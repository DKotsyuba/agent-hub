/** Agent Quota reset-credit evidence and account display ordering. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { quotaResetCredits, quotaSnapshot } from '../src/index.ts';

const base = { known: true, available_count: 0, observed_at: 100, credits: [] };

/** Parses a minimal producer snapshot through the regular account boundary. */
function account(report?: unknown) {
  return quotaSnapshot({
    schema_version: 2, coverage: { state: 'complete' },
    accounts: [{ account: 'test', reset_credits: report }],
  }).accounts[0]!;
}

test('absent, unreadable and explicitly unknown credit reports remain distinct from zero', () => {
  assert.equal(quotaResetCredits(account().resetCredits).count, null);
  assert.equal(quotaResetCredits(account({ known: true }).resetCredits).count, null);
  assert.equal(quotaResetCredits(account({ ...base, known: false }).resetCredits).count, null);
  assert.equal(quotaResetCredits(account({ ...base, available_count: null }).resetCredits).count, null);
  assert.equal(quotaResetCredits(account(base).resetCredits).count, 0);
  assert.deepEqual(quotaResetCredits(account({ ...base, available_count: 2 }).resetCredits),
    { count: 2, credits: [], soonestExpiryMs: null });
});

test('usable credits lead by expiry with undated credits after dated ones', () => {
  const row = { provider_kind: 'codex', label: 'Banked reset', scope: 'model:example',
    resets_left: 2, usable_now: true, granted_at: 80, expires_at: 200 };
  const report = account({ ...base, available_count: 4, credits: [
    { ...row, id: 'undated', expires_at: null },
    { ...row, id: 'later' },
    { ...row, id: 'unusable', usable_now: false, expires_at: 110 },
    { ...row, id: 'earlier', expires_at: 150 },
  ] }).resetCredits;
  assert.equal(report?.observedAtMs, 100000);
  const summary = quotaResetCredits(report);
  assert.equal(summary.count, 4);
  assert.equal(summary.soonestExpiryMs, 150000);
  assert.deepEqual(summary.credits.map(credit => credit.id), ['earlier', 'later', 'undated', 'unusable']);
  assert.deepEqual(summary.credits[0], {
    id: 'earlier', providerKind: 'codex', label: 'Banked reset', scope: 'model:example',
    resetsLeft: 2, usableNow: true, grantedAtMs: 80000, expiresAtMs: 150000,
  });
  assert.equal(report?.credits[0]?.id, 'undated');
});

test('spent credits with no resets left are not listed', () => {
  const row = { provider_kind: 'full', label: 'Reset', scope: 'all', usable_now: false, granted_at: 80, expires_at: 200 };
  const summary = quotaResetCredits(account({ ...base, available_count: 1, credits: [
    { ...row, id: 'spent', resets_left: 0 },
    { ...row, id: 'left', resets_left: 1, usable_now: true },
    { ...row, id: 'unknown-left', resets_left: null },
  ] }).resetCredits);
  assert.deepEqual(summary.credits.map(credit => credit.id), ['left', 'unknown-left']);
});
