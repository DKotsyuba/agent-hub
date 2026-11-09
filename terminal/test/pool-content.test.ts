/** Exercises revision-fenced UTF-8 content pages without contacting live Pool. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestRenderer } from '@opentui/core/testing';
import { createDemoClient } from '../src/demo.ts';
import { mountHub } from '../src/hub.ts';
import type { ObservationClient } from '../src/api.ts';

/** Provides two content pages and optional failure or delayed continuation. */
function contentSource() {
  const demo = createDemoClient(), requests: Record<string, unknown>[] = [];
  const controls = { fail: false, hold: false, cancelled: false };
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const chunks = ['FIRST-ЖЖЖ-', 'SECOND-Ж-END'], bytes = (value: string) => new TextEncoder().encode(value).length;
  const client: ObservationClient = {
    async read(resource, params = {}, signal) {
      if (resource === 'pool.identity') {
        const base = await demo.read(resource, params, signal), outer = base.data as { data: Record<string, unknown> };
        return { ...base, data: { ...outer, data: { ...outer.data, capabilities: ['identity', 'list', 'get', 'history_window_v1', 'content_pages_v1'] } } };
      }
      if (resource === 'pool.get' && params.section === 'content') {
        requests.push({ ...params });
        const offset = Number(params.after ?? 0);
        if (offset > 0 && controls.hold) {
          await Promise.race([gate, new Promise<void>(resolve => { const abort = () => { controls.cancelled = true; resolve(); }; if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true }); })]);
        }
        if (offset > 0 && controls.fail) return { schema_version: 1, source: 'pool', resource, observed_at_ms: Date.now(), outcome: 'unavailable', data: null, error: { code: 'stale', message: 'unavailable' } };
        const base = await demo.read(resource, { pool_id: 'demo-pool', section: 'members', after: 0 }, signal), outer = base.data as { data: Record<string, unknown> }, data = outer.data, view = data.view as Record<string, unknown>;
        const text = offset === 0 ? chunks[0] : chunks[1], next = offset + bytes(text), total = bytes(chunks.join('')), more = next < total;
        return { ...base, data: { ...outer, data: { ...data, section: 'content', bindings: undefined, cursor: String(next), returned: 1, has_more: more, view: { ...view, section: 'content', members: [], next_after: next, has_more: more, content: { field: params.field, offset, total_bytes: total, text } } } } };
      }
      if (resource === 'pool.get' && params.section === 'proposal') {
        const base = await demo.read(resource, params, signal), outer = base.data as { data: Record<string, unknown> }, data = outer.data, view = data.view as Record<string, unknown>, pool = view.pool as Record<string, unknown>, proposal = pool.proposal as Record<string, unknown>;
        return { ...base, data: { ...outer, data: { ...data, view: { ...view, pool: { ...pool, proposal: { ...proposal, snapshot_bytes: bytes(chunks.join('')) } } } } } };
      }
      return demo.read(resource, params, signal);
    },
    close: () => demo.close(),
  };
  return { client, requests, controls, release };
}

test('full purpose and proposal snapshot concatenate fenced UTF-8 pages', async () => {
  const setup = await createTestRenderer({ width: 160, height: 40 }), fixture = contentSource();
  const unmount = mountHub(setup.renderer, fixture.client, 'demo', () => {}, undefined, { pool: 'demo-pool' });
  try {
    await setup.waitForFrame(value => value.includes('[Members]'));
    setup.mockInput.pressKey('e');
    await setup.waitForFrame(value => value.includes('Full purpose') && value.includes('FIRST-ЖЖЖ-SECOND-Ж-END'));
    assert.equal(fixture.requests[1]?.expected_revision, 1);
    assert.equal(fixture.requests[1]?.after, String(new TextEncoder().encode('FIRST-ЖЖЖ-').length));
    setup.mockInput.pressEscape(); await new Promise(resolve => setTimeout(resolve, 25));
    await setup.waitForFrame(value => value.includes('[Members]') && value.includes('Example reviewer'));
    setup.mockInput.pressKey('d'); await setup.waitForFrame(value => value.includes('[s] open'));
    setup.mockInput.pressKey('s');
    await setup.waitForFrame(value => value.includes('Full proposal snapshot') && value.includes('SECOND-Ж-END'));
    assert.ok(fixture.requests.some(request => request.field === 'snapshot' && request.proposal_id === 'demo-proposal'));
  } finally { fixture.release(); unmount(); await fixture.client.close(); await setup.dispose(); }
});

test('failed content continuation withholds partial text and can be closed', async () => {
  const setup = await createTestRenderer({ width: 120, height: 40 }), fixture = contentSource(); fixture.controls.fail = true;
  const unmount = mountHub(setup.renderer, fixture.client, 'demo', () => {}, undefined, { pool: 'demo-pool' });
  try {
    await setup.waitForFrame(value => value.includes('[Members]'));
    setup.mockInput.pressKey('e');
    const frame = await setup.waitForFrame(value => value.includes('Full content is unavailable or changed'));
    assert.doesNotMatch(frame, /FIRST-ЖЖЖ/);
    setup.mockInput.pressEscape(); await new Promise(resolve => setTimeout(resolve, 25));
    await setup.waitForFrame(value => value.includes('[Members]') && value.includes('Example reviewer'));
  } finally { fixture.release(); unmount(); await fixture.client.close(); await setup.dispose(); }
});

test('closing long content cancels its pending source read', async () => {
  const setup = await createTestRenderer({ width: 120, height: 40 }), fixture = contentSource(); fixture.controls.hold = true;
  const unmount = mountHub(setup.renderer, fixture.client, 'demo', () => {}, undefined, { pool: 'demo-pool' });
  try {
    await setup.waitForFrame(value => value.includes('[Members]'));
    setup.mockInput.pressKey('e');
    await setup.waitFor(() => fixture.requests.length === 2);
    setup.mockInput.pressEscape(); await new Promise(resolve => setTimeout(resolve, 25));
    await setup.waitFor(() => fixture.controls.cancelled);
    fixture.release();
    const frame = await setup.waitForFrame(value => value.includes('[Members]') && value.includes('Example reviewer'));
    assert.doesNotMatch(frame, /Full purpose/);
  } finally { fixture.release(); unmount(); await fixture.client.close(); await setup.dispose(); }
});
