import test from 'node:test';
import assert from 'node:assert/strict';
import {
  tlRect, phaseToX, xToPhase, valueToY, yToValue, hitEvent, rulerTicks, newEventFrom, moveEvent, removeEvent, nudge,
} from '../../src/ui/timeline-geom.js';

const close = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) <= e, `${a} vs ${b}`);
const R = tlRect(1000, 200);

test('tlRect has fixed margins', () => {
  assert.deepEqual(R, { l: 14, r: 986, t: 24, b: 188, w: 972, h: 164 });
});

test('phase/x mapping is linear and clamps to [0, 0.9999]', () => {
  assert.equal(phaseToX(0, R), 14);
  assert.equal(phaseToX(0.5, R), 500);
  close(xToPhase(500, R), 0.5);
  assert.equal(xToPhase(-50, R), 0);
  assert.equal(xToPhase(5000, R), 0.9999);
  assert.equal(xToPhase(986, R), 0.9999);
});

test('value/y mapping puts 1 at the top and clamps to [0,1]', () => {
  assert.equal(valueToY(1, R), 24);
  assert.equal(valueToY(0, R), 188);
  assert.equal(valueToY(0.5, R), 106);
  close(yToValue(106, R), 0.5);
  assert.equal(yToValue(-10, R), 1);
  assert.equal(yToValue(999, R), 0);
});

test('hitEvent returns the nearest event within tolerance, else -1', () => {
  const ev = [{ t: 0.1, c: 0.5 }, { t: 0.5, c: 0.5 }, { t: 0.52, c: 0.5 }];
  const x = phaseToX(0.5, R), y = valueToY(0.5, R);
  assert.equal(hitEvent(ev, x + 1, y, R), 1);
  assert.equal(hitEvent(ev, phaseToX(0.52, R) - 1, y, R), 2);
  assert.equal(hitEvent(ev, x, y + 40, R), -1);
  assert.equal(hitEvent([ev[1]], x + 11, y, R, 12), 0);
  assert.equal(hitEvent([ev[1]], x + 11, y, R, 5), -1);
  assert.equal(hitEvent([], x, y, R), -1);
  assert.equal(hitEvent([{ t: 0.5 }], x, y, R), -1, 'event without a centre has no node');
});

test('rulerTicks: beats length gives beat numbers, bars for long lengths', () => {
  let t = rulerTicks({ mode: 'beats', div: '1 bar' }, 120, R);
  assert.deepEqual(t.map(x => x.label), ['1', '2', '3', '4']);
  assert.deepEqual(t.map(x => x.phase), [0, 0.25, 0.5, 0.75]);
  t = rulerTicks({ mode: 'beats', div: '4 bars' }, 120, R);
  assert.deepEqual(t.map(x => x.label), ['1', '2', '3', '4']);
  assert.deepEqual(t.map(x => x.phase), [0, 0.25, 0.5, 0.75]);
  t = rulerTicks({ mode: 'beats', div: '16 bars' }, 120, R);
  assert.deepEqual(t.map(x => x.label), ['1', '3', '5', '7', '9', '11', '13', '15']);
  t = rulerTicks({ mode: 'beats', div: '1/4' }, 120, R);
  assert.deepEqual(t.map(x => x.phase), [0, 0.25, 0.5, 0.75]);
});

test('rulerTicks: free lengths label seconds', () => {
  const t = rulerTicks({ mode: 'sec', value: 10 }, 120, R);
  assert.deepEqual(t.map(x => x.label), ['0', '2 s', '4 s', '6 s', '8 s']);
  close(t[1].phase, 0.2);
  const h = rulerTicks({ mode: 'hz', value: 0.5 }, 120, R); // 2 s period
  assert.equal(h[0].label, '0');
  assert.ok(h.length >= 3);
});

test('rulerTicks never yields NaN for hostile lengths', () => {
  for (const len of [null, undefined, { mode: 'hz', value: 'abc' }, { mode: 'sec', value: -1 }, { mode: 'beats', div: 'nope' }, { mode: 'x' }]) {
    const t = rulerTicks(len, NaN, R);
    assert.ok(t.length > 0);
    for (const k of t) assert.ok(Number.isFinite(k.phase) && k.phase >= 0 && k.phase < 1 && typeof k.label === 'string');
  }
});

const fb = { c: 0.5, w: 0.3, s: 0.35, l: 1, z: 0.4, d: 0.5, x: 0.7, y: 0.5, h: 1, q: 0.35 };

test('newEventFrom with no events takes fallback values and the centre', () => {
  const e = newEventFrom({ len: { mode: 'sec', value: 8 }, mode: 'morph', events: [] }, 0.25, 0.8, fb);
  assert.deepEqual(e, { t: 0.25, c: 0.8, w: 0.3, s: 0.35, l: 1, z: 0.4, d: 0.5, x: 0.7, y: 0.5, h: 1, q: 0.35 });
});

test('newEventFrom with events interpolates the other values at that phase and overrides c', () => {
  const tl = { len: { mode: 'sec', value: 8 }, mode: 'morph', events: [{ t: 0, c: 0, w: 0.2, s: 0, l: 0, z: 0, d: 0, x: 0, y: 0, h: 0.5, q: 0 }, { t: 0.5, c: 1, w: 0.6, s: 1, l: 1, z: 1, d: 1, x: 1, y: 1, h: 1, q: 1 }] };
  const e = newEventFrom(tl, 0.25, 0.9, fb);
  assert.equal(e.t, 0.25);
  assert.equal(e.c, 0.9);
  close(e.w, 0.4); close(e.s, 0.5); close(e.h, 0.75);
  const j = newEventFrom({ ...tl, mode: 'jump' }, 0.25, 0.9, fb);
  assert.equal(j.w, 0.2);
});

test('newEventFrom fills keys the events lack from the fallback', () => {
  const tl = { len: { mode: 'sec', value: 8 }, mode: 'morph', events: [{ t: 0, c: 0.1 }, { t: 0.5, c: 0.2 }] };
  const e = newEventFrom(tl, 0.25, 0.3, fb);
  assert.equal(e.w, 0.3);
  assert.equal(e.c, 0.3);
});

test('moveEvent re-sorts and reports the new index; removeEvent drops one', () => {
  const ev = [{ t: 0.1, c: 0.1 }, { t: 0.4, c: 0.4 }, { t: 0.7, c: 0.7 }];
  const m = moveEvent(ev, 0, 0.8, 0.9);
  assert.deepEqual(m.events.map(e => e.t), [0.4, 0.7, 0.8]);
  assert.equal(m.index, 2);
  assert.equal(m.events[2].c, 0.9);
  assert.deepEqual(ev[0], { t: 0.1, c: 0.1 }, 'input untouched');
  const m2 = moveEvent(ev, 2, 2, 0.5);
  assert.equal(m2.events[2].t, 0.9999);
  assert.deepEqual(removeEvent(ev, 1).map(e => e.t), [0.1, 0.7]);
  assert.equal(ev.length, 3);
});

test('nudge steps 0.01 (0.05 with shift) and clamps', () => {
  assert.equal(nudge(0.5, 'ArrowRight', false), 0.51);
  assert.equal(nudge(0.5, 'ArrowLeft', true), 0.45);
  assert.equal(nudge(0.005, 'ArrowLeft', false), 0);
  assert.equal(nudge(0.99, 'ArrowRight', true), 0.9999);
  assert.equal(nudge(0.3, 'a', false), 0.3);
});
