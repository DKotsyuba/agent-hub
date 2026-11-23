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
  const groups = groupPools(rows, '', true);
  assert.deepEqual(ids(groups.live.items), ['open-1', 'open-2']);
  assert.deepEqual(ids(groups.finished.items), ['closed-1', 'closed-2']);
  assert.deepEqual(ids(groups.items), ['open-1', 'open-2', 'closed-1', 'closed-2']);
  assert.equal(groups.live.loaded, 2);
  assert.equal(groups.finished.loaded, 2);
  assert.equal(groups.items[0], rows[1]);
  assert.deepEqual(rows, original);
});

test('closed pools stay counted but leave the navigation order unless shown', () => {
  const rows = [row('closed-1', true), row('open-1', false), row('closed-2', true)];
  const hidden = groupPools(rows, '', false);
  assert.deepEqual(ids(hidden.items), ['open-1']);
  assert.deepEqual(ids(hidden.finished.items), ['closed-1', 'closed-2']);
  assert.equal(hidden.finished.loaded, 2);
  assert.deepEqual(ids(groupPools(rows, '', true).items), ['open-1', 'closed-1', 'closed-2']);
  assert.deepEqual(ids(groupPools([row('only', true)], '', false).items), []);
});

test('search counts only matching loaded rows by name, purpose or ID', () => {
  const rows = [row('alpha', false, 'Inspect', 'Review this'), row('beta', true, 'REVIEW', 'Other'), row('review-3', false, 'Other', 'Other'), row('skip', true, 'Skip', 'Other')];
  const groups = groupPools(rows, '  ReViEw  ', true);
  assert.deepEqual(ids(groups.items), ['alpha', 'review-3', 'beta']);
  assert.equal(groups.live.loaded, 2);
  assert.equal(groups.finished.loaded, 1);
  assert.deepEqual(ids(groupPools(rows, 'other review').items), ['review-3']);
});

test('empty input, empty matches and later loaded pages remain explicitly loaded-only', () => {
  assert.deepEqual(groupPools([], ''), { live: { items: [], loaded: 0 }, finished: { items: [], loaded: 0 }, unknown: { items: [], loaded: 0 }, items: [] });
  const partial = [row('one', false), row('two', true)];
  assert.deepEqual(groupPools(partial, 'absent'), { live: { items: [], loaded: 0 }, finished: { items: [], loaded: 0 }, unknown: { items: [], loaded: 0 }, items: [] });
  const next = groupPools([...partial, row('three', true)], '', true);
  assert.equal(next.live.loaded, 1);
  assert.equal(next.finished.loaded, 2);
  assert.deepEqual(ids(next.items), ['one', 'two', 'three']);
});

test('accepted decisions and other states never decide whether a pool is closed', () => {
  const accepted = row('accepted', false), closed = row('closed', true);
  Object.assign(accepted.pool as Record<string, unknown>, { proposal: { state: 'accepted' }, state: 'completed' });
  Object.assign(closed.pool as Record<string, unknown>, { proposal: { state: 'open' } });
  const groups = groupPools([accepted, closed], '');
  assert.deepEqual(ids(groups.live.items), ['accepted']);
  assert.deepEqual(ids(groups.finished.items), ['closed']);
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

test('only a durable completion ID or closure moves a pool to Finished', () => {
  const active = { ...row('live', false), kind: 'chat', completion_id: null };
  const completed = { ...row('done', false), kind: 'chat', completion_id: 'agreement-1' };
  const closed = { ...row('closed', true), kind: 'chat' };
  assert.deepEqual(ids(groupPools([active, completed, closed], '').items), ['live']);
  assert.deepEqual(ids(groupPools([active, completed, closed], '', true).finished.items), ['done', 'closed']);
});

test('an open agreement appears under Finished and unknown closure stays out of Live', () => {
  const completed = row('completed', false);
  const unknown = row('unknown', false);
  Object.assign(completed.pool as object, { kind: 'chat', completion_id: 'agreement-1' });
  Object.assign(unknown.pool as object, { closure_state: 'unknown' });
  const groups = groupPools([completed, unknown, row('live', false), row('closed', true)], '', true);
  assert.deepEqual(ids(groups.live.items), ['live']);
  assert.deepEqual(ids(groups.finished.items), ['completed', 'closed']);
  assert.deepEqual(ids(groups.unknown.items), ['unknown']);
  assert.deepEqual(ids(groupPools([completed, unknown], '').items), ['unknown']);
});
