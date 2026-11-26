/** Regression coverage for cross-page chat grouping, independent feed boundaries and expired cursors. */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolHistory, SessionHistory } from '@agent-hub/domain';
import { HubHttpError } from '../client';
import { mergeChat, mergeTranscript } from '../model';
import { mergeHistoryPage, readHistoryBoundary } from '../history-window';

test('chat retains separate invalid evidence when multipart attribution conflicts across pages', () => {
  type Item = PoolHistory['items'][number];
  const first: Item = {
    id: 'event-1', position: '1', revision: '4', authorKind: 'member', authorId: 'seat-a', recipientId: 'seat-b',
    kind: 'message', atMs: null, proposalId: null, parts: ['first'], valid: true, complete: false,
    partRange: { first: 1, last: 1, expected: 2 },
  };
  const second: Item = { ...first, position: '2', kind: 'message_part', parts: [' second'], partRange: { first: 2, last: 2, expected: 2 } };
  const joined = mergeChat([first], [second]);
  assert.equal(joined.length, 1);
  assert.deepEqual(joined[0].parts, ['first', ' second']);
  assert.equal(joined[0].complete, true);
  const prepended = mergeHistoryPage(
    { items: [second], page: { previous: 'older', next: null, resume: 'live' } },
    { items: [first, second], page: { previous: null, next: null, resume: 'ignored' } },
    mergeChat, true,
  );
  assert.deepEqual(prepended.items, joined);
  assert.equal(prepended.items[0].id, second.id);
  assert.deepEqual(prepended.page, { previous: null, next: null, resume: 'live' });
  for (const change of [{ revision: '5' }, { authorId: 'seat-c' }, { authorKind: 'service' }, { recipientId: null }]) {
    const conflict = mergeChat([first], [{ ...second, ...change }]);
    assert.equal(conflict.length, 2);
    assert.ok(conflict.every(item => !item.valid && !item.complete));
  }
  assert.equal(mergeChat([first], [{ ...first, parts: ['conflicting replay'] }])[0].valid, false);
});

test('an expired live cursor retries at the opening edge and leaves the old receipt intact', async () => {
  const receipt = { observedAtMs: 42, items: ['retained'], page: { next: null, resume: 'expired', previous: 'older' } };
  const requests: (string | null)[] = [];
  const result = await readHistoryBoundary(receipt.page.resume, async cursor => {
    requests.push(cursor);
    if (cursor) throw new HubHttpError('stale_boundary', 409);
    return { observedAtMs: 84, items: ['renewed'] };
  }, new AbortController().signal);
  assert.deepEqual(requests, ['expired', null]);
  assert.equal(result.reset, true);
  assert.equal(result.value.observedAtMs, 84);
  assert.deepEqual(receipt.page, { next: null, resume: 'expired', previous: 'older' });
});

/** Constructs a minimal transcript entry to exercise chronology and identity independently. */
function transcriptEntry(id: string, position: string): SessionHistory['entries'][number] {
  return {
    head: { id, position, role: 'assistant', name: null, sourceRef: null, text: id, atMs: null, error: null, complete: true },
    calls: [], results: [], partialBefore: false, partialAfter: false,
  };
}

test('prepending merges overlapping transcript IDs and exhausts only the older cursor', () => {
  const newest = transcriptEntry('newest', '120');
  const initial = { items: [transcriptEntry('overlap', '100'), newest], page: { previous: 'older', next: null, resume: 'live' } };
  const older = { items: [transcriptEntry('oldest', '1'), transcriptEntry('overlap', '99')],
    page: { previous: null, next: null, resume: 'old-resume' } };
  const feed = mergeHistoryPage(initial, older, mergeTranscript, true);
  assert.deepEqual(feed.items.map(item => item.head.id), ['oldest', 'overlap', 'newest']);
  assert.equal(feed.items.at(-1), newest);
  assert.deepEqual(feed.page, { previous: null, next: null, resume: 'live' });
});

test('live pages extend the feed past the old row limit and cannot reopen exhausted older history', () => {
  const items = Array.from({ length: 120 }, (_, index) => transcriptEntry('msg-' + index, String(index + 1)));
  const incoming = { items: [items[119], transcriptEntry('new', '121')], page: { previous: 'unrelated', next: 'backlog', resume: 'live' } };
  const feed = mergeHistoryPage({ items, page: { previous: null, next: null, resume: 'prior-live' } }, incoming, mergeTranscript, false);
  assert.deepEqual(feed.items, [...items, incoming.items[1]]);
  assert.deepEqual(feed.page, { previous: null, next: 'backlog', resume: 'live' });
});
