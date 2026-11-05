/*
 * The shared stage: spectrum plot with the four channel windows, range selector, readout and monitors.
 * Browser module. createStage(host, {store, app, getLive?}) builds into `host`.
 *
 * - The plot repaints only when dirty (store params of the filter/vwin/map/source/grain groups, app version
 *   bumps, resize, hover); the rAF loop runs only while something is pending or analysers feed the monitors.
 * - Drag writes to the store are coalesced to one per animation frame.
 * - Strings from files (layer names, line labels) only ever reach textContent or canvas fillText.
 * `getLive` is accepted for the transport task (live modulated values); the stage currently draws stored values.
 */
import { NUM_CHANNELS, pid, channelView } from '../core/schema.js';
import { profileOnStage, layerOnStage } from '../spectrum/layers.js';
import { winOne, sampleProfile } from '../dsp/window.js';
import { mapFreq, snapFreq, channelMapping } from '../dsp/mapping.js';
import { fmtX, fmtHz, noteName } from './controls.js';
import {
  plotRect, uToPx, pxToU, axisTicks, hitWindow, dragWindow, wheelWidth, arrowStep, MIN_WIDTH,
} from './stage-geom.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const M = 512;
const EDGE_TOL = 9; // px
const WATCH = /^ch[1-4]\.(filter|vwin|map|source|grain)\./;
const rgba = (hex, a) => {
  const h = String(hex).trim();
  if (!/^#[0-9a-f]{6}$/i.test(h)) return `rgba(200,200,200,${a})`;
  const n = parseInt(h.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};

export function createStage(host, { store, app } = {}) {
  const el = (tag, props = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) { if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else e.setAttribute(k, v); }
    e.append(...kids);
    return e;
  };
  const cleanups = [];
  const on = (t, type, fn, opts) => { t.addEventListener(type, fn, opts); cleanups.push(() => t.removeEventListener(type, fn, opts)); };

  // ---- DOM -------------------------------------------------------------------------------------
  const viewSel = el('select', { id: 'selView', 'aria-label': 'View' },
    el('option', { value: 'both', text: 'Spectrum and depth' }), el('option', { value: 'spectrum', text: 'Spectrum only' }), el('option', { value: 'depth', text: 'Depth only' }));
  const plot = el('canvas', {
    id: 'plot', tabindex: '0', role: 'application',
    'aria-label': 'Spectrum plot. Drag a window to move it, drag its edges to resize, use arrow keys to move or resize the selected window, keys 1 to 4 select a channel.',
    'aria-describedby': 'plot-live',
    'data-tip': 'Drag inside a window to move it, drag an edge to resize it, scroll to change its width, or click empty space to put the selected channel\'s window there. Arrow keys work too; keys 1 to 4 pick a channel.',
  });
  const live = el('div', { id: 'plot-live', class: 'sr-only', role: 'status', 'aria-live': 'polite' });
  const empty = el('div', { class: 'empty', id: 'empty' },
    el('h2', { text: 'Drop a spectrum here' }),
    el('p', { text: 'Two columns of text: position along the spectrum, then the measured value. .tab, .txt and .csv all work, or pick an example. Nothing plays until you load something.' }));
  const rng = el('canvas', {
    id: 'rng', tabindex: '0',
    'aria-label': 'Range selector. Drag the edges or the middle to choose a segment of the spectrum, arrow keys nudge it, Enter zooms.',
    'data-tip': 'Drag the edges to choose a segment of the spectrum, drag the middle to slide it, or drag across empty space to start a new one. Double-click to select everything.',
  });
  const btnZoom = el('button', { type: 'button', class: 'btn', id: 'btnZoom', text: 'Zoom to selection' });
  const btnZoomOut = el('button', { type: 'button', class: 'btn', id: 'btnZoomOut', text: 'Zoom out' });
  const rinfo = el('span', { class: 'rinfo', id: 'rinfo' });
  const readout = el('div', { class: 'readout', id: 'readout' });
  const scope = el('canvas', { id: 'scope', 'aria-label': 'Waveform monitor' });
  const ana = el('canvas', { id: 'ana', 'aria-label': 'Spectrum monitor, 30 hertz to 8 kilohertz' });
  const root = el('div', { class: 'stagebox' },
    el('div', { class: 'bar' }, el('label', {}, 'View', viewSel)),
    el('div', { class: 'plotwrap' }, plot, empty, live),
    el('div', { class: 'rangebar' }, rng, el('div', { class: 'rangerow' }, btnZoom, btnZoomOut, rinfo)),
    readout,
    el('div', { class: 'monitors' },
      el('div', {}, el('span', { class: 'lbl', text: 'Waveform' }), scope),
      el('div', {}, el('span', { class: 'lbl', text: 'Spectrum 30 Hz to 8 kHz' }), ana)));
  host.append(root);
  const pg = plot.getContext('2d'), rg = rng.getContext('2d'), sg = scope.getContext('2d'), ag = ana.getContext('2d');

  // ---- state -----------------------------------------------------------------------------------
  const C = {};
  const readColors = () => {
    const cs = getComputedStyle(document.documentElement);
    for (const k of ['fg', 'dim', 'line', 'accent', 'band', 'curve', 'panel', 'ch1', 'ch2', 'ch3', 'ch4']) C[k] = cs.getPropertyValue('--' + k).trim() || '#999999';
    C.mono = cs.getPropertyValue('--mono').trim() || 'monospace';
  };
  readColors();
  const chColor = c => C['ch' + (c + 1)];

  let view = 'both';
  let analysers = null;
  let hover = null;          // {u, x, y, line?} in plot css px
  let dragState = null;      // plot drag
  let pending = null;        // coalesced store write {ch, centre, width}
  let rs = { a: 0, b: 1 };   // range selection in u of the full range
  let rsDrag = null;
  let lastStageKey = '';
  let dirty = true, rngDirty = true, monDirty = true;
  let raf = 0, disposed = false, paints = 0;

  const request = () => { if (!raf && !disposed) raf = requestAnimationFrame(frame); };
  const markPlot = () => { dirty = true; request(); };
  const markRng = () => { rngDirty = true; request(); };
  const markAll = () => { dirty = rngDirty = monDirty = true; request(); };

  const fit = cv => {
    const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    cv.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
    return [w, h];
  };

  const chView = c => channelView(store.state.params, c);
  const windows = () => Array.from({ length: NUM_CHANNELS }, (_, c) => {
    const v = chView(c);
    return { channel: c, centre: v['filter.center'], width: v['filter.width'], enabled: !!v['filter.on'] };
  });
  const unit = () => (app.stage ? app.stage.unit : '');
  const xAt = u => app.stage.x0 + u * (app.stage.x1 - app.stage.x0);
  const hasLayers = () => app.layers.length > 0 && !!app.stage;

  // ---- plot drawing ----------------------------------------------------------------------------
  const yOfProfile = (R, v) => R.t + R.h * (1 - (0.08 + 0.84 * v));
  const depthScale = () => (view === 'depth' ? 0.9 : 0.42);

  function lineGeom(R) {
    // visible line-list layers on the current stage: [{layer, lines, imax, selected}]
    const selId = store.get(pid(app.selected, 'source.layer'));
    const out = [];
    for (const l of app.layers) {
      if (l.kind !== 'lines' || !app.isVisible(l.id)) continue;
      const L = layerOnStage(l, app.stage);
      if (!L || !L.lines.length) continue;
      let imax = 0; for (const ln of L.lines) if (ln.intensity > imax) imax = ln.intensity;
      out.push({ layer: l, lines: L.lines, imax: imax || 1, selected: l.id === selId });
    }
    return out;
  }
  const spanU = ln => (ln.x - app.stage.x0) / (app.stage.x1 - app.stage.x0);
  const tickTop = (R, ln, imax) => R.b - clamp(ln.intensity / imax, 0.04, 1) * R.h * 0.8;

  function paintPlot() {
    const [w, h] = fit(plot);
    pg.clearRect(0, 0, w, h);
    if (!hasLayers()) return;
    paints++;
    const R = plotRect(w, h), X = u => uToPx(u, R), st = app.stage;
    pg.font = `11px ${C.mono}`; pg.textBaseline = 'alphabetic';
    const sel = app.selected;

    // axis
    pg.strokeStyle = C.line; pg.fillStyle = C.dim; pg.lineWidth = 1; pg.textAlign = 'center';
    for (const t of axisTicks(st.x0, st.x1, Math.max(3, Math.floor(R.w / 110)))) {
      const x = Math.round(X((t.x - st.x0) / (st.x1 - st.x0))) + 0.5;
      pg.beginPath(); pg.moveTo(x, R.t); pg.lineTo(x, R.b); pg.stroke(); pg.fillText(t.label, x, R.b + 16);
    }
    pg.textAlign = 'right'; pg.fillText(st.unit, w - 14, h - 4);

    const selLayerId = store.get(pid(sel, 'source.layer'));
    const an = app.analysisFor(sel);

    // vertical window of the selected channel (behind everything)
    const sv = chView(sel);
    const vm = Math.round(sv['vwin.mode'] || 0);
    if (vm && sv['filter.on'] && sv['vwin.height'] < 0.999) {
      const yOf = v => (vm === 1 ? yOfProfile(R, v) : R.b - v * R.h * depthScale());
      const yc = sv['vwin.center'], yh = sv['vwin.height'];
      const y1 = yOf(clamp(yc + yh / 2, 0, 1)), y2 = yOf(clamp(yc - yh / 2, 0, 1)), col = chColor(sel);
      pg.fillStyle = rgba(col, 0.1); pg.fillRect(R.l, y1, R.w, y2 - y1);
      pg.strokeStyle = rgba(col, 0.7); pg.lineWidth = 1; pg.setLineDash([2, 4]);
      for (const y of [y1, y2]) { pg.beginPath(); pg.moveTo(R.l, Math.round(y) + 0.5); pg.lineTo(R.r, Math.round(y) + 0.5); pg.stroke(); }
      pg.setLineDash([]);
      pg.fillStyle = rgba(col, 0.9); pg.textAlign = 'left';
      pg.fillText(`${vm === 1 ? 'reflectance' : 'depth'} window, channel ${sel + 1}`, R.l + 6, Math.max(R.t + 12, y1 - 4));
    }

    // selected channel's analysis depth curve
    if (an && view !== 'spectrum') {
      pg.beginPath(); pg.moveTo(R.l, R.b);
      for (let i = 0; i < an.d.length; i++) pg.lineTo(X(i / (an.d.length - 1)), R.b - (an.d[i] / (an.dmax || 1)) * R.h * depthScale());
      pg.lineTo(R.r, R.b); pg.closePath(); pg.fillStyle = rgba(C.band, 0.2); pg.fill();
    }

    // layers: sampled as polylines, line lists as ticks
    const hoverLayerLine = hover && hover.line;
    if (view !== 'depth') {
      for (const l of app.layers) {
        if (l.kind === 'lines' || !app.isVisible(l.id)) continue;
        const prof = profileOnStage(l, st, M);
        let lo = Infinity, hi = -Infinity;
        for (let i = 0; i < M; i++) { if (prof[i] < lo) lo = prof[i]; if (prof[i] > hi) hi = prof[i]; }
        if (!(hi > lo)) continue;
        const isSel = l.id === selLayerId;
        pg.beginPath();
        for (let i = 0; i < M; i++) { const x = X(i / (M - 1)), y = yOfProfile(R, (prof[i] - lo) / (hi - lo)); if (i) pg.lineTo(x, y); else pg.moveTo(x, y); }
        pg.strokeStyle = isSel ? C.curve : rgba(C.curve, 0.3); pg.lineWidth = isSel ? 1.8 : 1; pg.stroke();
      }
    }
    pg.textAlign = 'center';
    for (const g of lineGeom(R)) {
      const strong = new Set(g.lines.slice().sort((a, b) => b.intensity - a.intensity).slice(0, 6));
      pg.lineWidth = g.selected ? 2 : 1;
      let lastEnd = -1e9;
      for (const ln of g.lines) {
        const x = Math.round(X(spanU(ln))) + 0.5, y = tickTop(R, ln, g.imax);
        const hot = hoverLayerLine && hoverLayerLine.ln === ln;
        pg.strokeStyle = hot ? C.fg : g.selected ? C.curve : rgba(C.curve, 0.4);
        pg.beginPath(); pg.moveTo(x, R.b); pg.lineTo(x, y); pg.stroke();
        if (ln.label && strong.has(ln) && !hot) {
          const tw = pg.measureText(ln.label).width;
          if (x - tw / 2 > lastEnd + 4) { pg.fillStyle = g.selected ? C.curve : rgba(C.curve, 0.6); pg.fillText(ln.label, clamp(x, R.l + tw / 2, R.r - tw / 2), y - 4); lastEnd = x + tw / 2; }
        }
      }
    }

    // detected bands of the selected channel's layer
    if (an) {
      const map = channelMapping(chView(sel));
      pg.textAlign = 'center'; let lastEnd = -1e9;
      for (const b of an.bands) {
        const x = Math.round(X(b.u)) + 0.5;
        pg.strokeStyle = rgba(C.band, 0.28); pg.lineWidth = 1;
        pg.beginPath(); pg.moveTo(x, R.t); pg.lineTo(x, R.b); pg.stroke();
        pg.fillStyle = C.band; pg.beginPath(); pg.moveTo(x, R.t + 1); pg.lineTo(x - 4, R.t - 5); pg.lineTo(x + 4, R.t - 5); pg.closePath(); pg.fill();
        const label = fmtHz(snapFreq(mapFreq(b.u, map), map)), tw = pg.measureText(label).width;
        if (x - tw / 2 > lastEnd + 6) { pg.fillStyle = rgba(C.band, 0.85); pg.fillText(label, clamp(x, R.l + tw / 2, R.r - tw / 2), R.t - 9); lastEnd = x + tw / 2; }
      }
    }

    // channel windows; the selected one last and strongest
    const badges = [];
    const order = [0, 1, 2, 3].filter(c => c !== sel).concat(sel);
    for (const c of order) {
      const v = chView(c);
      if (!v['filter.on']) continue;
      const col = chColor(c), isSel = c === sel, cen = v['filter.center'], wd = v['filter.width'];
      if (v['filter.type'] === 'granular') {
        const lo = clamp(cen - wd / 2, 0, 1), hi = clamp(cen + wd / 2, 0, 1);
        pg.fillStyle = rgba(col, isSel ? 0.12 : 0.07); pg.fillRect(X(lo), R.t, X(hi) - X(lo), R.h);
        pg.strokeStyle = rgba(col, isSel ? 0.95 : 0.6); pg.lineWidth = isSel ? 1.5 : 1; pg.setLineDash([5, 4]);
        pg.strokeRect(Math.round(X(lo)) + 0.5, R.t + 0.5, Math.max(1, X(hi) - X(lo)), R.h); pg.setLineDash([]);
      } else {
        const amp = R.h * 0.92, lvl = v['filter.level'];
        pg.beginPath(); pg.moveTo(R.l, R.b);
        const pts = [];
        for (let px = 0; px <= R.w; px += 2) { const u = px / R.w, y = R.b - winOne(u, cen, wd, v['filter.soft']) * lvl * amp; pts.push([R.l + px, y]); pg.lineTo(R.l + px, y); }
        pg.lineTo(R.r, R.b); pg.closePath(); pg.fillStyle = rgba(col, isSel ? 0.22 : 0.13); pg.fill();
        pg.beginPath(); pts.forEach(([x, y], i) => { if (i) pg.lineTo(x, y); else pg.moveTo(x, y); });
        pg.strokeStyle = rgba(col, isSel ? 1 : 0.7); pg.lineWidth = isSel ? 2 : 1.2; pg.stroke();
        if (wd < 0.999) {
          for (const u of [cen - wd / 2, cen + wd / 2]) {
            if (u < 0 || u > 1) continue;
            const x = Math.round(X(u)) + 0.5;
            pg.strokeStyle = rgba(col, isSel ? 0.9 : 0.4); pg.lineWidth = isSel ? 1.5 : 1; pg.beginPath(); pg.moveTo(x, R.t); pg.lineTo(x, R.b); pg.stroke();
            if (isSel) { pg.fillStyle = col; pg.fillRect(x - 3, R.t + R.h / 2 - 12, 6, 24); }
          }
        }
      }
      const cx = Math.round(X(cen)) + 0.5;
      pg.strokeStyle = rgba(col, isSel ? 0.6 : 0.3); pg.lineWidth = 1; pg.setLineDash([3, 4]);
      pg.beginPath(); pg.moveTo(cx, R.t); pg.lineTo(cx, R.b); pg.stroke(); pg.setLineDash([]);
      badges.push({ c, x: clamp(cx, R.l + 9, R.r - 9), sel: isSel });
    }
    // channel number badges, stacked when they collide
    badges.sort((a, b) => a.x - b.x);
    const placed = [];
    for (const b of badges) {
      let row = 0; while (placed.some(p => p.row === row && Math.abs(p.x - b.x) < 20)) row++;
      placed.push({ x: b.x, row });
      const y = R.t + 11 + row * 20, col = chColor(b.c);
      pg.fillStyle = col; pg.beginPath(); pg.arc(b.x, y, 8, 0, Math.PI * 2); pg.fill();
      if (b.sel) { pg.strokeStyle = C.fg; pg.lineWidth = 1.5; pg.stroke(); }
      pg.fillStyle = '#0e1118'; pg.textAlign = 'center'; pg.fillText(String(b.c + 1), b.x, y + 4);
    }

    // hover guide and line tooltip
    if (hover) {
      const x = Math.round(X(hover.u)) + 0.5;
      pg.strokeStyle = rgba(C.fg, 0.25); pg.lineWidth = 1; pg.beginPath(); pg.moveTo(x, R.t); pg.lineTo(x, R.b); pg.stroke();
      if (hover.line) {
        const ln = hover.line.ln;
        const text = `${ln.label ? ln.label + ' · ' : ''}${fmtX(ln.x)} ${st.unit}`;
        const tw = pg.measureText(text).width + 12, tx = clamp(hover.x + 12, R.l, R.r - tw), ty = clamp(hover.y - 26, R.t, R.b - 20);
        pg.fillStyle = 'rgba(27,34,50,0.95)'; pg.fillRect(tx, ty, tw, 20);
        pg.strokeStyle = C.dim; pg.lineWidth = 1; pg.strokeRect(tx + 0.5, ty + 0.5, tw - 1, 19);
        pg.fillStyle = C.fg; pg.textAlign = 'left'; pg.fillText(text, tx + 6, ty + 14);
      }
    }
  }

  // ---- readout ---------------------------------------------------------------------------------
  function updateReadout() {
    if (!hasLayers()) { readout.textContent = ''; return; }
    const sel = app.selected, v = chView(sel), map = channelMapping(v);
    const pitch = u => { const f = snapFreq(mapFreq(u, map), map); return `${fmtHz(f)} (${noteName(f)})`; };
    if (!hover) {
      const lo = clamp(v['filter.center'] - v['filter.width'] / 2, 0, 1), hi = clamp(v['filter.center'] + v['filter.width'] / 2, 0, 1);
      readout.textContent = `channel ${sel + 1}${v['filter.on'] ? '' : ' (off)'} ${fmtX(xAt(lo))} to ${fmtX(xAt(hi))} ${unit()} · ${pitch(lo)} to ${pitch(hi)}`;
      return;
    }
    const parts = [`${fmtX(xAt(hover.u))} ${unit()}`, `channel ${sel + 1} pitch ${pitch(hover.u)}`];
    const an = app.analysisFor(sel);
    if (an) parts.push(`level ${sampleProfile(an.r, hover.u).toFixed(3)}`, `depth ${(sampleProfile(an.d, hover.u) * 100).toFixed(1)}%`);
    if (hover.line) parts.unshift(`${hover.line.ln.label || 'line'} at ${fmtX(hover.line.ln.x)} ${unit()}`);
    readout.textContent = parts.join(' · ');
  }

  function describe() {
    if (!hasLayers()) { live.textContent = ''; return; }
    const sel = app.selected, v = chView(sel);
    live.textContent = `Channel ${sel + 1}${v['filter.on'] ? '' : ' off'}: window centre ${Math.round(v['filter.center'] * 100)} percent, width ${Math.round(v['filter.width'] * 100)} percent.`;
  }

  // ---- plot interaction ------------------------------------------------------------------------
  const plotU = ev => { const b = plot.getBoundingClientRect(); return pxToU(ev.clientX - b.left, plotRect(plot.clientWidth, plot.clientHeight)); };
  const plotR = () => plotRect(plot.clientWidth, plot.clientHeight);
  const writeWin = (ch, centre, width) => {
    pending = { ch, centre, width };
    request();
  };
  const flushPending = () => {
    if (!pending) return;
    const p = pending; pending = null;
    store.set(pid(p.ch, 'filter.center'), p.centre);
    store.set(pid(p.ch, 'filter.width'), p.width);
  };
  const lineAt = (px, py) => {
    const R = plotR();
    let best = null;
    for (const g of lineGeom(R)) for (const ln of g.lines) {
      const x = uToPx(spanU(ln), R), dx = Math.abs(px - x);
      if (dx > 5) continue;
      if (py < tickTop(R, ln, g.imax) - 4 || py > R.b + 2) continue;
      if (!best || dx < best.dx) best = { dx, ln };
    }
    return best;
  };
  const curWin = c => { const v = chView(c); return { centre: v['filter.center'], width: v['filter.width'] }; };

  on(plot, 'pointerdown', ev => {
    if (!hasLayers() || ev.button > 0) return;
    plot.focus({ preventScroll: true });
    try { plot.setPointerCapture(ev.pointerId); } catch (e) { /* synthetic pointer ids have nothing to capture */ }
    const R = plotR(), u = plotU(ev), hit = hitWindow(u, windows(), EDGE_TOL, R);
    if (hit) {
      app.select(hit.channel);
      dragState = { ch: hit.channel, mode: hit.mode, u0: u, start: curWin(hit.channel) };
    } else {
      const ch = app.selected, start = curWin(ch);
      const centre = clamp(u, start.width / 2, 1 - start.width / 2);
      if (!chView(ch)['filter.on']) store.set(pid(ch, 'filter.on'), true);
      store.set(pid(ch, 'filter.center'), start.width >= 1 ? 0.5 : centre);
      dragState = { ch, mode: 'move', u0: u, start: curWin(ch) };
    }
    describe();
  });
  on(plot, 'pointermove', ev => {
    if (!hasLayers()) return;
    const b = plot.getBoundingClientRect(), px = ev.clientX - b.left, py = ev.clientY - b.top, u = plotU(ev);
    hover = { u, x: px, y: py, line: dragState ? null : lineAt(px, py) };
    if (dragState) {
      const r = dragWindow(dragState.start, dragState.mode, u - dragState.u0);
      writeWin(dragState.ch, r.centre, r.width);
      plot.style.cursor = dragState.mode === 'move' ? 'grabbing' : 'ew-resize';
    } else {
      const hit = hitWindow(u, windows(), EDGE_TOL, plotR());
      plot.style.cursor = !hit ? 'crosshair' : hit.mode === 'move' ? 'grab' : 'ew-resize';
    }
    updateReadout(); markPlot();
  });
  const endDrag = () => { if (dragState) { dragState = null; flushPending(); describe(); } };
  on(plot, 'pointerup', endDrag);
  on(plot, 'pointercancel', endDrag);
  on(plot, 'pointerleave', () => { if (!dragState) { hover = null; updateReadout(); markPlot(); } });
  on(plot, 'wheel', ev => {
    if (!hasLayers()) return;
    ev.preventDefault();
    const ch = app.selected, v = curWin(ch);
    store.set(pid(ch, 'filter.width'), wheelWidth(v.width, ev.deltaY));
    describe();
  }, { passive: false });
  on(plot, 'keydown', ev => {
    if (!hasLayers() || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (/^[1-4]$/.test(ev.key)) { ev.preventDefault(); app.select(+ev.key - 1); describe(); return; }
    const step = arrowStep(ev.key, ev.shiftKey);
    if (!step) return;
    ev.preventDefault();
    const ch = app.selected, v = curWin(ch);
    if (step.dCentre) store.set(pid(ch, 'filter.center'), clamp(v.centre + step.dCentre, 0, 1));
    if (step.widthFactor !== 1) store.set(pid(ch, 'filter.width'), clamp(v.width * step.widthFactor, MIN_WIDTH, 1));
    describe();
  });

  // ---- range selector --------------------------------------------------------------------------
  const RL = 14;
  const rngU = ev => { const b = rng.getBoundingClientRect(); return clamp((ev.clientX - b.left - RL) / Math.max(1, b.width - 2 * RL), 0, 1); };
  const rngTol = () => 9 / Math.max(1, rng.clientWidth - 2 * RL);
  const fullSpan = () => app.fullRange.x1 - app.fullRange.x0;
  const fullX = u => app.fullRange.x0 + u * fullSpan();
  const syncSelectionToStage = () => {
    if (!app.stage || !app.fullRange) { rs = { a: 0, b: 1 }; return; }
    const k = `${app.stage.unit}|${app.stage.x0}|${app.stage.x1}|${app.fullRange.x0}|${app.fullRange.x1}`;
    if (k === lastStageKey) return;
    lastStageKey = k;
    rs = { a: clamp((app.stage.x0 - app.fullRange.x0) / fullSpan(), 0, 1), b: clamp((app.stage.x1 - app.fullRange.x0) / fullSpan(), 0, 1) };
  };
  const rangeLayer = () => {
    const id = store.get(pid(app.selected, 'source.layer'));
    return app.layerById(id) || app.layers[0] || null;
  };
  function paintRange() {
    const [w, h] = fit(rng);
    rg.clearRect(0, 0, w, h);
    if (!hasLayers()) { rinfo.textContent = ''; btnZoom.disabled = true; btnZoomOut.disabled = true; return; }
    const W = w - 2 * RL, T = 6, B = h - 18, X = u => RL + u * W;
    const full = { unit: app.stage.unit, x0: app.fullRange.x0, x1: app.fullRange.x1 };
    const layer = rangeLayer();
    if (layer) {
      const prof = profileOnStage(layer, full, M);
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < M; i++) { if (prof[i] < lo) lo = prof[i]; if (prof[i] > hi) hi = prof[i]; }
      if (hi > lo) {
        rg.beginPath(); rg.moveTo(RL, B);
        for (let i = 0; i < M; i++) rg.lineTo(X(i / (M - 1)), B - ((prof[i] - lo) / (hi - lo)) * (B - T));
        rg.lineTo(RL + W, B); rg.closePath(); rg.fillStyle = rgba(C.band, 0.18); rg.fill();
        rg.strokeStyle = C.curve; rg.lineWidth = 1.2; rg.beginPath();
        for (let i = 0; i < M; i++) { const x = X(i / (M - 1)), y = B - ((prof[i] - lo) / (hi - lo)) * (B - T); if (i) rg.lineTo(x, y); else rg.moveTo(x, y); }
        rg.stroke();
      }
    }
    rg.fillStyle = 'rgba(8,10,16,0.62)'; rg.fillRect(RL, 0, rs.a * W, h - 14); rg.fillRect(X(rs.b), 0, (1 - rs.b) * W, h - 14);
    rg.fillStyle = rgba(C.accent, 0.12); rg.fillRect(X(rs.a), 0, (rs.b - rs.a) * W, h - 14);
    rg.strokeStyle = C.accent; rg.lineWidth = 1.5; rg.strokeRect(X(rs.a) + 0.5, 1.5, (rs.b - rs.a) * W, h - 17);
    rg.fillStyle = C.accent; for (const u of [rs.a, rs.b]) rg.fillRect(Math.round(X(u)) - 3, T + 4, 6, B - T - 8);
    rg.font = `11px ${C.mono}`; rg.fillStyle = C.dim; rg.textBaseline = 'alphabetic';
    rg.textAlign = 'left'; rg.fillText(fmtX(fullX(0)), RL, h - 4);
    rg.textAlign = 'right'; rg.fillText(fmtX(fullX(1)) + ' ' + full.unit, RL + W, h - 4);
    const wholeSel = rs.b - rs.a > 0.995;
    const vis = `${fmtX(app.stage.x0)} to ${fmtX(app.stage.x1)} ${full.unit}`;
    rinfo.textContent = wholeSel ? `showing ${vis}` : `selected ${fmtX(fullX(rs.a))} to ${fmtX(fullX(rs.b))} ${full.unit} · showing ${vis}`;
    btnZoom.disabled = wholeSel;
    btnZoomOut.disabled = !app.canZoomOut();
  }
  const zoomSel = () => {
    if (!hasLayers() || rs.b - rs.a > 0.995) return;
    app.zoomTo(fullX(rs.a), fullX(rs.b));
  };
  on(rng, 'pointerdown', ev => {
    if (!hasLayers()) return;
    try { rng.setPointerCapture(ev.pointerId); } catch (e) { /* synthetic pointer ids have nothing to capture */ }
    rng.focus({ preventScroll: true });
    const u = rngU(ev), px = rngTol();
    if (Math.abs(u - rs.a) < px) rsDrag = { m: 'a' };
    else if (Math.abs(u - rs.b) < px) rsDrag = { m: 'b' };
    else if (u > rs.a && u < rs.b && rs.b - rs.a < 0.995) rsDrag = { m: 'move', off: u - rs.a, w: rs.b - rs.a };
    else { rsDrag = { m: 'new', u0: u }; rs = { a: Math.min(u, 0.98), b: Math.min(1, u + 0.02) }; }
    markRng();
  });
  on(rng, 'pointermove', ev => {
    if (!hasLayers()) return;
    const u = rngU(ev);
    if (!rsDrag) {
      const px = rngTol();
      rng.style.cursor = (Math.abs(u - rs.a) < px || Math.abs(u - rs.b) < px) ? 'ew-resize' : (u > rs.a && u < rs.b && rs.b - rs.a < 0.995) ? 'grab' : 'crosshair';
      return;
    }
    if (rsDrag.m === 'a') rs.a = clamp(u, 0, rs.b - 0.02);
    else if (rsDrag.m === 'b') rs.b = clamp(u, rs.a + 0.02, 1);
    else if (rsDrag.m === 'move') { const a = clamp(u - rsDrag.off, 0, 1 - rsDrag.w); rs = { a, b: a + rsDrag.w }; }
    else { const a = Math.min(rsDrag.u0, u); let b = Math.max(rsDrag.u0, u, a + 0.02); let a2 = a; if (b > 1) { b = 1; a2 = Math.min(a, 0.98); } rs = { a: a2, b }; }
    markRng();
  });
  const endRng = () => { rsDrag = null; };
  on(rng, 'pointerup', endRng); on(rng, 'pointercancel', endRng);
  on(rng, 'dblclick', () => { rs = { a: 0, b: 1 }; markRng(); });
  on(rng, 'keydown', ev => {
    if (!hasLayers()) return;
    const s = ev.shiftKey ? 0.1 : 0.02; let hit = true;
    if (ev.key === 'ArrowLeft') { const d = Math.min(s, rs.a); rs = { a: rs.a - d, b: rs.b - d }; }
    else if (ev.key === 'ArrowRight') { const d = Math.min(s, 1 - rs.b); rs = { a: rs.a + d, b: rs.b + d }; }
    else if (ev.key === 'ArrowUp') { const a = clamp(rs.a + s / 2, 0, rs.b - 0.02); rs = { a, b: clamp(rs.b - s / 2, a + 0.02, 1) }; }
    else if (ev.key === 'ArrowDown') rs = { a: clamp(rs.a - s / 2, 0, 1), b: clamp(rs.b + s / 2, 0, 1) };
    else if (ev.key === 'Enter') zoomSel();
    else if (ev.key === 'Escape') rs = { a: 0, b: 1 };
    else hit = false;
    if (hit) { ev.preventDefault(); markRng(); }
  });
  on(btnZoom, 'click', zoomSel);
  on(btnZoomOut, 'click', () => { app.zoomOut(); });

  // ---- monitors --------------------------------------------------------------------------------
  let td = null, fd = null;
  function paintMonitors() {
    const [sw, sh] = fit(scope), [aw, ah] = fit(ana);
    sg.clearRect(0, 0, sw, sh); ag.clearRect(0, 0, aw, ah);
    sg.strokeStyle = C.line; sg.lineWidth = 1; sg.beginPath(); sg.moveTo(0, sh / 2 + 0.5); sg.lineTo(sw, sh / 2 + 0.5); sg.stroke();
    ag.strokeStyle = C.line; ag.lineWidth = 1; ag.beginPath(); ag.moveTo(0, ah - 0.5); ag.lineTo(aw, ah - 0.5); ag.stroke();
    const an = analysers && analysers.analyser;
    if (!an) return;
    if (!td || td.length !== an.fftSize) td = new Float32Array(an.fftSize);
    an.getFloatTimeDomainData(td);
    sg.strokeStyle = C.curve; sg.lineWidth = 1; sg.beginPath();
    const n = Math.min(1024, td.length);
    for (let i = 0; i < n; i++) { const x = i / (n - 1) * sw, y = sh / 2 - td[i] * sh * 1.6; if (i) sg.lineTo(x, y); else sg.moveTo(x, y); }
    sg.stroke();
    if (!fd || fd.length !== an.frequencyBinCount) fd = new Uint8Array(an.frequencyBinCount);
    an.getByteFrequencyData(fd);
    const binHz = ((an.context && an.context.sampleRate) || 48000) / an.fftSize;
    ag.strokeStyle = C.accent; ag.lineWidth = 1; ag.beginPath();
    for (let x = 0; x < aw; x++) {
      const f = 30 * Math.pow(8000 / 30, x / (aw - 1)), v = fd[clamp(Math.round(f / binHz), 0, fd.length - 1)], y = ah - (v / 255) * ah;
      if (x) ag.lineTo(x, y); else ag.moveTo(x, y);
    }
    ag.stroke();
  }

  // ---- loop ------------------------------------------------------------------------------------
  function syncChrome() {
    empty.hidden = hasLayers();
    syncSelectionToStage();
  }
  function frame() {
    raf = 0;
    if (disposed) return;
    flushPending();
    if (dirty) { dirty = false; syncChrome(); paintPlot(); updateReadout(); }
    if (rngDirty) { rngDirty = false; syncSelectionToStage(); paintRange(); }
    if (analysers && analysers.analyser) { paintMonitors(); monDirty = false; request(); }
    else if (monDirty) { monDirty = false; paintMonitors(); }
  }

  const unsubStore = store.subscribe(id => {
    if (typeof id === 'string' && WATCH.test(id)) { dirty = true; if (id.includes('.source.')) rngDirty = true; request(); }
  });
  const unsubApp = app.subscribe(() => { syncChrome(); describe(); dirty = rngDirty = true; request(); });
  on(viewSel, 'change', () => { view = viewSel.value; markPlot(); });
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => markAll()) : null;
  if (ro) for (const cv of [plot, rng, scope, ana]) ro.observe(cv);
  on(window, 'resize', markAll);

  syncChrome();
  markAll();

  return {
    get paints() { return paints; },
    refresh() { readColors(); syncChrome(); describe(); markAll(); },
    setAnalysers(a) { analysers = a && a.analyser ? a : null; monDirty = true; request(); },
    dispose() {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      unsubStore(); unsubApp();
      if (ro) ro.disconnect();
      for (const fn of cleanups.splice(0)) fn();
      root.remove();
    },
  };
}
