/** Shared lightweight SSE poller with a bounded queue per foreground connection. */
import { event, type HubEvent, type Topic } from '@agent-hub/domain';
import { bridgeData, poolDetail, poolPage, runPage, worktreePage } from '../../src/live/protocol.ts';
import { quotaSnapshot, quotaStatus } from '../../terminal/src/quota.ts';
import { digest } from './cursor.ts';
import { HubError, logSourceFailure } from './errors.ts';
import { observed } from './projection.ts';
import type { ObserverResource } from './observer.ts';
import type { SharedReads } from './reads.ts';

/** One bounded poll independent of expensive page, transcript and inspect work. */
type Probe = [ObserverResource, Record<string, unknown>?];

/** Selects fixed, lightweight reads for root and detail topics. */
function probes(topic: Topic): Probe[] {
  const [, id] = topic.split(':');
  if (topic.startsWith('session:')) return [['run.agents', { limit: 1, offset: 0 }]];
  if (topic.startsWith('pool:')) return [['pool.get', { pool_id: id, section: 'proposal', after: 0 }]];
  if (topic.startsWith('worktree:')) return [['worktree.list', { limit: 1, discovery: false }]];
  switch (topic) {
    case 'overview': return [['run.agents', { limit: 1, offset: 0 }], ['bridge.overview'], ['quota.snapshot']];
    case 'sessions': return [['run.agents', { limit: 1, offset: 0 }]];
    case 'pools': return [['pool.list']];
    case 'quota': return [['quota.snapshot'], ['quota.status']];
    case 'worktrees': return [['worktree.list', { limit: 1, discovery: false }]];
    case 'incidents': return [['bridge.incidents', { limit: 1, after_seq: 0, include_closed: true }]];
  }
  return [];
}

/** Checks a probe with the producer parser before allowing it to advance a stream boundary. */
function validateProbe(resource: ObserverResource, data: unknown): void {
  switch (resource) {
    case 'run.agents': runPage(data); break;
    case 'pool.list': poolPage(data); break;
    case 'pool.get': poolDetail(data); break;
    case 'quota.snapshot': quotaSnapshot(data); break;
    case 'quota.status': quotaStatus(data); break;
    case 'bridge.overview': bridgeData(data, 'bridge_overview'); break;
    case 'bridge.incidents': bridgeData(data, 'incident_page'); break;
    case 'worktree.list': worktreePage(data); break;
  }
}

/** Removes volatile receipt/sample clocks so identical source facts do not trigger invalidations. */
function sourceBoundary(data: unknown): string {
  return digest(JSON.stringify(data, (key, value: unknown) =>
    ['observed_at', 'observed_at_unix_ms', 'observed_at_ms', 'evaluated_at', 'elapsed_seconds', 'silence_seconds'].includes(key) ? undefined : value));
}

/** Active subscribers and schedule for a single distinct topic. */
interface TopicState {
  subscribers: Set<Subscriber>;
  timer?: ReturnType<typeof setTimeout>;
  due?: number;
  controller?: AbortController;
  boundary?: string;
  outcomes: Map<string, string>;
  failures: number;
}

/** A stream subscription with its own cadence and lifetime. */
interface Subscriber {
  interval: number;
  emit(value: HubEvent): void;
  close(): void;
}

/** Runs one poll per topic, at the fastest subscribed rate, and closes slow connections. */
export class Events {
  private readonly topics = new Map<Topic, TopicState>();
  private readonly streams = new Set<Subscriber>();
  private closed = false;

  /** Uses the same admitted native reads as foreground requests. */
  constructor(private readonly client: SharedReads) {}

  /** Opens one stream with validated topics and rate. The response owns subscription cleanup. */
  open(topics: Topic[], interval: number, signal: AbortSignal): Response {
    if (this.closed || signal.aborted) throw new HubError('source_unavailable');
    // Unix transport identifies one local principal, so cap the aggregate and each subscription.
    if (this.streams.size >= 16 || this.topics.size + topics.filter(topic => !this.topics.has(topic)).length > 64) throw new HubError('saturated');
    const encoder = new TextEncoder();
    let cleanup = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start: controller => {
        let active = true;
        /** Enqueues a complete SSE frame, cutting off exhausted consumers. */
        const send = (frame: string) => {
          if (!active) return;
          if ((controller.desiredSize ?? 0) <= 0) {
            cleanup();
            controller.error(new Error('stream queue exhausted'));
          } else controller.enqueue(encoder.encode(frame));
        };
        const subscriber: Subscriber = {
          interval: interval * 1000,
          emit: value => send('event: ' + value.type + '\ndata: ' + JSON.stringify(event(value)) + '\n\n'),
          close: () => { if (active) { cleanup(); controller.close(); } },
        };
        const heartbeat = setInterval(() => send(': heartbeat\n\n'), 15_000);
        cleanup = () => {
          if (!active) return;
          active = false;
          clearInterval(heartbeat);
          signal.removeEventListener('abort', subscriber.close);
          this.streams.delete(subscriber);
          for (const topic of topics) {
            const state = this.topics.get(topic);
            state?.subscribers.delete(subscriber);
            if (!state) continue;
            if (state.subscribers.size === 0) {
              clearTimeout(state.timer);
              state.controller?.abort();
              this.topics.delete(topic);
            } else this.schedule(topic, state, false);
          }
        };
        signal.addEventListener('abort', subscriber.close, { once: true });
        this.streams.add(subscriber);
        subscriber.emit({ type: 'ready', topics, observedAtMs: Date.now() });
        for (const topic of topics) {
          let state = this.topics.get(topic);
          const initial = !state;
          if (!state) {
            state = { subscribers: new Set(), outcomes: new Map(), failures: 0 };
            this.topics.set(topic, state);
          }
          state.subscribers.add(subscriber);
          this.schedule(topic, state, initial);
        }
        if (signal.aborted) subscriber.close();
      },
      cancel: () => cleanup(),
    }, { highWaterMark: 32 });
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' } });
  }

  /** Schedules one poll while preserving bounded outage backoff. */
  private schedule(topic: Topic, state: TopicState, initial: boolean): void {
    if (state.controller || !state.subscribers.size) return;
    const interval = Math.min(...[...state.subscribers].map(value => value.interval));
    const delay = initial ? 0 : Math.min(30_000, interval * 2 ** state.failures);
    const due = Date.now() + delay;
    if (state.due !== undefined && state.due <= due) return;
    clearTimeout(state.timer);
    state.due = due;
    state.timer = setTimeout(() => {
      state.due = undefined;
      void this.poll(topic, state);
    }, delay);
  }

  /** Emits changes to source authority/outcome and a compact invalidation when data moves. */
  private async poll(topic: Topic, state: TopicState): Promise<void> {
    const controller = new AbortController();
    state.controller = controller;
    const requestId = crypto.randomUUID();
    try {
      const reads = probes(topic);
      const results = await Promise.allSettled(reads.map(([resource, params]) => this.client.read(resource, params, controller.signal,
        (resource, failure) => logSourceFailure('events', requestId, resource, failure))));
      if (controller.signal.aborted) return;
      const boundaries: string[] = [];
      let failed = false;
      for (const [index, result] of results.entries()) {
        const resource = reads[index][0];
        const observation = result.status === 'fulfilled' ? observed(result.value) : {
          source: resource.split('.')[0] as 'run' | 'pool' | 'worktree' | 'quota' | 'bridge', resource,
          outcome: 'unavailable' as const, observedAtMs: Date.now(), producerAtMs: null,
        };
        if (result.status === 'fulfilled' && ['ok', 'partial'].includes(observation.outcome)) {
          try {
            validateProbe(resource, result.value.data);
            boundaries.push(sourceBoundary(result.value.data));
          } catch {
            observation.outcome = 'invalid';
            failed = true;
            this.client.projectionFailure(result.value);
          }
        } else {
          failed = true;
        }
        const prior = state.outcomes.get(resource);
        if (prior !== observation.outcome) {
          state.outcomes.set(resource, observation.outcome);
          for (const subscriber of state.subscribers) subscriber.emit({ type: 'source-state', topic, observation });
        }
      }
      state.failures = failed ? Math.min(5, state.failures + 1) : 0;
      const boundary = digest(boundaries);
      if (boundaries.length && boundary !== state.boundary) {
        state.boundary = boundary;
        for (const subscriber of state.subscribers) subscriber.emit({ type: 'changed', topic, boundary });
      }
    } finally {
      state.controller = undefined;
      if (!controller.signal.aborted) this.schedule(topic, state, false);
    }
  }

  /** Closes all streams and cancels their outstanding subscriptions. */
  close(): void {
    this.closed = true;
    for (const stream of this.streams) stream.close();
  }
}
