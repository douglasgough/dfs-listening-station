import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timelineOverrides, TL_KEYS } from '../../src/core/timeline.js';

const T0 = { beat: 0, sec: 0 };
const near = (a, b, eps = 1e-12) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);
const two = (extra = {}) => ({
  len: { mode: 'sec', value: 8 }, mode: 'morph',
  events: [{ t: 0, c: 0.2 }, { t: 0.5, c: 0.8 }], ...extra,
});
const at = (tl, phase, opts) => timelineOverrides(tl, T0, 120, { ...opts, hold: phase })['filter.center'];

test('TL_KEYS maps the ten short keys to param keys in order', () => {
  assert.deepEqual(TL_KEYS, [
    ['c', 'filter.center'], ['w', 'filter.width'], ['s', 'filter.soft'], ['l', 'filter.level'],
    ['z', 'grain.size'], ['d', 'grain.density'], ['x', 'grain.scatter'],
    ['y', 'vwin.center'], ['h', 'vwin.height'], ['q', 'vwin.soft'],
  ]);
});

test('no events (empty or missing) gives null', () => {
  assert.equal(timelineOverrides({ len: { mode: 'sec', value: 8 }, mode: 'morph', events: [] }, T0, 120), null);
  assert.equal(timelineOverrides({ len: { mode: 'sec', value: 8 }, mode: 'morph' }, T0, 120), null);
  assert.equal(timelineOverrides(null, T0, 120), null);
  assert.equal(timelineOverrides({ events: [{ t: NaN, c: 1 }] }, T0, 120), null);
});

test('single event gives its values at any phase, keyed by param key', () => {
  const ev = { t: 0.3, c: 0.1, w: 0.2, s: 0.3, l: 0.4, z: 0.5, d: 0.6, x: 0.7, y: 0.8, h: 0.9, q: 0.05 };
  for (const mode of ['morph', 'jump']) {
    for (const p of [0, 0.1, 0.3, 0.99]) {
      const o = timelineOverrides({ len: { mode: 'sec', value: 8 }, mode, events: [ev] }, T0, 120, { hold: p });
      assert.deepEqual(o, {
        'filter.center': 0.1, 'filter.width': 0.2, 'filter.soft': 0.3, 'filter.level': 0.4,
        'grain.size': 0.5, 'grain.density': 0.6, 'grain.scatter': 0.7,
        'vwin.center': 0.8, 'vwin.height': 0.9, 'vwin.soft': 0.05,
      });
    }
  }
});

test('morph: two events interpolate and wrap back to the first', () => {
  const tl = two();
  near(at(tl, 0), 0.2);
  near(at(tl, 0.25), 0.5);
  near(at(tl, 0.5), 0.8);
  near(at(tl, 0.75), 0.5);
  near(at(tl, 1 - 1e-9), 0.2, 1e-6);
});

test('morph: first event after 0 wraps from the last event', () => {
  const tl = two({ events: [{ t: 0.25, c: 0.2 }, { t: 0.75, c: 0.8 }] });
  near(at(tl, 0.25), 0.2);
  near(at(tl, 0.5), 0.5);
  near(at(tl, 0.75), 0.8);
  near(at(tl, 0), 0.5);   // halfway from 0.8 (t=-0.25) to 0.2 (t=0.25)
  near(at(tl, 0.9), 0.8 + (0.2 - 0.8) * 0.15 / 0.5);
});

test('jump: last event at or before phase; before the first event wraps to the last', () => {
  const tl = two({ mode: 'jump' });
  for (const p of [0, 0.1, 0.4999]) near(at(tl, p), 0.2);
  for (const p of [0.5, 0.7, 0.9999]) near(at(tl, p), 0.8);
  const late = two({ mode: 'jump', events: [{ t: 0.25, c: 0.2 }, { t: 0.5, c: 0.8 }] });
  near(at(late, 0.1), 0.8);
  near(at(late, 0.25), 0.2);
  near(at(late, 0.6), 0.8);
});

test('unsorted input gives the same result as sorted, and is not mutated', () => {
  const sorted = two();
  const events = [{ t: 0.5, c: 0.8 }, { t: 0, c: 0.2 }];
  const un = two({ events });
  for (const p of [0, 0.1, 0.25, 0.5, 0.75, 0.99]) assert.deepEqual(at(un, p), at(sorted, p));
  assert.deepEqual(events, [{ t: 0.5, c: 0.8 }, { t: 0, c: 0.2 }]);
});

test('beats length follows tempo through t.beat', () => {
  const tl = two({ len: { mode: 'beats', div: '4 bars' } }); // 16 beats
  const v = (beat) => timelineOverrides(tl, { beat, sec: 0 }, 120)['filter.center'];
  near(v(8), 0.8);
  near(v(4), 0.5);
  near(v(16), 0.2);
  near(v(24), 0.8);
  // a different tempo reaches a different beat at the same wall time
  const sec = 4; // 8 beats at 120 bpm, 4 beats at 60 bpm
  near(timelineOverrides(tl, { beat: sec * 2, sec }, 120)['filter.center'], 0.8);
  near(timelineOverrides(tl, { beat: sec * 1, sec }, 60)['filter.center'], 0.5);
});

test('hz and sec lengths use seconds', () => {
  const hz = two({ len: { mode: 'hz', value: 0.25 } });
  const v = (tl, sec) => timelineOverrides(tl, { beat: 99, sec }, 120)['filter.center'];
  near(v(hz, 2), 0.8);
  near(v(hz, 1), 0.5);
  const sc = two({ len: { mode: 'sec', value: 8 } });
  near(v(sc, 4), 0.8);
  near(v(sc, 12), 0.8);
  near(v(sc, -4), 0.8); // negative time wraps
});

test('loop mode: whole number of repeats per loop; without loop mode they differ', () => {
  const tl = two({ len: { mode: 'sec', value: 3 } });
  let differs = 0;
  for (let i = 0; i < 40; i++) {
    const sec = i * 0.37;
    const a = timelineOverrides(tl, { beat: 0, sec }, 120, { loopSec: 10 })['filter.center'];
    const b = timelineOverrides(tl, { beat: 0, sec: sec + 10 }, 120, { loopSec: 10 })['filter.center'];
    near(a, b);
    const c = timelineOverrides(tl, { beat: 0, sec }, 120)['filter.center'];
    const d = timelineOverrides(tl, { beat: 0, sec: sec + 10 }, 120)['filter.center'];
    if (Math.abs(c - d) > 1e-6) differs++;
  }
  assert.ok(differs > 20, `${differs}`);
});

test('loop mode with a length longer than the loop plays once per loop (N >= 1)', () => {
  const tl = two({ len: { mode: 'sec', value: 40 } });
  const v = sec => timelineOverrides(tl, { beat: 0, sec }, 120, { loopSec: 10 })['filter.center'];
  near(v(0), 0.2);
  near(v(5), 0.8); // stretched to 10 s
  near(v(15), 0.8);
});

test('hold overrides time', () => {
  const tl = two();
  for (const sec of [0, 1.3, 5, 100]) {
    near(timelineOverrides(tl, { beat: 0, sec }, 120, { hold: 0.25 })['filter.center'], 0.5);
  }
  // null / undefined hold does not freeze
  near(timelineOverrides(tl, { beat: 0, sec: 4 }, 120, { hold: null })['filter.center'], 0.8);
  near(timelineOverrides(tl, { beat: 0, sec: 4 }, 120, { hold: undefined })['filter.center'], 0.8);
});

test('events with a missing or non-finite key omit that param', () => {
  const tl = { len: { mode: 'sec', value: 8 }, mode: 'morph', events: [{ t: 0, c: 0.2, w: 0.1 }, { t: 0.5, c: 0.8 }] };
  const o = timelineOverrides(tl, T0, 120, { hold: 0.25 });
  assert.deepEqual(Object.keys(o), ['filter.center']);
  const o1 = timelineOverrides({ len: tl.len, mode: 'jump', events: [{ t: 0, c: 0.4, w: NaN, s: 'x' }] }, T0, 120);
  assert.deepEqual(o1, { 'filter.center': 0.4 });
});

test('events with non-finite t are ignored', () => {
  const tl = two({ events: [{ t: NaN, c: 0.9 }, { t: 0, c: 0.2 }, { t: 0.5, c: 0.8 }, { t: Infinity, c: 0.1 }, { c: 0.7 }] });
  near(at(tl, 0.25), 0.5);
});

test('invalid len falls back to a 10 s period; outputs are finite', () => {
  for (const len of [undefined, null, { mode: 'sec', value: 0 }, { mode: 'beats', div: 'nope' }, { mode: 'hz', value: NaN }]) {
    const tl = two({ len });
    near(timelineOverrides(tl, { beat: 0, sec: 5 }, 120)['filter.center'], 0.8);
    const o = timelineOverrides(tl, { beat: 3, sec: 7 }, NaN, { loopSec: 20 });
    for (const x of Object.values(o)) assert.ok(Number.isFinite(x));
  }
});

test('all outputs finite over a sweep', () => {
  const tl = two({ events: [{ t: 0.9, c: 0.1, w: 0.2 }, { t: 0.1, c: 0.5, w: 0.4 }, { t: 0.1, c: 0.6, w: 0.5 }] });
  for (let i = 0; i < 200; i++) {
    for (const opts of [undefined, { loopSec: 7 }]) {
      for (const x of Object.values(timelineOverrides(tl, { beat: i * 0.31, sec: i * 0.17 - 5 }, 90, opts))) {
        assert.ok(Number.isFinite(x));
      }
    }
  }
});
