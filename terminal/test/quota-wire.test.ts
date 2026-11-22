/** The real observer reads a synthetic Quota socket with explicit server-UID trust. */
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { createNativeClient, observerPath } from './native-observer-harness.ts';

const binary = process.env.AGENT_HUB_TEST_OBSERVER ?? observerPath();

test('observer validates Quota socket identity and envelope', async () => {
  const directory = await mkdtemp(path.join(process.env.TMPDIR!, 'hub-quota-test-'));
  const socket = path.join(directory, 'quota.sock'), config = path.join(directory, 'connections.json');
  const snapshot = JSON.parse(await readFile(new URL('./fixtures/quota-snapshot-v2.json', import.meta.url), 'utf8'));
  const requests: Record<string, unknown>[] = [];
  const server = net.createServer(connection => {
    let input = '';
    connection.on('data', chunk => {
      input += chunk.toString();
      if (!input.includes('\n')) return;
      const request = JSON.parse(input.split('\n')[0]!);
      requests.push(request);
      const reply = request.method === 'status' ? { version: 1, result: { status: 'running', external_collection: [] } }
        : Array.isArray(request.accounts) && request.accounts.includes('missing') ? { version: 1, error: 'unknown_account' }
          : Array.isArray(request.accounts) && request.accounts.includes('secret') ? { version: 1, error: 'PRIVATE detail' }
            : snapshot;
      connection.end(JSON.stringify(reply) + '\n');
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  await chmod(socket, 0o660);
  const uid = process.getuid!();
  const previous = process.env.AGENT_HUB_CONFIG;
  process.env.AGENT_HUB_CONFIG = config;
  const client = createNativeClient(binary);
  try {
    await writeFile(config, JSON.stringify({ schema_version: 1, quota: { socket, server_uid: uid } }));
    const read = await client.read('quota.snapshot');
    assert.equal(read.outcome, 'ok');
    assert.deepEqual(read.data, snapshot.result);
    assert.deepEqual(requests.at(-1), { version: 1, method: 'snapshot', accounts: [] });
    assert.equal((await client.read('quota.status')).outcome, 'ok');
    assert.deepEqual(requests.at(-1), { version: 1, method: 'status', accounts: [] });
    const missing = await client.read('quota.snapshot', { accounts: ['missing'] });
    assert.equal(missing.outcome, 'missing');
    assert.equal(missing.error?.code, 'quota_unknown_account');
    const hidden = await client.read('quota.snapshot', { accounts: ['secret'] });
    assert.equal(hidden.error?.code, 'quota_source_error');
    assert.doesNotMatch(JSON.stringify(hidden), /PRIVATE/);
    assert.equal((await client.read('quota.status', { accounts: [] })).error?.code, 'quota_params');
    assert.equal((await client.read('quota.snapshot', { socket: '/x' })).error?.code, 'authority_denied');
    await writeFile(config, JSON.stringify({ schema_version: 1, quota: { socket, server_uid: uid + 1 } }));
    assert.equal((await client.read('quota.snapshot')).error?.code, 'quota_endpoint_identity');
    await writeFile(config, JSON.stringify({ schema_version: 1, quota: { socket } }));
    assert.equal((await client.read('quota.snapshot')).error?.code, 'quota_config_incomplete');
    await chmod(socket, 0o666);
    await writeFile(config, JSON.stringify({ schema_version: 1, quota: { socket, server_uid: uid } }));
    assert.equal((await client.read('quota.snapshot')).error?.code, 'quota_endpoint_identity', 'world-accessible socket is refused');
  } finally {
    if (previous === undefined) delete process.env.AGENT_HUB_CONFIG; else process.env.AGENT_HUB_CONFIG = previous;
    await client.close(); server.close(); await rm(directory, { recursive: true, force: true });
  }
});
