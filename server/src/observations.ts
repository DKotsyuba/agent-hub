/** Independent Quota, Bridge, Overview and Worktree projections. */
import { worktreeDetail as decodeWorktreeDetail, type Coverage, type Observation, type Overview, type Quota, type Worktree, type WorktreeDetail } from '@agent-hub/domain';
import { activeStatus, basename, bridgeData, heldRow, integer, longestWorktree, object, pendingCount, scanDeliveriesNewestFirst, text, usable, type LiveWorktree } from '../../src/live/protocol.ts';
import { quotaSnapshot, quotaStatus } from '../../terminal/src/quota.ts';
import { projectQuotaSnapshot, quotaWindowForecast } from '../../packages/view-model/src/index.ts';
import { repositoriesData, worktreeDetail, worktreeFacts, worktreePage } from '../../terminal/src/worktree.ts';
import { digest, type Position } from './cursor.ts';
import { HubError } from './errors.ts';
import { coverage, inPeriod, ms, noPage, observed, optionalObject, projectId, records, requireData, type Input, type ReadContext } from './projection.ts';
import { runInventory } from './run.ts';

/** Builds a Quota snapshot while preserving nullable values and producer-specific clocks. */
function snapshot(value: unknown): NonNullable<Quota['snapshot']> {
  const parsed = quotaSnapshot(value);
  return {
    revision: parsed.revision, configRevision: parsed.configRevision, evaluatedAtMs: ms(parsed.evaluatedAt),
    coverage: { ...parsed.coverage, lastCollectionAtMs: ms(parsed.coverage.lastCollectionAt) },
    accounts: parsed.accounts.map(account => ({
      account: account.account, advice: account.advice, resetCredits: account.resetCredits,
      models: account.models.map(({ validity, resetAt, newestObservedAt, exhaustedUntil, ...model }) => ({
        ...model, validity: validity.kind === 'until' ? { kind: 'until', atMs: ms(validity.at)! } : validity,
        resetAtMs: ms(resetAt), newestObservedAtMs: ms(newestObservedAt), exhaustedUntilMs: ms(exhaustedUntil),
      })),
      windows: account.windows.map(({ observedAt, validUntil, lastResetAt, ...window }) => ({
        ...window, observedAtMs: ms(observedAt), validUntilMs: ms(validUntil), lastResetAtMs: ms(lastResetAt),
      })),
      latches: account.latches.map(({ observedAt, resetAt, ...latch }) => ({ ...latch, observedAtMs: ms(observedAt), resetAtMs: ms(resetAt) })),
    })),
  };
}

/** Selects the earliest fresh window that is behind even pace and will run out before reset. */
function earliestExhaustion(snapshot: NonNullable<Quota['snapshot']>, now: number): NonNullable<Overview['quota']>['exhaustion'] {
  let earliest: NonNullable<Overview['quota']>['exhaustion'];
  for (const account of projectQuotaSnapshot(snapshot).accounts) {
    for (const window of account.windows) {
      const { stale, note, exhaust, resetAt } = quotaWindowForecast(window, now / 1000);
      if (stale || note.kind !== 'deficit' || exhaust.kind !== 'runs_out' || exhaust.seconds === null || resetAt === null) continue;
      const atMs = Math.round(now + exhaust.seconds * 1000);
      if (earliest && earliest.atMs <= atMs) continue;
      const provider = account.models.find(model => window.models.includes(model.model))?.provider
        ?? snapshot.coverage.sources.find(source => source.account === account.account)?.provider;
      earliest = { account: account.account, provider, window: window.window, lane: window.lane, atMs,
        resetAtMs: ms(resetAt)!, validUntilMs: ms(window.validUntil) };
    }
  }
  return earliest;
}

/** Reads status and snapshot independently and keeps a useful sibling after a failure. */
export async function quota(ctx: ReadContext) {
  const [statusRead, snapshotRead] = await Promise.all([ctx.read('quota.status'), ctx.read('quota.snapshot')]);
  const observations = [observed(statusRead), observed(snapshotRead)];
  let status: Quota['status'] = null, data: Quota['snapshot'] = null;
  if (usable(statusRead)) {
    try {
      const { startedAt, lastCollectionAt, external, ...parsed } = ctx.project(statusRead, quotaStatus);
      status = { ...parsed, startedAtMs: ms(startedAt), lastCollectionAtMs: ms(lastCollectionAt),
        external: external.map(({ acceptedAt, ...row }) => ({ ...row, acceptedAtMs: ms(acceptedAt) })) };
      observations[0].producerAtMs = status.lastCollectionAtMs;
    } catch { observations[0].outcome = 'invalid'; }
  }
  if (usable(snapshotRead)) {
    try {
      data = ctx.project(snapshotRead, snapshot);
      observations[1] = observed(snapshotRead, data.evaluatedAtMs, coverage('source_snapshot', data.coverage.state === 'complete', 'snapshot'));
    } catch { observations[1].outcome = 'invalid'; }
  }
  if (!status && !data) {
    if (observations.some(value => value.outcome === 'invalid')) throw new HubError('invalid_projection');
    requireData(snapshotRead);
  }
  return { data: { status, snapshot: data }, observations };
}

/** Reads a fixed Bridge watermark, validates ordering and caps filtered scans. */
async function bridgeScan(ctx: ReadContext, resource: 'bridge.incidents' | 'bridge.deliveries', from: number, through: number | null, limit: number, includeClosed = false, maxPages = 5) {
  const isIncident = resource === 'bridge.incidents';
  const field = isIncident ? 'incidents' : 'deliveries';
  const seq = isIncident ? 'incident_seq' : 'acceptance_seq';
  const items: Record<string, unknown>[] = [];
  let after = from, next: number | null = null;
  let observation: Observation | undefined;
  let scanPartial = false;
  for (let index = 0; index < maxPages; index++) {
    const envelope = await ctx.read(resource, { limit, after_seq: after, ...(through === null ? {} : { through_seq: through }),
      ...(isIncident ? { include_closed: includeClosed } : {}) });
    const page = ctx.project(envelope, value => bridgeData(value, isIncident ? 'incident_page' : 'delivery_page'));
    const upper = integer(page.through_seq);
    if (through !== null && through !== upper) throw new HubError('stale_boundary');
    through = upper;
    scanPartial ||= envelope.outcome !== 'ok' || page.scan_partial === true;
    observation ??= observed(envelope);
    let last = after;
    for (const row of records(page[field])) {
      const position = integer(row[seq]);
      if (position <= last || position > upper) throw new HubError('invalid_projection');
      last = position;
      items.push({ ...row, receiptAtMs: envelope.observed_at_ms });
    }
    next = page.next_after_seq === null ? null : integer(page.next_after_seq);
    if (next === null) break;
    if (next !== last || next <= after || next >= upper) throw new HubError('invalid_projection');
    after = next;
  }
  const complete = next === null && !scanPartial;
  const scope = coverage('retained', complete, 'snapshot');
  return { items, next, through: through!, observation: { ...observation!, coverage: scope, outcome: !complete && observation?.outcome === 'ok' ? 'partial' as const : observation!.outcome } };
}

/** Filters within the fixed incident journal and uses producer positions for continuation. */
export async function incidents(ctx: ReadContext, query: Input<'incidents'>, position: Position | null) {
  const at = Number(position?.at ?? 0);
  const result = await bridgeScan(ctx, 'bridge.incidents', at, position?.through === undefined ? null : Number(position.through),
    Math.min(query.limit, 100), query.includeClosed, 1);
  const items = result.items.filter(item => inPeriod(query, item.created_ms == null ? null : integer(item.created_ms))).map(item => ({
    id: 'incident-' + integer(item.incident_seq), publisher: text(item.publisher), eventId: text(item.event_id), state: item.state,
    closed: ['closed', 'resolved', 'authorized', 'disposed'].includes(String(item.state)) ? true : item.state === 'open' ? false : null,
    createdAtMs: item.created_ms ?? null, updatedAtMs: item.updated_ms ?? null, detail: text(item.detail ?? item.reason),
  }));
  const next = result.next === null ? null : ctx.cursors.encode(query, { at: result.next, direction: 'newer', fence: null, through: String(result.through) });
  return { data: { items }, page: { ...noPage, next }, observations: [result.observation], capabilities: { bridgeIncidents: 'supported' } };
}

/**
 * Lists accepted-but-undelivered Bridge messages. The total comes from the observer overview `counts` (`pending`), so a new
 * hold is counted whatever the history size; the rows come from a newest-first windowed scan of `bridge.deliveries`
 * (`limit: 1` probe for `through_seq`, then `{ limit: 100, after_seq: upper - 100, through_seq: upper }` windows, five at most).
 * Age and thresholds are a client concern. An overview an older Bridge cannot answer leaves `pending` absent.
 */
export async function held(ctx: ReadContext) {
  let first: Observation | undefined, degraded = false;
  const [overviewRead, scanned] = await Promise.allSettled([
    ctx.read('bridge.overview'),
    scanDeliveriesNewestFirst(async (after, through, limit) => {
      const envelope = await ctx.read('bridge.deliveries', { limit, after_seq: after, ...(through === null ? {} : { through_seq: through }) });
      const page = ctx.project(envelope, value => bridgeData(value, 'delivery_page'));
      first ??= observed(envelope);
      degraded ||= envelope.outcome !== 'ok';
      return page;
    }),
  ]);
  if (scanned.status === 'rejected') throw scanned.reason instanceof Error && scanned.reason.message === 'bridge_window' ? new HubError('invalid_projection') : scanned.reason;
  const scan = scanned.value;
  if (!scan || !first) throw new HubError('invalid_projection');
  const complete = scan.reachedStart && !scan.partial && !degraded;
  const observation: Observation = { ...first, coverage: coverage('retained', complete, 'snapshot'),
    outcome: !complete && first.outcome === 'ok' ? 'partial' : first.outcome };
  const pending = overviewRead.status === 'fulfilled' && usable(overviewRead.value) ? pendingCount(overviewRead.value.data) : null;
  const items = scan.rows.flatMap(row => heldRow(row) ?? []);
  return { data: { items, complete, ...(pending === null ? {} : { pending }), oldestScannedAtMs: scan.oldestScannedAtMs }, observations: [observation] };
}

/** Classifies one failed producer without dropping useful sibling data. */
function failed(source: Observation['source'], error: unknown): Observation {
  const code = error instanceof HubError ? error.code : 'invalid_projection';
  const outcome = code === 'unsupported_capability' ? 'incompatible' : code === 'invalid_projection' ? 'invalid' : 'unavailable';
  return { source, outcome, observedAtMs: Date.now(), producerAtMs: null, issue: { code } };
}

/** Returns independent current and period metrics under bounded source scans. */
export async function overview(ctx: ReadContext, query: Input<'overview'>) {
  const [run, active, bridge, deliveries, incidents, quotaResult] = await Promise.allSettled([
    runInventory(ctx), runInventory(ctx, true), ctx.read('bridge.overview'), bridgeScan(ctx, 'bridge.deliveries', 0, null, 100),
    bridgeScan(ctx, 'bridge.incidents', 0, null, 100, true), quota(ctx),
  ]);
  const unknown = { kind: 'unknown', value: null } as const;
  const metric = (value: number, complete: boolean) => ({ kind: complete ? 'exact' as const : 'lower_bound' as const, value });
  const data: Overview = { from: query.from, to: query.to, run: null, bridge: null, quota: null };
  const observations: Observation[] = [];
  if (run.status === 'fulfilled' || active.status === 'fulfilled') {
    const history = run.status === 'fulfilled' ? run.value : null, current = active.status === 'fulfilled' ? active.value : null;
    const rows = history?.rows ?? [];
    const currentRows = current?.rows ?? rows.filter(item => activeStatus(item.status));
    const receipt = history?.observation.observedAtMs ?? 0;
    const bounded = query.from !== null || query.to !== null;
    const observedPeriod = !!history && (query.from === null || receipt >= query.from);
    const coversPeriod = !bounded || query.to === null || query.to > Date.now() || receipt >= query.to;
    /** Accepts only a reported clock within the selected period and observed by the receipt. */
    const counted = (clock: number | null) => !bounded || clock !== null && clock <= receipt && inPeriod(query, clock);
    const finished = rows.filter(item => !activeStatus(item.status));
    const inFinish = finished.filter(item => counted(item.finishedAtMs));
    const exact = history?.observation.coverage?.state === 'complete';
    const exactStarted = exact && coversPeriod && (!bounded || rows.every(item => item.createdAtMs !== null && item.createdAtMs <= receipt));
    const exactFinished = exact && coversPeriod && (!bounded || finished.every(item => item.finishedAtMs !== null && item.finishedAtMs <= receipt));
    data.run = {
      active: metric(currentRows.length, current ? current.observation.coverage?.state === 'complete' : exact), current: currentRows.slice(0, 50),
      started: observedPeriod ? metric(rows.filter(item => counted(item.createdAtMs)).length, exactStarted) : unknown,
      succeeded: observedPeriod ? metric(inFinish.filter(item => item.status === 'succeeded').length, exactFinished) : unknown,
      failed: observedPeriod ? metric(inFinish.filter(item => ['failed', 'lost', 'timed_out'].includes(item.status)).length, exactFinished) : unknown,
      finished: observedPeriod ? metric(inFinish.length, exactFinished) : unknown,
    };
  }
  for (const result of [run, active]) observations.push(result.status === 'fulfilled' ? result.value.observation : failed('run', result.reason));
  const bridgeObservation = bridge.status === 'fulfilled' ? observed(bridge.value) : failed('bridge', bridge.reason);
  let bridgeDataResult = null;
  if (bridge.status === 'fulfilled' && usable(bridge.value)) {
    try { bridgeDataResult = ctx.project(bridge.value, value => bridgeData(value, 'bridge_overview')); }
    catch { bridgeObservation.outcome = 'invalid'; }
  }
  /** Count only rows with producer clocks bounded by their own receipt. */
  const bridgeMetric = (scan: Awaited<ReturnType<typeof bridgeScan>>, field: string) => {
    if (query.from !== null && scan.observation.observedAtMs < query.from) return unknown;
    let complete = scan.observation.coverage?.state === 'complete';
    let count = 0;
    for (const row of scan.items) {
      const at = row[field];
      if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0 || at > Number(row.receiptAtMs)) complete = false;
      else if (inPeriod(query, at)) count++;
    }
    if (query.to !== null && query.to <= Date.now() && scan.observation.observedAtMs < query.to) complete = false;
    return !complete && count === 0 ? unknown : metric(count, complete);
  };
  if (deliveries.status === 'fulfilled' || incidents.status === 'fulfilled' || bridgeDataResult) {
    data.bridge = {
      accepted: deliveries.status === 'fulfilled' ? bridgeMetric(deliveries.value, 'accepted_at_ms') : unknown,
      incidents: incidents.status === 'fulfilled' ? bridgeMetric(incidents.value, 'created_ms') : unknown,
      pending: unknown,
    };
  }
  observations.push(bridgeObservation);
  for (const result of [deliveries, incidents]) observations.push(result.status === 'fulfilled' ? result.value.observation : failed('bridge', result.reason));
  if (quotaResult.status === 'fulfilled') {
    observations.push(...quotaResult.value.observations);
    const snapshot = quotaResult.value.data.snapshot;
    if (snapshot) {
      const now = Date.now();
      const models = snapshot.accounts.flatMap(account => account.models.map(model => ({
        ...model, account: account.account,
        stale: model.evidence === 'stale' || model.validity.kind === 'until' && model.validity.atMs <= now,
      })));
      const lowest = models.filter(model => model.state !== 'unknown' && model.remaining !== null)
        .sort((a, b) => Number(a.stale) - Number(b.stale) || a.remaining! - b.remaining!)[0];
      data.quota = { accounts: snapshot.accounts.length, known: models.filter(model => model.state === 'known').length,
        unknown: models.filter(model => model.state === 'unknown').length, exhausted: models.filter(model => model.state === 'exhausted').length,
        stale: models.filter(model => model.stale).length, exhaustion: earliestExhaustion(snapshot, now),
        lowest: lowest ? { account: lowest.account, model: lowest.model, remaining: lowest.remaining!, provider: lowest.provider, ...(lowest.stale ? { stale: true } : {}) } : null };
    }
  } else observations.push(failed('quota', quotaResult.reason));
  if (!data.run && !data.bridge && !data.quota && quotaResult.status === 'rejected') {
    if (observations.every(row => row.outcome === 'incompatible')) throw new HubError('unsupported_capability');
    if (observations.every(row => row.outcome === 'invalid')) throw new HubError('invalid_projection');
    throw new HubError('source_unavailable');
  }
  return { data, observations };
}

/** A source-attested Worktree row with a private inventory identity. */
interface Listed {
  repo: string;
  key: string;
  row: Worktree;
}

/** Inspected details expire after ten minutes and are never eagerly refreshed. */
export type WorktreeCache = Map<string, { expires: number; details: WorktreeDetail; observation: Observation }>;

/** Derives IDs from configured inventory and labels the bounded coverage of each project. */
async function worktreeInventory(ctx: ReadContext, cache: WorktreeCache, project: string | null) {
  const configured = await ctx.read('hub.repositories');
  const knownRepos = [...new Set(ctx.project(configured, repositoriesData))];
  const repos = knownRepos.length ? knownRepos.filter(repo => project === null || projectId(repo) === project).sort() : [null];
  const projects: { id: string; name: string; path: string; coverage: Coverage }[] = [];
  const listed: Listed[] = [];
  const observations: Observation[] = [];
  let inventoryBudget = 20;
  for (const repo of repos.slice(0, 20)) {
    let next: string | null = null, complete = true;
    let source: Observation | undefined;
    const seen = new Set<string>();
    for (let index = 0; index < 3 && inventoryBudget > 0; index++) {
      inventoryBudget--;
      const envelope = await ctx.read('worktree.list', { ...(repo ? { repo } : {}), limit: 20, ...(next ? { cursor: next } : {}) });
      source = observed(envelope);
      if (!usable(envelope)) { complete = false; break; }
      const page = ctx.project(envelope, worktreePage);
      complete &&= envelope.outcome === 'ok' && page.coverage.budget_exhausted !== true && page.coverage.root_unconfigured !== true
        && page.coverage.orphan_scan_truncated !== true && !(Array.isArray(page.coverage.failed) && page.coverage.failed.length);
      for (const row of page.rows) {
        const repoPath = repo ?? row.repoCommonDir?.replace(/\/\.git$/, '') ?? null;
        if (!repoPath?.startsWith('/') || project !== null && project !== projectId(repoPath)) continue;
        const id = 'wt-' + digest([repoPath, row.key]);
        const facts = cache.get(id);
        const current = facts && facts.expires > Date.now() && facts.details.worktree.path === row.path ? facts.details.worktree.facts : null;
        listed.push({ repo: repoPath, key: row.key, row: { id, projectId: projectId(repoPath), class: row.class, path: row.path,
          branch: row.branch, detached: row.detached, head: row.head, activity: row.activity, mtimeBased: row.mtimeBased,
          integration: row.integration, removalStarted: row.removalStarted, creator: row.creator, sessions: [],
          facts: current ?? { observedAtMs: null, expiresAtMs: null, status: { state: 'not_checked', code: null }, size: { state: 'not_checked', code: null } },
        } });
      }
      next = page.cursor;
      if (!page.hasMore) { next = null; break; }
      if (!next || seen.has(next)) throw new HubError('invalid_projection');
      seen.add(next);
    }
    const scope = coverage('listed_inventory', complete && next === null && !!source, 'offset_unfenced');
    for (const path of repo ? [repo] : [...new Set(listed.map(item => item.repo))].sort()) {
      projects.push({ id: projectId(path), name: basename(path), path, coverage: scope });
    }
    if (source) observations.push({ ...source, coverage: scope, outcome: scope.state === 'partial' && source.outcome === 'ok' ? 'partial' : source.outcome });
  }
  if ((!observations.length && repos.length > 0) || observations.length && observations.every(row => !['ok', 'partial'].includes(row.outcome))) {
    throw new HubError(observations.every(row => row.outcome === 'incompatible') ? 'unsupported_capability' : 'source_unavailable');
  }
  if (knownRepos.length && projects.length < repos.length || inventoryBudget === 0) observations.push(observed(configured, null, coverage('listed_inventory', false)));
  if (!observations.length) observations.push(observed(configured, null, coverage('listed_inventory', true)));
  const rows = [...new Map(listed.map(item => [item.row.id, item])).values()].sort((a, b) => a.row.id.localeCompare(b.row.id));
  try {
    const run = await runInventory(ctx);
    observations.push(run.observation);
    const agents = run.rows.filter(agent => !agent.projectInferred);
    const publicRows: LiveWorktree[] = rows.flatMap(({ row, repo }) => row.path ? [{ key: row.id, common: repo, path: row.path, branch: row.branch, raw: {} }] : []);
    const byId = new Map(rows.map(item => [item.row.id, item.row]));
    for (const agent of agents) {
      const id = longestWorktree(agent.workdir, publicRows)?.key;
      if (id) byId.get(id)?.sessions.push({ sessionId: agent.id, execution: agent.execution, match: 'unverified' });
    }
  } catch (error) { observations.push(failed('run', error)); }
  return { rows, projects, observations };
}

/** Lists a stable bounded set without performing Worktree inspection. */
export async function worktrees(ctx: ReadContext, query: Input<'worktrees'>, position: Position | null, cache: WorktreeCache) {
  const result = await worktreeInventory(ctx, cache, query.project);
  const items = result.rows.map(item => item.row);
  const page = ctx.cursors.slice(query, position, items, digest(items.map(({ id, path, branch, head }) => [id, path, branch, head])), query.limit);
  return { data: { projects: result.projects, items: page.items }, page: page.page, observations: result.observations };
}

/** Resolves an exact listed ID before issuing a single private, bounded status/size probe. */
export async function worktree(ctx: ReadContext, query: Input<'worktree'>, cache: WorktreeCache) {
  const result = await worktreeInventory(ctx, cache, null);
  const listed = result.rows.find(item => item.row.id === query.id);
  if (!listed) throw new HubError('not_found');
  const row = listed.row;
  const cached = cache.get(query.id);
  if (cached && cached.expires > Date.now() && cached.details.worktree.path === row.path) {
    return { data: { ...cached.details, worktree: { ...row, facts: cached.details.worktree.facts } }, observations: [...result.observations, cached.observation] };
  }
  if (!row.path?.startsWith('/')) return { data: { worktree: row, coverage: coverage('current', false), probes: [], warnings: [] }, observations: result.observations };
  const envelope = await ctx.read('worktree.inspect', { repo: listed.repo, path: row.path, checks: { status: true, size: true } });
  const observation = observed(envelope);
  if (!usable(envelope)) return { data: { worktree: row, coverage: coverage('current', false), probes: [], warnings: [{ code: 'inspect_unavailable' }] }, observations: [...result.observations, observation] };
  const data = ctx.project(envelope, worktreeDetail);
  if (data.key !== listed.key || data.path !== row.path) throw new HubError('stale_boundary');
  const facts = worktreeFacts(data), expires = envelope.observed_at_ms + 600_000;
  for (const axis of [facts.status, facts.size]) {
    if (axis.state !== 'known' && axis.code && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(axis.code)) axis.code = null;
  }
  const signals = optionalObject(data.activity_signals), record = optionalObject(data.record), hygiene = optionalObject(data.hygiene);
  const details = decodeWorktreeDetail({ worktree: { ...row, facts: { ...facts, observedAtMs: envelope.observed_at_ms, expiresAtMs: expires } },
    coverage: coverage('current', envelope.outcome === 'ok'),
    warnings: Array.isArray(data.warnings) ? records(data.warnings).flatMap(warning =>
      typeof warning.code === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(warning.code) ? [{ code: warning.code }] : []) : [],
    inspectedAtMs: ms(data.observed_at), repositoryPath: listed.repo,
    activitySignals: { headMtimeMs: ms(signals.head_mtime), indexMtimeMs: ms(signals.index_mtime), reflogAtMs: ms(signals.last_reflog_entry) },
    hygiene: ['stale_activity', 'large', 'missing'].flatMap(key => typeof hygiene[key] === 'boolean' ? [{ key, value: String(hygiene[key]) }] : []),
    managedRecord: data.record == null ? null : ['creator', 'purpose', 'session', 'revision'].flatMap(key =>
      typeof record[key] === 'string' || typeof record[key] === 'number' ? [{ key, value: String(record[key]) }] : []),
    probes: Object.entries(object(data.probes)).map(([name, value]) => {
      const probe = optionalObject(value);
      return { name, state: text(probe.state) ?? 'unknown', code: text(probe.code), detail: null };
    }),
  });
  if (cache.size >= 256 && !cache.has(query.id)) cache.delete(cache.keys().next().value!);
  cache.set(query.id, { expires, details, observation });
  return { data: details, observations: [...result.observations, observation], capabilities: { worktreeInspect: 'supported' } };
}
