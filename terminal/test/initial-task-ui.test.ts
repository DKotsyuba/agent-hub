/** Checks that the session view shows an initial task only when Run advertises and fully verifies it. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createTestRenderer } from '@opentui/core/testing';
import type { ObservationClient, ReadResponse } from '../src/api.ts';
import { createDemoClient } from '../src/demo.ts';
import { mountHub } from '../src/hub.ts';

type Json = Record<string, any>;
const STORE = `store_${'1'.repeat(32)}`, REF = `ex1_${'a'.repeat(64)}`;
const TASK = `Audit the ledger — 日本語 🚀\nSECOND-LINE ${'ü'.repeat(100)}`;
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const ENTRY = { version: 1, method: 'initial_task', modes: ['strict', 'current'], max_task_bytes: 524288, max_page_bytes: 65536 };

/** Builds the native response around one producer page. */
function native(data: unknown, outcome: ReadResponse['outcome'] = 'ok', code?: string): ReadResponse {
  return { schema_version: 1, source: 'run', resource: 'run.initial_task', observed_at_ms: Date.now(), outcome, data: code ? null : data, error: code ? { code, message: 'Source read is unavailable; no agent was cancelled.' } : null };
}
/** A producer page for the synthetic task, split at UTF-8 boundaries. */
function page(params: Json, overrides: Json = {}): Json {
  const bytes = Buffer.from(TASK), offset = params.offset ?? 0;
  let end = Math.min(bytes.length, offset + Math.min(params.max_bytes ?? 65536, 64));
  while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  return { state: 'available', version: 1, mode: 'current', store_id: STORE, agent_id: params.agent_id, sequence: 1, execution_ref: REF, total_bytes: bytes.length, sha256: digest(TASK), offset, end, next_offset: end < bytes.length ? end : null, text: bytes.subarray(offset, end).toString('utf8'), complete: end === bytes.length, ...overrides };
}

/** Wraps the demo client; `advertise` adds the capability and `answer` serves `run.initial_task`. */
function client(advertise: boolean, answer: (params: Json, signal?: AbortSignal) => ReadResponse | Promise<ReadResponse>, calls: Json[] = []): ObservationClient {
  const demo = createDemoClient();
  return {
    async read(resource, params, signal) {
      if (resource === 'run.initial_task') { calls.push(structuredClone(params ?? {})); return answer(params ?? {}, signal); }
      const response = await demo.read(resource, params, signal);
      if (resource !== 'run.identity' || !advertise || !response.data) return response;
      const data = response.data as Json;
      return { ...response, data: { ...data, capabilities: { ...data.capabilities, schema_version: 1, product: 'agent-run', initial_task: ENTRY } } };
    },
    close: () => demo.close(),
  };
}
/** Opens the first demo session and waits for its retained history. */
async function openSession(setup: Awaited<ReturnType<typeof createTestRenderer>>): Promise<string> {
  await setup.waitForFrame(value => value.includes('4 loaded / 4 reported'));
  setup.mockInput.pressKey('1');
  return setup.waitForFrame(value => value.includes('Inspect the saved execution history') && value.includes('Initial task'));
}
const complete = (params: Json) => { const data = page(params); return native(data, data.complete ? 'ok' : 'partial'); };

test('a verified multi-page task is labelled and shown in Details with its proof scope', async () => {
  const setup = await createTestRenderer({ width: 140, height: 44 }), calls: Json[] = [];
  const hub = client(true, complete, calls);
  const unmount = mountHub(setup.renderer, hub, 'live', () => {});
  try {
    await openSession(setup);
    const label = await setup.waitForFrame(value => value.includes('Initial task verified (current)'));
    assert.match(label, new RegExp(`SHA-256 ${digest(TASK).slice(0, 12)}…`));
    assert.doesNotMatch(label, /SECOND-LINE/, 'the task text is not mixed into the history');
    assert.ok(calls.length >= 3 && calls[0].mode === 'current' && calls[0].agent_id === 'demo-inspect' && calls[0].offset === 0);
    assert.ok(!('pin_id' in calls[0]) && !('sequence' in calls[0]), 'an unbound session has no pin proof and cannot use strict mode');
    setup.mockInput.pressKey('d');
    const details = await setup.waitForFrame(value => value.includes('SECOND-LINE') && value.includes('current retained root only'));
    assert.match(details, /Audit the ledger — 日本語 🚀/);
    assert.match(details, /no pin, coverage or older Pool/);
  } finally { unmount(); await hub.close(); await setup.dispose(); }
});

test('a Run that does not advertise the capability is never asked and keeps the plain label', async () => {
  const setup = await createTestRenderer({ width: 140, height: 44 }), calls: Json[] = [];
  const hub = client(false, complete, calls);
  const unmount = mountHub(setup.renderer, hub, 'live', () => {});
  try {
    const frame = await openSession(setup);
    assert.match(frame, /Initial task unverified · showing retained history/);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(calls.length, 0);
    assert.doesNotMatch(await setup.waitForFrame(value => value.includes('Initial task unverified')), /Initial task unverified · showing retained history ·/);
  } finally { unmount(); await hub.close(); await setup.dispose(); }
});

test('an unavailable reason, a typed error or a digest mismatch keeps the unverified label and never shows text', async () => {
  const cases: [string, (params: Json) => ReadResponse, RegExp][] = [
    ['task_mismatch', params => native({ state: 'unavailable', version: 1, mode: 'current', store_id: STORE, agent_id: params.agent_id, reason: 'task_mismatch' }), /showing retained history · task_mismatch/],
    ['content_changed', params => params.offset ? native({ state: 'unavailable', version: 1, mode: 'current', store_id: STORE, agent_id: params.agent_id, reason: 'content_changed' }) : complete(params), /showing retained history · content_changed/],
    ['typed error', () => native(null, 'unavailable', 'run_source_error'), /showing retained history · run_source_error/],
    ['digest', params => { const data = page(params, { sha256: digest('other') }); return native(data, data.complete ? 'ok' : 'partial'); }, /showing retained history · digest_mismatch/],
  ];
  for (const [name, answer, expected] of cases) {
    const setup = await createTestRenderer({ width: 140, height: 44 }), hub = client(true, answer);
    const unmount = mountHub(setup.renderer, hub, 'live', () => {});
    try {
      await openSession(setup);
      const frame = await setup.waitForFrame(value => expected.test(value));
      assert.doesNotMatch(frame, /Initial task verified/, name);
      setup.mockInput.pressKey('d');
      const details = await setup.waitForFrame(value => value.includes('Agent ID'));
      assert.doesNotMatch(details, /SECOND-LINE|Audit the ledger/, `${name}: no partial task text`);
    } finally { unmount(); await hub.close(); await setup.dispose(); }
  }
});

test('leaving the session cancels an unfinished read and its late pages are discarded', async () => {
  const setup = await createTestRenderer({ width: 140, height: 44 }), signals: (AbortSignal | undefined)[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const hub = client(true, async (params, signal) => { signals.push(signal); if (params.offset) await gate; return complete(params); });
  const unmount = mountHub(setup.renderer, hub, 'live', () => {});
  try {
    await openSession(setup);
    await setup.waitForFrame(value => value.includes('verifying exact task'));
    setup.mockInput.pressKey('0');
    await setup.waitForFrame(value => value.includes('Overview') || value.includes('Agent Run'));
    release();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(signals.some(signal => signal?.aborted), 'the in-flight page read is aborted on a session change');
    setup.mockInput.pressKey('1');
    const frame = await setup.waitForFrame(value => value.includes('Initial task'));
    assert.doesNotMatch(frame, /SECOND-LINE/);
  } finally { release(); unmount(); await hub.close(); await setup.dispose(); }
});
