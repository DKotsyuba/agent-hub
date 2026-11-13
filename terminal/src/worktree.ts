/** Runtime-checked Worktree pages/details and workdir-based session links, for display only. */
import { object, product } from '../../src/live/protocol.ts';

/** One worktree row from a `worktree_page`. Unprobed values stay null, never guessed. */
export interface WorktreeRow {
  key: string; class: string; path: string | null; branch: string | null; detached: boolean | null; head: string | null;
  repoId: string | null; repoCommonDir: string | null; activity: string | null; mtimeBased: boolean; integration: string | null;
  removalStarted: boolean; creator: string | null;
}
/** One validated page with its continuation and coverage. */
export interface WorktreePage { rows: WorktreeRow[]; cursor: string | null; hasMore: boolean; coverage: Record<string, unknown>; hygiene: Record<string, unknown> }
/** One listed repository scope (null = every repository known to Worktree). */
export interface WorktreeGroup { repo: string | null; rows: WorktreeRow[]; coverage: Record<string, unknown> | null; partial: boolean; error: string | null }

/** Reads an optional string field. */
function str(value: unknown): string | null { return typeof value === 'string' && value ? value : null; }

/** Validates the configured repository list read from Hub's own configuration. */
export function repositoriesData(value: unknown): string[] {
  const rows = object(value).repositories;
  if (!Array.isArray(rows) || rows.some(row => typeof row !== 'string' || !row.startsWith('/'))) throw new Error('hub_repositories');
  return rows as string[];
}

/** Validates one `worktree_page` envelope. */
export function worktreePage(value: unknown): WorktreePage {
  const data = product(value, 'worktree_page');
  if (!Array.isArray(data.rows) || typeof data.has_more !== 'boolean') throw new Error('worktree_page');
  return {
    rows: data.rows.map(item => {
      const row = object(item), activity = row.activity === null || row.activity === undefined ? null : object(row.activity);
      if (typeof row.key !== 'string' || typeof row.class !== 'string') throw new Error('worktree_row');
      return {
        key: row.key, class: row.class, path: str(row.path), branch: str(row.branch), detached: typeof row.detached === 'boolean' ? row.detached : null, head: str(row.head),
        repoId: str(row.repo_id), repoCommonDir: str(row.repo_common_dir), activity: activity ? str(activity.state) : null, mtimeBased: activity?.mtime_based === true,
        integration: str(row.integration), removalStarted: row.removal_started === true, creator: str(row.creator),
      };
    }),
    cursor: str(data.cursor), hasMore: data.has_more,
    coverage: data.coverage && typeof data.coverage === 'object' && !Array.isArray(data.coverage) ? data.coverage as Record<string, unknown> : {},
    hygiene: data.hygiene && typeof data.hygiene === 'object' && !Array.isArray(data.hygiene) ? data.hygiene as Record<string, unknown> : {},
  };
}

/** Validates one `worktree_detail` envelope, keeping probes as reported. */
export function worktreeDetail(value: unknown): Record<string, unknown> {
  const data = product(value, 'worktree_detail');
  if (typeof data.key !== 'string' || !data.probes || typeof data.probes !== 'object') throw new Error('worktree_detail');
  return data;
}

/** Counts reported by the `status` probe: one entry per path and per staged/unstaged side. */
export interface StatusCounts { staged: number; unstaged: number; untracked: number; conflicts: number }
/** A probe axis that is either a value, still pending, or degraded with its code; never a guessed default. */
export type Measured<T> = { state: 'known'; value: T; lowerBound: boolean } | { state: 'unavailable' | 'not_checked'; code: string | null };
/** On-demand facts of one worktree read by `worktree.inspect` (status counts and size). */
export interface WorktreeFacts { status: Measured<StatusCounts>; size: Measured<number> }

/** Reads one non-negative integer, or null. */
function count(value: unknown): number | null { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null; }
/** Reads the probe `state`/`code` envelope of one axis. */
function axis(probes: Record<string, unknown>, name: string): { state: string; code: string | null; reason: string | null; value: unknown } {
  const item = probes[name];
  if (!item || typeof item !== 'object' || Array.isArray(item)) return { state: 'unknown', code: null, reason: null, value: null };
  const record = item as Record<string, unknown>;
  return { state: str(record.state) ?? 'unknown', code: str(record.code), reason: str(record.reason), value: record.value };
}
/** Extracts status counts and size from a validated `worktree_detail`; a degraded axis stays degraded. */
export function worktreeFacts(detail: Record<string, unknown>): WorktreeFacts {
  const probes = object(detail.probes), status = axis(probes, 'status'), size = axis(probes, 'size');
  const counts = status.value && typeof status.value === 'object' && !Array.isArray(status.value) ? status.value as Record<string, unknown> : null;
  const parts = counts ? [count(counts.staged), count(counts.unstaged), count(counts.untracked), count(counts.conflicts)] : [];
  const measuredStatus: Measured<StatusCounts> = (status.state === 'known' || status.state === 'incomplete') && parts.length === 4 && parts.every(part => part !== null)
    ? { state: 'known', value: { staged: parts[0]!, unstaged: parts[1]!, untracked: parts[2]!, conflicts: parts[3]! }, lowerBound: status.state === 'incomplete' }
    : { state: status.state === 'not_checked' ? 'not_checked' : 'unavailable', code: status.code ?? status.reason };
  const sized = size.value && typeof size.value === 'object' && !Array.isArray(size.value) ? size.value as Record<string, unknown> : null;
  const bytes = sized ? count(sized.bytes) : null;
  const measuredSize: Measured<number> = (size.state === 'known' || size.state === 'incomplete') && bytes !== null
    ? { state: 'known', value: bytes, lowerBound: size.state === 'incomplete' || sized?.quality === 'lower_bound' }
    : { state: size.state === 'not_checked' ? 'not_checked' : 'unavailable', code: size.code ?? size.reason };
  return { status: measuredStatus, size: measuredSize };
}

/** Strips the refs/heads/ prefix for display only. */
export function branchLabel(row: { branch: string | null; detached: boolean | null; head: string | null }): string {
  if (row.detached) return `detached ${row.head?.slice(0, 12) ?? 'Unknown'}`;
  return row.branch ? row.branch.replace(/^refs\/heads\//, '') : 'Unknown';
}

/** Returns the most specific listed worktree containing a workdir (longest path prefix). */
export function worktreeFor<T extends { path: string | null }>(workdir: string | null, rows: T[]): T | null {
  if (!workdir) return null;
  let best: T | null = null;
  for (const row of rows) {
    if (!row.path) continue;
    const root = row.path.replace(/\/+$/, '') || '/';
    if ((workdir === root || workdir.startsWith(root === '/' ? '/' : `${root}/`)) && (!best || root.length > best.path!.length)) best = row;
  }
  return best;
}

/** Sessions whose workdir resolves to this worktree, given every listed row for disambiguation. */
export function linkedSessions<A extends { workdir: string | null }>(row: WorktreeRow, rows: WorktreeRow[], agents: A[]): A[] {
  return agents.filter(agent => worktreeFor(agent.workdir, rows)?.key === row.key);
}

/** Formats one probe axis without collapsing degraded states into values. */
function probe(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'Unknown';
  const axis = value as Record<string, unknown>, state = str(axis.state) ?? 'unknown';
  if (state === 'not_checked') return 'not checked';
  if (state === 'unavailable') return `unavailable (${str(axis.code) ?? 'unknown'})`;
  const shown = axis.value === null || axis.value === undefined ? 'Unknown' : typeof axis.value === 'object' ? Object.entries(axis.value as Record<string, unknown>).map(([key, item]) => `${key}=${String(item)}`).join(' ') : String(axis.value);
  return state === 'incomplete' ? `${shown} (incomplete: ${str(axis.reason) ?? 'unknown'})` : shown;
}

/** Builds the inspect detail lines. */
export function detailLines(detail: Record<string, unknown>, now: number, measuredSize?: string): string[] {
  const probes = object(detail.probes), signals = detail.activity_signals && typeof detail.activity_signals === 'object' ? detail.activity_signals as Record<string, unknown> : null;
  const ago = (value: unknown) => typeof value === 'number' ? `${Math.max(0, Math.round((now - value) / 60))}m ago` : 'Unknown';
  const lines = [
    `Worktree ${String(detail.key)} (${str(detail.class) ?? 'Unknown'})`,
    `Path: ${str(detail.path) ?? 'Unknown'}`,
    `Branch: ${branchLabel({ branch: str(detail.branch), detached: typeof detail.detached === 'boolean' ? detail.detached : null, head: str(detail.head) })} · HEAD ${str(detail.head)?.slice(0, 12) ?? 'Unknown'}`,
    `Repository: ${str(detail.repo_common_dir) ?? 'Unknown'}`,
    `Activity: ${str(detail.activity) ?? 'Unknown'}${signals ? ` · HEAD ${ago(signals.head_mtime)} · index ${ago(signals.index_mtime)} · reflog ${ago(signals.last_reflog_entry)}` : ''}`,
  ];
  for (const axis of ['status', 'integration', 'processes', 'submodules', 'size']) lines.push(`${axis[0]!.toUpperCase()}${axis.slice(1)}: ${axis === 'size' && measuredSize ? `${measuredSize} (measured for the list)` : probe(probes[axis])}`);
  const warnings = Array.isArray(detail.warnings) ? detail.warnings.map(item => str(object(item).code) ?? 'unknown') : [];
  lines.push(`Warnings: ${warnings.length ? warnings.join(', ') : 'none'}`);
  const hygiene = detail.hygiene && typeof detail.hygiene === 'object' ? Object.entries(detail.hygiene as Record<string, unknown>).map(([key, value]) => `${key}=${String(value)}`).join(' ') : 'Unknown';
  lines.push(`Hygiene: ${hygiene}`);
  const record = detail.record && typeof detail.record === 'object' ? detail.record as Record<string, unknown> : null;
  lines.push(`Record: ${record ? Object.entries(record).filter(([, value]) => value === null || typeof value !== 'object').map(([key, value]) => `${key}=${String(value)}`).join(' ') : 'none (not managed by agent-worktree)'}`);
  lines.push(`Observed: ${ago(detail.observed_at)}`);
  return lines;
}
