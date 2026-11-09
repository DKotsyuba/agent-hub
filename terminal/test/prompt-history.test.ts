/** Exercises beginning-of-history navigation using isolated synthetic transcript pages. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestRenderer } from '@opentui/core/testing';
import { createDemoClient } from '../src/demo.ts';
import { mountHub } from '../src/hub.ts';
import type { ObservationClient, ReadResponse } from '../src/api.ts';

/** Supplies a distant live tail and a separately paged beginning with controllable failures. */
function historySource() {
  const demo = createDemoClient(), requests: Record<string, unknown>[] = [];
  let releaseHead!: () => void, releaseNext!: () => void, releaseLast!: () => void, releaseNewHead!: () => void;
  const headGate = new Promise<void>(resolve => { releaseHead = resolve; });
  const nextGate = new Promise<void>(resolve => { releaseNext = resolve; });
  const lastGate = new Promise<void>(resolve => { releaseLast = resolve; });
  const newHeadGate = new Promise<void>(resolve => { releaseNewHead = resolve; });
  const controls = { holdHead: false, holdNext: false, holdLast: false, holdNewHead: false, longNext: false, failHead: false, badNext: false, emptyNext: false, updated: false, resumed: false, fullyLoaded: false };
  const row = (seq: number, role: string, content: string, extra: Record<string, unknown> = {}) => ({ seq, role, content, name: null, at: 100 + seq, content_complete: true, first_seq: seq, last_seq: seq, starts_block: true, ...extra });
  const prompt = row(1, 'user', Array.from({ length: 10 }, (_, index) => `PROMPT-LINE-${String(index + 1).padStart(2, '0')}`).join('\n'));
  const call = row(2, 'tool_call', '{"command":"example"}', { name: 'Bash', raw_ref: 'shared' });
  const middle = () => row(3, 'assistant', controls.longNext ? Array.from({ length: 100 }, (_, index) => `MIDDLE-LINE-${String(index + 1).padStart(3, '0')}`).join('\n') : 'MIDDLE-RECORD');
  const result = row(100, 'tool_result', 'DISTANT-RESULT', { name: 'Bash', raw_ref: 'shared', error: false });
  /** Returns producer-shaped pages with forward and backward continuation kept distinct. */
  function page(id: string, cursor: number, messages: ReturnType<typeof row>[], complete: boolean, reverse = false, next: number | null = null): ReadResponse {
    return { schema_version: 1, source: 'run', resource: 'run.transcript', observed_at_ms: Date.now(), outcome: complete ? 'ok' : 'partial', error: null,
      data: { agent_id: id, view: 'blocks', cursor, direction: reverse ? 'backward' : 'forward', messages, complete, previous_cursor: reverse && !complete ? messages[0]?.seq ?? null : null, next_cursor: reverse || complete ? null : next, resume_cursor: messages.at(-1)?.seq ?? cursor } };
  }
  const client: ObservationClient = {
    async read(resource, params = {}, signal) {
      if (resource !== 'run.transcript') {
        const response = await demo.read(resource, params, signal);
        if (resource !== 'run.agents' || !controls.resumed || !response.data) return response;
        const data = response.data as { items: Record<string, unknown>[] };
        return { ...response, data: { ...data, items: data.items.map(item => item.agent_id === 'demo-inspect' ? { ...item, sequence: 2 } : item) } };
      }
      requests.push({ ...params });
      const id = typeof params.agent_id === 'string' ? params.agent_id : '';
      const tail = row(101, 'assistant', `TAIL-${id}`), cursor = typeof params.cursor === 'number' ? params.cursor : 0;
      if (typeof params.tail_blocks === 'number') return controls.fullyLoaded ? page(id, 0, [prompt, call, middle(), result, tail], true, true) : page(id, 0, [result, tail], false, true);
      if (cursor === 0) {
        if (controls.holdHead) await headGate;
        if (controls.failHead) return { schema_version: 1, source: 'run', resource, observed_at_ms: Date.now(), outcome: 'unavailable', error: { code: 'fixture', message: 'Source unavailable.' }, data: null };
        return page(id, cursor, [prompt, call], false, false, 2);
      }
      if (cursor === 2) { if (controls.holdNext) await nextGate; return page(id, cursor, controls.emptyNext ? [] : [middle()], false, false, controls.badNext ? 2 : 3); }
      if (cursor === 3) { if (controls.holdLast) await lastGate; return page(id, cursor, [result, tail], true); }
      if (cursor === 101 && controls.updated) { if (params.limit === 40 && controls.holdNewHead) await newHeadGate; return page(id, cursor, [row(102, 'assistant', `NEW-TAIL-${id}`)], true); }
      return page(id, cursor, [], true);
    },
    close: () => demo.close(),
  };
  return { client, controls, requests, releaseHead, releaseNext, releaseLast, releaseNewHead };
}

test('wheel movement continues after a delayed next history page arrives', async () => {
  const setup = await createTestRenderer({ width: 160, height: 40 }), fixture = historySource();
  fixture.controls.holdNext = true; fixture.controls.longNext = true;
  const unmount = mountHub(setup.renderer, fixture.client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('4 loaded / 4 reported'));
    setup.mockInput.pressKey('1');
    await setup.waitForFrame(value => value.includes('PROMPT-LINE-01') && value.includes('Loading next page'));
    setup.mockInput.pressKey('\x1b[<65;81;11M'.repeat(12));
    await setup.renderOnce();
    assert.equal(fixture.requests.filter(request => request.cursor === 2).length, 1);
    fixture.releaseNext();
    await setup.waitForFrame(value => value.includes('MIDDLE-LINE-'));
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    assert.doesNotMatch(frame, /PROMPT-LINE-01/, 'the unconsumed wheel movement continues after loading');
    assert.match(frame, /MIDDLE-LINE-/);
  } finally { fixture.releaseHead(); fixture.releaseNext(); unmount(); await fixture.client.close(); await setup.dispose(); }
});

test('returning to the tail cancels wheel movement waiting for a page', async () => {
  const setup = await createTestRenderer({ width: 160, height: 40 }), fixture = historySource();
  fixture.controls.holdNext = true; fixture.controls.longNext = true;
  const unmount = mountHub(setup.renderer, fixture.client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('4 loaded / 4 reported'));
    setup.mockInput.pressKey('1');
    await setup.waitForFrame(value => value.includes('PROMPT-LINE-01') && value.includes('Loading next page'));
    setup.mockInput.pressKey('\x1b[<65;81;11M'.repeat(12));
    await setup.renderOnce();
    assert.equal(fixture.requests.filter(request => request.cursor === 2).length, 1);
    setup.mockInput.pressKey('G');
    await setup.waitForFrame(value => value.includes('TAIL-demo-inspect') && value.includes('Following'));
    fixture.releaseNext();
    await new Promise<void>(resolve => setImmediate(resolve));
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    assert.match(frame, /TAIL-demo-inspect/);
    assert.doesNotMatch(frame, /MIDDLE-LINE-|Follow paused/);
  } finally { fixture.releaseHead(); fixture.releaseNext(); unmount(); await fixture.client.close(); await setup.dispose(); }
});

test('Home jumps directly to the retained beginning and scroll continues through source pages', async () => {
  const setup = await createTestRenderer({ width: 160, height: 40 }), fixture = historySource();
  fixture.controls.holdNext = true; fixture.controls.holdLast = true;
  const unmount = mountHub(setup.renderer, fixture.client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('4 loaded / 4 reported'));
    setup.mockInput.pressKey('1');
    let frame = await setup.waitForFrame(value => value.includes('PROMPT-LINE-01') && value.includes('Loading next page'));
    assert.match(frame, /Start \[i\]/);
    setup.mockInput.pressKey('G');
    await setup.waitForFrame(value => value.includes('TAIL-demo-inspect') && value.includes('Following'));
    setup.mockInput.pressEnter();
    setup.mockInput.pressKey('HOME');
    frame = await setup.waitForFrame(value => value.includes('PROMPT-LINE-01') && value.includes('Bash') && value.includes('Loading next page'));
    assert.doesNotMatch(frame, /TAIL-demo-inspect|DISTANT-RESULT|loaded history complete/);
    assert.match(frame, /result not loaded|no result/);
    assert.deepEqual(fixture.requests.filter(request => request.cursor === 0).map(request => ({ cursor: request.cursor, limit: request.limit, view: request.view })), [{ cursor: 0, limit: 40, view: 'blocks' }]);
    assert.doesNotMatch(frame, /PROMPT-LINE-10/);
    setup.mockInput.pressEnter();
    await setup.waitForFrame(value => value.includes('PROMPT-LINE-10'));
    fixture.releaseNext();
    frame = await setup.waitForFrame(value => value.includes('MIDDLE-RECORD') && value.includes('Loading next page'));
    assert.match(frame, /PROMPT-LINE-01/);
    assert.doesNotMatch(frame, /loaded history complete|TAIL-demo-inspect/);
    fixture.releaseLast();
    frame = await setup.waitForFrame(value => value.includes('TAIL-demo-inspect') && value.includes('loaded history complete'));
    assert.deepEqual(fixture.requests.filter(request => request.limit === 40 && typeof request.cursor === 'number').map(request => request.cursor), [0, 2, 3]);
    fixture.controls.updated = true; fixture.controls.holdNewHead = true;
    setup.mockInput.pressKey('r');
    frame = await setup.waitForFrame(value => value.includes('1 new') && value.includes('Loading next page'));
    assert.doesNotMatch(frame, /loaded history complete/);
    fixture.releaseNewHead();
    await setup.waitForFrame(value => value.includes('NEW-TAIL-demo-inspect') && value.includes('PROMPT-LINE-01'));
  } finally { fixture.releaseHead(); fixture.releaseNext(); fixture.releaseLast(); fixture.releaseNewHead(); unmount(); await fixture.client.close(); await setup.dispose(); }
});

test('already loaded history goes to its beginning without a new source read', async () => {
  const setup = await createTestRenderer({ width: 160, height: 40 }), fixture = historySource();
  fixture.controls.fullyLoaded = true;
  const unmount = mountHub(setup.renderer, fixture.client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('4 loaded / 4 reported'));
    setup.mockInput.pressKey('1');
    await setup.waitForFrame(value => value.includes('PROMPT-LINE-01'));
    setup.mockInput.pressKey('G');
    await setup.waitForFrame(value => value.includes('TAIL-demo-inspect'));
    const before = fixture.requests.filter(request => request.cursor === 0).length;
    setup.mockInput.pressKey('i');
    await setup.waitForFrame(value => value.includes('PROMPT-LINE-01') && value.includes('Follow paused'));
    setup.mockInput.pressKey('HOME');
    await setup.renderOnce();
    assert.equal(fixture.requests.filter(request => request.cursor === 0).length, before);
  } finally { fixture.releaseHead(); unmount(); await fixture.client.close(); await setup.dispose(); }
});

test('invalid forward continuation stops automatic reads until an explicit retry', async () => {
  const setup = await createTestRenderer({ width: 160, height: 40 }), fixture = historySource();
  fixture.controls.badNext = true;
  const unmount = mountHub(setup.renderer, fixture.client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('4 loaded / 4 reported'));
    setup.mockInput.pressKey('1');
    let frame = await setup.waitForFrame(value => value.includes('PROMPT-LINE-01') && value.includes('Next page unavailable'));
    assert.doesNotMatch(frame, /MIDDLE-RECORD|loaded history complete/);
    const attempts = fixture.requests.filter(request => request.cursor === 2).length;
    assert.equal(attempts, 1, 'automatic fill made one attempt');
    setup.mockInput.pressEnter();
    setup.mockInput.pressArrow('down');
    await setup.renderOnce();
    assert.equal(fixture.requests.filter(request => request.cursor === 2).length, attempts);
    fixture.controls.badNext = false; fixture.controls.emptyNext = true; fixture.controls.holdNext = true;
    setup.mockInput.pressKey('n');
    await setup.waitForFrame(value => value.includes('Loading next page') && fixture.requests.filter(request => request.cursor === 2).length === attempts + 1);
    fixture.releaseNext();
    await setup.waitForFrame(value => value.includes('Next page unavailable'));
    fixture.controls.emptyNext = false; fixture.controls.holdNext = false;
    setup.mockInput.pressKey('n');
    frame = await setup.waitForFrame(value => value.includes('MIDDLE-RECORD'));
    assert.match(frame, /PROMPT-LINE-01/);
    assert.equal(fixture.requests.filter(request => request.cursor === 2).length, attempts + 2);
  } finally { fixture.releaseHead(); fixture.releaseNext(); unmount(); await fixture.client.close(); await setup.dispose(); }
});

test('a failed beginning is reported, while the tail remains available and the beginning can be retried', async () => {
  const setup = await createTestRenderer({ width: 160, height: 40 }), fixture = historySource();
  fixture.controls.failHead = true;
  const unmount = mountHub(setup.renderer, fixture.client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('4 loaded / 4 reported'));
    setup.mockInput.pressKey('1');
    const failed = await setup.waitForFrame(value => value.includes('Beginning unavailable'));
    assert.doesNotMatch(failed, /PROMPT-LINE-01|TAIL-demo-inspect|loaded history complete/);
    setup.mockInput.pressKey('G');
    await setup.waitForFrame(value => value.includes('TAIL-demo-inspect') && value.includes('Following'));
    fixture.controls.failHead = false;
    setup.mockInput.pressKey('i');
    await setup.waitForFrame(value => value.includes('PROMPT-LINE-01'));
    assert.equal(fixture.requests.filter(request => request.cursor === 0).length, 2);
  } finally { fixture.releaseHead(); unmount(); await fixture.client.close(); await setup.dispose(); }
});

test('a pending beginning does not block tail updates or override End', async () => {
  const setup = await createTestRenderer({ width: 160, height: 40 }), fixture = historySource();
  fixture.controls.holdHead = true;
  const unmount = mountHub(setup.renderer, fixture.client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('4 loaded / 4 reported'));
    setup.mockInput.pressKey('1');
    await setup.waitForFrame(value => value.includes('Loading beginning'));
    setup.mockInput.pressKey('G');
    await setup.waitForFrame(value => value.includes('TAIL-demo-inspect') && value.includes('Following'));
    setup.mockInput.pressKey('i');
    await setup.waitForFrame(value => value.includes('Loading beginning'));
    fixture.controls.updated = true;
    setup.mockInput.pressKey('r');
    await setup.waitForFrame(value => value.includes('Follow paused') && value.includes('1 new'));
    setup.mockInput.pressKey('END');
    await setup.waitForFrame(value => value.includes('NEW-TAIL-demo-inspect') && value.includes('Following'));
    fixture.releaseHead();
    await new Promise<void>(resolve => setImmediate(resolve));
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    assert.match(frame, /NEW-TAIL-demo-inspect/);
    assert.doesNotMatch(frame, /PROMPT-LINE-01|Follow paused/);
  } finally { fixture.releaseHead(); unmount(); await fixture.client.close(); await setup.dispose(); }
});

for (const transition of ['session', 'sequence', 'tab'] as const) {
  test(`a delayed beginning cannot switch back after changing ${transition}`, async () => {
    const setup = await createTestRenderer({ width: 160, height: 40 }), fixture = historySource();
    fixture.controls.holdHead = true;
    const unmount = mountHub(setup.renderer, fixture.client, 'live', () => {});
    try {
      await setup.waitForFrame(value => value.includes('4 loaded / 4 reported'));
      setup.mockInput.pressKey('1');
      await setup.waitForFrame(value => value.includes('Loading beginning'));
      if (transition === 'session') {
        setup.mockInput.pressArrow('down');
        await setup.waitForFrame(value => value.includes('demo-index') && value.includes('Loading beginning'));
        setup.mockInput.pressKey('G');
        await setup.waitForFrame(value => value.includes('TAIL-demo-index'));
      } else if (transition === 'sequence') {
        fixture.controls.resumed = true;
        setup.mockInput.pressKey('r');
        await setup.waitForFrame(value => value.includes('sequence 2') && value.includes('Loading beginning'));
        setup.mockInput.pressKey('G');
        await setup.waitForFrame(value => value.includes('sequence 2') && value.includes('TAIL-demo-inspect'));
      } else {
        setup.mockInput.pressKey('a');
        await setup.waitForFrame(value => value.includes('[Result]') && value.includes('No answer reported'));
      }
      fixture.releaseHead();
      await new Promise<void>(resolve => setImmediate(resolve));
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      assert.doesNotMatch(frame, /PROMPT-LINE-01/);
      assert.match(frame, transition === 'session' ? /TAIL-demo-index/ : transition === 'sequence' ? /sequence 2/ : /\[Result\]/);
    } finally { fixture.releaseHead(); unmount(); await fixture.client.close(); await setup.dispose(); }
  });
}
