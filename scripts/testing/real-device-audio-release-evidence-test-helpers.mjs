import fs from 'node:fs';
import path from 'node:path';

import { ensureDir, writeJson } from '../lib/testing-common.mjs';
import {
  REAL_DEVICE_AUDIO_SELECTED_CELL,
  fileReceipt,
} from './real-device-audio-release-evidence.mjs';
import { materializeRealDeviceAudioReleaseEvidence } from './run-real-device-audio-release-evidence.mjs';
import { requiredCellArtifactPaths } from './watch-mode-evidence-authority.mjs';

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

export function createRealDeviceAudioAuthorityFixture({
  workspaceRoot,
  provenance,
  generatedAt = '2026-08-10T09:30:00.000Z',
  durationMs = 180_000,
  failedPlayback = false,
  endpointId = '{0.0.0.00000000}.{physical-default}',
  endpointName = 'Speakers (Realtek Audio)',
} = {}) {
  if (!workspaceRoot || !provenance) {
    throw new Error('real-device authority fixture requires workspaceRoot and provenance');
  }
  const evidenceRoot = path.join(workspaceRoot, 'test-authority', 'watch-mode-live');
  const runDirectory = path.join(evidenceRoot, 'authorized-cell');
  ensureDir(runDirectory);
  const watch = watchReport({ durationMs });
  const report = {
    schemaVersion: 1,
    generatedAt,
    provenance,
    mode: 'live',
    verdict: 'passed',
    modelId: REAL_DEVICE_AUDIO_SELECTED_CELL.modelId,
    feedbackLoopPrevention: 'process-exclusion',
    deviceEvidence: {
      deviceClass: 'default-speaker',
      profileId: 'default-speaker',
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
    'steps.json': [
      { name: 'start desktop shell', ok: true, result: { pid: 1100 } },
      { name: 'start physical output content recording', ok: true, result: { pid: 1200 } },
    ],
    'physical-playback-device.json': {
      verified: true,
      fixtureOnly: false,
      profileId: 'default-speaker',
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
    'playback.json': {
      passed: true,
      playbackMode: 'wasapi-media-injector',
      injectorProcessId: 1300,
    },
    'snapshots.json': { feedbackLoopPrevention: 'process-exclusion' },
    'system-metrics.json': {
      artifactKind: 'watch-mode-system-metrics',
      samples: [{ pid: 1100 }],
    },
    'source-media-transcript.json': {
      passed: true,
      source: 'This is the original media transcript.',
    },
  };
  for (const [relativePath, value] of Object.entries(jsonFiles)) {
    writeJson(path.join(runDirectory, relativePath), value);
  }
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
    schemaVersion: 2,
    artifactKind: 'watch-mode-live-cell-authority',
    generatedAt: '2026-08-10T09:35:00.000Z',
    provenance,
    matrixCell: REAL_DEVICE_AUDIO_SELECTED_CELL,
    artifacts: requiredPaths.map((relativePath) => ({
      path: relativePath,
      ...fileReceipt(path.join(runDirectory, ...relativePath.split('/'))),
    })),
  };
  const receiptPath = path.join(runDirectory, 'matrix-cell-authority.json');
  writeJson(receiptPath, receipt);
  const manifest = {
    schemaVersion: 3,
    artifactKind: 'watch-mode-strict-matrix-authority',
    strict: true,
    evidenceMode: 'live',
    verification: 'passed',
    generatedAt: '2026-08-10T09:40:00.000Z',
    verifiedAt: '2026-08-10T09:41:00.000Z',
    provenance,
    verificationProvenance: provenance,
    cells: [{
      ...REAL_DEVICE_AUDIO_SELECTED_CELL,
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
    cell: REAL_DEVICE_AUDIO_SELECTED_CELL,
    cellIndex: 0,
    runDirectory,
    report,
    receiptPath,
    receipt,
    strict: { ok: true },
    authority: {},
  };
  return {
    evidenceRoot,
    runDirectory,
    manifestPath,
    resolved,
    authorityResolver: () => resolved,
  };
}

export function materializeRealDeviceAudioRawFixture({
  rawDirectory,
  workspaceRoot,
  provenance,
  now = new Date('2026-08-10T10:00:00.000Z'),
} = {}) {
  if (fs.existsSync(rawDirectory)) {
    if (fs.readdirSync(rawDirectory).length > 0) {
      throw new Error(`real-device raw fixture directory must be empty: ${rawDirectory}`);
    }
    fs.rmdirSync(rawDirectory);
  }
  const authority = createRealDeviceAudioAuthorityFixture({ workspaceRoot, provenance });
  const plan = {
    workspaceRoot,
    provenance,
    canonicalManifestPath: authority.manifestPath,
    runDirectory: rawDirectory,
    maxAgeDays: 14,
    startedAt: now.toISOString(),
    invocationId: '11111111-1111-7111-8111-111111111111',
  };
  materializeRealDeviceAudioReleaseEvidence({
    plan,
    resolved: authority.resolved,
    completedAt: now.toISOString(),
  });
  return authority;
}
