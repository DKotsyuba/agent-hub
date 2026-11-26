/** Merges chronological history while maintaining independent older and live boundaries. */
import type { Page } from '@agent-hub/domain';
import { HubHttpError } from './client';

/** Keeps the unmodified edge's cursors when prepending or appending a history page. */
export function mergeHistoryPage<T>(
  previous: { items: T[]; page: Page },
  incoming: { items: T[]; page: Page },
  merge: (previous: T[], incoming: T[], older: boolean) => T[],
  older: boolean,
) {
  return {
    items: merge(previous.items, incoming.items, older),
    page: older
      ? { ...previous.page, previous: incoming.page.previous }
      : { ...incoming.page, previous: previous.page.previous },
  };
}

/** Retries an expired opaque live cursor at the opening edge exactly once. */
export async function readHistoryBoundary<T>(cursor: string | null, read: (cursor: string | null) => Promise<T>, signal: AbortSignal) {
  try { return { value: await read(cursor), reset: false }; }
  catch (error) {
    if (!cursor || signal.aborted || !(error instanceof HubHttpError) || error.code !== 'stale_boundary') throw error;
    return { value: await read(null), reset: true };
  }
}
