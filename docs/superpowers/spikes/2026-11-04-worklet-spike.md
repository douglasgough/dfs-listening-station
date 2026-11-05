# Worklet spike: import, offline determinism, CPU (Task 0)

Date: 2026-11-04. Branch `channel-architecture`. Environment: headless Google Chrome 156.0.8078.80, macOS, Apple M3, driven by puppeteer-core from a scratch directory outside the repo; page served over HTTPS by lerd (self-signed cert ignored). Firefox and Safari: **not tested** (not available).

## Verdict

| Check | Result |
|---|---|
| (a) Worklet statically `import`s a shared module from `../src/dsp/` | **PASS** in Chrome 156. Firefox / Safari not tested. No bundling step needed. |
| (b) Offline determinism with timestamped frames | **PASS, with one mandatory graph rule** (below). The naive graph (4 worklets connected straight to one destination/bus) is **NOT bit-identical**. |
| (c) CPU, 4 banks x 114 oscillators, mean `process()` < 1.33 ms | **PASS**: about 0.15 to 0.19 ms per call (realtime, 10 s); about 0.6 to 0.75 ms summed over the 4 banks per quantum, against a 2.67 ms quantum budget. |

Go for the channel-worklet architecture. Task 14 to 16 must obey the two rules in "Rules for later tasks".

## What was built (deleted after recording)

- `src/dsp/spike-shared.js`: one function, `lcgNext(state)` (32-bit LCG: `(Math.imul(s,1664525)+1013904223)>>>0`).
- `spike/voice.js` (worklet module): `import { lcgNext } from '../src/dsp/spike-shared.js'`. Processor `spike-voice`: one bank of N = 114 sine oscillators (30 band + 64 comb + 20 noise-band stand-ins). `Float64Array` phases, per-oscillator gain ramped linearly across each 128-frame quantum, `Math.sin` per oscillator per sample. The 20 noise-band stand-ins have their target gain multiplied once per quantum by `0.9 + 0.2*lcg` (deterministic). Also processor `spike-mixer`: fixed-order summing mixer (below).
- `spike/worklet.html` (module script): builds 4 banks, builds a deterministic score per bank (8 frames at t = 0, 0.0031, 0.5, 0.987, 1.5, 2.25, 3.3333, 4.1 s, each with 114 freqs and gains from a seeded LCG; deliberately not quantum-aligned), posts the score to each node's port **before** `startRendering()`, renders `OfflineAudioContext(…, 48000)` several times and compares the Float32 output sample by sample (`Object.is`) plus an FNV hash. Realtime mode uses `new AudioContext({sampleRate:48000})` for 10 s.

Timestamped-frame application (the key snippet; this is the whole mechanism):

```js
process(inputs, outputs) {
  const t0 = now();
  // A frame takes effect at the first quantum whose start (currentFrame) is >= its timestamp frame.
  while (this.next < this.score.length && currentFrame >= this.score[this.next].frame) {
    this.applyFrame(this.score[this.next]);   // sets per-osc phase increment (2*pi*f/sampleRate) and target gain
    this.next++;
  }
  this.render(outputs[0][0]);                 // sum of g*Math.sin(ph) over 114 oscillators, gain ramped over the quantum
  ...
  return true;
}
// main thread, before startRendering():
node.port.postMessage({ type: 'score', frames: [{ frame: Math.round(t*SR), freqs: Float32Array(114), gains: Float32Array(114) }, ...] });
// processor replies {type:'ack'} from its onmessage handler; main awaits all 4 acks (handshake) before startRendering().
```

Fixed-order mixer (needed for determinism, see (b)):

```js
class SpikeMixer extends AudioWorkletProcessor {   // numberOfInputs = number of channels, outputChannelCount [2]
  process(inputs, outputs) {
    const o = outputs[0];
    for (let c = 0; c < o.length; c++) o[c].fill(0);
    for (let i = 0; i < inputs.length; i++)          // input index order is fixed
      for (let c = 0; c < o.length; c++) {
        const ch = inputs[i][c] || inputs[i][0];
        if (ch) for (let n = 0; n < ch.length; n++) o[c][n] += ch[n];
      }
    return true;
  }
}
```

## (a) Import

`addModule('./voice.js')` where `voice.js` statically imports `../src/dsp/spike-shared.js` loaded and ran in Chrome 156: the imported `lcgNext` drives the noise stand-ins, and the output is non-silent and deterministic, so the import resolved and executed. Relative paths resolve against the worklet module URL, and lerd serves `.js` with a module-compatible MIME type. No `tools/bundle-worklet.mjs` fallback is needed for Chrome. Firefox and Safari: **not tested**, so the import claim is Chrome-only. Task 14 should still keep `src/audio/worklet/channel-voice.js` importing only from `src/dsp/` and keep the fallback idea in reserve.

## (b) Offline determinism

Method: render the same posted score N times in fresh `OfflineAudioContext`s and compare all samples exactly. A different score (variant 1) gave a different hash (`ed91056e` vs `7d617599`), so the comparison is not vacuous. The first run applied frames as expected (see below).

Results (4 banks, 5 s unless noted, 10 runs each):

| Topology (all banks feed ...) | Bit-identical across 10 runs? |
|---|---|
| directly to `ctx.destination` (implicit summing junction, 4 inputs) | **NO**: 7 or more distinct hashes in 10 runs; first differing sample about index 1 to 4 |
| directly, 3 banks | NO (3 distinct hashes in 8 runs) |
| directly, 1 or 2 banks | yes (2 inputs: float addition is commutative) |
| pairwise `GainNode` tree (each junction has at most 2 inputs) | **yes** (hash `1ff1c132` x10) |
| one fixed-order mixer worklet, mono | **yes** (hash `2dd6cbb5` x10) |
| realistic strips: bank -> `GainNode` -> `StereoPannerNode` -> stereo mixer worklet -> `DynamicsCompressorNode` -> destination | **yes** (hash `ed91056e` x10; also x10 with no ack handshake; 10 s render x3: `4d2715db`) |

Cause: Chrome sums the connections into an input with 3 or more sources in an unspecified (hash-set) order, and float addition is not associative, so the low bits differ between renders. The worklets themselves, the posted score and the frame application are deterministic. This only bites when 3 or more nodes feed one input.

Frame application timing: with `currentFrame >= t*sampleRate` at quantum granularity, a frame stamped at sample 149 was applied at the quantum starting at 256, 24000 -> 24064 (24000 is not a multiple of 128), 47376 -> 47488, 159998 -> 160000. Application is up to 127 frames (2.65 ms at 48 kHz) late but identical every run. If sample-accurate event onsets are wanted later, the processor must split the quantum at the frame boundary; this spike does not.

The ack handshake (processor replies after receiving the score; main awaits before `startRendering`) is not needed in the observed runs (10 of 10 identical without it) but it is cheap and removes a theoretical race between port delivery and the first `process()`. Keep it in `render.js`.

Not verified: determinism across different machines, OS or browser builds (only repeated renders in one Chrome on one Mac); stereo `StereoPannerNode` and `DynamicsCompressorNode` were deterministic on this machine.

## (c) CPU

Pass threshold: mean `process()` under 1.33 ms per 128-frame call at 48 kHz.

Measurement notes:
- `performance` is **undefined in Chrome's AudioWorkletGlobalScope** (`hasPerf: false`), so `performance.now()` cannot be used inside the processor as the brief assumed. In-processor timing used `Date.now()` (1 ms ticks). Per-call deltas are quantised to 0 or 1 ms, but because the 2.667 ms call cadence walks through the millisecond phase, the sum of deltas over thousands of calls is an unbiased estimate of total time, so the mean is usable (per-call max and "over 1.33 ms" counts are not: a count of 1 in about 3700 calls is a tick artefact).
- Cross-check 1: tight-loop benchmark inside the processor (20000 quanta timed with one `Date.now()` pair, run on an offline context with nothing else rendering): **0.038 ms per call per bank** (hot, best case).
- Cross-check 2: wall clock of a 10 s offline render of 4 banks, `performance.now()` on the main thread: 1.38 to 1.42 s, i.e. 0.37 ms per quantum for all 4 banks (0.092 ms per bank), about 7x faster than real time. (Includes rendering overhead.)
- The machine had background load (load average about 2.7).

Results, realtime `AudioContext` at 48000 Hz, 4 banks x 114 oscillators (456 partials), 10 s, about 3700 calls per bank:

| Run | Mean ms per call per bank (4 banks) | Mean over banks | Sum over 4 banks per quantum |
|---|---|---|---|
| 1 | 0.187, 0.191, 0.186, 0.181 | **0.186 ms** | 0.746 ms |
| 2 | 0.142, 0.160, 0.159, 0.149 | **0.153 ms** | 0.611 ms |
| earlier run | 0.178, 0.186, 0.173 (bank 0 unreadable) | about 0.18 ms | about 0.71 ms |

All far under 1.33 ms (about 7x to 9x margin per bank). Across the 4 banks, the audio thread uses roughly 0.6 to 0.75 ms of the 2.667 ms quantum (22 to 28 percent) for the synthesis loop alone, on an M3. The realtime figures are about 4x the hot-loop benchmark (cold caches between calls, thread scheduling).

Step 3 reduction (`COMB` 32, `NK` 10) was **not needed** and was not run. Caveats: this is a bare sine bank; the real worklet also evaluates window gains, event voices and strip smoothing, and lower-power devices (phones, older laptops) will be slower. Task 14 to 16 should re-measure with the real engine; the smoke test threshold in the plan (mean < 1.33 ms) still applies, and a comfortable target is the sum over 4 channels below about 1.3 ms (half a quantum).

## Rules for later tasks

1. **Never let 3 or more nodes feed one audio input in a path that must render deterministically.** The master bus (4 channel strips) must sum through a fixed-order mixer worklet (input i added in index order; as above) or a pairwise tree of 2-input junctions. Analysers and other tap-only connections are fine. This belongs in `src/audio/graph.js` / `mixer.js` and in the offline render path.
2. **Do not use `performance.now()` inside the worklet.** Expose per-call timing as `Date.now()` sums (or a tight-loop bench) as done here, or time on the main thread. The Task 16 smoke test that asserts a mean process time must use this.
3. Post the whole score and await a handshake from every node before `startRendering()`.

## Reproduce

Serve the repo at an HTTPS host; load `spike/worklet.html` (expose `window.spike = { renderOffline, determinism, realtime, offlineSpeed }`); drive it from `puppeteer-core` with `--autoplay-policy=no-user-gesture-required --ignore-certificate-errors`. The code above plus the description of the page is sufficient to rebuild it.
