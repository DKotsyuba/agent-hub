/** Pool chat v1 observer fields: pool kind and per-seat Run identity, all optional for older Pool builds. */
import { object } from '../../src/live/protocol.ts';

/** Pool kind reported by newer observers: an ordinary Run chat pool or a legacy managed pool. */
export type PoolKind = 'chat' | 'managed';

/** Admission of one chat seat's Run job as recorded by Pool; independent of join and process state. */
export type SeatAdmission = 'pending' | 'admitted' | 'refused' | 'unknown';

/** Validated chat seat projection of one member row. */
export interface PoolSeat { seatId: string; runAgentId: string | null; profile: string; admission: SeatAdmission; joined: boolean }

const ADMISSIONS: readonly string[] = ['pending', 'admitted', 'refused', 'unknown'];

/** Pool-level facts newer observers attach to an inventory row or a detail page. */
export interface PoolFacts { kind: PoolKind | null; /** String: committed record; null: reported not completed; undefined: not reported (older Pool). */ completionId: string | null | undefined }

/** Strict Pool identifier form for a completion or agreement ID. */
const COMPLETION_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * Reads the optional `kind` and `completion_id` from the objects that may carry them: the inventory row or
 * detail page (`pools[]`, `data`) and its nested pool object. Absent means an older Pool; a malformed value, or
 * two sources that disagree, is rejected rather than guessed.
 */
export function poolFacts(...sources: Record<string, unknown>[]): PoolFacts {
  let kind: PoolKind | null = null, completionId: string | null | undefined;
  for (const source of sources) {
    if (source.kind !== undefined) {
      if (source.kind !== 'chat' && source.kind !== 'managed') throw new Error('pool_kind');
      if (kind !== null && kind !== source.kind) throw new Error('pool_kind');
      kind = source.kind;
    }
    const id = source.completion_id;
    if (id !== undefined) {
      if (id !== null && (typeof id !== 'string' || !COMPLETION_ID.test(id))) throw new Error('pool_completion_id');
      if (completionId !== undefined && completionId !== id) throw new Error('pool_completion_id');
      completionId = id;
    }
  }
  return { kind, completionId };
}

/** Human label for a pool kind; null when the observer does not report one. */
export function poolKindLabel(kind: PoolKind | null): string | null {
  return kind === 'chat' ? 'chat pool' : kind === 'managed' ? 'managed pool (legacy)' : null;
}

/**
 * Reads the optional seat fields of a member row. Returns null for rows without any new field (managed pools
 * and older observers); a partially present or mistyped set is rejected rather than half-displayed.
 */
export function poolSeat(member: Record<string, unknown>): PoolSeat | null {
  const names = ['seat_id', 'run_agent_id', 'profile', 'admission', 'joined'] as const;
  if (names.every(name => member[name] === undefined)) return null;
  const { seat_id: seatId, run_agent_id: agent, profile, admission, joined } = member;
  if (typeof seatId !== 'string' || !seatId || typeof profile !== 'string' || typeof admission !== 'string' || !ADMISSIONS.includes(admission) || typeof joined !== 'boolean' || agent !== null && (typeof agent !== 'string' || !agent)) throw new Error('pool_seat');
  return { seatId, runAgentId: agent as string | null, profile, admission: admission as SeatAdmission, joined };
}

/** Validates the seats of a member list; seats appear only on chat pools. */
export function checkSeats(members: unknown, kind: PoolKind | null): void {
  if (!Array.isArray(members)) return;
  for (const value of members) if (poolSeat(object(value)) && kind === 'managed') throw new Error('pool_seat_kind');
}
