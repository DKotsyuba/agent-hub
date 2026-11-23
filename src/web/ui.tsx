/** Shared web presentation primitives for source evidence and navigable read views. */
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { createContext, useContext, useId, useState } from 'react';
import { ChevronDown, LoaderCircle } from 'lucide-react';
import type { Coverage, Observation, Topic } from '@agent-hub/domain';
import { useLocale } from '../i18n';
import { ru } from '../locales';
import { Badge } from '../components/ui/badge';
import { english, translations } from './strings';
import { LiveContext, type Read } from './data';

/** Localizes authored v1 chrome and typed tokens; callers render producer prose directly. */
export function useWebText() {
  const tools = useLocale();
  const label = (text: string) => {
    const catalog = tools.locale === 'ru' ? translations : english;
    if (Object.hasOwn(catalog, text)) return catalog[text];
    return tools.locale === 'ru' && Object.hasOwn(ru, text) ? ru[text as keyof typeof ru] : text;
  };
  return { ...tools, label,
    clock: (ms: number | null | undefined) => ms == null ? '—' : new Date(ms).toLocaleString(tools.tag, { dateStyle: 'medium', timeStyle: 'short' }) };
}

/** Link navigation stays native for modified clicks and new tabs. */
export const Navigation = createContext<(href: string, replace?: boolean, focus?: boolean) => void>(() => {});

/** Same-origin route links participate in local history and focus restoration. */
export function Link({ href, onClick, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const go = useContext(Navigation);
  return <a href={href} {...props} onClick={event => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    event.preventDefault();
    if (event.currentTarget.dataset.focusKey) event.currentTarget.focus({ preventScroll: true });
    go(href);
  }}>{children}</a>;
}

/** Builds a shareable route from current filters or filters supplied by a related source. */
export function href(path: string, query: Record<string, string | number | null | undefined> = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value != null && value !== '') params.set(key, String(value));
  return path + (params.size ? '?' + params : '');
}

/** Retains stable Run ID and opaque execution selection in related links. */
export function sessionHref(id: string, execution?: string | null) {
  return href('/sessions/' + encodeURIComponent(id), { execution });
}

/** Read failure and loading are independent from retained content. */
export function ReadState<T>({ read, children }: { read: Read<T>; children: (value: T) => ReactNode }) {
  const { label, clock } = useWebText();
  const { unreachable } = useContext(LiveContext);
  const error = unreachable && read.error === 'network_unavailable' && read.value === null ? null : read.error;
  return <>{error && <p className="web-warning" role="status">{label(error)}{read.failedAt && read.value ? ' · ' + label('Retained since') + ' ' + clock(read.failedAt) : ''}</p>}
    {read.value !== null ? children(read.value) : read.loading && <p className="web-muted" role="status"><LoaderCircle className="web-spin" size={16} /> {label('Loading')}</p>}</>;
}

/** Empty is an observed value rather than an unavailable or unsupported state. */
export function EmptyRows({ count, observations }: { count: number; observations?: Observation[] }) {
  const { label } = useWebText();
  if (count || observations?.some(item => item.outcome !== 'ok')) return null;
  return <p className="web-empty">{label('No records')}</p>;
}

/** Scoped coverage is kept visible wherever a count or retained boundary is shown. */
export function CoverageLine({ value }: { value?: Coverage }) {
  const { label, clock } = useWebText();
  if (!value) return null;
  return <span className="web-muted">{label(value.scope)} · {label(value.state)}
    {value.consistency && ' · ' + label(value.consistency)}
    {value.scanned !== undefined && ' · ' + label('Scanned') + ' ' + value.scanned}
    {value.reportedTotal != null && ' / ' + value.reportedTotal}
    {(value.fromMs != null || value.toMs != null) && ' · ' + clock(value.fromMs) + ' → ' + clock(value.toMs)}
    {value.reason && ' · ' + value.reason}</span>;
}

/** Uses the shared visual tones for session, source and quota states. */
export function StatusBadge({ state }: { state: string }) {
  const { label } = useWebText();
  const tone = ['ok', 'succeeded', 'ready'].includes(state) ? 'good'
    : ['running', 'starting', 'open'].includes(state) ? 'active'
    : ['failed', 'timed_out', 'exhausted', 'invalid', 'high', 'critical'].includes(state) ? 'error'
    : ['partial', 'unavailable', 'incompatible', 'missing', 'Stale', 'medium'].includes(state) ? 'warning' : 'neutral';
  return <Badge variant="outline" className="web-status" data-tone={tone}>{label(state)}</Badge>;
}

/** Chooses one source badge from its independent resource observations. */
function sourceState(group: Observation[]) {
  const unavailable = group.find(item => !['ok', 'partial'].includes(item.outcome));
  if (unavailable) return group.some(item => ['ok', 'partial'].includes(item.outcome)) ? 'partial' : unavailable.outcome;
  if (group.some(item => item.staleSinceMs != null)) return 'Stale';
  return group.some(item => item.outcome === 'partial') ? 'partial' : 'ok';
}

/** Keeps each resource's original timestamps and coverage inside its source disclosure. */
export function SourceEvidence({ items }: { items: Observation[] }) {
  const { label, clock } = useWebText();
  return <ul className="web-source-evidence">{items.map((item, i) => <li key={i}>
    {item.resource && <strong>{label(item.resource)} · </strong>}<StatusBadge state={item.outcome} />
    <div>{label('Producer time')} {clock(item.producerAtMs)} · {label('Observed')} {clock(item.observedAtMs)}</div>
    {item.staleSinceMs != null && <div>{label('Retained since')} {clock(item.staleSinceMs)}</div>}
    <CoverageLine value={item.coverage} />
    {item.issue && <div>{item.issue.message ?? item.issue.code}</div>}
  </li>)}</ul>;
}

/** Labels finite receipts and live updates by the route topic that produced them. */
export type EvidenceScope = { title?: string; topic?: Topic; items: Observation[] };

/** Merges scoped live outcomes with finite receipts, keeping the newest per resource. */
export function useEvidence(scopes: EvidenceScope[]) {
  const { visible, sourceEvents } = useContext(LiveContext);
  return scopes.map(scope => {
    const items = [...scope.items];
    for (const item of visible && scope.topic ? sourceEvents?.get(scope.topic) ?? [] : []) {
      const index = items.findIndex(other => other.source === item.source && other.resource === item.resource);
      if (index < 0) items.push(item);
      else if (item.observedAtMs >= items[index].observedAtMs) {
        items[index] = { ...item, coverage: item.coverage ?? items[index].coverage };
      }
    }
    return { ...scope, items };
  });
}

/** Displays one entry per source, with scope labels inside its evidence. */
export function Sources({ items, topic, title, additional = [], strip = false, bridgeLink }: {
  items: Observation[]; topic?: Topic; title?: string; additional?: EvidenceScope[]; strip?: boolean; bridgeLink?: ReactNode;
}) {
  const { label } = useWebText();
  const id = useId();
  const [selected, setSelected] = useState<Observation['source'] | null>(null);
  const scopes = useEvidence([{ items, topic, title }, ...additional]);
  const groups = new Map<Observation['source'], Observation[]>();
  for (const item of scopes.flatMap(scope => scope.items)) {
    const group = groups.get(item.source) ?? [];
    group.push(item);
    groups.set(item.source, group);
  }
  if (!groups.size) return null;
  const active = selected && groups.get(selected);
  const evidence = (source: Observation['source']) => scopes.map((scope, index) => {
    const scoped = scope.items.filter(item => item.source === source);
    return scoped.length > 0 && <div key={index}>
      {scope.title && <h3 className="web-evidence-title">{label(scope.title)}</h3>}
      <SourceEvidence items={scoped} />
    </div>;
  });
  return <section className={strip ? 'web-sources web-source-strip' : 'web-sources'} aria-label={label('Source health')}>
    {strip && <h2>{label('Source health')}</h2>}
    <div className="web-source-items">{[...groups].map(([source, group]) => strip
      ? <button type="button" key={source} className="web-source-control" aria-expanded={selected === source} aria-controls={id}
          onClick={() => setSelected(selected === source ? null : source)}>
          <strong>{label(source)} <ChevronDown size={14} aria-hidden="true" /></strong><StatusBadge state={sourceState(group)} />
        </button>
      : <details key={source} className="web-source">
          <summary><strong>{label(source)}</strong>{additional.length > 0 && <span className="web-source-scope">{label('Scoped source evidence')}</span>}
            <StatusBadge state={sourceState(group)} /></summary>
          {evidence(source)}
        </details>)}</div>
    {strip && <div id={id} className="web-source-panel" hidden={!active}>
      {active && evidence(selected)}
      {selected === 'bridge' && bridgeLink}
    </div>}
  </section>;
}

/** Formats a timestamp against a shared page clock in minutes, hours, or days. */
export function relativeTime(ms: number, now: number, locale: string) {
  const minutes = Math.round((ms - now) / 60_000);
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute');
  if (Math.abs(minutes) < 1440) return formatter.format(Math.round(minutes / 60), 'hour');
  return formatter.format(Math.round(minutes / 1440), 'day');
}

/** Metadata list renders nullable values explicitly. */
export function Facts({ rows }: { rows: [string, ReactNode][] }) {
  const { label } = useWebText();
  return <dl className="web-facts">{rows.map(([name, value], i) => <div key={name + i}><dt>{label(name)}</dt><dd>{typeof value === 'boolean' ? label(value ? 'Yes' : 'No') : value ?? '—'}</dd></div>)}</dl>;
}

/** Expandable section preserves accessible native interaction on keyboard and touch. */
export function Expand({ title, children }: { title: string; children: ReactNode }) {
  const { label } = useWebText();
  return <details className="web-expand"><summary>{label(title)}</summary>{children}</details>;
}

/** Readable text preserving line breaks and wrapping long producer content. */
export function Text({ children }: { children: ReactNode }) {
  return <div className="web-text">{children}</div>;
}
