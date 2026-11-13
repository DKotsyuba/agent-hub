/** Quota snapshot/status projection: exact schema, Unknown never becomes zero, every row shown. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { quotaLines, quotaSnapshot, quotaStatus, quotaSummary } from '../src/quota.ts';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/quota-${name}.json`, import.meta.url), 'utf8')).result;

test('reference fixtures parse with all model states', () => {
  const known = quotaSnapshot(fixture('snapshot-v2'));
  assert.equal(known.accounts[0]!.models[0]!.state, 'known');
  assert.equal(known.accounts[0]!.models[0]!.remaining, 80);
  assert.equal(known.accounts[0]!.models[0]!.burn, null);
  const exhausted = quotaSnapshot(fixture('exhausted-snapshot-v2'));
  assert.equal(exhausted.accounts[0]!.models[0]!.state, 'exhausted');
  assert.equal(exhausted.accounts[0]!.latches[0]!.active, true);
  const unknown = quotaSnapshot(fixture('unknown-snapshot-v2'));
  assert.equal(unknown.accounts[0]!.models[0]!.remaining, null);
  assert.deepEqual(quotaSummary(unknown), { accounts: 1, known: 0, unknown: 1, exhausted: 0, stale: 1, lowest: null, coverage: 'partial' });
});

test('unsupported schema and unknown state values are rejected, not treated as capacity', () => {
  assert.throws(() => quotaSnapshot({ ...fixture('snapshot-v2'), schema_version: 1 }), /quota_schema/);
  const bad = structuredClone(fixture('snapshot-v2'));
  bad.accounts[0].models[0].state = 'available';
  assert.throws(() => quotaSnapshot(bad), /quota_state/);
  const validity = structuredClone(fixture('snapshot-v2'));
  validity.accounts[0].models[0].state_validity = { kind: 'forever' };
  assert.throws(() => quotaSnapshot(validity), /quota_validity/);
  const text = structuredClone(fixture('snapshot-v2'));
  text.accounts[0].models[0].remaining_percent = '80';
  assert.throws(() => quotaSnapshot(text), /quota_remaining/);
});

test('lines show every account/model field and render absence as Unknown', () => {
  const now = 10000;
  const unknown = quotaLines(quotaSnapshot(fixture('unknown-snapshot-v2')), null, now).map(line => line.text).join('\n');
  assert.match(unknown, /codex\/model-a · UNKNOWN · risk unknown/);
  assert.match(unknown, /remaining Unknown · burn Unknown · reset Unknown/);
  assert.match(unknown, /evidence missing · newest sample Unknown · no decision/);
  assert.match(unknown, /coverage partial/);
  assert.match(unknown, /issues: collector_timeout/);
  assert.doesNotMatch(unknown, /remaining 0%/);
  const known = quotaLines(quotaSnapshot(fixture('snapshot-v2')), null, now).map(line => line.text).join('\n');
  assert.match(known, /remaining 80% · burn Unknown · reset in 2h 46m/);
  assert.match(known, /window five_hour · acct-test::primary · fixture-source · score 1\.6/);
  assert.match(known, /evidence fresh · newest sample 0s ago · valid in 15m/);
  assert.match(known, /Latches: none active/);
  const exhausted = quotaLines(quotaSnapshot(fixture('exhausted-snapshot-v2')), null, now).map(line => line.text).join('\n');
  assert.match(exhausted, /EXHAUSTED · risk high/);
  assert.match(exhausted, /exhausted until in 2h 46m/);
  assert.match(exhausted, /Latches: 1 active/);
  assert.match(exhausted, /five_hour · acct-test::primary · fixture-source · reset in 2h 46m \([^)]+\) · models model-a/);
  assert.match(exhausted, /near exhaustion/);
});

test('status projection lists external ingest ages', () => {
  const status = quotaStatus({ status: 'running', started_at: 100, source_count: 1, last_collection: { observed_at: 9990, ok: true }, external_collection: [{ account: 'a', provider: 'p', source: 's', accepted_at: 5000, revision: 3 }] });
  const lines = quotaLines(null, status, 10000);
  assert.match(lines[0]!.text, /Service: running · started 2h 45m ago · sources 1 · last round 10s ago \(ok\)/);
  assert.equal(lines[1]!.tone, 'error', 'external ingest older than an hour is highlighted');
  assert.match(lines[1]!.text, /external a · p\/s · accepted 1h 23m ago · revision 3/);
});
