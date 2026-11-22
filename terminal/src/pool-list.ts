/** Groups loaded standalone Pool inventory rows for display and navigation. */
import { integer, object } from '../../src/live/protocol.ts';
import { poolFacts, poolSeat } from './pool-chat.ts';

/** A filtered group whose count covers loaded rows only. */
export interface PoolListGroup {
  items: Record<string, unknown>[];
  loaded: number;
}

/** Live and finished groups plus their shared keyboard navigation order. */
export interface GroupedPoolList {
  live: PoolListGroup;
  finished: PoolListGroup;
  items: Record<string, unknown>[];
}

/** Classifies a pool using the closure flag and the durable completion ID. */
export function poolState(row: Record<string, unknown>): 'Live' | 'Completed' | 'Closed' {
  const pool = object(row.pool);
  const { completionId } = poolFacts(row, pool);
  return pool.closed === true ? 'Closed' : completionId ? 'Completed' : 'Live';
}

/** Groups matching loaded rows in source order, with finished rows hidden by default. */
export function groupPools(rows: readonly unknown[], query: string, showFinished = false): GroupedPoolList {
  const live: Record<string, unknown>[] = [], finished: Record<string, unknown>[] = [];
  const term = query.trim().toLocaleLowerCase();
  for (const value of rows) {
    const row = object(value), pool = object(row.pool);
    if (typeof pool.pool_id !== 'string' || typeof pool.name !== 'string' || typeof pool.purpose !== 'string' || typeof pool.closed !== 'boolean' || typeof row.leader_id !== 'string') throw new Error('pool_metadata');
    integer(pool.revision); const state = poolState(row);
    if (!pool.pool_id) throw new Error('pool_inventory_order');
    if (term && !`${pool.name} ${pool.purpose} ${pool.pool_id}`.toLocaleLowerCase().includes(term)) continue;
    (state === 'Live' ? live : finished).push(row);
  }
  return { live: { items: live, loaded: live.length }, finished: { items: finished, loaded: finished.length }, items: showFinished ? [...live, ...finished] : live };
}

/** Reads the full observer roster matching the pool ID and displayed revision. */
export function inventoryRoster(row: Record<string, unknown>, snapshots: readonly Record<string, unknown>[]): Record<string, unknown>[] | null {
  const pool = object(row.pool);
  const snapshot = snapshots.find(value => {
    const candidate = object(value.pool);
    return candidate.pool_id === pool.pool_id && candidate.revision === pool.revision;
  });
  return Array.isArray(snapshot?.roster) ? snapshot.roster.map(object) : null;
}

/** Indexes current chat seat Run lineage IDs using only already loaded roster rows. */
export function sessionPoolNames(snapshots: readonly Record<string, unknown>[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const row of snapshots) {
    const pool = object(row.pool);
    for (const member of Array.isArray(row.roster) ? row.roster.map(object) : []) {
      const id = poolSeat(member)?.runAgentId;
      if (id && !names.has(id)) names.set(id, String(pool.name || pool.pool_id));
    }
  }
  return names;
}
