/** Exercises the real finite observer against isolated synthetic socket/CLI sources. */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { createNativeClient, observerPath } from './native-observer-harness.ts';
import type { Resource } from '../src/api.ts';

/** Waits for a fixture file without inspecting unrelated processes or sources. */
async function waitForFile(file: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { return await readFile(file, 'utf8'); } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  throw new Error('fixture did not start');
}

type Json = Record<string, any>;

const binary = process.env.AGENT_HUB_TEST_OBSERVER ?? observerPath();

test('closed observer reads, validates and cancels only its own sources', async () => {
  const temp = process.env.TMPDIR;
  assert.ok(binary && path.isAbsolute(binary));
  assert.ok(temp && path.isAbsolute(temp));
  assert.equal(observerPath(temp), path.join(temp, 'debug', process.platform === 'win32' ? 'agent-hub-observer.exe' : 'agent-hub-observer'));
  const directory = await mkdtemp(path.join(temp, 'hub-observer-test-'));
  const socket = path.join(directory, 'run.sock');
  const helper = path.join(directory, 'bridge-fixture.cjs');
  const poolHelper = path.join(directory, 'pool-fixture');
  const poolConfig = path.join(directory, 'pool-observer.toml');
  const unconfiguredHelper = path.join(directory, 'bridge-unconfigured');
  const helperPid = path.join(directory, 'helper.pid');
  const config = path.join(directory, 'connections.json');
  const calls: string[] = [];
  let largeIdentity = false, statusSupported = true, exactSupported = true, initialTaskAdvertised = true, capabilityFlagAccepted = true;
  const capabilityParams: unknown[] = [];
  const server = net.createServer(connection => {
    let input = '';
    connection.on('data', chunk => {
      input += chunk.toString();
      if (!input.includes('\n')) return;
      const request = JSON.parse(input.split('\n')[0]!);
      calls.push(request.method);
      if (request.method === 'transcript' && request.params?.view === 'blocks') { connection.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: "unknown field 'view' · PRIVATE" } }) + '\n'); return; }
      if (request.method === 'status' && !statusSupported) { connection.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'method not found' } }) + '\n'); return; }
      if (request.method === 'transcript_exact' && !exactSupported) { connection.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'method not found' } }) + '\n'); return; }
      if (request.method === 'status' && request.params?.expected_store_id === `store_${'f'.repeat(32)}`) { connection.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'PRIVATE', data: { code: 'StoreIdentityMismatch' } } }) + '\n'); return; }
      if (request.method === 'capabilities') capabilityParams.push(request.params);
      if (request.method === 'capabilities' && request.params?.include_initial_task && !capabilityFlagAccepted) { connection.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'unknown field include_initial_task · PRIVATE' } }) + '\n'); return; }
      const padding = largeIdentity ? 'x'.repeat(700_000) : '';
      const result = request.method === 'ping' ? { ok: true, padding }
        : request.method === 'tools' ? [{ name: 'capabilities', padding }, { name: 'answer_chunk' }, ...(initialTaskAdvertised ? [{ name: 'initial_task' }] : [])]
          : request.method === 'capabilities' ? { version: 'fixture', padding, ...(request.params?.include_initial_task ? { initial_task: { version: 1, method: 'initial_task', modes: ['strict', 'current'], max_task_bytes: 524288, max_page_bytes: 65536 } } : {}) }
            : request.method === 'list_agents' ? { items: [], offset: 0, limit: 200, total: 0, next_offset: null, complete: true, revision: 1, message_revision: 1, observed_at: 100 }
              : request.method === 'status' ? { agent_id: request.params.agent_id, sequence: 1, status: 'running', received: request.params }
              : request.method === 'transcript_exact' || request.method === 'initial_task' ? { received: request.params }
              : request.method === 'answer_chunk' ? { agent_id: 'fixture', sequence: 1, content: 'ok' }
                : request.method === 'answer' ? { value: 'x'.repeat(1_048_450) }
                : null;
      connection.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  await chmod(socket, 0o600);
  await writeFile(helper, `#!/usr/bin/env node\nconst fs = require('node:fs');\nlet input = '';\nprocess.stdin.on('data', c => input += c);\nprocess.stdin.on('end', () => {\n  const request = JSON.parse(input);\n  if (request.params.hold) { process.on('SIGINT', () => {}); process.on('SIGTERM', () => {}); fs.writeFileSync(${JSON.stringify(helperPid)}, String(process.pid)); setInterval(() => {}, 1000); return; }\n  const value = request.params.null_error ? {schema_version:1,kind:'bridge_overview',error:null} : {schema_version:1,kind:'bridge_overview',data:{coverage:'retained_history'}};\n  process.stdout.write(JSON.stringify(value) + '\\n');\n});\n`, { mode: 0o700 });
  await writeFile(unconfiguredHelper, `#!/usr/bin/env node\nprocess.stdin.resume();\nprocess.stdin.on('end', () => { process.stdout.write(JSON.stringify({schema_version:1,kind:'bridge_overview',error:{code:'observer_unconfigured',outcome:'blocked',detail:'private text'}})+'\\n'); process.exitCode=2; });\n`, { mode: 0o700 });
  await writeFile(poolHelper, `#!/usr/bin/env node\nlet input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const request=JSON.parse(input);const kind=request.operation==='identity'?'identity':request.operation==='list'?'pool_page':request.operation==='inventory_snapshot'?'inventory_snapshot':request.params.section==='run_proof'?'run_proof':'pool_detail';if(request.params.stale){process.stdout.write(JSON.stringify({schema_version:1,kind,error:{code:'stale',outcome:'blocked',detail:'PRIVATE-STALE'}})+'\\n');process.exitCode=2;return;}process.stdout.write(JSON.stringify({schema_version:1,kind,data:{params:request.params,args:process.argv.slice(2)}})+'\\n');});\n`, { mode: 0o700 });
  await writeFile(config, JSON.stringify({ schema_version: 1, run: { socket }, bridge: { program: helper } }));
  const previous = process.env.AGENT_HUB_CONFIG;
  process.env.AGENT_HUB_CONFIG = config;
  const client = createNativeClient(binary);
  try {
    const identity = await client.read('run.identity');
    assert.equal(identity.outcome, 'ok');
    assert.deepEqual(calls.slice(0, 3), ['ping', 'tools', 'capabilities']);
    assert.equal((identity.data as { version: string }).version, 'fixture');
    assert.equal((await client.read('run.agents', { limit: 200, offset: 0 })).outcome, 'ok');
    assert.equal((await client.read('run.status', { agent_id: 'fixture' })).outcome, 'ok');
    const statusV1 = { version: 1, expected_store_id: `store_${'1'.repeat(32)}`, targets: [{ agent_id: 'fixture', sequence: 1, execution_ref: `ex1_${'a'.repeat(64)}`, pin_id: 'pin_123e4567e89b42d3a456426614174000' }], include_view: true };
    const observedStatus = await client.read('run.status', statusV1);
    assert.equal(observedStatus.outcome, 'ok');
    assert.deepEqual((observedStatus.data as { received: unknown }).received, statusV1);
    const wrongStore = await client.read('run.status', { ...statusV1, expected_store_id: `store_${'f'.repeat(32)}` });
    assert.equal(wrongStore.error?.code, 'run_source_error');
    assert.ok(!JSON.stringify(wrongStore).includes('PRIVATE'));
    statusSupported = false;
    assert.equal((await client.read('run.status', { agent_id: 'fixture' })).error?.code, 'run_method_unavailable');
    statusSupported = true;
    const exactRequest = { version: 1, expected_store_id: `store_${'1'.repeat(32)}`, selector: statusV1.targets[0], cursor: '9007199254740993', upper_seq: '9007199254740995', offset: 0 };
    const exactResponse = await client.read('run.transcript_exact', exactRequest);
    assert.equal(exactResponse.outcome, 'ok');
    assert.deepEqual((exactResponse.data as { received: unknown }).received, exactRequest);
    exactSupported = false;
    assert.equal((await client.read('run.transcript_exact', exactRequest)).error?.code, 'run_method_unavailable');
    exactSupported = true;
    assert.deepEqual(capabilityParams.slice(0, 1), [{ include_initial_task: true }], 'capabilities asks for the optional entry only because tools advertises initial_task');
    assert.equal(((identity.data as Json).capabilities as Json).initial_task.version, 1);
    const taskRequest = { version: 1, mode: 'current', agent_id: 'fixture', offset: 0, max_bytes: 65536 };
    const task = await client.read('run.initial_task', taskRequest);
    assert.equal(task.outcome, 'ok');
    assert.deepEqual((task.data as { received: unknown }).received, taskRequest, 'the closed request reaches Run unchanged');
    for (const params of [{ ...taskRequest, mode: 'loose' }, { ...taskRequest, pin_id: null }, { ...taskRequest, task: 'x' }, { ...taskRequest, agent_id: '' }]) {
      assert.equal((await client.read('run.initial_task', params)).error?.code, 'initial_task_params');
    }
    assert.equal((await client.read('run.initial_task', { ...taskRequest, command: 'x' })).error?.code, 'authority_denied');
    capabilityParams.length = 0; initialTaskAdvertised = false;
    assert.equal((await client.read('run.identity')).outcome, 'ok');
    assert.deepEqual(capabilityParams, [{}], 'a Run whose tools omit initial_task gets the plain capabilities call');
    assert.equal((((await client.read('run.identity')).data as Json).capabilities as Json).initial_task, undefined);
    initialTaskAdvertised = true; capabilityFlagAccepted = false; capabilityParams.length = 0;
    const fallback = await client.read('run.identity');
    assert.equal(fallback.outcome, 'ok', 'a Run that rejects the optional flag still reports identity');
    assert.deepEqual(capabilityParams, [{ include_initial_task: true }, {}]);
    assert.equal(((fallback.data as Json).capabilities as Json).initial_task, undefined);
    assert.ok(!JSON.stringify(fallback).includes('PRIVATE'));
    capabilityFlagAccepted = true;
    assert.equal((await client.read('run.answer_chunk', { agent_id: 'fixture', sequence: 1 })).outcome, 'ok');
    const legacy = await client.read('run.transcript', { agent_id: 'fixture', view: 'blocks' });
    assert.equal(legacy.error?.code, 'run_blocks_unsupported');
    assert.ok(!JSON.stringify(legacy).includes('PRIVATE'));
    const nearLimit = await client.read('run.answer', { agent_id: 'fixture' });
    assert.equal((nearLimit.data as { value: string }).value.length, 1_048_450);
    largeIdentity = true;
    const combined = await client.read('run.identity');
    assert.equal(combined.outcome, 'ok');
    assert.ok(Buffer.byteLength(JSON.stringify(combined)) > 2 * 1024 * 1024);
    largeIdentity = false;

    const uid = process.getuid?.();
    assert.ok(uid !== undefined);
    await chmod(socket, 0o770);
    assert.equal((await client.read('run.agents', { limit: 200, offset: 0 })).error?.code, 'run_endpoint_identity', 'private mode rejects a group-accessible socket');
    await writeFile(config, JSON.stringify({ schema_version: 1, run: { socket, broker_uid: uid }, bridge: { program: helper } }));
    assert.equal((await client.read('run.agents', { limit: 200, offset: 0 })).outcome, 'ok', 'an explicit matching broker UID permits the shared socket');
    assert.equal((await client.read('run.identity')).outcome, 'ok', 'identity discovery uses the same trusted broker');
    const privateOverride = createNativeClient(binary, { socket });
    const sharedOverride = createNativeClient(binary, { socket, brokerUid: uid });
    try {
      assert.equal((await privateOverride.read('run.agents', { limit: 200, offset: 0 })).error?.code, 'run_endpoint_identity', 'an override without UID does not inherit trust from the configured socket');
      assert.equal((await sharedOverride.read('run.agents', { limit: 200, offset: 0 })).outcome, 'ok', 'an explicit session override can select the shared broker');
      await writeFile(config, JSON.stringify({ schema_version: 1, run: { socket: path.join(directory, 'missing.sock'), broker_uid: uid } }));
      const configured = await readFile(config, 'utf8');
      assert.equal((await sharedOverride.read('run.agents', { limit: 200, offset: 0 })).outcome, 'ok', 'the session socket overrides the configured path');
      assert.equal(await readFile(config, 'utf8'), configured, 'session overrides never rewrite saved connections');
    } finally { await privateOverride.close(); await sharedOverride.close(); }
    await writeFile(config, JSON.stringify({ schema_version: 1, run: { socket, broker_uid: uid === 0 ? 1 : 0 } }));
    assert.equal((await client.read('run.agents', { limit: 200, offset: 0 })).error?.code, 'run_endpoint_identity', 'the configured broker must own the socket');
    await writeFile(config, JSON.stringify({ schema_version: 1, run: { socket, broker_uid: uid } }));
    await chmod(socket, 0o777);
    assert.equal((await client.read('run.agents', { limit: 200, offset: 0 })).error?.code, 'run_endpoint_identity', 'shared mode still rejects world-accessible sockets');
    await chmod(socket, 0o770);
    await chmod(directory, 0o720);
    assert.equal((await client.read('run.agents', { limit: 200, offset: 0 })).error?.code, 'run_endpoint_parent', 'shared socket directory cannot be group-writable');
    await chmod(directory, 0o700);
    const link = path.join(directory, 'run-link.sock');
    await symlink(socket, link);
    await writeFile(config, JSON.stringify({ schema_version: 1, run: { socket: link, broker_uid: uid } }));
    assert.equal((await client.read('run.agents', { limit: 200, offset: 0 })).error?.code, 'run_endpoint_identity', 'shared endpoints cannot be symbolic links');
    await writeFile(config, JSON.stringify({ schema_version: 1, run: { broker_uid: uid } }));
    assert.equal((await client.read('run.agents', { limit: 200, offset: 0 })).error?.code, 'run_broker_socket_required');
    for (const broker_uid of [-1, 1.5, 4_294_967_296, '1000']) {
      await writeFile(config, JSON.stringify({ schema_version: 1, run: { socket, broker_uid } }));
      assert.equal((await client.read('run.agents', { limit: 200, offset: 0 })).error?.code, 'config_json');
    }
    await chmod(socket, 0o600);
    await writeFile(config, JSON.stringify({ schema_version: 1, run: { socket }, bridge: { program: helper } }));

    const callCount = calls.length;
    const denied = await client.read('run.agents', { nested: { command: 'not allowed' } });
    assert.equal(denied.outcome, 'invalid');
    assert.equal(denied.error?.code, 'authority_denied');
    assert.equal((await client.read('run.agents', { nested: { broker_uid: uid } })).error?.code, 'authority_denied');
    assert.equal(calls.length, callCount);
    const outside = await client.read('tasks.peek' as Resource);
    assert.equal(outside.outcome, 'invalid');
    assert.equal(outside.error?.code, 'resource_denied');

    const bridge = await client.read('bridge.overview');
    assert.equal(bridge.outcome, 'ok', JSON.stringify(bridge));
    const malformed = await client.read('bridge.overview', { null_error: true });
    assert.equal(malformed.outcome, 'invalid');
    assert.equal(malformed.error?.code, 'source_envelope');
    await writeFile(config, JSON.stringify({ schema_version: 1, run: { socket }, bridge: { program: unconfiguredHelper } }));
    const unconfigured = await client.read('bridge.overview');
    assert.equal(unconfigured.error?.code, 'observer_unconfigured');
    assert.equal(unconfigured.error?.message, 'Observer access is not configured.');
    await writeFile(config, JSON.stringify({ schema_version: 1, run: { socket }, bridge: { program: helper } }));

    await writeFile(config, JSON.stringify({ schema_version: 1, run: { socket }, bridge: { program: helper }, pool: { program: poolHelper, config: poolConfig } }));
    const exact = '9007199254740993';
    const pool = await client.read('pool.get', { pool_id: 'fixture', section: 'history', direction: 'forward', after: exact, through: exact });
    assert.equal(pool.outcome, 'ok');
    const poolData = (pool.data as { data: { params: Record<string, unknown>; args: string[] } }).data;
    assert.equal(poolData.params.after, exact);
    assert.equal(poolData.params.through, exact);
    assert.deepEqual(poolData.args, ['observe', '--config', poolConfig]);
    assert.equal((await client.read('pool.list')).outcome, 'ok');
    assert.equal((await client.read('pool.identity')).outcome, 'ok');
    const proofParams = { pool_id: 'fixture', section: 'run_proof', member_id: 'member', expected_revision: 1 };
    const proof = await client.read('pool.run_proof', proofParams);
    assert.equal(proof.outcome, 'ok');
    assert.equal((proof.data as { kind: string }).kind, 'run_proof');
    assert.deepEqual((proof.data as { data: { params: unknown } }).data.params, proofParams);
    assert.equal((await client.read('pool.get', proofParams)).error?.code, 'source_kind');
    for (const params of [{ ...proofParams, section: 'members' }, { ...proofParams, expected_revision: 0 }, { ...proofParams, after: 0 }]) {
      assert.equal((await client.read('pool.run_proof', params)).error?.code, 'pool_proof_params');
    }
    const snapshot = { filter: 'all', limit: 1 };
    assert.equal((await client.read('pool.inventory_snapshot', snapshot)).outcome, 'ok');
    const stale = await client.read('pool.inventory_snapshot', { ...snapshot, stale: true });
    assert.equal(stale.error?.code, 'pool_inventory_params', 'unknown parameters never reach the producer');
    await writeFile(config, JSON.stringify({ schema_version: 1, run: { socket }, bridge: { program: helper }, pool: { program: poolHelper, config: poolConfig } }));
    const staleGet = await client.read('pool.get', { pool_id: 'fixture', section: 'history', stale: true });
    assert.equal(staleGet.outcome, 'unavailable');
    assert.equal(staleGet.error?.code, 'stale', 'a producer stale error is distinguishable from a generic source error');
    assert.ok(!JSON.stringify(staleGet).includes('PRIVATE-STALE'));
    assert.equal((await client.read('run.pool' as Resource)).error?.code, 'resource_denied');
    assert.equal((await client.read('pool.get', { nested: { assertion: 'not allowed' } })).error?.code, 'authority_denied');

    const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'ignore'], env: process.env });
    child.stdin.write(JSON.stringify({ resource: 'run.identity', params: {} }) + '\n');
    const [exitCode] = await once(child, 'close');
    assert.equal(exitCode, 0, 'successful adapter must exit even while parent stdin stays open');
    child.stdin.destroy();

    const abort = new AbortController();
    const pending = client.read('bridge.overview', { hold: true }, abort.signal);
    const pid = Number(await waitForFile(helperPid));
    abort.abort();
    assert.equal((await pending).error?.code, 'cancelled');
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'cancelled helper must be reaped');

    await rm(helperPid);
    const clientUrl = new URL('./native-observer-harness.ts', import.meta.url).href;
    const program = `import { createNativeClient } from ${JSON.stringify(clientUrl)}; const client = createNativeClient(${JSON.stringify(binary)}); process.on('SIGINT', () => { void client.close(); }); await client.read('bridge.overview', { hold: true });`;
    const frontend = spawn(process.execPath, ['--input-type=module', '-e', program], { stdio: 'ignore', detached: true, env: process.env });
    let secondPid: number | undefined;
    try {
      secondPid = Number(await waitForFile(helperPid));
      assert.ok(frontend.pid);
      process.kill(-frontend.pid, 'SIGINT');
      const [frontendExit] = await once(frontend, 'close');
      assert.equal(frontendExit, 0);
      assert.throws(() => process.kill(secondPid!, 0), { code: 'ESRCH' }, 'group SIGINT must still reap the observer helper');
    } finally {
      if (frontend.exitCode === null && frontend.signalCode === null) frontend.kill('SIGKILL');
      if (secondPid) { try { process.kill(secondPid, 'SIGKILL'); } catch { /* Already reaped. */ } }
    }
  } finally {
    await client.close();
    if (previous === undefined) delete process.env.AGENT_HUB_CONFIG; else process.env.AGENT_HUB_CONFIG = previous;
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true });
  }
});

test('a FIFO config cannot keep the finite observer alive after its deadline', { timeout: 22_000 }, async () => {
  const temp = process.env.TMPDIR;
  assert.ok(temp && path.isAbsolute(temp));
  const directory = await mkdtemp(path.join(temp, 'hub-config-test-'));
  const fifo = path.join(directory, 'config-fifo');
  execFileSync('/usr/bin/mkfifo', [fifo]);
  const previous = process.env.AGENT_HUB_CONFIG;
  process.env.AGENT_HUB_CONFIG = fifo;
  const client = createNativeClient(binary);
  try {
    const result = await client.read('run.agents');
    assert.equal(result.outcome, 'unavailable');
    assert.equal(result.error?.code, 'config_timeout');
  } finally {
    await client.close();
    if (previous === undefined) delete process.env.AGENT_HUB_CONFIG; else process.env.AGENT_HUB_CONFIG = previous;
    await rm(directory, { recursive: true });
  }
});

test('cancelling the real observer stops a frontend descendant that holds stdout open', async () => {
  const temp = process.env.TMPDIR;
  assert.ok(temp && path.isAbsolute(temp));
  const directory = await mkdtemp(path.join(temp, 'hub-child-'));
  const helper = path.join(directory, 'frontend.cjs'), config = path.join(directory, 'connections.json'), marker = path.join(directory, 'child.pid');
  const previous = process.env.AGENT_HUB_CONFIG;
  const client = createNativeClient(binary);
  let descendant: number | undefined;
  try {
    const childScript = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000)`;
    await writeFile(helper, `#!/usr/bin/env node
const {spawn} = require('node:child_process');
process.stdin.resume();
process.stdin.once('end', () => {
  spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], {stdio: ['ignore', 'inherit', 'ignore']}).unref();
  process.exit(0);
});
`, { mode: 0o700 });
    await writeFile(config, JSON.stringify({ schema_version: 1, bridge: { program: helper } }));
    process.env.AGENT_HUB_CONFIG = config;
    const controller = new AbortController();
    const result = client.read('bridge.overview', {}, controller.signal);
    descendant = Number(await waitForFile(marker));
    controller.abort();
    assert.equal((await result).error?.code, 'cancelled');
    /** A reparented zombie has exited but may await the container's init. */
    const live = async (pid: number) => readFile('/proc/' + pid + '/status', 'utf8').then(
      status => !/^State:\s+Z/m.test(status), error => { if (error.code === 'ENOENT') return false; throw error; });
    for (let attempt = 0; attempt < 50 && await live(descendant); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(await live(descendant), false, 'the frontend group has no running descendant');
    descendant = undefined;
  } finally {
    if (descendant) { try { process.kill(descendant, 'SIGKILL'); } catch { /* Already stopped. */ } }
    await client.close();
    if (previous === undefined) delete process.env.AGENT_HUB_CONFIG; else process.env.AGENT_HUB_CONFIG = previous;
    await rm(directory, { recursive: true });
  }
});

test('server sweeps Bridge and Worktree descendants even with the real observer stopped', async () => {
  const { createNativeClient: createServerClient } = await import('../../server/src/observer.ts');
  const temp = process.env.TMPDIR;
  assert.ok(temp && path.isAbsolute(temp));
  const directory = await mkdtemp(path.join(temp, 'hub-group-'));
  const helper = path.join(directory, 'frontend.cjs'), config = path.join(directory, 'connections.json');
  const marker = path.join(directory, 'pids');
  const original = process.env.AGENT_HUB_CONFIG;
  const client = createServerClient(binary, { readMs: 5000, killMs: 150 });
  const owned: number[] = [];
  /** Checks whether a known fixture process can still run after group cleanup. */
  async function running(pid: number) {
    return readFile('/proc/' + pid + '/status', 'utf8').then(
      status => !/^State:\s+Z/m.test(status), error => { if (error.code === 'ENOENT') return false; throw error; });
  }
  try {
    await writeFile(helper, `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync(${JSON.stringify(marker)}, [process.ppid, process.pid, child.pid].join(' '));
process.stdin.resume();
setInterval(() => {}, 1000);
`, { mode: 0o700 });
    await writeFile(config, JSON.stringify({ schema_version: 1, bridge: { program: helper }, worktree: { program: helper } }));
    process.env.AGENT_HUB_CONFIG = config;
    for (const resource of ['bridge.overview', 'worktree.list'] as const) for (const stopped of [false, true]) {
      const controller = new AbortController();
      const result = client.read(resource, {}, controller.signal);
      const pids = (await waitForFile(marker)).split(' ').map(Number);
      owned.push(...pids);
      assert.equal(pids.length, 3);
      assert.ok(pids.every(pid => Number.isSafeInteger(pid) && pid > 1));
      if (stopped) process.kill(pids[0], 'SIGSTOP');
      controller.abort();
      assert.equal((await result).error?.code, 'cancelled');
      for (const pid of pids) {
        for (let attempt = 0; attempt < 50 && await running(pid); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(await running(pid), false, `${resource} fixture PID ${pid} survived ${stopped ? 'forced' : 'cooperative'} cleanup`);
      }
      owned.length = 0;
      await rm(marker);
    }
  } finally {
    for (const pid of owned) if (Number.isSafeInteger(pid) && pid > 1) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* Already stopped. */ }
    }
    await client.close();
    if (original === undefined) delete process.env.AGENT_HUB_CONFIG; else process.env.AGENT_HUB_CONFIG = original;
    await rm(directory, { recursive: true });
  }
});
