/** Quota tab and Overview card render synthetic Quota observations read-only as scannable account blocks. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestRenderer } from '@opentui/core/testing';
import type { CapturedFrame } from '@opentui/core';
import { createDemoClient } from '../src/demo.ts';
import { mountHub } from '../src/hub.ts';

/** Returns the foreground color of one terminal cell. */
function foregroundAt(frame: CapturedFrame, row: number, column: number): number[] {
  let position = 0;
  for (const span of frame.lines[row].spans) {
    if (column < position + span.width) return span.fg.toInts();
    position += span.width;
  }
  throw new Error('Cell is outside the captured frame');
}

test('overview card shows one line per account with a mini bar, % left, reset and badge', async () => {
  const setup = await createTestRenderer({ width: 140, height: 40 });
  const client = createDemoClient();
  const unmount = mountHub(setup.renderer, client, 'demo', () => {}, { theme: 'dark', async save() {} });
  try {
    const frame = await setup.waitForFrame(value => value.includes('Agent Quota') && value.includes('[UNKNOWN]'));
    const rows = frame.split('\n');
    const alpha = rows.find(row => row.includes('demo-account') && row.includes('% left'))!, unknown = rows.find(row => row.includes('demo-unknown') && row.includes('[UNKNOWN]'))!;
    assert.match(alpha, /demo-account +[█░┃]{10,} +26% left · resets in 2d [56]h · Weekly \(7d\) +\[AT RISK\] *$/, 'the most constraining window of the account');
    assert.match(unknown, /demo-unknown +░{10,} +Unknown +\[UNKNOWN\]/, 'Unknown keeps a dim empty bar');
    assert.doesNotMatch(unknown, /█|0%/);
    assert.ok(rows.findIndex(row => row.includes('Agent Quota')) > rows.findIndex(row => row.includes('Agent Bridge')));
    assert.ok(rows.findIndex(row => row.includes('Needs attention')) > rows.findIndex(row => row.includes('demo-unknown')));
    assert.match(frame, /2 accounts · coverage partial/);
    assert.doesNotMatch(frame, /Lowest known|Not fresh/, 'the old counter line is gone');
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('Quota tab is a block per account, window rows with bar and pace, technical details collapsed', async () => {
  const setup = await createTestRenderer({ width: 140, height: 44 });
  const client = createDemoClient();
  const unmount = mountHub(setup.renderer, client, 'demo', () => {}, { theme: 'dark', async save() {} });
  try {
    await setup.waitForFrame(value => value.includes('Agent Quota') && value.includes('[UNKNOWN]'));
    setup.mockInput.pressKey('3');
    let frame = await setup.waitForFrame(value => value.includes('[Quota]') && value.includes('Weekly (7d)') && value.includes('demo-unknown'));
    const rows = frame.split('\n').map(row => row.trimEnd());
    const at = (needle: RegExp) => rows.findIndex(row => needle.test(row));
    // account header: name, provider · source, freshness and state badge
    assert.match(rows[at(/demo-account {2}demo/)], /demo-account {2}demo · demo-source +updated [01]m ago {2}\[AT RISK\]$/);
    // window block: title, % left, right-aligned countdown; bar; reserve/deficit subline; shared models listed once
    const session = at(/Session \(5h\) {2}72% left/), weekly = at(/Weekly \(7d\) {2}26% left/);
    assert.ok(session > 0 && weekly > session);
    assert.match(rows[session], /Resets in (1h 5\d|2h 0)m$/);
    assert.match(rows[session + 1], /^ {4}█+┃█+░+$/, 'bar with the pace marker inside the filled part (reserve)');
    assert.match(rows[session + 2], /3[12]% in reserve · lasts until reset/);
    assert.match(rows[session + 3], /models: model-alpha, model-beta/);
    assert.match(rows[weekly], /Resets in 2d [56]h$/);
    assert.match(rows[weekly + 1], /^ {4}█+░+┃░+$/, 'marker beyond the fill (deficit)');
    assert.match(rows[weekly + 2], /[56]% in deficit · runs out in 21h (39|40)m/);
    assert.equal(frame.match(/models: model-alpha, model-beta/g)!.length, 2, 'one compact list per window, no per-model rows');
    // unknown account: never zero, dim empty bar, warnings
    const unknown = at(/Session \(5h\) {2}Unknown/);
    assert.ok(unknown > weekly);
    assert.match(rows[unknown + 1], /^ {4}░+$/);
    assert.match(rows[unknown + 2], /never sampled/);
    assert.match(frame, /demo-unknown {2}demo · demo-source +not observed yet {2}\[UNKNOWN\]/);
    assert.match(frame, /! Source demo-source failed: collector_timeout/);
    assert.match(frame, /! demo-account\/secondary seven_day is trending toward exhaustion/);
    assert.match(frame, /Coverage partial/);
    assert.doesNotMatch(frame, /\b0% left/);
    // collapsed by default: no technical fields in the main view
    assert.match(frame, /\[d\] Technical details ▸/);
    assert.doesNotMatch(frame, /Snapshot revision|score|evidence|evaluated|sustainable|pp\/h|valid in/);
    // expand with d
    setup.mockInput.pressKey('d');
    frame = await setup.waitForFrame(value => value.includes('Technical details') && value.includes('▾'));
    setup.mockInput.pressKey('END');
    frame = await setup.waitForFrame(value => value.includes('Read-only Quota observations'));
    assert.match(frame, /demo\/model-gamma · UNKNOWN/);
    assert.match(frame, /remaining Unknown · burn Unknown · reset Unknown/);
    assert.match(frame, /Read-only Quota observations\. Missing values are Unknown, never zero/);
    // Enter collapses again
    setup.mockInput.pressKey('HOME');
    await setup.waitForFrame(value => value.includes('▾'));
    setup.mockInput.pressEnter();
    frame = await setup.waitForFrame(value => value.includes('▸'));
    assert.doesNotMatch(frame, /Snapshot revision/);
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('bars use the status colors: green when healthy, red when running out, dim when Unknown', async () => {
  const setup = await createTestRenderer({ width: 140, height: 44 });
  const client = createDemoClient();
  const unmount = mountHub(setup.renderer, client, 'demo', () => {}, { theme: 'dark', async save() {} });
  try {
    await setup.waitForFrame(value => value.includes('[UNKNOWN]'));
    setup.mockInput.pressKey('3');
    const text = await setup.waitForFrame(value => value.includes('[Quota]') && value.includes('Weekly (7d)') && value.includes('demo-unknown'));
    const rows = text.split('\n'), frame = setup.captureSpans();
    const bar = (title: RegExp) => { const row = rows.findIndex(line => title.test(line)) + 1; return { row, column: rows[row].indexOf('█') < 0 ? rows[row].indexOf('░') : rows[row].indexOf('█') }; };
    const healthy = bar(/Session \(5h\) {2}72%/), running = bar(/Weekly \(7d\) {2}26%/), unknown = bar(/Session \(5h\) {2}Unknown/);
    const colors = [healthy, running, unknown].map(item => foregroundAt(frame, item.row, item.column));
    assert.equal(new Set(colors.map(item => item.join())).size, 3, 'three distinct tones');
    const unknownBar = foregroundAt(frame, unknown.row, unknown.column), emptyHealthy = foregroundAt(frame, healthy.row, rows[healthy.row].lastIndexOf('░'));
    assert.deepEqual(unknownBar, emptyHealthy, 'the empty part of every bar is the same dim tone');
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('Quota tab stays readable at narrow widths', async () => {
  for (const width of [90, 60]) {
    const setup = await createTestRenderer({ width, height: 44 });
    const client = createDemoClient();
    const unmount = mountHub(setup.renderer, client, 'demo', () => {}, { theme: 'dark', async save() {} });
    try {
      await setup.waitForFrame(value => value.includes('Quota'));
      setup.mockInput.pressKey('3');
      const frame = await setup.waitForFrame(value => value.includes('Technical details') && value.includes('demo-unknown'));
      assert.match(frame, /26% left/);
      assert.match(frame, /Unknown/);
      assert.match(frame, /\[AT RISK\]/);
      const bars = frame.split('\n').map(row => row.trim()).filter(row => /^[█░┃]{8,}$/.test(row));
      assert.equal(bars.length, 3, `three bars at ${width} columns`);
      assert.ok(bars.every(row => row.length >= width - 12), 'bars fill the card interior');
      for (const row of frame.split('\n')) assert.ok([...row].length <= width, `row fits ${width} columns`);
    } finally { unmount(); await client.close(); await setup.dispose(); }
  }
});

test('help documents the Quota key', async () => {
  const setup = await createTestRenderer({ width: 140, height: 40 });
  const client = createDemoClient();
  const unmount = mountHub(setup.renderer, client, 'demo', () => {}, { theme: 'dark', async save() {} });
  try {
    await setup.waitForFrame(value => value.includes('Agent Quota'));
    setup.mockInput.pressKey('3');
    await setup.waitForFrame(value => value.includes('[Quota]'));
    setup.mockInput.pressKey('?');
    const frame = await setup.waitForFrame(value => value.includes('technical details'));
    assert.match(frame, /Quota: d \/ Enter: show or hide technical details/);
    assert.match(frame, /r: refresh/);
  } finally { unmount(); await client.close(); await setup.dispose(); }
});
