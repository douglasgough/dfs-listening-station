/*
 * ChannelEngine: main-thread handle on one 'channel-voice' AudioWorkletNode (src/audio/worklet/channel-voice.js).
 * Frames are stamped in CONTEXT time; the worklet converts them to its synth's engine time.
 *
 * connect({node, index}) records the destination (a Mixer input) so setEnabled(true) can reconnect it.
 * A disabled engine is disconnected and its worklet drops the synth (sleep); frames sent meanwhile are
 * dropped by the worklet, never an error. A newly created engine is enabled.
 */
import { addModuleOnce } from './worklet-loader.js';

export const channelVoiceUrl = () => new URL('./worklet/channel-voice.js', import.meta.url);

export class ChannelEngine {
  /** opts {stereo, seed, loopSec?, plain?, stats?} */
  static async create(ctx, opts = {}) {
    await addModuleOnce(ctx, channelVoiceUrl());
    return new ChannelEngine(ctx, opts);
  }

  constructor(ctx, { stereo = true, seed = 0, loopSec = 0, plain = false, stats = false } = {}) {
    this.ctx = ctx;
    this.node = new AudioWorkletNode(ctx, 'channel-voice', {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [stereo ? 2 : 1],
      processorOptions: { stereo: !!stereo, seed, loopSec, plain: !!plain, stats: !!stats },
    });
    this.output = this.node;
    this.enabled = true;
    this.disposed = false;
    this.dest = null;
    this._acks = [];
    this._stats = new Set();
    this.node.port.onmessage = (e) => {
      const m = e.data;
      if (!m) return;
      if (m.type === 'ack') { const r = this._acks.shift(); if (r) r(); } else if (m.type === 'stats') for (const fn of this._stats) fn(m);
    };
    this.node.onprocessorerror = (e) => console.error('channel-voice processor error', e);
  }

  /** Connect the output to {node, index} (e.g. mixer.input(i)) and remember it for setEnabled. */
  connect(dest) {
    this.dest = dest;
    if (this.enabled && !this.disposed) this.node.connect(dest.node, 0, dest.index);
  }

  send(frame) {
    if (this.disposed) return;
    this.node.port.postMessage({ type: 'frame', frame });
  }

  setEnabled(on) {
    on = !!on;
    if (this.disposed || on === this.enabled) return;
    this.enabled = on;
    if (on) {
      if (this.dest) this.node.connect(this.dest.node, 0, this.dest.index);
      this.node.port.postMessage({ type: 'wake' });
    } else {
      this.node.port.postMessage({ type: 'sleep' });
      this.node.disconnect();
    }
  }

  /** Resolves once the worklet has handled every message posted before this call. */
  flush() {
    if (this.disposed) return Promise.resolve();
    return new Promise((resolve) => {
      this._acks.push(resolve);
      this.node.port.postMessage({ type: 'flush' });
    });
  }

  /** fn({type:'stats', calls, meanMs}); returns unsubscribe. Needs opts.stats. */
  onStats(fn) {
    this._stats.add(fn);
    return () => this._stats.delete(fn);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.node.port.postMessage({ type: 'dispose' });
    this.node.port.onmessage = null;
    this.node.disconnect();
    for (const r of this._acks.splice(0)) r();
    this._stats.clear();
  }
}
