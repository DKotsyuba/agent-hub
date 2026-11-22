/** Package B acceptance tests with deterministic producer-shaped reads. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { API_RESPONSES, apiError, event, type ApiResponse } from '@agent-hub/domain';
import { createDemoClient } from '../../terminal/src/demo.ts';
import runStatus from '../../terminal/test/fixtures/run-status-v1.json';
import chat from '../../terminal/test/fixtures/pool-chat-v1.json';
import { object, sha256 } from '../../src/live/protocol.ts';
import { createHttp } from '../src/http.ts';
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
    assert.equal((await get(http, 'poolSection', '/pools/demo-pool/sections/members')).data.items.length, 1);
    assert.equal((await get(http, 'poolHistory', '/pools/demo-pool/history')).data.items.length, 1);
    assert.equal((await get(http, 'poolContent', '/pools/demo-pool/content/purpose')).data.content.text, 'A pinned synthetic goal.');
    assert.equal((await get(http, 'quota', '/quota')).data.snapshot?.accounts.length, 2);
    const trees = await get(http, 'worktrees', '/worktrees');
    const main = trees.data.items.find(item => item.path === '/demo/agent-hub')!;
    assert.equal((await get(http, 'worktree', '/worktrees/' + main.id)).data.worktree.facts.size.state, 'known');
    assert.equal((await get(http, 'incidents', '/bridge/incidents')).data.items.length, 1);
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

test('serves a deep link and hashed assets while bounding files to the build root', async () => {
  const directory = await mkdtemp(join(process.env.TMPDIR!, 'http-test-'));
  const web = join(directory, 'web');
  await mkdir(join(web, 'assets'), { recursive: true });
  await writeFile(join(web, 'index.html'), '<title>fixture app</title>');
  await writeFile(join(web, 'assets', 'page-C3rrC30X.js'), 'export {};');
  await writeFile(join(directory, 'outside.txt'), 'outside the build');
  await symlink(join(directory, 'outside.txt'), join(web, 'outside.txt'));
  const http = handler(await producer(), web);
  try {
    const entry = await http.fetch(request('/sessions/demo-finished/history'));
    assert.equal(await entry.text(), '<title>fixture app</title>');
    assert.equal(entry.headers.get('Cache-Control'), 'no-cache');
    const asset = await http.fetch(request('/assets/page-C3rrC30X.js'));
    assert.match(asset.headers.get('Cache-Control') ?? '', /immutable/);
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
    assert.ok(token?.startsWith('bound-'));
    const path = '/sessions/' + selector.agent_id;
    const initial = await get(http, 'initialTask', path + '/initial-task?execution=' + token);
    assert.equal(initial.data.state === 'verified' && initial.data.proof.kind, 'strict');
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
