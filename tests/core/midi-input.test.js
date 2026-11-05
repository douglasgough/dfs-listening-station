import { test } from 'node:test';
import assert from 'node:assert/strict';

test('midi-input imports in Node and reports no Web MIDI support', async () => {
  const m = await import('../../src/audio/midi-input.js');
  assert.equal(m.midiSupported(), false);
  assert.deepEqual(await m.listInputs(), []);
  await assert.rejects(() => m.connect('x', { handle() {} }, () => 0));
});
