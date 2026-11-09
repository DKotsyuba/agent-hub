/** Shared content primitives used by fixture and live projections with identical navigation semantics. */
import type { MouseEvent, ReactNode } from 'react';
import { Search } from 'lucide-react';
import { Button } from './ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { useLocale } from '../i18n';

/** Localized accessible selector; stable values never depend on displayed language. */
export function Choice({ label, value, options, onChange }: { label: string; value: string; options: [string, string][]; onChange: (value: string) => void }) {
  return <Select value={value} onValueChange={onChange}><SelectTrigger className="choice-trigger" aria-label={label} title={value.startsWith('/') ? value : undefined}><SelectValue /></SelectTrigger><SelectContent aria-label={label}>{options.map(([key, text]) => <SelectItem key={key} value={key} title={key.startsWith('/') ? key : undefined}>{text}</SelectItem>)}</SelectContent></Select>;
}
/** Section surface with a contextual read/navigation action. */
export function Panel({ title, extra, children, className = '' }: { title: string; extra?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={'panel ' + className}><header className="panel-heading"><h2>{title}</h2>{extra}</header>{children}</section>;
}
/** Semantic metadata pair; paths and source text never become filesystem operations. */
export function Field({ label, children }: { label: string; children: ReactNode }) { return <div className="field"><dt>{label}</dt><dd>{children}</dd></div>; }
/** Explicit no-match recovery, distinct from disconnected source state. */
export function Empty({ title, text, onReset }: { title: string; text: string; onReset: () => void }) {
  const { t } = useLocale();
  return <div className="empty-state"><Search size={28} aria-hidden="true" /><h2>{title}</h2><p>{text}</p><Button variant="outline" onClick={onReset}>{t('Reset filters')}</Button></div>;
}
/** One row-wide pointer activation; the semantic button retains native keyboard behavior. */
export function activateRecordRow(event: MouseEvent<HTMLTableRowElement>, open: () => void): void {
  if ((event.target as Element).closest('button,a,input,select,textarea') || window.getSelection()?.isCollapsed === false) return;
  event.currentTarget.querySelector<HTMLButtonElement>('button')?.focus(); open();
}
