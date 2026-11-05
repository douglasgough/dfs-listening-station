import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engineContract } from '../../src/audio/engine-contract.js';
import { createChannelSynth } from '../../src/dsp/additive.js';

engineContract(createChannelSynth, { test, assert });
