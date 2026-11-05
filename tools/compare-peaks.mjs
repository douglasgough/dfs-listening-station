// Compare the new app's spectral peaks with the prototype's (tests/fixtures/prototype-allende-peaks.json).
// Usage: node tools/compare-peaks.mjs new-peaks.json [prototype-peaks.json]
// A prototype peak MATCHES when the new render has a peak within ±1 Hz or ±2 % and its level is within ±3 dB.
import { readFileSync } from 'node:fs';
const [newFile, protoFile = new URL('../tests/fixtures/prototype-allende-peaks.json', import.meta.url).pathname] = process.argv.slice(2);
if (!newFile) { console.error('usage: node tools/compare-peaks.mjs new-peaks.json [prototype-peaks.json]'); process.exit(2); }
const load = f => JSON.parse(readFileSync(f, 'utf8'));
const neu = load(newFile), proto = load(protoFile);
let bad = 0;
for (const p of proto) {
  const tol = Math.max(1, p.hz * 0.02);
  const m = neu.filter(n => Math.abs(n.hz - p.hz) <= tol).sort((a, b) => Math.abs(a.hz - p.hz) - Math.abs(b.hz - p.hz))[0];
  const d = m ? m.db - p.db : null;
  const ok = m && Math.abs(d) <= 3;
  if (!ok) bad++;
  console.log(`${ok ? 'MATCH ' : 'DIFFER'}  ${String(p.hz).padStart(8)} Hz  proto ${p.db.toFixed(2).padStart(7)} dB  new ${m ? m.db.toFixed(2).padStart(7) + ' dB (' + (d >= 0 ? '+' : '') + d.toFixed(2) + ')' : '   missing'}`);
}
console.log(`${proto.length - bad}/${proto.length} peaks match`);
process.exit(bad ? 1 : 0);
