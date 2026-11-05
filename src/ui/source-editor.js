/*
 * Modulation source editor: one LFO or envelope of one owner ('g' | 'ch1'..'ch4').
 * Browser module (touches `document` only when called). All writes go through store.setMod; invalid input
 * is caught and shown in a small inline message. textContent only.
 *
 * createSourceEditor(host, {store, owner, kind, index, label}) -> {el, dispose, refresh}
 */
import { LFO_SHAPES } from '../core/state.js';
import { lfoValue } from '../core/modulation.js';
import { createTimeControl, fromSliderPos, toSliderPos, SLIDER_STEPS, fmtS } from './controls.js';

/** Matrix id of a source: ('ch1','lfo',0) -> 'ch1.lfo1'. */
export const sourceId = (owner, kind, index) => `${owner}.${kind}${index + 1}`;

// Envelope sliders: the prototype's ranges, log tapers for attack and decay, same formatting (ea/eh/ed).
const ENV_DEFS = {
  a: { key: 'env.a', label: 'Attack', min: 0.002, max: 3, log: true, fmt: fmtS, tip: 'Time for an event to rise to full level.' },
  h: { key: 'env.h', label: 'Hold', min: 0, max: 4, log: false, fmt: v => (v < 0.01 ? 'none' : fmtS(v)), tip: 'How long an event stays at full level before it decays.' },
  d: { key: 'env.d', label: 'Decay', min: 0.05, max: 10, log: true, fmt: fmtS, tip: 'Decay time constant. The event falls by about 63 percent in this time.' },
};
const SHAPE_NAMES = { sine: 'Sine', tri: 'Triangle', ramp: 'Ramp', square: 'Square', steps: 'Steps (random)', drift: 'Drift (smooth random)' };

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v;
    else if (k === 'tip') { if (v) e.dataset.tip = v; } else e.setAttribute(k, v);
  }
  e.append(...kids);
  return e;
}
let uid = 0;

export function createSourceEditor(host, { store, owner, kind, index, label }) {
  if (kind !== 'lfo' && kind !== 'env') throw new Error(`Unknown source kind: ${kind}`);
  const cur = () => store.state.mods[owner][kind][index];
  const uniq = `se${++uid}`;
  const cleanups = [];
  const name = label || (kind === 'lfo' ? `LFO ${index + 1}` : `Envelope ${index + 1}`);

  const root = el('div', { class: `srced ${kind}` });
  const head = el('div', { class: 'srchead' }, el('b', { text: name }),
    el('code', { class: 'srcid', text: sourceId(owner, kind, index), tip: 'This source appears under this name in the modulation matrix.' }));
  const preview = el('canvas', { class: 'srcprev', 'aria-label': `${name} shape preview`, role: 'img' });
  const msg = el('div', { class: 'srcmsg', role: 'alert' });
  root.append(head, preview);

  /** Run a store write; show the error inline instead of throwing into the event loop. */
  const write = patch => {
    try { store.setMod(owner, kind, index, patch); msg.textContent = ''; } catch (e) { msg.textContent = String(e && e.message || e); refresh(); }
  };
  const refreshers = [];

  if (kind === 'lfo') {
    const sel = el('select', { id: `${uniq}-shape` });
    for (const s of LFO_SHAPES) sel.append(el('option', { value: s, text: SHAPE_NAMES[s] || s }));
    sel.addEventListener('change', () => write({ shape: sel.value }));
    root.append(el('div', { class: 'inline', tip: 'Waveform of this LFO. Steps and Drift are random and follow the seed.' },
      el('label', { for: sel.id, text: 'Shape' }), sel));
    refreshers.push(() => { sel.value = cur().shape; });

    const tc = createTimeControl(root, () => cur().rate, v => write({ rate: v }), { label: 'Rate', tip: 'How fast the LFO runs: synced to the tempo or free.' });
    refreshers.push(tc.refresh);

    const ph = el('input', { id: `${uniq}-phase`, type: 'range', min: 0, max: 999, step: 1 });
    const phOut = el('output', { for: ph.id });
    root.append(el('div', { class: 'row', tip: 'Where in its cycle the LFO starts.' }, el('label', { for: ph.id, text: 'Phase' }), phOut, ph));
    ph.addEventListener('input', () => write({ phase: +ph.value / 1000 }));
    refreshers.push(() => { ph.value = String(Math.min(999, Math.round(cur().phase * 1000))); phOut.textContent = Math.round(cur().phase * 360) + '°'; ph.setAttribute('aria-valuetext', phOut.textContent); });

    const seed = el('input', { id: `${uniq}-seed`, type: 'number', step: '1' });
    const fresh = el('button', { type: 'button', class: 'btn small', text: 'New seed', tip: 'Pick a new random seed for Steps and Drift.' });
    seed.addEventListener('change', () => write({ seed: +seed.value }));
    fresh.addEventListener('click', () => write({ seed: Math.floor(Math.random() * 1000000) }));
    root.append(el('div', { class: 'inline', tip: 'Seed of the random shapes (Steps, Drift). The same seed gives the same sequence.' },
      el('label', { for: seed.id, text: 'Seed' }), seed, fresh));
    refreshers.push(() => { seed.value = String(cur().seed); });
  } else {
    for (const k of ['a', 'h', 'd']) {
      const def = ENV_DEFS[k];
      const inp = el('input', { id: `${uniq}-${k}`, type: 'range', min: 0, max: SLIDER_STEPS, step: 1 });
      const out = el('output', { for: inp.id });
      root.append(el('div', { class: 'row', tip: def.tip }, el('label', { for: inp.id, text: def.label }), out, inp));
      inp.addEventListener('input', () => write({ [k]: fromSliderPos(def, +inp.value) }));
      refreshers.push(() => {
        const v = cur()[k];
        inp.value = String(Math.round(toSliderPos(def, v)));
        out.textContent = def.fmt(v);
        inp.setAttribute('aria-valuetext', out.textContent);
      });
    }
  }
  root.append(msg);

  // ---- preview -----------------------------------------------------------------------------
  const css = (name, fb) => (typeof getComputedStyle === 'function' && getComputedStyle(root).getPropertyValue(name).trim()) || fb;
  function paint() {
    const w0 = preview.clientWidth, h0 = preview.clientHeight;
    if (!w0 || !h0) return; // collapsed (hidden details): redrawn when it gets a size
    const dpr = (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1;
    if (preview.width !== Math.round(w0 * dpr) || preview.height !== Math.round(h0 * dpr)) { preview.width = Math.round(w0 * dpr); preview.height = Math.round(h0 * dpr); }
    const g = preview.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w0, h0);
    const line = css('--line', '#252d3d'), accent = css('--c', css('--accent', '#94a6e8')), dim = css('--dim', '#8590a6');
    const m = cur(), pad = 6;
    g.lineWidth = 1; g.strokeStyle = line;
    g.beginPath();
    if (kind === 'lfo') {
      g.moveTo(pad, h0 / 2 + 0.5); g.lineTo(w0 - pad, h0 / 2 + 0.5);
    } else {
      g.moveTo(pad, h0 - pad + 0.5); g.lineTo(w0 - pad, h0 - pad + 0.5);
    }
    g.stroke();
    g.strokeStyle = accent; g.lineWidth = 1.5; g.beginPath();
    let caption = '';
    if (kind === 'lfo') {
      // one cycle; the random shapes show four cycles so the sequence is visible
      const cycles = m.shape === 'steps' || m.shape === 'drift' ? 4 : 1, N = 240;
      const unit = { ...m, rate: { mode: 'hz', value: 1 } };
      for (let i = 0; i <= N; i++) {
        const t = (i / N) * cycles - (m.shape === 'steps' && i === N ? 1e-9 : 0);
        const v = lfoValue(unit, { beat: 0, sec: t }, 120);
        const x = pad + (i / N) * (w0 - 2 * pad), y = h0 / 2 - v * (h0 / 2 - pad);
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      caption = cycles === 1 ? 'one cycle' : `${cycles} cycles`;
    } else {
      const T = m.a + m.h + 5 * m.d, X = t => pad + (t / T) * (w0 - 2 * pad), Y = v => h0 - pad - v * (h0 - 2 * pad - 8);
      g.moveTo(X(0), Y(0)); g.lineTo(X(m.a), Y(1)); g.lineTo(X(m.a + m.h), Y(1));
      for (let i = 1; i <= 60; i++) { const t = m.a + m.h + ((T - m.a - m.h) * i) / 60; g.lineTo(X(t), Y(Math.exp(-(t - m.a - m.h) / m.d))); }
      caption = T.toFixed(T < 10 ? 1 : 0) + ' s';
    }
    g.stroke();
    g.fillStyle = dim; g.font = '10px ui-monospace, Menlo, monospace'; g.textAlign = 'right'; g.fillText(caption, w0 - pad, 11);
  }

  function refresh() { for (const f of refreshers) f(); paint(); }

  host.append(root);
  refresh();
  cleanups.push(store.subscribe((id, v) => {
    if (id === 'mods' && v && v.owner === owner && v.kind === kind && v.index === index) refresh();
  }));
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => paint());
    ro.observe(preview);
    cleanups.push(() => ro.disconnect());
  }

  return {
    el: root,
    refresh,
    dispose() { for (const f of cleanups.splice(0)) f(); root.remove(); },
  };
}
