import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Transport, DIVISIONS, timeValuePeriodSec, timeValueCycles } from '../../src/core/transport.js';

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg || ''} ${a} !== ${b}`);

test('defaults: bpm 120, stopped, internal source, position 0', () => {
  const t = new Transport();
  assert.equal(t.bpm, 120);
  assert.equal(t.running, false);
  assert.equal(t.source, 'internal');
  assert.equal(t.beatAt(10), 0);
  assert.equal(t.secondsAt(10), 0);
});

test('constructor bpm is honoured and clamped to [20,300]', () => {
  assert.equal(new Transport({ bpm: 90 }).bpm, 90);
  assert.equal(new Transport({ bpm: 5 }).bpm, 20);
  assert.equal(new Transport({ bpm: 999 }).bpm, 300);
});

test('at 120 bpm after start(0), beatAt(1) === 2', () => {
  const t = new Transport({ bpm: 120 });
  t.start(0);
  assert.equal(t.running, true);
  assert.equal(t.beatAt(1), 2);
  assert.equal(t.secondsAt(1), 1);
});

test('stop holds position; beatAt/secondsAt frozen while stopped', () => {
  const t = new Transport({ bpm: 120 });
  t.start(0);
  t.stop(1);
  assert.equal(t.running, false);
  assert.equal(t.beatAt(5), 2);
  assert.equal(t.secondsAt(5), 1);
});

test('restart resumes from held position', () => {
  const t = new Transport({ bpm: 120 });
  t.start(0);
  t.stop(1);
  t.start(10);
  assert.equal(t.beatAt(11), 4);
  assert.equal(t.secondsAt(11), 2);
});

test('start while running and stop while stopped are no-ops', () => {
  const t = new Transport({ bpm: 120 });
  t.start(0);
  t.start(1);
  assert.equal(t.beatAt(2), 4);
  t.stop(2);
  t.stop(3);
  assert.equal(t.beatAt(9), 4);
});

test('locate(8, 0) then beatAt(0.5) === 9 while running', () => {
  const t = new Transport({ bpm: 120 });
  t.start(0);
  t.locate(8, 0);
  assert.equal(t.beatAt(0.5), 9);
});

test('locate while stopped sets the held position and seconds at current bpm', () => {
  const t = new Transport({ bpm: 120 });
  t.locate(8, 3);
  assert.equal(t.beatAt(100), 8);
  assert.equal(t.secondsAt(100), 4);
  t.start(100);
  assert.equal(t.beatAt(101), 10);
  assert.equal(t.secondsAt(101), 5);
});

test('setBpm mid-run keeps the beat position continuous', () => {
  const t = new Transport({ bpm: 120 });
  t.start(0);
  t.setBpm(60, 2);               // beat 4 at t=2
  assert.equal(t.bpm, 60);
  assert.equal(t.beatAt(2), 4);
  assert.equal(t.beatAt(3), 5);  // 1 beat/sec now
  assert.equal(t.secondsAt(3), 3); // seconds independent of bpm
});

test('setBpm without nowSec uses the last known time', () => {
  const t = new Transport({ bpm: 120 });
  t.start(0);
  assert.equal(t.beatAt(2), 4);  // observes time 2
  t.setBpm(60);
  assert.equal(t.beatAt(2), 4);
  assert.equal(t.beatAt(4), 6);
});

test('setBpm clamps to [20,300]', () => {
  const t = new Transport();
  t.setBpm(1);
  assert.equal(t.bpm, 20);
  t.setBpm(1000);
  assert.equal(t.bpm, 300);
});

test('setBpm while stopped changes tempo without moving position', () => {
  const t = new Transport({ bpm: 120 });
  t.locate(4, 0);
  t.setBpm(60, 5);
  assert.equal(t.beatAt(9), 4);
  t.start(9);
  assert.equal(t.beatAt(10), 5);
});

test('snapshot returns {bpm}; source is a plain settable property', () => {
  const t = new Transport({ bpm: 133 });
  assert.deepEqual(t.snapshot(), { bpm: 133 });
  t.source = 'midi';
  assert.equal(t.source, 'midi');
});

test('DIVISIONS: plain, bar, dotted and triplet values', () => {
  assert.equal(DIVISIONS['1/32'], 0.125);
  assert.equal(DIVISIONS['1/16'], 0.25);
  assert.equal(DIVISIONS['1/8'], 0.5);
  assert.equal(DIVISIONS['1/4'], 1);
  assert.equal(DIVISIONS['1/2'], 2);
  assert.equal(DIVISIONS['1 bar'], 4);
  assert.equal(DIVISIONS['2 bars'], 8);
  assert.equal(DIVISIONS['4 bars'], 16);
  assert.equal(DIVISIONS['8 bars'], 32);
  assert.equal(DIVISIONS['16 bars'], 64);
  for (const x of ['1/16', '1/8', '1/4', '1/2']) {
    near(DIVISIONS[x + 'd'], DIVISIONS[x] * 1.5, x + 'd');
    near(DIVISIONS[x + 't'], DIVISIONS[x] * 2 / 3, x + 't');
  }
  near(DIVISIONS['1/8d'], 0.75);
  near(DIVISIONS['1/8t'], 1 / 3);
  assert.equal(DIVISIONS['1/32d'], undefined);
  assert.equal(DIVISIONS['1 bard'], undefined);
});

test('timeValuePeriodSec: beats mode follows tempo', () => {
  assert.equal(timeValuePeriodSec({ mode: 'beats', div: '1/4' }, 120), 0.5);
  assert.equal(timeValuePeriodSec({ mode: 'beats', div: '4 bars' }, 120), 8);
  assert.equal(timeValuePeriodSec({ mode: 'beats', div: '1/4' }, 60), 1);
});

test('timeValuePeriodSec: hz and sec ignore bpm', () => {
  assert.equal(timeValuePeriodSec({ mode: 'hz', value: 0.1 }, 120), 10);
  assert.equal(timeValuePeriodSec({ mode: 'hz', value: 0.1 }, 60), 10);
  assert.equal(timeValuePeriodSec({ mode: 'hz', value: 4 }, 200), 0.25);
  assert.equal(timeValuePeriodSec({ mode: 'sec', value: 3 }, 77), 3);
});

test("timeValuePeriodSec: '1/8d' is 1.5x '1/8'; '1/8t' is 2/3x", () => {
  const p = timeValuePeriodSec({ mode: 'beats', div: '1/8' }, 120);
  near(timeValuePeriodSec({ mode: 'beats', div: '1/8d' }, 120), p * 1.5);
  near(timeValuePeriodSec({ mode: 'beats', div: '1/8t' }, 120), p * 2 / 3);
});

test('timeValuePeriodSec guards: bad values fall back to 10 s, never NaN/Infinity/throw', () => {
  for (const tv of [
    { mode: 'hz', value: 0 }, { mode: 'hz', value: -1 }, { mode: 'hz', value: NaN },
    { mode: 'hz', value: Infinity }, { mode: 'hz' }, { mode: 'hz', value: '2' },
    { mode: 'sec', value: 0 }, { mode: 'sec', value: -3 }, { mode: 'sec', value: NaN },
    { mode: 'sec', value: Infinity },
    { mode: 'beats', div: 'nope' }, { mode: 'beats' }, { mode: 'beats', div: 'toString' },
    { mode: 'weird', value: 2 }, {}, null, undefined,
  ]) {
    assert.equal(timeValuePeriodSec(tv, 120), 10, JSON.stringify(tv));
  }
});

test('timeValuePeriodSec guards: bad bpm is treated as 120', () => {
  const tv = { mode: 'beats', div: '1/4' };
  for (const bpm of [0, -5, NaN, Infinity, undefined, null, 'x']) {
    assert.equal(timeValuePeriodSec(tv, bpm), 0.5, String(bpm));
  }
});

test('timeValueCycles: beats uses beat, free uses sec', () => {
  const t = { beat: 8, sec: 3 };
  assert.equal(timeValueCycles({ mode: 'beats', div: '1/4' }, t), 8);
  assert.equal(timeValueCycles({ mode: 'beats', div: '1 bar' }, t), 2);
  near(timeValueCycles({ mode: 'beats', div: '1/8t' }, t), 24);
  assert.equal(timeValueCycles({ mode: 'hz', value: 2 }, t), 6);
  assert.equal(timeValueCycles({ mode: 'sec', value: 1.5 }, t), 2);
});

test('timeValueCycles guards: bad values use 10 s fallback on sec, never NaN/Infinity', () => {
  const t = { beat: 8, sec: 5 };
  for (const tv of [
    { mode: 'hz', value: 0 }, { mode: 'hz', value: -2 }, { mode: 'hz', value: NaN },
    { mode: 'sec', value: 0 }, { mode: 'sec', value: -1 }, { mode: 'sec', value: Infinity },
    { mode: 'beats', div: 'nope' }, { mode: 'weird' }, null, undefined,
  ]) {
    assert.equal(timeValueCycles(tv, t), 0.5, JSON.stringify(tv));
  }
});
