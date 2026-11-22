/** Explicit fixture fetch transport. Serves the public v1 API without native observations. */
import {
  API_RESPONSES, API_VERSION, type ApiRequest, type Capabilities, type HubEvent,
  type Observation, type Page, type RouteName, type Topic, parseApiRequest, textChunk,
} from '../../domain/src/index.ts';
import metadata from '../../../package.json' with { type: 'json' };
import { type FixtureCatalog, type FixtureScenario, loadCatalog } from './catalog.ts';
import { fixtureCursor } from './paging.ts';
import { FixtureError, errorResponse } from './response.ts';
export { SCENARIOS, type FixtureScenario } from './catalog.ts';

/** Shared non-cacheable headers for fixture observations. */
const headers = { 'Cache-Control': 'no-store' };

/** Supported source of each detail or list route. */
const ROUTE_SOURCE = {
  sessions: 'run', session: 'run', sessionHistory: 'run', initialTask: 'run', sessionResult: 'run', sessionExport: 'run',
  pools: 'pool', pool: 'pool', poolSection: 'pool', poolHistory: 'pool', poolContent: 'pool', poolRecord: 'pool',
  quota: 'quota', worktrees: 'worktree', worktree: 'worktree', incidents: 'bridge',
} as const;

/** Extracts the typed normalized query for a specific route. */
type Query<K extends RouteName> = Extract<NonNullable<ApiRequest>, { route: K }>;

/** Maps supported event scopes to independent source observations. */
function sourcesFor(topic: Topic): Observation['source'][] {
  if (topic === 'overview') return ['run', 'bridge', 'quota'];
  if (topic === 'incidents') return ['bridge'];
  if (topic === 'quota') return ['quota'];
  if (topic.startsWith('session')) return ['run'];
  if (topic.startsWith('pool')) return ['pool'];
  return ['worktree', 'run'];
}

/** Opens a bounded synthetic stream and heartbeats until the consumer cancels. */
function events(data: FixtureCatalog, query: Query<'events'>, signal: AbortSignal): Response {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  let abort: () => void;
  const cleanup = () => {
    clearInterval(timer);
    signal.removeEventListener('abort', abort);
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (event: HubEvent) => controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
      emit({ type: 'ready', topics: query.topics, observedAtMs: data.clockMs });
      for (const topic of query.topics) {
        for (const source of sourcesFor(topic)) emit({ type: 'source-state', topic, observation: data.observations[source] });
        emit({ type: 'changed', topic, boundary: null });
      }
      abort = () => {
        cleanup();
        controller.close();
      };
      signal.addEventListener('abort', abort, { once: true });
      timer = setInterval(() => {
        if ((controller.desiredSize ?? 0) <= 0) {
          abort();
        } else {
          controller.enqueue(encoder.encode(': heartbeat\n\n'));
        }
      }, 15_000);
    },
    cancel: cleanup,
  });
  return new Response(stream, { headers: { ...headers, 'Content-Type': 'text/event-stream; charset=utf-8' } });
}

/** Uses an inclusive start and exclusive end. Null producer clocks cannot match a bounded period. */
function inPeriod(at: number | null, query: { from: number | null; to: number | null }): boolean {
  if (at === null) return query.from === null && query.to === null;
  return (query.from === null || at >= query.from) && (query.to === null || at < query.to);
}

/** Test-clock Run activity classes mirrored by the Sessions filter. */
const ACTIVE = new Set(['created', 'starting', 'running', 'cancelling']);

/** Raises a scoped error for a resource that may be present only in another scenario. */
function required<T>(value: T | undefined | null): T {
  if (value == null) throw new FixtureError('not_found');
  return value;
}

/** Creates an injectable fetch transport for the selected JSON scenario. */
export function createFixtureFetch(scenario: FixtureScenario): typeof fetch {
  const catalog = loadCatalog(scenario);
  return async (input, init) => {
    const request = new Request(input, init);
    request.signal.throwIfAborted();
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) return errorResponse('invalid_request');
    if (request.method !== 'GET') return errorResponse('method_not_allowed');
    let query: ApiRequest;
    try {
      query = parseApiRequest(url);
    } catch {
      return errorResponse('invalid_request');
    }
    if (!query) return errorResponse('not_found');
    try {
      return handleFixture(catalog, scenario, query, request.signal);
    } catch (error) {
      if (error instanceof FixtureError) return errorResponse(error.code);
      throw error;
    }
  };
}

/** Projects fixed fixture snapshots through the same routes that B will implement. */
function handleFixture(catalog: FixtureCatalog, scenario: FixtureScenario, query: NonNullable<ApiRequest>, signal: AbortSignal): Response {
  const { route } = query;
  if (route === 'health') return Response.json(API_RESPONSES.health({
    ready: true, apiVersion: API_VERSION, release: metadata.version, mode: 'fixture',
  }), { headers });
  if (route === 'events') return events(catalog, query, signal);

  const source = route === 'overview' ? null : ROUTE_SOURCE[route];
  const observed = source ? catalog.observations[source] : null;
  if (observed?.outcome === 'incompatible') throw new FixtureError('unsupported_capability');
  if (observed?.outcome === 'unavailable') throw new FixtureError('source_unavailable');
  const observations = observed ? [observed] : [catalog.observations.run, catalog.observations.bridge, catalog.observations.quota];
  if (observations.every(item => item.outcome === 'incompatible')) throw new FixtureError('unsupported_capability');
  if (observations.every(item => item.outcome === 'unavailable')) throw new FixtureError('source_unavailable');

  const capabilities: Capabilities | undefined = source ? catalog.capabilities[source] : undefined;
  const json = (data: unknown, page?: Page, info = observations) => Response.json(
    API_RESPONSES[route]({ data, observations: info, capabilities, page }), { headers },
  );
  const selectedSession = (request: { id: string; execution: string | null }) => {
    const item = required(catalog.sessions.find(({ detail }) => detail.session.id === request.id));
    if (request.execution !== null && request.execution !== item.detail.session.execution) throw new FixtureError('stale_boundary');
    return item;
  };
  const selectedPool = (id: string) => required(catalog.pools.find(({ detail }) => detail.pool.id === id));
  const paginator = <T,>(request: Parameters<typeof fixtureCursor>[0], rows: T[], boundary: string, forwardOnly = false) => {
    const { offset, stop, page } = fixtureCursor(request, scenario, boundary, rows.length, forwardOnly);
    return { items: rows.slice(offset, stop), page };
  };
  const unchunked = (data: unknown, request: { cursor: string | null }) => {
    if (request.cursor !== null) throw new FixtureError('invalid_request');
    return json(data, { next: null, previous: null, resume: null });
  };
  const chunks = (content: ReturnType<typeof textChunk>, request: { route: RouteName; cursor: string | null }, boundary: string, assemble: (chunk: typeof content) => unknown) => {
    const { items, page } = paginator({ ...request, limit: 1 }, fixtureTextChunks(content), boundary, true);
    return json(assemble(required(items[0])), page);
  };
  switch (route) {
    case 'overview': {
      const { run, bridge, quota } = catalog.overview;
      const periodSessions = catalog.sessions.map(({ detail }) => detail.session);
      const count = (rows: unknown[], kind: 'exact' | 'lower_bound' | 'unknown') =>
        ({ value: kind === 'unknown' ? null : rows.length, kind });
      return json({
        from: query.from, to: query.to,
        run: run && {
          ...run,
          started: count(periodSessions.filter(row => inPeriod(row.createdAtMs, query)), run.started.kind),
          finished: count(periodSessions.filter(row => !ACTIVE.has(row.status) && inPeriod(row.finishedAtMs, query)), run.finished.kind),
          failed: count(periodSessions.filter(row => row.status === 'failed' && inPeriod(row.finishedAtMs, query)), run.failed.kind),
          succeeded: count(periodSessions.filter(row => row.status === 'succeeded' && inPeriod(row.finishedAtMs, query)), run.succeeded.kind),
        },
        bridge: bridge && {
          ...bridge,
          accepted: count(catalog.bridgeAcceptedAtMs.filter(at => inPeriod(at, query)), bridge.accepted.kind),
          incidents: count(catalog.incidents.filter(incident => inPeriod(incident.createdAtMs, query)), bridge.incidents.kind),
        },
        quota,
      });
    }
    case 'sessions': {
      const rows = catalog.sessions.map(({ detail }) => detail.session).filter(row =>
        (query.status === 'all' || query.status === row.status ||
          (query.status === 'active' && ACTIVE.has(row.status)) || (query.status === 'finished' && !ACTIVE.has(row.status))) &&
        (query.project === null || row.projectId === query.project) &&
        inPeriod(row.finishedAtMs ?? row.createdAtMs, query) &&
        [row.id, row.name, row.summary, row.workdir, row.model].some(value => value?.toLowerCase().includes(query.q.toLowerCase())),
      );
      const { items, page } = paginator(query, rows, 'run-inventory');
      return json({ items }, page);
    }
    case 'session': return json(selectedSession(query).detail);
    case 'sessionHistory': {
      const history = selectedSession(query).history;
      const { items, page } = paginator({ ...query, edge: query.edge ?? 'start' }, history.entries, history.coverage.boundary ?? 'history', history.format === 'legacy_raw');
      return json({ ...history, entries: items }, page);
    }
    case 'initialTask': {
      const data = selectedSession(query).initialTask;
      return data.state === 'verified'
        ? chunks(data.content, query, data.proof.root.sha256, content => ({ ...data, content }))
        : unchunked(data, query);
    }
    case 'sessionResult': {
      if (capabilities?.verifiedResult === 'unsupported') throw new FixtureError('unsupported_capability');
      const data = required(selectedSession(query).result);
      return chunks(data.content, query, data.proof.sha256, content => ({ ...data, content }));
    }
    case 'sessionExport': {
      if (query.mode === 'exact' && capabilities?.exactExport === 'unsupported') throw new FixtureError('unsupported_capability');
      const data = required(selectedSession(query).exports[query.mode]);
      return chunks(data.content, query, data.boundary, content => ({ ...data, content }));
    }
    case 'pools': {
      const rows = catalog.pools.map(({ detail }) => detail.pool).filter(row =>
        (query.state === 'all' || row.state === query.state) &&
        [row.id, row.name, row.purposePreview].some(value => value?.toLowerCase().includes(query.q.toLowerCase())),
      );
      const { items, page } = paginator(query, rows, catalog.poolTotals?.revision ?? 'pool-inventory');
      return json({ items, totals: catalog.poolTotals }, page);
    }
    case 'pool': return json(selectedPool(query.id).detail);
    case 'poolSection': {
      const selected = selectedPool(query.id);
      const section = required(selected.sections.find(item => item.section === query.section));
      const rows = section.items.filter(row => query.proposal === null ||
        ('proposalId' in row ? row.proposalId === query.proposal : 'voters' in row && row.id === query.proposal));
      const { items, page } = paginator(query, rows, selected.detail.pool.revision ?? 'pool-section');
      return json({ ...section, revision: selected.detail.pool.revision, items }, page);
    }
    case 'poolHistory': {
      const history = selectedPool(query.id).history;
      const legacy = history.format === 'legacy_forward';
      const { items, page } = paginator({ ...query, edge: query.edge ?? (legacy ? 'start' : 'tail') }, history.items, history.upperBound ?? 'pool-history', legacy);
      return json({ ...history, items }, page);
    }
    case 'poolContent': {
      const { content } = selectedPool(query.id);
      const data = required(content.find(item => item.field === query.field && (query.proposal === null || item.proposalId === query.proposal)));
      return chunks(data.content, query, data.revision, content => ({ ...data, content }));
    }
    case 'poolRecord': {
      const { records } = selectedPool(query.id);
      if (capabilities?.completionRecord === 'unsupported' && capabilities?.agreementRecord === 'unsupported') {
        throw new FixtureError('unsupported_capability');
      }
      const data = required(records.find(record => record.id === query.record));
      return data.kind === 'agreement'
        ? chunks(data.result, query, data.revision, result => ({ ...data, result }))
        : unchunked(data, query);
    }
    case 'quota': return json(catalog.quota);
    case 'worktrees': {
      const rows = catalog.worktrees.map(({ worktree }) => worktree).filter(row => query.project === null || row.projectId === query.project);
      const projects = catalog.projects.filter(project => query.project === null || project.id === query.project);
      const { items, page } = paginator(query, rows, 'worktree-inventory');
      return json({ items, projects }, page, [...observations, catalog.observations.run]);
    }
    case 'worktree': return json(required(catalog.worktrees.find(({ worktree }) => worktree.id === query.id)), undefined, [...observations, catalog.observations.run]);
    case 'incidents': {
      const rows = catalog.incidents.filter(incident =>
        (query.includeClosed || incident.closed === false) && inPeriod(incident.createdAtMs, query),
      );
      const { items, page } = paginator(query, rows, 'bridge-incidents');
      return json({ items }, page);
    }
  }
}

/** Splits complete fixture text into UTF-8 pages without bisecting a Unicode code point. */
function fixtureTextChunks(content: ReturnType<typeof textChunk>): ReturnType<typeof textChunk>[] {
  const encoder = new TextEncoder();
  const chunks: ReturnType<typeof textChunk>[] = [];
  let text = '', offsetBytes = 0, size = 0;
  for (const character of content.text) {
    const bytes = encoder.encode(character).byteLength;
    if (size + bytes > 80) {
      chunks.push({ ...content, text, offsetBytes });
      offsetBytes += size;
      text = '';
      size = 0;
    }
    text += character;
    size += bytes;
  }
  chunks.push({ ...content, text, offsetBytes });
  return chunks;
}
