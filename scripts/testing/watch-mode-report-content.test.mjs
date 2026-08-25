// Split from watch-mode-report.test.mjs (kept as the package.json entry that
// imports this file): physical-output content recording/STT evidence (subtitle
// match, clipping, source similarity, combined transcript consistency) and the
// strict reference-media content gate.
import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateStrictContent } from './watch-mode-report.mjs';
import {
  classify,
  healthyPhysicalOutputContent,
  strictTestMediaContent,
  testMediaReferenceTranslation,
} from './watch-mode-report-test-helpers.mjs';

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
  assert.match(report.failureReason, /diverged from source media reference/i);
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

test('passes mixed physical output content when original and translated subchecks pass', () => {
  const report = classify({
    physicalOutputContent: {
      ...healthyPhysicalOutputContent,
      source: 'original game voice that does not match the translated subtitle',
      translation: '',
      subtitleText: '译音字幕',
      sourceReference: { passed: true, source: 'original game voice that does not match the translated subtitle', translation: '' },
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
      source: 'unrelated physical transcript',
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
      source: '一个新家，一个五亿美元的生物圈。发生什么事了？未来汽车可以带你去任何地方。'.repeat(4),
      translation: '我这边还是听不到任何声音，好像有点问题。你能再说一遍吗？我这边还是听不到任何声音，好像有点问题。你能再说一遍吗？',
      originalPassthrough: { passed: true, transcriptChars: 42 },
      translatedSpeech: { passed: true, playedSegments: 8, queuedSegments: 8, transcriptChars: 60 },
      mixedOutput: { passed: true, rms: 0.05, peak: 0.2 },
      sourceReference: {
        passed: true,
        source: '一个新家，一个五亿美元的生物圈。发生什么事了？未来汽车可以带你去任何地方。',
        translation: '一个价值五亿美元的生物圈和一辆未来汽车可以带你去任何地方。'.repeat(8),
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
  assert.match(report.failureReason, /combined physical\/structured translation evidence/);
  assert.equal(report.layers.physicalOutputContent.data.contentConsistency.evidenceSource, 'node-report-v2');
});

test('classifies failed combined physical and structured evidence as physical output content failure', () => {
  const report = classify({
    physicalOutputContent: {
      ...healthyPhysicalOutputContent,
      source: 'completely unrelated physical source transcript',
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
  assert.match(report.failureReason, /diverged from source media reference/);
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

test('uses Node-parsed playback lifecycle when raw PowerShell counters are stale', () => {
  const report = classify({
    physicalOutputContent: {
      ...healthyPhysicalOutputContent,
      translatedSpeech: { passed: false, queuedSegments: 0, playedSegments: 0 },
    },
    speechSegmentation: { queuedSegments: 4, playedSegments: 4 },
  });

  assert.equal(report.layers.physicalOutputContent.status, 'passed');
  assert.equal(report.layers.physicalOutputContent.data.translatedSpeech.queuedSegments, 4);
  assert.equal(report.layers.physicalOutputContent.data.translatedSpeech.playedSegments, 4);
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

test('strict reference-media concepts accept equivalent Arabic-number currency forms', () => {
  const result = evaluateStrictContent({
    physicalOutputContent: strictTestMediaContent({
      translation: testMediaReferenceTranslation
        .replaceAll('十亿美元', '10 亿美元')
        .replaceAll('五亿美元', '5 亿美元')
        .replaceAll('一美元的灯泡', '1 美元灯泡'),
      subtitleText: '',
      segmentTranslationText: '',
    }),
  });

  assert.equal(result.passed, true);
  assert.deepEqual(result.missingConcepts, []);
});

test('strict native reference-media content accepts completed native cues instead of secondary TTS queue writes', () => {
  const result = evaluateStrictContent({
    translationRoute: 'native',
    physicalOutputContent: strictTestMediaContent({
      subtitleQueue: {
        finalWriteCount: 0,
        queuedSegmentCount: 0,
        playedSegmentCount: 2,
      },
      translatedSpeech: {
        passed: true,
        queuedSegments: 0,
        playedSegments: 2,
        transcriptChars: testMediaReferenceTranslation.length,
      },
    }),
    watchSessionReport: {
      cues: [
        {
          cueId: 'native-cue-1',
          comparisonStatus: 'exact',
          llmText: '第一段译文',
          publishedText: '第一段译文',
          renderedText: '第一段译文',
        },
        {
          cueId: 'native-cue-2',
          comparisonStatus: 'formatting-only',
          llmText: '第二段译文',
          publishedText: '第二段译文',
          renderedText: '第二段译文',
        },
      ],
    },
  });

  assert.equal(result.passed, true);
  assert.equal(result.translationRoute, 'native');
  assert.equal(result.nativeCompletedCueCount, 2);
  assert.equal(result.finalWriteCount, 0);
});

test('strict native reference-media content accepts one complete continuous-source cue', () => {
  const result = evaluateStrictContent({
    translationRoute: 'native',
    physicalOutputContent: strictTestMediaContent({
      subtitleQueue: { finalWriteCount: 0, queuedSegmentCount: 0, playedSegmentCount: 1 },
      translatedSpeech: {
        passed: true,
        queuedSegments: 0,
        playedSegments: 1,
        transcriptChars: testMediaReferenceTranslation.length,
      },
    }),
    watchSessionReport: {
      cues: [{
        cueId: 'native-cue-1',
        comparisonStatus: 'exact',
        llmText: '唯一译文',
        publishedText: '唯一译文',
        renderedText: '唯一译文',
      }],
    },
  });

  assert.equal(result.passed, true);
  assert.equal(result.nativeCompletedCueCount, 1);
  assert.equal(result.playedSegmentCount, 1);
});

test('strict native reference-media content rejects a cue that never reaches the physical sink', () => {
  const result = evaluateStrictContent({
    translationRoute: 'native',
    physicalOutputContent: strictTestMediaContent({
      subtitleQueue: { finalWriteCount: 0, queuedSegmentCount: 0, playedSegmentCount: 0 },
      translatedSpeech: {
        passed: false,
        queuedSegments: 1,
        playedSegments: 0,
        transcriptChars: testMediaReferenceTranslation.length,
      },
    }),
    watchSessionReport: {
      cues: [{
        cueId: 'native-cue-1',
        comparisonStatus: 'exact',
        llmText: '唯一译文',
        publishedText: '唯一译文',
        renderedText: '唯一译文',
      }],
    },
  });

  assert.equal(result.passed, false);
  assert.match(result.failures.join('\n'), /playedSegmentCount=0/);
});

test('strict secondary reference-media content still requires the subtitle-TTS queue', () => {
  const result = evaluateStrictContent({
    translationRoute: 'secondary',
    physicalOutputContent: strictTestMediaContent({
      subtitleQueue: { finalWriteCount: 0, queuedSegmentCount: 0, playedSegmentCount: 2 },
      translatedSpeech: { passed: true, queuedSegments: 0, playedSegments: 2 },
    }),
    speechSegmentation: { queuedSegments: 0, playedSegments: 2 },
  });

  assert.equal(result.passed, false);
  assert.match(result.failures.join('\n'), /finalWriteCount=0/);
  assert.match(result.failures.join('\n'), /queuedSegmentCount=0/);
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
        mediaSha256: 'cf4990ecdc23622d12de3e62adad442755c9e84c4612787798655ee00c85fb2f',
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
  const openingOnly = '杩欐槸涓€鑹樹环鍊煎崄浜跨編鍏冪殑鐏椋炶埞';
  const report = classify({
    translationRoute: 'secondary',
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
