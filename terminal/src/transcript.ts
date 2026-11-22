/** Projects source transcript blocks into display entries without modifying evidence. */
import type { TranscriptBlock } from '../../src/live/protocol.ts';

/** One source message or a tool call with its correlated result fragments. */
export interface TranscriptEntry {
  head: TranscriptBlock;
  calls: TranscriptBlock[];
  results: TranscriptBlock[];
}

/** A display entry index also resolves every constituent source block identity. */
export interface GroupedTranscript {
  entries: TranscriptEntry[];
  byKey: Map<string, number>;
  partialBefore: Set<string>;
  partialAfter: Set<string>;
}

/** Accepts only the producer's known native reference. */
function reference(block: TranscriptBlock): string | null {
  return typeof block.raw.raw_ref === 'string' && block.raw.raw_ref.length > 0 ? block.raw.raw_ref : null;
}

/** Matches optional producer names without treating malformed values as equal. */
function sameName(first: TranscriptBlock, second: TranscriptBlock): boolean {
  const name = (block: TranscriptBlock): string | null | undefined => block.raw.name == null ? null : typeof block.raw.name === 'string' ? block.raw.name : undefined;
  const left = name(first), right = name(second);
  return left !== undefined && right !== undefined && left === right;
}

/** Pairs results and late-filled call placeholders by source reference and tool name. */
export function groupTranscript(blocks: TranscriptBlock[]): GroupedTranscript {
  if (blocks.length && blocks.every(block => typeof block.raw.group_id === 'string')) return groupProjectedBlocks(blocks);
  const entries: TranscriptEntry[] = [], calls = new Map<string, { index: number; lastCall: number }>();
  let previousEntry = -1, previousIndex = -1;
  const open = (head: TranscriptBlock): number => {
    entries.push({ head, calls: head.role === 'tool_call' ? [head] : [], results: head.role === 'tool_result' ? [head] : [] });
    return entries.length - 1;
  };
  blocks.forEach((block, index) => {
    if (block.raw.starts_block === true && block.raw.first_seq == null) calls.clear();
    const ref = reference(block);
    let entryIndex: number;
    if (block.role === 'tool_call') {
      const prior = ref === null ? undefined : calls.get(ref);
      const previous = prior ? entries[prior.index] : undefined;
      const partial = prior && block.raw.partial_before === true && prior.lastCall === index - 1;
      const filled = previous && previous.results.length === 0 && previous.calls.every(call => call.content.length === 0) && block.content.length > 0;
      const joins = prior && previous && sameName(previous.head, block) && (partial || filled);
      entryIndex = joins ? prior.index : open(block);
      if (joins) entries[entryIndex].calls.push(block);
      if (ref !== null) calls.set(ref, { index: entryIndex, lastCall: index });
    } else if (block.role === 'tool_result') {
      const prior = ref === null ? undefined : calls.get(ref);
      if (prior && sameName(entries[prior.index].head, block)) {
        entryIndex = prior.index; entries[entryIndex].results.push(block);
      } else {
        const previous = entries[previousEntry];
        const joins = previous && previousIndex === index - 1 && previous.head.role === 'tool_result' && block.raw.partial_before === true && ref !== null && reference(previous.head) === ref && sameName(previous.head, block);
        entryIndex = joins ? previousEntry : open(block);
        if (joins) entries[entryIndex].results.push(block);
      }
    } else entryIndex = open(block);
    previousEntry = entryIndex; previousIndex = index;
  });
  const byKey = new Map<string, number>();
  entries.forEach((entry, index) => {
    for (const block of [entry.head, ...entry.calls, ...entry.results]) byKey.set(block.key, index);
  });
  const partialBefore = new Set(blocks.filter(block => block.raw.partial_before === true).map(block => block.key));
  const partialAfter = new Set(blocks.filter(block => block.raw.partial_after === true).map(block => block.key));
  blocks.forEach((block, index) => {
    const next = blocks[index + 1];
    if (!next || block.role !== next.role || reference(block) === null || reference(block) !== reference(next) || !sameName(block, next)) return;
    if ((block.raw.error ?? null) !== (next.raw.error ?? null) || (block.raw.error_source ?? null) !== (next.raw.error_source ?? null)) return;
    if (typeof block.raw.last_seq !== 'number' || !Number.isSafeInteger(block.raw.last_seq) || block.raw.last_seq !== block.seq || typeof next.raw.first_seq !== 'number' || !Number.isSafeInteger(next.raw.first_seq) || next.raw.first_seq > next.seq || block.raw.last_seq >= next.raw.first_seq) return;
    if (next.raw.partial_before === true) { partialAfter.delete(block.key); partialBefore.delete(next.key); }
  });
  return { entries, byKey, partialBefore, partialAfter };
}

/** Retain the server's explicit grouping, including unmatched result heads. */
function groupProjectedBlocks(blocks: TranscriptBlock[]): GroupedTranscript {
  const entries: TranscriptEntry[] = [], groups = new Map<string, number>(), byKey = new Map<string, number>();
  const partialBefore = new Set<string>(), partialAfter = new Set<string>();
  for (const block of blocks) {
    const id = String(block.raw.group_id);
    if (!groups.has(id)) {
      groups.set(id, entries.length);
      entries.push({ head: block, calls: [], results: [] });
    }
    const index = groups.get(id)!;
    const entry = entries[index];
    if (block.raw.fragment_id === id) entry.head = block;
    if (block.role === 'tool_call') entry.calls.push(block);
    if (block.role === 'tool_result') entry.results.push(block);
    byKey.set(block.key, index);
    if (block.raw.partial_before === true) partialBefore.add(block.key);
    if (block.raw.partial_after === true) partialAfter.add(block.key);
  }
  return { entries, byKey, partialBefore, partialAfter };
}
