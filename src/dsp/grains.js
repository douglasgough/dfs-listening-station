/*
 * Granular windows and the granular loudness match (spec section 4.1).
 * Pure module: no DOM, no Web Audio.
 *
 * A granular channel replaces its window with short grains of window scattered across the
 * filter region. Grains are stateless: each is a function of its time slot (GSLOT per second),
 * so loop renders repeat exactly and changing density only adds or removes grains.
 *
 * Raw grains are about 10 dB quieter (RMS over the spectrum) than the plain window with the same
 * center/width/softness/level. loudnessMatch() returns the gain that brings them level: the ratio
 * of the window's RMS coverage to the EXPECTED time-averaged RMS coverage of the grains, capped
 * at +20 dB. It is statistical, so it does not pump with individual grains.
 */
import { winOne } from './window.js';

export const GSLOT = 12;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Integer hash to [-1, 1) (prototype hash01). */
function hash01(n) {
  n = Math.imul(n ^ 0x9E3779B9, 0x85EBCA6B); n ^= n >>> 13; n = Math.imul(n, 0xC2B2AE35); n ^= n >>> 16;
  return ((n >>> 0) / 4294967296) * 2 - 1;
}

/** Grain parameters derived from a ResolvedChannel (short keys). */
function grainParams(ch) {
  return {
    c: ch['filter.center'], span: ch['filter.width'], soft: ch['filter.soft'], lvl: ch['filter.level'],
    scat: ch['grain.scatter'],
    size: 0.01 * 50 ** ch['grain.size'],
    prob: clamp(0.2 * 60 ** ch['grain.density'] / GSLOT, 0, 1),
    dur: ch['grain.dur'], speed: ch['grain.speed'], wj: ch['grain.jitter'],
  };
}

/**
 * Grains of a granular channel at time t: an array of [u, width, soft, level].
 * Port of the prototype grainsAt. With loopSec = L > 0 the slot index wraps every GSLOT*L slots
 * and the playhead speed is rounded to whole cycles per loop, so grainsAt(t) equals grainsAt(t+L).
 * In loop mode t is first reduced modulo L (exact in floating point), which makes that equality
 * bit-exact rather than merely equal up to rounding.
 */
export function grainsAt(ch, seed, t, loopSec) {
  const { c, span, soft, lvl, scat, size, prob, dur, wj } = grainParams(ch);
  const L = loopSec > 0 ? loopSec : 0;
  if (L) t = ((t % L) + L) % L;
  const K = L ? GSLOT * L : 0, speed = L ? Math.round(ch['grain.speed'] * L) / L : ch['grain.speed'], out = [];
  for (let k = Math.floor((t - dur) * GSLOT) - 1; k <= Math.floor(t * GSLOT); k++) {
    const idx = K ? ((k % K) + K) % K : k, hs = seed + idx * 4;
    const tk = (k + hash01(hs) * 0.5 + 0.5) / GSLOT, x = t - tk;
    if (x < 0 || x >= dur) continue;
    if (hash01(hs + 1) * 0.5 + 0.5 >= prob) continue;
    const ph = speed ? ((speed * tk) % 1 + 1) % 1 - 0.5 : 0;
    const u = clamp(c + ph * span + hash01(hs + 2) * 0.5 * scat * span, 0, 1);
    const gw = clamp(size * (1 + wj * 0.8 * hash01(hs + 3)), 0.004, 1), e = Math.sin(Math.PI * x / dur);
    out.push([u, gw, soft, lvl * e * e]);
  }
  return out;
}

/** RMS over u in [0,1] (512-point midpoint grid) of the plain window at the channel's level. */
export function windowRmsCoverage(ch) {
  const c = ch['filter.center'], w = ch['filter.width'], s = ch['filter.soft'], l = ch['filter.level'];
  const N = 512;
  let acc = 0;
  for (let i = 0; i < N; i++) { const g = winOne((i + 0.5) / N, c, w, s) * l; acc += g * g; }
  return Math.sqrt(acc / N);
}

/*
 * Expected-RMS estimator (exact expectation of the grain model, evaluated by fixed quadrature).
 *
 * Model (matches grainsAt): slot k holds a grain with probability p, independently of the other
 * slots, born at (k+v)/GSLOT with v uniform in [0,1). At time t with slot phase phi = frac(t*GSLOT),
 * the grain of the slot j slots back has age x uniform in ((j+phi-1)/GSLOT, (j+phi)/GSLOT] and
 * contributes g(u) = lvl * sin^2(pi x/dur) * winOne(u, centre, gw, soft), with
 *   centre = clamp(c + ph*span + U*0.5*scat*span, 0, 1), U uniform in [-1,1],
 *   gw = clamp(size*(1 + wj*0.8*V), 0.004, 1),        V uniform in [-1,1],
 *   ph = frac(theta - speed*x) - 0.5 with theta = frac(speed*t) (ph = 0 when speed = 0).
 * Given (phi, theta) the slots are independent, so for a(u) = 1 - prod(1 - g):
 *   F1 = E[prod(1-g)]   = prod_j (1 - p*E[g_j]),
 *   F2 = E[prod(1-g)^2] = prod_j (1 - p*E[2g_j - g_j^2]),
 *   E[a^2] = 1 - 2*F1 + F2.
 * The time average is the mean over phi and theta (both equidistributed over long times), and
 * the RMS is sqrt of its mean over u. E[w] and E[w^2] over (U, V) depend only on u and ph, so they
 * are tabulated once; the age only scales them by sin^2 and sin^4.
 */
const NU = 128;      // u grid (midpoints)
const NUS = 32;      // scatter (U) quadrature points
const NV = 5;        // width-jitter (V) quadrature points
const NPHI = 8;      // slot-phase points
const NSUB = 4;      // age points per slot
const NTH = 8;       // playhead-phase points (speed != 0)
const NPH = 32;      // ph table resolution (speed != 0)
const ND = 2048;     // distance table for the V-averaged window
const MAX_SLOTS = 64;

function estimateGrainRms(ch) {
  const { c, span, soft, lvl, scat, size, prob: p, dur, speed, wj } = grainParams(ch);
  if (!(p > 0) || !(lvl > 0) || !(dur > 0)) return 0;

  // V-averaged window and squared window as functions of the distance d = |u - centre|.
  const B1 = new Float64Array(ND + 1), B2 = new Float64Array(ND + 1);
  const gws = [];
  for (let iv = 0; iv < NV; iv++) gws.push(clamp(size * (1 + wj * 0.8 * (2 * (iv + 0.5) / NV - 1)), 0.004, 1));
  for (let i = 0; i <= ND; i++) {
    const d = i / ND;
    let a = 0, b = 0;
    for (const gw of gws) { const w = winOne(d, 0, gw, soft); a += w; b += w * w; }
    B1[i] = a / NV; B2[i] = b / NV;
  }
  const look = (T, d) => { const q = d * ND, i = Math.floor(q); return i >= ND ? T[ND] : T[i] + (T[i + 1] - T[i]) * (q - i); };

  // W1[ph][u] = E[w], W2[ph][u] = E[w^2] over scatter and width jitter.
  const moving = speed !== 0;
  const nph = moving ? NPH : 1;
  const W1 = [], W2 = [];
  for (let ip = 0; ip < nph; ip++) {
    const ph = moving ? (ip + 0.5) / NPH - 0.5 : 0;
    const centres = [];
    for (let iu = 0; iu < NUS; iu++) centres.push(clamp(c + ph * span + (2 * (iu + 0.5) / NUS - 1) * 0.5 * scat * span, 0, 1));
    const w1 = new Float64Array(NU), w2 = new Float64Array(NU);
    for (let j = 0; j < NU; j++) {
      const u = (j + 0.5) / NU;
      let a = 0, b = 0;
      for (const cc of centres) { const d = Math.abs(u - cc); a += look(B1, d); b += look(B2, d); }
      w1[j] = a / NUS; w2[j] = b / NUS;
    }
    W1.push(w1); W2.push(w2);
  }

  const nSlots = Math.min(MAX_SLOTS, Math.ceil(dur * GSLOT) + 1);
  const nth = moving ? NTH : 1;
  const F1 = new Float64Array(NU), F2 = new Float64Array(NU), m1 = new Float64Array(NU), m2 = new Float64Array(NU);
  let acc = 0;
  for (let it = 0; it < nth; it++) {
    const theta = (it + 0.5) / nth;
    for (let iphi = 0; iphi < NPHI; iphi++) {
      const phi = (iphi + 0.5) / NPHI;
      F1.fill(1); F2.fill(1);
      for (let j = 0; j < nSlots; j++) {
        const lo = Math.max(0, (j + phi - 1) / GSLOT), hi = Math.min(dur, (j + phi) / GSLOT);
        if (hi <= lo) continue;
        const wt = (hi - lo) * GSLOT / NSUB; // probability mass of each age sub-interval
        m1.fill(0); m2.fill(0);
        for (let s = 0; s < NSUB; s++) {
          const x = lo + (s + 0.5) * (hi - lo) / NSUB, e = Math.sin(Math.PI * x / dur), e2 = e * e;
          const a1 = wt * lvl * e2, a2 = wt * lvl * lvl * e2 * e2;
          let ip = 0;
          if (moving) { const ph = ((theta - speed * x) % 1 + 1) % 1; ip = Math.min(NPH - 1, Math.floor(ph * NPH)); }
          const w1 = W1[ip], w2 = W2[ip];
          for (let u = 0; u < NU; u++) { m1[u] += a1 * w1[u]; m2[u] += 2 * a1 * w1[u] - a2 * w2[u]; }
        }
        for (let u = 0; u < NU; u++) { F1[u] *= 1 - p * m1[u]; F2[u] *= 1 - p * m2[u]; }
      }
      for (let u = 0; u < NU; u++) acc += 1 - 2 * F1[u] + F2[u];
    }
  }
  const ms = acc / (NU * NPHI * nth);
  return Math.sqrt(Math.max(0, ms));
}

const CACHE_MAX = 64;
const KEY_PARAMS = ['filter.center', 'filter.width', 'filter.soft', 'filter.level', 'grain.size',
  'grain.density', 'grain.scatter', 'grain.speed', 'grain.dur', 'grain.jitter'];
const cache = new Map();

/**
 * Expected time-averaged RMS over u of the combined grain gain 1 - prod(1 - grain) for the
 * channel's current params. Deterministic and noise-free: an exact expectation over the grain
 * model evaluated by fixed quadrature (see above). `seed` is accepted for symmetry with grainsAt
 * but ignored: the expectation does not depend on which grains a seed happens to pick.
 * Memoised (at most 64 entries, oldest evicted first) on the params it depends on.
 */
export function grainRmsCoverage(ch, seed) { // eslint-disable-line no-unused-vars
  const key = KEY_PARAMS.map(k => ch[k]).join('|');
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const v = estimateGrainRms(ch);
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, v);
  return v;
}

/** Gain that brings a granular channel level with its equivalent window, capped at +20 dB (10). */
export function loudnessMatch(ch, seed) {
  const w = windowRmsCoverage(ch);
  if (!(w > 0)) return 1;
  const g = grainRmsCoverage(ch, seed);
  if (!(g > 0) || !Number.isFinite(g)) return 10;
  return Math.min(10, w / g);
}
