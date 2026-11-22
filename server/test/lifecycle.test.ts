/** End-to-end Unix HTTP and synthetic subprocess ownership acceptance. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, chown, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { API_RESPONSES, event } from '@agent-hub/domain';
import { createHttp } from '../src/http.ts';
import { listen } from '../src/main.ts';
import { createNativeClient } from '../src/observer.ts';

/** Creates a task-local fake observer that reports its PID before responding or hanging. */
async function fakeObserver(directory: string) {
  const executable = join(directory, 'observer');
  const pids = join(directory, 'pids');
  const release = join(directory, 'release');
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
let input = '', active = false, timer;
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  if (active || !input.includes('\\n')) return;
  active = true;
  const { resource, params } = JSON.parse(input);
  fs.appendFileSync(${JSON.stringify(pids)}, process.pid + ' ' + (params.mode ?? 'normal') + '\\n');
  if (params.mode === 'hung') { setInterval(() => {}, 1000); return; }
  if (params.mode === 'abort') { timer = setInterval(() => {}, 1000); return; }
  if (params.mode === 'crash') process.exit(8);
  timer = setInterval(() => {
    if (!fs.existsSync(${JSON.stringify(release)})) return;
    const data = { items: [], offset: 0, limit: params.limit ?? 200, total: 0, next_offset: null, complete: true, revision: 7, message_revision: 9, observed_at: 1730000000 };
    process.stdout.write(JSON.stringify({ schema_version: 1, source: resource.split('.')[0], resource, data, outcome: 'ok', observed_at_ms: Date.now(), error: null }) + '\\n', () => process.exit(0));
    clearInterval(timer);
  }, 5);
});
process.stdin.on('end', () => {
  if (input.includes('"mode":"hung"')) return;
  clearInterval(timer);
  process.exit(0);
});
`, { mode: 0o700 });
  return { executable, pids, release };
}

/** Waits briefly for an owned process to signal admission through its PID marker. */
async function readPids(path: string, count: number): Promise<number[]> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const data = await readFile(path, 'utf8').catch(() => '');
    const pids = data.trim().split('\n').filter(Boolean).map(line => Number(line.split(' ')[0]));
    if (pids.length >= count) return pids;
    await delay(10);
  }
  throw new Error('Expected observer processes did not start.');
}

/** Confirms a PID can no longer be signaled after the adapter promises completion. */
function reaped(pid: number): void {
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
}

/** Uses independent native Unix connections for HTTP requests. */
function local(socket: string, route: string, options: RequestInit = {}): Promise<Response> {
  const init = { ...options, unix: socket };
  return fetch('http://localhost/api/v1' + route, init);
}

/** Mirrors the service-owned mode and primary group even under a setgid scratch parent. */
async function unixDirectory(): Promise<string> {
  const directory = await mkdtemp(join(process.env.TMPDIR!, 'u-'));
  await chown(directory, process.getuid!(), process.getgid!());
  await chmod(directory, 0o750);
  return directory;
}

test('Unix clients share identical source reads and two streams share one poll', async () => {
  const directory = await unixDirectory();
  const fake = await fakeObserver(directory);
  const native = createNativeClient(fake.executable, { readMs: 3000, killMs: 100 });
  const http = createHttp(native, { localHost: 'localhost', webRoot: directory, release: 'test' });
  const socket = join(directory, 'http.sock');
  const listener = await listen(http, { unix: socket });
  try {
    assert.equal((await lstat(socket)).mode & 0o777, 0o660);
    const first = local(socket, '/sessions'), second = local(socket, '/sessions');
    void first.catch(() => {});
    void second.catch(() => {});
    const [initial] = await readPids(fake.pids, 1);
    await delay(30);
    assert.equal((await readPids(fake.pids, 1)).length, 1);
    await writeFile(fake.release, '');
    for (const response of await Promise.all([first, second])) {
      assert.equal(response.status, 200);
      API_RESPONSES.sessions(await response.json());
    }
    reaped(initial);
    await rm(fake.release);
    const responses = await Promise.all([local(socket, '/events?topic=sessions'), local(socket, '/events?topic=sessions')]);
    const readers = responses.map(response => response.body!.getReader());
    for (const reader of readers) {
      const frame = new TextDecoder().decode((await reader.read()).value);
      assert.equal(event(JSON.parse(frame.split('\ndata: ')[1])).type, 'ready');
    }
    const admitted = await readPids(fake.pids, 2);
    assert.equal(admitted.length, 2);
    await writeFile(fake.release, '');
    for (const reader of readers) {
      const decoder = new TextDecoder();
      let buffer = '';
      const types: string[] = [];
      while (types.length < 2) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        buffer += decoder.decode(chunk.value, { stream: true });
        for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const value = event(JSON.parse(frame.split('\ndata: ')[1]));
          assert.equal(frame.startsWith('event: ' + value.type), true);
          types.push(value.type);
        }
      }
      assert.deepEqual(types, ['source-state', 'changed']);
    }
    await Promise.all(readers.map(reader => reader.cancel()));
    await listener.stop();
    admitted.forEach(reaped);
  } finally { await listener.stop(); await rm(directory, { recursive: true }); }
});

test('last Unix consumer disconnect cancels its outstanding observer read', async () => {
  const directory = await unixDirectory();
  const fake = await fakeObserver(directory);
  const native = createNativeClient(fake.executable, { readMs: 5000, killMs: 100 });
  const http = createHttp(native, { localHost: 'localhost', webRoot: directory, release: 'test' });
  const socket = join(directory, 'http.sock');
  const listener = await listen(http, { unix: socket });
  const connection = createConnection(socket);
  connection.on('error', () => {});
  connection.write('GET /api/v1/sessions HTTP/1.1\r\nHost: localhost\r\n\r\n');
  try {
    const [pid] = await readPids(fake.pids, 1);
    connection.destroy();
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      try { process.kill(pid, 0); } catch { break; }
      await delay(15);
    }
    reaped(pid);
  } finally { connection.destroy(); await listener.stop(); await rm(directory, { recursive: true }); }
});

test('observer timeout, cancellation, restart and idempotent shutdown reap all children', async () => {
  const directory = await mkdtemp(join(process.env.TMPDIR!, 'life-'));
  const fake = await fakeObserver(directory);
  const client = createNativeClient(fake.executable, { readMs: 250, killMs: 50 });
  try {
    const timed = client.read('run.agents', { mode: 'hung' });
    const [first] = await readPids(fake.pids, 1);
    assert.equal((await timed).error?.code, 'observer_timeout');
    reaped(first);
    const signal = new AbortController();
    const aborted = client.read('run.agents', { mode: 'abort' }, signal.signal);
    const [, second] = await readPids(fake.pids, 2);
    signal.abort();
    assert.equal((await aborted).error?.code, 'cancelled');
    reaped(second);
    assert.equal((await client.read('run.agents', { mode: 'crash' })).outcome, 'unavailable');
    await writeFile(fake.release, '');
    assert.equal((await client.read('run.agents')).outcome, 'ok');
    const shutdown = client.read('run.agents', { mode: 'hung' });
    const pids = await readPids(fake.pids, 5);
    await Promise.all([client.close(), client.close()]);
    assert.equal((await shutdown).error?.code, 'cancelled');
    pids.forEach(reaped);
  } finally { await client.close(); await rm(directory, { recursive: true }); }
});

test('Unix listener refuses an unexpected file or a running peer at its socket path', async () => {
  const directory = await unixDirectory();
  const socket = join(directory, 'http.sock');
  const native = createNativeClient('/missing');
  const http = createHttp(native, { localHost: 'localhost', webRoot: directory, release: 'test' });
  try {
    await writeFile(socket, 'preserve me');
    await assert.rejects(listen(http, { unix: socket }), /unexpected/);
    assert.equal(await readFile(socket, 'utf8'), 'preserve me');
    await rm(socket);
    const running = await listen(http, { unix: socket });
    try {
      await assert.rejects(listen(http, { unix: socket }), /in use/);
      assert.equal((await local(socket, '/health')).status, 200);
    } finally { await running.stop(); }
  } finally { await http.close(); await rm(directory, { recursive: true }); }
});
