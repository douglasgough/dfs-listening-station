/*
 * Timeline editor geometry: pure helpers (no DOM). Phase runs left to right in [0, 1); a value v in [0,1]
 * runs bottom to top. rect comes from tlRect().
 */
import { DIVISIONS, timeValuePeriodSec } from '../core/transport.js';
import { timelineOverrides, TL_KEYS } from '../core/timeline.js';
import { niceStep } from './stage-geom.js';
import { fmtX } from './controls.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const isNum = v => typeof v === 'number' && Number.isFinite(v);
export const MAX_PHASE = 0.9999;

export function tlRect(w, h) { return { l: 14, r: w - 14, t: 24, b: h - 12, w: w - 28, h: h - 36 }; }
export const phaseToX = (phase, rect) => rect.l + phase * rect.w;
export const xToPhase = (x, rect) => clamp((x - rect.l) / (rect.w || 1), 0, MAX_PHASE);
export const valueToY = (v, rect) => rect.b - v * rect.h;
export const yToValue = (y, rect) => clamp((rect.b - y) / (rect.h || 1), 0, 1);

/** Index of the event node nearest to (x, y) within tolPx (Euclidean), else -1. Events without a centre have no node. */
export function hitEvent(events, x, y, rect, tolPx = 12) {
  let best = -1, bd = Infinity;
  (events || []).forEach((e, i) => {
    if (!e || !isNum(e.t) || !isNum(e.c)) return;
    const d = Math.hypot(phaseToX(e.t, rect) - x, valueToY(e.c, rect) - y);
    if (d <= tolPx && d < bd) { bd = d; best = i; }
  });
  return best;
}

/** Ruler ticks [{phase, label}] for a timeline length: beats/bars for synced lengths, seconds otherwise. */
export function rulerTicks(len, bpm, rect) {
  void rect;
  const beats = len && len.mode === 'beats' && Object.hasOwn(DIVISIONS, len.div) ? DIVISIONS[len.div] : null;
  if (beats !== null && beats >= 2) {
    const unit = beats >= 8 ? 4 : 1, n = beats / unit;
    let step = 1;
    while (n / step > 8) step *= 2;
    const out = [];
    for (let k = 0; k * step < n - 1e-9; k++) out.push({ phase: +((k * step * unit) / beats).toPrecision(12), label: String(k * step + 1) });
    return out;
  }
  if (beats !== null) return [0, 1, 2, 3].map(k => ({ phase: k / 4, label: k === 0 ? '0' : fmtX(+(k * beats / 4).toPrecision(6)) }));
  const P = timeValuePeriodSec(len, bpm);
  const step = niceStep(P / 6);
  const out = [];
  for (let k = 0; k * step < P - step * 1e-9 && out.length < 40; k++) {
    const s = +(k * step).toPrecision(12);
    out.push({ phase: +(s / P).toPrecision(12), label: k === 0 ? '0' : fmtX(s) + ' s' });
  }
  return out;
}

/**
 * A full event at `phase` with centre `centre`. With existing events the other values are the timeline's
 * resolved values at that phase; keys they lack (and the no-events case) come from fallbackValues (keyed by TL key).
 */
export function newEventFrom(timeline, phase, centre, fallbackValues = {}) {
  const ov = timelineOverrides(timeline, { beat: 0, sec: 0 }, 120, { hold: phase }) || {};
  const e = { t: phase };
  for (const [k, key] of TL_KEYS) {
    const v = ov[key] !== undefined ? ov[key] : fallbackValues[k];
    if (isNum(v)) e[k] = v;
  }
  e.c = centre;
  return e;
}

/** Move events[index] to (phase, centre); returns a new sorted array and the moved event's new index. */
export function moveEvent(events, index, phase, centre) {
  const moved = { ...events[index], t: clamp(phase, 0, MAX_PHASE), c: clamp(centre, 0, 1) };
  const rest = events.filter((_, i) => i !== index);
  let at = rest.findIndex(e => e.t > moved.t);
  if (at < 0) at = rest.length;
  rest.splice(at, 0, moved);
  return { events: rest, index: at };
}

export const removeEvent = (events, index) => events.filter((_, i) => i !== index);

/** Phase after an arrow key: 0.01 per press, 0.05 with shift, clamped to [0, 0.9999]. */
export function nudge(phase, key, shift) {
  const d = (shift ? 0.05 : 0.01) * (key === 'ArrowRight' ? 1 : key === 'ArrowLeft' ? -1 : 0);
  return clamp(+(phase + d).toFixed(6), 0, MAX_PHASE);
}
