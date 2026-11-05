# Acceptance checklist

Run after any change to the engine, score builder or UI. Automated parts: `node --test` and the headless-Chrome
scripts in `tools/browser-tests/` (see its README).

## 1. Sound parity with the prototype (automated)

The prototype's default Allende loop (mono, 48 s, free length) was exported once and its 12 strongest spectral
peaks saved in `tests/fixtures/prototype-allende-peaks.json`.

```sh
cd /tmp/bt        # a scratch dir with puppeteer-core installed
node /path/to/repo/tools/browser-tests/t21-acceptance-render.mjs        # writes /tmp/new-allende-loop.wav
node /path/to/repo/tools/wav-peaks.mjs /tmp/new-allende-loop.wav /tmp/new-peaks.json
node /path/to/repo/tools/compare-peaks.mjs /tmp/new-peaks.json
```

Result at cutover (2026-11-05): **11 of 12 peaks match** (same frequency, level within 0.15 dB). The 12th, 1155 Hz
(= 2 × 577.5 Hz, the octave-up event ping of the strongest band), is +3.2 dB: it is **event-driven** (random events,
a different seed from the prototype's). Rendering with events switched off removes 1155 Hz from the top 12 entirely
and leaves the drone peaks at the same frequencies. This is the only accepted deviation.

## 2. Automated browser scripts (all should print ALL PASSED)

`t17b-stage` · `t18-channel-panel` · `t18b-timeline` · `t19-matrix` · `t20-audio`, plus the pages
`tests/browser/smoke.html` (offline determinism x5, live CPU, toggling, file:// guard) and `render.html`
(loop periodicity, take, length).

## 3. By ear / by hand (needs a person)

- Four channels on four different layers (a meteorite, ISM absorption lines, nebular emission lines): each is
  distinct, and the mixer strips balance them.
- A Granular channel is about as loud as a Window channel with the same centre/width (the loudness match).
- Synced LFO follows tempo; changing BPM while listening keeps modulation locked; Free LFO ignores tempo.
- MIDI sync with a real device or a DAW's virtual port: Play follows the external start/stop, tempo tracks,
  unplugging shows "clock lost" and holds; Safari shows MIDI disabled with a note.
- Export loop, drop it in a DAW loop at the same tempo: no seam.
- A flat/featureless spectrum file loads and is silent (status says no features), no errors.
- Load a hand-edited patch with an unknown parameter id: loads with a warning.
