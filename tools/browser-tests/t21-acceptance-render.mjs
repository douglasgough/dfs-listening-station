// Dev-only: renders the prototype-equivalent default Allende loop (mono, 48 s, free length) in the NEW app and saves the WAV
// for tools/wav-peaks.mjs comparison against tests/fixtures/prototype-allende-peaks.json. Usage: see README.md.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const puppeteer = createRequire(process.cwd() + '/')('puppeteer-core');
const URL_ = process.env.DFS_URL || 'https://dfs-listening-station.test/app.html';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = process.env.WAV_OUT || '/tmp/new-allende-loop.wav';
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--ignore-certificate-errors'], defaultViewport: { width: 1400, height: 1000 } });
const page = await browser.newPage();
page.on('pageerror', e => console.log('pageerror', e.message));
await page.goto(URL_, { waitUntil: 'networkidle0' });
const b64 = await page.evaluate(async () => {
  const a = window.__app;
  a.app.addLayer(a.app.examples.find(l => l.id === 'allende'));
  const au = a.audio;
  au.output.stereo = false; au.output.synced = false; au.output.seconds = 48;
  const blobs = []; const o = URL.createObjectURL.bind(URL); URL.createObjectURL = b => { blobs.push(b); return o(b); };
  await au.exportLoop();
  const buf = new Uint8Array(await blobs[0].arrayBuffer());
  let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
});
writeFileSync(OUT, Buffer.from(b64, 'base64'));
console.log('wrote', OUT, Buffer.from(b64, 'base64').length, 'bytes');
await browser.close();
