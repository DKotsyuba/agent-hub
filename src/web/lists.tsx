/** Read inventories with URL filters, stable related links and scoped pagination. */
import { useState } from 'react';
import type { ReactNode } from 'react';
import { LoaderCircle } from 'lucide-react';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Choice } from '../components/hub-primitives';
import { client, useRead } from './data';
import { branchLabel, formatBytes, worktreeMeasurements } from './model';
import { Next, period, Period } from './catalog';
import { EmptyRows, href, Link, ReadState, Sources, CoverageLine, useWebText } from './ui';

export type Inventory = 'sessions' | 'pools' | 'worktrees';

/** Passes only the contract filters for the selected inventory. */
function filters(kind: Inventory, query: URLSearchParams) {
  const cursor = query.get('cursor');
  const q = query.get('q');
  const project = query.get('project');
  if (kind === 'sessions') return { ...period(query), status: query.get('status') ?? 'active', q, project, cursor };
  if (kind === 'pools') return { state: query.get('state') ?? 'open', q, cursor };
  return { project, cursor };
}

/** A row keeps its accessible name and focus identity stable on background refresh. */
function Row({ id, target, selected, title, state, busy, children }: {
  id: string; target: string; selected: boolean; title: string; state?: string | null; busy?: boolean; children?: ReactNode;
}) {
  const { label } = useWebText();
  return <Link href={target} data-focus-key={id} aria-current={selected ? 'page' : undefined} className="web-record">
    <div className="web-record-heading"><strong>{title}</strong>{state && <Badge variant="outline">
      {busy && <LoaderCircle size={13} className="web-spin" aria-hidden="true" />}{label(state)}</Badge>}</div>
    <div className="web-record-copy">{children}</div>
  </Link>;
}

/** List pane shows fetched counts as loaded counts, with independent source coverage. */
export function InventoryList({ kind, query, id, update }: {
  kind: Inventory; query: URLSearchParams; id: string | null; update: (values: Record<string, string | null>, keepCursor?: boolean) => void;
}) {
  const { label, clock, duration, n } = useWebText();
  const [technical, setTechnical] = useState(false);
  const request = filters(kind, query);
  const read = useRead(JSON.stringify([kind, request]), signal => client.get(kind, { query: request, signal }), kind);
  const keys = kind === 'sessions' ? ['active', 'finished', 'failed', 'all'] : ['open', 'closed', 'all'];
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
      <div className="web-controls">
        {keys.map(key => <Button size="sm" key={key} variant={selected === key ? 'secondary' : 'outline'} aria-pressed={selected === key}
          onClick={() => update({ [groupKey]: key })}>{label(key === 'active' || key === 'open' ? 'Live' : key === 'closed' || key === 'finished' ? 'Finished' : key)}</Button>)}
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
    <ReadState read={read}>{response => {
      const { data, observations, page } = response;
      const shown = data.items.filter(row => !('workdir' in row) || !folder || row.workdir === folder);
      return <>
        {'totals' in data && data.totals && <p className="web-muted">{label('Snapshot totals')} · {label('Retained')} {data.totals.retained} · {label('open')} {data.totals.open ?? '—'} · {label('closed')} {data.totals.closed} · {label('Completed')} {data.totals.completed ?? '—'} · {label('Unknown')} {data.totals.unknown}</p>}
        {'projects' in data && <div className="web-projects">
          <Button variant="outline" size="sm" aria-pressed={!request.project} onClick={() => update({ project: null })}>{label('All projects')}</Button>
          {data.projects.map(project => <Button key={project.id} variant="outline" aria-pressed={request.project === project.id} className="web-project"
            onClick={() => update({ project: project.id })}><strong>{project.name}</strong><span>{project.path}</span><CoverageLine value={project.coverage} /></Button>)}
        </div>}
        <p className="web-muted">{label('Loaded')} {shown.length}{shown.length !== data.items.length && ' / ' + data.items.length}</p>
        <EmptyRows count={shown.length} observations={observations} />
        <div className="web-records">{shown.map(row => {
          if ('workdir' in row) return <Row key={row.id + ':' + row.execution} id={row.id + ':' + row.execution}
            target={detailUrl(row.id, row.execution)} selected={id === row.id && (!query.has('execution') || row.execution === query.get('execution'))}
            title={row.name ?? row.id} state={row.status} busy={row.status === 'running'}>
            <span>{[row.runtime, row.model, row.effort].filter(Boolean).join(' · ')}</span>
            <span>{row.workdir ?? row.projectId}{row.projectInferred && row.projectId ? ' · ' + row.projectId + ' (' + label('Inferred') + ')' : ''}</span>
            <span>{row.lastAction ?? row.summary}</span>{row.failureKind && <span className="error-text">{row.failureKind}{row.failureText && ' · ' + row.failureText}</span>}
            <span>{clock(row.finishedAtMs ?? row.progressAtMs ?? row.createdAtMs)}{row.elapsedMs != null && ' · ' + duration(row.elapsedMs)}</span>
          </Row>;
          if ('purposePreview' in row) return <Row key={row.id} id={row.id} target={detailUrl(row.id)} selected={id === row.id} title={row.name ?? row.id} state={row.state}>
            <span>{[row.kind && label(row.kind), row.leader].filter(Boolean).join(' · ')}</span><span>{row.purposePreview}</span>
          </Row>;
          const measurements = worktreeMeasurements(row, label, bytes => formatBytes(bytes, n));
          return <Row key={row.id} id={row.id} target={detailUrl(row.id)} selected={id === row.id} title={label(branchLabel(row))} state={row.integration}>
            <span>{row.path}</span><span>{measurements.changes} · {measurements.size}</span><span>{label(row.class)} · {label(row.activity ?? 'Unknown')}{row.mtimeBased ? ' · ' + label('mtime-derived') : ''}</span>
          </Row>;
        })}</div>
        <Next cursor={page.next} update={cursor => update({ cursor }, true)} />
        {request.cursor && <Button variant="ghost" onClick={() => update({ cursor: null }, true)}>{label('Beginning')}</Button>}
        <Sources items={observations} />
      </>;
    }}</ReadState>
  </>;
}

/** Parent address keeps inventory filters while stripping detail-specific query values. */
export function inventoryHref(kind: Inventory, query: URLSearchParams) {
  return href('/' + kind, { ...filters(kind, query), ...(kind === 'sessions' ? { folder: query.get('folder') } : {}) });
}
