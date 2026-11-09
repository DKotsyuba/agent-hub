/** Bounded real WKWebView/Rust acceptance. Only isolated source transports are synthetic; no invoke mock. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createNativeSession, activateOwnedWindow } from './native-support.mjs';
import { accessibility, geometry } from './browser-support.mjs';
import { createFixtures, helperReply, answerContent, digest, agentCount, sourceProse, runModels, runLimits } from './native-fixtures.mjs';
import { answerText, runPage, worktreePage, poolPage, poolDetail, legacyPoolDetail, bridgeData, ideData, modelsData, limitsData, tasksData, reportObserved, reportCompleted } from '../src/live/protocol.ts';

/** Every test-owned temporary path is under the approved project root. @type {string} */
const tempRoot = os.tmpdir();
Object.assign(process.env, { TMPDIR: tempRoot, TMP: tempRoot, TEMP: tempRoot });

/** Waits for one matching synthetic producer event, not a timed readiness sleep.
 * @param {import('node:events').EventEmitter} events Fixture controller. @param {string} event Event name.
 * @param {(row:object)=>boolean} predicate Selects the expected read. @returns {Promise<object>} Matching evidence; rejects after 12 seconds.
 */
function sourceEvent(events, event, predicate) {
  const pending = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { events.off(event, listener); reject(new Error('TIMEOUT_SOURCE fixture.' + event)); }, 12000);
    /** Resolves exactly the requested source event and removes both owned handles. @param {object} row Safe method evidence. @returns {void} */
    function listener(row) { if (predicate(row)) { clearTimeout(timeout); events.off(event, listener); resolve(row); } }
    events.on(event, listener);
  });
  pending.catch(() => {}); // A preceding UI failure may stop the caller before it awaits its already-bounded event.
  return pending;
}

/** Exercises generated fixture contracts offline, with real fake Unix/MCP/CLI framing and owned cleanup.
 * @returns {Promise<object>} Exact counts and artifact path. Does not launch Tauri or contact a real service.
 */
async function checkFixtures() {
  const fixture = await createFixtures();
  let closed;
  /** Runs one explicitly generated frontend and proves bounded framing plus process exit.
   * @param {string} source Owned wrapper namespace. @param {string[]} args Native-owned argv.
   * @param {object[]} input One observer request or MCP exchange, empty for IDE. @returns {Promise<object[]>} Parsed NDJSON source replies; rejects on timeout/nonzero exit.
   */
  async function helper(source, args, input) {
    const child = spawn(path.join(fixture.directory, source), args, { env: { PATH: process.env.PATH, TMPDIR: fixture.directory, TMP: fixture.directory, TEMP: fixture.directory }, stdio: ['pipe', 'pipe', 'pipe'] });
    const output = [], errors = [];
    child.stdout.on('data', bytes => output.push(bytes)); child.stderr.on('data', bytes => errors.push(bytes));
    const exit = once(child, 'close');
    child.stdin.end(input.map(row => JSON.stringify(row)).join('\n') + (input.length ? '\n' : ''));
    const deadline = setTimeout(() => child.kill('SIGKILL'), 5000);
    try { const [code] = await exit; assert.equal(code, 0, Buffer.concat(errors).toString()); }
    finally { clearTimeout(deadline); }
    return Buffer.concat(output).toString().trim().split('\n').map(line => JSON.parse(line));
  }
  try {
    const tree = worktreePage(helperReply('worktree', 'list_worktrees', { limit: 20, size: false }, fixture.directory));
    const second = worktreePage(helperReply('worktree', 'list_worktrees', { limit: 20, size: false, cursor: tree.next }, fixture.directory));
    assert.equal(tree.items.length + second.items.length, 23); assert.equal(second.complete, false);
    const pools = poolPage(helperReply('pool', 'list', {}, fixture.directory)); assert.equal(pools.next, 'standalone-1');
    assert.equal(poolDetail(helperReply('pool', 'get', { pool_id: 'standalone-1', section: 'decisions' }, fixture.directory)).cursor, '41');
    assert.throws(() => helperReply('tasks', 'plan', {}, fixture.directory), /Forbidden/);
    assert.throws(() => helperReply('pool', 'create', {}, fixture.directory), /Forbidden/);
    assert.throws(() => helperReply('worktree', 'list_worktrees', { limit: 20, size: true }, fixture.directory));
    const models = runModels(), limits = runLimits(); assert.equal(models.schema_version, 2); assert.equal(models.providers.length, 2);
    assert.equal(limits.items.length, 2); assert.equal(limits.items[1].known, false); assert.equal(limits.items[1].remaining_percent, null); assert.ok(limits.items[0].valid_until > Date.now() / 1000);
    const expired = runLimits(true, limits.items[0].observed_at); limitsData(expired); assert.equal(expired.items[0].known, false); assert.equal(expired.items[0].remaining_percent, null); assert.ok(expired.items[0].valid_until < Date.now() / 1000);
    modelsData(models); limitsData(limits); assert.equal(models.providers[0].models[0].quota.evidence, 'stale'); assert.equal(models.providers[1].models[0].quota.evidence, 'missing');
    bridgeData(helperReply('bridge', 'overview', {}, fixture.directory), 'bridge_overview');
    ideData(helperReply('ide', 'observe', { repository: fixture.repository }, fixture.directory));
    const tasks = tasksData(helperReply('tasks', 'peek', { repository: fixture.repository }, fixture.directory), fixture.common);
    assert.notEqual(tasks.plan.revision, tasks.report.plan.revision); assert.ok(reportObserved(tasks.report.observed_at)); assert.ok(reportCompleted(tasks.report.completed_at)); assert.equal(tasks.pending.state, 'accepted');
    /** Calls one private synthetic Unix RPC with a finite socket timeout. @param {string} method Allowlisted read. @param {object} params Arguments. @returns {Promise<object>} Original result. */
    async function rpc(method, params = {}) {
      const config = JSON.parse(await fs.readFile(fixture.connections, 'utf8'));
      const socket = net.createConnection(config.run.socket); socket.setTimeout(3000, () => socket.destroy(new Error('TIMEOUT_SOURCE fixture.rpc')));
      socket.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) + '\n');
      const chunks = []; let length = 0;
      for await (const bytes of socket) { length += bytes.length; assert.ok(length <= 1024 * 1024); chunks.push(bytes); }
      return JSON.parse(Buffer.concat(chunks).toString()).result;
    }
    const first = runPage(await rpc('list_agents', { offset: 0, limit: 200 }));
    const rest = runPage(await rpc('list_agents', { offset: first.next, limit: 200 }));
    assert.equal(first.items.length + rest.items.length, agentCount); assert.equal(rest.complete, true);
    const metadata = await rpc('answer', { agent_id: 'agent-000' });
    let chunks = 0;
    const content = await answerText(metadata, 'agent-000', 1, digest(answerContent()), true, async params => { chunks++; return rpc('answer_chunk', params); }, () => true);
    assert.equal(content, answerContent()); assert.ok(chunks > 8); assert.ok(metadata.size_bytes <= 16 * 1024 * 1024);
    legacyPoolDetail(await rpc('pool', { pool_id: 'legacy-1', after_seq: 0, limit: 50 }), 'legacy-1');
    const replies = await helper('tasks', ['--config', path.join(fixture.directory, 'producer.json'), 'mcp'], [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'synthetic-contract-check', version: '1' } } }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'peek', arguments: { repository: fixture.repository } } }]);
    tasksData(replies[1].result.structuredContent, fixture.common);
    const treesReply = await helper('worktree', ['mcp'], [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_worktrees', arguments: { limit: 20, size: false } } }]);
    worktreePage(treesReply[1].result.structuredContent);
    const poolReply = await helper('pool', ['observe', '--config', path.join(fixture.directory, 'producer.json')], [{ schema_version: 1, operation: 'list', params: {} }]); assert.equal(poolReply.length, 1); poolPage(poolReply[0]);
    const bridgeReply = await helper('bridge', ['observe', '--config', path.join(fixture.directory, 'producer.json')], [{ schema_version: 1, operation: 'overview', params: {} }]); assert.equal(bridgeReply.length, 1); bridgeData(bridgeReply[0], 'bridge_overview');
    const doctor = await helper('ide', ['doctor', '--read-only'], []); assert.equal(doctor[0].read_only, true);
    const ide = await helper('ide', ['observe', '--repo', fixture.repository, '--json'], []); ideData(ide[0]);
    await fixture.restart({ version: 'SYNTHETIC offline restart', revision: 2, messageRevision: 2 }); assert.equal((await rpc('capabilities')).version, 'SYNTHETIC offline restart');
    closed = await fixture.close();
    const report = { status: 'passed', mode: 'offline-fixture-contracts', agents: agentCount, trees: 23, modelProviders: 2, quotaWindows: 2, answerBytes: metadata.size_bytes, answerChunks: chunks, cleanup: closed, nativeUI: 'NOT RUN: requires explicit current-frontend embedding clearance' };
    await fs.writeFile(path.join(fixture.directory, 'fixture-check.json'), JSON.stringify(report, null, 2));
    return { ...report, directory: fixture.directory };
  } finally { if (!closed) await fixture.close(); }
}

/** Runs actual native UI navigation and source contracts, collecting failure evidence without zero-test success.
 * @param {string} binary Explicit root-prepared native-e2e binary. @returns {Promise<object>} Compact report; throws after report preservation if any assertion/cleanup failed.
 */
async function checkNative(binary) {
  assert.ok(path.isAbsolute(binary), 'Explicit absolute native-e2e executable required');
  const binarySha256 = digest(await fs.readFile(binary));
  if (process.env.AGENT_HUB_E2E_EXPECTED_SHA256) assert.equal(binarySha256, process.env.AGENT_HUB_E2E_EXPECTED_SHA256, 'Native binary differs from the root-cleared immutable executable');
  const fixture = await createFixtures();
  const keyboardOnly = process.argv.includes('--keyboard-only');
  const report = { mode: keyboardOnly ? 'targeted-native-keyboard' : 'full-native-acceptance', status: 'running', binary, binarySha256, fixture: fixture.directory, runtime: null, visibilityEvents: [], navigation: [], clipboard: 'Recording browser sink only; original method restored. OS clipboard NOT accessed or qualified.', checks: [], viewports: [], accessibility: [], presentation: [], screenshots: [], errors: [], timeoutSource: null, lastWindowExit: false, cleanup: null, methodCounts: {} };
  let session, browser, stage = 'native-session', originalClipboard = false, requestedViewport = null;
  /** Reads visible text only; collapsed producer JSON is not accepted as visible UI evidence. @returns {Promise<string>} Current rendered main body text. */
  async function body() { return browser.$('body').getText(); }
  /** Re-activates only this owned app after the controller occludes it; never changes visibility APIs.
   * @returns {Promise<void>} Fixed native foreground requests, if needed; the surrounding assertion still observes real DOM state.
   */
  async function ensureVisible() {
    if (!await browser.execute(() => !document.hidden && document.hasFocus())) {
      await activateOwnedWindow(browser);
      await browser.waitUntil(() => browser.execute(() => !document.hidden && document.hasFocus()), { timeout: 5000, interval: 100, timeoutMsg: 'Owned native window remained occluded after real foreground activation' });
      report.foregroundRecoveries = (report.foregroundRecoveries ?? 0) + 1;
    }
  }
  /** Waits for a specific DOM condition with a bounded state assertion, without arbitrary retrying actions.
   * @param {()=>Promise<boolean>} predicate Current observed state. @param {string} label Failure context. @returns {Promise<void>} Resolves only on the required state.
   */
  async function until(predicate, label) { await browser.waitUntil(async () => { await ensureVisible(); return predicate(); }, { timeout: 15000, interval: 100, timeoutMsg: 'TIMEOUT_SOURCE ' + label }); }
  /** Uses native window resizing and measured chrome deltas to establish an exact CSS content viewport.
   * @param {number} width Required CSS content width in pixels. @param {number} height Required CSS content height in pixels.
   * @returns {Promise<void>} Rejects if macOS/window constraints prevent the exact observed content size; never uses CDP emulation.
   */
  async function setNativeViewport(width, height) {
    const outer = await browser.getWindowSize();
    const inner = await browser.execute(() => ({ width: innerWidth, height: innerHeight }));
    await browser.setWindowSize(width + Math.max(0, outer.width - inner.width), height + Math.max(0, outer.height - inner.height));
    await until(() => browser.execute((width, height) => innerWidth === width && innerHeight === height, width, height), 'native.css-viewport.' + width + 'x' + height);
    requestedViewport = { width, height };
  }
  /** Clicks an existing user-facing button by exact rendered text.
   * @param {string} text Exact authored English text. @returns {Promise<void>} Click completion; rejects if missing or noninteractive.
   */
  async function button(text) { await ensureVisible(); await browser.$('//button[normalize-space()="' + text + '"]').click(); }
  /** Uses the real sidebar and waits for actual route state. @param {string} section Stable shell section. @returns {Promise<void>} Current sidebar route established. */
  async function navigate(section) { await ensureVisible(); await browser.$('nav a[href="#' + section + '"]').click(); await until(async () => (await browser.$('nav a[href="#' + section + '"]').getAttribute('aria-current')) === 'page' && !(await browser.$('.detail-screen').isExisting()), 'navigation.' + section); report.navigation.push({ section, ...await browser.execute(() => ({ at: Date.now(), visibilityState: document.visibilityState, hidden: document.hidden, hasFocus: document.hasFocus() })) }); }
  /** Returns the stable semantic record button for a real producer identity. @param {string} key data-focus-key. @returns {Promise<import('webdriverio').Element>} Existing record. */
  async function record(key) { return browser.$('[data-focus-key="' + key + '"]'); }
  /** Selects a Radix option through its actual trigger and keyboard-accessible listbox.
   * @param {string} label Trigger accessible label. @param {string} choice Exact source/translated option. @returns {Promise<void>} Closed listbox after selection.
   */
  async function choose(label, choice) { await ensureVisible(); await browser.$('[role="combobox"][aria-label="' + label + '"]').click(); await browser.$('//*[@role="option" and normalize-space()="' + choice + '"]').click(); await until(async () => !(await browser.$('[role="listbox"]').isExisting()), 'select.' + label); }
  /** Requires settings content/overlay to unmount and body pointer actions to recover after dismissal.
   * Closed data-state or zero opacity alone never qualifies a retained, potentially blocking native portal.
   * @returns {Promise<boolean>} True only when no settings dialog/overlay remains, body pointer actions recover, and the real settings trigger wins its center hit-test.
   */
  async function settingsDismissed() { const state = await dismissalEvidence(); return state.portals.length === 0 && state.bodyPointerEvents !== 'none' && state.triggerActionable; }
  /** Changes appearance or locale through actual settings, never by editing React/localStorage state.
   * @param {{theme?:string,locale?:string}} options Theme button or visible language choice. @returns {Promise<void>} Dialog closed through its real Done action; trusted Escape is qualified separately.
   */
  async function settings({ theme, locale }) {
    await ensureVisible();
    await browser.$('.settings-button').click(); await browser.$('[role="dialog"]').waitForDisplayed();
    if (locale) await choose(await browser.$('[role="dialog"] [role="combobox"]').getAttribute('aria-label'), locale);
    if (theme) await button(theme);
    const closing = Date.now();
    await browser.$('.settings-actions button[aria-label]').click(); await until(settingsDismissed, 'settings.closed');
    const durationMs = Date.now() - closing; (report.settingsClosures ??= []).push({ theme, locale, durationMs });
    assert.ok(durationMs < 5000, 'Settings Done must fully dismiss its native portal promptly');
  }
  /** Reads the private operator stop sentinel after an input interruption; it never changes application state.
   * @returns {Promise<boolean>} True when this session's native-input-stop file exists; false only for absence, other I/O errors reject.
   */
  async function inputInterrupted() { try { await fs.access(path.join(session.directory, 'native-input-stop')); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
  /** Lets the controller bind/activate this already-owned app before Node establishes the next DOM focus barrier.
   * @param {string} label Trusted test phase; not an application command.
   * @returns {Promise<void>} Resolves on a matching private acknowledgement, restores this owned app once if the controller occluded it, and verifies genuine focus before the DOM barrier; rejects after 60 seconds.
   */
  async function controllerReady(label) {
    const id = label + '-' + Date.now(), acknowledgement = path.join(session.directory, 'controller-' + id + '.ack');
    const request = { event: 'native-controller-ready', label, id, acknowledgement, session: session.directory };
    await fs.writeFile(path.join(session.directory, 'native-controller-ready.json'), JSON.stringify(request, null, 2)); console.log(JSON.stringify(request));
    await browser.waitUntil(async () => { if (await inputInterrupted()) return true; try { return await fs.readFile(acknowledgement, 'utf8') === 'ready'; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }, { timeout: 60000, interval: 100, timeoutMsg: 'TIMEOUT_SOURCE controller-ready.' + label });
    if (await inputInterrupted()) throw Object.assign(new Error('Native controller stopped after an input interruption'), { code: 'NATIVE_INPUT_INTERRUPTED' });
    await ensureVisible();
    assert.equal(await browser.execute(() => !document.hidden && document.hasFocus()), true, 'Controller must establish genuine owned-window focus before the DOM barrier');
  }
  /** Captures complete settings dismissal evidence without changing focus, animation or application state.
   * @returns {Promise<{bodyPointerEvents:string,triggerActionable:boolean,portals:{role:string|null,state:string|null,opacity:string,pointerEvents:string,display:string,visibility:string}[]}>} Current body actionability and all dialog/overlay styles, including closed retained nodes.
   */
  async function dismissalEvidence() {
    return browser.execute(() => {
      const trigger = document.querySelector('.settings-button'), rect = trigger?.getBoundingClientRect();
      const hit = rect && document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return { bodyPointerEvents: getComputedStyle(document.body).pointerEvents, triggerActionable: !!(trigger && hit && trigger.contains(hit)), portals: [...document.querySelectorAll('[role="dialog"],.fixed.inset-0[data-state]')].map(element => ({ role: element.getAttribute('role'), state: element.getAttribute('data-state'), opacity: getComputedStyle(element).opacity, pointerEvents: getComputedStyle(element).pointerEvents, display: getComputedStyle(element).display, visibility: getComputedStyle(element).visibility })) };
    });
  }
  /** Awaits a genuine key sent by the controller to this owned app after confirming current DOM focus.
   * The optional WDIO driver dispatches untrusted KeyboardEvents and cannot exercise native button defaults.
   * @param {'Enter'|'Escape'|'PageDown'|'ArrowDown'} key Expected trusted browser key. @param {string} label Stable evidence label.
   * @param {()=>Promise<boolean>} predicate Real navigation/dialog result required after the key.
   * @returns {Promise<void>} Records expected/actual targets, exact key/code/modifiers/trust and scroll before any recovery; rejects after 60 seconds and never substitutes click/default activation.
   */
  async function trustedKey(key, label, predicate) {
    if (keyboardOnly) assert.equal(await browser.execute(() => !document.hidden && document.hasFocus()), true, 'Owned app must stay genuinely focused after the DOM barrier');
    else await ensureVisible();
    const before = await browser.execute(key => {
      window.__nativeTrustedKeys = [];
      const expected = document.activeElement;
      window.__nativeTrustedListener = event => {
        const region = document.querySelector('pre.source-text[role="region"]');
        window.__nativeTrustedKeys.push({ type: event.type, key: event.key, code: event.code, trusted: event.isTrusted, at: Date.now(), modifiers: { alt: event.altKey, control: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey }, defaultPrevented: event.defaultPrevented, expectedTarget: event.target === expected, target: { tag: event.target?.tagName, focusKey: event.target?.getAttribute?.('data-focus-key'), role: event.target?.getAttribute?.('role'), label: event.target?.getAttribute?.('aria-label') }, focus: event.target?.getAttribute?.('data-focus-key') ?? event.target?.tagName, activeTag: document.activeElement?.tagName, hidden: document.hidden, hasFocus: document.hasFocus(), windowScroll: scrollY, resultScroll: region?.scrollTop ?? null });
      };
      document.addEventListener('keydown', window.__nativeTrustedListener, true); document.addEventListener('keyup', window.__nativeTrustedListener, true);
      return { hash: location.hash, focus: document.activeElement?.getAttribute('data-focus-key'), tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute('aria-label'), hidden: document.hidden, hasFocus: document.hasFocus(), windowScroll: scrollY, resultScroll: document.querySelector('pre.source-text')?.scrollTop };
    }, key);
    const request = { event: 'native-key-required', key, label, before, session: session.directory };
    await fs.writeFile(path.join(session.directory, 'native-key-request.json'), JSON.stringify(request, null, 2)); console.log(JSON.stringify(request));
    try { await browser.waitUntil(async () => await inputInterrupted() || predicate(), { timeout: 60000, interval: 100, timeoutMsg: 'TIMEOUT_SOURCE trusted-key.' + label }); }
    finally {
      const after = await browser.execute(() => { document.removeEventListener('keydown', window.__nativeTrustedListener, true); document.removeEventListener('keyup', window.__nativeTrustedListener, true); return { hash: location.hash, focus: document.activeElement?.getAttribute('data-focus-key'), tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute('aria-label'), hidden: document.hidden, hasFocus: document.hasFocus(), windowScroll: scrollY, resultScroll: document.querySelector('pre.source-text')?.scrollTop, events: window.__nativeTrustedKeys }; });
      (report.trustedKeys ??= []).push({ key, label, before, after, dismissal: await dismissalEvidence() });
    }
    if (await inputInterrupted()) throw Object.assign(new Error('Native controller stopped after an input interruption'), { code: 'NATIVE_INPUT_INTERRUPTED' });
    const keydown = report.trustedKeys.at(-1).after.events.find(event => event.trusted && event.type === 'keydown' && event.key === key);
    assert.ok(keydown, 'Real native keydown required for ' + label);
    assert.equal(keydown.hidden, false, 'Genuine keydown must reach a visible native document'); assert.equal(keydown.hasFocus, true, 'Genuine keydown must reach the focused native document');
    assert.equal(keydown.expectedTarget, true, 'Trusted key must reach the exact DOM target established before input');
    if (key === 'Escape') assert.ok(Date.now() - keydown.at < 5000, 'Trusted Escape must fully dismiss its native portal promptly');
  }
  /** Reads genuinely exposed technical JSON, excluding descendants of closed native disclosures.
   * WKWebView can return rectangles for closed-details descendants; all ancestor disclosure states remain authoritative.
   * @returns {Promise<string[]>} At most 100 characters per visible metadata pre, preserving JSON detection outside disclosures.
   */
  async function exposedMetadata() {
    return browser.execute(() => [...document.querySelectorAll('pre:not(.source-text)')].filter(element => !element.closest('details:not([open])') && element.getClientRects().length && /^[\[{]/.test(element.textContent?.trim() ?? '')).map(element => element.textContent?.slice(0, 100)));
  }
  /** Captures a real native viewport, layout, screenshot and axe A/AA; violations always fail the check.
   * @param {string} name Trusted evidence filename prefix. @returns {Promise<void>} Asserts no document/source-text overflow or axe violations.
   */
  async function inspect(name) {
    await until(() => browser.execute(() => !document.hidden && document.hasFocus()), 'native.visual-visibility');
    const shape = await geometry(browser);
    const violations = await accessibility(browser);
    const presentation = await browser.execute(() => ({
      labels: [...document.querySelectorAll('.agent-name strong,.object-row strong,.project-row strong,.detail-heading h1')].filter(element => element.getClientRects().length).map(element => element.textContent?.trim()),
      footers: [...document.querySelectorAll('footer')].map(element => ({ className: element.className, text: element.innerText })),
      modeIndicators: [...document.querySelectorAll('.demo-label,.compact-demo,.page-heading .eyebrow')].map(element => ({ className: element.className, text: element.textContent?.trim() ?? '', visible: element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden' })),
    }));
    presentation.exposedMetadata = await exposedMetadata();
    report.viewports.push({ name, requestedCSS: requestedViewport, outer: await browser.getWindowSize(), innerWidth: shape.width, innerHeight: shape.height, documentWidth: shape.documentWidth });
    report.accessibility.push({ name, violations });
    report.presentation.push({ name, ...presentation });
    const screenshot = path.join(session.directory, name + '.png'); await browser.saveScreenshot(screenshot); report.screenshots.push(screenshot);
    assert.ok(shape.width > 0 && shape.height > 0); assert.ok(shape.documentWidth <= shape.width + 1, name + ' document overflow');
    const overflow = await browser.execute(() => [...document.querySelectorAll('pre.source-text')].filter(element => element.getClientRects().length && element.scrollWidth > element.clientWidth + 1).map(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth })));
    assert.deepEqual(overflow, [], name + ' long source text overflow'); assert.deepEqual(violations, [], name + ' axe A/AA');
    assert.equal(await browser.execute(() => window.__nativeFixtureExecuted === true), false, 'Source markup must never execute');
    assert.equal(await browser.$('img[src="x"]').isExisting(), false, 'HTML-like source prose must stay text, even when CSP would block execution');
    assert.deepEqual(presentation.labels.filter(label => /^\/(?:Users|Volumes|private)\//.test(label ?? '')), [], name + ' primary labels must be useful names, with paths retained as provenance');
    assert.deepEqual(presentation.exposedMetadata, [], name + ' raw technical JSON must remain folded');
    assert.ok(presentation.modeIndicators.some(indicator => indicator.visible && indicator.text.includes('Live read-only data')), name + ' visible mode indicator must identify live read-only mode');
    assert.ok(presentation.modeIndicators.every(indicator => !/Demo data|Synthetic data · read only/.test(indicator.text)), name + ' mode indicators must not claim demo mode');
  }
  /** Runs one bounded scenario, preserving screenshots for failures while independent scenarios continue.
   * Restores English and closes any settings portal through actual UI, then resets query/status/scope with Reset filters; Back retention inside the scenario remains unchanged.
   * @param {string} name Evidence label. @param {()=>Promise<void>} action Scenario with explicit assertions. @returns {Promise<void>} Records pass/failure; final gate rejects any failure.
   */
  async function check(name, action) {
    stage = name; const started = Date.now();
    try {
      await ensureVisible();
      if (await browser.execute(() => !!document.querySelector('[role="dialog"]'))) { await browser.$('.settings-actions button[aria-label]').click(); await until(settingsDismissed, 'scenario.dialog-reset'); }
      if (await browser.execute(() => document.documentElement.lang !== 'en')) await settings({ locale: 'English' });
      await navigate('agents');
      if (await browser.$('//button[normalize-space()="Reset filters"]').isExisting()) await button('Reset filters');
      await action(); report.checks.push({ name, status: 'passed', durationMs: Date.now() - started }); }
    catch (error) { report.checks.push({ name, status: 'failed', durationMs: Date.now() - started }); const visibility = await browser.execute(() => ({ at: Date.now(), visibilityState: document.visibilityState, hidden: document.hidden, hasFocus: document.hasFocus() })).catch(() => null); report.errors.push({ stage, message: String(error), stack: error.stack, visibility, dismissal: await dismissalEvidence().catch(() => null) }); if (error.code === 'NATIVE_INPUT_INTERRUPTED') report.inputInterrupted = true; console.error(JSON.stringify({ event: 'assertion-failed', stage, error: String(error).slice(0, 1200), visibility })); if (String(error).includes('TIMEOUT_SOURCE')) report.timeoutSource = String(error).match(/TIMEOUT_SOURCE ([^\n]+)/)?.[1] ?? name; try { const screenshot = path.join(session.directory, 'failure-' + name + '.png'); await browser.saveScreenshot(screenshot); report.screenshots.push(screenshot); } catch { /* App exit can make screenshot unavailable; original failure remains in report. */ } }
    await fs.writeFile(path.join(session.directory, 'native-ui-progress.json'), JSON.stringify(report, null, 2));
    if (report.inputInterrupted) throw Object.assign(new Error('Native input interrupted; remaining scenarios were not run'), { code: 'NATIVE_INPUT_INTERRUPTED' });
  }
  try {
    session = await createNativeSession({ binary, connections: fixture.connections }); browser = session.browser;
    console.log(JSON.stringify({ event: 'native-ui-start', session: session.directory, fixtures: fixture.directory, binary }));
    await until(() => browser.execute(() => !!window.__TAURI_INTERNALS__ && !!document.querySelector('h1')), 'native.mount');
    await setNativeViewport(1440, 900);
    report.runtime = await browser.execute(() => ({ visibilityState: document.visibilityState, hidden: document.hidden, hasFocus: document.hasFocus(), secureContext: isSecureContext, innerWidth, innerHeight }));
    assert.equal(report.runtime.visibilityState, 'visible'); assert.equal(report.runtime.hidden, false); assert.equal(report.runtime.hasFocus, true);
    await browser.execute(() => { window.__nativeAcceptanceVisibility = []; for (const type of ['visibilitychange', 'focus', 'blur']) window.addEventListener(type, () => window.__nativeAcceptanceVisibility.push({ type, at: Date.now(), hidden: document.hidden, hasFocus: document.hasFocus() })); });
    const configuration = await browser.execute(() => window.__TAURI_INTERNALS__.invoke('hub_connections'));
    assert.equal(configuration.state, 'configured', 'Native fixture connections must validate before UI assertions: ' + configuration.error?.code);
    await settings({ locale: 'English', theme: 'Light' });
    if (keyboardOnly) {
      await check('targeted-result-scroll-and-dismissal', async () => {
        await until(async () => (await record('agents:run:agent-000')).isExisting(), 'targeted.agent-ready');
        await (await record('agents:run:agent-000')).click(); await button('Result');
        await until(() => browser.execute(() => document.querySelector('pre.source-text[role="region"]')?.textContent).then(value => value === answerContent(1)), 'targeted.full-answer');
        report.targetedAnswerBytes = Buffer.byteLength(answerContent(1));
        report.largeResultLayout = await browser.execute(() => { const region = document.querySelector('pre.source-text[role="region"]'); return { documentHeight: document.documentElement.scrollHeight, viewportHeight: innerHeight, regionHeight: region.clientHeight, internalHeight: region.scrollHeight, horizontalWidth: region.scrollWidth, clientWidth: region.clientWidth, tabIndex: region.tabIndex, label: region.getAttribute('aria-label') }; });
        assert.ok(report.largeResultLayout.documentHeight < report.largeResultLayout.viewportHeight * 3); assert.ok(report.largeResultLayout.internalHeight > report.largeResultLayout.regionHeight * 100); assert.equal(report.largeResultLayout.horizontalWidth, report.largeResultLayout.clientWidth);
        await controllerReady('result-arrow-scroll');
        await browser.execute(() => document.querySelector('pre.source-text[role="region"]').focus());
        assert.equal(await browser.execute(() => document.activeElement === document.querySelector('pre.source-text[role="region"]')), true);
        const before = await browser.execute(() => ({ outer: scrollY, inner: document.querySelector('pre.source-text[role="region"]').scrollTop }));
        await trustedKey('ArrowDown', 'targeted-result-arrow-scroll', () => browser.execute(previous => document.querySelector('pre.source-text[role="region"]').scrollTop > previous, before.inner));
        report.targetedResultScroll = { before, after: await browser.execute(() => ({ outer: scrollY, inner: document.querySelector('pre.source-text[role="region"]').scrollTop })) };
        assert.equal(report.targetedResultScroll.after.outer, before.outer, 'Trusted ArrowDown must scroll the focused result rather than the document');
        await browser.execute(() => { const region = document.querySelector('pre.source-text[role="region"]'); region.scrollTop = region.scrollHeight; });
        await until(() => browser.execute(() => { const region = document.querySelector('pre.source-text[role="region"]'); return region.scrollTop + region.clientHeight >= region.scrollHeight - 2; }), 'targeted.internal-bottom');
        assert.deepEqual(await exposedMetadata(), []);
        const disclosure = await browser.$('//pre[not(contains(@class,"source-text"))]/ancestor::details[1]/summary');
        await disclosure.click(); assert.ok((await exposedMetadata()).length > 0); await disclosure.click(); assert.deepEqual(await exposedMetadata(), []); report.metadataDetectorPositiveControl = true;
        await settings({ locale: 'Русский' }); assert.equal(await browser.execute(() => document.querySelector('pre.source-text[role="region"]')?.textContent), answerContent(1)); await settings({ locale: 'English' });
        await browser.$('.settings-button').click(); await browser.$('[role="dialog"]').waitForDisplayed();
        await controllerReady('large-result-settings-escape');
        await browser.execute(() => document.querySelector('.settings-actions button[aria-label]').focus());
        assert.equal(await browser.execute(() => document.activeElement === document.querySelector('.settings-actions button[aria-label]')), true);
        await trustedKey('Escape', 'targeted-large-result-settings-escape', settingsDismissed);
        assert.equal(await settingsDismissed(), true); report.largeResultDismissal = await dismissalEvidence();
        await button('Back');
      });
      await check('targeted-later-list-return', async () => {
        await until(async () => (await record('agents:run:agent-000')).isExisting(), 'targeted.return-agent');
        await controllerReady('later-list-return');
        await browser.execute(() => document.querySelector('[data-focus-key="agents:run:agent-000"]').focus());
        assert.equal(await browser.execute(() => document.activeElement?.getAttribute('data-focus-key')), 'agents:run:agent-000');
        await trustedKey('Enter', 'targeted-later-list-return', () => browser.execute(() => !!document.querySelector('.detail-screen')));
        assert.equal(await browser.execute(() => document.activeElement === document.querySelector('.detail-screen h1')), true); await button('Back');
      });
      await check('targeted-enlarged-settings-escape', async () => {
        await setNativeViewport(1100, 720); await settings({ theme: 'Light' }); await browser.execute(() => { document.documentElement.style.fontSize = '200%'; });
        try {
          await browser.$('.settings-button').click(); await browser.$('[role="dialog"]').waitForDisplayed();
          await controllerReady('enlarged-settings-escape');
          await browser.execute(() => document.querySelector('.settings-actions button[aria-label]').focus());
          assert.equal(await browser.execute(() => document.activeElement === document.querySelector('.settings-actions button[aria-label]')), true);
          await trustedKey('Escape', 'targeted-enlarged-settings-escape', settingsDismissed);
          assert.equal(await settingsDismissed(), true); report.enlargedDismissal = await dismissalEvidence();
        } finally { await browser.execute(() => { document.documentElement.style.fontSize = ''; }); }
      });
    } else {
    await check('live-pagination-watch-navigation', async () => {
      assert.match(await body(), /Live read-only data/); assert.doesNotMatch(await body(), /Demo data|Synthetic data · read only|Native connection required/);
      await navigate('agents'); await until(async () => (await browser.$$('.agent-row')).length === 200, 'run.first-page');
      assert.match(await body(), /Loaded 200 of 237 records/); await button('Load more');
      await until(async () => (await browser.$$('.agent-row')).length === agentCount, 'run.all-pages');
      const ids = await browser.execute(() => [...document.querySelectorAll('.agent-name')].map(element => element.dataset.focusKey)); assert.equal(new Set(ids).size, agentCount);
      await until(async () => (await fixture.logs()).some(row => row.method === 'list_agents' && row.after_revision === 1 && row.after_message_revision === 1), 'run.dual-revision-watch');
      fixture.set({ revision: 2, messageRevision: 2 });
      await until(async () => (await fixture.logs()).some(row => row.method === 'list_agents' && row.after_revision === 2), 'run.first-page-watch');
      assert.equal((await browser.$$('.agent-row')).length, agentCount); assert.equal(await (await record('agents:run:agent-000')).isExisting(), true); assert.equal(await (await record('agents:run:agent-236')).isExisting(), true);
      await browser.$('input[data-focus-key="search"]').setValue('SYNTHETIC task 000'); await choose('Agent status', 'Running');
      await until(async () => (await browser.$$('.agent-row')).length === 1, 'run.filter');
      await browser.execute(() => {
        /** Snapshots the actual route, render and selection state around one driver click. @returns {object} Non-secret synthetic navigation evidence. */
        const snapshot = () => ({ at: Date.now(), hash: location.hash, history: history.state, renderKey: document.getElementById('main-content')?.dataset.screenKey, detail: !!document.querySelector('.detail-screen'), focus: document.activeElement?.outerHTML.slice(0, 300), selection: { isCollapsed: getSelection()?.isCollapsed, text: getSelection()?.toString().slice(0, 200), anchor: getSelection()?.anchorNode?.textContent?.slice(0, 100), focus: getSelection()?.focusNode?.textContent?.slice(0, 100) } });
        window.__nativeRowTrace = { before: snapshot(), events: [] };
        /** Appends a bounded event snapshot without modifying navigation or event propagation. @param {Event} event Real browser event. @returns {void} */
        const listener = event => window.__nativeRowTrace.events.push({ type: event.type, target: event.target?.outerHTML?.slice(0, 300), message: event.message, ...snapshot() });
        for (const type of ['click', 'error', 'unhandledrejection', 'hashchange', 'popstate']) window.addEventListener(type, listener);
        window.__nativeRowTraceStop = () => { window.__nativeRowTrace.after = snapshot(); for (const type of ['click', 'error', 'unhandledrejection', 'hashchange', 'popstate']) window.removeEventListener(type, listener); return window.__nativeRowTrace; };
      });
      try { await browser.$('.agent-row td:nth-child(2)').click(); await browser.$('.detail-screen').waitForDisplayed(); }
      finally { report.rowClick = await browser.execute(() => window.__nativeRowTraceStop()); }
      await browser.$('.detail-screen').waitForDisplayed(); assert.equal(await browser.$('[role="dialog"]').isExisting(), false);
      assert.match(await browser.$('.detail-screen h1').getText(), /SYNTHETIC task 000/); assert.equal(await browser.execute(() => document.activeElement === document.querySelector('.detail-screen h1')), true);
      await until(async () => (await body()).includes('SYNTHETIC tail history agent-000'), 'run.history-tail'); await button('Load older messages');
      await until(async () => (await body()).includes('SYNTHETIC older history agent-000'), 'run.history-older'); assert.ok((await body()).includes(sourceProse));
      await browser.back(); await until(async () => !(await browser.$('.detail-screen').isExisting()), 'native.back');
      assert.equal(await browser.$('input[data-focus-key="search"]').getValue(), 'SYNTHETIC task 000'); assert.equal(await browser.$('[aria-label="Agent status"]').getText(), 'Running');
      assert.equal(await browser.execute(() => document.activeElement?.getAttribute('data-focus-key')), 'agents:run:agent-000');
      await trustedKey('Enter', 'retained-row-enter', async () => await browser.$('.detail-screen').isExisting()); await browser.$('.detail-screen').waitForDisplayed(); await button('Back');
      await browser.$('input[data-focus-key="search"]').setValue(''); await choose('Agent status', 'All statuses');
    });
    await check('large-answer-copy-and-resume-fence', async () => {
      await navigate('agents'); await (await record('agents:run:agent-000')).click(); await button('Result');
      await until(async () => (await browser.$$('.source-text')).length > 0 && (await browser.$('pre.source-text').getText()).startsWith('SYNTHETIC RESULT sequence=1'), 'run.answer-chunks');
      const displayed = await browser.execute(() => document.querySelector('pre.source-text')?.textContent); assert.equal(displayed, answerContent(1));
      const installed = await browser.execute(() => { const target = navigator.clipboard; if (!target) return false; window.__nativeClipboardOriginal = Object.getOwnPropertyDescriptor(target, 'writeText'); Object.defineProperty(target, 'writeText', { configurable: true, value: async text => { window.__nativeClipboardRecording = text; } }); return true; });
      assert.equal(installed, true, 'Recording clipboard sink must be installed without calling the system clipboard'); originalClipboard = true;
      await button('Copy result'); assert.equal(await browser.execute(() => window.__nativeClipboardRecording), answerContent(1));
      assert.ok((await fixture.logs()).filter(row => row.method === 'answer_chunk').length > 8);
      const held = sourceEvent(fixture.events, 'held', row => row.method === 'answer_chunk' && row.agent === 'agent-000');
      const release = fixture.hold('answer_chunk', 'agent-000');
      try {
        await browser.$('[aria-label="Refresh observations"]').click(); await held;
        const resumed = sourceEvent(fixture.events, 'held', row => row.method === 'answer_chunk' && row.agent === 'agent-000' && row.sequence === 2);
        fixture.set({ sequence: 2, revision: 3, messageRevision: 3 }); await resumed;
        assert.equal(await browser.$('pre.source-text').isExisting(), false, 'Prior execution answer must disappear while replacement proof is pending');
        release();
        await until(async () => (await browser.execute(() => document.querySelector('pre.source-text')?.textContent)) === answerContent(2), 'run.resume-proof');
        assert.doesNotMatch(await browser.$('pre.source-text').getText(), /sequence=1/);
        await button('Copy result'); assert.equal(await browser.execute(() => window.__nativeClipboardRecording), answerContent(2));
      } finally { release(); }
      report.largeResultLayout = await browser.execute(() => {
        const region = document.querySelector('pre.source-text');
        return { documentHeight: document.documentElement.scrollHeight, viewportHeight: innerHeight, regionHeight: region.clientHeight, internalHeight: region.scrollHeight, horizontalWidth: region.scrollWidth, clientWidth: region.clientWidth, tabIndex: region.tabIndex, label: region.getAttribute('aria-label') };
      });
      assert.ok(report.largeResultLayout.regionHeight > 0 && report.largeResultLayout.regionHeight <= report.largeResultLayout.viewportHeight, 'Full result region must fit the native viewport');
      assert.ok(report.largeResultLayout.documentHeight < report.largeResultLayout.viewportHeight * 3, 'Large answer must not create a giant outer native document');
      assert.ok(report.largeResultLayout.internalHeight > report.largeResultLayout.regionHeight * 100, 'The untruncated large answer must scroll inside its bounded region');
      assert.equal(report.largeResultLayout.tabIndex, 0, 'Scrollable result must be keyboard focusable'); assert.ok(report.largeResultLayout.label, 'Scrollable result must retain an accessible name');
      await browser.$('pre.source-text').click();
      assert.equal(await browser.execute(() => document.activeElement === document.querySelector('pre.source-text')), true, 'Result must own real DOM focus before native PageDown');
      const beforeScroll = await browser.execute(() => ({ outer: scrollY, inner: document.querySelector('pre.source-text').scrollTop }));
      await trustedKey('PageDown', 'large-result-internal-scroll', () => browser.execute(before => document.querySelector('pre.source-text').scrollTop > before, beforeScroll.inner));
      assert.equal(await browser.execute(() => scrollY), beforeScroll.outer, 'Native PageDown must scroll the focused result rather than the outer document');
      await browser.execute(() => { const region = document.querySelector('pre.source-text'); region.scrollTop = region.scrollHeight; });
      await until(() => browser.execute(() => { const region = document.querySelector('pre.source-text'); return region.scrollTop + region.clientHeight >= region.scrollHeight - 2; }), 'result.internal-bottom');
      assert.deepEqual(await exposedMetadata(), [], 'Metadata must initially be folded');
      const disclosure = await browser.$('//pre[not(contains(@class,"source-text"))]/ancestor::details[1]/summary');
      await disclosure.click(); assert.ok((await exposedMetadata()).length > 0, 'Metadata visibility detector must detect an actual opened disclosure');
      await disclosure.click(); assert.deepEqual(await exposedMetadata(), [], 'Closing disclosure must restore folded metadata');
      report.metadataDetectorPositiveControl = true;
      // The disclosure click scrolls to the end of the untruncated result; restore a normal reading position for visual evidence and the next independent settings interaction.
      report.largeResultDisclosureScroll = await browser.execute(() => ({ scrollY, documentHeight: document.documentElement.scrollHeight }));
      await browser.execute(() => window.scrollTo(0, 0)); await until(() => browser.execute(() => scrollY === 0), 'result.reading-position');
      await inspect('large-result-internal-bottom');
      await settings({ locale: 'Русский' }); assert.equal(await browser.execute(() => document.querySelector('pre.source-text')?.textContent), answerContent(2));
      await settings({ locale: 'English' });
      await browser.$('.settings-button').click(); await browser.$('[role="dialog"]').waitForDisplayed();
      await trustedKey('Escape', 'large-result-settings-escape', settingsDismissed);
      assert.equal(await browser.execute(() => document.querySelector('pre.source-text')?.textContent), answerContent(2));
      await browser.execute(() => { document.querySelector('pre.source-text').scrollTop = 0; window.scrollTo(0, 0); });
      await inspect('large-result');
      await button('Back');
    });
    await check('selection-obsolete-answer-fence', async () => {
      await navigate('agents');
      const held = sourceEvent(fixture.events, 'held', row => row.method === 'answer' && row.agent === 'agent-001');
      const release = fixture.hold('answer', 'agent-001');
      try {
        await (await record('agents:run:agent-001')).click(); await button('Result'); await held;
        assert.match(await body(), /Loading source observations/); assert.equal(await browser.$('pre.source-text').isExisting(), false);
        await button('Back'); await (await record('agents:run:agent-002')).click(); await button('Result');
        await until(async () => (await browser.execute(() => document.querySelector('pre.source-text')?.textContent)) === 'SYNTHETIC selected 2', 'run.new-selection');
        const answered = sourceEvent(fixture.events, 'answered', row => row.method === 'answer' && row.agent === 'agent-001');
        release(); await answered;
        await browser.execute(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await browser.execute(() => document.querySelector('pre.source-text')?.textContent), 'SYNTHETIC selected 2');
      } finally { release(); }
      await button('Back');
    });
    await check('unavailable-retains-dated-last-good', async () => {
      await navigate('agents'); await until(async () => (await browser.$$('.agent-row')).length === agentCount, 'run.retained-start');
      fixture.set({ available: false });
      await until(async () => (await body()).includes('Retained last good snapshot; freshness is unconfirmed.'), 'run.unavailable');
      assert.equal((await browser.$$('.agent-row')).length, agentCount); assert.match(await body(), /Source view built:/); assert.doesNotMatch(await body(), /No records in the reported coverage|Loaded 0/);
      await fixture.restart({ available: true, version: 'SYNTHETIC restarted 2', revision: 4, messageRevision: 4 });
      await browser.$('[aria-label="Refresh observations"]').click(); await until(async () => !(await body()).includes('Retained last good snapshot; freshness is unconfirmed.'), 'run.reconnect');
      fixture.set({ empty: true, revision: 5, messageRevision: 5 });
      await until(async () => (await body()).includes('No records in the reported coverage'), 'run.explicit-empty'); assert.equal((await browser.$$('.agent-row')).length, 0);
      fixture.set({ empty: false, revision: 6, messageRevision: 6 });
      await until(async () => (await browser.$$('.agent-row')).length === agentCount, 'run.restore-after-empty');
    });
    await check('worktree-cheap-pages-explicit-inspection', async () => {
      const before = await fixture.logs(); assert.equal(before.filter(row => row.source === 'worktree' && row.method === 'inspect_worktree').length, 0);
      await navigate('worktrees'); await button('Load more'); await until(async () => (await browser.$$('[data-focus-key^="worktrees:wt:"]')).length === 23, 'worktree.pages');
      assert.match(await body(), /Coverage is incomplete or unknown/); assert.match(await body(), /Source timestamp not reported/);
      await (await record('worktrees:wt:tree-0')).click(); await until(async () => (await fixture.logs()).some(row => row.source === 'worktree' && row.method === 'inspect_worktree' && row.size === false), 'worktree.inspect');
      assert.equal((await fixture.logs()).filter(row => row.source === 'worktree' && row.method === 'inspect_worktree' && row.size === true).length, 0);
      await browser.$('h3=Status').waitForDisplayed();
      assert.match(await (await browser.$('h3=Status').$('..')).getText(), /known/);
      await button('Measure size read-only'); await until(async () => (await fixture.logs()).some(row => row.source === 'worktree' && row.method === 'inspect_worktree' && row.size === true), 'worktree.size');
      await until(async () => (await (await browser.$('h3=Size measurement').$('..')).getText()).includes('lower bound'), 'worktree.size-visible');
      assert.match(await (await browser.$('h3=Size measurement').$('..')).getText(), /At least .*lower bound/);
      await inspect('worktree-detail'); await button('Back');
    });
    await check('projects-saved-tasks-refresh-only-peek', async () => {
      await navigate('projects'); await until(async () => (await browser.$$('[data-focus-key^="projects:repo:"]')).length === 1, 'projects.identity');
      await browser.$('[data-focus-key^="projects:repo:"]').click();
      await until(async () => (await body()).includes('SYNTHETIC saved report, older plan revision'), 'tasks.saved-report'); assert.ok((await body()).includes(sourceProse));
      assert.match(await body(), /The current plan differs from the saved report plan/); assert.match(await body(), /Pending receipt is recorded; current execution has not been checked/);
      const before = (await fixture.logs()).filter(row => row.source === 'tasks' && row.method === 'peek').length;
      await browser.$('[aria-label="Refresh observations"]').click(); await until(async () => (await fixture.logs()).filter(row => row.source === 'tasks' && row.method === 'peek').length > before, 'tasks.refresh.peek');
      assert.ok((await fixture.logs()).filter(row => row.source === 'tasks' && row.method && !row.method.startsWith('notifications/')).every(row => ['initialize', 'get_status', 'peek'].includes(row.method))); await inspect('tasks-detail'); await button('Back');
    });
    await check('pool-namespaces-votes-decisions-deliveries', async () => {
      await navigate('pools'); await until(async () => (await browser.$$('[data-focus-key^="pools:"]')).length >= 2, 'pools.sources');
      assert.equal(await (await record('pools:runpool:legacy-1')).isExisting(), true); assert.equal(await (await record('pools:pool:standalone-1')).isExisting(), true);
      await button('Load more'); await until(async () => (await record('pools:pool:standalone-2')).isExisting(), 'pools.standalone-pages');
      await (await record('pools:pool:standalone-1')).click(); await button('Decisions'); await until(async () => (await body()).includes('SYNTHETIC accepted result; pool remains open'), 'pools.votes');
      assert.match(await body(), /Ready for acceptance/); assert.match(await body(), /Open/); assert.match(await body(), /No historical source timestamp/);
      await button('Next source page'); await until(async () => (await fixture.logs()).some(row => row.source === 'pool' && row.section === 'decisions' && row.after === 41), 'pool.decision-rowid'); await inspect('standalone-decisions');
      await button('Deliveries'); await until(async () => (await body()).includes('deliver') && (await body()).includes('accepted'), 'pools.deliveries'); await button('Back');
      await (await record('pools:runpool:legacy-1')).click(); await button('Discussion'); await until(async () => (await body()).includes('SYNTHETIC operator retained history'), 'legacy.history');
      assert.match(await body(), /open/); assert.match(await body(), /running/); assert.match(await body(), /true/);
      await button('Next source page'); await until(async () => (await body()).includes('SYNTHETIC legacy agreed is not completed'), 'legacy.cursor');
      await button('Decisions'); await until(async () => (await body()).includes('ready'), 'legacy.vote'); await inspect('legacy-decisions'); await button('Back');
    });
    await check('tools-observer-data-version-rediscovery', async () => {
      await navigate('tools'); await until(async () => (await body()).includes('Version unknown'), 'tools.unknown-version');
      await (await record('tools:run')).click(); await until(async () => (await body()).includes('SYNTHETIC provider a') && (await body()).includes('SYNTHETIC model b'), 'run.cached-limits-models');
      assert.match(await body(), /62/); assert.match(await body(), /unknown|Unknown|No information/);
      fixture.set({ quotaExpired: true }); await browser.$('[aria-label="Refresh observations"]').click();
      await until(async () => !(await body()).includes('62%') && !(await body()).includes('62 %'), 'run.expired-quota-null');
      assert.match(await body(), /No information/); await inspect('run-tool-detail'); await button('Back');
      await until(async () => (await body()).includes('SYNTHETIC restarted 2'), 'run.version-rediscovery');
      await (await record('tools:bridge')).click(); await button('Deliveries'); await until(async () => (await body()).includes('synthetic-delivery'), 'bridge.delivery'); assert.match(await body(), /unknown/); await button('Incidents'); await until(async () => (await body()).includes('synthetic-incident'), 'bridge.incident'); await inspect('bridge-tool-detail'); await button('Back');
      await (await record('tools:ide')).click(); await until(async () => (await body()).includes('synthetic-check'), 'ide.retained-check'); assert.match(await body(), /Information is stale/); assert.match(await body(), /Private instances may be outside this coverage/); await inspect('ide-tool-detail'); await button('Back');
    });
    await check('native-size-theme-axe-keyboard-overflow', async () => {
      for (const [width, height] of [[1440, 900], [1100, 720]]) {
        await setNativeViewport(width, height);
        for (const theme of ['Light', 'Dark']) {
          await settings({ theme });
          assert.equal(await browser.execute(() => document.documentElement.classList.contains('dark')), theme === 'Dark');
          for (const section of ['overview', 'agents', 'pools', 'worktrees', 'projects', 'tools']) { await navigate(section); await inspect(`${width}x${height}-${theme.toLowerCase()}-${section}`); }
        }
      }
      await navigate('agents'); await browser.execute(() => document.querySelector('.agent-name')?.focus()); await trustedKey('Enter', 'matrix-row-enter', async () => await browser.$('.detail-screen').isExisting()); await browser.$('.detail-screen').waitForDisplayed();
      assert.equal(await browser.execute(() => document.activeElement === document.querySelector('.detail-screen h1')), true); await browser.back(); await until(async () => !(await browser.$('.detail-screen').isExisting()), 'keyboard.back');
      assert.equal(await browser.execute(() => document.activeElement?.classList.contains('agent-name')), true);
    });
    await check('native-200-percent-text', async () => {
      await setNativeViewport(1100, 720); await settings({ theme: 'Light' });
      await browser.execute(() => { document.documentElement.style.fontSize = '200%'; });
      try {
        for (const section of ['overview', 'agents', 'worktrees', 'projects', 'pools', 'tools']) {
          await navigate(section); await inspect('200-percent-' + section);
          const layout = await browser.execute(() => {
            const kbd = document.querySelector('.search-box kbd'), input = document.querySelector('.search-box input');
            return {
              clippedControls: [...document.querySelectorAll('[role="combobox"] > span,.sidebar-footer')].filter(element => element.getClientRects().length && element.textContent.trim() && element.scrollWidth > element.clientWidth + 2).map(element => element.textContent.trim().slice(0, 100)),
              searchOverlap: !!(kbd?.getClientRects().length && input && getComputedStyle(kbd).position === 'absolute' && parseFloat(getComputedStyle(input).paddingRight) < kbd.getBoundingClientRect().width + 10),
              footerClipped: [...document.querySelectorAll('.sidebar-footer')].some(element => ['hidden', 'clip'].includes(getComputedStyle(element).overflowY) && element.scrollHeight > element.clientHeight + 2),
            };
          });
          assert.deepEqual(layout.clippedControls, [], section + ' enlarged selector/footer text clipping'); assert.equal(layout.searchOverlap, false, section + ' enlarged search shortcut overlap'); assert.equal(layout.footerClipped, false, section + ' enlarged footer clipping');
        }
        await navigate('agents'); await browser.$('input[data-focus-key="search"]').setValue('SYNTHETIC task 000');
        await until(async () => (await browser.$$('.agent-row')).length === 1, 'enlarged.search');
        await (await record('agents:run:agent-000')).click(); await browser.$('.detail-screen').waitForDisplayed(); await button('Back');
        assert.equal(await browser.$('input[data-focus-key="search"]').getValue(), 'SYNTHETIC task 000');
        await browser.$('.settings-button').scrollIntoView(); await browser.$('.settings-button').click(); await browser.$('[role="dialog"]').waitForDisplayed(); await trustedKey('Escape', 'enlarged-settings-escape', settingsDismissed);
      } finally { await browser.execute(() => { document.documentElement.style.fontSize = ''; }); }
    });
    }
  } catch (error) { report.errors.push({ stage, message: String(error), stack: error.stack }); if (String(error).includes('TIMEOUT_SOURCE')) report.timeoutSource = stage; else if (String(error).includes('genuinely visible and focused')) report.timeoutSource = 'native.focus'; if (browser) { try { await browser.saveScreenshot(path.join(session.directory, 'failure-terminal.png')); } catch { /* Terminal app failure may have closed WKWebView. */ } } }
  finally {
    if (browser) report.visibilityEvents = await browser.execute(() => window.__nativeAcceptanceVisibility ?? []).catch(() => []);
    if (browser && originalClipboard) { try { await browser.execute(() => { if (window.__nativeClipboardOriginal) Object.defineProperty(navigator.clipboard, 'writeText', window.__nativeClipboardOriginal); else delete navigator.clipboard.writeText; delete window.__nativeClipboardOriginal; delete window.__nativeClipboardRecording; }); } catch (error) { report.errors.push({ stage: 'clipboard-restore', message: String(error) }); } }
    if (session) { try { await session.close(); report.lastWindowExit = true; } catch (error) { report.errors.push({ stage: 'last-window-close', message: String(error) }); } }
    try { report.cleanup = await fixture.close(); } catch (error) { report.errors.push({ stage: 'fixture-cleanup', message: String(error) }); }
    for (const row of await fixture.logs()) if (row.method) { const key = row.source + '.' + row.method; report.methodCounts[key] = (report.methodCounts[key] ?? 0) + 1; }
    assert.ok(report.checks.length > 0 || report.errors.length > 0, 'Zero-test success is forbidden');
    report.status = report.errors.length ? 'failed' : 'passed';
    const destination = path.join(session?.directory ?? fixture.directory, 'native-ui-check.json'); await fs.writeFile(destination, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ status: report.status, checks: report.checks.length, errors: report.errors.length, report: destination, fixtures: fixture.directory, lastWindowExit: report.lastWindowExit, timeoutSource: report.timeoutSource }));
  }
  assert.equal(report.errors.length, 0, 'Native acceptance failed; inspect native-ui-check.json and screenshots');
  return report;
}

if (process.argv.includes('--fixtures-only')) console.log(JSON.stringify(await checkFixtures()));
else {
  assert.equal(process.env.AGENT_HUB_E2E_UI_CLEARED, '1', 'Native UI run requires root clearance that current frontend is embedded: AGENT_HUB_E2E_UI_CLEARED=1');
  assert.ok(process.env.AGENT_HUB_E2E_BINARY, 'Set AGENT_HUB_E2E_BINARY to the root-prepared native-e2e executable');
  await checkNative(process.env.AGENT_HUB_E2E_BINARY);
}
