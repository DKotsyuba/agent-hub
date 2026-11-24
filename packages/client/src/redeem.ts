/** Browser-safe client for the single mutating Hub action: redeeming a banked reset credit. */
import { REDEEM_HEADER, REDEEM_HEADER_VALUE, REDEEM_PATH, REQUEST_ID, apiError, redeemRecord, redeemSettled } from '../../domain/src/index.ts';
import type { RedeemRecord } from '../../domain/src/index.ts';
import { HubHttpError } from './index.ts';
import type { HubOptions } from './index.ts';

export type { RedeemRecord } from '../../domain/src/index.ts';

/** Creates the redeem transport. A POST is never retried here: the caller owns the one request. */
export function createRedeemClient(options: HubOptions = {}) {
  const base = options.baseUrl ?? globalThis.location?.origin;
  if (!base) throw new Error('A Hub base URL is required.');
  const send = options.fetch ?? globalThis.fetch.bind(globalThis);

  /** Decodes a record or the safe machine error. */
  async function decode(response: Response): Promise<RedeemRecord> {
    if (response.ok) return redeemRecord(await response.json());
    const parsed = await response.json().then(value => apiError(value).error).catch(() => null);
    throw new HubHttpError(parsed?.code ?? 'http_error', response.status, parsed?.retryable);
  }

  return {
    /** Redeems the given credit once. The server generates the idempotency key. */
    async redeem(account: string, creditId: string, signal?: AbortSignal): Promise<RedeemRecord> {
      return decode(await send(new URL(REDEEM_PATH, base), {
        method: 'POST', signal, redirect: 'error', credentials: 'same-origin',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', [REDEEM_HEADER]: REDEEM_HEADER_VALUE },
        body: JSON.stringify({ account, credit_id: creditId }),
      }));
    },
    /** Reads the current state of an earlier attempt. */
    async status(requestId: string, signal?: AbortSignal): Promise<RedeemRecord> {
      return decode(await send(new URL(REDEEM_PATH + '/' + REQUEST_ID(requestId), base), {
        method: 'GET', signal, redirect: 'error', headers: { Accept: 'application/json' },
      }));
    },
  };
}

/** Waiting policy: 2 s between reads for about one minute. */
export const REDEEM_POLL = { intervalMs: 2000, timeoutMs: 60_000 } as const;

/** Dependencies of the polling loop; the defaults use real time. */
export interface RedeemPollOptions {
  status: (requestId: string, signal?: AbortSignal) => Promise<RedeemRecord>;
  intervalMs?: number;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  onUpdate?: (record: RedeemRecord) => void;
}

/** Aborts a wait promptly when the view goes away. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
    const stop = () => { clearTimeout(timer); reject(signal!.reason); };
    signal?.addEventListener('abort', stop, { once: true });
  });
}

/**
 * Follows an attempt until Quota settles it or the deadline passes. Read failures are tolerated while waiting.
 * A deadline with no terminal state yields `unknown`: the credit may or may not have been spent.
 */
export async function awaitRedeem(initial: RedeemRecord, options: RedeemPollOptions): Promise<RedeemRecord> {
  const { intervalMs = REDEEM_POLL.intervalMs, timeoutMs = REDEEM_POLL.timeoutMs, now = Date.now, sleep = pause } = options;
  const deadline = now() + timeoutMs;
  let latest = initial;
  while (!redeemSettled(latest.state)) {
    if (now() >= deadline) return { ...latest, state: 'unknown', reason: latest.reason ?? 'timeout' };
    await sleep(intervalMs, options.signal);
    options.signal?.throwIfAborted();
    try {
      latest = await options.status(latest.request_id, options.signal);
      options.onUpdate?.(latest);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      // Keep waiting: a transient read failure is not an outcome.
    }
  }
  return latest;
}

/** Display classification of a record for the Quota view. */
export type RedeemOutcome = { kind: 'pending' | 'redeemed' | 'unknown' } | { kind: 'failed'; reason: string | null };

/** Maps a Quota record to what the owner should read; rejected and failed carry the producer reason. */
export function redeemOutcome(record: RedeemRecord): RedeemOutcome {
  switch (record.state) {
    case 'redeemed': return { kind: 'redeemed' };
    case 'rejected': case 'failed': return { kind: 'failed', reason: record.reason };
    case 'pending': return { kind: 'pending' };
    case 'unknown': return { kind: 'unknown' };
  }
}
