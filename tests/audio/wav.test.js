import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeWav24, crc32, zipStore } from '../../src/audio/wav.js';

const str = (dv, o, n) => String.fromCharCode(...Array.from({ length: n }, (_, i) => dv.getUint8(o + i)));
const s24 = (dv, o) => { let v = dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getUint8(o + 2) << 16); if (v & 0x800000) v -= 0x1000000; return v; };

for (const nc of [1, 2]) {
  test(`encodeWav24 header, ${nc} channel(s)`, () => {
    const n = 10, chans = Array.from({ length: nc }, () => new Float32Array(n));
    const buf = encodeWav24(chans);
    const dv = new DataView(buf);
    assert.equal(buf.byteLength, 44 + n * nc * 3);
    assert.equal(str(dv, 0, 4), 'RIFF');
    assert.equal(dv.getUint32(4, true), 36 + n * nc * 3);
    assert.equal(str(dv, 8, 4), 'WAVE');
    assert.equal(str(dv, 12, 4), 'fmt ');
    assert.equal(dv.getUint32(16, true), 16);
    assert.equal(dv.getUint16(20, true), 1);
    assert.equal(dv.getUint16(22, true), nc);
    assert.equal(dv.getUint32(24, true), 48000);
    assert.equal(dv.getUint32(28, true), 48000 * nc * 3);
    assert.equal(dv.getUint16(32, true), nc * 3);
    assert.equal(dv.getUint16(34, true), 24);
    assert.equal(str(dv, 36, 4), 'data');
    assert.equal(dv.getUint32(40, true), n * nc * 3);
  });
}

test('encodeWav24 ramp round-trips within 1 LSB (stereo interleave) and honours sampleRate', () => {
  const n = 1000, a = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) { a[i] = -1 + 2 * i / (n - 1); b[i] = -a[i]; }
  const dv = new DataView(encodeWav24([a, b], 44100));
  assert.equal(dv.getUint32(24, true), 44100);
  for (let i = 0; i < n; i++) {
    const l = s24(dv, 44 + i * 6) / 8388607, r = s24(dv, 44 + i * 6 + 3) / 8388607;
    assert.ok(Math.abs(l - a[i]) <= 1 / 8388607 + 1e-7, `L ${i}`);
    assert.ok(Math.abs(r - b[i]) <= 1 / 8388607 + 1e-7, `R ${i}`);
  }
});

test('encodeWav24 clamps out-of-range samples', () => {
  const dv = new DataView(encodeWav24([Float32Array.of(2, -3, 1, -1, 0)]));
  assert.equal(s24(dv, 44), 8388607);
  assert.equal(s24(dv, 47), -8388607);
  assert.equal(s24(dv, 50), 8388607);
  assert.equal(s24(dv, 53), -8388607);
  assert.equal(s24(dv, 56), 0);
});

test('crc32 of the check string', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test('zipStore central directory lists the files with matching sizes and crc', () => {
  const enc = new TextEncoder();
  const files = [{ name: 'a.wav', data: enc.encode('hello world') }, { name: 'dir/b.txt', data: enc.encode('123456789') }];
  const z = zipStore(files);
  const dv = new DataView(z.buffer, z.byteOffset, z.byteLength);
  const eocd = z.length - 22;
  assert.equal(dv.getUint32(eocd, true), 0x06054b50);
  assert.equal(dv.getUint16(eocd + 10, true), 2);
  let p = dv.getUint32(eocd + 16, true);
  assert.equal(dv.getUint32(eocd + 12, true) + p, eocd);
  files.forEach((f) => {
    assert.equal(dv.getUint32(p, true), 0x02014b50);
    assert.equal(dv.getUint32(p + 16, true), crc32(f.data));
    assert.equal(dv.getUint32(p + 20, true), f.data.length);
    assert.equal(dv.getUint32(p + 24, true), f.data.length);
    const nl = dv.getUint16(p + 28, true), off = dv.getUint32(p + 42, true);
    assert.equal(new TextDecoder().decode(z.subarray(p + 46, p + 46 + nl)), f.name);
    assert.equal(dv.getUint32(off, true), 0x04034b50);
    const lnl = dv.getUint16(off + 26, true);
    assert.equal(new TextDecoder().decode(z.subarray(off + 30, off + 30 + lnl)), f.name);
    assert.deepEqual([...z.subarray(off + 30 + lnl, off + 30 + lnl + f.data.length)], [...f.data]);
    p += 46 + nl;
  });
});

test('odd-length data chunk gets a RIFF pad byte (mono, n = 11)', () => {
  const n = 11, a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = (i - 5) / 5;
  const buf = encodeWav24([a]), dv = new DataView(buf);
  assert.equal(dv.getUint32(40, true), 33);
  assert.equal(buf.byteLength, 44 + 33 + 1);
  assert.equal(dv.getUint32(4, true), buf.byteLength - 8);
  assert.equal(dv.getUint8(buf.byteLength - 1), 0);
  for (let i = 0; i < n; i++) assert.ok(Math.abs(s24(dv, 44 + i * 3) / 8388607 - a[i]) <= 1 / 8388607 + 1e-7);
});
