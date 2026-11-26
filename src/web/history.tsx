/** Virtualized transcript and discussion feeds with independent older and live continuations. */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import type { Page, Coverage, Observation, Topic, SessionHistory, PoolHistory } from '@agent-hub/domain';
import { ArrowDown, Check, ChevronDown, Wrench, X } from 'lucide-react';
import { Button } from '../components/ui/button';
import { useRead, client, errorCode, useReadSignal } from './data';
import { EmptyRows, Text, useWebText } from './ui';
import { mergeChat, mergeTranscript } from './model';
import { mergeHistoryPage, readHistoryBoundary } from './history-window';

/** A validated history page projected into the common feed. */
type FeedPage<T> = { items: T[]; page: Page; coverage: Coverage; observations: Observation[] };

/** The opaque cursor and the opening edge must belong to the same API query. */
type Position = { edge: 'start' | 'tail'; cursor?: string | null; direction?: 'older' | 'newer' };

const OLDER_THRESHOLD = 120;
const END_THRESHOLD = 64;

/** Loads older pages on approach to the top and follows the live tail while the reader stays near it. */
function History<T>({ topic, edge = 'tail', load, merge, render, identity, position = identity }: {
  topic: Topic; edge?: Position['edge']; load: (position: Position, signal: AbortSignal) => Promise<FeedPage<T>>;
  merge: (previous: T[], incoming: T[], older: boolean) => T[];
  render: (item: T) => ReactNode; identity: (item: T) => string; position?: (item: T) => string;
}) {
  const { label } = useWebText();
  const { visible, matched, refresh } = useReadSignal(topic);
  const [current, setCurrent] = useState<FeedPage<T> | null>(null);
  const [nearTop, setNearTop] = useState(true);
  const [unread, setUnread] = useState(false);
  const [focused, setFocused] = useState<string | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [olderError, setOlderError] = useState<string | null>(null);
  const [retryLive, setRetryLive] = useState(0);
  const [retryOlder, setRetryOlder] = useState(0);
  const applied = useRef<FeedPage<T> | null>(null);
  const restart = useRef(false);
  const openingEdge = useRef(edge);
  const olderConsumed = useRef(new Set<string>());
  const viewport = useRef<HTMLDivElement>(null);
  const opened = useRef(false);
  const items = current?.items;
  const keys = useMemo(() => {
    const seen = new Set<string>();
    // The first row keeps the message ID when earlier parts merge into it. Separate
    // conflicting or disjoint fragments with that ID still need distinct React keys.
    return items?.map(item => {
      const id = identity(item);
      const occurrence = seen.has(id);
      seen.add(id);
      return occurrence ? JSON.stringify(['fragment', id, position(item)]) : JSON.stringify(['message', id]);
    });
  }, [items, identity, position]);
  const focusedIndex = focused === null ? -1 : keys?.indexOf(focused) ?? -1;
  const getItemKey = useCallback((index: number) => keys![index], [keys]);
  const virtualizer = useVirtualizer({
    count: items?.length ?? 0,
    getScrollElement: () => viewport.current,
    getItemKey,
    estimateSize: () => 100,
    overscan: 5,
    paddingStart: 14,
    paddingEnd: 48,
    gap: 8,
    anchorTo: 'end',
    followOnAppend: true,
    scrollEndThreshold: END_THRESHOLD,
    rangeExtractor: range => {
      const indices = defaultRangeExtractor(range);
      // Keep the active control mounted if its row leaves the visible range.
      if (focusedIndex >= 0 && !indices.includes(focusedIndex)) indices.push(focusedIndex);
      return indices.sort((a, b) => a - b);
    },
  });

  useLayoutEffect(() => {
    if (!opened.current && items?.length) {
      opened.current = true;
      virtualizer.scrollToEnd();
    }
  }, [items, virtualizer]);

  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    const { signal } = controller;

    /** Opens the latest page and drains any forward-only or live backlog in cursor order. */
    async function readLive() {
      const saved = applied.current;
      /** Opens a forward-only source from its retained start when tail is unsupported. */
      async function read(cursor: string | null) {
        try {
          return await load({ edge: openingEdge.current, cursor, direction: cursor ? 'newer' : undefined }, signal);
        } catch (failure) {
          if (signal.aborted || cursor || openingEdge.current !== 'tail' || errorCode(failure) !== 'unsupported_capability') throw failure;
          const first = await load({ edge: 'start' }, signal);
          if (!signal.aborted) openingEdge.current = 'start';
          return first;
        }
      }
      const restarting = restart.current;
      const cursor = restarting ? null : saved?.page.next ?? saved?.page.resume ?? null;
      const result = await readHistoryBoundary(cursor, read, signal);
      let incoming = result.value;
      const seen = new Set<string>();
      while (incoming.page.next && !signal.aborted) {
        const cursor = incoming.page.next;
        if (seen.has(cursor)) throw new Error('invalid_projection');
        seen.add(cursor);
        const next = await read(cursor);
        incoming = { ...next, ...mergeHistoryPage(incoming, next, merge, false) };
      }
      if (signal.aborted) return;

      const previous = applied.current;
      const reset = !previous || restarting || result.reset;
      const next = reset ? incoming : { ...incoming, ...mergeHistoryPage(previous, incoming, merge, false),
        coverage: previous.page.previous || !incoming.items.length ? previous.coverage : incoming.coverage };
      if (reset) {
        restart.current = false;
        olderConsumed.current.clear();
        setOlderError(null);
      }
      const before = previous?.items.at(-1);
      const after = next.items.at(-1);
      if (before && after && identity(before) !== identity(after) && !virtualizer.isAtEnd()) setUnread(true);
      const committed = !reset && !incoming.items.length ? { ...next, items: previous.items } : next;
      applied.current = committed;
      setCurrent(committed);
      setLiveError(null);
    }

    void readLive().catch(failure => { if (!signal.aborted) setLiveError(errorCode(failure)); });
    return () => controller.abort();
  }, [visible, matched, refresh, retryLive]);

  const olderCursor = current?.page.previous;
  useEffect(() => {
    if (!visible || !nearTop || !olderCursor || (viewport.current?.scrollTop ?? 0) > OLDER_THRESHOLD) return;
    const controller = new AbortController();
    const { signal } = controller;
    setOlderError(null);
    void load({ edge: openingEdge.current, cursor: olderCursor, direction: 'older' }, signal).then(incoming => {
      const previous = applied.current;
      if (signal.aborted || previous?.page.previous !== olderCursor) return;
      olderConsumed.current.add(olderCursor);
      const next = { ...incoming, ...mergeHistoryPage(previous, incoming, merge, true) };
      if (next.page.previous && olderConsumed.current.has(next.page.previous)) throw new Error('invalid_projection');
      applied.current = next;
      setCurrent(next);
    }).catch(failure => {
      if (!signal.aborted && applied.current?.page.previous === olderCursor) setOlderError(errorCode(failure));
    });
    return () => controller.abort();
  }, [visible, nearTop, olderCursor, retryOlder]);

  const coverage = current && label(current.coverage.scope) + ' · ' + label(current.coverage.state);
  return <section className="web-history">
    {coverage && <div className="web-history-bar"><span className="web-history-coverage" title={coverage}>{coverage}</span></div>}
    {liveError && <p role="status" className="web-warning">{label(liveError)}{' '}
      <Button variant="ghost" size="sm" onClick={() => setRetryLive(value => value + 1)}>{label('Retry')}</Button>
    </p>}
    {olderError && <p role="status" className="web-warning">{label(olderError)}{' '}
      <Button variant="ghost" size="sm" onClick={() => {
        if (olderError === 'stale_boundary') {
          restart.current = true;
          setRetryLive(value => value + 1);
        } else setRetryOlder(value => value + 1);
      }}>{label('Retry')}</Button>
    </p>}
    <div className="web-history-body">
      <div className="web-transcript" ref={viewport} tabIndex={0} role="region" aria-label={label('History')} onScroll={event => {
        const area = event.currentTarget;
        setNearTop(area.scrollTop <= OLDER_THRESHOLD);
        if (area.scrollHeight - area.clientHeight - area.scrollTop <= END_THRESHOLD) setUnread(false);
      }}>
        {items?.length ? <ol className="web-history-list" role="list" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map(row => {
            const item = items[row.index];
            return <li className="web-history-entry" key={row.key} data-index={row.index} ref={virtualizer.measureElement}
              aria-posinset={row.index + 1} aria-setsize={items.length} style={{ transform: `translateY(${row.start}px)` }}
              onFocus={() => setFocused(getItemKey(row.index))} onBlur={event => {
                if (!event.currentTarget.contains(event.relatedTarget)) setFocused(null);
              }}>{render(item)}</li>;
          })}
        </ol> : current ? <EmptyRows count={0} observations={current.observations} />
          : !liveError && <p role="status">{label('Loading')}</p>}
      </div>
      {unread && <div className="web-history-follow">
        <Button size="sm" onClick={() => {
          viewport.current?.focus({ preventScroll: true });
          virtualizer.scrollToEnd();
          setUnread(false);
        }}>
          <span>{label('New messages')}</span><ArrowDown size={15} aria-hidden="true" />
        </Button>
      </div>}
      <span className="sr-only" role="status">{unread ? label('New messages') : ''}</span>
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

/** Returns the source's stable identity for a transcript group head. */
function transcriptId(item: SessionHistory['entries'][number]) {
  return item.head.id;
}

/** Returns the message ID, which survives a change in its first retained part. */
function discussionId(item: PoolHistory['items'][number]) {
  return item.id;
}

/** Distinguishes unjoined discussion fragments that share a message ID. */
function discussionPosition(item: PoolHistory['items'][number]) {
  return item.position;
}

/** Session history opens at the retained tail and discloses unmatched results. */
export function Transcript({ id, execution }: { id: string; execution?: string | null }) {
  const { label } = useWebText();
  return <History<SessionHistory['entries'][number]> key={JSON.stringify([id, execution])} topic={`session:${id}:history`} identity={transcriptId}
    merge={mergeTranscript} load={async (position, signal) => {
      const { data, page, observations } = await client.get('sessionHistory', { params: { id }, query: { execution, ...position, limit: 12 }, signal });
      return { items: data.entries, page, observations, coverage: data.coverage };
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

/** Pool discussion resolves participant names and merges multipart messages. */
export function Discussion({ id, bidirectional }: { id: string; bidirectional: boolean }) {
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
  return <History<PoolHistory['items'][number]> key={JSON.stringify([id, bidirectional])} topic={`pool:${id}:history`} edge={bidirectional ? 'tail' : 'start'}
    identity={discussionId} position={discussionPosition} merge={mergeChat} load={async (position, signal) => {
      const { data, page, observations } = await client.get('poolHistory', { params: { id }, query: { ...position, limit: 12 }, signal });
      return { items: data.items, page, observations, coverage: data.coverage };
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
