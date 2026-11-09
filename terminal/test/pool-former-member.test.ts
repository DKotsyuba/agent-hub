/** Checks archived Pool-member navigation using isolated synthetic read responses. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createTestRenderer } from '@opentui/core/testing';
import { object } from '../../src/live/protocol.ts';
import { createDemoClient, DEMO_POOL_AGENT_ID } from '../src/demo.ts';
import { mountHub } from '../src/hub.ts';
import type { ObservationClient, ReadResponse } from '../src/api.ts';
import type { RunStatusRequest } from '../src/run-status.ts';

interface Fixture { request: RunStatusRequest; result: Record<string, unknown> }
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/run-status-v1.json', import.meta.url), 'utf8')) as { cases: Record<string, Fixture> };
type Fault = 'none' | 'legacy' | 'legacy_partial' | 'legacy_incomplete' | 'missing' | 'pool' | 'member' | 'revision' | 'current' | 'partial' | 'stale' | 'run_mismatch' | 'changed_binding';
type Stage = 'binding' | 'run' | 'recheck';

/** Wraps the established demo transports with exact archived-binding and status snapshots. */
function formerClient(fault: Fault = 'none', heldStage?: Stage) {
  const demo = createDemoClient(), fixture = structuredClone(fixtures.cases.verified_selected_not_tail), selector = fixture.request.targets[0];
  const requests: { resource: string; params: Record<string, unknown> }[] = [];
  let bindingCalls = 0, held = false, cancelled = false, revision = 7, accepted = true, deliveryUnavailable = false;
  let delayDeliveries = false, deliveryHeld = false, delayCurrent = false, currentHeld = false, currentAborted = false, currentCalls = 0;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let releaseDelivery!: () => void, releaseCurrent!: () => void;
  const pendingDelivery = new Promise<void>(resolve => { releaseDelivery = resolve; });
  const pendingCurrent = new Promise<void>(resolve => { releaseCurrent = resolve; });
  /** Holds a response even after abort to exercise the caller's late-response guard. */
  async function hold(stage: Stage, signal?: AbortSignal): Promise<void> {
    if (stage !== heldStage) return;
    held = true;
    signal?.addEventListener('abort', () => { cancelled = true; }, { once: true });
    await pending;
  }
  const client: ObservationClient = {
    async read(resource, params = {}, signal) {
      requests.push({ resource, params: structuredClone(params) });
      if (resource === 'run.transcript' && bindingCalls > 0) {
        const response = await demo.read(resource, { ...params, agent_id: 'demo-inspect' }, signal);
        return { ...response, data: { ...object(response.data), agent_id: params.agent_id } };
      }
      if (resource === 'run.status' && bindingCalls > 0) {
        if (object((params.targets as unknown[])[0]).agent_id === DEMO_POOL_AGENT_ID) {
          currentCalls++;
          if (delayCurrent) { currentHeld = true; signal?.addEventListener('abort', () => { currentAborted = true; }, { once: true }); await pendingCurrent; }
          return demo.read(resource, params, signal);
        }
        await hold('run', signal);
        if (fault.startsWith('legacy')) return { schema_version: 1, source: 'run', resource, observed_at_ms: Date.now(), outcome: 'incompatible', data: null, error: { code: 'run_method_unavailable', message: 'Unsupported status.' } };
        const result = structuredClone(fixture.result);
        if (fault === 'run_mismatch') {
          const item = object((result.items as unknown[])[0]);
          Object.assign(item, { match: 'mismatch', selected: null, retained_latest: null, coverage: 'unknown', restart_resume: 'unknown', lineage_terminal: null, terminal_outcome: null, success_commit: 'unknown', cleanup: { scope: 'lineage', state: 'unknown' } });
          delete result.view;
        }
        return { schema_version: 1, source: 'run', resource, observed_at_ms: Date.now(), outcome: 'ok', error: null, data: result };
      }
      if (resource === 'pool.get' && params.section === 'binding') {
        bindingCalls++;
        await hold(bindingCalls === 1 ? 'binding' : 'recheck', signal);
        const base: ReadResponse = { schema_version: 1, source: 'pool', resource, observed_at_ms: Date.now(), outcome: 'ok', data: null, error: null };
        if (fault === 'missing' || fault === 'stale' && bindingCalls > 1) return { ...base, outcome: 'unavailable', error: { code: 'source_error', message: 'Read unavailable.' } };
        const response = await demo.read('pool.get', { pool_id: 'demo-pool', section: 'members', include_bindings: true });
        const data = object(object(response.data).data), view = object(data.view), member = { ...object((view.members as unknown[])[0]), member_id: fault === 'member' ? 'wrong-member' : params.member_id, state: fault === 'current' ? 'active' : 'removed' };
        const binding = { ...object((data.bindings as unknown[])[0]), pool_id: fault === 'pool' ? 'wrong-pool' : 'demo-pool', member, run_id: selector.agent_id, run_sequence: selector.sequence, run_execution_ref: fault === 'changed_binding' && bindingCalls > 1 ? `ex1_${'f'.repeat(64)}` : selector.execution_ref, run_pin_id: selector.pin_id, run_store_id: fixture.request.expected_store_id };
        return { ...base, outcome: fault === 'partial' ? 'partial' : 'ok', data: { schema_version: 1, kind: 'pool_detail', data: { ...data, section: 'binding', observed_at_unix_ms: 1_700_000_000_000 + bindingCalls * 1_000, view: { ...view, section: 'binding', pool: { ...object(view.pool), revision: fault === 'revision' ? 8 : 7 }, members: [member], next_after: 0 }, bindings: [binding], cursor: '0', returned: 1 } } };
      }
      const response = await demo.read(resource, params, signal);
      if (resource === 'pool.identity' && response.data) {
        const outer = object(response.data), identity = object(outer.data);
        return { ...response, data: { ...outer, data: { ...identity, capabilities: [...identity.capabilities as string[], 'content_pages_v1'] } } };
      }
      if (resource === 'run.agents' && fault.startsWith('legacy') && bindingCalls > 0 && response.data) {
        const page = object(response.data);
        const partial = fault === 'legacy_partial' || fault === 'legacy_incomplete';
        return { ...response, outcome: partial ? 'partial' : response.outcome, data: { ...page, ...(partial ? { complete: false, next_offset: 4, total: 5 } : {}), ...(fault === 'legacy_incomplete' ? { partial: true } : {}), items: (page.items as unknown[]).map(value => { const agent = object(value); return agent.agent_id === 'demo-inspect' ? { ...agent, agent_id: selector.agent_id, sequence: selector.sequence } : agent; }) } };
      }
      if (resource === 'pool.get' && params.section === 'deliveries' && response.data) {
        if (delayDeliveries) { deliveryHeld = true; await pendingDelivery; }
        if (deliveryUnavailable) return { ...response, outcome: 'unavailable', data: null, error: { code: 'source_error', message: 'Unavailable.' } };
        const outer = object(response.data), data = object(outer.data), view = object(data.view);
        const deliveries = [1, 2].map(index => ({ operation_id: `replacement-${index}`, member_id: `former-${index}`, operation: 'replace', state: accepted ? 'accepted' : 'unknown' }));
        return { ...response, data: { ...outer, data: { ...data, returned: 2, cursor: '2', view: { ...view, pool: { ...object(view.pool), revision }, deliveries, next_after: 2 } } } };
      }
      return response;
    },
    close: () => demo.close(),
  };
  return { client, requests, held: () => held, cancelled: () => cancelled, release, holdDeliveries: () => { delayDeliveries = true; }, deliveryHeld: () => deliveryHeld, releaseDelivery, holdCurrent: () => { delayCurrent = true; }, currentHeld: () => currentHeld, currentAborted: () => currentAborted, currentCalls: () => currentCalls, releaseCurrent, setRevision: (value: number) => { revision = value; }, removeAcceptance: () => { accepted = false; }, failDeliveries: () => { deliveryUnavailable = true; } };
}

/** Opens the existing Pool's deliveries through the actual keyboard handler. */
async function deliveryScreen(source: ReturnType<typeof formerClient>) {
  const setup = await createTestRenderer({ width: 160, height: 40 });
  const unmount = mountHub(setup.renderer, source.client, 'live', () => {}, undefined, { pool: 'demo-pool' });
  await setup.waitForFrame(value => value.includes('[Members]') && value.includes('Example reviewer'));
  setup.mockInput.pressKey('b');
  await setup.waitForFrame(value => value.includes('[Deliveries]') && value.includes('replacement-1'));
  return { ...setup, unmount };
}

for (const input of ['keyboard', 'mouse', 'legacy', 'legacy_partial'] as const) test(`an accepted replacement opens its original member through ${input} and returns to deliveries`, async () => {
  const source = formerClient(input === 'legacy' || input === 'legacy_partial' ? input : 'none'), setup = await deliveryScreen(source);
  try {
    if (input !== 'mouse') { setup.mockInput.pressArrow('down'); setup.mockInput.pressEnter(); }
    else {
      const frame = setup.captureCharFrame(), rows = frame.split('\n'), row = rows.findIndex(value => value.includes('Open original member history'));
      await setup.mockMouse.click(rows[row].indexOf('Open original') + 1, row);
    }
    const frame = await setup.waitForFrame(value => value.includes('[History]') && value.includes(input.startsWith('legacy') ? 'historical identity unverified' : 'History and answer attribution unverified'));
    assert.match(frame, /sequence 1/);
    await setup.waitForFrame(value => value.includes('Inspect the saved execution history.'));
    const bindings = source.requests.filter(value => value.params.section === 'binding');
    assert.equal(bindings.length, 2);
    assert.deepEqual(bindings.map(value => value.params), [1, 2].map(() => ({ pool_id: 'demo-pool', section: 'binding', member_id: input !== 'mouse' ? 'former-2' : 'former-1', expected_revision: 7 })));
    setup.mockInput.pressKey('y');
    await setup.waitForFrame(value => value.includes(input.startsWith('legacy') ? 'Exact execution copy requires a fresh verified' : 'Run does not advertise exact transcript export'));
    setup.mockInput.pressEscape();
    // A bare ESC waits for the input parser to distinguish it from an escape sequence.
    await new Promise(resolve => setTimeout(resolve, 25));
    await setup.waitForFrame(value => value.includes('[Deliveries]') && value.includes('replacement-1'));
  } finally { source.release(); setup.unmount(); await source.client.close(); await setup.dispose(); }
});

test('archived member details show the final binding observation time', async () => {
  const source = formerClient(), setup = await deliveryScreen(source);
  try {
    setup.mockInput.pressEnter(); await setup.waitForFrame(value => value.includes('[History]') && value.includes('History and answer attribution unverified'));
    setup.mockInput.pressKey('d');
    const expected = new Date(1_700_000_002_000).toLocaleString();
    const frame = await setup.waitForFrame(value => value.includes('Pool binding observed:') && value.includes(expected));
    assert.match(frame, /Pool binding observed:/);
  } finally { source.release(); setup.unmount(); await source.client.close(); await setup.dispose(); }
});

for (const fault of ['missing', 'pool', 'member', 'revision', 'current', 'partial', 'stale', 'run_mismatch', 'changed_binding', 'legacy_incomplete'] as const) test(`original-member navigation withholds ${fault} evidence`, async () => {
  const source = formerClient(fault), setup = await deliveryScreen(source);
  try {
    setup.mockInput.pressEnter();
    const frame = await setup.waitForFrame(value => value.includes('Original member history unavailable'));
    assert.match(frame, /\[Deliveries\]/);
    assert.doesNotMatch(frame, /\[History\]/);
    if (['missing', 'pool', 'member', 'revision', 'current', 'partial'].includes(fault)) assert.equal(source.requests.filter(value => value.resource === 'run.status' && Array.isArray(value.params.targets) && object((value.params.targets as unknown[])[0]).agent_id === fixtures.cases.verified_selected_not_tail.request.targets[0].agent_id).length, 0);
  } finally { source.release(); setup.unmount(); await source.client.close(); await setup.dispose(); }
});

for (const [stage, change] of [['binding', 'selection'], ['run', 'screen'], ['run', 'content'], ['recheck', 'revision'], ['run', 'delivery']] as const) test(`a late ${stage} response cannot survive ${change} changes`, async () => {
  const source = formerClient('none', stage), setup = await deliveryScreen(source);
  try {
    setup.mockInput.pressEnter(); await setup.waitFor(() => source.held());
    if (change === 'selection') setup.mockInput.pressArrow('down');
    if (change === 'screen') setup.mockInput.pressKey('m');
    if (change === 'content') setup.mockInput.pressKey('e');
    if (change === 'revision') { source.setRevision(8); setup.mockInput.pressKey('r'); }
    if (change === 'delivery') { source.removeAcceptance(); setup.mockInput.pressKey('r'); }
    await setup.waitFor(() => source.cancelled());
    source.release(); await new Promise<void>(resolve => setImmediate(resolve));
    const frame = await setup.waitForFrame(value => value.includes(change === 'screen' ? '[Members]' : change === 'content' ? 'Full purpose' : '[Deliveries]'));
    assert.doesNotMatch(frame, /\[History\]/);
  } finally { source.release(); setup.unmount(); await source.client.close(); await setup.dispose(); }
});

test('switching tabs by mouse cancels an archived lookup and clears its progress message', async () => {
  const source = formerClient('none', 'binding'), setup = await deliveryScreen(source);
  try {
    setup.mockInput.pressEnter(); await setup.waitFor(() => source.held());
    const rows = setup.captureCharFrame().split('\n'), row = rows.findIndex(value => value.includes('[Deliveries]'));
    await setup.mockMouse.click(rows[row].indexOf('Members') + 1, row);
    await setup.waitFor(() => source.cancelled());
    const frame = await setup.waitForFrame(value => value.includes('[Members]'));
    assert.doesNotMatch(frame, /Checking original member binding/);
  } finally { source.release(); setup.unmount(); await source.client.close(); await setup.dispose(); }
});

test('an old deliveries refresh cannot cancel a newer current-member lookup', async () => {
  const source = formerClient('none', 'binding'), setup = await deliveryScreen(source);
  try {
    setup.mockInput.pressEnter(); await setup.waitFor(() => source.held());
    source.holdDeliveries(); setup.mockInput.pressKey('r'); await setup.waitFor(() => source.deliveryHeld());
    setup.mockInput.pressKey('m'); await setup.waitForFrame(value => value.includes('[Members]') && value.includes('Example reviewer'));
    await setup.waitFor(() => source.currentCalls() > 0);
    source.holdCurrent(); setup.mockInput.pressEnter(); await setup.waitFor(() => source.currentHeld());
    source.releaseDelivery(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(source.currentAborted(), false);
    source.releaseCurrent();
    await setup.waitForFrame(value => value.includes('[History]') && value.includes('historical identity unverified'));
  } finally { source.release(); source.releaseDelivery(); source.releaseCurrent(); setup.unmount(); await source.client.close(); await setup.dispose(); }
});


for (const state of ['unaccepted', 'stale'] as const) test(`a ${state} deliveries snapshot cannot authorize archived navigation`, async () => {
  const source = formerClient(), setup = await deliveryScreen(source);
  try {
    if (state === 'unaccepted') source.removeAcceptance(); else source.failDeliveries();
    setup.mockInput.pressKey('r');
    await setup.waitForFrame(value => state === 'unaccepted' ? value.includes('Replacement not confirmed.') : value.includes('last good'));
    setup.mockInput.pressEnter();
    const frame = await setup.waitForFrame(value => value.includes('Select a fresh accepted replacement'));
    assert.doesNotMatch(frame, /\[History\]/);
    assert.equal(source.requests.filter(value => value.params.section === 'binding').length, 0);
  } finally { source.release(); setup.unmount(); await source.client.close(); await setup.dispose(); }
});

/** Serves the exact initial task and advertises it, wrapping the archived-binding fixture client. */
function withInitialTask(source: ReturnType<typeof formerClient>, calls: Record<string, unknown>[], unavailable?: string) {
  const text = `Archived task — ${'日本語'.repeat(30)}\nBOUND-TASK-END`, bytes = Buffer.from(text), digest = createHash('sha256').update(text).digest('hex');
  const client: ObservationClient = {
    async read(resource, params = {}, signal) {
      if (resource === 'run.initial_task') {
        calls.push(structuredClone(params));
        const strict = params.mode === 'strict', offset = Number(params.offset ?? 0);
        const base = { version: 1, mode: params.mode, store_id: params.expected_store_id, agent_id: params.agent_id };
        if (unavailable) return { schema_version: 1, source: 'run', resource, observed_at_ms: Date.now(), outcome: 'ok', error: null, data: { state: 'unavailable', ...base, reason: unavailable } };
        let end = Math.min(bytes.length, offset + 90);
        while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
        const data = { state: 'available', ...base, sequence: 1, execution_ref: params.execution_ref, ...(strict ? { pin_id: params.pin_id } : {}), total_bytes: bytes.length, sha256: digest, offset, end, next_offset: end < bytes.length ? end : null, text: bytes.subarray(offset, end).toString('utf8'), complete: end === bytes.length };
        return { schema_version: 1, source: 'run', resource, observed_at_ms: Date.now(), outcome: data.complete ? 'ok' : 'partial', error: null, data };
      }
      const response = await source.client.read(resource, params, signal);
      if (resource !== 'run.identity' || !response.data) return response;
      const data = object(response.data);
      return { ...response, data: { ...data, capabilities: { ...object(data.capabilities), schema_version: 1, product: 'agent-run', initial_task: { version: 1, method: 'initial_task', modes: ['strict', 'current'], max_task_bytes: 524288, max_page_bytes: 65536 } } } };
    },
    close: () => source.client.close(),
  };
  return { ...source, client };
}

for (const unavailable of [undefined, 'pin_released']) test(`a Pool-bound historical session uses strict mode and ${unavailable ? `reports ${unavailable} without text` : 'verifies the archived task'}`, async () => {
  const calls: Record<string, unknown>[] = [], source = withInitialTask(formerClient(), calls, unavailable), setup = await deliveryScreen(source);
  try {
    setup.mockInput.pressEnter();
    await setup.waitForFrame(value => value.includes('[History]') && value.includes('History and answer attribution unverified'));
    const frame = await setup.waitForFrame(value => unavailable ? value.includes(`showing retained history · ${unavailable}`) : value.includes('Initial task verified (strict)'));
    const selector = fixtures.cases.verified_selected_not_tail.request.targets[0];
    assert.ok(calls.length >= 1);
    assert.deepEqual(calls[0], { version: 1, mode: 'strict', agent_id: selector.agent_id, expected_store_id: fixtures.cases.verified_selected_not_tail.request.expected_store_id, sequence: 1, pin_id: selector.pin_id, execution_ref: selector.execution_ref, offset: 0, max_bytes: 65536 });
    if (!unavailable) assert.ok(calls.length >= 3 && calls.slice(1).every(call => call.expected_sha256 && call.expected_total_bytes));
    setup.mockInput.pressKey('d');
    const details = await setup.waitForFrame(value => value.includes('Pool binding observed:'));
    if (unavailable) assert.doesNotMatch(details, /BOUND-TASK-END|Archived task/);
    else { assert.match(frame, /Initial task verified \(strict\)/); assert.match(await setup.waitForFrame(value => value.includes('BOUND-TASK-END')), /strict: store store_013af400171a556aae5e2597303c78e4/); }
  } finally { source.release(); setup.unmount(); await source.client.close(); await setup.dispose(); }
});
