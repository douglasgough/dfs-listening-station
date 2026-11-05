/*
 * Stage geometry: pure helpers for the plot (axis ticks, window hit-testing and dragging). No DOM.
 * u is a position along the stage in [0,1]; rect comes from plotRect().
 */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const MIN_WIDTH = 0.02;

export function plotRect(w, h) { return { l: 14, r: w - 14, t: 26, b: h - 28, w: w - 28, h: h - 54 }; }
export const uToPx = (u, rect) => rect.l + u * rect.w;
export const pxToU = (px, rect) => clamp((px - rect.l) / (rect.w || 1), 0, 1);

export function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
}

const fmtX = v => { const a = Math.abs(v); return String(+v.toFixed(a < 10 ? 3 : a < 100 ? 2 : a < 1000 ? 1 : 0)); };

/** Nice tick values inside [x0,x1] (about targetCount of them) with clean labels. */
export function axisTicks(x0, x1, targetCount = 7) {
  if (!Number.isFinite(x0) || !Number.isFinite(x1) || !(x1 > x0)) return [];
  const step = niceStep((x1 - x0) / Math.max(1, targetCount));
  if (!(step > 0) || !Number.isFinite(step)) return [];
  const out = [];
  const first = Math.ceil(x0 / step - 1e-9);
  for (let k = first; k * step <= x1 + step * 1e-9 && out.length < 200; k++) {
    // k*step avoids the drift of repeated addition; round away binary noise
    const x = +(k * step).toPrecision(12);
    out.push({ x, label: fmtX(x) });
  }
  return out;
}

export function windowEdges(centre, width) {
  return { lo: clamp(centre - width / 2, 0, 1), hi: clamp(centre + width / 2, 0, 1) };
}

/**
 * Which window is under u. windows = [{channel, centre, width, enabled}].
 * Edge handles (within tolPx) beat interiors; the nearest edge wins; for overlapping interiors the
 * window whose centre is nearest to u wins (ties go to the lower channel). Disabled windows never hit.
 */
export function hitWindow(u, windows, tolPx, rect) {
  const tol = tolPx / (rect.w || 1);
  let edge = null;
  for (const w of windows) {
    if (!w.enabled || w.width >= 0.999) continue;
    const lo = w.centre - w.width / 2, hi = w.centre + w.width / 2;
    for (const [e, mode] of [[lo, 'resizeL'], [hi, 'resizeR']]) {
      if (e < 0 || e > 1) continue;
      const d = Math.abs(u - e);
      if (d > tol + 1e-12) continue;
      const dc = Math.abs(u - w.centre);
      if (!edge || d < edge.d - 1e-12 || (Math.abs(d - edge.d) <= 1e-12 && (dc < edge.dc || (dc === edge.dc && w.channel < edge.channel)))) {
        edge = { d, dc, channel: w.channel, mode };
      }
    }
  }
  if (edge) return { channel: edge.channel, mode: edge.mode };
  let best = null;
  for (const w of windows) {
    if (!w.enabled || Math.abs(u - w.centre) > w.width / 2 + 1e-12) continue;
    const dc = Math.abs(u - w.centre);
    if (!best || dc < best.dc - 1e-12 || (Math.abs(dc - best.dc) <= 1e-12 && w.channel < best.channel)) best = { dc, channel: w.channel };
  }
  return best ? { channel: best.channel, mode: 'move' } : null;
}

/** New {centre,width} after dragging by du (in u) from startState. Resize keeps the opposite edge fixed. */
export function dragWindow(start, mode, du) {
  const w0 = clamp(start.width, MIN_WIDTH, 1);
  if (mode === 'move') {
    const lo = w0 / 2, hi = 1 - w0 / 2;
    return { centre: lo > hi ? 0.5 : clamp(start.centre + du, lo, hi), width: w0 };
  }
  const L0 = clamp(start.centre - start.width / 2, 0, 1), R0 = clamp(start.centre + start.width / 2, 0, 1);
  let L = L0, R = R0;
  if (mode === 'resizeL') { R = Math.max(R0, MIN_WIDTH); L = clamp(L0 + du, 0, R - MIN_WIDTH); }
  else if (mode === 'resizeR') { L = Math.min(L0, 1 - MIN_WIDTH); R = clamp(R0 + du, L + MIN_WIDTH, 1); }
  return { centre: (L + R) / 2, width: R - L };
}

export const wheelWidth = (width, deltaY) => clamp(width * Math.exp(deltaY * 0.0015), MIN_WIDTH, 1);

/** Keyboard step on the plot: centre shift (Shift = x5) or width factor. Null for other keys. */
export function arrowStep(key, shift) {
  const big = shift ? 5 : 1;
  if (key === 'ArrowLeft') return { dCentre: -0.01 * big, widthFactor: 1 };
  if (key === 'ArrowRight') return { dCentre: 0.01 * big, widthFactor: 1 };
  if (key === 'ArrowUp') return { dCentre: 0, widthFactor: 1.1 };
  if (key === 'ArrowDown') return { dCentre: 0, widthFactor: 1 / 1.1 };
  return null;
}
