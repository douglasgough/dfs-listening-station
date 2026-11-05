/*
 * App model: loaded layers, the stage axis/zoom, the selected channel and the analysis cache.
 * Pure logic (no DOM). The store holds only layer ids (store.state.layers) and each channel's `source.layer`.
 *
 * Choices:
 * - A channel whose `source.layer` is '' or 'none' is "unassigned" and gets every newly added layer id.
 * - 'none' (the schema default for source.layer) counts as empty, exactly like '', for auto-assign.
 * - removeLayer: channels that used the removed layer move to the FIRST REMAINING layer (silent if none).
 * - `stage` is the CURRENT view {unit,x0,x1} (the zoomed range, what analysis uses); `fullRange` is the unzoomed range.
 */
import { NUM_CHANNELS, pid } from '../core/schema.js';
import { isWellFormedLayer, layerOnStage, convertPosition } from '../spectrum/layers.js';
import { createAnalysisCache } from '../spectrum/analyse.js';

const EMPTY = v => v === '' || v == null || v === 'none';

export function createAppState({ store, examples = [] } = {}) {
  const layers = [];
  const hidden = new Set();
  const subs = new Set();
  const cache = createAnalysisCache();
  const app = {
    layers,
    examples,
    stage: null,
    fullRange: null,
    zoomStack: [],
    selected: 0,
    version: 0,
    /** UI-only: channel i's map.* follows channel 1's (never part of the patch). */
    mapLinked: Array.from({ length: NUM_CHANNELS }, () => false),
    /** UI-only: phase a channel's timeline playhead is held at while an event is edited (null = plays normally). */
    timelineHold: Array.from({ length: NUM_CHANNELS }, () => null),
  };

  const bump = () => { app.version++; for (const fn of [...subs]) fn(app); };
  const chLayerId = c => pid(c, 'source.layer');
  const setStageFrom = layer => {
    const a = layer.axis;
    app.stage = { unit: a.unit, x0: a.x0, x1: a.x1 };
    app.fullRange = { x0: a.x0, x1: a.x1 };
    app.zoomStack = [];
  };

  app.subscribe = fn => { subs.add(fn); return () => { subs.delete(fn); }; };
  app.layerById = id => layers.find(l => l.id === id) || null;

  app.addLayer = layer => {
    if (!isWellFormedLayer(layer)) throw new Error(`Layer ${layer && layer.name ? `"${layer.name}" ` : ''}is not a well-formed spectrum layer`);
    const base = String(layer.id || 'layer');
    let id = base;
    for (let n = 2; layers.some(l => l.id === id); n++) id = `${base}-${n}`;
    const added = id === layer.id ? layer : { ...layer, id };
    layers.push(added);
    cache.clear();
    if (!app.stage) setStageFrom(added);
    store.state.layers.push(id);
    for (let c = 0; c < NUM_CHANNELS; c++) if (EMPTY(store.get(chLayerId(c)))) store.set(chLayerId(c), id);
    bump();
    return added;
  };

  app.removeLayer = id => {
    const i = layers.findIndex(l => l.id === id);
    if (i < 0) return false;
    layers.splice(i, 1);
    hidden.delete(id);
    cache.clear();
    store.state.layers = store.state.layers.filter(x => x !== id);
    const fallback = layers.length ? layers[0].id : 'none';
    for (let c = 0; c < NUM_CHANNELS; c++) if (store.get(chLayerId(c)) === id) store.set(chLayerId(c), fallback);
    if (i === 0 && layers.length) setStageFrom(layers[0]);
    else if (!layers.length) { app.stage = null; app.fullRange = null; app.zoomStack = []; }
    bump();
    return true;
  };

  /** Replace every layer (patch load): clears all, then adds the given layer objects in order. Zoom resets. */
  app.replaceLayers = list => {
    for (const l of [...layers]) app.removeLayer(l.id);
    app.stage = null; app.fullRange = null; app.zoomStack = [];
    for (const l of list || []) app.addLayer(l);
    for (let i = 1; i < NUM_CHANNELS; i++) if (app.mapLinked[i]) app.mapLinked[i] = false;
    app.selected = 0;
    bump();
  };

  app.setVisible = (id, on) => { if (on) hidden.delete(id); else hidden.add(id); bump(); };
  app.isVisible = id => !hidden.has(id);

  /** Layers that cannot be placed on the current stage axis. */
  app.unplaced = () => (app.stage ? layers.filter(l => !layerOnStage(l, app.stage)) : []);

  app.setStage = axis => {
    if (!axis || !(axis.x1 > axis.x0)) throw new Error('Stage axis needs x1 > x0');
    app.stage = { unit: axis.unit, x0: axis.x0, x1: axis.x1 };
    app.fullRange = { x0: axis.x0, x1: axis.x1 };
    app.zoomStack = [];
    cache.clear();
    bump();
  };

  /** Change the stage unit, converting the full range (else the layers' ranges) into it. */
  app.setUnit = unit => {
    if (!app.stage || app.stage.unit === unit) return;
    const from = app.stage.unit;
    const conv = (a, b, u0) => {
      const p = convertPosition(a, u0, unit), q = convertPosition(b, u0, unit);
      return p !== null && q !== null && p !== q ? { x0: Math.min(p, q), x1: Math.max(p, q) } : null;
    };
    let r = from === unit ? app.fullRange : conv(app.fullRange.x0, app.fullRange.x1, from);
    if (!r) {
      for (const l of layers) {
        const c = conv(l.axis.x0, l.axis.x1, l.axis.unit);
        if (c) { r = c; break; }
      }
    }
    if (!r) r = app.fullRange;
    app.setStage({ unit, ...r });
  };

  app.zoomTo = (x0, x1) => {
    if (!app.stage || !(x1 > x0)) return;
    const f = app.fullRange;
    const a = Math.max(f.x0, x0), b = Math.min(f.x1, x1);
    if (!(b > a)) return;
    app.zoomStack.push({ x0: app.stage.x0, x1: app.stage.x1 });
    app.stage = { unit: app.stage.unit, x0: a, x1: b };
    bump();
  };
  app.canZoomOut = () => app.zoomStack.length > 0;
  app.zoomOut = () => {
    if (!app.zoomStack.length) return false;
    const r = app.zoomStack.pop();
    app.stage = { unit: app.stage.unit, x0: r.x0, x1: r.x1 };
    bump();
    return true;
  };

  app.select = i => {
    if (!Number.isInteger(i) || i < 0 || i >= NUM_CHANNELS || i === app.selected) return;
    app.selected = i;
    bump();
  };

  app.setMapLinked = (i, on) => {
    if (!Number.isInteger(i) || i < 1 || i >= NUM_CHANNELS) throw new Error(`Channel ${i} cannot be linked to channel 1`);
    const v = Boolean(on);
    if (app.mapLinked[i] === v) return;
    app.mapLinked[i] = v;
    bump();
  };

  app.setTimelineHold = (ch, phase) => {
    if (!Number.isInteger(ch) || ch < 0 || ch >= NUM_CHANNELS) throw new Error(`Bad channel for timeline hold: ${String(ch)}`);
    if (phase !== null && !(typeof phase === 'number' && phase >= 0 && phase < 1)) throw new Error('Timeline hold must be null or a phase in [0, 1)');
    if (app.timelineHold[ch] === phase) return;
    app.timelineHold[ch] = phase;
    bump();
  };
  // A timeline with no events has nothing to hold on.
  store.subscribe((id, v) => {
    if (id === 'timeline' && v && app.timelineHold[v.ch] !== null && !store.state.timelines[v.ch].events.length) app.setTimelineHold(v.ch, null);
  });

  app.analysisFor = c => {
    if (!app.stage) return null;
    const layer = app.layerById(store.get(chLayerId(c)));
    if (!layer) return null;
    return cache.get(layer, app.stage, {
      polarity: store.get(pid(c, 'source.polarity')),
      sens: store.get(pid(c, 'source.sens')),
      mode: store.get(pid(c, 'source.mode')),
    });
  };
  app.getAnalyses = () => Array.from({ length: NUM_CHANNELS }, (_, c) => app.analysisFor(c));
  app.getStage = () => app.stage;

  return app;
}
