/** Browser-safe v1 HTTP and event transport. */
import { API_PREFIX, API_ROUTES, API_RESPONSES, apiError, event, parseApiRequest } from '../../domain/src/index.ts';
import type { ApiResponse, HubEvent, Topic } from '../../domain/src/index.ts';

export type { HubEvent, Topic, ApiResponse } from '../../domain/src/index.ts';

/** JSON routes with a registered success decoder. */
export type JsonRoute = keyof typeof API_RESPONSES;

/** Path selectors and normalized query fields for a finite GET. */
export interface ReadOptions {
  params?: Record<string, string>;
  query?: Record<string, string | number | boolean | readonly string[] | null | undefined>;
  signal?: AbortSignal;
}

/** Transport injection also supports same-origin browser and fixture fetch. */
export interface HubOptions { baseUrl?: string | URL; fetch?: typeof fetch }

/** A Hub HTTP failure, preserving the machine code and HTTP status. */
export class HubHttpError extends Error {
  constructor(readonlyCode: string, httpStatus: number, retry = false) {
    super(readonlyCode);
    this.code = readonlyCode;
    this.status = httpStatus;
    this.retryable = retry;
  }

  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
}

/** Creates finite reads and reconnecting event subscriptions over one transport. */
export function createHubClient(options: HubOptions = {}) {
  const base = options.baseUrl ?? globalThis.location?.origin;
  if (!base) throw new Error('A Hub base URL is required.');
  const send = options.fetch ?? globalThis.fetch.bind(globalThis);

  /** Generate and validate a v1 URL before dispatching a read. */
  async function request(route: JsonRoute | 'events', options: ReadOptions, accept: string): Promise<Response> {
    const path = API_ROUTES[route].replace(/:(\w+)/g, (_, key: string) => encodeURIComponent(options.params?.[key] ?? ''));
    const url = new URL(API_PREFIX + path, base);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value == null) continue;
      if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, item);
      else url.searchParams.set(key, String(value));
    }
    if (parseApiRequest(url)?.route !== route) throw new Error('Invalid Hub route.');
    const response = await send(url, { method: 'GET', signal: options.signal, headers: { Accept: accept }, redirect: 'error' });
    if (response.ok) return response;
    const status = response.status;
    const parsed = await response.json().then(value => apiError(value).error).catch(() => null);
    throw new HubHttpError(parsed?.code ?? 'http_error', status, parsed?.retryable);
  }

  /** Decodes a successful response before exposing data. */
  async function get<K extends JsonRoute>(route: K, options: ReadOptions = {}): Promise<ApiResponse<K>> {
    const response = await request(route, options, 'application/json');
    return API_RESPONSES[route](await response.json()) as ApiResponse<K>;
  }

  /** Reads one SSE connection. EOF and errors are visible to the caller. */
  async function* events(topics: readonly Topic[], interval: 1 | 3 | 5 | 10, signal: AbortSignal, onActivity?: () => void): AsyncGenerator<HubEvent> {
    const response = await request('events', { query: { topic: topics, interval }, signal }, 'text/event-stream');
    if (!response.body || !/^text\/event-stream(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
      await response.body?.cancel();
      throw new Error('Invalid Hub event stream.');
    }
    let ready = false;
    const selected = new Set(topics);
    for await (const frame of readSse(response.body, onActivity, signal)) {
      signal.throwIfAborted();
      if (frame.type === 'ready') {
        if (ready || new Set(frame.topics).size !== selected.size || frame.topics.some(topic => !selected.has(topic))) throw new Error('Unexpected Hub ready event.');
        ready = true;
      } else if (!ready || !selected.has(frame.topic)) throw new Error('Unexpected Hub event topic.');
      yield frame;
    }
  }

  /** Reopens after EOF or transport failure. Revalidate on each ready event using the last applied cursor. */
  async function watch(topics: readonly Topic[], interval: 1 | 3 | 5 | 10, handlers: {
    event: (event: HubEvent) => void;
    connection?: (state: 'connected' | 'disconnected') => void;
  }, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const stream = new AbortController();
      const activity = AbortSignal.any([signal, stream.signal]);
      // The published heartbeat interval is 15 seconds. A missing heartbeat also ends the connection.
      let timeout = setTimeout(() => stream.abort(), 35_000);
      try {
        for await (const frame of events(topics, interval, activity, () => {
          clearTimeout(timeout);
          timeout = setTimeout(() => stream.abort(), 35_000);
        })) {
          if (frame.type === 'ready') handlers.connection?.('connected');
          handlers.event(frame);
        }
      } catch {
        // The reconnection loop also covers protocol incompatibility.
      } finally {
        clearTimeout(timeout);
        stream.abort();
      }
      if (signal.aborted) break;
      handlers.connection?.('disconnected');
      await retryDelay(interval * 1000, signal);
    }
  }

  return { get, events, watch };
}

/** Waits until the retry interval expires or its subscription is disposed. */
async function retryDelay(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>(resolve => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
    if (signal.aborted) done();
  });
}

/** Decode bounded, UTF-8 SSE frames with multiline data and CR/LF line endings. */
export async function* readSse(body: ReadableStream<Uint8Array>, activity?: () => void, signal?: AbortSignal): AsyncGenerator<HubEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let line = '', data = '', name = '', skipLF = false;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    for (;;) {
      const read = await reader.read();
      signal?.throwIfAborted();
      if (read.done) break;
      const chunk = decoder.decode(read.value, { stream: true });
      for (const character of chunk) {
        if (skipLF) { skipLF = false; if (character === '\n') continue; }
        if (character !== '\r' && character !== '\n') {
          line += character;
          if (line.length + data.length > 256 * 1024) throw new Error('Hub event exceeds its frame budget.');
          continue;
        }
        skipLF = character === '\r';
        if (!line) {
          activity?.();
          if (data) {
            const decoded = event(JSON.parse(data));
            if (decoded.type !== name) throw new Error('Hub event name mismatch.');
            yield decoded;
          }
          data = '';
          name = '';
        } else if (line.startsWith(':')) {
          activity?.();
        } else {
          const colon = line.indexOf(':');
          const field = colon < 0 ? line : line.slice(0, colon);
          const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
          if (field === 'event') name = value;
          if (field === 'data') data += value + '\n';
        }
        line = '';
      }
    }
    decoder.decode();
  } finally {
    signal?.removeEventListener('abort', abort);
    try { await reader.cancel(); } catch { /* The transport may already be closed. */ }
    reader.releaseLock();
  }
}

/** Restarts one invalidated continuation at its original edge, leaving older browsing to the caller. */
export async function recoverCursor<T>(cursor: string | null, read: (cursor: string | null) => Promise<T>): Promise<T> {
  try { return await read(cursor); }
  catch (error) {
    if (cursor === null || !(error instanceof HubHttpError) || error.status !== 409 || error.code !== 'stale_boundary') throw error;
    return read(null);
  }
}
