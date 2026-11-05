/*
 * The audio graph: four ChannelEngines -> Mixer (fixed-order 'mixer-bus' worklet) -> master -> output.
 * live: a new AudioContext (latencyHint 'interactive'), with compressor and analysers.
 * offline: the caller's OfflineAudioContext (opts.ctx), no compressor, no analysers.
 * Channel i's synth seed is seed + i (default seed 20261027, the prototype's).
 * Loading from file:// (or any worklet module load failure) throws FILE_PROTOCOL_ERROR (R31.4).
 */
import { NUM_CHANNELS } from '../core/schema.js';
import { addModuleOnce } from './worklet-loader.js';
import { ChannelEngine, channelVoiceUrl } from './channel-engine.js';
import { Mixer, mixerBusUrl } from './mixer.js';

export const DEFAULT_GRAPH_SEED = 20261027;
export const FILE_PROTOCOL_MESSAGE = 'Serve this app over HTTP(S) (the audio engine cannot load from a file)';

/**
 * @param o {live, stereo = true, loopSec?, ctx? (required when !live), seed = 20261027, plain = false, stats = false}
 * @returns Promise<{ctx, channels: ChannelEngine[4], mixer: Mixer, dispose()}>
 */
export async function createGraph({ live, stereo = true, loopSec = 0, ctx, seed = DEFAULT_GRAPH_SEED, plain = false, stats = false } = {}) {
  if (typeof location !== 'undefined' && location.protocol === 'file:') throw new Error(FILE_PROTOCOL_MESSAGE);
  if (!live && !ctx) throw new Error('createGraph: an offline graph needs opts.ctx (an OfflineAudioContext)');
  const own = !!live && !ctx;
  if (own) ctx = new AudioContext({ latencyHint: 'interactive' });
  const closeOwn = () => {
    if (!own) return;
    try { const p = ctx.close(); if (p && p.catch) p.catch(() => {}); } catch { /* closing is best effort */ }
  };
  try {
    await Promise.all([addModuleOnce(ctx, channelVoiceUrl()), addModuleOnce(ctx, mixerBusUrl())]);
  } catch (e) {
    closeOwn();
    throw new Error(FILE_PROTOCOL_MESSAGE, { cause: e });
  }
  let mixer = null;
  const channels = [];
  try {
    mixer = new Mixer(ctx, ctx.destination, { stereo, live: !!live });
    for (let i = 0; i < NUM_CHANNELS; i++) {
      const ch = new ChannelEngine(ctx, { stereo, seed: seed + i, loopSec, plain, stats });
      channels.push(ch);
      ch.connect(mixer.input(i));
    }
  } catch (e) {
    // any failure after the context exists: release what was built and close a context we own
    for (const ch of channels) { try { ch.dispose(); } catch { /* already broken */ } }
    if (mixer) { try { mixer.dispose(); } catch { /* already broken */ } }
    closeOwn();
    throw e;
  }
  return {
    ctx, channels, mixer,
    dispose() {
      for (const ch of channels) ch.dispose();
      mixer.dispose();
      if (own) return ctx.close().catch(() => {});
      return Promise.resolve();
    },
  };
}
