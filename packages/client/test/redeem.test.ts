/** Redeem client, polling policy and outcome mapping. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { REDEEM_HEADER, REDEEM_HEADER_VALUE, redeemRequest, type RedeemRecord } from '../../domain/src/index.ts';
import { HubHttpError } from '../src/index.ts';
import { awaitRedeem, createRedeemClient, redeemOutcome, REDEEM_POLL } from '../src/redeem.ts';

const id = '5b0e8c1e-61d1-4c2b-9f7e-0a3a8f4f6b11';
const base: RedeemRecord = { request_id: id, account: 'acct', credit_id: 'c1', state: 'pending', reason: null, created_at: 1, updated_at: 1 };

/** Deterministic clock whose sleep advances time and records the requested delays. */
function clock() {
  let at = 0;
  const delays: number[] = [];
  return { delays, now: () => at, sleep: async (ms: number) => { delays.push(ms); at += ms; } };
}

test('the policy is a 2 s cadence for about a minute', () => {
  assert.deepEqual(REDEEM_POLL, { intervalMs: 2000, timeoutMs: 60000 });
});

test('a settled record is returned without polling, a pending one polls every 2 s until it settles', async () => {
  const time = clock();
  const calls: string[] = [];
  assert.equal((await awaitRedeem({ ...base, state: 'redeemed' }, { status: async () => { throw new Error('no'); }, ...time })).state, 'redeemed');
  const updates: string[] = [];
  const result = await awaitRedeem(base, {
    ...time, onUpdate: record => updates.push(record.state),
    status: async requestId => { calls.push(requestId); return { ...base, state: calls.length < 3 ? 'pending' : 'redeemed' }; },
  });
  assert.equal(result.state, 'redeemed');
  assert.deepEqual(time.delays, [2000, 2000, 2000]);
  assert.deepEqual(calls, [id, id, id]);
  assert.deepEqual(updates, ['pending', 'pending', 'redeemed']);
});

test('rejected and failed outcomes keep their reason', async () => {
  const time = clock();
  const result = await awaitRedeem(base, { ...time, status: async () => ({ ...base, state: 'rejected', reason: 'credit_expired' }) });
  assert.deepEqual(redeemOutcome(result), { kind: 'failed', reason: 'credit_expired' });
  assert.deepEqual(redeemOutcome({ ...base, state: 'failed', reason: null }), { kind: 'failed', reason: null });
});

test('read failures are tolerated and the deadline yields an unknown outcome', async () => {
  const time = clock();
  let reads = 0;
  const result = await awaitRedeem(base, { ...time, status: async () => { reads++; throw new HubHttpError('network_unavailable', 0); } });
  assert.equal(result.state, 'unknown');
  assert.equal(result.reason, 'timeout');
  assert.equal(reads, 30);
  assert.deepEqual(redeemOutcome(result), { kind: 'unknown' });
  const stuck = await awaitRedeem(base, { ...clock(), status: async () => base });
  assert.equal(stuck.state, 'unknown');
});

test('an aborted wait stops without a result', async () => {
  const controller = new AbortController();
  const time = clock();
  await assert.rejects(awaitRedeem(base, {
    ...time, signal: controller.signal,
    status: async () => { controller.abort(); throw new Error('aborted'); },
  }));
});

test('the POST carries the action header, JSON body and the status GET carries no body', async () => {
  const seen: { url: string; init?: RequestInit }[] = [];
  const client = createRedeemClient({
    baseUrl: 'https://hub.example',
    fetch: async (input, init) => {
      seen.push({ url: String(input), init });
      return Response.json(base);
    },
  });
  assert.equal((await client.redeem('acct', 'c1')).request_id, id);
  assert.equal((await client.status(id)).state, 'pending');
  assert.equal(seen[0]!.url, 'https://hub.example/api/v1/quota/redeem');
  assert.equal(seen[0]!.init?.method, 'POST');
  assert.deepEqual(JSON.parse(seen[0]!.init?.body as string), { account: 'acct', credit_id: 'c1' });
  const headers = seen[0]!.init?.headers as Record<string, string>;
  assert.equal(headers[REDEEM_HEADER], REDEEM_HEADER_VALUE);
  assert.equal(headers['Content-Type'], 'application/json');
  assert.equal(seen[1]!.url, 'https://hub.example/api/v1/quota/redeem/' + id);
  assert.equal(seen[1]!.init?.method, 'GET');
  assert.equal(seen[1]!.init?.body, undefined);
  await assert.rejects(client.status('../x'));
});

test('server refusals surface their machine code', async () => {
  const client = createRedeemClient({
    baseUrl: 'https://hub.example',
    fetch: async () => Response.json({ error: { code: 'forbidden', message: 'x', requestId: 'r1', retryable: false } }, { status: 403 }),
  });
  await assert.rejects(client.redeem('acct', 'c1'), error => error instanceof HubHttpError && error.code === 'forbidden' && error.status === 403);
});

test('request validation accepts only the two bounded fields', () => {
  assert.deepEqual(redeemRequest({ account: 'a-b_1@x', credit_id: 'c:1' }), { account: 'a-b_1@x', credit_id: 'c:1' });
  for (const bad of [null, [], {}, { account: 'a' }, { account: 'a', credit_id: 'c', x: 1 }, { account: 'a b', credit_id: 'c' }, { account: 'a', credit_id: '' }]) {
    assert.throws(() => redeemRequest(bad));
  }
});
