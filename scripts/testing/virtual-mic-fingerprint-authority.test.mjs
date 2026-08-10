import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  validateVirtualMicCaptureArtifacts,
  validateVirtualMicFingerprintAuthority,
  VIRTUAL_MIC_FINGERPRINT_FRAME_COUNT,
} from './virtual-mic-fingerprint-authority.mjs';

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const temporaryRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'omni-vmic-fingerprint-'));

const expectedFingerprintPcm = () => {
  const pcm = Buffer.alloc(VIRTUAL_MIC_FINGERPRINT_FRAME_COUNT * 2);
  let seed = 0x4d595df4;
  for (let frame = 0; frame < VIRTUAL_MIC_FINGERPRINT_FRAME_COUNT; frame += 1) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    const watermark = 0.88 + ((seed >>> 0) & 0xffff) / 0xffff * 0.12;
    const sample = Math.round(
      Math.sin((2 * Math.PI * 997 * frame) / 48_000) * 0.24 * watermark * 32_767,
    );
    pcm.writeInt16LE(sample, frame * 2);
  }
  return pcm;
};

const buildWav = (pcm) => {
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(48_000, 24);
  wav.writeUInt32LE(96_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);
  return wav;
};

const realVmShapedFixture = () => {
  const root = temporaryRoot();
  const expected = expectedFingerprintPcm();
  const capturedFrames = 153_600;
  const startFrame = 5_184;
  const captured = Buffer.alloc(capturedFrames * 2);
  for (let frame = 0; frame < VIRTUAL_MIC_FINGERPRINT_FRAME_COUNT; frame += 1) {
    const expectedSample = expected.readInt16LE(frame * 2);
    const delta = frame % 4 === 0 ? 1 : frame % 4 === 1 ? -1 : 0;
    captured.writeInt16LE(expectedSample + delta, (startFrame + frame) * 2);
  }
  const wavPath = path.join(root, 'virtual-mic-capture.wav');
  const wav = buildWav(captured);
  fs.writeFileSync(wavPath, wav);
  const fingerprint = {
    id: 'virtual-mic-fingerprint-real-vm-shape',
    detected: true,
    frequencyHz: 997,
    startFrame,
    frameCount: VIRTUAL_MIC_FINGERPRINT_FRAME_COUNT,
    expectedPcmHex: expected.toString('hex'),
    expectedPcmSha256: sha256(expected),
  };
  const common = {
    captureWav: 'virtual-mic-capture.wav',
    captureWavSha256: sha256(wav),
    capturedFrames,
    fingerprint,
  };
  return {
    root,
    wavPath,
    expected,
    captured,
    startFrame,
    captureProbe: { ...common },
    runtimeSnapshot: structuredClone(common),
  };
};

test('real-VM-shaped 153600-frame WAV passes the shared one-LSB fingerprint authority', () => {
  const fixture = realVmShapedFixture();
  try {
    const result = validateVirtualMicCaptureArtifacts({
      captureWavPath: fixture.wavPath,
      captureProbe: fixture.captureProbe,
      runtimeSnapshot: fixture.runtimeSnapshot,
    });
    assert.deepEqual(result.issues, []);
    assert.equal(result.authority.startFrame, 5_184);
    assert.equal(result.authority.frameCount, 24_000);
    assert.equal(result.authority.maxSampleDelta, 1);
    assert.equal(result.authority.uniqueMatchCount, 1);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('the PowerShell-facing CLI recomputes the same probe/runtime/WAV authority', () => {
  const fixture = realVmShapedFixture();
  try {
    const probePath = path.join(fixture.root, 'virtual-mic-capture-probe.json');
    const snapshotPath = path.join(fixture.root, 'runtime-snapshot.json');
    fs.writeFileSync(probePath, JSON.stringify(fixture.captureProbe), 'utf8');
    fs.writeFileSync(snapshotPath, JSON.stringify(fixture.runtimeSnapshot), 'utf8');
    const result = spawnSync(process.execPath, [
      path.resolve('scripts/testing/virtual-mic-fingerprint-authority.mjs'),
      '--capture-wav', fixture.wavPath,
      '--capture-probe', probePath,
      '--runtime-snapshot', snapshotPath,
    ], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).algorithm, 'omni-vmic-fingerprint-pcm16-v1');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('two-LSB mutation, duplicate, truncation, forged hash, and forged start fail closed', () => {
  const fixture = realVmShapedFixture();
  const validate = (fingerprint = fixture.captureProbe.fingerprint) => (
    validateVirtualMicFingerprintAuthority({ wavPath: fixture.wavPath, fingerprint }).issues.join('\n')
  );
  try {
    const original = fs.readFileSync(fixture.wavPath);
    const twoLsb = Buffer.from(original);
    const sampleOffset = 44 + fixture.startFrame * 2 + 200;
    twoLsb.writeInt16LE(twoLsb.readInt16LE(sampleOffset) + 2, sampleOffset);
    fs.writeFileSync(fixture.wavPath, twoLsb);
    assert.match(validate(), /does not contain.*one-LSB/i);

    const duplicatePcm = Buffer.from(fixture.captured);
    fixture.captured.copy(
      duplicatePcm,
      80_000 * 2,
      fixture.startFrame * 2,
      (fixture.startFrame + 24_000) * 2,
    );
    fs.writeFileSync(fixture.wavPath, buildWav(duplicatePcm));
    assert.match(validate(), /more than once/i);

    fs.writeFileSync(fixture.wavPath, original.subarray(0, original.length - 2));
    assert.match(validate(), /RIFF size|truncated/i);

    fs.writeFileSync(fixture.wavPath, original);
    assert.match(validate({
      ...fixture.captureProbe.fingerprint,
      expectedPcmSha256: '0'.repeat(64),
    }), /does not bind the pre-injection PCM/i);
    assert.match(validate({
      ...fixture.captureProbe.fingerprint,
      startFrame: fixture.startFrame + 1,
    }), /startFrame does not match/i);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
