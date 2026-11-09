/** Exercises the Run `initial_task` v1 consumer against a synthetic producer; no Run process is contacted. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { ReadResponse } from '../src/api.ts';
import { initialTaskCapability, initialTaskLabel, readInitialTask } from '../src/initial-task.ts';
import type { InitialTaskCapability, InitialTaskRequest, InitialTaskResult } from '../src/initial-task.ts';

type Json = Record<string, any>;
const STORE = `store_${'1'.repeat(32)}`, REF = `ex1_${'a'.repeat(64)}`, PIN = `pin_${'0'.repeat(12)}40008000${'0'.repeat(12)}`, AGENT = 'ag-20261109-120000-0123456789';
const capability: InitialTaskCapability = { modes: ['strict', 'current'], maxTaskBytes: 524288, maxPageBytes: 65536 };
const strictRequest: InitialTaskRequest = { mode: 'strict', agentId: AGENT, storeId: STORE, executionRef: REF, pinId: PIN };
const currentRequest: InitialTaskRequest = { mode: 'current', agentId: AGENT };
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

/** Multi-byte text: 2-, 3- and 4-byte characters, a newline and a tab, longer than three small pages. */
const TASK = `Résumé the migration — 日本語のタスク 🚀\n\tstep ${'ü漢🙂'.repeat(40)} end`;

/** Wraps a producer result in the native read response the observer returns. */
function native(data: unknown, outcome: ReadResponse['outcome'] = 'ok', error: ReadResponse['error'] = null): ReadResponse {
  return { schema_version: 1, source: 'run', resource: 'run.initial_task', observed_at_ms: 1, outcome, data: error ? null : data, error };
}

/** Returns the producer's page for `text`, splitting only at UTF-8 character boundaries like the contract. */
function page(text: string, params: Json, mode: 'strict' | 'current', overrides: Json = {}): Json {
  const bytes = Buffer.from(text), offset = params.offset ?? 0;
  let end = Math.min(bytes.length, offset + (params.max_bytes ?? 65536));
  while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  const body = bytes.subarray(offset, end).toString('utf8');
  return {
    state: 'available', version: 1, mode, store_id: STORE, agent_id: AGENT, sequence: 1, execution_ref: REF, ...(mode === 'strict' ? { pin_id: PIN } : {}),
    total_bytes: bytes.length, sha256: digest(text), offset, end, next_offset: end < bytes.length ? end : null, text: body, complete: end === bytes.length, ...overrides,
  };
}

/** A recording producer; `mutate` may replace or alter any page. */
function producer(text: string, mode: 'strict' | 'current', mutate: (data: Json, index: number, params: Json) => Json | ReadResponse = data => data, budget = 40) {
  const sent: Json[] = [];
  const read = async (params: Record<string, unknown>): Promise<ReadResponse> => {
    sent.push(structuredClone(params));
    const index = sent.length - 1, data = page(text, { ...params, max_bytes: Math.min(Number(params.max_bytes), budget) }, mode);
    const result = mutate(data, index, params);
    return 'schema_version' in result && 'outcome' in result ? result as ReadResponse : native(result, result.complete === false ? 'partial' : 'ok');
  };
  return { read, sent };
}

/** Reads with a small page budget so every fixture needs several pages. */
const small: InitialTaskCapability = { ...capability, maxPageBytes: 40 };
const unverified = (result: InitialTaskResult) => { assert.equal(result.state, 'unverified'); return (result as { reason: string }).reason; };

test('a multi-page multi-byte strict task is shown only after length and SHA-256 verification', async () => {
  const source = producer(TASK, 'strict'), result = await readInitialTask(source.read, strictRequest, small);
  assert.equal(result.state, 'verified');
  if (result.state !== 'verified') return;
  assert.equal(result.text, TASK);
  assert.equal(result.totalBytes, Buffer.byteLength(TASK));
  assert.equal(result.sha256, digest(TASK));
  assert.ok(result.pages >= 4 && result.pages === source.sent.length, `${result.pages} pages`);
  assert.deepEqual([result.mode, result.pinId, result.executionRef, result.storeId], ['strict', PIN, REF, STORE]);
  assert.deepEqual(source.sent[0], { version: 1, mode: 'strict', agent_id: AGENT, expected_store_id: STORE, sequence: 1, pin_id: PIN, execution_ref: REF, offset: 0, max_bytes: 40 });
  for (const [index, request] of source.sent.slice(1).entries()) {
    assert.equal(request.expected_sha256, digest(TASK), 'every continuation carries the whole-text fences');
    assert.equal(request.expected_total_bytes, Buffer.byteLength(TASK));
    assert.ok(request.offset > source.sent[index].offset);
    assert.ok(!Object.values(request).includes(null), 'optional fields are omitted, never null');
  }
});

test('current mode sends no pin or sequence, learns the ref from page one and fences later pages with it', async () => {
  const source = producer(TASK, 'current'), result = await readInitialTask(source.read, currentRequest, small);
  assert.equal(result.state, 'verified');
  if (result.state !== 'verified') return;
  assert.equal(result.pinId, null);
  assert.deepEqual(source.sent[0], { version: 1, mode: 'current', agent_id: AGENT, offset: 0, max_bytes: 40 });
  assert.equal(source.sent[1].execution_ref, REF);
  assert.ok(!('pin_id' in source.sent[1]) && !('sequence' in source.sent[1]));
  const fenced = producer(TASK, 'current'), withRef = await readInitialTask(fenced.read, { ...currentRequest, executionRef: REF, storeId: STORE }, small);
  assert.equal(withRef.state, 'verified');
  assert.equal(fenced.sent[0].execution_ref, REF);
  assert.equal(fenced.sent[0].expected_store_id, STORE);
});

test('a one-page task and the largest page budget work, and a partial outcome is accepted only on a non-final page', async () => {
  const one = producer('short task', 'current', data => data, 65536);
  const result = await readInitialTask(one.read, currentRequest, capability);
  assert.equal(result.state === 'verified' && result.pages, 1);
  const lying = producer(TASK, 'current', (data, index) => data.complete ? native(data, 'partial') : data);
  assert.equal(unverified(await readInitialTask(lying.read, currentRequest, small)), 'page_invalid');
});

test('content_changed on any page discards the buffered text', async () => {
  for (const at of [0, 1, 3]) {
    const source = producer(TASK, 'strict', (data, index) => index === at ? { state: 'unavailable', version: 1, mode: 'strict', store_id: STORE, agent_id: AGENT, reason: 'content_changed' } : data);
    assert.equal(unverified(await readInitialTask(source.read, strictRequest, small)), 'content_changed', `page ${at}`);
    assert.equal(source.sent.length, at + 1, 'no read follows an unavailable page');
  }
});

test('each unavailable reason class is reported and none carries text', async () => {
  const all = ['not_found', 'retention_deleted', 'not_root_execution', 'execution_ref_unavailable', 'execution_ref_mismatch', 'pin_missing', 'pin_released', 'pin_mismatch', 'coverage_incomplete', 'task_missing', 'task_mismatch', 'task_too_large', 'provider_identity_invalid', 'content_changed'];
  const strictOnly = ['retention_deleted', 'pin_missing', 'pin_released', 'pin_mismatch', 'coverage_incomplete'];
  for (const reason of all) {
    const strict = producer(TASK, 'strict', () => ({ state: 'unavailable', version: 1, mode: 'strict', store_id: STORE, agent_id: AGENT, reason }));
    assert.equal(unverified(await readInitialTask(strict.read, strictRequest, small)), reason);
    const current = producer(TASK, 'current', () => ({ state: 'unavailable', version: 1, mode: 'current', store_id: STORE, agent_id: AGENT, reason }));
    const outcome = unverified(await readInitialTask(current.read, currentRequest, small));
    assert.equal(outcome, strictOnly.includes(reason) ? 'unavailable_reason' : reason, `current ${reason}`);
  }
  const storeless = producer(TASK, 'current', () => ({ state: 'unavailable', version: 1, mode: 'current', agent_id: AGENT, reason: 'not_found' }));
  assert.equal(unverified(await readInitialTask(storeless.read, currentRequest, small)), 'not_found');
  for (const bad of [{ reason: 'something_else' }, { reason: 7 }, { reason: 'task_mismatch', text: TASK }, { reason: 'task_mismatch', store_id: `store_${'2'.repeat(32)}` }, { reason: 'task_mismatch', agent_id: 'other' }, { reason: 'task_mismatch', mode: 'strict' }, { reason: 'task_mismatch', version: 2 }]) {
    const source = producer(TASK, 'current', () => ({ state: 'unavailable', version: 1, mode: 'current', store_id: STORE, agent_id: AGENT, ...bad }));
    assert.notEqual(unverified(await readInitialTask(source.read, { ...currentRequest, storeId: STORE }, small)), 'task_mismatch', JSON.stringify(bad));
  }
});

test('source errors, including a wrong store fence, withhold the task with only a static reason', async () => {
  const wrongStore = producer(TASK, 'strict', () => native(null, 'unavailable', { code: 'run_source_error', message: 'Source read is unavailable; no agent was cancelled.' }));
  assert.equal(unverified(await readInitialTask(wrongStore.read, strictRequest, small)), 'run_source_error');
  for (const outcome of ['unavailable', 'incompatible', 'invalid', 'missing'] as const) {
    const source = producer(TASK, 'current', () => native(null, outcome));
    assert.equal(unverified(await readInitialTask(source.read, currentRequest, small)), `source_${outcome}`);
  }
  const later = producer(TASK, 'current', (data, index) => index === 2 ? native(null, 'unavailable', { code: 'run_source_error', message: 'x' }) : data);
  assert.equal(unverified(await readInitialTask(later.read, currentRequest, small)), 'run_source_error', 'a later failure discards earlier pages');
  const old = producer(TASK, 'current', () => native(null, 'incompatible', { code: 'run_method_unavailable', message: 'x' }));
  assert.equal(unverified(await readInitialTask(old.read, currentRequest, small)), 'run_method_unavailable');
});

test('a wrong length or digest claim is rejected only after the whole text is buffered', async () => {
  const wrongHash = producer(TASK, 'current', data => ({ ...data, sha256: digest('different') }));
  assert.equal(unverified(await readInitialTask(wrongHash.read, currentRequest, small)), 'digest_mismatch');
  assert.ok(wrongHash.sent.length >= 4, 'the digest is checked once, after the last page');
  const short = Buffer.byteLength(TASK) - 1;
  const lyingLength = producer(TASK, 'current', data => ({ ...data, total_bytes: data.total_bytes + 1 }));
  assert.notEqual((await readInitialTask(lyingLength.read, currentRequest, small)).state, 'verified');
  const early = producer(TASK, 'current', data => ({ ...data, total_bytes: short, complete: data.end === short, next_offset: data.end === short ? null : data.next_offset }));
  assert.notEqual((await readInitialTask(early.read, currentRequest, small)).state, 'verified');
});

test('identity, range and shape drift between pages is refused', async () => {
  const changes: [string, (data: Json, index: number) => Json][] = [
    ['store', (data, index) => index === 1 ? { ...data, store_id: `store_${'2'.repeat(32)}` } : data],
    ['ref', (data, index) => index === 1 ? { ...data, execution_ref: `ex1_${'b'.repeat(64)}` } : data],
    ['digest', (data, index) => index === 1 ? { ...data, sha256: digest('x') } : data],
    ['total', (data, index) => index === 1 ? { ...data, total_bytes: data.total_bytes - 1 } : data],
    ['offset', (data, index) => index === 1 ? { ...data, offset: data.offset + 1 } : data],
    ['end', (data, index) => index === 1 ? { ...data, end: data.end + 1 } : data],
    ['next', (data, index) => index === 1 ? { ...data, next_offset: data.next_offset + 1 } : data],
    ['complete', (data, index) => index === 1 ? { ...data, complete: true } : data],
    ['no progress', (data, index) => index === 1 ? { ...data, end: data.offset, next_offset: data.offset, text: '' } : data],
    ['agent', data => ({ ...data, agent_id: 'ag-other' })],
    ['mode', data => ({ ...data, mode: 'current' })],
    ['sequence', data => ({ ...data, sequence: 2 })],
    ['pin', data => ({ ...data, pin_id: `pin_${'f'.repeat(32)}` })],
    ['missing pin', data => { const { pin_id: _pin, ...rest } = data; return rest; }],
    ['unknown field', data => ({ ...data, truncated: false })],
    ['bad ref syntax', data => ({ ...data, execution_ref: 'ex1_short' })],
    ['bad digest syntax', data => ({ ...data, sha256: 'ABC' })],
    ['non-text', data => ({ ...data, text: 7 })],
    ['byte count', data => ({ ...data, text: data.text + 'x' })],
    ['state', data => ({ ...data, state: 'maybe' })],
    ['oversize total', data => ({ ...data, total_bytes: 524289 })],
  ];
  for (const [name, change] of changes) {
    const source = producer(TASK, 'strict', change);
    assert.notEqual((await readInitialTask(source.read, strictRequest, small)).state, 'verified', name);
  }
  const refSwap = producer(TASK, 'strict', data => ({ ...data, execution_ref: `ex1_${'b'.repeat(64)}` }));
  assert.equal(unverified(await readInitialTask(refSwap.read, strictRequest, small)), 'page_identity', 'a ref other than the requested fence');
  const pinSwap = producer(TASK, 'strict', data => ({ ...data, pin_id: `pin_${'f'.repeat(32)}` }));
  assert.equal(unverified(await readInitialTask(pinSwap.read, strictRequest, small)), 'page_identity');
  const storeSwap = producer(TASK, 'strict', data => ({ ...data, store_id: `store_${'2'.repeat(32)}` }));
  assert.equal(unverified(await readInitialTask(storeSwap.read, strictRequest, small)), 'page_identity');
});

test('NUL, blank, ill-formed and runaway tasks are never verified', async () => {
  for (const text of ['abc\0def', '   \n\t ', '']) {
    const source = producer(text, 'current', data => text ? data : { ...data, total_bytes: 0 });
    assert.notEqual((await readInitialTask(source.read, currentRequest, small)).state, 'verified', JSON.stringify(text));
  }
  const lone = producer('abcd', 'current', data => ({ ...data, text: 'ab\ud800' }));
  assert.notEqual((await readInitialTask(lone.read, currentRequest, small)).state, 'verified');
  const tiny = producer('a'.repeat(100), 'current', data => ({ ...data, text: data.text.slice(0, 1), end: data.offset + 1, next_offset: data.offset + 1, complete: false }), 1);
  assert.equal(unverified(await readInitialTask(tiny.read, currentRequest, { ...capability, maxPageBytes: 4 })), 'page_budget');
  assert.equal(tiny.sent.length, 16, 'a source that never finishes is stopped at the page budget');
});

test('a session change cancels the read and nothing is returned', async () => {
  let live = true;
  const source = producer(TASK, 'strict', (data, index) => { if (index === 1) live = false; return data; });
  assert.equal(unverified(await readInitialTask(source.read, strictRequest, small, () => live)), 'obsolete');
  assert.equal(source.sent.length, 2, 'no page is requested after the session changed');
  const never = producer(TASK, 'strict');
  assert.equal(unverified(await readInitialTask(never.read, strictRequest, small, () => false)), 'obsolete');
  assert.equal(never.sent.length, 0);
  let last = true;
  const finishing = producer('x', 'current', data => { last = false; return data; });
  assert.equal(unverified(await readInitialTask(finishing.read, currentRequest, small, () => last)), 'obsolete', 'a change during the final page still discards the text');
});

test('requests that cannot be proven are not sent', async () => {
  const none = producer(TASK, 'strict');
  const cases: [InitialTaskRequest, string][] = [
    [{ ...strictRequest, pinId: undefined }, 'request_invalid'],
    [{ ...strictRequest, storeId: undefined }, 'request_invalid'],
    [{ ...strictRequest, executionRef: undefined }, 'request_invalid'],
    [{ ...strictRequest, pinId: 'pin_x' }, 'request_invalid'],
    [{ ...currentRequest, pinId: PIN }, 'request_invalid'],
    [{ ...currentRequest, executionRef: 'ex1_x' }, 'request_invalid'],
    [{ ...currentRequest, storeId: 'store_x' }, 'request_invalid'],
    [{ ...currentRequest, agentId: '' }, 'request_invalid'],
  ];
  for (const [request, reason] of cases) assert.equal(unverified(await readInitialTask(none.read, request, small)), reason);
  assert.equal(unverified(await readInitialTask(none.read, strictRequest, { ...small, modes: ['current'] })), 'mode_unsupported');
  assert.equal(none.sent.length, 0);
});

test('the capability is accepted only when it is exactly the v1 advertisement', () => {
  const entry = { version: 1, method: 'initial_task', modes: ['strict', 'current'], max_task_bytes: 524288, max_page_bytes: 65536 };
  const identity = (value: unknown) => ({ ping: {}, tools: [], capabilities: { schema_version: 1, ...(value === undefined ? {} : { initial_task: value }) }, version: 'x' });
  assert.deepEqual(initialTaskCapability(identity(entry)), { modes: ['strict', 'current'], maxTaskBytes: 524288, maxPageBytes: 65536 });
  assert.deepEqual(initialTaskCapability(identity({ ...entry, modes: ['current'], max_page_bytes: 4096 })), { modes: ['current'], maxTaskBytes: 524288, maxPageBytes: 4096 });
  assert.equal(initialTaskCapability(identity(undefined)), null, 'absent without the flag');
  assert.equal(initialTaskCapability({ ping: {}, capabilities: null }), null);
  assert.equal(initialTaskCapability(null), null);
  for (const bad of [null, 1, [], { ...entry, version: 2 }, { ...entry, method: 'other' }, { ...entry, modes: [] }, { ...entry, modes: ['loose'] }, { ...entry, modes: ['strict', 'strict'] }, { ...entry, modes: 'strict' }, { ...entry, max_task_bytes: 524289 }, { ...entry, max_task_bytes: 0 }, { ...entry, max_page_bytes: 65537 }, { ...entry, max_page_bytes: 3 }, { ...entry, max_page_bytes: '65536' }, { ...entry, max_task_bytes: undefined }]) {
    assert.equal(initialTaskCapability(identity(bad)), null, JSON.stringify(bad));
  }
});

test('labels keep the established unverified wording and state exactly what was proven', async () => {
  assert.equal(initialTaskLabel(null), 'Initial task unverified · showing retained history');
  assert.match(initialTaskLabel('reading'), /^Initial task unverified · showing retained history · verifying/);
  assert.equal(initialTaskLabel({ state: 'unverified', reason: 'task_mismatch' }), 'Initial task unverified · showing retained history · task_mismatch');
  const result = await readInitialTask(producer(TASK, 'strict').read, strictRequest, small);
  assert.match(initialTaskLabel(result), new RegExp(`^Initial task verified \\(strict\\) · SHA-256 ${digest(TASK).slice(0, 12)}… · ${Buffer.byteLength(TASK)} bytes`));
});
