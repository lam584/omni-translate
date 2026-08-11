import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseLooseArgs } from '../lib/testing-common.mjs';
import {
  currentGitProvenance,
  exactGitProvenanceFailure,
} from './git-provenance.mjs';
import { rebuildReportFromDirectory } from './watch-mode-report.mjs';
import {
  CELL_AUTHORITY_ARTIFACT_KIND,
  CELL_AUTHORITY_FILE,
  CELL_AUTHORITY_SCHEMA_VERSION,
  LIVE_RUN_COLLECTOR_ID,
  MATRIX_RUNNER_ID,
  STRICT_MATRIX_ARTIFACT_KIND,
  STRICT_MATRIX_SCHEMA_VERSION,
  canonicalJson,
  currentAuthorityImplementationHashes,
  currentAuthorityRuntimeBinaryHashes,
  fileAuthorityEntry,
  forbiddenCellArtifactPaths,
  requiredCellArtifactPaths,
  resolveAuthorityPath,
  sameAuthorityInventory,
  validateFileAuthorityEntry,
} from './watch-mode-evidence-authority.mjs';
import {
  BALANCED_RELEASE_PLAN,
  LIVE_LLM_CELLS,
  RELEASE_DEVICE_CLASSES,
  RELEASE_MODELS,
  balancedReleasePlanFailure,
} from './watch-mode-balanced-release-plan.mjs';
import { verifyLocalIsolationManifest } from './watch-mode-local-isolation.mjs';

export const STRICT_MATRIX_VERIFICATION_ARTIFACT_KIND = 'watch-mode-strict-matrix-verification';

export function strictMatrixVerificationReceiptPath(manifestPath) {
  return `${path.resolve(manifestPath)}.verified.json`;
}

function atomicWriteJson(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporaryPath, filePath);
}

export function writeStrictMatrixVerificationReceipt({
  manifestPath,
  manifest,
  authority,
  currentProvenance,
  now = new Date(),
}) {
  const sourceManifest = fileAuthorityEntry(
    path.resolve(manifestPath),
    path.basename(manifestPath),
  );
  const receipt = {
    schemaVersion: 1,
    artifactKind: STRICT_MATRIX_VERIFICATION_ARTIFACT_KIND,
    verifiedAt: now.toISOString(),
    verifier: 'scripts/testing/verify-watch-mode-evidence.mjs',
    provenance: currentProvenance,
    sourceManifestPath: sourceManifest.path,
    sourceManifestBytes: sourceManifest.bytes,
    sourceManifestSha256: sourceManifest.sha256,
    implementationHashes: authority.implementationHashes,
    runtimeBinaryHashes: authority.runtimeBinaryHashes,
    cells: manifest.cells.map((cell) => ({
      cellId: cell.cellId,
      tier: cell.tier,
      providerMode: cell.providerMode,
      durationSeconds: cell.durationSeconds,
      modelId: cell.modelId,
      feedbackLoopPrevention: cell.feedbackLoopPrevention,
      deviceClass: cell.deviceClass,
      deviceProfileId: cell.deviceProfileId,
      runDirectory: cell.runDirectory,
      receiptPath: cell.receiptPath,
      receiptBytes: cell.receiptBytes,
      receiptSha256: cell.receiptSha256,
    })),
    verdict: 'passed',
  };
  const receiptPath = strictMatrixVerificationReceiptPath(manifestPath);
  atomicWriteJson(receiptPath, receipt);
  return { receiptPath, receipt };
}

export function validateStrictMatrixVerificationReceipt({
  receiptPath,
  manifestPath,
  manifest,
  currentProvenance,
  implementationHashes,
  runtimeBinaryHashes,
}) {
  const resolvedReceiptPath = path.resolve(receiptPath);
  const expectedReceiptPath = strictMatrixVerificationReceiptPath(manifestPath);
  if (resolvedReceiptPath !== expectedReceiptPath) {
    throw new Error(`strict verification receipt path mismatch: expected ${expectedReceiptPath}; got ${resolvedReceiptPath}`);
  }
  const receipt = readJson(resolvedReceiptPath);
  if (
    receipt.schemaVersion !== 1
    || receipt.artifactKind !== STRICT_MATRIX_VERIFICATION_ARTIFACT_KIND
    || receipt.verifier !== 'scripts/testing/verify-watch-mode-evidence.mjs'
    || receipt.verdict !== 'passed'
  ) {
    throw new Error('strict matrix verification receipt is missing or was not emitted by the production verifier');
  }
  const sourceManifest = fileAuthorityEntry(
    path.resolve(manifestPath),
    path.basename(manifestPath),
  );
  if (
    receipt.sourceManifestPath !== sourceManifest.path
    || receipt.sourceManifestBytes !== sourceManifest.bytes
    || receipt.sourceManifestSha256 !== sourceManifest.sha256
  ) {
    throw new Error('strict matrix verification receipt does not bind the current source manifest bytes');
  }
  const provenanceFailure = exactGitProvenanceFailure(
    receipt.provenance,
    currentProvenance,
    {
      recordedSubject: 'strict verification receipt provenance',
      currentSubject: 'current checkout provenance',
    },
  );
  if (provenanceFailure) throw new Error(provenanceFailure);
  if (
    !sameAuthorityInventory(receipt.implementationHashes, implementationHashes)
    || !sameAuthorityInventory(receipt.runtimeBinaryHashes, runtimeBinaryHashes)
  ) {
    throw new Error('strict matrix verification receipt implementation/runtime authority mismatch');
  }
  const expectedCells = manifest.cells.map((cell) => ({
    cellId: cell.cellId,
    tier: cell.tier,
    providerMode: cell.providerMode,
    durationSeconds: cell.durationSeconds,
    modelId: cell.modelId,
    feedbackLoopPrevention: cell.feedbackLoopPrevention,
    deviceClass: cell.deviceClass,
    deviceProfileId: cell.deviceProfileId,
    runDirectory: cell.runDirectory,
    receiptPath: cell.receiptPath,
    receiptBytes: cell.receiptBytes,
    receiptSha256: cell.receiptSha256,
  }));
  assertExactObject(receipt.cells, expectedCells, 'strict matrix verification receipt cells');
  return { receiptPath: resolvedReceiptPath, receipt };
}

export const REQUIRED_LAYERS = [
  'driver',
  'wasapi',
  'bridge',
  'physicalOutput',
  'physicalOutputContent',
  'speechSegmentation',
  'strictContent',
  'app',
  'provider',
];

export const BASE_REQUIRED_LAYERS = REQUIRED_LAYERS.filter((layer) => layer !== 'strictContent');

export const ECHO_CANCEL_REQUIRED_LAYERS = [
  'aec',
  'app',
  'provider',
];

export const PROCESS_EXCLUSION_REQUIRED_LAYERS = REQUIRED_LAYERS.filter(
  (layer) => !['driver', 'wasapi'].includes(layer),
);

const DEFAULT_ROOT = 'artifacts/testing/watch-mode-live';
const DEFAULT_STRICT_MODELS = RELEASE_MODELS;
export const DEFAULT_STRICT_DEVICE_CLASSES = RELEASE_DEVICE_CLASSES;
export const MIN_STRICT_SESSION_DURATION_MS = 180_000;
const EXCLUDED_DIRECTORY_PATTERNS = [
  /^cache$/i,
  /^physical-output-smoke-/i,
  /^reference-pcm-smoke-/i,
];
const INVALID_CANDIDATE_PRINT_LIMIT = 12;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

export function normalizeRunDirectories(value, { baseDirectory = process.cwd() } = {}) {
  let entries = value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(trimmed);
    entries = Array.isArray(parsed) ? parsed : parsed?.runDirectories;
  }
  if (!Array.isArray(entries)) {
    throw new Error('runDirectories must be a JSON array or an object containing runDirectories');
  }
  return entries.map((entry, index) => {
    if (typeof entry !== 'string' || !entry.trim()) {
      throw new Error(`runDirectories[${index}] must be a non-empty path string`);
    }
    return path.resolve(baseDirectory, entry.trim());
  });
}

export function readRunManifest(manifestPath, { baseDirectory = process.cwd() } = {}) {
  if (typeof manifestPath !== 'string' || !manifestPath.trim()) {
    throw new Error('--run-manifest requires a non-empty file path');
  }
  const resolvedManifestPath = path.resolve(baseDirectory, manifestPath.trim());
  if (!fs.existsSync(resolvedManifestPath)) {
    throw new Error(`run manifest does not exist: ${resolvedManifestPath}; complete the strict live matrix first`);
  }
  const manifest = readJson(resolvedManifestPath);
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`run manifest must contain a JSON object: ${resolvedManifestPath}`);
  }
  if (![1, STRICT_MATRIX_SCHEMA_VERSION].includes(manifest.schemaVersion)) {
    throw new Error(`unsupported run manifest schemaVersion=${manifest.schemaVersion ?? 'missing'}: ${resolvedManifestPath}`);
  }
  const runDirectories = normalizeRunDirectories(manifest.runDirectories, {
    baseDirectory: path.dirname(resolvedManifestPath),
  });
  if (runDirectories.length === 0) {
    throw new Error(`run manifest has no runDirectories: ${resolvedManifestPath}`);
  }
  return { manifestPath: resolvedManifestPath, manifest, runDirectories };
}

function reportAuthorityProjection(report) {
  if (!report || typeof report !== 'object') return report;
  const {
    generatedAt: _generatedAt,
    commit: _commit,
    provenance: _provenance,
    artifacts: _artifacts,
    ...stable
  } = report;
  return stable;
}

function assertExactObject(left, right, label) {
  if (canonicalJson(left) !== canonicalJson(right)) {
    throw new Error(`${label} does not match the independently rebuilt raw evidence`);
  }
}

function assertCellIdentity(receiptCell, manifestCell, report, index) {
  assertExactObject(receiptCell, {
    cellId: manifestCell.cellId,
    tier: manifestCell.tier,
    providerMode: manifestCell.providerMode,
    durationSeconds: manifestCell.durationSeconds,
    modelId: manifestCell.modelId,
    feedbackLoopPrevention: manifestCell.feedbackLoopPrevention,
    deviceClass: manifestCell.deviceClass,
    deviceProfileId: manifestCell.deviceProfileId,
  }, `strict matrix cell ${index} receipt identity`);
  if (report.modelId !== manifestCell.modelId) {
    throw new Error(`strict matrix cell ${index} model mismatch: expected ${manifestCell.modelId}; raw report has ${report.modelId ?? 'missing'}`);
  }
  if (report.feedbackLoopPrevention !== manifestCell.feedbackLoopPrevention) {
    throw new Error(`strict matrix cell ${index} route mismatch: expected ${manifestCell.feedbackLoopPrevention}; raw report has ${report.feedbackLoopPrevention ?? 'missing'}`);
  }
  if (report.deviceEvidence?.deviceClass !== manifestCell.deviceClass) {
    throw new Error(`strict matrix cell ${index} device class mismatch: expected ${manifestCell.deviceClass}; raw report has ${report.deviceEvidence?.deviceClass ?? 'missing'}`);
  }
  if (report.deviceEvidence?.profileId !== manifestCell.deviceProfileId) {
    throw new Error(`strict matrix cell ${index} device profile mismatch: expected ${manifestCell.deviceProfileId}; raw report has ${report.deviceEvidence?.profileId ?? 'missing'}`);
  }
}

function assertVirtualDriverBinaryAuthority(runDirectory, runtimeBinaryHashes, index) {
  const driver = readJson(path.join(runDirectory, 'driver.json'));
  const authority = driver.InstalledDriverAuthority ?? driver.installedDriverAuthority;
  if (!authority || typeof authority !== 'object') {
    throw new Error(`strict matrix cell ${index} virtual-driver evidence is missing InstalledDriverAuthority`);
  }
  const packageSys = runtimeBinaryHashes.find(
    (entry) => entry.path === 'drivers/windows-virtual-mic/package/omni-virtual-speaker.sys',
  );
  const packageCat = runtimeBinaryHashes.find(
    (entry) => entry.path === 'drivers/windows-virtual-mic/package/omni-virtual-speaker.cat',
  );
  const packageInf = runtimeBinaryHashes.find(
    (entry) => entry.path === 'drivers/windows-virtual-mic/package/omni-virtual-speaker.inf',
  );
  if (!packageSys || !packageCat || !packageInf) {
    throw new Error(`strict matrix cell ${index} runtime authority is missing the current-HEAD driver SYS/CAT/INF`);
  }
  const installedHash = String(authority.installedSysSha256 ?? '').toLowerCase();
  const packageHash = String(authority.packageSysSha256 ?? '').toLowerCase();
  if (!installedHash || installedHash !== packageHash || packageHash !== packageSys.sha256) {
    throw new Error(`strict matrix cell ${index} installed driver SYS does not match the current-HEAD package`);
  }
  if (
    String(authority.packageCatSha256 ?? '').toLowerCase() !== packageCat.sha256
    || String(authority.packageInfSha256 ?? '').toLowerCase() !== packageInf.sha256
  ) {
    throw new Error(`strict matrix cell ${index} driver CAT/INF identity does not match the current-HEAD package`);
  }
  if (!authority.installedSysPath || !authority.installedInfName || !authority.installedDriverVersion) {
    throw new Error(`strict matrix cell ${index} installed driver identity is incomplete`);
  }
  if (String(authority.installedServiceState ?? '').toLowerCase() !== 'running') {
    throw new Error(`strict matrix cell ${index} installed driver service is not running`);
  }
  if (
    String(authority.installedSysSignatureStatus ?? '').toLowerCase() !== 'valid'
    || String(authority.packageCatalogSignatureStatus ?? '').toLowerCase() !== 'valid'
    || !authority.installedSysSignerThumbprint
    || !authority.packageCatalogSignerThumbprint
    || String(authority.installedSysSignerThumbprint).toLowerCase()
      !== String(authority.packageCatalogSignerThumbprint).toLowerCase()
  ) {
    throw new Error(`strict matrix cell ${index} installed driver/package signature identity is missing or invalid`);
  }
}

function assertRawMediaAuthority(runDirectory, implementationHashes, cell, index) {
  const playback = readJson(path.join(runDirectory, 'playback.json'));
  const canonicalMedia = implementationHashes.find(
    (entry) => entry.path === 'scripts/testing/fixtures/watch-mode-en-original.wav',
  );
  if (!canonicalMedia || playback.mediaSha256 !== canonicalMedia.sha256) {
    throw new Error(`strict matrix cell ${index} playback media hash is not the canonical Watch reference WAV`);
  }
  const playbackStartedAtMs = Number(playback.startedAtMs);
  const playbackFinishedAtMs = Number(playback.finishedAtMs);
  if (
    playback.playbackMode !== 'wasapi-media-injector'
    || !Number.isInteger(Number(playback.injectorProcessId))
    || Number(playback.injectorProcessId) <= 0
    || !Number.isFinite(playbackStartedAtMs)
    || !Number.isFinite(playbackFinishedAtMs)
    || playbackFinishedAtMs <= playbackStartedAtMs
  ) {
    throw new Error(`strict matrix cell ${index} playback.json is not a completed production media-injector timeline`);
  }
  const referencePcmBytes = fs.statSync(path.join(runDirectory, 'source-media-reference-16k-mono.pcm')).size;
  const providerInputBytes = fs.statSync(path.join(runDirectory, 'provider-input-16k-mono.pcm')).size;
  if (referencePcmBytes < 60 * 16_000 * 2 || referencePcmBytes % 2 !== 0) {
    throw new Error(`strict matrix cell ${index} source reference PCM is too short or malformed`);
  }
  if (providerInputBytes < referencePcmBytes || providerInputBytes % 2 !== 0) {
    throw new Error(`strict matrix cell ${index} provider input PCM does not contain the complete reference-media duration`);
  }
  const renderedSeconds = Number(playback.renderedSeconds);
  if (Number.isFinite(renderedSeconds)) {
    const referenceSeconds = referencePcmBytes / (16_000 * 2);
    if (Math.abs(referenceSeconds - renderedSeconds) > 1) {
      throw new Error(`strict matrix cell ${index} source reference PCM duration does not match media-injector renderedSeconds`);
    }
  }
  const device = readJson(path.join(runDirectory, 'physical-playback-device.json'));
  if (device.deviceClass !== cell.deviceClass || device.profileId !== cell.deviceProfileId) {
    throw new Error(`strict matrix cell ${index} raw physical device identity does not match the requested matrix cell`);
  }
  if (cell.feedbackLoopPrevention !== 'echo-cancel') {
    const probe = readJson(path.join(runDirectory, 'physical-output-probe.json'));
    const resolvedProbeId = probe.resolvedPhysicalPlaybackDeviceId
      ?? probe.resolved_physical_playback_device_id;
    if (!resolvedProbeId || resolvedProbeId !== device.resolvedDeviceId) {
      throw new Error(`strict matrix cell ${index} physical-output probe endpoint does not match physical-playback-device.json`);
    }
  }
}

function assertSystemMetricsAuthority(
  runDirectory,
  index,
  minimumDurationMs = MIN_STRICT_SESSION_DURATION_MS,
) {
  const steps = readJson(path.join(runDirectory, 'steps.json'));
  const desktopStep = Array.isArray(steps)
    ? steps.find((step) => step?.name === 'start desktop shell')
    : null;
  const desktopProcessId = Number(desktopStep?.result?.pid);
  const samplerRootProcessId = Number(desktopStep?.result?.systemMetricsSampler?.rootProcessId);
  if (
    desktopStep?.ok !== true
    || !Number.isInteger(desktopProcessId)
    || desktopProcessId <= 0
    || samplerRootProcessId !== desktopProcessId
  ) {
    throw new Error(`strict matrix cell ${index} steps.json does not bind the production Desktop launch PID to its metrics sampler`);
  }

  const metrics = readJson(path.join(runDirectory, 'system-metrics.json'));
  const samples = Array.isArray(metrics.samples) ? metrics.samples : [];
  const startedAtMs = Date.parse(metrics.startedAt ?? '');
  const finishedAtMs = Date.parse(metrics.finishedAt ?? '');
  if (
    metrics.artifactKind !== 'watch-mode-system-metrics'
    || metrics.collector !== 'scripts/testing/collect-watch-mode-system-metrics.ps1'
    || metrics.scope !== 'process-tree'
    || metrics.completionReason !== 'root-process-exited'
    || Number(metrics.rootProcessId) !== desktopProcessId
    || Number(metrics.sampleCount) !== samples.length
    || samples.length < 2
    || !Array.isArray(metrics.collectionErrors)
    || metrics.collectionErrors.length !== 0
    || !Number.isFinite(startedAtMs)
    || !Number.isFinite(finishedAtMs)
    || finishedAtMs - startedAtMs < minimumDurationMs - 15_000
  ) {
    throw new Error(`strict matrix cell ${index} system metrics do not prove the complete production Desktop process-tree lifetime`);
  }

  let previousElapsedMs = -1;
  let previousTimestampMs = startedAtMs - 1;
  for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 1) {
    const sample = samples[sampleIndex];
    const elapsedMs = Number(sample?.elapsedMs);
    const timestampMs = Date.parse(sample?.timestamp ?? '');
    const processIds = Array.isArray(sample?.processIds) ? sample.processIds.map(Number) : [];
    const processNamesById = sample?.processNamesById ?? {};
    const bridgeProcessIds = Array.isArray(sample?.bridgeProcessIds)
      ? sample.bridgeProcessIds.map(Number)
      : [];
    const desktopProcessName = String(
      processNamesById[String(desktopProcessId)]
        ?? processNamesById[desktopProcessId]
        ?? '',
    ).toLowerCase();
    if (
      !Number.isFinite(elapsedMs)
      || elapsedMs <= previousElapsedMs
      || !Number.isFinite(timestampMs)
      || timestampMs <= previousTimestampMs
      || !processIds.includes(desktopProcessId)
      || desktopProcessName !== 'omni-desktop-shell'
      || Number(sample.processCount) !== processIds.length
      || !Number.isFinite(Number(sample.workingSetMb))
      || Number(sample.workingSetMb) <= 0
      || !Number.isFinite(Number(sample.cpuPercent))
      || Number(sample.cpuPercent) < 0
      || bridgeProcessIds.some((processId) => (
        !processIds.includes(processId)
        || String(processNamesById[String(processId)] ?? '').toLowerCase() !== 'omni-bridge-service'
      ))
    ) {
      throw new Error(`strict matrix cell ${index} system metrics sample ${sampleIndex} is not a valid production Desktop process-tree snapshot`);
    }
    previousElapsedMs = elapsedMs;
    previousTimestampMs = timestampMs;
  }
  if (previousElapsedMs < minimumDurationMs - 15_000) {
    throw new Error(`strict matrix cell ${index} system metrics samples do not span the required live window`);
  }
}

function readPcm16Wav(filePath, { collectMono = false } = {}) {
  const bytes = fs.readFileSync(filePath);
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`invalid RIFF/WAVE PCM artifact: ${filePath}`);
  }
  let offset = 12;
  let format = null;
  let dataOffset = -1;
  let dataBytes = 0;
  while (offset + 8 <= bytes.length) {
    const chunkId = bytes.toString('ascii', offset, offset + 4);
    const chunkBytes = bytes.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    if (chunkStart + chunkBytes > bytes.length) break;
    if (chunkId === 'fmt ' && chunkBytes >= 16) {
      format = {
        audioFormat: bytes.readUInt16LE(chunkStart),
        channels: bytes.readUInt16LE(chunkStart + 2),
        sampleRate: bytes.readUInt32LE(chunkStart + 4),
        bitsPerSample: bytes.readUInt16LE(chunkStart + 14),
      };
    } else if (chunkId === 'data') {
      dataOffset = chunkStart;
      dataBytes = chunkBytes;
      break;
    }
    offset = chunkStart + chunkBytes + (chunkBytes % 2);
  }
  if (
    !format
    || format.audioFormat !== 1
    || ![1, 2].includes(format.channels)
    || format.bitsPerSample !== 16
    || dataOffset < 0
  ) {
    throw new Error(`unsupported or incomplete PCM16 WAV artifact: ${filePath}`);
  }
  const bytesPerFrame = format.channels * 2;
  const frames = Math.floor(dataBytes / bytesPerFrame);
  const mono = collectMono ? new Float32Array(frames) : null;
  let sumSquares = 0;
  let peak = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    let mixed = 0;
    const frameOffset = dataOffset + frame * bytesPerFrame;
    for (let channel = 0; channel < format.channels; channel += 1) {
      mixed += bytes.readInt16LE(frameOffset + channel * 2) / 32_768;
    }
    mixed /= format.channels;
    if (mono) mono[frame] = mixed;
    sumSquares += mixed * mixed;
    peak = Math.max(peak, Math.abs(mixed));
  }
  return {
    ...format,
    frames,
    durationSeconds: frames / format.sampleRate,
    rms: frames > 0 ? Math.sqrt(sumSquares / frames) : 0,
    peak,
    mono,
  };
}

function componentAmplitude(samples, sampleRate, frequencyHz) {
  if (!samples || samples.length === 0) return 0;
  const omega = 2 * Math.PI * frequencyHz / sampleRate;
  const coefficient = 2 * Math.cos(omega);
  let previous = 0;
  let beforePrevious = 0;
  for (const sample of samples) {
    const current = sample + coefficient * previous - beforePrevious;
    beforePrevious = previous;
    previous = current;
  }
  const power = previous * previous
    + beforePrevious * beforePrevious
    - coefficient * previous * beforePrevious;
  return 2 * Math.sqrt(Math.max(0, power)) / samples.length;
}

function assertPhysicalRecordingAuthority(runDirectory, index) {
  const wav = readPcm16Wav(path.join(runDirectory, 'physical-output-recording.wav'));
  if (wav.durationSeconds < 60 || wav.rms <= 0.0001 || wav.peak <= 0.001) {
    throw new Error(`strict matrix cell ${index} physical-output WAV is too short or silent`);
  }
  const recording = readJson(path.join(runDirectory, 'physical-output-recording.json'));
  const content = readJson(path.join(runDirectory, 'physical-output-content.json'));
  if (recording.passed !== true || content.passed !== true) {
    throw new Error(`strict matrix cell ${index} physical-output recording/content raw evidence did not pass`);
  }
  const capturedFrames = Number(recording.capturedFrames);
  if (Number.isFinite(capturedFrames) && Math.abs(capturedFrames - wav.frames) > wav.sampleRate) {
    throw new Error(`strict matrix cell ${index} physical-output recording frame count disagrees with its WAV`);
  }
}

function assertProcessExclusionAudioAuthority(runDirectory, index) {
  const probe = readJson(path.join(runDirectory, 'physical-output-probe.json'));
  const evidence = probe.processExclusionFingerprint ?? probe.process_exclusion_fingerprint;
  if (!evidence || typeof evidence !== 'object') {
    throw new Error(`strict matrix cell ${index} process-exclusion fingerprint evidence is missing`);
  }
  const physical = readPcm16Wav(
    path.join(runDirectory, 'physical-output-probe-runtime', 'process-exclusion-physical-output.wav'),
    { collectMono: true },
  );
  const source = readPcm16Wav(
    path.join(runDirectory, 'physical-output-probe-runtime', 'process-exclusion-source-pipe.wav'),
    { collectMono: true },
  );
  if (
    physical.sampleRate !== 48_000
    || source.sampleRate !== 48_000
    || physical.durationSeconds < 1
    || source.durationSeconds < 1
  ) {
    throw new Error(`strict matrix cell ${index} process-exclusion fingerprint WAV format/duration is invalid`);
  }
  const translationHz = Number(evidence.translationFrequencyHz ?? evidence.translation_frequency_hz);
  const externalHz = Number(evidence.externalFrequencyHz ?? evidence.external_frequency_hz);
  const childHz = Number(evidence.bridgeChildFrequencyHz ?? evidence.bridge_child_frequency_hz);
  if (translationHz !== 997 || externalHz !== 1_733 || childHz !== 2_449) {
    throw new Error(`strict matrix cell ${index} process-exclusion fingerprint frequencies are not the production 997/1733/2449 Hz triplet`);
  }
  const physicalTranslation = componentAmplitude(physical.mono, physical.sampleRate, translationHz);
  const physicalExternal = componentAmplitude(physical.mono, physical.sampleRate, externalHz);
  const physicalChild = componentAmplitude(physical.mono, physical.sampleRate, childHz);
  const sourceTranslation = componentAmplitude(source.mono, source.sampleRate, translationHz);
  const sourceExternal = componentAmplitude(source.mono, source.sampleRate, externalHz);
  const sourceChild = componentAmplitude(source.mono, source.sampleRate, childHz);
  const leakLimit = Math.max(0.006, Number(evidence.translationComponentLimit ?? 0.003) * 2);
  if (Math.min(physicalTranslation, physicalExternal, physicalChild, sourceExternal) < 0.005) {
    throw new Error(`strict matrix cell ${index} raw fingerprint WAVs do not prove physical translation/external/child playback and source preservation`);
  }
  if (
    sourceTranslation > leakLimit
    || sourceChild > leakLimit
    || sourceTranslation / physicalTranslation > 0.1
    || sourceChild / physicalChild > 0.1
  ) {
    throw new Error(`strict matrix cell ${index} raw source-pipe WAV contains an excluded Bridge/child fingerprint`);
  }
  const bridgePid = Number(evidence.bridgeProcessId ?? evidence.bridge_process_id);
  const excludedPid = Number(evidence.excludedProcessId ?? evidence.excluded_process_id);
  const externalPid = Number(evidence.externalPlayerProcessId ?? evidence.external_player_process_id);
  const childPid = Number(evidence.bridgeChildPlayerProcessId ?? evidence.bridge_child_player_process_id);
  const childParentPid = Number(evidence.bridgeChildParentProcessId ?? evidence.bridge_child_parent_process_id);
  if (
    !Number.isInteger(bridgePid)
    || bridgePid <= 0
    || excludedPid !== bridgePid
    || childParentPid !== bridgePid
    || externalPid === bridgePid
    || childPid === bridgePid
    || externalPid === childPid
  ) {
    throw new Error(`strict matrix cell ${index} process-exclusion raw PID/parent/excluded identity is invalid`);
  }
  if (
    (evidence.captureBackend ?? evidence.capture_backend) !== 'wasapi-process-exclusion'
    || (evidence.sourceCaptureMode ?? evidence.source_capture_mode) !== 'process-exclusion'
    || (evidence.processLoopbackStatus ?? evidence.process_loopback_status) !== 'ready'
  ) {
    throw new Error(`strict matrix cell ${index} process-exclusion raw probe did not stay on the WASAPI exclusion backend`);
  }
}

function assertCanonicalVerificationBinding({
  manifest,
  evidenceRoot,
  currentProvenance,
  implementationHashes,
  runtimeBinaryHashes,
}) {
  if (manifest.verification !== 'passed') return;
  const receiptPath = validateFileAuthorityEntry(
    evidenceRoot,
    {
      path: manifest.verificationReceiptPath,
      bytes: manifest.verificationReceiptBytes,
      sha256: manifest.verificationReceiptSha256,
    },
    manifest.verificationReceiptPath,
    'canonical strict verification receipt',
  );
  validateFileAuthorityEntry(
    evidenceRoot,
    {
      path: manifest.sourceManifest,
      bytes: manifest.sourceManifestBytes,
      sha256: manifest.sourceManifestSha256,
    },
    manifest.sourceManifest,
    'canonical strict source manifest',
  );
  const receipt = readJson(receiptPath);
  if (
    receipt.schemaVersion !== 1
    || receipt.artifactKind !== STRICT_MATRIX_VERIFICATION_ARTIFACT_KIND
    || receipt.verdict !== 'passed'
    || receipt.sourceManifestPath !== manifest.sourceManifest
    || receipt.sourceManifestBytes !== manifest.sourceManifestBytes
    || receipt.sourceManifestSha256 !== manifest.sourceManifestSha256
    || receipt.verifiedAt !== manifest.verifiedAt
  ) {
    throw new Error('canonical strict verification receipt/source-manifest binding is invalid');
  }
  const provenanceFailure = exactGitProvenanceFailure(
    receipt.provenance,
    currentProvenance,
    {
      recordedSubject: 'canonical strict verification receipt provenance',
      currentSubject: 'current checkout provenance',
    },
  );
  if (provenanceFailure) throw new Error(provenanceFailure);
  if (
    !sameAuthorityInventory(receipt.implementationHashes, implementationHashes)
    || !sameAuthorityInventory(receipt.runtimeBinaryHashes, runtimeBinaryHashes)
  ) {
    throw new Error('canonical strict verification receipt implementation/runtime authority mismatch');
  }
  const expectedCells = manifest.cells.map((cell) => ({
    modelId: cell.modelId,
    feedbackLoopPrevention: cell.feedbackLoopPrevention,
    deviceClass: cell.deviceClass,
    deviceProfileId: cell.deviceProfileId,
    runDirectory: cell.runDirectory,
    receiptPath: cell.receiptPath,
    receiptBytes: cell.receiptBytes,
    receiptSha256: cell.receiptSha256,
  }));
  assertExactObject(receipt.cells, expectedCells, 'canonical strict verification receipt cells');
}

export function verifyStrictMatrixAuthority({
  manifestPath,
  manifest,
  evidenceRoot,
  currentProvenance,
  workspaceRoot = process.cwd(),
  now = Date.now(),
  maxAgeDays = DEFAULT_MAX_EVIDENCE_AGE_DAYS,
  currentRuntimeBinaryHashes = currentAuthorityRuntimeBinaryHashes({ workspaceRoot }),
  releaseCells = LIVE_LLM_CELLS,
  requireLocalIsolation = true,
}) {
  const resolvedRoot = path.resolve(evidenceRoot);
  const resolvedManifestPath = path.resolve(manifestPath);
  if (path.dirname(resolvedManifestPath) !== resolvedRoot) {
    throw new Error(`strict authority manifest must be stored directly in the evidence root: manifest=${resolvedManifestPath} root=${resolvedRoot}`);
  }
  if (
    manifest.schemaVersion !== STRICT_MATRIX_SCHEMA_VERSION
    || manifest.artifactKind !== STRICT_MATRIX_ARTIFACT_KIND
  ) {
    throw new Error(`strict evidence requires ${STRICT_MATRIX_ARTIFACT_KIND} schemaVersion=${STRICT_MATRIX_SCHEMA_VERSION}`);
  }
  const planFailure = balancedReleasePlanFailure(manifest.validationPlan);
  if (planFailure) throw new Error(planFailure);
  if (requireLocalIsolation && (!manifest.localIsolation || typeof manifest.localIsolation !== 'object')) {
    throw new Error('strict evidence requires the zero-LLM local isolation authority');
  }
  if (requireLocalIsolation) {
    const localManifestPath = path.resolve(workspaceRoot, manifest.localIsolation.manifestPath ?? '');
    const localManifestAuthority = fileAuthorityEntry(
      localManifestPath,
      path.basename(localManifestPath),
    );
    if (
      localManifestAuthority.bytes !== manifest.localIsolation.bytes
      || localManifestAuthority.sha256 !== manifest.localIsolation.sha256
    ) throw new Error('strict local isolation manifest hash/size binding mismatch');
    verifyLocalIsolationManifest({
      manifestPath: localManifestPath,
      workspaceRoot,
      provenance: currentProvenance,
      runtimeBinaryHashes: currentRuntimeBinaryHashes,
      reuseAuthority: manifest.localIsolation.reuse ?? null,
    });
  }
  if (manifest.authority?.runner !== MATRIX_RUNNER_ID) {
    throw new Error(`strict authority runner must be ${MATRIX_RUNNER_ID}`);
  }
  if (manifest.authority?.collector !== LIVE_RUN_COLLECTOR_ID) {
    throw new Error(`strict authority collector must be ${LIVE_RUN_COLLECTOR_ID}`);
  }
  const currentImplementationHashes = currentAuthorityImplementationHashes({ workspaceRoot });
  if (!sameAuthorityInventory(manifest.authority?.implementationHashes, currentImplementationHashes)) {
    throw new Error('strict authority runner/collector implementation hashes do not match the current checkout');
  }
  if (!sameAuthorityInventory(manifest.authority?.runtimeBinaryHashes, currentRuntimeBinaryHashes)) {
    throw new Error('strict authority runtime binary hashes do not match the current release build');
  }
  if (!Array.isArray(manifest.cells) || manifest.cells.length === 0) {
    throw new Error('strict authority manifest has no cells');
  }
  if (manifest.cells.length !== manifest.runDirectories?.length) {
    throw new Error('strict authority cells/runDirectories length mismatch');
  }
  if (manifest.cells.length !== releaseCells.length) {
    throw new Error(`strict authority manifest must contain exactly ${releaseCells.length} paid live cells`);
  }
  const manifestGeneratedAtMs = Date.parse(manifest.generatedAt ?? '');
  if (!Number.isFinite(manifestGeneratedAtMs)) {
    throw new Error('strict authority manifest generatedAt is missing or invalid');
  }
  if (manifestGeneratedAtMs > now + 300_000) {
    throw new Error(`strict authority manifest generatedAt is in the future: ${manifest.generatedAt}`);
  }
  const maxAgeMs = Number(maxAgeDays) * 86_400_000;
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
    throw new Error(`strict authority maxAgeDays must be a non-negative number; got ${maxAgeDays}`);
  }
  if (now - manifestGeneratedAtMs > maxAgeMs) {
    throw new Error(`strict authority manifest is stale: generatedAt=${manifest.generatedAt}`);
  }
  if (manifest.verification === 'passed') {
    const verifiedAtMs = Date.parse(manifest.verifiedAt ?? '');
    if (!Number.isFinite(verifiedAtMs) || verifiedAtMs < manifestGeneratedAtMs || verifiedAtMs > now + 300_000) {
      throw new Error('canonical strict authority verifiedAt must be between manifest generation and the current verification time');
    }
  }
  assertCanonicalVerificationBinding({
    manifest,
    evidenceRoot: resolvedRoot,
    currentProvenance,
    implementationHashes: currentImplementationHashes,
    runtimeBinaryHashes: currentRuntimeBinaryHashes,
  });

  const authorizedReports = new Map();
  const runDirectories = [];
  const seenDirectories = new Set();
  for (let index = 0; index < manifest.cells.length; index += 1) {
    const cell = manifest.cells[index];
    const plannedCell = releaseCells[index];
    for (const key of ['cellId', 'tier', 'providerMode', 'durationSeconds', 'modelId', 'feedbackLoopPrevention', 'deviceClass']) {
      if (cell?.[key] !== plannedCell?.[key]) {
        throw new Error(`strict matrix cell ${index} does not match balanced release plan field ${key}`);
      }
    }
    if (cell.runDirectory !== manifest.runDirectories[index]) {
      throw new Error(`strict matrix cell ${index} runDirectory does not match the manifest scope`);
    }
    const runDirectory = resolveAuthorityPath(resolvedRoot, cell.runDirectory, `strict matrix cell ${index} run directory`);
    const directoryIdentity = process.platform === 'win32' ? runDirectory.toLowerCase() : runDirectory;
    if (seenDirectories.has(directoryIdentity)) {
      throw new Error(`strict matrix cell ${index} reuses run directory ${runDirectory}`);
    }
    seenDirectories.add(directoryIdentity);
    const expectedReceiptPath = `${cell.runDirectory.replaceAll('\\', '/')}/${CELL_AUTHORITY_FILE}`;
    const receiptPath = validateFileAuthorityEntry(
      resolvedRoot,
      { path: cell.receiptPath, bytes: cell.receiptBytes, sha256: cell.receiptSha256 },
      expectedReceiptPath,
      `strict matrix cell ${index} receipt`,
    );
    const receipt = readJson(receiptPath);
    if (
      receipt.schemaVersion !== CELL_AUTHORITY_SCHEMA_VERSION
      || receipt.artifactKind !== CELL_AUTHORITY_ARTIFACT_KIND
      || receipt.runner !== MATRIX_RUNNER_ID
      || receipt.collector !== LIVE_RUN_COLLECTOR_ID
    ) {
      throw new Error(`strict matrix cell ${index} receipt was not emitted by the production matrix runner/collector`);
    }
    if (receipt.runDirectory !== cell.runDirectory) {
      throw new Error(`strict matrix cell ${index} receipt runDirectory mismatch`);
    }
    const receiptGeneratedAtMs = Date.parse(receipt.generatedAt ?? '');
    if (!Number.isFinite(receiptGeneratedAtMs) || receiptGeneratedAtMs > manifestGeneratedAtMs) {
      throw new Error(`strict matrix cell ${index} receipt generatedAt must not be later than the matrix manifest`);
    }
    if (now - receiptGeneratedAtMs > maxAgeMs) {
      throw new Error(`strict matrix cell ${index} authority receipt is stale: generatedAt=${receipt.generatedAt}`);
    }
    const provenanceFailure = exactGitProvenanceFailure(
      receipt.provenance,
      currentProvenance,
      {
        recordedSubject: `strict matrix cell ${index} receipt provenance`,
        currentSubject: 'current checkout provenance',
      },
    );
    if (provenanceFailure) throw new Error(provenanceFailure);
    if (!sameAuthorityInventory(receipt.implementationHashes, currentImplementationHashes)) {
      throw new Error(`strict matrix cell ${index} implementation hashes do not match the current checkout`);
    }
    if (!sameAuthorityInventory(receipt.runtimeBinaryHashes, currentRuntimeBinaryHashes)) {
      throw new Error(`strict matrix cell ${index} runtime binary hashes do not match the current release build`);
    }
    const expectedArtifactPaths = requiredCellArtifactPaths(cell.feedbackLoopPrevention);
    if (!Array.isArray(receipt.artifacts) || receipt.artifacts.length !== expectedArtifactPaths.length) {
      throw new Error(`strict matrix cell ${index} raw inventory is incomplete; expected ${expectedArtifactPaths.length} fixed artifacts`);
    }
    for (let artifactIndex = 0; artifactIndex < expectedArtifactPaths.length; artifactIndex += 1) {
      const expectedPath = expectedArtifactPaths[artifactIndex];
      validateFileAuthorityEntry(
        runDirectory,
        receipt.artifacts[artifactIndex],
        expectedPath,
        `strict matrix cell ${index} raw artifact ${expectedPath}`,
      );
    }
    for (const forbiddenPath of forbiddenCellArtifactPaths(cell.feedbackLoopPrevention)) {
      const resolvedForbiddenPath = resolveAuthorityPath(
        runDirectory,
        forbiddenPath,
        `strict matrix cell ${index} forbidden artifact`,
      );
      if (fs.existsSync(resolvedForbiddenPath)) {
        throw new Error(`strict matrix cell ${index} contains forbidden/unbound artifact ${forbiddenPath}`);
      }
    }
    const rebuiltReport = rebuildReportFromDirectory(runDirectory, {
      mode: 'live',
      provenance: receipt.provenance,
    });
    assertSystemMetricsAuthority(runDirectory, index, cell.durationSeconds * 1_000);
    assertRawMediaAuthority(runDirectory, currentImplementationHashes, cell, index);
    if (cell.feedbackLoopPrevention === 'virtual-driver') {
      assertVirtualDriverBinaryAuthority(runDirectory, currentRuntimeBinaryHashes, index);
    }
    if (cell.feedbackLoopPrevention !== 'echo-cancel') {
      assertPhysicalRecordingAuthority(runDirectory, index);
    }
    if (cell.feedbackLoopPrevention === 'process-exclusion') {
      assertProcessExclusionAudioAuthority(runDirectory, index);
    }
    const storedReport = readJson(path.join(runDirectory, 'report.json'));
    assertExactObject(
      reportAuthorityProjection(storedReport),
      reportAuthorityProjection(rebuiltReport),
      `strict matrix cell ${index} report.json`,
    );
    const reportGeneratedAtMs = Date.parse(storedReport.generatedAt ?? '');
    if (!Number.isFinite(reportGeneratedAtMs) || reportGeneratedAtMs > receiptGeneratedAtMs) {
      throw new Error(`strict matrix cell ${index} report generatedAt must not be later than its authority receipt`);
    }
    const systemMetrics = readJson(path.join(runDirectory, 'system-metrics.json'));
    const metricsStartedAtMs = Date.parse(systemMetrics.startedAt ?? '');
    const metricsFinishedAtMs = Date.parse(systemMetrics.finishedAt ?? '');
    if (
      !Number.isFinite(metricsStartedAtMs)
      || !Number.isFinite(metricsFinishedAtMs)
      || metricsFinishedAtMs < metricsStartedAtMs
      || metricsFinishedAtMs > receiptGeneratedAtMs + 300_000
    ) {
      throw new Error(`strict matrix cell ${index} system-metrics time window is missing, inverted, or later than collection`);
    }
    // Reclassification is intentionally fresh, but evidence age must remain
    // anchored to the immutable report/receipt timeline rather than Date.now().
    rebuiltReport.generatedAt = storedReport.generatedAt;
    rebuiltReport.commit = storedReport.commit;
    rebuiltReport.provenance = storedReport.provenance;
    assertCellIdentity(receipt.matrixCell, cell, rebuiltReport, index);
    runDirectories.push(runDirectory);
    authorizedReports.set(directoryIdentity, rebuiltReport);
  }
  return {
    runDirectories,
    authorizedReports,
    implementationHashes: currentImplementationHashes,
    runtimeBinaryHashes: currentRuntimeBinaryHashes,
  };
}

function parseDirectoryTimestamp(name) {
  const match = name.match(/^(\d{8})-(\d{6})(?:-.+)?$/);
  if (!match) return null;
  const [, date, time] = match;
  return Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(4, 6)) - 1,
    Number(date.slice(6, 8)),
    Number(time.slice(0, 2)),
    Number(time.slice(2, 4)),
    Number(time.slice(4, 6)),
  );
}

function evidenceSortTime(entry) {
  const generatedAtMs = Date.parse(entry.report.generatedAt ?? '');
  if (Number.isFinite(generatedAtMs)) return generatedAtMs;
  const directoryTimestamp = parseDirectoryTimestamp(entry.directoryName);
  if (directoryTimestamp !== null) return directoryTimestamp;
  return entry.reportMtimeMs;
}

function isExcludedDirectory(directoryName) {
  return EXCLUDED_DIRECTORY_PATTERNS.some((pattern) => pattern.test(directoryName));
}

function reportFeedbackMode(report) {
  const mode = report?.feedbackLoopPrevention;
  return mode === 'echo-cancel' || mode === 'process-exclusion' ? mode : 'virtual-driver';
}

function requiredLayersFor(options = {}, feedbackMode = 'virtual-driver') {
  if (feedbackMode === 'echo-cancel') return ECHO_CANCEL_REQUIRED_LAYERS;
  if (feedbackMode === 'process-exclusion') {
    return options.strict
      ? PROCESS_EXCLUSION_REQUIRED_LAYERS
      : PROCESS_EXCLUSION_REQUIRED_LAYERS.filter((layer) => layer !== 'strictContent');
  }
  return options.strict ? REQUIRED_LAYERS : BASE_REQUIRED_LAYERS;
}

function hasRequiredLayerShape(report, options = {}) {
  return missingRequiredLayers(report, options).length === 0;
}

function missingRequiredLayers(report, options = {}) {
  return requiredLayersFor(options, reportFeedbackMode(report)).filter((layer) => !report.layers?.[layer]?.status);
}

function reportModelId(report) {
  return report.modelId ?? report.layers?.strictContent?.data?.modelId ?? null;
}

function strictContentFailure(report) {
  const strict = report.layers?.strictContent;
  if (!strict) return 'strictContent layer is missing';
  if (strict.status !== 'passed') return strict.reason ?? 'strictContent layer did not pass';
  if (strict.data?.applicable !== true) return 'strictContent gate was not applicable to this report';
  if (strict.data?.passed !== true) return strict.data?.reason ?? 'strictContent data did not pass';
  return null;
}

export function strictWatchSessionReportFailure(report, minimumDurationMs = MIN_STRICT_SESSION_DURATION_MS) {
  const watch = report?.watchSessionReport;
  if (!watch) return 'strict evidence requires a saved watchSessionReport';
  if (watch.status !== 'completed') {
    return `watchSessionReport status is ${watch.status ?? 'unknown'}, expected completed`;
  }
  const elapsedMs = Number(watch.elapsedMs);
  const summaryDurationMs = Number(watch.summary?.durationMs);
  if (!Number.isFinite(elapsedMs) || !Number.isFinite(summaryDurationMs)) {
    return 'watchSessionReport must include numeric elapsedMs and summary.durationMs';
  }
  if (elapsedMs < minimumDurationMs || summaryDurationMs < minimumDurationMs) {
    return `watchSessionReport duration is too short: elapsedMs=${elapsedMs} summary.durationMs=${summaryDurationMs} minimum=${minimumDurationMs}`;
  }
  if (Math.abs(elapsedMs - summaryDurationMs) > 1_000) {
    return `watchSessionReport duration fields disagree: elapsedMs=${elapsedMs} summary.durationMs=${summaryDurationMs}`;
  }
  const cues = Array.isArray(watch.cues) ? watch.cues : [];
  const completeCues = cues.filter((cue) => (
    cue.comparisonStatus !== 'superseded'
    && Number.isFinite(Number(cue.llmFirstAtMs))
    && Number.isFinite(Number(cue.publishedFirstAtMs))
    && Number.isFinite(Number(cue.renderedFirstAtMs))
    && Number(cue.llmFirstToRenderMs) >= 0
    && Number(cue.publishToRenderMs) >= 0
  ));
  if (completeCues.length === 0) {
    return 'watchSessionReport has no complete model → publish → visible-render cue';
  }
  if (Number(watch.summary?.unrenderedCueCount ?? 0) > 0) {
    return `watchSessionReport has ${watch.summary.unrenderedCueCount} published cue(s) without visible rendering`;
  }
  const invalid = cues.find((cue) => {
    // Superseded revisions remain in the report as diagnostic history. Only
    // the selected logical revision can determine the strict app verdict;
    // retain the older retry/error events without treating them as active
    // output failures.
    if (cue?.comparisonStatus === 'superseded') return false;
    const issues = Array.isArray(cue.issues) ? cue.issues : [];
    const recoveredRetryOnly = ['exact', 'formatting-only'].includes(cue?.comparisonStatus)
      && Number.isFinite(Number(cue?.llmFirstAtMs))
      && Number.isFinite(Number(cue?.publishedFirstAtMs))
      && Number.isFinite(Number(cue?.renderedFirstAtMs))
      && issues.length > 0
      && issues.every((issue) => issue?.code === 'retry-exhausted');
    if (recoveredRetryOnly) return false;
    // A capture may stop while the provider still has an unfinished source
    // hypothesis. Keep that interruption explicit in the exported report,
    // but do not treat it as a model/publish/render failure in the strict
    // long-chain gate. The report builder only emits this code when it has no
    // completed source evidence (or the update landed immediately before
    // stop), so real no-output errors remain blocking.
    const interruptedSourceTail = cue.comparisonStatus === 'not-published'
      && issues.length > 0
      && issues.every((issue) => (
        issue?.category === 'session'
        && issue?.code === 'session-ended-before-model-output'
        && issue?.severity === 'warning'
      ));
    if (interruptedSourceTail) return false;
    return ['different', 'not-published', 'not-rendered', 'model-error'].includes(cue.comparisonStatus)
      || issues.length > 0;
  });
  if (invalid) {
    return `watchSessionReport has an explicit issue for cue=${invalid.cueId ?? '-'} comparison=${invalid.comparisonStatus ?? '-'}`;
  }
  return null;
}

export function strictAecScenarioFailure(report) {
  if (report?.mode !== 'live') return 'AEC strict evidence must come from a live run';
  const aec = report?.layers?.aec?.data;
  if (!aec) return 'AEC strict evidence is missing layers.aec.data';
  if (report.layers.aec.status !== 'passed') {
    return report.layers.aec.reason ?? 'AEC layer did not pass';
  }
  const scenario = aec.liveScenario;
  if (!scenario || scenario.completed !== true) {
    return 'AEC strict evidence requires a completed live double-talk, dynamic-delay, and nonlinear scenario';
  }
  if (scenario.evidenceMode !== 'live' || scenario.fixtureOnly !== false) {
    return 'AEC strict scenario is fixture/simulated evidence rather than live physical-render evidence';
  }
  if (scenario.timelineBoundToPlayback !== true) {
    return 'AEC strict scenario is not bound to the real reference-media playback timeline';
  }
  const playback = scenario.playback ?? {};
  if (
    playback.actualPlayback !== true
    || String(playback.mediaSha256 ?? '').toLowerCase()
      !== 'cf4990ecdc23622d12de3e62adad442755c9e84c4612787798655ee00c85fb2f'
    || !Number.isInteger(Number(playback.processId))
    || Number(playback.processId) <= 0
    || !Number.isFinite(Number(playback.startedAtMs))
    || !Number.isFinite(Number(playback.finishedAtMs))
    || Number(playback.finishedAtMs) <= Number(playback.startedAtMs)
  ) {
    return 'AEC strict scenario lacks the actual reference-media injector identity, hash, and playback timestamps';
  }
  const stages = scenario.stages ?? {};
  const expectedStages = [
    ['doubleTalk', 'double-talk', 1, 0, 'none', false],
    ['dynamicDelay', 'dynamic-delay', 2, 80, 'none', false],
    ['nonlinear', 'nonlinear', 3, 160, 'soft-clip', true],
  ];
  for (const [key, name, ordinal, delayMs, nonlinearity, nonlinearExpected] of expectedStages) {
    const stage = stages[key];
    const referenceFrames = Number(stage?.referenceFrames);
    const physicalFrames = Number(stage?.physicalFrames);
    const changedSamples = Number(stage?.changedSamples);
    const changedRatio = Number(stage?.changedRatio);
    const expectedPrefixFrames = Math.round(delayMs * 48_000 / 1_000);
    const physicalPcmMatchesStage = (
      physicalFrames - referenceFrames === expectedPrefixFrames
      && (nonlinearExpected
        ? changedSamples > 0 && changedRatio > 0 && changedRatio <= 1
        : changedSamples === 0 && changedRatio === 0)
    );
    if (
      stage?.status !== 'completed'
      || stage.stage !== name
      || Number(stage.ordinal) !== ordinal
      || Number(stage.delayMs) !== delayMs
      || stage.nonlinearity !== nonlinearity
      || stage.source !== 'runtime-physical-render'
      || !['native-omni', 'subtitle-tts'].includes(stage.playbackSource)
      || String(stage.started) !== 'true'
      || String(stage.completed) !== 'true'
      || referenceFrames <= 0
      || physicalFrames <= 0
      || !physicalPcmMatchesStage
      || !Number.isFinite(Number(stage.startedAtMs))
      || Number(stage.completedAtMs) < Number(stage.startedAtMs)
    ) {
      return `AEC strict scenario stage ${name} is missing real physical-render lifecycle evidence`;
    }
  }
  if (!Number.isFinite(Number(aec.maxDoubleTalkFrames)) || Number(aec.maxDoubleTalkFrames) <= 0) {
    return `AEC strict double-talk telemetry did not increase: doubleTalkFrames=${aec.maxDoubleTalkFrames ?? 'missing'}`;
  }
  if (
    !Number.isFinite(Number(aec.minReportedDelayMs))
    || !Number.isFinite(Number(aec.maxReportedDelayMs))
    || Number(aec.minReportedDelayMs) < 0
    || Number(aec.maxReportedDelayMs) > 1000
    || Number(aec.reportedDelaySpanMs) < 10
  ) {
    return `AEC strict delay telemetry did not prove a bounded dynamic change: minimum=${aec.minReportedDelayMs ?? 'missing'} maximum=${aec.maxReportedDelayMs ?? 'missing'} span=${aec.reportedDelaySpanMs ?? 'missing'}`;
  }
  if (Number(aec.asrDeletedChunkMetricCount) <= 0) {
    return 'AEC strict evidence is missing the explicit asrDeletedChunks metric';
  }
  if (Number(aec.maxAsrDeletedChunks) !== 0) {
    return `AEC strict evidence deleted ASR capture chunks: asrDeletedChunks=${aec.maxAsrDeletedChunks ?? 'missing'}`;
  }
  const expectedSubtitles = scenario.expectedSubtitles ?? {};
  if (
    expectedSubtitles.referenceSource !== 'watch-mode-en-original-transcript'
    || expectedSubtitles.acceptedSource !== 'watch-session-report-cues'
    || !String(expectedSubtitles.watchSessionId ?? '')
    || !Array.isArray(expectedSubtitles.acceptedCueIds)
    || expectedSubtitles.acceptedCueIds.length !== Number(expectedSubtitles.acceptedCueCount)
    || Number(expectedSubtitles.acceptedCueCount) <= 0
    || Number(expectedSubtitles.expectedSegmentCount) <= 0
    || Number(expectedSubtitles.acceptedSegmentCount) !== Number(expectedSubtitles.expectedSegmentCount)
    || Number(expectedSubtitles.acceptanceRate) !== 1
  ) {
    return `AEC strict evidence did not accept 100% of expected subtitle segments: accepted=${expectedSubtitles.acceptedSegmentCount ?? 0}/${expectedSubtitles.expectedSegmentCount ?? 0}`;
  }
  return null;
}

export function strictProcessExclusionRestartFailure(
  report,
  minimumDurationMs = MIN_STRICT_SESSION_DURATION_MS,
) {
  if (report?.mode !== 'live') return 'process-exclusion restart evidence must come from a live run';
  const restart = report?.layers?.bridge?.data?.processExclusionRestart;
  if (!restart || restart.completed !== true) {
    return 'process-exclusion strict evidence requires a completed controlled Bridge restart';
  }
  if (restart.evidenceMode !== 'live' || restart.fixtureOnly !== false) {
    return 'process-exclusion Bridge restart is fixture/simulated evidence rather than live evidence';
  }
  if (
    restart.identityChanged !== true
    || Number(restart.oldBridgeProcessId) <= 0
    || Number(restart.newBridgeProcessId) <= 0
    || Number(restart.oldBridgeProcessId) === Number(restart.newBridgeProcessId)
    || !restart.oldBridgeInstanceId
    || !restart.newBridgeInstanceId
    || restart.oldBridgeInstanceId === restart.newBridgeInstanceId
    || !restart.oldSessionId
    || !restart.newSessionId
    || restart.oldSessionId === restart.newSessionId
    || !String(restart.oldSourceGeneration ?? '')
    || !String(restart.newSourceGeneration ?? '')
    || String(restart.oldSourceGeneration) === String(restart.newSourceGeneration)
    || !restart.oldSourceGenerationToken
    || !restart.newSourceGenerationToken
    || restart.oldSourceGenerationToken === restart.newSourceGenerationToken
  ) {
    return 'process-exclusion restart did not prove a new Bridge PID, session, generation, and generation token';
  }
  if (
    restart.frameContinuity !== true
    || Number(restart.sourceFramesBefore) <= 0
    || Number(restart.sourceFramesAfter) <= 0
    || Number(restart.newFirstFrameTimestampMs) <= Number(restart.oldLastFrameTimestampMs)
    || Number(restart.newFirstFrameReadTimestampMs) <= Number(restart.oldLastFrameReadTimestampMs)
    || Number(restart.oldFramesAfterRestart) !== 0
  ) {
    return 'process-exclusion restart did not prove continuous new-source frames and zero old-generation frames';
  }
  if (
    restart.runtimeReady !== true
    || restart.captureBackend !== 'wasapi-process-exclusion'
    || restart.processLoopbackStatus !== 'ready'
    || restart.sourceSubscriberActive !== true
    || Number(restart.excludedProcessId) !== Number(restart.newBridgeProcessId)
  ) {
    return 'process-exclusion restart did not restore ready WASAPI exclusion targeting the new Bridge PID';
  }
  if (
    restart.timingValid !== true
    || !Number.isFinite(Number(restart.startedAtMs))
    || !Number.isFinite(Number(restart.restartTriggeredAtMs))
    || !Number.isFinite(Number(restart.recoveredAtMs))
    || Number(restart.startedAtMs) > Number(restart.oldLastFrameReadTimestampMs)
    || Number(restart.oldLastFrameReadTimestampMs) > Number(restart.restartTriggeredAtMs)
    || Number(restart.restartTriggeredAtMs) > Number(restart.newFirstFrameReadTimestampMs)
    || Number(restart.newFirstFrameReadTimestampMs) > Number(restart.recoveredAtMs)
    || Number(restart.recoveredAtMs) < Number(restart.restartTriggeredAtMs)
    || Number(restart.downtimeMs) > 15_000
  ) {
    return 'process-exclusion restart timing is missing, invalid, or exceeded 15 seconds';
  }
  const metrics = restart.systemMetrics ?? {};
  const metricsStartedAtMs = Date.parse(metrics.startedAt ?? '');
  const metricsFinishedAtMs = Date.parse(metrics.finishedAt ?? '');
  const metricsWallDurationMs = metricsFinishedAtMs - metricsStartedAtMs;
  const restartOffsetMs = Number(restart.restartTriggeredAtMs) - metricsStartedAtMs;
  if (
    restart.metricsProveTransition !== true
    || metrics.valid !== true
    || Number(metrics.durationMs) < minimumDurationMs - 15_000
    || !Number.isFinite(metricsWallDurationMs)
    || metricsWallDurationMs < minimumDurationMs - 15_000
    || Number(metrics.samplesWithOldPid) <= 0
    || Number(metrics.samplesWithNewPid) <= 0
    || metrics.oldPidAbsentAfterNew !== true
    || restartOffsetMs < metricsWallDurationMs * 0.35
    || restartOffsetMs > metricsWallDurationMs * 0.65
  ) {
    return 'process-exclusion restart is not corroborated near the midpoint of the required real process-tree metrics timeline';
  }
  return null;
}

function inferredDeviceClass(deviceEvidence) {
  const classificationText = [
    deviceEvidence?.resolvedDeviceId,
    deviceEvidence?.resolvedDeviceName,
    ...(Array.isArray(deviceEvidence?.classificationSignals)
      ? deviceEvidence.classificationSignals
      : []),
  ].filter(Boolean).join(' ').toLowerCase();
  if (/bluetooth|\bbth(?:enum|hf|a2dp)?\b|a2dp|hands[ -]?free/.test(classificationText)) {
    return 'bluetooth';
  }
  if (/\busb\b|usb[\\#_-]|vid_[0-9a-f]{4}/.test(classificationText)) {
    return 'usb';
  }
  return classificationText.trim() ? 'default-speaker' : null;
}

export function strictDeviceEvidenceFailure(report, expectedDeviceClass = null) {
  const evidence = report?.deviceEvidence;
  if (!evidence || typeof evidence !== 'object') {
    return 'strict device matrix requires report.deviceEvidence';
  }
  const requiredStrings = [
    'profileId',
    'deviceClass',
    'requestedDeviceId',
    'resolvedDeviceId',
    'resolvedDeviceName',
    'classificationSource',
    'routeEvidenceSource',
  ];
  const missing = requiredStrings.filter((field) => (
    typeof evidence[field] !== 'string' || !evidence[field].trim()
  ));
  if (missing.length > 0) {
    return `deviceEvidence is missing required field(s): ${missing.join(',')}`;
  }
  if (!DEFAULT_STRICT_DEVICE_CLASSES.includes(evidence.deviceClass)) {
    return `deviceEvidence has unsupported deviceClass=${evidence.deviceClass}`;
  }
  if (evidence.verified !== true || evidence.fixtureOnly === true) {
    return `deviceEvidence is not verified live endpoint evidence: verified=${evidence.verified} fixtureOnly=${evidence.fixtureOnly}`;
  }
  const inferred = inferredDeviceClass(evidence);
  if (inferred !== evidence.deviceClass) {
    return `deviceEvidence classification mismatch: declared=${evidence.deviceClass} inferred=${inferred ?? 'unknown'}`;
  }
  if (expectedDeviceClass && evidence.deviceClass !== expectedDeviceClass) {
    return `deviceEvidence class mismatch: expected=${expectedDeviceClass} actual=${evidence.deviceClass}`;
  }
  return null;
}

/** Strict evidence must be recent and produced from the exact clean HEAD. */
export const DEFAULT_MAX_EVIDENCE_AGE_DAYS = 14;

/**
 * Strict-mode latency gate: threshold starting points come from historical
 * passing evidence reports (full runs measured firstVisible<=7s and
 * firstFinal<=7s; the live report generator already rejects secondary runs
 * above 8s/15s, so the evidence gate starts at those documented bounds).
 * firstTtsQueued/firstPlayback only have a non-representative 12s short
 * sample (1s/2s) as history, so they default to null and are asserted only
 * when configured via --latency-thresholds.
 */
export const DEFAULT_STRICT_LATENCY_THRESHOLDS = {
  firstVisibleTranslationLatencySeconds: 8,
  firstFinalTranslationLatencySeconds: 15,
  firstTtsQueuedLatencySeconds: null,
  firstPlaybackLatencySeconds: null,
};

export function normalizeLatencyThresholds(value) {
  const thresholds = { ...DEFAULT_STRICT_LATENCY_THRESHOLDS };
  if (value == null || value === true) return thresholds;
  const entries = typeof value === 'string'
    ? value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => item.split('=').map((part) => part.trim()))
    : Object.entries(value);
  for (const [field, raw] of entries) {
    if (!(field in thresholds)) {
      throw new Error(`unknown latency threshold field: ${field}; expected one of ${Object.keys(thresholds).join(', ')}`);
    }
    if (raw == null || raw === 'off' || raw === 'none') {
      thresholds[field] = null;
      continue;
    }
    const numeric = Number(raw);
    if (!Number.isFinite(numeric) || numeric < 0) {
      throw new Error(`invalid latency threshold for ${field}: ${raw} (expected a non-negative number of seconds, or off)`);
    }
    thresholds[field] = numeric;
  }
  return thresholds;
}

/**
 * Rejects a passed report whose produced latency fields exceed the configured
 * thresholds. Fields that the run did not produce are not asserted; the
 * failure reason always carries the measured value.
 */
export function strictLatencyFailure(report, options = {}) {
  const thresholds = normalizeLatencyThresholds(options.latencyThresholds);
  const subtitleQueue = report.layers?.app?.data?.subtitleQueue;
  if (!subtitleQueue) return null;
  const violations = [];
  for (const [field, threshold] of Object.entries(thresholds)) {
    if (threshold == null) continue;
    const measured = Number(subtitleQueue[field]);
    if (!Number.isFinite(measured)) continue;
    if (measured > threshold) {
      violations.push(`${field}=${measured}s exceeds the ${threshold}s threshold`);
    }
  }
  if (violations.length === 0) return null;
  return `latency evidence exceeded threshold(s): ${violations.join('; ')} (adjust with --latency-thresholds field=seconds)`;
}

/**
 * Strict-mode provenance gate: a passed report is still rejected when it is
 * older than the age budget or was not produced by the exact clean checkout
 * currently being verified. Ancestor commits and dirty/untracked source state
 * are intentionally insufficient release evidence.
 */
export function strictProvenanceFailure(report, options = {}) {
  const now = options.now ?? Date.now();
  const maxAgeDays = Number(options.maxAgeDays ?? DEFAULT_MAX_EVIDENCE_AGE_DAYS);
  const generatedAtMs = Date.parse(report.generatedAt ?? '');
  if (!Number.isFinite(generatedAtMs)) {
    return 'strict evidence requires a parseable generatedAt timestamp';
  }
  const ageDays = (now - generatedAtMs) / 86_400_000;
  if (ageDays > maxAgeDays) {
    return `evidence is stale: generatedAt=${report.generatedAt} age=${ageDays.toFixed(1)}d exceeds the ${maxAgeDays}d budget; re-run the live matrix`;
  }
  const currentProvenance = options.currentProvenance ?? currentGitProvenance({
    cwd: options.workspaceRoot ?? process.cwd(),
  });
  const provenanceFailure = exactGitProvenanceFailure(
    report.provenance,
    currentProvenance,
    {
      recordedSubject: 'report.provenance',
      currentSubject: 'current checkout provenance',
    },
  );
  if (provenanceFailure) return provenanceFailure;
  const legacyCommit = typeof report.commit === 'string' && report.commit.trim()
    ? report.commit.trim()
    : null;
  if (legacyCommit && legacyCommit !== report.provenance.headCommit.trim()) {
    return `report.commit ${legacyCommit} disagrees with report.provenance.headCommit ${report.provenance.headCommit.trim()}`;
  }
  return null;
}

export function strictManifestProvenanceFailure(manifest, options = {}) {
  const currentProvenance = options.currentProvenance ?? currentGitProvenance({
    cwd: options.workspaceRoot ?? process.cwd(),
  });
  const sourceFailure = exactGitProvenanceFailure(
    manifest?.provenance,
    currentProvenance,
    {
      recordedSubject: 'run manifest provenance',
      currentSubject: 'current checkout provenance',
    },
  );
  if (sourceFailure) return sourceFailure;
  if (manifest?.verification === 'passed') {
    return exactGitProvenanceFailure(
      manifest.verificationProvenance,
      currentProvenance,
      {
        recordedSubject: 'canonical manifest verificationProvenance',
        currentSubject: 'current checkout provenance',
      },
    );
  }
  return null;
}

function basicFailure(entry, options = {}) {
  const feedbackMode = entry.feedbackMode ?? reportFeedbackMode(entry.report);
  const failedLayers = requiredLayersFor(options, feedbackMode).filter(
    (layer) => entry.report.layers?.[layer]?.status !== 'passed',
  );
  const latestFailure = describeLatestFailure(entry, failedLayers, options);
  if (entry.report.verdict !== 'passed' || failedLayers.length > 0) {
    return {
      failedLayers,
      latestFailure,
      reason: [
        `verdict=${entry.report.verdict ?? 'unknown'}`,
        `failureLayer=${entry.report.failureLayer ?? '-'}`,
        `failureReason=${latestFailure.failureReason ?? '-'}`,
        `failedLayers=${failedLayers.join(',') || '-'}`,
      ].join(' '),
    };
  }
  if (options.strict && feedbackMode !== 'echo-cancel') {
    const reason = strictContentFailure(entry.report);
    if (reason) {
      return {
        failedLayers: ['strictContent'],
        latestFailure: describeLatestFailure(entry, ['strictContent'], options, reason),
        reason,
      };
    }
  }
  if (options.strict) {
    const watchReportReason = strictWatchSessionReportFailure(
      entry.report,
      options.minimumDurationMs,
    );
    if (watchReportReason) {
      return {
        failedLayers: ['watchSessionReport'],
        latestFailure: describeLatestFailure(entry, ['watchSessionReport'], options, watchReportReason),
        reason: watchReportReason,
      };
    }
    const scenarioReason = feedbackMode === 'echo-cancel'
      ? strictAecScenarioFailure(entry.report)
      : feedbackMode === 'process-exclusion'
        ? strictProcessExclusionRestartFailure(entry.report, options.minimumDurationMs)
        : null;
    if (scenarioReason) {
      const failedLayer = feedbackMode === 'echo-cancel' ? 'aecScenario' : 'processExclusionRestart';
      return {
        failedLayers: [failedLayer],
        latestFailure: describeLatestFailure(entry, [failedLayer], options, scenarioReason),
        reason: scenarioReason,
      };
    }
    if (options.expectedDeviceClass) {
      const deviceReason = strictDeviceEvidenceFailure(
        entry.report,
        options.expectedDeviceClass,
      );
      if (deviceReason) {
        return {
          failedLayers: ['deviceEvidence'],
          latestFailure: describeLatestFailure(entry, ['deviceEvidence'], options, deviceReason),
          reason: deviceReason,
        };
      }
    }
    const provenanceReason = strictProvenanceFailure(entry.report, options);
    if (provenanceReason) {
      return {
        failedLayers: ['provenance'],
        latestFailure: describeLatestFailure(entry, ['provenance'], options, provenanceReason),
        reason: provenanceReason,
      };
    }
    const latencyReason = strictLatencyFailure(entry.report, options);
    if (latencyReason) {
      return {
        failedLayers: ['latency'],
        latestFailure: describeLatestFailure(entry, ['latency'], options, latencyReason),
        reason: latencyReason,
      };
    }
  }
  return { failedLayers: [], reason: null, latestFailure: null };
}

function invalidCandidateReason(entry) {
  if (!entry) return null;
  if (entry.scopeError) {
    return `scoped Watch Mode report is invalid: ${entry.scopeError} reportPath=${entry.reportPath}`;
  }
  if (entry.parseError) {
    return `latest live report could not be parsed: ${entry.parseError} reportPath=${entry.reportPath}`;
  }
  if (entry.incomplete) {
    const deviceDetail = entry.deviceEvidenceFailure
      ? ` deviceEvidenceFailure=${entry.deviceEvidenceFailure}`
      : '';
    return `latest live report is incomplete: missingLayers=${entry.missingLayers.join(',')}${deviceDetail} reportPath=${entry.reportPath}`;
  }
  return null;
}

function uniqueTail(lines, limit = 12) {
  const output = [];
  const seen = new Set();
  for (const line of lines.filter(Boolean).reverse()) {
    const key = String(line);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(key);
    if (output.length >= limit) break;
  }
  return output.reverse();
}

function describeLatestFailure(entry, failedLayers = [], options = {}, fallbackReason = null) {
  const report = entry.report ?? {};
  const diagnostics = report.diagnostics ?? {};
  const evidence = diagnostics.evidence ?? {};
  const strict = report.layers?.strictContent?.data;
  return {
    reportPath: entry.reportPath,
    directoryName: entry.directoryName,
    modelId: entry.modelId ?? null,
    failureLayer: report.failureLayer ?? null,
    failureReason: report.failureReason
      ?? fallbackReason
      ?? report.layers?.[report.failureLayer]?.reason
      ?? null,
    failedLayers,
    failedSteps: diagnostics.failedSteps ?? [],
    checkFailures: diagnostics.checkFailures ?? [],
    keyEvidence: uniqueTail([
      ...(evidence.appErrors ?? []),
      ...(evidence.providerErrors ?? evidence.appProviderErrors ?? []),
      ...(evidence.appOmniPreconnect ?? []),
      ...(evidence.appReadiness ?? []),
      ...(evidence.bridgeErrors ?? []),
      ...(evidence.bridgeSourceSummary ?? []),
      ...(evidence.bridgeWatchdog ?? []),
      ...(strict?.failures ?? []),
    ], 16),
  };
}

function describeInvalidCandidate(entry) {
  const failureReason = invalidCandidateReason(entry);
  const diagnostics = entry.report?.diagnostics ?? {};
  return {
    reportPath: entry.reportPath,
    directoryName: entry.directoryName,
    modelId: entry.modelId ?? null,
    failureLayer: entry.report?.failureLayer ?? 'evidence',
    failureReason,
    failedLayers: entry.missingLayers ?? [],
    failedSteps: diagnostics.failedSteps ?? [],
    checkFailures: diagnostics.checkFailures ?? [],
    keyEvidence: uniqueTail([
      entry.scopeError ? `scopeError=${entry.scopeError}` : null,
      entry.parseError ? `parseError=${entry.parseError}` : null,
      entry.incomplete ? `missingLayers=${entry.missingLayers.join(',')}` : null,
      ...(diagnostics.evidence?.appErrors ?? []),
      ...(diagnostics.evidence?.providerErrors ?? diagnostics.evidence?.appProviderErrors ?? []),
      ...(diagnostics.evidence?.appOmniPreconnect ?? []),
      ...(diagnostics.evidence?.appReadiness ?? []),
    ], 16),
  };
}

function invalidScopedCandidate(directoryPath, reportPath, options, scopeError) {
  return {
    directoryName: path.basename(directoryPath),
    reportPath,
    report: {
      verdict: 'failed',
      failureLayer: 'evidence',
      generatedAt: null,
      translationRoute: null,
      layers: {},
    },
    reportMtimeMs: fs.existsSync(reportPath) ? fs.statSync(reportPath).mtimeMs : 0,
    modelId: null,
    feedbackMode: 'virtual-driver',
    deviceClass: null,
    deviceEvidenceFailure: null,
    complete: false,
    incomplete: false,
    missingLayers: requiredLayersFor(options),
    scopeError,
  };
}

function loadCandidateDirectory(root, directoryPath, options, scoped) {
  const directoryName = path.relative(root, directoryPath) || path.basename(directoryPath);
  const reportPath = path.join(directoryPath, 'report.json');
  if (!fs.existsSync(directoryPath) || !fs.statSync(directoryPath).isDirectory()) {
    return scoped
      ? invalidScopedCandidate(directoryPath, reportPath, options, 'run directory does not exist')
      : null;
  }
  if (!fs.existsSync(reportPath)) {
    return scoped
      ? invalidScopedCandidate(directoryPath, reportPath, options, 'run directory is missing report.json')
      : null;
  }
  try {
    const directoryIdentity = process.platform === 'win32'
      ? path.resolve(directoryPath).toLowerCase()
      : path.resolve(directoryPath);
    const report = options.authorizedReports?.get(directoryIdentity) ?? readJson(reportPath);
    const stats = fs.statSync(reportPath);
    if (report.mode !== 'live') {
      return scoped
        ? invalidScopedCandidate(
            directoryPath,
            reportPath,
            options,
            `report mode=${report.mode ?? 'missing'} is non-live and cannot satisfy live evidence`,
          )
        : null;
    }
    const missingLayers = missingRequiredLayers(report, options);
    const deviceEvidenceFailure = options.requireDeviceEvidence
      ? strictDeviceEvidenceFailure(report)
      : null;
    if (deviceEvidenceFailure) missingLayers.push('deviceEvidence');
    return {
      directoryName,
      reportPath,
      report,
      reportMtimeMs: stats.mtimeMs,
      modelId: reportModelId(report),
      feedbackMode: reportFeedbackMode(report),
      deviceClass: report.deviceEvidence?.deviceClass ?? null,
      deviceEvidenceFailure,
      complete: missingLayers.length === 0,
      incomplete: missingLayers.length > 0,
      missingLayers,
    };
  } catch (error) {
    return {
      ...invalidScopedCandidate(directoryPath, reportPath, options, null),
      directoryName,
      parseError: error instanceof Error ? error.message : String(error),
      scopeError: undefined,
    };
  }
}

function loadCandidates(root, options = {}) {
  if (!fs.existsSync(root)) return [];
  const scoped = Array.isArray(options.runDirectories);
  const directories = scoped
    ? options.runDirectories
    : fs
        .readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .filter((entry) => !isExcludedDirectory(entry.name))
        .map((entry) => path.join(root, entry.name));
  return directories
    .map((directoryPath) => loadCandidateDirectory(root, directoryPath, options, scoped))
    .filter(Boolean)
    .sort((left, right) => {
      const timeDiff = evidenceSortTime(right) - evidenceSortTime(left);
      return timeDiff || right.directoryName.localeCompare(left.directoryName);
    });
}

function normalizeModels(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value !== 'string' || !value.trim()) return [];
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

export function normalizeDeviceClasses(value) {
  const classes = normalizeModels(value);
  for (const deviceClass of classes) {
    if (!DEFAULT_STRICT_DEVICE_CLASSES.includes(deviceClass)) {
      throw new Error(
        `unsupported device class '${deviceClass}'; expected ${DEFAULT_STRICT_DEVICE_CLASSES.join(',')}`,
      );
    }
  }
  return classes.filter((value, index, list) => list.indexOf(value) === index);
}

function applyMatrixIdentityFailures(modelResults) {
  const failResults = (entries, reason) => {
    for (const entry of entries) {
      entry.ok = false;
      entry.failedLayers = [...new Set([...entry.failedLayers, 'deviceEvidence'])];
      entry.reason = reason;
      entry.latestFailure = entry.latest
        ? describeLatestFailure(entry.latest, ['deviceEvidence'], {}, reason)
        : entry.latestFailure;
    }
  };

  const bySessionId = new Map();
  for (const result of modelResults.filter((entry) => entry.latest)) {
    const sessionId = result.latest.report?.watchSessionReport?.sessionId;
    if (!sessionId) continue;
    const entries = bySessionId.get(sessionId) ?? [];
    entries.push(result);
    bySessionId.set(sessionId, entries);
  }
  for (const [sessionId, entries] of bySessionId) {
    if (entries.length > 1) {
      failResults(
        entries,
        `duplicate live artifact/session reused by multiple matrix cells: sessionId=${sessionId}`,
      );
    }
  }

  const byResolvedDeviceId = new Map();
  for (const result of modelResults.filter((entry) => entry.latest)) {
    const resolvedDeviceId = result.latest.report?.deviceEvidence?.resolvedDeviceId;
    const deviceClass = result.latest.report?.deviceEvidence?.deviceClass;
    if (!resolvedDeviceId || !deviceClass) continue;
    const key = String(resolvedDeviceId).trim().toLowerCase();
    const entries = byResolvedDeviceId.get(key) ?? [];
    entries.push(result);
    byResolvedDeviceId.set(key, entries);
  }
  for (const [resolvedDeviceId, entries] of byResolvedDeviceId) {
    const classes = [...new Set(entries.map((entry) => entry.deviceClass).filter(Boolean))];
    if (classes.length > 1) {
      failResults(
        entries,
        `one physical endpoint cannot satisfy multiple device classes: resolvedDeviceId=${resolvedDeviceId} classes=${classes.join(',')}`,
      );
    }
  }
}

function resolveScopedRunDirectories(root, runDirectories) {
  if (!Array.isArray(runDirectories)) return null;
  if (runDirectories.length === 0) {
    throw new Error('explicit runDirectories scope is empty');
  }
  const seen = new Set();
  return runDirectories.map((directory, index) => {
    if (typeof directory !== 'string' || !directory.trim()) {
      throw new Error(`runDirectories[${index}] must be a non-empty path string`);
    }
    const resolved = path.resolve(root, directory.trim());
    const relative = path.relative(root, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`run directory must be a child of evidence root: ${resolved}`);
    }
    const identity = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(identity)) {
      throw new Error(`duplicate run directory in explicit evidence scope: ${resolved}`);
    }
    seen.add(identity);
    return resolved;
  });
}

export function findWatchModeEvidence(options = {}) {
  const root = path.resolve(options.root ?? DEFAULT_ROOT);
  const strict = Boolean(options.strict);
  const currentProvenance = strict
    ? (options.currentProvenance ?? currentGitProvenance({
      cwd: options.workspaceRoot ?? process.cwd(),
    }))
    : null;
  const requestedModels = normalizeModels(options.models);
  const models = requestedModels.length > 0 ? requestedModels : [];
  const requestedFeedbackModes = normalizeModels(options.feedbackModes);
  const feedbackModes = requestedFeedbackModes.length > 0 ? requestedFeedbackModes : ['virtual-driver'];
  const deviceClasses = normalizeDeviceClasses(options.deviceClasses);
  const releaseCells = Array.isArray(options.releaseCells) ? options.releaseCells : null;
  let runDirectories;
  try {
    runDirectories = resolveScopedRunDirectories(root, options.runDirectories);
  } catch (error) {
    return {
      ok: false,
      reason: `invalid explicit Watch Mode run scope: ${error instanceof Error ? error.message : error}`,
      root,
      latest: null,
      candidates: [],
      invalidCandidates: [],
      modelResults: [],
    };
  }
  if (strict && runDirectories === null) {
    return {
      ok: false,
      reason: `strict Watch Mode evidence requires the schema-v${STRICT_MATRIX_SCHEMA_VERSION} budget-balanced authority manifest emitted by run-watch-mode-live-matrix.mjs; scanning outputRoot and --run-directories are disabled`,
      root,
      latest: null,
      candidates: [],
      invalidCandidates: [],
      modelResults: [],
    };
  }
  if (strict && runDirectories && releaseCells) {
    if (runDirectories.length !== releaseCells.length) {
      return {
        ok: false,
        reason: `strict Watch Mode run scope has ${runDirectories.length} run directories; expected exactly ${releaseCells.length} for the balanced paid-live plan`,
        root,
        latest: null,
        candidates: [],
        invalidCandidates: [],
        modelResults: [],
      };
    }
  } else if (strict && runDirectories && models.length > 0) {
    const expectedRunCount = models.length
      * feedbackModes.length
      * (deviceClasses.length > 0 ? deviceClasses.length : 1);
    if (runDirectories.length !== expectedRunCount) {
      return {
        ok: false,
        reason: `strict Watch Mode run scope has ${runDirectories.length} run directories; expected exactly ${expectedRunCount} for the requested model x route x device matrix`,
        root,
        latest: null,
        candidates: [],
        invalidCandidates: [],
        modelResults: [],
      };
    }
  }
  if (!fs.existsSync(root)) {
    return {
      ok: false,
      reason: `watch-mode evidence root does not exist: ${root}`,
      root,
      latest: null,
      candidates: [],
      modelResults: [],
    };
  }

  const candidates = loadCandidates(root, {
    strict,
    requireDeviceEvidence: deviceClasses.length > 0,
    runDirectories,
    authorizedReports: options.authorizedReports,
  });
  const invalidCandidates = candidates.filter(
    (entry) => entry.scopeError || entry.parseError || entry.incomplete,
  );
  const completeCandidates = candidates.filter((entry) => entry.complete);
  const latestCandidate = candidates[0] ?? null;
  if (latestCandidate && !latestCandidate.complete) {
    const reason = invalidCandidateReason(latestCandidate);
    return {
      ok: false,
      reason,
      root,
      latest: null,
      latestFailure: describeInvalidCandidate(latestCandidate),
      candidates,
      invalidCandidates,
      modelResults: [],
    };
  }
  if (completeCandidates.length === 0) {
    const latestInvalid = invalidCandidates[0] ?? null;
    const invalidReason = invalidCandidateReason(latestInvalid);
    return {
      ok: false,
      reason: invalidReason ?? `no complete live watch-mode report found under ${root}`,
      root,
      latest: null,
      latestFailure: latestInvalid ? describeInvalidCandidate(latestInvalid) : null,
      candidates,
      invalidCandidates,
      modelResults: [],
    };
  }

  if (releaseCells) {
    const byDirectory = new Map(completeCandidates.map((entry) => {
      const directory = path.resolve(path.dirname(entry.reportPath));
      return [process.platform === 'win32' ? directory.toLowerCase() : directory, entry];
    }));
    const modelResults = releaseCells.map((plannedCell, index) => {
      const runDirectory = path.resolve(runDirectories[index]);
      const identity = process.platform === 'win32' ? runDirectory.toLowerCase() : runDirectory;
      const latest = byDirectory.get(identity) ?? null;
      if (!latest) {
        return {
          cellId: plannedCell.cellId,
          tier: plannedCell.tier,
          modelId: plannedCell.modelId,
          feedbackMode: plannedCell.feedbackLoopPrevention,
          deviceClass: plannedCell.deviceClass,
          ok: false,
          latest: null,
          failedLayers: [],
          reason: `no complete live watch-mode report found for balanced cell ${plannedCell.cellId}`,
        };
      }
      if (
        latest.modelId !== plannedCell.modelId
        || latest.feedbackMode !== plannedCell.feedbackLoopPrevention
        || latest.deviceClass !== plannedCell.deviceClass
      ) {
        return {
          cellId: plannedCell.cellId,
          tier: plannedCell.tier,
          modelId: plannedCell.modelId,
          feedbackMode: plannedCell.feedbackLoopPrevention,
          deviceClass: plannedCell.deviceClass,
          ok: false,
          latest,
          failedLayers: ['identity'],
          reason: `balanced cell identity mismatch for ${plannedCell.cellId}`,
        };
      }
      const failure = basicFailure(latest, {
        strict,
        expectedDeviceClass: plannedCell.deviceClass,
        minimumDurationMs: plannedCell.durationSeconds * 1_000,
        now: options.now,
        maxAgeDays: options.maxAgeDays,
        currentProvenance,
        latencyThresholds: options.latencyThresholds,
      });
      return {
        cellId: plannedCell.cellId,
        tier: plannedCell.tier,
        modelId: plannedCell.modelId,
        feedbackMode: plannedCell.feedbackLoopPrevention,
        deviceClass: plannedCell.deviceClass,
        ok: failure.reason == null,
        latest,
        failedLayers: failure.failedLayers,
        reason: failure.reason,
        latestFailure: failure.latestFailure,
      };
    });
    applyMatrixIdentityFailures(modelResults);
    const failed = modelResults.filter((item) => !item.ok);
    return {
      ok: failed.length === 0,
      reason: failed.length === 0
        ? null
        : `balanced Watch Mode evidence failed: ${failed.map((item) => `${item.cellId}: ${item.reason}`).join('; ')}`,
      root,
      latest: modelResults[0]?.latest ?? null,
      failedLayers: [...new Set(modelResults.flatMap((item) => item.failedLayers))],
      candidates: completeCandidates,
      invalidCandidates,
      modelResults,
    };
  }

  if (models.length > 0) {
    const requiredDeviceClasses = deviceClasses.length > 0 ? deviceClasses : [null];
    const modelResults = models.flatMap((model) => feedbackModes.flatMap((feedbackMode) => (
      requiredDeviceClasses.map((deviceClass) => {
      const latest = completeCandidates.find(
        (entry) => entry.modelId === model
          && entry.feedbackMode === feedbackMode
          && (deviceClass === null || entry.deviceClass === deviceClass),
      );
      if (!latest) {
        const deviceLabel = deviceClass ? ` deviceClass ${deviceClass}` : '';
        return {
          modelId: model,
          feedbackMode,
          deviceClass,
          ok: false,
          latest: null,
          failedLayers: [],
          reason: `no complete live watch-mode report found for model ${model} feedbackLoopPrevention ${feedbackMode}${deviceLabel}`,
        };
      }
      const failure = basicFailure(latest, {
        strict,
        expectedDeviceClass: deviceClass,
        now: options.now,
        maxAgeDays: options.maxAgeDays,
        currentProvenance,
        latencyThresholds: options.latencyThresholds,
      });
      return {
        modelId: model,
        feedbackMode,
        deviceClass,
        ok: failure.reason == null,
        latest,
        failedLayers: failure.failedLayers,
        reason: failure.reason,
        latestFailure: failure.latestFailure,
      };
      })
    )));
    if (deviceClasses.length > 0) applyMatrixIdentityFailures(modelResults);
    const failed = modelResults.filter((item) => !item.ok);
    return {
      ok: failed.length === 0,
      reason: failed.length === 0
        ? null
        : `watch-mode evidence failed for model(s): ${failed.map((item) => `${item.modelId}[${item.feedbackMode}][${item.deviceClass ?? 'single-device'}]: ${item.reason}`).join('; ')}`,
      root,
      latest: modelResults[0]?.latest ?? null,
      failedLayers: [...new Set(modelResults.flatMap((item) => item.failedLayers))],
      candidates: completeCandidates,
      invalidCandidates,
      modelResults,
    };
  }

  const eligibleCandidates = completeCandidates.filter((entry) => feedbackModes.includes(entry.feedbackMode));
  const latest = eligibleCandidates[0];
  if (!latest) {
    return {
      ok: false,
      reason: `no complete live watch-mode report found for feedbackLoopPrevention ${feedbackModes.join(',')} under ${root}`,
      root,
      latest: null,
      candidates: completeCandidates,
      invalidCandidates,
      modelResults: [],
    };
  }
  const failure = basicFailure(latest, {
    strict,
    now: options.now,
    maxAgeDays: options.maxAgeDays,
    currentProvenance,
    latencyThresholds: options.latencyThresholds,
  });
  return {
    ok: failure.reason == null,
    reason: failure.reason == null
      ? null
      : `latest live watch-mode report is not passed: ${failure.reason}`,
    root,
    latest,
    failedLayers: failure.failedLayers,
    latestFailure: failure.latestFailure,
    candidates: completeCandidates,
    invalidCandidates,
    modelResults: [],
  };
}

function printEntry(entry, label = 'Latest Watch Mode report') {
  if (!entry) return;
  const report = entry.report;
  console.log(`${label}: ${entry.reportPath}`);
  console.log(`ModelId: ${entry.modelId ?? '-'}`);
  console.log(`FeedbackLoopPrevention: ${entry.feedbackMode ?? '-'}`);
  console.log(`DeviceClass: ${entry.deviceClass ?? report.deviceEvidence?.deviceClass ?? '-'}`);
  console.log(`ResolvedDeviceId: ${report.deviceEvidence?.resolvedDeviceId ?? '-'}`);
  console.log(`GeneratedAt: ${report.generatedAt ?? '-'}`);
  console.log(`TranslationRoute: ${report.translationRoute ?? '-'}`);
  console.log(`Verdict: ${report.verdict ?? '-'}`);
  console.log(`FailureLayer: ${report.failureLayer ?? '-'}`);
  console.log(`FailureReason: ${report.failureReason ?? '-'}`);
  const strict = report.layers?.strictContent?.data;
  if (strict) {
    console.log(`StrictContent: applicable=${strict.applicable ?? '-'} passed=${strict.passed ?? '-'} coverage=${strict.coverage ?? '-'}`);
  }
}

function printFailureDetails(failure, label = 'Failure details') {
  if (!failure) return;
  console.error(`${label}: ${failure.failureReason ?? '-'}`);
  if (failure.reportPath) console.error(`ReportPath: ${failure.reportPath}`);
  for (const step of failure.failedSteps ?? []) {
    console.error(`FailedStep: ${step.name}: ${step.error ?? '-'}`);
  }
  for (const evidence of failure.keyEvidence ?? []) {
    console.error(`Evidence: ${evidence}`);
  }
}

function printEvidence(result) {
  if (result.modelResults?.length > 0) {
    for (const model of result.modelResults) {
      const label = model.feedbackMode
        ? `${model.modelId} [${model.feedbackMode}] [${model.deviceClass ?? 'single-device'}]`
        : model.modelId;
      if (model.latest) printEntry(model.latest, `Latest Watch Mode report for ${label}`);
      if (!model.ok) {
        console.error(`Model ${label} failed evidence gate: ${model.reason}`);
        printFailureDetails(model.latestFailure, `Failure details for ${label}`);
      }
    }
  } else if (result.latest) {
    printEntry(result.latest);
  }
  if (result.ok) {
    console.log('Watch Mode live evidence gate passed.');
    return;
  }
  console.error(`Watch Mode live evidence gate failed: ${result.reason}`);
  printFailureDetails(result.latestFailure);
  const invalidCandidates = result.invalidCandidates ?? [];
  for (const invalid of invalidCandidates.slice(0, INVALID_CANDIDATE_PRINT_LIMIT)) {
    if (invalid.scopeError) {
      console.error(`InvalidScopedReport: ${invalid.reportPath}: ${invalid.scopeError}`);
    } else if (invalid.parseError) {
      console.error(`InvalidReport: ${invalid.reportPath}: ${invalid.parseError}`);
    } else if (invalid.incomplete) {
      console.error(`IncompleteReport: ${invalid.reportPath}: missingLayers=${invalid.missingLayers.join(',')}`);
    }
  }
  if (invalidCandidates.length > INVALID_CANDIDATE_PRINT_LIMIT) {
    console.error(`InvalidReportSummary: ${invalidCandidates.length - INVALID_CANDIDATE_PRINT_LIMIT} older incomplete/invalid report(s) omitted; newest ${INVALID_CANDIDATE_PRINT_LIMIT} shown.`);
  }
  console.error('Next step: npm run test:watch-mode-live:matrix');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseLooseArgs(process.argv.slice(2));
  const strict = args.strict === true || args.strict === 'true';
  const currentProvenance = strict ? currentGitProvenance() : null;
  const models = normalizeModels(args.models)
    .concat(strict && !args.models ? DEFAULT_STRICT_MODELS : [])
    .filter((value, index, list) => list.indexOf(value) === index);
  const feedbackModes = normalizeModels(args['feedback-modes']);
  let deviceClasses;
  try {
    deviceClasses = normalizeDeviceClasses(args['device-classes'])
      .concat(strict && !args['device-classes'] ? DEFAULT_STRICT_DEVICE_CLASSES : [])
      .filter((value, index, list) => list.indexOf(value) === index);
  } catch (error) {
    console.error(`Invalid --device-classes: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
    process.exit();
  }
  let latencyThresholds;
  try {
    latencyThresholds = normalizeLatencyThresholds(args['latency-thresholds']);
  } catch (error) {
    console.error(`Invalid --latency-thresholds: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
    process.exit();
  }
  let runDirectories;
  let runManifestResolution;
  let verifiedAuthority;
  let authorizedReports;
  try {
    if (args['run-manifest'] && args['run-directories']) {
      throw new Error('provide exactly one of --run-manifest or --run-directories, not both');
    }
    if (args['run-manifest']) {
      const resolved = readRunManifest(String(args['run-manifest']));
      runManifestResolution = resolved;
      if (strict && resolved.manifest.evidenceMode !== 'live') {
        throw new Error(`strict evidence requires a live manifest; evidenceMode=${resolved.manifest.evidenceMode ?? 'missing'}`);
      }
      if (strict && resolved.manifest.strict !== true) {
        throw new Error('strict evidence requires a manifest produced by a strict matrix run');
      }
      if (strict) {
        const provenanceFailure = strictManifestProvenanceFailure(resolved.manifest, {
          currentProvenance,
        });
        if (provenanceFailure) {
          throw new Error(`strict run manifest provenance failed: ${provenanceFailure}`);
        }
        const authority = verifyStrictMatrixAuthority({
          manifestPath: resolved.manifestPath,
          manifest: resolved.manifest,
          evidenceRoot: path.resolve(args.root ?? DEFAULT_ROOT),
          currentProvenance,
          workspaceRoot: process.cwd(),
          maxAgeDays: args['max-age-days'],
        });
        verifiedAuthority = authority;
        runDirectories = authority.runDirectories;
        authorizedReports = authority.authorizedReports;
      }
      if (!strict) runDirectories = resolved.runDirectories;
    } else if (args['run-directories']) {
      if (strict) {
        throw new Error(`strict evidence does not accept --run-directories; use the schema-v${STRICT_MATRIX_SCHEMA_VERSION} authority manifest emitted by run-watch-mode-live-matrix.mjs`);
      }
      runDirectories = normalizeRunDirectories(String(args['run-directories']), {
        baseDirectory: path.resolve(args.root ?? DEFAULT_ROOT),
      });
    }
  } catch (error) {
    console.error(`Invalid explicit run scope: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
    process.exit();
  }
  const result = findWatchModeEvidence({
    root: args.root ?? DEFAULT_ROOT,
    strict,
    models,
    feedbackModes,
    deviceClasses,
    runDirectories,
    authorizedReports,
    releaseCells: strict ? LIVE_LLM_CELLS : null,
    currentProvenance,
    maxAgeDays: args['max-age-days'],
    latencyThresholds,
  });
  printEvidence(result);
  if (
    result.ok
    && strict
    && runManifestResolution
    && runManifestResolution.manifest.verification !== 'passed'
  ) {
    const verification = writeStrictMatrixVerificationReceipt({
      manifestPath: runManifestResolution.manifestPath,
      manifest: runManifestResolution.manifest,
      authority: verifiedAuthority,
      currentProvenance,
    });
    console.log(`StrictMatrixVerificationReceipt: ${verification.receiptPath}`);
  }
  process.exitCode = result.ok ? 0 : 1;
}
