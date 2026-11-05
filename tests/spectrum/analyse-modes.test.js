import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyse, applyShift, createAnalysisCache } from '../../src/spectrum/analyse.js';
import { EXAMPLE_LINES, decodeExample } from '../../src/spectrum/examples.js';

const golden = JSON.parse(readFileSync(new URL('../fixtures/prototype-golden.json', import.meta.url), 'utf8'));
const TOL = 1e-9;
const C = 299792.458;

const NM = { unit: 'nm', x0: 400, x1: 800 };
const sampled = (id, x, y, axis, quantity = 'reflectance') =>
  ({ id, name: id, kind: 'sampled', quantity, axis: axis || { unit: 'nm', x0: x[0], x1: x[x.length - 1] }, x, y });
const linesLayer = (lines, axis = NM) => ({ id: 'L', name: 'L', kind: 'lines', quantity: 'intensity', axis, lines });
const allFinite = a => [a.r, a.d, a.gx].every(arr => Array.from(arr).every(Number.isFinite));
const argmax = arr => arr.reduce((bi, v, i) => (v > arr[bi] ? i : bi), 0);

for (const line of EXAMPLE_LINES) {
  const key = line.split('|')[1];
  test(`analyse sampled/hull reproduces golden: ${key}`, () => {
    const sp = decodeExample(line);
    const layer = sampled(key, sp.x, sp.y);
    const got = analyse(layer, { unit: 'nm', x0: sp.x0, x1: sp.x1 }, { polarity: 'dips', sens: 0.2 }).bands;
    const exp = golden.examples[key].bands;
    assert.equal(got.length, exp.length);
    exp.forEach((e, i) => {
      for (const f of ['u', 'depth', 'fwhmU', 'rel']) assert.ok(Math.abs(got[i][f] - e[f]) <= TOL, `${key} ${i} ${f}`);
    });
  });
}

test('analyse returns the documented shape and honours M', () => {
  const sp = decodeExample(EXAMPLE_LINES[0]);
  const a = analyse(sampled('a', sp.x, sp.y), { unit: 'nm', x0: sp.x0, x1: sp.x1 }, { polarity: 'both', sens: 0.2, M: 256 });
  assert.equal(a.r.length, 256);
  assert.equal(a.d.length, 256);
  assert.equal(a.gx.length, 256);
  assert.equal(a.gx[0], sp.x0);
  assert.ok(Math.abs(a.gx[255] - sp.x1) < 1e-9);
  assert.ok(a.dmax > 0);
});

test('direct mode: flat 0.3 layer gives constant d and no bands', () => {
  const x = Array.from({ length: 51 }, (_, i) => 400 + i * 8), y = x.map(() => 0.3);
  const a = analyse(sampled('f', x, y, NM, 'optical-depth'), NM, { polarity: 'dips', sens: 0.2, mode: 'direct' });
  assert.deepEqual(a.bands, []);
  for (const v of a.d) assert.ok(Math.abs(v - 0.3) < 1e-9);
  assert.ok(Math.abs(a.dmax - 0.3) < 1e-9);
  assert.ok(allFinite(a));
});

test('direct mode: uses y as depth, finds the bump, polarity does not change d', () => {
  const x = Array.from({ length: 201 }, (_, i) => 400 + i * 2);
  const y = x.map(v => 0.1 + 0.5 * Math.exp(-0.5 * ((v - 600) / 10) ** 2));
  const L = sampled('g', x, y, NM, 'optical-depth');
  const dips = analyse(L, NM, { polarity: 'dips', sens: 0.2, mode: 'direct' });
  const peaks = analyse(L, NM, { polarity: 'peaks', sens: 0.2, mode: 'direct' });
  assert.deepEqual(Array.from(dips.d), Array.from(peaks.d));
  assert.equal(dips.bands.length, 1);
  assert.ok(Math.abs(dips.bands[0].u - 0.5) < 0.01);
  assert.equal(dips.bands[0].rel, 1);
  assert.ok(Math.abs(dips.dmax - 0.6) < 0.01);
  assert.ok(Math.abs(Math.max(...peaks.r) - 1) < 1e-12);
  assert.ok(Math.abs(Math.min(...dips.r) - 0) < 1e-12);
  assert.ok(Math.abs(Math.max(...dips.r) - (1 - 0.1 / dips.dmax)) < 0.02);
});

// --- lines ---
test('lines: one band per in-range line with exact u, proportional rel, label kept', () => {
  const L = linesLayer([
    { x: 500, intensity: 2, label: 'A' },
    { x: 600, intensity: 4, label: 'B' },
    { x: 900, intensity: 9, label: 'out' },
    { x: 700, intensity: 1 },
  ]);
  const a = analyse(L, NM, { polarity: 'both', sens: 0.9 });
  assert.equal(a.bands.length, 3);
  assert.deepEqual(a.bands.map(b => b.u), [0.25, 0.5, 0.75]);
  assert.deepEqual(a.bands.map(b => b.rel), [0.5, 1, 0.25]);
  assert.deepEqual(a.bands.map(b => b.depth), [2, 4, 1]);
  assert.equal(a.bands[0].label, 'A');
  assert.equal(a.bands[1].label, 'B');
  assert.ok(a.dmax > 2 && a.dmax <= 4); // grid-sampled Gaussian: peak lands between cells
  assert.equal(a.d.length, 512);
  assert.ok(allFinite(a));
});

test('lines: width gives fwhmU; default is 1.5 cells, floored at one cell', () => {
  const L = linesLayer([{ x: 600, intensity: 1, width: 40 }, { x: 700, intensity: 1 }, { x: 500, intensity: 1, width: 0.1 }]);
  const a = analyse(L, NM, { polarity: 'both', sens: 0.2, M: 401 });
  const by = Object.fromEntries(a.bands.map(b => [Math.round(b.u * 400), b]));
  assert.ok(Math.abs(by[200].fwhmU - 0.1) < 1e-12);
  assert.ok(Math.abs(by[300].fwhmU - 1.5 / 400) < 1e-12);
  assert.ok(Math.abs(by[100].fwhmU - 1 / 400) < 1e-12);
});

test('lines: polarity filters by type', () => {
  const L = linesLayer([
    { x: 500, intensity: 1, type: 'abs' },
    { x: 600, intensity: 1, type: 'em' },
    { x: 700, intensity: 1 },
  ]);
  const us = pol => analyse(L, NM, { polarity: pol, sens: 0.2 }).bands.map(b => b.u);
  assert.deepEqual(us('dips'), [0.25, 0.75]);
  assert.deepEqual(us('peaks'), [0.5, 0.75]);
  assert.deepEqual(us('both'), [0.25, 0.5, 0.75]);
});

test('lines: rel is relative to the strongest KEPT line', () => {
  const L = linesLayer([{ x: 500, intensity: 10, type: 'em' }, { x: 600, intensity: 2, type: 'abs' }]);
  const a = analyse(L, NM, { polarity: 'dips', sens: 0.2 });
  assert.equal(a.bands.length, 1);
  assert.equal(a.bands[0].rel, 1);
  assert.ok(a.dmax > 1 && a.dmax <= 2);
});

test('lines: more than 10 keeps the strongest 10, sorted by u', () => {
  const lines = Array.from({ length: 14 }, (_, i) => ({ x: 410 + i * 25, intensity: i === 3 ? 0.01 : i === 9 ? 0.02 : 1 + i }));
  const a = analyse(linesLayer(lines), NM, { polarity: 'both', sens: 0.2 });
  assert.equal(a.bands.length, 10);
  for (let i = 1; i < a.bands.length; i++) assert.ok(a.bands[i].u > a.bands[i - 1].u);
  assert.ok(a.bands.every(b => b.depth >= 1));
  assert.equal(a.bands.filter(b => b.depth === 14).length, 1);
});

test('lines: d peaks at the line, r follows polarity', () => {
  const L = linesLayer([{ x: 600, intensity: 3, width: 20 }]);
  const pk = analyse(L, NM, { polarity: 'peaks', sens: 0.2 });
  const dp = analyse(L, NM, { polarity: 'dips', sens: 0.2 });
  const i = argmax(pk.d);
  assert.ok(Math.abs(i / 511 - 0.5) < 0.003);
  assert.ok(Math.abs(pk.r[i] - 1) < 1e-12 && Math.abs(dp.r[i] - 0) < 1e-12);
});

test('lines on a different unit are converted to the stage', () => {
  const L = linesLayer([{ x: 6000, intensity: 1 }], { unit: 'Å', x0: 4000, x1: 8000 });
  const a = analyse(L, NM, { polarity: 'both', sens: 0.2 });
  assert.equal(a.bands.length, 1);
  assert.ok(Math.abs(a.bands[0].u - 0.5) < 1e-12);
});

// --- RF1: degenerate inputs ---
function assertEmptyish(a, M = 512) {
  assert.deepEqual(a.bands, []);
  assert.ok(a.dmax > 0);
  assert.equal(a.r.length, M); assert.equal(a.d.length, M); assert.equal(a.gx.length, M);
  assert.ok(allFinite(a));
}

test('RF1: constant sampled layer, hull and direct, every polarity', () => {
  const x = Array.from({ length: 60 }, (_, i) => 400 + i * 400 / 59), y = x.map(() => 0.7);
  const L = sampled('c', x, y, NM);
  for (const mode of ['hull', 'direct']) for (const polarity of ['dips', 'peaks', 'both']) {
    assertEmptyish(analyse(L, NM, { polarity, sens: 0.2, mode }));
  }
});

test('RF1: all-zero direct layer', () => {
  const x = Array.from({ length: 60 }, (_, i) => 400 + i * 400 / 59);
  assertEmptyish(analyse(sampled('z', x, x.map(() => 0), NM), NM, { polarity: 'dips', sens: 0.2, mode: 'direct' }));
});

test('RF1: empty line list', () => {
  const a = analyse(linesLayer([]), NM, { polarity: 'both', sens: 0.2 });
  assertEmptyish(a);
  assert.equal(a.dmax, 1e-6);
  assert.ok(a.d.every(v => v === 0) && a.r.every(v => v === 0));
});

test('RF1: layer entirely outside the stage', () => {
  const x = Array.from({ length: 30 }, (_, i) => 1000 + i), y = x.map((v, i) => i % 3);
  for (const mode of ['hull', 'direct']) {
    const a = analyse(sampled('o', x, y), NM, { polarity: 'both', sens: 0.2, mode });
    assertEmptyish(a);
    assert.equal(a.dmax, 1e-6);
    assert.ok(a.r.every(v => v === 0) && a.d.every(v => v === 0));
    assert.equal(a.gx[0], 400); assert.ok(Math.abs(a.gx[511] - 800) < 1e-9);
  }
  assertEmptyish(analyse(linesLayer([{ x: 100, intensity: 1 }], { unit: 'nm', x0: 50, x1: 150 }), NM, { polarity: 'both', sens: 0.2 }));
});

test('RF1: dips on purely-emission lines, and unusable stage/layer', () => {
  const L = linesLayer([{ x: 500, intensity: 1, type: 'em' }, { x: 600, intensity: 2, type: 'em' }]);
  const a = analyse(L, NM, { polarity: 'dips', sens: 0.2 });
  assertEmptyish(a);
  assert.equal(a.dmax, 1e-6);
  assert.doesNotThrow(() => analyse(L, { unit: 'nm', x0: 5, x1: 5 }, { polarity: 'both', sens: 0.2 }));
  assert.doesNotThrow(() => analyse(null, NM, { polarity: 'both', sens: 0.2 }));
  assert.doesNotThrow(() => analyse({ id: 'q', kind: 'weird', axis: NM }, NM, { polarity: 'both', sens: 0.2 }));
});

// --- Task 2 review carry-over: value-checked polarity paths ---
function synth(n = 600) {
  const x = Array.from({ length: n }, (_, i) => 400 + i * 400 / (n - 1));
  const y = x.map((v, i) => {
    const u = i / (n - 1);
    return 0.8 - 0.3 * Math.exp(-0.5 * ((u - 0.3) / 0.02) ** 2) + 0.3 * Math.exp(-0.5 * ((u - 0.7) / 0.02) ** 2);
  });
  return sampled('syn', x, y, NM);
}
const near = (bands, u, tol) => bands.some(b => Math.abs(b.u - u) <= tol);

test('synthetic dip+peak: dips finds the dip only', () => {
  const b = analyse(synth(), NM, { polarity: 'dips', sens: 0.2 }).bands;
  assert.ok(near(b, 0.3, 0.02)); assert.ok(!near(b, 0.7, 0.02));
});
test('synthetic dip+peak: peaks finds the peak only', () => {
  const b = analyse(synth(), NM, { polarity: 'peaks', sens: 0.2 }).bands;
  assert.ok(near(b, 0.7, 0.02)); assert.ok(!near(b, 0.3, 0.02));
});
test('synthetic dip+peak: both finds both', () => {
  const b = analyse(synth(), NM, { polarity: 'both', sens: 0.2 }).bands;
  assert.ok(near(b, 0.3, 0.02)); assert.ok(near(b, 0.7, 0.02));
});
test('synthetic: M 256 gives length 256 with band positions within 1/255 of M 512', () => {
  for (const polarity of ['dips', 'peaks', 'both']) {
    const a = analyse(synth(), NM, { polarity, sens: 0.2, M: 256 });
    const b = analyse(synth(), NM, { polarity, sens: 0.2, M: 512 });
    assert.equal(a.r.length, 256); assert.equal(a.d.length, 256); assert.equal(a.gx.length, 256);
    assert.equal(a.bands.length, b.bands.length);
    a.bands.forEach((band, i) => assert.ok(Math.abs(band.u - b.bands[i].u) <= 1 / 255));
  }
});

// --- applyShift ---
test('applyShift: zero / non-finite velocity is the identity (same object)', () => {
  const a = analyse(linesLayer([{ x: 600, intensity: 1 }]), NM, { polarity: 'both', sens: 0.2 });
  assert.equal(applyShift(a, 0, NM), a);
  assert.equal(applyShift(a, 1e-12, NM), a);
  assert.equal(applyShift(a, NaN, NM), a);
  assert.equal(applyShift(a, Infinity, NM), a);
});

test('applyShift: wavelength stage, +c/100 moves 600 nm to 606 nm; d peak follows; input untouched', () => {
  const a = analyse(linesLayer([{ x: 600, intensity: 1, width: 8 }]), NM, { polarity: 'both', sens: 0.2 });
  const before = { u: a.bands[0].u, d: Array.from(a.d), r: Array.from(a.r) };
  const s = applyShift(a, C / 100, NM);
  assert.notEqual(s, a);
  assert.ok(Math.abs(s.bands[0].u - 206 / 400) < 1e-9);
  assert.equal(a.bands[0].u, before.u);
  assert.deepEqual(Array.from(a.d), before.d);
  assert.deepEqual(Array.from(a.r), before.r);
  const cells = (206 / 400 - 0.5) * 511;
  assert.ok(Math.abs((argmax(s.d) - argmax(a.d)) - cells) <= 1.01);
  assert.equal(s.dmax, a.dmax);
  assert.equal(s.gx, a.gx);
  assert.equal(s.d.length, 512);
  assert.ok(allFinite(s));
});

test('applyShift: negative velocity moves the other way', () => {
  const a = analyse(linesLayer([{ x: 600, intensity: 1 }]), NM, { polarity: 'both', sens: 0.2 });
  const s = applyShift(a, -C / 100, NM);
  assert.ok(Math.abs(s.bands[0].u - (600 * 0.99 - 400) / 400) < 1e-9);
});

test('applyShift: cm-1 stage moves bands down in position for positive velocity', () => {
  const st = { unit: 'cm⁻¹', x0: 1000, x1: 3000 };
  const a = analyse(linesLayer([{ x: 2000, intensity: 1 }], { unit: 'cm⁻¹', x0: 1000, x1: 3000 }), st, { polarity: 'both', sens: 0.2 });
  const s = applyShift(a, C / 100, st);
  const x = st.x0 + s.bands[0].u * 2000;
  assert.ok(Math.abs(x - 2000 / 1.01) < 1e-9);
  assert.ok(s.bands[0].u < a.bands[0].u);
});

test('applyShift: unitless x axis shifts u by beta', () => {
  const st = { unit: 'x', x0: 0, x1: 10 };
  const a = analyse(linesLayer([{ x: 5, intensity: 1 }], { unit: 'x', x0: 0, x1: 10 }), st, { polarity: 'both', sens: 0.2 });
  const s = applyShift(a, C / 10, st);
  assert.ok(Math.abs(s.bands[0].u - 0.6) < 1e-9);
});

test('applyShift: bands pushed out of range are dropped; edges clamp', () => {
  const a = analyse(linesLayer([{ x: 790, intensity: 1 }, { x: 500, intensity: 1 }]), NM, { polarity: 'both', sens: 0.2 });
  const s = applyShift(a, C / 10, NM);
  assert.equal(s.bands.length, 1);
  assert.ok(Math.abs(s.bands[0].u - (550 - 400) / 400) < 1e-9);
  assert.ok(allFinite(s));
  assert.equal(s.d[0], a.d[0]);
});

test('applyShift: non-positive x0 on a multiplicative axis stays finite', () => {
  const st = { unit: 'nm', x0: -100, x1: 100 };
  const a = analyse(linesLayer([{ x: 50, intensity: 1 }], { unit: 'nm', x0: -100, x1: 100 }), st, { polarity: 'both', sens: 0.2 });
  const s = applyShift(a, 1000, st);
  assert.ok(allFinite(s));
  assert.ok(s.bands.every(b => Number.isFinite(b.u) && b.u >= 0 && b.u <= 1));
});

// --- cache ---
test('analysis cache memoises by layer identity and parameters', () => {
  const cache = createAnalysisCache();
  const L = linesLayer([{ x: 600, intensity: 1 }]);
  const o = { polarity: 'both', sens: 0.2, mode: 'hull' };
  const a = cache.get(L, NM, o);
  assert.equal(cache.get(L, { ...NM }, { ...o }), a);
  assert.notEqual(cache.get(L, NM, { ...o, sens: 0.3 }), a);
  assert.notEqual(cache.get(L, NM, { ...o, polarity: 'dips' }), a);
  assert.notEqual(cache.get(L, { unit: 'nm', x0: 400, x1: 900 }, o), a);
  assert.notEqual(cache.get(L, NM, { ...o, mode: 'direct' }), a);
  assert.notEqual(cache.get({ ...L }, NM, o), a);
  cache.clear();
  const b = cache.get(L, NM, o);
  assert.notEqual(b, a);
  assert.equal(cache.get(L, NM, o), b);
});
