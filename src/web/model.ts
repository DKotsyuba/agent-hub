/** Portable projections pending the shared view-model package. */
import type { PoolHistory, Quota, SessionHistory, Worktree } from '@agent-hub/domain';

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
export function quotaAccountTitle(account: NonNullable<Quota['snapshot']>['accounts'][number], snapshot: NonNullable<Quota['snapshot']>) {
  const names: Record<string, string> = {
    claude: 'Claude subscription', codex: 'Codex (ChatGPT)', glm: 'Z.AI GLM',
    'opencode-go': 'OpenCode Go', 'opencode-zen': 'OpenCode Zen', 'codex-api': 'OpenAI API',
  };
  const providers = new Set([...account.models.map(item => item.provider),
    ...snapshot.coverage.sources.filter(source => source.account === account.account).map(source => source.provider)]);
  const titles = [...providers].flatMap(provider => Object.hasOwn(names, provider) ? [names[provider]] : []);
  return titles.join(' + ') || account.account;
}

/** Removes the Git ref prefix and distinguishes detached heads from unknown branches. */
export function branchLabel(row: Pick<Worktree, 'branch' | 'detached' | 'head'>) {
  if (row.detached) return ['Detached', row.head?.slice(0, 12)].filter(Boolean).join(' ');
  return row.branch?.replace(/^refs\/heads\//, '') ?? 'Unknown';
}

/** Formats reported bytes in readable binary units. */
export function formatBytes(bytes: number, format: (value: number) => string) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const unit = bytes > 0 ? Math.min(units.length - 1, Math.floor(Math.log2(bytes) / 10)) : 0;
  return format(bytes / 1024 ** unit) + ' ' + units[unit];
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

/** A bounded contiguous UTF-8 assembly with an optional final digest. */
export class TextAssembly {
  private total: number | undefined;
  private offset = 0;
  private parts: string[] = [];

  /** Applies one forward page and rejects gaps, overlaps and changed totals. */
  add(chunk: { text: string; offsetBytes: number; totalBytes: number }) {
    const size = new TextEncoder().encode(chunk.text).length;
    if (chunk.totalBytes > 16 * 1024 * 1024) throw new Error('content_budget');
    if (chunk.offsetBytes !== this.offset || (this.total !== undefined && chunk.totalBytes !== this.total)
        || (size === 0 && this.offset < chunk.totalBytes) || this.offset + size > chunk.totalBytes) throw new Error('invalid_projection');
    this.offset += size;
    this.total = chunk.totalBytes;
    this.parts.push(chunk.text);
  }

  /** Releases complete text only after its optional SHA-256 has been checked. */
  async finish(digest?: string) {
    if (this.offset !== this.total) throw new Error('invalid_projection');
    const text = this.parts.join('');
    if (digest) {
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      const hex = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
      if (hex !== digest) throw new Error('invalid_projection');
    }
    return text;
  }
}
