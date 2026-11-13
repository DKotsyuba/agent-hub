/** Verifies adjustable polling with synthetic sources and a controlled clock. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestRenderer } from '@opentui/core/testing';
import { createDemoClient } from '../src/demo.ts';
import { mountHub } from '../src/hub.ts';
import type { ObservationClient, Resource } from '../src/api.ts';

test('polling cycles through the requested intervals without overlapping slow reads', async context => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const setup = await createTestRenderer({ width: 120, height: 40 }), demo = createDemoClient();
  const counts = new Map<Resource, number>(); let hold = false, release: (() => void) | null = null, activeCalls = 0;
  const client: ObservationClient = {
    async read(resource, params, signal) {
      if (resource === 'run.agents' && params?.active === true) { activeCalls++; return demo.read(resource, params, signal); }
      counts.set(resource, (counts.get(resource) ?? 0) + 1);
      if (resource === 'run.agents' && hold) await new Promise<void>(resolve => { release = resolve; signal?.addEventListener('abort', () => resolve(), { once: true }); });
      return demo.read(resource, params, signal);
    },
    close: () => demo.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'demo', () => {});
  const calls = (resource: Resource) => counts.get(resource) ?? 0;
  const tick = async (milliseconds: number) => { context.mock.timers.tick(milliseconds); await new Promise<void>(resolve => setImmediate(resolve)); await setup.renderOnce(); };
  try {
    let frame = await setup.waitForFrame(value => value.includes('Poll: 3s [u]') && value.includes('Agent Run') && value.includes('4 loaded / 4 reported'));
    const initialRun = calls('run.agents'), initialBridge = calls('bridge.overview'), initialActive = activeCalls;
    await tick(2999);
    assert.equal(calls('run.agents'), initialRun);
    await tick(1);
    assert.equal(calls('run.agents'), initialRun + 1);
    assert.equal(activeCalls, initialActive + 1);
    assert.equal(calls('bridge.overview'), initialBridge + 1);

    setup.mockInput.pressKey('u');
    frame = await setup.waitForFrame(value => value.includes('Poll: 5s [u]'));
    let before = calls('run.agents');
    await tick(4999);
    assert.equal(calls('run.agents'), before, 'the previous three-second timer was cancelled');
    await tick(1);
    assert.equal(calls('run.agents'), before + 1);

    const header = frame.split('\n')[1];
    await setup.mockMouse.click(header.indexOf('Poll:') + 1, 1);
    await setup.waitForFrame(value => value.includes('Poll: 10s [u]'));
    before = calls('run.agents');
    await tick(9999);
    assert.equal(calls('run.agents'), before, 'the previous five-second timer was cancelled');
    await tick(1);
    assert.equal(calls('run.agents'), before + 1);

    setup.mockInput.pressKey('u');
    await setup.waitForFrame(value => value.includes('Poll: 1s [u]'));
    before = calls('run.agents');
    await tick(999);
    assert.equal(calls('run.agents'), before);
    await tick(1);
    assert.equal(calls('run.agents'), before + 1);
    setup.mockInput.pressKey('u');
    await setup.waitForFrame(value => value.includes('Poll: 3s [u]'));

    hold = true;
    before = calls('run.agents');
    await tick(3000);
    assert.equal(calls('run.agents'), before + 1);
    await tick(9000);
    assert.equal(calls('run.agents'), before + 1, 'a slow read is not started again on later ticks');
    hold = false;
    (release as (() => void) | null)?.();
    await new Promise<void>(resolve => setImmediate(resolve));
    await tick(3000);
    assert.equal(calls('run.agents'), before + 2);

    setup.mockInput.pressKey('1');
    await setup.waitForFrame(value => value.includes('[Sessions]') && value.includes('Search earlier messages'));
    await new Promise<void>(resolve => setImmediate(resolve));
    const transcript = calls('run.transcript');
    await tick(3000);
    assert.equal(calls('run.transcript'), transcript + 1, 'one poll does not read the same loaded transcript twice');
    setup.mockInput.pressKey('/');
    await setup.waitForFrame(value => value.includes('Search loaded records'));
    setup.mockInput.pressKey('u');
    frame = await setup.waitForFrame(value => value.includes('> u') && value.includes('Poll: 3s [u]'));
    await setup.mockMouse.click(frame.split('\n')[1].indexOf('Poll:') + 1, 1);
    await setup.renderOnce();
    assert.match(setup.captureCharFrame(), /Poll: 3s \[u\]/, 'an open text overlay owns the input');
    setup.mockInput.pressEscape();
    await new Promise(resolve => setTimeout(resolve, 25));
    await setup.waitForFrame(value => !value.includes('Search loaded records'));

    setup.resize(60, 16);
    await setup.waitForFrame(value => value.includes('Poll: 3s [u]'));
    unmount();
    before = calls('run.agents');
    const transcriptBefore = calls('run.transcript');
    await tick(30000);
    assert.equal(calls('run.agents'), before, 'the polling timer stops when the UI is unmounted');
    assert.equal(calls('run.transcript'), transcriptBefore, 'no transcript reads survive unmount');
  } finally {
    (release as (() => void) | null)?.();
    unmount(); await client.close(); await setup.dispose();
    context.mock.timers.reset();
  }
});

test('a new execution still loads its transcript after the agent inventory changes', async () => {
  const setup = await createTestRenderer({ width: 120, height: 40 }), demo = createDemoClient();
  let resumed = false; const requests: Record<string, unknown>[] = [];
  const client: ObservationClient = {
    async read(resource, params = {}, signal) {
      if (resource === 'run.transcript') requests.push(params);
      const result = await demo.read(resource, params, signal);
      if (resource !== 'run.agents' || !resumed || !result.data) return result;
      const data = result.data as { items: Record<string, unknown>[] };
      return { ...result, data: { ...data, items: data.items.map(item => item.agent_id === 'demo-inspect' ? { ...item, sequence: 2 } : item) } };
    },
    close: () => demo.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'demo', () => {});
  try {
    await setup.waitForFrame(value => value.includes('4 loaded / 4 reported'));
    setup.mockInput.pressKey('1');
    await setup.waitForFrame(value => value.includes('Search earlier messages') && value.includes('sequence 1'));
    const before = requests.length;
    resumed = true;
    setup.mockInput.pressKey('r');
    await setup.waitForFrame(value => value.includes('Search earlier messages') && value.includes('sequence 2'));
    assert.ok(requests.slice(before).some(params => params.tail_blocks === 40), 'the new execution reads an initial history tail');
  } finally { unmount(); await client.close(); await setup.dispose(); }
});
