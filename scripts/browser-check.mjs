/** End-to-end prototype checks using an isolated browser and the prepared, pinned WebdriverIO engine. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createBrowser, setViewport, screenshot, accessibility, geometry, artifactRoot } from './browser-support.mjs';

/** Source-local preview endpoint; no live ecosystem API is contacted. */
const url = 'http://127.0.0.1:4173/?demo=1';
/** Six required views and their stable local hash destinations. */
const sections = ['overview', 'agents', 'pools', 'worktrees', 'projects', 'tools'];
/** Accumulated evidence remains useful even when a later assertion fails. */
const report = { checks: [], accessibility: [], geometry: [], screenshots: [], errors: [] };
/** Owned browser session; always terminated after checks. */
const browser = await createBrowser();

/** Navigate with the real sidebar control and wait for its current-page state. */
async function navigate(section) {
  await browser.$('nav a[href="#' + section + '"]').click();
  await browser.waitUntil(async () => (await browser.$('nav a[href="#' + section + '"]').getAttribute('aria-current')) === 'page');
}

/** Change the actual interface preference through the settings dialog, retaining the native focus path. */
async function theme(label) {
  await browser.$('button*=Настройки интерфейса').click();
  await browser.$('[role="dialog"]').waitForDisplayed();
  await browser.$('//div[@role="dialog"]//button[normalize-space()="' + label + '"]').click();
  await browser.keys('Escape');
  await browser.$('[role="dialog"]').waitForDisplayed({ reverse: true });
}

/** Select a demonstration state through the accessible shadcn Select control. */
async function scenario(label) {
  await browser.$('[aria-label="Сценарий макета"]').waitForDisplayed({ timeout: 5000 });
  await browser.$('[aria-label="Сценарий макета"]').click();
  await browser.$('//*[@role="option" and normalize-space()="' + label + '"]').click();
  await browser.waitUntil(async () => browser.execute(() => !document.querySelector('[role="listbox"]') && document.querySelector('#root')?.getAttribute('aria-hidden') !== 'true'), { timeout: 5000 });
}

/** Collect geometry, contrast and accessible-name evidence without hiding violations. */
async function inspect(name) {
  const shape = await geometry(browser);
  const violations = await accessibility(browser);
  report.geometry.push({ name, ...shape });
  report.accessibility.push({ name, violations });
  assert.ok(shape.documentWidth <= shape.width + 1, name + ': document overflow');
  assert.ok(parseFloat(shape.bodyFont) >= 15, name + ': body font below 15px');
  assert.deepEqual(shape.smallVisible, [], name + ': visible prose below 14px');
}

try {
  await setViewport(browser, 1440, 900);
  await browser.url(url);
  await browser.$('main h1').waitForDisplayed();
  assert.equal((await browser.$$('nav a')).length, 6);
  assert.match(await browser.$('body').getText(), /Демонстрационные данные/);
  report.checks.push('six views and explicit demonstration label');
  const burstWrites = await browser.execute(async () => {
    const original = history.replaceState;
    let calls = 0;
    history.replaceState = function(...args) { calls += 1; return original.apply(this, args); };
    try {
      for (let i = 0; i < 1000; i += 1) {
        window.dispatchEvent(new Event('scroll'));
        document.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      }
      await new Promise(resolve => requestAnimationFrame(resolve));
      return calls;
    } finally { history.replaceState = original; }
  });
  assert.equal(burstWrites, 0, 'scroll/focus must not flood the History API');
  report.checks.push('2000 scroll/focus events produce no History API writes');

  for (const [label, code] of [['Светлая', 'light'], ['Тёмная', 'dark']]) {
    await theme(label);
    for (const section of sections) {
      await navigate(section);
      await inspect(code + '-' + section);
    }
    await navigate('overview');
    await screenshot(browser, 'overview-' + code);
    report.screenshots.push('overview-' + code + '.png');
  }
  report.checks.push('six views in both themes with WCAG AA checks');

  await theme('Светлая');
  await navigate('agents');
  const search = await browser.$('input[aria-label="Поиск: Агенты"]');
  await search.setValue('необычный-запрос-без-совпадений');
  await browser.waitUntil(async () => (await browser.$('main').getText()).includes('Совпадений не найдено'));
  await search.click();
  await browser.keys(['Meta', 'a']);
  await browser.keys('Backspace');
  await browser.$('button[aria-label="Открыть агента: Собрать читаемый обзор"]').waitForDisplayed();
  await browser.$('input[aria-label="Поиск: Агенты"]').setValue('обзор');
  const beforeOpenHistory = await browser.execute(() => history.length);
  await browser.$('.agent-table tbody tr:nth-child(1) td:nth-child(3)').moveTo();
  const rowBackgrounds = await browser.execute(() => {
    const row = document.querySelector('.agent-table tbody tr');
    const nodes = [...row.querySelectorAll('td'), row.querySelector('.agent-name')];
    return nodes.map(node => {
      let current = node;
      while (current) {
        const color = getComputedStyle(current).backgroundColor;
        if (color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') return color;
        current = current.parentElement;
      }
      return 'transparent';
    });
  });
  assert.equal(new Set(rowBackgrounds).size, 1, 'hover must cover all cells uniformly');
  await screenshot(browser, 'agent-row-hover');
  await browser.$('.agent-table tbody tr:nth-child(1) td:nth-child(3)').click();
  assert.equal(await browser.execute(() => history.length), beforeOpenHistory + 1, 'row click must create one history entry');
  await browser.$('[aria-label^="Подробности:"]').waitForDisplayed();
  assert.equal(await browser.execute(() => Boolean(document.querySelector('[aria-label="Список: Агенты"]')?.getClientRects().length)), false, 'details replace the list at wide size');
  await browser.$('[role="tab"]=Результат').click();
  assert.ok((await browser.$('[role="tabpanel"][data-state="active"]').getText()).length > 20);
  await browser.execute(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('fixture permission denied'); } } }); });
  await browser.$('button=Копировать результат').click();
  await browser.$('[role="alert"]').waitForDisplayed();
  assert.match(await browser.$('[role="alert"]').getText(), /Не удалось скопировать/);
  assert.equal(await browser.$('[role="alert"] .lucide-check').isExisting(), false);
  await inspect('clipboard-denied');
  await browser.$('[aria-label="Закрыть уведомление"]').click();
  await browser.execute(() => { delete navigator.clipboard; });
  report.checks.push('clipboard rejection is a warning, not success');
  await browser.$('[role="tab"]=История').click();
  await screenshot(browser, 'agent-detail-wide');
  await inspect('agent-detail-wide');
  report.checks.push('agent search, full-width hover, one row-click history entry, full-page details and tabs');

  await setViewport(browser, 1100, 720);
  await inspect('agent-detail-narrow');
  await screenshot(browser, 'agent-detail-narrow');
  await browser.$('button=Назад').click();
  await browser.$('[aria-label^="Подробности:"]').waitForDisplayed({ reverse: true });
  assert.equal(await browser.$('input[aria-label="Поиск: Агенты"]').getValue(), 'обзор', 'Back preserves the search query');
  report.checks.push('narrow full-page detail and Back preserving list filters');

  await navigate('pools');
  await browser.$('button*=Читаемый интерфейс').click();
  await browser.$('[role="tab"]=Решения').click();
  assert.match(await browser.$('[role="tabpanel"][data-state="active"]').getText(), /Возражение/);
  await browser.$('[role="tab"]=Участники').click();
  await browser.$('button*=Собрать читаемый обзор').click();
  await browser.$('button=Назад').click();
  assert.match(await browser.$('[aria-label^="Подробности:"]').getText(), /Читаемый интерфейс/);
  await browser.$('button*=Собрать читаемый обзор').click();
  await browser.$('[role="tab"]=Подробности').click();
  await browser.$('button=Интерфейс обзора').click();
  assert.match(await browser.$('[aria-label^="Подробности:"]').getText(), /Размер/);
  await browser.back();
  await browser.$('[role="tab"]=Подробности').waitForDisplayed();
  assert.equal(await browser.$('[role="tab"]=Подробности').getAttribute('aria-selected'), 'true', 'browser Back restores detail tab');
  await browser.forward();
  await browser.waitUntil(async () => (await browser.$('[aria-label^="Подробности:"]').getText()).includes('Размер'));
  await browser.$('button=Agent Hub').click();
  assert.match(await browser.$('[aria-label^="Подробности:"]').getText(), /Agent Tasks/);
  report.checks.push('independent pool votes and pool-agent-worktree-project links');

  await navigate('agents');
  for (const label of ['Пусто', 'Загрузка', 'Нет соединения', 'Устаревшие', 'Неполные', 'Обычный']) {
    await scenario(label);
    await inspect('scenario-' + label);
  }
  report.checks.push('empty, loading, error, stale and partial scenarios');

  await browser.keys(['Meta', 'k']);
  assert.equal(await browser.execute(() => document.activeElement?.tagName), 'INPUT');
  await browser.keys('Tab');
  assert.notEqual(await browser.execute(() => document.activeElement?.tagName), 'BODY');
  report.checks.push('search shortcut and keyboard focus');

  await navigate('tools');
  await scenario('Устаревшие');
  await browser.$('button*=Agent IDE').click();
  assert.match(await browser.$('[aria-label^="Подробности:"]').getText(), /актуальность всех сведений не подтверждена/);
  await inspect('stale-tool-detail');
  await browser.$('button=Назад').click();
  await scenario('Обычный');
  report.checks.push('stale tool details retain explicit freshness uncertainty');
  await navigate('overview');
  await browser.execute(() => { document.documentElement.style.fontSize = '200%'; });
  await inspect('large-text');
  await screenshot(browser, 'large-text');
  const clippedControls = await browser.execute(() => [...document.querySelectorAll('[role="combobox"] > span')].filter(e => e.getClientRects().length && e.textContent.trim() && e.scrollWidth > e.clientWidth + 2).map(e => e.textContent));
  assert.deepEqual(clippedControls, [], 'large text must not clip selected control values');
  const searchOverlap = await browser.execute(() => {
    const kbd = document.querySelector('.search-box kbd');
    const input = document.querySelector('.search-box input');
    if (!kbd?.getClientRects().length || !input || getComputedStyle(kbd).position !== 'absolute') return false;
    return parseFloat(getComputedStyle(input).paddingRight) < kbd.getBoundingClientRect().width + 10;
  });
  assert.equal(searchOverlap, false, 'shortcut must not overlap the search value');
  await browser.execute(() => { document.documentElement.style.fontSize = ''; });
  await setViewport(browser, 676, 900);
  await inspect('in-app-panel');
  await screenshot(browser, 'in-app-panel');
  const external = await browser.execute(() => performance.getEntriesByType('resource').map(e => e.name).filter(name => new URL(name).origin !== location.origin));
  assert.deepEqual(external, []);
  report.checks.push('large text without overflow and no external resources');

  const logs = await browser.getLogs('browser');
  report.errors = logs.filter(entry => entry.level === 'SEVERE');
  assert.deepEqual(report.errors, []);
  const violations = report.accessibility.flatMap(result => result.violations.map(v => ({ view: result.name, ...v })));
  assert.deepEqual(violations, [], 'Accessibility violations; see browser-check.json');
  console.log(JSON.stringify({ passed: report.checks, accessibilityViews: report.accessibility.length, screenshots: report.screenshots }, null, 2));
} catch (error) {
  report.failure = String(error.stack || error);
  report.navigationAtFailure = await browser.execute(() => ({ hash: location.hash, state: history.state, historyLength: history.length })).catch(() => null);
  await screenshot(browser, 'failure').catch(() => {});
  console.error(report.failure);
  process.exitCode = 1;
} finally {
  await fs.writeFile(artifactRoot + '/browser-check.json', JSON.stringify(report, null, 2) + '\n');
  await browser.deleteSession();
}
