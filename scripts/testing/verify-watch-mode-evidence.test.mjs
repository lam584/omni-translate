import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { writeMatrixRunManifest } from './run-watch-mode-live-matrix.mjs';
import { writeReport as writeDirectoryReport } from './watch-mode-report.mjs';
import { requiredCellArtifactPaths, sha256File } from './watch-mode-evidence-authority.mjs';
import {
  ECHO_CANCEL_REQUIRED_LAYERS,
  MIN_STRICT_SESSION_DURATION_MS,
  REQUIRED_LAYERS,
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
  verifyStrictMatrixAuthority,
} from './verify-watch-mode-evidence.mjs';

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
  modelId = 'authority-model',
  feedbackLoopPrevention = 'echo-cancel',
  deviceClass = 'default-speaker',
  profileId = 'authority-profile',
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
    'snapshots.json': snapshots,
    'steps.json': [{
      name: 'start desktop shell',
      ok: true,
      result: {
        pid: desktopProcessId,
        systemMetricsSampler: { rootProcessId: desktopProcessId },
      },
      error: null,
    }],
    'driver.json': { error: 'authority fixture driver did not run' },
    'bridge-source-probe.json': { passed: false, error: 'authority fixture bridge probe' },
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
  if (feedbackLoopPrevention !== 'echo-cancel') {
    jsonArtifacts['physical-output-content.json'] = { passed: false, detail: 'authority fixture' };
    jsonArtifacts['physical-output-recording.json'] = { passed: false, capturedFrames: 1 };
    jsonArtifacts['source-media-transcript.json'] = { passed: false, transcript: '' };
  }
  for (const [relativePath, value] of Object.entries(jsonArtifacts)) {
    fs.writeFileSync(path.join(directory, relativePath), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  }
  fs.writeFileSync(path.join(directory, 'app.log'), `${snapshots.runMarker}\n`, 'utf8');
  fs.writeFileSync(path.join(directory, 'bridge-service.log'), 'authority bridge log\n', 'utf8');
  const minimumPcm = Buffer.alloc(60 * 16_000 * 2, 1);
  fs.writeFileSync(path.join(directory, 'source-media-reference-16k-mono.pcm'), minimumPcm);
  fs.writeFileSync(path.join(directory, 'provider-input-16k-mono.pcm'), minimumPcm);
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
    fs.writeFileSync(path.join(directory, 'physical-output-content.json'), `${JSON.stringify({
      passed: true,
      recording: { passed: true },
    })}\n`, 'utf8');
    if (feedbackLoopPrevention === 'virtual-driver') {
      fs.writeFileSync(path.join(directory, 'driver.json'), `${JSON.stringify({
        Endpoint: 'Omni Translate Synthetic Virtual Speaker',
        InstalledDriverAuthority: {
          installedServiceName: 'omni_translate_virtual_speaker',
          installedServiceState: 'Running',
          installedSysPath: 'C:\\Windows\\System32\\DriverStore\\omni-virtual-speaker.sys',
          installedSysSha256: 'driver-package-hash',
          packageSysSha256: 'driver-package-hash',
          packageCatSha256: 'driver-catalog-hash',
          packageInfSha256: 'driver-inf-hash',
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
  writeDirectoryReport({ inputDir: directory, outputDir: directory, mode: 'live' });
  return directory;
}

function writeAuthorityManifest(root, runDirectory, {
  modelId = 'authority-model',
  feedbackLoopPrevention = 'echo-cancel',
  deviceClass = 'default-speaker',
  profileId = 'authority-profile',
  now = new Date(Date.now() + 1_000),
  runtimeBinaryHashes = TEST_RUNTIME_BINARY_HASHES,
} = {}) {
  return writeMatrixRunManifest({
    outputRoot: root,
    modelList: [modelId],
    feedbackModeList: [feedbackLoopPrevention],
    deviceProfiles: [{ profileId, deviceClass }],
    runDirectories: [runDirectory],
    strict: true,
    now,
    provenance: CLEAN_CURRENT_PROVENANCE,
    authorityRuntimeBinaryHashes: runtimeBinaryHashes,
  });
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
    strictDeviceEvidenceFailure({ deviceEvidence: deviceEvidence('usb') }, 'usb'),
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
    /classification mismatch/,
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
  assert.match(result.reason, /requires the schema-v2 authority manifest/);
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
    modelId: 'authority-process-model',
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
    modelId: 'authority-driver-model',
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
    /requires watch-mode-strict-matrix-authority schemaVersion=2/,
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
  const { manifestPath, manifest } = writeAuthorityManifest(root, runDirectory);

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

test('strict process-exclusion evidence requires a real midpoint restart across the 30-minute timeline', () => {
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
  assert.match(strictProcessExclusionRestartFailure(fiveMinuteSimulation), /30-minute real process-tree/i);

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

test('strict device matrix rejects one captured session copied across device cells', () => {
  const root = makeTempRoot();
  for (const [index, deviceClass] of ['default-speaker', 'usb'].entries()) {
    writeReport(root, `20260605-19133${index}-${deviceClass}`, {
      modelId: 'qwen3.5-omni-flash-realtime',
      layers: strictContentLayers(),
      deviceEvidence: deviceEvidence(deviceClass),
      watchSessionReport: {
        ...healthyWatchSessionReport,
        sessionId: 'copied-watch-session',
      },
    });
  }

  const result = findScopedStrictEvidence(root, {
    models: ['qwen3.5-omni-flash-realtime'],
    feedbackModes: ['virtual-driver'],
    deviceClasses: ['default-speaker', 'usb'],
    ...provenanceOk,
  });

  assert.equal(result.ok, false);
  assert.equal(result.modelResults.length, 2);
  assert.ok(result.modelResults.every((entry) => !entry.ok));
  assert.match(result.reason, /duplicate live artifact\/session/);
});

test('strict device matrix accepts the complete two-model by three-route by three-device grid', () => {
  const root = makeTempRoot();
  const models = [
    'qwen3.5-omni-flash-realtime',
    'qwen3.5-livetranslate-flash-realtime',
  ];
  const feedbackModes = ['process-exclusion', 'virtual-driver', 'echo-cancel'];
  const deviceClasses = ['default-speaker', 'usb', 'bluetooth'];
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
  assert.equal(result.modelResults.length, 18);
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
