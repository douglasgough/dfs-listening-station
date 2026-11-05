/*
 * The dock (Task 20): four channel strips + master (fader, pan, mute, solo, drone/event balance, VU), capture
 * (record a take of your moves against the transport) and output (mono/stereo, loop length, WAV export, patches).
 *
 * createDock(host, {store, app, audio, panel?}) -> dispose
 */
import { paramDef } from '../core/schema.js';
import { el, formatParam } from './controls.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const toDb = x => 20 * Math.log10(x + 1e-9);
const VU_H = 108, NSEG = 20;

// ---- a vertical fader bound to a numeric store param (port of the prototype's makeFader) -------------------------
function makeFader(host, { store, id, label, tip, onDraw }) {
  const def = paramDef(id), CH = 18;
  const root = el('div', { class: 'fader', tabindex: '0', role: 'slider', 'aria-orientation': 'vertical', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': '1', tip });
  root.append(el('div', { class: 'ftrack' }), el('div', { class: 'fcap' }));
  host.append(root);
  const cap = root.querySelector('.fcap');
  const draw = () => {
    const v = store.get(id);
    cap.style.bottom = (v * ((root.clientHeight || VU_H) - CH)) + 'px';
    root.setAttribute('aria-valuenow', v.toFixed(3)); root.setAttribute('aria-valuetext', formatParam(def, v));
    if (onDraw) onDraw(v);
  };
  const setPos = v => { store.set(id, clamp(v, def.min, def.max)); };
  const fromY = ev => { const b = root.getBoundingClientRect(); return clamp(1 - (ev.clientY - b.top - CH / 2) / ((b.height || VU_H) - CH), 0, 1); };
  let drag = null;
  const L = (t, type, fn, o) => { t.addEventListener(type, fn, o); };
  L(root, 'pointerdown', ev => { if (drag !== null) return; drag = ev.pointerId; try { root.setPointerCapture(ev.pointerId); } catch (e) { /* unavailable */ } root.focus(); setPos(fromY(ev)); });
  L(root, 'pointermove', ev => { if (drag === ev.pointerId) setPos(fromY(ev)); });
  const end = ev => { if (drag === ev.pointerId) drag = null; };
  L(root, 'pointerup', end); L(root, 'pointercancel', end); L(root, 'lostpointercapture', end);
  L(root, 'dblclick', () => setPos(def.default));
  L(root, 'wheel', ev => { ev.preventDefault(); setPos(store.get(id) - ev.deltaY * 0.0005); }, { passive: false });
  L(root, 'keydown', ev => {
    const big = ev.shiftKey ? 0.05 : 0.01, k = ev.key; let hit = true;
    if (k === 'ArrowUp' || k === 'ArrowRight') setPos(store.get(id) + big); else if (k === 'ArrowDown' || k === 'ArrowLeft') setPos(store.get(id) - big);
    else if (k === 'Home') setPos(def.default); else if (k === 'End') setPos(def.max); else hit = false;
    if (hit) ev.preventDefault();
  });
  return { draw, el: root };
}

// ---- meters -------------------------------------------------------------------------------------------------------
const newBar = () => ({ lvl: -90, pk: -90, hold: 0, clip: 0 });
function stepBar(s, rd, dt) {
  const tgt = rd ? toDb(rd[1]) : -90, pk = rd ? toDb(rd[0]) : -90;
  s.lvl = tgt > s.lvl ? s.lvl + (tgt - s.lvl) * Math.min(1, dt / 0.08) : Math.max(tgt, s.lvl - 45 * dt);
  if (pk >= s.pk) { s.pk = pk; s.hold = 1.2; } else { s.hold -= dt; if (s.hold < 0) s.pk = Math.max(pk, s.pk - 25 * dt); }
  s.clip = rd && rd[0] >= 0.999 ? 2.5 : Math.max(0, s.clip - dt);
}
function paintVu(g, w, bars) {
  const bw = bars.length === 1 ? w : (w - 3) / 2;
  g.clearRect(0, 0, w, VU_H);
  bars.forEach((s, b) => {
    const x = b * (bw + 3);
    g.fillStyle = s.clip > 0 ? '#e0907a' : 'rgba(255,255,255,0.07)'; g.fillRect(x, 0, bw, 4);
    const pkSeg = Math.floor((s.pk + 60) / 60 * NSEG);
    for (let k = 0; k < NSEG; k++) {
      const db = -60 + (k + 1) * 3, lit = s.lvl >= db - 3 + 0.01 && s.lvl > -58;
      const col = db > -6 ? '#e0907a' : db > -18 ? '#d0a874' : '#6fbf8a';
      g.fillStyle = lit ? col : (k === pkSeg && s.pk > -58 ? '#e8ecf6' : 'rgba(255,255,255,0.07)');
      g.fillRect(x, 6 + (NSEG - 1 - k) * 5, bw, 4);
    }
  });
}
const readAn = (an, buf) => {
  if (!an) return null;
  an.getFloatTimeDomainData(buf);
  let pk = 0, ss = 0;
  for (let i = 0; i < buf.length; i++) { const a = buf[i], b = a < 0 ? -a : a; if (b > pk) pk = b; ss += a * a; }
  return [pk, Math.sqrt(ss / buf.length)];
};

export function createDock(host, { store, app, audio } = {}) {
  const cleanups = [];
  const root = el('div', { class: 'dockin' });
  const head = el('div', { class: 'dhead' });
  const toggle = el('button', { class: 'btn', type: 'button', id: 'dockToggle', 'aria-expanded': 'true', text: 'Hide', tip: 'Collapse or expand the mixer, capture and output panel.' });
  head.append(el('h2', {}, 'Mixer ', el('small', { text: 'one strip per channel: drone and events together' })), toggle);
  const body = el('div', { class: 'dbody' });
  root.append(head, body);
  host.append(root);
  const L = (t, type, fn, o) => { t.addEventListener(type, fn, o); cleanups.push(() => t.removeEventListener(type, fn, o)); };

  // ---- strips ----------------------------------------------------------------------------------------------------
  const mixer = el('div', { class: 'mixer', id: 'mixer' });
  body.append(mixer);
  const dpr = window.devicePixelRatio || 1;
  const mkCanvas = (cv, w, h) => { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); cv.style.width = w + 'px'; cv.style.height = h + 'px'; const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); return g; };
  const strips = [];
  for (let c = 0; c < 4; c++) {
    const P = k => `ch${c + 1}.strip.${k}`;
    const strip = el('div', { class: 'strip', style: `--c: var(--ch${c + 1})` });
    const name = el('button', { type: 'button', class: 'sname', text: String(c + 1), tip: `Channel ${c + 1}. Click to open its panel.`, style: 'color:var(--c)' });
    const mid = el('div', { class: 'smid' });
    const vu = el('canvas', { class: 'vu', 'aria-hidden': 'true' });
    const fhost = el('div', { class: 'fhost' });
    mid.append(vu, fhost);
    const out = el('output', { class: 'sdb' });
    const pan = el('input', { class: 'pan', type: 'range', min: '-100', max: '100', step: '1', 'aria-label': `Channel ${c + 1} pan`, tip: 'Pan (stereo only). Double-click to centre.' });
    const bal = el('input', { class: 'pan bal', type: 'range', min: '0', max: '100', step: '1', 'aria-label': `Channel ${c + 1} drone and events balance`, tip: 'Balance between the sustained drone (left) and the pings (right). Centre is both at full level.' });
    const btns = el('div', { class: 'sbtns' });
    const bm = el('button', { type: 'button', class: 'bm', text: 'M', 'aria-label': `Mute channel ${c + 1}`, 'aria-pressed': 'false', tip: 'Mute' });
    const bs = el('button', { type: 'button', class: 'bs', text: 'S', 'aria-label': `Solo channel ${c + 1}`, 'aria-pressed': 'false', tip: 'Solo' });
    btns.append(bm, bs);
    strip.append(name, mid, out, pan, bal, btns);
    mixer.append(strip);
    const g = mkCanvas(vu, 14, VU_H);
    const fader = makeFader(fhost, { store, id: P('fader'), label: `Channel ${c + 1} level`, tip: 'Channel level. Double-click for 0 dB.', onDraw: v => { out.textContent = formatParam(paramDef(P('fader')), v); } });
    L(name, 'click', () => app.select(c));
    L(pan, 'input', () => store.set(P('pan'), +pan.value / 100));
    L(pan, 'dblclick', () => store.set(P('pan'), 0));
    L(bal, 'input', () => store.set(P('balance'), +bal.value / 100));
    L(bal, 'dblclick', () => store.set(P('balance'), 0.5));
    L(bm, 'click', () => store.set(P('mute'), !store.get(P('mute'))));
    L(bs, 'click', () => store.set(P('solo'), !store.get(P('solo'))));
    strips.push({ strip, name, fader, pan, bal, bm, bs, vu, g, bar: newBar(), P });
  }
  const master = el('div', { class: 'strip master' });
  const mvu = el('canvas', { class: 'vu', 'aria-hidden': 'true' }), mhost = el('div', { class: 'fhost' }), mout = el('output', { class: 'sdb' });
  master.append(el('span', { class: 'sname', style: 'cursor:default', text: 'Master' }), el('div', { class: 'smid' }, mvu, mhost), mout);
  mixer.append(master);
  const mg = mkCanvas(mvu, 26, VU_H);
  const mfader = makeFader(mhost, { store, id: 'g.master.gain', label: 'Master level', tip: 'Overall output level. Double-click to reset.', onDraw: v => { mout.textContent = formatParam(paramDef('g.master.gain'), v); } });
  const mL = newBar(), mR = newBar();

  function syncMixer() {
    const anySolo = [0, 1, 2, 3].some(c => store.get(strips[c].P('solo')));
    strips.forEach((s, c) => {
      s.fader.draw();
      s.pan.value = String(Math.round(store.get(s.P('pan')) * 100)); s.pan.disabled = !audio.output.stereo;
      s.bal.value = String(Math.round(store.get(s.P('balance')) * 100));
      const m = !!store.get(s.P('mute')), so = !!store.get(s.P('solo'));
      s.bm.classList.toggle('on', m); s.bm.setAttribute('aria-pressed', String(m));
      s.bs.classList.toggle('on', so); s.bs.setAttribute('aria-pressed', String(so));
      s.strip.classList.toggle('dim', m || (anySolo && !so) || !store.get(`ch${c + 1}.filter.on`));
      s.name.classList.toggle('on', c === app.selected);
    });
    mfader.draw();
  }
  cleanups.push(store.subscribe(id => { if (typeof id === 'string' && (id.includes('.strip.') || id === 'g.master.gain' || /^ch\d\.filter\.on$/.test(id))) syncMixer(); }));
  cleanups.push(app.subscribe(syncMixer));
  cleanups.push(audio.on(e => { if (e.type === 'transport') syncMixer(); }));

  // ---- capture ---------------------------------------------------------------------------------------------------
  const cap = el('section', { class: 'mod' });
  cap.append(el('h2', {}, 'Capture ', el('small', { text: 'record your moves' })));
  const r1 = el('div', { class: 'inline' }), r2 = el('div', { class: 'inline' });
  const bRec = el('button', { class: 'btn rec', type: 'button', id: 'btnRec', text: 'Record', tip: 'Start recording your control movements against the transport clock. Nothing before you press this is captured.' });
  const chkCount = el('input', { type: 'checkbox', id: 'chkCount', checked: '' });
  r1.append(bRec, el('label', { tip: 'Wait three seconds after pressing Record before capture begins.' }, chkCount, ' 3 second count-in'));
  const bPlayTake = el('button', { class: 'btn', type: 'button', id: 'btnPlayTake', text: 'Play take', tip: 'Replay your recorded movements from the start of the transport.' });
  const bClear = el('button', { class: 'btn', type: 'button', id: 'btnClear', text: 'Clear take', tip: 'Discard the recorded take.' });
  r2.append(bPlayTake, bClear);
  const takeInfo = el('div', { class: 'status', id: 'takeInfo', role: 'status', 'aria-live': 'polite' });
  cap.append(r1, r2, takeInfo);
  const guard = fn => async (...a) => { try { await fn(...a); } catch (e) { takeInfo.textContent = String(e && e.message || e); } };
  L(bRec, 'click', guard(async () => { if (audio.recording || audio.countingIn) audio.stopRecording(); else await audio.record(chkCount.checked ? 3 : 0); }));
  L(bPlayTake, 'click', guard(async () => { if (audio.playingTake) audio.stopTake(); else await audio.playTake(); }));
  L(bClear, 'click', () => audio.clearTake());
  let takeState = { state: 'none' };
  function syncTake() {
    const s = takeState, t = audio.take;
    const rec = audio.recording, ci = audio.countingIn;
    bRec.classList.toggle('on', rec || ci); bRec.textContent = rec ? 'Stop recording' : ci ? 'Cancel' : 'Record';
    bPlayTake.disabled = !t || rec || ci; bPlayTake.textContent = audio.playingTake ? 'Stop take' : 'Play take';
    bClear.disabled = !t || rec || ci;
    takeInfo.textContent = ci ? `Recording starts in ${s.left}…` : rec ? 'Recording your moves…' : audio.playingTake ? 'Playing the take.' : t ? `Take ready: ${t.dur.toFixed(1)} s` : 'No take yet. Recording starts when you press Record, not before.';
  }
  cleanups.push(audio.on(e => { if (e.type === 'take') { takeState = e; syncTake(); } }));

  // ---- output ----------------------------------------------------------------------------------------------------
  const outp = el('section', { class: 'mod' });
  outp.append(el('h2', {}, 'Output ', el('small', { text: '24-bit, 48 kHz WAV' })));
  const o1 = el('div', { class: 'inline' }), o2 = el('div', { class: 'inline' }), o3 = el('div', { class: 'inline' });
  const chSeg = el('span', { class: 'seg', role: 'group', 'aria-label': 'Channels' });
  const bMono = el('button', { type: 'button', id: 'segMono', text: 'Mono', tip: 'One channel.' });
  const bStereo = el('button', { type: 'button', id: 'segStereo', text: 'Stereo', tip: 'Two channels. Bands are spread by position and noise is decorrelated.' });
  chSeg.append(bMono, bStereo);
  const lenSeg = el('span', { class: 'seg', role: 'group', 'aria-label': 'Loop length unit' });
  const bBars = el('button', { type: 'button', text: 'Bars', tip: 'Loop length in whole bars at the current tempo. Everything repeats without a seam.' });
  const bSecs = el('button', { type: 'button', text: 'Seconds', tip: 'Loop length in seconds.' });
  lenSeg.append(bBars, bSecs);
  const numLen = el('input', { type: 'number', id: 'numLoop', min: '1', max: '300', step: '1', 'aria-label': 'Loop length', style: 'width:72px' });
  o1.append(chSeg, lenSeg, numLen);
  const bExpLoop = el('button', { class: 'btn', type: 'button', id: 'btnExportLoop', text: 'Export loop', tip: 'Render a seamless loop to a WAV file.' });
  const bExpTake = el('button', { class: 'btn', type: 'button', id: 'btnExportTake', text: 'Export take', tip: 'Render your recorded take to a WAV file.' });
  o2.append(bExpLoop, bExpTake);
  const bSave = el('button', { class: 'btn', type: 'button', id: 'btnSavePatch', text: 'Save patch', tip: 'Download everything (settings, matrix, layers) as a patch file.' });
  const bLoad = el('button', { class: 'btn', type: 'button', id: 'btnLoadPatch', text: 'Load patch', tip: 'Load a patch file saved earlier.' });
  const fileIn = el('input', { type: 'file', accept: '.json,application/json', hidden: '', id: 'patchInput' });
  o3.append(bSave, bLoad, fileIn);
  const outInfo = el('div', { class: 'status', id: 'outInfo', role: 'status', 'aria-live': 'polite' });
  outp.append(o1, o2, o3, outInfo);
  const oGuard = fn => async (...a) => { try { await fn(...a); } catch (e) { outInfo.textContent = String(e && e.message || e); } };
  function syncOut() {
    const o = audio.output;
    bMono.classList.toggle('on', !o.stereo); bStereo.classList.toggle('on', o.stereo);
    bMono.setAttribute('aria-pressed', String(!o.stereo)); bStereo.setAttribute('aria-pressed', String(o.stereo));
    bBars.classList.toggle('on', o.synced); bSecs.classList.toggle('on', !o.synced);
    bBars.setAttribute('aria-pressed', String(o.synced)); bSecs.setAttribute('aria-pressed', String(!o.synced));
    if (document.activeElement !== numLen) numLen.value = String(o.synced ? o.bars : o.seconds);
    numLen.max = o.synced ? '64' : '300'; numLen.min = o.synced ? '1' : '2';
    bExpTake.disabled = !audio.take;
  }
  L(bMono, 'click', oGuard(async () => { await audio.setStereo(false); syncOut(); syncMixer(); }));
  L(bStereo, 'click', oGuard(async () => { await audio.setStereo(true); syncOut(); syncMixer(); }));
  L(bBars, 'click', () => { audio.output.synced = true; syncOut(); });
  L(bSecs, 'click', () => { audio.output.synced = false; syncOut(); });
  L(numLen, 'change', () => { const v = +numLen.value; if (audio.output.synced) audio.output.bars = clamp(Math.round(v) || 4, 1, 64); else audio.output.seconds = clamp(v || 8, 2, 300); syncOut(); });
  L(bExpLoop, 'click', oGuard(async () => { bExpLoop.disabled = true; try { await audio.exportLoop(); } finally { bExpLoop.disabled = false; } }));
  L(bExpTake, 'click', oGuard(async () => { bExpTake.disabled = true; try { await audio.exportTake(); } finally { syncOut(); } }));
  L(bSave, 'click', () => { audio.savePatch(); outInfo.textContent = 'Patch downloaded.'; });
  L(bLoad, 'click', () => fileIn.click());
  L(fileIn, 'change', oGuard(async () => {
    const f = fileIn.files && fileIn.files[0]; fileIn.value = '';
    if (!f) return;
    const warnings = audio.loadPatchText(await f.text());
    outInfo.textContent = warnings.length ? `Loaded ${f.name} with ${warnings.length} warning(s): ${warnings[0]}` : `Loaded ${f.name}.`;
    syncMixer(); syncOut();
  }));
  cleanups.push(audio.on(e => { if (e.type === 'take') syncOut(); else if (e.type === 'status') outInfo.textContent = e.text; }));
  body.append(cap, outp);

  // ---- collapse + layout ---------------------------------------------------------------------------------------------
  const dock = host;
  L(toggle, 'click', () => { const min = dock.classList.toggle('min'); toggle.textContent = min ? 'Show' : 'Hide'; toggle.setAttribute('aria-expanded', String(!min)); });
  let ro = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => document.body.style.setProperty('--dockH', dock.offsetHeight + 'px'));
    ro.observe(dock); cleanups.push(() => ro.disconnect());
  }

  // ---- meter loop ---------------------------------------------------------------------------------------------------
  let raf = 0, last = performance.now(), disposed = false;
  const bufL = new Float32Array(1024), bufR = new Float32Array(1024);
  function frame(now) {
    if (disposed) return;
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (!dock.classList.contains('min')) {
      const live = audio.listening, m = audio.meters;
      strips.forEach((s, c) => {
        stepBar(s.bar, live && m.peak[c] !== undefined ? [m.peak[c], m.rms[c]] : null, dt);
        paintVu(s.g, 14, [s.bar]);
      });
      const gr = audio.graph && audio.graph.mixer;
      const l = live && gr ? readAn(gr.analyserL, bufL) : null, r = live && gr ? (audio.output.stereo ? readAn(gr.analyserR, bufR) : l) : null;
      stepBar(mL, l, dt); stepBar(mR, r, dt); paintVu(mg, 26, [mL, mR]);
    }
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  syncMixer(); syncTake(); syncOut();
  return function dispose() {
    disposed = true; cancelAnimationFrame(raf);
    for (const c of cleanups.splice(0)) c();
    root.remove();
  };
}
