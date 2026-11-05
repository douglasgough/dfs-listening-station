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
