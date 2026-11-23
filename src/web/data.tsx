/** Shared browser read lifecycle and SSE invalidation for the visible route. */
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { HubEvent, Observation, Topic } from '@agent-hub/domain';
import { createHubClient, HubHttpError } from './client';

/** Uses same-origin requests and preserves the browser's finite-read error codes. */
export const client = createHubClient({ fetch: async (input, options) => {
  try {
    return await fetch(input, { ...options, cache: 'no-store' });
  } catch (error) {
    if (options?.signal?.aborted) throw error;
    throw new HubHttpError('network_unavailable', 0);
  }
} });

/** Current subscription invalidations, source states and explicit refresh generation. */
export const LiveContext = createContext<{
  visible: boolean; events: ReadonlyMap<Topic, HubEvent>; sourceEvents?: ReadonlyMap<Topic, readonly Observation[]>; refresh: number; unreachable?: boolean; reportRead?: (at: number) => void;
}>({ visible: true, events: new Map(), refresh: 0 });

/** Closes the scoped stream on hide and revalidates through ready after reopening. */
export function useLive(topics: readonly Topic[], interval: 1 | 3 | 5 | 10) {
  const [visible, setVisible] = useState(!document.hidden);
  const [scope, setScope] = useState<{ key: string; events: Map<Topic, HubEvent>; sourceEvents: Map<Topic, Observation[]> }>({
    key: '', events: new Map(), sourceEvents: new Map(),
  });
  const [connection, setConnection] = useState('connecting');
  const key = topics.join(',');
  useEffect(() => {
    const show = () => setVisible(!document.hidden);
    const hide = () => setVisible(false);
    document.addEventListener('visibilitychange', show);
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', show);
    return () => {
      document.removeEventListener('visibilitychange', show);
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', show);
    };
  }, []);
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    const events = new Map<Topic, HubEvent>();
    const sourceEvents = new Map<Topic, Map<string, Observation>>();
    let pending: number | undefined;
    const publish = () => {
      pending = undefined;
      setScope({ key, events: new Map(events), sourceEvents: new Map([...sourceEvents].map(([topic, values]) => [topic, [...values.values()]])) });
    };
    setConnection('connecting');
    void client.watch(key.split(',') as Topic[], interval, {
      event: event => {
        for (const topic of event.type === 'ready' ? event.topics : [event.topic]) events.set(topic, event);
        if (event.type === 'source-state') {
          const value = event.observation;
          const id = value.source + ':' + (value.resource ?? '');
          const scoped = sourceEvents.get(event.topic) ?? new Map<string, Observation>();
          scoped.set(id, value);
          sourceEvents.set(event.topic, scoped);
        }
        pending ??= window.setTimeout(publish, 24);
      },
      connection: setConnection,
    }, controller.signal).catch(() => { if (!controller.signal.aborted) setConnection('disconnected'); });
    publish();
    return () => {
      controller.abort();
      window.clearTimeout(pending);
    };
  }, [key, interval, visible]);
  return { visible: visible && scope.key === key, events: scope.events, sourceEvents: scope.sourceEvents, connection };
}

/** Restricts stream invalidation to the read's own topic or the ready frame. */
export function useReadSignal(topic?: Topic) {
  const { visible, events, refresh } = useContext(LiveContext);
  return { visible, matched: topic ? events.get(topic) : undefined, refresh };
}

/** A read can retain successful data while showing a new failure for the same key. */
export type Read<T> = { value: T | null; error: string | null; loading: boolean; failedAt?: number };

/** Resolves a protocol code without surfacing browser or upstream diagnostic bodies. */
export function errorCode(error: unknown) {
  return error instanceof HubHttpError && error.code !== 'http_error' ? error.code : error instanceof Error && error.message === 'content_budget' ? error.message : 'invalid_projection';
}

/** Latest-wins read keyed by the normalized request; hides previous-query data immediately. */
export function useRead<T>(key: string, load: (signal: AbortSignal) => Promise<T>, topic?: Topic, pollMs?: number): Read<T> {
  const [state, setState] = useState<Read<T> & { key: string }>({ key, value: null, error: null, loading: true });
  const { visible, matched, refresh } = useReadSignal(topic);
  const { reportRead } = useContext(LiveContext);
  const [poll, setPoll] = useState(0);
  useEffect(() => {
    if (!pollMs) return;
    const update = () => { if (!document.hidden) setPoll(value => value + 1); };
    const timer = window.setInterval(update, pollMs);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', update);
    };
  }, [pollMs]);
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    setState(old => old.key === key ? { ...old, loading: true } : { key, value: null, error: null, loading: true });
    void load(controller.signal).then(value => {
      if (!controller.signal.aborted) {
        const updatedAt = Date.now();
        setState({ key, value, error: null, loading: false });
        reportRead?.(updatedAt);
      }
    }, error => {
      if (!controller.signal.aborted) setState(old => ({ key, value: old.key === key ? old.value : null,
        loading: false, error: errorCode(error), failedAt: old.key === key && old.failedAt ? old.failedAt : Date.now() }));
    });
    return () => controller.abort();
    // The key encodes all resource/filter inputs; the inline reader need not be memoized.
  }, [key, visible, matched, refresh, poll, reportRead]);
  return state.key === key ? state : { value: null, error: null, loading: true };
}

/** Recovers an expired continuation at the first page while retaining the same read slot. */
export function usePagedRead<T>(scope: unknown, cursor: string | null, load: (cursor: string | null, signal: AbortSignal) => Promise<T>, topic: Topic) {
  const key = JSON.stringify([scope, cursor]);
  const expired = useRef<string | null>(null);
  return useRead(key, async signal => {
    const selected = expired.current === key ? null : cursor;
    try { return await load(selected, signal); }
    catch (error) {
      if (!selected || signal.aborted || errorCode(error) !== 'stale_boundary') throw error;
      expired.current = key;
      return load(null, signal);
    }
  }, topic);
}
