/** Launches the terminal client in explicitly selected live or synthetic demo mode. */
import { createCliRenderer } from '@opentui/core';
import metadata from '../package.json' with { type: 'json' };
import { createHttpClient } from './client.ts';
import { hubServer } from './endpoint.ts';
import { createDemoClient } from './demo.ts';
import { mountHub } from './hub.ts';
import { loadTheme, saveTheme } from './preferences.ts';
import type { AppMode } from './api.ts';

const arguments_ = process.argv.slice(2);
const invocation = process.env.OTUI_ASSET_ROOT ? 'agent-hub' : 'npm start --';
let pool: string | undefined, project: string | undefined, server: URL | undefined, invalid = false, live = false, demo = false;
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
  if (value === '--server' || value.startsWith('--server=')) {
    const endpoint = value === '--server' ? arguments_[++index] : value.slice('--server='.length);
    try { if (!endpoint || server) invalid = true; else server = hubServer(endpoint); }
    catch { invalid = true; }
    continue;
  }
  if (value.startsWith('-') || project) invalid = true; else project = value;
}
if (arguments_.includes('--help') || arguments_.includes('-h')) {
  process.stdout.write(`Agent Hub terminal client\n\nUsage: ${invocation} [--live | --demo] [--pool ID] [--server URL] [PROJECT]\n\nLive mode uses /run/agent-hub-http/http.sock unless --server is supplied. Demo mode uses synthetic data.\n`);
} else if (arguments_.includes('--version') || arguments_.includes('-V')) {
  process.stdout.write(`agent-hub ${metadata.version}\n`);
} else if (invalid || live && demo || demo && server !== undefined) {
  process.stderr.write(`Usage: ${invocation} [--live | --demo] [--pool ID] [--server URL] [PROJECT]\n`);
  process.exitCode = 2;
} else if (!process.stdin.isTTY || !process.stdout.isTTY) {
  process.stderr.write('Agent Hub requires an interactive terminal.\n');
  process.exitCode = 1;
} else {
  const mode: AppMode = demo ? 'demo' : 'live';
  const client = mode === 'demo' ? createDemoClient() : createHttpClient(server);
  const theme = await loadTheme();
  const renderer = await createCliRenderer({ exitOnCtrlC: false, exitSignals: [], screenMode: 'alternate-screen', useMouse: true, enableMouseMovement: true });
  let dispose = () => {};
  let stopping = false;
  /** Stops only this UI and its own HTTP requests. */
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
