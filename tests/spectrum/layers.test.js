import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UNITS, convertPosition, stageAxisFrom, layerOnStage, profileOnStage } from '../../src/spectrum/layers.js';

const near = (a, b, rel = 1e-9) => assert.ok(Math.abs(a - b) <= rel * Math.max(1, Math.abs(b)), `${a} vs ${b}`);
const ascending = (a) => a.every((v, i) => i === 0 || v > a[i - 1]);

const linesLayer = (lines, axis = { unit: 'nm', x0: 380, x1: 780 }) =>
  ({ id: 'L', name: 'lines', kind: 'lines', quantity: 'intensity', axis, lines });
const sampled = (x, y, unit, extra = {}) =>
  ({ id: 'S', name: 'samp', kind: 'sampled', quantity: 'reflectance', axis: { unit, x0: x[0], x1: x[x.length - 1] }, x, y, ...extra });

test('UNITS list', () => {
  assert.deepEqual(UNITS, ['nm', 'µm', 'Å', 'cm⁻¹', 'Hz', 'GHz', 'x']);
});

test('convertPosition: wavelength family', () => {
  assert.equal(convertPosition(500, 'nm', 'µm'), 0.5);
  assert.equal(convertPosition(500, 'nm', 'Å'), 5000);
  assert.equal(convertPosition(2, 'µm', 'nm'), 2000);
  assert.equal(convertPosition(1, 'µm', 'Å'), 10000);
  assert.equal(convertPosition(7, 'nm', 'nm'), 7);
});

test('convertPosition: nm <-> cm-1 round trip', () => {
  near(convertPosition(500, 'nm', 'cm⁻¹'), 1e7 / 500);
  for (const nm of [100, 450.5, 656.28, 5000]) {
    near(convertPosition(convertPosition(nm, 'nm', 'cm⁻¹'), 'cm⁻¹', 'nm'), nm);
  }
});

test('convertPosition: frequency', () => {
  near(convertPosition(500, 'nm', 'Hz'), 299792458 / 500e-9, 1e-12);
  near(convertPosition(500, 'nm', 'GHz'), 299792458 / 500e-9 / 1e9, 1e-12);
  for (const nm of [100, 500, 656.28, 12000]) {
    near(convertPosition(convertPosition(nm, 'nm', 'Hz'), 'Hz', 'nm'), nm);
    near(convertPosition(convertPosition(nm, 'nm', 'GHz'), 'GHz', 'nm'), nm);
  }
  // cm-1 -> µm: 2000 cm-1 = 5 µm
  near(convertPosition(2000, 'cm⁻¹', 'µm'), 5);
  // cm-1 <-> Hz
  near(convertPosition(1, 'cm⁻¹', 'Hz'), 299792458 * 100);
  near(convertPosition(convertPosition(1234, 'cm⁻¹', 'Hz'), 'Hz', 'cm⁻¹'), 1234);
});

test('convertPosition: null cases', () => {
  assert.equal(convertPosition(500, 'nm', 'x'), null);
  assert.equal(convertPosition(5, 'x', 'nm'), null);
  assert.equal(convertPosition(5, 'x', 'x'), 5);
  assert.equal(convertPosition(NaN, 'nm', 'µm'), null);
  assert.equal(convertPosition(Infinity, 'nm', 'µm'), null);
  assert.equal(convertPosition(0, 'nm', 'cm⁻¹'), null);
  assert.equal(convertPosition(-5, 'nm', 'Hz'), null);
  assert.equal(convertPosition(0, 'cm⁻¹', 'nm'), null);
  assert.equal(convertPosition(-1, 'GHz', 'nm'), null);
  assert.equal(convertPosition(5, 'furlong', 'nm'), null);
});

test('stageAxisFrom copies the axis', () => {
  const l = linesLayer([]);
  const a = stageAxisFrom(l);
  assert.deepEqual(a, { unit: 'nm', x0: 380, x1: 780 });
  a.x0 = 0;
  assert.equal(l.axis.x0, 380);
});

test('layerOnStage: layer outside stage range is null', () => {
  const s = sampled([1000, 1100, 1200], [1, 2, 3], 'nm');
  assert.equal(layerOnStage(s, { unit: 'nm', x0: 400, x1: 700 }), null);
  assert.equal(layerOnStage(linesLayer([{ x: 500, intensity: 1 }], { unit: 'nm', x0: 380, x1: 780 }), { unit: 'nm', x0: 900, x1: 1000 }), null);
});

test('layerOnStage: unconvertible is null', () => {
  const s = sampled([1, 2, 3], [1, 2, 3], 'nm');
  assert.equal(layerOnStage(s, { unit: 'x', x0: 0, x1: 1 }), null);
});

test('layerOnStage: line keeps correct normalised position when zoomed; dropped outside', () => {
  const l = linesLayer([{ x: 656.28, intensity: 1, width: 2, label: 'Hα', type: 'em' }]);
  const full = layerOnStage(l, stageAxisFrom(l));
  near((full.lines[0].x - 380) / 400, (656.28 - 380) / 400);
  const z = { unit: 'nm', x0: 600, x1: 700 };
  const zl = layerOnStage(l, z);
  assert.equal(zl.lines.length, 1);
  near((zl.lines[0].x - z.x0) / (z.x1 - z.x0), (656.28 - 600) / 100);
  assert.equal(zl.lines[0].label, 'Hα');
  assert.equal(zl.lines[0].type, 'em');
  assert.deepEqual(zl.axis, z);
  const out = layerOnStage(l, { unit: 'nm', x0: 400, x1: 500 });
  assert.ok(out === null || out.lines.length === 0);
  assert.ok(out !== null && out.lines.length === 0);
  // original untouched
  assert.equal(l.lines[0].x, 656.28);
});

test('layerOnStage: line widths convert by local derivative', () => {
  const l = linesLayer([{ x: 500, intensity: 1, width: 10 }]);
  const um = layerOnStage(l, { unit: 'µm', x0: 0.4, x1: 0.7 });
  near(um.lines[0].x, 0.5);
  near(um.lines[0].width, 0.01);
  const cm = layerOnStage(l, { unit: 'cm⁻¹', x0: 1e7 / 700, x1: 1e7 / 400 });
  near(cm.lines[0].x, 20000);
  // |d(1e7/x)| * w = 1e7/500^2 * 10 = 400; finite-difference over +-w/2 is close
  assert.ok(Math.abs(cm.lines[0].width - 400) / 400 < 0.01);
  const none = layerOnStage(linesLayer([{ x: 500, intensity: 1 }]), { unit: 'µm', x0: 0.4, x1: 0.7 });
  assert.equal('width' in none.lines[0] && none.lines[0].width !== undefined, false);
});

test('layerOnStage: sampled µm layer on nm stage lands at right nm and ascends; exact edges', () => {
  const x = [0.4, 0.5, 0.6, 0.7, 0.8];
  const y = [0, 10, 20, 30, 40];
  const s = sampled(x, y, 'µm');
  const out = layerOnStage(s, { unit: 'nm', x0: 450, x1: 750 });
  assert.ok(ascending(out.x));
  assert.equal(out.x[0], 450);
  assert.equal(out.x[out.x.length - 1], 750);
  near(out.y[0], 5);
  near(out.y[out.y.length - 1], 35);
  const i = out.x.findIndex(v => Math.abs(v - 500) < 1e-9);
  assert.ok(i > 0);
  near(out.y[i], 10);
  assert.equal(out.x.length, out.y.length);
  assert.deepEqual(out.axis, { unit: 'nm', x0: 450, x1: 750 });
  assert.equal(out.kind, 'sampled');
  assert.deepEqual(s.x, x); // source untouched
});

test('layerOnStage: sampled layer narrower than stage keeps only its own range', () => {
  const s = sampled([500, 600, 700], [1, 2, 3], 'nm');
  const out = layerOnStage(s, { unit: 'nm', x0: 400, x1: 800 });
  assert.deepEqual(out.x, [500, 600, 700]);
});

test('layerOnStage: zooming into a gap between source points interpolates both edges', () => {
  const s = sampled([500, 700], [0, 100], 'nm');
  const out = layerOnStage(s, { unit: 'nm', x0: 550, x1: 650 });
  assert.deepEqual(out.x, [550, 650]);
  near(out.y[0], 25);
  near(out.y[1], 75);
});

test('layerOnStage: cm-1 layer on nm stage is ascending', () => {
  const sig = [10000, 12500, 15000, 20000]; // 1000, 800, 666.7, 500 nm
  const s = sampled(sig, [1, 2, 3, 4], 'cm⁻¹');
  const out = layerOnStage(s, { unit: 'nm', x0: 400, x1: 1200 });
  assert.ok(ascending(out.x));
  near(out.x[0], 500);
  near(out.x[out.x.length - 1], 1000);
  assert.deepEqual(out.y, [4, 3, 2, 1]);
});

test('layerOnStage: unitless layer maps its own range onto the stage', () => {
  const s = sampled([0, 5, 10], [1, 2, 3], 'x');
  const out = layerOnStage(s, { unit: 'nm', x0: 400, x1: 800 });
  assert.deepEqual(out.x, [400, 600, 800]);
  assert.deepEqual(out.y, [1, 2, 3]);
  assert.deepEqual(out.axis, { unit: 'nm', x0: 400, x1: 800 });
  const l = linesLayer([{ x: 5, intensity: 1, width: 1 }], { unit: 'x', x0: 0, x1: 10 });
  const lo = layerOnStage(l, { unit: 'nm', x0: 400, x1: 800 });
  near(lo.lines[0].x, 600);
  near(lo.lines[0].width, 40);
});

test('profileOnStage: single line peaks at its grid position with value = intensity', () => {
  const stage = { unit: 'nm', x0: 0, x1: 511 };
  const l = linesLayer([{ x: 100, intensity: 3 }], { unit: 'nm', x0: 0, x1: 511 });
  const p = profileOnStage(l, stage, 512);
  assert.ok(p instanceof Float64Array && p.length === 512);
  let imax = 0; for (let i = 0; i < p.length; i++) if (p[i] > p[imax]) imax = i;
  assert.equal(imax, 100);
  assert.ok(Math.abs(p[100] - 3) <= 1e-9);
  // off-grid line (0.15 cell off): within 5 %; a 0.5-cell offset at the default 1.5-cell FWHM would sample only 73.5 % of the peak
  const l2 = linesLayer([{ x: 100.15, intensity: 3 }], { unit: 'nm', x0: 0, x1: 511 });
  const p2 = profileOnStage(l2, stage, 512);
  let m = 0; for (const v of p2) if (v > m) m = v;
  assert.ok(Math.abs(m - 3) / 3 <= 0.05, String(m));
});

test('profileOnStage: Gaussian FWHM equals the specified width', () => {
  const stage = { unit: 'nm', x0: 0, x1: 511 }; // cell = 1
  const l = linesLayer([{ x: 250, intensity: 2, width: 20 }], { unit: 'nm', x0: 0, x1: 511 });
  const p = profileOnStage(l, stage, 512);
  const cell = 1, half = 1;
  // first index at/above half height on the left, last on the right
  let lo = 0; while (p[lo] < half) lo++;
  let hi = p.length - 1; while (p[hi] < half) hi--;
  const left = lo - 1 + (half - p[lo - 1]) / (p[lo] - p[lo - 1]);
  const right = hi + (p[hi] - half) / (p[hi] - p[hi + 1]);
  assert.ok(Math.abs((right - left) * cell - 20) <= cell, `${(right - left)}`);
});

test('profileOnStage: default width is 1.5 grid cells; overlapping lines sum', () => {
  const stage = { unit: 'nm', x0: 0, x1: 100 };
  const M = 101; // cell = 1
  const one = profileOnStage(linesLayer([{ x: 50, intensity: 1 }], { unit: 'nm', x0: 0, x1: 100 }), stage, M);
  near(one[51], Math.exp(-4 * Math.LN2 / (1.5 * 1.5)), 1e-9);
  const two = profileOnStage(linesLayer([{ x: 50, intensity: 1 }, { x: 50, intensity: 1 }], { unit: 'nm', x0: 0, x1: 100 }), stage, M);
  near(two[50], 2, 1e-9);
});

test('profileOnStage: sampled interpolates source and is zero outside covered range', () => {
  const s = sampled([200, 300, 400], [1, 3, 1], 'nm');
  const stage = { unit: 'nm', x0: 100, x1: 500 };
  const p = profileOnStage(s, stage, 5); // 100,200,300,400,500
  assert.equal(p[0], 0);
  near(p[1], 1);
  near(p[2], 3);
  near(p[3], 1);
  assert.equal(p[4], 0);
  const p2 = profileOnStage(s, { unit: 'nm', x0: 250, x1: 450 }, 5); // 250,300,350,400,450
  near(p2[0], 2); near(p2[1], 3); near(p2[2], 2); near(p2[3], 1); assert.equal(p2[4], 0);
});

test('profileOnStage: non-overlapping layer gives all zeros', () => {
  const s = sampled([1000, 1100, 1200], [1, 2, 3], 'nm');
  const p = profileOnStage(s, { unit: 'nm', x0: 400, x1: 700 }, 64);
  assert.equal(p.length, 64);
  assert.ok(p.every(v => v === 0));
});
