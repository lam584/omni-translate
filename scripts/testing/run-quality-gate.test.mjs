import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { readJson, writeJson } from '../lib/testing-common.mjs';
import { archiveReleaseManualEvidence } from './archive-release-manual-evidence.mjs';
import { assemblePerformanceBaseline } from './assemble-performance-baseline.mjs';
import {
  RELEASE_MANUAL_PRODUCTION_EMITTERS,
  collectDesktopReleaseManualEvidence,
  collectInstallReleaseManualEvidence,
  collectOverlayReleaseManualEvidence,
  collectRealDeviceAudioReleaseManualEvidence,
  collectVirtualMicReleaseManualEvidence,
  testOnlyCollectReleaseManualEvidence,
  testOnlyValidateCanonicalExecutableAuthority,
  testOnlyValidateReleaseRunnerProcessAuthority,
  validateRawReleaseManualEvidence,
} from './release-manual-collector.mjs';
import { materializeRealDeviceAudioRawFixture } from './real-device-audio-release-evidence-test-helpers.mjs';
import { materializeOverlayClickThroughRawFixture } from './overlay-click-through-release-evidence-test-helpers.mjs';
import { prepareInstallRegressionReport } from './prepare-install-regression-report.mjs';
import { prepareManualE2eReport } from './prepare-manual-e2e-report.mjs';
import { preparePerformanceBaselineReport } from './prepare-performance-baseline.mjs';
import {
  buildCurrentDesktopRelease,
  buildDesktopReleaseEvidencePlan,
  parseDesktopReleaseEvidenceArgs,
  runDesktopReleaseEvidence,
} from './run-desktop-release-evidence.mjs';
import {
  buildCurrentVirtualMicBinaries,
  buildVirtualMicReleasePlan,
  parseVirtualMicReleaseArgs,
  runVirtualMicReleaseEvidence,
} from './run-virtual-mic-release-evidence.mjs';
import {
  hashEvidenceArtifact,
  INSTALL_REGRESSION_SCENARIOS,
  MANUAL_E2E_SCENARIOS,
  PERFORMANCE_BASELINE_SCENARIO,
  PERFORMANCE_LIVE_SOURCE_SCHEMA_VERSION,
  PERFORMANCE_MEASUREMENT_NAMES,
  PERFORMANCE_THRESHOLDS,
  resolvePerformanceStrictAuthority,
} from './release-manual-evidence.mjs';
import {
  CANONICAL_STRICT_MATRIX_MANIFEST,
  DEFAULT_FEEDBACK_MODES,
  DEFAULT_MODELS,
  SUPPORTED_DEVICE_CLASSES,
} from './run-watch-mode-live-matrix.mjs';
import { buildSteps } from './run-all-tests.mjs';
import { buildAutoSteps } from './run-quality-gate-auto.mjs';
import {
  buildQualityGateSummary,
  testMarkdownManualReport,
  testPerformanceReport,
} from './run-quality-gate.mjs';

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'quality-gate-test-'));
const TEST_NOW = new Date('2026-08-10T10:00:00.000Z');
const TEST_PROVENANCE = Object.freeze({
  schemaVersion: 1,
  source: 'git',
  captureStatus: 'captured',
  headCommit: 'a'.repeat(40),
  worktreeClean: true,
  dirtyEntryCount: 0,
});
const realDeviceAuthorityResolvers = new Map();

const validationOptions = (workspaceRoot, currentProvenance = TEST_PROVENANCE) => ({
  workspaceRoot,
  currentProvenance,
  now: TEST_NOW.getTime(),
  testOnlyAllowSyntheticAuthority: true,
  testOnlyRealDeviceAuthorityResolver: realDeviceAuthorityResolvers.get(path.resolve(workspaceRoot)),
  performanceAuthorityResolver: testPerformanceAuthorityResolver,
});

const runGit = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });

const makeCleanGitWorkspace = () => {
  const workspaceRoot = makeTempDir();
  fs.cpSync(path.resolve('scripts'), path.join(workspaceRoot, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, '.gitignore'), 'target/\n', 'utf8');
  fs.writeFileSync(path.join(workspaceRoot, 'tracked.txt'), 'release evidence CLI fixture\n', 'utf8');
  for (const args of [
    ['init'],
    ['config', 'user.email', 'quality-gate@example.invalid'],
    ['config', 'user.name', 'Quality Gate'],
    ['add', '.'],
    ['commit', '-m', 'fixture'],
  ]) {
    const result = runGit(workspaceRoot, args);
    assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return workspaceRoot;
};

const runProductionCli = (script, args, cliRoot = path.resolve('.')) => spawnSync(
  process.execPath,
  [path.resolve(cliRoot, script), ...args],
  { cwd: cliRoot, encoding: 'utf8' },
);

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

const writePcm16Wav = (filePath, { frameCount = 4800, channelCount = 1 } = {}) => {
  const pcm = Buffer.alloc(frameCount * channelCount * 2);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const sample = Math.round(Math.sin((2 * Math.PI * 997 * frame) / 48000) * 16000);
    for (let channel = 0; channel < channelCount; channel += 1) {
      pcm.writeInt16LE(sample, ((frame * channelCount) + channel) * 2);
    }
  }
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + pcm.length, 4);
  wav.write('WAVEfmt ', 8, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channelCount, 22);
  wav.writeUInt32LE(48000, 24);
  wav.writeUInt32LE(48000 * channelCount * 2, 28);
  wav.writeUInt16LE(channelCount * 2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);
  fs.writeFileSync(filePath, wav);
  return { wav, pcm, frameCount };
};

const writeRealVmShapedVirtualMicWav = (filePath) => {
  const expectedPcm = Buffer.alloc(24_000 * 2);
  let seed = 0x4d595df4;
  for (let frame = 0; frame < 24_000; frame += 1) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    const watermark = 0.88 + ((seed >>> 0) & 0xffff) / 0xffff * 0.12;
    const sample = Math.round(
      Math.sin((2 * Math.PI * 997 * frame) / 48_000) * 0.24 * watermark * 32_767,
    );
    expectedPcm.writeInt16LE(sample, frame * 2);
  }
  const frameCount = 153_600;
  const fingerprintStartFrame = 5_184;
  const capturedPcm = Buffer.alloc(frameCount * 2);
  for (let frame = 0; frame < 24_000; frame += 1) {
    const expected = expectedPcm.readInt16LE(frame * 2);
    const delta = frame % 4 === 0 ? 1 : frame % 4 === 1 ? -1 : 0;
    capturedPcm.writeInt16LE(expected + delta, (fingerprintStartFrame + frame) * 2);
  }
  const wav = Buffer.alloc(44 + capturedPcm.length);
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
  wav.writeUInt32LE(capturedPcm.length, 40);
  capturedPcm.copy(wav, 44);
  fs.writeFileSync(filePath, wav);
  return { wav, expectedPcm, frameCount, fingerprintStartFrame };
};

const cueTimeline = (cueId, sessionId, { vmic = false } = {}) => [
  ['queued', 1],
  ['started', 2],
  ['completed', 3],
].map(([status, index]) => vmic ? {
  type: 'bridge.translation.status',
  statusId: `status-${index}`,
  requestId: `request-${index}`,
  sessionId,
  cueId,
  playbackStatus: status,
  reason: `fixture-${status}`,
  errorCode: null,
  timestampMs: TEST_NOW.getTime() + index,
  collectorReceivedAtMonotonicNs: index * 1000,
} : {
  status,
  observedAt: new Date(TEST_NOW.getTime() + index).toISOString(),
});

const writeVirtualMicCaptureEvidence = (
  rawDirectory,
  {
    workspaceRoot = path.dirname(rawDirectory),
    provenance = TEST_PROVENANCE,
    implementationRoot = path.resolve('.'),
    now = TEST_NOW,
    includeEmitter = true,
  } = {},
) => {
  const {
    wav,
    expectedPcm,
    frameCount,
    fingerprintStartFrame,
  } = writeRealVmShapedVirtualMicWav(
    path.join(rawDirectory, 'virtual-mic-capture.wav'),
  );
  const virtualMicFramesWritten = 33_600;
  const endpointId = '{0.0.1.00000000}.omni-virtual-mic';
  const endpointName = 'Omni Translate Virtual Microphone';
  const cueId = 'virtual-mic-release-cue-1';
  const sessionId = 'virtual-mic-release-session-1';
  const lifecycle = {
    cueId,
    queuedCount: 1,
    startedCount: 1,
    completedCount: 1,
    staleDroppedCount: 0,
    routeFailedCount: 0,
    terminalEventCount: 1,
    terminalStatus: 'completed',
  };
  const fingerprint = {
    id: 'release-fingerprint-0001',
    detected: true,
    frequencyHz: 997,
    startFrame: fingerprintStartFrame,
    frameCount: 24_000,
    expectedPcmHex: expectedPcm.toString('hex'),
    expectedPcmSha256: sha256(expectedPcm),
  };
  const authority = {
    collectorId: 'omni-virtual-mic-target-capture',
    collectorVersion: '0.1.0',
    parentCollectorProcessId: 4101,
    captureChildProcessId: 4102,
    bridgeProtocolVersion: '2026-08-10-audio-routing-v6',
    bridgeProcessId: 4103,
    bridgeInstanceId: 'bridge-instance-release-1',
    bridgeSessionId: sessionId,
    captureEndpointId: endpointId,
    captureEndpointName: endpointName,
    rawCountersBefore: { virtualMicFramesWritten: 100, playbackFramesWritten: 9 },
    rawCountersAfter: { virtualMicFramesWritten: 100 + virtualMicFramesWritten, playbackFramesWritten: 9 },
    recomputedCounterDelta: { virtualMicFramesWritten, playbackFramesWritten: 0 },
    cueId,
    cueStatusTimeline: cueTimeline(cueId, sessionId, { vmic: true }),
    cueLifecycle: lifecycle,
  };
  const commonCapture = {
    captureWav: 'virtual-mic-capture.wav',
    captureWavSha256: sha256(wav),
    capturedFrames: frameCount,
    fingerprint,
  };
  writeJson(path.join(rawDirectory, 'virtual-mic-capture-probe.json'), {
    schemaVersion: 1,
    artifactKind: 'virtual-mic-real-capture-probe',
    capturedAt: now.toISOString(),
    ...authority,
    targetCaptureApplication: {
      classification: 'real-target',
      name: 'Omni Translate Virtual Microphone Target Capture',
      processId: authority.captureChildProcessId,
      captureApi: 'WASAPI',
      openedEndpoint: true,
      endpointId,
      endpointName,
    },
    format: { sampleRateHz: 48000, channelCount: 1, bitsPerSample: 16, encoding: 'pcm16' },
    ...commonCapture,
  });
  writeJson(path.join(rawDirectory, 'runtime-snapshot.json'), {
    schemaVersion: 1,
    artifactKind: 'virtual-mic-runtime-snapshot',
    capturedAt: now.toISOString(),
    ...authority,
    virtualMicOutputSupported: true,
    virtualMicOutputStatus: 'ready',
    virtualMicFormat: '48000Hz/mono/pcm16',
    virtualMicFramesWritten: 100 + virtualMicFramesWritten,
    virtualMicFramesWrittenBefore: 100,
    virtualMicFramesWrittenAfter: 100 + virtualMicFramesWritten,
    virtualMicFramesWrittenForCue: virtualMicFramesWritten,
    physicalPlaybackFramesWrittenBefore: 9,
    physicalPlaybackFramesWrittenAfter: 9,
    physicalPlaybackFramesWrittenForCue: 0,
    ...commonCapture,
  });
  if (!includeEmitter) return;
  const releaseDirectory = path.join(workspaceRoot, 'target', 'release');
  fs.mkdirSync(releaseDirectory, { recursive: true });
  const collectorExecutable = path.join(releaseDirectory, 'omni-virtual-mic-target-capture.exe');
  const bridgeExecutable = path.join(releaseDirectory, 'omni-bridge-service.exe');
  fs.writeFileSync(collectorExecutable, 'current-head virtual mic collector fixture\n', 'utf8');
  fs.writeFileSync(bridgeExecutable, 'current-head bridge fixture\n', 'utf8');
  const invocationId = '22222222-2222-7222-8222-222222222222';
  const rawArtifacts = [
    'virtual-mic-capture.wav',
    'virtual-mic-capture-probe.json',
    'runtime-snapshot.json',
  ].map((relativePath) => ({
    path: relativePath,
    sha256: sha256(fs.readFileSync(path.join(rawDirectory, relativePath))),
    fileCount: 1,
    byteCount: fs.statSync(path.join(rawDirectory, relativePath)).size,
  }));
  const runnerPath = path.join(
    implementationRoot,
    'scripts',
    'testing',
    'run-virtual-mic-release-evidence.mjs',
  );
  writeJson(path.join(rawDirectory, 'emitter-result.json'), {
    schemaVersion: 1,
    artifactKind: 'virtual-mic-release-evidence-emitter-result',
    collectorId: 'omni-virtual-mic-release-evidence',
    collectorVersion: '0.1.0',
    scenarioId: 'E2E-VIRTUAL-MIC-CAPTURE',
    invocationId,
    status: 'completed',
    startedAt: new Date(now.getTime() - 1000).toISOString(),
    completedAt: now.toISOString(),
    sourceHeadCommit: provenance.headCommit,
    provenance,
    runner: {
      path: 'scripts/testing/run-virtual-mic-release-evidence.mjs',
      sha256: sha256(fs.readFileSync(runnerPath)),
    },
    binaries: {
      collector: {
        path: collectorExecutable,
        sha256: sha256(fs.readFileSync(collectorExecutable)),
        buildCommit: provenance.headCommit,
        processId: authority.parentCollectorProcessId,
      },
      bridge: {
        path: bridgeExecutable,
        sha256: sha256(fs.readFileSync(bridgeExecutable)),
        buildCommit: provenance.headCommit,
        processId: authority.bridgeProcessId,
      },
    },
    collectorInvocation: {
      exitCode: 0,
      passed: true,
      cueId,
      captureEndpointId: endpointId,
      stdoutSha256: 'e'.repeat(64),
    },
    rawAuthority: {
      captureChildProcessId: authority.captureChildProcessId,
      bridgeInstanceId: authority.bridgeInstanceId,
      bridgeSessionId: authority.bridgeSessionId,
      captureEndpointId: endpointId,
      captureEndpointName: endpointName,
      cueId,
    },
    rawArtifacts,
    timeline: [
      'build-started',
      'build-completed',
      'binaries-verified',
      'collector-started',
      'collector-completed',
      'raw-evidence-verified',
      'invocation-completed',
    ].map((event, index) => ({
      event,
      invocationId,
      observedAt: new Date(now.getTime() - 900 + (index * 10)).toISOString(),
      sequence: index + 1,
      detail: null,
    })),
    error: null,
  });
};

const writeDiagnosticsBundle = (
  rawDirectory,
  {
    invocationId = 'fixture-invocation',
    processId = 5101,
    sourceHeadCommit = TEST_PROVENANCE.headCommit,
    provider = {
      templateId: 'template-dashscope',
      providerId: 'dashscope',
      kind: 'dashscope',
      model: 'qwen3.5-plus',
      baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
      transport: 'websocket',
      authRef: {
        kind: 'credential-ref',
        reference: 'credential://provider/dashscope/default',
        headerName: 'Authorization',
        scheme: 'bearer',
      },
    },
  } = {},
) => {
  const bundle = path.join(rawDirectory, 'diagnostics-bundle');
  const generatedAt = TEST_NOW.toISOString();
  const diagnostics = {
    status: 'ready',
    supportTier: 'stable',
    installStatus: 'ready',
    providerStatus: 'ready',
    driverStatus: 'ready',
    deviceStatus: 'ready',
    lastSelfCheckAt: generatedAt,
    lastExportScope: 'full',
    lastExportPath: 'C:\\Diagnostics\\fixture-full',
    lastExportedAt: generatedAt,
    categories: [],
    supportMatrix: [],
    modelTraceSummary: {
      activeTraceId: null,
      totalCalls: 0,
      succeededCalls: 0,
      failedCalls: 0,
      lastError: null,
      lastCallAt: null,
      recentCalls: [],
    },
    recentLogs: [],
    recentErrors: [],
    logDroppedCount: 0,
    logWriteErrorCount: 0,
  };
  const bridge = {
    bridgeProcessId: 5201,
    bridgeInstanceId: 'bridge-instance-release-evidence',
    status: 'ready',
    processStatus: 'running',
    installChannel: 'release',
    installPhase: 'ready',
    bridgeState: 'running',
    lifecycleState: 'ready',
    driverHealth: 'running',
    targetDeviceId: 'virtual-mic-default',
    expectedDriverVersion: '0.10.0',
    expectedBridgeVersion: '0.1.0',
    driverVersion: '0.10.0',
    bridgeVersion: '0.1.0',
    sourceCaptureMode: 'process-exclusion',
    captureBackend: 'wasapi-process-exclusion',
    excludedProcessId: 5201,
    sessionId: 'bridge-session-release-evidence',
    endpointName: 'Omni Translate Virtual Speaker',
    captureEndpointName: 'Omni Translate Virtual Microphone',
    captureRestartCount: 0,
    underrunCount: 0,
    droppedFrameCount: 0,
    lastErrorCode: null,
    recommendedAction: null,
    driverProbeState: 'ready',
    testSigningEnabled: true,
    memoryIntegrityEnabled: false,
    secureBootEnabled: false,
    ioctlAvailable: true,
  };
  const storage = {
    status: 'ready',
    schemaVersion: 4,
    databasePath: 'C:\\OmniTranslate\\omni.sqlite3',
    credentialBackend: 'windows-credential-manager',
    hasPersistedConfig: true,
    snapshotCount: 1,
    lastSavedAt: generatedAt,
    lastExportPath: null,
    lastImportPath: null,
  };
  const runtime = {
    coreState: 'ready',
    bridgeStatus: 'tauri-shell',
    activeProfileId: provider.templateId,
    trayReady: true,
    lastSyncAt: generatedAt,
    sessionId: 'release-evidence-session',
    bridge,
    diagnostics,
    storage,
    windows: [{ label: 'main', title: 'Omni Translate', kind: 'main', visible: true, focused: true }],
    notifications: [],
  };
  const idleRoute = {
    captureState: 'idle',
    preBufferState: 'idle',
    vadState: 'idle',
    bufferAheadMs: 0,
    framesCaptured: 0,
    segmentCount: 0,
    streamBound: false,
    lastEnergyDb: null,
    lastFrameAt: null,
    lastErrorCode: null,
    recommendedAction: null,
  };
  const audio = {
    snapshotSeq: 1,
    status: 'ready',
    host: 'wasapi',
    renderDevices: [],
    captureDevices: [],
    inbound: idleRoute,
    outbound: idleRoute,
    subtitleOverlay: {
      queueDepth: 0,
      droppedCueCount: 0,
      firstTranslationAverageMs: null,
      firstTranslationLastMs: null,
      firstTranslationSampleCount: 0,
    },
    speech: {
      status: 'ready',
      dispatchState: 'idle',
      queueDepth: 0,
      policy: 'subtitle-first',
      outputTarget: 'physical-speaker',
      lastError: null,
      speakerFramesWritten: 0,
      virtualMicFramesWritten: 0,
    },
    echoCaptureDiagnostics: {
      processedChunks: 0,
      playbackActiveChunks: 0,
      forwardedToAsrChunks: 0,
      droppedChunks: 0,
    },
    aecBackend: 'webrtc-aec3',
    aecStatus: 'ready',
    aecFailureDetail: null,
    sessionStartedAt: null,
    sttConnected: false,
    sttBufferSize: 0,
    sttConnection: { state: 'idle' },
  };
  const diagnosticsSummary = {
    schemaVersion: 2,
    generatedAt,
    scope: 'full',
    diagnostics: {
      status: 'ready', supportTier: 'stable', installStatus: 'ready', providerStatus: 'ready',
      driverStatus: 'ready', deviceStatus: 'ready', lastSelfCheckAt: generatedAt,
      logDroppedCount: 0, logWriteErrorCount: 0, recentErrorCount: 0,
    },
    runtime: {
      available: true, coreState: 'ready', bridgeStatus: 'tauri-shell',
      activeProfileId: provider.templateId, trayReady: true, lastSyncAt: generatedAt,
      sessionId: 'release-evidence-session', windowCount: 1, notificationCount: 0,
    },
    audio: {
      status: 'ready', host: 'wasapi', renderDeviceCount: 0, captureDeviceCount: 0,
      sessionStartedAt: null, sttConnected: false, sttBufferSize: 0,
      sttConnection: { state: 'idle' }, inbound: idleRoute, outbound: idleRoute,
      subtitle: {
        queueDepth: 0, droppedCueCount: 0, firstTranslationAverageMs: null,
        firstTranslationLastMs: null, firstTranslationSampleCount: 0,
      },
      echoCaptureDiagnostics: {
        processedChunks: 0, playbackActiveChunks: 0, forwardedToAsrChunks: 0, droppedChunks: 0,
      },
      speech: {
        status: 'ready', dispatchState: 'idle', queueDepth: 0, policy: 'subtitle-first',
        outputTarget: 'physical-speaker', lastError: null, speakerFramesWritten: 0,
        virtualMicFramesWritten: 0,
      },
    },
    bridge: {
      status: 'ready', processStatus: 'running', bridgeState: 'running', lifecycleState: 'ready',
      installChannel: 'release', installPhase: 'ready', driverHealth: 'running',
      driverVersion: '0.10.0', bridgeVersion: '0.1.0', captureBackend: 'wasapi-process-exclusion',
      captureRestartCount: 0, underrunCount: 0, droppedFrameCount: 0, lastErrorCode: null,
      recommendedAction: null, driverProbeState: 'ready', testSigningEnabled: true,
      memoryIntegrityEnabled: false, secureBootEnabled: false, ioctlAvailable: true,
    },
    storage: {
      status: 'ready', schemaVersion: 4, credentialBackend: 'windows-credential-manager',
      hasPersistedConfig: true, snapshotCount: 1, lastSavedAt: generatedAt,
    },
  };
  const logContent = `release_evidence.authority_event invocationId=${invocationId}\n`;
  const logBytes = Buffer.byteLength(logContent);
  const logSummary = {
    schemaVersion: 2,
    scope: 'full',
    perFileTailBytes: null,
    redactionPolicy: 'credential-patterns-v2',
    files: [{
      source: 'desktop',
      name: 'app.log',
      outputPath: 'logs/desktop/app.log',
      originalBytes: logBytes,
      exportedBytes: logBytes,
      originalLineCount: 1,
      exportedLineCount: 1,
      redactionCount: 0,
      truncated: false,
      levelStats: {},
      categoryStats: {},
    }],
    totals: {
      fileCount: 1,
      truncatedFileCount: 0,
      redactionCount: 0,
      originalBytes: logBytes,
      exportedBytes: logBytes,
      originalLineCount: 1,
      exportedLineCount: 1,
      levelStats: {},
      categoryStats: {},
    },
  };
  const payload = new Map([
    ['diagnostics-summary.json', JSON.stringify(diagnosticsSummary, null, 2) + '\n'],
    ['environment.json', JSON.stringify({
      schemaVersion: 2,
      generatedAt,
      scope: 'full',
      platform: 'windows',
      family: 'windows',
      arch: 'x86_64',
      appVersion: '0.1.0',
      executableName: 'omni-desktop-shell.exe',
      processId,
      buildProfile: 'release',
      debugAssertions: false,
      buildCommit: sourceHeadCommit,
      redactionPolicy: 'credential-patterns-v2',
    }, null, 2) + '\n'],
    ['log-summary.json', JSON.stringify(logSummary, null, 2) + '\n'],
    ['diagnostics-report.txt', `Omni Translate Diagnostics Report\n=================================\nGenerated: ${generatedAt}\nScope: full\nCore status\nLogs\nWarnings\n`],
    ['snapshots/diagnostics.json', JSON.stringify(diagnostics, null, 2) + '\n'],
    ['snapshots/runtime.json', JSON.stringify(runtime, null, 2) + '\n'],
    ['snapshots/audio.json', JSON.stringify(audio, null, 2) + '\n'],
    ['snapshots/bridge.json', JSON.stringify(bridge, null, 2) + '\n'],
    ['snapshots/storage.json', JSON.stringify(storage, null, 2) + '\n'],
    ['snapshots/config.json', JSON.stringify({
      activeProviderTemplateId: provider.templateId,
      providers: [provider],
    }, null, 2) + '\n'],
    ['logs/desktop/app.log', logContent],
  ]);
  for (const [relative, content] of payload) {
    const candidate = path.join(bundle, relative);
    fs.mkdirSync(path.dirname(candidate), { recursive: true });
    fs.writeFileSync(candidate, content, 'utf8');
  }
  const payloadFiles = [...payload].map(([relative, content]) => ({
    path: relative,
    kind: relative === 'diagnostics-summary.json'
      ? 'core-summary'
      : relative === 'environment.json'
        ? 'environment'
        : relative === 'log-summary.json'
          ? 'log-summary'
          : relative === 'diagnostics-report.txt'
            ? 'human-readable-report'
            : relative.startsWith('logs/')
              ? 'redacted-log'
              : 'snapshot',
    bytes: Buffer.byteLength(content),
  }));
  const payloadBytes = payloadFiles.reduce((total, file) => total + file.bytes, 0);
  let manifestBytes = 0;
  let text = '';
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const manifest = {
      schemaVersion: 2,
      scope: 'full',
      generatedAt,
      redactionPolicy: 'credential-patterns-v2',
      payloadFiles,
      warnings: [],
      totals: {
        fileCount: payloadFiles.length + 1,
        payloadFileCount: payloadFiles.length,
        payloadBytes,
        manifestBytes,
        bundleBytes: payloadBytes + manifestBytes,
        redactionCount: 0,
        logFileCount: 1,
        truncatedLogFileCount: 0,
        originalLogBytes: logBytes,
        exportedLogBytes: logBytes,
        originalLogLines: 1,
        exportedLogLines: 1,
      },
    };
    text = `${JSON.stringify(manifest, null, 2)}\n`;
    if (Buffer.byteLength(text) === manifestBytes) break;
    manifestBytes = Buffer.byteLength(text);
  }
  fs.writeFileSync(path.join(bundle, 'bundle-manifest.json'), text, 'utf8');
};

const DESKTOP_FIXTURE_TIMELINES = {
  'E2E-PROVIDER-CONFIG': [
    'invocation-started', 'configuration-loaded', 'configuration-saved-and-reloaded',
    'credential-status-read', 'diagnostics-export-requested',
    'diagnostics-export-packaged', 'invocation-completed',
  ],
  'E2E-PROVIDER-PROBE': [
    'invocation-started', 'provider-loaded-and-credential-checked',
    'provider-probe-completed', 'diagnostics-export-requested',
    'diagnostics-export-packaged', 'invocation-completed',
  ],
  'E2E-DIAGNOSTICS-EXPORT': [
    'invocation-started', 'diagnostics-export-requested',
    'diagnostics-export-packaged', 'invocation-completed',
  ],
};

const DESKTOP_FIXTURE_COLLECTORS = {
  'E2E-PROVIDER-CONFIG': 'omni-desktop-provider-config-release-evidence',
  'E2E-PROVIDER-PROBE': 'omni-desktop-provider-probe-release-evidence',
  'E2E-DIAGNOSTICS-EXPORT': 'omni-desktop-diagnostics-export-release-evidence',
};

const writeDesktopEmitterFixture = (
  rawDirectory,
  scenarioId,
  payloadFile,
  payload,
  {
    processId = 5101,
    desktopExecutable = 'C:\\Program Files\\Omni Translate\\omni-desktop-shell.exe',
    desktopExecutableSha256 = 'd'.repeat(64),
    sourceHeadCommit = TEST_PROVENANCE.headCommit,
  } = {},
) => {
  const invocationId = '11111111-1111-7111-8111-111111111111';
  const collectorId = DESKTOP_FIXTURE_COLLECTORS[scenarioId];
  const provider = scenarioId === 'E2E-PROVIDER-CONFIG'
    ? {
        templateId: payload.provider.templateId,
        providerId: payload.provider.providerId,
        kind: payload.provider.kind,
        model: payload.provider.model,
        baseUrl: payload.provider.baseUrl,
        transport: payload.provider.transport,
        authRef: payload.provider.authRef,
      }
    : scenarioId === 'E2E-PROVIDER-PROBE'
      ? {
          templateId: payload.rawProbeResult.templateId,
          providerId: payload.providerId,
          kind: 'dashscope',
          model: payload.model,
          baseUrl: `https://${payload.endpointHost}/api/v1`,
          transport: payload.rawProbeResult.transportRequested,
          authRef: {
            kind: 'credential-ref',
            reference: payload.credentialStatus.reference,
            headerName: 'Authorization',
            scheme: 'bearer',
          },
        }
      : undefined;
  writeDiagnosticsBundle(rawDirectory, { invocationId, processId, sourceHeadCommit, provider });
  const bundleRoot = path.join(rawDirectory, 'diagnostics-bundle');
  const bundleHash = hashEvidenceArtifact(bundleRoot);
  const diagnosticsExport = {
    scope: 'full',
    canonicalOutputPath: 'C:\\Users\\qa\\AppData\\Local\\OmniTranslate\\diagnostics\\exports\\fixture-full',
    generatedAt: TEST_NOW.toISOString(),
    fileCount: bundleHash.fileCount,
    canonicalBundleSha256: bundleHash.sha256,
    packagedBundleSha256: bundleHash.sha256,
    bundleManifestSha256: sha256(fs.readFileSync(path.join(bundleRoot, 'bundle-manifest.json'))),
  };
  writeJson(path.join(rawDirectory, payloadFile), {
    ...payload,
    collectorId,
    collectorVersion: '0.1.0',
    invocationId,
    desktopProcessId: processId,
    sourceHeadCommit,
    diagnosticsExport,
  });
  const payloadPaths = [payloadFile, 'diagnostics-bundle'];
  writeJson(path.join(rawDirectory, 'emitter-result.json'), {
    schemaVersion: 1,
    artifactKind: 'desktop-release-evidence-emitter-result',
    collectorId,
    collectorVersion: '0.1.0',
    scenarioId,
    invocationId,
    status: 'completed',
    startedAt: new Date(TEST_NOW.getTime() - 1000).toISOString(),
    completedAt: TEST_NOW.toISOString(),
    desktopProcessId: processId,
    desktopExecutable,
    desktopExecutableSha256,
    sourceHeadCommit,
    diagnosticsExport,
    timeline: DESKTOP_FIXTURE_TIMELINES[scenarioId].map((event, index) => ({
      event,
      invocationId,
      observedAt: new Date(TEST_NOW.getTime() - 900 + (index * 10)).toISOString(),
      sequence: index + 1,
      detail: null,
    })),
    artifacts: payloadPaths.map((relativePath) => ({
      path: relativePath,
      ...hashEvidenceArtifact(path.join(rawDirectory, relativePath)),
    })),
    error: null,
  });
};

const readyDriverProbe = () => ({
  schemaVersion: 1,
  driverHealth: 'running',
  errorCode: null,
  rootDeviceCount: 1,
  rootInstanceIds: ['ROOT\\MEDIA\\0000'],
  endpointName: 'Omni Translate Virtual Speaker',
  captureEndpointName: 'Omni Translate Virtual Microphone',
  virtualMicOutputSupported: true,
  virtualMicOutputStatus: 'ready',
  virtualMicFormat: '48000Hz/mono/pcm16',
  abiVersion: '0X20260810',
  ioctlAvailable: true,
  packageSigningMode: 'release-injected',
  installedDriverVersion: '1.2.3',
});

const installOperation = (artifactKind) => ({
  schemaVersion: 1,
  artifactKind,
  collectorId: 'omni-release-install-collector',
  completedAt: TEST_NOW.toISOString(),
  command: `official-${artifactKind}`,
  elevated: true,
  exitCode: 0,
  packageVersion: '1.2.3',
  packageSha256: '1'.repeat(64),
  signer: { status: 'valid', signingMode: 'release-injected' },
});

const writeReleaseLayout = (rawDirectory) => {
  const layoutRoot = path.join(rawDirectory, 'installer-layout');
  const requiredFiles = [
    'bridge-service-native/omni-bridge-service.exe',
    'bridge-service-native/omni-driver-audio-probe.exe',
    'bridge-service-native/omni-virtual-mic-target-capture.exe',
    'desktop/omni-desktop-shell.exe',
    'drivers/windows-virtual-mic/package/omni-virtual-speaker.inf',
    'drivers/windows-virtual-mic/package/omni-virtual-speaker.sys',
    'drivers/windows-virtual-mic/package/omni-virtual-speaker.cat',
  ];
  for (const relative of requiredFiles) {
    const candidate = path.join(layoutRoot, relative);
    fs.mkdirSync(path.dirname(candidate), { recursive: true });
    fs.writeFileSync(candidate, `fixture ${relative}\n`, 'utf8');
  }
  writeJson(path.join(layoutRoot, 'drivers/windows-virtual-mic/package/driver-package.json'), {
    configuration: 'Release',
    signingMode: 'release-injected',
  });
  writeJson(path.join(layoutRoot, 'installer-layout.json'), {
    version: '1.2.3',
    generatedAt: TEST_NOW.toISOString(),
    naming: { channel: 'stable', platform: 'windows-x64' },
  });
  writeJson(path.join(rawDirectory, 'release-manifest.json'), {
    generatedAt: TEST_NOW.toISOString(),
    version: '1.2.3',
    releaseChannel: 'stable',
    packages: { root: { version: '1.2.3' } },
    installer: {
      nativeBridgeExecutable: 'bridge-service-native/omni-bridge-service.exe',
      audioProbeExecutable: 'bridge-service-native/omni-driver-audio-probe.exe',
      virtualMicTargetCaptureExecutable: 'bridge-service-native/omni-virtual-mic-target-capture.exe',
    },
  });
};

const writeScenarioRawEvidence = (rawDirectory, scenarioId, fixtureOptions = {}) => {
  switch (scenarioId) {
    case 'E2E-PROVIDER-CONFIG':
      writeDesktopEmitterFixture(rawDirectory, scenarioId, 'provider-config-snapshot.json', {
        schemaVersion: 1,
        artifactKind: 'provider-config-production-snapshot',
        source: 'desktop-api-v2',
        productionMode: true,
        capturedAt: TEST_NOW.toISOString(),
        desktopProcessId: 5101,
        provider: {
          templateId: 'template-dashscope',
          providerId: 'dashscope',
          kind: 'dashscope',
          model: 'qwen3.5-plus',
          baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
          transport: 'websocket',
          configPersisted: true,
          authRef: {
            kind: 'credential-ref',
            reference: 'credential://provider/dashscope/default',
            headerName: 'Authorization',
            scheme: 'bearer',
          },
          secretValuePresent: false,
        },
        credentialStatus: {
          backend: 'windows-credential-manager',
          exists: true,
          reference: 'credential://provider/dashscope/default',
          checkedAt: TEST_NOW.toISOString(),
        },
      }, fixtureOptions);
      break;
    case 'E2E-PROVIDER-PROBE':
      writeDesktopEmitterFixture(rawDirectory, scenarioId, 'provider-probe-result.json', {
        schemaVersion: 1,
        artifactKind: 'provider-production-probe-result',
        source: 'desktop-api-v2',
        productionMode: true,
        checkedAt: TEST_NOW.toISOString(),
        desktopProcessId: 5101,
        templateId: 'template-dashscope',
        providerId: 'dashscope',
        model: 'qwen3.5-plus',
        transportRequested: 'websocket',
        effectiveTransport: 'websocket',
        endpointHost: 'dashscope.aliyuncs.com',
        verdict: 'available',
        latencyMs: 420,
        latencyBudgetMs: 1200,
        streamObserved: true,
        responseShapeStable: true,
        errorShapeStable: true,
        credentialStatus: {
          backend: 'windows-credential-manager',
          exists: true,
          reference: 'credential://provider/dashscope/default',
        },
        rawProbeResult: {
          id: 'probe-fixture',
          templateId: 'template-dashscope',
          providerId: 'dashscope',
          verdict: 'available',
          checkedAt: TEST_NOW.toISOString(),
          measuredLatencyMs: 420,
          latencyBudgetMs: 1200,
          streamSupported: true,
          responseShapeStable: true,
          errorShapeStable: true,
          transportRequested: 'websocket',
          transportEffective: 'websocket',
          fallbackApplied: false,
          checks: [
            { id: 'dashscope-streaming', key: 'streaming', label: '流式能力', status: 'pass', summary: '已观察到增量事件，实际传输模式为 websocket。' },
            { id: 'dashscope-latency', key: 'latency', label: '实时适用性', status: 'pass', summary: '首个有效事件耗时 420 ms，预算 1200 ms。' },
            { id: 'dashscope-error-shape', key: 'error-shape', label: '错误结构', status: 'pass', summary: '本次请求未触发上游错误，当前归一化链路可用。' },
            { id: 'dashscope-response-shape', key: 'response-shape', label: '响应格式稳定性', status: 'pass', summary: '已完整得到 translation.completed 与 response.completed。' },
          ],
          guidance: [
            '当前延迟 420 ms，允许字幕与译音并行。',
            '可直接用于真实 Provider 连通性测试与后续字幕/译音主链路。',
          ],
          routingDecision: {
            subtitlePriority: 'balanced',
            speechDisposition: 'ready',
            rationale: '当前延迟 420 ms，允许字幕与译音并行。',
          },
          error: null,
        },
      }, fixtureOptions);
      break;
    case 'E2E-REAL-DEVICE-AUDIO': {
      return materializeRealDeviceAudioRawFixture({
        rawDirectory,
        workspaceRoot: fixtureOptions.workspaceRoot,
        provenance: fixtureOptions.provenance ?? TEST_PROVENANCE,
        now: fixtureOptions.now ?? TEST_NOW,
      });
    }
    case 'E2E-OVERLAY-CLICK-THROUGH': {
      materializeOverlayClickThroughRawFixture({
        rawDirectory,
        workspaceRoot: fixtureOptions.workspaceRoot,
        provenance: fixtureOptions.provenance ?? TEST_PROVENANCE,
        now: fixtureOptions.now ?? TEST_NOW,
      });
      break;
    }
    case 'E2E-DIAGNOSTICS-EXPORT':
      writeDesktopEmitterFixture(rawDirectory, scenarioId, 'diagnostics-export-receipt.json', {
        schemaVersion: 1,
        artifactKind: 'diagnostics-full-export-production-receipt',
        capturedAt: TEST_NOW.toISOString(),
        productionHandler: 'diagnostics_events::export_diagnostics_bundle',
      }, fixtureOptions);
      break;
    case 'E2E-VIRTUAL-MIC-CAPTURE':
      writeVirtualMicCaptureEvidence(rawDirectory, {
        workspaceRoot: fixtureOptions.workspaceRoot,
        provenance: fixtureOptions.provenance ?? TEST_PROVENANCE,
      });
      break;
    case 'INSTALL-FRESH':
      writeJson(path.join(rawDirectory, 'fresh-install-evidence.json'), installOperation('install-fresh-operation'));
      writeJson(path.join(rawDirectory, 'driver-install-state.json'), {
        protocolVersion: '2026-08-10-audio-routing-v6',
        installChannel: 'stable',
        driverHealth: 'running',
        driverVersion: '1.2.3',
        installedAt: TEST_NOW.toISOString(),
        pnpInstanceId: 'ROOT\\MEDIA\\0000',
        endpointInstanceId: 'SWD\\MMDEVAPI\\RENDER-1',
        captureEndpointInstanceId: 'SWD\\MMDEVAPI\\CAPTURE-1',
      });
      writeJson(path.join(rawDirectory, 'driver-probe.json'), readyDriverProbe());
      writeJson(path.join(rawDirectory, 'pnp-endpoints.json'), {
        schemaVersion: 1,
        artifactKind: 'pnp-endpoint-inventory',
        capturedAt: TEST_NOW.toISOString(),
        rootDeviceCount: 1,
        renderEndpointCount: 1,
        captureEndpointCount: 1,
        rootInstanceId: 'ROOT\\MEDIA\\0000',
        renderEndpointId: 'SWD\\MMDEVAPI\\RENDER-1',
        captureEndpointId: 'SWD\\MMDEVAPI\\CAPTURE-1',
      });
      writeJson(path.join(rawDirectory, 'wasapi-tone-probe.json'), {
        schemaVersion: 1,
        artifactKind: 'wasapi-tone-production-probe',
        capturedAt: TEST_NOW.toISOString(),
        passed: true,
        endpointId: 'SWD\\MMDEVAPI\\RENDER-1',
        toneFrames: 4800,
        toneRms: 0.2,
        invalidSamples: 0,
      });
      break;
    case 'INSTALL-REPAIR': {
      const operation = { ...installOperation('install-repair-operation'), rootDeviceCountBefore: 1, rootDeviceCountAfter: 1 };
      writeJson(path.join(rawDirectory, 'repair-evidence.json'), operation);
      writeJson(path.join(rawDirectory, 'driver-probe.json'), readyDriverProbe());
      writeJson(path.join(rawDirectory, 'bridge-handshake.json'), {
        schemaVersion: 1,
        artifactKind: 'bridge-production-handshake',
        passed: true,
        connectedAt: TEST_NOW.toISOString(),
        protocolVersion: '2026-08-10-audio-routing-v6',
        bridgeProcessId: 6101,
        rootInstanceId: 'ROOT\\MEDIA\\0000',
        captureEndpointName: 'Omni Translate Virtual Microphone',
      });
      break;
    }
    case 'INSTALL-UNINSTALL':
      writeJson(path.join(rawDirectory, 'uninstall-evidence.json'), installOperation('install-uninstall-operation'));
      writeJson(path.join(rawDirectory, 'driver-probe.json'), {
        schemaVersion: 1,
        driverHealth: 'not-installed',
        rootDeviceCount: 0,
        runtimeStatePresent: false,
        endpointName: null,
        captureEndpointName: null,
        ioctlAvailable: false,
      });
      writeJson(path.join(rawDirectory, 'pnp-absence.json'), {
        schemaVersion: 1,
        artifactKind: 'pnp-driver-absence',
        capturedAt: TEST_NOW.toISOString(),
        rootDeviceCount: 0,
        renderEndpointCount: 0,
        captureEndpointCount: 0,
        matchingDriverPackageCount: 0,
      });
      break;
    case 'INSTALL-UPGRADE': {
      const operation = {
        ...installOperation('install-upgrade-operation'),
        previousVersion: '1.2.2',
        rootDeviceCountBefore: 1,
        rootDeviceCountAfter: 1,
        retainedBackupCount: 2,
      };
      writeJson(path.join(rawDirectory, 'upgrade-evidence.json'), operation);
      writeJson(path.join(rawDirectory, 'driver-probe.json'), readyDriverProbe());
      writeJson(path.join(rawDirectory, 'bridge-handshake.json'), {
        schemaVersion: 1,
        artifactKind: 'bridge-production-handshake',
        passed: true,
        connectedAt: TEST_NOW.toISOString(),
        protocolVersion: '2026-08-10-audio-routing-v6',
        bridgeProcessId: 6102,
        captureEndpointName: 'Omni Translate Virtual Microphone',
      });
      break;
    }
    case 'INSTALL-RELEASE-LAYOUT':
      writeReleaseLayout(rawDirectory);
      break;
    default:
      throw new Error(`missing raw evidence fixture for ${scenarioId}`);
  }
};

const buildManualFixture = (artifactKind = 'manual-e2e') => {
  const workspaceRoot = makeTempDir();
  const scenarios = artifactKind === 'install-regression'
    ? INSTALL_REGRESSION_SCENARIOS
    : MANUAL_E2E_SCENARIOS;
  const archived = new Map();
  const blocks = [];
  for (const scenarioId of scenarios) {
    const rawDirectory = path.join(workspaceRoot, 'raw', scenarioId);
    fs.mkdirSync(rawDirectory, { recursive: true });
    const scenarioFixture = writeScenarioRawEvidence(rawDirectory, scenarioId, {
      workspaceRoot,
      provenance: TEST_PROVENANCE,
      now: TEST_NOW,
    });
    const realDeviceAuthorityResolver = scenarioFixture?.authorityResolver;
    if (realDeviceAuthorityResolver) {
      realDeviceAuthorityResolvers.set(path.resolve(workspaceRoot), realDeviceAuthorityResolver);
    }
    const collected = testOnlyCollectReleaseManualEvidence({
      source: rawDirectory,
      scenarioId,
      outputRoot: 'collector',
      workspaceRoot,
      provenance: TEST_PROVENANCE,
      now: TEST_NOW,
      suffix: scenarioId.toLowerCase(),
      testOnlyAllowSyntheticAuthority: true,
      ...(realDeviceAuthorityResolver ? {
        testOnlyRealDeviceAuthorityResolver: realDeviceAuthorityResolver,
      } : {}),
    });
    const receipt = archiveReleaseManualEvidence({
      source: collected.packageDirectory,
      scenarioId,
      outputRoot: 'evidence',
      workspaceRoot,
      provenance: TEST_PROVENANCE,
      now: TEST_NOW,
      suffix: scenarioId.toLowerCase(),
      testOnlyAllowSyntheticAuthority: true,
      ...(realDeviceAuthorityResolver ? {
        testOnlyRealDeviceAuthorityResolver: realDeviceAuthorityResolver,
      } : {}),
    });
    archived.set(scenarioId, receipt);
    blocks.push(
      `### ${scenarioId}`,
      '',
      ...(scenarioId === 'E2E-VIRTUAL-MIC-CAPTURE'
        ? [
            '- ExpectedOutcome: supported-ready-real-capture',
            '- CapabilitySupported: true',
            '- CapabilityStatus: ready',
            '- CaptureEndpointName: Omni Translate Virtual Microphone',
            '- VirtualMicFormat: 48000Hz/mono/pcm16',
            '- CapturedFrames: 153600',
            '- BridgeVirtualMicFramesWritten: 33600',
            '- PhysicalPlaybackFrames: 0',
            '- CueCompletedCount: 1',
          ]
        : []),
      '- [x] PASS',
      '- [ ] FAIL',
      `- EvidenceReceipt: ${path.relative(workspaceRoot, receipt.receiptPath).split(path.sep).join('/')}`,
      `- EvidenceReceiptSha256: ${receipt.receiptSha256}`,
      '- Result: observed-and-reviewed',
      '',
    );
  }
  const content = [
    artifactKind === 'install-regression' ? '# Install Regression Report' : '# Desktop E2E Smoke Report',
    '',
    '- SchemaVersion: 2',
    `- ArtifactKind: ${artifactKind}`,
    `- GeneratedAt: ${TEST_NOW.toISOString()}`,
    '- Operator: QA Robot',
    `- Build: ${TEST_PROVENANCE.headCommit}`,
    `- GitHead: ${TEST_PROVENANCE.headCommit}`,
    '- WorktreeClean: true',
    '- DirtyEntryCount: 0',
    '',
    '## Scenario Checklist',
    '',
    ...blocks,
    '## Final Verdict',
    '',
    '- [x] PASS',
    '- [ ] FAIL',
    '- Notes: reviewed',
  ].join('\n');
  return { workspaceRoot, scenarios, archived, content };
};

const rehashManualReceipt = (fixture, scenarioId) => {
  const archived = fixture.archived.get(scenarioId);
  const receipt = readJson(archived.receiptPath);
  const packageRoot = path.join(path.dirname(archived.receiptPath), receipt.source.archivedPath);
  const payloadRoot = path.join(packageRoot, 'artifacts');
  const manifestPath = path.join(packageRoot, 'collector-manifest.json');
  const manifest = readJson(manifestPath);
  manifest.artifacts = manifest.artifacts.map((artifact) => ({
    role: artifact.role,
    path: artifact.path,
    ...hashEvidenceArtifact(path.join(packageRoot, artifact.path)),
  }));
  writeJson(manifestPath, manifest);
  receipt.collector.manifestSha256 = hashEvidenceArtifact(manifestPath).sha256;
  const payloadHash = hashEvidenceArtifact(packageRoot);
  Object.assign(receipt.source, {
    sha256: payloadHash.sha256,
    fileCount: payloadHash.fileCount,
    byteCount: payloadHash.byteCount,
  });
  writeJson(archived.receiptPath, receipt);
  const nextReceiptSha = hashEvidenceArtifact(archived.receiptPath).sha256;
  fixture.content = fixture.content.replace(archived.receiptSha256, nextReceiptSha);
  archived.receiptSha256 = nextReceiptSha;
  return { packageRoot, payloadRoot, receipt, manifest };
};

const buildSystemMetrics = ({ processId, durationMs, cpuPercent = 20, memoryMb = 400 }) => {
  const sampleIntervalMs = 5000;
  const finishedAt = TEST_NOW.getTime();
  const startedAt = finishedAt - durationMs;
  const sampleCount = Math.floor(durationMs / sampleIntervalMs);
  const samples = Array.from({ length: sampleCount }, (_, index) => ({
    timestamp: new Date(startedAt + ((index + 1) * sampleIntervalMs)).toISOString(),
    elapsedMs: (index + 1) * sampleIntervalMs,
    processCount: 4,
    cpuPercent,
    workingSetMb: memoryMb,
  }));
  return {
    schemaVersion: 1,
    artifactKind: 'watch-mode-system-metrics',
    collector: 'scripts/testing/collect-watch-mode-system-metrics.ps1',
    rootProcessId: processId,
    scope: 'process-tree',
    processorCount: 8,
    sampleIntervalMs,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    completionReason: 'root-process-exited',
    sampleCount: samples.length,
    collectionErrors: [],
    samples,
  };
};

const buildPerformanceWorkspace = ({
  durationMs = 30 * 60 * 1000,
  providerLatencyMs = 800,
  subtitleLatencyMs = 500,
  ttsLatencySeconds = 1.5,
  cpuPercent = 20,
  memoryMb = 400,
  dropouts = 0,
  omitMetricsCell = null,
} = {}) => {
  const workspaceRoot = makeTempDir();
  const evidenceRoot = path.join(workspaceRoot, 'artifacts/testing/watch-mode-live');
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const runDirectories = [];
  const cells = [];
  let processId = 10_000;
  for (const modelId of DEFAULT_MODELS) {
    for (const feedbackLoopPrevention of DEFAULT_FEEDBACK_MODES) {
      for (const deviceClass of SUPPORTED_DEVICE_CLASSES) {
        processId += 1;
        const cellKey = `${modelId}::${feedbackLoopPrevention}::${deviceClass}`;
        const runDirectory = path.join(evidenceRoot, 'runs', String(runDirectories.length + 1).padStart(2, '0'));
        fs.mkdirSync(runDirectory, { recursive: true });
        const llmFinalAtMs = 10_000;
        const report = {
          schemaVersion: 1,
          generatedAt: TEST_NOW.toISOString(),
          commit: TEST_PROVENANCE.headCommit,
          provenance: TEST_PROVENANCE,
          mode: 'live',
          modelId,
          feedbackLoopPrevention,
          deviceEvidence: { deviceClass, profileId: deviceClass },
          verdict: 'passed',
          watchSessionReport: {
            status: 'completed',
            elapsedMs: durationMs,
            summary: {
              durationMs,
              cueCount: 1,
              p95SourceToLlmFirstMs: providerLatencyMs,
              p95LlmFinalToRenderMs: subtitleLatencyMs,
            },
            cues: [{
              cueId: `${cellKey}::cue-1`,
              revision: 1,
              comparisonStatus: 'exact',
              sourceAtMs: 1_000,
              llmFirstAtMs: 1_000 + providerLatencyMs,
              llmFinalAtMs,
              renderedFinalAtMs: llmFinalAtMs + subtitleLatencyMs,
              sourceToLlmFirstMs: providerLatencyMs,
              llmFinalToRenderMs: subtitleLatencyMs,
            }],
          },
          layers: {
            environment: {
              data: [{ name: 'start desktop shell', ok: true, result: { pid: processId } }],
            },
            app: {
              data: {
                subtitleQueue: {
                  firstPlaybackLatencySeconds: feedbackLoopPrevention === 'echo-cancel'
                    ? null
                    : ttsLatencySeconds,
                },
              },
            },
            bridge: { data: { droppedFrameCount: dropouts } },
          },
          diagnostics: {
            evidence: {
              bridgeMetrics: {
                underruns: 0,
                droppedFrames: 0,
                driverDroppedBytes: 0,
                staleSourceFramesDropped: 0,
              },
            },
          },
        };
        writeJson(path.join(runDirectory, 'report.json'), report);
        if (omitMetricsCell !== cellKey) {
          writeJson(path.join(runDirectory, 'system-metrics.json'), buildSystemMetrics({
            processId,
            durationMs,
            cpuPercent,
            memoryMb,
          }));
        }
        runDirectories.push(runDirectory);
        const runDirectoryRelative = path.relative(evidenceRoot, runDirectory).split(path.sep).join('/');
        cells.push({
          modelId,
          feedbackLoopPrevention,
          deviceClass,
          deviceProfileId: deviceClass,
          runDirectory: runDirectoryRelative,
          receiptPath: `${runDirectoryRelative}/matrix-cell-authority.json`,
          receiptBytes: 123,
          receiptSha256: crypto.createHash('sha256').update(cellKey).digest('hex'),
        });
      }
    }
  }
  const manifestPath = path.join(evidenceRoot, CANONICAL_STRICT_MATRIX_MANIFEST);
  const sourceManifestName = 'watch-mode-live-matrix-source.json';
  const verificationReceiptName = 'watch-mode-live-matrix-source.json.verified.json';
  writeJson(path.join(evidenceRoot, sourceManifestName), {
    schemaVersion: 2,
    artifactKind: 'watch-mode-strict-matrix-authority',
    generatedAt: TEST_NOW.toISOString(),
    testFixture: true,
  });
  writeJson(path.join(evidenceRoot, verificationReceiptName), {
    schemaVersion: 1,
    artifactKind: 'watch-mode-strict-matrix-verification',
    verifiedAt: TEST_NOW.toISOString(),
    verdict: 'passed',
    testFixture: true,
  });
  writeJson(manifestPath, {
    schemaVersion: 2,
    artifactKind: 'watch-mode-strict-matrix-authority',
    generatedAt: TEST_NOW.toISOString(),
    evidenceMode: 'live',
    strict: true,
    provenance: TEST_PROVENANCE,
    models: DEFAULT_MODELS,
    feedbackLoopPreventionModes: DEFAULT_FEEDBACK_MODES,
    deviceProfiles: SUPPORTED_DEVICE_CLASSES.map((deviceClass) => ({
      profileId: deviceClass,
      deviceClass,
    })),
    runDirectories: cells.map((cell) => cell.runDirectory),
    cells,
    verification: 'passed',
    verifiedAt: TEST_NOW.toISOString(),
    verificationProvenance: TEST_PROVENANCE,
    sourceManifest: sourceManifestName,
    verificationReceiptPath: verificationReceiptName,
  });
  return { workspaceRoot, manifestPath };
};

function testPerformanceAuthorityResolver({ workspaceRoot, manifestPath }) {
  const expectedManifestPath = path.join(
    workspaceRoot,
    'artifacts/testing/watch-mode-live',
    CANONICAL_STRICT_MATRIX_MANIFEST,
  );
  assert.equal(path.resolve(manifestPath), path.resolve(expectedManifestPath));
  const manifest = readJson(manifestPath);
  if (manifest.schemaVersion !== 2 || manifest.artifactKind !== 'watch-mode-strict-matrix-authority') {
    throw new Error('test performance authority requires the schema-v2 strict manifest');
  }
  const runDirectories = manifest.runDirectories.map((candidate) => (
    path.resolve(path.dirname(manifestPath), candidate)
  ));
  const reportsByCell = new Map();
  const runDirectoriesByCell = new Map();
  const rawArtifactsByCell = new Map();
  const authorizedReports = new Map();
  for (const [index, cell] of manifest.cells.entries()) {
    const cellKey = `${cell.modelId}::${cell.feedbackLoopPrevention}::${cell.deviceClass}`;
    const runDirectory = runDirectories[index];
    const report = readJson(path.join(runDirectory, 'report.json'));
    reportsByCell.set(cellKey, report);
    runDirectoriesByCell.set(cellKey, runDirectory);
    const reportHash = hashEvidenceArtifact(path.join(runDirectory, 'report.json'));
    const metricsPath = path.join(runDirectory, 'system-metrics.json');
    const metricsHash = fs.existsSync(metricsPath) ? hashEvidenceArtifact(metricsPath) : null;
    rawArtifactsByCell.set(cellKey, {
      receiptPath: path.join(runDirectory, 'matrix-cell-authority.json'),
      report: {
        path: 'report.json',
        bytes: reportHash.byteCount,
        sha256: reportHash.sha256,
      },
      systemMetrics: metricsHash ? {
        path: 'system-metrics.json',
        bytes: metricsHash.byteCount,
        sha256: metricsHash.sha256,
      } : null,
    });
    authorizedReports.set(
      process.platform === 'win32' ? runDirectory.toLowerCase() : runDirectory,
      report,
    );
  }
  return {
    manifestPath,
    manifest,
    runDirectories,
    authorizedReports,
    reportsByCell,
    runDirectoriesByCell,
    rawArtifactsByCell,
    implementationHashes: [],
    runtimeBinaryHashes: [],
  };
}

const assembleFixture = (options = {}) => {
  const fixture = buildPerformanceWorkspace(options);
  const assembled = assemblePerformanceBaseline({
    operator: 'QA Robot',
    workspaceRoot: fixture.workspaceRoot,
    provenance: TEST_PROVENANCE,
    now: TEST_NOW,
    outputRoot: 'artifacts/testing/perf-baseline',
    evidenceOutputRoot: 'artifacts/testing/release-manual-evidence',
    performanceAuthorityResolver: testPerformanceAuthorityResolver,
  });
  return { ...fixture, ...assembled, report: readJson(assembled.reportPath) };
};

const autoSummaryFixture = {
  generatedAt: '2026-07-27T00:00:00',
  workspaceRoot: 'E:/repo',
  automatedResults: [
    { name: 'contracts', command: 'npm run test:contracts', logPath: 'contracts.log', status: 'passed' },
    {
      name: 'integration-bridge-contract',
      command: 'npm run test:integration:bridge-contract',
      logPath: 'integration-bridge-contract.log',
      status: 'passed',
    },
  ],
};

test('test-only collector fixtures exercise the exact manual schema, scenario set, provenance, and receipts', () => {
  const fixture = buildManualFixture();
  try {
    assert.deepEqual(
      testMarkdownManualReport(fixture.content, validationOptions(fixture.workspaceRoot)),
      [],
    );
  } finally {
    fs.rmSync(fixture.workspaceRoot, { recursive: true, force: true });
  }
});

test('default production report validation rejects synthetic authority packages', () => {
  const fixture = buildManualFixture();
  try {
    const issues = testMarkdownManualReport(fixture.content, {
      workspaceRoot: fixture.workspaceRoot,
      currentProvenance: TEST_PROVENANCE,
      now: TEST_NOW.getTime(),
    });
    assert.ok(issues.some((issue) => issue.includes('authority does not match the registered production emitter')));
  } finally {
    fs.rmSync(fixture.workspaceRoot, { recursive: true, force: true });
  }
});

test('manual validator rejects arbitrary legacy PASS prose and incomplete scenario sets', () => {
  const workspaceRoot = makeTempDir();
  try {
    const issues = testMarkdownManualReport([
      '# Desktop E2E Smoke Report',
      '- GeneratedAt: 2026-08-10T10:00:00.000Z',
      '- Operator: QA Robot',
      `- Build: ${TEST_PROVENANCE.headCommit}`,
      '- [x] PASS',
    ].join('\n'), validationOptions(workspaceRoot));
    assert.ok(issues.some((issue) => issue.startsWith('SchemaVersion must be')));
    assert.ok(issues.some((issue) => issue.startsWith('scenario set/order must be exactly')));
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('manual validator rejects stale, old-HEAD, and dirty provenance', () => {
  const fixture = buildManualFixture();
  try {
    const stale = fixture.content.replace(TEST_NOW.toISOString(), '2026-07-01T00:00:00.000Z');
    assert.ok(testMarkdownManualReport(stale, validationOptions(fixture.workspaceRoot))
      .some((issue) => issue.includes('stale')));
    const oldHead = { ...TEST_PROVENANCE, headCommit: 'b'.repeat(40) };
    assert.ok(testMarkdownManualReport(fixture.content, validationOptions(fixture.workspaceRoot, oldHead))
      .some((issue) => issue.includes('does not exactly match current HEAD')));
    const dirty = { ...TEST_PROVENANCE, worktreeClean: false, dirtyEntryCount: 1 };
    assert.ok(testMarkdownManualReport(fixture.content, validationOptions(fixture.workspaceRoot, dirty))
      .some((issue) => issue.includes('dirty worktree')));
  } finally {
    fs.rmSync(fixture.workspaceRoot, { recursive: true, force: true });
  }
});

test('manual validator rejects tampered archived evidence', () => {
  const fixture = buildManualFixture();
  try {
    const receiptPath = fixture.archived.get(MANUAL_E2E_SCENARIOS[0]).receiptPath;
    const receipt = readJson(receiptPath);
    writeJson(path.join(
      path.dirname(receiptPath),
      receipt.source.archivedPath,
      'artifacts/provider-config-snapshot.json',
    ), {
      tampered: true,
    });
    assert.ok(testMarkdownManualReport(fixture.content, validationOptions(fixture.workspaceRoot))
      .some((issue) => issue.includes('payload SHA-256 mismatch')));
  } finally {
    fs.rmSync(fixture.workspaceRoot, { recursive: true, force: true });
  }
});

test('production archive CLI and public virtual-mic entrypoint reject caller-authored raw sources', async () => {
  const gitWorkspace = makeCleanGitWorkspace();
  const scratch = makeTempDir();
  try {
    const rootOverride = runProductionCli('scripts/testing/collect-release-manual-evidence.mjs', [
      '--workspace-root', path.resolve('.'),
      '--scenario-id', 'E2E-VIRTUAL-MIC-CAPTURE',
      '--source', scratch,
    ], gitWorkspace);
    assert.notEqual(rootOverride.status, 0);
    assert.match(rootOverride.stderr, /generic caller-supplied --source assembly is forbidden/);

    const arbitrary = path.join(scratch, 'arbitrary');
    fs.mkdirSync(arbitrary);
    fs.writeFileSync(path.join(arbitrary, 'PASS.txt'), 'PASS\n', 'utf8');
    const arbitraryResult = runProductionCli('scripts/testing/archive-release-manual-evidence.mjs', [
      '--scenario-id', 'E2E-PROVIDER-CONFIG',
      '--source', arbitrary,
      '--output-root', path.join(scratch, 'archive-arbitrary'),
    ], gitWorkspace);
    assert.notEqual(arbitraryResult.status, 0);
    assert.match(arbitraryResult.stderr, /official E2E-PROVIDER-CONFIG collector package/);

    const raw = path.join(scratch, 'virtual-mic-raw');
    fs.mkdirSync(raw);
    const liveNow = new Date();
    const liveProvenance = {
      schemaVersion: 1,
      source: 'git',
      captureStatus: 'captured',
      headCommit: runGit(gitWorkspace, ['rev-parse', '--verify', 'HEAD']).stdout.trim(),
      worktreeClean: true,
      dirtyEntryCount: 0,
    };
    writeVirtualMicCaptureEvidence(raw, {
      workspaceRoot: gitWorkspace,
      implementationRoot: gitWorkspace,
      provenance: liveProvenance,
      now: liveNow,
    });
    const genericResult = runProductionCli('scripts/testing/collect-release-manual-evidence.mjs', [
      '--scenario-id', 'E2E-VIRTUAL-MIC-CAPTURE',
      '--source', raw,
      '--output-root', path.join(scratch, 'collector'),
    ], gitWorkspace);
    assert.notEqual(genericResult.status, 0);
    assert.match(genericResult.stderr, /generic caller-supplied --source assembly is forbidden/);
    await assert.rejects(collectVirtualMicReleaseManualEvidence({
      source: raw,
      scenarioId: 'E2E-VIRTUAL-MIC-CAPTURE',
      outputRoot: path.join(scratch, 'collector-private'),
      workspaceRoot: gitWorkspace,
      implementationRoot: gitWorkspace,
      provenance: liveProvenance,
      now: liveNow,
    }), /does not accept caller authority\/raw overrides/);
  } finally {
    fs.rmSync(gitWorkspace, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('public production collectors cannot be imported as raw authority wrappers', async () => {
  const rawOptions = {
    source: 'caller-authored',
    outputRoot: 'caller-output',
    workspaceRoot: makeTempDir(),
    provenance: TEST_PROVENANCE,
  };
  try {
    await assert.rejects(collectDesktopReleaseManualEvidence({
      ...rawOptions,
      scenarioId: 'E2E-PROVIDER-CONFIG',
    }), /does not accept caller authority\/raw overrides/);
    await assert.rejects(collectOverlayReleaseManualEvidence({
      ...rawOptions,
      scenarioId: 'E2E-OVERLAY-CLICK-THROUGH',
    }), /does not accept caller authority\/raw overrides/);
    await assert.rejects(collectVirtualMicReleaseManualEvidence({
      ...rawOptions,
      scenarioId: 'E2E-VIRTUAL-MIC-CAPTURE',
    }), /does not accept caller authority\/raw overrides/);
    await assert.rejects(
      collectRealDeviceAudioReleaseManualEvidence({
        ...rawOptions,
        workspaceRoot: path.resolve('.'),
        scenarioId: 'E2E-REAL-DEVICE-AUDIO',
      }),
      /does not accept caller authority\/raw overrides/,
    );
    await assert.rejects(
      collectInstallReleaseManualEvidence({
        ...rawOptions,
        workspaceRoot: path.resolve('.'),
        scenarioId: 'INSTALL-FRESH',
      }),
      /does not accept caller authority\/raw overrides/,
    );
  } finally {
    fs.rmSync(rawOptions.workspaceRoot, { recursive: true, force: true });
  }
});

test('canonical executable authority executes --build-commit and rejects text masquerading as an EXE', () => {
  const workspaceRoot = makeTempDir();
  try {
    const executable = path.join(workspaceRoot, 'target', 'release', 'omni-desktop-shell.exe');
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, 'not a Windows executable\n', 'utf8');
    const raw = path.join(workspaceRoot, 'raw');
    fs.mkdirSync(raw);
    writeJson(path.join(raw, 'emitter-result.json'), {
      desktopExecutable: executable,
      desktopExecutableSha256: sha256(fs.readFileSync(executable)),
    });
    const issues = testOnlyValidateCanonicalExecutableAuthority(
      raw,
      'E2E-DIAGNOSTICS-EXPORT',
      {
        workspaceRoot,
        currentProvenance: TEST_PROVENANCE,
        testOnlyExecutableCommitResolver: (candidate) => spawnSync(candidate, ['--build-commit'], {
          encoding: 'utf8',
          windowsHide: true,
        }),
      },
    );
    assert.match(issues.join('\n'), /--build-commit execution failed|--build-commit does not match/);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('test-only Win32 process seam recomputes the canonical production runner entrypoint', () => {
  const runner = 'scripts/testing/run-real-device-audio-release-evidence.mjs';
  const invocation = {
    argv: [process.execPath, path.resolve(runner)],
    argv0: process.execPath,
    execArgv: [],
    execPath: process.execPath,
    nodeOptions: '',
  };
  const observed = testOnlyValidateReleaseRunnerProcessAuthority({
    runner,
    workspaceRoot: path.resolve('.'),
    testOnlyInvocationAuthority: invocation,
    testOnlyProcessAuthorityResolver: () => ({
      processId: process.pid,
      executablePath: process.execPath,
      commandLine: `"${process.execPath}" "${path.resolve(runner)}"`,
    }),
  });
  assert.equal(observed.runner, runner);
  assert.match(observed.runnerSha256, /^[a-f0-9]{64}$/);
  assert.equal(observed.directEntrypoint, true);
  assert.throws(
    () => testOnlyValidateReleaseRunnerProcessAuthority({
      runner,
      workspaceRoot: path.resolve('.'),
      testOnlyInvocationAuthority: invocation,
      testOnlyProcessAuthorityResolver: () => ({
        processId: process.pid,
        executablePath: process.execPath,
        commandLine: `"${process.execPath}" "caller-authored.mjs" "${path.resolve(runner)}"`,
      }),
    }),
    /must launch node\.exe with the canonical runner as its direct entrypoint/,
  );
  for (const poisoned of [
    { ...invocation, execArgv: ['-e', 'import("attacker")'] },
    { ...invocation, execArgv: ['-p', 'process.argv'] },
    { ...invocation, execArgv: ['--input-type=module'] },
  ]) {
    assert.throws(
      () => testOnlyValidateReleaseRunnerProcessAuthority({
        runner,
        workspaceRoot: path.resolve('.'),
        testOnlyInvocationAuthority: poisoned,
        testOnlyProcessAuthorityResolver: () => ({
          processId: process.pid,
          executablePath: process.execPath,
          commandLine: `"${process.execPath}" "${path.resolve(runner)}"`,
        }),
      }),
      /forbids Node execArgv/,
    );
  }
  assert.throws(
    () => testOnlyValidateReleaseRunnerProcessAuthority({
      runner,
      workspaceRoot: path.resolve('.'),
      testOnlyInvocationAuthority: { ...invocation, nodeOptions: '--require attacker.cjs' },
      testOnlyProcessAuthorityResolver: () => ({
        processId: process.pid,
        executablePath: process.execPath,
        commandLine: `"${process.execPath}" "${path.resolve(runner)}"`,
      }),
    }),
    /forbids NODE_OPTIONS/,
  );
});

test('real Win32 child accepts only direct runner entry and rejects eval, stdin spoofing, and NODE_OPTIONS', () => {
  const child = path.resolve('scripts/testing/fixtures/release-runner-process-authority-child.mjs');
  const direct = spawnSync(process.execPath, [child], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(direct.status, 0, direct.stderr);
  assert.equal(JSON.parse(direct.stdout).directEntrypoint, true);

  const poisonedEnvironment = spawnSync(process.execPath, [child], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, NODE_OPTIONS: '--no-warnings' },
  });
  assert.notEqual(poisonedEnvironment.status, 0);
  assert.match(poisonedEnvironment.stderr, /forbids NODE_OPTIONS/);

  const runner = path.resolve('scripts/testing/run-real-device-audio-release-evidence.mjs');
  const moduleUrl = new URL('./release-manual-collector.mjs', import.meta.url).href;
  const call = `import(${JSON.stringify(moduleUrl)})`
    + `.then((module) => module.collectRealDeviceAudioReleaseManualEvidence({scenarioId:'E2E-REAL-DEVICE-AUDIO'}))`
    + `.then(() => { process.exitCode = 0; })`
    + `.catch((error) => { console.error(error.message); process.exitCode = 23; })`;
  for (const mode of ['-e', '-p']) {
    const evaluated = spawnSync(process.execPath, [mode, call, runner], {
      cwd: path.resolve('.'),
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.notEqual(evaluated.status, 0);
    assert.match(evaluated.stderr, /forbids Node execArgv/);
  }

  const stdinAttack = `process.argv[1] = ${JSON.stringify(runner)};\n${call}\n`;
  const stdin = spawnSync(process.execPath, ['-', runner], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
    windowsHide: true,
    input: stdinAttack,
  });
  assert.notEqual(stdin.status, 0);
  assert.match(stdin.stderr, /must launch node\.exe with the canonical runner as its direct entrypoint/);
});

test('every manual/install production collector profile rejects observation.json self-reported PASS', () => {
  const gitWorkspace = makeCleanGitWorkspace();
  const scratch = makeTempDir();
  try {
    for (const scenarioId of [...MANUAL_E2E_SCENARIOS, ...INSTALL_REGRESSION_SCENARIOS]) {
      const raw = path.join(scratch, scenarioId);
      fs.mkdirSync(raw);
      writeJson(path.join(raw, 'observation.json'), {
        scenarioId,
        result: 'PASS',
        observedAt: new Date().toISOString(),
      });
      const result = runProductionCli('scripts/testing/collect-release-manual-evidence.mjs', [
        '--scenario-id', scenarioId,
        '--source', raw,
        '--output-root', path.join(scratch, `collector-${scenarioId}`),
      ], gitWorkspace);
      assert.notEqual(result.status, 0, `${scenarioId} accepted observation.json`);
      assert.match(
        result.stderr,
        /generic caller-supplied --source assembly is forbidden/,
      );
    }
  } finally {
    fs.rmSync(gitWorkspace, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('production collector rejects a schema-perfect caller-authored provider source outside the same-process runner', () => {
  const gitWorkspace = makeCleanGitWorkspace();
  const scratch = makeTempDir();
  try {
    const raw = path.join(scratch, 'spoofed-provider');
    fs.mkdirSync(raw);
    writeScenarioRawEvidence(raw, 'E2E-PROVIDER-CONFIG');
    const value = readJson(path.join(raw, 'provider-config-snapshot.json'));
    value.capturedAt = new Date().toISOString();
    value.credentialStatus.checkedAt = value.capturedAt;
    value.desktopProcessId = process.pid;
    writeJson(path.join(raw, 'provider-config-snapshot.json'), value);
    const result = runProductionCli('scripts/testing/collect-release-manual-evidence.mjs', [
      '--scenario-id', 'E2E-PROVIDER-CONFIG',
      '--source', raw,
      '--output-root', path.join(scratch, 'collector'),
    ], gitWorkspace);
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /generic caller-supplied --source assembly is forbidden/,
    );
  } finally {
    fs.rmSync(gitWorkspace, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('production collector rejects generic real-device --source assembly outside the canonical authority runner', () => {
  const gitWorkspace = makeCleanGitWorkspace();
  const scratch = makeTempDir();
  try {
    const raw = path.join(scratch, 'spoofed-real-device');
    fs.mkdirSync(raw);
    const result = runProductionCli('scripts/testing/collect-release-manual-evidence.mjs', [
      '--scenario-id', 'E2E-REAL-DEVICE-AUDIO',
      '--source', raw,
      '--output-root', path.join(scratch, 'collector'),
    ], gitWorkspace);
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /generic caller-supplied --source assembly is forbidden/,
    );
  } finally {
    fs.rmSync(gitWorkspace, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('production collector rejects generic overlay --source assembly outside the OS authority runner', () => {
  const gitWorkspace = makeCleanGitWorkspace();
  const scratch = makeTempDir();
  try {
    const raw = path.join(scratch, 'spoofed-overlay');
    fs.mkdirSync(raw);
    const result = runProductionCli('scripts/testing/collect-release-manual-evidence.mjs', [
      '--scenario-id', 'E2E-OVERLAY-CLICK-THROUGH',
      '--source', raw,
      '--output-root', path.join(scratch, 'collector'),
    ], gitWorkspace);
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /generic caller-supplied --source assembly is forbidden/,
    );
  } finally {
    fs.rmSync(gitWorkspace, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('production authority allowlist contains Desktop, audio, overlay, virtual-mic, and install emitters', () => {
  assert.deepEqual(RELEASE_MANUAL_PRODUCTION_EMITTERS, {
    'E2E-PROVIDER-CONFIG': {
      emitterId: 'omni-desktop-provider-config-release-evidence',
      emitterVersion: '0.1.0',
      runner: 'scripts/testing/run-desktop-release-evidence.mjs',
    },
    'E2E-PROVIDER-PROBE': {
      emitterId: 'omni-desktop-provider-probe-release-evidence',
      emitterVersion: '0.1.0',
      runner: 'scripts/testing/run-desktop-release-evidence.mjs',
    },
    'E2E-REAL-DEVICE-AUDIO': {
      emitterId: 'omni-watch-mode-real-device-audio-release-evidence',
      emitterVersion: '0.1.0',
      runner: 'scripts/testing/run-real-device-audio-release-evidence.mjs',
    },
    'E2E-OVERLAY-CLICK-THROUGH': {
      emitterId: 'omni-overlay-click-through-release-evidence',
      emitterVersion: '0.1.0',
      runner: 'scripts/testing/run-overlay-click-through-release-evidence.mjs',
    },
    'E2E-DIAGNOSTICS-EXPORT': {
      emitterId: 'omni-desktop-diagnostics-export-release-evidence',
      emitterVersion: '0.1.0',
      runner: 'scripts/testing/run-desktop-release-evidence.mjs',
    },
    'E2E-VIRTUAL-MIC-CAPTURE': {
      emitterId: 'omni-virtual-mic-release-evidence',
      emitterVersion: '0.1.0',
      runner: 'scripts/testing/run-virtual-mic-release-evidence.mjs',
    },
    ...Object.fromEntries(INSTALL_REGRESSION_SCENARIOS.map((scenarioId) => [scenarioId, {
      emitterId: 'omni.release.install-authority',
      emitterVersion: '1.0.0',
      runner: 'scripts/testing/run-install-release-evidence.mjs',
    }])),
  });
});

test('virtual-mic runner rejects generic inputs and fixes the current-HEAD target/release binaries', () => {
  assert.throws(
    () => parseVirtualMicReleaseArgs(['--source', 'caller-authored']),
    /Unknown flag --source/,
  );
  assert.throws(
    () => parseVirtualMicReleaseArgs(['--bridge-executable', 'C:\\temp\\bridge.exe']),
    /Unknown flag --bridge-executable/,
  );
  const workspaceRoot = makeTempDir();
  try {
    const plan = buildVirtualMicReleasePlan({
      workspaceRoot,
      provenance: TEST_PROVENANCE,
      now: TEST_NOW,
      invocationId: '33333333-3333-7333-8333-333333333333',
      suffix: 'canonical',
    });
    assert.equal(
      plan.collectorExecutable,
      path.join(workspaceRoot, 'target', 'release', 'omni-virtual-mic-target-capture.exe'),
    );
    assert.equal(
      plan.bridgeExecutable,
      path.join(workspaceRoot, 'target', 'release', 'omni-bridge-service.exe'),
    );
    for (const candidate of [plan.collectorExecutable, plan.bridgeExecutable]) {
      fs.mkdirSync(path.dirname(candidate), { recursive: true });
      fs.writeFileSync(candidate, 'stale binary\n', 'utf8');
    }
    const built = buildCurrentVirtualMicBinaries(plan, {
      run(command, args, options) {
        assert.equal(command, 'cargo');
        assert.deepEqual(args.slice(0, 3), ['build', '--locked', '--release']);
        assert.equal(options.env.CARGO_TARGET_DIR, path.join(workspaceRoot, 'target'));
        assert.equal(options.env.CARGO_BUILD_TARGET, undefined);
        assert.equal(options.env.OMNI_BUILD_COMMIT, TEST_PROVENANCE.headCommit);
        assert.ok(!fs.existsSync(plan.collectorExecutable));
        assert.ok(!fs.existsSync(plan.bridgeExecutable));
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(built.status, 0);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('virtual-mic runner binds rebuilt binary commits, process IDs, and raw artifact hashes', async () => {
  const workspaceRoot = makeTempDir();
  try {
    const runnerDestination = path.join(
      workspaceRoot,
      'scripts',
      'testing',
      'run-virtual-mic-release-evidence.mjs',
    );
    fs.mkdirSync(path.dirname(runnerDestination), { recursive: true });
    fs.copyFileSync(
      path.resolve('scripts/testing/run-virtual-mic-release-evidence.mjs'),
      runnerDestination,
    );
    const plan = buildVirtualMicReleasePlan({
      workspaceRoot,
      provenance: TEST_PROVENANCE,
      now: TEST_NOW,
      invocationId: '44444444-4444-7444-8444-444444444444',
      suffix: 'runner',
    });
    const result = await runVirtualMicReleaseEvidence({
      plan,
      clock: () => TEST_NOW,
      provenanceReader: () => TEST_PROVENANCE,
      build: () => {
        fs.mkdirSync(path.dirname(plan.collectorExecutable), { recursive: true });
        fs.writeFileSync(plan.collectorExecutable, 'current collector\n', 'utf8');
        fs.writeFileSync(plan.bridgeExecutable, 'current bridge\n', 'utf8');
        return { status: 0, stdout: '', stderr: '' };
      },
      probeBuildCommit: () => ({ status: 0, stdout: `${TEST_PROVENANCE.headCommit}\n`, stderr: '' }),
      runCollector: () => {
        writeVirtualMicCaptureEvidence(plan.runDirectory, {
          workspaceRoot,
          provenance: TEST_PROVENANCE,
          includeEmitter: false,
        });
        return {
          status: 0,
          pid: 4101,
          stdout: `${JSON.stringify({
            passed: true,
            cueId: 'virtual-mic-release-cue-1',
            captureEndpointId: '{0.0.1.00000000}.omni-virtual-mic',
          })}\n`,
          stderr: '',
        };
      },
      collect: (options) => {
        assert.equal(options.scenarioId, 'E2E-VIRTUAL-MIC-CAPTURE');
        assert.ok(fs.existsSync(path.join(options.source, 'emitter-result.json')));
        return { packageDirectory: 'fixture-package', manifestPath: 'fixture-manifest' };
      },
    });
    assert.equal(result.packageDirectory, 'fixture-package');
    const checked = validateRawReleaseManualEvidence(plan.runDirectory, plan.scenarioId, {
      workspaceRoot,
      currentProvenance: TEST_PROVENANCE,
      now: TEST_NOW.getTime(),
    });
    assert.deepEqual(checked.issues, []);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('Desktop authority runner deletes stale output and rebuilds the canonical binary from clean HEAD', () => {
  const workspaceRoot = makeTempDir();
  try {
    const executablePath = path.join(workspaceRoot, 'target', 'release', 'omni-desktop-shell.exe');
    fs.mkdirSync(path.dirname(executablePath), { recursive: true });
    fs.writeFileSync(executablePath, 'stale Desktop\n', 'utf8');
    const built = buildCurrentDesktopRelease({
      workspaceRoot,
      provenance: TEST_PROVENANCE,
      provenanceReader: () => TEST_PROVENANCE,
      run(command, args, options) {
        assert.equal(command, process.execPath);
        assert.equal(
          args[0],
          path.join(workspaceRoot, 'scripts', 'development', 'build-desktop-release.mjs'),
        );
        assert.equal(options.env.CARGO_TARGET_DIR, path.join(workspaceRoot, 'target'));
        assert.equal(options.env.CARGO_BUILD_TARGET, undefined);
        assert.equal(options.env.OMNI_BUILD_COMMIT, TEST_PROVENANCE.headCommit);
        assert.ok(!fs.existsSync(executablePath));
        fs.writeFileSync(executablePath, 'current Desktop\n', 'utf8');
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(built, executablePath);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('dedicated Desktop runner launches one production process and binds its PID and executable hash', async () => {
  const workspaceRoot = makeTempDir();
  try {
    const executablePath = path.join(workspaceRoot, 'target', 'release', 'omni-desktop-shell.exe');
    fs.mkdirSync(path.dirname(executablePath), { recursive: true });
    fs.writeFileSync(executablePath, 'release desktop fixture\n', 'utf8');
    const executableSha256 = sha256(fs.readFileSync(executablePath));
    const processId = 7501;
    const plan = buildDesktopReleaseEvidencePlan({
      scenarioId: 'E2E-PROVIDER-CONFIG',
      workspaceRoot,
      outputRoot: 'raw',
      collectorOutputRoot: 'collector',
      provenance: TEST_PROVENANCE,
      now: TEST_NOW,
      suffix: 'same-process',
    });
    let launches = 0;
    const result = await runDesktopReleaseEvidence({
      plan,
      listRunning: () => [],
      launch: (launchedExecutable, environment) => {
        launches += 1;
        assert.equal(path.resolve(launchedExecutable), path.resolve(executablePath));
        assert.equal(environment.OMNI_RELEASE_EVIDENCE_SCENARIO, 'E2E-PROVIDER-CONFIG');
        assert.equal(path.resolve(environment.OMNI_RELEASE_EVIDENCE_OUTPUT_DIRECTORY), plan.runDirectory);
        assert.equal(environment.OMNI_RELEASE_EVIDENCE_HEAD_COMMIT, TEST_PROVENANCE.headCommit);
        fs.mkdirSync(plan.runDirectory, { recursive: true });
        writeScenarioRawEvidence(plan.runDirectory, plan.scenarioId, {
          processId,
          desktopExecutable: executablePath,
          desktopExecutableSha256: executableSha256,
        });
        return { pid: processId };
      },
      wait: async () => ({ code: 0, signal: null, processId }),
      collectEvidence: (options) => testOnlyCollectReleaseManualEvidence({
        ...options,
        testOnlyAllowSyntheticAuthority: true,
      }),
    });
    assert.equal(launches, 1);
    assert.equal(result.processId, processId);
    assert.equal(result.scenarioId, plan.scenarioId);
    assert.ok(fs.existsSync(result.manifestPath));
    const manifest = readJson(result.manifestPath);
    assert.equal(manifest.authority.kind, 'test-fixture');
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('dedicated Desktop runner rejects arbitrary executable and caller-authored source overrides', () => {
  assert.throws(
    () => parseDesktopReleaseEvidenceArgs([
      '--scenario-id', 'E2E-PROVIDER-CONFIG',
      '--desktop-executable', 'C:\\temp\\forged.exe',
    ]),
    /Unknown flag --desktop-executable/,
  );
  assert.throws(
    () => buildDesktopReleaseEvidencePlan({
      scenarioId: 'E2E-PROVIDER-CONFIG',
      desktopExecutable: 'C:\\temp\\forged.exe',
      provenance: TEST_PROVENANCE,
    }),
    /does not accept executable\/source/,
  );
});

test('dedicated Desktop runner refuses collection while another Desktop process is running', async () => {
  const workspaceRoot = makeTempDir();
  try {
    const executablePath = path.join(workspaceRoot, 'target', 'release', 'omni-desktop-shell.exe');
    fs.mkdirSync(path.dirname(executablePath), { recursive: true });
    fs.writeFileSync(executablePath, 'release desktop fixture\n', 'utf8');
    const plan = buildDesktopReleaseEvidencePlan({
      scenarioId: 'E2E-DIAGNOSTICS-EXPORT',
      workspaceRoot,
      provenance: TEST_PROVENANCE,
      now: TEST_NOW,
    });
    await assert.rejects(
      runDesktopReleaseEvidence({
        plan,
        listRunning: () => [4242],
        launch: () => assert.fail('runner must not launch a second Desktop process'),
      }),
      /close every existing omni-desktop-shell\.exe.*4242/,
    );
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('Desktop collector rejects an internally consistent emitter built from a different Git commit', () => {
  const workspaceRoot = makeTempDir();
  try {
    const rawDirectory = path.join(workspaceRoot, 'raw');
    fs.mkdirSync(rawDirectory);
    writeScenarioRawEvidence(rawDirectory, 'E2E-DIAGNOSTICS-EXPORT', {
      sourceHeadCommit: 'b'.repeat(40),
    });
    assert.throws(
      () => testOnlyCollectReleaseManualEvidence({
        source: rawDirectory,
        scenarioId: 'E2E-DIAGNOSTICS-EXPORT',
        outputRoot: 'collector',
        workspaceRoot,
        provenance: TEST_PROVENANCE,
        now: TEST_NOW,
        testOnlyAllowSyntheticAuthority: true,
      }),
      /sourceHeadCommit does not match collector exact clean HEAD provenance/,
    );
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('Desktop emitter validation rejects tampered invocation, PID, and diagnostics bundle authority', () => {
  const cases = [
    {
      name: 'invocation',
      mutate(rawDirectory) {
        const snapshotPath = path.join(rawDirectory, 'provider-config-snapshot.json');
        const snapshot = readJson(snapshotPath);
        snapshot.invocationId = '22222222-2222-7222-8222-222222222222';
        writeJson(snapshotPath, snapshot);
      },
      expected: /not bound to the desktop emitter and diagnostics invocation/,
    },
    {
      name: 'pid',
      mutate(rawDirectory) {
        const environmentPath = path.join(rawDirectory, 'diagnostics-bundle', 'environment.json');
        const environment = readJson(environmentPath);
        environment.processId = 4242;
        writeJson(environmentPath, environment);
      },
      expected: /diagnostics environment processId must match/,
    },
    {
      name: 'bundle-hash',
      mutate(rawDirectory) {
        const resultPath = path.join(rawDirectory, 'emitter-result.json');
        const result = readJson(resultPath);
        result.diagnosticsExport.packagedBundleSha256 = '0'.repeat(64);
        writeJson(resultPath, result);
      },
      expected: /diagnostics authority does not match/,
    },
    {
      name: 'legacy-summary-name',
      mutate(rawDirectory) {
        const bundle = path.join(rawDirectory, 'diagnostics-bundle');
        fs.renameSync(
          path.join(bundle, 'diagnostics-summary.json'),
          path.join(bundle, 'core-summary.json'),
        );
      },
      expected: /payload is missing: diagnostics-summary\.json|contains undeclared file core-summary\.json/,
    },
    {
      name: 'missing-config-snapshot',
      mutate(rawDirectory) {
        fs.rmSync(path.join(rawDirectory, 'diagnostics-bundle', 'snapshots', 'config.json'));
      },
      expected: /payload is missing: snapshots\/config\.json/,
    },
    {
      name: 'config-provider-mismatch',
      mutate(rawDirectory) {
        const configPath = path.join(rawDirectory, 'diagnostics-bundle', 'snapshots', 'config.json');
        const config = readJson(configPath);
        config.providers[0].model = 'caller-authored-model';
        writeJson(configPath, config);
      },
      expected: /provider config snapshot model does not match/,
    },
    {
      name: 'placeholder-diagnostics-snapshot',
      mutate(rawDirectory) {
        writeJson(
          path.join(rawDirectory, 'diagnostics-bundle', 'snapshots', 'diagnostics.json'),
          { status: 'ready' },
        );
      },
      expected: /diagnostics snapshot does not match DiagnosticsRuntimeSnapshot/,
    },
    {
      name: 'wrong-diagnostics-artifact-kind',
      mutate(rawDirectory) {
        const manifestPath = path.join(rawDirectory, 'diagnostics-bundle', 'bundle-manifest.json');
        const manifest = readJson(manifestPath);
        manifest.payloadFiles.find((entry) => entry.path === 'diagnostics-summary.json').kind = 'snapshot';
        writeJson(manifestPath, manifest);
      },
      expected: /payload kind for diagnostics-summary\.json must be core-summary/,
    },
  ];
  for (const entry of cases) {
    const rawDirectory = makeTempDir();
    try {
      writeScenarioRawEvidence(rawDirectory, 'E2E-PROVIDER-CONFIG');
      entry.mutate(rawDirectory);
      const checked = validateRawReleaseManualEvidence(
        rawDirectory,
        'E2E-PROVIDER-CONFIG',
        { now: TEST_NOW.getTime() },
      );
      assert.match(checked.issues.join('\n'), entry.expected, entry.name);
    } finally {
      fs.rmSync(rawDirectory, { recursive: true, force: true });
    }
  }
});

test('Provider probe validator cross-checks raw result, top-level fields, and diagnostics config', () => {
  const cases = [
    {
      name: 'raw-latency',
      mutate(value) {
        value.rawProbeResult.measuredLatencyMs = value.latencyMs + 1;
      },
      expected: /raw production Provider probe does not match/,
    },
    {
      name: 'requested-transport',
      mutate(value) {
        value.rawProbeResult.transportRequested = 'http';
      },
      expected: /raw production Provider probe does not match/,
    },
    {
      name: 'credential-reference',
      mutate(value) {
        value.credentialStatus.reference = 'credential:\/\/caller-authored';
      },
      expected: /provider probe result authRef does not match/,
    },
    {
      name: 'available-over-production-budget',
      mutate(value) {
        value.latencyMs = 100_000;
        value.rawProbeResult.measuredLatencyMs = 100_000;
      },
      expected: /within the production 1200 ms budget/,
    },
    {
      name: 'available-without-streaming',
      mutate(value) {
        value.streamObserved = false;
        value.rawProbeResult.streamSupported = false;
        value.rawProbeResult.checks[0].status = 'fail';
      },
      expected: /must observe streaming/,
    },
    {
      name: 'forged-available-routing',
      mutate(value) {
        value.rawProbeResult.routingDecision.speechDisposition = 'queued';
      },
      expected: /routingDecision\/guidance is not the production available route/,
    },
  ];
  for (const testCase of cases) {
    const rawDirectory = makeTempDir();
    try {
      writeScenarioRawEvidence(rawDirectory, 'E2E-PROVIDER-PROBE');
      const probePath = path.join(rawDirectory, 'provider-probe-result.json');
      const probe = readJson(probePath);
      testCase.mutate(probe);
      writeJson(probePath, probe);
      const checked = validateRawReleaseManualEvidence(rawDirectory, 'E2E-PROVIDER-PROBE', {
        now: TEST_NOW.getTime(),
        currentProvenance: TEST_PROVENANCE,
      });
      assert.match(checked.issues.join('\n'), testCase.expected, testCase.name);
    } finally {
      fs.rmSync(rawDirectory, { recursive: true, force: true });
    }
  }
});

test('virtual-mic authority rejects fake PID, endpoint, delta, and timeline evidence', () => {
  const scratch = makeTempDir();
  try {
    const cases = [
      {
        name: 'fake-pid',
        mutate(probe) {
          probe.targetCaptureApplication.name = 'OBS Studio';
          probe.targetCaptureApplication.processId = 4242;
        },
        expected: /official collector child process/,
      },
      {
        name: 'wrong-endpoint',
        mutate(probe) {
          probe.targetCaptureApplication.endpointId = 'hand-authored-endpoint';
        },
        expected: /endpoint ID\/name fields must match/,
      },
      {
        name: 'wrong-delta',
        mutate(probe, snapshot) {
          probe.recomputedCounterDelta.virtualMicFramesWritten = 1;
          snapshot.recomputedCounterDelta.virtualMicFramesWritten = 1;
        },
        expected: /raw before\/after counters and recomputed deltas/,
      },
      {
        name: 'wrong-timeline',
        mutate(probe, snapshot) {
          probe.cueStatusTimeline = [...probe.cueStatusTimeline].reverse();
          snapshot.cueStatusTimeline = [...snapshot.cueStatusTimeline].reverse();
        },
        expected: /status 0 must be queued|timestamps must be strictly increasing/,
      },
    ];
    for (const testCase of cases) {
      const raw = path.join(scratch, testCase.name);
      fs.mkdirSync(raw);
      writeVirtualMicCaptureEvidence(raw, { workspaceRoot: scratch });
      const probePath = path.join(raw, 'virtual-mic-capture-probe.json');
      const snapshotPath = path.join(raw, 'runtime-snapshot.json');
      const probe = readJson(probePath);
      const snapshot = readJson(snapshotPath);
      testCase.mutate(probe, snapshot);
      writeJson(probePath, probe);
      writeJson(snapshotPath, snapshot);
      const checked = validateRawReleaseManualEvidence(raw, 'E2E-VIRTUAL-MIC-CAPTURE', {
        workspaceRoot: scratch,
        currentProvenance: TEST_PROVENANCE,
        now: TEST_NOW.getTime(),
      });
      assert.match(checked.issues.join('\n'), testCase.expected, testCase.name);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('virtual-mic emitter rejects stale build, binary, PID, artifact, and runner authority', () => {
  const cases = [
    {
      name: 'old-build',
      mutate(result) {
        result.sourceHeadCommit = 'b'.repeat(40);
        result.provenance.headCommit = 'b'.repeat(40);
      },
      expected: /sourceHeadCommit must match|does not exactly match current HEAD/,
    },
    {
      name: 'binary-hash',
      mutate(result) {
        result.binaries.collector.sha256 = '0'.repeat(64);
      },
      expected: /collector executable SHA-256/,
    },
    {
      name: 'binary-commit',
      mutate(result) {
        result.binaries.bridge.buildCommit = 'b'.repeat(40);
      },
      expected: /bridge build commit/,
    },
    {
      name: 'pid',
      mutate(result) {
        result.binaries.collector.processId = 4242;
      },
      expected: /binary PIDs do not match/,
    },
    {
      name: 'raw-artifact',
      mutate(result) {
        result.rawArtifacts[0].sha256 = '0'.repeat(64);
      },
      expected: /raw artifact hashes\/sizes/,
    },
    {
      name: 'runner',
      mutate(result) {
        result.runner.sha256 = '0'.repeat(64);
      },
      expected: /runner path\/hash/,
    },
  ];
  for (const testCase of cases) {
    const workspaceRoot = makeTempDir();
    try {
      const raw = path.join(workspaceRoot, 'raw');
      fs.mkdirSync(raw);
      writeVirtualMicCaptureEvidence(raw, { workspaceRoot });
      const emitterPath = path.join(raw, 'emitter-result.json');
      const emitter = readJson(emitterPath);
      testCase.mutate(emitter);
      writeJson(emitterPath, emitter);
      const checked = validateRawReleaseManualEvidence(raw, 'E2E-VIRTUAL-MIC-CAPTURE', {
        workspaceRoot,
        currentProvenance: TEST_PROVENANCE,
        now: TEST_NOW.getTime(),
      });
      assert.match(checked.issues.join('\n'), testCase.expected, testCase.name);
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  }
});

test('manual E2E validator rejects unsupported virtual-mic diagnostics as stable release evidence', () => {
  const fixture = buildManualFixture();
  try {
    const scenarioId = 'E2E-VIRTUAL-MIC-CAPTURE';
    const { payloadRoot } = rehashManualReceipt(fixture, scenarioId);
    const snapshotPath = path.join(payloadRoot, 'runtime-snapshot.json');
    const snapshot = readJson(snapshotPath);
    snapshot.virtualMicOutputSupported = false;
    snapshot.virtualMicOutputStatus = 'unsupported';
    writeJson(snapshotPath, snapshot);
    rehashManualReceipt(fixture, scenarioId);
    fixture.content = fixture.content
      .replace('- CapabilitySupported: true', '- CapabilitySupported: false')
      .replace('- CapabilityStatus: ready', '- CapabilityStatus: unsupported');
    const issues = testMarkdownManualReport(fixture.content, validationOptions(fixture.workspaceRoot));
    assert.ok(issues.some((issue) => issue.includes('runtime snapshot does not match raw counters/capability')));
    assert.ok(issues.some((issue) => issue.includes('CapabilitySupported must match receipt evidence (true)')));
  } finally {
    fs.rmSync(fixture.workspaceRoot, { recursive: true, force: true });
  }
});

test('manual E2E validator requires capture WAV, real-target probe, fingerprint, isolation, and exactly-once cue evidence', () => {
  const fixture = buildManualFixture();
  try {
    const scenarioId = 'E2E-VIRTUAL-MIC-CAPTURE';
    const receiptPath = fixture.archived.get(scenarioId).receiptPath;
    const receipt = readJson(receiptPath);
    const payloadRoot = path.join(path.dirname(receiptPath), receipt.source.archivedPath, 'artifacts');
    const probePath = path.join(payloadRoot, 'virtual-mic-capture-probe.json');
    const snapshotPath = path.join(payloadRoot, 'runtime-snapshot.json');
    const probe = readJson(probePath);
    probe.targetCaptureApplication.classification = 'synthetic-harness';
    probe.fingerprint.expectedPcmSha256 = '0'.repeat(64);
    writeJson(probePath, probe);
    const snapshot = readJson(snapshotPath);
    snapshot.virtualMicFramesWritten = 0;
    snapshot.virtualMicFramesWrittenForCue = 0;
    snapshot.physicalPlaybackFramesWrittenForCue = 4800;
    snapshot.cueLifecycle.completedCount = 2;
    snapshot.cueLifecycle.terminalEventCount = 2;
    writeJson(snapshotPath, snapshot);
    rehashManualReceipt(fixture, scenarioId);
    const issues = testMarkdownManualReport(fixture.content, validationOptions(fixture.workspaceRoot));
    assert.ok(issues.some((issue) => issue.includes('official collector child process')));
    assert.ok(issues.some((issue) => issue.includes('expectedPcmSha256')));
    assert.ok(issues.some((issue) => issue.includes('collector authority must match exactly')));
    assert.ok(issues.some((issue) => issue.includes('runtime snapshot does not match raw counters/capability')));
  } finally {
    fs.rmSync(fixture.workspaceRoot, { recursive: true, force: true });
  }
});

test('manual E2E validator rejects a receipt without the required virtual-mic capture WAV', () => {
  const fixture = buildManualFixture();
  try {
    const scenarioId = 'E2E-VIRTUAL-MIC-CAPTURE';
    const receiptPath = fixture.archived.get(scenarioId).receiptPath;
    const receipt = readJson(receiptPath);
    const payloadRoot = path.join(path.dirname(receiptPath), receipt.source.archivedPath, 'artifacts');
    fs.rmSync(path.join(payloadRoot, 'virtual-mic-capture.wav'));
    assert.ok(testMarkdownManualReport(fixture.content, validationOptions(fixture.workspaceRoot))
      .some((issue) => issue.includes('required virtual-mic-capture-wav artifact is missing')));
  } finally {
    fs.rmSync(fixture.workspaceRoot, { recursive: true, force: true });
  }
});

test('all five install profiles reject generic source assembly outside the production runner', () => {
  const workspaceRoot = makeTempDir();
  try {
    const source = path.join(workspaceRoot, 'caller-authored');
    fs.mkdirSync(source);
    for (const scenarioId of INSTALL_REGRESSION_SCENARIOS) {
      assert.throws(
        () => testOnlyCollectReleaseManualEvidence({
          source,
          scenarioId,
          outputRoot: 'collector',
          workspaceRoot,
          provenance: TEST_PROVENANCE,
          now: TEST_NOW,
        }),
        /raw release evidence assembly is test-only/,
      );
    }
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('prepare helpers expose ready Desktop, real-device, overlay, and v6 virtual-mic emitters', () => {
  const dir = makeTempDir();
  try {
    const e2ePath = prepareManualE2eReport({ outputRoot: dir });
    const e2e = fs.readFileSync(e2ePath, 'utf8');
    assert.match(e2e, /E2E-PROVIDER-CONFIG[\s\S]*AuthorityStatus: ready \(same-process production Desktop emitter\)/);
    assert.match(e2e, /E2E-PROVIDER-PROBE[\s\S]*run-desktop-release-evidence\.mjs --scenario-id E2E-PROVIDER-PROBE/);
    assert.match(e2e, /E2E-REAL-DEVICE-AUDIO[\s\S]*AuthorityStatus: ready \(canonical strict-v2 Watch Mode authority/);
    assert.match(e2e, /E2E-REAL-DEVICE-AUDIO[\s\S]*ProductionCommand: npm run collect:release-evidence:real-device-audio/);
    assert.match(e2e, /E2E-REAL-DEVICE-AUDIO[\s\S]*cell-raw\//);
    assert.match(e2e, /E2E-DIAGNOSTICS-EXPORT[\s\S]*RequiredArtifacts: emitter-result\.json, diagnostics-export-receipt\.json, diagnostics-bundle\//);
    assert.match(e2e, /E2E-OVERLAY-CLICK-THROUGH[\s\S]*AuthorityStatus: ready \(real Windows OS\/WebDriver authority/);
    assert.match(e2e, /E2E-OVERLAY-CLICK-THROUGH[\s\S]*run-overlay-click-through-release-evidence\.mjs/);
    assert.match(e2e, /E2E-OVERLAY-CLICK-THROUGH[\s\S]*webdriver-transcript\.json/);
    assert.match(e2e, /ExpectedOutcome: supported-ready-real-capture/);
    assert.match(e2e, /E2E-VIRTUAL-MIC-CAPTURE[\s\S]*collect:release-evidence:virtual-mic/);
    assert.match(e2e, /E2E-VIRTUAL-MIC-CAPTURE[\s\S]*RequiredArtifacts: emitter-result\.json, virtual-mic-capture\.wav/);
    assert.match(e2e, /CapabilitySupported: TODO/);
    assert.match(e2e, /BridgeVirtualMicFramesWritten: TODO/);
    assert.ok(testMarkdownManualReport(e2e).includes('contains TODO placeholders'));

    const installPath = prepareInstallRegressionReport({ outputRoot: dir });
    const install = fs.readFileSync(installPath, 'utf8');
    assert.match(install, /INSTALL-FRESH[\s\S]*collect:release-evidence:install:fresh/);
    assert.match(install, /INSTALL-REPAIR[\s\S]*signed-package production UAC runner/);
    assert.match(install, /INSTALL-UPGRADE[\s\S]*-PreviousVersion <older-signed-version>/);
    assert.match(install, /INSTALL-RELEASE-LAYOUT[\s\S]*read-only canonical signed-layout authority runner/);
    assert.match(install, /signature-inventory\.json, package-authority\.json, authority\.json/);
    assert.ok(testMarkdownManualReport(install, { artifactKind: 'install-regression' })
      .some((issue) => issue.includes('PASS checkbox is not selected')));

    const performancePath = preparePerformanceBaselineReport({ outputRoot: dir });
    const performance = readJson(performancePath);
    assert.equal(performance.verdict, 'PENDING');
    assert.deepEqual(Object.keys(performance.measurements), PERFORMANCE_MEASUREMENT_NAMES);
    assert.ok(testPerformanceReport(performance).includes('verdict is not PASS'));
    assert.ok(testPerformanceReport(performance)
      .includes('missing or invalid measurement: stabilityDurationMinutes'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('production performance CLI cannot replace the repository authority root', () => {
  const temporaryRoot = makeTempDir();
  try {
    const result = runProductionCli('scripts/testing/assemble-performance-baseline.mjs', [
      '--operator', 'QA Robot',
      '--workspace-root', temporaryRoot,
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unknown flag:? --workspace-root/);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('production performance authority rejects a legacy schema-v1 canonical manifest', () => {
  const fixture = buildPerformanceWorkspace();
  try {
    const manifest = readJson(fixture.manifestPath);
    manifest.schemaVersion = 1;
    delete manifest.artifactKind;
    writeJson(fixture.manifestPath, manifest);
    assert.throws(() => resolvePerformanceStrictAuthority({
      workspaceRoot: fixture.workspaceRoot,
      manifestPath: fixture.manifestPath,
      currentProvenance: TEST_PROVENANCE,
      now: TEST_NOW.getTime(),
    }), /schemaVersion=2/);
  } finally {
    fs.rmSync(fixture.workspaceRoot, { recursive: true, force: true });
  }
});

test('performance assembler and validator recompute a complete 18-cell baseline', () => {
  const fixture = assembleFixture();
  try {
    assert.equal(fixture.verdict, 'PASS');
    assert.deepEqual(fixture.report.measurements, {
      providerFirstEventLatencyMs: 800,
      subtitleCueCommitLatencyMs: 500,
      ttsRoundTripLatencyMs: 1500,
      cpuP95Percent: 20,
      memoryPeakMb: 400,
      observedDropouts: 0,
      stabilityDurationMinutes: 30,
    });
    assert.deepEqual(
      testPerformanceReport(fixture.report, validationOptions(fixture.workspaceRoot)),
      [],
    );
  } finally {
    fs.rmSync(fixture.workspaceRoot, { recursive: true, force: true });
  }
});

test('performance assembler rejects a Watch summary that disagrees with raw cue timestamps', () => {
  const fixture = buildPerformanceWorkspace();
  try {
    const manifest = readJson(fixture.manifestPath);
    const reportPath = path.join(
      path.dirname(fixture.manifestPath),
      manifest.runDirectories[0],
      'report.json',
    );
    const report = readJson(reportPath);
    report.watchSessionReport.summary.p95SourceToLlmFirstMs = 1;
    writeJson(reportPath, report);
    assert.throws(() => assemblePerformanceBaseline({
      operator: 'QA Robot',
      workspaceRoot: fixture.workspaceRoot,
      provenance: TEST_PROVENANCE,
      now: TEST_NOW,
      performanceAuthorityResolver: testPerformanceAuthorityResolver,
    }), /Watch summary p95SourceToLlmFirstMs does not match raw cue timestamps/);
  } finally {
    fs.rmSync(fixture.workspaceRoot, { recursive: true, force: true });
  }
});

test('performance validator rejects a rehashed archive with a forged strict source receipt', () => {
  const fixture = assembleFixture();
  try {
    const receiptPath = path.resolve(fixture.workspaceRoot, fixture.report.sourceEvidence.receiptPath);
    const receipt = readJson(receiptPath);
    const payloadRoot = path.join(path.dirname(receiptPath), receipt.source.archivedPath);
    const sourcePath = path.join(payloadRoot, 'performance-source.json');
    const source = readJson(sourcePath);
    source.collection.sourceReceipt.strictVerificationReceipt.sha256 = '0'.repeat(64);
    writeJson(sourcePath, source);
    const payloadHash = hashEvidenceArtifact(payloadRoot);
    Object.assign(receipt.source, {
      sha256: payloadHash.sha256,
      fileCount: payloadHash.fileCount,
      byteCount: payloadHash.byteCount,
    });
    writeJson(receiptPath, receipt);
    fixture.report.sourceEvidence.receiptSha256 = hashEvidenceArtifact(receiptPath).sha256;
    const issues = testPerformanceReport(fixture.report, validationOptions(fixture.workspaceRoot));
    assert.ok(issues.includes(
      'performance source collection.sourceReceipt does not match strict manifest/verification receipt authority',
    ));
  } finally {
    fs.rmSync(fixture.workspaceRoot, { recursive: true, force: true });
  }
});

test('performance validator rejects authority receipts and raw metrics changed after archive', () => {
  const fixture = assembleFixture();
  try {
    const evidenceRoot = path.dirname(fixture.manifestPath);
    const manifest = readJson(fixture.manifestPath);
    const verificationReceiptPath = path.resolve(evidenceRoot, manifest.verificationReceiptPath);
    const verificationReceipt = readJson(verificationReceiptPath);
    verificationReceipt.verdict = 'caller-authored-pass';
    writeJson(verificationReceiptPath, verificationReceipt);

    const firstRunDirectory = path.resolve(evidenceRoot, manifest.runDirectories[0]);
    const metricsPath = path.join(firstRunDirectory, 'system-metrics.json');
    const metrics = readJson(metricsPath);
    metrics.samples[0].cpuPercent += 1;
    writeJson(metricsPath, metrics);

    const issues = testPerformanceReport(fixture.report, validationOptions(fixture.workspaceRoot));
    assert.ok(issues.includes(
      'strict verification receipt archived copy does not match the current production authority artifact',
    ));
    assert.ok(issues.some((issue) => issue.includes(
      'system metrics archived copy does not match the current production authority artifact',
    )));
  } finally {
    fs.rmSync(fixture.workspaceRoot, { recursive: true, force: true });
  }
});

test('performance validator rejects rehashed hand-edited aggregate numbers', () => {
  const fixture = assembleFixture();
  try {
    const receiptPath = path.resolve(fixture.workspaceRoot, fixture.report.sourceEvidence.receiptPath);
    const receipt = readJson(receiptPath);
    const payloadRoot = path.join(path.dirname(receiptPath), receipt.source.archivedPath);
    const sourcePath = path.join(payloadRoot, 'performance-source.json');
    const source = readJson(sourcePath);
    source.measurements.cpuP95Percent = 1;
    writeJson(sourcePath, source);
    const payloadHash = hashEvidenceArtifact(payloadRoot);
    Object.assign(receipt.source, {
      sha256: payloadHash.sha256,
      fileCount: payloadHash.fileCount,
      byteCount: payloadHash.byteCount,
    });
    writeJson(receiptPath, receipt);
    fixture.report.measurements.cpuP95Percent = 1;
    fixture.report.sourceEvidence.receiptSha256 = hashEvidenceArtifact(receiptPath).sha256;
    const issues = testPerformanceReport(fixture.report, validationOptions(fixture.workspaceRoot));
    assert.ok(issues.includes(
      'performance-source.json measurements do not match independently recomputed raw evidence',
    ));
    assert.ok(issues.includes(
      'performance report measurements do not match independently recomputed raw evidence',
    ));
  } finally {
    fs.rmSync(fixture.workspaceRoot, { recursive: true, force: true });
  }
});

test('performance gate rejects threshold violations, dropouts, and short stability runs', () => {
  for (const [options, expectedIssue] of [
    [{ providerLatencyMs: 1300 }, 'providerFirstEventLatencyMs=1300 exceeds threshold 1200'],
    [{ dropouts: 1 }, 'observedDropouts must be 0'],
    [{ durationMs: 29 * 60 * 1000 }, 'stabilityDurationMinutes=29 is shorter than 30'],
  ]) {
    const fixture = assembleFixture(options);
    try {
      assert.equal(fixture.verdict, 'FAIL');
      const issues = testPerformanceReport(fixture.report, validationOptions(fixture.workspaceRoot));
      assert.ok(issues.some((issue) => issue.includes(expectedIssue)), JSON.stringify(issues));
    } finally {
      fs.rmSync(fixture.workspaceRoot, { recursive: true, force: true });
    }
  }
});

test('performance gate rejects old or dirty current checkout provenance', () => {
  const fixture = assembleFixture();
  try {
    const oldHead = { ...TEST_PROVENANCE, headCommit: 'b'.repeat(40) };
    assert.ok(testPerformanceReport(fixture.report, validationOptions(fixture.workspaceRoot, oldHead))
      .some((issue) => issue.includes('does not exactly match current HEAD')));
    const dirty = { ...TEST_PROVENANCE, worktreeClean: false, dirtyEntryCount: 1 };
    assert.ok(testPerformanceReport(fixture.report, validationOptions(fixture.workspaceRoot, dirty))
      .some((issue) => issue.includes('dirty worktree')));
  } finally {
    fs.rmSync(fixture.workspaceRoot, { recursive: true, force: true });
  }
});

test('performance assembler refuses a canonical matrix cell without raw system metrics', () => {
  const missingCell = `${DEFAULT_MODELS[0]}::${DEFAULT_FEEDBACK_MODES[0]}::${SUPPORTED_DEVICE_CLASSES[0]}`;
  const fixture = buildPerformanceWorkspace({ omitMetricsCell: missingCell });
  try {
    assert.throws(() => assemblePerformanceBaseline({
      operator: 'QA Robot',
      workspaceRoot: fixture.workspaceRoot,
      provenance: TEST_PROVENANCE,
      now: TEST_NOW,
      performanceAuthorityResolver: testPerformanceAuthorityResolver,
    }), /raw system metrics are missing/);
  } finally {
    fs.rmSync(fixture.workspaceRoot, { recursive: true, force: true });
  }
});

test('system metrics collector records real process-tree samples', {
  skip: process.platform !== 'win32',
}, () => {
  const dir = makeTempDir();
  try {
    const outputPath = path.join(dir, 'system-metrics.json');
    const collectorPath = path.resolve('scripts/testing/collect-watch-mode-system-metrics.ps1');
    const command = [
      `$target = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-Command','Start-Sleep -Seconds 3') -WindowStyle Hidden -PassThru`,
      `& '${collectorPath.replaceAll("'", "''")}' -RootProcessId $target.Id -OutputPath '${outputPath.replaceAll("'", "''")}' -SampleIntervalMs 500`,
      'exit $LASTEXITCODE',
    ].join('; ');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], {
      encoding: 'utf8',
      timeout: 15_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const metrics = readJson(outputPath);
    assert.equal(metrics.completionReason, 'root-process-exited');
    assert.equal(metrics.collectionErrors.length, 0);
    assert.ok(metrics.samples.length >= 2);
    assert.ok(metrics.samples.every((sample) => sample.workingSetMb > 0));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildQualityGateSummary marks artifacts with issues as pending', () => {
  const summary = buildQualityGateSummary({
    autoSummary: autoSummaryFixture,
    workspaceRoot: 'E:/repo',
    e2eReport: 'e2e.md',
    performanceBaseline: 'perf.json',
    installRegression: 'install.md',
    e2eIssues: ['contains TODO placeholders'],
    performanceIssues: [],
    installIssues: [],
    generatedAt: '2026-07-27T00:00:01',
  });
  assert.equal(summary.manualVerificationStatus, 'pending');
  assert.equal(summary.generatedAt, '2026-07-27T00:00:01');
  assert.equal(summary.workspaceRoot, 'E:/repo');
  assert.equal(summary.automatedResults, autoSummaryFixture.automatedResults);
  assert.deepEqual(summary.automatedIntegration, {
    name: 'integration-bridge-contract',
    status: 'passed',
    logPath: 'integration-bridge-contract.log',
    coveredManualScenarios: ['subtitle-display', 'locked-overlay-click-through', 'tts-counters'],
  });
  assert.deepEqual(summary.manualArtifacts, {
    e2eReport: 'e2e.md',
    performanceBaseline: 'perf.json',
    installRegression: 'install.md',
  });
  assert.deepEqual(summary.manualArtifactResults, [
    { name: 'manual-e2e', path: 'e2e.md', status: 'pending', issues: ['contains TODO placeholders'] },
    { name: 'performance-baseline', path: 'perf.json', status: 'passed', issues: [] },
    { name: 'install-regression', path: 'install.md', status: 'passed', issues: [] },
  ]);
  assert.deepEqual(summary.degradation, {
    allowPendingManual: false,
    skipDesktopShell: false,
    skipBridgeService: false,
    manualArtifactStatuses: {
      'manual-e2e': 'pending',
      'performance-baseline': 'passed',
      'install-regression': 'passed',
    },
    degradedPass: false,
  });
});

test('buildQualityGateSummary reports passed when every artifact is clean', () => {
  const summary = buildQualityGateSummary({
    autoSummary: autoSummaryFixture,
    e2eReport: 'e2e.md',
    performanceBaseline: 'perf.json',
    installRegression: 'install.md',
    e2eIssues: [],
    performanceIssues: [],
    installIssues: [],
  });
  assert.equal(summary.manualVerificationStatus, 'passed');
  assert.deepEqual(summary.manualArtifactResults.map((artifact) => artifact.status), [
    'passed',
    'passed',
    'passed',
  ]);
  assert.equal(summary.degradation.degradedPass, false);
});

test('buildQualityGateSummary records the degraded path when switches are used', () => {
  const summary = buildQualityGateSummary({
    autoSummary: {
      ...autoSummaryFixture,
      degradation: { skipDesktopShell: true, skipBridgeService: false },
    },
    e2eReport: 'e2e.md',
    performanceBaseline: 'perf.json',
    installRegression: 'install.md',
    e2eIssues: ['contains TODO placeholders'],
    performanceIssues: [],
    installIssues: [],
    allowPendingManual: true,
  });
  assert.equal(summary.manualVerificationStatus, 'pending');
  assert.deepEqual(summary.degradation, {
    allowPendingManual: true,
    skipDesktopShell: true,
    skipBridgeService: false,
    manualArtifactStatuses: {
      'manual-e2e': 'pending',
      'performance-baseline': 'passed',
      'install-regression': 'passed',
    },
    degradedPass: true,
  });
});

test('buildQualityGateSummary marks degradedPass when pending manual is allowed', () => {
  const summary = buildQualityGateSummary({
    autoSummary: autoSummaryFixture,
    e2eReport: 'e2e.md',
    performanceBaseline: 'perf.json',
    installRegression: 'install.md',
    e2eIssues: [],
    performanceIssues: ['verdict is not PASS'],
    installIssues: [],
    allowPendingManual: true,
  });
  assert.equal(summary.degradation.allowPendingManual, true);
  assert.equal(summary.degradation.degradedPass, true);
  const passedManual = buildQualityGateSummary({
    autoSummary: autoSummaryFixture,
    e2eReport: 'e2e.md',
    performanceBaseline: 'perf.json',
    installRegression: 'install.md',
    e2eIssues: [],
    performanceIssues: [],
    installIssues: [],
    allowPendingManual: true,
  });
  assert.equal(passedManual.degradation.allowPendingManual, true);
  assert.equal(passedManual.degradation.degradedPass, false);
});

test('buildQualityGateSummary throws when the integration step is missing', () => {
  assert.throws(
    () => buildQualityGateSummary({
      autoSummary: { automatedResults: [{ name: 'contracts', status: 'passed', logPath: 'x' }] },
      e2eReport: 'e2e.md',
      performanceBaseline: 'perf.json',
      installRegression: 'install.md',
      e2eIssues: [],
      performanceIssues: [],
      installIssues: [],
    }),
    /integration-bridge-contract' is missing/,
  );
});

test('buildAutoSteps honors the skip switches', () => {
  assert.deepEqual(buildAutoSteps().map((step) => step.name), [
    'audit-architecture',
    'audit-error-handling',
    'audit-rust-warnings',
    'i18n-ratchet',
    'verify-desktop',
    'contracts',
    'config-paths',
    'integration-bridge-contract',
    'driver-boundaries',
    'watch-mode-tooling',
    'release-tooling',
    'quality-gate-tooling',
    'startup-tooling',
    'coverage-base',
    'check-desktop-shell',
    'test-desktop-shell',
    'check-bridge-service-native',
    'test-bridge-service-native',
  ]);
  assert.deepEqual(
    buildAutoSteps({ skipDesktopShell: true, skipBridgeService: true }).map((step) => step.name),
    [
      'audit-architecture', 'audit-error-handling', 'audit-rust-warnings', 'i18n-ratchet',
      'verify-desktop', 'contracts', 'config-paths', 'integration-bridge-contract',
      'driver-boundaries', 'watch-mode-tooling', 'release-tooling', 'quality-gate-tooling',
      'startup-tooling', 'coverage-base',
    ],
  );
});

test('test:all includes every deterministic cross-layer gate', () => {
  assert.deepEqual(buildSteps({ skipIntegration: true }).map((step) => step.name), [
    'workspace-tests',
    'desktop-shell-tests',
    'bridge-service-native-tests',
    'contracts',
    'config-paths',
    'integration-bridge-contract',
    'driver-boundaries',
    'watch-mode-tooling',
    'release-tooling',
    'quality-gate-tooling',
    'startup-tooling',
  ]);
});
