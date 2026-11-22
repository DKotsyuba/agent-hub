/** Contract-fenced read assembly for text and frozen Pool records. */
import type { ApiResponse, Coverage, PoolRecord } from '@agent-hub/domain';
import { client } from './data';
import { assembleText, verifyText } from '../../packages/view-model/src/index';
import type { TextPage } from '../../packages/view-model/src/index';
import type { ReadOptions } from './client';

/** Buffers fenced chunks from records that interleave multiple text fields. */
function collectText() {
  const chunks: TextPage['content'][] = [];
  const encoder = new TextEncoder();
  let bufferedBytes = 0;
  return {
    /** Bounds buffered content before walking the shared assembler. */
    add(content: TextPage['content']) {
      if (content.totalBytes > 16 * 1024 * 1024) throw new Error('content_budget');
      bufferedBytes += encoder.encode(content.text).length;
      if (bufferedBytes > 16 * 1024 * 1024) throw new Error('content_budget');
      chunks.push(content);
    },
    /** Applies the shared boundary and digest checks to the buffered field. */
    async finish(signal: AbortSignal, digest?: string) {
      const text = await assembleText(async cursor => {
        const index = Number(cursor ?? 0);
        const content = chunks[index];
        if (!content) throw new Error('invalid_projection');
        return { content, fence: '', next: index + 1 < chunks.length ? String(index + 1) : null };
      }, signal);
      return digest ? verifyText(text, digest) : text;
    },
  };
}

/** Prevents cursor cycles and bounds local work for a single copy action. */
async function pages<T extends { page: { next: string | null } }>(
  load: (cursor: string | null) => Promise<T>, apply: (page: T) => void,
) {
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await load(cursor);
    apply(page);
    cursor = page.page.next;
    if (cursor && (seen.has(cursor) || seen.size >= 4096)) throw new Error('invalid_projection');
    if (cursor) seen.add(cursor);
  } while (cursor);
}

/** Cursor chains are accepted only while their revision or proof stays identical. */
function fence() {
  let previous: string | undefined;
  return (value: unknown) => {
    const key = JSON.stringify(value);
    if (previous !== undefined && previous !== key) throw new Error('invalid_projection');
    previous = key;
  };
}

/** Reads all text pages and checks execution, content digest and any retained boundary. */
export async function readSessionText(route: 'initialTask' | 'sessionResult' | 'sessionExport', id: string, query: NonNullable<ReadOptions['query']>, signal: AbortSignal) {
  const check = fence(), assembly = collectText();
  let digest: string | undefined, provenance = '', reason: string | undefined, coverage: Coverage | undefined;
  let observations: ApiResponse<'sessionResult'>['observations'] = [];
  await pages(cursor => client.get(route, { params: { id }, query: { ...query, cursor }, signal }), response => {
    const { data } = response;
    observations = response.observations;
    if ('state' in data && data.state === 'unverified') {
      if (response.page.next || digest) throw new Error('invalid_projection');
      reason = data.reason;
      return;
    }
    if (reason) throw new Error('invalid_projection');
    const proof = 'proof' in data ? data.proof : undefined;
    check([proof, 'boundary' in data ? data.boundary : null]);
    const binding = proof && ('root' in proof ? proof.root : 'content' in proof ? proof.content : proof);
    if (binding && query.execution && query.execution !== binding.execution && !('root' in (proof ?? {}))) throw new Error('invalid_projection');
    digest = binding?.sha256;
    provenance = proof && 'kind' in proof ? (proof.kind === 'current' ? 'initial_current' : proof.kind) : 'mode' in data ? data.mode : 'execution_verified';
    coverage = 'coverage' in data ? data.coverage : undefined;
    assembly.add(data.content);
  });
  return { text: reason ? null : await assembly.finish(signal, digest), provenance, reason, coverage, observations };
}

/** Loads complete purpose or snapshot text under one Pool revision. */
export async function readPoolContent(id: string, field: 'purpose' | 'snapshot', proposal: string | null, signal: AbortSignal) {
  const check = fence(), assembly = collectText();
  await pages(cursor => client.get('poolContent', { params: { id, field }, query: { cursor, proposal }, signal }), ({ data }) => {
    if (data.poolId !== id || data.field !== field || (proposal && data.proposalId !== proposal)) throw new Error('invalid_projection');
    check([data.revision, data.proposalId]);
    assembly.add(data.content);
  });
  return assembly.finish(signal);
}

/** Assembles record text under one frozen identity and validates each completion digest. */
export async function readPoolRecord(id: string, record: { id: string; kind: PoolRecord['kind'] }, signal: AbortSignal) {
  const check = fence(), result = collectText();
  const fields = new Map<string, { assembly: ReturnType<typeof collectText>; digest: string }>();
  const roster = new Map<string, Extract<PoolRecord, { kind: 'completion' }>['roster'][number]>();
  const ballots = new Map<string, Extract<PoolRecord, { kind: 'completion' }>['ballots'][number]>();
  const seats = new Map<string, Extract<PoolRecord, { kind: 'agreement' }>['ballots'][number]>();
  const facts = new Map<string, Extract<PoolRecord, { kind: 'completion' }>['runFacts'][number]>();
  let metadata: PoolRecord | undefined;
  let observations: ApiResponse<'poolRecord'>['observations'] = [];
  await pages(cursor => client.get('poolRecord', { params: { id, record: record.id }, query: { cursor }, signal }), ({ data, observations: source }) => {
    if (data.id !== record.id || data.poolId !== id || data.kind !== record.kind) throw new Error('invalid_projection');
    check([data.revision, data.kind === 'completion' ? [data.recordDigest, data.header] : [data.eventId, data.proposalId, data.rosterKey]]);
    metadata ??= data;
    observations = source;
    if (data.kind === 'agreement') {
      result.add(data.result);
      for (const ballot of data.ballots) seats.set(ballot.seatId, ballot);
    } else {
      for (const item of data.content) {
        const field = fields.get(item.field) ?? { assembly: collectText(), digest: item.sha256 };
        if (field.digest !== item.sha256 || data.header.absentFields.includes(item.field)) throw new Error('invalid_projection');
        field.assembly.add(item.content);
        fields.set(item.field, field);
      }
      for (const item of data.roster) roster.set(item.id, item);
      for (const item of data.ballots) ballots.set(item.id, item);
      for (const item of data.runFacts) facts.set(JSON.stringify(item.match), item);
    }
  });
  const data = metadata!;
  return data.kind === 'agreement'
    ? { kind: data.kind, data, observations, text: await result.finish(signal), seats: [...seats.values()] } as const
    : { kind: data.kind, data, observations, roster: [...roster.values()], ballots: [...ballots.values()], facts: [...facts.values()],
        fields: await Promise.all([...fields].map(async ([name, field]) => [name, await field.assembly.finish(signal, field.digest), field.digest] as const)) } as const;
}

/** Copies retained Pool discussion under one frozen upper bound; legacy history has no such export. */
export async function readPoolExport(id: string, signal: AbortSignal) {
  const check = fence();
  const rows: ApiResponse<'poolHistory'>['data']['items'][] = [];
  let coverage: Coverage | undefined;
  await pages(cursor => client.get('poolHistory', { params: { id }, query: { cursor, edge: 'start', limit: 50 }, signal }),
    ({ data }) => {
      if (data.format !== 'window' || !data.upperBound) throw new Error('unsupported_capability');
      check(data.upperBound);
      coverage = data.coverage;
      rows.push(data.items);
    });
  return { rows, coverage };
}
