/*
 * MidiClockFollower: makes a Transport follow an external MIDI clock.
 * Pure module: no DOM, no Web MIDI. Messages and times are passed in by the caller
 * (see src/audio/midi-input.js for the browser glue).
 *
 * The follower only sets tempo and start/stop/locate. Between ticks the position follows the
 * transport's own clock; ticks are not counted into the position.
 *
 * Tempo: exponential moving average over inter-tick intervals, 24 ticks per quarter note,
 *   bpm = 60 / (24 * avgInterval).
 * Smoothing constant EMA_ALPHA = 0.1 (time constant ~10 ticks, under half a beat). With +-10%
 * uniform interval jitter the steady-state error of the average is ~1.3% (about 1.6 bpm at
 * 120); a larger alpha tracks tempo changes faster but passes more jitter into the bpm.
 */

export const TICKS_PER_BEAT = 24;
export const EMA_ALPHA = 0.1;
const MIN_PLAUSIBLE_BPM = 20;
const MAX_PLAUSIBLE_BPM = 400;
const APPLY_EVERY_TICKS = 24;
const APPLY_DELTA_BPM = 0.25;
const SIXTEENTHS_PER_BEAT = 4;

const intervalToBpm = (iv) => 60 / (TICKS_PER_BEAT * iv);

export class MidiClockFollower {
  constructor(transport, { lostAfterSec = 1 } = {}) {
    this.transport = transport;
    this.lostAfterSec = lostAfterSec;
    this._lastTickT = null;   // time of the most recent tick ever seen
    this._avg = null;         // EMA of the inter-tick interval, seconds
    this._ticks = 0;          // ticks since the last reset
    this._applied = null;     // bpm last pushed to the transport by this follower
    this._lostStopped = false; // poll() stopped the transport because the clock went silent
  }

  /** Feed one MIDI message (status byte first) received at audio time tSec. */
  handle(bytes, tSec) {
    if (!bytes || typeof bytes.length !== 'number' || bytes.length < 1) return;
    if (typeof tSec !== 'number' || !Number.isFinite(tSec)) return;
    const status = bytes[0];
    switch (status) {
      case 0xf8: this._tick(tSec); break;
      case 0xfa: // start: from the top, tempo estimate rebuilt
        this.transport.source = 'midi';
        this._lostStopped = false;
        this._resetEstimate();
        this.transport.locate(0, tSec);
        this.transport.start(tSec);
        break;
      case 0xfb: // continue: no relocation
        this.transport.source = 'midi';
        this._lostStopped = false;
        this.transport.start(tSec);
        break;
      case 0xfc: // stop; a no-op when already stopped (also covers FC before any FA)
        this._lostStopped = false;
        this.transport.stop(tSec);
        break;
      case 0xf2: { // song position pointer, in MIDI beats (sixteenth notes)
        if (bytes.length < 3) return;
        const lsb = bytes[1];
        const msb = bytes[2];
        if (!(lsb >= 0 && lsb <= 127 && msb >= 0 && msb <= 127)) return;
        this.transport.locate((lsb | (msb << 7)) / SIXTEENTHS_PER_BEAT, tSec);
        break;
      }
      default: break;
    }
  }

  /** 'idle' (no clock, or transport stopped), 'lost' (running but silent too long), 'ok'. */
  poll(tSec) {
    if (this._lostStopped) return 'lost';
    const tr = this.transport;
    if (this._lastTickT === null || !tr.running) return 'idle';
    if (tSec - this._lastTickT > this.lostAfterSec) {
      tr.stop(tSec); // hold position; exactly once per loss
      this._lostStopped = true;
      return 'lost';
    }
    return 'ok';
  }

  _resetEstimate() {
    this._avg = null;
    this._ticks = 0;
    this._applied = null;
    this._lastTickT = null;
  }

  _tick(t) {
    const tr = this.transport;
    tr.source = 'midi';
    const prev = this._lastTickT;
    const resumed = this._lostStopped;
    if (prev === null || t > prev) this._lastTickT = t;
    if (resumed) { // clock is back after a hold: resume, and don't measure across the gap
      this._lostStopped = false;
      tr.start(t);
      return;
    }
    if (prev === null) return;
    const iv = t - prev;
    if (!(iv > 0)) return;
    const bpm = intervalToBpm(iv);
    if (bpm < MIN_PLAUSIBLE_BPM || bpm > MAX_PLAUSIBLE_BPM) return; // outlier: not folded in
    this._avg = this._avg === null ? iv : this._avg + EMA_ALPHA * (iv - this._avg);
    this._ticks++;
    const est = intervalToBpm(this._avg);
    if (this._applied === null || this._ticks % APPLY_EVERY_TICKS === 0
      || Math.abs(est - this._applied) > APPLY_DELTA_BPM) {
      tr.setBpm(est, t);
      this._applied = est;
    }
  }
}
