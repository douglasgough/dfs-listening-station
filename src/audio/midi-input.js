/*
 * Web MIDI input glue (browser only). Imports nothing; importing in Node is safe because every
 * access to `navigator` / `performance` is guarded and happens inside functions.
 *
 * Time mapping: MIDIMessageEvent.timeStamp is a DOMHighResTimeStamp (ms) on the
 * performance.now() timeline. A message that arrived `age = performance.now() - timeStamp` ms ago
 * happened at audio time  clock() - age/1000,  where clock() returns the current audio-context
 * time in seconds. Mapped times are clamped to be non-decreasing, so jitter in the offset can
 * never make time run backwards for the follower.
 */

const nav = () => (typeof navigator !== 'undefined' ? navigator : null);

export function midiSupported() {
  const n = nav();
  return !!n && typeof n.requestMIDIAccess === 'function';
}

async function access() {
  if (!midiSupported()) throw new Error('Web MIDI is not supported in this browser');
  return nav().requestMIDIAccess({ sysex: false });
}

/** @returns {Promise<{id:string,name:string}[]>} empty when unsupported or permission is denied. */
export async function listInputs() {
  if (!midiSupported()) return [];
  try {
    const acc = await access();
    return [...acc.inputs.values()].map((i) => ({ id: i.id, name: i.name || i.id }));
  } catch {
    return [];
  }
}

/**
 * Route one input's messages to a MidiClockFollower (and optionally CC messages to onCc).
 * @param {string} inputId
 * @param {{handle:(bytes:ArrayLike<number>, tSec:number)=>void}} follower
 * @param {() => number} clock current audio time in seconds
 * @param {(cc:number, value01:number) => void} [onCc]
 * @returns {Promise<() => void>} resolves with the disconnect function
 */
export async function connect(inputId, follower, clock, onCc) {
  const acc = await access();
  const input = acc.inputs.get(inputId);
  if (!input) throw new Error(`MIDI input not found: ${inputId}`);
  if (typeof input.open === 'function') await input.open();
  let last = -Infinity;
  const onMessage = (ev) => {
    const data = ev.data;
    if (!data || data.length < 1) return;
    const perf = typeof performance !== 'undefined' ? performance : null;
    let t = perf && Number.isFinite(ev.timeStamp) && ev.timeStamp > 0
      ? clock() - (perf.now() - ev.timeStamp) / 1000
      : clock();
    if (t < last) t = last;
    last = t;
    const status = data[0];
    if (status >= 0xb0 && status <= 0xbf) {
      if (onCc && data.length >= 3) onCc(data[1], data[2] / 127);
      return;
    }
    follower.handle(data, t);
  };
  input.addEventListener('midimessage', onMessage);
  // `acc` is captured so the MIDIAccess object stays reachable (and its ports alive) while connected.
  return () => {
    input.removeEventListener('midimessage', onMessage);
    void acc;
  };
}
