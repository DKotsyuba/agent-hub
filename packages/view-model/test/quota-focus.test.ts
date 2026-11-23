/** Covers the compact per-account window choice shared by Overview summaries. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { quotaAccountFocus } from '../src/quota-pace.ts';
import type { QuotaWindow } from '../src/quota.ts';

const NOW = 1_800_000_000;
/** Builds a fresh known window; overrides describe the case under test. */
function window(name: string, remaining: number | null, extra: Partial<QuotaWindow> = {}): QuotaWindow {
  return { pool: 'p', source: 's', window: name, lane: 'primary', runtime: 'r', models: [], observedAt: NOW - 60, validUntil: NOW + 600,
    lastRemaining: remaining, lastResetAt: NOW + 3600, forecastKnown: true, risk: 'low', marker: null, projected: null, sustainable: null, burn: null, ...extra };
}
const pick = (...windows: QuotaWindow[]) => quotaAccountFocus({ windows }, NOW)?.window.window ?? null;

test('account focus prefers the window that runs out soonest', () => {
  // 40% at 20 pp/h ends in 2 h, before its 3 h reset; the weekly window is lower but lasts.
  assert.equal(pick(window('weekly', 25, { lastResetAt: NOW + 2 * 86400, burn: 0.1 }),
    window('five_hour', 40, { lastResetAt: NOW + 3 * 3600, burn: 20 })), 'five_hour');
  // Two deficits: the earlier exhaustion wins regardless of the balance.
  assert.equal(pick(window('five_hour', 10, { lastResetAt: NOW + 4 * 3600, burn: 5 }),
    window('weekly', 30, { lastResetAt: NOW + 5 * 86400, burn: 30 })), 'weekly');
});

test('account focus falls back to the lowest fresh balance, then stale, then unknown', () => {
  assert.equal(pick(window('five_hour', 80), window('weekly', 35, { lastResetAt: NOW + 86400 })), 'weekly');
  assert.equal(pick(window('five_hour', 80), window('weekly', 0, { lastResetAt: NOW + 86400 })), 'weekly');
  assert.equal(pick(window('weekly', 5, { validUntil: NOW - 1 }), window('five_hour', 90)), 'five_hour');
  const stale = quotaAccountFocus({ windows: [window('weekly', 5, { validUntil: NOW - 1 })] }, NOW);
  assert.equal(stale?.rank, 3);
  assert.equal(pick(window('weekly', null), window('five_hour', 50, { forecastKnown: false })), null);
  assert.equal(pick(), null);
});

test('account focus breaks ties toward the account lane and the shorter window', () => {
  assert.equal(pick(window('weekly', 50, { lane: 'model:opus' }), window('weekly_all', 50)), 'weekly_all');
  assert.equal(pick(window('weekly', 50), window('five_hour', 50)), 'five_hour');
});
