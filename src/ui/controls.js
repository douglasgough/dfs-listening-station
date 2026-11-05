/*
 * Schema-generated controls. The pure helpers (formatParam, toSliderPos, fromSliderPos, LOG_TAPER) have no DOM
 * dependence and are unit-tested in Node; bindParam builds DOM and only touches `document` when called.
 */
import { paramDef } from '../core/schema.js';
import { DIVISIONS } from '../core/transport.js';
import { onParams } from './store-bind.js';

/** Keys (without the channel prefix) that use a logarithmic slider taper, as the prototype's scale:'log'. */
export const LOG_TAPER = new Set(['filter.width', 'vwin.height', 'grain.dur', 'map.f0', 'map.lo', 'map.hi', 'event.rpm']);
export const SLIDER_STEPS = 1000;

const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const noteName = f => { const n = Math.round(12 * Math.log2(f / 440) + 69); return NOTES[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1); };
export const fmtHz = f => (f < 1000 ? f.toFixed(f < 100 ? 1 : 0) + ' Hz' : (f / 1000).toFixed(2) + ' kHz');
export const fmtX = v => { const a = Math.abs(v); return String(+v.toFixed(a < 10 ? 3 : a < 100 ? 2 : a < 1000 ? 1 : 0)); };
const pct = v => Math.round(v * 100) + '%';
export const fmtS = v => (v < 1 ? Math.round(v * 1000) + ' ms' : (v < 10 ? v.toFixed(2) : v.toFixed(1)) + ' s');
const fmtPer = s => (s < 60 ? s.toFixed(s < 10 ? 1 : 0) + ' s' : (s / 60).toFixed(1) + ' min');
const dB = v => (v < 0.01 ? 'off' : (20 * Math.log10(v)).toFixed(1) + ' dB');
const sig3 = v => String(+Number(v).toPrecision(3));

const FORMATTERS = {
  'source.sens': v => (v < 0.1 ? 'many' : v > 0.5 ? 'few' : v.toFixed(2)),
  'source.shift': v => `${v >= 0 ? '+' : '−'}${Math.abs(Math.round(v))} km/s`,
  'filter.width': v => (v >= 0.999 ? 'whole spectrum' : pct(v)),
  'vwin.height': v => (v >= 0.999 ? 'all values' : pct(v)),
  'grain.density': v => (0.2 * Math.pow(60, v)).toFixed(1) + ' per s',
  'grain.dur': fmtS,
  'grain.speed': v => (Math.abs(v) < 0.005 ? 'still' : (v < 0 ? 'down, ' : 'up, ') + 'drifting'),
  'map.f0': v => `${v.toFixed(1)} Hz · ${noteName(v)}`,
  'map.lo': fmtHz,
  'map.hi': fmtHz,
  'map.snap': v => (v < 0.01 ? 'free' : pct(v)),
  'event.rpm': v => v.toFixed(1) + ' per min',
  'event.chance': v => (v < 0.01 ? 'never' : pct(v)),
  'event.level': dB,
  'event.octave': v => `${v > 0 ? '+' : ''}${+v.toFixed(2)} oct`,
  'event.steps': v => String(Math.round(v)),
  'strip.fader': v => (v < 0.005 ? 'off' : (v * 66 - 60).toFixed(1) + ' dB'),
  'strip.pan': v => (Math.abs(v) < 0.005 ? 'center' : (v < 0 ? 'L ' : 'R ') + Math.round(Math.abs(v) * 100)),
  'master.gain': dB,
  'transport.bpm': v => Math.round(v) + ' BPM',
};
const PCT_KEYS = new Set(['filter.center', 'filter.soft', 'filter.level', 'vwin.center', 'vwin.soft', 'grain.size', 'grain.scatter',
  'grain.jitter', 'drone.bands', 'drone.comb', 'drone.noise', 'drone.anchor', 'drone.beat', 'event.jitter', 'strip.balance']);

/** Display string for a value of def. Unknown keys: 3 significant digits plus the def unit. */
export function formatParam(def, value, ctx = {}) {
  if (def.type === 'bool') return value ? 'on' : 'off';
  if (def.type === 'time') return value && value.mode === 'beats' ? value.div : value ? `${sig3(value.value)} ${value.mode === 'hz' ? 'Hz' : 's'}` : '';
  if (def.type !== 'num') return String(value);
  if (ctx.format) { const s = ctx.format(def, value); if (s != null) return s; }
  const f = FORMATTERS[def.key];
  if (f) return f(value);
  if (PCT_KEYS.has(def.key)) return pct(value);
  return sig3(value) + (def.unit ? ' ' + def.unit : '');
}

/** A def tapers logarithmically when it says `log: true` (non-schema sliders) or its key is in LOG_TAPER. */
const isLog = def => (def.log !== undefined ? def.log : LOG_TAPER.has(def.key));

/** Slider position 0..1000 for a value (log taper where LOG_TAPER lists the key). */
export function toSliderPos(def, v) {
  const t = isLog(def)
    ? Math.log(v / def.min) / Math.log(def.max / def.min)
    : (v - def.min) / (def.max - def.min);
  return SLIDER_STEPS * Math.min(1, Math.max(0, t));
}
export function fromSliderPos(def, s) {
  const t = Math.min(1, Math.max(0, s / SLIDER_STEPS));
  return isLog(def) ? def.min * Math.pow(def.max / def.min, t) : def.min + (def.max - def.min) * t;
}

const ENUM_LABELS = { 'vwin.mode': { 0: 'Off', 1: 'Reflectance', 2: 'Depth' } };

// ---- DOM ----------------------------------------------------------------------------------------

export function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else if (k === 'tip') { if (v != null && v !== '') e.dataset.tip = v; } else e.setAttribute(k, v);
  }
  for (const c of kids) e.append(c);
  return e;
}
const option = (v, t) => el('option', { value: String(v), text: t });
let uid = 0;

/**
 * Reusable time-value control (Synced division / Free Hz or seconds). getValue() returns the current TimeValue,
 * setValue(tv) writes a new one (may throw; the control then reverts to getValue()). opts: {label, tip}.
 * Appends to `host`; returns {el, refresh}. The caller calls refresh() when the value changes elsewhere.
 */
export function createTimeControl(host, getValue, setValue, opts = {}) {
  const label = opts.label || 'Time';
  const root = el('div', { class: 'inline timectl', tip: opts.tip });
  const seg = el('span', { class: 'seg', role: 'group', 'aria-label': label + ' mode' });
  const bS = el('button', { type: 'button', text: 'Synced' });
  const bF = el('button', { type: 'button', text: 'Free' });
  seg.append(bS, bF);
  const div = el('select', { 'aria-label': label + ' division' });
  for (const k of Object.keys(DIVISIONS)) div.append(option(k, k));
  const num = el('input', { type: 'number', min: '0', step: 'any', 'aria-label': label + ' value' });
  const unit = el('select', { 'aria-label': label + ' unit' });
  unit.append(option('hz', 'Hz'), option('sec', 's'));
  const freeBox = el('span', { class: 'inline' }, num, unit);
  root.append(el('span', { class: 'lbl', text: label }), seg, div, freeBox);
  const write = v => { try { setValue(v); } catch (e) { redraw(); } };
  const writeFree = () => {
    const value = +num.value;
    if (Number.isFinite(value) && value > 0) write({ mode: unit.value, value });
    else redraw(); // invalid: revert the field to the stored value
  };
  bS.addEventListener('click', () => write({ mode: 'beats', div: div.value }));
  bF.addEventListener('click', () => { const cur = getValue(); write({ mode: unit.value, value: cur.mode === 'beats' ? (+num.value > 0 ? +num.value : 1) : cur.value }); });
  div.addEventListener('change', () => write({ mode: 'beats', div: div.value }));
  num.addEventListener('change', writeFree);
  unit.addEventListener('change', writeFree);
  function redraw() {
    const v = getValue(), synced = v.mode === 'beats';
    bS.classList.toggle('on', synced); bF.classList.toggle('on', !synced);
    bS.setAttribute('aria-pressed', String(synced)); bF.setAttribute('aria-pressed', String(!synced));
    div.hidden = !synced; freeBox.hidden = synced;
    if (synced) div.value = Object.hasOwn(DIVISIONS, v.div) ? v.div : '1/4';
    else { unit.value = v.mode; num.value = String(v.value); }
  }
  host.append(root);
  redraw();
  return { el: root, refresh: redraw };
}

/**
 * Build the control for param `id` inside `host`. opts: {live?: () => resolvedValues|null, options?: () => [value,label][]
 * (id params), onRefresh?: (fn) => unsubscribe (id params: call fn to repopulate), label?: string, format?: (def,v)=>string|null}.
 * Returns {dispose, refresh, el}.
 */
export function bindParam(host, id, store, opts = {}) {
  const def = paramDef(id);
  if (!def) throw new Error(`Unknown parameter id: ${id}`);
  const uniq = `p${++uid}`;
  const label = opts.label || def.label;
  const cleanups = [];
  let root, redraw;

  if (def.type === 'num') {
    root = el('div', { class: 'row', tip: def.tip });
    const lab = el('label', { for: uniq, text: label });
    const out = el('output', { for: uniq });
    const inp = el('input', { id: uniq, type: 'range', min: 0, max: SLIDER_STEPS, step: 1 });
    const ghost = el('i', { class: 'ghost', hidden: '', 'aria-hidden': 'true' });
    root.append(lab, out, inp, ghost);
    inp.addEventListener('input', () => store.set(id, fromSliderPos(def, +inp.value)));
    redraw = () => {
      const v = store.get(id);
      inp.value = String(Math.round(toSliderPos(def, v)));
      out.textContent = formatParam(def, v, opts);
      inp.setAttribute('aria-valuetext', out.textContent);
      const live = def.modulatable && opts.live ? opts.live() : null;
      const lv = live ? live[id] : undefined;
      if (typeof lv === 'number' && Number.isFinite(lv) && Math.abs(lv - v) > (def.max - def.min) * 1e-3) {
        ghost.hidden = false;
        ghost.style.setProperty('--f', String(toSliderPos(def, lv) / SLIDER_STEPS));
      } else ghost.hidden = true;
    };
  } else if (def.type === 'bool') {
    root = el('div', { class: 'inline', tip: def.tip });
    const inp = el('input', { id: uniq, type: 'checkbox' });
    root.append(el('label', { for: uniq }, inp, label));
    inp.addEventListener('change', () => store.set(id, inp.checked));
    redraw = () => { inp.checked = Boolean(store.get(id)); };
  } else if (def.type === 'enum') {
    root = el('div', { class: 'inline', tip: def.tip });
    const sel = el('select', { id: uniq });
    const names = ENUM_LABELS[def.key] || {};
    for (const o of def.options) sel.append(option(o, names[o] ?? String(o)));
    root.append(el('label', { for: uniq, text: label }), sel);
    sel.addEventListener('change', () => store.set(id, def.options.find(o => String(o) === sel.value)));
    redraw = () => { sel.value = String(store.get(id)); };
  } else if (def.type === 'time') {
    const tc = createTimeControl(host, () => store.get(id), v => store.set(id, v), { label, tip: def.tip });
    root = tc.el;
    redraw = tc.refresh;
    cleanups.push(() => { /* element removed with root */ });
  } else if (def.type === 'id') {
    root = el('div', { class: 'inline', tip: def.tip });
    const sel = el('select', { id: uniq });
    root.append(el('label', { for: uniq, text: label }), sel);
    const fill = () => {
      const cur = store.get(id);
      sel.textContent = '';
      sel.append(option('none', 'None (silent)'));
      for (const [v, t] of opts.options ? opts.options() : []) sel.append(option(v, t));
      if (cur !== 'none' && !Array.from(sel.options).some(o => o.value === cur)) sel.append(option(cur, cur + ' (missing)'));
      sel.value = cur;
    };
    sel.addEventListener('change', () => store.set(id, sel.value));
    if (opts.onRefresh) { const off = opts.onRefresh(fill); if (typeof off === 'function') cleanups.push(off); }
    redraw = fill;
  } else {
    throw new Error(`${id}: unsupported param type ${def.type}`);
  }

  if (root.parentNode !== host) host.append(root);
  redraw();
  cleanups.push(onParams(store, [id], redraw));
  return {
    el: root,
    refresh: redraw,
    dispose() { for (const f of cleanups.splice(0)) f(); root.remove(); },
  };
}
