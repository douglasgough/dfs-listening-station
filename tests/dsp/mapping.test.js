import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mapFreq, snapFreq, channelMapping } from '../../src/dsp/mapping.js';
import { channelView } from '../../src/core/schema.js';
import { createState } from '../../src/core/state.js';

const golden = JSON.parse(readFileSync(new URL('../fixtures/prototype-golden.json', import.meta.url)));

test('mapFreq + snapFreq at the Allende bands equal the golden freqs', () => {
  const m = channelMapping(channelView(createState().params, 0));
  assert.deepEqual(m, { lo: 110, hi: 3520, curve: 'log', flip: false, f0: 27.5, snap: 1 });
  assert.equal(golden.allende.freqs.length, 4);
  golden.allende.freqs.forEach(({ u, f }, i) => {
    assert.equal(u, golden.examples.Allende.bands[i].u);
    assert.ok(Math.abs(snapFreq(mapFreq(u, m), m) - f) < 1e-9, `band ${i}`);
  });
});

test('mapFreq curves and flip', () => {
  const m = { lo: 100, hi: 400, curve: 'log', flip: false };
  assert.ok(Math.abs(mapFreq(0.5, m) - 200) < 1e-9);
  assert.equal(mapFreq(0.5, { ...m, curve: 'lin' }), 250);
  assert.equal(mapFreq(0, { ...m, flip: true, curve: 'lin' }), 400);
});

test('snapFreq: snap 0 keeps f, never below the 2nd harmonic', () => {
  assert.ok(Math.abs(snapFreq(123, { f0: 27.5, snap: 0 }) - 123) < 1e-9);
  assert.ok(Math.abs(snapFreq(10, { f0: 27.5, snap: 1 }) - 55) < 1e-9);
});
