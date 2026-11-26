/** Versioned read route map with typed parameters and success decoders. */
import { API_PREFIX, API_VERSION, PAGE_LIMITS, opaque, pagedResponse, resourceId, response } from './common.ts';
import { INTERVALS, detailScope, topic } from './events.ts';
import { modelSeries, modelStats, speedBucket, speedGrouping, speedWindow, statsLabel } from './model-speed.ts';
import { bridgeIncident, heldMessages, overview, quota, worktreeDetail, worktrees } from './observations.ts';
import { POOL_SECTIONS, poolContent, poolDetail, poolHistory, poolRecord, poolSection, pools } from './pools.ts';
import { initialTask, runStatus, session, sessionDetail, sessionExport, sessionHistory, sessionResult } from './sessions.ts';
import { type Decoded, array, invalid, nullable, object, oneOf, text } from './schema.ts';

/** Process readiness and fixture/live mode are independent of source availability. */
export const health = object({ ready: oneOf(true, false), apiVersion: oneOf(API_VERSION), release: text, mode: oneOf('live', 'fixture') });

/** Process and release metadata. */
export type Health = Decoded<typeof health>;

/** Exact path templates from the v1 design. */
export const API_ROUTES = {
  health: '/health', overview: '/overview', sessions: '/sessions', session: '/sessions/:id',
  sessionHistory: '/sessions/:id/history', initialTask: '/sessions/:id/initial-task',
  sessionResult: '/sessions/:id/result', sessionExport: '/sessions/:id/export',
  pools: '/pools', pool: '/pools/:id', poolSection: '/pools/:id/sections/:section',
  poolHistory: '/pools/:id/history', poolContent: '/pools/:id/content/:field',
  poolRecord: '/pools/:id/records/:record', modelSpeed: '/model-speed', modelSpeedSeries: '/model-speed/series',
  quota: '/quota', worktrees: '/worktrees',
  worktree: '/worktrees/:id', incidents: '/bridge/incidents', held: '/bridge/held', events: '/events',
} as const;

/** A supported v1 route name. */
export type RouteName = keyof typeof API_ROUTES;

/** Successful JSON response validators. Events have their own decoder in events.ts. */
export const API_RESPONSES = {
  health, overview: response(overview), sessions: pagedResponse(object({ items: array(session) })),
  session: response(sessionDetail), sessionHistory: pagedResponse(sessionHistory),
  initialTask: pagedResponse(initialTask), sessionResult: pagedResponse(sessionResult), sessionExport: pagedResponse(sessionExport),
  pools: pagedResponse(pools), pool: response(poolDetail), poolSection: pagedResponse(poolSection),
  poolHistory: pagedResponse(poolHistory), poolContent: pagedResponse(poolContent), poolRecord: pagedResponse(poolRecord),
  modelSpeed: response(nullable(modelStats)), modelSpeedSeries: response(nullable(modelSeries)),
  quota: response(quota), worktrees: pagedResponse(worktrees), worktree: response(worktreeDetail),
  incidents: pagedResponse(object({ items: array(bridgeIncident) })), held: response(heldMessages),
} as const;

/** A successful response DTO indexed by route. */
export type ApiResponse<K extends keyof typeof API_RESPONSES> = Decoded<typeof API_RESPONSES[K]>;

/** Final normalized request states for each route. */
export type ApiRequest = ReturnType<typeof parseApiRequest>;

/** A single filter value bounded to a safe, small search string. */
function search(value: string): string {
  const normalized = value.trim();
  if (normalized.length > 200 || /[\u0000-\u001f\u007f]/.test(normalized)) return invalid('q', 'search text up to 200 characters');
  return normalized;
}

/** Converts an epoch millisecond, limit or interval from its exact decimal form. */
function integer(value: string): number {
  if (!/^(0|[1-9][0-9]{0,15})$/.test(value) || !Number.isSafeInteger(Number(value))) return invalid('query', 'nonnegative safe integer');
  return Number(value);
}

/** Decodes a request by its explicit route, returning null for an unknown path. Throws for invalid parameters. */
export function parseApiRequest(url: URL) {
  if (!url.pathname.startsWith(`${API_PREFIX}/`)) return null;
  const path = url.pathname.slice(API_PREFIX.length).split('/');
  for (const [route, template] of Object.entries(API_ROUTES) as [RouteName, string][]) {
    const parts = template.split('/');
    if (parts.length !== path.length || !parts.every((part, index) => part.startsWith(':') || part === path[index])) continue;
    const params = new Map(parts.flatMap((part, index) => part.startsWith(':') ? [[part.slice(1), path[index]]] : []));
    return readRouteRequest(route, params, url.searchParams);
  }
  return null;
}

/** Produces typed, bounded, normalized fields and rejects aliases, duplicates or undeclared parameters. */
function readRouteRequest(route: RouteName, params: Map<string, string>, query: URLSearchParams) {
  const used = new Set<string>();
  const param = (key: string) => decodeURIComponent(params.get(key)!);
  const get = <T>(key: string, decode: (value: string) => T) => {
    used.add(key);
    const inputs = query.getAll(key);
    if (inputs.length > 1) return invalid(key, 'one query value');
    return inputs.length ? decode(inputs[0]) : null;
  };
  const done = <K extends RouteName, T extends object>(name: K, fields: T): { route: K } & T => {
    for (const key of query.keys()) if (!used.has(key)) invalid('query', 'declared query parameter');
    return { route: name, ...fields };
  };
  const id = () => resourceId(param('id'));
  const execution = () => get('execution', opaque);
  const cursor = () => ({ cursor: get('cursor', opaque) });
  const pagination = (max: number = PAGE_LIMITS.max) => {
    const limit = get('limit', integer) ?? PAGE_LIMITS.default;
    if (limit === 0) invalid('limit', 'positive page size');
    return { ...cursor(), limit: Math.min(limit, max) };
  };
  const period = () => {
    const from = get('from', integer), to = get('to', integer);
    if (from !== null && to !== null && from >= to) invalid('period', 'from earlier than to');
    return { from, to };
  };
  const history = () => ({
    edge: get('edge', oneOf('start', 'tail')),
    direction: get('direction', oneOf('older', 'newer')),
    ...pagination(),
  });
  const project = () => get('project', resourceId);
  const proposal = () => get('proposal', resourceId);
  switch (route) {
    case 'health': return done(route, {});
    case 'overview': return done(route, period());
    case 'sessions': return done(route, {
      status: get('status', value => ['active', 'finished', 'all'].includes(value)
        ? oneOf('active', 'finished', 'all')(value) : runStatus(value)) ?? 'all',
      project: project(), q: get('q', search) ?? '', ...period(), ...pagination(),
    });
    case 'session': return done(route, { id: id(), execution: execution() });
    case 'sessionHistory': return done(route, { id: id(), execution: execution(), ...history() });
    case 'initialTask': return done(route, { id: id(), execution: execution(), ...cursor() });
    case 'sessionResult': return done(route, { id: id(), execution: execution(), ...cursor() });
    case 'sessionExport': return done(route, {
      id: id(), execution: execution(), mode: get('mode', oneOf('retained', 'exact')) ?? 'retained', ...cursor(),
    });
    case 'pools': return done(route, {
      state: get('state', oneOf('live', 'finished', 'open', 'closed', 'all')) ?? 'all', q: get('q', search) ?? '', ...pagination(),
    });
    case 'pool': return done(route, { id: id() });
    case 'poolSection': {
      const section = oneOf(...POOL_SECTIONS)(param('section'));
      return done(route, {
        id: id(), section, proposal: section === 'members' || section === 'deliveries' ? null : proposal(), ...pagination(),
      });
    }
    case 'poolHistory': return done(route, { id: id(), ...history() });
    case 'poolContent': {
      const field = oneOf('purpose', 'snapshot')(param('field'));
      return done(route, { id: id(), field, proposal: field === 'snapshot' ? proposal() : null, ...cursor() });
    }
    case 'poolRecord': return done(route, { id: id(), record: resourceId(param('record')), ...cursor() });
    case 'modelSpeed': return done(route, {
      window: get('window', speedWindow) ?? '24h', group_by: get('group_by', speedGrouping) ?? 'provider+model',
    });
    case 'modelSpeedSeries': {
      const window = get('window', speedWindow) ?? '24h';
      const bucket = get('bucket', speedBucket) ?? (window === '24h' ? 'hour' : 'day');
      const model = get('model', statsLabel) ?? invalid('model', 'Agent Stats label');
      return done(route, { model, window, bucket });
    }
    case 'quota': return done(route, {});
    case 'worktrees': return done(route, { project: project(), ...pagination(PAGE_LIMITS.worktrees) });
    case 'worktree': return done(route, { id: id() });
    case 'incidents': return done(route, {
      ...period(), includeClosed: (get('includeClosed', oneOf('true', 'false')) ?? 'false') === 'true', ...pagination(),
    });
    case 'held': return done(route, {});
    case 'events': {
      used.add('topic');
      const topics = query.getAll('topic');
      if (!topics.length || topics.length > 16) invalid('topic', 'one to sixteen topics');
      const selected = [...new Set(topics.map(value => topic(value)))];
      const scopes = new Set(selected.map(detailScope).filter(Boolean));
      if (scopes.size > 1) invalid('topic', 'at most one selected resource');
      const interval = get('interval', value => oneOf(...INTERVALS)(integer(value))) ?? 3;
      return done(route, { topics: selected, interval });
    }
  }
}
