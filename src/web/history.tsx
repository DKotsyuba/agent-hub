/** Anchored transcript and chat windows with independent older and live continuations. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Page, Coverage, Observation, Topic, SessionHistory, PoolHistory } from '@agent-hub/domain';
import { ArrowDown, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Info, Pause, Play, Wrench, X } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '../components/ui/dialog';
import { useRead, client, errorCode, useReadSignal } from './data';
import { CoverageLine, EmptyRows, Sources, Text, type EvidenceScope, useWebText } from './ui';
import { mergeChat, mergeTranscript } from './model';
import { appendHistoryWindow, readHistoryBoundary, retainPausedHistory } from './history-window';

/** A validated history page projected into a common anchored window. */
type WindowPage<T> = { items: T[]; page: Page; coverage: Coverage; observations: Observation[]; format: string; attribution?: string };

/** History requests preserve the opening edge while consuming its opaque continuations. */
type Position = { edge: 'start' | 'tail'; cursor?: string | null; direction?: 'older' | 'newer' };

/** Commands control only the local projection and scrolling position. */
type Command = 'start' | 'tail' | 'older' | 'newer' | 'follow';

/** Maintains separate live and older cursors and never moves a paused reader during catch-up. */
function History<T>({ topic, initial, load, merge, render, identity, size, evidence = [], actions }: {
  topic: Topic; initial: Position['edge']; load: (position: Position, signal: AbortSignal) => Promise<WindowPage<T>>;
  merge: (previous: T[], incoming: T[], older: boolean) => T[]; render: (item: T) => ReactNode;
  identity: (item: T) => string; size: (item: T) => number; evidence?: EvidenceScope[]; actions?: ReactNode;
}) {
  const { label } = useWebText();
  const { visible, matched, refresh } = useReadSignal(topic);
  const [following, setFollowing] = useState(true);
  const [unread, setUnread] = useState(0);
  const [current, setCurrent] = useState<WindowPage<T> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [command, setCommand] = useState<{ action: Command } | null>(null);
  const consumed = useRef<typeof command>(null);
  const applied = useRef<{ value: WindowPage<T>; edge: Position['edge']; live: string | null } | null>(null);
  const recovered = useRef<{ value: WindowPage<T>; edge: Position['edge'] } | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const adjustment = useRef<{ anchor?: HTMLElement; top?: number; tail?: boolean; start?: boolean } | null>(null);
  useLayoutEffect(() => {
    const area = viewport.current, change = adjustment.current;
    adjustment.current = null;
    if (!area || !change) return;
    if (change.tail) area.scrollTop = area.scrollHeight;
    else if (change.start) area.scrollTop = 0;
    else if (change.anchor?.isConnected && change.top !== undefined) area.scrollTop += change.anchor.getBoundingClientRect().top - change.top;
  }, [current]);
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    const saved = applied.current;
    // A command interrupted by page hide or invalidation remains pending until applied.
    const action = command !== consumed.current ? command?.action : undefined;
    const edge = action === 'start' || action === 'tail' ? action : saved?.edge ?? initial;
    const direction = action === 'older' ? 'older' : 'newer';
    const replacing = !saved || action === 'start' || action === 'tail';
    const paused = !action && !!saved && (!following || !!viewport.current && viewport.current.scrollHeight - viewport.current.clientHeight - viewport.current.scrollTop >= 26);
    const cursor = replacing ? null : action === 'older' ? saved.value.page.previous
      : (action === 'newer' || action === 'follow') ? saved.value.page.next ?? saved.value.page.resume : paused ? saved.live : saved.value.page.resume;
    const run = async () => {
      const area = viewport.current;
      const pending = action === 'newer' || action === 'follow' || !action && !paused ? recovered.current : null;
      const recoveryEdge = saved?.value.format === 'legacy_raw' || saved?.value.format === 'legacy_forward' ? 'start' : paused ? 'tail' : edge;
      const result = pending ? { value: pending.value, reset: true }
        : await readHistoryBoundary(cursor, token => load({ edge: token ? edge : recoveryEdge, cursor: token, direction: token ? direction : undefined }, controller.signal), controller.signal);
      if (controller.signal.aborted) return;
      let page = result.value;
      const resolvedEdge = pending?.edge ?? (result.reset ? recoveryEdge : edge);
      let reset = replacing || result.reset;
      // Drain a limited burst while keeping a bounded buffer and its real page boundaries.
      if ((!action || action === 'follow') && saved && !result.reset) {
        const seen = new Set<string>();
        while (page.page.next && seen.size < 16) {
          const next = page.page.next;
          if (seen.has(next)) throw new Error('invalid_projection');
          seen.add(next);
          const more = await load({ edge, cursor: next, direction: 'newer' }, controller.signal);
          const joined = appendHistoryWindow(page, more, merge, size, false);
          reset ||= joined.moved;
          page = { ...more, items: joined.items, page: joined.page };
        }
      }
      if (controller.signal.aborted) return;
      const fresh = page.page.next ?? page.page.resume;
      if (paused && saved) {
        if (result.reset) {
          // Keep the paused viewport and receipt clocks. The renewed page is available via Newer.
          recovered.current = { value: page, edge: resolvedEdge };
          const value = retainPausedHistory(saved.value);
          applied.current = { value, edge: resolvedEdge, live: fresh };
          setCurrent(value);
        } else {
          applied.current = { ...saved, live: fresh ?? saved.live };
        }
        const ids = new Set(saved.value.items.map(identity));
        const added = page.items.filter(item => !ids.has(identity(item))).length;
        if (added || result.reset) setUnread(value => result.reset ? Math.max(1, added) : Math.min(999, value + added));
        setError(null);
        return;
      }
      recovered.current = null;
      const joined = reset ? { ...page, moved: true } : appendHistoryWindow(saved!.value, page, merge, size, action === 'older');
      const stillAtTail = !!area && area.scrollHeight - area.clientHeight - area.scrollTop < 26;
      const anchor = Array.from(area?.children ?? []).find(item => item.getBoundingClientRect().bottom > area!.getBoundingClientRect().top) as HTMLElement | undefined;
      adjustment.current = { anchor, top: anchor?.getBoundingClientRect().top,
        tail: action === 'tail' || action === 'follow' || (!saved && edge === 'tail') || (!!saved && following && stillAtTail && action !== 'older'),
        start: action === 'start' || !saved || (joined.moved && action === 'newer') };
      const next = { ...page, items: joined.items, page: joined.page };
      if (action === 'tail' || action === 'follow' || action === 'newer') setUnread(0);
      consumed.current = command;
      applied.current = { value: next, edge: resolvedEdge, live: action === 'older' && !result.reset ? saved?.live ?? null : fresh };
      setCurrent(next);
      setError(null);
    };
    void run().catch(failure => { if (!controller.signal.aborted) setError(errorCode(failure)); });
    return () => controller.abort();
  }, [visible, matched, refresh, command, following]);
  const legacy = current?.format === 'legacy_raw' || current?.format === 'legacy_forward';
  /** Resumes from the newest supported edge, or consumes the forward continuation on legacy sources. */
  function resume() {
    setFollowing(true);
    if (!legacy || current?.page.next || current?.page.resume || recovered.current) {
      setCommand({ action: legacy ? 'follow' : 'tail' });
    } else if (viewport.current) {
      viewport.current.scrollTop = viewport.current.scrollHeight;
      setUnread(0);
    }
  }
  const controls = [
    { title: 'Beginning', icon: ChevronsLeft, run: () => { setFollowing(false); setCommand({ action: 'start' }); } },
    { title: 'Older', icon: ChevronLeft, disabled: !current?.page.previous, run: () => { setFollowing(false); setCommand({ action: 'older' }); } },
    { title: 'Newer', icon: ChevronRight, disabled: !current?.page.next && (!unread || !current?.page.resume && !recovered.current), run: () => setCommand({ action: 'newer' }) },
    { title: 'Jump to latest', icon: ChevronsRight, disabled: !current || legacy, run: resume },
    { title: following ? 'Pause follow' : 'Follow', icon: following ? Pause : Play, disabled: !current, active: following, run: following ? () => setFollowing(false) : resume },
  ];
  return <section className="web-history">
    <div className="web-history-bar">
      <div className="web-history-context">
        <Dialog>
          <DialogTrigger asChild><Button variant="ghost" size="sm" className="web-history-info" title={label('History information')}
            aria-label={label('History information')}><Info size={16} /><span>{label('History info')}</span></Button></DialogTrigger>
          <DialogContent className="web-history-dialog">
            <DialogTitle>{label('History information')}</DialogTitle>
            <DialogDescription>{label('Retained history')}</DialogDescription>
            {current && <><CoverageLine value={current.coverage} />{current.attribution && <p className="web-muted">{label(current.attribution)}</p>}</>}
            {legacy && <p className="web-muted">{label('Forward-only history')}</p>}
            <Sources items={current?.observations ?? []} topic={topic} title="History" additional={evidence} />
            {actions}
          </DialogContent>
        </Dialog>
        {current && <span className="web-history-coverage">{label(current.coverage.scope)} · {label(current.coverage.state)}</span>}
      </div>
      <div className="web-history-controls" role="group" aria-label={label('History navigation')}>
        {controls.map(({ title, icon: Icon, disabled, active, run }) =>
          <Button key={title === 'Follow' || title === 'Pause follow' ? 'follow' : title} variant={active ? 'secondary' : 'ghost'} size="icon"
            aria-label={label(title)} title={label(title)} disabled={disabled} onClick={run}>
            <Icon size={17} aria-hidden="true" />
          </Button>)}
      </div>
    </div>
    {error && <p role="status" className="web-warning">{label(error)}</p>}
    <div className="web-history-body">
      <div className="web-transcript" ref={viewport} tabIndex={0} role="region" aria-label={label('History')}>
        {current ? current.items.map(item => <div className="web-history-entry" key={identity(item)}>{render(item)}</div>)
          : !error && <p role="status">{label('Loading')}</p>}
        {current && <EmptyRows count={current.items.length} observations={current.observations} />}
      </div>
      {unread > 0 && <div className="web-history-follow">
        <Button size="sm" onClick={() => { viewport.current?.focus({ preventScroll: true }); resume(); }}>
          <ArrowDown size={15} aria-hidden="true" /><span>{label('New messages')} · {unread}</span>
        </Button>
      </div>}
      <span className="sr-only" role="status">{unread > 0 ? label('New messages') + ' · ' + unread : ''}</span>
    </div>
  </section>;
}

/** One source fragment from a retained transcript group. */
type FragmentValue = SessionHistory['entries'][number]['head'];

/** Empty tool arguments do not occupy a preview or a disclosure body. */
function fragmentText(value: FragmentValue) {
  return value.role === 'tool_call' && /^\s*\{\s*\}\s*$/.test(value.text) ? '' : value.text;
}

/** Preserves fragment attribution, timestamps, completeness, and full retained text. */
function Fragment({ value }: { value: FragmentValue }) {
  const { label, clock } = useWebText();
  const text = fragmentText(value);
  return <><header className="web-chat-meta"><strong>{value.name ?? label(value.role)}</strong><span>{clock(value.atMs)}{value.endAtMs != null && ' → ' + clock(value.endAtMs)}</span>
    {value.error && <span className="web-caution">{label('Error')}</span>}
    {(!value.complete || !!value.omittedBytes) && <span>{label('Partial')} {value.omittedBytes ? ' · ' + value.omittedBytes + ' B' : ''}</span>}</header>
    {text && <Text>{text}</Text>}</>;
}

/** Shortens the display of shell wrappers and MCP namespaces while retaining original payloads. */
function toolPreview(value: FragmentValue) {
  const raw = fragmentText(value).trim();
  const shell = value.name === 'command' && raw.match(/^(?:\S*\/)?([\w-]+)\s+-[a-z]*c\s+(['"])([\s\S]*)\2$/);
  return shell ? { name: shell[1], text: shell[3] }
    : { name: value.name?.split('/').pop()?.replaceAll('_', ' '), text: raw };
}

/** A compact tool group keeps its full calls and results available inline. */
function ToolRow({ head, related, partial }: { head: FragmentValue; related: FragmentValue[]; partial?: boolean }) {
  const { label, duration } = useWebText();
  const { name, text } = toolPreview(head);
  const outcome = [...related].reverse().find(part => part.role === 'tool_result') ?? head;
  const end = outcome.endAtMs ?? head.endAtMs;
  const elapsed = head.atMs != null && end != null && end >= head.atMs ? duration(end - head.atMs) : null;
  return <details className="web-tool-row">
    <summary>
      <Wrench size={14} aria-hidden="true" />
      <strong>{name || label(head.role)}</strong>
      {text && <code>{text}</code>}
      <span className="web-tool-state">
        {outcome.error === false && <span className="web-tool-ok" role="img" aria-label={label('Tool succeeded')}><Check size={14} /></span>}
        {outcome.error === true && <span className="web-tool-error" role="img" aria-label={label('Error')}><X size={14} /></span>}
        {elapsed && <span>{elapsed}</span>}
        {partial && <span className="web-caution">{label('Partial')}</span>}
        <ChevronDown size={13} aria-hidden="true" className="web-tool-chevron" />
      </span>
    </summary>
    <div className="web-tool-content">
      {head.role === 'tool_result' && <p className="web-muted">{label('Unmatched tool result')}</p>}
      <Fragment value={head} />
      {related.map(part => <div className="web-fragment" key={part.position}><Fragment value={part} /></div>)}
      {partial && <p className="web-muted">{label('Partial history block')}</p>}
    </div>
  </details>;
}

const encoder = new TextEncoder();
/** Measures retained text with the same UTF-8 encoding used by the wire protocol. */
function textBytes(parts: string[]): number {
  return parts.reduce((size, part) => size + encoder.encode(part).byteLength, 0);
}

/** Session history opens at the retained start and discloses unmatched results. */
export function Transcript({ id, execution, evidence, actions }: {
  id: string; execution?: string | null; evidence: EvidenceScope[]; actions?: ReactNode;
}) {
  const { label } = useWebText();
  return <History<SessionHistory['entries'][number]> evidence={evidence} actions={actions} topic={`session:${id}:history`} initial="start" identity={item => item.head.position}
    merge={mergeTranscript} size={item => textBytes([item.head, ...item.calls, ...item.results].map(part => part.text))} load={async (position, signal) => {
      const { data, page, observations } = await client.get('sessionHistory', { params: { id }, query: { execution, ...position, limit: 12 }, signal });
      return { items: data.entries, page, observations, coverage: data.coverage, format: data.format, attribution: data.attribution };
    }} render={item => {
      const { head } = item;
      const related = [...item.calls, ...item.results].filter(part => part.position !== head.position);
      const partial = item.partialBefore || item.partialAfter;
      if (head.role === 'tool' || head.role === 'tool_call' || head.role === 'tool_result') {
        return <ToolRow head={head} related={related} partial={partial} />;
      }
      return <article className="web-message" data-role={head.role}>
        <Fragment value={head} />
        {partial && <p className="web-muted">{label('Partial history block')}</p>}
        {related.map(part => <ToolRow key={part.position} head={part} related={[]} />)}
      </article>;
    }} />;
}

/** Pool discussion defaults according to the producer capability and merges multipart messages. */
export function Discussion({ id, bidirectional, evidence, actions }: {
  id: string; bidirectional: boolean; evidence: EvidenceScope[]; actions?: ReactNode;
}) {
  const { label, clock } = useWebText();
  const roster = useRead(id, signal => client.get('poolSection', { params: { id, section: 'members' }, signal }), `pool:${id}:members`);
  const data = roster.value?.data;
  const members = data?.section === 'members' ? data.items : [];
  const names = new Map<string, string>();
  for (const [index, member] of members.entries()) {
    const shared = member.name === null || members.some(other => other !== member && other.name === member.name);
    const name = shared ? `${label('Member')} ${index + 1}` : member.name!;
    names.set(member.id, name);
    if (member.seat) names.set(member.seat.id, name);
  }
  return <History<PoolHistory['items'][number]> evidence={evidence} actions={actions} topic={`pool:${id}:history`} initial={bidirectional ? 'tail' : 'start'}
    identity={item => item.id + ':' + (item.partRange?.first ?? '')} merge={mergeChat} size={item => textBytes(item.parts)} load={async (position, signal) => {
      const { data, page, observations } = await client.get('poolHistory', { params: { id }, query: { ...position, limit: 12 }, signal });
      return { items: data.items, page, observations, coverage: data.coverage, format: data.format };
    }} render={item => <article className="web-message" data-role={item.kind === 'direct_message' ? 'direct'
      : item.kind === 'message' ? 'chat' : 'event'}>
      <header className="web-chat-meta">
        <strong title={item.authorId ?? undefined}>{(item.authorId && names.get(item.authorId)) ?? label(item.authorKind ?? 'Unknown sender')}</strong>
        {item.atMs !== null && <span>{clock(item.atMs)}</span>}
        {item.kind === 'direct_message' && item.recipientId && <span className="web-chat-direct" title={item.recipientId}>{label('Direct to')} {names.get(item.recipientId) ?? label('Unknown recipient')}</span>}
        {!['message', 'direct_message'].includes(item.kind) && <span>{label(item.kind)}</span>}
      </header>
      {(!item.complete || !item.valid) && <p className="web-caution">{label(!item.valid ? 'Invalid message' : 'Partial message')}</p>}
      <Text>{item.parts.join('')}</Text>
    </article>} />;
}
