/** Worktree tab: one card per project with size, changes and merge state; lazy measuring; details; narrow widths; detail and session links. */
import assert from 'node:assert/strict';
import test from 'node:test';
import stringWidth from 'string-width';
import { createTestRenderer } from '@opentui/core/testing';
import type { ObservationClient, ReadResponse, Resource } from '../src/api.ts';
import { createDemoClient } from '../src/demo.ts';
import { mountHub } from '../src/hub.ts';

/** Wraps the demo client, recording every read and letting a test fail chosen inspects. */
function recording(failInspect: (params: Record<string, unknown>) => boolean = () => false): ObservationClient & { reads: { resource: Resource; params: Record<string, unknown> }[] } {
  const inner = createDemoClient(), reads: { resource: Resource; params: Record<string, unknown> }[] = [];
  return {
    reads,
    async read(resource, params = {}, signal) {
      reads.push({ resource, params });
      if (resource === 'worktree.inspect' && failInspect(params)) return { schema_version: 1, source: 'worktree', resource, observed_at_ms: Date.now(), outcome: 'unavailable', data: null, error: { code: 'source_error', message: 'Synthetic observation unavailable.' } } satisfies ReadResponse;
      return inner.read(resource, params, signal);
    },
    close: () => inner.close(),
  };
}
const inspects = (client: { reads: { resource: Resource; params: Record<string, unknown> }[] }) => client.reads.filter(item => item.resource === 'worktree.inspect');
/** True once every size and change is known: the tab finished its lazy pass. */
const measured = (frame: string) => /3 projects · 4 worktrees · ≥5\.\d GB on disk/.test(frame) && !/measuring|queued|checking/.test(frame);
/** The frame without trailing blanks, one string per row. */
const rowsOf = (frame: string) => frame.split('\n').map(row => row.trimEnd());

async function open(width: number, height: number, client: ObservationClient = createDemoClient()) {
  const setup = await createTestRenderer({ width, height });
  const unmount = mountHub(setup.renderer, client, 'demo', () => {}, { theme: 'dark', async save() {} });
  await setup.waitForFrame(value => value.includes('Needs attention'));
  setup.mockInput.pressKey('4');
  return { setup, close: async () => { unmount(); await client.close(); await setup.dispose(); } };
}

test('Worktree tab is a card per project: header, merge target, a block per worktree with size, changes, merge badge and activity', async () => {
  const client = recording(), { setup, close } = await open(140, 52, client);
  try {
    const frame = await setup.waitForFrame(measured);
    const rows = rowsOf(frame), at = (needle: RegExp) => rows.findIndex(row => needle.test(row));
    assert.match(frame, /\[Worktree\]/);
    assert.match(frame, /Agent Worktree · 3 configured repositories/);
    assert.match(frame, /3 projects · 4 worktrees · ≥5\.\d GB on disk/);
    // project card: short name with a right-aligned summary, the path dim below with the merge target
    assert.match(rows[at(/^ {4}agent-hub {3,}.*3 worktrees/)]!, /3 worktrees · ≥5\.\d GB · 1 unmerged · 2 with changes$/);
    assert.match(rows[at(/\/demo\/agent-hub {3,}merge target: main/)]!, /^ {4}\/demo\/agent-hub {3,}merge target: main$/);
    // worktree blocks: needs attention first (unmerged with changes), then merged but large, then the main checkout
    const workspace = at(/› workspace {2}feature\/demo/), spike = at(/agent-hub-spike {2}spike\/old/), main = at(/agent-hub {2}main checkout {2}main/);
    assert.ok(workspace > 0 && spike > workspace && main > spike, 'attention order inside the card');
    assert.match(rows[workspace]!, /\[NOT MERGED\]$/);
    assert.match(rows[workspace + 1]!, /^ {8}size 1\.2 GB · 5 changes \(3 modified · 1 staged · 1 new\) · idle · mtime-based · 2 sessions \(1 active\)$/);
    assert.match(rows[spike]!, /\[MERGED\]$/);
    assert.match(rows[spike + 1]!, /size ≥3\.4 GB \(large\) · clean · stale · mtime-based$/, 'a lower bound keeps its ≥ and a clean worktree says clean');
    assert.doesNotMatch(rows[spike + 1]!, /sessions/, 'sessions are shown only when there are some');
    assert.match(rows[main]!, /\[MAIN\]$/);
    assert.match(rows[main + 1]!, /size 430 MB · 3 changes \(2 modified · 1 new\)/);
    // an unreadable repository keeps its card, ranks above clean ones and explains itself
    const quota = at(/^ {4}agent-quota {3,}could not be read$/), skills = at(/^ {4}skills {3,}1 worktree · 52 MB$/);
    assert.ok(quota > main && skills > quota, 'attention order across cards');
    assert.match(rows.slice(quota, quota + 6).join('\n'), /Worktree could not read this repository \(unavailable \[source_error\]/);
    assert.match(rows.slice(quota, quota + 6).join('\n'), /safe\.directory/);
    // raw producer codes are not on the plain screen
    assert.doesNotMatch(frame, /ancestor_merged|idle_candidate|stale_candidate|managed|foreign|\[producer/);
    assert.match(frame.replace(/\s+/g, ' '), /Ahead\/behind counts are not available: agent-worktree does not report them/);
    assert.match(frame, /↑↓ select {3}enter open {3}d details {3}s measure/);
  } finally { await close(); }
});

test('sizes and changes are inspected once per present worktree with bounded read-only checks, nearest the selection first', async () => {
  const client = recording(), { setup, close } = await open(140, 52, client);
  try {
    await setup.waitForFrame(measured);
    const calls = inspects(client);
    assert.equal(calls.length, 4, 'one inspect per listed worktree');
    for (const call of calls) {
      assert.deepEqual(Object.keys(call.params).sort(), ['checks', 'path', 'repo']);
      assert.deepEqual(call.params.checks, { status: true, size: true });
      assert.equal(typeof call.params.repo, 'string');
    }
    // Moving the selection, scrolling and waiting for polls never rescans: the facts are cached.
    setup.mockInput.pressArrow('down'); setup.mockInput.pressArrow('down'); setup.mockInput.pressKey('d');
    await setup.waitForFrame(value => value.includes('Technical details ▾'));
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(inspects(client).length, 4, 'no new inspect after navigation');
    assert.ok(client.reads.every(item => item.resource !== 'worktree.list' || !('size' in item.params)), 'the list never asks for size');
    // s measures again, explicitly.
    setup.mockInput.pressKey('s');
    await setup.waitForFrame(() => inspects(client).length === 8);
    assert.equal(inspects(client).length, 8);
  } finally { await close(); }
});

test('while measuring, unknowns say so and are never shown as zero or clean', async () => {
  const gate: { release: () => void } = { release: () => {} }, hold = new Promise<void>(resolve => { gate.release = resolve; });
  const inner = createDemoClient();
  const client: ObservationClient = { read: async (resource, params, signal) => { if (resource === 'worktree.inspect') await hold; return inner.read(resource, params, signal); }, close: () => inner.close() };
  const { setup, close } = await open(140, 52, client);
  try {
    const frame = await setup.waitForFrame(value => value.includes('workspace') && value.includes('measuring…'));
    assert.match(frame, /sizes not measured yet/);
    assert.match(frame, /size: measuring… · changes: checking…/);
    assert.match(frame, /size: queued · changes: queued/);
    assert.match(frame, /3 worktrees · size … · 1 unmerged/);
    assert.doesNotMatch(frame, /\b0 B\b|clean/, 'nothing is clean or empty before it was read');
    assert.match(frame, /\[NOT MERGED\]/, 'merge state comes from the cheap list and is already known');
    gate.release();
    await setup.waitForFrame(measured);
  } finally { gate.release(); await close(); }
});

test('a failed inspect shows unknown size and changes for that worktree only', async () => {
  const client = recording(params => params.path === '/demo/workspace'), { setup, close } = await open(140, 52, client);
  try {
    const frame = await setup.waitForFrame(value => value.includes('size unknown · changes unknown'));
    assert.match(frame, /3 projects · 4 worktrees · ≥3\.9 GB on disk \(3 of 4 measured\)/);
    assert.match(frame, /size ≥3\.4 GB \(large\) · clean/);
    assert.doesNotMatch(rowsOf(frame).find(row => row.includes('size unknown'))!, /clean|\b0 B\b/);
    setup.mockInput.pressKey('d');
    const details = await setup.waitForFrame(value => value.includes('Technical details (raw producer codes)'));
    assert.match(details, /size=failed\(source_error\) status=failed\(source_error\)/);
  } finally { await close(); }
});

test('technical details hold the raw producer codes and toggle with d', async () => {
  const { setup, close } = await open(140, 90);
  try {
    await setup.waitForFrame(measured);
    assert.match(rowsOf(await setup.waitForFrame(() => true))[2]!, /\[d\] Technical details ▸$/);
    setup.mockInput.pressKey('d');
    const frame = await setup.waitForFrame(value => value.includes('Technical details (raw producer codes)'));
    assert.match(rowsOf(frame)[2]!, /\[d\] Technical details ▾$/);
    assert.match(frame, /demo\/workspace class=managed branch=refs\/heads\/feature\/demo/);
    assert.match(frame, /integration=unmerged activity=idle_candidate \(mtime_based\) size=1288490189 bytes status=staged:1 unstaged:3 untracked:1 conflicts:0/);
    assert.match(frame, /integration=ancestor_merged activity=stale_candidate \(mtime_based\) size=3650722202 bytes \(lower bound\)/);
    assert.match(frame, /read error: unavailable \[source_error\]: Synthetic observation unavailable\./);
    assert.match(frame, /Coverage \/demo\/agent-hub: repos=1/);
    setup.mockInput.pressKey('d');
    await setup.waitForFrame(value => !value.includes('Technical details (raw producer codes)'));
  } finally { await close(); }
});

for (const [width, height] of [[140, 52], [90, 60], [60, 70]] as const) {
  test(`Worktree tab fits ${width} columns without clipped badges or overflow`, async () => {
    const { setup, close } = await open(width, height);
    try {
      const frame = await setup.waitForFrame(measured);
      const rows = rowsOf(frame);
      assert.ok(rows.every(row => stringWidth(row) <= width), `a row is wider than ${width}`);
      for (const needle of [/agent-hub/, /\/demo\/agent-hub|…demo\/agent-hub/, /\[NOT MERGED\]/, /\[MERGED\]/, /\[MAIN\]/, /size 1\.2 GB/, /5 changes/, /clean/, /idle · mtime-based/, /2 sessions \(1 active\)/, /could not be read/]) assert.match(frame, needle);
      assert.match(frame, /size ≥3\.4 GB \(large\)/);
      // the name row keeps the whole merge badge at the right edge
      assert.ok(rows.filter(row => /\[(NOT MERGED|MERGED|MAIN)\]$/.test(row)).length >= 4);
      // the card header keeps the project name and a complete summary
      assert.ok(rows.some(row => /3 worktrees · ≥5\.\d GB · 1 unmerged · 2 with changes/.test(row)));
      // selection moves with the arrows and stays visible
      setup.mockInput.pressArrow('down');
      const moved = await setup.waitForFrame(value => /› agent-hub-spike/.test(value));
      assert.doesNotMatch(moved, /› workspace/);
    } finally { await close(); }
  });
}

test('keyboard selection follows display order; Enter opens the detail with the measured size and linked sessions', async () => {
  const { setup, close } = await open(140, 52);
  try {
    let frame = await setup.waitForFrame(value => measured(value) && value.includes('› workspace'));
    setup.mockInput.pressArrow('down');
    frame = await setup.waitForFrame(value => /› agent-hub-spike/.test(value));
    setup.mockInput.pressArrow('up');
    await setup.waitForFrame(value => /› workspace/.test(value));
    setup.mockInput.pressEnter();
    frame = await setup.waitForFrame(value => value.includes('Processes: unavailable (probe_timeout)') && value.includes('Run sessions in this worktree (2)'));
    assert.match(frame, /Agent Worktree · demo\/workspace/);
    assert.match(frame, /Size: 1\.2 GB \(measured for the list\)/);
    assert.match(frame, /Index repository/);
    setup.mockInput.pressEnter();
    frame = await setup.waitForFrame(value => value.includes('[Sessions]'));
    setup.mockInput.pressKey('4');
    frame = await setup.waitForFrame(value => value.includes('Agent Worktree · demo/workspace'));
    setup.mockInput.pressEscape(); await new Promise(resolve => setTimeout(resolve, 100));
    frame = await setup.waitForFrame(value => value.includes('3 projects · 4 worktrees'));
    assert.match(frame, /› workspace/, 'the selection returns to the same worktree');
  } finally { await close(); }
});

test('clicking a worktree block opens its detail', async () => {
  const { setup, close } = await open(140, 52);
  try {
    const frame = await setup.waitForFrame(measured), rows = rowsOf(frame);
    const row = rows.findIndex(item => /agent-hub-spike {2}spike\/old/.test(item));
    await setup.mockMouse.click(24, row);
    await setup.waitForFrame(value => value.includes('Agent Worktree · demo/agent-hub-spike'));
  } finally { await close(); }
});

test('help documents the Worktree keys', async () => {
  const { setup, close } = await open(140, 52);
  try {
    await setup.waitForFrame(measured);
    setup.mockInput.pressKey('?');
    const frame = await setup.waitForFrame(value => value.includes('Worktree: Enter open'));
    assert.match(frame, /Worktree: Enter open · d raw codes · s measure size again/);
    assert.match(frame, /r: refresh/);
  } finally { await close(); }
});
