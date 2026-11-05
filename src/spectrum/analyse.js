/* Sampled-spectrum analysis: resample, hull-based dip/peak depth, band picking. Pure. */
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
