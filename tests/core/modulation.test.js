import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LFO_SHAPES, lfoValue, envValue, evaluate, eventRoutes, voiceGain } from '../../src/core/modulation.js';
import { createState } from '../../src/core/state.js';
import { allParamIds, paramDef } from '../../src/core/schema.js';

const golden = JSON.parse(readFileSync(new URL('../fixtures/prototype-golden.json', import.meta.url), 'utf8'));
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} ${a} !== ${b}`);
const lfoOf = (shape, over = {}) => ({ shape, rate: { mode: 'hz', value: 0.1 }, phase: 0, seed: 17, ...over });
const T = sec => ({ beat: 0, sec });
const OPTS = { bpm: 120, triggers: {} };

test('LFO_SHAPES lists the six prototype shapes', () => {
  assert.deepEqual(LFO_SHAPES, ['sine', 'tri', 'ramp', 'square', 'steps', 'drift']);
});

test('golden: lfoValue reproduces the prototype for all shapes and times (1e-12)', () => {
  assert.equal(golden.allende.lfo.length, 18);
  for (const { shape, t, v } of golden.allende.lfo) {
    near(lfoValue(lfoOf(shape), { beat: 0, sec: t }, 120), v, 1e-12, `${shape}@${t}`);
  }
});

test('sine at phase 0.25 is 1', () => {
  near(lfoValue(lfoOf('sine', { rate: { mode: 'hz', value: 1 }, phase: 0.25 }), T(0), 120), 1, 1e-9);
});

test('loop mode: value repeats exactly every loopSec for all shapes', () => {
  for (const shape of LFO_SHAPES) {
    for (const s of [0, 0.37, 1.9, 4.4, 7.77, 9.99]) {
      const lfo = lfoOf(shape, { rate: { mode: 'hz', value: 0.13 }, seed: 5 });
      near(lfoValue(lfo, T(s), 120, 10), lfoValue(lfo, T(s + 10), 120, 10), 1e-9, `${shape}@${s}`);
    }
  }
});

test('synced rate: 1/4 at 120 bpm completes a cycle in 0.5 s', () => {
  const lfo = lfoOf('ramp', { rate: { mode: 'beats', div: '1/4' } });
  // at 120 bpm a beat is 0.5 s; transport supplies beat position
  near(lfoValue(lfo, { beat: 0.25, sec: 0.125 }, 120), lfoValue(lfo, { beat: 1.25, sec: 0.625 }, 120), 1e-9);
  near(lfoValue(lfo, { beat: 0, sec: 0 }, 120), lfoValue(lfo, { beat: 1, sec: 0.5 }, 120), 1e-9);
});

test('guards: bad rate, unknown shape, bad phase and bad t stay finite', () => {
  const bad = lfoOf('nope', { rate: { mode: 'hz', value: -3 }, phase: NaN });
  for (const t of [0, 1.3, 1e9]) assert.ok(Number.isFinite(lfoValue(bad, T(t), 120)));
  near(lfoValue(bad, T(0.7), 120), lfoValue(lfoOf('sine', { rate: { mode: 'hz', value: -3 } }), T(0.7), 120), 1e-12);
  assert.ok(Number.isFinite(lfoValue(lfoOf('drift', { rate: null, seed: NaN }), T(2), NaN, 10)));
  assert.ok(Number.isFinite(lfoValue(lfoOf('sine'), { beat: NaN, sec: NaN }, 120)));
});

test('envValue: 0 before trigger, 1 at a, exp(-1) at a+h+d, 0 after life', () => {
  const env = { a: 0.1, h: 0.2, d: 0.5 };
  assert.equal(envValue(env, [1], 0.5), 0);
  assert.equal(envValue(env, [], 0.5), 0);
  near(envValue(env, [1], 1), 0, 1e-12);
  near(envValue(env, [1], 1.05), 0.5, 1e-12);
  near(envValue(env, [1], 1.1), 1, 1e-12);
  near(envValue(env, [1], 1.2), 1, 1e-12);
  near(envValue(env, [1], 1 + 0.1 + 0.2 + 0.5), Math.exp(-1), 1e-12);
  assert.equal(envValue(env, [1], 1 + 0.1 + 0.2 + 8 * 0.5 + 0.001), 0);
});

test('envValue: newest trigger at or before sec wins; later triggers ignored', () => {
  const env = { a: 0.1, h: 0, d: 0.5 };
  near(envValue(env, [0, 2, 5], 2.1), 1, 1e-12);
  near(envValue(env, [5, 0, 2], 2.1), 1, 1e-12);
  near(envValue(env, [0, 2, 5], 3.1), Math.exp(-(3.1 - 2 - 0.1) / 0.5), 1e-12);
  near(envValue(env, [0, 2, 5], 4.0), envValue(env, [2], 4.0), 1e-12);
  assert.ok(envValue(env, [0, 2, 5], 4.0) > 0);
  assert.equal(envValue(env, [10], 5), 0);
});

test('envValue guards: tiny a/d and non-finite values are finite', () => {
  for (const env of [{ a: 0, h: 0, d: 0 }, { a: NaN, h: -1, d: NaN }]) {
    for (const s of [0, 0.001, 0.5, 100]) {
      const v = envValue(env, [0], s);
      assert.ok(Number.isFinite(v) && v >= 0 && v <= 1, String(v));
    }
  }
  assert.ok(Number.isFinite(envValue({ a: 1, h: 1, d: 1 }, [NaN, 0], NaN)));
});

test('evaluate: returns every schema id; non-numeric params pass through unchanged', () => {
  const st = createState();
  st.params['ch1.source.polarity'] = 'both';
  st.params['ch2.filter.on'] = false;
  const out = evaluate(st, T(0), OPTS);
  assert.deepEqual(Object.keys(out).sort(), allParamIds().sort());
  assert.equal(out['ch1.source.polarity'], 'both');
  assert.equal(out['ch2.filter.on'], false);
  assert.equal(out['ch1.source.layer'], 'none');
  for (const id of allParamIds()) {
    if (paramDef(id).type === 'time') assert.deepEqual(out[id], st.params[id]);
    if (paramDef(id).type === 'num') assert.equal(out[id], st.params[id]);
  }
});

test('evaluate: g.lfo1 -> ch1.filter.center amount .5 moves by +/-.25 range and stays in range', () => {
  const st = createState();
  st.matrix = [{ src: 'g.lfo1', dst: 'ch1.filter.center', amount: 0.5 }];
  st.mods.g.lfo[0] = lfoOf('sine', { rate: { mode: 'hz', value: 1 } });
  const out = evaluate(st, T(0.25), OPTS); // sine peak
  near(out['ch1.filter.center'], 0.5 + 0.25, 1e-6);
  const trough = evaluate(st, T(0.75), OPTS);
  near(trough['ch1.filter.center'], 0.5 - 0.25, 1e-6);
  st.params['ch1.filter.center'] = 0.95;
  for (let s = 0; s < 2; s += 0.05) {
    const v = evaluate(st, T(s), OPTS)['ch1.filter.center'];
    assert.ok(v >= 0 && v <= 1, String(v));
  }
  near(evaluate(st, T(0.25), OPTS)['ch1.filter.center'], 1, 1e-12);
});

test('evaluate: envelope and CC are unipolar and scale by (max-min)', () => {
  const st = createState();
  st.matrix = [
    { src: 'ch1.env1', dst: 'ch1.filter.width', amount: 0.5 },
    { src: 'g.cc7', dst: 'ch2.filter.center', amount: -1 },
  ];
  st.params['ch1.filter.width'] = 0.3;
  st.params['ch2.filter.center'] = 0.9;
  const o = evaluate(st, T(1.03), { bpm: 120, triggers: { 'ch1.env1': [1] }, cc: { 'g.cc7': 0.5 } });
  near(o['ch1.filter.width'], 0.3 + 1 * 0.5 * (1 - 0.02), 1e-9);
  near(o['ch2.filter.center'], 0.9 - 0.5, 1e-12);
  const none = evaluate(st, T(1.03), OPTS);
  near(none['ch2.filter.center'], 0.9, 1e-12); // missing cc is 0
});

test('evaluate (RF2): unknown src/dst, non-modulatable dst and nonexistent source index are skipped', () => {
  const st = createState();
  const base = evaluate(st, T(1), OPTS);
  st.matrix = [
    { src: 'bogus.thing', dst: 'ch1.filter.center', amount: 1 },
    { src: 'g.lfo1', dst: 'ch1.nope', amount: 1 },
    { src: 'g.lfo1', dst: 'map.f0', amount: 1 },
    { src: 'g.lfo1', dst: 'ch1.map.f0', amount: 1 },
    { src: 'g.lfo1', dst: 'drone.beat', amount: 1 },
    { src: 'ch1.lfo9', dst: 'ch1.filter.center', amount: 1 },
    { src: 'ch1.env7', dst: 'ch1.filter.center', amount: 1 },
    { src: 'g.env1', dst: 'ch1.filter.center', amount: 1 },
    { src: 'ch9.lfo1', dst: 'ch1.filter.center', amount: 1 },
    { src: 'g.lfo1', dst: 'ch1.source.polarity', amount: 1 },
    { src: 'g.lfo1', dst: 'ch1.filter.center', amount: NaN },
    null,
  ];
  let out;
  assert.doesNotThrow(() => { out = evaluate(st, T(1), OPTS); });
  assert.deepEqual(out, base);
  st.mods.g.lfo = [];
  st.matrix = [{ src: 'g.lfo2', dst: 'ch1.filter.center', amount: 1 }];
  assert.deepEqual(evaluate(st, T(1), OPTS), base);
  delete st.mods.ch1;
  st.matrix = [{ src: 'ch1.lfo1', dst: 'ch1.filter.center', amount: 1 }];
  assert.deepEqual(evaluate(st, T(1), OPTS), base);
});

test('evaluate: routes to event.level are skipped (voice rate)', () => {
  const st = createState();
  st.matrix = [{ src: 'g.lfo1', dst: 'ch1.event.level', amount: 1 }, ...st.matrix];
  const out = evaluate(st, T(0.5), { bpm: 120, triggers: { 'ch1.env1': [0] } });
  assert.equal(out['ch1.event.level'], st.params['ch1.event.level']);
});

test('evaluate: loopSec makes modulated values repeat every loop', () => {
  const st = createState();
  st.matrix = [{ src: 'g.lfo1', dst: 'ch1.filter.center', amount: 0.5 }];
  st.mods.g.lfo[0] = lfoOf('drift', { rate: { mode: 'hz', value: 0.13 } });
  const o = { bpm: 120, triggers: {}, loopSec: 10 };
  near(evaluate(st, T(3.3), o)['ch1.filter.center'], evaluate(st, T(13.3), o)['ch1.filter.center'], 1e-9);
});

test('voiceGain with the default route equals envValue at that age; ages are independent', () => {
  const st = createState();
  const env = st.mods.ch1.env[0];
  const er = eventRoutes(st, 0, T(0), OPTS);
  assert.equal(er.envRoutes.length, 1);
  assert.deepEqual(er.envRoutes[0], { a: env.a, h: env.h, d: env.d, amount: 1 });
  assert.equal(er.staticGain, 1);
  for (const age of [0, 0.01, 0.03, 0.5, 1.2, 5, 30]) {
    near(voiceGain(st, 0, age, OPTS), envValue(env, [0], age), 1e-12, `age ${age}`);
  }
  const g1 = voiceGain(st, 0, 0.03, OPTS), g2 = voiceGain(st, 0, 2, OPTS);
  near(g1, 1, 1e-12);
  near(g2, envValue(env, [0], 2), 1e-12);
  near(voiceGain(st, 0, 0.03, OPTS), g1, 0); // repeat call: no hidden state
});

test('eventRoutes: LFO route lands in staticGain; no env route -> voiceGain is staticGain', () => {
  const st = createState();
  st.matrix = [{ src: 'g.lfo1', dst: 'ch2.event.level', amount: 0.5 }];
  st.mods.g.lfo[0] = lfoOf('sine', { rate: { mode: 'hz', value: 1 } });
  const er = eventRoutes(st, 1, T(0.25), OPTS);
  assert.deepEqual(er.envRoutes, []);
  near(er.staticGain, 1.5, 1e-6);
  near(voiceGain(st, 1, 0.1, { ...OPTS, t: T(0.25) }), 1.5, 1e-6);
  assert.deepEqual(eventRoutes(st, 0, T(0.25), OPTS), { envRoutes: [], staticGain: 1 });
});

test('eventRoutes: CC unipolar gain, floor at 0, other-channel env allowed, bad routes skipped', () => {
  const st = createState();
  st.matrix = [
    { src: 'g.cc1', dst: 'ch1.event.level', amount: 1 },
    { src: 'ch3.env2', dst: 'ch1.event.level', amount: -0.5 },
    { src: 'ch1.lfo9', dst: 'ch1.event.level', amount: 1 },
    { src: 'zzz', dst: 'ch1.event.level', amount: 1 },
    { src: 'g.lfo1', dst: 'ch1.filter.center', amount: 1 },
  ];
  const er = eventRoutes(st, 0, T(0), { bpm: 120, triggers: {}, cc: { 'g.cc1': 0 } });
  assert.equal(er.staticGain, 0); // max(0, 1 + 1*(0-1))
  assert.equal(er.envRoutes.length, 1);
  assert.equal(er.envRoutes[0].amount, -0.5);
  const e = st.mods.ch3.env[1];
  assert.deepEqual([er.envRoutes[0].a, er.envRoutes[0].h, er.envRoutes[0].d], [e.a, e.h, e.d]);
});
