/** End-to-end v1 read routes against a framed Unix socket producer. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { API_RESPONSES } from '@agent-hub/domain';
import { fixtureModelGroups } from '../../packages/client/fixtures/model-speed.ts';
import { createHttp } from '../src/http.ts';

test('Agent Stats routes send only versioned read operations and project typed outcomes', async () => {
  const directory = await mkdtemp(join(process.env.TMPDIR!, 'hs-'));
  const path = join(directory, 's');
  const calls: unknown[] = [];
  const start = '1760000000123456789';
  const metrics = fixtureModelGroups('model')[0].metrics;
  const server = createServer(socket => {
    let input = '';
    socket.setEncoding('utf8').on('data', chunk => {
      input += chunk;
      if (!input.endsWith('\n')) return;
      const request = JSON.parse(input);
      calls.push(request);
      const { window, group_by, bucket, model } = request;
      if (model === 'silent') return;
      const data = request.op === 'model_stats' ? { window, group_by, groups: fixtureModelGroups(group_by) }
        : { window, model, bucket, buckets: [{ start_unix_ns: start, metrics }] };
      const response = window === '30d' ? { version: 1, ok: false, error: 'query_too_large' }
        : model === 'empty' ? { version: 1, ok: true, data: { window, model, bucket, buckets: [] } }
        : model === 'malformed' ? { version: 1, ok: true, data: { ...data, window: '30d' } }
        : { version: 1, ok: true, data };
      socket.write(JSON.stringify(response));
      socket.end('\n');
    });
  });
  const http = createHttp({ async read() { throw new Error('Unexpected native observer call'); }, async close() {} },
    { localHost: 'hub.test', release: 'test', webRoot: directory, statsSocket: path });
  /** Fetches a valid authority over the real HTTP handler. */
  const get = (query: string) => http.fetch(new Request('http://hub.test/api/v1/model-speed' + query, { headers: { host: 'hub.test' } }));
  try {
    await new Promise<void>((resolve, reject) => server.once('error', reject).listen(path, resolve));
    await writeFile(join(directory, 'index.html'), '<title>Hub fixture</title>');
    const page = await http.fetch(new Request('http://hub.test/model-speed', { headers: { host: 'hub.test' } }));
    assert.equal(await page.text(), '<title>Hub fixture</title>');
    const summary = await get('?window=7d&group_by=provider%2Bmodel');
    assert.equal(summary.status, 200);
    assert.equal(API_RESPONSES.modelSpeed(await summary.json()).data?.groups.length, 4);
    const series = API_RESPONSES.modelSpeedSeries(await (await get('/series?model=claude&bucket=day&window=7d')).json());
    assert.equal(series.data?.buckets[0].start_unix_ns, start);
    assert.deepEqual(calls, [
      { version: 1, op: 'model_stats', window: '7d', group_by: 'provider+model' },
      { version: 1, op: 'model_series', window: '7d', model: 'claude', bucket: 'day' },
    ]);
    assert.equal((await get('/series?model=bad%20name')).status, 400);
    assert.equal(calls.length, 2);
    for (const [query, outcome] of [['?window=30d', 'partial'], ['/series?model=empty', 'missing'], ['/series?model=malformed', 'invalid'], ['/series?model=silent', 'unavailable']]) {
      const result = await (await get(query)).json();
      assert.equal(result.observations[0].outcome, outcome);
      if (outcome !== 'missing') assert.equal(result.data, null);
    }
    await new Promise<void>(resolve => server.close(() => resolve()));
    const unavailable = API_RESPONSES.modelSpeed(await (await get('')).json());
    assert.equal(unavailable.data, null);
    assert.equal(unavailable.observations[0].outcome, 'unavailable');
  } finally {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await http.close();
    await rm(directory, { recursive: true, force: true });
  }
});
