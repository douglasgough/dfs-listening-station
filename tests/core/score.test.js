import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  recordChange, paramsAt, resolveAt, channelEvents, buildScore, hashSeed, mulberry32, DEFAULT_SEED,
} from '../../src/core/score.js';
import { createState } from '../../src/core/state.js';
import { paramDef, NUM_CHANNELS } from '../../src/core/schema.js';
import { Transport, timeMap } from '../../src/core/transport.js';
import { envValue } from '../../src/core/modulation.js';
import { analyse } from '../../src/spectrum/analyse.js';
import { EXAMPLE_LAYERS } from '../../src/spectrum/examples.js';

// ---- helpers ---------------------------------------------------------------------------------

const allende = EXAMPLE_LAYERS.find(l => l.id === 'allende');
const STAGE = { unit: allende.axis.unit, x0: allende.axis.x0, x1: allende.axis.x1 };
const A = analyse(allende, STAGE, { polarity: 'dips', sens: 0.2, mode: 'hull' });

function project(edit = () => {}, analyses = [A, A, A, A]) {
  const state = createState();
  edit(state);
  return { state, analyses, stage: STAGE };
}
const running = (bpm = 120) => { const tr = new Transport({ bpm }); tr.start(0); return timeMap(tr, 0); };
const stopped = () => timeMap(new Transport(), 0);

const ARRAYS = ['bandF', 'bandA', 'bandPan', 'combF', 'combA', 'noiseF', 'noiseA', 'anchorF', 'anchorA'];
const AMPS = ['bandA', 'combA', 'noiseA', 'anchorA'];
/** A frame as plain data (typed arrays to arrays); events optional. */
const plain = (fr, { events = true, t = true } = {}) => {
  const o = { balance: fr.balance, match: fr.match };
  if (t) o.t = fr.t;
  for (const k of ARRAYS) o[k] = Array.from(fr[k]);
  if (events) o.events = fr.events;
  return o;
};
const flatEvents = frames => frames.flatMap(f => f.events).sort((a, b) => a.t - b.t);
const allZero = fr => AMPS.every(k => fr[k].every(v => v === 0));

/** Channel 1 random at 60/min (the schema max; 600 clamps to 60), channel 2 regular 1/4 jitter .3, both chance 1. */
function busy(s) {
  s.params['ch1.event.mode'] = 'random';
  s.params['ch1.event.rpm'] = 60;
  s.params['ch1.event.chance'] = 1;
  s.params['ch2.filter.on'] = true;
  s.params['ch2.event.mode'] = 'regular';
  s.params['ch2.event.interval'] = { mode: 'beats', div: '1/4' };
  s.params['ch2.event.jitter'] = 0.3;
  s.params['ch2.event.chance'] = 1;
}

// ---- Take ------------------------------------------------------------------------------------

test('recordChange keeps events sorted by t (stable for equal t)', () => {
  const take = { dur: 10, bpm: 120, events: [] };
  recordChange(take, 3, 'a', 1);
  recordChange(take, 1, 'b', 2);
  recordChange(take, 2, 'a', 3);
  recordChange(take, 2, 'c', 4);
  recordChange(take, 5, 'a', 5);
  assert.deepEqual(take.events.map(e => [e.t, e.id, e.value]),
    [[1, 'b', 2], [2, 'a', 3], [2, 'c', 4], [3, 'a', 1], [5, 'a', 5]]);
});

test('paramsAt returns the last event at or before t per id; other ids keep base; base not mutated', () => {
  const take = { dur: 10, bpm: 120, events: [] };
  recordChange(take, 1, 'x', 10);
  recordChange(take, 2, 'x', 20);
  recordChange(take, 2, 'x', 21);
  recordChange(take, 4, 'y', 'on');
  const base = { x: 0, y: 'off', z: 7 };
  assert.deepEqual(paramsAt(take, base, 0.5), { x: 0, y: 'off', z: 7 });
  assert.deepEqual(paramsAt(take, base, 1), { x: 10, y: 'off', z: 7 });
  assert.deepEqual(paramsAt(take, base, 2), { x: 21, y: 'off', z: 7 });
  assert.deepEqual(paramsAt(take, base, 9), { x: 21, y: 'on', z: 7 });
  assert.deepEqual(base, { x: 0, y: 'off', z: 7 });
  assert.notEqual(paramsAt(take, base, 0), base);
});

// ---- rng -------------------------------------------------------------------------------------

test('hashSeed is a deterministic 32-bit mix; neighbouring buckets and channels differ', () => {
  assert.equal(hashSeed(1, 2, 3), hashSeed(1, 2, 3));
  const seen = new Set();
  for (let c = 0; c < 4; c++) for (let b = -50; b < 50; b++) {
    const h = hashSeed(DEFAULT_SEED, c, b);
    assert.ok(Number.isInteger(h) && h >= 0 && h < 2 ** 32);
    seen.add(h);
  }
  assert.equal(seen.size, 400);
  const r = mulberry32(5), s = mulberry32(5);
  for (let i = 0; i < 5; i++) { const v = r(); assert.equal(v, s()); assert.ok(v >= 0 && v < 1); }
});

// ---- determinism and tiling ------------------------------------------------------------------

test('buildScore is deterministic for fixed inputs', () => {
  const p = project(busy), tm = running();
  const span = { startSec: 0, endSec: 4, stepSec: 0.25 };
  const a = buildScore(p, span, { tm }), b = buildScore(p, span, { tm });
  assert.equal(a.length, NUM_CHANNELS);
  assert.deepEqual(a.map(ch => ch.map(f => plain(f))), b.map(ch => ch.map(f => plain(f))));
  assert.ok(flatEvents(a[0]).length > 0 && flatEvents(a[1]).length > 0);
});

test('frame count and times: n = ceil((end-start)/step), t_i = start + i*step', () => {
  const s = buildScore(project(), { startSec: 1, endSec: 2, stepSec: 0.25 }, { tm: running() });
  assert.deepEqual(s[0].map(f => f.t), [1, 1.25, 1.5, 1.75]);
  const u = buildScore(project(), { startSec: 0, endSec: 1.1, stepSec: 0.25 }, { tm: running() });
  assert.equal(u[0].length, 5);
});

test('tiling: one span equals the concatenation of chunks (frames and events)', () => {
  // Channel 3: regular 1/4 with jitter 0, so events land exactly on the chunk boundaries 3 and 7.
  const p = project(s => {
    busy(s);
    Object.assign(s.params, {
      'ch3.filter.on': true, 'ch3.event.mode': 'regular', 'ch3.event.interval': { mode: 'beats', div: '1/4' },
      'ch3.event.jitter': 0, 'ch3.event.chance': 1, 'ch3.filter.center': 0.5, 'ch3.filter.width': 0.3,
    });
  });
  const tm = running();
  const whole = buildScore(p, { startSec: 0, endSec: 10, stepSec: 0.25 }, { tm });
  const parts = [[0, 3], [3, 7], [7, 10]].map(([s, e]) => buildScore(p, { startSec: s, endSec: e, stepSec: 0.25 }, { tm }));
  for (let c = 0; c < NUM_CHANNELS; c++) {
    const joined = parts.flatMap(part => part[c]);
    assert.equal(joined.length, whole[c].length);
    assert.deepEqual(joined.map(f => plain(f)), whole[c].map(f => plain(f)), `channel ${c + 1}`);
    assert.deepEqual(flatEvents(joined), flatEvents(whole[c]));
  }
  assert.ok(flatEvents(whole[0]).length >= 3, 'random channel has events');
  assert.ok(flatEvents(whole[1]).length >= 10, 'regular channel has events');
  const onGrid = flatEvents(whole[2]).map(e => e.t);
  assert.ok(onGrid.includes(3) && onGrid.includes(7), 'boundary events exist');
});

test('channelEvents: any partition of a range yields each event exactly once', () => {
  const p = project(s => { busy(s); s.params['ch2.event.interval'] = { mode: 'beats', div: '2 bars' }; s.params['ch2.event.jitter'] = 1; });
  const tm = running();
  for (const c of [0, 1]) {
    const whole = channelEvents(p, c, 0, 20, { tm });
    const cuts = [0, 0.3, 1, 2.7, 5, 5.01, 9, 13.5, 20];
    const joined = [];
    for (let i = 0; i < cuts.length - 1; i++) joined.push(...channelEvents(p, c, cuts[i], cuts[i + 1], { tm }));
    assert.deepEqual(joined, whole, `channel ${c + 1}`);
    for (const e of whole) assert.ok(e.t > 0 && e.t <= 20);
    for (let i = 1; i < whole.length; i++) assert.ok(whole[i].t >= whole[i - 1].t);
  }
});

// ---- event semantics -------------------------------------------------------------------------

test('event fields: finite f in [40,4200], amp > 0, pan in [-0.8,0.8], default envRoutes and staticGain', () => {
  const p = project(busy), tm = running();
  const evs = [...channelEvents(p, 0, 0, 20, { tm }), ...channelEvents(p, 1, 0, 20, { tm })];
  assert.ok(evs.length > 20);
  for (const e of evs) {
    assert.deepEqual(Object.keys(e).sort(), ['amp', 'envRoutes', 'f', 'pan', 'staticGain', 't']);
    assert.ok(Number.isFinite(e.f) && e.f >= 40 && e.f <= 4200, `f ${e.f}`);
    assert.ok(e.amp > 0 && Number.isFinite(e.amp));
    assert.ok(e.pan >= -0.8 && e.pan <= 0.8);
    assert.deepEqual(e.envRoutes, [{ a: 0.03, h: 0, d: 1.2, amount: 1 }]);
    assert.equal(e.staticGain, 1);
  }
});

test('no events before transport-elapsed second 0 (no phantom history before play)', () => {
  const p = project(busy), tm = running();
  assert.equal(channelEvents(p, 0, -20, 0, { tm }).length, 0);
  assert.equal(channelEvents(p, 1, -20, 0, { tm }).length, 0);
  assert.ok(channelEvents(p, 1, -20, 2, { tm }).every(e => e.t >= 0));
});

test('event.chance 0 gives no events', () => {
  const p = project(s => { busy(s); s.params['ch1.event.chance'] = 0; s.params['ch2.event.chance'] = 0; });
  const sc = buildScore(p, { startSec: 0, endSec: 10, stepSec: 0.25 }, { tm: running() });
  assert.equal(flatEvents(sc[0]).length, 0);
  assert.equal(flatEvents(sc[1]).length, 0);
});

test('stopped transport: no events, frames still produced, modulators hold', () => {
  const lfo = s => { busy(s); s.matrix.push({ src: 'g.lfo1', dst: 'ch1.filter.center', amount: 1 }); };
  const span = { startSec: 0, endSec: 5, stepSec: 0.25 };
  const st = buildScore(project(lfo), span, { tm: stopped() });
  assert.equal(st[0].length, 20);
  assert.equal(flatEvents(st[0]).length + flatEvents(st[1]).length, 0);
  assert.equal(channelEvents(project(lfo), 0, 0, 5, { tm: stopped() }).length, 0);
  assert.ok(!allZero(st[0][0]));
  assert.deepEqual(plain(st[0][0], { t: false }), plain(st[0][10], { t: false }));
  const run = buildScore(project(lfo), span, { tm: running() });
  assert.notDeepEqual(plain(run[0][0], { t: false, events: false }), plain(run[0][10], { t: false, events: false }));
});

test('disabled channel: no events and all-zero frames', () => {
  const p = project(s => { busy(s); s.params['ch1.filter.on'] = false; });
  const sc = buildScore(p, { startSec: 0, endSec: 10, stepSec: 0.25 }, { tm: running() });
  assert.equal(flatEvents(sc[0]).length, 0);
  assert.ok(sc[0].every(allZero));
  assert.ok(flatEvents(sc[1]).length > 0);
});

test('(RF4) analyses[c] === null: zero frames, no events, no throw, other channels unaffected', () => {
  const span = { startSec: 0, endSec: 6, stepSec: 0.25 }, tm = running();
  const full = buildScore(project(busy), span, { tm });
  const p = project(busy, [A, null, A, A]);
  const sc = buildScore(p, span, { tm });
  assert.equal(sc[1].length, 24);
  assert.ok(sc[1].every(allZero));
  assert.equal(flatEvents(sc[1]).length, 0);
  assert.equal(channelEvents(p, 1, 0, 6, { tm }).length, 0);
  assert.deepEqual(sc[0].map(f => plain(f)), full[0].map(f => plain(f)));
});

test('an analysis with no bands gives finite frames and no events', () => {
  const empty = { ...A, bands: [] };
  const sc = buildScore(project(busy, [empty, A, A, A]), { startSec: 0, endSec: 4, stepSec: 0.25 }, { tm: running() });
  assert.equal(flatEvents(sc[0]).length, 0);
  for (const f of sc[0]) for (const k of ARRAYS) assert.ok(f[k].every(Number.isFinite));
});

test('events ride the frame whose interval (t_i, t_i+step] contains them', () => {
  const p = project(busy);
  const sc = buildScore(p, { startSec: 0, endSec: 10, stepSec: 0.25 }, { tm: running() });
  for (const ch of sc.slice(0, 2)) {
    ch.forEach((f, i) => { for (const e of f.events) assert.ok(e.t > f.t && e.t <= f.t + 0.25 + 1e-12, `${e.t} on frame ${f.t}`); });
  }
});

// ---- envelope triggers -----------------------------------------------------------------------

test('envelope triggers from channelEvents shape filter.center and return to base after the life', () => {
  const env = { a: 0.03, h: 0, d: 0.1 }; // life 0.03 + 0.8 = 0.83 s
  const p = project(s => {
    s.params['ch1.event.mode'] = 'regular';
    s.params['ch1.event.interval'] = { mode: 'beats', div: '1 bar' }; // 4 beats = 2 s at 120 bpm
    s.params['ch1.event.jitter'] = 0;
    s.params['ch1.event.chance'] = 1;
    s.mods.ch1.env[0] = { ...env };
    s.matrix.push({ src: 'ch1.env1', dst: 'ch1.filter.center', amount: 0.5 });
  });
  const tm = running(120);
  const evs = channelEvents(p, 0, 0, 7, { tm });
  assert.deepEqual(evs.map(e => e.t), [2, 4, 6]);
  const triggers = { 'ch1.env1': evs.map(e => e.t) };
  const def = paramDef('ch1.filter.center'), base = p.state.params['ch1.filter.center'];
  const expect = sec => Math.min(def.max, Math.max(def.min, base + 0.5 * (def.max - def.min) * envValue(env, triggers['ch1.env1'], sec)));
  for (const t of [1.9, 2.015, 2.03, 2.2, 2.5, 4.03, 4.5]) {
    const v = resolveAt(p, t, { tm, triggers })['ch1.filter.center'];
    assert.ok(Math.abs(v - expect(t)) < 1e-12, `t=${t}: ${v} vs ${expect(t)}`);
  }
  assert.ok(Math.abs(resolveAt(p, 2.015, { tm, triggers })['ch1.filter.center'] - (base + 0.25)) < 1e-12);
  assert.ok(Math.abs(resolveAt(p, 2.03, { tm, triggers })['ch1.filter.center'] - Math.min(1, base + 0.5)) < 1e-12);
  assert.equal(resolveAt(p, 2.9, { tm, triggers })['ch1.filter.center'], base); // past the 0.83 s life
  assert.equal(resolveAt(p, 1.9, { tm, triggers })['ch1.filter.center'], base);

  // buildScore wires the same triggers into its frames: window centre moves, so amplitudes differ.
  const sc = buildScore(p, { startSec: 1.5, endSec: 3, stepSec: 0.125 }, { tm });
  const at = t => sc[0].find(f => f.t === t);
  assert.deepEqual(plain(at(1.5), { t: false, events: false }), plain(at(2.875), { t: false, events: false }));
  assert.notDeepEqual(Array.from(at(2.125).bandA), Array.from(at(1.5).bandA));
});

// ---- loop mode -------------------------------------------------------------------------------

test('loop mode: frames repeat every loop, events repeat, carried copies, quantised frequencies', () => {
  const p = project(s => {
    busy(s);
    s.params['ch2.filter.type'] = 'granular';
  });
  const tm = running(120), L = 8, O = 7;
  const sc = buildScore(p, { startSec: 7, endSec: 23, stepSec: 0.25 }, { tm, loopSec: L, loopOffset: O });
  for (let c = 0; c < NUM_CHANNELS; c++) {
    for (let i = 0; i < 32; i++) {
      const a = sc[c][i], b = sc[c][i + 32];
      assert.equal(b.t - a.t, 8);
      assert.deepEqual(plain(a, { t: false, events: false }), plain(b, { t: false, events: false }), `ch${c + 1} frame ${i}`);
      if (i === 0) continue; // frame 0 also carries the copies started before the span
      assert.equal(a.events.length, b.events.length, `ch${c + 1} frame ${i} event count`);
      a.events.forEach((e, k) => {
        const g = b.events[k];
        assert.ok(Math.abs(g.t - e.t - 8) < 1e-9);
        assert.deepEqual({ ...g, t: 0 }, { ...e, t: 0 });
      });
    }
  }
  for (const c of [0, 1]) {
    const evs = flatEvents(sc[c]);
    const mod = list => list.map(e => ((e.t - O) % L + L) % L).sort((x, y) => x - y);
    const c1 = mod(evs.filter(e => e.t > 7 && e.t <= 15)), c2 = mod(evs.filter(e => e.t > 15 && e.t <= 23));
    assert.ok(c1.length > 0);
    assert.equal(c1.length, c2.length);
    c1.forEach((x, k) => assert.ok(Math.abs(x - c2[k]) < 1e-9));
    for (const e of evs) assert.ok(Math.abs(e.f * 8 - Math.round(e.f * 8)) < 1e-9, `f ${e.f}`);
    // Default env life is 0.03 + 8*1.2 = 9.63 s > 8 s: copies from the previous cycle still sound at the start.
    const carried = sc[c][0].events.filter(e => e.t < 7);
    assert.ok(carried.length > 0, `ch${c + 1} carries earlier copies`);
    for (const e of carried) assert.ok(e.t + 9.63 > 7 - 1e-9);
  }
});

// ---- take overlay and source.shift -----------------------------------------------------------

test('take overlay: drone.bands 0 from transport second 2 zeroes bandA at/after 2 s only', () => {
  const take = { dur: 10, bpm: 120, events: [] };
  recordChange(take, 2, 'ch1.drone.bands', 0);
  const sc = buildScore(project(), { startSec: 0, endSec: 4, stepSec: 0.25 }, { tm: running(), take });
  for (const f of sc[0]) {
    const zero = f.bandA.every(v => v === 0);
    assert.equal(zero, f.t >= 2, `t=${f.t}`);
  }
});

test('an LFO route to source.shift moves bandF', () => {
  const p = project(s => {
    s.params['ch1.map.snap'] = 0;
    s.matrix.push({ src: 'g.lfo1', dst: 'ch1.source.shift', amount: 1 }); // sine 0.1 Hz: 0 at t=0, +1 at t=2.5
  });
  const sc = buildScore(p, { startSec: 0, endSec: 3, stepSec: 0.5 }, { tm: running() });
  const f0 = Array.from(sc[0][0].bandF), f5 = Array.from(sc[0][5].bandF);
  assert.equal(sc[0][5].t, 2.5);
  assert.notDeepEqual(f0, f5);
  const plainP = project(s => { s.params['ch1.map.snap'] = 0; });
  const ref = buildScore(plainP, { startSec: 0, endSec: 3, stepSec: 0.5 }, { tm: running() });
  assert.deepEqual(f0, Array.from(ref[0][0].bandF));
});

// ---- performance and purity ------------------------------------------------------------------

test('performance: one second of score (step .04, 4 channels, events) builds in < 300 ms', () => {
  // Loose bound so CI noise does not flake; typical is a few milliseconds.
  const p = project(s => {
    for (let c = 1; c <= 4; c++) {
      s.params[`ch${c}.filter.on`] = true;
      s.params[`ch${c}.event.mode`] = 'random';
      s.params[`ch${c}.event.rpm`] = 60;
      s.params[`ch${c}.event.chance`] = 1;
    }
    s.params['ch3.filter.type'] = 'granular';
  });
  const tm = running();
  buildScore(p, { startSec: 0, endSec: 1, stepSec: 0.04 }, { tm }); // warm-up
  const t0 = process.hrtime.bigint();
  const sc = buildScore(p, { startSec: 10, endSec: 11, stepSec: 0.04 }, { tm });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(sc[0].length, 25);
  assert.ok(ms < 300, `${ms} ms`);
});

test('purity: project, state, take, analyses and opts are not mutated', () => {
  const p = project(busy);
  const take = { dur: 10, bpm: 120, events: [] };
  recordChange(take, 1, 'ch1.filter.center', 0.2);
  const cc = { 'g.cc1': 0.5 };
  const opts = { tm: running(), seed: 42, take, cc, loopSec: 8, loopOffset: 7 };
  const before = { p: structuredClone(p), take: structuredClone(take), cc: structuredClone(cc), seed: opts.seed, loopSec: 8, loopOffset: 7 };
  const tmKeys = Object.keys(opts.tm);
  buildScore(p, { startSec: 7, endSec: 12, stepSec: 0.25 }, opts);
  buildScore(p, { startSec: 0, endSec: 5, stepSec: 0.25 }, { tm: opts.tm, take, cc });
  assert.deepEqual(p, before.p);
  assert.deepEqual(take, before.take);
  assert.deepEqual(cc, before.cc);
  assert.deepEqual({ seed: opts.seed, loopSec: opts.loopSec, loopOffset: opts.loopOffset }, { seed: 42, loopSec: 8, loopOffset: 7 });
  assert.deepEqual(Object.keys(opts), ['tm', 'seed', 'take', 'cc', 'loopSec', 'loopOffset']);
  assert.deepEqual(Object.keys(opts.tm), tmKeys);
});
