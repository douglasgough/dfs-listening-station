// Dev-only headless-Chrome check for the stage canvases (Task 17b). NOT a runtime dependency and not a node:test file.
// Usage: see README.md. The fixed dock overlaps the page bottom, so controls are scrolled into view before clicking.
import { createRequire } from 'node:module';
const puppeteer = createRequire(process.cwd() + '/')('puppeteer-core');
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--autoplay-policy=no-user-gesture-required', '--ignore-certificate-errors'], defaultViewport: { width: 1400, height: 900 } });
const p = await b.newPage(); const logs = [];
p.on('console', m => { if (['error', 'warning'].includes(m.type())) logs.push(m.text()); });
p.on('pageerror', e => logs.push('pageerror: ' + e.message));
await p.goto('https://dfs-listening-station.test/app.html', { waitUntil: 'networkidle0' });
const wait = (ms = 120) => new Promise(r => setTimeout(r, ms));
const ok = (n, c, extra = '') => console.log(c ? 'PASS' : 'FAIL', n, extra);
const G = (id) => p.evaluate(i => window.__app.store.get(i), id);
const S = (id, v) => p.evaluate((i, x) => window.__app.store.set(i, x), id, v);
await p.screenshot({ path: '/tmp/ui-t17b-1-empty.png' });
ok('empty overlay visible', await p.evaluate(() => !document.getElementById('empty').hidden && getComputedStyle(document.getElementById('empty')).display !== 'none'));
await p.select('#selExamples', '0'); await wait();
ok('empty overlay hidden', await p.evaluate(() => document.getElementById('empty').hidden));
const cfg = [[0, .25, .2], [1, .5, .25], [2, .72, .15], [3, .88, .12]];
for (const [c, ce, w] of cfg) { await S(`ch${c+1}.filter.on`, true); await S(`ch${c+1}.filter.center`, ce); await S(`ch${c+1}.filter.width`, w); }
await S('ch2.filter.type', 'granular');
await S('ch3.vwin.mode', 1); await S('ch3.vwin.center', 0.5); await S('ch3.vwin.height', 0.4);
await p.evaluate(() => window.__app.app.select(2)); await wait();
await p.evaluate(() => document.getElementById('plot').scrollIntoView({ block: 'center' })); await wait(200);
await p.screenshot({ path: '/tmp/ui-t17b-2-allende.png' });
await p.evaluate(() => window.__app.app.select(0)); await wait();
const box = async (id = 'plot') => p.evaluate(i => { const r = document.getElementById(i).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }, id);
let bx = await box();
const px = u => bx.x + 14 + u * (bx.w - 28), py = bx.y + bx.h * 0.55;
// drag ch1 interior by +0.2 u
let c0 = await G('ch1.filter.center');
await p.mouse.move(px(.25), py); await p.mouse.down(); await p.mouse.move(px(.35), py, { steps: 4 }); await p.mouse.move(px(.45), py, { steps: 4 }); await p.mouse.up(); await wait();
let c1 = await G('ch1.filter.center');
ok('drag moves centre', Math.abs((c1 - c0) - 0.2) < 2 / (bx.w - 28), `delta ${(c1 - c0).toFixed(4)}`);
// right edge drag: window .35..? centre c1 width .2 -> right edge c1+.1
let w0 = await G('ch1.filter.width'); const re = c1 + w0 / 2;
await p.mouse.move(px(re), py); await p.mouse.down(); await p.mouse.move(px(re + .05), py, { steps: 5 }); await p.mouse.up(); await wait();
let w1 = await G('ch1.filter.width'), c2 = await G('ch1.filter.center');
ok('right edge drag widens', Math.abs((w1 - w0) - 0.05) < 2 / (bx.w - 28), `w ${w0}->${w1}`);
ok('left edge fixed', Math.abs((c2 - w1 / 2) - (c1 - w0 / 2)) < 1e-6);
// click on empty space moves selected centre
await p.mouse.click(px(.12), py); await wait();
let c3 = await G('ch1.filter.center');
ok('click empty moves selected', Math.abs(c3 - .12) < 2 / (bx.w - 28) || Math.abs(c3 - (await G('ch1.filter.width')) / 2) < 1e-3, `c ${c3}`);
// wheel
let w2 = await G('ch1.filter.width');
await p.mouse.move(px(.5), py); await p.mouse.wheel({ deltaY: 100 }); await wait();
let w3 = await G('ch1.filter.width');
ok('wheel changes width', Math.abs(w3 - Math.min(1, w2 * Math.exp(0.15))) < 1e-6, `${w2}->${w3}`);
// keys
await p.focus('#plot');
const kc = await G('ch1.filter.center'); await p.keyboard.press('ArrowRight'); await wait();
ok('ArrowRight +0.01', Math.abs((await G('ch1.filter.center')) - kc - 0.01) < 1e-9);
await p.keyboard.down('Shift'); await p.keyboard.press('ArrowLeft'); await p.keyboard.up('Shift'); await wait();
ok('Shift+Left -0.05 more', Math.abs((await G('ch1.filter.center')) - kc + 0.04) < 1e-9);
await p.keyboard.press('2'); await wait();
ok('key 2 selects channel 2', await p.evaluate(() => window.__app.app.selected === 1));
// pointerdown selecting another window
await p.mouse.click(px(.72), py); await wait();
ok('click on ch3 window selects ch3', await p.evaluate(() => window.__app.app.selected === 2));
await p.evaluate(() => window.__app.app.select(0));
// overlap precedence: ch1 & ch4 overlapping interiors; ch4 edge vs ch1 interior
await S('ch1.filter.center', .5); await S('ch1.filter.width', .4); await S('ch4.filter.center', .65); await S('ch4.filter.width', .2); await S('ch2.filter.on', false); await S('ch3.filter.on', false); await wait();
await p.evaluate(() => window.__app.app.select(1));
await p.mouse.move(px(.57), py); await p.mouse.down(); await p.mouse.up(); await wait();
ok('overlap nearest centre (ch1)', await p.evaluate(() => window.__app.app.selected === 0));
// u=.58 is ch4 left edge (.55)? ch4: .55..75; ch1: .3..7; u=.55 -> ch4 left edge handle beats ch1 interior
await p.mouse.move(px(.55), py); await p.mouse.down(); await p.mouse.up(); await wait();
ok('edge beats interior (ch4)', await p.evaluate(() => window.__app.app.selected === 3));
const hv = await p.evaluate(() => { const g = window.__app; return { sel: g.app.selected }; });
await S('ch2.filter.on', true); await S('ch3.filter.on', true);
// zoom
await S('ch1.filter.center', .25); await S('ch1.filter.width', .2); await S('ch4.filter.center', .88); await S('ch4.filter.width', .12);
await p.evaluate(() => window.__app.app.select(0)); await wait();
const st0 = await p.evaluate(() => ({ ...window.__app.app.stage }));
ok('zoom out disabled initially', await p.evaluate(() => document.getElementById('btnZoomOut').disabled));
// drag range selection
await p.evaluate(() => document.getElementById('rng').scrollIntoView({ block: 'center' })); await wait(200);
const rb = await box('rng'); const ru = u => rb.x + 14 + u * (rb.w - 28), ry = rb.y + rb.h / 2;
const full = await p.evaluate(() => ({ ...window.__app.app.fullRange }));
const fu = x => (x - full.x0) / (full.x1 - full.x0);
await p.mouse.move(ru(fu(500)), ry); await p.mouse.down(); await p.mouse.move(ru(fu(600)), ry, { steps: 5 }); await p.mouse.move(ru(fu(700)), ry, { steps: 5 }); await p.mouse.up(); await wait();
ok('zoom enabled', await p.evaluate(() => !document.getElementById('btnZoom').disabled));
await p.evaluate(() => document.getElementById('btnZoom').scrollIntoView({ block: 'center' })); await wait(200);
await p.click('#btnZoom'); await wait(200);
const st1 = await p.evaluate(() => ({ ...window.__app.app.stage }));
ok('stage narrowed', st1.x1 - st1.x0 < st0.x1 - st0.x0 && Math.abs(st1.x0 - 500) < 8 && Math.abs(st1.x1 - 700) < 8, JSON.stringify(st1));
ok('zoom out enabled', await p.evaluate(() => !document.getElementById('btnZoomOut').disabled));
await p.evaluate(() => document.getElementById('plot').scrollIntoView({ block: 'center' })); await wait(200);
await p.screenshot({ path: '/tmp/ui-t17b-4-zoom.png' });
await p.evaluate(() => document.getElementById('btnZoomOut').scrollIntoView({ block: 'center' })); await wait(200);
await p.click('#btnZoomOut'); await wait();
const st2 = await p.evaluate(() => ({ ...window.__app.app.stage }));
ok('zoom out restores', JSON.stringify(st2) === JSON.stringify(st0));
// lines: remove allende, add ISM + nebula
await p.evaluate(() => { const { app } = window.__app; app.removeLayer('allende'); });
await p.select('#selExamples', '8'); await wait(); await p.select('#selExamples', '9'); await wait();
await p.evaluate(() => window.__app.app.select(0)); await wait();
const info = await p.evaluate(() => window.__app.app.layers.map(l => l.id + ':' + l.kind));
console.log(info.join(','));
bx = await box();
// hover on the strongest tick of the first line layer
const tick = await p.evaluate(() => {
  const { app } = window.__app; const L = app.layers.find(l => l.kind === 'lines'); const st = app.stage;
  const ln = L.lines.filter(l => l.x >= st.x0 && l.x <= st.x1).sort((a, b) => b.intensity - a.intensity)[0];
  return { u: (ln.x - st.x0) / (st.x1 - st.x0), label: ln.label, I: ln.intensity };
});
await p.mouse.move(px(tick.u), bx.y + bx.h - 40, {}); await wait(); await p.mouse.move(px(tick.u) + 1, bx.y + bx.h - 40); await wait(200);
const ro = await p.evaluate(() => document.getElementById('readout').textContent);
console.log('readout:', ro);
ok('readout has line label', tick.label ? ro.includes(tick.label) : /line at/.test(ro));
await p.evaluate(() => document.getElementById('plot').scrollIntoView({ block: 'center' })); await wait(200);
bx = await box();
await p.mouse.move(px(tick.u), bx.y + bx.h - 40); await wait(); await p.mouse.move(px(tick.u) + .5, bx.y + bx.h - 40); await wait(200);
await p.screenshot({ path: '/tmp/ui-t17b-3-lines.png' });
// idle
await p.mouse.move(5, 5); await wait(300);
const n0 = await p.evaluate(() => window.__app.stage.paints); await wait(2000);
const n1 = await p.evaluate(() => window.__app.stage.paints);
ok('no repaints while idle', n0 === n1, `${n0} -> ${n1}`);
// ---- hardening (R35): a click or key never silently enables a disabled channel ----------------------------------------
await p.evaluate(() => { const a = window.__app; a.app.addLayer(a.app.examples.find(l => l.id === 'allende')); a.store.set('ch2.filter.on', false); a.app.select(1); document.getElementById('plot').scrollIntoView({ block: 'center' }); });
await wait(200);
{ const pb = await p.evaluate(() => { const r = document.getElementById('plot').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  const c0 = await p.evaluate(() => window.__app.store.get('ch2.filter.center'));
  await p.evaluate(() => { const a = window.__app; a.store.set('ch1.filter.center', 0.25); a.store.set('ch1.filter.width', 0.2); a.store.set('ch3.filter.center', 0.6); a.store.set('ch4.filter.center', 0.88); a.app.select(1); });
  await p.mouse.click(pb.x + 14 + 0.45 * (pb.w - 28), pb.y + pb.h * 0.5); await wait(100); // u = 0.45 is free of every enabled window
  ok('click on empty space does NOT enable a disabled channel', await p.evaluate(() => window.__app.store.get('ch2.filter.on') === false));
  ok('...nor move its window, and says so', (await p.evaluate(() => window.__app.store.get('ch2.filter.center'))) === c0 && /is off/.test(await p.evaluate(() => document.getElementById('plot-live').textContent)));
  await p.focus('#plot'); await p.keyboard.press('ArrowRight'); await p.mouse.move(pb.x + pb.w / 2, pb.y + pb.h / 2); await p.mouse.wheel({ deltaY: 100 }); await wait(100);
  ok('arrow keys and wheel leave a disabled channel alone', (await p.evaluate(() => window.__app.store.get('ch2.filter.center'))) === c0 && (await p.evaluate(() => window.__app.store.get('ch2.filter.on'))) === false); }
ok('no console errors/warnings', logs.length === 0, logs.join(' | '));
await b.close();
