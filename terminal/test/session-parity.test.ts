/** Verifies project grouping and nullable native usage against synthetic Run observations. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestRenderer } from '@opentui/core/testing';
import { runAgent } from '../../src/live/protocol.ts';
import { createDemoClient } from '../src/demo.ts';
import { mountHub } from '../src/hub.ts';
import { agentWorkdir, projectRoot, sessionUsage } from '../src/sessions.ts';
import type { ObservationClient } from '../src/api.ts';

test('project grouping keeps source paths separate from task-derived fallbacks', () => {
  assert.equal(projectRoot('/repo/project/.claude/worktrees/one'), '/repo/project');
  assert.equal(projectRoot('/repo/project/.worktrees/two'), '/repo/project');
  assert.equal(projectRoot('/repo/project/worktrees/three/subdir'), '/repo/project');
  const agent = runAgent({ agent_id: 'fixture', sequence: 1, status: 'running', task_summary: 'Workdir: /repo/project/.worktrees/two.' });
  assert.deepEqual(agentWorkdir(agent), { path: '/repo/project/.worktrees/two', inferred: true });
  assert.deepEqual(agentWorkdir({ ...agent, workdir: '/reported' }), { path: '/reported', inferred: false });
});

test('native usage retains unknown values and does not label incomplete totals as complete', () => {
  const base = { agent_id: 'fixture', sequence: 1, status: 'running' };
  assert.equal(sessionUsage(runAgent(base)), '');
  const usage = { input_tokens: 10, output_tokens: null, cache_read_tokens: 0, cost_usd: null, num_turns: 2 };
  const tools = { calls: 4, failed: null, unknown_results: 1 };
  const value = sessionUsage(runAgent({ ...base, usage, tool_counts: tools, usage_cumulative: { executions: 2, cost_usd: null, total_tokens: null, input_tokens: null } }));
  assert.match(value, /in 10 · out — · cache 0 · \$— · turns 2/);
  assert.match(value, /tools 4 · — failed · 1 unknown/);
  assert.doesNotMatch(value, /Σ/);
  const complete = sessionUsage(runAgent({ ...base, usage, usage_cumulative: { executions: 2, cost_usd: 1.5, input_tokens: 20 } }));
  assert.match(complete, /Σ 2 runs \$1\.50/);
});

test('project picker groups loaded worktrees without changing literal folder filtering', async () => {
  const setup = await createTestRenderer({ width: 160, height: 40 }), demo = createDemoClient();
  const client: ObservationClient = {
    async read(resource, params, signal) {
      const result = await demo.read(resource, params, signal);
      if (resource !== 'run.agents' || !result.data) return result;
      const data = result.data as { items: Record<string, unknown>[] };
      const paths: Record<string, string | null> = { 'demo-inspect': '/repo/project/.claude/worktrees/one', 'demo-index': '/repo/project/worktrees/two', 'demo-finished': null, 'demo-failed': '/repo/other' };
      return { ...result, data: { ...data, items: data.items.map(item => ({ ...item, workdir: paths[String(item.agent_id)], ...(item.agent_id === 'demo-finished' ? { task_summary: 'Workdir: /repo/project/.worktrees/three.' } : {}) })) } };
    },
    close: () => demo.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'demo', () => {});
  try {
    await setup.waitForFrame(value => value.includes('4 loaded / 4 reported'));
    setup.mockInput.pressKey('1'); await setup.waitForFrame(value => value.includes('Index repository'));
    setup.mockInput.pressKey('o'); setup.mockInput.pressKey('p');
    const picker = await setup.waitForFrame(value => value.includes('Project: /repo/project'));
    const row = picker.split('\n').findIndex(line => line.includes('Project: /repo/project'));
    await setup.mockMouse.click(picker.split('\n')[row].indexOf('Project: /repo/project') + 2, row);
    const filtered = await setup.waitForFrame(value => value.includes('Project: /repo/project') && value.includes('Review saved output'));
    assert.match(filtered, /Inspect execution history/);
    assert.match(filtered, /Index repository/);
    assert.doesNotMatch(filtered, /Inspect failed observation/);
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('a long-running session remains visible behind a full page of newer finished sessions', async () => {
  const setup = await createTestRenderer({ width: 160, height: 40 }), demo = createDemoClient();
  const client: ObservationClient = {
    async read(resource, params = {}, signal) {
      const result = await demo.read(resource, params, signal);
      if (resource !== 'run.agents' || !result.data) return result;
      const page = result.data as { items: Record<string, unknown>[] }, sample = page.items[0];
      const items = params.active === true ? [{ ...sample, agent_id: 'old-running', name: 'Old running session', status: 'running' }] : Array.from({ length: 200 }, (_, index) => ({ ...sample, agent_id: `finished-${index}`, name: `Finished ${index}`, status: 'succeeded' }));
      return { ...result, data: { ...page, items, total: params.active === true ? 1 : 201, next_offset: params.active === true ? null : 200, complete: params.active === true, revision: 42 } };
    },
    close: () => demo.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'demo', () => {});
  try {
    await setup.waitForFrame(value => value.includes('Agent Run'));
    setup.mockInput.pressKey('1');
    const frame = await setup.waitForFrame(value => value.includes('Old running session') && value.includes('▸ Finished  200'));
    assert.match(frame, /201 loaded \/ 201 reported/);
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('a newer live snapshot remains usable when the inventory revision changes between reads', async () => {
  const setup = await createTestRenderer({ width: 160, height: 40 }), demo = createDemoClient();
  const client: ObservationClient = {
    async read(resource, params = {}, signal) {
      const result = await demo.read(resource, params, signal);
      if (resource !== 'run.agents' || !result.data) return result;
      const page = result.data as { items: Record<string, unknown>[] }, sample = page.items[0];
      const items = params.active === true ? [{ ...sample, agent_id: 'still-running', name: 'Still running', status: 'running' }] : [{ ...sample, agent_id: 'old-running', name: 'Old snapshot', status: 'running' }];
      return { ...result, data: { ...page, items, total: 1, next_offset: null, complete: true, revision: params.active === true ? 43 : 42 } };
    },
    close: () => demo.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'demo', () => {});
  try {
    await setup.waitForFrame(value => value.includes('Agent Run'));
    setup.mockInput.pressKey('1');
    const frame = await setup.waitForFrame(value => value.includes('Still running'));
    assert.doesNotMatch(frame, /Old snapshot/);
  } finally { unmount(); await client.close(); await setup.dispose(); }
});
