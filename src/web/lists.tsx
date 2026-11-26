/** Read inventories with URL filters, stable related links and scoped pagination. */
import { useState } from 'react';
import type { ReactNode } from 'react';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Choice } from '../components/hub-primitives';
import { client, usePagedRead } from './data';
import { modelTitle, poolBadge, poolTitle, sessionTitle, worktreeMeasurements } from './model';
import { branchLabel, formatBytes } from '../../packages/view-model/src/index';
import { Next, period, Period } from './catalog';
import { EmptyRows, Expand, href, Link, ReadState, SessionFooter, SessionStatus, sessionHref, Sources, StatusBadge, useWebText } from './ui';
import type { Session } from '@agent-hub/domain';

export type Inventory = 'sessions' | 'pools' | 'worktrees';

/** Passes only the contract filters for the selected inventory. */
function filters(kind: Inventory, query: URLSearchParams) {
  const cursor = query.get('cursor');
  const q = query.get('q');
  const project = query.get('project');
  if (kind === 'sessions') return { ...period(query), status: query.get('status') ?? 'active', q, project, cursor };
  if (kind === 'pools') return { state: query.get('state') ?? 'live', q, cursor };
  return { project, cursor };
}

/** A row keeps its accessible name and focus identity stable on background refresh; status leads the name. */
export function Row({ id, target, selected, title, hint, status, children }: {
  id: string; target?: string; selected: boolean; title: string; hint?: string; status?: ReactNode; children?: ReactNode;
}) {
  const content = <>
    <div className="web-record-heading">{status && <span className="web-record-status">{status}</span>}<strong title={hint ?? title}>{title}</strong></div>
    <div className="web-record-copy">{children}</div>
  </>;
  return target
    ? <Link href={target} data-focus-key={id} aria-current={selected ? 'page' : undefined} className="web-record">{content}</Link>
    : <div className="web-record" data-focus-key={id}>{content}</div>;
}

/** List pane shows fetched counts as loaded counts, with independent source coverage. */
export function InventoryList({ kind, query, id, now, update }: {
  kind: Inventory; query: URLSearchParams; id: string | null; now: number; update: (values: Record<string, string | null>, keepCursor?: boolean) => void;
}) {
  const { label, n } = useWebText();
  const [technical, setTechnical] = useState(false);
  const { cursor, ...request } = filters(kind, query);
  const read = usePagedRead([kind, request], cursor, (cursor, signal) => client.get(kind, { query: { ...request, cursor }, signal }), kind);
  const keys = kind === 'sessions' ? ['active', 'finished', 'failed', 'all'] : ['live', 'finished', 'all'];
  const groupKey = kind === 'pools' ? 'state' : 'status';
  const selected = query.get(groupKey) ?? keys[0];
  const folder = query.get('folder') ?? '';
  const detailUrl = (row: string, execution?: string | null) => {
    const target = new URLSearchParams(query);
    target.delete('proposal'); target.delete('execution');
    if (execution) target.set('execution', execution);
    return '/' + kind + '/' + encodeURIComponent(row) + (target.size ? '?' + target : '');
  };
  return <>
    {kind !== 'worktrees' && <>
      <div className="web-list-filters" role="group" aria-label={label('Status')}>
        {(kind === 'pools' && (selected === 'open' || selected === 'closed') ? [...keys, selected] : keys).map(key => {
          const text = label(key === 'active' || key === 'live' ? 'Live' : key === 'finished' ? 'Finished' : key);
          return <Button size="sm" key={key} variant="ghost" aria-label={text} title={text} aria-pressed={selected === key}
            onClick={() => update({ [groupKey]: key })}>{key === 'finished' ? label('Finished short') : text}</Button>;
        })}
      </div>
      <label className="web-search">{label('Search')}<Input type="search" maxLength={200} value={query.get('q') ?? ''} onChange={event => update({ q: event.target.value })} /></label>
      {kind === 'sessions' && <>
        <Button variant="ghost" size="sm" aria-expanded={technical} onClick={() => setTechnical(value => !value)}>{label('Filters')}</Button>
        {technical && <>
          <Choice label={label('Status')} value={selected} options={[...new Set([...keys, 'created', 'starting', 'running', 'cancelling', 'succeeded', 'timed_out', 'cancelled', 'lost', selected])].map(key => [key, label(key)])}
            onChange={value => update({ status: value })} />
          <label className="web-search">{label('Project ID')}<Input value={query.get('project') ?? ''} onChange={event => update({ project: event.target.value })} /></label>
          <label className="web-search">{label('Working directory')}<Input value={folder} onChange={event => update({ folder: event.target.value })} /></label>
          <Period query={query} update={update} />
          <Button variant="ghost" onClick={() => update({ q: null, project: null, folder: null, from: null, to: null, status: null })}>{label('Reset filters')}</Button>
        </>}
      </>}
    </>}
    {cursor && <Button variant="ghost" onClick={() => update({ cursor: null }, true)}>{label('Beginning')}</Button>}
    <ReadState read={read}>{response => {
      const { data, observations, page } = response;
      const shown = data.items.filter(row => !('workdir' in row) || !folder || row.workdir === folder);
      return <>
        {'projects' in data && !!data.projects.length && <div className="web-projects">
          <Choice label={label('Project')} value={request.project ?? 'all'}
            options={[[ 'all', label('All projects')], ...data.projects.map(project => [project.id, project.name] as [string, string])]}
            onChange={value => update({ project: value === 'all' ? null : value })} />
        </div>}
        <p className="web-muted web-loaded">{label('Loaded')} {n(shown.length)}{shown.length !== data.items.length && ' / ' + n(data.items.length)}</p>
        <EmptyRows count={shown.length} observations={observations} />
        <div className="web-records">{shown.map(row => {
          if ('workdir' in row) return <SessionCard key={row.id + ':' + row.execution} row={row} now={now} target={detailUrl(row.id, row.execution)}
            selected={id === row.id && (!query.has('execution') || row.execution === query.get('execution'))} />;
          if ('purposePreview' in row) return <Row key={row.id} id={row.id} target={detailUrl(row.id)} selected={id === row.id} title={poolTitle(row) ?? label('Pool detail')} status={<StatusBadge state={poolBadge(row)} />}>
            <span>{row.kind && label(row.kind)}</span><span className="web-record-preview">{row.name && row.purposePreview}</span>
          </Row>;
          const project = 'projects' in data && !request.project ? data.projects.find(item => item.id === row.projectId)?.name : null;
          const measurements = worktreeMeasurements(row, label, bytes => formatBytes(bytes, n));
          return <Row key={row.id} id={row.id} target={detailUrl(row.id)} selected={id === row.id} title={[label(branchLabel(row, true)), project].filter(Boolean).join(' · ')} status={row.integration && <StatusBadge state={row.integration} />}>
            <span>{measurements.changes} · {measurements.size}</span><span>{label('worktree-class:' + row.class)} · {label(row.activity ?? 'Unknown')}</span>
          </Row>;
        })}</div>
        <Next cursor={page.next} update={cursor => update({ cursor }, true)} />
        {'totals' in data && data.totals && <Expand title="Snapshot totals"><p className="web-muted">{label('Retained')} {data.totals.retained} · {label('Live')} {data.totals.live ?? '—'} · {label('closed')} {data.totals.closed} · {label('Completed')} {data.totals.completed ?? '—'} · {label('Unknown')} {data.totals.unknown}</p></Expand>}
        <Sources items={observations} topic={kind} title="Inventory" />
      </>;
    }}</ReadState>
  </>;
}

/** Parent address keeps inventory filters while stripping detail-specific query values. */
export function inventoryHref(kind: Inventory, query: URLSearchParams) {
  return href('/' + kind, { ...filters(kind, query), ...(kind === 'sessions' ? { folder: query.get('folder') } : {}) });
}

/** One session row exactly as the Sessions list shows it; pool members reuse it for their Run agent. */
export function SessionCard({ row, now, selected = false, target }: { row: Session; now: number; selected?: boolean; target?: string }) {
  const { label } = useWebText();
  return <Row id={row.id + ':' + row.execution} target={target ?? sessionHref(row.id, row.execution)} selected={selected}
    title={sessionTitle(row) ?? label('Session detail')} hint={row.id} status={<SessionStatus row={row} now={now} />}>
    <span>{[row.model && modelTitle(row.model), row.workdir?.split('/').filter(Boolean).at(-1)].filter(Boolean).join(' · ')}</span>
    <span className="web-record-preview">{row.lastAction ?? (row.name ? row.summary : null)}</span>{row.failureKind && <span className="error-text">{row.failureKind}{row.failureText && ' · ' + row.failureText}</span>}
    <SessionFooter row={row} now={now} />
  </Row>;
}
