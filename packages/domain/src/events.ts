/** Closed SSE topic set and event payloads. */
import { observation, opaque, resourceId } from './common.ts';
import { type Decoded, type Decoder, array, count, invalid, nullable, object, oneOf, tagged } from './schema.ts';

/** Topics without a selected resource. */
export const TOPICS = ['overview', 'sessions', 'pools', 'quota', 'worktrees', 'incidents'] as const;

/** The closed set of accepted subscription rates, in seconds. */
export const INTERVALS = [1, 3, 5, 10] as const;

/** Selected detail topic suffixes. */
const DETAIL_TOPICS = {
  session: ['detail', 'history', 'initial-task', 'result'],
  pool: ['detail', 'history', 'members', 'proposals', 'decisions', 'criteria', 'votes', 'deliveries', 'content', 'records'],
  worktree: ['detail'],
} as const;

/** A selected resource and section, or a root topic. */
export type Topic = typeof TOPICS[number]
  | `session:${string}:${typeof DETAIL_TOPICS.session[number]}`
  | `pool:${string}:${typeof DETAIL_TOPICS.pool[number]}`
  | `worktree:${string}:${typeof DETAIL_TOPICS.worktree[number]}`;

/** A topic may refer to one known resource and one declared detail suffix. */
export const topic: Decoder<Topic> = (value, path = '$') => {
  if (typeof value !== 'string') return invalid(path, 'SSE topic');
  if ((TOPICS as readonly string[]).includes(value)) return value as Topic;
  const [kind, id, section, ...extra] = value.split(':');
  if (extra.length || !Object.hasOwn(DETAIL_TOPICS, kind)) return invalid(path, 'SSE topic');
  if (!(DETAIL_TOPICS[kind as keyof typeof DETAIL_TOPICS] as readonly string[]).includes(section)) return invalid(path, 'SSE topic');
  resourceId(id, path);
  return value as Topic;
};

/** A selected resource key groups its detail topics on one stream. */
export function detailScope(topic: Topic): string | null {
  return topic.includes(':') ? topic.slice(0, topic.lastIndexOf(':')) : null;
}

/** JSON data for each named SSE frame. A heartbeat is a comment with no JSON data. */
export const event = tagged('type', {
  ready: object({ type: oneOf('ready'), topics: array(topic), observedAtMs: count }),
  changed: object({ type: oneOf('changed'), topic, boundary: nullable(opaque) }),
  'source-state': object({ type: oneOf('source-state'), topic, observation }),
});

/** A decoded SSE event with its type matching the frame name. */
export type HubEvent = Decoded<typeof event>;
