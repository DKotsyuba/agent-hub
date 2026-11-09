/** Read-only desktop console with source-specific native observations and explicitly selected demo fixtures. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { Activity, ArrowLeft, ArrowRight, Bot, Check, CheckCheck, ChevronRight, CircleHelp, Clock3, Copy, FileCheck2, FolderKanban, GitBranch, Layers3, LayoutDashboard, LoaderCircle, Monitor, Moon, RefreshCw, Search, Settings2, ShieldCheck, Sun, TriangleAlert, Unplug, Wrench, X } from 'lucide-react';
import { Button } from './components/ui/button';
import { Badge } from './components/ui/badge';
import { Input } from './components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './components/ui/tabs';
import { Choice, Panel, Field, Empty, activateRecordRow } from './components/hub-primitives';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from './components/ui/dialog';
import { agents, observed, pools, projects, statusLabels, tools, worktrees, demoMessages, messageTimes } from './demo';
import type { Agent, AgentStatus, Pool, Project, Tool, Worktree } from './demo';
import { useLocale } from './i18n';
import type { MessageKey } from './locales';
import { dataMode } from './live/native';
import { useLiveIndex } from './live/index';
import { LiveSection } from './live/LiveSection';
import { liveText } from './live/copy';
import type { LiveKey } from './live/copy';
import { longestWorktree, basename } from './live/protocol';

/** Supported top-level destinations, also used as address-bar fragments. */
type Section = 'overview' | 'agents' | 'pools' | 'worktrees' | 'projects' | 'tools';
/** One full content-area detail screen; related objects create actual history entries. */
type Selection = { kind: Exclude<Section, 'overview'>; id: string; /** Exact standalone Pool binding sequence, when navigation names a particular execution. */ sequence?: number } | null;
/** User-selected appearance; system tracks changes until explicitly overridden. */
type Theme = 'system' | 'light' | 'dark';
/** Fixture availability states, deliberately controlled rather than fetched. */
type Scenario = 'normal' | 'empty' | 'loading' | 'error' | 'stale' | 'partial';
/** One browser history entry owns its view, filters, tab, scroll and focus restoration. */
interface Screen {
  /** Unique entry identity; filter and tab updates retain it. */
  key: string;
  /** Number of preceding in-app screens; a direct detail URL starts at zero. */
  depth: number;
  /** Active sidebar destination. */
  section: Section;
  /** Null for a list/overview, otherwise the full-screen fixture detail. */
  selected: Selection;
  /** Shared project filter, including the all-projects value. */
  scope: string;
  /** Contextual list search, preserved while reading details. */
  query: string;
  /** Agent status filter, including all. */
  status: string;
  /** Synthetic availability condition. */
  scenario: Scenario;
  /** Controlled detail tab, empty on screens without tabs. */
  tab: string;
  /** Document vertical scroll in CSS pixels. */
  scroll: number;
  /** List viewport vertical scroll in CSS pixels. */
  listScroll: number;
  /** Stable data-focus-key of the control to restore, or heading fallback. */
  focus: string | null;
}
/** Typed feedback keeps a failed clipboard operation distinct from successful demo actions. */
interface Notice {
  /** Explicit UI copy key, rendered in the current locale and never inspected to infer severity. */
  message: MessageKey;
  /** Explicit action outcome controls both icon and announcement role. */
  severity: 'success' | 'warning';
}
/** Navigation metadata contains no management actions. */
const navigation = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'agents', label: 'Agents', icon: Bot },
  { id: 'pools', label: 'Pools', icon: Layers3 },
  { id: 'worktrees', label: 'Worktree', icon: GitBranch },
  { id: 'projects', label: 'Projects', icon: FolderKanban },
  { id: 'tools', label: 'Tools', icon: Wrench },
] as const;
/** Accessible fixture control labels shared by toolbar and settings. */
const scenarios: [string, MessageKey][] = [['normal', 'Default'], ['empty', 'Empty'], ['loading', 'Loading'], ['error', 'Disconnected'], ['stale', 'Stale'], ['partial', 'Partial']];
/** Descriptive introductions remain concise and specific to the selected section. */
const introductions: Record<Section, MessageKey> = {
  overview: 'What is happening across projects, in one calm overview.',
  agents: 'Tasks, latest activity and saved execution results.',
  pools: 'Members, discussions and decisions with their original sources.',
  worktrees: 'Project working copies and their last observed state.',
  projects: 'Saved plans, outcomes and related objects.',
  tools: 'Latest service observations, versions and quota windows.',
};

/** Addressable screen fragment; detail IDs are synthetic stable link keys. */
function screenHash(screen: Pick<Screen, 'section' | 'selected'>): string {
  return '#' + screen.section + (screen.selected ? '/' + encodeURIComponent(screen.selected.id) + (screen.selected.sequence === undefined ? '' : '?sequence=' + screen.selected.sequence) : '');
}
/** Restores the latest cached entry, falling back to saved history or a validated direct fragment. */
function screenFromLocation(snapshots?: Map<string, Screen>): Screen {
  /** Previously persisted entry, accepted only when its route matches the current address. */
  const stored = window.history.state?.agentHub as Screen | undefined;
  /** In-memory edits take precedence without rewriting browser history on input or scroll. */
  const saved = (stored?.key && snapshots?.get(stored.key)) || stored;
  if (saved?.key && navigation.some(item => item.id === saved.section) && screenHash(saved) === window.location.hash) return saved;
  /** A direct list/detail fragment contains only known section and fixture identifiers. */
  const [destination, detailFragment] = window.location.hash.slice(1).split('/');
  const [encodedId, detailQuery] = (detailFragment ?? '').split('?');
  const sequenceValue = new URLSearchParams(detailQuery).get('sequence');
  const sequence = sequenceValue !== null && /^\d+$/.test(sequenceValue) && Number.isSafeInteger(Number(sequenceValue)) ? Number(sequenceValue) : undefined;
  /** Producer IDs are opaque route values; malformed percent encoding is not accepted. */
  let id = '';
  try { id = decodeURIComponent(encodedId ?? ''); } catch { /* Invalid fragments resolve to the section list. */ }
  /** Unknown destinations resolve to the overview without inventing a detail record. */
  const section = navigation.find(item => item.id === destination)?.id ?? 'overview';
  /** Detail records must exist in their stated section. */
  const selected: Selection = section !== 'overview' && id && (sequenceValue === null || sequence !== undefined) ? { kind: section, id, ...(sequence === undefined ? {} : { sequence }) } : null;
  return { key: crypto.randomUUID(), depth: 0, section, selected, scope: 'all', query: '', status: 'all', scenario: 'normal', tab: section === 'agents' ? 'history' : section === 'pools' ? 'members' : '', scroll: 0, listScroll: 0, focus: null };
}
/** Reads only the interface preference; unavailable storage safely falls back to system. */
function savedTheme(): Theme {
  try { return (['light', 'dark', 'system'].includes(localStorage.getItem('agent-hub-theme') ?? '') ? localStorage.getItem('agent-hub-theme') : 'system') as Theme; }
  catch { return 'system'; }
}
/** Text and icon preserve state meaning without depending on color. */
function Status({ status }: { status: AgentStatus }) {
  /** Status labels follow the interface locale; status identifiers never change. */
  const { t } = useLocale();
  /** State-specific icon, never a completion percentage. */
  const Icon = { running: Activity, succeeded: CheckCheck, failed: TriangleAlert, unknown: CircleHelp }[status];
  return <Badge variant="outline" className={`status status-${status}`}><Icon size={14} aria-hidden="true" />{t(statusLabels[status])}</Badge>;
}
/** Compact initial mark associates a task with its project without hiding its readable name. */
function ProjectMark({ id }: { id: string }) {
  return <span className={`project-mark mark-${id}`} aria-hidden="true">{projects.find(project => project.id === id)?.name.replace('Agent ', '').slice(0, 1)}</span>;
}
/** Localized provenance label for stable source IDs; product names remain unchanged. */
function poolSource(pool: Pool): MessageKey { return pool.source === 'agent-pool' ? 'Agent Pool' : 'Agent Run · legacy pools'; }
/** Explicit collaboration states are independent of execution state and interface language. */
const poolStates: Record<Pool['state'], MessageKey> = { discussion: 'Discussion', 'accepted-open': 'Decision accepted · open', attention: 'Needs attention', 'awaiting-observation': 'Awaiting information' };
/** Localizes structured cleanliness without parsing a source message. */
function TreeState({ tree }: { tree: Worktree }) {
  /** File counts use native plural rules, with unknown coverage preserved. */
  const { t, count } = useLocale();
  return tree.cleanliness === 'modified' ? tree.modifiedFileCount === null ? t('Changes observed · file count unavailable') : t('Changes observed · {files}', { files: count(tree.modifiedFileCount, 'file') }) : t(tree.cleanliness === 'clean' ? 'No changes observed' : tree.cleanliness === 'tracked-only' ? 'Unknown · only tracked files checked' : 'Unknown · no observation');
}
/** Formats saved approximate stage progress; it never recalculates or translates source plans. */
function SavedProgress({ project }: { project: Project }) {
  /** Dates and numeric stage counts come from explicit saved observations. */
  const { t, n, datetime, count } = useLocale();
  return t('Approximately {done} of {stages} · saved {date}', { done: n(project.progress.completed), stages: count(project.progress.total, 'stage'), date: datetime(project.progress.observedAt) });
}
/** Agent history is source text; only its controls, metadata and structured times are localized. */
function AgentDetail({ agent, partial, open, announce, tab, onTab }: { agent: Agent; partial: boolean; tab: string; onTab: (value: string) => void; open: (kind: Exclude<Section, 'overview'>, id: string) => void; announce: (notice: Notice) => void }) {
  /** Interface formatting never changes the saved task/result prose. */
  const { t, date, time, datetime, duration } = useLocale();
  /** Clipboard outcome is typed; localized feedback is rendered at the current locale. */
  async function copyResult() {
    try { await navigator.clipboard.writeText(agent.result); announce({ message: 'Result copied', severity: 'success' }); }
    catch { announce({ message: 'Could not copy. Select and copy the result text manually.', severity: 'warning' }); }
  }
  return <>
    <div className="detail-intro"><Status status={agent.status} /><span>{agent.model} · {duration(agent.durationMs)}</span></div>
    <Tabs value={tab} onValueChange={onTab} className="detail-tabs">
      <TabsList aria-label={t('Agent information')}><TabsTrigger value="history">{t('History')}</TabsTrigger><TabsTrigger value="result">{t('Result')}</TabsTrigger><TabsTrigger value="details">{t('Details')}</TabsTrigger></TabsList>
      <TabsContent value="history">
        <div className="history-note"><Clock3 size={15} />{t('{date} · demonstration time', { date: date(agent.observedAt) })}</div>
        <article className="message"><header><span className="speaker">{t('You')}</span><time dateTime={messageTimes.user}>{time(messageTimes.user)}</time></header><p>{t('Task')}: {agent.name}. {demoMessages.userInstruction}</p></article>
        <article className="message"><header><span className="speaker"><Bot size={16} />{t('Assistant')}</span><time dateTime={messageTimes.assistant}>{time(messageTimes.assistant)}</time></header><p>{demoMessages.assistantIntro}</p></article>
        <details className="tool-call"><summary><Wrench size={15} /><span>{t('Read project context')}</span><span className="call-result"><Check size={14} />{t('Success')}</span></summary><div className="tool-body"><p>{t('Tool call · {time}', { time: time(messageTimes.context) })}</p><pre>{JSON.stringify({ tool: 'project.context', project: agent.project, source: 'synthetic-fixture', readOnly: true }, null, 2)}</pre><p>{demoMessages.contextResult}</p></div></details>
        <details className="tool-call"><summary><Wrench size={15} /><span>{t(agent.status === 'failed' ? 'Type check' : 'Observation check')}</span><span className={'call-result ' + (agent.status === 'failed' ? 'error-text' : '')}>{agent.status === 'failed' ? <TriangleAlert size={14} /> : <CircleHelp size={14} />}{t(agent.status === 'failed' ? 'Error' : 'No information')}</span></summary><div className="tool-body"><p>{t('Observation · {time}', { time: time(agent.observedAt) })}</p><pre>{agent.status === 'failed' ? 'Type check failed: observation may be null.\nNo source changes were applied.' : 'Delivery outcome: unknown.\nNo acknowledgement was observed.\nNo automatic resend was performed.'}</pre><details><summary>{t('Full output · long entry, collapsed')}</summary><pre>{'Synthetic diagnostic context: '.repeat(35)}{'/demo/project/very-long-read-only-observation-path/'.repeat(8)}</pre></details></div></details>
        <article className="message last-message"><header><span className="speaker"><Bot size={16} />{t('Assistant')}</span><time dateTime={agent.observedAt}>{time(agent.observedAt)}</time></header><p>{partial ? t('Part of the history is missing. The latest result is unavailable in this scenario.') : agent.result}</p></article>
        <p className="muted source-note">{t('Source: Agent Run · synthetic history. Saved messages are shown, not an event stream.')}</p>
      </TabsContent>
      <TabsContent value="result"><div className="result-heading"><h3>{t('Saved result')}</h3><Button variant="outline" onClick={copyResult} disabled={partial}><Copy size={15} />{t('Copy result')}</Button></div><p className="result-text">{partial ? t('No information: the result is absent from the received subset.') : agent.result}</p><p className="muted">{t('Observed: {date}. Delivery acceptance is recorded separately in the pool.', { date: datetime(agent.observedAt) })}</p></TabsContent>
      <TabsContent value="details"><dl>
        <Field label={t('Project')}><button className="text-link" data-focus-key={'projects:' + agent.project} onClick={() => open('projects', agent.project)}>{projects.find(project => project.id === agent.project)?.name}<ArrowRight size={14} /></button></Field>
        <Field label={t('Working copy')}><button className="text-link" data-focus-key={'worktrees:' + agent.worktree} onClick={() => open('worktrees', agent.worktree)}>{worktrees.find(tree => tree.id === agent.worktree)?.name}<ArrowRight size={14} /></button></Field>
        <Field label={t('Pool')}>{agent.pool ? <button className="text-link" data-focus-key={'pools:' + agent.pool} onClick={() => open('pools', agent.pool!)}>{pools.find(pool => pool.id === agent.pool)?.name}<ArrowRight size={14} /></button> : t('Independent execution')}</Field>
        <Field label={t('Latest activity')}>{agent.activity}</Field><Field label={t('Source and time')}>Agent Run · {datetime(agent.observedAt)} · {t('Demo')}</Field>
      </dl><details className="metadata"><summary>{t('Technical metadata')}</summary><dl><Field label={t('Identifier')}>{agent.id} · {t('Synthetic')}</Field><Field label={t('Model')}>{agent.model} · {t('Demonstration value')}</Field><Field label={t('Coverage')}>{t(partial ? 'Partial · some history is missing' : 'Only saved prototype messages')}</Field></dl></details></TabsContent>
    </Tabs>
  </>;
}
/** Pool source prose and votes remain original; explicit state/control labels follow the locale. */
function PoolDetail({ pool, open, tab, onTab }: { pool: Pool; tab: string; onTab: (value: string) => void; open: (kind: Exclude<Section, 'overview'>, id: string) => void }) {
  /** Structured vote times and status labels are locale-aware. */
  const { t, time, datetime } = useLocale();
  return <><Badge variant="outline" className="source-badge">{t(poolSource(pool))}</Badge><div className="leader-block"><span className="eyebrow">{t('Leader · outside the participant roster')}</span><strong>{pool.leader}</strong><span className="muted">{t(poolStates[pool.state])}</span></div>
    <Tabs value={tab} onValueChange={onTab} className="detail-tabs"><TabsList aria-label={t('Pool information')}><TabsTrigger value="members">{t('Members')}</TabsTrigger><TabsTrigger value="discussion">{t('Discussion')}</TabsTrigger><TabsTrigger value="decisions">{t('Decisions')}</TabsTrigger><TabsTrigger value="deliveries">{t('Deliveries')}</TabsTrigger></TabsList>
      <TabsContent value="members">{pool.agents.map(id => {
        /** Linked members resolve through shared stable agent IDs. */
        const member = agents.find(agent => agent.id === id)!;
        return <button key={id} className="member-row" data-focus-key={'agents:' + id} onClick={() => open('agents', id)}><Bot size={19} /><span><strong>{member.name}</strong><span className="muted">Agent Run · {t(statusLabels[member.status])}</span></span><ChevronRight size={17} /></button>;
      })}{pool.native.map(name => <div className="member-row native-member" key={name}><ShieldCheck size={19} /><span><strong>{name}</strong><span className="muted">{t('Agent Pool member · no Run execution data')}</span></span></div>)}</TabsContent>
      <TabsContent value="discussion"><article className="message"><header><strong>{pool.leader}</strong><time dateTime={messageTimes.context}>{time(messageTimes.context)}</time></header><p>{demoMessages.poolLeader}</p></article><article className="message"><header><strong>{demoMessages.reviewerName}</strong><time dateTime={messageTimes.reviewer}>{time(messageTimes.reviewer)}</time></header><p>{demoMessages.poolReviewer}</p></article><p className="muted">{t('Synthetic discussion · read only')}</p></TabsContent>
      <TabsContent value="decisions"><h3>{t('Saved member votes')}</h3><p className="muted">{t('A vote concerns the decision and is independent of execution state.')}</p>{pool.votes.map(vote => <div className="vote-row" key={vote.member}><div><strong>{agents.find(agent => agent.id === vote.member)?.name ?? vote.member}</strong><Badge variant="outline" className={'vote-label vote-' + vote.state}>{vote.state === 'ready' ? <Check size={14} /> : vote.state === 'block' ? <TriangleAlert size={14} /> : <CircleHelp size={14} />}{t(vote.state === 'ready' ? 'Ready for acceptance' : vote.state === 'block' ? 'Objection' : 'No information')}</Badge></div><p>{vote.evidence}</p><span className="muted">{datetime(vote.observedAt)} · {t(poolSource(pool))} · {t('Saved observation')}</span></div>)}<h3>{t('Accepted decision')}</h3><p className="result-text">{pool.decision}</p><dl><Field label={t('Pool state')}>{t(poolStates[pool.state])}</Field><Field label={t('Closure')}>{t('Closure is unconfirmed. An accepted decision does not close a pool by itself.')}</Field></dl></TabsContent>
      <TabsContent value="deliveries"><h3>{t('Result acceptance')}</h3><p className="result-text">{pool.delivery}</p><div className="inline-note"><CircleHelp size={18} />{t('An accepted delivery does not mean the agent has finished.')}</div></TabsContent>
    </Tabs><button className="text-link detail-related" data-focus-key={'projects:' + pool.project} onClick={() => open('projects', pool.project)}>{projects.find(project => project.id === pool.project)?.name}<ArrowRight size={15} /></button><p className="source-note muted">{t('Source: {source} · {date} · demo', { source: t(poolSource(pool)), date: datetime(observed) })}</p></>;
}
/** Saved worktree measurements are formatted locally without inspecting or mutating a real path. */
function WorktreeDetail({ tree, partial, open, announce }: { tree: Worktree; partial: boolean; open: (kind: Exclude<Section, 'overview'>, id: string) => void; announce: (notice: Notice) => void }) {
  /** Explicit byte/time observations retain unknown and lower-bound semantics. */
  const { t, datetime, size } = useLocale();
  return <><dl><Field label={t('Branch')}><code>{tree.branch}</code></Field><Field label={t('Path · demonstration')}><code>{tree.path}</code></Field><Field label={t('Owner')}>{tree.owner}</Field><Field label={t('Latest observation')}>{datetime(tree.observedAt)} · Agent Worktree</Field><Field label={t('Observed state')}>{partial ? t('Unknown · some observations are missing') : <TreeState tree={tree} />}</Field>
    <Field label={t('Size from saved measurement')}><span>{partial || tree.sizeKind === 'unmeasured' ? t('Unmeasured · size unknown') : tree.sizeKind === 'lower-bound' ? t('At least {size} · lower bound', { size: size(tree.sizeBytes) }) : t('{size} · known snapshot size', { size: size(tree.sizeBytes) })}</span><span className="size-caption">{t('{date} · demo observation', { date: datetime(tree.sizeObservedAt) })}</span><span className="size-caption">{t(partial ? 'The saved measurement is absent from the received subset.' : tree.sizeKind === 'lower-bound' ? 'Some files were excluded. The total size is unknown.' : tree.sizeKind === 'unmeasured' ? 'The saved record has no measurement. Zero is not substituted.' : 'Complete synthetic snapshot measurement at the stated time.')}</span></Field>
    <Field label={t('Check coverage')}>{t('Synthetic observation only. Untracked and excluded files were not checked; full cleanliness is unconfirmed.')}</Field><Field label={t('Project')}><button className="text-link" data-focus-key={'projects:' + tree.project} onClick={() => open('projects', tree.project)}>{projects.find(project => project.id === tree.project)?.name}<ArrowRight size={14} /></button></Field></dl>
    <Button variant="outline" onClick={() => announce({ message: 'Saved demo information is shown. The real path was not checked.', severity: 'success' })}><Search size={15} />{t('Check information')}</Button><p className="muted source-note">{t('Demo lookup of the saved record, without filesystem access.')}</p><h3 className="related-heading">{t('Related agents')}</h3>{agents.filter(agent => agent.worktree === tree.id).map(agent => <button key={agent.id} className="member-row" data-focus-key={'agents:' + agent.id} onClick={() => open('agents', agent.id)}><Bot size={18} /><span><strong>{agent.name}</strong><span className="muted">{t(statusLabels[agent.status])}</span></span><ChevronRight size={16} /></button>)}</>;
}
/** Plans and outcomes retain their source language; surrounding UI and numeric progress are localized. */
function ProjectDetail({ project, open }: { project: Project; open: (kind: Exclude<Section, 'overview'>, id: string) => void }) {
  /** Only application-authored framing is translated. */
  const { t } = useLocale();
  return <><p className="muted">{project.description}</p><h3>{t('Saved plan')}</h3><ol className="plan-list">{project.plan.map(item => <li key={item}>{item}</li>)}</ol><h3>{t('Observed outcome')}</h3><p>{project.outcome}</p><div className="estimate"><Clock3 size={18} /><div><strong>{t('Approximate plan progress')}</strong><p><SavedProgress project={project} /></p><span className="muted">{t('Source: Agent Tasks · saved estimate, not agent progress')}</span></div></div><h3 className="related-heading">{t('Related objects')}</h3>
    {agents.filter(agent => agent.project === project.id).map(agent => <button className="member-row" key={agent.id} data-focus-key={'agents:' + agent.id} onClick={() => open('agents', agent.id)}><Bot size={18} /><span><strong>{agent.name}</strong><span className="muted">{t(statusLabels[agent.status])}</span></span><ChevronRight size={16} /></button>)}
    {worktrees.filter(tree => tree.project === project.id).map(tree => <button className="member-row" key={tree.id} data-focus-key={'worktrees:' + tree.id} onClick={() => open('worktrees', tree.id)}><GitBranch size={18} /><span><strong>{tree.name}</strong><span className="muted">{tree.branch}</span></span><ChevronRight size={16} /></button>)}
    {pools.filter(pool => pool.project === project.id).map(pool => <button className="member-row" key={pool.id} data-focus-key={'pools:' + pool.id} onClick={() => open('pools', pool.id)}><Layers3 size={18} /><span><strong>{pool.name}</strong><span className="muted">{t(poolSource(pool))}</span></span><ChevronRight size={16} /></button>)}</>;
}
/** Tool fixture copy is explicitly authored UI metadata; arbitrary service response prose is never a key. */
function ToolDetail({ tool, partial, stale }: { tool: Tool; partial: boolean; stale: boolean }) {
  /** Structured counters and ISO timestamps are formatted before interpolation into metadata copy. */
  const { t, n, time, datetime } = useLocale();
  /** This known fixture's interpolation values contain no source prose or executable markup. */
  const values = { ...Object.fromEntries(Object.entries(tool.metrics).map(([key, value]) => [key, n(value)])), ...Object.fromEntries(Object.entries(tool.timestamps).map(([key, value]) => [key, time(value)])), time: time(tool.observedAt), date: datetime(tool.observedAt) };
  /** Coverage categories are labels, not conclusions parsed from natural-language diagnostics. */
  const coverageLabels: Record<Tool['quotaState'], MessageKey> = { known: 'Known', stale: 'Information is stale', unknown: 'No information', 'not-applicable': 'Not applicable' };
  return <><p className="muted">{t(tool.purpose)}</p>{stale && <div className="inline-note warning" role="status"><Clock3 size={18} /><span>{t('Saved snapshot · freshness of all observations is unconfirmed. The current source state is unknown.')}</span></div>}<dl>
    <Field label={t(stale ? 'State in saved snapshot' : 'State in demonstration')}>{partial ? t('No complete observation') : stale ? t('Saved: {state} · currently unconfirmed', { state: t(tool.state) }) : t(tool.state)}</Field>
    <Field label={t(stale ? 'Version in saved snapshot' : 'Version')}>{t('Demo version {version}', { version: tool.version })}</Field>
    <Field label={t(tool.id === 'run' ? 'Provider quota and window' : 'Limits and coverage')}><strong className="observation-label">{t(partial ? 'No information · complete observation unavailable' : stale ? 'Saved · freshness unconfirmed' : coverageLabels[tool.quotaState])}</strong>{!partial && <span className="coverage-value">{t(tool.quota, values)}</span>}</Field>
    <Field label={t(stale ? 'Saved observation time' : 'Latest observation')}>{datetime(tool.observedAt)}{tool.quotaState === 'stale' && <> · {t('Information is stale')}</>}</Field></dl>
    <h3>{t(stale ? 'Saved observations' : tool.id === 'bridge' ? 'Delivery and incident' : tool.id === 'ide' ? 'Checks and coverage' : 'Observations')}</h3><p className="result-text">{t(tool.detail, values)}</p><details className="metadata"><summary>{t('Source metadata')}</summary><dl><Field label={t('Source')}>{tool.name} · {t('Synthetic snapshot')}</Field><Field label={t('Connection')}>{t('No live service connected')}</Field><Field label={t('Limits')}>{t('Prototype observations do not confirm service availability.')}</Field></dl></details></>;
}

/** Owns one explicit screen history and interface preferences; never calls a live API. */
export default function App() {
  /** Locale is independent of history, preserving screen identity and cached filters/tabs on switching. */
  const { t, n, date, time, datetime, duration, count, tag, locale, setLocale } = useLocale();
  /** Stable scenario IDs are paired with current-language labels only at render time. */
  const scenarioOptions: [string, string][] = scenarios.map(([value, label]) => [value, t(label)]);
  /** Every visible navigation state is restored as one history snapshot. */
  const [screen, setScreen] = useState<Screen>(screenFromLocation);
  /** Current render's screen fields are the only source of filter and detail state. */
  const { section, selected, scope, query, status, scenario } = screen;
  /** Native production is live; browser demo requires explicit intent and never follows a read failure. */
  const [mode] = useState(dataMode);
  /** Refresh generations restart only the visible read subscriptions. */
  const [liveRefresh, setLiveRefresh] = useState(0);
  /** Real inventories supply shell counts/project identities without any fixture substitution. */
  const live = useLiveIndex(section, liveRefresh, mode === 'live', selected, screen.tab);
  /** Live-only labels use the same locale while retaining their explicit authored-copy type. */
  const l = (key: LiveKey, values?: Record<string, string | number>) => liveText(locale, key, values);
  /** Only confirmed common-directory identities are offered as real project scope. */
  const scopeOptions: [string, string][] = [["all", t('All projects')], ...(mode === 'demo' ? projects.map(project => [project.id, project.name] as [string, string]) : live.repositories.map(repo => [repo.id, repo.label] as [string, string]))];
  if (scope !== 'all' && !scopeOptions.some(([id]) => id === scope)) scopeOptions.push([scope, l('No confirmed repository') + ' · ' + basename(scope)]);
  /** Event listeners read the current screen without being recreated for every keystroke. */
  const screenRef = useRef(screen);
  /** Latest snapshots belong to existing browser entry keys, not a second navigation stack. */
  const snapshotsRef = useRef(new Map<string, Screen>([[screen.key, screen]]));
  /** Theme is persisted locally and follows the OS while system is selected. */
  const [theme, setTheme] = useState<Theme>(savedTheme);
  /** Visible feedback is independent of navigation history. */
  const [notice, setNotice] = useState<Notice | null>(null);
  /** Search shortcut and restoration target on list screens. */
  const searchRef = useRef<HTMLInputElement>(null);
  /** Each list/detail screen has one primary heading for initial focus. */
  const headingRef = useRef<HTMLHeadingElement>(null);
  /** Independent list viewport is restored along with document scroll. */
  const listRef = useRef<HTMLDivElement>(null);

  /** Captures actual scroll and focus without triggering a render or changing the route. */
  function remember(): Screen {
    return { ...screenRef.current, scroll: window.scrollY, listScroll: listRef.current?.scrollTop ?? 0, focus: document.activeElement?.closest<HTMLElement>('[data-focus-key]')?.dataset.focusKey ?? null };
  }
  /** Updates this cached entry's filters/tab without any History API write. */
  function update(patch: Partial<Pick<Screen, 'scope' | 'query' | 'status' | 'scenario' | 'tab'>>) {
    /** Semantic edits and current DOM observations share the same existing entry key. */
    const next = { ...remember(), ...patch };
    screenRef.current = next;
    snapshotsRef.current.set(next.key, next);
    setScreen(next);
  }
  /** Saves the departing cached snapshot and writes history only for actual screen navigation. */
  function visit(patch: Partial<Screen>, replace = false) {
    /** Departure retains its latest tab, query, scope, focus and scroll entirely in memory. */
    const previous = remember();
    snapshotsRef.current.set(previous.key, previous);
    /** Only a direct-link Back fallback replaces its entry instead of pushing another. */
    const next = { ...previous, ...patch, key: crypto.randomUUID(), depth: previous.depth + (replace ? 0 : 1), scroll: 0, listScroll: 0, focus: null };
    window.history[replace ? 'replaceState' : 'pushState']({ agentHub: next }, '', screenHash(next));
    screenRef.current = next;
    snapshotsRef.current.set(next.key, next);
    setScreen(next);
    setNotice(null);
  }
  useEffect(() => {
    /** Back/Forward uses cached edits; only a new native fragment needs an initial entry key. */
    const restore = () => {
      const next = screenFromLocation(snapshotsRef.current);
      if (window.history.state?.agentHub?.key !== next.key) window.history.replaceState({ agentHub: next }, '', screenHash(next));
      screenRef.current = next;
      snapshotsRef.current.set(next.key, next);
      setScreen(next);
      setNotice(null);
    };
    /** Late events cannot save old DOM positions into a different browser entry or route. */
    const savePosition = () => {
      const current = screenRef.current;
      if (window.history.state?.agentHub?.key !== current.key || window.location.hash !== screenHash(current) || document.getElementById('main-content')?.dataset.screenKey !== current.key) return;
      const next = remember();
      screenRef.current = next;
      snapshotsRef.current.set(next.key, next);
    };
    /** Native scroll restoration stays disabled while this component restores cached positions. */
    const previousRestoration = window.history.scrollRestoration;
    window.history.scrollRestoration = 'manual';
    if (window.history.state?.agentHub?.key !== screenRef.current.key || window.location.hash !== screenHash(screenRef.current)) window.history.replaceState({ agentHub: screenRef.current }, '', screenHash(screenRef.current));
    window.addEventListener('popstate', restore);
    window.addEventListener('hashchange', restore);
    window.addEventListener('scroll', savePosition, true);
    document.addEventListener('focusin', savePosition);
    return () => {
      window.history.scrollRestoration = previousRestoration;
      window.removeEventListener('popstate', restore);
      window.removeEventListener('hashchange', restore);
      window.removeEventListener('scroll', savePosition, true);
      document.removeEventListener('focusin', savePosition);
    };
  }, []);
  useLayoutEffect(() => {
    /** Restoration runs only on actual history entry changes, never during reading or typing. */
    const target = screen.focus ? document.querySelector<HTMLElement>('[data-focus-key="' + CSS.escape(screen.focus) + '"]') : null;
    (target ?? headingRef.current)?.focus({ preventScroll: true });
    if (listRef.current) listRef.current.scrollTop = screen.listScroll;
    window.scrollTo({ top: screen.scroll, behavior: 'instant' });
  }, [screen.key]);
  useEffect(() => {
    /** System theme changes are observed only for the system preference. */
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    /** Applies the chosen class and browser form-control scheme. */
    const apply = () => { /** Effective appearance for the current preference and OS signal. */ const dark = theme === 'dark' || (theme === 'system' && media.matches); document.documentElement.classList.toggle('dark', dark); document.documentElement.style.colorScheme = dark ? 'dark' : 'light'; };
    apply();
    media.addEventListener('change', apply);
    try { localStorage.setItem('agent-hub-theme', theme); } catch { /* The interface still works when storage is unavailable. */ }
    return () => media.removeEventListener('change', apply);
  }, [theme]);
  useEffect(() => {
    /** Search shortcut leaves ordinary typing and Escape untouched. */
    const shortcut = (event: KeyboardEvent) => { if (searchRef.current && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); searchRef.current?.focus(); } };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, []);
  /** Sidebar navigation pushes a list screen while retaining shared scope/status preferences. */
  function navigate(destination: Section) { visit({ section: destination, selected: null, query: '', tab: '' }); }
  /** Related objects create full detail screens with their own default tab. */
  function open(kind: Exclude<Section, 'overview'>, id: string, sequence?: number) { visit({ section: kind, selected: { kind, id, ...(sequence === undefined ? {} : { sequence }) }, tab: kind === 'agents' ? 'history' : kind === 'pools' ? 'members' : '' }); }
  /** Returns to the actual prior screen; a direct detail URL falls back to its section list. */
  function goBack() {
    if (screen.depth > 0) window.history.back();
    else visit({ selected: null, tab: '' }, true);
  }
  /** Pointer activation covers every non-interactive cell, while text selection remains inert. */
  function activateAgentRow(event: MouseEvent<HTMLTableRowElement>, agent: Agent) {
    activateRecordRow(event, () => open('agents', agent.id));
  }
  /** Project filters are cached; leaving a detail for its scoped list is actual navigation. */
  function setScope(value: string) { if (screenRef.current.selected) visit({ scope: value, selected: null, tab: '' }); else update({ scope: value }); }
  /** Search changes update only the cached entry and rendered list. */
  function setQuery(value: string) { update({ query: value }); }
  /** Status changes retain project/query context without writing browser history. */
  function setStatus(value: string) { update({ status: value }); }
  /** Availability edits are cached; a detail-to-list transition remains explicit navigation. */
  function changeScenario(value: string) { if (screenRef.current.selected) visit({ scenario: value as Scenario, selected: null, tab: '' }); else update({ scenario: value as Scenario, tab: '' }); setNotice(null); }
  /** Honest demo refresh never implies that any service was contacted. */
  function refresh() { if (mode === 'demo') { update({ scenario: 'normal' }); setNotice({ message: 'Demo data refreshed', severity: 'success' }); } else if (mode === 'live') { setLiveRefresh(value => value + 1); setNotice({ message: 'Read-only refresh requested', severity: 'success' }); } }
  /** Clears all list filters in the current in-memory snapshot. */
  function resetFilters() { update({ scope: 'all', status: 'all', query: '' }); }

  /** Empty, loading and failed states contain no purportedly fresh records. */
  const available = !['empty', 'loading', 'error'].includes(scenario);
  /** Partial data has deliberately bounded coverage and explicit unknown detail fields. */
  const partial = scenario === 'partial';
  /** Scope is shared across fixtures through stable project links. */
  const scopedAgents = available ? agents.filter(agent => scope === 'all' || agent.project === scope).filter((_, index) => !partial || index < 2) : [];
  /** Related worktrees share the same scope and availability contract. */
  const scopedTrees = available ? worktrees.filter(tree => scope === 'all' || tree.project === scope).filter((_, index) => !partial || index < 2) : [];
  /** Pools keep their original source when scoped. */
  const scopedPools = available ? pools.filter(pool => scope === 'all' || pool.project === scope).filter((_, index) => !partial || index < 1) : [];
  /** Projects include only the selected scope and available fixture coverage. */
  const scopedProjects = available ? projects.filter(project => scope === 'all' || project.id === scope).filter((_, index) => !partial || index < 2) : [];
  /** Tool observations are global, explicitly unaffected by project scope. */
  const visibleTools = available ? tools.filter((_, index) => !partial || index < 3) : [];
  /** Normalized search matches human task names, project names and secondary metadata. */
  const needle = query.trim().toLocaleLowerCase(tag);
  /** One textual matching rule is shared across all sections. */
  const matches = (text: string) => text.toLocaleLowerCase(tag).includes(needle);
  /** Filtered executions drive the agent table and overview counts/list. */
  const filteredAgents = scopedAgents.filter(agent => (status === 'all' || agent.status === status) && matches(`${agent.name} ${agent.model} ${projects.find(project => project.id === agent.project)?.name} ${agent.activity}`));
  /** Visible pools honor both scope and contextual search. */
  const filteredPools = scopedPools.filter(pool => matches(`${pool.name} ${t(poolSource(pool))} ${t(poolStates[pool.state])}`));
  /** Visible working directories match name, branch, project, owner and inert path. */
  const filteredTrees = scopedTrees.filter(tree => matches(`${tree.name} ${tree.branch} ${tree.owner} ${tree.path} ${projects.find(project => project.id === tree.project)?.name}`));
  /** Project search includes saved plan and outcome text. */
  const filteredProjects = scopedProjects.filter(project => matches(`${project.name} ${project.description} ${project.plan.join(' ')} ${project.outcome}`));
  /** Tool search includes observations and quota metadata. */
  const filteredTools = visibleTools.filter(tool => matches(`${tool.name} ${t(tool.purpose)} ${t(tool.state)} ${t(tool.detail)} ${t(tool.quota)}`));
  /** Summary counts derive from exactly the same scoped/filter-matching fixtures as the rows. */
  const running = filteredAgents.filter(agent => agent.status === 'running');
  /** Errors and unknown executions are distinct actionable observations. */
  const attention = filteredAgents.filter(agent => agent.status === 'failed' || agent.status === 'unknown');
  /** Saved outcomes use lexical local times, which have a common fixture date. */
  const completed = filteredAgents.filter(agent => agent.status === 'succeeded').sort((a, b) => b.observedAt.localeCompare(a.observedAt));
  /** Current section title is derived from the single navigation source. */
  const title = t(navigation.find(item => item.id === section)!.label);
  /** Selected data always resolves against shared fixtures; unavailable scenario clears selection. */
  const detailRecord = selected ? ({ agents, pools, worktrees, projects, tools }[selected.kind] as { id: string; name: string }[]).find(record => record.id === selected.id) : undefined;
  /** Visible row count determines the contextual no-match state. */
  const rowCount = ({ overview: filteredAgents.length, agents: filteredAgents.length, pools: filteredPools.length, worktrees: filteredTrees.length, projects: filteredProjects.length, tools: filteredTools.length })[section];
  /** Summary action uses stable section navigation rather than locale-dependent routes. */
  const viewAgents = <button className="text-link" onClick={() => navigate('agents')}>{t('All agents')}<ArrowRight size={15} /></button>;
  return <div className="app-frame"><div className="app-shell">
    <a className="skip-link" href="#main-content" onClick={event => { event.preventDefault(); document.getElementById('main-content')?.focus(); }}>{t('Skip to content')}</a>
    <aside className="sidebar" aria-label={t('Sidebar')}>
      <a href="#overview" className="brand" aria-label={t('Agent Hub — overview')} onClick={event => { event.preventDefault(); navigate('overview'); }}><span className="brand-symbol" aria-hidden="true"><i /><i /><i /></span><span>Agent Hub<span className="brand-caption">{t('Workspace')}</span></span></a>
      <div className="scope-picker"><label id="scope-label">{t('Project')}</label><Choice label={t('Project scope')} value={scope} options={scopeOptions} onChange={setScope} /></div>
      <nav aria-label={t('Main navigation')}>{navigation.map(item => <a key={item.id} href={'#' + item.id} onClick={event => { event.preventDefault(); navigate(item.id); }} aria-label={t(item.label)} aria-current={section === item.id ? 'page' : undefined} title={t(item.label)}><item.icon size={20} /><span>{t(item.label)}</span>{item.id === 'agents' && <span className="nav-count">{mode === 'demo' ? n(scopedAgents.length) : live.run.page ? n(live.run.page.items.filter(agent => scope === 'all' || longestWorktree(agent.workdir, live.worktrees.page?.items ?? [])?.common === scope).length) : '—'}</span>}</a>)}</nav>
      <div className="sidebar-note"><span className="eyebrow">{t('One place for context')}</span><p>{t('Executions, decisions and project results.')}</p></div>
      <footer className="sidebar-footer"><Dialog><DialogTrigger asChild><Button variant="ghost" className="settings-button" aria-label={t('Interface settings')}><Settings2 size={19} /><span>{t('Interface settings')}</span></Button></DialogTrigger>
        <DialogContent className="settings-dialog"><DialogTitle>{t('Interface settings')}</DialogTitle><DialogDescription>{mode === 'demo' ? t('Local prototype settings. Service connections are not changed here.') : l('Interface preferences only. Service configuration is read-only.')}</DialogDescription>
          <div className="settings-field"><label>{t('Appearance')}</label><div className="theme-options">{([['system', 'System', Monitor], ['light', 'Light', Sun], ['dark', 'Dark', Moon]] as const).map(([key, label, Icon]) => <Button key={key} variant={theme === key ? 'secondary' : 'outline'} aria-pressed={theme === key} onClick={() => setTheme(key)}><Icon size={17} />{t(label)}</Button>)}</div></div>
          <div className="settings-field"><label>{t('Interface language')}</label><Choice label={t('Interface language')} value={locale} options={[["ru", "Русский"], ["en", "English"]]} onChange={value => { if (value === 'ru' || value === 'en') setLocale(value); }} /></div>
          {mode === 'demo' && <div className="settings-field"><label>{t('Prototype scenario')}</label><Choice label={t('Prototype scenario in settings')} value={scenario} options={scenarioOptions} onChange={changeScenario} /></div>}
          <p className="muted">{mode === 'demo' ? t('Scenarios affect synthetic data only. Theme and language are saved in this browser.') : l('Language and theme are saved locally. Refresh performs read-only observations.')}</p><div className="settings-actions"><Button variant="outline" onClick={() => { setTheme('system'); if (mode === 'demo') changeScenario('normal'); }}>{t('Reset appearance')}</Button><DialogClose asChild><Button aria-label={t('Close settings')}>{t('Done')}</Button></DialogClose></div>
        </DialogContent></Dialog><div className="demo-label"><span className="demo-dot" /><span>{mode === 'demo' ? t('Demo data') : l(mode === 'live' ? 'Live read-only data' : 'Native connection required')}</span></div><span className="sidebar-version">{mode === 'demo' ? t('Prototype {version} · read only', { version: '0.1.0' }) : l('Agent Hub {version} · read only', { version: '0.1.0' })}</span>
      </footer>
    </aside>
    <div className="workspace">
      <header className="toolbar"><div className="toolbar-context"><div className="breadcrumb"><span>{t('Space')}</span><ChevronRight size={15} /><strong>{title}</strong>{selected && <><ChevronRight size={15} /><span>{t('Details')}</span></>}</div><span className="compact-demo">{mode === 'demo' ? t('Demo data') : l(mode === 'live' ? 'Live read-only data' : 'Native connection required')}</span></div><div className="toolbar-actions">{!selected && <div className="search-box"><Search size={17} aria-hidden="true" /><Input data-focus-key="search" ref={searchRef} value={query} onChange={event => setQuery(event.target.value)} aria-label={t('Search: {section}', { section: title })} placeholder={t('Search: {section}', { section: title.toLocaleLowerCase(tag) })} /><kbd>⌘ / Ctrl K</kbd></div>}<Button variant="ghost" size="icon" aria-label={mode === 'demo' ? t('Refresh demo data') : l('Refresh observations')} title={mode === 'demo' ? t('Refresh demo data') : l('Refresh observations')} disabled={mode === 'unavailable'} onClick={refresh}><RefreshCw size={18} /></Button></div></header>
      <main id="main-content" data-screen-key={screen.key} tabIndex={-1}>
        {notice && <div className={'feedback' + (notice.severity === 'warning' ? ' warning' : '')} role={notice.severity === 'warning' ? 'alert' : 'status'}>{notice.severity === 'warning' ? <TriangleAlert size={17} /> : <Check size={17} />}<span>{t(notice.message)}</span><button aria-label={t('Close notification')} onClick={() => setNotice(null)}><X size={16} /></button></div>}
        {mode === 'live' ? <LiveSection section={section} selected={selected} scope={scope} query={query} status={status} onStatus={setStatus} reset={resetFilters} showAgents={() => navigate('agents')} tab={screen.tab} onTab={value => update({ tab: value })} refresh={liveRefresh} index={live} open={open} back={goBack} heading={headingRef} list={listRef} notify={(message, severity) => setNotice({ message, severity })} /> : mode === 'unavailable' ? <div className="empty-state"><h1 ref={headingRef} tabIndex={-1}>{l('Native connection required')}</h1><p>{l('This browser has no native read connection. Demo data is available only by explicit selection.')}</p><Button asChild variant="outline"><a href={'?demo=1' + window.location.hash}>{l('Open explicit demo')}</a></Button></div> : selected && detailRecord ? <section className="detail-screen" aria-label={t('Details: {name}', { name: detailRecord.name })}><header className="detail-heading"><Button variant="ghost" className="detail-back" onClick={goBack}><ArrowLeft size={17} />{t('Back')}</Button><span className="eyebrow">{title} / {t('Details')}</span><h1 ref={headingRef} tabIndex={-1}>{detailRecord.name}</h1></header><div className="detail-content">{selected.kind === 'agents' ? <AgentDetail key={selected.id} agent={detailRecord as Agent} partial={partial} tab={screen.tab} onTab={value => update({ tab: value })} open={open} announce={setNotice} /> : selected.kind === 'pools' ? <PoolDetail key={selected.id} pool={detailRecord as Pool} open={open} tab={screen.tab} onTab={value => update({ tab: value })} /> : selected.kind === 'worktrees' ? <WorktreeDetail key={selected.id} tree={detailRecord as Worktree} partial={partial} open={open} announce={setNotice} /> : selected.kind === 'projects' ? <ProjectDetail key={selected.id} project={detailRecord as Project} open={open} /> : <ToolDetail key={selected.id} tool={detailRecord as Tool} partial={partial} stale={scenario === 'stale'} />}</div></section> : <>
          <div className="page-heading"><div><div className="eyebrow">{scope === 'all' ? t('All projects') : projects.find(project => project.id === scope)?.name}<span className="heading-dot">·</span>{date(observed)}</div><h1 ref={headingRef} tabIndex={-1}>{section === 'overview' ? t('Ecosystem overview') : title}</h1><p>{t(introductions[section])}</p></div><div className="page-controls"><div className="compact-scope"><label>{t('Project')}</label><Choice label={t('Project in compact view')} value={scope} options={scopeOptions} onChange={setScope} /></div><div className="scenario-control"><label>{t('Prototype scenario')}</label><Choice label={t('Prototype scenario')} value={scenario} options={scenarioOptions} onChange={changeScenario} /></div></div></div>
          {scenario === 'stale' && <div className="state-banner warning" role="status"><Clock3 size={19} /><div><strong>{t('Information is stale')}</strong><p>{t('Saved demo snapshot: {date}. This scenario has no fresh observations; the current state is unknown.', { date: datetime(observed) })}</p></div><Button variant="outline" onClick={refresh}>{t('Refresh prototype')}</Button></div>}
          {partial && <div className="state-banner warning" role="status"><CircleHelp size={19} /><div><strong>{t('Only partial data is available')}</strong><p>{t('Available prototype records are shown. Counts cover this subset; missing observations remain unknown.')}</p></div></div>}
          {scenario === 'loading' ? <div className="loading-state" role="status" aria-live="polite"><LoaderCircle size={30} className="spin" /><h2>{t('Loading this view')}</h2><p>{t('Simulated loading. No services are being queried.')}</p><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /><Button variant="outline" onClick={refresh}>{t('Show demo data')}</Button></div>
            : scenario === 'error' ? <div className="empty-state error-state" role="alert"><Unplug size={34} /><h2>{t('Source connection unavailable')}</h2><p>{t('This is a prototype scenario. Data is unavailable and execution states are unknown.')}</p><Button onClick={refresh}><RefreshCw size={16} />{t('Retry')}</Button></div>
            : scenario === 'empty' ? <div className="empty-state"><FolderKanban size={34} /><h2>{t('No data here yet')}</h2><p>{t('The selected demo scenario has no data in “{section}”.', { section: title })}</p><Button variant="outline" onClick={refresh}>{t('Show default scenario')}</Button></div>
            : <>
              {(section === 'agents' || section === 'overview') && <div className={'filter-bar ' + (section === 'overview' ? 'overview-filters' : '')}><div><label>{t('Agent status')}</label><Choice label={t('Agent status')} value={status} options={[["all", t('All statuses')], ...Object.entries(statusLabels).map(([key, label]) => [key, t(label)] as [string, string])]} onChange={setStatus} /></div><span className="muted">{section === 'agents' ? t('Showing {shown} of {executions}', { shown: n(filteredAgents.length), executions: count(scopedAgents.length, 'execution') }) : t('Summary for the selected scope')}</span>{(needle || status !== 'all' || scope !== 'all') && <Button variant="ghost" onClick={resetFilters}>{t('Reset filters')}</Button>}</div>}
              {section === 'tools' && <p className="scope-explanation"><CircleHelp size={16} />{t('Tools cover the entire ecosystem. Project scope does not change service observations.')}</p>}
              {section === 'overview' && rowCount > 0 ? <>
                <div className="summary-strip"><div><span className="summary-icon"><Activity size={21} /></span><div><strong>{n(running.length)}<span>{t('In progress')}</span></strong><span className="muted">{t('Last observed state')}</span></div></div><div><span className="summary-icon summary-warning"><TriangleAlert size={21} /></span><div><strong>{n(attention.length)}<span>{t('Needs attention')}</span></strong><span className="muted">{t('Errors and missing information')}</span></div></div><div><span className="summary-icon"><FileCheck2 size={21} /></span><div><strong>{n(completed.length)}<span>{t('Saved results')}</span></strong><span className="muted">{t('Within the selected scope')}</span></div></div></div>
                <div className="overview-core"><Panel title={t('Needs attention')} extra={<span className="small-counter">{n(attention.length)}</span>} className="attention-panel">{attention.length ? attention.map(agent => <button key={agent.id} className="attention-row" data-focus-key={'agents:' + agent.id} onClick={() => open('agents', agent.id)}><span className={'attention-icon ' + (agent.status === 'failed' ? 'error-text' : '')}>{agent.status === 'failed' ? <TriangleAlert size={20} /> : <CircleHelp size={20} />}</span><span><strong>{agent.name}</strong><span className="muted">{t(agent.status === 'failed' ? 'Result needs review' : 'Execution outcome unknown')} · {projects.find(project => project.id === agent.project)?.name}</span></span><Status status={agent.status} /><ChevronRight size={18} /></button>) : <p className="panel-empty"><CheckCheck size={19} />{t('No agents in this scope need attention.')}</p>}</Panel>
                  <Panel title={t('Working now')} extra={viewAgents}>{running.length ? running.map(agent => <button key={agent.id} className="working-row" data-focus-key={'agents:' + agent.id} onClick={() => open('agents', agent.id)}><ProjectMark id={agent.project} /><span className="row-main"><strong>{agent.name}</strong><span className="muted">{agent.activity}</span></span><span className="working-model">{agent.model}<span className="muted">{projects.find(project => project.id === agent.project)?.name}</span></span><span className="row-time">{duration(agent.durationMs)}<span className="muted">{time(agent.observedAt)}</span></span><ChevronRight size={16} /></button>) : <p className="panel-empty">{t('No running agents match these filters.')}</p>}</Panel>
                </div>
                <div className="overview-bottom"><Panel title={t('Latest results')} extra={<span className="muted">{date(observed)}</span>}>{completed.length ? completed.slice(0, 3).map(agent => <button key={agent.id} className="result-row" data-focus-key={'agents:' + agent.id} onClick={() => open('agents', agent.id)}><CheckCheck size={18} /><span><strong>{agent.name}</strong><span className="muted">{projects.find(project => project.id === agent.project)?.name} · {t('Result saved')}</span></span><time dateTime={agent.observedAt}>{time(agent.observedAt)}</time></button>) : <p className="panel-empty">{t('No saved results yet.')}</p>}</Panel>
                  <Panel title={t('Information sources')} extra={<button className="text-link" onClick={() => navigate('tools')}>{t('All')}<ArrowRight size={15} /></button>}><div className="connection-summary"><span className="connection-icon"><Layers3 size={21} /></span><div><strong>{count(visibleTools.length, 'source')}</strong><p>{t('Live services are not connected')}</p></div></div>{visibleTools.some(tool => tool.id === 'bridge') ? <button className="bridge-observation" data-focus-key="tools:bridge" onClick={() => open('tools', 'bridge')}><TriangleAlert size={17} /><span>{t('Bridge: {count} delivery outcome unknown', { count: n(tools.find(tool => tool.id === 'bridge')!.metrics.unknown) })}</span><ChevronRight size={16} /></button> : <p className="missing-source muted">{t('Bridge observations are unavailable')}</p>}<p className="source-note muted">{t('Versions and limits are illustrative. Source states are shown separately.')}</p></Panel>
                </div>
              </> : section === 'overview' ? <Empty title={t('No matches found')} text={t('Change the search query or reset scope filters.')} onReset={resetFilters} /> : <div className="list-screen"><div ref={listRef} className="records-list" aria-label={t('List: {section}', { section: title })}>
                {!rowCount ? <Empty title={t('No matches found')} text={t('Try another query or reset the filters.')} onReset={resetFilters} /> : section === 'agents' ? <div className="agent-table-wrap"><table className="agent-table"><thead><tr><th scope="col">{t('Task / project')}</th><th scope="col">{t('Status')}</th><th scope="col" className="optional-column">{t('Model')}</th><th scope="col" className="optional-column">{t('Duration / activity')}</th></tr></thead><tbody>{filteredAgents.map(agent => <tr key={agent.id} className="agent-row" onClick={event => activateAgentRow(event, agent)}><td><button className="agent-name" data-focus-key={'agents:' + agent.id} onClick={() => open('agents', agent.id)} aria-label={t('Open agent: {name}', { name: agent.name })}><ProjectMark id={agent.project} /><span><strong>{agent.name}</strong><span className="muted">{projects.find(project => project.id === agent.project)?.name}<span className="compact-model"> · {agent.model}</span></span></span></button></td><td><Status status={agent.status} /></td><td className="optional-column">{agent.model}</td><td className="optional-column"><span>{duration(agent.durationMs)}</span><span className="muted cell-secondary">{time(agent.observedAt)} · {agent.activity}</span></td></tr>)}</tbody></table></div>
                  : section === 'pools' ? <div className="object-list">{filteredPools.map(pool => <button key={pool.id} className="object-row" data-focus-key={'pools:' + pool.id} onClick={() => open('pools', pool.id)}><span className="object-icon"><Layers3 size={21} /></span><span className="object-body"><strong>{pool.name}</strong><span className="muted">{projects.find(project => project.id === pool.project)?.name} · {count(pool.agents.length + pool.native.length, 'member')}</span><Badge variant="outline" className="source-badge">{t(poolSource(pool))}</Badge></span><span className="object-state">{t(poolStates[pool.state])}</span><ChevronRight size={17} /></button>)}</div>
                    : section === 'worktrees' ? <div className="object-list">{filteredTrees.map(tree => <button key={tree.id} className="object-row" data-focus-key={'worktrees:' + tree.id} onClick={() => open('worktrees', tree.id)}><span className="object-icon"><GitBranch size={21} /></span><span className="object-body"><strong>{tree.name}</strong><span className="branch-label">{tree.branch}</span><span className="muted">{projects.find(project => project.id === tree.project)?.name} · {tree.owner}</span></span><span className="object-state"><span>{partial ? t('No complete observation') : <TreeState tree={tree} />}</span><span className="muted">{datetime(tree.observedAt)}</span></span><ChevronRight size={17} /></button>)}</div>
                      : section === 'projects' ? <div className="project-list">{filteredProjects.map(project => <button key={project.id} className="project-row" data-focus-key={'projects:' + project.id} onClick={() => open('projects', project.id)}><ProjectMark id={project.id} /><span><strong>{project.name}</strong><span className="project-description">{project.description}</span><span className="muted">{count(scopedAgents.filter(agent => agent.project === project.id).length, 'agent')} · {count(scopedTrees.filter(tree => tree.project === project.id).length, 'worktree')}</span><span className="saved-estimate"><Clock3 size={14} /><SavedProgress project={project} /></span></span><ChevronRight size={18} /></button>)}</div>
                        : <div className="object-list">{filteredTools.map(tool => <button key={tool.id} className="object-row tool-row" data-focus-key={'tools:' + tool.id} onClick={() => open('tools', tool.id)}><span className="object-icon"><Wrench size={21} /></span><span className="object-body"><strong>{tool.name}</strong><span className="muted">{t(tool.purpose)}</span><span className="tool-version">{t('Demo version {version}', { version: tool.version })}</span></span><span className="object-state">{partial ? t('No complete observation') : t(tool.state)}</span><ChevronRight size={17} /></button>)}</div>}
              </div></div>}
              <footer className="content-footer"><span><Clock3 size={14} />{t(scenario === 'stale' ? 'Stale snapshot: {date}' : 'Observed: {date}', { date: datetime(observed) })}</span><span>{t('Synthetic data · read only')}</span></footer>
            </>}
        </>}
      </main>
    </div>
  </div></div>;
}
