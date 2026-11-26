/** Held-message alarm: threshold edge, absence, ordering, reasons and the producer-row parser. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { HELD_STALE_MS, HELD_THRESHOLD_MS, heldAlarm, heldState, heldDuration, heldReasonKind, shortRecipient } from '../src/index.ts';
import { heldRow } from '../../../src/live/protocol.ts';

const now = 1_800_000_000_000;
const minutes = (value: number) => value * 60_000;

test('the alarm needs a wait strictly longer than ten minutes', () => {
  assert.equal(HELD_THRESHOLD_MS, minutes(10));
  assert.equal(heldAlarm([{ acceptedAtMs: now - minutes(10) }], now), null);
  assert.equal(heldAlarm([{ acceptedAtMs: now - minutes(10) - 1 }], now)?.count, 1);
  assert.equal(heldAlarm([{ acceptedAtMs: now - minutes(9) }], now), null);
});

test('missing, empty or implausible data hides the alarm', () => {
  assert.equal(heldAlarm(undefined, now), null);
  assert.equal(heldAlarm(null, now), null);
  assert.equal(heldAlarm([], now), null);
  assert.equal(heldAlarm([{ acceptedAtMs: now + minutes(30) }, { acceptedAtMs: Number.NaN }], now), null);
});

test('several held messages are counted, ordered oldest first and capped to three lines', () => {
  const alarm = heldAlarm([
    { acceptedAtMs: now - minutes(30), recipient: 'b' }, { acceptedAtMs: now - minutes(360) - 2 * 60_000, recipient: 'oldest', holdReason: 'target unavailable', attempts: 0 },
    { acceptedAtMs: now - minutes(11), recipient: 'c' }, { acceptedAtMs: now - minutes(60), recipient: 'd' }, { acceptedAtMs: now - minutes(5), recipient: 'fresh' },
  ], now, false)!;
  assert.equal(alarm.count, 4);
  assert.equal(alarm.complete, false);
  assert.equal(alarm.lines.length, 3);
  assert.deepEqual(alarm.lines.map(line => line.recipient), ['oldest', 'd', 'b']);
  assert.deepEqual(heldDuration(alarm.oldestWaitMs), { hours: 6, minutes: 2 });
  assert.equal(alarm.lines[0].attempts, 0);
  assert.equal(alarm.lines[0].reasonKind, 'target_unavailable');
});

test('hold reasons are classified, shown verbatim when unknown and fall back to the state', () => {
  assert.equal(heldReasonKind('target unavailable'), 'target_unavailable');
  assert.equal(heldReasonKind('Target_Unavailable'), 'target_unavailable');
  assert.equal(heldReasonKind('socket continuity not confirmed'), 'socket_continuity');
  assert.equal(heldReasonKind('operator review'), 'other');
  assert.equal(heldReasonKind(null), 'unknown');
  const [other, bare] = heldAlarm([{ acceptedAtMs: now - minutes(20), holdReason: 'operator review' }, { acceptedAtMs: now - minutes(15), state: 'held' }], now)!.lines;
  assert.equal(other.reasonText, 'operator review');
  assert.equal(bare.reasonKind, 'unknown');
  assert.equal(bare.reasonText, 'held');
});

test('long recipients are shortened around an ellipsis and short ones are untouched', () => {
  assert.equal(shortRecipient('codex@host'), 'codex@host');
  assert.equal(shortRecipient('  '), null);
  const long = 'codex@' + 'x'.repeat(80) + '/session-1234';
  const short = shortRecipient(long)!;
  assert.ok(short.length <= 36 && short.includes('…') && short.startsWith('codex@') && short.endsWith('1234'));
});

test('durations never read below one minute', () => {
  assert.deepEqual(heldDuration(0), { hours: 0, minutes: 1 });
  assert.deepEqual(heldDuration(minutes(61)), { hours: 1, minutes: 1 });
});

test('the producer row parser accepts only accepted-custody undelivered rows and tolerates absent optional fields', () => {
  const row = { acceptance_seq: 7, publisher: 'claude', event_id: 'e', custody_state: 'pending', delivery_state: 'held', accepted_at_ms: now - minutes(20) };
  assert.deepEqual(heldRow(row), { id: 'delivery-7', acceptedAtMs: now - minutes(20), state: 'held', holdReason: null, recipient: null, attempts: null });
  assert.deepEqual(heldRow({ ...row, hold_reason: ' target unavailable ', recipient: 'codex@host', attempts: 0, body: 'secret' }),
    { id: 'delivery-7', acceptedAtMs: now - minutes(20), state: 'held', holdReason: 'target unavailable', recipient: 'codex@host', attempts: 0 });
  assert.equal(heldRow({ ...row, delivery_state: 'hook_submitted' }), null);
  assert.equal(heldRow({ ...row, delivery_state: 'unknown' }), null);
  assert.equal(heldRow({ ...row, custody_state: 'refused' }), null);
  assert.equal(heldRow({ ...row, accepted_at_ms: null }), null);
  assert.equal(heldRow({ ...row, hold_reason: 7, recipient: {}, attempts: -1 })?.attempts, null);
  assert.equal(heldRow(null), null);
  assert.equal(heldRow([]), null);
});

const day = 24 * 3_600_000;

test('a message older than seven days is stale: no alarm, only the muted count', () => {
  assert.equal(HELD_STALE_MS, 7 * day);
  const edge = heldState([{ acceptedAtMs: now - 7 * day }], now);
  assert.equal(edge.alarm?.count, 1);
  assert.equal(edge.stale, 0);
  const old = heldState([{ acceptedAtMs: now - 21 * day }], now);
  assert.equal(old.alarm, null);
  assert.equal(old.stale, 1);
  assert.equal(heldAlarm([{ acceptedAtMs: now - 21 * day }], now), null);
  const mixed = heldState([{ acceptedAtMs: now - 21 * day }, { acceptedAtMs: now - minutes(20) }], now);
  assert.equal(mixed.alarm?.count, 1);
  assert.equal(mixed.alarm?.stale, 1);
  assert.deepEqual(heldDuration(mixed.alarm!.oldestWaitMs), { hours: 0, minutes: 20 });
});

test('a new hold alarms after a long terminal history because the overview total is trusted', () => {
  const state = heldState([{ acceptedAtMs: now - minutes(30), recipient: 'new' }], now, false, undefined, { pending: 1, oldestScannedAtMs: now - minutes(500) });
  assert.equal(state.alarm?.count, 1);
  assert.equal(state.alarm?.complete, true);
  assert.equal(state.alarm?.partial, false);
});

test('overview counts above the rows seen keep the alarm and mark the list partial', () => {
  const seen = [{ acceptedAtMs: now - minutes(30) }];
  const unknownAge = heldState(seen, now, false, undefined, { pending: 3 });
  assert.equal(unknownAge.alarm?.count, 3);
  assert.equal(unknownAge.alarm?.partial, true);
  assert.equal(unknownAge.alarm?.complete, true);
  assert.equal(unknownAge.alarm?.lines.length, 1);
  assert.equal(unknownAge.alarm?.oldestWaitMs, minutes(30));
  const floored = heldState(seen, now, false, undefined, { pending: 2, oldestScannedAtMs: now - minutes(500) });
  assert.equal(floored.alarm?.count, 2);
  assert.equal(floored.alarm?.partial, true);
  const unseenStale = heldState(seen, now, false, undefined, { pending: 3, oldestScannedAtMs: now - 9 * day });
  assert.equal(unseenStale.alarm?.count, 1);
  assert.equal(unseenStale.alarm?.partial, false);
  assert.equal(unseenStale.stale, 2);
  assert.equal(heldState([], now, false, undefined, { pending: 2, oldestScannedAtMs: now - 9 * day }).alarm, null);
  assert.equal(heldState([], now, false, undefined, { pending: 2, oldestScannedAtMs: now - 9 * day }).stale, 2);
  const fresh = heldState([], now, false, undefined, { pending: 1, oldestScannedAtMs: now - minutes(3) });
  assert.equal(fresh.alarm, null);
});

test('oldest wait with only unseen overdue messages is the oldest scanned row age', () => {
  const state = heldState([], now, false, undefined, { pending: 1, oldestScannedAtMs: now - minutes(90) });
  assert.equal(state.alarm?.count, 1);
  assert.equal(state.alarm?.oldestWaitMs, minutes(90));
  assert.equal(state.alarm?.lines.length, 0);
});

test('without overview counts (an older Bridge) only scanned rows count and a bounded scan is a lower bound', () => {
  const rows = [{ acceptedAtMs: now - minutes(30) }];
  const bounded = heldState(rows, now, false, undefined, { pending: null });
  assert.equal(bounded.alarm?.count, 1);
  assert.equal(bounded.alarm?.complete, false);
  assert.equal(bounded.alarm?.partial, true);
  const whole = heldState(rows, now, true, undefined, {});
  assert.equal(whole.alarm?.complete, true);
  assert.equal(whole.alarm?.partial, false);
  assert.equal(heldState(rows, now, true, undefined, { pending: undefined }).alarm?.count, 1);
});
