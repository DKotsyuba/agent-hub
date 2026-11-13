/** Frozen Pool completion record: ID from the pool_completed event, digest-bound pages, verified content. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createTestRenderer } from '@opentui/core/testing';
import { createDemoClient } from '../src/demo.ts';
import { mountHub } from '../src/hub.ts';
import { completionContent, completionIdFromEvents, completionPage } from '../src/completion.ts';
import type { ObservationClient, ReadResponse } from '../src/api.ts';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const goal = 'Ship the hub ✓', result = 'Done.';

/** Builds one completion page for a section. */
function page(params: Record<string, unknown>, digest = 'd1'): Record<string, unknown> {
  const section = params.section as string;
  const header = section === 'header' ? { pool_store_id: 'store', commit_sequence: 1, source_revision: 9, proposal_id: 'prop-1', leader_id: 'leader', content: [{ field: 'goal', present: true, length: Buffer.byteLength(goal), sha256: sha(goal) }, { field: 'snapshot', present: false, length: 0, sha256: null }], roster_entries: 1, ballots: 1, coverage: 'fixed' } : null;
  const items = section === 'content' ? params.after ? [{ item: 'content', field: 'result', offset: 0, total_bytes: 5, sha256: sha(result), text: result }] : [{ item: 'content', field: 'goal', offset: 0, total_bytes: Buffer.byteLength(goal), sha256: sha(goal), text: goal }]
    : section === 'roster' ? [{ item: 'member', member_id: 'm1', role: 'reviewer' }] : section === 'ballots' ? [{ item: 'ballot', member_id: 'm1', choice: 'ready' }] : [];
  const more = section === 'content' && !params.after;
  return { schema_version: 1, kind: 'completion_page', data: { pool_id: params.pool_id, completion_id: params.completion_id, record_version: 1, record_digest: digest, integrity_algorithm: 'sha256', section, header, items, returned: items.length, has_more: more, next_cursor: more ? { version: 1, completion_id: params.completion_id, record_digest: digest, section, position: 'p1' } : null, observed_at_unix_ms: 1 } };
}

test('completion helpers bind pages and verify content digests', () => {
  assert.equal(completionIdFromEvents([{ kind: 'message', body: 'Completion fake.' }, { kind: 'pool_completed', body: 'Pool completed. Completion cmp-1. Goal, roster ... frozen.' }]), 'cmp-1');
  assert.equal(completionIdFromEvents([{ kind: 'pool_completed', body: 'Pool completed. Completion a/b. x' }]), null);
  const request = { pool_id: 'p', completion_id: 'c', section: 'header' as const };
  assert.equal(completionPage(page(request), request, null).recordDigest, 'd1');
  assert.throws(() => completionPage(page(request, 'other'), request, { digest: 'd1', version: 1 }), /completion_changed/);
  assert.throws(() => completionPage(page({ ...request, completion_id: 'x' }), request, null), /completion_binding/);
  assert.deepEqual(completionContent([{ item: 'content', field: 'goal', offset: 0, total_bytes: 3, sha256: sha('abc'), text: 'abc' }]), [{ field: 'goal', text: 'abc', verified: true }]);
  assert.equal(completionContent([{ item: 'content', field: 'goal', offset: 0, total_bytes: 3, sha256: sha('abd'), text: 'abc' }])[0]!.verified, false);
});

test('pool view opens the frozen completion record with l', async () => {
  const demo = createDemoClient(), requests: Record<string, unknown>[] = [];
  const client: ObservationClient = {
    async read(resource, params = {}, signal) {
      const base = await demo.read(resource === 'pool.completion_get' ? 'pool.identity' : resource, params, signal);
      if (resource === 'pool.identity') { const outer = base.data as { data: Record<string, unknown> }; return { ...base, data: { ...outer, data: { ...outer.data, capabilities: ['identity', 'list', 'get', 'history_window_v1', 'completion_record_v1', 'observer_socket_v1'] } } }; }
      if (resource === 'pool.completion_get') { requests.push(params); return { ...base, resource, outcome: 'ok', data: page(params), error: null } as ReadResponse; }
      if (resource === 'pool.get' && params.section === 'history' && params.direction === 'backward') {
        const outer = base.data as { data: Record<string, any> }, data = outer.data;
        const events = [...data.view.events, { event_id: 2, event_id_exact: '2', revision: 2, kind: 'pool_completed', author: { kind: 'service' }, body: 'Pool completed. Completion cmp-7. Goal, roster, assignments, proposals and votes are now frozen.', recipient: null }];
        return { ...base, data: { ...outer, data: { ...data, history_watermark: '2', returned: events.length, view: { ...data.view, events } } } };
      }
      if (resource === 'pool.get') assert.notEqual(params.include_bindings, true, 'socket route never asks for bindings');
      return base;
    },
    close: () => demo.close(),
  };
  const setup = await createTestRenderer({ width: 160, height: 50 });
  const unmount = mountHub(setup.renderer, client, 'demo', () => {}, undefined, { pool: 'demo-pool' });
  try {
    await setup.waitForFrame(value => value.includes('[Members]'));
    setup.mockInput.pressKey('l');
    const frame = await setup.waitForFrame(value => value.includes('Completion record (frozen)') && value.includes('Ballots (1)'));
    assert.match(frame, /completion cmp-7/);
    assert.match(frame, /Goal \(sha256 verified\)/);
    assert.match(frame, /Ship the hub ✓/);
    assert.match(frame, /Result \(sha256 verified\)/);
    assert.match(frame, /snapshot: absent/);
    assert.match(frame, /Roster \(1\)/);
    assert.ok(requests.every(request => request.completion_id === 'cmp-7' && request.limit === 10));
    assert.deepEqual(requests.map(request => request.section), ['header', 'content', 'content', 'roster', 'ballots', 'run_facts', 'notice']);
    setup.mockInput.pressEscape();
    await setup.waitForFrame(value => value.includes('[Members]'));
  } finally { unmount(); await client.close(); await setup.dispose(); }
});
