/** Closed observations available to the terminal interface in this iteration. */
export type Resource =
  | 'run.identity' | 'run.agents' | 'run.status' | 'run.transcript' | 'run.transcript_exact' | 'run.answer' | 'run.answer_chunk'
  | 'run.models' | 'run.limits' | 'run.initial_task'
  | 'quota.status' | 'quota.snapshot'
  | 'hub.repositories' | 'worktree.identity' | 'worktree.list' | 'worktree.inspect'
  | 'pool.identity' | 'pool.list' | 'pool.get' | 'pool.run_proof' | 'pool.inventory_snapshot'
  | 'bridge.identity' | 'bridge.overview' | 'bridge.deliveries' | 'bridge.incidents';

/** A source-preserving response from the existing native read contract. */
export interface ReadResponse {
  schema_version: 1;
  source: string;
  resource: Resource;
  observed_at_ms: number;
  outcome: 'ok' | 'partial' | 'unavailable' | 'incompatible' | 'missing' | 'invalid';
  data: unknown;
  error: { code: string; message: string } | null;
}

/** Finite read-only observations; closing cancels only application-owned reads. */
export interface ObservationClient {
  read(resource: Resource, params?: Record<string, unknown>, signal?: AbortSignal): Promise<ReadResponse>;
  close(): Promise<void>;
}

/** Explicitly chosen input mode; a failed live read never becomes demo data. */
export type AppMode = 'live' | 'demo';

/** Separates a page continuation from an independent producer coverage warning. */
export function independentlyPartial(envelope: { outcome: string; data: unknown }): boolean {
  if (envelope.outcome !== 'partial') return false;
  if (!envelope.data || typeof envelope.data !== 'object' || Array.isArray(envelope.data)) return true;
  const data = envelope.data as Record<string, unknown>, coverage = data.coverage;
  const nested = data.data && typeof data.data === 'object' && !Array.isArray(data.data) ? data.data as Record<string, unknown> : null;
  const nestedCoverage = nested?.coverage;
  return data.complete !== false || data.partial === true || data.outcome === 'partial' || !!coverage && typeof coverage === 'object' && !Array.isArray(coverage) && (coverage as Record<string, unknown>).complete === false || !!nestedCoverage && typeof nestedCoverage === 'object' && !Array.isArray(nestedCoverage) && (nestedCoverage as Record<string, unknown>).complete === false;
}
