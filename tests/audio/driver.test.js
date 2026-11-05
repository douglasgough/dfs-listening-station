import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planSpan, Driver } from '../../src/audio/driver.js';
import { createState, createStore } from '../../src/core/state.js';
import { Transport } from '../../src/core/transport.js';
import { analyse } from '../../src/spectrum/analyse.js';
import { EXAMPLE_LAYERS } from '../../src/spectrum/examples.js';

const allende = EXAMPLE_LAYERS.find(l => l.id === 'allende');
const STAGE = { unit: allende.axis.unit, x0: allende.axis.x0, x1: allende.axis.x1 };
const A = analyse(allende, STAGE, { polarity: 'dips', sens: 0.2, mode: 'hull' });
const EPS = 1e-9;

// ---- planSpan --------------------------------------------------------------------------------

test('planSpan: null when the cursor is already a lookahead ahead', () => {
  assert.equal(planSpan(1.5, 1, 0.5, 0.125), null);
  assert.equal(planSpan(2, 1, 0.5, 0.125), null);
});

test('planSpan: whole frames up to now + lookahead', () => {
  assert.deepEqual(planSpan(1, 1, 0.5, 0.125), { startSec: 1, endSec: 1.5 });
  assert.deepEqual(planSpan(1.25, 1, 0.5, 0.125), { startSec: 1.25, endSec: 1.5 });
  // less than one step left: still one whole frame (n >= 1)
  assert.deepEqual(planSpan(1.45, 1, 0.5, 0.125), { startSec: 1.45, endSec: 1.45 + 0.125 });
  // decimal steps: endSec - startSec is a whole number of steps and lands within one step of the target
  for (const [cursor, now, la, step] of [[10, 10, 0.12, 0.04], [3.3, 3.29, 0.12, 0.04], [0, 0, 0.12, 0.025], [7.1, 7.05, 0.12, 0.025]]) {
    const s = planSpan(cursor, now, la, step);
    assert.equal(s.startSec, cursor);
    const n = Math.round((s.endSec - s.startSec) / step);
    assert.ok(n >= 1);
    assert.equal(s.endSec, cursor + n * step);
    assert.ok(s.endSec <= now + la + EPS, `${s.endSec} past ${now + la}`);
    assert.ok(s.endSec > now + la - step - EPS, `${s.endSec} short of ${now + la}`);
  }
});

test('planSpan: 0.025 step gives more, smaller frames', () => {
  const s = planSpan(0, 0, 0.125, 0.025);
  assert.equal(Math.round((s.endSec - s.startSec) / 0.025), 5);
});

test('planSpan: restarts at now when the cursor fell more than 0.25 s behind', () => {
  assert.deepEqual(planSpan(0.5, 1, 0.5, 0.125), { startSec: 1, endSec: 1.5 });
  // only 0.2 s behind: keeps the cursor (catches up)
  assert.deepEqual(planSpan(0.75, 0.95, 0.5, 0.125), { startSec: 0.75, endSec: 1.375 });
});

// ---- Driver with a fake graph and timer --------------------------------------------------------

function fakeGraph(t0 = 0) {
  const channels = [0, 1, 2, 3].map(() => ({
    sent: [], enabled: [],
    send(fr) { this.sent.push(fr); },
    setEnabled(on) { this.enabled.push(on); },
  }));
  const mixer = { calls: [], apply(strips, master, t) { this.calls.push({ strips, master, t }); } };
  return { ctx: { currentTime: t0 }, channels, mixer };
}

function fakeTimer() {
  const timer = { fn: null, ms: null, sets: 0, clears: 0 };
  timer.setIntervalFn = (fn, ms) => { timer.fn = fn; timer.ms = ms; timer.sets++; return 42; };
  timer.clearIntervalFn = (id) => { assert.equal(id, 42); timer.fn = null; timer.clears++; };
  return timer;
}

function setup(edit = () => {}, t0 = 0) {
  const state = createState();
  edit(state);
  const store = createStore(state);
  const transport = new Transport({ bpm: 120 });
  transport.start(t0);
  const graph = fakeGraph(t0);
  const timer = fakeTimer();
  const driver = new Driver({
    graph, store, transport, getAnalyses: () => [A, A, A, A], getStage: () => STAGE,
    setIntervalFn: timer.setIntervalFn, clearIntervalFn: timer.clearIntervalFn,
  });
  return { store, transport, graph, timer, driver };
}

/** Advance the fake context clock by dt and fire one tick. */
function step(env, dt = 0.04) {
  env.graph.ctx.currentTime += dt;
  env.timer.fn();
}

const busy = s => { s.params['ch1.event.rpm'] = 60; s.params['ch1.event.chance'] = 1; };

function assertContiguous(times, stepSec) {
  for (let i = 1; i < times.length; i++) {
    const d = times[i] - times[i - 1];
    assert.ok(Math.abs(d - stepSec) < EPS, `gap/duplicate at ${i}: ${times[i - 1]} -> ${times[i]}`);
  }
}

test('Driver: start registers one interval at tickMs; stop clears it; start is idempotent', () => {
  const env = setup();
  env.driver.start();
  env.driver.start();
  assert.equal(env.timer.sets, 1);
  assert.equal(env.timer.ms, 40);
  env.driver.stop();
  assert.equal(env.timer.clears, 1);
  assert.equal(env.timer.fn, null);
  env.driver.stop();
  assert.equal(env.timer.clears, 1);
});

test('Driver: frames tile time (non-decreasing, no duplicate, no gap) and stay a lookahead ahead', () => {
  const env = setup(busy);
  env.driver.start();
  env.timer.fn(); // first tick at t = 0
  for (let i = 0; i < 60; i++) {
    step(env, i % 3 === 0 ? 0.05 : 0.035); // irregular timer jitter
    const sent = env.graph.channels[0].sent;
    const now = env.graph.ctx.currentTime;
    assert.ok(sent[sent.length - 1].t + 0.04 > now + 0.12 - 0.04 - EPS, 'fell short of the lookahead');
    assert.ok(sent[sent.length - 1].t < now + 0.12 + EPS, 'ran past the lookahead');
  }
  const times = env.graph.channels[0].sent.map(f => f.t);
  assert.equal(times[0], 0);
  assertContiguous(times, 0.04);
  // events ride the frame whose interval (t, t + step] contains them
  let nev = 0;
  for (const fr of env.graph.channels[0].sent) {
    for (const e of fr.events) { nev++; assert.ok(e.t > fr.t - EPS && e.t <= fr.t + 0.04 + EPS); }
  }
  assert.ok(nev > 0, 'expected some events at 60/min over ~2 s');
});

test('Driver: disabled channels get setEnabled(false) once and no frames; re-enabled get setEnabled(true)', () => {
  const env = setup(); // defaults: only ch1 enabled
  env.driver.start();
  for (let i = 0; i < 10; i++) step(env);
  for (const c of [1, 2, 3]) {
    assert.deepEqual(env.graph.channels[c].enabled, [false]);
    assert.equal(env.graph.channels[c].sent.length, 0);
  }
  assert.deepEqual(env.graph.channels[0].enabled, []);
  env.store.set('ch3.filter.on', true);
  env.store.set('ch1.filter.on', false);
  const n0 = env.graph.channels[0].sent.length;
  for (let i = 0; i < 5; i++) step(env);
  assert.deepEqual(env.graph.channels[2].enabled, [false, true]);
  assert.ok(env.graph.channels[2].sent.length > 0);
  assert.deepEqual(env.graph.channels[0].enabled, [false]);
  assert.equal(env.graph.channels[0].sent.length, n0);
});

test('Driver: step is 0.025 s while an enabled channel is granular, 0.04 s otherwise', () => {
  const env = setup(s => { s.params['ch2.filter.type'] = 'granular'; }); // ch2 disabled: no effect
  env.driver.start();
  for (let i = 0; i < 5; i++) step(env);
  assertContiguous(env.graph.channels[0].sent.map(f => f.t), 0.04);
  const n0 = env.graph.channels[0].sent.length;
  env.store.set('ch1.filter.type', 'granular');
  for (let i = 0; i < 8; i++) step(env);
  const later = env.graph.channels[0].sent.slice(n0).map(f => f.t);
  assert.ok(later.length >= 8);
  assertContiguous(later, 0.025);
  // the switch itself leaves no gap: the first 0.025 frame starts where the last 0.04 span ended
  const last = env.graph.channels[0].sent[n0 - 1].t;
  assert.ok(Math.abs(later[0] - (last + 0.04)) < EPS);
});

test('Driver: timestamps are converted by clockOffset; setGraph keeps span time monotonic (R18)', () => {
  const env = setup(busy, 5);
  env.driver.start();
  for (let i = 0; i < 25; i++) step(env);
  const lastNow = env.driver.lastNowSec;
  assert.ok(Math.abs(lastNow - 6) < EPS);
  const oldSent = env.graph.channels[0].sent;
  const oldTail = oldSent[oldSent.length - 1].t;

  const g2 = fakeGraph(0.3);
  env.driver.setGraph(g2);
  assert.ok(Math.abs(env.driver.clockOffset - (lastNow - 0.3)) < EPS);
  // new engines start enabled: the disabled channels are switched off again on the new graph
  g2.ctx.currentTime = 0.34;
  env.timer.fn();
  assert.ok(env.driver.lastNowSec > lastNow, 'span time went backwards');
  assert.ok(Math.abs(env.driver.lastNowSec - 6.04) < EPS);
  for (const c of [1, 2, 3]) assert.deepEqual(g2.channels[c].enabled, [false]);
  for (let i = 0; i < 30; i++) { g2.ctx.currentTime += 0.04; env.timer.fn(); }

  const off = env.driver.clockOffset;
  const sent = g2.channels[0].sent;
  // context-time frames on the new graph continue the old span-time grid without a gap or duplicate
  assert.ok(Math.abs(sent[0].t + off - (oldTail + 0.04)) < EPS);
  assertContiguous(sent.map(f => f.t), 0.04);
  assert.ok(sent[0].t > 0.3 && sent[0].t < 0.34 + 0.12 + EPS, `first new frame at ctx ${sent[0].t}`);
  // events are converted with the frames
  let nev = 0;
  for (const fr of sent) {
    for (const e of fr.events) { nev++; assert.ok(e.t > fr.t - EPS && e.t <= fr.t + 0.04 + EPS, `event ${e.t} frame ${fr.t}`); }
  }
  assert.ok(nev > 0);
  // the new graph's mixer is driven every tick, in the new context's time
  assert.equal(g2.mixer.calls.length, 31);
  assert.equal(g2.mixer.calls[0].t, 0.34);
  // nothing more goes to the old graph
  assert.equal(env.graph.channels[0].sent.length, oldSent.length);
});

test('Driver: mixer.apply gets the strips and master from the store, every tick', () => {
  const env = setup();
  env.store.set('ch1.strip.pan', -0.5);
  env.store.set('ch2.strip.fader', 0.5);
  env.store.set('ch3.strip.mute', true);
  env.store.set('ch4.strip.solo', true);
  env.store.set('g.master.gain', 0.3);
  env.driver.start(); // ticks once at once
  step(env);          // nothing changed: applied again anyway (R31.6)
  assert.equal(env.graph.mixer.calls.length, 2);
  const f0 = 60 / 66;
  const expected = [
    { fader: f0, pan: -0.5, mute: false, solo: false },
    { fader: 0.5, pan: 0, mute: false, solo: false },
    { fader: f0, pan: 0, mute: true, solo: false },
    { fader: f0, pan: 0, mute: false, solo: true },
  ];
  for (const [i, call] of env.graph.mixer.calls.entries()) {
    assert.deepEqual(call.strips, expected);
    assert.equal(call.master, 0.3);
    assert.equal(call.t, i === 0 ? 0 : 0.04);
  }
  env.store.set('ch2.strip.fader', 0.25);
  step(env);
  assert.equal(env.graph.mixer.calls.length, 3);
  assert.equal(env.graph.mixer.calls[2].strips[1].fader, 0.25);
  assert.equal(env.graph.mixer.calls[2].t, env.graph.ctx.currentTime);
});

test('Driver: matrix modulation of strip fader and master gain reaches mixer.apply', () => {
  const env = setup(s => {
    s.mods.g.lfo[0] = { shape: 'sine', rate: { mode: 'hz', value: 1 }, phase: 0, seed: 1 };
    s.matrix.push({ src: 'g.lfo1', dst: 'ch1.strip.fader', amount: 0.5 });
    s.matrix.push({ src: 'g.lfo1', dst: 'g.master.gain', amount: 0.5 });
  });
  env.driver.start();
  for (let i = 0; i < 25; i++) step(env);
  const calls = env.graph.mixer.calls;
  assert.equal(calls.length, 26);
  const faders = calls.map(c => c.strips[0].fader), masters = calls.map(c => c.master);
  assert.ok(new Set(faders).size > 10, `fader not modulated: ${faders}`);
  assert.ok(new Set(masters).size > 10, `master not modulated: ${masters}`);
  for (const v of [...faders, ...masters]) assert.ok(v >= 0 && v <= 1, `out of range ${v}`);
  // unrouted strips keep their base value
  for (const c of calls) assert.equal(c.strips[1].fader, 60 / 66);
});

test('Driver: after setGraph the first tick applies the mixer of the new graph', () => {
  const env = setup();
  env.driver.start();
  step(env);
  const g2 = fakeGraph(0.5);
  env.driver.setGraph(g2);
  assert.equal(g2.mixer.calls.length, 0);
  g2.ctx.currentTime = 0.54;
  env.timer.fn();
  assert.equal(g2.mixer.calls.length, 1);
  assert.equal(g2.mixer.calls[0].t, 0.54);
  assert.equal(g2.mixer.calls[0].master, 0.7);
});

test('Driver: a cursor far behind restarts at now without overlapping already-sent frames', () => {
  const env = setup();
  env.driver.start(); // frames from 0 up to ~0.12
  const before = env.graph.channels[0].sent.map(f => f.t);
  env.graph.ctx.currentTime = 2; // the timer stalled for 2 s
  env.timer.fn();
  const after = env.graph.channels[0].sent.slice(before.length).map(f => f.t);
  assert.ok(after.length > 0);
  assert.equal(after[0], 2);
  assert.ok(after[0] > before[before.length - 1]);
  assertContiguous(after, 0.04);
});

test('Driver: converting to context time does not mutate the frames buildScore returned', () => {
  const made = [];
  const fakeScore = (project, span) => {
    const frames = [[], [], [], []];
    for (let c = 0; c < 4; c++) {
      for (let t = span.startSec; t < span.endSec - 1e-9; t += span.stepSec) {
        const fr = { t, events: [{ t: t + 0.01, f: 440 }] };
        frames[c].push(fr);
        made.push({ fr, t, et: t + 0.01 });
      }
    }
    return frames;
  };
  const state = createState();
  const store = createStore(state);
  const transport = new Transport();
  transport.start(10);
  const graph = fakeGraph(10), timer = fakeTimer();
  const driver = new Driver({ graph, store, transport, getAnalyses: () => [A, A, A, A], getStage: () => STAGE,
    setIntervalFn: timer.setIntervalFn, clearIntervalFn: timer.clearIntervalFn, buildScoreFn: fakeScore });
  driver.start();
  const g2 = fakeGraph(1);
  driver.setGraph(g2); // clockOffset 9
  g2.ctx.currentTime = 1.04;
  timer.fn();
  assert.ok(g2.channels[0].sent.length > 0);
  for (const m of made) {
    assert.equal(m.fr.t, m.t);
    assert.equal(m.fr.events[0].t, m.et);
  }
  // and the converted copies are shifted by clockOffset
  const s0 = g2.channels[0].sent[0];
  assert.ok(Math.abs(s0.events[0].t - (s0.t + 0.01)) < 1e-9);
  assert.ok(s0.t < 2);
});

test('Driver never touches the transport', () => {
  const env = setup();
  const before = { running: env.transport.running, bpm: env.transport.bpm };
  env.driver.start();
  for (let i = 0; i < 5; i++) step(env);
  env.driver.stop();
  assert.deepEqual({ running: env.transport.running, bpm: env.transport.bpm }, before);
});

// ---- take / timeline hold / manual trigger (Task 20) ----------------------------------------------

test('Driver: getTake and getHold reach buildScore (and the mixer resolve)', () => {
  const state = createState();
  const store = createStore(state), transport = new Transport({ bpm: 120 });
  transport.start(0);
  const graph = fakeGraph(0), timer = fakeTimer(), seen = [];
  const take = { dur: 5, bpm: 120, events: [{ t: 0, id: 'ch1.drone.bands', value: 0 }] };
  const hold = [0.25, null, null, null];
  const driver = new Driver({
    graph, store, transport, getAnalyses: () => [A, A, A, A], getStage: () => STAGE,
    setIntervalFn: timer.setIntervalFn, clearIntervalFn: timer.clearIntervalFn,
    getTake: () => take, getHold: () => hold,
    buildScoreFn: (project, span, opts) => { seen.push(opts); return [[], [], [], []]; },
  });
  driver.tick();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].take, take);
  assert.equal(seen[0].timelineHold, hold);
});

test('Driver: without getTake/getHold nothing extra is passed', () => {
  const { driver } = setup();
  const seen = [];
  driver.buildScoreFn = (p, s, opts) => { seen.push(opts); return [[], [], [], []]; };
  driver.tick();
  assert.equal(seen[0].take, undefined);
  assert.equal(seen[0].timelineHold, undefined);
});

test('Driver.trigger: false before any frame was sent; afterwards sends one event on a copy of the last frame', () => {
  const { driver, graph } = setup(s => { s.params['ch1.filter.on'] = true; s.params['ch1.filter.center'] = 0.1; s.params['ch1.filter.width'] = 0.3; });
  assert.equal(driver.trigger(0), false, 'no frame sent yet');
  driver.tick();
  const before = graph.channels[0].sent.length;
  assert.ok(before > 0);
  assert.equal(driver.trigger(0), true);
  const fr = graph.channels[0].sent.at(-1);
  assert.equal(graph.channels[0].sent.length, before + 1);
  assert.equal(fr.events.length, 1);
  const e = fr.events[0];
  assert.ok(Number.isFinite(e.f) && e.f >= 40 && e.f <= 4200 && e.amp > 0, JSON.stringify(e));
  assert.ok(e.t > 0 && e.t === fr.t, 'the event rides its own frame timestamp');
  assert.deepEqual(e.envRoutes, [{ a: 0.03, h: 0, d: 1.2, amount: 1 }]);
  assert.equal(fr.bandF.length, 30, 'the carrier frame keeps the drone arrays');
});

test('Driver.trigger: false for a disabled channel, a missing analysis, or no band under the window', () => {
  const a = setup(s => { s.params['ch2.filter.on'] = false; });
  a.driver.tick();
  assert.equal(a.driver.trigger(1), false);
  const b = setup(s => { s.params['ch1.filter.on'] = true; });
  b.driver.getAnalyses = () => [null, null, null, null];
  b.driver.tick();
  assert.equal(b.driver.trigger(0), false);
  // window parked where Allende has no band, narrow
  const c = setup(s => { s.params['ch1.filter.on'] = true; s.params['ch1.filter.center'] = 0.95; s.params['ch1.filter.width'] = 0.02; s.params['ch1.filter.soft'] = 0; });
  c.driver.tick();
  assert.equal(c.driver.trigger(0), false);
});

test('Driver.trigger applies the clockOffset to the event timestamp (context time)', () => {
  const { driver, graph } = setup(s => { s.params['ch1.filter.on'] = true; s.params['ch1.filter.center'] = 0.1; s.params['ch1.filter.width'] = 0.3; });
  driver.tick(); driver.clockOffset = 5;
  assert.equal(driver.trigger(0), true);
  const fr = graph.channels[0].sent.at(-1);
  assert.ok(fr.t < 1 && fr.events[0].t === fr.t, `context time stamp, got ${fr.t}`);
});
