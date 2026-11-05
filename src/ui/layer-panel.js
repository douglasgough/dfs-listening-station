/*
 * Layer panel: chips, Open files, drag-and-drop, Examples, stage unit and the status line.
 * Browser module; builds into `host`. Returns {say, dispose, handleFiles}.
 */
import { UNITS } from '../spectrum/layers.js';
import { parseAny } from '../spectrum/parse.js';

export function createLayerPanel(host, app, { say: sayExt } = {}) {
  const $ = (tag, props = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) { if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else e.setAttribute(k, v); }
    e.append(...kids);
    return e;
  };
  const msg = $('div', { class: 'status', id: 'msg', role: 'status', 'aria-live': 'polite' });
  // Status line = last message + (live) warning for layers that cannot be placed; the warning vanishes by itself.
  let base = '';
  const warnText = () => (app.stage ? app.unplaced().map(l => `Layer ${l.name} cannot be placed on the ${app.stage.unit} axis`).join('. ') : '');
  const showMsg = () => { const w = warnText(); msg.textContent = [base, w].filter(Boolean).join(' \u00b7 '); };
  const say = t => { base = t; showMsg(); if (sayExt) sayExt(t); };

  const file = $('input', { type: 'file', multiple: '', id: 'fileInput', accept: '.csv,.tsv,.txt,.dat,.json,.tab,.lines,text/*' });
  const open = $('button', { type: 'button', class: 'btn', text: 'Open files' });
  open.addEventListener('click', () => file.click());
  const exSel = $('select', { id: 'selExamples', 'aria-label': 'Examples' });
  exSel.append($('option', { value: '', text: 'Examples…' }));
  app.examples.forEach((l, i) => exSel.append($('option', { value: String(i), text: l.name })));
  exSel.addEventListener('change', () => {
    const l = app.examples[+exSel.value];
    exSel.value = '';
    if (!l) return;
    try { say(tryAdd(l, 0)); } catch (e) { say(String(e && e.message || e)); }
  });
  const unitSel = $('select', { id: 'selUnit', 'aria-label': 'Stage unit' });
  UNITS.forEach(u => unitSel.append($('option', { value: u, text: u })));
  unitSel.addEventListener('change', () => app.setUnit(unitSel.value));
  const bar = $('div', { class: 'bar' }, open, file,
    $('label', {}, 'Examples', exSel), $('label', {}, 'Axis unit', unitSel));
  const chips = $('div', { class: 'files', id: 'chips' });
  host.append($('div', { class: 'layerpanel' }, bar, chips, msg));

  function tryAdd(layer, skipped) {
    const added = app.addLayer(layer);
    const n = added.kind === 'sampled' ? `${added.x.length} points` : `${added.lines.length} lines`;
    return `Loaded ${added.name} \u00b7 ${n}${skipped ? ` \u00b7 ${skipped} skipped` : ''}`;
  }

  async function handleFiles(files) {
    const parts = [];
    for (const f of files) {
      try {
        const text = await f.text();
        const res = parseAny(text, f.name.replace(/\.[^.]+$/, ''));
        parts.push(tryAdd(res.layer, res.skipped && res.skipped.count ? res.skipped.count : 0));
      } catch (e) { parts.push(`${f.name} failed: ${String(e && e.message || e)}`); }
    }
    if (parts.length) say(parts.join('; '));
  }
  file.addEventListener('change', () => { const fs = [...file.files]; file.value = ''; handleFiles(fs); });

  // drag and drop anywhere
  const veil = document.getElementById('dropveil');
  let depth = 0;
  const hasFiles = e => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
  const on = {
    dragenter: e => { if (hasFiles(e)) { e.preventDefault(); depth++; veil && veil.classList.add('on'); } },
    dragover: e => { if (hasFiles(e)) e.preventDefault(); },
    dragleave: e => { if (hasFiles(e) && --depth <= 0) { depth = 0; veil && veil.classList.remove('on'); } },
    drop: e => { if (!hasFiles(e)) return; e.preventDefault(); depth = 0; veil && veil.classList.remove('on'); handleFiles([...e.dataTransfer.files]); },
  };
  for (const [k, fn] of Object.entries(on)) window.addEventListener(k, fn);

  // Keyed chips: DOM nodes are kept for unchanged ids so keyboard focus survives re-renders.
  const nodes = new Map();
  function makeChip(l) {
    const c = $('div', { class: 'chip' });
    const name = $('span');
    const badge = $('span', { class: 'badge' });
    const vis = $('button', { type: 'button', class: 'vis' });
    vis.addEventListener('click', () => app.setVisible(l.id, !app.isVisible(l.id)));
    const x = $('button', { type: 'button', class: 'rm', text: '\u00d7' });
    x.addEventListener('click', () => {
      const ids = app.layers.map(q => q.id), i = ids.indexOf(l.id);
      const nextId = ids[i + 1] ?? ids[i - 1];
      app.removeLayer(l.id);
      say(`Removed ${l.name}`);
      const n = nodes.get(nextId);
      (n ? n.x : open).focus();
    });
    c.append(name, badge, vis, x);
    return { c, name, badge, vis, x };
  }
  function render() {
    const live = new Set(app.layers.map(l => l.id));
    for (const [id, n] of nodes) if (!live.has(id)) { n.c.remove(); nodes.delete(id); }
    const bad = app.unplaced();
    app.layers.forEach((l, i) => {
      let n = nodes.get(l.id);
      if (!n) { n = makeChip(l); nodes.set(l.id, n); }
      const vis = app.isVisible(l.id);
      n.c.className = 'chip' + (vis ? '' : ' hid') + (bad.includes(l) ? ' warn' : '');
      n.name.textContent = l.name; n.name.title = l.name;
      n.badge.textContent = `${l.axis.unit} \u00b7 ${l.kind === 'lines' ? 'lines' : 'sampled'}`;
      n.vis.setAttribute('aria-pressed', String(vis));
      n.vis.setAttribute('aria-label', `Toggle visibility of ${l.name}`);
      n.vis.textContent = vis ? '\u25cf' : '\u25cb';
      n.x.setAttribute('aria-label', `Remove ${l.name}`);
      if (chips.children[i] !== n.c) chips.insertBefore(n.c, chips.children[i] || null);
    });
    if (app.stage) unitSel.value = app.stage.unit;
    showMsg();
  }
  const off = app.subscribe(render);
  render();

  return {
    say, handleFiles,
    dispose() { off(); for (const [k, fn] of Object.entries(on)) window.removeEventListener(k, fn); },
  };
}
