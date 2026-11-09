/** Exercises OpenTUI rendering and keyboard navigation with synthetic observations. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestRenderer } from '@opentui/core/testing';
import { createDemoClient } from '../src/demo.ts';
import { mountHub } from '../src/hub.ts';
import type { ObservationClient } from '../src/api.ts';
import type { Theme } from '../src/preferences.ts';

test('overview, split history, follow and resize remain keyboard accessible', async () => {
  const setup = await createTestRenderer({ width: 120, height: 40 });
  const client = createDemoClient();
  let quit = false;
  const saved: Theme[] = [];
  const unmount = mountHub(setup.renderer, client, 'demo', () => { quit = true; }, { theme: 'dark', async save(theme) { saved.push(theme); } });
  try {
    let frame = await setup.waitForFrame(value => value.includes('Agent Run') && value.includes('Agent Bridge') && value.includes('Needs attention'));
    assert.match(frame, /DEMO/);
    const dark = setup.captureSpans().lines[0].spans.find(span => span.text.includes('agent-hub'))!.bg.toInts();
    if (process.env.AGENT_HUB_SHOW_FRAMES === '1') process.stdout.write(`\n120×40 overview:\n${frame}\n`);

    setup.mockInput.pressKey(',');
    const appearance = await setup.waitForFrame(value => value.includes('Appearance'));
    assert.doesNotMatch(appearance, /[┌┐└┘│─╭╮╰╯]/, 'appearance controls do not draw outlines');
    setup.mockInput.pressArrow('down');
    setup.mockInput.pressEnter();
    await setup.waitForFrame(value => !value.includes('Appearance') && value.includes('Agent Run'));
    const light = setup.captureSpans().lines[0].spans.find(span => span.text.includes('agent-hub'))!.bg.toInts();
    assert.notDeepEqual(light, dark);
    assert.deepEqual(saved, ['light']);

    setup.mockInput.pressKey('p');
    await setup.waitForFrame(value => value.includes('Reporting period'));
    setup.mockInput.pressArrow('down');
    setup.mockInput.pressEnter();
    await setup.waitForFrame(value => value.includes('Yesterday'));

    setup.resize(80, 24);
    await setup.renderOnce();
    setup.mockInput.pressKey('p');
    await setup.waitForFrame(value => value.includes('Reporting period'));
    setup.mockInput.pressArrow('down');
    setup.mockInput.pressArrow('down');
    setup.mockInput.pressEnter();
    frame = await setup.waitForFrame(value => value.includes('Period: Last 30 days') && !value.includes('Reporting period'));
    if (process.env.AGENT_HUB_SHOW_FRAMES === '1') process.stdout.write(`\n80×24 overview:\n${frame}\n`);
    const overviewRows = frame.split('\n');
    const finishedRow = overviewRows.findIndex(row => row.includes('Finished'));
    const finishedColumn = overviewRows[finishedRow]?.indexOf('Finished') ?? -1;
    assert.ok(finishedRow >= 0 && finishedColumn >= 0 && /\b2\b/.test(overviewRows[finishedRow + 1]?.slice(finishedColumn, finishedColumn + 12) ?? ''), 'compact metric retains its value');
    setup.resize(60, 16);
    frame = await setup.waitForFrame(value => value.includes('Needs attention'));
    assert.match(frame, /Agent Run/);
    assert.match(frame, /Agent Bridge/);
    setup.resize(120, 40);
    await setup.renderOnce();

    setup.mockInput.pressKey('1');
    frame = await setup.waitForFrame(value => value.includes('Inspect execution history') && value.includes('Index repository'));
    if (process.env.AGENT_HUB_SHOW_FRAMES === '1') process.stdout.write(`\n120×40 sessions:\n${frame}\n`);
    setup.mockInput.pressEnter();
    setup.mockInput.pressKey('G');
    await setup.waitForFrame(value => value.includes('Following'));
    setup.mockInput.pressArrow('up');
    await setup.waitForFrame(value => value.includes('Follow paused'));
    setup.mockInput.pressKey('G');
    await setup.waitForFrame(value => value.includes('Following'));
    setup.mockInput.pressKey('z');
    frame = await setup.waitForFrame(value => value.includes('Following') && !value.includes('Index repository'));
    assert.match(frame, /Inspect execution history/);
    setup.mockInput.pressEscape();
    // OpenTUI waits 20 ms to distinguish a lone Escape from a terminal sequence.
    await new Promise(resolve => setTimeout(resolve, 25));
    await setup.waitForFrame(value => value.includes('Index repository'));

    setup.resize(80, 24);
    await setup.renderOnce();
    setup.mockInput.pressEscape();
    await new Promise(resolve => setTimeout(resolve, 25));
    frame = await setup.waitForFrame(value => value.includes('Sessions') && value.includes('Inspect execution history'));
    if (process.env.AGENT_HUB_SHOW_FRAMES === '1') process.stdout.write(`\n80×24 sessions:\n${frame}\n`);
    setup.resize(50, 14);
    await setup.waitForFrame(value => value.includes('Resize terminal'));
    setup.mockInput.pressKey('q');
    assert.equal(quit, true);
  } finally {
    unmount();
    await client.close();
    await setup.dispose();
  }
});

test('visible overview actions and session tabs respond to mouse selection', async () => {
  const setup = await createTestRenderer({ width: 120, height: 40 });
  const client = createDemoClient();
  const unmount = mountHub(setup.renderer, client, 'demo', () => {});
  try {
    const overview = await setup.waitForFrame(value => value.includes('View incidents'));
    const overviewRows = overview.split('\n'), actionRow = overviewRows.findIndex(value => value.includes('View incidents'));
    await setup.mockMouse.click(overviewRows[actionRow].indexOf('View incidents') + 1, actionRow);
    await setup.waitForFrame(value => value.includes('Agent Bridge · retained incident evidence'));
    setup.mockInput.pressKey('1');
    const frame = await setup.waitForFrame(value => value.includes('Inspect execution history') && value.includes('[History]'));
    const rows = frame.split('\n'), row = rows.findIndex(value => value.includes('[History]') && value.includes('Result'));
    await setup.mockMouse.click(rows[row].indexOf('Result') + 1, row);
    await setup.waitForFrame(value => value.includes('[Result]'));
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('Finished expands and collapses by clicking its header or pressing o', async () => {
  const setup = await createTestRenderer({ width: 120, height: 40 });
  const client = createDemoClient();
  const unmount = mountHub(setup.renderer, client, 'demo', () => {});
  try {
    await setup.waitForFrame(value => value.includes('4 loaded / 4 reported'));
    setup.mockInput.pressKey('1');
    let frame = await setup.waitForFrame(value => value.includes('▸ Finished') && value.includes('Inspect execution history'));
    assert.match(frame, /o finished/);
    let rows = frame.split('\n'), row = rows.findIndex(value => value.includes('▸ Finished'));
    await setup.mockMouse.click(rows[row].indexOf('Finished') + 1, row);
    frame = await setup.waitForFrame(value => value.includes('▾ Finished') && value.includes('Review saved output'));
    assert.match(frame, /› [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Inspect execution history/, 'expanding does not move the active selection');
    rows = frame.split('\n'); row = rows.findIndex(value => value.includes('▾ Finished'));
    await setup.mockMouse.click(rows[row].indexOf('Finished') + 1, row);
    frame = await setup.waitForFrame(value => value.includes('▸ Finished') && !value.includes('Review saved output'));
    assert.match(frame, /› [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Inspect execution history/);
    setup.mockInput.pressKey('o');
    await setup.waitForFrame(value => value.includes('▾ Finished') && value.includes('Review saved output'));
    setup.mockInput.pressKey('o');
    await setup.waitForFrame(value => value.includes('▸ Finished') && !value.includes('Review saved output'));
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('an empty expanded Finished group remains closable', async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 });
  const demo = createDemoClient();
  const client: ObservationClient = {
    async read(resource, params, signal) {
      const result = await demo.read(resource, params, signal);
      if (resource !== 'run.agents' || !result.data) return result;
      const page = result.data as { items: Record<string, unknown>[] };
      return { ...result, data: { ...page, items: page.items.filter(item => item.status === 'running'), total: 2 } };
    },
    close: () => demo.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'demo', () => {});
  try {
    await setup.waitForFrame(value => value.includes('2 loaded / 2 reported'));
    setup.mockInput.pressKey('1');
    await setup.waitForFrame(value => value.includes('▸ Finished  0'));
    setup.mockInput.pressKey('o');
    const frame = await setup.waitForFrame(value => value.includes('▾ Finished  0'));
    const rows = frame.split('\n'), row = rows.findIndex(value => value.includes('▾ Finished'));
    await setup.mockMouse.click(rows[row].indexOf('Finished') + 1, row);
    await setup.waitForFrame(value => value.includes('▸ Finished  0'));
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('opening Finished selects and loads a session when no active session exists', async () => {
  const setup = await createTestRenderer({ width: 120, height: 40 });
  const demo = createDemoClient();
  const client: ObservationClient = {
    async read(resource, params, signal) {
      const result = await demo.read(resource, params, signal);
      if (resource !== 'run.agents' || !result.data) return result;
      const page = result.data as { items: Record<string, unknown>[] };
      return { ...result, data: { ...page, items: page.items.filter(item => item.status !== 'running'), total: 2 } };
    },
    close: () => demo.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'demo', () => {});
  try {
    await setup.waitForFrame(value => value.includes('2 loaded / 2 reported'));
    setup.mockInput.pressKey('1');
    await setup.waitForFrame(value => value.includes('▸ Finished  2'));
    setup.mockInput.pressKey('o');
    await setup.waitForFrame(value => value.includes('Review saved output') && value.includes('[History]') && value.includes('Synthetic result'));
  } finally { unmount(); await client.close(); await setup.dispose(); }
});


test('visible active sessions animate without polling and finished sessions stay still', async () => {
  const setup = await createTestRenderer({ width: 120, height: 40 });
  const demo = createDemoClient();
  let reads = 0;
  const client: ObservationClient = { read(...args) { reads++; return demo.read(...args); }, close: () => demo.close() };
  const unmount = mountHub(setup.renderer, client, 'demo', () => {});
  try {
    await setup.waitForFrame(value => value.includes('Agent Run'));
    setup.mockInput.pressKey('1');
    setup.mockInput.pressKey('o');
    const first = await setup.waitForFrame(value => value.includes('Review saved output') && value.includes('Inspect execution history'));
    const active = first.split('\n').find(row => row.includes('›') && row.includes('Inspect execution history'))!;
    const finished = first.split('\n').find(row => row.includes('Review saved output'))!;
    const frame = active.match(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/)?.[0];
    assert.ok(frame);
    assert.match(active, /› [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Inspect execution history/);
    assert.doesNotMatch(finished, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    const before = reads;
    await new Promise(resolve => setTimeout(resolve, 120));
    await setup.renderOnce();
    const next = setup.captureCharFrame();
    const nextActive = next.split('\n').find(row => row.includes('›') && row.includes('Inspect execution history'))!;
    assert.ok(!nextActive.includes(frame));
    assert.equal(reads, before);
    assert.equal(next.split('\n').find(row => row.includes('Review saved output')), finished);
  } finally {
    unmount();
    await client.close();
    await setup.dispose();
  }
});
