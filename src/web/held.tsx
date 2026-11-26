/** Red alarm for Bridge messages accepted into custody but still undelivered after the threshold. */
import { createContext } from 'react';
import { TriangleAlert } from 'lucide-react';
import { heldDuration, type HeldAlarm, type HeldLine } from '../../packages/view-model/src/index';
import { href, Link, useWebText } from './ui';

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
  if (!alarm) return stale > 0 ? <p className="web-held-stale-only web-muted" role="status"><StaleHeld count={stale} link /></p> : null;
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
  </section>;
}
