import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildFrame, MAXB, COMB, NK, BAND_AMP, COMB_AMP, NOISE_AMP, ANCHOR_AMP, MASTER,
} from '../../src/dsp/partials.js';
import { grainsAt, loudnessMatch } from '../../src/dsp/grains.js';
import { channelView } from '../../src/core/schema.js';
import { createState } from '../../src/core/state.js';
import { analyse } from '../../src/spectrum/analyse.js';
import { EXAMPLE_LAYERS } from '../../src/spectrum/examples.js';

const golden = JSON.parse(readFileSync(new URL('../fixtures/prototype-golden.json', import.meta.url)));

const allende = EXAMPLE_LAYERS.find(l => l.id === 'allende');
const A = analyse(allende, allende.axis, { polarity: 'dips', sens: 0.2, mode: 'hull' });
const ch1 = (over = {}) => ({ ...channelView(createState().params, 0), ...over });
const opts = (over = {}) => ({ t: 0, seed: 101, ...over });

// Amplitudes are Float32 (and frequencies computed in a different order): compare with a relative tolerance.
const close = (a, b, msg) => assert.ok(Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b)), `${msg || ''} ${a} vs ${b}`);

const ARRAYS = { bandF: 30, bandA: 30, bandPan: 10, combF: 64, combA: 64, noiseF: 20, noiseA: 20, anchorF: 2, anchorA: 2 };
// R28: frequencies are Float64 (whole cycles per loop survive storage), amplitudes and pans Float32.
const F64 = new Set(['bandF', 'combF', 'noiseF', 'anchorF']);

// ---- independent reference formulas (prototype update(), lines 894-942) ----
function hWin(u, c, w, s) {
  if (w >= 0.999) return 1;
  const half = w / 2, d = Math.abs(u - c), inner = half * (1 - s), outer = half * (1 + s) + 1e-6;
  if (d <= inner) return 1;
  if (d >= outer) return 0;
  return 0.5 * (1 + Math.cos(Math.PI * (d - inner) / (outer - inner)));
}
const wWindow = (ch, u) => hWin(u, ch['filter.center'], ch['filter.width'], ch['filter.soft']) * ch['filter.level'];
const wGrains = (grains, u) => { let k = 1; for (const g of grains) k *= 1 - hWin(u, g[0], g[1], g[2]) * g[3]; return 1 - k; };
const interp = (arr, u) => { const p = Math.min(1, Math.max(0, u)) * (arr.length - 1), i = Math.floor(p), j = Math.min(arr.length - 1, i + 1), f = p - i; return arr[i] * (1 - f) + arr[j] * f; };
const refMap = (u, ch) => ch['map.lo'] * Math.pow(ch['map.hi'] / ch['map.lo'], ch['map.flip'] ? 1 - u : u);
const refSnap = (f, ch) => { const f0 = ch['map.f0'], s = ch['map.snap'], h = Math.max(2, Math.round(f / f0)); return Math.exp(Math.log(f) * (1 - s) + Math.log(h * f0) * s); };
const refBandA = (ch, b, w) => {
  const h = Math.max(2, Math.round(refMap(b.u, ch) / ch['map.f0']));
  return Math.pow(0.12 + 0.88 * b.rel, 0.7) / Math.pow(h, 0.3) * ch['drone.bands'] * 0.16 * w;
};

test('constants', () => {
  assert.deepEqual([MAXB, COMB, NK, BAND_AMP, COMB_AMP, NOISE_AMP, ANCHOR_AMP, MASTER], [10, 64, 20, 0.16, 0.05, 0.05, 0.14, 2.0]);
});

test('frame shape: Float32Arrays of the right length, empty events, t passthrough', () => {
  const fr = buildFrame(ch1(), A, opts({ t: 3.5 }));
  assert.equal(fr.t, 3.5);
  assert.deepEqual(fr.events, []);
  for (const [k, n] of Object.entries(ARRAYS)) {
    assert.ok(fr[k] instanceof (F64.has(k) ? Float64Array : Float32Array), k);
    assert.equal(fr[k].length, n, k);
  }
});

test('golden parity: bandF[3i] equals the golden Allende freqs, absent bands are 0', () => {
  assert.equal(A.bands.length, 4);
  const fr = buildFrame(ch1(), A, opts());
  golden.allende.freqs.forEach(({ f }, i) => assert.ok(Math.abs(fr.bandF[3 * i] - f) < 1e-9, `band ${i}: ${fr.bandF[3 * i]} vs ${f}`));
  for (let i = 4; i < MAXB; i++) for (let k = 0; k < 3; k++) {
    assert.equal(fr.bandF[3 * i + k], 0); assert.equal(fr.bandA[3 * i + k], 0);
  }
  for (let i = 4; i < MAXB; i++) assert.equal(fr.bandPan[i], 0);
});

test('band amplitudes and detuned sisters equal an independent hand computation', () => {
  for (const over of [{}, { 'filter.width': 1 }, { 'filter.center': 0.2, 'filter.width': 0.4, 'drone.bands': 0.5, 'drone.beat': 0.9 }]) {
    const ch = ch1(over), fr = buildFrame(ch, A, opts());
    let nonzero = 0;
    A.bands.forEach((b, i) => {
      const w = wWindow(ch, b.u), a = refBandA(ch, b, w);
      close(fr.bandA[3 * i], a, `bandA ${i} ${JSON.stringify(over)}`);
      close(fr.bandA[3 * i + 1], 0.55 * fr.bandA[3 * i], `sister 1 ${i}`);
      close(fr.bandA[3 * i + 2], 0.55 * fr.bandA[3 * i], `sister 2 ${i}`);
      if (a > 0) nonzero++;
      const f = refSnap(refMap(b.u, ch), ch), det = ch['drone.beat'] * (0.04 + 0.5 * Math.min(1, b.fwhmU * 8));
      close(fr.bandF[3 * i], f, `f ${i}`);
      close(fr.bandF[3 * i + 1], f + det, `f+det ${i}`);
      close(fr.bandF[3 * i + 2], Math.max(20, f - 1.5 * det), `f-1.5det ${i}`);
    });
    assert.ok(nonzero >= 1, 'at least one band is inside the window');
  }
  // the fully open window passes every band
  const fr = buildFrame(ch1({ 'filter.width': 1 }), A, opts());
  for (let i = 0; i < 4; i++) assert.ok(fr.bandA[3 * i] > 0);
});

test('comb and noise entries equal hand-computed values', () => {
  for (const over of [{ 'filter.width': 1 }, { 'filter.width': 1, 'drone.combSrc': 'refl' }, {}]) {
    const ch = ch1(over), fr = buildFrame(ch, A, opts());
    for (const j of [0, 31, 63]) {
      const du = (j + 0.5) / 64, f = refSnap(refMap(du, ch), ch);
      const val = ch['drone.combSrc'] === 'refl' ? Math.pow(interp(A.r, du), 1.5) : Math.pow(interp(A.d, du) / A.dmax, 0.8);
      close(fr.combF[j], f, `combF ${j}`);
      close(fr.combA[j], val * ch['drone.comb'] * 0.05 / Math.pow(Math.max(f, 110) / 110, 0.35) * wWindow(ch, du), `combA ${j} ${JSON.stringify(over)}`);
    }
    for (const k of [0, 9, 19]) {
      const du = (k + 0.5) / 20, ff = refMap(du, ch), tilt = (100 / Math.max(ff, 40)) / (1 + Math.pow(ff / 2200, 4));
      close(fr.noiseF[k], ff, `noiseF ${k}`);
      close(fr.noiseA[k], Math.sqrt(interp(A.r, du)) * (1 + 5 * interp(A.d, du) / A.dmax) * tilt * ch['drone.noise'] * 0.05 * wWindow(ch, du), `noiseA ${k}`);
    }
  }
  // the comb sees something somewhere with the default window
  assert.ok(buildFrame(ch1(), A, opts()).combA.some(x => x > 0));
});

test('anchor: 2 and 4 times f0, unwindowed levels', () => {
  const ch = ch1({ 'map.f0': 30, 'drone.anchor': 0.7 }), fr = buildFrame(ch, A, opts());
  close(fr.anchorF[0], 60); close(fr.anchorF[1], 120);
  close(fr.anchorA[0], 0.7 * 0.14); close(fr.anchorA[1], 0.7 * 0.14 * 0.5);
});

test('bandPan: within [-0.8, 0.8], and map.flip mirrors it', () => {
  const a = buildFrame(ch1(), A, opts()), b = buildFrame(ch1({ 'map.flip': true }), A, opts());
  A.bands.forEach((band, i) => {
    assert.ok(a.bandPan[i] >= -0.8 && a.bandPan[i] <= 0.8);
    close(a.bandPan[i], Math.min(0.8, Math.max(-0.8, (band.u - 0.5) * 1.2)), `pan ${i}`);
    close(b.bandPan[i], -a.bandPan[i], `flip ${i}`);
  });
  // u = 0 / 1 pan to -/+0.6; the +-0.8 clamp only bites for u outside [0,1]
  const band = u => ({ u, depth: 1, fwhmU: 0.01, rel: 1 });
  const e = buildFrame(ch1(), { ...A, bands: [band(0), band(1), band(-0.5), band(1.5)] }, opts());
  close(e.bandPan[0], -0.6); close(e.bandPan[1], 0.6); close(e.bandPan[2], -0.8); close(e.bandPan[3], 0.8);
});

const allZero = (fr) => { for (const k of Object.keys(ARRAYS)) for (const x of fr[k]) assert.equal(x, 0, k); };

test('disabled channel: every array exactly zero, match 1, balance passthrough', () => {
  const fr = buildFrame(ch1({ 'filter.on': false, 'strip.balance': 0.3 }), A, opts({ t: 2 }));
  allZero(fr);
  assert.equal(fr.match, 1);
  assert.equal(fr.balance, 0.3);
  assert.equal(fr.t, 2);
  assert.deepEqual(fr.events, []);
});

test('(RF4) analysis === null: zeros, no throw', () => {
  const fr = buildFrame(ch1({ 'filter.type': 'granular' }), null, opts());
  allZero(fr);
  assert.equal(fr.match, 1);
  assert.equal(fr.balance, 0.5);
  assert.deepEqual(fr.events, []);
});

test('(RF1) no bands and a flat profile: every element finite, bandA all zero', () => {
  const M = 512, flat = { r: new Float64Array(M).fill(0.5), d: new Float64Array(M), dmax: 0, bands: [], gx: new Float64Array(M) };
  for (const an of [flat, { ...flat, dmax: 1e-6 }, { ...flat, r: new Float64Array(M) }]) {
    for (const over of [{}, { 'filter.type': 'granular', 'filter.width': 1 }, { 'drone.combSrc': 'refl' }]) {
      const fr = buildFrame(ch1(over), an, opts({ t: 1.3 }));
      for (const k of Object.keys(ARRAYS)) for (const x of fr[k]) assert.ok(Number.isFinite(x), `${k} ${x}`);
      for (const x of fr.bandA) assert.equal(x, 0);
      assert.ok(Number.isFinite(fr.match));
    }
  }
});

test('loopSec: every quantised frequency (band, comb, anchor) has whole cycles per loop, also non-dyadic L', () => {
  for (const L of [8, 12, 48, 60, 7.3]) {
    for (const over of [{ 'map.snap': 0.37, 'map.f0': 31.3 }, { 'filter.width': 1 }, { 'map.hi': 9000, 'map.snap': 0 }]) {
      const fr = buildFrame(ch1(over), A, opts({ loopSec: L }));
      for (const k of ['bandF', 'combF', 'anchorF']) fr[k].forEach((f, i) => {
        assert.ok(Math.abs(f * L - Math.round(f * L)) < 1e-9, `L=${L} ${k}[${i}] ${f} ${JSON.stringify(over)}`);
      });
    }
  }
  // without loopSec the same channel has off-grid frequencies
  const free = buildFrame(ch1({ 'map.snap': 0.37, 'map.f0': 31.3 }), A, opts());
  assert.ok([...free.combF].some(f => Math.abs(f * 8 - Math.round(f * 8)) > 1e-3));
});

test('granular: match is loudnessMatch, bandA follows grainsAt at sec', () => {
  const ch = ch1({ 'filter.type': 'granular', 'filter.width': 1, 'grain.density': 1 }), seed = 101;
  const results = [];
  for (const sec of [2.0, 3.7]) {
    const fr = buildFrame(ch, A, { t: 100, sec, seed });
    assert.equal(fr.match, loudnessMatch(ch, seed));
    const grains = grainsAt(ch, seed, sec, undefined);
    A.bands.forEach((b, i) => close(fr.bandA[3 * i], refBandA(ch, b, wGrains(grains, b.u)), `sec ${sec} band ${i}`));
    results.push([...fr.bandA]);
  }
  assert.notDeepEqual(results[0], results[1]);
  // sec defaults to t
  assert.deepEqual([...buildFrame(ch, A, { t: 2.0, seed }).bandA], results[0]);
  // loopSec is passed on to grainsAt
  const looped = buildFrame(ch, A, { t: 0, sec: 2.0, loopSec: 8, seed });
  const g8 = grainsAt(ch, seed, 2.0, 8);
  A.bands.forEach((b, i) => close(looped.bandA[3 * i], refBandA(ch, b, wGrains(g8, b.u))));
});

test('non-granular match is 1; balance passthrough', () => {
  const fr = buildFrame(ch1({ 'strip.balance': 0.85 }), A, opts());
  assert.equal(fr.match, 1);
  assert.equal(fr.balance, 0.85);
});

test('vertical window (reflectance gate) scales band amplitudes by the independently computed gate', () => {
  const base = ch1({ 'filter.width': 1 }), gated = ch1({ 'filter.width': 1, 'vwin.mode': 1, 'vwin.center': 0.5, 'vwin.height': 0.3 });
  const f0 = buildFrame(base, A, opts()), f1 = buildFrame(gated, A, opts());
  let lowered = 0;
  A.bands.forEach((b, i) => {
    // documented gate: mode 1 windows the reflectance value at u with (center, height, soft)
    const gate = hWin(interp(A.r, b.u), 0.5, 0.3, gated['vwin.soft']);
    close(f1.bandA[3 * i], f0.bandA[3 * i] * gate, `band ${i}`);
    close(f1.bandA[3 * i], refBandA(gated, b, gate), `band ${i} ref`);
    if (gate < 1) { assert.ok(f1.bandA[3 * i] < f0.bandA[3 * i], `band ${i} is attenuated`); lowered++; }
  });
  assert.ok(lowered >= 1);
  // Allende: band 0 (r ~ 0.45) sits inside the gate, bands 2-3 (r ~ 0.78, 0.89) are outside it
  close(f1.bandA[0], f0.bandA[0]);
  assert.equal(f1.bandA[6], 0); assert.equal(f1.bandA[9], 0);
  assert.ok(f0.bandA[6] > 0 && f0.bandA[9] > 0);
});

test('filter.level 0: band/comb/noise amplitudes zero, anchor still sounds', () => {
  const fr = buildFrame(ch1({ 'filter.level': 0, 'filter.width': 1 }), A, opts());
  for (const k of ['bandA', 'combA', 'noiseA']) for (const x of fr[k]) assert.equal(x, 0, k);
  assert.ok(fr.anchorA[0] > 0 && fr.anchorA[1] > 0);
});
