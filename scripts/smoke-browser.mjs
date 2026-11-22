/** Exercises browser navigation against the extracted archive's isolated smoke origin. */
import assert from 'node:assert/strict';
import { createBrowser, setViewport } from './browser-support.mjs';

const origin = new URL(process.argv[2]);
assert.equal(origin.hostname, '127.0.0.1');
const browser = await createBrowser();
const fixture = '[data-focus-key^="release-fixture:"]';
try {
  await browser.url(origin + 'sessions');
  await browser.execute(() => localStorage.setItem('agent-hub-locale', 'en'));
  for (const [width, height] of [[1440, 900], [1100, 720], [390, 844]]) {
    for (const theme of ['light', 'dark']) {
      await setViewport(browser, width, height);
      await browser.execute(value => localStorage.setItem('agent-hub-theme', value), theme);
      await browser.refresh();
      await browser.$(fixture).waitForDisplayed();
      await browser.waitUntil(() => browser.$('.web-connection .online').isExisting());
      assert.equal(await browser.execute(() => document.documentElement.classList.contains('dark')), theme === 'dark');
      assert.ok(await browser.execute(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
      await browser.execute(selector => document.querySelector(selector).focus(), fixture);
      await browser.keys('Enter');
      await browser.$('.web-detail-pane').waitForDisplayed();
      assert.equal(await browser.execute(() => document.activeElement?.tagName), 'H1');
      await browser.back();
      await browser.waitUntil(() => browser.execute(selector => document.activeElement?.matches(selector), fixture));
    }
  }
  await browser.url(origin + 'sessions?q=no-matching-fixture');
  await browser.waitUntil(async () => (await browser.$('main').getText()).includes('No records'));
  console.log('Browser smoke passed for both themes, three viewports, keyboard entry and Back focus, SSE and empty search.');
} finally {
  await browser.deleteSession();
}
