/*
 * Per-channel timeline editor (Task 18b). Mounted by channel-panel's mountTimeline hook.
 *
 * Events are keyframes {t, c,w,s,l,z,d,x,y,h,q}: `t` is a PHASE in [0,1) of the timeline length (a TimeValue),
 * the other keys are the channel's window values (see TL_KEYS). All edits go through store.setTimeline, which
 * validates and clamps. While an event is selected the playhead is held on it (app.setTimelineHold), so the
 * Driver plays that event's values while it is being edited.
 *
 * createTimelineEditor(host, {store, app, channel, getPlayhead?}) -> dispose
 *   getPlayhead(channel) -> phase in [0,1) | null  (Task 20 supplies the transport's phase)
 */
import { paramDef, pid } from '../core/schema.js';
import { TL_KEYS, timelineOverrides } from '../core/timeline.js';
import { el, createTimeControl, formatParam, toSliderPos, fromSliderPos, SLIDER_STEPS } from './controls.js';
import { tlRect, phaseToX, xToPhase, valueToY, yToValue, hitEvent, rulerTicks, newEventFrom, moveEvent, removeEvent, nudge } from './timeline-geom.js';

const NOTE_NONE = 'Click the timeline to add an event. With no events this channel follows its sliders and any matrix routes.';
const NOTE_EVENTS = 'The timeline values replace this channel\'s Center, Width, Softness, Level, Grain and Vertical window values; matrix routes add on top. While an event is selected the playhead is held on it.';

export function createTimelineEditor(host, { store, app, channel, getPlayhead } = {}) {
  const ch = channel;
  const tl = () => store.state.timelines[ch];
  let selected = -1, drag = null, pending = null, raf = 0, dirty = true, disposed = false, lastHead = null, sliding = false;
  const cleanups = [];

  // ---- DOM ---------------------------------------------------------------------------------
  const root = el('div', { class: 'tleditor', style: `--c: var(--ch${ch + 1})` });
  const note = el('p', { class: 'note' });
  const canvas = el('canvas', { class: 'tlcanvas', tabindex: '0', 'aria-label': `Timeline for channel ${ch + 1}. Click to add an event, drag to move it, arrow keys nudge, Delete removes, Escape lets go.` });
  const msg = el('div', { class: 'status', role: 'status', 'aria-live': 'polite' });
  const btns = el('div', { class: 'inline' });
  const bAdd = el('button', { class: 'btn', type: 'button', text: 'Add at playhead', tip: 'Add an event at the playhead, holding what this channel sounds like right now.' });
  const bDel = el('button', { class: 'btn', type: 'button', text: 'Delete event', tip: 'Delete the selected event.' });
  const bClr = el('button', { class: 'btn', type: 'button', text: 'Clear', tip: 'Remove every event from this channel\'s timeline.' });
  const modeSeg = el('span', { class: 'seg', role: 'group', 'aria-label': 'Transition between events' });
  const bMorph = el('button', { type: 'button', text: 'Morph', tip: 'Glide smoothly from each event to the next.' });
  const bJump = el('button', { type: 'button', text: 'Jump', tip: 'Switch instantly at each event and hold.' });
  modeSeg.append(bMorph, bJump);
  btns.append(bAdd, bDel, bClr, modeSeg);
  const lenHost = el('div', { class: 'inline' });
  const editor = el('div', { class: 'tlevent' });
  root.append(note, canvas, msg, btns, lenHost, editor);
  host.append(root);

  const lenCtl = createTimeControl(lenHost, () => tl().len, len => write({ len }), { label: 'Length', tip: 'Length of the timeline. It repeats. Synced lengths follow the tempo.' });

  // ---- store writes ------------------------------------------------------------------------
  function write(patch) {
    try { store.setTimeline(ch, patch); msg.textContent = ''; return true; } catch (e) { msg.textContent = String(e && e.message || e); return false; }
  }
  const events = () => tl().events;
  function flush() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (!pending) return;
    const p = pending; pending = null;
    if (write({ events: p.events })) { selected = p.index; setHold(); }
  }
  function schedule() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; flush(); }); }
  function setHold() { const e = events()[selected]; app.setTimelineHold(ch, e ? e.t : null); }
  function select(i) { selected = i; setHold(); dirty = true; buildEditor(); }

  const baseValues = () => { const o = {}; for (const [k, key] of TL_KEYS) o[k] = store.get(pid(ch, key)); return o; };
  function centreAt(phase) {
    const ov = timelineOverrides(tl(), { beat: 0, sec: 0 }, 120, { hold: phase });
    return ov && Number.isFinite(ov['filter.center']) ? ov['filter.center'] : store.get(pid(ch, 'filter.center'));
  }
  function addEvent(phase, centre) {
    const t = tl();
    const e = newEventFrom(t, phase, centre, baseValues());
    const list = [...t.events, e];
    if (!write({ events: list })) return -1;
    const now = events();
    const i = now.findIndex(x => x.t === e.t && x.c === e.c);
    select(i);
    return i;
  }

  // ---- drawing -----------------------------------------------------------------------------
  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
  function fit() {
    const dpr = window.devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return null;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    const g = canvas.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { g, w, h };
  }
  const bpm = () => store.get('g.transport.bpm');
  function paint() {
    dirty = false;
    const f = fit(); if (!f) return;
    const { g, w, h } = f, R = tlRect(w, h), colour = css(`--ch${ch + 1}`), dim = css('--dim'), line = css('--line'), fg = css('--fg'), panel = css('--panel');
    g.clearRect(0, 0, w, h);
    g.font = `10px ${css('--mono')}`; g.textBaseline = 'alphabetic'; g.textAlign = 'center';
    g.lineWidth = 1; g.strokeStyle = line; g.fillStyle = dim;
    for (const t of rulerTicks(tl().len, bpm(), R)) {
      const x = Math.round(phaseToX(t.phase, R)) + 0.5;
      g.beginPath(); g.moveTo(x, R.t); g.lineTo(x, R.b); g.stroke();
      g.fillText(t.label, x, R.t - 8);
    }
    const evs = events();
    if (!evs.length) { g.fillStyle = dim; g.fillText('Click to add an event', w / 2, R.t + R.h / 2); }
    else {
      const N = Math.max(8, Math.floor(R.w / 3)), pts = [];
      for (let k = 0; k <= N; k++) {
        const ph = (k / N) * 0.9999, ov = timelineOverrides(tl(), { beat: 0, sec: 0 }, 120, { hold: ph }) || {};
        pts.push({ c: ov['filter.center'], w: ov['filter.width'] });
      }
      const X = k => R.l + R.w * k / N, clamp01 = v => Math.min(1, Math.max(0, v));
      g.fillStyle = colour + '33'; g.beginPath();
      pts.forEach((p, k) => { const y = valueToY(clamp01((p.c ?? 0.5) + (p.w ?? 0) / 2), R); k ? g.lineTo(X(k), y) : g.moveTo(X(k), y); });
      for (let k = N; k >= 0; k--) g.lineTo(X(k), valueToY(clamp01((pts[k].c ?? 0.5) - (pts[k].w ?? 0) / 2), R));
      g.closePath(); g.fill();
      g.strokeStyle = colour; g.lineWidth = 1.5; g.beginPath();
      pts.forEach((p, k) => { const y = valueToY(clamp01(p.c ?? 0.5), R); k ? g.lineTo(X(k), y) : g.moveTo(X(k), y); });
      g.stroke();
      evs.forEach((e, i) => {
        if (!Number.isFinite(e.c)) return;
        g.beginPath(); g.arc(phaseToX(e.t, R), valueToY(e.c, R), i === selected ? 6 : 4.5, 0, Math.PI * 2);
        g.fillStyle = i === selected ? colour : panel; g.fill();
        g.lineWidth = 1.5; g.strokeStyle = colour; g.stroke();
      });
    }
    const held = events()[selected], head = held ? held.t : (typeof getPlayhead === 'function' ? getPlayhead(ch) : null);
    lastHead = head;
    if (Number.isFinite(head)) {
      const px = Math.round(phaseToX(head, R)) + 0.5;
      g.strokeStyle = fg; g.globalAlpha = 0.7; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(px, R.t); g.lineTo(px, R.b); g.stroke(); g.setLineDash([]); g.globalAlpha = 1;
    }
  }

  // ---- event editor (sliders for the selected event) ---------------------------------------
  function buildEditor() {
    editor.textContent = '';
    const e = events()[selected];
    if (!e) return;
    editor.append(el('div', { class: 'lbl', text: `Event ${selected + 1} at ${(e.t * 100).toFixed(1)}% of the timeline` }));
    for (const [k, key] of TL_KEYS) {
      const def = paramDef(pid(ch, key));
      if (!def || e[k] === undefined) continue;
      const id = `tle_${ch}_${k}`;
      const row = el('div', { class: 'row', tip: def.tip });
      const out = el('output', { for: id });
      const inp = el('input', { id, type: 'range', min: '0', max: String(SLIDER_STEPS), step: '1' });
      row.append(el('label', { for: id, text: def.label }), out, inp);
      const show = v => { out.textContent = formatParam(def, v); inp.setAttribute('aria-valuetext', out.textContent); };
      inp.value = String(toSliderPos(def, e[k])); show(e[k]);
      inp.addEventListener('input', () => {
        const v = fromSliderPos(def, +inp.value), list = events().map((x, i) => (i === selected ? { ...x, [k]: v } : x));
        sliding = true; // the store notification must not rebuild the slider being dragged
        try { if (write({ events: list })) show(events()[selected][k]); } finally { sliding = false; }
      });
      editor.append(row);
    }
  }

  function refresh() {
    if (disposed) return;
    if (selected >= events().length) { selected = -1; setHold(); }
    bMorph.classList.toggle('on', tl().mode === 'morph'); bJump.classList.toggle('on', tl().mode === 'jump');
    bMorph.setAttribute('aria-pressed', String(tl().mode === 'morph')); bJump.setAttribute('aria-pressed', String(tl().mode === 'jump'));
    bDel.disabled = selected < 0; bClr.disabled = !events().length;
    note.textContent = events().length ? NOTE_EVENTS : NOTE_NONE;
    lenCtl.refresh();
    if (!sliding) buildEditor();
    dirty = true;
  }

  // ---- interaction -------------------------------------------------------------------------
  const point = ev => { const b = canvas.getBoundingClientRect(); return { x: ev.clientX - b.left, y: ev.clientY - b.top, R: tlRect(canvas.clientWidth, canvas.clientHeight) }; };
  function on(target, type, fn, opts) { target.addEventListener(type, fn, opts); cleanups.push(() => target.removeEventListener(type, fn, opts)); }

  on(canvas, 'pointerdown', ev => {
    if (drag) return; // a second finger/pointer is ignored while a drag is active
    const p = point(ev), i = hitEvent(events(), p.x, p.y, p.R);
    try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* capture unavailable */ }
    if (i >= 0) { select(i); drag = { id: ev.pointerId, index: i }; return; }
    const at = addEvent(xToPhase(p.x, p.R), yToValue(p.y, p.R));
    if (at >= 0) drag = { id: ev.pointerId, index: at };
  });
  on(canvas, 'pointermove', ev => {
    const p = point(ev);
    if (!drag) { canvas.style.cursor = hitEvent(events(), p.x, p.y, p.R) >= 0 ? 'grab' : 'crosshair'; return; }
    if (ev.pointerId !== drag.id) return;
    const base = pending ? pending.events : events(), idx = pending ? pending.index : drag.index;
    const m = moveEvent(base, idx, xToPhase(p.x, p.R), yToValue(p.y, p.R));
    pending = m; selected = m.index; dirty = true; schedule();
  });
  const end = ev => {
    if (!drag || (ev && ev.pointerId !== undefined && ev.pointerId !== drag.id)) return;
    flush(); drag = null;
  };
  on(canvas, 'pointerup', end);
  on(canvas, 'pointercancel', end);
  on(canvas, 'lostpointercapture', end);
  on(canvas, 'keydown', ev => {
    const e = events()[selected];
    if (ev.key === 'Escape') { select(-1); refresh(); return; }
    if (!e) return;
    if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); removeSelected(); }
    else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
      ev.preventDefault();
      const m = moveEvent(events(), selected, nudge(e.t, ev.key, ev.shiftKey), e.c);
      if (write({ events: m.events })) { selected = m.index; setHold(); }
    }
  });
  function removeSelected() { if (selected < 0) return; const list = removeEvent(events(), selected); selected = -1; write({ events: list }); setHold(); refresh(); }

  on(bAdd, 'click', () => {
    const head = (typeof getPlayhead === 'function' ? getPlayhead(ch) : null);
    const ph = Number.isFinite(head) ? head : (Number.isFinite(app.timelineHold[ch]) ? app.timelineHold[ch] : 0);
    addEvent(Math.min(0.9999, Math.max(0, ph)), centreAt(ph));
  });
  on(bDel, 'click', removeSelected);
  on(bClr, 'click', () => { selected = -1; if (write({ events: [] })) app.setTimelineHold(ch, null); refresh(); });
  on(bMorph, 'click', () => write({ mode: 'morph' }));
  on(bJump, 'click', () => write({ mode: 'jump' }));

  // ---- subscriptions and the repaint loop ---------------------------------------------------
  const offStore = store.subscribe((id, v) => { if (id === 'timeline' && v && v.ch === ch) refresh(); else if (id === 'g.transport.bpm') dirty = true; });
  const offApp = app.subscribe(() => { dirty = true; });
  cleanups.push(offStore, offApp);
  let ro = null;
  if (typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(() => { dirty = true; }); ro.observe(canvas); cleanups.push(() => ro.disconnect()); }
  let loop = 0;
  const frame = () => {
    if (disposed) return;
    if (typeof getPlayhead === 'function' && !events()[selected]) { const h = getPlayhead(ch); if (h !== lastHead) dirty = true; }
    if (dirty) paint();
    loop = requestAnimationFrame(frame);
  };
  loop = requestAnimationFrame(frame);

  refresh();
  return function dispose() {
    disposed = true; flush(); cancelAnimationFrame(loop); if (raf) cancelAnimationFrame(raf);
    for (const c of cleanups.splice(0)) c();
    if (selected >= 0) app.setTimelineHold(ch, null);
    root.remove();
  };
}
