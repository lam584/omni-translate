// Shared fixtures for the watch-mode-report test suite. The suite is split by
// theme across watch-mode-report-*.test.mjs files (all imported by the
// package.json entry watch-mode-report.test.mjs); every file builds its
// evidence from the same healthy baseline so a single failing layer is the
// only difference under test.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyWatchModeRun } from './watch-mode-report.mjs';

export const healthyDriver = {
  Endpoint: 'Omni Translate Virtual Speaker',
  RootDeviceStatus: 'OK',
  AbiVersion: '0x20260602',
  CapturedBytes: 384000,
  DeliveredBytes: 384000,
  DroppedBytes: 0,
};

export const healthyWasapi = {
  ToneFrames: 48000,
  TonePeak: 0.5,
  ToneRms: 0.2,
  InvalidSamples: 0,
};

export const healthyBridge = {
  bridgeState: 'running',
  driverHealth: 'running',
  sourceSubscriberActive: true,
  sourceReadCalls: 12,
  droppedFrameCount: 0,
};

export const healthyProcessExclusionBridge = {
  bridgeState: 'running',
  driverHealth: 'not-installed',
  sourceCaptureMode: 'process-exclusion',
  captureBackend: 'wasapi-process-exclusion',
  processLoopbackSupported: true,
  processLoopbackStatus: 'ready',
  windowsBuildNumber: 26100,
  processLoopbackMinimumWindowsBuild: 20348,
  excludedProcessId: 4242,
  processLoopbackFailureDetail: null,
  sourceSubscriberActive: false,
  sourceReadCalls: 0,
  sourceFramePayloadBytes: 0,
  droppedFrameCount: 0,
};

export const healthyApp = {
  routeState: 'capturing',
  overlayVisible: true,
  subtitleCueCount: 2,
};

export const healthyWatchSessionReport = {
  sessionId: 'watch-test-session',
  status: 'completed',
  routeMode: 'watch',
  providerId: 'test-provider',
  model: 'test-model',
  summary: {
    cueCount: 1,
    completeCueCount: 1,
    visibleRenderCueCount: 1,
    unrenderedCueCount: 0,
    issueCount: 0,
  },
  cues: [{
    cueId: 'cue-1',
    sourceText: fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'watch-mode-en-original.txt'),
      'utf8',
    ).trim(),
    comparisonStatus: 'exact',
    llmFirstAtMs: 100,
    publishedFirstAtMs: 140,
    renderedFirstAtMs: 156,
    llmFirstToRenderMs: 56,
    publishToRenderMs: 16,
    issues: [],
  }],
  issues: [],
};

export const healthyProvider = {
  totalCalls: 2,
  failedCalls: 0,
};

export const healthyPhysicalOutput = {
  passed: true,
  physicalPlaybackDeviceId: 'default',
  resolvedPhysicalPlaybackDeviceId: 'real-speaker-1',
  resolvedPhysicalPlaybackDeviceName: 'Real Speakers',
  playbackFramesWrittenBefore: 0,
  playbackFramesWrittenAfter: 96000,
  capturedFrames: 96000,
  rms: 0.08,
  toneComponent: 0.07,
  invalidSamples: 0,
};

export const healthyProcessExclusionFingerprint = {
  ...healthyPhysicalOutput,
  status: 'passed',
  probeKind: 'process-exclusion-fingerprint',
  processExclusionFingerprint: {
    bridgeProcessId: 4242,
    excludedProcessId: 4242,
    externalPlayerProcessId: 5001,
    bridgeChildPlayerProcessId: 5002,
    bridgeChildParentProcessId: 4242,
    bridgeChildExitCode: 0,
    sourceCaptureMode: 'process-exclusion',
    captureBackend: 'wasapi-process-exclusion',
    processLoopbackStatus: 'ready',
    translationFrequencyHz: 997,
    externalFrequencyHz: 1733,
    bridgeChildFrequencyHz: 2449,
    physicalTranslationComponent: 0.08,
    physicalExternalComponent: 0.16,
    physicalBridgeChildComponent: 0.16,
    sourceTranslationComponent: 0.0004,
    sourceExternalComponent: 0.15,
    sourceBridgeChildComponent: 0.0002,
    sourceToPhysicalTranslationRatio: 0.005,
    sourceTranslationToExternalRatio: 0.0027,
    sourceToPhysicalBridgeChildRatio: 0.00125,
    sourceCapturedFrames: 134400,
    sourceRms: 0.19,
    translationComponentLimit: 0.003,
    sourceToPhysicalRatioLimit: 0.05,
    sourceToExternalRatioLimit: 0.05,
  },
};

export const healthyPhysicalOutputContent = {
  passed: true,
  source: '你好世界',
  translation: '你好世界',
  subtitleText: '你好世界',
  sourceReference: {
    passed: true,
    source: '你好世界',
    translation: '',
  },
  recording: {
    passed: true,
    recordingPath: 'physical-output-recording.wav',
    transcriptionPcmPath: 'physical-output-recording-16k-mono.pcm',
    capturedFrames: 96000,
    rms: 0.08,
  },
  translatedSpeech: { queuedSegments: 1, playedSegments: 1 },
  mixedOutput: { rms: 0.08, peak: 0.3 },
};

export const testMediaReferenceTranslation = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'watch-mode-en-original.zh-CN.txt'),
  'utf8',
).trim();

export function strictTestMediaContent(overrides = {}) {
  return {
    ...healthyPhysicalOutputContent,
    sourceReference: {
      passed: true,
      source: '你好世界',
      translation: testMediaReferenceTranslation,
      mediaSha256: 'cf4990ecdc23622d12de3e62adad442755c9e84c4612787798655ee00c85fb2f',
      mediaPath: 'scripts/testing/fixtures/watch-mode-en-original.wav',
      playbackSeconds: null,
      fullMedia: true,
    },
    translation: testMediaReferenceTranslation,
    subtitleText: testMediaReferenceTranslation,
    segmentTranslationText: testMediaReferenceTranslation,
    subtitleQueue: {
      finalWriteCount: 8,
      queuedSegmentCount: 8,
      playedSegmentCount: 8,
    },
    translatedSpeech: {
      passed: true,
      queuedSegments: 8,
      playedSegments: 8,
      transcriptChars: testMediaReferenceTranslation.length,
    },
    originalPassthrough: { passed: true, transcriptChars: 160 },
    mixedOutput: { passed: true, rms: 0.08, peak: 0.3 },
    ...overrides,
  };
}

// Mirrors the unified bridge log line format emitted by omni-logging:
// `{timestamp} [{LEVEL}] [bridge] {source} - {message}`, including the
// trailing ` sid=<value>` session token every line now carries.
export const healthyBridgeLog = '2026-01-01 00:00:00.000 [NORMAL] [bridge] - - source pacer summary: releasedFrames=12 queuedFrames=0 pendingBytes=0 underruns=0 droppedFrames=0 driverBufferedBytes=0 driverDroppedBytes=0 monitorQueuedFrames=0 staleSourceFramesDropped=0 sid=bridge-0198testsid-1000';
export const healthyAppLog = [
  'event=echo_cancel_reset | direction=inbound reason=route-start',
  'watch_mode.omni_preconnect_started detail=direction=inbound sid=0198testsid',
  'watch_mode.omni_preconnect_reused detail=direction=inbound sid=0198testsid',
  'watch_mode.omni_session_config | model=test-model realtimeAudioMode=server_vad outputMode=text-and-audio inputAudioFormat=pcm16 isLivetranslate=false subtitleTranslateActive=false sid=0198testsid',
  '[AUDIO] playback request received: cue_id=omni-audio-test samples=24000 sample_rate_hz=24000 duration_ms=1000 enabled=true local_playback=true virtual_mic=false sid=0198testsid',
  '[AUDIO] speaker playback completed: cue_id=omni-audio-test frames=24000 sample_rate_hz=24000 sid=0198testsid',
  'event=echo_cancel_backend | backend=webrtc-aec3 frameMs=10 renderSubmitFormat=48000-f32-stereo renderClock=wasapi-submit-position endpointRenderPadding=same-client-get-current-padding webRtcAec3Ready=true msvcBuildVerified=true linkedBackendPresent=true fixtureVerified=true sid=0198testsid',
  'event=echo_cancel_summary | direction=inbound final=false backend=webrtc-aec3 render10msFrames=50 capture10msFrames=50 processedCapture10msFrames=50 resetCount=1 rejectedFrames=0 statsReadFailures=0 renderUnderruns=0 captureUnderruns=0 erleDb=10.0 residualEchoLikelihood=0.08 reportedDelayMs=0 doubleTalkFrames=0 avgProcessingUs=110.0 maxProcessingUs=230 captureChunks=50 intervalCaptureChunks=50 playbackActiveChunks=40 asrForwardedChunks=50 asrDeletedChunks=0 avgPreDb=-40.0 avgPostDb=-50.0 avgRemovedDb=10.0 sid=0198testsid',
  'event=echo_cancel_summary | direction=inbound final=true backend=webrtc-aec3 render10msFrames=100 capture10msFrames=100 processedCapture10msFrames=100 resetCount=1 rejectedFrames=0 statsReadFailures=0 renderUnderruns=0 captureUnderruns=0 erleDb=20.0 residualEchoLikelihood=0.02 reportedDelayMs=125 doubleTalkFrames=12 avgProcessingUs=120.0 maxProcessingUs=250 captureChunks=100 intervalCaptureChunks=100 playbackActiveChunks=90 asrForwardedChunks=100 asrDeletedChunks=0 avgPreDb=-40.0 avgPostDb=-60.0 avgRemovedDb=20.0 sid=0198testsid',
  'event=aec_live_scenario_stage status=completed cueId=cue-1 stage=double-talk ordinal=1 delayMs=0 nonlinearity=none referenceFrames=4800 physicalFrames=4800 changedSamples=0 changedRatio=0.000000 started=true completed=true startedAtMs=1000000 completedAtMs=1000100 source=runtime-physical-render playbackSource=native-omni',
  'event=aec_live_scenario_stage status=completed cueId=cue-2 stage=dynamic-delay ordinal=2 delayMs=80 nonlinearity=none referenceFrames=4800 physicalFrames=8640 changedSamples=0 changedRatio=0.000000 started=true completed=true startedAtMs=1000200 completedAtMs=1000300 source=runtime-physical-render playbackSource=native-omni',
  'event=aec_live_scenario_stage status=completed cueId=cue-3 stage=nonlinear ordinal=3 delayMs=160 nonlinearity=soft-clip referenceFrames=4800 physicalFrames=12480 changedSamples=9600 changedRatio=1.000000 started=true completed=true startedAtMs=1000400 completedAtMs=1000500 source=runtime-physical-render playbackSource=native-omni',
  'watch route ensured subtitle overlay visible detail=label=subtitle-overlay visible=true sid=0198testsid',
  'subtitle cue appended id=cue-1 sid=0198testsid',
  'model_trace finished status=ok elapsedMs=1200 sid=0198testsid',
].join('\n');

export const healthyProcessExclusionRestartLog = [
  'event=process_exclusion_restart_started status=started oldBridgeProcessId=4242 restartTriggeredAtUnixMs=1000000',
  'event=process_exclusion_restart_summary status=passed startedAtUnixMs=999000 oldBridgeProcessId=4242 newBridgeProcessId=4343 oldBridgeInstanceId=instance-old newBridgeInstanceId=instance-new oldSessionId=session-old newSessionId=session-new oldSourceGeneration=101 newSourceGeneration=202 oldSourceGenerationToken=token-old newSourceGenerationToken=token-new oldPlaybackOwnerGeneration=1001 newPlaybackOwnerGeneration=2002 oldPhysicalPlaybackDeviceId={hda-test-endpoint} newPhysicalPlaybackDeviceId={hda-test-endpoint} physicalPlaybackStatus=ready physicalPlaybackRebindDurationMs=200 oldLastFrameTimestampMs=1000100 oldLastFrameReadTimestampMs=1000150 newFirstFrameTimestampMs=1000300 newFirstFrameReadTimestampMs=1000350 restartTriggeredAtUnixMs=1000200 recoveredAtUnixMs=1000400 downtimeMs=200 sourceFramesBefore=1000 sourceFramesAfter=2000 oldFramesAfterRestart=0 oldFrameRejectedCount=0 excludedProcessId=4343 processLoopbackStatus=ready captureBackend=wasapi-process-exclusion sourceSubscriberActive=true',
].join('\n');

export const healthySystemMetrics = {
  schemaVersion: 1,
  artifactKind: 'watch-mode-system-metrics',
  collector: 'scripts/testing/collect-watch-mode-system-metrics.ps1',
  rootProcessId: 4000,
  scope: 'process-tree',
  sampleIntervalMs: 1000,
  startedAt: '1970-01-01T00:16:39.000Z',
  finishedAt: '1970-01-01T00:16:42.000Z',
  completionReason: 'root-process-exited',
  sampleCount: 3,
  collectionErrors: [],
  samples: [
    { timestamp: '1970-01-01T00:16:39.000Z', elapsedMs: 0, bridgeProcessIds: [4242] },
    { timestamp: '1970-01-01T00:16:40.000Z', elapsedMs: 1000, bridgeProcessIds: [] },
    { timestamp: '1970-01-01T00:16:41.000Z', elapsedMs: 2000, bridgeProcessIds: [4343] },
  ],
};

export const healthyAecPlayback = {
  playbackMode: 'wasapi-media-injector',
  sourceGainDb: -5,
  postrollSilenceFrames: 144000,
  postrollSilenceSeconds: 3,
  mediaPath: 'scripts/testing/fixtures/watch-mode-en-original.wav',
  mediaSha256: 'cf4990ecdc23622d12de3e62adad442755c9e84c4612787798655ee00c85fb2f',
  processId: 5001,
  startedAtMs: 999900,
  finishedAtMs: 1000600,
};

export function classify(overrides = {}) {
  const feedbackLoopPrevention = overrides.feedbackLoopPrevention ?? 'virtual-driver';
  return classifyWatchModeRun({
    mode: 'live',
    driver: healthyDriver,
    wasapi: healthyWasapi,
    bridge: healthyBridge,
    physicalOutput: healthyPhysicalOutput,
    physicalOutputContent: healthyPhysicalOutputContent,
    app: healthyApp,
    watchSessionReport: healthyWatchSessionReport,
    provider: healthyProvider,
    bridgeLogText: healthyBridgeLog,
    appLogText: feedbackLoopPrevention === 'process-exclusion'
      ? [healthyAppLog, healthyProcessExclusionRestartLog].join('\n')
      : healthyAppLog,
    playback: feedbackLoopPrevention === 'echo-cancel' ? healthyAecPlayback : null,
    systemMetrics: feedbackLoopPrevention === 'process-exclusion' ? healthySystemMetrics : null,
    ...overrides,
  });
}
