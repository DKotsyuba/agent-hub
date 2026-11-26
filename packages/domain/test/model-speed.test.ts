/** Model speed request and response boundary checks. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { API_RESPONSES, modelSeries, modelStats, parseApiRequest } from '../src/index.ts';

test('model speed routes validate producer labels, enum values and encoded groupings', () => {
  const url = (path: string) => new URL('https://hub.test/api/v1/model-speed' + path);
  assert.deepEqual(parseApiRequest(url('?window=7d&group_by=provider%2Bmodel')),
    { route: 'modelSpeed', window: '7d', group_by: 'provider+model' });
  assert.deepEqual(parseApiRequest(url('/series?model=vendor%2Fa%5B1%5D&window=30d')),
    { route: 'modelSpeedSeries', model: 'vendor/a[1]', window: '30d', bucket: 'day' });
  for (const path of ['?group_by=provider+model', '?window=all', '?window=7d&window=30d', '/series', '/series?model=bad%20name']) {
    assert.throws(() => parseApiRequest(url(path)), TypeError);
  }
});

test('model speed keeps exact bucket timestamps and independent nullable distributions', () => {
  const empty = { count: 0, mean: null, median: null, min: null, max: null, p10: null, p90: null };
  const metrics = { count: 1, speed_tokens_per_second: empty, ttft_ms: { count: 1, mean: 0, median: 0, min: 0, max: 0, p10: 0, p90: 0 } };
  const bucket = { start_unix_ns: '1760000000123456789', metrics };
  const series = { window: '24h', model: 'claude', bucket: 'hour', buckets: [bucket] };
  assert.deepEqual(modelSeries(series), series);
  assert.throws(() => modelSeries({ ...series, buckets: [{ ...bucket, start_unix_ns: 1760000000123456789 }] }), TypeError);
  const stats = { window: '7d', group_by: 'model+effort', groups: [{ key: { model: 'claude', effort: null }, metrics }] };
  assert.deepEqual(modelStats(stats), stats);
  assert.throws(() => modelStats({ ...stats, groups: [{ ...stats.groups[0], metrics: { ...metrics, ttft_ms: { ...empty, median: '0' } } }] }), TypeError);
  const unavailable = { data: null, observations: [{ source: 'stats', outcome: 'unavailable', producerAtMs: null, observedAtMs: 1 }] };
  assert.deepEqual(API_RESPONSES.modelSpeed(unavailable), unavailable);
});
