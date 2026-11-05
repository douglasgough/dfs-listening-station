import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState, createStore } from '../../src/core/state.js';
import { createAppState } from '../../src/ui/app-state.js';
import { EXAMPLE_LAYERS } from '../../src/spectrum/examples.js';

const ex = id => EXAMPLE_LAYERS.find(l => l.id === id);
const make = () => { const store = createStore(createState()); return { store, app: createAppState({ store, examples: EXAMPLE_LAYERS }) }; };
const xLayer = { id: 'xs', name: 'XS', kind: 'lines', quantity: 'intensity', axis: { unit: 'x', x0: 0, x1: 1 }, lines: [{ x: 0.5, intensity: 1 }] };

test('first layer sets the stage; second in another unit keeps it', () => {
  const { app } = make();
  assert.equal(app.stage, null);
  app.addLayer(ex('allende'));
  assert.equal(app.stage.unit, 'nm');
  const { x0, x1 } = app.stage;
  app.addLayer({ ...xLayer });
  assert.equal(app.stage.unit, 'nm');
  assert.deepEqual([app.stage.x0, app.stage.x1], [x0, x1]);
  assert.equal(app.getStage(), app.stage);
});

test('auto-assign only to channels with empty layer; ids pushed to state.layers', () => {
  const { app, store } = make();
  store.set('ch2.source.layer', 'manual');
  const a = app.addLayer(ex('allende'));
  assert.equal(store.get('ch1.source.layer'), a.id);
  assert.equal(store.get('ch2.source.layer'), 'manual');
  assert.equal(store.get('ch4.source.layer'), a.id);
  app.addLayer(ex('murchison'));
  assert.equal(store.get('ch1.source.layer'), a.id);
  assert.deepEqual(store.state.layers, ['allende', 'murchison']);
});

test('ids are unique', () => {
  const { app } = make();
  assert.equal(app.addLayer(ex('allende')).id, 'allende');
  assert.equal(app.addLayer(ex('allende')).id, 'allende-2');
  assert.equal(app.addLayer(ex('allende')).id, 'allende-3');
  assert.equal(app.layers.length, 3);
});

test('remove reassigns to the first remaining layer, or silent', () => {
  const { app, store } = make();
  app.addLayer(ex('allende')); app.addLayer(ex('murchison'));
  app.removeLayer('allende');
  assert.equal(store.get('ch1.source.layer'), 'murchison');
  assert.deepEqual(store.state.layers, ['murchison']);
  assert.equal(app.stage.unit, 'nm');
  app.removeLayer('murchison');
  assert.equal(store.get('ch1.source.layer'), 'none');
  assert.equal(app.stage, null);
  assert.equal(app.removeLayer('nope'), false);
});

test('stage re-taken from new first layer when stage layer removed', () => {
  const { app } = make();
  app.addLayer(ex('allende')); app.addLayer({ ...xLayer });
  app.removeLayer('allende');
  assert.equal(app.stage.unit, 'x');
});

test('zoom stack', () => {
  const { app } = make();
  app.addLayer(ex('allende'));
  const full = { ...app.fullRange };
  assert.equal(app.canZoomOut(), false);
  app.zoomTo(500, 600);
  assert.deepEqual([app.stage.x0, app.stage.x1], [500, 600]);
  app.zoomTo(520, 540);
  assert.equal(app.zoomStack.length, 2);
  app.zoomOut();
  assert.deepEqual([app.stage.x0, app.stage.x1], [500, 600]);
  app.zoomTo(0, 1e6); // clamps to full range
  assert.deepEqual([app.stage.x0, app.stage.x1], [full.x0, full.x1]);
  while (app.canZoomOut()) app.zoomOut();
  assert.deepEqual([app.stage.x0, app.stage.x1], [full.x0, full.x1]);
  assert.equal(app.zoomOut(), false);
});

test('analysisFor / getAnalyses', () => {
  const { app, store } = make();
  assert.equal(app.analysisFor(0), null);
  app.addLayer(ex('allende'));
  assert.ok(app.analysisFor(0).bands.length > 0);
  store.set('ch2.source.layer', '');
  assert.equal(app.analysisFor(1), null);
  store.set('ch3.source.layer', 'ghost');
  assert.equal(app.analysisFor(2), null);
  const all = app.getAnalyses();
  assert.equal(all.length, 4);
  assert.equal(all[1], null);
  assert.equal(app.analysisFor(0), app.analysisFor(0)); // cached
});

test('version bumps and subscribe', () => {
  const { app } = make();
  let n = 0; const off = app.subscribe(() => n++);
  const v0 = app.version;
  app.addLayer(ex('allende')); app.zoomTo(500, 600); app.select(2);
  assert.equal(app.version, v0 + 3);
  assert.equal(n, 3);
  assert.equal(app.selected, 2);
  off(); app.select(1);
  assert.equal(n, 3);
});

test('malformed layer rejected', () => {
  const { app, store } = make();
  assert.throws(() => app.addLayer({ id: 'bad', name: 'Bad', kind: 'sampled', axis: { unit: 'nm', x0: 1, x1: 2 } }), /well-formed/);
  assert.throws(() => app.addLayer(null), /well-formed/);
  assert.equal(app.layers.length, 0);
  assert.deepEqual(store.state.layers, []);
});

test('setUnit converts the range; unplaced lists layers outside the stage', () => {
  const { app } = make();
  const far = { id: 'far', name: 'Far', kind: 'lines', quantity: 'intensity', axis: { unit: 'nm', x0: 3000, x1: 4000 }, lines: [{ x: 3500, intensity: 1 }] };
  app.addLayer(ex('allende')); app.addLayer({ ...xLayer }); app.addLayer(far);
  assert.deepEqual(app.unplaced().map(l => l.id), ['far']);
  app.setUnit('µm');
  assert.equal(app.stage.unit, 'µm');
  assert.ok(app.stage.x1 < 5);
  assert.deepEqual(app.unplaced().map(l => l.id), ['far']);
  app.setUnit('nm');
  assert.ok(Math.abs(app.stage.x0 - ex('allende').axis.x0) < 1e-6);
});

test('visibility', () => {
  const { app } = make();
  app.addLayer(ex('allende'));
  assert.equal(app.isVisible('allende'), true);
  app.setVisible('allende', false);
  assert.equal(app.isVisible('allende'), false);
});

test('zoom, polarity, sens and mode changes give a fresh analysis', () => {
  const { app, store } = make();
  app.addLayer(ex('allende'));
  const a0 = app.analysisFor(0);
  app.zoomTo(500, 900);
  const a1 = app.analysisFor(0);
  assert.notEqual(a1, a0);
  app.zoomOut();
  assert.equal(app.analysisFor(0), a0); // same key -> cached again
  store.set('ch1.source.sens', 0.05);
  const a2 = app.analysisFor(0);
  assert.notEqual(a2, a0);
  assert.ok(a2.bands.length > a0.bands.length, `${a2.bands.length} vs ${a0.bands.length}`);
  store.set('ch1.source.polarity', 'peaks');
  const a3 = app.analysisFor(0);
  assert.notEqual(a3, a2);
  store.set('ch1.source.mode', 'direct');
  assert.notEqual(app.analysisFor(0), a3);
});

test('removing a non-first layer leaves the stage alone; same-unit setUnit is a no-op', () => {
  const { app } = make();
  app.addLayer(ex('allende')); app.addLayer(ex('murchison'));
  app.zoomTo(500, 600);
  const stage = app.stage, v = app.version;
  app.removeLayer('murchison');
  assert.equal(app.stage, stage);
  assert.equal(app.zoomStack.length, 1);
  const v2 = app.version;
  app.setUnit('nm');
  assert.equal(app.version, v2);
  assert.equal(app.zoomStack.length, 1);
  assert.ok(v2 > v);
});

test('mapLinked defaults false; setMapLinked toggles, notifies, rejects channel 1/out of range', () => {
  const { app } = make();
  assert.deepEqual(app.mapLinked, [false, false, false, false]);
  let n = 0; app.subscribe(() => n++);
  app.setMapLinked(1, true);
  assert.deepEqual(app.mapLinked, [false, true, false, false]);
  assert.equal(n, 1);
  app.setMapLinked(1, true);
  assert.equal(n, 1, 'no change, no notify');
  app.setMapLinked(1, false);
  assert.equal(app.mapLinked[1], false);
  for (const i of [0, 4, -1, 1.5]) assert.throws(() => app.setMapLinked(i, true));
});

test('mapLinked is not part of the patch', async () => {
  const { app, store } = make();
  app.setMapLinked(2, true);
  const { serializePatch } = await import('../../src/core/state.js');
  assert.ok(!serializePatch(store.state).includes('mapLinked'));
});

test('timelineHold: defaults null, setTimelineHold notifies and bumps version', () => {
  const { app } = make();
  assert.deepEqual(app.timelineHold, [null, null, null, null]);
  let n = 0; app.subscribe(() => n++);
  const v = app.version;
  app.setTimelineHold(1, 0.25);
  assert.deepEqual(app.timelineHold, [null, 0.25, null, null]);
  assert.equal(n, 1);
  assert.equal(app.version, v + 1);
  app.setTimelineHold(1, 0.25);
  assert.equal(n, 1, 'no change, no notify');
  app.setTimelineHold(1, null);
  assert.equal(app.timelineHold[1], null);
  assert.equal(n, 2);
});

test('timelineHold: rejects bad channel or phase', () => {
  const { app } = make();
  for (const c of [-1, 4, 1.5, '0']) assert.throws(() => app.setTimelineHold(c, 0.5));
  for (const p of [NaN, -0.1, 1, 'x', Infinity]) assert.throws(() => app.setTimelineHold(0, p));
});

test('timelineHold clears when the channel timeline has no events left', () => {
  const { app, store } = make();
  store.setTimeline(0, { events: [{ t: 0.2, c: 0.5 }] });
  app.setTimelineHold(0, 0.2);
  store.setTimeline(0, { events: [] });
  assert.equal(app.timelineHold[0], null);
  app.setTimelineHold(2, 0.3); // never a timeline with events on ch3: stays until cleared by the UI
  store.setTimeline(0, { mode: 'jump' });
  assert.equal(app.timelineHold[2], 0.3);
});

test('replaceLayers swaps every layer, resets zoom/selection/map links, keeps channels pointing at real layers', async () => {
  const { createState, createStore } = await import('../../src/core/state.js');
  const { createAppState } = await import('../../src/ui/app-state.js');
  const { EXAMPLE_LAYERS } = await import('../../src/spectrum/examples.js');
  const store = createStore(createState()), app = createAppState({ store });
  const [a, b, c] = EXAMPLE_LAYERS;
  app.addLayer(a); app.addLayer(b);
  app.select(2); app.setMapLinked(1, true);
  app.replaceLayers([c]);
  assert.deepEqual(app.layers.map(l => l.id), [c.id]);
  assert.deepEqual(store.state.layers, [c.id]);
  assert.equal(app.selected, 0);
  assert.equal(app.mapLinked[1], false);
  assert.equal(app.zoomStack.length, 0);
  for (let i = 1; i <= 4; i++) assert.equal(store.get(`ch${i}.source.layer`), c.id);
  app.replaceLayers([]);
  assert.equal(app.layers.length, 0);
  assert.equal(app.stage, null);
  assert.equal(store.get('ch1.source.layer'), 'none');
});
