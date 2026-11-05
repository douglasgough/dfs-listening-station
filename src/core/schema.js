/*
 * Parameter schema: the single source of truth for every parameter.
 * Sliders, modulation destinations, patch keys and tooltips are all generated from it.
 *
 * ParamDef = {
 *   key, label, unit, min, max, default, modulatable, voiceRate?, tip,
 *   type: 'num' | 'enum' | 'bool' | 'time' | 'id', options?
 * }
 *
 * Consumer notes:
 * - min/max are only meaningful for type 'num'. For 'enum', 'bool', 'time' and 'id'
 *   they are null: do not range-check or clamp those types.
 * - 'enum' defs carry `options` (the allowed values; default is one of them).
 * - 'time' defaults are objects, {mode:'beats', div:'1/4'} (synced) or a free value
 *   object; their range is defined by the time-value system, not by min/max.
 * - 'id' params hold an identifier string (e.g. a spectrum layer id), 'none' when unset.
 * - `modulatable` params appear as modulation-matrix destinations; `voiceRate` marks
 *   a destination evaluated per voice instead of per control frame.
 * - Ids are 'chN.<key>' (N is 1-based) for channel params and 'g.<key>' for globals.
 */

export const NUM_CHANNELS = 4;

const num = (key, label, unit, min, max, def, modulatable, tip, extra = {}) =>
  ({ key, label, unit, min, max, default: def, modulatable, tip, type: 'num', ...extra });
const en = (key, label, options, def, tip) =>
  ({ key, label, unit: '', min: null, max: null, default: def, modulatable: false, tip, type: 'enum', options });
const bool = (key, label, def, tip) =>
  ({ key, label, unit: '', min: null, max: null, default: def, modulatable: false, tip, type: 'bool' });
const time = (key, label, tip) =>
  ({ key, label, unit: '', min: null, max: null, default: { mode: 'beats', div: '1/4' }, modulatable: false, tip, type: 'time' });

export const CHANNEL_PARAMS = [
  // source
  { key: 'source.layer', label: 'Spectrum layer', unit: '', min: null, max: null, default: 'none', modulatable: false,
    tip: 'Which loaded spectrum this channel listens to. None means the channel is silent.', type: 'id' },
  en('source.polarity', 'Features', ['dips', 'peaks', 'both'], 'dips',
    'Which spectral features become voices: absorption dips, emission peaks, or both.'),
  num('source.sens', 'Band sensitivity', '', 0.03, 0.8, 0.2, false,
    'How many bands are found. Lower finds more, including faint ones.'),
  en('source.mode', 'Source mode', ['hull', 'direct'], 'hull',
    'Hull measures band depth against the spectrum continuum. Direct uses the raw values.'),
  num('source.shift', 'Velocity shift', 'km/s', -3000, 3000, 0, true,
    'Shifts what this channel hears along the spectrum, as a velocity in km per second. Positive and negative move in opposite directions.'),

  // filter
  bool('filter.on', 'Enabled', true, 'Turn this channel\'s filter on or off. Enabled filters are added together.'),
  en('filter.type', 'Filter type', ['window', 'granular'], 'window',
    'Window stays where you put it. Granular scatters short grains of window across a region of the spectrum.'),
  num('filter.center', 'Center', '', 0, 1, 0.5, true,
    'Where the filter sits along the spectrum. Only what is inside its window is heard.'),
  num('filter.width', 'Width', '', 0.02, 1, 0.3, true,
    'How much of the spectrum the filter passes. Fully open means no filtering.'),
  num('filter.soft', 'Edge softness', '', 0, 1, 0.35, true,
    'How gradually the filter edges fade. 0 is a hard edge.'),
  num('filter.level', 'Level', '', 0, 1, 1, true,
    'How strongly this filter passes the spectrum. Several filters add together.'),

  // vertical window
  en('vwin.mode', 'Vertical window', [0, 1, 2], 0,
    'Off applies only the horizontal window. Reflectance gates by value. Depth gates by absorption depth.'),
  num('vwin.center', 'Vertical center', '', 0, 1, 0.5, true,
    'Where the vertical window sits, from weakest to strongest value of the chosen channel.'),
  num('vwin.height', 'Vertical height', '', 0.02, 1, 1, true,
    'How wide the vertical window is. Fully open passes every value.'),
  num('vwin.soft', 'Vertical softness', '', 0, 1, 0.35, false,
    'How gradually the vertical window fades at its edges. 0 is a hard gate.'),

  // grain
  num('grain.size', 'Grain size', '', 0, 1, 0.4, true, 'Width of each grain of window.'),
  num('grain.density', 'Density', '', 0, 1, 0.5, true, 'How many grains start each second.'),
  num('grain.scatter', 'Scatter', '', 0, 1, 0.7, true,
    'How far grains stray from the playhead inside the region. 100 percent fills the region at random.'),
  num('grain.speed', 'Playhead drift', '', -0.5, 0.5, 0, false,
    'Speed of a playhead that carries grains across the region. Still means grains cluster at the region center.'),
  num('grain.dur', 'Grain time', 's', 0.05, 4, 1.2, false,
    'How long each grain lasts. It swells and fades in that time.'),
  num('grain.jitter', 'Size jitter', '', 0, 1, 0.4, false, 'Random variation in grain size.'),

  // map
  num('map.f0', 'Fundamental', 'Hz', 12, 110, 27.5, false, 'The base note of the harmonic series that pitches snap to.'),
  num('map.lo', 'Low end', 'Hz', 40, 800, 110, false, 'The pitch at the low end of the mapped range.'),
  num('map.hi', 'High end', 'Hz', 800, 9000, 3520, false, 'The pitch at the high end of the mapped range.'),
  num('map.snap', 'Snap to harmonics', '', 0, 1, 1, false,
    'How strongly pitches are pulled onto exact harmonics of the fundamental. 0 keeps the raw mapped pitch.'),
  en('map.curve', 'Curve', ['log', 'lin'], 'log',
    'Logarithmic spaces the spectrum evenly by octave. Linear spaces it evenly in Hz.'),
  bool('map.flip', 'Flip direction', false, 'Reverse which end of the spectrum is the low pitch.'),

  // drone
  num('drone.bands', 'Bands', '', 0, 1, 0.8, true, 'Level of the sustained tones placed on detected bands.'),
  num('drone.comb', 'Comb', '', 0, 1, 0.25, true,
    'Level of 64 fine partials that sample the whole spectrum under the filter.'),
  en('drone.combSrc', 'Comb follows', ['depth', 'refl'], 'depth',
    'What the comb partials follow: how deep the absorption is, or the raw reflectance level.'),
  num('drone.noise', 'Noise bed', '', 0, 1, 0.3, true, 'Level of the filtered noise bed shaped by the spectrum.'),
  num('drone.anchor', 'Anchor', '', 0, 1, 0.4, true, 'Level of two low sine tones at 2 and 4 times the fundamental.'),
  num('drone.beat', 'Beating', '', 0, 1, 0.5, false,
    'Detuning between sister oscillators, which makes slow beating.'),

  // event
  en('event.mode', 'Event timing', ['random', 'regular', 'pattern'], 'random',
    'Random events arrive at an average rate. Regular events arrive at a steady interval. Pattern follows a step pattern you draw.'),
  num('event.rpm', 'Rate', 'per min', 0.5, 60, 6, false,
    'Average number of scheduled events per minute. Chance then thins them.'),
  time('event.interval', 'Interval', 'Time between events.'),
  num('event.jitter', 'Jitter', '', 0, 1, 0.3, false,
    'Random delay added to each event, as a share of the interval.'),
  num('event.steps', 'Steps', '', 2, 16, 8, false, 'Number of steps in the pattern, 2 to 16.'),
  time('event.stepLen', 'Step length', 'Duration of one pattern step.'),
  num('event.chance', 'Chance', '', 0, 1, 0.6, true,
    'Probability that a scheduled event actually sounds.'),
  num('event.level', 'Level', '', 0, 1, 0.6, true, 'Loudness of events.', { voiceRate: true }),
  num('event.octave', 'Pitch', 'octaves', -1, 2, 1, false, 'Pitch of an event relative to the band it comes from, in octaves.'),

  // strip
  num('strip.fader', 'Track level', '', 0, 1, 60 / 66, true,
    'Track level. Double-click for 0 dB.'),
  num('strip.pan', 'Pan', '', -1, 1, 0, false, 'Where this channel sits between left and right.'),
  bool('strip.mute', 'Mute', false, 'Silence this channel.'),
  bool('strip.solo', 'Solo', false, 'Hear only soloed channels.'),
  num('strip.balance', 'Drone / events', '', 0, 1, 0.5, false,
    'Balance between the sustained drone and the events in this channel.'),
];

export const GLOBAL_PARAMS = [
  num('master.gain', 'Output level', '', 0, 1, 0.7, true, 'Overall level.'),
  num('transport.bpm', 'Tempo', 'BPM', 20, 300, 120, false, 'Tempo of the transport. Synced times follow it.'),
];

/** Per-channel default overrides, indexed by channel 0..3. */
export const CHANNEL_DEFAULTS = {
  'filter.center': [0.5, 0.25, 0.6, 0.85],
  'filter.width': [0.3, 0.15, 0.15, 0.15],
  'filter.on': [true, false, false, false],
};

/** Parameter id: pid(1,'filter.center') -> 'ch2.filter.center'; pid('g','master.gain') -> 'g.master.gain'. */
export const pid = (ch, key) => (ch === 'g' ? `g.${key}` : `ch${ch + 1}.${key}`);

// Resolved defs by id, built once. Each channel gets its own def object.
const cloneDefault = v => (v && typeof v === 'object' ? { ...v } : v);
const DEFS = new Map();
for (let ch = 0; ch < NUM_CHANNELS; ch++) {
  for (const d of CHANNEL_PARAMS) {
    const over = CHANNEL_DEFAULTS[d.key];
    DEFS.set(pid(ch, d.key), { ...d, default: over ? over[ch] : cloneDefault(d.default) });
  }
}
for (const d of GLOBAL_PARAMS) DEFS.set(pid('g', d.key), { ...d });

const IDS = [...DEFS.keys()];
const MOD_IDS = IDS.filter(i => DEFS.get(i).modulatable).sort();

/** The def for an id with that channel's default applied, or undefined. */
export const paramDef = id => DEFS.get(id);
export const allParamIds = () => [...IDS];
/** Modulation destination ids, sorted (stable across calls). */
export const modulatableIds = () => [...MOD_IDS];

/**
 * Short-key view of one channel: strips the 'chN.' prefix from a flat id->value map
 * (state.params or evaluate() output). chIndex is 0..3. Ids of other channels and globals are ignored.
 */
export function channelView(values, chIndex) {
  const prefix = `ch${chIndex + 1}.`;
  const out = {};
  for (const id of Object.keys(values)) if (id.startsWith(prefix)) out[id.slice(prefix.length)] = values[id];
  return out;
}
