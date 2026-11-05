// Usage: node tools/wav-peaks.mjs <file.wav> [out.json]
// Decodes a 24-bit PCM WAV (channel 0), averages Hann-windowed power spectra over the
// whole file (Welch), and reports the 12 strongest spectral peaks as [{hz, db}] sorted by
// descending level. db is the estimated sinusoid amplitude in dBFS.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function decodeWav24(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = o => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  if (buf.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a RIFF/WAVE file');
  let fmt = null, dataOff = -1, dataLen = 0;
  for (let o = 12; o + 8 <= buf.length;) {
    const id = tag(o), len = dv.getUint32(o + 4, true);
    if (id === 'fmt ') fmt = { format: dv.getUint16(o + 8, true), channels: dv.getUint16(o + 10, true), rate: dv.getUint32(o + 12, true), bits: dv.getUint16(o + 22, true) };
    else if (id === 'data') { dataOff = o + 8; dataLen = Math.min(len, buf.length - dataOff); break; }
    o += 8 + len + (len & 1);
  }
  if (!fmt || dataOff < 0) throw new Error('missing fmt or data chunk');
  if (fmt.bits !== 24) throw new Error('expected 24-bit PCM, got ' + fmt.bits + '-bit');
  const frame = fmt.channels * 3, n = Math.floor(dataLen / frame), samples = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = dataOff + i * frame;
    let s = dv.getUint8(p) | (dv.getUint8(p + 1) << 8) | (dv.getUint8(p + 2) << 16);
    if (s & 0x800000) s -= 0x1000000;
    samples[i] = s / 8388608;
  }
  return { sampleRate: fmt.rate, channels: fmt.channels, samples };
}

// In-place iterative radix-2 FFT.
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang), h = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < h; k++) {
        const a = i + k, b = a + h, tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

// Welch-averaged amplitude spectrum: returns { amp (linear, sinusoid amplitude), binHz }.
export function amplitudeSpectrum(samples, sampleRate, size = 1 << 17) {
  let n = size; while (n > samples.length && n > 16) n >>= 1;
  const win = new Float64Array(n); let wsum = 0;
  for (let i = 0; i < n; i++) { win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n); wsum += win[i]; }
  const hop = n >> 1, half = n >> 1, pow = new Float64Array(half + 1), re = new Float64Array(n), im = new Float64Array(n);
  let segs = 0;
  for (let s = 0; s + n <= samples.length || segs === 0; s += hop) {
    for (let i = 0; i < n; i++) { re[i] = (samples[s + i] || 0) * win[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k <= half; k++) pow[k] += re[k] * re[k] + im[k] * im[k];
    segs++;
  }
  const amp = new Float64Array(half + 1);
  for (let k = 0; k <= half; k++) amp[k] = 2 * Math.sqrt(pow[k] / segs) / wsum;
  return { amp, binHz: sampleRate / n };
}

// Strongest local maxima, parabolic interpolation on dB, at least minSep bins apart.
export function pickPeaks({ amp, binHz }, count = 12, minSep = 4) {
  const db = Array.from(amp, a => 20 * Math.log10(Math.max(a, 1e-12)));
  const cand = [];
  for (let k = 2; k < db.length - 1; k++) if (db[k] > db[k - 1] && db[k] >= db[k + 1]) cand.push(k);
  cand.sort((a, b) => db[b] - db[a]);
  const taken = [];
  for (const k of cand) {
    if (taken.length >= count) break;
    if (taken.some(t => Math.abs(t - k) < minSep)) continue;
    taken.push(k);
  }
  return taken.map(k => {
    const a = db[k - 1], b = db[k], c = db[k + 1], d = a - 2 * b + c, off = d ? 0.5 * (a - c) / d : 0;
    return { hz: +((k + off) * binHz).toFixed(2), db: +(b - 0.25 * (a - c) * off).toFixed(2) };
  }).sort((x, y) => y.db - x.db);
}

export function wavPeaks(buf, count = 12) {
  const { sampleRate, samples } = decodeWav24(buf);
  return pickPeaks(amplitudeSpectrum(samples, sampleRate), count);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [file, out] = process.argv.slice(2);
  if (!file) { console.error('usage: node tools/wav-peaks.mjs <file.wav> [out.json]'); process.exit(2); }
  const json = JSON.stringify(wavPeaks(readFileSync(file)), null, 2) + '\n';
  if (out) writeFileSync(out, json); else process.stdout.write(json);
}
