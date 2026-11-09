/** Verifies session labels against source-reported models and requested reasoning. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestRenderer } from '@opentui/core/testing';
import { runAgent } from '../../src/live/protocol.ts';
import { createDemoClient } from '../src/demo.ts';
import { mountHub } from '../src/hub.ts';
import type { ObservationClient } from '../src/api.ts';

test('reasoning comes from the requested effort and is not inferred from profile', () => {
  const base = { agent_id: 'synthetic', sequence: 1, status: 'running', model: 'model', profile: 'high' };
  assert.equal(runAgent({ ...base, effort: 'medium' }).effort, 'medium');
  assert.equal(runAgent({ ...base, effort: null }).effort, null);
  assert.equal(runAgent(base).effort, null);
  assert.equal(runAgent({ ...base, effort: { level: 'high' } }).effort, null);
});

for (const width of [80, 110, 120, 200]) {
  test(`session metadata uses available width at ${width} columns`, async () => {
    const setup = await createTestRenderer({ width, height: 40 }), demo = createDemoClient();
    const client: ObservationClient = {
      async read(resource, params, signal) {
        const result = await demo.read(resource, params, signal);
        if (resource !== 'run.agents' || !result.data) return result;
        const data = result.data as { items: Record<string, unknown>[] };
        return { ...result, data: { ...data, items: data.items.map(item => item.agent_id === 'demo-inspect' ? { ...item, model: 'claude-sonnet-5-5', effort: 'high' } : item.agent_id === 'demo-index' ? { ...item, model: 'gpt-6.1-terra-super-long-name', effort: null, profile: 'ultra' } : item) } };
      },
      close: () => demo.close(),
    };
    const unmount = mountHub(setup.renderer, client, 'live', () => {});
    try {
      await setup.waitForFrame(value => value.includes('Agent Run') && value.includes('4 loaded / 4 reported'));
      setup.mockInput.pressKey('1');
      const frame = await setup.waitForFrame(value => value.includes('Inspect execution history') && value.includes('Index repository'));
      const rows = frame.split('\n'), sidebar = width < 110 ? width : Math.round(width * 38 / 120);
      const item = (name: string) => {
        const start = rows.findIndex(row => row.slice(0, sidebar).includes(name));
        assert.ok(start >= 0);
        return rows.slice(start, start + 4).map(row => row.slice(0, sidebar)).join('\n');
      };
      const first = item('Inspect execution history'), second = item('Index repository');
      assert.match(first, /claude-sonnet-5-5/);
      assert.match(first, /reasoning high/);
      assert.match(first, /Running/);
      assert.match(first, /3m 12s/);
      assert.match(first, /agent-hub/);
      assert.match(first, /Read history/);
      assert.match(second, /gpt-6\.1-terra-super-long-name/);
      assert.match(second, /reasoning —/);
      assert.doesNotMatch(second, /reasoning ultra/);
      assert.match(second, /6m 5s/);
    } finally { unmount(); await client.close(); await setup.dispose(); }
  });
}

test('model, reasoning, folder and action stay readable when they fit across the available rows', async () => {
  const setup = await createTestRenderer({ width: 120, height: 40 }), demo = createDemoClient();
  const client: ObservationClient = {
    async read(resource, params, signal) {
      const result = await demo.read(resource, params, signal);
      if (resource !== 'run.agents' || !result.data) return result;
      const data = result.data as { items: Record<string, unknown>[] };
      return { ...result, data: { ...data, items: data.items.map(item => item.agent_id === 'demo-inspect' ? { ...item, model: 'claude-sonnet-5-5', effort: 'high', workdir: '/demo/long-folder-name-1234' } : item) } };
    },
    close: () => demo.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('Agent Run') && value.includes('4 loaded / 4 reported'));
    setup.mockInput.pressKey('1');
    const frame = await setup.waitForFrame(value => value.includes('Inspect execution history') && value.includes('Index repository'));
    const rows = frame.split('\n'), start = rows.findIndex(row => row.slice(0, 38).includes('Inspect execution history'));
    const item = rows.slice(start, start + 4).map(row => row.slice(0, 38)).join('\n');
    for (const value of ['claude-sonnet-5-5', 'reasoning high', 'long-folder-name-1234', '3m 12s', 'Read history']) assert.ok(item.includes(value), value);
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('updated requested reasoning appears on the next observation', async () => {
  const setup = await createTestRenderer({ width: 200, height: 40 }), demo = createDemoClient();
  let effort = 'low';
  const client: ObservationClient = {
    async read(resource, params, signal) {
      const result = await demo.read(resource, params, signal);
      if (resource !== 'run.agents' || !result.data) return result;
      const data = result.data as { items: Record<string, unknown>[] };
      return { ...result, data: { ...data, items: data.items.map(item => item.agent_id === 'demo-inspect' ? { ...item, effort } : item) } };
    },
    close: () => demo.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('Agent Run') && value.includes('4 loaded / 4 reported'));
    setup.mockInput.pressKey('1');
    await setup.waitForFrame(value => value.includes('reasoning low'));
    effort = 'high';
    setup.mockInput.pressKey('r');
    const frame = await setup.waitForFrame(value => value.includes('reasoning high'));
    assert.doesNotMatch(frame.split('\n').slice(4, 10).join('\n'), /reasoning low/);
    setup.mockInput.pressKey('d');
    await setup.waitForFrame(value => value.includes('Requested reasoning: high'));
  } finally { unmount(); await client.close(); await setup.dispose(); }
});
