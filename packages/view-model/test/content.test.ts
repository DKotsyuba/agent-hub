/** Covers UTF-8 offsets and fencing independently of the rendering framework. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { assembleText, verifyText } from '../src/content.ts';
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
