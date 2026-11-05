/*
 * Modulation matrix model: pure helpers (no DOM). The grid is a VIEW of store.state.matrix (a sparse list of
 * {src, dst, amount}); nothing here is stored.
 *
 * Destinations are every schema param flagged modulatable. Sources: the two global LFOs, any number of global MIDI
 * CC sources (g.cc<n>), and each channel's 2 LFOs + 2 envelopes.
 */
import { NUM_CHANNELS, CHANNEL_PARAMS, GLOBAL_PARAMS, modulatableIds, paramDef, pid } from '../core/schema.js';

export const OWNERS = ['g', ...Array.from({ length: NUM_CHANNELS }, (_, i) => `ch${i + 1}`)];
export const ownerLabel = o => (o === 'g' ? 'Global' : `Channel ${o.slice(2)}`);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Owner of a param id or source id: 'g' | 'ch1'..'ch4'. */
export const ownerOf = id => (id.startsWith('g.') ? 'g' : id.slice(0, 3));

/** Every modulatable destination, grouped in schema order: [{owner, id, label, voiceRate}]. */
export function allDestinations() {
  const mod = new Set(modulatableIds()), out = [];
  for (const o of OWNERS) {
    const defs = o === 'g' ? GLOBAL_PARAMS : CHANNEL_PARAMS;
    for (const d of defs) {
      const id = o === 'g' ? `g.${d.key}` : `${o}.${d.key}`;
      if (mod.has(id)) out.push({ owner: o, id, label: paramDef(id).label, voiceRate: !!paramDef(id).voiceRate });
    }
  }
  return out;
}

/**
 * Rows to show. filter: 'all' | 'g' | 'ch1'..'ch4'. collapsed: Set of owners whose group is folded.
 * Returns [{owner, id, label, voiceRate}] (folded groups contribute no rows).
 */
export function destinationRows(filter = 'all', collapsed = new Set()) {
  return allDestinations().filter(d => (filter === 'all' || d.owner === filter) && !collapsed.has(d.owner));
}

const SRC_LABEL = { lfo: 'LFO', env: 'Env' };
export function sourceLabel(src) {
  const m = /^(g|ch\d)\.(lfo|env)(\d)$/.exec(src);
  if (m) return `${SRC_LABEL[m[2]]} ${m[3]}`;
  const c = /^g\.cc(\d+)$/.exec(src);
  return c ? `CC ${c[1]}` : src;
}

/**
 * Columns to show: [{owner, id, label}]. 'all': global LFOs, the CC list, then every channel's sources.
 * A channel filter shows the global sources, that channel's own sources, and any other channel's source that
 * already has a route into a visible row (so cross-channel routes are never hidden).
 */
export function sourceColumns(filter = 'all', routes = [], ccList = []) {
  const ccs = [...new Set([...ccList, ...routes.map(r => /^g\.cc(\d+)$/.exec(r.src)?.[1]).filter(Boolean).map(Number)])].sort((a, b) => a - b);
  const all = [
    { owner: 'g', id: 'g.lfo1' }, { owner: 'g', id: 'g.lfo2' },
    ...ccs.map(n => ({ owner: 'g', id: `g.cc${n}` })),
    ...Array.from({ length: NUM_CHANNELS }, (_, i) => ['lfo1', 'lfo2', 'env1', 'env2'].map(k => ({ owner: `ch${i + 1}`, id: `ch${i + 1}.${k}` }))).flat(),
  ].map(c => ({ ...c, label: sourceLabel(c.id) }));
  if (filter === 'all') return all;
  const rows = new Set(destinationRows(filter).map(d => d.id));
  const used = new Set(routes.filter(r => rows.has(r.dst)).map(r => r.src));
  return all.filter(c => c.owner === 'g' || c.owner === filter || used.has(c.id));
}

/** Map "src|dst" -> amount for O(1) cell lookup. */
export function routeMap(routes) {
  const m = new Map();
  for (const r of routes || []) m.set(`${r.src}|${r.dst}`, r.amount);
  return m;
}

/** Amount after dragging dy pixels (up = positive); 200 px spans the full -1..+1 range; snaps to 1%. */
export function amountFromDrag(startAmount, dy) {
  return clamp(Math.round((startAmount - dy / 100) * 100) / 100, -1, 1);
}

export const formatAmount = a => (Math.abs(a) < 0.005 ? '0%' : `${a > 0 ? '+' : '−'}${Math.round(Math.abs(a) * 100)}%`);

/** Keyboard step (up/down arrows): 5%, Shift 25%. */
export const keyStep = (key, shift) => (key === 'ArrowUp' ? 1 : key === 'ArrowDown' ? -1 : 0) * (shift ? 0.25 : 0.05);

/**
 * Presets for channel ch (0..3). Each returns {mods:[[owner,kind,index,patch]], routes:[{src,dst,amount}]}.
 * - slowSweep: a slow triangle LFO on filter centre (replaces the prototype's Auto-sweep; 60 s per pass = 120 s cycle).
 * - envToEventLevel: restores the default envelope-shaped event level.
 */
export function preset(name, ch) {
  const o = `ch${ch + 1}`;
  if (name === 'slowSweep') return { mods: [[o, 'lfo', 0, { shape: 'tri', rate: { mode: 'sec', value: 120 }, phase: 0.25 }]], routes: [{ src: `${o}.lfo1`, dst: pid(ch, 'filter.center'), amount: 1 }] };
  if (name === 'envToEventLevel') return { mods: [], routes: [{ src: `${o}.env1`, dst: pid(ch, 'event.level'), amount: 1 }] };
  throw new Error(`Unknown preset: ${name}`);
}
export const PRESETS = [['slowSweep', 'Slow sweep'], ['envToEventLevel', 'Envelope to event level']];
