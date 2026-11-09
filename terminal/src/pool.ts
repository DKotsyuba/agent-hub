/** Validates Agent Pool's independent observer pages and continuation cursors. */
import { decimalCursor, integer, object, poolDetail, poolPage, product } from '../../src/live/protocol.ts';
import type { Page } from '../../src/live/protocol.ts';

/** Agent Pool sections shown by the terminal. */
export type PoolSection = 'members' | 'history' | 'proposal' | 'votes' | 'criteria' | 'decisions' | 'deliveries';

/** A journal page with lossless decimal identities and a frozen source watermark. */
export interface PoolWindow { entries: Record<string, unknown>[]; cursor: string; watermark: string; more: boolean }

/** One ordinary event or an explicitly correlated multi-part message. */
export interface PoolMessage { head: Record<string, unknown>; parts: Record<string, unknown>[]; complete: boolean; valid: boolean }

/** One exact UTF-8 content slice, fenced by the source pool revision. */
export interface PoolContentPage { text: string; next: number; total: number; revision: number; more: boolean }

/** Checks the owner-only archived binding against the displayed Pool revision and exact member. */
export function poolFormerBinding(value: unknown, poolId: string, memberId: string, revision: number): Record<string, unknown> {
  const data = poolDetail(value), view = object(data.view), pool = object(view.pool);
  if (data.section !== 'binding' || view.section !== 'binding' || pool.pool_id !== poolId || integer(pool.revision) !== revision || data.has_more !== false || view.has_more !== false || integer(data.returned) !== 1 || data.source_timestamp !== null || !Array.isArray(view.members) || view.members.length !== 1 || !Array.isArray(data.bindings) || data.bindings.length !== 1) throw new Error('pool_former_binding');
  const binding = object(data.bindings[0]), member = object(binding.member), listed = object(view.members[0]);
  if (binding.pool_id !== poolId || member.member_id !== memberId || listed.member_id !== memberId || member.state !== 'removed' || listed.state !== 'removed') throw new Error('pool_former_member');
  return binding;
}

/** Reassembles only consecutive message parts whose producer identity and metadata agree. */
export function groupPoolEvents(events: Record<string, unknown>[]): PoolMessage[] {
  const groups: PoolMessage[] = [];
  for (const event of events) {
    const id = event.event_id_exact ?? event.event_id, parent = event.message_event_id, index = event.part_index, count = event.part_count;
    const hasParts = parent != null || index != null || count != null || event.kind === 'message_part';
    if (!hasParts) { groups.push({ head: event, parts: [event], complete: true, valid: true }); continue; }
    const valid = typeof parent === 'string' && /^(0|[1-9]\d{0,18})$/.test(parent) && typeof index === 'number' && Number.isSafeInteger(index) && typeof count === 'number' && Number.isSafeInteger(count) && count > 1 && count <= 64 && index >= 1 && index <= count && typeof event.revision === 'number' && Number.isSafeInteger(event.revision) && (index === 1 ? String(id) === parent && event.kind !== 'message_part' : event.kind === 'message_part');
    const prior = groups.at(-1), last = prior?.parts.at(-1);
    const matches = valid && last && prior?.valid && last.message_event_id === parent && last.part_count === count && last.part_index === index - 1 && last.revision === event.revision && last.recipient === event.recipient && JSON.stringify(last.author) === JSON.stringify(event.author);
    if (matches) {
      prior.parts.push(event);
      prior.complete = prior.head.part_index === 1 && index === count;
    } else groups.push({ head: event, parts: [event], complete: false, valid });
  }
  return groups;
}

/** Validates one nonnegative i64 encoded without a JavaScript numeric conversion. */
function exact(value: unknown): string {
  if (typeof value !== 'string' || value.length > 19 || !/^(0|[1-9]\d*)$/.test(value) || BigInt(value) > 9223372036854775807n) throw new Error('pool_exact_cursor');
  return value;
}

/** Validates history_window_v1 independently of the legacy numeric view cursor. */
export function poolWindow(value: unknown, id: string, direction: 'forward' | 'backward', boundary: string | null, through: string | null): PoolWindow {
  const data = product(value, 'pool_detail');
  if (data.section !== 'history' || typeof data.has_more !== 'boolean' || data.source_timestamp !== null) throw new Error('pool_history_section');
  const view = object(data.view), source = object(view.pool), entries = view.events;
  if (source.pool_id !== id || view.section !== 'history' || !Array.isArray(entries) || view.has_more !== data.has_more || integer(data.returned) !== entries.length) throw new Error('pool_history_attribution');
  const watermark = exact(data.history_watermark), cursor = exact(data.cursor);
  if (through !== null && watermark !== exact(through)) throw new Error('pool_history_watermark');
  if (boundary !== null) exact(boundary);
  let last = 0n;
  const rows = entries.map(value => {
    const event = object(value), eventId = exact(event.event_id_exact), numeric = BigInt(eventId);
    if (numeric <= last || numeric > BigInt(watermark) || direction === 'backward' && boundary !== null && numeric >= BigInt(boundary) || direction === 'forward' && boundary !== null && numeric <= BigInt(boundary)) throw new Error('pool_history_order');
    if (typeof event.kind !== 'string' || typeof event.body !== 'string') throw new Error('pool_history_event');
    object(event.author); last = numeric; return event;
  });
  const expected = rows.length ? String(rows[direction === 'backward' ? 0 : rows.length - 1].event_id_exact) : direction === 'backward' ? '0' : boundary ?? '0';
  if (cursor !== expected || (data.has_more && !rows.length)) throw new Error('pool_history_cursor');
  return { entries: rows, cursor, watermark, more: data.has_more };
}

/** Validates byte boundaries and identity for the producer's bounded content page. */
export function poolContentPage(value: unknown, id: string, field: 'purpose' | 'snapshot', offset: number, revision: number | null): PoolContentPage {
  const data = poolDetail(value), view = object(data.view), pool = object(view.pool), content = object(view.content);
  const observed = integer(pool.revision), start = integer(content.offset), total = integer(content.total_bytes), next = decimalCursor(data.cursor);
  if (data.section !== 'content' || view.section !== 'content' || pool.pool_id !== id || revision !== null && observed !== revision || content.field !== field || start !== offset || typeof content.text !== 'string' || data.source_timestamp !== null || typeof data.has_more !== 'boolean' || view.has_more !== data.has_more || integer(data.returned) !== 1 || next === null || integer(view.next_after) !== next) throw new Error('pool_content_attribution');
  const bytes = new TextEncoder().encode(content.text).length;
  const limit = field === 'purpose' ? 8192 : 65536;
  if (total > limit || next !== offset + bytes || next > total || data.has_more !== (next < total) || next < total && bytes === 0) throw new Error('pool_content_cursor');
  return { text: content.text, next, total, revision: observed, more: data.has_more };
}

/** Validates inventory order and the producer's opaque pool-ID continuation. */
export function poolInventory(value: unknown, after: string | null): Page<Record<string, unknown>> {
  const page = poolPage(value), raw = product(value, 'pool_page');
  if (typeof raw.has_more !== 'boolean' || integer(raw.returned) !== page.items.length || raw.source_timestamp !== null) throw new Error('pool_inventory_page');
  let previous = after ?? '';
  for (const row of page.items) {
    const id = object(row.pool).pool_id;
    if (typeof id !== 'string' || !id || id <= previous) throw new Error('pool_inventory_order');
    previous = id;
  }
  if (raw.cursor !== (page.items.length ? previous : after) || (raw.has_more && !page.items.length)) throw new Error('pool_inventory_cursor');
  return page;
}

/** Validates a single section without conflating separately observed page revisions. */
export function poolSection(value: unknown, id: string, section: PoolSection, after: number, revision: number | null): Record<string, unknown> {
  const data = poolDetail(value);
  if (data.section !== section || typeof data.has_more !== 'boolean' || data.source_timestamp !== null) throw new Error('pool_section');
  const next = decimalCursor(data.cursor);
  if (next === null || next < after || (data.has_more && next === after)) throw new Error('pool_cursor');
  const view = data.view === null ? null : object(data.view);
  if ((section === 'decisions') !== (view === null)) throw new Error('pool_view');
  if (view) {
    const pool = object(view.pool), observedRevision = integer(pool.revision);
    if (pool.pool_id !== id || view.section !== section || integer(view.next_after) !== next || view.has_more !== data.has_more || (revision !== null && observedRevision !== revision)) throw new Error('pool_attribution');
    const rows = section === 'members' ? view.members : section === 'history' ? view.events : section === 'deliveries' ? view.deliveries : section === 'criteria' ? pool.acceptance ?? [] : section === 'votes' ? pool.proposal === null ? [] : Object.values(object(object(pool.proposal).votes)) : pool.proposal === null ? [] : [pool.proposal];
    if (!Array.isArray(rows) || integer(data.returned) !== rows.length) throw new Error('pool_returned');
    if (section === 'history') {
      let cursor = after;
      for (const row of rows) { const event = object(row), eventId = integer(event.event_id); if (eventId <= cursor || eventId > next) throw new Error('pool_event_order'); cursor = eventId; }
      if (rows.length && cursor !== next) throw new Error('pool_event_cursor');
    }
  } else if (integer(data.returned) !== (data.decisions as unknown[]).length) throw new Error('pool_returned');
  return data;
}
