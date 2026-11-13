/** Presentation model of the Worktree tab: one card per project with a block per worktree.
 * Pure and renderer-independent: it maps already validated list rows and on-demand facts (status counts, size)
 * to toned spans. Missing facts stay Unknown, a lower bound stays a lower bound, and nothing is guessed. */
import { fitSpans, leftRight, spansWidth, wrapCells } from './quota-view.ts';
import type { Row, Span } from './quota-view.ts';
import type { Tone } from './quota.ts';
import { branchLabel } from './worktree.ts';
import type { Measured, StatusCounts, WorktreeFacts, WorktreeGroup, WorktreeRow } from './worktree.ts';

/** A worktree at or above this size is flagged as large; this is agent-worktree's own warning threshold (2 GiB). */
export const LARGE_BYTES = 2 * 1024 ** 3;
/** Merge relation of one worktree to the merge target (the main checkout's branch). */
export type MergeState = 'merged' | 'not_merged' | 'unknown' | 'main';
/** Lifecycle of one on-demand inspection: still running, finished with facts, or failed with a code. */
export type FactsEntry = { state: 'pending' } | { state: 'ready'; facts: WorktreeFacts } | { state: 'failed'; code: string };
/** Run sessions linked to a worktree. */
export interface SessionCount { total: number; active: number }
/** A terminal row of the tab; `key` ties the rows of a worktree block to its selection and click target. */
export interface WorktreeRowView extends Row { key?: string }

/** Formats a byte count with binary multiples (1 GB = 1024³ bytes, like `du -h`): 0 B, 640 KB, 1.2 GB, 12 GB. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unknown';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let unit = 0, value = bytes / 1024;
  const round = (number: number) => number < 10 ? Math.round(number * 10) / 10 : Math.round(number);
  while (unit < units.length - 1 && round(value) >= 1024) { value /= 1024; unit++; }
  const rounded = round(value);
  return `${rounded < 10 ? rounded.toFixed(1) : String(rounded)} ${units[unit]}`;
}

/** Names a merge state as a badge text and tone. */
export function mergeBadge(state: MergeState): { text: string; tone: Tone } {
  if (state === 'merged') return { text: 'MERGED', tone: 'good' };
  if (state === 'not_merged') return { text: 'NOT MERGED', tone: 'warn' };
  if (state === 'main') return { text: 'MAIN', tone: 'muted' };
  return { text: 'UNKNOWN', tone: 'muted' };
}
/** Maps the producer's integration code to a merge state; the main checkout is the target itself and is never compared. */
export function mergeState(row: Pick<WorktreeRow, 'class' | 'integration'>): MergeState {
  if (row.class === 'main') return 'main';
  if (row.integration === 'ancestor_merged') return 'merged';
  if (row.integration === 'unmerged') return 'not_merged';
  return 'unknown';
}

/** Plain activity words for the producer's activity bands; the `~` marker is the mtime-based flag, not part of the band. */
export function activityWord(row: Pick<WorktreeRow, 'activity' | 'mtimeBased'>): { text: string; tone: Tone } | null {
  if (row.activity === null) return null;
  const state = row.activity.replace(/~$/, ''), estimated = row.mtimeBased || row.activity.endsWith('~');
  const word = state === 'active' ? { text: 'active', tone: 'good' as Tone }
    : state === 'recent' ? { text: 'recent', tone: 'text' as Tone }
    : state === 'idle_candidate' || state === 'idle' ? { text: 'idle', tone: 'muted' as Tone }
    : state === 'stale_candidate' || state === 'stale' ? { text: 'stale', tone: 'muted' as Tone }
    : null;
  if (!word) return { text: 'activity unknown', tone: 'muted' };
  return estimated && state !== 'active' ? { text: `${word.text} · mtime-based`, tone: word.tone } : word;
}

/** Summarized uncommitted changes of one worktree. */
export interface ChangeSummary { text: string; detail: string; tone: Tone; count: number | null; lowerBound: boolean; conflicts: number }
/** Total of changed paths; a path that is both staged and modified is counted on each side, as the producer reports it. */
export function changeCount(counts: StatusCounts): number { return counts.staged + counts.unstaged + counts.untracked + counts.conflicts; }
/** Plain breakdown of the status counts: modified (not yet staged), staged, new (untracked) and in conflict. */
export function changeDetail(counts: StatusCounts): string {
  const parts: string[] = [];
  if (counts.unstaged) parts.push(`${counts.unstaged} modified`);
  if (counts.staged) parts.push(`${counts.staged} staged`);
  if (counts.untracked) parts.push(`${counts.untracked} new`);
  if (counts.conflicts) parts.push(`${counts.conflicts} in conflict`);
  return parts.join(' · ');
}
/** Summarizes the status axis: clean, N changes with a breakdown, or an honest unknown. */
export function changeSummary(entry: FactsEntry | undefined): ChangeSummary {
  const unknown = (text: string): ChangeSummary => ({ text, detail: '', tone: 'muted', count: null, lowerBound: false, conflicts: 0 });
  if (!entry) return unknown('changes: queued');
  if (entry.state === 'pending') return unknown('changes: checking…');
  if (entry.state === 'failed') return unknown('changes unknown');
  const status: Measured<StatusCounts> = entry.facts.status;
  if (status.state !== 'known') return unknown(status.state === 'not_checked' ? 'changes: not checked' : 'changes unknown');
  const total = changeCount(status.value), bound = status.lowerBound ? '≥' : '';
  if (total === 0 && !status.lowerBound) return { text: 'clean', detail: '', tone: 'good', count: 0, lowerBound: false, conflicts: 0 };
  return { text: `${bound}${total} ${total === 1 ? 'change' : 'changes'}`, detail: changeDetail(status.value), tone: status.value.conflicts ? 'error' : 'warn', count: total, lowerBound: status.lowerBound, conflicts: status.value.conflicts };
}

/** Size of one worktree as text and tone; a lower bound keeps its ≥ and an unmeasured size is never zero. */
export interface SizeSummary { text: string; tone: Tone; bytes: number | null; lowerBound: boolean; large: boolean }
/** Summarizes the size axis. */
export function sizeSummary(entry: FactsEntry | undefined): SizeSummary {
  const none = (text: string): SizeSummary => ({ text, tone: 'muted', bytes: null, lowerBound: false, large: false });
  if (!entry) return none('size: queued');
  if (entry.state === 'pending') return none('size: measuring…');
  if (entry.state === 'failed') return none('size unknown');
  const size: Measured<number> = entry.facts.size;
  if (size.state !== 'known') return none(size.state === 'not_checked' ? 'size: not measured' : 'size unknown');
  const large = size.value >= LARGE_BYTES;
  return { text: `size ${size.lowerBound ? '≥' : ''}${formatBytes(size.value)}${large ? ' (large)' : ''}`, tone: large ? 'warn' : 'text', bytes: size.value, lowerBound: size.lowerBound, large };
}

/** One worktree prepared for display. */
export interface WorktreeView {
  key: string; row: WorktreeRow; repo: string | null; name: string; branch: string; path: string | null; isMain: boolean; present: boolean;
  merge: MergeState; mergeText: string; mergeTone: Tone; size: SizeSummary; changes: ChangeSummary;
  activity: { text: string; tone: Tone } | null; note: { text: string; tone: Tone } | null; sessions: SessionCount;
  /** 4 broken or in conflict, 3 not merged with uncommitted changes, 2 not merged, 1 large, unknown or dirty, 0 the rest. */
  attention: number;
}
/** One project (repository) prepared for display. */
export interface ProjectView {
  repo: string | null; name: string; path: string | null; target: string | null; worktrees: WorktreeView[];
  error: string | null; partial: boolean; attention: number; unmerged: number; withChanges: number;
  /** Worktrees with a folder to measure, how many of them have a size, and the total of those sizes. */
  expected: number; measured: number; sizeBytes: number; sizeLowerBound: boolean;
}

/** Last non-empty path segment. */
export function baseName(path: string): string { return path.replace(/\/+$/, '').split('/').pop() || path; }
/** The checkout directory behind a repository's common directory (`/x/repo/.git` → `/x/repo`); bare repositories keep their path. */
function repoPath(commonDir: string | null): string | null { return commonDir ? commonDir.replace(/\/\.git\/?$/, '') : null; }

/** Attention level of one worktree; see {@link WorktreeView.attention}. */
function attentionOf(row: WorktreeRow, merge: MergeState, changes: ChangeSummary, size: SizeSummary): number {
  if (row.class === 'missing' || row.class === 'orphan_candidate' || row.removalStarted || changes.conflicts > 0) return 4;
  if (merge === 'not_merged') return (changes.count ?? 0) > 0 ? 3 : 2;
  if (merge === 'main') return 0;
  return size.large || merge === 'unknown' || (changes.count ?? 0) > 0 ? 1 : 0;
}
/** Builds the view of one worktree row. */
export function worktreeView(row: WorktreeRow, repo: string | null, entry: FactsEntry | undefined, sessions: SessionCount): WorktreeView {
  const merge = mergeState(row), badge = mergeBadge(merge), present = row.class !== 'missing' && row.class !== 'orphan_candidate';
  const changes = changeSummary(present ? entry : undefined), size = sizeSummary(present ? entry : undefined);
  const note = row.removalStarted ? { text: 'removal started', tone: 'error' as Tone }
    : row.class === 'missing' ? { text: 'folder is missing on disk', tone: 'error' as Tone }
    : row.class === 'orphan_candidate' ? { text: 'folder without a Git registration', tone: 'error' as Tone } : null;
  return {
    key: row.key, row, repo, name: row.path ? baseName(row.path) : baseName(row.key), branch: branchLabel(row), path: row.path, isMain: row.class === 'main', present,
    merge, mergeText: badge.text, mergeTone: badge.tone, size, changes, activity: activityWord(row), note, sessions, attention: attentionOf(row, merge, changes, size),
  };
}
/** Orders worktrees: needs attention first, then larger, then by name; the main checkout closes its project. */
export function compareWorktrees(a: WorktreeView, b: WorktreeView): number {
  return Number(a.isMain) - Number(b.isMain) || b.attention - a.attention || (b.size.bytes ?? -1) - (a.size.bytes ?? -1) || a.name.localeCompare(b.name) || a.key.localeCompare(b.key);
}

/** A repository that could not be read ranks with unmerged work: above clean projects, below broken or conflicted worktrees. */
const ERROR_ATTENTION = 2;
/** Builds one project from its rows. */
function projectFrom(repo: string | null, rows: WorktreeRow[], group: WorktreeGroup | null, facts: ReadonlyMap<string, FactsEntry>, sessions: (row: WorktreeRow) => SessionCount): ProjectView {
  const views = rows.map(row => worktreeView(row, repo, facts.get(row.key), sessions(row))).sort(compareWorktrees);
  const main = rows.find(row => row.class === 'main');
  const path = repo ?? repoPath(rows.find(row => row.repoCommonDir)?.repoCommonDir ?? null);
  const present = views.filter(view => view.present), sized = present.filter(view => view.size.bytes !== null);
  return {
    repo, name: path ? baseName(path) : 'all repositories', path, target: main && !main.detached && main.branch ? branchLabel(main) : null,
    worktrees: views, error: group?.error ?? null, partial: !!group?.partial,
    attention: Math.max(group?.error ? ERROR_ATTENTION : 0, ...views.map(view => view.attention)), unmerged: views.filter(view => view.merge === 'not_merged').length, withChanges: views.filter(view => (view.changes.count ?? 0) > 0).length,
    expected: present.length, measured: sized.length, sizeBytes: sized.reduce((total, view) => total + view.size.bytes!, 0), sizeLowerBound: sized.length < present.length || sized.some(view => view.size.lowerBound),
  };
}
/** Builds every project card. Rows listed without a repository filter are split by repository; a repository with a read error keeps its card.
 * Projects needing attention come first, then more unmerged worktrees, then by name. */
export function projectViews(groups: WorktreeGroup[], facts: ReadonlyMap<string, FactsEntry>, sessions: (row: WorktreeRow) => SessionCount): ProjectView[] {
  const projects: ProjectView[] = [];
  for (const group of groups) {
    if (group.repo !== null || !group.rows.length) { projects.push(projectFrom(group.repo, group.rows, group, facts, sessions)); continue; }
    const byRepo = new Map<string, WorktreeRow[]>();
    for (const row of group.rows) { const id = row.repoCommonDir ?? row.repoId ?? ''; byRepo.set(id, [...byRepo.get(id) ?? [], row]); }
    for (const rows of byRepo.values()) projects.push(projectFrom(null, rows, { ...group, error: null }, facts, sessions));
    if (group.error) projects.push(projectFrom(null, [], group, facts, sessions));
  }
  return projects.sort((a, b) => b.attention - a.attention || b.unmerged - a.unmerged || a.name.localeCompare(b.name) || (a.path ?? '').localeCompare(b.path ?? ''));
}
/** Worktrees in display order across projects; this order drives selection and keyboard navigation. */
export function orderedWorktrees(projects: ProjectView[]): WorktreeView[] { return projects.flatMap(project => project.worktrees); }

/** Totals across every card, for the line above them. */
export interface TabSummary { projects: number; worktrees: number; measured: number; expected: number; sizeBytes: number; sizeLowerBound: boolean }
/** Totals across every card. */
export function tabSummary(projects: ProjectView[]): TabSummary {
  const sum = (pick: (project: ProjectView) => number) => projects.reduce((total, project) => total + pick(project), 0);
  return { projects: projects.length, worktrees: sum(project => project.worktrees.length), measured: sum(project => project.measured), expected: sum(project => project.expected), sizeBytes: sum(project => project.sizeBytes), sizeLowerBound: projects.some(project => project.sizeLowerBound) };
}
/** Plain-words summary and measuring progress of the whole tab. */
export function tabSummaryText(summary: TabSummary): string {
  const sizes = summary.expected === 0 ? '' : summary.measured === 0 ? ' · sizes not measured yet' : ` · ${summary.sizeLowerBound ? '≥' : ''}${formatBytes(summary.sizeBytes)} on disk${summary.measured < summary.expected ? ` (${summary.measured} of ${summary.expected} measured)` : ''}`;
  return `${summary.projects} ${summary.projects === 1 ? 'project' : 'projects'} · ${summary.worktrees} ${summary.worktrees === 1 ? 'worktree' : 'worktrees'}${sizes}`;
}

/** Card header summary: "3 worktrees · 2.1 GB · 1 unmerged · 2 with changes". */
export function projectSummary(project: ProjectView): Span[] {
  if (project.error) return [{ text: 'could not be read', tone: 'error', bold: true }];
  const spans: Span[] = [], count = project.worktrees.length, dot = () => spans.push({ text: ' · ', tone: 'muted' });
  spans.push({ text: `${count} ${count === 1 ? 'worktree' : 'worktrees'}`, tone: 'text' });
  if (project.expected > 0) {
    dot();
    if (project.measured === 0) spans.push({ text: 'size …', tone: 'muted' });
    else spans.push({ text: `${project.sizeLowerBound ? '≥' : ''}${formatBytes(project.sizeBytes)}`, tone: project.sizeBytes >= LARGE_BYTES ? 'warn' : 'text' });
  }
  const linked = project.worktrees.filter(view => !view.isMain);
  if (project.unmerged > 0) { dot(); spans.push({ text: `${project.unmerged} unmerged`, tone: 'warn', bold: true }); }
  else if (linked.length && linked.every(view => view.merge === 'merged')) { dot(); spans.push({ text: 'all merged', tone: 'good' }); }
  else if (linked.some(view => view.merge === 'unknown')) { dot(); spans.push({ text: 'merge state unknown', tone: 'muted' }); }
  if (project.withChanges > 0) { dot(); spans.push({ text: `${project.withChanges} with changes`, tone: 'warn' }); }
  if (project.partial) { dot(); spans.push({ text: 'partial', tone: 'warn' }); }
  return spans;
}

/** Indentation of the detail rows of a worktree block, aligned under its name. */
const INDENT = 4;
/** One unit of the detail rows; units are never split, only moved to the next row. */
interface Chip { spans: Span[]; glue: string }
/** The detail chips of one worktree: note, size, changes (with breakdown), activity and sessions. */
function chips(view: WorktreeView): Chip[] {
  const out: Chip[] = [];
  if (view.note) out.push({ spans: [{ text: view.note.text, tone: view.note.tone, bold: true }], glue: ' · ' });
  if (view.present) {
    out.push({ spans: [{ text: view.size.text, tone: view.size.tone, ...view.size.large ? { bold: true } : {} }], glue: ' · ' });
    out.push({ spans: [{ text: view.changes.text, tone: view.changes.tone, ...view.changes.tone === 'warn' || view.changes.tone === 'error' ? { bold: true } : {} }], glue: ' · ' });
    if (view.changes.detail) out.push({ spans: [{ text: `(${view.changes.detail})`, tone: 'muted' }], glue: ' ' });
  }
  if (view.activity) out.push({ spans: [{ text: view.activity.text, tone: view.activity.tone }], glue: ' · ' });
  if (view.sessions.total > 0) out.push({ spans: [{ text: `${view.sessions.total} ${view.sessions.total === 1 ? 'session' : 'sessions'}${view.sessions.active ? ` (${view.sessions.active} active)` : ''}`, tone: view.sessions.active ? 'good' : 'accent' }], glue: ' · ' });
  return out;
}
/** Flows chips across rows of `width` cells, starting each row at `indent`; a chip is moved whole, never split. */
export function flowChips(list: Chip[], width: number, indent: number): Span[][] {
  const rows: Span[][] = [];
  const start = (chip: Chip): Span[] => [{ text: ' '.repeat(indent), tone: 'text' }, ...chip.spans];
  let current: Span[] = [];
  for (const chip of list) {
    if (!current.length) { current = start(chip); continue; }
    const glue: Span = { text: chip.glue, tone: 'muted' };
    if (spansWidth([...current, glue, ...chip.spans]) <= width) current.push(glue, ...chip.spans);
    else { rows.push(fitSpans(current, width)); current = start(chip); }
  }
  if (current.length) rows.push(fitSpans(current, width));
  return rows;
}

/** Inner padding of a card. */
const PAD = 2;
/** Builds the rows of one worktree block (name row plus detail rows) inside `inner` cells. */
function worktreeBlock(view: WorktreeView, inner: number, selected: boolean): Span[][] {
  const badge: Span = { text: `[${view.mergeText}]`, tone: view.mergeTone, bold: true };
  const head: Span[] = [{ text: selected ? '› ' : '  ', tone: 'accent', bold: true }, { text: view.name, tone: 'text', bold: true }, ...view.isMain ? [{ text: '  main checkout', tone: 'muted' as Tone }] : [], { text: `  ${view.branch}`, tone: 'accent' }];
  return [...leftRight(head, [badge], inner), ...flowChips(chips(view), inner, INDENT)];
}
/** Clips a path from the left so its end (the part that tells projects apart) stays visible. */
function tail(path: string, width: number): string {
  const chars = Array.from(path);
  if (chars.length <= width) return path;
  return width <= 1 ? '…' : `…${chars.slice(chars.length - (width - 1)).join('')}`;
}
/** Builds the rows of one project card at `width` cells (including its padding). */
function projectRows(project: ProjectView, width: number, selectedKey: string | null): WorktreeRowView[] {
  const pad = width >= 12 ? PAD : 0, inner = Math.max(1, width - pad * 2), rows: WorktreeRowView[] = [];
  const card = (spans: Span[], key?: string) => rows.push({ spans: [...pad ? [{ text: ' '.repeat(pad), tone: 'text' as Tone }] : [], ...fitSpans(spans, inner)], card: true, ...key ? { key } : {} });
  const blank = (key?: string) => rows.push({ spans: [], card: true, ...key ? { key } : {} });
  blank();
  for (const spans of leftRight([{ text: project.name, tone: 'accent', bold: true }], projectSummary(project), inner)) card(spans);
  // The path is clipped from the left so the project directory stays visible; the merge target moves to its own row when both do not fit.
  const target = project.target ? `merge target: ${project.target}` : project.worktrees.length ? 'merge target unknown' : '';
  const room = inner - Array.from(target).length - 2, full = project.path ?? 'path unknown';
  if (!target) card([{ text: tail(full, inner), tone: 'muted' }]);
  else if (room >= Math.min(Array.from(full).length, 24)) for (const spans of leftRight([{ text: tail(full, room), tone: 'muted' }], [{ text: target, tone: 'muted' }], inner)) card(spans);
  else { card([{ text: tail(full, inner), tone: 'muted' }]); card([{ text: target, tone: 'muted' }]); }
  if (project.error) {
    blank();
    for (const [index, line] of wrapCells(`Worktree could not read this repository (${project.error}). A common cause is Git refusing a repository owned by another user (safe.directory). Press d for details.`, inner - 2, 4).entries()) card([{ text: index ? `  ${line}` : `! ${line}`, tone: 'error' }]);
  } else if (!project.worktrees.length) { blank(); card([{ text: 'No worktrees listed.', tone: 'muted' }]); }
  project.worktrees.forEach(view => {
    blank(view.key);
    for (const spans of worktreeBlock(view, inner, view.key === selectedKey)) card(spans, view.key);
  });
  blank();
  return rows;
}

/** Builds the Worktree tab body (without technical details) for a terminal of `width` cells. */
export function worktreeBody(projects: ProjectView[], width: number, selectedKey: string | null): WorktreeRowView[] {
  const plain = (text: string, tone: Tone): WorktreeRowView => ({ spans: fitSpans([{ text, tone }], width), card: false });
  const rows: WorktreeRowView[] = [];
  for (const project of projects) rows.push(plain('', 'muted'), ...projectRows(project, width, selectedKey));
  if (!projects.length) rows.push(plain('No repositories listed yet.', 'muted'));
  rows.push(plain('', 'muted'));
  for (const line of wrapCells('MERGED: the worktree HEAD is already contained in the merge target branch (squash merges are not detected). Activity is estimated from file times, not from running processes. Sizes are measured on demand and capped (≥ marks a lower bound). Ahead/behind counts are not available: agent-worktree does not report them.', width, 4)) rows.push(plain(line, 'muted'));
  return rows;
}

/** One technical-details line. */
export interface DetailLine { text: string; tone: Tone; bold?: boolean }
/** Describes one facts axis with its raw state and code. */
function rawAxis<T>(name: string, entry: FactsEntry | undefined, pick: (facts: WorktreeFacts) => Measured<T>, show: (value: T) => string): string {
  if (!entry) return `${name}=queued`;
  if (entry.state === 'pending') return `${name}=pending`;
  if (entry.state === 'failed') return `${name}=failed(${entry.code})`;
  const axis = pick(entry.facts);
  return axis.state === 'known' ? `${name}=${show(axis.value)}${axis.lowerBound ? ' (lower bound)' : ''}` : `${name}=${axis.state}${axis.code ? `(${axis.code})` : ''}`;
}
/** Raw producer codes behind the plain words, per worktree under its project, for the collapsed details view. */
export function technicalLines(groups: WorktreeGroup[], projects: ProjectView[], facts: ReadonlyMap<string, FactsEntry>): DetailLine[] {
  const lines: DetailLine[] = [];
  for (const project of projects) {
    lines.push({ text: `${project.name} · ${project.path ?? 'path Unknown'}`, tone: 'accent', bold: true });
    if (project.error) lines.push({ text: `  read error: ${project.error}`, tone: 'error' });
    for (const view of project.worktrees) {
      const row = view.row, entry = facts.get(row.key);
      lines.push({ text: `  ${row.key} class=${row.class} branch=${row.branch ?? 'Unknown'} head=${row.head?.slice(0, 12) ?? 'Unknown'}`, tone: 'text' });
      lines.push({ text: `    integration=${row.integration ?? 'null'} activity=${row.activity ?? 'null'}${row.mtimeBased ? ' (mtime_based)' : ''} ${rawAxis('size', entry, facts => facts.size, bytes => `${bytes} bytes`)} ${rawAxis('status', entry, facts => facts.status, counts => `staged:${counts.staged} unstaged:${counts.unstaged} untracked:${counts.untracked} conflicts:${counts.conflicts}`)}${row.removalStarted ? ' removal_started' : ''}`, tone: 'muted' });
    }
  }
  for (const group of groups) {
    const coverage = Object.entries(group.coverage ?? {}).filter(([, value]) => value === null || typeof value !== 'object').map(([key, value]) => `${key}=${String(value)}`).join(' ');
    lines.push({ text: `Coverage ${group.repo ?? 'all known'}: ${coverage || 'not reported'}${group.partial ? ' · partial' : ''}${group.error ? ` · error ${group.error}` : ''}`, tone: group.error ? 'error' : 'muted' });
  }
  return lines;
}
