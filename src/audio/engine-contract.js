/*
 * Voice Engine contract (spec §3.3, protected rule: no module outside src/audio/ may depend on how
 * voices are synthesised). The interface and these contract tests come before any implementation, so
 * a future engine (Faust, FM, ...) can be checked against the same suite.
 *
 * INTERFACE
 *   create(opts: {sampleRate:number, stereo:boolean, seed:number, loopSec?:number, plain?:boolean}): Engine
 *   Engine.schedule(frame: ControlFrame): void
 *       The frame takes effect at frame.t (engine seconds). Frames arrive in non-decreasing t. Events
 *       inside a frame (frame.events: EventSpec[]) carry their own absolute t.
 *   Engine.render(frames: number): { left: Float32Array, right: Float32Array | null }
 *       Advances engine time by frames/sampleRate. right is null when !stereo.
 *   Engine.dispose(): void
 *       Afterwards render() returns zeros (never throws) and schedule() is a no-op (never throws).
 *
 * TIME AND SMOOTHING
 *   Engine time starts at 0 and advances only through render. Frame application is sample-accurate:
 *   render splits at frame timestamps. Instant rule: a frame applies instantly (no smoothing) only if
 *   it is the FIRST frame ever scheduled AND its t <= current engine time. A first frame with a later
 *   t fades in (smoothed) when engine time reaches it. Every other frame applies with one-pole
 *   smoothing (time constants 0.04 s for gains/amplitudes, 0.07 s for frequencies).
 *
 * LEVELS
 *   opts.plain = true disables slow random amplitude modulation (e.g. the prototype's per-band wobble),
 *   so output levels are exactly the frame's; default false.
 *   Drone output (bands, comb, noise, anchor) is scaled by  match * min(1, 2*(1-balance))  and event
 *   output by  match * min(1, 2*balance), using the frame currently in effect (smoothed as a gain).
 *   Fader, strip pan, mute, solo and master are NOT the engine's business (Mixer).
 *
 * EVENTS  EventSpec = {t, f, amp, pan, envRoutes:{a,h,d,amount}[], staticGain}
 *   Gain = amp * staticGain * PROD_i (1 + amount_i * (env_i(age) - 1)), env = linear attack a, hold h,
 *   exponential decay d (a >= 0.002, d >= 0.02, zero after a+h+8d). Each route's amount is clamped to
 *   [-1, 1] (as eventRoutes does); a route with a non-finite amount is ignored. With no envRoute: a
 *   fixed gate, full level for 0.245 s then a 5 ms linear release (ends at 0.25 s; ruling R1). An event
 *   with t in the past starts now with the phase and level it would have by then (sine phase
 *   2*pi*f*age).
 *
 * STEREO LEVEL CONVENTIONS (ChannelSynth, matching the prototype's Web Audio graph)
 *   Constant-power pan law L = cos((p+1)pi/4), R = sin((p+1)pi/4):
 *     - bands pan with bandPan: a centred band is 0.707 per channel;
 *     - events with a numeric pan use the same law: pan 0 is 0.707 per channel;
 *     - events with pan null/undefined are centred at 1.0 in both channels;
 *     - comb, anchor and noise are 1.0 in both channels (noise through 7 ms / 13 ms delays).
 *   Mono ignores pan: bands and events are 1.0. Another engine need not reproduce these exact levels,
 *   but it must keep pan -1 / +1 isolation (all energy in one channel) and finite output.
 *
 * ROBUSTNESS
 *   Non-finite or extreme inputs never produce NaN/Infinity in the output, and the engine keeps working.
 *
 * ControlFrame layout: see src/dsp/partials.js. This file imports nothing; the runner injects
 * {test, assert} (e.g. from node:test and node:assert/strict).
 */

const SR = 48000;
const SIZES = { bandF: 30, bandA: 30, bandPan: 10, combF: 64, combA: 64, noiseF: 20, noiseA: 20, anchorF: 2, anchorA: 2 };
const F64 = new Set(['bandF', 'combF', 'noiseF', 'anchorF']);

/**
 * A ControlFrame with everything zero, balance 0.5, match 1. `over` sets fields; for array fields an
 * object {index: value} sets individual entries.
 */
export function makeFrame(t, over = {}) {
  const fr = { t, balance: 0.5, match: 1, events: [] };
  for (const [k, n] of Object.entries(SIZES)) fr[k] = F64.has(k) ? new Float64Array(n) : new Float32Array(n);
  for (const [k, v] of Object.entries(over)) {
    if (k in SIZES && v && typeof v === 'object' && !ArrayBuffer.isView(v)) {
      for (const [i, x] of Object.entries(v)) fr[k][Number(i)] = x;
    } else fr[k] = v;
  }
  return fr;
}

// ---- measurement helpers (no dependencies) --------------------------------------------------------

/** Renders `sec` seconds in blocks of `block`; returns concatenated {left, right}. */
export function renderSec(engine, sec, block = 128, sr = SR) {
  const total = Math.round(sec * sr);
  let left = null, right = null;
  for (let pos = 0; pos < total; pos += block) {
    const n = Math.min(block, total - pos);
    const out = engine.render(n);
    if (!left) { left = new Float32Array(total); right = out.right ? new Float32Array(total) : null; }
    left.set(out.left, pos);
    if (right && out.right) right.set(out.right, pos);
  }
  return { left: left || new Float32Array(0), right };
}

/** Goertzel power of x[start .. start+n) at frequency f. */
export function goertzel(x, start, n, f, sr = SR) {
  const c = 2 * Math.cos(2 * Math.PI * f / sr);
  let s1 = 0, s2 = 0;
  for (let i = start; i < start + n; i++) { const s0 = x[i] + c * s1 - s2; s2 = s1; s1 = s0; }
  return s1 * s1 + s2 * s2 - c * s1 * s2;
}

/** Frequency with the largest Goertzel power in [lo, hi] at `step` Hz. */
export function dominant(x, start, n, lo, hi, step, sr = SR) {
  let best = lo, bp = -1;
  for (let f = lo; f <= hi + 1e-9; f += step) {
    const p = goertzel(x, start, n, f, sr);
    if (p > bp) { bp = p; best = f; }
  }
  return best;
}

export function peak(x, start = 0, end = x.length) {
  let m = 0;
  for (let i = start; i < end; i++) { const a = Math.abs(x[i]); if (a > m) m = a; }
  return m;
}

/** Peak-to-peak envelope / 2 over the 10 ms window starting at time t0. */
export function ppEnv(x, t0, win = 0.01, sr = SR) {
  const a = Math.round(t0 * sr), b = a + Math.round(win * sr);
  let mx = -Infinity, mn = Infinity;
  for (let i = a; i < b; i++) { if (x[i] > mx) mx = x[i]; if (x[i] < mn) mn = x[i]; }
  return (mx - mn) / 2;
}

/** RMS * sqrt(2) over a window centred at time tc (sine amplitude estimate, less biased by decay). */
export function rmsEnv(x, tc, win = 0.01, sr = SR) {
  const h = Math.round(win * sr / 2), c = Math.round(tc * sr);
  let s = 0;
  for (let i = c - h; i < c + h; i++) s += x[i] * x[i];
  return Math.sqrt(2 * s / (2 * h));
}

const rms = (x, a = 0, b = x.length) => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, b - a)); };

/** Reference AHD envelope (same law as src/core/modulation.js envValue, trigger at age 0). */
function envRef(e, age) {
  const a = Math.max(0.002, e.a), h = Math.max(0, e.h), d = Math.max(0.02, e.d);
  if (age < 0 || age > a + h + 8 * d) return 0;
  return age < a ? age / a : age < a + h ? 1 : Math.exp(-(age - a - h) / d);
}

const allFinite = (x) => { for (let i = 0; i < x.length; i++) if (!Number.isFinite(x[i])) return false; return true; };

// ---- the contract ---------------------------------------------------------------------------------

export function engineContract(create, { test, assert }) {
  const mk = (over = {}) => create({ sampleRate: SR, stereo: false, seed: 1234, plain: true, ...over });
  const ENV1 = { a: 0.002, h: 0, d: 0.5, amount: 1 };
  const ev = (over = {}) => ({ t: 0.1, f: 1000, amp: 0.2, pan: 0, envRoutes: [{ ...ENV1 }], staticGain: 1, ...over });
  const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);
  const maxDiff = (a, b, a0 = 0, b0 = 0, n = Math.min(a.length - a0, b.length - b0)) => {
    let m = 0;
    for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(a[a0 + i] - b[b0 + i]));
    return m;
  };

  test('engine contract 1: no frames gives all-zero output (mono and stereo)', () => {
    const m = mk();
    const o = m.render(4800);
    assert.ok(o.left instanceof Float32Array);
    assert.equal(o.left.length, 4800);
    assert.equal(o.right, null);
    assert.equal(peak(o.left), 0);
    const s = mk({ stereo: true });
    const os = s.render(4800);
    assert.ok(os.right instanceof Float32Array);
    assert.equal(os.right.length, 4800);
    assert.equal(peak(os.left), 0);
    assert.equal(peak(os.right), 0);
  });

  test('engine contract 2: a t=0 frame applies instantly; one band gives its level and pitch', () => {
    const e = mk();
    e.schedule(makeFrame(0, { bandF: { 0: 440 }, bandA: { 0: 0.1 } }));
    renderSec(e, 2);
    const { left } = renderSec(e, 1);
    near(peak(left), 0.1, 0.001, 'peak');
    near(dominant(left, 0, SR, 400, 480, 0.5), 440, 1, 'dominant frequency');
    // instant: no fade-in, the very first samples already sit at full level
    const e2 = mk();
    e2.schedule(makeFrame(0, { bandF: { 0: 440 }, bandA: { 0: 0.1 } }));
    near(peak(e2.render(480).left), 0.1, 0.002, 'level in the first 10 ms');
  });

  test('engine contract 3: frame application is sample-accurate', () => {
    const e = mk();
    e.schedule(makeFrame(0.5, { bandF: { 0: 1000 }, bandA: { 0: 0.1 } }));
    const { left } = renderSec(e, 1);
    for (let i = 0; i < 23999; i++) assert.ok(Math.abs(left[i]) <= 1e-12, `sample ${i} before the frame is ${left[i]}`);
    let first = -1;
    for (let i = 0; i < left.length; i++) if (Math.abs(left[i]) > 1e-12) { first = i; break; }
    assert.ok(first >= 23999 && first <= 24100, `first non-zero sample ${first}`);
    assert.ok(peak(left, 24000, 24100) > 0, 'signal starts right after the frame');
    near(peak(left, 36000, 48000), 0.1, 0.002, 'settled level');
  });

  test('engine contract 4: same seed and schedule give bit-identical output; seeds change noise', () => {
    const fr = () => makeFrame(0, {
      bandF: { 0: 300, 1: 302, 2: 297 }, bandA: { 0: 0.05, 1: 0.03, 2: 0.03 },
      combF: { 0: 500, 1: 750 }, combA: { 0: 0.02, 1: 0.02 },
      noiseF: { 0: 800, 1: 2000 }, noiseA: { 0: 0.05, 1: 0.05 },
      anchorF: { 0: 55 }, anchorA: { 0: 0.05 },
      events: [ev({ t: 0.05 })],
    });
    const run = (seed, f = fr, stereo = false) => {
      const e = mk({ seed, stereo });
      e.schedule(f());
      e.schedule(makeFrame(0.3, { bandF: { 0: 310 }, bandA: { 0: 0.08 }, noiseF: { 0: 900 }, noiseA: { 0: 0.04 } }));
      return renderSec(e, 0.6);
    };
    const a = run(7), b = run(7);
    assert.equal(maxDiff(a.left, b.left), 0, 'mono bit-identical');
    const sa = run(7, fr, true), sb = run(7, fr, true);
    assert.equal(maxDiff(sa.left, sb.left), 0, 'stereo L bit-identical');
    assert.equal(maxDiff(sa.right, sb.right), 0, 'stereo R bit-identical');
    assert.ok(maxDiff(a.left, run(8).left) > 1e-4, 'different seeds differ');
    const noiseOnly = () => makeFrame(0, { noiseF: { 0: 1000 }, noiseA: { 0: 0.05 } });
    const n1 = (seed) => { const e = mk({ seed }); e.schedule(noiseOnly()); return renderSec(e, 0.2).left; };
    assert.ok(maxDiff(n1(7), n1(8)) > 1e-4, 'noise differs between seeds');
    assert.ok(peak(n1(7)) > 1e-3, 'noise sounds');
  });

  test('engine contract 5 (RF4): an all-zero frame fades to silence without clicks; dispose is safe', () => {
    const e = mk();
    e.schedule(makeFrame(0, { bandF: { 0: 220 }, bandA: { 0: 0.5 } }));
    const before = renderSec(e, 0.5).left;
    assert.ok(peak(before) > 0.45, 'sounding before the fade');
    e.schedule(makeFrame(0.5, { bandF: { 0: 220 } }));
    const { left } = renderSec(e, 1.5);
    let jump = Math.abs(left[0] - before[before.length - 1]);
    for (let i = 1; i < left.length; i++) jump = Math.max(jump, Math.abs(left[i] - left[i - 1]));
    assert.ok(jump < 0.05, `largest sample-to-sample jump ${jump}`);
    assert.ok(peak(left, 0, 480) > 0.2, 'the fade is gradual, not instant');
    assert.ok(peak(left, SR) < 1e-4, `residual after 1 s ${peak(left, SR)}`);
    e.dispose();
    const z = e.render(1024);
    assert.equal(z.left.length, 1024);
    assert.equal(peak(z.left), 0);
    assert.doesNotThrow(() => e.schedule(makeFrame(2, { bandF: { 0: 220 }, bandA: { 0: 0.5 } })));
    assert.equal(peak(e.render(1024).left), 0);
    const s = mk({ stereo: true });
    s.dispose();
    const zs = s.render(256);
    assert.equal(peak(zs.left), 0);
    assert.ok(zs.right === null || peak(zs.right) === 0);
  });

  const evRun = (events, sec, over = {}, opts = {}) => {
    const e = mk(opts);
    e.schedule(makeFrame(0, { events, ...over }));
    return renderSec(e, sec);
  };

  test('engine contract 6a: an event with one envelope route peaks, then decays by e^-1 after d', () => {
    const { left } = evRun([ev()], 1.2);
    for (let i = 0; i < 4799; i++) assert.ok(Math.abs(left[i]) <= 1e-12, `sample ${i} before the event`);
    const pk = peak(left, 4800, 4800 + 960);
    near(pk, 0.2, 0.01, 'peak within the first 20 ms');
    const r = ppEnv(left, 0.1 + 0.002 + 0.5 - 0.005) / pk;
    near(r, Math.exp(-1), 0.1 * Math.exp(-1), 'envelope one d after the attack');
  });

  test('engine contract 6b: an event without envelope routes is a fixed 0.25 s gate', () => {
    const { left } = evRun([ev({ envRoutes: [] })], 0.6);
    for (const tc of [0.11, 0.2, 0.3, 0.335]) near(rmsEnv(left, tc), 0.2, 0.01, `gate level at ${tc}`);
    assert.ok(peak(left, Math.round(0.36 * SR)) <= 1e-9, 'silent 0.26 s after the start');
  });

  test('engine contract 6c: an event with negative t starts with the phase and level it would have', () => {
    const f = 1234.5;
    const a = evRun([ev({ t: -0.3, f })], 0.5).left;
    const b = evRun([ev({ t: 0, f })], 0.8).left;
    const off = Math.round(0.3 * SR);
    assert.ok(maxDiff(a, b, 0, off, Math.round(0.5 * SR)) < 1e-5, `a[n] vs b[n+0.3 s]: ${maxDiff(a, b, 0, off, Math.round(0.5 * SR))}`);
    near(rmsEnv(a, 0.005), 0.2 * Math.exp(-(0.3 + 0.005 - 0.002) / 0.5), 0.005, 'level at engine time 0');
    const old = evRun([ev({ t: -100 })], 0.1).left;
    assert.equal(peak(old), 0, 'an event whose life ended long ago is dropped');
  });

  test('engine contract 6d: overlapping events sum independently; staticGain and route products', () => {
    const e1 = ev({ t: 0.1, f: 1000 }), e2 = ev({ t: 0.35, f: 1500, envRoutes: [{ a: 0.01, h: 0.02, d: 0.2, amount: 1 }] });
    const both = evRun([e1, e2], 1).left, only1 = evRun([e1], 1).left, only2 = evRun([e2], 1).left;
    let m = 0;
    for (let i = 0; i < both.length; i++) m = Math.max(m, Math.abs(both[i] - (only1[i] + only2[i])));
    assert.ok(m < 1e-6, `superposition error ${m}`);
    const half = evRun([ev({ staticGain: 0.5 })], 0.8).left, full = evRun([ev()], 0.8).left;
    let mh = 0;
    for (let i = 0; i < full.length; i++) mh = Math.max(mh, Math.abs(2 * half[i] - full[i]));
    assert.ok(mh < 1e-6, `staticGain 0.5 halves: ${mh}`);
    assert.ok(peak(full) > 0.15);
    const r2 = { a: 0.01, h: 0.05, d: 0.1, amount: 0.5 };
    const two = evRun([ev({ envRoutes: [{ ...ENV1 }, r2] })], 0.8).left;
    for (const age of [0.03, 0.08, 0.2, 0.4]) {
      const want = 0.2 * envRef(ENV1, age) * (1 + 0.5 * (envRef(r2, age) - 1));
      near(rmsEnv(two, 0.1 + age), want, 0.04 * want + 1e-4, `two routes at age ${age}`);
    }
  });

  test('engine contract 7: stereo panning of events and bands; mono ignores pan', () => {
    const L = evRun([ev({ pan: -1 })], 0.5, {}, { stereo: true });
    assert.ok(peak(L.left) > 0.15, 'pan -1 sounds left');
    assert.ok(peak(L.right) < 1e-6 * peak(L.left), `pan -1 right ${peak(L.right)}`);
    const R = evRun([ev({ pan: 1 })], 0.5, {}, { stereo: true });
    assert.ok(peak(R.right) > 0.15, 'pan +1 sounds right');
    assert.ok(peak(R.left) < 1e-6 * peak(R.right), `pan +1 left ${peak(R.left)}`);
    const B = evRun([], 0.5, { bandF: { 0: 440 }, bandA: { 0: 0.1 }, bandPan: { 0: -0.8 } }, { stereo: true });
    assert.ok(rms(B.left) > 2 * rms(B.right), `band panned -0.8 is left-heavy: ${rms(B.left)} vs ${rms(B.right)}`);
    assert.ok(rms(B.right) > 0, 'but not hard left');
    const m1 = evRun([ev({ pan: -1 })], 0.4), m2 = evRun([ev({ pan: 1 })], 0.4);
    assert.equal(m1.right, null);
    assert.equal(maxDiff(m1.left, m2.left), 0, 'mono ignores pan');
    assert.ok(peak(m1.left) > 0.15);
  });

  test('engine contract 8: extreme and non-finite inputs give finite output; the engine recovers', () => {
    const short = [{ a: 0.002, h: 0, d: 0.02, amount: 1 }];
    const ev = (over) => ({ t: 0.1, f: 1000, amp: 0.2, pan: 0, envRoutes: short, staticGain: 1, ...over });
    for (const stereo of [false, true]) {
      const e = mk({ stereo });
      e.schedule(makeFrame(0, {
        bandF: { 0: 440, 1: 0, 2: NaN, 3: 440, 4: Infinity, 5: -440, 6: 1e9 },
        bandA: { 0: 1e6, 1: 0.1, 2: 0.1, 3: NaN, 4: 0.1, 5: 0.1, 6: 0.1 },
        bandPan: { 0: NaN, 1: Infinity, 2: -50 },
        combF: { 0: NaN, 1: -1, 2: 1e12 }, combA: { 0: 1, 1: Infinity, 2: 0.5 },
        noiseF: { 0: Infinity, 1: 0, 2: -100, 3: NaN, 4: 1e9 }, noiseA: { 0: 1e6, 1: 1, 2: 1, 3: 1, 4: 1 },
        anchorF: { 0: NaN, 1: 1e9 }, anchorA: { 0: Infinity, 1: 1 },
        balance: NaN, match: Infinity,
        events: [
          ev({ f: NaN }), ev({ amp: NaN }), ev({ t: NaN }), ev({ t: Infinity }), ev({ t: -Infinity }),
          ev({ f: -5 }), ev({ f: 1e9 }), ev({ amp: 1e6 }), ev({ pan: NaN }), ev({ staticGain: NaN }),
          ev({ envRoutes: [{ a: NaN, h: Infinity, d: -1, amount: NaN }] }), ev({ envRoutes: null }), null, 42,
        ],
      }));
      e.schedule(makeFrame(NaN, { bandA: { 0: NaN } }));
      e.schedule(makeFrame(0.1, { bandF: { 0: NaN }, bandA: { 0: Infinity }, balance: -3, match: -1 }));
      const a = renderSec(e, 0.5);
      assert.ok(allFinite(a.left), 'left finite');
      if (stereo) assert.ok(allFinite(a.right), 'right finite');
      // balance 0 mutes any still-sounding events, whatever an engine made of the extreme ones
      e.schedule(makeFrame(0.5, { bandF: { 0: 440 }, bandA: { 0: 0.1 }, balance: 0 }));
      const b = renderSec(e, 1.5);
      assert.ok(allFinite(b.left), 'left finite after recovery');
      if (!stereo) {
        near(peak(b.left, SR), 0.1, 0.002, 'recovered level');
        near(dominant(b.left, Math.round(0.5 * SR), SR, 400, 480, 0.5), 440, 1, 'recovered pitch');
      }
    }
  });

  test('engine contract 9: balance and match scale drone and events', () => {
    const band = { bandF: { 0: 440 }, bandA: { 0: 0.1 } };
    const evs = () => [ev({ t: 0.05, envRoutes: [] })];
    const run = (over, events) => evRun(events, 0.4, over).left;
    const droneOnly = run(band, []), eventOnly = run({}, evs());
    assert.ok(peak(eventOnly) > 0.15 && peak(droneOnly) > 0.09);
    assert.ok(maxDiff(run({ ...band, balance: 0 }, evs()), droneOnly) < 1e-6, 'balance 0: events muted, drone full');
    assert.ok(maxDiff(run({ ...band, balance: 1 }, evs()), eventOnly) < 1e-6, 'balance 1: drone muted, events full');
    const m1 = run(band, evs()), m2 = run({ ...band, match: 2 }, evs());
    let md = 0;
    for (let i = 0; i < m1.length; i++) md = Math.max(md, Math.abs(m2[i] - 2 * m1[i]));
    assert.ok(md < 1e-6, `match 2 doubles both: ${md}`);
    // smoothed change of balance: a later frame settles to the new scaling
    const e = mk();
    e.schedule(makeFrame(0, { ...band }));
    renderSec(e, 0.2);
    e.schedule(makeFrame(0.2, { ...band, balance: 0.75 }));
    renderSec(e, 0.8);
    near(peak(renderSec(e, 0.2).left), 0.05, 0.001, 'balance 0.75 halves the drone after settling');
  });
}
