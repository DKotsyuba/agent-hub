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

/** Destructive banner on every page: count, oldest wait, up to three messages and the Bridge incidents link. */
export function HeldAlert({ alarm }: { alarm: HeldAlarm | null }) {
  const { label, n } = useWebText();
  const time = useHeldTime();
  const reason = useReason();
  if (!alarm) return null;
  const more = alarm.count - alarm.lines.length;
  return <section className="web-held-alert" role="alert" aria-label={label('Held alarm')}>
    <TriangleAlert size={20} aria-hidden="true" />
    <div className="web-held-body">
      <strong>{label('Held title').replace('{count}', (alarm.complete ? '' : '≥ ') + n(alarm.count)).replace('{time}', time(alarm.oldestWaitMs))}</strong>
      <ul>
        {alarm.lines.map((line, index) => <li key={index}>
          <span className="web-held-recipient" title={line.recipient ?? undefined}>{line.recipient ?? label('Held recipient unknown')}</span>
          <span>{reason(line)}</span>
          <span>{time(line.waitMs)}{line.attempts !== null && ' · ' + label('Held attempts').replace('{count}', n(line.attempts))}</span>
        </li>)}
      </ul>
      {more > 0 && <span className="web-held-more">{label('Held more').replace('{count}', n(more))}</span>}
      {!alarm.complete && <span className="web-held-more">{label('Held partial')}</span>}
      <Link className="web-held-link" href={href('/incidents')}>{label('Bridge incidents')}</Link>
    </div>
  </section>;
}
