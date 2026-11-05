// Captures "golden" outputs from the prototype (index.html lines 422-724) so the
// rebuilt ES modules can be proven to reproduce it. Run: node tools/capture-golden.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const lines = readFileSync(join(root, 'index.html'), 'utf8').split('\n');
// 1-indexed lines 422..724 inclusive: constants, state, helpers, parsing, analyse().
const src = lines.slice(421, 724).join('\n');
const names = 'EXAMPLES, decodeExample, analyse, winTrack, grainsAt, lfoVal, mapF, snapF, P, S';
const proto = vm.runInNewContext(`${src}\n;({ ${names} });`, { Math, JSON, Float64Array }, { filename: 'index.html' });
const { EXAMPLES, decodeExample, analyse, winTrack, grainsAt, lfoVal, mapF, snapF, P, S } = proto;

// Default analysis settings are polarity 'dips', sensitivity 0.2.
if (S.pol !== 'dips' || S.sens !== 0.2) throw new Error('prototype defaults changed');

const examples = {};
for (const line of EXAMPLES) {
  const name = line.split('|')[1];
  const { bands } = analyse(decodeExample(line));
  examples[name] = { bands: bands.map(({ u, depth, fwhmU, rel }) => ({ u, depth, fwhmU, rel })) };
}

const allendeLine = EXAMPLES.find(l => l.split('|')[1] === 'Allende');
const allendeBands = examples.Allende.bands;

// winTrack for filter 0 at 16 evenly spaced u (i/15, endpoints included), fon=[true,false,false,false].
const fon = [true, false, false, false];
const win = Array.from({ length: 16 }, (_, i) => { const u = i / 15; return { u, gain: winTrack(u, P, 0, fon) }; });

// Grains of filter 0 with default granular settings at t=3.0, free-running (L=0).
const grains = grainsAt(0, P, S.gran[0], 3.0, 0);

// lfoVal for each of the 6 shapes using the default LFO 1 settings (rate .1, ph 0, seed 17), L=0.
const lfo = [];
for (const shape of ['sine', 'tri', 'ramp', 'square', 'steps', 'drift'])
  for (const t of [0, 0.7, 3.3]) lfo.push({ shape, t, v: lfoVal({ ...S.lfo[0], shape }, t, 0) });

// Band centre frequency: mapF then snapF, as the prototype does for every band.
const freqs = allendeBands.map(b => ({ u: b.u, f: snapF(mapF(b.u, P, S.flip, S.curve), P, P.snap) }));

const out = { examples, allende: { win, grains, lfo, freqs } };
const dest = join(root, 'tests', 'fixtures', 'prototype-golden.json');
mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest, JSON.stringify(out, null, 2) + '\n');
console.log(`wrote ${dest}: ${Object.keys(examples).length} examples, Allende ${allendeBands.length} bands, ${grains.length} grains`);
if (Object.keys(examples).length !== 8 || allendeBands.length < 1 || !allendeLine) process.exit(1);
