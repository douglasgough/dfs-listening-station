import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as m from '../../src/audio/midi-input.js';

const desc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
function setNavigator(v) {
  Object.defineProperty(globalThis, 'navigator', { value: v, configurable: true, writable: true });
}
function restoreNavigator() {
  if (desc) Object.defineProperty(globalThis, 'navigator', desc);
  else delete globalThis.navigator;
}

// Fix the performance timeline so "N ms ago" stamps are positive regardless of process uptime.
const perfDesc = Object.getOwnPropertyDescriptor(globalThis, 'performance');
const PERF_NOW = 10000;
function fakePerformance() {
  Object.defineProperty(globalThis, 'performance', { value: { now: () => PERF_NOW }, configurable: true, writable: true });
}
function restorePerformance() { Object.defineProperty(globalThis, 'performance', perfDesc); }

function fakeInput(id = 'in1', name = 'Fake') {
  const listeners = new Set();
  return {
    id, name, opened: 0, listeners,
    open() { this.opened++; return Promise.resolve(this); },
    addEventListener(type, fn) { if (type === 'midimessage') listeners.add(fn); },
    removeEventListener(type, fn) { if (type === 'midimessage') listeners.delete(fn); },
    emit(data, timeStamp) { for (const fn of [...listeners]) fn({ data, timeStamp }); },
  };
}
function fakeNavigator(input, calls = []) {
  return {
    requestMIDIAccess: async (opts) => {
      calls.push(opts);
      return { inputs: new Map([[input.id, input]]) };
    },
  };
}

test('without Web MIDI: unsupported, listInputs is empty, connect rejects', async () => {
  assert.equal(m.midiSupported(), false);
  assert.deepEqual(await m.listInputs(), []);
  await assert.rejects(() => m.connect('x', { handle() {} }, () => 0));
});

test('with Web MIDI: supported, lists inputs, requests sysex:false', async () => {
  const input = fakeInput();
  const calls = [];
  setNavigator(fakeNavigator(input, calls));
  try {
    assert.equal(m.midiSupported(), true);
    assert.deepEqual(await m.listInputs(), [{ id: 'in1', name: 'Fake' }]);
    assert.deepEqual(calls[0], { sysex: false });
  } finally { restoreNavigator(); }
});

test('connect: opens port, maps timestamps to audio time, clamps non-decreasing, routes CC, disconnects', async () => {
  const input = fakeInput();
  setNavigator(fakeNavigator(input));
  fakePerformance();
  try {
    const got = [];
    const ccs = [];
    const follower = { handle: (bytes, t) => got.push([[...bytes], t]) };
    const clock = () => 100;
    const disconnect = await m.connect('in1', follower, clock, (cc, v) => ccs.push([cc, v]));
    assert.equal(typeof disconnect, 'function');
    assert.equal(input.opened, 1);
    assert.equal(input.listeners.size, 1);

    // Message stamped 500 ms ago on the performance timeline -> ~99.5 audio seconds.
    input.emit(Uint8Array.of(0xf8), PERF_NOW - 500);
    assert.equal(got.length, 1);
    assert.ok(Math.abs(got[0][1] - 99.5) < 1e-9, `t=${got[0][1]}`);

    // An older stamp would map earlier; it must be clamped to the previous time.
    input.emit(Uint8Array.of(0xf8), PERF_NOW - 5000);
    assert.equal(got[1][1], got[0][1]);

    // A newer stamp moves forward.
    input.emit(Uint8Array.of(0xfa), PERF_NOW - 10);
    assert.ok(got[2][1] > got[0][1]);

    // Control change on any channel goes to onCc only.
    input.emit(Uint8Array.of(0xb0, 7, 127), PERF_NOW);
    input.emit(Uint8Array.of(0xbf, 1, 0), PERF_NOW);
    input.emit(Uint8Array.of(0xb3, 74, 64), PERF_NOW);
    assert.deepEqual(ccs, [[7, 1], [1, 0], [74, 64 / 127]]);
    assert.equal(got.length, 3);

    // Non-CC channel messages still go to the follower.
    input.emit(Uint8Array.of(0x90, 60, 100), PERF_NOW);
    assert.equal(got.length, 4);

    disconnect();
    assert.equal(input.listeners.size, 0);
    input.emit(Uint8Array.of(0xf8), PERF_NOW);
    assert.equal(got.length, 4);
  } finally { restorePerformance(); restoreNavigator(); }
});

test('connect rejects for an unknown input id', async () => {
  setNavigator(fakeNavigator(fakeInput()));
  try {
    await assert.rejects(() => m.connect('nope', { handle() {} }, () => 0), /not found/);
  } finally { restoreNavigator(); }
});

test('permission denied: connect rejects and listInputs resolves []', async () => {
  setNavigator({ requestMIDIAccess: () => Promise.reject(new Error('SecurityError')) });
  try {
    assert.equal(m.midiSupported(), true);
    assert.deepEqual(await m.listInputs(), []);
    await assert.rejects(() => m.connect('in1', { handle() {} }, () => 0), /SecurityError/);
  } finally { restoreNavigator(); }
});
