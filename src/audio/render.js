/*
 * Offline render of a take or a seamless loop to Float32 channels (Task 16). No top-level browser
 * globals (OfflineAudioContext is looked up when renderOffline runs).
 *
 * Both kinds build ONE score over the whole render (buildScore), send every frame/event to the four
 * ChannelEngines, schedule the mixer, await each engine's flush ack, then startRendering.
 * Loop: PRE s of pre-roll then L s; the loop timeline starts at render time PRE (loopOffset = PRE);
 * the beat grid is aligned so beat 0 is at PRE (Transport.locate(0, PRE); start(PRE)) while the
 * seconds axis stays render time, so evaluate's sec (= secAt - loopOffset) is the loop time.
 */
import { createGraph } from './graph.js';
import { buildScore, resolveAt } from '../core/score.js';
import { Transport, timeMap } from '../core/transport.js';
import { NUM_CHANNELS } from '../core/schema.js';

export const SAMPLE_RATE = 48000;
export const PRE_ROLL_SEC = 7;
export const FALLBACK_LOOP_SEC = 8;
const MIX_STEP = 0.1;

const posFinite = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Loop length in seconds (R8): synced = bars*4*60/bpm, free = seconds; bad input gives 8 s. */
export function loopLengthSec({ synced, bars, seconds, bpm } = {}) {
  if (synced) {
    if (!posFinite(bars) || !posFinite(bpm)) return FALLBACK_LOOP_SEC;
    return bars * 4 * 60 / bpm;
  }
  return posFinite(seconds) ? seconds : FALLBACK_LOOP_SEC;
}

function stripsOf(values) {
  return Array.from({ length: NUM_CHANNELS }, (_, c) => {
    const p = `ch${c + 1}.strip.`;
    return { fader: values[p + 'fader'], pan: values[p + 'pan'], mute: values[p + 'mute'], solo: values[p + 'solo'] };
  });
}

function maxEnvLife(state) {
  let m = 0;
  for (let c = 1; c <= NUM_CHANNELS; c++) {
    const mods = state.mods && state.mods[`ch${c}`];
    for (const e of (mods && Array.isArray(mods.env) ? mods.env : [])) {
      const a = Number.isFinite(e.a) ? e.a : 0, h = Number.isFinite(e.h) ? e.h : 0, d = Number.isFinite(e.d) ? e.d : 0;
      m = Math.max(m, a + h + 4 * d);
    }
  }
  return m;
}

/**
 * @param project {state, analyses[4], stage}
 * @param kind 'take' | 'loop'
 * @param opts {stereo, bars?, seconds?, synced?, take?, bpm?, seed?, fadeSec = 2, onProgress?}
 * @param opts.debugCapture  also return `raw` (un-normalised, whole render) and `preSamples` (loop start index)
 * @returns {chans, peak (raw, all channels), rms (channel 0, normalised), sampleRate, lengthSec}
 */
export async function renderOffline(project, kind, opts = {}) {
  if (kind !== 'take' && kind !== 'loop') throw new Error(`renderOffline: unknown kind ${String(kind)}`);
  const { state } = project;
  const stereo = opts.stereo !== false, fadeSec = opts.fadeSec ?? 2, progress = opts.onProgress || (() => {});
  const bpm = opts.bpm ?? state.params['g.transport.bpm'];
  const loop = kind === 'loop', take = opts.take;
  if (!loop && !take) throw new Error("renderOffline: kind 'take' needs opts.take");

  let L = 0, total, outStart, outLen, tm;
  const tr = new Transport({ bpm });
  if (loop) {
    L = loopLengthSec({ synced: opts.synced, bars: opts.bars, seconds: opts.seconds, bpm: tr.bpm });
    total = PRE_ROLL_SEC + L;
    outStart = Math.round(PRE_ROLL_SEC * SAMPLE_RATE);
    outLen = Math.round(L * SAMPLE_RATE);
    tr.locate(0, PRE_ROLL_SEC);
    tr.start(PRE_ROLL_SEC);
    const beatTm = timeMap(tr, PRE_ROLL_SEC);
    // render-time seconds (so evaluate's sec = loop time); beats grid-aligned at PRE; nowSec/sec describe that axis
    tm = Object.freeze({ ...beatTm, nowSec: 0, sec: 0, secAt: (t) => t });
  } else {
    const keep = clamp(maxEnvLife(state), 3, 20);
    total = take.dur + keep + 1;
    outStart = 0;
    outLen = Math.round((take.dur + keep) * SAMPLE_RATE);
    tr.start(0);
    tm = timeMap(tr, 0);
  }

  const OAC = globalThis.OfflineAudioContext;
  if (!OAC) throw new Error('renderOffline needs OfflineAudioContext');
  const ctx = new OAC(stereo ? 2 : 1, Math.ceil(total * SAMPLE_RATE), SAMPLE_RATE);
  const g = await createGraph({ live: false, ctx, stereo, loopSec: L, seed: opts.seed });
  try {
    progress(0.05);
    const granular = Array.from({ length: NUM_CHANNELS }, (_, c) => c)
      .some((c) => state.params[`ch${c + 1}.filter.on`] && state.params[`ch${c + 1}.filter.type`] === 'granular');
    const sOpts = { tm, seed: opts.seed, take, loopSec: loop ? L : undefined, loopOffset: loop ? PRE_ROLL_SEC : undefined };
    const frames = buildScore(project, { startSec: 0, endSec: total, stepSec: granular ? 0.025 : 0.04 }, sOpts);
    progress(0.2);
    for (let c = 0; c < NUM_CHANNELS; c++) {
      if (!state.params[`ch${c + 1}.filter.on`]) g.channels[c].setEnabled(false);
      for (const fr of frames[c]) g.channels[c].send(fr);
    }

    const rOpts = { tm, take, loopSec: sOpts.loopSec, loopOffset: sOpts.loopOffset };
    let prev = null;
    for (let i = 0; i * MIX_STEP < total; i++) {
      const t = i * MIX_STEP;
      const v = resolveAt(project, t, rOpts), strips = stripsOf(v), master = v['g.master.gain'];
      const key = JSON.stringify([strips, master]);
      if (key === prev) continue;
      prev = key;
      g.mixer.apply(strips, master, t, i === 0);
    }
    await Promise.all(g.channels.map((ch) => ch.flush()));
    progress(0.3);
    const buf = await ctx.startRendering();
    progress(0.9);

    const raw = opts.debugCapture ? Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c).slice()) : null;
    const chans = [];
    for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c).slice(outStart, outStart + outLen));
    let peak = 0;
    for (const d of chans) for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
    const gain = 0.5 / Math.max(peak, 1e-9);
    for (const d of chans) for (let i = 0; i < d.length; i++) d[i] *= gain;
    if (!loop && fadeSec > 0) {
      for (const d of chans) {
        const n = Math.min(Math.round(fadeSec * SAMPLE_RATE), d.length >> 1);
        for (let i = 0; i < n; i++) { const f = 0.5 - 0.5 * Math.cos(Math.PI * i / n); d[i] *= f; d[d.length - 1 - i] *= f; }
      }
    }
    let ss = 0;
    const d0 = chans[0];
    for (let i = 0; i < d0.length; i++) ss += d0[i] * d0[i];
    progress(1);
    const res = { chans, peak, rms: Math.sqrt(ss / Math.max(1, d0.length)), sampleRate: SAMPLE_RATE, lengthSec: d0.length / SAMPLE_RATE };
    if (raw) { res.raw = raw; res.preSamples = outStart; }
    return res;
  } finally {
    await g.dispose();
  }
}
