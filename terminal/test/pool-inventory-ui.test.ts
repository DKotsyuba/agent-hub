/** Checks that the Pool list labels source-wide totals only from an advertised snapshot read. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createTestRenderer } from '@opentui/core/testing';
import type { ObservationClient, ReadResponse } from '../src/api.ts';
import { createDemoClient } from '../src/demo.ts';
import { mountHub } from '../src/hub.ts';

type Json = Record<string, any>;
const pages = (JSON.parse(readFileSync(new URL('./fixtures/pool-inventory-snapshot-v1.json', import.meta.url), 'utf8')) as { pages: Json[] }).pages;

/** Wraps the synthetic client, advertising the capability and answering the snapshot read through `snapshot`. */
function client(capabilities: string[], snapshot: (call: number) => ReadResponse | Promise<ReadResponse>, calls: Record<string, unknown>[] = []): ObservationClient {
  const demo = createDemoClient();
  return {
    async read(resource, params, signal) {
      if (resource === 'pool.inventory_snapshot') { calls.push(params ?? {}); return snapshot(calls.length); }
      const response = await demo.read(resource, params, signal);
      if (resource !== 'pool.identity' || !response.data) return response;
      const outer = response.data as { data: Json };
      return { ...response, data: { ...outer, data: { ...outer.data, capabilities } } };
    },
    close: () => demo.close(),
  };
}
/** Builds a native response around a producer envelope. */
function answer(data: unknown, outcome: ReadResponse['outcome'] = 'ok'): ReadResponse {
  return { schema_version: 1, source: 'pool', resource: 'pool.inventory_snapshot', observed_at_ms: Date.now(), outcome, data: outcome === 'ok' ? data : null, error: outcome === 'ok' ? null : { code: 'source_error', message: 'Source returned a structured read error.' } };
}
/** Opens the Pool list of a mounted Hub. */
async function openPools(setup: Awaited<ReturnType<typeof createTestRenderer>>): Promise<void> {
  setup.mockInput.pressKey('2');
  await setup.waitForFrame(value => value.includes('Agent Pool') && value.includes('Synthetic review pool'));
}

test('an advertising observer shows exact totals and keeps Open/Completed unavailable', async () => {
  const setup = await createTestRenderer({ width: 140, height: 40 }), calls: Record<string, unknown>[] = [];
  const hub = client(['identity', 'list', 'get', 'inventory_snapshot_v1'], () => answer(pages[0]), calls);
  const unmount = mountHub(setup.renderer, hub, 'demo', () => {});
  try {
    await openPools(setup);
    const frame = await setup.waitForFrame(value => value.includes('Source snapshot r42'));
    assert.match(frame, /2 retained · 1 closed/);
    assert.match(frame, /Open \/ Completed: unavailable/);
    assert.match(frame, /Closed is not completion/);
    assert.deepEqual(calls[0], { filter: 'all', limit: 1 });
    assert.ok(calls.every(call => Object.keys(call).sort().join() === 'filter,limit'), 'only the first fixed page is requested');
  } finally { unmount(); await hub.close(); await setup.dispose(); }
});

test('an observer without the capability never receives the read and is labelled unavailable', async () => {
  const setup = await createTestRenderer({ width: 140, height: 40 }), calls: Record<string, unknown>[] = [];
  const hub = client(['identity', 'list', 'get'], () => answer(pages[0]), calls);
  const unmount = mountHub(setup.renderer, hub, 'demo', () => {});
  try {
    await openPools(setup);
    await setup.waitForFrame(value => value.includes('Source-wide totals unavailable') && value.includes('inventory_snapshot_v1'));
    assert.equal(calls.length, 0);
  } finally { unmount(); await hub.close(); await setup.dispose(); }
});

test('a failed or malformed snapshot is labelled and never replaced by loaded-row counts', async () => {
  for (const [name, reply, label] of [['unavailable', () => answer(null, 'unavailable'), 'Source-wide totals unavailable'], ['malformed', () => answer({ schema_version: 1, kind: 'inventory_snapshot', data: { totals: { total: 2 } } }), 'Source-wide totals invalid']] as const) {
    const setup = await createTestRenderer({ width: 140, height: 40 });
    const hub = client(['identity', 'list', 'get', 'inventory_snapshot_v1'], reply);
    const unmount = mountHub(setup.renderer, hub, 'demo', () => {});
    try {
      await openPools(setup);
      const frame = await setup.waitForFrame(value => value.includes(label));
      assert.doesNotMatch(frame, /Source snapshot r/, name);
      assert.match(frame, /Open · 1 loaded/, 'loaded groups keep their loaded-only label');
    } finally { unmount(); await hub.close(); await setup.dispose(); }
  }
});

test('the last good snapshot is marked stale when a later read fails', async () => {
  const setup = await createTestRenderer({ width: 140, height: 40 });
  const hub = client(['identity', 'list', 'get', 'inventory_snapshot_v1'], call => call === 1 ? answer(pages[0]) : answer(null, 'unavailable'));
  const unmount = mountHub(setup.renderer, hub, 'demo', () => {});
  try {
    await openPools(setup);
    await setup.waitForFrame(value => value.includes('Source snapshot r42'));
    setup.mockInput.pressKey('r');
    await setup.waitForFrame(value => value.includes('STALE · Source snapshot r42'));
  } finally { unmount(); await hub.close(); await setup.dispose(); }
});
