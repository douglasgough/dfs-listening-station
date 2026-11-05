# Spectrum Listening Station

Load a spectrum from outside the audio band (meteorite reflectance, ISM absorption lines, nebular emission
lines, your own CSV), move four filter windows across it, and hear it. Each of the four **channels** is a
complete instrument with its own spectrum layer, filter, pitch mapping, drone voices, event generator,
LFOs/envelopes, timeline and mixer strip. A **modulation matrix** routes any source to any destination,
and one **central transport** (internal or MIDI-synced) clocks everything.

## Run it

It is a static site with ES modules and an AudioWorklet: no build step, no dependencies. It must be served
over HTTP(S) (browsers do not load modules or worklets from `file://`; the page says so if you try).

```sh
# this repo is a lerd site:  https://dfs-listening-station.test/
# or any static server, e.g.  npx serve .   /   python3 -m http.server
```

Web MIDI (clock sync, CC) needs Chrome, Edge or Firefox over HTTPS/localhost. Safari has no Web MIDI; the
MIDI option is disabled there with a note.

## Tests

```sh
node --test                 # pure modules: core, spectrum, dsp, audio math, UI models (Node 22, ~3 s)
```

Browser checks (headless Chrome, dev only) live in `tools/browser-tests/` — see its README. They cover the
parts Node cannot: the AudioWorklet engine, offline-render determinism, meters, the UI, MIDI clock through the
controller, takes, exports and patches. `tools/compare-peaks.mjs` compares a render with the original prototype's
spectral peaks (see `tests/acceptance.md`).

## Layout

```
index.html                    shell
src/core/       schema · state · transport · midi-clock · modulation · score · timeline   (pure)
src/spectrum/   layers · analyse · parse · examples                                        (pure)
src/dsp/        window · mapping · events · grains · partials · additive                   (pure)
src/audio/      graph · mixer · driver · render · wav · channel-engine · midi-input · worklets/
src/ui/         stage · layer-panel · channel-panel · timeline · matrix · dock · transport-ui · controls · app-state · audio-controller
tests/          node --test suites + fixtures (prototype golden values)
docs/superpowers/  design spec, implementation plan, worklet spike notes
```

How the pieces fit: a **schema** declares every parameter once (range, default, modulatable, tooltip); sliders,
matrix destinations, patches and takes are all generated from it. A pure **evaluator** resolves parameters at a
given time (base + matrix modulation + timeline + take). `buildScore` turns that into timestamped **control
frames** per channel, identically for live playback (the `Driver` calls it in short chunks) and offline export.
Each channel's frames feed an AudioWorklet synth (`ChannelSynth`); a fixed-order `mixer-bus` worklet sums the
four strips (fixed order is what makes offline renders bit-identical).

**Voice Engine boundary:** nothing outside `src/audio/` depends on how voices are made. The interface
(`src/audio/engine-contract.js`: control frames in, audio out) has contract tests, so another engine (an FM engine
or a Faust one) can replace `ChannelSynth` without touching the rest.

## Adding a parameter

1. Add a `ParamDef` to `CHANNEL_PARAMS` (or `GLOBAL_PARAMS`) in `src/core/schema.js` (key, label, unit, min, max,
   default, `modulatable`, tip, type).
2. It then appears in the patch format, the store, takes, and — if `modulatable` — as a matrix row.
3. Add it to the matching section list in `src/ui/channel-panel.js` so a control is built for it, and read it from
   `ch[...]` where the DSP needs it (`src/dsp/partials.js` etc.).

## Patches, takes, exports

- **Patch** (`Save patch`): JSON `{v: 4, app: 'spectrum-listening-station', params, mods, timelines, pattern, matrix, layers}`.
  Older prototype patches are not migrated.
- **Take**: your control moves recorded against the transport (`Record`, optional 3 s count-in); replayed in sync.
- **Export loop**: seamless 24-bit 48 kHz WAV; a synced loop is whole bars at the current tempo, a free loop is
  seconds. **Export take** renders the take offline.

## Known limits

- A loop whose length is not a whole number of samples (for example some tempos) is periodic to about −60 dB
  (the noise bed has an integer-sample length).
- Spectrum cubes / time series (a third axis), spectrum-derived modulation sources and FITS import are not built.
  The layer model and importer registry leave room for them.
- Only Chrome on macOS has been used for browser testing.
