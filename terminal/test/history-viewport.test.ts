/** Exercises history layout and mouse navigation using synthetic transcript data. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestRenderer } from '@opentui/core/testing';
import { createDemoClient } from '../src/demo.ts';
import { mountHub } from '../src/hub.ts';
import type { ObservationClient } from '../src/api.ts';

/** Supplies an isolated sequence of short tool messages or one long assistant message. */
function historyClient(count: number, long = false): ObservationClient {
  const demo = createDemoClient();
  return {
    async read(resource, params = {}, signal) {
      if (resource !== 'run.transcript') return demo.read(resource, params, signal);
      const messages = long
        ? [{ seq: 1, role: 'assistant', content: Array.from({ length: 100 }, (_, index) => `line-${String(index + 1).padStart(3, '0')}`).join('\n'), at: 100, content_complete: true }]
        : Array.from({ length: count }, (_, index) => ({ seq: index + 1, role: 'tool', name: `Tool-${String(index + 1).padStart(3, '0')}`, content: 'synthetic', at: 100, content_complete: true, error: false }));
      return { schema_version: 1, source: 'run', resource, observed_at_ms: Date.now(), outcome: 'ok', error: null, data: { agent_id: params.agent_id, view: 'blocks', cursor: 0, messages, complete: true, previous_cursor: null, next_cursor: null, resume_cursor: messages.at(-1)?.seq ?? null } };
    },
    close: () => demo.close(),
  };
}

/** Replaces one tool with a long assistant block to exercise mixed message lengths. */
function mixedHistoryClient(count: number, longIndex: number): ObservationClient {
  const client = historyClient(count);
  return {
    async read(resource, params, signal) {
      const response = await client.read(resource, params, signal);
      if (resource !== 'run.transcript') return response;
      const data = response.data as { messages: Record<string, unknown>[] };
      return { ...response, data: { ...data, messages: data.messages.map((message, index) => index === longIndex ? { ...message, role: 'assistant', content: Array.from({ length: 100 }, (_, row) => `Long-${String(row + 1).padStart(3, '0')}`).join('\n') } : message) } };
    },
    close: () => client.close(),
  };
}

test('the history scrollbar has one continuous background-colored thumb', async () => {
  const setup = await createTestRenderer({ width: 120, height: 40 }), client = historyClient(100);
  const unmount = mountHub(setup.renderer, client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('4 loaded / 4 reported'));
    setup.mockInput.pressKey('1'); setup.mockInput.pressKey('G');
    await setup.waitForFrame(value => value.includes('Tool-100'));
    const frame = setup.captureSpans();
    const background = (row: number) => frame.lines[row].spans.at(-1)!.bg.toInts().join(',');
    const track = background(5), thumb = Array.from({ length: 31 }, (_, offset) => offset + 5).filter(row => background(row) !== track);
    assert.ok(thumb.length > 0, 'the thumb fills cells with its background color');
    assert.equal(thumb.at(-1)! - thumb[0] + 1, thumb.length, 'the thumb has no gaps');
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('history uses tall viewports and its scrollbar moves across loaded messages', async () => {
  const setup = await createTestRenderer({ width: 120, height: 60 }), client = historyClient(80);
  const unmount = mountHub(setup.renderer, client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('Agent Run') && value.includes('Active'));
    setup.mockInput.pressKey('1'); setup.mockInput.pressKey('G');
    let frame = await setup.waitForFrame(value => value.includes('Tool-080') && value.includes('Following'));
    const rows = frame.split('\n'), last = rows.findIndex(row => row.includes('Tool-080'));
    assert.ok(last > 45, `last message should use the lower viewport, row ${last}`);
    assert.ok((frame.match(/Tool-\d{3}/g) ?? []).length >= 20, 'more than eight messages fill the tall viewport');
    await setup.mockMouse.drag(119, 54, 119, 5);
    frame = await setup.waitForFrame(value => value.includes('Tool-001') && value.includes('Follow paused'));
    assert.doesNotMatch(frame, /Tool-080/);
    await setup.mockMouse.click(119, 55);
    await setup.waitForFrame(value => value.includes('Tool-080') && value.includes('Following'));

    setup.mockInput.pressEnter();
    setup.mockInput.pressKey('HOME');
    await setup.waitForFrame(value => value.includes('Tool-001'));
    setup.resize(120, 70);
    frame = await setup.waitForFrame(value => value.includes('Tool-025') && value.includes('Tool-001'));
    assert.ok(frame.split('\n').findIndex(row => row.includes('Tool-025')) > 45, 'resizing expands the paused window while keeping its anchor');
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('history window changes keep the pane filled and the wheel works over its gutter', async () => {
  const setup = await createTestRenderer({ width: 120, height: 60 }), client = historyClient(30);
  const unmount = mountHub(setup.renderer, client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('Agent Run') && value.includes('Active'));
    setup.mockInput.pressKey('1'); setup.mockInput.pressKey('G');
    await setup.waitForFrame(value => value.includes('Tool-030'));
    setup.mockInput.pressEnter();
    setup.mockInput.pressKey('HOME');
    await setup.waitForFrame(value => value.includes('Tool-001'));
    setup.mockInput.pressKey('\x1b[6~');
    await setup.renderOnce();
    setup.mockInput.pressKey('\x1b[6~');
    const frame = await setup.waitForFrame(value => value.includes('Tool-030') && value.includes('Follow paused'));
    assert.ok(frame.includes('Tool-006') && frame.split('\n').findIndex(row => row.includes('Tool-030')) > 45, 'the final window fills the viewport');
    setup.mockInput.pressKey('\x1b[<64;39;46M'.repeat(3));
    await setup.waitForFrame(value => value.includes('Tool-025') && !value.includes('Tool-030'));
    setup.mockInput.pressKey('\x1b[<65;119;46M'.repeat(3));
    await setup.waitForFrame(value => value.includes('Tool-030'));
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('wheel input reaches the history panel below its last message', async () => {
  const setup = await createTestRenderer({ width: 120, height: 60 }), client = historyClient(3);
  const unmount = mountHub(setup.renderer, client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('Agent Run') && value.includes('Active'));
    setup.mockInput.pressKey('1'); setup.mockInput.pressKey('G');
    await setup.waitForFrame(value => value.includes('Tool-003') && value.includes('Following'));
    await setup.mockMouse.scroll(100, 50, 'up');
    await setup.waitForFrame(value => value.includes('Follow paused'));
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('scrollbar can seek inside a single long message', async () => {
  const setup = await createTestRenderer({ width: 120, height: 40 }), client = historyClient(1, true);
  const unmount = mountHub(setup.renderer, client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('Agent Run') && value.includes('Active'));
    setup.mockInput.pressKey('1'); setup.mockInput.pressKey('G');
    await setup.waitForFrame(value => value.includes('line-100'));
    await setup.mockMouse.click(119, 5);
    await setup.waitForFrame(value => value.includes('line-001') && value.includes('Follow paused'));
    await setup.mockMouse.click(119, 20);
    const frame = await setup.waitForFrame(value => value.includes('line-050'));
    assert.doesNotMatch(frame, /line-001/);
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

for (const direction of ['forward', 'backward'] as const) {
  test(`crossing a history window keeps the nearby long message readable ${direction}`, async () => {
    const setup = await createTestRenderer({ width: 120, height: 60 }), client = mixedHistoryClient(30, direction === 'forward' ? 29 : 3);
    const unmount = mountHub(setup.renderer, client, 'live', () => {});
    try {
      await setup.waitForFrame(value => value.includes('Agent Run') && value.includes('Active'));
      setup.mockInput.pressKey('1'); setup.mockInput.pressKey('G');
      await setup.waitForFrame(value => value.includes(direction === 'forward' ? 'Long-100' : 'Tool-030'));
      setup.mockInput.pressEnter();
      if (direction === 'forward') {
        setup.mockInput.pressKey('HOME');
        await setup.waitForFrame(value => value.includes('Tool-001'));
        setup.mockInput.pressKey('\x1b[6~');
        await setup.renderOnce();
        setup.mockInput.pressKey('\x1b[6~');
        const frame = await setup.waitForFrame(value => value.includes('Tool-027') && value.includes('Long-001'));
        assert.doesNotMatch(frame, /Long-100/, 'the beginning of the long message is not skipped');
      } else {
        setup.mockInput.pressKey('\x1b[5~');
        await setup.renderOnce();
        setup.mockInput.pressKey('\x1b[5~');
        const frame = await setup.waitForFrame(value => value.includes('Long-100'));
        assert.doesNotMatch(frame, /Long-001/, 'backward navigation reaches the end of the previous message first');
      }
    } finally { unmount(); await client.close(); await setup.dispose(); }
  });
}

test('scrollbar seeks an assistant message outside the current window', async () => {
  const setup = await createTestRenderer({ width: 120, height: 60 }), base = historyClient(80);
  const client: ObservationClient = {
    async read(resource, params, signal) {
      const response = await base.read(resource, params, signal);
      if (resource !== 'run.transcript') return response;
      const data = response.data as { messages: Record<string, unknown>[] };
      return { ...response, data: { ...data, messages: data.messages.map((message, index) => ({ ...message, role: 'assistant', content: `Message-${String(index + 1).padStart(3, '0')}` })) } };
    },
    close: () => base.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('Agent Run') && value.includes('Active'));
    setup.mockInput.pressKey('1'); setup.mockInput.pressKey('G');
    await setup.waitForFrame(value => value.includes('Message-080'));
    setup.mockInput.pressEnter();
    setup.mockInput.pressKey('HOME');
    await setup.waitForFrame(value => value.includes('Message-001'));
    await setup.mockMouse.click(119, 54);
    const frame = await setup.waitForFrame(value => value.includes('Message-075') && value.includes('Follow paused'));
    const first = Number(frame.match(/Message-(\d{3})/)?.[1]);
    assert.ok(first >= 60, `seek should start near the requested assistant message, got ${first}`);
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('Home while history loads still fills the viewport after the response', async () => {
  const setup = await createTestRenderer({ width: 120, height: 60 }), base = historyClient(30);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const client: ObservationClient = {
    async read(resource, params, signal) { if (resource === 'run.transcript') await pending; return base.read(resource, params, signal); },
    close: () => base.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('Agent Run') && value.includes('Active'));
    setup.mockInput.pressKey('1');
    await setup.waitForFrame(value => value.includes('Loading history'));
    setup.mockInput.pressEnter();
    setup.mockInput.pressKey('HOME');
    release();
    await setup.waitForFrame(value => value.includes('Tool-001') && value.includes('Tool-020'));
  } finally { release(); unmount(); await client.close(); await setup.dispose(); }
});

test('a captured scrollbar cannot move history after changing tabs', async () => {
  const setup = await createTestRenderer({ width: 120, height: 60 }), client = historyClient(80);
  const unmount = mountHub(setup.renderer, client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('Agent Run') && value.includes('Active'));
    setup.mockInput.pressKey('1'); setup.mockInput.pressKey('G');
    await setup.waitForFrame(value => value.includes('Tool-080'));
    await setup.mockMouse.pressDown(119, 54);
    await setup.mockMouse.moveTo(119, 30);
    const paused = await setup.waitForFrame(value => value.includes('Follow paused'));
    const first = paused.match(/Tool-\d{3}/)?.[0];
    assert.ok(first);
    setup.mockInput.pressKey('d');
    await setup.waitForFrame(value => value.includes('[Details]'));
    await setup.mockMouse.moveTo(119, 5);
    await setup.mockMouse.release(119, 5);
    await setup.renderOnce();
    await setup.mockMouse.click(43, 3);
    const restored = await setup.waitForFrame(value => value.includes('[History]') && value.includes('Follow paused'));
    assert.equal(restored.match(/Tool-\d{3}/)?.[0], first);
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('dragging past a long message keeps a stable scrollbar scale', async () => {
  const setup = await createTestRenderer({ width: 120, height: 40 }), client = mixedHistoryClient(100, 50);
  const unmount = mountHub(setup.renderer, client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('Agent Run') && value.includes('Active'));
    setup.mockInput.pressKey('1'); setup.mockInput.pressKey('G');
    await setup.waitForFrame(value => value.includes('Tool-100'));
    await setup.mockMouse.pressDown(119, 23);
    await setup.waitForFrame(value => value.includes('Long-'));
    await setup.mockMouse.moveTo(119, 24);
    const frame = await setup.waitForFrame(value => value.includes('Tool-054'));
    const first = Number(frame.match(/Tool-(\d{3})/)?.[1]);
    assert.ok(first <= 55, `one cell of pointer motion should not jump past neighboring messages, got ${first}`);
    await setup.mockMouse.release(119, 24);
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('new observations retain the paused reader position and mark new messages', async () => {
  const setup = await createTestRenderer({ width: 120, height: 60 }), base = historyClient(80);
  let updated = false;
  const client: ObservationClient = {
    async read(resource, params, signal) {
      const response = await base.read(resource, params, signal);
      if (resource !== 'run.transcript' || !updated) return response;
      const data = response.data as { messages: Record<string, unknown>[] };
      const extra = Array.from({ length: 10 }, (_, index) => ({ seq: 81 + index, role: 'tool', name: `Tool-${81 + index}`, content: 'synthetic', at: 100, content_complete: true, error: false }));
      return { ...response, data: { ...data, messages: [...data.messages, ...extra], resume_cursor: 90 } };
    },
    close: () => base.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('Agent Run') && value.includes('Active'));
    setup.mockInput.pressKey('1'); setup.mockInput.pressKey('G');
    await setup.waitForFrame(value => value.includes('Tool-080'));
    await setup.mockMouse.click(119, 5);
    await setup.waitForFrame(value => value.includes('Tool-001') && value.includes('Follow paused'));
    updated = true;
    setup.mockInput.pressKey('r');
    await setup.waitForFrame(value => value.includes('Tool-001') && value.includes('Follow paused · 10 new'));
    await setup.mockMouse.pressDown(119, 55);
    await setup.waitForFrame(value => value.includes('Tool-90') && value.includes('Following'));
    await setup.mockMouse.release(119, 55);
    await setup.waitForFrame(value => value.includes('Tool-90') && value.includes('Following'));
  } finally { unmount(); await client.close(); await setup.dispose(); }
});
