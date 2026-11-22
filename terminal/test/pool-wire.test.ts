/** Tests the real Pool observer candidate against a synthetic, private resident. */
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { createNativeClient } from './native-observer-harness.ts';
import { createDemoClient } from '../src/demo.ts';
import { poolInventory, poolSection, poolWindow } from '../src/pool.ts';
import type { Resource } from '../src/api.ts';

const poolBinary = process.env.AGENT_POOL_TEST_CANDIDATE;
const hubBinary = process.env.AGENT_HUB_TEST_OBSERVER;

test('Hub and the Pool candidate exchange only owner read requests over a synthetic resident', { skip: !poolBinary || !hubBinary }, async () => {
  assert.ok(poolBinary && path.isAbsolute(poolBinary) && hubBinary && path.isAbsolute(hubBinary));
  assert.ok(process.env.TMPDIR && path.isAbsolute(process.env.TMPDIR));
  const directory = await mkdtemp(path.join(process.env.TMPDIR, 'pool-wire-'));
  const socket = path.join(directory, 'pool.sock'), token = path.join(directory, 'observer.token'), poolConfig = path.join(directory, 'pool.toml'), hubConfig = path.join(directory, 'connections.json');
  const observed: Record<string, unknown>[] = [], demo = createDemoClient();
  await writeFile(token, 'synthetic-owner-token', { mode: 0o600 });
  const q = (value: string) => JSON.stringify(value);
  await writeFile(poolConfig, `socket_path=${q(socket)}\ndatabase_path=${q(path.join(directory, 'must-not-open.db'))}\nexpected_uid=${process.getuid!()}\nbridge_registration_socket=${q(path.join(directory, 'absent-register.sock'))}\nbridge_core_socket=${q(path.join(directory, 'absent-core.sock'))}\nbridge_credential_file=${q(path.join(directory, 'absent-bridge.token'))}\nbridge_producer_id="fixture"\nbridge_audience="fixture"\nowner_observer_credential_file=${q(token)}\n`, { mode: 0o600 });
  await writeFile(hubConfig, JSON.stringify({ schema_version: 1, pool: { program: poolBinary, config: poolConfig } }), { mode: 0o600 });
  const server = net.createServer(connection => {
    let input = '', handled = false;
    connection.on('data', chunk => {
      input += chunk.toString();
      if (handled || !input.includes('\n')) return;
      handled = true;
      void (async () => {
        try {
          const request = JSON.parse(input.split('\n')[0]);
          assert.equal(request.observer_credential, 'synthetic-owner-token');
          assert.equal(request.assertion, undefined);
          observed.push(request.observe);
          const operation = request.observe.operation as 'identity' | 'list' | 'get';
          const response = await demo.read(`pool.${operation}` as Resource, request.observe.params);
          connection.end(JSON.stringify(response.data) + '\n');
        } catch { connection.destroy(); }
      })();
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  await chmod(socket, 0o600);
  const previous = process.env.AGENT_HUB_CONFIG; process.env.AGENT_HUB_CONFIG = hubConfig;
  const client = createNativeClient(hubBinary);
  try {
    const identity = await client.read('pool.identity');
    assert.equal(identity.outcome, 'ok', JSON.stringify({ error: identity.error, requests: observed.length }));
    assert.ok(!JSON.stringify(identity).includes('synthetic-owner-token'));
    const inventory = await client.read('pool.list');
    assert.equal(inventory.outcome, 'ok');
    assert.equal(poolInventory(inventory.data, null).items.length, 1);
    const members = await client.read('pool.get', { pool_id: 'demo-pool', section: 'members', after: 0, include_bindings: true });
    assert.equal(members.outcome, 'ok');
    assert.equal(poolSection(members.data, 'demo-pool', 'members', 0, null).section, 'members');
    const history = await client.read('pool.get', { pool_id: 'demo-pool', section: 'history', direction: 'backward' });
    assert.equal(history.outcome, 'ok');
    assert.equal(poolWindow(history.data, 'demo-pool', 'backward', null, null).watermark, '1');
    assert.deepEqual(observed.map(value => value.operation), ['identity', 'list', 'get', 'get']);
  } finally {
    await client.close(); await demo.close();
    if (previous === undefined) delete process.env.AGENT_HUB_CONFIG; else process.env.AGENT_HUB_CONFIG = previous;
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true });
  }
});
