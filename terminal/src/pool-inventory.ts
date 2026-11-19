/** Validates Agent Pool's source-wide `inventory_snapshot_v1` pages and exact totals. */
import { integer, invalid, object, product, usable } from '../../src/live/protocol.ts';
import type { ReadResponse, Resource } from './api.ts';
import { checkSeats, poolFacts } from './pool-chat.ts';

/** Capability name that the Pool observer must advertise before this read is attempted. */
export const INVENTORY_SNAPSHOT_CAPABILITY = 'inventory_snapshot_v1';

/** Row selection offered by the producer; totals are independent of it. */
export type InventoryFilter = 'all' | 'closed' | 'not_closed';

/** Producer-defined binding of every page to one Pool store snapshot. */
export interface InventorySource { store_id: string; read_epoch: string; revision: string }

/** Exact retained totals; `open` and `completed` stay null until the source has a completion ledger. */
export interface InventoryTotals { total: string; closed: string; unknown: string; open: string | null; completed: string | null }

/** Opaque continuation returned by the producer and echoed back unchanged. */
export interface InventoryCursor { version: 1; source: InventorySource; filter: InventoryFilter; limit: number; after: string }

/** One validated snapshot page. */
export interface InventoryPage {
  source: InventorySource;
  totals: InventoryTotals;
  coverage: string;
  rows: Record<string, unknown>[];
  next: InventoryCursor | null;
  observedAtMs: number;
}

/** The request a page must answer. */
export interface InventoryRequest { filter: InventoryFilter; limit: number; cursor: InventoryCursor | null }

/** A complete or explicitly bounded walk of one source snapshot. */
export type InventoryWalk =
  | { state: 'ok'; page: InventoryPage; rows: Record<string, unknown>[]; pages: number }
  | { state: 'partial'; page: InventoryPage; rows: Record<string, unknown>[]; pages: number; reason: string }
  | { state: 'unavailable'; reason: string };

const DECIMAL = /^(0|[1-9]\d{0,19})$/;
const U64_MAX = 18446744073709551615n;
const FILTERS: readonly string[] = ['all', 'closed', 'not_closed'];

/** Reads a canonical unsigned decimal string without a JavaScript numeric conversion. */
function decimal(value: unknown): bigint {
  if (typeof value !== 'string' || !DECIMAL.test(value) || BigInt(value) > U64_MAX) return invalid('inventory_decimal');
  return BigInt(value);
}

/** Compares pool IDs by UTF-8 bytes, matching a binary-collated producer order. */
function compareIds(left: string, right: string): number { return Buffer.compare(Buffer.from(left), Buffer.from(right)); }

/** Validates the store/epoch/revision fence. */
function inventorySource(value: unknown): InventorySource {
  const source = object(value);
  if (typeof source.store_id !== 'string' || !source.store_id || typeof source.read_epoch !== 'string' || !source.read_epoch) return invalid('inventory_source');
  decimal(source.revision);
  return { store_id: source.store_id, read_epoch: source.read_epoch, revision: source.revision as string };
}

/** Reports whether two page fences name exactly one snapshot. */
function sameSource(left: InventorySource, right: InventorySource): boolean {
  return left.store_id === right.store_id && left.read_epoch === right.read_epoch && left.revision === right.revision;
}

/** Checks exact totals; open/completed are all-or-nothing and never derived from closure. */
function inventoryTotals(value: unknown): InventoryTotals {
  const totals = object(value);
  const total = decimal(totals.total), closed = decimal(totals.closed), unknown = decimal(totals.unknown);
  if (closed > total || unknown > total) return invalid('inventory_totals');
  const open = totals.open, completed = totals.completed;
  if (open === null && completed === null) {
    if (unknown !== total) return invalid('inventory_totals');
  } else if (open === null || completed === null || decimal(open) + decimal(completed) + unknown !== total) return invalid('inventory_totals');
  return { total: totals.total as string, closed: totals.closed as string, unknown: totals.unknown as string, open: open as string | null, completed: completed as string | null };
}

/** Validates the producer's continuation shape against the request and the response fence. */
function inventoryCursor(value: unknown, source: InventorySource, request: InventoryRequest, lastId: string): InventoryCursor {
  const cursor = object(value);
  if (cursor.version !== 1 || cursor.filter !== request.filter || cursor.limit !== request.limit || cursor.after !== lastId || !sameSource(inventorySource(cursor.source), source)) return invalid('inventory_cursor');
  return cursor as unknown as InventoryCursor;
}

/** Validates one source-shaped pool row and its complete roster. */
function inventoryRow(value: unknown, filter: InventoryFilter): Record<string, unknown> {
  const row = object(value), pool = object(row.pool);
  if (typeof pool.pool_id !== 'string' || !pool.pool_id || typeof pool.name !== 'string' || typeof pool.purpose !== 'string' || typeof pool.closed !== 'boolean' || typeof row.leader_id !== 'string' || !Array.isArray(row.roster)) return invalid('inventory_row');
  integer(pool.revision);
  let kind;
  try { kind = poolFacts(row, pool).kind; } catch { return invalid('inventory_row'); }
  if (filter === 'closed' && !pool.closed || filter === 'not_closed' && pool.closed) return invalid('inventory_filter');
  for (const member of row.roster) if (typeof object(member).member_id !== 'string') return invalid('inventory_roster');
  try { checkSeats(row.roster, kind); } catch { return invalid('inventory_roster'); }
  return row;
}

/** Validates a complete `inventory_snapshot` envelope against the exact request it answers. */
export function inventorySnapshotPage(value: unknown, request: InventoryRequest): InventoryPage {
  if (!FILTERS.includes(request.filter) || !Number.isInteger(request.limit) || request.limit < 1 || request.limit > 10) return invalid('inventory_request');
  const data = product(value, 'inventory_snapshot');
  const source = inventorySource(data.source), totals = inventoryTotals(data.totals);
  if (typeof data.coverage !== 'string' || !data.coverage || !Array.isArray(data.pools) || typeof data.has_more !== 'boolean') return invalid('inventory_page');
  if (request.cursor && (!sameSource(request.cursor.source, source) || request.cursor.filter !== request.filter || request.cursor.limit !== request.limit)) return invalid('inventory_fence');
  const rows = data.pools.map(row => inventoryRow(row, request.filter));
  if (integer(data.returned) !== rows.length || rows.length > request.limit || data.has_more && !rows.length) return invalid('inventory_returned');
  let previous = request.cursor?.after ?? null;
  for (const row of rows) {
    const id = object(row.pool).pool_id as string;
    if (previous !== null && compareIds(id, previous) <= 0) return invalid('inventory_order');
    previous = id;
  }
  const next = data.has_more ? inventoryCursor(data.next_cursor, source, request, previous as string) : data.next_cursor === null ? null : invalid('inventory_cursor');
  return { source, totals, coverage: data.coverage, rows, next, observedAtMs: integer(data.observed_at_unix_ms) };
}

/** Counts the rows a complete walk must return for the selected filter. */
function expectedRows(totals: InventoryTotals, filter: InventoryFilter): bigint {
  return filter === 'all' ? BigInt(totals.total) : filter === 'closed' ? BigInt(totals.closed) : BigInt(totals.total) - BigInt(totals.closed);
}

/** One finite read callback; it must not retry or fall back to another resource. */
export type InventoryRead = (params: Record<string, unknown>) => Promise<ReadResponse>;

/**
 * Walks one source snapshot. Any failed, stale or fence-changing page discards everything and
 * restarts at the first page; mixed revisions are never merged. A walk that stops at `maxPages`
 * is partial and keeps its exact totals but never claims every row.
 */
export async function walkInventory(read: InventoryRead, options: { filter: InventoryFilter; limit: number; maxPages: number; restarts?: number; current?: () => boolean }): Promise<InventoryWalk> {
  const { filter, limit, maxPages } = options, current = options.current ?? (() => true);
  let failure = 'inventory_unavailable';
  for (let attempt = 0; attempt <= (options.restarts ?? 2); attempt++) {
    const rows = new Map<string, Record<string, unknown>>();
    let first: InventoryPage | null = null, cursor: InventoryCursor | null = null, pages = 0;
    try {
      for (;;) {
        if (!current()) return { state: 'unavailable', reason: 'obsolete' };
        const request: InventoryRequest = { filter, limit, cursor };
        const envelope = await read({ filter, limit, ...(cursor ? { cursor } : {}) });
        if (!current()) return { state: 'unavailable', reason: 'obsolete' };
        if (!usable(envelope) || envelope.error !== null) { failure = envelope.error?.code === 'stale' ? 'source_stale' : `source_${envelope.outcome}`; break; }
        const page = inventorySnapshotPage(envelope.data, request);
        if (first && (!sameSource(first.source, page.source) || JSON.stringify(first.totals) !== JSON.stringify(page.totals))) { failure = 'inventory_fence_changed'; break; }
        first ??= page; pages++;
        for (const row of page.rows) { const id = object(row.pool).pool_id as string; if (rows.has(id)) return invalid('inventory_duplicate'); rows.set(id, row); }
        if (page.next === null) {
          if (BigInt(rows.size) !== expectedRows(first.totals, filter)) { failure = 'inventory_row_count'; break; }
          return { state: 'ok', page: first, rows: [...rows.values()], pages };
        }
        if (pages >= maxPages) return { state: 'partial', page: first, rows: [...rows.values()], pages, reason: 'page_budget' };
        cursor = page.next;
      }
    } catch (error) { failure = error instanceof Error && /^inventory_/.test(error.message) ? error.message : 'inventory_invalid'; }
  }
  return { state: 'unavailable', reason: failure };
}

/** Reads the first page only: exact source-wide totals plus the snapshot fence, one row at most. */
export function readInventoryTotals(read: (resource: Resource, params: Record<string, unknown>) => Promise<ReadResponse>): Promise<InventoryWalk> {
  return walkInventory(params => read('pool.inventory_snapshot', params), { filter: 'all', limit: 1, maxPages: 1 });
}

/** Describes totals without deriving Open or Completed from closure. */
export function inventoryTotalsLines(page: InventoryPage): string[] {
  const { totals, source } = page;
  return [
    `Source snapshot r${source.revision} · ${totals.total} retained · ${totals.closed} closed`,
    totals.open === null ? 'Open / Completed: unavailable · no completion ledger' : `Open ${totals.open} · Completed ${totals.completed} · ${totals.unknown} unclassified (source ledger)`,
    'Closed is not completion',
  ];
}
