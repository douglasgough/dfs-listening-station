import { test } from 'node:test';
import assert from 'node:assert/strict';
import { faderGain, mixGates } from '../../src/audio/mixer.js';

test('faderGain: 0 and anything below 0.005 is silent', () => {
  assert.equal(faderGain(0), 0);
  assert.equal(faderGain(0.004), 0);
  assert.ok(faderGain(0.005) > 0);
});

test('faderGain: 60/66 is 0 dB, 1 is +6 dB', () => {
  assert.ok(Math.abs(faderGain(60 / 66) - 1) < 1e-12);
  assert.ok(Math.abs(faderGain(1) - 10 ** (6 / 20)) < 1e-12);
  assert.ok(Math.abs(faderGain(0.5) - 10 ** ((33 - 60) / 20)) < 1e-15);
});

test('faderGain is monotonic non-decreasing over [0, 1]', () => {
  let prev = -1;
  for (let i = 0; i <= 1000; i++) {
    const g = faderGain(i / 1000);
    assert.ok(g >= prev, `faderGain(${i / 1000}) = ${g} < ${prev}`);
    prev = g;
  }
});

const s = (mute = false, solo = false) => ({ mute, solo });

test('mixGates: no solo, no mute -> all pass', () => {
  assert.deepEqual(mixGates([s(), s(), s(), s()]), [true, true, true, true]);
});

test('mixGates: mute silences only that strip', () => {
  assert.deepEqual(mixGates([s(), s(true), s(), s()]), [true, false, true, true]);
});

test('mixGates: one solo silences the others', () => {
  assert.deepEqual(mixGates([s(), s(false, true), s(), s()]), [false, true, false, false]);
});

test('mixGates: solo on two strips passes both', () => {
  assert.deepEqual(mixGates([s(false, true), s(), s(), s(false, true)]), [true, false, false, true]);
});

test('mixGates: mute wins over solo', () => {
  assert.deepEqual(mixGates([s(true, true), s(), s(false, true), s()]), [false, false, true, false]);
  // the only soloed strip is muted: everything is silent (a solo still excludes the others)
  assert.deepEqual(mixGates([s(true, true), s(), s(), s()]), [false, false, false, false]);
});
