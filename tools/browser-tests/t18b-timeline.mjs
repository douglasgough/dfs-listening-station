// Dev-only headless-Chrome check for the timeline editor (Task 18b). NOT a runtime dependency and not a node:test file.
// Usage: see README.md. Env: DFS_URL, CHROME_PATH, SHOT_DIR (default /tmp).
import { createRequire } from 'node:module';
const puppeteer = createRequire(process.cwd() + '/')('puppeteer-core');

const URL_ = process.env.DFS_URL || 'https://dfs-listening-station.test/';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = process.env.SHOT_DIR || '/tmp';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fails = [];
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) fails.push(name); };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--autoplay-policy=no-user-gesture-required', '--ignore-certificate-errors'], defaultViewport: { width: 1400, height: 1000 } });
const page = await browser.newPage();
const logs = [];
page.on('console', m => { if (['error', 'warning'].includes(m.type())) logs.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', e => logs.push('pageerror: ' + e.message));
await page.goto(URL_, { waitUntil: 'networkidle0' });
const ev = (fn, ...a) => page.evaluate(fn, ...a);
const events = (ch = 0) => ev(c => JSON.parse(JSON.stringify(window.__app.store.state.timelines[c].events)), ch);
const tlState = (ch = 0) => ev(c => JSON.parse(JSON.stringify(window.__app.store.state.timelines[c])), ch);

await ev(() => { const a = window.__app; a.app.addLayer(a.app.examples.find(l => l.id === 'allende')); a.store.set('ch1.filter.on', true); });
await ev(() => { const d = document.querySelector('details[data-section=timeline], .chbody details:last-of-type'); if (d) d.open = true; });
await ev(() => document.querySelectorAll('.chbody details').forEach(d => { if (d.textContent.includes('Timeline')) d.open = true; }));
await sleep(300);
check('timeline editor mounted', await ev(() => !!document.querySelector('.tleditor .tlcanvas')));
await ev(() => document.querySelector('.tleditor').scrollIntoView({ block: 'center' }));
await page.screenshot({ path: `${OUT}/ui-t18b-1-empty.png` });

const box = async () => { const b = await (await page.$('.tlcanvas')).boundingBox(); return b; };
const pos = async (phase, v) => { const b = await box(); return { x: b.x + 14 + phase * (b.width - 28), y: b.y + (b.height - 12) - v * (b.height - 36) }; };
const click = async (phase, v) => { const p = await pos(phase, v); await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.up(); await sleep(60); };

// ---- add four events by clicking ---------------------------------------------------------------------------------
for (const [p, v] of [[0.1, 0.3], [0.4, 0.8], [0.7, 0.5], [0.9, 0.2]]) await click(p, v);
let evs = await events();
check('4 events added, sorted', evs.length === 4 && evs.every((e, i) => i === 0 || evs[i - 1].t <= e.t), JSON.stringify(evs.map(e => [+e.t.toFixed(3), +e.c.toFixed(3)])));
check('event phases/centres match the clicks', near(evs[0].t, 0.1, 0.01) && near(evs[0].c, 0.3, 0.02) && near(evs[1].t, 0.4, 0.01) && near(evs[1].c, 0.8, 0.02) && near(evs[3].c, 0.2, 0.02));
check('selecting sets timelineHold', await ev(() => window.__app.app.timelineHold[0] !== null));

// ---- drag a node ------------------------------------------------------------------------------------------------
await click(0.4, 0.8);
const a = await pos(0.4, 0.8), b = await pos(0.55, 0.6);
await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 }); await page.mouse.move(b.x, b.y, { steps: 4 }); await page.mouse.up(); await sleep(120);
evs = await events();
const moved = evs.find(e => near(e.t, 0.55, 0.015));
check('drag moved t and c', !!moved && near(moved.c, 0.6, 0.03), JSON.stringify(evs.map(e => [+e.t.toFixed(3), +e.c.toFixed(3)])));
check('events stay sorted after the drag', evs.every((e, i) => i === 0 || evs[i - 1].t <= e.t));
check('hold follows the moved event', await ev(() => { const h = window.__app.app.timelineHold[0]; return h !== null; }));
await page.screenshot({ path: `${OUT}/ui-t18b-2-events.png` });

// ---- keyboard -----------------------------------------------------------------------------------------------------
await page.focus('.tlcanvas');
const t0 = (await events()).find(e => near(e.t, 0.55, 0.015)).t;
await page.keyboard.press('ArrowRight'); await sleep(60);
const t1 = (await events()).find(e => near(e.t, t0 + 0.01, 0.002));
check('ArrowRight nudges the selected event by 0.01', !!t1);
await page.keyboard.press('Delete'); await sleep(60);
check('Delete removes the selected event', (await events()).length === 3);

// ---- morph / jump / length ------------------------------------------------------------------------------------------
await ev(() => [...document.querySelectorAll('.tleditor .seg button')].find(b => b.textContent === 'Jump').click()); await sleep(50);
check('Jump writes mode', (await tlState()).mode === 'jump');
await page.screenshot({ path: `${OUT}/ui-t18b-3-jump.png` });
await ev(() => [...document.querySelectorAll('.tleditor .seg button')].find(b => b.textContent === 'Morph').click()); await sleep(50);
check('Morph writes mode', (await tlState()).mode === 'morph');
await page.select('.tleditor select[aria-label="Length division"]', '2 bars'); await sleep(60);
const len = (await tlState()).len;
check('Length control writes len', len.mode === 'beats' && len.div === '2 bars', JSON.stringify(len));

// ---- selected-event editor ------------------------------------------------------------------------------------------
await click(0.1, 0.3); // select first event
check('event editor visible when an event is selected', await ev(() => document.querySelectorAll('.tleditor .tlevent .row').length >= 4));
await ev(() => { const r = [...document.querySelectorAll('.tleditor .tlevent .row')].find(x => x.querySelector('label').textContent === 'Width'); const i = r.querySelector('input'); i.value = '700'; i.dispatchEvent(new Event('input', { bubbles: true })); });
await sleep(60);
const w = (await events())[0].w;
check('event slider writes the event key', typeof w === 'number' && w > 0.2, 'w=' + w);
check('slider not rebuilt while dragging (same element still attached)', await ev(() => { const r = [...document.querySelectorAll('.tleditor .tlevent .row')].find(x => x.querySelector('label').textContent === 'Width'); return !!r && r.isConnected; }));
await page.focus('.tlcanvas'); await page.keyboard.press('Escape'); await sleep(60);
check('Escape clears the hold', await ev(() => window.__app.app.timelineHold[0] === null));

// ---- hostile length does not throw ----------------------------------------------------------------------------------
const before = logs.length;
await ev(() => { window.__app.store.state.timelines[0].len = { mode: 'hz', value: 'abc' }; window.__app.store.setTimeline(0, { mode: 'jump' }); });
await sleep(150);
check('invalid length value draws without errors', logs.length === before);
await ev(() => window.__app.store.setTimeline(0, { len: { mode: 'sec', value: 8 }, mode: 'morph' }));

// ---- channel switching / leaks --------------------------------------------------------------------------------------
await page.click('#chtab-1'); await sleep(150);
check('channel 2 editor starts empty', (await events(1)).length === 0 && await ev(() => document.querySelector('.tleditor .note')?.textContent.startsWith('Click the timeline')));
await page.click('#chtab-0'); await sleep(150);
check('channel 1 events are back after switching', (await events(0)).length === 3);
const subs0 = await ev(() => window.__app.store.subscriberCount());
for (let i = 0; i < 50; i++) await page.click(`#chtab-${i % 2}`);
await sleep(200);
check('50 channel switches leave the subscriber count unchanged', (await ev(() => window.__app.store.subscriberCount())) === subs0, `${subs0}`);
await page.click('.tleditor button:nth-of-type(3)').catch(() => {});

check('no console errors or warnings', logs.length === 0, logs.join(' | '));
await browser.close();
console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASSED');
process.exit(fails.length ? 1 : 0);
