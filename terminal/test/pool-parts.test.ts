/** Preserves multi-part Pool messages and refuses incomplete journal exports. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestRenderer } from '@opentui/core/testing';
import { createDemoClient } from '../src/demo.ts';
import { mountHub } from '../src/hub.ts';
import { groupPoolEvents } from '../src/pool.ts';
import { exportHistory } from '../src/export.ts';
import type { ObservationClient } from '../src/api.ts';

const first = 9007199254740993n;
/** Builds source-shaped parts with lossless event identifiers. */
function parts() {
  return ['first ', 'middle ', 'last'].map((body, index) => ({ event_id: Number(first + BigInt(index)), event_id_exact: String(first + BigInt(index)), revision: 7, kind: index === 0 ? 'message' : 'message_part', author: { kind: 'member', member_id: 'm1' }, body, recipient: null, message_event_id: String(first), part_index: index + 1, part_count: 3 }));
}

test('message parts join only with matching source identity, metadata and complete boundaries', () => {
  const events = parts(), full = groupPoolEvents(events);
  assert.equal(full.length, 1);
  assert.equal(full[0].complete, true);
  assert.equal(full[0].parts.map(part => part.body).join(''), 'first middle last');
  assert.equal(groupPoolEvents(events.slice(1))[0].complete, false);
  assert.equal(groupPoolEvents(events.slice(0, 2))[0].complete, false);
  const changed = groupPoolEvents([events[0], { ...events[1], author: { kind: 'member', member_id: 'other' } }, events[2]]);
  assert.ok(changed.every(group => !group.complete));
});

test('replacement cancellation remains visible as a separate journal event', async () => {
  const setup = await createTestRenderer({ width: 120, height: 40 }), demo = createDemoClient();
  const client: ObservationClient = {
    async read(resource, params = {}, signal) {
      const response = await demo.read(resource, params, signal);
      if (resource !== 'pool.get' || params.section !== 'history' || !params.direction || !response.data) return response;
      const outer = response.data as { data: { view: { events: Record<string, unknown>[] } } };
      const events = outer.data.view.events.map(event => ({ ...event, kind: 'replacement_cancelled', body: 'Replacement cancelled before Run admission.' }));
      return { ...response, data: { ...outer, data: { ...outer.data, view: { ...outer.data.view, events } } } };
    },
    close: () => demo.close(),
  };
  const unmount = mountHub(setup.renderer, client, 'demo', () => {}, undefined, { pool: 'demo-pool' });
  try {
    await setup.waitForFrame(value => value.includes('[Members]'));
    setup.mockInput.pressArrow('right');
    const frame = await setup.waitForFrame(value => value.includes('replacement_cancelled') && value.includes('Replacement cancelled before Run admission.'));
    assert.match(frame, /replacement_cancelled/);
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

for (const incomplete of [false, true]) {
  test(`journal copy ${incomplete ? 'refuses missing parts' : 'joins parts across source pages'}`, async () => {
    const all = parts().filter(part => !incomplete || part.part_index !== 2), watermark = all.at(-1)!.event_id_exact;
    const client: ObservationClient = {
      async read(resource, params = {}) {
        if (resource === 'pool.identity') return { schema_version: 1, source: 'pool', resource, observed_at_ms: Date.now(), outcome: 'ok', error: null, data: { schema_version: 1, kind: 'identity', data: { capabilities: ['history_window_v1', 'message_parts_v1'] } } };
        assert.equal(resource, 'pool.get');
        const backward = params.direction === 'backward', after = String(params.after ?? '0');
        const eligible = all.filter(part => BigInt(part.event_id_exact) > BigInt(after));
        const rows = backward ? all.slice(-2) : eligible.slice(0, 2), more = backward ? all.length > rows.length : eligible.length > rows.length;
        const cursor = rows.length ? backward ? rows[0].event_id_exact : rows.at(-1)!.event_id_exact : after;
        return { schema_version: 1, source: 'pool', resource, observed_at_ms: Date.now(), outcome: 'ok', error: null, data: { schema_version: 1, kind: 'pool_detail', data: { section: 'history', cursor, history_watermark: watermark, has_more: more, returned: rows.length, source_timestamp: null, view: { section: 'history', pool: { pool_id: 'fixture' }, events: rows, has_more: more } } } };
      },
      async close() {},
    };
    if (incomplete) await assert.rejects(exportHistory(client, { kind: 'pool', id: 'fixture' }), /incomplete or inconsistent/);
    else { const copy = await exportHistory(client, { kind: 'pool', id: 'fixture' }); assert.match(copy, /first middle last/); assert.doesNotMatch(copy, /message_part/); }
  });
}

for (const incomplete of [false, true]) {
  test(`pool history ${incomplete ? 'marks a missing first part' : 'joins parts loaded across pages'}`, async () => {
    const setup = await createTestRenderer({ width: 120, height: 40 }), demo = createDemoClient();
    const all = parts().filter(part => !incomplete || part.part_index !== 1), watermark = all.at(-1)!.event_id_exact;
    const client: ObservationClient = {
      async read(resource, params = {}, signal) {
        if (resource !== 'pool.get' || params.section !== 'history' || !params.direction) return demo.read(resource, params, signal);
        const base = await demo.read(resource, { pool_id: 'demo-pool', section: 'members', after: 0 }, signal), outer = base.data as { data: Record<string, unknown> }, data = outer.data, view = data.view as Record<string, unknown>;
        const backward = params.direction === 'backward', before = params.before == null ? null : String(params.before), after = String(params.after ?? '0');
        const eligible = all.filter(part => backward ? before === null || BigInt(part.event_id_exact) < BigInt(before) : BigInt(part.event_id_exact) > BigInt(after));
        const rows = backward ? eligible.slice(-2) : eligible.slice(0, 2), more = eligible.length > rows.length;
        const cursor = rows.length ? backward ? rows[0].event_id_exact : rows.at(-1)!.event_id_exact : backward ? '0' : after;
        return { ...base, data: { ...outer, data: { ...data, section: 'history', bindings: undefined, cursor, history_watermark: watermark, has_more: more, returned: rows.length, view: { ...view, section: 'history', members: [], events: rows, next_after: Number(cursor), has_more: more } } } };
      },
      close: () => demo.close(),
    };
    const unmount = mountHub(setup.renderer, client, 'demo', () => {}, undefined, { pool: 'demo-pool' });
    try {
      await setup.waitForFrame(value => value.includes('[Members]'));
      setup.mockInput.pressArrow('right');
      const frame = await setup.waitForFrame(value => incomplete ? value.includes('incomplete message') && value.includes('middle last') : value.includes('first middle last'));
      if (!incomplete) assert.doesNotMatch(frame, /incomplete message|message_part/);
    } finally { unmount(); await client.close(); await setup.dispose(); }
  });
}
