/*
 * Application state, parameter store and patch (v4) serialisation.
 * Pure module: no DOM, no Web Audio.
 *
 * State = {
 *   params:    Record<paramId, value>            every schema id, global and channel
 *   mods:      Record<'g'|'ch1'..'ch4', {lfo: Lfo[], env: Env[]}>
 *   timelines: Timeline[]                        one per channel
 *   pattern:   boolean[][]                       one 16-step row per channel
 *   matrix:    Route[]                           sparse {src, dst, amount}
 *   layers:    string[]                          ids of loaded layers (objects live elsewhere)
 * }
 * Lfo = {shape, rate: TimeValue, phase, seed};  Env = {a, h, d};  Route = {src, dst, amount in [-1,1]}
 * Timeline = {len: TimeValue, mode: 'morph'|'jump', events: object[]}
 */

import { NUM_CHANNELS, paramDef, allParamIds } from './schema.js';

export const PATCH_VERSION = 4;
export const PATCH_APP = 'spectrum-listening-station';
export const PATTERN_STEPS = 16;

const TIME_MODES = ['beats', 'hz', 'sec'];
const TIMELINE_MODES = ['morph', 'jump'];
const DEFAULT_PATTERN_ROW = [1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0].map(Boolean);
const LFO_SHAPES = ['sine', 'tri'];
const SOURCE_RE = /^(g\.lfo[12]|g\.cc\d+|ch[1-4]\.(lfo|env)[12])$/;

const owners = () => ['g', ...Array.from({ length: NUM_CHANNELS }, (_, i) => `ch${i + 1}`)];
const clone = v => JSON.parse(JSON.stringify(v));
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function defaultLfo(n, seedIndex) {
  return { shape: LFO_SHAPES[n % LFO_SHAPES.length], rate: { mode: 'hz', value: 0.1 }, phase: 0, seed: 17 + 1000 * seedIndex };
}
const defaultEnv = () => ({ a: 0.03, h: 0, d: 1.2 });

export function createState() {
  const params = {};
  for (const id of allParamIds()) params[id] = clone(paramDef(id).default);

  const mods = {};
  let seedIndex = 0;
  for (const o of owners()) {
    mods[o] = {
      lfo: [0, 1].map(n => defaultLfo(n, seedIndex++)),
      env: o === 'g' ? [] : [defaultEnv(), defaultEnv()],
    };
  }

  const matrix = Array.from({ length: NUM_CHANNELS }, (_, i) =>
    ({ src: `ch${i + 1}.env1`, dst: `ch${i + 1}.event.level`, amount: 1 }));

  return {
    params,
    mods,
    timelines: Array.from({ length: NUM_CHANNELS }, () => ({ len: { mode: 'sec', value: 32 }, mode: 'morph', events: [] })),
    pattern: Array.from({ length: NUM_CHANNELS }, () => [...DEFAULT_PATTERN_ROW]),
    matrix,
    layers: [],
  };
}

// ---- value and route validation ------------------------------------------------------------

function isTimeValue(v) {
  return isObj(v) && TIME_MODES.includes(v.mode);
}

/** Validate/normalise a value for a def. Throws Error on a value that cannot be accepted. */
function normalize(id, def, v) {
  switch (def.type) {
    case 'num':
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${id}: expected a finite number, got ${String(v)}`);
      return clamp(v, def.min, def.max);
    case 'enum':
      if (!def.options.includes(v)) throw new Error(`${id}: ${JSON.stringify(v)} is not one of ${JSON.stringify(def.options)}`);
      return v;
    case 'bool':
      return Boolean(v);
    case 'time':
      if (!isTimeValue(v)) throw new Error(`${id}: expected a time value with mode beats|hz|sec`);
      return clone(v);
    case 'id':
      if (typeof v !== 'string') throw new Error(`${id}: expected a string id`);
      return v;
    default:
      throw new Error(`${id}: unsupported param type ${def.type}`);
  }
}

/** Returns an error string for an invalid route, or null. Does not touch amount. */
function routeProblem(r) {
  if (!isObj(r)) return 'route is not an object';
  if (typeof r.src !== 'string' || !SOURCE_RE.test(r.src)) return `invalid route source: ${String(r.src)}`;
  const def = typeof r.dst === 'string' ? paramDef(r.dst) : undefined;
  if (!def) return `invalid route destination (unknown parameter): ${String(r.dst)}`;
  if (!def.modulatable) return `invalid route destination (not modulatable): ${r.dst}`;
  if (typeof r.amount !== 'number' || !Number.isFinite(r.amount)) return `invalid route amount for ${r.src} -> ${r.dst}`;
  return null;
}

/** Insert or replace a route (clamping amount). Returns true if the list changed. */
function putRoute(matrix, r) {
  const route = { src: r.src, dst: r.dst, amount: clamp(r.amount, -1, 1) };
  const i = matrix.findIndex(m => m.src === route.src && m.dst === route.dst);
  if (i < 0) { matrix.push(route); return true; }
  if (matrix[i].amount === route.amount) return false;
  matrix[i] = route;
  return true;
}

// ---- store ---------------------------------------------------------------------------------

export function createStore(state) {
  const subs = new Set();
  const defOf = id => {
    const def = paramDef(id);
    if (!def) throw new Error(`Unknown parameter id: ${id}`);
    return def;
  };
  const notify = (id, value) => { for (const fn of [...subs]) fn(id, value); };
  return {
    state,
    get(id) {
      defOf(id);
      return state.params[id];
    },
    set(id, v) {
      const value = normalize(id, defOf(id), v);
      state.params[id] = value;
      notify(id, value);
    },
    subscribe(fn) {
      subs.add(fn);
      return () => { subs.delete(fn); };
    },
    addRoute(r) {
      const problem = routeProblem(r);
      if (problem) throw new Error(problem);
      if (putRoute(state.matrix, r)) notify('matrix', clone(state.matrix));
    },
    removeRoute(src, dst) {
      const next = state.matrix.filter(m => !(m.src === src && m.dst === dst));
      if (next.length === state.matrix.length) return;
      state.matrix = next;
      notify('matrix', clone(next));
    },
  };
}

// ---- patch ---------------------------------------------------------------------------------

export function serializePatch(state, layers = []) {
  return JSON.stringify({
    v: PATCH_VERSION,
    app: PATCH_APP,
    params: state.params,
    mods: state.mods,
    timelines: state.timelines,
    pattern: state.pattern,
    matrix: state.matrix,
    layers,
  });
}

const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

function loadMods(src, out) {
  if (!isObj(src)) return;
  let seedIndex = 0;
  for (const o of owners()) {
    const m = isObj(src[o]) ? src[o] : {};
    const lfo = Array.isArray(m.lfo) ? m.lfo : out[o].lfo;
    out[o].lfo = lfo.map((l, n) => {
      const d = defaultLfo(n, seedIndex + n);
      if (!isObj(l)) return d;
      return {
        shape: typeof l.shape === 'string' ? l.shape : d.shape,
        rate: isTimeValue(l.rate) ? clone(l.rate) : d.rate,
        phase: num(l.phase, d.phase),
        seed: num(l.seed, d.seed),
      };
    });
    seedIndex += 2;
    const env = Array.isArray(m.env) ? m.env : out[o].env;
    out[o].env = env.map(e => {
      const d = defaultEnv();
      return isObj(e) ? { a: num(e.a, d.a), h: num(e.h, d.h), d: num(e.d, d.d) } : d;
    });
  }
}

export function deserializePatch(text) {
  let p;
  try { p = JSON.parse(text); } catch (e) { throw new Error(`Patch is not valid JSON: ${e.message}`); }
  if (!isObj(p)) throw new Error('Patch must be a JSON object');
  if (p.app !== PATCH_APP) throw new Error(`Not a ${PATCH_APP} patch (app is ${JSON.stringify(p.app)})`);
  if (p.v !== PATCH_VERSION) throw new Error(`Unsupported patch version v${String(p.v)}; this build reads v${PATCH_VERSION} only`);

  const state = createState();
  const warnings = [];

  if (isObj(p.params)) {
    for (const [id, v] of Object.entries(p.params)) {
      const def = paramDef(id);
      if (!def) { warnings.push(`Skipped unknown parameter: ${id}`); continue; }
      try { state.params[id] = normalize(id, def, v); } catch (e) { warnings.push(`Kept default for ${id}: ${e.message}`); }
    }
  }

  loadMods(p.mods, state.mods);

  if (Array.isArray(p.timelines)) {
    state.timelines = state.timelines.map((d, i) => {
      const t = p.timelines[i];
      if (!isObj(t)) return d;
      return {
        len: isTimeValue(t.len) ? clone(t.len) : d.len,
        mode: TIMELINE_MODES.includes(t.mode) ? t.mode : d.mode,
        events: Array.isArray(t.events) ? clone(t.events) : [],
      };
    });
  }

  if (Array.isArray(p.pattern)) {
    state.pattern = state.pattern.map((d, i) => {
      const row = p.pattern[i];
      return Array.isArray(row) ? Array.from({ length: PATTERN_STEPS }, (_, s) => Boolean(row[s])) : d;
    });
  }

  if (Array.isArray(p.matrix)) {
    state.matrix = [];
    for (const r of p.matrix) {
      const problem = routeProblem(r);
      if (problem) warnings.push(`Dropped route: ${problem}`);
      else putRoute(state.matrix, r);
    }
  }

  const layers = [];
  if (Array.isArray(p.layers)) {
    for (const l of p.layers) {
      if (isObj(l) && typeof l.id === 'string') layers.push(clone(l));
      else warnings.push('Dropped layer without a string id');
    }
  }
  state.layers = layers.map(l => l.id);

  return { state, layers, warnings };
}
