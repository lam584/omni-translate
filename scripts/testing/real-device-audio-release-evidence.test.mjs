import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ensureDir, writeJson } from '../lib/testing-common.mjs';
import {
  REAL_DEVICE_AUDIO_ARTIFACTS,
  REAL_DEVICE_AUDIO_SELECTED_CELL,
  exactReleaseGridFailure,
  fileReceipt,
  validateRealDeviceAudioEvidence,
} from './real-device-audio-release-evidence.mjs';
import {
  buildRealDeviceAudioReleasePlan,
  parseRealDeviceAudioReleaseArgs,
  runRealDeviceAudioReleaseEvidence,
} from './run-real-device-audio-release-evidence.mjs';
import { requiredCellArtifactPaths } from './watch-mode-evidence-authority.mjs';
import {
  DEFAULT_FEEDBACK_MODES,
  DEFAULT_MODELS,
  SUPPORTED_DEVICE_CLASSES,
} from './run-watch-mode-live-matrix.mjs';
import {
  BALANCED_RELEASE_PLAN,
  LIVE_LLM_CELLS,
} from './watch-mode-balanced-release-plan.mjs';

const TEST_HEAD = 'a'.repeat(40);
const TEST_NOW = new Date('2026-08-10T10:00:00.000Z');
const provenance = Object.freeze({
  schemaVersion: 1,
  source: 'git',
  captureStatus: 'captured',
  headCommit: TEST_HEAD,
  worktreeClean: true,
  dirtyEntryCount: 0,
});

const temporaryRoot = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `omni-real-device-${name}-`));

const writeText = (candidate, value) => {
  ensureDir(path.dirname(candidate));
  fs.writeFileSync(candidate, value, 'utf8');
};

const writePcm16Wav = (candidate, {
  sampleRateHz = 16_000,
  channels = 1,
  seconds = 60,
  amplitude = 0.1,
} = {}) => {
  const frames = sampleRateHz * seconds;
  const data = Buffer.alloc(frames * channels * 2);
  for (let frame = 0; frame < frames; frame += 1) {
    const sample = Math.round(Math.sin(2 * Math.PI * 440 * frame / sampleRateHz) * 32767 * amplitude);
    for (let channel = 0; channel < channels; channel += 1) {
      data.writeInt16LE(sample, (frame * channels + channel) * 2);
    }
  }
  const wav = Buffer.alloc(44 + data.length);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + data.length, 4);
  wav.write('WAVEfmt ', 8, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRateHz, 24);
  wav.writeUInt32LE(sampleRateHz * channels * 2, 28);
  wav.writeUInt16LE(channels * 2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(data.length, 40);
  data.copy(wav, 44);
  ensureDir(path.dirname(candidate));
  fs.writeFileSync(candidate, wav);
};

const playbackLog = ({ failed = false } = {}) => Array.from({ length: 8 }, (_, index) => {
  const cue = `translated-cue-${index + 1}`;
  const base = index * 3;
  const line = (offset, status) => (
    `2026-08-10 09:00:${String(base + offset).padStart(2, '0')}.000 [NORMAL] [bridge] ${cue} - event=translation_playback_status status=${status} cueId=${cue} estimatedDurationMs=1000 sid=watch-session`
  );
  return [
    line(0, 'queued'),
    line(1, 'started'),
    line(2, failed && index === 0 ? 'route-failed' : 'completed'),
  ].join('\n');
}).join('\n');

const watchReport = ({ durationMs = 180_000 } = {}) => {
  const cues = Array.from({ length: 8 }, (_, index) => ({
    cueId: `watch-cue-${index + 1}`,
    comparisonStatus: 'exact',
    llmFirstAtMs: 1000 + index * 100,
    publishedFirstAtMs: 1100 + index * 100,
    renderedFirstAtMs: 1200 + index * 100,
    sourceText: `source ${index + 1}`,
    translatedText: `translation ${index + 1}`,
  }));
  return {
    sessionId: 'watch-session',
    status: 'completed',
    elapsedMs: durationMs,
    summary: {
      durationMs,
      cueCount: cues.length,
      completeCueCount: cues.length,
      visibleRenderCueCount: cues.length,
      unrenderedCueCount: 0,
    },
    cues,
    events: [
      { eventId: 'watch-event-1', stage: 'session', kind: 'started', elapsedMs: 0, accepted: true },
      { eventId: 'watch-event-2', stage: 'session', kind: 'completed', elapsedMs: durationMs, accepted: true },
    ],
    droppedCueCount: 0,
    droppedEventCount: 0,
  };
};

function buildAuthorizedFixture({
  durationMs = 180_000,
  failedPlayback = false,
  endpointId = '{0.0.0.00000000}.{physical-default}',
  endpointName = 'Speakers (Realtek Audio)',
  profileId = 'default-speaker',
} = {}) {
  const workspaceRoot = temporaryRoot('workspace');
  const evidenceRoot = path.join(workspaceRoot, 'artifacts', 'testing', 'watch-mode-live');
  const runDirectory = path.join(evidenceRoot, 'authorized-cell');
  ensureDir(runDirectory);
  const watch = watchReport({ durationMs });
  const selectedCell = {
    ...REAL_DEVICE_AUDIO_SELECTED_CELL,
    deviceProfileId: profileId,
  };
  const report = {
    schemaVersion: 1,
    generatedAt: '2026-08-10T09:30:00.000Z',
    provenance,
    mode: 'live',
    verdict: 'passed',
    modelId: REAL_DEVICE_AUDIO_SELECTED_CELL.modelId,
    feedbackLoopPrevention: 'process-exclusion',
    deviceEvidence: {
      deviceClass: 'default-speaker',
      profileId,
    },
    watchSessionReport: watch,
    layers: {
      bridge: {
        status: 'passed',
        data: {
          processExclusionRestart: {
            completed: true,
            evidenceMode: 'live',
            fixtureOnly: false,
            oldBridgeProcessId: 2200,
            newBridgeProcessId: 2300,
            oldFramesAfterRestart: 0,
            sourceFramesBefore: 10_000,
            sourceFramesAfter: 20_000,
          },
        },
      },
      strictContent: { status: 'passed' },
      physicalOutputContent: { status: 'passed' },
    },
  };
  const fingerprint = {
    bridgeProcessId: 3100,
    excludedProcessId: 3100,
    externalPlayerProcessId: 3200,
    bridgeChildPlayerProcessId: 3300,
    bridgeChildParentProcessId: 3100,
    bridgeChildExitCode: 0,
    sourceCaptureMode: 'process-exclusion',
    captureBackend: 'wasapi-process-exclusion',
    processLoopbackStatus: 'ready',
    translationFrequencyHz: 997,
    externalFrequencyHz: 1733,
    bridgeChildFrequencyHz: 2449,
    physicalTranslationComponent: 0.05,
    sourceTranslationComponent: 0.0001,
    physicalExternalComponent: 0.05,
    sourceExternalComponent: 0.05,
  };
  const jsonFiles = {
    'watch-session-report.json': watch,
    'report.json': report,
    'physical-playback-device.json': {
      verified: true,
      fixtureOnly: false,
      profileId,
      deviceClass: 'default-speaker',
      requestedDeviceId: 'default',
      resolvedDeviceId: endpointId,
      resolvedDeviceName: endpointName,
      classificationSignals: [endpointId, endpointName, 'HDAUDIO'],
      classificationSource: 'windows-mmdevice-registry',
      routeEvidenceSource: 'physical-output-probe+runtime-route',
    },
    'physical-output-probe.json': {
      passed: true,
      skipped: false,
      status: 'passed',
      resolvedPhysicalPlaybackDeviceId: endpointId,
      resolvedPhysicalPlaybackDeviceName: endpointName,
      playbackFramesWrittenBefore: 100,
      playbackFramesWrittenAfter: 100_000,
      invalidSamples: 0,
      processExclusionFingerprint: fingerprint,
    },
    'physical-output-recording.json': {
      passed: true,
      capturedFrames: 960_000,
      rms: 0.07,
      peak: 0.1,
    },
    'physical-output-content.json': {
      passed: true,
      skipped: false,
      source: 'This is the original media transcript.',
      translation: '这是物理扬声器中的翻译内容。',
      subtitleText: '这是字幕。',
      segmentTranslationText: '这是分段译音。',
      recording: { passed: true },
      audioQuality: { passed: true },
      contentConsistency: { passed: true },
      translatedSpeech: {
        passed: true,
        queuedSegments: 8,
        playedSegments: 8,
      },
    },
    'bridge-source-probe.json': { passed: true },
    'driver.json': { skipped: true, reason: 'process-exclusion' },
    'physical-output-content.json.tmp-never': undefined,
    'playback.json': {
      passed: true,
      playbackMode: 'wasapi-media-injector',
      injectorProcessId: 1300,
    },
    'system-metrics.json': { artifactKind: 'watch-mode-system-metrics', samples: [{ pid: 1100 }] },
    'source-media-transcript.json': { passed: true, source: 'This is the original media transcript.' },
  };
  jsonFiles['physical-output-content.raw.json'] = structuredClone(jsonFiles['physical-output-content.json']);
  for (const [relativePath, value] of Object.entries(jsonFiles)) {
    if (value !== undefined) writeJson(path.join(runDirectory, relativePath), value);
  }
  writeJson(path.join(runDirectory, 'run-metadata.json'), {
    schemaVersion: 'watch-mode-run-metadata/v1', runMarker: null, startedAtLocal: null,
    modelId: 'fixture-model', feedbackMode: 'process-exclusion',
  });
  writeJson(path.join(runDirectory, 'run-collection.json'), {
    schemaVersion: 'watch-mode-run-collection/v2',
    artifactKind: 'watch-mode-run-collection',
    request: { schemaVersion: 'watch-mode-run-request/v1', runMode: 'live', feedbackMode: 'process-exclusion' },
    collectionStatus: 'completed',
    steps: [
      { schemaVersion: 'watch-mode-step/v1', id: 'start-desktop-shell', phase: 'desktopLaunch', status: 'passed', data: { pid: 1100 }, error: null },
      { schemaVersion: 'watch-mode-step/v1', id: 'start-physical-output-content-recording', phase: 'recording', status: 'passed', data: { pid: 1200 }, error: null },
    ],
    ownedProcesses: [],
    artifacts: {
      runMetadata: 'run-metadata.json', appLog: 'app.log', bridgeLog: 'bridge-service.log',
      driverProbe: 'driver.json', bridgeSourceProbe: 'bridge-source-probe.json',
      physicalOutputProbe: 'physical-output-probe.json', physicalPlaybackDevice: 'physical-playback-device.json',
      playback: 'playback.json', watchSessionReport: 'watch-session-report.json',
      sourceMediaTranscript: 'source-media-transcript.json', physicalOutputContentRaw: 'physical-output-content.raw.json',
      physicalOutputRecording: 'physical-output-recording.wav', systemMetrics: 'system-metrics.json',
    },
    primaryError: null,
    cleanupErrors: [],
  });
  writeText(path.join(runDirectory, 'app.log'), '2026-08-10 09:00:00.000 [NORMAL] [app] watch - session ready\n');
  writeText(path.join(runDirectory, 'bridge-service.log'), `${playbackLog({ failed: failedPlayback })}\n`);
  writeText(path.join(runDirectory, 'report.md'), '# passed\n');
  writePcm16Wav(path.join(runDirectory, 'physical-output-recording.wav'));
  writePcm16Wav(
    path.join(runDirectory, 'physical-output-probe-runtime', 'process-exclusion-physical-output.wav'),
    { sampleRateHz: 48_000, channels: 2, seconds: 1 },
  );
  writePcm16Wav(
    path.join(runDirectory, 'physical-output-probe-runtime', 'process-exclusion-source-pipe.wav'),
    { sampleRateHz: 48_000, channels: 2, seconds: 1 },
  );
  const minutePcm = Buffer.alloc(60 * 16_000 * 2, 1);
  for (const relativePath of [
    'provider-input-16k-mono.pcm',
    'source-media-reference-16k-mono.pcm',
    'physical-output-recording-16k-mono.pcm',
    'physical-output-recording-source-window-16k-mono.pcm',
  ]) fs.writeFileSync(path.join(runDirectory, relativePath), minutePcm);

  const requiredPaths = requiredCellArtifactPaths('process-exclusion');
  for (const relativePath of requiredPaths) {
    const candidate = path.join(runDirectory, ...relativePath.split('/'));
    if (fs.existsSync(candidate)) continue;
    if (relativePath.endsWith('.json')) writeJson(candidate, { passed: true });
    else writeText(candidate, 'authorized raw evidence\n');
  }
  const receipt = {
    schemaVersion: 3,
    artifactKind: 'watch-mode-live-cell-authority',
    generatedAt: '2026-08-10T09:35:00.000Z',
    provenance,
    matrixCell: selectedCell,
    artifacts: requiredPaths.map((relativePath) => ({
      path: relativePath,
      ...fileReceipt(path.join(runDirectory, ...relativePath.split('/'))),
    })),
  };
  const receiptPath = path.join(runDirectory, 'matrix-cell-authority.json');
  writeJson(receiptPath, receipt);
  const manifest = {
    schemaVersion: 4,
    artifactKind: 'watch-mode-strict-matrix-authority',
    strict: true,
    evidenceMode: 'live',
    verification: 'passed',
    generatedAt: '2026-08-10T09:40:00.000Z',
    verifiedAt: '2026-08-10T09:41:00.000Z',
    provenance,
    verificationProvenance: provenance,
    cells: [{
      ...selectedCell,
      runDirectory: 'authorized-cell',
      receiptPath: 'authorized-cell/matrix-cell-authority.json',
      receiptBytes: fileReceipt(receiptPath).bytes,
      receiptSha256: fileReceipt(receiptPath).sha256,
    }],
    runDirectories: ['authorized-cell'],
  };
  const manifestPath = path.join(evidenceRoot, 'latest-successful-watch-mode-strict-matrix.json');
  writeJson(manifestPath, manifest);
  const resolved = {
    manifestPath,
    manifest,
    currentProvenance: provenance,
    cell: selectedCell,
    cellIndex: 0,
    runDirectory,
    report,
    receiptPath,
    receipt,
    strict: { ok: true },
    authority: {},
  };
  return { workspaceRoot, evidenceRoot, runDirectory, manifestPath, resolved };
}

const buildPlan = (fixture, outputRoot = 'assembled') => buildRealDeviceAudioReleasePlan({
  workspaceRoot: fixture.workspaceRoot,
  outputRoot,
  collectorOutputRoot: 'collector-output',
  provenance,
  now: TEST_NOW,
  suffix: 'fixture',
});

test('production CLI has no source, manifest, dry-run, simulated, or skip seam', () => {
  for (const argv of [
    ['--source', 'forged'],
    ['--manifest-path', 'forged.json'],
    ['--workspace-root', 'forged'],
    ['--dry-run'],
    ['--simulated'],
    ['--skip'],
  ]) assert.throws(() => parseRealDeviceAudioReleaseArgs(argv), /Unknown flag/);
  const root = temporaryRoot('plan-no-source');
  assert.throws(() => buildRealDeviceAudioReleasePlan({
    workspaceRoot: root,
    provenance,
    source: 'forged',
  }), /does not accept source/);
});

test('canonical release grid binds each device class to its declared profileId', () => {
  const profileIds = {
    'default-speaker': 'office-default-render',
    usb: 'conference-usb-dac',
    bluetooth: 'headset-a2dp',
  };
  const manifest = {
    schemaVersion: 4,
    artifactKind: 'watch-mode-strict-matrix-authority',
    strict: true,
    evidenceMode: 'live',
    verification: 'passed',
    validationPlan: BALANCED_RELEASE_PLAN,
    models: DEFAULT_MODELS,
    feedbackLoopPreventionModes: DEFAULT_FEEDBACK_MODES,
    deviceProfiles: SUPPORTED_DEVICE_CLASSES.map((deviceClass) => ({
      deviceClass,
      profileId: profileIds[deviceClass],
    })),
    cells: [],
    runDirectories: [],
  };
  for (const plannedCell of LIVE_LLM_CELLS) {
    manifest.cells.push({
      ...plannedCell,
      deviceProfileId: profileIds[plannedCell.deviceClass],
    });
    manifest.runDirectories.push(`runs/${manifest.runDirectories.length + 1}`);
  }
  assert.equal(exactReleaseGridFailure(manifest), null);
  manifest.cells[0].deviceProfileId = 'wrong-profile';
  assert.match(exactReleaseGridFailure(manifest), /missing/);
});

test('canonical assembler copies the fixed authority inventory and validates the E2E package', async () => {
  const fixture = buildAuthorizedFixture({ profileId: 'office-default-render' });
  const plan = buildPlan(fixture);
  let collectorCall;
  const result = await runRealDeviceAudioReleaseEvidence({
    plan,
    authorityResolver: () => fixture.resolved,
    collectEvidence: async (options) => {
      collectorCall = options;
      return {
        packageDirectory: path.join(fixture.workspaceRoot, 'collector-package'),
        manifestPath: path.join(fixture.workspaceRoot, 'collector-package', 'collector-manifest.json'),
      };
    },
    now: () => new Date('2026-08-10T10:01:00.000Z'),
  });
  assert.equal(result.scenarioId, 'E2E-REAL-DEVICE-AUDIO');
  assert.equal(result.selectedCell.deviceProfileId, 'office-default-render');
  assert.equal(collectorCall.source, plan.runDirectory);
  assert.deepEqual(fs.readdirSync(plan.runDirectory).sort(), REAL_DEVICE_AUDIO_ARTIFACTS
    .map((artifact) => artifact.path).sort());
  const checked = validateRealDeviceAudioEvidence(plan.runDirectory, {
    workspaceRoot: fixture.workspaceRoot,
    currentProvenance: provenance,
    now: Date.parse('2026-08-10T10:01:00.000Z'),
    authorityResolver: () => fixture.resolved,
  });
  assert.deepEqual(checked.issues, []);
  assert.equal(checked.summary.acceptedCueCount, 8);
  assert.equal(checked.summary.captureBackend, 'wasapi-process-exclusion');
});

test('arbitrary JSON and an old runtime authority cannot become real-device evidence', () => {
  const root = temporaryRoot('forged-json');
  writeJson(path.join(root, 'real-device-audio-probe.json'), {
    productionMode: true,
    passed: true,
  });
  const arbitrary = validateRealDeviceAudioEvidence(root, {
    workspaceRoot: root,
    currentProvenance: provenance,
    authorityResolver: () => { throw new Error('must not be reached'); },
  });
  assert.match(arbitrary.issues.join('\n'), /artifact set|required .* is missing/);

  const fixture = buildAuthorizedFixture();
  const packageRoot = temporaryRoot('old-runtime-package');
  for (const artifact of REAL_DEVICE_AUDIO_ARTIFACTS) {
    const candidate = path.join(packageRoot, artifact.path);
    if (artifact.kind === 'directory') ensureDir(candidate);
    else writeText(candidate, '{}\n');
  }
  const oldRuntime = validateRealDeviceAudioEvidence(packageRoot, {
    workspaceRoot: fixture.workspaceRoot,
    currentProvenance: provenance,
    authorityResolver: () => { throw new Error('strict authority runtime binary hashes do not match the current release build'); },
  });
  assert.match(oldRuntime.issues.join('\n'), /runtime binary hashes do not match/);
});

test('wrong endpoint, missing WAV, hash tampering, and skip markers fail closed', async () => {
  const fixture = buildAuthorizedFixture();
  const plan = buildPlan(fixture, 'assembled-negative');
  await runRealDeviceAudioReleaseEvidence({
    plan,
    authorityResolver: () => fixture.resolved,
    collectEvidence: async () => ({ packageDirectory: 'package', manifestPath: 'manifest' }),
    now: () => new Date('2026-08-10T10:01:00.000Z'),
  });
  const validate = () => validateRealDeviceAudioEvidence(plan.runDirectory, {
    workspaceRoot: fixture.workspaceRoot,
    currentProvenance: provenance,
    now: Date.parse('2026-08-10T10:01:00.000Z'),
    authorityResolver: () => fixture.resolved,
  }).issues.join('\n');

  const devicePath = path.join(plan.runDirectory, 'cell-raw', 'physical-playback-device.json');
  const originalDevice = fs.readFileSync(devicePath);
  writeJson(devicePath, {
    ...JSON.parse(originalDevice.toString('utf8')),
    resolvedDeviceId: '{wrong-endpoint}',
  });
  assert.match(validate(), /physical-playback-device\.json does not match/);
  fs.writeFileSync(devicePath, originalDevice);

  const wavPath = path.join(plan.runDirectory, 'real-device-audio.wav');
  const originalWav = fs.readFileSync(wavPath);
  fs.rmSync(wavPath);
  assert.match(validate(), /required physical-output-wav is missing/);
  fs.writeFileSync(wavPath, originalWav);
  fs.appendFileSync(wavPath, Buffer.from([0]));
  assert.match(validate(), /does not hash-match/);
  fs.writeFileSync(wavPath, originalWav);

  const evidencePath = path.join(plan.runDirectory, 'real-device-audio-probe.json');
  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  writeJson(evidencePath, { ...evidence, skipped: true });
  assert.match(validate(), /identity\/selected cell is invalid|hash-bound/);
});

test('short session and failed translation route are rejected before assembly', async () => {
  for (const fixture of [
    buildAuthorizedFixture({ durationMs: 120_000 }),
    buildAuthorizedFixture({ failedPlayback: true }),
  ]) {
    const plan = buildPlan(fixture);
    await assert.rejects(
      runRealDeviceAudioReleaseEvidence({
        plan,
        authorityResolver: () => fixture.resolved,
        collectEvidence: async () => ({ packageDirectory: 'package', manifestPath: 'manifest' }),
      }),
      /budget-approved pairwise-live session|zero route failures/,
    );
    assert.equal(fs.existsSync(plan.runDirectory), false);
  }
});
