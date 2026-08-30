import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { readJson, repoRoot } from '../lib/testing-common.mjs';
import { readWatchModeRunCollection } from './watch-mode-run-collection.mjs';
import { derivePhysicalOutputContent } from './watch-mode-report.mjs';
import { analyzeAudioWithRust } from './watch-mode-rust-audio-analysis.mjs';
import {
  currentGitProvenance,
  exactGitProvenanceFailure,
} from './git-provenance.mjs';
import {
  CANONICAL_STRICT_MATRIX_MANIFEST,
  DEFAULT_FEEDBACK_MODES,
  SUPPORTED_DEVICE_CLASSES,
} from './run-watch-mode-live-matrix.mjs';
import {
  CELL_AUTHORITY_ARTIFACT_KIND,
  CELL_AUTHORITY_SCHEMA_VERSION,
  STRICT_MATRIX_ARTIFACT_KIND,
  STRICT_MATRIX_SCHEMA_VERSION,
  requiredCellArtifactPaths,
  resolveAuthorityPath,
} from './watch-mode-evidence-authority.mjs';
import {
  findWatchModeEvidence,
  readRunManifest,
  strictManifestProvenanceFailure,
  verifyStrictMatrixAuthority,
} from './verify-watch-mode-evidence.mjs';
import {
  LIVE_LLM_CELLS,
  RELEASE_MODELS,
  balancedReleasePlanFailure,
} from './watch-mode-balanced-release-plan.mjs';

export const REAL_DEVICE_AUDIO_COLLECTOR_ID = 'omni.release.real-device-audio';
export const REAL_DEVICE_AUDIO_COLLECTOR_VERSION = 1;
export const REAL_DEVICE_AUDIO_EMITTER_ID = 'omni-watch-mode-real-device-audio-release-evidence';
export const REAL_DEVICE_AUDIO_EMITTER_VERSION = '0.1.0';
export const REAL_DEVICE_AUDIO_RUNNER = 'scripts/testing/run-real-device-audio-release-evidence.mjs';
export const REAL_DEVICE_AUDIO_SCHEMA_VERSION = 1;
export const REAL_DEVICE_AUDIO_AUTHORITY_COLLECTOR_ID = 'omni.watch-mode-strict-matrix';
export const REAL_DEVICE_AUDIO_AUTHORITY_COLLECTOR_VERSION = 2;

export const REAL_DEVICE_AUDIO_SELECTED_CELL = Object.freeze({
  cellId: 'pairwise-live::qwen3.5-livetranslate-flash-realtime::process-exclusion::default-speaker',
  tier: 'pairwise-live',
  modelId: 'qwen3.5-livetranslate-flash-realtime',
  feedbackLoopPrevention: 'process-exclusion',
  deviceClass: 'default-speaker',
  // Selector default for fixtures only. Production selection binds the actual
  // unique profileId declared for the default-speaker class in the manifest.
  deviceProfileId: 'default-speaker',
});

export const REAL_DEVICE_AUDIO_ARTIFACTS = Object.freeze([
  Object.freeze({ role: 'emitter-result', path: 'emitter-result.json', kind: 'file' }),
  Object.freeze({ role: 'real-device-audio-probe', path: 'real-device-audio-probe.json', kind: 'file' }),
  Object.freeze({ role: 'real-device-audio-timeline', path: 'real-device-audio-timeline.json', kind: 'file' }),
  Object.freeze({ role: 'canonical-strict-matrix', path: 'canonical-matrix-manifest.json', kind: 'file' }),
  Object.freeze({ role: 'matrix-cell-authority', path: 'matrix-cell-authority.json', kind: 'file' }),
  Object.freeze({ role: 'physical-output-wav', path: 'real-device-audio.wav', kind: 'file' }),
  Object.freeze({ role: 'physical-output-pcm16k', path: 'real-device-audio-16k-mono.pcm', kind: 'file' }),
  Object.freeze({ role: 'provider-input-pcm16k', path: 'real-device-source-16k-mono.pcm', kind: 'file' }),
  Object.freeze({ role: 'source-reference-pcm16k', path: 'real-device-reference-16k-mono.pcm', kind: 'file' }),
  Object.freeze({ role: 'fingerprint-physical-wav', path: 'process-exclusion-physical-output.wav', kind: 'file' }),
  Object.freeze({ role: 'fingerprint-source-wav', path: 'process-exclusion-source-pipe.wav', kind: 'file' }),
  Object.freeze({ role: 'authorized-cell-raw', path: 'cell-raw', kind: 'directory' }),
]);

export const REAL_DEVICE_AUDIO_PROFILE = Object.freeze({
  collectorId: REAL_DEVICE_AUDIO_COLLECTOR_ID,
  collectorVersion: REAL_DEVICE_AUDIO_COLLECTOR_VERSION,
  evidenceArtifactKind: 'real-device-audio-release-evidence',
  artifacts: REAL_DEVICE_AUDIO_ARTIFACTS,
});

const MIN_PHYSICAL_RECORDING_SECONDS = 60;
const MIN_COMPLETE_CUES = 8;
const MAX_AGE_DAYS = 14;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

const portable = (value) => String(value).split(path.sep).join('/');
const valueFrom = (object, camel, snake) => object?.[camel] ?? object?.[snake];
const authorityMapKey = (directory) => {
  const resolved = path.resolve(directory);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

export const sha256Bytes = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
export const sha256File = (candidate) => sha256Bytes(fs.readFileSync(candidate));

export function fileReceipt(candidate) {
  const stats = fs.statSync(candidate);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0) {
    throw new Error(`evidence file must be a non-empty regular file: ${candidate}`);
  }
  return { sha256: sha256File(candidate), bytes: stats.size };
}

const samePath = (left, right) => authorityMapKey(left) === authorityMapKey(right);

export const canonicalRealDeviceAudioManifestPath = (workspaceRoot = repoRoot) => path.resolve(
  workspaceRoot,
  'artifacts/testing/watch-mode-live',
  CANONICAL_STRICT_MATRIX_MANIFEST,
);

const cellKey = (cell) => [
  cell?.cellId,
  cell?.tier,
  cell?.modelId,
  cell?.feedbackLoopPrevention,
  cell?.deviceClass,
  cell?.deviceProfileId,
].join('::');
const selectedCellKey = (cell) => cell?.cellId;

export const exactReleaseGridFailure = (manifest) => {
  if (manifest?.schemaVersion !== STRICT_MATRIX_SCHEMA_VERSION
    || manifest?.artifactKind !== STRICT_MATRIX_ARTIFACT_KIND
    || manifest?.strict !== true
    || manifest?.evidenceMode !== 'live'
    || manifest?.verification !== 'passed') {
    return `real-device audio requires the verified live canonical strict matrix schema-v${STRICT_MATRIX_SCHEMA_VERSION} manifest`;
  }
  const validationPlanFailure = balancedReleasePlanFailure(manifest.validationPlan);
  if (validationPlanFailure) return validationPlanFailure;
  if (!isDeepStrictEqual(manifest.models, RELEASE_MODELS)
    || !isDeepStrictEqual(manifest.feedbackLoopPreventionModes, DEFAULT_FEEDBACK_MODES)) {
    return 'canonical strict matrix model/route set is not the exact release grid';
  }
  const profileClasses = Array.isArray(manifest.deviceProfiles)
    ? manifest.deviceProfiles.map((profile) => profile?.deviceClass)
    : [];
  if (profileClasses.length !== SUPPORTED_DEVICE_CLASSES.length
    || !SUPPORTED_DEVICE_CLASSES.every((deviceClass) => (
      profileClasses.filter((candidate) => candidate === deviceClass).length === 1
    ))) {
    return `canonical strict matrix device profiles are not exactly: ${SUPPORTED_DEVICE_CLASSES.join(', ')}`;
  }
  const expectedCount = LIVE_LLM_CELLS.length;
  if (!Array.isArray(manifest.cells) || manifest.cells.length !== expectedCount
    || manifest.runDirectories?.length !== expectedCount) {
    return `canonical strict matrix must contain the complete ${expectedCount}-cell paid balanced release plan`;
  }
  const keys = manifest.cells.map(cellKey);
  if (new Set(keys).size !== expectedCount) return 'canonical strict matrix contains duplicate cells';
  const profileByClass = new Map(manifest.deviceProfiles.map((profile) => [
    profile.deviceClass,
    profile.profileId,
  ]));
  for (const expected of LIVE_LLM_CELLS) {
    const actual = manifest.cells.find((cell) => cell.cellId === expected.cellId);
    const contractKeys = [
      'tier',
      'providerMode',
      'inputCompletionWatchdogSeconds',
      'processExclusionRestartAfterSeconds',
      'processExclusionRestartQuietSeconds',
      'providerFinishTimeoutSeconds',
      'localPlaybackDrainTimeoutSeconds',
      'reportWriteTimeoutSeconds',
      'cellHardWatchdogSeconds',
      'authoritativeTransformedReferenceFrames',
      'boundedCaptureGraceFrames',
      'maxExternalAudioSamples',
      'modelId',
      'feedbackLoopPrevention',
      'deviceClass',
    ];
    if (!actual
      || contractKeys.some((key) => actual[key] !== expected[key])
      || actual.deviceProfileId !== profileByClass.get(expected.deviceClass)) {
      return `canonical strict matrix is missing balanced release cell ${expected.cellId}`;
    }
  }
  return null;
};

/**
 * Resolve the only production input accepted by this emitter. This runs the
 * complete strict authority verifier and the budget-balanced release gate; a
 * caller-supplied report directory or summary is intentionally unsupported.
 */
export function resolveCanonicalRealDeviceAudioAuthority({
  workspaceRoot = repoRoot,
  manifestPath = canonicalRealDeviceAudioManifestPath(workspaceRoot),
  currentProvenance = currentGitProvenance({ cwd: workspaceRoot }),
  now = Date.now(),
  maxAgeDays = MAX_AGE_DAYS,
} = {}) {
  const expectedManifestPath = canonicalRealDeviceAudioManifestPath(workspaceRoot);
  const resolvedManifestPath = path.resolve(manifestPath);
  if (!samePath(resolvedManifestPath, expectedManifestPath)) {
    throw new Error(`real-device audio authority must use the canonical strict matrix manifest: ${expectedManifestPath}`);
  }
  const resolved = readRunManifest(resolvedManifestPath, { baseDirectory: workspaceRoot });
  const shapeFailure = exactReleaseGridFailure(resolved.manifest);
  if (shapeFailure) throw new Error(shapeFailure);
  const provenanceFailure = strictManifestProvenanceFailure(resolved.manifest, {
    currentProvenance,
    workspaceRoot,
  });
  if (provenanceFailure) throw new Error(`canonical strict matrix provenance failed: ${provenanceFailure}`);
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const authority = verifyStrictMatrixAuthority({
    manifestPath: resolved.manifestPath,
    manifest: resolved.manifest,
    evidenceRoot: path.dirname(resolved.manifestPath),
    currentProvenance,
    workspaceRoot,
    now: nowMs,
    maxAgeDays,
  });
  const strict = findWatchModeEvidence({
    root: path.dirname(resolved.manifestPath),
    strict: true,
    models: RELEASE_MODELS,
    feedbackModes: DEFAULT_FEEDBACK_MODES,
    deviceClasses: SUPPORTED_DEVICE_CLASSES,
    releaseCells: LIVE_LLM_CELLS,
    runDirectories: authority.runDirectories,
    authorizedReports: authority.authorizedReports,
    currentProvenance,
    workspaceRoot,
    now: nowMs,
    maxAgeDays,
  });
  if (!strict.ok) {
    throw new Error(`canonical strict matrix evidence failed: ${strict.reason ?? 'unknown strict failure'}`);
  }
  const matches = resolved.manifest.cells
    .map((cell, index) => ({ cell, index }))
    .filter(({ cell }) => selectedCellKey(cell) === selectedCellKey(REAL_DEVICE_AUDIO_SELECTED_CELL));
  if (matches.length !== 1) {
    throw new Error('canonical strict matrix must contain exactly one fixed pairwise-live process-exclusion/default-speaker real-device cell');
  }
  const { cell, index } = matches[0];
  const runDirectory = authority.runDirectories[index];
  const report = authority.authorizedReports.get(authorityMapKey(runDirectory));
  if (!report) throw new Error('fixed real-device cell has no independently rebuilt authorized report');
  const receiptPath = resolveAuthorityPath(
    path.dirname(resolved.manifestPath),
    cell.receiptPath,
    'real-device matrix cell receipt',
  );
  const receipt = readJson(receiptPath);
  return {
    manifestPath: resolved.manifestPath,
    manifest: resolved.manifest,
    currentProvenance,
    strict,
    authority,
    cell,
    cellIndex: index,
    runDirectory,
    report,
    receiptPath,
    receipt,
  };
}

function readPcm16Wav(candidate) {
  const metrics = analyzeAudioWithRust({ inputPath: candidate, format: 'wav' });
  return {
    sampleRateHz: metrics.sampleRateHz,
    frames: metrics.sampleCount,
    durationSeconds: metrics.durationSeconds,
    rms: metrics.rms,
    peak: metrics.peak,
  };
}

const bridgePlaybackTimeline = (text) => {
  const events = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.includes('event=translation_playback_status')) continue;
    const status = line.match(/\bstatus=([^\s]+)/)?.[1] ?? '';
    const cueId = line.match(/\bcueId=([^\s]+)/)?.[1] ?? '';
    if (!status || !cueId || cueId === '-') continue;
    events.push({
      ordinal: events.length + 1,
      status,
      cueId,
      timestamp: line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})/)?.[1] ?? null,
      estimatedDurationMs: Number(
        line.match(/\b(?:estimatedDurationMs|durationMs)=(\d+)/)?.[1] ?? 0,
      ),
      rawLine: line,
    });
  }
  return events;
};

const terminalCueSummary = (events) => {
  const byCue = new Map();
  for (const event of events) {
    const cueEvents = byCue.get(event.cueId) ?? [];
    cueEvents.push(event);
    byCue.set(event.cueId, cueEvents);
  }
  const completed = [...byCue.entries()].filter(([, cueEvents]) => {
    const statuses = cueEvents.map(({ status }) => status);
    return statuses.filter((status) => status === 'queued').length === 1
    && statuses.filter((status) => status === 'started').length === 1
    && statuses.filter((status) => status === 'completed').length === 1
    && !statuses.some((status) => ['route-failed', 'stale-dropped'].includes(status))
    && statuses.indexOf('queued') < statuses.indexOf('started')
    && statuses.indexOf('started') < statuses.indexOf('completed');
  });
  const failed = [...byCue.entries()].filter(([, cueEvents]) => (
    cueEvents.some(({ status }) => ['route-failed', 'stale-dropped'].includes(status))
  ));
  const completedEstimatedFrames48k = completed.reduce((total, [, cueEvents]) => {
    const durationMs = Math.max(...cueEvents.map(({ estimatedDurationMs }) => (
      Number(estimatedDurationMs) || 0
    )));
    return total + Math.round(durationMs * 48);
  }, 0);
  return {
    cueCount: byCue.size,
    completedCueCount: completed.length,
    failedCueCount: failed.length,
    completedCueIds: completed.map(([cueId]) => cueId),
    failedCueIds: failed.map(([cueId]) => cueId),
    completedEstimatedFrames48k,
  };
};

const positiveInteger = (value) => Number.isInteger(Number(value)) && Number(value) > 0;

/** Validate and derive the E2E facts from one already-authorized raw cell. */
export function inspectAuthorizedRealDeviceCell(resolved) {
  const issues = [];
  const { cell, report, receipt, runDirectory } = resolved;
  if (selectedCellKey(cell) !== selectedCellKey(REAL_DEVICE_AUDIO_SELECTED_CELL)) {
    issues.push('selected authority cell is not the fixed qwen3.5-livetranslate process-exclusion/default-speaker cell');
  }
  if (receipt?.schemaVersion !== CELL_AUTHORITY_SCHEMA_VERSION
    || receipt?.artifactKind !== CELL_AUTHORITY_ARTIFACT_KIND
    || cellKey(receipt?.matrixCell) !== cellKey(cell)) {
    issues.push('selected cell authority receipt identity is invalid');
  }
  const expectedRawPaths = requiredCellArtifactPaths('process-exclusion');
  const recordedRawPaths = Array.isArray(receipt?.artifacts)
    ? receipt.artifacts.map((artifact) => artifact.path)
    : [];
  if (!isDeepStrictEqual(recordedRawPaths, expectedRawPaths)) {
    issues.push('selected cell receipt does not contain the fixed process-exclusion raw inventory');
  }
  if (report?.mode !== 'live' || report?.verdict !== 'passed'
    || report?.modelId !== cell.modelId
    || report?.feedbackLoopPrevention !== cell.feedbackLoopPrevention
    || report?.deviceEvidence?.deviceClass !== cell.deviceClass
    || report?.deviceEvidence?.profileId !== cell.deviceProfileId) {
    issues.push('authorized report is not the passed live selected-cell report');
  }

  const watch = readJson(path.join(runDirectory, 'watch-session-report.json'));
  const elapsedMs = Number(watch?.elapsedMs);
  const summaryDurationMs = Number(watch?.summary?.durationMs);
  if (watch?.status !== 'completed'
    || !Number.isFinite(elapsedMs) || elapsedMs <= 0
    || !Number.isFinite(summaryDurationMs) || summaryDurationMs <= 0
    || Math.abs(elapsedMs - summaryDurationMs) > 1000) {
    issues.push('real-device Watch session lacks completed, internally consistent evidence-driven terminal timing');
  }
  const expectedCues = Array.isArray(watch?.cues)
    ? watch.cues.filter((cue) => cue?.comparisonStatus !== 'superseded')
    : [];
  const acceptedCues = expectedCues.filter((cue) => (
    ['exact', 'formatting-only'].includes(cue?.comparisonStatus)
    && Number.isFinite(Number(cue?.llmFirstAtMs))
    && Number.isFinite(Number(cue?.publishedFirstAtMs))
    && Number.isFinite(Number(cue?.renderedFirstAtMs))
  ));
  if (expectedCues.length < MIN_COMPLETE_CUES || acceptedCues.length !== expectedCues.length
    || Number(watch?.summary?.completeCueCount) !== acceptedCues.length
    || Number(watch?.summary?.visibleRenderCueCount) !== acceptedCues.length
    || Number(watch?.summary?.unrenderedCueCount) !== 0
    || Number(watch?.droppedCueCount) !== 0) {
    issues.push('real-device subtitle expected segments were not accepted/rendered at 100% with zero cue drops');
  }

  const steps = readWatchModeRunCollection(runDirectory).collection.steps;
  const desktopStep = Array.isArray(steps)
    ? steps.find((step) => step?.id === 'start-desktop-shell')
    : null;
  const recorderStep = Array.isArray(steps)
    ? steps.find((step) => step?.id === 'start-physical-output-content-recording')
    : null;
  const playback = readJson(path.join(runDirectory, 'playback.json'));
  const desktopProcessId = Number(desktopStep?.data?.pid);
  const physicalRecorderProcessId = Number(recorderStep?.data?.pid);
  const mediaInjectorProcessId = Number(playback?.injectorProcessId);
  const restart = report?.layers?.bridge?.data?.processExclusionRestart;
  const oldBridgeProcessId = Number(restart?.oldBridgeProcessId);
  const newBridgeProcessId = Number(restart?.newBridgeProcessId);
  if (desktopStep?.status !== 'passed' || recorderStep?.status !== 'passed'
    || !positiveInteger(desktopProcessId)
    || !positiveInteger(physicalRecorderProcessId)
    || !positiveInteger(mediaInjectorProcessId)
    || new Set([
      desktopProcessId,
      physicalRecorderProcessId,
      mediaInjectorProcessId,
      oldBridgeProcessId,
      newBridgeProcessId,
    ]).size !== 5
    || restart?.completed !== true || restart?.evidenceMode !== 'live'
    || restart?.fixtureOnly !== false
    || !positiveInteger(oldBridgeProcessId) || !positiveInteger(newBridgeProcessId)
    || oldBridgeProcessId === newBridgeProcessId
    || desktopProcessId === oldBridgeProcessId || desktopProcessId === newBridgeProcessId
    || Number(restart?.oldFramesAfterRestart) !== 0
    || Number(restart?.sourceFramesAfter) <= Number(restart?.sourceFramesBefore)) {
    issues.push('Desktop/Bridge live process identity and controlled-restart continuity are invalid');
  }

  const device = readJson(path.join(runDirectory, 'physical-playback-device.json'));
  const physicalProbe = readJson(path.join(runDirectory, 'physical-output-probe.json'));
  const fingerprint = physicalProbe?.processExclusionFingerprint
    ?? physicalProbe?.process_exclusion_fingerprint;
  const resolvedProbeId = physicalProbe?.resolvedPhysicalPlaybackDeviceId
    ?? physicalProbe?.resolved_physical_playback_device_id;
  if (device?.verified !== true || device?.fixtureOnly !== false
    || device?.profileId !== cell.deviceProfileId || device?.deviceClass !== cell.deviceClass
    || device?.classificationSource !== 'windows-mmdevice-registry'
    || !String(device?.resolvedDeviceId ?? '').trim()
    || !String(device?.resolvedDeviceName ?? '').trim()
    || resolvedProbeId !== device.resolvedDeviceId
    || /Omni Translate Virtual Speaker/i.test(device.resolvedDeviceName)) {
    issues.push('actual Windows MMDevice render endpoint identity/class does not match the selected cell');
  }

  const recordingPath = path.join(runDirectory, 'physical-output-recording.wav');
  let recording;
  try {
    recording = readPcm16Wav(recordingPath);
  } catch (error) {
    issues.push(error.message);
  }
  const recordingJson = readJson(path.join(runDirectory, 'physical-output-recording.json'));
  const content = derivePhysicalOutputContent(
    readJson(path.join(runDirectory, 'physical-output-content.raw.json')),
  );
  if (!recording || recording.durationSeconds < MIN_PHYSICAL_RECORDING_SECONDS
    || recording.rms <= 0.0001 || recording.peak <= 0.001
    || recordingJson?.passed !== true || content?.passed !== true
    || content?.skipped === true || content?.recording?.passed !== true
    || content?.audioQuality?.passed === false
    || content?.contentConsistency?.passed !== true
    || content?.translatedSpeech?.passed !== true
    || Number(content?.translatedSpeech?.queuedSegments) < MIN_COMPLETE_CUES
    || Number(content?.translatedSpeech?.playedSegments) < MIN_COMPLETE_CUES
    || !String(content?.source ?? '').trim()
    || !(String(content?.translation ?? '').trim()
      || String(content?.subtitleText ?? '').trim()
      || String(content?.segmentTranslationText ?? '').trim())) {
    issues.push('physical recording/STT does not prove audible original plus translated content');
  }
  if (report?.layers?.strictContent?.status !== 'passed'
    || report?.layers?.physicalOutputContent?.status !== 'passed') {
    issues.push('authorized report did not pass physical-content and strict-content gates');
  }

  const providerInput = fs.readFileSync(path.join(runDirectory, 'provider-input-16k-mono.pcm'));
  const sourceReference = fs.readFileSync(path.join(runDirectory, 'source-media-reference-16k-mono.pcm'));
  const physicalPcm = fs.readFileSync(path.join(runDirectory, 'physical-output-recording-16k-mono.pcm'));
  if (providerInput.length < sourceReference.length || sourceReference.length < 60 * 16_000 * 2
    || physicalPcm.length < 60 * 16_000 * 2
    || [providerInput, sourceReference, physicalPcm].some((bytes) => bytes.length % 2 !== 0)) {
    issues.push('source/provider/physical PCM frame evidence is incomplete or malformed');
  }

  const bridgeLogText = fs.readFileSync(path.join(runDirectory, 'bridge-service.log'), 'utf8');
  const playbackTimeline = bridgePlaybackTimeline(bridgeLogText);
  const playbackSummary = terminalCueSummary(playbackTimeline);
  if (playbackSummary.completedCueCount < MIN_COMPLETE_CUES
    || playbackSummary.failedCueCount !== 0
    || /event=translation_playback_status status=(?:route-failed|stale-dropped)/.test(bridgeLogText)) {
    issues.push('Bridge production log does not prove at least eight exactly-once queued/started/completed translated cues with zero route failures');
  }
  if (playbackSummary.completedEstimatedFrames48k <= 0) {
    issues.push('Bridge cue lifecycle did not expose positive completed translated frame duration');
  }
  if (!fingerprint
    || valueFrom(fingerprint, 'captureBackend', 'capture_backend') !== 'wasapi-process-exclusion'
    || valueFrom(fingerprint, 'sourceCaptureMode', 'source_capture_mode') !== 'process-exclusion'
    || valueFrom(fingerprint, 'processLoopbackStatus', 'process_loopback_status') !== 'ready'
    || Number(valueFrom(fingerprint, 'bridgeProcessId', 'bridge_process_id'))
      !== Number(valueFrom(fingerprint, 'excludedProcessId', 'excluded_process_id'))
    || Number(valueFrom(fingerprint, 'bridgeChildParentProcessId', 'bridge_child_parent_process_id'))
      !== Number(valueFrom(fingerprint, 'bridgeProcessId', 'bridge_process_id'))) {
    issues.push('process-exclusion physical/source fingerprint authority is invalid');
  }

  const rawArtifactByPath = new Map((receipt?.artifacts ?? []).map((artifact) => [artifact.path, artifact]));
  return {
    issues: [...new Set(issues)],
    facts: {
      cell,
      report,
      watch,
      desktopProcessId,
      physicalRecorderProcessId,
      mediaInjectorProcessId,
      oldBridgeProcessId,
      newBridgeProcessId,
      device,
      recording,
      recordingJson,
      content,
      fingerprint,
      expectedCueCount: expectedCues.length,
      acceptedCueCount: acceptedCues.length,
      acceptedCueIds: acceptedCues.map((cue) => cue.cueId),
      playbackTimeline,
      playbackSummary,
      translatedFrames: playbackSummary.completedEstimatedFrames48k,
      providerInputFrames: providerInput.length / 2,
      sourceReferenceFrames: sourceReference.length / 2,
      physicalPcmFrames: physicalPcm.length / 2,
      rawArtifactByPath,
    },
  };
}

const artifactSetFailure = (root) => {
  const expected = REAL_DEVICE_AUDIO_ARTIFACTS.map((artifact) => artifact.path).sort();
  const actual = fs.existsSync(root) && fs.statSync(root).isDirectory()
    ? fs.readdirSync(root).sort()
    : [];
  return isDeepStrictEqual(actual, expected)
    ? null
    : `real-device artifact set must be exactly: ${expected.join(', ')}`;
};

const timestampFailure = (value, label, now, maxAgeDays) => {
  const parsed = Date.parse(String(value ?? ''));
  if (!Number.isFinite(parsed)) return `${label} is missing or invalid`;
  if (parsed > now + 300_000) return `${label} is more than five minutes in the future`;
  if ((now - parsed) / 86_400_000 > maxAgeDays) return `${label} is stale`;
  return null;
};

const copiedRawMatchesReceipt = (root, receipt, issues) => {
  const copiedRoot = path.join(root, 'cell-raw');
  const expected = requiredCellArtifactPaths('process-exclusion');
  const copied = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        issues.push(`cell-raw may not contain a symbolic link: ${candidate}`);
      } else if (entry.isDirectory()) walk(candidate);
      else if (entry.isFile()) copied.push(portable(path.relative(copiedRoot, candidate)));
    }
  };
  walk(copiedRoot);
  copied.sort();
  if (!isDeepStrictEqual(copied, expected)) {
    issues.push('cell-raw does not contain the exact fixed process-exclusion inventory');
    return;
  }
  const receiptByPath = new Map(receipt.artifacts.map((artifact) => [artifact.path, artifact]));
  for (const relativePath of expected) {
    const candidate = path.join(copiedRoot, ...relativePath.split('/'));
    const authority = receiptByPath.get(relativePath);
    const actual = fileReceipt(candidate);
    if (!authority || authority.sha256 !== actual.sha256 || Number(authority.bytes) !== actual.bytes) {
      issues.push(`cell-raw/${relativePath} does not match the matrix cell authority receipt`);
    }
  }
};

/**
 * Validate an assembled package by re-running canonical strict authority and
 * matching every copied raw byte to the selected cell receipt.
 */
export function validateRealDeviceAudioEvidence(
  sourceRoot,
  {
    workspaceRoot = repoRoot,
    currentProvenance = currentGitProvenance({ cwd: workspaceRoot }),
    now = Date.now(),
    maxAgeDays = MAX_AGE_DAYS,
    authorityResolver = resolveCanonicalRealDeviceAudioAuthority,
  } = {},
) {
  const root = path.resolve(sourceRoot);
  const issues = [];
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return { issues: ['real-device evidence source must be a directory'], summary: null, evidenceTimes: [] };
  }
  const setFailure = artifactSetFailure(root);
  if (setFailure) issues.push(setFailure);
  for (const artifact of REAL_DEVICE_AUDIO_ARTIFACTS) {
    const candidate = path.join(root, artifact.path);
    if (!fs.existsSync(candidate)) issues.push(`required ${artifact.role} is missing: ${artifact.path}`);
    else if ((fs.statSync(candidate).isDirectory() ? 'directory' : 'file') !== artifact.kind) {
      issues.push(`${artifact.path} must be a ${artifact.kind}`);
    }
  }
  if (issues.length > 0) return { issues, summary: null, evidenceTimes: [] };

  let resolved;
  let inspected;
  try {
    resolved = authorityResolver({ workspaceRoot, currentProvenance, now, maxAgeDays });
    inspected = inspectAuthorizedRealDeviceCell(resolved);
    issues.push(...inspected.issues);
  } catch (error) {
    issues.push(`canonical strict authority: ${error.message}`);
    return { issues: [...new Set(issues)], summary: null, evidenceTimes: [] };
  }

  const emitter = readJson(path.join(root, 'emitter-result.json'));
  const evidence = readJson(path.join(root, 'real-device-audio-probe.json'));
  const timeline = readJson(path.join(root, 'real-device-audio-timeline.json'));
  const copiedManifest = readJson(path.join(root, 'canonical-matrix-manifest.json'));
  const copiedReceipt = readJson(path.join(root, 'matrix-cell-authority.json'));
  if (emitter?.schemaVersion !== REAL_DEVICE_AUDIO_SCHEMA_VERSION
    || emitter?.artifactKind !== 'real-device-audio-release-evidence-emitter-result'
    || emitter?.emitterId !== REAL_DEVICE_AUDIO_EMITTER_ID
    || emitter?.emitterVersion !== REAL_DEVICE_AUDIO_EMITTER_VERSION
    || emitter?.scenarioId !== 'E2E-REAL-DEVICE-AUDIO'
    || emitter?.status !== 'completed'
    || emitter?.productionMode !== true
    || emitter?.simulated !== false || emitter?.dryRun !== false || emitter?.skipped !== false) {
    issues.push('emitter-result.json is not a completed non-simulated production emitter result');
  }
  const timeIssues = [
    timestampFailure(emitter?.startedAt, 'emitter startedAt', Number(now), maxAgeDays),
    timestampFailure(emitter?.completedAt, 'emitter completedAt', Number(now), maxAgeDays),
    timestampFailure(evidence?.capturedAt, 'evidence capturedAt', Number(now), maxAgeDays),
  ].filter(Boolean);
  issues.push(...timeIssues);
  const provenanceIssue = exactGitProvenanceFailure(emitter?.sourceProvenance, currentProvenance, {
    recordedSubject: 'real-device emitter provenance',
    currentSubject: 'current checkout provenance',
  });
  if (provenanceIssue) issues.push(provenanceIssue);
  if (emitter?.invocationId !== evidence?.invocationId
    || emitter?.invocationId !== timeline?.invocationId) {
    issues.push('real-device artifacts do not share one invocationId');
  }
  if (emitter?.canonicalManifestSha256 !== sha256File(path.join(root, 'canonical-matrix-manifest.json'))
    || emitter?.cellReceiptSha256 !== sha256File(path.join(root, 'matrix-cell-authority.json'))
    || emitter?.evidenceSha256 !== sha256File(path.join(root, 'real-device-audio-probe.json'))
    || emitter?.timelineSha256 !== sha256File(path.join(root, 'real-device-audio-timeline.json'))) {
    issues.push('emitter result is not hash-bound to the assembled authority artifacts');
  }
  if (!isDeepStrictEqual(copiedManifest, resolved.manifest)
    || sha256File(path.join(root, 'canonical-matrix-manifest.json')) !== sha256File(resolved.manifestPath)) {
    issues.push('canonical manifest copy does not match the currently verified authority manifest');
  }
  if (!isDeepStrictEqual(copiedReceipt, resolved.receipt)
    || sha256File(path.join(root, 'matrix-cell-authority.json')) !== sha256File(resolved.receiptPath)) {
    issues.push('matrix cell receipt copy does not match the selected canonical cell authority');
  }
  copiedRawMatchesReceipt(root, copiedReceipt, issues);

  const aliasBindings = [
    ['real-device-audio.wav', 'physical-output-recording.wav'],
    ['real-device-audio-16k-mono.pcm', 'physical-output-recording-16k-mono.pcm'],
    ['real-device-source-16k-mono.pcm', 'provider-input-16k-mono.pcm'],
    ['real-device-reference-16k-mono.pcm', 'source-media-reference-16k-mono.pcm'],
    ['process-exclusion-physical-output.wav', 'physical-output-probe-runtime/process-exclusion-physical-output.wav'],
    ['process-exclusion-source-pipe.wav', 'physical-output-probe-runtime/process-exclusion-source-pipe.wav'],
  ];
  for (const [alias, rawPath] of aliasBindings) {
    if (sha256File(path.join(root, alias))
      !== sha256File(path.join(root, 'cell-raw', ...rawPath.split('/')))) {
      issues.push(`${alias} does not hash-match authorized cell-raw/${rawPath}`);
    }
  }

  const facts = inspected.facts;
  if (evidence?.schemaVersion !== REAL_DEVICE_AUDIO_SCHEMA_VERSION
    || evidence?.artifactKind !== 'real-device-audio-production-probe'
    || evidence?.collectorId !== REAL_DEVICE_AUDIO_AUTHORITY_COLLECTOR_ID
    || evidence?.collectorVersion !== REAL_DEVICE_AUDIO_AUTHORITY_COLLECTOR_VERSION
    || evidence?.productionMode !== true || evidence?.passed !== true
    || evidence?.simulated !== false || evidence?.dryRun !== false || evidence?.skipped !== false
    || cellKey(evidence?.selectedCell) !== cellKey(resolved.cell)) {
    issues.push('real-device-audio-probe.json identity/selected cell is invalid');
  }
  if (evidence?.authority?.canonicalManifestSha256 !== sha256File(resolved.manifestPath)
    || evidence?.authority?.cellReceiptSha256 !== sha256File(resolved.receiptPath)
    || evidence?.authority?.sourceHeadCommit !== currentProvenance.headCommit) {
    issues.push('real-device summary is not bound to canonical manifest/cell/current HEAD authority');
  }
  if (evidence?.endpoint?.id !== facts.device.resolvedDeviceId
    || evidence?.endpoint?.name !== facts.device.resolvedDeviceName
    || evidence?.endpoint?.deviceClass !== facts.device.deviceClass
    || evidence?.endpoint?.classificationSource !== facts.device.classificationSource) {
    issues.push('real-device summary endpoint does not match Windows MMDevice raw evidence');
  }
  if (Number(evidence?.processes?.desktopProcessId) !== facts.desktopProcessId
    || Number(evidence?.processes?.physicalRecorderProcessId) !== facts.physicalRecorderProcessId
    || Number(evidence?.processes?.mediaInjectorProcessId) !== facts.mediaInjectorProcessId
    || Number(evidence?.processes?.oldBridgeProcessId) !== facts.oldBridgeProcessId
    || Number(evidence?.processes?.newBridgeProcessId) !== facts.newBridgeProcessId) {
    issues.push('real-device summary Desktop/Bridge identities do not match authorized raw evidence');
  }
  if (Number(evidence?.session?.durationMs) !== Number(facts.watch.summary.durationMs)
    || Number(evidence?.subtitles?.expectedCueCount) !== facts.expectedCueCount
    || Number(evidence?.subtitles?.acceptedCueCount) !== facts.acceptedCueCount
    || evidence?.subtitles?.acceptancePercent !== 100
    || Number(evidence?.playback?.completedCueCount) !== facts.playbackSummary.completedCueCount
    || Number(evidence?.playback?.failedCueCount) !== 0
    || Number(evidence?.audio?.sourceFrames) !== facts.providerInputFrames
    || Number(evidence?.audio?.translatedFrames) !== facts.translatedFrames
    || evidence?.audio?.translatedFrameBasis !== 'bridge-completed-estimated-duration-48khz'
    || Number(evidence?.audio?.physicalFrames) !== facts.physicalPcmFrames) {
    issues.push('real-device summary session/cue/audio counters were not recomputed from authorized raw evidence');
  }
  if (evidence?.route?.captureBackend !== 'wasapi-process-exclusion'
    || evidence?.route?.processLoopbackStatus !== 'ready'
    || evidence?.zeroErrors?.routeFailures !== 0
    || evidence?.zeroErrors?.cueDrops !== 0
    || evidence?.zeroErrors?.invalidSamples !== 0) {
    issues.push('real-device summary does not prove the ready process-exclusion route with zero errors');
  }
  if (timeline?.schemaVersion !== REAL_DEVICE_AUDIO_SCHEMA_VERSION
    || timeline?.artifactKind !== 'real-device-audio-authorized-timeline'
    || timeline?.sessionId !== facts.watch.sessionId
    || !isDeepStrictEqual(timeline?.watchEvents, facts.watch.events)
    || !isDeepStrictEqual(timeline?.translationPlaybackEvents, facts.playbackTimeline)) {
    issues.push('real-device timeline does not match raw Watch/Bridge production events');
  }

  return {
    issues: [...new Set(issues)],
    evidenceTimes: [emitter.startedAt, evidence.capturedAt, emitter.completedAt],
    summary: issues.length === 0 ? {
      endpointId: facts.device.resolvedDeviceId,
      endpointName: facts.device.resolvedDeviceName,
      deviceClass: facts.device.deviceClass,
      desktopProcessId: facts.desktopProcessId,
      physicalRecorderProcessId: facts.physicalRecorderProcessId,
      mediaInjectorProcessId: facts.mediaInjectorProcessId,
      bridgeProcessId: facts.newBridgeProcessId,
      sessionDurationMs: Number(facts.watch.summary.durationMs),
      expectedCueCount: facts.expectedCueCount,
      acceptedCueCount: facts.acceptedCueCount,
      sourceFrames: facts.providerInputFrames,
      translatedFrames: facts.translatedFrames,
      physicalFrames: facts.physicalPcmFrames,
      captureBackend: valueFrom(facts.fingerprint, 'captureBackend', 'capture_backend'),
      processLoopbackStatus: valueFrom(
        facts.fingerprint,
        'processLoopbackStatus',
        'process_loopback_status',
      ),
    } : null,
  };
}
