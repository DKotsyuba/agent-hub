/** Framework-free held-message alarm shared by the web and terminal clients. */

/** Messages accepted by Bridge are alarming once they wait strictly longer than this. */
export const HELD_THRESHOLD_MS = 10 * 60_000;

/** Messages undelivered for longer than this are stale: shown as a muted line, never as the alarm. */
export const HELD_STALE_MS = 7 * 24 * 3_600_000;

/** Number of message lines an alarm lists. */
export const HELD_LINES = 3;

/** The fields of an undelivered Bridge message the alarm reads. */
export interface HeldInput {
  acceptedAtMs: number;
  holdReason?: string | null;
  recipient?: string | null;
  attempts?: number | null;
  state?: string | null;
}

/** Well-known hold reasons get plain wording in the UI; anything else is shown verbatim. */
export type HeldReasonKind = 'target_unavailable' | 'socket_continuity' | 'other' | 'unknown';

/** A displayed message line. */
export interface HeldLine {
  recipient: string | null;
  reasonKind: HeldReasonKind;
  /** The producer's own reason text (or delivery state when no reason is reported). */
  reasonText: string | null;
  waitMs: number;
  attempts: number | null;
}

/** What the producer reports besides the scanned rows. */
export interface HeldScope {
  /** Bridge overview total of undelivered messages; absent or null from an older Bridge. */
  pending?: number | null;
  /** Accepted clock of the oldest scanned row; every message missing from the rows is at least that old. */
  oldestScannedAtMs?: number | null;
}

/** An active alarm; null from heldAlarm means there is nothing to show. */
export interface HeldAlarm {
  count: number;
  /** Longest wait among the rows actually seen; when `partial` it is a lower bound of the true oldest wait. */
  oldestWaitMs: number;
  /** Oldest first, at most HELD_LINES. */
  lines: HeldLine[];
  /** False when the count itself is a lower bound: no producer total and the row scan was bounded. */
  complete: boolean;
  /** True when counted messages are missing from the rows, so the list and oldest wait are a subset. */
  partial: boolean;
  /** Messages older than seven days that are not part of the alarm. */
  stale: number;
}

/** The alarm plus the muted stale-message count; stale messages can exist without an alarm. */
export interface HeldState {
  alarm: HeldAlarm | null;
  stale: number;
}

/** Classifies a producer hold reason by its normalized words. */
export function heldReasonKind(reason: string | null | undefined): HeldReasonKind {
  const text = reason?.trim().toLowerCase().replace(/[\s_-]+/g, ' ');
  if (!text) return 'unknown';
  if (text.includes('target unavailable')) return 'target_unavailable';
  if (text.includes('socket continuity')) return 'socket_continuity';
  return 'other';
}

/** Shortens a long address to its head and tail so it fits a phone-width line. */
export function shortRecipient(recipient: string | null | undefined, max = 36): string | null {
  const text = recipient?.trim();
  if (!text) return null;
  if (text.length <= max) return text;
  const tail = Math.floor((max - 1) / 3), head = max - 1 - tail;
  return text.slice(0, head) + '…' + text.slice(-tail);
}

/**
 * Classifies undelivered messages at `now`. Rows without a plausible accepted clock (not finite, or later than now) are
 * ignored rather than guessed. A message alarms once it waits strictly longer than `thresholdMs`; one older than `staleMs`
 * is counted as stale instead. When the producer reports its total (`scope.pending`), messages missing from `items` are
 * still counted: they are older than the oldest scanned row, so they are stale when that row is, alarming when it is past
 * the threshold, and alarming when its age is unknown. Without a total only the rows are counted.
 */
export function heldState(items: readonly HeldInput[] | null | undefined, now: number, complete = true, thresholdMs = HELD_THRESHOLD_MS, scope: HeldScope = {}, staleMs = HELD_STALE_MS): HeldState {
  const rows = items ?? [];
  const age = (item: HeldInput) => Number.isFinite(item.acceptedAtMs) && item.acceptedAtMs <= now ? now - item.acceptedAtMs : null;
  const stale = rows.filter(item => (age(item) ?? 0) > staleMs).length;
  const overdue = rows.filter(item => { const wait = age(item); return wait !== null && wait > thresholdMs && wait <= staleMs; })
    .sort((a, b) => a.acceptedAtMs - b.acceptedAtMs);
  const total = typeof scope.pending === 'number' && Number.isFinite(scope.pending) ? scope.pending : null;
  const unseen = total === null ? 0 : Math.max(0, total - rows.length);
  const floor = typeof scope.oldestScannedAtMs === 'number' && Number.isFinite(scope.oldestScannedAtMs) && scope.oldestScannedAtMs <= now ? now - scope.oldestScannedAtMs : null;
  const unseenStale = unseen > 0 && floor !== null && floor > staleMs ? unseen : 0;
  const unseenOverdue = unseen > 0 && !unseenStale && (floor === null || floor > thresholdMs) ? unseen : 0;
  const count = overdue.length + unseenOverdue;
  const staleCount = stale + unseenStale;
  if (!count) return { alarm: null, stale: staleCount };
  const partial = unseenOverdue > 0 || total === null && !complete;
  return {
    stale: staleCount,
    alarm: {
      count, complete: total !== null || complete, partial, stale: staleCount,
      oldestWaitMs: overdue.length ? now - overdue[0].acceptedAtMs : floor ?? thresholdMs,
      lines: overdue.slice(0, HELD_LINES).map(item => {
        const reason = item.holdReason?.trim() || null;
        return {
          recipient: shortRecipient(item.recipient), reasonKind: heldReasonKind(reason),
          reasonText: reason ?? item.state?.trim() ?? null, waitMs: now - item.acceptedAtMs, attempts: item.attempts ?? null,
        };
      }),
    },
  };
}

/** The alarm half of `heldState`; null means there is nothing to alarm on. */
export function heldAlarm(items: readonly HeldInput[] | null | undefined, now: number, complete = true, thresholdMs = HELD_THRESHOLD_MS, scope: HeldScope = {}): HeldAlarm | null {
  return heldState(items, now, complete, thresholdMs, scope).alarm;
}

/** Splits a wait into whole hours and the remaining whole minutes, never below one minute. */
export function heldDuration(ms: number): { hours: number; minutes: number } {
  const total = Math.max(1, Math.floor(ms / 60_000));
  return { hours: Math.floor(total / 60), minutes: total % 60 };
}
