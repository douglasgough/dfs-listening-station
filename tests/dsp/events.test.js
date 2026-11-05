import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evTimes, eventSpec, pickEvent, PING } from '../../src/dsp/events.js';
import { mapFreq, snapFreq } from '../../src/dsp/mapping.js';
import { DIVISIONS } from '../../src/core/transport.js';
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

// ---- span tiling ----
function tile(ev, tm, size, total, rnd = () => 0) {
  const all = [];
  const n = Math.round(total / size);
  let t0 = 0;
  for (let i = 1; i <= n; i++) {
    const t1 = i === n ? total : i * size; // consecutive spans share the exact boundary value
    all.push(...evTimes(ev, t0, t1, rnd, tm));
    t0 = t1;
  }
  return { all, tEnd: t0 };
}
const strictlyIncreasing = a => a.every((x, i) => i === 0 || x > a[i - 1]);

test('beats grids tile exactly across consecutive spans (regular and pattern)', () => {
  for (const div of ['1/4', '1/8t']) {
    const D = DIVISIONS[div];
    for (const bpm of [90, 120, 164.9999999999997, 133.3333333333, 200]) {
      for (const size of [0.1, 0.0333, 0.25, 1]) {
        const tm = { bpm, beatAt: s => s * bpm / 60 };
        const tv = { mode: 'beats', div };
        for (const mode of ['regular', 'pattern']) {
          const ev = { ...base, mode, interval: tv, stepLen: tv, jitter: 0, steps: 4, pattern: [true, true, true, true] };
          const { all, tEnd } = tile(ev, tm, size, 20);
          const expected = Math.floor(tm.beatAt(tEnd) / D + 1e-9);
          assert.equal(all.length, expected, `${mode} ${div} bpm ${bpm} size ${size}`);
          assert.ok(strictlyIncreasing(all), `${mode} ${div} bpm ${bpm} size ${size} order`);
        }
      }
    }
  }
});

test('seconds grids (hz and sec) tile exactly', () => {
  for (const tv of [{ mode: 'hz', value: 0.5 }, { mode: 'sec', value: 0.3 }, { mode: 'hz', value: 3.3333333333333335 }]) {
    const I = tv.mode === 'hz' ? 1 / tv.value : tv.value;
    for (const size of [0.1, 0.0333, 0.25, 1]) {
      for (const mode of ['regular', 'pattern']) {
        const ev = { ...base, mode, interval: tv, stepLen: tv, jitter: 0, steps: 4, pattern: [true, true, true, true] };
        const { all, tEnd } = tile(ev, tm120, size, 20);
        assert.equal(all.length, Math.floor(tEnd / I + 1e-9), `${mode} ${JSON.stringify(tv)} size ${size}`);
        assert.ok(strictlyIncreasing(all));
      }
    }
  }
});

test('jitter does not change which grid indices are emitted', () => {
  const rnd = mulberry32(3);
  for (const size of [0.1, 0.25, 1]) {
    const tm = { bpm: 164.9999999999997, beatAt: s => s * 164.9999999999997 / 60 };
    const plain = tile({ ...base, jitter: 0 }, tm, size, 20).all;
    const jit = tile({ ...base, jitter: 0.3 }, tm, size, 20, rnd).all;
    assert.equal(jit.length, plain.length, `size ${size}`);
    // each jittered event sits within 0.3 of a period after its grid time
    jit.forEach((x, i) => assert.ok(x >= plain[i] - 1e-9 && x <= plain[i] + 0.3 * 60 / 165 + 1e-9));
  }
});

test('bad bpm in the time map still yields finite times', () => {
  for (const bpm of [0, NaN, -5, Infinity]) {
    const t = evTimes(base, 0, 2, Math.random, { bpm, beatAt: s => s * 2 });
    assert.equal(t.length, 4);
    assert.ok(t.every(Number.isFinite));
    near(t[0], 0.5);
  }
});

test('random mode consumes rnd in the prototype order (scripted)', () => {
  const script = [0.5, 0.05, 0.5, 0.01, 0.4];
  let n = 0;
  const rnd = () => script[n++];
  // rpm 60 -> rate 1/s; slices [0,.1], [.1,.2], [.2,.25]
  const t = evTimes({ ...base, mode: 'random', rpm: 60 }, 0, 0.25, rnd, tm120);
  assert.equal(n, 5);
  assert.equal(t.length, 2);
  near(t[0], 0.1 + 0.5 * 0.1);
  near(t[1], 0.2 + 0.4 * 0.05);
});

test('pickEvent roulette picks first, middle and last band, with the boundary staying on the lower band', () => {
  const bands = [0.2, 0.4, 0.6, 0.8].map(u => ({ u, depth: 1, fwhmU: 0.1, rel: 1 }));
  const an = { r: new Float64Array(8).fill(1), d: new Float64Array(8), dmax: 1, bands };
  const ch = chPick();
  const freqOf = u => {
    const m = { lo: ch['map.lo'], hi: ch['map.hi'], curve: ch['map.curve'], flip: ch['map.flip'], f0: ch['map.f0'], snap: ch['map.snap'] };
    let f = snapFreq(mapFreq(u, m), m) * 2;
    while (f > 4200) f /= 2;
    while (f < 40) f *= 2;
    return f;
  };
  // four equal weights of 1 (total 4): r = rnd * 4
  const cases = [[0.1, 0], [0.5, 1] /* r == 2: not > 1 after one step, stays on band 1 */, [0.25, 0] /* r == 1: boundary stays on band 0 */, [0.51, 2], [0.999, 3], [0, 0]];
  for (const [rv, want] of cases) {
    const e = pickEvent(ch, an, () => rv);
    assert.equal(e.bandIndex, want, `rnd ${rv}`);
    near(e.f, freqOf(bands[want].u));
  }
});

test('pickEvent roulette weights follow band strength', () => {
  const bands = [{ u: 0.2, rel: 1 }, { u: 0.5, rel: 0 }, { u: 0.8, rel: 1 }].map(b => ({ depth: 1, fwhmU: 0.1, ...b }));
  const an = { r: new Float64Array(8).fill(1), d: new Float64Array(8), dmax: 1, bands };
  const w = [1, 0.12, 1], tot = 2.12;
  const at = c => pickEvent(chPick(), an, () => c / tot).bandIndex;
  assert.equal(at(0.5), 0);
  assert.equal(at(1.05), 1);
  assert.equal(at(1.2), 2);
  assert.equal(at(1.12 - 1e-6), 1);
  assert.equal(at(1.12 + 1e-6), 2);
  assert.equal(w[0] + w[1] + w[2], tot);
});
