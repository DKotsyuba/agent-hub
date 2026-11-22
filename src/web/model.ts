/** Portable projections pending the shared view-model package. */
import type { PoolHistory, SessionHistory, Worktree } from '@agent-hub/domain';
import type { QuotaAccount, QuotaSnapshot } from '../../packages/view-model/src/index';

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

/** Joins reported multipart ranges by ordinal and preserves invalid or incomplete messages. */
export function mergeChat(previous: PoolHistory['items'], incoming: PoolHistory['items']) {
  const messages = new Map<string, PoolHistory['items']>();
  for (const item of [...previous, ...incoming]) {
    const saved = messages.get(item.id) ?? [];
    const first = item.partRange?.first;
    if (item.complete || first == null) {
      if (!saved[0]?.complete || item.complete) messages.set(item.id, [item]);
    } else if (!saved[0]?.complete) {
      const exact = saved.filter(part => part.partRange?.first !== first);
      messages.set(item.id, [...exact, item]);
    }
  }
  const joined = [...messages.values()].flatMap(parts => {
    if (parts.length < 2) return parts;
    const ordered = [...parts].sort((a, b) => a.partRange!.first! - b.partRange!.first!);
    const merged: PoolHistory['items'] = [];
    for (const part of ordered) {
      const prior = merged.at(-1);
      const start = prior?.partRange?.first;
      const next = part.partRange!.first!;
      if (!prior || start == null || next > start + prior.parts.length) {
        merged.push(part);
        continue;
      }
      const end = Math.max(start + prior.parts.length, next + part.parts.length);
      const content = Array.from({ length: end - start }, (_, index) => part.parts[start + index - next] ?? prior.parts[index]);
      const expected = part.partRange!.expected ?? prior.partRange!.expected;
      const valid = prior.valid && part.valid && (prior.partRange!.expected == null || part.partRange!.expected == null || prior.partRange!.expected === part.partRange!.expected);
      merged[merged.length - 1] = { ...part, parts: content, valid,
        complete: valid && expected !== null && content.length === expected,
        partRange: { first: start, last: end - 1, expected } };
    }
    return merged;
  });
  return joined.sort(byPosition);
}

/** Projects producer names for the Quota card while preserving the raw account ID. */
export function quotaAccountTitle(account: QuotaAccount, snapshot: QuotaSnapshot) {
  const names: Record<string, string> = {
    claude: 'Claude subscription', codex: 'Codex (ChatGPT)', glm: 'Z.AI GLM',
    'opencode-go': 'OpenCode Go', 'opencode-zen': 'OpenCode Zen', 'codex-api': 'OpenAI API',
  };
  const providers = new Set([...account.models.map(item => item.provider),
    ...snapshot.coverage.sources.filter(source => source.account === account.account).map(source => source.provider)]);
  const titles = [...providers].flatMap(provider => Object.hasOwn(names, provider) ? [names[provider]] : []);
  return titles.join(' + ') || account.account;
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
