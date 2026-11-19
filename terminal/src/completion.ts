/** Agent Pool `completion_record_v1` pages: exact, digest-bound, frozen completion records. */
import { createHash } from 'node:crypto';
import { object, product } from '../../src/live/protocol.ts';

/** Record sections in display order. */
export const COMPLETION_SECTIONS = ['header', 'content', 'roster', 'ballots', 'run_facts', 'notice'] as const;
/** One completion record section. */
export type CompletionSection = typeof COMPLETION_SECTIONS[number];
/** Capability advertised by Pool identity for this read. */
export const COMPLETION_CAPABILITY = 'completion_record_v1';

/** One validated page bound to its record. */
export interface CompletionPage {
  completionId: string; recordVersion: number; recordDigest: string; algorithm: string; section: CompletionSection;
  header: Record<string, unknown> | null; items: Record<string, unknown>[]; next: Record<string, unknown> | null;
}

/** Strict Pool identifier form accepted for a completion ID taken from journal text. */
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;

/** Returns the completion or chat agreement ID announced by the latest `pool_completed` journal event, or null. */
export function completionIdFromEvents(events: Record<string, unknown>[]): string | null {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (event.kind !== 'pool_completed' || typeof event.body !== 'string') continue;
    const match = /\bCompletion (\S+?)\./.exec(event.body) ?? /^Agreement (\S+) committed for proposal /.exec(event.body);
    if (match && ID.test(match[1]!)) return match[1]!;
  }
  return null;
}

/** Validates one `completion_page` against the request and the first page's record binding. */
export function completionPage(value: unknown, request: { pool_id: string; completion_id: string; section: CompletionSection }, bound: { digest: string; version: number } | null): CompletionPage {
  const data = product(value, 'completion_page');
  if (data.pool_id !== request.pool_id || data.completion_id !== request.completion_id || data.section !== request.section) throw new Error('completion_binding');
  if (typeof data.record_digest !== 'string' || !data.record_digest || typeof data.record_version !== 'number' || typeof data.integrity_algorithm !== 'string') throw new Error('completion_record');
  if (bound && (bound.digest !== data.record_digest || bound.version !== data.record_version)) throw new Error('completion_changed');
  if (!Array.isArray(data.items) || typeof data.has_more !== 'boolean' || data.has_more !== (data.next_cursor !== null && data.next_cursor !== undefined)) throw new Error('completion_page');
  const header = request.section === 'header' ? object(data.header) : null;
  return {
    completionId: data.completion_id as string, recordVersion: data.record_version, recordDigest: data.record_digest, algorithm: data.integrity_algorithm, section: request.section,
    header, items: data.items.map(item => object(item)), next: data.has_more ? object(data.next_cursor) : null,
  };
}

/** Reassembles content fields from exact slices and verifies each field's length and SHA-256. */
export function completionContent(items: Record<string, unknown>[]): { field: string; text: string; verified: boolean }[] {
  const fields = new Map<string, { parts: string[]; offset: number; total: number; sha256: string; valid: boolean }>();
  for (const item of items) {
    if (item.item !== 'content' || typeof item.field !== 'string' || typeof item.text !== 'string' || typeof item.offset !== 'number' || typeof item.total_bytes !== 'number' || typeof item.sha256 !== 'string') throw new Error('completion_content');
    const entry = fields.get(item.field) ?? { parts: [], offset: 0, total: item.total_bytes, sha256: item.sha256, valid: true };
    if (item.offset !== entry.offset || item.total_bytes !== entry.total || item.sha256 !== entry.sha256) entry.valid = false;
    entry.parts.push(item.text); entry.offset += Buffer.byteLength(item.text); fields.set(item.field, entry);
  }
  return [...fields].map(([field, entry]) => {
    const text = entry.parts.join('');
    return { field, text, verified: entry.valid && entry.offset === entry.total && createHash('sha256').update(text).digest('hex') === entry.sha256 };
  });
}

/** Renders a scalar-or-object value compactly, without inventing missing values. */
function compact(value: unknown): string {
  if (value === null || value === undefined) return 'Unknown';
  if (typeof value !== 'object') return String(value);
  return Object.entries(value as Record<string, unknown>).filter(([key]) => key !== 'item').map(([key, item]) => `${key}=${item !== null && typeof item === 'object' ? JSON.stringify(item) : String(item)}`).join(' · ');
}

/** Builds the frozen completion view text from fully read sections. */
export function completionText(poolId: string, pages: Map<CompletionSection, CompletionPage[]>): string {
  const first = pages.get('header')?.[0];
  const lines = [`Pool ${poolId} · completion ${first?.completionId ?? 'Unknown'}`, `Frozen record v${first?.recordVersion ?? '?'} · ${first?.algorithm ?? 'Unknown'} ${first?.recordDigest ?? 'Unknown'}`, 'Immutable: goal, roster, assignments, proposal and votes cannot change after completion.', ''];
  const header = first?.header;
  if (header) {
    lines.push('Header');
    for (const [key, value] of Object.entries(header)) if (key !== 'content') lines.push(`  ${key}: ${compact(value)}`);
    lines.push('');
  }
  const content = (pages.get('content') ?? []).flatMap(page => page.items);
  for (const field of completionContent(content)) lines.push(`${field.field[0]!.toUpperCase()}${field.field.slice(1)} ${field.verified ? '(sha256 verified)' : '(VERIFICATION FAILED)'}`, ...field.text.split('\n').map(line => `  ${line}`), '');
  if (header && Array.isArray(header.content)) for (const field of header.content.map(item => object(item))) if (field.present === false) lines.push(`${String(field.field)}: absent`, '');
  for (const [section, title] of [['roster', 'Roster'], ['ballots', 'Ballots'], ['run_facts', 'Run facts'], ['notice', 'Notice']] as const) {
    const items = (pages.get(section) ?? []).flatMap(page => page.items);
    lines.push(`${title} (${items.length})`);
    for (const item of items) lines.push(`  ${compact(item)}`);
    lines.push('');
  }
  return lines.join('\n');
}

/** One seat's recorded ready vote in a chat agreement. */
export interface AgreementBallot { seatId: string; agentId: string; voteEventId: string }

/** Immutable chat agreement: unanimous ready votes of the current seats on one proposal and roster. */
export interface AgreementRecord {
  completionId: string; poolId: string; revision: number; eventId: string; proposalId: string; rosterKey: string; result: string; ballots: AgreementBallot[];
}

/**
 * Reads a chat pool's `completion_get` header answer. Chat pools answer with the agreement object under the
 * same `completion_page` kind; the legacy format carries `record_digest` and paged sections instead. Returns
 * null for the legacy format and throws on a malformed or mismatched agreement.
 */
export function agreementRecord(value: unknown, request: { pool_id: string; completion_id: string }): AgreementRecord | null {
  const data = product(value, 'completion_page');
  if (data.record_digest !== undefined || !Array.isArray(data.ballots) || typeof data.result !== 'string') return null;
  const text = (field: string): string => { const item = data[field]; if (typeof item !== 'string' || !item) throw new Error('agreement_record'); return item; };
  if (data.version !== 1 || data.pool_id !== request.pool_id || data.completion_id !== request.completion_id || typeof data.revision !== 'number' || !Number.isSafeInteger(data.revision) || data.revision < 1 || !ID.test(text('completion_id')) || !/^(0|[1-9]\d{0,18})$/.test(text('event_id'))) throw new Error('agreement_binding');
  const seen = new Set<string>();
  const ballots = data.ballots.map(item => {
    const ballot = object(item);
    if (typeof ballot.seat_id !== 'string' || !ballot.seat_id || typeof ballot.agent_id !== 'string' || !ballot.agent_id || typeof ballot.vote_event_id !== 'string' || !/^(0|[1-9]\d{0,18})$/.test(ballot.vote_event_id) || seen.has(ballot.seat_id)) throw new Error('agreement_ballot');
    seen.add(ballot.seat_id);
    return { seatId: ballot.seat_id, agentId: ballot.agent_id, voteEventId: ballot.vote_event_id };
  });
  if (!ballots.length) throw new Error('agreement_ballot');
  return { completionId: text('completion_id'), poolId: text('pool_id'), revision: data.revision, eventId: text('event_id'), proposalId: text('proposal_id'), rosterKey: text('roster_key'), result: data.result, ballots };
}

/** Builds the agreement view text; the result carries no digest, so it is labeled as recorded, not verified. */
export function agreementText(record: AgreementRecord): string {
  const lines = [
    `Pool ${record.poolId} · agreement ${record.completionId}`,
    'Chat pool agreement v1 · all current seats voted ready on one proposal and roster',
    'Immutable: the result and ballots cannot change after the agreement. It records member agreement only; process outcome and cleanup are reported separately by Run.',
    '',
    'Header',
    `  pool revision: ${record.revision}`, `  completion event: ${record.eventId}`, `  proposal: ${safeLine(record.proposalId)}`, `  roster key: ${safeLine(record.rosterKey)}`,
    '', 'Result (recorded by Pool · no digest)', ...record.result.split('\n').map(line => `  ${line}`), '',
    `Ballots (${record.ballots.length})`,
  ];
  for (const ballot of record.ballots) lines.push(`  seat ${safeLine(ballot.seatId)} · ready · Run agent ${safeLine(ballot.agentId)} · vote event ${ballot.voteEventId}`);
  return lines.join('\n');
}

/** Keeps one producer value on one line. */
function safeLine(value: string): string { return value.replace(/[\r\n]+/g, ' '); }
