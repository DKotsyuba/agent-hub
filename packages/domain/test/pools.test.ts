/** Decodes Pool member rows with and without the linked Run agent's session row. */
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
    id: 'ag-20261107-002455-e0caf0d956', execution: null, sequence: 1, status: 'running', runtime: 'claude-code',
    model: 'claude-sonnet-5-5', effort: null, profile: 'implement', name: null, summary: 'Write the change', workdir: null,
    projectId: null, projectInferred: false, phase: 'idle', phaseStartedAtMs: 1_000, idleMs: 720_000, createdAtMs: 0,
    finishedAtMs: null, observedAtMs: 721_000, progressAtMs: null, elapsedMs: 721_000, silenceMs: null, lastAction: null,
    failureKind: null, failureText: null, answerAvailable: null,
  };
  assert.deepEqual(member({ ...base, run }).run, run);
  assert.throws(() => member({ ...base, run: { ...run, status: 'sleeping' } }), /run\.status/);
});
