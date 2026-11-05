/*
 * Spectrum windows: the horizontal window, the vertical (value) gate and the per-channel gain.
 * Pure module: no DOM, no Web Audio.
 */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Linear interpolation of a profile at u in [0,1]; the grid size comes from arr.length. */
export function sampleProfile(arr, u) {
  const M = arr.length;
  const p = clamp(u, 0, 1) * (M - 1), i = Math.floor(p), j = Math.min(M - 1, i + 1), f = p - i;
  return arr[i] * (1 - f) + arr[j] * f;
}

/** Window centred on c, total width w, edge softness s (cosine taper); 1 inside, 0 outside. */
export function winOne(u, c, w, s) {
  if (w >= 0.999) return 1;
  const half = w / 2, d = Math.abs(u - c), inner = half * (1 - s), outer = half * (1 + s) + 1e-6;
  if (d <= inner) return 1;
  if (d >= outer) return 0;
  return 0.5 * (1 + Math.cos(Math.PI * (d - inner) / (outer - inner)));
}

/**
 * Vertical window: gates a partial by the strength of the spectrum at its position
 * (mode 1 reflectance, mode 2 depth normalised by dmax), on top of the horizontal window.
 */
export function verticalGate(analysis, u, { mode, center, height, soft }) {
  const m = Math.round(mode || 0);
  if (!m || !analysis) return 1;
  if (height >= 0.999) return 1;
  const v = m === 1 ? sampleProfile(analysis.r, u) : sampleProfile(analysis.d, u) / (analysis.dmax || 1);
  return winOne(v, center, height, soft);
}

/**
 * Gain of one channel at position u. ch is a ResolvedChannel (short keys); grains, when the
 * channel is granular, is an array of [u, width, soft, level].
 */
export function channelGain(u, ch, analysis, grains) {
  if (!ch['filter.on']) return 0;
  const gate = verticalGate(analysis, u, {
    mode: ch['vwin.mode'], center: ch['vwin.center'], height: ch['vwin.height'], soft: ch['vwin.soft'],
  });
  if (ch['filter.type'] === 'granular') {
    if (!Array.isArray(grains)) return 0;
    let k = 1;
    for (const g of grains) k *= 1 - winOne(u, g[0], g[1], g[2]) * g[3];
    return (1 - k) * gate;
  }
  return winOne(u, ch['filter.center'], ch['filter.width'], ch['filter.soft']) * ch['filter.level'] * gate;
}
