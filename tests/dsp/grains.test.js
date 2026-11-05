import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GSLOT, grainsAt, windowRmsCoverage, grainRmsCoverage, loudnessMatch } from '../../src/dsp/grains.js';
import { winOne } from '../../src/dsp/window.js';
import { channelView } from '../../src/core/schema.js';
import { createState } from '../../src/core/state.js';

const golden = JSON.parse(readFileSync(new URL('../fixtures/prototype-golden.json', import.meta.url)));
const ch1 = (over = {}) => ({ ...channelView(createState().params, 0), 'filter.type': 'granular', ...over });
const db = x => 20 * Math.log10(x);
const finite = x => typeof x === 'number' && Number.isFinite(x);

/*
 * Brute-force reference: step through time with grainsAt and average the squared combined grain
 * gain a(u,t) = 1 - prod(1 - winOne(u,g)*g3) over a 128-point midpoint u grid and all time steps.
 * The run length is scaled so that roughly `grains` grains are born in total (sparse settings need
 * long runs); dt (scaled down for short grains) is incommensurate with the 1/GSLOT slot so the slot phase is sampled evenly.
 */
const NU = 128;
function simRms(ch, { grains = 2500, seeds = [101, 7, 4242] } = {}) {
  const dt = 0.0937 * Math.min(1, ch['grain.dur'] / 0.6); // several samples per grain lifetime
  const prob = Math.min(1, Math.max(0, 0.2 * 60 ** ch['grain.density'] / GSLOT));
  const T = Math.min(6000, Math.max(150, grains / (prob * GSLOT)));
  const steps = Math.ceil(T / seeds.length / dt);
  let acc = 0, n = 0;
  for (const seed of seeds) {
    for (let i = 0; i < steps; i++) {
      const gr = grainsAt(ch, seed, 5 + i * dt);
      if (!gr.length) { n += NU; continue; }
      for (let j = 0; j < NU; j++) {
        const u = (j + 0.5) / NU;
        let k = 1;
        for (const g of gr) k *= 1 - winOne(u, g[0], g[1], g[2]) * g[3];
        acc += (1 - k) * (1 - k); n++;
      }
    }
  }
  return Math.sqrt(acc / n);
}

test('GSLOT is 12', () => assert.equal(GSLOT, 12));

test('grainsAt matches the prototype golden grains at t=3 (seed 101, defaults)', () => {
  const g = grainsAt(ch1(), 101, 3.0);
  const want = golden.allende.grains;
  assert.equal(g.length, want.length);
  g.forEach((gr, i) => {
    assert.equal(gr.length, 4);
    for (let j = 0; j < 4; j++) assert.ok(Math.abs(gr[j] - want[i][j]) < 1e-12, `grain ${i}[${j}] ${gr[j]} vs ${want[i][j]}`);
  });
});

test('grainsAt with loopSec is exactly periodic', () => {
  for (const over of [{}, { 'grain.speed': 0.3 }, { 'grain.density': 0.9, 'grain.dur': 2.5 }]) {
    const ch = ch1(over);
    for (const L of [8, 10]) {
      for (const t of [0, 0.25, 1.5, 3, 7.75]) {
        const a = grainsAt(ch, 101, t, L), b = grainsAt(ch, 101, t + L, L), c = grainsAt(ch, 101, t + 2 * L, L);
        assert.deepEqual(b, a, `L=${L} t=${t} ${JSON.stringify(over)}`);
        assert.deepEqual(c, a);
      }
    }
  }
  // the loop is not trivially empty
  assert.ok([0.5, 1, 2, 3, 4].some(t => grainsAt(ch1(), 101, t, 8).length > 0));
});

test('grains are stateless: same inputs give the same grains; levels stay in [0,1]', () => {
  const ch = ch1({ 'grain.density': 0.9 });
  assert.deepEqual(grainsAt(ch, 5, 12.3), grainsAt(ch, 5, 12.3));
  for (let t = 0; t < 20; t += 0.37) for (const g of grainsAt(ch, 5, t)) {
    assert.ok(g[0] >= 0 && g[0] <= 1 && g[1] >= 0.004 && g[1] <= 1 && g[3] >= 0 && g[3] <= 1);
  }
});

test('extremes of size, density and width give finite numbers', () => {
  const cases = [
    { 'grain.size': 0 }, { 'grain.size': 1 }, { 'grain.density': 0 }, { 'grain.density': 1 },
    { 'filter.width': 1 }, { 'filter.width': 0.999 }, { 'filter.width': 0.02 }, { 'filter.soft': 0 },
    { 'grain.dur': 0.05 }, { 'grain.dur': 4 }, { 'grain.jitter': 1, 'grain.scatter': 1, 'grain.speed': -0.5 },
    { 'filter.center': 0 }, { 'filter.center': 1, 'grain.speed': 0.5 },
  ];
  for (const over of cases) {
    const ch = ch1(over);
    for (const t of [0, 1.1, 2.9]) for (const g of grainsAt(ch, 101, t)) assert.ok(g.every(finite), JSON.stringify(over));
    const w = windowRmsCoverage(ch), g = grainRmsCoverage(ch), m = loudnessMatch(ch);
    assert.ok(finite(w) && finite(g) && finite(m), `${JSON.stringify(over)}: ${w} ${g} ${m}`);
    assert.ok(g >= 0 && g <= 1 && w >= 0 && w <= 1 && m > 0 && m <= 10, `${JSON.stringify(over)}: ${w} ${g} ${m}`);
  }
  // fully open window passes everything at its level
  assert.ok(Math.abs(windowRmsCoverage(ch1({ 'filter.width': 1, 'filter.level': 0.5 })) - 0.5) < 1e-12);
});

test('loudnessMatch: no grains -> cap (10); silent window -> 1', () => {
  // prob = 0.2*60^density/GSLOT cannot reach 0 inside the schema range; force it to 0
  const none = ch1({ 'grain.density': -1e9 });
  assert.deepEqual(grainsAt(none, 101, 3), []);
  assert.equal(grainRmsCoverage(none), 0);
  assert.equal(loudnessMatch(none), 10);
  const silent = ch1({ 'filter.level': 0 });
  assert.equal(windowRmsCoverage(silent), 0);
  assert.equal(loudnessMatch(silent), 1);
});

test('grainRmsCoverage is seed independent and deterministic', () => {
  const ch = ch1({ 'grain.size': 0.55 });
  assert.equal(grainRmsCoverage(ch, 1), grainRmsCoverage(ch, 999));
  assert.equal(loudnessMatch(ch, 1), loudnessMatch(ch, 999));
});

test('uncached grainRmsCoverage is fast, cached call returns the same number', () => {
  const ch = ch1({ 'filter.center': 0.4321, 'grain.speed': 0.27 }); // unique key, slow path (speed != 0)
  let t0 = performance.now();
  const a = grainRmsCoverage(ch);
  const dt1 = performance.now() - t0;
  assert.ok(dt1 < 50, `uncached ${dt1} ms`);
  t0 = performance.now();
  for (let i = 0; i < 100; i++) assert.equal(grainRmsCoverage({ ...ch }), a);
  const dt2 = (performance.now() - t0) / 100;
  assert.ok(dt2 < 0.5, `cached ${dt2} ms`);
  // keys ignore params the estimator does not depend on
  assert.equal(grainRmsCoverage({ ...ch, 'map.f0': 55, 'strip.pan': 1 }), a);
});

test('cache stays bounded and evicts oldest-first without changing results', () => {
  const first = ch1({ 'filter.center': 0.111 });
  const v = grainRmsCoverage(first);
  for (let i = 0; i < 80; i++) grainRmsCoverage(ch1({ 'filter.center': 0.2 + i / 1000 }));
  assert.equal(grainRmsCoverage(first), v); // recomputed after eviction, same value
});

test('spec 4.1: below the matchable density the +20 dB cap applies exactly', () => {
  for (const over of [{ 'grain.size': 0.2, 'grain.density': 0.1, 'filter.width': 0.6 }, { 'grain.size': 0, 'grain.density': 0 }]) {
    const ch = ch1(over);
    assert.ok(windowRmsCoverage(ch) / grainRmsCoverage(ch) > 10, JSON.stringify(over));
    assert.equal(loudnessMatch(ch), 10);
  }
});

// ---- spec 4.1: granular and equivalent-window RMS agree within ±1 dB ----

/*
 * (1) the estimator is within ±0.6 dB of the simulated grain RMS; (2) the matched grain RMS is
 * within ±1 dB of the window RMS, except where the +20 dB cap binds (then the gain is exactly 10).
 */
function checkMatch(ch) {
  const sim = simRms(ch), est = grainRmsCoverage(ch), win = windowRmsCoverage(ch), G = loudnessMatch(ch);
  const msg = `est-sim ${db(est / sim).toFixed(3)} dB, raw ${db(sim / win).toFixed(2)} dB, G ${G.toFixed(3)}, matched ${db(G * sim / win).toFixed(3)} dB`;
  assert.ok(Math.abs(db(est / sim)) <= 0.6, msg);
  if (win / est >= 10) assert.equal(G, 10, msg);
  else assert.ok(Math.abs(db(G * sim / win)) <= 1, msg);
  return msg + (G === 10 ? ' (cap)' : '');
}

const SIZES = [0.2, 0.4, 0.7], DENS = [0.3, 0.5, 0.8], WIDTHS = [0.15, 0.3, 0.6];

test('spec 4.1: prototype defaults are ~10 dB quiet raw; match gain ~3.3', () => {
  const ch = ch1();
  const sim = simRms(ch), win = windowRmsCoverage(ch), G = loudnessMatch(ch);
  const raw = db(sim / win);
  assert.ok(raw > -12 && raw < -8, `raw deficit ${raw.toFixed(2)} dB`);
  assert.ok(G > 2.9 && G < 3.8, `match gain ${G}`);
  assert.ok(Math.abs(db(G * sim / win)) <= 1);
});

test('spec 4.1: estimator vs simulation and matched level across the grid', () => {
  const rows = [];
  for (const z of SIZES) for (const d of DENS) for (const w of WIDTHS) {
    const ch = ch1({ 'grain.size': z, 'grain.density': d, 'filter.width': w });
    rows.push(`z=${z} d=${d} w=${w}: ${checkMatch(ch)}`);
  }
  if (process.env.GRAIN_TABLE) console.log(rows.join('\n'));
});

test('spec 4.1: drifting playhead and an off-centre region also match within ±1 dB', () => {
  for (const over of [{ 'grain.speed': 0.3 }, { 'filter.center': 0.2 }, { 'filter.center': 0.2, 'grain.speed': -0.3, 'filter.width': 0.6 },
    // grains shorter than a slot, long grains, and narrow hard-edged grains
    { 'grain.dur': 0.05 }, { 'grain.dur': 4, 'grain.speed': 0.5 }, { 'grain.size': 0, 'filter.soft': 0, 'grain.density': 0.8 }]) {
    const msg = `${JSON.stringify(over)}: ${checkMatch(ch1(over))}`;
    if (process.env.GRAIN_TABLE) console.log(msg);
  }
});
