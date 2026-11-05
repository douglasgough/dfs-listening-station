// Dev-only headless-Chrome runner for tests/browser/render.html (Task 16): loop length, periodicity, determinism, take, free loop.
// NOT a runtime dependency and not a node:test file. Usage: see README.md.
import { createRequire } from 'node:module';
const puppeteer = createRequire(process.cwd() + '/')('puppeteer-core');
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--ignore-certificate-errors'] });
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => logs.push(m.text())); page.on('pageerror', (e) => logs.push(String(e)));
await page.goto('https://dfs-listening-station.test/tests/browser/render.html', { waitUntil: 'load' });
await page.waitForFunction(() => document.title === 'render-done', { timeout: 300000, polling: 500 });
console.log(JSON.stringify(await page.evaluate(() => window.__render), null, 1));
await browser.close();
