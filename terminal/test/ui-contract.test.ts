/** Exercises live source transitions without contacting installed services. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createTestRenderer } from '@opentui/core/testing';
import { createDemoClient, DEMO_POOL_AGENT_ID } from '../src/demo.ts';
import { mountHub } from '../src/hub.ts';
import type { ObservationClient, Resource } from '../src/api.ts';

/** Extracts the value under the Bridge intake label from a wide terminal frame. */
function bridgeAccepted(frame: string): string {
  const rows = frame.split('\n'), line = rows.findIndex(row => row.includes('Accepted by Bridge'));
  const column = line < 0 ? -1 : rows[line].indexOf('Accepted by Bridge');
  return column < 0 ? '' : rows.slice(line + 1, line + 4).map(row => row.slice(column, column + 30)).join(' ');
}

test('Bridge overview follows its frozen cursor and keeps independent sources', async () => {
  const setup = await createTestRenderer({ width: 120, height: 40 });
  const demo = createDemoClient(), calls: Record<string, unknown>[] = []; let failContinuation = false, replayContinuation = false, partialContinuation = false;
  const client: ObservationClient = {
    async read(resource, params = {}, signal) {
      if (resource !== 'bridge.deliveries') return demo.read(resource, params, signal);
      const after = Number(params.after_seq ?? 0);
      // The independent held-message scan walks newest-first windows (a limit-1 probe, then after_seq 1); only the Overview's own ascending scan is recorded.
      if (params.limit !== 1 && !(after === 1 && params.through_seq === 101)) calls.push(params);
      if (after > 0 && failContinuation) return { schema_version: 1, source: 'bridge', resource, observed_at_ms: Date.now(), outcome: 'unavailable', error: { code: 'offline', message: 'Source unavailable' }, data: null };
      const rows = after === 0 ? Array.from({ length: 100 }, (_, index) => ({ acceptance_seq: index + 1, publisher: 'synthetic', event_id: `old-${index}`, custody_state: 'accepted', delivery_state: 'unknown', accepted_at_ms: Date.now() - 2 * 86400_000 })) : [{ acceptance_seq: replayContinuation ? 1 : 101, publisher: 'synthetic', event_id: 'today', custody_state: 'accepted', delivery_state: 'unknown', accepted_at_ms: Date.now() - 1000 }];
      return { schema_version: 1, source: 'bridge', resource, observed_at_ms: Date.now(), outcome: after > 0 && partialContinuation ? 'partial' : 'ok', error: null, data: { schema_version: 1, kind: 'delivery_page', data: { deliveries: rows, through_seq: 101, next_after_seq: after === 0 ? 100 : null, coverage: 'retained_history' } } };
    },
    close: () => demo.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'live', () => {});
  try {
    const frame = await setup.waitForFrame(value => calls.length >= 2 && /\b1\b/.test(bridgeAccepted(value)));
    assert.match(frame, /Agent Run/);
    assert.match(frame, /Agent Bridge/);
    assert.equal(calls[1]?.after_seq, 100);
    assert.equal(calls[1]?.through_seq, 101);
    partialContinuation = true;
    setup.mockInput.pressKey('r');
    await setup.waitForFrame(value => bridgeAccepted(value).includes('≥1 retained · partial'));
    partialContinuation = false;
    setup.mockInput.pressKey('r');
    await setup.waitForFrame(value => /\b1\b/.test(bridgeAccepted(value)) && !bridgeAccepted(value).includes('partial'));
    failContinuation = true;
    setup.mockInput.pressKey('r');
    const stale = await setup.waitForFrame(value => bridgeAccepted(value).includes('STALE · 1 retained'));
    assert.match(bridgeAccepted(stale), /STALE · 1 retained/);
    failContinuation = false;
    setup.mockInput.pressKey('r');
    await setup.waitForFrame(value => /\b1\b/.test(bridgeAccepted(value)) && !bridgeAccepted(value).includes('STALE'));
    replayContinuation = true;
    setup.mockInput.pressKey('r');
    await setup.waitForFrame(value => bridgeAccepted(value).includes('STALE · 1 retained'));
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('a failed refresh marks retained sessions stale', async () => {
  const setup = await createTestRenderer({ width: 120, height: 40 });
  const demo = createDemoClient(); let disconnected = false;
  const client: ObservationClient = {
    async read(resource, params, signal) {
      if (resource === 'run.agents' && disconnected) return { schema_version: 1, source: 'run', resource, observed_at_ms: Date.now(), outcome: 'unavailable', data: null, error: { code: 'offline', message: 'Source unavailable' } };
      return demo.read(resource, params, signal);
    },
    close: () => demo.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('Agent Run') && value.includes('Active'));
    setup.mockInput.pressKey('1');
    await setup.waitForFrame(value => value.includes('Inspect execution history'));
    disconnected = true;
    setup.mockInput.pressKey('r');
    const frame = await setup.waitForFrame(value => value.includes('STALE'));
    assert.match(frame, /Inspect execution history/);
    assert.match(frame, /STALE/);
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('loading every Run page clears the pagination-only partial state', async () => {
  const setup = await createTestRenderer({ width: 120, height: 40 });
  const demo = createDemoClient();
  const client: ObservationClient = {
    async read(resource, params = {}, signal) {
      const base = await demo.read(resource, resource === 'run.agents' ? {} : params, signal);
      if (resource !== 'run.agents' || !base.data) return base;
      const template = (base.data as { items: Record<string, unknown>[] }).items[0], offset = Number(params.offset ?? 0);
      const count = offset === 0 ? 200 : 1;
      return { ...base, outcome: offset === 0 ? 'partial' : 'ok', data: { items: Array.from({ length: count }, (_, index) => ({ ...template, agent_id: `agent-${offset + index}` })), offset, limit: 200, total: 201, next_offset: offset === 0 ? 200 : null, complete: offset !== 0, revision: 1, message_revision: 1, observed_at: Math.floor(Date.now() / 1000) } };
    },
    close: () => demo.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('200 loaded / 201 reported'));
    setup.mockInput.pressKey('1');
    await setup.waitForFrame(value => value.includes('200 loaded / 201 reported'));
    setup.mockInput.pressKey('n');
    const frame = await setup.waitForFrame(value => value.includes('201 loaded / 201 reported'));
    assert.doesNotMatch(frame.split('\n')[3] ?? '', /partial/i);
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('an exact pool binding cannot switch to a resumed execution', async () => {
  const setup = await createTestRenderer({ width: 120, height: 40 });
  const demo = createDemoClient(); let resumed = false;
  const client: ObservationClient = {
    async read(resource: Resource, params, signal) {
      const value = await demo.read(resource, params, signal);
      if (resource === 'run.agents' && value.data) {
        const data = value.data as { items: Record<string, unknown>[] };
        return { ...value, data: { ...data, items: data.items.map(item => item.agent_id === 'demo-inspect' ? { ...item, agent_id: DEMO_POOL_AGENT_ID, sequence: resumed ? 2 : 1 } : item) } };
      }
      return value;
    },
    close: () => demo.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('Agent Run') && value.includes('4 loaded / 4 reported'));
    setup.mockInput.pressKey('2');
    await setup.waitForFrame(value => value.includes('Synthetic review pool'));
    setup.mockInput.pressEnter();
    await setup.waitForFrame(value => value.includes('Example reviewer'));
    setup.mockInput.pressEnter();
    await setup.waitForFrame(value => value.includes('sequence 1'));
    resumed = true;
    setup.mockInput.pressKey('r');
    const frame = await setup.waitForFrame(value => value.includes('Bound execution 1'));
    assert.match(frame, /withheld/);
    assert.doesNotMatch(frame, /sequence 2 · Agent Run/);
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('a long verified answer remains navigable through its final Unicode text', async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 });
  const demo = createDemoClient();
  const content = `BEGIN\n${'\n'.repeat(500_000)}THE-END-Ж`, bytes = Buffer.from(content), sha = createHash('sha256').update(bytes).digest('hex');
  const client: ObservationClient = {
    async read(resource, params = {}, signal) {
      const base = await demo.read(resource, params, signal);
      if (resource === 'run.agents' && base.data) {
        const data = base.data as { items: Record<string, unknown>[] };
        return { ...base, data: { ...data, items: data.items.map(item => item.agent_id === 'demo-inspect' ? { ...item, answer_available: true, answer_sha256: sha } : item) } };
      }
      if (resource === 'run.answer') return { ...base, outcome: 'ok', error: null, data: { agent_id: 'demo-inspect', available: true, inline_complete: false, sha256: sha, size_bytes: bytes.length } };
      if (resource === 'run.answer_chunk') {
        const offset = Number(params.offset_bytes), end = Math.min(bytes.length, offset + 65536), text = bytes.subarray(offset, end).toString('utf8');
        return { ...base, outcome: 'ok', error: null, data: { agent_id: 'demo-inspect', sequence: 1, sha256: sha, total_bytes: bytes.length, offset_bytes: offset, next_offset: end, content: text, complete: end === bytes.length } };
      }
      return base;
    },
    close: () => demo.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('Agent Run') && value.includes('Active'));
    setup.mockInput.pressKey('1');
    await setup.waitForFrame(value => value.includes('Inspect execution history'));
    setup.mockInput.pressKey('a');
    await setup.waitForFrame(value => value.includes('SHA-256 verified') && value.includes('BEGIN'), { maxPasses: 200 });
    setup.mockInput.pressKey('END');
    const frame = await setup.waitForFrame(value => value.includes('THE-END-Ж'), { maxPasses: 200 });
    assert.match(frame, /THE-END-Ж/);
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('a long transcript message can be read in bounded parts', async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 });
  const demo = createDemoClient(), content = 'A\n'.repeat(4096) + 'FINAL-MESSAGE-Ж';
  const client: ObservationClient = {
    async read(resource, params = {}, signal) {
      if (resource !== 'run.transcript') return demo.read(resource, params, signal);
      return { schema_version: 1, source: 'run', resource, observed_at_ms: Date.now(), outcome: 'ok', error: null, data: { agent_id: params.agent_id, view: 'blocks', cursor: 0, messages: [{ seq: 1, role: 'assistant', content, at: 100, content_complete: true }], complete: true, previous_cursor: null, next_cursor: null, resume_cursor: 1 } };
    },
    close: () => demo.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('Agent Run') && value.includes('Active'));
    setup.mockInput.pressKey('1'); setup.mockInput.pressKey('G');
    await setup.waitForFrame(value => value.includes('Inspect execution history'));
    setup.mockInput.pressEnter();
    await setup.waitForFrame(value => value.includes('Part 1/2'));
    setup.mockInput.pressKey(']');
    await setup.waitForFrame(value => value.includes('FINAL-MESSAGE-Ж'));
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('a complete page with an omitted body is not called complete history', async () => {
  const setup = await createTestRenderer({ width: 120, height: 40 });
  const demo = createDemoClient();
  const client: ObservationClient = {
    async read(resource, params = {}, signal) {
      if (resource !== 'run.transcript') return demo.read(resource, params, signal);
      return { schema_version: 1, source: 'run', resource, observed_at_ms: Date.now(), outcome: 'ok', error: null, data: { agent_id: params.agent_id, view: 'blocks', cursor: 0, messages: [{ seq: 1, role: 'assistant', content: 'partial body', at: 100, content_complete: false, omitted_bytes: 10 }], complete: true, previous_cursor: null, next_cursor: null, resume_cursor: 1 } };
    },
    close: () => demo.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('Agent Run') && value.includes('4 loaded / 4 reported'));
    setup.mockInput.pressKey('1');
    const frame = await setup.waitForFrame(value => value.includes('bodies incomplete/unknown'));
    assert.doesNotMatch(frame, /loaded history complete/);
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('scrolling reaches earlier loaded history windows and resumes at the tail', async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 });
  const demo = createDemoClient(); let olderRead = false;
  const client: ObservationClient = {
    async read(resource, params = {}, signal) {
      if (resource !== 'run.transcript') return demo.read(resource, params, signal);
      olderRead ||= typeof params.before_cursor === 'number';
      const messages = olderRead && typeof params.before_cursor === 'number' ? Array.from({ length: 3 }, (_, index) => ({ seq: 98 + index, role: 'assistant', content: `older-${index + 1}`, at: 90 + index, content_complete: true })) : Array.from({ length: 12 }, (_, index) => ({ seq: index + 101, role: 'assistant', content: `message-${index + 1}`, at: 100 + index, content_complete: true }));
      return { schema_version: 1, source: 'run', resource, observed_at_ms: Date.now(), outcome: 'ok', error: null, data: { agent_id: params.agent_id, view: 'blocks', cursor: 0, messages, complete: typeof params.before_cursor === 'number', previous_cursor: typeof params.before_cursor === 'number' ? null : 101, next_cursor: null, resume_cursor: messages.at(-1)?.seq ?? null } };
    },
    close: () => demo.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('Agent Run') && value.includes('Active'));
    setup.mockInput.pressKey('1'); setup.mockInput.pressKey('G');
    await setup.waitForFrame(value => value.includes('Inspect execution history'));
    setup.mockInput.pressEnter();
    await setup.waitForFrame(value => value.includes('message-12'));
    setup.mockInput.pressKey('\x1b[5~'.repeat(2));
    await setup.waitForFrame(value => value.includes('message-1') && !value.includes('message-12'));
    setup.mockInput.pressKey('G');
    await setup.waitForFrame(value => value.includes('message-12') && value.includes('Following'));
    setup.mockInput.pressKey('\x1b[5~');
    setup.mockInput.pressKey('\x1b[5~');
    await setup.renderOnce();
    setup.mockInput.pressArrow('up');
    await setup.waitForFrame(value => value.includes('message-4') && !value.includes('message-12'));
    setup.mockInput.pressKey('g');
    await setup.waitForFrame(value => olderRead && value.includes('message-4') && !value.includes('message-12'));
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('followed updates cannot make Enter toggle a previously selected hidden message', async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 });
  const demo = createDemoClient(); let updated = false;
  const client: ObservationClient = {
    async read(resource, params = {}, signal) {
      if (resource !== 'run.transcript') return demo.read(resource, params, signal);
      const messages = updated && typeof params.cursor === 'number'
        ? [{ seq: 2, role: 'assistant', content: '\n'.repeat(500) + 'VISIBLE-TAIL', at: 102, content_complete: true }]
        : [{ seq: 1, role: 'tool', name: 'Old tool', content: 'OLD-TOOL-BODY', at: 100, content_complete: true, error: false }];
      return { schema_version: 1, source: 'run', resource, observed_at_ms: Date.now(), outcome: 'ok', error: null, data: { agent_id: params.agent_id, view: 'blocks', cursor: 0, messages, complete: true, previous_cursor: null, next_cursor: null, resume_cursor: messages.at(-1)!.seq } };
    },
    close: () => demo.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'live', () => {});
  try {
    await setup.waitForFrame(value => value.includes('Agent Run') && value.includes('Active'));
    setup.mockInput.pressKey('1'); setup.mockInput.pressKey('G');
    await setup.waitForFrame(value => value.includes('Inspect execution history'));
    setup.mockInput.pressEnter();
    await setup.waitForFrame(value => value.includes('Old tool'));
    setup.mockInput.pressEnter();
    await setup.waitForFrame(value => value.includes('OLD-TOOL-BODY'));
    await setup.mockMouse.click(10, 9);
    await setup.waitForFrame(value => value.includes('Old tool') && !value.includes('OLD-TOOL-BODY'));
    setup.mockInput.pressEnter();
    await setup.waitForFrame(value => value.includes('OLD-TOOL-BODY'));
    setup.mockInput.pressKey('f');
    await setup.waitForFrame(value => value.includes('Following'));
    updated = true;
    setup.mockInput.pressKey('r');
    await setup.waitForFrame(value => value.includes('VISIBLE-TAIL') && !value.split('\n').slice(9).join('\n').includes('Old tool'));
    setup.mockInput.pressEnter();
    setup.mockInput.pressKey('HOME');
    await setup.waitForFrame(value => value.includes('Old tool') && value.includes('OLD-TOOL-BODY'));
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('history copy labels the frozen retained scan and reports terminal submission', async () => {
  const setup = await createTestRenderer({ width: 120, height: 40 });
  const demo = createDemoClient(), copied: string[] = [];
  setup.renderer.copyToClipboardOSC52 = value => { copied.push(value); return true; };
  const unmount = mountHub(setup.renderer, demo, 'demo', () => {});
  try {
    await setup.waitForFrame(value => value.includes('Agent Run') && value.includes('4 loaded / 4 reported'));
    setup.mockInput.pressKey('1');
    await setup.waitForFrame(value => value.includes('Inspect execution history'));
    setup.mockInput.pressKey('y');
    await setup.waitForFrame(value => value.includes('Retained scan copy requested'));
    assert.equal(copied.length, 1);
    assert.match(copied[0], /retained logical session history across executions/);
    assert.match(copied[0], /completeness is not guaranteed/);
    assert.match(copied[0], /Inspect the saved execution history/);
  } finally { unmount(); await demo.close(); await setup.dispose(); }
});

test('unavailable live sources remain unknown and never become demo data', async () => {
  const setup = await createTestRenderer({ width: 120, height: 40 });
  const client: ObservationClient = {
    async read(resource) { return { schema_version: 1, source: resource.split('.')[0]!, resource, observed_at_ms: Date.now(), outcome: 'unavailable', data: null, error: { code: 'offline', message: 'Source unavailable' } }; },
    async close() {},
  };
  const unmount = mountHub(setup.renderer, client, 'live', () => {});
  try {
    const frame = await setup.waitForFrame(value => value.includes('Source unavailable') && value.includes('Unknown'));
    assert.match(frame, /LIVE READ-ONLY/);
    assert.doesNotMatch(frame, /DEMO DATA|Synthetic review pool/);
  } finally { unmount(); await client.close(); await setup.dispose(); }
});
