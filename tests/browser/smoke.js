/*
 * Browser smoke test for the audio layer (Task 15). Writes window.__smoke and sets document.title
 * to 'smoke-done'. Query ?quick=1 shortens the live phases (debugging only).
 *  (a) offline determinism: 5 renders of a 3 s, 4-channel score must hash identically, non-silent
 *  (b) live run: 12 s with the Driver; worklet stats (sum of the 4 channels' mean block time < 1.33 ms),
 *      meters for every enabled strip, no console.error / page error / unhandled rejection
 *  (c) toggling ch3 and ch4 (indices 2, 3) off and on during playback: no exception, their strips meter
 *      0 within 1 s, the others keep sounding; a frame sent to a slept engine does not throw
 */
import { createGraph } from '../../src/audio/graph.js';
import { Driver } from '../../src/audio/driver.js';
import { buildScore } from '../../src/core/score.js';
import { createState, createStore } from '../../src/core/state.js';
import { Transport, timeMap } from '../../src/core/transport.js';
import { analyse } from '../../src/spectrum/analyse.js';
import { EXAMPLE_LAYERS } from '../../src/spectrum/examples.js';

const quick = new URLSearchParams(location.search).has('quick');
const R = { errors: [], offline: null, live: null, toggle: null, pass: false, failures: [] };
window.__smoke = R;

const origError = console.error.bind(console);
console.error = (...a) => { R.errors.push(a.map(String).join(' ')); origError(...a); };
window.addEventListener('error', (e) => R.errors.push(`error: ${e.message}`));
window.addEventListener('unhandledrejection', (e) => R.errors.push(`unhandledrejection: ${e.reason && (e.reason.stack || e.reason)}`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (ok, msg) => { if (!ok) R.failures.push(msg); return ok; };

const LAYER = EXAMPLE_LAYERS[0]; // Allende
const STAGE = { unit: LAYER.axis.unit, x0: LAYER.axis.x0, x1: LAYER.axis.x1 };
const A = analyse(LAYER, STAGE, { polarity: 'dips', sens: 0.2, mode: 'hull' });
const ANALYSES = [A, A, A, A];

function makeState() {
  const s = createState();
  const centers = [0.5, 0.25, 0.6, 0.85];
  for (let c = 0; c < 4; c++) {
    s.params[`ch${c + 1}.filter.on`] = true;
    s.params[`ch${c + 1}.filter.center`] = centers[c];
    s.params[`ch${c + 1}.filter.width`] = 0.3;
  }
  s.params['ch4.filter.type'] = 'granular';
  for (const c of [1, 2]) {         // make sure events occur inside 3 s
    s.params[`ch${c}.event.rpm`] = 60;
    s.params[`ch${c}.event.chance`] = 1;
  }
  return s;
}

const stripsOf = (get) => [0, 1, 2, 3].map((c) => {
  const p = `ch${c + 1}.strip.`;
  return { fader: get(p + 'fader'), pan: get(p + 'pan'), mute: get(p + 'mute'), solo: get(p + 'solo') };
});

function fnv(buf) {
  let h = 0x811c9dc5;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const u = new Uint32Array(buf.getChannelData(c).buffer);
    for (let i = 0; i < u.length; i++) { h ^= u[i]; h = Math.imul(h, 16777619) >>> 0; }
  }
  return h.toString(16).padStart(8, '0');
}

// ---- (a) offline determinism --------------------------------------------------------------------

async function offlineOnce(seed = undefined) {
  const SR = 48000, SEC = 3;
  const ctx = new OfflineAudioContext(2, SR * SEC, SR);
  const g = await createGraph({ live: false, ctx, stereo: true, plain: false, seed });
  const state = makeState();
  const tr = new Transport({ bpm: 120 });
  tr.start(0);
  const tm = timeMap(tr, 0);
  const frames = buildScore({ state, analyses: ANALYSES, stage: STAGE }, { startSec: 0, endSec: SEC, stepSec: 0.025 }, { tm });
  let nFrames = 0, nEvents = 0;
  for (let c = 0; c < 4; c++) for (const fr of frames[c]) { g.channels[c].send(fr); nFrames++; nEvents += fr.events.length; }
  g.mixer.apply(stripsOf((id) => state.params[id]), state.params['g.master.gain'], 0, true);
  await Promise.all(g.channels.map((ch) => ch.flush()));
  const t0 = performance.now();
  const buf = await ctx.startRendering();
  const renderMs = performance.now() - t0;
  let peak = 0;
  for (let c = 0; c < 2; c++) for (const v of buf.getChannelData(c)) { const a = Math.abs(v); if (a > peak) peak = a; }
  await g.dispose();
  return { hash: fnv(buf), peak, nFrames, nEvents, renderMs: Math.round(renderMs) };
}

async function offline() {
  const runs = [];
  for (let i = 0; i < 5; i++) runs.push(await offlineOnce());
  const hashes = runs.map((r) => r.hash);
  const distinct = new Set(hashes).size;
  const variant = await offlineOnce(1); // different synth seeds: the hash must change (comparison not vacuous)
  R.offline = { hashes, distinct, variantHash: variant.hash, peak: runs[0].peak, frames: runs[0].nFrames, events: runs[0].nEvents, renderMs: runs.map((r) => r.renderMs) };
  check(distinct === 1, `offline renders not bit-identical: ${hashes.join(' ')}`);
  check(runs[0].peak > 1e-3, `offline render silent (peak ${runs[0].peak})`);
  check(runs[0].nEvents > 0, 'offline score has no events');
  check(variant.hash !== hashes[0], 'a different seed gave the same hash');
}

// ---- (b) live run and (c) toggling ----------------------------------------------------------------

async function live() {
  const g = await createGraph({ live: true, stereo: true, stats: true });
  await g.ctx.resume();
  const store = createStore(makeState());
  const tr = new Transport({ bpm: 120 });
  tr.start(g.ctx.currentTime);

  const stats = [[], [], [], []];
  g.channels.forEach((ch, c) => ch.onStats((m) => stats[c].push({ calls: m.calls, meanMs: m.meanMs })));
  const meters = [];
  g.mixer.onMeters((m) => meters.push({ at: performance.now(), peak: m.peak, rms: m.rms }));

  const driver = new Driver({ graph: g, store, transport: tr, getAnalyses: () => ANALYSES, getStage: () => STAGE });
  const ctxStart = g.ctx.currentTime, wallStart = performance.now();
  driver.start();
  await sleep(quick ? 4000 : 12000);

  const wallSec = (performance.now() - wallStart) / 1000, ctxSec = g.ctx.currentTime - ctxStart;
  const meanOf = (arr) => {
    let calls = 0, ms = 0;
    for (const s of arr) { calls += s.calls; ms += s.meanMs * s.calls; }
    return calls ? ms / calls : NaN;
  };
  const means = stats.map(meanOf);
  const sumMean = means.reduce((a, b) => a + b, 0);
  const peakMax = [0, 1, 2, 3].map((i) => Math.max(0, ...meters.map((m) => m.peak[i])));
  const rmsMean = [0, 1, 2, 3].map((i) => meters.reduce((a, m) => a + m.rms[i], 0) / Math.max(1, meters.length));
  R.live = {
    sampleRate: g.ctx.sampleRate, baseLatency: g.ctx.baseLatency, wallSec: +wallSec.toFixed(3), ctxSec: +ctxSec.toFixed(3),
    statsMessages: stats.map((s) => s.length), statsCalls: stats.map((s) => s.reduce((a, x) => a + x.calls, 0)),
    meanMsPerChannel: means.map((x) => +x.toFixed(4)), sumMeanMs: +sumMean.toFixed(4),
    meterMessages: meters.length, peakMax: peakMax.map((x) => +x.toFixed(5)), rmsMean: rmsMean.map((x) => +x.toFixed(5)),
  };
  check(ctxSec > wallSec * 0.9, `audio clock lagged: ctx ${ctxSec} s vs wall ${wallSec} s`);
  check(stats.every((s) => s.length >= 2), `too few stats messages: ${stats.map((s) => s.length)}`);
  check(sumMean < 1.33, `sum of mean block times ${sumMean} ms >= 1.33 ms`);
  check(meters.length > 100, `too few meter messages: ${meters.length}`);
  check(peakMax.every((p) => p > 0), `a strip never metered: ${peakMax}`);

  // (c) toggling ch3/ch4 (indices 2 and 3)
  const cycles = [];
  const window_ = (from, to) => meters.filter((m) => m.at >= from && m.at < to);
  const sample = buildScore({ state: store.state, analyses: ANALYSES, stage: STAGE },
    { startSec: g.ctx.currentTime, endSec: g.ctx.currentTime + 0.04, stepSec: 0.04 }, { tm: timeMap(tr, g.ctx.currentTime) });
  let sendToSleptThrew = null;
  const HOLD = quick ? 1200 : 1500;
  for (let k = 0; k < 3; k++) {
    const offAt = performance.now();
    store.set('ch3.filter.on', false);
    store.set('ch4.filter.on', false);
    await sleep(200);
    if (k === 0) {
      try { g.channels[2].send(sample[2][0]); g.channels[3].send(sample[3][0]); sendToSleptThrew = false; } catch (e) { sendToSleptThrew = String(e); }
    }
    await sleep(HOLD - 200);
    const offWin = window_(offAt + 1000, offAt + HOLD);
    const onAt = performance.now();
    store.set('ch3.filter.on', true);
    store.set('ch4.filter.on', true);
    await sleep(HOLD);
    const onWin = window_(onAt + 1000, onAt + HOLD);
    const mx = (win, i) => Math.max(0, ...win.map((m) => m.peak[i]));
    const cyc = {
      offMeters: offWin.length, onMeters: onWin.length,
      offPeak: [0, 1, 2, 3].map((i) => mx(offWin, i)), onPeak: [0, 1, 2, 3].map((i) => mx(onWin, i)),
    };
    cycles.push(cyc);
    check(cyc.offMeters > 0 && cyc.onMeters > 0, `cycle ${k}: no meter messages in a window`);
    check(cyc.offPeak[2] < 1e-6 && cyc.offPeak[3] < 1e-6, `cycle ${k}: disabled strips not silent ${cyc.offPeak}`);
    check(cyc.offPeak[0] > 0 && cyc.offPeak[1] > 0, `cycle ${k}: enabled strips went silent ${cyc.offPeak}`);
    check(cyc.onPeak.every((p) => p > 0), `cycle ${k}: re-enabled strips silent ${cyc.onPeak}`);
  }
  R.toggle = { cycles, sendToSleptThrew };
  check(sendToSleptThrew === false, `send to a slept engine threw: ${sendToSleptThrew}`);

  driver.stop();
  await g.dispose();
}

async function main() {
  try {
    await offline();
    await live();
  } catch (e) {
    R.errors.push(`exception: ${e && (e.stack || e)}`);
  }
  check(R.errors.length === 0, `errors: ${R.errors.join(' | ')}`);
  R.pass = R.failures.length === 0;
  document.getElementById('out').textContent = JSON.stringify(R, null, 2);
  document.title = 'smoke-done';
}

main();
