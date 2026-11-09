/** Exercises snapshot watermark paging, omission refusal and cancellation for history export. */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ObservationClient, ReadResponse, Resource } from '../src/api.ts';
import { independentlyPartial } from '../src/api.ts';
import { exportHistory } from '../src/export.ts';

/** Creates a read-only synthetic source that exposes a two-page logical session. */
function source(incomplete = false): ObservationClient {
  const messages = [1, 2, 3].map(seq => ({ seq, role: 'assistant', name: null, content: `message-${seq}`, at: 100 + seq, content_complete: !(incomplete && seq === 2), omitted_bytes: 0 }));
  return {
    async read(resource: Resource, params: Record<string, unknown> = {}): Promise<ReadResponse> {
      assert.equal(resource, 'run.transcript');
      const cursor = typeof params.cursor === 'number' ? params.cursor : 0;
      const tail = params.view === 'blocks';
      const rows = tail ? messages.slice(-1) : messages.filter(message => message.seq > cursor).slice(0, 2);
      const more = !tail && rows.at(-1)!.seq < 3;
      return { schema_version: 1, source: 'run', resource, observed_at_ms: Date.now(), outcome: more ? 'partial' : 'ok', error: null, data: { agent_id: 'fixture', view: tail ? 'blocks' : 'raw', cursor, messages: rows, complete: !more, next_cursor: more ? rows.at(-1)!.seq : null, resume_cursor: rows.at(-1)!.seq } };
    },
    async close() {},
  };
}

test('history export follows source pages through the frozen watermark', async () => {
  const text = await exportHistory(source(), { kind: 'session', id: 'fixture' });
  assert.match(text, /Scan through #3/);
  assert.match(text, /completeness is not guaranteed/);
  for (const value of ['message-1', 'message-2', 'message-3']) assert.match(text, new RegExp(value));
});

test('history export refuses omitted content and never returns a partial copy', async () => {
  await assert.rejects(exportHistory(source(true), { kind: 'session', id: 'fixture' }), /incomplete or unknown/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(exportHistory(source(), { kind: 'session', id: 'fixture' }, abort.signal), /cancelled or timed out/);
});

test('a nested source coverage warning is not mistaken for page continuation', () => {
  assert.equal(independentlyPartial({ outcome: 'partial', data: { complete: false, data: { coverage: { complete: false } } } }), true);
  assert.equal(independentlyPartial({ outcome: 'partial', data: { complete: false } }), false);
});

test('copied history pairs each proven tool input with its own output and preserves unknown outcomes', async () => {
  const rows = [
    { seq: 1, role: 'tool_call', name: 'Bash', raw_ref: 'one', content: 'printf first', error: null },
    { seq: 2, role: 'tool_call', name: 'Bash', raw_ref: 'two', content: 'printf second', error: null },
    { seq: 3, role: 'tool_result', name: 'Bash', raw_ref: 'two', content: 'SECOND', error: false },
    { seq: 4, role: 'tool_result', name: 'Bash', raw_ref: 'one', content: 'FIRST\u001b[31m', error: null },
  ].map(row => ({ ...row, at: 100 + row.seq, content_complete: true, omitted_bytes: 0 }));
  const client: ObservationClient = {
    async read(resource, params = {}) {
      const tail = params.view === 'blocks', cursor = Number(params.cursor ?? 0), messages = tail ? rows.slice(-1) : rows.filter(row => row.seq > cursor);
      return { schema_version: 1, source: 'run', resource, observed_at_ms: Date.now(), outcome: 'ok', error: null, data: { agent_id: 'fixture', view: tail ? 'blocks' : 'raw', cursor, messages, complete: true, next_cursor: null, resume_cursor: messages.at(-1)?.seq ?? null } };
    },
    async close() {},
  };
  const copy = await exportHistory(client, { kind: 'session', id: 'fixture' });
  assert.match(copy, /Tool · Bash · unknown\nInput:\nprintf first\nOutput:\nFIRST\[control\]/);
  assert.match(copy, /Tool · Bash · ok\nInput:\nprintf second\nOutput:\nSECOND/);
  assert.doesNotMatch(copy, /\u001b/);
});
