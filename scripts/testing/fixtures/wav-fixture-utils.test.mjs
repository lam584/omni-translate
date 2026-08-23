import assert from 'node:assert/strict';
import test from 'node:test';

import {
  inspectPcm16MonoWav,
  normalizeStreamingWavHeader,
  resamplePcm16MonoWav,
} from './wav-fixture-utils.mjs';

function sineWav({ sampleRate = 24_000, seconds = 0.1, frequency = 440 } = {}) {
  const frames = Math.floor(sampleRate * seconds);
  const wav = Buffer.alloc(44 + frames * 2);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(frames * 2, 40);
  for (let frame = 0; frame < frames; frame += 1) {
    wav.writeInt16LE(Math.round(Math.sin((2 * Math.PI * frequency * frame) / sampleRate) * 12_000), 44 + frame * 2);
  }
  return wav;
}

test('resamples provider PCM to deterministic 16 kHz mono fixtures', () => {
  const source = sineWav();
  const first = resamplePcm16MonoWav(source);
  const second = resamplePcm16MonoWav(source);
  assert.deepEqual(first, second);
  assert.deepEqual(inspectPcm16MonoWav(first), {
    durationSeconds: 0.1,
    sampleRate: 16_000,
    channels: 1,
    bitsPerSample: 16,
  });
  assert.equal(first.length, 44 + 1_600 * 2);
});

test('repairs streaming RIFF and data lengths before inspection', () => {
  const source = sineWav();
  source.writeUInt32LE(0xffff_ffff, 4);
  source.writeUInt32LE(0xffff_ffff, 40);
  normalizeStreamingWavHeader(source);
  assert.equal(source.readUInt32LE(4), source.length - 8);
  assert.equal(source.readUInt32LE(40), source.length - 44);
  assert.equal(inspectPcm16MonoWav(source).sampleRate, 24_000);
});

test('rejects compressed, multichannel, and malformed fixture inputs', () => {
  const stereo = sineWav();
  stereo.writeUInt16LE(2, 22);
  assert.throws(() => resamplePcm16MonoWav(stereo), /16-bit mono integer PCM/);
  assert.throws(() => inspectPcm16MonoWav(Buffer.from('not a wav')), /RIFF\/WAVE/);
});
