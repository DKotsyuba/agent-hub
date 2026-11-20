/** Quota view model: bar and pace math, formatting, per-window blocks, narrow widths and Overview rows. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { quotaSnapshot } from '../src/quota.ts';
import {
  BAR_EMPTY, BAR_FILLED, BAR_PACE, accountView, barLayout, barSpans, barText, exhaustion, leftRight, overviewRows, paceNote, paceRemaining, percentLeft,
  quotaRows, spansWidth, unobservedLabel, windowSeconds, windowTitle, wrapCells,
} from '../src/quota-view.ts';
import type { Row, Span } from '../src/quota-view.ts';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/quota-${name}.json`, import.meta.url), 'utf8')).result;
/** Fixture time: the five_hour window resets at 20000, evaluated at 10000. */
const NOW = 10000;
/** Joins a row's spans to plain text. */
const text = (row: Row): string => row.spans.map(item => item.text).join('');
/** Joins every row to plain text. */
const all = (rows: Row[]): string => rows.map(text).join('\n');
/** Builds a snapshot from the reference fixture with the first window/model mutated. */
function variant(change: (account: any) => void) {
  const raw = structuredClone(fixture('snapshot-v2'));
  change(raw.accounts[0]);
  return quotaSnapshot(raw);
}

test('window lengths come from the producer name; unknown names stay unknown', () => {
  assert.equal(windowSeconds('five_hour'), 5 * 3600);
  assert.equal(windowSeconds('seven_day'), 7 * 86400);
  assert.equal(windowSeconds('weekly'), 7 * 86400);
  assert.equal(windowSeconds('30_minute'), 1800);
  assert.equal(windowSeconds('two_hours'), 7200);
  assert.equal(windowSeconds('session'), null);
  assert.equal(windowSeconds('zero_day'), null);
  assert.equal(windowTitle('five_hour', 'primary'), 'Session (5h)');
  assert.equal(windowTitle('seven_day', 'secondary'), 'Weekly (7d)');
  assert.equal(windowTitle('seven_day', 'model:fable'), 'Fable weekly (7d)');
  assert.equal(windowTitle('mystery', 'primary'), 'Mystery');
});

test('pace is the share an even burn would have left now', () => {
  assert.equal(paceRemaining('five_hour', NOW + 9000, NOW), 50);
  assert.equal(paceRemaining('five_hour', NOW + 18000, NOW), 100);
  assert.equal(paceRemaining('five_hour', NOW + 1800, NOW), 10);
  assert.equal(paceRemaining('five_hour', null, NOW), null, 'no reset clock');
  assert.equal(paceRemaining('five_hour', NOW, NOW), null, 'reset already reached');
  assert.equal(paceRemaining('five_hour', NOW - 5, NOW), null, 'reset passed');
  assert.equal(paceRemaining('five_hour', NOW + 40000, NOW), null, 'reset farther than the window is inconsistent');
  assert.equal(paceRemaining('session', NOW + 100, NOW), null, 'unknown window length');
});

test('bar layout: unknown is empty, 0 and 100 are exact, partial values never round to an extreme', () => {
  const unknown = barLayout(10, null, 50);
  assert.deepEqual(unknown, { width: 10, filled: 0, marker: null, known: false });
  assert.equal(barText(unknown), BAR_EMPTY.repeat(10), 'Unknown is a dim empty bar, never 0%');
  assert.equal(barText(barLayout(10, 0, null)), BAR_EMPTY.repeat(10));
  assert.equal(barText(barLayout(10, 100, null)), BAR_FILLED.repeat(10));
  assert.equal(barLayout(10, 0.4, null).filled, 1, 'a sliver stays visible');
  assert.equal(barLayout(10, 99.9, null).filled, 9, 'nearly full is not full');
  assert.equal(barLayout(10, 150, null).filled, 10, 'out-of-range values are clamped');
  assert.equal(barLayout(10, -5, null).filled, 0);
  assert.equal(barLayout(10, 72, null).filled, 7);
  assert.equal(barLayout(20, 50, null).filled, 10);
});

test('pace marker sits where an even burn would be and replaces one cell', () => {
  const bar = barLayout(10, 80, 30);
  assert.equal(bar.marker, 3);
  assert.equal(barText(bar), `${BAR_FILLED.repeat(3)}${BAR_PACE}${BAR_FILLED.repeat(4)}${BAR_EMPTY.repeat(2)}`);
  assert.equal(barLayout(10, 80, 100).marker, 9, 'start of window: last cell');
  assert.equal(barLayout(10, 80, 0).marker, 0, 'end of window: first cell');
  assert.equal(barLayout(10, 80, null).marker, null, 'no pace, no marker');
  assert.equal(barLayout(10, null, 50).marker, null, 'Unknown carries no marker');
  assert.equal(barText(barLayout(10, 80, 30)).length, 10, 'width is constant');
  assert.equal(barLayout(40, 20, 50).marker, 20);
});

test('bars stay valid at narrow widths', () => {
  for (const width of [1, 2, 3, 4, 5]) {
    const bar = barLayout(width, 60, 40);
    assert.equal(barText(bar).length, width);
    assert.equal(spansWidth(barSpans(bar, 'good')), width);
  }
  assert.equal(barLayout(2, 60, 40).marker, null, 'too narrow for a marker');
  assert.equal(barLayout(0, 60, null).width, 1, 'zero width is raised to one cell');
  assert.equal(barLayout(Number.NaN, 60, null).width, 1);
  const spans = barSpans(barLayout(10, 80, 30), 'warn');
  assert.deepEqual(spans.map(item => [item.text, item.tone]), [[BAR_FILLED.repeat(3), 'warn'], [BAR_PACE, 'text'], [BAR_FILLED.repeat(4), 'warn'], [BAR_EMPTY.repeat(2), 'muted']]);
  assert.ok(barSpans(barLayout(6, null, null), 'good').every(item => item.tone === 'muted'), 'Unknown is dim whatever the tone');
});

test('percent left keeps the edges honest', () => {
  assert.equal(percentLeft(null), 'Unknown');
  assert.equal(percentLeft(Number.NaN), 'Unknown');
  assert.equal(percentLeft(0), '0%');
  assert.equal(percentLeft(-3), '0%');
  assert.equal(percentLeft(0.2), '<1%');
  assert.equal(percentLeft(1), '1%');
  assert.equal(percentLeft(71.6), '72%');
  assert.equal(percentLeft(99.6), '99%', 'only an exactly full window reads 100%');
  assert.equal(percentLeft(100), '100%');
});

test('reserve versus deficit versus pace', () => {
  assert.deepEqual(paceNote(80, 55.6), { kind: 'reserve', points: 24, text: '24% in reserve' });
  assert.deepEqual(paceNote(30, 36), { kind: 'deficit', points: 6, text: '6% in deficit' });
  assert.equal(paceNote(50, 50.2).text, 'on pace');
  assert.equal(paceNote(50, 50.4).kind, 'even', 'less than a point either way is even');
  assert.equal(paceNote(null, 50).text, 'pace unknown');
  assert.equal(paceNote(50, null).text, 'pace unknown');
  assert.equal(paceNote(0, 20).kind, 'deficit');
  assert.equal(paceNote(100, 100).kind, 'even');
});

test('exhaustion projection compares the burn with the reset clock', () => {
  assert.deepEqual(exhaustion(30, 20, NOW + 10000, NOW), { kind: 'runs_out', seconds: 5400, text: 'runs out in 1h 30m' });
  assert.equal(exhaustion(30, 5, NOW + 10000, NOW).text, 'lasts until reset');
  assert.equal(exhaustion(30, 0, NOW + 10000, NOW).text, 'lasts until reset', 'an idle window lasts');
  assert.equal(exhaustion(30, 0, null, NOW).kind, 'none');
  assert.equal(exhaustion(30, null, NOW + 10000, NOW).kind, 'none', 'no burn estimate, no claim');
  assert.equal(exhaustion(null, 5, NOW + 10000, NOW).kind, 'none', 'Unknown has no projection');
  assert.equal(exhaustion(0, 5, NOW + 10000, NOW).kind, 'exhausted');
  assert.equal(exhaustion(30, 20, null, NOW).text, 'runs out in 1h 30m', 'without a reset clock the burn still applies');
  assert.equal(exhaustion(30, 1e-9, null, NOW).kind, 'none', 'an effectively idle burn is not announced');
});

test('a healthy window shows reserve and a green block', () => {
  const view = accountView(variant(() => {}).accounts[0]!, [], NOW);
  assert.equal(view.badge, 'OK');
  const window = view.windows[0]!;
  assert.equal(window.title, 'Session (5h)');
  assert.equal(window.leftText, '80% left');
  assert.equal(window.resetText, 'Resets in 2h 46m');
  assert.equal(window.tone, 'good');
  assert.equal(window.sub.map(item => item.text).join(''), '24% in reserve');
  assert.equal(Math.round(window.pace!), 56);
  assert.deepEqual(window.models, ['model-a']);
  assert.equal(view.provider, 'codex');
  assert.deepEqual(view.sources, ['fixture-source']);
});

test('a window behind pace that will run out is red with the projected time', () => {
  const snapshot = variant(account => {
    account.windows[0].last_remaining_percent = 30; account.windows[0].evaluation.risk = 'high';
    account.windows[0].evaluation.burn_percent_per_hour = 20;
    account.models[0].remaining_percent = 30;
  });
  const view = accountView(snapshot.accounts[0]!, [], NOW);
  const window = view.windows[0]!;
  assert.equal(window.tone, 'error');
  assert.equal(window.sub.map(item => item.text).join(''), '26% in deficit · runs out in 1h 30m');
  assert.equal(view.badge, 'AT RISK');
  const lines = all(quotaRows(snapshot, NOW, 80));
  assert.match(lines, /30% left/);
  assert.match(lines, /26% in deficit · runs out in 1h 30m/);
});

test('a window behind pace that still lasts is yellow', () => {
  const snapshot = variant(account => { account.windows[0].last_remaining_percent = 30; account.windows[0].evaluation.risk = 'medium'; account.windows[0].evaluation.burn_percent_per_hour = 5; });
  const window = accountView(snapshot.accounts[0]!, [], NOW).windows[0]!;
  assert.equal(window.tone, 'warn');
  assert.equal(window.sub.map(item => item.text).join(''), '26% in deficit · lasts until reset');
});

test('an exhausted account has an empty bar, EXHAUSTED badge and latch warning', () => {
  const snapshot = quotaSnapshot(fixture('exhausted-snapshot-v2'));
  const view = accountView(snapshot.accounts[0]!, snapshot.coverage.sources, NOW);
  assert.equal(view.badge, 'EXHAUSTED');
  const window = view.windows[0]!;
  assert.equal(window.leftText, '0% left');
  assert.equal(window.tone, 'error');
  assert.match(window.sub.map(item => item.text).join(''), /exhausted until reset/);
  assert.match(view.warnings[0]!.text, /^Latched: five_hour \(model-a\) · resets in 2h 46m$/);
  const rows = quotaRows(snapshot, NOW, 80);
  const bar = rows.find(row => text(row).includes(BAR_EMPTY.repeat(10)))!;
  assert.ok(!text(bar).includes(BAR_FILLED), '0% is an empty bar');
  assert.match(all(rows), /\[EXHAUSTED\]/);
});

test('an unknown account stays Unknown with a dim empty bar, never 0%', () => {
  const snapshot = quotaSnapshot(fixture('unknown-snapshot-v2'));
  const view = accountView(snapshot.accounts[0]!, snapshot.coverage.sources, NOW);
  assert.equal(view.badge, 'UNKNOWN');
  assert.deepEqual(view.orphans, [{ model: 'model-a', text: 'Unknown', tone: 'muted' }]);
  const joined = all(quotaRows(snapshot, NOW, 80));
  assert.match(joined, /\[UNKNOWN\]/);
  assert.match(joined, /model-a {2}Unknown/);
  assert.match(joined, /Source fixture-source failed: collector_timeout/);
  assert.doesNotMatch(joined, /\b0%/);
  // A window the producer reports with a placeholder 100% but no known forecast.
  const placeholder = variant(account => { account.windows[0].forecast.known = false; account.models[0].state = 'unknown'; account.models[0].remaining_percent = null; account.models[0].state_validity = { kind: 'unknown' }; account.models[0].risk = 'unknown'; });
  const unknownView = accountView(placeholder.accounts[0]!, [], NOW);
  assert.equal(unknownView.badge, 'UNKNOWN');
  const window = unknownView.windows[0]!;
  assert.ok(!window.known && window.remaining === null && window.leftText === 'Unknown' && window.pace === null);
  const rows = quotaRows(placeholder, NOW, 80);
  const barRow = rows.find(row => text(row).includes(BAR_EMPTY.repeat(10)))!;
  assert.ok(!text(barRow).includes(BAR_FILLED) && !text(barRow).includes(BAR_PACE));
  assert.ok(barRow.spans.filter(item => item.text.trim()).every(item => item.tone === 'muted'), 'dim');
  assert.doesNotMatch(all(rows), /100% left|\b0% left/, 'a placeholder value is not shown as capacity');
  assert.match(all(rows), /Unknown/);
});

test('freshness: red when stale, plain when current, not observed when empty', () => {
  const snapshot = quotaSnapshot(fixture('snapshot-v2'));
  const fresh = accountView(snapshot.accounts[0]!, [], NOW + 60);
  assert.equal(fresh.stale, false);
  assert.match(all(quotaRows(snapshot, NOW + 60, 90)), /updated 1m ago {2}\[OK\]/);
  const stale = quotaRows(snapshot, NOW + 5000, 90);
  const header = stale.find(row => text(row).includes('updated'))!;
  assert.match(text(header), /updated 1h 23m ago · stale/);
  assert.equal(header.spans.find(item => item.text.startsWith('updated'))!.tone, 'error', 'stale freshness is red');
  assert.match(all(stale), /sample is stale/);
  const never = quotaRows(quotaSnapshot(fixture('unknown-snapshot-v2')), NOW, 90);
  assert.match(all(never), /not observed yet/);
});

test('models sharing a window are listed once; differing models get their own row', () => {
  const same = variant(account => {
    account.windows[0].models = ['model-a', 'model-b', 'model-c'];
    for (const name of ['model-b', 'model-c']) account.models.push({ ...structuredClone(account.models[0]), model: name, native_model: name });
  });
  const joined = all(quotaRows(same, NOW, 100));
  assert.match(joined, /models: model-a, model-b, model-c/);
  assert.equal(joined.match(/80% left/g)!.length, 1, 'the shared numbers are not repeated per model');
  const differing = variant(account => {
    account.windows[0].models = ['model-a', 'model-b', 'model-c'];
    account.models.push({ ...structuredClone(account.models[0]), model: 'model-b', native_model: 'model-b', remaining_percent: 12, risk: 'medium' });
    account.models.push({ ...structuredClone(account.models[0]), model: 'model-c', native_model: 'model-c', state: 'exhausted', remaining_percent: 0, exhausted_until: 15000 });
  });
  const view = accountView(differing.accounts[0]!, [], NOW);
  assert.deepEqual(view.windows[0]!.models, ['model-a']);
  assert.deepEqual(view.windows[0]!.divergent.map(row => [row.model, row.text, row.tone]), [['model-b', '12% left · resets in 2h 46m', 'warn'], ['model-c', 'exhausted · resets in 1h 23m', 'error']]);
  assert.equal(view.badge, 'EXHAUSTED');
  const lines = all(quotaRows(differing, NOW, 100));
  assert.match(lines, /models: model-a$/m);
  assert.match(lines, /↳ model-b {2}12% left · resets in 2h 46m/);
});

test('a model without any window is listed as such, Unknown included', () => {
  const snapshot = variant(account => { account.models.push({ ...structuredClone(account.models[0]), model: 'model-z', native_model: 'model-z', state: 'unknown', remaining_percent: null, limiting_window: null, state_validity: { kind: 'unknown' } }); });
  const view = accountView(snapshot.accounts[0]!, [], NOW);
  assert.deepEqual(view.orphans, [{ model: 'model-z', text: 'Unknown', tone: 'muted' }]);
  assert.match(all(quotaRows(snapshot, NOW, 80)), /No window reported for:\n.*↳ model-z {2}Unknown/);
});

test('windows are ordered session, weekly, model-specific and named without collisions', () => {
  const snapshot = variant(account => {
    const base = account.windows[0];
    const make = (lane: string, name: string) => ({ ...structuredClone(base), lane, window: name, pool: `acct-test::${lane}` });
    account.windows = [make('model:fable', 'seven_day'), make('secondary', 'seven_day'), make('primary', 'five_hour'), make('other', 'seven_day')];
  });
  const view = accountView(snapshot.accounts[0]!, [], NOW);
  assert.deepEqual(view.windows.map(window => window.title), ['Session (5h)', 'Weekly (7d) · other', 'Weekly (7d) · secondary', 'Fable weekly (7d)']);
});

test('advice, latches and source failures become short warning lines only when present', () => {
  const none = accountView(variant(() => {}).accounts[0]!, [], NOW);
  assert.deepEqual(none.warnings, []);
  assert.doesNotMatch(all(quotaRows(variant(() => {}), NOW, 80)), /^ *!/m);
  const advised = variant(account => { account.advice = [{ recommendations: ['one', 'two'] }, { recommendations: ['three'] }, { recommendations: ['one'] }]; });
  const lines = all(quotaRows(advised, NOW, 80));
  assert.match(lines, /^ *! one$/m);
  assert.match(lines, /^ *! two$/m);
  assert.doesNotMatch(lines, /three/, 'extra advice is collapsed');
  assert.match(lines, /\+1 more · press d for technical details/);
});

test('technical fields stay out of the main view', () => {
  const lines = all(quotaRows(quotaSnapshot(fixture('snapshot-v2')), NOW, 100));
  for (const hidden of [/revision/i, /score/i, /evaluated/i, /valid/i, /evidence/i, /fixture-source ·.*·/, /pp\/h/, /sustainable/i]) assert.doesNotMatch(lines, hidden);
});

test('rows never exceed the available width, from wide to very narrow', () => {
  for (const snapshot of [quotaSnapshot(fixture('snapshot-v2')), quotaSnapshot(fixture('exhausted-snapshot-v2')), quotaSnapshot(fixture('unknown-snapshot-v2'))]) {
    for (const width of [200, 100, 60, 40, 30, 20, 12, 8]) {
      for (const row of quotaRows(snapshot, NOW, width)) assert.ok(spansWidth(row.spans) <= width, `width ${width}: "${text(row)}" is ${spansWidth(row.spans)}`);
    }
  }
});

test('the card header wraps when account and badge cannot share a row', () => {
  const rows = quotaRows(quotaSnapshot(fixture('snapshot-v2')), NOW, 34);
  const header = rows.findIndex(row => text(row).includes('acct-test'));
  assert.ok(header >= 0);
  const joined = all(rows);
  assert.match(joined, /\[OK\]/);
  const bar = rows.find(row => text(row).includes(BAR_FILLED))!;
  assert.equal(spansWidth(bar.spans), 34, 'bar fills the card interior');
});

test('right-aligned text flushes to the edge or wraps', () => {
  const left: Span[] = [{ text: 'abc', tone: 'text' }], right: Span[] = [{ text: 'xyz', tone: 'muted' }];
  const [one] = leftRight(left, right, 20);
  assert.equal(spansWidth(one!), 20);
  assert.equal(one!.map(item => item.text).join(''), `abc${' '.repeat(14)}xyz`);
  assert.equal(leftRight(left, right, 7).length, 2);
  assert.equal(leftRight(left, [], 20).length, 1);
  assert.deepEqual(wrapCells('alpha beta gamma delta', 11, 3), ['alpha beta', 'gamma delta']);
  assert.equal(wrapCells('alpha beta gamma delta', 6, 2).at(-1)!.endsWith('…'), true);
  assert.deepEqual(wrapCells('', 10), ['']);
});

test('coverage gaps are named, not dumped as JSON', () => {
  assert.equal(unobservedLabel('{"account":"acct-x","provider":"p","reason":"external_not_received","source":"s"}'), 'acct-x/s');
  assert.equal(unobservedLabel('{"account":"acct-x"}'), 'acct-x');
  assert.equal(unobservedLabel('plain text'), 'plain text');
  assert.equal(unobservedLabel('[1]'), '[1]');
  const raw = structuredClone(fixture('snapshot-v2'));
  raw.coverage = { ...raw.coverage, state: 'partial', unobserved: [{ account: 'acct-x', source: 's', reason: 'external_not_received' }] };
  const lines = all(quotaRows(quotaSnapshot(raw), NOW, 120));
  assert.match(lines, /Coverage partial · not yet received: acct-x\/s/);
  assert.doesNotMatch(lines, /\{/);
});

test('overview rows pick the most constraining window per account', () => {
  const snapshot = variant(account => {
    const weekly = { ...structuredClone(account.windows[0]), lane: 'secondary', window: 'seven_day', pool: 'acct-test::secondary', last_remaining_percent: 40, last_reset_at: NOW + 86400 };
    weekly.forecast.remaining_percent = 40; weekly.evaluation.burn_percent_per_hour = 0.1; weekly.evaluation.risk = 'low';
    account.windows.push(weekly);
  });
  const [row] = overviewRows(snapshot, NOW, 12);
  assert.equal(row!.account, 'Codex (ChatGPT)');
  assert.equal(row!.window, 'Weekly (7d)');
  assert.match(row!.text, /^40% left · resets in 1d 0h$/);
  assert.equal(barText(row!.bar).length, 12);
  assert.equal(row!.badge, 'OK');
  const unknown = overviewRows(quotaSnapshot(fixture('unknown-snapshot-v2')), NOW, 12)[0]!;
  assert.equal(unknown.text, 'Unknown');
  assert.equal(unknown.badge, 'UNKNOWN');
  assert.equal(barText(unknown.bar), BAR_EMPTY.repeat(12));
  assert.deepEqual(overviewRows(null, NOW, 12), []);
  const exhausted = overviewRows(quotaSnapshot(fixture('exhausted-snapshot-v2')), NOW, 12)[0]!;
  assert.equal(exhausted.text, '0% left · resets in 2h 46m');
  assert.equal(exhausted.badge, 'EXHAUSTED');
  assert.equal(exhausted.tone, 'error');
});

test('empty and missing snapshots render an explicit empty state', () => {
  assert.match(all(quotaRows(null, NOW, 80)), /No Quota snapshot yet/);
  const raw = structuredClone(fixture('snapshot-v2')); raw.accounts = [];
  assert.match(all(quotaRows(quotaSnapshot(raw), NOW, 80)), /No accounts reported by Quota/);
  const bare = variant(account => { account.windows = []; });
  assert.match(all(quotaRows(bare, NOW, 80)), /No window reported for:|No windows reported/);
});
