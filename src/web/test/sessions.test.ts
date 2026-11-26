/** Exercises the producer-phase mapping, wait formatting and profile-bearing session labels. */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Session } from '@agent-hub/domain';
import { createLocaleTools } from '../../locales.ts';
import { sessionPhase, sessionTitle, waitingText } from '../model.ts';
import { translations } from '../strings.ts';

/** One phase-bearing session row with only the fields the mapping reads. */
function row(status: Session['status'], phase: string | null, phaseStartedAtMs: number | null = null, idleMs: number | null = null,
  observedAtMs: number | null = null) {
  return { status, phase, phaseStartedAtMs, idleMs, observedAtMs };
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

test('a running producer phase is working, timed from its phase start; a missing phase keeps the running status', () => {
  const none = { kind: 'working', sinceMs: null, waitMs: null };
  assert.deepEqual(sessionPhase(row('running', 'running'), 0), none);
  for (const phase of ['preparing', 'spawning', 'accepted']) assert.deepEqual(sessionPhase(row('starting', phase), 0), none, phase);
  assert.deepEqual(sessionPhase(row('running', null), 0), none);
  assert.deepEqual(sessionPhase(row('running', 'running', 1_000), 61_000), { kind: 'working', sinceMs: 1_000, waitMs: 60_000 });
});

test('an idle wait starts at observation minus the reported idle time, not at a refreshed phase start', () => {
  const now = Date.UTC(2026, 10, 26, 18, 14);
  const observed = now - 30_000;
  // Run refreshed the phase start 10 s ago, but the agent has been idle for 26 minutes.
  assert.deepEqual(sessionPhase(row('running', 'idle', now - 10_000, 26 * 60_000, observed), now),
    { kind: 'waiting', sinceMs: observed - 26 * 60_000, waitMs: 30_000 + 26 * 60_000 });
  // Without the idle observation the phase start is the only source.
  assert.deepEqual(sessionPhase(row('running', 'idle', now - 720_000), now), { kind: 'waiting', sinceMs: now - 720_000, waitMs: 720_000 });
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
