/** Exercises the Agent Pool layout, navigation and read-failure states. */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { CapturedFrame } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { createDemoClient } from '../src/demo.ts';
import { mountHub } from '../src/hub.ts';
import type { ObservationClient } from '../src/api.ts';

/** Reads the rendered background of a terminal cell. */
function backgroundAt(frame: CapturedFrame, row: number, column: number): number[] {
  let position = 0;
  for (const span of frame.lines[row].spans) {
    if (column < position + span.width) return span.bg.toInts();
    position += span.width;
  }
  throw new Error('Cell is outside the captured frame');
}

for (const width of [80, 120, 200]) {
  test(`pool list and detail remain usable without outlines at ${width} columns`, async () => {
    const setup = await createTestRenderer({ width, height: 40 }), client = createDemoClient();
    const unmount = mountHub(setup.renderer, client, 'demo', () => {});
    try {
      await setup.waitForFrame(value => value.includes('4 loaded / 4 reported'));
      setup.mockInput.pressKey('2');
      let frame = await setup.waitForFrame(value => value.includes('Synthetic review pool') && value.includes('Agent Pool'));
      assert.doesNotMatch(frame, /[┌┐└┘│─╭╮╰╯]/);
      let rows = frame.split('\n'), row = rows.findIndex(value => value.includes('Synthetic review pool'));
      assert.notDeepEqual(backgroundAt(setup.captureSpans(), row, 2), backgroundAt(setup.captureSpans(), row, 0));
      await setup.mockMouse.click(rows[row].indexOf('Synthetic review pool') + 1, row);
      frame = await setup.waitForFrame(value => value.includes('Example reviewer') && value.includes('[Members]'));
      assert.doesNotMatch(frame, /[┌┐└┘│─╭╮╰╯]/);
      row = frame.split('\n').findIndex(value => value.includes('Example reviewer'));
      assert.notDeepEqual(backgroundAt(setup.captureSpans(), row, 2), backgroundAt(setup.captureSpans(), row, 0));
      assert.match(frame, /Open matching Run session/);
      setup.mockInput.pressArrow('right');
      frame = await setup.waitForFrame(value => value.includes('[Discussion]') && value.includes('Synthetic discussion'));
      assert.match(frame, /historical timestamps not reported/);
      setup.mockInput.pressKey('d');
      await setup.waitForFrame(value => value.includes('[Decisions]') && value.includes('Synthetic proposed result'));
      setup.mockInput.pressKey('v');
      await setup.waitForFrame(value => value.includes('[Votes]') && value.includes('Synthetic evidence'));
      setup.mockInput.pressKey('b');
      await setup.waitForFrame(value => value.includes('[Deliveries]') && value.includes('demo-delivery'));
      setup.mockInput.pressKey('m');
      await setup.waitForFrame(value => value.includes('[Members]') && value.includes('Example reviewer'));
      setup.mockInput.pressEnter();
      await setup.waitForFrame(value => value.includes('Inspect execution history') && value.includes('[History]'));
      setup.mockInput.pressEscape();
      await new Promise(resolve => setTimeout(resolve, 25));
      await setup.waitForFrame(value => value.includes('[Members]') && value.includes('Example reviewer'));
    } finally { unmount(); await client.close(); await setup.dispose(); }
  });
}

test('pool groups show loaded counts and keep the selected pool when another page arrives', async () => {
  const setup = await createTestRenderer({ width: 160, height: 40 }), demo = createDemoClient();
  const row = (id: string, name: string, closed: boolean) => ({ pool: { pool_id: id, name, purpose: 'Fixture', closed, revision: 1 }, leader_id: 'leader' });
  const pages = [[row('01', 'Closed first', true), row('02', 'Open first', false)], [row('03', 'Closed later', true), row('04', 'Open later', false)]];
  const opened: string[] = [];
  const client: ObservationClient = {
    async read(resource, params = {}, signal) {
      if (resource === 'pool.get' && typeof params.pool_id === 'string') opened.push(params.pool_id);
      const response = await demo.read(resource, params, signal);
      if (resource !== 'pool.list' || !response.data) return response;
      const outer = response.data as { data: Record<string, unknown> }, index = params.after === '02' ? 1 : 0, rows = pages[index];
      return { ...response, data: { ...outer, data: { ...outer.data, pools: rows, cursor: rows.at(-1)!.pool.pool_id, returned: rows.length, has_more: index === 0 } } };
    },
    close: () => demo.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'demo', () => {});
  try {
    await setup.waitForFrame(value => value.includes('4 loaded / 4 reported'));
    setup.mockInput.pressKey('2');
    let frame = await setup.waitForFrame(value => value.includes('Open · 1 loaded') && value.includes('Closed · 1 loaded'));
    assert.ok(frame.indexOf('Open first') < frame.indexOf('Closed first'));
    setup.mockInput.pressArrow('down'); await setup.waitForFrame(value => value.includes('› Closed first'));
    setup.mockInput.pressKey('n');
    frame = await setup.waitForFrame(value => value.includes('Open · 2 loaded') && value.includes('Closed · 2 loaded'));
    assert.match(frame, /› Closed first/);
    setup.mockInput.pressEnter(); await setup.waitFor(() => opened.includes('01'));
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('a selected pool stays visible when new groups move it below the viewport', async () => {
  const setup = await createTestRenderer({ width: 120, height: 24 }), demo = createDemoClient();
  const row = (id: string, name: string, closed: boolean) => ({ pool: { pool_id: id, name, purpose: 'Fixture', closed, revision: 1 }, leader_id: 'leader' });
  const pages = [[row('01', 'Closed target', true), row('02', 'Open first', false)], Array.from({ length: 10 }, (_, index) => row(String(index + 3).padStart(2, '0'), `Open ${index + 2}`, false))];
  const client: ObservationClient = {
    async read(resource, params = {}, signal) {
      const response = await demo.read(resource, params, signal);
      if (resource !== 'pool.list' || !response.data) return response;
      const outer = response.data as { data: Record<string, unknown> }, index = params.after === '02' ? 1 : 0, rows = pages[index];
      return { ...response, data: { ...outer, data: { ...outer.data, pools: rows, cursor: rows.at(-1)!.pool.pool_id, returned: rows.length, has_more: index === 0 } } };
    },
    close: () => demo.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'demo', () => {});
  try {
    await setup.waitForFrame(value => value.includes('4 loaded / 4 reported'));
    setup.mockInput.pressKey('2'); await setup.waitForFrame(value => value.includes('Open first') && value.includes('Closed target'));
    setup.mockInput.pressArrow('down'); await setup.waitForFrame(value => value.includes('› Closed target'));
    setup.mockInput.pressKey('n');
    const frame = await setup.waitForFrame(value => value.includes('› Closed target') && value.includes('End observed'));
    assert.match(frame, /› Closed target/);
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('a visible pool stays visible when an earlier purpose grows on refresh', async () => {
  const setup = await createTestRenderer({ width: 120, height: 24 }), demo = createDemoClient();
  let longer = false, reads = 0;
  const client: ObservationClient = {
    async read(resource, params = {}, signal) {
      const response = await demo.read(resource, params, signal);
      if (resource !== 'pool.list' || !response.data) return response;
      reads++;
      const outer = response.data as { data: Record<string, unknown> };
      const rows = [
        { pool: { pool_id: '01', name: 'First pool', purpose: longer ? 'Long purpose\n'.repeat(30) : 'Short', closed: false, revision: 1 }, leader_id: 'leader' },
        { pool: { pool_id: '02', name: 'Selected pool', purpose: 'Fixture', closed: false, revision: 1 }, leader_id: 'leader' },
      ];
      return { ...response, data: { ...outer, data: { ...outer.data, pools: rows, cursor: '02', returned: 2, has_more: false } } };
    },
    close: () => demo.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'demo', () => {});
  try {
    await setup.waitForFrame(value => value.includes('4 loaded / 4 reported'));
    setup.mockInput.pressKey('2'); await setup.waitForFrame(value => value.includes('First pool') && value.includes('Selected pool'));
    setup.mockInput.pressArrow('down'); await setup.waitForFrame(value => value.includes('› Selected pool'));
    const before = reads; longer = true; setup.mockInput.pressKey('r');
    await setup.waitFor(() => reads > before);
    await setup.waitForFrame(value => value.includes('Long purpose') && value.includes('› Selected pool'));
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('returning from a pool reveals the selected row in a short viewport', async () => {
  const setup = await createTestRenderer({ width: 120, height: 24 }), demo = createDemoClient();
  const client: ObservationClient = {
    async read(resource, params, signal) {
      const response = await demo.read(resource, params, signal);
      if (resource !== 'pool.list' || !response.data) return response;
      const outer = response.data as { data: Record<string, unknown> };
      const rows = Array.from({ length: 10 }, (_, index) => ({ pool: { pool_id: String(index + 1).padStart(2, '0'), name: `Pool ${index + 1}`, purpose: 'Fixture', closed: false, revision: 1 }, leader_id: 'leader' }));
      return { ...response, data: { ...outer, data: { ...outer.data, pools: rows, cursor: '10', returned: rows.length, has_more: false } } };
    },
    close: () => demo.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'demo', () => {});
  try {
    await setup.waitForFrame(value => value.includes('4 loaded / 4 reported'));
    setup.mockInput.pressKey('2'); await setup.waitForFrame(value => value.includes('Pool 1'));
    for (let index = 0; index < 9; index++) setup.mockInput.pressArrow('down');
    await setup.waitForFrame(value => value.includes('› Pool 10'));
    setup.mockInput.pressEnter(); await setup.waitForFrame(value => value.includes('‹ Pools') && value.includes('Pool 10'));
    setup.mockInput.pressEscape(); await new Promise(resolve => setTimeout(resolve, 25));
    await setup.waitForFrame(value => value.includes('› Pool 10'));
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('clicking an older pool frame retains the clicked ID after a concurrent inventory update', async () => {
  const setup = await createTestRenderer({ width: 160, height: 40 }), demo = createDemoClient();
  const row = (id: string, name: string) => ({ pool: { pool_id: id, name, purpose: 'Fixture', closed: false, revision: 1 }, leader_id: 'leader' });
  let changed = false, delivered = false, freeze = false, pending: FrameRequestCallback | undefined;
  const opened: string[] = [], original = setup.renderer.requestAnimationFrame.bind(setup.renderer);
  setup.renderer.requestAnimationFrame = callback => { if (freeze) { pending = callback; return 999; } return original(callback); };
  const client: ObservationClient = {
    async read(resource, params = {}, signal) {
      if (resource === 'pool.get' && typeof params.pool_id === 'string') opened.push(params.pool_id);
      const response = await demo.read(resource, params, signal);
      if (resource !== 'pool.list' || !response.data) return response;
      const rows = changed ? [row('01', 'Pool A'), row('02', 'Pool C'), row('03', 'Pool B')] : [row('01', 'Pool A'), row('03', 'Pool B')];
      if (changed) delivered = true;
      const outer = response.data as { data: Record<string, unknown> };
      return { ...response, data: { ...outer, data: { ...outer.data, pools: rows, cursor: '03', returned: rows.length, has_more: false } } };
    },
    close: () => demo.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'demo', () => {});
  try {
    await setup.waitForFrame(value => value.includes('4 loaded / 4 reported'));
    setup.mockInput.pressKey('2');
    const frame = await setup.waitForFrame(value => value.includes('Pool A') && value.includes('Pool B'));
    const rows = frame.split('\n'), y = rows.findIndex(value => value.includes('Pool B')), x = rows[y].indexOf('Pool B') + 1;
    freeze = true; changed = true; setup.mockInput.pressKey('r');
    await setup.waitFor(() => delivered); await new Promise<void>(resolve => setImmediate(resolve));
    await setup.mockMouse.click(x, y); await setup.waitFor(() => opened.includes('03'));
    freeze = false; const paint = pending; pending = undefined; paint?.(0);
    await setup.waitForFrame(value => value.includes('‹ Pools') && value.includes('Pool B'));
    setup.mockInput.pressEscape(); await new Promise(resolve => setTimeout(resolve, 25));
    const back = await setup.waitForFrame(value => value.includes('› Pool B'));
    assert.doesNotMatch(back, /› Pool C/);
  } finally { freeze = false; setup.renderer.requestAnimationFrame = original; pending?.(0); unmount(); await client.close(); await setup.dispose(); }
});

test('pool detail retains and marks the last good observation after a read failure', async () => {
  const setup = await createTestRenderer({ width: 120, height: 40 }), demo = createDemoClient();
  let disconnected = false;
  const client: ObservationClient = {
    async read(resource, params, signal) {
      if (resource === 'pool.get' && disconnected) return { schema_version: 1, source: 'pool', resource, observed_at_ms: Date.now(), outcome: 'unavailable', data: null, error: { code: 'offline', message: 'Source unavailable' } };
      return demo.read(resource, params, signal);
    },
    close: () => demo.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('4 loaded / 4 reported'));
    setup.mockInput.pressKey('2'); await setup.waitForFrame(value => value.includes('Synthetic review pool'));
    setup.mockInput.pressEnter(); await setup.waitForFrame(value => value.includes('Example reviewer'));
    disconnected = true; setup.mockInput.pressKey('r');
    const frame = await setup.waitForFrame(value => value.includes('unavailable') && value.includes('last good'));
    assert.match(frame, /Example reviewer/);
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('proposal failures are separate from a successful archive and never become an absent proposal', async () => {
  const setup = await createTestRenderer({ width: 120, height: 40 }), demo = createDemoClient();
  let disconnected = true;
  const client: ObservationClient = {
    async read(resource, params = {}, signal) {
      if (resource === 'pool.get' && params.section === 'proposal' && disconnected) return { schema_version: 1, source: 'pool', resource, observed_at_ms: Date.now(), outcome: 'unavailable', data: null, error: { code: 'offline', message: 'Source unavailable' } };
      return demo.read(resource, params, signal);
    },
    close: () => demo.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'live', () => {}, undefined, { pool: 'demo-pool' });
  try {
    await setup.waitForFrame(value => value.includes('[Members]'));
    setup.mockInput.pressKey('d');
    let frame = await setup.waitForFrame(value => value.includes('Proposal unavailable') && value.includes('Proposal archive'));
    assert.doesNotMatch(frame, /No proposal reported/);
    disconnected = false; setup.mockInput.pressKey('r');
    await setup.waitForFrame(value => value.includes('Criteria: Review the available evidence'));
    disconnected = true; setup.mockInput.pressKey('r');
    frame = await setup.waitForFrame(value => value.includes('Proposal unavailable') && value.includes('last good'));
    assert.match(frame, /Synthetic proposed result/);
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('recorded acceptance is shown without claiming verified vote authors', async () => {
  const setup = await createTestRenderer({ width: 160, height: 40 }), demo = createDemoClient();
  const client: ObservationClient = {
    async read(resource, params = {}, signal) {
      const response = await demo.read(resource, params, signal);
      if (resource !== 'pool.get' || params.section !== 'proposal' || !response.data) return response;
      const outer = response.data as { data: Record<string, unknown> }, data = outer.data, view = data.view as Record<string, unknown>, pool = view.pool as Record<string, unknown>, proposal = pool.proposal as Record<string, unknown>;
      return { ...response, data: { ...outer, data: { ...data, view: { ...view, pool: { ...pool, proposal: { ...proposal, state: 'accepted' } } } } } };
    },
    close: () => demo.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'demo', () => {}, undefined, { pool: 'demo-pool' });
  try {
    await setup.waitForFrame(value => value.includes('[Members]'));
    setup.mockInput.pressKey('d');
    const frame = await setup.waitForFrame(value => value.includes('Recorded acceptance does not by itself verify vote authors.'));
    assert.match(frame, /accepted · demo-proposal/);
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('a failed first pool read is reported as unavailable, not loading', async () => {
  const setup = await createTestRenderer({ width: 120, height: 40 }), demo = createDemoClient();
  const client: ObservationClient = {
    async read(resource, params, signal) {
      if (resource === 'pool.list') return { schema_version: 1, source: 'pool', resource, observed_at_ms: Date.now(), outcome: 'unavailable', data: null, error: { code: 'offline', message: 'Source unavailable' } };
      return demo.read(resource, params, signal);
    },
    close: () => demo.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('4 loaded / 4 reported'));
    setup.mockInput.pressKey('2');
    const frame = await setup.waitForFrame(value => value.includes('Pool source unavailable.'));
    assert.doesNotMatch(frame, /Loading pool observations/);
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('keyboard selection scrolls the pool title into a short viewport', async () => {
  const setup = await createTestRenderer({ width: 120, height: 16 }), demo = createDemoClient();
  const client: ObservationClient = {
    async read(resource, params, signal) {
      const result = await demo.read(resource, params, signal);
      if (resource !== 'pool.list' || !result.data) return result;
      const outer = result.data as { data: { pools: Record<string, unknown>[] } }, page = outer.data;
      const original = page.pools[0], source = original.pool as Record<string, unknown>;
      const pools = [...page.pools, { ...original, pool: { ...source, pool_id: 'z-second', name: 'Second pool' } }];
      return { ...result, data: { ...outer, data: { ...page, pools, cursor: 'z-second', returned: pools.length } } };
    },
    close: () => demo.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'demo', () => {});
  try {
    await setup.waitForFrame(value => value.includes('Agent Run'));
    setup.mockInput.pressKey('2'); await setup.waitForFrame(value => value.includes('Synthetic review pool'));
    setup.mockInput.pressArrow('down');
    await setup.waitForFrame(value => value.includes('› Second pool'));
  } finally { unmount(); await client.close(); await setup.dispose(); }
});
