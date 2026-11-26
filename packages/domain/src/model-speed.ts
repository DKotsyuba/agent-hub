/** Agent Stats v1 aggregate data, shared by the server, fixtures and browser. */
import { array, count, matching, nullable, number, object, oneOf, optional, type Decoded } from './schema.ts';

/** Rolling windows accepted by Agent Stats. */
export const speedWindow = oneOf('24h', '7d', '30d');
/** Dimensions supported by the summary operation. */
export const speedGrouping = oneOf('model', 'provider+model', 'model+effort');
/** UTC-aligned widths supported by the series operation. */
export const speedBucket = oneOf('hour', 'day');
/** Producer label syntax, including namespaced model IDs. */
export const statsLabel = matching(/[A-Za-z0-9_.:[\]/-]{1,128}/, 'Agent Stats label');

/** Exact distribution with separate eligible sample count and nullable statistics. */
const distribution = object({
  count, mean: nullable(number), median: nullable(number), min: nullable(number),
  max: nullable(number), p10: nullable(number), p90: nullable(number),
});

/** Total calls and independent distributions in tokens per second and milliseconds. */
const metrics = object({ count, speed_tokens_per_second: distribution, ttft_ms: distribution });

/** Grouped summary. An unknown effort is explicitly null when requested. */
export const modelStats = object({
  window: speedWindow, group_by: speedGrouping,
  groups: array(object({
    key: object({ model: statsLabel, provider: optional(statsLabel), effort: optional(nullable(statsLabel)) }),
    metrics,
  })),
});

/** Model-wide trend with exact nanosecond timestamps and explicit empty buckets. */
export const modelSeries = object({
  window: speedWindow, model: statsLabel, bucket: speedBucket,
  buckets: array(object({ start_unix_ns: matching(/-?(0|[1-9][0-9]{0,18})/, 'decimal epoch nanoseconds'), metrics })),
});

/** A speed or latency distribution for display. */
export type SpeedDistribution = Decoded<typeof distribution>;
/** Grouped speed and latency summary. */
export type ModelStats = Decoded<typeof modelStats>;
/** Chronological model-wide speed and latency series. */
export type ModelSeries = Decoded<typeof modelSeries>;
