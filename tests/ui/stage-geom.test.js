import test from 'node:test';
import assert from 'node:assert/strict';
import {
  plotRect, uToPx, pxToU, niceStep, axisTicks, windowEdges, hitWindow, dragWindow, wheelWidth, arrowStep,
} from '../../src/ui/stage-geom.js';

const close = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) <= e, `${a} vs ${b}`);
const R = plotRect(1000, 300);

test('plotRect has fixed margins', () => {
  assert.deepEqual(R, { l: 14, r: 986, t: 26, b: 272, w: 972, h: 246 });
});

test('uToPx / pxToU map and clamp', () => {
  assert.equal(uToPx(0, R), 14);
  assert.equal(uToPx(1, R), 986);
  assert.equal(uToPx(0.5, R), 500);
  assert.equal(pxToU(500, R), 0.5);
  assert.equal(pxToU(-50, R), 0);
  assert.equal(pxToU(5000, R), 1);
});

test('niceStep picks 1/2/5/10 times a power of ten', () => {
  assert.equal(niceStep(1), 1);
  assert.equal(niceStep(1.4), 1);
  assert.equal(niceStep(2), 2);
  assert.equal(niceStep(4.9), 5);
  assert.equal(niceStep(8), 10);
  close(niceStep(0.032), 0.02);
  assert.equal(niceStep(45), 50);
  assert.equal(niceStep(320 / 7), 50);
});

test('axisTicks gives nice in-range values with clean labels', () => {
  const t = axisTicks(380, 700, 7);
  assert.deepEqual(t.map(k => k.x), [400, 450, 500, 550, 600, 650, 700]);
  assert.deepEqual(t.map(k => k.label), ['400', '450', '500', '550', '600', '650', '700']);
  const f = axisTicks(0, 1, 5);
  assert.deepEqual(f.map(k => k.label), ['0', '0.2', '0.4', '0.6', '0.8', '1']);
  for (const k of axisTicks(0.1, 0.4, 6)) { assert.ok(!/NaN/.test(k.label)); assert.ok(k.x >= 0.1 - 1e-9 && k.x <= 0.4 + 1e-9); }
  assert.deepEqual(axisTicks(5, 5, 5), []);
  assert.deepEqual(axisTicks(NaN, 5, 5), []);
  assert.deepEqual(axisTicks(0, 1, 0).length > 0, true);
});

test('windowEdges clamps to [0,1]', () => {
  const m = windowEdges(0.5, 0.2); close(m.lo, 0.4); close(m.hi, 0.6);
  const a = windowEdges(0.05, 0.3); assert.equal(a.lo, 0); close(a.hi, 0.2);
  const b = windowEdges(0.95, 0.3); close(b.lo, 0.8); assert.equal(b.hi, 1);
});

const W = (channel, centre, width, enabled = true) => ({ channel, centre, width, enabled });
const tol = 9; // px; 9/972 in u

test('hitWindow: interior move, edge resize, miss', () => {
  const ws = [W(0, 0.5, 0.2)];
  assert.deepEqual(hitWindow(0.5, ws, tol, R), { channel: 0, mode: 'move' });
  assert.deepEqual(hitWindow(0.4, ws, tol, R), { channel: 0, mode: 'resizeL' });
  assert.deepEqual(hitWindow(0.6, ws, tol, R), { channel: 0, mode: 'resizeR' });
  assert.deepEqual(hitWindow(0.405, ws, tol, R), { channel: 0, mode: 'resizeL' });
  assert.deepEqual(hitWindow(0.45, ws, tol, R), { channel: 0, mode: 'move' });
  assert.equal(hitWindow(0.2, ws, tol, R), null);
  assert.equal(hitWindow(0.4 - 10 / 972, ws, tol, R), null);
  // just outside the right edge but inside tolerance still resizes
  assert.deepEqual(hitWindow(0.6 + 8 / 972, ws, tol, R), { channel: 0, mode: 'resizeR' });
});

test('hitWindow: disabled windows are not hit', () => {
  assert.equal(hitWindow(0.5, [W(1, 0.5, 0.2, false)], tol, R), null);
  assert.deepEqual(hitWindow(0.5, [W(1, 0.5, 0.2, false), W(2, 0.5, 0.1)], tol, R), { channel: 2, mode: 'move' });
});

test('hitWindow: edge handle beats an interior, even of a nearer-centre window', () => {
  // A: 0.4..0.6 (centre .5), B: 0.55..0.65 (centre .6). u=0.4 is A's left edge and outside B.
  // u = 0.6: A's right edge, B's interior with centre exactly under u.
  const ws = [W(0, 0.5, 0.2), W(1, 0.6, 0.1)];
  assert.deepEqual(hitWindow(0.6, ws, tol, R), { channel: 0, mode: 'resizeR' });
});

test('hitWindow: overlapping interiors pick the nearest centre; ties go to the lower channel', () => {
  const ws = [W(0, 0.4, 0.4), W(1, 0.6, 0.4)];
  assert.deepEqual(hitWindow(0.45, ws, tol, R), { channel: 0, mode: 'move' });
  assert.deepEqual(hitWindow(0.55, ws, tol, R), { channel: 1, mode: 'move' });
  assert.deepEqual(hitWindow(0.5, ws, tol, R), { channel: 0, mode: 'move' });
});

test('hitWindow: two edges in tolerance pick the nearer edge', () => {
  const ws = [W(0, 0.5, 0.2), W(1, 0.55, 0.1)]; // A right edge .6, B right edge .6 ; B left edge .5
  const a = hitWindow(0.605, [W(0, 0.5, 0.2), W(1, 0.5, 0.22)], tol, R); // A right .6 (d .005), B right .61 (d .005 too)
  assert.equal(a.mode, 'resizeR');
  const b = hitWindow(0.603, [W(0, 0.5, 0.2), W(1, 0.5, 0.22)], tol, R); // A right .6 d .003, B .61 d .007
  assert.deepEqual(b, { channel: 0, mode: 'resizeR' });
  const c = hitWindow(0.608, [W(0, 0.5, 0.2), W(1, 0.5, 0.22)], tol, R);
  assert.deepEqual(c, { channel: 1, mode: 'resizeR' });
  assert.ok(ws.length);
});

test('hitWindow: fully open window has no edge handles but is movable', () => {
  assert.deepEqual(hitWindow(0.001, [W(0, 0.5, 1)], tol, R), { channel: 0, mode: 'move' });
  assert.deepEqual(hitWindow(0.999, [W(0, 0.5, 1)], tol, R), { channel: 0, mode: 'move' });
});

test('dragWindow move keeps the window inside [0,1]', () => {
  const s = { centre: 0.5, width: 0.2 };
  let r = dragWindow(s, 'move', 0.1); close(r.centre, 0.6); close(r.width, 0.2);
  r = dragWindow(s, 'move', 0.9); close(r.centre, 0.9); close(r.width, 0.2);
  r = dragWindow(s, 'move', -0.9); close(r.centre, 0.1);
  r = dragWindow({ centre: 0.5, width: 1 }, 'move', 0.3); close(r.centre, 0.5);
});

test('dragWindow resizeL keeps the right edge fixed', () => {
  const s = { centre: 0.5, width: 0.2 }; // 0.4..0.6
  let r = dragWindow(s, 'resizeL', -0.1); close(r.centre, 0.45); close(r.width, 0.3);
  r = dragWindow(s, 'resizeL', -0.9); close(r.centre, 0.3); close(r.width, 0.6); // left clamped at 0
  r = dragWindow(s, 'resizeL', 0.9); close(r.width, 0.02); close(r.centre + r.width / 2, 0.6); // min width
});

test('dragWindow resizeR keeps the left edge fixed', () => {
  const s = { centre: 0.5, width: 0.2 };
  let r = dragWindow(s, 'resizeR', 0.1); close(r.centre, 0.55); close(r.width, 0.3);
  r = dragWindow(s, 'resizeR', 0.9); close(r.centre, 0.7); close(r.width, 0.6);
  r = dragWindow(s, 'resizeR', -0.9); close(r.width, 0.02); close(r.centre - r.width / 2, 0.4);
});

test('wheelWidth is multiplicative and clamped', () => {
  close(wheelWidth(0.3, 0), 0.3);
  close(wheelWidth(0.3, 100), 0.3 * Math.exp(0.15));
  close(wheelWidth(0.3, -100), 0.3 * Math.exp(-0.15));
  assert.equal(wheelWidth(0.9, 10000), 1);
  assert.equal(wheelWidth(0.05, -10000), 0.02);
});

test('arrowStep', () => {
  assert.deepEqual(arrowStep('ArrowLeft', false), { dCentre: -0.01, widthFactor: 1 });
  assert.deepEqual(arrowStep('ArrowRight', true), { dCentre: 0.05, widthFactor: 1 });
  assert.deepEqual(arrowStep('ArrowUp', false), { dCentre: 0, widthFactor: 1.1 });
  assert.deepEqual(arrowStep('ArrowDown', false), { dCentre: 0, widthFactor: 1 / 1.1 });
  assert.equal(arrowStep('a', false), null);
});
