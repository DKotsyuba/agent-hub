/** Shares in-flight native reads and keeps separate capacity for independent sources. */
import { response } from '../../src/live/protocol.ts';
import type { ObservationClient, NativeResponse as ReadResponse, ObserverResource as Resource } from './observer.ts';
import { HubError } from './errors.ts';

/** Read ownership and subscriber count for one native operation. */
interface Flight {
  controller: AbortController;
  done: Promise<ReadResponse>;
  consumers: number;
}

/** Shares only identical requests and holds source slots until child cleanup completes. */
export function shareReads(native: ObservationClient): ObservationClient {
  const flights = new Map<string, Flight>();
  const active = new Map<string, number>();
  let closed = false;

  /** Subscribes to an existing read or admits a bounded new native operation. */
  function read(resource: Resource, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<ReadResponse> {
    if (closed || signal?.aborted) return Promise.reject(new HubError('source_unavailable'));
    const key = JSON.stringify([resource, Object.entries(params).sort(([a], [b]) => a.localeCompare(b))]);
    const source = resource.split('.')[0];
    let entry = flights.get(key);
    if (!entry || entry.controller.signal.aborted) {
      const count = active.get(source) ?? 0;
      const inspecting = resource === 'worktree.inspect';
      if (count >= 4 || inspecting && active.has('inspect')) {
        return Promise.reject(new HubError('saturated'));
      }
      active.set(source, count + 1);
      if (inspecting) active.set('inspect', 1);
      const controller = new AbortController();
      const done = Promise.resolve().then(() => native.read(resource, params, controller.signal))
        .then(value => {
          const envelope = response(value, resource) as ReadResponse;
          if (!Number.isSafeInteger(envelope.observed_at_ms) || envelope.observed_at_ms < 0) throw new HubError('invalid_projection');
          return envelope;
        })
        .finally(() => {
          active.set(source, (active.get(source) ?? 1) - 1);
          if (inspecting) active.delete('inspect');
          if (flights.get(key)?.controller === controller) flights.delete(key);
        });
      entry = { controller, done, consumers: 0 };
      flights.set(key, entry);
    }
    const flight = entry;
    flight.consumers++;
    return new Promise((resolve, reject) => {
      /** Detaches exactly once and cancels the underlying read after the last departure. */
      function leave(): void {
        signal?.removeEventListener('abort', abort);
        if (--flight.consumers === 0) flight.controller.abort();
      }
      let finished = false;
      /** Releases only this subscriber on cancellation. */
      function abort(): void {
        if (finished) return;
        finished = true;
        leave();
        reject(new HubError('source_unavailable'));
      }
      signal?.addEventListener('abort', abort, { once: true });
      flight.done.then(value => {
        if (finished) return;
        finished = true;
        leave();
        resolve(value);
      }, error => {
        if (finished) return;
        finished = true;
        leave();
        reject(error);
      });
      if (signal?.aborted) abort();
    });
  }

  /** Stops admission and waits for every child through the native owner. */
  async function close(): Promise<void> {
    closed = true;
    for (const flight of flights.values()) flight.controller.abort();
    await native.close();
  }

  return { read, close };
}
