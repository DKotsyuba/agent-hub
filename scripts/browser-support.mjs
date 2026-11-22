/** Browser-check utilities; isolated Chrome only, with all artifacts under the task temporary root. */
import { remote } from 'webdriverio';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

/** Task-owned evidence directory; the caller may isolate one run below the project temporary root (TMPDIR). */
export const artifactRoot = process.env.AGENT_HUB_BROWSER_ARTIFACT_ROOT ?? path.join(os.tmpdir(), 'artifacts');
/** Prepared downloads directory below the project temporary root (TMPDIR). */
const downloadsRoot = path.join(os.tmpdir(), 'downloads');
/** Prepared ChromeDriver, overridable for the installed Chrome build; tests never provision executables. */
const driverPath = process.env.AGENT_HUB_CHROMEDRIVER ?? path.join(downloadsRoot, 'driver-155.0.8059.84', 'chromedriver-mac-arm64', 'chromedriver');
/** Resolve the local, locked accessibility engine without network requests. */
const require = createRequire(import.meta.url);

/** Start an isolated headless Chrome using explicit installed browser and prepared driver paths; caller must deleteSession. */
export async function createBrowser() {
  await fs.mkdir(artifactRoot, { recursive: true });
  await fs.access(driverPath);
  const profile = await fs.mkdtemp(path.join(path.dirname(artifactRoot), 'browser-profile-'));
  return remote({
    logLevel: 'error',
    outputDir: artifactRoot,
    cacheDir: downloadsRoot,
    connectionRetryCount: 0,
    connectionRetryTimeout: 20000,
    capabilities: {
      browserName: 'chrome',
      'wdio:enforceWebDriverClassic': true,
      'wdio:chromedriverOptions': { binary: driverPath },
      'goog:chromeOptions': {
        binary: process.env.AGENT_HUB_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        args: ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-breakpad', '--user-data-dir=' + profile, '--crash-dumps-dir=' + artifactRoot],
      },
      'goog:loggingPrefs': { browser: 'ALL' },
    },
  });
}

/** Set an exact CSS viewport through the prepared Chromium driver, independent of desktop display size. */
export async function setViewport(browser, width, height) {
  await browser.setWindowSize(width, height);
  await browser.sendCommand('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
}

/** Save an inspectable screenshot under the approved artifact directory; name is a trusted test constant. */
export async function screenshot(browser, name) {
  return browser.saveScreenshot(path.join(artifactRoot, name + '.png'));
}

/** Return WCAG A/AA violations from the locked axe engine for the current rendered document. */
export async function accessibility(browser) {
  const source = await fs.readFile(require.resolve('axe-core/axe.min.js'), 'utf8');
  await browser.execute(source);
  return browser.execute(() => {
    return window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })
      .then(result => result.violations.map(v => ({ id: v.id, impact: v.impact, description: v.description, nodes: v.nodes.map(n => ({ target: n.target, summary: n.failureSummary })) })))
      .catch(error => [{ id: 'axe-error', description: String(error) }]);
  });
}

/** Read basic geometry and visible text sizes; identifies document overflow and undersized prose. */
export async function geometry(browser) {
  return browser.execute(() => ({
    width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth,
    bodyFont: getComputedStyle(document.body).fontSize,
    smallVisible: [...document.querySelectorAll('p, button, a, label, th, td, input, select, h1, h2, h3')].filter(e => e.getClientRects().length && !e.closest('.sr-only') && parseFloat(getComputedStyle(e).fontSize) < 14).slice(0, 12).map(e => ({ text: e.textContent?.trim().slice(0, 70), size: getComputedStyle(e).fontSize })),
  }));
}
