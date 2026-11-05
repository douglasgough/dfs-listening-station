/*
 * Modulation matrix UI (Task 19). A grid VIEW of store.state.matrix: rows are destinations (grouped by owner,
 * collapsible), columns are sources (Global, then Ch1..Ch4). A cell shows the route amount (-100%..+100%);
 * empty cell = no route. Edits go through store.addRoute / store.removeRoute only; nothing is stored here.
 *
 * Cell gestures: click an empty cell = +50%; drag up/down = set amount (100 px = 100%); double-click/double-tap or
 * Delete/Backspace = clear; ArrowUp/ArrowDown = +/-5% (Shift 25%); Left/Right/PageUp/PageDown move focus.
 *
 * createMatrix(host, {store, app, onLearn?}) -> {refresh, dispose}
 *   onLearn(cb) -> cancel   (Task 20 supplies MIDI learn: cb(ccNumber) is called with the next control change)
 */
import { el } from './controls.js';
import { createSourceEditor } from './source-editor.js';
import { OWNERS, ownerLabel, destinationRows, sourceColumns, routeMap, amountFromDrag, formatAmount, keyStep, preset, PRESETS, sourceLabel } from './matrix-model.js';

const ownerColour = o => (o === 'g' ? 'var(--dim)' : `var(--${o})`);

export function createMatrix(host, { store, app, onLearn } = {}) {
  let filter = 'all', ccList = [], disposed = false, columnsKey = '';
  const collapsed = new Set();
  const cells = new Map(); // "src|dst" -> button
  const cleanups = [];
  let drag = null, learning = null, lastTap = null;

  // ---- static chrome ------------------------------------------------------------------------
  const root = el('div', { class: 'matrix' });
  const bar = el('div', { class: 'inline mxbar' });
  const selFilter = el('select', { 'aria-label': 'Show routes for' });
  for (const [v, t] of [['all', 'All channels'], ['g', 'Global'], ...OWNERS.slice(1).map(o => [o, ownerLabel(o)])]) selFilter.append(el('option', { value: v, text: t }));
  const selPreset = el('select', { 'aria-label': 'Preset' });
  for (const [v, t] of PRESETS) selPreset.append(el('option', { value: v, text: t }));
  const bPreset = el('button', { class: 'btn', type: 'button', text: 'Add preset', tip: 'Adds the chosen route set to the selected channel.' });
  const ccNum = el('input', { type: 'number', min: '0', max: '127', step: '1', value: '1', 'aria-label': 'MIDI CC number', style: 'width:64px' });
  const bCc = el('button', { class: 'btn', type: 'button', text: 'Add CC column', tip: 'A global source driven by a MIDI control-change number (0 to 127).' });
  const bLearn = el('button', { class: 'btn', type: 'button', text: 'Learn', tip: 'Wiggle a knob on your MIDI controller to pick its CC number.' });
  bLearn.disabled = typeof onLearn !== 'function';
  bar.append(el('label', {}, 'Show ', selFilter), el('span', { class: 'mxsep' }), selPreset, bPreset, el('span', { class: 'mxsep' }), ccNum, bCc, bLearn);
  const status = el('div', { class: 'status', role: 'status', 'aria-live': 'polite' });
  const gsrc = el('details', { class: 'mxsources' });
  gsrc.append(el('summary', { text: 'Global sources' }));
  const wrap = el('div', { class: 'mxwrap', tabindex: '-1' });
  root.append(bar, status, gsrc, wrap);
  host.append(root);

  const gEditors = [0, 1].map(i => createSourceEditor(gsrc, { store, owner: 'g', kind: 'lfo', index: i, label: `Global LFO ${i + 1}` }));
  cleanups.push(...gEditors.map(e => e.dispose));

  function say(t) { status.textContent = t; }
  const route = (src, dst) => store.state.matrix.find(r => r.src === src && r.dst === dst);
  function setAmount(src, dst, amount) {
    try {
      if (Math.abs(amount) < 0.005) store.removeRoute(src, dst);
      else store.addRoute({ src, dst, amount });
    } catch (e) { say(String(e && e.message || e)); }
  }
  const describe = (src, dst, a) => `${sourceLabel(src)} (${src}) → ${dst}: ${a ? formatAmount(a) : 'no route'}`;

  // ---- build (structure) ---------------------------------------------------------------------
  function build() {
    cells.clear(); wrap.textContent = '';
    const routes = store.state.matrix, cols = sourceColumns(filter, routes, ccList), rows = destinationRows(filter, collapsed);
    columnsKey = cols.map(c => c.id).join('|');
    const table = el('table', { class: 'mxgrid', role: 'grid', 'aria-label': 'Modulation matrix: destinations down, sources across' });
    const head1 = el('tr'), head2 = el('tr');
    head1.append(el('th', { class: 'mxcorner', rowspan: '2', scope: 'col', text: 'Destination' }));
    for (const o of OWNERS) {
      const n = cols.filter(c => c.owner === o).length;
      if (n) head1.append(el('th', { class: 'mxgroup', colspan: String(n), scope: 'colgroup', text: ownerLabel(o), style: `color:${ownerColour(o)}` }));
    }
    for (const c of cols) head2.append(el('th', { class: 'mxsrc', scope: 'col', text: c.label, title: c.id, style: `color:${ownerColour(c.owner)}` }));
    table.append(el('thead', {}, head1, head2));
    const body = el('tbody');
    const groups = filter === 'all' ? OWNERS : [filter];
    for (const o of groups) {
      const gr = el('tr', { class: 'mxgrow' });
      const th = el('th', { colspan: String(cols.length + 1), scope: 'rowgroup' });
      const tog = el('button', { type: 'button', class: 'mxtoggle', 'aria-expanded': String(!collapsed.has(o)), text: `${collapsed.has(o) ? '▸' : '▾'} ${ownerLabel(o)}`, style: `color:${ownerColour(o)}` });
      tog.addEventListener('click', () => { collapsed.has(o) ? collapsed.delete(o) : collapsed.add(o); build(); });
      th.append(tog); gr.append(th); body.append(gr);
      for (const d of rows.filter(r => r.owner === o)) {
        const tr = el('tr');
        tr.append(el('th', { class: 'mxdst', scope: 'row', text: d.label + (d.voiceRate ? ' · per voice' : ''), title: d.id }));
        for (const c of cols) {
          const b = el('button', { type: 'button', class: 'mxcell', 'data-src': c.id, 'data-dst': d.id });
          cells.set(`${c.id}|${d.id}`, b);
          tr.append(el('td', {}, b));
        }
        body.append(tr);
      }
    }
    table.append(body); wrap.append(table);
    updateCells();
  }

  // ---- cell state ------------------------------------------------------------------------------
  function paint(b, a) {
    const src = b.dataset.src, dst = b.dataset.dst;
    b.style.setProperty('--amt', String(Math.abs(a)));
    b.classList.toggle('on', a !== 0); b.classList.toggle('neg', a < 0);
    b.textContent = a ? formatAmount(a).replace('%', '') : '';
    b.setAttribute('aria-label', describe(src, dst, a));
    b.title = describe(src, dst, a);
  }
  function updateCells() {
    const m = routeMap(store.state.matrix);
    for (const [k, b] of cells) paint(b, m.get(k) || 0);
  }

  // ---- interaction -----------------------------------------------------------------------------
  function on(t, type, fn, o) { t.addEventListener(type, fn, o); cleanups.push(() => t.removeEventListener(type, fn, o)); }
  const cellOf = t => (t && t.closest ? t.closest('.mxcell') : null);
  on(wrap, 'pointerdown', ev => {
    const b = cellOf(ev.target); if (!b || drag) return;
    const r = route(b.dataset.src, b.dataset.dst);
    drag = { b, id: ev.pointerId, y: ev.clientY, start: r ? r.amount : 0, moved: false, had: !!r };
    try { b.setPointerCapture(ev.pointerId); } catch (e) { /* capture unavailable */ }
  });
  on(wrap, 'pointermove', ev => {
    if (!drag || ev.pointerId !== drag.id) return;
    const dy = ev.clientY - drag.y;
    if (!drag.moved && Math.abs(dy) < 4) return;
    drag.moved = true;
    setAmount(drag.b.dataset.src, drag.b.dataset.dst, amountFromDrag(drag.start, dy));
  });
  const end = ev => {
    if (!drag || (ev.pointerId !== undefined && ev.pointerId !== drag.id)) return;
    const d = drag; drag = null;
    if (!d.moved && ev.type === 'pointerup') {
      const now = performance.now();
      if (lastTap && lastTap.b === d.b && now - lastTap.t < 350) { lastTap = null; setAmount(d.b.dataset.src, d.b.dataset.dst, 0); } // double tap/click clears
      else { lastTap = { b: d.b, t: now }; if (!d.had) setAmount(d.b.dataset.src, d.b.dataset.dst, 0.5); }
      d.b.focus();
    } else lastTap = null;
    const r = route(d.b.dataset.src, d.b.dataset.dst);
    say(describe(d.b.dataset.src, d.b.dataset.dst, r ? r.amount : 0));
  };
  on(wrap, 'pointerup', end); on(wrap, 'pointercancel', end); on(wrap, 'lostpointercapture', end);
  on(wrap, 'keydown', ev => {
    const b = cellOf(ev.target); if (!b) return;
    const src = b.dataset.src, dst = b.dataset.dst, cur = (route(src, dst) || { amount: 0 }).amount;
    if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') { ev.preventDefault(); setAmount(src, dst, Math.min(1, Math.max(-1, Math.round((cur + keyStep(ev.key, ev.shiftKey)) * 100) / 100))); say(describe(src, dst, (route(src, dst) || { amount: 0 }).amount)); }
    else if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); setAmount(src, dst, 0); }
    else if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); setAmount(src, dst, cur ? 0 : 0.5); }
    else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') { ev.preventDefault(); const td = b.closest('td'), n = ev.key === 'ArrowLeft' ? td.previousElementSibling : td.nextElementSibling; n?.querySelector('.mxcell')?.focus(); }
    else if (ev.key === 'PageUp' || ev.key === 'PageDown') {
      ev.preventDefault();
      const tr = b.closest('tr'), idx = [...tr.children].indexOf(b.closest('td'));
      let n = ev.key === 'PageUp' ? tr.previousElementSibling : tr.nextElementSibling;
      while (n && !n.querySelector('.mxcell')) n = ev.key === 'PageUp' ? n.previousElementSibling : n.nextElementSibling;
      n?.children[idx]?.querySelector('.mxcell')?.focus();
    }
  });
  on(selFilter, 'change', () => { filter = selFilter.value; build(); });
  on(bPreset, 'click', () => {
    try {
      const p = preset(selPreset.value, app.selected);
      for (const m of p.mods) store.setMod(...m);
      for (const r of p.routes) store.addRoute(r);
      say(`Added "${selPreset.selectedOptions[0].textContent}" to channel ${app.selected + 1}.`);
    } catch (e) { say(String(e && e.message || e)); }
  });
  const addCc = n => {
    if (!Number.isInteger(n) || n < 0 || n > 127) { say('CC number must be a whole number from 0 to 127.'); return; }
    if (!ccList.includes(n)) ccList.push(n);
    build(); say(`Added source CC ${n}. Click a cell in its column to route it.`);
  };
  on(bCc, 'click', () => addCc(+ccNum.value));
  on(bLearn, 'click', () => {
    if (learning) { learning(); learning = null; bLearn.textContent = 'Learn'; return; }
    bLearn.textContent = 'Listening…';
    const cancel = onLearn(n => { learning = null; bLearn.textContent = 'Learn'; ccNum.value = String(n); addCc(n); });
    if (typeof cancel === 'function') learning = cancel;
    else { bLearn.textContent = 'Learn'; say('MIDI learn is not available yet: start listening and choose a MIDI input first.'); }
  });

  // ---- subscriptions -----------------------------------------------------------------------------
  const offStore = store.subscribe((id) => {
    if (disposed || id !== 'matrix') return;
    const key = sourceColumns(filter, store.state.matrix, ccList).map(c => c.id).join('|');
    if (key !== columnsKey) build(); else updateCells();
  });
  cleanups.push(offStore);

  build();
  return {
    refresh() { build(); },
    dispose() {
      disposed = true;
      if (learning) { learning(); learning = null; }
      for (const c of cleanups.splice(0)) c();
      root.remove();
    },
  };
}
