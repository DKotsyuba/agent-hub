/** The terminal header shows one red line when Bridge holds an accepted message past the threshold. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestRenderer } from '@opentui/core/testing';
import { createDemoClient } from '../src/demo.ts';
import { heldShortSummary, heldSummary } from '../src/held.ts';
import { mountHub } from '../src/hub.ts';
import type { ObservationClient } from '../src/api.ts';
import { heldAlarm } from '../../packages/view-model/src/index.ts';

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
