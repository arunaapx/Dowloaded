// Headless browser smoke test for the Velox PWA.
// Verifies: page loads, no console errors, service worker registers,
// the download flow runs end to end, and the browser receives a file download.

const { chromium } = require('playwright');

const BASE = process.env.TEST_BASE || 'http://127.0.0.1:8099';
const SAMPLE = 'https://samplelib.com/lib/preview/mp4/sample-5s.mp4';

function log(ok, msg) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) process.exitCode = 1;
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();

  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  // 1. load
  const resp = await page.goto(BASE, { waitUntil: 'load' });
  log(resp && resp.ok(), `page loads (${resp && resp.status()})`);
  log((await page.title()) === 'Velox Downloader', `title = "${await page.title()}"`);

  // 2. key UI present
  log(await page.locator('#url').isVisible(), 'URL input visible');
  log(await page.locator('#downloadBtn').isVisible(), 'Download button visible');

  // 3. service worker registers (localhost is a secure context)
  const swReady = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return false;
    const reg = await navigator.serviceWorker.ready.catch(() => null);
    return !!reg;
  });
  log(swReady, 'service worker registered');

  // 4. manifest reachable + parses
  const manifestOk = await page.evaluate(async () => {
    const href = document.querySelector('link[rel=manifest]')?.href;
    if (!href) return false;
    const m = await (await fetch(href)).json();
    return m.name === 'Velox Downloader' && Array.isArray(m.icons) && m.icons.length >= 2;
  });
  log(manifestOk, 'manifest linked + valid');

  // 5. full download flow
  await page.fill('#url', SAMPLE);
  const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
  await page.click('#downloadBtn');

  // progress card should appear
  await page.locator('#progressCard').waitFor({ state: 'visible', timeout: 10000 });
  log(true, 'progress card shown');

  const download = await downloadPromise;
  const suggested = download.suggestedFilename();
  log(/\.mp4$/i.test(suggested), `browser received download: ${suggested}`);

  // title should reach a finished state
  await page.locator('#progressTitle').waitFor({ state: 'visible' });
  const finalTitle = await page.locator('#progressTitle').textContent();
  log(/ready|done/i.test(finalTitle), `final status = "${finalTitle}"`);

  // 6. no console errors
  log(consoleErrors.length === 0, `console errors: ${consoleErrors.length ? consoleErrors.join(' | ') : 'none'}`);

  await browser.close();
  console.log(process.exitCode ? '\nRESULT: some checks failed' : '\nRESULT: all checks passed');
})().catch((e) => { console.error('TEST CRASHED:', e); process.exit(1); });
