/** Shared web presentation primitives for source evidence and navigable read views. */
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { createContext, useContext } from 'react';
import { LoaderCircle } from 'lucide-react';
import type { Coverage, Observation } from '@agent-hub/domain';
import { useLocale } from '../i18n';
import { ru } from '../locales';
import { Badge } from '../components/ui/badge';
import { english, translations } from './strings';
import type { Read } from './data';

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
  return <>{read.error && <p className="web-warning" role="status">{label(read.error)}{read.failedAt && read.value ? ' · ' + label('Retained since') + ' ' + clock(read.failedAt) : ''}</p>}
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

/** Original source clocks and outcomes remain separate on mixed-source pages. */
export function Sources({ items }: { items: Observation[] }) {
  const { label, clock } = useWebText();
  return <div className="web-sources">{items.map((item, i) => <details key={item.source + ':' + (item.resource ?? i)} className="web-source">
    <summary><strong>{label(item.source)}</strong><Badge variant="outline" className={item.outcome !== 'ok' || item.staleSinceMs != null ? 'web-caution' : ''}>{label(item.outcome)}{item.staleSinceMs != null && ' · ' + label('Stale')}</Badge></summary>
    <div>{label('Producer time')} {clock(item.producerAtMs)} · {label('Observed')} {clock(item.observedAtMs)}</div>
    {item.staleSinceMs != null && <div>{label('Retained since')} {clock(item.staleSinceMs)}</div>}
    <CoverageLine value={item.coverage} />
    {item.issue && <div>{item.issue.message ?? item.issue.code}</div>}
  </details>)}</div>;
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
