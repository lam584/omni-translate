import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  LEGACY_FINITE_SILENCE_GRACE_POLICY_ID,
  PROVIDER_INPUT_PREFILTER_FILE,
  PROVIDER_INPUT_PREFILTER_MAGIC,
  readProviderInputPrefilterFrames,
  replayProviderInputPrefilter,
} from './watch-mode-external-provider-budget.mjs';
import { deriveWatchModelProtocolIdentity } from './watch-mode-model-protocol-authority.mjs';

const LIVETRANSLATE_MODEL = 'qwen3.5-livetranslate-flash-realtime';
const NON_LIVETRANSLATE_MODEL = 'qwen3.5-omni-flash-realtime';
const CHUNK_SAMPLES = 320;
const CHUNK_RAW_BYTES = CHUNK_SAMPLES * 3 * 8;
const MINIMUM_CHUNK_RMS = 0.002;
const SILENCE_GRACE_CHUNKS = 40;

function rustF32(value) { return Math.fround(value); }
function rustF32ToI16(value) {
  if (Number.isNaN(value)) return 0;
  if (value >= 32_767) return 32_767;
  if (value <= -32_768) return -32_768;
  return Math.trunc(value);
}
function resampleLikeProduction(rawChunk) {
  const output = Buffer.allocUnsafe(Math.floor((rawChunk.length / 8) / 3) * 2);
  for (let outputIndex = 0; outputIndex < output.length / 2; outputIndex += 1) {
    let sum = rustF32(0);
    for (let offset = 0; offset < 3; offset += 1) {
      const frameOffset = (outputIndex * 3 + offset) * 8;
      const mono = rustF32(rustF32(
        rawChunk.readFloatLE(frameOffset) + rawChunk.readFloatLE(frameOffset + 4),
      ) * rustF32(0.5));
      sum = rustF32(sum + mono);
    }
    const averaged = rustF32(sum / rustF32(3));
    const clamped = Math.min(1, Math.max(-1, averaged));
    output.writeInt16LE(rustF32ToI16(rustF32(clamped * rustF32(32_767))), outputIndex * 2);
  }
  return output;
}
function rawChunk(amplitude) {
  const raw = Buffer.alloc(CHUNK_RAW_BYTES);
  for (let offset = 0; offset < raw.length; offset += 8) {
    raw.writeFloatLE(amplitude, offset);
    raw.writeFloatLE(amplitude, offset + 4);
  }
  return raw;
}
function writePrefilter(t, amplitudes) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-silence-replay-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const framed = amplitudes.map((amplitude) => {
    const raw = rawChunk(amplitude);
    const length = Buffer.alloc(4);
    length.writeUInt32LE(raw.length);
    return Buffer.concat([length, raw]);
  });
  const filePath = path.join(root, PROVIDER_INPUT_PREFILTER_FILE);
  fs.writeFileSync(filePath, Buffer.concat([PROVIDER_INPUT_PREFILTER_MAGIC, ...framed]));
  return filePath;
}

test('r109-style strict replay preserves every low-RMS chunk after first LiveTranslate audible chunk', (t) => {
  const filePath = writePrefilter(t, [0, 0.25, ...Array(43).fill(0), 0.5, 0]);
  const identity = deriveWatchModelProtocolIdentity(LIVETRANSLATE_MODEL);
  const replayResult = replayProviderInputPrefilter({ filePath, maxSamples: 100_000, modelProtocolProfileIdentity: identity });
  const replay = { pcm: replayResult.expectedProviderPcm, attemptedSamples: replayResult.authority.decisions.acceptedSamples, appendCount: replayResult.authority.decisions.acceptedChunks, skipped: replayResult.authority.decisions.skippedSilenceChunks };
  const expectedChunks = 46; // one leading silence remains excluded; all post-audible chunks remain.
  assert.equal(replay.skipped, 1);
  assert.equal(replay.appendCount, expectedChunks);
  assert.equal(replay.attemptedSamples, expectedChunks * CHUNK_SAMPLES);
  assert.equal(replay.pcm.length, replay.attemptedSamples * 2);
  assert.deepEqual(replay.pcm, Buffer.concat([
    resampleLikeProduction(rawChunk(0.25)),
    ...Array(43).fill(null).map(() => resampleLikeProduction(rawChunk(0))),
    resampleLikeProduction(rawChunk(0.5)),
    resampleLikeProduction(rawChunk(0)),
  ]));
});

test('r108-style strict replay leaves the legacy non-LiveTranslate 40-chunk grace policy byte-exact', (t) => {
  const filePath = writePrefilter(t, [0, 0.25, ...Array(43).fill(0), 0.5]);
  const replayResult = replayProviderInputPrefilter({
    filePath,
    maxSamples: 100_000,
    legacyPolicyId: LEGACY_FINITE_SILENCE_GRACE_POLICY_ID,
  });
  const strict = {
    pcm: replayResult.expectedProviderPcm,
    attemptedSamples: replayResult.authority.decisions.acceptedSamples,
    appendCount: replayResult.authority.decisions.acceptedChunks,
    skipped: replayResult.authority.decisions.skippedSilenceChunks,
  };
  const legacyExpected = Buffer.concat([
    resampleLikeProduction(rawChunk(0.25)),
    ...Array(40).fill(null).map(() => resampleLikeProduction(rawChunk(0))),
    resampleLikeProduction(rawChunk(0.5)),
  ]);
  assert.equal(strict.skipped, 4); // leading silence plus three beyond grace.
  assert.equal(strict.appendCount, 42);
  assert.equal(strict.attemptedSamples, 42 * CHUNK_SAMPLES);
  assert.equal(strict.pcm.length, legacyExpected.length);
  assert.deepEqual(strict.pcm, legacyExpected);
});

test('strict replay fails closed before policy selection for a forged LiveTranslate identity', (t) => {
  const filePath = writePrefilter(t, [0.25, ...Array(41).fill(0)]);
  const expectedIdentity = deriveWatchModelProtocolIdentity(LIVETRANSLATE_MODEL);
  const forgedIdentity = { ...expectedIdentity, exactModelId: NON_LIVETRANSLATE_MODEL };
  assert.throws(
    () => replayProviderInputPrefilter({ filePath, maxSamples: 100_000, modelProtocolProfileIdentity: forgedIdentity }),
    /authorization failed|model protocol profile identity/,
  );
});


