/* Spectrum analysis: hull/direct sampled modes, line features, velocity shift, memo cache. Pure. */
import { layerOnStage, profileOnStage } from './layers.js';

const MAXB = 10;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function upperHull(x, y) {
  const h = [];
  for (let i = 0; i < x.length; i++) {
    while (h.length >= 2) {
      const a = h[h.length - 2], b = h[h.length - 1];
      if ((x[b] - x[a]) * (y[i] - y[a]) - (y[b] - y[a]) * (x[i] - x[a]) >= 0) h.pop(); else break;
    }
    h.push(i);
  }
  const out = new Float64Array(x.length);
  for (let k = 0; k < h.length - 1; k++) {
    const a = h[k], b = h[k + 1];
    for (let i = a; i <= b; i++) out[i] = y[a] + (y[b] - y[a]) * (x[i] - x[a]) / (x[b] - x[a]);
  }
  return out;
}

export function smooth(a, w) {
  const n = a.length, out = new Float64Array(n), r = w >> 1;
  for (let i = 0; i < n; i++) { let s = 0, c = 0; for (let k = -r; k <= r; k++) { const j = i + k; if (j >= 0 && j < n) { s += a[j]; c++; } } out[i] = s / c; }
  return out;
}

export function findBands(d, sens) {
  const n = d.length, cand = [];
  for (let i = 1; i < n - 1; i++) {
    if (!(d[i] > d[i - 1] && d[i] >= d[i + 1] && d[i] > 1e-4)) continue;
    let minL = d[i], j = i - 1; while (j >= 0 && d[j] <= d[i]) { if (d[j] < minL) minL = d[j]; j--; }
    let minR = d[i], k = i + 1; while (k < n && d[k] <= d[i]) { if (d[k] < minR) minR = d[k]; k++; }
    cand.push({ i, prom: d[i] - Math.max(minL, minR) });
  }
  if (!cand.length) return [];
  const pmax = Math.max(...cand.map(c => c.prom), 1e-9);
  const keep = cand.filter(c => c.prom >= Math.max(sens * pmax, 1e-3 * pmax)).sort((a, b) => b.prom - a.prom).slice(0, MAXB).sort((a, b) => a.i - b.i);
  return keep.map(c => {
    const half = d[c.i] / 2; let l = c.i, r = c.i;
    while (l > 0 && d[l] > half) l--; while (r < n - 1 && d[r] > half) r++;
    return { u: c.i / (n - 1), depth: d[c.i], fwhmU: Math.max((r - l) / (n - 1), 1 / (n - 1)) };
  });
}

/**
 * @param sp sampled spectrum {x,y,x0,x1}
 * @param opts {polarity:'dips'|'peaks'|'both', sens:number, M?:number}
 * @returns {r:Float64Array, d:Float64Array, dmax:number, bands:Band[], gx:Float64Array}
 */
export function analyseSampled(sp, { polarity, sens, M = 512 }) {
  const gx = new Float64Array(M), gy = new Float64Array(M);
  let k = 0;
  for (let i = 0; i < M; i++) {
    const x = sp.x0 + (sp.x1 - sp.x0) * i / (M - 1);
    while (k < sp.x.length - 2 && sp.x[k + 1] < x) k++;
    const t = clamp((x - sp.x[k]) / (sp.x[k + 1] - sp.x[k] || 1), 0, 1);
    gx[i] = x; gy[i] = sp.y[k] + (sp.y[k + 1] - sp.y[k]) * t;
  }
  let lo = Infinity, hi = -Infinity; for (const v of gy) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const span = hi - lo || 1;
  const r = new Float64Array(M), yy = new Float64Array(M), uu = new Float64Array(M);
  for (let i = 0; i < M; i++) { r[i] = (gy[i] - lo) / span; yy[i] = r[i] + 0.05; uu[i] = i / (M - 1); }
  const up = upperHull(uu, yy);
  const zz = yy.map(v => 1.1 - v), lowH = upperHull(uu, zz);
  const dip = new Float64Array(M), pk = new Float64Array(M);
  for (let i = 0; i < M; i++) { dip[i] = Math.max(0, 1 - yy[i] / up[i]); pk[i] = Math.max(0, (yy[i] - (1.1 - lowH[i])) / yy[i]); }
  let d = polarity === 'dips' ? dip : polarity === 'peaks' ? pk : dip.map((v, i) => Math.max(v, pk[i]));
  d = smooth(d, 5);
  let dmax = 1e-6; for (const v of d) if (v > dmax) dmax = v;
  const bands = findBands(d, sens).map(b => ({ ...b, rel: b.depth / dmax }));
  return { r, d, dmax, bands, gx };
}

const EMPTY_DMAX = 1e-6;
const gridOf = (stage, M) => {
  const gx = new Float64Array(M);
  for (let i = 0; i < M; i++) gx[i] = stage.x0 + (stage.x1 - stage.x0) * i / (M - 1);
  return gx;
};
const emptyAnalysis = (stage, M) => ({ r: new Float64Array(M), d: new Float64Array(M), dmax: EMPTY_DMAX, bands: [], gx: gridOf(stage, M) });

// d -> {r, dmax}: r is the normalised depth for peaks, its complement otherwise. Polarity never changes d.
function finishDirect(d, polarity, gx) {
  let dmax = EMPTY_DMAX; for (const v of d) if (v > dmax) dmax = v;
  const r = new Float64Array(d.length);
  for (let i = 0; i < d.length; i++) r[i] = polarity === 'peaks' ? d[i] / dmax : 1 - d[i] / dmax;
  return { r, dmax, gx };
}

/**
 * Analyse a layer on a stage axis.
 * @param layer Layer ({kind:'sampled'|'lines', ...}, see layers.js)
 * @param stage {unit,x0,x1}
 * @param opts {polarity:'dips'|'peaks'|'both', sens:number, mode?:'hull'|'direct', M?:number}
 *   mode applies to sampled layers only. `sens` applies to sampled layers only; line bands come straight
 *   from the line list (the strongest MAXB by intensity), so sens is ignored for lines.
 * @returns {r:Float64Array, d:Float64Array, dmax:number, bands:Band[], gx:Float64Array}
 *   Band = {u, depth, fwhmU, rel, label?}. Unusable input yields an all-zero analysis (dmax 1e-6, no bands).
 */
export function analyse(layer, stage, { polarity, sens, mode = 'hull', M = 512 } = {}) {
  let lay = null;
  try { lay = layerOnStage(layer, stage); } catch { lay = null; } // malformed layers degrade to empty, never throw
  if (!lay) return emptyAnalysis(stage && Number.isFinite(stage.x0) && Number.isFinite(stage.x1) ? stage : { x0: 0, x1: 1 }, M);
  const span = stage.x1 - stage.x0;

  if (lay.kind === 'sampled') {
    if (mode !== 'direct') {
      return analyseSampled({ name: lay.name, x: lay.x, y: lay.y, x0: stage.x0, x1: stage.x1, unit: stage.unit }, { polarity, sens, M });
    }
    const p = profileOnStage(layer, stage, M);
    const d = smooth(p.map(v => Math.max(0, v)), 5);
    const { r, dmax, gx } = finishDirect(d, polarity, gridOf(stage, M));
    const bands = findBands(d, sens).map(b => ({ ...b, rel: b.depth / dmax }));
    return { r, d, dmax, bands, gx };
  }

  if (lay.kind === 'lines') {
    const kept = lay.lines.filter(l => l.intensity > 0 && (polarity === 'dips' ? l.type !== 'em' : polarity === 'peaks' ? l.type !== 'abs' : true));
    if (!kept.length) return emptyAnalysis(stage, M);
    let imax = 0; for (const l of kept) if (l.intensity > imax) imax = l.intensity;
    const bands = kept.slice().sort((a, b) => b.intensity - a.intensity).slice(0, MAXB).sort((a, b) => a.x - b.x).map(l => {
      const b = {
        u: (l.x - stage.x0) / span,
        depth: l.intensity,
        fwhmU: Math.max((typeof l.width === 'number' ? l.width : 1.5 * span / (M - 1)) / span, 1 / (M - 1)),
        rel: l.intensity / imax,
      };
      if (l.label !== undefined) b.label = l.label;
      return b;
    });
    const only = { kind: 'lines', axis: { unit: stage.unit, x0: stage.x0, x1: stage.x1 }, lines: kept };
    const d = profileOnStage(only, stage, M);
    const { r, dmax, gx } = finishDirect(d, polarity, gridOf(stage, M));
    return { r, d, dmax, bands, gx };
  }

  return emptyAnalysis(stage, M);
}

const C_KMS = 299792.458;
const WAVELENGTH_UNITS = new Set(['nm', 'µm', 'Å']);
const FREQUENCY_UNITS = new Set(['cm⁻¹', 'Hz', 'GHz']);

function sampleLinear(a, pos) {
  const n = a.length;
  if (!(pos > 0)) return a[0];
  if (pos >= n - 1) return a[n - 1];
  const i = Math.floor(pos), t = pos - i;
  return a[i] + (a[i + 1] - a[i]) * t;
}

/**
 * Doppler-shift an analysis by a radial velocity (km/s, positive = receding). Pure; never mutates `analysis`.
 * beta = kmS/c. Wavelength-family stages: x' = x(1+beta). Frequency-family: x' = x/(1+beta).
 * Unitless 'x': u' = u + beta. Bands leaving [0,1] are dropped; r/d are resampled (edge values clamped).
 * |kmS| < 1e-9 or non-finite returns the same object.
 */
export function applyShift(analysis, kmS, stage) {
  if (!Number.isFinite(kmS) || Math.abs(kmS) < 1e-9) return analysis;
  const beta = kmS / C_KMS;
  const { x0, x1, unit } = stage;
  const span = x1 - x0;
  // forward: stage position -> shifted position
  let fwd;
  if (WAVELENGTH_UNITS.has(unit)) fwd = x => x * (1 + beta);
  else if (FREQUENCY_UNITS.has(unit)) fwd = x => x / (1 + beta);
  else fwd = x => x + beta * span;
  // inverse, as a function of u: where does the value at grid cell u come from?
  let invU;
  if (WAVELENGTH_UNITS.has(unit)) invU = u => (((x0 + u * span) / (1 + beta)) - x0) / span;
  else if (FREQUENCY_UNITS.has(unit)) invU = u => (((x0 + u * span) * (1 + beta)) - x0) / span;
  else invU = u => u - beta;

  const bands = [];
  for (const b of analysis.bands) {
    const u = (fwd(x0 + b.u * span) - x0) / span;
    if (Number.isFinite(u) && u >= 0 && u <= 1) bands.push({ ...b, u });
  }
  const M = analysis.d.length;
  const r = new Float64Array(M), d = new Float64Array(M);
  for (let i = 0; i < M; i++) {
    let us = invU(i / (M - 1));
    if (!Number.isFinite(us)) us = i / (M - 1);
    const pos = us * (M - 1);
    r[i] = sampleLinear(analysis.r, pos);
    d[i] = sampleLinear(analysis.d, pos);
  }
  return { r, d, dmax: analysis.dmax, bands, gx: analysis.gx };
}

/**
 * Memoise analyse() by layer object identity plus stage/polarity/sens/mode/M.
 * A different layer object (even with the same id) is a miss; callers replace layer objects on edit.
 */
export function createAnalysisCache() {
  let byLayer = new WeakMap();
  return {
    get(layer, stage, { polarity, sens, mode = 'hull', M = 512 } = {}) {
      const key = [stage.unit, stage.x0, stage.x1, polarity, sens, mode, M].join('|');
      let m = byLayer.get(layer);
      if (!m) { m = new Map(); byLayer.set(layer, m); }
      let a = m.get(key);
      if (!a) { a = analyse(layer, stage, { polarity, sens, mode, M }); m.set(key, a); }
      return a;
    },
    clear() { byLayer = new WeakMap(); },
  };
}
