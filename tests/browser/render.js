/*
 * Browser verification of the offline render (Task 16). Writes window.__render, title 'render-done'.
 *  (a) 4-bar synced loop @120 bpm stereo: 384000 samples, non-silent, seamless (last->first step < 0.05,
 *      first/last 10 ms RMS within 3 dB)
 *  (b) 3 renders of the same project hash identically
 *  (c) take render with a recordChange (ch1..4 drone.bands 0 -> .8 at 2 s), dur 5 s
 *  (d) free-mode loop 6 s = 288000 samples
 *  (e) timing of a 48 s loop render
 */
import { renderOffline } from '../../src/audio/render.js';
import { createState } from '../../src/core/state.js';
import { recordChange } from '../../src/core/score.js';
import { analyse } from '../../src/spectrum/analyse.js';
import { EXAMPLE_LAYERS } from '../../src/spectrum/examples.js';

const R = { errors: [], failures: [], pass: false };
window.__render = R;
const origError = console.error.bind(console);
console.error = (...a) => { R.errors.push(a.map(String).join(' ')); origError(...a); };
window.addEventListener('error', (e) => R.errors.push(`error: ${e.message}`));
window.addEventListener('unhandledrejection', (e) => R.errors.push(`unhandledrejection: ${e.reason && (e.reason.stack || e.reason)}`));
const check = (ok, msg) => { if (!ok) R.failures.push(msg); return ok; };

const LAYER = EXAMPLE_LAYERS[0];
const STAGE = { unit: LAYER.axis.unit, x0: LAYER.axis.x0, x1: LAYER.axis.x1 };
const A = analyse(LAYER, STAGE, { polarity: 'dips', sens: 0.2, mode: 'hull' });
const project = (state) => ({ state, analyses: [A, A, A, A], stage: STAGE });

function loopState() {
  const s = createState();
  const centers = [0.5, 0.25, 0.6, 0.85];
  for (let c = 0; c < 4; c++) {
    s.params[`ch${c + 1}.filter.on`] = true;
    s.params[`ch${c + 1}.filter.center`] = centers[c];
    s.params[`ch${c + 1}.filter.width`] = 0.3;
  }
  s.params['ch4.filter.type'] = 'granular';
  for (const c of [1, 2]) { s.params[`ch${c}.event.rpm`] = 60; s.params[`ch${c}.event.chance`] = 1; }
  s.timelines[1] = { len: { mode: 'beats', div: '1 bar' }, mode: 'morph',
    events: [{ t: 0, c: 0.3, w: 0.3 }, { t: 0.5, c: 0.7, w: 0.3 }] };
  s.matrix.push({ src: 'g.lfo1', dst: 'ch1.filter.center', amount: 0.3 });
  return s;
}

function fnv(chans) {
  let h = 0x811c9dc5;
  for (const d of chans) {
    const u = new Uint32Array(d.buffer, d.byteOffset, d.length);
    for (let i = 0; i < u.length; i++) { h ^= u[i]; h = Math.imul(h, 16777619) >>> 0; }
  }
  return h.toString(16).padStart(8, '0');
}
const rmsOf = (d, a, b) => { let s = 0; for (let i = a; i < b; i++) s += d[i] * d[i]; return Math.sqrt(s / (b - a)); };
const db = (x) => 20 * Math.log10(x);

async function main() {
  const SR = 48000, N10 = 480;
  // (a)
  const loop = await renderOffline(project(loopState()), 'loop', { stereo: true, synced: true, bars: 4, bpm: 120 });
  const per = loop.chans.map((d, c) => {
    const first = rmsOf(d, 0, N10), last = rmsOf(d, d.length - N10, d.length);
    let maxStep = 0;
    for (let i = 1; i < d.length; i++) maxStep = Math.max(maxStep, Math.abs(d[i] - d[i - 1]));
    return { first, last, diffDb: first > 0 && last > 0 ? db(last / first) : null, wrapStep: Math.abs(d[0] - d[d.length - 1]), maxAdjacentStep: maxStep };
  });
  R.loop = { length: loop.chans[0].length, lengthSec: loop.lengthSec, peak: loop.peak, rms: loop.rms, per };
  check(loop.chans.length === 2 && loop.chans[0].length === 384000, `loop length ${loop.chans[0].length}`);
  check(loop.rms > 1e-3 && loop.peak > 1e-3, 'loop silent');
  per.forEach((p, c) => {
    check(p.wrapStep < 0.05, `ch${c} wrap step ${p.wrapStep}`);
    check(p.diffDb !== null && Math.abs(p.diffDb) <= 3, `ch${c} start/end rms diff ${p.diffDb} dB`);
  });

  // (b)
  const hashes = [fnv(loop.chans)];
  for (let i = 0; i < 2; i++) hashes.push(fnv((await renderOffline(project(loopState()), 'loop', { stereo: true, synced: true, bars: 4, bpm: 120 })).chans));
  R.determinism = { hashes, distinct: new Set(hashes).size };
  check(R.determinism.distinct === 1, `hashes differ ${hashes}`);

  // (c)
  const s = createState();
  for (let c = 1; c <= 4; c++) {
    s.params[`ch${c}.filter.on`] = true; s.params[`ch${c}.drone.bands`] = 0; s.params[`ch${c}.event.chance`] = 0;
    for (const k of ['comb', 'noise', 'anchor']) s.params[`ch${c}.drone.${k}`] = 0;
  }
  const take = { dur: 5, bpm: 120, events: [] };
  for (let c = 1; c <= 4; c++) recordChange(take, 2, `ch${c}.drone.bands`, 0.8);
  const tk = await renderOffline(project(s), 'take', { stereo: true, take, fadeSec: 0.5 });
  const d = tk.chans[0], expectLen = Math.round(tk.lengthSec * SR);
  const early = rmsOf(d, 0, Math.round(1.5 * SR)), late = rmsOf(d, 3 * SR, 5 * SR);
  R.take = { length: d.length, lengthSec: tk.lengthSec, peak: tk.peak, rms: tk.rms, earlyRms: early, lateRms: late,
    earlyVsLateDb: db(early / late), first: d[0], last: d[d.length - 1], firstAbs: Math.max(...Array.from(d.slice(0, 8), Math.abs)), lastAbs: Math.max(...Array.from(d.slice(-8), Math.abs)) };
  check(d.length === expectLen && Math.abs(d.length - (5 + 4.83) * SR) < 2, `take length ${d.length}`);
  check(late > 0 && (early === 0 || db(late / early) > 6), `take early/late ${db(late / early)} dB`);
  check(Math.abs(d[0]) < 1e-3 && Math.abs(d[d.length - 1]) < 1e-3, 'take ends not faded');

  // (d)
  const free = await renderOffline(project(loopState()), 'loop', { stereo: false, synced: false, seconds: 6 });
  R.free = { length: free.chans[0].length, channels: free.chans.length, peak: free.peak };
  check(free.chans[0].length === 288000 && free.chans.length === 1, `free loop ${free.chans[0].length}`);

  // (e)
  const t0 = performance.now();
  const big = await renderOffline(project(loopState()), 'loop', { stereo: true, synced: false, seconds: 48 });
  R.perf48 = { ms: Math.round(performance.now() - t0), length: big.chans[0].length };
  check(big.chans[0].length === 48 * SR, 'perf loop length');
}

main().catch((e) => R.errors.push(`exception: ${e && (e.stack || e)}`)).finally(() => {
  check(R.errors.length === 0, `errors: ${R.errors.join(' | ')}`);
  R.pass = R.failures.length === 0;
  document.getElementById('out').textContent = JSON.stringify(R, null, 2);
  document.title = 'render-done';
});
