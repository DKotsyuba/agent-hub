/** Read-only Agent Stats socket source for the Hub HTTP routes. */
import { createConnection } from 'node:net';
import { modelSeries, modelStats, type ApiRequest, type Observation } from '@agent-hub/domain';

/** Only summary and series requests can originate from Hub. */
type Query = Extract<NonNullable<ApiRequest>, { route: 'modelSpeed' | 'modelSpeedSeries' }>;

/** Maximum Agent Stats v1 response, including line framing. */
const REPLY_LIMIT = 1024 * 1024;

/** Exchanges one bounded UTF-8 JSON line and closes on response, timeout or cancellation. */
function exchange(path: string, request: object, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path });
    const chunks: Buffer[] = [];
    let size = 0;
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(2000)]);
    const abort = () => socket.destroy();
    timeout.addEventListener('abort', abort, { once: true });
    socket.once('close', () => {
      timeout.removeEventListener('abort', abort);
      reject(new Error('stats_socket_closed'));
    });
    socket.on('error', reject);
    socket.once('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('data', (chunk: Buffer) => {
      const end = chunk.indexOf(10);
      const part = end < 0 ? chunk : chunk.subarray(0, end);
      size += part.length;
      if (size >= REPLY_LIMIT) { socket.destroy(); return; }
      chunks.push(part);
      if (end < 0) return;
      try { resolve(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)))); }
      catch { resolve(null); }
      finally { socket.destroy(); }
    });
    if (timeout.aborted) abort();
  });
}

/** Projects producer outcomes without leaking socket or upstream error details. */
export async function readModelSpeed(query: Query, signal: AbortSignal, path = '/run/agent-stats/read.sock') {
  const observation: Observation = { source: 'stats', outcome: 'ok', producerAtMs: null, observedAtMs: Date.now() };
  const summary = query.route === 'modelSpeed';
  const request = summary
    ? { version: 1, op: 'model_stats', window: query.window, group_by: query.group_by }
    : { version: 1, op: 'model_series', model: query.model, window: query.window, bucket: query.bucket };
  let reply: unknown;
  try { reply = await exchange(path, request, signal); }
  catch { return { data: null, observations: [{ ...observation, outcome: 'unavailable' }] }; }
  try {
    if (typeof reply !== 'object' || reply === null || !('version' in reply)) throw new Error();
    if (reply.version !== 1) return { data: null, observations: [{ ...observation, outcome: 'incompatible' }] };
    if ('ok' in reply && reply.ok === false && 'error' in reply && typeof reply.error === 'string') {
      const outcome = reply.error === 'query_too_large' ? 'partial' : 'unavailable';
      return { data: null, observations: [{ ...observation, outcome }] };
    }
    if (!('ok' in reply) || reply.ok !== true || !('data' in reply)) throw new Error();
    const data = summary ? modelStats(reply.data) : modelSeries(reply.data);
    if (data.window !== query.window || (summary
      ? !('group_by' in data) || data.group_by !== query.group_by
      : !('model' in data) || data.model !== query.model || data.bucket !== query.bucket)) throw new Error();
    const metrics = 'groups' in data ? data.groups : data.buckets;
    const sufficient = metrics.some(({ metrics }) => metrics.speed_tokens_per_second.count || metrics.ttft_ms.count);
    return { data, observations: [{ ...observation, outcome: sufficient ? 'ok' : 'missing' }] };
  } catch { return { data: null, observations: [{ ...observation, outcome: 'invalid' }] }; }
}
