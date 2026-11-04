# Spectrum Listening Station: Channel Architecture Design

Date: 2026-11-04
Status: approved in conversation, pending written-spec review

## 1. Purpose and scope

The current app (`index.html`, ~1,840 lines, one script, global mutable state) is a working prototype. This work restructures it so that it is modular, DRY and built around self-contained channels.

**Goals**

1. Four self-contained channels, each with one mixer strip (the prototype has eight: V1–V4, E1–E4).
2. A modulation matrix. Envelopes and LFOs are general sources, not hardcoded to destinations.
3. One central clock that every timed thing derives from, with external MIDI sync.
4. Layered spectral data that goes beyond a single reflectance spectrum (absorption, emission, line lists).
5. FM is removed for now, leaving a clean seam so it can return.

**Shared (not per-channel):** the layer stack, spectrum plot with all four filter windows, range selector and zoom, transport and clock, matrix, master level, capture, output, tooltips.

**Out of scope for this pass:** FM, spectrum-derived modulation sources, spectral cubes and time series (third axis), FITS import, v3 patch migration (explicitly dropped), recorded-take migration.

## 2. Decisions made

| Topic | Decision |
|---|---|
| Pitch mapping | Per channel (f0, low/high Hz, snap, curve, flip). UI offers a link-to-channel-1 toggle. |
| Modulation scope | Channel-owned sources plus a small global bank; one global matrix; cross-channel routing allowed. |
| Time units | Every time parameter is Synced (beats/bars) or Free (Hz/seconds). Both derive from the one transport. |
| Stopped transport | Modulators hold (they do not free-run). The drone still sounds. |
| Spectral data | Layered 1D spectra (sampled and line list). Third axis designed for, not built. |
| Implementation | ES modules, no build step, AudioWorklet voice engine per channel. |
| DSP libraries | None. The Voice Engine boundary keeps a Faust port possible. |
| Auto-sweep | Removed as a feature. Replaced by a "slow sweep" matrix preset (triangle LFO to filter center). |
| Mixer | Four strips. Drone/event balance is one knob inside each strip. |
| Patch migration | Not needed. Patch format restarts at v4. |

## 3. Architecture

**Principle:** one source of truth per thing. Every parameter is declared once in a schema; sliders, matrix destinations, patch serialisation, recording and tooltips are generated from it. This replaces the prototype's parallel `KC/KW/KS/KL`, `DEST`, `DR`, `TLK`, `FILT`, `PKEYS` and `SL` tables.

### 3.1 Modules

```
index.html                 shell only
src/core/      schema · state · transport · modulation   (pure: no DOM, no Web Audio)
src/spectrum/  layers · analyse · parse · examples       (pure)
src/dsp/       window · mapping · additive · events      (pure, shared by worklet and tests)
src/audio/     graph · channel-engine · mixer · render · wav
src/audio/worklet/channel-voice.js     (AudioWorkletProcessor, one instance per channel)
src/ui/        stage · channel-panel · matrix · mixer · transport · capture
tests/         node --test suites, characterization fixtures
```

### 3.2 Data flow (identical live and offline)

1. `Transport` supplies the current beat and second.
2. The pure modulation evaluator takes state and time and returns each channel's resolved parameters.
3. The main thread builds a **control frame** per channel: partial tables, window gains, event triggers, strip values. Each frame carries an absolute audio-frame timestamp.
4. The channel's worklet applies each frame when its clock reaches the timestamp, then synthesises.

Offline export preloads the whole timestamped score; live playback streams it with a short lookahead. The same worklet code serves both, so a render matches what was heard.

### 3.3 Voice Engine boundary (protected rule)

No module outside `src/audio/` may depend on how voices are synthesised. The engine's interface is: timestamped control frames in, audio out. The interface and its contract tests are written **before** the worklet, so the hand-written worklet is the first implementation, not the definition. A future Faust or FM engine implements the same interface. Faust would likely add a build step for the engine alone, and would use a fixed maximum voice count with unused voices muted, as the prototype already does (`MAXB`, `COMB`).

### 3.4 Audio graph

Four channel worklets → four strips (fader, pan, mute, solo, VU) → master with compressor and analysers. A disabled channel tears down its bank. Per-channel mapping means each channel needs its own bank, so the oscillator count is up to about four times the prototype's (~456 if all four channels are enabled). The spike (section 8) measures this.

## 4. Channels

Each channel is one object with namespaced schema ids (for example `ch2.filter.center`).

| Group | Contents |
|---|---|
| Source | spectrum layer, polarity (absorption / emission / both), sensitivity, velocity shift |
| Filter | enable; window or granular; center, width, softness, level; vertical window (off / reflectance / depth) with y, height, softness; grain size, density, scatter, speed, duration, jitter |
| Mapping | f0, low Hz, high Hz, snap, log/linear curve, flip |
| Drone | bands, comb (and what it follows), noise, anchor, beating |
| Events | generator (random / regular / pattern), chance, level, octave, pattern steps |
| Modulators | 2 LFOs, 2 envelopes |
| Timeline | keyframes for the window |
| Strip | fader, pan, mute, solo, drone/event balance knob |

### 4.1 UI layout

```
Header   title · transport (play, BPM, internal | MIDI) · listen
Stage    layer chips · plot with 4 colored windows · range bar · monitors
Channel  [1][2][3][4] tabs → collapsible sections in two columns
Matrix   source × destination grid
Dock     strips 1–4 + master · capture · output
```

Each channel has one color, shared by its window in the plot, its tab and its strip. Selecting a channel works by clicking its tab, its strip, or its window in the plot; all three do the same thing.

## 5. Central clock

One `Transport` object. Nothing else keeps time. It replaces `clockFree`, the `performance.now()` clocks, per-filter `tlPos` and the sweep `dt`.

- State: `running`, `bpm`, `beat` (double), `source` (`internal` | `midi`). It converts beats to seconds and back, and maps both onto the audio clock (`ctx.currentTime`), which is the final timing authority.
- **Time value type:**
  - `{sync: 'beats', div}`: 1/32 up to 16 bars, plus dotted and triplet. Follows tempo.
  - `{sync: 'free', hz | seconds}`: runs off the transport's elapsed seconds. Ignores tempo, but starts, stops and relocates with the transport.
- **Consumers:** LFO phase, event generators, envelope triggers, timelines, grain scheduling, takes, loop export.
- **Stopped:** modulators hold at their current position.
- **MIDI sync** (Web MIDI, input picker in the header): clock `F8` (24 per quarter note), start `FA`, continue `FB`, stop `FC`, song position `F2`. Tempo is smoothed over the last several ticks; position advances by ticks; MIDI timestamps are mapped to audio time via `getOutputTimestamp()`. With source `midi`, the Play button follows the external transport. If clock pulses stop for about one second while running, the transport holds and shows "clock lost" (no silent free-run).
- **Support:** Web MIDI is available in Chrome, Edge and Firefox, not Safari. It is feature-detected; the MIDI option is hidden with a note where missing. HTTPS (already provided by lerd) satisfies the secure-context requirement.
- **Offline / loop export:** a virtual transport at a snapshot tempo. A synced loop length is whole bars; a free loop length is seconds. LFO rates round to whole cycles per loop, as in the prototype.
- **Takes:** recorded against transport time so they replay in sync.

## 6. Modulation matrix

**Sources** share one interface (a named signal producing a value over time):

| Source | Owner | Notes |
|---|---|---|
| LFO ×2 | each channel | sine, triangle, ramp, square, random steps, random drift; synced or free rate |
| Envelope ×2 | each channel | attack, hold, decay; triggered by the channel's event generator or manually |
| LFO ×2 | global | clock-synced, available to all channels |
| MIDI CC | global | optional, with learn |

**Destinations:** every schema parameter flagged `modulatable`. The pitch controls (f0, range, snap, beating) stay excluded, as in the prototype, to keep loops seamless.

**Storage:** a sparse list of `{source, destination, amount}`, amount from −100% to +100%. The grid is a view of that list. The prototype's 8-route cap is removed. Evaluation is `clamp(base + Σ source × amount × range)`, in one pure function shared by live and offline.

**Grid UI:** rows are destinations grouped by channel (collapsible); columns are sources grouped Global, Ch1–Ch4. Click or drag a cell to set an amount. A "show channel N" filter shows only routes touching that channel. Presets add ready-made route sets ("slow sweep", "envelope to event level").

**Envelopes and event voices.** To avoid hardcoding envelopes to events, envelope sources are evaluated **per event voice** for voice destinations (for example Event level). Each ping gets its own envelope instance, so overlapping pings keep their own decay. For channel-wide destinations, the envelope is evaluated once at the channel's latest trigger. The default patch ships with `Env 1 → Event level` at +100%, so default behavior matches the prototype. Envelope values are a pure function of trigger times (no running state), the same stateless approach the prototype's grain scheduler uses, so loop renders stay exact.

**Timeline** stays a per-channel feature (keyframed window motion). It is not an LFO replacement.

## 7. Spectral layers

Everything downstream of the spectrum (voices, comb, noise, window, vertical window) keeps reading one `Analysis` object with the prototype's shape: profile `r`, depth `d`, `dmax`, `bands`. Richer data is handled upstream of it.

**Layer:** `{ id, name, kind: 'sampled' | 'lines', quantity, axis: {unit, x0, x1}, data }`.

- **Sampled:** position/value pairs. `quantity` is reflectance, flux, optical depth or intensity.
- **Lines:** list of `{position, intensity, width?, label?, type?}`, where `type` can mark absorption or emission per line.

**Shared axis.** The stage axis comes from the first layer, with a unit selector. Wavelength units (Å, nm, µm), wavenumber and frequency convert physically, so layers in different units share one axis. A unitless layer is mapped by its own range onto the stage. Range and zoom apply to the stage, so every layer follows. Zoom re-derives from source data, not from the 512-point grid, so narrow lines survive.

**Analysis per channel.** Each channel chooses layer, polarity and sensitivity, and gets its own cached `Analysis`:

- *Sampled, hull mode:* the prototype's continuum-removal pipeline (default for reflectance spectra).
- *Sampled, direct mode:* values are used as depth with no continuum removal (for optical-depth data and already-normalised spectra).
- *Lines:* features come straight from the list with no peak-finding; the continuous profile for comb, noise and plot is synthesised as Gaussians from the line widths.

**Velocity shift:** a per-channel, modulatable parameter in km/s (equivalently redshift) that shifts the channel's view of the layer along the axis (a constant shift in log-x on a wavelength axis).

**Import:** the existing two-column text, plus CSV with headers and a line-list mode detected from headers (`wavelength,intensity,width,label`). The parser is a registry of detectors so a FITS parser can plug in later.

**Bundled examples:** the 8 meteorite spectra, plus two small hand-entered line lists for testing: ISM absorption (Na D, Ca II H&K) and nebular emission (Balmer, [O III], [N II], [S II]), using approximate rest wavelengths and labelled as demonstration data, not research data.

## 8. Order of work and risk

0. **Spike:** confirm worklet `import` of shared `dsp/` modules in target browsers; confirm offline-render determinism with worklets and timestamped frames; measure CPU with four full banks (~456 partials).
1. Characterization tests, then extract the pure modules and strip FM.
2. Schema, state and the channel model.
3. Transport and MIDI sync.
4. Modulation evaluator and matrix.
5. Worklet engine and four-strip mixer.
6. Spectral layers.
7. UI assembly.
8. Capture, render and export on the new engine.

**Principal risks:** CPU with four banks (mitigation: tear down disabled channels, tune `COMB`/`NK`, measure in the spike); worklet determinism offline; MIDI clock jitter and Safari absence.

## 9. Testing

- **Characterization first.** Before refactoring, capture golden outputs from the prototype: Allende's detected bands and positions, window values, partial tables and a short render. The new code must reproduce them in the default configuration.
- `node --test` for pure modules: schema integrity (unique ids, defaults within range); modulation evaluator (sums, clamping, per-voice envelopes); transport (beat/second conversion, MIDI tick parsing, tempo smoothing, clock loss); analysis; parsers; loop seamlessness.
- Engine contract tests (frames in, audio out) that any Voice Engine must pass, including a future Faust one.
- A browser smoke page and a short manual checklist for UI and MIDI (needs a device or virtual port).

## 10. Error handling

- Parse failures show in the status line.
- Missing Web MIDI hides the MIDI option with a note.
- Clock loss shows "clock lost" and holds.
- Worklet load failure (including opening via `file://`) shows a message to serve over HTTP(S).
- A layer on an unconvertible unit shows a warning.
