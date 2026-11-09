/** Validates single-target Run status evidence without treating it as a read fence. */
import { integer, number, object, runAgent } from '../../src/live/protocol.ts';
import type { RunAgent } from '../../src/live/protocol.ts';

const statuses = ['created', 'starting', 'running', 'cancelling', 'succeeded', 'failed', 'timed_out', 'cancelled', 'lost'] as const;
const terminal = new Set<string>(['succeeded', 'failed', 'timed_out', 'cancelled', 'lost']);
const matches = ['verified', 'unverified', 'missing', 'mismatch', 'unknown'] as const;
const pins = ['active', 'released', 'missing', 'mismatch', 'unknown'] as const;
const coverages = ['complete', 'unknown'] as const;
const restarts = ['none', 'pending', 'unknown'] as const;
const cleanupStates = ['confirmed', 'pending', 'unknown'] as const;
const commits = ['recorded', 'not_succeeded', 'unknown'] as const;
const executionPattern = /^ex1_[0-9a-f]{64}$/;
const pinPattern = /^pin_[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}$/;
const storePattern = /^store_[0-9a-f]{32}$/;

/** Matches Run's ASCII agent ID and Chrono's greedy, whitespace-tolerant calendar parser. */
export function validRunAgentId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 29 || !/^ag-[\x00-\x7f]{15}-[0-9a-f]{10}$/.test(value)) return false;
  const input = value.slice(3, 18); let offset = 0;
  const read = (width: number, signed = false): number | null => {
    while (offset < input.length && /[\t\n\v\f\r ]/.test(input[offset])) offset++;
    let sign = 1, limit = width;
    if (signed && (input[offset] === '+' || input[offset] === '-')) { sign = input[offset++] === '-' ? -1 : 1; limit = input.length; }
    const start = offset;
    while (offset < input.length && offset - start < limit && /[0-9]/.test(input[offset])) offset++;
    return offset === start ? null : sign * Number(input.slice(start, offset));
  };
  const year = read(4, true), month = read(2), day = read(2);
  if (input[offset++] !== '-') return false;
  const hour = read(2), minute = read(2), second = read(2);
  if (offset !== input.length || year === null || month === null || day === null || hour === null || minute === null || second === null || !Number.isSafeInteger(year) || year < -262143 || year > 262142 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 60) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= days[month - 1];
}

/** One source selector; optional fields never become proof merely by being present. */
export interface RunStatusSelector {
  agent_id: string;
  sequence: number;
  execution_ref?: string;
  pin_id?: string;
}

/** The exact one-target request used to inspect a Pool binding. */
export interface RunStatusRequest {
  version: 1;
  targets: [RunStatusSelector];
  include_view: true;
  expected_store_id?: string;
}

/** A retained execution row, independent of its lineage's logical outcome. */
export interface RunExecutionFact {
  sequence: number;
  executionRef: string | null;
  rawStatus: typeof statuses[number];
}

/** Correlated database facts and separately sampled selected view. */
export interface RunStatusEvidence {
  storeId: string;
  storeFenced: boolean;
  observedAt: number;
  canonicalAgentId: string | null;
  match: typeof matches[number];
  pinState: typeof pins[number];
  selected: RunExecutionFact | null;
  retainedLatest: RunExecutionFact | null;
  coverage: typeof coverages[number];
  restartResume: typeof restarts[number];
  lineageTerminal: boolean | null;
  terminalOutcome: typeof statuses[number] | null;
  successCommit: typeof commits[number];
  cleanup: typeof cleanupStates[number];
  view: { agent: RunAgent; sampledAt: number } | null;
}

/** Summarizes only source lineage facts; raw selected-row status is not a lineage outcome. */
export function runLineageLabel(value: RunStatusEvidence): string {
  if (value.restartResume === 'pending') return 'restart pending';
  if (value.lineageTerminal === true && value.terminalOutcome && value.retainedLatest) return `${value.terminalOutcome} (latest #${value.retainedLatest.sequence})`;
  if (value.lineageTerminal === false) return 'not terminal';
  return 'unknown';
}

/** Rejects malformed optional identities instead of weakening the requested selector. */
function optionalIdentity(value: unknown, pattern: RegExp): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || pattern.exec(value)?.[0] !== value) throw new Error('status_identity');
  return value;
}

/** Reads one declared literal without coercing an unknown source value. */
function literal<T extends string>(value: unknown, options: readonly T[]): T {
  if (typeof value !== 'string' || !options.includes(value as T)) throw new Error('status_literal');
  return value as T;
}

/** Validates a positive Run execution sequence in the producer's u32 range. */
function sequence(value: unknown): number {
  const parsed = integer(value);
  if (parsed < 1 || parsed > 0xffff_ffff) throw new Error('status_sequence');
  return parsed;
}

/** Reads a nonnegative source timestamp in Unix seconds. */
function clock(value: unknown): number {
  const parsed = number(value);
  if (parsed === null || parsed < 0) throw new Error('status_clock');
  return parsed;
}

/** Extracts a validated v1 request from one owner-observed Pool binding. */
export function runStatusRequest(binding: Record<string, unknown>): RunStatusRequest {
  if (!validRunAgentId(binding.run_id)) throw new Error('status_agent_id');
  const executionRef = optionalIdentity(binding.run_execution_ref, executionPattern);
  const pinId = optionalIdentity(binding.run_pin_id, pinPattern);
  const storeId = optionalIdentity(binding.run_store_id, storePattern);
  return {
    version: 1,
    targets: [{ agent_id: binding.run_id, sequence: sequence(binding.run_sequence), ...(executionRef ? { execution_ref: executionRef } : {}), ...(pinId ? { pin_id: pinId } : {}) }],
    include_view: true,
    ...(storeId ? { expected_store_id: storeId } : {}),
  };
}

/** Parses a nullable retained row while keeping raw status separate from lineage status. */
function execution(value: unknown): RunExecutionFact | null {
  if (value === null) return null;
  const row = object(value), ref = optionalIdentity(row.execution_ref, executionPattern);
  if (row.execution_ref === undefined) throw new Error('status_execution_ref');
  return { sequence: sequence(row.sequence), executionRef: ref ?? null, rawStatus: literal(row.raw_status, statuses) };
}

/** Rejects miscorrelated or contradictory v1 evidence for the exact requested target. */
export function parseRunStatus(value: unknown, request: RunStatusRequest): RunStatusEvidence {
  const output = object(value), target = request.targets[0];
  if (!validRunAgentId(target.agent_id)) throw new Error('status_agent_id');
  const storeId = optionalIdentity(output.store_id, storePattern);
  if (output.version !== 1 || !storeId || request.expected_store_id && request.expected_store_id !== storeId || !Array.isArray(output.items) || output.items.length !== 1) throw new Error('status_envelope');
  const observedAt = clock(output.observed_at), item = object(output.items[0]), selector = object(item.selector);
  const echoedRef = optionalIdentity(selector.execution_ref, executionPattern), echoedPin = optionalIdentity(selector.pin_id, pinPattern);
  if (selector.agent_id !== target.agent_id || sequence(selector.sequence) !== target.sequence || echoedRef !== target.execution_ref || echoedPin !== target.pin_id) throw new Error('status_selector');
  const match = literal(item.match, matches), pinState = literal(item.pin_state, pins);
  const pinId = optionalIdentity(item.pin_id, pinPattern);
  if (item.pin_id === undefined || pinId !== target.pin_id || !pinId && pinState !== 'missing') throw new Error('status_pin');
  const canonical = item.canonical_agent_id;
  if (canonical !== null && !validRunAgentId(canonical)) throw new Error('status_canonical');
  if (['active', 'released', 'mismatch'].includes(pinState) && (!pinId || !canonical)) throw new Error('status_pin');
  const selected = execution(item.selected), retainedLatest = execution(item.retained_latest);
  if ((selected || retainedLatest) && !canonical || selected && selected.sequence !== target.sequence || selected && retainedLatest && (retainedLatest.sequence < selected.sequence || retainedLatest.sequence === selected.sequence && (retainedLatest.executionRef !== selected.executionRef || retainedLatest.rawStatus !== selected.rawStatus) || retainedLatest.sequence !== selected.sequence && !!selected.executionRef && retainedLatest.executionRef === selected.executionRef)) throw new Error('status_execution');
  if (match === 'verified' && (!canonical || !target.execution_ref || !selected || selected.executionRef !== target.execution_ref) || match === 'unverified' && (!canonical || target.execution_ref || !selected) || (match === 'missing' || match === 'mismatch') && (selected || retainedLatest)) throw new Error('status_match');
  const coverage = literal(item.coverage, coverages), restartResume = literal(item.restart_resume, restarts);
  const lineageTerminal = item.lineage_terminal;
  if (lineageTerminal !== null && typeof lineageTerminal !== 'boolean') throw new Error('status_lineage');
  const terminalOutcome = item.terminal_outcome === null ? null : literal(item.terminal_outcome, statuses);
  const successCommit = literal(item.success_commit, commits), cleanup = object(item.cleanup);
  const cleanupState = literal(cleanup.state, cleanupStates);
  if (match === 'unknown' && (selected?.executionRef || retainedLatest)) throw new Error('status_unknown');
  if (cleanup.scope !== 'lineage' || coverage === 'complete' && (pinState !== 'active' || !canonical || !selected?.executionRef || !retainedLatest?.executionRef || !['verified', 'unverified'].includes(match))) throw new Error('status_coverage');
  if (['missing', 'mismatch', 'unknown'].includes(match) && (coverage !== 'unknown' || restartResume !== 'unknown' || lineageTerminal !== null || cleanupState !== 'unknown' || successCommit !== 'unknown')) throw new Error('status_unmatched');
  if (lineageTerminal === true && (coverage !== 'complete' || match !== 'verified' || restartResume !== 'none' || !retainedLatest || !terminal.has(retainedLatest.rawStatus) || terminalOutcome !== retainedLatest.rawStatus) || lineageTerminal !== true && terminalOutcome !== null) throw new Error('status_outcome');
  if (lineageTerminal === false && restartResume !== 'pending' && (coverage !== 'complete' || match !== 'verified' || restartResume !== 'none' || !retainedLatest || terminal.has(retainedLatest.rawStatus))) throw new Error('status_nonterminal');
  if (cleanupState === 'confirmed' && (coverage !== 'complete' || match !== 'verified' || lineageTerminal !== true || restartResume !== 'none')) throw new Error('status_cleanup');
  if (successCommit === 'recorded' && terminalOutcome !== 'succeeded' || successCommit === 'not_succeeded' && (terminalOutcome === null || terminalOutcome === 'succeeded')) throw new Error('status_commit');
  let view: RunStatusEvidence['view'] = null;
  if (output.view !== undefined && output.view !== null) {
    const rawView = object(output.view), sampledAt = clock(rawView.sampled_at), agent = runAgent(rawView.agent);
    if (!['verified', 'unverified'].includes(match) || rawView.selector_index !== 0 || rawView.match !== match || rawView.status_scope !== 'selected_execution_raw' || !selected || agent.id !== canonical || agent.sequence !== selected.sequence || agent.status !== selected.rawStatus || agent.observed !== sampledAt) throw new Error('status_view');
    view = { agent, sampledAt };
  }
  return { storeId, storeFenced: request.expected_store_id !== undefined, observedAt, canonicalAgentId: canonical as string | null, match, pinState, selected, retainedLatest, coverage, restartResume, lineageTerminal, terminalOutcome, successCommit, cleanup: cleanupState, view };
}
