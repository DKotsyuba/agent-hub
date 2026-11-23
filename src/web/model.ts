/** Web history and presentation projections. */
import type { PoolHistory, SessionHistory, Worktree } from '@agent-hub/domain';
import { accountTitle, type QuotaAccount, type QuotaSnapshot } from '../../packages/view-model/src/index';

/** Matches the Quota producer's three known recommendation forms without displaying their identifiers. */
export function quotaAdviceKind(advice: string) {
  if (advice.endsWith(' capacity is unknown; treat limits as unverified.')) return 'Quota advice unknown';
  if (advice.includes(' is near exhaustion; avoid starting new ') && advice.endsWith(' work before reset.')) return 'Quota advice high';
  if (advice.endsWith(' is trending toward exhaustion; pace new requests.')) return 'Quota advice medium';
  return null;
}

/** Sorts and deduplicates anchored transcript groups while retaining tools across partial pages. */
export function mergeTranscript(previous: SessionHistory['entries'], incoming: SessionHistory['entries'], older = false) {
  const entries = new Map(previous.map(entry => [entry.head.position, entry]));
  for (const entry of incoming) {
    const saved = entries.get(entry.head.position);
    const head = saved?.head.complete && !entry.head.complete ? saved.head : entry.head;
    const combine = (left: typeof entry.calls, right: typeof entry.calls) =>
      [...new Map([...left, ...right].map(part => [part.position, part])).values()].sort(byPosition);
    entries.set(entry.head.position, saved ? {
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
