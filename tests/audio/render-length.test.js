import test from 'node:test';
import assert from 'node:assert/strict';

test('render.js and wav.js import in Node without browser globals', async () => {
  const r = await import('../../src/audio/render.js');
  const w = await import('../../src/audio/wav.js');
  assert.equal(typeof r.renderOffline, 'function');
  assert.equal(typeof w.downloadBlob, 'function');
});

test('loopLengthSec', async () => {
  const { loopLengthSec } = await import('../../src/audio/render.js');
  assert.equal(loopLengthSec({ synced: true, bars: 4, bpm: 120 }), 8);
  assert.equal(loopLengthSec({ synced: true, bars: 1, bpm: 90 }), 2.6666666666666665);
  assert.equal(loopLengthSec({ synced: false, seconds: 6, bpm: 120 }), 6);
  for (const bad of [0, NaN, -2, Infinity, undefined]) {
    assert.equal(loopLengthSec({ synced: true, bars: bad, bpm: 120 }), 8, `bars ${bad}`);
    assert.equal(loopLengthSec({ synced: true, bars: 4, bpm: bad }), 8, `bpm ${bad}`);
    assert.equal(loopLengthSec({ synced: false, seconds: bad, bpm: 120 }), 8, `seconds ${bad}`);
  }
});
