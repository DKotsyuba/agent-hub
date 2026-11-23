/** Overview, Bridge, Quota and Worktree presentation over v1 observations. */
import type { ReactNode } from 'react';
import type { Overview as OverviewData, Topic, Worktree } from '@agent-hub/domain';
import { Button } from '../components/ui/button';
import { Progress } from '../components/ui/progress';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Panel } from '../components/hub-primitives';
import { client, usePagedRead, useRead } from './data';
import { modelTitle, quotaAccountTitle, quotaAdviceKind, worktreeMeasurements } from './model';
import { accountTitle, branchLabel, formatBytes, projectQuotaSnapshot, projectQuotaStatus, quotaModelRemaining, quotaWindowForecast, windowSeconds, type QuotaAccount, type QuotaSnapshot } from '../../packages/view-model/src/index';
import { CoverageLine, EmptyRows, Expand, Facts, href, Link, ReadState, relativeTime, sessionHref, SourceEvidence, Sources, StatusBadge, Text, useEvidence, useWebText } from './ui';

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

/** Source health and activity lead the dashboard; raw evidence stays expandable. */
export function Overview({ query, filter, now }: { query: URLSearchParams; filter: ReactNode; now: number }) {
  const { label, percent } = useWebText();
  const bounds = period(query);
  const read = useRead(JSON.stringify(bounds), signal => client.get('overview', { query: bounds, signal }), 'overview');
  const bridgeLink = <Link className="web-link" href={href('/incidents', bounds)}>{label('Incidents')}</Link>;
  return <>
    <Sources items={read.value?.observations ?? []} topic="overview" strip bridgeLink={bridgeLink} />
    <ReadState read={read}>{({ data, observations }) => {
      const lowest = data.quota?.lowest;
      const account = lowest ? accountTitle(lowest.account, lowest.provider ? [lowest.provider] : []) : null;
      const bridge = data.bridge;
      return <>
        <Panel className="web-current" title={label('Current sessions')} extra={<Link className="web-link" href="/sessions">{label('All sessions')}</Link>}>
          <div className="web-panel-body">
            {data.run?.current.map(item => <Link className="web-inline-row" key={item.id + item.execution} href={sessionHref(item.id, item.execution)}>
              <strong>{item.name ?? item.id}</strong><StatusBadge state={item.status} /></Link>)}
            {data.run && <EmptyRows count={data.run.current.length} observations={observations.filter(item => item.source === 'run')} />}
            {!data.run && <p className="web-empty">{label('Session data unavailable')}</p>}
          </div>
        </Panel>
        <div className="web-cards">
          <Panel title={label('Sessions')} extra={<div className="web-panel-actions">{filter}<Link className="web-link" href={href('/sessions', { ...bounds, status: 'failed' })}>{label('Failed executions')}</Link></div>}>
            <div className="web-panel-body">{data.run ? <div className="web-metrics">
              {(['active', 'started', 'succeeded', 'failed', 'finished'] as const).map(key => <Metric key={key} name={key} value={data.run![key]} />)}
            </div> : <p className="web-empty">{label('Session data unavailable')}</p>}</div>
          </Panel>
          <Panel title={label('Quota')} extra={<Link className="web-link" href="/quota">{label('Accounts')}</Link>}>
            <div className="web-panel-body">{data.quota ? <>
              {lowest && <div className="web-quota-min"><span>{label('Lowest remaining')}</span><strong>{percent(lowest.remaining)}</strong>
                <span className="web-quota-min-model"><span>{account && account !== lowest.account ? label(account) + ' · ' : ''}{modelTitle(lowest.model)}</span>
                  {lowest.stale && <StatusBadge state="Stale" />}</span></div>}
              {data.quota.exhaustion && <OverviewExhaustion forecast={data.quota.exhaustion} now={now} />}
              <Facts rows={[[ 'Accounts', data.quota.accounts], ['Exhausted', data.quota.exhausted], ['Stale', data.quota.stale], ['Unknown', data.quota.unknown]]} />
            </> : <p className="web-empty">{label('Quota data unavailable')}</p>}</div>
          </Panel>
          {bridge && Object.values(bridge).some(value => value.value !== null) &&
            <Panel title="Bridge" extra={bridgeLink}>
              <div className="web-panel-body"><div className="web-metrics">
                {(['accepted', 'pending', 'incidents'] as const).map(key => <Metric key={key} name={key} value={bridge[key]} />)}
              </div></div>
            </Panel>}
        </div>
      </>;
    }}</ReadState>
  </>;
}

/** A route-controlled continuation preserves incident filters. */
export function Next({ cursor, update }: { cursor?: string | null; update: (cursor: string) => void }) {
  const { label } = useWebText();
  return cursor ? <Button variant="outline" className="web-next" onClick={() => update(cursor)}>{label('Next page')}</Button> : null;
}

/** Bridge retains producer detail and shows open and closed incidents independently. */
export function Incidents({ query, next }: { query: URLSearchParams; next: (cursor: string | null) => void }) {
  const { label, clock } = useWebText();
  const params = { ...period(query), includeClosed: true };
  const cursor = query.get('cursor');
  const read = usePagedRead(params, cursor, (cursor, signal) => client.get('incidents', { query: { ...params, cursor }, signal }), 'incidents');
  return <>
    {cursor && <Button variant="ghost" onClick={() => next(null)}>{label('Beginning')}</Button>}
    <ReadState read={read}>{({ data, observations, page }) => <>
    <EmptyRows count={data.items.length} observations={observations} />
    {!!data.items.length && <div className="panel web-incidents">
      <Table aria-label={label('Bridge incidents')} className="web-incident-table">
        <TableHeader><TableRow><TableHead>{label('Incident')}</TableHead><TableHead>{label('Status')}</TableHead></TableRow></TableHeader>
        <TableBody>{data.items.map(item => <TableRow key={item.id}>
          <TableCell><strong>#{item.id}</strong><Text>{item.detail}</Text>
            <Facts rows={[[ 'Publisher', item.publisher], ['Event ID', item.eventId], ['Created', clock(item.createdAtMs)], ['Updated', clock(item.updatedAtMs)]]} />
          </TableCell>
          <TableCell><StatusBadge state={item.state} /><Facts rows={[[ 'Closed', item.closed]]} /></TableCell>
        </TableRow>)}</TableBody>
      </Table>
    </div>}
    <Next cursor={page.next} update={next} /><Sources items={observations} topic="incidents" />
  </>}</ReadState></>;
}

/** Rounds forecast durations to minutes or hours without changing their underlying estimates. */
function forecastDuration(seconds: number, label: (key: string) => string, n: (amount: number) => string) {
  return seconds < 3600 ? n(Math.max(1, Math.round(seconds / 60))) + ' ' + label('min short')
    : n(Math.round(seconds / 3600)) + ' ' + label('hour short');
}

/** Identifies the deficit window separately from the model with the lowest balance. */
function OverviewExhaustion({ forecast, now }: { forecast: NonNullable<NonNullable<OverviewData['quota']>['exhaustion']>; now: number }) {
  const { label, clock, n } = useWebText();
  if (forecast.atMs <= now || forecast.resetAtMs <= now || forecast.atMs > 8.64e15
      || forecast.validUntilMs !== null && forecast.validUntilMs <= now) return null;
  const account = accountTitle(forecast.account, forecast.provider ? [forecast.provider] : []);
  const window = quotaWindowName(forecast, label, false);
  return <p className="web-quota-overview-forecast">
    <strong>{label('Expected exhaustion')}</strong>
    <time dateTime={new Date(forecast.atMs).toISOString()} title={clock(forecast.atMs)}>
      {label('Runs out in').replace('{time}', forecastDuration((forecast.atMs - now) / 1000, label, n))}
    </time>
    <span className="web-muted">{account === forecast.account ? window : label(account) + ' · ' + window}</span>
  </p>;
}

/** A window forecast is shared with the TUI. The web renders it only while its evidence is usable. */
type WindowForecast = ReturnType<typeof quotaWindowForecast> & { burn: number | null };

/** Compact quota line keeps the measured value, reset time, and freshness together. */
function QuotaRow({ title, value, reset, now, state, risk, forecast }: {
  title: string; value: number | null; reset: number | null; now: number; state?: string; risk: string; forecast?: WindowForecast;
}) {
  const { label, clock, percent, tag, n } = useWebText();
  const usable = forecast?.known && !forecast.stale;
  const pace = usable ? forecast.pace : null;
  const burn = usable ? forecast.burn : null;
  const note = usable ? label({
    reserve: 'Quota pace reserve', deficit: 'Quota pace deficit', even: 'Quota on pace', unknown: 'Quota pace unknown',
  }[forecast.note.kind]).replace('{amount}', percent(forecast.note.points)) : null;
  const exhaustion = usable && forecast.exhaust.kind === 'runs_out' && forecast.exhaust.seconds !== null
    ? label('Runs out in').replace('{time}', forecastDuration(forecast.exhaust.seconds, label, n))
    : usable && forecast.exhaust.kind === 'lasts' ? label('Lasts until reset')
      : usable && forecast.exhaust.kind === 'exhausted' ? label('Exhausted') : null;
  const untilReset = usable && forecast.exhaust.kind === 'runs_out' && reset !== null && reset > now / 1000
    ? label('Time until reset').replace('{time}', forecastDuration(reset - now / 1000, label, n)) : null;
  const forecastText = forecast && (usable ? [note, exhaustion, untilReset].filter(Boolean).join(' · ') : label('Forecast unknown'));
  const burnText = burn === null ? null : label(burn > 0 && burn < 0.1 ? 'Forecast tiny burn' : 'Forecast burn')
    .replace('{rate}', n(burn > 0 && burn < 0.1 ? 0.1 : Math.round(burn * 10) / 10));
  const riskVisible = forecast ? usable && ['low', 'medium', 'high'].includes(risk)
    : value !== null && ['medium', 'high', 'critical'].includes(risk);
  const resetMs = reset !== null && Math.abs(reset * 1000) <= 8.64e15 ? reset * 1000 : null;
  return <div className="web-quota-row" data-stale={state === 'Stale' || undefined}>
    <div className="web-quota-row-heading"><strong>{title}</strong>
      <span className="web-quota-reading">{riskVisible && <StatusBadge state={risk} />}
        <span className="web-quota-value">{value !== null ? percent(value) : label('Unknown')}</span></span></div>
    {value === null ? <div className="web-quota-track" aria-hidden="true" /> :
      <div className="web-quota-bar" data-tone={forecast?.tone}>
        <Progress value={Math.max(0, Math.min(value, 100))} aria-label={title + ' · ' + label('Remaining')}
          aria-valuetext={pace === null ? undefined : percent(value) + ' · ' + label('Expected remaining') + ' ' + percent(pace)} />
        {pace !== null && <span className="web-quota-pace-marker" aria-hidden="true"
          style={{ insetInlineStart: `clamp(1px, ${pace}%, calc(100% - 1px))` }}
          title={label('Expected remaining') + ' ' + percent(pace)} />}
      </div>}
    {forecastText && <p className="web-quota-forecast" data-tone={usable ? forecast?.tone : undefined}
      title={untilReset ? clock(resetMs) : undefined}>{forecastText}</p>}
    <div className="web-quota-row-meta">
      {!untilReset && (resetMs === null ? <span>{label('Reset unknown')}</span> :
        <time dateTime={new Date(resetMs).toISOString()} title={clock(resetMs)}>{label('Reset')} · {relativeTime(resetMs, now, tag)}</time>)}
      {state && <StatusBadge state={state} />}
      {burnText && <span>{burnText}</span>}
    </div>
  </div>;
}

/** Gives common quota windows localized names, with lane context when needed. */
function quotaWindowName(window: Pick<QuotaAccount['windows'][number], 'window' | 'lane'>, label: (name: string) => string, distinguishLane: boolean) {
  const length = windowSeconds(window.window);
  const name = length === 18000 ? label('Five-hour window') : length === 604800 ? label('Weekly window')
    : length === 86400 ? label('Daily window') : length === 36000 ? label('Ten-hour window') : window.window === 'monthly' ? label('Monthly window') : window.window.replaceAll('_', ' ');
  const model = window.lane.startsWith('model:') && window.lane.slice(6);
  return model ? `${model[0].toUpperCase()}${model.slice(1)} · ${name}` : distinguishLane ? name + ' · ' + label(window.lane) : name;
}

/** Renders one account with compact samples, a model disclosure and a single evidence section. */
function QuotaCard({ account, title, discriminator, now }: { account: QuotaAccount; title: string; discriminator?: string; now: number }) {
  const { label, clock, percent } = useWebText();
  const quotaClock = (seconds: number | null) => clock(seconds === null ? null : seconds * 1000);
  const pct = (value: number | null) => value === null ? null : percent(value);
  const windows = [...account.windows].sort((a, b) => Number(a.lane.startsWith('model:')) - Number(b.lane.startsWith('model:'))
    || (windowSeconds(a.window) ?? Infinity) - (windowSeconds(b.window) ?? Infinity));
  const samples = windows.map(window => ({ ...quotaWindowForecast(window, now / 1000), burn: window.burn }));
  const exhausted = account.latches.some(latch => latch.active) || account.models.some(model => model.state === 'exhausted')
    || samples.some((sample, i) => sample.remaining === 0 && !sample.stale && windows[i].validUntil !== null);
  return <Panel title={title} extra={<div className="web-panel-actions">
    {discriminator && <span className="web-muted web-account-discriminator" title={account.account}>{discriminator}</span>}
    {exhausted && <StatusBadge state="exhausted" />}
  </div>}>
    <div className="web-panel-body">
      {windows.length === 0 && <p className="web-empty">{label('No account windows reported')}</p>}
      {windows.map((window, i) => <QuotaRow key={i} title={quotaWindowName(window, label, windows.some(other => other !== window && other.window === window.window && !other.lane.startsWith('model:')))}
        value={samples[i].remaining} reset={samples[i].resetAt} now={now} risk={window.risk} forecast={samples[i]}
        state={samples[i].stale ? 'Stale' : undefined} />)}
      {!!account.models.length && <Expand title={label('Models') + ' · ' + account.models.length}>
        {account.models.map((model, i) => <QuotaRow key={i} title={modelTitle(model.model)} value={quotaModelRemaining(model)} reset={model.state === 'unknown' ? null : model.resetAt} now={now}
          state={model.state === 'exhausted' ? model.state : model.evidence === 'stale' ? 'Stale' : undefined} risk={model.risk} />)}
      </Expand>}
      {[...new Set(account.advice.map(quotaAdviceKind))].map(kind => kind && <p key={kind} className="web-muted web-quota-advice">{label(kind)}</p>)}
      <Expand title="Technical evidence">
        <Facts rows={[[ 'Account', account.account]]} />
        {!!account.advice.length && <><h3>{label('Producer advice')}</h3>{account.advice.map((advice, i) => <Text key={i}>{advice}</Text>)}</>}
        {windows.map((window, i) => <section className="web-subcard" key={i}><h3>{[window.pool, window.source, window.window].join(' · ')}</h3>
          <Facts rows={[[ 'Last sample', quotaClock(window.observedAt)], ['Valid until', quotaClock(window.validUntil)],
            ['Projected reserve', pct(window.projected)], ['Sustainable reserve', pct(window.sustainable)],
            ['Burn', window.burn != null ? window.burn + ' ' + label('pp/hour') : null], ['Risk', label(window.risk)],
            ['Models', window.models.join(', ')], ['Forecast known', window.forecastKnown], ['Marker', window.marker]]} /></section>)}
        {account.models.map((model, i) => <section className="web-subcard" key={i}><h3>{modelTitle(model.model)}</h3>
          <Facts rows={[[ 'Native model', model.nativeModel ?? model.model], ['Provider', model.provider], ['Score', model.score],
            ['Evidence', label(model.evidence)], ['Last sample', quotaClock(model.newestObservedAt)], ['Exhausted until', quotaClock(model.exhaustedUntil)],
            ['Validity', model.validity.kind === 'until' ? quotaClock(model.validity.at) : label(model.validity.kind)],
            ['Burn', model.burn != null ? model.burn + ' ' + label('pp/hour') : null], ['Risk', label(model.risk)], ['Pools', model.pools.join(', ')],
            ['Window', model.window && [model.window.pool, model.window.source, model.window.window].join(' · ')]]} /></section>)}
        {account.latches.map((latch, i) => <p className="web-warning" key={i}>{label('Exhaustion latch')} · {latch.window} · {label(latch.active ? 'active' : 'Inactive')} · {quotaClock(latch.observedAt)} → {quotaClock(latch.resetAt)}</p>)}
      </Expand>
    </div>
  </Panel>;
}

/** Account samples lead the page; service and coverage diagnostics follow in one disclosure. */
export function Quota({ now }: { now: number }) {
  const { label, clock, tag } = useWebText();
  const read = useRead('quota', signal => client.get('quota', { signal }), 'quota');
  const quotaClock = (seconds: number | null) => clock(seconds === null ? null : seconds * 1000);
  const evidence = useEvidence([{ topic: 'quota', items: read.value?.observations ?? [] }]);
  return <ReadState read={read}>{({ data, observations }) => {
    const status = data.status && projectQuotaStatus(data.status);
    const snapshot = data.snapshot && projectQuotaSnapshot(data.snapshot);
    const hasPace = snapshot?.accounts.some(account => account.windows.some(window => {
      const forecast = quotaWindowForecast(window, now / 1000);
      return !forecast.stale && forecast.pace !== null;
    }));
    const collected = snapshot?.coverage.lastCollectionAt ?? status?.lastCollectionAt;
    const titles = snapshot?.accounts.map(account => label(quotaAccountTitle(account, snapshot))) ?? [];
    const accountsByTitle = new Map<string, string[]>();
    snapshot?.accounts.forEach((account, i) => {
      const ids = accountsByTitle.get(titles[i]) ?? [];
      ids.push(account.account);
      accountsByTitle.set(titles[i], ids);
    });
    for (const ids of accountsByTitle.values()) ids.sort();
    return <>
      {(collected != null || snapshot?.coverage.state === 'partial') && <p className="web-muted web-quota-collected">
        {label('Last collection')} · {collected == null ? label('Unknown') : relativeTime(collected * 1000, now, tag)}
        {snapshot?.coverage.state === 'partial' && <StatusBadge state="partial" />}
      </p>}
      {hasPace && <p className="web-muted web-quota-legend">{label('Pace marker legend')}</p>}
      {snapshot ? <>
        <EmptyRows count={snapshot.accounts.length} observations={observations.filter(item => item.resource !== 'quota.status')} />
        <div className="web-cards web-quota">{snapshot.accounts.map((account, i) => {
          const siblings = accountsByTitle.get(titles[i])!;
          return <QuotaCard key={account.account} account={account} title={titles[i]}
            discriminator={siblings.length > 1 ? label('Account') + ' ' + (siblings.indexOf(account.account) + 1) : undefined} now={now} />;
        })}</div>
      </> : <p className="web-warning" role="status">{label('Quota data unavailable')}</p>}
      {(status || snapshot || evidence.some(scope => scope.items.length > 0)) && <Expand title="Quota source evidence">
        {status && <><h2>{label('Service status')}</h2><Facts rows={[[ 'Status', label(status.status)], ['Started', quotaClock(status.startedAt)],
          ['Last collection', quotaClock(status.lastCollectionAt)], ['Collection successful', status.lastCollectionOk], ['Sources', status.sourceCount]]} />
          {!!status.external.length && <Expand title="External collections">{status.external.map((entry, i) => <Facts key={i} rows={[
            ['Account', label(accountTitle(entry.account, [entry.provider]))], ['Provider', entry.provider], ['Source', entry.source],
            ['Accepted', quotaClock(entry.acceptedAt)], ['Revision', entry.revision],
          ]} />)}</Expand>}
        </>}
        {snapshot && <><h2>{label('Collection coverage')}</h2><Facts rows={[[ 'Status', label(snapshot.coverage.state)],
          ['Evaluated', quotaClock(snapshot.evaluatedAt)], ['Last collection', quotaClock(snapshot.coverage.lastCollectionAt)],
          ['Collection successful', snapshot.coverage.lastCollectionOk], ['Unobserved', snapshot.coverage.unobserved.join(', ') || '—']]} />
          {snapshot.coverage.sources.map((entry, i) => <Expand key={i} title={entry.source + ' · ' + label(accountTitle(entry.account, [entry.provider]))}><Facts rows={[
            ['Status', label(entry.status)], ['Provider', entry.provider], ['Windows', entry.windows], ['Issues', entry.issues.join(', ') || '—'],
          ]} /></Expand>)}
        </>}
        {evidence.map((scope, i) => scope.items.length > 0 && <section key={i}>
          <h2>{label(scope.title ?? 'Source observations')}</h2><SourceEvidence items={scope.items} />
        </section>)}
      </Expand>}
    </>;
  }}</ReadState>;
}

/** Worktree probe values preserve lower bounds and distinguish unavailable from pending. */
export function WorktreeFacts({ row }: { row: Worktree }) {
  const { clock, label, n } = useWebText();
  const facts = row.facts;
  const measurements = worktreeMeasurements(row, label, bytes => formatBytes(bytes, n));
  return <Facts rows={[[ 'Changes', measurements.changes], ['Size', measurements.size], ['Class', label('worktree-class:' + row.class)],
    ['Measured', clock(facts.observedAtMs)], ['Expires', clock(facts.expiresAtMs)]]} />;
}

/** Inspects only the selected Worktree and exposes the independent bounded probe evidence. */
export function WorktreeDetails({ id }: { id: string }) {
  const { label, clock } = useWebText();
  const [topic, key]: [Topic, string] = [`worktree:${id}:detail`, id];
  const read = useRead(key, signal => client.get('worktree', { params: { id }, signal }), topic);
  return <ReadState read={read}>{({ data, observations }) => <>
    <h2>{label(branchLabel(data.worktree, true))}</h2>
    <div className="web-row-meta">{data.worktree.integration && <StatusBadge state={data.worktree.integration} />}{data.worktree.activity && <StatusBadge state={data.worktree.activity} />}</div>
    <WorktreeFacts row={data.worktree} />
    {data.warnings.map((warning, i) => <p className="web-warning" key={i}>{warning.message ?? label(warning.code)}</p>)}
    <CoverageLine value={data.coverage} />
    {data.worktree.sessions.map((item, i) => <Link className="web-inline-row web-link" key={i}
      href={sessionHref(item.sessionId, item.execution)}>{item.sessionId} · {label(item.match)}</Link>)}
    <Expand title="Technical evidence"><Facts rows={[
      ['Branch', data.worktree.branch], ['Path', data.worktree.path], ['Head', data.worktree.head], ['Detached', data.worktree.detached],
      ['Activity', data.worktree.activity && label(data.worktree.activity)], ['mtime-derived', data.worktree.mtimeBased],
      ['Integration', data.worktree.integration && label(data.worktree.integration)], ['Removal started', data.worktree.removalStarted], ['Creator', data.worktree.creator],
      ['Repository path', data.repositoryPath], ['Inspected', clock(data.inspectedAtMs)],
      ['HEAD mtime', clock(data.activitySignals?.headMtimeMs)], ['Index mtime', clock(data.activitySignals?.indexMtimeMs)],
      ['Reflog time', clock(data.activitySignals?.reflogAtMs)],
      ...(data.hygiene ?? []).map(item => [item.key, item.value] as [string, ReactNode]),
      ...(data.managedRecord ?? []).map(item => [item.key, item.value] as [string, ReactNode]),
      ...data.probes.map(item => [item.name, [label(item.state), item.code, item.detail].filter(Boolean).join(' · ')] as [string, ReactNode]),
    ]} /></Expand><Sources items={observations} topic={topic} title="Details" />
  </>}</ReadState>;
}
