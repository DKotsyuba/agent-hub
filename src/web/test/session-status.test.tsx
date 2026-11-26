/** Renders the session status badge to markup, proving the working spinner and the fixed wait text. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Session } from '@agent-hub/domain';
import { LocaleProvider } from '../../i18n';

// The shared web client binds a same-origin base URL at module load; the renderer needs no network.
Object.defineProperty(globalThis, 'location', { value: { origin: 'http://hub.test' }, configurable: true });
const { SessionStatus } = await import('../ui');

/** Renders one phase row inside the required locale provider and returns its markup. */
function markup(row: Pick<Session, 'status' | 'phase' | 'phaseStartedAtMs' | 'idleMs'> & { observedAtMs?: number | null }, now: number) {
  return renderToStaticMarkup(<LocaleProvider><SessionStatus row={{ observedAtMs: null, ...row }} now={now} /></LocaleProvider>);
}

test('a waiting agent renders its duration and start clock without a spinner', () => {
  const now = Date.UTC(2026, 10, 26, 13, 17);
  const html = markup({ status: 'running', phase: 'idle', phaseStartedAtMs: now - 720_000, idleMs: 720_000 }, now);
  assert.match(html, />Ожидает · 12 мин \(с 14:05\)</);
  assert.doesNotMatch(html, /web-spin/);
  assert.match(html, /data-tone="neutral"/);
});

test('a working agent renders the spinner and the working label', () => {
  const now = Date.UTC(2026, 10, 26, 13, 17);
  const html = markup({ status: 'running', phase: 'running', phaseStartedAtMs: now - 720_000, idleMs: null }, now);
  assert.match(html, /web-spin/);
  assert.match(html, />Выполняется · 12 мин \(с 14:05\)</);
  assert.match(html, /data-tone="active"/);
});

test('an unknown phase keeps the producer name and a terminal status keeps its badge', () => {
  assert.match(markup({ status: 'running', phase: 'awaiting_review', phaseStartedAtMs: null, idleMs: null }, 0), />awaiting_review</);
  const done = markup({ status: 'succeeded', phase: 'terminal', phaseStartedAtMs: null, idleMs: null }, 0);
  assert.match(done, />Успешно</);
  assert.doesNotMatch(done, /web-spin|web-status-phase/);
});
