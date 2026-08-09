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

export const healthyPhysicalOutputContent = {
  passed: true,
  source: '你好世界',
  translation: '你好世界',
  subtitleText: '你好世界',
  recording: {
    passed: true,
    recordingPath: 'physical-output-recording.wav',
    transcriptionPcmPath: 'physical-output-recording-16k-mono.pcm',
    capturedFrames: 96000,
    rms: 0.08,
  },
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
    contentConsistency: {
      passed: true,
      combinedEvidence: { passed: true },
    },
    ...overrides,
  };
}

// Mirrors the unified bridge log line format emitted by omni-logging:
// `{timestamp} [{LEVEL}] [bridge] {source} - {message}`, including the
// trailing ` sid=<value>` session token every line now carries.
export const healthyBridgeLog = '2026-01-01 00:00:00.000 [NORMAL] [bridge] - - source pacer summary: releasedFrames=12 queuedFrames=0 pendingBytes=0 underruns=0 droppedFrames=0 driverBufferedBytes=0 driverDroppedBytes=0 monitorQueuedFrames=0 staleSourceFramesDropped=0 sid=bridge-0198testsid-1000';
export const healthyAppLog = [
  'watch_mode.omni_preconnect_started detail=direction=inbound sid=0198testsid',
  'watch_mode.omni_preconnect_reused detail=direction=inbound sid=0198testsid',
  'watch_mode.omni_session_config | model=test-model realtimeAudioMode=server_vad outputMode=text-and-audio inputAudioFormat=pcm16 isLivetranslate=false subtitleTranslateActive=false sid=0198testsid',
  '[AUDIO] playback request received: cue_id=omni-audio-test samples=24000 sample_rate_hz=24000 duration_ms=1000 enabled=true local_playback=true virtual_mic=false sid=0198testsid',
  '[AUDIO] speaker playback completed: cue_id=omni-audio-test frames=24000 sample_rate_hz=24000 sid=0198testsid',
  'event=echo_cancel_summary | direction=inbound subtractCount=100 intervalChunks=100 alignedChunks=92 alignmentRatePct=92.0 aecSuppressedChunks=12 intervalAecSuppressedChunks=12 avgPureEchoRemovedDb=20.0 playbackActiveChunks=90 effectiveSuppressedChunks=12 refBufferDepthSamples=96000 refBufferEmpty=false avgPreDb=-40.0 avgPostDb=-60.0 avgRemovedDb=20.0 avgCorrelation=0.91 maxCorrelation=0.96 avgDelayMs=125.0 avgResidualDb=-62.0 sid=0198testsid',
  'watch route ensured subtitle overlay visible detail=label=subtitle-overlay visible=true sid=0198testsid',
  'subtitle cue appended id=cue-1 sid=0198testsid',
  'model_trace finished status=ok elapsedMs=1200 sid=0198testsid',
].join('\n');

export function classify(overrides = {}) {
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
    appLogText: healthyAppLog,
    ...overrides,
  });
}
