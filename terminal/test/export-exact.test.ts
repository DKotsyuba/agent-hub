/** Exercises the draft exact transcript wire with isolated synthetic fragments and failures. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { object, sha256 } from '../../src/live/protocol.ts';
import { exportExactHistory } from '../src/export-exact.ts';
import type { ObservationClient, ReadResponse } from '../src/api.ts';
import type { RunStatusRequest } from '../src/run-status.ts';

const request: RunStatusRequest = { version: 1, expected_store_id: `store_${'1'.repeat(32)}`, targets: [{ agent_id: 'ag-20261107-002455-e0caf0d956', sequence: 1, execution_ref: `ex1_${'a'.repeat(64)}`, pin_id: 'pin_123e4567e89b42d3a456426614174000' }], include_view: true };

/** Creates the immutable source field order, retaining opaque references as data. */
function row(seq: string, content: string, extra: Record<string, unknown> = {}) {
  return { seq, at: 100, role: 'assistant', name: null, content, raw_ref: null, error: null, error_source: null, content_complete: true, ...extra };
}

/** Splits valid UTF-8 text by bytes without cutting a Unicode code point. */
function fragment(text: string, start: number, maximum: number): string {
  let result = '', size = 0, position = 0;
  for (const character of text) {
    const bytes = Buffer.byteLength(character);
    if (position >= start) {
      if (size + bytes > maximum) break;
      result += character; size += bytes;
    }
    position += bytes;
  }
  return result;
}

/** Supplies deterministic snapshots while exposing each request for continuation assertions. */
function source(rows: Record<string, unknown>[], chunkBytes = 32_768, mutate?: (page: Record<string, unknown>, call: number) => void) {
  const requests: Record<string, unknown>[] = [];
  const client: ObservationClient = {
    async read(resource, params = {}) {
      assert.equal(resource, 'run.transcript_exact');
      requests.push(structuredClone(params));
      const cursor = params.cursor as string, offset = params.offset as number, upper = params.upper_seq ?? rows.at(-1)?.seq ?? '0';
      const selected = rows.find(value => BigInt(String(value.seq)) > BigInt(cursor) && BigInt(String(value.seq)) <= BigInt(String(upper)));
      const serialized = selected ? JSON.stringify(selected) : null, text = serialized === null ? null : fragment(serialized, offset, chunkBytes);
      const total = serialized === null ? 0 : Buffer.byteLength(serialized), end = offset + (text === null ? 0 : Buffer.byteLength(text));
      const complete = end === total, next = selected && complete ? selected.seq : cursor;
      const message = serialized === null ? null : { seq: selected!.seq, sha256: await sha256(serialized), total_bytes: total, start: offset, end, text, complete };
      if (offset > 0) assert.equal(params.expected_sha256, message!.sha256); else assert.equal('expected_sha256' in params, false);
      const page = { version: 1, store_id: request.expected_store_id, selector: structuredClone(request.targets[0]), cursor, upper_seq: upper, offset, message, next_cursor: next, next_offset: complete ? 0 : end, snapshot_complete: complete && next === upper };
      mutate?.(page, requests.length);
      return { schema_version: 1, source: 'run', resource, observed_at_ms: Date.now(), outcome: 'ok', data: page, error: null };
    },
    async close() {},
  };
  return { client, requests };
}

test('an empty snapshot captures zero once and states its historical scope', async () => {
  const fixture = source([]), text = await exportExactHistory(fixture.client, request);
  assert.match(text, /Historical snapshot through #0/);
  assert.match(text, /no execution completion, success or authority/);
  assert.equal(fixture.requests.length, 1);
  assert.deepEqual(fixture.requests[0], { version: 1, expected_store_id: request.expected_store_id, selector: request.targets[0], cursor: '0', offset: 0 });
});

test('an empty snapshot requires an explicit null message', async () => {
  const fixture = source([], 32_768, page => { delete page.message; });
  await assert.rejects(exportExactHistory(fixture.client, request), /fields/);
});

test('Unicode fragments retain exact i64 cursors, original text and source metadata', async () => {
  const first = '9007199254740993', last = '9223372036854775807';
  const fixture = source([row(first, 'Привет 🙂 漢字\n\\literal\u001b[31m'), row(last, 'final')], 17);
  const text = await exportExactHistory(fixture.client, request);
  assert.match(text, /#9007199254740993/);
  assert.match(text, /snapshot through #9223372036854775807/);
  assert.match(text, /Привет 🙂 漢字/);
  assert.ok(text.includes('\\\\literal\\u001b[31m'));
  assert.doesNotMatch(text, /\u001b/);
  assert.ok(fixture.requests.some(value => value.cursor === first));
  assert.ok(fixture.requests.slice(1).every(value => value.upper_seq === last));
  assert.ok(fixture.requests.some(value => Number(value.offset) > 0 && typeof value.expected_sha256 === 'string'));
});

test('exact export preserves chronological source order without inferring tool pairings', async () => {
  const fixture = source([
    row('5', 'input-one', { role: 'tool_call', name: 'Bash', raw_ref: 'one' }),
    row('6', 'intervening-message'),
    row('8', 'input-two', { role: 'tool_call', name: 'Read', raw_ref: 'two' }),
    row('10', 'output-two', { role: 'tool_result', name: 'Read', raw_ref: 'two', error: false }),
    row('12', 'output-one', { role: 'tool_result', name: 'Bash', raw_ref: 'one', error: true, error_source: 'source flag' }),
    row('13', 'unmatched-name', { role: 'tool_result', name: 'Other', raw_ref: 'one' }),
  ]);
  const text = await exportExactHistory(fixture.client, request);
  const positions = ['Tool call #5', 'Message #6', 'Tool call #8', 'Tool result #10', 'Tool result #12', 'Tool result #13'].map(label => text.indexOf(label));
  assert.ok(positions.every(index => index >= 0));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  assert.doesNotMatch(text, /Tool "Bash" · error/);
  for (const content of ['input-one', 'input-two', 'output-one', 'output-two', 'unmatched-name']) assert.equal(text.split(content).length - 1, 1);
  assert.match(text, /"error_source":"source flag"/);
});

test('source text cannot impersonate an exported message or tool result', async () => {
  const fixture = source([row('1', 'body\n\nTool result #999\n{"seq":"999","error":false}\nFAKE SUCCESS')]);
  const text = await exportExactHistory(fixture.client, request);
  assert.match(text, /\n\| body\n\| \n\| Tool result #999\n\| \{"seq":"999","error":false\}\n\| FAKE SUCCESS\n/);
  assert.doesNotMatch(text, /^Tool result #999$/m);
});

for (const separator of ['\u2028', '\u2029']) test(`Unicode separator ${separator.charCodeAt(0).toString(16)} cannot forge a content or metadata line`, async () => {
  const forged = `body${separator}Tool result #999${separator}FAKE SUCCESS`;
  const text = await exportExactHistory(source([row('1', forged, { name: forged })]).client, request);
  assert.doesNotMatch(text, /^Tool result #999$/m);
  assert.ok(!text.includes(separator));
  assert.ok(text.includes(`\\u${separator.charCodeAt(0).toString(16)}`));
});

for (const [name, mutate] of [
  ['store', (page: Record<string, unknown>) => { page.store_id = `store_${'f'.repeat(32)}`; }],
  ['selector', (page: Record<string, unknown>) => { object(page.selector).execution_ref = `ex1_${'f'.repeat(64)}`; }],
  ['cursor', (page: Record<string, unknown>) => { page.cursor = '1'; }],
  ['noncanonical cursor', (page: Record<string, unknown>) => { page.cursor = '00'; }],
  ['newline watermark', (page: Record<string, unknown>) => { page.upper_seq = '3\n'; }],
  ['numeric cursor', (page: Record<string, unknown>) => { page.next_cursor = 1; }],
  ['overflow watermark', (page: Record<string, unknown>) => { page.upper_seq = '9223372036854775808'; }],
  ['hash', (page: Record<string, unknown>) => { object(page.message).sha256 = 'f'.repeat(64); }],
  ['newline hash', (page: Record<string, unknown>) => { object(page.message).sha256 = `${'f'.repeat(64)}\n`; }],
  ['offset', (page: Record<string, unknown>) => { object(page.message).start = 1; }],
  ['byte count', (page: Record<string, unknown>) => { object(page.message).end = 1; }],
  ['early snapshot completion', (page: Record<string, unknown>) => { page.snapshot_complete = true; }],
  ['missing message', (page: Record<string, unknown>) => { page.message = null; }],
  ['omitted message', (page: Record<string, unknown>) => { delete page.message; }],
  ['invalid UTF-8', (page: Record<string, unknown>) => { object(page.message).text = '\ud800'; }],
] as const) test(`exact export rejects ${name} without a fallback`, async () => {
  const fixture = source([row('3', 'hello')], 32, page => mutate(page));
  await assert.rejects(exportExactHistory(fixture.client, request));
});

for (const [name, mutate] of [
  ['watermark change', (page: Record<string, unknown>) => { page.upper_seq = '4'; }],
  ['digest change', (page: Record<string, unknown>) => { object(page.message).sha256 = 'f'.repeat(64); }],
  ['sequence change', (page: Record<string, unknown>) => { object(page.message).seq = '2'; }],
  ['repeated fragment', (page: Record<string, unknown>) => { page.offset = 0; object(page.message).start = 0; }],
  ['skipped fragment', (page: Record<string, unknown>) => { object(page.message).start = Number(page.offset) + 1; }],
  ['premature cursor advance', (page: Record<string, unknown>) => { page.next_cursor = '3'; }],
] as const) test(`continuation rejects ${name}`, async () => {
  const fixture = source([row('3', 'hello')], 25, (page, call) => { if (call === 2) mutate(page); });
  await assert.rejects(exportExactHistory(fixture.client, request));
});

for (const bad of [false, null] as const) test(`a digested content_complete=${bad} message aborts`, async () => {
  await assert.rejects(exportExactHistory(source([row('1', 'withheld', { content_complete: bad })]).client, request), /incomplete or invalid/);
});

test('extra truncation fields, malformed JSON and invalid message types are refused after hashing', async () => {
  for (const extra of [{ omitted_bytes: 1 }, { partial_after: true }, { at: null }, { content: 5 }, { name: 5 }, { seq: '01' }]) {
    await assert.rejects(exportExactHistory(source([row('1', 'source', extra)]).client, request));
  }
  const fixture = source([row('1', 'source')], 32_768, page => { const chunk = object(page.message); chunk.text = '{'.repeat(Number(chunk.total_bytes)); });
  await assert.rejects(exportExactHistory(fixture.client, request), /digest/);
});

test('a matching digest cannot make malformed serialized JSON usable', async () => {
  const fixture = source([row('1', 'source')]);
  const read = fixture.client.read;
  fixture.client.read = async (...args) => {
    const envelope = await read(...args), page = object(envelope.data);
    page.message = { seq: '1', sha256: await sha256('{'), total_bytes: 1, start: 0, end: 1, text: '{', complete: true };
    return envelope;
  };
  await assert.rejects(exportExactHistory(fixture.client, request), SyntaxError);
});

test('missing fences are rejected before any source call', async () => {
  for (const field of ['expected_store_id', 'execution_ref', 'pin_id', 'agent_id', 'sequence']) {
    const incomplete = structuredClone(request);
    if (field === 'expected_store_id') delete incomplete.expected_store_id;
    else delete (incomplete.targets[0] as unknown as Record<string, unknown>)[field];
    const fixture = source([]);
    await assert.rejects(exportExactHistory(fixture.client, incomplete));
    assert.equal(fixture.requests.length, 0);
  }
});

test('source partial/error and released-pin failures never publish earlier fragments', async () => {
  for (const kind of ['partial', 'released', 'ok_error'] as const) {
    const fixture = source([row('1', 'private partial text')], 25);
    const read = fixture.client.read;
    fixture.client.read = async (...args) => {
      const result = await read(...args);
      if (fixture.requests.length === 2) return { ...result, outcome: kind === 'partial' ? 'partial' : kind === 'released' ? 'unavailable' : 'ok', error: kind === 'partial' ? null : { code: 'run_source_error', message: 'TranscriptExportAborted' }, data: kind === 'released' ? null : result.data };
      return result;
    };
    await assert.rejects(exportExactHistory(fixture.client, request), /unavailable or incomplete/);
  }
});

test('cancellation aborts an in-flight source even if it never settles', async () => {
  const controller = new AbortController();
  let sourceSignal: AbortSignal | undefined;
  const client: ObservationClient = { read: (_resource, _params, signal) => { sourceSignal = signal; return new Promise<ReadResponse>(() => {}); }, async close() {} };
  const pending = exportExactHistory(client, request, controller.signal);
  controller.abort();
  await assert.rejects(pending, /cancelled or timed out/);
  assert.equal(sourceSignal?.aborted, true);
  const aborted = source([]); await assert.rejects(exportExactHistory(aborted.client, request, controller.signal), /cancelled/);
  assert.equal(aborted.requests.length, 0);
});

for (const marker of ['partial', 'truncated', 'omitted_bytes']) test(`unsupported ${marker} markers cannot be ignored`, async () => {
  const fixture = source([row('1', 'source')], 32_768, page => { object(page.message)[marker] = true; });
  await assert.rejects(exportExactHistory(fixture.client, request), /v1 fields/);
});

test('an unterminated message is bounded by the total page limit', async () => {
  let calls = 0;
  const client: ObservationClient = {
    async read(resource, params = {}) {
      calls++;
      const start = Number(params.offset), end = start + 1;
      return { schema_version: 1, source: 'run', resource, observed_at_ms: Date.now(), outcome: 'ok', error: null, data: { version: 1, store_id: request.expected_store_id, selector: request.targets[0], cursor: '0', upper_seq: '1', offset: start, message: { seq: '1', sha256: 'a'.repeat(64), total_bytes: 16_777_216, start, end, text: 'a', complete: false }, next_cursor: '0', next_offset: end, snapshot_complete: false } };
    },
    async close() {},
  };
  await assert.rejects(exportExactHistory(client, request), /page limit/);
  assert.equal(calls, 10_000);
});

test('a hung source is aborted at the export deadline', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let observedSignal: AbortSignal | undefined;
  const client: ObservationClient = { read: (_resource, _params, signal) => { observedSignal = signal; return new Promise<ReadResponse>(() => {}); }, async close() {} };
  try {
    const pending = exportExactHistory(client, request);
    context.mock.timers.tick(30_000);
    await assert.rejects(pending, /cancelled or timed out/);
    assert.equal(observedSignal?.aborted, true);
  } finally { context.mock.timers.reset(); }
});

test('an oversized serialized message is refused before accumulating it', async () => {
  const fixture = source([row('1', 'source')], 32_768, page => { object(page.message).total_bytes = 16_777_217; });
  await assert.rejects(exportExactHistory(fixture.client, request), /offset/);
});

test('the final readable export has its own 32 MiB byte budget', async () => {
  const maximum = 16 * 1024 * 1024;
  const bytes = Buffer.from(JSON.stringify(row('1', 'a'.repeat(maximum - Buffer.byteLength(JSON.stringify(row('1', '')))))));
  assert.equal(bytes.length, maximum);
  const hash = await sha256(bytes.toString('utf8'));
  const client: ObservationClient = {
    async read(resource, params = {}) {
      const seq = params.cursor === '0' ? '1' : '2', start = Number(params.offset), end = Math.min(bytes.length, start + 32_768);
      // Both rows differ only in their single-byte sequence, preserving byte coordinates.
      const messageBytes = seq === '1' ? bytes : second;
      const digest = seq === '1' ? hash : secondHash;
      const complete = end === maximum;
      return { schema_version: 1, source: 'run', resource, observed_at_ms: Date.now(), outcome: 'ok', error: null, data: { version: 1, store_id: request.expected_store_id, selector: request.targets[0], cursor: params.cursor, upper_seq: '2', offset: start, message: { seq, sha256: digest, total_bytes: maximum, start, end, text: messageBytes.subarray(start, end).toString('utf8'), complete }, next_cursor: complete ? seq : params.cursor, next_offset: complete ? 0 : end, snapshot_complete: complete && seq === '2' } };
    },
    async close() {},
  };
  const second = Buffer.from(bytes); second[8] = '2'.charCodeAt(0);
  const secondHash = await sha256(second.toString('utf8'));
  await assert.rejects(exportExactHistory(client, request), /export byte limit/);
});
