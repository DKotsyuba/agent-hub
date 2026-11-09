/** Exercises the Pool `inventory_snapshot_v1` consumer against synthetic producer-shaped pages. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { ReadResponse } from '../src/api.ts';
import { inventorySnapshotPage, inventoryTotalsLines, readInventoryTotals, walkInventory } from '../src/pool-inventory.ts';
import type { InventoryRequest } from '../src/pool-inventory.ts';

type Json = Record<string, any>;
const fixture = JSON.parse(readFileSync(new URL('./fixtures/pool-inventory-snapshot-v1.json', import.meta.url), 'utf8')) as { pages: Json[] };
const first = (): Json => structuredClone(fixture.pages[0]), second = (): Json => structuredClone(fixture.pages[1]);
const request = (overrides: Partial<InventoryRequest> = {}): InventoryRequest => ({ filter: 'all', limit: 1, cursor: null, ...overrides });

/** Wraps a producer envelope in the native read response the observer returns. */
function ok(data: unknown): ReadResponse {
  return { schema_version: 1, source: 'pool', resource: 'pool.inventory_snapshot', observed_at_ms: 1, outcome: 'ok', data, error: null };
}
/** A fixed safe failure, as the observer reports a producer `stale` or unavailable error. */
function failed(outcome: ReadResponse['outcome'] = 'unavailable'): ReadResponse {
  return { schema_version: 1, source: 'pool', resource: 'pool.inventory_snapshot', observed_at_ms: 1, outcome, data: null, error: { code: 'source_error', message: 'Source returned a structured read error.' } };
}

test('the first page keeps exact decimal totals and never derives Open or Completed', () => {
  const page = inventorySnapshotPage(first(), request());
  assert.deepEqual(page.totals, { total: '2', closed: '1', unknown: '2', open: null, completed: null });
  assert.equal(page.source.revision, '42');
  assert.equal(page.rows.length, 1);
  assert.equal(page.next?.after, 'pool-a');
  const lines = inventoryTotalsLines(page);
  assert.match(lines[0], /r42 · 2 retained · 1 closed/);
  assert.match(lines[1], /Open \/ Completed: unavailable/);
  assert.doesNotMatch(lines.join('\n'), /Completed [0-9]/);
});

test('totals beyond the JavaScript safe integer range stay exact strings', () => {
  const body = first(); body.data.totals = { total: '18446744073709551615', closed: '9007199254740993', unknown: '18446744073709551615', open: null, completed: null };
  assert.equal(inventorySnapshotPage(body, request()).totals.closed, '9007199254740993');
  for (const bad of ['18446744073709551616', '01', '1.0', '-1', '', 1]) { const copy = first(); copy.data.totals.total = bad; assert.throws(() => inventorySnapshotPage(copy, request()), `total ${String(bad)}`); }
});

test('a future ledger is shown only as a source claim and must add up', () => {
  const body = first(); body.data.totals = { total: '5', closed: '1', unknown: '1', open: '3', completed: '1' };
  const lines = inventoryTotalsLines(inventorySnapshotPage(body, request()));
  assert.match(lines[1], /Open 3 · Completed 1 · 1 unclassified \(source ledger\)/);
  for (const totals of [{ total: '5', closed: '1', unknown: '1', open: '3', completed: '2' }, { total: '5', closed: '1', unknown: '5', open: '3', completed: null }, { total: '5', closed: '1', unknown: '4', open: null, completed: null }, { total: '1', closed: '2', unknown: '1', open: null, completed: null }]) {
    const copy = first(); copy.data.totals = totals;
    assert.throws(() => inventorySnapshotPage(copy, request()), JSON.stringify(totals));
  }
});

test('closed is never counted as completion', () => {
  const body = first(); body.data.totals = { total: '2', closed: '2', unknown: '2', open: null, completed: null };
  const lines = inventoryTotalsLines(inventorySnapshotPage(body, request())).join('\n');
  assert.match(lines, /2 closed/);
  assert.match(lines, /Closed is not completion/);
});

test('malformed envelopes, rows and cursors are rejected', () => {
  const mutations: [string, (body: Json) => void][] = [
    ['kind', body => { body.kind = 'pool_page'; }],
    ['error branch', body => { body.error = { code: 'stale' }; }],
    ['source id', body => { body.data.source.store_id = ''; }],
    ['revision', body => { body.data.source.revision = 42; }],
    ['coverage', body => { delete body.data.coverage; }],
    ['returned', body => { body.data.returned = 2; }],
    ['empty continued page', body => { body.data.pools = []; body.data.returned = 0; }],
    ['over limit', body => { body.data.pools.push(structuredClone(body.data.pools[0])); body.data.pools[1].pool.pool_id = 'pool-b'; body.data.returned = 2; }],
    ['row shape', body => { delete body.data.pools[0].roster; }],
    ['pool id', body => { body.data.pools[0].pool.pool_id = ''; }],
    ['cursor missing', body => { body.data.next_cursor = null; }],
    ['cursor version', body => { body.data.next_cursor.version = 2; }],
    ['cursor source', body => { body.data.next_cursor.source.revision = '43'; }],
    ['cursor filter', body => { body.data.next_cursor.filter = 'closed'; }],
    ['cursor limit', body => { body.data.next_cursor.limit = 2; }],
    ['cursor boundary', body => { body.data.next_cursor.after = 'other'; }],
    ['observed time', body => { body.data.observed_at_unix_ms = '1'; }],
  ];
  for (const [name, mutate] of mutations) { const body = first(); mutate(body); assert.throws(() => inventorySnapshotPage(body, request()), name); }
  const last = second(); last.data.next_cursor = first().data.next_cursor;
  assert.throws(() => inventorySnapshotPage(last, request({ cursor: first().data.next_cursor })), 'terminal page with a cursor');
});

test('filters, order and the request fence are checked on continuation pages', () => {
  const cursor = first().data.next_cursor;
  assert.equal(inventorySnapshotPage(second(), request({ cursor })).next, null);
  const changed = second(); changed.data.source.revision = '43';
  assert.throws(() => inventorySnapshotPage(changed, request({ cursor })), 'changed revision');
  const backwards = second(); backwards.data.pools[0].pool.pool_id = 'pool-0';
  assert.throws(() => inventorySnapshotPage(backwards, request({ cursor })), 'row not after boundary');
  const unfiltered = first(); unfiltered.data.pools[0].pool.closed = true;
  assert.throws(() => inventorySnapshotPage(unfiltered, request({ filter: 'not_closed' })), 'closed row in not_closed page');
  for (const bad of [{ limit: 0 }, { limit: 11 }, { limit: 1.5 }, { filter: 'open' as 'all' }]) assert.throws(() => inventorySnapshotPage(first(), request(bad)), JSON.stringify(bad));
});

test('a complete walk follows the producer cursor under one fence and counts rows', async () => {
  const sent: Json[] = [];
  const walk = await walkInventory(async params => { sent.push(structuredClone(params)); return ok(params.cursor ? second() : first()); }, { filter: 'all', limit: 1, maxPages: 5 });
  assert.equal(walk.state, 'ok');
  if (walk.state !== 'ok') return;
  assert.deepEqual(walk.rows.map(row => (row.pool as Json).pool_id), ['pool-a', 'pool-b']);
  assert.equal(walk.pages, 2);
  assert.deepEqual(sent[0], { filter: 'all', limit: 1 });
  assert.deepEqual(sent[1], { filter: 'all', limit: 1, cursor: first().data.next_cursor });
});

/** Rebinds a fixture page and its continuation to another source revision. */
function atRevision(body: Json, revision: string): Json {
  body.data.source.revision = revision;
  if (body.data.next_cursor) body.data.next_cursor.source.revision = revision;
  return body;
}

test('a changed fence restarts at the first page and never merges snapshots', async () => {
  const sent: Json[] = [];
  const walk = await walkInventory(async params => {
    sent.push(structuredClone(params));
    if (sent.length === 1) return ok(first());
    if (sent.length === 2) return ok(atRevision(second(), '43'));
    return ok(atRevision(params.cursor ? second() : first(), '43'));
  }, { filter: 'all', limit: 1, maxPages: 5 });
  assert.equal(walk.state, 'ok');
  assert.equal(sent.length, 4);
  assert.equal(sent[2].cursor, undefined, 'the restart begins at the first page');
  if (walk.state === 'ok') { assert.equal(walk.page.source.revision, '43'); assert.deepEqual(walk.rows.map(row => (row.pool as Json).pool_id), ['pool-a', 'pool-b']); }
});

test('a failed continuation page, such as a stale cursor, restarts instead of reusing earlier rows', async () => {
  let calls = 0;
  const walk = await walkInventory(async params => {
    calls++;
    if (calls === 2) return failed('unavailable');
    return ok(params.cursor ? second() : first());
  }, { filter: 'all', limit: 1, maxPages: 5 });
  assert.equal(walk.state, 'ok');
  assert.equal(calls, 4);
});

test('a producer stale error reaches the walk as its own reason, not a generic source error', async () => {
  const stale = (): ReadResponse => ({ ...failed('unavailable'), error: { code: 'stale', message: 'Source snapshot changed; read again from the first page.' } });
  assert.deepEqual(await walkInventory(async () => stale(), { filter: 'all', limit: 1, maxPages: 2, restarts: 0 }), { state: 'unavailable', reason: 'source_stale' });
  let calls = 0;
  const recovered = await walkInventory(async params => { calls++; return calls === 2 ? stale() : ok(params.cursor ? second() : first()); }, { filter: 'all', limit: 1, maxPages: 5 });
  assert.equal(recovered.state, 'ok', 'a stale continuation restarts at the first page');
  assert.deepEqual(await walkInventory(async () => failed('unavailable'), { filter: 'all', limit: 1, maxPages: 2, restarts: 0 }), { state: 'unavailable', reason: 'source_unavailable' });
});

test('totals that change between pages become unavailable after bounded restarts', async () => {
  let calls = 0;
  const walk = await walkInventory(async params => {
    calls++;
    if (!params.cursor) return ok(first());
    const body = second(); body.data.totals = { total: '3', closed: '1', unknown: '3', open: null, completed: null }; return ok(body);
  }, { filter: 'all', limit: 1, maxPages: 5, restarts: 1 });
  assert.deepEqual(walk, { state: 'unavailable', reason: 'inventory_fence_changed' });
  assert.equal(calls, 4);
});

test('a row count that disagrees with exact totals is unavailable, not complete', async () => {
  const walk = await walkInventory(async params => { const body = params.cursor ? second() : first(); body.data.totals = { total: '3', closed: '1', unknown: '3', open: null, completed: null }; return ok(body); }, { filter: 'all', limit: 1, maxPages: 5, restarts: 0 });
  assert.deepEqual(walk, { state: 'unavailable', reason: 'inventory_row_count' });
});

test('a page budget gives partial rows with exact totals and no completeness claim', async () => {
  const walk = await walkInventory(async () => ok(first()), { filter: 'all', limit: 1, maxPages: 1 });
  assert.equal(walk.state, 'partial');
  if (walk.state === 'partial') { assert.equal(walk.rows.length, 1); assert.equal(walk.page.totals.total, '2'); assert.equal(walk.reason, 'page_budget'); }
});

test('source failures, malformed pages and obsolete walks publish nothing', async () => {
  assert.deepEqual(await walkInventory(async () => failed('incompatible'), { filter: 'all', limit: 1, maxPages: 2, restarts: 0 }), { state: 'unavailable', reason: 'source_incompatible' });
  assert.deepEqual(await walkInventory(async () => ok({ nonsense: true }), { filter: 'all', limit: 1, maxPages: 2, restarts: 0 }), { state: 'unavailable', reason: 'inventory_invalid' });
  assert.deepEqual(await walkInventory(async () => ok(first()), { filter: 'all', limit: 1, maxPages: 2, current: () => false }), { state: 'unavailable', reason: 'obsolete' });
  const duplicate = await walkInventory(async () => ok(first()), { filter: 'all', limit: 1, maxPages: 5, restarts: 0 });
  assert.equal(duplicate.state, 'unavailable', 'a repeated boundary is a cycle, not a snapshot');
});

test('the totals read asks the observer for one row of the unfiltered inventory', async () => {
  const seen: [string, Json][] = [];
  const walk = await readInventoryTotals(async (resource, params) => { seen.push([resource, params]); return ok(first()); });
  assert.deepEqual(seen, [['pool.inventory_snapshot', { filter: 'all', limit: 1 }]]);
  assert.equal(walk.state, 'partial');
  if (walk.state === 'partial') assert.equal(walk.page.totals.total, '2');
});
