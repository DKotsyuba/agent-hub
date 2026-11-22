/** Anchored transcript and chat windows with independent older and live continuations. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Page, Coverage, Observation, Topic, SessionHistory, PoolHistory } from '@agent-hub/domain';
import { Button } from '../components/ui/button';
import { client, errorCode, useReadSignal } from './data';
import { CoverageLine, EmptyRows, Expand, Sources, Text, useWebText } from './ui';
import { mergeChat, mergeTranscript } from './model';
import { appendHistoryWindow, readHistoryBoundary, retainPausedHistory } from './history-window';

/** A validated history page projected into a common anchored window. */
type WindowPage<T> = { items: T[]; page: Page; coverage: Coverage; observations: Observation[]; format: string; attribution?: string };

/** History requests preserve the opening edge while consuming its opaque continuations. */
type Position = { edge: 'start' | 'tail'; cursor?: string | null; direction?: 'older' | 'newer' };

/** Commands control only the local projection and scrolling position. */
type Command = 'start' | 'tail' | 'older' | 'newer';

/** Maintains separate live and older cursors and never moves a paused reader during catch-up. */
function History<T>({ topic, initial, load, merge, render, identity, size }: {
  topic: Topic; initial: Position['edge']; load: (position: Position, signal: AbortSignal) => Promise<WindowPage<T>>;
  merge: (previous: T[], incoming: T[], older: boolean) => T[]; render: (item: T) => ReactNode;
  identity: (item: T) => string; size: (item: T) => number;
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
      : action === 'newer' ? saved.value.page.next ?? saved.value.page.resume : paused ? saved.live : saved.value.page.resume;
    const run = async () => {
      const area = viewport.current;
      const pending = action === 'newer' || !action && !paused ? recovered.current : null;
      const recoveryEdge = saved?.value.format === 'legacy_raw' || saved?.value.format === 'legacy_forward' ? 'start' : paused ? 'tail' : edge;
      const result = pending ? { value: pending.value, reset: true }
        : await readHistoryBoundary(cursor, token => load({ edge: token ? edge : recoveryEdge, cursor: token, direction: token ? direction : undefined }, controller.signal), controller.signal);
      if (controller.signal.aborted) return;
      let page = result.value;
      const resolvedEdge = pending?.edge ?? (result.reset ? recoveryEdge : edge);
      let reset = replacing || result.reset;
      // Drain a limited burst while keeping a bounded buffer and its real page boundaries.
      if (!action && saved && !result.reset) {
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
        tail: action === 'tail' || (!saved && edge === 'tail') || (following && stillAtTail && action !== 'older'),
        start: action === 'start' || (joined.moved && action === 'newer') };
      const next = { ...page, items: joined.items, page: joined.page };
      if (action === 'tail' || action === 'newer') setUnread(0);
      consumed.current = command;
      applied.current = { value: next, edge: resolvedEdge, live: action === 'older' && !result.reset ? saved?.live ?? null : fresh };
      setCurrent(next);
      setError(null);
    };
    void run().catch(failure => { if (!controller.signal.aborted) setError(errorCode(failure)); });
    return () => controller.abort();
  }, [visible, matched, refresh, command, following]);
  const legacy = current?.format === 'legacy_raw' || current?.format === 'legacy_forward';
  return <section className="web-history">
    <div className="web-controls">
      <Button variant="outline" onClick={() => { setFollowing(false); setCommand({ action: 'start' }); }}>{label('Beginning')}</Button>
      <Button variant="outline" disabled={!current?.page.previous} onClick={() => { setFollowing(false); setCommand({ action: 'older' }); }}>{label('Older')}</Button>
      <Button variant="outline" disabled={!current?.page.next && (!unread || !current?.page.resume && !recovered.current)} onClick={() => setCommand({ action: 'newer' })}>{label('Newer')}</Button>
      <Button variant="outline" disabled={!current || legacy} onClick={() => { setFollowing(true); setCommand({ action: 'tail' }); }}>{label('Jump to latest')}{unread > 0 && ' (' + unread + ')'}</Button>
      <Button variant={following ? 'secondary' : 'outline'} aria-pressed={following} onClick={() => setFollowing(value => !value)}>{label(following ? 'Pause follow' : 'Follow')}</Button>
      <span className="web-muted" role="status">{legacy ? label('Forward-only history') : unread > 0 ? label('Unread') + ' ' + unread : null}</span>
    </div>
    {error && <p role="status" className="web-warning">{label(error)}</p>}
    <div className="web-transcript" ref={viewport} tabIndex={0} aria-label={label('History')}>
      {current ? current.items.map(item => <div key={identity(item)}>{render(item)}</div>) : !error && <p role="status">{label('Loading')}</p>}
      {current && <EmptyRows count={current.items.length} observations={current.observations} />}
    </div>
    {current && <><CoverageLine value={current.coverage} />{current.attribution && <p className="web-muted">{label(current.attribution)}</p>}<Sources items={current.observations} /></>}
  </section>;
}

/** One transcript fragment, retaining tool errors and checked completion timestamps. */
function Fragment({ value }: { value: SessionHistory['entries'][number]['head'] }) {
  const { label, clock } = useWebText();
  return <><header className="web-row-meta"><strong>{value.name ?? label(value.role)}</strong><span>{clock(value.atMs)}{value.endAtMs != null && ' → ' + clock(value.endAtMs)}</span>
    {value.error && <span className="web-caution">{label('Error')}</span>}
    {(!value.complete || !!value.omittedBytes) && <span>{label('Partial')} {value.omittedBytes ? ' · ' + value.omittedBytes + ' B' : ''}</span>}</header>
    <Text>{value.text}</Text></>;
}

const encoder = new TextEncoder();
/** Measures retained text with the same UTF-8 encoding used by the wire protocol. */
function textBytes(parts: string[]): number {
  return parts.reduce((size, part) => size + encoder.encode(part).byteLength, 0);
}

/** Session history opens at the retained start and discloses unmatched results. */
export function Transcript({ id, execution }: { id: string; execution?: string | null }) {
  const { label } = useWebText();
  return <History<SessionHistory['entries'][number]> topic={`session:${id}:history`} initial="start" identity={item => item.head.position}
    merge={mergeTranscript} size={item => textBytes([item.head, ...item.calls, ...item.results].map(part => part.text))} load={async (position, signal) => {
      const { data, page, observations } = await client.get('sessionHistory', { params: { id }, query: { execution, ...position, limit: 6 }, signal });
      return { items: data.entries, page, observations, coverage: data.coverage, format: data.format, attribution: data.attribution };
    }} render={item => <article className="web-message">
      {item.head.role === 'tool_result' && <p className="web-muted">{label('Unmatched tool result')}</p>}
      <Fragment value={item.head} />
      {(item.partialBefore || item.partialAfter) && <p className="web-muted">{label('Partial history block')}</p>}
      {!!(item.calls.length || item.results.length) && <Expand title="Tool calls and results">
        {[...item.calls, ...item.results].map(fragment => <div className="web-fragment" key={fragment.position}><Fragment value={fragment} /></div>)}
      </Expand>}
    </article>} />;
}

/** Pool discussion defaults according to the producer capability and merges multipart messages. */
export function Discussion({ id, bidirectional }: { id: string; bidirectional: boolean }) {
  const { label, clock } = useWebText();
  return <History<PoolHistory['items'][number]> topic={`pool:${id}:history`} initial={bidirectional ? 'tail' : 'start'}
    identity={item => item.id + ':' + (item.partRange?.first ?? '')} merge={mergeChat} size={item => textBytes(item.parts)} load={async (position, signal) => {
      const { data, page, observations } = await client.get('poolHistory', { params: { id }, query: { ...position, limit: 6 }, signal });
      return { items: data.items, page, observations, coverage: data.coverage, format: data.format };
    }} render={item => <article className="web-message">
      <header className="web-row-meta"><strong>{item.authorId ?? item.authorKind ?? label('Unknown')}</strong><span>{item.kind}</span><span>{clock(item.atMs)}</span></header>
      {(!item.complete || !item.valid) && <p className="web-caution">{label(!item.valid ? 'Invalid message' : 'Partial message')}</p>}
      <Text>{item.parts.join('')}</Text>
    </article>} />;
}
