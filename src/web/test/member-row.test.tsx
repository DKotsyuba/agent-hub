/** Renders a Pool member as a session-style row with its live status and transcript link. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PoolMember } from '@agent-hub/domain';
import { LocaleProvider } from '../../i18n';

// The shared web client binds a same-origin base URL at module load; the renderer needs no network.
Object.defineProperty(globalThis, 'location', { value: { origin: 'http://hub.test' }, configurable: true });
const { Member } = await import('../details');

/** A linked member whose Run row is currently working. */
const working: PoolMember = {
  id: 'm-seat-00', name: 'Worker', role: 'implement', task: 'Исследователь (лидер): проверь план', state: 'active', runtime: 'claude-code',
  seat: { id: 'seat-00', profile: 'лидер', admission: 'admitted', joined: true },
  session: { sessionId: 'ag-20261107-002455-e0caf0d956', execution: null, match: 'unverified' },
  run: {
    status: 'running', phase: 'running', phaseStartedAtMs: 0, idleMs: null, observedAtMs: 0,
    model: 'claude-sonnet-5-5', createdAtMs: 0, elapsedMs: 0, finishedAtMs: null,
  },
  lineage: null,
};

/** Renders one member row inside the required locale provider and returns its markup. */
function markup(item: PoolMember, now: number) {
  return renderToStaticMarkup(<LocaleProvider><Member item={item} now={now} /></LocaleProvider>);
}

test('a working member shows its phase, role label, model, task and a link to the session transcript', () => {
  const now = Date.UTC(2026, 10, 26, 13, 17);
  const item = { ...working, run: { ...working.run!, phaseStartedAtMs: now - 720_000, observedAtMs: now } };
  const html = markup(item, now);
  assert.match(html, /href="\/sessions\/ag-20261107-002455-e0caf0d956"/);
  assert.match(html, /web-spin/);
  assert.match(html, />Выполняется · 12 мин/);
  assert.match(html, />Исследователь \(лидер\)</);
  assert.match(html, /Claude Sonnet 5\.5 · claude-code/);
  assert.match(html, /Исследователь \(лидер\): проверь план/);
  assert.match(html, /Подробнее/);
});

test('a member without a Run row keeps a neutral state badge and is not a link', () => {
  const item: PoolMember = {
    ...working, session: null, run: null,
    seat: { id: 'seat-01', profile: 'review', admission: 'pending', joined: false }, state: 'pending',
  };
  const html = markup(item, 0);
  assert.match(html, /data-tone="neutral"/);
  assert.match(html, />pending</);
  assert.doesNotMatch(html, /<a /);
});
