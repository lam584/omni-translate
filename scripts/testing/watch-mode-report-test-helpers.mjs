// Shared fixtures for the watch-mode-report test suite. The suite is split by
// theme across watch-mode-report-*.test.mjs files (all imported by the
// package.json entry watch-mode-report.test.mjs); every file builds its
// evidence from the same healthy baseline so a single failing layer is the
// only difference under test.
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

export const testMediaReferenceTranslation = [
  '这是 Omni Translate 项目的原创音频测试素材',
  '极光项目拥有十亿美元的可靠性基金',
  '第一个研究站计划建在火星上',
  '它的建设预算是五亿美元',
  '研究站内的人工生物圈维持空气、水和植物的平衡',
  '研究团队还研究保护濒危物种的方法',
  '工程师正在测试用于偏远地点之间安全出行的飞行汽车',
  '一个一美元的灯泡用于验证较小的价格仍能准确翻译',
  '每个句子都清晰分隔，以便测量翻译时间',
  '原创音频测试素材现已播放完毕',
].join('\n');

export function strictTestMediaContent(overrides = {}) {
  return {
    ...healthyPhysicalOutputContent,
    sourceReference: {
      passed: true,
      mediaSha256: '7fd64ecd6cf0762cac5ac0ab16eba37cc733765c55cc8264f87a94cb46962131',
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
    provider: healthyProvider,
    bridgeLogText: healthyBridgeLog,
    appLogText: healthyAppLog,
    ...overrides,
  });
}
