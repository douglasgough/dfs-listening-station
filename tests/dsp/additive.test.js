import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelSynth, createChannelSynth } from '../../src/dsp/additive.js';
import { makeFrame, renderSec, goertzel, peak } from '../../src/audio/engine-contract.js';

const SR = 48000;
const mk = (over = {}) => createChannelSynth({ sampleRate: SR, stereo: false, seed: 99, plain: true, ...over });

/** Every voice active: 10 bands x 3, 64 comb, 20 noise bands, 2 anchors (frequencies on a 0.25 Hz grid). */
function fullFrame(t = 0, events = []) {
  const fr = makeFrame(t, { events });
  for (let b = 0; b < 10; b++) {
    const f = 110 * 2 ** (b / 3);
    for (let k = 0; k < 3; k++) { fr.bandF[3 * b + k] = Math.round((f + k * 0.75) * 4) / 4; fr.bandA[3 * b + k] = 0.01; }
    fr.bandPan[b] = (b - 4.5) / 6;
  }
  for (let j = 0; j < 64; j++) { fr.combF[j] = Math.round(110 * 2 ** (j / 12) * 4) / 4; fr.combA[j] = 0.002; }
  for (let k = 0; k < 20; k++) { fr.noiseF[k] = 100 * 2 ** (k / 4); fr.noiseA[k] = 0.01; }
  fr.anchorF[0] = 55; fr.anchorF[1] = 110; fr.anchorA[0] = 0.05; fr.anchorA[1] = 0.025;
  return fr;
}

const sameArray = (a, b, n = Math.min(a.length, b.length)) => {
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return `index ${i}: ${a[i]} vs ${b[i]}`;
  return null;
};

test('ChannelSynth is the factory product and implements the interface', () => {
  const e = mk();
  assert.ok(e instanceof ChannelSynth);
  for (const m of ['schedule', 'render', 'dispose']) assert.equal(typeof e[m], 'function');
});

test('wobble (plain:false) keeps a band within [0.44, 1.0] x A and varies it over 60 s', () => {
  const sr = 8000, A = 0.1;
  const e = createChannelSynth({ sampleRate: sr, stereo: false, seed: 5, plain: false });
  e.schedule(makeFrame(0, { bandF: { 0: 100 }, bandA: { 0: A } }));
  const per = [];
  for (let s = 0; s < 60; s++) per.push(peak(renderSec(e, 1, 500, sr).left) / A);
  const lo = Math.min(...per), hi = Math.max(...per);
  assert.ok(lo >= 0.44 - 0.005 && hi <= 1.0 + 0.005, `range [${lo}, ${hi}]`);
  assert.ok(hi - lo > 0.3, `the level varies: [${lo}, ${hi}]`);
  // plain:true: exactly the frame's level
  const p = createChannelSynth({ sampleRate: sr, stereo: false, seed: 5, plain: true });
  p.schedule(makeFrame(0, { bandF: { 0: 100 }, bandA: { 0: A } }));
  renderSec(p, 10, 500, sr);
  assert.ok(Math.abs(peak(renderSec(p, 1, 500, sr).left) - A) < 1e-4);
});

test('loopSec 4: wobble and noise repeat every loop, for block sizes 128, 100 and 480', () => {
  const sr = 12000, L = 4 * sr;
  const run = (block) => {
    const e = createChannelSynth({ sampleRate: sr, stereo: true, seed: 3, loopSec: 4, plain: false });
    e.schedule(fullFrame(0, [{ t: 0.2, f: 440, amp: 0.1, pan: 0.3, envRoutes: [{ a: 0.01, h: 0, d: 0.05, amount: 1 }], staticGain: 1 }]));
    return renderSec(e, 12, block, sr);
  };
  const ref = run(128);
  let m = 0;
  for (const ch of [ref.left, ref.right]) {
    for (let i = Math.round(0.5 * sr) + L; i + L < ch.length; i++) m = Math.max(m, Math.abs(ch[i] - ch[i + L]));
  }
  assert.ok(m <= 1e-6, `loop periodicity error ${m}`);
  assert.ok(peak(ref.left, L) > 0.05, 'the drone sounds');
  for (const block of [100, 480]) {
    const o = run(block);
    assert.equal(sameArray(o.left, ref.left), null, `block ${block} left`);
    assert.equal(sameArray(o.right, ref.right), null, `block ${block} right`);
  }
});

test('output does not depend on render block size (bit-identical)', () => {
  const schedule = (e) => {
    e.schedule(fullFrame(0, [
      { t: -0.05, f: 660, amp: 0.1, pan: -0.5, envRoutes: [{ a: 0.002, h: 0, d: 0.1, amount: 1 }], staticGain: 1 },
      { t: 0.0101, f: 880, amp: 0.1, pan: 0.5, envRoutes: [], staticGain: 0.7 },
    ]));
    const f2 = fullFrame(0.0052, [{ t: 0.3, f: 1200, amp: 0.1, pan: null, envRoutes: [{ a: 0.01, h: 0.02, d: 0.05, amount: 0.5 }], staticGain: 1 }]);
    f2.bandA[0] = 0.05; f2.bandF[3] = 300; f2.noiseF[2] = 3000; f2.balance = 0.7;
    e.schedule(f2);
    const f3 = fullFrame(0.40001);
    f3.match = 1.5; f3.bandPan[1] = -1;
    e.schedule(f3);
  };
  for (const stereo of [false, true]) {
    const mkS = () => { const e = mk({ stereo, plain: false }); schedule(e); return e; };
    const a = renderSec(mkS(), 1, 128);
    const big = mkS().render(SR);
    assert.equal(sameArray(big.left, a.left), null, 'one block vs 128-sample blocks (L)');
    if (stereo) assert.equal(sameArray(big.right, a.right), null, 'one block vs 128-sample blocks (R)');
    const one = mkS();
    const ones = new Float32Array(1000), onesR = new Float32Array(1000);
    for (let i = 0; i < 1000; i++) { const o = one.render(1); ones[i] = o.left[0]; if (stereo) onesR[i] = o.right[0]; }
    assert.equal(sameArray(ones, a.left, 1000), null, '1-sample blocks (L)');
    if (stereo) assert.equal(sameArray(onesR, a.right, 1000), null, '1-sample blocks (R)');
    assert.ok(peak(a.left, 0, 1000) > 0.01);
  }
});

test('a frame boundary inside a render block is applied at its exact sample', () => {
  const e = mk();
  e.schedule(makeFrame(100 / SR, { bandF: { 0: 1000 }, bandA: { 0: 0.1 } }));
  const { left } = e.render(128);
  for (let i = 0; i < 100; i++) assert.equal(left[i], 0, `sample ${i}`);
  assert.ok(left[100] !== 0 && left[101] !== 0, 'non-zero from sample 100');
  // a later frame inside a block: same output as stopping the block exactly there
  const run = (split) => {
    const x = mk();
    x.schedule(makeFrame(0, { bandF: { 0: 500 }, bandA: { 0: 0.1 } }));
    x.schedule(makeFrame(1037 / SR, { bandF: { 0: 800 }, bandA: { 0: 0.2 } }));
    const out = new Float32Array(2048);
    let pos = 0;
    for (const n of split) { out.set(x.render(n).left, pos); pos += n; }
    return out;
  };
  const r1 = run([2048]), r2 = run([1037, 1011]);
  assert.equal(sameArray(r1, r2), null);
  assert.ok(Math.abs(r1[1037] - r1[1036]) < 0.05, 'no step at the boundary');
});

test('comb and anchor frequencies appear in the spectrum', () => {
  const e = mk();
  e.schedule(makeFrame(0, { combF: { 0: 700, 5: 1300 }, combA: { 0: 0.05, 5: 0.05 }, anchorF: { 0: 110, 1: 220 }, anchorA: { 0: 0.1, 1: 0.05 } }));
  const { left } = renderSec(e, 1);
  const off = goertzel(left, 0, SR, 400);
  for (const f of [700, 1300, 110, 220]) assert.ok(goertzel(left, 0, SR, f) > 1e6 * (off + 1e-12), `${f} Hz present`);
});

test('noise band energy sits at its centre frequency', () => {
  const e = mk();
  e.schedule(makeFrame(0, { noiseF: { 0: 2000 }, noiseA: { 0: 0.1 } }));
  renderSec(e, 0.2);
  const { left } = renderSec(e, 1);
  const band = (lo, hi) => { let s = 0, n = 0; for (let f = lo; f <= hi; f += 5) { s += goertzel(left, 0, SR, f); n++; } return s / n; };
  const centre = band(1900, 2100);
  assert.ok(centre > 20 * band(400, 600), 'well above 500 Hz');
  assert.ok(centre > 20 * band(7000, 7200), 'well above 7 kHz');
  assert.ok(peak(left) > 0.01);
});

test('stereo noise is decorrelated between L and R', () => {
  const e = mk({ stereo: true });
  const fr = makeFrame(0);
  for (let k = 0; k < 20; k++) { fr.noiseF[k] = 100 * 2 ** (k / 4); fr.noiseA[k] = 0.05; }
  e.schedule(fr);
  renderSec(e, 0.5);
  const { left, right } = renderSec(e, 1);
  let sl = 0, sr = 0, sll = 0, srr = 0, slr = 0;
  const n = left.length;
  for (let i = 0; i < n; i++) { sl += left[i]; sr += right[i]; sll += left[i] ** 2; srr += right[i] ** 2; slr += left[i] * right[i]; }
  const corr = (slr - sl * sr / n) / Math.sqrt((sll - sl * sl / n) * (srr - sr * sr / n));
  assert.ok(Math.abs(corr) < 0.5, `L/R correlation ${corr}`);
  assert.ok(peak(left) > 0.01 && peak(right) > 0.01);
});

test('disposal: zeros afterwards, repeated dispose and late schedules are harmless', () => {
  const e = mk({ stereo: true });
  e.schedule(fullFrame(0));
  assert.ok(peak(e.render(512).left) > 0);
  e.dispose();
  assert.doesNotThrow(() => e.dispose());
  assert.doesNotThrow(() => e.schedule(fullFrame(1)));
  const o = e.render(300);
  assert.equal(o.left.length, 300);
  assert.equal(peak(o.left), 0);
  assert.equal(peak(o.right), 0);
  assert.equal(e.render(0).left.length, 0);
});

test('an event whose route does not reach 0 (amount 0.5) ends through the 5 ms fade, without a step', () => {
  const e = mk();
  const route = { a: 0.002, h: 0, d: 0.02, amount: 0.5 };   // life 0.162 s: ends at 0.262 s, mid-cycle at 1100 Hz
  e.schedule(makeFrame(0, { events: [{ t: 0.1, f: 1100, amp: 0.2, pan: 0, envRoutes: [route], staticGain: 1 }] }));
  const { left } = renderSec(e, 0.4);
  let last = -1;
  for (let i = 0; i < left.length; i++) if (left[i] !== 0) last = i;
  assert.ok(Math.abs(last - Math.round(0.262 * SR)) <= 2, `voice ends at sample ${last}`);
  let pre = 0;
  for (let i = last - 720; i < last - 240; i++) pre = Math.max(pre, Math.abs(left[i]));
  assert.ok(Math.abs(pre - 0.1) < 0.005, `level before the fade ${pre} (route floor 1 - amount)`);
  assert.ok(Math.abs(left[last]) < 1e-3, `step at removal ${left[last]}`);
});

test('sanitising defaults: balance NaN = 0.5, match NaN = 1, staticGain NaN = 1', () => {
  const ev = (sg) => ({ t: 0.05, f: 900, amp: 0.1, pan: 0, envRoutes: [{ a: 0.002, h: 0, d: 0.1, amount: 1 }], staticGain: sg });
  const run = (over, sg = 1) => {
    const e = mk();
    e.schedule(makeFrame(0, { bandF: { 0: 440 }, bandA: { 0: 0.1 }, events: [ev(sg)], ...over }));
    e.schedule(makeFrame(0.2, { bandF: { 0: 550 }, bandA: { 0: 0.05 }, ...over }));
    return renderSec(e, 0.4).left;
  };
  const ref = run({});
  assert.ok(peak(ref) > 0.1);
  assert.equal(sameArray(run({ balance: NaN }), ref), null, 'balance NaN');
  assert.equal(sameArray(run({ match: NaN }), ref), null, 'match NaN');
  assert.equal(sameArray(run({}, NaN), ref), null, 'staticGain NaN');
  assert.equal(sameArray(run({}, undefined), ref), null, 'staticGain missing');
});

test('a sounding band glides to a new frequency with the 0.07 s one-pole', () => {
  const A = 0.1, e = mk();
  e.schedule(makeFrame(0, { bandF: { 0: 440 }, bandA: { 0: A } }));
  e.schedule(makeFrame(0.5, { bandF: { 0: 660 }, bandA: { 0: A } }));
  const { left } = renderSec(e, 1.5);
  let jump = 0;
  for (let i = Math.round(0.45 * SR); i < left.length; i++) jump = Math.max(jump, Math.abs(left[i] - left[i - 1]));
  assert.ok(jump <= 1.02 * A * 2 * Math.PI * 660 / SR, `largest jump ${jump}`);
  // instantaneous frequency around 0.57 s from upward zero crossings
  const ups = [];
  for (let i = Math.round(0.56 * SR); i < Math.round(0.58 * SR); i++) {
    if (left[i - 1] < 0 && left[i] >= 0) ups.push((i - 1 + -left[i - 1] / (left[i] - left[i - 1])) / SR);
  }
  const fMeas = (ups.length - 1) / (ups[ups.length - 1] - ups[0]);
  const fWant = 660 - 220 * Math.exp(-(0.57 - 0.5) / 0.07);
  assert.ok(Math.abs(fMeas - fWant) < 4, `frequency at 0.57 s ${fMeas} vs ${fWant}`);
  let best = 0, bp = -1;
  for (let f = 640; f <= 680; f += 0.5) { const p = goertzel(left, SR, SR / 2, f); if (p > bp) { bp = p; best = f; } }
  assert.ok(Math.abs(best - 660) <= 1, `converged to ${best}`);
});

test('long silence: smoothed state reaches exact zeros (no denormals) and stays cheap', () => {
  for (const stereo of [false, true]) {
    const sr = 12000, e = createChannelSynth({ sampleRate: sr, stereo, seed: 4, plain: false });
    const loud = fullFrame(0, [{ t: 0, f: 500, amp: 0.1, pan: 1, envRoutes: [{ a: 0.002, h: 0, d: 0.05, amount: 1 }], staticGain: 1 }]);
    for (let b = 0; b < 10; b++) loud.bandPan[b] = b % 2 ? 1 : -1;   // pan gains with exact-0 / ~6e-17 targets
    e.schedule(loud);
    renderSec(e, 0.5, 4096, sr);
    e.schedule(makeFrame(0.5, { balance: 1 }));    // all zero, frequencies 0, events muted
    const time = (blocks) => { const t0 = performance.now(); for (let i = 0; i < blocks; i++) e.render(128); return (performance.now() - t0) / blocks; };
    const early = time(200);
    let last = null;
    const blocks = Math.ceil(120 * sr / 4096);
    for (let i = 0; i < blocks; i++) last = e.render(4096);
    const min = e._debugStateMin();
    assert.ok(min === Infinity || min >= 1e-30, `smallest non-zero state ${min} (stereo ${stereo})`);
    assert.equal(peak(last.left), 0, 'exact silence after the ramp');
    if (stereo) assert.equal(peak(last.right), 0);
    const late = time(200);
    console.log(`# silent block time (stereo ${stereo}): just after cut ${early.toFixed(4)} ms, after 120 s ${late.toFixed(4)} ms`);
    assert.ok(late <= 2 * early + 0.02, `late ${late} ms vs early ${early} ms`);
  }
});

test('performance: fully active mono channel, mean time per 128-sample block', () => {
  const e = createChannelSynth({ sampleRate: SR, stereo: false, seed: 1, plain: false });
  e.schedule(fullFrame(0));
  for (let i = 0; i < 100; i++) e.render(128);   // warm-up
  const t0 = performance.now();
  for (let i = 0; i < 300; i++) e.render(128);
  const mean = (performance.now() - t0) / 300;
  console.log(`# ChannelSynth mean block time (128 frames, 48 kHz, fully active mono): ${mean.toFixed(4)} ms`);
  assert.ok(mean < 2, `mean ${mean} ms per block`);
});
