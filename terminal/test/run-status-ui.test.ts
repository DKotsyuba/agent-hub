/** Exercises Pool navigation against synthetic status v1 source observations. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createTestRenderer } from '@opentui/core/testing';
import { createDemoClient, DEMO_POOL_AGENT_ID, DEMO_POOL_INDEX_ID } from '../src/demo.ts';
import { mountHub } from '../src/hub.ts';
import { object, sha256 } from '../../src/live/protocol.ts';
import type { ObservationClient, ReadResponse } from '../src/api.ts';
import type { RunStatusRequest } from '../src/run-status.ts';

interface Fixture { request: RunStatusRequest; result: Record<string, unknown> }
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/run-status-v1.json', import.meta.url), 'utf8')) as { cases: Record<string, Fixture> };
type Mode = 'normal' | 'mismatch' | 'missing' | 'unknown' | 'source_error' | 'connect_error' | 'ref_change' | 'no_view' | 'partial' | 'ok_error' | 'pin_released';

/** Supplies a real-shaped status fixture while retaining the existing synthetic Pool UI. */
function statusClient(name: string, newerInventory = false, configure?: (fixture: Fixture) => void) {
  const fixture = structuredClone(fixtures.cases[name]), demo = createDemoClient(), requests: Record<string, unknown>[] = [], transcripts: Record<string, unknown>[] = [];
  configure?.(fixture);
  const target = fixture.request.targets[0], expectedStore = fixture.request.expected_store_id;
  let mode: Mode = 'normal', statusRequested = false, laterInventory = 0, historyMarker: string | null = null;
  const client: ObservationClient = {
    async read(resource, params = {}, signal) {
      if (resource === 'run.status') {
        statusRequested = true;
        requests.push(structuredClone(params));
        const base: ReadResponse = { schema_version: 1, source: 'run', resource, observed_at_ms: Date.now(), outcome: 'ok', data: structuredClone(fixture.result), error: null };
        if (mode === 'source_error' || mode === 'connect_error') return { ...base, outcome: 'unavailable', data: null, error: { code: mode === 'source_error' ? 'run_source_error' : 'run_connect', message: 'Source unavailable.' } };
        if (mode === 'partial') return { ...base, outcome: 'partial' };
        if (mode === 'ok_error') return { ...base, error: { code: 'producer_error', message: 'Source unavailable.' } };
        if (mode === 'mismatch' || mode === 'missing' || mode === 'unknown') {
          const data = base.data as { items: Record<string, unknown>[]; view?: unknown };
          data.items = data.items.map(item => ({ ...item, match: mode, selected: null, retained_latest: null, coverage: 'unknown', restart_resume: 'unknown', lineage_terminal: null, terminal_outcome: null, success_commit: 'unknown', cleanup: { scope: 'lineage', state: 'unknown' } }));
          delete data.view;
        }
        if (mode === 'ref_change') object(object((object(base.data).items as unknown[])[0]).selected).execution_ref = `ex1_${'b'.repeat(64)}`;
        if (mode === 'pin_released') { const item = object((object(base.data).items as unknown[])[0]); item.pin_state = 'released'; item.coverage = 'unknown'; item.restart_resume = 'unknown'; item.lineage_terminal = null; item.terminal_outcome = null; item.success_commit = 'unknown'; object(item.cleanup).state = 'unknown'; }
        if (mode === 'no_view') delete (base.data as { view?: unknown }).view;
        return base;
      }
      if (resource === 'run.transcript') {
        transcripts.push(structuredClone(params));
        const response = await demo.read(resource, { ...params, agent_id: 'demo-inspect' }, signal);
        if (!response.data) return response;
        const data = { ...(response.data as Record<string, unknown>), agent_id: params.agent_id };
        return historyMarker ? { ...response, data: { ...data, messages: [{ seq: 1, role: 'assistant', content: historyMarker, at: 100, content_complete: true }], complete: true, previous_cursor: null, next_cursor: null, resume_cursor: 1 } } : { ...response, data };
      }
      if (resource === 'run.agents' && statusRequested) laterInventory++;
      const response = await demo.read(resource, params, signal);
      if (resource === 'pool.get' && params.section === 'members' && response.data) {
        const outer = response.data as { data: { bindings: Record<string, unknown>[] } };
        const bindings = outer.data.bindings.map(binding => ({ ...binding, run_id: target.agent_id, run_sequence: target.sequence, run_execution_ref: target.execution_ref, run_pin_id: target.pin_id, run_store_id: expectedStore }));
        return { ...response, data: { ...outer, data: { ...outer.data, bindings } } };
      }
      if (newerInventory && resource === 'run.agents' && response.data) {
        const data = response.data as { items: Record<string, unknown>[] };
        return { ...response, data: { ...data, items: data.items.map(item => item.agent_id === 'demo-inspect' ? { ...item, agent_id: target.agent_id, sequence: target.sequence + 1 } : item) } };
      }
      return response;
    },
    close: () => demo.close(),
  };
  return { client, fixture, requests, transcripts, laterInventory: () => laterInventory, setMode: (next: Mode) => { mode = next; }, setHistory: (value: string) => { historyMarker = value; } };
}

/** Models an old binding without a confirmed store or retention pin. */
function withoutPinFence(fixture: Fixture): void {
  delete fixture.request.expected_store_id;
  delete fixture.request.targets[0].pin_id;
  const item = object((fixture.result.items as unknown[])[0]);
  delete object(item.selector).pin_id;
  item.pin_id = null; item.pin_state = 'missing'; item.coverage = 'unknown'; item.restart_resume = 'unknown';
}

/** Adds a bounded exact-transcript source to the existing verified Pool fixture. */
function exactCopyClient(mode: 'ok' | 'partial' | 'unsupported' | 'delayed' = 'ok') {
  const source = statusClient('verified_selected_not_tail'), base = source.client;
  let started = false, release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const requests: Record<string, unknown>[] = [];
  const client: ObservationClient = {
    async read(resource, params = {}, signal) {
      if (resource === 'run.identity') return { schema_version: 1, source: 'run', resource, observed_at_ms: Date.now(), outcome: 'ok', error: null, data: { capabilities: { schema_version: 1, product: 'agent-run', read_methods: mode === 'unsupported' ? [] : [{ name: 'transcript_exact' }] } } };
      if (resource === 'run.transcript_exact') {
        started = true; requests.push(structuredClone(params));
        if (mode === 'delayed') await pending;
        const row = { seq: '1', at: 100, role: 'assistant', name: null, content: 'EXACT-EXECUTION-CONTENT', raw_ref: null, error: null, error_source: null, content_complete: true };
        const text = JSON.stringify(row), bytes = Buffer.byteLength(text);
        return { schema_version: 1, source: 'run', resource, observed_at_ms: Date.now(), outcome: mode === 'partial' ? 'partial' : 'ok', error: null, data: { version: 1, store_id: params.expected_store_id, selector: params.selector, cursor: '0', upper_seq: '1', offset: 0, message: { seq: '1', sha256: await sha256(text), total_bytes: bytes, start: 0, end: bytes, text, complete: true }, next_cursor: '1', next_offset: 0, snapshot_complete: true } };
      }
      return base.read(resource, params, signal);
    },
    async close() { release(); await base.close(); },
  };
  return { client, requests, started: () => started, release };
}

for (const mode of ['ok', 'partial', 'unsupported'] as const) test(`exact execution copy ${mode === 'ok' ? 'publishes only a verified snapshot' : mode === 'partial' ? 'withholds partial data' : 'refuses an unsupported source'}`, async () => {
  const setup = await createTestRenderer({ width: 160, height: 40 }), source = exactCopyClient(mode), copied: string[] = [];
  setup.renderer.copyToClipboardOSC52 = value => { copied.push(value); return true; };
  const unmount = mountHub(setup.renderer, source.client, 'live', () => {}, undefined, { pool: 'demo-pool' });
  try {
    await setup.waitForFrame(value => value.includes('[Members]') && value.includes('Example reviewer'));
    setup.mockInput.pressEnter(); await setup.waitForFrame(value => value.includes('[History]') && value.includes('Run lineage: not terminal'));
    setup.mockInput.pressKey('y');
    await setup.waitForFrame(value => value.includes(mode === 'ok' ? 'Exact execution copy requested' : 'History copy withheld'));
    if (mode === 'ok') { assert.equal(copied.length, 1); assert.match(copied[0], /EXACT-EXECUTION-CONTENT/); assert.match(copied[0], /Historical snapshot/); }
    else assert.equal(copied.length, 0);
    assert.equal(source.requests.length, mode === 'unsupported' ? 0 : 1);
    if (mode !== 'unsupported') assert.equal(source.requests[0].cursor, '0');
  } finally { source.release(); unmount(); await source.client.close(); await setup.dispose(); }
});

test('changing the selected view prevents an in-flight exact copy from reaching the clipboard', async () => {
  const setup = await createTestRenderer({ width: 160, height: 40 }), source = exactCopyClient('delayed'), copied: string[] = [];
  setup.renderer.copyToClipboardOSC52 = value => { copied.push(value); return true; };
  const unmount = mountHub(setup.renderer, source.client, 'live', () => {}, undefined, { pool: 'demo-pool' });
  try {
    await setup.waitForFrame(value => value.includes('[Members]') && value.includes('Example reviewer'));
    setup.mockInput.pressEnter(); await setup.waitForFrame(value => value.includes('[History]') && value.includes('Run lineage: not terminal'));
    setup.mockInput.pressKey('y'); await setup.waitFor(() => source.started());
    setup.mockInput.pressKey('0'); await setup.waitForFrame(value => value.includes('[Overview]'));
    source.release(); await setup.waitForFrame(value => value.includes('History export cancelled'));
    assert.equal(copied.length, 0);
  } finally { source.release(); unmount(); await source.client.close(); await setup.dispose(); }
});

test('leaving and returning to the same execution cancels its in-flight exact copy', async () => {
  const setup = await createTestRenderer({ width: 160, height: 40 }), source = exactCopyClient('delayed'), copied: string[] = [];
  setup.renderer.copyToClipboardOSC52 = value => { copied.push(value); return true; };
  const unmount = mountHub(setup.renderer, source.client, 'live', () => {}, undefined, { pool: 'demo-pool' });
  try {
    await setup.waitForFrame(value => value.includes('[Members]') && value.includes('Example reviewer'));
    setup.mockInput.pressEnter(); await setup.waitForFrame(value => value.includes('[History]') && value.includes('Run lineage: not terminal'));
    setup.mockInput.pressKey('y'); await setup.waitFor(() => source.started());
    setup.mockInput.pressKey('0'); await setup.waitForFrame(value => value.includes('[Overview]') && value.includes('History export cancelled'));
    setup.mockInput.pressEscape(); await new Promise(resolve => setTimeout(resolve, 25)); await setup.waitForFrame(value => value.includes('[History]'));
    source.release(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(copied.length, 0);
  } finally { source.release(); unmount(); await source.client.close(); await setup.dispose(); }
});

test('cancelling an in-flight exact copy leaves the clipboard unchanged', async () => {
  const setup = await createTestRenderer({ width: 160, height: 40 }), source = exactCopyClient('delayed'), copied: string[] = [];
  setup.renderer.copyToClipboardOSC52 = value => { copied.push(value); return true; };
  const unmount = mountHub(setup.renderer, source.client, 'live', () => {}, undefined, { pool: 'demo-pool' });
  try {
    await setup.waitForFrame(value => value.includes('[Members]') && value.includes('Example reviewer'));
    setup.mockInput.pressEnter(); await setup.waitForFrame(value => value.includes('[History]') && value.includes('Run lineage: not terminal'));
    setup.mockInput.pressKey('y'); await setup.waitFor(() => source.started());
    setup.mockInput.pressEscape(); await new Promise(resolve => setTimeout(resolve, 25)); await setup.waitForFrame(value => value.includes('History export cancelled'));
    source.release(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(copied.length, 0);
  } finally { source.release(); unmount(); await source.client.close(); await setup.dispose(); }
});

test('verified status opens the selected execution even when the retained latest is newer', async () => {
  const setup = await createTestRenderer({ width: 160, height: 40 }), source = statusClient('verified_selected_not_tail', true);
  const unmount = mountHub(setup.renderer, source.client, 'live', () => {}, undefined, { pool: 'demo-pool' });
  try {
    await setup.waitForFrame(value => value.includes('[Members]') && value.includes('Example reviewer'));
    setup.mockInput.pressEnter();
    const frame = await setup.waitForFrame(value => value.includes('[History]') && value.includes('Run lineage: not terminal'));
    assert.match(frame, /sequence 1/);
    assert.match(frame, /History and answer attribution unverified/);
    assert.deepEqual(source.requests[0], source.fixture.request);
    setup.mockInput.pressKey('d');
    const details = await setup.waitForFrame(value => value.includes('Selected execution status (raw): succeeded'));
    assert.match(details, /Run lineage: not terminal/);
    assert.match(details, /Cleanup: pending · lineage snapshot/);
    assert.match(details, /Run store fence: matched/);
  } finally { unmount(); await source.client.close(); await setup.dispose(); }
});

test('the selected Pool member shows status and cleanup before opening a session', async () => {
  const setup = await createTestRenderer({ width: 160, height: 40 }), source = statusClient('verified_selected_not_tail');
  const unmount = mountHub(setup.renderer, source.client, 'live', () => {}, undefined, { pool: 'demo-pool' });
  try {
    const frame = await setup.waitForFrame(value => value.includes('[Members]') && value.includes('Run lineage: not terminal') && value.includes('Cleanup: pending'));
    assert.doesNotMatch(frame, /\[History\]/);
    assert.deepEqual(source.requests[0], source.fixture.request);
  } finally { unmount(); await source.client.close(); await setup.dispose(); }
});

test('a late roster status cannot be shown for a changed member binding', async () => {
  const setup = await createTestRenderer({ width: 160, height: 40 }), demo = createDemoClient();
  let changed = false, started = false, release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const client: ObservationClient = {
    async read(resource, params = {}, signal) {
      if (resource === 'run.status' && (params.targets as { agent_id: string }[])[0].agent_id === DEMO_POOL_AGENT_ID) {
        started = true; await pending;
        return demo.read(resource, params);
      }
      const response = await demo.read(resource, params, signal);
      if (resource !== 'pool.get' || params.section !== 'members' || !response.data) return response;
      const outer = response.data as { data: { bindings: Record<string, unknown>[]; view: { members: Record<string, unknown>[] } } };
      const members = outer.data.view.members.map(member => ({ ...member, name: changed ? 'Changed reviewer' : member.name }));
      const bindings = outer.data.bindings.map(binding => changed ? { ...binding, run_id: DEMO_POOL_INDEX_ID } : { ...binding, run_execution_ref: `ex1_${'a'.repeat(64)}`, run_pin_id: 'pin_123e4567e89b42d3a456426614174000', run_store_id: `store_${'1'.repeat(32)}` });
      return { ...response, data: { ...outer, data: { ...outer.data, bindings, view: { ...outer.data.view, members } } } };
    },
    close: () => demo.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'live', () => {}, undefined, { pool: 'demo-pool' });
  try {
    await setup.waitForFrame(value => value.includes('[Members]') && value.includes('Example reviewer'));
    await setup.waitFor(() => started);
    changed = true; setup.mockInput.pressKey('r');
    await setup.waitForFrame(value => value.includes('Changed reviewer') && value.includes('Run lineage: unknown'));
    release(); await new Promise(resolve => setTimeout(resolve, 0));
    const frame = await setup.waitForFrame(value => value.includes('Changed reviewer') && value.includes('Run lineage: unknown'));
    assert.doesNotMatch(frame, /Run lineage: not terminal/);
  } finally { release(); unmount(); await client.close(); await setup.dispose(); }
});

test('a slow roster status is not duplicated by polling and is cancelled on exit', async context => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const setup = await createTestRenderer({ width: 120, height: 40 }), demo = createDemoClient();
  let calls = 0, cancelled = false;
  const client: ObservationClient = {
    async read(resource, params, signal) {
      if (resource === 'run.status') {
        calls++;
        await new Promise<void>(resolve => { const abort = () => { cancelled = true; resolve(); }; if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true }); });
      }
      return demo.read(resource, params, signal);
    },
    close: () => demo.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'live', () => {}, undefined, { pool: 'demo-pool' });
  try {
    await setup.waitForFrame(value => value.includes('[Members]') && value.includes('Example reviewer'));
    await setup.waitFor(() => calls === 1);
    context.mock.timers.tick(9000); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
    setup.mockInput.pressKey('0');
    await setup.waitFor(() => cancelled);
  } finally { unmount(); await client.close(); await setup.dispose(); context.mock.timers.reset(); }
});

for (const mode of ['connect_error', 'source_error'] as const) test(`roster status handles ${mode} without claiming a fresh proof`, async () => {
  const setup = await createTestRenderer({ width: 160, height: 40 }), source = statusClient('verified_selected_not_tail');
  const unmount = mountHub(setup.renderer, source.client, 'live', () => {}, undefined, { pool: 'demo-pool' });
  try {
    await setup.waitForFrame(value => value.includes('[Members]') && value.includes('Run lineage: not terminal'));
    source.setMode(mode); setup.mockInput.pressKey('r');
    const frame = await setup.waitForFrame(value => mode === 'connect_error' ? value.includes('STALE · Run lineage: not terminal') : value.includes('Cleanup: unknown · proof not verified'));
    if (mode === 'source_error') assert.doesNotMatch(frame, /Run lineage: not terminal/);
  } finally { unmount(); await source.client.close(); await setup.dispose(); }
});

test('pending restart stays nonterminal even when the selected row says succeeded', async () => {
  const setup = await createTestRenderer({ width: 160, height: 40 }), source = statusClient('restart_pending_raw_terminal');
  const unmount = mountHub(setup.renderer, source.client, 'live', () => {}, undefined, { pool: 'demo-pool' });
  try {
    await setup.waitForFrame(value => value.includes('[Members]') && value.includes('Example reviewer'));
    setup.mockInput.pressEnter();
    const frame = await setup.waitForFrame(value => value.includes('[History]') && value.includes('Run lineage: restart pending'));
    assert.doesNotMatch(frame, /Run lineage: succeeded/);
    setup.mockInput.pressKey('d');
    const details = await setup.waitForFrame(value => value.includes('Selected execution status (raw): succeeded'));
    assert.match(details, /Selected execution answer available \(raw\): true/);
    assert.match(details, /Run store fence: unknown/);
  } finally { unmount(); await source.client.close(); await setup.dispose(); }
});

test('a mismatched status cannot open the bound execution', async () => {
  const setup = await createTestRenderer({ width: 120, height: 40 }), source = statusClient('mismatch');
  const unmount = mountHub(setup.renderer, source.client, 'live', () => {}, undefined, { pool: 'demo-pool' });
  try {
    await setup.waitForFrame(value => value.includes('[Members]') && value.includes('Example reviewer'));
    setup.mockInput.pressEnter();
    const frame = await setup.waitForFrame(value => value.includes('Bound execution is unavailable or mismatch'));
    assert.match(frame, /\[Members\]/);
    assert.doesNotMatch(frame, /\[History\]/);
    assert.deepEqual(source.requests[0], source.fixture.request);
  } finally { unmount(); await source.client.close(); await setup.dispose(); }
});

test('status facts remain visible when the selected execution view is unavailable', async () => {
  const setup = await createTestRenderer({ width: 160, height: 40 }), source = statusClient('verified_selected_not_tail');
  source.setMode('no_view');
  const unmount = mountHub(setup.renderer, source.client, 'live', () => {}, undefined, { pool: 'demo-pool' });
  try {
    await setup.waitForFrame(value => value.includes('[Members]') && value.includes('Run lineage: not terminal'));
    setup.mockInput.pressEnter();
    const frame = await setup.waitForFrame(value => value.includes('selected execution view unavailable'));
    assert.match(frame, /\[Members\]/);
    assert.doesNotMatch(frame, /\[History\]/);
  } finally { unmount(); await source.client.close(); await setup.dispose(); }
});

test('a retained execution alias opens only its correlated canonical view', async () => {
  const alias = 'ag-20261107-002455-aaaaaaaaaa';
  const source = statusClient('verified_selected_not_tail', false, fixture => {
    fixture.request.targets[0].agent_id = alias;
    object(object((fixture.result.items as unknown[])[0]).selector).agent_id = alias;
  });
  const setup = await createTestRenderer({ width: 160, height: 40 });
  const unmount = mountHub(setup.renderer, source.client, 'live', () => {}, undefined, { pool: 'demo-pool' });
  try {
    await setup.waitForFrame(value => value.includes('[Members]') && value.includes('Example reviewer'));
    setup.mockInput.pressEnter();
    const frame = await setup.waitForFrame(value => value.includes('[History]') && value.includes('Run lineage: not terminal'));
    assert.match(frame, /ag-20261107-002455-e0caf0d956 · sequence 1/);
    assert.equal((source.requests[0].targets as { agent_id: string }[])[0].agent_id, alias);
  } finally { unmount(); await source.client.close(); await setup.dispose(); }
});

test('a status source error does not fall back to a weaker inventory lookup', async () => {
  const setup = await createTestRenderer({ width: 120, height: 40 }), source = statusClient('verified_selected_not_tail');
  source.setMode('source_error');
  const unmount = mountHub(setup.renderer, source.client, 'live', () => {}, undefined, { pool: 'demo-pool' });
  try {
    await setup.waitForFrame(value => value.includes('[Members]') && value.includes('Example reviewer'));
    setup.mockInput.pressEnter();
    await setup.waitForFrame(value => value.includes('Bound Run execution is unavailable'));
    assert.equal(source.laterInventory(), 0);
  } finally { unmount(); await source.client.close(); await setup.dispose(); }
});

for (const mode of ['partial', 'ok_error'] as const) test(`${mode} status cannot claim confirmed cleanup or open a session`, async () => {
  const source = statusClient('verified_selected_not_tail', false, fixture => {
    const item = object((fixture.result.items as unknown[])[0]);
    object(item.retained_latest).raw_status = 'succeeded';
    item.lineage_terminal = true; item.terminal_outcome = 'succeeded'; item.success_commit = 'recorded'; object(item.cleanup).state = 'confirmed';
  });
  source.setMode(mode);
  const setup = await createTestRenderer({ width: 160, height: 40 });
  const unmount = mountHub(setup.renderer, source.client, 'live', () => {}, undefined, { pool: 'demo-pool' });
  try {
    await setup.waitFor(() => source.requests.length > 0);
    const roster = await setup.waitForFrame(value => value.includes('[Members]') && value.includes('Cleanup: unknown'));
    assert.doesNotMatch(roster, /Cleanup: confirmed/);
    setup.mockInput.pressEnter();
    const frame = await setup.waitForFrame(value => value.includes('Bound Run execution is unavailable'));
    assert.doesNotMatch(frame, /\[History\]/);
  } finally { unmount(); await source.client.close(); await setup.dispose(); }
});

for (const mode of ['mismatch', 'missing', 'unknown', 'source_error', 'partial', 'ok_error'] as const) test(`a later ${mode} withdraws the old bound session`, async () => {
  const setup = await createTestRenderer({ width: 160, height: 40 }), source = statusClient('verified_selected_not_tail');
  const unmount = mountHub(setup.renderer, source.client, 'live', () => {}, undefined, { pool: 'demo-pool' });
  try {
    await setup.waitForFrame(value => value.includes('[Members]') && value.includes('Example reviewer'));
    setup.mockInput.pressEnter();
    await setup.waitForFrame(value => value.includes('[History]') && value.includes('Run lineage: not terminal'));
    source.setMode(mode); setup.mockInput.pressKey('r');
    const frame = await setup.waitForFrame(value => value.includes('its result is withheld'));
    assert.match(frame, new RegExp(`Bound execution 1: ${['source_error', 'partial', 'ok_error'].includes(mode) ? 'unavailable' : mode}`));
    assert.doesNotMatch(frame, /Inspect the saved execution history/);
  } finally { unmount(); await source.client.close(); await setup.dispose(); }
});

test('a transient connection failure labels the last bound observation stale', async () => {
  const setup = await createTestRenderer({ width: 160, height: 40 }), source = statusClient('verified_selected_not_tail');
  const unmount = mountHub(setup.renderer, source.client, 'live', () => {}, undefined, { pool: 'demo-pool' });
  try {
    await setup.waitForFrame(value => value.includes('[Members]') && value.includes('Example reviewer'));
    setup.mockInput.pressEnter();
    await setup.waitForFrame(value => value.includes('[History]') && value.includes('Run lineage: not terminal'));
    source.setMode('connect_error'); setup.mockInput.pressKey('r');
    const frame = await setup.waitForFrame(value => value.includes('STALE · Pool snapshot · History and answer attribution unverified'));
    assert.match(frame, /STALE/);
  } finally { unmount(); await source.client.close(); await setup.dispose(); }
});

test('a stale proof cannot override a newer conflicting inventory execution', async () => {
  const setup = await createTestRenderer({ width: 160, height: 40 }), source = statusClient('verified_selected_not_tail', true);
  const unmount = mountHub(setup.renderer, source.client, 'live', () => {}, undefined, { pool: 'demo-pool' });
  try {
    await setup.waitForFrame(value => value.includes('[Members]') && value.includes('Example reviewer'));
    setup.mockInput.pressEnter();
    await setup.waitForFrame(value => value.includes('[History]') && value.includes('Run lineage: not terminal'));
    source.setMode('connect_error'); setup.mockInput.pressKey('r');
    const frame = await setup.waitForFrame(value => value.includes('its result is withheld'));
    assert.doesNotMatch(frame, /Inspect the saved execution history/);
  } finally { unmount(); await source.client.close(); await setup.dispose(); }
});

test('forward navigation marks old proof stale until Run revalidation completes', async () => {
  const setup = await createTestRenderer({ width: 160, height: 40 }), source = statusClient('verified_selected_not_tail');
  let hold = false, waiting = false, release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const client: ObservationClient = {
    async read(resource, params, signal) {
      if (resource === 'run.status' && hold) { waiting = true; await pending; }
      return source.client.read(resource, params, signal);
    },
    close: () => source.client.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'live', () => {}, undefined, { pool: 'demo-pool' });
  try {
    await setup.waitForFrame(value => value.includes('[Members]') && value.includes('Run lineage: not terminal'));
    setup.mockInput.pressEnter();
    await setup.waitForFrame(value => value.includes('[History]') && value.includes('ref matched'));
    setup.mockInput.pressEscape(); await new Promise(resolve => setTimeout(resolve, 25));
    await setup.waitForFrame(value => value.includes('[Members]') && value.includes('Run lineage: not terminal'));
    hold = true; setup.mockInput.pressKey('F');
    await setup.waitFor(() => waiting);
    const pendingFrame = await setup.waitForFrame(value => value.includes('[History]') && value.includes('STALE'));
    assert.match(pendingFrame, /STALE/);
    source.setMode('mismatch'); release();
    const withheld = await setup.waitForFrame(value => value.includes('Bound execution 1: mismatch'));
    assert.doesNotMatch(withheld, /Inspect the saved execution history/);
  } finally { release(); unmount(); await client.close(); await setup.dispose(); }
});

for (const scenario of ['changed-ref', 'missing-ref', 'no-store'] as const) test(`unverified history is reloaded when the selected ${scenario} cannot fence its cache`, async () => {
  const source = statusClient('unverified', false, fixture => {
    if (scenario === 'missing-ref') { withoutPinFence(fixture); object(object((fixture.result.items as unknown[])[0]).selected).execution_ref = null; }
    if (scenario === 'no-store') { delete fixture.request.expected_store_id; const item = object((fixture.result.items as unknown[])[0]); object(item.selected).execution_ref = null; item.coverage = 'unknown'; item.restart_resume = 'unknown'; }
  });
  source.setHistory('OBSERVATION-A');
  const setup = await createTestRenderer({ width: 160, height: 40 });
  const unmount = mountHub(setup.renderer, source.client, 'live', () => {}, undefined, { pool: 'demo-pool' });
  try {
    await setup.waitForFrame(value => value.includes('[Members]') && value.includes('Example reviewer'));
    setup.mockInput.pressEnter();
    await setup.waitForFrame(value => value.includes('OBSERVATION-A'));
    source.setHistory('OBSERVATION-B');
    if (scenario === 'changed-ref') source.setMode('ref_change');
    setup.mockInput.pressKey('r');
    const frame = await setup.waitForFrame(value => value.includes('OBSERVATION-B'));
    assert.doesNotMatch(frame, /OBSERVATION-A/);
    assert.match(frame, /History and answer attribution unverified/);
  } finally { unmount(); await source.client.close(); await setup.dispose(); }
});

test('a fresh unfenced lineage snapshot preserves the reader position without reusing old blocks', async context => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const source = statusClient('unverified', false, fixture => { withoutPinFence(fixture); object(object((fixture.result.items as unknown[])[0]).selected).execution_ref = null; });
  source.setHistory(Array.from({ length: 80 }, (_, index) => `LINE-${String(index).padStart(2, '0')}`).join('\n'));
  const setup = await createTestRenderer({ width: 120, height: 24 });
  const unmount = mountHub(setup.renderer, source.client, 'live', () => {}, undefined, { pool: 'demo-pool' });
  try {
    await setup.waitForFrame(value => value.includes('[Members]') && value.includes('Example reviewer'));
    setup.mockInput.pressEnter();
    await setup.waitForFrame(value => value.includes('LINE-00'));
    for (let index = 0; index < 20; index++) setup.mockInput.pressArrow('down');
    const before = await setup.waitForFrame(value => value.includes('LINE-30'));
    const firstBefore = before.match(/LINE-\d{2}/)?.[0];
    assert.ok(firstBefore && firstBefore !== 'LINE-00');
    const count = source.requests.length;
    context.mock.timers.tick(3000); await new Promise<void>(resolve => setImmediate(resolve));
    await setup.waitFor(() => source.requests.length > count);
    await new Promise<void>(resolve => setImmediate(resolve)); await setup.renderOnce();
    const after = setup.captureCharFrame();
    assert.equal(after.match(/LINE-\d{2}/)?.[0], firstBefore);
  } finally { unmount(); await source.client.close(); await setup.dispose(); context.mock.timers.reset(); }
});

test('an active fenced pin preserves the current lineage cache, then release invalidates it', async context => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const source = statusClient('unverified', false, fixture => { const item = object((fixture.result.items as unknown[])[0]); object(item.selected).execution_ref = null; item.coverage = 'unknown'; item.restart_resume = 'unknown'; });
  source.setHistory(Array.from({ length: 80 }, (_, index) => `LINE-${String(index).padStart(2, '0')}`).join('\n'));
  const setup = await createTestRenderer({ width: 120, height: 24 });
  const unmount = mountHub(setup.renderer, source.client, 'live', () => {}, undefined, { pool: 'demo-pool' });
  try {
    await setup.waitForFrame(value => value.includes('[Members]') && value.includes('Example reviewer'));
    setup.mockInput.pressEnter(); await setup.waitForFrame(value => value.includes('LINE-00'));
    for (let index = 0; index < 20; index++) setup.mockInput.pressArrow('down');
    const before = await setup.waitForFrame(value => value.includes('LINE-30'));
    const firstBefore = before.match(/LINE-\d{2}/)?.[0];
    const headReads = () => source.transcripts.filter(params => params.cursor === 0).length;
    const beforeHeads = headReads(), count = source.requests.length;
    context.mock.timers.tick(3000); await new Promise<void>(resolve => setImmediate(resolve));
    await setup.waitFor(() => source.requests.length > count);
    await new Promise<void>(resolve => setImmediate(resolve)); await setup.renderOnce();
    assert.equal(setup.captureCharFrame().match(/LINE-\d{2}/)?.[0], firstBefore);
    assert.equal(headReads(), beforeHeads, 'the protected prefix is not reloaded on every status poll');
    source.setMode('pin_released'); source.setHistory('AFTER-RELEASE');
    context.mock.timers.tick(3000); await new Promise<void>(resolve => setImmediate(resolve));
    const frame = await setup.waitForFrame(value => value.includes('AFTER-RELEASE'));
    assert.doesNotMatch(frame, /LINE-\d{2}/);
  } finally { unmount(); await source.client.close(); await setup.dispose(); context.mock.timers.reset(); }
});

test('an unfenced refresh clamps position to fresh, shorter history', async context => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const source = statusClient('unverified', false, fixture => { withoutPinFence(fixture); object(object((fixture.result.items as unknown[])[0]).selected).execution_ref = null; });
  source.setHistory(Array.from({ length: 80 }, (_, index) => `OLD-${String(index).padStart(2, '0')}`).join('\n'));
  const setup = await createTestRenderer({ width: 120, height: 24 });
  const unmount = mountHub(setup.renderer, source.client, 'live', () => {}, undefined, { pool: 'demo-pool' });
  try {
    await setup.waitForFrame(value => value.includes('[Members]') && value.includes('Example reviewer'));
    setup.mockInput.pressEnter(); await setup.waitForFrame(value => value.includes('OLD-00'));
    for (let index = 0; index < 20; index++) setup.mockInput.pressArrow('down');
    await setup.waitForFrame(value => value.includes('OLD-30'));
    source.setHistory('FRESH-00\nFRESH-01');
    context.mock.timers.tick(3000); await new Promise<void>(resolve => setImmediate(resolve));
    const frame = await setup.waitForFrame(value => value.includes('FRESH-00'));
    assert.doesNotMatch(frame, /OLD-\d{2}/);
  } finally { unmount(); await source.client.close(); await setup.dispose(); context.mock.timers.reset(); }
});

test('an unfenced refresh restores position beyond the first transcript page', async context => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const source = statusClient('unverified', false, fixture => { withoutPinFence(fixture); object(object((fixture.result.items as unknown[])[0]).selected).execution_ref = null; });
  const setup = await createTestRenderer({ width: 160, height: 24 });
  const client: ObservationClient = {
    async read(resource, params = {}, signal) {
      if (resource !== 'run.transcript') return source.client.read(resource, params, signal);
      const cursor = typeof params.cursor === 'number' ? params.cursor : 0, tail = typeof params.tail_blocks === 'number';
      const rows = Array.from({ length: 120 }, (_, index) => ({ seq: index + 1, role: 'assistant', content: `ROW-${String(index + 1).padStart(3, '0')}`, at: 100 + index, content_complete: true }));
      const selected = tail ? rows.slice(-40) : rows.filter(row => row.seq > cursor).slice(0, 40);
      const last = selected.at(-1)?.seq ?? cursor, complete = !tail && last === rows.length;
      return { schema_version: 1, source: 'run', resource, observed_at_ms: Date.now(), outcome: complete ? 'ok' : 'partial', error: null, data: { agent_id: params.agent_id, view: 'blocks', cursor: tail ? 0 : cursor, direction: tail ? 'backward' : 'forward', messages: selected, complete, previous_cursor: tail ? selected[0].seq : null, next_cursor: !tail && !complete ? last : null, resume_cursor: last } };
    },
    close: () => source.client.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'live', () => {}, undefined, { pool: 'demo-pool' });
  try {
    await setup.waitForFrame(value => value.includes('[Members]') && value.includes('Example reviewer'));
    setup.mockInput.pressEnter(); await setup.waitForFrame(value => value.includes('ROW-001'));
    for (let index = 0; index < 165; index++) { setup.mockInput.pressArrow('down'); if (index % 8 === 7) { await new Promise<void>(resolve => setImmediate(resolve)); await setup.renderOnce(); } }
    await setup.renderOnce();
    const before = setup.captureCharFrame();
    const firstBefore = before.match(/ROW-\d{3}/)?.[0];
    assert.ok(firstBefore && Number(firstBefore.slice(4)) > 40);
    const count = source.requests.length;
    context.mock.timers.tick(3000); await new Promise<void>(resolve => setImmediate(resolve));
    await setup.waitFor(() => source.requests.length > count);
    const after = await setup.waitForFrame(value => value.includes(firstBefore), { maxPasses: 200 });
    assert.equal(after.match(/ROW-\d{3}/)?.[0], firstBefore);
  } finally { unmount(); await client.close(); await setup.dispose(); context.mock.timers.reset(); }
});

test('a stalled position restore is cancelled so status polling resumes', async context => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const source = statusClient('unverified', false, fixture => { withoutPinFence(fixture); object(object((fixture.result.items as unknown[])[0]).selected).execution_ref = null; });
  const setup = await createTestRenderer({ width: 160, height: 24 });
  let hold = false, held = false, aborted = false, clock = performance.now();
  const clockMock = context.mock.method(performance, 'now', () => clock);
  const client: ObservationClient = {
    async read(resource, params = {}, signal) {
      if (resource !== 'run.transcript') return source.client.read(resource, params, signal);
      const cursor = typeof params.cursor === 'number' ? params.cursor : 0, tail = typeof params.tail_blocks === 'number';
      if (hold && !tail && cursor > 0) {
        held = true;
        await new Promise<void>(resolve => { const cancel = () => { aborted = true; resolve(); }; if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, { once: true }); });
        return { schema_version: 1, source: 'run', resource, observed_at_ms: Date.now(), outcome: 'unavailable', data: null, error: { code: 'cancelled', message: 'Cancelled.' } };
      }
      const rows = Array.from({ length: 120 }, (_, index) => ({ seq: index + 1, role: 'assistant', content: `ROW-${String(index + 1).padStart(3, '0')}`, at: 100 + index, content_complete: true }));
      const selected = tail ? rows.slice(-40) : rows.filter(row => row.seq > cursor).slice(0, 40);
      const last = selected.at(-1)?.seq ?? cursor, complete = !tail && last === rows.length;
      return { schema_version: 1, source: 'run', resource, observed_at_ms: Date.now(), outcome: complete ? 'ok' : 'partial', error: null, data: { agent_id: params.agent_id, view: 'blocks', cursor: tail ? 0 : cursor, direction: tail ? 'backward' : 'forward', messages: selected, complete, previous_cursor: tail ? selected[0].seq : null, next_cursor: !tail && !complete ? last : null, resume_cursor: last } };
    },
    close: () => source.client.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'live', () => {}, undefined, { pool: 'demo-pool' });
  try {
    await setup.waitForFrame(value => value.includes('[Members]') && value.includes('Example reviewer'));
    setup.mockInput.pressEnter(); await setup.waitForFrame(value => value.includes('ROW-001'));
    for (let index = 0; index < 165; index++) { setup.mockInput.pressArrow('down'); if (index % 8 === 7) { await new Promise<void>(resolve => setImmediate(resolve)); await setup.renderOnce(); } }
    await setup.renderOnce(); assert.match(setup.captureCharFrame(), /ROW-05\d/);
    hold = true; clock += 3000; context.mock.timers.tick(3000); await new Promise<void>(resolve => setImmediate(resolve));
    await setup.waitFor(() => held);
    const count = source.requests.length;
    clock += 6000; context.mock.timers.tick(3000); await new Promise<void>(resolve => setImmediate(resolve));
    await setup.waitFor(() => aborted && source.requests.length > count);
  } finally { unmount(); await client.close(); await setup.dispose(); clockMock.mock.restore(); context.mock.timers.reset(); }
});

test('an unfenced refresh preserves follow mode for the current lineage tail', async context => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const source = statusClient('unverified', false, fixture => { withoutPinFence(fixture); object(object((fixture.result.items as unknown[])[0]).selected).execution_ref = null; });
  source.setHistory(Array.from({ length: 80 }, (_, index) => `LINE-${String(index).padStart(2, '0')}`).join('\n'));
  const setup = await createTestRenderer({ width: 120, height: 24 });
  const unmount = mountHub(setup.renderer, source.client, 'live', () => {}, undefined, { pool: 'demo-pool' });
  try {
    await setup.waitForFrame(value => value.includes('[Members]') && value.includes('Example reviewer'));
    setup.mockInput.pressEnter(); await setup.waitForFrame(value => value.includes('LINE-00'));
    setup.mockInput.pressKey('G');
    await setup.waitForFrame(value => value.includes('LINE-79') && value.includes('Following'));
    source.setHistory(Array.from({ length: 80 }, (_, index) => `LINE-${String(index).padStart(2, '0')}`).join('\n') + '\nNEW-TAIL');
    context.mock.timers.tick(3000); await new Promise<void>(resolve => setImmediate(resolve));
    const frame = await setup.waitForFrame(value => value.includes('NEW-TAIL') && value.includes('Following'));
    assert.doesNotMatch(frame, /LINE-00/);
  } finally { unmount(); await source.client.close(); await setup.dispose(); context.mock.timers.reset(); }
});

test('an in-flight answer is cancelled when the observed execution reference changes', async context => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const setup = await createTestRenderer({ width: 160, height: 40 }), source = statusClient('unverified');
  let started = false, cancelled = false;
  const client: ObservationClient = {
    async read(resource, params, signal) {
      if (resource === 'run.answer') {
        started = true;
        await new Promise<void>(resolve => { const abort = () => { cancelled = true; resolve(); }; if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true }); });
        return { schema_version: 1, source: 'run', resource, observed_at_ms: Date.now(), outcome: 'unavailable', data: null, error: { code: 'cancelled', message: 'Cancelled.' } };
      }
      return source.client.read(resource, params, signal);
    },
    close: () => source.client.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'live', () => {}, undefined, { pool: 'demo-pool' });
  try {
    await setup.waitForFrame(value => value.includes('[Members]') && value.includes('Example reviewer'));
    setup.mockInput.pressEnter();
    await setup.waitForFrame(value => value.includes('[History]') && value.includes('History and answer attribution unverified'));
    setup.mockInput.pressKey('a'); await setup.waitFor(() => started);
    source.setMode('ref_change'); context.mock.timers.tick(3000);
    await new Promise<void>(resolve => setImmediate(resolve));
    await setup.waitFor(() => cancelled);
  } finally { unmount(); await client.close(); await setup.dispose(); context.mock.timers.reset(); }
});

test('a roster that becomes stale during lookup cannot open its previous binding', async () => {
  const setup = await createTestRenderer({ width: 120, height: 40 }), demo = createDemoClient();
  let failRoster = false, started = false, release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const client: ObservationClient = {
    async read(resource, params, signal) {
      if (resource === 'run.status') { started = true; await pending; }
      if (resource === 'pool.get' && params?.section === 'members' && failRoster) return { schema_version: 1, source: 'pool', resource, observed_at_ms: Date.now(), outcome: 'unavailable', data: null, error: { code: 'offline', message: 'Source unavailable.' } };
      return demo.read(resource, params, signal);
    },
    close: () => demo.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'live', () => {}, undefined, { pool: 'demo-pool' });
  try {
    await setup.waitForFrame(value => value.includes('[Members]') && value.includes('Example reviewer'));
    setup.mockInput.pressEnter(); await setup.waitFor(() => started);
    failRoster = true; setup.mockInput.pressKey('r');
    await setup.waitForFrame(value => value.includes('last good'));
    release();
    const frame = await setup.waitForFrame(value => value.includes('Pool binding is stale'));
    assert.match(frame, /\[Members\]/);
    assert.doesNotMatch(frame, /\[History\]/);
  } finally { release(); unmount(); await client.close(); await setup.dispose(); }
});

test('back and forward keep same-ID executions from different Run stores separate', async () => {
  const setup = await createTestRenderer({ width: 160, height: 40 }), demo = createDemoClient();
  const fixture = structuredClone(fixtures.cases.verified_selected_not_tail), first = fixture.request.targets[0];
  const storeA = fixture.request.expected_store_id!, storeB = `store_${'2'.repeat(32)}`;
  const refB = `ex1_${'b'.repeat(64)}`, pinB = 'pin_123e4567e89b42d3a456426614174001';
  let observedStore = storeA;
  const client: ObservationClient = {
    async read(resource, params = {}, signal) {
      if (resource === 'run.status') {
        const output = structuredClone(fixture.result), item = object((output.items as unknown[])[0]);
        observedStore = String(params.expected_store_id);
        const selector = object((params.targets as unknown[])[0]);
        output.store_id = observedStore; item.selector = selector; item.pin_id = selector.pin_id;
        object(item.selected).execution_ref = selector.execution_ref;
        return { schema_version: 1, source: 'run', resource, observed_at_ms: Date.now(), outcome: 'ok', data: output, error: null };
      }
      if (resource === 'run.transcript') {
        const response = await demo.read(resource, { ...params, agent_id: 'demo-inspect' }, signal);
        return { ...response, data: { ...(response.data as Record<string, unknown>), agent_id: first.agent_id, messages: [{ seq: 1, role: 'assistant', content: observedStore === storeA ? 'HISTORY-A' : 'HISTORY-B', at: 100, content_complete: true }], complete: true, previous_cursor: null, next_cursor: null, resume_cursor: 1 } };
      }
      const response = await demo.read(resource, params, signal);
      if (resource !== 'pool.get' || params.section !== 'members' || !response.data) return response;
      const outer = response.data as { data: { bindings: Record<string, unknown>[]; view: { members: Record<string, unknown>[] } } };
      const baseMember = outer.data.view.members[0], baseBinding = outer.data.bindings[0];
      const members = [{ ...baseMember, member_id: 'member-a', name: 'Alpha' }, { ...baseMember, member_id: 'member-b', name: 'Beta' }];
      const bindings = [
        { ...baseBinding, member: members[0], run_id: first.agent_id, run_sequence: first.sequence, run_execution_ref: first.execution_ref, run_pin_id: first.pin_id, run_store_id: storeA },
        { ...baseBinding, member: members[1], run_id: first.agent_id, run_sequence: first.sequence, run_execution_ref: refB, run_pin_id: pinB, run_store_id: storeB },
      ];
      return { ...response, data: { ...outer, data: { ...outer.data, bindings, returned: 2, cursor: '2', view: { ...outer.data.view, members, next_after: 2 } } } };
    },
    close: () => demo.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'live', () => {}, undefined, { pool: 'demo-pool' });
  try {
    await setup.waitForFrame(value => value.includes('[Members]') && value.includes('Alpha') && value.includes('Beta'));
    setup.mockInput.pressEnter();
    await setup.waitForFrame(value => value.includes('HISTORY-A'));
    setup.mockInput.pressEscape(); await new Promise(resolve => setTimeout(resolve, 25));
    await setup.waitForFrame(value => value.includes('[Members]') && value.includes('Beta'));
    setup.mockInput.pressArrow('down'); setup.mockInput.pressEnter();
    const second = await setup.waitForFrame(value => value.includes('HISTORY-B'));
    assert.doesNotMatch(second, /HISTORY-A/);
    setup.mockInput.pressEscape(); await new Promise(resolve => setTimeout(resolve, 25));
    await setup.waitForFrame(value => value.includes('[Members]') && value.includes('Beta'));
    setup.mockInput.pressKey('F');
    const forward = await setup.waitForFrame(value => value.includes('HISTORY-B'));
    assert.doesNotMatch(forward, /HISTORY-A/);
  } finally { unmount(); await client.close(); await setup.dispose(); }
});
