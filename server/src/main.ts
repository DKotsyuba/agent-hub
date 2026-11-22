/** Bun executable entry for the private Unix listener and explicit loopback development mode. */
import { chmod, lstat, realpath, unlink } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHttp } from './http.ts';
import { errorResponse, HubError } from './errors.ts';
import { createNativeClient } from './observer.ts';
import project from '../../package.json';

/** Limited Bun server controls used by the application. */
interface Listener {
  stop(closeConnections?: boolean): Promise<void>;
  timeout(request: Request, seconds: number): void;
}

/** Bun runtime listener API, with transport selected before construction. */
interface Runtime {
  serve(options: ({ unix: string } | { hostname: '127.0.0.1'; port: number }) & {
    fetch(request: Request, server: Listener): Promise<Response>;
    idleTimeout: number;
    maxRequestBodySize: number;
  }): Listener;
}

/** Probes a socket without sending a request. Only a refused connection indicates a stale socket. */
async function stale(path: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ path });
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', (error: NodeJS.ErrnoException) => resolve(error.code === 'ECONNREFUSED'));
    socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
  });
}

/** Requires the service-owned canonical socket directory and rejects unexpected entries. */
async function prepareSocket(path: string): Promise<void> {
  const parent = dirname(path);
  const dir = await lstat(parent);
  if (!isAbsolute(path) || resolve(path) !== path || await realpath(parent) !== parent || !dir.isDirectory()
    || dir.uid !== process.getuid?.() || dir.gid !== process.getgid?.() || (dir.mode & 0o777) !== 0o750) {
    throw new Error('Unix listener requires an owned canonical directory with mode 0750.');
  }
  const file = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!file) return;
  if (!file.isSocket() || file.uid !== dir.uid || file.gid !== dir.gid || !(await stale(path))) {
    throw new Error('Unix socket path is in use or has unexpected ownership or type.');
  }
  const current = await lstat(path);
  if (current.ino !== file.ino || current.dev !== file.dev) throw new Error('Unix socket path changed.');
  await unlink(path);
}

/** Normalizes a single explicitly configured public HTTPS origin. */
function publicOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.host !== url.hostname || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('Expected one public HTTPS origin.');
  }
  return url.origin;
}

/** Binds the selected transport and grants only the owned Unix socket group access. */
export async function listen(http: ReturnType<typeof createHttp>, transport: { unix: string } | { port: number }) {
  const unix = 'unix' in transport ? transport.unix : null;
  if (unix !== null) await prepareSocket(unix);
  const runtime = (globalThis as unknown as { Bun: Runtime }).Bun;
  const previousMask = unix !== null ? process.umask(0o077) : null;
  let listener: Listener;
  try {
    listener = runtime.serve({
      ...('unix' in transport ? transport : { hostname: '127.0.0.1' as const, port: transport.port }),
      idleTimeout: 35,
      maxRequestBodySize: 1024,
      fetch(request, server) {
        if (request.method === 'GET' && (request.headers.has('transfer-encoding') ||
            Number(request.headers.get('content-length')) !== 0 || request.body !== null)) {
          return Promise.resolve(errorResponse(new HubError('invalid_request')));
        }
        return http.fetch(request, () => server.timeout(request, 0));
      },
    });
  } finally {
    if (previousMask !== null) process.umask(previousMask);
  }
  if (unix !== null) {
    try { await chmod(unix, 0o660); }
    catch (error) { await listener.stop(true); await http.close(); throw error; }
  }
  let stopping: Promise<void> | undefined;
  /** Stops admission and cancels streams and source children exactly once. */
  function stop(): Promise<void> {
    stopping ??= Promise.all([listener.stop(true), http.close()]).then(() => {});
    return stopping;
  }
  return { stop };
}

/** Starts the selected transport and drains owned reads on a termination signal. */
async function main(): Promise<void> {
  const [flag, value, ...rest] = process.argv.slice(2);
  if (!value || rest.length || (flag !== '--unix' && flag !== '--dev-loopback')) {
    throw new Error('Usage: hub-server --unix /absolute/socket or --dev-loopback PORT');
  }
  const unix = flag === '--unix' ? value : null;
  if (unix !== null) {
    if (process.env.AGENT_HUB_CONFIG !== undefined && !isAbsolute(process.env.AGENT_HUB_CONFIG)) throw new Error('Expected an absolute source configuration path.');
  } else if (!/^\d{1,5}$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error('Invalid loopback port.');
  const releaseRoot = resolve(dirname(process.execPath), '..');
  const compiled = new URL(import.meta.url).pathname.startsWith('/$bunfs/');
  const root = compiled ? releaseRoot : resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const executable = compiled ? resolve(root, 'libexec/agent-hub-observer')
    : resolve(process.env.CARGO_TARGET_DIR ?? resolve(root, 'server/observer/target'), 'debug/agent-hub-observer');
  const http = createHttp(createNativeClient(executable), {
    localHost: unix !== null ? 'localhost' : '127.0.0.1:' + Number(value),
    publicOrigin: publicOrigin(process.env.AGENT_HUB_PUBLIC_ORIGIN), release: project.version,
    webRoot: resolve(root, compiled ? 'share/web' : 'dist'),
  });
  const listener = await listen(http, unix === null ? { port: Number(value) } : { unix });
  /** Stops intake immediately, then waits for owned work before leaving the service. */
  function stop(): void {
    void listener.stop().catch(() => { process.exitCode = 1; });
  }
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (import.meta.main) void main().catch(() => {
  console.error('Hub server startup failed. Verify the listener arguments, socket directory and public origin.');
  process.exitCode = 1;
});
