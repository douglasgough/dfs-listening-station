/*
 * Header transport (Task 20): Start listening, transport Play/Pause, BPM, clock source (Internal | MIDI), MIDI input
 * picker with a "clock lost" indicator, and a bar/beat readout. Talks to the audio controller only.
 *
 * createTransportUI(host, {store, audio}) -> dispose
 */
import { el } from './controls.js';

export function createTransportUI(host, { store, audio } = {}) {
  const cleanups = [];
  const root = el('div', { class: 'transportbar' });
  const bListen = el('button', { class: 'btn primary', type: 'button', id: 'btnListen', text: 'Start listening', tip: 'Start or stop live audio. Nothing sounds until you press this.' });
  const bPlay = el('button', { class: 'btn', type: 'button', id: 'btnPlay', text: 'Play', 'aria-pressed': 'false', tip: 'Run or hold the central clock. LFOs, events and timelines move only while it runs.' });
  const bpm = el('input', { type: 'number', min: '20', max: '300', step: '1', id: 'numBpm', 'aria-label': 'Tempo in BPM', style: 'width:68px' });
  const seg = el('span', { class: 'seg', role: 'group', 'aria-label': 'Clock source' });
  const bInt = el('button', { type: 'button', text: 'Internal', tip: 'The app\'s own clock, set by the BPM field.' });
  const bMidi = el('button', { type: 'button', text: 'MIDI', tip: 'Follow an external MIDI clock (start, stop, tempo and song position).' });
  seg.append(bInt, bMidi);
  const sel = el('select', { 'aria-label': 'MIDI input', hidden: '' });
  const bRescan = el('button', { class: 'btn', type: 'button', text: 'Rescan', hidden: '', tip: 'Look for MIDI devices again.' });
  const state = el('span', { class: 'status', role: 'status', 'aria-live': 'polite' });
  const pos = el('span', { class: 'status', id: 'tpos' });
  root.append(bListen, bPlay, el('label', { class: 'inline' }, 'BPM ', bpm), seg, sel, bRescan, state, pos);
  host.append(root);

  const on = (t, type, fn) => { t.addEventListener(type, fn); cleanups.push(() => t.removeEventListener(type, fn)); };
  const guard = fn => async (...a) => { try { await fn(...a); } catch (e) { state.textContent = String(e && e.message || e); } };

  async function scan() {
    if (!audio.midiSupported()) return;
    const list = await audio.listMidiInputs();
    sel.textContent = '';
    sel.append(el('option', { value: '', text: list.length ? 'Choose a MIDI input…' : 'No MIDI inputs found' }));
    for (const i of list) sel.append(el('option', { value: i.id, text: i.name }));
    if (audio.midiInput) sel.value = audio.midiInput;
  }

  function sync() {
    const info = audio.transportInfo();
    bListen.textContent = audio.listening ? 'Stop listening' : 'Start listening';
    bListen.classList.toggle('on', audio.listening);
    bPlay.textContent = info.running ? 'Pause' : 'Play';
    bPlay.setAttribute('aria-pressed', String(info.running));
    bPlay.disabled = info.source === 'midi';
    bPlay.title = info.source === 'midi' ? 'The external MIDI clock controls the transport.' : '';
    if (document.activeElement !== bpm) bpm.value = String(Math.round(info.bpm * 10) / 10);
    bpm.disabled = info.source === 'midi';
    const midi = info.source === 'midi';
    bInt.classList.toggle('on', !midi); bMidi.classList.toggle('on', midi);
    bInt.setAttribute('aria-pressed', String(!midi)); bMidi.setAttribute('aria-pressed', String(midi));
    const supported = audio.midiSupported();
    bMidi.disabled = !supported;
    bMidi.title = supported ? '' : 'Web MIDI is not available in this browser (try Chrome, Edge or Firefox).';
    sel.hidden = !supported || !midi && !sel.options.length; bRescan.hidden = sel.hidden;
    if (midi) { sel.hidden = false; bRescan.hidden = false; }
    const ms = audio.midiState;
    state.textContent = midi ? (audio.midiInput ? (ms === 'lost' ? 'MIDI clock lost — holding' : ms === 'ok' ? 'MIDI clock locked' : 'Waiting for MIDI clock…') : 'Choose a MIDI input') : '';
    state.classList.toggle('warn', midi && ms === 'lost');
  }
  function readout() {
    const info = audio.transportInfo();
    if (!audio.listening) { pos.textContent = ''; return; }
    const beat = Math.max(0, info.beat), bar = Math.floor(beat / 4) + 1, b = Math.floor(beat % 4) + 1;
    pos.textContent = `bar ${bar} · beat ${b}`;
  }

  on(bListen, 'click', guard(async () => { if (audio.listening) await audio.stopAudio(); else await audio.start(); }));
  on(bPlay, 'click', guard(async () => { if (audio.transport.running) audio.pause(); else await audio.play(); }));
  on(bpm, 'change', () => { const v = +bpm.value; if (Number.isFinite(v)) { try { store.set('g.transport.bpm', v); } catch (e) { /* clamped */ } } sync(); });
  on(bInt, 'click', () => { audio.midiDisconnectInput(); sync(); });
  on(bMidi, 'click', guard(async () => { sel.hidden = false; bRescan.hidden = false; await scan(); sync(); }));
  on(sel, 'change', guard(async () => { if (sel.value) await audio.midiConnectInput(sel.value); sync(); }));
  on(bRescan, 'click', guard(scan));

  cleanups.push(audio.on(e => { if (e.type === 'listening' || e.type === 'transport' || e.type === 'midi') sync(); else if (e.type === 'status') state.textContent = e.text; }));
  cleanups.push(store.subscribe(id => { if (id === 'g.transport.bpm') sync(); }));
  const timer = setInterval(readout, 120);
  cleanups.push(() => clearInterval(timer));
  sync();
  return () => { for (const c of cleanups.splice(0)) c(); root.remove(); };
}
