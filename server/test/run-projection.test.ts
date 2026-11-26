/** Checks that producer phase facts reach the served session row unchanged. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { runAgent } from '../../src/live/protocol.ts';
import { sessionRow } from '../src/run.ts';

/** Minimal Run inventory row with the phase facts under test. */
function agent(extra: Record<string, unknown>) {
  return runAgent({ agent_id: 'agent-1', sequence: 1, status: 'running', task_summary: 'Wait for events', ...extra });
}

test('phase, phase start, idle time and profile are carried into the session row', () => {
  const row = sessionRow(agent({
    phase: 'idle', phase_started_at: 1_000_000.5, idle_seconds: 720.4, profile: 'reviewer',
  }));
  assert.equal(row.phase, 'idle');
  assert.equal(row.phaseStartedAtMs, 1_000_000_500);
  assert.equal(row.idleMs, 720_400);
  assert.equal(row.profile, 'reviewer');
});

test('an unrecognized phase is preserved and a producer without phase facts stays unknown', () => {
  assert.equal(sessionRow(agent({ phase: 'tool_call' })).phase, 'tool_call');
  const older = sessionRow(agent({}));
  assert.deepEqual([older.phase, older.phaseStartedAtMs, older.idleMs, older.profile], [null, null, null, null]);
  assert.equal(sessionRow(agent({ idle_seconds: -1 })).idleMs, null);
});
