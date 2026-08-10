import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  isMain,
  parseCliArgs,
  readJson,
} from '../lib/testing-common.mjs';

export const VIRTUAL_MIC_FINGERPRINT_SAMPLE_RATE_HZ = 48_000;
export const VIRTUAL_MIC_FINGERPRINT_CHANNEL_COUNT = 1;
export const VIRTUAL_MIC_FINGERPRINT_BITS_PER_SAMPLE = 16;
export const VIRTUAL_MIC_FINGERPRINT_FRAME_COUNT = 24_000;
export const VIRTUAL_MIC_FINGERPRINT_FREQUENCY_HZ = 997;
export const VIRTUAL_MIC_FINGERPRINT_MAX_SAMPLE_DELTA = 1;

const BLOCK_ALIGN_BYTES = 2;
const FINGERPRINT_ANCHOR_COUNT = 64;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const EXPECTED_PCM_HEX_PATTERN = /^[a-f0-9]+$/;

const sha256Bytes = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

export function readCanonicalVirtualMicWav(wavPath) {
  const bytes = fs.readFileSync(wavPath);
  const label = path.basename(wavPath);
  if (
    bytes.length < 44
    || bytes.toString('ascii', 0, 4) !== 'RIFF'
    || bytes.toString('ascii', 8, 12) !== 'WAVE'
  ) throw new Error(`${label} is not RIFF/WAVE`);
  if (bytes.readUInt32LE(4) + 8 !== bytes.length) {
    throw new Error(`${label} RIFF size does not match the file length`);
  }

  let format = null;
  let pcmBytes = null;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > bytes.length) throw new Error(`${label} contains a truncated ${id} chunk`);
    if (id === 'fmt ') {
      if (format || size !== 16) throw new Error(`${label} must contain exactly one canonical fmt chunk`);
      format = {
        audioFormat: bytes.readUInt16LE(start),
        channelCount: bytes.readUInt16LE(start + 2),
        sampleRateHz: bytes.readUInt32LE(start + 4),
        byteRate: bytes.readUInt32LE(start + 8),
        blockAlign: bytes.readUInt16LE(start + 12),
        bitsPerSample: bytes.readUInt16LE(start + 14),
      };
    } else if (id === 'data') {
      if (pcmBytes) throw new Error(`${label} must contain exactly one data chunk`);
      pcmBytes = bytes.subarray(start, end);
    }
    offset = end + (size % 2);
  }
  if (
    !format
    || !pcmBytes
    || pcmBytes.length === 0
    || format.audioFormat !== 1
    || format.sampleRateHz !== VIRTUAL_MIC_FINGERPRINT_SAMPLE_RATE_HZ
    || format.channelCount !== VIRTUAL_MIC_FINGERPRINT_CHANNEL_COUNT
    || format.bitsPerSample !== VIRTUAL_MIC_FINGERPRINT_BITS_PER_SAMPLE
    || format.blockAlign !== BLOCK_ALIGN_BYTES
    || format.byteRate !== VIRTUAL_MIC_FINGERPRINT_SAMPLE_RATE_HZ * BLOCK_ALIGN_BYTES
    || pcmBytes.length % BLOCK_ALIGN_BYTES !== 0
  ) throw new Error(`${label} must be canonical 48 kHz mono PCM16`);

  return {
    bytes,
    pcmBytes,
    frames: pcmBytes.length / BLOCK_ALIGN_BYTES,
    sha256: sha256Bytes(bytes),
  };
}

const withinOneLsb = (actual, expected) => (
  Math.abs(Number(actual) - Number(expected)) <= VIRTUAL_MIC_FINGERPRINT_MAX_SAMPLE_DELTA
);

const expectedPcmFromFingerprint = (fingerprint, issues) => {
  const expectedHex = fingerprint?.expectedPcmHex;
  if (
    typeof expectedHex !== 'string'
    || expectedHex.length !== VIRTUAL_MIC_FINGERPRINT_FRAME_COUNT * BLOCK_ALIGN_BYTES * 2
    || !EXPECTED_PCM_HEX_PATTERN.test(expectedHex)
  ) {
    issues.push('virtual microphone fingerprint expectedPcmHex must contain the exact 24k pre-injection PCM16 bytes');
    return null;
  }
  const expected = Buffer.from(expectedHex, 'hex');
  if (
    !SHA256_PATTERN.test(String(fingerprint?.expectedPcmSha256 ?? ''))
    || sha256Bytes(expected) !== fingerprint.expectedPcmSha256
  ) {
    issues.push('virtual microphone fingerprint expectedPcmSha256 does not bind the pre-injection PCM');
    return null;
  }
  return expected;
};

const windowMatches = (capturedPcm, expectedPcm, startFrame, anchors = null) => {
  const indexes = anchors ?? Array.from(
    { length: expectedPcm.length / BLOCK_ALIGN_BYTES },
    (_, index) => index,
  );
  return indexes.every((index) => withinOneLsb(
    capturedPcm.readInt16LE((startFrame + index) * BLOCK_ALIGN_BYTES),
    expectedPcm.readInt16LE(index * BLOCK_ALIGN_BYTES),
  ));
};

const findUniqueFingerprint = (capturedPcm, expectedPcm) => {
  const capturedFrames = capturedPcm.length / BLOCK_ALIGN_BYTES;
  const expectedFrames = expectedPcm.length / BLOCK_ALIGN_BYTES;
  if (capturedFrames < expectedFrames) return { matches: [] };
  const anchorStride = Math.max(1, Math.floor(expectedFrames / FINGERPRINT_ANCHOR_COUNT));
  const anchors = [];
  for (let index = 0; index < expectedFrames; index += anchorStride) anchors.push(index);
  if (anchors.at(-1) !== expectedFrames - 1) anchors.push(expectedFrames - 1);
  const matches = [];
  for (let start = 0; start <= capturedFrames - expectedFrames; start += 1) {
    if (!windowMatches(capturedPcm, expectedPcm, start, anchors)) continue;
    if (!windowMatches(capturedPcm, expectedPcm, start)) continue;
    matches.push(start);
    if (matches.length > 1) break;
  }
  return { matches };
};

const pcmToneComponent = (pcmBytes, startFrame, frameCount, frequencyHz) => {
  let sine = 0;
  let cosine = 0;
  for (let index = 0; index < frameCount; index += 1) {
    const sample = pcmBytes.readInt16LE((startFrame + index) * BLOCK_ALIGN_BYTES) / 32_768;
    const phase = (2 * Math.PI * frequencyHz * index) / VIRTUAL_MIC_FINGERPRINT_SAMPLE_RATE_HZ;
    sine += sample * Math.sin(phase);
    cosine += sample * Math.cos(phase);
  }
  return (2 * Math.hypot(sine, cosine)) / frameCount;
};

export function validateVirtualMicFingerprintAuthority({ wavPath, fingerprint }) {
  const issues = [];
  let wav;
  try {
    wav = readCanonicalVirtualMicWav(wavPath);
  } catch (error) {
    return { issues: [error.message], authority: null };
  }
  const startFrame = Number(fingerprint?.startFrame);
  const frameCount = Number(fingerprint?.frameCount);
  const frequencyHz = Number(fingerprint?.frequencyHz);
  if (
    fingerprint?.detected !== true
    || typeof fingerprint?.id !== 'string'
    || fingerprint.id.trim().length < 8
    || !Number.isInteger(startFrame)
    || startFrame < 0
    || !Number.isInteger(frameCount)
    || frameCount !== VIRTUAL_MIC_FINGERPRINT_FRAME_COUNT
    || startFrame + frameCount > wav.frames
    || frequencyHz !== VIRTUAL_MIC_FINGERPRINT_FREQUENCY_HZ
  ) issues.push('virtual microphone fingerprint metadata is incomplete or noncanonical');

  const expectedPcm = expectedPcmFromFingerprint(fingerprint, issues);
  if (!expectedPcm || issues.length > 0) return { issues: [...new Set(issues)], authority: null, wav };

  const { matches } = findUniqueFingerprint(wav.pcmBytes, expectedPcm);
  if (matches.length === 0) {
    issues.push('captured endpoint PCM does not contain the full Bridge fingerprint within one-LSB tolerance');
  } else if (matches.length > 1) {
    issues.push('captured endpoint PCM contains the fingerprint more than once');
  } else if (matches[0] !== startFrame) {
    issues.push('declared virtual microphone fingerprint startFrame does not match the recomputed unique window');
  }

  let targetComponent = null;
  let sideComponent = null;
  let maxSampleDelta = null;
  if (matches.length === 1) {
    targetComponent = pcmToneComponent(wav.pcmBytes, matches[0], frameCount, frequencyHz);
    sideComponent = Math.max(
      pcmToneComponent(wav.pcmBytes, matches[0], frameCount, frequencyHz - 211),
      pcmToneComponent(wav.pcmBytes, matches[0], frameCount, frequencyHz + 211),
    );
    if (targetComponent < 0.02 || targetComponent < Math.max(0.001, sideComponent) * 4) {
      issues.push('captured fingerprint spectrum is not isolated at the production 997 Hz component');
    }
    maxSampleDelta = 0;
    for (let index = 0; index < frameCount; index += 1) {
      maxSampleDelta = Math.max(maxSampleDelta, Math.abs(
        wav.pcmBytes.readInt16LE((matches[0] + index) * BLOCK_ALIGN_BYTES)
          - expectedPcm.readInt16LE(index * BLOCK_ALIGN_BYTES),
      ));
    }
  }

  return {
    issues: [...new Set(issues)],
    wav,
    authority: issues.length === 0 ? {
      passed: true,
      algorithm: 'omni-vmic-fingerprint-pcm16-v1',
      captureWavSha256: wav.sha256,
      capturedFrames: wav.frames,
      expectedPcmSha256: fingerprint.expectedPcmSha256,
      startFrame: matches[0],
      frameCount,
      frequencyHz,
      maxSampleDelta,
      targetComponent,
      sideComponent,
      uniqueMatchCount: matches.length,
    } : null,
  };
}

export function validateVirtualMicCaptureArtifacts({ captureWavPath, captureProbe, runtimeSnapshot }) {
  const issues = [];
  if (JSON.stringify(captureProbe?.fingerprint) !== JSON.stringify(runtimeSnapshot?.fingerprint)) {
    issues.push('capture probe/runtime snapshot fingerprint authority must match exactly');
  }
  const result = validateVirtualMicFingerprintAuthority({
    wavPath: captureWavPath,
    fingerprint: captureProbe?.fingerprint,
  });
  issues.push(...result.issues);
  if (result.wav) {
    for (const [record, subject] of [
      [captureProbe, 'capture probe'],
      [runtimeSnapshot, 'runtime snapshot'],
    ]) {
      if (
        record?.captureWav !== 'virtual-mic-capture.wav'
        || record?.captureWavSha256 !== result.wav.sha256
        || Number(record?.capturedFrames) !== result.wav.frames
      ) issues.push(`${subject} WAV hash/frame authority does not match the captured WAV`);
    }
  }
  return {
    issues: [...new Set(issues)],
    authority: issues.length === 0 ? result.authority : null,
  };
}

const runCli = () => {
  const args = parseCliArgs(process.argv.slice(2), {
    defaults: { captureWav: '', captureProbe: '', runtimeSnapshot: '' },
  });
  const unexpected = Object.keys(args).filter((key) => ![
    'captureWav', 'captureProbe', 'runtimeSnapshot',
  ].includes(key));
  if (unexpected.length > 0) throw new Error(`unsupported fingerprint verifier option(s): ${unexpected.join(', ')}`);
  for (const key of ['captureWav', 'captureProbe', 'runtimeSnapshot']) {
    if (!args[key]) throw new Error(`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`);
  }
  const result = validateVirtualMicCaptureArtifacts({
    captureWavPath: path.resolve(args.captureWav),
    captureProbe: readJson(path.resolve(args.captureProbe)),
    runtimeSnapshot: readJson(path.resolve(args.runtimeSnapshot)),
  });
  if (result.issues.length > 0) throw new Error(result.issues.join('; '));
  process.stdout.write(`${JSON.stringify(result.authority)}\n`);
};

if (isMain(import.meta.url)) {
  try {
    runCli();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
