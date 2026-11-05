import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NUM_CHANNELS, CHANNEL_PARAMS, GLOBAL_PARAMS, CHANNEL_DEFAULTS,
  pid, paramDef, allParamIds, modulatableIds,
} from '../../src/core/schema.js';

test('NUM_CHANNELS is 4', () => assert.equal(NUM_CHANNELS, 4));

test('all param ids are unique', () => {
  const ids = allParamIds();
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.length, CHANNEL_PARAMS.length * NUM_CHANNELS + GLOBAL_PARAMS.length);
});

test('every def has the required fields and a valid type', () => {
  for (const d of [...CHANNEL_PARAMS, ...GLOBAL_PARAMS]) {
    for (const f of ['key', 'label', 'unit', 'tip']) assert.equal(typeof d[f], 'string', `${d.key}.${f}`);
    assert.ok(d.tip.length > 0, `${d.key} tip`);
    assert.ok(['num', 'enum', 'bool', 'time', 'id'].includes(d.type), `${d.key} type`);
    assert.equal(typeof d.modulatable, 'boolean', `${d.key} modulatable`);
    if (d.type === 'enum') assert.ok(Array.isArray(d.options) && d.options.length > 1, `${d.key} options`);
  }
});

test('every numeric default is within [min,max], for every channel', () => {
  for (let ch = 0; ch < NUM_CHANNELS; ch++) {
    for (const id of allParamIds().filter(i => i.startsWith(`ch${ch + 1}.`))) {
      const d = paramDef(id);
      if (d.type === 'num') {
        assert.ok(d.default >= d.min && d.default <= d.max, `${id} default ${d.default} in [${d.min},${d.max}]`);
      }
      if (d.type === 'enum') assert.ok(d.options.includes(d.default), `${id} default in options`);
    }
  }
  for (const d of GLOBAL_PARAMS) if (d.type === 'num') assert.ok(d.default >= d.min && d.default <= d.max, d.key);
});

test('pid builds 1-based channel ids and global ids', () => {
  assert.equal(pid(1, 'filter.center'), 'ch2.filter.center');
  assert.equal(pid(0, 'filter.center'), 'ch1.filter.center');
  assert.equal(pid('g', 'master.gain'), 'g.master.gain');
});

test('paramDef resolves ids and rejects unknown ones', () => {
  assert.equal(paramDef('ch5.filter.center'), undefined);
  assert.equal(paramDef('ch5.x'), undefined);
  assert.equal(paramDef('ch1.nope'), undefined);
  assert.equal(paramDef('nonsense'), undefined);
  assert.equal(paramDef('g.master.gain').default, 0.7);
  assert.equal(paramDef('g.transport.bpm').default, 120);
});

test('per-channel filter defaults are applied by paramDef', () => {
  assert.deepEqual(CHANNEL_DEFAULTS['filter.center'], [0.5, 0.25, 0.6, 0.85]);
  assert.deepEqual(CHANNEL_DEFAULTS['filter.width'], [0.3, 0.15, 0.15, 0.15]);
  assert.deepEqual(CHANNEL_DEFAULTS['filter.on'], [true, false, false, false]);
  const centers = [0, 1, 2, 3].map(c => paramDef(pid(c, 'filter.center')).default);
  assert.deepEqual(centers, [0.5, 0.25, 0.6, 0.85]);
  assert.equal(paramDef('ch2.filter.center').default, 0.25);
  assert.equal(paramDef('ch1.filter.on').default, true);
  assert.equal(paramDef('ch3.filter.on').default, false);
  assert.equal(paramDef('ch4.filter.width').default, 0.15);
});

test('modulatableIds contains filter centers, excludes map.* and drone.beat, is stable-sorted', () => {
  const m = modulatableIds();
  assert.ok(m.includes('ch1.filter.center'));
  assert.ok(m.includes('g.master.gain'));
  assert.ok(m.includes('ch3.strip.fader'));
  assert.ok(m.includes('ch1.source.shift'));
  assert.ok(m.includes('ch1.event.level'));
  assert.ok(!m.some(i => /\.map\./.test(i)));
  assert.ok(!m.some(i => i.endsWith('drone.beat')));
  assert.ok(!m.includes('ch1.filter.on'));
  assert.ok(!m.includes('ch1.filter.type'));
  assert.deepEqual(m, [...m].sort());
  assert.deepEqual(modulatableIds(), m);
  assert.equal(new Set(m).size, m.length);
});

test('modulatable set matches the spec exactly', () => {
  const keys = CHANNEL_PARAMS.filter(d => d.modulatable).map(d => d.key).sort();
  assert.deepEqual(keys, [
    'drone.anchor', 'drone.bands', 'drone.comb', 'drone.noise',
    'event.chance', 'event.level',
    'filter.center', 'filter.level', 'filter.soft', 'filter.width',
    'grain.density', 'grain.scatter', 'grain.size',
    'source.shift', 'strip.fader',
    'vwin.center', 'vwin.height',
  ]);
  assert.deepEqual(GLOBAL_PARAMS.filter(d => d.modulatable).map(d => d.key), ['master.gain']);
});

test('voiceRate only on event.level', () => {
  const vr = CHANNEL_PARAMS.filter(d => d.voiceRate).map(d => d.key);
  assert.deepEqual(vr, ['event.level']);
});

test('time params default to synced quarter-beat', () => {
  assert.deepEqual(paramDef('ch1.event.interval').default, { mode: 'beats', div: '1/4' });
  assert.deepEqual(paramDef('ch1.event.stepLen').default, { mode: 'beats', div: '1/4' });
  assert.equal(paramDef('ch1.event.interval').type, 'time');
});

test('width and vertical height have min 0.02; fader default is 60/66', () => {
  assert.equal(paramDef('ch1.filter.width').min, 0.02);
  assert.equal(paramDef('ch1.vwin.height').min, 0.02);
  assert.equal(paramDef('ch1.strip.fader').default, 60 / 66);
});

test('paramDef returns an independent def per channel', () => {
  assert.notEqual(paramDef('ch1.filter.center'), paramDef('ch2.filter.center'));
  assert.equal(paramDef('ch1.filter.center').default, 0.5);
});
