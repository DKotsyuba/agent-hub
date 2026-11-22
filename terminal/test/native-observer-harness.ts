/** App-owned finite reads through the closed native observer process. */
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { response } from '../../src/live/protocol.ts';
import type { ObservationClient, ReadResponse, Resource } from '../src/api.ts';

/** Identity combines up to three 1 MiB producer frames plus its native envelope. */
const OUTPUT_LIMIT = 4 * 1024 * 1024;
/** Requests have the same parameter budget as the desktop observer. */
const REQUEST_LIMIT = 64 * 1024;

let embeddedObserver: string | undefined;
let embeddedTemp: string | undefined;

/** Resolves an explicit socket before CLI and environment Run homes, without changing saved settings. */
export function runSocketPath(socket: string | undefined, home: string | undefined, environmentHome: string | undefined): string | undefined {
  const source = socket ?? home ?? environmentHome;
  if (source === undefined) return undefined;
  if (!source) throw new Error('Agent Run home must not be blank.');
  const tilde = source === '~' || source.startsWith('~/');
  if (tilde && !process.env.HOME) throw new Error('HOME is unavailable.');
  const path = tilde ? resolve(process.env.HOME!, source === '~' ? '' : source.slice(2)) : resolve(source);
  return socket === undefined ? resolve(existsSync(path) ? realpathSync(path) : path, 'api.sock') : path;
}

/** Selects the private observer and held runtime directory of a standalone executable. */
export function useEmbeddedObserver(executable: string, runtime: string): void {
  if (!isAbsolute(executable) || !isAbsolute(runtime)) throw new Error('Embedded runtime paths must be absolute.');
  embeddedObserver = executable;
  embeddedTemp = runtime;
}

/** Reports whether this process uses its bundled observer. */
export function hasEmbeddedObserver(): boolean { return embeddedObserver !== undefined; }

/** Returns the bundled observer or resolves the Cargo build directory. */
export function observerPath(targetDirectory = process.env.CARGO_TARGET_DIR): string {
  if (embeddedObserver) return embeddedObserver;
  const executable = process.platform === 'win32' ? 'agent-hub-observer.exe' : 'agent-hub-observer';
  return targetDirectory ? resolve(targetDirectory, 'debug', executable) : fileURLToPath(new URL(`../../server/observer/target/debug/${executable}`, import.meta.url));
}

/** Creates a static, sanitized error without leaking process stderr or credentials. */
function failure(resource: Resource, code: string, outcome: ReadResponse['outcome'] = 'unavailable'): ReadResponse {
  return { schema_version: 1, source: resource.split('.')[0]!, resource, observed_at_ms: Date.now(), outcome, data: null, error: { code, message: 'Source observation is unavailable.' } };
}

/** Gives the owned observer only configuration, explicit session overrides and platform environment. */
function observerEnvironment(runOverride?: { socket: string; brokerUid?: number }): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of ['HOME', 'PATH', 'XDG_CONFIG_HOME', 'AGENT_HUB_CONFIG', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL']) {
    if (process.env[key] !== undefined) result[key] = process.env[key];
  }
  const temp = embeddedTemp ?? [result.TMPDIR, result.TMP, result.TEMP].map(value => {
    if (!value || !isAbsolute(value)) return null;
    try { return realpathSync(value); } catch { return null; }
  }).find(value => value && !/^\/(?:private\/)?tmp(?:\/|$)/.test(value));
  for (const key of ['TMPDIR', 'TMP', 'TEMP']) {
    if (temp) result[key] = temp;
    else delete result[key];
  }
  if (runOverride) {
    result.AGENT_HUB_SESSION_SOCKET = runOverride.socket;
    if (runOverride.brokerUid !== undefined) result.AGENT_HUB_SESSION_BROKER_UID = String(runOverride.brokerUid);
  }
  return result;
}

/** Starts one finite observer per read with optional session-only Run socket settings. */
export function createNativeClient(executable: string, runOverride?: { socket: string; brokerUid?: number }): ObservationClient {
  const active = new Set<{ cancel: (code: string) => void; done: Promise<ReadResponse> }>();
  let closed = false;

  /** Bounds one request, owns its child, validates its envelope and fences cancellation. */
  function read(resource: Resource, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<ReadResponse> {
    if (closed || signal?.aborted) return Promise.resolve(failure(resource, 'cancelled'));
    let request: string;
    try {
      request = JSON.stringify({ resource, params }) + '\n';
      if (Buffer.byteLength(request) > REQUEST_LIMIT + 1024) return Promise.resolve(failure(resource, 'params_budget', 'invalid'));
    } catch {
      return Promise.resolve(failure(resource, 'params_json', 'invalid'));
    }
    let cancel = (_code: string) => {};
    let entry: { cancel: (code: string) => void; done: Promise<ReadResponse> };
    const done = new Promise<ReadResponse>(resolve => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'ignore'], env: observerEnvironment(runOverride), windowsHide: true, detached: process.platform !== 'win32' });
      } catch {
        resolve(failure(resource, 'observer_start'));
        return;
      }
      let settled = false;
      let output = Buffer.alloc(0);
      let cancellation: string | null = null;
      let killTimer: NodeJS.Timeout | undefined;
      const timeoutSeconds = resource === 'run.agents' && typeof params.wait_seconds === 'number' ? Math.min(60, Math.max(0, params.wait_seconds)) + 20 : 20;
      const deadline = setTimeout(() => cancel('observer_timeout'), timeoutSeconds * 1000);
      deadline.unref();
      /** Settles once after the owned child exits and releases all local listeners. */
      const finish = (value: ReadResponse) => {
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
        killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
        killTimer.unref();
      };
      const abort = () => cancel('cancelled');
      signal?.addEventListener('abort', abort, { once: true });
      child.on('error', () => finish(failure(resource, 'observer_start')));
      child.stdin?.on('error', () => { /* The exit or response supplies the outcome. */ });
      child.stdout?.on('data', (chunk: Buffer) => {
        if (output.length + chunk.length > OUTPUT_LIMIT) { cancel('observer_frame_budget'); return; }
        output = Buffer.concat([output, chunk]);
      });
      child.on('close', code => {
        if (cancellation) { finish(failure(resource, cancellation)); return; }
        if (code !== 0 || !output.length || output[output.length - 1] !== 10 || output.subarray(0, -1).includes(10)) { finish(failure(resource, 'observer_response')); return; }
        try {
          finish(response(JSON.parse(output.toString('utf8')), resource) as ReadResponse);
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
