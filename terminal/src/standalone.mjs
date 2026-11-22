/** Starts the Bun executable with its own private native assets. */
import { accessSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, realpathSync, readdirSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import observerAsset from '../observer/target/x86_64-unknown-linux-gnu/release/agent-hub-observer' with { type: 'file' };
import nativeAsset from '@opentui/core-linux-x64';
import { useEmbeddedObserver } from './client.ts';

/** Finds owned runtime parents outside operating-system temporary roots. */
function runtimeParents() {
  const parents = new Set();
  for (const value of [process.env.TMPDIR, process.env.TMP, process.env.TEMP, process.env.XDG_RUNTIME_DIR, process.env.HOME]) {
    if (!value || !isAbsolute(value)) continue;
    try {
      const original = lstatSync(value), path = realpathSync(value), meta = statSync(path);
      if (original.isSymbolicLink() || !meta.isDirectory() || meta.uid !== process.getuid() || (meta.mode & 0o022) !== 0 || /^\/(?:private\/)?(?:tmp|var\/tmp)(?:\/|$)/.test(path)) continue;
      accessSync(path, constants.W_OK | constants.X_OK);
      parents.add(path);
    } catch { /* Try the next explicitly available directory. */ }
  }
  return parents;
}

/** Removes this process's files through its held directory, never a substituted path. */
function cleanup(runtime) {
  if (!runtime) return;
  let failed = false;
  try {
    if (runtime.anchor) {
      for (const name of readdirSync(runtime.anchor)) rmSync(join(runtime.anchor, name), { recursive: true });
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') failed = true;
  }
  try {
    const current = lstatSync(runtime.path);
    if (current.dev === runtime.meta.dev && current.ino === runtime.meta.ino && current.isDirectory() && current.uid === process.getuid()) rmdirSync(runtime.path);
    else failed = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') failed = true;
  }
  try { if (runtime.fd !== undefined) closeSync(runtime.fd); } catch { failed = true; }
  if (failed) process.stderr.write('Unable to remove the Agent Hub runtime directory.\n');
}

const [libraryBytes, observerBytes] = await Promise.all([
  Bun.file(nativeAsset).arrayBuffer(),
  Bun.file(observerAsset).arrayBuffer(),
]);
let runtime;
for (const parent of runtimeParents()) {
  let candidate;
  try {
    const path = mkdtempSync(join(parent, 'agent-hub-'));
    const meta = lstatSync(path);
    candidate = { path, meta };
    if (!meta.isDirectory() || meta.uid !== process.getuid() || (meta.mode & 0o077) !== 0) throw new Error('The runtime directory is not private.');
    const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    candidate.fd = fd;
    const held = fstatSync(fd);
    if (held.dev !== meta.dev || held.ino !== meta.ino || held.uid !== process.getuid() || (held.mode & 0o077) !== 0) throw new Error('The runtime directory changed during startup.');
    candidate.anchor = `/proc/${process.pid}/fd/${fd}`;
    const assetRoot = join(candidate.anchor, 'assets');
    const libraryDir = join(assetRoot, '@opentui', 'core-linux-x64');
    mkdirSync(libraryDir, { recursive: true, mode: 0o700 });
    const observer = join(candidate.anchor, 'agent-hub-observer');
    writeFileSync(join(libraryDir, 'libopentui.so'), Buffer.from(libraryBytes), { flag: 'wx', mode: 0o700 });
    writeFileSync(observer, Buffer.from(observerBytes), { flag: 'wx', mode: 0o700 });
    accessSync(observer, constants.X_OK);
    candidate.assetRoot = assetRoot;
    candidate.observer = observer;
    runtime = candidate;
    break;
  } catch (error) {
    cleanup(candidate);
    if (!['EACCES', 'EPERM', 'EROFS', 'ENOENT', 'ENOTDIR'].includes(error?.code)) throw error;
  }
}
if (!runtime) throw new Error('No private executable runtime directory. Set TMPDIR to an owned writable directory outside /tmp.');

process.once('exit', () => cleanup(runtime));
try {
  process.env.OTUI_ASSET_ROOT = runtime.assetRoot;
  process.env.TMPDIR = runtime.anchor;
  process.env.TMP = runtime.anchor;
  process.env.TEMP = runtime.anchor;
  useEmbeddedObserver(runtime.observer, runtime.anchor);
  await import('./main.ts');
} catch (error) {
  cleanup(runtime);
  runtime = undefined;
  throw error;
}
