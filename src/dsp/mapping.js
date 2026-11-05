/*
 * Spectrum position to frequency: range mapping and harmonic snapping.
 * Pure module: no DOM, no Web Audio.
 */

/** u in [0,1] to Hz across [lo,hi], logarithmic or linear, optionally flipped. */
export function mapFreq(u, { lo, hi, curve, flip }) {
  const v = flip ? 1 - u : u;
  return curve === 'lin' ? lo + (hi - lo) * v : lo * Math.pow(hi / lo, v);
}

/** Pull f toward the nearest harmonic (>= 2) of f0 by amount snap (0 keeps f). */
export function snapFreq(f, { f0, snap }) {
  const h = Math.max(2, Math.round(f / f0));
  return Math.exp(Math.log(f) * (1 - snap) + Math.log(h * f0) * snap);
}

/** Mapping parameters of a ResolvedChannel. */
export function channelMapping(ch) {
  return {
    lo: ch['map.lo'], hi: ch['map.hi'], curve: ch['map.curve'], flip: ch['map.flip'],
    f0: ch['map.f0'], snap: ch['map.snap'],
  };
}
