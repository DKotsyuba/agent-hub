/** Optional per-seat Bridge custody evidence from the Pool observer. */
import type { Session } from '@agent-hub/domain';
import { object, product } from '../../src/live/protocol.ts';
import { poolSeat } from '../../terminal/src/pool-chat.ts';
import { walkInventory } from '../../terminal/src/pool-inventory.ts';
import type { ReadContext } from './projection.ts';

/** Projects a positive count and usable epoch-millisecond clock as one fact. */
export function poolHeldMessages(row: Record<string, unknown>): Session['heldMessages'] {
  const { held_message_count: count, oldest_held_message_at_ms: oldestAtMs } = row;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count <= 0
    || typeof oldestAtMs !== 'number' || !Number.isSafeInteger(oldestAtMs) || oldestAtMs < 0 || oldestAtMs > 8.64e15) return undefined;
  return { count, oldestAtMs };
}

/** Indexes current chat seat evidence by exact Run identity, omitting ambiguous bindings. */
export function heldMessagesBySession(pools: readonly Record<string, unknown>[]) {
  const seats = new Map<string, Session['heldMessages']>();
  for (const pool of pools) {
    if (object(pool.pool).closed !== false || !Array.isArray(pool.roster)) continue;
    for (const value of pool.roster) {
      const row = object(value);
      if (row.state === 'removed') continue;
      const id = poolSeat(row)?.runAgentId;
      if (id) seats.set(id, seats.has(id) ? undefined : poolHeldMessages(row));
    }
  }
  return seats;
}

/** Enriches the current Sessions page from one bounded Pool inventory snapshot when supported. */
export async function withPoolHeldMessages(ctx: ReadContext, rows: Session[]): Promise<Session[]> {
  if (!rows.some(row => row.phase?.trim() === 'idle')) return rows;
  try {
    const identity = await ctx.read('pool.identity');
    if (identity.outcome !== 'ok') return rows;
    const { capabilities } = product(identity.data, 'identity');
    if (!Array.isArray(capabilities) || !capabilities.includes('seat_held_messages_v1')
      || !capabilities.includes('inventory_snapshot_v1')) return rows;
    const inventory = await walkInventory(params => ctx.read('pool.inventory_snapshot', params), {
      filter: 'not_closed', limit: 10, maxPages: 8, restarts: 0, current: () => !ctx.signal.aborted,
    });
    if (inventory.state !== 'ok') return rows;
    const bySession = heldMessagesBySession(inventory.rows);
    return rows.map(row => {
      const heldMessages = bySession.get(row.id);
      return heldMessages ? { ...row, heldMessages } : row;
    });
  } catch {
    // Pool evidence is optional and independent of the Run inventory.
    return rows;
  }
}
