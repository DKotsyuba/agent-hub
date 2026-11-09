/** View-owned read state, native subscription cleanup and source-generation fences. */
import { useEffect, useRef, useState } from 'react';
import { read, watch } from './native';
import { collectPages, failure, usable, nextObservation } from './protocol';
import type { Cursor, Page, ReadRequest, ReadResponse, Observation } from './protocol';

export type { Observation } from './protocol';
/** Stops observers while the document is hidden and removes its listener on unmount. */
export function useVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  useEffect(() => { const changed = () => setVisible(document.visibilityState !== 'hidden'); document.addEventListener('visibilitychange', changed); return () => document.removeEventListener('visibilitychange', changed); }, []);
  return visible;
}
/** Watches or reads one exact request; changed selection/unmount invalidates obsolete replies. */
export function useObservation(request: ReadRequest | null, refresh: number, subscribe = true, enabled = true, validate?: (value: unknown) => unknown): Observation {
  const key = JSON.stringify(request);
  const visible = useVisible();
  const [state, setState] = useState<Observation>({ key, response: null, good: null, loading: request !== null });
  useEffect(() => {
    if (!request || !enabled || !visible) return;
    let current = true;
    setState(previous => ({ key, response: previous.key === key ? previous.response : null, good: previous.key === key ? previous.good : null, loading: true }));
    /** A native error retains only this request's prior producer snapshot. */
    const accept = (envelope: ReadResponse) => {
      if (!current) return;
      setState(previous => nextObservation(previous, envelope, key, validate));
    };
    const stop = subscribe ? watch(request, accept) : (() => { void read(request).then(accept); return () => {}; })();
    return () => { current = false; stop(); };
  }, [key, refresh, enabled, visible, subscribe]);
  return state.key === key ? state : { key, response: null, good: null, loading: request !== null };
}
/** Last complete loaded coverage plus current source errors; never a first-page replacement. */
export interface Inventory<T> extends Observation {
  /** Last successfully parsed loaded coverage, including a real continuation cursor. */
  page: Page<T> | null;
  /** Explicitly requests another source page without overlapping the current collection. */
  loadMore: () => void;
}
/** Keeps all explicitly loaded pages across first-page watch updates, fencing changed revisions. */
export function useInventory<T>(request: ReadRequest, parse: (value: unknown) => Page<T>, pageParams: (cursor: Cursor) => Record<string, unknown>, keyOf: (item: T) => string, refresh: number, enabled: boolean): Inventory<T> {
  const key = JSON.stringify(request);
  const visible = useVisible();
  const target = useRef(1);
  const more = useRef<() => void>(() => {});
  const [state, setState] = useState<Observation & { page: Page<T> | null }>({ key, response: null, good: null, loading: enabled, page: null });
  useEffect(() => {
    more.current = () => {};
    if (!enabled || !visible) return;
    let active = true; let epoch = 0; let pumping = false; let pending: ReadResponse | null = null; let latest: ReadResponse | null = null; let latestRevision: unknown = undefined;
    setState(previous => ({ ...previous, key, loading: true }));
    /** A single drain coalesces revisions instead of issuing overlapping page traversals. */
    async function drain() {
      if (pumping) return; pumping = true;
      try {
        while (pending && active) {
          const envelope: ReadResponse = pending; pending = null; const generation = epoch;
          if (!usable(envelope)) { if (active) setState(previous => ({ ...previous, response: envelope, loading: false })); continue; }
          try {
            const page = await collectPages(parse(envelope.data), target.current, async cursor => {
              const value = await read({ resource: request.resource, params: { ...request.params, ...pageParams(cursor) } });
              if (!usable(value)) throw new Error('page_unavailable');
              return parse(value.data);
            }, keyOf, () => active && generation === epoch);
            if (active && generation === epoch) setState({ key, response: envelope, good: envelope, loading: false, page });
          } catch {
            if (active && generation === epoch) setState(previous => ({ ...previous, response: failure(request.resource, 'source_page_invalid_or_changed'), loading: false }));
          }
        }
      } finally { pumping = false; }
    }
    /** Changed first-page revisions invalidate old traversal commits but retain loaded page count. */
    const accept = (value: ReadResponse) => { if (!active) return; const revision = value.data && typeof value.data === 'object' && !Array.isArray(value.data) ? (value.data as Record<string, unknown>).revision : undefined; if (request.resource !== 'run.agents' || revision !== latestRevision || !usable(value)) epoch++; latestRevision = revision; latest = value; pending = value; void drain(); };
    more.current = () => { if (latest && active) { target.current++; setState(previous => ({ ...previous, loading: true })); accept(latest); } };
    const stop = watch(request, accept);
    return () => { active = false; epoch++; more.current = () => {}; stop(); };
  }, [key, refresh, enabled, visible]);
  return { ...state, loadMore: () => more.current() };
}
