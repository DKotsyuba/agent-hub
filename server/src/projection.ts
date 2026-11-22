/// <reference lib="es2024.string" />
/** Shared projection context, source classification and bounded text slices. */
import type { ApiRequest, Coverage, Observation, Page } from '@agent-hub/domain';
import { number, object, text } from '../../src/live/protocol.ts';
import { Cursors, digest, type Position } from './cursor.ts';
import type { RunStatusRequest } from '../../terminal/src/run-status.ts';
import { HubError } from './errors.ts';
import type { ObservationClient, NativeResponse as ReadResponse, ObserverResource as Resource } from './observer.ts';

/** A request accepted by the domain router. */
export type Query = NonNullable<ApiRequest>;

/** Selects the parsed input of one route. */
export type Input<K extends Query['route']> = Extract<Query, { route: K }>;

export const noPage: Page = { next: null, previous: null, resume: null };

/** Optional producer record, with absent values represented by an empty object. */
export function optionalObject(value: unknown): Record<string, unknown> {
  return value == null ? {} : object(value);
}

/** Validates the outer shape and converts each producer row to a record. */
export function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new HubError('invalid_projection');
  return value.map(object);
}

/** Converts a producer epoch in seconds to API milliseconds. */
export function ms(value: unknown): number | null {
  const seconds = number(value);
  return seconds === null || seconds < 0 ? null : Math.round(seconds * 1000);
}

/** Preserves a nonnegative counter without rounding unsafe JSON numbers. */
export function decimalValue(value: unknown): string {
  if (typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  throw new HubError('invalid_projection');
}

/** Uses stable path-derived public IDs without exposing paths in route selectors. */
export function projectId(path: string): string {
  return 'project-' + digest(path);
}

/** Adds coverage with the budget and consistency represented independently. */
export function coverage(scope: Coverage['scope'], complete: boolean, consistency?: Coverage['consistency']): Coverage {
  return { scope, state: complete ? 'complete' : 'partial', consistency };
}

/** Returns a safe observation for a correlated native envelope. */
export function observed(result: ReadResponse, producerAtMs: number | null = null, scope?: Coverage): Observation {
  return {
    source: (result.source === 'hub' ? 'worktree' : result.source) as Observation['source'],
    resource: result.resource, outcome: scope?.state === 'partial' && result.outcome === 'ok' ? 'partial' : result.outcome,
    producerAtMs, observedAtMs: result.observed_at_ms, coverage: scope,
    ...(result.error ? { issue: { code: 'source_' + result.outcome } } : {}),
  };
}

/** Makes single-source failures explicit before any payload projection. */
export function requireData(result: ReadResponse): unknown {
  if (result.error?.code && /^(?:stale|revision_changed|stale_revision|watermark|execution_ref_mismatch|run_store_identity_mismatch)$/.test(result.error.code)) throw new HubError('stale_boundary');
  switch (result.outcome) {
    case 'ok': case 'partial': return result.data;
    case 'missing': throw new HubError('not_found');
    case 'incompatible': throw new HubError('unsupported_capability');
    case 'invalid': throw new HubError('invalid_projection');
    default: throw new HubError('source_unavailable');
  }
}

/** Owns the observer subscriber and cursor scope for one request. */
export class ReadContext {
  private remainingReads = 1024;
  private remainingBytes = 48 * 1024 * 1024;

  /** Keeps all native calls tied to the same HTTP deadline and abort signal. */
  constructor(
    readonly client: ObservationClient,
    readonly cursors: Cursors,
    readonly signal: AbortSignal,
    readonly bindings: Map<string, RunStatusRequest>,
  ) {}

  /** Sends closed resource and server-constructed parameters only. */
  async read(resource: Resource, params: Record<string, unknown> = {}, caller?: AbortSignal): Promise<ReadResponse> {
    if (--this.remainingReads < 0 || this.remainingBytes < 0) throw new HubError('invalid_projection');
    const signal = caller ? AbortSignal.any([this.signal, caller]) : this.signal;
    const response = await this.client.read(resource, params, signal);
    this.remainingBytes -= Buffer.byteLength(JSON.stringify(response.data));
    if (this.remainingBytes < 0) throw new HubError('invalid_projection');
    return response;
  }

  /** Returns a UTF-8-safe slice only after callers verify the full content or revision. */
  textPage(query: Query, value: string, fence: string, position: Position | null) {
    if (!value.isWellFormed()) throw new HubError('invalid_projection');
    const bytes = Buffer.from(value);
    if (bytes.length > 32 * 1024 * 1024) throw new HubError('invalid_projection');
    const offset = position ? Number(position.at) : 0;
    if (position && (position.fence !== fence || offset > bytes.length)) throw new HubError('stale_boundary');
    let end = Math.min(bytes.length, offset + 32 * 1024);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    return { content: { text: bytes.toString('utf8', offset, end), offsetBytes: offset, totalBytes: bytes.length },
      page: { ...noPage, next: end < bytes.length ? this.cursors.encode(query, { at: end, fence, direction: 'newer', through: position?.through }) : null } };
  }
}

/** Checks a selected period with an exclusive upper bound. */
export function inPeriod(query: { from: number | null; to: number | null }, clock: number | null): boolean {
  if (query.from === null && query.to === null) return true;
  return clock !== null && clock >= (query.from ?? 0) && clock < (query.to ?? Infinity);
}

/** Reads text only from a known field of an optional source object. */
export function field(value: unknown, key: string): string | null {
  return text(optionalObject(value)[key]);
}
