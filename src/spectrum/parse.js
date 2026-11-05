/* Parsing of spectra and line lists. Pure: no DOM, no globals. */
import { UNITS } from './layers.js';

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

/* ---------------------------------------------------------------------------------------------
 * Layer importers: line lists, headered sampled CSV, and a detector registry.
 * Every layer built here uses plain arrays, finite numbers, and an axis with x0 < x1.
 * ------------------------------------------------------------------------------------------- */
/** Layer id from a name: lowercase, runs of non-alphanumerics -> '-', trimmed of leading/trailing '-'. */
export function slugify(name) {
  return String(name).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
}

const MAX_REASONS = 20;
const POSITION_WORDS = new Set(['wavelength', 'wave', 'lambda', 'position', 'x', 'freq', 'frequency', 'wavenumber']);
const INTENSITY_WORDS = new Set(['intensity', 'strength', 'flux', 'depth', 'amplitude', 'height']);
const WIDTH_WORDS = new Set(['width', 'fwhm']);
const LABEL_WORDS = new Set(['label', 'species', 'name', 'element', 'id']);
const TYPE_WORDS = new Set(['type', 'kind']);
const SAMPLED_Y_WORDS = new Set(['intensity', 'strength', 'amplitude', 'height', 'flux', 'value', 'reflectance', 'depth', 'y']);
const CATEGORIES = [['position', POSITION_WORDS], ['intensity', INTENSITY_WORDS], ['width', WIDTH_WORDS], ['label', LABEL_WORDS], ['type', TYPE_WORDS]];

const COMMENT_MARKERS = ['//', '#', ';', '%'];
const commentMarker = t => COMMENT_MARKERS.find(m => t.startsWith(m));
const toNum = cell => {
  const t = cell === undefined ? '' : String(cell).trim();
  return t === '' ? NaN : Number(t);
};
const isNumericCell = cell => Number.isFinite(toNum(cell));

/**
 * Non-blank lines with their 1-based line numbers in the original text.
 * Comment markers (`#`, `//`, `;`, `%`) are honoured only BEFORE the header (the first content line); after it every
 * non-blank line is data, so a row like `;2;B` is a row with an empty position rather than a vanished comment.
 * Exception: if the very first non-blank line is a comment whose text (marker stripped) names a position-like and an
 * intensity-like column (`# wavelength,intensity,width`), it is used as the header.
 */
function contentLines(text) {
  const out = [];
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);
  let started = false, firstNonBlank = true;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    if (!started) {
      const m = commentMarker(t);
      if (m) {
        if (firstNonBlank) {
          const stripped = t.slice(m.length).trim();
          const { cols } = headerColumns(splitCells(stripped, detectDelimiter(stripped)));
          if (cols.position !== undefined && cols.intensity !== undefined) { out.push({ n: i + 1, t: stripped }); started = true; }
        }
        firstNonBlank = false;
        continue;
      }
      started = true;
    }
    firstNonBlank = false;
    out.push({ n: i + 1, t });
  }
  return out;
}

/** Tab, semicolon or comma (most frequent wins; ties prefer tab, then semicolon); else runs of whitespace. */
function detectDelimiter(line) {
  let best = null, bestCount = 0;
  for (const d of ['\t', ';', ',']) {
    const c = line.split(d).length - 1;
    if (c > bestCount) { best = d; bestCount = c; }
  }
  return best;
}

/** Split into trimmed cells; double quotes protect delimiters in cell text. */
function splitCells(line, delim) {
  if (delim === null) return line.trim().split(/\s+/);
  if (!line.includes('"')) return line.split(delim).map(s => s.trim());
  const cells = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; } else inQ = !inQ;
    } else if (ch === delim && !inQ) { cells.push(cur.trim()); cur = ''; } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

const headerTokens = cell => String(cell).normalize('NFC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

function classifyHeader(cell) {
  for (const tok of headerTokens(cell)) {
    for (const [cat, words] of CATEGORIES) if (words.has(tok)) return { cat, tok };
  }
  return null;
}

/** Column indices by category (first match wins) plus the raw tokens that matched. */
function headerColumns(cells) {
  const cols = {}, toks = {};
  cells.forEach((c, i) => {
    const h = classifyHeader(c);
    if (h && !(h.cat in cols)) { cols[h.cat] = i; toks[h.cat] = h.tok; }
  });
  return { cols, toks };
}

/** Unit named inside a header cell (`wavelength_nm`, `Wavelength [µm]`, `wavenumber cm⁻¹`, `GHz`...), or null. */
function unitFromHeader(cell) {
  const s = String(cell).normalize('NFC').toLowerCase();
  if (/cm\s*(⁻¹|\^?\s*-\s*1)|1\s*\/\s*cm/u.test(s)) return 'cm⁻¹';
  if (/(?<![a-z])ghz(?![a-z])/.test(s)) return 'GHz';
  if (/(?<![a-z])hz(?![a-z])/.test(s)) return 'Hz';
  if (/(?<![a-z])(nm|nanometers?|nanometres?)(?![a-z])/.test(s)) return 'nm';
  if (/(?<![a-z])(µm|μm|um|microns?|micrometers?|micrometres?)(?![a-z])/.test(s)) return 'µm';
  if (/å|å|angstroms?|(?<![a-z])ang(?![a-z])/.test(s)) return 'Å';
  if (/(?<![a-z])wavenumbers?(?![a-z])/.test(s)) return 'cm⁻¹';
  return null;
}

function resolveUnit(headerCell, optUnit, lo, hi) {
  return unitFromHeader(headerCell) || (UNITS.includes(optUnit) ? optUnit : null) || guessUnit(lo, hi);
}

/** Axis from min/max positions padded by 2% of the span each side; a lone position is padded by 1% (or +-1 at 0). */
function paddedAxis(unit, lo, hi) {
  if (hi > lo) { const pad = 0.02 * (hi - lo); return { unit, x0: lo - pad, x1: hi + pad }; }
  const pad = lo === 0 ? 1 : Math.abs(lo) * 0.01;
  return { unit, x0: lo - pad, x1: lo + pad };
}

function lineType(cell) {
  const t = String(cell || '').trim().toLowerCase();
  if (t === 'abs' || t === 'absorption' || t === 'a') return 'abs';
  if (t === 'em' || t === 'emission' || t === 'e') return 'em';
  return undefined;
}

/**
 * Line list: a header row (position + intensity columns required; width/label/type optional), then one line per row.
 * Bad rows are skipped and reported (see the skipping rules below); positions outside any stage are not errors.
 * @returns {{layer, skipped:{count:number, reasons:string[]}}}
 */
export function parseLineList(text, name, opts = {}) {
  const content = contentLines(text);
  if (!content.length) throw new Error('No data rows');
  const delim = detectDelimiter(content[0].t);
  const head = splitCells(content[0].t, delim);
  const { cols } = headerColumns(head);
  if (cols.position === undefined || cols.intensity === undefined) {
    throw new Error('A line list needs a header row naming a position column (wavelength, position, ...) and an intensity column.');
  }
  if (content.length < 2) throw new Error('No data rows');

  const reasons = [];
  let skippedCount = 0;
  const skip = (n, why) => { skippedCount++; if (reasons.length < MAX_REASONS) reasons.push('row ' + n + ': ' + why); };
  const byX = new Map();

  for (let r = 1; r < content.length; r++) {
    const { n, t } = content[r];
    const cells = splitCells(t, delim);
    const cell = c => (c === undefined ? '' : (cells[c] === undefined ? '' : cells[c]));
    const x = toNum(cell(cols.position));
    if (!Number.isFinite(x)) { skip(n, 'position is missing or not a finite number'); continue; }
    const intensity = toNum(cell(cols.intensity));
    if (!Number.isFinite(intensity)) { skip(n, 'intensity is missing or not a finite number'); continue; }
    if (!(intensity > 0)) { skip(n, 'intensity must be greater than zero'); continue; }
    let width;
    if (cols.width !== undefined && cell(cols.width) !== '') {
      width = toNum(cell(cols.width));
      if (!Number.isFinite(width) || !(width > 0)) { skip(n, 'width must be a positive number when given'); continue; }
    }
    const line = { x, intensity };
    if (width !== undefined) line.width = width;
    const label = cols.label !== undefined ? cell(cols.label) : '';
    if (label) line.label = label;
    const type = cols.type !== undefined ? lineType(cell(cols.type)) : undefined;
    if (type) line.type = type;

    const prev = byX.get(x);
    if (!prev) { byX.set(x, line); continue; }
    skip(n, 'duplicate position ' + x + ' merged');
    if (intensity > prev.intensity) byX.set(x, line);
  }

  if (!byX.size) throw new Error(reasons.length ? reasons[0] : 'No data rows');
  const lines = [...byX.values()].sort((a, b) => a.x - b.x);
  const unit = resolveUnit(head[cols.position], opts.unit, lines[0].x, lines[lines.length - 1].x);
  const layer = {
    id: opts.id || slugify(name), name, kind: 'lines', quantity: 'intensity',
    axis: paddedAxis(unit, lines[0].x, lines[lines.length - 1].x), lines,
  };
  return { layer, skipped: { count: skippedCount, reasons } };
}

/**
 * Sampled spectrum from delimited text, with or without a header row.
 * x = first numeric column; y = the column whose header names a value, else the next column.
 */
export function parseCsvSampled(text, name, opts = {}) {
  const content = contentLines(text);
  if (!content.length) throw new Error('Found only 0 numeric rows. Expected two columns: position, value.');
  const delim = detectDelimiter(content[0].t);
  const first = splitCells(content[0].t, delim);
  const hasHeader = !isNumericCell(first[0]);
  const head = hasHeader ? first : null;
  const body = hasHeader ? content.slice(1) : content;
  const firstRow = body.length ? splitCells(body[0].t, delim) : [];
  let xc = firstRow.findIndex(isNumericCell);
  if (xc < 0) xc = 0;
  let yc = -1;
  if (head) yc = head.findIndex((c, i) => i !== xc && headerTokens(c).some(tok => SAMPLED_Y_WORDS.has(tok)));
  if (yc < 0) yc = xc === 0 ? 1 : 0;

  const pts = [];
  for (const { t } of body) {
    const cells = splitCells(t, delim);
    const a = toNum(cells[xc]), b = toNum(cells[yc]);
    if (!Number.isFinite(a) || !Number.isFinite(b) || isNull(b)) continue;
    pts.push([a, b]);
  }
  if (pts.length < 16) throw new Error('Found only ' + pts.length + ' numeric rows. Expected two columns: position, value.');
  pts.sort((p, q) => p[0] - q[0]);
  const x = [], y = [];
  for (const p of pts) { if (x.length && p[0] === x[x.length - 1]) continue; x.push(p[0]); y.push(p[1]); }
  if (x.length < 16 || x[x.length - 1] === x[0]) throw new Error('The position column does not vary.');
  const unit = resolveUnit(head ? head[xc] : '', opts.unit, x[0], x[x.length - 1]);
  return { id: opts.id || slugify(name), name, kind: 'sampled', quantity: 'flux', axis: { unit, x0: x[0], x1: x[x.length - 1] }, x, y };
}

/** Header analysis of the first content line, or null when it is not a non-numeric header with >= 2 columns. */
function peekHeader(text) {
  const content = contentLines(text);
  const first = content[0];
  if (!first) return null;
  const delim = detectDelimiter(first.t);
  const cells = splitCells(first.t, delim);
  if (cells.length < 2 || isNumericCell(cells[0])) return null;
  return { cells, content, delim, ...headerColumns(cells) };
}

const BARE_LINE_WORDS = ['intensity', 'strength', 'amplitude', 'height'];
const DENSE_MIN_ROWS = 64;
const UNIFORM_MAX_GAP_RATIO = 5;

/** True when the data rows (after the header) look like a regularly sampled spectrum: >= 64 distinct finite positions
 *  whose largest gap is at most 5x the median gap. */
function looksSampled(h) {
  const pc = h.cols.position;
  const xs = [];
  for (let i = 1; i < h.content.length; i++) {
    const v = toNum(splitCells(h.content[i].t, h.delim)[pc]);
    if (Number.isFinite(v)) xs.push(v);
  }
  xs.sort((p, q) => p - q);
  const u = xs.filter((v, i) => i === 0 || v !== xs[i - 1]);
  if (u.length < DENSE_MIN_ROWS) return false;
  const gaps = [];
  for (let i = 1; i < u.length; i++) gaps.push(u[i] - u[i - 1]);
  const sorted = gaps.slice().sort((p, q) => p - q);
  const median = sorted[sorted.length >> 1];
  return sorted[sorted.length - 1] <= UNIFORM_MAX_GAP_RATIO * median;
}

/** 'lines' | 'sampled' | null for a headered file with position and intensity-like columns (rule R23, see IMPORTERS). */
function classifyHeadered(text) {
  const h = peekHeader(text);
  if (!h || h.cols.position === undefined || h.cols.intensity === undefined) return null;
  if (h.cols.width !== undefined || h.cols.label !== undefined || h.cols.type !== undefined) return 'lines';
  if (h.cells.length === 2 && BARE_LINE_WORDS.includes(h.toks.intensity)) return looksSampled(h) ? 'sampled' : 'lines';
  return null;
}

/**
 * Detector registry, tried in order; the first whose detect(text) is true parses the text. A FITS parser can be
 * inserted here later as another {name, detect, parse}.
 *  1. line-list    : non-numeric header with a position-like and an intensity-like column, plus either a
 *                    width/fwhm/label/species/type column (always a line list), or the "bare" case: exactly two columns
 *                    whose intensity header is a line-style word (intensity, strength, amplitude, height).
 *                    Bare files are ambiguous, so (R23) a bare file with >= 64 distinct positions whose largest gap is at
 *                    most 5x the median gap is a regularly sampled spectrum and is NOT a line list; it falls through to
 *                    csv-sampled. Fewer rows or irregular spacing stay a line list (e.g. 5 irregular rows, or 100 rows
 *                    with a 5x+ gap). Calling parseLineList directly is never redirected.
 *  2. csv-sampled  : non-numeric header with a flux|value|reflectance|y column, or a dense uniform bare file (above).
 *  3. spectrum-text: anything else, as headerless two-column text (reflectance); throws if it is not one.
 * A header may be a first-line comment (`# wavelength,intensity,width`); comment markers elsewhere count only before it.
 */
export const IMPORTERS = [
  {
    name: 'line-list',
    detect: text => classifyHeadered(text) === 'lines',
    parse: (text, name, opts) => parseLineList(text, name, opts),
  },
  {
    name: 'csv-sampled',
    detect(text) {
      const h = peekHeader(text);
      if (!h) return false;
      if (h.cells.some(c => headerTokens(c).some(tok => ['flux', 'value', 'reflectance', 'y'].includes(tok)))) return true;
      return classifyHeadered(text) === 'sampled';
    },
    parse: (text, name, opts) => ({ layer: parseCsvSampled(text, name, opts) }),
  },
  {
    name: 'spectrum-text',
    detect: () => true,
    parse(text, name, opts = {}) {
      const sp = parseSpectrumText(text, name);
      const unit = UNITS.includes(opts.unit) ? opts.unit : sp.unit;
      return { layer: { id: opts.id || slugify(name), name, kind: 'sampled', quantity: 'reflectance', axis: { unit, x0: sp.x0, x1: sp.x1 }, x: sp.x, y: sp.y } };
    },
  },
];

/** @returns {{layer, skipped?}} from the first matching importer; throws Error with a readable message otherwise. */
export function parseAny(text, name, opts = {}) {
  const imp = IMPORTERS.find(i => i.detect(String(text)));
  if (!imp) throw new Error('Unrecognised file format.');
  return imp.parse(String(text), name, opts);
}
