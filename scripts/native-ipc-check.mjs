/** Real WKWebView-to-Rust read smoke; does not start or alter resident services. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNativeSession } from './native-support.mjs';

/** @type {string|undefined} Explicit prepared native-e2e executable; no installed fallback. */
const binary = process.env.AGENT_HUB_E2E_BINARY;
/** @type {string|undefined} Explicit app-owned connection fixture or reviewed read-only candidate configuration. */
const connections = process.env.AGENT_HUB_E2E_CONNECTIONS;
if (!binary || !connections) throw new Error('Set AGENT_HUB_E2E_BINARY and AGENT_HUB_E2E_CONNECTIONS');
/** @type {Awaited<ReturnType<typeof createNativeSession>>} Directly owned app and W3C session. */
const session = await createNativeSession({ binary, connections });
/** @type {Array<{resource:string,outcome:string,source:string,rows?:number,version?:string|null}>} Safe check metadata, excluding task bodies and credentials. */
const results = [];

/** Invokes one real closed native command through WKWebView's existing Tauri IPC.
 * @param {import('../src/live/protocol').Resource} resource Native read resource fixed by this test.
 * @param {Record<string, unknown>} [params] Product arguments; defaults to an empty object.
 * @returns {Promise<import('../src/live/protocol').ReadResponse['data']>} Original heterogeneous producer payload for explicit source assertions.
 */
async function read(resource, params = {}) {
  const value = await session.browser.execute((resource, params) => window.__TAURI_INTERNALS__.invoke('hub_read', { request: { resource, params } }), resource, params);
  assert.equal(value.schema_version, 1);
  assert.equal(value.resource, resource);
  assert.ok(['ok', 'partial'].includes(value.outcome), resource + ' failed: ' + value.error?.code);
  assert.equal(value.source, resource.split('.')[0]);
  results.push({ resource, source: value.source, outcome: value.outcome });
  return value.data;
}

try {
  await session.browser.waitUntil(() => session.browser.execute(() => !!document.querySelector('h1') && !!window.__TAURI_INTERNALS__), { timeout: 15000, timeoutMsg: 'Bundled WKWebView did not mount with native IPC' });
  const identity = await read('run.identity');
  assert.equal(identity.ping.ok, true);
  assert.ok(Array.isArray(identity.tools));
  assert.ok(identity.version === null || typeof identity.version === 'string');
  results.at(-1).version = identity.version;
  const agents = await read('run.agents', { limit: 200, offset: 0 });
  assert.ok(Array.isArray(agents.items));
  assert.equal(typeof agents.total, 'number');
  assert.equal(typeof agents.complete, 'boolean');
  results.at(-1).rows = agents.items.length;
  const treesIdentity = await read('worktree.identity');
  assert.equal(treesIdentity.kind, 'identity');
  assert.equal(treesIdentity.data.product, 'agent-worktree');
  const trees = await read('worktree.list', { limit: 20, discovery: false, size: false });
  assert.equal(trees.kind, 'worktree_page');
  assert.equal(trees.data.returned, trees.data.rows.length);
  assert.equal(typeof trees.data.has_more, 'boolean');
  assert.ok(trees.data.rows.every(row => typeof row.repo_common_dir === 'string'));
  results.at(-1).rows = trees.data.rows.length;
  const tasksIdentity = await read('tasks.identity');
  assert.equal(tasksIdentity.kind, 'product_identity');
  assert.equal(tasksIdentity.data.product, 'agent-tasks');
  const tasks = await read('tasks.peek', { repository: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') });
  assert.equal(tasks.kind, 'project_snapshot');
  assert.equal(tasks.data.error, null);
  assert.ok(['missing', 'saved'].includes(tasks.data.plan_state));
  assert.equal(typeof tasks.data.repository.common_dir, 'string');
  const denied = await session.browser.execute(() => window.__TAURI_INTERNALS__.invoke('hub_read', { request: { resource: 'run.start', params: {} } }).then(() => false, () => true));
  assert.equal(denied, true, 'Mutating resource must fail native enum deserialization');
  const unknownCommand = await session.browser.execute(() => window.__TAURI_INTERNALS__.invoke('plugin:shell|execute', { program: '/usr/bin/true' }).then(() => false, () => true));
  assert.equal(unknownCommand, true, 'Generic command execution must be absent');
  await session.browser.saveScreenshot(path.join(session.directory, 'native-ipc.png'));
} catch (error) {
  try { await session.browser.saveScreenshot(path.join(session.directory, 'failure.png')); } catch { /* The failure may already have closed the app; original error remains authoritative. */ }
  await fs.writeFile(path.join(session.directory, 'ipc-failure.json'), JSON.stringify({ checks: results, error: String(error) }, null, 2));
  throw error;
} finally {
  await session.close();
}
await fs.writeFile(path.join(session.directory, 'ipc-check.json'), JSON.stringify({ status: 'passed', checks: results, lastWindowExit: true }, null, 2));
console.log(JSON.stringify({ status: 'passed', directory: session.directory, checks: results.length, lastWindowExit: true }));
