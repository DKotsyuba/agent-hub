/** Runtime-checked Quota snapshot (schema 2) and status projections for display only.
 * Absent or null producer values stay Unknown; they are never shown as zero capacity. */

/** Recognized model state classes; any other value rejects the snapshot. */
export type QuotaState = 'known' | 'unknown' | 'exhausted';

/** One configured model's governing quota state. */
export interface QuotaModel {
  provider: string; model: string; nativeModel: string | null; state: QuotaState;
  validity: { kind: 'until'; at: number } | { kind: 'latched_no_reset' } | { kind: 'unknown' };
  score: number | null; window: { pool: string; source: string; window: string } | null;
  remaining: number | null; burn: number | null; resetAt: number | null; risk: string; evidence: string;
  newestObservedAt: number | null; exhaustedUntil: number | null; pools: string[];
}
/** One physical provider window with its latest sample and forecast. */
export interface QuotaWindow {
  pool: string; source: string; window: string; lane: string; runtime: string; models: string[];
  observedAt: number | null; validUntil: number | null; lastRemaining: number | null; lastResetAt: number | null;
  forecastKnown: boolean; risk: string; marker: string | null; projected: number | null; sustainable: number | null; burn: number | null;
}
/** An exhaustion latch, independent of sample freshness. */
export interface QuotaLatch { pool: string; window: string; source: string; active: boolean; observedAt: number | null; resetAt: number | null; models: string[] }
/** One account's models, windows, latches and advice. */
export interface QuotaAccount { account: string; models: QuotaModel[]; windows: QuotaWindow[]; latches: QuotaLatch[]; advice: string[] }
/** One collection source result from the latest round. */
export interface QuotaSource { account: string; provider: string; source: string; status: string; windows: number | null; issues: string[] }
/** Snapshot projection; raw producer payload remains in the envelope. */
export interface QuotaSnapshot {
  revision: number | null; evaluatedAt: number | null; configRevision: string | null;
  coverage: { state: string; unobserved: string[]; lastCollectionAt: number | null; lastCollectionOk: boolean | null; sources: QuotaSource[] };
  accounts: QuotaAccount[];
}
/** Service status projection. */
export interface QuotaStatus {
  status: string; startedAt: number | null; sourceCount: number | null; lastCollectionAt: number | null; lastCollectionOk: boolean | null;
  external: { account: string; provider: string; source: string; acceptedAt: number | null; revision: number | null }[];
}

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fourteen: 14, thirty: 30 };
const UNIT_SECONDS: Record<string, number> = { minute: 60, hour: 3600, day: 86400, week: 604800 };

/** Returns the window length in seconds from its producer name, or null when it cannot be derived. */
export function windowSeconds(name: string): number | null {
  const lower = name.toLowerCase();
  if (lower === 'weekly') return 7 * 86400;
  if (lower === 'daily') return 86400;
  if (lower === 'hourly') return 3600;
  const match = /^([a-z0-9]+)_(minute|hour|day|week)s?(?:_[a-z0-9_]+)?$/.exec(lower);
  if (!match) return null;
  const count = /^\d+$/.test(match[1]!) ? Number(match[1]) : NUMBER_WORDS[match[1]!];
  return count && count > 0 ? count * UNIT_SECONDS[match[2]!]! : null;
}
/** Human names for known quota providers. Unknown providers keep the account identifier. */
const PROVIDER_NAMES: Record<string, string> = {
  claude: 'Claude subscription', codex: 'Codex (ChatGPT)', glm: 'Z.AI GLM', 'opencode-go': 'OpenCode Go',
  'opencode-zen': 'OpenCode Zen', 'codex-api': 'OpenAI API',
};

/** Returns the shared TUI and web account title from producer-confirmed provider names. */
export function accountTitle(account: string, providers: readonly string[]): string {
  const names = new Set(providers.flatMap(provider => Object.hasOwn(PROVIDER_NAMES, provider) ? [PROVIDER_NAMES[provider]!] : []));
  return [...names].join(' + ') || account;
}

const STATES = new Set<QuotaState>(['known', 'unknown', 'exhausted']);

/** Returns a plain object or throws a schema error. */
function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`quota_${field}`);
  return value as Record<string, unknown>;
}
/** Returns a finite number, null for absent/null, or throws for another type. */
function num(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`quota_${field}`);
  return value;
}
/** Returns a required non-empty string. */
function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`quota_${field}`);
  return value;
}
/** Returns an optional string, or null. */
function optText(value: unknown): string | null { return typeof value === 'string' && value ? value : null; }
/** Returns string array entries; non-strings are dropped. */
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; }
/** Returns a list of objects or an empty list when absent. */
function rows(value: unknown, field: string): Record<string, unknown>[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`quota_${field}`);
  return value.map(item => record(item, field));
}

/** Validates the fields this view uses; unknown state values reject the whole snapshot. */
export function quotaSnapshot(value: unknown): QuotaSnapshot {
  const data = record(value, 'snapshot');
  if (data.schema_version !== 2) throw new Error('quota_schema');
  const coverage = record(data.coverage, 'coverage');
  const last = coverage.last_collection === null || coverage.last_collection === undefined ? null : record(coverage.last_collection, 'last_collection');
  if (!Array.isArray(data.accounts)) throw new Error('quota_accounts');
  return {
    revision: num(data.revision, 'revision'), evaluatedAt: num(data.evaluated_at, 'evaluated_at'), configRevision: optText(data.config_revision),
    coverage: {
      state: text(coverage.state, 'coverage_state'), unobserved: Array.isArray(coverage.unobserved) ? coverage.unobserved.map(item => typeof item === 'string' ? item : JSON.stringify(item)) : [],
      lastCollectionAt: last ? num(last.observed_at, 'observed_at') : null, lastCollectionOk: last && typeof last.ok === 'boolean' ? last.ok : null,
      sources: last ? rows(last.sources, 'sources').map(source => ({ account: text(source.account, 'source_account'), provider: optText(source.provider) ?? 'Unknown', source: optText(source.source) ?? 'Unknown', status: optText(source.status) ?? 'Unknown', windows: num(source.windows, 'source_windows'), issues: strings(source.issues) })) : [],
    },
    accounts: data.accounts.map(item => {
      const account = record(item, 'account');
      return {
        account: text(account.account, 'account_id'),
        models: rows(account.models, 'models').map(model => {
          const state = text(model.state, 'state') as QuotaState;
          if (!STATES.has(state)) throw new Error('quota_state');
          const validity = record(model.state_validity, 'state_validity');
          const kind = validity.kind;
          const parsedValidity: QuotaModel['validity'] = kind === 'until' ? { kind, at: num(validity.at, 'validity_at') ?? (() => { throw new Error('quota_validity_at'); })() } : kind === 'latched_no_reset' || kind === 'unknown' ? { kind } : (() => { throw new Error('quota_validity'); })();
          const limiting = model.limiting_window === null || model.limiting_window === undefined ? null : record(model.limiting_window, 'limiting_window');
          return {
            provider: optText(model.provider) ?? 'Unknown', model: text(model.model, 'model'), nativeModel: optText(model.native_model), state, validity: parsedValidity,
            score: num(model.quota_score, 'quota_score'), window: limiting ? { pool: optText(limiting.pool) ?? 'Unknown', source: optText(limiting.source) ?? 'Unknown', window: optText(limiting.window) ?? 'Unknown' } : null,
            remaining: num(model.remaining_percent, 'remaining'), burn: num(model.burn_percent_per_hour, 'burn'), resetAt: num(model.reset_at, 'reset_at'),
            risk: optText(model.risk) ?? 'unknown', evidence: optText(model.evidence) ?? 'unknown', newestObservedAt: num(model.newest_observed_at, 'newest_observed_at'),
            exhaustedUntil: num(model.exhausted_until, 'exhausted_until'), pools: strings(model.pools),
          };
        }),
        windows: rows(account.windows, 'windows').map(window => {
          const forecast = window.forecast === null || window.forecast === undefined ? null : record(window.forecast, 'forecast');
          const evaluation = window.evaluation === null || window.evaluation === undefined ? null : record(window.evaluation, 'evaluation');
          return {
            pool: optText(window.pool) ?? 'Unknown', source: optText(window.source) ?? 'Unknown', window: optText(window.window) ?? 'Unknown', lane: optText(window.lane) ?? 'Unknown', runtime: optText(window.runtime) ?? 'Unknown', models: strings(window.models),
            observedAt: num(window.observed_at, 'window_observed_at'), validUntil: num(window.valid_until, 'valid_until'), lastRemaining: num(window.last_remaining_percent, 'last_remaining'), lastResetAt: num(window.last_reset_at, 'last_reset'),
            forecastKnown: forecast?.known === true, risk: optText(evaluation?.risk) ?? optText(forecast?.risk) ?? 'unknown', marker: optText(evaluation?.marker),
            projected: evaluation ? num(evaluation.projected_percent, 'projected') : null, sustainable: forecast ? num(forecast.sustainable_percent_per_hour, 'sustainable') : null,
            burn: evaluation ? num(evaluation.burn_percent_per_hour, 'window_burn') : forecast ? num(forecast.burn_percent_per_hour, 'window_burn') : null,
          };
        }),
        latches: rows(account.latches, 'latches').map(latch => ({ pool: optText(latch.pool) ?? 'Unknown', window: optText(latch.window) ?? 'Unknown', source: optText(latch.source) ?? 'Unknown', active: latch.active === true, observedAt: num(latch.observed_at, 'latch_observed_at'), resetAt: num(latch.reset_at, 'latch_reset_at'), models: strings(latch.models) })),
        advice: rows(account.advice, 'advice').flatMap(advice => strings(advice.recommendations)),
      };
    }),
  };
}

/** Validates the service status fields used by the view. */
export function quotaStatus(value: unknown): QuotaStatus {
  const data = record(value, 'status');
  const last = data.last_collection === null || data.last_collection === undefined ? null : record(data.last_collection, 'last_collection');
  return {
    status: optText(data.status) ?? 'unknown', startedAt: num(data.started_at, 'started_at'), sourceCount: num(data.source_count, 'source_count'),
    lastCollectionAt: last ? num(last.observed_at, 'observed_at') : null, lastCollectionOk: last && typeof last.ok === 'boolean' ? last.ok : null,
    external: rows(data.external_collection, 'external_collection').map(row => ({ account: optText(row.account) ?? 'Unknown', provider: optText(row.provider) ?? 'Unknown', source: optText(row.source) ?? 'Unknown', acceptedAt: num(row.accepted_at, 'accepted_at'), revision: num(row.revision, 'external_revision') })),
  };
}

/** Formats a percentage, or Unknown. */
export function percent(value: number | null): string { return value === null ? 'Unknown' : `${Math.round(value * 10) / 10}%`; }
/** Formats a burn rate in percentage points per hour, or Unknown. */
export function burn(value: number | null): string { return value === null ? 'Unknown' : `${value >= 100 ? Math.round(value) : Math.round(value * 100) / 100} pp/h`; }
/** Formats a non-negative duration compactly. */
export function span(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor(s % 86400 / 3600)}h`;
}
/** Formats an age relative to now, or Unknown. */
export function age(at: number | null, now: number): string { return at === null ? 'Unknown' : at > now ? `in ${span(at - now)} (clock ahead)` : `${span(now - at)} ago`; }
/** Formats a future boundary relative to now with its local time, or Unknown. */
export function until(at: number | null, now: number): string {
  if (at === null) return 'Unknown';
  const local = new Date(at * 1000), clock = local.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  return at <= now ? `passed ${span(now - at)} ago (${clock})` : `in ${span(at - now)} (${clock})`;
}
/** Describes when the model's state class can next change. */
export function validity(model: QuotaModel, now: number): string {
  if (model.validity.kind === 'until') return model.validity.at <= now ? 'expired; re-read' : `valid ${until(model.validity.at, now)}`;
  return model.validity.kind === 'latched_no_reset' ? 'latched, no reset clock' : 'no decision';
}

/** Per-snapshot summary for the Overview card. Unknown models are counted, never treated as capacity. */
export interface QuotaSummary { accounts: number; known: number; unknown: number; exhausted: number; stale: number; lowest: { account: string; model: string; remaining: number } | null; coverage: string }
/** Summarizes model states across accounts. */
export function quotaSummary(snapshot: QuotaSnapshot): QuotaSummary {
  let known = 0, unknown = 0, exhausted = 0, stale = 0, lowest: QuotaSummary['lowest'] = null;
  for (const account of snapshot.accounts) for (const model of account.models) {
    if (model.state === 'known') known++; else if (model.state === 'exhausted') exhausted++; else unknown++;
    if (model.evidence !== 'fresh') stale++;
    if (model.state === 'known' && model.remaining !== null && (!lowest || model.remaining < lowest.remaining)) lowest = { account: account.account, model: model.model, remaining: model.remaining };
  }
  return { accounts: snapshot.accounts.length, known, unknown, exhausted, stale, lowest, coverage: snapshot.coverage.state };
}

/** Display tone mapped by the renderer to its palette. */
export type Tone = 'text' | 'muted' | 'good' | 'warn' | 'error' | 'accent';
/** One rendered line of the Quota view. */
export interface QuotaLine { text: string; tone: Tone; bold?: boolean }

/** Tone for a model state/risk pair. */
function modelTone(model: QuotaModel): Tone {
  if (model.state === 'exhausted' || model.risk === 'high') return 'error';
  if (model.state === 'unknown') return 'muted';
  return model.risk === 'low' ? 'good' : 'text';
}

/** Builds every per-account/model detail line for the Quota tab. */
export function quotaLines(snapshot: QuotaSnapshot | null, status: QuotaStatus | null, now: number): QuotaLine[] {
  const lines: QuotaLine[] = [];
  if (status) {
    lines.push({ text: `Service: ${status.status} · started ${age(status.startedAt, now)} · sources ${status.sourceCount ?? 'Unknown'} · last round ${age(status.lastCollectionAt, now)} (${status.lastCollectionOk === null ? 'Unknown' : status.lastCollectionOk ? 'ok' : 'failed'})`, tone: status.status === 'running' ? 'text' : 'error' });
    for (const row of status.external) lines.push({ text: `  external ${row.account} · ${row.provider}/${row.source} · accepted ${age(row.acceptedAt, now)} · revision ${row.revision ?? 'Unknown'}`, tone: row.acceptedAt !== null && now - row.acceptedAt > 3600 ? 'error' : 'muted' });
    lines.push({ text: '', tone: 'muted' });
  }
  if (!snapshot) return lines;
  const coverageTone: Tone = snapshot.coverage.state === 'complete' ? 'muted' : 'error';
  lines.push({ text: `Snapshot revision ${snapshot.revision ?? 'Unknown'} · evaluated ${age(snapshot.evaluatedAt, now)} · coverage ${snapshot.coverage.state}${snapshot.coverage.unobserved.length ? ` · unobserved: ${snapshot.coverage.unobserved.join(', ')}` : ''}`, tone: coverageTone });
  for (const source of snapshot.coverage.sources) lines.push({ text: `  source ${source.account} · ${source.provider}/${source.source} · ${source.status} · windows ${source.windows ?? 'Unknown'}${source.issues.length ? ` · issues: ${source.issues.join(', ')}` : ''}`, tone: source.issues.length || source.status === 'failed' ? 'error' : 'muted' });
  if (!snapshot.accounts.length) lines.push({ text: 'No accounts reported by Quota.', tone: 'muted' });
  for (const account of snapshot.accounts) {
    lines.push({ text: '', tone: 'muted' }, { text: `Account ${account.account}`, tone: 'accent', bold: true });
    if (!account.models.length) lines.push({ text: '  No configured models reported.', tone: 'muted' });
    for (const model of account.models) {
      lines.push({ text: `  ${model.provider}/${model.model}${model.nativeModel && model.nativeModel !== model.model ? ` (${model.nativeModel})` : ''} · ${model.state.toUpperCase()} · risk ${model.risk}`, tone: modelTone(model), bold: true });
      lines.push({ text: `    remaining ${percent(model.remaining)} · burn ${burn(model.burn)} · reset ${until(model.resetAt, now)}${model.exhaustedUntil !== null ? ` · exhausted until ${until(model.exhaustedUntil, now)}` : ''}`, tone: 'text' });
      lines.push({ text: `    window ${model.window ? `${model.window.window} · ${model.window.pool} · ${model.window.source}` : 'Unknown'} · score ${model.score === null ? 'Unknown' : Math.round(model.score * 1000) / 1000}`, tone: 'muted' });
      lines.push({ text: `    evidence ${model.evidence} · newest sample ${age(model.newestObservedAt, now)} · ${validity(model, now)}`, tone: model.evidence === 'fresh' ? 'muted' : 'error' });
    }
    if (account.windows.length) lines.push({ text: '  Windows', tone: 'text', bold: true });
    for (const window of account.windows) {
      const fresh = window.validUntil !== null && window.validUntil > now;
      lines.push({ text: `    ${window.window} · ${window.lane} · ${window.source} · last ${percent(window.lastRemaining)} · reset ${until(window.lastResetAt, now)}`, tone: window.risk === 'high' ? 'error' : 'text' });
      lines.push({ text: `      sample ${age(window.observedAt, now)} · ${fresh ? `valid ${until(window.validUntil, now)}` : 'stale'} · forecast ${window.forecastKnown ? 'known' : 'unknown'} · risk ${window.risk}${window.marker ? ` (${window.marker})` : ''} · burn ${burn(window.burn)} · sustainable ${burn(window.sustainable)} · projected ${percent(window.projected)} · models ${window.models.join(', ') || 'Unknown'}`, tone: fresh ? 'muted' : 'error' });
    }
    const active = account.latches.filter(latch => latch.active);
    lines.push({ text: `  Latches: ${active.length ? `${active.length} active` : 'none active'}`, tone: active.length ? 'error' : 'muted', bold: !!active.length });
    for (const latch of active) lines.push({ text: `    ${latch.window} · ${latch.pool} · ${latch.source} · reset ${until(latch.resetAt, now)} · models ${latch.models.join(', ') || 'Unknown'}`, tone: 'error' });
    lines.push({ text: `  Advice: ${account.advice.length ? account.advice.length : 'none'}`, tone: account.advice.length ? 'accent' : 'muted' });
    for (const advice of account.advice) lines.push({ text: `    ${advice}`, tone: 'accent' });
  }
  lines.push({ text: '', tone: 'muted' }, { text: 'Read-only Quota observations. Missing values are Unknown, never zero; re-read before any decision.', tone: 'muted' });
  return lines;
}
