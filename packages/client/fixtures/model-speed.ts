/** Deterministic model speed data for explicit fixture mode and render tests. */
import type { ApiRequest, ModelStats, Observation, SpeedDistribution } from '../../domain/src/index.ts';
import type { FixtureScenario } from './catalog.ts';

/** Captures the two supported fixture request shapes. */
type Query = Extract<NonNullable<ApiRequest>, { route: 'modelSpeed' | 'modelSpeedSeries' }>;

/** Produces a plausible distribution or the exact missing-measurement shape. */
function distribution(count: number, median: number): SpeedDistribution {
  return count ? { count, mean: median * 1.02, median, min: median * .55, max: median * 1.75, p10: median * .78, p90: median * 1.31 }
    : { count, mean: null, median: null, min: null, max: null, p10: null, p90: null };
}

/** Counts calls independently of the two eligible measurement streams. */
function metrics(count: number, speed: number, ttft: number) {
  return { count, speed_tokens_per_second: distribution(speed ? count : 0, speed), ttft_ms: distribution(ttft ? count : 0, ttft) };
}

/** Synthetic producer groups for the three requested dimensions. */
export function fixtureModelGroups(grouping: ModelStats['group_by']): ModelStats['groups'] {
  return [
    { model: 'gpt-6.2-sol', provider: 'OpenAI', effort: 'low', metrics: metrics(118, 84.3, 820) },
    { model: 'claude-haiku-5-5', provider: 'Anthropic', effort: null, metrics: metrics(96, 112.8, 670) },
    { model: 'claude-sonnet-5', provider: 'Anthropic', effort: 'medium', metrics: metrics(71, 66.4, 1190) },
    { model: 'claude-opus-5', provider: 'Anthropic', effort: 'high', metrics: metrics(35, 46.9, 1680) },
  ].map(({ model, provider, effort, metrics }) => ({
    key: { model, ...(grouping === 'provider+model' ? { provider } : {}), ...(grouping === 'model+effort' ? { effort } : {}) },
    metrics,
  }));
}

/** Projects an explicit fixture scenario with matching request echoes and aligned UTC buckets. */
export function fixtureModelSpeed(query: Query, scenario: FixtureScenario, clockMs: number) {
  const outcome: Observation['outcome'] = scenario === 'empty' ? 'missing'
    : scenario === 'unavailable' || scenario === 'incompatible' ? scenario : 'ok';
  const observations = [{ source: 'stats', outcome, producerAtMs: null, observedAtMs: clockMs }];
  if (outcome === 'unavailable' || outcome === 'incompatible') return { data: null, observations };
  if (query.route === 'modelSpeed') return { data: {
    window: query.window, group_by: query.group_by, groups: outcome === 'missing' ? [] : fixtureModelGroups(query.group_by),
  }, observations };

  const width = (query.bucket === 'hour' ? 1 : 24) * 3_600_000;
  const hours = query.window === '24h' ? 24 : query.window === '7d' ? 168 : 720;
  const end = Math.floor(clockMs / width) * width;
  const length = hours * 3_600_000 / width + 1;
  const selected = fixtureModelGroups('model').find(row => row.key.model === query.model);
  const buckets = Array.from({ length }, (_, i) => ({
    start_unix_ns: String(BigInt(end - (length - i - 1) * width) * 1_000_000n),
    metrics: outcome === 'missing' || !selected || i === 6 ? metrics(0, 0, 0) : metrics(
      i % 6 + 1, (selected.metrics.speed_tokens_per_second.median ?? 0) * (1 + Math.sin(i * 1.7) * .14),
      (selected.metrics.ttft_ms.median ?? 0) * (1 + Math.cos(i * 1.1) * .18),
    ),
  }));
  if (!selected) return { data: { window: query.window, model: query.model, bucket: query.bucket, buckets },
    observations: [{ ...observations[0], outcome: 'missing' }] };
  return { data: { window: query.window, model: query.model, bucket: query.bucket, buckets }, observations };
}
