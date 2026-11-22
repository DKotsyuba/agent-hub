/** Finite history windows retain complete page boundaries for reversible navigation. */
import type { Page } from '@agent-hub/domain';
import { HubHttpError } from './client';

/** Retains enough content for browsing without accumulating the entire transcript in the DOM. */
const MAX_ITEMS = 80;
const MAX_BYTES = 4 * 1024 * 1024;

/** Render and retention limits are applied to the same anchored buffer. */
export function appendHistoryWindow<T>(
  previous: { items: T[]; page: Page },
  incoming: { items: T[]; page: Page },
  merge: (previous: T[], incoming: T[], older: boolean) => T[],
  size: (item: T) => number,
  older: boolean,
) {
  const items = merge(previous.items, incoming.items, older);
  if (items.length <= MAX_ITEMS && items.reduce((total, item) => total + size(item), 0) <= MAX_BYTES) {
    return { items, page: older
      ? { ...previous.page, previous: incoming.page.previous }
      : { ...incoming.page, previous: previous.page.previous }, moved: false };
  }
  // Drop whole pages so Older/Newer can reach discarded rows without inventing a cursor.
  return { items: incoming.items, page: older ? { ...incoming.page, next: incoming.page.resume } : incoming.page, moved: true };
}

/** Drops expired navigation tokens while keeping the displayed records and evidence. */
export function retainPausedHistory<T extends { page: Page }>(window: T): T {
  return { ...window, page: { previous: null, next: null, resume: null } };
}

/** Retries an expired opaque cursor at a caller-selected edge exactly once. */
export async function readHistoryBoundary<T>(cursor: string | null, read: (cursor: string | null) => Promise<T>, signal: AbortSignal) {
  try { return { value: await read(cursor), reset: false }; }
  catch (error) {
    if (!cursor || signal.aborted || !(error instanceof HubHttpError) || error.code !== 'stale_boundary') throw error;
    return { value: await read(null), reset: true };
  }
}
