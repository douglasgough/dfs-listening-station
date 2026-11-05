/*
 * Event scheduling (nominal event times) and event selection (which band sounds, at what pitch).
 * Pure module: no DOM, no Web Audio.
 */
import { DIVISIONS, timeValuePeriodSec } from '../core/transport.js';
import { channelGain } from './window.js';
import { mapFreq, snapFreq, channelMapping } from './mapping.js';

export const PING = 0.33;

const cleanBpm = b => (typeof b === 'number' && Number.isFinite(b) && b > 0 ? b : 120);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Event timing view of a ResolvedChannel; pattern is that channel's boolean step row. */
export function eventSpec(ch, pattern) {
  return {
    mode: ch['event.mode'], rpm: ch['event.rpm'], interval: ch['event.interval'], jitter: ch['event.jitter'],
    steps: ch['event.steps'], stepLen: ch['event.stepLen'], pattern,
  };
}

// Beat-domain grid applies to beats-mode periods with a known division; everything else is seconds.
const beatPeriod = tv => (tv && tv.mode === 'beats' && Object.hasOwn(DIVISIONS, tv.div) ? DIVISIONS[tv.div] : null);

/**
 * Nominal event times in seconds, in (t0, t1].
 * tm = {bpm, beatAt(sec)} is the time map; beats-mode periods are gridded in beats (so they follow tempo
 * and transport position), hz/sec periods and random mode in seconds.
 */
export function evTimes(ev, t0, t1, rnd, tm) {
  const out = [];
  const bpm = tm && tm.bpm;
  if (ev.mode === 'random') {
    const rate = ev.rpm / 60;
    for (let a = t0; a < t1; a += 0.1) { const b = Math.min(t1, a + 0.1); if (rnd() < rate * (b - a)) out.push(a + rnd() * (b - a)); }
    return out;
  }
  const regular = ev.mode === 'regular';
  const tv = regular ? ev.interval : ev.stepLen;
  // Grid index k (event at k periods) belongs to the span with kLo <= k <= kHi, where both bounds use the
  // same expression, so consecutive spans (t1 of one == t0 of the next) tile exactly: no index is dropped
  // or emitted twice. Jitter is added after the index is chosen, so an event may land after t1; it is emitted
  // by the span that owns its grid index.
  const indices = (x0, x1, P) => {
    const lo = Math.floor(x0 / P + 1e-9) + 1, hi = Math.floor(x1 / P + 1e-9), ks = [];
    for (let k = lo; k <= hi; k++) ks.push(k);
    return ks;
  };
  const D = beatPeriod(tv);
  if (D !== null && tm && typeof tm.beatAt === 'function') {
    const b0 = tm.beatAt(t0), b1 = tm.beatAt(t1), secPerBeat = 60 / cleanBpm(bpm), toSec = beat => t0 + (beat - b0) * secPerBeat;
    for (const k of indices(b0, b1, D)) {
      if (regular) out.push(toSec(k * D + rnd() * ev.jitter * D));
      else if (ev.pattern[k % ev.steps]) out.push(toSec(k * D));
    }
    return out;
  }
  const I = timeValuePeriodSec(tv, bpm);
  for (const k of indices(t0, t1, I)) {
    if (regular) out.push(k * I + rnd() * ev.jitter * I);
    else if (ev.pattern[k % ev.steps]) out.push(k * I);
  }
  return out;
}

/**
 * Choose one band under the channel's filter (weighted by gain and band strength) and give its voice.
 * @returns {f, amp, pan, bandIndex} or null when nothing sits under the filter or there are no bands.
 */
export function pickEvent(ch, analysis, rnd, grains, opts = {}) {
  if (!analysis || !analysis.bands || !analysis.bands.length) return null;
  let tot = 0; const ws = [];
  analysis.bands.forEach((b, bi) => {
    const rel = 0.12 + 0.88 * b.rel;
    const x = channelGain(b.u, ch, analysis, grains) * rel;
    if (x > 0) { ws.push([bi, x]); tot += x; }
  });
  if (tot < 0.03) return null;
  let r = rnd() * tot, j = 0;
  while (j < ws.length - 1 && r > ws[j][1]) { r -= ws[j][1]; j++; }
  const bi = ws[j][0], b = analysis.bands[bi], map = channelMapping(ch);
  let f = snapFreq(mapFreq(b.u, map), map) * Math.pow(2, ch['event.octave']);
  while (f > 4200) f /= 2;
  while (f < 40) f *= 2;
  if (opts.loopSec) { const L = opts.loopSec; f = Math.round(f * L) / L; }
  return {
    f,
    amp: PING * ch['event.level'] * Math.sqrt(0.12 + 0.88 * b.rel) * channelGain(b.u, ch, analysis, grains),
    pan: clamp(((map.flip ? 1 - b.u : b.u) - 0.5) * 1.2, -0.8, 0.8),
    bandIndex: bi,
  };
}
