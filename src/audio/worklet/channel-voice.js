/*
 * AudioWorklet processor 'channel-voice': one channel's ChannelSynth on the audio thread.
 * Imports only from src/dsp/ (spike: static import works in Chrome; no bundling).
 *
 * processorOptions {stereo, seed, loopSec, plain, stats}; no inputs, one output (2 channels stereo, 1 mono).
 * Port messages in:
 *   {type:'frame', frame}  ControlFrame; frame.t and every frame.events[i].t are CONTEXT-time seconds
 *   {type:'sleep'}         drop the synth; process() keeps running and writes silence
 *   {type:'wake'}          new ChannelSynth with the same options (seed)
 *   {type:'flush'}         reply {type:'ack'} (messages are handled in order, so everything posted
 *                          before the flush has been applied or queued)
 *   {type:'dispose'}       drop the synth; process() returns false
 * Port messages out: {type:'ack'}, and with stats {type:'stats', calls, meanMs} about every 2 s of audio.
 *
 * Engine time 0 of a synth is the first process() call after it was created (construction or wake):
 * t0 = currentFrame / sampleRate there, and timestamps are handed to the synth as t - t0. Frames that
 * arrive before that call are queued raw and converted then.
 * Timing uses Date.now() sums: `performance` is undefined in AudioWorkletGlobalScope (spike).
 */
import { ChannelSynth } from '../../dsp/additive.js';

const QUANTUM = 128;

class ChannelVoice extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.opts = { sampleRate, stereo: !!o.stereo, seed: o.seed, loopSec: o.loopSec, plain: !!o.plain };
    this.stats = !!o.stats;
    this.synth = new ChannelSynth(this.opts);
    this.t0 = null;        // context seconds at the synth's engine time 0 (null until its first process)
    this.queue = [];       // raw frames received before t0 is known
    this.alive = true;
    this.calls = 0; this.ms = 0; this.statEvery = Math.max(1, Math.round(2 * sampleRate / QUANTUM));
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(m) {
    if (!m || typeof m !== 'object') return;
    switch (m.type) {
      case 'frame':
        if (!this.synth || !m.frame) return;           // asleep or disposed: dropped
        if (this.t0 === null) this.queue.push(m.frame);
        else this.schedule(m.frame);
        return;
      case 'sleep':
        if (this.synth) this.synth.dispose();
        this.synth = null; this.queue = []; this.t0 = null;
        return;
      case 'wake':
        if (!this.alive || this.synth) return;
        this.synth = new ChannelSynth(this.opts);
        this.t0 = null;
        return;
      case 'flush':
        this.port.postMessage({ type: 'ack' });
        return;
      case 'dispose':
        if (this.synth) this.synth.dispose();
        this.synth = null; this.queue = []; this.alive = false;
        return;
      default:
    }
  }

  schedule(fr) {
    const t0 = this.t0;
    fr.t -= t0;
    if (Array.isArray(fr.events)) for (const e of fr.events) if (e && typeof e.t === 'number') e.t -= t0;
    this.synth.schedule(fr);
  }

  process(inputs, outputs) {
    if (!this.alive) return false;
    const synth = this.synth;
    if (!synth) return true;
    if (this.t0 === null) {
      this.t0 = currentFrame / sampleRate;
      const q = this.queue;
      this.queue = [];
      for (const fr of q) this.schedule(fr);
    }
    const out = outputs[0];
    const n = out[0] ? out[0].length : QUANTUM;
    const a = this.stats ? Date.now() : 0;
    const { left, right } = synth.render(n);
    if (this.stats) {
      this.ms += Date.now() - a;
      if (++this.calls >= this.statEvery) {
        this.port.postMessage({ type: 'stats', calls: this.calls, meanMs: this.ms / this.calls });
        this.calls = 0; this.ms = 0;
      }
    }
    if (out[0]) out[0].set(left);
    if (out[1]) out[1].set(right || left);
    return true;
  }
}

registerProcessor('channel-voice', ChannelVoice);
