/*
 * WAV (24-bit PCM) and stored-zip encoders. Pure and Node-importable; downloadBlob is the only
 * browser-touching function and reaches for browser globals only when called.
 */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** @param chans Float32Array[] (1 or 2, equal length) @returns ArrayBuffer of a RIFF/WAVE 24-bit LE PCM file */
export function encodeWav24(chans, sampleRate = 48000) {
  const nc = chans.length, n = nc ? chans[0].length : 0;
  const dataLen = n * nc * 3, pad = dataLen & 1; // RIFF chunks are word aligned
  const buf = new ArrayBuffer(44 + dataLen + pad), dv = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + dataLen + pad, true); str(8, 'WAVE'); str(12, 'fmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, nc, true); dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * nc * 3, true); dv.setUint16(32, nc * 3, true); dv.setUint16(34, 24, true);
  str(36, 'data'); dv.setUint32(40, dataLen, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nc; c++) {
      const x = chans[c][i];
      let s = Math.round(clamp(Number.isFinite(x) ? x : 0, -1, 1) * 8388607);
      if (s < 0) s += 16777216;
      dv.setUint8(o++, s & 255); dv.setUint8(o++, (s >> 8) & 255); dv.setUint8(o++, (s >> 16) & 255);
    }
  }
  return buf;
}

const CRC_T = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();

export function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_T[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** Stored (uncompressed) zip of {name, data: Uint8Array}[]; UTF-8 names. */
export function zipStore(files) {
  const enc = new TextEncoder(), parts = [], cds = [];
  let offset = 0, cdSize = 0;
  for (const f of files) {
    const nb = enc.encode(f.name), crc = crc32(f.data), sz = f.data.length;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(12, 0x21, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, sz, true); lh.setUint32(22, sz, true); lh.setUint16(26, nb.length, true);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true); cd.setUint16(14, 0x21, true);
    cd.setUint32(16, crc, true); cd.setUint32(20, sz, true); cd.setUint32(24, sz, true); cd.setUint16(28, nb.length, true);
    cd.setUint32(42, offset, true);
    parts.push(new Uint8Array(lh.buffer), nb, f.data);
    cds.push(new Uint8Array(cd.buffer), nb);
    offset += 30 + nb.length + sz;
    cdSize += 46 + nb.length;
  }
  const ec = new DataView(new ArrayBuffer(22));
  ec.setUint32(0, 0x06054b50, true); ec.setUint16(8, files.length, true); ec.setUint16(10, files.length, true);
  ec.setUint32(12, cdSize, true); ec.setUint32(16, offset, true);
  const all = [...parts, ...cds, new Uint8Array(ec.buffer)];
  const out = new Uint8Array(all.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of all) { out.set(p, o); o += p.length; }
  return out;
}

/** Browser only: trigger a download of `buffer` (ArrayBuffer | Uint8Array) as `filename`. */
export function downloadBlob(filename, buffer, mime = 'application/octet-stream') {
  if (typeof document === 'undefined' || typeof Blob === 'undefined') throw new Error('downloadBlob needs a browser');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([buffer], { type: mime }));
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
