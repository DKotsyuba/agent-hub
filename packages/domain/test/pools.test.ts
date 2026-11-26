/** Decodes Pool member rows with and without the optional linked Run display row. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { member } from '../src/index.ts';

/** One roster entry whose seat and Run link are already known. */
const base = {
  id: 'm-1', name: 'Worker', role: 'implement', task: 'Write the change', state: 'active', runtime: 'claude-code',
  seat: { id: 'seat-1', profile: 'implement', admission: 'admitted', joined: true },
  session: { sessionId: 'ag-1', execution: null, match: 'unverified' }, lineage: null,
};

test('a Pool member row decodes with an absent, null or linked Run row', () => {
  assert.equal(member(base).run, undefined);
  assert.equal(member({ ...base, run: null }).run, null);
  const run = {
    status: 'running', phase: 'idle', phaseStartedAtMs: 1_000, idleMs: 720_000, observedAtMs: 721_000,
    model: 'claude-sonnet-5-5', createdAtMs: 0, elapsedMs: 721_000, finishedAtMs: null,
  };
  assert.deepEqual(member({ ...base, run }).run, run);
  assert.throws(() => member({ ...base, run: { ...run, status: 'sleeping' } }), /run\.status/);
});
