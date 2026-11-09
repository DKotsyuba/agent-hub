/** Exercises the draft owner-only Pool proof with synthetic Run status examples. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { object } from '../../src/live/protocol.ts';
import { parsePoolRunProof } from '../src/pool-run-proof.ts';
import { runLineageLabel } from '../src/run-status.ts';
import type { PoolRunProofTarget } from '../src/pool-run-proof.ts';
import type { RunStatusRequest } from '../src/run-status.ts';

interface Fixture { request: RunStatusRequest; result: Record<string, unknown> }
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/run-status-v1.json', import.meta.url), 'utf8')) as { cases: Record<string, Fixture> };

/** Wraps a Run example in the documented Pool observer envelope. */
function example(name: string) {
  const fixture = structuredClone(fixtures.cases[name]), selector = fixture.request.targets[0], result = fixture.result;
  const target: PoolRunProofTarget = { poolId: 'pool', memberId: 'member', revision: 7, binding: { pool_id: 'pool', member: { member_id: 'member' }, run_id: selector.agent_id, run_sequence: selector.sequence, run_execution_ref: selector.execution_ref, run_pin_id: selector.pin_id, run_store_id: result.store_id } };
  const envelope: Record<string, unknown> = { schema_version: 1, kind: 'run_proof', data: { pool_id: 'pool', member_id: 'member', pool_revision: 7, current: true, observed_at_unix_ms: 2000, state: 'observed', store_id: result.store_id, run_observed_at: result.observed_at, proof: { status: (result.items as unknown[])[0], historical_success: false, outcome_scope: 'retained_latest' }, author_identity: 'unknown' } };
  return { target, envelope };
}

test('Pool proof keeps selected and retained-latest facts separate', () => {
  for (const [name, expected] of [['verified_selected_not_tail', 'not terminal'], ['restart_pending_raw_terminal', 'restart pending']] as const) {
    const { target, envelope } = example(name), result = parsePoolRunProof(envelope, target);
    assert.equal(result.state, 'observed');
    if (result.state !== 'observed') throw new Error('missing observed proof');
    assert.equal(result.evidence.selected?.sequence, 1);
    assert.equal(result.evidence.retainedLatest?.sequence, 2);
    assert.equal(result.evidence.selected?.rawStatus, 'succeeded');
    assert.equal(runLineageLabel(result.evidence), expected);
    assert.equal(result.historicalSuccess, false);
  }
});

test('Pool proof preserves a mismatch and never provides a selected view', () => {
  const { target, envelope } = example('mismatch'), result = parsePoolRunProof(envelope, target);
  assert.equal(result.state, 'observed');
  if (result.state !== 'observed') throw new Error('missing observed proof');
  assert.equal(result.evidence.match, 'mismatch');
  assert.equal(result.evidence.view, null);
  assert.equal(result.historicalSuccess, false);
});

test('Pool unknown proof does not become an empty successful observation', () => {
  const target: PoolRunProofTarget = { poolId: 'pool', memberId: 'member', revision: 7, binding: { pool_id: 'pool', member: { member_id: 'member' } } };
  const envelope = { schema_version: 1, kind: 'run_proof', data: { pool_id: 'pool', member_id: 'member', pool_revision: 7, current: false, observed_at_unix_ms: 2000, state: 'unknown', reason: 'incomplete_binding', author_identity: 'unknown' } };
  const result = parsePoolRunProof(envelope, target);
  assert.equal(result.state, 'unknown');
  if (result.state !== 'unknown') throw new Error('unexpected proof');
  assert.equal(result.reason, 'incomplete_binding');
  assert.equal(result.current, false);
  assert.equal(result.storeId, null);
});

test('historical success requires the selected verified latest and complete cleanup', () => {
  const { target, envelope } = example('verified_selected_not_tail'), data = object(envelope.data), proof = object(data.proof), item = object(proof.status);
  item.retained_latest = structuredClone(item.selected);
  item.lineage_terminal = true; item.terminal_outcome = 'succeeded'; item.success_commit = 'recorded'; object(item.cleanup).state = 'confirmed';
  proof.historical_success = true;
  const result = parsePoolRunProof(envelope, target);
  assert.equal(result.state, 'observed');
  if (result.state !== 'observed') throw new Error('missing observed proof');
  assert.equal(result.historicalSuccess, true);
  assert.equal(result.evidence.cleanup, 'confirmed');
});

test('Pool proof rejects impossible latest facts and invalid exact identities', () => {
  const unknown = example('mismatch'), status = object(object(object(unknown.envelope.data).proof).status);
  status.match = 'unknown';
  status.selected = { sequence: unknown.target.binding.run_sequence, execution_ref: null, raw_status: 'running' };
  status.retained_latest = structuredClone(status.selected);
  assert.throws(() => parsePoolRunProof(unknown.envelope, unknown.target));

  const invalid = example('verified_selected_not_tail'), invalidStatus = object(object(object(invalid.envelope.data).proof).status);
  invalid.target.binding.run_id = 'invalid-agent';
  object(invalidStatus.selector).agent_id = 'invalid-agent'; invalidStatus.canonical_agent_id = 'invalid-agent';
  assert.throws(() => parsePoolRunProof(invalid.envelope, invalid.target));

  const incomplete = example('verified_selected_not_tail'), incompleteStatus = object(object(object(incomplete.envelope.data).proof).status);
  incompleteStatus.coverage = 'unknown';
  assert.throws(() => parsePoolRunProof(incomplete.envelope, incomplete.target), 'restart none requires complete coverage');
  const running = example('verified_selected_not_tail'), runningStatus = object(object(object(running.envelope.data).proof).status);
  object(runningStatus.selected).raw_status = 'running';
  assert.throws(() => parsePoolRunProof(running.envelope, running.target), 'an earlier selected execution must be terminal');
  const pending = example('restart_pending_raw_terminal'), pendingStatus = object(object(object(pending.envelope.data).proof).status);
  pendingStatus.retained_latest = null; pendingStatus.coverage = 'unknown'; object(pendingStatus.cleanup).state = 'unknown';
  assert.throws(() => parsePoolRunProof(pending.envelope, pending.target), 'nonterminal lineage requires a retained latest execution');
});

test('Pool proof rejects wrong membership, revision, store, authority and contradictory success', () => {
  const mutations: [string, (data: Record<string, unknown>) => void][] = [
    ['pool', data => { data.pool_id = 'other'; }],
    ['member', data => { data.member_id = 'other'; }],
    ['revision', data => { data.pool_revision = 8; }],
    ['current', data => { data.current = 'true'; }],
    ['author', data => { data.author_identity = 'verified'; }],
    ['store', data => { data.store_id = `store_${'f'.repeat(32)}`; }],
    ['outcome scope', data => { object(data.proof).outcome_scope = 'selected'; }],
    ['forged success', data => { object(data.proof).historical_success = true; }],
    ['selector', data => { object(object(object(data.proof).status).selector).agent_id = 'other'; }],
    ['missing Run clock', data => { delete data.run_observed_at; }],
  ];
  for (const [label, mutate] of mutations) {
    const { target, envelope } = example('verified_selected_not_tail');
    mutate(object(envelope.data));
    assert.throws(() => parsePoolRunProof(envelope, target), label);
  }
  const { target, envelope } = example('verified_selected_not_tail');
  const data = object(envelope.data);
  data.state = 'unknown'; data.reason = 'run_unavailable';
  assert.throws(() => parsePoolRunProof(envelope, target), 'unknown must not carry a proof');
  for (const binding of [{ ...target.binding, pool_id: 'other' }, { ...target.binding, member: { member_id: 'other' } }, { ...target.binding, member: null }]) {
    const source = example('verified_selected_not_tail');
    assert.throws(() => parsePoolRunProof(source.envelope, { ...source.target, binding }), 'binding must match the requested Pool and member');
  }
});
