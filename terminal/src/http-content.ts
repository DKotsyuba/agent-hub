/** Verified content reads for the terminal's HTTP mode. */
import type { createHubClient } from '../../packages/client/src/index.ts';
import type { ApiResponse } from '../../packages/domain/src/index.ts';
import { assembleText, verifyText } from '../../packages/view-model/src/content.ts';

type Hub = ReturnType<typeof createHubClient>;

/** A finite content operation is cancelled by the caller or after a maximum wait. */
function deadline(signal: AbortSignal): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
}

/** Validates the saved answer's execution, byte boundary and full digest before display. */
export async function loadHttpResult(http: Hub, id: string, execution: string | null, sequence: number, caller: AbortSignal) {
  if (!execution) throw new Error('execution_unavailable');
  const signal = deadline(caller);
  let digest = '';
  const text = await assembleText(async cursor => {
    const response = await http.get('sessionResult', { params: { id }, query: { execution, cursor }, signal });
    const { proof, content } = response.data;
    if (response.capabilities?.verifiedResult !== 'supported' || proof.execution !== execution || proof.sequence !== sequence) throw new Error('result_execution_changed');
    digest = proof.sha256;
    return { content, next: response.page.next, fence: digest };
  }, signal);
  return verifyText(text, digest);
}

/** Assemble the separately proved retained root task or report its explicit reason. */
export async function loadHttpInitialTask(http: Hub, id: string, execution: string | null, caller: AbortSignal) {
  const signal = deadline(caller);
  const first = await http.get('initialTask', { params: { id }, query: { execution }, signal });
  if (first.data.state === 'unverified') return first.data;
  const { proof } = first.data;
  const capability = proof.kind === 'strict' ? 'initialTaskStrict' : 'initialTaskCurrent';
  let pages = 0;
  const text = await assembleText(async cursor => {
    pages++;
    const response = cursor === null ? first : await http.get('initialTask', { params: { id }, query: { execution, cursor }, signal });
    if (response.data.state !== 'verified' || response.capabilities?.[capability] !== 'supported') throw new Error('initial_task_unverified');
    return { ...response.data, next: response.page.next, fence: JSON.stringify(response.data.proof) };
  }, signal, 524_288);
  await verifyText(text, proof.root.sha256);
  return { state: 'verified' as const, text, mode: proof.kind, sha256: proof.root.sha256, executionRef: proof.root.execution, totalBytes: first.data.content.totalBytes, pages, storeId: null, agentId: id, pinId: null };
}

/** Copies one fixed retained boundary or a pinned, digest-verified execution. */
export async function loadHttpExport(http: Hub, id: string, execution: string | null, mode: 'retained' | 'exact', caller: AbortSignal) {
  if (mode === 'exact' && !execution) throw new Error('execution_unavailable');
  const signal = deadline(caller);
  let digest: string | undefined, coverage: string | undefined;
  const text = await assembleText(async cursor => {
    const response = await http.get('sessionExport', { params: { id }, query: { execution, cursor, mode }, signal });
    const { data } = response;
    if (data.mode !== mode) throw new Error('export_mode_changed');
    if (data.mode === 'exact') {
      if (response.capabilities?.exactExport !== 'supported' || data.proof.content.execution !== execution) throw new Error('export_execution_changed');
      digest = data.proof.content.sha256;
    }
    coverage = data.coverage.state;
    return { content: data.content, next: response.page.next, fence: JSON.stringify([data.boundary, data.coverage, data.mode === 'exact' && data.proof]) };
  }, signal);
  return digest ? verifyText(text, digest) : `Retained session lineage · coverage ${coverage ?? 'unknown'}\n\n${text}`;
}

/** Read long Pool purpose or snapshot text under one revision. */
export async function loadHttpPoolContent(http: Hub, id: string, field: 'purpose' | 'snapshot', proposal: string | undefined, caller: AbortSignal) {
  const signal = deadline(caller);
  return assembleText(async cursor => {
    const response = await http.get('poolContent', { params: { id, field }, query: { proposal, cursor }, signal });
    const { data } = response;
    if (data.poolId !== id || data.field !== field || (proposal && data.proposalId !== proposal)) throw new Error('pool_content_changed');
    return { content: data.content, next: response.page.next, fence: JSON.stringify([data.revision, data.proposalId]) };
  }, signal, field === 'purpose' ? 8192 : 65536);
}

/** Traverses the frozen Pool history continuation and rejects legacy unfenced export. */
export async function loadHttpPoolExport(http: Hub, id: string, caller: AbortSignal) {
  const signal = deadline(caller);
  const lines: string[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null, boundary: string | undefined, coverage: string | undefined, previous = -1n, bytes = 0;
  do {
    const response: ApiResponse<'poolHistory'> = await http.get('poolHistory', {
      params: { id }, query: { edge: 'start', direction: cursor ? 'newer' : null, cursor, limit: 100 }, signal,
    });
    const { data, page } = response;
    boundary ??= data.upperBound ?? undefined;
    coverage ??= data.coverage.state;
    if (data.poolId !== id || data.format !== 'window' || !boundary || data.upperBound !== boundary || data.coverage.state !== coverage) throw new Error('pool_export_boundary_changed');
    for (const row of data.items) {
      const position = BigInt(row.position);
      if (position <= previous) throw new Error('pool_export_order');
      previous = position;
      const line = `#${row.position} · ${row.authorId ?? row.authorKind ?? 'Unknown'} · ${row.kind}${row.complete ? '' : ' · incomplete'}${row.valid ? '' : ' · invalid'}\n${row.parts.join('')}`;
      bytes += new TextEncoder().encode(line).length;
      if (bytes > 16 * 1024 * 1024) throw new Error('pool_export_budget');
      lines.push(line);
    }
    cursor = page.next;
    if (cursor !== null) {
      if (!data.items.length || cursors.has(cursor) || cursors.size >= 4096) throw new Error('pool_export_cursor');
      cursors.add(cursor);
    }
  } while (cursor !== null);
  return `Pool ${id} · retained journal · coverage ${coverage ?? 'unknown'}\n\n${lines.join('\n\n')}`;
}

/** Assemble agreement text or every separately verified completion field. */
export async function loadHttpPoolRecord(http: Hub, id: string, record: string, caller: AbortSignal) {
  const signal = deadline(caller);
  const first = await http.get('poolRecord', { params: { id, record }, signal });
  const requested = (page: ApiResponse<'poolRecord'>) => {
    if (page.data.id !== record || page.data.poolId !== id) throw new Error('pool_record_identity');
    return page.data;
  };
  const data = requested(first);
  if (data.kind === 'agreement') {
    if (first.capabilities?.agreementRecord !== 'supported') throw new Error('agreement_unsupported');
    const result = await assembleText(async cursor => {
      const page = cursor === null ? first : await http.get('poolRecord', { params: { id, record }, query: { cursor }, signal });
      const value = requested(page);
      if (value.kind !== 'agreement' || page.capabilities?.agreementRecord !== 'supported') throw new Error('agreement_changed');
      return {
        content: value.result, next: page.page.next,
        fence: JSON.stringify([value.revision, value.eventId, value.proposalId, value.rosterKey, value.ballots]),
      };
    }, signal);
    const agents = data.ballots.map(ballot => ({ seat: ballot.seatId, id: ballot.session.sessionId, execution: ballot.session.execution }));
    return {
      agents,
      text: [`Pool ${id} · agreement ${record}`, `Revision ${data.revision} · event ${data.eventId} · proposal ${data.proposalId}`, `Roster key: ${data.rosterKey}`, '',
        'Result (recorded by Pool · no digest)', result, '',
        ...data.ballots.map(ballot => `Seat ${ballot.seatId} · Run ${ballot.session.sessionId} · vote ${ballot.voteEventId}`)].join('\n'),
    };
  }
  if (first.capabilities?.completionRecord !== 'supported') throw new Error('completion_unsupported');
  const pages = [data], seen = new Set<string>();
  let cursor = first.page.next;
  while (cursor !== null) {
    if (seen.has(cursor) || seen.size >= 200) throw new Error('completion_cursor');
    seen.add(cursor);
    const page = await http.get('poolRecord', { params: { id, record }, query: { cursor }, signal });
    const value = requested(page);
    if (value.kind !== 'completion' || page.capabilities?.completionRecord !== 'supported' || value.recordDigest !== data.recordDigest ||
        value.revision !== data.revision || JSON.stringify(value.header) !== JSON.stringify(data.header)) throw new Error('completion_changed');
    pages.push(value);
    cursor = page.page.next;
  }
  const fields: string[] = [];
  for (const field of ['goal', 'criteria', 'result', 'snapshot'] as const) {
    const chunks = pages.flatMap(page => page.content.filter(item => item.field === field));
    if (data.header.absentFields.includes(field)) {
      if (chunks.length) throw new Error('completion_field_conflict');
      fields.push(`${field}: absent`);
      continue;
    }
    if (!chunks.length) throw new Error('completion_field_missing');
    let index = 0;
    const content = await assembleText(async () => {
      const item = chunks[index++];
      return { content: item.content, fence: item.sha256, next: index < chunks.length ? String(index) : null };
    }, signal);
    fields.push(`${field}:\n${await verifyText(content, chunks[0].sha256)}`);
  }
  return {
    agents: null,
    text: [`Pool ${id} · completion ${record} · revision ${data.revision}`, `SHA-256: ${data.recordDigest}`, JSON.stringify(data.header), ...fields,
      ...pages.flatMap(page => [...page.roster, ...page.ballots, ...page.runFacts].map(item => JSON.stringify(item))), data.notice ?? ''].join('\n\n'),
  };
}
