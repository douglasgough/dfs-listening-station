import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyseSampled } from '../../src/spectrum/analyse.js';
import { parseSpectrumText } from '../../src/spectrum/parse.js';
import { EXAMPLE_LINES, decodeExample } from '../../src/spectrum/examples.js';

const golden = JSON.parse(readFileSync(new URL('../fixtures/prototype-golden.json', import.meta.url), 'utf8'));
// The prototype's EXAMPLES array, snapshotted from the original index.html before it was replaced (cutover).
const protoExamples = JSON.parse(readFileSync(new URL('../fixtures/prototype-examples.json', import.meta.url), 'utf8'));
const TOL = 1e-9;

test('EXAMPLE_LINES match the prototype EXAMPLES array byte for byte', () => {
  assert.equal(EXAMPLE_LINES.length, 8);
  assert.deepEqual(EXAMPLE_LINES, protoExamples);
});

test('every golden example is present in EXAMPLE_LINES', () => {
  const names = EXAMPLE_LINES.map(l => l.split('|')[1]);
  assert.deepEqual(names, Object.keys(golden.examples));
});

for (const line of EXAMPLE_LINES) {
  const key = line.split('|')[1];
  test(`analyseSampled matches prototype golden: ${key}`, () => {
    const exp = golden.examples[key].bands;
    const got = analyseSampled(decodeExample(line), { polarity: 'dips', sens: 0.2 }).bands;
    assert.equal(got.length, exp.length);
    exp.forEach((e, i) => {
      for (const f of ['u', 'depth', 'fwhmU', 'rel']) {
        assert.ok(Math.abs(got[i][f] - e[f]) <= TOL, `${key} band ${i} ${f}: ${got[i][f]} vs ${e[f]}`);
      }
    });
  });
}

test('analyseSampled returns the documented shape', () => {
  const a = analyseSampled(decodeExample(EXAMPLE_LINES[0]), { polarity: 'both', sens: 0.2, M: 256 });
  assert.equal(a.r.length, 256);
  assert.equal(a.d.length, 256);
  assert.equal(a.gx.length, 256);
  assert.ok(a.dmax > 0);
});

test('parseSpectrumText throws on fewer than 16 numeric rows', () => {
  const text = Array.from({ length: 10 }, (_, i) => `${400 + i} ${i}`).join('\n');
  assert.throws(() => parseSpectrumText(text, 't'), /only 10 numeric rows/);
});

test('parseSpectrumText throws on a constant x column', () => {
  const text = Array.from({ length: 20 }, (_, i) => `500 ${i}`).join('\n');
  assert.throws(() => parseSpectrumText(text, 't'), /does not vary/);
});

test('parseSpectrumText parses, sorts, skips comments/nulls and guesses unit', () => {
  const rows = Array.from({ length: 20 }, (_, i) => `${1000 - i * 10}, ${i}`);
  const text = ['# header', ...rows, '500 -999', ''].join('\r\n');
  const sp = parseSpectrumText(text, 'n');
  assert.equal(sp.x.length, 20);
  assert.equal(sp.x0, 810);
  assert.equal(sp.x1, 1000);
  assert.equal(sp.unit, 'nm');
  assert.equal(sp.name, 'n');
});
