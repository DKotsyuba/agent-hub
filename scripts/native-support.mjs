/** Isolated macOS WKWebView acceptance using the prepared optional W3C test driver. */
import { remote } from 'webdriverio';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

/** @type {string} Approved root for native test artifacts and private fixture files. */
export const nativeRoot = path.join(os.tmpdir(), 'native');

/** Allocates one currently unused loopback port; launch failure remains an explicit test failure.
 * @returns {Promise<number>} A local ephemeral port, released before app startup.
 */
async function freePort() {
  /** @type {import('node:net').Server} Temporary exclusive loopback reservation, closed before launch. */
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  /** @type {import('node:net').AddressInfo|string|null} Actual reservation endpoint; never a fixed external port. */
  const address = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (!address || typeof address === 'string') throw new Error('No loopback port allocated');
  return address.port;
}

/** Requests genuine foreground visibility for this explicitly owned acceptance app/window.
 * Only the acceptance config grants these fixed native actions; document visibility is never spoofed.
 * @param {import('webdriverio').Browser} browser Connected owned native acceptance session.
 * @returns {Promise<void>} Native show/focus requests complete; the caller must verify actual visibility.
 * @throws {Error} Closed session, missing test-only permissions, or native invocation failure.
 */
export async function activateOwnedWindow(browser) {
  await browser.execute(async () => {
    await window.__TAURI_INTERNALS__.invoke('plugin:app|app_show');
    await window.__TAURI_INTERNALS__.invoke('plugin:window|show', { label: 'main' });
    await window.__TAURI_INTERNALS__.invoke('plugin:window|set_focus', { label: 'main' });
  });
}

/** Starts only the explicitly supplied test binary, never an installed app or resident service.
 * @param {{binary:string, connections:string}} options Absolute test binary and connection fixture file.
 * @returns {Promise<{browser:import('webdriverio').Browser, directory:string, close:()=>Promise<void>}>} Owned test session and idempotent cleanup.
 * @throws {Error} Invalid paths, early app exit, driver timeout, or W3C handshake failure, or missing acceptance-only own-app/window visibility permissions.
 */
export async function createNativeSession({ binary, connections }) {
  if (!path.isAbsolute(binary) || !path.isAbsolute(connections)) throw new Error('Absolute binary and connection fixture paths required');
  await Promise.all([fs.access(binary), fs.access(connections), fs.mkdir(nativeRoot, { recursive: true })]);
  /** @type {string} Unique private session directory retaining screenshots/logs after cleanup. */
  const directory = await fs.mkdtemp(path.join(nativeRoot, 'session-'));
  /** @type {number} Local WebDriver endpoint for this directly owned app only. */
  const port = await freePort();
  /** @type {import('node:fs/promises').FileHandle} App diagnostic descriptor, closed during cleanup. */
  const log = await fs.open(path.join(directory, 'app.log'), 'wx');
  /** @type {Record<string,string>} Minimal GUI/runtime environment, excluding provider tokens and SSH agents. */
  const env = Object.fromEntries(['HOME', 'PATH', 'USER', 'LOGNAME', 'LANG', '__CF_USER_TEXT_ENCODING'].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
  Object.assign(env, { TMPDIR: directory, TMP: directory, TEMP: directory, AGENT_HUB_CONFIG: connections, TAURI_WEBDRIVER_PORT: String(port) });
  /** @type {import('node:child_process').ChildProcess} Direct app ownership handle; no resident process is targeted. */
  const child = spawn(binary, [], { env, stdio: ['ignore', log.fd, log.fd] });
  /** @type {Error|undefined} Startup failure retained without reflecting child stderr. */
  let spawnError;
  child.once('error', error => { spawnError = error; });
  /** @type {Promise<void>} Resolves only after the owned process exits or fails to spawn. */
  const exited = new Promise(resolve => { child.once('exit', () => resolve()); child.once('error', () => resolve()); });
  /** @type {import('webdriverio').Browser|undefined} W3C session available after successful handshake. */
  let browser;
  /** @type {boolean} Idempotent cleanup latch; repeated callers never signal twice. */
  let closed = false;
  /** Stops only this directly owned app and joins its process; residents are not signalled.
   * @returns {Promise<void>} Resolves after graceful last-window exit or failed-start cleanup, then log closure.
   */
  async function close() {
    if (closed) return;
    closed = true;
    if (browser) { try { await browser.closeWindow(); } catch { /* Closing the last window may close the WebDriver HTTP response first. */ } }
    else if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    /** @type {boolean} Unreferenced deadline cannot keep Node alive after an already completed app exit. */
    const ended = await Promise.race([exited.then(() => true), delay(10000, false, { ref: false })]);
    if (!ended) {
      child.kill('SIGTERM');
      /** @type {boolean} Bounded fallback joins this app before reporting failed graceful shutdown. */
      const terminated = await Promise.race([exited.then(() => true), delay(3000, false, { ref: false })]);
      if (!terminated) { child.kill('SIGKILL'); await exited; }
    }
    await log.close();
    if (!ended) throw new Error('Native app did not exit after its last window closed');
  }
  try {
    /** @type {number} Finite startup deadline in Unix milliseconds; not a product execution timeout. */
    const deadline = Date.now() + 30000;
    /** @type {boolean} True only after this app's W3C readiness response. */
    let ready = false;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Test app exited before WebDriver became ready');
      try { /** @type {Response} Bounded request to the explicitly allocated local test endpoint. */ const response = await fetch('http://127.0.0.1:' + port + '/status', { signal: AbortSignal.timeout(1000) }); ready = response.ok && (await response.json()).value?.ready === true; } catch { /* Startup socket is not listening yet; bounded deadline still applies. */ }
      if (ready) break;
      await delay(100);
    }
    if (!ready) throw new Error('Native WebDriver startup timeout; inspect ' + path.join(directory, 'app.log'));
    browser = await remote({ hostname: '127.0.0.1', port, path: '/', logLevel: 'error', outputDir: directory, connectionRetryCount: 0, connectionRetryTimeout: 20000, capabilities: { browserName: 'tauri', 'wdio:enforceWebDriverClassic': true, 'wdio:tauriServiceOptions': { windowLabel: 'main' } } });
    // A W3C handshake can precede Tauri injection and React mount; focus IPC requires both.
    await browser.waitUntil(() => browser.execute(() => typeof window.__TAURI_INTERNALS__?.invoke === 'function' && !!document.querySelector('h1')), { timeout: 15000, timeoutMsg: 'Owned native WebView did not finish Tauri injection and React mount' });
    // Only the acceptance config grants own-app visibility and own-window actions; hidden WKWebView must never be accepted by spoofing visibility.
    await activateOwnedWindow(browser);
    await browser.waitUntil(async () => {
      if (await browser.execute(() => document.visibilityState === 'visible' && document.hasFocus())) return true;
      await activateOwnedWindow(browser);
      return browser.execute(() => document.visibilityState === 'visible' && document.hasFocus());
    }, { timeout: 30000, interval: 200, timeoutMsg: 'Owned native window did not become genuinely visible and focused' });
    return { browser, directory, close };
  } catch (error) {
    if (browser) {
      try { await fs.writeFile(path.join(directory, 'native-window-failure.json'), JSON.stringify(await browser.execute(() => ({ hidden: document.hidden, visibility: document.visibilityState, focused: document.hasFocus(), title: document.title, viewport: { width: innerWidth, height: innerHeight }, native: !!window.__TAURI_INTERNALS__ })), null, 2)); await browser.saveScreenshot(path.join(directory, 'native-window-failure.png')); } catch { /* Preserve original failure even when the owned window already exited. */ }
    }
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Native session and cleanup failed'); }
    throw error;
  }
}
