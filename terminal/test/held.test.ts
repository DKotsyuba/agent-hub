/** The terminal header shows one red line when Bridge holds an accepted message past the threshold. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestRenderer } from '@opentui/core/testing';
import { createDemoClient } from '../src/demo.ts';
import { heldShortSummary, heldSummary } from '../src/held.ts';
import { mountHub } from '../src/hub.ts';
import type { ObservationClient } from '../src/api.ts';
import { heldAlarm } from '../../packages/view-model/src/index.ts';
import { pendingCount, scanDeliveriesNewestFirst } from '../../src/live/protocol.ts';

const MINUTE = 60_000;

/** A native client whose Bridge delivery journal holds the given accepted-at ages (minutes). */
function bridgeWith(ages: number[]): ObservationClient {
  const demo = createDemoClient();
  return {
    async read(resource, params = {}, signal) {
      if (resource !== 'bridge.deliveries') return demo.read(resource, params, signal);
      const deliveries = ages.map((age, index) => ({ acceptance_seq: index + 1, publisher: 'claude', event_id: `e${index}`, custody_state: 'pending',
        delivery_state: 'held', accepted_at_ms: Date.now() - age * MINUTE, hold_reason: 'target unavailable', recipient: 'codex@host', attempts: 0 }));
      return { schema_version: 1, source: 'bridge', resource, observed_at_ms: Date.now(), outcome: 'ok', error: null,
        data: { schema_version: 1, kind: 'delivery_page', data: { deliveries, through_seq: deliveries.length, next_after_seq: null, coverage: 'retained_history' } } };
    },
    close: () => demo.close(),
  };
}

test('summaries state the count and the oldest wait', () => {
  const now = Date.now();
  const alarm = heldAlarm([{ acceptedAtMs: now - 362 * MINUTE }, { acceptedAtMs: now - 15 * MINUTE }], now)!;
  assert.equal(heldSummary(alarm), 'Messages to agents not delivered: 2, oldest waiting 6 h 2 min');
  assert.equal(heldShortSummary(alarm), '2 undelivered · 6 h 2 min');
  assert.equal(heldSummary({ ...alarm, complete: false }), 'Messages to agents not delivered: ≥2, oldest waiting 6 h 2 min');
  assert.equal(heldSummary(heldAlarm([{ acceptedAtMs: now - 12 * MINUTE }], now)!), 'Messages to agents not delivered: 1, oldest waiting 12 min');
});

test('the Overview header carries the red held line only past ten minutes', async () => {
  const held = await createTestRenderer({ width: 120, height: 40 });
  const client = bridgeWith([362, 3]);
  const unmount = mountHub(held.renderer, client, 'live', () => {});
  try {
    const frame = await held.waitForFrame(value => value.includes('Messages to agents not delivered'));
    assert.match(frame, /Messages to agents not delivered: 1, oldest waiting 6 h \d+ min/);
  } finally { unmount(); await client.close(); await held.dispose(); }
  const quiet = await createTestRenderer({ width: 120, height: 40 });
  const fresh = bridgeWith([9]);
  const unmountQuiet = mountHub(quiet.renderer, fresh, 'live', () => {});
  try {
    await quiet.waitForFrame(value => value.includes('Agent Bridge'));
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.ok(!quiet.captureCharFrame().includes('not delivered'));
  } finally { unmountQuiet(); await fresh.close(); await quiet.dispose(); }
});

/** Serves the observer's ascending window contract over `total` rows. */
function windows(total: number, calls: [number, number | null, number][] = []) {
  return async (after: number, through: number | null, limit: number) => {
    calls.push([after, through, limit]);
    const high = through ?? total;
    const deliveries = Array.from({ length: Math.max(0, Math.min(high, after + limit) - after) }, (_, index) => ({ acceptance_seq: after + index + 1, accepted_at_ms: 1000 + after + index }));
    return { deliveries, through_seq: high, next_after_seq: null, coverage: 'retained_history' } as Record<string, unknown>;
  };
}

test('the newest-first scan probes the high-water mark, then walks windows backwards', async () => {
  const calls: [number, number | null, number][] = [];
  const scan = (await scanDeliveriesNewestFirst(windows(650, calls)))!;
  assert.deepEqual(calls, [[0, null, 1], [550, 650, 100], [450, 550, 100], [350, 450, 100], [250, 350, 100], [150, 250, 100]]);
  assert.equal(scan.rows.length, 500);
  assert.equal(scan.reachedStart, false);
  assert.equal(scan.oldestScannedAtMs, 1000 + 150);
  const short = (await scanDeliveriesNewestFirst(windows(130)))!;
  assert.equal(short.rows.length, 130);
  assert.equal(short.reachedStart, true);
  const empty = (await scanDeliveriesNewestFirst(windows(0)))!;
  assert.deepEqual([empty.rows.length, empty.reachedStart, empty.oldestScannedAtMs], [0, true, null]);
  assert.equal(await scanDeliveriesNewestFirst(async () => null), null);
});

test('the overview total sums the undelivered states and is null for an older Bridge', () => {
  const overview = (counts: Record<string, number>) => ({ schema_version: 1, kind: 'bridge_overview', data: { counts, retention: {}, coverage: 'retained_history' } });
  assert.equal(pendingCount(overview({ unhanded: 1, reserved: 2, invoking: 3, held: 4, review: 5, accepted: 99 })), 15);
  assert.equal(pendingCount(overview({ unhanded: 1 })), null);
  assert.equal(pendingCount({ schema_version: 1, kind: 'bridge_overview', data: {} }), null);
  assert.equal(pendingCount(null), null);
});
