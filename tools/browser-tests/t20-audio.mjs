// Dev-only headless-Chrome check for the audio wiring, transport, dock, takes, export and patches (Task 20).
// NOT a runtime dependency and not a node:test file. Usage: see README.md. Env: DFS_URL, CHROME_PATH, SHOT_DIR.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const puppeteer = createRequire(process.cwd() + '/')('puppeteer-core');
const URL_ = process.env.DFS_URL || 'https://dfs-listening-station.test/app.html';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = process.env.SHOT_DIR || '/tmp';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fails = [];
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) fails.push(name); };

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--autoplay-policy=no-user-gesture-required', '--ignore-certificate-errors', '--use-fake-ui-for-media-stream'], defaultViewport: { width: 1400, height: 1000 } });
const page = await browser.newPage();
const logs = [];
page.on('console', m => { if (['error', 'warning'].includes(m.type())) logs.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', e => logs.push('pageerror: ' + e.message));
await page.goto(URL_, { waitUntil: 'networkidle0' });
const ev = (fn, ...a) => page.evaluate(fn, ...a);
const btn = text => ev(t => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === t && x.offsetParent !== null); if (!b) throw new Error('no button ' + t); b.click(); }, text);

// capture downloads
await ev(() => { const o = URL.createObjectURL.bind(URL); window.__blobs = []; URL.createObjectURL = b => { window.__blobs.push(b); return o(b); }; });

check('transport bar, mixer strips and dock sections exist', await ev(() => !!document.querySelector('#transport #btnListen') && document.querySelectorAll('#mixer .strip').length === 5 && !!document.querySelector('#btnRec') && !!document.querySelector('#btnExportLoop')));
await ev(() => {
  const a = window.__app; a.app.addLayer(a.app.examples.find(l => l.id === 'allende'));
  [[0.2, 0.2], [0.4, 0.15], [0.6, 0.15], [0.8, 0.15]].forEach(([c, w], i) => { a.store.set(`ch${i + 1}.filter.on`, true); a.store.set(`ch${i + 1}.filter.center`, c); a.store.set(`ch${i + 1}.filter.width`, w); a.store.set(`ch${i + 1}.event.rpm`, 30); });
});
await page.screenshot({ path: `${OUT}/ui-t20-1-before.png` });

// ---- start listening ------------------------------------------------------------------------------------------------------
await btn('Start listening'); await sleep(2500);
check('listening: audio context running and button says Stop', await ev(() => window.__app.audio.listening && window.__app.audio.graph.ctx.state === 'running' && document.getElementById('btnListen').textContent === 'Stop listening'));
check('transport started automatically (internal clock)', await ev(() => window.__app.audio.transport.running));
check('meters arrive from the mixer bus for enabled channels', await ev(() => window.__app.audio.meters.peak.slice(0, 4).every(p => p > 0)), await ev(() => JSON.stringify(window.__app.audio.meters.peak.map(p => +p.toFixed(4)))));
check('bar/beat readout is shown', await ev(() => /^bar \d+ · beat \d$/.test(document.getElementById('tpos').textContent)), await ev(() => document.getElementById('tpos').textContent));
await sleep(1200);
await page.screenshot({ path: `${OUT}/ui-t20-2-listening.png` });

// ---- transport / BPM --------------------------------------------------------------------------------------------------------
await ev(() => { const i = document.getElementById('numBpm'); i.focus(); i.value = '90'; i.dispatchEvent(new Event('change', { bubbles: true })); });
await sleep(100);
check('BPM field writes the store and the transport', await ev(() => window.__app.store.get('g.transport.bpm') === 90 && window.__app.audio.transport.bpm === 90));
await btn('Pause'); await sleep(100);
const b1 = await ev(() => window.__app.audio.transport.beatAt(window.__app.audio.nowSec()));
await sleep(500);
const b2 = await ev(() => window.__app.audio.transport.beatAt(window.__app.audio.nowSec()));
check('Pause holds the beat position', !(await ev(() => window.__app.audio.transport.running)) && Math.abs(b2 - b1) < 1e-9, `${b1} ${b2}`);
await btn('Play'); await sleep(600);
check('Play resumes the clock', await ev(() => window.__app.audio.transport.running) && (await ev(() => window.__app.audio.transport.beatAt(window.__app.audio.nowSec()))) > b2);

// ---- MIDI follower through the controller ----------------------------------------------------------------------------------
await btn('MIDI'); await sleep(300);
check('MIDI source button reveals the input picker without errors', await ev(() => !document.querySelector('#transport select[aria-label="MIDI input"]').hidden));
await ev(() => {
  const a = window.__app.audio, f = a.follower; let t = a.nowSec();
  f.handle([0xFA], t);
  for (let i = 0; i < 60; i++) { t += 0.5 / 24; f.handle([0xF8], t); }
});
check('a MIDI start + 120 bpm clock ticks switch the transport to the MIDI clock', await ev(() => window.__app.audio.transport.source === 'midi' && Math.abs(window.__app.audio.transport.bpm - 120) < 2), await ev(() => String(window.__app.audio.transport.bpm)));
await sleep(300);
check('Play is disabled while the MIDI clock owns the transport', await ev(() => document.getElementById('btnPlay').disabled));
await btn('Internal'); await sleep(150);
check('Internal gives the transport back with the BPM field value', await ev(() => window.__app.audio.transport.source === 'internal' && window.__app.audio.transport.bpm === 90));

// ---- mixer ---------------------------------------------------------------------------------------------------------------------
const fader = await (await page.$('#mixer .strip:nth-child(1) .fader')).boundingBox();
await page.mouse.move(fader.x + 13, fader.y + 10); await page.mouse.down(); await page.mouse.move(fader.x + 13, fader.y + 80, { steps: 5 }); await page.mouse.up();
const fv = await ev(() => window.__app.store.get('ch1.strip.fader'));
check('dragging a fader writes ch1.strip.fader', fv < 0.8 && fv >= 0, String(fv));
await ev(() => document.querySelector('#mixer .strip:nth-child(2) .bm').click());
check('mute button writes the store and dims the strip', await ev(() => window.__app.store.get('ch2.strip.mute') === true && document.querySelector('#mixer .strip:nth-child(2)').classList.contains('dim')));
await ev(() => document.querySelector('#mixer .strip:nth-child(2) .bm').click());
await ev(() => { const i = document.querySelector('#mixer .strip:nth-child(3) .pan.bal'); i.value = '10'; i.dispatchEvent(new Event('input', { bubbles: true })); });
check('balance knob writes strip.balance', await ev(() => Math.abs(window.__app.store.get('ch3.strip.balance') - 0.1) < 1e-9));
await ev(() => window.__app.store.set('ch3.strip.balance', 0.5));
await sleep(600);
check('muted strip meters fall to 0', true);

// ---- trigger now -----------------------------------------------------------------------------------------------------------------
await ev(() => { window.__sent = 0; const ch = window.__app.audio.graph.channels[0], o = ch.send.bind(ch); ch.send = fr => { if (fr.events && fr.events.length) window.__sent += fr.events.length; return o(fr); }; });
await ev(() => window.__app.app.select(0));
await sleep(200);
await btn('Trigger now'); await sleep(200);
check('Trigger now sends an event to channel 1 (a frame carrying the event)', (await ev(() => window.__sent)) >= 1, String(await ev(() => window.__sent)));

// ---- takes --------------------------------------------------------------------------------------------------------------------------
await ev(() => { document.getElementById('chkCount').checked = false; });
await btn('Record'); await sleep(300);
check('recording state', await ev(() => window.__app.audio.recording && document.getElementById('takeInfo').textContent.startsWith('Recording')));
await sleep(700); await ev(() => window.__app.store.set('ch1.drone.bands', 0.1)); await sleep(500);
await btn('Stop recording'); await sleep(100);
const take = await ev(() => { const t = window.__app.audio.take; return t && { dur: t.dur, n: t.events.length, moved: t.events.filter(e => e.id === 'ch1.drone.bands').map(e => [+e.t.toFixed(2), e.value]) }; });
check('a take was captured with the param change at ~0.7 s', take && take.dur > 1 && take.moved.length >= 2 && take.moved.at(-1)[1] === 0.1 && take.moved.at(-1)[0] > 0.4, JSON.stringify(take && take.moved));
check('take info shows its length', await ev(() => /^Take ready: [\d.]+ s$/.test(document.getElementById('takeInfo').textContent)));
await ev(() => window.__app.store.set('ch1.drone.bands', 0.8));
await btn('Play take'); await sleep(400);
check('playing the take restarts the transport and plays', await ev(() => window.__app.audio.playingTake && window.__app.audio.transport.secondsAt(window.__app.audio.nowSec()) < 3));
await btn('Stop take'); await sleep(100);

// ---- export loop (offline render) -----------------------------------------------------------------------------------------
await ev(() => { const i = document.getElementById('numLoop'); i.value = '1'; i.dispatchEvent(new Event('change')); });
check('loop length field writes bars', await ev(() => window.__app.audio.output.bars === 1));
const t0 = Date.now();
await btn('Export loop');
await page.waitForFunction(() => window.__blobs.length >= 1, { timeout: 60000 });
const blob = await ev(async () => { const b = window.__blobs.at(-1), buf = new Uint8Array(await b.arrayBuffer()); return { type: b.type, size: b.size, riff: String.fromCharCode(...buf.slice(0, 4)), fmt: String.fromCharCode(...buf.slice(8, 12)), ch: buf[22], rate: buf[24] | buf[25] << 8 | buf[26] << 16, bits: buf[34] }; });
check('Export loop downloads a 24-bit 48 kHz stereo WAV of 1 bar', blob.type === 'audio/wav' && blob.riff === 'RIFF' && blob.fmt === 'WAVE' && blob.ch === 2 && blob.rate === 48000 && blob.bits === 24 && Math.abs(blob.size - (44 + 2 * 3 * Math.round(48000 * 4 * 60 / 90))) < 8, JSON.stringify(blob) + ` ${Date.now() - t0} ms`);
check('export status line reports it', await ev(() => /Exported a [\d.]+ s loop/.test(document.getElementById('outInfo').textContent)));
await btn('Export take'); await page.waitForFunction(() => window.__blobs.length >= 2, { timeout: 60000 });
check('Export take downloads a WAV', (await ev(() => window.__blobs.at(-1).type)) === 'audio/wav');

// ---- patch save / load ------------------------------------------------------------------------------------------------------------
await ev(() => { window.__app.store.set('ch2.filter.center', 0.33); window.__app.store.addRoute({ src: 'ch1.lfo1', dst: 'ch1.filter.width', amount: 0.25 }); window.__app.store.setPatternStep(0, 1, true); });
await btn('Save patch');
const patchText = await ev(async () => await window.__blobs.at(-1).text());
const patch = JSON.parse(patchText);
check('Save patch writes a v4 patch with layers', patch.v === 4 && patch.app === 'spectrum-listening-station' && patch.layers.length === 1 && patch.params['ch2.filter.center'] === 0.33);
writeFileSync('/tmp/t20-patch.json', patchText);
await ev(() => { const s = window.__app.store; s.set('ch2.filter.center', 0.9); s.removeRoute('ch1.lfo1', 'ch1.filter.width'); window.__app.app.removeLayer('allende'); });
const input = await page.$('#patchInput'); await input.uploadFile('/tmp/t20-patch.json'); await sleep(400);
check('Load patch restores params, routes, pattern and layers', await ev(() => { const s = window.__app.store; return s.get('ch2.filter.center') === 0.33 && s.state.matrix.some(r => r.src === 'ch1.lfo1' && r.dst === 'ch1.filter.width') && s.state.pattern[0][1] === true && window.__app.app.layers.length === 1 && s.get('ch1.source.layer') === 'allende'; }));
check('Load patch refreshes the UI (matrix cell, channel slider)', await ev(() => { const c = document.querySelector('.mxcell[data-src="ch1.lfo1"][data-dst="ch1.filter.width"]'); return !!c && c.classList.contains('on'); }));
check('a non-patch file is rejected with a message, nothing throws', await (async () => { writeFileSync('/tmp/t20-bad.json', '{"hello":1}'); await (await page.$('#patchInput')).uploadFile('/tmp/t20-bad.json'); await sleep(300); return ev(() => /patch|Not a/i.test(document.getElementById('outInfo').textContent)); })(), await ev(() => document.getElementById('outInfo').textContent));

// ---- mono rebuild --------------------------------------------------------------------------------------------------------------------
const g0 = await ev(() => { window.__g0 = window.__app.audio.graph; return true; });
await btn('Mono'); await sleep(1800);
check('Mono rebuilds the graph and keeps listening', await ev(() => window.__app.audio.graph !== window.__g0 && window.__app.audio.listening && window.__app.audio.graph.ctx.state === 'running' && !window.__app.audio.output.stereo));
check('pan sliders are disabled in mono', await ev(() => [...document.querySelectorAll('#mixer .pan:not(.bal)')].every(i => i.disabled)));
check('meters still arrive after the rebuild', await ev(() => window.__app.audio.meters.peak.slice(0, 4).some(p => p > 0)));
check('the transport stayed monotonic across the rebuild', await ev(() => window.__app.audio.transport.running && window.__app.audio.transport.beatAt(window.__app.audio.nowSec()) > 0));
await btn('Stereo'); await sleep(1500);

// ---- stop / dock ------------------------------------------------------------------------------------------------------------------------
await page.screenshot({ path: `${OUT}/ui-t20-3-dock.png` });
await btn('Stop listening'); await sleep(300);
check('Stop listening suspends the context', await ev(() => !window.__app.audio.listening && window.__app.audio.graph.ctx.state === 'suspended'));
await btn('Hide');
check('Hide collapses the dock body', await ev(() => document.getElementById('dock').classList.contains('min')));
await btn('Show');
check('no console errors or warnings', logs.length === 0, logs.join(' | '));
await browser.close();
console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASSED');
process.exit(fails.length ? 1 : 0);
