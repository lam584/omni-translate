import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  classifyWatchModeRun,
  evaluateStrictContent,
  parseBridgeLog,
  renderMarkdownReport,
  writeReport,
} from './watch-mode-report.mjs';

const healthyDriver = {
  Endpoint: 'Omni Translate Virtual Speaker',
  RootDeviceStatus: 'OK',
  AbiVersion: '0x20260602',
  CapturedBytes: 384000,
  DeliveredBytes: 384000,
  DroppedBytes: 0,
};

const healthyWasapi = {
  ToneFrames: 48000,
  TonePeak: 0.5,
  ToneRms: 0.2,
  InvalidSamples: 0,
};

const healthyBridge = {
  bridgeState: 'running',
  driverHealth: 'running',
  sourceSubscriberActive: true,
  sourceReadCalls: 12,
  droppedFrameCount: 0,
};

const healthyApp = {
  routeState: 'capturing',
  overlayVisible: true,
  subtitleCueCount: 2,
};

const healthyProvider = {
  totalCalls: 2,
  failedCalls: 0,
};

const healthyPhysicalOutput = {
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

const healthyPhysicalOutputContent = {
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

const testMediaReferenceTranslation = [
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

function strictTestMediaContent(overrides = {}) {
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
const healthyBridgeLog = '2026-01-01 00:00:00.000 [NORMAL] [bridge] - - source pacer summary: releasedFrames=12 queuedFrames=0 pendingBytes=0 underruns=0 droppedFrames=0 driverBufferedBytes=0 driverDroppedBytes=0 monitorQueuedFrames=0 staleSourceFramesDropped=0 sid=bridge-0198testsid-1000';
const healthyAppLog = [
  'watch_mode.omni_preconnect_started detail=direction=inbound sid=0198testsid',
  'watch_mode.omni_preconnect_reused detail=direction=inbound sid=0198testsid',
  'watch route ensured subtitle overlay visible detail=label=subtitle-overlay visible=true sid=0198testsid',
  'subtitle cue appended id=cue-1 sid=0198testsid',
  'model_trace finished status=ok elapsedMs=1200 sid=0198testsid',
].join('\n');

function classify(overrides = {}) {
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

test('classifies healthy watch-mode evidence as passed', () => {
  const report = classify();

  assert.equal(report.verdict, 'passed');
  assert.equal(report.failureLayer, null);
  assert.equal(report.suspectFiles.length, 0);
});

test('surfaces bridge source probe diagnostics before generic bridge counters', () => {
  const report = classify({
    bridge: {
      probePassed: false,
      error: 'bridge source probe failed during source_frame: timed out waiting for a bridge.source.frame',
      phase: 'source_frame',
      pipeName: 'omni-watch-mode-probe-1234',
      sourcePipeName: 'omni-watch-mode-probe-1234-source',
    },
  });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'bridge');
  assert.match(report.failureReason, /bridge source frame probe failed/);
  assert.match(report.failureReason, /source_frame/);
});

test('native route does not require secondary segment TTS evidence', () => {
  const report = classify({
    translationRoute: 'native',
    appLogText: healthyAppLog,
  });

  assert.equal(report.verdict, 'passed');
  assert.equal(report.translationRoute, 'native');
  assert.equal(report.layers.speechSegmentation.status, 'passed');
});

test('secondary route requires final segment TTS playback evidence', () => {
  const report = classify({
    translationRoute: 'secondary',
    appLogText: healthyAppLog,
  });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'speechSegmentation');
  assert.match(report.failureReason, /segment TTS/i);
});

test('secondary route passes with segment TTS playback evidence', () => {
  const report = classify({
    translationRoute: 'secondary',
    appLogText: [
      healthyAppLog,
      'speech.segment_tts_queued | cue=cue-1 segmentIndex=0 segmentMode=true sourceChars=12 translatedChars=6',
      'speech.segment_tts_requested | cue=cue-1 segmentIndex=0 translatedChars=6 provider=provider model=tts',
      'speech.segment_playback_written | cue=cue-1 segmentIndex=0 frames=24000 sampleRateHz=24000 channels=1 outputLevel=50 deviceId=real-speaker',
    ].join('\n'),
  });

  assert.equal(report.verdict, 'passed');
  assert.equal(report.translationRoute, 'secondary');
  assert.equal(report.layers.speechSegmentation.data.queuedSegments, 1);
});

test('secondary route fails when Omni preconnect reuse evidence is missing', () => {
  const report = classify({
    translationRoute: 'secondary',
    appLogText: [
      'watch_mode.omni_preconnect_started detail=direction=inbound',
      'watch route ensured subtitle overlay visible detail=label=subtitle-overlay visible=true',
      'subtitle cue appended id=cue-1',
      'model_trace finished status=ok elapsedMs=1200',
      'speech.segment_tts_queued | cue=cue-1 segmentIndex=0 segmentMode=true sourceChars=12 translatedChars=6',
      'speech.segment_playback_written | cue=cue-1 segmentIndex=0 frames=24000 sampleRateHz=24000 channels=1 outputLevel=50 deviceId=real-speaker',
    ].join('\n'),
  });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'app');
  assert.match(report.failureReason, /reuse the Omni preconnect/i);
});

test('native fallback log classifies route as native and does not require secondary segment TTS', () => {
  const report = classify({
    translationRoute: 'secondary',
    appLogText: [
      healthyAppLog,
      'watch_mode.subtitle_translate_config_failed detail=phase=route subtitleTranslationMode=secondary fallback=native reason=provider_not_found',
      'watch_mode.subtitle_translate_fallback_native_applied detail=reason=provider_unresolved translationAudioSource=omni-native',
    ].join('\n'),
  });

  assert.equal(report.verdict, 'passed');
  assert.equal(report.translationRoute, 'native');
  assert.equal(report.layers.speechSegmentation.status, 'passed');
});

test('classifies silent physical output after bridge success', () => {
  const report = classify({
    physicalOutput: {
      ...healthyPhysicalOutput,
      passed: false,
      rms: 0,
      toneComponent: 0,
      detail: 'physical output RMS 0.000000 is below 0.015000',
    },
  });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'physicalOutput');
  assert.match(report.failureReason, /physical output/i);
});

test('classifies physical output content that does not match subtitles', () => {
  const report = classify({
    physicalOutputContent: {
      ...healthyPhysicalOutputContent,
      source: '完全不同的内容',
      translation: '完全不同的内容',
      subtitleText: '你好世界',
    },
  });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'physicalOutputContent');
  assert.match(report.failureReason, /did not match subtitle/i);
});

test('classifies clipped physical output recording as content failure', () => {
  const report = classify({
    physicalOutputContent: {
      ...healthyPhysicalOutputContent,
      audioQuality: {
        passed: false,
        clippingRatio: 0.025,
        peak: 1,
        detail: 'physical output recording is clipped: clippingRatio=0.025 peak=1',
      },
    },
  });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'physicalOutputContent');
  assert.match(report.failureReason, /clipped/);
});

test('classifies subtitle queue final translation order inversions as app failure', () => {
  const report = classify({
    app: {
      ...healthyApp,
      subtitleQueue: {
        eventCount: 8,
        cueOrderInversions: 1,
        duplicateFinalTranslations: 0,
      },
    },
  });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'app');
  assert.match(report.failureReason, /out of cue order/);
});

test('classifies any duplicate final translation as app failure', () => {
  const report = classify({
    app: {
      ...healthyApp,
      subtitleQueue: {
        eventCount: 8,
        cueOrderInversions: 0,
        duplicateFinalTranslations: 1,
      },
    },
  });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'app');
  assert.match(report.failureReason, /duplicate final translations/);
});

test('echo-cancel variant skips virtual-driver evidence layers and passes on healthy app evidence', () => {
  const report = classify({
    feedbackLoopPrevention: 'echo-cancel',
    bridge: {
      bridgeState: 'running',
      driverHealth: 'running',
      sourceSubscriberActive: false,
      sourceReadCalls: 0,
      droppedFrameCount: 0,
    },
    physicalOutput: {
      ...healthyPhysicalOutput,
      passed: false,
      rms: 0,
      toneComponent: 0,
    },
  });

  assert.equal(report.verdict, 'passed');
  assert.equal(report.failureLayer, null);
  assert.equal(report.feedbackLoopPrevention, 'echo-cancel');
  for (const layer of ['bridge', 'physicalOutput', 'physicalOutputContent', 'speechSegmentation', 'strictContent']) {
    assert.equal(report.layers[layer].status, 'skipped');
  }
  assert.equal(report.layers.driver.status, 'passed');
  assert.equal(report.layers.app.status, 'passed');
  assert.equal(report.layers.provider.status, 'passed');
});

test('echo-cancel variant keeps the duplicate final translation detector as a failing gate', () => {
  const report = classify({
    feedbackLoopPrevention: 'echo-cancel',
    app: {
      ...healthyApp,
      subtitleQueue: {
        eventCount: 8,
        cueOrderInversions: 0,
        duplicateFinalTranslations: 1,
      },
    },
  });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'app');
  assert.match(report.failureReason, /duplicate final translations/);
  assert.equal(report.feedbackLoopPrevention, 'echo-cancel');
});

test('reports default to the virtual-driver variant and honor snapshots feedbackLoopPrevention', () => {
  assert.equal(classify().feedbackLoopPrevention, 'virtual-driver');

  const fromSnapshots = classify({ snapshots: { feedbackLoopPrevention: 'echo-cancel' } });
  assert.equal(fromSnapshots.feedbackLoopPrevention, 'echo-cancel');
  assert.equal(fromSnapshots.layers.strictContent.status, 'skipped');
});

test('classifies slow secondary subtitle first translation as app failure', () => {
  const report = classify({
    translationRoute: 'secondary',
    app: {
      ...healthyApp,
      subtitleQueue: {
        eventCount: 8,
        cueOrderInversions: 0,
        duplicateFinalTranslations: 0,
        firstVisibleTranslationLatencySeconds: 34,
        firstFinalTranslationLatencySeconds: 41,
      },
    },
  });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'app');
  assert.match(report.failureReason, /first visible subtitle translation latency/);
});

test('passes mixed physical output content when original and translated subchecks pass', () => {
  const report = classify({
    physicalOutputContent: {
      ...healthyPhysicalOutputContent,
      source: 'original game voice that does not match the translated subtitle',
      translation: '',
      subtitleText: '译音字幕',
      originalPassthrough: { passed: true, transcriptChars: 58 },
      translatedSpeech: { passed: true, playedSegments: 2, queuedSegments: 2, transcriptChars: 0 },
      mixedOutput: { passed: true, rms: 0.05, peak: 0.2 },
    },
  });

  assert.equal(report.verdict, 'passed');
  assert.equal(report.layers.physicalOutputContent.status, 'passed');
});

test('classifies low source similarity as physical output content failure', () => {
  const report = classify({
    physicalOutputContent: {
      ...healthyPhysicalOutputContent,
      originalPassthrough: {
        passed: false,
        transcriptChars: 120,
        sourceSimilarity: {
          passed: false,
          envelopeCorrelation: 0.12,
          levelRatio: 0.8,
          detail: 'physical output original passthrough does not resemble source media reference: correlation=0.12 levelRatio=0.8',
        },
      },
      translatedSpeech: { passed: true, playedSegments: 3, queuedSegments: 3 },
      mixedOutput: { passed: true, rms: 0.08, peak: 0.3 },
      contentConsistency: {
        passed: false,
        physicalTranscript: { passed: false, coverage: 0.2, missingClauses: ['source'] },
      },
    },
  });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'physicalOutputContent');
  assert.match(report.failureReason, /does not resemble source media reference/);
});

test('passes low PCM source similarity when transcript evidence covers the source media', () => {
  const report = classify({
    physicalOutputContent: {
      ...healthyPhysicalOutputContent,
      originalPassthrough: {
        passed: false,
        transcriptChars: 120,
        sourceSimilarity: {
          passed: false,
          envelopeCorrelation: 0.2939,
          levelRatio: 1.0187,
          detail: 'physical output original passthrough does not resemble source media reference: correlation=0.2939 levelRatio=1.0187',
        },
      },
      translatedSpeech: { passed: true, playedSegments: 1, queuedSegments: 1 },
      mixedOutput: { passed: true, rms: 0.13, peak: 0.76 },
      contentConsistency: {
        passed: true,
        coverage: 1,
        lengthRatio: 1.005,
        missingClauses: [],
        extraClauses: [],
        physicalTranscript: { passed: true, coverage: 1, missingClauses: [] },
      },
    },
  });

  assert.equal(report.verdict, 'passed');
  assert.equal(report.layers.physicalOutputContent.status, 'passed');
});

test('passes mixed physical output content when it matches the source media reference', () => {
  const report = classify({
    physicalOutputContent: {
      ...healthyPhysicalOutputContent,
      source: '一个新家，一个五亿美元的生物圈。发生什么事了？未来汽车可以带你去任何地方。',
      translation: '一个价值五亿美元的生物圈。未来汽车能带你去任何地方。',
      originalPassthrough: { passed: true, transcriptChars: 42 },
      translatedSpeech: { passed: true, playedSegments: 3, queuedSegments: 3, transcriptChars: 30 },
      mixedOutput: { passed: true, rms: 0.05, peak: 0.2 },
      sourceReference: {
        passed: true,
        source: '一个新家，一个五亿美元的生物圈。发生什么事了？未来汽车可以带你去任何地方。',
      },
      contentConsistency: {
        passed: true,
        coverage: 1,
        lengthRatio: 1.6,
        referenceClauseCount: 3,
        outputClauseCount: 5,
        missingClauses: [],
        extraClauses: [],
      },
    },
  });

  assert.equal(report.verdict, 'passed');
  assert.equal(report.layers.physicalOutputContent.status, 'passed');
});

test('classifies repeated or extra physical output content against the source reference', () => {
  const report = classify({
    physicalOutputContent: {
      ...healthyPhysicalOutputContent,
      source: '一个新家，一个五亿美元的生物圈。发生什么事了？未来汽车可以带你去任何地方。',
      translation: '我这边还是听不到任何声音，好像有点问题。你能再说一遍吗？我这边还是听不到任何声音，好像有点问题。你能再说一遍吗？',
      originalPassthrough: { passed: true, transcriptChars: 42 },
      translatedSpeech: { passed: true, playedSegments: 8, queuedSegments: 8, transcriptChars: 60 },
      mixedOutput: { passed: true, rms: 0.05, peak: 0.2 },
      sourceReference: {
        passed: true,
        source: '一个新家，一个五亿美元的生物圈。发生什么事了？未来汽车可以带你去任何地方。',
      },
      contentConsistency: {
        passed: false,
        coverage: 1,
        lengthRatio: 3.1,
        referenceClauseCount: 3,
        outputClauseCount: 9,
        missingClauses: [],
        extraClauses: ['我这边还是听不到任何声音', '好像有点问题', '你能再说一遍吗'],
      },
    },
  });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'physicalOutputContent');
  assert.match(report.failureReason, /diverged from source media reference/);
  assert.match(report.failureReason, /lengthRatio=3\.100/);
});

test('classifies failed combined physical and structured evidence as physical output content failure', () => {
  const report = classify({
    physicalOutputContent: {
      ...healthyPhysicalOutputContent,
      originalPassthrough: { passed: true, transcriptChars: 120 },
      translatedSpeech: { passed: true, playedSegments: 8, queuedSegments: 8, transcriptChars: 240 },
      mixedOutput: { passed: true, rms: 0.08, peak: 0.3 },
      contentConsistency: {
        passed: true,
        combinedEvidence: {
          passed: false,
          detail: 'combined physical transcript and structured subtitles disagree',
        },
      },
    },
  });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'physicalOutputContent');
  assert.match(report.failureReason, /combined physical transcript/);
});

test('preserves physical output translated speech detail in failure reason and diagnostics', () => {
  const report = classify({
    physicalOutputContent: {
      ...healthyPhysicalOutputContent,
      originalPassthrough: { passed: true, transcriptChars: 120 },
      translatedSpeech: {
        passed: false,
        error: 'TTS write failed: device unavailable',
        queuedSegments: 8,
        playedSegments: 0,
      },
      mixedOutput: { passed: true, rms: 0.08, peak: 0.3 },
    },
  });

  assert.equal(report.failureLayer, 'physicalOutputContent');
  assert.match(report.failureReason, /device unavailable/);
  assert.equal(report.diagnostics.evidence.physicalOutputContent.translatedSpeech.playedSegments, 0);
});

test('preserves physical output mixed-output detail in markdown', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-mode-report-physical-detail-'));
  const physicalOutputContent = {
    ...healthyPhysicalOutputContent,
    originalPassthrough: { passed: true, transcriptChars: 120 },
    translatedSpeech: { passed: true, queuedSegments: 8, playedSegments: 8 },
    mixedOutput: {
      passed: false,
      detail: 'mixed rms=0.001 peak=0.004',
      rms: 0.001,
      peak: 0.004,
    },
  };
  fs.writeFileSync(path.join(tempDir, 'snapshots.json'), JSON.stringify({
    driver: healthyDriver,
    wasapi: healthyWasapi,
    bridge: healthyBridge,
    physicalOutput: healthyPhysicalOutput,
    physicalOutputContent,
    app: healthyApp,
    provider: healthyProvider,
  }));
  fs.writeFileSync(path.join(tempDir, 'app.log'), healthyAppLog);
  fs.writeFileSync(path.join(tempDir, 'bridge-service.log'), healthyBridgeLog);

  const { report, reportMarkdownPath } = writeReport({ inputDir: tempDir, outputDir: tempDir, mode: 'live' });
  const markdown = fs.readFileSync(reportMarkdownPath, 'utf8');

  assert.equal(report.failureLayer, 'physicalOutputContent');
  assert.match(report.failureReason, /mixed rms=0\.001/);
  assert.match(markdown, /mixed rms=0\.001 peak=0\.004/);
});

test('strict reference-media content passes with full reference coverage and segment evidence', () => {
  const result = evaluateStrictContent({
    physicalOutputContent: strictTestMediaContent(),
    speechSegmentation: {
      queuedSegments: 8,
      playedSegments: 8,
    },
  });

  assert.equal(result.applicable, true);
  assert.equal(result.passed, true);
  assert.equal(result.coverage, 1);
  assert.equal(result.missingConcepts.length, 0);
});

test('strict reference-media content reuses passed combined physical evidence for coverage', () => {
  const structuredConceptOnly = [
    '十亿美元',
    '火星',
    '五亿美元',
    '人工生物圈',
    '濒危物种',
    '飞行汽车',
    '一美元的灯泡',
  ].join('\n');
  const result = evaluateStrictContent({
    physicalOutputContent: strictTestMediaContent({
      translation: structuredConceptOnly,
      subtitleText: structuredConceptOnly,
      segmentTranslationText: structuredConceptOnly,
      contentConsistency: {
        passed: true,
        combinedEvidence: {
          passed: true,
          coverage: 1,
          lengthRatio: 1.12,
          referenceClauseCount: 12,
          outputClauseCount: 12,
          missingClauses: [],
        },
        structuredEvidence: {
          passed: false,
          coverage: 0.58,
        },
      },
    }),
    speechSegmentation: {
      queuedSegments: 8,
      playedSegments: 8,
    },
  });

  assert.equal(result.passed, true);
  assert.equal(result.coverage, 1);
  assert.equal(result.structuredCoverage < 0.83, true);
  assert.equal(result.lengthRatio, 1.12);
  assert.equal(result.strictEvidenceSource, 'combinedPhysical');
});

test('strict reference-media content still fails when combined physical evidence fails', () => {
  const result = evaluateStrictContent({
    physicalOutputContent: strictTestMediaContent({
      contentConsistency: {
        passed: true,
        combinedEvidence: {
          passed: false,
          coverage: 1,
          lengthRatio: 1,
          detail: 'combined physical transcript and structured subtitles disagree',
        },
      },
    }),
    speechSegmentation: {
      queuedSegments: 8,
      playedSegments: 8,
    },
  });

  assert.equal(result.passed, false);
  assert(result.failures.some((reason) => /combined physical\/structured/.test(reason)));
});

test('strict reference-media content fails short 12 second evidence', () => {
  const report = classify({
    physicalOutputContent: strictTestMediaContent({
      sourceReference: {
        passed: true,
        mediaSha256: '7fd64ecd6cf0762cac5ac0ab16eba37cc733765c55cc8264f87a94cb46962131',
        mediaPath: 'scripts/testing/fixtures/watch-mode-en-original.wav',
        playbackSeconds: 12,
        fullMedia: false,
      },
    }),
    speechSegmentation: {
      queuedSegments: 8,
      playedSegments: 8,
      maxSourceChars: 60,
      maxTranslatedChars: 60,
    },
  });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'strictContent');
  assert.match(report.failureReason, /full-media playback/);
});

test('strict reference-media content fails key numeric mistranslation', () => {
  const result = evaluateStrictContent({
    physicalOutputContent: strictTestMediaContent({
      translation: testMediaReferenceTranslation.replace('十亿美元', '一亿美元'),
      subtitleText: testMediaReferenceTranslation.replace('十亿美元', '一亿美元'),
      segmentTranslationText: testMediaReferenceTranslation.replace('十亿美元', '一亿美元'),
    }),
    speechSegmentation: {
      queuedSegments: 8,
      playedSegments: 8,
    },
  });

  assert.equal(result.passed, false);
  assert(result.forbiddenErrors.some((item) => item.text === '一亿美元'));
});

test('strict reference-media content fails when only the opening translation is present', () => {
  const openingOnly = '这是一艘价值十亿美元的火箭飞船，一项未来科技，总有一天会带你一路前往火星，住进一个价值五亿美元的人工生物圈。';
  const result = evaluateStrictContent({
    physicalOutputContent: strictTestMediaContent({
      translation: openingOnly,
      subtitleText: openingOnly,
      segmentTranslationText: openingOnly,
      subtitleQueue: {
        finalWriteCount: 1,
        queuedSegmentCount: 1,
        playedSegmentCount: 1,
      },
      translatedSpeech: {
        passed: true,
        queuedSegments: 1,
        playedSegments: 1,
        transcriptChars: openingOnly.length,
      },
    }),
    speechSegmentation: {
      queuedSegments: 1,
      playedSegments: 1,
    },
  });

  assert.equal(result.passed, false);
  assert.match(result.failures.join('\n'), /coverage|queuedSegmentCount|playedSegmentCount/);
});

test('classifies strict reference-media failure with all strict failure reasons', () => {
  const openingOnly = '杩欐槸涓€鑹樹环鍊煎崄浜跨編鍏冪殑鐏椋炶埞';
  const report = classify({
    physicalOutputContent: strictTestMediaContent({
      translation: openingOnly,
      subtitleText: openingOnly,
      segmentTranslationText: openingOnly,
      subtitleQueue: {
        finalWriteCount: 1,
        queuedSegmentCount: 1,
        playedSegmentCount: 1,
      },
      translatedSpeech: {
        passed: true,
        queuedSegments: 1,
        playedSegments: 1,
        transcriptChars: openingOnly.length,
      },
    }),
    speechSegmentation: {
      queuedSegments: 1,
      playedSegments: 1,
    },
  });

  assert.equal(report.failureLayer, 'strictContent');
  assert(report.layers.strictContent.reasons.some((reason) => /coverage/.test(reason)));
  assert(report.layers.strictContent.reasons.some((reason) => /queuedSegmentCount=1/.test(reason)));
  assert(report.layers.strictContent.reasons.some((reason) => /playedSegmentCount=1/.test(reason)));
});

test('classifies missing physical output content recording as its own layer', () => {
  const report = classify({
    physicalOutputContent: null,
  });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'physicalOutputContent');
  assert.match(report.failureReason, /recording\/STT did not run/);
});

test('prioritizes physical output content failure over transient provider timeout', () => {
  const report = classify({
    physicalOutputContent: {
      ...healthyPhysicalOutputContent,
      passed: false,
      recording: {
        passed: false,
        capturedFrames: 0,
        rms: 0,
        detail: 'physical output recording captured only 0 frame(s)',
      },
    },
    provider: {
      totalCalls: 10,
      failedCalls: 1,
    },
    appLogText: [
      healthyAppLog,
      'provider.translate_text end_call | {"payload":{"error":"timeout: upstream request timed out","status":"failed"}}',
    ].join('\n'),
  });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'physicalOutputContent');
  assert.match(report.failureReason, /captured only 0 frame/);
});

test('keeps hard provider auth and quota failures ahead of physical output content', () => {
  const report = classify({
    physicalOutputContent: {
      ...healthyPhysicalOutputContent,
      passed: false,
      recording: {
        passed: false,
        capturedFrames: 0,
        rms: 0,
        detail: 'physical output recording captured only 0 frame(s)',
      },
    },
    appLogText: [
      healthyAppLog,
      'provider.translate_text end_call | {"payload":{"error":"HTTP 401 invalid api key","status":"failed"}}',
    ].join('\n'),
  });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'provider');
  assert.match(report.failureReason, /credential|rate-limit/);
});

test('classifies missing driver before higher layers', () => {
  const report = classify({
    driver: { error: 'Root\\OmniTranslateVirtualSpeaker endpoint was not found' },
    app: { routeState: 'idle', overlayVisible: false, subtitleCueCount: 0 },
    provider: { failedCalls: 1 },
  });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'driver');
  assert.match(report.failureReason, /endpoint/);
  assert(report.suspectFiles.some((file) => file.includes('drivers/windows-virtual-mic')));
});

test('classifies bridge queue failures with queue metrics', () => {
  const report = classify({
    bridge: {
      bridgeState: 'running',
      driverHealth: 'running',
      sourceSubscriberActive: true,
      sourceReadCalls: 12,
      droppedFrameCount: 0,
      sourceFramePayloadBytes: 3840,
    },
    bridgeLogText: 'source pacer summary: releasedFrames=12 queuedFrames=99 pendingBytes=384000 underruns=0 droppedFrames=0 driverBufferedBytes=0 driverDroppedBytes=0 monitorQueuedFrames=0 staleSourceFramesDropped=0',
  });

  assert.equal(report.failureLayer, 'bridge');
  assert.match(report.failureReason, /queuedFrames=99/);
  assert.match(report.failureReason, /pendingBytes=384000/);
  assert.equal(report.diagnostics.evidence.bridgeMetrics.queuedFrames, 99);
});

test('classifies physical output loopback failures with captured metrics', () => {
  const report = classify({
    physicalOutput: {
      ...healthyPhysicalOutput,
      capturedFrames: 0,
      rms: 0,
      toneComponent: 0,
    },
  });

  assert.equal(report.failureLayer, 'physicalOutput');
  assert.match(report.failureReason, /capturedFrames=0/);
  assert.match(report.failureReason, /rms=0/);
  assert.equal(report.diagnostics.evidence.physicalOutput.capturedFrames, 0);
});

test('classifies silent WASAPI tone as wasapi failure', () => {
  const report = classify({
    wasapi: { ToneFrames: 48000, ToneRms: 0, InvalidSamples: 0 },
  });

  assert.equal(report.failureLayer, 'wasapi');
  assert.match(report.failureReason, /silent/);
});

test('classifies injected playback with fixed baseline capture as wasapi failure', () => {
  const report = classify({
    wasapi: {
      ToneFrames: 57600,
      IdleRms: 0.3535265,
      ToneRms: 0.3535265,
      PostToneIdleRms: 0.3535265,
      ToneFrequencyHz: 3000,
      ToneComponent: 0,
      InvalidSamples: 0,
    },
    app: { routeState: null, overlayVisible: null, subtitleCueCount: null },
    playback: { playbackMode: 'sapi-endpoint-speech' },
    appLogText: [
      'watch_mode.route_start | direction=inbound routeMode=watch',
      'ws.send.input_audio_buffer.append.summary chunks=100',
    ].join('\n'),
  });

  assert.equal(report.failureLayer, 'wasapi');
  assert.match(report.failureReason, /fixed 3 kHz baseline/);
});

test('classifies fixed baseline with unchanged driver counters as render path failure evidence', () => {
  const report = classify({
    wasapi: {
      ToneFrames: 57600,
      IdleRms: 0.3535265,
      ToneRms: 0.3535265,
      PostToneIdleRms: 0.3535265,
      ToneFrequencyHz: 3000,
      ToneComponent: 0,
      CapturedBytesBeforeTone: 0,
      CapturedBytesAfterTone: 0,
      InvalidSamples: 0,
    },
    app: { routeState: null, overlayVisible: null, subtitleCueCount: null },
    appLogText: 'watch_mode.route_start | direction=inbound routeMode=watch',
  });

  assert.equal(report.failureLayer, 'wasapi');
  assert.match(report.failureReason, /capturedBytes did not increase/);
});

test('classifies fixed baseline with no render stream as render stream creation failure', () => {
  const report = classify({
    wasapi: {
      ToneFrames: 57600,
      IdleRms: 0.3535265,
      ToneRms: 0.3535265,
      PostToneIdleRms: 0.3535265,
      ToneFrequencyHz: 3000,
      ToneComponent: 0,
      CapturedBytesBeforeTone: 0,
      CapturedBytesAfterTone: 0,
      RenderStreamsCreatedAfterTone: 0,
      InvalidSamples: 0,
    },
    app: { routeState: null, overlayVisible: null, subtitleCueCount: null },
    appLogText: 'watch_mode.route_start | direction=inbound routeMode=watch',
  });

  assert.equal(report.failureLayer, 'wasapi');
  assert.match(report.failureReason, /no system render stream creation/);
});


test('classifies bridge source stalls from logs', () => {
  const report = classify({
    bridgeLogText: 'event=source_watchdog sourceSubscriberActive=true workerPhase=reading-driver lastProgressAgeMs=6000',
  });

  assert.equal(report.failureLayer, 'bridge');
  assert.match(report.failureReason, /watchdog|source frames/);
});

test('treats healthy bridge source watchdog events as progress evidence', () => {
  const report = classify({
    bridge: {
      bridgeState: 'running',
      driverHealth: 'running',
      sourceSubscriberActive: true,
      sourceReadCalls: 0,
      droppedFrameCount: 0,
      sourceFramePayloadBytes: 3840,
    },
    bridgeLogText: 'event=source_watchdog sourceSubscriberActive=true workerPhase=wasapi-loopback-running lastProgressAgeMs=17 capturePackets=487 captureFrames=467520 readCalls=0 bytesRead=0 releasedFrames=487',
  });

  assert.notEqual(report.failureLayer, 'bridge');
});

test('classifies missing subtitle evidence as app failure', () => {
  const report = classify({
    app: { routeState: 'capturing', overlayVisible: true, subtitleCueCount: 0 },
    appLogText: 'watch route ensured subtitle overlay visible',
  });

  assert.equal(report.failureLayer, 'app');
  assert.match(report.failureReason, /subtitle/);
});

test('classifies runner failure before healthy log evidence', () => {
  const report = classify({
    failure: { message: 'stale omni-desktop-shell could not be stopped; pid=25452' },
    appLogText: healthyAppLog,
  });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'app');
  assert.match(report.failureReason, /stale omni-desktop-shell/);
  assert(report.suspectFiles.some((file) => file.includes('run-watch-mode-live.ps1')));
});

test('keeps runner failure as primary app reason while preserving secondary symptoms', () => {
  const report = classify({
    translationRoute: 'secondary',
    failure: {
      message: 'wait for watch-mode app readiness failed: timed out waiting for app log pattern: watch_mode\\.omni_session_ready',
    },
    appLogText: [
      'watch_mode.diagnostic_autostart_requested | watch_mode_diagnostic.run_id=abc123',
      'watch_mode.omni_preconnect_discarded | direction=inbound reason=readiness_timeout',
      'watch_mode.diagnostic_autostart_route_failed | Omni session readiness timed out after 90000ms: timed out waiting on channel',
      'start_audio_route subtitleTranslationMode=secondary subtitleTranslationModelId=template-deepseek::deepseek-v4-flash st_active=true',
    ].join('\n'),
  });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'app');
  assert.match(report.failureReason, /wait for watch-mode app readiness failed/);
  assert.match(report.layers.app.reason, /wait for watch-mode app readiness failed/);
  assert(report.layers.app.reasons.some((reason) => /did not start Omni preconnect/.test(reason)));
  assert.equal(report.diagnostics.runnerFailure, report.failureReason);
  assert(report.diagnostics.evidence.appOmniPreconnect.some((line) => /omni_preconnect_discarded/.test(line)));
});

test('writeReport prioritizes failure artifact over stale healthy app log', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-mode-report-failure-'));
  fs.writeFileSync(path.join(tempDir, 'failure.json'), JSON.stringify({
    message: 'start watch mode via existing desktop shell failed: elevation required',
  }));
  fs.writeFileSync(path.join(tempDir, 'snapshots.json'), JSON.stringify({
    driver: healthyDriver,
    wasapi: healthyWasapi,
    bridge: healthyBridge,
    physicalOutput: healthyPhysicalOutput,
    physicalOutputContent: healthyPhysicalOutputContent,
    app: healthyApp,
    provider: healthyProvider,
  }));
  fs.writeFileSync(path.join(tempDir, 'app.log'), healthyAppLog);
  fs.writeFileSync(path.join(tempDir, 'bridge-service.log'), healthyBridgeLog);

  const { report } = writeReport({ inputDir: tempDir, outputDir: tempDir, mode: 'live' });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'app');
  assert.match(report.failureReason, /start watch mode via existing desktop shell failed/);
});

test('writeReport surfaces failed runner steps and readiness evidence in report output', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-mode-report-steps-'));
  fs.writeFileSync(path.join(tempDir, 'failure.json'), JSON.stringify({
    message: 'wait for watch-mode app readiness failed: timed out waiting for app log pattern: watch_mode\\.omni_session_ready',
  }));
  fs.writeFileSync(path.join(tempDir, 'steps.json'), JSON.stringify([
    { name: 'driver probe', ok: true, result: healthyDriver, error: null },
    {
      name: 'wait for watch-mode app readiness',
      ok: false,
      result: null,
      error: 'timed out waiting for app log pattern: watch_mode\\.omni_session_ready|ws\\.recv\\.session\\.(?:created|updated)',
    },
  ]));
  fs.writeFileSync(path.join(tempDir, 'snapshots.json'), JSON.stringify({
    runMarker: 'watch_mode_diagnostic.run_id=steps-test',
    driver: healthyDriver,
    wasapi: healthyWasapi,
    bridge: healthyBridge,
    physicalOutput: healthyPhysicalOutput,
    physicalOutputContent: null,
    app: { routeState: null, overlayVisible: null, subtitleCueCount: null },
    provider: { totalCalls: 2, failedCalls: 1 },
    translationRoute: 'secondary',
  }));
  fs.writeFileSync(path.join(tempDir, 'bridge-service.log'), healthyBridgeLog);
  fs.writeFileSync(path.join(tempDir, 'app.log'), [
    'watch_mode_diagnostic.run_id=steps-test',
    'watch_mode.omni_preconnect_discarded | direction=inbound reason=readiness_timeout',
    'watch_mode.diagnostic_autostart_route_failed | Omni session readiness timed out after 90000ms: timed out waiting on channel',
  ].join('\n'));

  const { report, reportMarkdownPath } = writeReport({ inputDir: tempDir, outputDir: tempDir, mode: 'live' });
  const markdown = fs.readFileSync(reportMarkdownPath, 'utf8');

  assert.match(report.failureReason, /wait for watch-mode app readiness failed/);
  assert.equal(report.diagnostics.failedSteps.length, 1);
  assert.equal(report.diagnostics.failedSteps[0].name, 'wait for watch-mode app readiness');
  assert(report.diagnostics.failedLayers.some((layer) => layer.layer === 'app'));
  assert(report.artifacts.steps.endsWith('steps.json'));
  assert.match(markdown, /RunnerFailure: wait for watch-mode app readiness failed/);
  assert.match(markdown, /wait for watch-mode app readiness: timed out waiting/);
  assert.match(markdown, /omni_preconnect_discarded/);
});

test('does not count diagnostic run markers as watch route evidence', () => {
  const report = classify({
    app: { routeState: null, overlayVisible: null, subtitleCueCount: null },
    provider: { totalCalls: 0, failedCalls: 0 },
    appLogText: 'watch_mode_diagnostic.run_id=abc123',
  });

  assert.equal(report.failureLayer, 'app');
  assert.equal(report.failureReason, 'no current watch route evidence was found');
});

test('does not use old subtitle evidence when marker is absent and startedAtLocal is current', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-mode-report-'));
  fs.writeFileSync(path.join(tempDir, 'snapshots.json'), JSON.stringify({
    runMarker: 'watch_mode_diagnostic.run_id=missing',
    startedAtLocal: '2026-06-04 09:32:00',
    driver: healthyDriver,
    wasapi: healthyWasapi,
    bridge: healthyBridge,
    physicalOutput: healthyPhysicalOutput,
    physicalOutputContent: healthyPhysicalOutputContent,
    app: { routeState: null, overlayVisible: null, subtitleCueCount: null },
    provider: healthyProvider,
  }));
  fs.writeFileSync(path.join(tempDir, 'app.log'), [
    '2026-06-01 00:12:28.696 [NORMAL] [omni] cue_id=old-cue',
    '2026-06-04 09:32:10.846 [NORMAL] [audio] watch_mode.route_start | direction=inbound routeMode=watch',
    '2026-06-04 09:32:13.078 [DEBUG] [model-trace] ws.send.input_audio_buffer.append.summary',
  ].join('\n'));
  fs.writeFileSync(path.join(tempDir, 'bridge-service.log'), healthyBridgeLog);

  const { report } = writeReport({ inputDir: tempDir, outputDir: tempDir, mode: 'live' });

  assert.equal(report.verdict, 'failed');
  assert.equal(report.failureLayer, 'app');
  assert.equal(report.failureReason, 'no subtitle cue evidence was found');
});

test('infers secondary route from early route config after append summaries flood route tail', () => {
  const appendSummaries = Array.from({ length: 40 }, (_, index) =>
    `2026-06-04 09:32:${String(13 + index).padStart(2, '0')}.078 [DEBUG] [model-trace] ws.send.input_audio_buffer.append.summary chunks=100`,
  );
  const report = classify({
    driver: healthyDriver,
    wasapi: healthyWasapi,
    bridge: healthyBridge,
    physicalOutput: healthyPhysicalOutput,
    physicalOutputContent: healthyPhysicalOutputContent,
    app: { routeState: 'preview', overlayVisible: true, subtitleCueCount: 0 },
    provider: healthyProvider,
    appLogText: [
      '2026-06-04 09:32:10.846 [NORMAL] [audio] start_audio_route 二次翻译判定: subtitleTranslationMode=secondary subtitleTranslationModelId=template-deepseek::deepseek-v4-flash st_active=true',
      '2026-06-04 09:32:10.900 [NORMAL] [audio] start_audio_route secondary speech decision: translationAudioSource=SubtitleTts',
      ...appendSummaries,
    ].join('\n'),
  });

  assert.equal(report.translationRoute, 'secondary');
  assert.equal(report.layers.speechSegmentation.status, 'failed');
});

test('app route config overrides stale native snapshot route', () => {
  const report = classify({
    snapshots: { translationRoute: 'native' },
    driver: healthyDriver,
    wasapi: healthyWasapi,
    bridge: healthyBridge,
    physicalOutput: healthyPhysicalOutput,
    physicalOutputContent: healthyPhysicalOutputContent,
    app: { routeState: 'preview', overlayVisible: true, subtitleCueCount: 0 },
    provider: healthyProvider,
    appLogText: [
      'watch_mode.route_start | direction=inbound routeMode=watch',
      'watch_mode.omni_preconnect_started | detail=direction=inbound',
      'watch_mode.omni_preconnect_reused | detail=direction=inbound',
      'start_audio_route subtitleTranslationMode=secondary subtitleTranslationModelId=template-deepseek::deepseek-v4-flash st_active=true',
      'start_audio_route secondary speech decision: translationAudioSource=SubtitleTts',
    ].join('\n'),
  });

  assert.equal(report.translationRoute, 'secondary');
  assert.equal(report.layers.speechSegmentation.status, 'failed');
});

test('writeReport infers secondary route from app log instead of stale snapshot route', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-mode-report-'));
  fs.writeFileSync(path.join(tempDir, 'snapshots.json'), JSON.stringify({
    translationRoute: 'native',
    driver: healthyDriver,
    wasapi: healthyWasapi,
    bridge: healthyBridge,
    physicalOutput: healthyPhysicalOutput,
    physicalOutputContent: healthyPhysicalOutputContent,
    app: { routeState: 'preview', overlayVisible: true, subtitleCueCount: 0 },
    provider: healthyProvider,
  }));
  fs.writeFileSync(path.join(tempDir, 'bridge-service.log'), healthyBridgeLog);
  fs.writeFileSync(path.join(tempDir, 'app.log'), [
    'watch_mode.route_start | direction=inbound routeMode=watch',
    'start_audio_route subtitleTranslationMode=secondary subtitleTranslationModelId=template-deepseek::deepseek-v4-flash st_active=true',
    'start_audio_route secondary speech decision: translationAudioSource=SubtitleTts',
  ].join('\n'));

  const { report } = writeReport({ inputDir: tempDir, outputDir: tempDir, mode: 'live' });

  assert.equal(report.translationRoute, 'secondary');
  assert.equal(report.layers.speechSegmentation.status, 'failed');
});

test('writeReport keeps early route config when run marker appears again later', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-mode-report-'));
  fs.writeFileSync(path.join(tempDir, 'snapshots.json'), JSON.stringify({
    runMarker: 'watch_mode_diagnostic.run_id=abc123',
    translationRoute: 'native',
    driver: healthyDriver,
    wasapi: healthyWasapi,
    bridge: healthyBridge,
    physicalOutput: healthyPhysicalOutput,
    physicalOutputContent: healthyPhysicalOutputContent,
    app: { routeState: 'preview', overlayVisible: true, subtitleCueCount: 0 },
    provider: healthyProvider,
  }));
  fs.writeFileSync(path.join(tempDir, 'bridge-service.log'), healthyBridgeLog);
  fs.writeFileSync(path.join(tempDir, 'app.log'), [
    'old stale cue_id=old-cue',
    'watch_mode.diagnostic_autostart_requested | watch_mode_diagnostic.run_id=abc123',
    'start_audio_route subtitleTranslationMode=secondary subtitleTranslationModelId=template-deepseek::deepseek-v4-flash st_active=true',
    'start_audio_route secondary speech decision: translationAudioSource=SubtitleTts',
    'watch_mode.diagnostic_autostart_route_started | watch_mode_diagnostic.run_id=abc123',
    'ws.send.input_audio_buffer.append.summary | {"payload":{"audioRms":{"avg":0.18,"max":0.39,"min":0.05},"chunks":{"count":100}}}',
  ].join('\n'));

  const { report } = writeReport({ inputDir: tempDir, outputDir: tempDir, mode: 'live' });

  assert.equal(report.translationRoute, 'secondary');
  assert.equal(report.failureLayer, 'provider');
});

test('classifies provider errors after local layers pass', () => {
  const report = classify({
    provider: { totalCalls: 1, failedCalls: 1 },
    appLogText: `${healthyAppLog}\nmodel_trace failed status=401 invalid api key`,
  });

  assert.equal(report.failureLayer, 'provider');
  assert.match(report.failureReason, /provider|failed/);
});

test('preserves provider status code and model evidence in report and markdown', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-mode-report-provider-'));
  const providerErrorLine = 'provider.translate_text end_call | {"payload":{"error":"HTTP 429 quota exceeded code=QuotaExceeded providerId=provider-dashscope modelId=qwen3.6-flash-2026-04-16","status":"failed"}}';
  fs.writeFileSync(path.join(tempDir, 'snapshots.json'), JSON.stringify({
    driver: healthyDriver,
    wasapi: healthyWasapi,
    bridge: healthyBridge,
    physicalOutput: healthyPhysicalOutput,
    physicalOutputContent: null,
    app: healthyApp,
    provider: { totalCalls: 3, failedCalls: 1 },
  }));
  fs.writeFileSync(path.join(tempDir, 'bridge-service.log'), healthyBridgeLog);
  fs.writeFileSync(path.join(tempDir, 'app.log'), [
    healthyAppLog,
    providerErrorLine,
  ].join('\n'));

  const { report, reportMarkdownPath } = writeReport({ inputDir: tempDir, outputDir: tempDir, mode: 'live' });
  const markdown = fs.readFileSync(reportMarkdownPath, 'utf8');

  assert.equal(report.failureLayer, 'provider');
  assert.match(report.failureReason, /429 quota exceeded/);
  assert.match(report.failureReason, /provider-dashscope/);
  assert(report.diagnostics.evidence.providerErrors.some((line) => /modelId=qwen3\.6/.test(line)));
  assert.match(markdown, /HTTP 429 quota exceeded/);
});

test('does not classify auth substring inside trace ids as provider auth failure', () => {
  const report = classify({
    appLogText: [
      healthyAppLog,
      'omni.websocket_session ws.recv.response.audio_transcript.delta | {"payload":{"event_id":"event_UiAuTHNW6doW4VCAt1qmq","type":"response.audio_transcript.delta"},"providerId":"provider-dashscope"}',
    ].join('\n'),
  });

  assert.equal(report.verdict, 'passed');
  assert.equal(report.failureLayer, null);
  assert.equal(report.layers.app.parsedLog.providerErrorLines.length, 0);
});

test('classifies audible Omni input without VAD events as provider failure before app cue failure', () => {
  const report = classify({
    driver: healthyDriver,
    wasapi: healthyWasapi,
    bridge: healthyBridge,
    physicalOutput: healthyPhysicalOutput,
    physicalOutputContent: healthyPhysicalOutputContent,
    app: { routeState: 'preview', overlayVisible: true, subtitleCueCount: 0 },
    provider: { totalCalls: 1, failedCalls: 0 },
    appLogText: [
      'watch_mode.route_start | direction=inbound routeMode=watch',
      'watch_mode.overlay_visible | label=subtitle-overlay visible=true',
      'start_audio_route subtitleTranslationMode=secondary subtitleTranslationModelId=template-deepseek::deepseek-v4-flash st_active=true',
      'ws.send.input_audio_buffer.append.summary | {"payload":{"audioRms":{"avg":0.18,"max":0.39,"min":0.05},"chunks":{"count":100}}}',
    ].join('\n'),
  });

  assert.equal(report.failureLayer, 'provider');
  assert.equal(report.failureReason, 'audible audio was sent to Omni, but no VAD/transcription event was received');
});

test('records Omni realtime diagnostics and classifies response.done before ASR final as provider suspect', () => {
  const report = classifyWatchModeRun({
    mode: 'live',
    modelId: 'qwen3.5-omni-plus-realtime',
    driver: healthyDriver,
    wasapi: healthyWasapi,
    bridge: healthyBridge,
    physicalOutput: healthyPhysicalOutput,
    physicalOutputContent: healthyPhysicalOutputContent,
    speechSegmentation: { passed: true, queuedSegments: 1, playedSegments: 1 },
    strictContent: { passed: true, applicable: true, coverage: 1 },
    app: { routeState: 'capturing', overlayVisible: true, subtitleCueCount: 1 },
    provider: { totalCalls: 1, failedCalls: 0 },
    appLogText: [
      'watch_mode.route_start | direction=inbound routeMode=watch',
      'watch_mode.omni_preconnect_started | detail=direction=inbound',
      'watch_mode.omni_preconnect_reused | detail=direction=inbound',
      'start_audio_route subtitleTranslationMode=secondary subtitleTranslationModelId=template-deepseek::deepseek-v4-flash st_active=true',
      'watch_mode.omni_session_config | model=qwen3.5-omni-plus-realtime realtimeAudioMode=manual inputAudioFormat=pcm16 isLivetranslate=false subtitleTranslateActive=true turnDetection=null',
      'watch_mode.omni_session_ready | event=session.created queuedAudioChunks=0 droppedBeforeReady=0',
      '[EVENT_CONTEXT] response.done cue_id=omni-cue-1 responseDoneCount=2 responseDoneAtMs=38000 firstResponseDoneAtMs=22000 readinessEvent=session.created cueOrigin=speech_started sourceLen=0 translatedLen=0 lastAsrDeltaAtMs=- lastAsrDelta="" lastAsrCompletedAtMs=- lastAsrCompleted="" firstNonEmptyAsrCompletedAtMs=- emptyAsrCompletedCount=2 lastOutputDoneAtMs=21000 lastOutputDone="那里！" st_active=true nativeTranslationReuse=false',
    ].join('\n'),
  });

  assert.equal(report.failureLayer, 'provider');
  assert.match(report.failureReason, /response\.done arrived before non-empty ASR completed/);
  assert.equal(report.realtimeSession.realtimeAudioMode, 'manual');
  assert.equal(report.realtimeSession.inputAudioFormat, 'pcm16');
  assert.equal(report.realtimeSession.readinessEvent, 'session.created');
  assert.equal(report.realtimeSession.responseDoneCount, 2);
  assert.equal(report.realtimeSession.duplicateResponseDoneCount, 1);
  assert.equal(report.diagnostics.evidence.realtimeSession.emptyAsrCompletedCount, 2);
});

test('classifies subtitle translate config failure before physical content failure', () => {
  const report = classify({
    app: { routeState: 'capturing', overlayVisible: true, subtitleCueCount: 0 },
    physicalOutputContent: {
      ...healthyPhysicalOutputContent,
      passed: false,
      error: 'physical output STT returned no usable transcript',
    },
    appLogText: [
      'watch_mode.route_start | direction=inbound routeMode=watch',
      'resolve_model_provider_from_config: purpose=subtitle-translate no provider matched target_template=template-deepseek composite_model_id=template-deepseek::deepseek-v4-flash linkedProviders=1',
      'watch_mode.subtitle_translate_config_failed | phase=route subtitleTranslationMode=secondary subtitleTranslationModelId=template-deepseek::deepseek-v4-flash fallback=native reason=provider_not_found',
    ].join('\n'),
  });

  assert.equal(report.failureLayer, 'app');
  assert.match(report.failureReason, /subtitle translate provider\/worker configuration failed/);
});

test('does not fail the run for recovered transient provider timeouts after subtitles are visible', () => {
  const report = classify({
    provider: { totalCalls: 40, failedCalls: 2 },
    appLogText: [
      'watch_mode.route_start | direction=inbound routeMode=watch',
      'watch_mode.overlay_visible | label=subtitle-overlay visible=true',
      'subtitle translate success: cue_id=omni-cue-1 translated="你好"',
      '[TRANS_WRITE] cue_id=omni-cue-1 rank=Final translated="你好"',
      'provider.translate_text end_call | {"payload":{"error":"timeout: upstream request timed out","status":"failed"}}',
      'provider.translate_text end_call | {"payload":{"error":null,"status":"succeeded"}}',
    ].join('\n'),
  });

  assert.equal(report.verdict, 'passed');
  assert.equal(report.failureLayer, null);
  assert.equal(report.layers.provider.status, 'passed');
  assert.equal(report.layers.app.parsedLog.providerErrorLines.length, 1);
});

test('does not fail recovered provider timeout when physical output content passed', () => {
  const report = classify({
    provider: { totalCalls: 40, failedCalls: 2 },
    appLogText: [
      'watch_mode.route_start | direction=inbound routeMode=watch',
      'provider.translate_text end_call | {"payload":{"error":"timeout: upstream request timed out","status":"failed"}}',
      'speech.speaker_playback_written | cue=cue-1 frames=48000',
    ].join('\n'),
    physicalOutputContent: {
      ...healthyPhysicalOutputContent,
      passed: true,
      source: '浣犲ソ涓栫晫',
      subtitleText: '浣犲ソ涓栫晫',
    },
  });

  assert.equal(report.verdict, 'passed');
  assert.equal(report.failureLayer, null);
  assert.equal(report.layers.provider.status, 'passed');
});

test('parses bridge source pacer metrics', () => {
  const parsed = parseBridgeLog('2026-01-01 00:00:01.000 [NORMAL] [bridge] - - source pacer summary: releasedFrames=10 queuedFrames=2 pendingBytes=3840 underruns=1 droppedFrames=0 driverBufferedBytes=960 driverDroppedBytes=0 monitorQueuedFrames=1 staleSourceFramesDropped=0 sid=bridge-0198testsid-1000');

  assert.equal(parsed.metrics.releasedFrames, 10);
  assert.equal(parsed.metrics.queuedFrames, 2);
  assert.equal(parsed.metrics.pendingBytes, 3840);
});

test('parses bridge source pacer metrics from legacy unprefixed lines', () => {
  // Logs written before the unified `{timestamp} [{LEVEL}] [bridge]` prefix
  // must keep parsing (rotated files can span the format change).
  const parsed = parseBridgeLog('source pacer summary: releasedFrames=10 queuedFrames=2 pendingBytes=3840 underruns=1 droppedFrames=0 driverBufferedBytes=960 driverDroppedBytes=0 monitorQueuedFrames=1 staleSourceFramesDropped=0');

  assert.equal(parsed.metrics.releasedFrames, 10);
  assert.equal(parsed.metrics.queuedFrames, 2);
  assert.equal(parsed.metrics.pendingBytes, 3840);
});

test('renders markdown with verdict and suspect files', () => {
  const markdown = renderMarkdownReport(classify({
    provider: { totalCalls: 1, failedCalls: 1, error: 'invalid api key' },
  }));

  assert.match(markdown, /Verdict: failed/);
  assert.match(markdown, /FailureLayer: provider/);
  assert.match(markdown, /apps\/desktop\/src-tauri\/src\/audio\/omni.rs/);
});
