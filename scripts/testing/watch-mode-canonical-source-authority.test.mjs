import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildCanonicalReferencePcm,
  buildCanonicalSpeechNegativeControls,
  buildPhysicalSourceWaveformAuthority,
  loadCanonicalFixtureAuthority,
  parseRiffWavePcm16,
  pcm16WaveToInjectorReference,
  validateCanonicalReferencePcm,
  validateCanonicalSourceAuthority,
} from './watch-mode-canonical-source-authority.mjs';

const workspaceRoot = path.resolve('.');

function temporaryDirectory(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
}

function pcmBuffer(samples) {
  const bytes = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) bytes.writeInt16LE(samples[index], index * 2);
  return bytes;
}

function writePcm(filePath, samples) {
  fs.writeFileSync(filePath, pcmBuffer(samples));
  return filePath;
}

function makeWave({ sampleRateHz = 24_000, channels = 1, samples, audioFormat = 1, bitsPerSample = 16 }) {
  const data = pcmBuffer(samples);
  const blockAlign = channels * (bitsPerSample / 8);
  const bytes = Buffer.alloc(44 + data.length);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(audioFormat, 20);
  bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(sampleRateHz, 24);
  bytes.writeUInt32LE(sampleRateHz * blockAlign, 28);
  bytes.writeUInt16LE(blockAlign, 32);
  bytes.writeUInt16LE(bitsPerSample, 34);
  bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(data.length, 40);
  data.copy(bytes, 44);
  return bytes;
}

function authorityFixture(runDirectory) {
  const fixture = loadCanonicalFixtureAuthority({ workspaceRoot });
  const referencePath = path.join(runDirectory, 'source-media-reference-16k-mono.pcm');
  fs.writeFileSync(referencePath, fixture.referencePcm.buffer);
  return {
    fixture,
    referencePath,
    authority: {
      schemaVersion: 2,
      authorityMode: 'canonical-fixture-local-v2',
      passed: true,
      remoteProviderCalls: 0,
      externalAudioSeconds: 0,
      mediaPath: 'scripts/testing/fixtures/watch-mode-en-original.wav',
      mediaSha256: fixture.media.sha256,
      mediaBytes: fixture.media.bytes,
      checksumPath: 'scripts/testing/fixtures/watch-mode-en-original.sha256',
      metadataPath: 'scripts/testing/fixtures/watch-mode-audio-fixtures.json',
      playbackSeconds: null,
      fullMedia: true,
      source: fixture.sourceText.text,
      translation: fixture.translationText.text,
      sourceText: {
        path: 'scripts/testing/fixtures/watch-mode-en-original.txt',
        bytes: fixture.sourceText.bytes,
        sha256: fixture.sourceText.sha256,
      },
      translationText: {
        path: 'scripts/testing/fixtures/watch-mode-en-original.zh-CN.txt',
        bytes: fixture.translationText.bytes,
        sha256: fixture.translationText.sha256,
      },
      referencePcm: {
        path: 'source-media-reference-16k-mono.pcm',
        bytes: fixture.referencePcm.bytes,
        samples: fixture.referencePcm.samples,
        sampleRateHz: 16_000,
        channels: 1,
        durationSeconds: Number(fixture.referencePcm.durationSeconds.toFixed(6)),
        sha256: fixture.referencePcm.sha256,
      },
      fixture: fixture.fixture,
    },
  };
}

function deterministicSpeechLike(seconds = 7, sampleRateHz = 16_000) {
  const samples = new Int16Array(seconds * sampleRateHz);
  let state = 0x1234abcd;
  for (let index = 0; index < samples.length; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const time = index / sampleRateHz;
    const envelope = 0.22 + 0.58 * Math.abs(Math.sin(2 * Math.PI * 1.37 * time));
    const voice = Math.sin(2 * Math.PI * (187 + 19 * Math.sin(time * 0.83)) * time)
      + 0.45 * Math.sin(2 * Math.PI * 431 * time)
      + 0.18 * (((state / 0xffff_ffff) * 2) - 1);
    samples[index] = Math.trunc(Math.max(-1, Math.min(1, voice * envelope * 0.45)) * 30_000);
  }
  return samples;
}

function transformed(reference, { lag = 1_600, polarity = -1, gain = 0.62, noise = 70 } = {}) {
  const output = new Int16Array(reference.length + lag + 2_000);
  let state = 0x99887766;
  for (let index = 0; index < reference.length; index += 1) {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    const jitter = (((state >>> 16) & 0x7fff) / 0x7fff * 2 - 1) * noise;
    output[index + lag] = Math.trunc(reference[index] * polarity * gain + jitter);
  }
  return output;
}

function sparseThreeOfNine(reference, { lag = 1_600, gain = 0.72 } = {}) {
  const output = new Int16Array(reference.length + lag + 2_000);
  const candidateCount = 9;
  const segmentSamples = Math.min(16_000, Math.floor(reference.length / (candidateCount + 2)));
  const available = reference.length - segmentSamples;
  const starts = Array.from({ length: candidateCount }, (_, index) => (
    Math.floor(available * (0.04 + (0.92 * index) / (candidateCount - 1)))
  ));
  for (const candidateIndex of [0, 4, 8]) {
    const start = starts[candidateIndex];
    for (let offset = 0; offset < segmentSamples; offset += 1) {
      output[start + lag + offset] = Math.trunc(reference[start + offset] * gain);
    }
  }
  return output;
}

function clockSkewedDenseMix(reference, { initialLag = 1_600, driftSamples = 2_400 } = {}) {
  const output = new Int16Array(reference.length + initialLag + driftSamples + 2_000);
  const interference = unrelatedTone(reference, 997);
  for (let index = 0; index < reference.length; index += 1) {
    const lag = initialLag + Math.round(driftSamples * index / Math.max(1, reference.length - 1));
    const target = index + lag;
    const mixed = output[target] + reference[index] * 0.42 + interference[index] * 0.58;
    output[target] = Math.trunc(Math.max(-32_768, Math.min(32_767, mixed)));
  }
  return output;
}

function unrelatedTone(reference, frequencyHz) {
  const output = new Int16Array(reference.length);
  for (let index = 0; index < output.length; index += 1) {
    const envelope = Math.abs(reference[index]) / 32_768;
    output[index] = Math.trunc(Math.sin(2 * Math.PI * frequencyHz * index / 16_000) * envelope * 28_000);
  }
  return output;
}

function expectedReverseSamplesWithinBlocks(reference, blockSamples) {
  const samples = new Int16Array(reference.length);
  for (let start = 0; start < reference.length; start += blockSamples) {
    samples.set(reference.slice(start, Math.min(reference.length, start + blockSamples)).reverse(), start);
  }
  return samples;
}

function physicalFixture({ recorded, reference = deterministicSpeechLike(), wrong = [] }) {
  const directory = temporaryDirectory('canonical-physical');
  const referencePath = writePcm(path.join(directory, 'reference.pcm'), reference);
  const recordedSamples = recorded ?? transformed(reference);
  const sourceWindowPath = writePcm(
    path.join(directory, 'physical-output-recording-source-window-16k-mono.pcm'),
    recordedSamples,
  );
  const physicalRecordingPcmPath = writePcm(
    path.join(directory, 'physical-output-recording-16k-mono.pcm'),
    recordedSamples,
  );
  const wrongReferencePcmPaths = wrong.map((samples, index) => writePcm(path.join(directory, `wrong-${index}.pcm`), samples));
  return {
    directory,
    reference,
    referencePath,
    sourceWindowPath,
    physicalRecordingPcmPath,
    wrongReferencePcmPaths,
  };
}

test('reconstructs the complete fixed canonical PCM with injector-identical nearest-neighbor f32 math', () => {
  const fixture = loadCanonicalFixtureAuthority({ workspaceRoot });
  const rebuilt = buildCanonicalReferencePcm({ workspaceRoot });
  assert.ok(rebuilt.equals(fixture.referencePcm.buffer));
  assert.deepEqual({
    bytes: rebuilt.length,
    samples: rebuilt.length / 2,
    sha256: fixture.referencePcm.sha256,
  }, {
    bytes: 4_026_090,
    samples: 2_013_045,
    sha256: '5d3d7f2124d72d7ea4f257f8c8a3edd549561058ff989e631cf5d82099f341b6',
  });

  const stereo = makeWave({
    sampleRateHz: 32_000,
    channels: 2,
    samples: new Int16Array([32_767, -32_768, 16_384, 8_192, -10_000, -20_000, 5_000, 15_000]),
  });
  const mono = pcm16WaveToInjectorReference(stereo);
  assert.deepEqual([...new Int16Array(mono.buffer, mono.byteOffset, mono.length / 2)], [0, -14_999]);
});

test('RIFF parser rejects non-PCM formats, duplicate data, chunk overflow, and trailing ambiguity', () => {
  const good = makeWave({ samples: new Int16Array([1, 2, 3, 4]) });
  assert.equal(parseRiffWavePcm16(good).frames, 4);

  const floatFormat = Buffer.from(good);
  floatFormat.writeUInt16LE(3, 20);
  assert.throws(() => parseRiffWavePcm16(floatFormat), /integer PCM format 1/);

  const duplicate = Buffer.concat([good, Buffer.from('data'), Buffer.alloc(4)]);
  duplicate.writeUInt32LE(duplicate.length - 8, 4);
  assert.throws(() => parseRiffWavePcm16(duplicate), /multiple data chunks/);

  const overflow = Buffer.from(good);
  overflow.writeUInt32LE(0xffff_ffff, 40);
  assert.throws(() => parseRiffWavePcm16(overflow), /overflows or exceeds/);

  const trailing = Buffer.concat([good, Buffer.from([0])]);
  assert.throws(() => parseRiffWavePcm16(trailing), /trailing-byte ambiguity/);
});

test('validates exact WAV/checksum/metadata/text and run reference PCM authority without trusting passed alone', () => {
  const runDirectory = temporaryDirectory('canonical-source');
  const { authority } = authorityFixture(runDirectory);
  fs.writeFileSync(path.join(runDirectory, 'source-media-transcript.json'), `${JSON.stringify(authority)}\n`, 'utf8');
  const validation = validateCanonicalSourceAuthority({ runDirectory, workspaceRoot });
  assert.equal(validation.passed, true);
  assert.equal(validation.referencePcm.byteForByteInjectorReconstruction, true);
  assert.equal(validation.sourceText.bytes, Buffer.byteLength(authority.source, 'utf8'));
  assert.equal(validation.source, authority.source);
  assert.equal(validation.translation, authority.translation);
  assert.equal(validation.checksum.declaredMediaSha256, validation.media.sha256);
  assert.match(validation.metadata.sha256, /^[a-f0-9]{64}$/);
});

test('reference-only validation rejects a same-length forged injector PCM before a passed authority exists', () => {
  const runDirectory = temporaryDirectory('canonical-reference-only');
  const referencePath = path.join(runDirectory, 'source-media-reference-16k-mono.pcm');
  fs.writeFileSync(referencePath, buildCanonicalReferencePcm({ workspaceRoot }));
  assert.equal(validateCanonicalReferencePcm({ runDirectory, workspaceRoot }).passed, true);
  const forged = fs.readFileSync(referencePath);
  forged.writeInt16LE(forged.readInt16LE(0) ^ 1, 0);
  fs.writeFileSync(referencePath, forged);
  assert.throws(
    () => validateCanonicalReferencePcm({ runDirectory, workspaceRoot }),
    /not byte-for-byte the injector reconstruction/,
  );
});

test('rejects Buffer.alloc pseudo-PCM even when a claimed passed authority points at it', () => {
  const runDirectory = temporaryDirectory('canonical-pseudo-pcm');
  const { authority, referencePath } = authorityFixture(runDirectory);
  fs.writeFileSync(referencePath, Buffer.alloc(authority.referencePcm.bytes));
  assert.throws(
    () => validateCanonicalSourceAuthority({ runDirectory, workspaceRoot, sourceAuthority: authority }),
    /not byte-for-byte the injector reconstruction/,
  );
});

test('does not treat a bare passed boolean or coercible null counters as source authority', () => {
  const runDirectory = temporaryDirectory('canonical-bare-passed');
  const { authority } = authorityFixture(runDirectory);
  assert.throws(
    () => validateCanonicalSourceAuthority({ runDirectory, workspaceRoot, sourceAuthority: { passed: true } }),
    /header is not an exact/,
  );
  assert.throws(
    () => validateCanonicalSourceAuthority({
      runDirectory,
      workspaceRoot,
      sourceAuthority: { ...authority, remoteProviderCalls: null, externalAudioSeconds: null },
    }),
    /header is not an exact/,
  );
});

test('rejects corrected or normalized top-level fixture text and nested authority drift', () => {
  const runDirectory = temporaryDirectory('canonical-corrected-text');
  const { authority } = authorityFixture(runDirectory);
  assert.throws(
    () => validateCanonicalSourceAuthority({
      runDirectory,
      workspaceRoot,
      sourceAuthority: { ...authority, source: authority.source.replace('one billion dollar', 'one-billion-dollar') },
    }),
    /source\/translation text mismatch/,
  );
  assert.throws(
    () => validateCanonicalSourceAuthority({
      runDirectory,
      workspaceRoot,
      sourceAuthority: { ...authority, sourceText: { ...authority.sourceText, bytes: authority.sourceText.bytes + 1 } },
    }),
    /sourceText.bytes mismatch/,
  );
});

test('accepts three independent segments using one global lag and polarity with wrong-reference margin', () => {
  const reference = deterministicSpeechLike();
  const wrong = [unrelatedTone(reference, 733), unrelatedTone(reference, 1_211)];
  const fixture = physicalFixture({ reference, recorded: transformed(reference), wrong });
  const authority = buildPhysicalSourceWaveformAuthority({
    runDirectory: fixture.directory,
    referencePcmPath: fixture.referencePath,
    sourceWindowPath: fixture.sourceWindowPath,
    wrongReferencePcmPaths: fixture.wrongReferencePcmPaths,
  });
  assert.equal(authority.passed, true, authority.violations.join('; '));
  assert.equal(authority.globalLagSamples, 1_600);
  assert.equal(authority.globalPolarity, -1);
  assert.equal(authority.independentNonOverlappingSegmentCount, 3);
  assert.ok(authority.wrongReferenceMargin >= authority.thresholds.wrongReferenceMargin);
  assert.ok(authority.segments.every((entry) => entry.waveformCorrelation > 0.99 && entry.derivativeCorrelation > 0.99));
});

test('uses deterministic speech-derived negative controls without optional WAV fixtures', () => {
  const reference = deterministicSpeechLike();
  const controls = buildCanonicalSpeechNegativeControls(reference);
  assert.deepEqual(
    controls.map((entry) => entry.label),
    [
      'canonical-speech-full-time-reversal',
      'canonical-speech-250ms-block-time-reversal',
    ],
  );
  assert.deepEqual(controls[0].samples, reference.slice().reverse());
  assert.deepEqual(controls[1].samples, expectedReverseSamplesWithinBlocks(reference, 4_000));

  const fixture = physicalFixture({ reference, recorded: transformed(reference), wrong: [] });
  const authority = buildPhysicalSourceWaveformAuthority({
    runDirectory: fixture.directory,
    referencePcmPath: fixture.referencePath,
    sourceWindowPath: fixture.sourceWindowPath,
  });
  assert.equal(authority.passed, true, authority.violations.join('; '));
  assert.deepEqual(
    authority.wrongReferences.map((entry) => entry.label),
    controls.map((entry) => entry.label),
  );
  assert.ok(authority.maximumWrongReferenceScore > 0.5, JSON.stringify(authority.wrongReferences));
});

test('default speech-derived negative controls reject a reordered canonical source', () => {
  const reference = deterministicSpeechLike();
  const [wrongSource] = buildCanonicalSpeechNegativeControls(reference);
  const fixture = physicalFixture({ reference, recorded: transformed(wrongSource.samples), wrong: [] });
  const authority = buildPhysicalSourceWaveformAuthority({
    runDirectory: fixture.directory,
    referencePcmPath: fixture.referencePath,
    sourceWindowPath: fixture.sourceWindowPath,
  });
  assert.equal(authority.passed, false);
  assert.ok(authority.wrongReferences[0].score > 0.95, JSON.stringify(authority.wrongReferences));
  assert.ok(authority.wrongReferenceMargin < authority.thresholds.wrongReferenceMargin);
  assert.match(authority.violations.join('\n'), /wrong-reference margin/);
});

test('accepts distributed source fragments under bounded endpoint-clock drift and dense overlap', () => {
  const reference = deterministicSpeechLike(14);
  const fixture = physicalFixture({
    reference,
    recorded: clockSkewedDenseMix(reference),
    wrong: [unrelatedTone(reference, 733), unrelatedTone(reference, 1_211)],
  });
  const authority = buildPhysicalSourceWaveformAuthority({
    runDirectory: fixture.directory,
    referencePcmPath: fixture.referencePath,
    sourceWindowPath: fixture.sourceWindowPath,
    wrongReferencePcmPaths: fixture.wrongReferencePcmPaths,
  });
  assert.equal(authority.passed, true, authority.violations.join('; '));
  assert.ok(authority.passingCandidateCount >= authority.thresholds.minimumPassingCandidateCount);
  assert.ok(authority.candidates.some((entry) => entry.localLagDeltaSamples !== 0));
  assert.ok(authority.candidates.every((entry) => Math.abs(entry.localLagDeltaSamples) <= 3_200));
});

test('rejects same-envelope different-frequency audio using signed waveform and derivative checks', () => {
  const reference = deterministicSpeechLike();
  const wrongTone = unrelatedTone(reference, 997);
  const controls = [unrelatedTone(reference, 733)];
  const fixture = physicalFixture({ reference, recorded: transformed(wrongTone, { polarity: 1, gain: 1, noise: 0 }), wrong: controls });
  const authority = buildPhysicalSourceWaveformAuthority({
    runDirectory: fixture.directory,
    referencePcmPath: fixture.referencePath,
    sourceWindowPath: fixture.sourceWindowPath,
    wrongReferencePcmPaths: fixture.wrongReferencePcmPaths,
  });
  assert.equal(authority.passed, false);
  assert.match(authority.violations.join('\n'), /waveform|derivative|wrong-reference/);
});

test('rejects pure translated-like tone and deterministic noise in place of canonical source', () => {
  const reference = deterministicSpeechLike();
  const controls = [unrelatedTone(reference, 733)];
  const translation = unrelatedTone(reference, 1_401);
  const toneFixture = physicalFixture({ reference, recorded: transformed(translation, { polarity: 1, gain: 1, noise: 0 }), wrong: controls });
  const toneAuthority = buildPhysicalSourceWaveformAuthority({
    runDirectory: toneFixture.directory,
    referencePcmPath: toneFixture.referencePath,
    sourceWindowPath: toneFixture.sourceWindowPath,
    wrongReferencePcmPaths: toneFixture.wrongReferencePcmPaths,
  });
  assert.equal(toneAuthority.passed, false);

  const noise = new Int16Array(reference.length + 2_000);
  let state = 7;
  for (let index = 0; index < noise.length; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    noise[index] = ((state >>> 16) & 0xffff) - 32_768;
  }
  const noiseFixture = physicalFixture({ reference, recorded: noise, wrong: controls });
  const noiseAuthority = buildPhysicalSourceWaveformAuthority({
    runDirectory: noiseFixture.directory,
    referencePcmPath: noiseFixture.referencePath,
    sourceWindowPath: noiseFixture.sourceWindowPath,
    wrongReferencePcmPaths: noiseFixture.wrongReferencePcmPaths,
  });
  assert.equal(noiseAuthority.passed, false);
});

test('rejects sparse recordings that copy only three favorable anchors and leave six source windows silent', () => {
  const reference = deterministicSpeechLike();
  const fixture = physicalFixture({
    reference,
    recorded: sparseThreeOfNine(reference),
    wrong: [unrelatedTone(reference, 733), unrelatedTone(reference, 1_211)],
  });
  const authority = buildPhysicalSourceWaveformAuthority({
    runDirectory: fixture.directory,
    referencePcmPath: fixture.referencePath,
    sourceWindowPath: fixture.sourceWindowPath,
    wrongReferencePcmPaths: fixture.wrongReferencePcmPaths,
  });
  assert.equal(authority.passed, false);
  assert.ok(authority.passingCandidateCount < authority.thresholds.minimumPassingCandidateCount, JSON.stringify(authority.candidates));
  assert.match(authority.violations.join('\n'), /source windows passed waveform, derivative, and energy coverage/);
});

test('forbids path or byte-for-byte physical window reuse', () => {
  const reference = deterministicSpeechLike();
  const directory = temporaryDirectory('canonical-window-reuse');
  const referencePath = writePcm(path.join(directory, 'reference.pcm'), reference);
  writePcm(path.join(directory, 'physical-output-recording-16k-mono.pcm'), reference);
  const wrongPath = writePcm(path.join(directory, 'wrong.pcm'), unrelatedTone(reference, 733));
  assert.throws(() => buildPhysicalSourceWaveformAuthority({
    runDirectory: directory,
    referencePcmPath: referencePath,
    sourceWindowPath: referencePath,
    wrongReferencePcmPaths: [wrongPath],
  }), /cannot reuse the reference PCM path/);

  const copiedPath = path.join(directory, 'copied-window.pcm');
  fs.copyFileSync(referencePath, copiedPath);
  assert.throws(() => buildPhysicalSourceWaveformAuthority({
    runDirectory: directory,
    referencePcmPath: referencePath,
    sourceWindowPath: copiedPath,
    wrongReferencePcmPaths: [wrongPath],
  }), /cannot reuse the canonical reference bytes/);
});

test('rejects a forged source window that is not the exact physical recording prefix', () => {
  const reference = deterministicSpeechLike();
  const recorded = transformed(reference);
  const fixture = physicalFixture({
    reference,
    recorded,
    wrong: [unrelatedTone(reference, 733), unrelatedTone(reference, 1_211)],
  });
  const forged = new Int16Array(recorded);
  forged[Math.floor(forged.length / 3)] ^= 0x1234;
  writePcm(fixture.sourceWindowPath, forged);
  assert.throws(() => buildPhysicalSourceWaveformAuthority({
    runDirectory: fixture.directory,
    referencePcmPath: fixture.referencePath,
    sourceWindowPath: fixture.sourceWindowPath,
    wrongReferencePcmPaths: fixture.wrongReferencePcmPaths,
  }), /not the exact prefix of the physical recording PCM/);
});
