/** Groups loaded standalone Pool inventory rows for display and navigation. */
import { integer, object } from '../../src/live/protocol.ts';

/** A filtered group whose count covers loaded rows only. */
export interface PoolListGroup {
  items: Record<string, unknown>[];
  loaded: number;
}

/** Open and closed groups plus their shared keyboard navigation order. */
export interface GroupedPoolList {
  open: PoolListGroup;
  closed: PoolListGroup;
  items: Record<string, unknown>[];
}

/** Filters validated source-shaped rows, preserving their order within each closure group. */
export function groupPools(rows: readonly unknown[], query: string): GroupedPoolList {
  const open: Record<string, unknown>[] = [], closed: Record<string, unknown>[] = [];
  const term = query.trim().toLocaleLowerCase();
  for (const value of rows) {
    const row = object(value), pool = object(row.pool);
    if (typeof pool.pool_id !== 'string' || typeof pool.name !== 'string' || typeof pool.purpose !== 'string' || typeof pool.closed !== 'boolean' || typeof row.leader_id !== 'string') throw new Error('pool_metadata');
    integer(pool.revision);
    if (!pool.pool_id) throw new Error('pool_inventory_order');
    if (term && !`${pool.name} ${pool.purpose} ${pool.pool_id}`.toLocaleLowerCase().includes(term)) continue;
    (pool.closed ? closed : open).push(row);
  }
  return { open: { items: open, loaded: open.length }, closed: { items: closed, loaded: closed.length }, items: [...open, ...closed] };
}
