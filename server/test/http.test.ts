/** Package B acceptance tests with deterministic producer-shaped reads. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, symlink, utimes, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { API_RESPONSES, apiError, event, type ApiResponse } from '@agent-hub/domain';
import { createDemoClient } from '../../terminal/src/demo.ts';
import runStatus from '../../terminal/test/fixtures/run-status-v1.json';
import chat from '../../terminal/test/fixtures/pool-chat-v1.json';
import { object, sha256 } from '../../src/live/protocol.ts';
import { heldAlarm, heldState } from '../../packages/view-model/src/index.ts';
import { createHttp } from '../src/http.ts';
import { createHubClient } from '../../packages/client/src/index.ts';
import { loadHttpExport, loadHttpInitialTask, loadHttpPoolExport, loadHttpResult } from '../../terminal/src/http-content.ts';
import { createHttpClient } from '../../terminal/src/client.ts';
import { groupPools } from '../../terminal/src/pool-list.ts';
import { poolInventory } from '../../terminal/src/pool.ts';
import type { NativeResponse, ObservationClient, ObserverResource } from '../src/observer.ts';

const mount = '/api/v1';
const now = 1_730_000_000_000;
const execution = 'ex1_' + 'a'.repeat(64);
const store = 'store_' + '1'.repeat(32);
const task = 'Inspect the synthetic migration.';

/** Wraps a deterministic fake payload in the native protocol. */
function envelope(resource: ObserverResource, data: unknown, outcome: NativeResponse['outcome'] = 'ok', code = 'synthetic'): NativeResponse {
  return { schema_version: 1, source: resource.split('.')[0], resource, observed_at_ms: now, data, outcome,
    error: ['ok', 'partial'].includes(outcome) ? null : { code, message: 'private fixture details' } };
}

/** Enforces the current Pool producer's closed parameter shape for fake reads. */
function checkedPoolParams(resource: ObserverResource, params: Record<string, unknown>): void {
  const allowed = resource === 'pool.list' ? ['after'] : resource === 'pool.get'
    ? ['pool_id', 'section', 'after', 'before', 'through', 'direction', 'proposal_id', 'expected_revision', 'field', 'include_bindings'] : null;
  if (allowed) assert.ok(Object.keys(params).every(key => allowed.includes(key)), JSON.stringify(params));
}

/** Supplies synthetic fixtures at the native observation seam, including proof responses. */
async function producer(): Promise<ObservationClient> {
  const demo = createDemoClient();
  const hash = await sha256(task);
  return {
    close: () => demo.close(),
    async read(resource, params = {}, signal) {
      checkedPoolParams(resource, params);
      if (resource === 'run.initial_task') return envelope(resource, {
        version: 1, mode: 'current', state: 'available', store_id: store, agent_id: params.agent_id,
        sequence: 1, execution_ref: execution, total_bytes: Buffer.byteLength(task), sha256: hash,
        offset: 0, end: Buffer.byteLength(task), next_offset: null, text: task, complete: true,
      });
      if (resource === 'pool.completion_get') return envelope(resource, chat.agreement);
      if (resource === 'pool.get' && params.section === 'content') {
        const text = 'A pinned synthetic goal.';
        const total = Buffer.byteLength(text);
        return envelope(resource, { schema_version: 1, kind: 'pool_detail', data: {
          section: 'content', source_timestamp: null, cursor: String(total), has_more: false, decisions: [], returned: 1,
          view: { ...poolView, section: 'content', next_after: total, content: { offset: 0, text, total_bytes: total, field: 'purpose' } },
        } });
      }
      const result = await demo.read(resource, params, signal);
      if (resource === 'run.identity') {
        return envelope(resource, { ...object(result.data),
          capabilities: { initial_task: { version: 1, method: 'initial_task', modes: ['current'], max_task_bytes: 524288, max_page_bytes: 65536 } } });
      }
      if (resource === 'run.agents') {
        return envelope(resource, { ...object(result.data),
          items: (object(result.data).items as unknown[]).map(item => ({ ...object(item), execution_ref: execution })) });
      }
      if (resource === 'pool.identity') {
        return envelope(resource, { schema_version: 1, kind: 'identity',
          data: { capabilities: ['history_window_v1', 'content_pages_v1', 'completion_record_v1', 'observer_socket_v1'] } });
      }
      return result;
    },
  };
}

const poolView = {
  pool: { pool_id: 'demo-pool', name: 'Synthetic', closed: false, revision: 1, proposal: null },
  members: [], events: [], deliveries: [], has_more: false,
};

/** Constructs a request with the Host that the Unix HTTP transport sends. */
function request(path: string, init?: RequestInit): Request {
  const headers = new Headers({ Host: 'localhost', ...init?.headers });
  return new Request('http://localhost' + path, { ...init, headers });
}

/** Creates an isolated HTTP handler without touching a live producer. */
function handler(client: ObservationClient, webRoot = '/does-not-exist') {
  return createHttp(client, { localHost: 'localhost', publicOrigin: 'https://hub.example', release: 'test', webRoot });
}

/** Exercises the public client through the real HTTP handler and its native seam. */
function transport(http: ReturnType<typeof handler>) {
  return createHubClient({
    baseUrl: 'http://localhost',
    fetch(input, options) {
      const url = new URL(String(input));
      return http.fetch(request(url.pathname + url.search, options));
    },
  });
}

/** Decodes one successful response from the actual route. */
async function get<K extends keyof typeof API_RESPONSES>(http: ReturnType<typeof handler>, route: K, path: string) {
  const response = await http.fetch(request(mount + path));
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  return API_RESPONSES[route](body) as ApiResponse<K>;
}

test('supported GET routes project native fixtures through the frozen contract', async () => {
  const http = handler(await producer());
  try {
    assert.equal((await get(http, 'health', '/health')).ready, true);
    assert.ok((await get(http, 'overview', '/overview')).data.run);
    const sessions = await get(http, 'sessions', '/sessions?limit=2');
    assert.equal(sessions.data.items.length, 2);
    assert.ok(sessions.page.next);
    assert.equal((await get(http, 'session', '/sessions/demo-finished')).data.session.status, 'succeeded');
    assert.equal((await get(http, 'sessionHistory', '/sessions/demo-finished/history')).data.entries.find(item => item.results.length)?.results.length, 1);
    assert.equal((await get(http, 'initialTask', '/sessions/demo-finished/initial-task')).data.state, 'verified');
    assert.equal((await get(http, 'sessionResult', '/sessions/demo-finished/result')).data.proof.execution, execution);
    assert.equal((await get(http, 'sessionExport', '/sessions/demo-finished/export')).data.coverage.state, 'partial');
    assert.equal((await get(http, 'pools', '/pools')).data.items[0].id, 'demo-pool');
    assert.equal((await get(http, 'pool', '/pools/demo-pool')).data.pool.id, 'demo-pool');
    const members = (await get(http, 'poolSection', '/pools/demo-pool/sections/members')).data.items;
    assert.equal(members.length, 1);
    // No Run binding leaves the display row explicitly absent rather than guessed.
    if ('seat' in members[0]) assert.equal(members[0].run, null);
    assert.equal((await get(http, 'poolHistory', '/pools/demo-pool/history')).data.items.length, 1);
    assert.equal((await get(http, 'poolContent', '/pools/demo-pool/content/purpose')).data.content.text, 'A pinned synthetic goal.');
    assert.equal((await get(http, 'quota', '/quota')).data.snapshot?.accounts.length, 2);
    const trees = await get(http, 'worktrees', '/worktrees');
    const main = trees.data.items.find(item => item.path === '/demo/agent-hub')!;
    assert.equal((await get(http, 'worktree', '/worktrees/' + main.id)).data.worktree.facts.size.state, 'known');
    assert.equal((await get(http, 'incidents', '/bridge/incidents')).data.items.length, 1);
  } finally { await http.close(); }
});

test('Run inventory StorageError recovers current session details through a correlated per-ID read', async t => {
  const id = 'ag-20260101-010101-0123456789';
  const status = 'succeeded', sampledAt = now / 1000 + 0.25;
  const agent = { agent_id: id, sequence: 2, status, observed_at: sampledAt, answer_available: true };
  const fact = { sequence: 2, raw_status: status, execution_ref: execution };
  const errorLog = t.mock.method(console, 'error', () => {});
  let inventoryCode = 'run_inventory_storage';
  let integrationOutcome: NativeResponse['outcome'] = 'ok';
  let integrationId = id;
  let integrationReads = 0;
  const http = handler({
    async close() {},
    async read(resource, params) {
      switch (resource) {
        case 'run.identity': return envelope(resource, { tools: [{ name: 'agent_integration' }] });
        case 'run.agents':
          assert.deepEqual(params, { limit: 200, offset: 0 });
          return envelope(resource, null, 'unavailable', inventoryCode);
        case 'run.agent_integration':
          integrationReads++;
          assert.deepEqual(params, { agent_id: id });
          return integrationOutcome === 'ok'
            ? envelope(resource, { schema_version: 1, agent: { ...agent, agent_id: integrationId },
              communication: { state: 'unknown', reason: 'terminal' } })
            : envelope(resource, null, integrationOutcome);
        case 'run.status': {
          const match = (params?.targets as Record<string, unknown>[])[0].execution_ref ? 'verified' : 'unverified';
          const selector = { agent_id: id, sequence: 2, ...(match === 'verified' ? { execution_ref: execution } : {}) };
          assert.deepEqual(params, { version: 1, targets: [selector], include_view: true });
          return envelope(resource, { version: 1, store_id: store, observed_at: now / 1000,
            items: [{ selector, canonical_agent_id: id, match, pin_id: null, pin_state: 'missing',
              selected: fact, retained_latest: fact, coverage: 'unknown', restart_resume: 'unknown',
              lineage_terminal: null, terminal_outcome: null, success_commit: 'unknown',
              cleanup: { scope: 'lineage', state: 'unknown' } }],
            view: { selector_index: 0, match, status_scope: 'selected_execution_raw', sampled_at: sampledAt, agent },
          });
        }
        default: throw new Error('unexpected observation: ' + resource);
      }
    },
  });
  try {
    const path = '/sessions/' + id;
    const result = await get(http, 'session', path);
    assert.equal(result.data.session.execution, execution);
    assert.equal(result.data.session.status, 'succeeded');
    assert.equal(result.data.lineage?.match.match, 'unverified');
    assert.equal((await get(http, 'session', path + '?execution=' + execution)).data.lineage?.match.match, 'verified');
    assert.equal(errorLog.mock.callCount(), 2);
    const logged = JSON.parse(String(errorLog.mock.calls[0].arguments[0]));
    assert.deepEqual(logged, { event: 'source_failure', route: 'session', source: 'run',
      resource: 'run.agents', errorClass: 'run_inventory_storage', requestId: logged.requestId });
    assert.match(logged.requestId, /^[0-9a-f-]{36}$/);

    integrationId = 'ag-20260101-010101-012345678a';
    assert.equal((await http.fetch(request(mount + path))).status, 502);
    integrationOutcome = 'missing';
    assert.equal((await http.fetch(request(mount + path))).status, 404);
    assert.equal((await http.fetch(request(mount + path + '?execution=' + execution))).status, 409);
    integrationOutcome = 'incompatible';
    assert.equal((await http.fetch(request(mount + path))).status, 503);
    assert.equal(integrationReads, 6);

    inventoryCode = 'secret-unrecognized-error';
    const failed = await http.fetch(request(mount + path));
    assert.equal(failed.status, 503);
    assert.equal(integrationReads, 6);
    const body = apiError(await failed.json());
    const last = JSON.parse(String(errorLog.mock.calls.at(-1)?.arguments[0]));
    assert.deepEqual(last, { ...logged, errorClass: 'unavailable', requestId: body.error.requestId });
  } finally { await http.close(); }
});

test('shared native failures and finite projector rejections are logged once per flight', async t => {
  const errorLog = t.mock.method(console, 'error', () => {});
  let reads = 0;
  let rejectAt: 'transport' | 'native' | 'projector' = 'transport';
  const http = handler({
    async read(resource) {
      reads++;
      await new Promise<void>(resolve => setTimeout(resolve, 5));
      if (rejectAt === 'transport') throw new Error('private transport details');
      if (rejectAt === 'native') return envelope(resource, null, 'unavailable', 'private native code');
      return envelope(resource, { privatePayload: true });
    },
    close: async () => {},
  });
  try {
    for (const [kind, status, errorClass] of [
      ['transport', 502, 'read_rejected'], ['native', 503, 'unavailable'], ['projector', 502, 'invalid_projection'],
    ] as const) {
      rejectAt = kind;
      const expected = reads + 1;
      const responses = await Promise.all([http.fetch(request(mount + '/sessions')), http.fetch(request(mount + '/sessions'))]);
      assert.deepEqual(responses.map(response => response.status), [status, status]);
      assert.equal(reads, expected);
      assert.equal(errorLog.mock.callCount(), expected);
      const line = String(errorLog.mock.calls.at(-1)?.arguments[0]);
      assert.doesNotMatch(line, /private/);
      const logged = JSON.parse(line);
      assert.deepEqual(logged, { event: 'source_failure', route: 'sessions', source: 'run', resource: 'run.agents', errorClass,
        requestId: apiError(await responses[0].json()).error.requestId });
    }
  } finally { await http.close(); }
});

test('overview excludes unknown quota placeholders and marks the retained minimum when fresh quota is absent', async () => {
  const native = await producer();
  let onlyStale = false;
  const http = handler({ close: () => native.close(), async read(resource, params, signal) {
    const result = await native.read(resource, params, signal);
    if (resource !== 'quota.snapshot') return result;
    const data = object(result.data);
    const [first, second] = (data.accounts as Record<string, unknown>[]);
    const [a, b] = first.models as Record<string, unknown>[];
    const [unknown] = second.models as Record<string, unknown>[];
    a.evidence = 'fresh';
    if (onlyStale) a.state_validity = { kind: 'until', at: 1 };
    b.evidence = 'stale';
    unknown.remaining_percent = 1;
    return result;
  } });
  try {
    const current = (await get(http, 'overview', '/overview')).data.quota?.lowest;
    assert.equal(current?.model, 'model-alpha');
    assert.equal(current?.remaining, 72);
    assert.equal(current?.stale, undefined);
    onlyStale = true;
    const retained = (await get(http, 'overview', '/overview')).data.quota?.lowest;
    assert.equal(retained?.model, 'model-beta');
    assert.equal(retained?.remaining, 26);
    assert.equal(retained?.stale, true);
  } finally { await http.close(); }
});

test('overview reports the earliest fresh deficit exhaustion, independently of the lowest model', async () => {
  const native = await producer();
  const start = Math.floor(Date.now() / 1000);
  let stale = false;
  const http = handler({ close: () => native.close(), async read(resource, params, signal) {
    const result = await native.read(resource, params, signal);
    if (resource !== 'quota.snapshot') return result;
    const account = (object(result.data).accounts as Record<string, unknown>[])[0];
    const first = (account.windows as Record<string, unknown>[])[0];
    const base = { ...first, valid_until: start + 900, last_remaining_percent: 32, last_reset_at: start + 7200,
      forecast: { known: true, risk: 'high' }, evaluation: { risk: 'high', burn_percent_per_hour: 32 } };
    account.windows = [
      { ...base, lane: 'expired', valid_until: start - 1, evaluation: { burn_percent_per_hour: 100 } },
      { ...base, lane: 'unknown', forecast: { known: false }, evaluation: { burn_percent_per_hour: 100 } },
      { ...base, lane: 'reserve', last_remaining_percent: 52, evaluation: { burn_percent_per_hour: 100 } },
      { ...base, lane: 'secondary', evaluation: { burn_percent_per_hour: 24 }, valid_until: stale ? start - 1 : start + 900 },
      { ...base, lane: 'primary', valid_until: stale ? start - 1 : start + 900 },
    ];
    return result;
  } });
  try {
    const data = (await get(http, 'overview', '/overview')).data.quota;
    assert.equal(data?.lowest?.model, 'model-beta');
    assert.equal(data?.exhaustion?.lane, 'primary');
    assert.equal(data?.exhaustion?.resetAtMs, (start + 7200) * 1000);
    assert.equal(data?.exhaustion?.validUntilMs, (start + 900) * 1000);
    assert.ok(Math.abs(data!.exhaustion!.atMs - (start + 3600) * 1000) < 2000);
    stale = true;
    assert.equal((await get(http, 'overview', '/overview')).data.quota?.exhaustion, undefined);
  } finally { await http.close(); }
});

test('Pool agreement remains recorded and does not acquire a verified Run link', async () => {
  const http = handler(await producer());
  try {
    const { data } = await get(http, 'poolRecord', '/pools/pool-chat-1/records/agr-7');
    assert.equal(data.kind, 'agreement');
    if (data.kind === 'agreement') assert.ok(data.ballots.every(ballot => ballot.session.match === 'unverified'));
  } finally { await http.close(); }
});

test('unsafe methods, paths, hosts, origins and cursor mutations stop before observer dispatch', async () => {
  let calls = 0;
  const delegate = await producer();
  const http = handler({ close: delegate.close, read: (...args) => { calls++; return delegate.read(...args); } });
  try {
    const first = await get(http, 'sessions', '/sessions?limit=1');
    const cursor = first.page.next!;
    calls = 0;
    for (const [item, status] of [
      [request(mount + '/sessions/id/cancel', { method: 'POST' }), 405],
      [request(mount + '/sessions/id/cancel'), 404],
      [request(mount + '/worktrees/%2Fetc%2Fpasswd'), 400],
      [request(mount + '/worktrees?repo=%2Fetc'), 400],
      [request(mount + '/pools/demo-pool/sections/binding'), 400],
      [request(mount + '/sessions?limit=1&status=finished&cursor=' + cursor), 400],
      [request(mount + '/sessions?limit=1&cursor=' + cursor.slice(0, -1) + (cursor.endsWith('A') ? 'B' : 'A')), 400],
      [request(mount + '/sessions', { headers: { Host: 'wrong.example' } }), 400],
      [request(mount + '/sessions', { headers: { Origin: 'https://wrong.example' } }), 400],
    ] as const) {
      const response = await http.fetch(item);
      assert.equal(response.status, status);
      apiError(await response.json());
    }
    assert.equal(calls, 0);
    const second = await get(http, 'sessions', '/sessions?limit=1&cursor=' + cursor);
    assert.notEqual(first.data.items[0].id, second.data.items[0].id);
    const restarted = handler({ close: async () => {}, read: async () => { throw new Error('unexpected dispatch'); } });
    try {
      const stale = await restarted.fetch(request(mount + '/sessions?limit=1&cursor=' + cursor));
      assert.equal(stale.status, 409);
    } finally { await restarted.close(); }
  } finally { await http.close(); }
});

test('older history preserves the applied resume for reconnect and append', async () => {
  let appended = false;
  const producerClient = await producer();
  const http = handler({ close: producerClient.close, async read(resource, params, signal) {
    const result = await producerClient.read(resource, params, signal);
    if (resource !== 'run.transcript' || !appended || params?.cursor !== 6) return result;
    return envelope(resource, { agent_id: params.agent_id, view: 'blocks', cursor: 6, next_cursor: null,
      complete: true, resume_cursor: 7, messages: [{ seq: 7, role: 'assistant', content: 'appended', content_complete: true }] });
  } });
  try {
    const path = '/sessions/demo-finished/history?edge=tail&limit=2';
    const tail = await get(http, 'sessionHistory', path);
    assert.notEqual(tail.page.previous, tail.page.resume);
    const old = await get(http, 'sessionHistory', path + '&direction=older&cursor=' + tail.page.previous);
    assert.equal(old.data.entries[0]?.head.position, '3');
    const stream = await http.fetch(request(mount + '/events?topic=session:demo-finished:history'));
    const reader = stream.body!.getReader();
    const frame = new TextDecoder().decode((await reader.read()).value);
    assert.equal(event(JSON.parse(frame.split('\ndata: ')[1])).type, 'ready');
    await reader.cancel();
    appended = true;
    const fresh = await http.fetch(request(mount + '/events?topic=session:demo-finished:history'));
    await fresh.body!.cancel();
    const next = await get(http, 'sessionHistory', path + '&direction=newer&cursor=' + tail.page.resume);
    assert.equal(next.data.entries[0]?.head.text, 'appended');
  } finally { await http.close(); }
});

test('malformed sources and isolated outages never become fixture or healthy-empty data', async () => {
  const known = await producer();
  const http = handler({ close: known.close, async read(resource, params, signal) {
    if (resource.startsWith('bridge.')) return envelope(resource, null, 'unavailable');
    if (resource === 'quota.snapshot') return envelope(resource, { schema_version: 8 });
    return known.read(resource, params, signal);
  } });
  try {
    const result = await get(http, 'overview', '/overview');
    assert.equal(result.data.bridge, null);
    assert.ok(result.data.run);
    assert.ok(result.observations.some(row => row.source === 'quota' && row.outcome === 'invalid'));
    const incidents = await http.fetch(request(mount + '/bridge/incidents'));
    assert.equal(incidents.status, 503);
    assert.equal((await incidents.text()).includes('private fixture details'), false);
  } finally { await http.close(); }
});

test('serves deep links, hashed assets and root-scope PWA files within the build root', async () => {
  const directory = await mkdtemp(join(process.env.TMPDIR!, 'http-test-'));
  const web = join(directory, 'web');
  await mkdir(join(web, 'assets'), { recursive: true });
  await writeFile(join(web, 'index.html'), '<title>fixture app</title>');
  await writeFile(join(web, 'assets', 'page-C3rrC30X.js'), 'export {};');
  await writeFile(join(web, 'sw.js'), 'self.addEventListener("fetch", () => {});');
  await writeFile(join(web, 'manifest.webmanifest'), '{"name":"Agent Hub"}');
  await writeFile(join(web, 'manifest-dark.webmanifest'), '{"name":"Agent Hub","theme_color":"#141c29"}');
  await writeFile(join(web, 'icon-192.png'), new Uint8Array([137, 80, 78, 71]));
  await writeFile(join(web, 'private.js'), 'private build output');
  await writeFile(join(directory, 'outside.txt'), 'outside the build');
  await symlink(join(directory, 'outside.txt'), join(web, 'outside.txt'));
  const http = handler(await producer(), web);
  try {
    const entry = await http.fetch(request('/sessions/demo-finished/history'));
    assert.equal(await entry.text(), '<title>fixture app</title>');
    assert.equal(entry.headers.get('Cache-Control'), 'no-cache');
    const asset = await http.fetch(request('/assets/page-C3rrC30X.js'));
    assert.match(asset.headers.get('Cache-Control') ?? '', /immutable/);
    const worker = await http.fetch(request('/sw.js'));
    assert.equal(worker.status, 200);
    assert.equal(worker.headers.get('Content-Type'), 'text/javascript; charset=utf-8');
    assert.equal(worker.headers.get('Cache-Control'), 'no-cache');
    assert.equal(worker.headers.get('Service-Worker-Allowed'), '/');
    assert.match(await worker.text(), /self\.addEventListener/);
    const revalidated = await http.fetch(request('/sw.js', { headers: { 'If-None-Match': worker.headers.get('ETag')! } }));
    assert.equal(revalidated.status, 304);
    assert.equal(revalidated.headers.get('Cache-Control'), 'no-cache');
    const swPath = join(web, 'sw.js');
    const swStat = await stat(swPath);
    await writeFile(swPath, 'self.addEventListener("fetch", () => 0); ');
    await utimes(swPath, swStat.atime, swStat.mtime);
    assert.equal((await stat(swPath)).size, swStat.size);
    const revision = await http.fetch(request('/sw.js', { headers: { 'If-None-Match': worker.headers.get('ETag')! } }));
    assert.equal(revision.status, 200);
    assert.notEqual(revision.headers.get('ETag'), worker.headers.get('ETag'));
    for (const name of ['manifest.webmanifest', 'manifest-dark.webmanifest']) {
      const manifest = await http.fetch(request('/' + name));
      assert.equal(manifest.status, 200);
      assert.equal(manifest.headers.get('Content-Type'), 'application/manifest+json');
      assert.equal(manifest.headers.get('Cache-Control'), 'no-cache');
      assert.equal((await manifest.json()).name, 'Agent Hub');
    }
    const icon = await http.fetch(request('/icon-192.png'));
    assert.equal(icon.status, 200);
    assert.equal(icon.headers.get('Content-Type'), 'image/png');
    assert.equal((await http.fetch(request('/private.js'))).status, 404);
    assert.equal((await http.fetch(request('/sw.js', { method: 'POST' }))).status, 405);
    const loopback = '127.0.0.1:4173';
    const local = createHttp(await producer(), { localHost: loopback, release: 'test', webRoot: web });
    try {
      const script = (origin: string) => local.fetch(new Request('http://' + loopback + '/sw.js', { headers: { Host: loopback, Origin: origin } }));
      assert.equal((await script('http://' + loopback)).status, 200);
      assert.equal((await script('http://127.0.0.1:4174')).status, 400);
    } finally { await local.close(); }
    assert.equal((await http.fetch(request('/outside.txt'))).status, 404);
    assert.equal((await http.fetch(request('/administration'))).status, 404);
    assert.equal((await http.fetch(request('/api/v9/health'))).status, 404);
  } finally { await http.close(); await rm(directory, { recursive: true }); }
});

test('strict tasks and exact exports require a Pool-fenced historical execution', async () => {
  const known = await producer(), example = runStatus.cases.verified_selected_not_tail;
  const selector = example.request.targets[0], storeId = example.request.expected_store_id;
  const member = { member_id: 'demo-member', name: 'Worker', role: 'reviewer', task: 'Check', state: 'active' };
  let badDigest = false;
  const http = handler({ close: known.close, async read(resource, params, signal) {
    if (resource === 'pool.identity') return envelope(resource, { schema_version: 1, kind: 'identity', data: { capabilities: ['run_proof_v1'] } });
    if (resource === 'pool.run_proof') return envelope(resource, { schema_version: 1, kind: 'run_proof', data: {
      state: 'observed', pool_id: 'demo-pool', member_id: member.member_id, pool_revision: 1, observed_at_unix_ms: now,
      current: true, author_identity: 'unknown', store_id: storeId, run_observed_at: example.result.observed_at,
      proof: { outcome_scope: 'retained_latest', historical_success: false, status: example.result.items[0] },
    } });
    if (resource === 'run.identity') return envelope(resource, { capabilities: {
      schema_version: 1, product: 'agent-run', read_methods: [{ name: 'transcript_exact' }],
      initial_task: { version: 1, method: 'initial_task', modes: ['strict'], max_task_bytes: 524288, max_page_bytes: 65536 },
    } });
    if (resource === 'run.status') {
      assert.deepEqual(params, example.request);
      return envelope(resource, example.result);
    }
    if (resource === 'run.agent_integration') {
      assert.deepEqual(params, { agent_id: selector.agent_id });
      return envelope(resource, { schema_version: 1, agent: example.result.view.agent, communication: { state: 'unknown', reason: 'terminal' } });
    }
    if (resource === 'run.initial_task') {
      assert.equal(params?.pin_id, selector.pin_id);
      const total = Buffer.byteLength(task);
      return envelope(resource, { state: 'available', version: 1, mode: 'strict', agent_id: selector.agent_id,
        store_id: storeId, sequence: 1, execution_ref: selector.execution_ref, pin_id: selector.pin_id,
        total_bytes: total, sha256: await sha256(task), offset: 0, end: total, next_offset: null, text: task, complete: true });
    }
    if (resource === 'run.transcript_exact') {
      assert.deepEqual(params?.selector, selector);
      const text = JSON.stringify({ seq: '1', at: 100, role: 'assistant', name: null, content: 'verified output',
        raw_ref: null, error: null, error_source: null, content_complete: true });
      const bytes = Buffer.byteLength(text);
      return envelope(resource, {
        version: 1, store_id: storeId, selector, cursor: '0', upper_seq: '1', offset: 0,
        message: { seq: '1', sha256: badDigest ? '0'.repeat(64) : await sha256(text), total_bytes: bytes, start: 0, end: bytes, text, complete: true },
        next_cursor: '1', next_offset: 0, snapshot_complete: true,
      });
    }
    const result = await known.read(resource, params, signal);
    if (resource === 'pool.get' && params?.section === 'members') {
      const outer = object(result.data), data = object(outer.data);
      return envelope(resource, { ...outer, data: { ...data, view: { ...object(data.view), members: [member] },
        bindings: [{ member, pool_id: 'demo-pool', run_id: selector.agent_id, run_sequence: selector.sequence,
          run_execution_ref: selector.execution_ref, run_store_id: storeId, run_pin_id: selector.pin_id }],
      } });
    }
    return result;
  } });
  try {
    const members = await get(http, 'poolSection', '/pools/demo-pool/sections/members');
    assert.equal(members.data.section, 'members');
    if (members.data.section !== 'members') return;
    const token = members.data.items[0].session?.execution;
    assert.ok(token && token.startsWith('bound-'));
    // The verified Run view supplies the member's own session row, rendered like Sessions.
    const run = members.data.items[0].run!;
    assert.deepEqual({ status: run.status, phase: run.phase, phaseStartedAtMs: run.phaseStartedAtMs, model: run.model, finishedAtMs: run.finishedAtMs },
      { status: 'succeeded', phase: 'terminal', phaseStartedAtMs: 1000, model: 'fixture', finishedAtMs: 1000 });
    const path = '/sessions/' + selector.agent_id;
    const initial = await get(http, 'initialTask', path + '/initial-task?execution=' + token);
    assert.equal(initial.data.state === 'verified' && initial.data.proof.kind, 'strict');
    const hub = transport(http), signal = AbortSignal.timeout(5000);
    assert.equal((await loadHttpInitialTask(hub, selector.agent_id, token, signal)).state, 'verified');
    assert.match(await loadHttpExport(hub, selector.agent_id, token, 'exact', signal), /verified output/);
    const exportPath = path + '/export?mode=exact&execution=' + token;
    const exact = await get(http, 'sessionExport', exportPath);
    assert.equal(exact.data.mode, 'exact');
    assert.match(exact.data.content.text, /verified output/);
    assert.equal(exact.data.content.text.includes(selector.pin_id), false);
    assert.equal(exact.data.content.text.includes(storeId), false);
    if (exact.data.mode === 'exact') assert.equal(exact.data.proof.content.sha256, await sha256(exact.data.content.text));
    badDigest = true;
    const invalid = await http.fetch(request(mount + exportPath));
    assert.equal(invalid.status, 502);
    assert.equal((await invalid.text()).includes('verified output'), false);
  } finally { await http.close(); }
});

test('completion requires intact field bytes and keeps the frozen Run evidence', async () => {
  const source = await producer(), example = runStatus.cases.verified_selected_not_tail;
  const goal = 'A digest-checked goal ✓', hash = await sha256(goal), bytes = Buffer.byteLength(goal);
  const recordDigest = 'a'.repeat(64), store = example.request.expected_store_id;
  let corrupt = false;
  const http = handler({ close: source.close, async read(resource, params, signal) {
    if (resource !== 'pool.completion_get') return source.read(resource, params, signal);
    const section = params?.section;
    const header = section === 'header' ? {
      source_revision: 17, commit_sequence: 6, proposal_id: 'proposal-one', leader_id: 'leader-one',
      roster_entries: 1, ballots: 1, content: [{ field: 'goal', present: true, length: bytes, sha256: hash }],
    } : null;
    const items = section === 'content' ? [{ item: 'content', field: 'goal', text: corrupt ? goal.replace('goal', 'text') : goal,
      offset: 0, total_bytes: bytes, sha256: hash }] : section === 'roster' ? [{ item: 'member', member_id: 'member-one' }]
        : section === 'ballots' ? [{ item: 'ballot', member_id: 'member-one', choice: 'ready', evidence: { text: 'checked' }, checks: [] }]
          : section === 'run_facts' ? [
            { item: 'target', entry: 'hold', run_store_id: store, status_observed_at: String(example.result.observed_at) },
            { item: 'target', entry: 'target', canonical_root: example.result.items[0].canonical_agent_id, status: { status: example.result.items[0] } },
          ] : [];
    return envelope(resource, { schema_version: 1, kind: 'completion_page', data: {
      pool_id: params?.pool_id, completion_id: params?.completion_id, section, header, items,
      record_version: 1, record_digest: recordDigest, integrity_algorithm: 'sha256', has_more: false, next_cursor: null,
    } });
  } });
  try {
    const path = '/pools/demo-pool/records/completion-one';
    const response = await get(http, 'poolRecord', path);
    assert.equal(response.data.kind, 'completion');
    if (response.data.kind === 'completion') {
      assert.equal(response.data.content[0].content.text, goal);
      assert.equal(response.data.recordDigest, recordDigest);
      assert.equal(response.data.runFacts[0].selected?.sequence, 1);
      assert.equal(response.data.ballots[0].evidence, 'checked');
    }
    corrupt = true;
    assert.equal((await http.fetch(request(mount + path))).status, 502);
  } finally { await http.close(); }
});

test('Worktree status and size are cached only after a listed, validated inspect', async () => {
  const source = await producer();
  let inspections = 0;
  const http = handler({ close: source.close, async read(resource, params, signal) {
    if (resource === 'worktree.inspect') {
      inspections++;
      assert.equal(params?.repo, '/demo/agent-hub');
      assert.equal(params?.path, '/demo/agent-hub');
    }
    return source.read(resource, params, signal);
  } });
  try {
    const first = await get(http, 'worktrees', '/worktrees');
    const row = first.data.items.find(item => item.path === '/demo/agent-hub')!;
    assert.equal(inspections, 0);
    assert.equal((await http.fetch(request(mount + '/worktrees/unknown'))).status, 404);
    assert.equal(inspections, 0);
    await get(http, 'worktree', '/worktrees/' + row.id);
    await get(http, 'worktree', '/worktrees/' + row.id);
    const after = await get(http, 'worktrees', '/worktrees');
    assert.equal(after.data.items.find(item => item.id === row.id)?.facts.size.state, 'known');
    assert.equal(inspections, 1);
  } finally { await http.close(); }
});

test('terminal result, current task and retained export loaders accept real handler proofs', async () => {
  const http = handler(await producer());
  try {
    const hub = transport(http), signal = AbortSignal.timeout(5000), id = 'demo-finished';
    assert.ok((await loadHttpResult(hub, id, execution, 1, signal)).length);
    const initial = await loadHttpInitialTask(hub, id, execution, signal);
    assert.equal(initial.state === 'verified' && initial.text, task);
    assert.match(await loadHttpExport(hub, id, execution, 'retained', signal), /Retained session lineage/);
  } finally { await http.close(); }
});

test('inline result cannot be verified without matching native answer-chunk sequence', async () => {
  const native = await producer();
  let chunkCalls = 0;
  const http = handler({ close: native.close, async read(resource, params, signal) {
    const payload = await native.read(resource, params, signal);
    if (resource !== 'run.answer_chunk') return payload;
    chunkCalls++;
    return { ...payload, data: { ...object(payload.data), sequence: Number(params?.sequence) + 1 } };
  } });
  try {
    const response = await http.fetch(request(mount + '/sessions/demo-finished/result'));
    assert.equal(response.status, 502);
    assert.equal(apiError(await response.json()).error.code, 'invalid_projection');
    assert.equal(chunkCalls, 1);
  } finally { await http.close(); }
});

test('history signs only cursor progress supported by forward, empty and older blocks', async () => {
  const native = await producer();
  let bad: 'next' | 'resume' | 'empty' | 'older' | null = null;
  const http = handler({ close: native.close, async read(resource, params, signal) {
    const payload = await native.read(resource, params, signal);
    if (resource !== 'run.transcript' || bad === null) return payload;
    const page = object(payload.data);
    return envelope(resource, { ...page, ...(bad === 'next' ? { next_cursor: 10 } : bad === 'resume' ? { resume_cursor: 10 }
      : bad === 'empty' ? { complete: false, messages: [], next_cursor: 10, resume_cursor: null } : { previous_cursor: 10 }) });
  } });
  try {
    const path = '/sessions/demo-finished/history?edge=start&limit=1';
    for (bad of ['next', 'resume', 'empty'] as const) {
      assert.equal((await http.fetch(request(mount + path))).status, 502, bad);
    }
    bad = null;
    const tail = await get(http, 'sessionHistory', '/sessions/demo-finished/history?edge=tail&limit=1');
    bad = 'older';
    assert.equal((await http.fetch(request(mount + '/sessions/demo-finished/history?edge=tail&limit=1&direction=older&cursor=' + tail.page.previous))).status, 502);
  } finally { await http.close(); }
});

test('terminal Pool export follows a frozen watermark through partial page coverage', async () => {
  const native = await producer();
  const all = Array.from({ length: 101 }, (_, index) => ({ event_id_exact: String(index + 1), kind: 'message', body: 'discussion-' + (index + 1), author: { kind: 'service' } }));
  const http = handler({ close: native.close, async read(resource, params, signal) {
    if (resource !== 'pool.get' || params?.section !== 'history') return native.read(resource, params, signal);
    const events = all.filter(row => Number(row.event_id_exact) > Number(params.after ?? 0));
    return envelope(resource, { schema_version: 1, kind: 'pool_detail', data: { source_timestamp: null,
      section: 'history', history_watermark: '101', cursor: '101', has_more: false, returned: events.length,
      view: { ...poolView, section: 'history', events } } });
  } });
  try {
    const hub = transport(http), signal = AbortSignal.timeout(5000);
    const first = await hub.get('poolHistory', { params: { id: 'demo-pool' }, query: { edge: 'start', limit: 100 }, signal });
    assert.equal(first.data.coverage.state, 'partial');
    const text = await loadHttpPoolExport(hub, 'demo-pool', signal);
    assert.match(text, /coverage complete/);
    assert.match(text, /discussion-101$/);
  } finally { await http.close(); }
});

test('overview keeps partial later pages and missing Bridge clocks out of exact metrics', async () => {
  const native = await producer();
  const http = handler({ close: native.close, async read(resource, params, signal) {
    const payload = await native.read(resource, params, signal);
    if (resource === 'run.agents') {
      const data = object(payload.data), items = data.items as unknown[];
      const second = Number(params?.offset) !== 0;
      return envelope(resource, { ...data, offset: second ? 1 : 0, limit: 200, items: second ? items.slice(1) : items.slice(0, 1),
        next_offset: second ? null : 1, complete: second, total: items.length }, second ? 'partial' : 'ok');
    }
    if (resource === 'bridge.deliveries' || resource === 'bridge.incidents') {
      const data = object(object(payload.data).data);
      const field = resource === 'bridge.deliveries' ? 'deliveries' : 'incidents';
      return envelope(resource, { ...object(payload.data), data: { ...data, scan_partial: field === 'deliveries',
        ...(field === 'incidents' ? { incidents: (data.incidents as object[]).map(row => ({ ...row, created_ms: null })) }
          : { deliveries: (data.deliveries as object[]).map(row => ({ ...row, accepted_at_ms: now - 1 })) }) } }, 'ok', '');
    }
    return payload;
  } });
  try {
    const result = (await get(http, 'overview', '/overview')).data;
    assert.equal(result.run?.active.kind, 'lower_bound');
    assert.equal(result.run?.started.kind, 'lower_bound');
    assert.equal(result.bridge?.accepted.kind, 'lower_bound');
    assert.equal(result.bridge?.incidents.kind, 'unknown');
  } finally { await http.close(); }
});

test('held route lists only accepted undelivered Bridge rows and keeps absent optional fields null', async () => {
  const native = await producer();
  const base = { publisher: 'claude', event_id: 'e', custody_state: 'pending' };
  const rows = [
    { ...base, acceptance_seq: 1, delivery_state: 'hook_submitted', accepted_at_ms: now - 7 * 3600_000 },
    { ...base, acceptance_seq: 2, delivery_state: 'held', accepted_at_ms: now - 6 * 3600_000, hold_reason: 'target unavailable', recipient: 'codex@host', attempts: 0, body: 'private text' },
    { ...base, acceptance_seq: 3, delivery_state: 'unhanded', accepted_at_ms: now - 60_000 },
    { ...base, acceptance_seq: 4, delivery_state: 'held', custody_state: 'refused', accepted_at_ms: now - 5 * 3600_000 },
    { ...base, acceptance_seq: 5, delivery_state: 'held', accepted_at_ms: null },
  ];
  const http = handler({ close: native.close, async read(resource, params, signal) {
    if (resource === 'bridge.deliveries') return envelope(resource, { schema_version: 1, kind: 'delivery_page',
      data: { deliveries: rows, through_seq: 5, next_after_seq: null, coverage: 'retained_history' } });
    return native.read(resource, params, signal);
  } });
  try {
    const result = (await get(http, 'held', '/bridge/held')).data;
    assert.equal(result.complete, true);
    assert.deepEqual(result.items, [
      { id: 'delivery-2', acceptedAtMs: now - 6 * 3600_000, state: 'held', holdReason: 'target unavailable', recipient: 'codex@host', attempts: 0 },
      { id: 'delivery-3', acceptedAtMs: now - 60_000, state: 'unhanded', holdReason: null, recipient: null, attempts: null },
    ]);
    assert.ok(!JSON.stringify(result).includes('private text'));
  } finally { await http.close(); }
});

/** A fake Bridge journal honoring the observer's ascending `after_seq`/`through_seq`/`limit` window contract. */
function journal(rows: Record<string, unknown>[], counts: Record<string, number> | null, calls: Record<string, unknown>[] = []) {
  const native = producer();
  return native.then(inner => ({ calls, http: handler({ close: inner.close, async read(resource, params, signal) {
    if (resource === 'bridge.overview') {
      if (counts === null) return envelope(resource, { schema_version: 1, kind: 'bridge_overview', data: { retention: {}, coverage: 'retained_history' } });
      return inner.read(resource, params, signal).then(payload => ({ ...payload, data: { ...object(payload.data), data: { ...object(object(payload.data).data), counts: { ...object(object(object(payload.data).data).counts), ...counts } } } }));
    }
    if (resource !== 'bridge.deliveries') return inner.read(resource, params, signal);
    calls.push({ ...params });
    const high = rows.length ? Number(rows.at(-1)!.acceptance_seq) : 0;
    const after = Number(params?.after_seq ?? 0), through = params?.through_seq === undefined ? high : Number(params.through_seq), limit = Number(params?.limit ?? 100);
    assert.ok(after === 0 || params?.through_seq !== undefined, 'a continuation needs through_seq');
    const window = rows.filter(row => Number(row.acceptance_seq) > after && Number(row.acceptance_seq) <= through);
    const page = window.slice(0, limit);
    return envelope(resource, { schema_version: 1, kind: 'delivery_page', data: { deliveries: page, through_seq: through,
      next_after_seq: window.length > limit ? Number(page.at(-1)!.acceptance_seq) : null, coverage: 'retained_history' } });
  } }) }));
}

const zeroCounts = { unhanded: 0, reserved: 0, invoking: 0, held: 0, review: 0 };
/** An accepted, already handed-over history row. */
const handed = (seq: number, base = 0) => ({ acceptance_seq: seq, publisher: 'claude', event_id: 'e' + seq, custody_state: 'accepted', delivery_state: 'hook_submitted', accepted_at_ms: now - base - (700 - seq) * 60_000 });
/** A pending held row accepted `minutes` ago. */
const stuck = (seq: number, minutes: number) => ({ acceptance_seq: seq, publisher: 'claude', event_id: 'e' + seq, custody_state: 'pending', delivery_state: 'held', accepted_at_ms: now - minutes * 60_000, recipient: 'codex@host' });

test('held route finds a new hold after more than 500 terminal rows by counting from the overview and scanning newest first', async () => {
  const rows = [...Array.from({ length: 600 }, (_, index) => handed(index + 1)), stuck(601, 30)];
  const { http, calls } = await journal(rows, { ...zeroCounts, held: 1 });
  try {
    const result = (await get(http, 'held', '/bridge/held')).data;
    assert.equal(result.pending, 1);
    assert.deepEqual(result.items.map(item => item.id), ['delivery-601']);
    assert.equal(result.complete, false);
    assert.deepEqual(calls, [{ limit: 1, after_seq: 0 }, ...[501, 401, 301, 201, 101].map(after => ({ limit: 100, after_seq: after, through_seq: after + 100 }))]);
    const alarm = heldAlarm(result.items, now, result.complete, undefined, { pending: result.pending, oldestScannedAtMs: result.oldestScannedAtMs });
    assert.equal(alarm?.count, 1);
    assert.equal(alarm?.partial, false);
    assert.equal(alarm?.complete, true);
  } finally { await http.close(); }
});

test('held route reports an overview total above the rows it saw; the unseen message stays in the alarm while its age is unknown', async () => {
  const rows = [stuck(1, 60 * 24 * 3), ...Array.from({ length: 600 }, (_, index) => handed(index + 2)), stuck(602, 45)];
  const { http } = await journal(rows, { ...zeroCounts, held: 2 });
  try {
    const result = (await get(http, 'held', '/bridge/held')).data;
    assert.equal(result.pending, 2);
    assert.deepEqual(result.items.map(item => item.id), ['delivery-602']);
    assert.equal(result.oldestScannedAtMs, now - (700 - 103) * 60_000);
    const state = heldState(result.items, now, result.complete, undefined, { pending: result.pending, oldestScannedAtMs: result.oldestScannedAtMs });
    assert.equal(state.alarm?.count, 2);
    assert.equal(state.alarm?.partial, true);
    assert.equal(state.alarm?.lines.length, 1);
    assert.equal(state.stale, 0);
  } finally { await http.close(); }
});

test('a three-week-old dead message beyond the scan is stale, not an alarm, while a new hold still alarms', async () => {
  const week = 7 * 24 * 3600_000;
  const rows = [stuck(1, 60 * 24 * 21), ...Array.from({ length: 600 }, (_, index) => handed(index + 2, 8 * 24 * 3600_000)), stuck(602, 45)];
  const { http } = await journal(rows, { ...zeroCounts, held: 2 });
  try {
    const result = (await get(http, 'held', '/bridge/held')).data;
    assert.ok(now - result.oldestScannedAtMs! > week);
    const state = heldState(result.items, now, result.complete, undefined, { pending: result.pending, oldestScannedAtMs: result.oldestScannedAtMs });
    assert.equal(state.alarm?.count, 1);
    assert.equal(state.stale, 1);
    assert.equal(state.alarm?.partial, false);
  } finally { await http.close(); }
});

test('held route scans a short history completely and counts review, reserved and invoking states', async () => {
  const rows = [handed(1), stuck(2, 30), handed(3)];
  const { http } = await journal(rows, { ...zeroCounts, held: 1, review: 2, reserved: 1, invoking: 3 });
  try {
    const result = (await get(http, 'held', '/bridge/held')).data;
    assert.equal(result.pending, 7);
    assert.equal(result.complete, true);
    assert.deepEqual(result.items.map(item => item.id), ['delivery-2']);
  } finally { await http.close(); }
});

test('held route against a Bridge without overview counts omits the total and still scans the rows', async () => {
  const { http } = await journal([handed(1), stuck(2, 30)], null);
  try {
    const result = (await get(http, 'held', '/bridge/held')).data;
    assert.equal(result.pending, undefined);
    assert.equal(result.complete, true);
    assert.deepEqual(result.items.map(item => item.id), ['delivery-2']);
    assert.equal(heldAlarm(result.items, now, result.complete, undefined, { pending: result.pending, oldestScannedAtMs: result.oldestScannedAtMs })?.count, 1);
  } finally { await http.close(); }
});

test('held route reports an incomplete scan and fails closed when Bridge is unavailable', async () => {
  const native = await producer();
  const incomplete = handler({ close: native.close, async read(resource, params, signal) {
    if (resource === 'bridge.deliveries') return envelope(resource, { schema_version: 1, kind: 'delivery_page',
      data: { deliveries: [], through_seq: 9, next_after_seq: null, scan_partial: true, coverage: 'retained_history' } });
    return native.read(resource, params, signal);
  } });
  const down = handler({ close: native.close, async read(resource, params, signal) {
    if (resource.startsWith('bridge.')) return envelope(resource, null, 'unavailable');
    return native.read(resource, params, signal);
  } });
  try {
    assert.deepEqual((await get(incomplete, 'held', '/bridge/held')).data, { items: [], complete: false, pending: 1, oldestScannedAtMs: null });
    assert.equal((await down.fetch(request(mount + '/bridge/held'))).status, 503);
  } finally { await incomplete.close(); await down.close(); }
});

test('HTTP Quota preserves optional account reset credits and existing windows', async () => {
  const native = await producer();
  const http = handler({ close: native.close, async read(resource, params, signal) {
    const result = await native.read(resource, params, signal);
    if (resource === 'quota.snapshot') {
      const [first] = object(result.data).accounts as Record<string, unknown>[];
      first.reset_credits = { known: true, available_count: 2, observed_at: 100, credits: [{
        id: 'credit', provider_kind: 'codex', label: 'Banked reset', scope: 'all',
        resets_left: 2, usable_now: true, granted_at: null, expires_at: 200,
      }] };
    }
    return result;
  } });
  try {
    const accounts = (await get(http, 'quota', '/quota')).data.snapshot?.accounts;
    assert.ok(accounts?.[0].windows.length);
    assert.deepEqual(accounts[0].resetCredits, { known: true, availableCount: 2, observedAtMs: 100000, credits: [{
      id: 'credit', providerKind: 'codex', label: 'Banked reset', scope: 'all',
      resetsLeft: 2, usableNow: true, grantedAtMs: null, expiresAtMs: 200000,
    }] });
    assert.equal(accounts[1].resetCredits, undefined);
  } finally { await http.close(); }
});

test('terminal Quota snapshot uses its own resource receipt when status is unavailable', async () => {
  const native = await producer();
  const http = handler({ close: native.close, async read(resource, params, signal) {
    if (resource === 'quota.status') return envelope(resource, null, 'unavailable');
    if (resource !== 'quota.snapshot') return native.read(resource, params, signal);
    return { ...await native.read(resource, params, signal), observed_at_ms: now + 40 };
  } });
  const client = createHttpClient(undefined, transport(http));
  try {
    const snapshot = await client.read('quota.snapshot');
    assert.ok(snapshot.data);
    assert.equal(snapshot.observed_at_ms, now + 40);
    const status = await client.read('quota.status');
    assert.equal(status.outcome, 'unavailable');
    assert.equal(status.observed_at_ms, now);
  } finally { await client.close(); await http.close(); }
});

test('HTTP caps shared finite requests and response bodies while admitting only valid streams', async () => {
  const source = await producer();
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  let holding = true, oversized = false, reads = 0;
  const http = handler({ close: source.close, async read(resource, params, signal) {
    if (resource === 'run.agents') {
      reads++;
      if (holding) await hold;
    }
    const value = await source.read(resource, params, signal);
    if (oversized && resource === 'run.agents') {
      const data = object(value.data);
      const row = object((data.items as unknown[])[0]);
      const items = Array.from({ length: 32 }, (_, index) => ({ ...row, agent_id: 'large-' + index, task_summary: 'w'.repeat(150_000) }));
      return envelope(resource, { ...data, items, total: items.length });
    }
    return value;
  } });
  const pending = Array.from({ length: 24 }, () => http.fetch(request(mount + '/sessions')));
  try {
    let streams = 0;
    const admitted = () => streams++;
    assert.equal((await http.fetch(request(mount + '/sessions'))).status, 429);
    assert.equal((await http.fetch(request(mount + '/events?topic=invalid'), admitted)).status, 400);
    assert.equal((await http.fetch(request(mount + '/events?topic=sessions', { method: 'HEAD' }), admitted)).status, 405);
    const stream = await http.fetch(request(mount + '/events?topic=sessions'), admitted);
    assert.equal(stream.status, 200);
    assert.equal(streams, 1);
    await stream.body!.cancel();
    await Promise.resolve();
    assert.equal(reads, 1, 'identical native requests remain coalesced');
    holding = false;
    release();
    assert.ok((await Promise.all(pending)).every(response => response.status === 200));
    oversized = true;
    assert.equal((await http.fetch(request(mount + '/sessions?limit=32'))).status, 502);
  } finally {
    release();
    await Promise.allSettled(pending);
    await http.close();
  }
});

test('overview receipts before a period are unknown and incomplete closed periods are lower bounds', async () => {
  const native = await producer();
  const http = handler({ close: native.close, async read(resource, params, signal) {
    const value = await native.read(resource, params, signal);
    if (resource === 'run.agents') {
      const data = object(value.data);
      return envelope(resource, { ...data, items: (data.items as object[]).map(row => ({
        ...row, created_at: now / 1000 - 1, finished_at: now / 1000 - 1,
      })) });
    }
    return { ...value, observed_at_ms: now };
  } });
  try {
    const stale = (await get(http, 'overview', '/overview?from=' + (now + 1) + '&to=' + (now + 1000))).data;
    for (const field of ['started', 'finished', 'succeeded', 'failed'] as const) assert.equal(stale.run?.[field].kind, 'unknown');
    assert.equal(stale.bridge?.accepted.kind, 'unknown');
    const incomplete = (await get(http, 'overview', '/overview?from=' + (now - 2000) + '&to=' + (now + 1000))).data;
    assert.equal(incomplete.run?.started.kind, 'lower_bound');
    assert.ok((incomplete.run?.started.value ?? 0) > 0);
    const complete = (await get(http, 'overview', '/overview?from=' + (now - 2000) + '&to=' + now)).data;
    assert.equal(complete.run?.started.kind, 'exact');
  } finally { await http.close(); }
});

test('verifiedResult distinguishes unavailable discovery from explicit absence', async () => {
  const native = await producer();
  let discovery: string = 'unavailable';
  let answerReads = 0;
  const http = handler({ close: native.close, async read(resource, params, signal) {
    const value = await native.read(resource, params, signal);
    if (resource === 'run.answer' || resource === 'run.answer_chunk') answerReads++;
    if (resource !== 'run.identity') return value;
    if (discovery === 'unavailable') return envelope(resource, null, 'unavailable');
    if (discovery === 'absent') return { ...value, data: { ...object(value.data), tools: [] } };
    return value;
  } });
  try {
    const path = '/sessions/demo-finished';
    for (const scenario of [
      { discovery: 'unavailable', capability: 'unknown', status: 503, code: 'source_unavailable', retryable: true },
      { discovery: 'absent', capability: 'unsupported', status: 422, code: 'unsupported_capability', retryable: false },
    ]) {
      discovery = scenario.discovery;
      const detail = await get(http, 'session', path);
      assert.equal(detail.data.session.answerAvailable, true);
      assert.equal(detail.capabilities?.verifiedResult, scenario.capability);
      const result = await http.fetch(request(mount + path + '/result'));
      assert.equal(result.status, scenario.status);
      const { error } = apiError(await result.json());
      assert.equal(error.code, scenario.code);
      assert.equal(error.retryable, scenario.retryable);
    }
    assert.equal(answerReads, 0);
    discovery = 'supported';
    assert.equal((await get(http, 'session', path)).capabilities?.verifiedResult, 'supported');
  } finally { await http.close(); }
});

test('pool lifecycle is filtered before paging while raw closure filters remain available', async () => {
  const native = await producer();
  const rows = [
    { ...poolView.pool, pool_id: 'a-completed', kind: 'chat', completion_id: 'agreement-1' },
    { ...poolView.pool, pool_id: 'b-live', kind: 'chat', completion_id: null },
    { ...poolView.pool, pool_id: 'c-closed', closed: true },
  ].map(pool => ({ pool: { ...pool, purpose: 'review' }, leader_id: 'leader', roster: [] }));
  const http = handler({
    ...native,
    async read(resource, params, signal) {
      if (resource === 'pool.identity') return envelope(resource, { schema_version: 1, kind: 'identity', data: { capabilities: ['inventory_snapshot_v1'] } });
      if (resource === 'pool.inventory_snapshot') return envelope(resource, { schema_version: 1, kind: 'inventory_snapshot', data: {
        source: { store_id: 's', read_epoch: 'e', revision: '4' },
        totals: { total: '3', closed: '1', unknown: '0', open: '2', completed: '1' },
        coverage: 'fixture', pools: rows, returned: rows.length, has_more: false, next_cursor: null, observed_at_unix_ms: now,
      } });
      return native.read(resource, params, signal);
    },
  });
  const terminal = createHttpClient(undefined, transport(http));
  try {
    const live = await get(http, 'pools', '/pools?state=live&limit=1');
    assert.deepEqual(live.data.items.map(row => row.id), ['b-live']);
    assert.equal(live.page.next, null);
    assert.equal(live.data.totals?.live, '1');
    const finished = await get(http, 'pools', '/pools?state=finished&limit=1&q=review');
    assert.deepEqual(finished.data.items.map(row => [row.id, row.state, row.record?.kind]), [['a-completed', 'open', 'agreement']]);
    assert.ok(finished.page.next);
    const next = await get(http, 'pools', '/pools?state=finished&limit=1&q=review&cursor=' + encodeURIComponent(finished.page.next));
    assert.deepEqual(next.data.items.map(row => row.id), ['c-closed']);
    assert.equal(next.page.next, null);
    assert.deepEqual((await get(http, 'pools', '/pools?state=open')).data.items.map(row => row.id), ['a-completed', 'b-live']);
    assert.deepEqual((await get(http, 'pools', '/pools?state=closed')).data.items.map(row => row.id), ['c-closed']);
    const result = await terminal.read('pool.list');
    const groups = groupPools(poolInventory(result.data, null).items, '');
    assert.equal(groups.live.loaded, 1);
    assert.equal(groups.finished.loaded, 2);
  } finally {
    await terminal.close();
    await http.close();
  }
});

test('Pool custody reaches the matching waiting session and Pool member through both HTTP routes', async () => {
  const native = await producer();
  const seat = { ...chat.seats[0], held_message_count: 3, oldest_held_message_at_ms: now - 600_000 };
  const expected = { count: 3, oldestAtMs: now - 600_000 };
  let supported = true;
  const http = handler({
    ...native,
    async read(resource, params, signal) {
      if (resource === 'pool.identity') return envelope(resource, { schema_version: 1, kind: 'identity', data: {
        capabilities: ['observer_socket_v1', 'inventory_snapshot_v1', ...(supported ? ['seat_held_messages_v1'] : [])],
      } });
      if (resource === 'pool.inventory_snapshot') {
        assert.equal(supported, true);
        assert.equal(params?.filter, 'not_closed');
        return envelope(resource, { schema_version: 1, kind: 'inventory_snapshot', data: {
          source: { store_id: 's', read_epoch: 'e', revision: '1' },
          totals: { total: '1', closed: '0', unknown: '0', open: '1', completed: '0' },
          coverage: 'fixture', pools: [{ pool: { ...poolView.pool, purpose: 'review', kind: 'chat' }, roster: [seat], leader_id: 'leader' }],
          returned: 1, has_more: false, next_cursor: null, observed_at_unix_ms: now,
        } });
      }
      if (resource === 'pool.get' && params?.section === 'members') return envelope(resource, {
        schema_version: 1, kind: 'pool_detail', data: {
          section: 'members', source_timestamp: null, cursor: '1', has_more: false, returned: 1, decisions: [],
          view: { ...poolView, members: [seat], section: 'members', next_after: 1 },
        },
      });
      const result = await native.read(resource, params, signal);
      if (resource !== 'run.agents') return result;
      return envelope(resource, { ...object(result.data), items: (object(result.data).items as unknown[]).map(value => {
        const row = object(value);
        return row.agent_id === seat.run_agent_id ? { ...row, phase: 'idle' } : row;
      }) });
    },
  });
  try {
    const sessions = await get(http, 'sessions', '/sessions');
    assert.deepEqual(sessions.data.items.filter(row => row.heldMessages).map(row => [row.id, row.heldMessages]), [[seat.run_agent_id, expected]]);
    const members = await get(http, 'poolSection', '/pools/demo-pool/sections/members');
    assert.equal(members.data.section, 'members');
    assert.deepEqual(members.data.items[0].heldMessages, expected);
    supported = false;
    assert.ok((await get(http, 'sessions', '/sessions')).data.items.every(row => row.heldMessages === undefined));
  } finally {
    await http.close();
  }
});
