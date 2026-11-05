# Channel Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the prototype `index.html` as modular ES modules with four self-contained channels, a modulation matrix, one MIDI-syncable transport, layered spectra and an AudioWorklet voice engine.

**Architecture:** A schema declares every parameter once. A pure core (state, transport, modulation, score builder) produces timestamped control frames for per-channel worklet synths, identically live and offline. The prototype keeps running as `index.html` until the cutover task; the new app is developed at `app.html`.

**Tech Stack:** Vanilla ES modules (no build, no DSP libraries), Web Audio + AudioWorklet, Web MIDI, `node --test` (Node 22) for pure modules, served by lerd at `https://dfs-listening-station.test`.

**Spec:** `docs/superpowers/specs/2026-11-04-channel-architecture-design.md`

## Global Constraints

- No build step; no DSP libraries; zero runtime dependencies.
- `src/core`, `src/spectrum`, `src/dsp` import no DOM and no Web Audio; they run under `node --test`.
- No module outside `src/audio/` depends on how voices are synthesised (Voice Engine boundary).
- 4 channels. 4 mixer strips + master. Drone/event balance is one knob per strip.
- Prototype constants kept: `M=512`, `MAXB=10` bands (3 oscillators each), `COMB=64`, `NK=20` noise bands, `SR=48000`, 24-bit WAV export, `GSLOT=12`.
- Time values: `{mode:'beats', div}` (1/32 up to 16 bars, plus dotted and triplet) or `{mode:'hz'|'sec', value}`. Everything timed derives from `Transport`.
- Stopped transport: modulators hold. MIDI clock: `F8` (24 per quarter note), `FA` start, `FB` continue, `FC` stop, `F2` song position; no pulses for 1 s while running means hold and report `lost`.
- Matrix amounts are −1..+1 (−100%..+100%). Pitch params (`map.*`, `drone.beat`) are never modulatable. No 8-route cap.
- Granular and window channels match in level within ±1 dB; loudness-match gain capped at +20 dB, always on.
- Patch format `v: 4`, `app: 'spectrum-listening-station'`. No v3 migration. FM is not carried over.
- Auto-sweep is not carried over; it ships as the matrix preset "slow sweep".
- Commit after every task on branch `channel-architecture`; commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Flat or featureless spectrum** (constant values, or a polarity with no features): no bands, no NaN/Infinity anywhere, channel silent, status says "No features found". Owned by Tasks 9 and 13.
2. **Patch or route naming unknown ids** (hand-edited file, or a later schema change): ignored with a warning, never an exception. Tasks 4 and 7.
3. **MIDI edge cases:** stop before start, clock with no start, duplicate stop, song-position jump while running, jittery ticks, device unplugged. Task 6.
4. **Channel disabled, layer deleted, or no layer chosen during playback:** silent without a click or exception. Tasks 13 and 14.
5. **Bad line-list input:** malformed rows, duplicate positions, zero or negative widths, lines outside the stage axis: skipped with counts reported, never a crash. Task 10.

---

## File Structure

```
package.json                     {"type":"module","scripts":{"test":"node --test"}}
tools/capture-golden.mjs         runs prototype pure code in node:vm → tests/fixtures/prototype-golden.json
tools/wav-peaks.mjs              WAV → top spectral peaks JSON (acceptance)
spike/worklet.html               Task 0 only (deleted after findings are recorded)
app.html                         new shell (becomes index.html in Task 21)
src/core/schema.js  state.js  transport.js  midi-clock.js  modulation.js  score.js
src/spectrum/parse.js  layers.js  analyse.js  examples.js
src/dsp/window.js  mapping.js  events.js  grains.js  partials.js  additive.js
src/audio/engine-contract.js  graph.js  channel-engine.js  mixer.js  driver.js  render.js  wav.js  midi-input.js
src/audio/worklet/channel-voice.js
src/ui/store-bind.js  controls.js  stage.js  channel-panel.js  timeline.js  matrix.js  mixer-ui.js  transport-ui.js  capture-ui.js  style.css
tests/<mirrors src>/*.test.js    tests/fixtures/
```

---

### Task 0: Spike: worklet import, offline determinism, CPU

**Files:** Create `spike/worklet.html`, `spike/voice.js`, `docs/superpowers/spikes/2026-11-04-worklet-spike.md`.

**Interfaces:** Produces a go/no-go record in the spike doc that Tasks 14–16 rely on.

- [ ] **Step 1:** Build `spike/worklet.html` served by lerd: loads an AudioWorklet module that statically `import`s a shared module (`../src/dsp/spike-shared.js`, a one-function file) and runs 4 instances of a 114-oscillator additive bank (30 band oscillators + 64 comb + 20 noise-band stand-ins).
- [ ] **Step 2:** Measure and record in the spike doc: (a) `import` works in the browsers you can test (Chrome required; Firefox/Safari if available); (b) two `OfflineAudioContext` renders of an identical timestamped score (frames posted before `startRendering`, applied at `currentFrame >= t*sampleRate`) are bit-identical; (c) mean `process()` time over 10 s with 4 banks, via `performance.now()` inside the processor. Pass threshold: mean < 1.33 ms per 128-frame call at 48 kHz.
- [ ] **Step 3:** If (c) fails, reduce `COMB` to 32 and `NK` to 10, re-measure, and record both results. If (a) fails, record the fallback: a `tools/bundle-worklet.mjs` concatenation step for the worklet only. If (b) fails, stop and report; the architecture needs revisiting.
- [ ] **Step 4:** Commit the spike doc (delete `spike/` after recording).

### Task 1: Scaffolding and characterization fixtures

**Files:** Create `package.json`, `tools/capture-golden.mjs`, `tests/fixtures/prototype-golden.json`, `tests/fixtures/prototype-allende-peaks.json`, `tools/wav-peaks.mjs`.

**Interfaces:** Produces `tests/fixtures/prototype-golden.json` shaped `{ examples: { [name]: { bands: {u,depth,fwhmU,rel}[] } }, allende: { win: {u,gain}[], grains: number[][], lfo: {shape,t,v}[], freqs: {u,f}[] } }`.

- [ ] **Step 1:** Write `tools/capture-golden.mjs`: read `index.html`, run lines 422–725 inside `node:vm` with an appended expression returning `{EXAMPLES, decodeExample, analyse, winTrack, grainsAt, lfoVal, mapF, snapF, P, S}`. For all 8 examples record `analyse(...).bands` (polarity `dips`, sens 0.2). For Allende with default `P`/`S` record: `winTrack` at 16 evenly spaced `u` (filter 0, `fon=[true,false,false,false]`); `grainsAt(0, P, gran[0], 3.0, 0)`; `lfoVal` for each of the 6 shapes at t ∈ {0, 0.7, 3.3}; `mapF`+`snapF` for each Allende band.
- [ ] **Step 2:** Run `node tools/capture-golden.mjs`; expected: writes the JSON, 8 examples present, Allende has ≥1 band.
- [ ] **Step 3:** Write `tools/wav-peaks.mjs <file.wav>`: decode 24-bit WAV, FFT-peak-pick, print/write the 12 strongest peaks as `{hz, db}` JSON. In a browser at `https://dfs-listening-station.test`, load Allende with all defaults, press Export loop, save the WAV outside the repo, run the tool, save to `tests/fixtures/prototype-allende-peaks.json`. (Manual step; the WAV is not committed.)
- [ ] **Step 4:** Commit.

### Task 2: Extract sampled-spectrum parsing and analysis

**Files:** Create `src/spectrum/parse.js`, `src/spectrum/analyse.js`, `src/spectrum/examples.js`; Test `tests/spectrum/analyse.test.js`.

**Interfaces:**
- Produces: `parseSpectrumText(text: string, name: string): {name,x:number[],y:number[],x0,x1,unit}` (prototype `parseSpectrum`, lines 634–650); `EXAMPLE_LINES: string[]` and `decodeExample(line): sampled` (lines 422, 652–662); `analyseSampled(sp, {polarity:'dips'|'peaks'|'both', sens:number, M?:number}): Analysis` where `Analysis = {r:Float64Array, d:Float64Array, dmax:number, bands:Band[], gx:Float64Array}`, `Band = {u,depth,fwhmU,rel,label?}`.

- [ ] **Step 1:** Test `tests/spectrum/analyse.test.js`: for each example in `prototype-golden.json`, `analyseSampled(decodeExample(line), {polarity:'dips', sens:0.2}).bands` equals golden `u/depth/fwhmU/rel` within 1e-9; `parseSpectrumText` throws on <16 numeric rows and on a constant x column.
- [ ] **Step 2:** Run `node --test tests/spectrum`; expect FAIL (module missing).
- [ ] **Step 3:** Move the prototype code verbatim (`isNull`, `guessUnit`, `parseSpectrum`, `decodeExample`, `upperHull`, `smooth`, `findBands`, `analyse`), replacing the globals `S.pol`, `S.sens`, `M`, `MAXB`, `clamp` with parameters/imports. Do not move FM code.
- [ ] **Step 4:** Run; expect PASS. **Step 5:** Commit.

### Task 3: Parameter schema

**Files:** Create `src/core/schema.js`; Test `tests/core/schema.test.js`.

**Interfaces:**
- Produces: `NUM_CHANNELS = 4`; `ParamDef = {key,label,unit,min,max,default,modulatable,voiceRate?,tip,type:'num'|'enum'|'bool'|'time'|'id',options?}`; `CHANNEL_PARAMS: ParamDef[]`; `GLOBAL_PARAMS: ParamDef[]`; `pid(ch: 0|1|2|3|'g', key: string): string` giving `'ch2.filter.center'` (1-based) or `'g.master.gain'`; `paramDef(id): ParamDef|undefined`; `allParamIds(): string[]`; `modulatableIds(): string[]`; `CHANNEL_DEFAULTS` override per channel for `filter.center` = [.5,.25,.6,.85], `filter.width` = [.3,.15,.15,.15], `filter.on` = [true,false,false,false].

Channel keys and defaults (from prototype `P`/`S`): `source.layer`(id, none), `source.polarity`(dips), `source.sens`(.2), `source.mode`(hull|direct, hull), `source.shift`(km/s, −3000..3000, 0, modulatable); `filter.on`, `filter.type`(window|granular), `filter.center`, `filter.width`(.02..1), `filter.soft`(.35), `filter.level`(1), all modulatable except on/type; `vwin.mode`(0|1|2), `vwin.center`(.5), `vwin.height`(.02..1, 1), `vwin.soft`(.35); `grain.size`(.4), `grain.density`(.5), `grain.scatter`(.7), `grain.speed`(0), `grain.dur`(1.2), `grain.jitter`(.4); `map.f0`(27.5), `map.lo`(110), `map.hi`(3520), `map.snap`(1), `map.curve`(log), `map.flip`(false); `drone.bands`(.8), `drone.comb`(.25), `drone.combSrc`(depth), `drone.noise`(.3), `drone.anchor`(.4), `drone.beat`(.5); `event.mode`(random), `event.rpm`(6), `event.interval`(time, {beats,'1/4'}), `event.jitter`(.3), `event.steps`(8), `event.stepLen`(time), `event.chance`(.6), `event.level`(.6, voiceRate), `event.octave`(1); `strip.fader`(60/66), `strip.pan`(0), `strip.mute`, `strip.solo`, `strip.balance`(.5). Globals: `g.master.gain`(.7, modulatable), `g.transport.bpm`(120).

- [ ] **Step 1:** Tests: ids unique; every default within `[min,max]`; `pid(1,'filter.center') === 'ch2.filter.center'`; `modulatableIds()` contains `ch1.filter.center`, excludes every `map.*` and `drone.beat`; `paramDef('ch5.x')` is undefined; per-channel center defaults equal [.5,.25,.6,.85].
- [ ] **Step 2:** Run; FAIL. **Step 3:** Implement. **Step 4:** Run; PASS. **Step 5:** Commit.

### Task 4: State, store, patch v4

**Files:** Create `src/core/state.js`; Test `tests/core/state.test.js`.

**Interfaces:**
- Consumes: Task 3 `paramDef`, `allParamIds`, `pid`.
- Produces: `State = {params:Record<string,any>, mods:Record<string,{lfo:Lfo[],env:Env[]}>, timelines:Timeline[], pattern:boolean[][], matrix:Route[], layers:string[]}`; `Lfo = {shape,rate:TimeValue,phase:number,seed:number}`; `Env = {a:number,h:number,d:number}` (defaults .03, 0, 1.2); `Route = {src:string,dst:string,amount:number}`; `Timeline = {len:TimeValue,mode:'morph'|'jump',events:object[]}`; `createState(): State`; `createStore(state): {state, get(id), set(id,v), subscribe(fn):()=>void, addRoute(r), removeRoute(src,dst)}`; `serializePatch(state, layers): string`; `deserializePatch(text): {state, layers, warnings:string[]}`. Source ids: `'g.lfo1'`, `'g.lfo2'`, `'g.cc<n>'`, `'ch1.lfo1'`, `'ch1.env2'`. Mods owners: `'g'`, `'ch1'`…`'ch4'`. Default state ships route `ch<i>.env1 → ch<i>.event.level` amount 1 for each channel.

- [ ] **Step 1:** Tests: `createState().params['ch1.filter.on'] === true`, others false; `set` clamps to `[min,max]` and throws on unknown id; subscribers fire once per `set`; serialize→deserialize round-trips deep-equal; patch JSON has `v:4` and `app:'spectrum-listening-station'`; `deserializePatch` rejects other `app`; **(RF2)** a patch containing a param id `ch9.foo` and a route to `ch1.nope` loads with two entries in `warnings` and no exception; routes with `amount` outside −1..1 are clamped.
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS). **Step 5:** Commit.

### Task 5: Transport and time values

**Files:** Create `src/core/transport.js`; Test `tests/core/transport.test.js`.

**Interfaces:**
- Produces: `class Transport { constructor({bpm?:number}); bpm; running; source:'internal'|'midi'; setBpm(b); start(nowSec); stop(nowSec); locate(beat,nowSec); beatAt(nowSec):number; secondsAt(nowSec):number; snapshot():{bpm} }`, where `beatAt/secondsAt` are frozen while stopped; `DIVISIONS: Record<string,number>` (beats per cycle, `'1/32'`→0.125 … `'16 bars'`→64, with `'1/8d'` dotted ×1.5 and `'1/8t'` triplet ×2/3 forms); `timeValuePeriodSec(tv: TimeValue, bpm): number`; `timeValueCycles(tv, t:{beat,sec}): number` (cycles elapsed, so phase = fractional part).

- [ ] **Step 1:** Tests: at 120 bpm after `start(0)`, `beatAt(1) === 2`; after `stop(1)`, `beatAt(5) === 2` (hold); `locate(8, 0)` then `beatAt(0.5) === 9`; `setBpm` mid-run keeps position continuous; `timeValuePeriodSec({mode:'beats',div:'1/4'},120) === 0.5`, `'4 bars'` at 120 = 8; `{mode:'hz',value:.1}` period 10 regardless of bpm; `timeValueCycles` of a free tv uses `sec`, of a beats tv uses `beat`; `'1/8d'` period is 1.5× `'1/8'`.
- [ ] **Step 2–5:** FAIL, implement, PASS, commit.

### Task 6: MIDI clock follower and Web MIDI input

**Files:** Create `src/core/midi-clock.js`, `src/audio/midi-input.js`; Test `tests/core/midi-clock.test.js`.

**Interfaces:**
- Consumes: Task 5 `Transport`.
- Produces: `class MidiClockFollower { constructor(transport, {lostAfterSec=1}); handle(bytes: ArrayLike<number>, tSec: number): void; poll(tSec): 'ok'|'lost'|'idle' }`; `midiSupported(): boolean`; `listInputs(): Promise<{id,name}[]>`; `connect(inputId, follower, clock: ()=>number, onCc?: (cc:number, value01:number)=>void): ()=>void` (returns disconnect; maps `event.timeStamp` to audio time via `clock`; control-change messages `0xB0` go to `onCc`).

- [ ] **Step 1:** Tests: 24 `[0xF8]` ticks spaced 0.5/24 s ⇒ `transport.bpm` within ±0.5 of 120; ticks with ±10% interval jitter ⇒ within ±2 bpm; `FA` ⇒ running, beat 0; `FC` ⇒ stopped; `FB` resumes without resetting beat; `F2` with data bytes (LSB, MSB) = 8 ⇒ beat 2 (value is 16th notes; 4 per beat); `poll` returns `'lost'` when running and no tick for >1 s and `'ok'` after a tick. **(RF3)** `FC` before any `FA` is ignored; `F8` ticks without `FA` update tempo but do not start; double `FC` is idempotent; `F2` while running relocates without stopping; a tick gap of 3 s followed by ticks recovers `'ok'`; implausible tempo (<20 or >400 bpm) from a single outlier interval is ignored.
- [ ] **Step 2–4:** FAIL, implement (EMA over inter-tick intervals), PASS. **Step 5:** `midi-input.js` is browser-only: verify manually in Task 20. Commit.

### Task 7: Modulation evaluator

**Files:** Create `src/core/modulation.js`; Test `tests/core/modulation.test.js`.

**Interfaces:**
- Consumes: Tasks 3, 4, 5.
- Produces: `LFO_SHAPES = ['sine','tri','ramp','square','steps','drift']`; `lfoValue(lfo, t:{beat,sec}, bpm, loopSec?): number` in [−1,1] (port `lfoVal`, lines 517–530; with `loopSec` the cycle count is rounded to a whole number per loop); `envValue(env, triggersSec: number[], sec): number` in [0,1] (linear attack `a`, hold `h`, then `exp(-(x-a-h)/d)`; life `a+h+8d`; the newest trigger at or before `sec` wins); `evaluate(state, t:{beat,sec}, opts:{bpm, triggers:Record<string,number[]>, cc?:Record<string,number>, loopSec?}): Record<string,number>` returning the effective value of every param (numeric params modulated, enum/bool/time/id params passed through unchanged); `voiceGain(state, ch: number, ageSec: number, opts): number` returning the multiplier for voice-rate destination `event.level`.
- Rules: bipolar sources (LFO) add `v*amount*(max-min)*0.5`; unipolar (envelope, CC) add `v*amount*(max-min)`; result clamped to `[min,max]`. Voice-rate destinations (`voiceRate: true`) are skipped by `evaluate` and instead multiplied in `voiceGain` as `∏ (1 + amount*(v-1))` for unipolar sources and `∏ (1 + amount*v)` for bipolar, floored at 0.

- [ ] **Step 1:** Tests: sine at phase 0.25 = 1; `lfoValue` matches golden `lfo` entries for all 6 shapes at 3 times (seed from the prototype defaults); with `loopSec=10` and rate .13 the value at t equals value at t+10 (loop seamless); `envValue` is 0 at t<trigger, peak 1 at `a`, equals `exp(-1)` at `a+h+d`, and 0 after life; a route `g.lfo1 → ch1.filter.center` amount 0.5 moves center by ±0.25*range and never leaves `[min,max]`; with a route `ch1.env1 → ch1.event.level` amount 1, `voiceGain` equals the envelope value; two overlapping triggers give independent `voiceGain` per age; **(RF2)** a route whose `src` or `dst` is unknown is skipped; pitch params are never modulated even if a route targets them.
- [ ] **Step 2–5:** FAIL, implement, PASS, commit.

### Task 8: Layers, units, shared axis

**Files:** Create `src/spectrum/layers.js`; Test `tests/spectrum/layers.test.js`.

**Interfaces:**
- Produces: `Layer = {id,name,kind:'sampled'|'lines',quantity:'reflectance'|'flux'|'optical-depth'|'intensity',axis:{unit,x0,x1}, x?:number[], y?:number[], lines?:Line[]}`; `Line = {x,intensity,width?,label?,type?:'abs'|'em'}`; `UNITS = ['nm','µm','Å','cm⁻¹','Hz','GHz','x']`; `convertPosition(v, from, to): number|null` (null when not convertible, e.g. nm↔x); `stageAxisFrom(layer): {unit,x0,x1}`; `layerOnStage(layer, stage): Layer|null` (converted to stage unit, sorted, clipped to the stage range; null if no overlap or unconvertible); `profileOnStage(layer, stage, M): Float64Array` (sampled: interpolate from source data; lines: sum of Gaussians, width default 1.5 grid cells).

- [ ] **Step 1:** Tests: `convertPosition(500,'nm','µm') === 0.5`; `nm`→`Å` ×10; `nm`↔`cm⁻¹` round-trips (`1e7/nm`); `nm`→`x` is null; a layer whose range lies outside the stage returns null from `layerOnStage`; zoom narrowing the stage axis re-derives from source (a line at 656.28 nm stays at the correct `u` for stage 600–700 nm and is dropped for 400–500); `profileOnStage` of one line peaks at its `u` with area independent of width default.
- [ ] **Step 2–5:** FAIL, implement, PASS, commit.

### Task 9: Analysis modes, line features, velocity shift

**Files:** Modify `src/spectrum/analyse.js`; Test `tests/spectrum/analyse-modes.test.js`.

**Interfaces:**
- Consumes: Tasks 2, 8.
- Produces: `analyse(layer, stage, {polarity, sens, mode:'hull'|'direct', M?}): Analysis` dispatching on `layer.kind`; `applyShift(analysis, kmS, stage): Analysis` (pure; shifts `bands[].u`, `r`, `d` by Δu; for wavelength units Δu = ln(1+kmS/299792.458)/ln(x1/x0), otherwise proportional to the axis span).

- [ ] **Step 1:** Tests: sampled/hull equals Task 2 output; direct mode uses y normalised to [0,1] as depth with no continuum removal (a flat 0.3 optical-depth layer gives constant `d`); lines produce one band per line within the axis, `u` exact, `rel` proportional to intensity, `label` kept, with `type:'abs'` lines excluded when polarity is `peaks` and vice versa; `applyShift(a, 0, stage)` is the identity; shifting +c/100 km/s moves a band by `ln(1.01)/ln(x1/x0)`; **(RF1)** a constant-value sampled layer and an empty line list both return `bands: []`, `dmax` > 0, and all-finite `r`/`d` (no NaN/Infinity).
- [ ] **Step 2–5:** FAIL, implement, PASS, commit.

### Task 10: Importers and bundled line lists

**Files:** Modify `src/spectrum/parse.js`, `src/spectrum/examples.js`; Test `tests/spectrum/parse.test.js`.

**Interfaces:**
- Produces: `parseLineList(text, name): {layer: Layer, skipped: {count:number, reasons:string[]}}`; `parseAny(text, name): {layer, skipped?}` using detectors (header containing `wavelength|position` plus `intensity` ⇒ line list; otherwise two-column sampled); `parseCsvSampled`; `EXAMPLE_LAYERS: Layer[]` containing the 8 meteorites plus `ism-absorption` (Na D 588.995/589.592 nm, Ca II H 396.847 / K 393.366 nm, type `abs`) and `nebula-emission` (Hα 656.28, Hβ 486.13, Hγ 434.05, Hδ 410.17, [O III] 500.7/495.9, [N II] 658.3/654.8, [S II] 671.6/673.1 nm, type `em`), each named "demonstration data (approximate rest wavelengths)".

- [ ] **Step 1:** Tests: headered CSV `wavelength,intensity,width,label,type` parses to a lines layer with labels; two-column text still parses as sampled; **(RF5)** rows with non-numeric position, negative or zero width, or missing intensity are skipped and counted in `skipped` with a reason string each; duplicate positions are merged (max intensity kept) and counted; a file with zero valid rows throws `Error` whose message names the first reason; `EXAMPLE_LAYERS` has 10 entries with unique ids.
- [ ] **Step 2–5:** FAIL, implement, PASS, commit.

### Task 11: DSP: windows, mapping, events

**Files:** Create `src/dsp/window.js`, `src/dsp/mapping.js`, `src/dsp/events.js`; Tests `tests/dsp/*.test.js`.

**Interfaces:**
- Produces: `winOne(u,c,w,s)`; `verticalGate(analysis, u, {mode,center,height,soft}): number`; `channelGain(u, ch: ResolvedChannel, analysis, grains?: Grain[]): number`; `mapFreq(u, {lo,hi,curve,flip}): number`; `snapFreq(f, {f0,snap}): number`; `evTimes(ev: {mode,rpm,interval,jitter,steps,stepLen,pattern}, t0, t1, rnd, bpm): number[]` (prototype `evTimes`, lines 609–622, with `interval`/`stepLen` as `TimeValue` converted by `timeValuePeriodSec`); `pickEvent(ch, analysis, rnd, grains?): {f,amp,pan,bandIndex}|null` (port of `pick`, no FM). `ResolvedChannel` = `{[shortKey]: value}` for one channel taken from `evaluate` output with the `chN.` prefix stripped (for example `ch['filter.center']`).

- [ ] **Step 1:** Tests: `winOne` and `mapFreq`/`snapFreq` equal golden values at the 16 sampled `u`; `channelGain` for default channel 1 equals golden `win` gains; `evTimes` regular mode with `{beats,'1/4'}` at 120 bpm over (0,2] returns 4 times 0.5 apart (jitter 0); pattern mode honours `pattern`; `pickEvent` returns null when no band sits under the window.
- [ ] **Step 2–5:** FAIL, implement, PASS, commit.

### Task 12: DSP: granular windows and loudness match

**Files:** Create `src/dsp/grains.js`; Test `tests/dsp/grains.test.js`.

**Interfaces:**
- Consumes: Task 11 `winOne`.
- Produces: `grainsAt(ch: ResolvedChannel, seed: number, t: number, loopSec?: number): Grain[]` with `Grain = [u, width, soft, level]` (port of prototype `grainsAt`, lines 558–573: stateless, slot-indexed, `GSLOT=12`); `grainRmsCoverage(ch, seed): number` (time-averaged RMS of the combined grain gain over `u`, computed from the analytic grain statistics or a cached fixed quadrature, not live randomness); `windowRmsCoverage(ch): number` (same for the plain window with identical center, width, soft, level); `loudnessMatch(ch, seed): number` = `min(10^(20/20), windowRms/grainRms)`.

- [ ] **Step 1:** Tests: `grainsAt` with prototype defaults at t=3.0 equals golden `grains`; with `loopSec=L`, `grainsAt(t)` equals `grainsAt(t+L)`; **(spec 4.1)** for a grid of `grain.size` ∈ {.2,.4,.7}, `grain.density` ∈ {.3,.5,.8}, `filter.width` ∈ {.15,.3,.6}: simulate 400 s of `grainsAt`, apply `loudnessMatch` to the grain gain, and assert its RMS over `u` is within ±1 dB of the equivalent window's RMS (use the prototype-default case to confirm the raw deficit is ≈ −10 dB, between −12 and −8 dB); when the required gain would exceed +20 dB, `loudnessMatch` returns exactly 10 (linear +20 dB).
- [ ] **Step 2–5:** FAIL, implement, PASS, commit.

### Task 13: Partial tables, ControlFrame and score builder

**Files:** Create `src/dsp/partials.js`, `src/core/score.js`; Tests `tests/dsp/partials.test.js`, `tests/core/score.test.js`.

**Interfaces:**
- Consumes: Tasks 7, 9, 11, 12.
- Produces: `ControlFrame = {t:number (engine seconds), balance:number, match:number, bandF:Float64Array(30), bandA:Float32Array(30), bandPan:Float32Array(10), combF:Float64Array(64), combA:Float32Array(64), noiseF:Float64Array(20), noiseA:Float32Array(20), anchorF:Float64Array(2), anchorA:Float32Array(2), events:EventSpec[]}`. The synth multiplies drone output by `match * min(1, 2*(1-balance))` and event output by `match * min(1, 2*balance)`; fader, strip pan, mute and solo live only in the Mixer. `EventSpec = {t,f,amp,pan,env:{a,h,d}, levelRoute:number}`; `buildFrame(ch: ResolvedChannel, analysis: Analysis|null, opts:{t,stereo,loopSec?,seed}): ControlFrame` (port of `update`, lines 894–942, formulas and constants `BAND_AMP .16, COMB_AMP .05, NOISE_AMP .05, ANCHOR_AMP .14, MASTER 2.0`); `Take = {dur:number, bpm:number, events:{t:number,id:string,value:any}[]}`; `recordChange(take, t, id, value)` (keeps events sorted); `paramsAt(take, base: Record<string,any>, t): Record<string,any>` (last event at or before `t` per id); `buildScore(project: {state, analyses: Record<channelIndex,Analysis|null>}, span: {startSec,endSec,stepSec}, opts: {bpm, transport, seed, loopSec?, take?}): Record<number, ControlFrame[]>` (per channel, frames every `stepSec`, 0.04 default, 0.025 when a granular channel is on; events generated by `evTimes`+`pickEvent`; each event's `levelRoute` is the summed amount of `chN.env1`-type routes to `event.level`).

- [ ] **Step 1:** Tests: default Allende channel 1 `bandF` equals `snapFreq(mapFreq(band.u))` for all bands (golden `freqs`); disabled channel (`filter.on` false) yields all-zero `*A` arrays; **(RF4)** a channel with `analysis === null` (no layer chosen) yields all-zero amplitudes and no events; **(RF1)** a channel whose analysis has `bands: []` yields finite arrays (no NaN/Infinity) and no events; `buildScore` with the same inputs and seed twice gives deep-equal output (deterministic); with `loopSec=48`, frames at `t` and the first frame after `t+48` match and event lists repeat; a granular channel's frame `match` equals `loudnessMatch`; `paramsAt` returns the last event at or before `t` and `recordChange` keeps events sorted.
- [ ] **Step 2–5:** FAIL, implement, PASS, commit.

### Task 14: Engine contract and ChannelSynth

**Files:** Create `src/audio/engine-contract.js`, `src/dsp/additive.js`; Test `tests/dsp/additive.test.js`.

**Interfaces:**
- Produces: the **VoiceEngine** interface: `create(opts:{sampleRate:number, stereo:boolean, seed:number, loopSec?:number}): Engine`; `Engine.schedule(frame: ControlFrame): void` (the frame takes effect at `frame.t`); `Engine.render(frames: number): {left:Float32Array, right:Float32Array|null}`; `Engine.dispose(): void`. `engine-contract.js` exports `engineContract(create, {test, assert})` registering the contract tests; `additive.js` exports `class ChannelSynth` implementing it (oscillator bank for bands/comb/anchor, 20 Q=4 bandpass biquads on seeded noise, event voices with per-event AHD gain, per-frame smoothing equivalent to the prototype's `tcG=0.04`, `tcF=0.07`).

- [ ] **Step 1:** Write `engineContract` first. Tests: no frames ⇒ all-zero output; a frame at `t=0` (applied instantly, with no smoothing, when `t` is at or before engine time 0) with `bandF[0]=440`, `bandA[0]=0.1`, `balance=0.5`, `match=1`, everything else zero ⇒ after 2 s the output's peak is 0.1 ±1% and the dominant FFT bin is at 440 Hz; a frame with `t=0.5` leaves samples before 0.5 s at zero (±1 sample) and applies after; identical schedules ⇒ bit-identical output; **(RF4)** scheduling an all-zero-amplitude frame after sound ramps to silence without a sample-to-sample jump larger than 0.05, and `dispose()` then `render` throws or returns zeros; an event with `levelRoute` 1 decays by `exp(-1)` one `d` after attack; extreme values (amp 1e6, f 0, NaN input) produce finite output; stereo `pan` −1 puts energy only in left.
- [ ] **Step 2:** Run `node --test tests/dsp/additive.test.js`; FAIL.
- [ ] **Step 3:** Implement `ChannelSynth` (port the prototype's per-voice formulas; keep it free of Web Audio). **Step 4:** PASS. **Step 5:** Commit.

### Task 15: Worklet, audio graph, mixer, driver

**Files:** Create `src/audio/worklet/channel-voice.js`, `src/audio/channel-engine.js`, `src/audio/mixer.js`, `src/audio/graph.js`, `src/audio/driver.js`; Test `tests/audio/mixer.test.js` (pure gain math only); Create `app.html` skeleton and `tests/browser/smoke.html`.

**Interfaces:**
- Consumes: Tasks 13, 14.
- Produces: worklet processor `'channel-voice'` wrapping `ChannelSynth` (frames arrive on `port` as `{type:'frame',frame}`; engine time = `currentFrame/sampleRate`); `class ChannelEngine { static create(ctx, {stereo,seed,loopSec?}): Promise<ChannelEngine>; output: AudioNode; send(frame); setEnabled(on); dispose() }` (a disabled channel disconnects and drops its synth); `faderGain(pos:number): number` (`pos<0.005 → 0`, else `10^((pos*66-60)/20)`) and `mixGates(strips:{mute,solo}[]): boolean[]` (solo logic as prototype line 513); `class Mixer { constructor(ctx, dest, {stereo, live}); strip(i):{input:GainNode, analyser:AnalyserNode|null}; apply(strips:{fader,pan,mute,solo,balance}[], master:number, t:number): void; analyser, analyserL, analyserR }` (master compressor as prototype: threshold −12, knee 10, ratio 8, attack .01, release .3); `class Driver { constructor({store, transport, getAnalyses, graph}); start(); stop() }` pulling 100 ms lookahead from `buildScore` every ~30 ms and sending frames/events; `createGraph({live, stereo, loopSec?}): Promise<{ctx, channels, mixer}>`.

- [ ] **Step 1:** Test `faderGain(0) === 0`, `faderGain(60/66) ≈ 1` (0 dB), `mixGates` with one solo silences the others, and mute wins over solo.
- [ ] **Step 2–3:** FAIL, implement the pure pieces; then the browser pieces. **Step 4:** In `tests/browser/smoke.html` (served by lerd), load Allende, enable all four channels, play 30 s: no console errors; assert in-page that `process()` mean time (exposed by the worklet) is below the Task 0 threshold; toggle channels on/off during play and confirm no exceptions (RF4); open the page via `file://` and confirm the app shows "Serve this app over HTTP(S) (the audio engine cannot load from a file)" instead of failing silently. **Step 5:** Commit.

### Task 16: Offline render, export, takes

**Files:** Create `src/audio/render.js`, `src/audio/wav.js`; Test `tests/audio/wav.test.js`, `tests/audio/render-length.test.js`.

**Interfaces:**
- Consumes: Tasks 13, 15.
- Produces: `encodeWav24(chans: Float32Array[]): ArrayBuffer`, `zipStore(name, data)` (port lines 1072–1126); Consumes Task 13 `Take`, `paramsAt`. `renderOffline(project, kind:'take'|'loop', opts:{bars?:number, seconds?:number, stereo:boolean, take?:Take}): Promise<{chans:Float32Array[], peak:number, rms:number}>` using `OfflineAudioContext` at 48 kHz, 7 s pre-roll for loops, peak-normalise to 0.5, 2 s fade for takes (as prototype lines 1018–1071); synced loop length is `bars * 4 * 60/bpm` seconds, free loop length is `seconds`.

- [ ] **Step 1:** Tests: `encodeWav24` header fields (RIFF, 48000 Hz, 24-bit, data length) and round-trip of a ramp to within 1 LSB; synced loop length at 120 bpm, 4 bars = 8 s.
- [ ] **Step 2–3:** FAIL, implement. **Step 4:** Browser check via smoke page: render a 4-bar loop and confirm the first and last 10 ms of the loop differ by < 0.05 peak step (seamless). **Step 5:** Commit.

### Task 17: UI foundation and stage

**Files:** Create `src/ui/store-bind.js`, `src/ui/controls.js`, `src/ui/stage.js`, `src/ui/style.css`; complete `app.html`.

**Interfaces:**
- Consumes: Tasks 3, 4, 8, 9.
- Produces: `bindParam(host, id, store): void` (renders a slider, toggle, select or time-value control from `paramDef(id)`; shows modulated value as a ghost marker); `createStage(host, store, {layers, analyses}): {selectChannel(i), refresh()}` (port plot lines 1374–1487, range selector 726–800, monitors 1490–1509, layer chips 1308–1332); the plot draws every layer in a muted hue, line lists as ticks with labels, and the four channel windows in four colors, with the existing drag/resize/scroll behaviors reading and writing `chN.filter.*`.

- [ ] **Step 1:** Port CSS (prototype lines 5–203) into `style.css`, adding `--ch1..--ch4` colors. **Step 2:** Port and adapt stage code; remove all reads of the prototype globals `P`, `S`, `A`.
- [ ] **Step 3:** Manual verify at `https://dfs-listening-station.test/app.html`: drop an example, drag each window, zoom, add the `nebula-emission` layer and see ticks; no console errors; a layer on an unconvertible unit (for example `x` layer onto an `nm` stage) shows the warning "Layer <name> cannot be placed on the <unit> axis" and is skipped; a parse failure from Task 2/10 appears in the status line. **Step 4:** Commit.

### Task 18: Channel panel and timeline

**Files:** Create `src/ui/channel-panel.js`, `src/ui/timeline.js`.

**Interfaces:** Consumes Task 17 `bindParam`. Produces `createChannelPanel(host, store, chIndex)` with collapsible sections Source, Filter, Mapping, Drone, Events, Modulators, Timeline, built only from `CHANNEL_PARAMS` (no hand-written per-parameter markup) plus tab selection shared with the plot and strips; `createTimeline(canvas, store, chIndex)` (port lines 1607–1680; `len` is a `TimeValue`, playhead from `Transport`).

- [ ] **Step 1:** Implement panel from the schema; link-to-channel-1 toggle for `map.*`. **Step 2:** Port timeline (Morph/Jump, add/delete/clear). **Step 3:** Manual verify: change layer per channel; granular toggle shows grain controls; setting two channels to different layers sounds from each. **Step 4:** Commit.

### Task 19: Modulation matrix UI

**Files:** Create `src/ui/matrix.js`.

**Interfaces:** Consumes Task 4 store routes, Task 3 `modulatableIds`. Produces `createMatrix(host, store)`: columns are sources grouped Global/Ch1–Ch4, rows are destinations grouped by channel (collapsible); click or drag a cell sets `amount` (−1..+1, double-click clears); "show channel N" filter; presets `slow sweep` (a triangle LFO at 60 s to `filter.center`) and `envelope to event level`; per-source editor (shape, rate as `TimeValue`, or a, h, d; for `g.cc<n>` a Learn button that binds the next incoming control-change number via `onCc`).

- [ ] **Step 1:** Implement grid as a view of `store.state.matrix`; no separate model. **Step 2:** Manual verify: LFO to two destinations on two channels moves both; removing the route restores base; routing to pitch params is impossible (rows absent). **Step 3:** Commit.

### Task 20: Mixer, transport, capture, output UI

**Files:** Create `src/ui/mixer-ui.js`, `src/ui/transport-ui.js`, `src/ui/capture-ui.js`.

**Interfaces:** Consumes Tasks 5, 6, 15, 16. Produces four strips + master (port faders/VU lines 1510–1606, adding the balance knob), header transport (play, BPM, source `Internal|MIDI`, MIDI input picker, "clock lost" indicator, hidden with a note when `midiSupported()` is false), Capture (record with 3 s count-in, play take, clear) and Output (mono/stereo, loop length in bars when synced or seconds when free, export loop, export take, patch save/load).

- [ ] **Step 1:** Port and adapt. **Step 2:** Manual verify with a MIDI source (DAW or virtual port): Play follows external start/stop, BPM tracks, unplugging shows "clock lost" and holds; synced LFO follows tempo changes. **Step 3:** Save and reload a patch. **Step 4:** Commit.

### Task 21: Acceptance and cutover

**Files:** Modify `app.html` → `index.html`; delete the old prototype code; Create `README.md`; Test `tests/acceptance.md` (checklist).

- [ ] **Step 1:** Render the Allende default loop with the new app, run `tools/wav-peaks.mjs`, and compare to `prototype-allende-peaks.json`: each prototype peak within ±1 Hz or ±2% of a new peak, level within ±3 dB.
- [ ] **Step 2:** Run the checklist in `tests/acceptance.md`: four channels each on a different layer; granular channel level matches a window channel by ear and by RMS; synced and free LFOs; MIDI sync; loop export seamless; take record/replay; flat-spectrum file produces silence with the status message (RF1); hand-edited patch with a bad id loads with a warning (RF2).
- [ ] **Step 3:** `git mv app.html index.html`, remove `tools/capture-golden.mjs` dependence on the old file (golden fixtures stay committed), write `README.md` (how to serve via lerd, module map, how to add a parameter).
- [ ] **Step 4:** `node --test` passes in full. **Step 5:** Commit.
