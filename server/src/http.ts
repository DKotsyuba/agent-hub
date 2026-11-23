/** Read-only v1 HTTP dispatch, request authority and release asset serving. */
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { extname, join, sep } from 'node:path';
import type { RunStatusRequest } from '../../terminal/src/run-status.ts';
import { API_RESPONSES, API_VERSION, parseApiRequest } from '@agent-hub/domain';
import { Cursors } from './cursor.ts';
import { HubError, errorResponse } from './errors.ts';
import { Events } from './events.ts';
import type { ObservationClient } from './observer.ts';
import { incidents, overview, quota, worktree, worktrees, type WorktreeCache } from './observations.ts';
import { pool, poolContent, poolHistory, poolRecord, pools, poolSection } from './pool.ts';
import { ReadContext } from './projection.ts';
import { initialTask, sessionDetail, sessionExport, sessionHistory, sessionResult, sessions } from './run.ts';
import { shareReads } from './reads.ts';

/** Bounds aggregate projection work and one serialized finite API body. */
const FINITE_LIMIT = 24;
const RESPONSE_LIMIT = 4 * 1024 * 1024;

const ID = '[A-Za-z0-9][A-Za-z0-9._-]{0,199}';
const SPA = new RegExp('^/(?:|incidents|quota|worktrees(?:/' + ID + ')?'
  + '|sessions(?:/' + ID + '(?:/(?:history|result|details))?)?'
  + '|pools(?:/' + ID + '(?:/(?:members|discussion|details|record|proposals|decisions|criteria|votes|deliveries))?)?)$');
const ASSET = /^\/(?:sw\.js|assets\/[A-Za-z0-9][A-Za-z0-9._-]*|[A-Za-z0-9][A-Za-z0-9._-]*\.(?:ico|svg|png|webmanifest|txt))$/;
const HASHED = /^\/assets\/.+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/;
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8', '.webp': 'image/webp',
};

/** Provides the small stable Bun runtime seam used to return file-backed bodies. */
interface FileRuntime {
  file(path: string): Blob;
}

/** Returns a known release asset with canonical containment and HTTP cache policy. */
async function staticAsset(url: URL, request: Request, webRoot: string): Promise<Response> {
  const pathname = url.pathname;
  const spa = SPA.test(pathname);
  if (!spa && !ASSET.test(pathname)) throw new HubError('not_found');
  const relative = spa ? 'index.html' : pathname.slice(1);
  let path, stat;
  try {
    const root = await realpath(webRoot);
    path = await realpath(join(root, relative));
    if (!path.startsWith(root + sep)) throw new HubError('not_found');
    stat = await lstat(path);
    if (!stat.isFile()) throw new HubError('not_found');
  } catch { throw new HubError('not_found'); }
  // The shell and worker can change without a new file size or release timestamp.
  const versioned = spa || pathname === '/sw.js' ? await readFile(path) : null;
  const etag = '"' + (versioned ? createHash('sha256').update(versioned).digest('hex') :
    stat.size.toString(16) + '-' + Math.round(stat.mtimeMs).toString(16)) + '"';
  const headers = {
    'Cache-Control': HASHED.test(pathname) ? 'public, max-age=31536000, immutable' : 'no-cache',
    'Content-Type': TYPES[extname(relative)] ?? 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff', ETag: etag,
    ...(pathname === '/sw.js' ? { 'Service-Worker-Allowed': '/' } : {}),
  };
  if (request.headers.get('If-None-Match') === etag) return new Response(null, { status: 304, headers });
  const runtime = (globalThis as unknown as { Bun: FileRuntime }).Bun;
  return new Response(versioned ?? runtime.file(path), { headers });
}

/** Server-owned host, release metadata and web asset path. */
export interface HttpOptions {
  localHost: string;
  publicOrigin?: string;
  release: string;
  webRoot: string;
}

/** Creates an isolated handler and shutdown owner, reusable in integration tests. */
export function createHttp(native: ObservationClient, options: HttpOptions) {
  const client = shareReads(native);
  const cursors = new Cursors();
  const events = new Events(client);
  const worktreeCache: WorktreeCache = new Map();
  const bindings = new Map<string, RunStatusRequest>();
  const shutdown = new AbortController();
  let finite = 0;
  const publicHost = options.publicOrigin ? new URL(options.publicOrigin).host : null;
  const loopbackOrigin = options.localHost.startsWith('127.0.0.1:') ? 'http://' + options.localHost : null;

  /** Checks authority and input before any use of the observer. */
  async function fetch(request: Request, admitStream?: () => void): Promise<Response> {
    let admitted = false;
    try {
      const host = request.headers.get('host');
      const origin = request.headers.get('origin');
      const allowedOrigin = origin === null || origin === options.publicOrigin
        || host === options.localHost && origin === loopbackOrigin;
      if (!host || host !== options.localHost && host !== publicHost || !allowedOrigin) {
        throw new HubError('invalid_request');
      }
      if (request.method !== 'GET') throw new HubError('method_not_allowed');
      if (request.url.length > 8192) throw new HubError('invalid_request');
      const url = new URL(request.url);
      if (!url.pathname.startsWith('/api/') && url.pathname !== '/api') return await staticAsset(url, request, options.webRoot);
      let query;
      try { query = parseApiRequest(url); } catch { throw new HubError('invalid_request'); }
      if (!query) throw new HubError('not_found');
      if (shutdown.signal.aborted) throw new HubError('source_unavailable');
      if (query.route === 'events') {
        const stream = events.open(query.topics, query.interval, request.signal);
        admitStream?.();
        return stream;
      }
      if (query.route !== 'health') {
        if (finite >= FINITE_LIMIT) throw new HubError('saturated');
        finite++;
        admitted = true;
      }
      const position = cursors.decode(query);
      const ctx = new ReadContext(client, cursors, AbortSignal.any([request.signal, shutdown.signal, AbortSignal.timeout(30_000)]), bindings);
      let result: unknown;
      switch (query.route) {
        case 'health': result = { ready: true, apiVersion: API_VERSION, release: options.release, mode: 'live' }; break;
        case 'overview': result = await overview(ctx, query); break;
        case 'sessions': result = await sessions(ctx, query, position); break;
        case 'session': result = await sessionDetail(ctx, query); break;
        case 'sessionHistory': result = await sessionHistory(ctx, query, position); break;
        case 'initialTask': result = await initialTask(ctx, query, position); break;
        case 'sessionResult': result = await sessionResult(ctx, query, position); break;
        case 'sessionExport': result = await sessionExport(ctx, query, position); break;
        case 'pools': result = await pools(ctx, query, position); break;
        case 'pool': result = await pool(ctx, query); break;
        case 'poolSection': result = await poolSection(ctx, query, position); break;
        case 'poolHistory': result = await poolHistory(ctx, query, position); break;
        case 'poolContent': result = await poolContent(ctx, query, position); break;
        case 'poolRecord': result = await poolRecord(ctx, query, position); break;
        case 'quota': result = await quota(ctx); break;
        case 'worktrees': result = await worktrees(ctx, query, position, worktreeCache); break;
        case 'worktree': result = await worktree(ctx, query, worktreeCache); break;
        case 'incidents': result = await incidents(ctx, query, position); break;
      }
      if (ctx.signal.aborted) throw new HubError('source_unavailable');
      const body = JSON.stringify(API_RESPONSES[query.route](result));
      if (Buffer.byteLength(body) > RESPONSE_LIMIT) throw new HubError('invalid_projection');
      return new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    } catch (error) { return errorResponse(error); }
    finally { if (admitted) finite--; }
  }

  /** Cancels streams and waits until the shared observer owner has reaped its children. */
  async function close(): Promise<void> {
    shutdown.abort();
    events.close();
    await client.close();
  }

  return { fetch, close };
}
