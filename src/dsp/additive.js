/*
 * ChannelSynth: the additive Voice Engine (contract: src/audio/engine-contract.js).
 * Port of the prototype's buildEngine voices (index.html lines 802-990, FM omitted) without Web Audio:
 *   - 10 band voices x 3 sine oscillators on a band bus with a slow "wobble" gain
 *     0.72 + 0.28*sin(2*pi*m*t/LP + phi), m in {1,2,3}, LP = loopSec || 48 (off with opts.plain);
 *   - 64 comb sines and 2 anchor sines (centred);
 *   - 20 RBJ band-pass biquads (Q = 4, 0 dB peak) on one seeded white-noise buffer of
 *     round(sampleRate * (loopSec || 15)) samples read in a loop; in stereo the noise sum reaches
 *     L and R through 7 ms and 13 ms delays (decorrelation, as the prototype);
 *   - events: one sine voice per EventSpec with its AHD gain (envValue from core/modulation.js).
 * Pure module: no DOM, no Web Audio, no clocks, no Math.random. All randomness is seeded.
 *
 * Processing is per sample inside sub-blocks split at frame and event boundaries. Every state update
 * (phases, one-pole smoothing, filters, the wobble) depends only on the absolute sample index, so the
 * output does not depend on how render() calls partition time (bit-identical for any block size).
 *
 * Choices beyond the contract:
 *   - an oscillator whose smoothed amplitude is silent (< 1e-9) when a frame is applied takes the new
 *     frequency at once (no audible glide from an inaudible state, e.g. from 0 Hz at the first frame);
 *   - a voice with target frequency 0 is silent (no DC);
 *   - one-pole states snap onto their target when within 1e-12 (gains, pans) or 1e-9 Hz (frequencies),
 *     and biquad states below 1e-30 are flushed, so long silences end in exact zeros, not denormals;
 *     _debugStateMin() is a test-only hook that checks this;
 *   - an event with envelope routes fades linearly over the last 5 ms of its life, so routes with
 *     |amount| < 1 (whose gain does not reach 0) end without a click.
 */
import { envValue } from '../core/modulation.js';
import { MAXB, COMB, NK } from './partials.js';

const TWO_PI = 2 * Math.PI;
const TC_GAIN = 0.04, TC_FREQ = 0.07;          // the prototype's setTargetAtTime constants
const EPS = 1e-9;                              // silent-voice threshold
// One-pole states snap onto their target once this close (per sample, so block-size independent):
// without it a decay toward 0 ends in denormals (~5e-321 after ~30 s), which are slow on x86.
const SNAP_A = 1e-12, SNAP_F = 1e-9;            // gains / pans, frequencies (Hz)
const FLUSH = 1e-30;                           // biquad states below this are flushed to 0
const MAX_AMP = 10;                            // amplitude / gain clamp
const NBO = 3 * MAXB;                          // band oscillators
const ANCH0 = NBO + COMB;                      // first anchor oscillator
const NOSC = ANCH0 + 2;
const WOBBLE_DC = 0.72, WOBBLE_DEPTH = 0.28, WOBBLE_LOOP = 48;
const NOISE_SEC = 15, NOISE_Q = 4, NOISE_F0 = 1000, NOISE_MIN_F = 10, COEF_EVERY = 16;
const NOISE_DELAY_L = 0.007, NOISE_DELAY_R = 0.013;
const GATE_HOLD = 0.245, GATE_LIFE = 0.25;     // ruling R1: 0.25 s gate with a 5 ms linear release
const END_FADE = 0.005;
const MIN_ATTACK = 0.002, MIN_DECAY = 0.02, ENV_LIFE_DECAYS = 8;
const TRIG0 = [0];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const fin = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** The prototype's mulberry32 PRNG (index.html line 427). */
function mulberry32(a) {
  return () => {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

const at = (arr, i) => (arr && i < arr.length ? Number(arr[i]) : 0);

export class ChannelSynth {
  constructor(opts = {}) {
    const sr = fin(opts.sampleRate, 0) > 0 ? opts.sampleRate : 48000;
    this.sr = sr;
    this.invSr = 1 / sr;
    this.stereo = !!opts.stereo;
    this.plain = !!opts.plain;
    const loopSec = fin(opts.loopSec, 0) > 0 ? opts.loopSec : 0;
    this.fMax = 0.45 * sr;
    this.kG = 1 - Math.exp(-1 / (sr * TC_GAIN));
    this.kF = 1 - Math.exp(-1 / (sr * TC_FREQ));
    this.kF16 = 1 - Math.exp(-COEF_EVERY / (sr * TC_FREQ));
    const seed = fin(opts.seed, 0);

    // oscillators: [0, NBO) bands (3 per band), [NBO, ANCH0) comb, [ANCH0, NOSC) anchors; phase in cycles
    this.ph = new Float64Array(NOSC);
    this.f = new Float64Array(NOSC); this.tf = new Float64Array(NOSC);
    this.a = new Float64Array(NOSC); this.ta = new Float64Array(NOSC);
    this.wph = new Float64Array(MAXB); this.wrate = new Float64Array(MAXB);
    const rng = mulberry32(seed);
    const LP = loopSec || WOBBLE_LOOP;
    for (let b = 0; b < MAXB; b++) {   // the prototype's order: wobble phase, wobble rate, 3 oscillator phases
      this.wph[b] = rng() * TWO_PI;
      this.wrate[b] = (1 + Math.floor(rng() * 3)) / (LP * sr);   // cycles per sample
      for (let k = 0; k < 3; k++) this.ph[3 * b + k] = rng();
    }
    for (let i = NBO; i < NOSC; i++) this.ph[i] = rng();
    const c = Math.cos(Math.PI / 4);
    this.pL = new Float64Array(MAXB).fill(c); this.pR = new Float64Array(MAXB).fill(c);
    this.tpL = new Float64Array(MAXB).fill(c); this.tpR = new Float64Array(MAXB).fill(c);

    // noise bank
    const nlen = Math.max(1, Math.round(sr * (loopSec || NOISE_SEC)));
    this.noise = new Float32Array(nlen);
    const nrng = mulberry32(seed ^ 0x5EED);
    for (let i = 0; i < nlen; i++) this.noise[i] = nrng() * 2 - 1;
    this.npos = 0;
    this.nf = new Float64Array(NK).fill(NOISE_F0); this.ntf = new Float64Array(NK).fill(NOISE_F0);
    this.ng = new Float64Array(NK); this.ntg = new Float64Array(NK);
    this.cf = new Float64Array(NK).fill(NaN);      // frequency the coefficients were computed for
    this.b0 = new Float64Array(NK); this.a1 = new Float64Array(NK); this.a2 = new Float64Array(NK);
    this.z1 = new Float64Array(NK); this.z2 = new Float64Array(NK);
    for (let k = 0; k < NK; k++) this._coef(k);
    if (this.stereo) {
      this.offL = Math.round(NOISE_DELAY_L * sr); this.offR = Math.round(NOISE_DELAY_R * sr);
      let size = 1;
      while (size <= this.offR) size <<= 1;
      this.dly = new Float64Array(size); this.dmask = size - 1; this.dw = 0;
    }

    this.gd = 0; this.tgd = 0; this.ge = 0; this.tge = 0;   // drone / event output gains
    this.n = 0;                 // engine time in samples
    this.frames = [];           // pending {s, ...targets}, sorted by s
    this.pending = [];          // pending event voices, sorted by start
    this.voices = [];
    this.first = true;
    this.disposed = false;
    this.cap = 0;
  }

  // ---- control --------------------------------------------------------------------------------

  schedule(frame) {
    if (this.disposed || !frame || typeof frame !== 'object') return;
    const t = frame.t;
    if (typeof t !== 'number' || !Number.isFinite(t)) return;
    const p = this._targets(frame);
    if (Array.isArray(frame.events)) for (const e of frame.events) this._addEvent(e);
    if (this.first) {
      this.first = false;
      if (p.s <= this.n) { this._apply(p, true); return; }
    }
    const q = this.frames;
    let i = q.length;
    while (i > 0 && q[i - 1].s > p.s) i--;
    q.splice(i, 0, p);
  }

  /** Sanitised targets of a frame. */
  _targets(fr) {
    const amp = (v) => (Number.isFinite(v) ? clamp(v, 0, MAX_AMP) : 0);
    const frq = (v) => (Number.isFinite(v) && v > 0 ? Math.min(this.fMax, v) : 0);
    const tf = new Float64Array(NOSC), ta = new Float64Array(NOSC);
    const set = (i, f, a) => { tf[i] = frq(f); ta[i] = tf[i] > 0 ? amp(a) : 0; };
    for (let i = 0; i < NBO; i++) set(i, at(fr.bandF, i), at(fr.bandA, i));
    for (let j = 0; j < COMB; j++) set(NBO + j, at(fr.combF, j), at(fr.combA, j));
    for (let j = 0; j < 2; j++) set(ANCH0 + j, at(fr.anchorF, j), at(fr.anchorA, j));
    const pl = new Float64Array(MAXB), pr = new Float64Array(MAXB);
    for (let b = 0; b < MAXB; b++) {
      const x = (clamp(fin(at(fr.bandPan, b), 0), -1, 1) + 1) * Math.PI / 4;
      pl[b] = Math.cos(x); pr[b] = Math.sin(x);
    }
    const nf = new Float64Array(NK), ng = new Float64Array(NK);
    for (let k = 0; k < NK; k++) {
      nf[k] = frq(at(fr.noiseF, k));
      ng[k] = nf[k] > 0 ? amp(at(fr.noiseA, k)) : 0;
    }
    const bal = clamp(fin(fr.balance, 0.5), 0, 1), match = clamp(fin(fr.match, 1), 0, MAX_AMP);
    return {
      s: Math.round(fr.t * this.sr), tf, ta, pl, pr, nf, ng,
      gd: match * Math.min(1, 2 * (1 - bal)), ge: match * Math.min(1, 2 * bal),
    };
  }

  _apply(p, instant) {
    const { f, a, tf, ta } = this;
    for (let i = 0; i < NOSC; i++) {
      tf[i] = p.tf[i]; ta[i] = p.ta[i];
      if (instant) { f[i] = tf[i]; a[i] = ta[i]; } else if (a[i] < EPS) f[i] = tf[i];
    }
    this.tpL.set(p.pl); this.tpR.set(p.pr);
    if (instant) { this.pL.set(p.pl); this.pR.set(p.pr); }
    for (let k = 0; k < NK; k++) {
      this.ntg[k] = p.ng[k];
      if (p.nf[k] > 0) this.ntf[k] = p.nf[k];   // a zero centre keeps the old one (that band is silent)
      if (instant) this.ng[k] = p.ng[k];
      if (instant || this.ng[k] < EPS) { this.nf[k] = this.ntf[k]; this._coef(k); }
    }
    this.tgd = p.gd; this.tge = p.ge;
    if (instant) { this.gd = p.gd; this.ge = p.ge; }
  }

  /** RBJ band-pass (constant 0 dB peak), as Web Audio's BiquadFilterNode 'bandpass'. */
  _coef(k) {
    const f = clamp(this.nf[k], NOISE_MIN_F, this.fMax);
    this.cf[k] = this.nf[k];
    const w0 = TWO_PI * f / this.sr, alpha = Math.sin(w0) / (2 * NOISE_Q), a0 = 1 + alpha;
    this.b0[k] = alpha / a0;
    this.a1[k] = -2 * Math.cos(w0) / a0;
    this.a2[k] = (1 - alpha) / a0;
  }

  _addEvent(e) {
    if (!e || typeof e !== 'object') return;
    const { t, f, amp } = e;
    if (![t, f, amp].every((v) => typeof v === 'number' && Number.isFinite(v))) return;
    const gain = Math.min(amp, MAX_AMP) * clamp(fin(e.staticGain, 1), 0, MAX_AMP);
    if (f <= 0 || !(gain > 0)) return;
    const routes = [];
    for (const r of Array.isArray(e.envRoutes) ? e.envRoutes : []) {
      if (!r || typeof r !== 'object' || !Number.isFinite(r.amount)) continue;
      routes.push({
        a: Math.max(MIN_ATTACK, fin(r.a, MIN_ATTACK)), h: Math.max(0, fin(r.h, 0)),
        d: Math.max(MIN_DECAY, fin(r.d, MIN_DECAY)), amount: clamp(r.amount, -1, 1),
      });
    }
    const life = routes.length ? Math.max(...routes.map((r) => r.a + r.h + ENV_LIFE_DECAYS * r.d)) : GATE_LIFE;
    let gL = 1, gR = 1;   // centred (and mono)
    if (this.stereo && typeof e.pan === 'number' && Number.isFinite(e.pan)) {
      const x = (clamp(e.pan, -1, 1) + 1) * Math.PI / 4;
      gL = Math.cos(x); gR = Math.sin(x);
    }
    const v = { t, start: Math.round(t * this.sr), f: Math.min(f, this.fMax), gain, gL, gR, routes, life, age0: 0, cnt: 0 };
    if (v.start <= this.n) this._startVoice(v, this.n);
    else {
      const q = this.pending;
      let i = q.length;
      while (i > 0 && q[i - 1].start > v.start) i--;
      q.splice(i, 0, v);
    }
  }

  _startVoice(v, n) {
    v.age0 = n * this.invSr - v.t;
    if (v.age0 >= v.life) return;
    this.voices.push(v);
  }

  _voiceGain(v, age) {
    if (age < 0 || age >= v.life) return 0;
    let g = v.gain;
    const rs = v.routes;
    if (rs.length === 0) return age > GATE_HOLD ? g * (GATE_LIFE - age) / (GATE_LIFE - GATE_HOLD) : g;
    for (let i = 0; i < rs.length; i++) g *= 1 + rs[i].amount * (envValue(rs[i], TRIG0, age) - 1);
    const left = v.life - age;
    return left < END_FADE ? g * left / END_FADE : g;
  }

  // ---- audio ----------------------------------------------------------------------------------

  render(frames) {
    const N = Math.max(0, Math.floor(fin(Number(frames), 0)));
    const left = new Float32Array(N), right = this.stereo ? new Float32Array(N) : null;
    if (this.disposed) return { left, right };
    let pos = 0;
    while (pos < N) {
      while (this.frames.length && this.frames[0].s <= this.n) this._apply(this.frames.shift(), false);
      while (this.pending.length && this.pending[0].start <= this.n) this._startVoice(this.pending.shift(), this.n);
      let len = N - pos;
      if (this.frames.length) len = Math.min(len, this.frames[0].s - this.n);
      if (this.pending.length) len = Math.min(len, this.pending[0].start - this.n);
      this._process(left, right, pos, len);
      pos += len;
      this.n += len;
    }
    return { left, right };
  }

  dispose() {
    this.disposed = true;
    this.frames = []; this.pending = []; this.voices = [];
    this.noise = null; this.dly = null;
    this.dL = this.dR = this.eL = this.eR = this.tmp = this.cb = null;
  }

  /**
   * TEST-ONLY hook: the smallest non-zero |value| across the smoothed and recursive state (amplitudes,
   * frequencies, pans, noise gains and centres, output gains, biquad states, noise delay ring).
   * Infinity when everything is exactly 0. Used to check that no state decays into denormals.
   */
  _debugStateMin() {
    let m = Infinity;
    const scan = (x) => { const v = Math.abs(x); if (v !== 0 && v < m) m = v; };
    for (const arr of [this.a, this.f, this.pL, this.pR, this.ng, this.nf, this.z1, this.z2, this.dly]) {
      if (arr) for (let i = 0; i < arr.length; i++) scan(arr[i]);
    }
    scan(this.gd); scan(this.ge);
    return m;
  }

  _scratch(len) {
    if (len <= this.cap) return;
    this.cap = Math.max(len, 2 * this.cap, 128);
    for (const k of ['dL', 'dR', 'eL', 'eR', 'tmp', 'cb']) this[k] = new Float64Array(this.cap);
  }

  /** One sine oscillator over `len` samples, added into buf; returns whether it could be heard. */
  _osc(i, buf, len) {
    const kF = this.kF, kG = this.kG, inv = this.invSr, tf = this.tf[i], ta = this.ta[i];
    let p = this.ph[i], f = this.f[i], a = this.a[i];
    const loud = a >= EPS || ta >= EPS;
    if (!loud && a === ta && f === tf) {
      // settled and silent: only the phase moves
      const df = f * inv;
      for (let j = 0; j < len; j++) { p += df; if (p >= 1) p -= 1; }
    } else if (!loud) {
      // silent for the whole sub-block (a moves monotonically toward ta): only advance the state
      for (let j = 0; j < len; j++) {
        f += (tf - f) * kF; if (Math.abs(tf - f) < SNAP_F) f = tf;
        a += (ta - a) * kG; if (Math.abs(ta - a) < SNAP_A) a = ta;
        p += f * inv; if (p >= 1) p -= 1;
      }
    } else {
      for (let j = 0; j < len; j++) {
        f += (tf - f) * kF; if (Math.abs(tf - f) < SNAP_F) f = tf;
        a += (ta - a) * kG; if (Math.abs(ta - a) < SNAP_A) a = ta;
        if (a >= EPS || ta >= EPS) buf[j] += a * Math.sin(TWO_PI * p);
        p += f * inv; if (p >= 1) p -= 1;
      }
    }
    this.ph[i] = p; this.f[i] = f; this.a[i] = a;
    return loud;
  }

  _process(left, right, off, len) {
    this._scratch(len);
    const { dL, dR, eL, eR, tmp, cb, stereo, kG } = this;
    const n0 = this.n;
    dL.fill(0, 0, len); cb.fill(0, 0, len); eL.fill(0, 0, len);
    if (stereo) { dR.fill(0, 0, len); eR.fill(0, 0, len); }

    // band voices: 3 oscillators -> band bus (wobble) -> constant-power pan
    for (let b = 0; b < MAXB; b++) {
      tmp.fill(0, 0, len);
      let loud = false;
      for (let k = 0; k < 3; k++) loud = this._osc(3 * b + k, tmp, len) || loud;
      let pl = this.pL[b], pr = this.pR[b];
      const tpl = this.tpL[b], tpr = this.tpR[b];
      if (loud) {
        const plain = this.plain, wr = this.wrate[b], wp = this.wph[b];
        for (let j = 0; j < len; j++) {
          let s = tmp[j];
          if (!plain) {
            const cyc = wr * (n0 + j);
            s *= WOBBLE_DC + WOBBLE_DEPTH * Math.sin(TWO_PI * (cyc - Math.floor(cyc)) + wp);
          }
          if (stereo) {
            pl += (tpl - pl) * kG; if (Math.abs(tpl - pl) < SNAP_A) pl = tpl;
            pr += (tpr - pr) * kG; if (Math.abs(tpr - pr) < SNAP_A) pr = tpr;
            dL[j] += s * pl; dR[j] += s * pr;
          } else dL[j] += s;
        }
      } else if (stereo && (pl !== tpl || pr !== tpr)) {
        for (let j = 0; j < len; j++) {
          pl += (tpl - pl) * kG; if (Math.abs(tpl - pl) < SNAP_A) pl = tpl;
          pr += (tpr - pr) * kG; if (Math.abs(tpr - pr) < SNAP_A) pr = tpr;
        }
      }
      this.pL[b] = pl; this.pR[b] = pr;
    }

    // comb and anchors, centred
    for (let i = NBO; i < NOSC; i++) this._osc(i, cb, len);
    for (let j = 0; j < len; j++) { dL[j] += cb[j]; if (stereo) dR[j] += cb[j]; }

    this._noise(len, n0);

    // events
    const vs = this.voices;
    if (vs.length) {
      const inv = this.invSr;
      let dead = 0;
      for (const v of vs) {
        const f = v.f, gL = v.gL, gR = v.gR, a0 = v.age0, c0 = v.cnt;
        for (let j = 0; j < len; j++) {
          const age = a0 + (c0 + j) * inv;
          const g = this._voiceGain(v, age);
          if (g === 0) continue;
          let ph = f * age; ph -= Math.floor(ph);
          const s = g * Math.sin(TWO_PI * ph);
          eL[j] += s * gL;
          if (stereo) eR[j] += s * gR;
        }
        v.cnt += len;
        if (a0 + v.cnt * inv >= v.life) { v.dead = true; dead++; }
      }
      if (dead) this.voices = vs.filter((v) => !v.dead);
    }

    // output scaling: drone x match*min(1,2(1-balance)), events x match*min(1,2*balance)
    let gd = this.gd, ge = this.ge;
    const tgd = this.tgd, tge = this.tge;
    for (let j = 0; j < len; j++) {
      gd += (tgd - gd) * kG; if (Math.abs(tgd - gd) < SNAP_A) gd = tgd;
      ge += (tge - ge) * kG; if (Math.abs(tge - ge) < SNAP_A) ge = tge;
      left[off + j] = dL[j] * gd + eL[j] * ge;
      if (stereo) right[off + j] = dR[j] * gd + eR[j] * ge;
    }
    this.gd = gd; this.ge = ge;
  }

  _noise(len, n0) {
    const { noise, nf, ntf, ng, ntg, cf, b0, a1, a2, z1, z2, kG, kF16, stereo, dL, dR } = this;
    const nlen = noise.length;
    let np = this.npos;
    const dly = this.dly, mask = this.dmask, offL = this.offL, offR = this.offR;
    let dw = this.dw;
    for (let j = 0; j < len; j++) {
      if ((n0 + j) % COEF_EVERY === 0) {
        for (let k = 0; k < NK; k++) {
          nf[k] += (ntf[k] - nf[k]) * kF16;
          if (Math.abs(ntf[k] - nf[k]) < SNAP_F) nf[k] = ntf[k];
          if (nf[k] !== cf[k]) this._coef(k);
          if (Math.abs(z1[k]) < FLUSH) z1[k] = 0;
          if (Math.abs(z2[k]) < FLUSH) z2[k] = 0;
        }
      }
      const x = noise[np];
      if (++np === nlen) np = 0;
      let s = 0;
      for (let k = 0; k < NK; k++) {
        const bk = b0[k], y = bk * x + z1[k];
        z1[k] = -a1[k] * y + z2[k];
        z2[k] = -bk * x - a2[k] * y;
        ng[k] += (ntg[k] - ng[k]) * kG; if (Math.abs(ntg[k] - ng[k]) < SNAP_A) ng[k] = ntg[k];
        s += ng[k] * y;
      }
      if (stereo) {
        dly[dw] = s;
        dL[j] += dly[(dw - offL) & mask];
        dR[j] += dly[(dw - offR) & mask];
        dw = (dw + 1) & mask;
      } else dL[j] += s;
    }
    this.npos = np; this.dw = dw;
  }
}

/** Voice Engine factory (the `create` of the engine contract). */
export function createChannelSynth(opts) {
  return new ChannelSynth(opts);
}
