/** Verifies the approved session layout's visible surfaces and proportions. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestRenderer } from '@opentui/core/testing';
import type { CapturedFrame } from '@opentui/core';
import { createDemoClient } from '../src/demo.ts';
import { mountHub } from '../src/hub.ts';

/** Returns a captured terminal cell's background, preserving rendered colors. */
function backgroundAt(frame: CapturedFrame, row: number, column: number): number[] {
  let position = 0;
  for (const span of frame.lines[row].spans) {
    if (column < position + span.width) return span.bg.toInts();
    position += span.width;
  }
  throw new Error('Cell is outside the captured frame');
}

for (const width of [120, 200]) {
  test(`session layout retains visible panels at ${width} columns`, async () => {
    const setup = await createTestRenderer({ width, height: 40 });
    const client = createDemoClient();
    const unmount = mountHub(setup.renderer, client, 'demo', () => {}, { theme: 'dark', async save() {} });
    try {
      await setup.waitForFrame(value => value.includes('Agent Run') && value.includes('4 loaded / 4 reported'));
      setup.mockInput.pressKey('1');
      const text = await setup.waitForFrame(value => value.includes('Inspect execution history') && value.includes('Search earlier messages'));
      const rows = text.split('\n'), sidebar = Math.round(width * 38 / 120), content = sidebar + 2;
      const frame = setup.captureSpans();
      assert.ok(rows[2].includes('All folders') && rows[2].includes('Inspect execution history'));
      assert.ok(rows[3].includes('[History]') && rows[3].includes('Result'));
      assert.ok(rows[37].includes('Follow paused'));
      const listBackground = backgroundAt(frame, 10, 0), detailBackground = backgroundAt(frame, 10, content);
      const selectedBackground = backgroundAt(frame, 5, 1), messageBackground = backgroundAt(frame, 6, content);
      assert.notDeepEqual(listBackground, detailBackground, 'list and history have distinct surfaces');
      assert.notDeepEqual(selectedBackground, listBackground, 'selected session has a full-width highlight');
      for (const row of [6, 7, 8]) assert.deepEqual(backgroundAt(frame, row, sidebar - 2), selectedBackground);
      assert.notDeepEqual(messageBackground, detailBackground, 'user message is separated from the history background');
      assert.deepEqual(backgroundAt(frame, 6, width - 4), messageBackground, 'message surface spans the content pane');
    } finally { unmount(); await client.close(); await setup.dispose(); }
  });
}

test('overview separates source metrics and attention rows into visible surfaces', async () => {
  const setup = await createTestRenderer({ width: 120, height: 40 });
  const client = createDemoClient();
  const unmount = mountHub(setup.renderer, client, 'demo', () => {}, { theme: 'dark', async save() {} });
  try {
    const text = await setup.waitForFrame(value => value.includes('4 loaded / 4 reported') && value.includes('Needs attention'));
    const rows = text.split('\n'), frame = setup.captureSpans();
    const run = rows.findIndex(row => row.includes('Agent Run') && row.includes('Open sessions'));
    const bridge = rows.findIndex(row => row.includes('Agent Bridge') && row.includes('View incidents'));
    const attention = rows.findIndex(row => row.includes('Needs attention'));
    assert.ok(run >= 0 && bridge > run && attention > bridge);
    assert.doesNotMatch(text, /[┌┐└┘│─╭╮╰╯]/, 'overview does not draw component outlines');
    assert.notDeepEqual(backgroundAt(frame, run + 2, 5), backgroundAt(frame, run, 5), 'metric cells differ from their source panel');
    assert.notDeepEqual(backgroundAt(frame, attention + 2, 10), backgroundAt(frame, attention + 1, 10), 'attention row has a separate surface');
    assert.notDeepEqual(backgroundAt(frame, attention + 3, 10), backgroundAt(frame, attention + 1, 10), 'both attention rows remain distinct');
  } finally { unmount(); await client.close(); await setup.dispose(); }
});
