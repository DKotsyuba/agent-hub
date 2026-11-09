/** Source-specific read-only projections inside the approved single-screen shell. */
import { useEffect, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { Activity, ArrowLeft, ArrowRight, Bot, Check, ChevronRight, CircleHelp, Clock3, Copy, GitBranch, LoaderCircle, TriangleAlert } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Choice, Field, Panel, activateRecordRow } from '../components/hub-primitives';
import { useLocale } from '../i18n';
import type { MessageKey } from '../locales';
import { liveText } from './copy';
import type { LiveKey } from './copy';
import { useInventory, useObservation } from './hooks';
import type { Observation, Inventory } from './hooks';
import type { LiveIndex } from './index';
import { useAnswer, useTranscript } from './run-details';
import { longestWorktree, number, object, product, worktreeDetail, text, usable, legacyPoolPage, poolPage, poolDetail, integer, bridgeData, ideData, legacyPoolDetail, decimalCursor, reportObserved, reportCompleted, limitsData, modelsData, tasksData, basename, activeStatus, attentionAgent, recentAnswers } from './protocol';
import type { LiveWorktree, Page, ReadResponse, Resource, RunAgent, RunLifecycle } from './protocol';

/** Stable existing route kinds, shared without introducing another router. */
type Section = 'overview' | 'agents' | 'pools' | 'worktrees' | 'projects' | 'tools';
/** Existing shell callback; IDs contain the actual source namespace and producer identity. */
type Open = (kind: Exclude<Section, 'overview'>, id: string, sequence?: number) => void;
/** Native read state and existing shell preferences; no fixture model enters this boundary. */
export interface LiveSectionProps {
  /** Current sidebar section. */
  section: Section;
  /** Current full-screen detail identity, or the list. */
  selected: { kind: Exclude<Section, 'overview'>; id: string; sequence?: number } | null;
  /** Existing cached project/common-directory filter. */
  scope: string;
  /** Existing cached source-text search. */
  query: string;
  /** Existing cached lifecycle filter. */
  status: string;
  /** Updates only the cached filter, never a source. */
  onStatus: (value: string) => void;
  /** Clears only cached local filters, never a source. */
  reset: () => void;
  /** Opens the existing full agent list while retaining shared scope/status preferences. */
  showAgents: () => void;
  /** Current tab stored in the existing screen snapshot. */
  tab: string;
  /** Updates only the current screen's tab. */
  onTab: (value: string) => void;
  /** Explicit manual refresh generation. */
  refresh: number;
  /** Visible inventories and safe connection diagnostics. */
  index: LiveIndex;
  /** Existing screen navigation, including full browser Back/Forward. */
  open: Open;
  /** Existing actual-screen Back action. */
  back: () => void;
  /** Existing heading focus restoration target. */
  heading: RefObject<HTMLHeadingElement | null>;
  /** Existing list scroll restoration target. */
  list: RefObject<HTMLDivElement | null>;
  /** Localized typed feedback; clipboard failure is distinct from success. */
  notify: (message: MessageKey, severity: 'success' | 'warning') => void;
}
/** Adds explicit live-copy formatting without translating arbitrary source text. */
function useLiveLocale() {
  const locale = useLocale();
  return { ...locale, l: (key: LiveKey, values?: Record<string, string | number>) => liveText(locale.locale, key, values) };
}
/** Converts a known producer epoch to ISO; malformed/absent time remains unreported. */
function iso(value: number | null, milliseconds = false): string | null { if (value === null) return null; const date = new Date(value * (milliseconds ? 1 : 1000)); return Number.isFinite(date.getTime()) ? date.toISOString() : null; }
/** Renders raw source JSON only as wrapped plain text, never HTML or an artifact link. */
function Raw({ value, title }: { value: unknown; title?: string }) { const { l } = useLiveLocale(); return <details className="metadata"><summary>{title ?? l('Original producer data')}</summary><pre>{JSON.stringify(value, null, 2)}</pre></details>; }
/** Displays an explicitly absent source value without coercing it to zero or empty success. */
function Value({ value }: { value: unknown }) { const { t } = useLocale(); return value === null || value === undefined ? <span className="muted">{t('No information')}</span> : typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? <>{String(value)}</> : <Raw value={value} />; }
/** Distinguishes the producer clock from local native receipt time. */
function SourceTime({ value, milliseconds = false, label = 'Source observation: {time}' }: { value: number | null; milliseconds?: boolean; label?: LiveKey }) { const { l, datetime } = useLiveLocale(); const date = iso(value, milliseconds); return <span className="muted">{date ? l(label, { time: datetime(date) }) : l('Source timestamp not reported')}</span>; }
/** Shows source failure/partial/loading state; Overview moves the separate receipt into provenance. */
function SourceNotice({ state, receipt = true }: { state: Pick<Observation, 'loading' | 'response' | 'good'> & { rejected?: ReadResponse }; receipt?: boolean }) {
  const { l, datetime } = useLiveLocale(); const value = state.response;
  const label = !value ? l('Loading source observations') : value.outcome === 'ok' ? null : l(({ partial: 'Partial source response', unavailable: 'Unavailable', incompatible: 'Incompatible', missing: 'Missing', invalid: 'Invalid response' } as const)[value.outcome]);
  return <>{label && <div className="state-banner warning" role="status">{state.loading ? <LoaderCircle size={18} className="spin" /> : <TriangleAlert size={18} />}<div><strong>{label}</strong>{value && <p>{value.resource}{value.error && <> · {value.error.code}</>}</p>}{state.good && value && !usable(value) && <p>{l('Retained last good snapshot; freshness is unconfirmed.')}</p>}</div></div>}{receipt && value && <p className="source-note muted">{l('Local receipt: {time} · not a source timestamp', { time: datetime(new Date(value.observed_at_ms).toISOString()) })}</p>}{state.rejected && value && !usable(value) && <Raw value={state.rejected.data} title={l('Unsupported producer projection')} />}</>;
}
/** Shows loaded coverage and continuation; compact Overview folds receipt without hiding the producer clock. */
function Coverage<T>({ inventory, compact = false }: { inventory: Inventory<T>; compact?: boolean }) {
  const { l, n, datetime } = useLiveLocale(); const page = inventory.page;
  const content = <><SourceNotice state={inventory} receipt={!compact} />{page && <div className="live-coverage"><span>{page.total === null ? l('Loaded {loaded} records; total unknown', { loaded: n(page.items.length) }) : l('Loaded {loaded} of {total} records', { loaded: n(page.items.length), total: n(page.total) })} · {l(page.complete ? 'Complete reported coverage' : 'Coverage is incomplete or unknown')}</span>{page.next !== null && <Button variant="outline" onClick={inventory.loadMore} disabled={inventory.loading}>{inventory.loading ? <LoaderCircle size={16} className="spin" /> : null}{l('Load more')}</Button>}</div>}<SourceTime value={page?.observed ?? null} label={inventory.response?.resource === 'run.agents' ? 'Source view built: {time}' : 'Source observation: {time}'} />{compact ? <details className="metadata"><summary>{l('Coverage and provenance')}</summary>{inventory.response && <p className="source-note muted">{l('Local receipt: {time} · not a source timestamp', { time: datetime(new Date(inventory.response.observed_at_ms).toISOString()) })}</p>}{page && <pre>{JSON.stringify(page.coverage, null, 2)}</pre>}</details> : page && <Raw value={page.coverage} title={l('Coverage and provenance')} />}</>;
  return compact ? <div className="live-overview-coverage">{content}</div> : content;
}
/** One full content-area detail frame at every width, sharing the shell's Back/focus behavior. */
function Detail({ title, source, props, children }: { title: string; source: string; props: LiveSectionProps; children: ReactNode }) {
  const { t } = useLocale();
  return <section className="detail-screen" aria-label={t('Details: {name}', { name: title })}><header className="detail-heading"><Button variant="ghost" className="detail-back" onClick={props.back}><ArrowLeft size={17} />{t('Back')}</Button><span className="eyebrow">{source} / {t('Details')}</span><h1 ref={props.heading} tabIndex={-1}>{title}</h1></header><div className="detail-content">{children}</div></section>;
}
/** Human task source text wins; an absent name never becomes an invented opaque task title. */
function taskName(agent: RunAgent | null, fallback: string): string { return agent?.name?.trim() || agent?.summary?.trim() || fallback; }
/** Every current producer lifecycle has explicit EN/RU copy; dictionary choice is never guessed from source text. */
const lifecycleCopy: Record<RunLifecycle, { kind: 'base'; key: MessageKey } | { kind: 'live'; key: LiveKey }> = {
  created: { kind: 'live', key: 'Created' }, starting: { kind: 'live', key: 'Starting' }, running: { kind: 'base', key: 'Running' }, cancelling: { kind: 'live', key: 'Cancelling' },
  succeeded: { kind: 'base', key: 'Completed' }, failed: { kind: 'base', key: 'Error' }, timed_out: { kind: 'live', key: 'Timed out (historical)' }, cancelled: { kind: 'live', key: 'Cancelled' }, lost: { kind: 'live', key: 'Lost' },
};
/** Unknown future source values remain visible and cannot inherit Object prototype translations. */
function lifecycleLabel(value: string, t: (key: MessageKey) => string, l: (key: LiveKey, values?: Record<string, string | number>) => string): string {
  if (!Object.hasOwn(lifecycleCopy, value)) return l('Unrecognized lifecycle: {value}', { value });
  const copy = lifecycleCopy[value as RunLifecycle];
  return copy.kind === 'base' ? t(copy.key) : l(copy.key);
}
/** Known lifecycle labels retain distinct source text and never classify silence as stuck. */
function RunStatus({ value }: { value: string }) {
  const { t, l } = useLiveLocale();
  const style = value === 'succeeded' ? 'succeeded' : ['failed', 'timed_out', 'lost'].includes(value) ? 'failed' : activeStatus(value) ? 'running' : 'unknown';
  return <Badge variant="outline" className={'status status-' + style}>{style === 'running' ? <Activity size={14} /> : style === 'failed' ? <TriangleAlert size={14} /> : style === 'succeeded' ? <Check size={14} /> : <CircleHelp size={14} />}{lifecycleLabel(value, t, l)}</Badge>;
}
/** Run table uses real source IDs, loaded coverage and the shared whole-row activation. */
function RunTable({ rows, props }: { rows: RunAgent[]; props: LiveSectionProps }) {
  const { t, l, duration, datetime } = useLiveLocale();
  return <div ref={props.list} className="records-list" aria-label={t('List: {section}', { section: t('Agents') })}><table className="agent-table"><thead><tr><th scope="col">{t('Task / project')}</th><th scope="col">{t('Status')}</th><th scope="col" className="optional-column">{t('Model')}</th><th scope="col" className="optional-column">{t('Duration / activity')}</th></tr></thead><tbody>{rows.map(agent => {
    const tree = longestWorktree(agent.workdir, props.index.worktrees.page?.items ?? []); const id = 'run:' + agent.id; const name = taskName(agent, l('Unnamed task')); const progress = iso(agent.progress);
    return <tr key={id} className="agent-row" onClick={event => activateRecordRow(event, () => props.open('agents', id))}><td><button className="agent-name" data-focus-key={'agents:' + id} aria-label={t('Open agent: {name}', { name })} onClick={() => props.open('agents', id)}><Bot size={20} /><span><strong>{name}</strong><span className="muted" title={tree?.common}>{props.index.repositories.find(repo => repo.id === tree?.common)?.label ?? l('No confirmed repository')}<span className="compact-model"> · {agent.model ?? t('No information')}</span></span></span></button></td><td><RunStatus value={agent.status} /></td><td className="optional-column">{agent.model ?? t('No information')}</td><td className="optional-column">{duration(agent.elapsed === null ? null : agent.elapsed * 1000)}<span className="cell-secondary muted">{progress ? l('Last transcript progress: {time}', { time: datetime(progress) }) : l('Activity time not reported')}</span></td></tr>;
  })}</tbody></table></div>;
}
/** Lazily displays execution-fenced history/results; complete plaintext uses labelled keyboard-scrollable areas. */
function RunDetail({ props, agentId }: { props: LiveSectionProps; agentId: string }) {
  const { t, l, duration } = useLiveLocale();
  const currentAgent = props.index.run.page?.items.find(row => row.id === agentId) ?? null;
  const staleBinding = props.selected?.sequence !== undefined && currentAgent !== null && currentAgent.sequence !== props.selected.sequence;
  const attributionReady = currentAgent !== null && !staleBinding;
  const agent = attributionReady ? currentAgent : null;
  const history = useTranscript(agentId, agent?.sequence ?? null, props.refresh, props.tab === 'history' && attributionReady);
  const answer = useAnswer(agentId, agent, props.refresh, props.tab === 'result' && attributionReady);
  const tree = longestWorktree(agent?.workdir ?? null, props.index.worktrees.page?.items ?? []);
  return <Detail title={taskName(agent, l('Task information'))} source="Agent Run" props={props}>
    {agent ? <><div className="detail-intro"><RunStatus value={agent.status} /><span>{agent.model ?? t('No information')} · {duration(agent.elapsed === null ? null : agent.elapsed * 1000)}</span></div><SourceTime value={agent.observed} label="Source view built: {time}" /></> : <div className="inline-note"><CircleHelp size={18} /><span>{l(staleBinding ? 'Bound execution is no longer current; no current result is attributed to the old binding.' : 'Source sequence is not in loaded coverage. Load more inventory to establish execution attribution.')}</span>{props.index.run.page?.next != null && <Button variant="outline" onClick={props.index.run.loadMore}>{l('Load more')}</Button>}</div>}
    <Tabs value={props.tab || 'history'} onValueChange={props.onTab} className="detail-tabs"><TabsList aria-label={t('Agent information')}><TabsTrigger value="history">{t('History')}</TabsTrigger><TabsTrigger value="result">{t('Result')}</TabsTrigger><TabsTrigger value="details">{t('Details')}</TabsTrigger></TabsList>
      <TabsContent value="history"><SourceNotice state={{ response: history.response, loading: history.loading, good: history.blocks.length ? history.response : null }} />{history.previous !== null && <Button variant="outline" onClick={history.loadOlder} disabled={history.older}>{l('Load older messages')}</Button>}{!history.complete && <p className="muted">{l('Source history may be incomplete')}</p>}{history.blocks.map(block => {
        const tool = ['tool', 'tool_call', 'tool_result'].includes(block.role); const title = tool ? l('Tool message') + (text(block.raw.name) ? ' · ' + text(block.raw.name) : '') : block.role === 'user' ? t('You') : block.role === 'assistant' ? t('Assistant') : block.role;
        const content = <><SourceTime value={block.at} />{(block.raw.partial_before === true || block.raw.partial_after === true || block.raw.content_complete === false) && <p className="muted">{l('Source marked this block as incomplete')}</p>}<pre className="source-text" role="group" aria-label={title} tabIndex={0}>{block.content}</pre><Raw value={block.raw} title={t('Technical metadata')} /></>;
        return tool ? <details className="tool-call" key={block.key}><summary>{title}<span className="call-result">{block.raw.error === true ? t('Error') : block.raw.error === false ? t('Success') : t('No information')}</span></summary><div className="tool-body">{content}</div></details> : <article className="message" key={block.key}><header><strong>{title}</strong></header>{content}</article>;
      })}{!history.loading && history.blocks.length === 0 && history.response && usable(history.response) && <p>{l('No messages in the reported window')}</p>}</TabsContent>
      <TabsContent value="result"><SourceNotice state={answer} />{answer.issue && <div className="state-banner warning" role="status"><TriangleAlert size={18} /><div><strong>{l('Answer proof could not be established')}</strong><p>{l(answer.issue === 'answer_chunk_unsupported' ? 'Large answer chunks are unsupported or execution/hash proof is missing.' : answer.issue === 'answer_attribution_missing' ? 'The captured list has no sequence/hash attribution for this answer.' : 'Answer integrity or attribution changed; content is withheld.')} · {answer.issue}</p></div></div>}{answer.content !== null ? <><div className="result-heading"><h3>{l('Complete attributed answer')}</h3><Button variant="outline" onClick={async () => { try { await navigator.clipboard.writeText(answer.content!); props.notify('Result copied', 'success'); } catch { props.notify('Could not copy. Select and copy the result text manually.', 'warning'); } }}><Copy size={15} />{t('Copy result')}</Button></div><pre className="source-text" role="region" aria-label={t('Result')} tabIndex={0}>{answer.content}</pre></> : !answer.loading && !answer.issue && answer.good ? <p>{l('No saved answer available')}</p> : null}<p className="muted">{l('Artifact paths and raw references are displayed as text and are never opened.')}</p>{answer.good && <Raw value={Object.fromEntries(Object.entries(object(answer.good.data)).filter(([key]) => key !== 'content'))} title={l('Answer metadata')} />}</TabsContent>
      <TabsContent value="details"><dl><Field label={t('Identifier')}>{agentId}</Field><Field label={l('Sequence')}><Value value={props.selected?.sequence ?? agent?.sequence} /></Field><Field label={l('Lifecycle')}>{agent ? <RunStatus value={agent.status} /> : t('No information')}</Field><Field label={l('Answer availability')}>{agent?.answerAvailable === null || !agent ? t('No information') : l(agent.answerAvailable ? 'Available' : 'Not available')}</Field><Field label={l('Delivery state')}><Value value={agent?.raw.delivery} /></Field><Field label={l('Cleanup state')}><Value value={agent?.raw.cleanup} /></Field><Field label={l('Silence')}>{duration(agent?.silence === null || !agent ? null : agent.silence * 1000)}<p className="muted">{l('Silence is an observation, not a stuck classification.')}</p></Field><Field label={l('Working directory')}><Value value={agent?.workdir} /></Field><Field label={l('Repository identity')}>{tree ? <button className="text-link" data-focus-key={'projects:repo:' + tree.common} onClick={() => props.open('projects', 'repo:' + tree.common)}>{tree.common}<ArrowRight size={14} /></button> : l('No confirmed repository')}</Field><Field label={t('Working copy')}>{tree ? <button className="text-link" data-focus-key={'worktrees:wt:' + tree.key} onClick={() => props.open('worktrees', 'wt:' + tree.key)}>{tree.path}<ArrowRight size={14} /></button> : l('No confirmed working copy')}</Field></dl>{agent && <Raw value={agent.raw} title={t('Technical metadata')} />}</TabsContent>
    </Tabs>
  </Detail>;
}
/** Worktree inspection occurs only after explicit detail selection; optional size is a separate user read. */
function WorktreeDetail({ props, tree }: { props: LiveSectionProps; tree: LiveWorktree | null }) {
  const { t, l } = useLiveLocale(); const [measure, setMeasure] = useState(false);
  const inspection = useObservation(tree ? { resource: 'worktree.inspect', params: { repo: tree.path, path: tree.path, checks: { integration: true, processes: true, size: false, status: true, submodules: true } } } : null, props.refresh, false, true, worktreeDetail);
  const size = useObservation(tree && measure ? { resource: 'worktree.inspect', params: { repo: tree.path, path: tree.path, checks: { integration: false, processes: false, size: true, status: false, submodules: false } } } : null, props.refresh, false, true, worktreeDetail);
  return <Detail title={tree ? basename(tree.path) : l('Not in loaded coverage')} source="Agent Worktree" props={props}>{!tree ? <Coverage inventory={props.index.worktrees} /> : <><dl><Field label={t('Branch')}><Value value={tree.branch} /></Field><Field label={l('Path')}>{tree.path}</Field><Field label={l('Repository identity')}><button className="text-link" data-focus-key={'projects:repo:' + tree.common} onClick={() => props.open('projects', 'repo:' + tree.common)}>{tree.common}<ArrowRight size={14} /></button></Field></dl><p>{l('A narrow probe does not establish full cleanliness.')}</p><SourceNotice state={inspection} />{inspection.good && <ProbeDetails value={worktreeDetail(inspection.good.data)} />}<Button variant="outline" onClick={() => setMeasure(true)} disabled={size.loading && measure}>{l('Measure size read-only')}</Button>{measure && <><SourceNotice state={size} />{size.good && <ProbeDetails value={worktreeDetail(size.good.data)} />}</>}<Raw value={tree.raw} /></>}</Detail>;
}
/** Named inspection probes expose their own state/value/code/reason without asserting global cleanliness. */
function ProbeDetails({ value }: { value: Record<string, unknown> }) {
  const { t, l, size } = useLiveLocale();
  const probes = object(value.probes);
  const labels: [string, string][] = [['status', t('Status')], ['integration', l('Integration')], ['processes', l('Processes')], ['submodules', l('Submodules')], ['size', l('Size measurement')]];
  return <><SourceTime value={number(value.observed_at)} />{labels.filter(([key]) => probes[key] !== undefined).map(([key, label]) => {
    const raw = probes[key]; const probe = raw && typeof raw === 'object' && !Array.isArray(raw) ? object(raw) : null;
    const measured = key === 'size' && probe?.value && typeof probe.value === 'object' && !Array.isArray(probe.value) ? object(probe.value) : null;
    return <section className="live-source-card" key={key}><h3>{label}</h3><dl><Field label={t('Status')}><Value value={probe?.state} /></Field>{measured && typeof measured.bytes === 'number' ? <Field label={l('Size measurement')}>{measured.quality === 'lower_bound' ? t('At least {size} · lower bound', { size: size(measured.bytes) }) : measured.quality === 'complete' ? size(measured.bytes) : l('Unknown measurement')}</Field> : probe && <Field label={t('Result')}><Value value={probe.value} /></Field>}{probe?.reason !== undefined && <Field label={t('Observations')}><Value value={probe.reason} /></Field>}{probe?.code !== undefined && <Field label={t('Identifier')}><Value value={probe.code} /></Field>}</dl><Raw value={raw} /></section>;
  })}<Raw value={value} title={l('Coverage and provenance')} /></>;
}
/** Retained source evidence stays readable prose; technical details and omission counts remain folded. */
function Evidence({ value }: { value: unknown }) {
  const { l } = useLiveLocale();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return <Value value={value} />;
  const evidence = object(value); const items = Array.isArray(evidence.items) ? evidence.items : [];
  return <><ul className="plan-list">{items.map((item, index) => <li key={index}><Value value={item} /></li>)}</ul>{evidence.truncated === true && <p className="muted">{l('Coverage is incomplete or unknown')}</p>}<Raw value={evidence} title={l('Source evidence')} /></>;
}
/** Reads saved per-outcome estimates with the report's own plan revision and verified clock semantics. */
function ProjectDetail({ props, common }: { props: LiveSectionProps; common: string }) {
  const { t, l, datetime, percent, n } = useLiveLocale(); const repository = props.index.repositories.find(row => row.id === common);
  const snapshot = useObservation(repository ? { resource: 'tasks.peek', params: { repository: repository.path } } : null, props.refresh, true, true, value => tasksData(value, common));
  const data = snapshot.good ? tasksData(snapshot.good.data, common) : null;
  const plan = data?.plan ? object(data.plan) : null; const report = data?.report ? object(data.report) : null;
  const coverage = report ? object(report.coverage) : null;
  const reportPlan = report ? object(report.plan) : null; const analysis = report ? object(report.analysis) : null;
  const observed = reportObserved(report?.observed_at), completed = reportCompleted(report?.completed_at);
  const mismatch = plan !== null && reportPlan !== null && JSON.stringify(plan.revision) !== JSON.stringify(reportPlan.revision);
  return <Detail title={repository?.label ?? basename(common)} source="Agent Tasks" props={props}><p className="muted">{l('Only retained plans/reports are read. No analysis or project check is launched.')}</p>{!repository && <p>{l('No confirmed repository')}</p>}<SourceNotice state={snapshot} />{data && <><dl><Field label={l('Repository identity')}>{common}</Field><Field label={l('Plan state')}>{data.plan_state === 'saved' ? t('Saved plan') : l('No retained source value')}</Field><Field label={l('Report state')}>{data.report_state === 'saved' ? t('Saved result') : l('No retained source value')}</Field><Field label={l('Current plan revision')}><Value value={plan?.revision} /></Field><Field label={l('Report plan revision')}><Value value={reportPlan?.revision} /></Field><Field label={l('Saved report observed')}>{observed ? datetime(observed) : l('Source timestamp not reported')}</Field><Field label={l('Saved report completed')}>{completed ? datetime(completed) : l('Source timestamp not reported')}</Field></dl>
    {mismatch && <div className="state-banner warning" role="status">{l('The current plan differs from the saved report plan; their outcomes are not merged.')}</div>}
    {data.pending !== null && <div className="inline-note"><Clock3 size={18} /><div><strong>{l('Pending source work')}</strong><p>{l(object(data.pending).state === 'accepted' ? 'Pending receipt is recorded; current execution has not been checked.' : object(data.pending).state === 'admission_unknown' ? 'Pending admission is unknown; acceptance is not asserted.' : 'Retained analysis is terminal; current execution has not been checked.')}</p><Raw value={data.pending} /></div></div>}
    <Panel title={t('Saved plan')}><div className="live-panel-body">{plan ? <><h3>{String(plan.goal)}</h3><ol className="plan-list">{Array.isArray(plan.outcomes) && plan.outcomes.map(value => { const outcome = object(value); return <li key={String(outcome.id)}>{String(outcome.text)}</li>; })}</ol><Raw value={plan} /></> : <p>{l('No retained source value')}</p>}</div></Panel>
    <Panel title={l('Original source report and dates')}><div className="live-panel-body"><p className="muted">{l('Retained source estimate, not current execution progress.')}</p>{analysis && Array.isArray(analysis.outcomes) ? analysis.outcomes.map((value, index) => { const outcome = object(value); const state = outcome.state === 'no_evidence' ? l('No evidence') : outcome.state === 'in_progress' ? t('In progress') : outcome.state === 'implemented' ? l('Implemented') : l('Uncertain'); return <article className="message" key={String(outcome.id)}><header><strong>{text(outcome.title) ?? l('Outcome {number}', { number: n(index + 1) })}</strong><span>{state}</span></header><p>{String(outcome.summary)}</p><dl><Field label={t('Approximate plan progress')}>{number(outcome.progress_percent) === null ? t('No information') : percent(Number(outcome.progress_percent))}</Field>{outcome.remaining !== null && <Field label={l('Remaining work')}><Value value={outcome.remaining} /></Field>}</dl><Evidence value={outcome.evidence} /></article>; }) : <p>{l('No retained source value')}</p>}
    {analysis && Array.isArray(analysis.findings) && analysis.findings.length > 0 && <><h3>{l('Source findings')}</h3>{analysis.findings.map((value, index) => { const finding = object(value); return <article className="message" key={index}><p><Value value={finding.text} /></p><Evidence value={finding.evidence} /></article>; })}</>}{coverage && <><h3>{t('Coverage')}</h3><dl><Field label={l('Runtime coverage')}>{coverage.runtime_complete === true ? l('Complete reported coverage') : coverage.runtime_complete === false ? l('Coverage is incomplete or unknown') : t('No information')}</Field></dl><h3>{l('Git omissions')}</h3><Evidence value={coverage.git_omissions} /><h3>{l('Runtime omissions')}</h3><Evidence value={coverage.runtime_omissions} /></>}{report && <Raw value={report} title={l('Saved Tasks snapshot')} />}</div></Panel></>}
    <h3>{l('Related loaded agents')}</h3><Coverage inventory={props.index.run} />{props.index.run.page && props.index.run.page.items.filter(agent => longestWorktree(agent.workdir, props.index.worktrees.page?.items ?? [])?.common === common).length === 0 && <p className="muted">{l('No confirmed related agents in loaded coverage.')}</p>}{props.index.run.page?.items.filter(agent => longestWorktree(agent.workdir, props.index.worktrees.page?.items ?? [])?.common === common).map(agent => <button className="member-row" key={agent.id} data-focus-key={'agents:run:' + agent.id} onClick={() => props.open('agents', 'run:' + agent.id)}><Bot size={18} /><span><strong>{taskName(agent, l('Unnamed task'))}</strong><span className="muted">{lifecycleLabel(agent.status, t, l)}</span></span><ChevronRight size={16} /></button>)}<h3>{t('Related objects')}</h3>{props.index.worktrees.page?.items.filter(tree => tree.common === common).map(tree => <button key={tree.key} className="member-row" data-focus-key={'worktrees:wt:' + tree.key} onClick={() => props.open('worktrees', 'wt:' + tree.key)}><GitBranch size={18} /><span><strong title={tree.path}>{basename(tree.path)}</strong><span className="muted">{tree.branch ?? t('No information')}</span></span><ChevronRight size={16} /></button>)}
  </Detail>;
}
/** Legacy and standalone source inventories remain independently paginated and labelled. */
function Pools({ props }: { props: LiveSectionProps }) {
  const { t, l } = useLiveLocale();
  const legacy = useInventory({ resource: 'run.pools', params: { limit: 200, offset: 0 } }, legacyPoolPage, offset => ({ offset }), row => String(row.pool_id), props.refresh, true);
  const standalone = useInventory({ resource: 'pool.list', params: {} }, poolPage, after => ({ after }), row => String(object(row.pool).pool_id), props.refresh, true);
  if (props.selected) {
    if (props.selected.id.startsWith('runpool:')) return <LegacyPool props={props} poolId={props.selected.id.slice(8)} metadata={legacy.page?.items.find(row => row.pool_id === props.selected?.id.slice(8)) ?? null} />;
    if (props.selected.id.startsWith('pool:')) return <StandalonePool props={props} poolId={props.selected.id.slice(5)} />;
    return <Detail title={l('Missing')} source="Agent Pool" props={props}><p>{l('Unsupported producer projection')}</p></Detail>;
  }
  return <><p className="muted">{l('No repository binding is reported for these pools; project scope is not inferred.')}</p><Panel title={l('Standalone Agent Pool')}><div className="live-panel-body"><Coverage inventory={standalone} /></div>{standalone.page?.items.filter(row => JSON.stringify(row.pool).toLocaleLowerCase().includes(props.query.toLocaleLowerCase())).map(row => { const pool = object(row.pool); return <button className="object-row" key={String(pool.pool_id)} data-focus-key={'pools:pool:' + pool.pool_id} onClick={() => props.open('pools', 'pool:' + pool.pool_id)}><span className="object-body"><strong>{String(pool.name)}</strong><span className="muted">{String(pool.purpose)}</span><Badge variant="outline" className="source-badge">Agent Pool</Badge></span><span className="object-state">{l(pool.closed === true ? 'Closed' : 'Open')}</span><ChevronRight size={17} /></button>; })}</Panel><Panel title={l('Legacy Run pool')}><div className="live-panel-body"><Coverage inventory={legacy} /></div>{legacy.page?.items.filter(row => String(row.goal).toLocaleLowerCase().includes(props.query.toLocaleLowerCase())).map(row => <button className="object-row" key={String(row.pool_id)} data-focus-key={'pools:runpool:' + row.pool_id} onClick={() => props.open('pools', 'runpool:' + row.pool_id)}><span className="object-body"><strong>{String(row.goal)}</strong><span className="muted">{t('Agent Run · legacy pools')}</span></span><span className="object-state"><Value value={row.state} /></span><ChevronRight size={17} /></button>)}</Panel><p className="muted">{l('Source histories remain separate.')}</p></>;
}
/** Legacy Run logs have their own ordered cursors, current votes, agreement and delivery semantics. */
function LegacyPool({ props, poolId, metadata }: { props: LiveSectionProps; poolId: string; metadata: Record<string, unknown> | null }) {
  const { t, l, n } = useLiveLocale();
  const [paging, setPaging] = useState({ before: false, cursor: 0 });
  const state = useObservation({ resource: 'run.pool', params: { pool_id: poolId, limit: 50, ...(paging.before ? { before_seq: paging.cursor } : { after_seq: paging.cursor }) } }, props.refresh, true, true, value => legacyPoolDetail(value, poolId));
  const data = state.good ? legacyPoolDetail(state.good.data, poolId) : null;
  const status = data ? object(data.status) : null;
  const delivery = data ? object(data.delivery) : null;
  const entries = data && Array.isArray(data.entries) ? data.entries.map(object) : [];
  const members = status && Array.isArray(status.members) ? status.members.map(object) : [];
  const next = number(data?.next_cursor);
  return <Detail title={text(status?.goal) ?? text(metadata?.goal) ?? l('Legacy Run pool')} source={t('Agent Run · legacy pools')} props={props}><SourceNotice state={state} /><p>{l('Source histories remain separate.')}</p><p className="muted">{l('No historical source timestamp is reported for this observation.')}</p><dl><Field label={t('Identifier')}>{poolId}</Field><Field label={t('Pool state')}><Value value={status?.state} /></Field><Field label={l('Activity')}><Value value={data?.activity} /></Field><Field label={l('Agreement')}><Value value={status?.agreed} /></Field><Field label={l('Delivery state')}><Value value={delivery?.state} /></Field><Field label={l('Ambiguous delivery')}><Value value={delivery?.ambiguous} /></Field></dl>
    <Tabs value={props.tab || 'members'} onValueChange={props.onTab} className="detail-tabs"><TabsList aria-label={t('Pool information')}><TabsTrigger value="members">{t('Members')}</TabsTrigger><TabsTrigger value="discussion">{t('Discussion')}</TabsTrigger><TabsTrigger value="decisions">{t('Decisions')}</TabsTrigger><TabsTrigger value="deliveries">{t('Deliveries')}</TabsTrigger></TabsList>
      <TabsContent value="members">{members.map((member, index) => <div className="member-row" key={String(member.slot ?? index)}><span><strong>{String(member.name)}</strong><span className="muted"><Value value={member.role} /> · <Value value={member.tip_status} /></span></span>{typeof member.agent_id === 'string' && <button className="text-link" data-focus-key={'agents:run:' + member.agent_id} onClick={() => props.open('agents', 'run:' + member.agent_id)}>Agent Run<ArrowRight size={14} /></button>}</div>)}<Raw value={status?.replaced_members} /></TabsContent>
      <TabsContent value="discussion">{entries.map(entry => <article className="message" key={String(entry.seq)}><header><strong>{entry.author_kind === 'member' ? text(entry.author_name) ?? t('No information') : entry.author_kind === 'operator' ? l('Operator') : 'Agent Run'}</strong><span>{n(integer(entry.seq))} · {String(entry.kind)}</span></header><Value value={entry.body} /><Raw value={entry} /></article>)}</TabsContent>
      <TabsContent value="decisions"><p className="muted">{l('Votes are source decisions, never inferred from execution status.')}</p><dl><Field label={t('Accepted decision')}><Value value={status?.current_proposal} /></Field><Field label={t('Coverage')}><Value value={status?.criteria} /></Field></dl>{members.map(member => <div className="vote-row" key={String(member.slot ?? member.agent_id)}><strong>{String(member.name)}</strong><dl><Field label={l('Source vote')}><Value value={member.vote} /></Field><Field label={l('Vote counts')}><Value value={member.counts} /><Value value={member.why} /></Field></dl></div>)}<p>{l('Decision acceptance does not imply pool closure or execution completion.')}</p></TabsContent>
      <TabsContent value="deliveries"><Value value={delivery} /><p className="muted">{t('An accepted delivery does not mean the agent has finished.')}</p></TabsContent>
    </Tabs>{data && <><p className="muted">{l(data.complete === true ? 'Complete reported coverage' : 'Coverage is incomplete or unknown')}</p>{next !== null && <Button variant="outline" onClick={() => setPaging({ before: paging.before, cursor: next })}>{l(paging.before ? 'Earlier source page' : 'Next source page')}</Button>}{entries.length > 0 && integer(entries[0].seq) > 1 && !paging.before && <Button variant="outline" onClick={() => setPaging({ before: true, cursor: integer(entries[0].seq) })}>{l('Earlier source page')}</Button>}{paging.before && entries.length > 0 && <Button variant="outline" onClick={() => setPaging({ before: false, cursor: integer(entries[entries.length - 1].seq) })}>{l('Newer source page')}</Button>}<Raw value={data} title={t('Technical metadata')} /></>}
  </Detail>;
}
/** Standalone Pool pages fence mutable continuations with the source's first-page pool revision. */
function StandalonePool({ props, poolId }: { props: LiveSectionProps; poolId: string }) {
  const { t, l } = useLiveLocale();
  const section = props.tab === 'discussion' ? 'history' : props.tab === 'decisions' ? 'decisions' : props.tab === 'deliveries' ? 'deliveries' : 'members';
  const overview = useObservation({ resource: 'pool.get', params: { pool_id: poolId, section: 'overview' } }, props.refresh, true, true, value => { const row = poolDetail(value); if (row.view && object(object(row.view).pool).pool_id !== poolId) throw new Error('pool_attribution'); });
  const [paging, setPaging] = useState({ section, after: 0, revision: null as number | null });
  const active = paging.section === section ? paging : { section, after: 0, revision: null };
  const params = { pool_id: poolId, section, after: active.after, ...(section === 'members' ? { include_bindings: true } : {}), ...(active.after > 0 && ['members', 'votes', 'overview'].includes(section) && active.revision !== null ? { expected_revision: active.revision } : {}) };
  const state = useObservation({ resource: 'pool.get', params }, props.refresh, true, true, value => { const row = poolDetail(value); if (row.section !== section || (row.view && object(object(row.view).pool).pool_id !== poolId) || (row.view && active.after > 0 && ['members', 'votes', 'overview'].includes(section) && object(object(row.view).pool).revision !== active.revision)) throw new Error('pool_attribution'); });
  const data = state.good ? poolDetail(state.good.data) : null;
  const view = data?.view ? object(data.view) : null;
  const overviewData = overview.good ? poolDetail(overview.good.data) : null;
  const overviewView = overviewData?.view ? object(overviewData.view) : null;
  const pool = view ? object(view.pool) : overviewView ? object(overviewView.pool) : null;
  useEffect(() => { if (pool && active.after === 0 && active.revision !== integer(pool.revision)) setPaging({ section, after: 0, revision: integer(pool.revision) }); }, [state.good, section]);
  let cursorIssue = false;
  let next = view && view.has_more === true ? number(view.next_after) : null;
  if (section === 'decisions' && data?.has_more === true) { try { next = decimalCursor(data.cursor); } catch { cursorIssue = true; } }
  const members = view && Array.isArray(view.members) ? view.members.map(object) : [];
  const bindings = data && Array.isArray(data.bindings) ? data.bindings.map(object) : [];
  const proposal = pool?.proposal ? object(pool.proposal) : null;
  return <Detail title={text(pool?.name) ?? l('Standalone Agent Pool')} source="Agent Pool" props={props}><SourceNotice state={overview} /><SourceNotice state={state} /><p className="muted">{l('No historical source timestamp is reported for this observation.')}</p><dl><Field label={l('Goal')}><Value value={pool?.purpose} /></Field><Field label={l('Leader')}><Value value={null} /></Field><Field label={t('Identifier')}><Value value={data?.leader_id ?? overviewData?.leader_id} /></Field><Field label={t('Pool state')}>{pool ? l(pool.closed === true ? 'Closed' : 'Open') : t('No information')}</Field></dl>
    <Tabs value={props.tab || 'members'} onValueChange={value => { setPaging({ section: value === 'discussion' ? 'history' : value === 'decisions' ? 'decisions' : value === 'deliveries' ? 'deliveries' : 'members', after: 0, revision: null }); props.onTab(value); }} className="detail-tabs"><TabsList aria-label={t('Pool information')}><TabsTrigger value="members">{t('Members')}</TabsTrigger><TabsTrigger value="discussion">{t('Discussion')}</TabsTrigger><TabsTrigger value="decisions">{t('Decisions')}</TabsTrigger><TabsTrigger value="deliveries">{t('Deliveries')}</TabsTrigger></TabsList>
      <TabsContent value="members">{members.map(member => {
        const binding = bindings.find(binding => { const source = binding.member ? object(binding.member) : null; return source?.member_id === member.member_id; });
        const linked = binding && typeof binding.run_id === 'string' && typeof binding.run_sequence === 'number' ? props.index.run.page?.items.find(agent => agent.id === binding.run_id && agent.sequence === binding.run_sequence) : null;
        return <div className="member-row" key={String(member.member_id)}><span><strong>{text(member.name) ?? t('No information')}</strong><span className="muted"><Value value={member.role} /> · {member.state === 'active' ? l('Active') : member.state === 'pending' ? l('Pending') : member.state === 'removed' ? l('Removed') : <Value value={member.state} />}</span><span><Value value={member.task} /></span><span className="muted">{linked ? null : binding?.run_id ? l('Run binding is outside loaded execution coverage') : l('Native-only member · no Run binding')}</span></span>{binding && typeof binding.run_id === 'string' && typeof binding.run_sequence === 'number' && <button className="text-link" data-focus-key={'agents:run:' + binding.run_id + ':sequence:' + binding.run_sequence} onClick={() => props.open('agents', 'run:' + binding.run_id, binding.run_sequence as number)}>Agent Run · {String(binding.run_sequence)}<ArrowRight size={14} /></button>}</div>;
      })}</TabsContent>
      <TabsContent value="discussion">{view && Array.isArray(view.events) && view.events.map(value => { const event = object(value); return <article className="message" key={String(event.event_id)}><header><Value value={event.author} /></header><Value value={event.body} /><Raw value={event} /></article>; })}</TabsContent>
      <TabsContent value="decisions"><p className="muted">{l('Votes are source decisions, never inferred from execution status.')}</p>{proposal ? <><dl><Field label={l('Current proposal')}>{proposal.state === 'accepted' ? t('Accepted decision') : proposal.state === 'open' ? l('Open') : t('Information is stale')}</Field><Field label={t('Result')}><Value value={proposal.result} /></Field></dl>{Object.entries(object(proposal.votes)).map(([memberId, value]) => { const vote = object(value); return <div className="vote-row" key={memberId}><strong>{text(members.find(member => member.member_id === memberId)?.name) ?? memberId}</strong><Badge variant="outline" className="vote-label">{vote.choice === 'ready' ? t('Ready for acceptance') : vote.choice === 'block' ? t('Objection') : vote.choice === 'revoke' ? l('Withdrawn') : t('No information')}</Badge><Value value={vote.evidence} /></div>; })}<Raw value={proposal} /></> : <p>{t('No information')}</p>}<p className="muted">{l('Decision acceptance does not imply pool closure or execution completion.')}</p>{data && Array.isArray(data.decisions) && data.decisions.length > 0 && <Raw value={data.decisions} title={t('Decisions')} />}</TabsContent>
      <TabsContent value="deliveries">{view && Array.isArray(view.deliveries) && view.deliveries.map(value => { const delivery = object(value); return <div className="member-row" key={String(delivery.operation_id)}><span><strong>{String(delivery.operation)}</strong><Value value={delivery.state} /></span><Raw value={delivery} /></div>; })}<p className="muted">{t('An accepted delivery does not mean the agent has finished.')}</p></TabsContent>
    </Tabs>{cursorIssue && <p role="status">{l('Cursor exceeds the supported safe integer range.')}</p>}{next !== null && next > active.after && <Button variant="outline" onClick={() => setPaging({ section, after: next, revision: active.revision })}>{l('Next source page')}</Button>}{state.response && !usable(state.response) && active.after > 0 && <Button variant="outline" onClick={() => setPaging({ section, after: 0, revision: null })}>{l('Restart source page')}</Button>}{data && <Raw value={data} title={t('Technical metadata')} />}</Detail>;
}
/** Supported identity payloads remain installation/source metadata rather than global health claims. */
function identityData(source: string, value: unknown): Record<string, unknown> {
  if (source === 'run') return object(value);
  if (source === 'ide') { const row = object(value); if (row.read_only !== true) throw new Error('ide_read_only'); return row; }
  return product(value, source === 'tasks' ? 'product_identity' : 'identity');
}
/** Product names are stable branding, not translated IDs or fabricated version labels. */
const sources = [{ id: 'run', name: 'Agent Run' }, { id: 'pool', name: 'Agent Pool' }, { id: 'worktree', name: 'Agent Worktree' }, { id: 'bridge', name: 'Agent Bridge' }, { id: 'tasks', name: 'Agent Tasks' }, { id: 'ide', name: 'Agent IDE' }] as const;
/** A visible tool's identity read never turns availability/version into an invented daemon-health claim. */
function SourceCard({ source, props, compact = false }: { source: typeof sources[number]; props: LiveSectionProps; compact?: boolean }) {
  const { l } = useLiveLocale();
  const state = useObservation({ resource: (source.id + '.identity') as Resource, params: {} }, props.refresh, false, true, value => identityData(source.id, value));
  const data = state.good ? identityData(source.id, state.good.data) : null;
  const outcome = state.response?.outcome;
  const summary = state.loading ? l('Loading source observations') : outcome === 'ok' ? l('Read observation received') : outcome === 'partial' ? l('Partial source response') : outcome === 'incompatible' ? l('Incompatible') : outcome === 'missing' ? l('Missing') : outcome === 'invalid' ? l('Invalid response') : l('Unavailable');
  return <div className="live-source-card"><button className="member-row" data-focus-key={'tools:' + source.id} onClick={() => props.open('tools', source.id)}><span><strong>{source.name}</strong><span className="muted">{text(data?.version) ?? text(data?.package_version) ?? l('Version unknown')}</span></span><ChevronRight size={17} /></button>{compact ? <p className="muted">{summary}</p> : <SourceNotice state={state} />}{!compact && source.id === 'ide' && <p className="muted">{l('Installation diagnostics only; daemon health is not inferred.')}</p>}</div>;
}
/** Cached Run windows and compatibility have first-class fields; technical routing stays folded. */
function RunTool({ props }: { props: LiveSectionProps }) {
  const { t, l, duration, percent, datetime } = useLiveLocale();
  const identity = useObservation({ resource: 'run.identity', params: {} }, props.refresh, false, true, object);
  const limits = useObservation({ resource: 'run.limits', params: {} }, props.refresh, true, true, limitsData);
  const models = useObservation({ resource: 'run.models', params: {} }, props.refresh, false, true, modelsData);
  const windows = limits.good ? limitsData(limits.good.data).items as unknown[] : [];
  const catalog = models.good ? modelsData(models.good.data) : null;
  const now = Date.now() / 1000;
  return <Detail title="Agent Run" source="Agent Run" props={props}><SourceNotice state={identity} />{identity.good && <IdentityFields source="run" value={identity.good.data} />}
    <Panel title={l('Cached provider limits')}><div className="live-panel-body"><SourceNotice state={limits} />{windows.map((value, index) => {
      const window = object(value), key = object(window.key); const observed = number(window.observed_at), validUntil = number(window.valid_until), reset = iso(number(window.reset_at));
      const freshness = observed !== null && observed > now ? l('Source clock is ahead of the local clock') : validUntil === null ? l('Cache expiry unknown') : validUntil < now ? l('Cache expired') : l('Cached sample is within its source validity window');
      return <article className="message" key={index}><header><strong>{text(key.window) ?? l('Quota window')}</strong><span>{window.known === true ? l('Known cached window') : t('No information')}</span></header><dl><Field label={t('Source')}><Value value={key.source} /></Field><Field label={t('Model')}><Value value={key.target} /></Field><Field label={l('Remaining quota')}>{window.known === true && number(window.remaining_percent) !== null ? percent(Number(window.remaining_percent)) : t('No information')}</Field><Field label={l('Reset time')}>{reset ? datetime(reset) : t('No information')}</Field><Field label={l('Freshness')}>{window.known === true ? freshness : t('No information')}</Field><Field label={l('Sample age')}>{observed === null ? t('No information') : observed > now ? l('Source clock is ahead of the local clock') : duration((now - observed) * 1000)}</Field></dl><SourceTime value={observed} /><Raw value={window} /></article>;
    })}{limits.good && windows.length === 0 && <p>{l('No records in the reported coverage')}</p>}{limits.good && <Raw value={limits.good.data} />}</div></Panel>
    <Panel title={l('Model compatibility')}><div className="live-panel-body"><SourceNotice state={models} />{models.rejected && <p>{l('Unsupported producer projection')}</p>}<p className="muted">{l('Source model cache, not authorization to launch a model.')}</p>{catalog && <><SourceTime value={number(catalog.ranked_at)} />{(catalog.providers as unknown[]).map(value => { const provider = object(value); return <section className="live-source-card" key={String(provider.provider)}><h3>{String(provider.provider)}</h3>{(provider.models as unknown[]).map(value => { const model = object(value), quota = object(model.quota); return <article className="message" key={String(model.model)}><header><strong>{String(model.model)}</strong><span>{quota.status === 'available' ? l('Quota available in cached evidence') : quota.status === 'exhausted' ? l('Quota exhausted in cached evidence') : quota.status === 'no_eligible_account' ? l('No eligible account in cached evidence') : quota.status === 'priority_overflow' ? l('Priority overflow in cached evidence') : t('No information')}</span></header><dl><Field label={l('Compatible profiles')}>{(model.profiles as string[]).join(', ') || t('No information')}</Field><Field label={l('Freshness')}>{quota.evidence === 'fresh' ? l('Evidence was fresh at its source observation') : quota.evidence === 'stale' ? t('Information is stale') : t('No information')}</Field></dl><SourceTime value={number(quota.newest_observed_at)} /><Raw value={model} /></article>; })}<Raw value={provider} /></section>; })}<Raw value={catalog} /></>}</div></Panel>
  </Detail>;
}
/** Basic identity fields remain readable while unknown build/installation fields stay explicitly unknown. */
function IdentityFields({ source, value }: { source: string; value: unknown }) {
  const { t, l } = useLiveLocale(); const data = identityData(source, value);
  return <><dl><Field label={t('Source')}>{sources.find(item => item.id === source)?.name ?? source}</Field><Field label={t('Version')}>{text(data.version) ?? text(data.package_version) ?? l('Version unknown')}</Field></dl>{source === 'ide' && <p>{l('Installation diagnostics only; daemon health is not inferred.')}</p>}<Raw value={data} /></>;
}
/** Exact retained Bridge counters stay separate; accepted is not execution or comprehension success. */
function BridgeCounts({ data }: { data: Record<string, unknown> }) {
  const { l, n, datetime } = useLiveLocale(); const counts = object(data.counts), retention = object(data.retention);
  const fields: [string, LiveKey][] = [['unhanded', 'Never handed to a path'], ['reserved', 'Reserved attempt, not invoked'], ['invoking', 'Invocation may have handed off'], ['held', 'Held or written without receipt'], ['review', 'Possible handoff under review'], ['accepted', 'Accepted by native queue or inbox'], ['hook_submitted', 'Hook payload handed out'], ['refused', 'Permanently refused before acceptance'], ['disposed', 'Closed by audited disposition'], ['open_incidents', 'Current open incidents']];
  const oldest = iso(number(retention.oldest_accepted_at_ms), true), newest = iso(number(retention.newest_accepted_at_ms), true);
  return <><p className="muted">{l('These categories are not summed into an all-time success total.')}</p><dl className="live-counts">{fields.map(([key, label]) => <Field key={key} label={l(label)}><strong>{n(integer(counts[key]))}</strong></Field>)}</dl><dl><Field label={l('Oldest retained acceptance')}>{oldest ? datetime(oldest) : l('Source timestamp not reported')}</Field><Field label={l('Newest retained acceptance')}>{newest ? datetime(newest) : l('Source timestamp not reported')}</Field></dl><Raw value={data} title={l('Coverage and provenance')} /></>;
}
/** Bridge diagnostics keep each source tab inside its labelled panel; paging and evidence tiers remain independent. */
function BridgeTool({ props }: { props: LiveSectionProps }) {
  const { t, l } = useLiveLocale(); const tab = props.tab || 'overview';
  const [paging, setPaging] = useState({ tab, after: 0, through: null as number | null });
  const active = paging.tab === tab ? paging : { tab, after: 0, through: null };
  const resource: Resource = tab === 'deliveries' ? 'bridge.deliveries' : tab === 'incidents' ? 'bridge.incidents' : 'bridge.overview';
  const kind = tab === 'deliveries' ? 'delivery_page' : tab === 'incidents' ? 'incident_page' : 'bridge_overview';
  const state = useObservation({ resource, params: tab === 'overview' ? {} : { limit: 100, after_seq: active.after, ...(active.through === null ? {} : { through_seq: active.through }), ...(tab === 'incidents' ? { include_closed: false } : {}) } }, props.refresh, true, true, value => bridgeData(value, kind));
  const data = state.good ? bridgeData(state.good.data, kind) : null;
  const next = number(data?.next_after_seq);
  useEffect(() => { if (data && tab !== 'overview' && active.through === null && number(data.through_seq) !== null) setPaging({ tab, after: active.after, through: integer(data.through_seq) }); }, [state.good, tab]);
  const rows = data && Array.isArray(data[tab]) ? (data[tab] as unknown[]).map(object) : [];
  const content = <><SourceNotice state={state} />{tab === 'overview' ? data && <BridgeCounts data={data} /> : <>{rows.map(row => <div className="live-source-card" key={String(row.acceptance_seq ?? row.incident_seq)}><dl><Field label={t('Identifier')}><Value value={row.event_id} /></Field>{tab === 'deliveries' ? <><Field label={l('Custody')}><Value value={row.custody_state} /></Field><Field label={l('Delivery state')}><Value value={row.delivery_state} /></Field><Field label={l('Evidence tiers')}><Value value={row.evidence_tiers} /></Field></> : <Field label={t('Status')}><Value value={row.state} /></Field>}</dl><Raw value={row} /></div>)}{next !== null && next > active.after && (active.through === null || next < active.through) && <Button variant="outline" onClick={() => setPaging({ tab, after: next, through: active.through })}>{l('Next source page')}</Button>}</>}{data && <Raw value={data} />}</>;
  return <Detail title="Agent Bridge" source="Agent Bridge" props={props}><p>{l('Retained diagnostic history, not all-time totals.')}</p><p className="muted">{l('Delivery tiers are distinct; unknown is not failure.')}</p><Tabs value={tab} onValueChange={value => { setPaging({ tab: value, after: 0, through: null }); props.onTab(value); }} className="detail-tabs"><TabsList aria-label="Agent Bridge"><TabsTrigger value="overview">{t('Overview')}</TabsTrigger><TabsTrigger value="deliveries">{t('Deliveries')}</TabsTrigger><TabsTrigger value="incidents">{l('Incidents')}</TabsTrigger></TabsList>{['overview', 'deliveries', 'incidents'].map(value => <TabsContent key={value} value={value}>{value === tab ? content : null}</TabsContent>)}</Tabs></Detail>;
}
/** IDE reads installation diagnostics and retained repository snapshots; it never launches a check. */
function IdeTool({ props }: { props: LiveSectionProps }) {
  const { t, l, datetime, n } = useLiveLocale();
  const configured = Array.isArray(props.index.connections?.repositories) ? props.index.connections.repositories.filter((value): value is string => typeof value === 'string' && value.startsWith('/')) : [];
  const options = [...new Set([...props.index.repositories.map(row => row.path), ...configured])];
  const [chosen, setChosen] = useState(''); const repository = chosen || options[0] || ''; const [cursor, setCursor] = useState<number | null>(null);
  const identity = useObservation({ resource: 'ide.identity', params: {} }, props.refresh, false, true, value => identityData('ide', value));
  const state = useObservation(repository ? { resource: 'ide.observe', params: { repository, ...(cursor === null ? {} : { cursor }) } } : null, props.refresh, true, true, ideData);
  const data = state.good ? ideData(state.good.data) : null;
  const checks = data ? object(data.checks) : null;
  return <Detail title="Agent IDE" source="Agent IDE" props={props}><p>{l('Installation diagnostics only; daemon health is not inferred.')}</p><SourceNotice state={identity} />{identity.good && <IdentityFields source="ide" value={identity.good.data} />}{options.length ? <Choice label={l('Repository observations')} value={repository} options={options.map(path => [path, path])} onChange={value => { setChosen(value); setCursor(null); }} /> : <p>{l('No confirmed repository')}</p>}<p className="muted">{l('Configured paths are not verified repository identities.')}</p><SourceNotice state={state} />{data && <><h3>{l('Instances')}</h3>{(data.instances as unknown[]).map((value, index) => { const instance = object(value); return <article className="message" key={String(instance.instance_id)}><header><strong>{l('Instance {number}', { number: n(index + 1) })}</strong><span>{instance.health === 'healthy' ? l('Healthy') : l('Unavailable')}</span></header><dl><Field label={l('Daemon version')}><Value value={instance.daemon_version} /></Field><Field label={l('Runtime coverage')}>{instance.runtime === 'private' ? l('Private runtime') : instance.runtime === 'unsafe' ? l('Unsafe runtime') : instance.runtime === 'missing' ? l('Missing runtime') : l('Unavailable')}</Field></dl><Raw value={instance} /></article>; })}<h3>{l('Retained checks')}</h3><dl><Field label={t('Status')}><Value value={checks?.availability} /></Field></dl>{checks && Array.isArray(checks.snapshots) && checks.snapshots.map(value => { const snapshot = object(value); const stamp = iso(number(snapshot.observed_at_ms), true); return <div className="live-source-card" key={String(snapshot.snapshot_id)}><dl><Field label={t('Identifier')}><Value value={snapshot.snapshot_id} /></Field><Field label={l('Path')}><Value value={snapshot.source_path} /></Field><Field label={t('Status')}><Value value={snapshot.state} /></Field><Field label={l('Freshness')}>{snapshot.freshness === 'stale' ? t('Information is stale') : snapshot.freshness === 'unknown' ? t('No information') : <Value value={snapshot.freshness} />}</Field><Field label={t('Latest observation')}>{stamp ? datetime(stamp) : l('Source timestamp not reported')}</Field></dl><Raw value={snapshot} /></div>; })}{number(checks?.next_cursor) !== null && <Button variant="outline" onClick={() => setCursor(integer(checks?.next_cursor))}>{l('Next source page')}</Button>}<p>{l('Private instances may be outside this coverage.')}</p><Raw value={{ repository: data.repository, coverage: data.coverage, telemetry: data.telemetry }} title={l('Coverage and provenance')} /></>}</Detail>;
}
/** Other identities retain typed failures or source data with no fabricated service success/version. */
function IdentityTool({ props, source }: { props: LiveSectionProps; source: typeof sources[number] }) {
  const state = useObservation({ resource: (source.id + '.identity') as Resource, params: {} }, props.refresh, false, true, value => identityData(source.id, value));
  return <Detail title={source.name} source={source.name} props={props}><SourceNotice state={state} />{state.good && <IdentityFields source={source.id} value={state.good.data} />}<Raw value={props.index.connections} /></Detail>;
}
/** Shared loaded-record filters stay visible on Overview and the full agent list. */
function RunFilters({ props }: { props: LiveSectionProps }) {
  const { t, l } = useLiveLocale();
  const statuses = [...new Set([...(props.index.run.page?.items.map(agent => agent.status) ?? []), ...(props.status === 'all' ? [] : [props.status])])];
  return <div className="filter-bar"><div><label>{t('Agent status')}</label><Choice label={t('Agent status')} value={props.status} options={[["all", t('All statuses')], ...statuses.map(status => [status, lifecycleLabel(status, t, l)] as [string, string])]} onChange={props.onStatus} /></div>{(props.status !== 'all' || props.scope !== 'all' || props.query.trim()) && <Button variant="ghost" onClick={props.reset}>{t('Reset filters')}</Button>}</div>;
}
/** Bounded accepted overview panels use loaded records and independent source lifecycle/answer evidence. */
function Overview({ props, rows }: { props: LiveSectionProps; rows: RunAgent[] }) {
  const { t, l, n, duration, datetime } = useLiveLocale();
  const known = props.index.run.page !== null;
  const attention = rows.filter(attentionAgent), working = rows.filter(agent => activeStatus(agent.status)), results = recentAnswers(rows);
  const all = <button className="text-link" onClick={props.showAgents}>{t('All agents')}<ArrowRight size={15} /></button>;
  return <div className="live-overview"><RunFilters props={props} /><Coverage inventory={props.index.run} compact /><div className="summary-strip"><div><div><strong>{known ? n(rows.length) : t('No information')}<span>{l('Loaded executions')}</span></strong></div></div><div><div><strong>{known ? n(working.length) : t('No information')}<span>{l('Active or pending')}</span></strong></div></div><div><div><strong>{known ? n(results.length) : t('No information')}<span>{l('Answers available')}</span></strong></div></div></div>
    <div className="overview-core"><Panel title={t('Needs attention')} extra={<span className="small-counter">{known ? n(attention.length) : t('No information')}</span>} className="attention-panel">{attention.slice(0, 3).map(agent => <button className="attention-row" key={agent.id} data-focus-key={'agents:run:' + agent.id} onClick={() => props.open('agents', 'run:' + agent.id)}><TriangleAlert size={20} /><span><strong title={taskName(agent, l('Unnamed task'))}>{taskName(agent, l('Unnamed task'))}</strong><span className="muted">{attentionAgent(agent) && !['failed', 'lost', 'timed_out'].includes(agent.status) ? l('Ambiguous delivery') : lifecycleLabel(agent.status, t, l)}</span></span><RunStatus value={agent.status} /><ChevronRight size={17} /></button>)}{attention.length === 0 && <p className="panel-empty">{known ? l('No attention items in loaded coverage.') : t('No information')}</p>}<div className="live-panel-body">{all}</div></Panel>
      <Panel title={t('Working now')} extra={all}>{working.slice(0, 4).map(agent => { const stamp = iso(agent.progress); return <button className="working-row" key={agent.id} data-focus-key={'agents:run:' + agent.id} onClick={() => props.open('agents', 'run:' + agent.id)}><Bot size={20} /><span className="row-main"><strong title={taskName(agent, l('Unnamed task'))}>{taskName(agent, l('Unnamed task'))}</strong><span className="muted">{lifecycleLabel(agent.status, t, l)} · {stamp ? l('Last transcript progress: {time}', { time: datetime(stamp) }) : l('Activity time not reported')}</span></span><span className="working-model">{agent.model ?? t('No information')}</span><span className="row-time">{duration(agent.elapsed === null ? null : agent.elapsed * 1000)}</span><ChevronRight size={16} /></button>; })}{working.length === 0 && <p className="panel-empty">{known ? l('No active executions in loaded coverage.') : t('No information')}</p>}</Panel>
    </div><div className="overview-bottom"><Panel title={t('Latest results')} extra={all}>{results.slice(0, 3).map(agent => { const terminal = iso(agent.finished), progress = iso(agent.progress); return <button className="result-row" key={agent.id} data-focus-key={'agents:run:' + agent.id} onClick={() => props.open('agents', 'run:' + agent.id)}><Check size={18} /><span><strong title={taskName(agent, l('Unnamed task'))}>{taskName(agent, l('Unnamed task'))}</strong><span className="muted">{l('Answers available')} · {terminal ? l('Terminal commit: {time}', { time: datetime(terminal) }) : progress ? l('Last transcript progress: {time}', { time: datetime(progress) }) : l('Activity time not reported')}</span></span><ChevronRight size={16} /></button>; })}{results.length === 0 && <p className="panel-empty">{known ? l('No answers available in loaded coverage.') : t('No information')}</p>}</Panel><Panel title={t('Information sources')}>{sources.map(source => <SourceCard key={source.id} source={source} props={props} compact />)}</Panel></div>
  </div>;
}
/** Reuses the existing shell, filters and full-screen navigation with real source-specific content. */
export function LiveSection(props: LiveSectionProps) {
  const { t, l, n, tag } = useLiveLocale(); const selected = props.selected;
  const rows = (props.index.run.page?.items ?? []).filter(agent => {
    const tree = longestWorktree(agent.workdir, props.index.worktrees.page?.items ?? []);
    return (props.scope === 'all' || tree?.common === props.scope) && (props.status === 'all' || agent.status === props.status) && [agent.name, agent.summary, agent.model, agent.workdir].filter(Boolean).join(' ').toLocaleLowerCase(tag).includes(props.query.toLocaleLowerCase(tag));
  });
  if (props.section === 'pools') return <>{!selected && <div className="page-heading"><h1 ref={props.heading} tabIndex={-1}>{t('Pools')}</h1></div>}<Pools props={props} /></>;
  if (selected?.kind === 'agents') return <RunDetail key={selected.id} props={props} agentId={selected.id.startsWith('run:') ? selected.id.slice(4) : selected.id} />;
  if (selected?.kind === 'worktrees') return <WorktreeDetail key={selected.id} props={props} tree={props.index.worktrees.page?.items.find(tree => 'wt:' + tree.key === selected.id) ?? null} />;
  if (selected?.kind === 'projects') return <ProjectDetail key={selected.id} props={props} common={selected.id.startsWith('repo:') ? selected.id.slice(5) : selected.id} />;
  if (selected?.kind === 'tools') { const source = sources.find(source => source.id === selected.id); return selected.id === 'run' ? <RunTool props={props} /> : selected.id === 'bridge' ? <BridgeTool props={props} /> : selected.id === 'ide' ? <IdeTool props={props} /> : source ? <IdentityTool props={props} source={source} /> : <Detail props={props} source="Agent Hub" title={l('Missing')}><p>{l('Unsupported producer projection')}</p></Detail>; }
  const labels: Record<Section, MessageKey> = { overview: 'Ecosystem overview', agents: 'Agents', pools: 'Pools', worktrees: 'Worktree', projects: 'Projects', tools: 'Tools' };
  return <><div className="page-heading"><div><div className="eyebrow">{l('Live read-only data')}</div><h1 ref={props.heading} tabIndex={-1}>{t(labels[props.section])}</h1><p>{l('Only loaded source records are counted. Lifecycle, answer and delivery remain independent.')}</p></div></div>
    {props.section === 'agents' ? <><RunFilters props={props} /><Coverage inventory={props.index.run} />{props.index.run.page && rows.length === 0 ? <div className="empty-state"><h2>{l(props.index.run.page.items.length ? 'No matches in loaded records' : 'No records in the reported coverage')}</h2>{props.index.run.page.items.length > 0 && <Button variant="outline" onClick={props.reset}>{t('Reset filters')}</Button>}</div> : <RunTable rows={rows} props={props} />}</>
      : props.section === 'worktrees' ? <><p>{l('Inventory does not inspect cleanliness or request sizes.')}</p><Coverage inventory={props.index.worktrees} /><div ref={props.list} className="records-list">{props.index.worktrees.page?.items.filter(tree => (props.scope === 'all' || tree.common === props.scope) && [tree.path, tree.branch, tree.common].join(' ').toLocaleLowerCase(tag).includes(props.query.toLocaleLowerCase(tag))).map(tree => <button className="object-row" key={tree.key} data-focus-key={'worktrees:wt:' + tree.key} onClick={() => props.open('worktrees', 'wt:' + tree.key)}><GitBranch size={21} /><span className="object-body"><strong title={tree.path}>{basename(tree.path)}</strong><span className="branch-label">{tree.branch ?? t('No information')}</span><span className="muted" title={tree.common}>{props.index.repositories.find(repo => repo.id === tree.common)?.label ?? l('No confirmed repository')}</span></span><ChevronRight size={17} /></button>)}</div></>
        : props.section === 'projects' ? <><p>{l('Repository grouping uses confirmed common-directory identity.')}</p><Coverage inventory={props.index.worktrees} /><div ref={props.list} className="records-list">{props.index.repositories.filter(repo => (props.scope === 'all' || props.scope === repo.id) && repo.id.toLocaleLowerCase(tag).includes(props.query.toLocaleLowerCase(tag))).map(repo => <button className="project-row" key={repo.id} data-focus-key={'projects:repo:' + repo.id} onClick={() => props.open('projects', 'repo:' + repo.id)}><span><strong title={repo.id}>{repo.label}</strong><span className="muted">{l('Loaded working copies: {count}', { count: n(props.index.worktrees.page?.items.filter(tree => tree.common === repo.id).length ?? 0) })}</span></span><ChevronRight size={17} /></button>)}</div><p className="muted">{l('Configured paths are not verified repository identities.')}</p><Raw value={props.index.connections?.repositories} title={l('Configured repository paths')} /></>
          : props.section === 'tools' ? <Panel title={t('Information sources')}>{sources.map(source => <SourceCard key={source.id} source={source} props={props} />)}</Panel>
            : <Overview props={props} rows={rows} />}
  </>;
}
