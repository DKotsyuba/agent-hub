/** Tests loaded-only Pool grouping and search without contacting a service. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { groupPools } from '../src/pool-list.ts';

/** Creates one source-shaped inventory row. */
function row(id: string, closed: boolean, name = id, purpose = ''): Record<string, unknown> {
  return { pool: { pool_id: id, name, purpose, revision: 1, closed }, leader_id: 'leader' };
}

/** Extracts ordered producer IDs from projected rows. */
function ids(rows: Record<string, unknown>[]): unknown[] {
  return rows.map(value => (value.pool as Record<string, unknown>).pool_id);
}

test('groups loaded pools by source closure while preserving order and row identity', () => {
  const rows = [row('closed-1', true), row('open-1', false), row('closed-2', true), row('open-2', false)];
  const original = [...rows];
  const groups = groupPools(rows, '');
  assert.deepEqual(ids(groups.open.items), ['open-1', 'open-2']);
  assert.deepEqual(ids(groups.closed.items), ['closed-1', 'closed-2']);
  assert.deepEqual(ids(groups.items), ['open-1', 'open-2', 'closed-1', 'closed-2']);
  assert.equal(groups.open.loaded, 2);
  assert.equal(groups.closed.loaded, 2);
  assert.equal(groups.items[0], rows[1]);
  assert.deepEqual(rows, original);
});

test('search counts only matching loaded rows by name, purpose or ID', () => {
  const rows = [row('alpha', false, 'Inspect', 'Review this'), row('beta', true, 'REVIEW', 'Other'), row('review-3', false, 'Other', 'Other'), row('skip', true, 'Skip', 'Other')];
  const groups = groupPools(rows, '  ReViEw  ');
  assert.deepEqual(ids(groups.items), ['alpha', 'review-3', 'beta']);
  assert.equal(groups.open.loaded, 2);
  assert.equal(groups.closed.loaded, 1);
  assert.deepEqual(ids(groupPools(rows, 'other review').items), ['review-3']);
});

test('empty input, empty matches and later loaded pages remain explicitly loaded-only', () => {
  assert.deepEqual(groupPools([], ''), { open: { items: [], loaded: 0 }, closed: { items: [], loaded: 0 }, items: [] });
  const partial = [row('one', false), row('two', true)];
  assert.deepEqual(groupPools(partial, 'absent'), { open: { items: [], loaded: 0 }, closed: { items: [], loaded: 0 }, items: [] });
  const next = groupPools([...partial, row('three', true)], '');
  assert.equal(next.open.loaded, 1);
  assert.equal(next.closed.loaded, 2);
  assert.deepEqual(ids(next.items), ['one', 'two', 'three']);
});

test('accepted decisions and other states never decide whether a pool is closed', () => {
  const accepted = row('accepted', false), closed = row('closed', true);
  Object.assign(accepted.pool as Record<string, unknown>, { proposal: { state: 'accepted' }, state: 'completed' });
  Object.assign(closed.pool as Record<string, unknown>, { proposal: { state: 'open' } });
  const groups = groupPools([accepted, closed], '');
  assert.deepEqual(ids(groups.open.items), ['accepted']);
  assert.deepEqual(ids(groups.closed.items), ['closed']);
});

test('rejects malformed producer rows instead of guessing a closure state', () => {
  const valid = row('valid', false);
  for (const malformed of [
    null,
    {},
    { pool: null },
    { ...valid, pool: { ...(valid.pool as Record<string, unknown>), closed: undefined } },
    { ...valid, pool: { ...(valid.pool as Record<string, unknown>), closed: 'false' } },
    { ...valid, pool: { ...(valid.pool as Record<string, unknown>), name: null } },
    { ...valid, pool: { ...(valid.pool as Record<string, unknown>), purpose: undefined } },
    { ...valid, pool: { ...(valid.pool as Record<string, unknown>), pool_id: '' } },
    { ...valid, pool: { ...(valid.pool as Record<string, unknown>), revision: -1 } },
    { ...valid, leader_id: null },
  ]) assert.throws(() => groupPools([valid, malformed], 'valid'));
});
