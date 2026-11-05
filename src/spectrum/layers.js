/* Spectral layers: units, conversion to a shared stage axis, and profile sampling. Pure: no DOM, no Web Audio.
 *
 * Layer = {id, name, kind:'sampled'|'lines', quantity:'reflectance'|'flux'|'optical-depth'|'intensity',
 *          axis:{unit,x0,x1}, x?:number[], y?:number[], lines?:Line[]}
 * Line  = {x, intensity, width?, label?, type?:'abs'|'em'}   (width = FWHM in the layer's own axis units)
 */
export const UNITS = ['nm', 'µm', 'Å', 'cm⁻¹', 'Hz', 'GHz', 'x'];

const C = 299792458; // m/s
const FWHM_TO_SIGMA = 1 / (2 * Math.sqrt(2 * Math.LN2));

// unit <-> nanometres. Reciprocal units need a strictly positive value.
const TO_NM = {
  'nm': v => v,
  'µm': v => v * 1e3,
  'Å': v => v / 10,
  'cm⁻¹': v => (v > 0 ? 1e7 / v : NaN),
  'Hz': v => (v > 0 ? C / v * 1e9 : NaN),
  'GHz': v => (v > 0 ? C / v : NaN),
};
const FROM_NM = {
  'nm': v => v,
  'µm': v => v / 1e3,
  'Å': v => v * 10,
  'cm⁻¹': v => (v > 0 ? 1e7 / v : NaN),
  'Hz': v => (v > 0 ? C / v * 1e9 : NaN),
  'GHz': v => (v > 0 ? C / v : NaN),
};

/** @returns number|null  null when not convertible (unknown/'x' mix, non-finite, non-positive reciprocal). */
export function convertPosition(v, from, to) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  if (from === to) return UNITS.includes(from) ? v : null;
  if (!(from in TO_NM) || !(to in FROM_NM)) return null;
  const nm = TO_NM[from](v);
  if (!Number.isFinite(nm)) return null;
  const out = FROM_NM[to](nm);
  return Number.isFinite(out) ? out : null;
}

export function stageAxisFrom(layer) {
  return { unit: layer.axis.unit, x0: layer.axis.x0, x1: layer.axis.x1 };
}

// Position mapper from the layer's own axis onto the stage: returns f(x) -> number|null, or null if impossible.
function mapperFor(layer, stage) {
  const from = layer.axis.unit;
  if (from === 'x') {
    const a0 = layer.axis.x0, a1 = layer.axis.x1;
    if (!(a1 > a0)) return null;
    const k = (stage.x1 - stage.x0) / (a1 - a0);
    return v => (Number.isFinite(v) ? stage.x0 + (v - a0) * k : null);
  }
  if (!(from in TO_NM) || !(stage.unit in FROM_NM)) return null;
  return v => convertPosition(v, from, stage.unit);
}

const stageOk = s => s && Number.isFinite(s.x0) && Number.isFinite(s.x1) && s.x1 > s.x0;

function meta(layer, stage, extra) {
  return {
    id: layer.id, name: layer.name, kind: layer.kind, quantity: layer.quantity,
    axis: { unit: stage.unit, x0: stage.x0, x1: stage.x1 },
    ...extra,
  };
}

function interpAt(xs, ys, e) {
  let lo = 0, hi = xs.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= e) lo = m; else hi = m; }
  const t = (e - xs[lo]) / (xs[hi] - xs[lo] || 1);
  return ys[lo] + (ys[hi] - ys[lo]) * t;
}

/** Layer expressed in the stage's unit, sorted ascending, clipped to [stage.x0, stage.x1]; null if no overlap/unconvertible. */
export function layerOnStage(layer, stage) {
  if (!layer || !stageOk(stage)) return null;
  const f = mapperFor(layer, stage);
  if (!f) return null;

  if (layer.kind === 'lines') {
    // Unconvertible axis endpoints (e.g. 0 cm⁻¹) are treated as unbounded: skip the overlap check.
    const a = f(layer.axis.x0), b = f(layer.axis.x1);
    if (a !== null && b !== null) {
      const lo = Math.min(a, b), hi = Math.max(a, b);
      if (!(Math.max(lo, stage.x0) < Math.min(hi, stage.x1))) return null;
    }
    const lines = [];
    for (const ln of layer.lines || []) {
      const x = f(ln.x);
      if (x === null || x < stage.x0 || x > stage.x1) continue;
      const out = { ...ln, x };
      if (typeof ln.width === 'number') {
        const w0 = f(ln.x - ln.width / 2), w1 = f(ln.x + ln.width / 2);
        if (w0 !== null && w1 !== null) out.width = Math.abs(w1 - w0); else delete out.width;
      }
      lines.push(out);
    }
    lines.sort((p, q) => p.x - q.x);
    return meta(layer, stage, { lines });
  }

  // sampled
  const pts = [];
  for (let i = 0; i < layer.x.length; i++) {
    const x = f(layer.x[i]);
    if (x !== null && Number.isFinite(layer.y[i])) pts.push([x, layer.y[i]]);
  }
  pts.sort((p, q) => p[0] - q[0]);
  const xs = [], ys = [];
  for (const p of pts) { if (xs.length && p[0] === xs[xs.length - 1]) continue; xs.push(p[0]); ys.push(p[1]); }
  if (xs.length < 2) return null;
  const cmin = xs[0], cmax = xs[xs.length - 1];
  if (!(Math.max(cmin, stage.x0) < Math.min(cmax, stage.x1))) return null;

  // Kept samples plus interpolated edge points; output is strictly increasing (first of equal x wins).
  const ox = [], oy = [];
  const push = (x, y) => { if (!ox.length || x > ox[ox.length - 1]) { ox.push(x); oy.push(y); } };
  if (cmin < stage.x0 && stage.x0 < cmax) push(stage.x0, interpAt(xs, ys, stage.x0));
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] >= stage.x0 && xs[i] <= stage.x1) push(xs[i], ys[i]);
  }
  if (cmin < stage.x1 && stage.x1 < cmax) push(stage.x1, interpAt(xs, ys, stage.x1));
  if (ox.length < 2) return null;
  return meta(layer, stage, { x: ox, y: oy });
}

/** Profile on the uniform stage grid x_i = x0 + (x1-x0)*i/(M-1). Lines: summed Gaussians with peak height = intensity. */
export function profileOnStage(layer, stage, M = 512) {
  const out = new Float64Array(M);
  const L = layerOnStage(layer, stage);
  if (!L || M < 2) return out;
  const span = stage.x1 - stage.x0, cell = span / (M - 1);

  if (L.kind === 'lines') {
    for (const ln of L.lines) {
      const fwhm = typeof ln.width === 'number' && ln.width > 0 ? ln.width : 1.5 * cell;
      const sigma = fwhm * FWHM_TO_SIGMA;
      const i0 = Math.max(0, Math.floor((ln.x - 6 * sigma - stage.x0) / cell));
      const i1 = Math.min(M - 1, Math.ceil((ln.x + 6 * sigma - stage.x0) / cell));
      for (let i = i0; i <= i1; i++) {
        const d = (stage.x0 + cell * i - ln.x) / sigma;
        out[i] += ln.intensity * Math.exp(-0.5 * d * d);
      }
    }
    return out;
  }

  const xs = L.x, ys = L.y, eps = 1e-9 * span;
  const first = xs[0], last = xs[xs.length - 1];
  let k = 0;
  for (let i = 0; i < M; i++) {
    const x = stage.x0 + span * i / (M - 1);
    if (x < first - eps || x > last + eps) continue;
    while (k < xs.length - 2 && xs[k + 1] < x) k++;
    const t = Math.min(1, Math.max(0, (x - xs[k]) / (xs[k + 1] - xs[k] || 1)));
    out[i] = ys[k] + (ys[k + 1] - ys[k]) * t;
  }
  return out;
}
