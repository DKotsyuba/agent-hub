/** Exercises hover, expanded surfaces and continuous scrolling with synthetic history. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestRenderer } from '@opentui/core/testing';
import type { CapturedFrame } from '@opentui/core';
import { createDemoClient } from '../src/demo.ts';
import { mountHub } from '../src/hub.ts';
import type { ObservationClient } from '../src/api.ts';
import type { Theme } from '../src/preferences.ts';

/** Reads a terminal cell's background from the rendered native frame. */
function backgroundAt(frame: CapturedFrame, row: number, column: number): number[] {
  let position = 0;
  for (const span of frame.lines[row].spans) {
    if (column < position + span.width) return span.bg.toInts();
    position += span.width;
  }
  throw new Error('Cell is outside the captured frame');
}

/** Creates a long synthetic history without accessing a live agent. */
function historySource(long: boolean): ObservationClient {
  const demo = createDemoClient();
  return {
    async read(resource, params = {}, signal) {
      if (resource !== 'run.transcript') return demo.read(resource, params, signal);
      const messages = long
        ? [{ seq: 1, role: 'assistant', content: Array.from({ length: 150 }, (_, index) => `Row-${String(index + 1).padStart(3, '0')}`).join('\n'), at: 100, content_complete: true }]
        : Array.from({ length: 100 }, (_, index) => ({ seq: index + 1, role: 'tool', name: `Tool-${String(index + 1).padStart(3, '0')}`, content: 'synthetic', at: 100, error: false, content_complete: true }));
      return { schema_version: 1, source: 'run', resource, observed_at_ms: Date.now(), outcome: 'ok', error: null, data: { agent_id: params.agent_id, view: 'blocks', cursor: 0, messages, complete: true, previous_cursor: null, next_cursor: null, resume_cursor: messages.at(-1)?.seq ?? null } };
    },
    close: () => demo.close(),
  };
}

test('screen updates never present a second displaced interface', async () => {
  const setup = await createTestRenderer({ width: 120, height: 40 }), client = createDemoClient();
  const presented: { text: string; width: number; height: number; layers: { x: number; y: number; width: number; height: number }[] }[] = [];
  const record = () => presented.push({ text: setup.captureCharFrame(), width: setup.renderer.width, height: setup.renderer.height, layers: setup.renderer.root.getChildren().filter(child => child.zIndex <= 0).map(child => ({ x: child.x, y: child.y, width: child.width, height: child.height })) });
  setup.renderer.on('frame', record);
  const unmount = mountHub(setup.renderer, client, 'demo', () => {});
  try {
    await setup.waitForFrame(value => value.includes('Needs attention'));
    presented.length = 0;
    for (const [width, height] of [[120, 40], [80, 24], [140, 48]]) {
      setup.resize(width, height);
      await setup.renderOnce();
      setup.mockInput.pressKey('1');
      await setup.waitForFrame(value => value.includes('Inspect execution history'));
      setup.mockInput.pressKey('r');
      await setup.renderOnce();
      setup.mockInput.pressKey('0');
      await setup.waitForFrame(value => value.includes('Needs attention'));
    }
    assert.ok(presented.some(frame => frame.layers.length > 1), 'the test observes frames during replacement');
    for (const frame of presented.filter(value => value.layers.length > 1)) {
      for (const layer of frame.layers) assert.deepEqual(layer, { x: 0, y: 0, width: frame.width, height: frame.height }, 'each retained frame covers the terminal without shifting');
      const rows = frame.text.split('\n');
      const headers = rows.filter(row => row.includes('agent-hub') && row.includes('Overview') && row.includes('Sessions'));
      assert.equal(headers.length, 1, 'a presented frame has one navigation bar');
      assert.match(rows[0], /agent-hub.*Overview.*Sessions/, 'navigation remains at the top');
      assert.match(rows[frame.height - 1], /help/, 'the footer remains at the bottom');
    }
  } finally { setup.renderer.off('frame', record); unmount(); await client.close(); await setup.dispose(); }
});

for (const theme of ['dark', 'light'] as Theme[]) {
  test(`pointer hover and expanded transcript use distinct surfaces in ${theme} mode`, async () => {
    const setup = await createTestRenderer({ width: 120, height: 40, enableMouseMovement: true }), client = createDemoClient();
    const unmount = mountHub(setup.renderer, client, 'demo', () => {}, { theme, async save() {} });
    try {
      await setup.waitForFrame(value => value.includes('4 loaded / 4 reported'));
      setup.mockInput.pressKey('1');
      let text = await setup.waitForFrame(value => value.includes('Index repository') && value.includes('Search earlier messages'));
      let rows = text.split('\n'), index = rows.findIndex(row => row.includes('Index repository'));
      const baseList = backgroundAt(setup.captureSpans(), index, 10), selected = backgroundAt(setup.captureSpans(), 5, 10);
      await setup.mockMouse.moveTo(10, index);
      await setup.renderOnce();
      let frame = setup.captureSpans();
      const hoveredList = backgroundAt(frame, index, 10);
      assert.notDeepEqual(hoveredList, baseList, 'hovering an unselected session changes its background');
      assert.deepEqual(backgroundAt(frame, index + 1, 10), hoveredList, 'the entire session item responds to hover');
      assert.deepEqual(backgroundAt(frame, 5, 10), selected, 'hover does not change the selected session');
      await setup.mockMouse.moveTo(10, index + 1);
      await setup.renderOnce();
      assert.deepEqual(backgroundAt(setup.captureSpans(), index, 10), hoveredList, 'moving within an item preserves its hover');
      setup.mockInput.pressKey('r');
      await setup.renderOnce();
      await setup.renderOnce();
      assert.deepEqual(backgroundAt(setup.captureSpans(), index, 10), hoveredList, 'hover follows the pointer through a refresh');
      await setup.mockMouse.moveTo(2, 1);
      await setup.renderOnce();
      assert.deepEqual(backgroundAt(setup.captureSpans(), index, 10), baseList);

      text = setup.captureCharFrame(); rows = text.split('\n');
      const tool = rows.findIndex(row => row.includes('Search earlier messages'));
      const baseTool = backgroundAt(setup.captureSpans(), tool, 50);
      await setup.mockMouse.moveTo(50, tool);
      await setup.renderOnce();
      assert.notDeepEqual(backgroundAt(setup.captureSpans(), tool, 50), baseTool, 'moving the pointer highlights a tool without clicking');
      assert.match(setup.captureCharFrame().split('\n')[tool], /▸/);
      await setup.mockMouse.click(50, tool);
      text = await setup.waitForFrame(value => value.includes('pattern: earlier synthetic history') && value.includes('No earlier synthetic records.'));
      await setup.mockMouse.moveTo(2, 1);
      await setup.renderOnce();
      rows = setup.captureCharFrame().split('\n');
      const heading = rows.findIndex(row => row.includes('Search earlier messages'));
      const input = rows.findIndex(row => row.includes('pattern: earlier synthetic history'));
      const output = rows.findIndex(row => row.includes('No earlier synthetic records.'));
      frame = setup.captureSpans();
      const expanded = backgroundAt(frame, heading, 50), outside = backgroundAt(frame, Math.max(5, heading - 1), 50);
      assert.notDeepEqual(expanded, outside, 'expanded tool is separated from the transcript');
      assert.deepEqual(backgroundAt(frame, input, 50), expanded);
      assert.deepEqual(backgroundAt(frame, output, 50), expanded);
      assert.deepEqual(backgroundAt(frame, output, 116), expanded, 'highlight covers the full width');
    } finally { unmount(); await client.close(); await setup.dispose(); }
  });
}

test('wheel movement stays continuous while crossing bounded history windows', async () => {
  const setup = await createTestRenderer({ width: 120, height: 40 }), client = historySource(false);
  const unmount = mountHub(setup.renderer, client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('4 loaded / 4 reported'));
    setup.mockInput.pressKey('1'); setup.mockInput.pressKey('G');
    let frame = await setup.waitForFrame(value => value.includes('Tool-100'));
    let first = Number(frame.match(/Tool-(\d{3})/)?.[1]);
    for (let step = 0; step < 20; step++) {
      await setup.mockMouse.scroll(60, 10, 'up');
      await setup.renderOnce();
      frame = setup.captureCharFrame();
      const next = Number(frame.match(/Tool-(\d{3})/)?.[1]);
      assert.ok(next <= first && first - next <= 4, `wheel step jumped from ${first} to ${next}`);
      first = next;
    }
    for (let step = 0; step < 20; step++) {
      await setup.mockMouse.scroll(60, 10, 'down');
      await setup.renderOnce();
      frame = setup.captureCharFrame();
      const next = Number(frame.match(/Tool-(\d{3})/)?.[1]);
      assert.ok(next >= first && next - first <= 4, `wheel step jumped from ${first} to ${next}`);
      first = next;
    }
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

for (const paused of [false, true]) {
  test(`expanding a tool keeps its screen position while ${paused ? 'paused' : 'following'}`, async () => {
    const setup = await createTestRenderer({ width: 120, height: 40 }), base = historySource(false);
    const client: ObservationClient = {
      async read(resource, params, signal) {
        const result = await base.read(resource, params, signal);
        if (resource !== 'run.transcript' || !result.data) return result;
        const data = result.data as { messages: Record<string, unknown>[] };
        return { ...result, data: { ...data, messages: data.messages.map(message => message.seq === 95 ? { ...message, content: Array.from({ length: 25 }, (_, row) => `Expanded-${row}`).join('\n') } : message) } };
      },
      close: () => base.close(),
    };
    const unmount = mountHub(setup.renderer, client, 'live', () => {});
    try {
      await setup.waitForFrame(value => value.includes('4 loaded / 4 reported'));
      setup.mockInput.pressKey('1'); setup.mockInput.pressKey('G');
      await setup.waitForFrame(value => value.includes('Tool-095') && value.includes('Following'));
      if (paused) { await setup.mockMouse.scroll(60, 10, 'up'); await setup.waitForFrame(value => value.includes('Follow paused')); }
      let frame = setup.captureCharFrame(), row = frame.split('\n').findIndex(line => line.includes('Tool-095'));
      assert.ok(row >= 5);
      await setup.mockMouse.click(60, row);
      frame = await setup.waitForFrame(value => value.includes('▾ Tool-095'));
      assert.equal(frame.split('\n').findIndex(line => line.includes('Tool-095')), row, 'opening keeps the clicked row in place');
      await setup.mockMouse.click(60, row);
      frame = await setup.waitForFrame(value => value.includes('▸ Tool-095'));
      assert.equal(frame.split('\n').findIndex(line => line.includes('Tool-095')), row, 'closing keeps the clicked row in place');
    } finally { unmount(); await client.close(); await setup.dispose(); }
  });
}

test('keyboard expansion also keeps the selected tool on the same row', async () => {
  const setup = await createTestRenderer({ width: 120, height: 40 }), base = historySource(false);
  const client: ObservationClient = {
    async read(resource, params, signal) {
      const result = await base.read(resource, params, signal);
      if (resource !== 'run.transcript' || !result.data) return result;
      const data = result.data as { messages: Record<string, unknown>[] };
      return { ...result, data: { ...data, messages: data.messages.map(message => ({ ...message, content: Array.from({ length: 25 }, (_, row) => `Expanded-${row}`).join('\n') })) } };
    },
    close: () => base.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('4 loaded / 4 reported'));
    setup.mockInput.pressKey('1'); setup.mockInput.pressKey('G');
    await setup.waitForFrame(value => value.includes('Tool-100'));
    setup.mockInput.pressEnter();
    await setup.renderOnce();
    const before = setup.captureCharFrame(), rows = before.split('\n');
    const row = rows.findIndex(line => line.includes('Tool-'));
    const name = rows[row]?.match(/Tool-\d{3}/)?.[0];
    assert.ok(name);
    setup.mockInput.pressEnter();
    const after = await setup.waitForFrame(value => value.includes(`▾ ${name}`));
    assert.equal(after.split('\n').findIndex(line => line.includes(name)), row);
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('clicking ordinary assistant text does not pause following', async () => {
  const setup = await createTestRenderer({ width: 120, height: 40 }), client = historySource(true);
  const unmount = mountHub(setup.renderer, client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('4 loaded / 4 reported'));
    setup.mockInput.pressKey('1'); setup.mockInput.pressKey('G');
    const frame = await setup.waitForFrame(value => value.includes('Row-150') && value.includes('Following'));
    const row = frame.split('\n').findIndex(line => line.includes('Row-140'));
    assert.ok(row >= 0);
    await setup.mockMouse.click(60, row);
    await setup.renderOnce();
    assert.match(setup.captureCharFrame(), /● Following/);
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('scrolling into an expanded item preserves its heading and first output line', async () => {
  const setup = await createTestRenderer({ width: 120, height: 60 }), base = historySource(false);
  const client: ObservationClient = {
    async read(resource, params, signal) {
      const result = await base.read(resource, params, signal);
      if (resource !== 'run.transcript' || !result.data) return result;
      const data = result.data as { messages: Record<string, unknown>[] };
      return { ...result, data: { ...data, messages: data.messages.slice(0, 30).map(message => message.seq === 27 ? { ...message, content: Array.from({ length: 100 }, (_, index) => `Long-${String(index + 1).padStart(3, '0')}`).join('\n') } : message) } };
    },
    close: () => base.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('4 loaded / 4 reported'));
    setup.mockInput.pressKey('1'); setup.mockInput.pressKey('G');
    let frame = await setup.waitForFrame(value => value.includes('Tool-027'));
    await setup.mockMouse.click(60, frame.split('\n').findIndex(row => row.includes('Tool-027')));
    await setup.renderOnce();
    setup.mockInput.pressEnter();
    setup.mockInput.pressKey('HOME');
    await setup.waitForFrame(value => value.includes('Tool-001'));
    let found = false;
    for (let step = 0; step < 30; step++) {
      await setup.mockMouse.scroll(60, 10, 'down');
      await setup.renderOnce();
      frame = setup.captureCharFrame();
      if (frame.includes('Long-001')) {
        assert.match(frame, /Tool-027/);
        assert.match(frame, /Content/);
        found = true; break;
      }
    }
    assert.equal(found, true);
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('queued Home and Enter operate on the first visible history item', async () => {
  const setup = await createTestRenderer({ width: 120, height: 40 }), client = historySource(false);
  const unmount = mountHub(setup.renderer, client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('4 loaded / 4 reported'));
    setup.mockInput.pressKey('1'); setup.mockInput.pressKey('G');
    await setup.waitForFrame(value => value.includes('Tool-100'));
    setup.mockInput.pressEnter();
    await setup.renderOnce();
    setup.mockInput.pressKey('\x1b[H\r');
    let frame = await setup.waitForFrame(value => value.includes('▾ Tool-001') && value.includes('Content'));
    assert.doesNotMatch(frame, /▾ Tool-100/);
    setup.mockInput.pressKey('\x1b[F\r');
    frame = await setup.waitForFrame(value => value.includes('▾ Tool-100') && value.includes('Content'));
    assert.doesNotMatch(frame, /▾ Tool-001/);
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('resizing preserves the visible history anchor after crossing windows', async () => {
  const setup = await createTestRenderer({ width: 120, height: 40 }), client = historySource(false);
  const unmount = mountHub(setup.renderer, client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('4 loaded / 4 reported'));
    setup.mockInput.pressKey('1'); setup.mockInput.pressKey('G');
    await setup.waitForFrame(value => value.includes('Tool-100'));
    for (let step = 0; step < 23; step++) { await setup.mockMouse.scroll(60, 10, 'up'); await setup.renderOnce(); }
    const before = setup.captureCharFrame().match(/Tool-\d{3}/)?.[0];
    assert.ok(before);
    for (const height of [42, 40]) {
      setup.resize(120, height);
      await setup.renderOnce();
      await setup.renderOnce();
      assert.equal(setup.captureCharFrame().match(/Tool-\d{3}/)?.[0], before);
    }
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('an overlay blocks a click delivered before its first painted frame', async () => {
  const setup = await createTestRenderer({ width: 120, height: 40 }), client = historySource(false);
  const unmount = mountHub(setup.renderer, client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('4 loaded / 4 reported'));
    setup.mockInput.pressKey('1'); setup.mockInput.pressKey('G');
    await setup.waitForFrame(value => value.includes('Tool-100'));
    setup.mockInput.pressKey('?\x1b[<0;61;17M\x1b[<0;61;17m');
    await setup.waitForFrame(value => value.includes('Read-only commands'));
    setup.mockInput.pressEscape();
    await new Promise(resolve => setTimeout(resolve, 25));
    const frame = await setup.waitForFrame(value => !value.includes('Read-only commands') && value.includes('Tool-100'));
    assert.doesNotMatch(frame, /▾ Tool-|Content/);
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('a burst of wheel events is not lost during a refresh', async () => {
  const setup = await createTestRenderer({ width: 120, height: 40 }), client = historySource(true);
  const unmount = mountHub(setup.renderer, client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('4 loaded / 4 reported'));
    setup.mockInput.pressKey('1'); setup.mockInput.pressKey('G');
    let frame = await setup.waitForFrame(value => value.includes('Row-150'));
    const first = Number(frame.match(/Row-(\d{3})/)?.[1]);
    setup.mockInput.pressKey('r');
    setup.mockInput.pressKey('\x1b[<64;61;11M'.repeat(8));
    await setup.renderOnce();
    frame = await setup.waitForFrame(value => value.includes('Follow paused'));
    const after = Number(frame.match(/Row-(\d{3})/)?.[1]);
    assert.equal(first - after, 8, 'eight simultaneous wheel events each move one row');
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('wheel input is precise slowly and accelerates during a fast gesture', async () => {
  const setup = await createTestRenderer({ width: 120, height: 40 }), client = historySource(true);
  const unmount = mountHub(setup.renderer, client, 'live', () => {}), originalNow = Date.now;
  try {
    await setup.waitForFrame(value => value.includes('4 loaded / 4 reported'));
    setup.mockInput.pressKey('1'); setup.mockInput.pressKey('G');
    let frame = await setup.waitForFrame(value => value.includes('Row-150'));
    const first = Number(frame.match(/Row-(\d{3})/)?.[1]);
    let now = 100000; Date.now = () => now;
    setup.mockInput.pressKey('\x1b[<64;61;11M');
    await setup.renderOnce();
    frame = await setup.waitForFrame(value => value.includes('Follow paused'));
    const slow = Number(frame.match(/Row-(\d{3})/)?.[1]);
    assert.equal(first - slow, 1);
    for (let i = 0; i < 5; i++) { now += 20; setup.mockInput.pressKey('\x1b[<64;61;11M'); }
    await setup.renderOnce();
    frame = setup.captureCharFrame();
    const fast = Number(frame.match(/Row-(\d{3})/)?.[1]);
    assert.ok(slow - fast > 5, 'rapid wheel events move farther than slow single-row events');
    now += 500; setup.mockInput.pressKey('\x1b[<64;61;11M');
    await setup.renderOnce();
    const reset = Number(setup.captureCharFrame().match(/Row-(\d{3})/)?.[1]);
    assert.equal(fast - reset, 1, 'the acceleration resets after a pause');
  } finally { Date.now = originalNow; unmount(); await client.close(); await setup.dispose(); }
});
