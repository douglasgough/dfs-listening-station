// Dev-only headless-Chrome runner for tests/browser/smoke.html (Task 15): offline determinism x5, live CPU, toggling, file:// guard.
// NOT a runtime dependency and not a node:test file. Usage: see README.md.
import { createRequire } from 'node:module';
const puppeteer = createRequire(process.cwd() + '/')('puppeteer-core');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = 'https://dfs-listening-station.test';
const REPO = '/Users/douglasgough/Lerd/dfs-listening-station';
const quick = process.argv.includes('--quick');

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--ignore-certificate-errors'],
});
const out = { chrome: await browser.version() };
try {
  const page = await browser.newPage();
  const consoleErrors = [], pageErrors = [], info = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); else info.push(m.text()); });
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.goto(`${BASE}/tests/browser/smoke.html${quick ? '?quick=1' : ''}`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.title === 'smoke-done', { timeout: 180000, polling: 500 });
  out.smoke = await page.evaluate(() => window.__smoke);
  out.consoleErrors = consoleErrors; out.pageErrors = pageErrors;

  // app shell over HTTPS
  const app = await browser.newPage();
  const appLogs = [];
  app.on('console', (m) => appLogs.push(`${m.type()}: ${m.text()}`));
  await app.goto(`${BASE}/index.html`, { waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 500));
  out.appHttps = { logs: appLogs, bodyHasMessage: (await app.evaluate(() => document.body.innerText)).includes('Serve this app over HTTP(S)') };

  // (d) file:// guard
  const f = await browser.newPage();
  await f.goto(`file://${REPO}/index.html`, { waitUntil: 'load' });
  const text = await f.evaluate(() => document.body.innerText);
  out.fileGuard = { text, ok: text.includes('Serve this app over HTTP(S) (the audio engine cannot load from a file)') };
} finally {
  await browser.close();
}
const ok = out.smoke && out.smoke.pass && out.consoleErrors.length === 0 && out.pageErrors.length === 0 && out.fileGuard.ok
  && !out.appHttps.bodyHasMessage && out.appHttps.logs.some((l) => l.includes('app shell loaded'));
out.overall = ok ? 'PASS' : 'FAIL';
console.log(JSON.stringify(out, null, 2));
process.exit(ok ? 0 : 1);
