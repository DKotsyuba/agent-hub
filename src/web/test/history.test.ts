/** Regression coverage for cross-page chat grouping, expired cursors and retained history budgets. */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolHistory } from '@agent-hub/domain';
import { HubHttpError } from '../client';
import { mergeChat } from '../model';
import { appendHistoryWindow, readHistoryBoundary, retainPausedHistory } from '../history-window';

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
  for (const change of [{ revision: '5' }, { authorId: 'seat-c' }, { authorKind: 'service' }, { recipientId: null }]) {
    const conflict = mergeChat([first], [{ ...second, ...change }]);
    assert.equal(conflict.length, 2);
    assert.ok(conflict.every(item => !item.valid && !item.complete));
  }
  assert.equal(mergeChat([first], [{ ...first, parts: ['conflicting replay'] }])[0].valid, false);
});

test('history retries a paused expired resume once without mutating the displayed receipt', async () => {
  const receipt = { observedAtMs: 42, items: ['retained'], page: { next: null, resume: 'expired', previous: 'older' } };
  const requests: (string | null)[] = [];
  const result = await readHistoryBoundary('expired', async cursor => {
    requests.push(cursor);
    if (cursor) throw new HubHttpError('stale_boundary', 409);
    return { observedAtMs: 84, items: ['renewed'] };
  }, new AbortController().signal);
  assert.deepEqual(requests, ['expired', null]);
  assert.equal(result.reset, true);
  assert.equal(result.value.observedAtMs, 84);
  const retained = retainPausedHistory(receipt);
  assert.equal(retained.observedAtMs, 42);
  assert.equal(retained.items, receipt.items);
  assert.deepEqual(retained.page, { next: null, resume: null, previous: null });
  assert.equal(receipt.page.resume, 'expired');
});

test('history discards whole pages under row and UTF-8 limits and preserves reverse navigation', () => {
  const page = { previous: 'older', resume: 'resume', next: 'newer' };
  const merge = (previous: string[], incoming: string[]) => [...previous, ...incoming];
  const size = (text: string) => new TextEncoder().encode(text).length;
  const incoming = { page, items: ['adjacent'] };
  for (const items of [Array.from({ length: 80 }, () => 'row'), ['🦀'.repeat(1024 * 1024)]]) {
    const previous = { page, items };
    assert.deepEqual(appendHistoryWindow(previous, incoming, merge, size, false), { ...incoming, moved: true });
    assert.deepEqual(appendHistoryWindow(previous, incoming, merge, size, true).page, { ...page, next: 'resume' });
  }
  const both = appendHistoryWindow({ page, items: ['anchor'] }, incoming, merge, size, false);
  assert.deepEqual(both.items, ['anchor', 'adjacent']);
});
