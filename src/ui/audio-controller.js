/*
 * Audio controller (Task 20): the one object that owns the live audio side of the app and exposes it to the UI as
 * plain methods and events. No DOM here (downloads go through wav.js downloadBlob; MIDI through midi-input.js).
 *
 *   start()/stopAudio()      create/suspend the live graph and its Driver (needs a user gesture the first time)
 *   play()/pause()           the central Transport (internal clock); with source 'midi' the MIDI follower owns it
 *   setStereo(on)            rebuild the graph with another channel layout (R18: the Driver keeps time monotonic)
 *   midi*                    Web MIDI clock + CC; learn hook for the matrix
 *   record()/stopRecording()/playTake()/stopTake()/clearTake()   takes are param changes in transport seconds
 *   exportLoop()/exportTake()/savePatch()/loadPatchText()
 *   trigger(ch), getPlayhead(ch), patternStep(ch)
 *   on(fn)                   fn({type, ...}) for 'listening' | 'meters' | 'status' | 'take' | 'midi' | 'transport'
 */
import { createGraph } from '../audio/graph.js';
import { Driver } from '../audio/driver.js';
import { Transport, timeMap, timeValueCycles } from '../core/transport.js';
import { MidiClockFollower } from '../core/midi-clock.js';
import { midiSupported, listInputs, connect as midiConnect } from '../audio/midi-input.js';
import { renderOffline } from '../audio/render.js';
import { encodeWav24, downloadBlob } from '../audio/wav.js';
import { recordChange } from '../core/score.js';
import { serializePatch, deserializePatch } from '../core/state.js';
import { allParamIds, paramDef } from '../core/schema.js';

export function createAudioController({ store, app, getStage, onStageAnalysers } = {}) {
  const transport = new Transport({ bpm: store.get('g.transport.bpm') });
  const follower = new MidiClockFollower(transport);
  const listeners = new Set();
  const cc = {};
  const output = { stereo: true, synced: true, bars: 4, seconds: 8 };
  const meters = { peak: [0, 0, 0, 0], rms: [0, 0, 0, 0] };
  let graph = null, driver = null, listening = false, building = null;
  let take = null, playingTake = false, recording = null, countIn = null;
  let midiDisconnect = null, midiInputId = null, midiState = 'idle', learnCb = null;
  let poller = null, lastBpm = store.get('g.transport.bpm'), lastSource = transport.source, lastRunning = false;

  const emit = e => { for (const fn of [...listeners]) fn(e); };
  const status = text => emit({ type: 'status', text });
  const nowSec = () => (graph ? graph.ctx.currentTime + (driver ? driver.clockOffset : 0) : 0);

  // the BPM param drives the Transport while the source is internal (MIDI sets it from the clock instead)
  const offStore = store.subscribe((id, v) => {
    if (id === 'g.transport.bpm' && transport.source === 'internal') { transport.setBpm(v, nowSec()); lastBpm = v; emit({ type: 'transport' }); }
    if (recording && typeof id === 'string' && paramDef(id)) recordChange(recording.take, Math.max(0, transport.secondsAt(nowSec())), id, v);
  });

  async function buildGraph() {
    const g = await createGraph({ live: true, stereo: output.stereo, stats: false });
    g.mixer.onMeters(m => { meters.peak = m.peak; meters.rms = m.rms; emit({ type: 'meters', meters }); });
    return g;
  }

  async function start() {
    if (building) return building;
    building = (async () => {
      try {
        if (!graph) {
          graph = await buildGraph();
          driver = new Driver({
            graph, store, transport, cc,
            getAnalyses: () => app.getAnalyses(), getStage: () => (getStage ? getStage() : app.getStage()),
            getTake: () => (playingTake ? take : null), getHold: () => app.timelineHold,
          });
          if (onStageAnalysers) onStageAnalysers({ analyser: graph.mixer.analyser, analyserL: graph.mixer.analyserL, analyserR: graph.mixer.analyserR });
        }
        await graph.ctx.resume();
        if (transport.source === 'internal' && !transport.running) transport.start(nowSec());
        driver.start();
        listening = true;
        if (!poller) poller = setInterval(poll, 200);
        emit({ type: 'listening', on: true }); emit({ type: 'transport' });
      } catch (e) { status(String(e && e.message || e)); throw e; } finally { building = null; }
    })();
    return building;
  }

  async function stopAudio() {
    if (!graph) return;
    driver.stop();
    await graph.ctx.suspend();
    listening = false;
    emit({ type: 'listening', on: false });
  }

  async function setStereo(on) {
    output.stereo = !!on;
    emit({ type: 'transport' });
    if (!graph) return;
    const was = listening, old = graph;
    driver.stop();
    graph = await buildGraph();
    driver.setGraph(graph);
    if (onStageAnalysers) onStageAnalysers({ analyser: graph.mixer.analyser, analyserL: graph.mixer.analyserL, analyserR: graph.mixer.analyserR });
    try { old.dispose(); } catch (e) { /* already closed */ }
    if (was) { await graph.ctx.resume(); driver.start(); }
  }

  // ---- transport ---------------------------------------------------------------------------------
  async function play() { await start(); if (transport.source === 'internal' && !transport.running) transport.start(nowSec()); emit({ type: 'transport' }); }
  function pause() { if (transport.source === 'internal') transport.stop(nowSec()); emit({ type: 'transport' }); }
  const transportInfo = () => ({ running: transport.running, bpm: transport.bpm, source: transport.source, beat: graph ? transport.beatAt(nowSec()) : 0 });

  // ---- MIDI ----------------------------------------------------------------------------------------
  const onCc = (n, v) => {
    if (learnCb) { const cb = learnCb; learnCb = null; cb(n); }
    cc[`g.cc${n}`] = v;
  };
  async function midiConnectInput(id) {
    await start();
    midiDisconnectInput();
    midiDisconnect = await midiConnect(id, follower, nowSec, onCc);
    midiInputId = id; transport.source = 'midi'; midiState = 'idle';
    emit({ type: 'midi', state: midiState, input: id }); emit({ type: 'transport' });
  }
  function midiDisconnectInput() {
    if (midiDisconnect) { try { midiDisconnect(); } catch (e) { /* port gone */ } midiDisconnect = null; }
    midiInputId = null; midiState = 'idle';
    if (transport.source === 'midi') { transport.source = 'internal'; transport.setBpm(store.get('g.transport.bpm'), nowSec()); }
    emit({ type: 'midi', state: 'idle', input: null }); emit({ type: 'transport' });
  }
  function onLearn(cb) { learnCb = cb; return () => { if (learnCb === cb) learnCb = null; }; }

  // ---- periodic bookkeeping ---------------------------------------------------------------------------
  function poll() {
    if (!graph) return;
    const now = nowSec();
    // anything that changed the transport behind the UI's back (a MIDI start/stop, the clock source) re-syncs it
    if (transport.source !== lastSource || transport.running !== lastRunning) { lastSource = transport.source; lastRunning = transport.running; emit({ type: 'transport' }); }
    if (midiInputId !== null) {
      const s = follower.poll(now);
      if (s !== midiState) { midiState = s; emit({ type: 'midi', state: s, input: midiInputId }); emit({ type: 'transport' }); }
      if (transport.source === 'midi' && Math.abs(transport.bpm - lastBpm) > 0.05) { lastBpm = transport.bpm; emit({ type: 'transport' }); }
    }
    if (playingTake && take && transport.secondsAt(now) >= take.dur + 1) stopTake();
  }

  // ---- takes -------------------------------------------------------------------------------------------
  async function record(countInSec = 3) {
    if (recording || countIn) return;
    await start();
    const begin = () => {
      countIn = null;
      const now = nowSec();
      transport.locate(0, now);
      if (!transport.running && transport.source === 'internal') transport.start(now);
      const t = { dur: 0, bpm: transport.bpm, events: [] };
      for (const id of allParamIds()) recordChange(t, 0, id, store.get(id));
      recording = { take: t };
      emit({ type: 'take', state: 'recording' }); emit({ type: 'transport' });
    };
    if (countInSec > 0) {
      let left = Math.ceil(countInSec);
      const tick = () => { emit({ type: 'take', state: 'count', left }); if (left-- <= 0) begin(); else countIn = setTimeout(tick, 1000); };
      tick();
    } else begin();
  }
  function stopRecording(cancel = false) {
    if (countIn) { clearTimeout(countIn); countIn = null; emit({ type: 'take', state: take ? 'ready' : 'none' }); return; }
    if (!recording) return;
    const r = recording; recording = null;
    if (!cancel) { r.take.dur = Math.max(0.1, transport.secondsAt(nowSec())); take = r.take; }
    emit({ type: 'take', state: take ? 'ready' : 'none' });
  }
  async function playTake() {
    if (!take || recording) return;
    await start();
    const now = nowSec();
    playingTake = true;
    transport.locate(0, now);
    if (!transport.running && transport.source === 'internal') transport.start(now);
    emit({ type: 'take', state: 'playing' }); emit({ type: 'transport' });
  }
  function stopTake() { if (!playingTake) return; playingTake = false; emit({ type: 'take', state: take ? 'ready' : 'none' }); }
  function clearTake() { stopTake(); take = null; emit({ type: 'take', state: 'none' }); }

  // ---- export / patches ----------------------------------------------------------------------------------
  const project = () => ({ state: store.state, analyses: app.getAnalyses(), stage: getStage ? getStage() : app.getStage() });
  const renderOpts = () => ({ stereo: output.stereo, synced: output.synced, bars: output.bars, seconds: output.seconds, bpm: store.get('g.transport.bpm') });
  async function exportLoop() {
    if (!app.getStage()) throw new Error('Load a spectrum first.');
    status('Rendering the loop…');
    const r = await renderOffline(project(), 'loop', renderOpts());
    downloadBlob('station-loop.wav', encodeWav24(r.chans, r.sampleRate), 'audio/wav');
    status(`Exported a ${r.lengthSec.toFixed(2)} s loop.`);
    return r;
  }
  async function exportTake() {
    if (!take) throw new Error('Record a take first.');
    status('Rendering the take…');
    const r = await renderOffline(project(), 'take', { ...renderOpts(), take });
    downloadBlob('station-take.wav', encodeWav24(r.chans, r.sampleRate), 'audio/wav');
    status(`Exported a ${r.lengthSec.toFixed(2)} s take.`);
    return r;
  }
  function savePatch() {
    const text = serializePatch(store.state, app.layers);
    downloadBlob('station-patch.json', new TextEncoder().encode(text), 'application/json');
    return text;
  }
  /** Load a patch file's text. Returns the warnings. Throws a clear Error for a file that is not a patch. */
  function loadPatchText(text) {
    const { state, layers, warnings } = deserializePatch(text);
    app.replaceLayers(layers);
    store.load(state);
    app.select(0);
    stopTake(); take = null; emit({ type: 'take', state: 'none' });
    return warnings;
  }

  // ---- helpers for the UI ----------------------------------------------------------------------------------
  function trigger(ch) {
    if (!driver) return false;
    return driver.trigger(ch);
  }
  function getPlayhead(ch) {
    if (!graph || !listening) return null;
    const tl = store.state.timelines[ch];
    if (!tl || !tl.events.length) return null;
    const tm = timeMap(transport, nowSec());
    const cycles = timeValueCycles(tl.len, { beat: tm.beat, sec: tm.sec });
    return Number.isFinite(cycles) ? ((cycles % 1) + 1) % 1 : null;
  }
  function patternStep(ch) {
    if (!graph || !listening || !transport.running || store.get(`ch${ch + 1}.event.mode`) !== 'pattern') return -1;
    const tm = timeMap(transport, nowSec());
    const steps = Math.round(store.get(`ch${ch + 1}.event.steps`));
    const c = timeValueCycles(store.get(`ch${ch + 1}.event.stepLen`), { beat: tm.beat, sec: tm.sec });
    return Number.isFinite(c) && steps > 0 ? ((Math.floor(c) % steps) + steps) % steps : -1;
  }

  return {
    transport, follower, output, meters, cc,
    get graph() { return graph; }, get driver() { return driver; },
    get listening() { return listening; }, get take() { return take; },
    get recording() { return !!recording; }, get countingIn() { return !!countIn; }, get playingTake() { return playingTake; },
    get midiInput() { return midiInputId; }, get midiState() { return midiState; },
    midiSupported, listMidiInputs: listInputs,
    start, stopAudio, setStereo, play, pause, transportInfo, nowSec,
    midiConnectInput, midiDisconnectInput, onLearn,
    record, stopRecording, playTake, stopTake, clearTake,
    exportLoop, exportTake, savePatch, loadPatchText,
    trigger, getPlayhead, patternStep,
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    dispose() {
      offStore(); if (poller) clearInterval(poller); if (countIn) clearTimeout(countIn);
      midiDisconnectInput(); if (driver) driver.stop(); if (graph) { try { graph.dispose(); } catch (e) { /* closed */ } }
      listeners.clear();
    },
  };
}
