import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sampleProfile, winOne, verticalGate, channelGain } from '../../src/dsp/window.js';
import { channelView } from '../../src/core/schema.js';
import { createState } from '../../src/core/state.js';

const golden = JSON.parse(readFileSync(new URL('../fixtures/prototype-golden.json', import.meta.url)));
const ch1 = () => channelView(createState().params, 0);

test('winOne edge cases', () => {
  assert.equal(winOne(0.9, 0.1, 0.999, 0.3), 1);
  assert.equal(winOne(0.9, 0.1, 1, 0.3), 1);
  assert.equal(winOne(0.5, 0.5, 0.2, 0.3), 1);
  assert.equal(winOne(0.9, 0.5, 0.2, 0.3), 0);
  // taper midpoint: inner=.07, outer=.13+1e-6; d at the middle gives .5
  const inner = 0.07, outer = 0.13 + 1e-6;
  assert.ok(Math.abs(winOne(0.5 + (inner + outer) / 2, 0.5, 0.2, 0.3) - 0.5) < 1e-12);
  assert.equal(winOne(0.5 + 0.11, 0.5, 0.2, 0), 0); // hard edge
});

test('sampleProfile interpolates and clamps', () => {
  const a = [0, 1, 0.5];
  assert.equal(sampleProfile(a, 0), 0);
  assert.equal(sampleProfile(a, 0.25), 0.5);
  assert.equal(sampleProfile(a, 0.5), 1);
  assert.equal(sampleProfile(a, 1), 0.5);
  assert.equal(sampleProfile(a, -3), 0);
  assert.equal(sampleProfile(a, 9), 0.5);
});

const an = { r: [0, 0.5, 1], d: [0, 1, 2], dmax: 2 };

test('verticalGate modes 0/1/2', () => {
  const vw = { center: 0.5, height: 0.2, soft: 0 };
  assert.equal(verticalGate(an, 0.5, { ...vw, mode: 0 }), 1);
  assert.equal(verticalGate(null, 0.5, { ...vw, mode: 1 }), 1);
  assert.equal(verticalGate(an, 0.5, { ...vw, mode: 1 }), 1); // r=.5 at centre
  assert.equal(verticalGate(an, 0, { ...vw, mode: 1 }), 0); // r=0
  assert.equal(verticalGate(an, 1, { ...vw, mode: 2 }), 0); // d/dmax = 1
  assert.equal(verticalGate(an, 0.5, { ...vw, mode: 2 }), 1); // d/dmax = .5
  assert.equal(verticalGate(an, 0, { ...vw, mode: 2, height: 0.999 }), 1); // open
  assert.equal(verticalGate(an, 0, { ...vw, mode: 2 }), 0);
  assert.equal(verticalGate({ r: [0, 1], d: [0, 1], dmax: 0 }, 0.5, { ...vw, mode: 2, center: 0.5, height: 0.1, soft: 0 }), 1); // dmax 0 -> divide by 1
});

test('channelGain for default channel 1 equals the golden window gains', () => {
  const ch = ch1();
  assert.equal(golden.allende.win.length, 16);
  for (const { u, gain } of golden.allende.win) {
    assert.ok(Math.abs(channelGain(u, ch, null) - gain) < 1e-12, `u=${u}`);
  }
});

test('channelGain: disabled is 0, level scales', () => {
  const ch = ch1();
  assert.equal(channelGain(0.5, { ...ch, 'filter.on': false }, null), 0);
  assert.equal(channelGain(0.5, ch, null), 1);
  assert.equal(channelGain(0.5, { ...ch, 'filter.level': 0.4 }, null), 0.4);
});

test('channelGain applies the vertical gate', () => {
  const ch = { ...ch1(), 'vwin.mode': 1, 'vwin.center': 0.5, 'vwin.height': 0.2, 'vwin.soft': 0 };
  assert.equal(channelGain(0.5, ch, an), 1);
  assert.equal(channelGain(0.45, { ...ch, 'vwin.center': 0.9 }, an), 0);
});

test('granular channel combines overlapping grains', () => {
  const ch = { ...ch1(), 'filter.type': 'granular' };
  const grains = [[0.5, 0.2, 0, 0.5], [0.5, 0.4, 0, 0.5]];
  // both full at u=.5: 1 - (1-.5)(1-.5) = .75
  assert.ok(Math.abs(channelGain(0.5, ch, null, grains) - 0.75) < 1e-12);
  // u=.65: first outside (d=.15 > .1), second inside (d=.15 <= .2): 1 - (1-0)(1-.5) = .5
  assert.ok(Math.abs(channelGain(0.65, ch, null, grains) - 0.5) < 1e-12);
  assert.equal(channelGain(0.5, ch, null), 0);
  assert.equal(channelGain(0.5, ch, null, []), 0);
  assert.equal(channelGain(0.5, { ...ch, 'filter.on': false }, null, grains), 0);
});
