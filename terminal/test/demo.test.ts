/** Checks that explicitly selected demo observations satisfy the existing read contracts. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { answerText, bridgeData, runPage, transcriptPage } from '../../src/live/protocol.ts';
import { createDemoClient } from '../src/demo.ts';
import { exportHistory } from '../src/export.ts';
import { poolInventory, poolSection } from '../src/pool.ts';

test('demo observations are source-shaped and the finished answer has matching proof', async () => {
  const client = createDemoClient();
  const inventory = runPage((await client.read('run.agents')).data);
  assert.equal(inventory.items.length, 4);
  const complete = inventory.items.find(agent => agent.status === 'succeeded');
  assert.ok(complete?.answerSha);
  const history = transcriptPage((await client.read('run.transcript', { agent_id: complete.id, view: 'blocks', tail_blocks: 40 })).data, complete.id);
  assert.ok(history.blocks.some(block => block.role === 'tool'));
  const metadata = (await client.read('run.answer', { agent_id: complete.id })).data;
  const answer = await answerText(metadata, complete.id, complete.sequence, complete.answerSha, true, async () => { throw new Error('inline answer should not read chunks'); }, () => true);
  assert.match(answer!, /Synthetic result/);
  const pools = poolInventory((await client.read('pool.list')).data, null);
  assert.equal(pools.items.length, 1);
  assert.equal(poolSection((await client.read('pool.get', { pool_id: 'demo-pool', section: 'members' })).data, 'demo-pool', 'members', 0, null).section, 'members');
  assert.equal(bridgeData((await client.read('bridge.overview')).data, 'bridge_overview').coverage, 'retained_history');
  assert.equal(bridgeData((await client.read('bridge.incidents')).data, 'incident_page').coverage, 'retained_history');
  assert.match(await exportHistory(client, { kind: 'session', id: complete.id }), /retained logical session history across executions/);
  assert.match(await exportHistory(client, { kind: 'pool', id: 'demo-pool' }), /Synthetic discussion/);
  await client.close();
  assert.equal((await client.read('run.agents')).error?.code, 'cancelled');
});
