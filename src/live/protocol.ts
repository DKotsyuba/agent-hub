/** Runtime-checked producer observations and proof/pagination helpers; never source mutations. */

/** Closed Rust read resources; no caller-supplied method, executable, path reader or HTTP endpoint. */
export type Resource = 'run.identity' | 'run.agents' | 'run.status' | 'run.transcript' | 'run.transcript_exact' | 'run.answer' | 'run.answer_chunk' | 'run.models' | 'run.limits' | 'run.initial_task' | 'run.pools' | 'run.pool' | 'quota.status' | 'quota.snapshot' | 'hub.repositories' | 'worktree.identity' | 'worktree.list' | 'worktree.inspect' | 'tasks.identity' | 'tasks.peek' | 'pool.identity' | 'pool.list' | 'pool.get' | 'pool.run_proof' | 'pool.inventory_snapshot' | 'pool.completion_get' | 'pool.enrollment_get' | 'bridge.identity' | 'bridge.overview' | 'bridge.deliveries' | 'bridge.incidents' | 'ide.identity' | 'ide.observe';
/** Native classification, independent of any agent lifecycle. */
export type Outcome = 'ok' | 'partial' | 'unavailable' | 'incompatible' | 'missing' | 'invalid';
/** Exactly one read request; product argument validation remains authoritative in Rust/services. */
export interface ReadRequest {
  /** Closed resource identity. */
  resource: Resource;
  /** JSON product arguments, never authority or credentials. */
  params: Record<string, unknown>;
}
/** Producer-preserving native envelope. Native receipt time never substitutes for source time. */
export interface ReadResponse {
  /** Exactly the supported native seam version. */
  schema_version: 1;
  /** Product namespace correlated to the requested resource. */
  source: string;
  /** Correlated closed resource. */
  resource: Resource;
  /** Receipt time in milliseconds, explicitly not a producer observation. */
  observed_at_ms: number;
  /** Data availability/compatibility classification. */
  outcome: Outcome;
  /** Untrusted original producer payload; parsed only by the matching source projection. */
  data: unknown;
  /** Safe native error, never raw stderr or a credential. */
  error: { code: string; message: string } | null;
}
/** Stable primitive producer cursor, preserved without interpreting its content. */
export type Cursor = string | number;
/** Checked source page; coverage and raw payload remain available for explanation. */
export interface Page<T> {
  /** Validated source rows in producer order. */
  items: T[];
  /** Next source cursor, absent only when the source has no continuation. */
  next: Cursor | null;
  /** Explicit source total, or null when the producer does not report one. */
  total: number | null;
  /** Complete coverage assertion, which can remain false even with no next cursor. */
  complete: boolean;
  /** Source revision used to fence mutable Run pages. */
  revision: string | number | null;
  /** Producer observation time in epoch seconds; null is never replaced by receipt time. */
  observed: number | null;
  /** Original producer coverage information. */
  coverage: unknown;
  /** Original source page. */
  raw: Record<string, unknown>;
}
/** Minimum useful Run projection, retaining every producer field in raw. */
export interface RunAgent {
  /** Original Run identity; UI namespace is run:agent_id. */
  id: string;
  /** Current execution sequence for resume fencing. */
  sequence: number;
  /** Original lifecycle value, never inferred from silence. */
  status: string;
  /** Original human task label; absent stays null. */
  name: string | null;
  /** Original task summary, never translated. */
  summary: string | null;
  /** Actual source workdir, not an inferred project name. */
  workdir: string | null;
  /** Source model, absent remains unknown. */
  model: string | null;
  /** Requested reasoning effort; null means the source did not report one. */
  effort: string | null;
  /** Source elapsed seconds, absent remains unknown. */
  elapsed: number | null;
  /** Source silence seconds, never a stuck heuristic. */
  silence: number | null;
  /** Source view-build clock in epoch seconds; never interpreted as transcript activity. */
  observed: number | null;
  /** Actual last transcript progress clock in epoch seconds; null remains unknown. */
  progress: number | null;
  /** Terminal commit clock in epoch seconds; null remains unknown. */
  finished: number | null;
  /** Independent answer availability. */
  answerAvailable: boolean | null;
  /** Captured expected answer digest, absent remains unknown. */
  answerSha: string | null;
  /** Original complete record, including unknown fields. */
  raw: Record<string, unknown>;
}
/** Inventory working directory identity; cleanliness/size are not inspected on load. */
export interface LiveWorktree {
  /** Stable producer key. */
  key: string;
  /** Canonical repository identity. */
  common: string;
  /** Confirmed working directory. */
  path: string;
  /** Original branch, nullable for detached/unknown. */
  branch: string | null;
  /** Original row, including coverage and any producer-retained cached measurement. */
  raw: Record<string, unknown>;
}
/** Plain transcript block, preserving source attribution and completeness markers. */
export interface TranscriptBlock {
  /** Stable sequence/block identity scoped by source and execution in the owning hook. */
  key: string;
  /** Original source message object. */
  raw: Record<string, unknown>;
  /** Source text; never interpreted as HTML. */
  content: string;
  /** Source role, including tool. */
  role: string;
  /** Producer sequence, used for ordering. */
  seq: number;
  /** Original producer time. */
  at: number | null;
}
/** Checked transcript page with independently retained forward and older cursors. */
export interface TranscriptPage {
  /** Original checked source blocks. */
  blocks: TranscriptBlock[];
  /** Older-history continuation. */
  previous: Cursor | null;
  /** Forward continuation, not confused with the older cursor. */
  resume: Cursor | null;
  /** Source complete flag. */
  complete: boolean;
  /** Original source page, including truncation metadata. */
  raw: Record<string, unknown>;
}
/** Rejects a malformed producer structure with a stable renderer-owned diagnostic code. */
export function invalid(code: string): never { throw new Error(code); }
/** Narrows an unknown JSON object, rejecting arrays/null. */
export function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('object_expected'); return value as Record<string, unknown>; }
/** Reads a finite numeric observation; unavailable stays null. */
export function number(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
/** Reads a nonnegative safe integer cursor/count; malformed values are rejected. */
export function integer(value: unknown): number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : invalid('integer_expected'); }
/** Reads source text without natural-language parsing or coercion. */
export function text(value: unknown): string | null { return typeof value === 'string' ? value : null; }
/** Preserves a producer primitive cursor; unsupported shapes are rejected. */
export function cursor(value: unknown): Cursor | null { return value === undefined || value === null ? null : typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) ? value : invalid('cursor_expected'); }
/** Validates native envelope version, source/resource correlation and safe error shape. */
export function response(value: unknown, resource: Resource): ReadResponse {
  const row = object(value);
  if (!('data' in row) || !('error' in row) || ((row.outcome === 'ok' || row.outcome === 'partial') && row.data === null)) return invalid('native_data');
  if (row.schema_version !== 1 || row.resource !== resource || row.source !== resource.split('.')[0] || number(row.observed_at_ms) === null || !Number.isFinite(new Date(Number(row.observed_at_ms)).getTime()) || !['ok', 'partial', 'unavailable', 'incompatible', 'missing', 'invalid'].includes(String(row.outcome))) return invalid('native_envelope');
  if (row.error !== null) { const error = object(row.error); if (typeof error.code !== 'string' || typeof error.message !== 'string') return invalid('native_error'); }
  return row as unknown as ReadResponse;
}
/** Wraps a renderer/IPC failure explicitly, retaining no fabricated source data. */
export function failure(resource: Resource, code = 'renderer_read'): ReadResponse { return { schema_version: 1, resource, source: resource.split('.')[0], observed_at_ms: Date.now(), outcome: 'invalid', data: null, error: { code, message: 'Read response unavailable or invalid.' } }; }
/** Only ok/partial data may enter source projectors. */
export function usable(value: ReadResponse): boolean { return value.outcome === 'ok' || value.outcome === 'partial'; }
/** Unwraps a supported versioned product payload without accepting text/prose fallbacks. */
export function product(value: unknown, kind: string): Record<string, unknown> {
  const outer = object(value);
  if (outer.schema_version !== 1 || outer.kind !== kind || outer.error) return invalid('product_envelope');
  return object(outer.data);
}
/** Projects Run records while retaining lifecycle/answer/delivery/cleanup separately. */
export function runAgent(value: unknown): RunAgent {
  const row = object(value);
  if (typeof row.agent_id !== 'string' || !row.agent_id || typeof row.status !== 'string') return invalid('run_agent');
  return { id: row.agent_id, sequence: integer(row.sequence), status: row.status, name: text(row.name), summary: text(row.task_summary), workdir: text(row.workdir), model: text(row.model), effort: text(row.effort), elapsed: number(row.elapsed_seconds), silence: number(row.silence_seconds), observed: number(row.observed_at), progress: number(row.last_progress_at), finished: number(row.finished_at), answerAvailable: typeof row.answer_available === 'boolean' ? row.answer_available : null, answerSha: text(row.answer_sha256), raw: row };
}
/** Validates one Run inventory page, preserving source revision and observed time. */
export function runPage(value: unknown): Page<RunAgent> {
  const row = object(value);
  if (!Array.isArray(row.items) || typeof row.complete !== 'boolean' || (typeof row.revision !== 'number' && typeof row.revision !== 'string')) return invalid('run_page');
  integer(row.offset); integer(row.limit);
  return { items: row.items.map(runAgent), next: cursor(row.next_offset), total: integer(row.total), complete: row.complete, revision: row.revision, observed: number(row.observed_at), coverage: { revision: row.revision, message_revision: row.message_revision, offset: row.offset, complete: row.complete }, raw: row };
}
/** Validates Worktree inventory and its explicit partial/unknown discovery coverage. */
export function worktreePage(value: unknown): Page<LiveWorktree> {
  const row = product(value, 'worktree_page');
  if (!Array.isArray(row.rows) || typeof row.has_more !== 'boolean') return invalid('worktree_page');
  const coverage = object(row.coverage);
  const partial = coverage.budget_exhausted === true || coverage.orphan_scan_truncated === true || coverage.root_unconfigured === true || (Array.isArray(coverage.failed) && coverage.failed.length > 0);
  const items = row.rows.map(value => { const raw = object(value); if (typeof raw.key !== 'string' || typeof raw.repo_common_dir !== 'string' || typeof raw.path !== 'string') return invalid('worktree_row'); return { key: raw.key, common: raw.repo_common_dir, path: raw.path, branch: text(raw.branch), raw }; });
  return { items, next: row.has_more ? cursor(row.cursor) ?? invalid('worktree_cursor') : null, total: null, complete: !row.has_more && !partial, revision: null, observed: null, coverage, raw: row };
}
/** Requires the producer's nested probe objects before an inspection can enter render state. */
export function worktreeDetail(value: unknown): Record<string, unknown> {
  const row = product(value, 'worktree_detail'); const probes = object(row.probes);
  for (const key of ['status', 'integration', 'processes', 'submodules', 'size']) object(probes[key]);
  return row;
}
/** Joins only confirmed paths, preferring the deepest working directory at a path boundary. */
export function longestWorktree(workdir: string | null, trees: LiveWorktree[]): LiveWorktree | null {
  if (!workdir) return null;
  return trees.filter(tree => workdir === tree.path || workdir.startsWith(tree.path.replace(/\/$/, '') + '/')).sort((a, b) => b.path.length - a.path.length)[0] ?? null;
}
/** Collects only requested coverage, checking every source cursor and mutable Run revision. */
export async function collectPages<T>(first: Page<T>, pages: number, next: (cursor: Cursor) => Promise<Page<T>>, key: (item: T) => string, current: () => boolean): Promise<Page<T>> {
  const rows = new Map(first.items.map(item => [key(item), item]));
  const seen = new Set<Cursor>();
  let page = first;
  for (let index = 1; index < pages && page.next !== null; index++) {
    if (!current()) return invalid('obsolete');
    if (seen.has(page.next)) return invalid('pagination_cycle');
    seen.add(page.next);
    page = await next(page.next);
    if (!current()) return invalid('obsolete');
    if (first.revision !== null && page.revision !== first.revision) return invalid('revision_changed');
    for (const item of page.items) rows.set(key(item), item);
  }
  return { ...first, items: [...rows.values()], next: page.next, complete: page.next === null && page.complete && (first.total === null || rows.size === first.total), coverage: { first: first.coverage, last: page.coverage, loaded_pages: seen.size + 1 } };
}
/** Checks the transcript agent ID and preserves cursors; it does not prove an execution incarnation. */
export function transcriptPage(value: unknown, agentId: string): TranscriptPage {
  const row = object(value);
  if (row.agent_id !== agentId || !Array.isArray(row.messages) || typeof row.complete !== 'boolean') return invalid('transcript_page');
  const blocks = row.messages.map(value => { const raw = object(value); if (typeof raw.role !== 'string' || typeof raw.content !== 'string') return invalid('transcript_block'); const seq = integer(raw.seq); return { key: JSON.stringify([seq, raw.role, raw.name ?? null]), seq, role: raw.role, content: raw.content, at: number(raw.at), raw }; });
  return { blocks, previous: cursor(row.previous_cursor), resume: cursor(row.resume_cursor ?? row.next_cursor ?? row.cursor), complete: row.complete, raw: row };
}
/** Merges overlapping blocks without translating content or reordering by arrival time. */
export function mergeBlocks(previous: TranscriptBlock[], incoming: TranscriptBlock[]): TranscriptBlock[] { return [...new Map([...previous, ...incoming].map(block => [block.key, block])).values()].sort((a, b) => a.seq - b.seq); }
/** Finite tools discovery, not a substring search in arbitrary capability prose. */
export function supportsChunks(value: unknown): boolean {
  const identity = object(value); const tools = identity.tools; const entries = Array.isArray(tools) ? tools : tools && typeof tools === 'object' && !Array.isArray(tools) ? object(tools).tools : null;
  return Array.isArray(entries) && entries.some(item => item === 'answer_chunk' || (item && typeof item === 'object' && !Array.isArray(item) && object(item).name === 'answer_chunk'));
}
/** SHA-256 of exact UTF-8 text, matching producer byte proof rather than JavaScript character length. */
export async function sha256(content: string): Promise<string> { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content)))].map(byte => byte.toString(16).padStart(2, '0')).join(''); }
/** Reconstructs at most 16 MiB with agent/hash checks and sequence-fenced chunks, optionally requiring a chunk proof even for inline answers. */
export async function answerText(value: unknown, agentId: string, sequence: number | null, expectedSha: string | null, chunkSupport: boolean, read: (params: Record<string, unknown>) => Promise<unknown>, current: () => boolean, requireChunkProof = false): Promise<string | null> {
  const answer = object(value);
  if (answer.agent_id !== agentId || typeof answer.available !== 'boolean') return invalid('answer_attribution');
  if (!answer.available) return null;
  const digest = text(answer.sha256);
  if (sequence === null || expectedSha === null) return invalid('answer_attribution_missing');
  if (expectedSha !== null && digest !== expectedSha) return invalid('answer_changed');
  const total = integer(answer.size_bytes);
  if (total > 16 * 1024 * 1024) return invalid('answer_budget');
  let content = '';
  if (!requireChunkProof && answer.inline_complete === true && typeof answer.content === 'string') content = answer.content;
  else {
    if (!chunkSupport || sequence === null || !digest || !/^[a-f0-9]{64}$/i.test(digest) || expectedSha === null) return invalid('answer_chunk_unsupported');
    let offset = 0;
    do {
      if (!current()) return invalid('obsolete');
      const chunk = object(await read({ agent_id: agentId, sequence, expected_sha256: digest, offset_bytes: offset, max_bytes: 65536 }));
      if (!current()) return invalid('obsolete');
      if (chunk.agent_id !== agentId || chunk.sequence !== sequence || chunk.sha256 !== digest || chunk.total_bytes !== total || chunk.offset_bytes !== offset || typeof chunk.content !== 'string' || typeof chunk.complete !== 'boolean') return invalid('answer_chunk_proof');
      const bytes = new TextEncoder().encode(chunk.content).byteLength;
      const next = integer(chunk.next_offset);
      if (bytes > 131072 || next !== offset + bytes || (next <= offset && total !== 0) || next > total || chunk.complete !== (next === total)) return invalid('answer_chunk_cursor');
      content += chunk.content; offset = next;
    } while (offset < total);
  }
  if (new TextEncoder().encode(content).byteLength !== total || (digest !== null && await sha256(content) !== digest.toLowerCase())) return invalid('answer_digest');
  if (!current()) return invalid('obsolete');
  return content;
}

/** Validates legacy Run pools, preserving their namespace and execution-tip fields without vote inference. */
export function legacyPoolPage(value: unknown): Page<Record<string, unknown>> {
  const row = object(value);
  if (!Array.isArray(row.items) || typeof row.complete !== 'boolean') return invalid('legacy_pool_page');
  const items = row.items.map(value => { const pool = object(value); if (typeof pool.pool_id !== 'string' || typeof pool.goal !== 'string' || !['open', 'completed'].includes(String(pool.state)) || !Array.isArray(pool.members)) return invalid('legacy_pool'); return pool; });
  integer(row.offset); integer(row.limit);
  return { items, next: cursor(row.next_offset), total: integer(row.total), complete: row.complete, revision: null, observed: null, coverage: { complete: row.complete, offset: row.offset }, raw: row };
}
/** Validates standalone Pool inventory metadata; no source historical timestamp is invented. */
export function poolPage(value: unknown): Page<Record<string, unknown>> {
  const row = product(value, 'pool_page');
  if (!Array.isArray(row.pools) || typeof row.has_more !== 'boolean') return invalid('pool_page');
  const items = row.pools.map(value => { const entry = object(value); const pool = object(entry.pool); if (typeof pool.pool_id !== 'string' || typeof pool.name !== 'string' || typeof pool.purpose !== 'string' || typeof pool.closed !== 'boolean' || typeof entry.leader_id !== 'string') return invalid('pool_metadata'); integer(pool.revision); return entry; });
  return { items, next: row.has_more ? cursor(row.cursor) ?? invalid('pool_cursor') : null, total: null, complete: !row.has_more, revision: null, observed: null, coverage: { coverage: row.coverage, source_timestamp: row.source_timestamp, observed_at_unix_ms: row.observed_at_unix_ms }, raw: row };
}
/** Validates a versioned standalone detail and its authoritative current revision/section arrays. */
export function poolDetail(value: unknown): Record<string, unknown> {
  const row = product(value, 'pool_detail');
  if (row.view !== null) {
    const view = object(row.view); const pool = object(view.pool);
    if (typeof pool.pool_id !== 'string' || typeof pool.name !== 'string' || typeof pool.closed !== 'boolean' || !Array.isArray(view.members) || !Array.isArray(view.events) || !Array.isArray(view.deliveries) || typeof view.has_more !== 'boolean') return invalid('pool_view');
    integer(pool.revision); integer(view.next_after);
    for (const value of view.members) { const member = object(value); if (typeof member.member_id !== 'string' || typeof member.name !== 'string' || typeof member.role !== 'string' || typeof member.task !== 'string' || !['pending', 'active', 'removed'].includes(String(member.state))) return invalid('pool_member'); }
    for (const value of view.events) { const event = object(value); if (typeof event.event_id !== 'string' && typeof event.event_id !== 'number') return invalid('pool_event'); object(event.author); }
    for (const value of view.deliveries) { const delivery = object(value); if (typeof delivery.operation_id !== 'string' || typeof delivery.state !== 'string' || !['deliver', 'retire', 'start', 'start_batch', 'release_pin', 'replace'].includes(String(delivery.operation)) || delivery.operation === 'replace' && (typeof delivery.member_id !== 'string' || !delivery.member_id)) return invalid('pool_delivery'); }
    if (pool.proposal !== null) {
      const proposal = object(pool.proposal);
      if (typeof proposal.proposal_id !== 'string' || !Array.isArray(proposal.voters) || !['open', 'accepted', 'stale'].includes(String(proposal.state))) return invalid('pool_proposal');
      for (const value of Object.values(object(proposal.votes))) { const vote = object(value); if (!['ready', 'block', 'revoke'].includes(String(vote.choice))) return invalid('pool_vote'); }
    }
  }
  if (!Array.isArray(row.decisions) || typeof row.has_more !== 'boolean') return invalid('pool_detail');
  if (row.bindings !== undefined && row.bindings !== null) {
    if (!Array.isArray(row.bindings)) return invalid('pool_bindings');
    for (const value of row.bindings) { const binding = object(value); if (typeof object(binding.member).member_id !== 'string' || (binding.run_id !== null && typeof binding.run_id !== 'string')) return invalid('pool_binding'); if (binding.run_sequence !== null) integer(binding.run_sequence); }
  }
  return row;
}

/** Validates content-free Bridge projections before any row is rendered. */
export function bridgeData(value: unknown, kind: string): Record<string, unknown> {
  const row = product(value, kind);
  if (row.coverage !== 'retained_history') return invalid('bridge_coverage');
  if (kind === 'bridge_overview') {
    const counts = object(row.counts); const retention = object(row.retention);
    for (const key of ['unhanded', 'reserved', 'invoking', 'held', 'review', 'accepted', 'hook_submitted', 'refused', 'disposed', 'open_incidents']) integer(counts[key]);
    for (const key of ['events', 'payload_compacted', 'envelope_bytes']) integer(retention[key]);
    for (const key of ['oldest_accepted_at_ms', 'newest_accepted_at_ms']) if (retention[key] !== null) integer(retention[key]);
    return row;
  }
  const field = kind === 'delivery_page' ? 'deliveries' : 'incidents';
  if (!Array.isArray(row[field])) return invalid('bridge_page');
  integer(row.through_seq); if (row.next_after_seq !== null) integer(row.next_after_seq);
  for (const value of row[field]) {
    const item = object(value); integer(item[field === 'deliveries' ? 'acceptance_seq' : 'incident_seq']);
    if (typeof item.publisher !== 'string' || typeof item.event_id !== 'string') return invalid('bridge_row');
    if (field === 'deliveries' ? typeof item.custody_state !== 'string' || typeof item.delivery_state !== 'string' : typeof item.state !== 'string') return invalid('bridge_state');
  }
  return row;
}
/** Validates retained IDE snapshots without treating installation identity as daemon health. */
export function ideData(value: unknown): Record<string, unknown> {
  const row = product(value, 'ide_observation');
  if (row.product !== 'agent-ide' || !Array.isArray(row.instances)) return invalid('ide_schema');
  const checks = object(row.checks); object(row.repository);
  if (!Array.isArray(checks.snapshots) || !['available', 'unavailable'].includes(String(checks.availability))) return invalid('ide_checks');
  if (checks.next_cursor !== null) integer(checks.next_cursor);
  for (const value of row.instances) { const instance = object(value); if (typeof instance.instance_id !== 'string' || !['healthy', 'unavailable'].includes(String(instance.health)) || !['missing', 'private', 'unsafe', 'unavailable'].includes(String(instance.runtime))) return invalid('ide_instance'); }
  for (const value of checks.snapshots) { const snapshot = object(value); if (typeof snapshot.snapshot_id !== 'string' || typeof snapshot.source_path !== 'string' || !['stale', 'unknown'].includes(String(snapshot.freshness)) || typeof snapshot.rechecking !== 'boolean') return invalid('ide_snapshot'); if (snapshot.observed_at_ms !== null) integer(snapshot.observed_at_ms); }
  return row;
}

/** Strictly parses the Pool producer's documented decimal row-ID cursor, never a positional offset. */
export function decimalCursor(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return invalid('cursor_decimal');
  return integer(Number(value));
}
/** Validates legacy Run pool log/status attribution without fabricating entry timestamps. */
export function legacyPoolDetail(value: unknown, poolId: string): Record<string, unknown> {
  const row = object(value);
  if (row.pool_id !== poolId || !Array.isArray(row.entries) || typeof row.complete !== 'boolean') return invalid('legacy_pool_detail');
  integer(row.log_revision); integer(row.after_seq); integer(row.limit);
  if (row.before_seq !== null) integer(row.before_seq);
  if (row.next_cursor !== null) integer(row.next_cursor);
  const status = object(row.status); object(row.delivery);
  if (!['open', 'completed'].includes(String(status.state)) || typeof status.agreed !== 'boolean' || !Array.isArray(status.members) || !Array.isArray(status.replaced_members) || !Array.isArray(status.criteria)) return invalid('legacy_pool_status');
  integer(status.roster_revision);
  for (const value of status.members) { const member = object(value); if (typeof member.name !== 'string' || typeof member.role !== 'string' || (member.agent_id !== null && typeof member.agent_id !== 'string') || typeof member.counts !== 'boolean') return invalid('legacy_pool_member'); }
  let last = -1;
  for (const value of row.entries) { const entry = object(value); const seq = integer(entry.seq); if (seq <= last || !['member', 'operator', 'broker'].includes(String(entry.author_kind)) || !['team', 'orchestrator_copy'].includes(String(entry.direction)) || typeof entry.kind !== 'string') return invalid('legacy_pool_entry'); last = seq; }
  return row;
}

/** Canonical IDs remain untouched; list labels use confirmed directory names with short disambiguation. */
export function repositoryLabels(ids: string[]): Map<string, string> {
  const entries = [...new Set(ids)].sort().map(id => {
    const parts = id.replace(/\/+$/, '').split('/').filter(Boolean);
    let name = parts.pop() ?? id;
    if (name === '.git') name = parts.pop() ?? name;
    else name = name.replace(/\.git$/, '') || name;
    return { id, name, parent: parts.at(-1) ?? '' };
  });
  const result = new Map<string, string>();
  for (const entry of entries) {
    const peers = entries.filter(other => other.name === entry.name);
    const label = peers.length === 1 ? entry.name : entry.name + ' · ' + entry.parent;
    const duplicates = peers.filter(other => other.parent === entry.parent);
    result.set(entry.id, duplicates.length > 1 ? label + ' (' + (duplicates.findIndex(other => other.id === entry.id) + 1) + ')' : label);
  }
  return result;
}
/** Directory basename for a source-owned path; it is presentation, never a repository identity. */
export function basename(path: string): string { return path.replace(/\/+$/, '').split('/').filter(Boolean).at(-1) ?? path; }
/** Parses only the documented Tasks RFC3339 UTC clock, rejecting legacy labels and normalized invalid dates. */
export function reportObserved(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:00)$/.test(value)) return null;
  const date = new Date(value); return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 19) === value.slice(0, 19) ? date.toISOString() : null;
}
/** Parses only Tasks' decimal Unix-seconds completion clock; unknown/raw labels remain unreported. */
export function reportCompleted(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const seconds = Number(value); if (!Number.isSafeInteger(seconds)) return null;
  const date = new Date(seconds * 1000); return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
/** Validates cached quota observations; unknown/null never becomes zero or fresh capacity. */
export function limitsData(value: unknown): Record<string, unknown> {
  const row = object(value); if (!Array.isArray(row.items) || number(row.observed_at) === null) return invalid('limits_schema');
  for (const value of row.items) { const item = object(value); object(item.key); if (typeof item.known !== 'boolean' || number(item.observed_at) === null || (item.remaining_percent !== null && (number(item.remaining_percent) === null || Number(item.remaining_percent) < 0 || Number(item.remaining_percent) > 100))) return invalid('quota_window'); for (const key of ['reset_at', 'valid_until']) if (item[key] !== null && number(item[key]) === null) return invalid('quota_clock'); }
  return row;
}
/** Validates current cached model compatibility v2 without interpreting legacy schemas as capacity. */
export function modelsData(value: unknown): Record<string, unknown> {
  const row = object(value); if (row.schema_version !== 2 || !Array.isArray(row.providers) || !Array.isArray(row.profiles) || number(row.ranked_at) === null) return invalid('models_schema');
  for (const value of row.providers) { const provider = object(value); if (typeof provider.provider !== 'string' || !Array.isArray(provider.models)) return invalid('model_provider'); for (const value of provider.models) { const model = object(value); if (typeof model.model !== 'string' || !Array.isArray(model.profiles) || !model.profiles.every(profile => typeof profile === 'string') || typeof object(model.quota).status !== 'string') return invalid('model_compatibility'); } }
  return row;
}
/** Validates retained Tasks reports/plans independently, preserving missing/error/pending semantics. */
export function tasksData(value: unknown, common: string): Record<string, unknown> {
  const row = product(value, 'project_snapshot');
  if (row.error !== null) return invalid('tasks_error');
  if (row.repository !== null && object(row.repository).common_dir !== common) return invalid('repository_identity');
  if (!['missing', 'saved'].includes(String(row.plan_state)) || !['missing', 'saved'].includes(String(row.report_state))) return invalid('tasks_state');
  if (row.plan !== null) { const plan = object(row.plan); if (typeof plan.goal !== 'string' || !Array.isArray(plan.outcomes)) return invalid('tasks_plan'); for (const value of plan.outcomes) { const outcome = object(value); if (typeof outcome.id !== 'string' || typeof outcome.text !== 'string') return invalid('tasks_plan_outcome'); } }
  if (row.report !== null) {
    const report = object(row.report); const analysis = object(report.analysis); object(report.plan); object(report.coverage);
    if (typeof report.observed_at !== 'string' || typeof report.completed_at !== 'string' || !Array.isArray(analysis.outcomes) || !Array.isArray(analysis.findings)) return invalid('tasks_report');
    for (const value of analysis.outcomes) { const outcome = object(value); if (typeof outcome.id !== 'string' || !['no_evidence', 'in_progress', 'implemented', 'uncertain'].includes(String(outcome.state)) || typeof outcome.summary !== 'string' || (outcome.progress_percent !== null && (number(outcome.progress_percent) === null || Number(outcome.progress_percent) < 0 || Number(outcome.progress_percent) > 100))) return invalid('tasks_estimate'); if (!Array.isArray(object(outcome.evidence).items)) return invalid('tasks_evidence'); }
  }
  return row;
}

/** Current Run lifecycle values; future producer values remain explicit unknown source values. */
export const runStatuses = ['created', 'starting', 'running', 'cancelling', 'succeeded', 'failed', 'timed_out', 'cancelled', 'lost'] as const;
/** Finite current lifecycle type, independent of read/transport error outcomes. */
export type RunLifecycle = typeof runStatuses[number];
/** Only the four producer-defined nonterminal states count as active; no clock/silence heuristic. */
export function activeStatus(status: string): boolean { return status === 'created' || status === 'starting' || status === 'running' || status === 'cancelling'; }

/** A last-good observation stays dated by its producer, never silently replaced by fixtures. */
export interface Observation {
  /** Exact request identity, preventing stale selection content from flashing. */
  key: string;
  /** Latest native response, including errors. */
  response: ReadResponse | null;
  /** Last successful/partial native response for this exact request. */
  good: ReadResponse | null;
  /** Original rejected producer payload, retained only for explicitly folded diagnostic inspection. */
  rejected?: ReadResponse;
  /** Initial/manual read in progress; source data is not fabricated while loading. */
  loading: boolean;
}
/** Applies one actual source tick; recovery explicitly clears obsolete rejected-payload diagnostics. */
export function nextObservation(previous: Observation, envelope: ReadResponse, key: string, validate?: (value: unknown) => unknown): Observation {
  let value = envelope;
  let rejected: ReadResponse | undefined;
  if (usable(value) && validate) { try { validate(value.data); } catch { rejected = value; value = failure(envelope.resource, 'producer_schema'); } }
  return { key, response: value, good: usable(value) ? value : previous.key === key ? previous.good : null, loading: false, rejected };
}

/** Only explicit failure/lost/historical timeout or source-reported delivery ambiguity requires attention. */
export function attentionAgent(agent: RunAgent): boolean {
  if (agent.status === 'failed' || agent.status === 'lost' || agent.status === 'timed_out') return true;
  const delivery = agent.raw.delivery;
  return !!delivery && typeof delivery === 'object' && !Array.isArray(delivery) && object(delivery).ambiguous === true;
}
/** Recent-answer ordering uses only actual known terminal/progress clocks, never build/receipt/current time. */
export function recentAnswers(agents: RunAgent[]): RunAgent[] {
  return agents.filter(agent => agent.answerAvailable === true).sort((left, right) => {
    const a = left.finished ?? left.progress, b = right.finished ?? right.progress;
    return a === null ? b === null ? 0 : 1 : b === null ? -1 : b - a;
  });
}
