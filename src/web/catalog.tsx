/** Overview, Bridge, Quota and Worktree presentation over v1 observations. */
import type { ReactNode } from 'react';
import type { Topic, Worktree } from '@agent-hub/domain';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Progress } from '../components/ui/progress';
import { Separator } from '../components/ui/separator';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Panel } from '../components/hub-primitives';
import { client, useRead } from './data';
import { branchLabel, formatBytes, quotaAccountTitle, worktreeMeasurements } from './model';
import { CoverageLine, EmptyRows, Expand, Facts, href, Link, ReadState, sessionHref, Sources, Text, useWebText } from './ui';

/** URL period bounds are shared with the Bridge and failed execution drill-downs. */
export function period(query: URLSearchParams) {
  return { from: query.get('from'), to: query.get('to') };
}

/** Separately scoped metrics retain bounds and display unknown values explicitly. */
function Metric({ name, value }: { name: string; value: { kind: string; value: number | null; coverage?: Parameters<typeof CoverageLine>[0]['value'] } }) {
  const { label, n } = useWebText();
  return <div className="web-metric"><span>{label(name)}</span><strong>{value.value === null ? label('Unknown') : (value.kind === 'lower_bound' ? '≥ ' : '') + n(value.value)}</strong><CoverageLine value={value.coverage} /></div>;
}

/** Client-side period input sends inclusive start and exclusive end in epoch milliseconds. */
export function Period({ query, update }: { query: URLSearchParams; update: (values: Record<string, string | null>) => void }) {
  const { label } = useWebText();
  const date = (value: string | null) => value && /^\d+$/.test(value) && +value <= 8.64e15 ? new Date(+value).toISOString().slice(0, 10) : '';
  return <div className="web-controls">
    <label>{label('From')} <input type="date" value={date(query.get('from'))} onChange={event => update({ from: event.target.value ? String(Date.parse(event.target.value)) : null })} /></label>
    <label>{label('Before')} <input type="date" value={date(query.get('to'))} onChange={event => update({ to: event.target.value ? String(Date.parse(event.target.value)) : null })} /></label>
    <Button variant="ghost" onClick={() => update({ from: null, to: null })}>{label('All time')}</Button>
  </div>;
}

/** Source summary and drill-downs share the selected observation period. */
export function Overview({ query }: { query: URLSearchParams }) {
  const { label } = useWebText();
  const bounds = period(query);
  const read = useRead(JSON.stringify(bounds), signal => client.get('overview', { query: bounds, signal }), 'overview');
  return <ReadState read={read}>{({ data, observations }) => <>
    <div className="web-cards">
      <Panel title={label('Sessions')} extra={<Link className="web-link" href={href('/sessions', { ...bounds, status: 'failed' })}>{label('Failed executions')}</Link>}>
        {data.run ? <div className="web-metrics">{(['active', 'started', 'succeeded', 'failed', 'finished'] as const).map(key => <Metric key={key} name={key} value={data.run![key]} />)}</div> : <p>{label('Unknown')}</p>}
      </Panel>
      <Panel title="Bridge" extra={<Link className="web-link" href={href('/incidents', bounds)}>{label('Incidents')}</Link>}>
        {data.bridge ? <div className="web-metrics">{(['accepted', 'pending', 'incidents'] as const).map(key => <Metric key={key} name={key} value={data.bridge![key]} />)}</div> : <p>{label('Unknown')}</p>}
      </Panel>
      <Panel title={label('Quota')} extra={<Link className="web-link" href="/quota">{label('Accounts')}</Link>}>
        {data.quota ? <Facts rows={[
          ['Accounts', data.quota.accounts], ['Known', data.quota.known], ['Unknown', data.quota.unknown],
          ['Exhausted', data.quota.exhausted], ['Stale', data.quota.stale],
          ['Lowest remaining', data.quota.lowest && `${data.quota.lowest.account} · ${data.quota.lowest.model} · ${data.quota.lowest.remaining}%`],
        ]} /> : <p>{label('Unknown')}</p>}
      </Panel>
      <Panel title={label('Current sessions')}>
        {data.run?.current.map(item => <Link className="web-inline-row" key={item.id + item.execution} href={sessionHref(item.id, item.execution)}>
          <strong>{item.name ?? item.id}</strong><Badge variant="outline">{label(item.status)}</Badge></Link>)}
        {data.run && <EmptyRows count={data.run.current.length} observations={observations.filter(item => item.source === 'run')} />}
      </Panel>
    </div>
    <Separator className="my-4" /><Sources items={observations} />
  </>}</ReadState>;
}

/** A route-controlled continuation preserves incident filters. */
export function Next({ cursor, update }: { cursor?: string | null; update: (cursor: string) => void }) {
  const { label } = useWebText();
  return cursor ? <Button variant="outline" className="web-next" onClick={() => update(cursor)}>{label('Next page')}</Button> : null;
}

/** Bridge retains producer detail and shows open and closed incidents independently. */
export function Incidents({ query, next }: { query: URLSearchParams; next: (cursor: string) => void }) {
  const { label, clock } = useWebText();
  const params = { ...period(query), cursor: query.get('cursor'), includeClosed: true };
  const read = useRead(JSON.stringify(params), signal => client.get('incidents', { query: params, signal }), 'incidents');
  return <ReadState read={read}>{({ data, observations, page }) => <>
    <EmptyRows count={data.items.length} observations={observations} />
    {!!data.items.length && <div className="panel web-incidents">
      <Table aria-label={label('Bridge incidents')} className="web-incident-table">
        <TableHeader><TableRow><TableHead>{label('Incident')}</TableHead><TableHead>{label('Status')}</TableHead></TableRow></TableHeader>
        <TableBody>{data.items.map(item => <TableRow key={item.id}>
          <TableCell><strong>#{item.id}</strong><Text>{item.detail}</Text>
            <Facts rows={[[ 'Publisher', item.publisher], ['Event ID', item.eventId], ['Created', clock(item.createdAtMs)], ['Updated', clock(item.updatedAtMs)]]} />
          </TableCell>
          <TableCell><Badge variant="outline">{label(item.state)}</Badge><Facts rows={[[ 'Closed', item.closed]]} /></TableCell>
        </TableRow>)}</TableBody>
      </Table>
    </div>}
    <Next cursor={page.next} update={next} /><Sources items={observations} />
  </>}</ReadState>;
}

/** Known percentage labels preserve the producer value even if the bar must be clamped. */
function PercentBar({ value, title }: { value: number | null; title: string }) {
  const { label, percent } = useWebText();
  return <div className="web-percent"><strong>{value == null ? label('Unknown') : percent(value)}</strong>
    {value != null && <Progress value={Math.max(0, Math.min(value, 100))} aria-label={title} />}</div>;
}

/** Quota status and snapshot retain independent availability and per-account window evidence. */
export function Quota() {
  const { label, clock, percent } = useWebText();
  const read = useRead('quota', signal => client.get('quota', { signal }), 'quota');
  const pct = (value: number | null) => value == null ? null : percent(value);
  return <ReadState read={read}>{({ data, observations }) => <>
    {data.status && <Panel title={label('Service status')}><Facts rows={[[ 'Status', label(data.status.status)], ['Started', clock(data.status.startedAtMs)],
      ['Last collection', clock(data.status.lastCollectionAtMs)], ['Collection successful', data.status.lastCollectionOk], ['Sources', data.status.sourceCount]]} />
      {!!data.status.external.length && <Expand title="External collections">{data.status.external.map((entry, i) => <Facts key={i} rows={[
        ['Account', entry.account], ['Provider', entry.provider], ['Source', entry.source], ['Accepted', clock(entry.acceptedAtMs)], ['Revision', entry.revision],
      ]} />)}</Expand>}
    </Panel>}
    {data.snapshot && <>
      <EmptyRows count={data.snapshot.accounts.length} observations={observations} />
      <div className="web-cards web-quota">{data.snapshot.accounts.map(account => <Panel key={account.account} title={label(quotaAccountTitle(account, data.snapshot!))}>
        {quotaAccountTitle(account, data.snapshot!) !== account.account && <p className="web-muted">{account.account}</p>}
        {account.models.map((model, i) => <article className="web-subcard" key={model.provider + model.model + i}>
          <header className="web-row-meta"><strong>{model.model}</strong><Badge variant="outline">{label(model.state)}</Badge><span>{model.provider}</span></header>
          <PercentBar value={model.remaining} title={model.model + ' ' + label('Remaining')} />
          <Facts rows={[[ 'Reset', clock(model.resetAtMs)], ['Validity', model.validity.kind === 'until' ? clock(model.validity.atMs) : label(model.validity.kind)],
            ['Burn', model.burn != null ? model.burn + ' ' + label('pp/hour') : null], ['Risk', label(model.risk)]]} />
          <Expand title="Technical evidence"><Facts rows={[
            ['Native model', model.nativeModel], ['Score', model.score], ['Evidence', model.evidence], ['Last sample', clock(model.newestObservedAtMs)],
            ['Exhausted until', clock(model.exhaustedUntilMs)], ['Pools', model.pools.join(', ')], ['Window', model.window && [model.window.pool, model.window.source, model.window.window].join(' · ')],
          ]} /></Expand>
        </article>)}
        {account.windows.map((window, i) => <article key={i} className="web-subcard">
          <header className="web-row-meta"><strong>{window.window}</strong><span>{[window.lane, window.runtime, window.pool].join(' · ')}</span></header>
          <PercentBar value={window.lastRemaining} title={window.window + ' ' + label('Last sample')} />
          <Facts rows={[[ 'Last sample', clock(window.observedAtMs)], ['Reset', clock(window.lastResetAtMs)], ['Valid until', clock(window.validUntilMs)],
            ['Projected reserve', pct(window.projected)], ['Sustainable reserve', pct(window.sustainable)],
            ['Burn', window.burn != null ? window.burn + ' ' + label('pp/hour') : null], ['Risk', label(window.risk)]]} />
          <Expand title="Technical evidence"><Facts rows={[[ 'Source', window.source], ['Models', window.models.join(', ')], ['Forecast known', window.forecastKnown], ['Marker', window.marker]]} /></Expand>
        </article>)}
        {account.latches.map((latch, i) => <p className="web-warning" key={i}>{label('Exhaustion latch')} · {latch.window} · {label(latch.active ? 'active' : 'Inactive')} · {clock(latch.observedAtMs)} → {clock(latch.resetAtMs)}</p>)}
        {account.advice.map((advice, i) => <Text key={i}>{advice}</Text>)}
      </Panel>)}</div>
      <Panel title={label('Collection coverage')}><Facts rows={[[ 'Status', label(data.snapshot.coverage.state)], ['Evaluated', clock(data.snapshot.evaluatedAtMs)],
        ['Last collection', clock(data.snapshot.coverage.lastCollectionAtMs)], ['Collection successful', data.snapshot.coverage.lastCollectionOk],
        ['Unobserved', data.snapshot.coverage.unobserved.join(', ') || '—']]} />
        {data.snapshot.coverage.sources.map((entry, i) => <Expand key={i} title={entry.source + ' · ' + entry.account}><Facts rows={[
          ['Status', label(entry.status)], ['Provider', entry.provider], ['Windows', entry.windows], ['Issues', entry.issues.join(', ') || '—'],
        ]} /></Expand>)}
      </Panel>
    </>}
    <Sources items={observations} />
  </>}</ReadState>;
}

/** Worktree probe values preserve lower bounds and distinguish unavailable from pending. */
export function WorktreeFacts({ row }: { row: Worktree }) {
  const { clock, label, n } = useWebText();
  const facts = row.facts;
  const measurements = worktreeMeasurements(row, label, bytes => formatBytes(bytes, n));
  return <Facts rows={[[ 'Branch', row.branch], ['Class', label(row.class)], ['Path', row.path], ['Head', row.head], ['Detached', row.detached],
    ['Activity', row.activity && label(row.activity)], ['mtime-derived', row.mtimeBased], ['Integration', row.integration && label(row.integration)],
    ['Changes', measurements.changes], ['Size', measurements.size],
    ['Measured', clock(facts.observedAtMs)], ['Expires', clock(facts.expiresAtMs)], ['Removal started', row.removalStarted], ['Creator', row.creator]]} />;
}

/** Inspects only the selected Worktree and exposes the independent bounded probe evidence. */
export function WorktreeDetails({ id }: { id: string }) {
  const { label, clock } = useWebText();
  const [topic, key]: [Topic, string] = [`worktree:${id}:detail`, id];
  const read = useRead(key, signal => client.get('worktree', { params: { id }, signal }), topic);
  return <ReadState read={read}>{({ data, observations }) => <>
    <h2>{label(branchLabel(data.worktree))}</h2><WorktreeFacts row={data.worktree} />
    {data.warnings.map((warning, i) => <p className="web-warning" key={i}>{warning.message ?? warning.code}</p>)}
    <CoverageLine value={data.coverage} />
    {data.worktree.sessions.map((item, i) => <Link className="web-inline-row web-link" key={i}
      href={sessionHref(item.sessionId, item.execution)}>{item.sessionId} · {label(item.match)}</Link>)}
    <Expand title="Technical evidence"><Facts rows={[
      ['Repository path', data.repositoryPath], ['Inspected', clock(data.inspectedAtMs)],
      ['HEAD mtime', clock(data.activitySignals?.headMtimeMs)], ['Index mtime', clock(data.activitySignals?.indexMtimeMs)],
      ['Reflog time', clock(data.activitySignals?.reflogAtMs)],
      ...(data.hygiene ?? []).map(item => [item.key, item.value] as [string, ReactNode]),
      ...(data.managedRecord ?? []).map(item => [item.key, item.value] as [string, ReactNode]),
      ...data.probes.map(item => [item.name, [label(item.state), item.code, item.detail].filter(Boolean).join(' · ')] as [string, ReactNode]),
    ]} /></Expand><Sources items={observations} />
  </>}</ReadState>;
}
