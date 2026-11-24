/** Redeem action tests against a fake Agent Quota Unix socket. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type Server, type Socket } from 'node:net';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REDEEM_HEADER, REDEEM_HEADER_VALUE, REDEEM_PATH, redeemRecord } from '@agent-hub/domain';
import { createHttp } from '../src/http.ts';
import { createQuotaRedeemClient, createRedeemService, resolveQuotaEndpoint } from '../src/redeem.ts';
import type { NativeResponse, ObservationClient } from '../src/observer.ts';

const ORIGIN = 'https://hub.example';
const uuid4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A read-only observer that is never expected to be used by redeem routes. */
const observer: ObservationClient = {
  async read(resource): Promise<NativeResponse> { throw new Error('observer must not be used: ' + resource); },
  async close() {},
};

/** What the fake Quota does with one request line. */
type Behavior = (request: Record<string, unknown>, socket: Socket) => unknown;

/** Starts a fake Quota socket owned by the current user, recording every received request. */
async function fakeQuota(behavior: Behavior) {
  const directory = await mkdtemp(join(tmpdir(), 'hub-redeem-'));
  await chmod(directory, 0o750);
  const path = join(directory, 'quota.sock');
  const requests: Record<string, unknown>[] = [];
  const server: Server = createServer(socket => {
    let buffer = '';
    socket.on('error', () => {});
    socket.on('data', chunk => {
      buffer += chunk.toString();
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      const request = JSON.parse(buffer.slice(0, end)) as Record<string, unknown>;
      requests.push(request);
      const reply = behavior(request, socket);
      if (reply === 'close') socket.destroy();
      else if (reply === 'garbage') socket.end('not json\n');
      else if (reply !== 'hang') socket.end(JSON.stringify(reply) + '\n');
    });
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  await chmod(path, 0o660);
  return {
    path, requests, uid: process.getuid!(),
    async close() { server.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

/** Builds a record for a request, as Agent Quota replies. */
function record(request: Record<string, unknown>, state: string, reason: string | null = null) {
  return { request_id: request.request_id, account: request.account, credit_id: request.credit_id, state, reason, created_at: 100, updated_at: 101 };
}

/** Standard fake: redeem → pending, then status reports the configured final state. */
function lifecycle(final: { state: string; reason?: string | null }): Behavior {
  const seen = new Map<string, Record<string, unknown>>();
  return request => {
    if (request.method === 'redeem_reset_credit') { seen.set(request.request_id as string, request); return record(request, 'pending'); }
    const original = seen.get(request.request_id as string);
    return original ? record(original, final.state, final.reason ?? null) : { version: 1, error: 'unknown_request' };
  };
}

/** Wires the real HTTP handler to the real narrow client and a fake Quota. */
async function setup(behavior: Behavior, options: { missing?: boolean } = {}) {
  const quota = await fakeQuota(behavior);
  const endpoint = { socket: options.missing ? quota.path + '.absent' : quota.path, uid: quota.uid };
  const redeem = createRedeemService(createQuotaRedeemClient(async () => endpoint, 1000));
  const http = createHttp(observer, { localHost: 'localhost', publicOrigin: ORIGIN, release: 'test', webRoot: '/does-not-exist', redeem });
  const log = console.error;
  const lines: string[] = [];
  console.error = (line: string) => { lines.push(String(line)); };
  return {
    quota, http, lines,
    async close() { console.error = log; await http.close(); await quota.close(); },
  };
}

/** Sends a redeem POST with all protections by default; overrides remove or alter them. */
function post(http: ReturnType<typeof createHttp>, body: unknown, headers: Record<string, string | null> = {}) {
  const base: Record<string, string> = { Host: 'localhost', Origin: ORIGIN, 'Content-Type': 'application/json', [REDEEM_HEADER]: REDEEM_HEADER_VALUE };
  for (const [key, value] of Object.entries(headers)) { if (value === null) delete base[key]; else base[key] = value; }
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return http.fetch(new Request('http://localhost' + REDEEM_PATH, { method: 'POST', headers: base, body: text }));
}

const credit = { account: 'acct-test', credit_id: 'credit-1' };

test('redeem sends the exact Quota op with a server-generated UUID v4 and returns the record', async () => {
  const env = await setup(lifecycle({ state: 'redeemed' }));
  try {
    const response = await post(env.http, credit);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = redeemRecord(await response.json());
    assert.equal(body.state, 'pending');
    assert.equal(env.quota.requests.length, 1);
    const sent = env.quota.requests[0]!;
    assert.deepEqual(Object.keys(sent).sort(), ['account', 'credit_id', 'method', 'request_id', 'version']);
    assert.equal(sent.method, 'redeem_reset_credit');
    assert.match(sent.request_id as string, uuid4);
    assert.equal(body.request_id, sent.request_id);
    const status = await env.http.fetch(new Request('http://localhost' + REDEEM_PATH + '/' + body.request_id, { headers: { Host: 'localhost' } }));
    assert.equal(status.status, 200);
    assert.equal(redeemRecord(await status.json()).state, 'redeemed');
    assert.deepEqual(env.quota.requests[1], { version: 1, method: 'redeem_status', request_id: body.request_id });
    assert.ok(env.lines.some(line => line.includes('"event":"quota_redeem"') && line.includes(body.request_id) && line.includes('acct-test')));
  } finally { await env.close(); }
});

test('a rejected redemption carries its reason, and the envelope form is accepted', async () => {
  const env = await setup(request => ({ version: 1, result: record(request, 'rejected', 'credit_expired') }));
  try {
    const body = redeemRecord(await (await post(env.http, credit)).json());
    assert.equal(body.state, 'rejected');
    assert.equal(body.reason, 'credit_expired');
  } finally { await env.close(); }
});

test('a Quota permission error becomes 403 and is not retried', async () => {
  const env = await setup(() => ({ version: 1, error: 'forbidden' }));
  try {
    const response = await post(env.http, credit);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'forbidden');
    assert.equal(env.quota.requests.length, 1);
    assert.ok(env.lines.some(line => line.includes('forbidden')));
  } finally { await env.close(); }
});

test('a dropped connection after sending is unknown and a retry asks about the same request ID', async () => {
  let drop = true;
  const env = await setup((request, socket) => {
    if (request.method === 'redeem_reset_credit') return drop ? 'close' : record(request, 'pending');
    socket.destroy();
    return 'close';
  });
  try {
    const first = redeemRecord(await (await post(env.http, credit)).json());
    assert.equal(first.state, 'unknown');
    assert.match(first.request_id, uuid4);
    drop = false;
    const second = redeemRecord(await (await post(env.http, credit)).json());
    assert.equal(second.request_id, first.request_id);
    assert.equal(second.state, 'unknown');
    assert.equal(env.quota.requests.filter(request => request.method === 'redeem_reset_credit').length, 1);
    assert.equal(env.quota.requests.at(-1)!.method, 'redeem_status');
    assert.equal(env.quota.requests.at(-1)!.request_id, first.request_id);
  } finally { await env.close(); }
});

test('malformed or mismatched replies are unknown, never a success', async () => {
  for (const reply of ['garbage', { ...record({ request_id: '00000000-0000-4000-8000-000000000000', account: 'acct-test', credit_id: 'credit-1' }, 'redeemed') }, { version: 1, error: 'internal secret=abc' }] as const) {
    const env = await setup(() => reply);
    try {
      const response = await post(env.http, credit);
      assert.equal(response.status, 200);
      const body = redeemRecord(await response.json());
      assert.equal(body.state, 'unknown');
      assert.doesNotMatch(JSON.stringify(body), /secret/);
    } finally { await env.close(); }
  }
});

test('an unreachable Quota socket is a safe, retryable failure with no request in flight', async () => {
  const env = await setup(() => 'hang', { missing: true });
  try {
    const body = redeemRecord(await (await post(env.http, credit)).json());
    assert.equal(body.state, 'failed');
    assert.equal(body.reason, 'quota_unavailable');
    assert.equal(env.quota.requests.length, 0);
  } finally { await env.close(); }
});

test('a silent Quota times out as unknown', async () => {
  const env = await setup(() => 'hang');
  try {
    const body = redeemRecord(await (await post(env.http, credit)).json());
    assert.equal(body.state, 'unknown');
  } finally { await env.close(); }
});

test('origin, header, content type and fetch-metadata refusals never reach Quota', async () => {
  const env = await setup(lifecycle({ state: 'redeemed' }));
  try {
    const cases: [string, Record<string, string | null>, number][] = [
      ['no Origin', { Origin: null }, 403],
      ['foreign Origin', { Origin: 'https://evil.example' }, 400],
      ['foreign Host', { Host: 'evil.example' }, 400],
      ['no action header', { [REDEEM_HEADER]: null }, 403],
      ['wrong action header', { [REDEEM_HEADER]: 'other' }, 403],
      ['cross-site fetch metadata', { 'Sec-Fetch-Site': 'cross-site' }, 403],
      ['same-site fetch metadata', { 'Sec-Fetch-Site': 'same-site' }, 403],
      ['form content type', { 'Content-Type': 'application/x-www-form-urlencoded' }, 400],
      ['text content type', { 'Content-Type': 'text/plain' }, 400],
      ['no content type', { 'Content-Type': null }, 400],
    ];
    for (const [name, headers, status] of cases) {
      const response = await post(env.http, credit, headers);
      assert.equal(response.status, status, name);
    }
    const ok = await post(env.http, credit, { 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json; charset=utf-8' });
    assert.equal(ok.status, 200);
    assert.equal(env.quota.requests.length, 1);
  } finally { await env.close(); }
});

test('strict input validation rejects before contacting Quota', async () => {
  const env = await setup(lifecycle({ state: 'redeemed' }));
  try {
    const bad: unknown[] = [
      '', 'not json', '[]', 'null', '"x"', {}, { account: 'a' }, { credit_id: 'c' },
      { ...credit, extra: 1 }, { ...credit, request_id: '00000000-0000-4000-8000-000000000000' },
      { account: 1, credit_id: 'c' }, { account: '', credit_id: 'c' }, { account: 'a b', credit_id: 'c' },
      { account: '../x', credit_id: 'c' }, { account: 'a\n', credit_id: 'c' }, { account: 'a', credit_id: '-leading' },
      { account: 'a'.repeat(129), credit_id: 'c' }, { account: 'a', credit_id: 'c'.repeat(129) },
      { account: 'a', credit_id: 'c', pad: 'x'.repeat(1100) }, '{"account":"a","account":"b","credit_id":"c","credit_id":"d"}'.replace('"b"', '"b", "x":1'),
    ];
    for (const body of bad) assert.equal((await post(env.http, body)).status, 400, JSON.stringify(body)?.slice(0, 60));
    const query = await env.http.fetch(new Request('http://localhost' + REDEEM_PATH + '?x=1', { method: 'POST',
      headers: { Host: 'localhost', Origin: ORIGIN, 'Content-Type': 'application/json', [REDEEM_HEADER]: REDEEM_HEADER_VALUE }, body: JSON.stringify(credit) }));
    assert.equal(query.status, 400);
    assert.equal(env.quota.requests.length, 0);
  } finally { await env.close(); }
});

test('double submit returns the existing attempt, including concurrent submissions', async () => {
  const env = await setup(lifecycle({ state: 'pending' }));
  try {
    const [a, b, c] = await Promise.all([post(env.http, credit), post(env.http, credit), post(env.http, credit)]);
    const ids = new Set((await Promise.all([a, b, c].map(async response => redeemRecord(await response.json())))).map(item => item.request_id));
    assert.equal(ids.size, 1);
    const later = redeemRecord(await (await post(env.http, credit)).json());
    assert.ok(ids.has(later.request_id));
    assert.equal(env.quota.requests.filter(request => request.method === 'redeem_reset_credit').length, 1);
    // A different credit is an independent attempt.
    const other = redeemRecord(await (await post(env.http, { ...credit, credit_id: 'credit-2' })).json());
    assert.ok(!ids.has(other.request_id));
  } finally { await env.close(); }
});

test('a redeemed credit is not spent again, but a rejected attempt can be retried', async () => {
  const done = await setup(lifecycle({ state: 'redeemed' }));
  try {
    const first = redeemRecord(await (await post(done.http, credit)).json());
    const again = redeemRecord(await (await post(done.http, credit)).json());
    assert.equal(again.request_id, first.request_id);
    assert.equal(again.state, 'redeemed');
    assert.equal(done.quota.requests.filter(request => request.method === 'redeem_reset_credit').length, 1);
  } finally { await done.close(); }
  const rejected = await setup(lifecycle({ state: 'rejected', reason: 'nope' }));
  try {
    const first = redeemRecord(await (await post(rejected.http, credit)).json());
    const retry = redeemRecord(await (await post(rejected.http, credit)).json());
    assert.notEqual(retry.request_id, first.request_id);
  } finally { await rejected.close(); }
});

test('status reads validate the ID, fall back to the last known record and report permission errors', async () => {
  let reachable = true;
  const env = await setup((request, socket) => {
    if (!reachable) { socket.destroy(); return 'close'; }
    return lifecycle({ state: 'redeemed' })(request, socket);
  });
  try {
    const first = redeemRecord(await (await post(env.http, credit)).json());
    const get = (id: string) => env.http.fetch(new Request('http://localhost' + REDEEM_PATH + '/' + id, { headers: { Host: 'localhost' } }));
    assert.equal((await get('not-a-uuid')).status, 400);
    assert.equal((await get('00000000-0000-1000-8000-000000000000')).status, 400);
    reachable = false;
    const cached = redeemRecord(await (await get(first.request_id)).json());
    assert.equal(cached.state, 'unknown');
    assert.equal(cached.request_id, first.request_id);
    assert.equal((await get('00000000-0000-4000-8000-000000000000')).status, 503);
  } finally { await env.close(); }
  const denied = await setup(() => ({ version: 1, error: 'unauthorized' }));
  try {
    const response = await denied.http.fetch(new Request('http://localhost' + REDEEM_PATH + '/00000000-0000-4000-8000-000000000000', { headers: { Host: 'localhost' } }));
    assert.equal(response.status, 403);
  } finally { await denied.close(); }
});

test('without a redeem capability the server stays read-only and other POSTs stay refused', async () => {
  const http = createHttp(observer, { localHost: 'localhost', publicOrigin: ORIGIN, release: 'test', webRoot: '/does-not-exist' });
  try {
    assert.equal((await post(http, credit)).status, 422);
    const other = await http.fetch(new Request('http://localhost/api/v1/quota', { method: 'POST', headers: { Host: 'localhost', Origin: ORIGIN } }));
    assert.equal(other.status, 405);
    const put = await http.fetch(new Request('http://localhost' + REDEEM_PATH, { method: 'PUT', headers: { Host: 'localhost', Origin: ORIGIN } }));
    assert.equal(put.status, 405);
  } finally { await http.close(); }
});

test('the Quota endpoint follows the observer configuration order', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hub-redeem-config-'));
  try {
    const config = join(directory, 'connections.json');
    await writeFile(config, JSON.stringify({ schema_version: 1, quota: { socket: '/run/custom/q.sock', server_uid: 42 } }));
    assert.deepEqual(await resolveQuotaEndpoint({ AGENT_HUB_CONFIG: config }, 'linux'), { socket: '/run/custom/q.sock', uid: 42 });
    await writeFile(config, JSON.stringify({ schema_version: 1 }));
    assert.deepEqual(await resolveQuotaEndpoint({ AGENT_HUB_CONFIG: config }, 'linux'), { socket: '/run/agent-quota/quota.sock', uid: 999 });
    assert.equal(await resolveQuotaEndpoint({ AGENT_HUB_CONFIG: config }, 'darwin'), null);
    await writeFile(config, JSON.stringify({ schema_version: 1, quota: { socket: 'relative.sock', server_uid: 1 } }));
    assert.equal(await resolveQuotaEndpoint({ AGENT_HUB_CONFIG: config }, 'linux'), null);
    await writeFile(config, JSON.stringify({ schema_version: 1, quota: { socket: '/run/x.sock' } }));
    assert.equal(await resolveQuotaEndpoint({ AGENT_HUB_CONFIG: config }, 'linux'), null);
    assert.equal(await resolveQuotaEndpoint({ AGENT_HUB_CONFIG: join(directory, 'missing.json') }, 'linux'), null);
    assert.equal(await resolveQuotaEndpoint({ AGENT_HUB_CONFIG: 'relative.json' }, 'linux'), null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('an endpoint owned by another uid or reachable by others is not trusted', async () => {
  const quota = await fakeQuota(lifecycle({ state: 'redeemed' }));
  try {
    const wrongUid = createRedeemService(createQuotaRedeemClient(async () => ({ socket: quota.path, uid: quota.uid + 1 }), 1000));
    assert.equal((await wrongUid.submit('acct-test', 'credit-1')).reason, 'quota_unavailable');
    await chmod(quota.path, 0o666);
    const open = createRedeemService(createQuotaRedeemClient(async () => ({ socket: quota.path, uid: quota.uid }), 1000));
    assert.equal((await open.submit('acct-test', 'credit-1')).state, 'failed');
    assert.equal(quota.requests.length, 0);
  } finally { await quota.close(); }
});
