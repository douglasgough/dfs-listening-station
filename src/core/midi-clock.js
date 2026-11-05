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
 * Smoothing: alpha = max(EMA_ALPHA, 1/n) where n counts intervals folded in since the last reset,
 * i.e. a plain running mean while the estimate is young (fast, exact lock-on), then an EMA with
 * EMA_ALPHA = 0.05 (time constant ~20 ticks, under one beat). Why 0.05 and not 0.1: independent
 * +-10% interval noise gives a steady-state error std of ~1.6 bpm at 0.1 (a fixed-seed +-2 bpm
 * check passes or fails by luck of the seed), ~1.1 bpm at 0.05. Real clock jitter is mostly
 * timestamp noise, which the EMA suppresses far better (over 2000 seeds the worst error after
 * 240 ticks was 1.8 bpm at 0.1 and 0.8 bpm at 0.05).
 */

export const TICKS_PER_BEAT = 24;
export const EMA_ALPHA = 0.05;
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
    this._ticks = 0;          // intervals folded into the estimate since the last reset
    this._applied = null;     // bpm last pushed to the transport by this follower
    this._engaged = false;    // heard clock/start/continue at least once since construction
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
        this._engaged = true;
        this._lostStopped = false;
        this._resetEstimate();
        this.transport.locate(0, tSec);
        this.transport.start(tSec);
        break;
      case 0xfb: // continue: no relocation
        this.transport.source = 'midi';
        this._engaged = true;
        this._lostStopped = false;
        this.transport.start(tSec);
        break;
      case 0xfc: // stop; ignored until engaged so a silent device cannot stop an internal transport
        if (!this._engaged) return;
        this._lostStopped = false;
        this.transport.stop(tSec);
        break;
      case 0xf2: { // song position pointer, in MIDI beats (sixteenth notes)
        if (!this._engaged || bytes.length < 3) return; // same gate as stop
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
    const tr = this.transport;
    if (this._lostStopped) {
      if (!tr.running) return 'lost';
      // The user took over (pressed Play) during the hold: drop the auto-resume and wait for a
      // fresh tick before judging the clock again, so a dead clock cannot re-stop their Play.
      this._lostStopped = false;
      this._lastTickT = null;
    }
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
    this._engaged = true;
    const prev = this._lastTickT;
    if (prev === null || t > prev) this._lastTickT = t;
    if (this._lostStopped) { // clock is back after a hold: don't measure across the gap
      this._lostStopped = false;
      if (!tr.running) tr.start(t); // already running means the user took over; leave it
      return;
    }
    if (prev === null) return;
    const iv = t - prev;
    if (!(iv > 0)) return;
    const bpm = intervalToBpm(iv);
    if (bpm < MIN_PLAUSIBLE_BPM || bpm > MAX_PLAUSIBLE_BPM) return; // outlier: not folded in
    this._ticks++;
    this._avg = this._avg === null ? iv
      : this._avg + Math.max(EMA_ALPHA, 1 / this._ticks) * (iv - this._avg);
    const est = intervalToBpm(this._avg);
    if (this._applied === null || this._ticks % APPLY_EVERY_TICKS === 0
      || Math.abs(est - this._applied) > APPLY_DELTA_BPM) {
      tr.setBpm(est, t);
      this._applied = est;
    }
  }
}
