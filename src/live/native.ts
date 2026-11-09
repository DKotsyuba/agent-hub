/** The renderer's entire native read surface: four closed Tauri commands, no shell/fs/http fallback. */
import { Channel, invoke, isTauri } from '@tauri-apps/api/core';
import { failure, response } from './protocol.ts';
import type { ReadRequest, ReadResponse } from './protocol.ts';

/** Explicit source selection; a native production window always uses live observations. */
export type DataMode = 'live' | 'demo' | 'unavailable';
/** Pure mode decision used by focused checks; native never obeys a persisted prototype URL. */
export function selectMode(native: boolean, search: string, configured?: string): DataMode { return native ? 'live' : new URLSearchParams(search).get('demo') === '1' || configured === 'demo' ? 'demo' : 'unavailable'; }
/** Reads only explicit build/runtime demo intent, never availability-based fixture fallback. */
export function dataMode(): DataMode { return selectMode(typeof window !== 'undefined' && isTauri(), typeof location === 'undefined' ? '' : location.search, import.meta.env?.VITE_AGENT_HUB_MODE); }
/** In-flight reads are shared by exact closed request, preventing duplicate overlapping one-shots. */
const inFlight = new Map<string, Promise<ReadResponse>>();
/** Executes a single bounded native read and validates correlation; native/source errors retain their envelope. */
export function read(request: ReadRequest): Promise<ReadResponse> {
  const key = JSON.stringify(request); const existing = inFlight.get(key); if (existing) return existing;
  const operation = invoke<unknown>('hub_read', { request }).then(value => response(value, request.resource)).catch(() => failure(request.resource)).finally(() => inFlight.delete(key));
  inFlight.set(key, operation); return operation;
}
/** Execution-sensitive reads wait out an older identical request, then reread only if still current. */
export async function readCurrent(request: ReadRequest, current: () => boolean): Promise<ReadResponse> {
  const pending = inFlight.get(JSON.stringify(request));
  if (pending) await pending;
  return current() ? read(request) : failure(request.resource, 'obsolete');
}
/** Cancels exactly one app-owned subscription; source daemons/agents are never addressed. */
async function unwatch(subscriptionId: string): Promise<void> { try { await invoke('hub_unwatch', { subscriptionId }); } catch { /* Native window ownership also drains subscriptions on exit. */ } }
/** Owns a Channel and handles the unmount-before-subscription-ID race without leaking the late subscription. */
export function watch(request: ReadRequest, accept: (value: ReadResponse) => void): () => void {
  let closed = false; let subscriptionId: string | null = null;
  const channel = new Channel<unknown>(value => { if (closed) return; try { accept(response(value, request.resource)); } catch { accept(failure(request.resource, 'renderer_schema')); } });
  void invoke<unknown>('hub_watch', { request, channel }).then(id => {
    if (typeof id !== 'string' || !id || id.length > 32) throw new Error('subscription_id');
    subscriptionId = id; if (closed) void unwatch(id);
  }).catch(() => { if (!closed) accept(failure(request.resource, 'watch_unavailable')); });
  return () => { closed = true; if (subscriptionId !== null) void unwatch(subscriptionId); };
}
/** Reads safe connection diagnostics only; this command does not probe services or expose credential contents. */
export async function connections(): Promise<unknown> { try { return await invoke<unknown>('hub_connections'); } catch { return { schema_version: 1, state: 'invalid', error: { code: 'connections_unavailable' } }; } }
