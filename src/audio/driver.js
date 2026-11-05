/*
 * Driver: the live scheduler. Every tick it pulls the next span of the score from buildScore and posts
 * the frames to the channel engines, a short lookahead ahead of the audio clock, and pushes the mixer
 * strip settings. It never touches the Transport (start/stop/locate is the UI's job).
 *
 * Time axes
 *   context time  graph.ctx.currentTime (what the engines/worklets are stamped in)
 *   span time     nowSec = context time + clockOffset: the Transport's nowSec axis and buildScore's
 *                 span axis. clockOffset is 0 until setGraph swaps in a rebuilt AudioContext (R18), whose
 *                 clock restarts near 0; the offset keeps span time monotonic across the swap.
 *
 * Frames sit on a grid: each span starts where the previous one ended (cursor), so consecutive ticks
 * never duplicate or skip a frame. Step 0.04 s, 0.025 s while any enabled channel is granular.
 * Mixer settings are pushed whenever they change (and on the first tick of each graph), not every tick,
 * so the AudioParam timelines do not fill with identical automation events.
 */
import { buildScore, DEFAULT_SEED } from '../core/score.js';
import { timeMap } from '../core/transport.js';
import { NUM_CHANNELS } from '../core/schema.js';

export const STEP_SEC = 0.04;
export const GRANULAR_STEP_SEC = 0.025;
/** How far behind now the cursor may fall before the driver gives up on the missed span. */
export const MAX_BEHIND_SEC = 0.25;

/**
 * Next span to schedule, or null when the cursor is already `lookahead` ahead of now.
 * startSec = cursor (or now when the cursor fell more than 0.25 s behind); endSec = startSec + n*step,
 * n = max(1, floor((now + lookahead - startSec)/step)). A 1e-9 tolerance in the floor keeps decimal
 * steps (0.04, 0.025) from losing a frame to rounding.
 */
export function planSpan(cursor, now, lookahead, step) {
  let start = cursor;
  if (start < now - MAX_BEHIND_SEC) start = now;
  if (start >= now + lookahead) return null;
  const n = Math.max(1, Math.floor((now + lookahead - start) / step + 1e-9));
  return { startSec: start, endSec: start + n * step };
}

const toContext = (fr, off) => (off === 0 ? fr : {
  ...fr, t: fr.t - off, events: fr.events.map(e => ({ ...e, t: e.t - off })),
});

export class Driver {
  /**
   * @param o {graph, store, transport, getAnalyses: () => Analysis[4], getStage: () => stage,
   *   cc?: Record|() => Record, seed?, tickMs = 40, lookahead = 0.12, setIntervalFn?, clearIntervalFn?}
   */
  constructor(o) {
    this.graph = o.graph;
    this.store = o.store;
    this.transport = o.transport;
    this.getAnalyses = o.getAnalyses;
    this.getStage = o.getStage;
    this.cc = o.cc;
    this.seed = o.seed ?? DEFAULT_SEED;
    this.tickMs = o.tickMs ?? 40;
    this.lookahead = o.lookahead ?? 0.12;
    this.setIntervalFn = o.setIntervalFn || ((fn, ms) => setInterval(fn, ms));
    this.clearIntervalFn = o.clearIntervalFn || ((id) => clearInterval(id));
    this.clockOffset = 0;
    this.lastNowSec = -Infinity;
    this.cursor = null;
    this.timer = null;
    this._resetGraphState();
  }

  _resetGraphState() {
    this.enabled = new Array(NUM_CHANNELS).fill(true); // a new ChannelEngine starts enabled
    this.mixKey = null;
  }

  start() {
    if (this.timer !== null) return;
    this.timer = this.setIntervalFn(() => this.tick(), this.tickMs);
    this.tick();
  }

  stop() {
    if (this.timer === null) return;
    this.clearIntervalFn(this.timer);
    this.timer = null;
  }

  /** Swap in a rebuilt graph (R18): span time continues from where the old clock left off. */
  setGraph(graph) {
    if (Number.isFinite(this.lastNowSec)) this.clockOffset = this.lastNowSec - graph.ctx.currentTime;
    this.graph = graph;
    this._resetGraphState();
  }

  tick() {
    const { graph, store } = this;
    const ctxTime = graph.ctx.currentTime;
    const nowSec = Math.max(ctxTime + this.clockOffset, this.lastNowSec);
    this.lastNowSec = nowSec;

    const on = [];
    let granular = false;
    for (let c = 0; c < NUM_CHANNELS; c++) {
      on.push(!!store.get(`ch${c + 1}.filter.on`));
      if (on[c] && store.get(`ch${c + 1}.filter.type`) === 'granular') granular = true;
    }
    for (let c = 0; c < NUM_CHANNELS; c++) {
      if (on[c] !== this.enabled[c]) { graph.channels[c].setEnabled(on[c]); this.enabled[c] = on[c]; }
    }

    const step = granular ? GRANULAR_STEP_SEC : STEP_SEC;
    if (this.cursor === null) this.cursor = nowSec;
    const span = planSpan(this.cursor, nowSec, this.lookahead, step);
    if (span) {
      const tm = timeMap(this.transport, nowSec);
      const cc = typeof this.cc === 'function' ? this.cc() : this.cc;
      const frames = buildScore(
        { state: store.state, analyses: this.getAnalyses(), stage: this.getStage() },
        { ...span, stepSec: step }, { tm, seed: this.seed, cc });
      this.cursor = span.endSec;
      const off = this.clockOffset;
      for (let c = 0; c < NUM_CHANNELS; c++) {
        if (!on[c]) continue;
        for (const fr of frames[c]) graph.channels[c].send(toContext(fr, off));
      }
    }

    const strips = [];
    for (let c = 0; c < NUM_CHANNELS; c++) {
      const p = `ch${c + 1}.strip.`;
      strips.push({ fader: store.get(p + 'fader'), pan: store.get(p + 'pan'), mute: store.get(p + 'mute'), solo: store.get(p + 'solo') });
    }
    const master = store.get('g.master.gain');
    const key = JSON.stringify([strips, master]);
    if (key !== this.mixKey) {
      graph.mixer.apply(strips, master, ctxTime);
      this.mixKey = key;
    }
  }
}
