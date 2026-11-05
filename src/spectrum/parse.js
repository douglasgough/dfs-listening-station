/* Parsing of two-column text spectra. Pure: no DOM, no globals. */
export function isNull(y) { return Math.abs(y + 9.999999) < 1e-5 || y === -999 || y === -9999 || y <= -1e29; }

export function guessUnit(x0, x1) {
  if (x1 <= 60) return 'µm';
  if (x0 >= 150 && x1 <= 6000) return 'nm';
  if (x0 >= 1000 && x1 > 6000 && x1 <= 30000) return 'Å';
  return 'x';
}

export function parseSpectrumText(text, name) {
  const pts = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || '#/;%'.includes(t[0])) continue;
    const parts = t.split(/[\s,;]+/);
    if (parts.length < 2) continue;
    const a = Number(parts[0]), b = Number(parts[1]);
    if (!isFinite(a) || !isFinite(b) || isNull(b)) continue;
    pts.push([a, b]);
  }
  if (pts.length < 16) throw new Error('Found only ' + pts.length + ' numeric rows. Expected two columns: position, value.');
  pts.sort((p, q) => p[0] - q[0]);
  const x = [], y = [];
  for (const p of pts) { if (x.length && p[0] === x[x.length - 1]) continue; x.push(p[0]); y.push(p[1]); }
  if (x.length < 16 || x[x.length - 1] === x[0]) throw new Error('The position column does not vary.');
  return { name, x, y, x0: x[0], x1: x[x.length - 1], unit: guessUnit(x[0], x[x.length - 1]) };
}
