import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  stageShardMatrixIntegration,
  writeMatrixRunManifest,
} from './run-watch-mode-live-matrix.mjs';
import { writeReport as writeDirectoryReport } from './watch-mode-report.mjs';
import {
  currentAuthorityImplementationHashes,
  fileAuthorityEntry,
  requiredCellArtifactPaths,
  sha256File,
} from './watch-mode-evidence-authority.mjs';
import {
  STRICT_PAID_MATRIX_CEILING_SECONDS,
  STRICT_PAID_MODEL_PROTOCOLS,
  STRICT_PAID_PROVIDER_IDENTITY,
  writeCellExternalProviderBudget,
  writeMatrixExternalProviderBudget,
} from './watch-mode-external-provider-budget.mjs';
import { LIVE_LLM_CELLS, RELEASE_MODELS } from './watch-mode-balanced-release-plan.mjs';
import {
  SHARD_EXECUTION_PLAN_FILE,
  SHARD_INTERACTIVE_CELL_EXECUTION_FILE,
  SHARD_INTERACTIVE_COMMAND_FILE,
  SHARD_INTERACTIVE_CLAIM_RELEASE_FILE,
  SHARD_INTERACTIVE_LAUNCH_FILE,
  SHARD_INTERACTIVE_PROCESS_AUTHORITY_FILE,
  SHARD_INTERACTIVE_SESSION_AUTHORITY_FILE,
  SHARD_INTERACTIVE_TASK_TERMINAL_FILE,
  SHARD_INTERACTIVE_TERMINAL_FILE,
  SHARD_WORKER_READINESS_FILE,
  SHARD_WORKER_READINESS_KIND,
  createWorkerReadinessRequest,
  currentShardOrchestrationImplementationHashes,
  createSignedExecutionPlan,
  generateCoordinatorSigningKeyPair,
  issueCellLeases,
  validateWorkerZeroProviderReadinessAuthority,
  writeShardCellResult,
  writeShardManifest,
} from './watch-mode-shard-authority.mjs';
import {
  claimCoordinatorCellDispatch,
  completeCoordinatorWave,
  defaultThreeVmAssignments,
  writeCoordinatorAggregate,
  writeCoordinatorProviderPreflightReceipt,
} from './run-watch-mode-live-coordinator.mjs';
import {
  PROVIDER_PREFLIGHT_COMPLETION_FILE,
  PROVIDER_PREFLIGHT_CONSUMPTION_CLAIM_FILE,
  PROVIDER_PREFLIGHT_CONSUMPTION_CLAIM_KIND,
  PROVIDER_PREFLIGHT_DESKTOP_EXECUTABLE,
  PROVIDER_PREFLIGHT_GRANT_FILE,
  PROVIDER_PREFLIGHT_LEASE_RESERVATION_DIRECTORY,
  PROVIDER_PREFLIGHT_MODEL,
  PROVIDER_PREFLIGHT_PROTOCOL,
  PROVIDER_PREFLIGHT_PROVIDER_ID,
  createProviderPreflightCompletion,
  createProviderPreflightGrant,
  createProviderPreflightLeaseReservations,
  loadProviderPreflightAuthorizationPackage,
  providerPreflightReservationFileName,
} from './watch-mode-provider-preflight-authorization.mjs';
import {
  buildTranslatedPcmLoopbackAuthority,
} from './watch-mode-translated-pcm-loopback.mjs';
import {
  buildPhysicalSourceWaveformAuthority,
  loadCanonicalFixtureAuthority,
} from './watch-mode-canonical-source-authority.mjs';
import {
  ECHO_CANCEL_REQUIRED_LAYERS,
  MIN_STRICT_SESSION_DURATION_MS,
  REQUIRED_LAYERS,
  buildStrictShardCellAuthorityProjection,
  findWatchModeEvidence,
  normalizeLatencyThresholds,
  normalizeRunDirectories,
  readRunManifest,
  strictDeviceEvidenceFailure,
  strictLatencyFailure,
  strictManifestProvenanceFailure,
  strictAecScenarioFailure,
  strictProcessExclusionRestartFailure,
  strictProvenanceFailure,
  strictWatchSessionReportFailure,
  assertStrictTranslatedPcmLoopbackAuthority,
  verifyStrictShardProviderPreflightAuthority,
  verifyStrictShardProviderPreflightAuthorization,
  verifyStrictShardMatrixAuthority,
  verifyStrictMatrixAuthority as verifyProductionStrictMatrixAuthority,
  writeStrictMatrixVerificationReceipt,
} from './verify-watch-mode-evidence.mjs';

const verifyStrictMatrixAuthority = (options) => verifyProductionStrictMatrixAuthority({
  ...options,
  requireLocalIsolation: false,
  releaseCells: Array.isArray(options?.manifest?.cells)
    ? options.manifest.cells.map((cell) => ({
      cellId: cell.cellId,
      tier: cell.tier,
      providerMode: cell.providerMode,
      durationSeconds: cell.durationSeconds,
      modelId: cell.modelId,
      feedbackLoopPrevention: cell.feedbackLoopPrevention,
      deviceClass: cell.deviceClass,
    }))
    : undefined,
});

// Frozen "now" + exact clean HEAD so strict provenance can be exercised
// deterministically without depending on the test process worktree.
const FIXTURE_NOW = Date.parse('2026-06-06T00:00:00.000Z');
const CLEAN_CURRENT_PROVENANCE = Object.freeze({
  schemaVersion: 1,
  source: 'git',
  captureStatus: 'captured',
  headCommit: 'fixture-commit',
  worktreeClean: true,
  dirtyEntryCount: 0,
});
const TEST_RUNTIME_BINARY_HASHES = Object.freeze([]);
const provenanceOk = { now: FIXTURE_NOW, currentProvenance: CLEAN_CURRENT_PROVENANCE };
const healthyWatchSessionReport = {
  sessionId: 'watch-fixture',
  status: 'completed',
  elapsedMs: MIN_STRICT_SESSION_DURATION_MS,
  summary: {
    durationMs: MIN_STRICT_SESSION_DURATION_MS,
    unrenderedCueCount: 0,
  },
  cues: [{
    cueId: 'cue-1',
    comparisonStatus: 'exact',
    llmFirstAtMs: 100,
    publishedFirstAtMs: 150,
    renderedFirstAtMs: 166,
    llmFirstToRenderMs: 66,
    publishToRenderMs: 16,
    issues: [],
  }],
};

const AEC_PLAYBACK_STARTED_AT_MS = Date.parse('2026-06-05T10:45:00.000Z');
const healthyAecScenarioData = {
  maxDoubleTalkFrames: 12,
  minReportedDelayMs: 0,
  maxReportedDelayMs: 160,
  reportedDelaySpanMs: 160,
  asrDeletedChunkMetricCount: 2,
  maxAsrDeletedChunks: 0,
  liveScenario: {
    completed: true,
    evidenceMode: 'live',
    fixtureOnly: false,
    timelineBoundToPlayback: true,
    playback: {
      actualPlayback: true,
      mediaSha256: 'cf4990ecdc23622d12de3e62adad442755c9e84c4612787798655ee00c85fb2f',
      processId: 5001,
      startedAtMs: AEC_PLAYBACK_STARTED_AT_MS,
      finishedAtMs: AEC_PLAYBACK_STARTED_AT_MS + 125_000,
    },
    stages: {
      doubleTalk: {
        status: 'completed', stage: 'double-talk', ordinal: 1, delayMs: 0, nonlinearity: 'none',
        source: 'runtime-physical-render', playbackSource: 'native-omni',
        referenceFrames: 4800, physicalFrames: 4800, changedSamples: 0, changedRatio: 0,
        started: true, completed: true,
        startedAtMs: AEC_PLAYBACK_STARTED_AT_MS + 1_000,
        completedAtMs: AEC_PLAYBACK_STARTED_AT_MS + 1_100,
      },
      dynamicDelay: {
        status: 'completed', stage: 'dynamic-delay', ordinal: 2, delayMs: 80, nonlinearity: 'none',
        source: 'runtime-physical-render', playbackSource: 'native-omni',
        referenceFrames: 4800, physicalFrames: 8640, changedSamples: 0, changedRatio: 0,
        started: true, completed: true,
        startedAtMs: AEC_PLAYBACK_STARTED_AT_MS + 2_000,
        completedAtMs: AEC_PLAYBACK_STARTED_AT_MS + 2_100,
      },
      nonlinear: {
        status: 'completed', stage: 'nonlinear', ordinal: 3, delayMs: 160, nonlinearity: 'soft-clip',
        source: 'runtime-physical-render', playbackSource: 'native-omni',
        referenceFrames: 4800, physicalFrames: 12480, changedSamples: 9600, changedRatio: 1,
        started: true, completed: true,
        startedAtMs: AEC_PLAYBACK_STARTED_AT_MS + 3_000,
        completedAtMs: AEC_PLAYBACK_STARTED_AT_MS + 3_100,
      },
    },
    expectedSubtitles: {
      referenceSource: 'watch-mode-en-original-transcript',
      acceptedSource: 'watch-session-report-cues',
      watchSessionId: 'watch-test-session',
      acceptedCueCount: 3,
      acceptedCueIds: ['cue-1', 'cue-2', 'cue-3'],
      expectedSegmentCount: 6,
      acceptedSegmentCount: 6,
      acceptanceRate: 1,
    },
  },
};

const PROCESS_METRICS_STARTED_AT_MS = Date.parse('2026-06-05T10:43:32.000Z');
const healthyProcessRestartData = {
  completed: true,
  evidenceMode: 'live',
  fixtureOnly: false,
  identityChanged: true,
  frameContinuity: true,
  runtimeReady: true,
  playbackRebound: true,
  timingValid: true,
  metricsProveTransition: true,
  oldBridgeProcessId: 4242,
  newBridgeProcessId: 4343,
  oldBridgeInstanceId: 'instance-old',
  newBridgeInstanceId: 'instance-new',
  oldSessionId: 'session-old',
  newSessionId: 'session-new',
  oldSourceGeneration: 101,
  newSourceGeneration: 202,
  oldSourceGenerationToken: 'token-old',
  newSourceGenerationToken: 'token-new',
  oldPlaybackOwnerGeneration: 1001,
  newPlaybackOwnerGeneration: 2002,
  oldPhysicalPlaybackDeviceId: '{hda-test-endpoint}',
  newPhysicalPlaybackDeviceId: '{hda-test-endpoint}',
  physicalPlaybackStatus: 'ready',
  physicalPlaybackRebindDurationMs: 250,
  oldLastFrameTimestampMs: PROCESS_METRICS_STARTED_AT_MS + 899_000,
  oldLastFrameReadTimestampMs: PROCESS_METRICS_STARTED_AT_MS + 899_100,
  newFirstFrameTimestampMs: PROCESS_METRICS_STARTED_AT_MS + 901_000,
  newFirstFrameReadTimestampMs: PROCESS_METRICS_STARTED_AT_MS + 901_100,
  startedAtMs: PROCESS_METRICS_STARTED_AT_MS,
  restartTriggeredAtMs: PROCESS_METRICS_STARTED_AT_MS + 900_000,
  recoveredAtMs: PROCESS_METRICS_STARTED_AT_MS + 902_000,
  downtimeMs: 2_000,
  sourceFramesBefore: 43_200_000,
  sourceFramesAfter: 43_296_000,
  oldFramesAfterRestart: 0,
  excludedProcessId: 4343,
  processLoopbackStatus: 'ready',
  captureBackend: 'wasapi-process-exclusion',
  sourceSubscriberActive: true,
  systemMetrics: {
    valid: true,
    sampleCount: 1_799,
    durationMs: 1_798_000,
    samplesWithOldPid: 899,
    samplesWithNewPid: 899,
    oldPidAbsentAfterNew: true,
    startedAt: new Date(PROCESS_METRICS_STARTED_AT_MS).toISOString(),
    finishedAt: new Date(PROCESS_METRICS_STARTED_AT_MS + 1_800_000).toISOString(),
  },
};

function echoCancelLayers() {
  const layers = Object.fromEntries(REQUIRED_LAYERS.map((layer) => [
    layer,
    ECHO_CANCEL_REQUIRED_LAYERS.includes(layer)
      ? {
          status: 'passed',
          reason: null,
        }
      : { status: 'skipped', reason: 'echo-cancel variant does not require this evidence layer' },
  ]));
  layers.aec = {
    status: 'passed',
    reason: null,
    data: structuredClone(healthyAecScenarioData),
  };
  return layers;
}

function processExclusionLayers() {
  const layers = strictContentLayers();
  layers.bridge.data = {
    processExclusionRestart: structuredClone(healthyProcessRestartData),
  };
  return layers;
}

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'watch-mode-evidence-'));
}

function writePcm16Wav(filePath, {
  sampleRate = 16_000,
  channels = 1,
  durationSeconds = 1,
  tones = [],
} = {}) {
  const frames = Math.round(sampleRate * durationSeconds);
  const dataBytes = frames * channels * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write('WAVEfmt ', 8, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * channels * 2, 28);
  wav.writeUInt16LE(channels * 2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataBytes, 40);
  for (let frame = 0; frame < frames; frame += 1) {
    const seconds = frame / sampleRate;
    const sample = tones.reduce(
      (sum, tone) => sum + tone.amplitude * Math.sin(2 * Math.PI * tone.frequencyHz * seconds),
      0,
    );
    const pcm = Math.max(-32_768, Math.min(32_767, Math.round(sample * 32_767)));
    for (let channel = 0; channel < channels; channel += 1) {
      wav.writeInt16LE(pcm, 44 + (frame * channels + channel) * 2);
    }
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, wav);
  return frames;
}

function pcmBuffer(samples) {
  const bytes = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) {
    bytes.writeInt16LE(
      Math.max(-32_768, Math.min(32_767, Math.round(samples[index] * 32_767))),
      index * 2,
    );
  }
  return bytes;
}

function deterministicTranslatedCue(seed, sampleRateHz = 24_000, seconds = 1.4) {
  const output = new Float32Array(Math.round(sampleRateHz * seconds));
  let state = seed >>> 0;
  for (let index = 0; index < output.length; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const noise = (state / 0xffff_ffff) * 2 - 1;
    const envelope = Math.sin(Math.PI * index / output.length) ** 0.5;
    const tone = Math.sin(
      2 * Math.PI * (180 + seed * 7 + index / sampleRateHz * 90) * index / sampleRateHz,
    );
    output[index] = envelope * (0.38 * noise + 0.32 * tone);
  }
  return output;
}

function renderBridgeReferenceToLoopback(samples, sourceRateHz) {
  const bridgeRateHz = 48_000;
  const bridge = new Float32Array(Math.max(1, Math.floor(samples.length * bridgeRateHz / sourceRateHz)));
  for (let index = 0; index < bridge.length; index += 1) {
    bridge[index] = samples[Math.min(samples.length - 1, Math.floor(index * sourceRateHz / bridgeRateHz))];
  }
  const output = new Float32Array(Math.max(1, Math.floor(bridge.length * 16_000 / bridgeRateHz)));
  for (let index = 0; index < output.length; index += 1) {
    const source = index * bridgeRateHz / 16_000;
    const left = Math.min(bridge.length - 1, Math.floor(source));
    const right = Math.min(bridge.length - 1, left + 1);
    output[index] = bridge[left] + (bridge[right] - bridge[left]) * (source - left);
  }
  return output;
}

function fixtureLocalTimestamp(epochMs) {
  const value = new Date(epochMs);
  const pad = (number, length = 2) => String(number).padStart(length, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} `
    + `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`
    + `.${pad(value.getMilliseconds(), 3)}`;
}

function writeTranslatedPcmLoopbackFixture(runDirectory, {
  runMarker,
  cellId,
  leaseId,
  modelId,
  protocol,
}) {
  const authorityDirectory = path.join(runDirectory, 'translated-cue-pcm');
  const cueDirectory = path.join(authorityDirectory, 'cue-pcm');
  fs.mkdirSync(cueDirectory, { recursive: true });
  const recordingStartedAtEpochMs = new Date(2026, 7, 13, 12, 0, 0, 0).getTime();
  const cueIds = ['authority-cue-1', 'authority-cue-2'];
  const playbackOffsetsSeconds = [2.2, 5.8];
  const canonical = loadCanonicalFixtureAuthority();
  const sourceLagSamples = 16_000;
  const recording = new Float32Array(canonical.referencePcm.samples + sourceLagSamples);
  for (let index = 0; index < canonical.referencePcm.samples; index += 1) {
    recording[sourceLagSamples + index] = canonical.referencePcm.buffer.readInt16LE(index * 2)
      / 32_768 * 0.25;
  }
  const acceptedCues = [];
  for (let index = 0; index < cueIds.length; index += 1) {
    const samples = deterministicTranslatedCue(11 + index * 19);
    const bytes = pcmBuffer(samples);
    const relativePath = `cue-pcm/${index + 1}.pcm`;
    fs.writeFileSync(path.join(authorityDirectory, relativePath), bytes);
    const loopback = renderBridgeReferenceToLoopback(samples, 24_000);
    const start = Math.round(playbackOffsetsSeconds[index] * 16_000);
    for (let offset = 0; offset < loopback.length; offset += 1) {
      recording[start + offset] = Math.max(
        -0.99,
        Math.min(0.99, recording[start + offset] + loopback[offset] * 0.6),
      );
    }
    acceptedCues.push({
      sequence: index + 1,
      cueId: cueIds[index],
      requestIds: [`request-${index + 1}`],
      sampleRateHz: 24_000,
      channelCount: 1,
      sampleCount: samples.length,
      frameCount: samples.length,
      bytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      relativePath,
      acceptedFrames: samples.length,
      chunkCount: 1,
      chunks: [{
        chunkIndex: 0,
        requestId: `request-${index + 1}`,
        sampleOffset: 0,
        sampleCount: samples.length,
        acceptedAtMs: recordingStartedAtEpochMs + playbackOffsetsSeconds[index] * 1_000,
      }],
      createdAtMs: recordingStartedAtEpochMs + playbackOffsetsSeconds[index] * 1_000 - 50,
      completedAtMs: recordingStartedAtEpochMs
        + (playbackOffsetsSeconds[index] + samples.length / 24_000) * 1_000,
      bridgeInstanceId: index === 0 ? 'bridge-instance-old' : 'bridge-instance-new',
      playbackOwnerGeneration: index === 0 ? 1001 : 2002,
      physicalPlaybackDeviceId: '{hda-test-endpoint}',
    });
  }
  const physicalPcmPath = path.join(runDirectory, 'physical-output-recording-16k-mono.pcm');
  const sourceWindowPath = path.join(
    runDirectory,
    'physical-output-recording-source-window-16k-mono.pcm',
  );
  const physicalPcm = pcmBuffer(recording);
  fs.writeFileSync(physicalPcmPath, physicalPcm);
  fs.writeFileSync(sourceWindowPath, physicalPcm);
  const recordingAuthorityPath = path.join(runDirectory, 'physical-output-recording.json');
  const recordingAuthority = JSON.parse(fs.readFileSync(recordingAuthorityPath, 'utf8'));
  fs.writeFileSync(recordingAuthorityPath, `${JSON.stringify({
    ...recordingAuthority,
    passed: true,
    recordingStartedAtEpochMs,
    transcriptionPcmPath: physicalPcmPath,
  }, null, 2)}\n`, 'utf8');
  const watchReportPath = path.join(runDirectory, 'watch-session-report.json');
  const watchReport = JSON.parse(fs.readFileSync(watchReportPath, 'utf8'));
  watchReport.cues = cueIds.map((cueId, index) => ({
    ...structuredClone(healthyWatchSessionReport.cues[0]),
    cueId,
    llmText: `translated text ${index + 1}`,
    publishedText: `translated text ${index + 1}`,
    renderedText: `translated text ${index + 1}`,
  }));
  fs.writeFileSync(watchReportPath, `${JSON.stringify(watchReport, null, 2)}\n`, 'utf8');
  const identity = {
    schemaVersion: 1,
    artifactKind: 'watch-mode-translated-cue-pcm-authority',
    cellId,
    leaseId,
    runMarker,
    sessionGeneration: 1,
    direction: 'inbound',
    model: modelId,
    protocol,
  };
  const summary = {
    ...identity,
    maxProviderInputSamples: 2_880_000,
    pcmFormat: 's16le',
    cueCount: acceptedCues.length,
    totalSamples: acceptedCues.reduce((sum, cue) => sum + cue.sampleCount, 0),
    totalBytes: acceptedCues.reduce((sum, cue) => sum + cue.bytes, 0),
    abortedStreamCount: 0,
    activeStreamCount: 0,
    acceptedCues,
    finalized: true,
    terminalReason: 'worker-completed',
  };
  fs.writeFileSync(
    path.join(authorityDirectory, 'translated-cue-pcm-summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
    'utf8',
  );
  const journal = [
    { ...identity, event: 'initialized', sequence: 1, occurredAtMs: recordingStartedAtEpochMs },
    ...acceptedCues.map((cue, index) => ({
      ...identity,
      event: 'bridge_write_accepted',
      sequence: index + 2,
      occurredAtMs: cue.completedAtMs,
      detail: cue,
    })),
    {
      ...identity,
      event: 'finalized',
      sequence: acceptedCues.length + 2,
      occurredAtMs: recordingStartedAtEpochMs + 8_000,
    },
  ];
  fs.writeFileSync(
    path.join(authorityDirectory, 'translated-cue-pcm-authority.jsonl'),
    `${journal.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    'utf8',
  );
  const lifecycleLines = [];
  for (let index = 0; index < cueIds.length; index += 1) {
    const startMs = recordingStartedAtEpochMs + playbackOffsetsSeconds[index] * 1_000;
    lifecycleLines.push(`${fixtureLocalTimestamp(startMs - 20)} [NORMAL] event=translation_playback_status | cueId=${cueIds[index]} status=queued`);
    lifecycleLines.push(`${fixtureLocalTimestamp(startMs)} [NORMAL] event=translation_playback_status | cueId=${cueIds[index]} status=started`);
    lifecycleLines.push(`${fixtureLocalTimestamp(startMs + 1_400)} [NORMAL] event=translation_playback_status | cueId=${cueIds[index]} status=completed`);
  }
  fs.appendFileSync(path.join(runDirectory, 'app.log'), `${lifecycleLines.join('\n')}\n`, 'utf8');
  const authority = buildTranslatedPcmLoopbackAuthority({
    runDirectory,
    runMarker,
    recordingStartedAtEpochMs,
    cellId,
    leaseId,
    modelId,
    protocol,
  });
  assert.equal(authority.passed, true, authority.violations.join('; '));
  fs.writeFileSync(
    path.join(runDirectory, 'translated-pcm-loopback.stdout.json'),
    `${JSON.stringify(authority, null, 2)}\n`,
    'utf8',
  );
  const physicalAuthorityPath = path.join(runDirectory, 'physical-output-content.raw.json');
  const physicalAuthority = JSON.parse(fs.readFileSync(physicalAuthorityPath, 'utf8'));
  const sourceWaveform = buildPhysicalSourceWaveformAuthority({ runDirectory });
  assert.equal(sourceWaveform.passed, true, sourceWaveform.violations.join('; '));
  physicalAuthority.recording = {
    ...physicalAuthority.recording,
    passed: true,
    recordingPath: 'physical-output-recording.wav',
    transcriptionPcmPath: 'physical-output-recording-16k-mono.pcm',
    capturedFrames: recording.length,
    rms: 0.1,
  };
  physicalAuthority.sttSourceWindow = {
    path: sourceWindowPath,
    sampleRateHz: 16_000,
    seconds: physicalPcm.length / 2 / 16_000,
    bytes: physicalPcm.length,
  };
  physicalAuthority.originalPassthrough = {
    authority: 'canonical-source-signed-waveform-v1',
    sourceSimilarity: sourceWaveform,
  };
  physicalAuthority.translatedSpeech.acousticAuthority = authority;
  fs.writeFileSync(
    physicalAuthorityPath,
    `${JSON.stringify(physicalAuthority, null, 2)}\n`,
    'utf8',
  );
  writeDirectoryReport({ inputDir: runDirectory, outputDir: runDirectory, mode: 'live' });
  return authority;
}

function writeReport(root, directoryName, overrides = {}) {
  const directory = path.join(root, directoryName);
  fs.mkdirSync(directory, { recursive: true });
  const layers = Object.fromEntries(REQUIRED_LAYERS.map((layer) => [layer, { status: 'passed', reason: null }]));
  const report = {
    schemaVersion: 1,
    generatedAt: '2026-06-05T11:13:32.000Z',
    commit: 'fixture-commit',
    provenance: CLEAN_CURRENT_PROVENANCE,
    mode: 'live',
    translationRoute: 'secondary',
    verdict: 'passed',
    failureLayer: null,
    layers,
    watchSessionReport: healthyWatchSessionReport,
    ...overrides,
  };
  fs.writeFileSync(path.join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

function writeAuthorityRawCell(root, directoryName, {
  modelId = 'qwen3.5-omni-flash-realtime',
  feedbackLoopPrevention = 'echo-cancel',
  deviceClass = 'default-speaker',
  profileId = 'authority-profile',
  runtimeBinaryHashes = [],
  healthyBridgeProbe = false,
} = {}) {
  const directory = path.join(root, directoryName);
  fs.mkdirSync(directory, { recursive: true });
  const generatedAt = new Date(Date.now() - 2_000);
  const metricsStartedAt = new Date(generatedAt.getTime() - MIN_STRICT_SESSION_DURATION_MS);
  const desktopProcessId = 6001;
  const device = deviceEvidence(deviceClass, { profileId });
  const snapshots = {
    runMarker: 'watch_mode_diagnostic.run_id=authority-fixture',
    startedAtLocal: '2026-08-10 10:00:00',
    modelId,
    feedbackLoopPrevention,
    deviceEvidence: device,
    translationRoute: 'native',
    app: {},
    provider: {},
    speechSegmentation: {},
  };
  const jsonArtifacts = {
    'driver.json': { error: 'authority fixture driver did not run' },
    'bridge-source-probe.json': healthyBridgeProbe
      ? {
          passed: true,
          sourceFrame: { payloadBytes: 3_840 },
          state: {
            bridgeState: 'ready',
            driverHealth: 'running',
            sourceCaptureMode: feedbackLoopPrevention === 'process-exclusion'
              ? 'process-exclusion'
              : 'virtual-speaker',
            captureBackend: feedbackLoopPrevention === 'process-exclusion'
              ? 'wasapi-process-exclusion'
              : 'driver-ring',
            processLoopbackSupported: true,
            processLoopbackStatus: 'ready',
            windowsBuildNumber: 26_200,
            processLoopbackMinimumWindowsBuild: 20_348,
            excludedProcessId: 8_001,
            sourceSubscriberActive: true,
            sourceReadCalls: 1,
            droppedFrameCount: 0,
            lastErrorCode: null,
          },
        }
      : { passed: false, error: 'authority fixture bridge probe' },
    'physical-output-probe.json': { error: 'authority fixture physical probe' },
    'physical-playback-device.json': device,
    'playback.json': {
      playbackMode: 'wasapi-media-injector',
      mediaSha256: sha256File(path.resolve('scripts/testing/fixtures/watch-mode-en-original.wav')),
      injectorProcessId: 7001,
      startedAtMs: metricsStartedAt.getTime() + 1_000,
      finishedAtMs: generatedAt.getTime() - 1_000,
    },
    'watch-session-report.json': {
      ...healthyWatchSessionReport,
      sessionId: `authority-${directoryName}`,
      cues: feedbackLoopPrevention === 'echo-cancel'
        ? healthyWatchSessionReport.cues.map((cue) => ({
            ...cue,
            sourceText: fs.readFileSync(
              path.resolve('scripts/testing/fixtures/watch-mode-en-original.txt'),
              'utf8',
            ).trim(),
          }))
        : healthyWatchSessionReport.cues,
    },
    'system-metrics.json': {
      artifactKind: 'watch-mode-system-metrics',
      collector: 'scripts/testing/collect-watch-mode-system-metrics.ps1',
      scope: 'process-tree',
      rootProcessId: desktopProcessId,
      startedAt: metricsStartedAt.toISOString(),
      finishedAt: generatedAt.toISOString(),
      completionReason: 'root-process-exited',
      sampleCount: 2,
      collectionErrors: [],
      samples: [{
        timestamp: new Date(metricsStartedAt.getTime() + 1_000).toISOString(),
        elapsedMs: 1_000,
        processCount: 1,
        processIds: [desktopProcessId],
        processNamesById: { [desktopProcessId]: 'omni-desktop-shell' },
        bridgeProcessIds: [],
        cpuPercent: 1,
        workingSetMb: 100,
      }, {
        timestamp: generatedAt.toISOString(),
        elapsedMs: MIN_STRICT_SESSION_DURATION_MS,
        processCount: 1,
        processIds: [desktopProcessId],
        processNamesById: { [desktopProcessId]: 'omni-desktop-shell' },
        bridgeProcessIds: [],
        cpuPercent: 1,
        workingSetMb: 100,
      }],
    },
  };
  jsonArtifacts['run-metadata.json'] = {
    schemaVersion: 'watch-mode-run-metadata/v1', runMarker: snapshots.runMarker,
    startedAtLocal: snapshots.startedAtLocal, modelId: snapshots.modelId,
    feedbackMode: feedbackLoopPrevention,
  };
  jsonArtifacts['run-collection.json'] = {
    schemaVersion: 'watch-mode-run-collection/v2',
    artifactKind: 'watch-mode-run-collection',
    request: { schemaVersion: 'watch-mode-run-request/v1', runMode: 'live', feedbackMode: feedbackLoopPrevention, model: { id: snapshots.modelId } },
    collectionStatus: 'completed',
    steps: [{
      schemaVersion: 'watch-mode-step/v1',
      id: 'start-desktop-shell',
      phase: 'desktopLaunch',
      status: 'passed',
      data: { pid: desktopProcessId, systemMetricsSampler: { rootProcessId: desktopProcessId } },
      error: null,
    }],
    ownedProcesses: [],
    artifacts: {
      runMetadata: 'run-metadata.json', appLog: 'app.log', bridgeLog: 'bridge-service.log',
      driverProbe: 'driver.json', bridgeSourceProbe: 'bridge-source-probe.json',
      physicalOutputProbe: 'physical-output-probe.json', physicalPlaybackDevice: 'physical-playback-device.json',
      playback: 'playback.json', watchSessionReport: 'watch-session-report.json',
      systemMetrics: 'system-metrics.json',
    },
    primaryError: null,
    cleanupErrors: [],
  };
  if (feedbackLoopPrevention !== 'echo-cancel') {
    jsonArtifacts['physical-output-content.raw.json'] = { passed: false, detail: 'authority fixture' };
    jsonArtifacts['physical-output-recording.json'] = { passed: false, capturedFrames: 1 };
    jsonArtifacts['source-media-transcript.json'] = { passed: false, transcript: '' };
  }
  for (const [relativePath, value] of Object.entries(jsonArtifacts)) {
    fs.writeFileSync(path.join(directory, relativePath), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  }
  const appLogLines = [
    snapshots.runMarker,
    'watch_mode.route_start subtitleTranslationMode=native translationAudioSource=omni-native',
    'watch_mode.omni_preconnect_started detail=direction=inbound sid=authority-fixture',
    'watch_mode.omni_preconnect_reused detail=direction=inbound sid=authority-fixture',
  ];
  if (feedbackLoopPrevention === 'echo-cancel') {
    const playbackStartedAtMs = metricsStartedAt.getTime() + 1_000;
    appLogLines.push(
      `watch_mode.omni_session_config | model=${modelId} realtimeAudioMode=server_vad outputMode=text-and-audio inputAudioFormat=pcm16 isLivetranslate=false subtitleTranslateActive=false sid=authority-fixture`,
      '[AUDIO] playback request received: cue_id=authority-aec samples=24000 sample_rate_hz=24000 duration_ms=1000 enabled=true local_playback=true virtual_mic=false sid=authority-fixture',
      '[AUDIO] speaker playback completed: cue_id=authority-aec frames=24000 sample_rate_hz=24000 sid=authority-fixture',
      'event=echo_cancel_backend | backend=webrtc-aec3 frameMs=10 renderSubmitFormat=48000-f32-stereo renderClock=wasapi-submit-position endpointRenderPadding=same-client-get-current-padding webRtcAec3Ready=true msvcBuildVerified=true linkedBackendPresent=true fixtureVerified=true sid=authority-fixture',
      'event=echo_cancel_summary | direction=inbound backend=webrtc-aec3 render10msFrames=50 capture10msFrames=50 processedCapture10msFrames=50 resetCount=1 rejectedFrames=0 statsReadFailures=0 renderUnderruns=0 captureUnderruns=0 erleDb=10.0 residualEchoLikelihood=0.08 reportedDelayMs=0 doubleTalkFrames=0 avgProcessingUs=110.0 maxProcessingUs=230 captureChunks=50 intervalCaptureChunks=50 playbackActiveChunks=40 asrForwardedChunks=50 asrDeletedChunks=0 avgPreDb=-40.0 avgPostDb=-50.0 avgRemovedDb=10.0 sid=authority-fixture',
      'event=echo_cancel_summary | direction=inbound backend=webrtc-aec3 render10msFrames=100 capture10msFrames=100 processedCapture10msFrames=100 resetCount=1 rejectedFrames=0 statsReadFailures=0 renderUnderruns=0 captureUnderruns=0 erleDb=20.0 residualEchoLikelihood=0.02 reportedDelayMs=125 doubleTalkFrames=12 avgProcessingUs=120.0 maxProcessingUs=250 captureChunks=100 intervalCaptureChunks=100 playbackActiveChunks=90 asrForwardedChunks=100 asrDeletedChunks=0 avgPreDb=-40.0 avgPostDb=-60.0 avgRemovedDb=20.0 sid=authority-fixture',
      `event=aec_live_scenario_stage status=completed cueId=authority-aec-1 stage=double-talk ordinal=1 delayMs=0 nonlinearity=none referenceFrames=4800 physicalFrames=4800 changedSamples=0 changedRatio=0.000000 started=true completed=true startedAtMs=${playbackStartedAtMs + 1_000} completedAtMs=${playbackStartedAtMs + 1_100} source=runtime-physical-render playbackSource=native-omni`,
      `event=aec_live_scenario_stage status=completed cueId=authority-aec-2 stage=dynamic-delay ordinal=2 delayMs=80 nonlinearity=none referenceFrames=4800 physicalFrames=8640 changedSamples=0 changedRatio=0.000000 started=true completed=true startedAtMs=${playbackStartedAtMs + 2_000} completedAtMs=${playbackStartedAtMs + 2_100} source=runtime-physical-render playbackSource=native-omni`,
      `event=aec_live_scenario_stage status=completed cueId=authority-aec-3 stage=nonlinear ordinal=3 delayMs=160 nonlinearity=soft-clip referenceFrames=4800 physicalFrames=12480 changedSamples=9600 changedRatio=1.000000 started=true completed=true startedAtMs=${playbackStartedAtMs + 3_000} completedAtMs=${playbackStartedAtMs + 3_100} source=runtime-physical-render playbackSource=native-omni`,
      'watch route ensured subtitle overlay visible detail=label=subtitle-overlay visible=true sid=authority-fixture',
      'subtitle cue appended id=cue-1 sid=authority-fixture',
      'model_trace finished status=ok elapsedMs=1200 sid=authority-fixture',
    );
  }
  fs.writeFileSync(path.join(directory, 'app.log'), `${appLogLines.join('\n')}\n`, 'utf8');
  fs.writeFileSync(path.join(directory, 'bridge-service.log'), 'authority bridge log\n', 'utf8');
  const canonical = loadCanonicalFixtureAuthority();
  fs.writeFileSync(
    path.join(directory, 'source-media-reference-16k-mono.pcm'),
    canonical.referencePcm.buffer,
  );
  fs.writeFileSync(
    path.join(directory, 'provider-input-16k-mono.pcm'),
    canonical.referencePcm.buffer,
  );
  for (const relativePath of requiredCellArtifactPaths(feedbackLoopPrevention)) {
    const filePath = path.join(directory, ...relativePath.split('/'));
    if (fs.existsSync(filePath) || ['report.json', 'report.md'].includes(relativePath)) continue;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, Buffer.from([1, 2, 3, 4]));
  }
  if (feedbackLoopPrevention !== 'echo-cancel') {
    const recordingFrames = writePcm16Wav(
      path.join(directory, 'physical-output-recording.wav'),
      {
        durationSeconds: 60,
        tones: [{ frequencyHz: 440, amplitude: 0.1 }],
      },
    );
    fs.writeFileSync(path.join(directory, 'physical-output-recording.json'), `${JSON.stringify({
      passed: true,
      capturedFrames: recordingFrames,
    })}\n`, 'utf8');
    fs.writeFileSync(path.join(directory, 'physical-output-content.raw.json'), `${JSON.stringify({
      passed: true,
      recording: {
        passed: true,
        recordingPath: 'physical-output-recording.wav',
        transcriptionPcmPath: 'physical-output-recording-16k-mono.pcm',
        capturedFrames: 960_000,
        rms: 0.07,
      },
    })}\n`, 'utf8');
    if (feedbackLoopPrevention === 'virtual-driver') {
      const runtimeSha256 = (relativePath, fallback) => runtimeBinaryHashes
        .find((entry) => entry.path === relativePath)?.sha256 ?? fallback;
      fs.writeFileSync(path.join(directory, 'driver.json'), `${JSON.stringify({
        Endpoint: 'Omni Translate Synthetic Virtual Speaker',
        ToneFrames: 4_800,
        ToneRms: 0.08,
        InvalidSamples: 0,
        InstalledDriverAuthority: {
          installedServiceName: 'omni_translate_virtual_speaker',
          installedServiceState: 'Running',
          installedSysPath: 'C:\\Windows\\System32\\DriverStore\\omni-virtual-speaker.sys',
          installedSysSha256: runtimeSha256(
            'drivers/windows-virtual-mic/package/omni-virtual-speaker.sys',
            'driver-package-hash',
          ),
          packageSysSha256: runtimeSha256(
            'drivers/windows-virtual-mic/package/omni-virtual-speaker.sys',
            'driver-package-hash',
          ),
          packageCatSha256: runtimeSha256(
            'drivers/windows-virtual-mic/package/omni-virtual-speaker.cat',
            'driver-catalog-hash',
          ),
          packageInfSha256: runtimeSha256(
            'drivers/windows-virtual-mic/package/omni-virtual-speaker.inf',
            'driver-inf-hash',
          ),
          installedInfName: 'oem42.inf',
          installedDriverVersion: '0.10.0-dev',
          installedSysSignatureStatus: 'Valid',
          installedSysSignerThumbprint: 'fixture-thumbprint',
          packageCatalogSignatureStatus: 'Valid',
          packageCatalogSignerThumbprint: 'fixture-thumbprint',
        },
      })}\n`, 'utf8');
      fs.writeFileSync(path.join(directory, 'physical-output-probe.json'), `${JSON.stringify({
        passed: true,
        probeKind: 'bridge-physical-output',
        resolvedPhysicalPlaybackDeviceId: device.resolvedDeviceId,
        playbackFramesWrittenBefore: 0,
        playbackFramesWrittenAfter: 96_000,
        capturedFrames: 96_000,
        rms: 0.08,
        toneComponent: 0.08,
        invalidSamples: 0,
      })}\n`, 'utf8');
    }
  }
  if (feedbackLoopPrevention === 'process-exclusion') {
    const runtimeRoot = path.join(directory, 'physical-output-probe-runtime');
    writePcm16Wav(path.join(runtimeRoot, 'process-exclusion-physical-output.wav'), {
      sampleRate: 48_000,
      channels: 2,
      durationSeconds: 2,
      tones: [
        { frequencyHz: 997, amplitude: 0.08 },
        { frequencyHz: 1_733, amplitude: 0.08 },
        { frequencyHz: 2_449, amplitude: 0.08 },
      ],
    });
    writePcm16Wav(path.join(runtimeRoot, 'process-exclusion-source-pipe.wav'), {
      sampleRate: 48_000,
      channels: 2,
      durationSeconds: 2,
      tones: [{ frequencyHz: 1_733, amplitude: 0.08 }],
    });
    const fingerprint = {
      bridgeProcessId: 8001,
      excludedProcessId: 8001,
      externalPlayerProcessId: 8002,
      bridgeChildPlayerProcessId: 8003,
      bridgeChildParentProcessId: 8001,
      sourceCaptureMode: 'process-exclusion',
      captureBackend: 'wasapi-process-exclusion',
      processLoopbackStatus: 'ready',
      translationFrequencyHz: 997,
      externalFrequencyHz: 1_733,
      bridgeChildFrequencyHz: 2_449,
      translationComponentLimit: 0.003,
    };
    fs.writeFileSync(path.join(directory, 'physical-output-probe.json'), `${JSON.stringify({
      passed: true,
      probeKind: 'process-exclusion-fingerprint',
      resolvedPhysicalPlaybackDeviceId: device.resolvedDeviceId,
      playbackFramesWrittenBefore: 0,
      playbackFramesWrittenAfter: 96_000,
      capturedFrames: 96_000,
      rms: 0.08,
      toneComponent: 0.08,
      invalidSamples: 0,
      processExclusionFingerprint: fingerprint,
    })}\n`, 'utf8');
  }
  if (feedbackLoopPrevention !== 'echo-cancel') {
    const referencePcmPath = path.join(directory, 'source-media-reference-16k-mono.pcm');
    fs.writeFileSync(path.join(directory, 'source-media-transcript.json'), `${JSON.stringify({
      schemaVersion: 2,
      passed: true,
      authorityMode: 'canonical-fixture-local-v2',
      remoteProviderCalls: 0,
      externalAudioSeconds: 0,
      mediaPath: 'scripts/testing/fixtures/watch-mode-en-original.wav',
      fullMedia: true,
      playbackSeconds: null,
      mediaSha256: canonical.media.sha256,
      mediaBytes: canonical.media.bytes,
      checksumPath: 'scripts/testing/fixtures/watch-mode-en-original.sha256',
      metadataPath: 'scripts/testing/fixtures/watch-mode-audio-fixtures.json',
      source: canonical.sourceText.text,
      translation: canonical.translationText.text,
      sourceText: {
        path: 'scripts/testing/fixtures/watch-mode-en-original.txt',
        bytes: canonical.sourceText.bytes,
        sha256: canonical.sourceText.sha256,
      },
      translationText: {
        path: 'scripts/testing/fixtures/watch-mode-en-original.zh-CN.txt',
        bytes: canonical.translationText.bytes,
        sha256: canonical.translationText.sha256,
      },
      referencePcm: {
        path: 'source-media-reference-16k-mono.pcm',
        bytes: canonical.referencePcm.bytes,
        samples: canonical.referencePcm.samples,
        sampleRateHz: 16_000,
        channels: 1,
        durationSeconds: Number(canonical.referencePcm.durationSeconds.toFixed(6)),
        sha256: canonical.referencePcm.sha256,
      },
      fixture: canonical.fixture,
    }, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(directory, 'physical-output-content.raw.json'), `${JSON.stringify({
      passed: true,
      authorityMode: 'local-pcm-cue-playback-v1',
      remoteProviderCalls: 0,
      externalAudioSeconds: 0,
      recording: {
        passed: true,
        recordingPath: 'physical-output-recording.wav',
        transcriptionPcmPath: 'physical-output-recording-16k-mono.pcm',
        capturedFrames: 960_000,
        rms: 0.07,
      },
      originalPassthrough: { sourceSimilarity: { passed: true } },
      contentConsistency: { structuredEvidence: { passed: true } },
      translatedSpeech: {
        playbackAuthority: { passed: true, invalidCues: [] },
        acousticAuthority: { passed: true },
      },
    }, null, 2)}\n`, 'utf8');
  }
  const collectionPath = path.join(directory, 'run-collection.json');
  const collection = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));
  if (feedbackLoopPrevention !== 'echo-cancel') {
    collection.artifacts.physicalOutputContentRaw = 'physical-output-content.raw.json';
  }
  fs.writeFileSync(collectionPath, `${JSON.stringify(collection, null, 2)}\n`, 'utf8');
  writeDirectoryReport({ inputDir: directory, outputDir: directory, mode: 'live' });
  return directory;
}

function writeStrictPaidBudgetFixture(runDirectory, cell, {
  generatedAt = new Date(),
  leaseId = `lease-${path.basename(runDirectory)}-${cell.cellId}`,
} = {}) {
  const collection = JSON.parse(fs.readFileSync(path.join(runDirectory, 'run-collection.json'), 'utf8'));
  const metadata = JSON.parse(fs.readFileSync(path.join(runDirectory, collection.artifacts.runMetadata), 'utf8'));
  const runMarker = metadata.runMarker;
  const providerPcmPath = path.join(runDirectory, 'provider-input-16k-mono.pcm');
  const totalAttemptedSamples = fs.statSync(providerPcmPath).size / 2;
  const maxSamples = Number(cell.durationSeconds) * 16_000;
  const identity = {
    schemaVersion: 1,
    artifactKind: 'watch-mode-provider-input-budget-ledger',
    cellId: cell.cellId,
    runMarker,
    direction: 'inbound',
    model: cell.modelId,
    protocol: STRICT_PAID_MODEL_PROTOCOLS[cell.modelId],
    ...STRICT_PAID_PROVIDER_IDENTITY,
  };
  const sessionGeneration = 1;
  fs.appendFileSync(
    path.join(runDirectory, 'app.log'),
    `input_audio_buffer.append.summary {"resampledSamplesTotal":${totalAttemptedSamples}}\n`,
    'utf8',
  );
  fs.writeFileSync(path.join(runDirectory, 'provider-input-budget-lease.json'), `${JSON.stringify({
    schemaVersion: 1,
    artifactKind: 'watch-mode-provider-input-budget-lease',
    leaseId,
    cellId: cell.cellId,
    runMarker,
    maxSamples,
  }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(runDirectory, 'provider-input-budget-ledger.json'), `${JSON.stringify({
    ...identity,
    leaseId,
    sessionGeneration,
    maxSamples,
    totalAttemptedSamples,
    appendAttempts: 1,
    sendFailures: 0,
    initialConnectAttempts: 1,
    reconnects: 0,
    budgetExceeded: false,
    finalized: true,
    terminalReason: 'worker-completed',
  }, null, 2)}\n`, 'utf8');
  const journal = [{
    ...identity,
    sequence: 1,
    event: 'initialized',
    leaseId,
    sessionGeneration,
    maxSamples,
    occurredAtMs: 1,
    initialConnectAttempts: 0,
  }, {
    ...identity,
    sequence: 2,
    event: 'initial_connect_attempt',
    leaseId,
    sessionGeneration,
    maxSamples,
    occurredAtMs: 2,
    initialConnectAttempts: 1,
  }, {
    ...identity,
    sequence: 3,
    event: 'reserved',
    leaseId,
    sessionGeneration,
    maxSamples,
    occurredAtMs: 3,
    initialConnectAttempts: 1,
    attemptedSamples: totalAttemptedSamples,
  }, {
    ...identity,
    sequence: 4,
    event: 'finalized',
    leaseId,
    sessionGeneration,
    maxSamples,
    occurredAtMs: 4,
    initialConnectAttempts: 1,
    finalized: true,
  }];
  fs.writeFileSync(
    path.join(runDirectory, 'provider-input-budget-ledger.json.journal.jsonl'),
    `${journal.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    'utf8',
  );
  if (cell.feedbackLoopPrevention !== 'echo-cancel') {
    writeTranslatedPcmLoopbackFixture(runDirectory, {
      runMarker,
      cellId: cell.cellId,
      leaseId,
      modelId: cell.modelId,
      protocol: STRICT_PAID_MODEL_PROTOCOLS[cell.modelId],
    });
  }
  return writeCellExternalProviderBudget({
    runDirectory,
    runMarker,
    cellId: cell.cellId,
    modelId: cell.modelId,
    feedbackLoopPrevention: cell.feedbackLoopPrevention,
    translationMode: 'native',
    sessionCeilingSeconds: cell.durationSeconds,
    generatedAt,
  }).ledger;
}

function writeInteractiveSessionBundleFixture(runDirectory, {
  plan,
  lease,
  worker,
  shardRoot,
  baseMs,
}) {
  const ownerSid = `S-1-5-21-fixture-${lease.cellIndex + 1}`;
  const taskPid = 20_000 + lease.cellIndex * 100;
  const explorerPid = taskPid + 1;
  const nodePid = taskPid + 2;
  const processStart = new Date(baseMs + 100).toISOString();
  const launcherPath = 'C:\\fixture\\run-watch-mode-interactive-task.ps1';
  const scheduledCommandPath = `C:\\fixture\\interactive-command-${lease.cellIndex + 1}.json`;
  const common = {
    executionId: plan.executionId,
    planDigest: plan.planDigest,
    leaseId: lease.leaseId,
    leaseDigest: lease.leaseDigest,
    cellId: lease.cellId,
    workerId: worker.workerId,
  };
  const processIdentity = (pid, parentPid, imageName, startedAt = processStart) => ({
    pid,
    parentPid,
    sessionId: 1,
    imagePath: `C:\\fixture\\${imageName}`,
    imageSha256: crypto.createHash('sha256').update(imageName).digest('hex'),
    startedAt,
    ownerUser: worker.interactiveUser,
    ownerDomain: 'FIXTURE',
    ownerSid,
  });
  const writeComponent = (fileName, value) => {
    const filePath = path.join(runDirectory, fileName);
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    return { filePath, authority: fileAuthorityEntry(filePath, fileName) };
  };

  const command = writeComponent(SHARD_INTERACTIVE_COMMAND_FILE, {
    schemaVersion: 1,
    artifactKind: 'watch-mode-interactive-task-command',
    mode: 'shard-cell',
    ...common,
    feedbackLoopPrevention: plan.cells[lease.cellIndex].feedbackLoopPrevention,
    vmIdentityDigest: worker.vmIdentityDigest,
    expectedVmUuidBios: worker.vmIdentity.uuidBios,
    expectedUser: worker.interactiveUser,
    expectedUserSid: ownerSid,
    expectedSessionId: 1,
    taskName: `OmniPaid-fixture-${lease.cellIndex + 1}`,
    taskPath: '\\OmniTranslate\\',
    launcherPath,
    scheduledCommandPath,
    expectedUserId: `FIXTURE\\${worker.interactiveUser}`,
    launcherSha256: 'a'.repeat(64),
    shardRunnerSha256: 'b'.repeat(64),
    nodeSha256: 'c'.repeat(64),
  });
  const taskProcess = processIdentity(taskPid, 4, 'powershell.exe');
  const explorerProcess = processIdentity(explorerPid, 4, 'explorer.exe');
  const nodeProcess = processIdentity(nodePid, taskPid, 'node.exe');
  const launch = writeComponent(SHARD_INTERACTIVE_LAUNCH_FILE, {
    schemaVersion: 1,
    artifactKind: 'watch-mode-interactive-shard-launch-authority',
    launchedAt: new Date(baseMs + 200).toISOString(),
    ...common,
    vmIdentityDigest: worker.vmIdentityDigest,
    actualVmUuidBios: worker.vmIdentity.uuidBios,
    commandSha256: command.authority.sha256,
    user: worker.interactiveUser,
    ownerSid,
    sessionId: 1,
    desktop: 'WinSta0\\Default',
    taskName: `OmniPaid-fixture-${lease.cellIndex + 1}`,
    taskProcess,
    explorerProcess,
    nodeProcess,
    launcherSha256: 'a'.repeat(64),
    shardRunnerSha256: 'b'.repeat(64),
  });
  const release = writeComponent(SHARD_INTERACTIVE_CLAIM_RELEASE_FILE, {
    schemaVersion: 1,
    artifactKind: 'watch-mode-interactive-shard-claim-release',
    ...common,
    vmIdentityDigest: worker.vmIdentityDigest,
    commandSha256: command.authority.sha256,
    nodePid,
    nodeStartedAt: nodeProcess.startedAt,
    sessionId: 1,
    ownerSid,
    releasedAt: new Date(baseMs + 300).toISOString(),
  });
  const roleSpecs = [
    ['shard-node', nodePid, taskPid, 'node.exe'],
    ['cell-powershell', nodePid + 1, nodePid, 'powershell.exe'],
    ['desktop', nodePid + 2, nodePid + 1, 'omni-desktop-shell.exe'],
    ['bridge', nodePid + 3, nodePid + 2, 'omni-bridge-service.exe'],
    ...(plan.cells[lease.cellIndex].feedbackLoopPrevention === 'echo-cancel'
      ? []
      : [['recorder', nodePid + 4, nodePid + 1, 'omni-physical-output-probe.exe']]),
  ];
  const firstSeenAt = new Date(baseMs + 350).toISOString();
  const lastSeenAt = new Date(baseMs + 600).toISOString();
  const processes = roleSpecs.map(([role, pid, parentPid, imageName]) => ({
    role,
    ...processIdentity(pid, parentPid, imageName),
    commandLine: `${imageName} fixture`,
    firstSeenAt,
    lastSeenAt,
  }));
  const processAuthority = writeComponent(SHARD_INTERACTIVE_PROCESS_AUTHORITY_FILE, {
    schemaVersion: 1,
    artifactKind: 'watch-mode-interactive-process-authority',
    ...common,
    vmIdentityDigest: worker.vmIdentityDigest,
    rootProcessId: nodePid,
    expectedSessionId: 1,
    expectedOwnerSid: ownerSid,
    startedAt: new Date(baseMs + 325).toISOString(),
    completedAt: new Date(baseMs + 650).toISOString(),
    sampleIntervalMs: 250,
    processCount: processes.length,
    processes,
    errors: [],
    passed: true,
  });
  const execution = writeComponent(SHARD_INTERACTIVE_CELL_EXECUTION_FILE, {
    schemaVersion: 1,
    artifactKind: 'watch-mode-interactive-shard-cell-execution',
    ...common,
    vmIdentityDigest: worker.vmIdentityDigest,
    runDirectory: path.relative(shardRoot, runDirectory).replaceAll('\\', '/'),
    exitCode: 0,
    completedAt: new Date(baseMs + 700).toISOString(),
  });
  const terminal = writeComponent(SHARD_INTERACTIVE_TERMINAL_FILE, {
    schemaVersion: 1,
    artifactKind: 'watch-mode-interactive-task-terminal',
    mode: 'shard-cell',
    ...common,
    vmIdentityDigest: worker.vmIdentityDigest,
    commandSha256: command.authority.sha256,
    sessionId: 1,
    user: worker.interactiveUser,
    ownerSid,
    nodePid,
    nodeStartedAt: nodeProcess.startedAt,
    exitCode: 0,
    processAuthorityExitCode: 0,
    executionReceiptPath: `interactive/${lease.leaseId}/execution.json`,
    executionReceiptObserved: true,
    completedAt: new Date(baseMs + 800).toISOString(),
  });
  const taskTerminal = writeComponent(SHARD_INTERACTIVE_TASK_TERMINAL_FILE, {
    schemaVersion: 1,
    artifactKind: 'watch-mode-interactive-scheduled-task-terminal',
    mode: 'shard-cell',
    ...common,
    vmIdentityDigest: worker.vmIdentityDigest,
    commandSha256: command.authority.sha256,
    taskName: `OmniPaid-fixture-${lease.cellIndex + 1}`,
    taskPath: '\\OmniTranslate\\',
    actionExecute: 'powershell.exe',
    actionArguments: '-NoProfile -NonInteractive -ExecutionPolicy Bypass '
      + `-File "${launcherPath}" -RequestPath "${scheduledCommandPath}" `
      + `-ExpectedRequestSha256 ${command.authority.sha256}`,
    userId: `FIXTURE\\${worker.interactiveUser}`,
    logonType: 'InteractiveToken',
    runLevel: 'Limited',
    lastTaskResult: 0,
    terminalSha256: terminal.authority.sha256,
    completedAt: new Date(baseMs + 900).toISOString(),
  });
  const summary = {
    schemaVersion: 1,
    artifactKind: 'watch-mode-interactive-shard-session-authority',
    ...common,
    vmIdentityDigest: worker.vmIdentityDigest,
    user: worker.interactiveUser,
    ownerSid,
    sessionId: 1,
    command: command.authority,
    launch: launch.authority,
    release: release.authority,
    processAuthority: processAuthority.authority,
    terminal: terminal.authority,
    taskTerminal: taskTerminal.authority,
    execution: execution.authority,
  };
  return writeComponent(SHARD_INTERACTIVE_SESSION_AUTHORITY_FILE, summary);
}

function writeProcessExclusionRestartFixture(runDirectory) {
  const metricsPath = path.join(runDirectory, 'system-metrics.json');
  const metrics = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));
  const oldBridgeProcessId = 8_001;
  const newBridgeProcessId = 8_002;
  metrics.samples[0].bridgeProcessIds = [oldBridgeProcessId];
  metrics.samples[0].processIds.push(oldBridgeProcessId);
  metrics.samples[0].processCount = metrics.samples[0].processIds.length;
  metrics.samples[0].processNamesById[String(oldBridgeProcessId)] = 'omni-bridge-service';
  metrics.samples.at(-1).bridgeProcessIds = [newBridgeProcessId];
  metrics.samples.at(-1).processIds.push(newBridgeProcessId);
  metrics.samples.at(-1).processCount = metrics.samples.at(-1).processIds.length;
  metrics.samples.at(-1).processNamesById[String(newBridgeProcessId)] = 'omni-bridge-service';
  fs.writeFileSync(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`, 'utf8');
  const probePath = path.join(runDirectory, 'physical-output-probe.json');
  const probe = JSON.parse(fs.readFileSync(probePath, 'utf8'));
  Object.assign(probe.processExclusionFingerprint, {
    bridgeChildExitCode: 0,
    sourceToPhysicalRatioLimit: 0.05,
    sourceToExternalRatioLimit: 0.05,
    physicalTranslationComponent: 0.08,
    physicalExternalComponent: 0.08,
    physicalBridgeChildComponent: 0.08,
    sourceTranslationComponent: 0,
    sourceExternalComponent: 0.08,
    sourceBridgeChildComponent: 0,
    sourceToPhysicalTranslationRatio: 0,
    sourceTranslationToExternalRatio: 0,
    sourceToPhysicalBridgeChildRatio: 0,
  });
  fs.writeFileSync(probePath, `${JSON.stringify(probe, null, 2)}\n`, 'utf8');
  const metricsStartedAtMs = Date.parse(metrics.startedAt);
  const metricsFinishedAtMs = Date.parse(metrics.finishedAt);
  const midpointMs = Math.round((metricsStartedAtMs + metricsFinishedAtMs) / 2);
  const summary = {
    event: 'process_exclusion_restart_summary',
    status: 'passed',
    oldBridgeProcessId,
    newBridgeProcessId,
    oldBridgeInstanceId: 'bridge-instance-old',
    newBridgeInstanceId: 'bridge-instance-new',
    oldSessionId: 'bridge-session-old',
    newSessionId: 'bridge-session-new',
    oldSourceGeneration: '1',
    newSourceGeneration: '2',
    oldSourceGenerationToken: 'generation-token-old',
    newSourceGenerationToken: 'generation-token-new',
    oldPlaybackOwnerGeneration: 1001,
    newPlaybackOwnerGeneration: 2002,
    oldPhysicalPlaybackDeviceId: '{hda-test-endpoint}',
    newPhysicalPlaybackDeviceId: '{hda-test-endpoint}',
    physicalPlaybackStatus: 'ready',
    physicalPlaybackRebindDurationMs: 150,
    oldLastFrameTimestampMs: midpointMs - 100,
    oldLastFrameReadTimestampMs: midpointMs - 50,
    newFirstFrameTimestampMs: midpointMs + 50,
    newFirstFrameReadTimestampMs: midpointMs + 100,
    startedAtUnixMs: midpointMs - 75,
    restartTriggeredAtUnixMs: midpointMs,
    recoveredAtUnixMs: midpointMs + 150,
    downtimeMs: 150,
    sourceFramesBefore: 48_000,
    sourceFramesAfter: 48_000,
    oldFramesAfterRestart: 0,
    oldFrameRejectedCount: 0,
    excludedProcessId: newBridgeProcessId,
    processLoopbackStatus: 'ready',
    captureBackend: 'wasapi-process-exclusion',
    sourceSubscriberActive: 'true',
  };
  fs.appendFileSync(
    path.join(runDirectory, 'app.log'),
    `${Object.entries(summary).map(([key, value]) => `${key}=${value}`).join(' ')}\n`,
    'utf8',
  );
}

function writeAuthorityMatrixManifest(root, entries, {
  now = null,
  runtimeBinaryHashes = TEST_RUNTIME_BINARY_HASHES,
  rebuildReportAfterBudget = true,
} = {}) {
  const releaseCells = entries.map((entry) => entry.cell);
  const budgetGeneratedAt = now instanceof Date
    ? new Date(now.getTime() - 1_000)
    : new Date();
  const cellBudgets = entries.map((entry, index) => writeStrictPaidBudgetFixture(
    entry.runDirectory,
    entry.cell,
    {
      generatedAt: budgetGeneratedAt,
      leaseId: entry.leaseId ?? `lease-${index}-${entry.cell.cellId}`,
    },
  ));
  if (rebuildReportAfterBudget) {
    for (const entry of entries) {
      writeDirectoryReport({ inputDir: entry.runDirectory, outputDir: entry.runDirectory, mode: 'live' });
    }
  }
  // Non-echo fixtures rebuild their canonical/acoustic evidence before the
  // report is minted.  Derive the receipt time only after those writes so a
  // slow local matcher cannot make report.generatedAt later than its receipt.
  const authorityNow = now instanceof Date ? now : new Date(Date.now() + 1_000);
  const matrixBudget = writeMatrixExternalProviderBudget(root, cellBudgets, {
    generatedAt: authorityNow,
    expectedCells: releaseCells,
    matrixCeilingSeconds: STRICT_PAID_MATRIX_CEILING_SECONDS,
  });
  const matrixBudgetAuthority = fileAuthorityEntry(
    matrixBudget.filePath,
    path.basename(matrixBudget.filePath),
  );
  const externalProviderBudget = {
    ...matrixBudget.ledger,
    ledgerPath: matrixBudgetAuthority.path,
    ledgerBytes: matrixBudgetAuthority.bytes,
    ledgerSha256: matrixBudgetAuthority.sha256,
  };
  const profilesByClass = new Map(entries.map((entry) => [
    entry.cell.deviceClass,
    {
      profileId: entry.profileId ?? 'authority-profile',
      deviceClass: entry.cell.deviceClass,
    },
  ]));
  return writeMatrixRunManifest({
    outputRoot: root,
    modelList: [...new Set(releaseCells.map((cell) => cell.modelId))],
    feedbackModeList: [...new Set(releaseCells.map((cell) => cell.feedbackLoopPrevention))],
    deviceProfiles: [...profilesByClass.values()],
    runDirectories: entries.map((entry) => entry.runDirectory),
    strict: true,
    now: authorityNow,
    provenance: CLEAN_CURRENT_PROVENANCE,
    authorityRuntimeBinaryHashes: runtimeBinaryHashes,
    releaseCells,
    externalProviderBudget,
  });
}

function writeAuthorityManifest(root, runDirectory, {
  modelId = 'qwen3.5-omni-flash-realtime',
  feedbackLoopPrevention = 'echo-cancel',
  deviceClass = 'default-speaker',
  profileId = 'authority-profile',
  now = null,
  runtimeBinaryHashes = TEST_RUNTIME_BINARY_HASHES,
  rebuildReportAfterBudget = true,
} = {}) {
  const releaseCells = [{
    cellId: `test::${modelId}::${feedbackLoopPrevention}::${deviceClass}`,
    tier: 'pairwise-live',
    providerMode: 'live-dashscope',
    durationSeconds: MIN_STRICT_SESSION_DURATION_MS / 1_000,
    modelId,
    feedbackLoopPrevention,
    deviceClass,
  }];
  return writeAuthorityMatrixManifest(root, [{
    runDirectory,
    cell: releaseCells[0],
    profileId,
  }], {
    now,
    runtimeBinaryHashes,
    rebuildReportAfterBudget,
  });
}

function refreshCellReceiptArtifacts(root, manifest, index, relativePaths) {
  const cell = manifest.cells[index];
  const runDirectory = path.join(root, ...cell.runDirectory.split('/'));
  const receiptPath = path.join(root, ...cell.receiptPath.split('/'));
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  for (const relativePath of relativePaths) {
    const artifactIndex = receipt.artifacts.findIndex((entry) => entry.path === relativePath);
    assert.notEqual(artifactIndex, -1, `missing fixture receipt artifact ${relativePath}`);
    receipt.artifacts[artifactIndex] = fileAuthorityEntry(
      path.join(runDirectory, ...relativePath.split('/')),
      relativePath,
    );
  }
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  const receiptAuthority = fileAuthorityEntry(receiptPath, cell.receiptPath);
  cell.receiptBytes = receiptAuthority.bytes;
  cell.receiptSha256 = receiptAuthority.sha256;
  return receipt;
}

function refreshMatrixBudgetAuthority(root, manifest) {
  const ledgerPath = path.join(root, ...manifest.externalProviderBudget.ledgerPath.split('/'));
  const authority = fileAuthorityEntry(ledgerPath, manifest.externalProviderBudget.ledgerPath);
  manifest.externalProviderBudget.ledgerBytes = authority.bytes;
  manifest.externalProviderBudget.ledgerSha256 = authority.sha256;
}

function rewriteRecordedCellBudget(runDirectory, cell) {
  const budgetPath = path.join(runDirectory, 'external-provider-budget.json');
  const recorded = JSON.parse(fs.readFileSync(budgetPath, 'utf8'));
  return writeCellExternalProviderBudget({
    runDirectory,
    runMarker: recorded.runMarker,
    cellId: cell.cellId,
    modelId: cell.modelId,
    feedbackLoopPrevention: cell.feedbackLoopPrevention,
    translationMode: 'native',
    sessionCeilingSeconds: cell.durationSeconds,
    generatedAt: recorded.generatedAt,
  }).ledger;
}

function deviceEvidence(deviceClass, overrides = {}) {
  const evidenceByClass = {
    'default-speaker': {
      resolvedDeviceId: 'hdaudio-default-endpoint',
      resolvedDeviceName: 'Built-in Speakers',
      classificationSignals: ['HDAUDIO\\FUNC_01'],
    },
    usb: {
      resolvedDeviceId: 'usb-endpoint-001',
      resolvedDeviceName: 'USB Audio Speakers',
      classificationSignals: ['USB\\VID_1234&PID_5678'],
    },
    bluetooth: {
      resolvedDeviceId: 'bluetooth-endpoint-001',
      resolvedDeviceName: 'Bluetooth A2DP Headphones',
      classificationSignals: ['BTHENUM\\DEV_001', 'A2DP'],
    },
  };
  const resolved = evidenceByClass[deviceClass];
  return {
    profileId: deviceClass,
    deviceClass,
    requestedDeviceId: deviceClass === 'default-speaker' ? 'default' : resolved.resolvedDeviceId,
    ...resolved,
    classificationSource: 'windows-mmdevice-registry',
    routeEvidenceSource: 'physical-output-probe+runtime-route',
    verified: true,
    fixtureOnly: false,
    ...overrides,
  };
}

test('strict Watch report validation requires a complete visible three-stage cue', () => {
  assert.equal(strictWatchSessionReportFailure({ watchSessionReport: healthyWatchSessionReport }), null);
  assert.match(strictWatchSessionReportFailure({}), /requires a saved/);
  assert.match(strictWatchSessionReportFailure({
    watchSessionReport: {
      ...healthyWatchSessionReport,
      summary: { ...healthyWatchSessionReport.summary, unrenderedCueCount: 1 },
    },
  }), /published cue\(s\) without visible rendering/);
  assert.match(strictWatchSessionReportFailure({
    watchSessionReport: {
      ...healthyWatchSessionReport,
      summary: { ...healthyWatchSessionReport.summary, unrenderedCueCount: 0 },
      cues: [
        healthyWatchSessionReport.cues[0],
        {
          ...healthyWatchSessionReport.cues[0],
          cueId: 'cue-not-published',
          comparisonStatus: 'not-published',
          publishedFirstAtMs: null,
          renderedFirstAtMs: null,
          issues: [{ code: 'model-output-not-published' }],
        },
      ],
    },
  }), /explicit issue.*not-published/);
  assert.equal(strictWatchSessionReportFailure({
    watchSessionReport: {
      ...healthyWatchSessionReport,
      cues: [
        healthyWatchSessionReport.cues[0],
        {
          ...healthyWatchSessionReport.cues[0],
          cueId: 'cue-interrupted-tail',
          comparisonStatus: 'not-published',
          llmFirstAtMs: null,
          publishedFirstAtMs: null,
          renderedFirstAtMs: null,
          issues: [{
            category: 'session',
            code: 'session-ended-before-model-output',
            severity: 'warning',
          }],
        },
      ],
    },
  }), null);
  assert.match(strictWatchSessionReportFailure({
    watchSessionReport: {
      ...healthyWatchSessionReport,
      cues: [{
        ...healthyWatchSessionReport.cues[0],
        comparisonStatus: 'superseded',
      }, {
        cueId: 'cue-interrupted-tail',
        comparisonStatus: 'not-published',
        llmFirstAtMs: null,
        publishedFirstAtMs: null,
        renderedFirstAtMs: null,
        issues: [{
          category: 'session',
          code: 'session-ended-before-model-output',
          severity: 'warning',
        }],
      }],
    },
  }), /no complete model/);
  assert.match(strictWatchSessionReportFailure({
    watchSessionReport: {
      ...healthyWatchSessionReport,
      cues: [
        healthyWatchSessionReport.cues[0],
        {
          cueId: 'cue-failed-tail',
          comparisonStatus: 'not-published',
          llmFirstAtMs: null,
          publishedFirstAtMs: null,
          renderedFirstAtMs: null,
          issues: [{
            category: 'session',
            code: 'session-ended-before-model-output',
            severity: 'error',
          }],
        },
      ],
    },
  }), /explicit issue/);
  assert.match(strictWatchSessionReportFailure({
    watchSessionReport: {
      ...healthyWatchSessionReport,
      cues: [{
        ...healthyWatchSessionReport.cues[0],
        comparisonStatus: 'different',
        issues: [{ code: 'content-different' }],
      }],
    },
  }), /explicit issue/);
  assert.equal(strictWatchSessionReportFailure({
    watchSessionReport: {
      ...healthyWatchSessionReport,
      cues: [
        ...healthyWatchSessionReport.cues,
        {
          ...healthyWatchSessionReport.cues[0],
          cueId: 'cue-old-revision',
          comparisonStatus: 'superseded',
          issues: [{
            category: 'model',
            code: 'retry-exhausted',
            severity: 'error',
          }],
        },
      ],
    },
  }), null);
  assert.equal(strictWatchSessionReportFailure({
    watchSessionReport: {
      ...healthyWatchSessionReport,
      cues: [{
        ...healthyWatchSessionReport.cues[0],
        comparisonStatus: 'formatting-only',
        issues: [{
          category: 'model',
          code: 'retry-exhausted',
          severity: 'error',
        }],
      }],
    },
  }), null);
  assert.match(strictWatchSessionReportFailure({
    watchSessionReport: {
      ...healthyWatchSessionReport,
      elapsedMs: MIN_STRICT_SESSION_DURATION_MS - 1,
      summary: {
        ...healthyWatchSessionReport.summary,
        durationMs: MIN_STRICT_SESSION_DURATION_MS - 1,
      },
    },
  }), /duration is too short/);
});

test('strict device evidence independently verifies classifying endpoint signals', () => {
  assert.equal(
    strictDeviceEvidenceFailure({ deviceEvidence: deviceEvidence('default-speaker') }, 'default-speaker'),
    null,
  );
  assert.match(
    strictDeviceEvidenceFailure({
      deviceEvidence: deviceEvidence('usb', {
        resolvedDeviceId: 'bthenum-endpoint',
        resolvedDeviceName: 'Bluetooth Headset',
        classificationSignals: ['BTHENUM\\DEV_001'],
      }),
    }, 'usb'),
    /unsupported deviceClass|classification mismatch/,
  );
});

// The strict-gate tests only vary the strictContent layer's data payload.
function strictContentLayers(strictContentData = { applicable: true, passed: true, coverage: 1 }) {
  return Object.fromEntries(REQUIRED_LAYERS.map((layer) => [
    layer,
    {
      status: 'passed',
      reason: null,
      data: layer === 'strictContent' ? strictContentData : undefined,
    },
  ]));
}

// A report.json whose layers object is missing most required layers.
function writeIncompleteReport(root, directoryName = '20260605-201332') {
  const directory = path.join(root, directoryName);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify({
    mode: 'live',
    generatedAt: '2026-06-05T12:13:32.000Z',
    verdict: 'failed',
    failureLayer: 'app',
    failureReason: 'runner crashed before snapshots completed',
    layers: {
      app: { status: 'failed', reason: 'runner crashed before snapshots completed' },
    },
  }));
}

// A report.json that is not valid JSON at all.
function writeUnparsableReport(root, directoryName = '20260605-201332') {
  const directory = path.join(root, directoryName);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'report.json'), '{ invalid json');
}

// Strict provenance tests: a passing strict-content report plus one override.
function writeStrictReport(root, directoryName, overrides = {}) {
  return writeReport(root, directoryName, {
    layers: strictContentLayers({ applicable: true, passed: true }),
    ...overrides,
  });
}

function reportRunDirectories(root) {
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => fs.existsSync(path.join(root, entry.name, 'report.json')))
    .map((entry) => path.join(root, entry.name));
}

function findScopedStrictEvidence(root, options = {}) {
  return findWatchModeEvidence({
    root,
    strict: true,
    runDirectories: reportRunDirectories(root),
    ...options,
  });
}

test('fails when no live report exists', () => {
  const root = makeTempRoot();
  const result = findWatchModeEvidence({ root });

  assert.equal(result.ok, false);
  assert.match(result.reason, /no complete live watch-mode report/);
});

test('passes when latest complete live report is passed', () => {
  const root = makeTempRoot();
  writeReport(root, '20260605-191332');

  const result = findWatchModeEvidence({ root });

  assert.equal(result.ok, true);
  assert.equal(result.latest.directoryName, '20260605-191332');
  assert.equal(result.latest.report.translationRoute, 'secondary');
});

test('fails when latest complete live report failed', () => {
  const root = makeTempRoot();
  writeReport(root, '20260605-191332', { generatedAt: '2026-06-05T11:13:32.000Z' });
  writeReport(root, '20260605-201332', {
    generatedAt: '2026-06-05T12:13:32.000Z',
    verdict: 'failed',
    failureLayer: 'bridge',
    layers: Object.fromEntries(REQUIRED_LAYERS.map((layer) => [
      layer,
      { status: layer === 'bridge' ? 'failed' : 'passed', reason: layer === 'bridge' ? 'bridge stalled' : null },
    ])),
  });

  const result = findWatchModeEvidence({ root });

  assert.equal(result.ok, false);
  assert.equal(result.latest.directoryName, '20260605-201332');
  assert.equal(result.latest.report.failureLayer, 'bridge');
  assert.deepEqual(result.failedLayers, ['bridge']);
  assert.match(result.reason, /bridge stalled/);
  assert.equal(result.latestFailure.failureReason, 'bridge stalled');
});

test('failure summaries preserve report reason, failed steps, and key evidence', () => {
  const root = makeTempRoot();
  writeReport(root, '20260605-201332', {
    generatedAt: '2026-06-05T12:13:32.000Z',
    verdict: 'failed',
    failureLayer: 'provider',
    failureReason: 'HTTP 429 quota exceeded providerId=provider-dashscope modelId=qwen3.6-flash-2026-04-16',
    diagnostics: {
      failedSteps: [
        { name: 'wait for watch-mode app readiness', error: 'timed out waiting for app log pattern' },
      ],
      checkFailures: [
        { layer: 'provider', reason: 'HTTP 429 quota exceeded' },
      ],
      evidence: {
        appProviderErrors: [
          'provider.translate_text failed HTTP 429 quota exceeded providerId=provider-dashscope modelId=qwen3.6-flash-2026-04-16',
        ],
      },
    },
    layers: Object.fromEntries(REQUIRED_LAYERS.map((layer) => [
      layer,
      { status: layer === 'provider' ? 'failed' : 'passed', reason: layer === 'provider' ? 'HTTP 429 quota exceeded' : null },
    ])),
  });

  const result = findWatchModeEvidence({ root });

  assert.equal(result.ok, false);
  assert.match(result.reason, /HTTP 429 quota exceeded/);
  assert.equal(result.latestFailure.failureLayer, 'provider');
  assert.equal(result.latestFailure.failedSteps[0].name, 'wait for watch-mode app readiness');
  assert(result.latestFailure.keyEvidence.some((line) => /provider-dashscope/.test(line)));
});

test('reports incomplete and invalid latest reports with concrete paths', () => {
  const root = makeTempRoot();
  writeIncompleteReport(root);

  const incomplete = findWatchModeEvidence({ root });

  assert.equal(incomplete.ok, false);
  assert.match(incomplete.reason, /incomplete/);
  assert.match(incomplete.reason, /missingLayers=/);
  assert.match(incomplete.reason, /report\.json/);
  assert.equal(incomplete.invalidCandidates[0].incomplete, true);

  const invalidRoot = makeTempRoot();
  writeUnparsableReport(invalidRoot);

  const invalid = findWatchModeEvidence({ root: invalidRoot });

  assert.equal(invalid.ok, false);
  assert.match(invalid.reason, /could not be parsed/);
  assert.match(invalid.reason, /report\.json/);
  assert(invalid.invalidCandidates[0].parseError);
});

test('does not fall back to stale complete reports when the latest report is incomplete or invalid', () => {
  const incompleteRoot = makeTempRoot();
  writeReport(incompleteRoot, '20260605-191332', {
    generatedAt: '2026-06-05T11:13:32.000Z',
  });
  writeIncompleteReport(incompleteRoot);

  const incomplete = findWatchModeEvidence({ root: incompleteRoot });

  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.latest, null);
  assert.match(incomplete.reason, /latest live report is incomplete/);
  assert.match(incomplete.latestFailure.failureReason, /missingLayers=/);
  assert.match(incomplete.latestFailure.keyEvidence.join('\n'), /missingLayers=/);

  const invalidRoot = makeTempRoot();
  writeReport(invalidRoot, '20260605-191332', {
    generatedAt: '2026-06-05T11:13:32.000Z',
  });
  writeUnparsableReport(invalidRoot);

  const invalid = findWatchModeEvidence({ root: invalidRoot });

  assert.equal(invalid.ok, false);
  assert.equal(invalid.latest, null);
  assert.match(invalid.reason, /latest live report could not be parsed/);
  assert.match(invalid.latestFailure.keyEvidence.join('\n'), /parseError=/);
});

test('ignores smoke and cache directories', () => {
  const root = makeTempRoot();
  fs.mkdirSync(path.join(root, 'cache'), { recursive: true });
  writeReport(root, 'physical-output-smoke-20260605-191332');
  writeReport(root, 'reference-pcm-smoke-20260605-191332');

  const result = findWatchModeEvidence({ root });

  assert.equal(result.ok, false);
  assert.equal(result.candidates.length, 0);
});

test('does not use stale root-level report.json', () => {
  const root = makeTempRoot();
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({
    mode: 'live',
    verdict: 'passed',
    layers: Object.fromEntries(REQUIRED_LAYERS.map((layer) => [layer, { status: 'passed' }])),
  }));

  const result = findWatchModeEvidence({ root });

  assert.equal(result.ok, false);
  assert.equal(result.latest, null);
});

test('strict mode fails when strict content is not applicable', () => {
  const root = makeTempRoot();
  writeReport(root, '20260605-191332', {
    layers: strictContentLayers({ applicable: false, passed: true }),
  });

  const result = findScopedStrictEvidence(root);

  assert.equal(result.ok, false);
  assert.match(result.reason, /strictContent gate was not applicable/);
  assert.deepEqual(result.failedLayers, ['strictContent']);
});

test('strict mode passes when strict content is applicable and passed', () => {
  const root = makeTempRoot();
  writeReport(root, '20260605-191332', {
    modelId: 'qwen3.5-omni-flash-realtime',
    layers: strictContentLayers(),
  });

  const result = findScopedStrictEvidence(root, provenanceOk);

  assert.equal(result.ok, true);
  assert.equal(result.latest.modelId, 'qwen3.5-omni-flash-realtime');
});

test('strict verifier refuses to scan outputRoot without an explicit current-run scope', () => {
  const root = makeTempRoot();
  writeStrictReport(root, '20260605-191332-historical-pass');

  const result = findWatchModeEvidence({ root, strict: true, ...provenanceOk });

  assert.equal(result.ok, false);
  assert.match(result.reason, /requires the schema-v4 budget-balanced authority manifest/);
  assert.equal(result.candidates.length, 0, 'historical reports must not be scanned in strict mode');
});

test('strict verifier inspects only listed run directories and rejects scoped dry-run output', () => {
  const root = makeTempRoot();
  writeStrictReport(root, '20260605-191332-historical-pass');
  const currentDirectoryName = '20260605-201332-current-dry-run';
  writeStrictReport(root, currentDirectoryName, { mode: 'dry-run' });
  const currentDirectory = path.join(root, currentDirectoryName);

  const result = findWatchModeEvidence({
    root,
    strict: true,
    runDirectories: [currentDirectory],
    ...provenanceOk,
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /mode=dry-run is non-live/);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].reportPath, path.join(currentDirectory, 'report.json'));
  assert.doesNotMatch(result.reason, /historical-pass/);
});

test('run manifest resolves relative current-run directories without discovering siblings', () => {
  const root = makeTempRoot();
  const currentDirectory = path.join(root, 'current-run');
  fs.mkdirSync(currentDirectory, { recursive: true });
  const manifestPath = path.join(root, 'current-matrix.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    schemaVersion: 1,
    evidenceMode: 'live',
    strict: true,
    provenance: CLEAN_CURRENT_PROVENANCE,
    runDirectories: ['current-run'],
  })}\n`, 'utf8');

  const resolved = readRunManifest(manifestPath);

  assert.equal(resolved.manifestPath, manifestPath);
  assert.deepEqual(resolved.runDirectories, [currentDirectory]);
  assert.deepEqual(
    normalizeRunDirectories(JSON.stringify(['current-run']), { baseDirectory: root }),
    [currentDirectory],
  );
});

test('strict authority rebuilds report evidence from the fixed raw inventory', () => {
  const root = makeTempRoot();
  const runDirectory = writeAuthorityRawCell(root, 'authority-valid');
  const { manifestPath, manifest } = writeAuthorityManifest(root, runDirectory);

  const verified = verifyStrictMatrixAuthority({
    manifestPath,
    manifest,
    evidenceRoot: root,
    currentProvenance: CLEAN_CURRENT_PROVENANCE,
    workspaceRoot: path.resolve('.'),
    now: Date.now() + 2_000,
    currentRuntimeBinaryHashes: TEST_RUNTIME_BINARY_HASHES,
  });

  assert.deepEqual(verified.runDirectories, [runDirectory]);
  assert.equal(verified.authorizedReports.size, 1);
  assert.equal(
    [...verified.authorizedReports.values()][0].generatedAt,
    JSON.parse(fs.readFileSync(path.join(runDirectory, 'report.json'), 'utf8')).generatedAt,
  );
  assert.equal(
    verified.externalProviderBudget.actualProviderInputSamples,
    loadCanonicalFixtureAuthority().referencePcm.samples,
  );
  assert.equal(
    verified.externalProviderBudget.cells[0].leaseId,
    manifest.externalProviderBudget.cells[0].leaseId,
  );
});

test('strict authority rejects a placeholder paid-cell ledger even when its receipt hash is refreshed', () => {
  const root = makeTempRoot();
  const runDirectory = writeAuthorityRawCell(root, 'authority-placeholder-budget');
  const { manifestPath, manifest } = writeAuthorityManifest(root, runDirectory);
  fs.writeFileSync(
    path.join(runDirectory, 'external-provider-budget.json'),
    `${JSON.stringify({ passed: true }, null, 2)}\n`,
    'utf8',
  );
  refreshCellReceiptArtifacts(root, manifest, 0, ['external-provider-budget.json']);

  assert.throws(
    () => verifyStrictMatrixAuthority({
      manifestPath,
      manifest,
      evidenceRoot: root,
      currentProvenance: CLEAN_CURRENT_PROVENANCE,
      workspaceRoot: path.resolve('.'),
      currentRuntimeBinaryHashes: TEST_RUNTIME_BINARY_HASHES,
    }),
    /paid-cell budget ledger has an unsupported schema\/kind/,
  );
});

test('strict authority rejects a missing Rust send-boundary ledger', () => {
  const root = makeTempRoot();
  const runDirectory = writeAuthorityRawCell(root, 'authority-missing-rust-ledger');
  const { manifestPath, manifest } = writeAuthorityManifest(root, runDirectory);
  fs.unlinkSync(path.join(runDirectory, 'provider-input-budget-ledger.json'));

  assert.throws(
    () => verifyStrictMatrixAuthority({
      manifestPath,
      manifest,
      evidenceRoot: root,
      currentProvenance: CLEAN_CURRENT_PROVENANCE,
      workspaceRoot: path.resolve('.'),
      currentRuntimeBinaryHashes: TEST_RUNTIME_BINARY_HASHES,
    }),
    /provider-input-budget-ledger\.json.*missing|authority artifact.*missing/,
  );
});

test('strict authority rejects a self-consistently rehashed paid-cell JS ledger tamper', () => {
  const root = makeTempRoot();
  const runDirectory = writeAuthorityRawCell(root, 'authority-tampered-js-budget');
  const { manifestPath, manifest } = writeAuthorityManifest(root, runDirectory);
  const budgetPath = path.join(runDirectory, 'external-provider-budget.json');
  const budget = JSON.parse(fs.readFileSync(budgetPath, 'utf8'));
  budget.actualProviderInputSamples += 1;
  fs.writeFileSync(budgetPath, `${JSON.stringify(budget, null, 2)}\n`, 'utf8');
  refreshCellReceiptArtifacts(root, manifest, 0, ['external-provider-budget.json']);

  assert.throws(
    () => verifyStrictMatrixAuthority({
      manifestPath,
      manifest,
      evidenceRoot: root,
      currentProvenance: CLEAN_CURRENT_PROVENANCE,
      workspaceRoot: path.resolve('.'),
      currentRuntimeBinaryHashes: TEST_RUNTIME_BINARY_HASHES,
    }),
    /paid-cell budget ledger does not match current raw artifacts/,
  );
});

test('strict authority rejects a wrong Rust model-protocol pair after all hashes are refreshed', () => {
  const root = makeTempRoot();
  const runDirectory = writeAuthorityRawCell(root, 'authority-wrong-rust-protocol');
  const { manifestPath, manifest } = writeAuthorityManifest(root, runDirectory);
  const ledgerPath = path.join(runDirectory, 'provider-input-budget-ledger.json');
  const journalPath = path.join(runDirectory, 'provider-input-budget-ledger.json.journal.jsonl');
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  ledger.protocol = 'dashscope-livetranslate';
  fs.writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  const journal = fs.readFileSync(journalPath, 'utf8').trim().split(/\r?\n/).map((line) => {
    const entry = JSON.parse(line);
    entry.protocol = 'dashscope-livetranslate';
    return entry;
  });
  fs.writeFileSync(journalPath, `${journal.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
  rewriteRecordedCellBudget(runDirectory, manifest.cells[0]);
  refreshCellReceiptArtifacts(root, manifest, 0, [
    'external-provider-budget.json',
    'provider-input-budget-ledger.json',
    'provider-input-budget-ledger.json.journal.jsonl',
  ]);

  assert.throws(
    () => verifyStrictMatrixAuthority({
      manifestPath,
      manifest,
      evidenceRoot: root,
      currentProvenance: CLEAN_CURRENT_PROVENANCE,
      workspaceRoot: path.resolve('.'),
      currentRuntimeBinaryHashes: TEST_RUNTIME_BINARY_HASHES,
    }),
    /protocol mismatch/,
  );
});

test('strict authority independently rejects a tampered matrix aggregate above the 23,040,000-sample cap', () => {
  const root = makeTempRoot();
  const runDirectory = writeAuthorityRawCell(root, 'authority-tampered-matrix-budget');
  const { manifestPath, manifest } = writeAuthorityManifest(root, runDirectory);
  const matrixPath = path.join(root, manifest.externalProviderBudget.ledgerPath);
  const matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
  matrix.actualProviderInputSamples = 23_040_001;
  matrix.actualProviderInputSeconds = 1_440.000063;
  fs.writeFileSync(matrixPath, `${JSON.stringify(matrix, null, 2)}\n`, 'utf8');
  refreshMatrixBudgetAuthority(root, manifest);

  assert.throws(
    () => verifyStrictMatrixAuthority({
      manifestPath,
      manifest,
      evidenceRoot: root,
      currentProvenance: CLEAN_CURRENT_PROVENANCE,
      workspaceRoot: path.resolve('.'),
      currentRuntimeBinaryHashes: TEST_RUNTIME_BINARY_HASHES,
    }),
    /paid-matrix budget ledger does not match rebuilt cell authorities/,
  );
});

test('production strict authority requires all eight fixed paid cells', () => {
  const root = makeTempRoot();
  const runDirectory = writeAuthorityRawCell(root, 'authority-one-of-eight');
  const { manifestPath, manifest } = writeAuthorityManifest(root, runDirectory);

  assert.throws(
    () => verifyProductionStrictMatrixAuthority({
      manifestPath,
      manifest,
      evidenceRoot: root,
      currentProvenance: CLEAN_CURRENT_PROVENANCE,
      workspaceRoot: path.resolve('.'),
      currentRuntimeBinaryHashes: TEST_RUNTIME_BINARY_HASHES,
      requireLocalIsolation: false,
    }),
    /must contain exactly 8 paid live cells/,
  );
});

test('strict shard parser fails closed when guest shardExecution authority is missing', () => {
  assert.throws(
    () => verifyStrictShardMatrixAuthority({
      manifest: {
        generatedAt: new Date(FIXTURE_NOW).toISOString(),
        matrixIntegration: {},
      },
      evidenceRoot: makeTempRoot(),
      releaseCells: [],
      cellReceipts: [],
      currentProvenance: CLEAN_CURRENT_PROVENANCE,
      currentImplementationHashes: [],
      currentRuntimeBinaryHashes: [],
      workspaceRoot: path.resolve('.'),
    }),
    /missing shardExecution guest authority/,
  );
});

test('strict shard parser fails closed when coordinator omits matrixIntegration authority', () => {
  assert.throws(
    () => verifyStrictShardMatrixAuthority({
      manifest: {
        generatedAt: new Date(FIXTURE_NOW).toISOString(),
        shardExecution: {},
      },
      evidenceRoot: makeTempRoot(),
      releaseCells: [],
      cellReceipts: [],
      currentProvenance: CLEAN_CURRENT_PROVENANCE,
      currentImplementationHashes: [],
      currentRuntimeBinaryHashes: [],
      workspaceRoot: path.resolve('.'),
    }),
    /missing shard matrixIntegration authority/,
  );
});

test('guest shard authority projection binds runtime inventory and immutable result files', () => {
  const runtimeBinaryHashes = [{ path: 'target/release/omni.exe', bytes: 3, sha256: 'a'.repeat(64) }];
  const workerReadinessAuthority = {
    path: 'worker-zero-provider-readiness.json', bytes: 41, sha256: '3'.repeat(64),
  };
  const interactiveSessionAuthority = {
    path: 'interactive-session-authority.json', bytes: 42, sha256: '4'.repeat(64),
  };
  const projection = buildStrictShardCellAuthorityProjection({
    matrixCell: { runDirectory: 'execution/shards/vm-1/run-1' },
    planCell: {
      cellIndex: 0,
      cellId: 'paid-cell-1',
      workerId: 'worker-1',
      vmIdentityDigest: 'b'.repeat(64),
      waveIndex: 0,
    },
    shardBinding: { shardRoot: 'execution/shards/vm-1' },
    shardManifest: { manifestDigest: 'c'.repeat(64) },
    shardManifestAuthority: {
      path: 'execution/shards/vm-1/shard-manifest.json',
      bytes: 40,
      sha256: 'd'.repeat(64),
    },
    resultBinding: {
      result: { path: 'run-1/shard-cell-result.json', bytes: 80, sha256: 'e'.repeat(64) },
    },
    result: {
      executionId: 'execution-1',
      planDigest: 'f'.repeat(64),
      leaseId: 'lease-1',
      leaseDigest: '1'.repeat(64),
      resultDigest: '2'.repeat(64),
      runDirectory: 'run-1',
      authority: { runtimeBinaryHashes },
      workerReadinessAuthority,
      interactiveSessionAuthority,
      usageAuthority: { actualExternalAudioSamples: 16_000 },
      deviceAuthority: { deviceClass: 'default-speaker' },
    },
  });

  assert.deepEqual(projection, {
    origin: 'guest-shard-result',
    executionId: 'execution-1',
    planDigest: 'f'.repeat(64),
    cellIndex: 0,
    cellId: 'paid-cell-1',
    workerId: 'worker-1',
    vmIdentityDigest: 'b'.repeat(64),
    waveIndex: 0,
    leaseId: 'lease-1',
    leaseDigest: '1'.repeat(64),
    shardRoot: 'execution/shards/vm-1',
    shardManifest: {
      path: 'execution/shards/vm-1/shard-manifest.json',
      bytes: 40,
      sha256: 'd'.repeat(64),
      manifestDigest: 'c'.repeat(64),
    },
    result: {
      path: 'run-1/shard-cell-result.json',
      bytes: 80,
      sha256: 'e'.repeat(64),
      resultDigest: '2'.repeat(64),
    },
    guestRunDirectory: 'run-1',
    runDirectory: 'execution/shards/vm-1/run-1',
    runtimeBinaryHashes,
    workerReadinessAuthority,
    interactiveSessionAuthority,
    usageAuthority: { actualExternalAudioSamples: 16_000 },
    deviceAuthority: { deviceClass: 'default-speaker' },
  });
});

test('strict shard preflight rejects a self-consistent model outside the paid release list', () => {
  const root = makeTempRoot();
  const executionRoot = path.join(root, 'execution');
  const sourceRoot = path.join(root, 'source');
  const executionId = `watch-shard-preflight-${crypto.randomUUID()}`;
  const unsupportedModel = 'qwen3.5-omni-plus-realtime';
  const grantGeneratedAt = new Date(Date.now() - 10_000).toISOString();
  const reservationIssuedAt = new Date(Date.now() - 9_000).toISOString();
  const rawStartedAt = new Date(Date.now() - 8_000).toISOString();
  const rawCompletedAt = new Date(Date.now() - 7_000).toISOString();
  const receiptGeneratedAt = new Date(Date.now() - 6_000);
  const completionGeneratedAt = new Date(Date.now() - 5_000).toISOString();
  const unsupportedClaim = {
    schemaVersion: 1,
    artifactKind: PROVIDER_PREFLIGHT_CONSUMPTION_CLAIM_KIND,
    executionId,
    grantDigest: '1'.repeat(64),
    authorizationDigest: 'a'.repeat(64),
    coordinatorKeyId: 'b'.repeat(64),
    claimedAt: new Date(Date.now() - 8_500).toISOString(),
    desktopProcessId: 1234,
    desktopExecutablePath: path.resolve(PROVIDER_PREFLIGHT_DESKTOP_EXECUTABLE),
    desktopExecutableRelativePath: PROVIDER_PREFLIGHT_DESKTOP_EXECUTABLE,
    desktopExecutableBytes: 1,
    desktopExecutableSha256: 'c'.repeat(64),
    retryPolicy: 'new-execution-required',
    path: PROVIDER_PREFLIGHT_CONSUMPTION_CLAIM_FILE,
    bytes: 1,
    sha256: 'd'.repeat(64),
  };
  const expectedAuthorization = {
    schemaVersion: 1,
    artifactKind: 'watch-mode-provider-preflight-authorization-consumption',
    executionId,
    grantDigest: '1'.repeat(64),
    leaseReservationDigests: Array.from({ length: 8 }, (_, index) => (
      (index + 2).toString(16).repeat(64).slice(0, 64)
    )),
    authorizationDigest: 'a'.repeat(64),
    providerId: PROVIDER_PREFLIGHT_PROVIDER_ID,
    model: unsupportedModel,
    protocol: PROVIDER_PREFLIGHT_PROTOCOL,
    operation: 'text-translation-preflight',
    inputMode: 'text-only',
    invocationCount: 1,
    externalAudioSamples: 0,
    tokenBudget: { maxInputTokens: 4_096, maxOutputTokens: 256 },
    consumptionClaim: unsupportedClaim,
    grantGeneratedAt,
    reservationIssuedAts: Array.from({ length: 8 }, () => reservationIssuedAt),
  };
  fs.mkdirSync(executionRoot);
  fs.mkdirSync(sourceRoot);
  fs.writeFileSync(path.join(sourceRoot, 'provider-probe-result.json'), `${JSON.stringify({
    operation: 'text-translation-preflight',
    inputMode: 'text-only',
    externalAudioSamples: 0,
    providerInvocationCount: 1,
    executionId,
    grantDigest: expectedAuthorization.grantDigest,
    leaseReservationDigests: expectedAuthorization.leaseReservationDigests,
    authorizationDigest: expectedAuthorization.authorizationDigest,
    providerId: PROVIDER_PREFLIGHT_PROVIDER_ID,
    model: unsupportedModel,
    protocol: PROVIDER_PREFLIGHT_PROTOCOL,
  })}\n`, 'utf8');
  const validateFixture = () => ({
    issues: [],
    evidenceTimes: [rawStartedAt, rawCompletedAt],
    summary: {
      providerId: PROVIDER_PREFLIGHT_PROVIDER_ID,
      model: unsupportedModel,
      protocol: PROVIDER_PREFLIGHT_PROTOCOL,
      executionId,
      grantDigest: expectedAuthorization.grantDigest,
      leaseReservationDigests: expectedAuthorization.leaseReservationDigests,
      authorizationDigest: expectedAuthorization.authorizationDigest,
      consumptionClaim: unsupportedClaim,
      operation: 'text-translation-preflight',
      inputMode: 'text-only',
      externalAudioSamples: 0,
      providerInvocationCount: 1,
      tokenBudget: expectedAuthorization.tokenBudget,
      inputTokens: 12,
      outputTokens: 3,
      audioSeconds: null,
    },
  });
  const written = writeCoordinatorProviderPreflightReceipt({
    executionRoot,
    executionId,
    preflight: {
      providerId: PROVIDER_PREFLIGHT_PROVIDER_ID,
      operation: 'text-translation-preflight',
      inputMode: 'text-only',
      status: 'completed',
      externalAudioSamples: 0,
      providerInvocationCount: 1,
      model: unsupportedModel,
      evidenceDirectory: sourceRoot,
    },
    provenance: CLEAN_CURRENT_PROVENANCE,
    generatedAt: receiptGeneratedAt,
    expectedAuthorization,
    validateEvidence: validateFixture,
  });

  assert.throws(
    () => verifyStrictShardProviderPreflightAuthority({
      plan: {
        executionId,
        providerPreflightAuthority: {
          ...written.authority,
          path: 'execution/provider-preflight-receipt.json',
        },
      },
      executionRoot,
      executionRootRelative: 'execution',
      evidenceRoot: root,
      currentProvenance: CLEAN_CURRENT_PROVENANCE,
      workspaceRoot: path.resolve('.'),
      validationAt: new Date(),
      authorization: {
        consumption: expectedAuthorization,
        claimProjection: unsupportedClaim,
        leaseReservations: Array.from({ length: 8 }, () => ({
          issuedAt: reservationIssuedAt,
        })),
        completion: { generatedAt: completionGeneratedAt },
      },
      validateEvidence: validateFixture,
    }),
    /preflight is not exactly one completed text-only invocation/,
  );
});

test('strict production verifier rebuilds the staged eight-cell authority from one local manifest', () => {
  const root = makeTempRoot();
  const evidenceRoot = path.join(root, 'evidence');
  const coordinatorRoot = path.join(root, 'coordinator-source');
  const workspaceRoot = path.resolve('.');
  fs.mkdirSync(evidenceRoot, { recursive: true });
  fs.mkdirSync(coordinatorRoot, { recursive: true });
  const baseMs = Date.now();
  const executionId = `watch-shard-verifier-${crypto.randomUUID()}`;
  const shardProvenance = {
    ...CLEAN_CURRENT_PROVENANCE,
    headCommit: '1'.repeat(40),
  };
  const runtimeBinaryHashes = [{
    path: 'drivers/windows-virtual-mic/package/omni-virtual-speaker.sys',
    bytes: 123,
    sha256: 'a'.repeat(64),
  }, {
    path: 'drivers/windows-virtual-mic/package/omni-virtual-speaker.cat',
    bytes: 123,
    sha256: 'b'.repeat(64),
  }, {
    path: 'drivers/windows-virtual-mic/package/omni-virtual-speaker.inf',
    bytes: 123,
    sha256: 'c'.repeat(64),
  }, {
    path: PROVIDER_PREFLIGHT_DESKTOP_EXECUTABLE,
    bytes: 456,
    sha256: 'd'.repeat(64),
  }];
  const deviceProfile = (
    workerId,
    suffix,
    profileId,
    deviceClass,
    physicalPlaybackDeviceId,
    expectedPhysicalPlaybackDeviceName,
  ) => ({
    instanceId: `${workerId}-${suffix}`,
    profileId,
    deviceClass,
    physicalPlaybackDeviceId,
    expectedPhysicalPlaybackDeviceName,
  });
  const workers = [{
    workerId: 'vm1',
    interactiveUser: 'VMUser',
    vmIdentity: { provider: 'vmware', uuidBios: 'verifier-vm-1' },
    deviceProfileInstances: [deviceProfile(
      'vm1',
      'default',
      'vmware-hda-default',
      'default-speaker',
      'default',
      'Built-in Speakers',
    )],
  }];

  try {
    const signingKeys = generateCoordinatorSigningKeyPair();
    const implementationHashes = currentAuthorityImplementationHashes({ workspaceRoot });
    const shardImplementationHashes = currentShardOrchestrationImplementationHashes({ workspaceRoot });
    const assignments = defaultThreeVmAssignments(workers).map((assignment, index) => ({
      ...assignment,
      leaseId: `verifier-paid-lease-${index + 1}`,
    }));
    const workerReadinessRequest = createWorkerReadinessRequest({
      executionId,
      generatedAt: new Date(baseMs - 10_000),
      provenance: shardProvenance,
      runtimeBinaryHashes,
      workers,
      assignments,
    });
    const readinessRequestPath = path.join(coordinatorRoot, 'worker-readiness-request.json');
    fs.writeFileSync(
      readinessRequestPath,
      `${JSON.stringify(workerReadinessRequest, null, 2)}\n`,
      'utf8',
    );
    const packageDriver = {
      packageSysSha256: runtimeBinaryHashes[0].sha256,
      packageCatSha256: runtimeBinaryHashes[1].sha256,
      packageInfSha256: runtimeBinaryHashes[2].sha256,
    };
    const readinessReceipts = new Map();
    const readinessAuthorities = workerReadinessRequest.workers.map((readinessWorker, index) => {
      const readinessOwnerSid = `S-1-5-21-readiness-${index + 1}`;
      const readinessTaskProcess = {
        pid: 10_000 + index,
        parentPid: 4,
        sessionId: 1,
        ownerSid: readinessOwnerSid,
        imagePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        imageSha256: crypto.createHash('sha256')
          .update(`readiness-powershell-${index + 1}`)
          .digest('hex'),
        startedAt: new Date(baseMs - 9_750).toISOString(),
      };
      const receipt = {
        schemaVersion: 1,
        artifactKind: SHARD_WORKER_READINESS_KIND,
        generatedAt: new Date(baseMs - 9_000).toISOString(),
        executionId,
        readinessRequestDigest: workerReadinessRequest.requestDigest,
        workerId: readinessWorker.workerId,
        vmIdentityDigest: readinessWorker.vmIdentityDigest,
        runtimeBundleDigest: workerReadinessRequest.runtimeBundleDigest,
        providerCalls: 0,
        driverRequired: readinessWorker.driverRequired,
        interactiveSession: {
          user: readinessWorker.interactiveUser,
          ownerSid: readinessOwnerSid,
          sessionId: 1,
          explorerProcessCount: 1,
          taskProcess: readinessTaskProcess,
        },
        credentialStatus: {
          backend: 'windows-credential-manager',
          exists: true,
          blobNonEmpty: true,
          credentialBlobBytes: 64,
          reference: STRICT_PAID_PROVIDER_IDENTITY.credentialReference,
          targetName: 'OmniTranslate:credential___provider_dashscope_default',
          checkedAt: new Date(baseMs - 9_250).toISOString(),
          probeProcess: readinessTaskProcess,
        },
        driver: readinessWorker.driverRequired
          ? {
              ...packageDriver,
              installedServiceState: 'Running',
              installedSysSha256: runtimeBinaryHashes[0].sha256,
              installedSysSignatureStatus: 'Valid',
              packageCatalogSignatureStatus: 'Valid',
            }
          : { ...packageDriver, installedServiceState: 'not-required' },
        profiles: readinessWorker.deviceProfileInstances.map((profile) => ({
          instanceId: profile.instanceId,
          profileId: profile.profileId,
          deviceClass: profile.deviceClass,
          resolvedDeviceId: profile.physicalPlaybackDeviceId === 'default'
            ? `resolved-${readinessWorker.workerId}-default`
            : profile.physicalPlaybackDeviceId,
          resolvedDeviceName: profile.expectedPhysicalPlaybackDeviceName,
        })),
      };
      readinessReceipts.set(readinessWorker.workerId, receipt);
      const authorityPath = `worker-readiness/${readinessWorker.workerId}.json`;
      const receiptPath = path.join(coordinatorRoot, ...authorityPath.split('/'));
      fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
      for (const invalidBytes of [0, 2_561]) {
        fs.writeFileSync(
          receiptPath,
          `${JSON.stringify({
            ...receipt,
            credentialStatus: {
              ...receipt.credentialStatus,
              credentialBlobBytes: invalidBytes,
            },
          }, null, 2)}\n`,
          'utf8',
        );
        assert.throws(
          () => validateWorkerZeroProviderReadinessAuthority({
            receiptPath,
            request: workerReadinessRequest,
            workerId: readinessWorker.workerId,
            now: new Date(baseMs - 8_000),
            authorityPath,
          }),
          /credential status/,
        );
      }
      fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
      return {
        workerId: readinessWorker.workerId,
        providerCalls: 0,
        driverRequired: readinessWorker.driverRequired,
        ...fileAuthorityEntry(receiptPath, authorityPath),
      };
    });
    const localIsolationAuthority = {
      path: 'local-isolation-manifest.json',
      bytes: 1,
      sha256: 'd'.repeat(64),
      providerCalls: 0,
    };
    const preflightGrant = createProviderPreflightGrant({
      executionId,
      generatedAt: new Date(baseMs - 8_000),
      expiresAt: new Date(baseMs + 86_400_000),
      provenance: shardProvenance,
      authorityImplementationHashes: implementationHashes,
      runtimeBinaryHashes,
      shardOrchestrationImplementationHashes: shardImplementationHashes,
      localIsolationAuthority,
      workerReadinessRequest,
      workerReadinessRequestAuthority: fileAuthorityEntry(
        readinessRequestPath,
        'worker-readiness-request.json',
      ),
      workerReadinessAuthorities: readinessAuthorities,
      workers,
      assignments,
      signingKeys,
    });
    const preflightGrantPath = path.join(coordinatorRoot, PROVIDER_PREFLIGHT_GRANT_FILE);
    fs.writeFileSync(preflightGrantPath, `${JSON.stringify(preflightGrant, null, 2)}\n`, 'utf8');
    const preflightReservations = createProviderPreflightLeaseReservations({
      grant: preflightGrant,
      issuedAt: new Date(baseMs - 7_000),
      signingKeys,
    });
    const reservationRoot = path.join(
      coordinatorRoot,
      PROVIDER_PREFLIGHT_LEASE_RESERVATION_DIRECTORY,
    );
    fs.mkdirSync(reservationRoot);
    preflightReservations.forEach((reservation, index) => fs.writeFileSync(
      path.join(reservationRoot, providerPreflightReservationFileName(reservation, index)),
      `${JSON.stringify(reservation, null, 2)}\n`,
      'utf8',
    ));
    const authorizationPackage = loadProviderPreflightAuthorizationPackage({
      grantPath: preflightGrantPath,
      reservationDirectory: reservationRoot,
    });
    const claimAt = new Date(baseMs - 6_600).toISOString();
    const desktopRuntime = runtimeBinaryHashes.find(
      (entry) => entry.path === PROVIDER_PREFLIGHT_DESKTOP_EXECUTABLE,
    );
    const consumptionClaim = {
      schemaVersion: 1,
      artifactKind: PROVIDER_PREFLIGHT_CONSUMPTION_CLAIM_KIND,
      executionId,
      grantDigest: preflightGrant.digest,
      authorizationDigest: authorizationPackage.authorizationDigest,
      coordinatorKeyId: preflightGrant.signature.keyId,
      claimedAt: claimAt,
      desktopProcessId: 42_424,
      desktopExecutablePath: path.resolve(
        workspaceRoot,
        ...PROVIDER_PREFLIGHT_DESKTOP_EXECUTABLE.split('/'),
      ),
      desktopExecutableRelativePath: PROVIDER_PREFLIGHT_DESKTOP_EXECUTABLE,
      desktopExecutableBytes: desktopRuntime.bytes,
      desktopExecutableSha256: desktopRuntime.sha256,
      retryPolicy: 'new-execution-required',
    };
    const consumptionClaimPath = path.join(
      coordinatorRoot,
      PROVIDER_PREFLIGHT_CONSUMPTION_CLAIM_FILE,
    );
    fs.writeFileSync(
      consumptionClaimPath,
      `${JSON.stringify(consumptionClaim, null, 2)}\n`,
      'utf8',
    );
    const consumptionClaimProjection = {
      ...consumptionClaim,
      ...fileAuthorityEntry(
        consumptionClaimPath,
        PROVIDER_PREFLIGHT_CONSUMPTION_CLAIM_FILE,
      ),
    };
    const expectedPreflightAuthorization = {
      ...authorizationPackage.consumption,
      consumptionClaim: consumptionClaimProjection,
      grantGeneratedAt: preflightGrant.generatedAt,
      reservationIssuedAts: preflightReservations.map((entry) => entry.issuedAt),
    };
    const authorizationObservedAt = new Date(baseMs - 6_750).toISOString();
    const providerConnectStartedAt = new Date(baseMs - 6_500).toISOString();
    const providerConnectCompletedAt = new Date(baseMs - 5_250).toISOString();
    const providerCheckedAt = providerConnectCompletedAt;
    const configuredModel = 'qwen3.5-omni-plus-realtime';
    const observedPreflightAuthorization = {
      ...authorizationPackage.consumption,
      consumptionClaim: consumptionClaimProjection,
      leaseReservations: preflightReservations.map((reservation, index) => ({
        cellIndex: index,
        cellId: reservation.cellId,
        workerId: reservation.workerId,
        waveIndex: reservation.waveIndex,
        leaseId: reservation.leaseId,
        maxExternalAudioSamples: reservation.maxExternalAudioSamples,
        digest: reservation.digest,
        issuedAt: reservation.issuedAt,
      })),
      grantGeneratedAt: preflightGrant.generatedAt,
      reservationIssuedAts: preflightReservations.map((entry) => entry.issuedAt),
      authorizationObservedAt,
    };
    const preflightRawTimes = [
      new Date(baseMs - 6_000).toISOString(),
      new Date(baseMs - 5_000).toISOString(),
    ];
    const validateFixturePreflight = () => ({
      issues: [],
      evidenceTimes: preflightRawTimes,
      summary: {
        providerId: PROVIDER_PREFLIGHT_PROVIDER_ID,
        model: PROVIDER_PREFLIGHT_MODEL,
        protocol: PROVIDER_PREFLIGHT_PROTOCOL,
        executionId,
        grantDigest: expectedPreflightAuthorization.grantDigest,
        leaseReservationDigests:
          expectedPreflightAuthorization.leaseReservationDigests,
        authorizationDigest: expectedPreflightAuthorization.authorizationDigest,
        consumptionClaim: consumptionClaimProjection,
        operation: 'text-translation-preflight',
        inputMode: 'text-only',
        externalAudioSamples: 0,
        providerInvocationCount: 1,
        tokenBudget: expectedPreflightAuthorization.tokenBudget,
        inputTokens: 42,
        outputTokens: 7,
        audioSeconds: null,
      },
    });
    const preflightSourceRoot = path.join(root, 'provider-preflight-raw');
    const preflightExtraRoot = path.join(
      preflightSourceRoot,
      'diagnostics-bundle',
      'snapshots',
      'extra',
    );
    fs.mkdirSync(preflightExtraRoot, { recursive: true });
    fs.writeFileSync(
      path.join(preflightSourceRoot, 'emitter-result.json'),
      `${JSON.stringify({
        startedAt: new Date(baseMs - 6_900).toISOString(),
        completedAt: preflightRawTimes[1],
        desktopProcessId: consumptionClaim.desktopProcessId,
        desktopExecutable: consumptionClaim.desktopExecutablePath,
        desktopExecutableSha256: consumptionClaim.desktopExecutableSha256,
        inputTokens: 42,
        outputTokens: 7,
        audioSeconds: null,
        preflightAuthorization: observedPreflightAuthorization,
        providerConnectStartedAt,
        providerConnectCompletedAt,
      }, null, 2)}\n`,
      'utf8',
    );
    fs.writeFileSync(
      path.join(preflightSourceRoot, 'provider-probe-result.json'),
      `${JSON.stringify({
        providerId: PROVIDER_PREFLIGHT_PROVIDER_ID,
        templateId: 'template-dashscope-realtime',
        configuredModel,
        model: PROVIDER_PREFLIGHT_MODEL,
        protocol: PROVIDER_PREFLIGHT_PROTOCOL,
        preflightAuthorization: observedPreflightAuthorization,
        providerConnectStartedAt,
        providerConnectCompletedAt,
        checkedAt: providerCheckedAt,
        endpointHost: 'dashscope.aliyuncs.com',
        transportRequested: 'websocket',
        effectiveTransport: 'websocket',
        credentialStatus: {
          backend: 'windows-credential-manager',
          exists: true,
          reference: 'credential://provider/dashscope/default',
        },
        operation: 'text-translation-preflight',
        inputMode: 'text-only',
        externalAudioSamples: 0,
        providerInvocationCount: 1,
        inputTokens: 42,
        outputTokens: 7,
        audioSeconds: null,
        rawProbeResult: {
          configuredModel,
          model: PROVIDER_PREFLIGHT_MODEL,
          protocol: PROVIDER_PREFLIGHT_PROTOCOL,
          preflightAuthorization: observedPreflightAuthorization,
          providerConnectStartedAt,
          providerConnectCompletedAt,
          transportRequested: 'websocket',
          transportEffective: 'websocket',
          fallbackApplied: false,
          inputTokens: 42,
          outputTokens: 7,
          audioSeconds: null,
        },
      }, null, 2)}\n`,
      'utf8',
    );
    fs.writeFileSync(
      path.join(preflightSourceRoot, 'diagnostics-bundle', 'snapshots', 'config.json'),
      `${JSON.stringify({
        providers: [{
          providerId: PROVIDER_PREFLIGHT_PROVIDER_ID,
          templateId: 'template-dashscope-realtime',
          kind: 'dashscope',
          model: configuredModel,
          baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
          transport: 'websocket',
          streamEnabled: true,
          systemPromptTemplate: 'game-live-translation-cn',
          timeoutMs: 12_000,
          temperature: 0.2,
          maxOutputTokens: 256,
          responseModalities: ['text'],
          customHeaders: [],
          authRef: {
            kind: 'credential-ref',
            reference: 'credential://provider/dashscope/default',
            headerName: 'Authorization',
            scheme: 'bearer',
          },
        }],
      }, null, 2)}\n`,
      'utf8',
    );
    fs.writeFileSync(
      path.join(preflightExtraRoot, 'provider-probe-summary.json'),
      `${JSON.stringify({
        configuredModel,
        model: PROVIDER_PREFLIGHT_MODEL,
        protocol: PROVIDER_PREFLIGHT_PROTOCOL,
        preflightAuthorization: observedPreflightAuthorization,
        providerConnectStartedAt,
        providerConnectCompletedAt,
        transportEffective: 'websocket',
        inputTokens: 42,
        outputTokens: 7,
        audioSeconds: null,
      }, null, 2)}\n`,
      'utf8',
    );
    const preflight = writeCoordinatorProviderPreflightReceipt({
      executionRoot: coordinatorRoot,
      executionId,
      preflight: {
        providerId: PROVIDER_PREFLIGHT_PROVIDER_ID,
        operation: 'text-translation-preflight',
        inputMode: 'text-only',
        status: 'completed',
        externalAudioSamples: 0,
        providerInvocationCount: 1,
        model: PROVIDER_PREFLIGHT_MODEL,
        evidenceDirectory: preflightSourceRoot,
      },
      provenance: shardProvenance,
      generatedAt: new Date(baseMs - 4_000),
      workspaceRoot,
      validateEvidence: validateFixturePreflight,
      expectedAuthorization: expectedPreflightAuthorization,
    });
    const preflightCompletion = createProviderPreflightCompletion({
      grant: preflightGrant,
      leaseReservations: preflightReservations,
      preflightAuthority: preflight.authority,
      generatedAt: new Date(baseMs - 3_000),
      signingKeys,
    });
    const preflightCompletionPath = path.join(
      coordinatorRoot,
      PROVIDER_PREFLIGHT_COMPLETION_FILE,
    );
    fs.writeFileSync(
      preflightCompletionPath,
      `${JSON.stringify(preflightCompletion, null, 2)}\n`,
      'utf8',
    );
    const plan = createSignedExecutionPlan({
      executionId,
      generatedAt: new Date(baseMs - 2_000),
      expiresAt: new Date(baseMs + 86_400_000),
      provenance: shardProvenance,
      authorityImplementationHashes: implementationHashes,
      runtimeBinaryHashes,
      shardOrchestrationImplementationHashes: shardImplementationHashes,
      localIsolationAuthority,
      providerPreflightAuthority: preflight.authority,
      providerPreflightGrant: {
        ...fileAuthorityEntry(preflightGrantPath, PROVIDER_PREFLIGHT_GRANT_FILE),
        digest: preflightGrant.digest,
      },
      providerPreflightLeaseReservations:
        authorizationPackage.leaseReservationAuthorities,
      providerPreflightAuthorization: {
        grantDigest: preflightGrant.digest,
        leaseReservationDigests: preflightReservations.map((entry) => entry.digest),
        authorizationDigest: authorizationPackage.authorizationDigest,
        tokenBudget: structuredClone(expectedPreflightAuthorization.tokenBudget),
        consumptionClaim: consumptionClaimProjection,
      },
      providerPreflightCompletion: {
        ...fileAuthorityEntry(preflightCompletionPath, PROVIDER_PREFLIGHT_COMPLETION_FILE),
        digest: preflightCompletion.digest,
        grantDigest: preflightCompletion.grantDigest,
        authorizationDigest: preflightCompletion.authorizationDigest,
        tokenBudget: structuredClone(preflight.authority.tokenBudget),
        inputTokens: preflight.authority.inputTokens,
        outputTokens: preflight.authority.outputTokens,
        audioSeconds: preflight.authority.audioSeconds,
        consumptionClaim: consumptionClaimProjection,
      },
      workerReadinessRequest,
      workers,
      assignments,
      ...signingKeys,
    });
    const planPath = path.join(coordinatorRoot, SHARD_EXECUTION_PLAN_FILE);
    fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
    const leases = issueCellLeases(plan, signingKeys.privateKeyPem, {
      issuedAt: new Date(baseMs - 2_000),
    });
    const leasePaths = leases.map((lease) => {
      const leasePath = path.join(
        coordinatorRoot,
        'leases',
        `${String(lease.cellIndex + 1).padStart(2, '0')}.json`,
      );
      fs.mkdirSync(path.dirname(leasePath), { recursive: true });
      fs.writeFileSync(leasePath, `${JSON.stringify(lease, null, 2)}\n`, 'utf8');
      return leasePath;
    });

    const resultsByCell = new Map();
    const shardStates = workers.map((worker) => ({
      worker,
      shardRoot: path.join(coordinatorRoot, 'guest-shards', worker.workerId),
      resultPaths: [],
    }));
    for (const cell of plan.cells) {
      const state = shardStates.find((entry) => entry.worker.workerId === cell.workerId);
      const lease = leases.find((entry) => entry.leaseId === cell.leaseId);
      const runDirectory = writeAuthorityRawCell(
        state.shardRoot,
        `runs/cell-${cell.cellIndex}`,
        {
          modelId: cell.modelId,
          feedbackLoopPrevention: cell.feedbackLoopPrevention,
          deviceClass: cell.deviceClass,
          profileId: cell.deviceProfileInstance.profileId,
          runtimeBinaryHashes,
          healthyBridgeProbe: true,
        },
      );
      writeStrictPaidBudgetFixture(runDirectory, cell, {
        generatedAt: new Date(baseMs + cell.waveIndex * 3_000 + 500),
        leaseId: lease.leaseId,
      });
      fs.writeFileSync(
        path.join(runDirectory, SHARD_WORKER_READINESS_FILE),
        `${JSON.stringify(readinessReceipts.get(cell.workerId), null, 2)}\n`,
        'utf8',
      );
      writeInteractiveSessionBundleFixture(runDirectory, {
        plan,
        lease,
        worker: plan.workers.find((entry) => entry.workerId === cell.workerId),
        shardRoot: state.shardRoot,
        baseMs: baseMs + cell.waveIndex * 3_000,
      });
      fs.appendFileSync(
        path.join(runDirectory, 'app.log'),
        `subtitle cue appended cue_id=authority-cue translated=fixture-${cell.cellIndex}\n`,
        'utf8',
      );
      if (cell.feedbackLoopPrevention === 'process-exclusion') {
        writeProcessExclusionRestartFixture(runDirectory);
      }
      writeDirectoryReport({ inputDir: runDirectory, outputDir: runDirectory, mode: 'live' });
      // Bind the stored report to the fixture timeline. Reclassification uses
      // the wall clock, so leaving generatedAt at Date.now() makes this test
      // race its deliberately fixed receipt timestamp under parallel load.
      const reportPath = path.join(runDirectory, 'report.json');
      const storedFixtureReport = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      storedFixtureReport.generatedAt = new Date(
        baseMs + cell.waveIndex * 3_000 + 250,
      ).toISOString();
      fs.writeFileSync(reportPath, `${JSON.stringify(storedFixtureReport, null, 2)}\n`, 'utf8');
      const written = writeShardCellResult({
        plan,
        lease,
        workerId: cell.workerId,
        vmIdentity: state.worker.vmIdentity,
        shardRoot: state.shardRoot,
        runDirectory,
        provenance: shardProvenance,
        authorityImplementationHashes: implementationHashes,
        runtimeBinaryHashes,
        shardOrchestrationImplementationHashes: shardImplementationHashes,
        generatedAt: new Date(baseMs + cell.waveIndex * 3_000 + 500),
      });
      state.resultPaths.push(written.resultPath);
      resultsByCell.set(cell.cellId, written.result);
    }
    const shards = shardStates.map((state) => {
      const written = writeShardManifest({
        plan,
        leases,
        workerId: state.worker.workerId,
        shardRoot: state.shardRoot,
        resultPaths: state.resultPaths,
        generatedAt: new Date(baseMs + 30_000),
      });
      return {
        workerId: state.worker.workerId,
        shardRoot: state.shardRoot,
        manifestPath: written.manifestPath,
      };
    });

    for (const wave of plan.waves) {
      const waveStartMs = baseMs + wave.waveIndex * 3_000;
      for (const cellId of wave.cellIds) {
        const cell = plan.cells.find((entry) => entry.cellId === cellId);
        const lease = leases.find((entry) => entry.leaseId === cell.leaseId);
        claimCoordinatorCellDispatch({
          executionRoot: coordinatorRoot,
          plan,
          lease,
          cell,
          claimedAt: new Date(waveStartMs),
        });
      }
      completeCoordinatorWave({
        executionRoot: coordinatorRoot,
        plan,
        wave,
        results: resultsByCell,
        completedAt: new Date(waveStartMs + 1_000),
      });
    }
    const aggregated = writeCoordinatorAggregate({
      outputRoot: coordinatorRoot,
      plan,
      leases,
      shards,
      executionRoot: coordinatorRoot,
      generatedAt: new Date(baseMs + 31_000),
    });
    const staged = stageShardMatrixIntegration({
      evidenceRoot,
      executionRootName: 'staged-production-execution',
      planPath,
      leasePaths,
      coordinatorAggregatePath: aggregated.aggregatePath,
      shards,
      collectedMatrixIntegration: aggregated.matrixIntegration,
    });
    const stagedCellBudgets = staged.runDirectories.map((runDirectory) => JSON.parse(
      fs.readFileSync(path.join(runDirectory, 'external-provider-budget.json'), 'utf8'),
    ));
    const matrixBudget = writeMatrixExternalProviderBudget(evidenceRoot, stagedCellBudgets, {
      generatedAt: new Date(baseMs + 31_500),
      expectedCells: LIVE_LLM_CELLS,
      matrixCeilingSeconds: STRICT_PAID_MATRIX_CEILING_SECONDS,
    });
    const matrixBudgetAuthority = fileAuthorityEntry(
      matrixBudget.filePath,
      path.basename(matrixBudget.filePath),
    );
    const externalProviderBudget = {
      ...matrixBudget.ledger,
      ledgerPath: matrixBudgetAuthority.path,
      ledgerBytes: matrixBudgetAuthority.bytes,
      ledgerSha256: matrixBudgetAuthority.sha256,
    };
    const { manifestPath, manifest } = writeMatrixRunManifest({
      outputRoot: evidenceRoot,
      modelList: [...new Set(LIVE_LLM_CELLS.map((cell) => cell.modelId))],
      feedbackModeList: [...new Set(LIVE_LLM_CELLS.map((cell) => cell.feedbackLoopPrevention))],
      deviceProfiles: [{
        profileId: 'vmware-hda-default',
        deviceClass: 'default-speaker',
      }],
      runDirectories: staged.runDirectories,
      strict: true,
      now: new Date(baseMs + 32_000),
      provenance: shardProvenance,
      authorityRuntimeBinaryHashes: runtimeBinaryHashes,
      releaseCells: LIVE_LLM_CELLS,
      externalProviderBudget,
      shardExecution: staged.shardExecution,
      matrixIntegration: staged.matrixIntegration,
    });

    const verified = verifyProductionStrictMatrixAuthority({
      manifestPath,
      manifest,
      evidenceRoot,
      currentProvenance: shardProvenance,
      workspaceRoot,
      currentRuntimeBinaryHashes: runtimeBinaryHashes,
      releaseCells: LIVE_LLM_CELLS,
      requireLocalIsolation: false,
      now: baseMs + 33_000,
      validatePreflightEvidence: validateFixturePreflight,
    });
    assert.equal(verified.runDirectories.length, LIVE_LLM_CELLS.length);
    assert.equal(verified.shardAuthority.shardCellAuthorities.length, LIVE_LLM_CELLS.length);
    assert.equal(verified.shardAuthority.aggregate.budget.cellLeaseCount, LIVE_LLM_CELLS.length);
    assert.deepEqual(
      verified.shardAuthority.shardCellAuthorities.map((entry) => entry.origin),
      LIVE_LLM_CELLS.map(() => 'guest-shard-result'),
    );
    const verifyTampered = (candidate) => verifyStrictShardProviderPreflightAuthorization({
      plan: verified.shardAuthority.plan,
      executionRoot: verified.shardAuthority.executionRoot,
      executionRootRelative: candidate.shardExecution.executionRoot,
      evidenceRoot,
      workspaceRoot,
      shardExecution: candidate.shardExecution,
      matrixIntegration: candidate.matrixIntegration,
      currentImplementationHashes: verified.implementationHashes,
      currentRuntimeBinaryHashes: runtimeBinaryHashes,
      currentShardImplementationHashes:
        verified.shardAuthority.shardOrchestrationImplementationHashes,
      validationAt: new Date(baseMs + 14_000),
    });
    const missingGrantProjection = structuredClone(manifest);
    delete missingGrantProjection.shardExecution.providerPreflightGrant;
    assert.throws(
      () => verifyTampered(missingGrantProjection),
      /strict shard execution providerPreflightGrant/,
    );
    const reorderedReservations = structuredClone(manifest);
    reorderedReservations.matrixIntegration.providerPreflightLeaseReservations = [
      ...reorderedReservations.matrixIntegration.providerPreflightLeaseReservations,
    ].reverse();
    assert.throws(
      () => verifyTampered(reorderedReservations),
      /strict shard matrixIntegration providerPreflightLeaseReservations/,
    );
    const tamperedReadiness = structuredClone(manifest);
    tamperedReadiness.shardExecution.workerReadiness[0].sha256 = '0'.repeat(64);
    assert.throws(
      () => verifyTampered(tamperedReadiness),
      /strict shard execution workerReadiness/,
    );
    const stagedClaimPath = path.join(
      verified.shardAuthority.executionRoot,
      PROVIDER_PREFLIGHT_CONSUMPTION_CLAIM_FILE,
    );
    const originalClaimBytes = fs.readFileSync(stagedClaimPath);
    const tamperedClaim = JSON.parse(originalClaimBytes.toString('utf8'));
    tamperedClaim.desktopProcessId += 1;
    fs.writeFileSync(stagedClaimPath, `${JSON.stringify(tamperedClaim, null, 2)}\n`, 'utf8');
    assert.throws(
      () => verifyTampered(manifest),
      /consumption claim.*hash\/size binding mismatch|consumption claim.*hash\/size mismatch/,
    );
    fs.writeFileSync(stagedClaimPath, originalClaimBytes);
    const wrongClaimProjection = structuredClone(manifest);
    wrongClaimProjection.matrixIntegration.providerPreflightAuthorization
      .consumptionClaim.desktopExecutableSha256 = '0'.repeat(64);
    assert.throws(
      () => verifyTampered(wrongClaimProjection),
      /strict shard (?:execution|matrixIntegration) providerPreflightAuthorization/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('strict authority rejects duplicate Rust provider lease IDs across cells', () => {
  const root = makeTempRoot();
  const firstCell = {
    cellId: 'test::lease-unique::first',
    tier: 'pairwise-live',
    providerMode: 'live-dashscope',
    durationSeconds: 180,
    modelId: 'qwen3.5-omni-flash-realtime',
    feedbackLoopPrevention: 'echo-cancel',
    deviceClass: 'default-speaker',
  };
  const secondCell = {
    ...firstCell,
    cellId: 'test::lease-unique::second',
    modelId: 'qwen3.5-livetranslate-flash-realtime',
  };
  const firstRunDirectory = writeAuthorityRawCell(root, 'authority-lease-first', firstCell);
  const secondRunDirectory = writeAuthorityRawCell(root, 'authority-lease-second', secondCell);
  const { manifestPath, manifest } = writeAuthorityMatrixManifest(root, [{
    runDirectory: firstRunDirectory,
    cell: firstCell,
  }, {
    runDirectory: secondRunDirectory,
    cell: secondCell,
  }]);
  const firstLedger = JSON.parse(fs.readFileSync(
    path.join(firstRunDirectory, 'provider-input-budget-ledger.json'),
    'utf8',
  ));
  const duplicateLeaseId = firstLedger.leaseId;
  const secondLedgerPath = path.join(secondRunDirectory, 'provider-input-budget-ledger.json');
  const secondLeasePath = path.join(secondRunDirectory, 'provider-input-budget-lease.json');
  const secondJournalPath = path.join(secondRunDirectory, 'provider-input-budget-ledger.json.journal.jsonl');
  const secondLedger = JSON.parse(fs.readFileSync(secondLedgerPath, 'utf8'));
  secondLedger.leaseId = duplicateLeaseId;
  fs.writeFileSync(secondLedgerPath, `${JSON.stringify(secondLedger, null, 2)}\n`, 'utf8');
  const secondLease = JSON.parse(fs.readFileSync(secondLeasePath, 'utf8'));
  secondLease.leaseId = duplicateLeaseId;
  fs.writeFileSync(secondLeasePath, `${JSON.stringify(secondLease, null, 2)}\n`, 'utf8');
  const secondJournal = fs.readFileSync(secondJournalPath, 'utf8').trim().split(/\r?\n/).map((line) => {
    const entry = JSON.parse(line);
    entry.leaseId = duplicateLeaseId;
    return entry;
  });
  fs.writeFileSync(
    secondJournalPath,
    `${secondJournal.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    'utf8',
  );
  rewriteRecordedCellBudget(secondRunDirectory, secondCell);
  refreshCellReceiptArtifacts(root, manifest, 1, [
    'external-provider-budget.json',
    'provider-input-budget-lease.json',
    'provider-input-budget-ledger.json',
    'provider-input-budget-ledger.json.journal.jsonl',
  ]);
  const matrixPath = path.join(root, manifest.externalProviderBudget.ledgerPath);
  const matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
  matrix.cells[1].leaseId = duplicateLeaseId;
  fs.writeFileSync(matrixPath, `${JSON.stringify(matrix, null, 2)}\n`, 'utf8');
  refreshMatrixBudgetAuthority(root, manifest);

  assert.throws(
    () => verifyStrictMatrixAuthority({
      manifestPath,
      manifest,
      evidenceRoot: root,
      currentProvenance: CLEAN_CURRENT_PROVENANCE,
      workspaceRoot: path.resolve('.'),
      currentRuntimeBinaryHashes: TEST_RUNTIME_BINARY_HASHES,
    }),
    /reuses Rust provider leaseId/,
  );
});

test('strict authority rejects reordered matrix budget cells after the ledger hash is refreshed', () => {
  const root = makeTempRoot();
  const cells = ['first', 'second'].map((suffix, index) => ({
    cellId: `test::ordered-budget::${suffix}`,
    tier: 'pairwise-live',
    providerMode: 'live-dashscope',
    durationSeconds: 180,
    modelId: index === 0
      ? 'qwen3.5-omni-flash-realtime'
      : 'qwen3.5-livetranslate-flash-realtime',
    feedbackLoopPrevention: 'echo-cancel',
    deviceClass: 'default-speaker',
  }));
  const entries = cells.map((cell, index) => ({
    runDirectory: writeAuthorityRawCell(root, `authority-order-${index}`, cell),
    cell,
  }));
  const { manifestPath, manifest } = writeAuthorityMatrixManifest(root, entries);
  const matrixPath = path.join(root, manifest.externalProviderBudget.ledgerPath);
  const matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
  matrix.cells.reverse();
  fs.writeFileSync(matrixPath, `${JSON.stringify(matrix, null, 2)}\n`, 'utf8');
  refreshMatrixBudgetAuthority(root, manifest);

  assert.throws(
    () => verifyStrictMatrixAuthority({
      manifestPath,
      manifest,
      evidenceRoot: root,
      currentProvenance: CLEAN_CURRENT_PROVENANCE,
      workspaceRoot: path.resolve('.'),
      currentRuntimeBinaryHashes: TEST_RUNTIME_BINARY_HASHES,
    }),
    /paid-matrix budget ledger does not match rebuilt cell authorities/,
  );
});

test('canonical strict authority round-trips the complete verifier receipt cell identity', () => {
  const root = makeTempRoot();
  const runDirectory = writeAuthorityRawCell(root, 'authority-canonical-round-trip');
  const { manifestPath, manifest } = writeAuthorityManifest(root, runDirectory);
  const verificationNow = new Date(Date.now() + 2_000);
  const authority = verifyStrictMatrixAuthority({
    manifestPath,
    manifest,
    evidenceRoot: root,
    currentProvenance: CLEAN_CURRENT_PROVENANCE,
    workspaceRoot: path.resolve('.'),
    now: verificationNow.getTime(),
    currentRuntimeBinaryHashes: TEST_RUNTIME_BINARY_HASHES,
  });
  const verification = writeStrictMatrixVerificationReceipt({
    manifestPath,
    manifest,
    authority,
    currentProvenance: CLEAN_CURRENT_PROVENANCE,
    now: verificationNow,
  });
  const sourceManifest = fileAuthorityEntry(manifestPath, path.basename(manifestPath));
  const verificationReceipt = fileAuthorityEntry(
    verification.receiptPath,
    path.basename(verification.receiptPath),
  );
  const canonicalPath = path.join(root, 'canonical-strict-matrix.json');
  const canonicalManifest = {
    ...manifest,
    verification: 'passed',
    verifiedAt: verification.receipt.verifiedAt,
    verificationProvenance: CLEAN_CURRENT_PROVENANCE,
    sourceManifest: sourceManifest.path,
    sourceManifestSha256: sourceManifest.sha256,
    sourceManifestBytes: sourceManifest.bytes,
    verificationReceiptPath: verificationReceipt.path,
    verificationReceiptSha256: verificationReceipt.sha256,
    verificationReceiptBytes: verificationReceipt.bytes,
  };
  fs.writeFileSync(canonicalPath, `${JSON.stringify(canonicalManifest, null, 2)}\n`, 'utf8');

  const verifiedCanonical = verifyStrictMatrixAuthority({
    manifestPath: canonicalPath,
    manifest: JSON.parse(fs.readFileSync(canonicalPath, 'utf8')),
    evidenceRoot: root,
    currentProvenance: CLEAN_CURRENT_PROVENANCE,
    workspaceRoot: path.resolve('.'),
    now: verificationNow.getTime() + 1_000,
    currentRuntimeBinaryHashes: TEST_RUNTIME_BINARY_HASHES,
  });

  assert.deepEqual(verifiedCanonical.runDirectories, [runDirectory]);
  assert.deepEqual(
    verification.receipt.paidImplementationHashes,
    authority.paidImplementationHashes,
  );
  assert.deepEqual(
    verification.receipt.externalProviderBudget,
    manifest.externalProviderBudget,
  );
  assert.deepEqual(verification.receipt.cells[0], {
    cellId: manifest.cells[0].cellId,
    tier: manifest.cells[0].tier,
    providerMode: manifest.cells[0].providerMode,
    durationSeconds: manifest.cells[0].durationSeconds,
    modelId: manifest.cells[0].modelId,
    feedbackLoopPrevention: manifest.cells[0].feedbackLoopPrevention,
    deviceClass: manifest.cells[0].deviceClass,
    deviceProfileId: manifest.cells[0].deviceProfileId,
    runDirectory: manifest.cells[0].runDirectory,
    receiptPath: manifest.cells[0].receiptPath,
    receiptBytes: manifest.cells[0].receiptBytes,
    receiptSha256: manifest.cells[0].receiptSha256,
  });

  const tamperedBudgetReceipt = structuredClone(verification.receipt);
  tamperedBudgetReceipt.externalProviderBudget.actualProviderInputSamples += 1;
  fs.writeFileSync(
    verification.receiptPath,
    `${JSON.stringify(tamperedBudgetReceipt, null, 2)}\n`,
    'utf8',
  );
  const tamperedBudgetReceiptAuthority = fileAuthorityEntry(
    verification.receiptPath,
    path.basename(verification.receiptPath),
  );
  assert.throws(
    () => verifyStrictMatrixAuthority({
      manifestPath: canonicalPath,
      manifest: {
        ...canonicalManifest,
        verificationReceiptSha256: tamperedBudgetReceiptAuthority.sha256,
        verificationReceiptBytes: tamperedBudgetReceiptAuthority.bytes,
      },
      evidenceRoot: root,
      currentProvenance: CLEAN_CURRENT_PROVENANCE,
      workspaceRoot: path.resolve('.'),
      now: verificationNow.getTime() + 1_000,
      currentRuntimeBinaryHashes: TEST_RUNTIME_BINARY_HASHES,
    }),
    /canonical strict verification receipt external provider budget does not match/,
  );
  fs.writeFileSync(
    verification.receiptPath,
    `${JSON.stringify(verification.receipt, null, 2)}\n`,
    'utf8',
  );

  const incompleteReceipt = JSON.parse(fs.readFileSync(verification.receiptPath, 'utf8'));
  delete incompleteReceipt.cells[0].durationSeconds;
  fs.writeFileSync(
    verification.receiptPath,
    `${JSON.stringify(incompleteReceipt, null, 2)}\n`,
    'utf8',
  );
  const incompleteReceiptAuthority = fileAuthorityEntry(
    verification.receiptPath,
    path.basename(verification.receiptPath),
  );
  const incompleteCanonical = {
    ...canonicalManifest,
    verificationReceiptSha256: incompleteReceiptAuthority.sha256,
    verificationReceiptBytes: incompleteReceiptAuthority.bytes,
  };
  assert.throws(
    () => verifyStrictMatrixAuthority({
      manifestPath: canonicalPath,
      manifest: incompleteCanonical,
      evidenceRoot: root,
      currentProvenance: CLEAN_CURRENT_PROVENANCE,
      workspaceRoot: path.resolve('.'),
      now: verificationNow.getTime() + 1_000,
      currentRuntimeBinaryHashes: TEST_RUNTIME_BINARY_HASHES,
    }),
    /canonical strict verification receipt cells does not match/,
  );
});

test('strict authority binds the metrics tree to the Desktop PID launched by the production runner', () => {
  const root = makeTempRoot();
  const runDirectory = writeAuthorityRawCell(root, 'authority-metrics-root-mismatch');
  const metricsPath = path.join(runDirectory, 'system-metrics.json');
  const metrics = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));
  metrics.rootProcessId += 1;
  fs.writeFileSync(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`, 'utf8');
  const { manifestPath, manifest } = writeAuthorityManifest(root, runDirectory);

  assert.throws(
    () => verifyStrictMatrixAuthority({
      manifestPath,
      manifest,
      evidenceRoot: root,
      currentProvenance: CLEAN_CURRENT_PROVENANCE,
      workspaceRoot: path.resolve('.'),
      now: Date.now() + 2_000,
      currentRuntimeBinaryHashes: TEST_RUNTIME_BINARY_HASHES,
    }),
    /system metrics do not prove the complete production Desktop process-tree lifetime/,
  );
});

test('strict process-exclusion authority independently recomputes the three-tone WAV isolation evidence', () => {
  const root = makeTempRoot();
  const options = {
    feedbackLoopPrevention: 'process-exclusion',
    modelId: 'qwen3.5-omni-flash-realtime',
  };
  const runDirectory = writeAuthorityRawCell(root, 'authority-process-wav', options);
  const { manifestPath, manifest } = writeAuthorityManifest(root, runDirectory, options);

  const verified = verifyStrictMatrixAuthority({
    manifestPath,
    manifest,
    evidenceRoot: root,
    currentProvenance: CLEAN_CURRENT_PROVENANCE,
    workspaceRoot: path.resolve('.'),
    currentRuntimeBinaryHashes: TEST_RUNTIME_BINARY_HASHES,
    now: Date.now() + 2_000,
  });

  assert.equal(verified.authorizedReports.size, 1);
  assert.equal(verified.translatedPcmLoopbackAuthorities[0].passed, true);
});

test('strict translated PCM verifier rehashes every cue and rejects matcher-output tampering', () => {
  const root = makeTempRoot();
  const options = {
    feedbackLoopPrevention: 'process-exclusion',
    modelId: 'qwen3.5-omni-flash-realtime',
  };
  const runDirectory = writeAuthorityRawCell(root, 'authority-translated-pcm-tamper', options);
  const { manifest } = writeAuthorityManifest(root, runDirectory, options);
  const cell = manifest.cells[0];
  const cellExternalProviderBudget = JSON.parse(fs.readFileSync(
    path.join(runDirectory, 'external-provider-budget.json'),
    'utf8',
  ));
  const initial = assertStrictTranslatedPcmLoopbackAuthority({
    runDirectory,
    cell,
    cellExternalProviderBudget,
    index: 0,
  });
  assert.equal(initial.passed, true);

  const stdoutPath = path.join(runDirectory, 'translated-pcm-loopback.stdout.json');
  const stdout = JSON.parse(fs.readFileSync(stdoutPath, 'utf8'));
  stdout.matchedCueCount -= 1;
  fs.writeFileSync(stdoutPath, `${JSON.stringify(stdout, null, 2)}\n`, 'utf8');
  assert.throws(
    () => assertStrictTranslatedPcmLoopbackAuthority({
      runDirectory,
      cell,
      cellExternalProviderBudget,
      index: 0,
    }),
    /translated PCM matcher output does not match/,
  );

  fs.writeFileSync(stdoutPath, `${JSON.stringify(initial, null, 2)}\n`, 'utf8');
  const summary = JSON.parse(fs.readFileSync(
    path.join(runDirectory, 'translated-cue-pcm', 'translated-cue-pcm-summary.json'),
    'utf8',
  ));
  fs.appendFileSync(
    path.join(runDirectory, 'translated-cue-pcm', summary.acceptedCues[0].relativePath),
    Buffer.from([0, 0]),
  );
  assert.throws(
    () => assertStrictTranslatedPcmLoopbackAuthority({
      runDirectory,
      cell,
      cellExternalProviderBudget,
      index: 0,
    }),
    /translated PCM loopback authority failed raw reconstruction.*file hash\/length mismatch/,
  );
});

test('strict virtual-driver authority binds the running SYS and signature identity to the current package', () => {
  const root = makeTempRoot();
  const runtimeBinaryHashes = [{
    path: 'drivers/windows-virtual-mic/package/omni-virtual-speaker.sys',
    bytes: 123,
    sha256: 'driver-package-hash',
  }, {
    path: 'drivers/windows-virtual-mic/package/omni-virtual-speaker.cat',
    bytes: 123,
    sha256: 'driver-catalog-hash',
  }, {
    path: 'drivers/windows-virtual-mic/package/omni-virtual-speaker.inf',
    bytes: 123,
    sha256: 'driver-inf-hash',
  }];
  const options = {
    feedbackLoopPrevention: 'virtual-driver',
    modelId: 'qwen3.5-omni-flash-realtime',
    runtimeBinaryHashes,
  };
  const runDirectory = writeAuthorityRawCell(root, 'authority-installed-driver', options);
  const { manifestPath, manifest } = writeAuthorityManifest(root, runDirectory, options);

  const verified = verifyStrictMatrixAuthority({
    manifestPath,
    manifest,
    evidenceRoot: root,
    currentProvenance: CLEAN_CURRENT_PROVENANCE,
    workspaceRoot: path.resolve('.'),
    currentRuntimeBinaryHashes: runtimeBinaryHashes,
    now: Date.now() + 2_000,
  });

  assert.equal(verified.authorizedReports.size, 1);
});

test('strict authority rejects a report-only schema-v1 matrix even when all 18 summaries are handmade', () => {
  const root = makeTempRoot();
  const runDirectories = [];
  for (let index = 0; index < 18; index += 1) {
    const directory = path.join(root, `handmade-${index}`);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'report.json'), '{}\n', 'utf8');
    runDirectories.push(path.basename(directory));
  }
  const manifestPath = path.join(root, 'handmade-matrix.json');
  const manifest = {
    schemaVersion: 1,
    evidenceMode: 'live',
    strict: true,
    provenance: CLEAN_CURRENT_PROVENANCE,
    runDirectories,
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  assert.throws(
    () => verifyStrictMatrixAuthority({
      manifestPath,
      manifest,
      evidenceRoot: root,
      currentProvenance: CLEAN_CURRENT_PROVENANCE,
      workspaceRoot: path.resolve('.'),
      currentRuntimeBinaryHashes: TEST_RUNTIME_BINARY_HASHES,
    }),
    /requires watch-mode-strict-matrix-authority schemaVersion=4/,
  );
});

test('production strict CLI rejects the legacy --run-directories escape hatch', () => {
  const root = makeTempRoot();
  const result = spawnSync(process.execPath, [
    path.resolve('scripts/testing/verify-watch-mode-evidence.mjs'),
    '--root', root,
    '--strict',
    '--run-directories', JSON.stringify(['handmade-run']),
  ], { encoding: 'utf8' });

  assert.equal(result.status, 1);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /strict evidence does not accept --run-directories/,
  );
});

test('strict authority rejects an artifact changed after the runner receipt was emitted', () => {
  const root = makeTempRoot();
  const runDirectory = writeAuthorityRawCell(root, 'authority-hash-change');
  const { manifestPath, manifest } = writeAuthorityManifest(root, runDirectory);
  fs.appendFileSync(path.join(runDirectory, 'app.log'), 'tampered after receipt\n', 'utf8');

  assert.throws(
    () => verifyStrictMatrixAuthority({
      manifestPath,
      manifest,
      evidenceRoot: root,
      currentProvenance: CLEAN_CURRENT_PROVENANCE,
      workspaceRoot: path.resolve('.'),
      currentRuntimeBinaryHashes: TEST_RUNTIME_BINARY_HASHES,
    }),
    /hash\/size mismatch for app\.log/,
  );
});

test('strict authority rejects swapping a manifest cell to a copied run directory', () => {
  const root = makeTempRoot();
  const runDirectory = writeAuthorityRawCell(root, 'authority-original');
  const { manifestPath, manifest } = writeAuthorityManifest(root, runDirectory);
  const copiedDirectory = path.join(root, 'authority-copy');
  fs.cpSync(runDirectory, copiedDirectory, { recursive: true });
  manifest.runDirectories[0] = 'authority-copy';
  manifest.cells[0].runDirectory = 'authority-copy';
  manifest.cells[0].receiptPath = `authority-copy/${path.basename(manifest.cells[0].receiptPath)}`;

  assert.throws(
    () => verifyStrictMatrixAuthority({
      manifestPath,
      manifest,
      evidenceRoot: root,
      currentProvenance: CLEAN_CURRENT_PROVENANCE,
      workspaceRoot: path.resolve('.'),
      currentRuntimeBinaryHashes: TEST_RUNTIME_BINARY_HASHES,
    }),
    /receipt runDirectory mismatch/,
  );
});

test('strict authority rejects a self-consistently rehashed summary that disagrees with raw evidence', () => {
  const root = makeTempRoot();
  const runDirectory = writeAuthorityRawCell(root, 'authority-summary-change');
  const reportPath = path.join(runDirectory, 'report.json');
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  report.modelId = 'forged-model';
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  const { manifestPath, manifest } = writeAuthorityManifest(root, runDirectory, {
    rebuildReportAfterBudget: false,
  });

  assert.throws(
    () => verifyStrictMatrixAuthority({
      manifestPath,
      manifest,
      evidenceRoot: root,
      currentProvenance: CLEAN_CURRENT_PROVENANCE,
      workspaceRoot: path.resolve('.'),
      currentRuntimeBinaryHashes: TEST_RUNTIME_BINARY_HASHES,
    }),
    /report\.json does not match the independently rebuilt raw evidence/,
  );
});

test('strict authority rejects an old receipt and cannot refresh evidence age during rebuild', () => {
  const root = makeTempRoot();
  const runDirectory = writeAuthorityRawCell(root, 'authority-stale');
  const oldNow = new Date('2026-06-01T00:00:00.000Z');
  const { manifestPath, manifest } = writeAuthorityManifest(root, runDirectory, { now: oldNow });

  assert.throws(
    () => verifyStrictMatrixAuthority({
      manifestPath,
      manifest,
      evidenceRoot: root,
      currentProvenance: CLEAN_CURRENT_PROVENANCE,
      workspaceRoot: path.resolve('.'),
      now: Date.parse('2026-08-10T00:00:00.000Z'),
      currentRuntimeBinaryHashes: TEST_RUNTIME_BINARY_HASHES,
    }),
    /manifest is stale/,
  );
});

test('strict manifest provenance must match the exact clean current HEAD', () => {
  const manifest = { provenance: CLEAN_CURRENT_PROVENANCE };
  assert.equal(
    strictManifestProvenanceFailure(manifest, {
      currentProvenance: CLEAN_CURRENT_PROVENANCE,
    }),
    null,
  );
  assert.match(
    strictManifestProvenanceFailure(manifest, {
      currentProvenance: {
        ...CLEAN_CURRENT_PROVENANCE,
        headCommit: 'fixture-newer-head',
      },
    }) ?? '',
    /does not exactly match current HEAD.*ancestor commits are not accepted/,
  );
  assert.match(
    strictManifestProvenanceFailure(manifest, {
      currentProvenance: {
        ...CLEAN_CURRENT_PROVENANCE,
        worktreeClean: false,
        dirtyEntryCount: 1,
      },
    }) ?? '',
    /dirty worktree or untracked source state/,
  );
  assert.match(
    strictManifestProvenanceFailure({
      ...manifest,
      verification: 'passed',
    }, {
      currentProvenance: CLEAN_CURRENT_PROVENANCE,
    }) ?? '',
    /canonical manifest verificationProvenance is missing/,
  );
  assert.equal(
    strictManifestProvenanceFailure({
      ...manifest,
      verification: 'passed',
      verificationProvenance: CLEAN_CURRENT_PROVENANCE,
    }, {
      currentProvenance: CLEAN_CURRENT_PROVENANCE,
    }),
    null,
  );
});

test('strict model matrix requires every requested model', () => {
  const root = makeTempRoot();
  const strictLayers = strictContentLayers();
  writeReport(root, '20260605-191332-qwen3.5-omni-flash-realtime', {
    modelId: 'qwen3.5-omni-flash-realtime',
    layers: strictLayers,
  });
  writeReport(root, '20260605-201332-qwen3.5-livetranslate-flash-realtime', {
    modelId: 'qwen3.5-livetranslate-flash-realtime',
    verdict: 'failed',
    failureLayer: 'provider',
    failureReason: 'provider request failed in the current matrix cell',
    layers: {
      ...strictLayers,
      provider: { status: 'failed', reason: 'provider request failed in the current matrix cell' },
    },
  });

  const result = findScopedStrictEvidence(root, {
    models: [
      'qwen3.5-omni-flash-realtime',
      'qwen3.5-livetranslate-flash-realtime',
    ],
    ...provenanceOk,
  });

  assert.equal(result.ok, false);
  assert.equal(result.modelResults.length, 2);
  assert.equal(result.modelResults[0].ok, true);
  assert.equal(result.modelResults[1].ok, false);
  assert.match(result.reason, /qwen3\.5-livetranslate-flash-realtime/);
});

test('strict model matrix passes when both requested models pass', () => {
  const root = makeTempRoot();
  const strictLayers = strictContentLayers();
  writeReport(root, '20260605-191332-qwen3.5-omni-flash-realtime', {
    generatedAt: '2026-06-05T11:13:32.000Z',
    modelId: 'qwen3.5-omni-flash-realtime',
    layers: strictLayers,
  });
  writeReport(root, '20260605-201332-qwen3.5-livetranslate-flash-realtime', {
    generatedAt: '2026-06-05T12:13:32.000Z',
    modelId: 'qwen3.5-livetranslate-flash-realtime',
    layers: strictLayers,
  });

  const result = findScopedStrictEvidence(root, {
    models: [
      'qwen3.5-omni-flash-realtime',
      'qwen3.5-livetranslate-flash-realtime',
    ],
    ...provenanceOk,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.modelResults.map((item) => item.modelId), [
    'qwen3.5-omni-flash-realtime',
    'qwen3.5-livetranslate-flash-realtime',
  ]);
});

test('echo-cancel variant report passes with the reduced layer set when requested', () => {
  const root = makeTempRoot();
  writeReport(root, '20260605-191332-echo-cancel', {
    feedbackLoopPrevention: 'echo-cancel',
    layers: echoCancelLayers(),
  });

  const result = findScopedStrictEvidence(root, { feedbackModes: ['echo-cancel'], ...provenanceOk });

  assert.equal(result.ok, true);
  assert.equal(result.latest.feedbackMode, 'echo-cancel');
  assert.equal(result.latest.report.feedbackLoopPrevention, 'echo-cancel');
});

test('strict AEC evidence requires real three-stage render injection and zero subtitle loss', () => {
  const healthyReport = {
    mode: 'live',
    layers: { aec: { status: 'passed', data: structuredClone(healthyAecScenarioData) } },
  };
  assert.equal(strictAecScenarioFailure(healthyReport), null);

  const simulated = structuredClone(healthyReport);
  simulated.layers.aec.data.liveScenario.fixtureOnly = true;
  assert.match(strictAecScenarioFailure(simulated), /fixture\/simulated/i);

  const noDoubleTalk = structuredClone(healthyReport);
  noDoubleTalk.layers.aec.data.maxDoubleTalkFrames = 0;
  assert.match(strictAecScenarioFailure(noDoubleTalk), /double-talk telemetry/i);

  const staticDelay = structuredClone(healthyReport);
  staticDelay.layers.aec.data.reportedDelaySpanMs = 0;
  assert.match(strictAecScenarioFailure(staticDelay), /dynamic change/i);

  const missingNonlinear = structuredClone(healthyReport);
  missingNonlinear.layers.aec.data.liveScenario.stages.nonlinear.nonlinearity = 'none';
  assert.match(strictAecScenarioFailure(missingNonlinear), /stage nonlinear/i);

  const unchangedNonlinearPcm = structuredClone(healthyReport);
  unchangedNonlinearPcm.layers.aec.data.liveScenario.stages.nonlinear.changedSamples = 0;
  unchangedNonlinearPcm.layers.aec.data.liveScenario.stages.nonlinear.changedRatio = 0;
  assert.match(strictAecScenarioFailure(unchangedNonlinearPcm), /stage nonlinear/i);

  const missingSubtitle = structuredClone(healthyReport);
  missingSubtitle.layers.aec.data.liveScenario.expectedSubtitles.acceptedSegmentCount = 5;
  missingSubtitle.layers.aec.data.liveScenario.expectedSubtitles.acceptanceRate = 5 / 6;
  assert.match(strictAecScenarioFailure(missingSubtitle), /100% of expected subtitle segments/i);

  const syntheticSubtitleSummary = structuredClone(healthyReport);
  syntheticSubtitleSummary.layers.aec.data.liveScenario.expectedSubtitles.acceptedSource =
    'synthetic-summary';
  assert.match(
    strictAecScenarioFailure(syntheticSubtitleSummary),
    /100% of expected subtitle segments/i,
  );

  const deletedCapture = structuredClone(healthyReport);
  deletedCapture.layers.aec.data.maxAsrDeletedChunks = 1;
  assert.match(strictAecScenarioFailure(deletedCapture), /deleted ASR capture chunks/i);

  const dryRun = structuredClone(healthyReport);
  dryRun.mode = 'dry-run';
  assert.match(strictAecScenarioFailure(dryRun), /live run/i);
});

test('strict process-exclusion evidence requires a real midpoint restart across the required timeline', () => {
  const healthyReport = {
    mode: 'live',
    layers: {
      bridge: {
        status: 'passed',
        data: { processExclusionRestart: structuredClone(healthyProcessRestartData) },
      },
    },
  };
  assert.equal(strictProcessExclusionRestartFailure(healthyReport), null);

  const fiveMinuteSimulation = structuredClone(healthyReport);
  const evidence = fiveMinuteSimulation.layers.bridge.data.processExclusionRestart;
  evidence.systemMetrics.durationMs = 300_000;
  evidence.systemMetrics.finishedAt = new Date(PROCESS_METRICS_STARTED_AT_MS + 300_000).toISOString();
  assert.match(strictProcessExclusionRestartFailure(fiveMinuteSimulation), /required real process-tree/i);

  const sameIdentity = structuredClone(healthyReport);
  sameIdentity.layers.bridge.data.processExclusionRestart.newBridgeProcessId = 4242;
  assert.match(strictProcessExclusionRestartFailure(sameIdentity), /new Bridge PID/i);

  const staleFrame = structuredClone(healthyReport);
  staleFrame.layers.bridge.data.processExclusionRestart.oldFramesAfterRestart = 1;
  assert.match(strictProcessExclusionRestartFailure(staleFrame), /zero old-generation frames/i);

  const staleReadOrder = structuredClone(healthyReport);
  staleReadOrder.layers.bridge.data.processExclusionRestart.newFirstFrameReadTimestampMs =
    staleReadOrder.layers.bridge.data.processExclusionRestart.oldLastFrameReadTimestampMs;
  assert.match(strictProcessExclusionRestartFailure(staleReadOrder), /zero old-generation frames/i);

  const fixtureOnly = structuredClone(healthyReport);
  fixtureOnly.layers.bridge.data.processExclusionRestart.fixtureOnly = true;
  assert.match(strictProcessExclusionRestartFailure(fixtureOnly), /fixture\/simulated/i);

  const dryRun = structuredClone(healthyReport);
  dryRun.mode = 'dry-run';
  assert.match(strictProcessExclusionRestartFailure(dryRun), /live run/i);
});

test('default gate ignores echo-cancel runs so virtual-driver evidence stays authoritative', () => {
  const root = makeTempRoot();
  writeReport(root, '20260605-201332-echo-cancel', {
    generatedAt: '2026-06-05T12:13:32.000Z',
    feedbackLoopPrevention: 'echo-cancel',
    layers: echoCancelLayers(),
  });
  writeReport(root, '20260605-191332', { generatedAt: '2026-06-05T11:13:32.000Z' });

  const result = findWatchModeEvidence({ root });

  assert.equal(result.ok, true);
  assert.equal(result.latest.directoryName, '20260605-191332');
  assert.equal(result.latest.feedbackMode, 'virtual-driver');
});

test('strict feedback-mode matrix requires every model and feedback mode combination', () => {
  const root = makeTempRoot();
  const strictLayers = strictContentLayers();
  writeReport(root, '20260605-191332-omni', {
    modelId: 'qwen3.5-omni-flash-realtime',
    layers: strictLayers,
  });
  writeReport(root, '20260605-201332-omni-echo-cancel', {
    generatedAt: '2026-06-05T12:13:32.000Z',
    modelId: 'qwen3.5-omni-flash-realtime',
    feedbackLoopPrevention: 'echo-cancel',
    layers: echoCancelLayers(),
  });
  writeReport(root, '20260605-211332-livetranslate', {
    modelId: 'qwen3.5-livetranslate-flash-realtime',
    verdict: 'failed',
    failureLayer: 'provider',
    failureReason: 'provider request failed in the current matrix cell',
    layers: {
      ...strictLayers,
      provider: { status: 'failed', reason: 'provider request failed in the current matrix cell' },
    },
  });
  writeReport(root, '20260605-221332-livetranslate-echo-cancel', {
    modelId: 'qwen3.5-livetranslate-flash-realtime',
    feedbackLoopPrevention: 'echo-cancel',
    verdict: 'failed',
    failureLayer: 'provider',
    failureReason: 'provider request failed in the current matrix cell',
    layers: {
      ...echoCancelLayers(),
      provider: { status: 'failed', reason: 'provider request failed in the current matrix cell' },
    },
  });

  const result = findScopedStrictEvidence(root, {
    models: [
      'qwen3.5-omni-flash-realtime',
      'qwen3.5-livetranslate-flash-realtime',
    ],
    feedbackModes: ['virtual-driver', 'echo-cancel'],
    ...provenanceOk,
  });

  assert.equal(result.ok, false);
  assert.equal(result.modelResults.length, 4);
  assert.equal(result.modelResults.filter((item) => item.ok).length, 2);
  assert.match(result.reason, /qwen3\.5-livetranslate-flash-realtime\[virtual-driver\]/);
  assert.match(result.reason, /qwen3\.5-livetranslate-flash-realtime\[echo-cancel\]/);
});

test('strict mode rejects a completed live report shorter than thirty minutes', () => {
  const root = makeTempRoot();
  writeReport(root, '20260605-191332-short-live', {
    layers: strictContentLayers(),
    watchSessionReport: {
      ...healthyWatchSessionReport,
      elapsedMs: MIN_STRICT_SESSION_DURATION_MS - 1,
      summary: {
        ...healthyWatchSessionReport.summary,
        durationMs: MIN_STRICT_SESSION_DURATION_MS - 1,
      },
    },
  });

  const result = findScopedStrictEvidence(root, provenanceOk);

  assert.equal(result.ok, false);
  assert.match(result.reason, /duration is too short/);
  assert.deepEqual(result.failedLayers, ['watchSessionReport']);
});

test('strict device matrix rejects a live report without classifiable endpoint evidence', () => {
  const root = makeTempRoot();
  writeReport(root, '20260605-191332-missing-device', {
    modelId: 'qwen3.5-omni-flash-realtime',
    layers: strictContentLayers(),
  });

  const result = findScopedStrictEvidence(root, {
    models: ['qwen3.5-omni-flash-realtime'],
    feedbackModes: ['virtual-driver'],
    deviceClasses: ['default-speaker'],
    ...provenanceOk,
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /missingLayers=deviceEvidence/);
  assert.match(result.reason, /requires report\.deviceEvidence/);
});

test('strict device matrix rejects one captured session copied across model cells', () => {
  const root = makeTempRoot();
  const models = ['qwen3.5-omni-flash-realtime', 'qwen3.5-livetranslate-flash-realtime'];
  for (const [index, modelId] of models.entries()) {
    writeReport(root, `20260605-19133${index}-default-speaker`, {
      modelId,
      layers: strictContentLayers(),
      deviceEvidence: deviceEvidence('default-speaker'),
      watchSessionReport: {
        ...healthyWatchSessionReport,
        sessionId: 'copied-watch-session',
      },
    });
  }

  const result = findScopedStrictEvidence(root, {
    models,
    feedbackModes: ['virtual-driver'],
    deviceClasses: ['default-speaker'],
    ...provenanceOk,
  });

  assert.equal(result.ok, false);
  assert.equal(result.modelResults.length, 2);
  assert.ok(result.modelResults.every((entry) => !entry.ok));
  assert.match(result.reason, /duplicate live artifact\/session/);
});

test('strict device matrix accepts the complete two-model by three-route single-device grid', () => {
  const root = makeTempRoot();
  const models = [
    'qwen3.5-omni-flash-realtime',
    'qwen3.5-livetranslate-flash-realtime',
  ];
  const feedbackModes = ['process-exclusion', 'virtual-driver', 'echo-cancel'];
  const deviceClasses = ['default-speaker'];
  let runIndex = 0;
  for (const modelId of models) {
    for (const feedbackLoopPrevention of feedbackModes) {
      for (const deviceClass of deviceClasses) {
        const runSuffix = String(runIndex).padStart(2, '0');
        writeReport(root, `20260605-1900${runSuffix}-${feedbackLoopPrevention}-${deviceClass}`, {
          modelId,
          feedbackLoopPrevention,
          layers: feedbackLoopPrevention === 'echo-cancel'
            ? echoCancelLayers()
            : feedbackLoopPrevention === 'process-exclusion'
              ? processExclusionLayers()
              : strictContentLayers(),
          deviceEvidence: deviceEvidence(deviceClass, {
            routeEvidenceSource: feedbackLoopPrevention === 'echo-cancel'
              ? 'desktop-runtime-route+windows-mmdevice'
              : 'physical-output-probe+runtime-route',
          }),
          watchSessionReport: {
            ...healthyWatchSessionReport,
            sessionId: `watch-matrix-${runIndex}`,
          },
        });
        runIndex += 1;
      }
    }
  }

  const result = findScopedStrictEvidence(root, {
    models,
    feedbackModes,
    deviceClasses,
    ...provenanceOk,
  });

  assert.equal(result.ok, true, result.reason);
  assert.equal(result.modelResults.length, 6);
  assert.ok(result.modelResults.every((entry) => entry.ok));
});

test('strict mode rejects evidence older than the age budget', () => {
  const root = makeTempRoot();
  writeStrictReport(root, '20260401-191332', { generatedAt: '2026-04-01T11:13:32.000Z' });

  const result = findScopedStrictEvidence(root, provenanceOk);

  assert.equal(result.ok, false);
  assert.match(result.reason, /evidence is stale/);
  assert.deepEqual(result.failedLayers, ['provenance']);
});

test('strict mode rejects evidence without explicit source provenance', () => {
  const root = makeTempRoot();
  writeStrictReport(root, '20260605-191332', { commit: null, provenance: null });

  const result = findScopedStrictEvidence(root, provenanceOk);

  assert.equal(result.ok, false);
  assert.match(result.reason, /report\.provenance is missing/);
});

test('strict mode rejects an ancestor commit that is not the exact current HEAD', () => {
  const root = makeTempRoot();
  writeStrictReport(root, '20260605-191332', {
    commit: 'fixture-ancestor-commit',
    provenance: {
      ...CLEAN_CURRENT_PROVENANCE,
      headCommit: 'fixture-ancestor-commit',
    },
  });

  const result = findScopedStrictEvidence(root, provenanceOk);

  assert.equal(result.ok, false);
  assert.match(result.reason, /does not exactly match current HEAD.*ancestor commits are not accepted/);
});

test('strict mode rejects the same HEAD when the current worktree is dirty or has untracked source', () => {
  const root = makeTempRoot();
  writeStrictReport(root, '20260605-191332');

  const result = findScopedStrictEvidence(root, {
    now: FIXTURE_NOW,
    currentProvenance: {
      ...CLEAN_CURRENT_PROVENANCE,
      worktreeClean: false,
      dirtyEntryCount: 2,
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /current checkout provenance records a dirty worktree or untracked source state/);
});

test('strict mode rejects a report generated from dirty source even after the checkout becomes clean', () => {
  const root = makeTempRoot();
  writeStrictReport(root, '20260605-191332', {
    provenance: {
      ...CLEAN_CURRENT_PROVENANCE,
      worktreeClean: false,
      dirtyEntryCount: 1,
    },
  });

  const result = findScopedStrictEvidence(root, provenanceOk);

  assert.equal(result.ok, false);
  assert.match(result.reason, /report\.provenance records a dirty worktree or untracked source state/);
});

test('strict mode accepts only a clean report from the exact clean current HEAD', () => {
  const root = makeTempRoot();
  writeStrictReport(root, '20260605-191332');

  const result = findScopedStrictEvidence(root, provenanceOk);

  assert.equal(result.ok, true, result.reason);
});

test('non-strict mode does not apply the provenance gate', () => {
  const root = makeTempRoot();
  writeReport(root, '20260401-191332', { generatedAt: '2026-04-01T11:13:32.000Z', commit: null });

  const result = findWatchModeEvidence({ root, now: FIXTURE_NOW });

  assert.equal(result.ok, true);
});

function strictLayersWithSubtitleQueue(subtitleQueue) {
  return Object.fromEntries(REQUIRED_LAYERS.map((layer) => [
    layer,
    {
      status: 'passed',
      reason: null,
      data: layer === 'strictContent'
        ? { applicable: true, passed: true, coverage: 1 }
        : layer === 'app'
          ? { routeState: 'capturing', subtitleQueue }
          : undefined,
    },
  ]));
}

test('strict mode fails when a produced latency field exceeds the default threshold and reports the measured value', () => {
  const root = makeTempRoot();
  writeReport(root, '20260605-191332', {
    layers: strictLayersWithSubtitleQueue({
      firstVisibleTranslationLatencySeconds: 34,
      firstFinalTranslationLatencySeconds: 7,
    }),
  });

  const result = findScopedStrictEvidence(root, provenanceOk);

  assert.equal(result.ok, false);
  assert.match(result.reason, /latency evidence exceeded threshold/);
  assert.match(result.reason, /firstVisibleTranslationLatencySeconds=34s exceeds the 8s threshold/);
  assert.deepEqual(result.failedLayers, ['latency']);
});

test('strict mode passes when produced latency fields stay within the thresholds', () => {
  const root = makeTempRoot();
  writeReport(root, '20260605-191332', {
    layers: strictLayersWithSubtitleQueue({
      firstVisibleTranslationLatencySeconds: 7,
      firstFinalTranslationLatencySeconds: 7,
      firstTtsQueuedLatencySeconds: 30,
      firstPlaybackLatencySeconds: 40,
    }),
  });

  const result = findScopedStrictEvidence(root, provenanceOk);

  assert.equal(result.ok, true);
});

test('strict latency gate honors configured thresholds, including opting fields in and out', () => {
  const root = makeTempRoot();
  writeReport(root, '20260605-191332', {
    layers: strictLayersWithSubtitleQueue({
      firstVisibleTranslationLatencySeconds: 7,
      firstTtsQueuedLatencySeconds: 5,
    }),
  });

  const tightened = findScopedStrictEvidence(root, {
    latencyThresholds: 'firstVisibleTranslationLatencySeconds=6,firstTtsQueuedLatencySeconds=3',
    ...provenanceOk,
  });
  assert.equal(tightened.ok, false);
  assert.match(tightened.reason, /firstVisibleTranslationLatencySeconds=7s exceeds the 6s threshold/);
  assert.match(tightened.reason, /firstTtsQueuedLatencySeconds=5s exceeds the 3s threshold/);

  const relaxed = findScopedStrictEvidence(root, {
    latencyThresholds: 'firstVisibleTranslationLatencySeconds=off',
    ...provenanceOk,
  });
  assert.equal(relaxed.ok, true);
});

test('strict latency gate skips fields the run did not produce and non-strict mode never applies it', () => {
  const strictRoot = makeTempRoot();
  writeReport(strictRoot, '20260605-191332', {
    layers: strictLayersWithSubtitleQueue({ duplicateFinalTranslations: 0 }),
  });
  const strictResult = findScopedStrictEvidence(strictRoot, provenanceOk);
  assert.equal(strictResult.ok, true);

  const nonStrictRoot = makeTempRoot();
  writeReport(nonStrictRoot, '20260605-191332', {
    layers: Object.fromEntries(REQUIRED_LAYERS.map((layer) => [
      layer,
      {
        status: 'passed',
        reason: null,
        data: layer === 'app'
          ? { subtitleQueue: { firstVisibleTranslationLatencySeconds: 120 } }
          : undefined,
      },
    ])),
  });
  const nonStrictResult = findWatchModeEvidence({ root: nonStrictRoot });
  assert.equal(nonStrictResult.ok, true);
});

test('normalizeLatencyThresholds rejects unknown fields and invalid values', () => {
  assert.deepEqual(normalizeLatencyThresholds(undefined), {
    firstVisibleTranslationLatencySeconds: 8,
    firstFinalTranslationLatencySeconds: 15,
    firstTtsQueuedLatencySeconds: null,
    firstPlaybackLatencySeconds: null,
  });
  assert.throws(() => normalizeLatencyThresholds('bogusField=3'), /unknown latency threshold field/);
  assert.throws(() => normalizeLatencyThresholds('firstVisibleTranslationLatencySeconds=-1'), /invalid latency threshold/);
  assert.throws(() => normalizeLatencyThresholds('firstVisibleTranslationLatencySeconds=abc'), /invalid latency threshold/);
});

test('strictLatencyFailure returns the measured value for each violated field', () => {
  const report = {
    layers: {
      app: {
        data: {
          subtitleQueue: {
            firstVisibleTranslationLatencySeconds: 9.5,
            firstFinalTranslationLatencySeconds: 16,
          },
        },
      },
    },
  };
  const reason = strictLatencyFailure(report);
  assert.match(reason, /firstVisibleTranslationLatencySeconds=9\.5s exceeds the 8s threshold/);
  assert.match(reason, /firstFinalTranslationLatencySeconds=16s exceeds the 15s threshold/);
  assert.equal(strictLatencyFailure({ layers: { app: { data: {} } } }), null);
});

test('strictProvenanceFailure honors a custom age budget', () => {
  const report = {
    generatedAt: '2026-06-01T00:00:00.000Z',
    commit: CLEAN_CURRENT_PROVENANCE.headCommit,
    provenance: CLEAN_CURRENT_PROVENANCE,
  };
  assert.equal(
    strictProvenanceFailure(report, {
      now: FIXTURE_NOW,
      maxAgeDays: 30,
      currentProvenance: CLEAN_CURRENT_PROVENANCE,
    }),
    null,
  );
  assert.match(
    strictProvenanceFailure(report, {
      now: FIXTURE_NOW,
      maxAgeDays: 3,
      currentProvenance: CLEAN_CURRENT_PROVENANCE,
    }) ?? '',
    /stale/,
  );
});
