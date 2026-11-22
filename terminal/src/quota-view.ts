/** Presentation model of the Quota tab and Overview card: per-account blocks, per-window bars and pace.
 * Pure and renderer-independent: it maps the already validated snapshot to rows of toned spans.
 * Unknown stays Unknown (dim, empty bar) and is never converted to zero capacity. */
import stringWidth from 'string-width';
import { span } from './quota.ts';
import type { QuotaAccount, QuotaModel, QuotaSnapshot, QuotaSource, QuotaWindow, Tone } from './quota.ts';

/** One run of identically styled text inside a row. */
export interface Span { text: string; tone: Tone; bold?: boolean }
/** One rendered terminal row; card rows sit on the raised surface, other rows on the page. */
export interface Row { spans: Span[]; card: boolean }
/** Overall account state shown as a badge. */
export type Badge = 'OK' | 'AT RISK' | 'EXHAUSTED' | 'UNKNOWN';

/** Filled, empty and marker glyphs of a progress bar. */
export const BAR_FILLED = '█', BAR_EMPTY = '░', BAR_PACE = '┃';
/** A window is considered inconsistent when its reset is further away than the window length by this factor. */
const PACE_TOLERANCE = 1.02;
/** Exhaustion further away than this is not announced; the burn is effectively idle. */
const FAR_SECONDS = 365 * 86400;
/** Below this many percent left a known window is highlighted even when pace is fine. */
const LOW_PERCENT = 10;

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fourteen: 14, thirty: 30 };
const UNIT_SECONDS: Record<string, number> = { minute: 60, hour: 3600, day: 86400, week: 604800 };

/** Returns the window length in seconds from its producer name, or null when it cannot be derived. */
export function windowSeconds(name: string): number | null {
  const lower = name.toLowerCase();
  if (lower === 'weekly') return 7 * 86400;
  if (lower === 'daily') return 86400;
  if (lower === 'hourly') return 3600;
  const match = /^([a-z0-9]+)_(minute|hour|day|week)s?(?:_[a-z0-9_]+)?$/.exec(lower);
  if (!match) return null;
  const count = /^\d+$/.test(match[1]!) ? Number(match[1]) : NUMBER_WORDS[match[1]!];
  return count && count > 0 ? count * UNIT_SECONDS[match[2]!]! : null;
}
/** Formats a window length such as 5h, 7d or 30m. */
function shortDuration(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  return `${Math.round(seconds / 60)}m`;
}
/** Capitalizes the first letter. */
function capital(value: string): string { return value ? value[0]!.toUpperCase() + value.slice(1) : value; }
/** Names a window for people: Session (5h), Weekly (7d), Fable weekly (7d); unknown names are shown as reported. */
export function windowTitle(window: string, lane: string): string {
  const length = windowSeconds(window);
  const base = length === 18000 ? 'Session' : length === 7 * 86400 ? 'Weekly' : length === 86400 ? 'Daily' : capital(window.replace(/_/g, ' '));
  const model = lane.startsWith('model:') && lane.length > 6 ? lane.slice(6) : null;
  const name = model ? `${capital(model)} ${base.toLowerCase()}` : base;
  return length === null ? name : `${name} (${shortDuration(length)})`;
}

/** Expected remaining percentage at an even burn rate: the window start is the reset minus its length.
 * Null when the length or the reset clock is unknown, the reset has passed, or the clock is inconsistent. */
export function paceRemaining(window: string, resetAt: number | null, now: number): number | null {
  const length = windowSeconds(window);
  if (length === null || resetAt === null) return null;
  const left = resetAt - now;
  if (left <= 0 || left > length * PACE_TOLERANCE) return null;
  return Math.min(100, Math.max(0, left / length * 100));
}

/** Cell layout of one bar: `filled` cells carry the remaining share, `marker` is the even-pace cell. */
export interface BarLayout { width: number; filled: number; marker: number | null; known: boolean }
/** Lays out a bar of `width` cells; Unknown is entirely empty and never carries a marker.
 * Partial values never round to a completely empty or completely full bar. */
export function barLayout(width: number, remaining: number | null, pace: number | null): BarLayout {
  const cells = Math.max(1, Math.floor(Number.isFinite(width) ? width : 1));
  if (remaining === null || !Number.isFinite(remaining)) return { width: cells, filled: 0, marker: null, known: false };
  const share = Math.min(100, Math.max(0, remaining));
  let filled = Math.round(share / 100 * cells);
  if (share > 0 && filled < 1) filled = 1;
  if (share < 100 && filled >= cells && cells > 1) filled = cells - 1;
  const marker = pace === null || !Number.isFinite(pace) || cells < 3 ? null : Math.min(cells - 1, Math.max(0, Math.round(Math.min(100, Math.max(0, pace)) / 100 * cells)));
  return { width: cells, filled, marker, known: true };
}
/** Renders a bar as plain text, the marker replacing the cell it sits on. */
export function barText(bar: BarLayout): string {
  let out = '';
  for (let index = 0; index < bar.width; index++) out += index === bar.marker ? BAR_PACE : index < bar.filled ? BAR_FILLED : BAR_EMPTY;
  return out;
}
/** Renders a bar as toned spans: filled in `tone`, empty dim, marker emphasized. */
export function barSpans(bar: BarLayout, tone: Tone): Span[] {
  const spans: Span[] = [];
  const push = (text: string, spanTone: Tone, bold?: boolean) => {
    const last = spans[spans.length - 1];
    if (last && last.tone === spanTone && !!last.bold === !!bold) last.text += text; else spans.push({ text, tone: spanTone, ...bold ? { bold } : {} });
  };
  for (let index = 0; index < bar.width; index++) {
    if (index === bar.marker) push(BAR_PACE, 'text', true);
    else if (index < bar.filled) push(BAR_FILLED, bar.known ? tone : 'muted');
    else push(BAR_EMPTY, 'muted');
  }
  return spans;
}

/** Formats the share left without hiding small or nearly full values: 0%, <1%, 99%, 100%; Unknown otherwise. */
export function percentLeft(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'Unknown';
  if (value <= 0) return '0%';
  if (value < 1) return '<1%';
  if (value >= 100) return '100%';
  return `${Math.min(99, Math.round(value))}%`;
}

/** Position relative to an even burn: reserve (ahead), deficit (behind), even, or unknown. */
export interface PaceNote { kind: 'reserve' | 'deficit' | 'even' | 'unknown'; points: number; text: string }
/** Compares what is left with what an even burn would have left now. */
export function paceNote(remaining: number | null, pace: number | null): PaceNote {
  if (remaining === null || pace === null) return { kind: 'unknown', points: 0, text: 'pace unknown' };
  const delta = remaining - pace, points = Math.round(Math.abs(delta));
  if (points === 0) return { kind: 'even', points: 0, text: 'on pace' };
  return delta > 0 ? { kind: 'reserve', points, text: `${points}% in reserve` } : { kind: 'deficit', points, text: `${points}% in deficit` };
}

/** Projected exhaustion against the reset clock. */
export interface Exhaustion { kind: 'exhausted' | 'runs_out' | 'lasts' | 'none'; seconds: number | null; text: string }
/** Projects exhaustion from the measured burn: runs out before reset, lasts until reset, or nothing known. */
export function exhaustion(remaining: number | null, burn: number | null, resetAt: number | null, now: number): Exhaustion {
  if (remaining === null) return { kind: 'none', seconds: null, text: '' };
  if (remaining <= 0) return { kind: 'exhausted', seconds: 0, text: 'exhausted' };
  if (burn === null) return { kind: 'none', seconds: null, text: '' };
  const untilReset = resetAt !== null && resetAt > now ? resetAt - now : null;
  if (burn <= 0) return untilReset !== null ? { kind: 'lasts', seconds: null, text: 'lasts until reset' } : { kind: 'none', seconds: null, text: '' };
  const seconds = remaining / burn * 3600;
  if (untilReset !== null && seconds >= untilReset) return { kind: 'lasts', seconds, text: 'lasts until reset' };
  if (seconds > FAR_SECONDS) return { kind: 'none', seconds, text: '' };
  return { kind: 'runs_out', seconds, text: `runs out in ${span(seconds)}` };
}

/** Per-model row, shown only when a model's value differs from the window it is listed under. */
export interface ModelRowView { model: string; text: string; tone: Tone }
/** One provider window prepared for display. */
export interface WindowView {
  id: string; title: string; known: boolean; remaining: number | null; pace: number | null; stale: boolean;
  tone: Tone; leftText: string; resetText: string; sub: Span[]; models: string[]; divergent: ModelRowView[]; resetAt: number | null;
}
/** One account prepared for display. */
export interface AccountView {
  account: string; provider: string; sources: string[]; badge: Badge; badgeTone: Tone; updatedAt: number | null; stale: boolean;
  windows: WindowView[]; orphans: ModelRowView[]; warnings: { text: string; tone: Tone }[]; constraining: WindowView | null;
}

/** Tone severity used to pick the most constraining window. */
const SEVERITY: Record<Tone, number> = { error: 3, warn: 2, accent: 1, text: 1, good: 0, muted: -1 };

/** Colors a known window: red when it will run out or is exhausted, yellow at medium risk or behind pace, else green. */
function windowTone(remaining: number, risk: string, note: PaceNote, exhaust: Exhaustion): Tone {
  if (remaining <= 0 || risk === 'high' || exhaust.kind === 'runs_out' || exhaust.kind === 'exhausted') return 'error';
  if (note.kind === 'deficit' || risk === 'medium' || remaining < LOW_PERCENT) return 'warn';
  return 'good';
}
/** True when the model row repeats the window's own numbers. */
function sameAsWindow(model: QuotaModel, window: QuotaWindow, known: boolean): boolean {
  if (model.state === 'exhausted') return false;
  if (!known) return model.state === 'unknown' && model.remaining === null;
  return model.state === 'known' && model.remaining !== null && window.lastRemaining !== null && Math.abs(model.remaining - window.lastRemaining) <= 0.05;
}
/** Describes one model's own state for a divergent row. */
function modelRow(model: QuotaModel, now: number): ModelRowView {
  if (model.state === 'exhausted') return { model: model.model, text: `exhausted${model.exhaustedUntil !== null && model.exhaustedUntil > now ? ` · resets in ${span(model.exhaustedUntil - now)}` : ''}`, tone: 'error' };
  if (model.state === 'unknown' || model.remaining === null) return { model: model.model, text: 'Unknown', tone: 'muted' };
  const reset = model.resetAt !== null && model.resetAt > now ? ` · resets in ${span(model.resetAt - now)}` : '';
  return { model: model.model, text: `${percentLeft(model.remaining)} left${reset}`, tone: model.risk === 'high' ? 'error' : model.risk === 'medium' ? 'warn' : 'good' };
}
/** True when the model's limiting window is this window. */
function limitedBy(model: QuotaModel, window: QuotaWindow): boolean {
  return !!model.window && model.window.pool === window.pool && model.window.source === window.source && model.window.window === window.window;
}

/** Prepares one window; `models` are the account's models for divergence checks. */
function windowView(window: QuotaWindow, models: QuotaModel[], now: number): WindowView {
  const known = window.forecastKnown && window.lastRemaining !== null;
  const remaining = known ? window.lastRemaining : null, resetAt = known ? window.lastResetAt : null;
  const pace = known ? paceRemaining(window.window, resetAt, now) : null;
  const passed = known && resetAt !== null && resetAt <= now;
  const stale = known && (passed || window.validUntil !== null && window.validUntil <= now);
  const note = paceNote(remaining, pace), exhaust = exhaustion(remaining, window.burn, resetAt, now);
  const tone: Tone = known ? windowTone(remaining!, window.risk, note, exhaust) : 'muted';
  const resetText = !known ? 'no usable sample' : resetAt === null ? 'no reset clock' : passed ? `reset passed ${span(now - resetAt!)} ago` : `Resets in ${span(resetAt - now)}`;
  const sub: Span[] = [];
  if (!known) sub.push({ text: window.observedAt === null ? 'never sampled' : `last sample ${span(Math.max(0, now - window.observedAt))} ago`, tone: 'muted' });
  else {
    sub.push({ text: note.text, tone: note.kind === 'reserve' || note.kind === 'even' ? 'good' : note.kind === 'deficit' ? tone === 'error' ? 'error' : 'warn' : 'muted' });
    if (exhaust.text && exhaust.kind !== 'exhausted') sub.push({ text: ' · ', tone: 'muted' }, { text: exhaust.text, tone: exhaust.kind === 'runs_out' ? 'error' : 'good' });
    else if (exhaust.kind === 'exhausted') sub.push({ text: ' · ', tone: 'muted' }, { text: 'exhausted until reset', tone: 'error' });
    if (stale) sub.push({ text: ' · ', tone: 'muted' }, { text: 'sample is stale', tone: 'error' });
  }
  const divergent = models.filter(model => window.models.includes(model.model) && limitedBy(model, window) && !sameAsWindow(model, window, known)).map(model => modelRow(model, now));
  const names = new Set(divergent.map(row => row.model));
  return {
    id: `${window.pool}/${window.source}/${window.window}`, title: windowTitle(window.window, window.lane), known, remaining, pace, stale, tone,
    leftText: known ? `${percentLeft(remaining)} left` : 'Unknown', resetText, sub, resetAt,
    models: window.models.filter(name => !names.has(name)), divergent,
  };
}
/** Orders session windows before weekly ones and model-specific lanes last. */
function windowOrder(a: QuotaWindow, b: QuotaWindow): number {
  const model = (window: QuotaWindow) => window.lane.startsWith('model:') ? 1 : 0;
  return model(a) - model(b) || (windowSeconds(a.window) ?? Infinity) - (windowSeconds(b.window) ?? Infinity) || a.lane.localeCompare(b.lane) || a.source.localeCompare(b.source);
}
/** Unique, order-preserving values. */
function unique(values: string[]): string[] { return [...new Set(values)]; }

/** Human names for known providers; the account id stays available in details. */
const PROVIDER_NAMES: Record<string, string> = {
  claude: 'Claude subscription', codex: 'Codex (ChatGPT)', glm: 'Z.AI GLM', 'opencode-go': 'OpenCode Go',
  'opencode-zen': 'OpenCode Zen', 'codex-api': 'OpenAI API',
};
/** Readable account title: the provider's human name, else the raw account id. */
export function accountTitle(account: string, providers: string[]): string {
  const names = unique(providers.map(provider => PROVIDER_NAMES[provider]).filter((name): name is string => Boolean(name)));
  return names.length ? names.join(' + ') : account;
}

/** Prepares one account: its windows, badge, freshness and warnings. */
export function accountView(account: QuotaAccount, sources: QuotaSource[], now: number): AccountView {
  const own = sources.filter(source => source.account === account.account);
  const ordered = [...account.windows].sort(windowOrder);
  const windows = ordered.map(window => windowView(window, account.models, now));
  const titles = new Map<string, number>();
  for (const view of windows) titles.set(view.title, (titles.get(view.title) ?? 0) + 1);
  windows.forEach((view, index) => { if ((titles.get(view.title) ?? 0) > 1) view.title = `${view.title} · ${ordered[index]!.lane}`; });
  const claimed = new Set(ordered.flatMap(window => window.models));
  const orphans = account.models.filter(model => !claimed.has(model.model) && !ordered.some(window => limitedBy(model, window))).map(model => modelRow(model, now));
  const providers = unique(account.models.map(model => model.provider).filter(value => value !== 'Unknown'));
  if (!providers.length) providers.push(...unique(own.map(source => source.provider).filter(value => value !== 'Unknown')));
  const sourceNames = unique([...ordered.map(window => window.source), ...own.map(source => source.source)].filter(value => value !== 'Unknown'));
  const samples = [...ordered.map(window => window.observedAt), ...account.models.map(model => model.newestObservedAt)].filter((value): value is number => value !== null);
  const updatedAt = samples.length ? Math.max(...samples) : null;
  const stale = account.models.some(model => model.evidence !== 'fresh') || windows.some(view => view.stale);
  const knownWindows = windows.filter(view => view.known);
  const latches = account.latches.filter(latch => latch.active);
  const exhausted = latches.length > 0 || account.models.some(model => model.state === 'exhausted') || knownWindows.some(view => view.remaining! <= 0);
  const risky = knownWindows.some(view => view.tone === 'error' || view.tone === 'warn') || account.models.some(model => model.risk === 'high' || model.risk === 'medium');
  const anyKnown = knownWindows.length > 0 || account.models.some(model => model.state === 'known');
  const badge: Badge = exhausted ? 'EXHAUSTED' : risky ? 'AT RISK' : anyKnown ? 'OK' : 'UNKNOWN';
  const warnings: AccountView['warnings'] = [];
  for (const latch of latches) warnings.push({ text: `Latched: ${latch.window}${latch.models.length ? ` (${latch.models.join(', ')})` : ''} · ${latch.resetAt !== null && latch.resetAt > now ? `resets in ${span(latch.resetAt - now)}` : 'no reset clock'}`, tone: 'error' });
  for (const source of own) if (source.issues.length || source.status === 'failed') warnings.push({ text: `Source ${source.source} ${source.status}${source.issues.length ? `: ${source.issues.join(', ')}` : ''}`, tone: 'error' });
  for (const advice of unique(account.advice)) warnings.push({ text: advice, tone: 'warn' });
  const constraining = [...knownWindows].sort((a, b) => SEVERITY[b.tone] - SEVERITY[a.tone] || a.remaining! - b.remaining! || (a.resetAt ?? Infinity) - (b.resetAt ?? Infinity))[0] ?? null;
  return {
    account: account.account, provider: providers.length ? providers.join(', ') : 'Unknown', sources: sourceNames, badge,
    badgeTone: badge === 'OK' ? 'good' : badge === 'UNKNOWN' ? 'muted' : badge === 'AT RISK' ? 'warn' : 'error', updatedAt, stale, windows, orphans, warnings, constraining,
  };
}

/** Display width of a text. */
function cells(text: string): number { return stringWidth(text); }
/** Total display width of spans. */
export function spansWidth(spans: Span[]): number { return spans.reduce((total, item) => total + cells(item.text), 0); }
/** Clips text to `width` cells with an ellipsis. */
export function clipCells(text: string, width: number): string {
  if (width <= 0) return '';
  if (cells(text) <= width) return text;
  let out = '';
  for (const char of Array.from(text)) { if (cells(out + char) > width - 1) break; out += char; }
  return out + '…';
}
/** Clips a span list to `width` cells; the last visible span carries the ellipsis. */
export function fitSpans(spans: Span[], width: number): Span[] {
  if (spansWidth(spans) <= width) return spans;
  const out: Span[] = [];
  let used = 0;
  for (const item of spans) {
    const size = cells(item.text);
    if (used + size <= width) { out.push(item); used += size; continue; }
    const room = width - used;
    if (room > 0) out.push({ ...item, text: clipCells(item.text, room) });
    break;
  }
  return out;
}
/** Greedy word wrap by cells; text beyond `maxLines` is cut with an ellipsis. */
export function wrapCells(text: string, width: number, maxLines = 3): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = current ? `${current} ${word}` : word;
    if (cells(next) <= width) { current = next; continue; }
    if (current) lines.push(current);
    current = cells(word) > width ? clipCells(word, width) : word;
  }
  if (current) lines.push(current);
  if (lines.length > maxLines) { lines.length = maxLines; lines[maxLines - 1] = clipCells(`${lines[maxLines - 1]} …`, width); }
  return lines.length ? lines : [''];
}
/** Places `right` flush against the right edge of `width`; when both cannot fit it wraps onto a second row. */
export function leftRight(left: Span[], right: Span[], width: number): Span[][] {
  if (!right.length) return [fitSpans(left, width)];
  const rightWidth = spansWidth(right), leftWidth = spansWidth(left);
  const join = (head: Span[]) => [...head, { text: ' '.repeat(Math.max(1, width - spansWidth(head) - rightWidth)), tone: 'text' as Tone }, ...right];
  if (leftWidth + 2 + rightWidth <= width) return [join(left)];
  if (width - rightWidth - 2 >= 14) return [join(fitSpans(left, width - rightWidth - 2))];
  return [fitSpans(left, width), fitSpans(right, width)];
}

/** Indentation inside a card. */
const PAD = 2;
/** Maximum bar length for extremely wide terminals. */
const MAX_BAR = 240;

/** Builds the rows of one account card at `width` cells (including its padding). */
function accountRows(view: AccountView, width: number, now: number): Row[] {
  const pad = width >= 12 ? PAD : 0, inner = Math.max(1, width - pad * 2), rows: Row[] = [];
  const card = (spans: Span[]) => rows.push({ spans: [...pad ? [{ text: ' '.repeat(pad), tone: 'text' as Tone }] : [], ...fitSpans(spans, inner)], card: true });
  const blank = () => rows.push({ spans: [], card: true });
  const tidy = (list: Span[][]) => { for (const spans of list) card(spans); };
  const updated = view.updatedAt === null ? 'not observed yet' : `updated ${span(Math.max(0, now - view.updatedAt))} ago${view.stale ? ' · stale' : ''}`;
  blank();
  tidy(leftRight(
    [{ text: accountTitle(view.account, view.provider.split(', ')), tone: 'accent', bold: true }, { text: `  ${accountTitle(view.account, view.provider.split(', ')) === view.account ? view.provider : view.account}`, tone: 'muted' }],
    [{ text: updated, tone: view.stale ? 'error' : 'muted' }, { text: '  ', tone: 'text' }, { text: `[${view.badge}]`, tone: view.badgeTone, bold: true }], inner));
  if (!view.windows.length && !view.orphans.length) { blank(); card([{ text: 'No windows reported.', tone: 'muted' }]); }
  for (const window of view.windows) {
    blank();
    tidy(leftRight(
      [{ text: window.title, tone: 'text', bold: true }, { text: '  ', tone: 'text' }, { text: window.leftText, tone: window.tone, bold: true }],
      [{ text: window.resetText, tone: window.stale ? 'error' : 'muted' }], inner));
    card(barSpans(barLayout(Math.min(MAX_BAR, inner), window.remaining, window.pace), window.tone));
    card(window.sub);
    if (window.models.length) for (const [index, line] of wrapCells(`models: ${window.models.join(', ')}`, inner, 2).entries()) card([{ text: index ? `        ${line}`.trimEnd() : line, tone: 'muted' }]);
    for (const row of window.divergent) card([{ text: '  ↳ ', tone: 'muted' }, { text: row.model, tone: 'text' }, { text: `  ${row.text}`, tone: row.tone }]);
  }
  if (view.orphans.length) {
    blank();
    card([{ text: 'No window reported for:', tone: 'muted' }]);
    for (const row of view.orphans) card([{ text: '  ↳ ', tone: 'muted' }, { text: row.model, tone: 'text' }, { text: `  ${row.text}`, tone: row.tone }]);
  }
  const shown = view.warnings.slice(0, 2), hidden = view.warnings.length - shown.length;
  if (view.warnings.length) blank();
  for (const warning of shown) for (const [index, line] of wrapCells(warning.text, inner - 2, 3).entries()) card([{ text: index ? `  ${line}` : `! ${line}`, tone: warning.tone }]);
  if (hidden > 0) card([{ text: `  +${hidden} more · press d for technical details`, tone: 'muted' }]);
  blank();
  return rows;
}

/** Names one unobserved source entry (a JSON object string from the producer) as account/source, else as reported. */
export function unobservedLabel(entry: string): string {
  try {
    const value: unknown = JSON.parse(entry);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      const account = typeof record.account === 'string' ? record.account : null, source = typeof record.source === 'string' ? record.source : null;
      if (account) return source ? `${account}/${source}` : account;
    }
  } catch { /* not JSON: show as reported */ }
  return entry;
}
/** Builds the Quota tab body (without technical details) for a terminal of `width` cells. */
export function quotaRows(snapshot: QuotaSnapshot | null, now: number, width: number): Row[] {
  const plain = (text: string, tone: Tone): Row => ({ spans: fitSpans([{ text, tone }], width), card: false });
  if (!snapshot) return [plain('No Quota snapshot yet. Every value stays Unknown until the service answers.', 'muted')];
  const rows: Row[] = [plain(`${BAR_FILLED} left   ${BAR_EMPTY} used   ${BAR_PACE} where an even burn would be now`, 'muted')];
  if (snapshot.coverage.state !== 'complete' || snapshot.coverage.unobserved.length) {
    const missing = snapshot.coverage.unobserved.map(unobservedLabel);
    for (const line of wrapCells(`Coverage ${snapshot.coverage.state}${missing.length ? ` · not yet received: ${missing.join(', ')}` : ''}`, width, 2)) rows.push(plain(line, 'error'));
  }
  if (!snapshot.accounts.length) { rows.push(plain('', 'muted'), plain('No accounts reported by Quota.', 'muted')); return rows; }
  for (const account of snapshot.accounts) {
    rows.push(plain('', 'muted'));
    rows.push(...accountRows(accountView(account, snapshot.coverage.sources, now), width, now));
  }
  rows.push(plain('', 'muted'), plain('Read-only observations. Unknown means no usable sample, never zero; re-read before any decision.', 'muted'));
  return rows;
}

/** One Overview line: an account's most constraining window. */
export interface OverviewRow { account: string; badge: Badge; badgeTone: Tone; bar: BarLayout; tone: Tone; text: string; window: string | null }
/** Builds one Overview row per account. `barWidth` is the mini bar length in cells. */
export function overviewRows(snapshot: QuotaSnapshot | null, now: number, barWidth: number): OverviewRow[] {
  if (!snapshot) return [];
  return snapshot.accounts.map(account => {
    const view = accountView(account, snapshot.coverage.sources, now), window = view.constraining;
    if (!window) return { account: accountTitle(view.account, view.provider.split(', ')), badge: view.badge, badgeTone: view.badgeTone, bar: barLayout(barWidth, null, null), tone: 'muted' as Tone, text: 'Unknown', window: null };
    const reset = window.resetAt === null ? 'no reset clock' : window.resetAt <= now ? `reset passed ${span(now - window.resetAt)} ago` : `resets in ${span(window.resetAt - now)}`;
    return { account: accountTitle(view.account, view.provider.split(', ')), badge: view.badge, badgeTone: view.badgeTone, bar: barLayout(barWidth, window.remaining, window.pace), tone: window.tone, text: `${window.leftText} · ${reset}`, window: window.title };
  });
}
