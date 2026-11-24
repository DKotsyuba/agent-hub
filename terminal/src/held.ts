/** One-line terminal summary of the held-message alarm; the terminal UI is English-only. */
import { heldDuration, type HeldAlarm } from '../../packages/view-model/src/index.ts';

/** Formats the red header line, e.g. "Messages to agents not delivered: 2, oldest waiting 6 h 2 min". */
export function heldSummary(alarm: HeldAlarm): string {
  const { hours, minutes } = heldDuration(alarm.oldestWaitMs);
  const wait = hours ? `${hours} h ${minutes} min` : `${minutes} min`;
  return `Messages to agents not delivered: ${alarm.complete ? '' : '≥'}${alarm.count}, oldest waiting ${wait}`;
}

/** Shortest form for narrow headers. */
export function heldShortSummary(alarm: HeldAlarm): string {
  const { hours, minutes } = heldDuration(alarm.oldestWaitMs);
  return `${alarm.complete ? '' : '≥'}${alarm.count} undelivered · ${hours ? `${hours} h ${minutes} min` : `${minutes} min`}`;
}
