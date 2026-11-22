/** Standalone Pool projections with revision, watermark, and record fences. */
import { type Capabilities, type Pool, type PoolMember } from '@agent-hub/domain';
import { integer, object, product, text } from '../../src/live/protocol.ts';
import { groupPoolEvents, poolContentPage, poolFormerBinding, poolInventory, poolSection as checkSection, poolWindow, type PoolSection } from '../../terminal/src/pool.ts';
import { poolFacts, poolSeat } from '../../terminal/src/pool-chat.ts';
import { inventorySnapshotPage, type InventoryCursor } from '../../terminal/src/pool-inventory.ts';
import { agreementRecord, completionContent, completionIdFromEvents, completionPage, COMPLETION_SECTIONS } from '../../terminal/src/completion.ts';
import { parsePoolRunProof } from '../../terminal/src/pool-run-proof.ts';
import { parseRunStatus, runStatusRequest, type RunStatusEvidence } from '../../terminal/src/run-status.ts';
import { digest, type Position } from './cursor.ts';
import { HubError } from './errors.ts';
import { coverage, decimalValue, field, ms, noPage, observed, optionalObject, records, requireData, type Input, type ReadContext } from './projection.ts';
import { registerBinding } from './run.ts';

/** Validates the product identity and exposes tri-state feature gates. */
async function identity(ctx: ReadContext) {
  const envelope = await ctx.read('pool.identity');
  const data = product(requireData(envelope), 'identity');
  if (!Array.isArray(data.capabilities) || data.capabilities.some(value => typeof value !== 'string')) throw new HubError('invalid_projection');
  const has = (name: string) => (data.capabilities as string[]).includes(name);
  const gate = (name: string) => has(name) ? 'supported' as const : 'unsupported' as const;
  const capabilities: Capabilities = {
    inventorySnapshot: gate('inventory_snapshot_v1'), bidirectionalHistory: gate('history_window_v1'),
    runProofs: gate('run_proof_v1'), runBindings: has('observer_socket_v1') ? 'unsupported' : 'unknown',
    completionRecord: gate('completion_record_v1'), formerMember: has('observer_socket_v1') ? 'unsupported' : 'supported',
  };
  return { has, capabilities };
}

/** Converts source metadata while preserving absent versus explicitly absent completion. */
function row(raw: Record<string, unknown>, data: Record<string, unknown>): Pool {
  const facts = poolFacts(data, raw);
  return {
    id: String(raw.pool_id), name: text(raw.name), purposePreview: text(raw.purpose)?.slice(0, 2048) ?? null,
    leader: text(data.leader_id), state: raw.closed === true ? 'closed' : raw.closed === false ? 'open' : 'unknown',
    kind: facts.kind, revision: raw.revision == null ? null : decimalValue(raw.revision),
    ...(facts.completionId === null ? { record: null } : facts.completionId && facts.kind ? {
      record: { id: facts.completionId, kind: facts.kind === 'chat' ? 'agreement' : 'completion' },
    } : {}),
  };
}

/** Reads and deduplicates a bounded inventory while preserving independent snapshot totals. */
export async function pools(ctx: ReadContext, query: Input<'pools'>, position: Position | null) {
  const { has, capabilities } = await identity(ctx);
  const snapshot = has('inventory_snapshot_v1');
  const rows: Pool[] = [];
  let sourceFence: string | null = null, totals = null, producerAt = null;
  let continuation: InventoryCursor | null = null, after: string | null = null;
  const params = { filter: 'all' as const, limit: 10 };
  let envelope = await ctx.read(snapshot ? 'pool.inventory_snapshot' : 'pool.list', snapshot ? params : {});
  let complete = false;
  for (let i = 0; i < 8; i++) {
    const value = requireData(envelope);
    if (snapshot) {
      const page = inventorySnapshotPage(value, { ...params, cursor: continuation });
      const fence = digest([page.source, page.totals]);
      if (sourceFence !== null && sourceFence !== fence) throw new HubError('stale_boundary');
      sourceFence = fence;
      producerAt ??= page.observedAtMs;
      totals ??= { revision: fence, retained: page.totals.total, closed: page.totals.closed, unknown: page.totals.unknown, open: page.totals.open, completed: page.totals.completed };
      rows.push(...page.rows.map(entry => row(object(entry.pool), entry)));
      continuation = page.next;
      complete = continuation === null;
      if (!complete && i < 7) envelope = await ctx.read('pool.inventory_snapshot', { ...params, cursor: continuation });
    } else {
      const page = poolInventory(value, after);
      producerAt ??= typeof page.raw.observed_at_unix_ms === 'number' ? page.raw.observed_at_unix_ms : null;
      rows.push(...page.items.map(entry => row(object(entry.pool), entry)));
      after = page.next == null ? null : String(page.next);
      complete = after === null && page.complete;
      if (after !== null && i < 7) envelope = await ctx.read('pool.list', { after });
      else break;
    }
    if (complete) break;
  }
  if (complete && totals && BigInt(rows.length) !== BigInt(totals.retained)) throw new HubError('invalid_projection');
  const items = [...new Map(rows.map(item => [item.id, item])).values()].filter(item =>
    (query.state === 'all' || query.state === item.state) &&
    (!query.q || [item.id, item.name, item.purposePreview].some(value => value?.toLowerCase().includes(query.q.toLowerCase()))));
  const page = ctx.cursors.slice(query, position, items, digest([sourceFence, items]), query.limit);
  const scope = coverage('retained', complete, snapshot ? 'snapshot' : 'offset_unfenced');
  return { data: { items: page.items, totals }, page: page.page, observations: [observed(envelope, producerAt, scope)],
    capabilities: { ...capabilities, completionTotals: totals?.completed == null ? 'unsupported' : 'supported' } };
}

/** Checks one metadata page without loading historical content. */
async function metadata(ctx: ReadContext, id: string) {
  const envelope = await ctx.read('pool.get', { pool_id: id, section: 'proposal', after: 0 });
  const data = checkSection(requireData(envelope), id, 'proposal', 0, null);
  const view = object(data.view), raw = object(view.pool);
  return { pool: row(raw, data), proposalId: field(raw.proposal, 'proposal_id'), envelope };
}

/** Returns Pool metadata and only capabilities available in the chosen observation path. */
export async function pool(ctx: ReadContext, query: Input<'pool'>) {
  const [meta, features] = await Promise.all([metadata(ctx, query.id), identity(ctx)]);
  let selected = meta.pool;
  if (selected.record === undefined && !selected.kind && features.has('completion_record_v1') && features.has('history_window_v1')) {
    const journal = await ctx.read('pool.get', { pool_id: query.id, section: 'history', direction: 'backward' });
    if (journal.outcome === 'ok' || journal.outcome === 'partial') {
      const id = completionIdFromEvents(poolWindow(journal.data, query.id, 'backward', null, null).entries);
      if (id) selected = { ...selected, record: { id, kind: 'completion' } };
    }
  }
  const scope = coverage('current', true);
  return { data: { pool: selected, proposalId: meta.proposalId, coverage: scope }, observations: [observed(meta.envelope, null, scope)], capabilities: {
    ...features.capabilities, poolKind: selected.kind ? 'supported' : 'unknown',
    agreementRecord: selected.kind === 'chat' && features.has('completion_record_v1') ? 'supported' : 'unknown',
  } };
}

/** Projects a display member and labels a bare seat link as unverified. */
function member(raw: Record<string, unknown>): PoolMember {
  const seat = poolSeat(raw);
  return {
    id: String(raw.member_id), name: text(raw.name), role: text(raw.role), task: text(raw.task), state: text(raw.state), runtime: text(raw.runtime),
    seat: seat ? { id: seat.seatId, profile: seat.profile, admission: seat.admission, joined: seat.joined } : null,
    session: seat?.runAgentId ? { sessionId: seat.runAgentId, execution: null, match: 'unverified' } : null, lineage: null,
  };
}

/** Projects the selected criterion or decision without inventing an evaluation. */
function finding(raw: Record<string, unknown>, proposal: string | null, index: number) {
  return { id: text(raw.criterion_id ?? raw.decision_id ?? raw.proposal_id ?? raw.id) ?? 'item-' + digest([proposal, index, raw]),
    proposalId: text(raw.proposal_id) ?? proposal, title: text(raw.title), text: text(raw.text ?? raw.criteria ?? raw.description ?? raw.summary) ?? '',
    state: text(raw.state ?? raw.status), evidence: text(raw.evidence ?? raw.rationale) ?? field(raw.evidence, 'text'), atMs: ms(raw.at ?? raw.created_at) };
}

/** Projects a proposal with the roster evidence reported by the producer. */
function proposal(raw: Record<string, unknown>) {
  return { id: String(raw.proposal_id), title: text(raw.title), resultPreview: text(raw.result ?? raw.result_preview), state: text(raw.state),
    rosterKey: text(raw.roster_key), voters: Array.isArray(raw.voters) ? raw.voters : [], atMs: ms(raw.at ?? raw.created_at), criteriaText: text(raw.criteria),
    snapshotBytes: typeof raw.snapshot_bytes === 'number' ? raw.snapshot_bytes : null };
}

/** Projects a ballot, including structured criterion evidence when present. */
function vote(raw: Record<string, unknown>, memberId: string, proposalId: string) {
  const evidence = text(raw.evidence) ?? field(raw.evidence, 'text');
  return { id: 'vote-' + digest([proposalId, memberId]), proposalId, memberId, choice: text(raw.choice), evidence,
    criteria: Array.isArray(raw.checks) ? records(raw.checks).map((item, index) => finding(item, proposalId, index)) : [],
    atMs: ms(raw.at ?? raw.created_at), validity: text(raw.validity),
    checksMet: typeof raw.checks_met === 'boolean' ? raw.checks_met : null,
    checksReported: typeof raw.checks_count === 'number' ? raw.checks_count : null,
    checksComplete: Array.isArray(raw.checks) ? true : undefined,
    voteEventId: raw.vote_event_id == null ? null : decimalValue(raw.vote_event_id) };
}

/** Uses owner-observed bindings only and keeps failures independent of roster availability. */
async function linkedMember(ctx: ReadContext, value: Record<string, unknown>, id: string, revision: number, bindings: unknown, proofSupported: boolean): Promise<PoolMember> {
  const base = member(value);
  const binding = bindings == null ? undefined : records(bindings).find(item => object(item.member).member_id === base.id && item.pool_id === id);
  const sessionId = text(binding?.run_id);
  if (!binding || !sessionId) return base;
  base.session = { sessionId, execution: null, match: 'unverified' };
  if (!proofSupported || !binding.run_store_id || !binding.run_execution_ref || !binding.run_pin_id) return base;
  const native = await ctx.read('pool.run_proof', { pool_id: id, member_id: base.id, expected_revision: revision, section: 'run_proof' });
  if (native.outcome !== 'ok') return base;
  const proof = parsePoolRunProof(native.data, { poolId: id, memberId: base.id, revision, binding });
  if (proof.state !== 'observed') return base;
  const e = proof.evidence;
  const execution = e.match === 'verified' && e.canonicalAgentId === sessionId
    ? registerBinding(ctx, runStatusRequest(binding)) : null;
  base.session = { sessionId, execution, match: e.match };
  base.lineage = lineage(e, base.session, proof.observedAtMs);
  return base;
}

/** Projects verified producer status separately from the availability of linked content. */
function lineage(e: RunStatusEvidence, match: NonNullable<PoolMember['session']>, poolObservedAtMs: number | null): NonNullable<PoolMember['lineage']> {
  return {
    storeFenced: e.storeFenced, match, pinState: e.pinState, selected: e.selected, retainedLatest: e.retainedLatest,
    coverage: { scope: 'lineage', state: e.coverage }, restartResume: e.restartResume, lineageTerminal: e.lineageTerminal,
    terminalOutcome: e.terminalOutcome, successCommit: e.successCommit, cleanup: e.cleanup, poolObservedAtMs,
    statusObservedAtMs: ms(e.observedAt), sampledAtMs: ms(e.view?.sampledAt),
  };
}

/** Resolves one retained replacement only through the owner-authorized binding and proof path. */
async function delivery(ctx: ReadContext, item: Record<string, unknown>, id: string, revision: number,
  features: Awaited<ReturnType<typeof identity>>, inspectBinding: boolean) {
  const formerMemberId = item.operation === 'replace' && item.state === 'accepted' ? text(item.member_id) : null;
  let formerSession: PoolMember['session'] = null, formerLineage: PoolMember['lineage'] = null;
  if (formerMemberId && inspectBinding && !features.has('observer_socket_v1')) {
    const envelope = await ctx.read('pool.get', { pool_id: id, section: 'binding', member_id: formerMemberId, expected_revision: revision });
    if (envelope.outcome === 'ok') {
      const binding = poolFormerBinding(envelope.data, id, formerMemberId, revision);
      const former = await linkedMember(ctx, object(binding.member), id, revision, [binding], features.has('run_proof_v1'));
      formerSession = former.session;
      formerLineage = former.lineage;
    }
  }
  return { id: String(item.operation_id), memberId: text(item.member_id), state: text(item.state), kind: text(item.operation),
    text: text(item.attention ?? item.message), atMs: ms(item.at ?? item.created_at), formerMemberId, formerSession, formerLineage };
}

/** Reads contiguous, correctly attributed journal checks immediately after a structured vote. */
async function ballotChecks(ctx: ReadContext, poolId: string, ballot: ReturnType<typeof vote>) {
  const anchor = ballot.voteEventId, count = ballot.checksReported;
  if (!anchor || count === null || count < 1 || count > 10) return ballot;
  const checks: ReturnType<typeof finding>[] = [];
  let after = anchor;
  for (let index = 0; index < 5 && checks.length < count; index++) {
    const envelope = await ctx.read('pool.get', { pool_id: poolId, section: 'history', direction: 'forward', after });
    if (envelope.outcome !== 'ok' && envelope.outcome !== 'partial') break;
    const page = poolWindow(envelope.data, poolId, 'forward', after, null);
    let mismatched = false;
    for (const entry of page.entries) {
      const author = object(entry.author);
      if (entry.vote_event_id !== anchor || author.kind !== 'member' || author.member_id !== ballot.memberId || !entry.check) {
        mismatched = true; break;
      }
      checks.push(finding(object(entry.check), ballot.proposalId, checks.length));
      if (checks.length === count) break;
    }
    if (mismatched || !page.more) break;
    after = page.cursor;
  }
  return { ...ballot, criteria: checks, checksComplete: checks.length === count };
}

/** Maps a bounded producer section and validates any continuation against its revision. */
export async function poolSection(ctx: ReadContext, query: Input<'poolSection'>, position: Position | null) {
  const features = await identity(ctx);
  if (query.section === 'criteria' && !features.has('structured_acceptance_v1')) throw new HubError('unsupported_capability');
  const section: PoolSection = query.section === 'proposals' ? 'proposal' : query.section;
  const at = position ? Number(position.at) : 0;
  const expected = position?.fence ?? null;
  const before = section === 'decisions' && !position ? await metadata(ctx, query.id) : null;
  const requestedRevision = expected ?? before?.pool.revision ?? null;
  const envelope = await ctx.read('pool.get', { pool_id: query.id, section, after: section === 'criteria' ? String(at) : at,
    ...(query.proposal && (section === 'proposal' || section === 'votes') ? { proposal_id: query.proposal } : {}),
    ...(requestedRevision !== null ? { expected_revision: Number(requestedRevision) } : {}),
    ...(section === 'members' && !features.has('observer_socket_v1') ? { include_bindings: true } : {}),
  });
  const data = checkSection(requireData(envelope), query.id, section, at, requestedRevision === null ? null : Number(requestedRevision));
  const view = optionalObject(data.view), raw = optionalObject(view.pool), selected = optionalObject(raw.proposal);
  const revision = raw.revision == null ? requestedRevision : decimalValue(raw.revision);
  if (expected !== null && revision !== expected) throw new HubError('stale_boundary');
  if (query.proposal && ['proposal', 'votes'].includes(section) && selected.proposal_id !== query.proposal) throw new HubError('not_found');
  const proposalId = text(selected.proposal_id) ?? query.proposal;
  const skip = position?.skip ?? 0;
  let items: unknown[];
  switch (section) {
    case 'members': {
      items = [];
      items = records(view.members);
      break;
    }
    case 'proposal': items = selected.proposal_id == null ? [] : [proposal(selected)]; break;
    case 'decisions': case 'criteria': items = records((section === 'decisions' ? data.decisions : raw.acceptance) ?? []).map((item, index) => finding(item, proposalId, at + index)); break;
    case 'votes': items = Object.entries(optionalObject(selected.votes)).map(([id, raw]) => vote(object(raw), id, proposalId!)); break;
    case 'deliveries': items = records(view.deliveries); break;
  }
  const end = skip + query.limit;
  if (skip > items.length) throw new HubError('stale_boundary');
  const remainder = end < items.length;
  const pageItems = items.slice(skip, end);
  if (section === 'members') {
    for (let index = 0; index < pageItems.length; index++) {
      pageItems[index] = await linkedMember(ctx, object(pageItems[index]), query.id, integer(raw.revision), data.bindings, features.has('run_proof_v1'));
    }
  }
  if (section === 'decisions' && query.proposal) {
    for (let i = pageItems.length - 1; i >= 0; i--) if (object(pageItems[i]).proposalId !== query.proposal) pageItems.splice(i, 1);
  }
  if (section === 'deliveries') {
    for (let i = 0; i < pageItems.length; i++) pageItems[i] = await delivery(ctx, object(pageItems[i]), query.id, integer(raw.revision), features, i < 4);
  }
  if (section === 'votes' && features.has('history_window_v1')) {
    for (let i = 0; i < Math.min(10, pageItems.length); i++) pageItems[i] = await ballotChecks(ctx, query.id, pageItems[i] as ReturnType<typeof vote>);
  }
  const more = remainder || data.has_more;
  const scope = coverage('current', !more, revision ? 'revision_fenced' : 'offset_unfenced');
  return { data: { section: query.section, revision, items: pageItems }, page: { ...noPage,
    next: more ? ctx.cursors.encode(query, { at: remainder ? at : decimalValue(data.cursor), skip: remainder ? end : undefined,
      fence: revision, direction: 'newer' }) : null },
    observations: [observed(envelope, null, scope)], capabilities: { ...features.capabilities, runBindings: data.bindings != null ? 'supported' : features.capabilities.runBindings } };
}

/** Reads forward or backward with separate historical and live cursor boundaries. */
export async function poolHistory(ctx: ReadContext, query: Input<'poolHistory'>, position: Position | null) {
  const features = await identity(ctx);
  const windowed = features.has('history_window_v1');
  const older = (position?.direction ?? query.direction) === 'older' || !position && (query.edge ?? 'tail') === 'tail' && query.direction !== 'newer';
  if (!windowed && (position?.direction === 'older' || query.direction === 'older')) throw new HubError('unsupported_capability');
  if (position && position.fence !== (windowed ? 'window' : 'legacy_forward')) throw new HubError('stale_boundary');
  const at = position ? String(position.at) : null;
  const params = { pool_id: query.id, section: 'history' };
  const envelope = await ctx.read('pool.get', windowed ? {
    ...params, direction: older ? 'backward' : 'forward',
    ...(at === null ? {} : older ? { before: at } : { after: at }),
    ...(position?.through ? { through: position.through } : {}),
  } : { ...params, after: Number(at ?? 0) });
  let events, next, watermark = null, more;
  if (windowed) {
    const page = poolWindow(requireData(envelope), query.id, older ? 'backward' : 'forward', at, position?.through ?? null);
    events = page.entries; next = page.cursor; watermark = page.watermark; more = page.more;
  } else {
    const page = checkSection(requireData(envelope), query.id, 'history', Number(at ?? 0), null);
    events = records(object(page.view).events); next = decimalValue(page.cursor); more = page.has_more;
  }
  const format = windowed ? 'window' : 'legacy_forward';
  const all = groupPoolEvents(events);
  const clipped = all.length > query.limit;
  const groups = older && windowed ? all.slice(-query.limit) : all.slice(0, query.limit);
  const firstEvent = groups[0]?.head, lastEvent = groups.at(-1)?.parts.at(-1);
  const firstPosition = firstEvent ? decimalValue(firstEvent.event_id_exact ?? firstEvent.event_id) : next;
  const lastPosition = lastEvent ? decimalValue(lastEvent.event_id_exact ?? lastEvent.event_id) : next;
  if (clipped) more = true;
  const items = groups.map(group => {
    const head = group.head, author = object(head.author);
    const position = decimalValue(head.event_id_exact ?? head.event_id);
    return { id: 'event-' + (group.valid && head.message_event_id ? decimalValue(head.message_event_id) : position), position,
      revision: head.revision == null ? null : decimalValue(head.revision), kind: text(head.kind),
      authorKind: text(author.kind), authorId: text(author.member_id ?? author.id), recipientId: text(head.recipient), atMs: ms(head.at ?? head.created_at),
      parts: group.parts.map(part => text(part.body)), complete: group.complete, valid: group.valid, proposalId: text(head.proposal_id),
      partRange: head.part_count != null ? { first: head.part_index, last: group.parts.at(-1)?.part_index, expected: head.part_count } : undefined };
  });
  const scope = coverage('retained', !more && groups.every(group => group.complete), windowed ? 'snapshot' : 'offset_unfenced');
  const resume = lastEvent ? lastPosition : older && !position ? watermark ?? '0' : next;
  const token = (at: string, direction: Position['direction'], through?: string) => ctx.cursors.encode(query, { at, direction, fence: format, through });
  return { data: { poolId: query.id, format, upperBound: watermark === null ? null : token('0', 'newer', watermark), items, coverage: scope },
    page: { next: (!older || !windowed) && more ? token(lastPosition, 'newer', watermark ?? undefined) : null,
      previous: windowed && (older ? more : at !== null && at !== '0') ? token(firstPosition, 'older', watermark ?? undefined) : null,
      resume: token(resume, 'newer') },
    observations: [observed(envelope, null, scope)], capabilities: features.capabilities };
}

/** Reassembles only contiguous bytes from the same Pool and revision. */
export async function poolContent(ctx: ReadContext, query: Input<'poolContent'>, position: Position | null) {
  if (!(await identity(ctx)).has('content_pages_v1')) throw new HubError('unsupported_capability');
  let revision: number | null = position ? Number(position.fence) : null, offset = 0, value = '', total: number | null = null;
  if (query.proposal) {
    // The content response omits its proposal. Check the requested proposal at the same pool revision.
    const envelope = await ctx.read('pool.get', { pool_id: query.id, section: 'proposal', proposal_id: query.proposal,
      ...(revision === null ? {} : { expected_revision: revision }),
    });
    const view = object(checkSection(requireData(envelope), query.id, 'proposal', 0, revision).view);
    const pool = object(view.pool);
    if (field(pool.proposal, 'proposal_id') !== query.proposal) throw new HubError('not_found');
    revision = integer(pool.revision);
  }
  for (let index = 0; index < 32; index++) {
    const envelope = await ctx.read('pool.get', { pool_id: query.id, section: 'content', field: query.field, after: String(offset),
      ...(query.proposal ? { proposal_id: query.proposal } : {}), ...(revision === null ? {} : { expected_revision: revision }),
    });
    const raw = requireData(envelope);
    const page = poolContentPage(raw, query.id, query.field, offset, revision);
    if (total !== null && total !== page.total) throw new HubError('stale_boundary');
    revision = page.revision; value += page.text; offset = page.next; total = page.total;
    if (!page.more) {
      const slice = ctx.textPage(query, value, String(revision), position);
      return { data: { poolId: query.id, field: query.field, proposalId: query.proposal, revision: String(revision), content: slice.content },
        page: slice.page, observations: [observed(envelope)] };
    }
  }
  throw new HubError('invalid_projection');
}

/** Decodes the producer's frozen status proofs without returning hold, store or pin identifiers. */
function completionFacts(items: Record<string, unknown>[]): NonNullable<PoolMember['lineage']>[] {
  const hold = items.find(item => item.entry === 'hold');
  const targets = items.filter(item => item.entry === 'target');
  if (!targets.length) return [];
  const observedAt = Number(hold?.status_observed_at), storeId = hold?.run_store_id;
  return targets.map(item => {
    const status = object(object(item.status).status), selector = object(status.selector);
    const request = runStatusRequest({
      run_id: selector.agent_id, run_sequence: selector.sequence, run_execution_ref: selector.execution_ref,
      run_pin_id: selector.pin_id, run_store_id: storeId,
    });
    const evidence = parseRunStatus({ version: 1, store_id: storeId, observed_at: observedAt, items: [status] }, request);
    if (!evidence.storeFenced || evidence.canonicalAgentId !== item.canonical_root) throw new HubError('invalid_projection');
    return lineage(evidence, { sessionId: request.targets[0].agent_id, execution: text(selector.execution_ref), match: evidence.match }, null);
  });
}

/** Reads a recorded chat agreement or assembles all digest-bound completion sections. */
export async function poolRecord(ctx: ReadContext, query: Input<'poolRecord'>, position: Position | null) {
  if (!(await identity(ctx)).has('completion_record_v1')) throw new HubError('unsupported_capability');
  const params = { pool_id: query.id, completion_id: query.record };
  const first = await ctx.read('pool.completion_get', { ...params, section: 'header', limit: 10 });
  const raw = requireData(first);
  const agreement = agreementRecord(raw, params);
  if (agreement) {
    const slice = ctx.textPage(query, agreement.result, digest(agreement), position);
    return { data: { kind: 'agreement', id: query.record, poolId: query.id, revision: String(agreement.revision), eventId: agreement.eventId,
      proposalId: agreement.proposalId, rosterKey: agreement.rosterKey, result: slice.content, recordedAtMs: null,
      ballots: agreement.ballots.map(ballot => ({ seatId: ballot.seatId, session: { sessionId: ballot.agentId, execution: null, match: 'unverified' }, voteEventId: ballot.voteEventId })),
    }, page: slice.page, observations: [observed(first)] };
  }
  const head = completionPage(raw, { ...params, section: 'header' }, null);
  if (head.algorithm !== 'sha256' || !/^[a-f0-9]{64}$/.test(head.recordDigest) || head.next !== null) throw new HubError('invalid_projection');
  if (position && position.fence !== head.recordDigest) throw new HubError('stale_boundary');
  const header = object(head.header), sections = new Map<string, Record<string, unknown>[]>();
  let byteBudget = 2 * 1024 * 1024;
  for (const section of COMPLETION_SECTIONS.slice(1)) {
    const items: Record<string, unknown>[] = [];
    let after: Record<string, unknown> | null = null;
    const seen = new Set<string>();
    for (let index = 0; index < 16; index++) {
      const envelope = await ctx.read('pool.completion_get', { ...params, section, limit: 10, ...(after ? { after } : {}) });
      const value = requireData(envelope);
      const page = completionPage(value, { ...params, section }, { digest: head.recordDigest, version: head.recordVersion });
      if (page.algorithm !== head.algorithm) throw new HubError('invalid_projection');
      byteBudget -= Buffer.byteLength(JSON.stringify(page.items));
      if (byteBudget < 0) throw new HubError('invalid_projection');
      items.push(...page.items);
      after = page.next;
      if (after === null) break;
      const cursor = digest(after);
      if (seen.has(cursor)) throw new HubError('invalid_projection');
      seen.add(cursor);
    }
    if (after !== null) throw new HubError('invalid_projection');
    sections.set(section, items);
  }
  const content = completionContent(sections.get('content') ?? []);
  const manifest = records(header.content);
  if (content.some(field => !field.verified || !manifest.some(item => item.field === field.field && item.present === true && item.length === Buffer.byteLength(field.text)
      && item.sha256 === (sections.get('content') ?? []).find(item => item.field === field.field)?.sha256))
    || manifest.some(item => item.present === true && !content.some(field => field.field === item.field))) throw new HubError('invalid_projection');
  const contentFields = (sections.get('content') ?? []).map(field => ({ field: field.field, content: {
    text: field.text, offsetBytes: field.offset, totalBytes: field.total_bytes }, sha256: field.sha256 }));
  const roster = sections.get('roster') ?? [], ballots = sections.get('ballots') ?? [];
  if (roster.length !== header.roster_entries || ballots.length !== header.ballots) throw new HubError('invalid_projection');
  type RecordPage = { content: typeof contentFields; roster: PoolMember[]; ballots: ReturnType<typeof vote>[]; runFacts: NonNullable<PoolMember['lineage']>[] };
  const chunks: RecordPage[] = [
    ...contentFields.map(item => ({ content: [item], roster: [], ballots: [], runFacts: [] })),
    ...roster.map(item => ({ content: [], roster: [member(item)], ballots: [], runFacts: [] })),
    ...ballots.map(item => ({ content: [], roster: [], ballots: [vote(item, String(item.member_id), String(header.proposal_id))], runFacts: [] })),
    ...completionFacts(sections.get('run_facts') ?? []).map(item => ({ content: [], roster: [], ballots: [], runFacts: [item] })),
  ];
  if (chunks.length === 0) chunks.push({ content: [], roster: [], ballots: [], runFacts: [] });
  const page = ctx.cursors.slice(query, position, chunks, head.recordDigest, 12);
  return { data: { kind: 'completion', id: query.record, poolId: query.id, revision: decimalValue(header.source_revision),
    recordDigest: head.recordDigest, header: { version: head.recordVersion, algorithm: head.algorithm,
      commitPosition: header.commit_sequence == null ? null : decimalValue(header.commit_sequence), proposalId: text(header.proposal_id),
      leader: text(header.leader_id), rosterCount: header.roster_entries ?? null, ballotCount: header.ballots ?? null,
      absentFields: manifest.filter(item => item.present === false).map(item => item.field) },
    content: page.items.flatMap(item => item.content), roster: page.items.flatMap(item => item.roster), ballots: page.items.flatMap(item => item.ballots),
    runFacts: page.items.flatMap(item => item.runFacts), notice: text(header.notice_observed_outcome), completedAtMs: ms(header.completed_at),
  }, page: page.page, observations: [observed(first)] };
}
