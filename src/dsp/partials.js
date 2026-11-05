/*
 * Partial tables: one ControlFrame per channel per control tick.
 * Port of the prototype audio-graph update() (index.html lines 894-942), producing arrays for the
 * per-channel synth engine instead of setting Web Audio nodes.
 * Pure module: no DOM, no Web Audio.
 *
 * ControlFrame = {
 *   t,                                  frame timestamp (span time)
 *   balance, match,
 *   bandF:Float64Array(30), bandA:Float32Array(30)   MAXB bands x 3 sister oscillators [f, f+det, f-1.5det]
 *   bandPan:Float32Array(10)                          per band
 *   combF:Float64Array(64), combA:Float32Array(64)
 *   noiseF:Float64Array(20), noiseA:Float32Array(20)  band-pass centres (not snapped, not quantised)
 *   anchorF:Float64Array(2), anchorA:Float32Array(2)  2*f0 and 4*f0, not windowed
 *   events: EventSpec[]                               empty here; the score builder fills it
 * }
 * Frequencies are Float64Array (ruling R28): with loopSec, quant() gives each partial a whole number
 * of cycles per loop, and float32 storage would undo that for non-dyadic loop lengths (a phase step
 * at the loop seam). Amplitudes and pans are Float32Array.
 * Amplitudes already include the channel's window gain (window, vertical gate or grains).
 *
 * Synth contract: the synth multiplies drone output (bands, comb, noise, anchor) by
 *   match * min(1, 2*(1-balance))
 * and event output by
 *   match * min(1, 2*balance).
 * Fader, strip pan, mute, solo and MASTER live in the Mixer only, never in a frame.
 */
import { channelGain, sampleProfile } from './window.js';
import { mapFreq, snapFreq, channelMapping } from './mapping.js';
import { grainsAt, loudnessMatch } from './grains.js';

export const MAXB = 10;
export const COMB = 64;
export const NK = 20;
export const BAND_AMP = 0.16;
export const COMB_AMP = 0.05;
export const NOISE_AMP = 0.05;
export const ANCHOR_AMP = 0.14;
/*
 * MAXB bands (3 oscillators each), COMB comb partials and NK noise bands give the array lengths above.
 * *_AMP are the per-layer amplitude scales folded into the frame amplitudes.
 */
/** Master output scale, applied by the mixer (exported for it), never by buildFrame. */
export const MASTER = 2.0;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const fin = (x) => (Number.isFinite(x) ? x : 0);

function emptyFrame(t, balance) {
  return {
    t, balance, match: 1,
    bandF: new Float64Array(3 * MAXB), bandA: new Float32Array(3 * MAXB), bandPan: new Float32Array(MAXB),
    combF: new Float64Array(COMB), combA: new Float32Array(COMB),
    noiseF: new Float64Array(NK), noiseA: new Float32Array(NK),
    anchorF: new Float64Array(2), anchorA: new Float32Array(2),
    events: [],
  };
}

/**
 * Control frame of one channel.
 * @param ch ResolvedChannel (short keys, e.g. channelView of evaluated params)
 * @param analysis Analysis or null (no layer chosen): null or a disabled channel gives a silent all-zero frame
 * @param opts {t: frame timestamp (span time), sec?: transport-elapsed seconds for time-dependent
 *   windows (grains), default t, loopSec?: loop length (frequencies quantised to whole cycles per loop),
 *   seed: grain seed (101*(channelIndex+1) by convention)}
 */
export function buildFrame(ch, analysis, opts) {
  const { t, seed } = opts;
  const sec = opts.sec ?? t, loopSec = opts.loopSec;
  const fr = emptyFrame(t, ch['strip.balance']);
  if (!analysis || !ch['filter.on']) return fr;

  const quant = (f) => (loopSec ? Math.round(f * loopSec) / loopSec : f);
  const granular = ch['filter.type'] === 'granular';
  const grains = granular ? grainsAt(ch, seed, sec, loopSec) : undefined;
  const w = (u) => channelGain(u, ch, analysis, grains);
  if (granular) {
    const m = loudnessMatch(ch, seed);
    fr.match = Number.isFinite(m) ? m : 1;
  }
  const map = channelMapping(ch);
  const bands = analysis.bands || [];

  for (let i = 0; i < MAXB; i++) {
    const b = bands[i];
    if (!b) continue;
    const ff = mapFreq(b.u, map), f = snapFreq(ff, map), h = Math.max(2, Math.round(ff / map.f0));
    const det = ch['drone.beat'] * (0.04 + 0.5 * Math.min(1, b.fwhmU * 8));
    const a = Math.pow(0.12 + 0.88 * b.rel, 0.7) / Math.pow(h, 0.3) * ch['drone.bands'] * BAND_AMP;
    const wu = w(b.u);
    const fr3 = [f, f + det, Math.max(20, f - 1.5 * det)], ga = [a, 0.55 * a, 0.55 * a];
    for (let k = 0; k < 3; k++) {
      fr.bandF[3 * i + k] = fin(quant(fr3[k]));
      fr.bandA[3 * i + k] = fin(ga[k] * wu);
    }
    fr.bandPan[i] = fin(clamp(((map.flip ? 1 - b.u : b.u) - 0.5) * 1.2, -0.8, 0.8));
  }

  for (let j = 0; j < COMB; j++) {
    const du = (j + 0.5) / COMB, ff = mapFreq(du, map), f = snapFreq(ff, map);
    const val = ch['drone.combSrc'] === 'refl'
      ? Math.pow(sampleProfile(analysis.r, du), 1.5)
      : Math.pow(sampleProfile(analysis.d, du) / analysis.dmax, 0.8);
    fr.combF[j] = fin(quant(f));
    fr.combA[j] = fin(val * ch['drone.comb'] * COMB_AMP / Math.pow(Math.max(f, 110) / 110, 0.35) * w(du));
  }

  for (let k = 0; k < NK; k++) {
    const du = (k + 0.5) / NK, ff = mapFreq(du, map);
    const tilt = (100 / Math.max(ff, 40)) / (1 + Math.pow(ff / 2200, 4));
    fr.noiseF[k] = fin(ff);
    fr.noiseA[k] = fin(Math.sqrt(sampleProfile(analysis.r, du)) * (1 + 5 * sampleProfile(analysis.d, du) / analysis.dmax)
      * tilt * ch['drone.noise'] * NOISE_AMP * w(du));
  }

  fr.anchorF[0] = fin(quant(2 * map.f0));
  fr.anchorF[1] = fin(quant(4 * map.f0));
  fr.anchorA[0] = fin(ch['drone.anchor'] * ANCHOR_AMP);
  fr.anchorA[1] = fin(ch['drone.anchor'] * ANCHOR_AMP * 0.5);
  return fr;
}
