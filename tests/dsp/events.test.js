import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evTimes, eventSpec, pickEvent, PING } from '../../src/dsp/events.js';
import { channelView } from '../../src/core/schema.js';
import { createState } from '../../src/core/state.js';

const golden = JSON.parse(readFileSync(new URL('../fixtures/prototype-golden.json', import.meta.url)));
const mulberry32 = a => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
const tm120 = { bpm: 120, beatAt: s => s * 2 };
const base = { mode: 'regular', rpm: 6, interval: { mode: 'beats', div: '1/4' }, jitter: 0, steps: 4, stepLen: { mode: 'beats', div: '1/4' }, pattern: [true, false, true, false] };

test('regular beats grid at 120 bpm', () => {
  const t = evTimes(base, 0, 2, Math.random, tm120);
  assert.equal(t.length, 4);
  [0.5, 1, 1.5, 2].forEach((x, i) => near(t[i], x));
});

test('regular beats grid follows a beat offset', () => {
  const tm = { bpm: 120, beatAt: s => s * 2 + 0.25 };
  const t = evTimes(base, 0, 2, Math.random, tm);
  // beats in (0.25, 4.25]: 1,2,3,4 -> seconds (b-.25)*.5
  assert.equal(t.length, 4);
  [0.375, 0.875, 1.375, 1.875].forEach((x, i) => near(t[i], x));
});

test('regular jitter uses one rnd per event, as a share of the interval', () => {
  const t = evTimes({ ...base, jitter: 0.5 }, 0, 2, () => 0.5, tm120);
  [0.5, 1, 1.5, 2].forEach((x, i) => near(t[i], x + 0.125));
});

test('pattern mode honours the pattern with prototype step indexing', () => {
  // steps m=1..4, pattern[m % 4] = [1,0,1,0] -> m=2 and m=4 fire (beats 2, 4 = 1 s, 2 s)
  const t = evTimes({ ...base, mode: 'pattern' }, 0, 2, Math.random, tm120);
  assert.equal(t.length, 2);
  near(t[0], 1); near(t[1], 2);
});

test('hz and sec periods use the seconds domain', () => {
  const ev = { ...base, interval: { mode: 'hz', value: 0.5 } };
  assert.deepEqual(evTimes(ev, 0, 7, Math.random, tm120), [2, 4, 6]);
  const ev2 = { ...base, mode: 'pattern', stepLen: { mode: 'sec', value: 0.5 } };
  // m=1..4, pattern[m%4]: m=2 (1s), m=4 (2s)
  assert.deepEqual(evTimes(ev2, 0, 2, Math.random, tm120), [1, 2]);
});

test('invalid time value falls back to the 10 s period', () => {
  const ev = { ...base, interval: { mode: 'beats', div: 'nope' } };
  assert.deepEqual(evTimes(ev, 0, 25, Math.random, tm120), [10, 20]);
});

test('random mode is reproducible and its count is near rpm/60 * span', () => {
  const ev = { ...base, mode: 'random', rpm: 30 };
  const a = evTimes(ev, 0, 2000, mulberry32(7), tm120), b = evTimes(ev, 0, 2000, mulberry32(7), tm120);
  assert.deepEqual(a, b);
  const mean = 30 / 60 * 2000, sigma = Math.sqrt(mean);
  assert.ok(Math.abs(a.length - mean) < 3 * sigma, `count ${a.length} vs ${mean}`);
  assert.ok(a.every((x, i) => x > 0 && x <= 2000 && (i === 0 || x >= a[i - 1])));
});

test('eventSpec builds the view from a channel', () => {
  const ch = channelView(createState().params, 0);
  const pat = new Array(16).fill(false);
  const s = eventSpec(ch, pat);
  assert.equal(s.mode, 'random');
  assert.equal(s.rpm, 6);
  assert.deepEqual(s.interval, { mode: 'beats', div: '1/4' });
  assert.equal(s.steps, 8);
  assert.equal(s.pattern, pat);
});

// ---- pickEvent ----
const analysis = { r: new Float64Array(8).fill(1), d: new Float64Array(8), dmax: 1, bands: golden.examples.Allende.bands };
const chPick = (over = {}) => ({ ...channelView(createState().params, 0), 'filter.width': 1, 'event.octave': 1, ...over });

test('pickEvent: null without bands or when the window is away', () => {
  assert.equal(pickEvent(chPick(), null, Math.random), null);
  assert.equal(pickEvent(chPick(), { ...analysis, bands: [] }, Math.random), null);
  // window narrow at 0.99 passes none of the bands (nearest .8376, outer edge ~.0125)
  assert.equal(pickEvent(chPick({ 'filter.center': 0.99, 'filter.width': 0.02, 'filter.soft': 0 }), analysis, Math.random), null);
  assert.equal(pickEvent(chPick({ 'filter.on': false }), analysis, Math.random), null);
});

test('pickEvent reproduces the prototype frequency for Allende band 0 at octave 1', () => {
  // narrow hard window on band 0 only
  const ch = chPick({ 'filter.center': golden.allende.freqs[0].u, 'filter.width': 0.04, 'filter.soft': 0 });
  const e = pickEvent(ch, analysis, () => 0.5);
  assert.equal(e.bandIndex, 0);
  near(e.f, golden.allende.freqs[0].f * 2);
  const rel = golden.examples.Allende.bands[0].rel;
  near(e.amp, PING * 0.6 * Math.sqrt(0.12 + 0.88 * rel) * 1);
  assert.ok(e.pan >= -0.8 && e.pan <= 0.8);
  near(e.pan, (golden.allende.freqs[0].u - 0.5) * 1.2);
});

test('pickEvent folds into [40,4200], quantises to the loop and flips pan', () => {
  for (const oct of [-1, 0, 1, 2]) {
    for (let i = 0; i < 20; i++) {
      const e = pickEvent(chPick({ 'event.octave': oct }), analysis, mulberry32(i));
      assert.ok(e.f >= 40 && e.f <= 4200, `f ${e.f}`);
      assert.ok(e.pan >= -0.8 && e.pan <= 0.8);
    }
  }
  const e = pickEvent(chPick({ 'event.octave': 2, 'map.hi': 9000, 'map.snap': 0 }), analysis, () => 0.99, null, { loopSec: 3 });
  near(e.f * 3, Math.round(e.f * 3));
  const flipped = pickEvent(chPick({ 'map.flip': true, 'filter.center': golden.allende.freqs[0].u, 'filter.width': 0.04, 'filter.soft': 0 }), analysis, () => 0.5);
  assert.equal(flipped.bandIndex, 0);
  near(flipped.pan, ((1 - analysis.bands[0].u) - 0.5) * 1.2);
});
