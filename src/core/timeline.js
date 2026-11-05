/*
 * Timeline: keyframes for a channel's window (filter / grain / vertical window), driven by the transport.
 * Pure module: no DOM, no Web Audio.
 *
 * Timeline = {len: TimeValue, mode: 'morph'|'jump', events: {t, c?, w?, s?, l?, z?, d?, x?, y?, h?, q?}[]}
 * `t` is a PHASE in [0, 1) of the timeline length. The value keys map to channel params (TL_KEYS).
 * The evaluator returns the values that REPLACE the channel's base params; matrix routes add on top
 * (the caller applies them before `evaluate`).
 */
import { timeValueCycles, timeValuePeriodSec } from './transport.js';

/** Ordered [event key, channel param key] pairs. */
export const TL_KEYS = Object.freeze([
  ['c', 'filter.center'], ['w', 'filter.width'], ['s', 'filter.soft'], ['l', 'filter.level'],
  ['z', 'grain.size'], ['d', 'grain.density'], ['x', 'grain.scatter'],
  ['y', 'vwin.center'], ['h', 'vwin.height'], ['q', 'vwin.soft'],
].map(Object.freeze));

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const frac = x => ((x % 1) + 1) % 1;

/**
 * Param-key -> value overrides of `timeline` at transport position t={beat, sec}, or null when the
 * timeline has no usable events (no override).
 * opts.loopSec = L > 0: the timeline repeats a whole number N = max(1, round(L / period)) of times per
 *   loop (the length is stretched to fit). opts.hold: a finite phase freezes the playhead there
 *   (live editing); null/undefined plays normally.
 * Events are sorted on a copy; events with non-finite `t` are ignored. A key that is missing or
 * non-finite in an event is skipped: in jump mode in the active event, in morph mode in either
 * interpolation endpoint; the result then omits that param and the base value stays.
 */
export function timelineOverrides(timeline, t, bpm, opts = {}) {
  const raw = timeline && Array.isArray(timeline.events) ? timeline.events : [];
  const ev = raw.filter(e => e && isNum(e.t)).sort((a, b) => a.t - b.t);
  const n = ev.length;
  if (!n) return null;

  let phase;
  if (opts && isNum(opts.hold)) phase = frac(opts.hold);
  else {
    const cycles = timeValueCycles(timeline.len, t);
    const L = opts && opts.loopSec;
    if (isNum(L) && L > 0) {
      const cyclesPerLoop = L / timeValuePeriodSec(timeline.len, bpm);
      phase = frac((Math.max(1, Math.round(cyclesPerLoop)) / cyclesPerLoop) * cycles);
    } else phase = frac(cycles);
  }

  const out = {};
  if (n === 1) {
    for (const [k, key] of TL_KEYS) if (isNum(ev[0][k])) out[key] = ev[0][k];
    return out;
  }

  let i = -1;
  for (let k = 0; k < n; k++) { if (ev[k].t <= phase) i = k; else break; }
  const a = ev[i < 0 ? n - 1 : i], ti = i < 0 ? a.t - 1 : a.t;
  if (timeline.mode === 'jump') {
    for (const [k, key] of TL_KEYS) if (isNum(a[k])) out[key] = a[k];
    return out;
  }
  const j = (i + 1) % n, b = ev[j], tj = b.t + (i >= 0 && j <= i ? 1 : 0);
  const f = tj > ti ? Math.min(1, Math.max(0, (phase - ti) / (tj - ti))) : 0;
  for (const [k, key] of TL_KEYS) if (isNum(a[k]) && isNum(b[k])) out[key] = a[k] + (b[k] - a[k]) * f;
  return out;
}
