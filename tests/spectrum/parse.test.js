import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseSpectrumText, parseLineList, parseCsvSampled, parseAny, IMPORTERS, slugify,
} from '../../src/spectrum/parse.js';
import { EXAMPLE_LINES, EXAMPLE_LAYERS, decodeExample } from '../../src/spectrum/examples.js';
import { isWellFormedLayer, stageAxisFrom, layerOnStage } from '../../src/spectrum/layers.js';
import { analyse } from '../../src/spectrum/analyse.js';

const golden = JSON.parse(readFileSync(new URL('../fixtures/prototype-golden.json', import.meta.url), 'utf8'));
const TOL = 1e-9;

const sampledText = (n = 20, sep = ' ') => Array.from({ length: n }, (_, i) => (400 + i * 10) + sep + (0.5 + i * 0.01)).join('\n');
const sampledCsv = (header, n = 20, sep = ',') => header + '\n' + sampledText(n, sep);

// ---- slugify ----
test('slugify lowercases and collapses non-alphanumerics', () => {
  assert.equal(slugify('Angra dos Reis'), 'angra-dos-reis');
  assert.equal(slugify('  My File (v2).csv '), 'my-file-v2-csv');
});

// ---- parseSpectrumText unchanged ----
test('parseSpectrumText still parses two-column text', () => {
  const sp = parseSpectrumText(sampledText(), 't');
  assert.equal(sp.x.length, 20);
  assert.equal(sp.unit, 'nm');
});

// ---- parseLineList basics ----
test('headered CSV wavelength,intensity,width,label,type -> lines layer', () => {
  const txt = [
    '# a comment',
    'wavelength,intensity,width,label,type',
    '656.28,1.0,0.5,Hα,em',
    '486.13,0.35,0.4,Hβ,emission',
    '588.995,0.8,,Na D2,abs',
    '500.7,0.5,0.3,mystery,',
  ].join('\n');
  const { layer, skipped } = parseLineList(txt, 'My Lines');
  assert.ok(isWellFormedLayer(layer));
  assert.equal(layer.id, 'my-lines');
  assert.equal(layer.name, 'My Lines');
  assert.equal(layer.kind, 'lines');
  assert.equal(layer.quantity, 'intensity');
  assert.equal(layer.axis.unit, 'nm');
  assert.deepEqual(layer.lines.map(l => l.x), [486.13, 500.7, 588.995, 656.28]);
  assert.deepEqual(layer.lines[0], { x: 486.13, intensity: 0.35, width: 0.4, label: 'Hβ', type: 'em' });
  assert.deepEqual(layer.lines[1], { x: 500.7, intensity: 0.5, width: 0.3, label: 'mystery' });
  assert.deepEqual(layer.lines[2], { x: 588.995, intensity: 0.8, label: 'Na D2', type: 'abs' });
  assert.deepEqual(skipped, { count: 0, reasons: [] });
  // axis = min/max padded by 2% of the span
  const span = 656.28 - 486.13;
  assert.ok(Math.abs(layer.axis.x0 - (486.13 - 0.02 * span)) < 1e-9);
  assert.ok(Math.abs(layer.axis.x1 - (656.28 + 0.02 * span)) < 1e-9);
  assert.ok(Array.isArray(layer.lines));
});

test('parseLineList honours opts.id and header-name variants', () => {
  const { layer } = parseLineList('Lambda,Strength,FWHM,Species\n500,2,1,X\n600,1,1,Y', 'n', { id: 'custom' });
  assert.equal(layer.id, 'custom');
  assert.equal(layer.lines[0].label, 'X');
  assert.equal(layer.lines[0].width, 1);
});

test('single-line (one position) layers get a padded axis', () => {
  const { layer } = parseLineList('wavelength,intensity\n500,1', 'one');
  assert.ok(isWellFormedLayer(layer));
  assert.ok(layer.axis.x0 < 500 && layer.axis.x1 > 500);
  const z = parseLineList('position,intensity\n0,1', 'zero').layer;
  assert.deepEqual([z.axis.x0, z.axis.x1], [-1, 1]);
});

// ---- embedded units ----
test('units embedded in the position header', () => {
  const unitOf = (h, v = '5') => parseLineList(`${h},intensity\n${v},1\n${+v + 1},1`, 'u').layer.axis.unit;
  assert.equal(unitOf('wavelength_nm', '500'), 'nm');
  assert.equal(unitOf('Wavelength [µm]', '5'), 'µm');
  assert.equal(unitOf('wavelength (um)', '5'), 'µm');
  assert.equal(unitOf('wavenumber cm⁻¹', '2000'), 'cm⁻¹');
  assert.equal(unitOf('wavenumber_cm-1', '2000'), 'cm⁻¹');
  assert.equal(unitOf('wavenumber', '2000'), 'cm⁻¹');
  assert.equal(unitOf('wavelength Å', '5000'), 'Å');
  assert.equal(unitOf('wavelength (angstrom)', '5000'), 'Å');
  assert.equal(unitOf('freq GHz', '300'), 'GHz');
  assert.equal(unitOf('frequency_Hz', '300'), 'Hz');
});

test('unit falls back to opts.unit then guessUnit', () => {
  const txt = 'wavelength,intensity\n500,1\n600,1';
  assert.equal(parseLineList(txt, 'u').layer.axis.unit, 'nm');
  assert.equal(parseLineList(txt, 'u', { unit: 'Å' }).layer.axis.unit, 'Å');
  assert.equal(parseLineList('wavelength,intensity\n1.5,1\n9,1', 'u').layer.axis.unit, 'µm');
  // embedded unit wins over opts
  assert.equal(parseLineList('wavelength_nm,intensity\n500,1\n600,1', 'u', { unit: 'Å' }).layer.axis.unit, 'nm');
});

// ---- delimiters ----
test('tab, semicolon and whitespace delimiters', () => {
  const rows = [['wavelength', 'intensity', 'label'], ['500', '1', 'A'], ['600', '0.5', 'B']];
  for (const sep of ['\t', ';', ',']) {
    const { layer } = parseLineList(rows.map(r => r.join(sep)).join('\n'), 'd');
    assert.equal(layer.lines.length, 2, JSON.stringify(sep));
    assert.equal(layer.lines[1].label, 'B');
  }
  const ws = parseLineList('wavelength   intensity\n500 1\n600   0.5', 'd').layer;
  assert.equal(ws.lines.length, 2);
});

test('comment styles and CRLF are tolerated', () => {
  const txt = '// c1\r\n% c2\r\n; c3\r\n# c4\r\nwavelength,intensity\r\n\r\n500,1\r\n600,2\r\n';
  const { layer, skipped } = parseLineList(txt, 'c');
  assert.equal(layer.lines.length, 2);
  assert.equal(skipped.count, 0);
});

// ---- RF5 skipping ----
const HDR = 'wavelength,intensity,width,label\n'; // line 1
const rowsOf = (...r) => HDR + r.join('\n');
const survivors = layer => layer.lines.map(l => l.x);

test('RF5: non-numeric position is skipped and reported with its line number', () => {
  const { layer, skipped } = parseLineList(rowsOf('500,1,,A', 'abc,1,,B', '600,1,,C'), 'n');
  assert.deepEqual(survivors(layer), [500, 600]);
  assert.equal(skipped.count, 1);
  assert.equal(skipped.reasons.length, 1);
  assert.match(skipped.reasons[0], /^row 3: /);
});

test('RF5: missing position cell is skipped', () => {
  const { layer, skipped } = parseLineList(rowsOf('500,1,,A', ',1,,B', '600,1,,C'), 'n');
  assert.deepEqual(survivors(layer), [500, 600]);
  assert.equal(skipped.count, 1);
  assert.match(skipped.reasons[0], /^row 3: /);
});

test('RF5: missing/short row (no intensity) is skipped; short rows are padded', () => {
  const { layer, skipped } = parseLineList(rowsOf('500,1,,A', '550', '600,1'), 'n');
  assert.deepEqual(survivors(layer), [500, 600]);
  assert.equal(skipped.count, 1);
  assert.match(skipped.reasons[0], /^row 3: .*intensity/);
});

test('RF5: non-numeric, zero and negative intensity are skipped', () => {
  const { layer, skipped } = parseLineList(rowsOf('500,1,,A', '510,x,,B', '520,0,,C', '530,-2,,D', '540,,,E', '600,1,,F'), 'n');
  assert.deepEqual(survivors(layer), [500, 600]);
  assert.equal(skipped.count, 4);
  assert.deepEqual(skipped.reasons.map(r => +r.match(/^row (\d+):/)[1]), [3, 4, 5, 6]);
});

test('RF5: zero, negative and non-numeric width are skipped; empty width is fine', () => {
  const { layer, skipped } = parseLineList(rowsOf('500,1,0.5,A', '510,1,0,B', '520,1,-1,C', '530,1,wide,D', '540,1,,E', '600,1,2,F'), 'n');
  assert.deepEqual(survivors(layer), [500, 540, 600]);
  assert.equal(layer.lines[1].width, undefined);
  assert.equal(skipped.count, 3);
  assert.deepEqual(skipped.reasons.map(r => +r.match(/^row (\d+):/)[1]), [3, 4, 5]);
  for (const r of skipped.reasons) assert.match(r, /width/);
});

test('RF5: non-finite values are skipped', () => {
  const { layer, skipped } = parseLineList(rowsOf('500,1,,A', 'Infinity,1,,B', '510,NaN,,C', '600,1,,D'), 'n');
  assert.deepEqual(survivors(layer), [500, 600]);
  assert.equal(skipped.count, 2);
});

test('RF5: duplicate positions merge keeping the larger intensity', () => {
  const { layer, skipped } = parseLineList(rowsOf('500,1,,first', '600,2,,B', '500,3,0.4,second', '500,0.5,,third'), 'n');
  assert.deepEqual(survivors(layer), [500, 600]);
  assert.equal(layer.lines[0].intensity, 3);
  assert.equal(layer.lines[0].label, 'second');
  assert.equal(layer.lines[0].width, 0.4);
  assert.equal(skipped.count, 2);
  assert.match(skipped.reasons[0], /^row 4: .*duplicate/);
  assert.match(skipped.reasons[1], /^row 5: .*duplicate/);
});

test('RF5: duplicate keeps first row on equal intensity', () => {
  const { layer, skipped } = parseLineList(rowsOf('500,1,,a', '500,1,,b'), 'n');
  assert.equal(layer.lines.length, 1);
  assert.equal(layer.lines[0].label, 'a');
  assert.equal(skipped.count, 1);
});

test('RF5: reasons are capped at 20 while count stays true', () => {
  const bad = Array.from({ length: 30 }, (_, i) => `x${i},1,,`);
  const { skipped, layer } = parseLineList(rowsOf('500,1,,A', ...bad), 'n');
  assert.equal(layer.lines.length, 1);
  assert.equal(skipped.count, 30);
  assert.equal(skipped.reasons.length, 20);
  assert.match(skipped.reasons[0], /^row 3:/);
});

test('RF5: zero valid rows throws an Error carrying the first reason', () => {
  assert.throws(() => parseLineList(rowsOf('abc,1,,A', '500,0,,B'), 'n'), err => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /row 2: /);
    return true;
  });
});

test('header only throws "No data rows"', () => {
  assert.throws(() => parseLineList('wavelength,intensity', 'n'), /No data rows/);
  assert.throws(() => parseLineList('# c\nwavelength,intensity\n\n', 'n'), /No data rows/);
});

test('positions outside the stage axis are not parser errors', () => {
  const { layer, skipped } = parseLineList('wavelength,intensity\n100,1\n9000,1\n500,1', 'n', { unit: 'nm' });
  assert.equal(layer.lines.length, 3);
  assert.equal(skipped.count, 0);
  assert.ok(isWellFormedLayer(layer));
  // and analysing against a narrower stage just ignores them
  const lay = layerOnStage(layer, { unit: 'nm', x0: 400, x1: 700 });
  assert.deepEqual(lay.lines.map(l => l.x), [500]);
});

// ---- hostile input ----
test('hostile inputs throw clear Errors', () => {
  const garbage = Array.from({ length: 5000 }, (_, i) => String.fromCharCode((i * 7919) % 256)).join('');
  const bin = '\u0000\u0001\u0002��\n\u0000,\u0000;\t\u0000\n'.repeat(500);
  for (const t of ['', '   \n\n', 'hello', garbage, bin, '500,1', 'wavelength,intensity']) {
    assert.throws(() => parseLineList(t, 'h'), Error, JSON.stringify(t.slice(0, 20)));
    assert.throws(() => parseAny(t, 'h'), Error, JSON.stringify(t.slice(0, 20)));
    assert.throws(() => parseCsvSampled(t, 'h'), Error, JSON.stringify(t.slice(0, 20)));
  }
  // not a header for a line list
  assert.throws(() => parseLineList('500,1\n600,2', 'h'), /header/i);
  assert.throws(() => parseLineList('foo,bar\n500,1', 'h'), /position|intensity/i);
});

test('a very long single line terminates', () => {
  const t0 = Date.now();
  const t = 'wavelength,intensity\n' + '1,'.repeat(200000);
  parseLineList(t, 'h'); // one valid row; extra cells ignored
  assert.throws(() => parseAny('x,'.repeat(200000), 'h'), Error);
  assert.throws(() => parseLineList('a,'.repeat(200000), 'h'), Error);
  assert.ok(Date.now() - t0 < 2000);
});

// ---- parseCsvSampled ----
test('parseCsvSampled: headerless', () => {
  const layer = parseCsvSampled(sampledText(20, ','), 'Plain File');
  assert.ok(isWellFormedLayer(layer));
  assert.equal(layer.kind, 'sampled');
  assert.equal(layer.quantity, 'flux');
  assert.equal(layer.id, 'plain-file');
  assert.equal(layer.x.length, 20);
  assert.equal(layer.axis.unit, 'nm');
  assert.equal(layer.axis.x0, 400);
  assert.equal(layer.axis.x1, 590);
});

test('parseCsvSampled: header, unit in header, y column by name, tab and semicolon', () => {
  const rows = Array.from({ length: 20 }, (_, i) => [5 + i, 99, 0.1 * i]);
  for (const sep of [',', '\t', ';']) {
    const txt = ['Wavelength [µm]', 'junk', 'Flux'].join(sep) + '\n' + rows.map(r => r.join(sep)).join('\n');
    const layer = parseCsvSampled(txt, 'h', { id: 'zz' });
    assert.equal(layer.id, 'zz');
    assert.equal(layer.axis.unit, 'µm');
    assert.equal(layer.y[3], 0.30000000000000004);
    assert.equal(layer.x[0], 5);
  }
  // default y column = second column
  const l2 = parseCsvSampled(sampledCsv('lam,sig'), 'h');
  assert.equal(l2.y[0], 0.5);
});

test('parseCsvSampled: sorts, dedupes, drops null/non-finite rows, honours opts.unit', () => {
  const lines = [];
  for (let i = 19; i >= 0; i--) lines.push(`${400 + i * 10},${0.5 + i * 0.01}`);
  lines.push('400,0.9', '410,-9999', '420,abc', '430,');
  const layer = parseCsvSampled(lines.join('\n'), 's', { unit: 'Å' });
  assert.equal(layer.x.length, 20);
  assert.ok(layer.x.every((v, i) => i === 0 || v > layer.x[i - 1]));
  assert.equal(layer.axis.unit, 'Å');
  assert.equal(layer.x[1], 410);
});

test('parseCsvSampled: too few rows / constant x errors', () => {
  assert.throws(() => parseCsvSampled(sampledText(5, ','), 'n'), /Found only 5 numeric rows/);
  const same = Array.from({ length: 20 }, () => '500,1').join('\n');
  assert.throws(() => parseCsvSampled(same, 'n'), /does not vary/);
});

// ---- parseAny ----
test('parseAny routes headered line-list CSV to parseLineList', () => {
  const r = parseAny('wavelength,intensity,label\n500,1,a\n600,2,b', 'n');
  assert.equal(r.layer.kind, 'lines');
  assert.equal(r.skipped.count, 0);
  const r2 = parseAny('wavelength,intensity\n500,1\n600,2', 'n');
  assert.equal(r2.layer.kind, 'lines');
  const r3 = parseAny('position;strength;type\n500;1;em\n600;2;abs', 'n');
  assert.equal(r3.layer.kind, 'lines');
  assert.equal(r3.layer.lines[0].type, 'em');
});

test('parseAny routes headered flux CSV to parseCsvSampled', () => {
  const r = parseAny(sampledCsv('wavelength,flux'), 'n');
  assert.equal(r.layer.kind, 'sampled');
  assert.equal(r.layer.quantity, 'flux');
  assert.equal(r.skipped, undefined);
});

test('parseAny: two-column text still parses as sampled', () => {
  const r = parseAny(sampledText(), 'Two Col');
  assert.ok(isWellFormedLayer(r.layer));
  assert.equal(r.layer.kind, 'sampled');
  assert.equal(r.layer.quantity, 'reflectance');
  assert.equal(r.layer.id, 'two-col');
  assert.equal(r.layer.axis.unit, 'nm');
  assert.equal(r.layer.x.length, 20);
  assert.equal(r.skipped, undefined);
});

test('IMPORTERS is an ordered registry of {name, detect, parse}', () => {
  assert.ok(Array.isArray(IMPORTERS) && IMPORTERS.length >= 3);
  for (const imp of IMPORTERS) {
    assert.equal(typeof imp.name, 'string');
    assert.equal(typeof imp.detect, 'function');
    assert.equal(typeof imp.parse, 'function');
  }
  assert.equal(IMPORTERS[0].name, 'line-list');
});

// ---- EXAMPLE_LAYERS ----
test('EXAMPLE_LAYERS: ten unique, well-formed layers', () => {
  assert.equal(EXAMPLE_LAYERS.length, 10);
  assert.equal(new Set(EXAMPLE_LAYERS.map(l => l.id)).size, 10);
  for (const l of EXAMPLE_LAYERS) assert.ok(isWellFormedLayer(l), l.id);
  assert.equal(EXAMPLE_LAYERS.filter(l => l.kind === 'sampled').length, 8);
  assert.ok(EXAMPLE_LAYERS.some(l => l.id === 'allende' && l.name === 'Allende (CV3)'));
  assert.ok(EXAMPLE_LAYERS.some(l => l.id === 'angra-dos-reis'));
});

for (const line of EXAMPLE_LINES) {
  const key = line.split('|')[1];
  test(`EXAMPLE_LAYERS meteorite reproduces golden: ${key}`, () => {
    const layer = EXAMPLE_LAYERS.find(l => l.id === slugify(key.replace(/_/g, ' ')));
    assert.ok(layer, key);
    assert.equal(layer.kind, 'sampled');
    assert.equal(layer.quantity, 'reflectance');
    assert.equal(layer.axis.unit, 'nm');
    const got = analyse(layer, stageAxisFrom(layer), { polarity: 'dips', sens: 0.2, mode: 'hull' }).bands;
    const exp = golden.examples[key].bands;
    assert.equal(got.length, exp.length);
    exp.forEach((e, i) => {
      for (const f of ['u', 'depth', 'fwhmU', 'rel']) assert.ok(Math.abs(got[i][f] - e[f]) <= TOL, `${key} ${i} ${f}`);
    });
    // matches the decoder directly
    const sp = decodeExample(line);
    assert.equal(layer.name, sp.name);
    assert.deepEqual(layer.x, sp.x);
  });
}

test('EXAMPLE_LAYERS line lists', () => {
  const ism = EXAMPLE_LAYERS.find(l => l.id === 'ism-absorption');
  const neb = EXAMPLE_LAYERS.find(l => l.id === 'nebula-emission');
  assert.equal(ism.name, 'ISM absorption lines (demonstration data, approximate rest wavelengths)');
  assert.equal(neb.name, 'Nebular emission lines (demonstration data, approximate rest wavelengths)');
  for (const l of [ism, neb]) {
    assert.equal(l.kind, 'lines');
    assert.equal(l.quantity, 'intensity');
    assert.deepEqual(l.axis, { unit: 'nm', x0: 380, x1: 700 });
  }
  assert.equal(ism.lines.length, 4);
  assert.ok(ism.lines.every(l => l.type === 'abs'));
  assert.equal(neb.lines.length, 10);
  assert.ok(neb.lines.every(l => l.type === 'em'));
  assert.ok(ism.lines.some(l => l.x === 588.995 && l.intensity === 1.0 && l.label === 'Na I D2'));
  assert.ok(neb.lines.some(l => l.x === 656.28 && l.label === 'Hα'));
  assert.ok(neb.lines.some(l => l.x === 500.7 && l.label === '[O III] 500.7'));

  const n = (layer, polarity) => analyse(layer, stageAxisFrom(layer), { polarity, sens: 0.2 }).bands.length;
  assert.equal(n(ism, 'dips'), 4);
  assert.equal(n(neb, 'peaks'), 10);
  assert.equal(n(neb, 'dips'), 0);
});

// ---- Fix round 1: sampled-vs-lines guard (R23) ----
const bareRows = (header, xs, sep = ',') => header + '\n' + xs.map((x, i) => x + sep + (1 + (i % 7))).join('\n');
const uniform = n => Array.from({ length: n }, (_, i) => 400 + i * 2);

test('R23: 500 uniform wavelength,intensity rows are a sampled spectrum, not 500 lines', () => {
  for (const h of ['wavelength,intensity', 'wavelength,strength', 'wavelength,amplitude', 'wavelength,height']) {
    const r = parseAny(bareRows(h, uniform(500)), 'dense');
    assert.equal(r.layer.kind, 'sampled', h);
    assert.equal(r.layer.x.length, 500);
    assert.ok(isWellFormedLayer(r.layer));
    assert.equal(r.layer.y[1], 2);
  }
});

test('R23: few or irregular rows stay a line list', () => {
  assert.equal(parseAny(bareRows('wavelength,intensity', [500, 510, 650, 700, 720]), 'n').layer.kind, 'lines');
  assert.equal(parseAny('wavelength,intensity\n500,1\n600,2', 'n').layer.kind, 'lines');
  assert.equal(parseAny(bareRows('wavelength,intensity', uniform(63)), 'n').layer.kind, 'lines');
  assert.equal(parseAny(bareRows('wavelength,intensity', uniform(64)), 'n').layer.kind, 'sampled');
  // 100 rows, irregular: gap ratio > 5
  const irr = Array.from({ length: 100 }, (_, i) => 400 + i + (i === 99 ? 300 : 0));
  assert.equal(parseAny(bareRows('wavelength,intensity', irr), 'n').layer.kind, 'lines');
  const geometric = Array.from({ length: 100 }, (_, i) => 400 * Math.pow(1.05, i));
  assert.equal(parseAny(bareRows('wavelength,intensity', geometric), 'n').layer.kind, 'lines');
});

test('R23: extra width/label/type columns always mean a line list', () => {
  const xs = uniform(100);
  const withLabel = 'wavelength,intensity,label\n' + xs.map(x => `${x},1,L`).join('\n');
  assert.equal(parseAny(withLabel, 'n').layer.kind, 'lines');
  const withWidth = 'wavelength,intensity,width\n' + xs.map(x => `${x},1,0.5`).join('\n');
  assert.equal(parseAny(withWidth, 'n').layer.kind, 'lines');
});

test('R23: direct parseLineList is never redirected', () => {
  const { layer } = parseLineList(bareRows('wavelength,intensity', uniform(500)), 'dense');
  assert.equal(layer.kind, 'lines');
  assert.equal(layer.lines.length, 500);
});

test('R23: parseCsvSampled accepts strength/amplitude/height as the y column', () => {
  const txt = 'wavelength,junk,strength\n' + uniform(20).map(x => `${x},99,${x / 1000}`).join('\n');
  assert.equal(parseCsvSampled(txt, 'n').y[0], 0.4);
});

// ---- Fix round 1: comment markers only before the header ----
test('markers after the header are data, not comments (semicolon file with empty position is counted)', () => {
  const txt = 'wavelength;intensity;label\n500;1;A\n;2;B\n600;3;C';
  const { layer, skipped } = parseLineList(txt, 'n');
  assert.deepEqual(layer.lines.map(l => l.x), [500, 600]);
  assert.equal(skipped.count, 1);
  assert.match(skipped.reasons[0], /^row 3: .*position/);
  // '%', '#', '//' leading data rows are counted as skipped too
  const t2 = 'wavelength,intensity\n500,1\n# 7,2\n% 8,2\n// 9,2\n600,1';
  const r2 = parseLineList(t2, 'n');
  assert.equal(r2.layer.lines.length, 2);
  assert.equal(r2.skipped.count, 3);
  assert.deepEqual(r2.skipped.reasons.map(r => +r.match(/^row (\d+):/)[1]), [3, 4, 5]);
});

test('comments before the header are still ignored', () => {
  const { layer, skipped } = parseLineList('# note\n// note\n% note\n; note\nwavelength,intensity\n500,1\n600,1', 'n');
  assert.equal(layer.lines.length, 2);
  assert.equal(skipped.count, 0);
});

// ---- Fix round 1: header written as a comment ----
test('a commented header line is used as the header', () => {
  for (const [mark, sep, row] of [['# ', ',', 'wavelength,intensity,width'], ['#', ' ', 'wavelength intensity width'],
    ['// ', ',', 'wavelength,intensity,width'], ['% ', '\t', 'wavelength\tintensity\twidth'], ['; ', ',', 'wavelength,intensity,width']]) {
    const txt = `${mark}${row}\n500${sep}1${sep}0.5\n600${sep}2${sep}0.6\n`;
    const { layer, skipped } = parseLineList(txt, 'c');
    assert.equal(layer.lines.length, 2, JSON.stringify(mark + row));
    assert.equal(layer.lines[0].width, 0.5);
    assert.equal(skipped.count, 0);
    assert.equal(parseAny(txt, 'c').layer.kind, 'lines');
  }
});

test('a commented header must be the first content and name position and intensity', () => {
  // a generic comment first, then the real header
  assert.equal(parseLineList('# produced by tool\n# wavelength,intensity\nwavelength,intensity\n500,1', 'c').layer.lines.length, 1);
  // not a header: ordinary prose comment, then no header at all -> clear error
  assert.throws(() => parseLineList('# some notes\n500,1\n600,2', 'c'), /header/i);
  // commented header only mentions position
  assert.throws(() => parseLineList('# wavelength,notes\n500,1', 'c'), /header/i);
});

test('commented header works for sampled CSV through parseAny', () => {
  const txt = '# wavelength,flux\n' + uniform(20).map(x => `${x},0.5`).join('\n');
  const r = parseAny(txt, 'c');
  assert.equal(r.layer.kind, 'sampled');
  assert.equal(r.layer.x.length, 20);
});

// ---- Fix round 1: BOM, CRLF, quoting, scale ----
test('UTF-8 BOM before the header (CSV and tab)', () => {
  for (const sep of [',', '\t']) {
    const txt = '﻿' + ['wavelength', 'intensity', 'label'].join(sep) + '\n' + ['500', '1', 'A'].join(sep) + '\n';
    const { layer } = parseLineList(txt, 'b');
    assert.equal(layer.lines.length, 1, JSON.stringify(sep));
    assert.equal(layer.lines[0].label, 'A');
    assert.equal(parseAny(txt, 'b').layer.kind, 'lines');
  }
  const bomComment = '﻿# wavelength,intensity\n500,1\n';
  assert.equal(parseLineList(bomComment, 'b').layer.lines.length, 1);
  const bomSampled = '﻿wavelength,flux\n' + uniform(20).map(x => `${x},1`).join('\n');
  assert.equal(parseAny(bomSampled, 'b').layer.x.length, 20);
});

test('CRLF line endings, including row numbers in reasons', () => {
  const txt = 'wavelength,intensity,label\r\n500,1,A\r\nzzz,1,B\r\n600,2,C\r\n';
  const { layer, skipped } = parseLineList(txt, 'crlf');
  assert.deepEqual(layer.lines.map(l => l.label), ['A', 'C']);
  assert.match(skipped.reasons[0], /^row 3:/);
});

test('quoted fields may contain delimiters', () => {
  const txt = 'wavelength,intensity,label\n588.995,1,"Na I, D2"\n589.592,0.8,"Say ""hi"", ok"\n';
  const { layer } = parseLineList(txt, 'q');
  assert.equal(layer.lines[0].label, 'Na I, D2');
  assert.equal(layer.lines[1].label, 'Say "hi", ok');
  const tab = 'wavelength\tintensity\tlabel\n588.995\t1\t"Na I\tD2"\n';
  assert.equal(parseLineList(tab, 'q').layer.lines[0].label, 'Na I\tD2');
});

test('a 100k-row line list parses in well under 2 s', () => {
  const rows = new Array(100000);
  for (let i = 0; i < rows.length; i++) rows[i] = `${400 + i * 0.003},${1 + (i % 5)},0.01,L${i},em`;
  const txt = 'wavelength,intensity,width,label,type\n' + rows.join('\n');
  const t0 = Date.now();
  const { layer } = parseAny(txt, 'big');
  const dt = Date.now() - t0;
  assert.equal(layer.kind, 'lines');
  assert.equal(layer.lines.length, 100000);
  assert.ok(dt < 2000, `took ${dt} ms`); // generous bound: typically well under 500 ms
});
