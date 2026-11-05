// Dev-only headless-Chrome check for the channel panel (Task 18). NOT a runtime dependency and not a node:test file.
// Usage: see README.md. Env: DFS_URL, CHROME_PATH, SHOT_DIR (default /tmp).
import { createRequire } from 'node:module';
const puppeteer = createRequire(process.cwd() + '/')('puppeteer-core');

const URL_ = process.env.DFS_URL || 'https://dfs-listening-station.test/';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = process.env.SHOT_DIR || '/tmp';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const fails = [];
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) fails.push(name); };

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--autoplay-policy=no-user-gesture-required', '--ignore-certificate-errors'],
  defaultViewport: { width: 1400, height: 1000 },
});
const page = await browser.newPage();
const logs = [];
page.on('console', m => { if (['error', 'warning'].includes(m.type())) logs.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', e => logs.push('pageerror: ' + e.message));
await page.goto(URL_, { waitUntil: 'networkidle0' });

const ev = (fn, ...a) => page.evaluate(fn, ...a);
const get = id => ev(i => window.__app.store.get(i), id);
const setRange = (label, v) => ev((l, val) => {
  const row = [...document.querySelectorAll('.chbody .row')].find(r => r.querySelector('label')?.textContent === l && !r.closest('[hidden]'));
  if (!row) throw new Error('no visible slider ' + l);
  const inp = row.querySelector('input[type=range]'); inp.value = String(val); inp.dispatchEvent(new Event('input', { bubbles: true }));
}, label, v);
const visibleRow = label => ev(l => [...document.querySelectorAll('.chbody .row')].some(r => r.querySelector('label')?.textContent === l && r.offsetParent !== null), label);
const clickSeg = (group, text) => ev((g, t) => {
  const b = [...document.querySelectorAll(`.chbody [role=group][aria-label="${g}"] button`)].find(x => x.textContent === t);
  if (!b) throw new Error('no seg ' + g + '/' + t); b.click();
}, group, text);
const shot = async (name, sel = '#channels') => {
  await ev(s => document.querySelector(s).scrollIntoView({ block: 'start' }), sel);
  await sleep(150);
  await page.screenshot({ path: `${OUT}/ui-t18-${name}.png` });
};

// ---- load Allende, enable all four channels through the UI -----------------------------------------------------
await ev(() => { const a = window.__app; a.app.addLayer(a.app.examples.find(l => l.id === 'allende')); });
await sleep(300);
check('channel panel mounted', await ev(() => !!document.querySelector('#channels .chtabs[role=tablist]')));
for (let i = 0; i < 4; i++) {
  await page.click(`#chtab-${i}`);
  const on = await get(`ch${i + 1}.filter.on`);
  if (!on) await ev(() => [...document.querySelectorAll('.chbody .inline label')].find(l => l.textContent.trim() === 'Enabled').click());
}
check('all four channels enabled', (await Promise.all([1, 2, 3, 4].map(n => get(`ch${n}.filter.on`)))).every(Boolean));
check('tab dots filled for enabled channels', await ev(() => [...document.querySelectorAll('.chtab')].every(t => t.classList.contains('en'))));

// ---- tabs ------------------------------------------------------------------------------------------------------
await page.click('#chtab-2');
check('tab click selects channel (app.selected)', (await ev(() => window.__app.app.selected)) === 2);
check('aria-selected follows', await ev(() => document.querySelector('#chtab-2').getAttribute('aria-selected') === 'true' && document.querySelector('#chtab-0').getAttribute('aria-selected') === 'false'));
await ev(() => window.__app.app.select(0));
check('tab follows app.select from elsewhere', await ev(() => document.querySelector('#chtab-0').classList.contains('on') && document.querySelector('.chbody').dataset.ch === '0'));

// ---- keyboard --------------------------------------------------------------------------------------------------
await page.focus('#chtab-0');
await page.keyboard.press('ArrowRight');
check('ArrowRight moves to next tab', (await ev(() => window.__app.app.selected)) === 1 && await ev(() => document.activeElement.id === 'chtab-1'));
await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft');
check('ArrowLeft wraps to last tab', (await ev(() => window.__app.app.selected)) === 3);
await page.keyboard.press('Home');
check('Home selects first tab', (await ev(() => window.__app.app.selected)) === 0);

// ---- slider writes the store ----------------------------------------------------------------------------------------
await setRange('Center', 250);
const c = await get('ch1.filter.center');
check('slider writes the store', Math.abs(c - 0.25) < 0.01, String(c));

// ---- vertical window -------------------------------------------------------------------------------------------
check('vwin controls hidden at mode Off', !(await visibleRow('Vertical center')));
await clickSeg('Vertical window', 'Reflectance');
check('vwin mode stored as 1', (await get('ch1.vwin.mode')) === 1);
check('vwin controls shown for mode 1', await visibleRow('Vertical center'));
await clickSeg('Vertical window', 'Depth');
check('vwin shown for mode 2', (await get('ch1.vwin.mode')) === 2 && await visibleRow('Vertical height'));
await clickSeg('Vertical window', 'Off');
check('vwin hidden again at Off', !(await visibleRow('Vertical center')));

// ---- screenshot 1 ----------------------------------------------------------------------------------------------
await shot('1-ch1');

// ---- granular on channel 2 ----------------------------------------------------------------------------------------
await page.click('#chtab-1');
check('grain controls hidden for window type', !(await visibleRow('Grain size')));
await clickSeg('Filter type', 'Granular');
check('filter.type stored', (await get('ch2.filter.type')) === 'granular');
check('grain controls shown for granular', await visibleRow('Grain size') && await visibleRow('Size jitter'));
check('granular alt labels', await visibleRow('Region center') && await visibleRow('Region span') && await visibleRow('Grain softness'));
await shot('2-granular');
await clickSeg('Filter type', 'Window');
check('grain controls hidden again', !(await visibleRow('Grain size')) && await visibleRow('Center'));
await clickSeg('Filter type', 'Granular');

// ---- events: pattern ---------------------------------------------------------------------------------------------
await page.click('#chtab-2');
await clickSeg('Event timing', 'Pattern');
check('event.mode pattern', (await get('ch3.event.mode')) === 'pattern');
const before = await ev(() => window.__app.store.state.pattern[2][1]);
await ev(() => document.querySelector('.chbody .steps button[aria-label="Step 2"]').click());
const after = await ev(() => window.__app.store.state.pattern[2][1]);
check('pattern step toggle writes store.state.pattern', before !== after, `${before} -> ${after}`);
await ev(() => document.querySelector('.chbody .steps button[aria-label="Step 2"]').click());
check('pattern step toggles back', (await ev(() => window.__app.store.state.pattern[2][1])) === before);
await ev(() => { const n = document.querySelector('.chbody input[type=number][min="2"]'); n.value = '12'; n.dispatchEvent(new Event('change', { bubbles: true })); });
check('steps number writes event.steps and shows 12 buttons', (await get('ch3.event.steps')) === 12 && (await ev(() => [...document.querySelectorAll('.chbody .steps button')].filter(b => !b.hidden).length)) === 12);
await ev(() => window.__app.panel.setCurrentStep(3));
check('setCurrentStep marks a step', await ev(() => document.querySelectorAll('.chbody .steps button.now').length === 1 && document.querySelector('.chbody .steps button.now').getAttribute('aria-label') === 'Step 4'));
check('Trigger now is enabled (Task 20 supplies the handler)', await ev(() => ![...document.querySelectorAll('.chbody button')].find(b => b.textContent === 'Trigger now').disabled));
await clickSeg('Event timing', 'Regular');
check('regular shows interval', await ev(() => !!document.querySelector('.chbody .timectl')?.offsetParent));
await clickSeg('Event timing', 'Pattern');
await ev(() => window.__app.panel.setCurrentStep(-1));
await shot('3-events-pattern');

// ---- modulators --------------------------------------------------------------------------------------------------
await page.click('#chtab-0');
await ev(() => { document.querySelector('.sec-mods').open = true; document.querySelectorAll('.sec-mods .subsec').forEach(d => { d.open = true; }); });
await sleep(250);
check('four source editors present', (await ev(() => document.querySelectorAll('.sec-mods .srced').length)) === 4);
check('source ids shown', JSON.stringify(await ev(() => [...document.querySelectorAll('.sec-mods .srcid')].map(e => e.textContent))) === JSON.stringify(['ch1.lfo1', 'ch1.lfo2', 'ch1.env1', 'ch1.env2']));
await ev(() => { const s = document.querySelector('.sec-mods .srced.lfo select'); s.value = 'drift'; s.dispatchEvent(new Event('change', { bubbles: true })); });
check('LFO shape writes store.state.mods', (await ev(() => window.__app.store.state.mods.ch1.lfo[0].shape)) === 'drift');
await ev(() => { const r = document.querySelector('.sec-mods .srced.env input[type=range]'); r.value = '800'; r.dispatchEvent(new Event('input', { bubbles: true })); });
const attack = await ev(() => window.__app.store.state.mods.ch1.env[0].a);
check('env attack writes store.state.mods (log taper)', Math.abs(attack - 0.695) < 0.02, String(attack));
await ev(() => [...document.querySelectorAll('.sec-mods .srced.lfo button')].find(b => b.textContent === 'New seed').click());
check('New seed writes seed', (await ev(() => window.__app.store.state.mods.ch1.lfo[0].seed)) !== 17);
check('no inline error shown', (await ev(() => [...document.querySelectorAll('.srcmsg')].every(m => m.textContent === ''))));
await shot('4-mod', '.sec-mods');

// ---- map link ----------------------------------------------------------------------------------------------------------
await page.click('#chtab-0');
check('no link toggle on channel 1', !(await ev(() => [...document.querySelectorAll('.chbody label')].some(l => l.textContent.includes('Link to channel 1')))));
await setRange('Snap to harmonics', 400);
await page.click('#chtab-1');
const linkBox = () => ev(() => [...document.querySelectorAll('.chbody label')].find(l => l.textContent.includes('Link to channel 1')).querySelector('input'));
await ev(() => [...document.querySelectorAll('.chbody label')].find(l => l.textContent.includes('Link to channel 1')).querySelector('input').click());
check('link flag in app UI state', await ev(() => window.__app.app.mapLinked[1] === true));
const [s1, s2] = [await get('ch1.map.snap'), await get('ch2.map.snap')];
check('turning link on copies ch1 map values', s1 === s2, `${s1} / ${s2}`);
check('ch2 map controls disabled', await ev(() => document.querySelector('.chbody fieldset.maplink').disabled && document.querySelector('.chbody fieldset.maplink input[type=range]').matches(':disabled')));
await page.click('#chtab-0');
await setRange('Low end', 100);
await ev(() => { const s = [...document.querySelectorAll('.chbody select')].find(x => [...x.options].some(o => o.value === 'lin')); s.value = 'lin'; s.dispatchEvent(new Event('change', { bubbles: true })); });
check('later ch1 map changes follow into ch2', (await get('ch2.map.lo')) === (await get('ch1.map.lo')) && (await get('ch2.map.curve')) === 'lin');
await page.click('#chtab-1');
check('link state restored on tab re-entry', await ev(() => document.querySelector('.chbody fieldset.maplink').disabled));
await ev(() => [...document.querySelectorAll('.chbody label')].find(l => l.textContent.includes('Link to channel 1')).querySelector('input').click());
check('unlinking re-enables controls', await ev(() => !document.querySelector('.chbody fieldset.maplink').disabled));
check('link state is not in the patch', await ev(() => !JSON.stringify(window.__app.store.state).includes('mapLinked')));

// ---- channel off hint --------------------------------------------------------------------------------------------------
await ev(() => window.__app.store.set('ch2.filter.on', false));
check('off channel shows hint and dims', await ev(() => !document.querySelector('.chhint').hidden && document.querySelector('.chbody').classList.contains('off')));
check('off channel stays editable', await ev(() => !document.querySelector('.chbody input[type=range]').disabled));
await ev(() => window.__app.store.set('ch2.filter.on', true));
check('hint hides when enabled', await ev(() => document.querySelector('.chhint').hidden));

// ---- stage follows tab switches ------------------------------------------------------------------------------------------------
await page.click('#chtab-3');
check('stage selection follows tab', (await ev(() => window.__app.app.selected)) === 3);

// ---- layer list repopulates ------------------------------------------------------------------------------------------------
await ev(() => { const a = window.__app; a.app.addLayer({ ...a.app.examples.find(l => l.id === 'murchison'), id: 'murch-x', name: 'Murch X' }); });
check('source.layer options follow app layers', await ev(() => [...document.querySelectorAll('.chbody select')].some(s => [...s.options].some(o => o.value === 'murch-x'))));

// ---- leak check: 50 tab switches ------------------------------------------------------------------------------------------------
await page.click('#chtab-0');
const subs0 = await ev(() => window.__app.store.subscriberCount());
// count live app subscribers too (wrap app.subscribe)
await ev(() => { const a = window.__app.app, orig = a.subscribe; window.__appSubs = 0; a.subscribe = fn => { window.__appSubs++; const off = orig(fn); return () => { window.__appSubs--; off(); }; }; });
await ev(() => window.__app.app.select(1)); await ev(() => window.__app.app.select(0));
const appSubs0 = await ev(() => window.__appSubs);
for (let k = 0; k < 50; k++) await ev(k2 => window.__app.app.select(k2 % 4), k + 1);
await ev(() => window.__app.app.select(0));
const subs1 = await ev(() => window.__app.store.subscriberCount());
check('50 tab switches leave store subscriber count unchanged', subs0 === subs1, `${subs0} -> ${subs1}`);
check('50 tab switches leave app subscriber count unchanged', appSubs0 === await ev(() => window.__appSubs), String(appSubs0));
check('exactly one body DOM tree', (await ev(() => document.querySelectorAll('.chbody').length)) === 1);

// ---- final -----------------------------------------------------------------------------------------------------------------------
const rel = logs.filter(l => !/favicon/.test(l));
check('no console errors or warnings', rel.length === 0, rel.join(' | '));
await browser.close();
console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join('; ')}` : '\nALL PASSED');
process.exit(fails.length ? 1 : 0);
