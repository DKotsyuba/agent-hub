/** Run inventory, transcript windows and proof-checked content. */
import { session, type Capabilities, type Session, type SessionHistory } from '@agent-hub/domain';
import { activeStatus, answerText, collectPages, integer, object, runAgent, runPage, sha256, supportsChunks, text, transcriptPage, type RunAgent, type TranscriptBlock } from '../../src/live/protocol.ts';
import { groupTranscript } from '../../terminal/src/transcript.ts';
import { agentWorkdir, projectRoot } from '../../terminal/src/sessions.ts';
import { initialTaskCapability, readInitialTask } from '../../terminal/src/initial-task.ts';
import { exportExactHistory } from '../../terminal/src/export-exact.ts';
import { parseRunStatus, runStatusRequest, validRunAgentId, type RunStatusRequest } from '../../terminal/src/run-status.ts';
import { HubError } from './errors.ts';
import type { NativeResponse } from './observer.ts';
import { digest, type Position } from './cursor.ts';
import { coverage, decimalValue, field, inPeriod, ms, noPage, observed, optionalObject, projectId, requireData, type Input, type ReadContext } from './projection.ts';

/** Identifies a producer StorageError on an inventory read. */
class RunInventoryStorageError extends HubError {
  /** Keeps the public failure classification while allowing per-ID recovery. */
  constructor() { super('source_unavailable'); }
}

/** Decodes a Run page while retaining the one inventory-specific recovery signal. */
function inventoryPage(envelope: NativeResponse) {
  if (envelope.outcome === 'unavailable' && envelope.error?.code === 'run_inventory_storage') {
    throw new RunInventoryStorageError();
  }
  return runPage(requireData(envelope));
}

/** A bounded inventory with its native receipt and fencing revision. */
export async function runInventory(ctx: ReadContext, active = false) {
  const params = { limit: 200, ...(active ? { active: true } : {}) };
  const envelope = await ctx.read('run.agents', { ...params, offset: 0 });
  const first = inventoryPage(envelope);
  let complete = envelope.outcome === 'ok';
  const inventory = await collectPages(first, 5, async offset => {
    const receipt = await ctx.read('run.agents', { ...params, offset });
    const next = inventoryPage(receipt);
    complete &&= receipt.outcome === 'ok';
    if (next.revision !== first.revision) throw new HubError('stale_boundary');
    return next;
  }, row => row.id, () => !ctx.signal.aborted);
  const items = [...inventory.items].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { inventory, items, rows: items.map(sessionRow), observation: observed(envelope, ms(inventory.observed), coverage(active ? 'current' : 'retained', complete && inventory.complete, 'revision_fenced')) };
}

/** Projects only Run fields understood by the API. */
export function sessionRow(agent: RunAgent): Session {
  const work = agentWorkdir(agent);
  return session({
    id: agent.id, sequence: agent.sequence, execution: text(agent.raw.execution_ref),
    name: agent.name, summary: agent.summary, workdir: work?.path ?? null, projectId: work ? projectId(projectRoot(work.path)) : null, projectInferred: work?.inferred ?? false,
    status: agent.status, runtime: text(agent.raw.runtime), model: agent.model, effort: agent.effort,
    createdAtMs: ms(agent.raw.created_at), finishedAtMs: ms(agent.finished), observedAtMs: ms(agent.observed),
    progressAtMs: ms(agent.progress), elapsedMs: ms(agent.elapsed), silenceMs: ms(agent.silence), lastAction: text(agent.raw.last_action),
    failureKind: text(agent.raw.failure_kind), failureText: text(agent.raw.failure_text), answerAvailable: agent.answerAvailable,
  });
}

/** Filters normalized rows and fences continuation to the scanned Run revision. */
export async function sessions(ctx: ReadContext, query: Input<'sessions'>, position: Position | null) {
  const result = await runInventory(ctx, query.status === 'active');
  const items = result.rows.filter(row => {
    const active = activeStatus(row.status);
    return (query.status === 'all' || query.status === 'active' && active || query.status === 'finished' && !active || query.status === row.status)
      && (!query.project || row.projectId === query.project)
      && inPeriod(query, active ? row.createdAtMs : row.finishedAtMs)
      && (!query.q || [row.id, row.name, row.summary, row.model, row.workdir].some(value => value?.toLowerCase().includes(query.q.toLowerCase())));
  });
  const page = ctx.cursors.slice(query, position, items, digest([result.inventory.revision, items.map(row => row.id)]), query.limit);
  return { data: { items: page.items }, page: page.page, observations: [result.observation] };
}

/** Finds the latest agent row, recovering by ID when Run cannot project a whole inventory page. */
async function currentSession(ctx: ReadContext, query: { id: string; execution: string | null }) {
  try {
    const inventory = await runInventory(ctx);
    const agent = inventory.items.find(row => row.id === query.id);
    if (!agent) throw new HubError(query.execution ? 'stale_boundary' : 'not_found');
    return { agent, observation: inventory.observation };
  } catch (error) {
    if (!(error instanceof RunInventoryStorageError) || !validRunAgentId(query.id)) throw error;
    const envelope = await ctx.read('run.agent_integration', { agent_id: query.id });
    if (envelope.outcome === 'incompatible') throw error;
    if (envelope.outcome === 'missing' && query.execution) throw new HubError('stale_boundary');
    const data = object(requireData(envelope));
    if (data.schema_version !== 1) throw new HubError('invalid_projection');
    const agent = runAgent(data.agent);
    if (agent.id !== query.id) throw new HubError('invalid_projection');
    return { agent, observation: observed(envelope, ms(agent.observed)) };
  }
}

/** Resolves a current Run row or a server-issued Pool binding. */
async function selected(ctx: ReadContext, query: { id: string; execution: string | null }) {
  const binding = query.execution ? ctx.bindings.get(query.execution) : undefined;
  if (query.execution?.startsWith('bound-') && (!binding || binding.targets[0].agent_id !== query.id)) throw new HubError('stale_boundary');
  if (binding) {
    const envelope = await ctx.read('run.status', { ...binding });
    const evidence = parseRunStatus(requireData(envelope), binding);
    if (evidence.match !== 'verified' || evidence.canonicalAgentId !== query.id || !evidence.view) throw new HubError('stale_boundary');
    return { agent: evidence.view.agent, observation: observed(envelope, ms(evidence.observedAt)), binding, evidence, execution: query.execution! };
  }
  const result = await currentSession(ctx, query);
  const { agent } = result;
  if (query.execution && !/^ex1_[a-f0-9]{64}$/.test(query.execution) && query.execution !== agent.raw.execution_ref) throw new HubError('stale_boundary');
  let execution = text(agent.raw.execution_ref);
  let evidence = null;
  let observation = result.observation;
  let current = agent;
  if (validRunAgentId(query.id) && (!execution || /^ex1_[a-f0-9]{64}$/.test(query.execution ?? execution))) {
    const selector = runStatusRequest({ run_id: query.id, run_sequence: agent.sequence, run_execution_ref: query.execution ?? execution });
    const envelope = await ctx.read('run.status', { ...selector });
    if (envelope.outcome === 'ok' || envelope.outcome === 'partial') {
      evidence = parseRunStatus(envelope.data, selector);
      if (!evidence.view || !evidence.selected || evidence.canonicalAgentId !== query.id) throw new HubError('stale_boundary');
      if (evidence.retainedLatest && evidence.retainedLatest.sequence !== evidence.selected.sequence) throw new HubError('stale_boundary');
      execution = evidence.selected.executionRef;
      observation = observed(envelope, ms(evidence.observedAt));
      current = evidence.view.agent;
    }
  }
  if (query.execution !== null && query.execution !== execution) throw new HubError('stale_boundary');
  return { agent: current, observation, binding: null, evidence, execution };
}

/** Registers an opaque selector without exposing store or pin identifiers. */
export function registerBinding(ctx: ReadContext, binding: RunStatusRequest): string {
  const { bindings } = ctx;
  const token = 'bound-' + digest(binding);
  if (!bindings.has(token) && bindings.size >= 1024) bindings.delete(bindings.keys().next().value!);
  bindings.set(token, binding);
  return token;
}

/** Requires the store, incarnation and active pin evidence for strict historical reads. */
function pinned(result: Awaited<ReturnType<typeof selected>>): boolean {
  return !!result.binding?.expected_store_id && !!result.binding.targets[0].pin_id && !!result.binding.targets[0].execution_ref
    && result.evidence?.storeFenced === true && result.evidence.pinState === 'active' && result.evidence.coverage === 'complete';
}

/** Maps proof capabilities without inferring support from source failures. */
async function discover(ctx: ReadContext) {
  const identity = await ctx.read('run.identity');
  const data = optionalObject(identity.data);
  const capabilities = optionalObject(data.capabilities), methods = capabilities.read_methods;
  const exact = capabilities.schema_version === 1 && capabilities.product === 'agent-run' && Array.isArray(methods)
    && methods.some(method => optionalObject(method).name === 'transcript_exact');
  const tools = Array.isArray(data.tools) ? data.tools : optionalObject(data.tools).tools;
  const usable = identity.outcome === 'ok' || identity.outcome === 'partial';
  const chunks: NonNullable<Capabilities['verifiedResult']> = usable && supportsChunks(data) ? 'supported'
    : identity.outcome === 'ok' && Array.isArray(tools) && tools.every(tool =>
      typeof tool === 'string' || typeof optionalObject(tool).name === 'string') ? 'unsupported' : 'unknown';
  return { identity, task: initialTaskCapability(data), exact, chunks };
}

/** Emits only top-level, nonnegative counts from a producer metric map. */
function metrics(data: unknown) {
  return Object.entries(optionalObject(data)).flatMap(([metric, count]) =>
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(metric) && typeof count === 'number' && Number.isSafeInteger(count) && count >= 0
      ? [{ metric, count: decimalValue(count) }] : []);
}

/** Reports execution details and independently gated data operations. */
export async function sessionDetail(ctx: ReadContext, query: Input<'session'>) {
  const [result, discovery] = await Promise.all([selected(ctx, query), discover(ctx)]);
  const row = sessionRow(result.agent), e = result.evidence;
  const capabilities: Capabilities = {
    initialTaskStrict: discovery.task?.modes.includes('strict') && pinned(result) && row.sequence === 1 ? 'supported' : 'unsupported',
    initialTaskCurrent: discovery.task?.modes.includes('current') ? 'supported' : 'unsupported',
    exactExport: discovery.exact && pinned(result) ? 'supported' : 'unsupported',
    verifiedResult: discovery.chunks === 'supported' && (!result.execution || !row.answerAvailable || !result.agent.answerSha)
      ? 'unsupported' : discovery.chunks,
  };
  const lineage = e ? {
    storeFenced: e.storeFenced, match: { sessionId: row.id, execution: result.execution, match: e.match },
    pinState: e.pinState, selected: e.selected, retainedLatest: e.retainedLatest,
    coverage: { scope: 'lineage', state: e.coverage }, restartResume: e.restartResume,
    lineageTerminal: e.lineageTerminal, terminalOutcome: e.terminalOutcome, successCommit: e.successCommit,
    cleanup: e.cleanup, poolObservedAtMs: null, statusObservedAtMs: ms(e.observedAt), sampledAtMs: ms(e.view?.sampledAt),
  } : null;
  return { data: { session: { ...row, execution: result.execution }, lineage,
    historyAttribution: 'retained_lineage', answerAttribution: capabilities.verifiedResult === 'supported' ? 'unverified' : 'unavailable',
    executionUsage: metrics(result.agent.raw.usage), cumulativeUsage: metrics(result.agent.raw.usage_cumulative), toolCounts: metrics(result.agent.raw.tool_counts),
    delivery: field(result.agent.raw.delivery, 'state'), cleanup: e?.cleanup ?? field(result.agent.raw.cleanup, 'state'),
  }, observations: [result.observation, observed(discovery.identity)], capabilities };
}

/** Maps one fragment with a unique key and explicit source completeness. */
function fragment(block: TranscriptBlock) {
  const roles = ['user', 'assistant', 'system', 'tool', 'tool_call', 'tool_result', 'other'];
  return {
    id: 'msg-' + digest(block.key), position: String(block.seq), role: roles.includes(block.role) ? block.role : 'other',
    name: text(block.raw.name), sourceRef: text(block.raw.raw_ref), text: block.content, atMs: ms(block.at),
    error: typeof block.raw.error === 'boolean' ? block.raw.error : null, complete: block.raw.content_complete === true,
    omittedBytes: block.raw.omitted_bytes == null ? undefined : integer(block.raw.omitted_bytes),
    firstPosition: block.raw.first_seq == null ? undefined : String(integer(block.raw.first_seq)),
    endAtMs: ms(block.raw.end_at), sourceRole: block.role,
  };
}

/** Preserves separate backward and live resume positions within the retained transcript. */
export async function sessionHistory(ctx: ReadContext, query: Input<'sessionHistory'>, position: Position | null) {
  const result = await selected(ctx, query);
  const fence = digest([result.evidence?.storeId, result.execution, result.agent.sequence, result.agent.raw.created_at]);
  if (position && position.fence !== fence) throw new HubError('stale_boundary');
  const older = (position?.direction ?? query.direction) === 'older' || !position && query.edge === 'tail' && query.direction !== 'newer';
  const at = position ? Number(position.at) : 0;
  const limit = Math.min(query.limit, 100);
  const base = { agent_id: query.id };
  let envelope = await ctx.read('run.transcript', { ...base, view: 'blocks',
    ...(older ? { tail_blocks: limit, ...(position ? { before_cursor: at } : {}) } : { cursor: at, limit }) });
  const legacy = envelope.error?.code === 'run_blocks_unsupported';
  if (legacy) {
    if (position?.direction === 'older' || query.direction === 'older') throw new HubError('unsupported_capability');
    envelope = await ctx.read('run.transcript', { ...base, cursor: at, limit });
  }
  const source = transcriptPage(requireData(envelope), query.id);
  if (!legacy && source.raw.view !== 'blocks' || (!older || legacy) && source.raw.cursor !== at) throw new HubError('invalid_projection');
  const backward = older && !legacy;
  const expectedDirection = backward ? 'backward' : 'forward';
  if ((source.raw.direction != null && source.raw.direction !== expectedDirection) ||
      (backward && source.raw.before_cursor != null && source.raw.before_cursor !== (position ? at : null))) throw new HubError('invalid_projection');
  let last = backward ? 0 : at;
  for (const block of source.blocks) {
    const first = integer(block.raw.first_seq ?? block.seq);
    if (first <= last || first > block.seq || integer(block.raw.last_seq ?? block.seq) !== block.seq ||
        backward && position && block.seq >= at) throw new HubError('invalid_projection');
    last = block.seq;
  }
  const first = source.blocks[0];
  const next = source.raw.next_cursor ?? null;
  const resume = source.raw.resume_cursor;
  const expectedResume = first ? last : backward ? 0 : at;
  if (backward) {
    if (next !== null || (source.complete ? source.previous !== null : !first || source.previous !== (first.raw.first_seq ?? first.seq))) {
      throw new HubError('invalid_projection');
    }
  } else if (source.previous !== null || (source.complete ? next !== null : !first || next !== last)) {
    throw new HubError('invalid_projection');
  }
  if ((resume != null && resume !== expectedResume) || (!legacy && first && resume == null)) throw new HubError('invalid_projection');
  const after = await selected(ctx, query);
  if (digest([after.evidence?.storeId, after.execution, after.agent.sequence, after.agent.raw.created_at]) !== fence) throw new HubError('stale_boundary');
  const grouped = groupTranscript(source.blocks);
  const entries = grouped.entries.map(entry => ({
    head: fragment(entry.head), calls: entry.calls.map(fragment), results: entry.results.map(fragment),
    partialBefore: [entry.head, ...entry.calls, ...entry.results].some(block => grouped.partialBefore.has(block.key)),
    partialAfter: [entry.head, ...entry.calls, ...entry.results].some(block => grouped.partialAfter.has(block.key)),
  }));
  const token = (offset: unknown, direction: Position['direction']) => offset == null ? null
    : ctx.cursors.encode(query, { at: integer(offset), fence, direction });
  const previous = backward ? source.previous : legacy || at === 0 || !first ? null : integer(first.raw.first_seq ?? first.seq);
  const scope = coverage('retained', source.complete && envelope.outcome === 'ok');
  return { data: { sessionId: query.id, execution: result.execution, format: legacy ? 'legacy_raw' : 'grouped',
      attribution: 'retained_lineage', entries, coverage: scope } as SessionHistory,
    page: { previous: token(previous, 'older'), next: token(next, 'newer'), resume: token(first || !backward || !position ? expectedResume : null, 'newer') },
    observations: [observed(envelope, null, scope)],
    capabilities: { groupedHistory: legacy ? 'unsupported' : 'supported', bidirectionalHistory: legacy ? 'unsupported' : 'supported' },
  };
}

/** Reassembles the bounded task and withholds text on any failed proof. */
export async function initialTask(ctx: ReadContext, query: Input<'initialTask'>, position: Position | null) {
  const [result, discovery] = await Promise.all([selected(ctx, query), discover(ctx)]);
  const observations = [result.observation, observed(discovery.identity)];
  const strict = pinned(result) && result.agent.sequence === 1 && discovery.task?.modes.includes('strict');
  const selector = result.binding?.targets[0];
  const task = discovery.task && (!result.binding || strict) ? await readInitialTask(
    params => ctx.read('run.initial_task', params),
    { mode: strict ? 'strict' : 'current', agentId: query.id, storeId: result.binding?.expected_store_id, executionRef: selector?.execution_ref ?? result.execution ?? undefined, pinId: strict ? selector?.pin_id : undefined },
    discovery.task, () => !ctx.signal.aborted,
  ) : { state: 'unverified' as const };
  if (task.state !== 'verified') {
    if (position) throw new HubError('stale_boundary');
    return { data: { state: 'unverified', reason: 'task_proof_unavailable' }, observations, page: noPage };
  }
  const root = { execution: task.executionRef, sequence: 1, sha256: task.sha256 };
  const proof = strict ? { kind: 'strict', root, storeFenced: true, activePin: true } : { kind: 'current', root };
  const slice = ctx.textPage(query, task.text, digest(proof), position);
  return { data: { state: 'verified', content: slice.content, proof }, page: slice.page, observations,
    capabilities: strict ? { initialTaskStrict: 'supported' } : { initialTaskCurrent: 'supported' } };
}

/** Verifies answer digest and rejects a changed execution or digest after assembly. */
export async function sessionResult(ctx: ReadContext, query: Input<'sessionResult'>, position: Position | null) {
  const [result, discovery] = await Promise.all([selected(ctx, query), discover(ctx)]);
  const { agent, execution } = result;
  if (!execution || !agent.answerSha || agent.answerAvailable !== true) throw new HubError('not_found');
  if (discovery.chunks === 'unknown') throw new HubError('source_unavailable');
  if (discovery.chunks === 'unsupported') throw new HubError('unsupported_capability');
  const envelope = await ctx.read('run.answer', { agent_id: query.id });
  const content = await answerText(requireData(envelope), query.id, agent.sequence, agent.answerSha,
    true, async params => requireData(await ctx.read('run.answer_chunk', params)), () => !ctx.signal.aborted, true);
  if (content === null) throw new HubError('not_found');
  const after = await selected(ctx, query);
  if (after.execution !== execution || after.evidence?.storeId !== result.evidence?.storeId || after.agent.sequence !== agent.sequence || after.agent.answerSha !== agent.answerSha) throw new HubError('stale_boundary');
  const proof = { execution, sequence: agent.sequence, sha256: agent.answerSha };
  const slice = ctx.textPage(query, content, digest(proof), position);
  return { data: { content: slice.content, proof }, page: slice.page, observations: [observed(envelope)], capabilities: { verifiedResult: 'supported' } };
}

/** Exports retained content through a fixed upper sequence or verifies a pinned exact export. */
export async function sessionExport(ctx: ReadContext, query: Input<'sessionExport'>, position: Position | null) {
  const result = await selected(ctx, query);
  if (query.mode === 'exact') {
    if (!result.binding || !pinned(result) || !(await discover(ctx)).exact) throw new HubError('unsupported_capability');
    let upper = position?.through;
    const exported = await exportExactHistory({
      close: async () => {},
      read: async (resource, params, signal) => {
        const envelope = await ctx.read(resource, { ...params, ...(upper === undefined ? {} : { upper_seq: upper }) }, signal);
        if (envelope.outcome === 'ok') {
          const observedUpper = decimalValue(object(envelope.data).upper_seq);
          if (upper !== undefined && upper !== observedUpper) throw new HubError('stale_boundary');
          upper = observedUpper;
        }
        return envelope;
      },
    }, result.binding, ctx.signal);
    // The terminal formatter includes its private selector and store in its first two lines.
    const headerEnd = exported.indexOf('\n', exported.indexOf('\n') + 1);
    const value = 'Exact execution transcript for ' + query.id + exported.slice(headerEnd);
    const proof = { content: { execution: result.execution, sequence: result.agent.sequence, sha256: await sha256(value) }, storeFenced: true, activePin: true };
    const boundary = digest([proof, upper]), slice = ctx.textPage(query, value, boundary, position ?? { at: 0, fence: boundary, direction: 'newer', through: upper });
    return { data: { mode: query.mode, content: slice.content, boundary, coverage: coverage('execution', true, 'snapshot'), proof }, page: slice.page, observations: [result.observation], capabilities: { exactExport: 'supported' } };
  }
  const params = { agent_id: query.id };
  let upper = position?.through;
  if (upper === undefined) {
    const tail = await ctx.read('run.transcript', { ...params, view: 'blocks', tail_blocks: 1 });
    if (tail.error?.code !== 'run_blocks_unsupported') {
      const page = transcriptPage(requireData(tail), query.id);
      if (page.raw.view !== 'blocks' || page.blocks.at(-1)?.seq !== (page.resume ?? undefined)) throw new HubError('invalid_projection');
      upper = String(integer(page.resume ?? 0));
    }
  }
  const watermark = upper === undefined ? Infinity : Number(upper);
  let cursor = 0, bytes = 0;
  const lines: string[] = [];
  for (let index = 0; cursor < watermark && index < 20; index++) {
    const read = transcriptPage(requireData(await ctx.read('run.transcript', { ...params, cursor, limit: 200 })), query.id);
    const before = cursor;
    for (const block of read.blocks) {
      if (block.seq > watermark) break;
      if (block.seq <= cursor) throw new HubError('invalid_projection');
      cursor = block.seq;
      const line = JSON.stringify(fragment(block)) + '\n';
      bytes += Buffer.byteLength(line);
      if (bytes > 8 * 1024 * 1024) throw new HubError('invalid_projection');
      lines.push(line);
    }
    if (before === cursor || read.complete) break;
  }
  const after = await selected(ctx, query);
  if (after.execution !== result.execution || after.agent.sequence !== result.agent.sequence) throw new HubError('stale_boundary');
  upper ??= String(cursor);
  const value = 'Retained session history through #' + upper + '. Earlier records may be unavailable.\n\n' + lines.join('');
  const boundary = digest([result.evidence?.storeId, result.execution, result.agent.sequence, upper, await sha256(value)]);
  const slice = ctx.textPage(query, value, boundary, position ?? { at: 0, fence: boundary, direction: 'newer', through: upper });
  return { data: { mode: query.mode, content: slice.content, boundary, coverage: coverage('lineage', false, 'offset_unfenced') }, page: slice.page, observations: [result.observation] };
}
