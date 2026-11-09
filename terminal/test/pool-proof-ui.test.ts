/** Exercises Pool-fenced Run proof rendering without accessing a real service. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createTestRenderer } from '@opentui/core/testing';
import { object } from '../../src/live/protocol.ts';
import { createDemoClient } from '../src/demo.ts';
import { mountHub } from '../src/hub.ts';
import type { ObservationClient, ReadResponse } from '../src/api.ts';
import type { RunStatusRequest } from '../src/run-status.ts';

interface Fixture { request: RunStatusRequest; result: Record<string, unknown> }
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/run-status-v1.json', import.meta.url), 'utf8')) as { cases: Record<string, Fixture> };

/** Supplies a current roster and independently controllable Pool proof responses. */
function proofClient(name: string) {
  const demo = createDemoClient(), fixture = structuredClone(fixtures.cases[name]), target = fixture.request.targets[0];
  let mode: 'observed' | 'confirmed' | 'unknown' | 'partial' | 'unavailable' = 'observed', revision = 1, directReads = 0;
  let delayRevision: number | null = null, held = false, incomplete = false, release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const requests: Record<string, unknown>[] = [];
  const client: ObservationClient = {
    async read(resource, params = {}, signal) {
      if (resource === 'run.status') directReads++;
      if (resource === 'pool.run_proof') {
        requests.push(structuredClone(params));
        if (params.expected_revision === delayRevision) { held = true; await pending; }
        const base: ReadResponse = { schema_version: 1, source: 'pool', resource, observed_at_ms: Date.now(), outcome: 'ok', data: null, error: null };
        if (mode === 'unavailable') return { ...base, outcome: 'unavailable', error: { code: 'fixture', message: 'Unavailable' } };
        const common = { pool_id: 'demo-pool', member_id: 'demo-member', pool_revision: params.expected_revision, current: true, observed_at_unix_ms: 2000, author_identity: 'unknown' };
        const status = structuredClone((fixture.result.items as Record<string, unknown>[])[0]);
        if (mode === 'confirmed') { status.retained_latest = structuredClone(status.selected); status.lineage_terminal = true; status.terminal_outcome = 'succeeded'; status.success_commit = 'recorded'; object(status.cleanup).state = 'confirmed'; }
        const data = mode === 'unknown' ? { ...common, state: 'unknown', reason: incomplete ? 'incomplete_binding' : 'run_unavailable' } : { ...common, state: 'observed', store_id: fixture.result.store_id, run_observed_at: fixture.result.observed_at, proof: { status, historical_success: mode === 'confirmed', outcome_scope: 'retained_latest' } };
        return { ...base, outcome: mode === 'partial' ? 'partial' : 'ok', data: { schema_version: 1, kind: 'run_proof', data } };
      }
      const response = await demo.read(resource, params, signal);
      if (!response.data) return response;
      if (resource === 'pool.identity') {
        const outer = object(response.data), data = object(outer.data);
        return { ...response, data: { ...outer, data: { ...data, capabilities: [...data.capabilities as string[], 'run_proof_v1'] } } };
      }
      if (resource === 'pool.get' && params.section === 'members') {
        const outer = object(response.data), data = object(outer.data), view = object(data.view), pool = object(view.pool);
        const bindings = (data.bindings as Record<string, unknown>[]).map(binding => ({ ...binding, run_id: incomplete ? null : target.agent_id, run_sequence: incomplete ? null : target.sequence, run_execution_ref: incomplete ? null : target.execution_ref, run_pin_id: incomplete ? null : target.pin_id, run_store_id: incomplete ? null : fixture.result.store_id }));
        return { ...response, data: { ...outer, data: { ...data, bindings, view: { ...view, pool: { ...pool, revision } } } } };
      }
      return response;
    },
    close: () => demo.close(),
  };
  return { client, requests, directReads: () => directReads, setMode: (value: typeof mode) => { mode = value; }, setIncomplete: () => { incomplete = true; }, setRevision: (value: number) => { revision = value; }, delay: (value: number) => { delayRevision = value; }, held: () => held, release };
}

for (const [name, label] of [['verified_selected_not_tail', 'Run lineage: not terminal'], ['restart_pending_raw_terminal', 'Run lineage: restart pending']] as const) test(`Pool-fenced evidence renders ${name} without requiring direct Run access`, async () => {
  const setup = await createTestRenderer({ width: 160, height: 40 }), source = proofClient(name);
  const unmount = mountHub(setup.renderer, source.client, 'live', () => {}, undefined, { pool: 'demo-pool' });
  try {
    const frame = await setup.waitForFrame(value => value.includes(label) && value.includes('Cleanup: pending'));
    assert.match(frame, /Run .* · Pool /);
    assert.deepEqual(source.requests[0], { pool_id: 'demo-pool', section: 'run_proof', member_id: 'demo-member', expected_revision: 1 });
    assert.equal(source.directReads(), 0);
  } finally { source.release(); unmount(); await source.client.close(); await setup.dispose(); }
});

test('Pool unknown and partial evidence never become a successful direct status', async () => {
  const setup = await createTestRenderer({ width: 160, height: 40 }), source = proofClient('verified_selected_not_tail');
  const unmount = mountHub(setup.renderer, source.client, 'live', () => {}, undefined, { pool: 'demo-pool' });
  try {
    await setup.waitForFrame(value => value.includes('Run lineage: not terminal'));
    source.setMode('unknown'); setup.mockInput.pressKey('r');
    let frame = await setup.waitForFrame(value => value.includes('Run proof: unknown') && value.includes('run_unavailable'));
    assert.doesNotMatch(frame, /Cleanup: confirmed/);
    assert.doesNotMatch(frame, /Run lineage: not terminal/);
    source.setMode('partial'); setup.mockInput.pressKey('r');
    frame = await setup.waitForFrame(value => value.includes('proof not verified'));
    assert.doesNotMatch(frame, /Cleanup: confirmed/);
    assert.equal(source.directReads(), 0);
  } finally { source.release(); unmount(); await source.client.close(); await setup.dispose(); }
});

test('a delayed proof cannot cross a new Pool roster revision', async () => {
  const setup = await createTestRenderer({ width: 160, height: 40 }), source = proofClient('verified_selected_not_tail');
  const unmount = mountHub(setup.renderer, source.client, 'live', () => {}, undefined, { pool: 'demo-pool' });
  try {
    await setup.waitForFrame(value => value.includes('Run lineage: not terminal'));
    source.delay(1); setup.mockInput.pressKey('r'); await setup.waitFor(() => source.held());
    source.setRevision(2); source.setMode('unknown'); setup.mockInput.pressKey('r');
    await setup.waitForFrame(value => value.includes('Run proof: unknown') && value.includes('run_unavailable'));
    source.release(); await new Promise(resolve => setTimeout(resolve, 0));
    const frame = await setup.waitForFrame(value => value.includes('Run proof: unknown'));
    assert.doesNotMatch(frame, /Run lineage: not terminal/);
    assert.ok(source.requests.some(request => request.expected_revision === 2));
  } finally { source.release(); unmount(); await source.client.close(); await setup.dispose(); }
});

test('Pool can explain an incomplete binding without inventing a Run selector', async () => {
  const setup = await createTestRenderer({ width: 160, height: 40 }), source = proofClient('verified_selected_not_tail');
  source.setMode('unknown'); source.setIncomplete();
  const unmount = mountHub(setup.renderer, source.client, 'live', () => {}, undefined, { pool: 'demo-pool' });
  try {
    const frame = await setup.waitForFrame(value => value.includes('Run proof: unknown') && value.includes('incomplete_binding'));
    assert.match(frame, /No confirmed Run binding/);
    assert.equal(source.directReads(), 0);
  } finally { source.release(); unmount(); await source.client.close(); await setup.dispose(); }
});

test('a failed refresh cannot present earlier confirmed cleanup as current', async () => {
  const setup = await createTestRenderer({ width: 160, height: 40 }), source = proofClient('verified_selected_not_tail');
  source.setMode('confirmed');
  const unmount = mountHub(setup.renderer, source.client, 'live', () => {}, undefined, { pool: 'demo-pool' });
  try {
    await setup.waitForFrame(value => value.includes('Cleanup: confirmed'));
    source.setMode('unavailable'); setup.mockInput.pressKey('r');
    const frame = await setup.waitForFrame(value => value.includes('STALE · Run lineage:') && value.includes('Cleanup: unknown'));
    assert.doesNotMatch(frame, /Cleanup: confirmed/);
    assert.equal(source.directReads(), 0);
  } finally { source.release(); unmount(); await source.client.close(); await setup.dispose(); }
});
