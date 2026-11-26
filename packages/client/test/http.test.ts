/** Covers validated HTTP, bounded SSE and continuation recovery against the frozen fixtures. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixtureFetch } from '../fixtures/index.ts';
import { createHubClient, HubHttpError, readSse, recoverCursor } from '../src/index.ts';

test('typed HTTP defaults to GET, rejects redirects and reports stale boundaries', async () => {
  const fixture = createFixtureFetch('populated');
  const hub = createHubClient({
    baseUrl: 'https://fixture.test',
    fetch(input, init) { assert.equal(init?.method, 'GET'); assert.equal(init?.redirect, 'error'); return fixture(input, init); },
  });
  assert.equal((await hub.get('health')).mode, 'fixture');
  assert.equal((await hub.get('sessions')).data.items.length, 6);
  await assert.rejects(hub.get('session', { params: { id: 'demo-inspect' }, query: { execution: 'invalid-selector' } }),
    error => error instanceof HubHttpError && error.status === 409 && error.code === 'stale_boundary');
  const calls: (string | null)[] = [];
  const result = await recoverCursor('old', async cursor => {
    calls.push(cursor);
    if (cursor) throw new HubHttpError('stale_boundary', 409);
    return 'new boundary';
  });
  assert.equal(result, 'new boundary');
  assert.deepEqual(calls, ['old', null]);
});

test('SSE validates UTF-8 split frames and observes cancellation', async () => {
  const bytes = new TextEncoder().encode(': heartbeat\r\nevent: source-state\r\ndata: {"type":"source-state","topic":"quota","observation":{"source":"quota","outcome":"partial","producerAtMs":null,"observedAtMs":1,"issue":{"code":"fixture","message":"é"}}}\r\n\r\n');
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  });
  const frames = [];
  for await (const frame of readSse(body)) frames.push(frame);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].type === 'source-state' && frames[0].observation.issue?.message, 'é');
  const hub = createHubClient({ baseUrl: 'https://fixture.test', fetch: createFixtureFetch('populated') });
  const controller = new AbortController();
  let ready = false;
  await hub.watch(['quota'], 1, { event(frame) { ready = frame.type === 'ready'; controller.abort(); } }, controller.signal);
  assert.equal(ready, true);
});

test('reconnect reports disconnection then readiness over a fresh stream', async () => {
  const first = new Response('event: ready\ndata: {"type":"ready","topics":["quota"],"observedAtMs":1}\n\n', {
    headers: { 'Content-Type': 'text/event-stream' },
  });
  const fixture = createFixtureFetch('populated');
  let requests = 0;
  const hub = createHubClient({
    baseUrl: 'https://fixture.test',
    fetch: async (input, init) => ++requests === 1 ? first : fixture(input, init),
  });
  const controller = new AbortController();
  const states: string[] = [];
  await hub.watch(['quota'], 1, {
    connection: state => states.push(state),
    event: () => { if (requests === 2) controller.abort(); },
  }, controller.signal);
  assert.deepEqual(states, ['connected', 'disconnected', 'connected']);
});

test('Unix transport reaches Bun HTTP server through the socket', { skip: !process.versions.bun }, async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { createUnixHubClient } = await import('../src/unix.ts');
  const temp = process.env.TMPDIR;
  assert.ok(temp);
  const dir = await mkdtemp(join(temp, 'hub-http-'));
  const socket = join(dir, 'http.sock');
  // Keep Bun-specific type definitions out of the browser transport.
  const bun = (globalThis as unknown as { Bun: { serve(options: { unix: string; fetch: typeof fetch }): { stop(force: boolean): void } } }).Bun;
  let server: ReturnType<typeof bun.serve> | undefined;
  try {
    const fixture = createFixtureFetch('populated');
    server = bun.serve({ unix: socket, fetch: request => fixture(request) });
    assert.equal((await createUnixHubClient(socket).get('health')).mode, 'fixture');
  } finally {
    server?.stop(true);
    await rm(dir, { recursive: true });
  }
});
