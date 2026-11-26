/** Pool inventory, membership, discussion, completion and recorded agreement data. */
import { coverage, decimal, opaque, resourceId, sha256 } from './common.ts';
import { lineageEvidence, runStatus, session, sessionLink, textChunk } from './sessions.ts';
import { type Decoded, array, bool, count, nullable, object, oneOf, optional, tagged, text } from './schema.ts';

/** A completion or agreement record is selectable only when Pool reports its reference. */
const recordRef = object({ id: resourceId, kind: oneOf('completion', 'agreement') });

/** One Pool row. Omitted record means unreported, while null means reported absent. */
export const pool = object({
  id: resourceId, name: nullable(text), purposePreview: nullable(text), leader: nullable(text),
  state: oneOf('open', 'closed', 'unknown'), kind: nullable(oneOf('chat', 'managed')),
  revision: nullable(decimal), record: optional(nullable(recordRef)),
});

/** A retained inventory row with an independent closure state. */
export type Pool = Decoded<typeof pool>;

/** Display lifecycle uses closure first, then a reported completion record. */
export function poolLifecycle(state: Pool['state'], completionId: string | null | undefined): 'live' | 'completed' | 'closed' | 'unknown' {
  return state === 'closed' ? 'closed' : completionId ? 'completed' : state === 'open' ? 'live' : 'unknown';
}

/** Matches lifecycle filters or the raw closure filters retained for API compatibility. */
export function matchesPoolState(row: Pool, state: 'live' | 'finished' | 'open' | 'closed' | 'all'): boolean {
  const lifecycle = poolLifecycle(row.state, row.record?.id);
  if (state === 'live') return lifecycle === 'live';
  if (state === 'finished') return lifecycle === 'completed' || lifecycle === 'closed';
  return state === 'all' || row.state === state;
}

/** Source totals share a Pool snapshot. The optional Live count requires complete row coverage. */
const totals = object({
  revision: opaque, retained: decimal, closed: decimal, unknown: decimal, open: nullable(decimal), completed: nullable(decimal),
  live: optional(nullable(decimal)),
});

/** Retained pool inventory and any independent source-wide totals. */
export const pools = object({ items: array(pool), totals: nullable(totals) });

/** Retained pools and optional source-wide totals. */
export type Pools = Decoded<typeof pools>;

/** Pool metadata and selected proposal reference. */
export const poolDetail = object({ pool, proposalId: nullable(resourceId), coverage });

/** A metadata response's data for the selected pool. */
export type PoolDetail = Decoded<typeof poolDetail>;

/** Chat seat admission and joining are separate Pool facts. */
const seat = object({
  id: resourceId, profile: text, admission: oneOf('pending', 'admitted', 'refused', 'unknown'), joined: bool,
});

/**
 * The linked Run execution's own display row: lifecycle, current phase, reported idleness,
 * model and clocks. It is omitted by older servers and null when the member is unlinked or
 * the Run row is unavailable, so the same check cannot invent a live state.
 */
/** The linked Run agent's own session row, rendered exactly like the Sessions list. */
const memberRun = session;

/** A roster entry and any available Run identity and live-row evidence. */
export const member = object({
  id: resourceId, name: nullable(text), role: nullable(text), task: nullable(text),
  state: nullable(text), runtime: nullable(text),
  seat: nullable(seat), session: nullable(sessionLink), run: optional(nullable(memberRun)),
  lineage: nullable(lineageEvidence),
});

/** A member or chat seat. */
export type PoolMember = Decoded<typeof member>;

/** One decision or criterion and its observer-reported state and rationale. */
const finding = object({
  id: resourceId, proposalId: nullable(resourceId), title: nullable(text), text, state: nullable(text),
  evidence: nullable(text), atMs: nullable(count),
});

/** One producer proposal, including the roster boundary used for votes. */
const proposal = object({
  id: resourceId, title: nullable(text), resultPreview: nullable(text), state: nullable(text),
  rosterKey: nullable(text), voters: array(resourceId), atMs: nullable(count),
  criteriaText: optional(nullable(text)), snapshotBytes: optional(nullable(count)),
});

/** A ballot and its criterion evidence. */
const vote = object({
  id: resourceId, proposalId: resourceId, memberId: resourceId, choice: text, evidence: nullable(text),
  criteria: array(finding), atMs: nullable(count), validity: optional(nullable(text)),
  checksMet: optional(nullable(bool)), checksReported: optional(nullable(count)),
  checksComplete: optional(bool), voteEventId: optional(nullable(decimal)),
});

/** Delivery and replacement facts. Former-session links retain their available evidence. */
const delivery = object({
  id: resourceId, memberId: nullable(resourceId), state: nullable(text), kind: nullable(text),
  text: nullable(text), atMs: nullable(count), formerMemberId: nullable(resourceId),
  formerSession: nullable(sessionLink), formerLineage: nullable(lineageEvidence),
});

/** Builds a section page whose discriminator matches the route selection. */
function section<const K extends string, T>(kind: K, item: (value: unknown, path?: string) => T) {
  return object({ section: oneOf(kind), revision: nullable(decimal), items: array(item) });
}

/** Closed set of section names supported by v1. */
export const POOL_SECTIONS = ['members', 'proposals', 'decisions', 'criteria', 'votes', 'deliveries'] as const;

/** The accepted name in the Pool sections path. */
export type PoolSection = typeof POOL_SECTIONS[number];

/** Section DTOs remain discriminated for clients. */
export const poolSection = tagged('section', {
  members: section('members', member), proposals: section('proposals', proposal),
  decisions: section('decisions', finding), criteria: section('criteria', finding),
  votes: section('votes', vote), deliveries: section('deliveries', delivery),
});

/** One page of a selected Pool section. */
export type PoolSectionData = Decoded<typeof poolSection>;

/** One discussion event grouped with its text parts. */
const message = object({
  id: resourceId, position: decimal, revision: nullable(decimal), kind: text,
  authorKind: nullable(text), authorId: nullable(resourceId), recipientId: nullable(resourceId),
  atMs: nullable(count), parts: array(text), complete: bool, valid: bool,
  proposalId: nullable(resourceId),
  partRange: optional(object({ first: nullable(count), last: nullable(count), expected: nullable(count) })),
});

/** Discussion window; upper bound can be reused via an opaque export continuation. */
export const poolHistory = object({
  poolId: resourceId, format: oneOf('window', 'legacy_forward'),
  upperBound: nullable(opaque), items: array(message), coverage,
});

/** Selected discussion/chat page. */
export type PoolHistory = Decoded<typeof poolHistory>;

/** A revision-bound page of Pool purpose or proposal snapshot. */
export const poolContent = object({
  poolId: resourceId, field: oneOf('purpose', 'snapshot'), proposalId: nullable(resourceId),
  revision: decimal, content: textChunk,
});

/** Text page for a projected Pool field. */
export type PoolContent = Decoded<typeof poolContent>;

/** One digest-verified text field in a frozen completion record. */
const completionContent = object({
  field: oneOf('goal', 'criteria', 'result', 'snapshot'), content: textChunk, sha256,
});

/** Printable header facts with counts and explicit absent content. */
const completionHeader = object({
  version: count, algorithm: oneOf('sha256'), commitPosition: nullable(decimal),
  proposalId: nullable(resourceId), leader: nullable(text), rosterCount: nullable(count), ballotCount: nullable(count),
  absentFields: array(oneOf('goal', 'criteria', 'result', 'snapshot')),
});

/** Frozen completion pages can carry several evidence sections under one record digest. */
const completion = object({
  kind: oneOf('completion'), id: resourceId, poolId: resourceId, revision: decimal, recordDigest: sha256,
  header: completionHeader, content: array(completionContent), roster: array(member), ballots: array(vote),
  runFacts: array(lineageEvidence), notice: nullable(text), completedAtMs: nullable(count),
});

/** A chat ballot links to a Run seat without claiming that Run verified the agreement. */
const agreementBallot = object({
  seatId: resourceId, session: sessionLink, voteEventId: decimal,
});

/** A Pool-recorded agreement carries no digest. */
const agreement = object({
  kind: oneOf('agreement'), id: resourceId, poolId: resourceId, revision: decimal,
  eventId: decimal, proposalId: resourceId, rosterKey: text,
  result: textChunk, ballots: array(agreementBallot), recordedAtMs: nullable(count),
});

/** One page of the requested frozen completion or Pool-recorded agreement. */
export const poolRecord = tagged('kind', { completion, agreement });

/** Completion and agreement pages remain distinct on the wire. */
export type PoolRecord = Decoded<typeof poolRecord>;
