/** Exercises the producer-phase mapping, wait formatting and profile-bearing session labels. */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Session } from '@agent-hub/domain';
import { createLocaleTools } from '../../locales.ts';
import { sessionPhase, sessionTitle, waitingText } from '../model.ts';
import { translations } from '../strings.ts';

/** One phase-bearing session row with only the fields the mapping reads. */
function row(status: Session['status'], phase: string | null, phaseStartedAtMs: number | null = null, idleMs: number | null = null) {
  return { status, phase, phaseStartedAtMs, idleMs };
}

/** Reads a label from an intentionally partial session row. */
function title(row: Partial<Session>) {
  return sessionTitle(row as Session);
}

/** Formats a wait label exactly as the waiting badge does, in the Russian catalogue. */
function waitLabel(waitMs: number | null, sinceMs: number | null) {
  const tools = createLocaleTools('ru');
  return waitingText(waitMs, sinceMs, {
    label: key => translations[key] ?? key,
    duration: tools.duration,
    at: ms => tools.time(new Date(ms).toISOString()),
  });
}

test('a running producer phase is shown as working and a missing phase keeps the running status', () => {
  assert.deepEqual(sessionPhase(row('running', 'running'), 0), { kind: 'working' });
  for (const phase of ['preparing', 'spawning', 'accepted']) assert.deepEqual(sessionPhase(row('starting', phase), 0), { kind: 'working' }, phase);
  assert.deepEqual(sessionPhase(row('running', null), 0), { kind: 'working' });
});

test('an idle phase reports the wait from the phase start and the producer idle time', () => {
  const now = Date.UTC(2026, 10, 26, 13, 17);
  const since = now - 12 * 60_000;
  assert.deepEqual(sessionPhase(row('running', 'idle', since), now), { kind: 'waiting', sinceMs: since, waitMs: 720_000 });
  // The producer's own observation is a floor when the reader clock runs behind.
  assert.deepEqual(sessionPhase(row('running', 'idle', since, 900_000), now), { kind: 'waiting', sinceMs: since, waitMs: 900_000 });
  assert.deepEqual(sessionPhase(row('running', 'idle', null, 300_000), now), { kind: 'waiting', sinceMs: null, waitMs: 300_000 });
  assert.deepEqual(sessionPhase(row('running', 'idle', null, null), now), { kind: 'waiting', sinceMs: null, waitMs: null });
  assert.deepEqual(sessionPhase(row('running', 'idle', now + 60_000), now), { kind: 'waiting', sinceMs: now + 60_000, waitMs: 0 });
});

test('terminal statuses keep their badge and unknown phases stay as the producer named them', () => {
  for (const status of ['succeeded', 'failed', 'timed_out', 'cancelled', 'lost'] as const) {
    assert.deepEqual(sessionPhase(row(status, 'terminal'), 0), { kind: 'status' }, status);
    assert.deepEqual(sessionPhase(row(status, 'idle', 1), 2), { kind: 'status' }, status);
  }
  assert.deepEqual(sessionPhase(row('running', 'tool_call'), 0), { kind: 'phase', phase: 'tool_call' });
  assert.deepEqual(sessionPhase(row('cancelling', 'stopping'), 0), { kind: 'status' });
  assert.deepEqual(sessionPhase(row('created', null), 0), { kind: 'status' });
});

test('the waiting label shows the duration and the local start clock', () => {
  const since = Date.UTC(2026, 10, 26, 13, 5);
  assert.equal(waitLabel(720_000, since), 'Ожидает · 12 мин (с 14:05)');
  assert.equal(waitLabel(300_000, null), 'Ожидает · 5 мин');
  assert.equal(waitLabel(null, since), 'Ожидает (с 14:05)');
  assert.equal(waitLabel(null, null), 'Ожидает');
});

test('session labels append the reported profile and keep the summary fallback', () => {
  const base = { id: 'agent-1', profile: 'reviewer', name: 'Inspect history', summary: 'Review the history.' };
  assert.equal(title(base), 'Inspect history (reviewer)');
  assert.equal(title({ ...base, profile: null }), 'Inspect history');
  assert.equal(title({ ...base, name: 'agent-1' }), 'Review the history. (reviewer)');
  assert.equal(title({ ...base, name: null, summary: null }), undefined);
  assert.equal(title({ ...base, name: 'Inspect history', profile: 'Inspect history' }), 'Inspect history');
});
