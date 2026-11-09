/** Verifies initial history loading and viewport filling using synthetic source pages. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestRenderer } from '@opentui/core/testing';
import { createDemoClient } from '../src/demo.ts';
import { mountHub } from '../src/hub.ts';
import type { ObservationClient } from '../src/api.ts';

/** Returns short forward pages and a distant tail without contacting live services. */
function pagedSource() {
  const demo = createDemoClient(), requests: { id: string; cursor: number | null; tail: boolean }[] = [];
  const controls = { holdHead: false, holdNext: false, failHead: false, repeatedResult: false, repeatThrough: 0, resumed: false, laterUser: false };
  let releaseHead!: () => void, releaseNext!: () => void;
  const headGate = new Promise<void>(resolve => { releaseHead = resolve; });
  const nextGate = new Promise<void>(resolve => { releaseNext = resolve; });
  const client: ObservationClient = {
    async read(resource, params = {}, signal) {
      if (resource !== 'run.transcript') {
        const response = await demo.read(resource, params, signal);
        if (resource !== 'run.agents' || !controls.resumed || !response.data) return response;
        const data = response.data as { items: Record<string, unknown>[] };
        return { ...response, data: { ...data, items: data.items.map(item => item.agent_id === 'demo-inspect' ? { ...item, sequence: 2 } : item) } };
      }
      const id = String(params.agent_id), tail = typeof params.tail_blocks === 'number';
      const cursor = typeof params.cursor === 'number' ? params.cursor : 0;
      requests.push({ id, cursor: tail ? null : cursor, tail });
      if (!tail && cursor === 0 && controls.holdHead && id === 'demo-inspect') await headGate;
      if (!tail && cursor === 3 && controls.holdNext && id === 'demo-inspect') await nextGate;
      if (!tail && cursor === 0 && controls.failHead) return { schema_version: 1, source: 'run', resource, observed_at_ms: Date.now(), outcome: 'unavailable', data: null, error: { code: 'fixture', message: 'unavailable' } };
      const messages = Array.from({ length: controls.repeatedResult ? 120 : 49 }, (_, index) => {
        const seq = index + 1, user = index === 0, repeated = !user && (controls.repeatedResult || index <= controls.repeatThrough);
        return { seq, role: user ? 'user' : repeated ? 'tool_result' : 'tool', name: user ? null : repeated ? 'Output' : `Call-${String(index).padStart(2, '0')}`, content: user ? `${controls.laterUser ? 'LATER' : 'PROMPT'}-${id}` : `record-${index}`, raw_ref: repeated ? 'same-result' : null, at: 100 + seq, content_complete: true, error: user ? null : false, first_seq: seq, last_seq: seq, starts_block: !repeated || index <= 1, partial_before: repeated && index > 1, partial_after: repeated && (controls.repeatedResult || index < controls.repeatThrough) };
      });
      const lastSeq = messages.length + 1;
      messages.push({ seq: lastSeq, role: 'assistant', name: null, content: `TAIL-${id}`, raw_ref: null, at: 150, content_complete: true, error: null, first_seq: lastSeq, last_seq: lastSeq, starts_block: true, partial_before: false, partial_after: false });
      const selected = tail ? messages.slice(-3) : messages.filter(row => row.seq > cursor).slice(0, 3);
      const last = selected.at(-1)?.seq ?? cursor, complete = tail ? false : last >= messages.at(-1)!.seq;
      return { schema_version: 1, source: 'run', resource, observed_at_ms: Date.now(), outcome: complete ? 'ok' : 'partial', error: null,
        data: { agent_id: id, view: 'blocks', cursor: tail ? 0 : cursor, direction: tail ? 'backward' : 'forward', messages: selected, complete, previous_cursor: tail ? selected[0].seq : null, next_cursor: !tail && !complete ? last : null, resume_cursor: last } };
    },
    close: () => demo.close(),
  };
  return { client, controls, requests, releaseHead, releaseNext };
}

test('a new session opens at its retained beginning and fills the viewport from subsequent pages', async () => {
  const setup = await createTestRenderer({ width: 120, height: 40 }), fixture = pagedSource();
  const unmount = mountHub(setup.renderer, fixture.client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('4 loaded / 4 reported'));
    setup.mockInput.pressKey('1');
    const frame = await setup.waitForFrame(value => value.includes('PROMPT-demo-inspect') && value.includes('Call-12'));
    assert.doesNotMatch(frame, /TAIL-demo-inspect|load next page|Earlier loaded messages|Later loaded messages/);
    assert.ok(frame.split('\n').findIndex(row => row.includes('Call-12')) >= 25, 'history fills the lower viewport');
    const cursors = fixture.requests.filter(request => request.id === 'demo-inspect' && !request.tail).map(request => request.cursor);
    assert.deepEqual(cursors.slice(0, 5), [0, 3, 6, 9, 12]);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(fixture.requests.filter(request => request.id === 'demo-inspect' && !request.tail).length, cursors.length, 'prefetch stops when the viewport is full');
  } finally { fixture.releaseHead(); unmount(); await fixture.client.close(); await setup.dispose(); }
});

test('the first retained user message is not claimed as the original task', async () => {
  const setup = await createTestRenderer({ width: 120, height: 40 }), fixture = pagedSource();
  fixture.controls.laterUser = true;
  const unmount = mountHub(setup.renderer, fixture.client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('4 loaded / 4 reported'));
    setup.mockInput.pressKey('1');
    const frame = await setup.waitForFrame(value => value.includes('LATER-demo-inspect') && value.includes('Initial task unverified'));
    assert.match(frame, /showing retained history/);
    assert.doesNotMatch(frame, /PROMPT-demo-inspect/);
  } finally { fixture.releaseHead(); unmount(); await fixture.client.close(); await setup.dispose(); }
});

test('the initial-task uncertainty remains visible in a narrow session view', async () => {
  const setup = await createTestRenderer({ width: 66, height: 24 }), fixture = pagedSource();
  fixture.controls.laterUser = true;
  const unmount = mountHub(setup.renderer, fixture.client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('4 loaded / 4 reported'));
    setup.mockInput.pressKey('1');
    await setup.waitForFrame(value => value.includes('Inspect execution history'));
    setup.mockInput.pressEnter();
    const frame = await setup.waitForFrame(value => value.includes('LATER-demo-inspect') && value.includes('Initial task unverified'));
    assert.match(frame, /showing retained history/);
  } finally { fixture.releaseHead(); unmount(); await fixture.client.close(); await setup.dispose(); }
});

test('a fast tail cannot replace a pending or unavailable initial page', async () => {
  const setup = await createTestRenderer({ width: 120, height: 40 }), fixture = pagedSource();
  fixture.controls.holdHead = true;
  const unmount = mountHub(setup.renderer, fixture.client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('4 loaded / 4 reported'));
    setup.mockInput.pressKey('1');
    let frame = await setup.waitForFrame(value => value.includes('Loading beginning'));
    assert.doesNotMatch(frame, /TAIL-demo-inspect/);
    fixture.controls.failHead = true; fixture.releaseHead();
    frame = await setup.waitForFrame(value => value.includes('Beginning unavailable'));
    assert.doesNotMatch(frame, /TAIL-demo-inspect|PROMPT-demo-inspect/);
    fixture.controls.failHead = false;
    setup.mockInput.pressKey('i');
    await setup.waitForFrame(value => value.includes('PROMPT-demo-inspect'));
  } finally { fixture.releaseHead(); unmount(); await fixture.client.close(); await setup.dispose(); }
});

test('switching to active and finished agents opens each retained beginning', async () => {
  const setup = await createTestRenderer({ width: 160, height: 40 }), fixture = pagedSource();
  const unmount = mountHub(setup.renderer, fixture.client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('4 loaded / 4 reported'));
    setup.mockInput.pressKey('1');
    let frame = await setup.waitForFrame(value => value.includes('PROMPT-demo-inspect'));
    await setup.mockMouse.click(10, frame.split('\n').findIndex(row => row.includes('Index repository')));
    frame = await setup.waitForFrame(value => value.includes('PROMPT-demo-index'));
    assert.doesNotMatch(frame, /PROMPT-demo-inspect|TAIL-demo-index/);
    setup.mockInput.pressKey('o');
    frame = await setup.waitForFrame(value => value.includes('Review saved output'));
    await setup.mockMouse.click(10, frame.split('\n').findIndex(row => row.includes('Review saved output')));
    frame = await setup.waitForFrame(value => value.includes('PROMPT-demo-finished'));
    assert.doesNotMatch(frame, /PROMPT-demo-index|TAIL-demo-finished/);
  } finally { fixture.releaseHead(); unmount(); await fixture.client.close(); await setup.dispose(); }
});

test('reopening another transcript starts there even after following its tail', async () => {
  const setup = await createTestRenderer({ width: 160, height: 40 }), fixture = pagedSource();
  const unmount = mountHub(setup.renderer, fixture.client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('4 loaded / 4 reported'));
    setup.mockInput.pressKey('1');
    await setup.waitForFrame(value => value.includes('PROMPT-demo-inspect'));
    setup.mockInput.pressKey('G');
    let frame = await setup.waitForFrame(value => value.includes('TAIL-demo-inspect') && value.includes('Following'));
    await setup.mockMouse.click(10, frame.split('\n').findIndex(row => row.includes('Index repository')));
    frame = await setup.waitForFrame(value => value.includes('PROMPT-demo-index'));
    await setup.mockMouse.click(10, frame.split('\n').findIndex(row => row.includes('Inspect execution history')));
    frame = await setup.waitForFrame(value => value.includes('PROMPT-demo-inspect'));
    assert.doesNotMatch(frame, /TAIL-demo-inspect/);
  } finally { fixture.releaseHead(); fixture.releaseNext(); unmount(); await fixture.client.close(); await setup.dispose(); }
});

test('automatic filling is bounded when many pages form one collapsed result', async () => {
  const setup = await createTestRenderer({ width: 120, height: 40 }), fixture = pagedSource();
  fixture.controls.repeatedResult = true;
  const unmount = mountHub(setup.renderer, fixture.client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('4 loaded / 4 reported'));
    setup.mockInput.pressKey('1');
    await setup.waitForFrame(value => value.includes('PROMPT-demo-inspect'));
    await setup.waitFor(() => fixture.requests.filter(request => request.id === 'demo-inspect' && !request.tail).length >= 33, { maxPasses: 200 });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(fixture.requests.filter(request => request.id === 'demo-inspect' && !request.tail).length, 33, 'one initial and 32 automatic pages');
    await setup.mockMouse.scroll(70, 30, 'down');
    await setup.waitFor(() => fixture.requests.filter(request => request.id === 'demo-inspect' && !request.tail).length > 33);
  } finally { fixture.releaseHead(); unmount(); await fixture.client.close(); await setup.dispose(); }
});

test('automatic filling continues past eight partial-result pages', async () => {
  const setup = await createTestRenderer({ width: 120, height: 40 }), fixture = pagedSource();
  fixture.controls.repeatThrough = 30;
  const unmount = mountHub(setup.renderer, fixture.client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('4 loaded / 4 reported'));
    setup.mockInput.pressKey('1');
    const frame = await setup.waitForFrame(value => value.includes('PROMPT-demo-inspect') && value.includes('Call-42'), { maxPasses: 200 });
    assert.doesNotMatch(frame, /TAIL-demo-inspect|load next page/);
    assert.ok(fixture.requests.filter(request => request.id === 'demo-inspect' && !request.tail).length > 8);
  } finally { fixture.releaseHead(); fixture.releaseNext(); unmount(); await fixture.client.close(); await setup.dispose(); }
});

test('a delayed page cannot continue loading the previous agent after selection changes', async () => {
  const setup = await createTestRenderer({ width: 160, height: 40 }), fixture = pagedSource();
  fixture.controls.holdNext = true;
  const unmount = mountHub(setup.renderer, fixture.client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('4 loaded / 4 reported'));
    setup.mockInput.pressKey('1');
    let frame = await setup.waitForFrame(value => value.includes('PROMPT-demo-inspect') && value.includes('Loading next'));
    await setup.mockMouse.click(10, frame.split('\n').findIndex(row => row.includes('Index repository')));
    await setup.waitForFrame(value => value.includes('PROMPT-demo-index'));
    fixture.releaseNext();
    await new Promise(resolve => setTimeout(resolve, 50));
    await setup.renderOnce();
    frame = setup.captureCharFrame();
    assert.match(frame, /PROMPT-demo-index/);
    assert.doesNotMatch(frame, /PROMPT-demo-inspect|TAIL-demo-inspect/);
    assert.equal(fixture.requests.filter(request => request.id === 'demo-inspect' && !request.tail && typeof request.cursor === 'number' && request.cursor > 3).length, 0);
  } finally { fixture.releaseHead(); fixture.releaseNext(); unmount(); await fixture.client.close(); await setup.dispose(); }
});

test('switching sessions cancels both in-flight transcript reads', async () => {
  const setup = await createTestRenderer({ width: 160, height: 40 }), demo = createDemoClient();
  const started: string[] = [], cancelled: string[] = [];
  const client: ObservationClient = {
    async read(resource, params = {}, signal) {
      if (resource === 'run.transcript' && params.agent_id === 'demo-inspect') {
        const kind = typeof params.tail_blocks === 'number' ? 'tail' : 'beginning'; started.push(kind);
        await new Promise<void>(resolve => {
          const abort = () => { cancelled.push(kind); resolve(); };
          if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
        });
      }
      return demo.read(resource, params, signal);
    },
    close: () => demo.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'demo', () => {});
  try {
    await setup.waitForFrame(value => value.includes('4 loaded / 4 reported'));
    setup.mockInput.pressKey('1');
    const frame = await setup.waitForFrame(value => value.includes('Index repository') && started.includes('tail') && started.includes('beginning'));
    await setup.mockMouse.click(10, frame.split('\n').findIndex(row => row.includes('Index repository')));
    await setup.waitFor(() => cancelled.includes('tail') && cancelled.includes('beginning'));
    await setup.waitForFrame(value => value.includes('Index repository') && value.includes('sequence 1'));
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('a new active-only execution cancels reads owned by its previous sequence', async () => {
  const setup = await createTestRenderer({ width: 160, height: 40 }), demo = createDemoClient();
  const started: string[] = [], cancelled: string[] = []; let resumed = false;
  const client: ObservationClient = {
    async read(resource, params = {}, signal) {
      if (resource === 'run.agents') {
        const base = await demo.read(resource, params, signal), page = base.data as { items: Record<string, unknown>[] }, sample = page.items[0];
        const active = params.active === true;
        const items = active ? [{ ...sample, agent_id: 'old-running', name: 'Old running session', sequence: resumed ? 2 : 1, status: 'running' }] : [{ ...sample, agent_id: 'recent-finished', name: 'Recent finished', sequence: 1, status: 'succeeded' }];
        return { ...base, data: { ...page, items, total: active ? 1 : 2, next_offset: active ? null : 1, complete: active, revision: active && resumed ? 43 : 42 } };
      }
      if (resource === 'run.transcript' && params.agent_id === 'old-running' && !resumed) {
        const kind = typeof params.tail_blocks === 'number' ? 'tail' : 'beginning'; started.push(kind);
        await new Promise<void>(resolve => { const abort = () => { cancelled.push(kind); resolve(); }; if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true }); });
      }
      if (resource === 'run.transcript' && params.agent_id === 'old-running' && resumed) return { schema_version: 1, source: 'run', resource, observed_at_ms: Date.now(), outcome: 'ok', error: null, data: { agent_id: 'old-running', view: 'blocks', cursor: params.cursor ?? 0, messages: [{ seq: 1, role: 'user', name: null, content: 'New execution prompt', at: 100, content_complete: true }], complete: true, previous_cursor: null, next_cursor: null, resume_cursor: 1 } };
      return demo.read(resource, params, signal);
    },
    close: () => demo.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'demo', () => {});
  try {
    await setup.waitForFrame(value => value.includes('Agent Run'));
    setup.mockInput.pressKey('1');
    await setup.waitForFrame(value => value.includes('Old running session') && started.includes('tail') && started.includes('beginning'));
    resumed = true; setup.mockInput.pressKey('r');
    await setup.waitFor(() => cancelled.includes('tail') && cancelled.includes('beginning'));
    await setup.waitForFrame(value => value.includes('New execution prompt') && value.includes('sequence 2'));
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('a changed source admission clock separates cached history even when sequence repeats', async () => {
  const setup = await createTestRenderer({ width: 160, height: 40 }), demo = createDemoClient();
  let replaced = false;
  const client: ObservationClient = {
    async read(resource, params = {}, signal) {
      if (resource === 'run.transcript' && params.agent_id === 'demo-inspect') { const cursor = Number(params.cursor ?? 0); return { schema_version: 1, source: 'run', resource, observed_at_ms: Date.now(), outcome: 'ok', error: null, data: { agent_id: 'demo-inspect', view: 'blocks', cursor, messages: cursor >= 1 ? [] : [{ seq: 1, role: 'user', name: null, content: replaced ? 'New admission prompt' : 'Old admission prompt', at: 100, content_complete: true }], complete: true, previous_cursor: null, next_cursor: null, resume_cursor: 1 } }; }
      const response = await demo.read(resource, params, signal);
      if (resource !== 'run.agents' || !response.data) return response;
      const page = response.data as { items: Record<string, unknown>[] };
      return { ...response, data: { ...page, revision: replaced ? 2 : 1, items: page.items.map(item => item.agent_id === 'demo-inspect' ? { ...item, created_at: replaced ? 200 : 100 } : item) } };
    },
    close: () => demo.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'demo', () => {});
  try {
    await setup.waitForFrame(value => value.includes('4 loaded / 4 reported'));
    setup.mockInput.pressKey('1'); await setup.waitForFrame(value => value.includes('Old admission prompt'));
    replaced = true; setup.mockInput.pressKey('r');
    const frame = await setup.waitForFrame(value => value.includes('New admission prompt'));
    assert.doesNotMatch(frame, /Old admission prompt/);
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('opening failed executions never starts a transcript for the previously selected session', async () => {
  const setup = await createTestRenderer({ width: 160, height: 40 }), demo = createDemoClient(), requests: string[] = [];
  const client: ObservationClient = {
    async read(resource, params = {}, signal) {
      if (resource === 'run.transcript') requests.push(String(params.agent_id));
      const response = await demo.read(resource, params, signal);
      if (resource !== 'run.agents' || !response.data) return response;
      const page = response.data as { items: Record<string, unknown>[] };
      return { ...response, data: { ...page, items: page.items.map(item => item.agent_id === 'demo-failed' ? { ...item, finished_at: Math.floor(Date.now() / 1000) - 1 } : item) } };
    },
    close: () => demo.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'demo', () => {});
  try {
    await setup.waitForFrame(value => value.includes('4 loaded / 4 reported') && value.includes('Failed executions'));
    setup.mockInput.pressEnter();
    await setup.waitForFrame(value => value.includes('Inspect failed observation') && value.includes('[History]'));
    assert.ok(requests.includes('demo-failed'));
    assert.ok(!requests.includes('demo-inspect'));
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('returning to the tail while the beginning loads does not reopen it later', async () => {
  const setup = await createTestRenderer({ width: 120, height: 40 }), fixture = pagedSource();
  fixture.controls.holdHead = true;
  const unmount = mountHub(setup.renderer, fixture.client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('4 loaded / 4 reported'));
    setup.mockInput.pressKey('1');
    await setup.waitForFrame(value => value.includes('Loading beginning'));
    setup.mockInput.pressKey('G');
    await setup.waitForFrame(value => value.includes('TAIL-demo-inspect') && value.includes('Following'));
    fixture.releaseHead();
    await new Promise(resolve => setTimeout(resolve, 50));
    await setup.renderOnce();
    assert.match(setup.captureCharFrame(), /TAIL-demo-inspect/);
    assert.doesNotMatch(setup.captureCharFrame(), /PROMPT-demo-inspect/);
    assert.equal(fixture.requests.filter(request => request.id === 'demo-inspect' && !request.tail).length, 1);
  } finally { fixture.releaseHead(); fixture.releaseNext(); unmount(); await fixture.client.close(); await setup.dispose(); }
});

test('a taller viewport fills with more pages without moving the prompt', async () => {
  const setup = await createTestRenderer({ width: 120, height: 24 }), fixture = pagedSource();
  const unmount = mountHub(setup.renderer, fixture.client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('4 loaded / 4 reported'));
    setup.mockInput.pressKey('1');
    const before = await setup.waitForFrame(value => value.includes('PROMPT-demo-inspect') && value.includes('Call-04'));
    const row = before.split('\n').findIndex(line => line.includes('PROMPT-demo-inspect'));
    setup.resize(120, 60);
    const after = await setup.waitForFrame(value => value.includes('PROMPT-demo-inspect') && value.includes('Call-20'));
    assert.equal(after.split('\n').findIndex(line => line.includes('PROMPT-demo-inspect')), row);
  } finally { fixture.releaseHead(); fixture.releaseNext(); unmount(); await fixture.client.close(); await setup.dispose(); }
});

test('returning to history after a new execution opens its beginning immediately', async () => {
  const setup = await createTestRenderer({ width: 160, height: 40 }), fixture = pagedSource();
  fixture.controls.holdHead = true;
  const unmount = mountHub(setup.renderer, fixture.client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('4 loaded / 4 reported'));
    setup.mockInput.pressKey('1');
    await setup.waitForFrame(value => value.includes('Loading beginning'));
    setup.mockInput.pressKey('a');
    await setup.waitForFrame(value => value.includes('[Result]'));
    fixture.controls.resumed = true; setup.mockInput.pressKey('r');
    const result = await setup.waitForFrame(value => value.includes('sequence 2') && value.includes('[Result]'));
    const tab = result.split('\n')[3].indexOf('History');
    assert.ok(tab >= 0);
    await setup.mockMouse.click(tab + 1, 3);
    const frame = await setup.waitForFrame(value => value.includes('sequence 2') && value.includes('Loading beginning') && fixture.requests.filter(request => !request.tail && request.cursor === 0).length === 2);
    assert.doesNotMatch(frame, /TAIL-demo-inspect/);
    fixture.releaseHead();
    await setup.waitForFrame(value => value.includes('sequence 2') && value.includes('PROMPT-demo-inspect'));
  } finally { fixture.releaseHead(); fixture.releaseNext(); unmount(); await fixture.client.close(); await setup.dispose(); }
});
