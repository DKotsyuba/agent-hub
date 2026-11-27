/** Per-seat custody mapping from the optional Pool observer extension. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { heldMessagesBySession, poolHeldMessages } from '../src/pool-held.ts';

const oldestAtMs = Date.UTC(2026, 10, 27, 9, 38);
const raw = { held_message_count: 3, oldest_held_message_at_ms: oldestAtMs };

test('maps the current custody aggregate and ignores missing, partial, empty, or malformed reports', () => {
  assert.deepEqual(poolHeldMessages(raw), { count: 3, oldestAtMs });
  for (const row of [
    {}, { ...raw, held_message_count: 0 }, { ...raw, held_message_count: 1.5 },
    { ...raw, held_message_count: '3' }, { ...raw, held_message_count: undefined },
    { ...raw, oldest_held_message_at_ms: null }, { ...raw, oldest_held_message_at_ms: 9e15 },
    { notice: { status: 'held', custody_since_ms: oldestAtMs, earlier_undeliverable: 4 } },
  ]) assert.equal(poolHeldMessages(row), undefined);
});

test('joins by current seat Run identity and suppresses ambiguous or retired bindings', () => {
  const seat = { ...raw, seat_id: 'seat-1', run_agent_id: 'ag-1', profile: 'review', admission: 'admitted', joined: true };
  const active = { pool: { closed: false }, roster: [seat] };
  const closed = { pool: { closed: true }, roster: [seat] };
  const retired = { pool: { closed: false }, roster: [{ ...seat, state: 'removed' }] };
  assert.deepEqual([...heldMessagesBySession([active, closed, retired])], [['ag-1', { count: 3, oldestAtMs }]]);
  assert.deepEqual([...heldMessagesBySession([closed, retired])], []);
  assert.equal(heldMessagesBySession([active, active]).get('ag-1'), undefined);
});
