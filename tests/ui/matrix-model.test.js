import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allDestinations, destinationRows, sourceColumns, routeMap, amountFromDrag, formatAmount, keyStep, preset, sourceLabel, ownerOf } from '../../src/ui/matrix-model.js';
import { modulatableIds } from '../../src/core/schema.js';

test('allDestinations is exactly the modulatable set, grouped by owner in order', () => {
  const d = allDestinations();
  assert.deepEqual(new Set(d.map(x => x.id)), new Set(modulatableIds()));
  assert.equal(d.length, modulatableIds().length);
  const owners = d.map(x => x.owner);
  assert.deepEqual([...new Set(owners)], ['g', 'ch1', 'ch2', 'ch3', 'ch4']);
  assert.equal(owners.join(','), [...owners].sort((a, b) => ['g', 'ch1', 'ch2', 'ch3', 'ch4'].indexOf(a) - ['g', 'ch1', 'ch2', 'ch3', 'ch4'].indexOf(b)).join(','), 'groups are contiguous');
});

test('no pitch destination is ever offered (map.* and drone.beat are not modulatable)', () => {
  assert.ok(!allDestinations().some(d => /\.map\.|drone\.beat/.test(d.id)));
});

test('event.level is flagged per-voice', () => {
  assert.equal(allDestinations().find(d => d.id === 'ch1.event.level').voiceRate, true);
  assert.equal(allDestinations().find(d => d.id === 'ch1.filter.center').voiceRate, false);
});

test('destinationRows honours filter and collapsed groups', () => {
  assert.equal(destinationRows('all').length, allDestinations().length);
  assert.ok(destinationRows('ch2').every(d => d.owner === 'ch2'));
  assert.equal(destinationRows('ch2').length, allDestinations().filter(d => d.owner === 'ch2').length);
  assert.ok(!destinationRows('all', new Set(['ch1'])).some(d => d.owner === 'ch1'));
  assert.equal(destinationRows('g').length, 1);
});

test('sourceColumns: all lists 2 global LFOs, CC columns, then 4 per channel', () => {
  const c = sourceColumns('all', [], []);
  assert.deepEqual(c.slice(0, 2).map(x => x.id), ['g.lfo1', 'g.lfo2']);
  assert.equal(c.length, 2 + 16);
  assert.deepEqual(c.slice(2, 6).map(x => x.id), ['ch1.lfo1', 'ch1.lfo2', 'ch1.env1', 'ch1.env2']);
});

test('sourceColumns adds CC columns from the ccList and from existing routes, sorted', () => {
  const c = sourceColumns('all', [{ src: 'g.cc74', dst: 'ch1.filter.center', amount: 0.5 }], [7]);
  assert.deepEqual(c.filter(x => x.id.startsWith('g.cc')).map(x => x.id), ['g.cc7', 'g.cc74']);
  assert.equal(c.find(x => x.id === 'g.cc74').label, 'CC 74');
});

test('a channel filter keeps global + own sources and any foreign source routed into a visible row', () => {
  const routes = [{ src: 'ch3.env1', dst: 'ch1.filter.width', amount: 1 }, { src: 'ch4.lfo1', dst: 'ch2.filter.width', amount: 1 }];
  const ids = sourceColumns('ch1', routes).map(x => x.id);
  assert.ok(ids.includes('g.lfo1') && ids.includes('ch1.env2') && ids.includes('ch3.env1'));
  assert.ok(!ids.includes('ch4.lfo1') && !ids.includes('ch2.lfo1'));
});

test('routeMap and labels', () => {
  const m = routeMap([{ src: 'ch1.lfo1', dst: 'ch1.filter.center', amount: 0.25 }]);
  assert.equal(m.get('ch1.lfo1|ch1.filter.center'), 0.25);
  assert.equal(sourceLabel('ch2.env2'), 'Env 2');
  assert.equal(sourceLabel('g.lfo1'), 'LFO 1');
  assert.equal(ownerOf('g.master.gain'), 'g');
  assert.equal(ownerOf('ch3.filter.center'), 'ch3');
});

test('amountFromDrag: up is positive, 100 px = 100%, clamps and snaps to 1%', () => {
  assert.equal(amountFromDrag(0, -50), 0.5);
  assert.equal(amountFromDrag(0, 50), -0.5);
  assert.equal(amountFromDrag(0.8, -50), 1);
  assert.equal(amountFromDrag(-0.8, 50), -1);
  assert.equal(amountFromDrag(0, -33.3), 0.33);
  assert.equal(amountFromDrag(0.5, 0), 0.5);
});

test('formatAmount and keyStep', () => {
  assert.equal(formatAmount(0.5), '+50%');
  assert.equal(formatAmount(-0.255), '−26%');
  assert.equal(formatAmount(0.001), '0%');
  assert.equal(keyStep('ArrowUp', false), 0.05);
  assert.equal(keyStep('ArrowDown', true), -0.25);
  assert.equal(keyStep('x', false), 0);
});

test('presets: slow sweep routes a triangle LFO to filter centre; unknown preset throws', () => {
  const p = preset('slowSweep', 1);
  assert.deepEqual(p.routes, [{ src: 'ch2.lfo1', dst: 'ch2.filter.center', amount: 1 }]);
  assert.deepEqual(p.mods[0].slice(0, 3), ['ch2', 'lfo', 0]);
  assert.equal(p.mods[0][3].shape, 'tri');
  assert.deepEqual(preset('envToEventLevel', 0).routes, [{ src: 'ch1.env1', dst: 'ch1.event.level', amount: 1 }]);
  assert.throws(() => preset('nope', 0), /Unknown preset/);
});
