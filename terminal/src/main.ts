/** Launches the terminal observer in explicitly selected live or synthetic demo mode. */
import { createCliRenderer } from '@opentui/core';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import metadata from '../package.json' with { type: 'json' };
import { createNativeClient, hasEmbeddedObserver, observerPath, runSocketPath } from './client.ts';
import { createDemoClient } from './demo.ts';
import { mountHub } from './hub.ts';
import { loadTheme, saveTheme } from './preferences.ts';
import type { AppMode } from './api.ts';

const arguments_ = process.argv.slice(2);
const invocation = hasEmbeddedObserver() ? 'agent-hub' : 'npm start --';
let pool: string | undefined, project: string | undefined, runHome: string | undefined, runSocket: string | undefined, brokerUid: number | undefined, invalid = false, live = false, demo = false;
for (let index = 0; index < arguments_.length; index++) {
  const value = arguments_[index];
  if (value === '--live') { live = true; continue; }
  if (value === '--demo') { demo = true; continue; }
  if (value === '--help' || value === '-h' || value === '--version' || value === '-V') continue;
  if (value === '--pool' || value.startsWith('--pool=')) {
    const id = value === '--pool' ? arguments_[++index] : value.slice('--pool='.length);
    if (pool || !id || !/^[A-Za-z0-9_.:-]{1,128}$/.test(id)) invalid = true; else pool = id;
    continue;
  }
  if (value === '--home' || value.startsWith('--home=')) {
    const home = value === '--home' ? arguments_[++index] : value.slice('--home='.length);
    if (runHome || !home || home.startsWith('-')) invalid = true; else runHome = home;
    continue;
  }
  if (value === '--socket' || value.startsWith('--socket=')) {
    const socket = value === '--socket' ? arguments_[++index] : value.slice('--socket='.length);
    if (runSocket || !socket || socket.startsWith('-')) invalid = true; else runSocket = socket;
    continue;
  }
  if (value === '--broker-uid' || value.startsWith('--broker-uid=')) {
    const uid = value === '--broker-uid' ? arguments_[++index] : value.slice('--broker-uid='.length);
    if (brokerUid !== undefined || !uid || !/^(0|[1-9]\d*)$/.test(uid) || Number(uid) > 4_294_967_295) invalid = true; else brokerUid = Number(uid);
    continue;
  }
  if (value.startsWith('-') || project) invalid = true; else project = value;
}
if (arguments_.includes('--help') || arguments_.includes('-h')) {
  process.stdout.write(`Agent Hub terminal observer\n\nUsage: ${invocation} [--live | --demo] [--pool ID] [--home DIR] [--socket PATH [--broker-uid UID]] [PROJECT]\n\nLive mode reads configured sources only. Demo mode uses synthetic data.\n`);
} else if (arguments_.includes('--version') || arguments_.includes('-V')) {
  process.stdout.write(`agent-hub ${metadata.version}\n`);
} else if (invalid || live && demo || brokerUid !== undefined && !runSocket) {
  process.stderr.write(`Usage: ${invocation} [--live | --demo] [--pool ID] [--home DIR] [--socket PATH [--broker-uid UID]] [PROJECT]\n`);
  process.exitCode = 2;
} else if (!process.stdin.isTTY || !process.stdout.isTTY) {
  process.stderr.write('Agent Hub requires an interactive terminal.\n');
  process.exitCode = 1;
} else {
  if (project) {
    try { project = realpathSync(resolve(project.startsWith('~/') && process.env.HOME ? `${process.env.HOME}/${project.slice(2)}` : project)); }
    catch { process.stderr.write('Project directory is unavailable.\n'); process.exit(2); }
  }
  const mode: AppMode = demo ? 'demo' : 'live';
  let socket: string | undefined;
  try { socket = mode === 'live' ? runSocketPath(runSocket, runHome, process.env.AGENT_RUN_HOME) : undefined; }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : 'Invalid Run home.'}\n`); process.exit(2); }
  const client = mode === 'demo' ? createDemoClient() : createNativeClient(observerPath(), socket ? { socket, ...(brokerUid === undefined ? {} : { brokerUid }) } : undefined);
  const theme = await loadTheme();
  const renderer = await createCliRenderer({ exitOnCtrlC: false, exitSignals: [], screenMode: 'alternate-screen', useMouse: true, enableMouseMovement: true });
  let dispose = () => {};
  let stopping = false;
  /** Stops only this UI and its own observer processes. */
  async function quit() {
    if (stopping) return;
    stopping = true;
    process.off('SIGINT', quit);
    process.off('SIGTERM', quit);
    dispose();
    await client.close();
    renderer.destroy();
  }
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
  try {
    dispose = mountHub(renderer, client, mode, () => { void quit(); }, { theme, save: saveTheme }, { pool, project });
  } catch (error) {
    await quit();
    throw error;
  }
}
