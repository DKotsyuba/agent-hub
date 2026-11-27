/** Run inventory, lineage evidence, transcript and content projections. */
import { coverage, decimal, opaque, resourceId, sha256 } from './common.ts';
import { type Decoded, array, bool, count, nullable, object, oneOf, optional, tagged, text } from './schema.ts';

/** Producer lifecycle status of one raw execution row. */
export const runStatus = oneOf('created', 'starting', 'running', 'cancelling', 'succeeded', 'failed', 'timed_out', 'cancelled', 'lost');

/** An execution or lineage link with the identity strength known at this read. */
export const sessionLink = object({
  sessionId: resourceId, execution: nullable(opaque),
  match: oneOf('verified', 'unverified', 'missing', 'mismatch', 'unknown'),
});

/** An observed positive Bridge custody backlog for one Pool seat, with its oldest custody clock. */
export const sessionHeldMessages = object({ count, oldestAtMs: count });

/**
 * A list row for a current or retained execution. Clocks are epoch milliseconds.
 * `phase` is the producer's own preparation/execution phase, shown as reported; `idleMs` is its
 * observed idle duration and `phaseStartedAtMs` the start of the current phase.
 */
export const session = object({
  id: resourceId, execution: nullable(opaque), sequence: nullable(count), status: runStatus,
  name: nullable(text), summary: nullable(text), runtime: nullable(text), model: nullable(text), effort: nullable(text), profile: nullable(text),
  projectId: nullable(resourceId), projectInferred: bool, workdir: nullable(text),
  createdAtMs: nullable(count), finishedAtMs: nullable(count), observedAtMs: nullable(count),
  progressAtMs: nullable(count), elapsedMs: nullable(count), silenceMs: nullable(count), lastAction: nullable(text),
  phase: nullable(text), phaseStartedAtMs: nullable(count), idleMs: nullable(count),
  heldMessages: optional(sessionHeldMessages),
  failureKind: nullable(text), failureText: nullable(text), answerAvailable: nullable(bool),
});

/** A current or retained execution inventory row. */
export type Session = Decoded<typeof session>;

/** Selected and latest retained executions each have independent lifecycle facts. */
const executionFact = object({ sequence: count, executionRef: nullable(opaque), rawStatus: runStatus });

/** The available Run evidence for a Pool link. Identifiers alone establish no proof. */
export const lineageEvidence = object({
  storeFenced: bool, match: sessionLink,
  pinState: oneOf('active', 'released', 'missing', 'mismatch', 'unknown'),
  selected: nullable(executionFact), retainedLatest: nullable(executionFact),
  coverage, restartResume: oneOf('none', 'pending', 'unknown'),
  lineageTerminal: nullable(bool), terminalOutcome: nullable(runStatus),
  successCommit: oneOf('recorded', 'not_succeeded', 'unknown'),
  cleanup: oneOf('confirmed', 'pending', 'unknown'),
  poolObservedAtMs: nullable(count), statusObservedAtMs: nullable(count), sampledAtMs: nullable(count),
});

/** A safe usage metric projected by the server. Omitted metrics are unknown. */
const usage = object({ metric: resourceId, count: decimal });

/** Attribution available to a history projection. */
const historyAttribution = oneOf('execution_verified', 'retained_lineage', 'unverified');

/** Displayable execution details with independent lineage and content attribution. */
export const sessionDetail = object({
  session, lineage: nullable(lineageEvidence),
  historyAttribution,
  answerAttribution: oneOf('execution_verified', 'unverified', 'unavailable'),
  executionUsage: array(usage), cumulativeUsage: array(usage), toolCounts: array(usage),
  delivery: nullable(text), cleanup: nullable(text),
});

/** A session detail projection. */
export type SessionDetail = Decoded<typeof sessionDetail>;

/** A single transcript fragment, preserving source position and content completeness. */
const fragment = object({
  id: resourceId, position: decimal, role: oneOf('user', 'assistant', 'system', 'tool', 'tool_call', 'tool_result', 'other'),
  name: nullable(text), sourceRef: nullable(text), text, atMs: nullable(count), error: nullable(bool),
  complete: bool, omittedBytes: optional(count),
  firstPosition: optional(decimal), endAtMs: optional(nullable(count)), sourceRole: optional(text),
});

/** A rendered group, with unmatched tool results also representable as a head. */
const transcriptEntry = object({
  head: fragment, calls: array(fragment), results: array(fragment),
  partialBefore: bool, partialAfter: bool,
});

/** Grouped or explicitly legacy raw-forward transcript with an independent verification scope. */
export const sessionHistory = object({
  sessionId: resourceId, execution: nullable(opaque), format: oneOf('grouped', 'legacy_raw'),
  attribution: historyAttribution, entries: array(transcriptEntry), coverage,
});

/** A page of session history. */
export type SessionHistory = Decoded<typeof sessionHistory>;

/** Contiguous UTF-8 text page. Offsets and totals are bytes of the complete content. */
export const textChunk = object({ text, offsetBytes: count, totalBytes: count });

/** Text verified by the server over the full UTF-8 content and an execution selector. */
const executionDigest = object({ execution: opaque, sequence: count, sha256 });

/** Strict task proof requires the store, execution and active pin at the root execution. */
const strictTaskProof = object({
  kind: oneOf('strict'), root: object({ execution: opaque, sequence: oneOf(1), sha256 }), storeFenced: oneOf(true), activePin: oneOf(true),
});

/** Current proof verifies the retained root and makes no historical claim. */
const currentTaskProof = object({ kind: oneOf('current'), root: object({ execution: opaque, sequence: oneOf(1), sha256 }) });

/** Until a proof exists there is no initial-task text in the API. */
export const initialTask = tagged('state', {
  verified: object({
    state: oneOf('verified'), content: textChunk, proof: tagged('kind', { strict: strictTaskProof, current: currentTaskProof }),
  }),
  unverified: object({ state: oneOf('unverified'), reason: resourceId }),
});

/** A verified initial task page or a safe reason for the unverified label. */
export type InitialTask = Decoded<typeof initialTask>;

/** A saved answer is emitted only after full content and execution verification. */
export const sessionResult = object({ content: textChunk, proof: executionDigest });

/** A verified saved answer page. */
export type SessionResult = Decoded<typeof sessionResult>;

/** Retained lineage export uses a fixed source boundary with independent coverage. */
const retainedExport = object({
  mode: oneOf('retained'), content: textChunk, boundary: opaque, coverage,
});

/** Exact export is one pinned execution with a digest over the exported text. */
const exactExport = object({
  mode: oneOf('exact'), content: textChunk, boundary: opaque, coverage,
  proof: object({ content: executionDigest, storeFenced: oneOf(true), activePin: oneOf(true) }),
});

/** Copy/export page under a fixed, opaque boundary. */
export const sessionExport = tagged('mode', { retained: retainedExport, exact: exactExport });

/** Retained or exact session export page. */
export type SessionExport = Decoded<typeof sessionExport>;
