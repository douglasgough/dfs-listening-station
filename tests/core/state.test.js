import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createState, createStore, serializePatch, deserializePatch,
} from '../../src/core/state.js';
import { allParamIds, paramDef, modulatableIds } from '../../src/core/schema.js';

const LAYER = { id: 'L1', name: 'Test', kind: 'sampled', quantity: 'reflectance', axis: { unit: 'nm', x0: 400, x1: 900 }, data: [[400, 1], [900, 0.5]] };

test('createState holds every schema id with its default', () => {
  const s = createState();
  assert.deepEqual(Object.keys(s.params).sort(), allParamIds().sort());
  for (const id of allParamIds()) assert.deepEqual(s.params[id], paramDef(id).default, id);
});

test('only channel 1 filter is on by default', () => {
  const s = createState();
  assert.equal(s.params['ch1.filter.on'], true);
  for (const c of [2, 3, 4]) assert.equal(s.params[`ch${c}.filter.on`], false);
});

test('createState mod owners, timelines, pattern, layers', () => {
  const s = createState();
  assert.deepEqual(Object.keys(s.mods), ['g', 'ch1', 'ch2', 'ch3', 'ch4']);
  assert.equal(s.mods.g.lfo.length, 2);
  assert.deepEqual(s.mods.g.env, []);
  for (const c of [1, 2, 3, 4]) {
    assert.equal(s.mods[`ch${c}`].lfo.length, 2);
    assert.deepEqual(s.mods[`ch${c}`].env, [{ a: 0.03, h: 0, d: 1.2 }, { a: 0.03, h: 0, d: 1.2 }]);
  }
  const lfos = Object.values(s.mods).flatMap(m => m.lfo);
  assert.deepEqual(lfos.map(l => l.seed), [17, 1017, 2017, 3017, 4017, 5017, 6017, 7017, 8017, 9017]);
  assert.deepEqual(s.mods.g.lfo.map(l => l.shape), ['sine', 'tri']);
  assert.deepEqual(s.mods.g.lfo[0].rate, { mode: 'hz', value: 0.1 });
  assert.equal(s.mods.g.lfo[0].phase, 0);
  assert.equal(s.timelines.length, 4);
  assert.deepEqual(s.timelines[0], { len: { mode: 'sec', value: 32 }, mode: 'morph', events: [] });
  assert.equal(s.pattern.length, 4);
  assert.deepEqual(s.pattern[0], [1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0].map(Boolean));
  assert.deepEqual(s.layers, []);
});

test('default state ships env1 -> event.level for each channel', () => {
  const s = createState();
  assert.deepEqual(s.matrix, [1, 2, 3, 4].map(i => ({ src: `ch${i}.env1`, dst: `ch${i}.event.level`, amount: 1 })));
});

test('createState returns independent copies', () => {
  const a = createState(), b = createState();
  a.pattern[0][0] = !a.pattern[0][0];
  a.params['ch1.event.interval'].div = 'x';
  a.timelines[0].events.push({});
  assert.notEqual(a.pattern[0][0], b.pattern[0][0]);
  assert.equal(b.params['ch1.event.interval'].div, '1/4');
  assert.equal(b.timelines[0].events.length, 0);
});

test('set clamps numerics and get reads back', () => {
  const st = createStore(createState());
  st.set('ch1.filter.center', 5);
  assert.equal(st.get('ch1.filter.center'), 1);
  st.set('ch1.filter.center', -5);
  assert.equal(st.get('ch1.filter.center'), 0);
  st.set('ch1.filter.center', 0.25);
  assert.equal(st.get('ch1.filter.center'), 0.25);
  assert.equal(st.state.params['ch1.filter.center'], 0.25);
});

test('set throws on unknown id, bad enum, non-finite number, bad time', () => {
  const st = createStore(createState());
  assert.throws(() => st.set('ch9.foo', 1), /ch9\.foo/);
  assert.throws(() => st.get('ch9.foo'), /ch9\.foo/);
  assert.throws(() => st.set('ch1.source.polarity', 'nope'), /polarity/);
  assert.throws(() => st.set('ch1.filter.center', NaN));
  assert.throws(() => st.set('ch1.filter.center', 'x'));
  assert.throws(() => st.set('ch1.event.interval', 3));
  assert.throws(() => st.set('ch1.event.interval', { mode: 'bogus' }));
  assert.equal(st.get('ch1.source.polarity'), 'dips');
});

test('set accepts valid enum, bool coercion, time, id', () => {
  const st = createStore(createState());
  st.set('ch1.source.polarity', 'both');
  st.set('ch1.vwin.mode', 2);
  st.set('ch1.strip.mute', 1);
  st.set('ch1.event.interval', { mode: 'hz', value: 2 });
  st.set('ch1.source.layer', 'L1');
  assert.equal(st.get('ch1.source.polarity'), 'both');
  assert.equal(st.get('ch1.vwin.mode'), 2);
  assert.equal(st.get('ch1.strip.mute'), true);
  assert.deepEqual(st.get('ch1.event.interval'), { mode: 'hz', value: 2 });
  assert.equal(st.get('ch1.source.layer'), 'L1');
  assert.throws(() => st.set('ch1.source.layer', 5));
});

test('subscribers fire exactly once per successful set, with (id, value)', () => {
  const st = createStore(createState());
  const calls = [];
  const off = st.subscribe((id, v) => calls.push([id, v]));
  st.set('g.master.gain', 0.5);
  assert.deepEqual(calls, [['g.master.gain', 0.5]]);
  st.set('g.master.gain', 9);
  assert.deepEqual(calls[1], ['g.master.gain', 1]);
  assert.throws(() => st.set('nope', 1));
  assert.equal(calls.length, 2);
  off();
  st.set('g.master.gain', 0.2);
  assert.equal(calls.length, 2);
});

test('addRoute / removeRoute: clamp, replace, validate', () => {
  const st = createStore(createState());
  const n0 = st.state.matrix.length;
  st.addRoute({ src: 'g.lfo1', dst: 'ch1.filter.center', amount: 3 });
  assert.equal(st.state.matrix.length, n0 + 1);
  assert.equal(st.state.matrix.at(-1).amount, 1);
  st.addRoute({ src: 'g.lfo1', dst: 'ch1.filter.center', amount: -0.5 });
  assert.equal(st.state.matrix.length, n0 + 1);
  assert.equal(st.state.matrix.at(-1).amount, -0.5);
  st.addRoute({ src: 'g.cc74', dst: 'g.master.gain', amount: -9 });
  assert.equal(st.state.matrix.at(-1).amount, -1);
  assert.throws(() => st.addRoute({ src: 'g.bogus', dst: 'ch1.filter.center', amount: 1 }), /g\.bogus/);
  assert.throws(() => st.addRoute({ src: 'g.lfo1', dst: 'ch1.nope', amount: 1 }), /ch1\.nope/);
  assert.throws(() => st.addRoute({ src: 'g.lfo1', dst: 'ch1.source.mode', amount: 1 }), /source\.mode/);
  assert.throws(() => st.addRoute({ src: 'g.lfo3', dst: 'ch1.filter.center', amount: 1 }));
  assert.throws(() => st.addRoute({ src: 'ch5.lfo1', dst: 'ch1.filter.center', amount: 1 }));
  st.removeRoute('g.lfo1', 'ch1.filter.center');
  assert.equal(st.state.matrix.length, n0 + 1);
  assert.ok(!st.state.matrix.some(r => r.src === 'g.lfo1'));
});

test('patch JSON has v:4 and app', () => {
  const p = JSON.parse(serializePatch(createState(), []));
  assert.equal(p.v, 4);
  assert.equal(p.app, 'spectrum-listening-station');
  for (const k of ['params', 'mods', 'timelines', 'pattern', 'matrix', 'layers']) assert.ok(k in p, k);
});

test('serialize -> deserialize round-trips deep-equal', () => {
  const st = createStore(createState());
  st.set('ch2.filter.center', 0.77);
  st.set('ch3.source.polarity', 'both');
  st.set('ch1.event.interval', { mode: 'sec', value: 1.5 });
  st.set('ch1.source.layer', 'L1');
  st.addRoute({ src: 'ch2.lfo2', dst: 'g.master.gain', amount: -0.25 });
  st.state.layers = ['L1'];
  st.state.mods.ch1.lfo[0].shape = 'ramp';
  st.state.pattern[2][3] = true;
  st.state.timelines[1].events.push({ t: 1, p: { 'ch2.filter.center': 0.1 } });
  const r = deserializePatch(serializePatch(st.state, [LAYER]));
  assert.deepEqual(r.state, st.state);
  assert.deepEqual(r.layers, [LAYER]);
  assert.deepEqual(r.warnings, []);
});

test('deserialize rejects wrong app, wrong version, bad JSON', () => {
  const good = JSON.parse(serializePatch(createState(), []));
  assert.throws(() => deserializePatch(JSON.stringify({ ...good, app: 'other' })), /app/);
  assert.throws(() => deserializePatch(JSON.stringify({ ...good, v: 3 })), /version|v3|v4/);
  assert.throws(() => deserializePatch('{nope'), /JSON/);
  assert.throws(() => deserializePatch('null'));
});

test('missing params keep defaults; out-of-range values clamp silently', () => {
  const good = JSON.parse(serializePatch(createState(), []));
  delete good.params['ch2.filter.width'];
  good.params['ch1.filter.center'] = 7;
  const r = deserializePatch(JSON.stringify(good));
  assert.equal(r.state.params['ch2.filter.width'], paramDef('ch2.filter.width').default);
  assert.equal(r.state.params['ch1.filter.center'], 1);
  assert.deepEqual(r.warnings, []);
});

test('(RF2) unknown param id and invalid route load with two warnings, no throw', () => {
  const good = JSON.parse(serializePatch(createState(), []));
  good.params['ch9.foo'] = 1;
  good.matrix.push({ src: 'g.lfo1', dst: 'ch1.nope', amount: 0.5 });
  let r;
  assert.doesNotThrow(() => { r = deserializePatch(JSON.stringify(good)); });
  assert.equal(r.warnings.length, 2);
  assert.ok(r.warnings.some(w => w.includes('ch9.foo')));
  assert.ok(r.warnings.some(w => w.includes('ch1.nope')));
  assert.ok(!('ch9.foo' in r.state.params));
  assert.equal(r.state.matrix.length, 4);
});

test('loaded routes: amounts clamp, non-modulatable and bad source dropped, duplicates collapse', () => {
  const good = JSON.parse(serializePatch(createState(), []));
  good.matrix = [
    { src: 'g.lfo1', dst: 'ch1.filter.center', amount: 5 },
    { src: 'g.lfo1', dst: 'ch1.filter.center', amount: -5 },
    { src: 'g.lfo1', dst: 'ch1.source.mode', amount: 1 },
    { src: 'bogus.src', dst: 'ch1.filter.width', amount: 1 },
  ];
  const r = deserializePatch(JSON.stringify(good));
  assert.deepEqual(r.state.matrix, [{ src: 'g.lfo1', dst: 'ch1.filter.center', amount: -1 }]);
  assert.equal(r.warnings.length, 2);
  assert.ok(r.warnings.some(w => w.includes('ch1.source.mode')));
  assert.ok(r.warnings.some(w => w.includes('bogus.src')));
});

test('every modulatable id is a valid route destination', () => {
  const st = createStore(createState());
  for (const id of modulatableIds()) st.addRoute({ src: 'g.lfo2', dst: id, amount: 0.1 });
});

test('route changes notify subscribers once with (matrix, copy of matrix)', () => {
  const st = createStore(createState());
  const calls = [];
  st.subscribe((id, v) => calls.push([id, v]));
  st.addRoute({ src: 'g.lfo1', dst: 'ch1.filter.center', amount: 0.5 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'matrix');
  assert.deepEqual(calls[0][1], st.state.matrix);
  assert.notEqual(calls[0][1], st.state.matrix);
  // replace amount
  st.addRoute({ src: 'g.lfo1', dst: 'ch1.filter.center', amount: 0.25 });
  assert.equal(calls.length, 2);
  assert.equal(calls[1][1].find(r => r.src === 'g.lfo1').amount, 0.25);
  // unchanged amount: no notify
  st.addRoute({ src: 'g.lfo1', dst: 'ch1.filter.center', amount: 0.25 });
  assert.equal(calls.length, 2);
  // invalid add: throws, no notify
  assert.throws(() => st.addRoute({ src: 'g.bogus', dst: 'ch1.filter.center', amount: 1 }));
  assert.equal(calls.length, 2);
  // no-op remove
  st.removeRoute('g.lfo2', 'ch1.filter.center');
  assert.equal(calls.length, 2);
  // real remove
  st.removeRoute('g.lfo1', 'ch1.filter.center');
  assert.equal(calls.length, 3);
  assert.equal(calls[2][0], 'matrix');
  assert.ok(!calls[2][1].some(r => r.src === 'g.lfo1'));
  // the copy passed to subscribers is detached from state
  calls[2][1].length = 0;
  assert.equal(st.state.matrix.length, 4);
});

// ---- Task 18: non-param store setters ------------------------------------------------------

const mk = () => { const store = createStore(createState()); const calls = []; store.subscribe((id, v) => calls.push([id, v])); return { store, calls }; };

test('LFO_SHAPES is the modulation list (single source)', async () => {
  const { LFO_SHAPES } = await import('../../src/core/state.js');
  const mod = await import('../../src/core/modulation.js');
  assert.equal(LFO_SHAPES, mod.LFO_SHAPES);
  assert.deepEqual(LFO_SHAPES, ['sine', 'tri', 'ramp', 'square', 'steps', 'drift']);
});

test('setPatternStep writes and notifies once; rejects bad input', () => {
  const { store, calls } = mk();
  store.setPatternStep(2, 5, true);
  assert.equal(store.state.pattern[2][5], true);
  assert.deepEqual(calls, [['pattern', { ch: 2, i: 5, on: true }]]);
  for (const [c, i, on] of [[4, 0, true], [-1, 0, true], [0, 16, true], [0, -1, true], [0, 1.5, true], [0, 0, 1], [0.5, 0, true]]) {
    assert.throws(() => store.setPatternStep(c, i, on), c + ',' + i + ',' + on);
  }
  assert.equal(calls.length, 1);
});

test('setTimeline merges, clamps, sorts and notifies', () => {
  const { store, calls } = mk();
  store.setTimeline(1, { mode: 'jump', len: { mode: 'beats', div: '1/4' }, events: [{ t: 0.5, c: 2, w: -3, extra: 9 }, { t: 0.1, c: 0.3 }] });
  const tl = store.state.timelines[1];
  assert.equal(tl.mode, 'jump');
  assert.deepEqual(tl.len, { mode: 'beats', div: '1/4' });
  assert.deepEqual(tl.events, [{ t: 0.1, c: 0.3 }, { t: 0.5, c: 1, w: 0.02 }]);
  assert.deepEqual(calls, [['timeline', { ch: 1 }]]);
  store.setTimeline(1, { mode: 'morph' });
  assert.equal(store.state.timelines[1].events.length, 2, 'partial patch keeps events');
  assert.equal(calls.length, 2);
});

test('setTimeline rejects invalid input atomically', () => {
  const { store, calls } = mk();
  const before = JSON.stringify(store.state.timelines);
  const bad = [
    [4, {}], [0, null], [0, { mode: 'x' }], [0, { len: { mode: 'sec', value: 0 } }], [0, { len: { mode: 'beats', div: '9/9' } }],
    [0, { events: {} }], [0, { events: [{ t: 1 }] }], [0, { events: [{ t: -0.1 }] }], [0, { events: [{ t: NaN }] }],
    [0, { events: [{ t: 0.2, c: NaN }] }], [0, { mode: 'jump', events: [{ t: 0.2, c: 'a' }] }], [0, { events: [3] }],
  ];
  for (const [c, p] of bad) assert.throws(() => store.setTimeline(c, p), JSON.stringify(p));
  assert.equal(JSON.stringify(store.state.timelines), before);
  assert.equal(calls.length, 0);
});

test('setMod lfo: valid, clamp-free fields, notifies', () => {
  const { store, calls } = mk();
  store.setMod('ch3', 'lfo', 1, { shape: 'drift', rate: { mode: 'hz', value: 2 }, phase: 0.5, seed: 42 });
  assert.deepEqual(store.state.mods.ch3.lfo[1], { shape: 'drift', rate: { mode: 'hz', value: 2 }, phase: 0.5, seed: 42 });
  store.setMod('g', 'lfo', 0, { shape: 'steps' });
  assert.deepEqual(calls, [['mods', { owner: 'ch3', kind: 'lfo', index: 1 }], ['mods', { owner: 'g', kind: 'lfo', index: 0 }]]);
});

test('setMod env clamps to ranges', () => {
  const { store } = mk();
  store.setMod('ch1', 'env', 0, { a: 0, h: 99, d: 0 });
  assert.deepEqual(store.state.mods.ch1.env[0], { a: 0.002, h: 4, d: 0.05 });
  store.setMod('ch1', 'env', 1, { a: 100, d: 100 });
  assert.equal(store.state.mods.ch1.env[1].a, 3);
  assert.equal(store.state.mods.ch1.env[1].d, 10);
});

test('setMod rejects invalid input without notifying', () => {
  const { store, calls } = mk();
  const bad = [
    ['x', 'lfo', 0, {}], ['ch1', 'foo', 0, {}], ['ch1', 'lfo', 2, {}], ['ch1', 'lfo', -1, {}], ['g', 'env', 0, { a: 1 }],
    ['ch1', 'lfo', 0, { shape: 'saw' }], ['ch1', 'lfo', 0, { rate: { mode: 'hz', value: -1 } }], ['ch1', 'lfo', 0, { rate: 3 }],
    ['ch1', 'lfo', 0, { phase: 1 }], ['ch1', 'lfo', 0, { phase: NaN }], ['ch1', 'lfo', 0, { seed: 1.5 }], ['ch1', 'lfo', 0, { a: 1 }],
    ['ch1', 'env', 0, { a: NaN }], ['ch1', 'env', 0, { shape: 'sine' }], ['ch1', 'env', 0, null], ['__proto__', 'lfo', 0, {}],
  ];
  for (const [o, k, i, p] of bad) assert.throws(() => store.setMod(o, k, i, p), `${o} ${k} ${i} ${JSON.stringify(p)}`);
  assert.equal(calls.length, 0);
  assert.deepEqual(store.state.mods.ch1.lfo[0], createState().mods.ch1.lfo[0]);
});

test('a patch with an invalid field changes nothing (all-or-nothing)', () => {
  const { store } = mk();
  assert.throws(() => store.setMod('ch1', 'lfo', 0, { shape: 'ramp', phase: 5 }));
  assert.equal(store.state.mods.ch1.lfo[0].shape, 'sine');
});

test('subscriberCount tracks subscribe/unsubscribe', () => {
  const store = createStore(createState());
  assert.equal(store.subscriberCount(), 0);
  const off = store.subscribe(() => {});
  assert.equal(store.subscriberCount(), 1);
  off();
  assert.equal(store.subscriberCount(), 0);
});

test('store.load replaces the content in place and notifies everything that changed', async () => {
  const { deserializePatch, serializePatch, createState, createStore } = await import('../../src/core/state.js');
  const a = createState(); a.params['ch1.filter.center'] = 0.77; a.matrix.push({ src: 'g.lfo1', dst: 'ch2.filter.width', amount: 0.3 });
  a.timelines[0].events = [{ t: 0.5, c: 0.3 }]; a.pattern[1][0] = false;
  const { state: loaded } = deserializePatch(serializePatch(a, []));
  const store = createStore(createState()), held = store.state, seen = [];
  store.subscribe((id, v) => seen.push([id, v]));
  store.load(loaded);
  assert.equal(store.state, held, 'the state object identity is preserved');
  assert.equal(store.get('ch1.filter.center'), 0.77);
  assert.equal(store.state.matrix.length, 5);
  assert.deepEqual(store.state.timelines[0].events, [{ t: 0.5, c: 0.3 }]);
  assert.equal(store.state.pattern[1][0], false);
  const ids = seen.map(x => x[0]);
  assert.ok(ids.includes('ch1.filter.center') && ids.includes('matrix'));
  assert.equal(ids.filter(i => i === 'timeline').length, 4);
  assert.equal(ids.filter(i => i === 'pattern').length, 4);
  assert.equal(ids.filter(i => i === 'mods').length, 2 * 5 + 2 * 4 + 0 * 1, 'g: 2 lfo; ch1..4: 2 lfo + 2 env each');
  assert.throws(() => store.load({}), /not a valid state/);
  assert.throws(() => store.load(null), /not a valid state/);
});
