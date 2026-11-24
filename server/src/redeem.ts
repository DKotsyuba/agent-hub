/**
 * The Hub's only mutating action: redeem one banked Agent Quota reset credit.
 *
 * The native observer stays strictly read-only. This module owns a separate, narrow Quota socket client
 * that can send exactly two operations (`redeem_reset_credit`, `redeem_status`) and nothing else.
 */
import { createConnection } from 'node:net';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { redeemRecord, redeemSettled, type RedeemRecord } from '@agent-hub/domain';
import { HubError } from './errors.ts';

/** Largest accepted Quota reply line. A record is a few hundred bytes. */
const REPLY_LIMIT = 64 * 1024;
/** Config files are tiny; the observer applies the same bound. */
const CONFIG_LIMIT = 64 * 1024;
/** How long an in-flight, unknown or redeemed attempt blocks a duplicate submission. */
const GUARD_TTL_MS = 10 * 60_000;
/** Bound on remembered records used for status fallback and the double-submit guard. */
const MEMORY_LIMIT = 256;

/** Why a Quota exchange did not produce a record. */
export type QuotaFailure =
  /** Nothing reached Quota: endpoint missing, unsafe identity or connection refused. Safe to retry. */
  | 'not_sent'
  /** The request may have been delivered: write, timeout, truncated or malformed reply. */
  | 'uncertain'
  /** Quota refused the calling uid. */
  | 'forbidden';

/** A classified Quota exchange failure without producer text. */
export class QuotaRedeemError extends Error {
  constructor(readonly failure: QuotaFailure) { super(failure); }
}

/** The two operations the server may send to Agent Quota. */
export interface QuotaRedeemClient {
  redeem(input: { account: string; credit_id: string; request_id: string }): Promise<RedeemRecord>;
  status(requestId: string): Promise<RedeemRecord>;
}

/** Trusted Quota socket and its service uid. */
export interface QuotaEndpoint { socket: string; uid: number }

/** Mirrors the observer's connection config: AGENT_HUB_CONFIG, then per-user, then host-wide, then Linux default. */
export async function resolveQuotaEndpoint(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): Promise<QuotaEndpoint | null> {
  const fallback: QuotaEndpoint | null = platform === 'linux' ? { socket: '/run/agent-quota/quota.sock', uid: 999 } : null;
  const explicit = env.AGENT_HUB_CONFIG;
  let paths: string[];
  if (explicit !== undefined) {
    if (!isAbsolute(explicit)) return null;
    paths = [explicit];
  } else {
    const home = env.HOME && isAbsolute(env.HOME) ? env.HOME : null;
    const config = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : home ? join(home, '.config') : null;
    paths = [...(config ? [join(config, 'dev.agent-mcp.hub', 'connections.json')] : []), '/etc/agent-hub/connections.json'];
  }
  for (const path of paths) {
    let bytes: Buffer;
    try { bytes = await readFile(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && explicit === undefined) continue;
      return null;
    }
    if (bytes.length > CONFIG_LIMIT) return null;
    try {
      const quota = (JSON.parse(bytes.toString('utf8')) as { quota?: { socket?: unknown; server_uid?: unknown } }).quota ?? {};
      if (quota.socket === undefined && quota.server_uid === undefined) return fallback;
      if (typeof quota.socket === 'string' && isAbsolute(quota.socket) && Number.isSafeInteger(quota.server_uid) && (quota.server_uid as number) >= 0) {
        return { socket: quota.socket, uid: quota.server_uid as number };
      }
    } catch { /* A malformed config disables the action rather than guessing another endpoint. */ }
    return null;
  }
  return fallback;
}

/** Checks the socket owner and permissions like the observer does before trusting the endpoint. */
async function checkedSocket(endpoint: QuotaEndpoint) {
  try {
    const before = await lstat(endpoint.socket);
    const parent = await lstat(dirname(endpoint.socket));
    if (!before.isSocket() || before.uid !== endpoint.uid || (before.mode & 0o007) !== 0
      || parent.uid !== endpoint.uid || (parent.mode & 0o022) !== 0) throw new QuotaRedeemError('not_sent');
    return before;
  } catch (error) {
    throw error instanceof QuotaRedeemError ? error : new QuotaRedeemError('not_sent');
  }
}

/** Sends one NDJSON request and returns the single reply line. Quota replies once and closes. */
async function exchange(endpoint: QuotaEndpoint, request: unknown, timeoutMs: number): Promise<unknown> {
  const before = await checkedSocket(endpoint);
  return new Promise((resolve, reject) => {
    let sent = false;
    let settled = false;
    const chunks: Buffer[] = [];
    let size = 0;
    const socket = createConnection({ path: endpoint.socket });
    const finish = (error: QuotaRedeemError | null, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new QuotaRedeemError(sent ? 'uncertain' : 'not_sent')), timeoutMs);
    timer.unref();
    socket.once('connect', () => {
      // The path is re-checked after connecting so a swapped inode is not trusted.
      void lstat(endpoint.socket).then(after => {
        if (after.ino !== before.ino || after.dev !== before.dev) { finish(new QuotaRedeemError('not_sent')); return; }
        socket.write(JSON.stringify(request) + '\n', error => {
          if (error) finish(new QuotaRedeemError('uncertain'));
          else sent = true;
        });
      }, () => finish(new QuotaRedeemError('not_sent')));
    });
    socket.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > REPLY_LIMIT) { finish(new QuotaRedeemError('uncertain')); return; }
      chunks.push(chunk);
      const all = Buffer.concat(chunks, size);
      const end = all.indexOf(10);
      if (end < 0) return;
      try { finish(null, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(all.subarray(0, end)))); }
      catch { finish(new QuotaRedeemError('uncertain')); }
    });
    socket.on('error', () => finish(new QuotaRedeemError(sent ? 'uncertain' : 'not_sent')));
    socket.on('close', () => finish(new QuotaRedeemError(sent ? 'uncertain' : 'not_sent')));
  });
}

/** Producer error strings meaning that the caller identity is not allowed. */
const DENIED = new Set(['unauthorized', 'forbidden', 'permission_denied', 'peer_not_allowed']);

/** Accepts a bare record or the family `{version:1,result|error}` envelope, and validates identity echoes. */
function decodeReply(reply: unknown, expect: { request_id: string; account?: string; credit_id?: string }): RedeemRecord {
  let body = reply;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const fields = body as Record<string, unknown>;
    if ('error' in fields) {
      throw new QuotaRedeemError(typeof fields.error === 'string' && DENIED.has(fields.error) ? 'forbidden' : 'uncertain');
    }
    if ('result' in fields && fields.version === 1) body = fields.result;
  }
  let record: RedeemRecord;
  try { record = redeemRecord(body); } catch { throw new QuotaRedeemError('uncertain'); }
  if (record.request_id !== expect.request_id
    || expect.account !== undefined && record.account !== expect.account
    || expect.credit_id !== undefined && record.credit_id !== expect.credit_id) throw new QuotaRedeemError('uncertain');
  return record;
}

/** Creates the narrow Quota client. The endpoint is resolved per call so configuration changes apply without restart. */
export function createQuotaRedeemClient(resolve: () => Promise<QuotaEndpoint | null> = () => resolveQuotaEndpoint(), timeoutMs = 10_000): QuotaRedeemClient {
  return {
    async redeem(input) {
      const endpoint = await resolve();
      if (!endpoint) throw new QuotaRedeemError('not_sent');
      const reply = await exchange(endpoint, { version: 1, method: 'redeem_reset_credit', account: input.account, credit_id: input.credit_id, request_id: input.request_id }, timeoutMs);
      return decodeReply(reply, input);
    },
    async status(requestId) {
      const endpoint = await resolve();
      if (!endpoint) throw new QuotaRedeemError('not_sent');
      return decodeReply(await exchange(endpoint, { version: 1, method: 'redeem_status', request_id: requestId }, timeoutMs), { request_id: requestId });
    },
  };
}

/** Writes one safe audit line. Account and credit IDs are identifiers, never credentials. */
function audit(action: 'submit' | 'status' | 'duplicate', record: Pick<RedeemRecord, 'account' | 'credit_id' | 'request_id'>, outcome: string): void {
  console.error(JSON.stringify({ event: 'quota_redeem', action, account: record.account, creditId: record.credit_id, requestId: record.request_id, outcome }));
}

/** Server-side redeem state machine: request IDs, double-submit guard and transport-error mapping. */
export function createRedeemService(client: QuotaRedeemClient, options: { now?: () => number; newId?: () => string } = {}) {
  const now = options.now ?? Date.now;
  const newId = options.newId ?? (() => crypto.randomUUID());
  const records = new Map<string, RedeemRecord>();
  const guard = new Map<string, { requestId: string; at: number }>();
  const inflight = new Map<string, Promise<RedeemRecord>>();

  /** Remembers the latest record, evicting the oldest entries. */
  const remember = (record: RedeemRecord) => {
    records.delete(record.request_id);
    records.set(record.request_id, record);
    while (records.size > MEMORY_LIMIT) records.delete(records.keys().next().value!);
    for (const [key, entry] of guard) if (!records.has(entry.requestId) || now() - entry.at >= GUARD_TTL_MS) guard.delete(key);
  };
  /** Display record for an exchange that produced no Quota record. */
  const synthetic = (base: Pick<RedeemRecord, 'request_id' | 'account' | 'credit_id'>, state: 'unknown' | 'failed', reason: string, created = Math.floor(now() / 1000)): RedeemRecord =>
    ({ ...base, state, reason, created_at: created, updated_at: Math.floor(now() / 1000) });

  /** Asks Quota about an earlier request; transport trouble keeps the last known record as unknown, never a new request. */
  async function refresh(known: RedeemRecord): Promise<RedeemRecord> {
    try {
      const fresh = await client.status(known.request_id);
      remember(fresh);
      return fresh;
    } catch (error) {
      if (error instanceof QuotaRedeemError && error.failure === 'forbidden') throw new HubError('forbidden');
      return redeemSettled(known.state) ? known : { ...known, state: 'unknown', reason: known.reason ?? 'quota_unreachable' };
    }
  }

  /** Sends one new request with a server-generated ID. */
  async function send(account: string, creditId: string, key: string): Promise<RedeemRecord> {
    const base = { request_id: newId(), account, credit_id: creditId };
    try {
      const record = await client.redeem(base);
      remember(record);
      if (!redeemSettled(record.state) || record.state === 'redeemed') guard.set(key, { requestId: record.request_id, at: now() });
      audit('submit', record, record.state + (record.reason ? ':' + record.reason : ''));
      return record;
    } catch (error) {
      const failure = error instanceof QuotaRedeemError ? error.failure : 'uncertain';
      if (failure === 'forbidden') { audit('submit', base, 'forbidden'); throw new HubError('forbidden'); }
      if (failure === 'not_sent') {
        const record = synthetic(base, 'failed', 'quota_unavailable');
        audit('submit', base, 'failed:quota_unavailable');
        return record;
      }
      // The request may have been delivered: remember it so a retry asks about this ID instead of creating another.
      const record = synthetic(base, 'unknown', 'quota_unreachable');
      remember(record);
      guard.set(key, { requestId: record.request_id, at: now() });
      audit('submit', base, 'unknown:quota_unreachable');
      return record;
    }
  }

  return {
    /** Starts a redemption, or returns the existing attempt for the same account and credit. */
    async submit(account: string, creditId: string): Promise<RedeemRecord> {
      const key = account + '\0' + creditId;
      const running = inflight.get(key);
      if (running) return running;
      const work = (async () => {
        const entry = guard.get(key);
        const known = entry && now() - entry.at < GUARD_TTL_MS ? records.get(entry.requestId) : undefined;
        if (known) {
          const current = await refresh(known);
          audit('duplicate', current, current.state);
          // A redeemed credit is never spent again from a stale view; failed or rejected attempts may be retried.
          if (!redeemSettled(current.state) || current.state === 'redeemed') return current;
          guard.delete(key);
        }
        return send(account, creditId, key);
      })();
      inflight.set(key, work);
      try { return await work; } finally { inflight.delete(key); }
    },

    /** Reads one attempt's status without ever creating a request. */
    async status(requestId: string): Promise<RedeemRecord> {
      const known = records.get(requestId);
      try {
        const record = await client.status(requestId);
        remember(record);
        if (!known || known.state !== record.state) audit('status', record, record.state);
        return record;
      } catch (error) {
        if (error instanceof QuotaRedeemError && error.failure === 'forbidden') throw new HubError('forbidden');
        if (!known) throw new HubError('source_unavailable');
        return redeemSettled(known.state) ? known : { ...known, state: 'unknown', reason: known.reason ?? 'quota_unreachable' };
      }
    },
  };
}

/** Redeem capability injected into the HTTP handler. */
export type RedeemService = ReturnType<typeof createRedeemService>;
