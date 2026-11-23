/** Which list tab a pool belongs to: a completed pool that is not closed is finished work, not an open one. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { lifecycle } from '../src/pool.ts';

test('an open pool without a record is open', () => {
  assert.equal(lifecycle({ state: 'open', record: undefined }), 'open');
  assert.equal(lifecycle({ state: 'open', record: null }), 'open');
});

test('a pool that is not closed but carries a completion or agreement record is listed with the closed ones', () => {
  assert.equal(lifecycle({ state: 'open', record: { id: 'c1', kind: 'completion' } }), 'closed');
  assert.equal(lifecycle({ state: 'open', record: { id: 'a1', kind: 'agreement' } }), 'closed');
});

test('closed and unknown pools keep their state, record or not', () => {
  assert.equal(lifecycle({ state: 'closed', record: null }), 'closed');
  assert.equal(lifecycle({ state: 'closed', record: { id: 'c1', kind: 'completion' } }), 'closed');
  assert.equal(lifecycle({ state: 'unknown', record: { id: 'c1', kind: 'completion' } }), 'unknown');
  assert.equal(lifecycle({ state: 'unknown', record: undefined }), 'unknown');
});
