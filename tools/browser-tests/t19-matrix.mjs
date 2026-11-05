// Dev-only headless-Chrome check for the modulation matrix (Task 19). NOT a runtime dependency and not a node:test file.
// Usage: see README.md. Env: DFS_URL, CHROME_PATH, SHOT_DIR (default /tmp).
import { createRequire } from 'node:module';
const puppeteer = createRequire(process.cwd() + '/')('puppeteer-core');
const URL_ = process.env.DFS_URL || 'https://dfs-listening-station.test/app.html';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = process.env.SHOT_DIR || '/tmp';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fails = [];
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) fails.push(name); };

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--autoplay-policy=no-user-gesture-required', '--ignore-certificate-errors'], defaultViewport: { width: 1400, height: 1000 } });
const page = await browser.newPage();
const logs = [];
page.on('console', m => { if (['error', 'warning'].includes(m.type())) logs.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', e => logs.push('pageerror: ' + e.message));
await page.goto(URL_, { waitUntil: 'networkidle0' });
const ev = (fn, ...a) => page.evaluate(fn, ...a);
const routes = () => ev(() => JSON.parse(JSON.stringify(window.__app.store.state.matrix)));
const cellSel = (s, d) => `.mxcell[data-src="${s}"][data-dst="${d}"]`;
const center = async sel => { const b = await (await page.$(sel)).boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
const show = () => ev(() => document.getElementById('matrix').scrollIntoView({ block: 'start' }));

await sleep(300);
check('matrix mounted with a grid', await ev(() => !!document.querySelector('#matrix table.mxgrid[role=grid]')));
const defaults = await routes();
check('default routes env1 → event.level for 4 channels are shown', defaults.length === 4 && (await ev(() => document.querySelectorAll('#matrix .mxcell.on').length)) === 4);
const nCells = await ev(() => document.querySelectorAll('#matrix .mxcell').length);
check('grid has a cell per (visible source × destination)', nCells > 500, String(nCells));
check('no pitch destination rows', await ev(() => ![...document.querySelectorAll('#matrix .mxdst')].some(t => /map\.|drone\.beat/.test(t.title))));

// ---- click empty cell = +50% ------------------------------------------------------------------------------------
await show();
const A = cellSel('ch1.lfo1', 'ch1.filter.center');
await page.evaluate(sel => document.querySelector(sel).scrollIntoView({ block: 'center', inline: 'center' }), A);
let c = await center(A); await page.mouse.click(c.x, c.y); await sleep(80);
let r = (await routes()).find(x => x.src === 'ch1.lfo1' && x.dst === 'ch1.filter.center');
check('click on an empty cell adds a +50% route', !!r && Math.abs(r.amount - 0.5) < 1e-9);
check('cell shows the amount', await ev(sel => document.querySelector(sel).textContent === '+50', A));

// ---- drag sets the amount ---------------------------------------------------------------------------------------
c = await center(A);
await page.mouse.move(c.x, c.y); await page.mouse.down(); await page.mouse.move(c.x, c.y - 20, { steps: 4 }); await page.mouse.move(c.x, c.y - 40, { steps: 4 }); await page.mouse.up(); await sleep(80);
r = (await routes()).find(x => x.src === 'ch1.lfo1' && x.dst === 'ch1.filter.center');
check('dragging up raises the amount (+50% → ~+90%)', !!r && r.amount > 0.85 && r.amount <= 1, String(r && r.amount));
c = await center(A);
await page.mouse.move(c.x, c.y); await page.mouse.down(); await page.mouse.move(c.x, c.y + 60, { steps: 5 }); await page.mouse.move(c.x, c.y + 160, { steps: 8 }); await page.mouse.up(); await sleep(80);
r = (await routes()).find(x => x.src === 'ch1.lfo1' && x.dst === 'ch1.filter.center');
check('dragging far down makes it negative', !!r && r.amount < -0.3 && r.amount >= -1, String(r && r.amount));
check('negative cell is styled', await ev(sel => document.querySelector(sel).classList.contains('neg'), A));

// ---- keyboard ---------------------------------------------------------------------------------------------------
await page.focus(A);
await page.keyboard.press('ArrowUp'); await sleep(40);
const k1 = (await routes()).find(x => x.src === 'ch1.lfo1' && x.dst === 'ch1.filter.center').amount;
check('ArrowUp adds 5%', Math.abs(k1 - (r.amount + 0.05)) < 1e-9, `${r.amount} → ${k1}`);
await page.keyboard.press('Delete'); await sleep(40);
check('Delete clears the route', !(await routes()).some(x => x.src === 'ch1.lfo1' && x.dst === 'ch1.filter.center'));
await page.keyboard.press('Enter'); await sleep(40);
check('Enter toggles +50%', (await routes()).some(x => x.src === 'ch1.lfo1' && x.dst === 'ch1.filter.center' && Math.abs(x.amount - 0.5) < 1e-9));
c = await center(A); await page.mouse.click(c.x, c.y); await page.mouse.click(c.x, c.y, { clickCount: 2 }); await sleep(80);
check('double-click clears the route', !(await routes()).some(x => x.src === 'ch1.lfo1' && x.dst === 'ch1.filter.center'));
await page.focus(A); await page.keyboard.press('ArrowRight'); 
check('ArrowRight moves focus to the next source cell', await ev(() => document.activeElement.dataset.src === 'ch1.lfo2'));

// ---- cross-channel route and the channel filter ---------------------------------------------------------------------
await ev(() => window.__app.store.addRoute({ src: 'ch3.env1', dst: 'ch1.filter.width', amount: 0.7 }));
await ev(() => window.__app.store.addRoute({ src: 'g.lfo1', dst: 'ch2.grain.density', amount: -0.4 }));
await sleep(80);
await page.select('#matrix select[aria-label="Show routes for"]', 'ch1'); await sleep(150);
const filtered = await ev(() => ({ rows: [...document.querySelectorAll('#matrix .mxdst')].map(t => t.title), cols: [...document.querySelectorAll('#matrix .mxsrc')].map(t => t.title) }));
check('channel filter shows only that channel\'s destinations', filtered.rows.length > 5 && filtered.rows.every(t => t.startsWith('ch1.')));
check('channel filter keeps the foreign source that routes into it (ch3.env1)', filtered.cols.includes('ch3.env1') && !filtered.cols.includes('ch4.lfo1'));
await page.screenshot({ path: `${OUT}/ui-t19-2-filter.png` });
await page.select('#matrix select[aria-label="Show routes for"]', 'all'); await sleep(150);

// ---- collapse ---------------------------------------------------------------------------------------------------------
const before = await ev(() => document.querySelectorAll('#matrix .mxdst').length);
await ev(() => [...document.querySelectorAll('#matrix .mxtoggle')].find(b => b.textContent.includes('Channel 4')).click()); await sleep(100);
const after = await ev(() => document.querySelectorAll('#matrix .mxdst').length);
check('collapsing a group removes its rows', after < before, `${before} → ${after}`);
await ev(() => [...document.querySelectorAll('#matrix .mxtoggle')].find(b => b.textContent.includes('Channel 4')).click()); await sleep(100);

// ---- presets and CC columns -------------------------------------------------------------------------------------------
await ev(() => window.__app.app.select(1));
await ev(() => { const s = document.querySelector('#matrix select[aria-label=Preset]'); s.value = 'slowSweep'; });
await ev(() => [...document.querySelectorAll('#matrix button')].find(b => b.textContent === 'Add preset').click()); await sleep(100);
check('slow sweep preset adds ch2.lfo1 → ch2.filter.center at +100% and makes the LFO a triangle',
  (await routes()).some(x => x.src === 'ch2.lfo1' && x.dst === 'ch2.filter.center' && x.amount === 1) && await ev(() => window.__app.store.state.mods.ch2.lfo[0].shape === 'tri'));
await ev(() => { const i = document.querySelector('#matrix input[aria-label="MIDI CC number"]'); i.value = '74'; });
await ev(() => [...document.querySelectorAll('#matrix button')].find(b => b.textContent === 'Add CC column').click()); await sleep(100);
check('CC 74 column appears', await ev(() => [...document.querySelectorAll('#matrix .mxsrc')].some(t => t.title === 'g.cc74')));
c = await center(cellSel('g.cc74', 'ch1.filter.level')); await page.mouse.click(c.x, c.y); await sleep(80);
check('a CC cell can be routed', (await routes()).some(x => x.src === 'g.cc74' && x.dst === 'ch1.filter.level'));
await ev(() => document.querySelector('#matrix .mxsources').open = true);
check('global LFO editors are present (2)', await ev(() => document.querySelectorAll('#matrix .mxsources .srcedit, #matrix .mxsources [data-owner]').length >= 0 && document.querySelectorAll('#matrix .mxsources select').length >= 2));
await show(); await page.screenshot({ path: `${OUT}/ui-t19-1-matrix.png` });

// ---- store → grid sync and leaks ---------------------------------------------------------------------------------------
await ev(() => window.__app.store.removeRoute('ch3.env1', 'ch1.filter.width'));
await sleep(80);
check('removing a route from the store clears the cell', await ev(() => { const b = document.querySelector('.mxcell[data-src="ch3.env1"][data-dst="ch1.filter.width"]'); return !b || !b.classList.contains('on'); }));
const subs0 = await ev(() => window.__app.store.subscriberCount());
await ev(() => { for (let i = 0; i < 30; i++) window.__app.matrix.refresh(); });
check('rebuilding the grid 30× does not leak subscribers', (await ev(() => window.__app.store.subscriberCount())) === subs0);
check('no console errors or warnings', logs.length === 0, logs.join(' | '));
await browser.close();
console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASSED');
process.exit(fails.length ? 1 : 0);
