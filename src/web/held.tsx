/** Red alarm for Bridge messages accepted into custody but still undelivered after the threshold. */
import { createContext, useEffect, useState } from 'react';
import { TriangleAlert, X } from 'lucide-react';
import { heldDuration, type HeldAlarm, type HeldLine } from '../../packages/view-model/src/index';
import { href, Link, useWebText } from './ui';

/** Where a dismissal is remembered per browser, and how long it lasts. */
const DISMISS_KEY = 'agent-hub.held-dismissed', DISMISS_MS = 60 * 60 * 1000;

/** Reads the remembered dismissal; malformed or unavailable storage counts as none. */
function readDismissal(): { count: number; at: number } | null {
  try {
    const value = JSON.parse(localStorage.getItem(DISMISS_KEY) ?? 'null') as { count?: unknown; at?: unknown } | null;
    return value && typeof value.count === 'number' && typeof value.at === 'number' ? { count: value.count, at: value.at } : null;
  } catch { return null; }
}

/** Active alarm shared with the Overview Bridge card; null while nothing is held past the threshold. */
export const HeldContext = createContext<HeldAlarm | null>(null);

/** Formats a wait as "X ч Y мин" (hours omitted below one hour). */
export function useHeldTime() {
  const { label, n } = useWebText();
  return (ms: number) => {
    const { hours, minutes } = heldDuration(ms);
    return label(hours ? 'Held wait hours' : 'Held wait minutes').replace('{hours}', n(hours)).replace('{minutes}', n(minutes));
  };
}

/** Plain-language hold reason; unrecognized producer wording is shown verbatim. */
function useReason() {
  const { label } = useWebText();
  return (line: HeldLine) => line.reasonKind === 'target_unavailable' || line.reasonKind === 'socket_continuity'
    ? label('Held reason ' + line.reasonKind) : line.reasonText ?? label('Held reason unknown');
}

/** Muted line (optionally linking to Bridge incidents) for messages undelivered longer than seven days; they never raise the alarm. */
function StaleHeld({ count, link = false }: { count: number; link?: boolean }) {
  const { label, n } = useWebText();
  return <span className="web-held-stale">{label('Held stale').replace('{count}', n(count))}
    {link && <>{' · '}<Link href={href('/incidents')}>{label('Bridge incidents')}</Link></>}</span>;
}

/**
 * Destructive banner on every page: count, oldest wait, up to three messages and the Bridge incidents link. Stale messages
 * add a muted line, and alone they show only that muted line.
 */
export function HeldAlert({ alarm, stale = 0 }: { alarm: HeldAlarm | null; stale?: number }) {
  const { label, n } = useWebText();
  const time = useHeldTime();
  const reason = useReason();
  const [dismissed, setDismissed] = useState(readDismissal);
  // A dismissal lasts an hour and ends early once more messages are held than when it was given.
  useEffect(() => { if (dismissed && alarm && alarm.count > dismissed.count) setDismissed(null); }, [alarm, dismissed]);
  if (!alarm) return stale > 0 ? <p className="web-held-stale-only web-muted" role="status"><StaleHeld count={stale} link /></p> : null;
  if (dismissed && Date.now() - dismissed.at < DISMISS_MS && alarm.count <= dismissed.count) return null;
  const dismiss = () => {
    const next = { count: alarm.count, at: Date.now() };
    try { localStorage.setItem(DISMISS_KEY, JSON.stringify(next)); } catch { /* storage unavailable: dismiss for this view only */ }
    setDismissed(next);
  };
  const more = alarm.count - alarm.lines.length;
  return <section className="web-held-alert" role="alert" aria-label={label('Held alarm')}>
    <TriangleAlert size={20} aria-hidden="true" />
    <div className="web-held-body">
      <strong>{label('Held title').replace('{count}', (alarm.complete ? '' : '≥ ') + n(alarm.count)).replace('{time}', (alarm.partial ? '≥ ' : '') + time(alarm.oldestWaitMs))}</strong>
      <ul>
        {alarm.lines.map((line, index) => <li key={index}>
          <span className="web-held-recipient" title={line.recipient ?? undefined}>{line.recipient ?? label('Held recipient unknown')}</span>
          <span>{reason(line)}</span>
          <span>{time(line.waitMs)}{line.attempts !== null && ' · ' + label('Held attempts').replace('{count}', n(line.attempts))}</span>
        </li>)}
      </ul>
      {more > 0 && <span className="web-held-more">{label('Held more').replace('{count}', n(more))}</span>}
      {(alarm.partial || !alarm.complete) && <span className="web-held-more">{label('Held partial')}</span>}
      {stale > 0 && <StaleHeld count={stale} />}
      <Link className="web-held-link" href={href('/incidents')}>{label('Bridge incidents')}</Link>
    </div>
    <button type="button" className="web-held-dismiss" onClick={dismiss} aria-label={label('Held dismiss')} title={label('Held dismiss')}>
      <X size={18} aria-hidden="true" />
    </button>
  </section>;
}
