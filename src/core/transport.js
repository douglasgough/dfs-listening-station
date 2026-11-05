/*
 * Transport: the one clock everything derives from.
 * Pure module: no DOM, no Web Audio, no performance/Date. Time is always passed in
 * as `nowSec` (audio-context time live, virtual time offline).
 *
 * TimeValue = {mode:'beats', div: key of DIVISIONS} | {mode:'hz'|'sec', value: number}
 */

export const MIN_BPM = 20;
export const MAX_BPM = 300;
export const DEFAULT_BPM = 120;
export const FALLBACK_PERIOD_SEC = 10;

const BASE = {
  '1/32': 0.125, '1/16': 0.25, '1/8': 0.5, '1/4': 1, '1/2': 2,
  '1 bar': 4, '2 bars': 8, '4 bars': 16, '8 bars': 32, '16 bars': 64,
};

/** Beats per cycle. Dotted ('<x>d', x1.5) and triplet ('<x>t', x2/3) for 1/16..1/2. */
export const DIVISIONS = (() => {
  const d = { ...BASE };
  for (const x of ['1/16', '1/8', '1/4', '1/2']) {
    d[x + 'd'] = BASE[x] * 1.5;
    d[x + 't'] = BASE[x] * 2 / 3;
  }
  return Object.freeze(d);
})();

const isPosFinite = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const cleanBpm = (b) => (isPosFinite(b) ? b : DEFAULT_BPM);
// Any number (incl. +-Infinity) clamps to [MIN_BPM, MAX_BPM]; NaN / non-number falls back to 120.
const clampBpm = (b) => (typeof b === 'number' && !Number.isNaN(b)
  ? Math.min(MAX_BPM, Math.max(MIN_BPM, b))
  : DEFAULT_BPM);

/** Beats per cycle for a beats-mode value, or null if unknown. */
function beatsPerCycle(tv) {
  return tv && Object.hasOwn(DIVISIONS, tv.div) ? DIVISIONS[tv.div] : null;
}

/** Free-mode period in seconds, or null if not a valid free value. */
function freePeriodSec(tv) {
  if (!tv || !isPosFinite(tv.value)) return null;
  if (tv.mode === 'hz') return 1 / tv.value;
  if (tv.mode === 'sec') return tv.value;
  return null;
}

/** Period of one cycle in seconds. Invalid input yields the 10 s fallback; bad bpm is 120. */
export function timeValuePeriodSec(tv, bpm) {
  if (tv && tv.mode === 'beats') {
    const beats = beatsPerCycle(tv);
    return beats === null ? FALLBACK_PERIOD_SEC : beats * 60 / cleanBpm(bpm);
  }
  const p = freePeriodSec(tv);
  return p === null ? FALLBACK_PERIOD_SEC : p;
}

/** Cycles elapsed at transport position t={beat,sec}; phase is the fractional part. */
export function timeValueCycles(tv, t) {
  if (tv && tv.mode === 'beats') {
    const beats = beatsPerCycle(tv);
    return beats === null ? t.sec / FALLBACK_PERIOD_SEC : t.beat / beats;
  }
  if (tv && tv.mode === 'hz' && isPosFinite(tv.value)) return t.sec * tv.value;
  const p = freePeriodSec(tv);
  return t.sec / (p === null ? FALLBACK_PERIOD_SEC : p);
}

export class Transport {
  constructor({ bpm = DEFAULT_BPM } = {}) {
    this.bpm = clampBpm(bpm);
    this.running = false;
    this.source = 'internal';
    this._beat = 0;       // position at anchor time _t
    this._sec = 0;        // transport-elapsed seconds at anchor time _t
    this._t = 0;          // anchor time
    this._lastNow = 0;    // latest time seen by any call
  }

  // Time never runs backwards: a non-finite or earlier nowSec is treated as the latest time seen,
  // so queries hold at that value and no span is ever billed twice.
  _seen(nowSec) {
    if (Number.isFinite(nowSec) && nowSec > this._lastNow) this._lastNow = nowSec;
    return this._lastNow;
  }

  /** Fold elapsed time since the anchor into the stored position (running only). */
  _advance(now) {
    if (now <= this._t) return;
    if (this.running) {
      const dt = now - this._t;
      this._beat += dt * this.bpm / 60;
      this._sec += dt;
    }
    this._t = now;
  }

  start(nowSec) {
    const now = this._seen(nowSec);
    if (this.running) return;
    this._t = now;
    this.running = true;
  }

  stop(nowSec) {
    const now = this._seen(nowSec);
    if (!this.running) return;
    this._advance(now);
    this.running = false;
  }

  // Without nowSec, the position is folded up to the last observed time at the old tempo;
  // everything after that is billed at the new tempo.
  setBpm(b, nowSec) {
    const now = this._seen(nowSec);
    this._advance(now);
    this.bpm = clampBpm(b);
  }

  locate(beat, nowSec) {
    const now = this._seen(nowSec);
    const b = Number.isFinite(beat) ? beat : 0;
    this._beat = b;
    this._sec = b * 60 / this.bpm;
    this._t = now;
  }

  beatAt(nowSec) {
    const now = this._seen(nowSec);
    return this.running ? this._beat + (now - this._t) * this.bpm / 60 : this._beat;
  }

  secondsAt(nowSec) {
    const now = this._seen(nowSec);
    return this.running ? this._sec + (now - this._t) : this._sec;
  }

  snapshot() {
    return { bpm: this.bpm };
  }
}

/**
 * A pure linear snapshot of the transport at nowSec (span time: the transport's nowSec axis,
 * audio-clock seconds live, render seconds offline).
 * Returns a frozen {bpm, running, nowSec, beat, sec, beatAt(t), secAt(t)}. beatAt/secAt are pure
 * functions of t, valid for any t (also earlier than nowSec), and unaffected by later calls on the
 * transport. A stopped transport gives constants.
 *
 * Precondition: nowSec must be non-decreasing across calls on the same Transport. With an earlier
 * nowSec, `beat`/`sec` reflect the later latest-seen time (the transport never runs backwards) while
 * `beatAt`/`secAt` anchor at nowSec, so the map is shifted. A non-finite nowSec is treated as the
 * transport's latest-seen time (the map's nowSec is then that time), so beatAt/secAt stay finite.
 */
export function timeMap(transport, nowSec) {
  const bpm = transport.bpm, running = transport.running;
  const beat = transport.beatAt(nowSec), sec = transport.secondsAt(nowSec);
  const anchor = Number.isFinite(nowSec) ? nowSec : transport._lastNow;
  return Object.freeze({
    bpm, running, nowSec: anchor, beat, sec,
    beatAt: (t) => (running ? beat + (t - anchor) * bpm / 60 : beat),
    secAt: (t) => (running ? sec + (t - anchor) : sec),
  });
}
