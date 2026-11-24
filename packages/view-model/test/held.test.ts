/** Held-message alarm: threshold edge, absence, ordering, reasons and the producer-row parser. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { HELD_THRESHOLD_MS, heldAlarm, heldDuration, heldReasonKind, shortRecipient } from '../src/index.ts';
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
