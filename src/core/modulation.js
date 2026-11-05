/*
 * Modulation evaluator: LFOs, envelopes, the routing matrix and the voice-rate
 * event.level gain. Pure module: no DOM, no Web Audio.
 *
 * Sources: 'g.lfo<n>', 'g.cc<n>', 'ch<N>.lfo<n>', 'ch<N>.env<n>' (n is 1-based).
 * Bipolar sources (LFO) add v*amount*(max-min)*0.5; unipolar sources (envelope,
 * CC) add v*amount*(max-min). Routes with an unknown source, an unknown or
 * non-modulatable destination, or a source that does not exist are skipped,
 * never thrown on.
 */

import { allParamIds, paramDef, NUM_CHANNELS } from './schema.js';
import { timeValuePeriodSec, timeValueCycles } from './transport.js';

export const LFO_SHAPES = ['sine', 'tri', 'ramp', 'square', 'steps', 'drift'];

const MIN_ATTACK = 0.002;
const MIN_DECAY = 0.02;
const ENV_LIFE_DECAYS = 8;

const finite = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---- LFO (ported from the prototype's hash01 / lfoVal) --------------------------------------

function hash01(n) {
  n = Math.imul(n ^ 0x9E3779B9, 0x85EBCA6B);
  n ^= n >>> 13;
  n = Math.imul(n, 0xC2B2AE35);
  n ^= n >>> 16;
  return ((n >>> 0) / 4294967296) * 2 - 1;
}

/**
 * LFO value in [-1, 1]. With loopSec the cycle count per loop is rounded to a whole
 * number N and the phase is scaled so exactly N cycles fit, so the value repeats
 * every loopSec seconds.
 */
export function lfoValue(lfo, t, bpm, loopSec) {
  const shape = LFO_SHAPES.includes(lfo && lfo.shape) ? lfo.shape : 'sine';
  const phase = finite(lfo && lfo.phase, 0);
  const seed = finite(lfo && lfo.seed, 0);
  const tt = { beat: finite(t && t.beat, 0), sec: finite(t && t.sec, 0) };
  const rate = lfo && lfo.rate;

  let cycles = timeValueCycles(rate, tt);
  let N = 0;
  if (typeof loopSec === 'number' && Number.isFinite(loopSec) && loopSec > 0) {
    const cyclesPerLoop = loopSec / timeValuePeriodSec(rate, bpm);
    N = Math.max(1, Math.round(cyclesPerLoop));
    cycles *= N / cyclesPerLoop;
  }
  const x = cycles + phase;
  if (!Number.isFinite(x)) return 0;

  const n = Math.floor(x), f = x - n;
  const ix = j => (N ? ((j % N) + N) % N : j) + seed;
  let v;
  switch (shape) {
    case 'tri': v = f < 0.25 ? 4 * f : f < 0.75 ? 2 - 4 * f : 4 * f - 4; break;
    case 'ramp': v = f < 0.5 ? 2 * f : 2 * f - 2; break;
    case 'square': v = f < 0.5 ? 1 : -1; break;
    case 'steps': v = hash01(ix(n)); break;
    case 'drift': {
      const s = f * f * (3 - 2 * f);
      v = hash01(ix(n)) * (1 - s) + hash01(ix(n + 1)) * s;
      break;
    }
    default: v = Math.sin(6.283185307 * f);
  }
  return Number.isFinite(v) ? v : 0;
}

// ---- envelope --------------------------------------------------------------------------------

/**
 * Envelope value in [0, 1]: linear attack, hold, then exponential decay. Only the
 * newest trigger at or before `sec` counts. Zero before the first trigger and
 * after the envelope's life (a + h + 8d).
 */
export function envValue(env, triggersSec, sec) {
  if (!Array.isArray(triggersSec) || !Number.isFinite(sec)) return 0;
  let trig = -Infinity;
  for (const tr of triggersSec) if (Number.isFinite(tr) && tr <= sec && tr > trig) trig = tr;
  if (trig === -Infinity) return 0;

  const a = Math.max(MIN_ATTACK, finite(env && env.a, MIN_ATTACK));
  const h = Math.max(0, finite(env && env.h, 0));
  const d = Math.max(MIN_DECAY, finite(env && env.d, MIN_DECAY));
  const x = sec - trig;
  if (x > a + h + ENV_LIFE_DECAYS * d) return 0;
  const v = x < a ? x / a : x < a + h ? 1 : Math.exp(-(x - a - h) / d);
  return Number.isFinite(v) ? clamp(v, 0, 1) : 0;
}

// ---- routing ---------------------------------------------------------------------------------

const SRC_RE = /^(?:(g)\.(lfo|cc)(\d+)|(ch[1-4])\.(lfo|env)(\d+))$/;

/** Resolves a source id to {kind:'lfo'|'env'|'cc', ...} or null when unknown or nonexistent. */
function resolveSource(state, src) {
  const m = typeof src === 'string' ? SRC_RE.exec(src) : null;
  if (!m) return null;
  const owner = m[1] || m[4], kind = m[2] || m[5], n = Number(m[3] || m[6]);
  if (kind === 'cc') return n >= 0 ? { kind, src } : null;
  const mods = state.mods && state.mods[owner];
  const list = mods && mods[kind];
  const item = Array.isArray(list) && n >= 1 ? list[n - 1] : undefined;
  return item && typeof item === 'object' ? { kind, src, item } : null;
}

function sourceValue(state, rs, t, opts) {
  if (rs.kind === 'lfo') return lfoValue(rs.item, t, opts.bpm, opts.loopSec);
  if (rs.kind === 'env') return envValue(rs.item, (opts.triggers && opts.triggers[rs.src]) || [], t.sec);
  return finite(opts.cc && opts.cc[rs.src], 0);
}

const isRoute = r => r !== null && typeof r === 'object' && Number.isFinite(r.amount);

/**
 * Effective value of every parameter at transport position t. Numeric params are
 * base + routed modulation, clamped; all other types pass through unchanged.
 * opts = {bpm, triggers: Record<sourceId, number[]>, cc?: Record<'g.cc<n>', number>, loopSec?}
 */
export function evaluate(state, t, opts = {}) {
  const out = {};
  for (const id of allParamIds()) out[id] = state.params[id];

  const add = {};
  const cache = new Map();
  for (const r of Array.isArray(state.matrix) ? state.matrix : []) {
    if (!isRoute(r)) continue;
    const def = typeof r.dst === 'string' ? paramDef(r.dst) : undefined;
    if (!def || def.type !== 'num' || !def.modulatable || def.voiceRate) continue;
    const rs = resolveSource(state, r.src);
    if (!rs) continue;
    let v = cache.get(r.src);
    if (v === undefined) { v = sourceValue(state, rs, t, opts); cache.set(r.src, v); }
    if (!Number.isFinite(v)) continue;
    const range = def.max - def.min;
    add[r.dst] = (add[r.dst] || 0) + (rs.kind === 'lfo' ? v * r.amount * range * 0.5 : v * r.amount * range);
  }

  for (const id of allParamIds()) {
    const def = paramDef(id);
    if (def.type !== 'num') continue;
    const base = finite(state.params[id], def.default);
    out[id] = clamp(base + (add[id] || 0), def.min, def.max);
  }
  return out;
}

// ---- voice-rate destination: event.level -----------------------------------------------------

/**
 * Splits the routes into event.level for channel `ch` (0..3) into envelope routes
 * (evaluated per event by age) and a static gain from LFO / CC routes at time t.
 */
export function eventRoutes(state, ch, t, opts = {}) {
  const dst = `ch${ch + 1}.event.level`;
  const envRoutes = [];
  let staticGain = 1;
  if (!(ch >= 0 && ch < NUM_CHANNELS)) return { envRoutes, staticGain };
  for (const r of Array.isArray(state.matrix) ? state.matrix : []) {
    if (!isRoute(r) || r.dst !== dst) continue;
    const rs = resolveSource(state, r.src);
    if (!rs) continue;
    if (rs.kind === 'env') {
      envRoutes.push({ a: rs.item.a, h: rs.item.h, d: rs.item.d, amount: r.amount });
      continue;
    }
    const v = sourceValue(state, rs, t, opts);
    if (!Number.isFinite(v)) continue;
    staticGain *= Math.max(0, 1 + r.amount * (rs.kind === 'lfo' ? v : v - 1));
  }
  return { envRoutes, staticGain };
}

/**
 * Gain multiplier for one event of channel `ch` that started ageSec ago. Each
 * event is independent because only its own age is used. With no envelope route
 * this is just the static gain. LFO / CC routes are read at opts.t (default 0).
 */
export function voiceGain(state, ch, ageSec, opts = {}) {
  const t = opts.t || { beat: 0, sec: 0 };
  const { envRoutes, staticGain } = eventRoutes(state, ch, t, opts);
  let g = staticGain;
  for (const e of envRoutes) g *= Math.max(0, 1 + e.amount * (envValue(e, [0], ageSec) - 1));
  return g;
}
