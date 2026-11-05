import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createGraph, FILE_PROTOCOL_MESSAGE } from '../../src/audio/graph.js';

// Minimal stubs of the browser globals createGraph touches. Restored after each test.
const saved = { AudioContext: globalThis.AudioContext, AudioWorkletNode: globalThis.AudioWorkletNode };
afterEach(() => Object.assign(globalThis, saved));

function stubContext({ addModule = async () => {} } = {}) {
  const made = [];
  globalThis.AudioContext = class {
    constructor(opts) {
      this.opts = opts; this.closed = 0; this.destination = {}; this.audioWorklet = { addModule };
      made.push(this);
    }
    close() { this.closed++; return Promise.resolve(); }
    createGain() { return { gain: { value: 0 }, connect() {}, disconnect() {} }; }
    createDynamicsCompressor() {
      const p = () => ({ value: 0 });
      return { threshold: p(), knee: p(), ratio: p(), attack: p(), release: p(), connect() {}, disconnect() {} };
    }
    createAnalyser() { return { connect() {}, disconnect() {} }; }
    createChannelSplitter() { return { connect() {}, disconnect() {} }; }
  };
  return made;
}

test('createGraph: a throw while building the mixer closes the owned live context', async () => {
  const made = stubContext();
  globalThis.AudioWorkletNode = class { constructor() { throw new Error('boom: no worklet node'); } };
  await assert.rejects(createGraph({ live: true, stereo: true }), /boom: no worklet node/);
  assert.equal(made.length, 1);
  assert.equal(made[0].closed, 1);
  assert.deepEqual(made[0].opts, { latencyHint: 'interactive' });
});

test('createGraph: a throw while building channel 2 disposes what was built and closes the context', async () => {
  const made = stubContext();
  const nodes = [];
  globalThis.AudioWorkletNode = class {
    constructor(ctx, name) {
      if (name === 'channel-voice' && nodes.filter(n => n.name === name).length === 2) throw new Error('boom: channel 2');
      this.name = name; this.posted = []; this.disconnected = 0;
      this.port = { postMessage: (m) => this.posted.push(m), onmessage: null };
      this.parameters = new Map();
      nodes.push(this);
    }
    connect() {}
    disconnect() { this.disconnected++; }
  };
  await assert.rejects(createGraph({ live: true }), /boom: channel 2/);
  assert.equal(made[0].closed, 1);
  // mixer-bus and channels 0, 1 were disposed
  assert.equal(nodes.length, 3);
  for (const n of nodes) assert.ok(n.posted.some(m => m.type === 'dispose'), `${n.name} not disposed`);
});

test('createGraph: a module load failure gives the serve-over-HTTP message and closes the context', async () => {
  const made = stubContext({ addModule: async () => { throw new Error('404'); } });
  await assert.rejects(createGraph({ live: true }), (e) => e.message === FILE_PROTOCOL_MESSAGE && e.cause.message === '404');
  assert.equal(made[0].closed, 1);
});

test('createGraph: an offline graph needs ctx; a caller-owned ctx is never closed', async () => {
  await assert.rejects(createGraph({ live: false }), /needs opts.ctx/);
  stubContext();
  globalThis.AudioWorkletNode = class { constructor() { throw new Error('boom'); } };
  const ctx = new globalThis.AudioContext();
  await assert.rejects(createGraph({ live: false, ctx }), /boom/);
  assert.equal(ctx.closed, 0);
});
