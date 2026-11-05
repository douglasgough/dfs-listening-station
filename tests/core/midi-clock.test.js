import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Transport } from '../../src/core/transport.js';
import { MidiClockFollower } from '../../src/core/midi-clock.js';

const TICK = 0.5 / 24; // 120 bpm
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} ${a} vs ${b} (+-${tol})`);

function rig(opts) {
  const transport = new Transport({ bpm: 90 });
  const f = new MidiClockFollower(transport, opts);
  return { transport, f };
}
/** Send n ticks starting at t0 with interval(i) seconds between them; returns time of last tick. */
function ticks(f, t0, n, interval = () => TICK) {
  let t = t0;
  for (let i = 0; i < n; i++) {
    f.handle([0xf8], t);
    if (i < n - 1) t += interval(i);
  }
  return t;
}
// Seeded LCG so the jitter sequence is deterministic.
function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

test('24 ticks at 0.5/24 s settle tempo to 120 bpm and mark source midi', () => {
  const { transport, f } = rig();
  ticks(f, 1, 24);
  near(transport.bpm, 120, 0.5);
  assert.equal(transport.source, 'midi');
});

test('+-10% interval jitter stays within 2 bpm of 120', () => {
  const { transport, f } = rig();
  const r = lcg(12345);
  ticks(f, 0, 200, () => TICK * (1 + (r() * 2 - 1) * 0.1));
  near(transport.bpm, 120, 2);
});

test('tempo follows a change', () => {
  const { transport, f } = rig();
  const t = ticks(f, 0, 48);
  near(transport.bpm, 120, 0.5);
  ticks(f, t + 0.25 / 24, 96, () => 0.25 / 24); // 240 bpm
  near(transport.bpm, 240, 2);
});

test('FA starts from beat 0 and running', () => {
  const { transport, f } = rig();
  transport.locate(7, 0);
  f.handle([0xfa], 1);
  assert.equal(transport.running, true);
  near(transport.beatAt(1), 0, 1e-9);
  assert.equal(transport.source, 'midi');
});

test('FC stops; duplicate FC is idempotent', () => {
  const { transport, f } = rig();
  f.handle([0xfa], 0);
  f.handle([0xfc], 1);
  assert.equal(transport.running, false);
  const b = transport.beatAt(1);
  f.handle([0xfc], 5);
  assert.equal(transport.running, false);
  assert.equal(transport.beatAt(9), b);
});

test('FB resumes without resetting the beat', () => {
  const { transport, f } = rig();
  f.handle([0xfa], 0);
  f.handle([0xfc], 2); // 90 bpm default -> 3 beats
  const held = transport.beatAt(2);
  assert.ok(held > 2.9);
  f.handle([0xfb], 10);
  assert.equal(transport.running, true);
  near(transport.beatAt(10), held, 1e-9);
  near(transport.beatAt(11), held + 1.5, 1e-9);
  assert.equal(transport.source, 'midi');
});

test('F2 [lsb=8,msb=0] relocates to beat 2 (16th notes, 4 per beat)', () => {
  const { transport, f } = rig();
  f.handle([0xf2, 8, 0], 0);
  near(transport.beatAt(0), 2, 1e-9);
  assert.equal(transport.running, false);
});

test('F2 combines lsb and msb', () => {
  const { transport, f } = rig();
  f.handle([0xf2, 1, 1], 0); // 1 + 128 = 129 sixteenths
  near(transport.beatAt(0), 129 / 4, 1e-9);
});

test('F2 while running relocates without stopping', () => {
  const { transport, f } = rig();
  f.handle([0xfa], 0);
  f.handle([0xf2, 16, 0], 1);
  assert.equal(transport.running, true);
  near(transport.beatAt(1), 4, 1e-9);
});

test('RF3: FC before any FA is ignored', () => {
  const { transport, f } = rig();
  assert.doesNotThrow(() => f.handle([0xfc], 1));
  assert.equal(transport.running, false);
  assert.equal(transport.source, 'internal');
  assert.equal(transport.beatAt(2), 0);
  assert.equal(transport.bpm, 90);
});

test('RF3: ticks without FA update tempo and source but do not start', () => {
  const { transport, f } = rig();
  ticks(f, 0, 30);
  assert.equal(transport.running, false);
  assert.equal(transport.source, 'midi');
  near(transport.bpm, 120, 0.5);
  assert.equal(f.poll(1), 'idle');
});

test('RF3: a single implausible interval is ignored', () => {
  const { transport, f } = rig();
  let t = ticks(f, 0, 30);
  near(transport.bpm, 120, 0.5);
  // Interval of 0.5 s between two ticks implies 5 bpm (< 20): outlier.
  t += 0.5;
  f.handle([0xf8], t);
  // Interval of 0.001 s implies 2500 bpm (> 400): outlier.
  t += 0.001;
  f.handle([0xf8], t);
  near(transport.bpm, 120, 0.5);
  ticks(f, t + TICK, 24);
  near(transport.bpm, 120, 0.5);
});

test('RF3: malformed, short and unknown messages are ignored without throwing', () => {
  const { transport, f } = rig();
  for (const m of [[], [0xf2], [0xf2, 8], [0xf2, 200, 0], [0x00], [0xff], [0xf9], [0xfd], [0x90, 60, 100], null, undefined, 42, 'x']) {
    assert.doesNotThrow(() => f.handle(m, 1), String(m));
  }
  assert.equal(transport.running, false);
  assert.equal(transport.beatAt(2), 0);
  assert.equal(transport.source, 'internal');
  assert.equal(transport.bpm, 90);
  assert.doesNotThrow(() => f.handle([0xf8], NaN));
  assert.equal(transport.source, 'internal');
});

test('accepts typed arrays', () => {
  const { transport, f } = rig();
  f.handle(Uint8Array.of(0xfa), 0);
  assert.equal(transport.running, true);
});

test('poll: idle before any tick, idle when not running', () => {
  const { transport, f } = rig();
  assert.equal(f.poll(0), 'idle');
  f.handle([0xfa], 0);
  assert.equal(f.poll(0.5), 'idle'); // running but no tick ever received
  ticks(f, 1, 5);
  f.handle([0xfc], 1.5);
  assert.equal(transport.running, false);
  assert.equal(f.poll(10), 'idle');
});

test('poll: ok while ticks flow, lost after >1 s silence, ok after a tick', () => {
  const { transport, f } = rig();
  f.handle([0xfa], 0);
  const last = ticks(f, 0, 24);
  assert.equal(f.poll(last + 0.5), 'ok');
  assert.equal(f.poll(last + 1.0), 'ok'); // not strictly more than 1 s
  assert.equal(f.poll(last + 1.5), 'lost');
  assert.equal(transport.running, false);
  f.handle([0xf8], last + 1.6);
  assert.equal(transport.running, true);
  assert.equal(f.poll(last + 1.6), 'ok');
});

test('poll: stop on loss happens once and lost persists until a tick', () => {
  const { transport, f } = rig();
  f.handle([0xfa], 0);
  const last = ticks(f, 0, 24);
  let stops = 0;
  const orig = transport.stop.bind(transport);
  transport.stop = (t) => { stops++; orig(t); };
  assert.equal(f.poll(last + 2), 'lost');
  assert.equal(f.poll(last + 3), 'lost');
  assert.equal(f.poll(last + 4), 'lost');
  assert.equal(stops, 1);
});

test('poll: lostAfterSec option is honoured', () => {
  const { f } = rig({ lostAfterSec: 3 });
  f.handle([0xfa], 0);
  const last = ticks(f, 0, 24);
  assert.equal(f.poll(last + 2), 'ok');
  assert.equal(f.poll(last + 3.5), 'lost');
});

test('RF3: 3 s gap then ticks recovers to ok, keeps tempo, resumes position hold', () => {
  const { transport, f } = rig();
  f.handle([0xfa], 0);
  let last = ticks(f, 0, 48);
  assert.equal(f.poll(last + 1.5), 'lost');
  const heldBeat = transport.beatAt(last + 1.5);
  assert.equal(transport.running, false);
  last = ticks(f, last + 3, 24);
  assert.equal(f.poll(last), 'ok');
  assert.equal(transport.running, true);
  near(transport.bpm, 120, 0.5);
  near(transport.beatAt(last + 3 - 3), transport.beatAt(last), 1e-9);
  assert.ok(transport.beatAt(last) >= heldBeat);
});

test('gap without a poll in between does not corrupt tempo', () => {
  const { transport, f } = rig();
  f.handle([0xfa], 0);
  let last = ticks(f, 0, 48);
  last = ticks(f, last + 3, 24);
  near(transport.bpm, 120, 0.5);
  assert.equal(f.poll(last), 'ok');
});

test('no resume after loss if the transport was stopped by FC during the loss', () => {
  const { transport, f } = rig();
  f.handle([0xfa], 0);
  const last = ticks(f, 0, 24);
  assert.equal(f.poll(last + 2), 'lost');
  f.handle([0xfc], last + 2.1);
  f.handle([0xf8], last + 2.2);
  assert.equal(transport.running, false);
  assert.equal(f.poll(last + 2.2), 'idle');
});

test('no resume after loss if transport was not running before it', () => {
  const { transport, f } = rig();
  const last = ticks(f, 0, 24); // ticks, never started
  assert.equal(f.poll(last + 2), 'idle');
  f.handle([0xf8], last + 2.1);
  assert.equal(transport.running, false);
});

test('FA resets the tempo estimate', () => {
  const { transport, f } = rig();
  ticks(f, 0, 30); // 120
  f.handle([0xfa], 2);
  ticks(f, 2.1, 30, () => 0.5 / 48); // 240 bpm
  near(transport.bpm, 240, 0.5);
});
