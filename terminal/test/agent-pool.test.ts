/** Exercises the standalone Pool observer without reading an installed service. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestRenderer } from '@opentui/core/testing';
import type { CapturedFrame } from '@opentui/core';
import { createDemoClient, DEMO_POOL_AGENT_ID, DEMO_POOL_INDEX_ID } from '../src/demo.ts';
import { mountHub } from '../src/hub.ts';
import { exportHistory } from '../src/export.ts';
import { poolDetail } from '../../src/live/protocol.ts';
import type { ObservationClient } from '../src/api.ts';

/** Returns the background of one captured terminal cell. */
function backgroundAt(frame: CapturedFrame, row: number, column: number): string {
  let position = 0;
  for (const span of frame.lines[row].spans) { if (column < position + span.width) return span.bg.toInts().join(','); position += span.width; }
  throw new Error('Cell outside captured frame');
}

test('Pool views verify execution references without claiming history attribution or cleanup', async () => {
  const setup = await createTestRenderer({ width: 160, height: 40 }), demo = createDemoClient();
  const calls: string[] = [];
  let referenceObserved = false;
  const client: ObservationClient = {
    async read(resource, params, signal) {
      calls.push(resource);
      const response = await demo.read(resource, params, signal);
      if (resource !== 'pool.get' || params?.section !== 'members' || !response.data) return response;
      const envelope = response.data as { data: { bindings?: Record<string, unknown>[] } };
      if (!envelope.data.bindings?.length) return response;
      referenceObserved = true;
      return { ...response, data: { ...envelope, data: { ...envelope.data, bindings: envelope.data.bindings.map(binding => ({ ...binding, run_execution_ref: `ex1_${'a'.repeat(64)}`, run_pin_id: 'pin_123e4567e89b42d3a456426614174000', run_store_id: `store_${'1'.repeat(32)}` })) } } };
    },
    close: () => demo.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'demo', () => {});
  try {
    await setup.waitForFrame(value => value.includes('4 loaded / 4 reported'));
    setup.mockInput.pressKey('2');
    await setup.waitForFrame(value => value.includes('Agent Pool') && value.includes('Synthetic review pool'));
    setup.mockInput.pressEnter();
    let frame = await setup.waitForFrame(value => value.includes('[Members]') && value.includes('Example reviewer'));
    assert.match(frame, /Open matching Run session/);
    assert.match(frame, /Cleanup: unknown/);
    assert.doesNotMatch(frame, /Cleanup: confirmed/);
    setup.mockInput.pressArrow('right');
    frame = await setup.waitForFrame(value => value.includes('[History]') && value.includes('Synthetic discussion'));
    assert.match(frame, /historical timestamps not reported/);
    setup.mockInput.pressArrow('right');
    frame = await setup.waitForFrame(value => value.includes('[Decisions]') && value.includes('Synthetic proposed result'));
    assert.match(frame, /Review the available evidence/);
    setup.mockInput.pressKey('v');
    await setup.waitForFrame(value => value.includes('[Votes]') && value.includes('Synthetic evidence'));
    setup.mockInput.pressArrow('right');
    await setup.waitForFrame(value => value.includes('[Deliveries]') && value.includes('demo-delivery'));
    setup.mockInput.pressKey('m');
    await setup.waitForFrame(value => value.includes('[Members]') && value.includes('Example reviewer'));
    setup.mockInput.pressEnter();
    const session = await setup.waitForFrame(value => value.includes('[History]') && value.includes(DEMO_POOL_AGENT_ID));
    assert.match(session, /ref matched/);
    assert.match(session, /History and answer attribution unverified/);
    assert.ok(referenceObserved);
    assert.ok(calls.includes('pool.list') && calls.includes('pool.get'));
    assert.ok(!calls.includes('run.pools') && !calls.includes('run.pool'));
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('a pool can be opened directly without depending on its discovery page', async () => {
  const setup = await createTestRenderer({ width: 120, height: 40 }), demo = createDemoClient();
  const client: ObservationClient = {
    async read(resource, params, signal) {
      if (resource === 'pool.list') return { schema_version: 1, source: 'pool', resource, observed_at_ms: Date.now(), outcome: 'unavailable', data: null, error: { code: 'fixture', message: 'unavailable' } };
      return demo.read(resource, params, signal);
    },
    close: () => demo.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'demo', () => {}, undefined, { pool: 'demo-pool' });
  try {
    const frame = await setup.waitForFrame(value => value.includes('[Members]') && value.includes('Example reviewer'));
    assert.match(frame, /Agent Pool/);
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('a pin release intent names its member without claiming release', async () => {
  const setup = await createTestRenderer({ width: 120, height: 40 }), demo = createDemoClient();
  const client: ObservationClient = {
    async read(resource, params, signal) {
      const response = await demo.read(resource, params, signal);
      if (resource !== 'pool.get' || params?.section !== 'deliveries' || !response.data) return response;
      const envelope = response.data as { data: { view: { deliveries: Record<string, unknown>[] } } };
      const original = envelope.data.view.deliveries[0];
      const deliveries = [
        { ...original, operation: 'release_pin', state: 'unknown' },
        { ...original, operation_id: 'demo-batch', member_id: null, operation: 'start_batch', state: 'unknown' },
      ];
      return { ...response, data: { ...envelope, data: { ...envelope.data, returned: 2, cursor: '2', view: { ...envelope.data.view, deliveries, next_after: 2 } } } };
    },
    close: () => demo.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'demo', () => {}, undefined, { pool: 'demo-pool' });
  try {
    await setup.waitForFrame(value => value.includes('[Members]'));
    setup.mockInput.pressKey('b');
    const frame = await setup.waitForFrame(value => value.includes('release_pin'));
    assert.match(frame, /release_pin · unknown · member demo-member/);
    assert.match(frame, /start_batch · unknown · demo-batch/);
    assert.match(frame, /pin release request does not confirm history was released/);
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('replacement requests retain the original member and distinguish their outcomes', async () => {
  const setup = await createTestRenderer({ width: 160, height: 40 }), demo = createDemoClient();
  const states = ['queued', 'inflight', 'unknown', 'accepted', 'refused', 'cancelled', 'future_state'];
  const client: ObservationClient = {
    async read(resource, params, signal) {
      const response = await demo.read(resource, params, signal);
      if (resource !== 'pool.get' || params?.section !== 'deliveries' || !response.data) return response;
      const envelope = response.data as { data: { view: { deliveries: Record<string, unknown>[] } } };
      const original = envelope.data.view.deliveries[0];
      const deliveries = states.map(state => ({ ...original, operation: 'replace', state, member_id: `old-${state}`, operation_id: `replacement-${state}` }));
      return { ...response, data: { ...envelope, data: { ...envelope.data, returned: deliveries.length, cursor: String(deliveries.length), view: { ...envelope.data.view, deliveries, next_after: deliveries.length } } } };
    },
    close: () => demo.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'demo', () => {}, undefined, { pool: 'demo-pool' });
  try {
    await setup.waitForFrame(value => value.includes('[Members]'));
    setup.mockInput.pressKey('b');
    const frame = await setup.waitForFrame(value => value.includes('replacement-future_state'));
    const lines = frame.split('\n');
    for (const state of states) {
      const index = lines.findIndex(line => line.includes(`Replace request · ${state} · original member old-${state}`));
      assert.ok(index >= 0, `missing replacement ${state}`);
      const detail = lines[index + 1];
      assert.match(detail, state === 'accepted' ? /Replacement recorded by Pool/ : state === 'refused' ? /Request refused; it did not replace the original member/ : state === 'cancelled' ? /Cancelled before admission was sent to Run/ : /Replacement not confirmed/);
    }
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('a cancelled replacement state survives Pool detail validation', async () => {
  const demo = createDemoClient();
  try {
    const response = await demo.read('pool.get', { pool_id: 'demo-pool', section: 'deliveries', after: 0 });
    const payload = structuredClone(response.data) as { data: { view: { deliveries: Record<string, unknown>[] } } };
    payload.data.view.deliveries[0] = { ...payload.data.view.deliveries[0], operation: 'replace', member_id: 'original-member', state: 'cancelled' };
    const view = poolDetail(payload).view as { deliveries: Record<string, unknown>[] };
    assert.equal(view.deliveries[0].state, 'cancelled');
    assert.equal(view.deliveries[0].member_id, 'original-member');
  } finally { await demo.close(); }
});

test('a replacement row without an original member is rejected', async () => {
  const demo = createDemoClient();
  try {
    const response = await demo.read('pool.get', { pool_id: 'demo-pool', section: 'deliveries', after: 0 });
    for (const member_id of [null, '', undefined, 1]) {
      const payload = structuredClone(response.data) as { data: { view: { deliveries: Record<string, unknown>[] } } };
      payload.data.view.deliveries[0] = { ...payload.data.view.deliveries[0], operation: 'replace', member_id };
      assert.throws(() => poolDetail(payload), `invalid member ${String(member_id)}`);
    }
  } finally { await demo.close(); }
});

test('an older Pool observer is shown as forward-only without pretending to support snapshot copy', async () => {
  const setup = await createTestRenderer({ width: 120, height: 40 }), demo = createDemoClient();
  const client: ObservationClient = {
    async read(resource, params, signal) {
      const response = await demo.read(resource, params, signal);
      if (resource !== 'pool.identity' || !response.data) return response;
      const outer = response.data as { data: Record<string, unknown> };
      return { ...response, data: { ...outer, data: { ...outer.data, capabilities: ['identity', 'list', 'get'] } } };
    },
    close: () => demo.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'demo', () => {}, undefined, { pool: 'demo-pool' });
  try {
    await setup.waitForFrame(value => value.includes('[Members]'));
    setup.mockInput.pressArrow('right');
    await setup.waitForFrame(value => value.includes('Forward-only source pages') && value.includes('Synthetic discussion'));
    setup.mockInput.pressKey('y');
    await setup.waitForFrame(value => value.includes('Pool history copy requires a source watermark'));
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('a bound Run session opens by status even when absent from session pages', async () => {
  const setup = await createTestRenderer({ width: 120, height: 40 }), demo = createDemoClient();
  const calls: string[] = [];
  const client: ObservationClient = {
    async read(resource, params, signal) {
      calls.push(resource);
      const response = await demo.read(resource, params, signal);
      if (resource !== 'run.agents' || !response.data) return response;
      const page = response.data as { items: Record<string, unknown>[] }, items = page.items.filter(item => item.agent_id !== 'demo-inspect');
      return { ...response, data: { ...page, items, total: items.length, next_offset: null, complete: true } };
    },
    close: () => demo.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'demo', () => {}, undefined, { pool: 'demo-pool' });
  try {
    await setup.waitForFrame(value => value.includes('[Members]') && value.includes('Example reviewer'));
    setup.mockInput.pressEnter();
    await setup.waitForFrame(value => value.includes('[History]') && value.includes(DEMO_POOL_AGENT_ID));
    assert.ok(calls.includes('run.status'));
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('an older Run without status resolves an off-page binding through revision-fenced inventory', async () => {
  const setup = await createTestRenderer({ width: 120, height: 40 }), demo = createDemoClient(), offsets: number[] = [];
  const client: ObservationClient = {
    async read(resource, params = {}, signal) {
      if (resource === 'run.status') return { schema_version: 1, source: 'run', resource, observed_at_ms: Date.now(), outcome: 'incompatible', data: null, error: { code: 'run_method_unavailable', message: 'Unavailable' } };
      if (resource === 'run.agents') {
        const base = await demo.read(resource, {}, signal), page = base.data as { items: Record<string, unknown>[] }, active = params.active === true, offset = Number(params.offset ?? 0);
        if (!active) offsets.push(offset);
        const original = page.items.find(row => row.agent_id === (active || offset === 0 ? 'demo-index' : 'demo-inspect'))!;
        const item = original.agent_id === 'demo-inspect' ? { ...original, agent_id: DEMO_POOL_AGENT_ID } : original;
        return { ...base, data: { ...page, items: [item], offset, total: active ? 1 : 2, next_offset: active || offset > 0 ? null : 1, complete: active || offset > 0 } };
      }
      return demo.read(resource, params, signal);
    },
    close: () => demo.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'demo', () => {}, undefined, { pool: 'demo-pool' });
  try {
    await setup.waitForFrame(value => value.includes('[Members]') && value.includes('Example reviewer'));
    setup.mockInput.pressEnter();
    await setup.waitForFrame(value => value.includes('[History]') && value.includes(DEMO_POOL_AGENT_ID));
    assert.ok(offsets.includes(1), 'the lookup continues beyond the loaded page');
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('an older Run lookup rejects inventory pages from different revisions', async () => {
  const setup = await createTestRenderer({ width: 120, height: 40 }), demo = createDemoClient();
  const client: ObservationClient = {
    async read(resource, params = {}, signal) {
      if (resource === 'run.status') return { schema_version: 1, source: 'run', resource, observed_at_ms: Date.now(), outcome: 'incompatible', data: null, error: { code: 'run_method_unavailable', message: 'Unavailable' } };
      if (resource === 'run.agents') {
        const base = await demo.read(resource, {}, signal), page = base.data as { items: Record<string, unknown>[] }, active = params.active === true, offset = Number(params.offset ?? 0);
        const original = page.items.find(row => row.agent_id === (active || offset === 0 ? 'demo-index' : 'demo-inspect'))!;
        const item = original.agent_id === 'demo-inspect' ? { ...original, agent_id: DEMO_POOL_AGENT_ID } : original;
        return { ...base, data: { ...page, items: [item], offset, total: active ? 1 : 2, next_offset: active || offset > 0 ? null : 1, complete: active || offset > 0, revision: offset > 0 ? 2 : 1 } };
      }
      return demo.read(resource, params, signal);
    },
    close: () => demo.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'demo', () => {}, undefined, { pool: 'demo-pool' });
  try {
    await setup.waitForFrame(value => value.includes('[Members]') && value.includes('Example reviewer'));
    setup.mockInput.pressEnter();
    const frame = await setup.waitForFrame(value => value.includes('Bound Run execution is unavailable'));
    assert.match(frame, /\[Members\]/);
    assert.doesNotMatch(frame, /\[History\]/);
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('a Run connection failure is not silently downgraded to an inventory scan', async () => {
  const setup = await createTestRenderer({ width: 120, height: 40 }), demo = createDemoClient();
  let statusTried = false, scansAfterFailure = 0;
  const client: ObservationClient = {
    async read(resource, params, signal) {
      if (resource === 'run.status') { statusTried = true; return { schema_version: 1, source: 'run', resource, observed_at_ms: Date.now(), outcome: 'unavailable', data: null, error: { code: 'run_connect', message: 'Unavailable' } }; }
      if (resource === 'run.agents' && statusTried) scansAfterFailure++;
      return demo.read(resource, params, signal);
    },
    close: () => demo.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'demo', () => {}, undefined, { pool: 'demo-pool' });
  try {
    await setup.waitForFrame(value => value.includes('[Members]') && value.includes('Example reviewer'));
    setup.mockInput.pressEnter();
    await setup.waitForFrame(value => value.includes('Bound Run execution is unavailable'));
    assert.equal(scansAfterFailure, 0);
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('a changed Run sequence cannot be opened through an old pool binding', async () => {
  const setup = await createTestRenderer({ width: 120, height: 40 }), demo = createDemoClient();
  const client: ObservationClient = {
    async read(resource, params, signal) {
      const response = await demo.read(resource, params, signal);
      if (resource !== 'run.status' || !response.data) return response;
      const output = response.data as { items: Record<string, unknown>[]; view?: unknown };
      return { ...response, data: { ...output, items: output.items.map(item => ({ ...item, match: 'missing', selected: null, retained_latest: null, coverage: 'unknown', restart_resume: 'unknown', lineage_terminal: null, terminal_outcome: null, success_commit: 'unknown', cleanup: { scope: 'lineage', state: 'unknown' } })), view: undefined } };
    },
    close: () => demo.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'demo', () => {}, undefined, { pool: 'demo-pool' });
  try {
    await setup.waitForFrame(value => value.includes('[Members]') && value.includes('Example reviewer'));
    setup.mockInput.pressEnter();
    const frame = await setup.waitForFrame(value => value.includes('Bound execution is unavailable or missing'));
    assert.match(frame, /\[Members\]/);
    assert.doesNotMatch(frame, /\[History\]/);
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

for (const [field, replacement] of [
  ['pool_id', 'another-pool'],
  ['run_id', DEMO_POOL_INDEX_ID],
  ['run_sequence', 2],
  ['run_execution_ref', `ex1_${'b'.repeat(64)}`],
  ['run_pin_id', 'pin_123e4567e89b42d3a456426614174001'],
  ['run_store_id', `store_${'2'.repeat(32)}`],
  ['removed', null],
  ['duplicated', null],
] as const) test(`a binding change (${field}) during lookup cannot open the old Run session`, async () => {
  const setup = await createTestRenderer({ width: 120, height: 40 }), demo = createDemoClient();
  let changed = false, started = false, releaseLookup!: () => void;
  const pending = new Promise<void>(resolve => { releaseLookup = resolve; });
  const client: ObservationClient = {
    async read(resource, params, signal) {
      if (resource === 'run.status') { started = true; await pending; }
      const response = await demo.read(resource, params, signal);
      if (resource !== 'pool.get' || params?.section !== 'members' || !response.data) return response;
      const envelope = response.data as { data: { bindings: Record<string, unknown>[]; view: { members: Record<string, unknown>[] } } };
      const members = envelope.data.view.members.map(member => ({ ...member, name: changed ? 'Changed reviewer' : member.name }));
      const bindings = envelope.data.bindings.map(binding => ({ ...binding, run_execution_ref: `ex1_${'a'.repeat(64)}`, run_pin_id: 'pin_123e4567e89b42d3a456426614174000', run_store_id: `store_${'1'.repeat(32)}`, ...(changed && field !== 'removed' && field !== 'duplicated' ? { [field]: replacement } : {}) }));
      if (changed && field === 'removed') bindings.length = 0;
      if (changed && field === 'duplicated') bindings.push({ ...bindings[0] });
      return { ...response, data: { ...envelope, data: { ...envelope.data, bindings, view: { ...envelope.data.view, members } } } };
    },
    close: () => demo.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'demo', () => {}, undefined, { pool: 'demo-pool' });
  try {
    await setup.waitForFrame(value => value.includes('[Members]') && value.includes('Example reviewer'));
    setup.mockInput.pressEnter(); await setup.waitFor(() => started);
    changed = true; setup.mockInput.pressKey('r');
    await setup.waitForFrame(value => value.includes('Changed reviewer'));
    releaseLookup();
    const frame = await setup.waitForFrame(value => value.includes('Pool binding changed'));
    assert.match(frame, /\[Members\]/);
    assert.doesNotMatch(frame, /\[History\]/);
  } finally { releaseLookup(); unmount(); await client.close(); await setup.dispose(); }
});

test('leaving the roster cancels a pending member lookup without changing views later', async () => {
  const setup = await createTestRenderer({ width: 120, height: 40 }), demo = createDemoClient();
  let started = false, cancelled = false;
  const client: ObservationClient = {
    async read(resource, params, signal) {
      if (resource === 'run.status') {
        started = true;
        await new Promise<void>(resolve => { const abort = () => { cancelled = true; resolve(); }; if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true }); });
      }
      return demo.read(resource, params, signal);
    },
    close: () => demo.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'demo', () => {}, undefined, { pool: 'demo-pool' });
  try {
    await setup.waitForFrame(value => value.includes('[Members]') && value.includes('Example reviewer'));
    setup.mockInput.pressEnter(); await setup.waitFor(() => started);
    setup.mockInput.pressKey('d');
    await setup.waitFor(() => cancelled);
    const frame = await setup.waitForFrame(value => value.includes('[Decisions]'));
    assert.doesNotMatch(frame, /\[History\]/);
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('member continuation sends the revision fence and stale pages can be restarted', async () => {
  const setup = await createTestRenderer({ width: 120, height: 40 }), demo = createDemoClient();
  const requests: Record<string, unknown>[] = []; let stale = false;
  const client: ObservationClient = {
    async read(resource, params = {}, signal) {
      if (resource === 'pool.get' && params.section === 'members') {
        requests.push({ ...params });
        if (params.after === 2 && stale) return { schema_version: 1, source: 'pool', resource, observed_at_ms: Date.now(), outcome: 'unavailable', data: null, error: { code: 'stale', message: 'Source unavailable' } };
        const base = await demo.read(resource, { ...params, after: 0 }, signal);
        const outer = base.data as { data: Record<string, unknown> }, payload = outer.data, view = payload.view as Record<string, unknown>;
        const member = (view.members as Record<string, unknown>[])[0];
        const rows = params.after === 2 ? [{ ...member, member_id: 'third', name: 'Third reviewer' }] : [member, { ...member, member_id: 'second', name: 'Second reviewer' }];
        const after = Number(params.after ?? 0), next = after + rows.length, more = after === 0;
        return { ...base, data: { ...outer, data: { ...payload, bindings: [], returned: rows.length, cursor: String(next), has_more: more, view: { ...view, members: rows, next_after: next, has_more: more } } } };
      }
      return demo.read(resource, params, signal);
    },
    close: () => demo.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'demo', () => {});
  try {
    await setup.waitForFrame(value => value.includes('4 loaded / 4 reported'));
    setup.mockInput.pressKey('2'); await setup.waitForFrame(value => value.includes('Synthetic review pool'));
    setup.mockInput.pressEnter(); await setup.waitForFrame(value => value.includes('Second reviewer'));
    stale = true; setup.mockInput.pressKey('n');
    await setup.waitForFrame(value => value.includes('unavailable') && value.includes('Restart this section'));
    assert.deepEqual(requests.find(row => row.after === 2), { pool_id: 'demo-pool', section: 'members', after: 2, include_bindings: true, expected_revision: 1 });
    stale = false; setup.mockInput.pressKey('h');
    await setup.waitForFrame(value => value.includes('Second reviewer'));
    setup.mockInput.pressKey('n');
    await setup.waitForFrame(value => value.includes('Third reviewer'));
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('a retained Run vote with unknown validity is not presented as a verified vote', async () => {
  const setup = await createTestRenderer({ width: 160, height: 40 }), demo = createDemoClient();
  const client: ObservationClient = {
    async read(resource, params = {}, signal) {
      const base = await demo.read(resource, params, signal);
      if (resource !== 'pool.get' || params.section !== 'votes' || !base.data) return base;
      const outer = base.data as { data: Record<string, unknown> }, data = outer.data, view = data.view as Record<string, unknown>, pool = view.pool as Record<string, unknown>, proposal = pool.proposal as Record<string, unknown>;
      const votes = {
        'managed-member': { choice: 'ready', evidence: 'Retained evidence', checks_met: true, validity: 'unknown' },
        'bridge-member': { choice: 'ready', evidence: 'Bridge evidence', checks_met: true },
      };
      return { ...base, data: { ...outer, data: { ...data, cursor: '2', returned: 2, view: { ...view, next_after: 2, pool: { ...pool, proposal: { ...proposal, votes } } } } } };
    },
    close: () => demo.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'demo', () => {}, undefined, { pool: 'demo-pool' });
  try {
    await setup.waitForFrame(value => value.includes('[Members]'));
    setup.mockInput.pressKey('v');
    const frame = await setup.waitForFrame(value => value.includes('managed-member') && value.includes('bridge-member'));
    const rows = frame.split('\n'), managed = rows.find(row => row.includes('managed-member'))!, bridge = rows.find(row => row.includes('bridge-member'))!;
    assert.match(managed, /ready · validity unknown · checks met · Retained evidence/);
    assert.match(bridge, /ready · checks met · Bridge evidence/);
    assert.doesNotMatch(bridge, /validity|verified/);
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('history windows keep IDs above 2^53 exact while following and exporting a frozen journal', async () => {
  const setup = await createTestRenderer({ width: 120, height: 24 }), demo = createDemoClient();
  const first = 9007199254740993n;
  const ids = Array.from({ length: 20 }, (_, index) => String(first + BigInt(index))), requests: Record<string, unknown>[] = [];
  let appendDuringExport = false, releaseOlder!: () => void, olderReturned = false;
  const olderGate = new Promise<void>(resolve => { releaseOlder = resolve; });
  const client: ObservationClient = {
    async read(resource, params = {}, signal) {
      if (resource !== 'pool.get' || params.section !== 'history' || !params.direction) return demo.read(resource, params, signal);
      requests.push({ ...params });
      if (params.direction === 'backward' && typeof params.before === 'string' && !olderReturned) { await olderGate; olderReturned = true; }
      const base = await demo.read(resource, { pool_id: 'demo-pool', section: 'members' }, signal);
      const outer = base.data as { data: Record<string, unknown> }, source = outer.data, oldView = source.view as Record<string, unknown>;
      if (appendDuringExport && params.direction === 'forward' && params.through) { ids.push(String(first + BigInt(ids.length))); appendDuringExport = false; }
      const watermark = String(params.through ?? ids.at(-1) ?? '0'), after = String(params.after ?? '0'), before = params.before == null ? null : String(params.before);
      const eligible = ids.filter(id => BigInt(id) <= BigInt(watermark) && (params.direction === 'backward' ? before === null || BigInt(id) < BigInt(before) : BigInt(id) > BigInt(after)));
      const selected = params.direction === 'backward' ? eligible.slice(-3) : eligible.slice(0, 3), more = eligible.length > selected.length;
      const cursor = selected.length ? params.direction === 'backward' ? selected[0] : selected.at(-1)! : params.direction === 'backward' ? '0' : after;
      const events = selected.map(id => ({ event_id: Number(id), event_id_exact: id, revision: 1, kind: 'message', author: { kind: 'leader' }, body: `Event ${id}`, recipient: null }));
      return { ...base, data: { ...outer, data: { ...source, section: 'history', bindings: undefined, cursor, history_watermark: watermark, returned: events.length, has_more: more, view: { ...oldView, section: 'history', members: [], events, next_after: Number(cursor), has_more: more } } } };
    },
    close: () => demo.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'demo', () => {});
  try {
    await setup.waitForFrame(value => value.includes('4 loaded / 4 reported'));
    setup.mockInput.pressKey('2'); await setup.waitForFrame(value => value.includes('Synthetic review pool'));
    setup.mockInput.pressEnter(); await setup.waitForFrame(value => value.includes('[Members]'));
    setup.mockInput.pressArrow('right');
    await setup.waitForFrame(value => value.includes(`Event ${ids[19]}`) && value.includes('Following'));
    const captured = setup.captureSpans(), column = 120 - 3;
    const track = backgroundAt(captured, 8, column), thumb = Array.from({ length: 12 }, (_, index) => index + 8).filter(row => backgroundAt(captured, row, column) !== track);
    assert.ok(thumb.length > 0 && thumb.at(-1)! - thumb[0] + 1 === thumb.length, 'the pool scrollbar thumb is continuous');
    await setup.mockMouse.drag(column, thumb.at(-1)!, column, 8);
    await setup.waitForFrame(value => value.includes('Follow paused'));
    await setup.waitFor(() => requests.some(request => typeof request.before === 'string'));
    const before = setup.captureCharFrame(), anchor = before.match(/Event (\d+)/)?.[1];
    assert.ok(anchor);
    const beforeRow = before.split('\n').findIndex(line => line.includes(`Event ${anchor}`));
    releaseOlder();
    await setup.waitFor(() => olderReturned);
    const after = await setup.waitForFrame(value => value.includes(`Event ${anchor}`));
    assert.equal(after.split('\n').findIndex(line => line.includes(`Event ${anchor}`)), beforeRow, 'loading earlier pages preserves the visible event');
    const older = requests.find(request => typeof request.before === 'string');
    assert.equal(older?.through, ids[19]);
    assert.equal(typeof older?.before, 'string');
    setup.mockInput.pressKey('f');
    await setup.waitForFrame(value => value.includes('Following'));
    const next = String(first + 20n); ids.push(next);
    setup.mockInput.pressKey('r');
    await setup.waitForFrame(value => value.includes(`Event ${next}`));
    assert.ok(requests.some(request => request.direction === 'forward' && request.after === ids[19] && request.through === undefined));
    appendDuringExport = true;
    const snapshot = await exportHistory(client, { kind: 'pool', id: 'demo-pool' });
    assert.match(snapshot, new RegExp(`Journal snapshot through #${next}`));
    assert.ok(snapshot.includes(`Event ${ids[0]}`) && snapshot.includes(`Event ${next}`));
    assert.ok(!snapshot.includes(`Event ${ids.at(-1)}`), 'the export excludes an event added after its watermark');
    assert.ok(requests.some(request => request.direction === 'forward' && request.after === '0' && request.through === next));
  } finally { releaseOlder(); unmount(); await client.close(); await setup.dispose(); }
});

for (const mismatched of [false, true]) {
  test(`structured criteria show only check evidence belonging to the selected vote (${mismatched ? 'mismatch' : 'matched'})`, async () => {
    const setup = await createTestRenderer({ width: 160, height: 40 }), demo = createDemoClient();
    const voteId = '9007199254740993', checks = [
      { criterion_id: 'criterion-a', status: 'met', evidence: 'First verified evidence' },
      { criterion_id: 'criterion-b', status: 'unmet', evidence: 'Second missing evidence' },
    ];
    const client: ObservationClient = {
      async read(resource, params = {}, signal) {
        if (resource === 'pool.identity') {
          const base = await demo.read(resource, params, signal), outer = base.data as { data: Record<string, unknown> };
          return { ...base, data: { ...outer, data: { ...outer.data, capabilities: ['identity', 'list', 'get', 'history_window_v1', 'structured_acceptance_v1'] } } };
        }
        if (resource === 'pool.get' && params.section === 'criteria') {
          const base = await demo.read(resource, { ...params, section: 'members', after: 0 }, signal);
          const outer = base.data as { data: Record<string, unknown> }, payload = outer.data, view = payload.view as Record<string, unknown>, pool = view.pool as Record<string, unknown>;
          return { ...base, data: { ...outer, data: { ...payload, section: 'criteria', bindings: undefined, returned: 2, cursor: '2', view: { ...view, section: 'criteria', members: [], next_after: 2, pool: { ...pool, acceptance: [{ id: 'criterion-a', text: 'First criterion' }, { id: 'criterion-b', text: 'Second criterion' }] } } } } };
        }
        if (resource === 'pool.get' && params.section === 'votes') {
          const base = await demo.read(resource, params, signal), outer = base.data as { data: Record<string, unknown> }, payload = outer.data, view = payload.view as Record<string, unknown>, pool = view.pool as Record<string, unknown>, proposal = pool.proposal as Record<string, unknown>;
          return { ...base, data: { ...outer, data: { ...payload, view: { ...view, pool: { ...pool, proposal: { ...proposal, votes: { 'demo-member': { choice: 'ready', evidence: 'Reviewed', checks_met: false, checks_count: 2, vote_event_id: voteId } } } } } } } };
        }
        if (resource === 'pool.get' && params.section === 'history' && params.direction === 'forward' && params.after === voteId) {
          const base = await demo.read(resource, { pool_id: 'demo-pool', section: 'members', after: 0 }, signal), outer = base.data as { data: Record<string, unknown> }, payload = outer.data, view = payload.view as Record<string, unknown>;
          const rows = checks.map((check, index) => ({ event_id: Number(BigInt(voteId) + BigInt(index + 1)), event_id_exact: String(BigInt(voteId) + BigInt(index + 1)), revision: 1, kind: 'vote_check', author: { kind: 'member', member_id: 'demo-member' }, body: '', recipient: null, vote_event_id: mismatched ? '1' : voteId, check }));
          const cursor = rows.at(-1)!.event_id_exact;
          return { ...base, data: { ...outer, data: { ...payload, section: 'history', bindings: undefined, cursor, history_watermark: cursor, returned: rows.length, has_more: false, view: { ...view, section: 'history', members: [], events: rows, next_after: Number(cursor), has_more: false } } } };
        }
        return demo.read(resource, params, signal);
      },
      close: () => demo.close(),
    };
    const unmount = mountHub(setup.renderer, client, 'demo', () => {}, undefined, { pool: 'demo-pool' });
    try {
      await setup.waitForFrame(value => value.includes('[Members]'));
      setup.mockInput.pressKey('c');
      await setup.waitForFrame(value => value.includes('[Criteria]') && value.includes('First criterion') && value.includes('Second criterion'));
      setup.mockInput.pressKey('v');
      await setup.waitForFrame(value => value.includes('[Votes]') && value.includes('checks unmet'));
      setup.mockInput.pressEnter();
      const frame = await setup.waitForFrame(value => mismatched ? value.includes('Check evidence unavailable or incomplete') : value.includes('First verified evidence') && value.includes('Second missing evidence'));
      if (mismatched) assert.doesNotMatch(frame, /First verified evidence|Second missing evidence/);
    } finally { unmount(); await client.close(); await setup.dispose(); }
  });
}
