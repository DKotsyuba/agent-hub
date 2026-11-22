/** Browser-local v1 transport until the shared client lands. */
import { API_PREFIX, API_ROUTES, API_RESPONSES, apiError, event as decodeEvent } from '@agent-hub/domain';
import type { ApiResponse, HubEvent, Topic } from '@agent-hub/domain';

/** Scalar API query values; null and undefined omit the parameter. */
export type Query = Record<string, string | number | boolean | null | undefined>;

/** A rejected HTTP request or malformed protocol response. */
export class HubHttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

/** Creates a read-only client with same-origin credentials and a native browser event stream. */
export function createHubClient({ baseUrl = '', fetch: request = globalThis.fetch }: { baseUrl?: string; fetch?: typeof fetch } = {}) {
  return {
    /** Validates a successful response with the frozen route decoder. */
    async get<K extends keyof typeof API_RESPONSES>(route: K, { params = {}, query = {}, signal }: {
      params?: Record<string, string>; query?: Query; signal?: AbortSignal;
    } = {}): Promise<ApiResponse<K>> {
      const path = API_ROUTES[route].replace(/:(\w+)/g, (_, name: string) => encodeURIComponent(params[name]));
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) if (value != null && value !== '') search.set(key, String(value));
      let response: Response;
      try {
        response = await request(baseUrl + API_PREFIX + path + (search.size ? '?' + search : ''), { signal, cache: 'no-store' });
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new HubHttpError(0, 'network_unavailable');
      }
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        let code = 'invalid_projection';
        try { code = apiError(body).error.code; } catch { /* Non-v1 upstream error. */ }
        throw new HubHttpError(response.status, code);
      }
      try { return API_RESPONSES[route](body) as ApiResponse<K>; }
      catch { throw new HubHttpError(response.status, 'invalid_projection'); }
    },
    /** Subscribes until aborted; EventSource owns transport retries. */
    watch(topics: readonly Topic[], interval: number, callbacks: {
      event: (event: HubEvent) => void; connection: (state: 'connecting' | 'connected' | 'disconnected') => void;
    }, signal: AbortSignal): Promise<void> {
      if (signal.aborted) return Promise.resolve();
      const query = new URLSearchParams({ interval: String(interval) });
      for (const topic of topics) query.append('topic', topic);
      const stream = new EventSource(baseUrl + API_PREFIX + '/events?' + query);
      callbacks.connection('connecting');
      stream.onopen = () => callbacks.connection('connected');
      stream.onerror = () => callbacks.connection('disconnected');
      for (const type of ['ready', 'changed', 'source-state']) stream.addEventListener(type, (frame: MessageEvent<string>) => {
        let event: HubEvent;
        try { event = decodeEvent(JSON.parse(frame.data)); } catch { return; }
        if (event.type === type) callbacks.event(event);
      });
      return new Promise(resolve => signal.addEventListener('abort', () => { stream.close(); resolve(); }, { once: true }));
    },
  };
}
