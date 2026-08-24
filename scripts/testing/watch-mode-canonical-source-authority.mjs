import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CANONICAL_SOURCE_AUTHORITY_SCHEMA_VERSION = 2;
export const CANONICAL_SOURCE_AUTHORITY_MODE = 'canonical-fixture-local-v2';
export const PHYSICAL_SOURCE_WAVEFORM_AUTHORITY_MODE = 'canonical-source-signed-waveform-v1';
export const CANONICAL_SOURCE_SAMPLE_RATE_HZ = 16_000;

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultWorkspaceRoot = path.resolve(moduleDirectory, '..', '..');
const fixtureDirectoryRelative = 'scripts/testing/fixtures';
const canonicalNames = Object.freeze({
  media: 'watch-mode-en-original.wav',
  checksum: 'watch-mode-en-original.sha256',
  metadata: 'watch-mode-audio-fixtures.json',
  sourceText: 'watch-mode-en-original.txt',
  translationText: 'watch-mode-en-original.zh-CN.txt',
});
const referencePcmName = 'source-media-reference-16k-mono.pcm';
const sourceAuthorityName = 'source-media-transcript.json';
const physicalSourceWindowName = 'physical-output-recording-source-window-16k-mono.pcm';
const physicalRecordingPcmName = 'physical-output-recording-16k-mono.pcm';
const canonicalRelativePaths = Object.freeze(Object.fromEntries(
  Object.entries(canonicalNames).map(([key, name]) => [key, `${fixtureDirectoryRelative}/${name}`]),
));

const waveformThresholds = Object.freeze({
  globalWaveformCorrelation: 0.18,
  globalDerivativeCorrelation: 0.08,
  minimumSegmentWaveformCorrelation: 0.10,
  minimumSegmentDerivativeCorrelation: 0.04,
  medianSegmentWaveformCorrelation: 0.16,
  medianSegmentDerivativeCorrelation: 0.07,
  wrongReferenceMargin: 0.08,
  minimumCandidateWaveformCorrelation: 0.20,
  minimumCandidateDerivativeCorrelation: 0.015,
  minimumCandidateEnergyRatio: 0.02,
  maximumCandidateEnergyRatio: 20,
  minimumPassingCandidateCount: 7,
});

const physicalFragmentSamples = Math.round(CANONICAL_SOURCE_SAMPLE_RATE_HZ * 0.2);
const physicalFragmentOffsetStep = Math.round(CANONICAL_SOURCE_SAMPLE_RATE_HZ * 0.05);
const physicalLocalLagRadiusSamples = Math.round(CANONICAL_SOURCE_SAMPLE_RATE_HZ * 0.2);

const sha256Buffer = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const portable = (value) => String(value).split(path.sep).join('/');

function regularFile(filePath, label, { nonempty = true } = {}) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    throw new Error(`${label} is missing: ${filePath} (${error.message})`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file: ${filePath}`);
  }
  if (nonempty && stat.size === 0) throw new Error(`${label} must not be empty: ${filePath}`);
  return stat;
}

function exactObject(actual, expected, label) {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) {
    throw new Error(`${label} must be an object`);
  }
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(`${label} keys mismatch: expected=${expectedKeys.join(',')} actual=${actualKeys.join(',')}`);
  }
  for (const [key, value] of Object.entries(expected)) {
    if (!Object.is(actual[key], value)) {
      throw new Error(`${label}.${key} mismatch`);
    }
  }
}

function readUInt32(buffer, offset, label) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + 4 > buffer.length) {
    throw new Error(`${label} uint32 offset is outside the file`);
  }
  return buffer.readUInt32LE(offset);
}

function checkedAdd(left, right, limit, label) {
  const sum = left + right;
  if (!Number.isSafeInteger(sum) || sum < left || sum > limit) {
    throw new Error(`${label} size overflows or exceeds the RIFF boundary`);
  }
  return sum;
}

/**
 * Parse the exact input class accepted by the strict source authority. The
 * production injector accepts more WAV formats; the canonical fixture is
 * deliberately narrower so no alternate decoder interpretation is possible.
 */
export function parseRiffWavePcm16(bytes, { label = 'canonical WAV' } = {}) {
  if (!Buffer.isBuffer(bytes)) throw new Error(`${label} bytes must be a Buffer`);
  if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${label} must be a RIFF/WAVE file`);
  }
  const declaredRiffEnd = checkedAdd(8, readUInt32(bytes, 4, label), bytes.length, `${label} RIFF`);
  if (declaredRiffEnd !== bytes.length) {
    throw new Error(`${label} RIFF length mismatch or trailing-byte ambiguity`);
  }

  let cursor = 12;
  let format = null;
  let data = null;
  while (cursor < declaredRiffEnd) {
    if (cursor + 8 > declaredRiffEnd) throw new Error(`${label} has a trailing partial chunk header`);
    const chunkId = bytes.toString('ascii', cursor, cursor + 4);
    const chunkSize = readUInt32(bytes, cursor + 4, `${label} ${chunkId}`);
    const chunkStart = cursor + 8;
    const chunkEnd = checkedAdd(chunkStart, chunkSize, declaredRiffEnd, `${label} ${chunkId}`);
    const paddedEnd = checkedAdd(chunkEnd, chunkSize & 1, declaredRiffEnd, `${label} ${chunkId} padding`);
    if (chunkId === 'fmt ') {
      if (format) throw new Error(`${label} contains multiple fmt chunks`);
      format = bytes.subarray(chunkStart, chunkEnd);
    } else if (chunkId === 'data') {
      if (data) throw new Error(`${label} contains multiple data chunks`);
      data = bytes.subarray(chunkStart, chunkEnd);
    }
    cursor = paddedEnd;
  }
  if (cursor !== declaredRiffEnd) throw new Error(`${label} chunk traversal did not end at the RIFF boundary`);
  if (!format) throw new Error(`${label} has no fmt chunk`);
  if (!data) throw new Error(`${label} has no data chunk`);
  if (format.length !== 16) throw new Error(`${label} fmt chunk must be the unambiguous 16-byte PCM form`);

  const audioFormat = format.readUInt16LE(0);
  const channels = format.readUInt16LE(2);
  const sampleRateHz = format.readUInt32LE(4);
  const byteRate = format.readUInt32LE(8);
  const blockAlign = format.readUInt16LE(12);
  const bitsPerSample = format.readUInt16LE(14);
  if (audioFormat !== 1) throw new Error(`${label} must use integer PCM format 1`);
  if (channels === 0 || sampleRateHz === 0) throw new Error(`${label} has invalid channels or sample rate`);
  if (bitsPerSample !== 16) throw new Error(`${label} must use 16-bit PCM samples`);
  const expectedBlockAlign = channels * 2;
  const expectedByteRate = sampleRateHz * expectedBlockAlign;
  if (!Number.isSafeInteger(expectedByteRate) || blockAlign !== expectedBlockAlign || byteRate !== expectedByteRate) {
    throw new Error(`${label} has inconsistent PCM blockAlign or byteRate`);
  }
  if (data.length === 0 || data.length % blockAlign !== 0) {
    throw new Error(`${label} data must contain whole non-empty PCM frames`);
  }
  return {
    audioFormat,
    channels,
    sampleRateHz,
    byteRate,
    blockAlign,
    bitsPerSample,
    frames: data.length / blockAlign,
    data: Buffer.from(data),
  };
}

/** Reproduce omni-watch-media-injector.rs::resample_to_16k_mono. */
export function pcm16WaveToInjectorReference(bytes) {
  const wave = parseRiffWavePcm16(bytes);
  const targetFrames = Math.floor((wave.frames * CANONICAL_SOURCE_SAMPLE_RATE_HZ) / wave.sampleRateHz);
  if (!Number.isSafeInteger(targetFrames) || targetFrames <= 0) {
    throw new Error('canonical WAV target frame count is invalid or overflows');
  }
  const output = Buffer.allocUnsafe(targetFrames * 2);
  const ratio = wave.sampleRateHz / CANONICAL_SOURCE_SAMPLE_RATE_HZ;
  for (let targetIndex = 0; targetIndex < targetFrames; targetIndex += 1) {
    const sourceIndex = Math.min(Math.floor(targetIndex * ratio), wave.frames - 1);
    const frameOffset = sourceIndex * wave.blockAlign;
    let sum = Math.fround(0);
    for (let channel = 0; channel < wave.channels; channel += 1) {
      const integer = wave.data.readInt16LE(frameOffset + channel * 2);
      const decoded = Math.fround(integer / 32_768);
      const clamped = Math.max(-1, Math.min(1, decoded));
      sum = Math.fround(sum + clamped);
    }
    const mono = Math.max(-1, Math.min(1, Math.fround(sum / wave.channels)));
    const scaled = Math.fround(mono * 32_767);
    output.writeInt16LE(Math.trunc(scaled), targetIndex * 2);
  }
  return output;
}

function fixturePaths(workspaceRoot = defaultWorkspaceRoot) {
  const root = path.resolve(workspaceRoot);
  const directory = path.join(root, ...fixtureDirectoryRelative.split('/'));
  return Object.fromEntries(Object.entries(canonicalNames).map(([key, name]) => [key, path.join(directory, name)]));
}

function readUtf8Exact(filePath, label) {
  const bytes = fs.readFileSync(filePath);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (text.length === 0 || text.trim().length === 0) throw new Error(`${label} is empty`);
  return { bytes, text };
}

export function buildCanonicalReferencePcm({ workspaceRoot = defaultWorkspaceRoot } = {}) {
  const paths = fixturePaths(workspaceRoot);
  regularFile(paths.media, 'canonical WAV');
  return pcm16WaveToInjectorReference(fs.readFileSync(paths.media));
}

export function loadCanonicalFixtureAuthority({ workspaceRoot = defaultWorkspaceRoot } = {}) {
  const paths = fixturePaths(workspaceRoot);
  for (const [key, filePath] of Object.entries(paths)) regularFile(filePath, `canonical ${key}`);
  const mediaBytes = fs.readFileSync(paths.media);
  const media = parseRiffWavePcm16(mediaBytes);
  const mediaSha256 = sha256Buffer(mediaBytes);
  const checksumBytes = fs.readFileSync(paths.checksum);
  const checksumText = new TextDecoder('utf-8', { fatal: true }).decode(checksumBytes);
  const checksumMatch = /^([a-fA-F0-9]{64})[ \t]+watch-mode-en-original\.wav(?:\r?\n)?$/.exec(checksumText);
  if (!checksumMatch || checksumMatch[1].toLowerCase() !== mediaSha256) {
    throw new Error('canonical checksum file does not bind exactly the canonical WAV');
  }
  const metadataBytes = fs.readFileSync(paths.metadata);
  const metadataText = new TextDecoder('utf-8', { fatal: true }).decode(metadataBytes);
  let metadata;
  try {
    metadata = JSON.parse(metadataText);
  } catch (error) {
    throw new Error(`canonical fixture metadata is invalid JSON: ${error.message}`);
  }
  const fixtures = Array.isArray(metadata.fixtures) ? metadata.fixtures.filter((entry) => entry?.id === 'general') : [];
  if (fixtures.length !== 1) throw new Error('canonical metadata must contain exactly one general fixture');
  const fixture = fixtures[0];
  const expectedFixture = {
    id: 'general',
    durationSeconds: Number(fixture.durationSeconds),
    sampleRateHz: media.sampleRateHz,
    channels: media.channels,
    bitsPerSample: media.bitsPerSample,
  };
  if (
    fixture.audio !== canonicalNames.media
    || fixture.checksum !== canonicalNames.checksum
    || fixture.source !== canonicalNames.sourceText
    || fixture.reference !== canonicalNames.translationText
    || String(fixture.sha256).toLowerCase() !== mediaSha256
    || Math.abs(Number(fixture.durationSeconds) - media.frames / media.sampleRateHz) > 0.001
    || Number(fixture.sampleRate) !== expectedFixture.sampleRateHz
    || Number(fixture.channels) !== expectedFixture.channels
    || Number(fixture.bitsPerSample) !== expectedFixture.bitsPerSample
  ) throw new Error('canonical metadata general fixture does not exactly bind the WAV/text/checksum tuple');

  const sourceText = readUtf8Exact(paths.sourceText, 'canonical source text');
  const translationText = readUtf8Exact(paths.translationText, 'canonical translation text');
  const referencePcm = pcm16WaveToInjectorReference(mediaBytes);
  return {
    paths,
    media: {
      bytes: mediaBytes.length,
      sha256: mediaSha256,
      sourceSampleRateHz: media.sampleRateHz,
      sourceChannels: media.channels,
      bitsPerSample: media.bitsPerSample,
      sourceFrames: media.frames,
    },
    checksum: { bytes: checksumBytes.length, sha256: sha256Buffer(checksumBytes), text: checksumText },
    metadata: { bytes: metadataBytes.length, sha256: sha256Buffer(metadataBytes) },
    sourceText: { bytes: sourceText.bytes.length, sha256: sha256Buffer(sourceText.bytes), text: sourceText.text },
    translationText: { bytes: translationText.bytes.length, sha256: sha256Buffer(translationText.bytes), text: translationText.text },
    referencePcm: {
      buffer: referencePcm,
      bytes: referencePcm.length,
      samples: referencePcm.length / 2,
      sampleRateHz: CANONICAL_SOURCE_SAMPLE_RATE_HZ,
      channels: 1,
      durationSeconds: referencePcm.length / 2 / CANONICAL_SOURCE_SAMPLE_RATE_HZ,
      sha256: sha256Buffer(referencePcm),
    },
    fixture: expectedFixture,
  };
}

function readJson(filePath, label) {
  regularFile(filePath, label);
  try {
    const text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

export function validateCanonicalSourceAuthority({
  runDirectory,
  workspaceRoot = defaultWorkspaceRoot,
  sourceAuthority,
} = {}) {
  if (!runDirectory) throw new Error('runDirectory is required');
  const runRoot = path.resolve(runDirectory);
  const fixture = loadCanonicalFixtureAuthority({ workspaceRoot });
  const referencePath = path.join(runRoot, referencePcmName);
  const referenceStat = regularFile(referencePath, 'run canonical reference PCM');
  if (referenceStat.size % 2 !== 0) throw new Error('run canonical reference PCM has an odd byte length');
  const referenceBytes = fs.readFileSync(referencePath);
  if (!referenceBytes.equals(fixture.referencePcm.buffer)) {
    throw new Error('run canonical reference PCM is not byte-for-byte the injector reconstruction');
  }
  const authority = sourceAuthority ?? readJson(path.join(runRoot, sourceAuthorityName), 'canonical source authority');
  if (
    authority.schemaVersion !== CANONICAL_SOURCE_AUTHORITY_SCHEMA_VERSION
    || authority.passed !== true
    || authority.authorityMode !== CANONICAL_SOURCE_AUTHORITY_MODE
    || authority.remoteProviderCalls !== 0
    || authority.externalAudioSeconds !== 0
    || authority.fullMedia !== true
    || authority.playbackSeconds !== null
  ) throw new Error('canonical source authority header is not an exact zero-provider full-media authority');

  if (
    authority.mediaPath !== canonicalRelativePaths.media
    || authority.checksumPath !== canonicalRelativePaths.checksum
    || authority.metadataPath !== canonicalRelativePaths.metadata
  ) throw new Error('canonical source authority fixture paths are not the exact portable paths');
  if (authority.mediaSha256 !== fixture.media.sha256 || Number(authority.mediaBytes) !== fixture.media.bytes) {
    throw new Error('canonical source media bytes/hash mismatch');
  }
  if (authority.source !== fixture.sourceText.text || authority.translation !== fixture.translationText.text) {
    throw new Error('canonical source authority top-level source/translation text mismatch');
  }
  exactObject(authority.sourceText, {
    path: canonicalRelativePaths.sourceText,
    bytes: fixture.sourceText.bytes,
    sha256: fixture.sourceText.sha256,
  }, 'canonical sourceText');
  exactObject(authority.translationText, {
    path: canonicalRelativePaths.translationText,
    bytes: fixture.translationText.bytes,
    sha256: fixture.translationText.sha256,
  }, 'canonical translationText');
  exactObject(authority.referencePcm, {
    path: referencePcmName,
    bytes: fixture.referencePcm.bytes,
    samples: fixture.referencePcm.samples,
    sampleRateHz: fixture.referencePcm.sampleRateHz,
    channels: fixture.referencePcm.channels,
    durationSeconds: Number(fixture.referencePcm.durationSeconds.toFixed(6)),
    sha256: fixture.referencePcm.sha256,
  }, 'canonical referencePcm');
  exactObject(authority.fixture, fixture.fixture, 'canonical fixture');

  return {
    schemaVersion: CANONICAL_SOURCE_AUTHORITY_SCHEMA_VERSION,
    artifactKind: 'watch-mode-canonical-source-authority-validation',
    passed: true,
    authorityMode: CANONICAL_SOURCE_AUTHORITY_MODE,
    remoteProviderCalls: 0,
    externalAudioSeconds: 0,
    media: { path: canonicalRelativePaths.media, bytes: fixture.media.bytes, sha256: fixture.media.sha256 },
    checksum: {
      path: canonicalRelativePaths.checksum,
      bytes: fixture.checksum.bytes,
      sha256: fixture.checksum.sha256,
      declaredMediaSha256: fixture.media.sha256,
    },
    metadata: { path: canonicalRelativePaths.metadata, bytes: fixture.metadata.bytes, sha256: fixture.metadata.sha256 },
    source: fixture.sourceText.text,
    translation: fixture.translationText.text,
    sourceText: { path: canonicalRelativePaths.sourceText, bytes: fixture.sourceText.bytes, sha256: fixture.sourceText.sha256 },
    translationText: { path: canonicalRelativePaths.translationText, bytes: fixture.translationText.bytes, sha256: fixture.translationText.sha256 },
    referencePcm: {
      path: referencePcmName,
      bytes: fixture.referencePcm.bytes,
      samples: fixture.referencePcm.samples,
      sampleRateHz: fixture.referencePcm.sampleRateHz,
      channels: fixture.referencePcm.channels,
      durationSeconds: Number(fixture.referencePcm.durationSeconds.toFixed(6)),
      sha256: fixture.referencePcm.sha256,
      byteForByteInjectorReconstruction: true,
    },
    fixture: fixture.fixture,
  };
}

function readPcm16(filePath, label) {
  const stat = regularFile(filePath, label);
  if (stat.size % 2 !== 0) throw new Error(`${label} must contain whole PCM16 samples`);
  const bytes = fs.readFileSync(filePath);
  const samples = new Int16Array(bytes.length / 2);
  for (let index = 0; index < samples.length; index += 1) samples[index] = bytes.readInt16LE(index * 2);
  return { bytes, samples };
}

function pearson(left, right, leftStart, rightStart, count, stride = 1, derivative = false) {
  let sumLeft = 0;
  let sumRight = 0;
  let observed = 0;
  const begin = derivative ? 1 : 0;
  for (let offset = begin; offset < count; offset += stride) {
    const leftIndex = leftStart + offset;
    const rightIndex = rightStart + offset;
    const leftValue = derivative ? left[leftIndex] - left[leftIndex - 1] : left[leftIndex];
    const rightValue = derivative ? right[rightIndex] - right[rightIndex - 1] : right[rightIndex];
    sumLeft += leftValue;
    sumRight += rightValue;
    observed += 1;
  }
  if (observed < 32) return 0;
  const meanLeft = sumLeft / observed;
  const meanRight = sumRight / observed;
  let numerator = 0;
  let denominatorLeft = 0;
  let denominatorRight = 0;
  for (let offset = begin; offset < count; offset += stride) {
    const leftIndex = leftStart + offset;
    const rightIndex = rightStart + offset;
    const leftValue = (derivative ? left[leftIndex] - left[leftIndex - 1] : left[leftIndex]) - meanLeft;
    const rightValue = (derivative ? right[rightIndex] - right[rightIndex - 1] : right[rightIndex]) - meanRight;
    numerator += leftValue * rightValue;
    denominatorLeft += leftValue * leftValue;
    denominatorRight += rightValue * rightValue;
  }
  const denominator = Math.sqrt(denominatorLeft * denominatorRight);
  return denominator > 0 ? numerator / denominator : 0;
}

function rmsRatio(reference, recorded, referenceStart, recordedStart, count) {
  let referenceEnergy = 0;
  let recordedEnergy = 0;
  for (let offset = 0; offset < count; offset += 1) {
    const referenceSample = reference[referenceStart + offset];
    const recordedSample = recorded[recordedStart + offset];
    referenceEnergy += referenceSample * referenceSample;
    recordedEnergy += recordedSample * recordedSample;
  }
  if (referenceEnergy <= 0) return 0;
  return Math.sqrt(recordedEnergy / referenceEnergy);
}

function segmentPlan(referenceLength) {
  if (referenceLength < CANONICAL_SOURCE_SAMPLE_RATE_HZ * 3) {
    throw new Error('source reference needs at least three seconds for independent waveform segments');
  }
  // Translation audio can overlap an otherwise exact source passthrough. Use
  // a fixed grid of candidates so one favorable interval cannot be reused or
  // substituted for distributed evidence across the source timeline.
  const candidateCount = 9;
  const segmentSamples = Math.min(CANONICAL_SOURCE_SAMPLE_RATE_HZ, Math.floor(referenceLength / (candidateCount + 2)));
  const available = referenceLength - segmentSamples;
  const starts = Array.from({ length: candidateCount }, (_, index) => {
    const fraction = 0.04 + (0.92 * index) / (candidateCount - 1);
    return Math.floor(available * fraction);
  });
  for (let index = 1; index < starts.length; index += 1) {
    if (starts[index] < starts[index - 1] + segmentSamples) throw new Error('source segment plan overlaps');
  }
  return starts.map((referenceStartSample, index) => ({ index, referenceStartSample, samples: segmentSamples }));
}

function lagScore(reference, recorded, segments, lag, stride) {
  let waveform = 0;
  let derivative = 0;
  for (const segment of segments) {
    waveform += pearson(reference, recorded, segment.referenceStartSample, segment.referenceStartSample + lag, segment.samples, stride, false);
    derivative += pearson(reference, recorded, segment.referenceStartSample, segment.referenceStartSample + lag, segment.samples, stride, true);
  }
  const combinedWaveform = waveform / segments.length;
  const combinedDerivative = derivative / segments.length;
  const sign = combinedWaveform < 0 ? -1 : 1;
  return {
    waveform: combinedWaveform * sign,
    derivative: combinedDerivative * sign,
    signedWaveform: combinedWaveform,
    signedDerivative: combinedDerivative,
    polarity: sign,
    score: Math.max(0, combinedWaveform * sign) * 0.65 + Math.max(0, combinedDerivative * sign) * 0.35,
  };
}

function findGlobalLag(reference, recorded, segments) {
  const last = segments.at(-1);
  const maximumFitLag = recorded.length - (last.referenceStartSample + last.samples);
  if (maximumFitLag < 0) throw new Error('physical source window is shorter than the required canonical segments');
  const maximumLag = Math.min(maximumFitLag, CANONICAL_SOURCE_SAMPLE_RATE_HZ * 15);
  const coarseStep = 80;
  let best = { lag: 0, score: -1 };
  for (let lag = 0; lag <= maximumLag; lag += coarseStep) {
    const score = lagScore(reference, recorded, segments, lag, 32);
    if (score.score > best.score) best = { lag, ...score };
  }
  const refineStart = Math.max(0, best.lag - coarseStep);
  const refineEnd = Math.min(maximumLag, best.lag + coarseStep);
  for (let lag = refineStart; lag <= refineEnd; lag += 1) {
    const score = lagScore(reference, recorded, segments, lag, 8);
    if (score.score > best.score) best = { lag, ...score };
  }
  return { ...best, maximumLag };
}

function bestClockBoundFragment(reference, recorded, segment, anchorLag, polarity) {
  // The media renderer and physical loopback capture are different hardware
  // clocks. Keep the global lag as the signed identity/polarity anchor, but
  // permit a tightly bounded local correction and a short fragment inside each
  // fixed one-second candidate. This retains 7/9 distributed coverage while
  // preventing dense translated speech from vetoing the original waveform.
  const minimumLag = Math.max(0, anchorLag - physicalLocalLagRadiusSamples);
  const maximumLag = Math.min(
    anchorLag + physicalLocalLagRadiusSamples,
    recorded.length - (segment.referenceStartSample + physicalFragmentSamples),
  );
  let best = null;
  const evaluate = (referenceOffsetSample, lag, stride) => {
    const referenceStartSample = segment.referenceStartSample + referenceOffsetSample;
    const recordedStartSample = referenceStartSample + lag;
    if (
      recordedStartSample < 0
      || referenceStartSample + physicalFragmentSamples > reference.length
      || recordedStartSample + physicalFragmentSamples > recorded.length
    ) return;
    const waveform = pearson(
      reference,
      recorded,
      referenceStartSample,
      recordedStartSample,
      physicalFragmentSamples,
      stride,
      false,
    ) * polarity;
    const derivative = pearson(
      reference,
      recorded,
      referenceStartSample,
      recordedStartSample,
      physicalFragmentSamples,
      stride,
      true,
    ) * polarity;
    const score = Math.max(0, waveform) * 0.65 + Math.max(0, derivative) * 0.35;
    if (!best || score > best.score) {
      best = { referenceOffsetSample, referenceStartSample, recordedStartSample, lag, waveform, derivative, score };
    }
  };
  for (
    let referenceOffsetSample = 0;
    referenceOffsetSample <= segment.samples - physicalFragmentSamples;
    referenceOffsetSample += physicalFragmentOffsetStep
  ) {
    for (let lag = minimumLag; lag <= maximumLag; lag += 80) {
      evaluate(referenceOffsetSample, lag, 8);
    }
  }
  if (!best) throw new Error('physical waveform candidate has no complete clock-bounded fragment');
  const coarse = best;
  for (let lag = Math.max(minimumLag, coarse.lag - 80); lag <= Math.min(maximumLag, coarse.lag + 80); lag += 4) {
    evaluate(coarse.referenceOffsetSample, lag, 4);
  }
  const refined = best;
  for (let lag = Math.max(minimumLag, refined.lag - 4); lag <= Math.min(maximumLag, refined.lag + 4); lag += 1) {
    evaluate(refined.referenceOffsetSample, lag, 2);
  }
  return best;
}

function adaptiveCandidateAuthorities(reference, recorded, segments, global) {
  return segments.map((segment) => {
    const fragment = bestClockBoundFragment(reference, recorded, segment, global.lag, global.polarity);
    const energyRatio = rmsRatio(
      reference,
      recorded,
      fragment.referenceStartSample,
      fragment.recordedStartSample,
      physicalFragmentSamples,
    );
    const coveragePassed = (
      fragment.waveform >= waveformThresholds.minimumCandidateWaveformCorrelation
      && fragment.derivative >= waveformThresholds.minimumCandidateDerivativeCorrelation
      && energyRatio >= waveformThresholds.minimumCandidateEnergyRatio
      && energyRatio <= waveformThresholds.maximumCandidateEnergyRatio
    );
    return {
      index: segment.index,
      anchorReferenceStartSample: segment.referenceStartSample,
      referenceOffsetSample: fragment.referenceOffsetSample,
      referenceStartSample: fragment.referenceStartSample,
      recordedStartSample: fragment.recordedStartSample,
      samples: physicalFragmentSamples,
      anchorLagSamples: global.lag,
      localLagSamples: fragment.lag,
      localLagDeltaSamples: fragment.lag - global.lag,
      waveformCorrelation: rounded(fragment.waveform),
      derivativeCorrelation: rounded(fragment.derivative),
      energyRatio: rounded(energyRatio),
      coveragePassed,
    };
  });
}

const median = (values) => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
const rounded = (value) => Number(value.toFixed(6));

function scoreWrongReference(wrong, recorded) {
  const comparisonLength = Math.min(
    wrong.length,
    Math.max(0, recorded.length - CANONICAL_SOURCE_SAMPLE_RATE_HZ),
  );
  const plan = segmentPlan(comparisonLength);
  // Give each negative control its own best possible lag. The margin therefore
  // cannot be manufactured by evaluating a wrong source at an unfavorable
  // offset chosen for the canonical source.
  const global = findGlobalLag(wrong, recorded, plan);
  const candidates = adaptiveCandidateAuthorities(wrong, recorded, plan, global)
    .sort((left, right) => (
      (right.waveformCorrelation * 0.65 + right.derivativeCorrelation * 0.35)
      - (left.waveformCorrelation * 0.65 + left.derivativeCorrelation * 0.35)
    ))
    .slice(0, 3);
  const waveform = median(candidates.map((entry) => entry.waveformCorrelation));
  const derivative = median(candidates.map((entry) => entry.derivativeCorrelation));
  return Math.max(0, waveform) * 0.65 + Math.max(0, derivative) * 0.35;
}

function reverseSamplesWithinBlocks(reference, blockSamples) {
  const samples = new Int16Array(reference.length);
  for (let blockStart = 0; blockStart < reference.length; blockStart += blockSamples) {
    const blockEnd = Math.min(reference.length, blockStart + blockSamples);
    for (let offset = 0; offset < blockEnd - blockStart; offset += 1) {
      samples[blockStart + offset] = reference[blockEnd - offset - 1];
    }
  }
  return samples;
}

export function buildCanonicalSpeechNegativeControls(reference) {
  if (!(reference instanceof Int16Array) || reference.length === 0) {
    throw new Error('canonical speech negative controls require non-empty Int16Array samples');
  }
  return [
    {
      label: 'canonical-speech-full-time-reversal',
      samples: reverseSamplesWithinBlocks(reference, reference.length),
    },
    {
      label: 'canonical-speech-250ms-block-time-reversal',
      samples: reverseSamplesWithinBlocks(reference, CANONICAL_SOURCE_SAMPLE_RATE_HZ / 4),
    },
  ];
}

export function buildPhysicalSourceWaveformAuthority({
  runDirectory,
  referencePcmPath,
  sourceWindowPath,
  physicalRecordingPcmPath,
  wrongReferencePcmPaths,
} = {}) {
  if (!runDirectory && (!referencePcmPath || !sourceWindowPath)) {
    throw new Error('runDirectory or explicit reference/source-window paths are required');
  }
  const runRoot = path.resolve(runDirectory ?? path.dirname(sourceWindowPath));
  const resolvedReferencePath = path.resolve(referencePcmPath ?? path.join(runRoot, referencePcmName));
  const resolvedWindowPath = path.resolve(sourceWindowPath ?? path.join(runRoot, physicalSourceWindowName));
  const resolvedRecordingPath = path.resolve(
    physicalRecordingPcmPath ?? path.join(runRoot, physicalRecordingPcmName),
  );
  const portableRunChild = (filePath, label) => {
    const relativePath = portable(path.relative(runRoot, filePath));
    if (!relativePath || relativePath === '..' || relativePath.startsWith('../') || path.isAbsolute(relativePath)) {
      throw new Error(`${label} must be inside runDirectory`);
    }
    return relativePath;
  };
  const referenceRelativePath = portableRunChild(resolvedReferencePath, 'canonical reference PCM');
  const sourceWindowRelativePath = portableRunChild(resolvedWindowPath, 'physical source-window PCM');
  const physicalRecordingRelativePath = portableRunChild(
    resolvedRecordingPath,
    'physical recording PCM',
  );
  if (resolvedReferencePath === resolvedWindowPath) throw new Error('physical source window cannot reuse the reference PCM path');
  const reference = readPcm16(resolvedReferencePath, 'canonical reference PCM');
  const recorded = readPcm16(resolvedWindowPath, 'physical source-window PCM');
  const physicalRecording = readPcm16(resolvedRecordingPath, 'physical recording PCM');
  if (reference.bytes.equals(recorded.bytes)) throw new Error('physical source window cannot reuse the canonical reference bytes');
  if (
    recorded.bytes.length > physicalRecording.bytes.length
    || !physicalRecording.bytes.subarray(0, recorded.bytes.length).equals(recorded.bytes)
  ) throw new Error('physical source window is not the exact prefix of the physical recording PCM');

  // A production physical capture may intentionally retain only the first
  // 90 seconds of the 126-second source. Plan all three anchors inside the
  // common prefix while leaving room to discover startup latency.
  const comparisonLength = Math.min(
    reference.samples.length,
    Math.max(0, recorded.samples.length - CANONICAL_SOURCE_SAMPLE_RATE_HZ),
  );
  const segments = segmentPlan(comparisonLength);
  const global = findGlobalLag(reference.samples, recorded.samples, segments);
  const candidateAuthorities = adaptiveCandidateAuthorities(
    reference.samples,
    recorded.samples,
    segments,
    global,
  );
  const segmentAuthorities = [...candidateAuthorities]
    .sort((left, right) => (
      (right.waveformCorrelation * 0.65 + right.derivativeCorrelation * 0.35)
      - (left.waveformCorrelation * 0.65 + left.derivativeCorrelation * 0.35)
    ))
    .slice(0, 3)
    .sort((left, right) => left.referenceStartSample - right.referenceStartSample);
  for (let index = 1; index < segmentAuthorities.length; index += 1) {
    const previous = segmentAuthorities[index - 1];
    const current = segmentAuthorities[index];
    if (
      current.referenceStartSample < previous.referenceStartSample + previous.samples
      || current.recordedStartSample < previous.recordedStartSample + previous.samples
    ) throw new Error('physical waveform authority reused an overlapping comparison window');
  }

  let wrongPaths = wrongReferencePcmPaths;
  let wrongBuffers = [];
  if (wrongPaths === undefined) {
    wrongBuffers = buildCanonicalSpeechNegativeControls(reference.samples);
  } else {
    wrongBuffers = wrongPaths.map((filePath) => ({
      label: portableRunChild(path.resolve(filePath), 'wrong-reference PCM'),
      samples: readPcm16(path.resolve(filePath), 'wrong-reference PCM').samples,
    }));
  }
  if (wrongBuffers.length === 0) throw new Error('at least one wrong-reference control is required');
  const wrongReferences = wrongBuffers.map(({ label, samples }) => ({
    label,
    score: rounded(scoreWrongReference(samples, recorded.samples)),
  }));
  const maximumWrongReferenceScore = Math.max(...wrongReferences.map((entry) => entry.score));
  const waveformValues = segmentAuthorities.map((entry) => entry.waveformCorrelation);
  const derivativeValues = segmentAuthorities.map((entry) => entry.derivativeCorrelation);
  const globalWaveformCorrelation = median(waveformValues);
  const globalDerivativeCorrelation = median(derivativeValues);
  const correctReferenceScore = Math.max(0, globalWaveformCorrelation) * 0.65
    + Math.max(0, globalDerivativeCorrelation) * 0.35;
  const wrongReferenceMargin = correctReferenceScore - maximumWrongReferenceScore;
  const passingCandidateCount = candidateAuthorities.filter((entry) => entry.coveragePassed).length;
  const violations = [];
  if (globalWaveformCorrelation < waveformThresholds.globalWaveformCorrelation) violations.push('global signed waveform correlation is below threshold');
  if (globalDerivativeCorrelation < waveformThresholds.globalDerivativeCorrelation) violations.push('global signed derivative correlation is below threshold');
  if (Math.min(...waveformValues) < waveformThresholds.minimumSegmentWaveformCorrelation) violations.push('a signed waveform segment is below threshold');
  if (Math.min(...derivativeValues) < waveformThresholds.minimumSegmentDerivativeCorrelation) violations.push('a signed derivative segment is below threshold');
  if (median(waveformValues) < waveformThresholds.medianSegmentWaveformCorrelation) violations.push('median signed waveform segment is below threshold');
  if (median(derivativeValues) < waveformThresholds.medianSegmentDerivativeCorrelation) violations.push('median signed derivative segment is below threshold');
  if (wrongReferenceMargin < waveformThresholds.wrongReferenceMargin) violations.push('correct-reference score lacks the required wrong-reference margin');
  if (passingCandidateCount < waveformThresholds.minimumPassingCandidateCount) {
    violations.push(`only ${passingCandidateCount}/${candidateAuthorities.length} source windows passed waveform, derivative, and energy coverage`);
  }

  return {
    schemaVersion: 1,
    artifactKind: 'watch-mode-physical-source-waveform-authority',
    authorityMode: PHYSICAL_SOURCE_WAVEFORM_AUTHORITY_MODE,
    passed: violations.length === 0,
    remoteProviderCalls: 0,
    externalAudioSeconds: 0,
    referencePcm: { path: referenceRelativePath, bytes: reference.bytes.length, sha256: sha256Buffer(reference.bytes) },
    physicalRecordingPcm: {
      path: physicalRecordingRelativePath,
      bytes: physicalRecording.bytes.length,
      sha256: sha256Buffer(physicalRecording.bytes),
    },
    sourceWindowPcm: {
      path: sourceWindowRelativePath,
      bytes: recorded.bytes.length,
      sha256: sha256Buffer(recorded.bytes),
      physicalRecordingPrefixOffsetBytes: 0,
      physicalRecordingPrefixExact: true,
    },
    sampleRateHz: CANONICAL_SOURCE_SAMPLE_RATE_HZ,
    globalPolarity: global.polarity,
    globalLagSamples: global.lag,
    globalLagSeconds: rounded(global.lag / CANONICAL_SOURCE_SAMPLE_RATE_HZ),
    globalWaveformCorrelation: rounded(globalWaveformCorrelation),
    globalDerivativeCorrelation: rounded(globalDerivativeCorrelation),
    correctReferenceScore: rounded(correctReferenceScore),
    maximumWrongReferenceScore: rounded(maximumWrongReferenceScore),
    wrongReferenceMargin: rounded(wrongReferenceMargin),
    thresholds: waveformThresholds,
    independentNonOverlappingSegmentCount: segmentAuthorities.length,
    candidateSegmentCount: candidateAuthorities.length,
    passingCandidateCount,
    candidateCoverageRatio: rounded(passingCandidateCount / candidateAuthorities.length),
    candidates: candidateAuthorities,
    segments: segmentAuthorities,
    wrongReferences,
    windowReuseRejected: true,
    violations,
  };
}

function pcmBufferToSamples(bytes) {
  if (bytes.length % 2 !== 0) throw new Error('PCM16 buffer has an odd byte length');
  const samples = new Int16Array(bytes.length / 2);
  for (let index = 0; index < samples.length; index += 1) samples[index] = bytes.readInt16LE(index * 2);
  return samples;
}

export function validateRunCanonicalSourceAuthority(options = {}) {
  const sourceAuthority = validateCanonicalSourceAuthority(options);
  const physicalSourceWaveform = buildPhysicalSourceWaveformAuthority(options);
  if (!physicalSourceWaveform.passed) {
    throw new Error(`physical original-source waveform authority failed: ${physicalSourceWaveform.violations.join('; ')}`);
  }
  return {
    schemaVersion: CANONICAL_SOURCE_AUTHORITY_SCHEMA_VERSION,
    artifactKind: 'watch-mode-canonical-source-and-physical-authority',
    passed: true,
    remoteProviderCalls: 0,
    externalAudioSeconds: 0,
    sourceAuthority,
    physicalSourceWaveform,
  };
}

function parseCliArgs(argv) {
  const values = {};
  let referenceOnly = false;
  let sourceOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--reference-only') {
      referenceOnly = true;
      continue;
    }
    if (key === '--source-only') {
      sourceOnly = true;
      continue;
    }
    if (key !== '--run-directory' && key !== '--workspace-root') throw new Error(`unknown argument: ${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${key} requires a value`);
    values[key.slice(2)] = value;
    index += 1;
  }
  if (!values['run-directory']) throw new Error('--run-directory is required');
  if (referenceOnly && sourceOnly) throw new Error('--reference-only and --source-only are mutually exclusive');
  return {
    runDirectory: values['run-directory'],
    ...(values['workspace-root'] ? { workspaceRoot: values['workspace-root'] } : {}),
    referenceOnly,
    sourceOnly,
  };
}

export function validateCanonicalReferencePcm({
  runDirectory,
  workspaceRoot = defaultWorkspaceRoot,
} = {}) {
  if (!runDirectory) throw new Error('runDirectory is required');
  const fixture = loadCanonicalFixtureAuthority({ workspaceRoot });
  const referencePath = path.join(path.resolve(runDirectory), referencePcmName);
  const bytes = fs.readFileSync(referencePath);
  regularFile(referencePath, 'run canonical reference PCM');
  if (!bytes.equals(fixture.referencePcm.buffer)) {
    throw new Error('run canonical reference PCM is not byte-for-byte the injector reconstruction');
  }
  return {
    schemaVersion: CANONICAL_SOURCE_AUTHORITY_SCHEMA_VERSION,
    artifactKind: 'watch-mode-canonical-reference-pcm-validation',
    passed: true,
    remoteProviderCalls: 0,
    externalAudioSeconds: 0,
    media: { path: canonicalRelativePaths.media, bytes: fixture.media.bytes, sha256: fixture.media.sha256 },
    checksum: {
      path: canonicalRelativePaths.checksum,
      bytes: fixture.checksum.bytes,
      sha256: fixture.checksum.sha256,
      declaredMediaSha256: fixture.media.sha256,
    },
    metadata: { path: canonicalRelativePaths.metadata, bytes: fixture.metadata.bytes, sha256: fixture.metadata.sha256 },
    source: fixture.sourceText.text,
    translation: fixture.translationText.text,
    sourceText: { path: canonicalRelativePaths.sourceText, bytes: fixture.sourceText.bytes, sha256: fixture.sourceText.sha256 },
    translationText: { path: canonicalRelativePaths.translationText, bytes: fixture.translationText.bytes, sha256: fixture.translationText.sha256 },
    referencePcm: {
      path: referencePcmName,
      bytes: fixture.referencePcm.bytes,
      samples: fixture.referencePcm.samples,
      sampleRateHz: fixture.referencePcm.sampleRateHz,
      channels: fixture.referencePcm.channels,
      durationSeconds: Number(fixture.referencePcm.durationSeconds.toFixed(6)),
      sha256: fixture.referencePcm.sha256,
    },
    fixture: fixture.fixture,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseCliArgs(process.argv.slice(2));
    const result = options.referenceOnly
      ? validateCanonicalReferencePcm(options)
      : options.sourceOnly
        ? validateCanonicalSourceAuthority(options)
        : validateRunCanonicalSourceAuthority(options);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
