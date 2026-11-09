/** Validates one Pool-fenced Run proof without treating it as caller or transcript identity. */
import { integer, number, object, product } from '../../src/live/protocol.ts';
import { parseRunStatus, runStatusRequest } from './run-status.ts';
import type { RunStatusEvidence } from './run-status.ts';

/** Exact roster snapshot and owner binding used for one proof request. */
export interface PoolRunProofTarget { poolId: string; memberId: string; revision: number; binding: Record<string, unknown> }

/** Pool and Run observation times remain separate and no author identity is inferred. */
export type PoolRunProof = {
  poolId: string; memberId: string; revision: number; current: boolean; observedAtMs: number;
} & ({ state: 'unknown'; reason: 'incomplete_binding' | 'origin_unavailable' | 'run_unavailable'; storeId: string | null }
  | { state: 'observed'; storeId: string; runObservedAt: number; evidence: RunStatusEvidence; historicalSuccess: boolean });

/** Correlates the Pool revision and exact binding before exposing any Run evidence. */
export function parsePoolRunProof(value: unknown, target: PoolRunProofTarget): PoolRunProof {
  const data = product(value, 'run_proof'), revision = integer(data.pool_revision), observedAtMs = integer(data.observed_at_unix_ms);
  if (!target.poolId || !target.memberId || target.binding.pool_id !== target.poolId || object(target.binding.member).member_id !== target.memberId || !Number.isSafeInteger(target.revision) || target.revision < 1 || data.pool_id !== target.poolId || data.member_id !== target.memberId || revision !== target.revision || typeof data.current !== 'boolean' || data.author_identity !== 'unknown') throw new Error('pool_run_proof_identity');
  const rawStore = data.store_id, expectedStore = target.binding.run_store_id;
  if (expectedStore != null && (typeof expectedStore !== 'string' || expectedStore.length !== 38 || !/^store_[0-9a-f]{32}$/.test(expectedStore))) throw new Error('pool_run_proof_store');
  if (rawStore !== undefined && (typeof rawStore !== 'string' || rawStore.length !== 38 || !/^store_[0-9a-f]{32}$/.test(rawStore) || expectedStore != null && rawStore !== expectedStore)) throw new Error('pool_run_proof_store');
  const common = { poolId: target.poolId, memberId: target.memberId, revision, current: data.current, observedAtMs };
  if (data.state === 'unknown') {
    const reason = data.reason;
    if (reason !== 'incomplete_binding' && reason !== 'origin_unavailable' && reason !== 'run_unavailable' || data.proof !== undefined || data.run_observed_at !== undefined) throw new Error('pool_run_proof_unknown');
    return { ...common, state: 'unknown', reason, storeId: typeof rawStore === 'string' ? rawStore : null };
  }
  const runObservedAt = number(data.run_observed_at);
  if (data.state !== 'observed' || data.reason !== undefined || typeof rawStore !== 'string' || runObservedAt === null || runObservedAt < 0) throw new Error('pool_run_proof_observed');
  const request = runStatusRequest(target.binding), selector = request.targets[0];
  if (!request.expected_store_id || !selector.execution_ref || !selector.pin_id || rawStore !== request.expected_store_id) throw new Error('pool_run_proof_binding');
  const proof = object(data.proof);
  if (proof.outcome_scope !== 'retained_latest' || typeof proof.historical_success !== 'boolean') throw new Error('pool_run_proof_scope');
  const evidence = parseRunStatus({ version: 1, store_id: rawStore, observed_at: runObservedAt, items: [proof.status] }, request);
  const selected = evidence.selected, latest = evidence.retainedLatest;
  const terminal = new Set(['succeeded', 'failed', 'timed_out', 'cancelled', 'lost']);
  if (evidence.pinState !== 'unknown' && !evidence.canonicalAgentId) throw new Error('pool_run_proof_pin');
  if (evidence.match !== 'verified' && (latest || evidence.coverage !== 'unknown' || evidence.restartResume !== 'unknown' || evidence.cleanup !== 'unknown')) throw new Error('pool_run_proof_unverified');
  if (evidence.coverage === 'complete' && (!selected || !latest || selected.sequence < latest.sequence && !terminal.has(selected.rawStatus))) throw new Error('pool_run_proof_coverage');
  if (evidence.restartResume === 'none' && evidence.coverage !== 'complete') throw new Error('pool_run_proof_restart');
  if (evidence.lineageTerminal === false && !latest) throw new Error('pool_run_proof_latest');
  if (evidence.lineageTerminal === null && latest && (evidence.restartResume === 'pending' || evidence.coverage === 'complete' && evidence.restartResume === 'none')) throw new Error('pool_run_proof_lineage');
  if (evidence.cleanup !== 'unknown' && evidence.coverage !== 'complete' || evidence.cleanup === 'pending' && evidence.lineageTerminal === null) throw new Error('pool_run_proof_cleanup');
  const historicalSuccess = evidence.match === 'verified' && evidence.pinState === 'active' && evidence.coverage === 'complete' && evidence.restartResume === 'none' && evidence.lineageTerminal === true && evidence.terminalOutcome === 'succeeded' && evidence.successCommit === 'recorded' && evidence.cleanup === 'confirmed' && !!selected && !!latest && selected.sequence === latest.sequence && selected.executionRef === latest.executionRef && selected.rawStatus === latest.rawStatus;
  if (proof.historical_success !== historicalSuccess) throw new Error('pool_run_proof_success');
  return { ...common, state: 'observed', storeId: rawStore, runObservedAt, evidence, historicalSuccess };
}
