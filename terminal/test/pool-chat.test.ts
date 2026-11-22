/** Pool chat v1: pool kind, seats with Run agents and the agreement record, with legacy fallbacks. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createTestRenderer } from '@opentui/core/testing';
import { createDemoClient } from '../src/demo.ts';
import { mountHub } from '../src/hub.ts';
import { agreementRecord, agreementText, completionIdFromEvents, completionPage } from '../src/completion.ts';
import { poolFacts, poolKindLabel, poolSeat } from '../src/pool-chat.ts';
import { groupPools } from '../src/pool-list.ts';
import { inventorySnapshotPage } from '../src/pool-inventory.ts';
import { poolSection } from '../src/pool.ts';
import type { ObservationClient, ReadResponse } from '../src/api.ts';

type Json = Record<string, any>;
const fixture = JSON.parse(readFileSync(new URL('./fixtures/pool-chat-v1.json', import.meta.url), 'utf8')) as Json;
const clone = <T>(value: T): T => structuredClone(value);

test('pool facts are optional, closed, labeled and merged across the row and its pool object', () => {
  assert.deepEqual(poolFacts({}), { kind: null, completionId: undefined });
  assert.deepEqual(poolFacts({ kind: 'chat', completion_id: 'agr-7' }), { kind: 'chat', completionId: 'agr-7' });
  assert.deepEqual(poolFacts({ kind: 'managed', completion_id: null }), { kind: 'managed', completionId: null });
  assert.deepEqual(poolFacts({ kind: 'chat' }, { completion_id: 'c-1' }), { kind: 'chat', completionId: 'c-1' });
  assert.deepEqual(poolFacts({ kind: 'chat' }, { kind: 'chat' }), { kind: 'chat', completionId: undefined });
  for (const bad of [{ kind: 'other' }, { kind: null }, { completion_id: 7 }, { completion_id: '' }, { completion_id: 'a/b' }]) assert.throws(() => poolFacts(bad), /pool_(kind|completion_id)/, JSON.stringify(bad));
  assert.throws(() => poolFacts({ kind: 'chat' }, { kind: 'managed' }), /pool_kind/);
  assert.throws(() => poolFacts({ completion_id: 'a' }, { completion_id: null }), /pool_completion_id/);
  assert.equal(poolKindLabel('chat'), 'chat pool');
  assert.equal(poolKindLabel('managed'), 'managed pool (legacy)');
  assert.equal(poolKindLabel(null), null);
});

test('pool list validates row facts and keeps closed pools out of the navigation order', () => {
  assert.throws(() => groupPools([{ ...fixture.pool_chat, kind: 'x' }], ''), /pool_kind/);
  const groups = groupPools([fixture.pool_chat, fixture.pool_managed], '', false);
  assert.deepEqual(groups.items, []);
  assert.equal(groups.finished.loaded, 2);
});

test('seat fields are all-or-nothing, typed and null only for an unadmitted agent', () => {
  assert.equal(poolSeat({ member_id: 'm', name: 'n', role: 'r', task: 't', state: 'active', runtime: 'unknown' }), null);
  assert.deepEqual(poolSeat(fixture.seats[0]), { seatId: 'm-seat-00', runAgentId: 'demo-inspect', profile: 'implement', admission: 'admitted', joined: true });
  assert.equal(poolSeat(fixture.seats[1])!.runAgentId, null);
  for (const patch of [{ admission: 'later' }, { joined: 'yes' }, { run_agent_id: '' }, { run_agent_id: 7 }, { seat_id: '' }, { profile: null }]) assert.throws(() => poolSeat({ ...fixture.seats[0], ...patch }), /pool_seat/, JSON.stringify(patch));
  const partial = clone(fixture.seats[0]); delete partial.run_agent_id;
  assert.throws(() => poolSeat(partial), /pool_seat/);
});

/** One pool_detail members page for the chat pool. */
function membersPage(seats: Json[], pool: Json = fixture.pool_chat.pool, facts: Json = { kind: 'chat', completion_id: 'agr-7' }): Json {
  return { schema_version: 1, kind: 'pool_detail', data: { ...facts, section: 'members', view: { section: 'members', pool: clone(pool), members: clone(seats), active: 1, pending: 1, events: [], deliveries: [], next_after: seats.length, has_more: false }, leader_id: 'pool-chat-v1-owner', decisions: [], cursor: String(seats.length), has_more: false, returned: seats.length, observed_at_unix_ms: 1, source_timestamp: null, coverage: 'fixed' } };
}

test('members pages validate seats and refuse them on a managed pool', () => {
  assert.ok(poolSection(membersPage(fixture.seats), 'pool-chat-1', 'members', 0, null));
  assert.throws(() => poolSection(membersPage(fixture.seats, fixture.pool_managed.pool, { kind: 'managed', completion_id: null }), 'pool-managed-1', 'members', 0, null), /pool_seat_kind/);
  const conflicting = membersPage(fixture.seats);
  conflicting.data.completion_id = 'other';
  conflicting.data.view.pool.completion_id = 'agr-7';
  assert.throws(() => poolSection(conflicting, 'pool-chat-1', 'members', 0, null), /pool_completion_id/);
  const bad = clone(fixture.seats); bad[0].admission = 'x';
  assert.throws(() => poolSection(membersPage(bad), 'pool-chat-1', 'members', 0, null), /pool_seat/);
  const legacy = [{ member_id: 'm', name: 'n', role: 'r', task: 't', state: 'active', runtime: 'unknown' }];
  assert.ok(poolSection(membersPage(legacy, fixture.pool_chat.pool, {}), 'pool-chat-1', 'members', 0, null));
});

test('inventory rows carry kind and seats and reject a managed pool with seats', () => {
  const snapshot = (row: Json): Json => ({ schema_version: 1, kind: 'inventory_snapshot', data: { source: { store_id: 's', read_epoch: 'e', revision: '5' }, totals: { total: '1', closed: '0', unknown: '0', open: '1', completed: '0' }, coverage: 'x', pools: [row], returned: 1, has_more: false, next_cursor: null, observed_at_unix_ms: 1 } });
  const row = { ...clone(fixture.pool_chat), roster: clone(fixture.seats) };
  assert.equal((inventorySnapshotPage(snapshot(row), { filter: 'all', limit: 1, cursor: null }).rows[0] as Json).roster.length, 2);
  const managed = { ...clone(fixture.pool_chat), roster: clone(fixture.seats) }; managed.kind = 'managed';
  assert.throws(() => inventorySnapshotPage(snapshot(managed), { filter: 'all', limit: 1, cursor: null }), /inventory_roster/);
  const older = clone(fixture.pool_chat); delete older.kind; delete older.completion_id; older.roster = [{ member_id: 'm', name: 'n', role: 'r', task: 't', state: 'active', runtime: 'unknown' }];
  assert.equal(inventorySnapshotPage(snapshot(older), { filter: 'all', limit: 1, cursor: null }).rows.length, 1);
});

test('agreement records bind to the request and are told apart from legacy completion pages', () => {
  const request = { pool_id: 'pool-chat-1', completion_id: 'agr-7' };
  const record = agreementRecord(clone(fixture.agreement), request)!;
  assert.equal(record.result, 'Ship it.\nAll checks pass.');
  assert.deepEqual(record.ballots.map(ballot => [ballot.seatId, ballot.agentId, ballot.voteEventId]), [['m-seat-00', 'demo-inspect', '27'], ['m-seat-01', 'demo-index', '30']]);
  const text = agreementText(record);
  assert.match(text, /agreement agr-7/);
  assert.match(text, /no digest/);
  assert.match(text, /seat m-seat-01 · ready · Run agent demo-index · vote event 30/);
  assert.throws(() => agreementRecord(clone(fixture.agreement), { ...request, completion_id: 'other' }), /agreement_binding/);
  assert.throws(() => agreementRecord(clone(fixture.agreement), { ...request, pool_id: 'other' }), /agreement_binding/);
  for (const patch of [{ version: 2 }, { event_id: 'x' }, { ballots: [] }, { revision: 0 }]) { const bad = clone(fixture.agreement); Object.assign(bad.data, patch); assert.throws(() => agreementRecord(bad, request), /agreement_/, JSON.stringify(patch)); }
  const duplicate = clone(fixture.agreement); duplicate.data.ballots.push(duplicate.data.ballots[0]);
  assert.throws(() => agreementRecord(duplicate, request), /agreement_ballot/);
  const legacy = { schema_version: 1, kind: 'completion_page', data: { pool_id: 'p', completion_id: 'c', record_version: 1, record_digest: 'd', integrity_algorithm: 'sha256', section: 'header', header: {}, items: [], returned: 0, has_more: false, next_cursor: null } };
  assert.equal(agreementRecord(legacy, { pool_id: 'p', completion_id: 'c' }), null);
  assert.equal(completionPage(legacy, { pool_id: 'p', completion_id: 'c', section: 'header' }, null).recordDigest, 'd');
});

test('the agreement ID comes from the new completion event and the legacy wording still works', () => {
  assert.equal(completionIdFromEvents([{ kind: 'pool_completed', body: 'Agreement agr-7 committed for proposal prop-3.' }]), 'agr-7');
  assert.equal(completionIdFromEvents([{ kind: 'pool_completed', body: 'Pool completed. Completion cmp-1. Goal frozen.' }]), 'cmp-1');
  assert.equal(completionIdFromEvents([{ kind: 'message', body: 'Agreement fake committed for proposal x.' }]), null);
  assert.equal(completionIdFromEvents([{ kind: 'pool_completed', body: 'Agreement a/b committed for proposal x.' }]), null);
});

const agentIds = { chat: 'pool-chat-1', managed: 'pool-managed-1' };

/** A demo client whose Pool answers with one open chat pool and one closed managed pool. */
function chatClient(options: { withKind?: boolean; withSeats?: boolean; withCompletionId?: boolean; completionId?: string | null; snapshot?: boolean } = {}): { client: ObservationClient; completionRequests: Json[]; historyScans: Json[] } {
  const withKind = options.withKind ?? true, withSeats = options.withSeats ?? true, withCompletionId = options.withCompletionId ?? true, demo = createDemoClient(), completionRequests: Json[] = [], historyScans: Json[] = [];
  const pool = (row: Json): Json => { const copy = clone(row); if (!withKind) delete copy.kind; if (!withCompletionId) delete copy.completion_id; else if (copy.kind === 'chat' && options.completionId !== undefined) copy.completion_id = options.completionId; return copy; };
  const facts: Json = { ...(withKind ? { kind: 'chat' } : {}), ...(withCompletionId ? { completion_id: options.completionId === undefined ? 'agr-7' : options.completionId } : {}) };
  const completedEvent = { event_id: 2, event_id_exact: '2', revision: 12, kind: 'pool_completed', author: { kind: 'service' }, body: 'Agreement agr-7 committed for proposal prop-3.', recipient: null };
  const client: ObservationClient = {
    async read(resource, params = {}, signal) {
      const base = await demo.read(resource === 'pool.completion_get' || resource === 'pool.inventory_snapshot' ? 'pool.identity' : resource, resource === 'pool.get' ? { ...params, pool_id: 'demo-pool' } : params, signal);
      const outer = base.data as Json;
      if (resource === 'pool.identity') return { ...base, data: { ...outer, data: { ...outer.data, capabilities: ['identity', 'list', 'get', 'history_window_v1', 'completion_record_v1', 'observer_socket_v1', ...(options.snapshot ? ['inventory_snapshot_v1'] : [])] } } };
      if (resource === 'pool.list') { const rows = [pool(fixture.pool_chat), pool(fixture.pool_managed)]; return { ...base, data: { ...outer, data: { ...outer.data, pools: rows, cursor: 'pool-managed-1', returned: 2 } } }; }
      if (resource === 'pool.inventory_snapshot') {
        const pools = [{ ...pool(fixture.pool_chat), roster: clone(fixture.seats) }, { ...pool(fixture.pool_managed), roster: [] }];
        pools[0].roster[0].notice_undeliverable = true;
        return { ...base, resource, data: { schema_version: 1, kind: 'inventory_snapshot', data: { source: { store_id: 's', read_epoch: 'e', revision: '9' }, totals: { total: '2', closed: '1', unknown: '0', open: '2', completed: '0' }, coverage: 'fixture', pools, returned: 2, has_more: false, next_cursor: null, observed_at_unix_ms: 1 } } };
      }
      if (resource === 'pool.completion_get') { completionRequests.push(params); return { ...base, resource, outcome: 'ok', data: clone(fixture.agreement), error: null } as ReadResponse; }
      if (resource === 'pool.get') {
        if (params.pool_id !== agentIds.chat) return { ...base, outcome: 'unavailable', data: null, error: { code: 'demo_pool_missing', message: 'x' } } as ReadResponse;
        const data = outer.data as Json, view = data.view as Json | null;
        const chat = fixture.pool_chat.pool;
        if (params.section === 'history' && params.direction === 'backward') {
          historyScans.push(params);
          const events = options.completionId === null ? view!.events : [...view!.events, completedEvent];
          const watermark = String(events.at(-1)?.event_id_exact ?? '0');
          return { ...base, data: { ...outer, data: { ...data, ...facts, history_watermark: watermark, cursor: String(events[0]?.event_id_exact ?? '0'), returned: events.length, view: { ...view, pool: chat, events } } } };
        }
        if (view) {
          const seats = params.section === 'members' && withSeats ? clone(fixture.seats) : view.members;
          return { ...base, data: { ...outer, data: { ...data, ...facts, view: { ...view, pool: { ...chat, proposal: view.pool.proposal }, members: seats, next_after: params.section === 'members' ? seats.length : view.next_after }, returned: params.section === 'members' ? seats.length : data.returned, cursor: params.section === 'members' ? String(seats.length) : data.cursor } } };
        }
      }
      return base;
    },
    close: () => demo.close(),
  };
  return { client, completionRequests, historyScans };
}

test('pool list tags the kind and keeps closed pools collapsed', async () => {
  const { client } = chatClient(), setup = await createTestRenderer({ width: 140, height: 40 });
  const unmount = mountHub(setup.renderer, client, 'demo', () => {});
  try {
    setup.mockInput.pressKey('2');
    const frame = await setup.waitForFrame(value => value.includes('▸ Finished  2'));
    assert.doesNotMatch(frame, /Chat review pool|Legacy managed pool/);
    setup.mockInput.pressKey('o');
    const shown = await setup.waitForFrame(value => value.includes('Legacy managed pool'));
    assert.match(shown, /Completed · chat pool/);
    assert.match(shown, /Closed · managed pool/);
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('chat seats show profile, admission, join state and Run agent, and open Sessions', async () => {
  const { client } = chatClient(), setup = await createTestRenderer({ width: 140, height: 50 });
  const unmount = mountHub(setup.renderer, client, 'demo', () => {}, undefined, { pool: agentIds.chat });
  try {
    const frame = await setup.waitForFrame(value => value.includes('Seats · ') && value.includes('m-seat-01'));
    assert.match(frame, /m-seat-00 · implement · active/);
    assert.match(frame, /Admission: admitted · Joined chat · Execution: unknown/);
    assert.match(frame, /Run agent: demo-inspect/);
    assert.match(frame, /m-seat-01 · review · pending/);
    assert.match(frame, /Admission: pending · Not joined/);
    assert.match(frame, /Run agent: none yet · admission pending/);
    assert.match(frame, /Kind: chat pool/);
    setup.mockInput.pressEnter();
    await setup.waitForFrame(value => value.includes('Inspect execution history') && value.includes('[History]'));
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('a pool without kind or seat fields keeps the previous member display', async () => {
  const { client } = chatClient({ withKind: false, withSeats: false }), setup = await createTestRenderer({ width: 140, height: 40 });
  const unmount = mountHub(setup.renderer, client, 'demo', () => {}, undefined, { pool: agentIds.chat });
  try {
    const frame = await setup.waitForFrame(value => value.includes('Members · ') && value.includes('Example reviewer'));
    assert.doesNotMatch(frame, /Seats ·|Admission:|chat pool/);
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('l opens the agreement record from the chat completion event and links each seat session', async () => {
  const { client, completionRequests, historyScans } = chatClient(), setup = await createTestRenderer({ width: 140, height: 60 });
  const unmount = mountHub(setup.renderer, client, 'demo', () => {}, undefined, { pool: agentIds.chat });
  try {
    await setup.waitForFrame(value => value.includes('Seats · '));
    setup.mockInput.pressKey('l');
    const frame = await setup.waitForFrame(value => value.includes('Agreement record (frozen)') && value.includes('Ballots (2)'));
    assert.match(frame, /agreement agr-7/);
    assert.match(frame, /Ship it\./);
    assert.match(frame, /no digest/);
    assert.match(frame, /seat m-seat-00 · ready · Run agent demo-inspect · vote event 27/);
    assert.match(frame, /Open Run session · seat m-seat-01/);
    assert.deepEqual(completionRequests.map(request => [request.completion_id, request.section]), [['agr-7', 'header']]);
    assert.equal(historyScans.length, 0, 'a reported completion_id needs no journal scan');
    const rows = frame.split('\n'), row = rows.findIndex(value => value.includes('Open Run session · seat m-seat-00'));
    await setup.mockMouse.click(rows[row]!.indexOf('Open Run session') + 1, row);
    await setup.waitForFrame(value => value.includes('Inspect execution history') && value.includes('[History]'));
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('without a reported completion_id the agreement ID is found from the journal event', async () => {
  const { client, completionRequests } = chatClient({ withCompletionId: false }), setup = await createTestRenderer({ width: 140, height: 60 });
  const unmount = mountHub(setup.renderer, client, 'demo', () => {}, undefined, { pool: agentIds.chat });
  try {
    await setup.waitForFrame(value => value.includes('Seats · '));
    setup.mockInput.pressKey('l');
    await setup.waitForFrame(value => value.includes('Agreement record (frozen)') && value.includes('Ballots (2)'));
    assert.deepEqual(completionRequests.map(request => request.completion_id), ['agr-7']);
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('an explicit null completion_id reports no record and reads nothing', async () => {
  const { client, completionRequests } = chatClient({ completionId: null }), setup = await createTestRenderer({ width: 140, height: 40 });
  const unmount = mountHub(setup.renderer, client, 'demo', () => {}, undefined, { pool: agentIds.chat });
  try {
    await setup.waitForFrame(value => value.includes('Seats · '));
    setup.mockInput.pressKey('l');
    const frame = await setup.waitForFrame(value => value.includes('no completion or agreement record yet'));
    assert.match(frame, /no completion or agreement record yet/);
    assert.equal(completionRequests.length, 0);
  } finally { unmount(); await client.close(); await setup.dispose(); }
});

test('a live chat spins, opens its history within the split and labels Run membership from inventory', async () => {
  const { client } = chatClient({ completionId: null, snapshot: true }), setup = await createTestRenderer({ width: 160, height: 40 });
  const unmount = mountHub(setup.renderer, client, 'demo', () => {});
  try {
    setup.mockInput.pressKey('2');
    const list = await setup.waitForFrame(frame => frame.includes('Chat review pool') && frame.includes('notice undeliverable'));
    assert.match(list, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Chat review pool/);
    assert.match(list, /chat pool · 2 seats/);
    assert.doesNotMatch(list, /Legacy managed pool/);
    setup.mockInput.pressEnter();
    const detail = await setup.waitForFrame(frame => frame.includes('[History]') && frame.includes('Synthetic discussion'));
    assert.match(detail, /Following/);
    assert.match(detail, /▸ Finished  1/);
    setup.mockInput.pressKey('1');
    await setup.waitForFrame(frame => frame.includes('Pool: Chat review pool'));
  } finally { unmount(); await client.close(); await setup.dispose(); }
});
