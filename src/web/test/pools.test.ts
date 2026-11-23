/** Exercises the Pools tabs against the explicit fixture transport and their display labels. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixtureFetch } from '../../../packages/client/fixtures/index.ts';
import { createHubClient } from '../../../packages/client/src/index.ts';
import { poolBadge } from '../model.ts';
import { translations } from '../strings.ts';

test('pool tabs count completed chat pools as finished and show distinct row labels', async () => {
  const client = createHubClient({ baseUrl: 'http://hub.test', fetch: createFixtureFetch('populated') });
  const live = await client.get('pools', { query: { state: 'live' } });
  assert.deepEqual(live.data.items.map(row => row.id), ['pool-live-demo']);
  assert.equal(live.data.totals?.live, '1');
  const finished = await client.get('pools', { query: { state: 'finished' } });
  assert.deepEqual(finished.data.items.map(row => translations[poolBadge(row)]), ['Завершён', 'Закрыт']);
  assert.equal(finished.data.totals?.live, '1');
});
