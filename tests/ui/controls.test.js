import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatParam, toSliderPos, fromSliderPos, LOG_TAPER, noteName } from '../../src/ui/controls.js';
import { paramDef, CHANNEL_PARAMS } from '../../src/core/schema.js';
import { createState, createStore } from '../../src/core/state.js';
import { onParams } from '../../src/ui/store-bind.js';

const d = id => paramDef(id);

test('LOG_TAPER membership', () => {
  assert.deepEqual([...LOG_TAPER].sort(), ['event.rpm', 'filter.width', 'grain.dur', 'map.f0', 'map.hi', 'map.lo', 'vwin.height']);
});

test('formatParam per-key formats', () => {
  assert.equal(formatParam(d('ch1.filter.soft'), 0.35), '35%');
  assert.equal(formatParam(d('ch1.event.level'), 1), '0.0 dB');
  assert.equal(formatParam(d('ch1.event.level'), 0), 'off');
  assert.equal(formatParam(d('g.master.gain'), 0.5), '-6.0 dB');
  assert.equal(formatParam(d('ch1.map.f0'), 27.5), '27.5 Hz · A0');
  assert.equal(formatParam(d('ch1.map.lo'), 110), '110 Hz');
  assert.equal(formatParam(d('ch1.map.hi'), 3520), '3.52 kHz');
  assert.equal(formatParam(d('ch1.source.shift'), 123), '+123 km/s');
  assert.equal(formatParam(d('ch1.source.shift'), -50), '−50 km/s');
  assert.equal(formatParam(d('ch1.source.sens'), 0.05), 'many');
  assert.equal(formatParam(d('ch1.source.sens'), 0.7), 'few');
  assert.equal(formatParam(d('ch1.source.sens'), 0.2), '0.20');
  assert.equal(formatParam(d('ch1.grain.dur'), 1.2), '1.20 s');
  assert.equal(formatParam(d('ch1.grain.dur'), 0.25), '250 ms');
  assert.equal(formatParam(d('ch1.grain.speed'), 0), 'still');
  assert.match(formatParam(d('ch1.grain.speed'), 0.2), /drifting/);
  assert.equal(formatParam(d('ch1.grain.density'), 0), '0.2 per s');
  assert.equal(formatParam(d('ch1.event.rpm'), 6), '6.0 per min');
  assert.equal(formatParam(d('ch1.filter.width'), 1), 'whole spectrum');
  assert.equal(formatParam(d('ch1.strip.fader'), 60 / 66), '0.0 dB');
});

test('formatParam generic fallback and non-num types', () => {
  assert.equal(formatParam(d('ch1.event.jitter'), 0.3), '30%');
  assert.equal(formatParam({ key: 'zzz', unit: 'Hz', type: 'num' }, 123.456), '123 Hz');
  assert.equal(formatParam({ key: 'zzz', unit: '', type: 'num' }, 0.012345), '0.0123');
  assert.equal(formatParam(d('ch1.filter.on'), true), 'on');
  assert.equal(formatParam(d('ch1.event.interval'), { mode: 'beats', div: '1/8' }), '1/8');
  assert.equal(formatParam(d('ch1.event.interval'), { mode: 'sec', value: 2.5 }), '2.5 s');
});

test('every numeric channel param formats to a non-empty string at min, default, max', () => {
  for (const p of CHANNEL_PARAMS) {
    if (p.type !== 'num') continue;
    for (const v of [p.min, p.default, p.max]) {
      const s = formatParam(p, v);
      assert.ok(typeof s === 'string' && s.length > 0 && !s.includes('NaN'), `${p.key} ${v} -> ${s}`);
    }
  }
});

test('slider position round trips (linear and log)', () => {
  for (const id of ['ch1.filter.center', 'ch1.filter.width', 'ch1.map.f0', 'ch1.event.rpm', 'ch1.source.shift', 'ch1.grain.dur']) {
    const def = d(id);
    assert.equal(toSliderPos(def, def.min), 0);
    assert.equal(toSliderPos(def, def.max), 1000);
    assert.ok(Math.abs(fromSliderPos(def, 0) - def.min) < 1e-9);
    assert.ok(Math.abs(fromSliderPos(def, 1000) - def.max) < 1e-9);
    for (const s of [1, 250, 500, 777, 999]) assert.ok(Math.abs(toSliderPos(def, fromSliderPos(def, s)) - s) < 1e-6, `${id} ${s}`);
  }
  // log taper: geometric midpoint at half travel; linear: arithmetic midpoint
  assert.ok(Math.abs(fromSliderPos(d('ch1.map.lo'), 500) - Math.sqrt(40 * 800)) < 1e-9);
  assert.equal(fromSliderPos(d('ch1.source.shift'), 500), 0);
  assert.equal(toSliderPos(d('ch1.map.lo'), 1e6), 1000);
});

test('noteName', () => { assert.equal(noteName(440), 'A4'); });

test('onParams filters ids (array, Set, predicate) and unsubscribes', () => {
  const store = createStore(createState());
  const seen = [];
  const off1 = onParams(store, ['ch1.filter.center'], (i, v) => seen.push(['a', i, v]));
  const off2 = onParams(store, new Set(['ch2.filter.center']), (i) => seen.push(['b', i]));
  const off3 = onParams(store, id => id.startsWith('g.'), (i) => seen.push(['c', i]));
  store.set('ch1.filter.center', 0.1); store.set('ch2.filter.center', 0.2); store.set('g.master.gain', 0.5); store.set('ch3.filter.center', 0.3);
  assert.deepEqual(seen, [['a', 'ch1.filter.center', 0.1], ['b', 'ch2.filter.center'], ['c', 'g.master.gain']]);
  off1(); off2(); off3();
  store.set('ch1.filter.center', 0.9);
  assert.equal(seen.length, 3);
});

test('onParams ignores the non-param notifications (pattern, timeline, mods, matrix)', () => {
  const store = createStore(createState());
  const seen = [];
  onParams(store, ['ch1.filter.center'], (id) => seen.push(id));
  store.setPatternStep(0, 1, true);
  store.setTimeline(0, { mode: 'jump' });
  store.setMod('ch1', 'env', 0, { a: 0.5 });
  store.addRoute({ src: 'ch1.lfo1', dst: 'ch1.filter.center', amount: 0.2 });
  assert.deepEqual(seen, []);
  store.set('ch1.filter.center', 0.4);
  assert.deepEqual(seen, ['ch1.filter.center']);
});

test('the stage watch pattern does not match non-param notification ids', () => {
  const WATCH = /^ch[1-4]\.(filter|vwin|map|source|grain)\./;
  for (const id of ['pattern', 'timeline', 'mods', 'matrix']) assert.equal(WATCH.test(id), false);
});
