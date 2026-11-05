/*
 * Score builder: state + analyses + a time map -> timestamped ControlFrames and event specs.
 * The same pure function serves live playback (a driver calls it in short chunks) and offline
 * rendering (one big span). Pure module: no DOM, no Web Audio, no Date/performance/Math.random.
 *
 * Time axes
 *   span time   the time map's nowSec axis (audio-clock seconds live, render seconds offline);
 *               frame and event `t` are span times.
 *   transport   tm.secAt(t): transport-elapsed seconds. Take event times are on this axis.
 *   evaluate    {beat: tm.beatAt(t), sec: tm.secAt(t) - loopOffset}: what LFOs, envelopes and grains see.
 *               Envelope trigger times passed to evaluate are on this sec axis too.
 *
 * Take = {dur:number, bpm:number, events:{t:number, id:string, value:any}[]}   (events sorted by t)
 * EventSpec = {t, f, amp, pan, envRoutes:{a,h,d,amount}[], staticGain}          (see eventRoutes)
 *
 * Event generation (ruling R27): events come from fixed absolute 1-second buckets of span time.
 * Bucket b covers (b, b+1] and owns its own rng, mulberry32(hashSeed(seed, chIndex, b)), so the
 * events of a bucket do not depend on which span asked for them, and any partition of a time range
 * yields each event exactly once. Rng consumption order inside a bucket: evTimes draws first (by its
 * own rules); then, for each nominal time in order, one chance draw (always consumed, also when the
 * event is then dropped because the channel is disabled or the time is before transport zero), then
 * pickEvent's single roulette draw (only when pickEvent gets that far).
 */
import { channelView, NUM_CHANNELS } from './schema.js';
import { evaluate, eventRoutes } from './modulation.js';
import { timeValuePeriodSec } from './transport.js';
import { timelineOverrides } from './timeline.js';
import { evTimes, eventSpec, pickEvent } from '../dsp/events.js';
import { grainsAt } from '../dsp/grains.js';
import { buildFrame } from '../dsp/partials.js';
import { applyShift } from '../spectrum/analyse.js';

export const DEFAULT_SEED = 20261027;
/** Cap on an event's life (and so on the trigger lookback and loop carry-over), in seconds. */
export const MAX_LIFE_SEC = 30;
/** Cap on the jitter spill the bucket lookback accounts for, in seconds. */
export const MAX_SPILL_SEC = 120;

// Envelope life a + h + 8d with the same floors as modulation.js envValue.
const MIN_ATTACK = 0.002, MIN_DECAY = 0.02, ENV_LIFE_DECAYS = 8;
const DEFAULT_ENV = { a: 0.03, h: 0, d: 1.2 };

const finite = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const byT = (a, b) => a.t - b.t; // Array.prototype.sort is stable: equal t keep generation order

// ---- rng -------------------------------------------------------------------------------------

/** Prototype PRNG (index.html), returns floats in [0, 1). */
export const mulberry32 = a => () => {
  a |= 0; a = a + 0x6D2B79F5 | 0;
  let t = Math.imul(a ^ a >>> 15, 1 | a);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
};

/** Deterministic unsigned 32-bit mix of three integers (seed, channel index, bucket index). */
export function hashSeed(seed, ch, b) {
  let h = Math.imul((seed | 0) ^ 0x9E3779B9, 0x85EBCA6B);
  h ^= h >>> 13;
  h = Math.imul(h ^ (ch | 0), 0xC2B2AE35);
  h ^= h >>> 16;
  h = Math.imul(h ^ (b | 0), 0x27D4EB2F);
  h ^= h >>> 15;
  h = Math.imul(h, 0x165667B1);
  h ^= h >>> 13;
  return h >>> 0;
}

// ---- takes -----------------------------------------------------------------------------------

/** Append a change to a take, keeping events sorted by t (stable: equal t go after existing ones). */
export function recordChange(take, t, id, value) {
  const ev = take.events;
  let i = ev.length;
  while (i > 0 && ev[i - 1].t > t) i--;
  ev.splice(i, 0, { t, id, value });
}

/**
 * Shallow copy of `base` where every id with a take event at or before t has the value of the last
 * such event. Precondition: take.events sorted by t (recordChange keeps them so).
 */
export function paramsAt(take, base, t) {
  const out = { ...base };
  for (const e of take.events) {
    if (e.t > t) break;
    out[e.id] = e.value;
  }
  return out;
}

// ---- parameter resolution --------------------------------------------------------------------

/**
 * Effective value of every param at span time t.
 * opts = {tm, triggers?, cc?, take?, loopSec?, loopOffset?, timelineHold?}; triggers are on the evaluate sec axis.
 * Order: base params, take overlay, timeline overrides (replace the channel's window params), then
 * evaluate (matrix routes add on top). timelineHold = per-channel phase (or null) freezing a timeline.
 */
export function resolveAt(project, t, opts) {
  const { tm } = opts;
  const base = project.state.params;
  let values = opts.take ? paramsAt(opts.take, base, tm.secAt(t)) : base;
  const time = { beat: tm.beatAt(t), sec: tm.secAt(t) - (opts.loopOffset || 0) };
  const timelines = project.state.timelines || [];
  let copied = values !== base; // paramsAt already returned a fresh copy
  for (let c = 0; c < NUM_CHANNELS; c++) {
    const tl = timelines[c];
    if (!tl || !Array.isArray(tl.events) || !tl.events.length) continue;
    const hold = opts.timelineHold ? opts.timelineHold[c] : undefined;
    const over = timelineOverrides(tl, time, tm.bpm, { loopSec: opts.loopSec, hold });
    if (!over) continue;
    if (!copied) { values = { ...values }; copied = true; }
    for (const [key, v] of Object.entries(over)) values[`ch${c + 1}.${key}`] = v;
  }
  return evaluate({ ...project.state, params: values }, time,
    { bpm: tm.bpm, triggers: opts.triggers || {}, cc: opts.cc, loopSec: opts.loopSec });
}

function shiftedAnalysis(project, c, values) {
  const a = project.analyses && project.analyses[c];
  if (!a) return null;
  return project.stage ? applyShift(a, values[`ch${c + 1}.source.shift`], project.stage) : a;
}

// ---- lives -----------------------------------------------------------------------------------

function envLife(env) {
  const a = Math.max(MIN_ATTACK, finite(env && env.a, MIN_ATTACK));
  const h = Math.max(0, finite(env && env.h, 0));
  const d = Math.max(MIN_DECAY, finite(env && env.d, MIN_DECAY));
  return Math.min(MAX_LIFE_SEC, a + h + ENV_LIFE_DECAYS * d);
}

/**
 * How long an event sounds: the life of its longest envelope route; with no envelope route, the
 * life of its channel's env1 (the default event envelope). Capped at MAX_LIFE_SEC.
 */
function eventLife(e, state, c) {
  if (e.envRoutes.length) return Math.max(...e.envRoutes.map(envLife));
  const mods = state.mods && state.mods[`ch${c + 1}`];
  return envLife((mods && Array.isArray(mods.env) && mods.env[0]) || DEFAULT_ENV);
}

/** Trigger lookback: the longest life of any envelope in the state (and the default), capped. */
function maxLife(state) {
  let m = envLife(DEFAULT_ENV);
  for (let c = 0; c < NUM_CHANNELS; c++) {
    const mods = state.mods && state.mods[`ch${c + 1}`];
    for (const env of (mods && Array.isArray(mods.env) ? mods.env : [])) m = Math.max(m, envLife(env));
  }
  return m;
}

/**
 * Buckets to look back before floor(from) so jitter spill is caught. Regular-mode jitter can push an
 * event up to jitter*period past its bucket. event.mode/jitter/interval are not modulatable, so their
 * values over time are the base value or a take value: the bound covers all of them and does not
 * depend on the query, which keeps partitions exact. Random and pattern events stay in their bucket
 * (up to rounding), so 1 bucket suffices for them.
 */
function lookbackBuckets(project, c, opts) {
  const pre = `ch${c + 1}.event.`;
  const values = key => {
    const vs = [project.state.params[pre + key]];
    if (opts.take) for (const e of opts.take.events) if (e.id === pre + key) vs.push(e.value);
    return vs;
  };
  if (!values('mode').includes('regular')) return 1;
  const jitter = Math.max(...values('jitter').map(v => clamp(finite(v, 1), 0, 1)));
  const period = Math.max(...values('interval').map(v => timeValuePeriodSec(v, opts.tm.bpm)));
  return 1 + Math.ceil(Math.min(MAX_SPILL_SEC, jitter * period));
}

// ---- events ----------------------------------------------------------------------------------

/**
 * Events of one bucket. Bucket times are on the axis of g.tmB; span time = bucket time + g.off.
 * With g.loopSec the nominal times are wrapped into [0, loopSec) first (loop timeline).
 * Returned `t` is the bucket-axis (or wrapped loop) time.
 */
function bucketEvents(g, b, b1) {
  const { project, c, tm, evalOpts, loopSec, off } = g;
  const rng = mulberry32(hashSeed(g.seed, c, b));
  const v0 = resolveAt(project, b + off, evalOpts);
  const times = evTimes(eventSpec(channelView(v0, c), project.state.pattern[c]), b, b1, rng, g.tmB);
  const chance = `ch${c + 1}.event.chance`, seed = 101 * (c + 1), out = [];
  for (let te of times) {
    if (loopSec) te = ((te % loopSec) + loopSec) % loopSec;
    const r = rng(); // chance draw, always consumed
    const ts = te + off;
    if (!loopSec && tm.secAt(ts) < 0) continue; // nothing before transport zero
    const values = resolveAt(project, ts, evalOpts);
    const ch = channelView(values, c);
    if (!ch['filter.on'] || !(r < values[chance])) continue;
    const sec = tm.secAt(ts) - (evalOpts.loopOffset || 0);
    const grains = ch['filter.type'] === 'granular' ? grainsAt(ch, seed, sec, loopSec) : undefined;
    const pe = pickEvent(ch, shiftedAnalysis(project, c, values), rng, grains, { loopSec });
    if (!pe) continue;
    const { envRoutes, staticGain } = eventRoutes(project.state, c, { beat: tm.beatAt(ts), sec },
      { bpm: tm.bpm, cc: evalOpts.cc, loopSec });
    out.push({ t: te, f: pe.f, amp: pe.amp, pan: pe.pan, envRoutes, staticGain });
  }
  return out;
}

/**
 * Events of channel chIndex (0..3) with t in (from, to], sorted by t.
 * opts = {tm, seed?, cc?, take?, loopSec?, loopOffset?, timelineHold?}. Event-time params are evaluated without
 * envelope triggers (an event's own envelope cannot gate it; this also keeps buckets query-independent).
 * None when the transport is stopped, the analysis is null or has no bands, or the channel is
 * disabled at the event time. Non-loop events before transport-elapsed second 0 are not generated.
 *
 * Loop mode (opts.loopSec = L > 0; loopOffset O, default 0): one cycle is generated on the loop
 * timeline lt in (0, L] (buckets 0..ceil(L)-1, the last one cut at L; time map shifted by O; nominal
 * times wrapped modulo L, so jitter spill past L wraps to the cycle start), then replicated: copy
 * O + lt + k*L for every integer k is emitted if it lies in (from, to], and ALSO if it started at or
 * before `from` but still sounds then (copy.t + life > from; life = eventLife, <= 30 s). Such carried
 * copies have t <= from (possibly negative); the engine handles their phase. Because of the carried
 * copies, loop-mode chunks do not tile: loop mode is meant for single-span (offline) rendering.
 */
export function channelEvents(project, chIndex, from, to, opts) {
  const { tm } = opts;
  if (!tm || !tm.running || !(to > from)) return [];
  const a = project.analyses && project.analyses[chIndex];
  if (!a || !Array.isArray(a.bands) || !a.bands.length) return [];
  const seed = opts.seed ?? DEFAULT_SEED;
  const L = opts.loopSec > 0 ? opts.loopSec : 0;
  const evalOpts = { tm, cc: opts.cc, take: opts.take, loopSec: opts.loopSec, loopOffset: opts.loopOffset,
    timelineHold: opts.timelineHold };

  if (!L) {
    const g = { project, c: chIndex, tm, tmB: tm, off: 0, seed, evalOpts, loopSec: 0 };
    const out = [];
    for (let b = Math.floor(from) - lookbackBuckets(project, chIndex, opts); b <= Math.floor(to); b++) {
      for (const e of bucketEvents(g, b, b + 1)) if (e.t > from && e.t <= to) out.push(e);
    }
    return out.sort(byT);
  }

  const O = opts.loopOffset || 0;
  const tmB = { bpm: tm.bpm, running: tm.running, beatAt: x => tm.beatAt(x + O), secAt: x => tm.secAt(x + O) };
  const g = { project, c: chIndex, tm, tmB, off: O, seed, evalOpts, loopSec: L };
  const cycle = [];
  for (let b = 0; b < L; b++) cycle.push(...bucketEvents(g, b, Math.min(b + 1, L)));
  cycle.sort(byT);

  const out = [];
  for (const e of cycle) {
    const life = eventLife(e, project.state, chIndex), base = O + e.t;
    const kLo = Math.ceil((from - life - base) / L) - 1, kHi = Math.floor((to - base) / L) + 1;
    for (let k = kLo; k <= kHi; k++) {
      const t = base + k * L;
      if ((t > from && t <= to) || (t <= from && t + life > from)) {
        out.push({ ...e, t, envRoutes: e.envRoutes.map(r => ({ ...r })) });
      }
    }
  }
  return out.sort(byT);
}

// ---- score -----------------------------------------------------------------------------------

/**
 * Frames and events for all channels over a span.
 * project = {state, analyses: Array(4)<Analysis|null>, stage: {unit, x0, x1}}
 * span = {startSec, endSec, stepSec}: frames at t_i = startSec + i*stepSec, i < ceil((end-start)/step - 1e-9),
 *   so consecutive spans on the step grid never duplicate a frame.
 * opts = {tm, seed = DEFAULT_SEED, loopSec?, loopOffset?, take?, cc?, timelineHold?}; tm is a timeMap made by the caller.
 * Returns ControlFrame[4][]. Each channel's events with t in (startSec, endSec] ride the frame whose
 * interval (t_i, t_i + step] contains them (so a chunk boundary event rides the same frame either way);
 * in loop mode, earlier-started copies still sounding at startSec ride frame 0.
 * Envelope triggers: for every frame, 'chN.env1' and 'chN.env2' of every channel are the times (on the
 * evaluate sec axis) of that channel's events in (t_i - lookback, t_i], lookback = the longest envelope
 * life in the state (<= 30 s). Pure and deterministic; never touches the Transport.
 */
export function buildScore(project, span, opts) {
  const { tm, take, cc, loopSec, loopOffset, timelineHold } = opts;
  const { startSec, endSec, stepSec } = span;
  const O = loopOffset || 0, loop = loopSec > 0;
  const n = Math.max(0, Math.ceil((endSec - startSec) / stepSec - 1e-9));
  const frames = Array.from({ length: NUM_CHANNELS }, () => []);
  if (!n) return frames;

  const lookback = maxLife(project.state);
  const evOpts = { tm, seed: opts.seed ?? DEFAULT_SEED, cc, take, loopSec, loopOffset, timelineHold };
  const events = [], trig = [];
  for (let c = 0; c < NUM_CHANNELS; c++) {
    events.push(channelEvents(project, c, startSec - lookback, endSec, evOpts));
    trig.push(events[c].map(e => tm.secAt(e.t) - O));
  }

  const lo = new Array(NUM_CHANNELS).fill(0), hi = new Array(NUM_CHANNELS).fill(0);
  for (let i = 0; i < n; i++) {
    const t = startSec + i * stepSec, triggers = {};
    for (let c = 0; c < NUM_CHANNELS; c++) {
      const ev = events[c];
      while (hi[c] < ev.length && ev[hi[c]].t <= t) hi[c]++;
      while (lo[c] < hi[c] && ev[lo[c]].t <= t - lookback) lo[c]++;
      const times = trig[c].slice(lo[c], hi[c]);
      triggers[`ch${c + 1}.env1`] = times;
      triggers[`ch${c + 1}.env2`] = times;
    }
    const values = resolveAt(project, t, { tm, triggers, cc, take, loopSec, loopOffset, timelineHold });
    const sec = tm.secAt(t) - O;
    for (let c = 0; c < NUM_CHANNELS; c++) {
      frames[c].push(buildFrame(channelView(values, c), shiftedAnalysis(project, c, values),
        { t, sec, loopSec, seed: 101 * (c + 1) }));
    }
  }

  for (let c = 0; c < NUM_CHANNELS; c++) {
    for (const e of events[c]) {
      let idx;
      if (e.t > startSec && e.t <= endSec) idx = clamp(Math.ceil((e.t - startSec) / stepSec) - 1, 0, n - 1);
      else if (loop && e.t <= startSec && e.t + eventLife(e, project.state, c) > startSec) idx = 0;
      else continue;
      frames[c][idx].events.push(e);
    }
  }
  return frames;
}
