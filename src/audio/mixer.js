/*
 * Mixer: four channel strips summed in a FIXED order, then master gain (and, live, the compressor).
 * Spike rule 1 (docs/superpowers/spikes/2026-11-04-worklet-spike.md): never let 3+ nodes feed one audio
 * input on a path that must render deterministically, so the strips sum inside the 'mixer-bus' worklet
 * (src/audio/worklet/mixer-bus.js) instead of a Web Audio summing junction. Analysers are taps only.
 *
 * Graph:  channel i -> mixer-bus input i (gain_i, pan_i, metering) -> GainNode (MASTER * master)
 *         -> live: DynamicsCompressor (-12 dB, knee 10, ratio 8, attack .01, release .3) -> destination
 *            (taps: analyser fftSize 4096 smoothing .8; splitter -> analyserL / analyserR fftSize 1024)
 *         -> offline: destination
 *
 * Importable in Node: the module top level touches no browser globals; only the pure helpers
 * faderGain and mixGates are meant to run there.
 */
import { MASTER } from '../dsp/partials.js';
import { addModuleOnce } from './worklet-loader.js';

export const NUM_STRIPS = 4;
const STRIP_TC = 0.04, MASTER_TC = 0.25;

/** Fader position 0..1 to linear gain: 60/66 is 0 dB, 1 is +6 dB, below 0.005 is silence. */
export const faderGain = pos => (pos < 0.005 ? 0 : 10 ** ((pos * 66 - 60) / 20));

/**
 * Which strips are heard. With any strip soloed, only soloed strips pass; a muted strip is silent
 * even when soloed (mute wins). Prototype index.html line 513.
 */
export function mixGates(strips) {
  const anySolo = strips.some(s => s.solo);
  return strips.map(s => !s.mute && (!anySolo || !!s.solo));
}

export const mixerBusUrl = () => new URL('./worklet/mixer-bus.js', import.meta.url);

const fin = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export class Mixer {
  /** The 'mixer-bus' module must already be loaded in ctx (Mixer.create does that). */
  constructor(ctx, dest, { stereo = true, live = false } = {}) {
    this.ctx = ctx;
    this.stereo = !!stereo;
    this.live = !!live;
    this._meters = new Set();
    this.bus = new AudioWorkletNode(ctx, 'mixer-bus', {
      numberOfInputs: NUM_STRIPS, numberOfOutputs: 1, outputChannelCount: [this.stereo ? 2 : 1],
      processorOptions: { stereo: this.stereo },
    });
    this.bus.port.onmessage = (e) => {
      const m = e.data;
      if (m && m.type === 'meters') for (const fn of this._meters) fn(m);
    };
    this.bus.onprocessorerror = (e) => console.error('mixer-bus processor error', e);
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.bus.connect(this.master);
    this.analyser = this.analyserL = this.analyserR = null;
    this.compressor = null;
    if (this.live) {
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -12; comp.knee.value = 10; comp.ratio.value = 8;
      comp.attack.value = 0.01; comp.release.value = 0.3;
      this.master.connect(comp);
      comp.connect(dest);
      this.compressor = comp;
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 4096; this.analyser.smoothingTimeConstant = 0.8;
      comp.connect(this.analyser);
      this.splitter = ctx.createChannelSplitter(2);
      this.analyserL = ctx.createAnalyser(); this.analyserR = ctx.createAnalyser();
      this.analyserL.fftSize = 1024; this.analyserR.fftSize = 1024;
      comp.connect(this.splitter);
      this.splitter.connect(this.analyserL, 0);
      this.splitter.connect(this.analyserR, 1);
    } else {
      this.master.connect(dest);
    }
  }

  static async create(ctx, dest, opts) {
    await addModuleOnce(ctx, mixerBusUrl());
    return new Mixer(ctx, dest, opts);
  }

  /** Where channel i connects: node.connect(input.node, 0, input.index). */
  input(i) {
    return { node: this.bus, index: i };
  }

  /**
   * strips: {fader, pan, mute, solo}[4]; master: 0..1 (scaled by MASTER); t: context time.
   * Smoothed (strip gains/pans 0.04 s, master 0.25 s) unless immediate.
   */
  apply(strips, master, t, immediate = false) {
    const gates = mixGates(strips);
    const set = (param, v, tc) => {
      if (immediate) { param.cancelScheduledValues(t); param.setValueAtTime(v, t); } else param.setTargetAtTime(v, t, tc);
    };
    for (let i = 0; i < NUM_STRIPS && i < strips.length; i++) {
      const s = strips[i];
      const g = gates[i] ? faderGain(fin(s.fader, 0)) : 0;
      set(this.bus.parameters.get(`gain${i}`), g, STRIP_TC);
      set(this.bus.parameters.get(`pan${i}`), Math.min(1, Math.max(-1, fin(s.pan, 0))), STRIP_TC);
    }
    set(this.master.gain, MASTER * Math.max(0, fin(master, 0)), MASTER_TC);
  }

  /** fn({type:'meters', peak:number[4], rms:number[4]}), post-gain, every 1024 frames. Returns unsubscribe. */
  onMeters(fn) {
    this._meters.add(fn);
    return () => this._meters.delete(fn);
  }

  dispose() {
    this._meters.clear();
    this.bus.port.onmessage = null;
    this.bus.port.postMessage({ type: 'dispose' });
    for (const n of [this.bus, this.master, this.compressor, this.splitter]) if (n) n.disconnect();
  }
}
