/*
 * AudioWorklet processor 'mixer-bus': the four channel strips summed in a FIXED order (input 0, 1, 2, 3).
 * Chrome sums 3+ connections into one input in an unspecified order, which breaks bit-identical offline
 * renders (spike); a fixed-order sum here keeps them deterministic. Each input carries one channel.
 *
 * processorOptions {stereo}; numberOfInputs 4; one output, 2 channels (stereo) or 1 (mono).
 * k-rate params gain0..gain3 (default 0, >= 0) and pan0..pan3 (default 0, -1..1).
 * Stereo: balance law gL = cos(max(0,p)*pi/2), gR = cos(max(0,-p)*pi/2) on the strip's L and R
 * (a mono input feeds both). Mono output: a stereo input is downmixed (L+R)/2; pan is ignored.
 * Meters: per strip peak and RMS of the strip's contribution (post gain and pan), posted as
 * {type:'meters', peak:[4], rms:[4]} every 1024 frames. {type:'dispose'} ends processing.
 */
const N = 4, METER_FRAMES = 1024;
const HALF_PI = Math.PI / 2;

const params = [];
for (let i = 0; i < N; i++) {
  params.push({ name: `gain${i}`, defaultValue: 0, minValue: 0, automationRate: 'k-rate' });
  params.push({ name: `pan${i}`, defaultValue: 0, minValue: -1, maxValue: 1, automationRate: 'k-rate' });
}

class MixerBus extends AudioWorkletProcessor {
  static get parameterDescriptors() { return params; }

  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.stereo = o.stereo !== false;
    this.peak = new Float64Array(N); this.sq = new Float64Array(N); this.count = 0;
    this.alive = true;
    this.port.onmessage = (e) => { if (e.data && e.data.type === 'dispose') this.alive = false; };
  }

  process(inputs, outputs, parameters) {
    if (!this.alive) return false;
    const out = outputs[0];
    const L = out[0], R = this.stereo ? out[1] : null;
    const len = L.length;
    L.fill(0); if (R) R.fill(0);
    const { peak, sq } = this;
    for (let i = 0; i < N; i++) {
      const inp = inputs[i];
      if (!inp || inp.length === 0) continue;             // not connected (e.g. a disabled channel)
      const g = Math.max(0, parameters[`gain${i}`][0]);
      const a = inp[0], b = inp.length > 1 ? inp[1] : inp[0];
      let pk = peak[i], s2 = sq[i];
      if (R) {
        const p = Math.min(1, Math.max(-1, parameters[`pan${i}`][0]));
        const gl = g * Math.cos(Math.max(0, p) * HALF_PI), gr = g * Math.cos(Math.max(0, -p) * HALF_PI);
        for (let n = 0; n < len; n++) {
          const l = a[n] * gl, r = b[n] * gr;
          L[n] += l; R[n] += r;
          const m = Math.max(Math.abs(l), Math.abs(r));
          if (m > pk) pk = m;
          s2 += 0.5 * (l * l + r * r);
        }
      } else {
        const gm = inp.length > 1 ? 0.5 * g : g;
        for (let n = 0; n < len; n++) {
          const x = (inp.length > 1 ? a[n] + b[n] : a[n]) * gm;
          L[n] += x;
          const m = Math.abs(x);
          if (m > pk) pk = m;
          s2 += x * x;
        }
      }
      peak[i] = pk; sq[i] = s2;
    }
    this.count += len;
    if (this.count >= METER_FRAMES) {
      const rms = new Array(N);
      for (let i = 0; i < N; i++) rms[i] = Math.sqrt(sq[i] / this.count);
      this.port.postMessage({ type: 'meters', peak: Array.from(peak), rms });
      peak.fill(0); sq.fill(0); this.count = 0;
    }
    return true;
  }
}

registerProcessor('mixer-bus', MixerBus);
