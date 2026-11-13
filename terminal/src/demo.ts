/** Explicit synthetic observations used only when the operator selects demo mode. */
import { createHash } from 'node:crypto';
import type { ObservationClient, ReadResponse, Resource } from './api.ts';

/** Valid synthetic identities for Pool bindings and their Run observations. */
export const DEMO_POOL_AGENT_ID = 'ag-20261107-000000-0000000001';
export const DEMO_POOL_INDEX_ID = 'ag-20261107-000000-0000000002';

/** Creates a stable synthetic dataset without contacting any service. */
export function createDemoClient(): ObservationClient {
  const observed = Math.floor(Date.now() / 1000);
  const answer = 'Synthetic result: the available execution history was reviewed.\nNo real service was contacted.';
  const digest = createHash('sha256').update(answer).digest('hex');
  const agents = [
    { agent_id: 'demo-inspect', name: 'Inspect execution history', task_summary: 'Review the available execution history.', status: 'running', model: 'model-alpha', effort: 'high', workdir: '/demo/agent-hub', last_action: 'Read history', elapsed_seconds: 192, last_progress_at: observed - 8, finished_at: null, answer_available: false, answer_sha256: null },
    { agent_id: 'demo-index', name: 'Index repository', task_summary: 'Find symbols in the example project.', status: 'running', model: 'model-beta', effort: 'medium', workdir: '/demo/workspace', last_action: 'Search symbols', elapsed_seconds: 365, last_progress_at: observed - 2, finished_at: null, answer_available: false, answer_sha256: null },
    { agent_id: 'demo-finished', name: 'Review saved output', task_summary: 'Summarize the synthetic result.', status: 'succeeded', model: 'model-alpha', workdir: '/demo/agent-hub', elapsed_seconds: 420, last_progress_at: observed - 3700, finished_at: observed - 3600, answer_available: true, answer_sha256: digest },
    { agent_id: 'demo-failed', name: 'Inspect failed observation', task_summary: 'Explain a synthetic failure.', status: 'failed', model: 'model-beta', workdir: '/demo/workspace', elapsed_seconds: 75, last_progress_at: observed - 1800, finished_at: observed - 1700, answer_available: false, answer_sha256: null },
  ].map(row => ({ ...row, sequence: 1, observed_at: observed, silence_seconds: observed - row.last_progress_at, delivery: null, cleanup: null }));
  const demoId = (id: string) => id === DEMO_POOL_AGENT_ID ? 'demo-inspect' : id === DEMO_POOL_INDEX_ID ? 'demo-index' : id;
  const member = { member_id: 'demo-member', name: 'Example reviewer', role: 'reviewer', task: 'Review the available evidence', state: 'active', runtime: 'running' };
  const proposal = { proposal_id: 'demo-proposal', roster_key: 'synthetic', voters: ['demo-member'], result: 'Synthetic proposed result', criteria: 'Review the available evidence', state: 'open', votes: { 'demo-member': { choice: 'ready', evidence: 'Synthetic evidence' } } };
  const standalonePool = { pool_id: 'demo-pool', name: 'Synthetic review pool', purpose: 'Review the available evidence', revision: 1, closed: false, proposal: null };
  const events = [{ event_id: 1, revision: 1, kind: 'message', author: { kind: 'member', member_id: 'demo-member' }, body: 'Synthetic discussion; source decisions and delivery remain independent.', recipient: null }];
  const product = (kind: string, data: unknown) => ({ schema_version: 1, kind, data });
  let closed = false;

  /** Returns a producer-shaped synthetic result with explicitly scoped fixture data. */
  async function read(resource: Resource, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<ReadResponse> {
    const fail = (code: string): ReadResponse => ({ schema_version: 1, source: resource.split('.')[0]!, resource, observed_at_ms: Date.now(), outcome: 'unavailable', data: null, error: { code, message: 'Synthetic observation unavailable.' } });
    if (closed || signal?.aborted) return fail('cancelled');
    let data: unknown;
    const id = typeof params.agent_id === 'string' ? params.agent_id : '';
    switch (resource) {
      case 'run.identity':
        data = { ping: { ok: true }, tools: ['answer_chunk'].map(name => ({ name })), capabilities: { version: 'demo' }, version: 'demo' };
        break;
      case 'run.agents': {
        const offset = typeof params.offset === 'number' ? Math.max(0, params.offset) : 0;
        const limit = typeof params.limit === 'number' ? Math.min(200, Math.max(1, params.limit)) : 200;
        const scoped = params.active === true ? agents.filter(agent => ['created', 'starting', 'running', 'cancelling'].includes(agent.status)) : agents;
        const items = scoped.slice(offset, offset + limit);
        data = { items, offset, limit, total: scoped.length, next_offset: offset + items.length < scoped.length ? offset + items.length : null, complete: offset + items.length >= scoped.length, revision: 1, message_revision: 1, observed_at: observed };
        break;
      }
      case 'run.status': {
        const target = Array.isArray(params.targets) && params.targets.length === 1 && params.targets[0] && typeof params.targets[0] === 'object' ? params.targets[0] as Record<string, unknown> : null;
        if (params.version !== 1 || !target || typeof target.agent_id !== 'string' || typeof target.sequence !== 'number') return fail('demo_status_request');
        const storeId = `store_${'1'.repeat(32)}`, ref = `ex1_${'a'.repeat(64)}`, pin = 'pin_123e4567e89b42d3a456426614174000';
        if (params.expected_store_id !== undefined && params.expected_store_id !== storeId) return fail('run_store_identity_mismatch');
        const source = agents.find(value => value.agent_id === demoId(target.agent_id as string));
        const agent = source ? { ...source, agent_id: target.agent_id as string } : undefined;
        const matched = agent && agent.sequence === target.sequence;
        const match = !matched ? 'missing' : target.execution_ref === undefined ? 'unverified' : target.execution_ref === ref ? 'verified' : 'mismatch';
        const pinState = target.pin_id === undefined ? 'missing' : target.pin_id === pin && agent ? 'active' : agent ? 'mismatch' : 'unknown';
        const fact = matched && match !== 'mismatch' ? { sequence: agent.sequence, execution_ref: ref, raw_status: agent.status } : null;
        const coverage = fact && pinState === 'active' ? 'complete' : 'unknown';
        const restart = fact && coverage === 'complete' ? 'none' : 'unknown';
        const terminal = match === 'verified' && coverage === 'complete' ? ['succeeded', 'failed', 'timed_out', 'cancelled', 'lost'].includes(agent!.status) : null;
        const item = { selector: target, canonical_agent_id: agent?.agent_id ?? null, match, pin_id: target.pin_id ?? null, pin_state: pinState, selected: fact, retained_latest: fact, coverage, restart_resume: restart, lineage_terminal: terminal, terminal_outcome: terminal ? agent!.status : null, success_commit: 'unknown', cleanup: { scope: 'lineage', state: 'unknown' } };
        data = { version: 1, store_id: storeId, observed_at: observed, items: [item], ...(params.include_view === true && fact && agent ? { view: { selector_index: 0, match, status_scope: 'selected_execution_raw', sampled_at: agent.observed_at, agent } } : {}) };
        break;
      }
      case 'run.transcript': {
        if (!agents.some(agent => agent.agent_id === demoId(id))) return fail('demo_agent_missing');
        const messages = [
          { seq: 1, role: 'user', name: null, content: 'Inspect the saved execution history. Identify missing records and explain what can be confirmed from the available evidence.', at: observed - 180, content_complete: true },
          { seq: 2, role: 'tool', name: 'Read history', content: 'Three synthetic records are available.', at: observed - 140, error: false, content_complete: true },
          { seq: 3, role: 'assistant', name: null, content: 'The latest page contains three records.\nTwo describe the execution and one contains a saved answer.', at: observed - 120, content_complete: true },
          { seq: 4, role: 'tool_call', name: 'Search earlier messages', content: '{"pattern":"earlier synthetic history"}', raw_ref: 'demo-search', at: observed - 20, content_complete: true },
          { seq: 5, role: 'tool_result', name: 'Search earlier messages', content: 'No earlier synthetic records.', raw_ref: 'demo-search', error: false, at: observed - 10, content_complete: true },
          { seq: 6, role: 'assistant', name: null, content: demoId(id) === 'demo-finished' ? answer : 'I am checking the earlier page before summarizing the result.\nThe current page alone does not establish complete coverage.', at: observed - 8, content_complete: true },
        ];
        const after = typeof params.cursor === 'number' ? params.cursor : 0;
        const before = typeof params.before_cursor === 'number' ? params.before_cursor : Number.POSITIVE_INFINITY;
        const reverse = typeof params.tail_blocks === 'number' || typeof params.before_cursor === 'number';
        const limit = typeof params.tail_blocks === 'number' ? params.tail_blocks : typeof params.limit === 'number' ? params.limit : 200;
        const available = messages.filter(message => message.seq > after && message.seq < before);
        const selected = reverse ? available.slice(-limit) : available.slice(0, limit), complete = selected.length === available.length;
        data = { agent_id: id, view: params.view ?? 'raw', cursor: after, direction: reverse ? 'backward' : 'forward', limit, messages: selected, complete, previous_cursor: reverse && !complete ? selected[0].seq : null, next_cursor: !reverse && !complete ? selected.at(-1)?.seq ?? null : null, resume_cursor: selected.at(-1)?.seq ?? null };
        break;
      }
      case 'run.answer':
        data = demoId(id) === 'demo-finished' ? { agent_id: id, available: true, size_bytes: Buffer.byteLength(answer), sha256: digest, inline_complete: true, content: answer } : { agent_id: id, available: false };
        break;
      case 'run.answer_chunk': {
        if (demoId(id) !== 'demo-finished' || params.sequence !== 1 || params.expected_sha256 !== digest || params.offset_bytes !== 0) return fail('demo_answer_mismatch');
        data = { agent_id: id, sequence: 1, sha256: digest, total_bytes: Buffer.byteLength(answer), offset_bytes: 0, next_offset: Buffer.byteLength(answer), content: answer, complete: true };
        break;
      }
      case 'run.models':
        data = { schema_version: 2, providers: [{ provider: 'synthetic', models: [{ model: 'model-alpha', profiles: ['observer'], quota: { status: 'unknown', evidence: 'missing', newest_observed_at: null } }] }], profiles: [], ranked_at: observed };
        break;
      case 'run.limits':
        data = { items: [], observed_at: observed };
        break;
      case 'pool.identity':
        data = product('identity', { product: 'agent-pool', version: 'demo', qualification: 'synthetic', capabilities: ['identity', 'list', 'get', 'history_window_v1'], observed_at_unix_ms: observed * 1000 });
        break;
      case 'pool.list': {
        const after = typeof params.after === 'string' ? params.after : null;
        const rows = after === null || after < standalonePool.pool_id ? [{ pool: standalonePool, leader_id: 'synthetic-leader' }] : [];
        data = product('pool_page', { pools: rows, cursor: rows.length ? standalonePool.pool_id : after, has_more: false, returned: rows.length, observed_at_unix_ms: observed * 1000, source_timestamp: null, coverage: 'Synthetic independently observed page.' });
        break;
      }
      case 'pool.get': {
        if (params.pool_id !== standalonePool.pool_id) return fail('demo_pool_missing');
        if (params.section === 'history' && (params.direction === 'forward' || params.direction === 'backward')) {
          const watermark = typeof params.through === 'string' ? params.through : '1', after = String(params.after ?? '0'), before = typeof params.before === 'string' ? params.before : null;
          const selected = events.filter(event => BigInt(event.event_id) <= BigInt(watermark) && (params.direction === 'forward' ? BigInt(event.event_id) > BigInt(after) : before === null || BigInt(event.event_id) < BigInt(before))).map(event => ({ ...event, event_id_exact: String(event.event_id) }));
          const cursor = selected.length ? String(params.direction === 'backward' ? selected[0].event_id : selected.at(-1)!.event_id) : params.direction === 'backward' ? '0' : after;
          const view = { section: 'history', pool: standalonePool, members: [], active: 1, pending: 0, events: selected, deliveries: [], next_after: Number(cursor), has_more: false };
          data = product('pool_detail', { section: 'history', view, leader_id: 'synthetic-leader', decisions: [], cursor, has_more: false, returned: selected.length, history_watermark: watermark, observed_at_unix_ms: observed * 1000, source_timestamp: null, coverage: 'Synthetic journal snapshot.' });
          break;
        }
        const section = typeof params.section === 'string' ? params.section : 'members', after = typeof params.after === 'number' ? params.after : 0;
        const bindings = params.include_bindings === true ? after === 0 ? [{ member, pool_id: standalonePool.pool_id, actor: null, address: null, run_id: DEMO_POOL_AGENT_ID, run_sequence: 1 }] : [] : undefined;
        const members = section === 'members' && after === 0 ? [member] : [];
        const messages = section === 'history' ? events.filter(event => event.event_id > after) : [];
        const deliveries = section === 'deliveries' && after === 0 ? [{ operation_id: 'demo-delivery', member_id: member.member_id, operation: 'deliver', state: 'accepted' }] : [];
        const decision = section === 'proposal' ? { ...proposal, votes: {} } : section === 'votes' ? proposal : null;
        const view = section === 'decisions' ? null : { section, pool: { ...standalonePool, proposal: decision }, members, active: 1, pending: 0, events: messages, deliveries, next_after: section === 'members' ? after + members.length : section === 'history' ? messages.at(-1)?.event_id ?? after : section === 'deliveries' ? after + deliveries.length : section === 'votes' ? after + Object.keys(proposal.votes).length : after, has_more: false };
        const decisions = section === 'decisions' && after === 0 ? [{ ...proposal, votes: {} }] : [];
        const next = view?.next_after ?? after + decisions.length;
        const returned = section === 'members' ? members.length : section === 'history' ? messages.length : section === 'deliveries' ? deliveries.length : section === 'proposal' ? Number(decision !== null) : section === 'votes' ? Object.keys(proposal.votes).length : decisions.length;
        data = product('pool_detail', { section, view, leader_id: 'synthetic-leader', ...(bindings ? { bindings } : {}), decisions, cursor: String(next), has_more: false, returned, observed_at_unix_ms: observed * 1000, source_timestamp: null, coverage: 'Synthetic independently observed page.' });
        break;
      }
      case 'bridge.identity':
        data = product('identity', { product: 'agent-bridge', version: 'demo', source_timestamp: null, coverage: 'retained_history' });
        break;
      case 'bridge.overview':
        data = product('bridge_overview', { counts: { unhanded: 1, reserved: 0, invoking: 0, held: 0, review: 0, accepted: 2, hook_submitted: 0, refused: 0, disposed: 0, open_incidents: 1 }, retention: { events: 3, payload_compacted: 0, envelope_bytes: 0, oldest_accepted_at_ms: (observed - 3600) * 1000, newest_accepted_at_ms: (observed - 120) * 1000 }, coverage: 'retained_history' });
        break;
      case 'bridge.deliveries':
        data = product('delivery_page', { deliveries: [{ acceptance_seq: 1, publisher: 'synthetic', event_id: 'demo-delivery', custody_state: 'accepted', delivery_state: 'unknown', accepted_at_ms: (observed - 120) * 1000, evidence_tiers: {} }], through_seq: 1, next_after_seq: null, coverage: 'retained_history' });
        break;
      case 'bridge.incidents':
        data = product('incident_page', { incidents: [{ incident_seq: 1, publisher: 'synthetic', event_id: 'demo-incident', state: 'open', created_ms: (observed - 1800) * 1000, updated_ms: (observed - 1700) * 1000 }], through_seq: 1, next_after_seq: null, coverage: 'retained_history' });
        break;
      case 'quota.status':
        data = { product: 'agent-quota', status: 'running', started_at: observed - 86400, source_count: 2, last_collection: { observed_at: observed - 60, ok: true, error: null, sources: [] }, external_collection: [{ account: 'demo-account', provider: 'demo', source: 'demo-source', accepted_at: observed - 90, revision: 7 }] };
        break;
      case 'quota.snapshot': {
        const window = (pool: string, models: string[], remaining: number | null, name = 'five_hour', lane = 'primary', resetIn = 7200, burn = 2.5) => ({ runtime: 'demo', lane, pool, source: 'demo-source', window: name, target: null, models, observed_at: remaining === null ? null : observed - 90, valid_until: remaining === null ? null : observed + 810, last_remaining_percent: remaining, last_reset_at: remaining === null ? null : observed + resetIn, forecast: { known: remaining !== null, risk: remaining === null ? 'unknown' : 'low', sustainable_percent_per_hour: null, burn_percent_per_hour: remaining === null ? null : burn }, evaluation: remaining === null ? null : { risk: remaining < 30 ? 'medium' : 'low', marker: 'projected', projected_percent: remaining - burn * resetIn / 3600, burn_percent_per_hour: burn } });
        const model = (name: string, pool: string, remaining: number | null, windowName = 'five_hour', resetIn = 7200, burn = 2.5) => ({ provider: 'demo', model: name, native_model: name, state: remaining === null ? 'unknown' : 'known', state_validity: remaining === null ? { kind: 'unknown' } : { kind: 'until', at: observed + 810 }, quota_score: remaining === null ? null : 1 + remaining / 100, limiting_window: remaining === null ? null : { pool, source: 'demo-source', window: windowName }, remaining_percent: remaining, burn_percent_per_hour: remaining === null ? null : burn, reset_at: remaining === null ? null : observed + resetIn, risk: remaining === null ? 'unknown' : remaining < 30 ? 'medium' : 'low', evidence: remaining === null ? 'missing' : 'fresh', newest_observed_at: remaining === null ? null : observed - 90, exhausted_until: null, pools: [pool] });
        data = { schema_version: 2, source_epoch: 'demo', revision: 7, config_revision: 'demo', evaluated_at: observed, coverage: { state: 'partial', unobserved: [], last_collection: { observed_at: observed - 60, ok: true, error: null, sources: [{ account: 'demo-account', provider: 'demo', source: 'demo-source', status: 'collected', windows: 1, issues: [] }, { account: 'demo-unknown', provider: 'demo', source: 'demo-source', status: 'failed', windows: 0, issues: ['collector_timeout'] }] } }, accounts: [
          { account: 'demo-account', models: [model('model-alpha', 'demo-account::primary', 72), model('model-beta', 'demo-account::secondary', 26, 'seven_day', 194400, 1.2)], windows: [window('demo-account::primary', ['model-alpha', 'model-beta'], 72), window('demo-account::secondary', ['model-alpha', 'model-beta'], 26, 'seven_day', 'secondary', 194400, 1.2)], latches: [], advice: [{ recommendations: ['demo-account/secondary seven_day is trending toward exhaustion; pace new requests.'] }] },
          { account: 'demo-unknown', models: [model('model-gamma', 'demo-unknown::primary', null)], windows: [window('demo-unknown::primary', ['model-gamma'], null)], latches: [], advice: [{ recommendations: ['demo-unknown capacity is unknown; treat limits as unverified.'] }] },
        ] };
        break;
      }
      case 'hub.repositories':
        data = { repositories: ['/demo/agent-hub', '/demo/agent-quota', '/demo/skills'] };
        break;
      case 'worktree.list': {
        const row = (key: string, path: string, kind: string, branch: string, activity: string, integration: string, repo: string) => ({ key, class: kind, path, branch: `refs/heads/${branch}`, detached: false, head: 'a'.repeat(40), repo_id: repo, repo_common_dir: `${repo}/.git`, creator: null, removal_started: false, activity: { state: activity, mtime_based: true }, integration, size: null });
        const rows = params.repo === '/demo/agent-hub'
          ? [row('demo/agent-hub', '/demo/agent-hub', 'main', 'main', 'recent', 'ancestor_merged', '/demo/agent-hub'), row('demo/workspace', '/demo/workspace', 'managed', 'feature/demo', 'idle_candidate', 'unmerged', '/demo/agent-hub'), row('demo/agent-hub-spike', '/demo/agent-hub-spike', 'foreign', 'spike/old', 'stale_candidate', 'ancestor_merged', '/demo/agent-hub')]
          : params.repo === '/demo/skills' ? [row('demo/skills', '/demo/skills', 'main', 'main', 'recent', 'ancestor_merged', '/demo/skills')] : null;
        // A repository Git refuses to read keeps the producer's structured error.
        if (!rows) return fail('source_error');
        data = product('worktree_page', { returned: rows.length, has_more: false, cursor: null, rows, hygiene: { idle: 1, stale: 1, unmerged: 1, missing: 0 }, coverage: { repos: 1, failed: [], root_unconfigured: false } });
        break;
      }
      case 'worktree.inspect': {
        const GiB = 1024 ** 3, path = String(params.path), checks = params.checks && typeof params.checks === 'object' ? params.checks as Record<string, unknown> : null;
        const facts: Record<string, { counts: [number, number, number]; bytes: number; quality: string }> = {
          '/demo/agent-hub': { counts: [0, 2, 1], bytes: 430 * 1024 ** 2, quality: 'complete' }, '/demo/workspace': { counts: [1, 3, 1], bytes: Math.round(1.2 * GiB), quality: 'complete' },
          '/demo/agent-hub-spike': { counts: [0, 0, 0], bytes: Math.round(3.4 * GiB), quality: 'lower_bound' }, '/demo/skills': { counts: [0, 0, 0], bytes: 52 * 1024 ** 2, quality: 'complete' },
        };
        const known = facts[path] ?? facts['/demo/agent-hub']!, workspace = path === '/demo/workspace';
        data = product('worktree_detail', { key: workspace ? 'demo/workspace' : 'demo/agent-hub', class: workspace ? 'managed' : 'main', path, branch: 'refs/heads/feature/demo', detached: false, head: 'a'.repeat(40), repo_common_dir: '/demo/agent-hub/.git', activity: 'recent', activity_signals: { head_mtime: observed - 600, index_mtime: observed - 300, last_reflog_entry: observed - 300 }, probes: { status: { state: 'known', value: { staged: known.counts[0], unstaged: known.counts[1], untracked: known.counts[2], conflicts: 0 }, code: null, reason: null }, integration: { state: 'known', value: 'unmerged', code: null, reason: null }, processes: { state: 'unavailable', value: null, code: 'probe_timeout', reason: null }, submodules: { state: 'not_checked', value: null, code: null, reason: null }, size: checks?.size === true ? { state: known.quality === 'complete' ? 'known' : 'incomplete', value: { bytes: known.bytes, quality: known.quality }, code: null, reason: known.quality === 'complete' ? null : 'budget' } : { state: 'not_checked', value: null, code: null, reason: null } }, warnings: [{ code: 'unmerged' }], hygiene: { stale_activity: false, large: false, missing: false }, record: null, observed_at: observed });
        break;
      }
      default:
        return fail('demo_resource_unsupported');
    }
    return { schema_version: 1, source: resource.split('.')[0]!, resource, observed_at_ms: Date.now(), outcome: 'ok', data, error: null };
  }

  return { read, async close() { closed = true; } };
}
