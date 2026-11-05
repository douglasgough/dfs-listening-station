import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeWav24, wavPeaks } from '../../tools/wav-peaks.mjs';

function makeWav(chans, rate) {
  const n = chans[0].length, nc = chans.length, buf = new Uint8Array(44 + n * nc * 3), dv = new DataView(buf.buffer);
  const str = (o, s) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); dv.setUint32(4, 36 + n * nc * 3, true); str(8, 'WAVE'); str(12, 'fmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, nc, true); dv.setUint32(24, rate, true); dv.setUint32(28, rate * nc * 3, true);
  dv.setUint16(32, nc * 3, true); dv.setUint16(34, 24, true); str(36, 'data'); dv.setUint32(40, n * nc * 3, true);
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) {
    let s = Math.round(chans[c][i] * 8388607); if (s < 0) s += 16777216;
    buf[o++] = s & 255; buf[o++] = (s >> 8) & 255; buf[o++] = (s >> 16) & 255;
  }
  return buf;
}

const rate = 48000, n = rate * 3;
const sine = (f, a) => Float64Array.from({ length: n }, (_, i) => a * Math.sin(2 * Math.PI * f * i / rate));
const s440 = sine(440, 0.4), s1234 = sine(1234, 0.1);
const two = Float64Array.from(s440, (v, i) => v + s1234[i]);

test('decodeWav24 round-trips header and samples (stereo uses channel layout)', () => {
  const w = decodeWav24(makeWav([two, sine(100, 0.2)], rate));
  assert.equal(w.sampleRate, rate);
  assert.equal(w.channels, 2);
  assert.equal(w.samples.length, n);
  assert.ok(Math.abs(w.samples[100] - two[100]) < 1e-6);
});

test('wavPeaks finds two known sines with correct level, strongest first', () => {
  const peaks = wavPeaks(makeWav([two], rate));
  assert.equal(peaks.length, 12);
  assert.ok(Math.abs(peaks[0].hz - 440) < 1, `got ${peaks[0].hz}`);
  assert.ok(Math.abs(peaks[1].hz - 1234) < 1, `got ${peaks[1].hz}`);
  assert.ok(Math.abs(peaks[0].db - 20 * Math.log10(0.4)) < 0.5, `got ${peaks[0].db}`);
  assert.ok(Math.abs(peaks[1].db - 20 * Math.log10(0.1)) < 0.5, `got ${peaks[1].db}`);
  for (let i = 1; i < peaks.length; i++) assert.ok(peaks[i - 1].db >= peaks[i].db);
});

test('decodeWav24 rejects non-24-bit input', () => {
  const w = makeWav([sine(440, 0.1)], rate); w[34] = 16;
  assert.throws(() => decodeWav24(w), /24-bit/);
});
