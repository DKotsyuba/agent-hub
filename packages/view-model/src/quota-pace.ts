/** Shared quota pace and exhaustion rules. Timestamps and durations use seconds. */
import { quotaWindowSample, span, windowSeconds, type QuotaWindow, type Tone } from './quota.ts';

/** A window is considered inconsistent when its reset is further away than the window length by this factor. */
const PACE_TOLERANCE = 1.02;
/** Exhaustion further away than this is not announced; the burn is effectively idle. */
const FAR_SECONDS = 365 * 86400;
/** Below this many percent left a known window is highlighted even when pace is fine. */
const LOW_PERCENT = 10;

/** Expected remaining percentage at an even burn rate: the window start is the reset minus its length.
 * Null when the length or the reset clock is unknown, the reset has passed, or the clock is inconsistent. */
export function paceRemaining(window: string, resetAt: number | null, now: number): number | null {
  const length = windowSeconds(window);
  if (length === null || resetAt === null) return null;
  const left = resetAt - now;
  if (left <= 0 || left > length * PACE_TOLERANCE) return null;
  return Math.min(100, Math.max(0, left / length * 100));
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

/** Colors a known window: red when it will run out or is exhausted, yellow at medium risk or behind pace, else green. */
function windowTone(remaining: number, risk: string, note: PaceNote, exhaust: Exhaustion): Tone {
  if (remaining <= 0 || risk === 'high' || exhaust.kind === 'runs_out' || exhaust.kind === 'exhausted') return 'error';
  if (note.kind === 'deficit' || risk === 'medium' || remaining < LOW_PERCENT) return 'warn';
  return 'good';
}
/** Projects a window using the shared sample, even-pace comparison and measured burn. */
export function quotaWindowForecast(window: QuotaWindow, now: number) {
  const sample = quotaWindowSample(window, now);
  const pace = sample.known ? paceRemaining(window.window, sample.resetAt, now) : null;
  const note = paceNote(sample.remaining, pace);
  const exhaust = exhaustion(sample.remaining, window.burn, sample.resetAt, now);
  const tone = sample.remaining === null ? 'muted' : windowTone(sample.remaining, window.risk, note, exhaust);
  return { ...sample, pace, note, exhaust, tone };
}
