/*
 * Channel panel: tabs [1][2][3][4] and one panel body for the selected channel, built from collapsible sections.
 * Every slider/select/checkbox is generated from CHANNEL_PARAMS through bindParam; the only custom widgets are the
 * segmented controls, the event octave select, the steps number, the pattern step row and the map-link toggle.
 * Browser module (touches `document` only when called). textContent only.
 *
 * createChannelPanel(host, {store, app, getLive?, onTrigger?, mountTimeline?}) ->
 *   {refresh(), dispose(), setCurrentStep(i|-1, ch?), el}
 * - getLive(): resolved (modulated) values by param id, or null; drives the ghost markers.
 * - onTrigger(channelIndex): "Trigger now" (Task 20 wires it); the button is disabled without a handler.
 * - mountTimeline(slotEl, channelIndex) -> dispose|undefined: Task 18b fills <div data-slot="timeline"> here;
 *   called on every (re)build of the body and the returned disposer on teardown.
 */
import { NUM_CHANNELS, pid, paramDef } from '../core/schema.js';
import { PATTERN_STEPS } from '../core/state.js';
import { bindParam } from './controls.js';
import { onParams } from './store-bind.js';
import { createSourceEditor } from './source-editor.js';

const MAP_KEYS = ['map.f0', 'map.lo', 'map.hi', 'map.snap', 'map.curve', 'map.flip'];
const OCTAVES = [[-1, 'Octave below'], [0, 'Same'], [1, 'Octave above'], [2, 'Two octaves above']];
const GRAN_LABELS = { 'filter.center': 'Region center', 'filter.width': 'Region span', 'filter.soft': 'Grain softness' };
const WINDOW_LABELS = { 'filter.center': 'Center', 'filter.width': 'Width', 'filter.soft': 'Edge softness' };

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

export function createChannelPanel(host, { store, app, getLive, onTrigger, mountTimeline } = {}) {
  const openState = new Map(); // section id -> boolean, remembered across channels and rebuilds
  const isOpen = (id, dflt) => (openState.has(id) ? openState.get(id) : dflt);
  const currentStep = Array.from({ length: NUM_CHANNELS }, () => -1);
  let bodyCleanups = [];
  let shown = -1;
  let stepButtons = [];
  let disposed = false;

  const root = el('div', { class: 'chpanel' });
  const tablist = el('div', { class: 'chtabs', role: 'tablist', 'aria-label': 'Channels' });
  const body = el('div', { class: 'chbody ch-color', role: 'tabpanel' });
  root.append(tablist, body);
  host.append(root);

  // ---- tabs ----------------------------------------------------------------------------------
  const tabs = Array.from({ length: NUM_CHANNELS }, (_, i) => {
    const dot = el('span', { class: 'tabdot', 'aria-hidden': 'true' });
    const b = el('button', {
      type: 'button', role: 'tab', id: `chtab-${i}`, class: 'chtab ch-tab ch-color', 'data-ch': String(i), 'aria-label': `Channel ${i + 1}`,
      tip: `Show channel ${i + 1}. The dot is filled while its filter is on.`,
    }, dot, el('span', { text: String(i + 1) }));
    b.addEventListener('click', () => app.select(i));
    b.addEventListener('keydown', e => {
      const k = e.key;
      const to = k === 'ArrowRight' || k === 'ArrowDown' ? (i + 1) % NUM_CHANNELS
        : k === 'ArrowLeft' || k === 'ArrowUp' ? (i + NUM_CHANNELS - 1) % NUM_CHANNELS
          : k === 'Home' ? 0 : k === 'End' ? NUM_CHANNELS - 1 : -1;
      if (to < 0) return;
      e.preventDefault();
      app.select(to);
      tabs[to].focus();
    });
    tablist.append(b);
    return b;
  });
  function syncTabs() {
    tabs.forEach((b, i) => {
      const on = i === app.selected, en = Boolean(store.get(pid(i, 'filter.on')));
      b.classList.toggle('on', on);
      b.classList.toggle('en', en);
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      b.setAttribute('aria-label', `Channel ${i + 1}${en ? ', on' : ', off'}`);
    });
  }

  // ---- map link (UI only) --------------------------------------------------------------------
  function syncLinks() {
    for (let c = 1; c < NUM_CHANNELS; c++) {
      if (!app.mapLinked[c]) continue;
      for (const k of MAP_KEYS) {
        const v = store.get(pid(0, k));
        if (store.get(pid(c, k)) !== v) store.set(pid(c, k), v);
      }
    }
  }
  const unsubLink = store.subscribe(id => { if (typeof id === 'string' && id.startsWith('ch1.map.')) syncLinks(); });
  const unsubTabs = onParams(store, id => typeof id === 'string' && id.endsWith('.filter.on'), () => { syncTabs(); syncOff(); });

  // ---- body ----------------------------------------------------------------------------------
  let hint, syncOff = () => {}, linkSync = () => {};

  function section(parent, id, title, sub, dflt, tip) {
    const d = el('details', { class: `sec sec-${id}`, 'data-sec': id });
    d.open = isOpen(id, dflt);
    d.addEventListener('toggle', () => openState.set(id, d.open));
    d.append(el('summary', { tip }, el('h3', {}, title, sub ? el('small', { text: sub }) : '')));
    const inner = el('div', { class: 'secbody' });
    d.append(inner);
    parent.append(d);
    return inner;
  }

  function segmented(parent, ch, key, items, aria) {
    const id = pid(ch, key), def = paramDef(id);
    const wrap = el('div', { class: 'inline', tip: def.tip });
    const seg = el('span', { class: 'seg', role: 'group', 'aria-label': aria });
    const btns = items.map(([value, text]) => {
      const b = el('button', { type: 'button', text, 'aria-pressed': 'false' });
      b.addEventListener('click', () => store.set(id, value));
      seg.append(b);
      return [value, b];
    });
    wrap.append(seg);
    parent.append(wrap);
    const redraw = () => {
      const cur = store.get(id);
      for (const [v, b] of btns) { b.classList.toggle('on', v === cur); b.setAttribute('aria-pressed', String(v === cur)); }
    };
    redraw();
    bodyCleanups.push(onParams(store, [id], redraw));
  }

  function build(ch) {
    for (const f of bodyCleanups.splice(0)) f();
    body.textContent = '';
    stepButtons = [];
    shown = ch;
    body.dataset.ch = String(ch);
    body.setAttribute('aria-labelledby', `chtab-${ch}`);
    const P = key => pid(ch, key);
    const bind = (parent, key, opts = {}) => {
      const c = bindParam(parent, P(key), store, { live: getLive, ...opts });
      bodyCleanups.push(c.dispose);
      return c;
    };
    const showWhen = (node, ids, pred) => {
      const f = () => { node.hidden = !pred(); };
      f();
      bodyCleanups.push(onParams(store, ids, f));
    };

    hint = el('p', { class: 'chhint', role: 'status', text: `Channel ${ch + 1} is off — enable it in Filter. You can still edit it.` });
    const cols = el('div', { class: 'chcols' });
    const colA = el('div', { class: 'chcol' }), colB = el('div', { class: 'chcol' });
    cols.append(colA, colB);
    const wide = el('div', { class: 'chwide' });
    body.append(hint, cols, wide);
    syncOff = () => {
      const off = !store.get(P('filter.on'));
      body.classList.toggle('off', off);
      hint.hidden = !off;
    };
    syncOff();

    // Source
    {
      const s = section(colA, 'source', 'Source', 'what this channel listens to', true, 'Which spectrum this channel hears and which features of it become voices.');
      bind(s, 'source.layer', {
        options: () => app.layers.map(l => [l.id, l.name]),
        onRefresh: fn => app.subscribe(() => fn()),
      });
      bind(s, 'source.polarity');
      bind(s, 'source.sens');
      bind(s, 'source.mode');
      bind(s, 'source.shift');
    }

    // Filter (window / granular, vertical window, grains)
    {
      const s = section(colA, 'filter', 'Filter', 'bandpass window', true, 'The window that selects part of the spectrum. Enabled filters are added together.');
      bind(s, 'filter.on');
      segmented(s, ch, 'filter.type', [['window', 'Window'], ['granular', 'Granular']], 'Filter type');
      const labelled = {};
      for (const key of ['filter.center', 'filter.width', 'filter.soft']) labelled[key] = bind(s, key).el.querySelector('label');
      bind(s, 'filter.level');
      const relabel = () => {
        const g = store.get(P('filter.type')) === 'granular';
        for (const [key, lab] of Object.entries(labelled)) lab.textContent = (g ? GRAN_LABELS : WINDOW_LABELS)[key];
      };
      relabel();
      bodyCleanups.push(onParams(store, [P('filter.type')], relabel));

      s.append(el('h4', { class: 'subh', text: 'Vertical window' }));
      segmented(s, ch, 'vwin.mode', [[0, 'Off'], [1, 'Reflectance'], [2, 'Depth']], 'Vertical window');
      const vert = el('div', { class: 'grp' });
      s.append(vert);
      for (const k of ['vwin.center', 'vwin.height', 'vwin.soft']) bind(vert, k);
      showWhen(vert, [P('vwin.mode')], () => store.get(P('vwin.mode')) !== 0);

      const gran = el('div', { class: 'grp' }, el('h4', { class: 'subh', text: 'Grains' }));
      s.append(gran);
      for (const k of ['grain.size', 'grain.density', 'grain.scatter', 'grain.speed', 'grain.dur', 'grain.jitter']) bind(gran, k);
      showWhen(gran, [P('filter.type')], () => store.get(P('filter.type')) === 'granular');
    }

    // Mapping
    {
      const s = section(colA, 'mapping', 'Mapping', 'spectrum to pitch', true, 'How positions along the spectrum become pitches.');
      let fs = s;
      if (ch > 0) {
        const id = `lk${++uid}`;
        const cb = el('input', { type: 'checkbox', id });
        const row = el('div', { class: 'inline', tip: 'Make this channel use channel 1\'s mapping. Changing channel 1\'s mapping then changes this one too.' },
          el('label', { for: id }, cb, 'Link to channel 1'));
        s.append(row);
        fs = el('fieldset', { class: 'maplink' });
        s.append(fs);
        cb.addEventListener('change', () => { app.setMapLinked(ch, cb.checked); syncLinks(); });
        linkSync = () => { cb.checked = app.mapLinked[ch]; fs.disabled = app.mapLinked[ch]; };
        linkSync();
      } else linkSync = () => {};
      bind(fs, 'map.f0'); bind(fs, 'map.lo'); bind(fs, 'map.hi'); bind(fs, 'map.snap');
      bind(fs, 'map.curve'); bind(fs, 'map.flip');
    }

    // Drone
    {
      const s = section(colB, 'drone', 'Drone', 'the sustained voices', true, 'Levels of the sustained sounds built from the spectrum.');
      for (const k of ['drone.bands', 'drone.comb', 'drone.combSrc', 'drone.noise', 'drone.anchor', 'drone.beat']) bind(s, k);
    }

    // Events
    {
      const s = section(colB, 'events', 'Events', 'pings over the drone', true, 'Short notes triggered over the drone.');
      const head = el('div', { class: 'inline' });
      s.append(head);
      segmented(head, ch, 'event.mode', [['random', 'Random'], ['regular', 'Regular'], ['pattern', 'Pattern']], 'Event timing');
      const trig = el('button', { type: 'button', class: 'btn small', text: 'Trigger now', tip: 'Play one event now, to audition the envelope and pitch.' });
      if (typeof onTrigger === 'function') trig.addEventListener('click', () => onTrigger(ch)); else trig.disabled = true;
      head.append(trig);
      bind(s, 'event.chance');
      bind(s, 'event.level');
      // pitch: the prototype's four choices over the schema range
      {
        const id = P('event.octave'), uq = `oct${++uid}`;
        const sel = el('select', { id: uq });
        const row = el('div', { class: 'inline', tip: paramDef(id).tip }, el('label', { for: uq, text: 'Pitch' }), sel);
        for (const [v, t] of OCTAVES) sel.append(el('option', { value: String(v), text: t }));
        sel.addEventListener('change', () => store.set(id, +sel.value));
        const redraw = () => {
          const v = store.get(id);
          for (const o of [...sel.options]) if (o.dataset.custom) o.remove();
          if (!OCTAVES.some(([x]) => x === v)) { const o = el('option', { value: String(v), text: `${v > 0 ? '+' : ''}${+v.toFixed(2)} octaves` }); o.dataset.custom = '1'; sel.append(o); }
          sel.value = String(v);
        };
        redraw();
        s.append(row);
        bodyCleanups.push(onParams(store, [id], redraw));
      }
      const gRandom = el('div', { class: 'grp' }), gRegular = el('div', { class: 'grp' }), gPattern = el('div', { class: 'grp' });
      s.append(gRandom, gRegular, gPattern);
      bind(gRandom, 'event.rpm');
      bind(gRegular, 'event.interval'); bind(gRegular, 'event.jitter');
      // steps number
      {
        const id = P('event.steps'), uq = `stp${++uid}`;
        const num = el('input', { id: uq, type: 'number', min: '2', max: String(PATTERN_STEPS), step: '1' });
        gPattern.append(el('div', { class: 'inline', tip: paramDef(id).tip }, el('label', { for: uq, text: 'Steps' }), num));
        num.addEventListener('change', () => {
          const n = Math.round(+num.value);
          if (Number.isFinite(n)) store.set(id, n);
          num.value = String(Math.round(store.get(id)));
        });
        const redraw = () => { num.value = String(Math.round(store.get(id))); };
        redraw();
        bodyCleanups.push(onParams(store, [id], redraw));
      }
      bind(gPattern, 'event.stepLen');
      const stepsRow = el('div', { class: 'steps', role: 'group', 'aria-label': 'Pattern steps', tip: 'Click steps to switch them on or off. The pattern repeats.' });
      gPattern.append(stepsRow);
      for (let i = 0; i < PATTERN_STEPS; i++) {
        const b = el('button', { type: 'button', 'aria-label': `Step ${i + 1}`, 'aria-pressed': 'false' });
        b.addEventListener('click', () => { try { store.setPatternStep(ch, i, !store.state.pattern[ch][i]); } catch (e) { /* out of range cannot happen */ } });
        stepsRow.append(b);
        stepButtons.push(b);
      }
      const stepsRedraw = () => {
        const n = Math.round(store.get(P('event.steps')));
        stepButtons.forEach((b, i) => {
          const on = Boolean(store.state.pattern[ch][i]);
          b.classList.toggle('on', on);
          b.setAttribute('aria-pressed', String(on));
          b.hidden = i >= n;
          b.classList.toggle('now', i === currentStep[ch]);
        });
      };
      stepsRedraw();
      bodyCleanups.push(store.subscribe((id, v) => {
        if (id === P('event.steps') || (id === 'pattern' && v && v.ch === ch)) stepsRedraw();
      }));
      const modeSync = () => {
        const m = store.get(P('event.mode'));
        gRandom.hidden = m !== 'random'; gRegular.hidden = m !== 'regular'; gPattern.hidden = m !== 'pattern';
      };
      modeSync();
      bodyCleanups.push(onParams(store, [P('event.mode')], modeSync));
    }

    // Modulators
    {
      const s = section(colB, 'mods', 'Modulators', 'two LFOs and two envelopes', false, 'LFOs and envelopes of this channel. Route them to controls in the modulation matrix.');
      const owner = `ch${ch + 1}`;
      for (const [kind, n] of [['lfo', 0], ['lfo', 1], ['env', 0], ['env', 1]]) {
        const name = kind === 'lfo' ? `LFO ${n + 1}` : `Envelope ${n + 1}`;
        const key = `mod-${kind}${n}`;
        const d = el('details', { class: 'subsec' });
        d.open = isOpen(key, false);
        d.addEventListener('toggle', () => { openState.set(key, d.open); if (d.open) ed.refresh(); });
        d.append(el('summary', { text: name }));
        s.append(d);
        const inner = el('div', {});
        d.append(inner);
        const ed = createSourceEditor(inner, { store, owner, kind, index: n, label: name });
        bodyCleanups.push(ed.dispose);
      }
    }

    // Timeline (Task 18b fills the slot)
    {
      const s = section(wide, 'timeline', 'Timeline', 'keyframes for the window', true, 'Events that move this channel\'s window over time.');
      const slot = el('div', { 'data-slot': 'timeline' }); // Task 18b: timeline editor mounts here
      s.append(slot);
      if (typeof mountTimeline === 'function') {
        const off = mountTimeline(slot, ch);
        if (typeof off === 'function') bodyCleanups.push(off);
      }
    }
    linkSync();
  }

  // ---- sync with the app ---------------------------------------------------------------------
  function sync() {
    if (disposed) return;
    syncTabs();
    if (app.selected !== shown) build(app.selected);
    else linkSync();
    syncLinks();
  }
  const unsubApp = app.subscribe(sync);
  syncTabs();
  build(app.selected);
  syncLinks();

  return {
    el: root,
    refresh() { sync(); },
    /** Highlight step i (or -1 for none) of channel ch (default: the selected one). Task 20 drives this. */
    setCurrentStep(i, ch = app.selected) {
      if (!Number.isInteger(ch) || ch < 0 || ch >= NUM_CHANNELS) return;
      currentStep[ch] = Number.isInteger(i) ? i : -1;
      if (ch === shown) stepButtons.forEach((b, k) => b.classList.toggle('now', k === currentStep[ch]));
    },
    dispose() {
      disposed = true;
      unsubApp(); unsubLink(); unsubTabs();
      for (const f of bodyCleanups.splice(0)) f();
      root.remove();
    },
  };
}
