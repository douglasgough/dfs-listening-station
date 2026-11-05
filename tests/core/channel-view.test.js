import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelView, CHANNEL_PARAMS, NUM_CHANNELS } from '../../src/core/schema.js';
import { createState } from '../../src/core/state.js';

test('channelView strips the chN. prefix and covers every channel key', () => {
  const { params } = createState();
  for (let i = 0; i < NUM_CHANNELS; i++) {
    const v = channelView(params, i);
    assert.deepEqual(Object.keys(v).sort(), CHANNEL_PARAMS.map(d => d.key).sort());
  }
});

test('channelView picks the right channel and ignores globals', () => {
  const { params } = createState();
  assert.equal(channelView(params, 0)['filter.center'], 0.5);
  assert.equal(channelView(params, 1)['filter.center'], 0.25);
  assert.equal(channelView(params, 3)['filter.center'], 0.85);
  assert.equal(channelView(params, 0)['master.gain'], undefined);
  assert.equal(channelView({ 'ch2.map.lo': 5, 'ch1.map.lo': 7, 'g.master.gain': 1 }, 1)['map.lo'], 5);
});
