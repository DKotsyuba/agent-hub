/** Exercises the migrated renderer over the public HTTP fixture service. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createTestRenderer } from '@opentui/core/testing';
import { createHubClient } from '../../packages/client/src/index.ts';
import { createHttpClient } from '../src/client.ts';
import { mountHub } from '../src/hub.ts';

test('HTTP fixture shows history, agreement, Quota and Worktree, and detects lost connection', async () => {
  const reserve = createServer();
  reserve.listen(0, '127.0.0.1');
  await once(reserve, 'listening');
  const address = reserve.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>(resolve => reserve.close(() => resolve()));
  const service = spawn('bun', ['--no-install', fileURLToPath(new URL('../../packages/client/fixtures/serve.mjs', import.meta.url)), 'populated', String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = once(service, 'exit');
  try {
    await Promise.race([
      once(service.stdout, 'data', { signal: AbortSignal.timeout(5000) }),
      exited.then(() => { throw new Error('Fixture server stopped before startup.'); }),
    ]);
    const url = new URL(`http://127.0.0.1:${port}`);
    const requests: URL[] = [];
    const http = createHubClient({
      baseUrl: url,
      async fetch(input, init) {
        const request = new URL(String(input));
        requests.push(request);
        const response = await fetch(input, init);
        if (!response.ok || !/\/pools\/[^/]+(?:\/sections\/members)?$/.test(request.pathname)) return response;
        const body = await response.json() as { capabilities?: { runBindings: string } };
        if (body.capabilities) body.capabilities.runBindings = 'unsupported';
        return Response.json(body);
      },
    });
    const client = createHttpClient(url, http);
    const setup = await createTestRenderer({ width: 120, height: 40 });
    const copied: string[] = [];
    setup.renderer.copyToClipboardOSC52 = content => { copied.push(content); return true; };
    const dispose = mountHub(setup.renderer, client, 'live', () => {});
    /** Waits for a renderer frame while giving real HTTP reads time to complete. */
    async function frame(text: string) {
      for (let attempt = 0; attempt < 160; attempt++) {
        await setup.renderOnce();
        const screen = setup.captureCharFrame();
        if (screen.includes(text)) return screen;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.fail(`Missing ${text}\n${setup.captureCharFrame()}`);
    }
    try {
      await frame('LIVE READ-ONLY');
      setup.mockInput.pressKey('1');
      await frame('Inspect the saved execution history.');
      setup.mockInput.pressKey('f');
      await frame('Following');
      setup.mockInput.pressKey('z');
      await frame('Following');
      setup.mockInput.pressEscape();
      await frame('All folders');
      setup.mockInput.pressKey('r');
      for (let attempt = 0; attempt < 50 && !requests.some(request => request.pathname.endsWith('/history') && request.searchParams.get('cursor')); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      setup.mockInput.pressKey('y');
      await frame('Retained scan copy requested');
      assert.match(copied.at(-1) ?? '', /Retained session lineage/);
      setup.mockInput.pressKey('2');
      const poolList = await frame('▸ Finished  2');
      assert.match(poolList, /›.*Live planning pool/);
      assert.doesNotMatch(poolList, /Chat review pool/);
      setup.mockInput.pressKey('o');
      await frame('Chat review pool');
      setup.mockInput.pressArrow('down');
      await frame('› Chat review pool');
      setup.mockInput.pressEnter();
      await frame('Synthetic discussion.');
      setup.mockInput.pressArrow('left');
      await frame('Open Run session · unverified');
      const seatReadCount = requests.filter(request => request.pathname === '/api/v1/sessions/demo-inspect').length;
      setup.mockInput.pressEnter();
      await frame('Inspect the saved execution history.');
      assert.ok(requests.filter(request => request.pathname === '/api/v1/sessions/demo-inspect').length > seatReadCount);
      setup.mockInput.pressEscape();
      await frame('Open Run session · unverified');
      setup.mockInput.pressArrow('right');
      await frame('Synthetic discussion.');
      setup.mockInput.pressKey('l');
      await frame('Result (recorded by Pool');
      await frame('Ship it.');
      setup.mockInput.pressEscape();
      await frame('Synthetic discussion.');
      setup.mockInput.pressKey('y');
      await frame('Journal copy requested');
      assert.match(copied.at(-1) ?? '', /Synthetic discussion/);
      setup.mockInput.pressKey('3');
      await frame('acct-test');
      setup.mockInput.pressKey('4');
      await frame('feat/review');
      setup.mockInput.pressEnter();
      await frame('Worktree wt-review');
      setup.mockInput.pressEscape();
      await frame('feat/review');
      assert.equal(requests[0].pathname, '/api/v1/events');
      assert.ok(requests.every(request => request.pathname.startsWith('/api/v1/')));
      assert.ok(requests.some(request => request.pathname.endsWith('/history') && request.searchParams.get('cursor')));
      service.kill();
      await exited;
      await frame('HUB DISCONNECTED');
    } finally {
      dispose(); await client.close(); await setup.dispose();
    }
  } finally {
    service.kill();
    await exited;
  }
});

test('verified HTTP content keeps execution and UTF-8 boundaries', async () => {
  const { createFixtureFetch } = await import('../../packages/client/fixtures/index.ts');
  const { loadHttpExport, loadHttpInitialTask, loadHttpResult } = await import('../src/http-content.ts');
  const http = createHubClient({ baseUrl: 'https://fixture.test', fetch: createFixtureFetch('populated') });
  const signal = AbortSignal.timeout(5000);
  const result = await loadHttpResult(http, 'demo-finished', 'exec-finished', 1, signal);
  assert.ok(result.length > 0);
  await assert.rejects(loadHttpResult(http, 'demo-finished', 'exec-finished', 2, signal), /execution_changed/);
  assert.ok((await loadHttpExport(http, 'demo-historical', 'exec-old', 'exact', signal)).length > 0);
  assert.equal((await loadHttpInitialTask(http, 'demo-inspect', 'exec-inspect', signal)).state, 'verified');
});

test('HTTP adapter keeps empty, stale and unavailable observations independent', async () => {
  const { createFixtureFetch } = await import('../../packages/client/fixtures/index.ts');
  for (const scenario of ['empty', 'partial-stale', 'unavailable', 'incompatible'] as const) {
    const http = createHubClient({ baseUrl: 'https://fixture.test', fetch: createFixtureFetch(scenario) });
    const terminal = createHttpClient(undefined, http);
    try {
      const health = await http.get('health');
      assert.equal(health.ready, true);
      const sessions = await terminal.read('run.agents');
      assert.equal(sessions.outcome, { empty: 'ok', 'partial-stale': 'partial', unavailable: 'unavailable', incompatible: 'incompatible' }[scenario]);
      if (scenario === 'empty') assert.deepEqual((sessions.data as { items: unknown[] }).items, []);
      if (scenario === 'unavailable' || scenario === 'incompatible') assert.equal(sessions.data, null);
    } finally { await terminal.close(); }
  }
});

for (const pending of [false, true]) test(pending
  ? 'terminal retries task and result failures that settle after a newer ready generation'
  : 'terminal readiness retries failed content and rewinds a rejected incident continuation', async () => {
  const { createFixtureFetch } = await import('../../packages/client/fixtures/index.ts');
  const fixture = createFixtureFetch('populated');
  const baseUrl = new URL('https://fixture.test');
  const rejected = (code: string, status: number) => Response.json({ error: {
    code, message: code, retryable: true, requestId: 'fixture-request',
  } }, { status });
  let resumed = false, resultReads = 0, taskReads = 0, staleIncidents = 0;
  let incidentStarts = 0;
  const priorRead = Promise.withResolvers<void>();
  let ready = () => {};
  const http = createHubClient({ baseUrl, async fetch(input, init) {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/demo-finished/initial-task')) {
      taskReads++;
      if (!resumed) {
        if (pending) await priorRead.promise;
        return rejected('source_unavailable', 503);
      }
    }
    if (url.pathname.endsWith('/demo-finished/result')) {
      resultReads++;
      if (!resumed) {
        if (pending) await priorRead.promise;
        return rejected('source_unavailable', 503);
      }
    }
    if (url.pathname.endsWith('/incidents')) {
      if (url.searchParams.has('cursor')) {
        staleIncidents++;
        return rejected('stale_boundary', 409);
      }
      incidentStarts++;
      return Response.json({
        data: { items: [{ id: 'incident-1', publisher: 'fixture', eventId: 'incident-test', state: 'open',
          closed: false, createdAtMs: null, updatedAtMs: null, detail: 'isolated incident' }] },
        page: { next: incidentStarts === 1 ? 'expired-incidents' : null, previous: null, resume: null },
        observations: [{ source: 'bridge', resource: 'bridge.incidents', observedAtMs: incidentStarts, producerAtMs: null, outcome: 'ok' }],
      });
    }
    return fixture(input, init);
  } });
  http.watch = async (topics, _interval, handlers, signal) => {
    ready = () => {
      if (signal.aborted) return;
      handlers.connection?.('connected');
      handlers.event({ type: 'ready', topics: [...topics], observedAtMs: Date.now() });
    };
    ready();
    if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
  };
  const client = createHttpClient(baseUrl, http);
  const setup = await createTestRenderer({ width: 140, height: 44 });
  const dispose = mountHub(setup.renderer, client, 'live', () => {});
  /** Click a label from a currently rendered frame. */
  async function click(label: string) {
    const frame = await setup.waitForFrame(value => value.includes(label));
    const rows = frame.split('\n'), row = rows.findIndex(line => line.includes(label));
    await setup.mockMouse.click(rows[row].indexOf(label) + 1, row);
  }
  try {
    await click('View incidents');
    await setup.waitForFrame(value => value.includes('Load next retained page'));
    setup.mockInput.pressKey('n');
    await setup.waitForFrame(() => incidentStarts >= 2);
    assert.equal(staleIncidents, 1);
    await setup.waitForFrame(value => value.includes('incident-1') && !value.includes('Load next retained page'));

    setup.mockInput.pressKey('1');
    setup.mockInput.pressKey('o');
    await click('Review saved output');
    await setup.waitForFrame(() => taskReads > 0);
    await click('Result');
    await setup.waitForFrame(value => resultReads > 0 && (pending || value.includes('source_unavailable')));
    const failedAnswers = resultReads, failedTasks = taskReads;
    resumed = true;
    ready();
    priorRead.resolve();
    await setup.waitForFrame(() => resultReads > failedAnswers && taskReads > failedTasks);
  } finally { priorRead.resolve(); dispose(); await client.close(); await setup.dispose(); }
});
