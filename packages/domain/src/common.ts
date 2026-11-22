/** Version, identity, evidence, pagination and response types shared by the v1 routes. */
import { type Decoded, type Decoder, array, bool, count, matching, nullable, object, oneOf, optional, tagged, text } from './schema.ts';

/** HTTP major. Producer wire versions evolve independently. */
export const API_VERSION = 1;

/** Common prefix for all Hub observation routes. */
export const API_PREFIX = '/api/v1';

/** Default, global maximum, and Worktree maximum page sizes in rows. */
export const PAGE_LIMITS = { default: 50, max: 200, worktrees: 20 } as const;

/** URL-safe stable resource identifier. Paths and filesystem inputs are excluded. */
export const resourceId = matching(/[A-Za-z0-9][A-Za-z0-9._-]{0,199}/, 'resource ID');

/** URL-safe opaque selector, boundary or cursor. The server alone interprets it. */
export const opaque = matching(/[A-Za-z0-9._~-]{1,2048}/, 'opaque token');

/** A stable identifier accepted by a resource route. */
export type ResourceId = Decoded<typeof resourceId>;

/** An opaque pagination continuation. */
export type Cursor = Decoded<typeof opaque>;

/** An opaque selector for one execution or a historical Pool binding. */
export type ExecutionSelector = Decoded<typeof opaque>;

/** A canonical unsigned decimal string for producer counters wider than JSON safe integers. */
export const decimal = matching(/(?:0|[1-9][0-9]{0,19})/, 'unsigned decimal string');

/** Hex SHA-256 used only where the producing path verifies it. */
export const sha256 = matching(/[0-9a-f]{64}/, 'SHA-256 digest');

/** Coverage describes the inspected scope and can carry bounds even on incomplete reads. */
export const coverage = object({
  scope: oneOf('current', 'retained', 'execution', 'lineage', 'period', 'source_snapshot', 'listed_inventory'),
  state: oneOf('complete', 'partial', 'unknown'),
  reason: optional(text),
  boundary: optional(opaque),
  fromMs: optional(nullable(count)),
  toMs: optional(nullable(count)),
  scanned: optional(count),
  reportedTotal: optional(nullable(decimal)),
  consistency: optional(oneOf('snapshot', 'revision_fenced', 'offset_unfenced', 'unknown')),
});

/** Coverage applies to its declared scope, including the retained window when applicable. */
export type Coverage = Decoded<typeof coverage>;

/** Differentiates exact counts, lower bounds and unknown values for an independently scoped metric. */
export const evidenceCount = tagged('kind', {
  exact: object({ kind: oneOf('exact'), value: count, coverage: optional(coverage) }),
  lower_bound: object({ kind: oneOf('lower_bound'), value: count, coverage: optional(coverage) }),
  unknown: object({ kind: oneOf('unknown'), value: oneOf(null), coverage: optional(coverage) }),
});

/** A safe issue code with optional producer-independent explanatory text. */
export const issue = object({ code: resourceId, message: optional(text) });

/** Source IDs used for independently observed outcomes. */
export const source = oneOf('run', 'pool', 'quota', 'worktree', 'bridge');

/** An observation outcome before any client-side stale retention. */
export const observationOutcome = oneOf('ok', 'partial', 'unavailable', 'incompatible', 'missing', 'invalid');

/** Clocks use epoch milliseconds. staleSinceMs is present on a retained observation after a failed refresh. */
export const observation = object({
  source, resource: optional(resourceId), outcome: observationOutcome,
  producerAtMs: nullable(count), observedAtMs: count,
  staleSinceMs: optional(count), coverage: optional(coverage), issue: optional(issue),
});

/** Per-source availability, coverage and original timestamp. */
export type Observation = Decoded<typeof observation>;

/** Tri-state producer capabilities. Omission and unknown grant no capability. */
export const capabilityState = oneOf('supported', 'unsupported', 'unknown');

/** Capabilities that change which reads or views the clients can offer. */
export const capabilities = object({
  groupedHistory: optional(capabilityState), bidirectionalHistory: optional(capabilityState),
  initialTaskCurrent: optional(capabilityState), initialTaskStrict: optional(capabilityState),
  verifiedResult: optional(capabilityState), exactExport: optional(capabilityState),
  runBindings: optional(capabilityState), runProofs: optional(capabilityState),
  poolKind: optional(capabilityState), inventorySnapshot: optional(capabilityState),
  completionTotals: optional(capabilityState), completionRecord: optional(capabilityState),
  agreementRecord: optional(capabilityState), formerMember: optional(capabilityState),
  worktreeInspect: optional(capabilityState), bridgeIncidents: optional(capabilityState),
});

/** Capability gates for a particular resource response. */
export type Capabilities = Decoded<typeof capabilities>;

/** Previous loads older data. Resume is the latest applied live position, separate from the older anchor. */
export const page = object({ next: nullable(opaque), previous: nullable(opaque), resume: nullable(opaque) });

/** The three independent continuations of a page. */
export type Page = Decoded<typeof page>;

/** Wraps an unpaged observation. */
export function response<T>(data: Decoder<T>) {
  return object({ data, observations: array(observation), capabilities: optional(capabilities) });
}

/** Wraps a collection or text page with required continuation metadata. */
export function pagedResponse<T>(data: Decoder<T>) {
  return object({ data, page, observations: array(observation), capabilities: optional(capabilities) });
}

/** Stable machine codes and their HTTP statuses. */
export const ERROR_STATUS = {
  invalid_request: 400, not_found: 404, method_not_allowed: 405, stale_boundary: 409,
  unsupported_capability: 422, saturated: 429, invalid_projection: 502, source_unavailable: 503,
} as const;

/** Machine code clients can localize and use to decide how to recover. */
export type ErrorCode = keyof typeof ERROR_STATUS;

/** Failure response for any endpoint before an SSE stream opens. */
export const apiError = object({
  error: object({
    code: matching(/[a-z][a-z0-9_]{0,79}/, 'machine error code'),
    message: text, retryable: bool, requestId: resourceId,
  }),
});

/** Safe failure response body. */
export type ApiError = Decoded<typeof apiError>;
