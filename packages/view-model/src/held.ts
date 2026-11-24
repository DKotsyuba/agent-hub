/** Framework-free held-message alarm shared by the web and terminal clients. */

/** Messages accepted by Bridge are alarming once they wait strictly longer than this. */
export const HELD_THRESHOLD_MS = 10 * 60_000;

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

/** An active alarm; null from heldAlarm means there is nothing to show. */
export interface HeldAlarm {
  count: number;
  oldestWaitMs: number;
  /** Oldest first, at most HELD_LINES. */
  lines: HeldLine[];
  /** False when the producer scan was bounded, so the true count may be higher. */
  complete: boolean;
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
 * Selects messages held strictly longer than the threshold at `now`. Rows without a plausible accepted clock
 * (not finite, or later than now) are ignored rather than guessed. Absent or empty input yields null.
 */
export function heldAlarm(items: readonly HeldInput[] | null | undefined, now: number, complete = true, thresholdMs = HELD_THRESHOLD_MS): HeldAlarm | null {
  if (!items?.length) return null;
  const overdue = items
    .filter(item => Number.isFinite(item.acceptedAtMs) && item.acceptedAtMs <= now && now - item.acceptedAtMs > thresholdMs)
    .sort((a, b) => a.acceptedAtMs - b.acceptedAtMs);
  if (!overdue.length) return null;
  return {
    count: overdue.length,
    oldestWaitMs: now - overdue[0].acceptedAtMs,
    complete,
    lines: overdue.slice(0, HELD_LINES).map(item => {
      const reason = item.holdReason?.trim() || null;
      return {
        recipient: shortRecipient(item.recipient), reasonKind: heldReasonKind(reason),
        reasonText: reason ?? item.state?.trim() ?? null, waitMs: now - item.acceptedAtMs, attempts: item.attempts ?? null,
      };
    }),
  };
}

/** Splits a wait into whole hours and the remaining whole minutes, never below one minute. */
export function heldDuration(ms: number): { hours: number; minutes: number } {
  const total = Math.max(1, Math.floor(ms / 60_000));
  return { hours: Math.floor(total / 60), minutes: total % 60 };
}
