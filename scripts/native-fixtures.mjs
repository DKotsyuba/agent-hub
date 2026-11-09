/** Synthetic producer transports for native WKWebView acceptance; never contacts installed services. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { EventEmitter, once } from 'node:events';

/** Approved private artifact root; short child paths also fit Darwin's Unix socket limit. @type {string} */
export const fixtureRoot = path.join(os.tmpdir(), 'native');
/** Explicit malicious source prose must appear verbatim as data, never executable markup. @type {string} */
export const sourceProse = 'SYNTHETIC acceptance — Русский・你好・🙂 <img src=x onerror="window.__nativeFixtureExecuted=true">';
/** Fixed historical source clock, deliberately different from the test receipt clock, in epoch seconds. @type {number} */
export const sourceTime = 1_760_000_123;
/** Inventory exceeds the renderer first-page budget. @type {number} */
export const agentCount = 237;

/** Hashes exact UTF-8 text or binary bytes without normalization. @param {string|Buffer} value Synthetic content or owned binary bytes. @returns {string} Lowercase SHA-256. */
export function digest(value) { return createHash('sha256').update(value).digest('hex'); }
/** Supplies sequence-specific text with >512KiB Unicode and a long unbroken token.
 * @param {number} sequence Positive execution sequence. @returns {string} Attributed synthetic answer, below 16MiB.
 */
export function answerContent(sequence = 1) { return `SYNTHETIC RESULT sequence=${sequence}\n${sourceProse}\n` + '界'.repeat(1600) + '\n' + '🙂Код・你好\n'.repeat(36000); }
/** Builds producer models v2 as cached compatibility observations, never executable provider settings.
 * @returns {object} Two synthetic providers/models, one profile, explicit unavailable quota evidence and historical clocks in Unix seconds.
 */
export function runModels() {
  return {
    schema_version: 2, config_revision: 'synthetic-config-4', capacity_revision: 'synthetic-capacity-2', ranked_at: sourceTime, roles_sha256: digest('SYNTHETIC profile roles'),
    profiles: [{ name: 'synthetic-read-only', revision: 'synthetic-profile-1', write: false, network: false, allow_external_read_roots: false, read_roots: [], skills: [], mcp: [], required_constraints: [] }],
    providers: ['a', 'b'].map((suffix, index) => ({
      provider: 'SYNTHETIC provider ' + suffix, harness: index === 0 ? 'codex' : 'claude', auth_family: 'synthetic', connection: index === 0 ? { kind: 'native' } : { kind: 'custom', protocol: 'messages' }, limits_source: 'synthetic-cached-only', priority_multiplier: 1, score: index === 0 ? 62 : null, recommendations: [],
      models: [{ model: 'SYNTHETIC model ' + suffix, native_model: index === 0 ? 'synthetic-native-' + suffix : null, allowed_params: { effort: ['low', 'high'] }, params: { effort: 'low' }, profiles: ['synthetic-read-only'], quota: { status: 'unknown', best_priority: null, evidence: index === 0 ? 'stale' : 'missing', newest_observed_at: index === 0 ? sourceTime : null, exhausted_until: null }, recommendations: [], restrictions: ['SYNTHETIC compatibility observation; no inference is authorized'] }],
    })),
  };
}
/** Builds real Run limits: a fresh cached sample or its separately controlled expired/null successor.
 * @param {boolean} [expired=false] Source recomputation invalidates the first sample instead of retaining its prior percentage.
 * @param {number} [observedAt] Stable producer sample clock in Unix seconds; defaults to 90 seconds before this fixture read.
 * @returns {object} Two cached physical quota lanes with numeric/null percentages and independent Unix-second clocks.
 */
export function runLimits(expired = false, observedAt = Math.floor(Date.now() / 1000) - 90) {
  const models = runModels();
  const invalidated = expired || Date.now() / 1000 > observedAt + 3600;
  return {
    items: [
      { account: 'SYNTHETIC account a', pool: 'SYNTHETIC physical quota lane', key: { lane: 'synthetic-lane-a', runtime: 'codex', source: 'synthetic-cached-only', target: 'SYNTHETIC provider a', window: '5h' }, known: !invalidated, remaining_percent: invalidated ? null : 62, reset_at: observedAt + 7200, observed_at: observedAt, valid_until: observedAt + (expired ? 30 : 3600) },
      { account: 'SYNTHETIC account b', key: { lane: 'synthetic-lane-b', runtime: 'claude', source: 'synthetic-cached-only', target: 'SYNTHETIC provider b', window: '7d' }, known: false, remaining_percent: null, reset_at: null, observed_at: sourceTime, valid_until: null },
    ],
    observed_at: observedAt, ranking: { schema_version: 2, config_revision: models.config_revision, capacity_revision: models.capacity_revision, ranked_at: models.ranked_at, providers: models.providers.map(({ provider, priority_multiplier, score, models }) => ({ provider, priority_multiplier, score, models: models.map(({ model, native_model, quota }) => ({ model, native_model, quota })) })) },
  };
}
/** Constructs one versioned producer envelope, without a contradictory error field.
 * @param {string} kind Producer kind. @param {Record<string, unknown>} data Original structured fields. @returns {object} Producer envelope.
 */
function product(kind, data) { return { schema_version: 1, kind, data }; }
/** Appends one bounded safe audit record in one O_APPEND write, including no task body or credentials.
 * @param {string} directory Owned fixture directory. @param {object} row Method/lifecycle evidence. @returns {void}
 */
function audit(directory, row) { appendFileSync(path.join(directory, 'methods.ndjson'), JSON.stringify(row) + '\n'); }
/** Produces the synthetic canonical repo and working directory identities.
 * @param {string} directory Owned fixture directory. @returns {{repository:string,common:string}} Paths are identities only, never filesystem discovery roots.
 */
export function identities(directory) { return { repository: path.join(directory, 'repo'), common: path.join(directory, 'repo/.git') }; }
/** Returns metadata for a standalone pool, independent of legacy Run pools and lifecycle.
 * @returns {object} Producer pool including accepted decision while the pool stays open.
 */
function standalonePool() { return { pool_id: 'standalone-1', name: 'SYNTHETIC standalone decisions', purpose: sourceProse, closed: false, revision: 7, proposal: { proposal_id: 'proposal-7', state: 'accepted', result: 'SYNTHETIC accepted result; pool remains open', voters: ['member-1'], votes: { 'member-1': { choice: 'ready', evidence: 'SYNTHETIC source vote evidence' } } } }; }
/** Produces faithful legacy status: agreement and delivery do not imply completion.
 * @returns {object} Producer legacy status metadata.
 */
function legacyStatus() { return { state: 'open', roster_revision: 3, goal: 'SYNTHETIC legacy Run discussion', criteria: [{ id: 'c1', text: 'SYNTHETIC review only' }], current_proposal: { seq: 2, snapshot: 'synthetic-sha', roster_revision: 3 }, members: [{ name: 'SYNTHETIC legacy member', role: 'review', agent_id: 'agent-000', slot: 0, tip_status: 'running', cleanup_complete: false, vote: 'ready', counts: true, why: 'SYNTHETIC current roster' }], replaced_members: [], agreed: true, note: 'SYNTHETIC agreed while open' }; }
/** Dispatches only fixed fake subprocess product reads; unknown requests fail rather than mutating anything.
 * @param {string} source worktree/tasks/pool/bridge/ide. @param {string} method Fixed producer operation.
 * @param {Record<string, any>} params Producer read arguments. @param {string} directory Fixture root.
 * @returns {object} Source envelope or IDE read-only installation report. @throws {Error} Any unsupported call or invalid argument.
 */
export function helperReply(source, method, params, directory) {
  const { repository, common } = identities(directory);
  if ((['worktree', 'tasks'].includes(source) && method === 'get_status') || (['pool', 'bridge'].includes(source) && method === 'identity')) return product(source === 'tasks' ? 'product_identity' : 'identity', { product: 'agent-' + source, version: null, source_timestamp: null, coverage: 'synthetic_fixture' });
  if (source === 'worktree' && method === 'list_worktrees') {
    assert.equal(params.size, false, 'Background inventory must not measure size');
    assert.ok(Number.isInteger(params.limit) && params.limit > 0 && params.limit <= 20);
    const offset = params.cursor === undefined ? 0 : Number(params.cursor);
    assert.ok([0, 20].includes(offset));
    const rows = Array.from({ length: offset === 0 ? 20 : 3 }, (_, i) => ({ key: 'tree-' + (offset + i), repo_common_dir: common, path: offset + i === 0 ? repository : path.join(directory, 'worktree-' + (offset + i)), branch: 'synthetic/ветка-' + (offset + i), observed_at: null }));
    return product('worktree_page', { rows, returned: rows.length, cursor: offset === 0 ? '20' : null, has_more: offset === 0, coverage: { failed: [], budget_exhausted: true, orphan_scan_truncated: false, root_unconfigured: false, provenance: 'SYNTHETIC partial discovery; not a full disk scan' } });
  }
  if (source === 'worktree' && method === 'inspect_worktree') {
    assert.ok(typeof params.repo === 'string' && params.repo.startsWith(directory + '/'));
    assert.ok(typeof params.path === 'string' && !('key' in params));
    assert.equal(typeof params.checks.size, 'boolean');
    return product('worktree_detail', {
      key: 'tree-0', repo_id: '0'.repeat(64), repo_common_dir: common, path: params.path,
      class: 'managed', head: null, branch: 'refs/heads/synthetic/ветка-0', detached: false,
      locked: null, activity: 'unknown', activity_signals: { head_mtime: null, index_mtime: null, last_reflog_entry: null },
      probes: {
        status: params.checks.status ? { state: 'known', value: { staged: 0, unstaged: 1, untracked: 0, conflicts: 0, ignored: 0 }, code: null, reason: null } : { state: 'not_checked', value: null, code: null, reason: null },
        integration: { state: 'not_checked', value: null, code: null, reason: null },
        processes: { state: 'not_checked', value: null, code: null, reason: null },
        submodules: { state: 'not_checked', value: null, code: null, reason: null },
        size: params.checks.size ? { state: 'incomplete', value: { bytes: 123456, quality: 'lower_bound' }, code: null, reason: 'SYNTHETIC traversal budget' } : { state: 'not_checked', value: null, code: null, reason: null },
      },
      warnings: [], record: null, hygiene: { stale_activity: false, large: false, missing: false }, observed_at: sourceTime,
    });
  }
  if (source === 'tasks' && method === 'peek') {
    assert.ok(params.repository.startsWith(directory + '/'));
    return product('project_snapshot', {
      repository: { id: 'synthetic-repo', common_dir: common, source_path: params.repository },
      plan_state: 'saved', plan: { revision: 2, goal: sourceProse, outcomes: [{ id: 'o1', text: 'SYNTHETIC observe fixture data' }, { id: 'o2', text: 'SYNTHETIC check fixture freshness' }], integration_ref: 'refs/heads/main' },
      report_state: 'saved', report: {
        analysis_id: 'synthetic-analysis-1', observed_at: new Date(sourceTime * 1000).toISOString(), completed_at: String(sourceTime + 1),
        plan: { revision: 1, goal: 'SYNTHETIC prior fixture scope', outcomes: [{ id: 'o1', text: 'SYNTHETIC observe fixture data' }], integration_ref: 'refs/heads/main' },
        analysis: { analysis_input_id: digest('SYNTHETIC analysis input'), plan_revision: 1, outcomes: [{ id: 'o1', title: 'SYNTHETIC saved outcome', state: 'in_progress', progress_percent: 40, summary: 'SYNTHETIC saved report, older plan revision', remaining: 'SYNTHETIC remaining part', integrated: null, evidence: { items: ['target_patch:fixture-1'], total: 1, truncated: false } }], findings: [{ text: 'SYNTHETIC coverage is incomplete', evidence: { items: ['target_patch:fixture-1'], total: 1, truncated: false } }] },
        coverage: { git_omissions: { items: [], total: 0, truncated: false }, runtime_complete: null, runtime_omissions: { items: ['SYNTHETIC runtime observation omitted'], total: 1, truncated: false } },
      },
      pending: { state: 'accepted', analysis_id: 'synthetic-pending-1', plan_revision: 2 }, error: null,
    });
  }
  if (source === 'pool' && method === 'list') {
    assert.ok(params.after === undefined || params.after === 'standalone-1');
    const pool = params.after ? { ...standalonePool(), pool_id: 'standalone-2', name: 'SYNTHETIC standalone second page' } : standalonePool();
    return product('pool_page', { pools: [{ pool, leader_id: 'leader-outside-roster' }], cursor: params.after ? null : 'standalone-1', has_more: !params.after, returned: 1, observed_at_unix_ms: sourceTime * 1000, source_timestamp: null, coverage: { source_timestamp: 'unavailable' } });
  }
  if (source === 'pool' && method === 'get') {
    assert.equal(params.pool_id, 'standalone-1');
    const section = params.section ?? 'overview';
    assert.ok(['overview', 'members', 'history', 'proposal', 'votes', 'deliveries', 'binding', 'decisions'].includes(section));
    const continuation = Number(params.after ?? 0) > 0;
    assert.ok(!continuation || Number(params.after) === 41, 'Decision continuation is source rowid, never positional OFFSET');
    const view = { pool: standalonePool(), members: [{ member_id: 'member-1', name: 'SYNTHETIC native member', role: 'review', task: sourceProse, state: 'active' }], events: [{ event_id: 'event-1', author: { member_id: 'member-1' }, body: sourceProse }], deliveries: [{ operation_id: 'delivery-1', operation: 'deliver', state: 'accepted' }], has_more: false, next_after: 0 };
    return product('pool_detail', { section, view, leader_id: 'leader-outside-roster', bindings: params.include_bindings ? [{ member: { member_id: 'member-1' }, run_id: null, run_sequence: null }] : null, decisions: section === 'decisions' ? [{ proposal_id: continuation ? 'decision-row-83' : 'decision-row-41', state: 'accepted', result: 'SYNTHETIC historical decision' }] : [], cursor: section === 'decisions' && !continuation ? '41' : null, has_more: section === 'decisions' && !continuation, source_timestamp: null, observed_at_unix_ms: sourceTime * 1000 });
  }
  if (source === 'bridge' && method === 'overview') return product('bridge_overview', { counts: { unhanded: 1, reserved: 0, invoking: 0, held: 1, review: 1, accepted: 1, hook_submitted: 0, refused: 0, disposed: 0, open_incidents: 1 }, retention: { events: 4, payload_compacted: 1, envelope_bytes: 512, oldest_accepted_at_ms: sourceTime * 1000, newest_accepted_at_ms: (sourceTime + 10) * 1000 }, coverage: 'retained_history' });
  if (source === 'bridge' && ['deliveries', 'incidents'].includes(method)) {
    assert.ok(params.limit >= 1 && params.limit <= 200);
    const deliveries = method === 'deliveries';
    return product(deliveries ? 'delivery_page' : 'incident_page', { [method]: [deliveries ? { acceptance_seq: 1, publisher: 'SYNTHETIC publisher', event_id: 'synthetic-delivery', custody_state: 'accepted', delivery_state: 'unknown', evidence_tiers: { accepted: true, native_observed: null } } : { incident_seq: 1, publisher: 'SYNTHETIC publisher', event_id: 'synthetic-incident', state: 'open' }], through_seq: 2, next_after_seq: null, coverage: 'retained_history' });
  }
  if (source === 'ide' && method === 'doctor') return { read_only: true, version: 'SYNTHETIC fixture 1', home: path.join(directory, 'ide-home'), checked_at: new Date(sourceTime * 1000).toISOString(), findings: [{ code: 'not_probed', severity: 'info', component: 'toolchains', detail: 'SYNTHETIC installation only; no daemon health assertion' }] };
  if (source === 'ide' && method === 'observe') {
    assert.ok(params.repository.startsWith(directory + '/'));
    return product('ide_observation', { product: 'agent-ide', repository: { common_dir: common, source_path: params.repository }, instances: [{ instance_id: 'synthetic-instance', health: 'unavailable', runtime: 'private' }], checks: { availability: 'available', snapshots: [{ snapshot_id: 'synthetic-check', source_path: path.join(directory, 'synthetic-report.json'), freshness: 'stale', state: 'passed', rechecking: false, observed_at_ms: sourceTime * 1000 }], next_cursor: null }, coverage: { private_instances: 'unknown' }, telemetry: null });
  }
  throw new Error('Forbidden fixture method: ' + source + '.' + method);
}

/** Runs a copied helper from an explicit wrapper. MCP is NDJSON; observers consume one line and EOF.
 * @param {string} source Fixed wrapper namespace. @param {string} directory Owned fixture directory.
 * @param {string[]} args Native-owned argv. @returns {Promise<void>} Settles after stdin EOF or SIGTERM; failures set nonzero exitCode and safe audit.
 */
async function runHelper(source, directory, args) {
  audit(directory, { source, event: 'start', pid: process.pid });
  process.on('exit', () => audit(directory, { source, event: 'exit', pid: process.pid }));
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const config = path.join(directory, 'producer.json');
  const expected = source === 'worktree' ? ['mcp'] : source === 'tasks' ? ['--config', config, 'mcp'] : source === 'ide' ? null : ['observe', '--config', config];
  if (expected) assert.deepEqual(args, expected);
  if (source === 'ide') {
    const doctor = args[0] === 'doctor';
    if (doctor) assert.deepEqual(args, ['doctor', '--read-only']);
    else { assert.equal(args[0], 'observe'); assert.equal(args[1], '--repo'); assert.equal(args[3], '--json'); assert.ok(args.length === 4 || (args.length === 6 && args[4] === '--cursor' && /^\d+$/.test(args[5]))); }
    const method = doctor ? 'doctor' : 'observe';
    audit(directory, { source, method, read_only: doctor ? args[1] === '--read-only' : true });
    process.stdout.write(JSON.stringify(helperReply(source, method, doctor ? {} : { repository: args[2] }, directory)) + '\n'); input.close(); process.stdin.destroy(); return;
  }
  let requests = 0;
  for await (const line of input) {
    assert.ok(Buffer.byteLength(line) <= 65536);
    const request = JSON.parse(line);
    if (source === 'worktree' || source === 'tasks') {
      assert.equal(request.jsonrpc, '2.0');
      if (request.method === 'initialize') {
        audit(directory, { source, method: 'initialize' });
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'synthetic-' + source, version: '1' } } }) + '\n');
      } else if (request.method === 'notifications/initialized') audit(directory, { source, method: request.method });
      else {
        assert.equal(request.method, 'tools/call');
        const method = request.params.name, params = request.params.arguments ?? {};
        const result = helperReply(source, method, params, directory);
        audit(directory, { source, method, size: params.size ?? params.checks?.size ?? null, cursor: params.cursor ?? null });
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { content: [], structuredContent: result, isError: false } }) + '\n');
      }
    } else {
      assert.equal(++requests, 1); assert.equal(request.schema_version, 1);
      const result = helperReply(source, request.operation, request.params, directory);
      audit(directory, { source, method: request.operation, section: request.params.section ?? null, after: request.params.after ?? null });
      process.stdout.write(JSON.stringify(result) + '\n');
    }
  }
}

/** Starts only synthetic private transports and creates explicit all-source connections.
 * @returns {Promise<{directory:string,connections:string,repository:string,common:string,events:EventEmitter,state:object,answer:(sequence?:number)=>string,set:(patch:object)=>void,hold:(method:string,agent:string)=>()=>void,logs:()=>Promise<object[]>,close:()=>Promise<object>}>}
 * Controller owns its server/sockets/gates; caller closes the app first, then close verifies helper PIDs are gone.
 */
export async function createFixtures() {
  await fs.mkdir(fixtureRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(fixtureRoot, 'f-'));
  await fs.chmod(directory, 0o700);
  await fs.writeFile(path.join(directory, 'methods.ndjson'), '', { flag: 'wx' });
  const socketPath = path.join(directory, 'r.sock'), events = new EventEmitter(), sockets = new Set(), pending = new Set(), gates = new Map();
  const state = { revision: 1, messageRevision: 1, sequence: 1, available: true, empty: false, version: null, quotaExpired: false, quotaObserved: Math.floor(Date.now() / 1000) - 90 };
  const { repository, common } = identities(directory);
  /** Returns one checked Run read; held responses capture their original proof before the gate.
   * @param {string} method Closed Run read. @param {Record<string, any>} params Producer arguments.
   * @returns {object|object[]} Original synthetic producer payload. @throws {Error} Unknown operations or invalid proof.
   */
  function runReply(method, params) {
    if (method === 'ping') return { ok: true };
    if (method === 'tools') return ['ping', 'capabilities', 'tools', 'list_agents', 'transcript', 'answer', 'answer_chunk', 'models', 'limits', 'list_pools', 'pool'].map(name => ({ name }));
    if (method === 'capabilities') return { version: state.version, source: 'SYNTHETIC native acceptance producer' };
    if (method === 'list_agents') {
      const offset = params.offset ?? 0, limit = Math.min(params.limit ?? 200, 200);
      assert.ok(Number.isInteger(offset) && offset >= 0 && offset <= agentCount);
      if (state.empty) return { items: [], offset, limit, total: 0, next_offset: null, complete: true, revision: state.revision, message_revision: state.messageRevision, observed_at: sourceTime };
      const end = Math.min(offset + limit, agentCount), viewBuiltAt = Date.now() / 1000;
      return { items: Array.from({ length: end - offset }, (_, i) => { const index = i + offset, sequence = index === 0 ? state.sequence : 1; return { agent_id: 'agent-' + String(index).padStart(3, '0'), sequence, name: `SYNTHETIC task ${String(index).padStart(3, '0')} — Задача・🙂`, task_summary: sourceProse, workdir: repository, status: index % 2 === 0 ? 'running' : 'succeeded', model: null, elapsed_seconds: 12, silence_seconds: null, observed_at: viewBuiltAt, last_progress_at: sourceTime, finished_at: index % 2 === 0 ? null : sourceTime + 5, answer_available: true, answer_sha256: digest(index === 0 ? answerContent(sequence) : `SYNTHETIC selected ${index}`), delivery: { state: 'unknown' }, cleanup: null }; }), offset, limit, total: agentCount, next_offset: end < agentCount ? end : null, complete: end === agentCount, revision: state.revision, message_revision: state.messageRevision, observed_at: viewBuiltAt };
    }
    if (method === 'transcript') {
      assert.match(params.agent_id, /^agent-\d{3}$/);
      const older = params.before_cursor !== undefined;
      return { agent_id: params.agent_id, messages: [{ seq: older ? 1 : 9, role: older ? 'user' : 'assistant', content: (older ? 'SYNTHETIC older history ' : 'SYNTHETIC tail history ') + params.agent_id + ' ' + sourceProse, at: sourceTime, content_complete: true }], previous_cursor: older ? null : 'older-9', resume_cursor: null, complete: older };
    }
    if (method === 'answer' || method === 'answer_chunk') {
      assert.match(params.agent_id, /^agent-\d{3}$/);
      const index = Number(params.agent_id.slice(6)), sequence = index === 0 ? (params.sequence ?? state.sequence) : 1;
      const content = index === 0 ? answerContent(sequence) : `SYNTHETIC selected ${index}`, sha256 = digest(content), bytes = Buffer.from(content);
      if (method === 'answer') return { agent_id: params.agent_id, sequence, available: true, size_bytes: bytes.length, sha256, inline_complete: index !== 0, ...(index === 0 ? {} : { content }), path: path.join(directory, 'MUST-NOT-READ-ARTIFACT'), raw_ref: 'SYNTHETIC metadata only' };
      assert.equal(params.expected_sha256, sha256); assert.ok(params.max_bytes > 0 && params.max_bytes <= 65536);
      const offset = params.offset_bytes; assert.ok(Number.isInteger(offset) && offset >= 0 && offset < bytes.length);
      assert.ok((bytes[offset] & 0xc0) !== 0x80, 'Byte cursor must start a Unicode character');
      let next = Math.min(offset + params.max_bytes, bytes.length);
      while (next < bytes.length && (bytes[next] & 0xc0) === 0x80) next--;
      return { agent_id: params.agent_id, sequence, sha256, total_bytes: bytes.length, offset_bytes: offset, next_offset: next, complete: next === bytes.length, content: bytes.subarray(offset, next).toString('utf8') };
    }
    if (method === 'models') return runModels();
    if (method === 'limits') return runLimits(state.quotaExpired, state.quotaObserved);
    if (method === 'list_pools') return { items: [{ pool_id: 'legacy-1', ...legacyStatus() }], offset: 0, limit: 200, total: 1, next_offset: null, complete: true };
    if (method === 'pool') {
      assert.equal(params.pool_id, 'legacy-1'); assert.ok(params.limit >= 1 && params.limit <= 50); assert.ok(!(params.after_seq !== undefined && params.before_seq !== undefined));
      const later = (params.after_seq ?? 0) > 0;
      assert.ok(!later || params.after_seq === 2);
      return { pool_id: 'legacy-1', log_revision: 3, entries: later ? [{ seq: 3, roster_revision: 3, author_kind: 'broker', direction: 'team', kind: 'agreed', body: 'SYNTHETIC legacy agreed is not completed' }] : [{ seq: 1, roster_revision: 3, author_kind: 'member', author_agent_id: 'agent-000', author_name: 'SYNTHETIC legacy member', author_role: 'review', direction: 'team', kind: 'message', body: sourceProse }, { seq: 2, roster_revision: 3, author_kind: 'operator', direction: 'team', kind: 'message', body: 'SYNTHETIC operator retained history' }], after_seq: params.after_seq ?? 0, before_seq: null, limit: params.limit, next_cursor: later ? null : 2, last_seq: 3, complete: later, activity: 'running', status: legacyStatus(), delivery: { bound: true, state: 'pending', attempts: 0, ambiguous: false, last_classification: null, last_attempt: null } };
    }
    throw new Error('Forbidden fixture method: run.' + method);
  }
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    const lines = readline.createInterface({ input: socket, crlfDelay: Infinity });
    lines.once('line', async line => {
      let request;
      try {
        assert.ok(Buffer.byteLength(line) <= 65536); request = JSON.parse(line); assert.equal(request.jsonrpc, '2.0');
        const method = request.method, params = request.params ?? {};
        const result = runReply(method, params);
        audit(directory, { source: 'run', method, agent: params.agent_id ?? null, sequence: params.sequence ?? null, offset: params.offset ?? params.offset_bytes ?? null, after_revision: params.after_revision ?? null, after_message_revision: params.after_message_revision ?? null, wait_seconds: params.wait_seconds ?? null });
        events.emit('call', { method, params });
        if (method === 'list_agents' && state.available && params.after_revision === state.revision && params.after_message_revision === state.messageRevision) {
          await new Promise(resolve => {
            const timeout = setTimeout(() => entry.resolve(), Math.min(params.wait_seconds ?? 25, 25) * 1000);
            const entry = {
              /** Settles this one finite producer long-poll, removing its deadline and registry entry. @returns {void} */
              resolve() { clearTimeout(timeout); pending.delete(entry); resolve(); }, socket,
            };
            pending.add(entry); socket.once('close', () => entry.resolve());
          });
        }
        const gate = gates.get(method + ':' + params.agent_id);
        if (gate) { events.emit('held', { method, agent: params.agent_id, sequence: result.sequence }); await gate.promise; }
        if (!socket.destroyed) socket.end(JSON.stringify(!state.available ? { jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'SYNTHETIC source unavailable' } } : { jsonrpc: '2.0', id: request.id, result: method === 'list_agents' ? runReply(method, params) : result }) + '\n', () => events.emit('answered', { method, agent: params.agent_id }));
      } catch (error) { audit(directory, { source: 'run', forbidden: true, method: request?.method ?? 'invalid', error: String(error).slice(0, 160) }); socket.destroy(); }
      finally { lines.close(); }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  await fs.chmod(socketPath, 0o600);
  await fs.writeFile(path.join(directory, 'producer.json'), JSON.stringify({ synthetic: true, provenance: 'Agent Hub isolated acceptance fixture; no credentials' }));
  await fs.copyFile(fileURLToPath(import.meta.url), path.join(directory, 'helper.mjs'));
  const config = { schema_version: 1, run: { socket: socketPath }, repositories: [repository] };
  for (const source of ['worktree', 'tasks', 'pool', 'bridge', 'ide']) {
    const program = path.join(directory, source);
    await fs.writeFile(program, '#!/bin/sh\nexport TMPDIR=' + directory + ' TMP=' + directory + ' TEMP=' + directory + '\nexec ' + [process.execPath, path.join(directory, 'helper.mjs'), '--helper', source, directory].map(value => "'" + value.replaceAll("'", "'\\''") + "'").join(' ') + ' "$@"\n', { mode: 0o700 });
    config[source] = { program, ...(['ide', 'worktree'].includes(source) ? {} : { config: path.join(directory, 'producer.json') }) };
  }
  const connections = path.join(directory, 'connections.json');
  await fs.writeFile(connections, JSON.stringify(config));
  return {
    directory, connections, repository, common, events, state, answer: answerContent,
    /** Changes only synthetic producer state and releases dual-revision waiters. @param {object} patch Explicit fixture changes. @returns {void} */
    set(patch) { Object.assign(state, patch); for (const item of pending) item.resolve(); pending.clear(); },
    /** Holds one method/agent response until its returned release callback is called. @param {string} method Read method. @param {string} agent Synthetic identity. @returns {()=>void} Idempotent release. */
    hold(method, agent) { const key = method + ':' + agent; assert.ok(!gates.has(key)); let release; const promise = new Promise(resolve => { release = resolve; }); gates.set(key, { promise, release }); return () => { gates.delete(key); release(); }; },
    /** Reads bounded synthetic method/lifecycle evidence. @returns {Promise<object[]>} Audit rows, without source prose or credentials. */
    async logs() { return (await fs.readFile(path.join(directory, 'methods.ndjson'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); },
    /** Restarts only the controller-owned synthetic Unix endpoint at the same explicit path.
     * @param {object} patch New producer version/revision state. @returns {Promise<void>} Resolves after the private endpoint is listening with mode 0600.
     */
    async restart(patch) {
      await Promise.all([...sockets].map(socket => { const closed = once(socket, 'close'); socket.destroy(); return closed; }));
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      this.set(patch);
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
      await fs.chmod(socketPath, 0o600); audit(directory, { source: 'run', event: 'restart', version: state.version });
    },
    /** Closes all owned sockets, settles gates, and proves app-created helpers exited. @returns {Promise<object>} Cleanup evidence; rejects on leaked helper or forbidden request. */
    async close() {
      for (const item of pending) item.resolve(); pending.clear(); for (const gate of gates.values()) gate.release(); gates.clear();
      await Promise.all([...sockets].map(socket => { const closed = once(socket, 'close'); socket.destroy(); return closed; }));
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      const rows = await this.logs();
      const pids = [...new Set(rows.filter(row => row.event === 'start').map(row => row.pid))];
      const alive = pids.filter(pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } });
      assert.deepEqual(alive, [], 'Owned fixture helper processes must be reaped after last-window exit');
      assert.equal(sockets.size, 0, 'Owned Run socket connections must settle');
      assert.ok(!rows.some(row => row.forbidden), 'No unsupported source method may be requested');
      return { helpersStarted: pids.length, helpersAlive: alive, sockets: sockets.size, serverClosed: !server.listening };
    },
  };
}

if (process.argv[2] === '--helper') {
  try { await runHelper(process.argv[3], process.argv[4], process.argv.slice(5)); }
  catch (error) { audit(process.argv[4], { source: process.argv[3], forbidden: true, error: String(error).slice(0, 160) }); process.exitCode = 10; }
}
