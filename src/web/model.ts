/** Web history and presentation projections. */
import { poolLifecycle, type Pool, type PoolHistory, type Session, type SessionHistory, type Worktree } from '@agent-hub/domain';
import { accountTitle, type QuotaAccount, type QuotaSnapshot } from '../../packages/view-model/src/index';

/** Maps pool lifecycle to singular row labels while retaining the badge tone. */
export function poolBadge(row: Pool): string {
  const state = poolLifecycle(row.state, row.record?.id);
  return state === 'unknown' ? 'Unknown' : 'pool:' + state;
}

/** Selects a readable session label from its reported name or task summary, keeping the profile visible. */
export function sessionTitle(row: Session) {
  const name = row.name?.trim();
  const label = name && name !== row.id ? name : row.summary?.trim().replace(/\s+/g, ' ') || undefined;
  const profile = row.profile?.trim();
  return label && profile && profile !== label ? label + ' (' + profile + ')' : label;
}

/** Producer phases in which the agent's own step is executing rather than waiting or stopping. */
const workingPhases = new Set(['running', 'preparing', 'spawning', 'accepted']);
/** Producer lifecycle statuses that already ended; they are shown as the status badge. */
const terminalStatuses = new Set(['succeeded', 'failed', 'timed_out', 'cancelled', 'lost']);

/** What one session row is doing, as far as its own producer reported. */
export type SessionPhase =
  /** No usable phase for this lifecycle: the status badge is shown exactly as reported. */
  | { kind: 'status' }
  /** The agent's step is executing since `sinceMs`; the caller adds the spinner. */
  | { kind: 'working'; sinceMs: number | null; waitMs: number | null }
  /** The agent finished its step and waits to be woken, with its reported wait and start. */
  | { kind: 'waiting'; sinceMs: number | null; waitMs: number | null }
  /** A phase this build does not classify; the raw producer name is shown neutrally. */
  | { kind: 'phase'; phase: string };

/**
 * Maps the producer phase without inventing one: a running agent is working, an idle one waits,
 * and an unrecognized phase keeps its own name instead of being forced into either claim.
 */
export function sessionPhase(row: Pick<Session, 'status' | 'phase' | 'phaseStartedAtMs' | 'idleMs' | 'observedAtMs'>, now: number): SessionPhase {
  if (terminalStatuses.has(row.status)) return { kind: 'status' };
  const phase = row.phase?.trim() || null;
  if (phase === 'idle') {
    // Run refreshes phase_started_at on idle health checks; the reported idle duration at observation
    // time is the real start of the wait. The phase start is only a fallback for producers without it.
    const sinceMs = row.idleMs !== null && row.observedAtMs !== null ? row.observedAtMs - row.idleMs : row.phaseStartedAtMs;
    return { kind: 'waiting', sinceMs, waitMs: sinceMs === null ? row.idleMs : Math.max(0, now - sinceMs) };
  }
  const working = { kind: 'working' as const, sinceMs: row.phaseStartedAtMs,
    waitMs: row.phaseStartedAtMs === null ? null : Math.max(0, now - row.phaseStartedAtMs) };
  if (phase !== null && workingPhases.has(phase)) return working;
  if (row.status !== 'running' && row.status !== 'starting') return { kind: 'status' };
  // Older producers omit the phase entirely; the running status is still their own report.
  return phase === null ? working : { kind: 'phase', phase };
}

/** Formats the waiting label as `Waiting · 12 min (since 14:05)` from reported values only. */
export function waitingText(waitMs: number | null, sinceMs: number | null,
  format: { label: (key: string) => string; duration: (milliseconds: number) => string; at: (milliseconds: number) => string },
  state: 'Waiting' | 'Working' = 'Waiting') {
  const parts = [format.label(state)];
  if (waitMs !== null) parts.push(format.duration(waitMs));
  const since = sinceMs === null ? '' : ' (' + format.label('since') + ' ' + format.at(sinceMs) + ')';
  return parts.join(' · ') + since;
}

/** Selects a readable Pool label from its reported name or purpose preview. */
export function poolTitle(row: Pool) {
  const name = row.name?.trim();
  return name && name !== row.id ? name : row.purposePreview?.trim().replace(/\s+/g, ' ') || undefined;
}

/** Matches the Quota producer's three known recommendation forms without displaying their identifiers. */
export function quotaAdviceKind(advice: string) {
  if (advice.endsWith(' capacity is unknown; treat limits as unverified.')) return 'Quota advice unknown';
  if (advice.includes(' is near exhaustion; avoid starting new ') && advice.endsWith(' work before reset.')) return 'Quota advice high';
  if (advice.endsWith(' is trending toward exhaustion; pace new requests.')) return 'Quota advice medium';
  return null;
}

/** Sorts and deduplicates anchored transcript groups while retaining tools across partial pages. */
export function mergeTranscript(previous: SessionHistory['entries'], incoming: SessionHistory['entries'], older = false) {
  const entries = new Map(previous.map(entry => [entry.head.id, entry]));
  for (const entry of incoming) {
    const saved = entries.get(entry.head.id);
    const head = saved?.head.complete && !entry.head.complete ? saved.head : entry.head;
    const combine = (left: typeof entry.calls, right: typeof entry.calls) =>
      [...new Map([...left, ...right].map(part => [part.position, part])).values()].sort(byPosition);
    entries.set(entry.head.id, saved ? {
      head, calls: combine(saved.calls, entry.calls), results: combine(saved.results, entry.results),
      partialBefore: older ? entry.partialBefore : saved.partialBefore,
      partialAfter: older ? saved.partialAfter : entry.partialAfter,
    } : entry);
  }
  return [...entries.values()].sort((a, b) => byPosition(a.head, b.head));
}

/** Compares decimal wire counters without losing precision. */
function byPosition(a: { position: string }, b: { position: string }) {
  return a.position.length - b.position.length || a.position.localeCompare(b.position);
}

/** Joins adjacent multipart ranges only when grouping metadata and overlapping bytes agree. */
export function mergeChat(previous: PoolHistory['items'], incoming: PoolHistory['items']) {
  type Item = PoolHistory['items'][number];
  const metadata = (row: Item) => JSON.stringify([row.revision, row.authorKind, row.authorId, row.recipientId, row.partRange?.expected]);
  const groups = new Map<string, string>(), conflicts = new Set<string>(), positions = new Map<string, Item>();
  for (const row of [...previous, ...incoming]) {
    const signature = metadata(row);
    if (groups.has(row.id) && groups.get(row.id) !== signature) conflicts.add(row.id);
    groups.set(row.id, signature);
    const saved = positions.get(row.position);
    if (saved) {
      if (saved.id !== row.id || saved.partRange?.first !== row.partRange?.first ||
          saved.parts.some((part, index) => index < row.parts.length && row.parts[index] !== part) ||
          !saved.valid || !row.valid) {
        conflicts.add(saved.id);
        conflicts.add(row.id);
      }
      if (saved.parts.length >= row.parts.length || conflicts.has(saved.id)) continue;
    }
    positions.set(row.position, row);
  }
  const merged: Item[] = [];
  for (const item of [...positions.values()].sort(byPosition)) {
    const range = item.partRange;
    const invalid = range && (range.first == null || range.last == null || range.expected == null ||
      range.first < 1 || range.last > range.expected || range.expected > 64 || range.last - range.first + 1 !== item.parts.length);
    const row = invalid || conflicts.has(item.id) ? { ...item, valid: false, complete: false } : item;
    const prior = merged.at(-1), left = prior?.partRange, right = row.partRange;
    if (!prior || prior.id !== row.id || !prior.valid || !row.valid || !left || !right ||
        left.first == null || left.last == null || right.first == null || right.last == null ||
        left.expected == null || right.first < left.first || right.first > left.last + 1) {
      merged.push(row);
      continue;
    }
    const offset = right.first - left.first;
    if (row.parts.some((part, index) => offset + index < prior.parts.length && prior.parts[offset + index] !== part)) {
      merged[merged.length - 1] = { ...prior, valid: false, complete: false };
      merged.push({ ...row, valid: false, complete: false });
      continue;
    }
    const parts = [...prior.parts, ...row.parts.slice(Math.max(0, prior.parts.length - offset))];
    const last = Math.max(left.last, right.last);
    merged[merged.length - 1] = { ...prior, parts, complete: left.first === 1 && last === left.expected,
      partRange: { first: left.first, last, expected: left.expected } };
  }
  return merged;
}

/** Projects producer names for the Quota card while preserving the raw account ID. */
export function quotaAccountTitle(account: QuotaAccount, snapshot: QuotaSnapshot) {
  const providers = account.models.map(item => item.provider).filter(provider => provider !== 'Unknown');
  return accountTitle(account.account, providers.length ? providers :
    snapshot.coverage.sources.filter(source => source.account === account.account).map(source => source.provider));
}

/** Formats familiar model IDs while preserving unrecognized producer names. */
export function modelTitle(model: string) {
  const claude = /^claude-(fable|haiku|opus|sonnet)-(\d+)-(\d+)$/i.exec(model);
  if (claude) return `Claude ${claude[1][0].toUpperCase()}${claude[1].slice(1)} ${claude[2]}.${claude[3]}`;
  return model.replace(/^gpt-/i, 'GPT-').replace(/^glm-/i, 'GLM-').replace(/^deepseek-/i, 'DeepSeek ');
}

/** Draws status and size independently from the cached Worktree axes. */
export function worktreeMeasurements(row: Worktree, label: (text: string) => string, size: (bytes: number) => string) {
  const { status, size: bytes } = row.facts;
  const missing = (value: { state: 'not_checked' | 'unavailable'; code: string | null }) => label(value.state) + (value.code ? ' · ' + value.code : '');
  return {
    changes: status.state === 'known' ? (status.lowerBound ? '≥ ' : '') + Object.entries(status.value)
      .map(([key, count]) => label(key) + ' ' + count).join(' · ') : missing(status),
    size: bytes.state === 'known' ? (bytes.lowerBound ? '≥ ' : '') + size(bytes.value) : missing(bytes),
  };
}
