/** Read-only terminal views over Run and Bridge observations. */
import { BoxRenderable, MacOSScrollAccel, TextRenderable, TextAttributes } from '@opentui/core';
import type { CliRenderer, KeyEvent, MouseEvent } from '@opentui/core';
import stringWidth from 'string-width';
import { exportHistory } from './export.ts';
import { exportExactHistory } from './export-exact.ts';
import { independentlyPartial } from './api.ts';
import { groupTranscript } from './transcript.ts';
import { groupPoolEvents, poolContentPage, poolFormerBinding, poolInventory, poolSection, poolWindow } from './pool.ts';
import { groupPools } from './pool-list.ts';
import { initialTaskCapability, initialTaskLabel, initialTaskScope, readInitialTask } from './initial-task.ts';
import type { InitialTaskRequest, InitialTaskResult } from './initial-task.ts';
import { INVENTORY_SNAPSHOT_CAPABILITY, inventorySnapshotPage, inventoryTotalsLines } from './pool-inventory.ts';
import type { InventoryPage } from './pool-inventory.ts';
import { parseRunStatus, runLineageLabel, runStatusRequest } from './run-status.ts';
import { parsePoolRunProof } from './pool-run-proof.ts';
import { agentWorkdir, projectRoot, sessionUsage } from './sessions.ts';
import type { PoolSection } from './pool.ts';
import type { Theme } from './preferences.ts';
import type { RunStatusEvidence, RunStatusRequest } from './run-status.ts';
import type { PoolRunProofTarget } from './pool-run-proof.ts';
import type { GroupedTranscript, TranscriptEntry } from './transcript.ts';
import {
  activeStatus, answerText, basename, bridgeData, collectPages, decimalCursor, failure,
  mergeBlocks, object, product, response, runAgent, runPage,
  supportsChunks, transcriptPage, usable,
} from '../../src/live/protocol.ts';
import type { Cursor, Page, RunAgent, TranscriptBlock } from '../../src/live/protocol.ts';
import type { AppMode, ObservationClient, ReadResponse, Resource } from './api.ts';
import { quotaLines, quotaSnapshot, quotaStatus } from './quota.ts';
import { barSpans, overviewRows, quotaRows } from './quota-view.ts';
import type { QuotaSnapshot, QuotaStatus, Tone } from './quota.ts';
import { detailLines, linkedSessions, repositoriesData, worktreeDetail as parseWorktreeDetail, worktreeFacts as parseWorktreeFacts, worktreePage } from './worktree.ts';
import { orderedWorktrees, projectViews, sizeSummary, tabSummary, tabSummaryText, technicalLines, worktreeBody } from './worktree-view.ts';
import type { FactsEntry, ProjectView } from './worktree-view.ts';
import type { WorktreeGroup, WorktreeRow } from './worktree.ts';
import { COMPLETION_CAPABILITY, COMPLETION_SECTIONS, completionIdFromEvents, completionPage, completionText } from './completion.ts';
import type { CompletionPage, CompletionSection } from './completion.ts';

/** One exact request's latest outcome and last usable, validated observation. */
interface Slot<T> { value: T | null; good: ReadResponse | null; response: ReadResponse | null; busy: boolean; generation: number }
/** Execution-scoped history and the reader's independent position. */
interface History {
  blocks: TranscriptBlock[]; grouped: GroupedTranscript; previous: Cursor | null; resume: Cursor | null; complete: boolean;
  headComplete: boolean; tailComplete: boolean; partial: boolean;
  response: ReadResponse | null; busy: boolean; loaded: boolean; follow: boolean; unseen: number;
  catchup: number;
  controller: AbortController | null;
  scroll: number; windowStart: number; windowEnd: number; windowSize: number; resultScroll: number; detailsScroll: number; anchor: { key: string; offset: number; row: number } | null; expanded: Set<string>; parts: Map<string, number>; selected: string | null;
  toolTimes: Map<string, { at: number | null; retryAt: number }>;
  wraps: Map<string, { content: string; width: number; lines: { text: string; offset: number }[] }>;
}
/** Reader-only coordinates carried to a newly fetched, uncorrelated lineage snapshot. */
interface HistoryPosition { beginning: boolean; follow: boolean; scroll: number; windowStart: number; windowEnd: number; startedAt: number }
/** A separately paged prefix; the live tail remains independent until the reader returns to it. */
interface Beginning { state: History; next: number | null; active: boolean; autoPages: number; width: number; height: number }
/** Buffered Agent Pool journal; source cursors and event IDs remain exact strings. */
interface PoolHistory { entries: Record<string, unknown>[]; previous: string | null; watermark: string; resume: string; loaded: boolean; busy: boolean; follow: boolean; unseen: number; response: ReadResponse | null }
/** Exact, on-demand evidence associated with one immutable vote event. */
interface PoolChecks { busy: boolean; rows: Record<string, unknown>[] | null; error: string | null }
/** Explicitly opened long source text, published only after every page is verified. */
interface PoolContent { field: 'purpose' | 'snapshot' | 'completion'; text: string | null; error: string | null; busy: boolean; previousScroll: number; controller: AbortController }
/** A complete answer exists only after source sequence and hash checks pass. */
interface Answer { executionKey: string; controller: AbortController | null; busy: boolean; loaded: boolean; content: string | null; issue: string | null; width: number; chunk: number; lines: Line[] | null }
/** A rendered line remembers the source block and character offset for stable scroll anchors. */
interface Line { text: string; color?: string; bg?: string; bold?: boolean; key?: string; offset?: number; action?: () => void; spinner?: boolean; hover?: string; spans?: { text: string; color: string; bold?: boolean }[] }
/** The immutable Pool member and exact Run status selector used for one navigation. */
/** One execution's exact initial-task read; text exists only after full length and SHA-256 verification. */
interface InitialTaskState { busy: boolean; controller: AbortController | null; result: InitialTaskResult | null; unsupported: boolean; lines: { width: number; rows: Line[] } | null }
interface BoundTarget { poolId: string; memberId: string; request: RunStatusRequest; key: string; poolObservedAtMs: number | null }
/** A correlated status observation or a deliberately weaker legacy inventory match. */
interface BoundObservation { targetKey: string; agent: RunAgent | null; evidence: RunStatusEvidence | null; legacy: boolean }
/** One selected Pool member's independently observed Run status. */
interface PoolStatusObservation { targetKey: string; evidence: RunStatusEvidence | null; source: 'pool' | 'run'; reason?: string; poolObservedAtMs?: number }
/** Page navigation stores source selection and focus without discarding underlying state. */
interface Location { route: Route; selected: string | null; boundSequence: number | null; boundTarget: BoundTarget | null; detailFromRelated: boolean; focus: Focus; tab: SessionTab; full: boolean; pool: string | null; poolTab: PoolTab; poolMetadata: boolean; poolCursor: number; poolRevision: number | null; poolPrevious: number[]; poolProposalId: string | null; poolScroll: number; poolMemberIndex: number; poolDeliveryIndex: number; poolDecisionIndex: number; poolVoteIndex: number; poolVoteMember: string | null; bridgeAfter: number; bridgeThrough: number | null; incidentScroll: number; query: string; filterFolder: string; filterProject: string; filterStatus: string; filterPeriodFailures: boolean; listTop: number; finishedOpen: boolean }
/** Current read-only destination. */
type Route = 'overview' | 'sessions' | 'pools' | 'quota' | 'worktree' | 'incidents';
/** Keyboard region within a session view. */
type Focus = 'list' | 'tabs' | 'history';
/** Selected session evidence kind. */
type SessionTab = 'history' | 'result' | 'details';
/** Selected independently paged Agent Pool evidence kind. */
type PoolTab = 'members' | 'discussion' | 'decisions' | 'criteria' | 'votes' | 'deliveries';
/** Local-calendar reporting period. */
type Period = 'Today' | 'Yesterday' | 'Last 7 days' | 'Last 30 days';
/** Local picker or text edit that temporarily owns keyboard input. */
interface Overlay { kind: 'help' | 'commands' | 'period' | 'folder' | 'status' | 'search' | 'theme'; query: string; index: number; original: string }

const darkColors = { bg: '#0a0a0a', header: '#141414', sidebar: '#141414', panel: '#141414', cell: '#202020', text: '#eeeeee', muted: '#a4a4a4', accent: '#5c9cf5', good: '#7fd88f', warn: '#e5c07b', error: '#e06c75', selected: '#242424', hover: '#202020', hoverSelected: '#343434', danger: '#211719', dangerSelected: '#302026' };
const lightColors = { bg: '#ffffff', header: '#f2f2f2', sidebar: '#f4f4f4', panel: '#fafafa', cell: '#ededed', text: '#1a1a1a', muted: '#595959', accent: '#2459a6', good: '#226d37', warn: '#8a5a00', error: '#a12932', selected: '#e1e1e1', hover: '#e8e8e8', hoverSelected: '#cecece', danger: '#fff0f0', dangerSelected: '#ffdede' };
const themes: Theme[] = ['system', 'dark', 'light'];
const periods: Period[] = ['Today', 'Yesterday', 'Last 7 days', 'Last 30 days'];
const sessionTabs: SessionTab[] = ['history', 'result', 'details'];
// OpenCode's standard spinner frames and 80 ms cadence.
const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const pollingIntervals = [1, 3, 5, 10] as const;
const poolTabs: PoolTab[] = ['members', 'discussion', 'decisions', 'criteria', 'votes', 'deliveries'];
const terminalStates = new Set(['succeeded', 'failed', 'timed_out', 'cancelled', 'lost']);
/** Bounds rendered line objects while retaining the complete hash-checked answer. */
const RESULT_CHUNK = 8192;
/** Worktree list/inspect reads spawn a helper per page; refresh them at most this often. */
const WORKTREE_REFRESH_MS = 15000;
/** Bounds one repository scope to 200 rows (10 pages of 20). */
const WORKTREE_PAGES = 10;
/** Status counts and sizes come from one bounded inspect per worktree; they are cached this long before the next lazy pass. */
const WORKTREE_FACTS_TTL_MS = 10 * 60 * 1000;
/** Minimum number of source blocks rendered per history window. */
const HISTORY_WINDOW = 8;
/** Bounds automatic prefetch when large fragments collapse into few visible rows. */
const HISTORY_FILL_PAGES = 32;
/** Keeps restoration from delaying status indefinitely when transcript I/O is slow. */
const HISTORY_RESTORE_MS = 5000;
/** Distinct anchor ranges keep annotations and separators separate from source text. */
const METADATA_OFFSET = 32 * 1024 * 1024, INCOMPLETE_OFFSET = 64 * 1024 * 1024, SEPARATOR_OFFSET = 96 * 1024 * 1024;
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' });

/** Replaces terminal commands and controls before any producer text reaches OpenTUI. */
function safe(value: unknown): string {
  const input = typeof value === 'string' ? value : value === null || value === undefined ? 'Unknown' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
  return input.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[PX^_][\s\S]*?\x1b\\|[@-_])?/g, '[control]')
    .replace(/\r\n/g, '\n').replace(/\t/g, '    ').replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '�');
}
/** Wraps source text by display cells and retains source offsets across resizing. */
function wrap(value: string, width: number): { text: string; offset: number }[] {
  const text = safe(value), result: { text: string; offset: number }[] = [];
  if (/^[\x20-\x7e\n]*$/.test(text)) {
    const columns = Math.max(1, width); let start = 0;
    while (start <= text.length) {
      const newline = text.indexOf('\n', start), end = newline < 0 ? text.length : newline;
      if (start === end) result.push({ text: '', offset: start });
      for (let index = start; index < end; index += columns) result.push({ text: text.slice(index, Math.min(index + columns, end)), offset: index });
      if (newline < 0) break; start = newline + 1;
    }
    return result;
  }
  let row = '', used = 0, start = 0;
  for (const part of segmenter.segment(text)) {
    if (part.segment === '\n') { result.push({ text: row, offset: start }); row = ''; used = 0; start = part.index + 1; continue; }
    const size = stringWidth(part.segment);
    if (used + size > Math.max(1, width) && row) { result.push({ text: row, offset: start }); row = ''; used = 0; start = part.index; }
    row += part.segment; used += size;
  }
  result.push({ text: row, offset: start });
  return result;
}
/** Wraps pool messages at word boundaries while retaining long words and whitespace. */
function wrapWords(value: string, width: number): string[] {
  const result: string[] = [], columns = Math.max(1, width);
  for (const line of safe(value).split('\n')) {
    let current = '';
    for (const part of wordSegmenter.segment(line)) {
      if (current && stringWidth(current + part.segment) > columns) { result.push(current); current = ''; }
      if (stringWidth(part.segment) > columns) {
        const pieces = wrap(part.segment, columns);
        result.push(...pieces.slice(0, -1).map(piece => piece.text));
        current = pieces.at(-1)?.text ?? '';
      } else current += part.segment;
    }
    result.push(current);
  }
  return result;
}
/** Clips single-line labels at cell boundaries with an explicit omission mark. */
function clip(value: unknown, width: number): string {
  if (width <= 0) return '';
  const text = safe(value).replace(/\n/g, ' ');
  if (stringWidth(text) <= width) return text;
  let out = '', used = 0;
  for (const part of segmenter.segment(text)) {
    const size = stringWidth(part.segment);
    if (used + size > width - 1) break;
    out += part.segment; used += size;
  }
  return out + '…';
}
/** Returns a bounded answer slice without splitting a UTF-16 surrogate pair. */
function resultChunk(content: string, index: number): string {
  let start = index * RESULT_CHUNK, end = Math.min(content.length, start + RESULT_CHUNK);
  if (start > 0 && /[\uDC00-\uDFFF]/.test(content[start]) && /[\uD800-\uDBFF]/.test(content[start - 1])) start--;
  if (end < content.length && /[\uDC00-\uDFFF]/.test(content[end]) && /[\uD800-\uDBFF]/.test(content[end - 1])) end--;
  return content.slice(start, end);
}
/** Counts display characters without joining potentially large streamed fragments. */
function segmentLength(segments: string[]): number { return segments.reduce((total, value) => total + value.length, 0); }
/** Slices a virtual concatenation without allocating its full contents. */
function segmentSlice(segments: string[], from: number, to: number): string {
  let position = 0, result = '';
  for (const value of segments) {
    const next = position + value.length;
    if (next > from && position < to) result += value.slice(Math.max(0, from - position), Math.min(value.length, to - position));
    position = next; if (position >= to) break;
  }
  return result;
}
/** Finds a part's source bounds without splitting a surrogate pair. */
function segmentBounds(segments: string[], index: number): [number, number] {
  const length = segmentLength(segments);
  let start = index * RESULT_CHUNK, end = Math.min(length, start + RESULT_CHUNK);
  const split = (at: number): boolean => { const pair = segmentSlice(segments, at - 1, at + 1); return pair.length === 2 && /[\uD800-\uDBFF]/.test(pair[0]) && /[\uDC00-\uDFFF]/.test(pair[1]); };
  if (start > 0 && split(start)) start--;
  if (end < length && split(end)) end--;
  return [start, end];
}
/** Returns a bounded slice across source fragments. */
function segmentChunk(segments: string[], index: number): string { const [start, end] = segmentBounds(segments, index); return segmentSlice(segments, start, end); }
/** Maps a sanitized display offset back to the corresponding unsanitized character. */
function sourceOffset(content: string, displayOffset: number): number {
  const pattern = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[PX^_][\s\S]*?\x1b\\|[@-_])?|\r\n|\t|[\x00-\x09\x0b-\x1f\x7f-\x9f]/g;
  let source = 0, displayed = 0;
  for (const match of content.matchAll(pattern)) {
    const start = match.index, plain = start - source;
    if (displayOffset < displayed + plain) return source + Math.max(0, displayOffset - displayed);
    displayed += plain;
    const replacement = match[0].startsWith('\x1b') ? '[control]' : match[0] === '\r\n' ? '\n' : match[0] === '\t' ? '    ' : '�';
    if (displayOffset < displayed + replacement.length) return start;
    displayed += replacement.length; source = start + match[0].length;
  }
  return Math.min(content.length, source + Math.max(0, displayOffset - displayed));
}
/** Maps an unsanitized character position to the equivalent displayed position. */
function displayOffset(content: string, sourceOffset: number): number {
  const pattern = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[PX^_][\s\S]*?\x1b\\|[@-_])?|\r\n|\t|[\x00-\x09\x0b-\x1f\x7f-\x9f]/g;
  let source = 0, displayed = 0;
  for (const match of content.matchAll(pattern)) {
    const start = match.index;
    if (sourceOffset <= start) return displayed + Math.max(0, sourceOffset - source);
    displayed += start - source;
    if (sourceOffset < start + match[0].length) return displayed;
    displayed += (match[0].startsWith('\x1b') ? '[control]' : match[0] === '\r\n' ? '\n' : match[0] === '\t' ? '    ' : '�').length;
    source = start + match[0].length;
  }
  return displayed + Math.max(0, Math.min(content.length, sourceOffset) - source);
}
/** Presents the known Codex file-change shape as paths and readable diff lines. */
function fileChanges(value: unknown): { text: string; preview: string } | null {
  const fields = object(value), changes = fields.changes;
  if (Object.keys(fields).some(key => key !== 'changes') || !Array.isArray(changes) || !changes.length) return null;
  const lines: string[] = [], previews: string[] = [];
  for (const change of changes) {
    if (!change || typeof change !== 'object' || Array.isArray(change)) return null;
    const item = object(change);
    if (Object.keys(item).some(key => !['path', 'kind', 'movePath', 'diff'].includes(key)) || typeof item.path !== 'string' || ['kind', 'movePath', 'diff'].some(key => item[key] !== undefined && typeof item[key] !== 'string')) return null;
    const label = `${typeof item.kind === 'string' ? item.kind : 'changed'}: ${item.path}${typeof item.movePath === 'string' ? ` → ${item.movePath}` : ''}`;
    previews.push(label); lines.push(label);
    if (typeof item.diff === 'string' && item.diff) lines.push(item.diff);
  }
  return { text: lines.join('\n'), preview: `${previews[0]}${previews.length > 1 ? ` · +${previews.length - 1} files` : ''}` };
}

/** Formats small structured arguments while retaining every reported input field. */
function toolInput(entry: TranscriptEntry): string[] {
  const segments = entry.calls.map(block => block.content);
  if (segmentLength(segments) > 65536) return segments;
  const content = segments.join('');
  try {
    const value: unknown = JSON.parse(content);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const changes = entry.head.raw.name === 'file_change' ? fileChanges(value) : null;
      if (changes) return [changes.text];
      const fields = Object.entries(value).map(([key, item]) => `${key}: ${typeof item === 'string' ? item : JSON.stringify(item)}`);
      if (fields.length) return [fields.join('\n')];
    }
  } catch { /* Incomplete or non-JSON arguments remain verbatim. */ }
  return [content];
}
/** Decodes intact text-only MCP results while preserving other payloads verbatim. */
function toolOutput(entry: TranscriptEntry): string[] {
  const blocks = entry.results.length ? entry.results : entry.head.role === 'tool' ? [entry.head] : [];
  const segments = blocks.map(block => block.content);
  if (segmentLength(segments) > 65536) return segments;
  const content = segments.join('');
  if (!content.trimStart().startsWith('[')) return [content];
  try {
    const parsed: unknown = JSON.parse(content);
    if (Array.isArray(parsed) && parsed.length && parsed.every(value => value && typeof value === 'object' && !Array.isArray(value) && object(value).type === 'text' && typeof object(value).text === 'string')) return [parsed.map(value => object(value).text).join('\n')];
  } catch { /* An incomplete or non-JSON result remains verbatim. */ }
  return [content];
}
/** Selects a useful command or argument within the available display width. */
function toolPreview(entry: TranscriptEntry, width: number): string {
  if (!entry.calls.length) return '';
  const segments = entry.calls.map(block => block.content);
  if (segmentLength(segments) > 65536) return clip(segments[0], width);
  const content = segments.join('');
  try {
    const value: unknown = JSON.parse(content), fields = object(value);
    const changes = entry.head.raw.name === 'file_change' ? fileChanges(value) : null;
    if (changes) return clip(changes.preview, width);
    for (const key of ['command', 'cmd', 'file_path', 'pattern', 'path', 'skill', 'prompt', 'description']) if (typeof fields[key] === 'string') return clip(fields[key], width);
  } catch { /* Use the original arguments when they are not complete JSON. */ }
  return clip(content, width);
}
/** Formats source epoch seconds without replacing absent clocks with local receipt time. */
function stamp(seconds: number | null): string { return seconds === null || !Number.isFinite(seconds) || !Number.isFinite(new Date(seconds * 1000).getTime()) ? 'Not reported' : new Date(seconds * 1000).toLocaleString(); }
/** Formats a reported source time compactly without inventing a missing clock. */
function timeOnly(seconds: number | null): string { return seconds === null || !Number.isFinite(seconds) || !Number.isFinite(new Date(seconds * 1000).getTime()) ? 'time unknown' : new Date(seconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
/** Formats an observed tool timestamp in local time with second precision. */
function toolTime(seconds: number | null): string { return seconds === null || !Number.isFinite(seconds) || !Number.isFinite(new Date(seconds * 1000).getTime()) ? '--:--:--' : new Date(seconds * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); }
/** Identifies a projected result whose final row needs its own source clock. */
function multiResultSequence(block: TranscriptBlock): number | null {
  const first = block.raw.first_seq, last = block.raw.last_seq;
  return typeof first === 'number' && Number.isSafeInteger(first) && first >= 0 && typeof last === 'number' && Number.isSafeInteger(last) && last === block.seq && last > first ? last : null;
}
/** Keys immutable source-time evidence by the exact result identity. */
function resultTimeKey(block: TranscriptBlock): string { return JSON.stringify([block.seq, block.raw.raw_ref ?? null, block.raw.name ?? null, block.raw.error ?? null, block.raw.error_source ?? null]); }
/** Formats a source-reported duration at its own observation time. */
function duration(seconds: number | null): string { if (seconds === null || seconds < 0) return 'Unknown'; const n = Math.floor(seconds); return n < 60 ? `${n}s` : n < 3600 ? `${Math.floor(n / 60)}m ${n % 60}s` : `${Math.floor(n / 3600)}h ${Math.floor(n % 3600 / 60)}m`; }
/** Presents known lifecycle values without rewriting unfamiliar producer states. */
function lifecycle(value: string): string { return activeStatus(value) || terminalStates.has(value) ? value[0].toUpperCase() + value.slice(1).replaceAll('_', ' ') : value; }
/** Formats a source value without treating missing values as false or zero. */
function shown(value: unknown): string { return value === undefined || value === null || value === '' ? 'Unknown' : safe(value); }
/** Labels the requested effort without inventing an effective runtime value. */
function reasoning(effort: string | null): string { return `reasoning ${effort?.trim() ? safe(effort).replace(/\n/g, ' ') : '—'}`; }
/** Uses the available sidebar width before moving metadata onto neighboring rows. */
function sessionRows(agent: RunAgent, width: number, action: string): [string, string, string] {
  const status = safe(lifecycle(agent.status)).replace(/\n/g, ' '), model = shown(agent.model).replace(/\n/g, ' ');
  const effort = reasoning(agent.effort), elapsed = duration(agent.elapsed), folder = safe(agent.workdir ? basename(agent.workdir) : 'Folder unknown').replace(/\n/g, ' ');
  const actionText = safe(action).replace(/\n/g, ' ');
  const line = (...parts: string[]) => `  ${parts.join(' · ')}`;
  const layouts: [string, string, string][] = [
    [line(status, model, effort, elapsed), line(folder), line(actionText)],
    [line(status, model, effort), line(elapsed, folder), line(actionText)],
    [line(status, model), line(effort, folder), line(elapsed, actionText)],
    [line(status, model), line(folder), line(effort, elapsed, actionText)],
    [line(status, model), line(effort), line(elapsed, folder, actionText)],
    [line(model, effort), line(status, folder), line(elapsed, actionText)],
    [line(model), line(status, effort, elapsed), line(folder, actionText)],
    [line(model), line(status, effort, folder), line(elapsed, actionText)],
  ];
  return layouts.find(rows => rows.every(row => stringWidth(row) <= width)) ?? (stringWidth(line(status, model)) <= width ? layouts[2] : layouts[6]);
}
/** Builds local calendar boundaries rather than assuming days are exactly 24 hours. */
function bounds(period: Period, now: number): [number, number] {
  const current = new Date(now), start = new Date(current.getFullYear(), current.getMonth(), current.getDate());
  if (period === 'Yesterday') { const end = start.getTime(); start.setDate(start.getDate() - 1); return [start.getTime(), end]; }
  if (period === 'Last 7 days') start.setDate(start.getDate() - 6);
  if (period === 'Last 30 days') start.setDate(start.getDate() - 29);
  return [start.getTime(), now];
}
/** Creates an empty last-good observation slot. */
function slot<T>(): Slot<T> { return { value: null, good: null, response: null, busy: false, generation: 0 }; }
/** Creates an independent execution history with follow initially enabled. */
function history(): History { return { blocks: [], grouped: groupTranscript([]), previous: null, resume: null, complete: false, headComplete: false, tailComplete: false, partial: false, response: null, busy: false, loaded: false, follow: true, unseen: 0, catchup: 0, controller: null, scroll: 0, windowStart: 0, windowEnd: 0, windowSize: 0, resultScroll: 0, detailsScroll: 0, anchor: null, expanded: new Set(), parts: new Map(), selected: null, toolTimes: new Map(), wraps: new Map() }; }
/** Run failures caused by socket placement, ownership or session group credentials. */
const RUN_ACCESS_CODES = new Set(['run_endpoint', 'run_endpoint_identity', 'run_endpoint_parent', 'run_connect', 'run_peer_identity', 'run_broker_socket_required', 'run_session_socket_absolute', 'run_session_broker_uid', 'config_read', 'config_json', 'config_absolute', 'config_version']);
/** Returns an operator hint for a Run access failure, or an empty string. */
export function runAccessHint(code: string | undefined): string {
  return code && RUN_ACCESS_CODES.has(code) ? ' · check Run socket (connections.json run.socket / --socket) and agent-run group (`id`)' : '';
}
/** Describes a source snapshot, including failure code and any retained last-good data. */
function notice<T>(state: Slot<T>): string {
  if (state.busy && !state.good) return 'Loading observations…';
  if (!state.response) return 'Not observed';
  const code = state.response.error?.code;
  const status = state.response.outcome === 'ok' || state.response.outcome === 'partial' && !independentlyPartial(state.response) ? 'Available' : state.response.outcome === 'partial' ? 'Partial response' : `${state.response.outcome}${code ? ` [${safe(code)}]` : ''}: ${safe(state.response.error?.message ?? 'Read failed')}${state.response.source === 'run' ? runAccessHint(code) : ''}`;
  const receipt = state.good ? `received ${stamp(state.good.observed_at_ms / 1000)}${state.response !== state.good ? ' · last good' : ''}` : 'no usable observation';
  return `${status} · ${receipt}`;
}

/** Mounts the read-only hub; its disposer aborts reads, timers and input listeners. */
export function mountHub(renderer: CliRenderer, client: ObservationClient, mode: AppMode, onQuit: () => void, preferences?: { theme: Theme; save: (theme: Theme) => Promise<void> }, start?: { pool?: string; project?: string }): () => void {
  let alive = true, frame: BoxRenderable | null = null, route: Route = start?.pool ? 'pools' : start?.project ? 'sessions' : 'overview', focus: Focus = 'list';
  let pendingPaint: number | null = null;
  const retiredFrames = new Set<BoxRenderable>();
  let pointer: { x: number; y: number } | null = null;
  let theme = preferences?.theme ?? 'system', C = theme === 'light' || theme === 'system' && renderer.themeMode === 'light' ? lightColors : darkColors;
  let selected: string | null = null, boundSequence: number | null = null, tab: SessionTab = 'history', full = false, previousFocus: Focus = 'list';
  let boundTarget: BoundTarget | null = null;
  let pool: string | null = start?.pool ?? null, poolTab: PoolTab = 'members', poolMetadata = false, period: Period = 'Today', overlay: Overlay | null = null;
  let listTop = 0, poolIndex = 0, poolMemberIndex = 0, poolDeliveryIndex = 0, poolDecisionIndex = 0, poolVoteIndex = 0, poolVoteMember: string | null = null, poolScroll = 0, quotaScroll = 0, quotaDetails = false, incidentScroll = 0, attentionIndex = 0;
  let revealPoolSelection = false, poolSelectionShown = false;
  let finishedOpen = false, filterFolder = '', filterProject = start?.project ?? '', filterStatus = '', filterPeriodFailures = false, query = '', alert = '';
  let detailFromRelated = false, spinnerFrame = 0;
  let rawTranscript = false;
  let toolTimeRequest: { key: string; controller: AbortController } | null = null, toolTimeRetryAt = 0, historyViewportRendered = false;
  const wheelAcceleration = new MacOSScrollAccel();
  let wheelState: History | null = null, wheelDirection = 0, wheelRemainder = 0, queuedWheel: { state: History; rows: number } | null = null;
  let waitingWheel: { beginning: Beginning; rows: number } | null = null;
  let pollingIndex = 1, pollingTimer: ReturnType<typeof setInterval> | null = null;
  let spinnerRows: { text: TextRenderable; value: string }[] = [];
  let copyController: AbortController | null = null;
  let exactCopyExecution: string | null = null;
  let poolMemberRead: AbortController | null = null;
  let formerDeliveryKey: string | null = null;
  let poolStatusRead: AbortController | null = null, poolStatusKey = '', poolStatusRetryAt = 0;
  let relatedRead: AbortController | null = null;
  let uncorrelatedObservation = 0;
  let directStatus: boolean | null = null, relatedNextScan = 0;
  let agentPages = 1, poolPages = 1, poolCursor = 0, poolRevision: number | null = null, poolPrevious: number[] = [];
  let poolProposalId: string | null = null;
  let poolContent: PoolContent | null = null;
  let bridgeAfter = 0, bridgeThrough: number | null = null;
  let poolRequestKey = '', poolProposalKey = '', incidentRequestKey = '';
  let backStack: Location[] = [], forwardStack: Location[] = [];
  const controllers = new Set<AbortController>();
  const poolPositions = new Map<string, number>();
  const poolPaging = new Map<string, { cursor: number; revision: number | null; previous: number[] }>();
  const agents = slot<Page<RunAgent>>(), activeAgents = slot<Page<RunAgent>>(), relatedAgent = slot<BoundObservation>(), pools = slot<Page<Record<string, unknown>>>(), poolDetail = slot<Record<string, unknown>>();
  const poolStatus = slot<PoolStatusObservation>();
  const poolProposal = slot<Record<string, unknown>>();
  const poolIdentity = slot<Record<string, unknown>>();
  const poolTotals = slot<InventoryPage>();
  const bridge = slot<Record<string, unknown>>(), deliveries = slot<Record<string, unknown>>(), incidentMetric = slot<Record<string, unknown>>(), incidents = slot<Record<string, unknown>>();
  const quota = slot<QuotaSnapshot>(), quotaService = slot<QuotaStatus>();
  const repositories = slot<string[]>(), worktreeInspect = slot<Record<string, unknown>>();
  let worktreeGroups: WorktreeGroup[] = [], worktreesBusy = false, worktreesLoadedAt = 0, worktreeGeneration = 0, worktreeIndex = 0, worktreeScroll = 0;
  let worktreeOpen: { row: WorktreeRow; repo: string } | null = null, worktreeSessionIndex = 0, worktreeInspectKey = '', worktreeInspectAt = 0;
  let worktreeKey: string | null = null, worktreeDetails = false, worktreeFactsBusy = false;
  const worktreeFacts = new Map<string, FactsEntry>(), worktreeFactsAt = new Map<string, number>();
  const histories = new Map<string, History>(), beginnings = new Map<string, Beginning>(), answers = new Map<string, Answer>(), initialTasks = new Map<string, InitialTaskState>();
  const historyPositions = new WeakMap<History, HistoryPosition>();
  const relatedKeys = new WeakMap<RunAgent, string>();
  const poolHistories = new Map<string, PoolHistory>();
  const poolChecks = new Map<string, PoolChecks>();
  const poolEventCache = new Map<string, { parts: Record<string, unknown>[]; complete: boolean; lines: Line[] }>();

  /** Calls only a fixed read resource and validates the native response envelope. */
  async function read(resource: Resource, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<ReadResponse> {
    const controller = new AbortController(); controllers.add(controller);
    const abort = () => controller.abort();
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    try { return response(await client.read(resource, params, controller.signal), resource) as ReadResponse; }
    catch { return failure(resource, controller.signal.aborted ? 'cancelled' : 'renderer_read') as ReadResponse; }
    finally { signal?.removeEventListener('abort', abort); controllers.delete(controller); }
  }
  /** Falls back to raw pages only after a correlated broker rejection of block options. */
  async function readTranscript(params: Record<string, unknown>, signal?: AbortSignal): Promise<{ envelope: ReadResponse; raw: boolean; cursor: number }> {
    const cursor = typeof params.cursor === 'number' ? params.cursor : 0;
    const raw = () => read('run.transcript', { agent_id: params.agent_id, cursor, limit: typeof params.limit === 'number' ? params.limit : 1000 }, signal);
    if (rawTranscript) return { envelope: await raw(), raw: true, cursor };
    const envelope = await read('run.transcript', params, signal);
    if (!signal?.aborted && envelope.error?.code === 'run_blocks_unsupported') { rawTranscript = true; return { envelope: await raw(), raw: true, cursor }; }
    return { envelope, raw: false, cursor };
  }
  /** Reads one exact raw result row when a projected block lacks its final timestamp. */
  function requestVisibleToolTime(): void {
    const agent = route === 'sessions' && tab === 'history' && historyViewportRendered ? selectedAgent() : null;
    const identity = agent ? executionKey(agent) : null;
    if (toolTimeRequest && toolTimeRequest.key !== identity) toolTimeRequest.controller.abort();
    if (!alive || toolTimeRequest || Date.now() < toolTimeRetryAt || !agent || overlay) return;
    const state = currentHistory(); if (!state) return;
    const visible = new Set(historyLines.slice(state.scroll, state.scroll + historyHeight).filter(line => line.text.trim()).map(line => line.key === undefined ? undefined : state.grouped.byKey.get(line.key)));
    for (const index of visible) {
      const entry = index === undefined ? undefined : state.grouped.entries[index]; if (!entry) continue;
      const result = entry.calls.length ? entry.results.at(-1) : undefined;
      if (!result || state.grouped.partialAfter.has(result.key)) continue;
      const sequence = multiResultSequence(result); if (sequence === null) continue;
      const key = resultTimeKey(result), cached = state.toolTimes.get(key);
      if (cached && (cached.at !== null || Date.now() < cached.retryAt)) continue;
      const request = { key: executionKey(agent), controller: new AbortController() }; toolTimeRequest = request;
      void (async () => {
        let at: number | null = null;
        const envelope = await read('run.transcript', { agent_id: agent.id, view: 'raw', cursor: sequence - 1, limit: 1 }, request.controller.signal);
        if (alive && !request.controller.signal.aborted && (!usable(envelope) || envelope.error !== null)) toolTimeRetryAt = Date.now() + 30000;
        if (usable(envelope) && envelope.error === null) {
          try {
            const page = transcriptPage(envelope.data, agent.id), row = page.blocks[0];
            const matches = page.raw.cursor === sequence - 1 && (page.raw.view == null || page.raw.view === 'raw') && page.blocks.length === 1 && row.seq === sequence && row.role === 'tool_result' && row.raw.first_seq == null && row.raw.last_seq == null && (row.raw.name ?? null) === (result.raw.name ?? null) && (row.raw.raw_ref ?? null) === (result.raw.raw_ref ?? null) && (row.raw.error ?? null) === (result.raw.error ?? null) && (row.raw.error_source ?? null) === (result.raw.error_source ?? null);
            if (matches && toolTime(row.at) !== '--:--:--') at = row.at;
          } catch { /* A missing or mismatched raw row cannot establish an end time. */ }
        }
        if (alive && !request.controller.signal.aborted && (histories.get(executionKey(agent)) === state || beginnings.get(executionKey(agent))?.state === state)) state.toolTimes.set(key, { at, retryAt: at === null ? Date.now() + 30000 : Infinity });
      })().finally(() => { if (toolTimeRequest === request) toolTimeRequest = null; if (alive) render(); });
      return;
    }
  }
  /** Updates one request slot without overlapping a slow read or losing last-good data. */
  async function observe<T>(state: Slot<T>, resource: Resource, params: Record<string, unknown>, parse: (value: unknown) => T): Promise<void> {
    if (!alive || state.busy) return; state.busy = true; const generation = ++state.generation; render();
    const envelope = await read(resource, params);
    if (!alive || generation !== state.generation) return;
    state.response = envelope;
    if (usable(envelope)) { try { state.value = parse(envelope.data); state.good = envelope; } catch { state.response = failure(resource, 'producer_schema') as ReadResponse; } }
    state.busy = false; render();
  }
  /** Returns the source-advertised journal capability, never guessing after a failed identity read. */
  function poolCapability(name: string): boolean | null {
    if (!poolIdentity.good || poolIdentity.response !== poolIdentity.good || !poolIdentity.value) return null;
    return (poolIdentity.value.capabilities as unknown[]).includes(name);
  }
  /** Identifies the exact journal-window contract rather than assuming support. */
  function poolHistorySupported(): boolean | null { return poolCapability('history_window_v1'); }
  /** Returns one independently buffered pool journal. */
  function poolHistory(id: string): PoolHistory {
    let state = poolHistories.get(id);
    if (!state) {
      if (poolHistories.size >= 4) { const expired = [...poolHistories].find(([key, value]) => key !== id && !value.busy); if (expired) poolHistories.delete(expired[0]); }
      state = { entries: [], previous: null, watermark: '0', resume: '0', loaded: false, busy: false, follow: true, unseen: 0, response: null }; poolHistories.set(id, state);
    }
    return state;
  }
  /** Formats journal events without interpreting current roster names as historical author names. */
  function poolEventLines(entries: Record<string, unknown>[], width: number): Line[] {
    const lines: Line[] = [];
    for (const group of groupPoolEvents(entries)) {
      const entry = group.head;
      const key = JSON.stringify([width, C.panel, C.muted, entry.event_id_exact ?? entry.event_id]);
      const cached = poolEventCache.get(key);
      if (cached && cached.complete === group.complete && cached.parts.length === group.parts.length && cached.parts.every((part, index) => part === group.parts[index])) { lines.push(...cached.lines); continue; }
      const author = object(entry.author), authorLabel = author.kind === 'member' ? `member ${shown(author.member_id)}` : shown(author.kind);
      const part = group.complete ? '' : ` · incomplete message (${shown(entry.part_index)}–${shown(group.parts.at(-1)?.part_index)}/${shown(entry.part_count)})`;
      const rendered: Line[] = [{ text: '', bg: C.panel }];
      addWrapped(rendered, `  ${authorLabel} · #${shown(entry.message_event_id ?? entry.event_id_exact ?? entry.event_id)} · ${shown(entry.kind)}${part} · revision ${shown(entry.revision)}${entry.recipient ? ` · to ${shown(entry.recipient)}` : ''}`, width, { bg: C.panel, color: C.muted, bold: true });
      for (const line of wrapWords(group.parts.map(value => String(value.body ?? '')).join(''), width - 4)) rendered.push({ text: `  ${line}`, bg: C.panel });
      rendered.push({ text: '', bg: C.panel }, { text: '' });
      if (poolEventCache.size >= 1000) poolEventCache.clear();
      poolEventCache.set(key, { parts: group.parts, complete: group.complete, lines: rendered }); lines.push(...rendered);
    }
    return lines;
  }
  /** Reads the newest journal page, or catches up from the last accepted exact ID. */
  async function refreshPoolHistory(id: string): Promise<void> {
    const state = poolHistory(id);
    if (!alive || state.busy || state.loaded && !state.follow && state.entries.length >= 500) return;
    state.busy = true;
    try {
      if (!state.loaded) {
        const response = await read('pool.get', { pool_id: id, section: 'history', direction: 'backward' });
        if (!alive || poolHistories.get(id) !== state) return;
        state.response = response;
        if (!usable(response)) return;
        const page = poolWindow(response.data, id, 'backward', null, null);
        if (page.entries.length ? page.entries.at(-1)?.event_id_exact !== page.watermark : page.watermark !== '0') throw new Error('pool_history_tail');
        state.entries = page.entries; state.previous = page.more ? page.cursor : null; state.watermark = page.watermark; state.resume = page.watermark; state.loaded = true;
        if (state.follow && route === 'pools' && pool === id && poolTab === 'discussion') poolScroll = Number.MAX_SAFE_INTEGER;
        // The producer returns at most three events per page. Fill the visible area from older pages.
        const width = renderer.width >= 110 ? Math.floor((renderer.width - 6) * 0.64) : renderer.width - 4;
        for (let pages = 0; pages < 32 && state.previous && pool === id && route === 'pools' && poolTab === 'discussion' && poolEventLines(state.entries, width).length < Math.max(1, renderer.height - 12); pages++) {
          if (!await prependPoolHistory(id, state)) break;
        }
      } else {
        for (let pages = 0; pages < 32 && pool === id && route === 'pools' && poolTab === 'discussion'; pages++) {
          const after = state.resume;
          const response = await read('pool.get', { pool_id: id, section: 'history', direction: 'forward', after });
          if (!alive || poolHistories.get(id) !== state) return;
          state.response = response;
          if (!usable(response)) break;
          const page = poolWindow(response.data, id, 'forward', after, null);
          if (!page.more && page.cursor !== page.watermark) throw new Error('pool_history_tail');
          const capacity = state.follow ? page.entries.length : Math.max(0, 500 - state.entries.length);
          const appended = page.entries.slice(0, capacity);
          state.entries.push(...appended);
          if (appended.length) state.resume = String(appended.at(-1)!.event_id_exact);
          state.watermark = page.watermark;
          if (state.follow) {
            if (state.entries.length > 500) { state.entries.splice(0, state.entries.length - 500); state.previous = String(state.entries[0].event_id_exact); }
            state.unseen = 0; if (route === 'pools' && pool === id && poolTab === 'discussion') poolScroll = Number.MAX_SAFE_INTEGER;
          } else state.unseen += appended.length;
          if (appended.length < page.entries.length || !page.more) break;
        }
      }
    } catch { state.response = failure('pool.get', 'pool_history_schema') as ReadResponse; }
    finally { state.busy = false; if (alive) render(); }
  }
  /** Prepends one exact frozen history page while preserving the visible line. */
  async function prependPoolHistory(id: string, state: PoolHistory): Promise<boolean> {
    const before = state.previous;
    if (!before) return false;
    const response = await read('pool.get', { pool_id: id, section: 'history', direction: 'backward', before, through: state.watermark });
    if (!alive || poolHistories.get(id) !== state) return false;
    state.response = response;
    if (!usable(response)) return false;
    const page = poolWindow(response.data, id, 'backward', before, state.watermark);
    const width = renderer.width >= 110 ? Math.floor((renderer.width - 6) * 0.64) : renderer.width - 4;
    const previousLines = poolEventLines(state.entries, width).length;
    state.entries.unshift(...page.entries); state.previous = page.more ? page.cursor : null;
    const addedLines = poolEventLines(state.entries, width).length - previousLines;
    if (state.entries.length > 500) { state.entries.splice(500); state.resume = String(state.entries.at(-1)?.event_id_exact ?? '0'); }
    if (route === 'pools' && pool === id && poolTab === 'discussion') { if (state.follow) poolScroll = Number.MAX_SAFE_INTEGER; else poolScroll = Math.max(0, poolScroll + addedLines); }
    return true;
  }
  /** Loads older history on demand; only this request owns the pool journal worker. */
  async function olderPoolHistory(): Promise<void> {
    if (!pool || poolHistorySupported() !== true) return;
    const id = pool, state = poolHistory(id);
    if (!state.loaded || state.busy || !state.previous) return;
    state.busy = true;
    try { await prependPoolHistory(id, state); }
    catch { state.response = failure('pool.get', 'pool_history_schema') as ReadResponse; }
    finally { state.busy = false; if (alive) render(); }
  }
  /** Loads only the checks immediately associated with one source-reported vote event. */
  async function loadPoolChecks(id: string, voteId: string, count: number): Promise<void> {
    const key = JSON.stringify([id, voteId, count]);
    if (poolChecks.has(key)) return;
    if (poolChecks.size >= 64) { const expired = [...poolChecks].find(([, value]) => !value.busy); if (expired) poolChecks.delete(expired[0]); }
    const state: PoolChecks = { busy: true, rows: null, error: null }; poolChecks.set(key, state); render();
    const controller = new AbortController(), deadline = setTimeout(() => controller.abort(), 30000);
    try {
      const rows: Record<string, unknown>[] = []; let after = voteId, through: string | null = null;
      while (rows.length < count) {
        const response = await read('pool.get', { pool_id: id, section: 'history', direction: 'forward', after, ...(through === null ? {} : { through }) }, controller.signal);
        if (!alive) return;
        if (!usable(response)) throw new Error('unavailable');
        const page = poolWindow(response.data, id, 'forward', after, through);
        if (through === null) through = page.watermark;
        for (const event of page.entries) {
          if (rows.length === count) break;
          const check = object(event.check);
          if (event.kind !== 'vote_check' || event.vote_event_id !== voteId || typeof check.criterion_id !== 'string' || !['met', 'unmet'].includes(String(check.status)) || typeof check.evidence !== 'string') throw new Error('check_attribution');
          rows.push(check);
        }
        if (rows.length < count && (!page.more || page.cursor === after)) throw new Error('check_incomplete');
        after = page.cursor;
      }
      state.rows = rows;
    } catch { state.error = 'Check evidence unavailable or incomplete.'; }
    finally { clearTimeout(deadline); state.busy = false; if (alive) render(); }
  }
  /** Returns the selected source ballot without attributing votes to execution state. */
  function poolVoteRows(): [string, Record<string, unknown>][] {
    if (!poolDetail.value?.view) return [];
    const source = object(object(poolDetail.value.view).pool).proposal;
    return source && typeof source === 'object' && !Array.isArray(source) ? Object.entries(object(object(source).votes)).map(([id, value]) => [id, object(value)]) : [];
  }
  /** Selects one ballot and requests only its explicitly identified evidence. */
  function choosePoolVote(index: number): void {
    const rows = poolVoteRows(), selected = rows[index];
    if (!pool || !selected) return;
    poolVoteIndex = index; poolVoteMember = selected[0];
    const vote = selected[1], id = vote.vote_event_id, count = vote.checks_count;
    if (poolCapability('structured_acceptance_v1') === true && poolHistorySupported() === true && typeof id === 'string' && /^(?:[1-9]\d{0,18})$/.test(id) && BigInt(id) <= 9223372036854775807n && typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 && count <= 10) void loadPoolChecks(pool, id, count);
    render();
  }
  /** Reads a long Pool purpose or proposal snapshot under one revision fence. */
  async function openPoolContent(field: 'purpose' | 'snapshot', proposalId?: string): Promise<void> {
    if (!pool || poolCapability('content_pages_v1') !== true) { alert = 'Full Pool content is not supported by this observer.'; render(); return; }
    if (field === 'snapshot' && !proposalId) { alert = 'No exact proposal snapshot is selected.'; render(); return; }
    cancelPoolMemberRead();
    const id = pool, previousScroll = poolContent?.previousScroll ?? poolScroll; poolContent?.controller.abort();
    const state: PoolContent = { field, text: null, error: null, busy: true, previousScroll, controller: new AbortController() };
    poolContent = state; poolScroll = 0; render();
    let offset = 0, revision: number | null = null, total: number | null = null; const parts: string[] = [];
    const deadline = setTimeout(() => { state.error = 'Full content timed out; retry from the beginning.'; state.controller.abort(); }, 30000);
    try {
      for (let pages = 0; pages < 256; pages++) {
        const response = await read('pool.get', { pool_id: id, section: 'content', field, after: String(offset), ...(proposalId ? { proposal_id: proposalId } : {}), ...(revision === null ? {} : { expected_revision: revision }) }, state.controller.signal);
        if (!alive || state.controller.signal.aborted || poolContent !== state || route !== 'pools' || pool !== id) return;
        if (!usable(response)) throw new Error('content_unavailable');
        const page = poolContentPage(response.data, id, field, offset, revision);
        if (total !== null && total !== page.total) throw new Error('content_changed');
        total = page.total; revision = page.revision; parts.push(page.text); offset = page.next;
        if (!page.more) { state.text = parts.join(''); return; }
      }
      throw new Error('content_page_limit');
    } catch { state.error = 'Full content is unavailable or changed; retry from the beginning.'; }
    finally { clearTimeout(deadline); state.busy = false; if (alive && poolContent === state) render(); }
  }
  /** Finds the latest pool_completed journal event, newest page first, under one watermark. */
  async function scanCompletionId(id: string, signal: AbortSignal): Promise<string | null> {
    let before: string | null = null, through: string | null = null;
    for (let pages = 0; pages < 100; pages++) {
      const response = await read('pool.get', { pool_id: id, section: 'history', direction: 'backward', ...(before ? { before, through } : {}) }, signal);
      if (!usable(response)) throw new Error(`history ${response.outcome}${response.error?.code ? ` [${response.error.code}]` : ''}`);
      const page = poolWindow(response.data, id, 'backward', before, through);
      const found = completionIdFromEvents(page.entries);
      if (found) return found;
      if (!page.more || !page.entries.length) return null;
      through = page.watermark; before = page.cursor;
    }
    throw new Error('history scan limit');
  }
  /** Reads every section of the pool's immutable completion record under one record digest. */
  async function openCompletion(): Promise<void> {
    if (!pool) return;
    if (poolCapability(COMPLETION_CAPABILITY) !== true) { alert = 'This Pool observer does not advertise completion records.'; render(); return; }
    cancelPoolMemberRead();
    const id = pool, previousScroll = poolContent?.previousScroll ?? poolScroll; poolContent?.controller.abort();
    const state: PoolContent = { field: 'completion', text: null, error: null, busy: true, previousScroll, controller: new AbortController() };
    poolContent = state; poolScroll = 0; render();
    const current = () => alive && !state.controller.signal.aborted && poolContent === state && route === 'pools' && pool === id;
    const deadline = setTimeout(() => { state.error = 'Completion record timed out; retry.'; state.controller.abort(); }, 60000);
    try {
      const completionId = completionIdFromEvents(poolHistories.get(id)?.entries ?? []) ?? await scanCompletionId(id, state.controller.signal);
      if (!current()) return;
      if (!completionId) { state.error = 'No pool_completed event: this pool has no completion record (closed is not completion).'; return; }
      const pages = new Map<CompletionSection, CompletionPage[]>();
      let bound: { digest: string; version: number } | null = null;
      for (const section of COMPLETION_SECTIONS) {
        const list: CompletionPage[] = [];
        let after: Record<string, unknown> | null = null;
        for (let count = 0; count < 200; count++) {
          const request = { pool_id: id, completion_id: completionId, section };
          const envelope = await read('pool.completion_get', { ...request, limit: 10, ...(after ? { after } : {}) }, state.controller.signal);
          if (!current()) return;
          if (!usable(envelope)) throw new Error(`${envelope.outcome}${envelope.error?.code ? ` [${envelope.error.code}]` : ''}`);
          const page = completionPage(envelope.data, request, bound);
          bound ??= { digest: page.recordDigest, version: page.recordVersion };
          list.push(page);
          if (!page.next) break;
          after = page.next;
          if (count === 199) throw new Error('completion page limit');
        }
        pages.set(section, list);
      }
      state.text = completionText(id, pages);
    } catch (error) { if (current()) state.error = `Completion record unavailable: ${error instanceof Error ? safe(error.message) : 'read failed'}`; }
    finally { clearTimeout(deadline); state.busy = false; if (alive && poolContent === state) render(); }
  }
  /** Closes an in-flight content read and restores the previous section position. */
  function closePoolContent(): void { if (!poolContent) return; poolContent.controller.abort(); poolScroll = poolContent.previousScroll; poolContent = null; }
  /** Scans bounded retained Bridge pages under the first page's source watermark. */
  async function observeBridgePages(state: Slot<Record<string, unknown>>, resource: 'bridge.deliveries' | 'bridge.incidents'): Promise<void> {
    if (!alive || state.busy) return;
    state.busy = true; const generation = ++state.generation; render();
    const field = resource === 'bridge.deliveries' ? 'deliveries' : 'incidents';
    const kind = field === 'deliveries' ? 'delivery_page' : 'incident_page';
    const first = await read(resource, { limit: 100, after_seq: 0, ...(field === 'incidents' ? { include_closed: true } : {}) });
    if (!alive || generation !== state.generation) return;
    if (!usable(first)) state.response = first;
    if (usable(first)) {
      try {
        const initial = bridgeData(first.data, kind), through = Number(initial.through_seq);
        /** Rejects replayed or out-of-window rows before they can inflate a metric. */
        const checkedRows = (data: Record<string, unknown>, after: number): unknown[] => {
          const page = data[field] as unknown[]; let last = after;
          for (const value of page) {
            const row = object(value), seq = Number(row[field === 'deliveries' ? 'acceptance_seq' : 'incident_seq']);
            if (!Number.isSafeInteger(seq) || seq <= last || seq > through) throw new Error('bridge_row_cursor');
            last = seq;
          }
          if (data.next_after_seq !== null && data.next_after_seq !== last) throw new Error('bridge_page_cursor');
          return page;
        };
        const rows = [...checkedRows(initial, 0)]; let next = initial.next_after_seq as number | null, partial = independentlyPartial(first);
        let lastResponse = first;
        for (let page = 1; page < 20 && next !== null && next < through && route === 'overview'; page++) {
          const previous = next;
          const envelope = await read(resource, { limit: 100, after_seq: previous, through_seq: through, ...(field === 'incidents' ? { include_closed: true } : {}) });
          if (!alive || generation !== state.generation) return;
          if (!usable(envelope)) { lastResponse = envelope; break; }
          partial ||= independentlyPartial(envelope);
          const data = bridgeData(envelope.data, kind);
          if (data.through_seq !== through || (data.next_after_seq !== null && Number(data.next_after_seq) <= previous)) throw new Error('bridge_cursor');
          rows.push(...checkedRows(data, previous)); next = data.next_after_seq as number | null;
        }
        if (usable(lastResponse) || !state.good || !state.value) {
          state.value = { ...initial, [field]: rows, next_after_seq: next, scan_partial: partial };
          state.good = first;
        }
        state.response = lastResponse;
      } catch { state.response = failure(resource, 'bridge_paging') as ReadResponse; }
    }
    state.busy = false; render();
  }
  /** Reads the explicitly requested inventory pages and fences mutable Run revisions. */
  async function inventory<T>(state: Slot<Page<T>>, resource: 'run.agents', count: number, parse: (value: unknown) => Page<T>, key: (value: T) => string): Promise<void> {
    if (!alive || state.busy) return; state.busy = true; const generation = ++state.generation; render();
    const first = await read(resource, { limit: 200, offset: 0 });
    if (!alive || generation !== state.generation) return;
    state.response = first;
    if (usable(first)) {
      try {
        let partial = independentlyPartial(first);
        const page = await collectPages(parse(first.data), count, async cursor => {
          const next = await read(resource, { limit: 200, offset: cursor });
          if (!usable(next)) throw new Error('page_unavailable'); partial ||= independentlyPartial(next); return parse(next.data);
        }, key, () => alive && generation === state.generation);
        if (!alive || generation !== state.generation) return;
        const previous = resource === 'run.agents' ? selectedAgent() : null;
        state.value = partial ? { ...page, complete: false } : page; state.good = first;
        if (previous && (!selectedAgent() || executionKey(selectedAgent()!) !== executionKey(previous))) cancelExecutionReads(executionKey(previous));
      } catch { if (!alive || generation !== state.generation) return; state.response = failure(resource, 'page_unavailable_or_changed') as ReadResponse; }
    }
    state.busy = false;
    if (resource === 'run.agents') { ensureSelection(); if (route === 'sessions') { ensureDefaultHistory(); if (!tailHistory()?.loaded) void loadHistory(); if (tab === 'result') void loadAnswer(); } }
    render();
  }
  /** Reads the requested Agent Pool inventory pages without inventing a cross-page snapshot. */
  async function inventoryPools(): Promise<void> {
    if (!alive || pools.busy) return; pools.busy = true; const generation = ++pools.generation; render();
    const first = await read('pool.list');
    if (!alive || generation !== pools.generation) return;
    pools.response = first;
    if (usable(first)) {
      try {
        const page = await collectPages(poolInventory(first.data, null), poolPages, async cursor => {
          if (typeof cursor !== 'string') throw new Error('pool_inventory_cursor');
          const next = await read('pool.list', { after: cursor });
          if (!usable(next)) throw new Error('pool_inventory_unavailable');
          return poolInventory(next.data, cursor);
        }, item => String(object(item.pool).pool_id), () => alive && generation === pools.generation);
        if (!alive || generation !== pools.generation) return;
        const previous = visiblePools()[poolIndex], selectedId = previous ? object(previous.pool).pool_id : null;
        const selectedWasShown = route === 'pools' && !pool && poolSelectionShown;
        pools.value = page; pools.good = first;
        if (typeof selectedId === 'string') {
          const index = visiblePools().findIndex(item => object(item.pool).pool_id === selectedId);
          if (index >= 0) { poolIndex = index; if (selectedWasShown) revealPoolSelection = true; }
        }
      } catch { if (!alive || generation !== pools.generation) return; pools.response = failure('pool.list', 'pool_inventory_page') as ReadResponse; }
    }
    pools.busy = false; render();
  }
  /** Reads live agents independently so old running sessions do not disappear behind finished pages. */
  async function inventoryActiveAgents(): Promise<void> {
    if (!alive || activeAgents.busy) return; activeAgents.busy = true; const generation = ++activeAgents.generation;
    const first = await read('run.agents', { active: true, limit: 200, offset: 0 });
    if (!alive || generation !== activeAgents.generation) return;
    let response = first, updated: Page<RunAgent> | null = null;
    if (usable(first)) {
      try {
        const parse = (value: unknown): Page<RunAgent> => { const page = runPage(value); if (page.items.some(agent => !activeStatus(agent.status))) throw new Error('active_scope'); return page; };
        const initial = parse(first.data), pages = Math.min(32, Math.max(1, Math.ceil((initial.total ?? initial.items.length) / 200)));
        const page = await collectPages(initial, pages, async cursor => {
          if (typeof cursor !== 'number') throw new Error('active_cursor');
          const next = await read('run.agents', { active: true, limit: 200, offset: cursor });
          if (!usable(next)) throw new Error('active_unavailable');
          return parse(next.data);
        }, agent => agent.id, () => alive && generation === activeAgents.generation);
        if (!alive || generation !== activeAgents.generation) return;
        updated = independentlyPartial(first) ? { ...page, complete: false } : page;
      } catch { if (!alive || generation !== activeAgents.generation) return; response = failure('run.agents', 'active_inventory') as ReadResponse; }
    }
    const previous = selectedAgent();
    activeAgents.response = response;
    if (updated) { activeAgents.value = updated; activeAgents.good = first; }
    if (previous && (!selectedAgent() || executionKey(selectedAgent()!) !== executionKey(previous))) cancelExecutionReads(executionKey(previous));
    activeAgents.busy = false;
    if (route === 'sessions') { ensureSelection(); ensureDefaultHistory(); if (!tailHistory()?.loaded) void loadHistory(); }
    render();
  }
  /** Compares reported integer revisions without rounding or assuming opaque strings are ordered. */
  function compareRevision(first: Cursor | null, second: Cursor | null): number | null {
    if (first === second) return 0;
    const integerText = (value: Cursor | null) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : typeof value === 'string' && /^(0|[1-9]\d{0,19})$/.test(value) ? value : null;
    const left = integerText(first), right = integerText(second);
    return left === null || right === null ? null : BigInt(left) > BigInt(right) ? 1 : -1;
  }
  /** Supplements the inventory from an equally fresh or newer active-only observation. */
  function loadedAgents(): RunAgent[] {
    const page = agents.value, active = activeAgents.value;
    if (!page) return [];
    if (!active || !activeAgents.good || activeAgents.response !== activeAgents.good) return page.items;
    const order = compareRevision(active.revision, page.revision);
    if (order === null || order < 0) return page.items;
    const live = new Set(active.items.map(agent => agent.id));
    const rows = new Map(page.items.filter(agent => order === 0 || !active.complete || !activeStatus(agent.status) || live.has(agent.id)).map(agent => [agent.id, agent]));
    for (const agent of active.items) rows.set(agent.id, agent);
    return [...rows.values()];
  }
  /** Returns the exact global terminal count only when both source totals share a revision. */
  function globalFinished(): number | null {
    const all = agents.value, active = activeAgents.value;
    if (!all || !active || !active.complete || !agents.good || agents.response !== agents.good || !activeAgents.good || activeAgents.response !== activeAgents.good || all.revision !== active.revision || all.total === null || active.total === null || active.total > all.total) return null;
    return all.total - active.total;
  }
  /** Keeps the active metric tied to its independently observed source total. */
  function activeCount(): string {
    if (activeAgents.value && activeAgents.good && activeAgents.value.total !== null) return `${activeAgents.response !== activeAgents.good ? 'STALE · ' : ''}${activeAgents.value.total}`;
    return agents.value ? `${agents.response !== agents.good ? 'STALE · ' : ''}${loadedAgents().filter(agent => activeStatus(agent.status)).length} loaded` : 'Unknown';
  }
  /** Returns the selected loaded execution, or null when the snapshot no longer contains it. */
  function selectedAgent(): RunAgent | null {
    const listed = loadedAgents().find(value => value.id === selected) ?? null;
    const observed = detailFromRelated && boundTarget && relatedAgent.value?.targetKey === boundTarget.key ? relatedAgent.value : null;
    const related = observed?.agent ?? null;
    const precise = observed?.evidence?.match === 'verified' && observed.evidence.storeFenced && relatedAgent.good !== null && relatedAgent.response === relatedAgent.good;
    if (related && listed && !precise && (listed.sequence !== related.sequence || typeof listed.raw.created_at === 'number' && typeof related.raw.created_at === 'number' && listed.raw.created_at !== related.raw.created_at)) return null;
    const agent = detailFromRelated ? related : listed;
    if (agent && agent.id !== selected) return null;
    return agent && (boundSequence === null || agent.sequence === boundSequence) ? agent : null;
  }
  /** Returns only evidence associated with the current bound navigation target. */
  function currentBoundEvidence(): RunStatusEvidence | null {
    const observed = relatedAgent.value;
    return detailFromRelated && boundTarget && observed?.targetKey === boundTarget.key ? observed.evidence : null;
  }
  /** Captures a Pool binding and its exact status selector for navigation and rereads. */
  function bindingTarget(binding: Record<string, unknown>, poolId: string, observed = poolDetail.value?.observed_at_unix_ms): BoundTarget {
    const memberId = object(binding.member).member_id;
    if (binding.pool_id !== poolId || typeof memberId !== 'string' || !memberId) throw new Error('pool_binding');
    const request = runStatusRequest(binding);
    const poolObservedAtMs = typeof observed === 'number' && Number.isFinite(observed) && observed >= 0 ? observed : null;
    return { poolId, memberId, request, key: JSON.stringify([poolId, memberId, request]), poolObservedAtMs };
  }
  /** Allows only numeric reader coordinates to survive a fresh unfenced lineage observation. */
  function sameUncorrelatedLineage(previous: BoundObservation | null, next: BoundObservation | null): boolean {
    if (!previous?.agent || !next?.agent || previous.targetKey !== next.targetKey || previous.agent.id !== next.agent.id || previous.agent.sequence !== next.agent.sequence) return false;
    const before = previous.agent.raw.created_at, after = next.agent.raw.created_at;
    if (typeof before === 'number' && typeof after === 'number' && before !== after) return false;
    if (previous.legacy || next.legacy) return previous.legacy && next.legacy;
    return !!previous.evidence && !!next.evidence && previous.evidence.storeId === next.evidence.storeId && previous.evidence.match === 'unverified' && next.evidence.match === 'unverified' && previous.evidence.selected?.executionRef === null && next.evidence.selected?.executionRef === null;
  }
  /** Cancels the selected roster member's status read and clears its scoped observation. */
  function cancelPoolStatus(): void { poolStatusRead?.abort(); poolStatusRead = null; poolStatusKey = ''; poolStatusRetryAt = 0; reset(poolStatus); }
  /** Cancels the owned member lookup and clears its archived-delivery association. */
  function cancelPoolMemberRead(): void { const pending = poolMemberRead; poolMemberRead = null; formerDeliveryKey = null; pending?.abort(); if (alert === 'Checking original member binding…' || alert === 'Checking bound Run execution…') alert = ''; }
  /** Resolves only the selected member of the current, non-stale roster page. */
  function selectedPoolTarget(): BoundTarget | null {
    if (route !== 'pools' || !pool || poolTab !== 'members' || !poolDetail.good || poolDetail.response !== poolDetail.good || !poolDetail.value?.view) return null;
    const members = object(poolDetail.value.view).members, bindings = poolDetail.value.bindings;
    if (!Array.isArray(members) || !members[poolMemberIndex] || !Array.isArray(bindings)) return null;
    const memberId = object(members[poolMemberIndex]).member_id;
    const matching = bindings.map(object).filter(value => object(value.member).member_id === memberId);
    if (matching.length !== 1) return null;
    try { return bindingTarget(matching[0], pool); } catch { return null; }
  }
  /** Fences Pool evidence to the selected roster revision and exact binding. */
  function selectedPoolStatusTarget(): { key: string; bound: BoundTarget | null; proof: PoolRunProofTarget | null } | null {
    const supported = poolCapability('run_proof_v1');
    if (supported === null) return null;
    if (!supported) {
      const bound = selectedPoolTarget();
      return bound ? { key: JSON.stringify([bound.key, 'run']), bound, proof: null } : null;
    }
    try {
      if (route !== 'pools' || !pool || poolTab !== 'members' || !poolDetail.good || poolDetail.response !== poolDetail.good) return null;
      const view = object(poolDetail.value?.view), revision = object(view.pool).revision, bindings = poolDetail.value?.bindings, members = view.members;
      if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1 || !Array.isArray(bindings) || !Array.isArray(members) || !members[poolMemberIndex]) return null;
      const memberId = object(members[poolMemberIndex]).member_id;
      if (typeof memberId !== 'string' || !memberId) return null;
      const matching = bindings.map(object).filter(binding => object(binding.member).member_id === memberId);
      if (matching.length !== 1 || matching[0].pool_id !== pool) return null;
      const binding = matching[0], proof = { poolId: pool, memberId, revision, binding };
      return { key: JSON.stringify([pool, memberId, revision, binding.run_id, binding.run_sequence, binding.run_execution_ref, binding.run_pin_id, binding.run_store_id]), bound: null, proof };
    } catch { return null; }
  }
  /** Observes the selected member without turning status failures into inventory matches. */
  async function refreshPoolStatus(): Promise<void> {
    const target = selectedPoolStatusTarget();
    if (!target) { if (poolStatusKey) { cancelPoolStatus(); render(); } return; }
    if (poolStatusKey !== target.key) { cancelPoolStatus(); poolStatusKey = target.key; }
    if (!alive || poolStatus.busy || Date.now() < poolStatusRetryAt) return;
    poolStatus.busy = true; const generation = ++poolStatus.generation;
    const controller = new AbortController(); poolStatusRead = controller;
    const resource = target.proof ? 'pool.run_proof' : 'run.status';
    const params = target.proof ? { pool_id: target.proof.poolId, section: 'run_proof', member_id: target.proof.memberId, expected_revision: target.proof.revision } : { ...target.bound!.request };
    const envelope = await read(resource, params, controller.signal);
    if (poolStatusRead === controller) poolStatusRead = null;
    if (!alive || controller.signal.aborted || generation !== poolStatus.generation) return;
    if (selectedPoolStatusTarget()?.key !== target.key) { cancelPoolStatus(); render(); return; }
    poolStatus.response = envelope;
    if (envelope.outcome === 'partial' || envelope.outcome === 'ok' && envelope.error !== null) {
      poolStatus.value = null; poolStatus.good = null; poolStatus.response = failure(resource, 'status_partial') as ReadResponse;
    } else if (usable(envelope)) {
      try {
        if (target.proof) {
          const proof = parsePoolRunProof(envelope.data, target.proof);
          if (!proof.current) throw new Error('pool_proof_removed_member');
          poolStatus.value = proof.state === 'observed' ? { targetKey: target.key, source: 'pool', evidence: proof.evidence, poolObservedAtMs: proof.observedAtMs } : { targetKey: target.key, source: 'pool', evidence: null, reason: proof.reason, poolObservedAtMs: proof.observedAtMs };
        } else poolStatus.value = { targetKey: target.key, source: 'run', evidence: parseRunStatus(envelope.data, target.bound!.request) };
        poolStatus.good = envelope;
      }
      catch { poolStatus.value = null; poolStatus.good = null; poolStatus.response = failure(resource, 'status_identity') as ReadResponse; }
    } else if (!target.proof && envelope.error?.code === 'run_method_unavailable') {
      poolStatus.value = null; poolStatus.good = null; poolStatusRetryAt = Date.now() + 30000;
    } else if (envelope.outcome === 'invalid' || envelope.outcome === 'incompatible' || envelope.error?.code === 'run_source_error') {
      poolStatus.value = null; poolStatus.good = null;
    }
    poolStatus.busy = false; render();
  }
  /** Resolves a bound selector through status v1 or revision-fenced legacy inventory. */
  async function readBoundAgent(target: BoundTarget, signal?: AbortSignal): Promise<{ envelope: ReadResponse; value: BoundObservation | null }> {
    const selector = target.request.targets[0], id = selector.agent_id;
    if (directStatus !== false || Date.now() >= relatedNextScan) {
      const envelope = await read('run.status', { ...target.request }, signal);
      if (signal?.aborted) return { envelope: failure('run.status', 'cancelled') as ReadResponse, value: null };
      if (envelope.outcome === 'partial' || envelope.outcome === 'ok' && envelope.error !== null) return { envelope: failure('run.status', 'status_partial') as ReadResponse, value: null };
      if (usable(envelope)) {
        try {
          const evidence = parseRunStatus(envelope.data, target.request), agent = evidence.view?.agent ?? null;
          if (agent) {
            const ref = evidence.selected?.executionRef, pin = target.request.targets[0].pin_id;
            const identity = ref ? ['execution', ref] : evidence.match === 'unverified' && evidence.storeFenced && evidence.pinState === 'active' && pin && evidence.canonicalAgentId ? ['pinned-lineage', pin, evidence.canonicalAgentId] : ['unknown', ++uncorrelatedObservation];
            relatedKeys.set(agent, JSON.stringify([target.key, evidence.storeId, identity]));
          }
          directStatus = true;
          return { envelope, value: { targetKey: target.key, agent, evidence, legacy: false } };
        } catch { return { envelope: failure('run.status', 'status_identity') as ReadResponse, value: null }; }
      }
      if (envelope.error?.code !== 'run_method_unavailable') return { envelope, value: null };
      directStatus = false;
    }
    let offset = 0, revision: Cursor | null = null;
    const seen = new Set<string>();
    for (let index = 0; index < 32; index++) {
      const envelope = await read('run.agents', { limit: 200, offset }, signal);
      if (signal?.aborted) return { envelope: failure('run.agents', 'cancelled') as ReadResponse, value: null };
      if (!usable(envelope) || envelope.error !== null || independentlyPartial(envelope)) return { envelope, value: null };
      try {
        const page = runPage(envelope.data);
        if (page.raw.offset !== offset || revision !== null && page.revision !== revision) throw new Error('inventory_changed');
        revision = page.revision;
        for (const agent of page.items) {
          if (seen.has(agent.id)) throw new Error('inventory_duplicate');
          seen.add(agent.id);
          if (agent.id === id) {
            const matching = agent.sequence === selector.sequence ? agent : null;
            if (matching) relatedKeys.set(matching, JSON.stringify([target.key, 'legacy', ++uncorrelatedObservation]));
            return { envelope, value: { targetKey: target.key, agent: matching, evidence: null, legacy: true } };
          }
        }
        if (page.next === null) return { envelope, value: { targetKey: target.key, agent: null, evidence: null, legacy: true } };
        if (typeof page.next !== 'number' || page.next <= offset || page.next !== offset + page.items.length) throw new Error('inventory_cursor');
        offset = page.next;
      } catch { return { envelope: failure('run.agents', 'bound_inventory') as ReadResponse, value: null }; }
    }
    return { envelope: failure('run.agents', 'bound_inventory_limit') as ReadResponse, value: null };
  }
  /** Cancels and invalidates only the in-flight bound status refresh. */
  function cancelRelatedRead(): void { relatedRead?.abort(); relatedRead = null; relatedAgent.generation++; relatedAgent.busy = false; }
  /** Rechecks the same bound selector without inheriting another target's evidence. */
  async function refreshRelated(target: BoundTarget): Promise<void> {
    const restoring = currentBeginning();
    const pendingPosition = tab === 'history' && restoring?.active ? historyPositions.get(restoring.state) : undefined;
    if (pendingPosition && restoring) {
      if (performance.now() - pendingPosition.startedAt >= HISTORY_RESTORE_MS) { historyPositions.delete(restoring.state); restoring.state.controller?.abort(); }
      else if (restoring.state.busy || restoring.state.loaded && restoring.next !== null && (!restoring.state.response || usable(restoring.state.response)) && restoring.autoPages < HISTORY_FILL_PAGES) return;
    }
    if (!alive || relatedAgent.busy || directStatus === false && Date.now() < relatedNextScan) return;
    relatedAgent.busy = true; const generation = ++relatedAgent.generation;
    const controller = new AbortController(); relatedRead = controller;
    const observed = await readBoundAgent(target, controller.signal), envelope = observed.envelope;
    if (relatedRead === controller) relatedRead = null;
    if (!alive || controller.signal.aborted || generation !== relatedAgent.generation) return;
    if (route !== 'sessions' || !detailFromRelated || boundTarget?.key !== target.key) { relatedAgent.busy = false; return; }
    const previous = selectedAgent(), previousKey = previous ? executionKey(previous) : null;
    const previousBeginning = previous && tab === 'history' ? currentBeginning() : null;
    const previousHistory = previous && tab === 'history' ? currentHistory() : null;
    const position: HistoryPosition | null = previousHistory?.loaded && sameUncorrelatedLineage(relatedAgent.value, observed.value) ? { beginning: !!previousBeginning?.active && previousBeginning.state === previousHistory, follow: previousHistory.follow, scroll: previousHistory.scroll, windowStart: previousHistory.windowStart, windowEnd: previousHistory.windowEnd, startedAt: performance.now() } : null;
    relatedAgent.response = envelope;
    if (usable(envelope) && observed.value) { relatedAgent.value = observed.value; relatedAgent.good = envelope; }
    else if (usable(envelope)) { relatedAgent.value = null; relatedAgent.good = null; relatedAgent.response = failure('run.agents', 'bound_agent_missing') as ReadResponse; }
    else if (envelope.outcome === 'invalid' || envelope.outcome === 'incompatible' || envelope.error?.code === 'run_source_error') { relatedAgent.value = null; relatedAgent.good = null; }
    if (directStatus === false) relatedNextScan = Date.now() + 30000;
    relatedAgent.busy = false;
    if (previousKey && (!selectedAgent() || executionKey(selectedAgent()!) !== previousKey)) {
      cancelExecutionReads(previousKey); histories.delete(previousKey); beginnings.delete(previousKey);
      if (previous) answers.delete(JSON.stringify([previousKey, previous.answerSha]));
      if (position && selectedAgent() && tab === 'history') {
        ensureDefaultHistory();
        const beginning = currentBeginning(), tail = tailHistory();
        if (position.beginning && beginning) historyPositions.set(beginning.state, position);
        else if (beginning && tail) { beginning.active = false; beginning.state.controller?.abort(); tail.follow = position.follow; if (!position.follow) historyPositions.set(tail, position); }
      }
    }
    if (selectedAgent() && tab === 'history') { ensureDefaultHistory(); if (!tailHistory()?.loaded) void loadHistory(); }
    if (selectedAgent() && tab === 'result') void loadAnswer();
    render();
  }
  /** Cancels only reads owned by one exact execution. */
  function cancelExecutionReads(key: string): void {
    histories.get(key)?.controller?.abort(); beginnings.get(key)?.state.controller?.abort();
    const task = initialTasks.get(key);
    if (task?.busy) { task.controller?.abort(); initialTasks.delete(key); }
    cancelAnswerReads(key);
    if (toolTimeRequest?.key === key) toolTimeRequest.controller.abort();
    if (exactCopyExecution === key) copyController?.abort();
  }
  /** Cancels answer reads owned by one execution without interrupting its transcript. */
  function cancelAnswerReads(key: string): void { for (const answer of answers.values()) if (answer.executionKey === key) answer.controller?.abort(); }
  /** Cancels reads owned by the previously selected session. */
  /**
   * Reads the selected execution's exact initial task once per execution identity. Strict mode is used only
   * when the Pool binding proved store, ref, active pin and complete coverage; otherwise the weaker current
   * mode. A Run without the capability, or any failure, keeps the unverified label.
   */
  async function loadInitialTask(): Promise<void> {
    const agent = selectedAgent(); if (!agent || route !== 'sessions' || initialTasks.has(executionKey(agent))) return;
    const key = executionKey(agent), controller = new AbortController();
    const state: InitialTaskState = { busy: true, controller, result: null, unsupported: false, lines: null };
    initialTasks.set(key, state); render();
    const current = () => alive && !controller.signal.aborted && initialTasks.get(key) === state && route === 'sessions' && !!selectedAgent() && executionKey(selectedAgent()!) === key;
    const drop = () => { if (initialTasks.get(key) === state) initialTasks.delete(key); };
    try {
      const discovery = await read('run.identity', {}, controller.signal);
      if (!current()) { drop(); return; }
      const capability = usable(discovery) && discovery.error === null ? initialTaskCapability(discovery.data) : null;
      if (usable(discovery) && discovery.error === null && !capability) state.unsupported = true;
      else if (!capability) state.result = { state: 'unverified', reason: 'capability_unknown' };
      if (capability) {
        const bound = detailFromRelated ? boundTarget : null, evidence = bound ? currentBoundEvidence() : null, selector = bound?.request.targets[0];
        const storeId = bound?.request.expected_store_id, ref = selector?.execution_ref, pin = selector?.pin_id;
        const strict = !!bound && !!selector && !!storeId && !!ref && !!pin && agent.sequence === 1 && selector.sequence === 1 && evidence?.match === 'verified' && evidence.storeFenced && evidence.pinState === 'active' && evidence.coverage === 'complete' && evidence.canonicalAgentId === agent.id && capability.modes.includes('strict');
        const fenced = !!bound && !!selector && selector.sequence === 1 && evidence?.match === 'verified' && !!ref;
        const request: InitialTaskRequest = strict ? { mode: 'strict', agentId: agent.id, storeId, executionRef: ref, pinId: pin } : { mode: 'current', agentId: agent.id, ...(fenced ? { executionRef: ref } : {}), ...(fenced && evidence?.storeFenced && storeId ? { storeId } : {}) };
        const result = await readInitialTask(params => read('run.initial_task', params, controller.signal), request, capability, current);
        if (!current()) { drop(); return; }
        state.result = result;
      }
    } catch { if (!current()) { drop(); return; } state.result = { state: 'unverified', reason: 'read_failed' }; }
    state.busy = false; state.controller = null; render();
  }
  function cancelSessionReads(): void { const agent = selectedAgent(); if (agent) cancelExecutionReads(executionKey(agent)); }
  /** Chooses the initial item only; a missing later selection never silently switches identity. */
  function ensureSelection(): void { if (selected === null && agents.value?.items.length) selected = visibleAgents()[0]?.id ?? null; }
  /** Separates caches by execution and, for bound sessions, by Pool target and Run store. */
  function executionKey(agent: RunAgent): string { const created = typeof agent.raw.created_at === 'number' && Number.isFinite(agent.raw.created_at) ? agent.raw.created_at : null; return JSON.stringify([agent.id, agent.sequence, created, relatedKeys.get(agent) ?? null]); }
  /** Gets or creates the selected execution's independently refreshed tail. */
  function tailHistory(): History | null { const agent = selectedAgent(); if (!agent) return null; const key = executionKey(agent); let item = histories.get(key); if (!item) { item = history(); histories.set(key, item); } return item; }
  /** Returns the selected execution's prefix, when one has been requested. */
  function currentBeginning(): Beginning | null { const agent = selectedAgent(); return agent ? beginnings.get(executionKey(agent)) ?? null : null; }
  /** Selects the displayed range without redirecting background tail reads. */
  function currentHistory(): History | null {
    const tail = tailHistory(), beginning = currentBeginning();
    return route === 'sessions' && tab === 'history' && beginning?.active ? beginning.state : tail;
  }
  /** Starts each newly selected execution at its retained beginning. */
  function ensureDefaultHistory(): void {
    const agent = selectedAgent(); if (!agent || route !== 'sessions' || tab !== 'history') return;
    const key = executionKey(agent); if (beginnings.has(key)) return;
    const tail = tailHistory(); if (!tail) return; tail.follow = false;
    const state = history(); state.follow = false;
    beginnings.set(key, { state, next: 0, active: true, autoPages: 0, width: 0, height: 0 });
    void loadBeginningPage();
  }
  /** Restores only screen coordinates after fresh source rows have been loaded. */
  function restoreHistoryPosition(state: History, hasMore = false): void {
    const position = historyPositions.get(state); if (!position) return;
    const total = state.grouped.entries.length;
    if (!position.beginning || !hasMore || total > position.windowStart || performance.now() - position.startedAt >= HISTORY_RESTORE_MS) historyPositions.delete(state);
    state.windowStart = Math.min(position.windowStart, Math.max(0, total - 1));
    state.windowEnd = Math.min(total, Math.max(state.windowStart + 1, position.windowEnd));
    state.scroll = position.scroll; state.anchor = null; state.selected = null;
  }
  /** Preserves an expanded fragment's reading position when an older prefix is loaded. */
  function regroupHistory(state: History): void {
    const previous = state.grouped, next = groupTranscript(state.blocks);
    for (const entry of previous.entries) {
      for (const field of ['calls', 'results'] as const) {
        const first = entry[field][0]; if (!first) continue;
        const index = next.byKey.get(first.key), updated = index === undefined ? undefined : next.entries[index];
        if (!updated) continue;
        const fragments = updated[field], newKey = fragments[0]?.key;
        if (!newKey || newKey === first.key) continue;
        const part = state.parts.get(first.key) ?? 0, previousIndex = fragments.findIndex(block => block.key === first.key);
        if (previousIndex < 0) continue;
        const prefix = fragments.slice(0, previousIndex).reduce((total, block) => total + block.content.length, 0);
        const anchor = state.anchor?.key === first.key ? state.anchor : null;
        const segments = field === 'calls' ? toolInput(entry) : toolOutput(entry);
        const [start] = segmentBounds(segments, part), chunk = segmentChunk(segments, part);
        const offset = anchor && anchor.offset >= 0 && anchor.offset < METADATA_OFFSET ? sourceOffset(chunk, anchor.offset) : 0;
        const absolute = start + prefix + offset;
        const nextSegments = field === 'calls' ? toolInput(updated) : toolOutput(updated);
        const page = Math.min(Math.floor(absolute / RESULT_CHUNK), Math.max(0, Math.ceil(segmentLength(nextSegments) / RESULT_CHUNK) - 1));
        if (state.parts.has(first.key) || anchor && anchor.offset >= 0) state.parts.set(newKey, page);
        if (anchor) {
          anchor.key = newKey;
          if (anchor.offset >= 0 && anchor.offset < METADATA_OFFSET) {
            const [nextStart] = segmentBounds(nextSegments, page);
            anchor.offset = displayOffset(segmentChunk(nextSegments, page), absolute - nextStart);
          }
        }
        if (state.selected === first.key) state.selected = newKey;
      }
    }
    state.grouped = next;
  }
  /** Labels the latest loaded named tool as transcript evidence, never as an inventory field. */
  function lastAction(agent: RunAgent): string {
    if (typeof agent.raw.last_action === 'string' && agent.raw.last_action) return `Source action: ${safe(agent.raw.last_action)}`;
    const blocks = histories.get(executionKey(agent))?.blocks ?? [];
    const tool = blocks.findLast(block => ['tool', 'tool_call', 'tool_result'].includes(block.role) && typeof block.raw.name === 'string' && !!block.raw.name);
    return tool ? `Last loaded transcript action: ${safe(tool.raw.name)}` : 'Action: Unknown';
  }
  /** Fetches an initial tail, source continuation, or an explicitly requested older page. */
  async function loadHistory(older = false): Promise<void> {
    void loadInitialTask();
    const agent = selectedAgent(), state = tailHistory(); if (!agent || !state || state.busy || (older && state.previous === null)) return;
    const key = executionKey(agent), initial = !state.loaded;
    const params: Record<string, unknown> = { agent_id: agent.id, view: 'blocks', ...(older ? { before_cursor: state.previous, tail_blocks: 40 } : initial || state.resume === null ? { tail_blocks: 40 } : { cursor: state.resume }) };
    const controller = new AbortController(); state.controller = controller; state.busy = true; render(); const observed = await readTranscript(params, controller.signal), envelope = observed.envelope;
    if (!alive || histories.get(key) !== state) return;
    if (state.controller !== controller) return;
    state.controller = null;
    if (controller.signal.aborted) { state.busy = false; const current = selectedAgent(); if (route === 'sessions' && current && executionKey(current) === key && !state.loaded) void loadHistory(); render(); return; }
    state.response = envelope;
    if (usable(envelope)) {
      try {
        const page = transcriptPage(envelope.data, agent.id), previous = new Map(state.blocks.map(block => [block.key, block.content]));
        if (!observed.raw && page.raw.view !== 'blocks') throw new Error('transcript_view');
        if (observed.raw) {
          if (page.raw.cursor !== observed.cursor || page.raw.view != null && page.raw.view !== 'raw') throw new Error('transcript_cursor');
          let last = observed.cursor;
          for (const block of page.blocks) { if (block.seq <= last) throw new Error('transcript_order'); last = block.seq; }
          if (page.complete ? page.raw.next_cursor != null : last === observed.cursor || page.raw.next_cursor !== last) throw new Error('transcript_continuation');
        }
        const added = page.blocks.filter(block => !previous.has(block.key) || previous.get(block.key) !== block.content).length;
        state.blocks = mergeBlocks(state.blocks, page.blocks); regroupHistory(state); state.loaded = true;
        const beginning = beginnings.get(key);
        if (initial || older) { state.previous = observed.raw ? null : page.previous; state.headComplete = observed.raw ? initial && observed.cursor === 0 : page.complete && page.previous === null; }
        if (!older) state.tailComplete = observed.raw ? page.complete : initial || page.complete;
        state.partial ||= independentlyPartial(envelope);
        state.complete = state.headComplete && state.tailComplete && !state.partial;
        if (!older && observed.raw) state.resume = page.blocks.at(-1)?.seq ?? observed.cursor;
        else if (!older && page.resume !== null) state.resume = page.resume;
        if (!older && beginning?.state.loaded && beginning.next === null && typeof state.resume === 'number') {
          const through = beginning.state.blocks.at(-1)?.seq ?? 0;
          if (state.resume > through) { beginning.next = through; beginning.state.tailComplete = false; beginning.state.complete = false; }
        }
        if (!older && !initial && !state.follow) state.unseen += added;
        if (state.follow) { state.unseen = 0; state.anchor = null; }
        if (initial) restoreHistoryPosition(state);
      } catch { state.response = failure('run.transcript', 'transcript_schema') as ReadResponse; }
    }
    state.busy = false;
    const current = selectedAgent();
    if (observed.raw && state.response === envelope && usable(envelope) && state.loaded && !state.tailComplete && state.catchup++ < 32 && alive && current && executionKey(current) === key && route === 'sessions') queueMicrotask(() => { void loadHistory(); });
    else state.catchup = 0;
    render();
  }
  /** Reads one forward prefix page and rejects missing, repeated or misattributed cursors. */
  async function loadBeginningPage(automatic = false): Promise<void> {
    const agent = selectedAgent(), beginning = currentBeginning();
    if (!agent || !beginning?.active || beginning.state.busy || beginning.next === null) return;
    const key = executionKey(agent), state = beginning.state, cursor = beginning.next;
    if (automatic) beginning.autoPages++; else beginning.autoPages = 0;
    const controller = new AbortController(); state.controller = controller; state.busy = true; render();
    const observed = await readTranscript({ agent_id: agent.id, view: 'blocks', cursor, limit: 40 }, controller.signal), envelope = observed.envelope;
    if (!alive || beginnings.get(key) !== beginning) return;
    if (state.controller !== controller) return;
    state.controller = null;
    if (controller.signal.aborted) { state.busy = false; const current = selectedAgent(); if (route === 'sessions' && current && executionKey(current) === key && beginning.active && !state.loaded) void loadBeginningPage(); render(); return; }
    state.response = envelope;
    if (usable(envelope)) {
      try {
        const page = transcriptPage(envelope.data, agent.id);
        if (page.raw.cursor !== cursor || (observed.raw ? page.raw.view != null && page.raw.view !== 'raw' : page.raw.view !== 'blocks') || page.raw.direction != null && page.raw.direction !== 'forward') throw new Error('transcript_cursor');
        let previous = cursor;
        for (const block of page.blocks) {
          const first = block.raw.first_seq ?? block.seq, last = block.raw.last_seq ?? block.seq;
          if (typeof first !== 'number' || !Number.isSafeInteger(first) || first <= previous || first > block.seq || last !== block.seq || !Number.isSafeInteger(block.seq)) throw new Error('transcript_order');
          previous = block.seq;
        }
        const next = page.raw.next_cursor;
        if (page.complete ? next != null : typeof next !== 'number' || !Number.isSafeInteger(next) || next <= cursor || next !== previous) throw new Error('transcript_continuation');
        const tail = histories.get(key), tailAhead = typeof tail?.resume === 'number' && tail.resume > previous;
        if (page.complete && tailAhead && previous === cursor) throw new Error('transcript_coverage_changed');
        const initial = !state.loaded, atEnd = state.windowEnd >= state.grouped.entries.length;
        state.blocks = initial ? page.blocks : mergeBlocks(state.blocks, page.blocks);
        regroupHistory(state); state.loaded = true; state.headComplete = true; state.tailComplete = page.complete && !tailAhead;
        if (initial) { state.anchor = null; state.selected = null; state.scroll = 0; state.windowStart = 0; state.windowEnd = Math.min(historyWindowSize(), state.grouped.entries.length); }
        else if (atEnd) state.windowEnd = Math.min(state.grouped.entries.length, state.windowEnd + Math.max(1, state.windowSize));
        state.partial ||= independentlyPartial(envelope);
        state.complete = state.tailComplete && !state.partial;
        beginning.next = page.complete ? tailAhead ? previous : null : next as number;
        restoreHistoryPosition(state, beginning.next !== null);
      } catch { state.response = failure('run.transcript', 'transcript_schema') as ReadResponse; }
    }
    state.busy = false;
    if (waitingWheel?.beginning === beginning) {
      const waiting = waitingWheel; waitingWheel = null;
      if (state.response && usable(state.response) && beginning.active && currentHistory() === state) {
        if (queuedWheel?.state === state) queuedWheel.rows += waiting.rows; else queuedWheel = { state, rows: waiting.rows };
      }
    }
    render();
  }
  /** Checks answer bytes, agent ID, sequence and SHA-256 without asserting an incarnation fence. */
  async function loadAnswer(): Promise<void> {
    const agent = selectedAgent(); if (!agent) return; const ownerKey = executionKey(agent), key = JSON.stringify([ownerKey, agent.answerSha]);
    let state = answers.get(key); if (!state) { state = { executionKey: ownerKey, controller: null, busy: false, loaded: false, content: null, issue: null, width: 0, chunk: 0, lines: null }; answers.set(key, state); }
    if (state.busy || state.loaded) return; state.busy = true; const controller = new AbortController(); state.controller = controller; render();
    const current = () => { const selected = selectedAgent(); return alive && !controller.signal.aborted && route === 'sessions' && tab === 'result' && answers.get(key) === state && !!selected && executionKey(selected) === ownerKey && selected.answerSha === agent.answerSha; };
    const envelope = await read('run.answer', { agent_id: agent.id }, controller.signal);
    if (!current()) { state.busy = false; state.controller = null; if (answers.get(key) === state) answers.delete(key); return; }
    if (!usable(envelope)) state.issue = `${envelope.outcome}: ${envelope.error?.message ?? 'Answer unavailable'}`;
    else {
      try {
        const metadata = object(envelope.data); let support = false;
        if (metadata.available === true) {
          const source = await read('run.identity', {}, controller.signal); support = usable(source) && supportsChunks(source.data);
          if (!support) throw new Error('answer_chunk_unsupported');
          if (metadata.inline_complete === true) {
            if (!agent.answerSha || !/^[a-f0-9]{64}$/.test(agent.answerSha)) throw new Error('answer_attribution_missing');
            const proof = await read('run.answer_chunk', { agent_id: agent.id, sequence: agent.sequence, expected_sha256: agent.answerSha, offset_bytes: 0, max_bytes: 65536 }, controller.signal);
            if (!usable(proof)) throw new Error('answer_chunk_unavailable');
            const chunk = object(proof.data), content = chunk.content;
            const bytes = typeof content === 'string' ? new TextEncoder().encode(content).byteLength : -1;
            if (chunk.agent_id !== agent.id || chunk.sequence !== agent.sequence || chunk.sha256 !== agent.answerSha || chunk.total_bytes !== metadata.size_bytes || chunk.offset_bytes !== 0 || typeof metadata.content !== 'string' || typeof content !== 'string' || !metadata.content.startsWith(content) || bytes > 65536 || chunk.next_offset !== bytes || typeof chunk.total_bytes !== 'number' || bytes > chunk.total_bytes || (chunk.total_bytes > 0 && bytes === 0) || chunk.complete !== (bytes === chunk.total_bytes)) throw new Error('answer_chunk_proof');
          }
        }
        state.content = await answerText(envelope.data, agent.id, agent.sequence, agent.answerSha, support, async params => {
          const chunk = await read('run.answer_chunk', params, controller.signal); if (!usable(chunk)) throw new Error('answer_chunk_unavailable'); return chunk.data;
        }, current);
      } catch (error) { state.issue = error instanceof Error ? error.message : 'answer_proof'; }
    }
    state.busy = false; state.controller = null;
    if (!current()) { if (answers.get(key) === state) answers.delete(key); return; }
    state.loaded = true; render();
  }
  /** Refreshes visible read-only sources; independent slots retain their own failures and timestamps. */
  function refresh(): void {
    if (route === 'overview' || route === 'sessions') { void inventory(agents, 'run.agents', agentPages, runPage, agent => agent.id); void inventoryActiveAgents(); }
    if (route === 'overview') {
      void observe(bridge, 'bridge.overview', {}, value => bridgeData(value, 'bridge_overview'));
      void observeBridgePages(deliveries, 'bridge.deliveries');
      void observeBridgePages(incidentMetric, 'bridge.incidents');
    }
    if (route === 'sessions') { if (detailFromRelated && boundTarget) void refreshRelated(boundTarget); ensureDefaultHistory(); void loadHistory(); if (tab === 'result') void loadAnswer(); }
    if (route === 'pools') {
      const poolId = pool;
      void inventoryPools();
      if (!agents.value && !agents.busy) { void inventory(agents, 'run.agents', agentPages, runPage, agent => agent.id); void inventoryActiveAgents(); }
      if (poolCapability(INVENTORY_SNAPSHOT_CAPABILITY) === true) void observe(poolTotals, 'pool.inventory_snapshot', { filter: 'all', limit: 1 }, value => inventorySnapshotPage(value, { filter: 'all', limit: 1, cursor: null }));
      if (!poolIdentity.good && !poolIdentity.busy) void observe(poolIdentity, 'pool.identity', {}, value => {
        const identity = product(value, 'identity');
        if (!Array.isArray(identity.capabilities) || identity.capabilities.some(value => typeof value !== 'string')) throw new Error('pool_identity');
        return identity;
      }).then(() => { if (alive && route === 'pools' && poolIdentity.good) refresh(); });
      if (poolId) {
        const section: PoolSection = poolTab === 'discussion' ? 'history' : poolTab;
        const fenced = section === 'members' || section === 'votes';
        const revision = poolCursor > 0 && fenced ? poolRevision : null;
        const params = { pool_id: poolId, section, after: section === 'criteria' ? String(poolCursor) : poolCursor, ...(section === 'members' && poolCapability('observer_socket_v1') !== true ? { include_bindings: true } : {}), ...(revision !== null ? { expected_revision: revision } : {}), ...(section === 'votes' && poolProposalId ? { proposal_id: poolProposalId } : {}) };
        const key = JSON.stringify(params);
        if (poolRequestKey !== key) { reset(poolDetail); poolRequestKey = key; }
        if (section === 'history' && poolHistorySupported() === true) void refreshPoolHistory(poolId);
        else if (section === 'criteria' ? poolCapability('structured_acceptance_v1') === true : section !== 'history' || poolHistorySupported() === false) {
          const observation = observe(poolDetail, 'pool.get', params, value => {
            const data = poolSection(value, poolId, section, poolCursor, revision);
            if (fenced && poolCursor === 0 && data.view) poolRevision = Number(object(object(data.view).pool).revision);
            return data;
          });
          if (section === 'members') void observation.then(() => { if (alive && route === 'pools' && poolRequestKey === key) void refreshPoolStatus(); });
          if (section === 'deliveries') void observation.then(() => { if (formerDeliveryKey && selectedFormerDelivery()?.key !== formerDeliveryKey) cancelPoolMemberRead(); });
        }
        if (poolTab === 'decisions' || poolTab === 'votes') {
          const proposal = { pool_id: poolId, section: 'proposal', after: 0, ...(poolProposalId ? { proposal_id: poolProposalId } : {}) };
          const key = JSON.stringify(proposal);
          if (poolProposalKey !== key) { reset(poolProposal); poolProposalKey = key; }
          void observe(poolProposal, 'pool.get', proposal, value => poolSection(value, poolId, 'proposal', 0, null));
        }
      }
    }
    if (route === 'overview' || route === 'quota') void observe(quota, 'quota.snapshot', {}, quotaSnapshot);
    if (route === 'worktree') {
      void inventory(agents, 'run.agents', agentPages, runPage, agent => agent.id); void inventoryActiveAgents();
      if (Date.now() - worktreesLoadedAt >= WORKTREE_REFRESH_MS) void loadWorktrees(); else void loadWorktreeFacts();
      if (worktreeOpen) {
        const params = { repo: worktreeOpen.repo, path: worktreeOpen.row.path }, key = JSON.stringify(params);
        if (worktreeInspectKey !== key) { reset(worktreeInspect); worktreeInspectKey = key; worktreeInspectAt = 0; }
        if (Date.now() - worktreeInspectAt >= WORKTREE_REFRESH_MS) { worktreeInspectAt = Date.now(); void observe(worktreeInspect, 'worktree.inspect', params, parseWorktreeDetail); }
      }
    }
    if (route === 'quota') void observe(quotaService, 'quota.status', {}, quotaStatus);
    if (route === 'incidents') { const key = JSON.stringify([bridgeAfter, bridgeThrough]); if (incidentRequestKey !== key) { reset(incidents); incidentRequestKey = key; } void observe(incidents, 'bridge.incidents', { limit: 100, after_seq: bridgeAfter, include_closed: true, ...(bridgeThrough === null ? {} : { through_seq: bridgeThrough }) }, value => bridgeData(value, 'incident_page')); }
  }
  /** Replaces the current poll timer without interrupting reads already in progress. */
  function schedulePolling(): void {
    if (pollingTimer !== null) clearInterval(pollingTimer);
    pollingTimer = setInterval(refresh, pollingIntervals[pollingIndex] * 1000);
  }
  /** Cycles the session's visible polling interval in ascending order. */
  function cyclePolling(): void { pollingIndex = (pollingIndex + 1) % pollingIntervals.length; schedulePolling(); render(); }
  /** Saves the current navigation location before a section or related-object transition. */
  function location(): Location { return { route, selected, boundSequence, boundTarget, detailFromRelated, focus, tab, full, pool, poolTab, poolMetadata, poolCursor, poolRevision, poolPrevious: [...poolPrevious], poolProposalId, poolScroll, poolMemberIndex, poolDeliveryIndex, poolDecisionIndex, poolVoteIndex, poolVoteMember, bridgeAfter, bridgeThrough, incidentScroll, query, filterFolder, filterProject, filterStatus, filterPeriodFailures, listTop, finishedOpen }; }
  /** Restores a navigation location without modifying its cached reading position. */
  function restore(value: Location): void {
    if (route === 'sessions') { cancelSessionReads(); cancelRelatedRead(); }
    if (route === 'pools') { cancelPoolMemberRead(); cancelPoolStatus(); closePoolContent(); }
    ({ route, selected, boundSequence, boundTarget, detailFromRelated, focus, tab, full, pool, poolTab, poolMetadata, poolCursor, poolRevision, poolPrevious, poolProposalId, poolScroll, poolMemberIndex, poolDeliveryIndex, poolDecisionIndex, poolVoteIndex, poolVoteMember, bridgeAfter, bridgeThrough, incidentScroll, query, filterFolder, filterProject, filterStatus, filterPeriodFailures, listTop, finishedOpen } = value);
    if (detailFromRelated && relatedAgent.value?.targetKey !== boundTarget?.key) reset(relatedAgent);
    else if (detailFromRelated && relatedAgent.good) relatedAgent.response = failure('run.status', 'status_rechecking') as ReadResponse;
    poolPrevious = [...poolPrevious];
    overlay = null;
    refresh(); render();
  }
  /** Moves to a section while preserving a real Back path. */
  function navigate(next: Route, prepare?: () => void): void { if (route === 'sessions' && (next !== 'sessions' || detailFromRelated)) cancelSessionReads(); if (route === 'sessions') cancelRelatedRead(); if (route === 'pools' && next !== 'pools') { cancelPoolMemberRead(); cancelPoolStatus(); closePoolContent(); } backStack.push(location()); forwardStack = []; route = next; focus = 'list'; full = false; boundSequence = null; boundTarget = null; detailFromRelated = false; overlay = null; if (next === 'incidents') { bridgeAfter = 0; bridgeThrough = null; incidentRequestKey = ''; } prepare?.(); refresh(); render(); }
  /** Invalidates a request key so another source/page cannot inherit its last-good data. */
  function reset<T>(state: Slot<T>): void { state.generation++; state.value = null; state.good = null; state.response = null; state.busy = false; }
  /** Filters loaded executions without inferring repository identities. */
  function matchingAgents(): RunAgent[] {
    const term = query.trim().toLocaleLowerCase(), folder = filterFolder.replace(/\/+$/, '') || filterFolder;
    return loadedAgents().filter(agent => {
      const matches = !term || [agent.name, agent.summary, agent.id, agent.model, agent.status, agent.workdir].some(value => value?.toLocaleLowerCase().includes(term));
      const workdir = agentWorkdir(agent), project = !filterProject || !!workdir && projectRoot(workdir.path) === filterProject;
      const path = !folder || !!agent.workdir && (agent.workdir === folder || agent.workdir.startsWith(folder === '/' ? '/' : folder + '/'));
      const [start, end] = bounds(period, Date.now());
      const inPeriod = !filterPeriodFailures || agent.finished !== null && agent.finished * 1000 >= start && agent.finished * 1000 < end;
      return matches && path && project && inPeriod && (!filterStatus || agent.status === filterStatus);
    });
  }
  /** Returns matching loaded executions grouped without changing source identity. */
  function visibleAgents(): RunAgent[] {
    const items = matchingAgents();
    return [...items.filter(agent => activeStatus(agent.status)), ...items.filter(agent => !activeStatus(agent.status) && !terminalStates.has(agent.status)), ...(finishedOpen ? items.filter(agent => terminalStates.has(agent.status)) : [])];
  }
  /** Labels a loaded-only finished count when the full source inventory is incomplete. */
  function finishedCount(items: RunAgent[]): string {
    const exact = !query && !filterFolder && !filterProject && !filterStatus && !filterPeriodFailures ? globalFinished() : null;
    const count = exact ?? items.filter(agent => terminalStates.has(agent.status)).length;
    return `${count}${exact === null && agents.value && !agents.value.complete ? ' loaded' : ''}`;
  }
  /** Filters and groups only the currently loaded Agent Pool inventory. */
  function visiblePools(): Record<string, unknown>[] { return groupPools(pools.value?.items ?? [], query).items; }
  /** Opens a selected execution without attributing content from a previous sequence. */
  function chooseAgent(id: string): void { const changed = selected !== id || detailFromRelated; if (changed) cancelSessionReads(); if (detailFromRelated) cancelRelatedRead(); selected = id; boundSequence = null; boundTarget = null; detailFromRelated = false; tab = 'history'; if (changed && currentBeginning()) jumpBeginning(false); else ensureDefaultHistory(); void loadHistory(); render(); }
  /** Opens a pool while invalidating the previous pool's keyed observation. */
  function choosePool(id: string): void { cancelPoolMemberRead(); cancelPoolStatus(); closePoolContent(); pool = id; poolTab = 'members'; poolMetadata = false; poolCursor = 0; poolRevision = null; poolPrevious = []; poolProposalId = null; poolMemberIndex = 0; poolDeliveryIndex = 0; poolDecisionIndex = 0; poolVoteIndex = 0; poolVoteMember = null; poolScroll = 0; poolRequestKey = ''; poolProposalKey = ''; refresh(); render(); }
  /** Keeps each pool tab and source page's reading position independent. */
  function poolPositionKey(): string { return JSON.stringify([pool, poolTab, poolCursor, poolProposalId]); }
  /** Saves the position and continuation separately for each section. */
  function savePoolPosition(): void {
    poolPositions.set(poolPositionKey(), poolScroll);
    poolPaging.set(JSON.stringify([pool, poolTab, poolProposalId]), { cursor: poolCursor, revision: poolRevision, previous: [...poolPrevious] });
  }
  /** Switches pool tabs while restoring the destination's previous scroll. */
  function setPoolTab(next: PoolTab): void { if (next !== poolTab) { cancelPoolMemberRead(); cancelPoolStatus(); } closePoolContent(); savePoolPosition(); poolTab = next; const page = poolPaging.get(JSON.stringify([pool, poolTab, poolProposalId])); poolCursor = page?.cursor ?? 0; poolRevision = page?.revision ?? null; poolPrevious = [...(page?.previous ?? [])]; poolScroll = poolPositions.get(poolPositionKey()) ?? 0; refresh(); render(); }
  /** Selects a precise archived proposal without moving the archive's own page. */
  function choosePoolProposal(id: string | null): void { savePoolPosition(); poolProposalId = id; poolVoteMember = null; poolVoteIndex = 0; poolProposalKey = ''; refresh(); render(); }
  /** Computes one loaded period count using only producer event clocks. */
  function runCount(status: 'finished' | 'failed'): string {
    if (!agents.value || !agents.good) return 'Unknown';
    const [start, end] = bounds(period, Date.now());
    if (agents.good.observed_at_ms < start) return 'STALE · Unknown';
    const observedEnd = Math.min(end, agents.good.observed_at_ms + 1);
    const rows = agents.value.items.filter(agent => terminalStates.has(agent.status) && (status === 'finished' || agent.status === 'failed'));
    const count = rows.filter(agent => agent.finished !== null && agent.finished * 1000 >= start && agent.finished * 1000 < observedEnd).length;
    const partial = !agents.value.complete || independentlyPartial(agents.good) || rows.some(agent => agent.finished === null || agent.finished * 1000 > agents.good!.observed_at_ms) || agents.value.items.some(agent => !activeStatus(agent.status) && !terminalStates.has(agent.status)) || period === 'Yesterday' && agents.good.observed_at_ms < end;
    return `${agents.response !== agents.good ? 'STALE · ' : ''}${count} loaded${partial ? ' · partial' : ''}`;
  }
  /** Computes Bridge period metrics only from retained rows with their explicit event clocks. */
  function bridgeCount(state: Slot<Record<string, unknown>>, field: 'deliveries' | 'incidents', clock: string): string {
    if (!state.value || !state.good) return 'Unknown'; const rows = state.value[field]; if (!Array.isArray(rows)) return 'Unknown';
    const [start, end] = bounds(period, Date.now()); let missing = false;
    if (state.good.observed_at_ms < start) return 'STALE · Unknown';
    const observedEnd = Math.min(end, state.good.observed_at_ms + 1);
    const count = rows.filter(value => { const row = object(value), at = row[clock]; if (typeof at !== 'number' || !Number.isFinite(at) || at > state.good!.observed_at_ms) { missing = true; return false; } return at >= start && at < observedEnd; }).length;
    const partial = missing || state.value.next_after_seq !== null || state.value.scan_partial === true || state.good.outcome === 'partial' || period === 'Yesterday' && state.good.observed_at_ms < end;
    return `${state.response !== state.good ? 'STALE · ' : ''}${partial && count === 0 ? 'Unknown' : `${partial ? '≥' : ''}${count} retained`}${partial ? ' · partial' : ''}`;
  }
  /** Summarizes each independently read source without implying another read succeeded. */
  function sourceState<T>(state: Slot<T>): string { return state.good && state.response !== state.good ? 'stale' : state.response?.outcome ?? 'loading'; }
  /** Adds a clipped, selectable text row and returns it, or null when outside the screen. */
  function textAt(parent: BoxRenderable, x: number, y: number, width: number, value: unknown, options: { color?: string; bg?: string; bold?: boolean; click?: () => void; hover?: boolean; overlay?: boolean } = {}): TextRenderable | null {
    if (width <= 0 || y < 0 || y >= renderer.height) return null;
    const base = options.bg ?? C.bg;
    const text = new TextRenderable(renderer, { position: 'absolute', left: x, top: y, width, height: 1, content: clip(value, width), fg: options.color ?? C.text, bg: base, attributes: options.bold ? TextAttributes.BOLD : TextAttributes.NONE, wrapMode: 'none', truncate: true, selectable: true, onMouseDown: options.click ? event => { if (overlay && !options.overlay) return; clearHistoryWheel(); pointer = { x: event.x, y: event.y }; options.click?.(); } : undefined });
    if (options.click && options.hover !== false) {
      text.onMouseOver = event => { pointer = { x: event.x, y: event.y }; if (!overlay || options.overlay) text.bg = base === C.selected ? C.hoverSelected : C.hover; };
      text.onMouseOut = event => { pointer = { x: event.x, y: event.y }; text.bg = base; };
    }
    parent.add(text); return text;
  }
  /** Adds a bounded neutral panel without an outline; dimensions are terminal cells. */
  function panel(parent: BoxRenderable, x: number, y: number, width: number, height: number, title: string): BoxRenderable {
    const box = new BoxRenderable(renderer, { position: 'absolute', left: x, top: y, width, height, backgroundColor: C.panel });
    parent.add(box);
    if (title) textAt(box, 2, 0, width - 4, title, { color: C.text, bg: C.panel, bold: true });
    return box;
  }
  /** Adds a borderless surface behind a region measured in terminal cells. */
  function surface(parent: BoxRenderable, x: number, y: number, width: number, height: number, background: string): void {
    if (width <= 0 || height <= 0) return;
    parent.add(new BoxRenderable(renderer, { position: 'absolute', left: x, top: y, width, height, backgroundColor: background }));
  }
  /** Displays bounded lines inside a scrollable surface, including empty cells. */
  function lineViewport(parent: BoxRenderable, x: number, y: number, width: number, height: number, lines: Line[], scroll: number, onScroll: (delta: number) => void, background = C.bg, gutter = 0, hoverKey?: (line: Line) => string | undefined, onWheel?: (event: MouseEvent) => void): void {
    const left = Math.min(x, gutter), right = Math.min(renderer.width - x - width, gutter);
    const viewport = new BoxRenderable(renderer, { position: 'absolute', left: x - left, top: y, width: width + left + right, height, backgroundColor: background, onMouseScroll: event => { if (onWheel) onWheel(event); else if (event.scroll?.direction === 'up') onScroll(-3); else if (event.scroll?.direction === 'down') onScroll(3); } });
    parent.add(viewport);
    const groups = new Map<string, { box: BoxRenderable; text: TextRenderable | null; base: string }[]>();
    let hovered: string | null = null, underPointer: string | null = null;
    /** Updates all visible rows belonging to the item under the pointer. */
    const setHover = (key: string | null) => {
      if (hovered === key) return;
      for (const [id, rows] of groups) for (const row of rows) {
        const color = id === key ? row.base === C.selected ? C.hoverSelected : C.hover : row.base;
        row.box.backgroundColor = color; if (row.text) row.text.bg = color;
      }
      hovered = key; renderer.requestRender();
    };
    for (let row = 0; row < height; row++) {
      const line = lines[scroll + row]; if (!line) break;
      const base = line.bg ?? background, group = hoverKey?.(line);
      let text: TextRenderable | null;
      if (group) {
        const box = new BoxRenderable(renderer, { position: 'absolute', left, top: row, width, height: 1, backgroundColor: base,
          onMouseOver: event => { pointer = { x: event.x, y: event.y }; if (!overlay) setHover(group); },
          onMouseOut: event => { pointer = { x: event.x, y: event.y }; const within = groups.get(group)?.some(item => event.x >= item.box.x && event.x < item.box.x + item.box.width && event.y >= item.box.y && event.y < item.box.y + item.box.height); if (!within && hovered === group) setHover(null); },
        });
        viewport.add(box);
        text = textAt(box, 0, 0, width, line.text, { color: line.color, bg: base, bold: line.bold, click: line.action, hover: false });
        const members = groups.get(group) ?? []; members.push({ box, text, base }); groups.set(group, members);
        if (pointer && pointer.x >= x && pointer.x < x + width && pointer.y === y + row) underPointer = group;
      } else {
        if (line.bg && line.bg !== background) surface(viewport, left, row, width, 1, line.bg);
        if (line.spans) {
          text = null;
          let column = 0;
          for (const part of line.spans) { textAt(viewport, left + column, row, width - column, part.text, { color: part.color, bg: base, bold: part.bold, ...line.action ? { click: line.action, hover: false } : {} }); column += stringWidth(part.text); }
        } else text = textAt(viewport, left, row, width, line.text, { color: line.color, bg: base, bold: line.bold, click: line.action });
      }
      if (line.spinner && text) spinnerRows.push({ text, value: clip(line.text, width) });
    }
    if (underPointer && !overlay) setHover(underPointer);
  }
  /** Adds source text as wrapped, anchorable lines without discarding any content. */
  function addWrapped(lines: Line[], value: string, width: number, options: Omit<Line, 'text' | 'offset'> = {}): void { for (const part of wrap(value, width)) lines.push({ ...options, text: part.text, offset: part.offset }); }
  /** Draws the overview's two independent source panels and explicit attention actions. */
  function drawOverview(parent: BoxRenderable): void {
    const w = renderer.width, h = renderer.height, left = 2, width = Math.max(1, w - 4), body = Math.max(12, h - 7);
    textAt(parent, left, 2, width, `Overview    Period: ${period}  [p]    Local timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`, { color: C.muted });
    if (h < 24) {
      const active = activeCount();
      const compact = (value: string) => value.replace(' loaded', '').replace(' retained', '').replace(' · partial', ' partial').replace('STALE · ', 'stale ');
      const compactSource = (y: number, title: string, values: string[], coverage: string) => {
        const box = panel(parent, left, y, width, 4, title), cellWidth = Math.floor((width - 2) / 3);
        values.forEach((value, index) => textAt(box, index * cellWidth, 1, cellWidth, value, { bg: C.panel }));
        textAt(box, 0, 2, width - 2, coverage, { color: C.muted, bg: C.panel });
      };
      compactSource(3, 'Agent Run', [`Active: ${active}`, `Finished: ${compact(runCount('finished'))}`, `Failed: ${compact(runCount('failed'))}`], runFailed() ? notice(agents) : `Failed included in finished · ${notice(agents)}`);
      compactSource(7, 'Agent Bridge', [`Intake: ${compact(bridgeCount(deliveries, 'deliveries', 'accepted_at_ms'))}`, 'Pending: Unknown', `Incidents: ${compact(bridgeCount(incidentMetric, 'incidents', 'created_ms'))}`], `Retained by Bridge · ${notice(bridge)}`);
      const attention = panel(parent, left, 11, width, 4, 'Needs attention');
      textAt(attention, 0, 1, width - 2, `${attentionIndex === 0 ? '›' : ' '} Failed executions: ${compact(runCount('failed'))} [Open]`, { color: C.error, bg: C.panel, click: () => openAttention(0) });
      textAt(attention, 0, 2, width - 2, `${attentionIndex === 1 ? '›' : ' '} Bridge incidents: ${compact(bridgeCount(incidentMetric, 'incidents', 'created_ms'))} [Open]`, { color: C.error, bg: C.panel, click: () => openAttention(1) });
      return;
    }
    const quotaCard = h >= 32, cardH = quotaCardHeight(), sourceH = Math.min(10, Math.max(5, Math.floor((body - (quotaCard ? 7 + cardH + 1 : 7)) / 2))), attentionY = 4 + sourceH * 2 + 2 + (quotaCard ? cardH + 1 : 0), attentionH = Math.min(8, Math.max(4, h - attentionY - 1));
    /** Renders three equal metric cells inside one independently bounded source panel. */
    const drawSource = (title: string, y: number, names: string[], values: string[], coverage: string, action: { label: string; open: () => void }) => {
      const compact = sourceH <= 7, box = panel(parent, left, y, width, sourceH, compact ? title : ''), inner = width - 4, cellWidth = Math.floor((inner - 2) / 3), cellHeight = compact ? 2 : Math.max(3, sourceH - 5);
      if (!compact) { textAt(box, 2, 0, Math.max(1, width - 30), title, { color: C.text, bg: C.panel, bold: true }); textAt(box, Math.max(0, width - 25), 0, 21, action.label, { color: C.accent, bg: C.panel, click: action.open }); }
      names.forEach((name, index) => {
        const x = 1 + index * (cellWidth + 1), cell = new BoxRenderable(renderer, { position: 'absolute', left: x, top: compact ? 1 : 2, width: cellWidth, height: cellHeight, backgroundColor: C.cell });
        box.add(cell);
        const value = values[index].includes('partial') || values[index].includes('STALE') ? values[index] : values[index].replace(' loaded', '').replace(' retained', '');
        const positive = /(?:^|\D)[1-9]\d*/.test(value), valueColor = /Unknown/i.test(value) ? C.muted : index === 0 && title === 'Agent Run' && positive ? C.good : index === 2 && positive ? C.error : C.text;
        if (compact) {
          textAt(cell, 1, 0, cellWidth - 2, name.split(' · ')[0], { color: C.muted, bg: C.cell });
          textAt(cell, 1, 1, cellWidth - 2, value, { color: valueColor, bg: C.cell, bold: true });
        }
        else {
          textAt(cell, 1, 0, cellWidth - 2, name, { color: C.muted, bg: C.cell });
          textAt(cell, 1, cellHeight >= 5 ? 2 : 1, cellWidth - 2, value, { color: valueColor, bg: C.cell, bold: true });
        }
      });
      textAt(box, 2, sourceH - 2, width - 4, coverage, { color: C.muted, bg: C.panel });
    };
    const active = activeCount();
    drawSource('Agent Run', 4, ['Active · now', `Finished · ${period}`, `Failed · ${period}`], [active, runCount('finished'), runCount('failed')], runFailed() ? `${notice(agents)} · ${agents.value ? `${agents.value.items.length} loaded / ${agents.value.total} reported` : 'coverage unknown'}` : `${agents.value ? `${agents.value.items.length} loaded / ${agents.value.total} reported` : 'coverage unknown'} · failed included in finished · ${notice(agents)}`, { label: 'Open sessions →', open: () => navigate('sessions') });
    drawSource('Agent Bridge', 5 + sourceH, [`Accepted by Bridge · ${period}`, 'Pending · now', `Incidents · ${period}`], [bridgeCount(deliveries, 'deliveries', 'accepted_at_ms'), 'Unknown', bridgeCount(incidentMetric, 'incidents', 'created_ms')], `${notice(bridge)} · Retained by Bridge · deliveries ${sourceState(deliveries)} · incidents ${sourceState(incidentMetric)}`, { label: 'View incidents →', open: () => navigate('incidents') });
    if (quotaCard) drawQuotaCard(parent, left, 6 + sourceH * 2, width);
    const attention = panel(parent, left, attentionY, width, attentionH, '');
    const failed = runCount('failed'), incident = bridgeCount(incidentMetric, 'incidents', 'created_ms');
    textAt(attention, 2, 0, width - 4, 'Needs attention', { color: C.text, bg: C.panel, bold: true });
    for (const [index, label, value] of [[0, 'Failed executions', failed], [1, 'Bridge incidents', incident]] as const) {
      if (index === 1 && attentionH <= 4) continue;
      const row = index + 2, background = attentionIndex === index ? C.dangerSelected : C.danger;
      surface(attention, 1, row, width - 4, 1, background);
      textAt(attention, 1, row, width - 4, `${attentionIndex === index ? '›' : ' '} ${label}: ${value} · ${period}`, { color: C.error, bg: background, click: () => openAttention(index) });
      if (width >= 65) textAt(attention, width - 12, row, 8, 'Open →', { color: C.accent, bg: background, click: () => openAttention(index) });
    }
  }
  /** Lists every configured repository (or every repository Worktree knows) page by page. */
  async function loadWorktrees(): Promise<void> {
    if (!alive || worktreesBusy) return;
    worktreesBusy = true; worktreesLoadedAt = Date.now(); const generation = ++worktreeGeneration; render();
    await observe(repositories, 'hub.repositories', {}, repositoriesData);
    const repos: (string | null)[] = repositories.value?.length ? repositories.value : [null], groups: WorktreeGroup[] = [];
    for (const repo of repos) {
      const group: WorktreeGroup = { repo, rows: [], coverage: null, partial: false, error: null };
      let cursor: string | null = null;
      for (let page = 0; page < WORKTREE_PAGES; page++) {
        const envelope = await read('worktree.list', { ...(repo ? { repo } : {}), limit: 20, ...(cursor ? { cursor } : {}) });
        if (!alive || generation !== worktreeGeneration) { worktreesBusy = false; return; }
        if (!usable(envelope)) { group.error = `${envelope.outcome}${envelope.error?.code ? ` [${safe(envelope.error.code)}]` : ''}: ${safe(envelope.error?.message ?? 'Read failed')}`; cursor = null; break; }
        try {
          const data = worktreePage(envelope.data);
          group.rows.push(...data.rows); group.coverage = data.coverage; if (envelope.outcome === 'partial') group.partial = true;
          cursor = data.hasMore && data.cursor ? data.cursor : null;
        } catch { group.error = 'invalid [producer_schema]: Worktree page did not match the read contract.'; cursor = null; }
        if (!cursor) break;
      }
      if (cursor) group.partial = true;
      groups.push(group);
    }
    worktreeGroups = groups; worktreesBusy = false; worktreeIndex = Math.min(worktreeIndex, Math.max(0, worktreeRows().length - 1)); render();
    void loadWorktreeFacts();
  }
  /** Reads each present worktree's status counts and size one at a time while the tab is open, nearest the selection first.
   * One inspect per worktree is bounded by agent-worktree (deadline and entry budget, read-only); results are cached for
   * {@link WORKTREE_FACTS_TTL_MS}, so the periodic refresh never rescans disks. Failures are cached too and shown as unknown. */
  async function loadWorktreeFacts(): Promise<void> {
    if (!alive || worktreeFactsBusy) return;
    worktreeFactsBusy = true;
    try {
      for (;;) {
        if (!alive || route !== 'worktree') break;
        const entries = orderedWorktrees(worktreeProjects()), selectedRepo = entries.find(view => view.key === worktreeKey)?.repo;
        const now = Date.now(), due = entries.filter(view => view.present && view.path && now - (worktreeFactsAt.get(view.key) ?? 0) >= WORKTREE_FACTS_TTL_MS);
        const next = due.find(view => view.repo === selectedRepo) ?? due[0];
        if (!next) break;
        worktreeFactsAt.set(next.key, Date.now());
        if (worktreeFacts.get(next.key)?.state !== 'ready') worktreeFacts.set(next.key, { state: 'pending' });
        render();
        const envelope = await read('worktree.inspect', { repo: next.repo ?? next.path, path: next.path, checks: { status: true, size: true } });
        if (!alive) break;
        let entry: FactsEntry;
        if (!usable(envelope)) entry = { state: 'failed', code: safe(envelope.error?.code ?? envelope.outcome) };
        else { try { entry = { state: 'ready', facts: parseWorktreeFacts(parseWorktreeDetail(envelope.data)) }; } catch { entry = { state: 'failed', code: 'producer_schema' }; } }
        const previous = worktreeFacts.get(next.key);
        worktreeFacts.set(next.key, entry.state === 'failed' && previous?.state === 'ready' ? previous : entry);
        render();
      }
    } finally { worktreeFactsBusy = false; if (alive) render(); }
  }
  /** Builds the project cards from the listed rows, cached facts and loaded Run sessions. */
  function worktreeProjects(): ProjectView[] {
    const listed = worktreeGroups.flatMap(group => group.rows), loaded = loadedAgents();
    return projectViews(worktreeGroups, worktreeFacts, row => { const linked = linkedSessions(row, listed, loaded); return { total: linked.length, active: linked.filter(agent => activeStatus(agent.status)).length }; });
  }
  /** Index of the selected worktree in display order; the selection follows its key when the order changes as facts arrive. */
  function worktreeSelected(count: number): number {
    const found = worktreeKey === null ? -1 : orderedWorktrees(worktreeProjects()).findIndex(view => view.key === worktreeKey);
    return Math.max(0, Math.min(count - 1, found >= 0 ? found : worktreeIndex));
  }
  /** Moves the selection by `delta` worktrees in display order. */
  function moveWorktree(delta: number): void {
    const entries = orderedWorktrees(worktreeProjects()); if (!entries.length) return;
    worktreeIndex = Math.max(0, Math.min(entries.length - 1, worktreeSelected(entries.length) + delta)); worktreeKey = entries[worktreeIndex]!.key;
  }
  /** Flattens listed rows with their repository scope, in display order. */
  function worktreeRows(): { row: WorktreeRow; repo: string | null }[] { return orderedWorktrees(worktreeProjects()).map(view => ({ row: view.row, repo: view.repo })); }
  /** Opens the inspect detail for one listed row; orphan and missing rows have no Git registration to inspect. */
  function openWorktree(index: number): void {
    const entry = worktreeRows()[index]; if (!entry?.row.path) return;
    worktreeIndex = index; worktreeKey = entry.row.key; worktreeOpen = { row: entry.row, repo: entry.repo ?? entry.row.path }; worktreeSessionIndex = 0; worktreeScroll = 0; refresh(); render();
  }
  /** Opens one Run session from a worktree link, clearing list filters so it is visible. */
  function openSession(id: string): void {
    navigate('sessions', () => {
      filterStatus = ''; filterPeriodFailures = false; filterFolder = ''; filterProject = ''; query = ''; finishedOpen = true;
      if (id !== selected) cancelSessionReads();
      selected = id;
      if (currentBeginning()) jumpBeginning(false); else ensureDefaultHistory();
      void loadHistory();
    });
  }
  /** Draws the per-repository worktree list or one worktree's detail with its linked sessions. */
  function drawWorktree(parent: BoxRenderable): void {
    const width = renderer.width - 4, height = renderer.height - 6, lines: Line[] = [], allRows = worktreeGroups.flatMap(group => group.rows), agentsLoaded = loadedAgents();
    if (worktreeOpen) {
      const open = worktreeOpen, linked = linkedSessions(open.row, allRows, agentsLoaded);
      worktreeSessionIndex = Math.max(0, Math.min(worktreeSessionIndex, linked.length - 1));
      textAt(parent, 2, 2, width, `Agent Worktree · ${open.row.key}`, { bold: true });
      lines.push({ text: notice(worktreeInspect), color: C.muted });
      const measured = worktreeFacts.get(open.row.key), sizeText = measured?.state === 'ready' ? sizeSummary(measured).text.replace(/^size /, '') : undefined;
      if (worktreeInspect.value) for (const line of detailLines(worktreeInspect.value, Date.now() / 1000, sizeText)) addWrapped(lines, safe(line), width);
      lines.push({ text: '' }, { text: `Run sessions in this worktree (${linked.length}) · ${notice(agents)}`, bold: true, color: C.accent });
      if (!linked.length) lines.push({ text: 'No loaded Run session has its workdir in this worktree.', color: C.muted });
      linked.forEach((agent, index) => lines.push({ text: `${index === worktreeSessionIndex ? '›' : ' '} ${safe(agent.status).padEnd(10)} ${safe(agent.name ?? agent.id)} · ${safe(agent.workdir)}`, color: activeStatus(agent.status) ? C.good : C.text, bg: index === worktreeSessionIndex ? C.selected : undefined, action: () => openSession(agent.id) }));
    } else {
      const projects = worktreeProjects(), entries = orderedWorktrees(projects), selectedIndex = worktreeSelected(entries.length), selectedKey = entries[selectedIndex]?.key ?? null;
      const toggle = `[d] Technical details ${worktreeDetails ? '▾' : '▸'}`;
      textAt(parent, 2, 2, Math.max(1, width - toggle.length - 2), `Agent Worktree · ${repositories.value?.length ? `${repositories.value.length} configured repositories` : 'all repositories known to Worktree'}`, { bold: true });
      textAt(parent, 2 + Math.max(0, width - toggle.length), 2, toggle.length, toggle, { color: C.accent, click: () => { worktreeDetails = !worktreeDetails; render(); } });
      lines.push({ text: projects.length ? `${tabSummaryText(tabSummary(projects))}${worktreeFactsBusy ? ' · measuring size and changes…' : ''}` : worktreesBusy ? 'Loading worktrees…' : `Not observed · ${notice(repositories)}`, color: C.muted });
      const indexOf = new Map(entries.map((view, index) => [view.key, index] as const));
      let first = -1, last = -1;
      for (const row of worktreeBody(projects, width, selectedKey)) {
        const index = row.key === undefined ? undefined : indexOf.get(row.key), chosen = row.key !== undefined && row.key === selectedKey;
        if (chosen) { if (first < 0) first = lines.length; last = lines.length; }
        lines.push({ text: row.spans.map(item => item.text).join(''), bg: chosen ? C.selected : row.card ? C.panel : undefined, spans: row.spans.map(item => ({ text: item.text, color: toneColor(item.tone), bold: item.bold })), ...index === undefined ? {} : { action: () => openWorktree(index) } });
      }
      if (worktreeDetails) {
        lines.push({ text: '' }, { text: 'Technical details (raw producer codes)', bold: true });
        for (const line of technicalLines(worktreeGroups, projects, worktreeFacts)) addWrapped(lines, safe(line.text), width, { color: toneColor(line.tone), bold: line.bold });
      }
      if (first >= 0) { if (first < worktreeScroll) worktreeScroll = first; else if (last + 1 > worktreeScroll + height) worktreeScroll = Math.min(first, last + 1 - height); }
      lines.push({ text: '' }, { text: 'Read-only: no worktree is created, removed or pruned.', color: C.muted });
    }
    worktreeScroll = Math.max(0, Math.min(worktreeScroll, Math.max(0, lines.length - height)));
    lineViewport(parent, 2, 4, width, height, lines, worktreeScroll, delta => { worktreeScroll = Math.max(0, Math.min(Math.max(0, lines.length - height), worktreeScroll + delta)); render(); });
  }
  /** Maps a display tone to the active palette. */
  function toneColor(value: Tone): string { return value === 'muted' ? C.muted : value === 'good' ? C.good : value === 'warn' ? C.warn : value === 'error' ? C.error : value === 'accent' ? C.accent : C.text; }
  /** Number of account lines the Overview Quota card shows (at least one). */
  function quotaCardAccounts(): number { return Math.max(1, Math.min(4, quota.value?.accounts.length ?? 1)); }
  /** Height of the Overview Quota card: title, account lines and a coverage footer. */
  function quotaCardHeight(): number { return quotaCardAccounts() + 3; }
  /** Draws the Quota card: one line per account with a mini bar of its most constraining window.
   * Unknown accounts keep an empty dim bar and are never shown as capacity. */
  function drawQuotaCard(parent: BoxRenderable, left: number, y: number, width: number): void {
    const box = panel(parent, left, y, width, quotaCardHeight(), ''), inner = width - 4;
    textAt(box, 2, 0, Math.max(1, width - 30), 'Agent Quota', { color: C.text, bg: C.panel, bold: true });
    textAt(box, Math.max(0, width - 25), 0, 21, 'Open quota →', { color: C.accent, bg: C.panel, click: () => navigate('quota') });
    const barWidth = Math.max(6, Math.min(20, Math.floor(inner / 6))), rows = overviewRows(quota.value, Date.now() / 1000, barWidth);
    const nameWidth = Math.min(Math.max(8, ...rows.map(row => stringWidth(row.account))), Math.max(8, Math.floor(inner / 4)));
    rows.slice(0, quotaCardAccounts()).forEach((row, index) => {
      const line = 1 + index, badge = `[${row.badge}]`, badgeX = width - 2 - badge.length, barX = 2 + nameWidth + 2, textX = barX + barWidth + 2;
      textAt(box, 2, line, nameWidth, row.account, { color: C.text, bg: C.panel, bold: true });
      let column = barX;
      for (const part of barSpans(row.bar, row.tone)) { textAt(box, column, line, barWidth - (column - barX), part.text, { color: toneColor(part.tone), bg: C.panel, bold: part.bold }); column += stringWidth(part.text); }
      textAt(box, textX, line, badgeX - textX - 1, row.text + (row.window ? ` · ${row.window}` : ''), { color: toneColor(row.tone), bg: C.panel });
      textAt(box, badgeX, line, badge.length, badge, { color: toneColor(row.badgeTone), bg: C.panel, bold: true });
    });
    if (!rows.length) textAt(box, 2, 1, inner, quota.value ? 'No accounts reported by Quota.' : 'Unknown · no quota snapshot yet', { color: C.muted, bg: C.panel });
    const more = rows.length - quotaCardAccounts();
    textAt(box, 2, quotaCardAccounts() + 1, inner, `${more > 0 ? `+${more} more accounts · ` : ''}${quota.value ? `${quota.value.accounts.length} accounts · coverage ${quota.value.coverage.state}` : 'coverage unknown'} · ${notice(quota)}`, { color: C.muted, bg: C.panel });
  }
  /** Draws the Quota tab: one block per account with a bar per window; technical details are collapsed by default. */
  function drawQuota(parent: BoxRenderable): void {
    const width = renderer.width - 4, height = renderer.height - 6, lines: Line[] = [];
    const toggle = `[d] Technical details ${quotaDetails ? '▾' : '▸'}`;
    textAt(parent, 2, 2, Math.max(1, width - toggle.length - 2), 'Agent Quota · accounts and windows', { bold: true });
    textAt(parent, 2 + Math.max(0, width - toggle.length), 2, toggle.length, toggle, { color: C.accent, click: () => { quotaDetails = !quotaDetails; render(); } });
    lines.push({ text: `Snapshot: ${notice(quota)}`, color: C.muted }, { text: '' });
    for (const row of quotaRows(quota.value, Date.now() / 1000, width)) lines.push({ text: row.spans.map(item => item.text).join(''), bg: row.card ? C.panel : undefined, spans: row.spans.map(item => ({ text: item.text, color: toneColor(item.tone), bold: item.bold })) });
    if (quotaDetails) {
      lines.push({ text: '' }, { text: 'Technical details', bold: true }, { text: `Service: ${notice(quotaService)}`, color: C.muted }, { text: '' });
      for (const line of quotaLines(quota.value, quotaService.value, Date.now() / 1000)) addWrapped(lines, line.text, width, { color: toneColor(line.tone), bold: line.bold });
    }
    quotaScroll = Math.max(0, Math.min(quotaScroll, Math.max(0, lines.length - height)));
    lineViewport(parent, 2, 4, width, height, lines, quotaScroll, delta => { quotaScroll = Math.max(0, Math.min(Math.max(0, lines.length - height), quotaScroll + delta)); render(); });
  }
  /** Reports whether the latest Run inventory read failed, so its diagnosis leads the card. */
  function runFailed(): boolean { return !!agents.response && agents.response.outcome !== 'ok' && agents.response.outcome !== 'partial'; }
  /** Opens an attention item with a source-specific filter or retained evidence. */
  function openAttention(index: number): void {
    if (index !== 0) { navigate('incidents'); return; }
    navigate('sessions', () => {
      filterStatus = 'failed'; filterPeriodFailures = true; filterFolder = ''; filterProject = ''; query = ''; finishedOpen = true;
      const next = visibleAgents()[0]?.id ?? null;
      if (next !== selected) cancelSessionReads();
      selected = next;
      if (currentBeginning()) jumpBeginning(false); else ensureDefaultHistory();
      void loadHistory();
    });
  }
  let historyLines: Line[] = [], historyHeight = 1, historyWidth = 1;
  /** Keeps the rendered block window proportional to the available rows. */
  function historyWindowSize(): number { return Math.max(HISTORY_WINDOW, Math.ceil(historyHeight / 2)); }
  /** Produces message rows, preserving source order, partial markers and expandable complete text. */
  function messageLines(state: History, width: number): Line[] {
    const lines: Line[] = [], size = historyWindowSize(), entries = state.grouped.entries;
    const used = new Set<string>();
    /** Reuses wrapped source text while its content and pane width are unchanged. */
    const cachedWrap = (key: string, content: string, columns: number) => {
      used.add(key); const prior = state.wraps.get(key);
      if (prior && prior.content === content && prior.width === columns) return prior.lines;
      const wrapped = wrap(content, columns); state.wraps.set(key, { content, width: columns, lines: wrapped }); return wrapped;
    };
    if (state.follow) {
      state.windowEnd = entries.length; state.windowStart = Math.max(0, state.windowEnd - size);
      const selectedIndex = state.selected === null ? undefined : state.grouped.byKey.get(state.selected);
      if (state.selected && (selectedIndex === undefined || selectedIndex < state.windowStart || selectedIndex >= state.windowEnd)) state.selected = entries.at(-1)?.head.key ?? null;
    }
    else if (state.anchor) {
      const index = state.grouped.byKey.get(state.anchor.key);
      if (index !== undefined && (index < state.windowStart || index >= state.windowEnd)) { state.windowStart = index; state.windowEnd = Math.min(entries.length, index + size); }
    }
    if (!state.follow && size !== state.windowSize) {
      const index = state.anchor ? state.grouped.byKey.get(state.anchor.key) : undefined;
      if (index === undefined) { state.windowEnd = Math.min(entries.length, state.windowStart + size); state.windowStart = Math.max(0, state.windowEnd - size); }
      else { state.windowStart = Math.max(0, index - size); state.windowEnd = Math.min(entries.length, index + size + 1); }
    }
    if (!state.follow && entries.length && state.windowEnd === 0) state.windowEnd = Math.min(entries.length, size);
    state.windowSize = size;
    state.windowStart = Math.min(state.windowStart, Math.max(0, entries.length - 1));
    state.windowEnd = Math.min(entries.length, Math.max(state.windowEnd, Math.min(entries.length, state.windowStart + 1)));
    for (const entry of entries.slice(state.windowStart, state.windowEnd)) {
      const block = entry.head;
      const raw = block.raw, tool = block.role === 'tool_call' || block.role === 'tool_result' || block.role === 'tool';
      const user = block.role === 'user', assistant = block.role === 'assistant';
      const keys = [block, ...entry.calls, ...entry.results].map(value => value.key);
      const expanded = keys.some(key => state.expanded.has(key));
      const selectedMark = focus === 'history' && state.selected !== null && keys.includes(state.selected) ? '›' : ' ';
      const toggle = () => toggleHistoryEntry(state, block.key);
      if (tool) {
        const firstLine = lines.length;
        const input = entry.calls.length ? toolInput(entry) : [], output = toolOutput(entry);
        const resultBlocks = entry.results.length ? entry.results : block.role === 'tool' ? [block] : [];
        const status = !resultBlocks.length ? 'result not loaded' : resultBlocks.some(item => item.raw.error === true) ? 'error' : resultBlocks.every(item => item.raw.error === false) ? 'ok' : 'unknown';
        const preview = toolPreview(entry, width) || (entry.calls.length && entry.calls.every(item => item.content.length === 0) ? 'input not recorded' : ''), outputKey = entry.results[0]?.key ?? block.key;
        const count = Math.max(1, Math.ceil(segmentLength(output) / RESULT_CHUNK)), part = Math.min(state.parts.get(outputKey) ?? 0, count - 1);
        const name = typeof raw.name === 'string' && raw.name ? raw.name : block.role;
        const start = entry.calls.length && state.grouped.partialBefore.has(entry.calls[0].key) ? null : block.at;
        const finalResult = entry.results.at(-1);
        // A projected multi-row block retains its first timestamp, not the last result's time.
        const firstSeq = finalResult?.raw.first_seq, lastSeq = finalResult?.raw.last_seq;
        const oneResult = firstSeq == null && lastSeq == null || typeof firstSeq === 'number' && Number.isSafeInteger(firstSeq) && firstSeq >= 0 && typeof lastSeq === 'number' && lastSeq === finalResult?.seq && firstSeq === lastSeq;
        const verified = finalResult ? state.toolTimes.get(resultTimeKey(finalResult))?.at ?? null : null;
        const end = finalResult && !state.grouped.partialAfter.has(finalResult.key) ? oneResult ? finalResult.at : verified : null;
        const startTime = toolTime(start), endTime = toolTime(end);
        const elapsed = entry.calls.length && start !== null && end !== null && startTime !== '--:--:--' && endTime !== '--:--:--' && end >= start ? duration(end - start) : null;
        const compact = width < 72, timing = entry.calls.length ? `${startTime}${compact ? '→' : ' → '}${endTime}${finalResult ? ` · ${elapsed ?? (compact ? '?s' : 'duration unknown')}` : ''}` : startTime;
        const marker = `${selectedMark} ${expanded ? '▾' : '▸'} `;
        const statusLabel = compact && status === 'result not loaded' ? 'no result' : status;
        const metadata = clip(`${statusLabel}${block.role === 'tool_result' ? compact ? ' · output' : ' · result only' : ''} · ${timing}${count > 1 && !compact ? ` · ${part + 1}/${count}` : ''}`, Math.max(0, width - stringWidth(marker) - 2));
        const available = Math.max(1, width - stringWidth(marker) - stringWidth(metadata) - 2);
        const previewSpace = preview && available >= 13 ? Math.min(12, Math.max(7, available - stringWidth(name) - 3)) : 0;
        const toolName = clip(name, Math.max(1, available - (previewSpace ? previewSpace + 3 : 0)));
        const shortPreview = preview ? clip(preview, Math.max(0, available - stringWidth(toolName) - 3)) : '';
        const left = `${marker}${toolName}${shortPreview ? ` · ${shortPreview}` : ''}`;
        const label = `${left}${' '.repeat(Math.max(1, width - stringWidth(left) - stringWidth(metadata)))}${metadata}`;
        lines.push({ text: label, color: status === 'error' ? C.error : C.muted, key: block.key, offset: -2, action: toggle });
        /** Displays each long input or output in bounded parts under one tool row. */
        const section = (title: string, key: string, segments: string[]): void => {
          const length = segmentLength(segments), pages = Math.max(1, Math.ceil(length / RESULT_CHUNK)), page = Math.min(state.parts.get(key) ?? 0, pages - 1);
          if (!length) { lines.push({ text: `  ${title}: ${title === 'Input' ? 'not recorded' : 'no output recorded'}`, color: C.muted, key, offset: -1, action: toggle }); return; }
          lines.push({ text: `  ${title}`, color: C.muted, key, offset: -1, action: toggle });
          for (const line of cachedWrap(`${key}:${title}`, segmentChunk(segments, page), Math.max(1, width - 4))) lines.push({ text: `  ${line.text}`, key, offset: line.offset, action: toggle });
          if (pages > 1) lines.push({ text: `  Part ${page + 1}/${pages} · [ previous · ] next`, color: C.accent, key, offset: METADATA_OFFSET - 3, action: () => changeMessagePart(1, key, state) });
        };
        if (expanded) {
          if (entry.calls.length) section('Input', entry.calls[0].key, input);
          if (resultBlocks.length) section(block.role === 'tool' ? 'Content' : 'Output', outputKey, output);
          else lines.push({ text: '  Output not in loaded history.', color: C.muted, key: block.key, offset: METADATA_OFFSET - 2, action: toggle });
        }
        for (const source of [...entry.calls, ...resultBlocks]) {
          const details = [state.grouped.partialBefore.has(source.key) ? 'earlier block content' : '', state.grouped.partialAfter.has(source.key) ? 'later block content' : '', source.raw.content_complete === false ? 'body omitted' : '', typeof source.raw.omitted_bytes === 'number' && source.raw.omitted_bytes > 0 ? `${source.raw.omitted_bytes} bytes omitted` : ''].filter(Boolean);
          if (details.length) lines.push({ text: `  [Incomplete ${source.role === 'tool_call' ? 'input' : 'output'}: ${details.join(', ')}]`, color: C.error, key: source.key, offset: INCOMPLETE_OFFSET, action: toggle });
        }
        lines.push({ text: '', key: block.key, offset: SEPARATOR_OFFSET });
        if (expanded) { for (let index = firstLine; index < lines.length; index++) lines[index].bg = C.panel; lines.push({ text: '' }); }
        continue;
      }
      const count = Math.max(1, Math.ceil(block.content.length / RESULT_CHUNK)), part = Math.min(state.parts.get(block.key) ?? 0, count - 1);
      if (user) lines.push({ text: '', bg: C.panel, key: block.key, offset: -1, action: toggle });
      else if (!assistant) lines.push({ text: `${selectedMark} ${safe(block.role)} · ${timeOnly(block.at)}`, color: C.muted, key: block.key, offset: -1, action: toggle });
      {
        const parts = cachedWrap(`${block.key}:message`, resultChunk(block.content, part), Math.max(1, width - 4)), hidden = user && !expanded && parts.length > 5 ? parts.length - 4 : 0;
        for (const part of hidden ? parts.slice(0, 4) : parts) lines.push({ text: `  ${part.text}`, bg: user ? C.panel : undefined, key: block.key, offset: part.offset, action: toggle });
        if (hidden) lines.push({ text: `  … ${hidden} lines hidden · Enter to expand`, color: C.muted, bg: user ? C.panel : undefined, key: block.key, offset: parts[4].offset, action: toggle });
        if (count > 1) lines.push({ text: `  Part ${part + 1}/${count} · [ previous · ] next`, color: C.accent, bg: user ? C.panel : undefined, key: block.key, offset: METADATA_OFFSET - 3, action: () => changeMessagePart(1, block.key, state) });
        if (user || assistant) lines.push({ text: `${selectedMark} ${user ? 'You' : 'Assistant'} · ${timeOnly(block.at)}`, color: C.muted, bg: user ? C.panel : undefined, key: block.key, offset: METADATA_OFFSET - 2, action: toggle });
      }
      if (state.grouped.partialBefore.has(block.key) || state.grouped.partialAfter.has(block.key) || raw.content_complete === false) lines.push({ text: `  [Incomplete: ${[state.grouped.partialBefore.has(block.key) ? 'earlier block content' : '', state.grouped.partialAfter.has(block.key) ? 'later block content' : '', raw.content_complete === false ? `body omitted${typeof raw.omitted_bytes === 'number' ? ` (${raw.omitted_bytes} bytes)` : ''}` : ''].filter(Boolean).join(', ')}]`, color: C.error, bg: user ? C.panel : undefined, key: block.key, offset: INCOMPLETE_OFFSET, action: toggle });
      if (user) lines.push({ text: '', bg: C.panel, key: block.key, offset: INCOMPLETE_OFFSET + 1, action: toggle });
      lines.push({ text: '', key: block.key, offset: SEPARATOR_OFFSET });
    }
    const beginning = currentBeginning();
    if (beginning?.active && beginning.state === state && state.loaded && state.windowEnd === entries.length && beginning.next !== null) {
      const failed = state.response !== null && !usable(state.response);
      if (state.busy || failed) lines.push({ text: state.busy ? 'Loading next history page…' : 'Next page unavailable · [n] retry', color: failed ? C.error : C.muted, action: failed ? () => { void loadBeginningPage(); } : undefined });
    }
    if (!entries.length) lines.push({ text: state.loaded ? 'No messages in the loaded page.' : state.busy ? 'Loading history…' : 'History unavailable.', color: C.muted });
    for (const key of state.wraps.keys()) if (!used.has(key)) state.wraps.delete(key);
    return lines;
  }
  /** Rebuilds the current history geometry before handling queued keyboard or mouse input. */
  function synchronizeHistory(state: History): boolean {
    const w = renderer.width, h = renderer.height, narrow = w < 110;
    const showList = !full && (!narrow || focus === 'list'), showDetail = full || !narrow || focus !== 'list';
    if (w < 60 || h < 16 || !showDetail) return false;
    const sidebarWidth = narrow ? w : Math.round(w * 38 / 120), detailX = showList && showDetail ? sidebarWidth + 2 : 2, y = showList ? 5 : 7;
    historyWidth = Math.max(1, w - detailX - 2); historyHeight = Math.max(1, h - y - 4);
    historyLines = messageLines(state, historyWidth); state.scroll = anchoredScroll(state, historyLines, historyHeight);
    return true;
  }
  /** Fills the visible viewport from loaded rows, then fetches a bounded prefix if needed. */
  function fillHistoryViewport(state: History, width: number, height: number): void {
    historyLines = messageLines(state, width); state.scroll = anchoredScroll(state, historyLines, height);
    const size = historyWindowSize();
    while (historyLines.length - state.scroll < height && state.windowEnd < state.grouped.entries.length) {
      const previous = state.windowEnd; state.windowEnd = Math.min(state.grouped.entries.length, state.windowEnd + size);
      historyLines = messageLines(state, width); state.scroll = anchoredScroll(state, historyLines, height);
      if (state.windowEnd === previous) break;
    }
    const beginning = currentBeginning();
    if (!beginning?.active || beginning.state !== state) return;
    if (beginning.width !== width || beginning.height !== height) { beginning.width = width; beginning.height = height; beginning.autoPages = 0; }
    if (historyPositions.has(state) && state.loaded && !state.busy) {
      const position = historyPositions.get(state)!;
      if (performance.now() - position.startedAt < HISTORY_RESTORE_MS && beginning.next !== null && (!state.response || usable(state.response)) && beginning.autoPages < HISTORY_FILL_PAGES) { void loadBeginningPage(true); return; }
      historyPositions.delete(state);
    }
    if (state.loaded && !state.busy && beginning.next !== null && (!state.response || usable(state.response)) && historyLines.length - state.scroll < height && beginning.autoPages < HISTORY_FILL_PAGES) void loadBeginningPage(true);
  }
  /** Scrolls by rows across overlapping source windows without dropping the remaining movement. */
  function scrollHistory(delta: number, expected?: History, redraw = true): number {
    const state = currentHistory(); if (!state || expected && state !== expected || route !== 'sessions' || tab !== 'history' || overlay) return delta;
    if (!synchronizeHistory(state)) return delta;
    const entries = state.grouped.entries, size = historyWindowSize();
    if (delta < 0) state.follow = false;
    let remaining = delta;
    while (remaining !== 0) {
      const max = Math.max(0, historyLines.length - historyHeight), next = Math.max(0, Math.min(max, state.scroll + remaining));
      remaining -= next - state.scroll; state.scroll = next;
      if (!remaining) break;
      const oldStart = state.windowStart, oldEnd = state.windowEnd;
      if (remaining < 0 && oldStart > 0) state.windowStart = Math.max(0, oldStart - size);
      else if (remaining > 0 && oldEnd < entries.length) state.windowEnd = Math.min(entries.length, oldEnd + size);
      else break;
      rememberHistoryAnchor(state);
      historyLines = messageLines(state, historyWidth);
      state.scroll = anchoredScroll(state, historyLines, historyHeight);
      if (state.windowStart === oldStart && state.windowEnd === oldEnd) break;
    }
    rememberHistoryAnchor(state);
    if (!state.follow) {
      const visible = historyLines.slice(state.scroll, state.scroll + historyHeight).map(line => line.key === undefined ? undefined : state.grouped.byKey.get(line.key)).filter((index): index is number => index !== undefined);
      if (visible.length) {
        const start = Math.max(0, Math.min(...visible) - size), end = Math.min(entries.length, Math.max(...visible) + size + 1);
        if (start > state.windowStart || end < state.windowEnd) {
          state.windowStart = Math.max(state.windowStart, start); state.windowEnd = Math.min(state.windowEnd, end);
          historyLines = messageLines(state, historyWidth); state.scroll = anchoredScroll(state, historyLines, historyHeight);
        }
      }
    }
    const beginning = currentBeginning();
    if (remaining > 0 && beginning?.active && beginning.state === state && state.loaded && beginning.next !== null && !state.busy && (!state.response || usable(state.response))) void loadBeginningPage();
    if (redraw) render();
    return remaining;
  }
  /** Drops queued wheel movement when another input takes control. */
  function clearHistoryWheel(): void { queuedWheel = null; waitingWheel = null; wheelState = null; wheelDirection = 0; wheelRemainder = 0; wheelAcceleration.reset(); }
  /** Coalesces wheel input and applies OpenTUI's velocity-based acceleration. */
  function queueHistoryWheel(event: MouseEvent, expected?: History): void {
    const state = currentHistory(), info = event.scroll;
    if (!state || expected && state !== expected || route !== 'sessions' || tab !== 'history' || overlay || !info) return;
    const direction = info.direction === 'up' ? -1 : info.direction === 'down' ? 1 : 0;
    if (!direction || !Number.isFinite(info.delta) || info.delta <= 0) return;
    if (wheelState !== state || wheelDirection !== direction) {
      if (queuedWheel?.state === state) scrollHistory(queuedWheel.rows, state, false);
      clearHistoryWheel(); wheelState = state; wheelDirection = direction;
    }
    wheelRemainder += direction * info.delta * wheelAcceleration.tick(Date.now());
    const rows = Math.trunc(wheelRemainder); wheelRemainder -= rows;
    if (rows) { if (!queuedWheel) queuedWheel = { state, rows }; else queuedWheel.rows += rows; render(); }
  }
  /** Applies at most one viewport of queued movement per frame. */
  function drainHistoryWheel(): void {
    const pending = queuedWheel; if (!pending) return;
    const rows = Math.max(-historyHeight, Math.min(historyHeight, pending.rows)); pending.rows -= rows;
    const remaining = scrollHistory(rows, pending.state, false), beginning = currentBeginning();
    if (remaining > 0 && beginning?.active && beginning.state === pending.state && beginning.state.busy) {
      const deferred = remaining + pending.rows;
      if (waitingWheel?.beginning === beginning) waitingWheel.rows += deferred; else waitingWheel = { beginning, rows: deferred };
      pending.rows = 0;
    } else if (remaining) pending.rows = 0;
    if (queuedWheel !== pending) return;
    if (pending.rows) render(); else queuedWheel = null;
  }
  /** Anchors the first visible source row and preserves its position within the viewport. */
  function rememberHistoryAnchor(state: History): void {
    const index = historyLines.findIndex((line, position) => position >= state.scroll && !!line.key && line.offset !== undefined);
    const line = historyLines[index];
    if (line?.key) { state.anchor = { key: line.key, offset: line.offset ?? -1, row: index - state.scroll }; state.selected = line.key; }
  }
  /** Restores the nearest wrapped row for a retained message/character anchor. */
  function anchoredScroll(state: History, lines: Line[], height: number): number {
    const max = Math.max(0, lines.length - height);
    if (state.follow) return max;
    if (state.anchor) {
      const anchor = state.anchor;
      let found = -1;
      lines.forEach((line, index) => { if (line.key === anchor.key && (line.offset ?? -1) <= anchor.offset && line.offset !== undefined) found = index; });
      if (found < 0) {
        const group = state.grouped.byKey.get(anchor.key), head = group === undefined ? undefined : state.grouped.entries[group]?.head.key;
        if (head) found = lines.findIndex(line => line.key === head);
      }
      if (found >= 0) return Math.max(0, Math.min(max, found - anchor.row));
    }
    return Math.min(max, state.scroll);
  }
  /** Estimates the visible range within grouped entries, including long individual messages. */
  function historyExtent(state: History): { start: number; end: number } {
    const ranges = new Map<number, { first: number; last: number }>();
    historyLines.forEach((line, index) => {
      if (!line.key) return;
      const group = state.grouped.byKey.get(line.key); if (group === undefined) return;
      const range = ranges.get(group);
      if (range) range.last = index + 1; else ranges.set(group, { first: index, last: index + 1 });
    });
    const position = (index: number, after: boolean): number | null => {
      const key = historyLines[index]?.key, block = key === undefined ? undefined : state.grouped.byKey.get(key), range = block === undefined ? undefined : ranges.get(block);
      return block === undefined || !range ? null : block + (index - range.first + (after ? 1 : 0)) / (range.last - range.first);
    };
    const begin = state.scroll, end = Math.min(historyLines.length, begin + historyHeight);
    let first: number | null = null, last: number | null = null;
    for (let index = begin; index < end; index++) { first ??= position(index, false); last = position(index, true) ?? last; }
    return { start: first ?? state.windowStart, end: last ?? state.windowEnd };
  }
  /** Moves the reader within already loaded history when the scrollbar changes. */
  function seekHistory(value: number): void {
    const state = currentHistory();
    if (route !== 'sessions' || tab !== 'history' || overlay || !historyTrack.visible || !state?.grouped.entries.length || historyDrag && historyDrag.state !== state) return;
    if (historyDrag) historyDrag.position = value;
    if (value >= 1 && !currentBeginning()?.active) { followLatest(); return; }
    const extent = historyExtent(state), span = historyDrag?.span ?? Math.max(0, extent.end - extent.start);
    const entries = state.grouped.entries, total = Math.min(entries.length, historyDrag?.total ?? entries.length);
    const target = Math.max(0, Math.min(1, value)) * Math.max(0, total - span);
    const index = Math.floor(target), block = entries[index].head, lines = historyLines.filter(line => line.key !== undefined && state.grouped.byKey.get(line.key) === index);
    const line = lines[Math.min(lines.length - 1, Math.floor((target - index) * lines.length))];
    const content = resultChunk(block.content, state.parts.get(block.key) ?? 0);
    const key = line?.key ?? block.key;
    state.follow = false; state.selected = key; state.anchor = { key, offset: line?.offset ?? Math.floor(safe(content).length * (target - index)), row: 0 };
    state.windowStart = Math.min(index, Math.max(0, entries.length - historyWindowSize())); state.windowEnd = Math.min(entries.length, state.windowStart + historyWindowSize()); state.scroll = 0;
    render();
  }
  /** Updates the persistent track and solid thumb without treating redraw as input. */
  function showHistoryScrollbar(state: History, y: number, height: number): void {
    if (!state.grouped.entries.length || state.windowStart === 0 && state.windowEnd === state.grouped.entries.length && historyLines.length <= height) return;
    const extent = historyExtent(state), total = state.grouped.entries.length, span = Math.min(total, Math.max(0.01, extent.end - extent.start));
    const drag = historyDrag?.state === state ? historyDrag : null;
    const position = drag?.position ?? (total > span ? Math.max(0, Math.min(1, extent.start / (total - span))) : 0);
    historyTrack.left = renderer.width - 1; historyTrack.top = y; historyTrack.height = height; historyTrack.backgroundColor = C.cell;
    const fraction = drag ? drag.span / drag.total : span / total;
    historyThumbHeight = Math.max(1, Math.min(height, Math.round(height * fraction)));
    historyThumbTop = Math.round((height - historyThumbHeight) * position);
    historyThumb.top = historyThumbTop; historyThumb.height = historyThumbHeight; historyThumb.backgroundColor = C.muted;
    historyTrack.visible = true;
  }
  /** Builds source details without interpreting workdir as a verified repository. */
  function sessionDetails(agent: RunAgent, width: number): Line[] {
    const evidence = currentBoundEvidence();
    const rows: Line[] = [], fields: [string, unknown][] = [
      ['Agent ID', agent.id], ['Execution sequence', agent.sequence], ['Name', agent.name], ['Task', agent.summary], [evidence ? 'Selected execution status (raw)' : 'Lifecycle', agent.status],
      ...(evidence ? [
        ['Run lineage', runLineageLabel(evidence)], ['Cleanup', `${evidence.cleanup} · lineage snapshot`], ['Pin', evidence.pinState],
        ['Run store fence', evidence.storeFenced ? 'matched' : 'unknown'], ['Selected execution answer available (raw)', agent.answerAvailable],
        ['Pool binding observed', stamp(boundTarget?.poolObservedAtMs == null ? null : boundTarget.poolObservedAtMs / 1000)],
        ['Status observed', stamp(evidence.observedAt)], ['View sampled', stamp(evidence.view?.sampledAt ?? null)],
      ] as [string, unknown][] : []),
      ['Runtime', agent.raw.runtime], ['Model', agent.model], ['Requested reasoning', agent.effort], ['Working directory', agent.workdir], ['Elapsed at source observation', duration(agent.elapsed)],
      ['Failure category', agent.raw.failure_kind], ['Failure detail', agent.raw.failure_text],
      ['Last action evidence', lastAction(agent)], ['Last transcript activity', stamp(agent.progress)], ['Silence at source observation', duration(agent.silence)],
      ['Native usage (latest execution)', agent.raw.usage], ['Tool counts (latest execution)', agent.raw.tool_counts], ['Usage across executions', agent.raw.usage_cumulative],
      ...(!evidence ? [['Answer available', agent.answerAvailable], ['Cleanup', agent.raw.cleanup]] as [string, unknown][] : []), ['Delivery', agent.raw.delivery], ['Source observation', stamp(agent.observed)],
      ['Inventory received', agents.good ? stamp(agents.good.observed_at_ms / 1000) : null], ['Producer metadata', agent.raw],
    ];
    const task = initialTasks.get(executionKey(agent))?.result;
    if (task?.state === 'verified') {
      const cached = initialTasks.get(executionKey(agent))!;
      if (cached.lines?.width !== width) { const taskRows: Line[] = []; addWrapped(taskRows, initialTaskScope(task), width, { color: C.good }); addWrapped(taskRows, task.text, width); taskRows.push({ text: '' }); cached.lines = { width, rows: taskRows }; }
      rows.push(...cached.lines.rows);
    }
    for (const [label, value] of fields) addWrapped(rows, `${label}: ${shown(value)}`, width);
    rows.push({ text: 'Working directory is source-reported; repository identity is unverified.', color: C.muted }); return rows;
  }
  /** Toggles finished sessions and selects the first only when nothing is selected. */
  function toggleFinished(): void {
    finishedOpen = !finishedOpen;
    if (finishedOpen && selected === null) { ensureSelection(); if (selected) void loadHistory(); }
    render();
  }
  /** Renders the session inventory and detail in split or narrow/fullscreen layouts. */
  function drawSessions(parent: BoxRenderable): void {
    const w = renderer.width, h = renderer.height, narrow = w < 110, showList = !full && (!narrow || focus === 'list');
    const showDetail = full || !narrow || focus !== 'list', sidebarWidth = narrow ? w : Math.round(w * 38 / 120);
    const leftWidth = Math.max(1, sidebarWidth - 4), detailX = showList && showDetail ? sidebarWidth + 2 : 2, detailWidth = Math.max(1, w - detailX - 2);
    const listY = 4, listHeight = Math.max(1, h - listY - 4), items = visibleAgents(), matching = matchingAgents(), selectedItem = selectedAgent();
    if (showList) {
      surface(parent, 0, 2, sidebarWidth, Math.max(0, h - 3), C.sidebar);
      textAt(parent, 2, 2, leftWidth, filterProject ? `Project: ${filterProject}  [p]` : filterFolder ? `${filterFolder}  [p]` : 'All folders  [p]', { color: C.muted, bg: C.sidebar, click: () => { overlay = { kind: 'folder', query: '', index: 0, original: filterFolder }; render(); } });
      const lines: Line[] = []; let group = '';
      for (const agent of items) {
        const name = activeStatus(agent.status) ? 'Live' : terminalStates.has(agent.status) ? 'Finished' : 'Other / Unknown';
        if (name !== group) { group = name; const count = name === 'Finished' ? finishedCount(matching) : matching.filter(item => name === 'Live' ? activeStatus(item.status) : !activeStatus(item.status) && !terminalStates.has(item.status)).length; lines.push({ text: ` ${name === 'Finished' ? '▾ ' : ''}${name}  ${count}`, color: C.text, bold: true, action: name === 'Finished' ? toggleFinished : undefined, hover: name === 'Finished' ? 'finished' : undefined }); }
        const chosen = selected === agent.id, marker = chosen && focus === 'list' ? '›' : ' ', bg = chosen ? C.selected : undefined;
        const hover = `session:${agent.id}`;
        const click = () => { const open = selected === agent.id && narrow; chooseAgent(agent.id); focus = open ? 'history' : 'list'; render(); };
        const action = lastAction(agent).replace(/^(?:Source action|Last loaded transcript action): /, '');
        lines.push({ text: `${marker} ${activeStatus(agent.status) ? `${spinnerFrames[spinnerFrame]} ` : ''}${shown(agent.name ?? agent.summary ?? agent.id)}`, bold: true, bg, action: click, spinner: activeStatus(agent.status), hover });
        for (const text of sessionRows(agent, sidebarWidth - 2, action)) lines.push({ text, color: C.muted, bg, action: click, hover });
        lines.push({ text: '' });
      }
      if (!finishedOpen || !items.some(agent => terminalStates.has(agent.status))) lines.push({ text: ` ${finishedOpen ? '▾' : '▸'} Finished  ${finishedCount(matching)}`, color: C.text, bold: true, action: toggleFinished, hover: 'finished' });
      if (activeAgents.response && !usable(activeAgents.response)) lines.push({ text: 'Active sessions unavailable · showing loaded inventory', color: C.muted });
      if (!matching.length && agents.value) lines.push({ text: 'No matching loaded sessions.', color: C.muted });
      listTop = Math.max(0, Math.min(listTop, Math.max(0, lines.length - listHeight)));
      lineViewport(parent, 1, listY, sidebarWidth - 2, listHeight, lines, listTop, delta => { listTop = Math.max(0, Math.min(Math.max(0, lines.length - listHeight), listTop + delta)); render(); }, C.sidebar, 0, line => line.hover);
      textAt(parent, 2, h - 4, leftWidth, `${agents.good && agents.response !== agents.good ? 'STALE · ' : ''}${agents.value ? loadedAgents().length : '?'} loaded${agents.value ? ` / ${agents.value.total} reported` : ''}${agents.value && (!agents.value.complete || activeAgents.value && !activeAgents.value.complete) ? ' · partial' : ''}${query || filterFolder || filterProject || filterStatus ? ' · filtered' : ''}`, { color: C.muted, bg: C.sidebar });
      if (agents.value?.next !== null && agents.value?.next !== undefined) textAt(parent, 2, h - 3, leftWidth, 'Load more  [n]', { color: C.accent, bg: C.sidebar, click: () => { agentPages++; refresh(); } });
    }
    if (!showDetail) return;
    if (!selectedItem) { const evidence = currentBoundEvidence(); textAt(parent, detailX, 3, detailWidth, boundSequence !== null ? `Bound execution ${boundSequence}: ${evidence?.match ?? 'unavailable'}; its result is withheld.` : selected ? 'Selected session is not in the loaded snapshot.' : notice(agents), { color: C.muted }); return; }
    const agent = selectedItem, state = currentHistory();
    const stale = agents.good && agents.response !== agents.good || detailFromRelated && relatedAgent.good && relatedAgent.response !== relatedAgent.good;
    textAt(parent, detailX, 2, detailWidth, `${stale ? 'STALE · ' : ''}${shown(agent.name ?? agent.summary ?? agent.id)}`, { bold: true });
    let tabX = detailX;
    for (const value of sessionTabs) {
      const label = `${tab === value ? '[' : ' '}${value[0].toUpperCase() + value.slice(1)}${tab === value ? ']' : ' '}`;
      textAt(parent, tabX, 3, Math.min(stringWidth(label), detailX + detailWidth - tabX), label, { color: tab === value ? C.text : C.muted, click: () => selectTab(value, 'tabs') });
      tabX += stringWidth(label) + 2;
    }
    if (focus === 'tabs') textAt(parent, tabX, 3, Math.min(9, detailX + detailWidth - tabX), '‹ tabs ›', { color: C.muted });
    const identity = `${agent.id} · sequence ${agent.sequence}`;
    const identityX = detailX + detailWidth - stringWidth(identity), showIdentity = identityX > tabX + 2;
    if (showIdentity) textAt(parent, identityX, 3, stringWidth(identity), identity, { color: C.muted });
    const startX = tabX + (focus === 'tabs' ? 10 : 0), startLabel = 'Start [i]';
    if (tab === 'history' && startX + stringWidth(startLabel) <= (showIdentity ? identityX - 1 : detailX + detailWidth)) textAt(parent, startX, 3, stringWidth(startLabel), startLabel, { color: C.accent, click: jumpBeginning });
    const compactDetail = !showList;
    if (compactDetail) {
      const evidence = currentBoundEvidence();
      textAt(parent, detailX, 4, detailWidth, `${evidence ? `Run lineage: ${runLineageLabel(evidence)}` : lifecycle(agent.status)} · ${shown(agent.model)} · ${reasoning(agent.effort)} · ${duration(agent.elapsed)}`, { color: C.muted });
      textAt(parent, detailX, 5, detailWidth, `${agent.workdir ? basename(agent.workdir) : 'Folder unknown'} · ${lastAction(agent)}`, { color: C.muted });
    }
    const usage = sessionUsage(agent);
    if (detailFromRelated) {
      const evidence = currentBoundEvidence();
      const stalePrefix = relatedAgent.good && relatedAgent.response !== relatedAgent.good ? 'STALE · ' : '';
      const identity = evidence?.match === 'verified' ? `ref matched${evidence.storeFenced ? '' : ' · store unverified'}` : 'historical identity unverified';
      const restoring = tab === 'history' && state && currentBeginning()?.active && historyPositions.has(state);
      const status = restoring ? 'Status paused while restoring position' : evidence ? `Run lineage: ${runLineageLabel(evidence)}` : '';
      const label = evidence ? `Pool snapshot · History and answer attribution unverified · ${status} · ${identity}` : restoring ? 'Historical identity unverified · status paused while restoring position' : 'Pool binding snapshot · ID and sequence match · historical identity unverified';
      textAt(parent, detailX, compactDetail ? 6 : 4, detailWidth, `${stalePrefix}${label}`, { color: C.muted });
    }
    else if (usage) textAt(parent, detailX, compactDetail ? 6 : 4, detailWidth, `Run usage · ${usage}`, { color: C.muted });
    const y = compactDetail ? 7 : 5, height = Math.max(1, h - y - 4);
    if (tab === 'history' && state) {
      historyHeight = height; historyWidth = detailWidth; fillHistoryViewport(state, detailWidth, height);
      if (!state.follow && !state.anchor) rememberHistoryAnchor(state);
      const incompleteBodies = state.blocks.some(block => block.raw.content_complete !== true || state.grouped.partialBefore.has(block.key) || state.grouped.partialAfter.has(block.key) || typeof block.raw.omitted_bytes === 'number' && block.raw.omitted_bytes > 0);
      const beginning = currentBeginning(), isBeginning = beginning?.active && beginning.state === state, tail = tailHistory();
      if (isBeginning && state.loaded && h - 4 >= y + height) { const task = initialTasks.get(executionKey(agent)); textAt(parent, detailX, h - 4, detailWidth, initialTaskLabel(!task ? null : task.busy ? 'reading' : task.unsupported ? null : task.result), { color: task?.result?.state === 'verified' ? C.good : C.muted }); }
      const follow = state.follow ? '● Following' : `○ Follow paused${tail?.unseen ? ` · ${tail.unseen} new` : ''}`;
      const range = isBeginning && beginning ? !state.loaded ? state.busy ? 'Loading beginning…' : 'Beginning unavailable · [i] retry' : beginning.next !== null ? state.busy ? 'Loading next page…' : state.response && !usable(state.response) ? 'Next page unavailable · [n] retry' : 'More history available' : state.complete ? incompleteBodies ? 'all pages loaded · bodies incomplete/unknown' : 'loaded history complete' : 'coverage incomplete or unknown'
        : state.complete ? incompleteBodies ? 'all pages loaded · bodies incomplete/unknown' : 'loaded history complete' : state.previous !== null ? 'older page available [g]' : 'coverage incomplete or unknown';
      const coverage = `Across runs · ${range}${!isBeginning && state.response && !usable(state.response) ? ` · ${state.response.outcome}${state.loaded ? ' (last good)' : ''}` : ''}${isBeginning && tail?.response && !usable(tail.response) ? ' · tail unavailable' : ''}`;
      const followWidth = Math.min(detailWidth, stringWidth(follow));
      const available = Math.max(0, detailWidth - followWidth - 2);
      textAt(parent, detailX, h - 3, available, coverage, { color: C.muted });
      textAt(parent, detailX + detailWidth - followWidth, h - 3, followWidth, follow, { color: state.follow ? C.good : C.muted });
      lineViewport(parent, detailX, y, detailWidth, height, historyLines, state.scroll, delta => { scrollHistory(delta, state); }, C.bg, 2, line => { const index = line.key === undefined || !line.action ? undefined : state.grouped.byKey.get(line.key); return index === undefined ? undefined : `history:${state.grouped.entries[index].head.key}`; }, event => queueHistoryWheel(event, state));
      historyViewportRendered = true;
      showHistoryScrollbar(state, y, height);
    } else if (tab === 'result') {
      const answer = answers.get(JSON.stringify([executionKey(agent), agent.answerSha]));
      let lines: Line[] = [];
      if (!answer || answer.busy) lines.push({ text: 'Checking answer ID, sequence and hash…', color: C.muted });
      else if (answer.issue) lines.push({ text: `Answer withheld: ${answer.issue}`, color: C.error });
      else if (answer.content === null) lines.push({ text: agent.answerAvailable === false ? 'No answer reported for this execution.' : 'Answer not yet available.', color: C.muted });
      else { if (answer.width !== detailWidth || !answer.lines) { answer.width = detailWidth; answer.lines = [{ text: `Saved answer · SHA-256 verified · part ${answer.chunk + 1}/${Math.max(1, Math.ceil(answer.content.length / RESULT_CHUNK))} · scroll for more · c to copy`, color: C.good }]; addWrapped(answer.lines, resultChunk(answer.content, answer.chunk), detailWidth); } lines = answer.lines; }
      historyLines = lines; historyHeight = height; const position = Math.min(state?.resultScroll ?? 0, Math.max(0, lines.length - height));
      if (state) state.resultScroll = position;
      lineViewport(parent, detailX, y, detailWidth, height, lines, position, scrollResult, C.bg, 2);
    } else {
      const lines = sessionDetails(agent, detailWidth); historyLines = lines; historyHeight = height; const position = Math.min(state?.detailsScroll ?? 0, Math.max(0, lines.length - height));
      lineViewport(parent, detailX, y, detailWidth, height, lines, position, delta => { if (state) { state.detailsScroll = Math.max(0, Math.min(Math.max(0, lines.length - height), position + delta)); render(); } }, C.bg, 2);
    }
  }
  /** Draws Agent Pool records as independently paged, read-only sections. */
  function drawPools(parent: BoxRenderable): void {
    const width = renderer.width - 4, wide = renderer.width >= 110, mainWidth = wide ? Math.floor((width - 2) * 0.64) : width;
    const asideX = 2 + mainWidth + 2, asideWidth = width - mainWidth - 2;
    const lines: Line[] = []; let selectedLine = -1;
    const data = pool ? poolDetail.value : null, view = data?.view ? object(data.view) : null;
    const journal = pool && !poolContent && poolTab === 'discussion' && poolHistorySupported() === true ? poolHistory(pool) : null;
    const selectedPool = pool ? visiblePools().find(item => object(item.pool).pool_id === pool) : null;
    const info = view ? object(view.pool) : selectedPool ? object(selectedPool.pool) : null;
    const members = view && Array.isArray(view.members) ? view.members : [], bindings = data && Array.isArray(data.bindings) ? data.bindings : [];
    const entries = view && Array.isArray(view.events) ? view.events : [];
    const bodyY = pool ? 8 : 5, available = Math.max(1, renderer.height - bodyY - 4);

    if (!pool) {
      textAt(parent, 2, 2, width, 'Agent Pool', { bold: true });
      textAt(parent, 2, 3, width, 'Pools · independently observed pages', { color: C.muted });
      const groups = groupPools(pools.value?.items ?? [], query), items = groups.items;
      poolIndex = Math.min(poolIndex, Math.max(0, items.length - 1));
      /* Source-wide totals come only from an advertised snapshot read; loaded rows below are a separate read. */
      const supported = poolCapability(INVENTORY_SNAPSHOT_CAPABILITY);
      if (poolTotals.value) { const stale = poolTotals.response !== poolTotals.good; for (const [index, text] of inventoryTotalsLines(poolTotals.value).entries()) addWrapped(lines, `${index === 0 && stale ? 'STALE · ' : ''}${text}`, mainWidth, { color: C.muted }); lines.push({ text: '' }); }
      else if (supported === false) lines.push({ text: 'Source-wide totals unavailable · observer does not advertise inventory_snapshot_v1', color: C.muted }, { text: '' });
      else if (supported === true) lines.push({ text: poolTotals.response && !usable(poolTotals.response) ? `Source-wide totals ${poolTotals.response.outcome}` : 'Loading source-wide totals…', color: C.muted }, { text: '' });
      if (pools.value) {
        let index = 0;
        for (const [title, group] of [['Open', groups.open], ['Closed', groups.closed]] as const) {
          lines.push({ text: `${title} · ${group.loaded} loaded`, bold: true });
          for (const item of group.items) {
            const selectedIndex = index++, source = object(item.pool), id = String(source.pool_id);
            if (selectedIndex === poolIndex) selectedLine = lines.length + 1;
            const click = () => { const current = visiblePools().findIndex(value => object(value.pool).pool_id === id); if (current < 0) { alert = 'Pool is no longer in loaded records.'; render(); return; } poolIndex = current; choosePool(id); }, background = selectedIndex === poolIndex ? C.selected : C.panel;
            lines.push({ text: '', bg: background, action: click });
            addWrapped(lines, `${selectedIndex === poolIndex ? '›' : ' '} ${shown(source.name)}`, mainWidth, { bg: background, bold: true, action: click });
            addWrapped(lines, `  ${shown(source.purpose)}`, mainWidth, { bg: background, color: C.muted, action: click });
            addWrapped(lines, `  ${title} · ${id}`, mainWidth, { bg: background, color: C.muted, action: click });
            lines.push({ text: '', bg: background, action: click }, { text: '' });
          }
        }
      }
      if (!items.length) {
        const message = pools.value ? pools.value.items.length ? 'No matching pools in loaded records.' : 'No pools in the reported coverage.' : pools.response && !usable(pools.response) ? `Pool source ${pools.response.outcome}.` : 'Loading pool observations…';
        lines.push({ text: message, color: C.muted });
      }
      if (pools.value?.next !== null && pools.value?.next !== undefined) lines.push({ text: 'Load more  [n]', color: C.accent, action: () => { poolPages++; refresh(); } });
    } else {
      textAt(parent, 2, 2, 10, '‹ Pools', { color: C.accent, click: back });
      textAt(parent, 14, 2, Math.max(1, width - 12), 'Agent Pool', { color: C.muted });
      textAt(parent, 2, 4, width, shown(info?.name ?? pool), { bold: true });
      let tabX = 2;
      for (const value of poolTabs) {
        const name = value[0].toUpperCase() + value.slice(1), label = value === poolTab ? `[${name}]` : ` ${name} `;
        textAt(parent, tabX, 6, Math.min(stringWidth(label), renderer.width - 2 - tabX), label, { color: value === poolTab ? C.text : C.muted, click: () => setPoolTab(value) });
        tabX += stringWidth(label) + 1;
      }
      if (renderer.width - tabX > 20) textAt(parent, renderer.width - 20, 6, 18, poolMetadata ? 'Hide details  [i]' : 'Source details [i]', { color: C.accent, click: () => { poolMetadata = !poolMetadata; render(); } });
      if (poolContent) {
        lines.push({ text: poolContent.field === 'purpose' ? 'Full purpose' : poolContent.field === 'completion' ? 'Completion record (frozen)' : 'Full proposal snapshot', bold: true }, { text: 'Esc returns to the pool', color: C.muted }, { text: '' });
        if (poolContent.busy) lines.push({ text: 'Loading verified content…', color: C.muted });
        else if (poolContent.error) lines.push({ text: poolContent.error, color: C.muted });
        else if (poolContent.text !== null) addWrapped(lines, poolContent.text, mainWidth);
      } else if (!data && !journal) {
        let message = 'Pool observation unavailable.';
        if (poolTab === 'criteria' && poolCapability('structured_acceptance_v1') === false) message = 'Structured criteria are not supported by this observer.';
        else if (poolTab === 'discussion' && poolHistorySupported() === null && poolIdentity.response && !usable(poolIdentity.response)) message = 'Pool identity unavailable; history capability unknown.';
        else if (poolDetail.busy || (poolTab === 'criteria' || poolTab === 'discussion') && !poolIdentity.response) message = 'Loading pool observation…';
        lines.push({ text: message, color: C.muted });
      } else if (poolTab === 'members' && view) {
        if (info?.purpose) { addWrapped(lines, `Purpose: ${shown(info.purpose)}${typeof info.purpose_bytes === 'number' ? ' · preview [e] full' : ''}`, mainWidth, { color: C.muted, action: () => { void openPoolContent('purpose'); } }); lines.push({ text: '' }); }
        lines.push({ text: `Members · ${shown(view.active)} active · ${shown(view.pending)} pending`, bold: true }, { text: '' });
        poolMemberIndex = Math.min(poolMemberIndex, Math.max(0, members.length - 1));
        for (const [index, value] of members.entries()) {
          if (index === poolMemberIndex) selectedLine = lines.length + 1;
          const member = object(value), binding = bindings.map(object).find(item => object(item.member).member_id === member.member_id);
          const background = index === poolMemberIndex ? C.selected : C.panel;
          const choose = () => { poolMemberIndex = index; if (binding) openMember(binding); else { alert = 'No confirmed Run binding for this member.'; render(); } };
          const statusTarget = index === poolMemberIndex ? selectedPoolStatusTarget() : null;
          const observation = statusTarget && poolStatus.value?.targetKey === statusTarget.key && poolDetail.response === poolDetail.good ? poolStatus.value : null;
          const evidence = observation?.evidence ?? null;
          const stale = observation && poolStatus.good && poolStatus.response !== poolStatus.good;
          lines.push({ text: '', bg: background, action: choose });
          addWrapped(lines, `${index === poolMemberIndex ? '›' : ' '} ${shown(member.name)} · ${shown(member.role)} · ${shown(member.state)}`, mainWidth, { bg: background, bold: true, action: choose });
          addWrapped(lines, `  ${shown(member.task)}`, mainWidth, { bg: background, color: C.muted, action: choose });
          if (evidence) {
            const label = ['verified', 'unverified'].includes(evidence.match) ? `Run lineage: ${runLineageLabel(evidence)}` : `Run binding: ${evidence.match}`;
            const scope = !evidence.storeFenced ? ' · store unverified' : evidence.match !== 'verified' ? ' · execution unverified' : '';
            const cleanup = !stale && evidence.storeFenced && evidence.match === 'verified' ? evidence.cleanup : 'unknown';
            addWrapped(lines, `  ${stale ? 'STALE · ' : ''}${label}${scope}`, mainWidth, { bg: background, color: C.muted, action: choose });
            const clocks = observation?.source === 'pool' && observation.poolObservedAtMs !== undefined ? `Run ${stamp(evidence.observedAt)} · Pool ${stamp(observation.poolObservedAtMs / 1000)}` : `observed ${stamp(evidence.observedAt)}`;
            addWrapped(lines, `  Cleanup: ${cleanup} · ${clocks}`, mainWidth, { bg: background, color: C.muted, action: choose });
          } else {
            addWrapped(lines, observation?.source === 'pool' ? `  ${stale ? 'STALE · ' : ''}Run proof: unknown · ${shown(observation.reason)}` : `  Execution: ${shown(member.runtime)}`, mainWidth, { bg: background, color: C.muted, action: choose });
            addWrapped(lines, '  Cleanup: unknown · proof not verified', mainWidth, { bg: background, color: C.muted, action: choose });
          }
          if (binding && typeof binding.run_id === 'string' && typeof binding.run_sequence === 'number') addWrapped(lines, '  Open matching Run session →', mainWidth, { bg: background, color: C.accent, action: choose });
          else addWrapped(lines, '  No confirmed Run binding', mainWidth, { bg: background, color: C.muted });
          lines.push({ text: '', bg: background, action: choose }, { text: '' });
        }
        if (!members.length) lines.push({ text: 'No members reported in this page.', color: C.muted });
      } else if (poolTab === 'discussion' && journal) {
        lines.push({ text: 'Discussion', bold: true }, { text: 'Source order · historical timestamps not reported', color: C.muted }, { text: '' });
        if (!journal.loaded) lines.push({ text: journal.response && !usable(journal.response) ? 'Pool history unavailable.' : 'Loading pool history…', color: C.muted });
        else if (!journal.entries.length) lines.push({ text: 'No entries in the reported history.', color: C.muted });
        else lines.push(...poolEventLines(journal.entries, mainWidth));
      } else if (poolTab === 'discussion' && view) {
        lines.push({ text: 'Discussion', bold: true }, { text: 'Forward-only source pages · timestamps not reported', color: C.muted }, { text: '' });
        lines.push(...poolEventLines(entries.map(object), mainWidth));
        if (!entries.length) lines.push({ text: 'No entries in the reported page.', color: C.muted });
      } else if (poolTab === 'decisions' && data) {
        const proposalView = poolProposal.value?.view ? object(poolProposal.value.view) : null;
        const proposalPool = proposalView ? object(proposalView.pool) : null;
        const current = proposalPool?.proposal ? object(proposalPool.proposal) : null;
        lines.push({ text: poolProposalId ? 'Selected proposal' : 'Current proposal', bold: true }, { text: '' });
        if (poolProposal.response && !usable(poolProposal.response)) lines.push({ text: `Proposal unavailable${poolProposal.good ? ' · last good' : ''}`, color: C.muted });
        if (current) {
          addWrapped(lines, `  ${shown(current.state)} · ${shown(current.proposal_id)}`, mainWidth, { bg: C.panel, bold: true });
          addWrapped(lines, `  Result: ${shown(current.result)}`, mainWidth, { bg: C.panel });
          addWrapped(lines, `  Criteria: ${shown(current.criteria)}`, mainWidth, { bg: C.panel });
          if (typeof current.snapshot_bytes === 'number' && typeof current.proposal_id === 'string') lines.push({ text: `  Snapshot: ${current.snapshot_bytes} bytes · [s] open`, color: C.accent, action: () => { void openPoolContent('snapshot', String(current.proposal_id)); } });
          if (current.state === 'accepted') lines.push({ text: '  Recorded acceptance does not by itself verify vote authors.', color: C.muted });
          lines.push({ text: '  Open Votes to inspect recorded choices.', color: C.muted });
        } else if (!poolProposal.response || poolProposal.busy && !poolProposal.good) lines.push({ text: 'Loading proposal…', color: C.muted });
        else if (poolProposal.good && poolProposal.response === poolProposal.good) lines.push({ text: 'No proposal reported.', color: C.muted });
        lines.push({ text: '' }, { text: 'Proposal archive · select an entry', bold: true });
        const decisions = data.decisions as unknown[];
        poolDecisionIndex = Math.min(poolDecisionIndex, Math.max(0, decisions.length - 1));
        for (const [index, value] of decisions.entries()) {
          if (index === poolDecisionIndex) selectedLine = lines.length;
          const item = object(value), id = typeof item.proposal_id === 'string' ? item.proposal_id : null;
          const action = id ? () => { poolDecisionIndex = index; choosePoolProposal(id); } : undefined;
          addWrapped(lines, `  ${index === poolDecisionIndex ? '›' : ' '} ${shown(item.state)} · ${shown(item.proposal_id)} · ${shown(item.result)}`, mainWidth, { color: id === poolProposalId ? C.accent : C.text, action });
        }
        if (poolProposalId) lines.push({ text: '  Show current proposal', color: C.accent, action: () => choosePoolProposal(null) });
        lines.push({ text: '' }, { text: 'A decision does not establish pool closure or execution completion.', color: C.muted });
      } else if (poolTab === 'criteria' && view) {
        const criteria = object(view.pool).acceptance;
        lines.push({ text: 'Acceptance criteria', bold: true }, { text: '' });
        if (Array.isArray(criteria)) for (const value of criteria) { const criterion = object(value); addWrapped(lines, `  ${shown(criterion.id)} · ${shown(criterion.text)}`, mainWidth); }
        else lines.push({ text: 'This pool uses the original single-evidence format.', color: C.muted });
      } else if (poolTab === 'votes' && view) {
        const proposal = object(view.pool).proposal;
        lines.push({ text: poolProposalId ? `Votes · ${poolProposalId}` : 'Current proposal votes', bold: true }, { text: '' });
        if (proposal && typeof proposal === 'object' && !Array.isArray(proposal)) {
          const votes = poolVoteRows(); poolVoteIndex = Math.min(poolVoteIndex, Math.max(0, votes.length - 1));
          for (const [index, [id, vote]] of votes.entries()) {
            if (index === poolVoteIndex) selectedLine = lines.length;
            const checks = vote.choice === 'ready' && typeof vote.checks_met === 'boolean' ? vote.checks_met ? ' · checks met' : ' · checks unmet' : '';
            const validity = vote.validity == null ? '' : typeof vote.validity === 'string' ? ` · validity ${safe(vote.validity).replace(/\n/g, ' ')}` : ' · validity unknown';
            addWrapped(lines, `  ${index === poolVoteIndex ? '›' : ' '} ${id} · ${shown(vote.choice)}${validity}${checks} · ${shown(vote.evidence)}`, mainWidth, { action: () => choosePoolVote(index), color: id === poolVoteMember ? C.accent : C.text });
          }
          if (!votes.length) lines.push({ text: 'No votes in this page.', color: C.muted });
          const chosen = votes.find(([id]) => id === poolVoteMember);
          if (chosen) {
            const vote = chosen[1], key = JSON.stringify([pool, vote.vote_event_id, vote.checks_count]), checks = poolChecks.get(key);
            lines.push({ text: '' }, { text: `Checks · ${chosen[0]}`, bold: true });
            if (checks?.busy) lines.push({ text: 'Loading check evidence…', color: C.muted });
            else if (checks?.error) lines.push({ text: checks.error, color: C.muted });
            else if (checks?.rows) { if (!checks.rows.length) lines.push({ text: 'No checks recorded.', color: C.muted }); for (const check of checks.rows) addWrapped(lines, `  ${shown(check.criterion_id)} · ${shown(check.status)} · ${shown(check.evidence)}`, mainWidth); }
            else lines.push({ text: 'No individually attributable checks reported.', color: C.muted });
          }
        } else lines.push({ text: 'No proposal reported.', color: C.muted });
        lines.push({ text: '' }, { text: 'Votes are separate from execution and delivery status.', color: C.muted });
      } else if (poolTab === 'deliveries' && view) {
        lines.push({ text: 'Delivery', bold: true }, { text: '' });
        const deliveryRows = view.deliveries as unknown[];
        poolDeliveryIndex = Math.min(poolDeliveryIndex, Math.max(0, deliveryRows.length - 1));
        for (const [index, value] of deliveryRows.entries()) {
          if (index === poolDeliveryIndex) selectedLine = lines.length;
          const delivery = object(value), replacement = delivery.operation === 'replace';
          const member = typeof delivery.member_id === 'string' && delivery.member_id ? ` · ${replacement ? 'original member' : 'member'} ${shown(delivery.member_id).replace(/\n/g, ' ')}` : '';
          addWrapped(lines, `  ${replacement ? 'Replace request' : shown(delivery.operation)} · ${shown(delivery.state)}${member} · ${shown(delivery.operation_id)}`, mainWidth, { bg: C.panel });
          if (replacement) {
            const result = delivery.state === 'accepted' ? 'Replacement recorded by Pool.' : delivery.state === 'refused' ? 'Request refused; it did not replace the original member.' : delivery.state === 'cancelled' ? 'Cancelled before admission was sent to Run.' : 'Replacement not confirmed.';
            addWrapped(lines, `    ${result}`, mainWidth, { bg: C.panel, color: C.muted });
            if (delivery.state === 'accepted') {
              const key = JSON.stringify([pool, poolCursor, info?.revision, delivery]);
              addWrapped(lines, `${index === poolDeliveryIndex ? '›' : ' '}   Open original member history →`, mainWidth, { bg: index === poolDeliveryIndex ? C.selected : C.panel, color: C.accent, action: () => { selectPoolDelivery(index); if (selectedFormerDelivery()?.key === key) void openFormerMember(); else { alert = 'Replacement changed; refresh before opening.'; render(); } } });
            }
          }
        }
        if (!deliveryRows.length) lines.push({ text: 'No deliveries in this page.', color: C.muted });
        if (deliveryRows.some(value => object(value).operation === 'release_pin')) lines.push({ text: 'A pin release request does not confirm history was released.', color: C.muted });
        lines.push({ text: '' }, { text: 'Delivery does not establish processing or execution completion.', color: C.muted });
      }
      if (!poolContent && !journal && data && data.has_more === true) lines.push({ text: '[n] Next source page', color: C.accent, action: () => pagePool('next') });
      if (!poolContent && !journal && poolPrevious.length) lines.push({ text: '[g] Previous source page', color: C.accent, action: () => pagePool('older') });
      if (!poolContent && !journal && poolCursor > 0 && poolDetail.response && !usable(poolDetail.response)) lines.push({ text: '[h] Restart this section', color: C.accent, action: () => pagePool('first') });
      if (!poolContent && data && poolMetadata) { lines.push({ text: '' }, { text: `Coverage: ${shown(data.coverage)}`, color: C.muted }, { text: `Leader: ${shown(data.leader_id)} · source timestamps not reported`, color: C.muted }); }
    }

    if (wide && asideWidth > 12) {
      const sideHeight = Math.max(0, Math.min(12, renderer.height - bodyY - 3));
      surface(parent, asideX, bodyY, asideWidth, sideHeight, C.sidebar);
      const facts: string[] = pool && info ? ['Pool overview', `State: ${info.closed === true ? 'Closed' : 'Open'}`, `Revision: ${shown(info.revision)}`, `Source: Agent Pool`, `Page: ${data ? data.has_more === true ? 'More available' : 'End observed' : 'Unknown'}`, 'Historical timestamps unavailable'] : ['Observation', 'Source: Agent Pool', `Loaded: ${pools.value?.items.length ?? 'Unknown'}`, `Coverage: ${pools.value ? pools.value.complete ? 'End observed' : 'More available' : 'Unknown'}`, 'Pages are independent observations'];
      facts.slice(0, Math.max(0, sideHeight - 2)).forEach((fact, index) => textAt(parent, asideX + 2, bodyY + 1 + index, asideWidth - 4, fact, { color: index === 0 ? C.text : C.muted, bg: C.sidebar, bold: index === 0 }));
    }
    const journalStatus = journal ? `${journal.response && !usable(journal.response) ? journal.loaded ? 'History unavailable · last good' : 'History unavailable' : journal.busy ? 'Loading history' : 'History observed'} · ${journal.follow ? 'Following' : `Follow paused${journal.unseen ? ` · ${journal.unseen} new` : ''}`}${journal.previous ? ' · older available [g]' : ''}` : null;
    textAt(parent, 2, renderer.height - 3, width, `${poolContent ? 'Full content · Esc back' : journalStatus ?? (pool ? notice(poolDetail) : notice(pools))} · Agent Pool`, { color: C.muted });
    if (revealPoolSelection && selectedLine >= 0) { if (selectedLine < poolScroll) poolScroll = selectedLine; else if (selectedLine >= poolScroll + available) poolScroll = selectedLine - available + 1; }
    revealPoolSelection = false;
    if (!pool || data || journal || poolContent) poolScroll = Math.max(0, Math.min(poolScroll, Math.max(0, lines.length - available)));
    const visibleScroll = pool && !data && !journal && !poolContent ? 0 : poolScroll;
    if (!pool) poolSelectionShown = selectedLine >= visibleScroll && selectedLine < visibleScroll + available;
    lineViewport(parent, 2, bodyY, mainWidth, available, lines, visibleScroll, delta => { if (pool && !data && !journal && !poolContent) return; if (journal) journal.follow = false; poolScroll = Math.max(0, Math.min(Math.max(0, lines.length - available), visibleScroll + delta)); if (journal && poolScroll <= 2 && journal.previous) void olderPoolHistory(); render(); });
    if (pool && lines.length > available) showPoolScrollbar(2 + mainWidth - 1, bodyY, available, lines.length, visibleScroll);
  }
  /** Opens a matching Run session only while the selected Pool binding stays unchanged. */
  async function openMember(binding: Record<string, unknown>): Promise<void> {
    if (!poolDetail.good || poolDetail.response !== poolDetail.good) { alert = 'Pool binding is stale; refresh before opening.'; render(); return; }
    let target: BoundTarget;
    try { if (!pool) throw new Error('pool_missing'); target = bindingTarget(binding, pool); }
    catch { alert = 'No valid Run binding for this member.'; render(); return; }
    const sequence = target.request.targets[0].sequence, sourcePool = target.poolId, memberId = target.memberId;
    cancelPoolStatus(); cancelPoolMemberRead(); const controller = new AbortController(); poolMemberRead = controller;
    alert = 'Checking bound Run execution…'; render();
    const observed = await readBoundAgent(target, controller.signal), envelope = observed.envelope;
    if (poolMemberRead === controller) poolMemberRead = null;
    const members = poolDetail.value?.view ? object(poolDetail.value.view).members : null;
    if (!alive || controller.signal.aborted || route !== 'pools' || pool !== sourcePool || poolTab !== 'members' || !Array.isArray(members) || !members[poolMemberIndex] || object(members[poolMemberIndex]).member_id !== memberId) return;
    const bindings = poolDetail.value?.bindings;
    const currentBindings = Array.isArray(bindings) ? bindings.map(object).filter(value => object(value.member).member_id === memberId) : [];
    let currentTarget: BoundTarget | null = null;
    try { if (currentBindings.length === 1) currentTarget = bindingTarget(currentBindings[0], sourcePool); } catch { /* A malformed current binding cannot authorize navigation. */ }
    if (!currentTarget || currentTarget.key !== target.key) { alert = 'Pool binding changed; select the member again.'; render(); return; }
    if (!poolDetail.good || poolDetail.response !== poolDetail.good) { alert = 'Pool binding is stale; refresh before opening.'; render(); return; }
    if (!usable(envelope)) { alert = 'Bound Run execution is unavailable.'; render(); return; }
    const observation = observed.value, bound = observation?.agent;
    if (!bound || bound.sequence !== sequence) {
      const match = observation?.evidence?.match;
      alert = match === 'verified' || match === 'unverified' ? 'Run status available; selected execution view unavailable.' : `Bound execution is unavailable or ${match ?? 'not current'}.`;
      render(); return;
    }
    enterBoundSession(currentTarget, observation, envelope);
  }
  /** Publishes an already correlated binding and preserves the exact Pool Back location. */
  function enterBoundSession(target: BoundTarget, observation: BoundObservation, envelope: ReadResponse): void {
    const bound = observation.agent!;
    cancelRelatedRead(); reset(relatedAgent); relatedAgent.value = observation; relatedAgent.good = envelope; relatedAgent.response = envelope;
    if (directStatus === false) relatedNextScan = Date.now() + 30000;
    backStack.push(location()); forwardStack = []; route = 'sessions'; selected = bound.id; boundSequence = target.request.targets[0].sequence; boundTarget = target; focus = 'history'; tab = 'history'; full = false; detailFromRelated = true;
    if (currentBeginning()) jumpBeginning(false); else ensureDefaultHistory();
    alert = observation.evidence?.match === 'verified' ? `Execution ref matched${observation.evidence.storeFenced ? '' : ' · store unverified'} · history and answer attribution unverified` : `Run ID and sequence ${boundSequence} match · historical identity unverified${directStatus === false ? ' · scan 30s' : ''}`;
    refresh(); render();
  }
  /** Selects one delivery and cancels an archived binding lookup for the previous selection. */
  function selectPoolDelivery(index: number): void {
    if (poolDeliveryIndex !== index) cancelPoolMemberRead();
    poolDeliveryIndex = index;
  }
  /** Captures only a fresh accepted replacement and its exact displayed revision. */
  function selectedFormerDelivery(): { key: string; poolId: string; memberId: string; revision: number } | null {
    if (route !== 'pools' || !pool || poolContent || poolTab !== 'deliveries' || !poolDetail.good || poolDetail.response !== poolDetail.good || poolDetail.good.outcome !== 'ok' || poolDetail.good.error !== null) return null;
    try {
      const view = object(poolDetail.value?.view), revision = object(view.pool).revision, rows = view.deliveries;
      if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1 || !Array.isArray(rows) || !rows[poolDeliveryIndex]) return null;
      const delivery = object(rows[poolDeliveryIndex]);
      if (delivery.operation !== 'replace' || delivery.state !== 'accepted' || typeof delivery.operation_id !== 'string' || !delivery.operation_id || typeof delivery.member_id !== 'string' || !delivery.member_id) return null;
      return { key: JSON.stringify([pool, poolCursor, revision, delivery]), poolId: pool, memberId: delivery.member_id, revision };
    } catch { return null; }
  }
  /** Resolves and rechecks an archived owner binding before opening unverified Run lineage. */
  async function openFormerMember(): Promise<void> {
    const delivery = selectedFormerDelivery();
    if (!delivery) { alert = 'Select a fresh accepted replacement to open its original member.'; render(); return; }
    cancelPoolMemberRead(); const controller = new AbortController(); poolMemberRead = controller; formerDeliveryKey = delivery.key;
    const current = () => alive && !controller.signal.aborted && selectedFormerDelivery()?.key === delivery.key;
    const params = { pool_id: delivery.poolId, section: 'binding', member_id: delivery.memberId, expected_revision: delivery.revision };
    alert = 'Checking original member binding…'; render();
    try {
      const before = await read('pool.get', params, controller.signal);
      if (!current()) return;
      if (before.outcome !== 'ok' || before.error !== null) throw new Error('binding_unavailable');
      const binding = poolFormerBinding(before.data, delivery.poolId, delivery.memberId, delivery.revision);
      const target = bindingTarget(binding, delivery.poolId, product(before.data, 'pool_detail').observed_at_unix_ms);
      const observed = await readBoundAgent(target, controller.signal);
      if (!current()) return;
      if (!usable(observed.envelope) || observed.envelope.error !== null || independentlyPartial(observed.envelope) || !observed.value?.agent) throw new Error('run_unavailable');
      const after = await read('pool.get', params, controller.signal);
      if (!current()) return;
      if (after.outcome !== 'ok' || after.error !== null) throw new Error('binding_unavailable');
      const checked = poolFormerBinding(after.data, delivery.poolId, delivery.memberId, delivery.revision);
      const currentTarget = bindingTarget(checked, delivery.poolId, product(after.data, 'pool_detail').observed_at_unix_ms);
      if (currentTarget.key !== target.key) throw new Error('binding_changed');
      enterBoundSession(currentTarget, observed.value, observed.envelope);
    } catch {
      if (current()) { alert = 'Original member history unavailable; binding or Run identity could not be verified.'; render(); }
    } finally {
      if (poolMemberRead === controller) { poolMemberRead = null; formerDeliveryKey = null; }
    }
  }

  /** Follows the exact section cursor or revisits a previously requested page. */
  function pagePool(direction: 'next' | 'older' | 'newer' | 'first'): void {
    if (poolContent) return;
    cancelPoolMemberRead(); cancelPoolStatus();
    const data = poolDetail.value;
    if (direction === 'first') { savePoolPosition(); poolCursor = 0; poolRevision = null; poolPrevious = []; }
    else if (direction === 'older') { if (!poolPrevious.length) return; savePoolPosition(); poolCursor = poolPrevious.pop()!; }
    else {
      if (!data || data.has_more !== true) return;
      let next: number | null; try { next = decimalCursor(data.cursor); } catch { alert = 'Pool cursor exceeds the supported exact range.'; render(); return; }
      if (next === null || next <= poolCursor) return;
      savePoolPosition(); poolPrevious.push(poolCursor); poolCursor = next;
    }
    poolScroll = poolPositions.get(poolPositionKey()) ?? 0; refresh(); render();
  }
  /** Displays retained Bridge incident evidence with its fixed high-water cursor. */
  function drawIncidents(parent: BoxRenderable): void {
    const width = renderer.width - 4, height = renderer.height - 7, lines: Line[] = [];
    textAt(parent, 2, 2, width, 'Agent Bridge · retained incident evidence', { bold: true });
    textAt(parent, 2, 3, width, `${notice(incidents)} · includes closed incidents`, { color: C.muted });
    const data = incidents.value, rows = data && Array.isArray(data.incidents) ? data.incidents : [];
    for (const value of rows) { const row = object(value); addWrapped(lines, `#${shown(row.incident_seq)} · ${shown(row.publisher)} · ${shown(row.event_id)} · ${shown(row.state)}`, width, { bold: true }); addWrapped(lines, `Created: ${typeof row.created_ms === 'number' ? stamp(row.created_ms / 1000) : 'Not reported'} · metadata: ${shown(row)}`, width, { color: C.muted }); lines.push({ text: '' }); }
    if (!rows.length) lines.push({ text: data ? 'No incidents in this retained page.' : 'Loading or unavailable.', color: C.muted });
    if (typeof data?.next_after_seq === 'number') lines.push({ text: '[n] Load next retained page', color: C.accent, action: nextIncidents });
    incidentScroll = Math.max(0, Math.min(incidentScroll, Math.max(0, lines.length - height)));
    lineViewport(parent, 2, 5, width, height, lines, incidentScroll, delta => { incidentScroll = Math.max(0, Math.min(Math.max(0, lines.length - height), incidentScroll + delta)); render(); });
  }
  /** Continues the retained scan under the source's original high-water mark. */
  function nextIncidents(): void {
    const data = incidents.value; if (!data || typeof data.next_after_seq !== 'number' || typeof data.through_seq !== 'number' || data.next_after_seq <= bridgeAfter || data.next_after_seq >= data.through_seq) return;
    bridgeAfter = data.next_after_seq; bridgeThrough = data.through_seq; incidentScroll = 0; refresh();
  }
  /** Returns the currently available commands for the help/palette overlay. */
  function commands(): { name: string; action: () => void }[] {
    return [
      { name: 'Overview · 0', action: () => navigate('overview') }, { name: 'Sessions · 1', action: () => navigate('sessions') },
      { name: 'Agent Pool · 2', action: () => navigate('pools') },
      { name: 'Quota · 3', action: () => navigate('quota') }, { name: 'Worktree · 4', action: () => navigate('worktree') },
      { name: 'Refresh observations · r', action: () => refresh() }, { name: 'Cycle polling interval · u', action: cyclePolling }, { name: 'Back · Esc', action: back },
      { name: 'History fullscreen · z', action: toggleFull }, { name: 'Result · a', action: () => selectTab('result') },
      { name: 'Details · d', action: () => selectTab('details') }, { name: 'Quota technical details · d (Quota tab)', action: () => { navigate('quota'); quotaDetails = !quotaDetails; render(); } }, { name: 'Worktree technical details · d (Worktree tab)', action: () => { navigate('worktree'); worktreeDetails = !worktreeDetails; render(); } }, { name: 'History beginning · i', action: jumpBeginning }, { name: 'Follow latest · G', action: followLatest },
      { name: 'Appearance · ,', action: () => { overlay = { kind: 'theme', query: '', index: themes.indexOf(theme), original: theme }; render(); } },
      { name: 'Quit · q', action: onQuit },
    ];
  }
  /** Lists literal source folders and separately marked, path-derived project groups. */
  function folders(): string[] {
    const loaded = loadedAgents();
    const paths = [...new Set(loaded.map(agent => agent.workdir).filter((value): value is string => !!value))].sort();
    const projects = [...new Set(loaded.map(agentWorkdir).filter((value): value is { path: string; inferred: boolean } => !!value).map(value => projectRoot(value.path)))].sort();
    return [...projects.map(path => `Project: ${path}`), ...paths];
  }
  /** Builds picker rows without converting a missing source field into a value. */
  function overlayItems(active: Overlay): string[] {
    if (active.kind === 'period') return periods;
    if (active.kind === 'theme') return themes.map(value => value[0].toUpperCase() + value.slice(1));
    if (active.kind === 'folder') return ['All working folders', ...folders().filter(path => path.toLocaleLowerCase().includes(active.query.toLocaleLowerCase()))];
    if (active.kind === 'status') return ['All statuses', ...new Set(loadedAgents().map(agent => agent.status))];
    if (active.kind === 'help') return [
      '0 Overview · 1 Sessions · 2 Agent Pool · 3 Quota · 4 Worktree',
      'Tab / Shift+Tab: move focus; Left / Right: switch focused tabs',
      'Up / Down or j / k: move selection or scroll',
      'Page Up / Down: scroll · Home / i: beginning · End: latest',
      'Enter / Space: open selection or expand the current message',
      'p: period on Overview; working folder on Sessions',
      '/: search loaded records · t: lifecycle · x: reset filters',
      'o: expand/collapse Finished · n: load offered continuation',
      'z: fullscreen · g: older · G: follow · f: pause · [ / ]: long message parts',
      'a: result · d: details · c: copy verified result · y: copy session lineage',
      'Quota: d / Enter: show or hide technical details · Up / Down / Page Up / Down: scroll',
      'Worktree: Enter open · d raw codes · s measure size again',
      'Pool: m members · d decisions · c criteria · v votes · b deliveries · e purpose · s snapshot · l completion record (ledger)',
      'r: refresh · u: polling interval · ,: appearance · Esc: back · F: forward · Ctrl+P: commands · q: quit',
    ];
    if (active.kind === 'commands') return commands().map(command => command.name).filter(name => name.toLocaleLowerCase().includes(active.query.toLocaleLowerCase()));
    return [];
  }
  /** Draws a keyboard-operable overlay, leaving the underlying view state untouched. */
  function drawOverlay(parent: BoxRenderable): void {
    if (!overlay) return; const width = Math.min(renderer.width - 4, 70), height = Math.min(renderer.height - 4, overlay.kind === 'help' ? 17 : 15), x = Math.floor((renderer.width - width) / 2), y = Math.floor((renderer.height - height) / 2);
    const box = panel(parent, x, y, width, height, overlay.kind === 'search' ? 'Search loaded records' : overlay.kind === 'folder' ? 'Working folder filter' : overlay.kind === 'period' ? 'Reporting period' : overlay.kind === 'status' ? 'Lifecycle filter' : overlay.kind === 'theme' ? 'Appearance' : overlay.kind === 'help' ? 'Read-only commands' : 'Command palette');
    if (['search', 'folder', 'commands'].includes(overlay.kind)) textAt(box, 2, 1, width - 4, `> ${overlay.query}`, { color: C.accent, bg: C.panel });
    if (overlay.kind === 'search') { textAt(box, 2, 3, width - 4, 'Enter applies · Esc restores the previous search', { color: C.muted, bg: C.panel }); return; }
    if (overlay.kind === 'folder') textAt(box, 2, height - 2, width - 4, 'Project paths are inferred; literal folders use reported workdirs.', { color: C.muted, bg: C.panel });
    const items = overlayItems(overlay), start = ['folder', 'commands'].includes(overlay.kind) ? 3 : 1;
    overlay.index = Math.max(0, Math.min(overlay.index, Math.max(0, items.length - 1)));
    const offset = Math.max(0, Math.min(overlay.index, Math.max(0, items.length - (height - start - 2))));
    items.slice(offset, offset + height - start - 2).forEach((item, index) => textAt(box, 2, start + index, width - 4, `${index + offset === overlay?.index ? '›' : ' '} ${item}`, { color: index + offset === overlay?.index ? C.accent : C.text, bg: C.panel, overlay: true, click: () => { if (overlay) { overlay.index = index + offset; acceptOverlay(); } } }));
  }
  /** Executes the selected overlay action or commits a local filter. */
  function acceptOverlay(): void {
    if (!overlay) return; const active = overlay, items = overlayItems(active), chosen = items[active.index]; overlay = null;
    if (active.kind === 'search') { query = active.query.trim(); listTop = 0; }
    if (active.kind === 'folder') { const project = active.index > 0 && chosen?.startsWith('Project: ') ? chosen.slice('Project: '.length) : ''; filterProject = project; filterFolder = project ? '' : active.query && (active.index === 0 || !chosen) ? active.query.trim() : active.index === 0 ? '' : chosen; listTop = 0; }
    if (active.kind === 'status') { filterStatus = active.index === 0 ? '' : chosen ?? ''; filterPeriodFailures = false; if (filterStatus && terminalStates.has(filterStatus)) finishedOpen = true; listTop = 0; }
    if (active.kind === 'period') { period = periods[active.index] ?? period; refresh(); }
    if (active.kind === 'theme') {
      theme = themes[active.index] ?? theme; C = theme === 'light' || theme === 'system' && renderer.themeMode === 'light' ? lightColors : darkColors;
      void preferences?.save(theme).catch(() => { if (alive) { alert = 'Appearance changed for this session; saving failed.'; render(); } });
    }
    if ((active.kind === 'commands' || active.kind === 'help') && chosen) commands().find(command => command.name === chosen)?.action();
    render();
  }
  /** Handles text and picker keys before any global shortcut can run. */
  function overlayKey(key: KeyEvent): void {
    if (!overlay) return;
    if (key.name === 'escape') { overlay = null; render(); return; }
    if (key.name === 'return' || key.name === 'enter') { acceptOverlay(); return; }
    if (key.name === 'up' || key.name === 'down') { overlay.index += key.name === 'up' ? -1 : 1; render(); return; }
    if (['search', 'folder', 'commands'].includes(overlay.kind)) {
      if (key.name === 'backspace') overlay.query = [...overlay.query].slice(0, -1).join('');
      else if (!key.ctrl && !key.meta && key.sequence && !/[\x00-\x1f\x7f-\x9f]/.test(key.sequence)) overlay.query += key.sequence;
      overlay.index = 0; render();
    }
  }
  /** Restores a split view first, then the actual previous section/location. */
  function back(): void {
    if (overlay) { overlay = null; render(); return; }
    if (route === 'sessions' && full) { full = false; focus = previousFocus; render(); return; }
    if (route === 'sessions' && renderer.width < 110 && focus !== 'list' && !detailFromRelated) { focus = 'list'; render(); return; }
    if (route === 'pools' && poolContent) { closePoolContent(); render(); return; }
    if (route === 'worktree' && worktreeOpen) { worktreeOpen = null; worktreeInspectKey = ''; reset(worktreeInspect); render(); return; }
    if (route === 'pools' && pool) { cancelPoolMemberRead(); cancelPoolStatus(); savePoolPosition(); pool = null; poolScroll = 0; revealPoolSelection = true; render(); return; }
    const previous = backStack.pop(); if (previous) { forwardStack.push(location()); restore(previous); }
  }
  /** Toggles history fullscreen while preserving its focus and scroll anchor. */
  function toggleFull(): void { if (route !== 'sessions' || !selectedAgent()) return; if (!full) { previousFocus = focus; full = true; focus = 'history'; } else { full = false; focus = previousFocus; } render(); }
  /** Selects a session tab and starts its proof-bound read when needed. */
  function selectTab(value: SessionTab, nextFocus: Focus = 'history'): void { const agent = selectedAgent(); if (route !== 'sessions' || !agent) return; if (tab === 'result' && value !== 'result') cancelAnswerReads(executionKey(agent)); tab = value; focus = nextFocus; if (value === 'result') void loadAnswer(); else if (value === 'history') ensureDefaultHistory(); render(); }
  /** Opens the first retained page without combining it with a disconnected live tail. */
  function jumpBeginning(focusHistory = true): void {
    const agent = selectedAgent(), tail = tailHistory(); if (!agent || !tail || route !== 'sessions' || tab !== 'history') return;
    clearHistoryWheel(); if (focusHistory) focus = 'history'; tail.follow = false;
    const key = executionKey(agent); let beginning = beginnings.get(key);
    if (tail.loaded && tail.headComplete) {
      if (beginning) beginning.active = false;
      tail.windowStart = 0; tail.windowEnd = Math.min(historyWindowSize(), tail.grouped.entries.length); tail.anchor = null; tail.selected = null; tail.scroll = 0;
    } else {
      if (!beginning) {
        const state = history(); state.follow = false;
        beginning = { state, next: 0, active: true, autoPages: 0, width: 0, height: 0 }; beginnings.set(key, beginning);
      }
      beginning.active = true; beginning.autoPages = 0;
      const state = beginning.state;
      state.follow = false; state.windowStart = 0; state.windowEnd = Math.min(historyWindowSize(), state.grouped.entries.length); state.anchor = null; state.selected = null; state.scroll = 0;
      if (!state.loaded) void loadBeginningPage();
    }
    render();
  }
  /** Returns to the independently refreshed tail and resumes follow. */
  function followLatest(): void {
    const state = tailHistory(); if (!state || route !== 'sessions') return;
    clearHistoryWheel(); const beginning = currentBeginning(); if (beginning) beginning.active = false;
    state.follow = true; state.unseen = 0; state.anchor = null; state.selected = state.grouped.entries.at(-1)?.head.key ?? null; render();
  }
  /** Moves list selection by identity while keeping its four-row entry visible. */
  function moveAgent(delta: number): void {
    const items = visibleAgents(); if (!items.length) return; const index = Math.max(0, items.findIndex(agent => agent.id === selected)), next = Math.max(0, Math.min(items.length - 1, index + delta));
    chooseAgent(items[next].id); listTop = Math.max(0, next * 5 - Math.max(0, renderer.height - 12));
  }
  /** Keeps the visible source row fixed while expanding or collapsing an entry. */
  function toggleHistoryEntry(state: History, key: string): void {
    if (state !== currentHistory() || route !== 'sessions' || tab !== 'history' || overlay || !synchronizeHistory(state)) return;
    const index = state.grouped.byKey.get(key), entry = index === undefined ? undefined : state.grouped.entries[index];
    if (!entry) return;
    if (entry.head.role !== 'user' && !['tool', 'tool_call', 'tool_result'].includes(entry.head.role)) { state.selected = key; render(); return; }
    const keys = [entry.head, ...entry.calls, ...entry.results].map(block => block.key);
    const start = state.scroll, end = start + historyHeight;
    let row = historyLines.findIndex((line, position) => position >= start && position < end && line.key === entry.head.key && line.offset === -2);
    if (row < 0) row = historyLines.findIndex((line, position) => position >= start && position < end && line.key !== undefined && keys.includes(line.key) && line.offset !== undefined);
    if (row < 0) return;
    const line = historyLines[row];
    state.follow = false; state.anchor = { key: line.key!, offset: line.offset!, row: row - start }; state.selected = key;
    if (keys.some(item => state.expanded.has(item))) keys.forEach(item => state.expanded.delete(item)); else state.expanded.add(entry.head.key);
    render();
  }
  /** Toggles the currently anchored expandable source block. */
  function toggleMessage(): void {
    const state = currentHistory(); if (!state) return; const key = visibleHistoryKey(state);
    if (key) toggleHistoryEntry(state, key);
  }
  /** Resolves keyboard actions only to a message currently visible in the viewport. */
  function visibleHistoryKey(state: History): string | undefined {
    if (!synchronizeHistory(state)) return undefined;
    const visible = historyLines.slice(state.scroll, state.scroll + historyHeight);
    return state.selected && visible.some(line => line.key === state.selected && line.action) ? state.selected : visible.find(line => line.key && line.action)?.key;
  }
  /** Changes only the selected long message's bounded display part. */
  function changeMessagePart(delta: number, explicit?: string, expected?: History): void {
    const state = currentHistory(), key = explicit ?? (state ? visibleHistoryKey(state) : undefined);
    if (!state || expected && state !== expected || !key) return; const index = state.grouped.byKey.get(key), entry = index === undefined ? undefined : state.grouped.entries[index];
    if (!entry) return;
    let target = key, length = entry.head.content.length;
    if (entry.calls.length || entry.results.length || entry.head.role === 'tool') {
      const input = toolInput(entry), output = toolOutput(entry);
      const useOutput = entry.head.role === 'tool' || entry.results.some(block => block.key === key) || !explicit && segmentLength(input) <= RESULT_CHUNK && segmentLength(output) > RESULT_CHUNK;
      target = useOutput ? entry.results[0]?.key ?? entry.head.key : entry.calls[0]?.key ?? entry.head.key;
      length = segmentLength(useOutput ? output : input);
    }
    const last = Math.max(0, Math.ceil(length / RESULT_CHUNK) - 1);
    state.parts.set(target, Math.max(0, Math.min(last, (state.parts.get(target) ?? 0) + delta)));
    state.follow = false; state.selected = target; state.anchor = { key: target, offset: 0, row: 0 }; render();
  }
  /** Copies a complete hash-checked answer; OSC52 cannot confirm remote clipboard receipt. */
  function copyAnswer(): void { const agent = selectedAgent(); if (!agent) return; const answer = answers.get(JSON.stringify([executionKey(agent), agent.answerSha])); if (!answer || answer.content === null) { alert = 'No complete hash-checked answer to copy.'; } else { alert = renderer.copyToClipboardOSC52(answer.content) ? 'Copy requested; terminal receipt is not confirmed.' : 'Copy failed; select the displayed text if supported.'; } render(); }
  /** Scrolls a hash-checked answer through bounded chunks without losing its full text. */
  function scrollResult(delta: number): void {
    const agent = selectedAgent(), state = currentHistory();
    const answer = agent && answers.get(JSON.stringify([executionKey(agent), agent.answerSha]));
    if (!state || !answer?.content) return;
    const max = Math.max(0, historyLines.length - historyHeight), last = Math.max(0, Math.ceil(answer.content.length / RESULT_CHUNK) - 1);
    if (delta > 0 && state.resultScroll >= max && answer.chunk < last) { answer.chunk++; answer.lines = null; state.resultScroll = 0; }
    else if (delta < 0 && state.resultScroll === 0 && answer.chunk > 0) { answer.chunk--; answer.lines = null; state.resultScroll = Number.MAX_SAFE_INTEGER; }
    else state.resultScroll = Math.max(0, Math.min(max, state.resultScroll + delta));
    render();
  }
  /** Handles the current focus region's page and directional navigation. */
  function move(delta: number, page = false): void {
    const amount = delta * (page ? Math.max(1, renderer.height - 12) : 1);
    if (route === 'overview') { attentionIndex = Math.max(0, Math.min(1, attentionIndex + delta)); render(); return; }
    if (route === 'sessions') {
      if (focus === 'list' && !full) { moveAgent(delta); return; }
      if (focus === 'history') { if (tab === 'history') scrollHistory(amount); else if (tab === 'result') scrollResult(amount); else { const state = currentHistory(); if (state) { state.detailsScroll = Math.max(0, Math.min(Math.max(0, historyLines.length - historyHeight), state.detailsScroll + amount)); render(); } } }
      return;
    }
    if (route === 'pools') { if (poolContent) { poolScroll = Math.max(0, poolScroll + amount); render(); return; } const journal = pool && poolTab === 'discussion' && poolHistorySupported() === true ? poolHistory(pool) : null; if (pool && !poolDetail.value && !journal) return; if (!pool) { poolIndex = Math.max(0, Math.min(visiblePools().length - 1, poolIndex + delta * (page ? Math.max(1, Math.floor((renderer.height - 7) / 3)) : 1))); revealPoolSelection = true; } else if (poolTab === 'deliveries' && !page && poolDetail.value?.view) { const rows = object(poolDetail.value.view).deliveries; if (Array.isArray(rows)) selectPoolDelivery(Math.max(0, Math.min(rows.length - 1, poolDeliveryIndex + delta))); revealPoolSelection = true; } else if (poolTab === 'members' && !page && poolDetail.value?.view) { const members = object(poolDetail.value.view).members; if (Array.isArray(members)) { poolMemberIndex = Math.max(0, Math.min(members.length - 1, poolMemberIndex + delta)); void refreshPoolStatus(); } revealPoolSelection = true; } else if (poolTab === 'decisions' && !page && Array.isArray(poolDetail.value?.decisions) && poolDetail.value.decisions.length) { poolDecisionIndex = Math.max(0, Math.min(poolDetail.value.decisions.length - 1, poolDecisionIndex + delta)); revealPoolSelection = true; } else if (poolTab === 'votes' && !page && poolVoteRows().length) { poolVoteIndex = Math.max(0, Math.min(poolVoteRows().length - 1, poolVoteIndex + delta)); revealPoolSelection = true; } else { if (journal) journal.follow = false; poolScroll = Math.max(0, poolScroll + amount); if (journal && poolScroll <= 2 && journal.previous) void olderPoolHistory(); } render(); return; }
    if (route === 'quota') { quotaScroll = Math.max(0, quotaScroll + amount); render(); }
    if (route === 'worktree') {
      if (worktreeOpen) worktreeSessionIndex = Math.max(0, worktreeSessionIndex + (page ? amount : delta));
      else moveWorktree(page ? amount : delta);
      render();
    }
    if (route === 'incidents') { incidentScroll = Math.max(0, incidentScroll + amount); render(); }
  }
  /** Copies only a complete, bounded source snapshot for the originally selected target. */
  async function copyHistory(): Promise<void> {
    if (copyController) return;
    if (poolContent) { alert = 'Close full content before copying history.'; render(); return; }
    if (route === 'pools' && poolHistorySupported() !== true) { alert = 'Pool history copy requires a source watermark and is not available.'; render(); return; }
    const agent = route === 'sessions' ? selectedAgent() : null;
    const bound = agent && boundSequence !== null ? boundTarget : null, evidence = bound ? currentBoundEvidence() : null;
    if (agent && boundSequence !== null && (!bound || !relatedAgent.good || relatedAgent.response !== relatedAgent.good || evidence?.match !== 'verified' || !evidence.storeFenced || evidence.pinState !== 'active' || evidence.coverage !== 'complete' || !bound.request.expected_store_id || !bound.request.targets[0].execution_ref || !bound.request.targets[0].pin_id)) { alert = 'Exact execution copy requires a fresh verified store, execution and active pin.'; render(); return; }
    const target = bound && agent ? { kind: 'exact' as const, request: bound.request, key: bound.key, executionKey: executionKey(agent) } : agent ? { kind: 'session' as const, id: agent.id } : route === 'pools' && pool && poolTab === 'discussion' ? { kind: 'pool' as const, id: pool } : null;
    if (!target) { alert = 'No eligible history selected.'; render(); return; }
    const controller = new AbortController(); copyController = controller; exactCopyExecution = target.kind === 'exact' ? target.executionKey : null; controllers.add(controller);
    alert = target.kind === 'exact' ? 'Scanning pinned execution history · Esc cancels' : target.kind === 'session' ? 'Scanning retained session lineage; pruning may omit records · Esc cancels' : 'Scanning frozen pool journal · Esc cancels'; render();
    try {
      const currentExact = () => target.kind !== 'exact' || route === 'sessions' && detailFromRelated && boundTarget?.key === target.key && !!selectedAgent() && executionKey(selectedAgent()!) === target.executionKey;
      if (target.kind === 'exact') {
        const discovery = await read('run.identity', {}, controller.signal);
        if (discovery.outcome !== 'ok' || discovery.error !== null) throw new Error('Run exact transcript capability is unavailable');
        const value = object(discovery.data).capabilities;
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Run does not advertise exact transcript export');
        const capabilities = object(value), methods = capabilities.read_methods;
        if (capabilities.schema_version !== 1 || capabilities.product !== 'agent-run' || !Array.isArray(methods) || !methods.some(value => value && typeof value === 'object' && !Array.isArray(value) && object(value).name === 'transcript_exact')) throw new Error('Run does not advertise exact transcript export');
        if (!currentExact()) throw new Error('Selected execution changed');
      }
      const content = target.kind === 'exact' ? await exportExactHistory(client, target.request, controller.signal) : await exportHistory(client, target, controller.signal);
      if (!alive || controller.signal.aborted) return;
      if (!currentExact()) throw new Error('Selected execution changed');
      alert = renderer.copyToClipboardOSC52(content) ? target.kind === 'exact' ? 'Exact execution copy requested; terminal receipt is not confirmed.' : target.kind === 'session' ? 'Retained scan copy requested; pruning may omit records, receipt unconfirmed.' : 'Journal copy requested; terminal receipt is not confirmed.' : 'Copy failed; select displayed text if supported.';
    } catch (error) {
      if (alive) alert = controller.signal.aborted ? 'History export cancelled; clipboard unchanged.' : `History copy withheld: ${error instanceof Error ? safe(error.message) : 'source unavailable'}`;
    } finally {
      controllers.delete(controller); if (copyController === controller) { copyController = null; exactCopyExecution = null; } if (alive) render();
    }
  }
  /** Dispatches keyboard actions only when no picker or text edit owns input. */
  function onKey(key: KeyEvent): void {
    if (!alive) return; clearHistoryWheel(); if (overlay) { overlayKey(key); return; }
    if (key.name === 'escape' && copyController) { copyController.abort(); return; }
    const name = /^[A-Z]$/.test(key.name) ? key.name.toLowerCase() : key.name, upper = key.shift || /^[A-Z]$/.test(key.name) || /^[A-Z]$/.test(key.sequence);
    if (name === 'u' && !key.ctrl && !key.meta) { cyclePolling(); return; }
    alert = '';
    if (key.ctrl && name === 'p') { overlay = { kind: 'commands', query: '', index: 0, original: '' }; render(); return; }
    if (key.ctrl && name === 'c' || name === 'q') { onQuit(); return; }
    if (name === '?' || key.sequence === '?') { overlay = { kind: 'help', query: '', index: 0, original: '' }; render(); return; }
    if (name === ',' || key.sequence === ',') { overlay = { kind: 'theme', query: '', index: themes.indexOf(theme), original: theme }; render(); return; }
    if (name === 'escape') { back(); return; }
    if (name === 'f' && upper) { const next = forwardStack.pop(); if (next) { backStack.push(location()); restore(next); } return; }
    if (name === '0') { navigate('overview'); return; }
    if (name === '1') { navigate('sessions'); return; }
    if (name === '2') { navigate('pools'); return; }
    if (name === '3') { navigate('quota'); return; }
    if (name === '4') { navigate('worktree'); return; }
    if (name === 'r') { if (route === 'sessions') { const agent = selectedAgent(); if (agent) { const key = JSON.stringify([executionKey(agent), agent.answerSha]); answers.get(key)?.controller?.abort(); answers.delete(key); initialTasks.get(executionKey(agent))?.controller?.abort(); initialTasks.delete(executionKey(agent)); } if (detailFromRelated) { directStatus = null; relatedNextScan = 0; } } if (route === 'pools') poolStatusRetryAt = 0; if (route === 'worktree') { worktreesLoadedAt = 0; worktreeInspectAt = 0; worktreeFactsAt.clear(); } refresh(); return; }
    if (name === 'tab' && route === 'sessions') { const choices: Focus[] = full || renderer.width < 110 && focus !== 'list' ? ['tabs', 'history'] : ['list', 'tabs', 'history']; const current = choices.indexOf(focus); focus = choices[(current + (key.shift ? choices.length - 1 : 1)) % choices.length]; render(); return; }
    if (name === 'up' || name === 'k') { move(-1); return; }
    if (name === 'down' || name === 'j') { move(1); return; }
    if (name === 'pageup' || name === 'pgup') { move(-1, true); return; }
    if (name === 'pagedown' || name === 'pgdown') { move(1, true); return; }
    if ((name === 'home' || name === 'end') && route === 'sessions' && focus === 'history' && tab === 'result') {
      const agent = selectedAgent(), state = currentHistory(), answer = agent && answers.get(JSON.stringify([executionKey(agent), agent.answerSha]));
      if (state && answer?.content) { answer.chunk = name === 'home' ? 0 : Math.max(0, Math.ceil(answer.content.length / RESULT_CHUNK) - 1); answer.lines = null; state.resultScroll = name === 'home' ? 0 : Number.MAX_SAFE_INTEGER; render(); }
      return;
    }
    if (name === 'home') {
      if (route === 'sessions' && focus === 'history' && tab === 'history') jumpBeginning();
      else move(-10000, true);
      return;
    }
    if (name === 'end') { if (route === 'sessions' && focus === 'history' && tab === 'history') followLatest(); else move(10000, true); return; }
    if ((name === 'left' || name === 'right') && route === 'sessions' && focus === 'tabs') { const index = sessionTabs.indexOf(tab); selectTab(sessionTabs[(index + (name === 'right' ? 1 : sessionTabs.length - 1)) % sessionTabs.length], 'tabs'); return; }
    if ((name === 'left' || name === 'right') && route === 'pools' && pool) { const index = poolTabs.indexOf(poolTab); setPoolTab(poolTabs[(index + (name === 'right' ? 1 : poolTabs.length - 1)) % poolTabs.length]); return; }
    if (name === 'return' || name === 'enter' || name === 'space') {
      if (route === 'pools' && poolContent) return;
      if (route === 'overview') openAttention(attentionIndex);
      else if (route === 'quota') { quotaDetails = !quotaDetails; render(); }
      else if (route === 'worktree') {
        if (!worktreeOpen) openWorktree(worktreeSelected(worktreeRows().length));
        else { const linked = linkedSessions(worktreeOpen.row, worktreeRows().map(entry => entry.row), loadedAgents()); if (linked[worktreeSessionIndex]) openSession(linked[worktreeSessionIndex].id); }
      }
      else if (route === 'sessions') { if (focus === 'list') { focus = 'history'; void loadHistory(); render(); } else if (focus === 'history' && tab === 'history') toggleMessage(); }
      else if (route === 'pools' && !pool) { const items = visiblePools(); if (items[poolIndex]) choosePool(String(object(items[poolIndex].pool).pool_id)); }
      else if (route === 'pools' && poolTab === 'members' && poolDetail.value?.view) { const members = object(poolDetail.value.view).members, bindings = poolDetail.value.bindings; if (Array.isArray(members) && members[poolMemberIndex] && Array.isArray(bindings)) { const id = object(members[poolMemberIndex]).member_id, binding = bindings.map(object).find(value => object(value.member).member_id === id); if (binding) openMember(binding); } }
      else if (route === 'pools' && poolTab === 'decisions' && Array.isArray(poolDetail.value?.decisions)) { const proposal = poolDetail.value.decisions[poolDecisionIndex]; if (proposal && typeof object(proposal).proposal_id === 'string') choosePoolProposal(String(object(proposal).proposal_id)); }
      else if (route === 'pools' && poolTab === 'votes') choosePoolVote(poolVoteIndex);
      else if (route === 'pools' && poolTab === 'deliveries') void openFormerMember();
      return;
    }
    if (name === 'p' && route === 'overview') { overlay = { kind: 'period', query: '', index: periods.indexOf(period), original: period }; render(); return; }
    if (name === '/' && (route === 'sessions' || route === 'pools')) { overlay = { kind: 'search', query, index: 0, original: query }; render(); return; }
    if (name === 'p' && route === 'sessions') { overlay = { kind: 'folder', query: '', index: 0, original: filterFolder }; render(); return; }
    if (name === 't' && route === 'sessions') { overlay = { kind: 'status', query: '', index: 0, original: filterStatus }; render(); return; }
    if (name === 'x' && (route === 'sessions' || route === 'pools')) { query = ''; filterFolder = ''; filterProject = ''; filterStatus = ''; filterPeriodFailures = false; listTop = 0; render(); return; }
    if (name === 'o' && route === 'sessions') { toggleFinished(); return; }
    if (name === 'n') {
      if (route === 'sessions' && tab === 'history' && focus === 'history' && currentBeginning()?.active) { void loadBeginningPage(); return; }
      if (route === 'sessions' && agents.value?.next !== null && agents.value?.next !== undefined) { agentPages++; refresh(); }
      if (route === 'pools' && !pool && pools.value?.next !== null && pools.value?.next !== undefined) { poolPages++; refresh(); }
      if (route === 'pools' && pool && !(poolTab === 'discussion' && poolHistorySupported() === true)) pagePool('next');
      if (route === 'incidents') nextIncidents(); return;
    }
    if (name === 'z') { toggleFull(); return; }
    if (name === 'a') { selectTab('result'); return; }
    if (name === 'd' && route === 'sessions') { selectTab('details'); return; }
    if (name === 'd' && route === 'quota') { quotaDetails = !quotaDetails; render(); return; }
    if (name === 'd' && route === 'worktree' && !worktreeOpen) { worktreeDetails = !worktreeDetails; render(); return; }
    if (name === 's' && route === 'worktree' && !worktreeOpen) { worktreeFactsAt.clear(); void loadWorktreeFacts(); render(); return; }
    if (name === 'c' && route === 'sessions' && tab === 'result') { copyAnswer(); return; }
    if (name === 'y') { void copyHistory(); return; }
    if (name === 'i' && route === 'sessions' && tab === 'history') { jumpBeginning(); return; }
    if (name === 'i' && route === 'pools' && pool) { poolMetadata = !poolMetadata; render(); return; }
    if (name === 'e' && route === 'pools' && pool) { void openPoolContent('purpose'); return; }
    if (name === 'l' && route === 'pools' && pool) { void openCompletion(); return; }
    if (name === 's' && route === 'pools' && pool && poolTab === 'decisions') { const view = poolProposal.value?.view ? object(poolProposal.value.view) : null, source = view ? object(view.pool).proposal : null, proposal = source && typeof source === 'object' && !Array.isArray(source) ? object(source) : null; if (proposal && typeof proposal.proposal_id === 'string' && typeof proposal.snapshot_bytes === 'number') void openPoolContent('snapshot', proposal.proposal_id); else { alert = 'No exact proposal snapshot is selected.'; render(); } return; }
    if (route === 'pools' && poolContent && ['g', 'f', 'h'].includes(name)) return;
    if (name === 'g' && upper) { if (route === 'sessions') followLatest(); else if (route === 'pools' && pool && poolTab === 'discussion' && poolHistorySupported() === true) { const journal = poolHistory(pool); journal.follow = true; journal.unseen = 0; poolScroll = Number.MAX_SAFE_INTEGER; void refreshPoolHistory(pool); render(); } else if (route === 'pools' && pool) pagePool('newer'); return; }
    if (name === 'g') { if (route === 'sessions' && !currentBeginning()?.active) void loadHistory(true); else if (route === 'pools' && pool && poolTab === 'discussion' && poolHistorySupported() === true) { poolHistory(pool).follow = false; void olderPoolHistory(); } else if (route === 'pools' && pool) pagePool('older'); return; }
    if (name === 'h' && route === 'pools' && pool) { if (poolTab === 'discussion' && poolHistorySupported() === true) { poolHistories.delete(pool); poolScroll = 0; void refreshPoolHistory(pool); } else pagePool('first'); return; }
    if ((name === '[' || name === ']') && route === 'sessions' && tab === 'history') { changeMessagePart(name === ']' ? 1 : -1); return; }
    if (name === 'f' && route === 'sessions' && tab === 'history') { if (currentBeginning()?.active) followLatest(); else { const state = currentHistory(); if (state) { state.follow = !state.follow; if (state.follow) { state.unseen = 0; state.anchor = null; render(); } else scrollHistory(0); } } return; }
    if (name === 'f' && route === 'pools' && pool && poolTab === 'discussion' && poolHistorySupported() === true) { const journal = poolHistory(pool); journal.follow = !journal.follow; if (journal.follow) { journal.unseen = 0; poolScroll = Number.MAX_SAFE_INTEGER; void refreshPoolHistory(pool); } render(); return; }
    if (route === 'pools' && pool) { if (name === 'm') setPoolTab('members'); if (name === 'd') setPoolTab('decisions'); if (name === 'c') setPoolTab('criteria'); if (name === 'v') setPoolTab('votes'); if (name === 'b') setPoolTab('deliveries'); }
  }
  /** Coalesces state changes so input packets keep their last painted targets. */
  function render(): void {
    if (!alive || pendingPaint !== null) return;
    pendingPaint = renderer.requestAnimationFrame(() => { pendingPaint = null; paint(); });
    if (pendingPaint < 0) pendingPaint = null;
  }
  /** Releases old hit targets only after a newer scene has actually painted. */
  function releaseRetiredFrames(): void { for (const previous of retiredFrames) previous.destroyRecursively(); retiredFrames.clear(); }
  /** Rebuilds a full-screen overlay while retaining the previous frame's hit targets. */
  function paint(): void {
    if (!alive) return; drainHistoryWheel(); spinnerRows = []; historyViewportRendered = false; historyTrack.visible = false; poolTrack.visible = false;
    if (frame) { frame.zIndex = -1; retiredFrames.add(frame); }
    frame = new BoxRenderable(renderer, { position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', backgroundColor: C.bg }); renderer.root.add(frame, 0);
    const w = renderer.width, h = renderer.height;
    surface(frame, 0, 0, w, Math.min(2, h), C.header);
    textAt(frame, 2, 0, 12, 'agent-hub', { bold: true, color: C.text, bg: C.header });
    const modeLabel = mode === 'demo' ? 'DEMO DATA' : 'LIVE READ-ONLY', modeX = Math.max(15, w - stringWidth(modeLabel) - 2);
    let navX = 16;
    for (const item of [{ route: 'overview' as const, label: 'Overview' }, { route: 'sessions' as const, label: 'Sessions' }, { route: 'pools' as const, label: 'Pools' }, { route: 'quota' as const, label: 'Quota' }, { route: 'worktree' as const, label: 'Worktree' }]) {
      const label = item.route === route ? `[${item.label}]` : item.label, width = Math.min(stringWidth(label), modeX - navX - 1);
      textAt(frame, navX, 0, width, label, { color: item.route === route ? C.text : C.muted, bg: C.header, click: () => navigate(item.route) });
      navX += stringWidth(label) + 3;
    }
    textAt(frame, modeX, 0, w - modeX, modeLabel, { color: C.muted, bg: C.header });
    const pollingLabel = `Poll: ${pollingIntervals[pollingIndex]}s [u]`, pollingWidth = stringWidth(pollingLabel);
    textAt(frame, Math.max(2, w - pollingWidth - 2), 1, Math.min(pollingWidth, Math.max(0, w - 4)), pollingLabel, { color: C.accent, bg: C.header, click: () => { if (!overlay) cyclePolling(); } });
    if (w < 60 || h < 16) textAt(frame, 2, Math.max(2, Math.floor(h / 2)), Math.max(1, w - 4), 'Resize terminal to at least 60 × 16. Navigation state is retained.', { color: C.accent });
    else if (route === 'overview') drawOverview(frame);
    else if (route === 'sessions') drawSessions(frame);
    else if (route === 'pools') drawPools(frame);
    else if (route === 'quota') drawQuota(frame);
    else if (route === 'worktree') drawWorktree(frame);
    else drawIncidents(frame);
    const hint = route === 'overview' ? '↑↓ select   enter open   1 sessions   p period   r refresh   ? help' : route === 'sessions' ? (w < 105 ? '↑↓ select  enter open  i start  o finished  z full  esc back  ? help' : '↑↓ select   enter history   i start   o finished   z fullscreen   ctrl+p commands   ? help   q quit') : route === 'pools' ? '↑↓ move  enter open  ←→ tabs  i details  n/g/G pages  esc back  ?' : route === 'quota' ? '↑↓ scroll   d details   n next   r refresh   esc back   ? help' : route === 'worktree' ? '↑↓ select   enter open   d details   s measure   r refresh   esc back   ? help' : '↑↓ scroll   n next   r refresh   esc back   ? help';
    textAt(frame, 2, h - 1, Math.max(1, w - 4), alert || hint, { color: alert ? C.accent : C.muted });
    if (overlay) { historyTrack.visible = false; poolTrack.visible = false; drawOverlay(frame); }
    requestVisibleToolTime();
    renderer.requestRender();
  }
  /** Reapplies the system preference when the terminal reports a theme change. */
  function terminalThemeChanged(): void { if (theme === 'system') { C = renderer.themeMode === 'light' ? lightColors : darkColors; render(); } }
  // This native control survives scene rebuilds so a mouse drag keeps its capture.
  let draggingHistoryTrack = false, historyThumbTop = 0, historyThumbHeight = 1;
  let historyDrag: { state: History; total: number; span: number; position: number; startY: number; startPosition: number } | null = null;
  /** Freezes the scrollbar scale while the pointer is held over changing message lengths. */
  function historyPointer(event: MouseEvent): void {
    if (event.type === 'down' && event.button === 0) {
      const state = currentHistory(); if (route !== 'sessions' || tab !== 'history' || overlay || !historyTrack.visible || !state?.grouped.entries.length) return;
      const extent = historyExtent(state), total = state.grouped.entries.length, span = Math.min(total, Math.max(0.01, extent.end - extent.start));
      const position = total > span ? Math.max(0, Math.min(1, extent.start / (total - span))) : 0;
      historyDrag = { state, total, span, position, startY: event.y, startPosition: position };
    } else if (event.type === 'up' || event.type === 'drag-end') {
      const drag = historyDrag;
      queueMicrotask(() => { if (historyDrag === drag && drag) { historyDrag = null; if (alive) render(); } });
    }
  }
  /** Maps a track click or a held thumb to a position in the frozen history scale. */
  const seekTrack = (event: MouseEvent, dragging = false) => {
    const offset = event.y - historyTrack.y;
    const value = dragging && historyDrag ? historyDrag.startPosition + (event.y - historyDrag.startY) / Math.max(1, historyTrack.height - historyThumbHeight) : offset / Math.max(1, historyTrack.height);
    if (offset >= historyTrack.height - 1) { seekHistory(1); return; }
    if (offset <= 0) { seekHistory(0); return; }
    seekHistory(Math.max(0, Math.min(1, value)));
  };
  const historyTrack = new BoxRenderable(renderer, { position: 'absolute', zIndex: 1, left: 0, top: 0, width: 1, height: 1, visible: false, backgroundColor: C.cell,
    onMouse: historyPointer,
    onMouseDown: event => { if (event.button === 0 && historyDrag) { clearHistoryWheel(); event.preventDefault(); draggingHistoryTrack = true; const offset = event.y - historyTrack.y; if (offset < historyThumbTop || offset >= historyThumbTop + historyThumbHeight) seekTrack(event); historyDrag.startY = event.y; historyDrag.startPosition = historyDrag.position; } },
    onMouseDrag: event => { if (draggingHistoryTrack) seekTrack(event, true); }, onMouseUp: () => { draggingHistoryTrack = false; },
    onMouseScroll: event => queueHistoryWheel(event),
  });
  const historyThumb = new BoxRenderable(renderer, { position: 'absolute', left: 0, top: 0, width: 1, height: 1, backgroundColor: C.muted });
  historyTrack.add(historyThumb); renderer.root.add(historyTrack);
  let poolTrackLimit = 0, poolThumbTop = 0, poolThumbHeight = 1;
  let poolDrag: { key: string; startY: number; startScroll: number } | null = null;
  /** Shows a continuous scrollbar for the currently loaded pool section. */
  function showPoolScrollbar(x: number, y: number, height: number, total: number, scroll: number): void {
    poolTrackLimit = Math.max(0, total - height);
    poolTrack.left = x; poolTrack.top = y; poolTrack.height = height; poolTrack.backgroundColor = C.cell;
    poolThumbHeight = Math.max(1, Math.round(height * height / total));
    poolThumbTop = Math.round((height - poolThumbHeight) * scroll / Math.max(1, poolTrackLimit));
    poolThumb.top = poolThumbTop; poolThumb.height = poolThumbHeight; poolThumb.backgroundColor = C.muted; poolTrack.visible = true;
  }
  /** Scrolls only the same section that captured the pointer. */
  function seekPoolTrack(event: MouseEvent, drag = false): void {
    if (!poolDrag || route !== 'pools' || !pool || overlay || poolDrag.key !== `${poolPositionKey()}:${poolContent?.field ?? ''}`) return;
    const position = drag ? poolDrag.startScroll + (event.y - poolDrag.startY) * poolTrackLimit / Math.max(1, poolTrack.height - poolThumbHeight) : (event.y - poolTrack.y) * poolTrackLimit / Math.max(1, poolTrack.height - 1);
    poolScroll = Math.max(0, Math.min(poolTrackLimit, Math.round(position)));
    if (!poolContent && poolTab === 'discussion' && poolHistorySupported() === true) { const journal = poolHistory(pool); journal.follow = false; if (poolScroll <= 2 && journal.previous) void olderPoolHistory(); }
    render();
  }
  const poolTrack = new BoxRenderable(renderer, { position: 'absolute', zIndex: 1, left: 0, top: 0, width: 1, height: 1, visible: false, backgroundColor: C.cell,
    onMouseDown: event => { if (event.button !== 0 || overlay || route !== 'pools' || !pool) return; event.preventDefault(); poolDrag = { key: `${poolPositionKey()}:${poolContent?.field ?? ''}`, startY: event.y, startScroll: poolScroll }; const offset = event.y - poolTrack.y; if (offset < poolThumbTop || offset >= poolThumbTop + poolThumbHeight) seekPoolTrack(event); if (poolDrag) poolDrag.startScroll = poolScroll; },
    onMouseDrag: event => { if (poolDrag) seekPoolTrack(event, true); },
    onMouseUp: () => { poolDrag = null; },
    onMouseScroll: event => { if (overlay || route !== 'pools' || !pool) return; if (!poolContent && poolTab === 'discussion' && poolHistorySupported() === true) poolHistory(pool).follow = false; poolScroll = Math.max(0, Math.min(poolTrackLimit, poolScroll + (event.scroll?.direction === 'up' ? -3 : event.scroll?.direction === 'down' ? 3 : 0))); if (!poolContent && poolScroll <= 2 && poolTab === 'discussion') void olderPoolHistory(); render(); },
  });
  const poolThumb = new BoxRenderable(renderer, { position: 'absolute', left: 0, top: 0, width: 1, height: 1, backgroundColor: C.muted });
  poolTrack.add(poolThumb); renderer.root.add(poolTrack);
  renderer.keyInput.on('keypress', onKey); renderer.on('resize', render); renderer.on('theme_mode', terminalThemeChanged); renderer.on('frame', releaseRetiredFrames);
  render(); refresh(); schedulePolling();
  const spinnerTimer = setInterval(() => {
    if (!spinnerRows.length) return;
    spinnerFrame = (spinnerFrame + 1) % spinnerFrames.length;
    for (const row of spinnerRows) { row.value = row.value.slice(0, 2) + spinnerFrames[spinnerFrame] + row.value.slice(3); row.text.content = row.value; }
    renderer.requestRender();
  }, 80);
  return () => { if (!alive) return; alive = false; if (pendingPaint !== null) renderer.cancelAnimationFrame(pendingPaint); if (pollingTimer !== null) clearInterval(pollingTimer); clearInterval(spinnerTimer); spinnerRows = []; for (const controller of controllers) controller.abort(); controllers.clear(); renderer.keyInput.off('keypress', onKey); renderer.off('resize', render); renderer.off('theme_mode', terminalThemeChanged); renderer.off('frame', releaseRetiredFrames); releaseRetiredFrames(); frame?.destroyRecursively(); frame = null; historyTrack.destroyRecursively(); poolTrack.destroyRecursively(); };
}
