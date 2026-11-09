/** Focused offline check: node src/live/read-check.mjs. No native services, browsers or frameworks. */
import assert from 'node:assert/strict';
import { answerText, collectPages, longestWorktree, response, runPage, sha256, worktreePage, worktreeDetail, repositoryLabels, reportObserved, reportCompleted, decimalCursor, limitsData, modelsData, bridgeData, ideData, activeStatus, runStatuses, runAgent, attentionAgent, recentAnswers, nextObservation } from './protocol.ts';
import { read, readCurrent, selectMode, watch } from './native.ts';

/** Constructs a producer page with stable identities and an explicit revision. */
function page(start, end, next, revision = 7) { return { items: Array.from({ length: end - start }, (_, offset) => ({ id: 'a' + (start + offset) })), next, total: 221, complete: next === null, revision, observed: 100, coverage: {}, raw: {} }; }
/** Provides a controllable read completion, making obsolete-reply ordering deterministic. */
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
/** Advances only promise callbacks, without sleeps or native/background work. */
async function microtasks() { for (let index = 0; index < 8; index++) await Promise.resolve(); }
/** Builds a valid native response with an explicitly separate local receipt clock. */
function envelope(data) { return { schema_version: 1, source: 'run', resource: 'run.agents', observed_at_ms: 1_800_000_000_000, outcome: 'ok', data, error: null }; }

assert.equal(selectMode(true, '?demo=1', 'demo'), 'live');
assert.equal(selectMode(false, ''), 'unavailable');
assert.equal(selectMode(false, '?demo=1'), 'demo');
assert.equal(selectMode(false, '', 'demo'), 'demo');
assert.throws(() => response({ ...envelope({}), source: 'pool' }, 'run.agents'));
assert.throws(() => runPage({ items: [], complete: true, revision: 1 }));
assert.throws(() => worktreePage({ schema_version: 2, kind: 'worktree_page', data: {} }));
/** Actual Worktree probes live under data.probes, never flat display fields. */
const probe = { state: 'not_checked', value: null, code: null, reason: null };
const inspection = { schema_version: 1, kind: 'worktree_detail', data: { observed_at: 100, probes: { status: probe, integration: probe, processes: probe, submodules: probe, size: { state: 'incomplete', value: { bytes: 123456, quality: 'lower_bound' }, code: null, reason: 'budget' } } } };
assert.equal(worktreeDetail(inspection).probes.size.value.bytes, 123456);
assert.throws(() => worktreeDetail({ ...inspection, data: { status: probe, size: probe } }));
/** The producer's outer diagnostic timeout remains usable explicitly unavailable evidence. */
const ideUnavailable = { schema_version: 1, kind: 'ide_observation', data: { product: 'agent-ide', repository: { common_dir: '/repo/.git', source_path: '/repo' }, instances: [{ instance_id: 'unknown-generation', health: 'unavailable', runtime: 'unavailable', endpoint: 'unavailable', lock: 'unavailable', daemon_version: null }], checks: { availability: 'unavailable', snapshots: [], next_cursor: null } } };
assert.equal(ideData(ideUnavailable).instances[0].runtime, 'unavailable');
assert.throws(() => ideData({ ...ideUnavailable, data: { ...ideUnavailable.data, instances: [{ ...ideUnavailable.data.instances[0], runtime: 'unexpected' }] } }), /ide_instance/);

const result = await collectPages(page(0, 200, 200), 2, async offset => { assert.equal(offset, 200); return { ...page(199, 221, null), items: page(199, 221, null).items }; }, item => item.id, () => true);
assert.equal(result.items.length, 221);
assert.equal(result.complete, true);
assert.equal((await collectPages(page(0, 200, 200), 1, async () => assert.fail('must not read unloaded coverage'), item => item.id, () => true)).complete, false);
await assert.rejects(collectPages(page(0, 200, 200), 2, async () => page(200, 221, null, 8), item => item.id, () => true), /revision_changed/);

let generation = 1;
const gate = deferred();
const obsolete = collectPages(page(0, 200, 200), 2, async () => gate.promise, item => item.id, () => generation === 1);
generation = 2;
const current = await collectPages(page(0, 1, null, 8), 1, async () => assert.fail('not needed'), item => item.id, () => generation === 2);
gate.resolve(page(200, 221, null));
await assert.rejects(obsolete, /obsolete/);
assert.equal(current.revision, 8);
assert.equal(current.items.length, 1);
assert.equal(longestWorktree('/repo/deep/src', [{ key: 'a', path: '/repo', common: '/r/.git', branch: null, raw: {} }, { key: 'b', path: '/repo/deep', common: '/r/.git', branch: null, raw: {} }]).key, 'b');
assert.equal(longestWorktree('/repository', [{ key: 'a', path: '/repo', common: '/r/.git', branch: null, raw: {} }]), null);

const unicode = '🙂Код・你好\n'.repeat(18000);
const digest = await sha256(unicode);
const total = new TextEncoder().encode(unicode).byteLength;
const chunks = new Map();
let part = '', offset = 0, partBytes = 0;
const encoder = new TextEncoder();
for (const character of unicode) {
  const bytes = encoder.encode(character).byteLength;
  if (partBytes + bytes > 32000) { chunks.set(offset, part); offset += partBytes; part = ''; partBytes = 0; }
  part += character; partBytes += bytes;
}
chunks.set(offset, part);
const metadata = { agent_id: 'proof', available: true, size_bytes: total, sha256: digest, inline_complete: false };
let reads = 0;
/** Fake chunks deliberately mix Unicode character sizes; every cursor is measured in UTF-8 bytes. */
async function chunk(params) {
  reads++; assert.equal(params.agent_id, 'proof'); assert.equal(params.sequence, 9); assert.equal(params.expected_sha256, digest);
  const content = chunks.get(params.offset_bytes); assert.equal(typeof content, 'string');
  const next = params.offset_bytes + new TextEncoder().encode(content).byteLength;
  return { agent_id: 'proof', sequence: 9, sha256: digest, total_bytes: total, offset_bytes: params.offset_bytes, next_offset: next, content, complete: next === total };
}
assert.equal(await answerText(metadata, 'proof', 9, digest, true, chunk, () => true), unicode);
assert.ok(reads > 1);
await assert.rejects(answerText(metadata, 'proof', 9, digest, true, async params => ({ ...await chunk(params), sequence: 10 }), () => true), /answer_chunk_proof/);
await assert.rejects(answerText(metadata, 'proof', 9, digest, true, async params => ({ ...await chunk(params), next_offset: params.offset_bytes }), () => true), /answer_chunk_cursor/);
await assert.rejects(answerText(metadata, 'proof', 9, digest, false, chunk, () => true), /answer_chunk_unsupported/);
await assert.rejects(answerText({ ...metadata, size_bytes: 16 * 1024 * 1024 + 1 }, 'proof', 9, digest, true, chunk, () => true), /answer_budget/);

const labels = repositoryLabels(['/work/alpha/repo/.git', '/work/beta/repo/.git', '/work/single.git']);
assert.equal(labels.get('/work/alpha/repo/.git'), 'repo · alpha');
assert.equal(labels.get('/work/beta/repo/.git'), 'repo · beta');
assert.equal(labels.get('/work/single.git'), 'single');
assert.equal(reportObserved('2026-10-20T10:00:00Z'), '2026-10-20T10:00:00.000Z');
assert.equal(reportObserved('unknown'), null);
assert.equal(reportObserved('2026-02-31T10:00:00Z'), null);
assert.equal(reportCompleted('100'), '1970-01-01T00:01:40.000Z');
assert.equal(reportCompleted('unknown'), null);
assert.equal(decimalCursor('201'), 201);
assert.throws(() => decimalCursor('9007199254740993'));
assert.throws(() => decimalCursor('2e3'));
assert.equal(limitsData({ items: [{ key: { window: 'day' }, known: true, remaining_percent: 0, reset_at: null, observed_at: 100, valid_until: null }], observed_at: 100 }).items[0].remaining_percent, 0);
assert.throws(() => modelsData({ schema_version: 1, providers: [], profiles: [], ranked_at: 100 }));
assert.equal(modelsData({ schema_version: 2, providers: [], profiles: [{ name: 'custom', canonical: false }], ranked_at: 100 }).profiles.length, 1);
const bridgeCounts = Object.fromEntries(['unhanded','reserved','invoking','held','review','accepted','hook_submitted','refused','disposed','open_incidents'].map(key => [key, 0]));
assert.equal(bridgeData({schema_version:1,kind:'bridge_overview',data:{counts:bridgeCounts,retention:{events:0,payload_compacted:0,envelope_bytes:0,oldest_accepted_at_ms:null,newest_accepted_at_ms:null},coverage:'retained_history'}},'bridge_overview').counts.accepted, 0);
assert.throws(() => bridgeData({schema_version:1,kind:'bridge_overview',data:{counts:{},retention:{},coverage:'retained_history'}},'bridge_overview'));

assert.deepEqual(runStatuses.filter(activeStatus), ['created','starting','running','cancelling']);
assert.equal(activeStatus('timed_out'), false);
assert.equal(activeStatus('lost'), false);
assert.equal(activeStatus('waiting'), false);

/** Real projection helpers must never rank view-build clocks or infer stuck from silence. */
const agent = fields => runAgent({ agent_id:'source', sequence:1, status:'running', observed_at:99999, last_progress_at:null, finished_at:null, answer_available:true, ...fields });
const earlier = agent({agent_id:'earlier',observed_at:999999,last_progress_at:10});
const later = agent({agent_id:'later',observed_at:1,last_progress_at:20});
const unknownClock = agent({agent_id:'unknown',observed_at:9999999});
const unavailable = agent({agent_id:'no-answer',status:'succeeded',finished_at:99999,answer_available:false});
assert.deepEqual(recentAnswers([earlier,unknownClock,later,unavailable]).map(row=>row.id),['later','earlier','unknown']);
assert.equal(attentionAgent(agent({silence_seconds:999999})),false);
assert.equal(attentionAgent(agent({status:'timed_out'})),true);
assert.equal(attentionAgent(agent({delivery:{ambiguous:true}})),true);
assert.equal(agent({last_progress_at:123}).progress,123);
/** The actual hook transition retains same-key last-good, then clears rejected diagnostics on recovery. */
const good = envelope({valid:true});
const previous = {key:'same',response:good,good,loading:false};
const validate = value => { if(value.valid!==true)throw new Error('bad_schema'); };
const bad = nextObservation(previous,envelope({valid:false}),'same',validate);
assert.equal(bad.good,good);assert.ok(bad.rejected);
const recovered = nextObservation(bad,envelope({valid:true}),'same',validate);
assert.equal(recovered.rejected,undefined);assert.equal(recovered.good,recovered.response);
assert.equal(nextObservation(bad,envelope({valid:false}),'different',validate).good,null);

const subscription = deferred(), finite = deferred(), cancelledRead = deferred();
const commands = [], callbacks = new Map();
let callbackId = 0, delivered = 0;
/** This fake exists only in this unimported Node check; production gets the real Tauri internals. */
globalThis.window = { __TAURI_INTERNALS__: {
  transformCallback(callback) { callbacks.set(++callbackId, callback); return callbackId; },
  unregisterCallback(id) { callbacks.delete(id); },
  invoke(command, args) { commands.push({ command, args }); return command === 'hub_watch' ? subscription.promise : command === 'hub_read' ? args.request.params.offset === 200 ? cancelledRead.promise : commands.filter(row => row.command === 'hub_read').length === 1 ? finite.promise : Promise.resolve(envelope({ fresh: true })) : Promise.resolve(); },
} };
const stop = watch({ resource: 'run.agents', params: {} }, () => delivered++);
const channel = commands[0].args.channel;
stop();
callbacks.get(channel.id)({ index: 0, message: envelope({}) });
subscription.resolve('late-subscription');
await microtasks();
assert.equal(delivered, 0);
assert.deepEqual(commands.find(row => row.command === 'hub_unwatch').args, { subscriptionId: 'late-subscription' });
const request = { resource: 'run.agents', params: { limit: 200, offset: 0 } };
const first = read(request), same = read(request);
assert.equal(first, same);
assert.equal(commands.filter(row => row.command === 'hub_read').length, 1);
const refreshed = readCurrent(request, () => true);
finite.resolve(envelope({ items: [] }));
await first;
assert.equal((await refreshed).data.fresh, true);
assert.equal(commands.filter(row => row.command === 'hub_read').length, 2);
const cancelledRequest = { resource: 'run.agents', params: { limit: 200, offset: 200 } };
const previousRead = read(cancelledRequest);
const obsoleteRead = readCurrent(cancelledRequest, () => false);
cancelledRead.resolve(envelope({ items: [] }));
await previousRead;
assert.equal((await obsoleteRead).error.code, 'obsolete');
assert.equal(commands.filter(row => row.command === 'hub_read').length, 3);
assert.ok(commands.every(row => ['hub_read', 'hub_watch', 'hub_unwatch'].includes(row.command)));
delete globalThis.window;
console.log('PASS: >200 pagination/dedup/coverage; revision and out-of-order fences; longest confirmed path; large Unicode SHA-256/chunk proof/budgets; malformed envelopes; explicit mode; late watch cleanup and nonoverlapping execution-fresh reads; repository labels, exact lifecycle set, Tasks clocks and cached source schemas.');
