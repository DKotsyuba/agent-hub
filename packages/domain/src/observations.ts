/** Projections for Overview, Bridge, Quota and Worktree. */
import { coverage, evidenceCount, issue, resourceId } from './common.ts';
import { session, sessionLink } from './sessions.ts';
import { type Decoded, type Decoder, array, bool, count, nullable, number, object, oneOf, optional, tagged, text } from './schema.ts';

/** Overview uses client-selected epoch millisecond bounds and independent source metrics. */
export const overview = object({
  from: nullable(count), to: nullable(count),
  run: nullable(object({
    active: evidenceCount, started: evidenceCount, succeeded: evidenceCount, failed: evidenceCount,
    finished: evidenceCount, current: array(session),
  })),
  bridge: nullable(object({ accepted: evidenceCount, pending: evidenceCount, incidents: evidenceCount })),
  quota: nullable(object({
    accounts: count, known: count, unknown: count, exhausted: count, stale: count,
    exhaustion: optional(object({ account: text, provider: optional(text), window: text, lane: text, atMs: count, resetAtMs: count, validUntilMs: nullable(count) })),
    lowest: nullable(object({ account: text, model: text, remaining: number, provider: optional(text), stale: optional(bool) })),
  })),
});

/** Independently observed Overview metrics. */
export type Overview = Decoded<typeof overview>;

/** A retained Bridge incident with its original clocks and safe display metadata. */
export const bridgeIncident = object({
  id: resourceId, publisher: nullable(text), eventId: nullable(text), state: text, closed: nullable(bool),
  createdAtMs: nullable(count), updatedAtMs: nullable(count), detail: nullable(text),
});

/** A projected Bridge incident. */
export type BridgeIncident = Decoded<typeof bridgeIncident>;

/** A Quota model's limit identity. */
const quotaKey = { pool: text, source: text, window: text };

/** Producer-confirmed validity, including an exhaustion latch without a reported reset. */
const validity = tagged('kind', {
  until: object({ kind: oneOf('until'), atMs: count }),
  latched_no_reset: object({ kind: oneOf('latched_no_reset') }),
  unknown: object({ kind: oneOf('unknown') }),
});

/** Numbers remain nullable; burn is percentage points per hour. */
const quotaModel = object({
  provider: text, model: text, nativeModel: nullable(text), state: oneOf('known', 'unknown', 'exhausted'),
  validity, score: nullable(number), window: nullable(object(quotaKey)), remaining: nullable(number),
  burn: nullable(number), resetAtMs: nullable(count), risk: text, evidence: text,
  newestObservedAtMs: nullable(count), exhaustedUntilMs: nullable(count), pools: array(text),
});

/** Provider window with observed sample, forecast, and available reset evidence. */
const quotaWindow = object({
  ...quotaKey, lane: text, runtime: text, models: array(text),
  observedAtMs: nullable(count), validUntilMs: nullable(count), lastRemaining: nullable(number),
  lastResetAtMs: nullable(count), forecastKnown: bool, risk: text, marker: nullable(text),
  projected: nullable(number), sustainable: nullable(number), burn: nullable(number),
});

/** A latch remains distinct from the freshness of any quota sample. */
const quotaLatch = object({
  ...quotaKey, active: bool, observedAtMs: nullable(count), resetAtMs: nullable(count), models: array(text),
});

/** Account projection with advice and technical detail. */
const quotaAccount = object({
  account: text, models: array(quotaModel), windows: array(quotaWindow), latches: array(quotaLatch), advice: array(text),
});

/** Quota's validated collection results and coverage. */
const quotaSnapshot = object({
  revision: nullable(count), evaluatedAtMs: nullable(count), configRevision: nullable(text),
  coverage: object({
    state: text, unobserved: array(text), lastCollectionAtMs: nullable(count), lastCollectionOk: nullable(bool),
    sources: array(object({
      account: text, provider: text, source: text, status: text, windows: nullable(count), issues: array(text),
    })),
  }),
  accounts: array(quotaAccount),
});

/** Service status is usable even when a snapshot cannot be projected. */
const quotaStatus = object({
  status: text, startedAtMs: nullable(count), sourceCount: nullable(count),
  lastCollectionAtMs: nullable(count), lastCollectionOk: nullable(bool),
  external: array(object({
    account: text, provider: text, source: text, acceptedAtMs: nullable(count), revision: nullable(count),
  })),
});

/** Independent views of the Quota producer. */
export const quota = object({ status: nullable(quotaStatus), snapshot: nullable(quotaSnapshot) });

/** Quota status and snapshot projection. */
export type Quota = Decoded<typeof quota>;

/** A probe carries its own value and quality even when a sibling probe is unavailable. */
function measured<T>(decode: Decoder<T>) {
  return tagged('state', {
    known: object({ state: oneOf('known'), value: decode, lowerBound: bool }),
    unavailable: object({ state: oneOf('unavailable'), code: nullable(resourceId) }),
    not_checked: object({ state: oneOf('not_checked'), code: nullable(resourceId) }),
  });
}

/** Cached Worktree axes and age of the bounded inspection. */
const worktreeFacts = object({
  observedAtMs: nullable(count), expiresAtMs: nullable(count),
  status: measured(object({ staged: count, unstaged: count, untracked: count, conflicts: count })),
  size: measured(count),
});

/** Discovered project with a safe stable ID for filters and path-based startup matching. */
const project = object({ id: resourceId, name: text, path: nullable(text), coverage });

/** Listed row with source-reported activity and integration, cached facts and Run links. */
export const worktree = object({
  id: resourceId, projectId: resourceId, class: text, path: nullable(text),
  branch: nullable(text), detached: nullable(bool), head: nullable(text),
  activity: nullable(text), mtimeBased: bool, integration: nullable(text),
  removalStarted: bool, creator: nullable(text), facts: worktreeFacts, sessions: array(sessionLink),
});

/** One listed Worktree row. */
export type Worktree = Decoded<typeof worktree>;

/** Listed inventory and project groups, including projects without retained rows. */
export const worktrees = object({ projects: array(project), items: array(worktree) });

/** Worktree inventory page data. */
export type Worktrees = Decoded<typeof worktrees>;

/** Curated display facts projected from Worktree's hygiene and managed record. */
const inspectField = object({ key: text, value: nullable(text) });

/** Bounded inspect outcome and recognized technical diagnostics for a listed row. */
export const worktreeDetail = object({
  worktree, coverage, warnings: array(issue),
  inspectedAtMs: optional(nullable(count)), repositoryPath: optional(nullable(text)),
  activitySignals: optional(object({
    headMtimeMs: nullable(count), indexMtimeMs: nullable(count), reflogAtMs: nullable(count),
  })),
  hygiene: optional(array(inspectField)), managedRecord: optional(nullable(array(inspectField))),
  probes: array(object({ name: text, state: text, code: nullable(resourceId), detail: nullable(text) })),
});

/** A listed worktree and its bounded inspect result. */
export type WorktreeDetail = Decoded<typeof worktreeDetail>;
