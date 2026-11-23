/** Covers UTF-8 offsets and fencing independently of the rendering framework. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { assembleText, verifyText } from '../src/content.ts';
import { quotaWindowForecast } from '../src/quota-pace.ts';
import { projectQuotaSnapshot } from '../src/quota-http.ts';
import { createFixtureFetch } from '../../client/fixtures/index.ts';
import { createHubClient } from '../../client/src/index.ts';

test('content assembly fences every page and measures bytes', async () => {
  const first = { content: { text: 'é', offsetBytes: 0, totalBytes: 3 }, next: 'second', fence: 'revision' };
  const second = { content: { text: 'a', offsetBytes: 2, totalBytes: 3 }, next: null, fence: 'revision' };
  assert.equal(await assembleText(async cursor => cursor ? second : first), 'éa');
  await assert.rejects(assembleText(async cursor => cursor ? { ...second, fence: 'different' } : first), /boundary/);
  await assert.rejects(assembleText(async cursor => cursor ? { ...second, content: { ...second.content, offsetBytes: 1 } } : first), /boundary/);
  await assert.rejects(verifyText('éa', '0'.repeat(64)), /digest/);
});

test('quota presentation keeps exhausted latches and unknown values distinct', async () => {
  const hub = createHubClient({ baseUrl: 'https://fixture.test', fetch: createFixtureFetch('populated') });
  const { data } = await hub.get('quota');
  assert.ok(data.snapshot);
  const snapshot = projectQuotaSnapshot(data.snapshot);
  assert.equal(snapshot.evaluatedAt, data.snapshot.evaluatedAtMs! / 1000);
  assert.ok(snapshot.accounts.flatMap(account => account.models).some(model => model.state === 'exhausted' && model.remaining === 0));
  assert.ok(snapshot.accounts.flatMap(account => account.latches).some(latch => latch.active));
});


test('shared quota forecast differentiates reserve, warning, exhaustion and unavailable samples', async () => {
  const hub = createHubClient({ baseUrl: 'https://fixture.test', fetch: createFixtureFetch('populated') });
  const { data } = await hub.get('quota');
  const now = 10_000;
  const base = { ...projectQuotaSnapshot(data.snapshot!).accounts[0].windows[0], window: 'five_hour',
    forecastKnown: true, lastResetAt: now + 7200, validUntil: now + 900, lastRemaining: 52, burn: 4, risk: 'low' };
  const reserve = quotaWindowForecast(base, now);
  assert.equal(reserve.pace, 40);
  assert.deepEqual([reserve.note.kind, reserve.note.points, reserve.exhaust.kind, reserve.tone], ['reserve', 12, 'lasts', 'good']);
  const behind = { ...base, window: 'ten_hour', lastResetAt: now + 18000, lastRemaining: 42 };
  const warning = quotaWindowForecast(behind, now);
  assert.deepEqual([warning.note.kind, warning.note.points, warning.exhaust.kind, warning.tone], ['deficit', 8, 'lasts', 'warn']);
  const deficit = quotaWindowForecast({ ...behind, burn: 14 }, now);
  assert.deepEqual([deficit.pace, deficit.exhaust.kind, deficit.exhaust.seconds, deficit.tone], [50, 'runs_out', 10800, 'error']);
  const unknown = quotaWindowForecast({ ...behind, forecastKnown: false }, now);
  assert.deepEqual([unknown.remaining, unknown.pace, unknown.exhaust.kind, unknown.tone], [null, null, 'none', 'muted']);
  assert.equal(quotaWindowForecast({ ...behind, validUntil: now }, now).stale, true);
});
