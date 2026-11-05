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
  const say = t => { msg.textContent = t; if (sayExt) sayExt(t); };

  const file = $('input', { type: 'file', multiple: '', id: 'fileInput', accept: '.csv,.tsv,.txt,.dat,.json,.tab,.lines,text/*' });
  const open = $('button', { type: 'button', class: 'btn', text: 'Open files' });
  open.addEventListener('click', () => file.click());
  const exSel = $('select', { id: 'selExamples', 'aria-label': 'Examples' });
  exSel.append($('option', { value: '', text: 'Examples…' }));
  app.examples.forEach((l, i) => exSel.append($('option', { value: String(i), text: l.name })));
  exSel.addEventListener('change', () => {
    const l = app.examples[+exSel.value];
    exSel.value = '';
    if (l) addAndReport(l, null);
  });
  const unitSel = $('select', { id: 'selUnit', 'aria-label': 'Stage unit' });
  UNITS.forEach(u => unitSel.append($('option', { value: u, text: u })));
  unitSel.addEventListener('change', () => { app.setUnit(unitSel.value); warnUnplaced(); });
  const bar = $('div', { class: 'bar' }, open, file,
    $('label', {}, 'Examples', exSel), $('label', {}, 'Axis unit', unitSel));
  const chips = $('div', { class: 'files', id: 'chips' });
  host.append($('div', { class: 'layerpanel' }, bar, chips, msg));

  function warnUnplaced() {
    const bad = app.unplaced();
    if (bad.length) say(bad.map(l => `Layer ${l.name} cannot be placed on the ${app.stage.unit} axis`).join('. '));
  }

  function addAndReport(layer, skipped) {
    try {
      const added = app.addLayer(layer);
      const n = added.kind === 'sampled' ? `${added.x.length} points` : `${added.lines.length} lines`;
      say(`Loaded ${added.name} · ${n}${skipped ? ` · ${skipped} skipped` : ''}`);
      warnUnplaced();
    } catch (e) { say(String(e && e.message || e)); }
  }

  async function handleFiles(files) {
    for (const f of files) {
      try {
        const text = await f.text();
        const res = parseAny(text, f.name.replace(/\.[^.]+$/, ''));
        const skipped = res.skipped && res.skipped.count ? res.skipped.count : 0;
        addAndReport(res.layer, skipped);
      } catch (e) { say(`${f.name}: ${String(e && e.message || e)}`); }
    }
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

  function render() {
    chips.textContent = '';
    for (const l of app.layers) {
      const placed = !app.unplaced().includes(l);
      const c = $('div', { class: 'chip' + (app.isVisible(l.id) ? '' : ' hid') + (placed ? '' : ' warn') });
      c.append($('span', { text: l.name, title: l.name }), $('span', { class: 'badge', text: `${l.axis.unit} · ${l.kind === 'lines' ? 'lines' : 'sampled'}` }));
      const vis = $('button', { type: 'button', class: 'vis', 'aria-pressed': String(app.isVisible(l.id)), 'aria-label': `Toggle visibility of ${l.name}`, text: app.isVisible(l.id) ? '●' : '○' });
      vis.addEventListener('click', () => app.setVisible(l.id, !app.isVisible(l.id)));
      const x = $('button', { type: 'button', 'aria-label': `Remove ${l.name}`, text: '×' });
      x.addEventListener('click', () => { app.removeLayer(l.id); say(`Removed ${l.name}`); });
      c.append(vis, x);
      chips.append(c);
    }
    if (app.stage) unitSel.value = app.stage.unit;
  }
  const off = app.subscribe(render);
  render();

  return {
    say, handleFiles,
    dispose() { off(); for (const [k, fn] of Object.entries(on)) window.removeEventListener(k, fn); },
  };
}
