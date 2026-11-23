/** HTTP-only data source for the terminal's existing read and navigation model. */
import { createHubClient, HubHttpError } from '../../packages/client/src/index.ts';
import type { JsonRoute, ReadOptions } from '../../packages/client/src/index.ts';
import { createUnixHubClient } from '../../packages/client/src/unix.ts';
import type { Capabilities, Observation, PoolSection } from '../../packages/domain/src/index.ts';
import type { ObservationClient, ReadResponse, Resource } from './api.ts';
import { journalRow, memberRow, poolRow, productPage, seconds, sessionBlocks, sessionRow, treeDetail, treeRow } from './http-projection.ts';

/** Local terminal state for mapping legacy page positions to opaque continuations. */
function continuations() {
  const tokens = new Map<string, string>();
  return {
    get(scope: unknown[], position: unknown) { return tokens.get(JSON.stringify([...scope, position])); },
    set(scope: unknown[], position: unknown, token: string | null) {
      const key = JSON.stringify([...scope, position]);
      tokens.delete(key);
      if (token !== null) tokens.set(key, token);
      if (tokens.size > 4096) tokens.delete(tokens.keys().next().value!);
    },
  };
}

/** Builds one terminal envelope while preserving the observed source outcome and clock. */
function envelope(resource: Resource, info: readonly Observation[], data: unknown): ReadResponse {
  const source = resource === 'hub.repositories' ? 'worktree' : resource.split('.')[0];
  const observed = info.find(item => item.source === source && item.resource === resource)
    ?? (source === 'quota' && info.some(item => item.source === source && item.resource) ? undefined : info.find(item => item.source === source));
  const outcome = observed?.outcome ?? 'unavailable';
  return {
    schema_version: 1, resource, source: resource.split('.')[0], observed_at_ms: observed?.observedAtMs ?? Date.now(),
    outcome: observed?.staleSinceMs != null && outcome === 'ok' ? 'partial' : outcome,
    data: outcome === 'ok' || outcome === 'partial' ? data : null,
    error: observed?.issue ? { code: observed.issue.code, message: observed.issue.message ?? 'Source observation reported an issue.' } : null,
  };
}

/** Represents an unavailable Hub or a scoped HTTP error without falling back to source tools. */
function failure(resource: Resource, error: unknown): ReadResponse {
  const code = error instanceof HubHttpError ? error.code : error instanceof TypeError ? 'hub_disconnected' : 'hub_read_failed';
  const outcome = code === 'unsupported_capability' ? 'incompatible' : code === 'not_found' ? 'missing' : 'unavailable';
  return { schema_version: 1, resource, source: resource.split('.')[0], observed_at_ms: Date.now(), outcome, data: null, error: { code, message: 'Hub read unavailable.' } };
}

/** Maps only explicitly supported capabilities into the legacy rendering seam. */
function poolCapabilities(capabilities: Capabilities | undefined) {
  return [
    'history_window_v1',
    (capabilities?.completionRecord === 'supported' || capabilities?.agreementRecord === 'supported') && 'completion_record_v1',
    capabilities?.runBindings === 'supported' && 'run_bindings_v1',
    'structured_acceptance_v1', 'content_pages_v1',
  ].filter(value => typeof value === 'string');
}

/** Create cancellable reads over either an explicit origin or the default local socket. */
export function createHttpClient(server?: URL, injected?: ReturnType<typeof createHubClient>): ObservationClient {
  const transport = injected ?? (server ? createHubClient({ baseUrl: server }) : createUnixHubClient());
  const close = new AbortController(), cursors = continuations();
  const pending = new Set<Promise<unknown>>();
  /** Tracks requests until they settle so close can quiesce both reads and subscriptions. */
  function owned<T>(request: Promise<T>): Promise<T> {
    pending.add(request);
    void request.then(() => pending.delete(request), () => pending.delete(request));
    return request;
  }
  const http: ReturnType<typeof createHubClient> = {
    get<K extends JsonRoute>(route: K, options: ReadOptions = {}) {
      const signal = AbortSignal.any([close.signal, AbortSignal.timeout(20_000), ...(options.signal ? [options.signal] : [])]);
      return owned(transport.get(route, { ...options, signal }));
    },
    events(topics, interval, signal) {
      return transport.events(topics, interval, AbortSignal.any([close.signal, signal]));
    },
    watch(topics, interval, handlers, signal) {
      return owned(transport.watch(topics, interval, handlers, AbortSignal.any([close.signal, signal])));
    },
  };
  const projects = new Map<string, string>();

  /** Dispatch a finite compatibility read via the frozen public route map. */
  async function read(resource: Resource, params: Record<string, unknown> = {}, caller?: AbortSignal): Promise<ReadResponse> {
    const signal = AbortSignal.any([close.signal, ...(caller ? [caller] : [])]);
    const id = String(params.agent_id ?? params.pool_id ?? '');
    const execution = typeof params.execution === 'string' ? params.execution : null;
    const path = { id };
    const wrap = (response: { observations: Observation[] }, data: unknown) => envelope(resource, response.observations, data);
    try {
      if (resource === 'run.agents') {
        const offset = Number(params.offset ?? 0), limit = Number(params.limit ?? 200);
        const query = {
          status: params.active ? 'active' : typeof params.status === 'string' ? params.status : 'all', limit,
          project: typeof params.project === 'string' ? params.project : null,
          q: typeof params.q === 'string' ? params.q : null,
          from: typeof params.from === 'number' ? params.from : null,
          to: typeof params.to === 'number' ? params.to : null,
        };
        const scope = ['sessions', query];
        const response = await http.get('sessions', { query: { ...query, cursor: continuation(cursors, scope, offset) }, signal });
        const end = offset + response.data.items.length;
        cursors.set(scope, end, response.page.next);
        return wrap(response, {
          items: response.data.items.map(sessionRow), offset, limit, next_offset: response.page.next === null ? null : end,
          total: end, complete: response.page.next === null && response.observations.every(item => item.coverage?.state === 'complete'),
          revision: response.observations[0]?.coverage?.boundary ?? 'http-inventory', observed_at: seconds(response.observations[0]?.observedAtMs),
        });
      }
      if (resource === 'run.transcript') {
        if (params.view === 'raw') throw new HubHttpError('unsupported_capability', 422);
        const prefix = params.limit !== undefined && params.tail_blocks === undefined && params.resume !== true;
        const older = typeof params.before_cursor === 'string', limit = Number(params.tail_blocks ?? params.limit ?? 40);
        let edge = prefix || params.edge === 'start' ? 'start' : 'tail';
        const direction = older ? 'older' : 'newer';
        const cursor = typeof (params.before_cursor ?? params.cursor) === 'string' ? String(params.before_cursor ?? params.cursor) : null;
        const load = (token: string | null) => http.get('sessionHistory', {
          params: path, query: { execution, edge, direction: token ? direction : null, limit, cursor: token }, signal,
        });
        const response = await load(cursor).catch(error => {
          if (edge !== 'tail' || cursor !== null || !(error instanceof HubHttpError) || error.code !== 'unsupported_capability') throw error;
          edge = 'start';
          return load(null);
        });
        if (response.data.sessionId !== id || (execution !== null && response.data.execution !== execution)) throw new Error('history_execution_changed');
        const messages = sessionBlocks(response.data.entries);
        return wrap(response, {
          agent_id: id, view: 'blocks', cursor: params.cursor ?? null, direction: 'forward',
          messages, complete: response.page.next === null, next_cursor: response.page.next,
          previous_cursor: response.page.previous, resume_cursor: prefix ? null : response.page.resume,
          projection_edge: edge, projection_format: response.data.format, attribution: response.data.attribution,
        });
      }
      if (resource === 'pool.list' || resource === 'pool.identity') {
        const after = typeof params.after === 'string' ? params.after : null, q = typeof params.query === 'string' && params.query.length <= 200 ? params.query : null;
        // Both sidebar groups share one cursor and source fence.
        const state = 'all';
        const scope = ['pools', state, q];
        const response = await http.get('pools', { query: { state, q, limit: 50, cursor: after === null ? null : continuation(cursors, scope, after) }, signal });
        if (resource === 'pool.identity') return wrap(response, productPage('identity', { capabilities: poolCapabilities(response.capabilities) }));
        const items = response.data.items.map(row => ({ pool: poolRow(row), leader_id: row.leader ?? 'Unknown' }));
        const last = items.at(-1)?.pool.pool_id ?? after;
        if (last !== null) cursors.set(scope, last, response.page.next);
        return wrap(response, productPage('pool_page', { pools: items, returned: items.length, cursor: last, has_more: response.page.next !== null, source_timestamp: null, totals: response.data.totals }));
      }
      if (resource === 'pool.get') {
        const section = String(params.section);
        if (section === 'history') return await poolHistory(id, params, signal);
        const metadata = await http.get('pool', { params: path, signal });
        const pool = poolRow(metadata.data.pool);
        if (metadata.data.pool.id !== id) throw new Error('pool_identity_changed');
        const after = Number(params.after ?? 0), proposalId = typeof params.proposal_id === 'string' ? params.proposal_id : null;
        const scope = ['section', id, section, proposalId];
        const routeSection = (section === 'proposal' ? 'proposals' : section) as PoolSection;
        const response = await http.get('poolSection', {
          params: { id, section: routeSection }, query: { proposal: proposalId, cursor: continuation(cursors, scope, after) }, signal,
        });
        const data = response.data;
        if (data.section !== routeSection || data.revision !== metadata.data.pool.revision) throw new Error('pool_section_changed');
        const next = after + data.items.length;
        cursors.set(scope, next, response.page.next);
        const has_more = response.page.next !== null;
        const members = data.section === 'members' ? data.items.map(memberRow) : [];
        const proposal = data.section === 'proposals' ? (data.items.find(item => item.id === (proposalId ?? metadata.data.proposalId)) ?? data.items[0]) : null;
        const votes = data.section === 'votes' ? Object.fromEntries(data.items.map(vote => [vote.memberId, {
          ...vote, checks_met: vote.checksMet, checks_count: vote.checksReported, vote_event_id: vote.voteEventId,
        }])) : {};
        const criteria = data.section === 'criteria' ? data.items.map(item => ({ ...item, criterion_id: item.id, description: item.text })) : [];
        const deliveries = data.section === 'deliveries' ? data.items.map(item => ({
          ...item, operation_id: item.id, operation: item.kind ?? 'deliver', member_id: item.memberId, hub_session: item.formerSession,
        })) : [];
        const projectedProposal = proposal ? {
          ...proposal, proposal_id: proposal.id, votes, result: proposal.resultPreview, criteria: proposal.criteriaText,
          snapshot_bytes: proposal.snapshotBytes, roster_key: proposal.rosterKey,
        } : data.section === 'votes' && (proposalId ?? metadata.data.proposalId) ? {
          proposal_id: proposalId ?? metadata.data.proposalId, state: 'open', voters: Object.keys(votes), votes,
        } : null;
        const decisions = data.section === 'decisions' ? data.items.map(item => ({
          ...item, proposal_id: item.proposalId, decision_id: item.id, body: item.text, outcome: item.state,
        })) : [];
        return wrap(response, productPage('pool_detail', {
          section, coverage: metadata.data.coverage, leader_id: metadata.data.pool.leader, has_more, cursor: String(next), returned: section === 'proposal' ? Number(!!proposal) : data.items.length, source_timestamp: null,
          decisions, view: section === 'decisions' ? null : {
            section, pool: { ...pool, proposal: projectedProposal, acceptance: criteria }, members, deliveries, events: [],
            active: members.filter(member => member.state === 'active').length, pending: members.filter(member => member.state === 'pending').length,
            has_more, next_after: next,
          },
        }));
      }
      if (resource === 'quota.status' || resource === 'quota.snapshot') {
        const response = await http.get('quota', { signal });
        const data = resource === 'quota.status' ? response.data.status : response.data.snapshot;
        const receipt = wrap(response, data);
        if (data === null && (receipt.outcome === 'ok' || receipt.outcome === 'partial')) {
          return { ...receipt, outcome: 'unavailable' };
        }
        return receipt;
      }
      if (resource === 'worktree.list' || resource === 'hub.repositories') {
        const project = projects.get(String(params.repo)) ?? null;
        if (params.repo && project === null) throw new HubHttpError('not_found', 404);
        const response = await http.get('worktrees', { query: { project, limit: Number(params.limit ?? 20), cursor: typeof params.cursor === 'string' ? params.cursor : null }, signal });
        for (const project of response.data.projects) {
          projects.set(project.id, project.id);
          if (project.path) projects.set(project.path, project.id);
        }
        if (resource === 'hub.repositories') return wrap(response, { repositories: response.data.projects.map(row => row.path ?? row.id) });
        const coverage = response.data.projects.find(row => row.id === project)?.coverage ?? response.observations[0]?.coverage;
        return wrap(response, productPage('worktree_page', {
          rows: response.data.items.map(treeRow), cursor: response.page.next, has_more: response.page.next !== null, coverage,
        }));
      }
      if (resource === 'worktree.inspect') {
        const id = typeof params.id === 'string' ? params.id : null;
        if (!id) throw new HubHttpError('not_found', 404);
        const response = await http.get('worktree', { params: { id }, signal });
        if (response.data.worktree.id !== id) throw new Error('worktree_identity_changed');
        return wrap(response, productPage('worktree_detail', treeDetail(response.data)));
      }
      if (resource === 'bridge.incidents') {
        const offset = Number(params.after_seq ?? 0), from = typeof params.from === 'number' ? params.from : null, to = typeof params.to === 'number' ? params.to : null;
        const scope = ['incidents', from, to];
        const response = await http.get('incidents', { query: { includeClosed: true, from, to, limit: 100, cursor: continuation(cursors, scope, offset) }, signal });
        const items = response.data.items.map((row, index) => ({
          ...row, incident_seq: offset + index + 1, incident_id: row.id, publisher: row.publisher ?? 'Unknown',
          event_id: row.eventId ?? 'Unknown', created_ms: row.createdAtMs, updated_ms: row.updatedAtMs,
        }));
        const end = offset + items.length;
        cursors.set(scope, end, response.page.next);
        return wrap(response, productPage('incident_page', {
          incidents: items, through_seq: params.through_seq ?? (response.page.next === null ? end : Number.MAX_SAFE_INTEGER),
          next_after_seq: response.page.next === null ? null : end, coverage: 'retained_history',
        }));
      }
      throw new HubHttpError('unsupported_capability', 422);
    } catch (error) { return failure(resource, error); }
  }

  /** Keep the older cursor separate from live resume for each Pool history. */
  async function poolHistory(id: string, params: Record<string, unknown>, signal: AbortSignal): Promise<ReadResponse> {
    const older = params.direction !== 'forward', boundary = older ? params.before : params.after;
    const direction = older ? 'older' : 'newer', scope = ['pool-history', id, direction];
    const token = boundary == null ? null : cursors.get(scope, boundary) ?? continuation(cursors, scope, boundary);
    const response = await http.get('poolHistory', {
      params: { id }, query: { direction: token ? direction : null, cursor: token }, signal,
    });
    if (response.data.poolId !== id) throw new Error('pool_history_changed');
    const rows = response.data.items.map(journalRow);
    const position = rows[older ? 0 : rows.length - 1]?.event_id_exact ?? String(older ? '0' : boundary ?? '0');
    const last = rows.at(-1)?.event_id_exact;
    if (older) cursors.set(scope, position, response.page.previous);
    if (!older || token === null) cursors.set(['pool-history', id, 'newer'], last ?? position, response.page.resume);
    const watermark = String(params.through ?? last ?? position);
    const more = (older ? response.page.previous : response.page.next) !== null;
    return envelope('pool.get', response.observations, productPage('pool_detail', {
      section: 'history', returned: rows.length, source_timestamp: null, cursor: position, history_watermark: watermark, has_more: more,
      http: true, upper_bound: response.data.upperBound, resume_position: last ?? position, format: response.data.format,
      view: { pool: { pool_id: id }, section: 'history', events: rows, has_more: more },
    }));
  }

  return {
    http, read,
    async close() {
      close.abort();
      await Promise.allSettled(pending);
    },
  };
}

/** A missing continuation never turns a later page into an unrelated first page. */
function continuation(cursors: ReturnType<typeof continuations>, scope: unknown[], position: unknown): string | null {
  if (position === 0 || position === '0') return null;
  const cursor = cursors.get(scope, position);
  if (cursor === undefined) throw new HubHttpError('stale_boundary', 409, true);
  return cursor;
}
