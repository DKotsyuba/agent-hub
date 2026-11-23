/** Session and Pool details, proof-gated content, and cancellable clipboard actions. */
import { useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Capabilities, Pool, PoolMember, PoolSection, SessionDetail, Topic } from '@agent-hub/domain';
import { Button } from '../components/ui/button';
import { Choice } from '../components/hub-primitives';
import { client, errorCode, LiveContext, usePagedRead, useRead } from './data';
import { readPoolContent, readPoolExport, readPoolRecord, readSessionText } from './content';
import { Discussion, Transcript } from './history';
import { mergeChat, modelTitle } from './model';
import { CoverageLine, EmptyRows, Expand, Facts, Link, ReadState, sessionHref, Sources, StatusBadge, Text, type EvidenceScope, useWebText } from './ui';

/** Clipboard output is only released after the complete read validates; Escape aborts the operation. */
function CopyAction({ title, load }: { title: string; load: (signal: AbortSignal) => Promise<string> }) {
  const { label } = useWebText();
  const { visible } = useContext(LiveContext);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState('');
  const operation = useRef<AbortController | null>(null);
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && operation.current) {
        event.preventDefault();
        operation.current.abort();
      }
    };
    window.addEventListener('keydown', cancel);
    return () => {
      window.removeEventListener('keydown', cancel);
      operation.current?.abort();
    };
  }, [visible]);
  return <div className="web-controls">
    <Button variant="outline" disabled={pending} onClick={async () => {
      if (operation.current) return;
      const controller = new AbortController();
      operation.current = controller;
      setPending(true);
      setNotice('');
      try {
        if (!navigator.clipboard) throw new Error('clipboard_unavailable');
        // Promise-backed writes keep browser activation while the fenced read completes.
        const content = load(controller.signal).then(text => {
          controller.signal.throwIfAborted();
          return new Blob([text], { type: 'text/plain' });
        });
        await navigator.clipboard.write([new ClipboardItem({ 'text/plain': content })]);
        setNotice('Copied');
      } catch (error) {
        setNotice(controller.signal.aborted ? 'Cancelled' : errorCode(error) === 'invalid_projection' ? 'Copy failed' : errorCode(error));
      } finally {
        operation.current = null;
        setPending(false);
      }
    }}>{label(title)}</Button>
    {pending && <Button variant="ghost" onClick={() => operation.current?.abort()}>{label('Cancel')}</Button>}
    {notice && <span role="status">{label(notice)}</span>}
  </div>;
}

/** Presents proof for historical and current binding scopes separately from raw lifecycle. */
function Lineage({ value }: { value: NonNullable<SessionDetail['lineage']> }) {
  const { label, clock } = useWebText();
  const execution = (fact: typeof value.selected) => fact && <Link className="web-link" href={sessionHref(value.match.sessionId, fact.executionRef)}>#{fact.sequence} · {label(fact.rawStatus)}</Link>;
  return <><Facts rows={[[ 'Match', label(value.match.match)], ['Store fenced', value.storeFenced], ['Pin', label(value.pinState)],
    ['Selected execution', execution(value.selected)], ['Latest retained execution', execution(value.retainedLatest)],
    ['Restart / resume', label(value.restartResume)], ['Lineage terminal', value.lineageTerminal], ['Terminal outcome', value.terminalOutcome && label(value.terminalOutcome)],
    ['Success commit', label(value.successCommit)], ['Cleanup', label(value.cleanup)], ['Pool observation', clock(value.poolObservedAtMs)],
    ['Status observation', clock(value.statusObservedAtMs)], ['Sampled', clock(value.sampledAtMs)]]} /><CoverageLine value={value.coverage} /></>;
}

/** Initial task and saved result are queried only through their proof-aware routes. */
function SessionText({ id, execution, initial, evidence = [] }: { id: string; execution: string | null; initial: boolean; evidence?: EvidenceScope[] }) {
  const { label } = useWebText();
  const read = useRead(id + ':' + execution + ':' + initial, signal => readSessionText(initial ? 'initialTask' : 'sessionResult', id, { execution }, signal),
    `session:${id}:${initial ? 'initial-task' : 'result'}`);
  return <ReadState read={read}>{value => <>
    <p className="web-muted">{value.reason ? label('Initial task unverified · see retained history') + ' · ' + value.reason : label(value.provenance)}</p>
    {value.text !== null && <Text>{value.text}</Text>}
    {!initial && value.text !== null && !read.error && <CopyAction title="Copy result" load={async () => value.text!} />}
    <Sources items={value.observations} topic={`session:${id}:${initial ? 'initial-task' : 'result'}`} title={initial ? 'Initial task' : 'result'} additional={evidence} />
  </>}</ReadState>;
}

/** Shows the verified task proof on demand and leaves unverified history clearly attributed. */
function InitialTaskProof({ id, execution, capabilities }: { id: string; execution: string | null; capabilities?: Capabilities }) {
  const { label } = useWebText();
  const [open, setOpen] = useState(false);
  const supported = capabilities?.initialTaskCurrent === 'supported' || capabilities?.initialTaskStrict === 'supported';
  return <details className="web-expand" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{label('Initial task')}</summary>
    {open && (supported ? <SessionText id={id} execution={execution} initial />
      : <p>{label('Initial task unverified · see retained history')}</p>)}
  </details>;
}

/** Tab selection is rendered through the shell's shareable detail navigation. */
type DetailTabs = (tabs: string[], content: ReactNode, extra?: string[]) => ReactNode;

/** Sessions display one selected execution, independent lineage evidence, and its retained transcript. */
export function SessionDetails({ id, execution, tab, tabs }: { id: string; execution: string | null; tab: string; tabs: DetailTabs }) {
  const { label, clock, duration } = useWebText();
  const read = useRead(id + ':' + execution, signal => client.get('session', { params: { id }, query: { execution }, signal }), `session:${id}:detail`);
  return <ReadState read={read}>{({ data, observations, capabilities }) => {
    const row = data.session;
    return <>
      <h2>{row.name ?? row.id}</h2>
      <div className="web-row-meta"><StatusBadge state={row.status} /><span>{[row.model && modelTitle(row.model), row.runtime].filter(Boolean).join(' · ')}</span></div>
      {tabs(['history', 'result', 'details'], <>
      {tab === 'history' && <>
        <Transcript id={id} execution={execution} evidence={[{ title: 'Details', topic: `session:${id}:detail`, items: observations }]} />
        <div className="web-controls">
          <CopyAction title="Copy retained history" load={async signal => {
            const value = await readSessionText('sessionExport', id, { execution, mode: 'retained' }, signal);
            return label('Retained history') + ' · ' + label(value.coverage?.state ?? 'Unknown') + '\n\n' + value.text;
          }} />
          {capabilities?.exactExport === 'supported' && execution && data.lineage?.storeFenced && data.lineage.pinState === 'active' && <CopyAction title="Copy exact execution" load={async signal =>
            (await readSessionText('sessionExport', id, { execution, mode: 'exact' }, signal)).text!} />}
        </div>
        <InitialTaskProof id={id} execution={execution} capabilities={capabilities} />
      </>}
      {tab === 'result' && (capabilities?.verifiedResult === 'supported' ? <SessionText id={id} execution={execution} initial={false} evidence={[{ title: 'Details', topic: `session:${id}:detail`, items: observations }]} />
        : <p className="web-warning">{label('unsupported_capability')}</p>)}
      {tab === 'details' && <>
        <Text>{row.summary}</Text>
        <Facts rows={[[ 'Execution', row.sequence], ['Project', row.projectId && row.projectId + (row.projectInferred ? ' · ' + label('Inferred') : '')],
          ['Working directory', row.workdir], ['Created', clock(row.createdAtMs)], ['Finished', clock(row.finishedAtMs)], ['Observed', clock(row.observedAtMs)],
          ['Last progress', clock(row.progressAtMs)], ['Elapsed', duration(row.elapsedMs)], ['Silence', duration(row.silenceMs)], ['Last action', row.lastAction],
          ['Failure kind', row.failureKind], ['Failure', row.failureText], ['Delivery', data.delivery], ['Cleanup', data.cleanup],
          ['History attribution', label(data.historyAttribution)], ['Answer attribution', label(data.answerAttribution)]]} />
        {data.lineage && <Expand title="Execution lineage"><Lineage value={data.lineage} /></Expand>}
        {(['executionUsage', 'cumulativeUsage', 'toolCounts'] as const).map(key => <Expand key={key} title={key}><Facts rows={data[key].map(item => [item.metric, item.count])} /></Expand>)}
        <InitialTaskProof id={id} execution={execution} capabilities={capabilities} />
      </>}
      </>)}
      {(tab === 'details' || tab === 'result' && capabilities?.verifiedResult !== 'supported') && <Sources items={observations} topic={`session:${id}:detail`} title="Details" />}
    </>;
  }}</ReadState>;
}

/** Member identity, seat admission and bound Run evidence are independent facts. */
function Member({ item, caps }: { item: PoolMember; caps?: Capabilities }) {
  const { label } = useWebText();
  return <article className="web-subcard"><h3>{item.name ?? item.id}</h3>
    <Facts rows={[[ 'Role', item.role], ['State', item.state], ['Runtime', item.runtime], ['Task', item.task],
      ['Seat', item.seat?.id], ['Profile', item.seat?.profile], ['Admission', item.seat && label(item.seat.admission)], ['Joined', item.seat?.joined]]} />
    {item.session && (item.seat || caps?.runBindings === 'supported') && <Link className="web-link" href={sessionHref(item.session.sessionId, item.session.execution)}>{item.session.sessionId} · {label(item.session.match)}</Link>}
    {item.lineage && caps?.runProofs === 'supported' && <Expand title="Execution lineage"><Lineage value={item.lineage} /></Expand>}
  </article>;
}

/** Each section paginates its own revision and optional proposal selection. */
function PoolSectionView({ id, section, capabilities, proposal, select, evidence }: {
  id: string; section: PoolSection; capabilities?: Capabilities; proposal: string | null; select: (id: string) => void; evidence: EvidenceScope[];
}) {
  const { label, clock } = useWebText();
  const [cursor, setCursor] = useState<string | null>(null);
  const selection = section === 'members' || section === 'deliveries' ? null : proposal;
  const read = usePagedRead([id, section, selection], cursor, (cursor, signal) => client.get('poolSection', { params: { id, section }, query: { cursor, proposal: selection }, signal }), `pool:${id}:${section}`);
  return <>
    {cursor && <Button variant="ghost" onClick={() => setCursor(null)}>{label('Beginning')}</Button>}
    <ReadState read={read}>{({ data, observations, page, capabilities: own }) => <>
    <EmptyRows count={data.items.length} observations={observations} />
    {data.section === 'members' ? data.items.map(item => <Member key={item.id} item={item} caps={own ?? capabilities} />)
      : data.items.map(item => <article className="web-subcard" key={item.id}>
        <h3>{('title' in item ? item.title : null) ?? item.id}</h3>
        {'voters' in item ? <>
          <Facts rows={[[ 'State', item.state], ['Roster key', item.rosterKey], ['Voters', item.voters.join(', ')],
            ['Criteria', item.criteriaText], ['Snapshot bytes', item.snapshotBytes], ['Time', clock(item.atMs)]]} />
          <Text>{item.resultPreview}</Text><Button variant="outline" onClick={() => select(item.id)}>{label('Select proposal')}</Button>
        </> : 'choice' in item ? <>
          <Facts rows={[[ 'Proposal', item.proposalId], ['Member', item.memberId], ['Vote', item.choice], ['Validity', item.validity],
            ['Checks met', item.checksMet], ['Checks complete', item.checksComplete], ['Checks reported', item.checksReported],
            ['Event ID', item.voteEventId], ['Time', clock(item.atMs)], ['Evidence', item.evidence]]} />
          {item.criteria.map(finding => <Facts key={finding.id} rows={[[ 'Criterion', finding.title ?? finding.id], ['State', finding.state], ['Text', finding.text], ['Evidence', finding.evidence]]} />)}
        </> : 'formerSession' in item ? <>
          <Facts rows={[[ 'Member', item.memberId], ['State', item.state], ['Kind', item.kind], ['Former member', item.formerMemberId], ['Time', clock(item.atMs)]]} />
          <Text>{item.text}</Text>
          {item.formerSession && (own ?? capabilities)?.formerMember === 'supported' && <Link className="web-link" href={sessionHref(item.formerSession.sessionId, item.formerSession.execution)}>{item.formerSession.sessionId} · {label(item.formerSession.match)}</Link>}
          {item.formerLineage && (own ?? capabilities)?.runProofs === 'supported' && <Expand title="Execution lineage"><Lineage value={item.formerLineage} /></Expand>}
        </> : <><Facts rows={[[ 'Proposal', item.proposalId], ['State', item.state], ['Time', clock(item.atMs)], ['Evidence', item.evidence]]} /><Text>{item.text}</Text></>}
      </article>)}
    {page.next && <Button variant="outline" onClick={() => setCursor(page.next)}>{label('Next page')}</Button>}
    <p className="web-muted">{label('Revision')} {data.revision ?? '—'}</p><Sources items={observations} topic={`pool:${id}:${section}`} title={section} additional={evidence} />
  </>}</ReadState></>;
}

/** Reads complete revision-fenced Pool text only on explicit request. */
function PoolContentView({ id, field, proposal }: { id: string; field: 'purpose' | 'snapshot'; proposal: string | null }) {
  const { label } = useWebText();
  const [open, setOpen] = useState(false);
  const read = useRead(id + ':' + field + ':' + proposal + ':' + open, signal => open ? readPoolContent(id, field, proposal, signal) : Promise.resolve(''), `pool:${id}:content`);
  return <div className="web-subcard"><Button variant="outline" aria-expanded={open} onClick={() => setOpen(value => !value)}>{label(field === 'purpose' ? 'Full purpose' : 'Proposal snapshot')}</Button>
    {open && <ReadState read={read}>{value => <Text>{value}</Text>}</ReadState>}</div>;
}

/** Distinguishes Pool-recorded agreement from completion with verified content fields. */
function RecordView({ id, record, evidence }: { id: string; record: NonNullable<Pool['record']>; evidence: EvidenceScope[] }) {
  const { label, clock } = useWebText();
  const read = useRead(id + ':' + record.id, signal => readPoolRecord(id, record, signal), `pool:${id}:records`);
  return <ReadState read={read}>{value => <section className="web-subcard">
    <h3>{label(value.kind === 'agreement' ? 'Agreement recorded by Pool' : 'Completion record')}</h3>
    {value.kind === 'agreement' ? <>
      <Facts rows={[[ 'Event ID', value.data.eventId], ['Proposal', value.data.proposalId], ['Roster key', value.data.rosterKey], ['Recorded', clock(value.data.recordedAtMs)]]} />
      <Text>{value.text}</Text>
      {value.seats.map(item => <div key={item.seatId}><Link className="web-link" href={sessionHref(item.session.sessionId, item.session.execution)}>{item.seatId} · {label(item.session.match)}</Link> · {item.voteEventId}</div>)}
    </> : <>
      <Facts rows={[[ 'Record digest', value.data.recordDigest], ['Version', value.data.header.version], ['Commit position', value.data.header.commitPosition],
        ['Proposal', value.data.header.proposalId], ['Leader', value.data.header.leader], ['Roster count', value.data.header.rosterCount],
        ['Ballot count', value.data.header.ballotCount], ['Absent fields', value.data.header.absentFields.map(label).join(', ')], ['Completed', clock(value.data.completedAtMs)]]} />
      {value.fields.map(([field, text, digest]) => <Expand key={field} title={field}><Text>{text}</Text><Facts rows={[[ 'SHA-256', digest]]} /></Expand>)}
      <Text>{value.data.notice}</Text>
      <Expand title="Members">{value.roster.map(item => <Member key={item.id} item={item} />)}</Expand>
      <Expand title="Votes">{value.ballots.map(item => <Facts key={item.id} rows={[[ 'Member', item.memberId], ['Vote', item.choice], ['Checks met', item.checksMet], ['Validity', item.validity]]} />)}</Expand>
      <Expand title="Execution lineage">{value.facts.map((item, i) => <Lineage key={i} value={item} />)}</Expand>
    </>}
    {!read.error && <CopyAction title="Copy record" load={async () => {
      if (value.kind === 'agreement') return JSON.stringify({ ...value.data, result: value.text, ballots: value.seats }, null, 2);
      return JSON.stringify({ ...value.data, roster: value.roster, ballots: value.ballots, runFacts: value.facts,
        content: Object.fromEntries(value.fields.map(([field, text, sha256]) => [field, { text, sha256 }])) }, null, 2);
    }} />}
    <Sources items={value.observations} topic={`pool:${id}:records`} title="record" additional={evidence} />
  </section>}</ReadState>;
}

/** Pool metadata stays above section tabs and retains proposal and record provenance. */
export function PoolDetails({ id, tab, tabs, proposal, select }: {
  id: string; tab: string; tabs: DetailTabs; proposal: string | null; select: (id: string | null) => void;
}) {
  const { label, clock } = useWebText();
  const read = useRead(id, signal => client.get('pool', { params: { id }, signal }), `pool:${id}:detail`);
  return <ReadState read={read}>{({ data, observations, capabilities }) => {
    const { pool, proposalId, coverage } = data;
    const capable = capabilities?.bidirectionalHistory === 'supported';
    const record = pool.record && (pool.record.kind === 'agreement' ? capabilities?.agreementRecord : capabilities?.completionRecord) === 'supported' ? pool.record : null;
    const core = ['discussion', 'members', 'details'];
    const sections = ['members', 'proposals', 'decisions', 'criteria', 'votes', 'deliveries'];
    const extra = [...sections.slice(1), 'record'];
    const evidence: EvidenceScope[] = [{ title: 'Details', topic: `pool:${id}:detail`, items: observations }];
    return <>
      <h2>{pool.name ?? pool.id}</h2>
      <div className="web-row-meta"><StatusBadge state={pool.state} /><span>{pool.kind && label(pool.kind)}</span></div>
      {tabs(pool.kind === 'chat' ? core : [...core, ...extra], <>
      {tab === 'discussion' && <>
        <Discussion id={id} bidirectional={capable} evidence={evidence} />
        {capable && <CopyAction title="Copy discussion" load={async signal => {
          const value = await readPoolExport(id, signal);
          return [label('Retained history') + ' · ' + label(value.coverage?.state ?? 'Unknown'),
            ...value.rows.reduce((items, page) => mergeChat(items, page), []).map(item =>
              [item.authorId, clock(item.atMs), item.complete && item.valid ? null : label('Partial message'), item.parts.join('')].filter(Boolean).join(' · '))].join('\n\n');
        }} />}
      </>}
      {tab === 'details' && <>
        <Text>{pool.purposePreview}</Text><Facts rows={[[ 'Leader', pool.leader], ['Revision', pool.revision],
          ['Proposal', proposalId], ['Record', pool.record === undefined ? label('Unreported') : pool.record?.id]]} />
        <PoolContentView id={id} field="purpose" proposal={null} />
        {(proposal ?? proposalId) && <PoolContentView id={id} field="snapshot" proposal={proposal ?? proposalId} />}
      </>}
      {tab === 'record' && (record ? <RecordView id={id} record={record} evidence={evidence} /> : <p>{label(pool.record === undefined ? 'Unreported' : pool.record ? 'unsupported_capability' : 'No records')}</p>)}
      {sections.includes(tab) && <>
        {proposal && tab !== 'members' && tab !== 'deliveries' && <Choice label={label('Proposal')} value={proposal}
          options={[[proposal, proposal], ['all', label('All proposals')]]} onChange={value => { if (value === 'all') select(null); }} />}
        {tab === 'proposals' && (proposal ?? proposalId) && <PoolContentView id={id} field="snapshot" proposal={proposal ?? proposalId} />}
        <PoolSectionView key={tab + ':' + proposal} id={id} section={tab as PoolSection} capabilities={capabilities} evidence={evidence} proposal={tab === 'proposals' ? null : proposal} select={select} />
      </>}
      </>, pool.kind === 'chat' ? extra : undefined)}
      {tab === 'details' && <CoverageLine value={coverage} />}
      {(tab === 'details' || tab === 'record' && !record) && <Sources items={observations} topic={`pool:${id}:detail`} title="Details" />}
    </>;
  }}</ReadState>;
}
