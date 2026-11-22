/** App-owned finite reads through the closed native observer process. */
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { response } from '../../src/live/protocol.ts';
import type { ReadResponse, Resource as AllResources } from '../../src/live/protocol.ts';
import type { Resource } from '../../terminal/src/api.ts';

/** Correlated response for the native binary's closed resource set. */
export type NativeResponse = ReadResponse & { resource: Resource };

/** Resource supported by the server's observer. */
export type ObserverResource = Extract<AllResources, Resource>;

/** Owns finite observer reads and their process lifetime. */
export interface ObservationClient {
  read(resource: Resource, params?: Record<string, unknown>, signal?: AbortSignal): Promise<NativeResponse>;
  close(): Promise<void>;
}

/** Identity combines up to three 1 MiB producer frames plus its native envelope. */
const OUTPUT_LIMIT = 4 * 1024 * 1024;
/** Requests have the same parameter budget as the desktop observer. */
const REQUEST_LIMIT = 64 * 1024;

/** Creates a static, sanitized error without leaking process stderr or credentials. */
function failure(resource: Resource, code: string, outcome: ReadResponse['outcome'] = 'unavailable'): NativeResponse {
  return { schema_version: 1, source: resource.split('.')[0]!, resource, observed_at_ms: Date.now(), outcome, data: null, error: { code, message: 'Source observation is unavailable.' } };
}

/** Gives the owned observer only configuration and the small platform environment it requires. */
function observerEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of ['HOME', 'PATH', 'XDG_CONFIG_HOME', 'AGENT_HUB_CONFIG', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL']) {
    if (process.env[key] !== undefined) result[key] = process.env[key];
  }
  const temp = [result.TMPDIR, result.TMP, result.TEMP].map(value => {
    if (!value || !isAbsolute(value)) return null;
    try { return realpathSync(value); } catch { return null; }
  }).find(value => value && !/^\/(?:private\/)?tmp(?:\/|$)/.test(value));
  for (const key of ['TMPDIR', 'TMP', 'TEMP']) {
    if (temp) result[key] = temp;
    else delete result[key];
  }
  return result;
}

/** Starts one finite observer per read with an optional test deadline override. */
export function createNativeClient(executable: string, deadlines = { readMs: 20000, killMs: 5000 }): ObservationClient {
  const active = new Set<{ cancel: (code: string) => void; done: Promise<NativeResponse> }>();
  let closed = false;

  /** Bounds one request, owns its child, validates its envelope and fences cancellation. */
  function read(resource: Resource, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<NativeResponse> {
    if (closed || signal?.aborted) return Promise.resolve(failure(resource, 'cancelled'));
    let request: string;
    try {
      request = JSON.stringify({ resource, params }) + '\n';
      if (Buffer.byteLength(request) > REQUEST_LIMIT + 1024) return Promise.resolve(failure(resource, 'params_budget', 'invalid'));
    } catch {
      return Promise.resolve(failure(resource, 'params_json', 'invalid'));
    }
    let cancel = (_code: string) => {};
    let entry: { cancel: (code: string) => void; done: Promise<NativeResponse> };
    const done = new Promise<NativeResponse>(resolve => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'ignore'], env: observerEnvironment(), windowsHide: true, detached: process.platform !== 'win32' });
      } catch {
        resolve(failure(resource, 'observer_start'));
        return;
      }
      let settled = false;
      const chunks: Buffer[] = [];
      let size = 0;
      let cancellation: string | null = null;
      let killTimer: NodeJS.Timeout | undefined;
      const deadline = setTimeout(() => cancel('observer_timeout'), deadlines.readMs);
      deadline.unref();
      /** Settles once after the owned child exits and releases all local listeners. */
      const finish = (value: NativeResponse) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (killTimer) clearTimeout(killTimer);
        signal?.removeEventListener('abort', abort);
        resolve(value);
      };
      /** Ask the native observer to cancel first; a stuck observer is bounded. */
      cancel = (code: string) => {
        if (settled || cancellation) return;
        cancellation = code;
        child.stdin?.end();
        killTimer = setTimeout(() => {
          // A stuck child or inherited output pipe must not delay reaping indefinitely.
          try {
            if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
            else child.kill('SIGKILL');
          } catch { /* It already exited. */ }
          child.stdout?.destroy();
          child.stdin?.destroy();
        }, deadlines.killMs);
        killTimer.unref();
      };
      const abort = () => cancel('cancelled');
      signal?.addEventListener('abort', abort, { once: true });
      child.on('error', () => finish(failure(resource, 'observer_start')));
      child.stdin?.on('error', () => { /* The exit or response supplies the outcome. */ });
      child.stdout?.on('data', (chunk: Buffer) => {
        if (cancellation) return;
        size += chunk.length;
        if (size > OUTPUT_LIMIT) { cancel('observer_frame_budget'); return; }
        chunks.push(chunk);
      });
      child.on('close', code => {
        if (cancellation) { finish(failure(resource, cancellation, cancellation === 'observer_frame_budget' ? 'invalid' : 'unavailable')); return; }
        const output = Buffer.concat(chunks, size);
        if (code !== 0) { finish(failure(resource, 'observer_exit')); return; }
        if (!output.length || output[output.length - 1] !== 10 || output.subarray(0, -1).includes(10)) {
          finish(failure(resource, 'observer_response', 'invalid'));
          return;
        }
        try {
          const envelope = response(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(output)), resource) as NativeResponse;
          if (!Number.isSafeInteger(envelope.observed_at_ms) || envelope.observed_at_ms < 0) throw new Error('invalid receipt clock');
          finish(envelope);
        } catch {
          finish(failure(resource, 'observer_protocol', 'invalid'));
        }
      });
      child.stdin?.write(request);
      if (signal?.aborted) cancel('cancelled');
    });
    entry = { cancel: code => cancel(code), done };
    active.add(entry);
    void done.finally(() => active.delete(entry));
    return done;
  }

  /** Cancels and waits for every process created by this client, never source daemons. */
  async function close(): Promise<void> {
    closed = true;
    const pending = [...active];
    for (const entry of pending) entry.cancel('cancelled');
    await Promise.all(pending.map(entry => entry.done));
  }

  return { read, close };
}
