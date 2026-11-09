/** Tests tool correlation and display using only synthetic producer-shaped records. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestRenderer } from '@opentui/core/testing';
import stringWidth from 'string-width';
import { transcriptPage } from '../../src/live/protocol.ts';
import { createDemoClient } from '../src/demo.ts';
import { mountHub } from '../src/hub.ts';
import { groupTranscript } from '../src/transcript.ts';
import type { ObservationClient } from '../src/api.ts';

/** Parses fixture records through the same source boundary as the UI. */
function blocks(messages: Record<string, unknown>[]) {
  return transcriptPage({ agent_id: 'synthetic', messages, complete: true, cursor: 0 }, 'synthetic').blocks;
}

/** Constructs one synthetic producer block with explicit correlation evidence. */
function tool(seq: number, role: 'tool_call' | 'tool_result', name: string, ref: string | null, content: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { seq, role, name, raw_ref: ref, content, at: 100 + seq, content_complete: true, ...extra };
}

/** Formats a fixture time in the same local clock convention as tool rows. */
function clock(seconds: number): string { return new Date(seconds * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); }

/** Supplies source-shaped pages without contacting Run or Bridge. */
function source(readPage: (params: Record<string, unknown>) => { messages: Record<string, unknown>[]; previous?: number | null; complete?: boolean }): ObservationClient {
  const demo = createDemoClient();
  return {
    async read(resource, params = {}, signal) {
      if (resource !== 'run.transcript') return demo.read(resource, params, signal);
      const page = readPage(params);
      return { schema_version: 1, source: 'run', resource, observed_at_ms: Date.now(), outcome: 'ok', error: null, data: { agent_id: params.agent_id, view: 'blocks', cursor: 0, messages: page.messages, complete: page.complete ?? true, previous_cursor: page.previous ?? null, next_cursor: null, resume_cursor: page.messages.at(-1)?.seq ?? null } };
    },
    close: () => demo.close(),
  };
}

test('tool results follow the matching native reference and name in journal order', () => {
  const data = blocks([
    tool(1, 'tool_call', 'Bash', 'a', '{"command":"printf A"}'),
    tool(2, 'tool_call', 'Bash', 'b', '{"command":"printf B"}'),
    tool(3, 'tool_result', 'Bash', 'b', 'B result', { error: false }),
    { seq: 4, role: 'assistant', name: null, content: 'between', at: 104, content_complete: true },
    tool(5, 'tool_result', 'Bash', 'a', 'A first ', { error: false }),
    tool(6, 'tool_result', 'Bash', 'a', 'A second', { error: false }),
  ]);
  const grouped = groupTranscript(data);
  assert.deepEqual(grouped.entries.map(entry => entry.head.seq), [1, 2, 4]);
  assert.deepEqual(grouped.entries[0].results.map(block => block.seq), [5, 6]);
  assert.deepEqual(grouped.entries[1].results.map(block => block.seq), [3]);
  assert.equal(grouped.byKey.get(data[5].key), 0);
});

test('a late input fills only its matching empty call without merging another invocation', () => {
  const data = blocks([
    tool(1, 'tool_call', 'command', 'a', ''),
    tool(2, 'tool_call', 'command', 'b', 'printf B'),
    tool(3, 'tool_call', 'command', 'a', 'printf A'),
    tool(4, 'tool_result', 'command', 'b', 'B output', { error: false }),
    tool(5, 'tool_result', 'command', 'a', 'A output', { error: false }),
    tool(6, 'tool_call', 'command', 'a', 'a new invocation'),
    tool(7, 'tool_result', 'command', 'a', 'new output', { error: false }),
  ]);
  const grouped = groupTranscript(data);
  assert.deepEqual(grouped.entries.map(entry => entry.head.seq), [1, 2, 6]);
  assert.deepEqual(grouped.entries[0].calls.map(block => block.content), ['', 'printf A']);
  assert.deepEqual(grouped.entries[0].results.map(block => block.content), ['A output']);
  assert.deepEqual(grouped.entries[1].results.map(block => block.content), ['B output']);
  assert.deepEqual(grouped.entries[2].results.map(block => block.content), ['new output']);
});

test('empty retained Codex input and output are explicitly labeled', async () => {
  const messages = [tool(1, 'tool_call', 'command', 'a', ''), tool(2, 'tool_result', 'command', 'a', '', { error: false })];
  const setup = await createTestRenderer({ width: 120, height: 40 }), client = source(() => ({ messages }));
  const unmount = mountHub(setup.renderer, client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('Agent Run') && value.includes('Active'));
    setup.mockInput.pressKey('1'); setup.mockInput.pressKey('G');
    let frame = await setup.waitForFrame(value => value.includes('input not recorded'));
    await setup.mockMouse.click(43, frame.split('\n').findIndex(row => row.includes('input not recorded')));
    frame = await setup.waitForFrame(value => value.includes('Input: not recorded') && value.includes('Output: no output recorded'));
    assert.equal(frame.split('\n').filter(row => /[▸▾] command/.test(row)).length, 1);
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('late Codex command text enriches its existing row and keeps the matching output', async () => {
  const initial = [tool(1, 'tool_call', 'command', 'a', ''), tool(2, 'tool_call', 'command', 'b', 'printf B')];
  const later = [tool(3, 'tool_call', 'command', 'a', 'printf A'), tool(4, 'tool_result', 'command', 'a', 'A output', { error: false })];
  let delivered = false;
  const setup = await createTestRenderer({ width: 120, height: 40 });
  const client = source(params => typeof params.cursor === 'number' ? { messages: delivered ? later : [] } : { messages: initial });
  const unmount = mountHub(setup.renderer, client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('Agent Run') && value.includes('Active'));
    setup.mockInput.pressKey('1'); setup.mockInput.pressKey('G');
    await setup.waitForFrame(value => value.includes('input not recorded') && value.includes('printf B'));
    delivered = true;
    setup.mockInput.pressKey('r');
    let frame = await setup.waitForFrame(value => value.includes('printf A') && value.includes('printf B'));
    assert.equal(frame.split('\n').filter(row => /[▸▾] command/.test(row)).length, 2);
    await setup.mockMouse.click(43, frame.split('\n').findIndex(row => row.includes('printf A')));
    frame = await setup.waitForFrame(value => value.includes('Input') && value.includes('A output'));
    assert.doesNotMatch(frame, /Input: not recorded/);
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

for (const width of [80, 120, 200]) {
  test(`tool status and timing align to the right at ${width} columns`, async () => {
    const longCommand = 'abcdefghijklmnopqrstuvwxyz'.repeat(3);
    const messages = [
      tool(1, 'tool_call', 'Bash', 'a', '{"command":"printf short"}'),
      tool(2, 'tool_result', 'Bash', 'a', 'done', { error: false }),
      tool(3, 'tool_call', '文件', 'b', JSON.stringify({ command: longCommand })),
      tool(4, 'tool_result', '文件', 'b', 'failed', { error: true }),
      tool(5, 'tool_call', 'Read', 'c', '{"command":"cat example"}'),
      tool(6, 'tool_result', 'Read', 'c', 'result'),
    ];
    const setup = await createTestRenderer({ width, height: 40 }), client = source(() => ({ messages }));
    const unmount = mountHub(setup.renderer, client, 'live', () => {});
    try {
      await setup.waitForFrame(value => value.includes('Agent Run') && value.includes('Active'));
      setup.mockInput.pressKey('1'); setup.mockInput.pressKey('G');
      if (width < 110) setup.mockInput.pressEnter();
      const frame = await setup.waitForFrame(value => value.includes('printf short') && value.includes('cat example'));
      const rows = frame.split('\n');
      for (const [name, status] of [['printf short', 'ok'], ['文件', 'error'], ['cat example', 'unknown']] as const) {
        const row = rows.find(line => line.includes(name));
        assert.ok(row, `missing ${name}`);
        assert.match(row, new RegExp(` {2,}${status} · `), 'metadata is separated from command details');
        assert.equal(stringWidth(row.trimEnd()), width - 2, 'metadata ends at the right edge of the transcript');
      }
      if (width === 200) assert.match(frame, new RegExp(longCommand), 'available width is used for command details');
    } finally { unmount(); await client.close(); await setup.dispose(); }
  });
}

test('Codex file changes show the path and readable diff lines', async () => {
  const input = JSON.stringify({ changes: [{ path: 'src/example.ts', kind: 'update', diff: '@@ -1 +1 @@\n-before\n+after' }] });
  const messages = [tool(1, 'tool_call', 'file_change', 'a', input), tool(2, 'tool_result', 'file_change', 'a', '', { error: false })];
  const setup = await createTestRenderer({ width: 120, height: 40 }), client = source(() => ({ messages }));
  const unmount = mountHub(setup.renderer, client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('Agent Run') && value.includes('Active'));
    setup.mockInput.pressKey('1'); setup.mockInput.pressKey('G');
    let frame = await setup.waitForFrame(value => value.includes('file_change') && value.includes('update: src/example.ts'));
    await setup.mockMouse.click(43, frame.split('\n').findIndex(row => row.includes('file_change')));
    frame = await setup.waitForFrame(value => value.includes('@@ -1 +1 @@') && value.includes('-before') && value.includes('+after'));
    const rows = frame.split('\n'), before = rows.findIndex(row => row.includes('-before'));
    assert.equal(rows.findIndex(row => row.includes('+after')), before + 1);
    assert.doesNotMatch(frame, /\\n\+after/);
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('missing identities, name mismatches and raw boundaries remain separate', () => {
  const data = blocks([
    tool(1, 'tool_call', 'Read', 'x', '{}'),
    tool(2, 'tool_result', 'Bash', 'x', 'different tool', { error: false }),
    tool(3, 'tool_call', 'Bash', null, '{}'),
    tool(4, 'tool_result', 'Bash', null, 'unknown identity', { error: false }),
    tool(5, 'tool_call', 'Bash', 'reuse', '{}'),
    { seq: 6, role: 'assistant', name: null, content: 'boundary', starts_block: true, at: 106, content_complete: true },
    tool(7, 'tool_result', 'Bash', 'reuse', 'unpaired', { error: false }),
    tool(8, 'tool_call', 'Bash', 'projected', '{}', { starts_block: true, first_seq: 8 }),
    tool(9, 'tool_result', 'Bash', 'projected', 'paired', { error: false, starts_block: true, first_seq: 9 }),
  ]);
  const grouped = groupTranscript(data);
  assert.deepEqual(grouped.entries.map(entry => entry.head.seq), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(grouped.entries.at(-1)?.results.map(block => block.seq), [9]);
  assert.ok(grouped.entries.slice(0, 7).filter(entry => entry.head.role === 'tool_call').every(entry => entry.results.length === 0));
});

test('adjacent partial call and orphan-result fragments retain their source order', () => {
  const data = blocks([
    tool(1, 'tool_call', 'Bash', 'a', '{"command":"', { partial_after: true, first_seq: 1 }),
    tool(2, 'tool_call', 'Bash', 'a', 'printf x"}', { partial_before: true, first_seq: 2 }),
    tool(3, 'tool_result', 'Bash', 'a', 'result', { error: false, first_seq: 3 }),
    tool(4, 'tool_result', 'Read', 'orphan', 'one', { partial_after: true, first_seq: 4 }),
    tool(5, 'tool_result', 'Read', 'orphan', 'two', { partial_before: true, first_seq: 5 }),
  ]);
  const grouped = groupTranscript(data);
  assert.deepEqual(grouped.entries.map(entry => entry.head.seq), [1, 4]);
  assert.deepEqual(grouped.entries[0].calls.map(block => block.content), ['{"command":"', 'printf x"}']);
  assert.deepEqual(grouped.entries[1].results.map(block => block.content), ['one', 'two']);
});

test('only matching adjacent projected fragments close a partial edge', () => {
  const data = blocks([
    tool(1, 'tool_result', 'Bash', 'a', 'one ', { error: false, first_seq: 1, last_seq: 1 }),
    tool(3, 'tool_result', 'Bash', 'a', 'two', { error: false, first_seq: 3, last_seq: 3, partial_before: true }),
    { seq: 4, role: 'assistant', name: null, content: 'between', at: 104, content_complete: true },
    tool(5, 'tool_result', 'Bash', 'a', 'three', { error: false, first_seq: 5, last_seq: 5, partial_before: true }),
  ]);
  const grouped = groupTranscript(data);
  assert.equal(grouped.partialBefore.has(data[1].key), false);
  assert.equal(grouped.partialBefore.has(data[3].key), true, 'an intervening source block prevents assumed continuity');
  const contradictory = blocks([
    tool(10, 'tool_result', 'Bash', 'a', 'left', { error: false, first_seq: 10, last_seq: 10, partial_after: true }),
    tool(11, 'tool_result', 'Bash', 'a', 'right', { error: false, first_seq: 11, last_seq: 11, starts_block: true, partial_before: false }),
  ]);
  assert.equal(groupTranscript(contradictory).partialAfter.has(contradictory[0].key), true, 'a new source block cannot resolve a contradictory missing edge');
});

test('one expandable row shows each command with its own output and no raw metadata', async () => {
  const messages = [
    tool(1, 'tool_call', 'Bash', 'a', '{"command":"printf A","timeout_ms":3000}'),
    tool(2, 'tool_call', 'Bash', 'b', '{"command":"printf B"}'),
    tool(3, 'tool_result', 'Bash', 'b', 'B output', { error: true, content_complete: false, omitted_bytes: 12 }),
    tool(4, 'tool_result', 'Bash', 'a', '[{"type":"text","text":"A first"},{"type":"text","text":"A second"}]', { error: false }),
  ];
  const setup = await createTestRenderer({ width: 120, height: 40 }), client = source(() => ({ messages }));
  const unmount = mountHub(setup.renderer, client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('Agent Run') && value.includes('Active'));
    setup.mockInput.pressKey('1'); setup.mockInput.pressKey('G');
    let frame = await setup.waitForFrame(value => value.includes('printf A') && value.includes('printf B'));
    let rows = frame.split('\n');
    assert.equal(rows.filter(row => /[▸▾] Bash/.test(row)).length, 2);
    assert.match(rows.find(row => row.includes('printf A')) ?? '', / {2,}ok ·/);
    assert.match(rows.find(row => row.includes('printf B')) ?? '', / {2,}error ·/);
    assert.ok((rows.find(row => row.includes('printf A')) ?? '').includes(`${clock(101)} → ${clock(104)} · 3s`));
    assert.ok((rows.find(row => row.includes('printf B')) ?? '').includes(`${clock(102)} → ${clock(103)} · 1s`));
    assert.match(frame, /Incomplete output/);
    await setup.mockMouse.click(43, rows.findIndex(row => row.includes('printf A')));
    frame = await setup.waitForFrame(value => value.includes('command: printf A') && value.includes('A first') && value.includes('A second'));
    assert.match(frame, /timeout_ms: 3000/);
    assert.doesNotMatch(frame, /B output|Metadata:|raw_ref|"type":"text"/);
    rows = frame.split('\n');
    await setup.mockMouse.click(43, rows.findIndex(row => row.includes('printf B')));
    frame = await setup.waitForFrame(value => value.includes('B output') && value.includes('A first'));
    assert.match(frame, /command: printf B/);
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('a result loaded before its older call joins it without losing expansion', async () => {
  const call = tool(1, 'tool_call', 'Bash', 'a', '{"command":"printf older"}');
  const result = tool(2, 'tool_result', 'Bash', 'a', 'older output', { error: false });
  const setup = await createTestRenderer({ width: 120, height: 40 });
  const client = source(params => typeof params.before_cursor === 'number' ? { messages: [call] } : { messages: [result], previous: 2, complete: false });
  const unmount = mountHub(setup.renderer, client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('Agent Run') && value.includes('Active'));
    setup.mockInput.pressKey('1'); setup.mockInput.pressKey('G');
    let frame = await setup.waitForFrame(value => value.includes('result only'));
    await setup.mockMouse.click(43, frame.split('\n').findIndex(row => row.includes('result only')));
    await setup.waitForFrame(value => value.includes('older output'));
    setup.mockInput.pressKey('g');
    frame = await setup.waitForFrame(value => value.includes('command: printf older') && value.includes('older output'));
    assert.equal(frame.split('\n').filter(row => /[▸▾] Bash/.test(row)).length, 1);
    assert.doesNotMatch(frame, /result only|Metadata:/);
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('a later result updates the expanded call without opening another row', async () => {
  const call = tool(1, 'tool_call', 'Bash', 'a', '{"command":"printf live"}');
  const result = tool(2, 'tool_result', 'Bash', 'a', 'live output', { error: false });
  let delivered = false;
  const setup = await createTestRenderer({ width: 120, height: 40 });
  const client = source(params => typeof params.cursor === 'number' ? { messages: delivered ? [result] : [] } : { messages: [call] });
  const unmount = mountHub(setup.renderer, client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('Agent Run') && value.includes('Active'));
    setup.mockInput.pressKey('1'); setup.mockInput.pressKey('G');
    let frame = await setup.waitForFrame(value => value.includes('printf live') && value.includes('result not loaded'));
    assert.match(frame, new RegExp(`${clock(101)} → --:--:--`));
    await setup.mockMouse.click(43, frame.split('\n').findIndex(row => row.includes('printf live')));
    await setup.waitForFrame(value => value.includes('command: printf live') && value.includes('Output not in loaded history'));
    delivered = true;
    setup.mockInput.pressKey('r');
    frame = await setup.waitForFrame(value => value.includes('command: printf live') && value.includes('live output'));
    assert.equal(frame.split('\n').filter(row => /[▸▾] Bash/.test(row)).length, 1);
    assert.match(frame.split('\n').find(row => row.includes('printf live') && row.includes('Bash')) ?? '', / {2,}ok ·/);
    assert.ok(frame.includes(`${clock(101)} → ${clock(102)} · 1s`));
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('missing, reversed, or unfinished result clocks never imply a duration', async () => {
  const messages = [
    tool(1, 'tool_call', 'Bash', 'a', '{"command":"reversed"}', { at: 200 }),
    tool(2, 'tool_result', 'Bash', 'a', 'a', { error: false, at: 199 }),
    tool(3, 'tool_call', 'Bash', 'b', '{"command":"missing"}', { at: 300 }),
    tool(4, 'tool_result', 'Bash', 'b', 'b', { error: false, at: null }),
    tool(5, 'tool_call', 'Bash', 'c', '{"command":"partial"}', { at: 400, first_seq: 5, last_seq: 5 }),
    tool(6, 'tool_result', 'Bash', 'c', 'c', { error: false, at: 401, first_seq: 6, last_seq: 6, partial_after: true }),
    tool(7, 'tool_call', 'Bash', 'd', '{"command":"late input"}', { at: 500, first_seq: 7, last_seq: 7, partial_before: true }),
    tool(8, 'tool_result', 'Bash', 'd', 'd', { error: false, at: 501, first_seq: 8, last_seq: 8 }),
    tool(9, 'tool_call', 'Bash', 'e', '{"command":"multiple rows"}', { at: 600, first_seq: 9, last_seq: 9 }),
    tool(12, 'tool_result', 'Bash', 'e', 'e', { error: false, at: 601, first_seq: 10, last_seq: 12 }),
  ];
  const setup = await createTestRenderer({ width: 160, height: 40 }), client = source(() => ({ messages }));
  const unmount = mountHub(setup.renderer, client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('Agent Run') && value.includes('Active'));
    setup.mockInput.pressKey('1'); setup.mockInput.pressKey('G');
    const frame = await setup.waitForFrame(value => value.includes('reversed') && value.includes('missing') && value.includes('partial') && value.includes('multiple rows'));
    const rows = frame.split('\n');
    assert.ok((rows.find(row => row.includes('reversed')) ?? '').includes(`${clock(200)} → ${clock(199)} · duration unknown`));
    assert.ok((rows.find(row => row.includes('missing')) ?? '').includes(`${clock(300)} → --:--:-- · duration unknown`));
    assert.ok((rows.find(row => row.includes('partial') && row.includes('Bash')) ?? '').includes(`${clock(400)} → --:--:-- · duration unknown`));
    assert.ok((rows.find(row => row.includes('late input') && row.includes('Bash')) ?? '').includes(`--:--:-- → ${clock(501)} · duration unknown`));
    assert.ok((rows.find(row => row.includes('multiple rows') && row.includes('Bash')) ?? '').includes(`${clock(600)} → --:--:-- · duration unknown`));
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('a narrow view keeps tool identity, command preview and second-precision timing', async () => {
  const messages = [
    tool(1, 'tool_call', 'LongToolNameForSyntheticRead', 'a', '{"command":"printf readable-command"}'),
    tool(2, 'tool_result', 'LongToolNameForSyntheticRead', 'a', 'ok', { error: false }),
  ];
  const setup = await createTestRenderer({ width: 60, height: 24 }), client = source(() => ({ messages }));
  const unmount = mountHub(setup.renderer, client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('Agent Run') && value.includes('Active'));
    setup.mockInput.pressKey('1'); setup.mockInput.pressKey('G');
    await setup.waitForFrame(value => value.includes('Inspect execution history'));
    setup.mockInput.pressEnter();
    const frame = await setup.waitForFrame(value => value.includes('LongT') && value.includes('printf'));
    assert.ok(frame.includes(`${clock(101)}→${clock(102)} · 1s`));
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('a multi-row result obtains its end time from the matching final raw record', async () => {
  const messages = [
    tool(1, 'tool_call', 'Bash', 'a', '{"command":"verified time"}', { at: 101, first_seq: 1, last_seq: 1 }),
    tool(4, 'tool_result', 'Bash', 'a', 'long result', { error: false, at: 102, first_seq: 2, last_seq: 4 }),
    tool(5, 'tool_call', 'Bash', 'b', '{"command":"unverified time"}', { at: 105, first_seq: 5, last_seq: 5 }),
    tool(8, 'tool_result', 'Bash', 'b', 'other result', { error: false, at: 106, first_seq: 6, last_seq: 8 }),
    tool(9, 'tool_call', 'Bash', 'c', '{"command":"projected row"}', { at: 109, first_seq: 9, last_seq: 9 }),
    tool(12, 'tool_result', 'Bash', 'c', 'third result', { error: false, at: 110, first_seq: 10, last_seq: 12 }),
  ];
  const setup = await createTestRenderer({ width: 160, height: 40 }), demo = createDemoClient();
  const requests: number[] = [];
  const client: ObservationClient = {
    async read(resource, params = {}, signal) {
      if (resource !== 'run.transcript') return demo.read(resource, params, signal);
      if (params.view === 'raw') {
        const cursor = Number(params.cursor); requests.push(cursor);
        const row = cursor === 3 ? tool(4, 'tool_result', 'Bash', 'a', 'last chunk', { error: false, at: 105 }) : cursor === 7 ? tool(8, 'tool_result', 'Bash', 'wrong-ref', 'other', { error: false, at: 999 }) : tool(12, 'tool_result', 'Bash', 'c', 'projected', { error: false, at: 999, first_seq: 10, last_seq: 12 });
        return { schema_version: 1, source: 'run', resource, observed_at_ms: Date.now(), outcome: 'ok', error: null, data: { agent_id: params.agent_id, cursor, view: 'raw', messages: [row], complete: true } };
      }
      return { schema_version: 1, source: 'run', resource, observed_at_ms: Date.now(), outcome: 'ok', error: null, data: { agent_id: params.agent_id, view: 'blocks', cursor: params.cursor ?? 0, messages: typeof params.cursor === 'number' ? [] : messages, complete: true, previous_cursor: null, next_cursor: null, resume_cursor: typeof params.cursor === 'number' ? params.cursor : 12 } };
    },
    close: () => demo.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('Agent Run') && value.includes('Active'));
    setup.mockInput.pressKey('1'); setup.mockInput.pressKey('G');
    let frame = await setup.waitForFrame(value => value.includes('verified time') && value.includes(`${clock(101)} → ${clock(105)} · 4s`));
    await setup.waitFor(() => requests.length === 3);
    frame = setup.captureCharFrame();
    assert.ok((frame.split('\n').find(row => row.includes('unverified time')) ?? '').includes(`${clock(105)} → --:--:-- · duration unknown`));
    assert.ok((frame.split('\n').find(row => row.includes('projected row')) ?? '').includes(`${clock(109)} → --:--:-- · duration unknown`));
    assert.deepEqual(requests, [3, 7, 11]);
    setup.mockInput.pressKey('r');
    await new Promise<void>(resolve => setImmediate(resolve));
    await setup.renderOnce();
    assert.deepEqual(requests, [3, 7, 11], 'cached and temporarily unavailable clocks do not cause repeated reads');
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('a slow final-time read is not duplicated and is cancelled on unmount', async () => {
  const messages = [
    tool(1, 'tool_call', 'Bash', 'a', '{"command":"slow clock"}', { first_seq: 1, last_seq: 1 }),
    tool(4, 'tool_result', 'Bash', 'a', 'result', { error: false, first_seq: 2, last_seq: 4 }),
  ];
  const setup = await createTestRenderer({ width: 120, height: 40 }), demo = createDemoClient();
  let requests = 0, aborted = false;
  const client: ObservationClient = {
    async read(resource, params = {}, signal) {
      if (resource !== 'run.transcript') return demo.read(resource, params, signal);
      if (params.view === 'raw') {
        requests++;
        return new Promise(resolve => signal?.addEventListener('abort', () => { aborted = true; resolve({ schema_version: 1, source: 'run', resource, observed_at_ms: Date.now(), outcome: 'unavailable', data: null, error: { code: 'cancelled', message: 'cancelled' } }); }, { once: true }));
      }
      return { schema_version: 1, source: 'run', resource, observed_at_ms: Date.now(), outcome: 'ok', error: null, data: { agent_id: params.agent_id, view: 'blocks', cursor: 0, messages, complete: true, previous_cursor: null, next_cursor: null, resume_cursor: 4 } };
    },
    close: () => demo.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('Agent Run') && value.includes('Active'));
    setup.mockInput.pressKey('1'); setup.mockInput.pressKey('G');
    await setup.waitForFrame(value => value.includes('slow clock'));
    await setup.waitFor(() => requests === 1);
    setup.mockInput.pressKey('r');
    setup.mockInput.pressKey('r');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(requests, 1);
    unmount();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(aborted, true);
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('changing the selected session cancels its outstanding final-time read', async () => {
  const setup = await createTestRenderer({ width: 120, height: 40 }), demo = createDemoClient();
  const requests: string[] = []; let firstAborted = false;
  const client: ObservationClient = {
    async read(resource, params = {}, signal) {
      if (resource !== 'run.transcript') return demo.read(resource, params, signal);
      const id = String(params.agent_id), first = id === 'demo-inspect', ref = first ? 'a' : 'b';
      if (params.view === 'raw') {
        requests.push(id);
        if (first) return new Promise(resolve => signal?.addEventListener('abort', () => { firstAborted = true; resolve({ schema_version: 1, source: 'run', resource, observed_at_ms: Date.now(), outcome: 'unavailable', data: null, error: { code: 'cancelled', message: 'cancelled' } }); }, { once: true }));
        return { schema_version: 1, source: 'run', resource, observed_at_ms: Date.now(), outcome: 'ok', error: null, data: { agent_id: id, view: 'raw', cursor: 3, messages: [tool(4, 'tool_result', 'Bash', ref, 'last', { error: false, at: 105 })], complete: true } };
      }
      const messages = [tool(1, 'tool_call', 'Bash', ref, `{"command":"${first ? 'first-session' : 'second-session'}"}`, { first_seq: 1, last_seq: 1, at: 101 }), tool(4, 'tool_result', 'Bash', ref, 'result', { error: false, first_seq: 2, last_seq: 4, at: 102 })];
      return { schema_version: 1, source: 'run', resource, observed_at_ms: Date.now(), outcome: 'ok', error: null, data: { agent_id: id, view: 'blocks', cursor: 0, messages, complete: true, previous_cursor: null, next_cursor: null, resume_cursor: 4 } };
    },
    close: () => demo.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('Agent Run') && value.includes('Active'));
    setup.mockInput.pressKey('1'); setup.mockInput.pressKey('G');
    await setup.waitForFrame(value => value.includes('first-session'));
    await setup.waitFor(() => requests.length === 1);
    setup.mockInput.pressArrow('down');
    await setup.waitForFrame(value => value.includes('second-session') && value.includes(`${clock(101)} → ${clock(105)} · 4s`));
    assert.equal(firstAborted, true);
    assert.deepEqual(requests, ['demo-inspect', 'demo-index']);
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('final-time reads target visible rows and back off when the source is unavailable', async () => {
  const messages = Array.from({ length: 10 }, (_, index) => [
    tool(index * 3 + 1, 'tool_call', 'Bash', `ref-${index}`, `{"command":"cmd-${index}"}`, { first_seq: index * 3 + 1, last_seq: index * 3 + 1 }),
    tool(index * 3 + 3, 'tool_result', 'Bash', `ref-${index}`, 'result', { error: false, first_seq: index * 3 + 2, last_seq: index * 3 + 3 }),
  ]).flat();
  const setup = await createTestRenderer({ width: 160, height: 20 }), demo = createDemoClient();
  const requests: number[] = [];
  const client: ObservationClient = {
    async read(resource, params = {}, signal) {
      if (resource !== 'run.transcript') return demo.read(resource, params, signal);
      if (params.view === 'raw') {
        requests.push(Number(params.cursor));
        return { schema_version: 1, source: 'run', resource, observed_at_ms: Date.now(), outcome: 'unavailable', data: null, error: { code: 'offline', message: 'offline' } };
      }
      return { schema_version: 1, source: 'run', resource, observed_at_ms: Date.now(), outcome: 'ok', error: null, data: { agent_id: params.agent_id, view: 'blocks', cursor: 0, messages, complete: true, previous_cursor: null, next_cursor: null, resume_cursor: 30 } };
    },
    close: () => demo.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('Agent Run') && value.includes('Active'));
    setup.mockInput.pressKey('1'); setup.mockInput.pressKey('G');
    const frame = await setup.waitForFrame(value => value.includes('cmd-9'));
    await setup.waitFor(() => requests.length === 1);
    const firstVisible = Number(frame.match(/cmd-(\d)/)?.[1]);
    assert.equal(requests[0], firstVisible * 3 + 2);
    setup.mockInput.pressKey('r');
    setup.mockInput.pressKey('r');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(requests.length, 1, 'an unavailable source does not cause a burst of background reads');
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('a narrow session list waits until history is visible before reading tool times', async () => {
  const messages = [tool(1, 'tool_call', 'Bash', 'a', '{"command":"narrow"}', { first_seq: 1, last_seq: 1 }), tool(4, 'tool_result', 'Bash', 'a', 'result', { error: false, first_seq: 2, last_seq: 4 })];
  const setup = await createTestRenderer({ width: 80, height: 24 }), demo = createDemoClient();
  let requests = 0;
  const client: ObservationClient = {
    async read(resource, params = {}, signal) {
      if (resource !== 'run.transcript') return demo.read(resource, params, signal);
      if (params.view === 'raw') {
        requests++;
        return { schema_version: 1, source: 'run', resource, observed_at_ms: Date.now(), outcome: 'ok', error: null, data: { agent_id: params.agent_id, view: 'raw', cursor: 3, messages: [tool(4, 'tool_result', 'Bash', 'a', 'last', { error: false, at: 105 })], complete: true } };
      }
      return { schema_version: 1, source: 'run', resource, observed_at_ms: Date.now(), outcome: 'ok', error: null, data: { agent_id: params.agent_id, view: 'blocks', cursor: 0, messages, complete: true, previous_cursor: null, next_cursor: null, resume_cursor: 4 } };
    },
    close: () => demo.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('Agent Run') && value.includes('Active'));
    setup.mockInput.pressKey('1'); setup.mockInput.pressKey('G');
    await setup.waitForFrame(value => value.includes('[Sessions]') && value.includes('Inspect execution history'));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(requests, 0);
    setup.mockInput.pressEnter();
    await setup.waitForFrame(value => value.includes('narrow') && value.includes(`${clock(101)} → ${clock(105)} · 4s`));
    assert.equal(requests, 1);
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('a streamed result no longer claims a resolved page boundary is incomplete', async () => {
  const call = tool(1, 'tool_call', 'Bash', 'a', '{"command":"printf streamed"}', { first_seq: 1, last_seq: 1 });
  const first = tool(2, 'tool_result', 'Bash', 'a', 'before ', { error: false, first_seq: 2, last_seq: 2 });
  const next = tool(3, 'tool_result', 'Bash', 'a', 'after', { error: false, first_seq: 3, last_seq: 3, partial_before: true, starts_block: false });
  let delivered = false;
  const setup = await createTestRenderer({ width: 120, height: 40 });
  const client = source(params => typeof params.cursor === 'number' ? { messages: delivered ? [next] : [] } : { messages: [call, first] });
  const unmount = mountHub(setup.renderer, client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('Agent Run') && value.includes('Active'));
    setup.mockInput.pressKey('1'); setup.mockInput.pressKey('G');
    let frame = await setup.waitForFrame(value => value.includes('printf streamed'));
    await setup.mockMouse.click(43, frame.split('\n').findIndex(row => row.includes('printf streamed')));
    await setup.waitForFrame(value => value.includes('before'));
    delivered = true;
    setup.mockInput.pressKey('r');
    frame = await setup.waitForFrame(value => value.includes('before after'));
    assert.doesNotMatch(frame, /Incomplete output|bodies incomplete\/unknown/);
    assert.match(frame, /loaded history complete/);
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('expanding a paused long tool keeps its heading in view', async () => {
  const messages = [tool(1, 'tool_call', 'Bash', 'a', '{"command":"long output"}'), tool(2, 'tool_result', 'Bash', 'a', Array.from({ length: 80 }, (_, index) => `line-${index}`).join('\n'), { error: false })];
  const setup = await createTestRenderer({ width: 120, height: 40 }), client = source(() => ({ messages }));
  const unmount = mountHub(setup.renderer, client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('Agent Run') && value.includes('Active'));
    setup.mockInput.pressKey('1'); setup.mockInput.pressKey('G');
    let frame = await setup.waitForFrame(value => value.includes('long output'));
    setup.mockInput.pressKey('f');
    await setup.waitForFrame(value => value.includes('Follow paused'));
    await setup.mockMouse.click(43, frame.split('\n').findIndex(row => row.includes('long output')));
    frame = await setup.waitForFrame(value => value.includes('command: long output') && value.includes('line-0'));
    assert.match(frame, /▾ Bash · long output/);
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('loading an earlier output fragment preserves the selected long-output part', async () => {
  const call = tool(1, 'tool_call', 'Bash', 'a', '{"command":"large"}', { first_seq: 1, last_seq: 1 });
  const prefix = tool(2, 'tool_result', 'Bash', 'a', 'P'.repeat(1000), { error: false, first_seq: 2, last_seq: 2, partial_after: true });
  const suffix = tool(3, 'tool_result', 'Bash', 'a', 'S'.repeat(9000) + '\nSUFFIX-END', { error: false, first_seq: 3, last_seq: 3, partial_before: true });
  const setup = await createTestRenderer({ width: 120, height: 40 });
  const client = source(params => typeof params.before_cursor === 'number' ? { messages: [call, prefix] } : { messages: [suffix], previous: 3, complete: false });
  const unmount = mountHub(setup.renderer, client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('Agent Run') && value.includes('Active'));
    setup.mockInput.pressKey('1'); setup.mockInput.pressKey('G');
    let frame = await setup.waitForFrame(value => value.includes('result only'));
    await setup.mockMouse.click(43, frame.split('\n').findIndex(row => row.includes('result only')));
    await setup.waitForFrame(value => value.includes('▾ Bash') && value.includes('Output'));
    setup.mockInput.pressKey(']');
    await setup.waitForFrame(value => value.includes('SUFFIX-END'));
    setup.mockInput.pressKey('g');
    frame = await setup.waitForFrame(value => value.includes('SUFFIX-END') && value.includes('loaded history complete'));
    assert.doesNotMatch(frame, /Incomplete output|result only/);
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('prepending output preserves an anchor after expanded tab characters', async () => {
  const call = tool(1, 'tool_call', 'Bash', 'a', '{"command":"tabs"}', { first_seq: 1, last_seq: 1 });
  const prefix = tool(2, 'tool_result', 'Bash', 'a', 'P'.repeat(5000), { error: false, first_seq: 2, last_seq: 2, partial_after: true });
  const suffix = tool(3, 'tool_result', 'Bash', 'a', '\t'.repeat(3000) + '\nMARKER-AT-8001\n' + 'z'.repeat(1200), { error: false, first_seq: 3, last_seq: 3, partial_before: true });
  const setup = await createTestRenderer({ width: 120, height: 40 });
  const client = source(params => typeof params.before_cursor === 'number' ? { messages: [call, prefix] } : { messages: [suffix], previous: 3, complete: false });
  const unmount = mountHub(setup.renderer, client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('Agent Run') && value.includes('Active'));
    setup.mockInput.pressKey('1'); setup.mockInput.pressKey('G');
    const frame = await setup.waitForFrame(value => value.includes('result only'));
    await setup.mockMouse.click(43, frame.split('\n').findIndex(row => row.includes('result only')));
    await setup.waitForFrame(value => value.includes('▾ Bash') && value.includes('Output'));
    setup.mockInput.pressTab(); setup.mockInput.pressTab();
    setup.mockInput.pressKey('\x1b[6~'.repeat(8));
    await setup.waitForFrame(value => value.includes('MARKER-AT-8001'));
    await setup.waitForFrame(value => value.includes('Follow paused'));
    setup.mockInput.pressKey('g');
    await setup.waitForFrame(value => value.includes('MARKER-AT-8001') && value.includes('loaded history complete'));
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('paired long output remains readable across parts and source fragments', async () => {
  const messages = [
    tool(1, 'tool_call', 'Bash', 'a', '{"command":"produce output"}'),
    tool(2, 'tool_result', 'Bash', 'a', 'x'.repeat(8191), { error: false }),
    tool(3, 'tool_result', 'Bash', 'a', '😀FINAL-OUTPUT', { error: false }),
  ];
  const setup = await createTestRenderer({ width: 80, height: 24 }), client = source(() => ({ messages }));
  const unmount = mountHub(setup.renderer, client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('Agent Run') && value.includes('Active'));
    setup.mockInput.pressKey('1'); setup.mockInput.pressKey('G');
    await setup.waitForFrame(value => value.includes('Inspect execution history'));
    setup.mockInput.pressEnter();
    await setup.waitForFrame(value => value.includes('produce output'));
    setup.mockInput.pressEnter();
    await setup.waitForFrame(value => value.includes('▾ Bash') && value.includes('Output'));
    setup.mockInput.pressKey(']');
    const frame = await setup.waitForFrame(value => value.includes('😀FINAL-OUTPUT'));
    assert.doesNotMatch(frame, /Metadata:/);
  } finally { unmount(); await client.close(); await setup.dispose(); }
});
