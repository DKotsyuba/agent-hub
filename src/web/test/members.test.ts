/** Exercises the Pool member labels: task role prefixes, names and seat profiles. */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolMember } from '@agent-hub/domain';
import { memberTitle } from '../model.ts';

/** Reads a title from an intentionally partial member row. */
function title(item: Partial<PoolMember>) {
  return memberTitle(item as PoolMember);
}

/** A seat whose profile stays visible after the role label. */
function member(profile: string | null) {
  return { seat: profile === null ? null : { id: 'seat-1', profile, admission: 'admitted' as const, joined: true } };
}

test('a member title uses the task role prefix and appends the seat profile', () => {
  const base = { id: 'm-1', name: 'Worker', task: 'Исследователь (лидер): проверь план', ...member('лидер') };
  assert.equal(title(base), 'Исследователь (лидер)');
  assert.equal(title({ ...base, task: 'Исследователь: проверь план', ...member('builder') }), 'Исследователь (builder)');
  assert.equal(title({ ...base, task: 'Исследователь: проверь план', ...member(null) }), 'Исследователь');
});

test('a member without a role prefix falls back to its name and never repeats the task', () => {
  const base = { id: 'm-1', name: 'Example reviewer', task: 'Write the change', ...member('review') };
  assert.equal(title(base), 'Example reviewer (review)');
  assert.equal(title({ ...base, name: null, ...member(null) }), undefined);
  assert.equal(title({ ...base, name: 'm-1', ...member(null) }), undefined);
});

test('a task head longer than 40 characters is not used as a role label', () => {
  const base = { id: 'm-1', name: 'Worker', task: 'Review every retained execution that mentions the migration: now', ...member(null) };
  assert.equal(title(base), 'Worker');
  assert.equal(title({ ...base, task: 'Review the change: now' }), 'Review the change');
});
