import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WATCH_MODE_RUN_COLLECTION_SCHEMA, writeWatchModeRunCollection } from './watch-mode-run-collection.mjs';
import {
  BENCHMARK_SCORE_VERSION,
  calculateChrF2,
  calculateWeightedTotal,
  finalizeBenchmarkScore,
  judgeValidRuns,
  parseLlmJudgeResponse,
  scoreDeterministic,
  scoreLatencyRamp,
  scoreRun,
} from './watch-mode-score.mjs';

const passedReport = { verdict: 'passed', failureLayer: null, layers: { app: { status: 'passed' } } };

function writeCollection(directory, evidence) {
  fs.writeFileSync(path.join(directory, 'fixture-evidence.raw.json'), JSON.stringify(evidence), 'utf8');
  writeWatchModeRunCollection(directory, {
    schemaVersion: WATCH_MODE_RUN_COLLECTION_SCHEMA,
    artifactKind: 'watch-mode-run-collection',
    request: { schemaVersion: 'watch-mode-run-request/v1', runMode: 'fixture' },
    collectionStatus: 'completed',
    steps: [],
    ownedProcesses: [],
    artifacts: { fixtureEvidence: 'fixture-evidence.raw.json' },
    primaryError: null,
    cleanupErrors: [],
  });
}

function completeRun(index, overrides = {}) {
  return {
    runIndex: index,
    responseCreatedMs: 0,
    firstOutputMs: 2_000,
    firstCommittedMs: 5_000,
    audioStartedAtMs: 0,
    audioStartOrigin: 'provider-offset',
    sourceStableAtMs: 1_000,
    audioToSourceFirstMs: 500,
    audioToLlmFirstMs: 1_500,
    audioToRenderFirstMs: 2_000,
    audioToRenderFinalMs: 5_000,
    responseDoneMs: 10_000,
    translationFinal: '你好世界',
    responseCount: 1,
    ...overrides,
  };
}

function successfulJudge(runs, score = 100) {
  return {
    status: 'passed',
    enabled: true,
    model: 'judge-model',
    rubricVersion: 'translation-judge/v1',
    semanticJudge: {
      model: 'judge-model',
      rubricVersion: 'translation-judge/v1',
      score,
      runs: runs.map((run) => ({
        runIndex: run.runIndex,
        score,
        subscores: { adequacy: score, factsTerminology: score, omissionsAdditions: score, fluency: score },
        rationale: 'The translation was evaluated against the supplied evidence.',
        criticalErrors: [],
      })),
    },
    runJudgments: [],
  };
}

test('chrF2 uses documented NFKC and whitespace normalization while preserving case and punctuation', () => {
  const perfect = calculateChrF2('Ａ B!', 'A\nB!');
  assert.equal(perfect.score, 100);
  assert.equal(perfect.normalization, 'Unicode NFKC; whitespace removed; case preserved');
  assert.deepEqual(perfect.orders.map(({ order }) => order), [1, 2, 3]);

  const caseSensitive = calculateChrF2('A', 'a');
  assert.equal(caseSensitive.score, 0);
  const punctuationSensitive = calculateChrF2('A!', 'A');
  assert.ok(punctuationSensitive.score < 100);
});

test('latency ramp has public threshold boundaries and linear interpolation', () => {
  assert.equal(scoreLatencyRamp(2_000, 2_000, 8_000), 100);
  assert.equal(scoreLatencyRamp(8_000, 2_000, 8_000), 0);
  assert.equal(scoreLatencyRamp(5_000, 2_000, 8_000), 50);
  assert.equal(scoreLatencyRamp(5_000, 5_000, 15_000), 100);
  assert.equal(scoreLatencyRamp(15_000, 5_000, 15_000), 0);
  assert.equal(scoreLatencyRamp(null, 5_000, 15_000), null);
});

test('v2 does not issue a total before LLM judge evidence is present', () => {
  const deterministic = scoreDeterministic({
    report: passedReport,
    sourceText: 'Hello world',
    referenceText: '你好世界',
    evidence: { runs: [completeRun(0)] },
  });
  assert.equal(deterministic.schemaVersion, BENCHMARK_SCORE_VERSION);
  assert.equal(deterministic.version, BENCHMARK_SCORE_VERSION);
  assert.equal(deterministic.status, 'evidence-insufficient');
  assert.equal(deterministic.total, null);
  assert.equal(deterministic.grade, null);
  assert.equal(deterministic.dimensions.semantic.score, null);
  assert.deepEqual(deterministic.dimensions.semantic.missingEvidence, ['judge-result-for-each-completed-run']);
  assert.equal(deterministic.dimensions.latency.score, 100);
  assert.equal(deterministic.dimensions.completeness.score, 100);
  assert.equal(deterministic.dimensions.stability.score, 100);
  assert.equal(Object.hasOwn(deterministic.dimensions, 'reliability'), false);
});

test('aggregates every run and exposes the exact weighted total and every stability deduction', () => {
  const runs = [
    completeRun(0),
    completeRun(1, {
      responseCreatedMs: 100,
      firstOutputMs: 5_100,
      firstCommittedMs: 10_100,
      audioToRenderFirstMs: 5_000,
      audioToRenderFinalMs: 10_000,
      responseCount: 3,
    }),
  ];
  const deterministic = scoreDeterministic({
    report: { ...passedReport, summary: { runCount: 2 } },
    sourceText: 'Hello world',
    referenceText: '你好世界',
    evidence: { runs },
  });
  const result = finalizeBenchmarkScore(deterministic, successfulJudge(runs, 66.7));

  assert.equal(result.status, 'official');
  assert.deepEqual(
    Object.fromEntries(Object.entries(result.dimensions).map(([name, dimension]) => [name, dimension.score])),
    { semantic: 80, latency: 75, completeness: 100, stability: 90 },
  );
  assert.equal(result.total, 83.5);
  assert.equal(result.grade, 'B');
  assert.deepEqual(result.deductions, [
    { type: 'extra-response', runIndex: 1, responseOrdinal: 2, amount: 5 },
    { type: 'extra-response', runIndex: 1, responseOrdinal: 3, amount: 5 },
  ]);
  assert.equal(result.dimensions.latency.evidence.signals[2].score, 50);
  assert.equal(result.dimensions.semantic.evidence.referenceByRun.length, 2);
  assert.equal(result.dimensions.semantic.evidence.judge.runs.length, 2);
  assert.equal(calculateWeightedTotal({ semantic: 80, latency: 75, completeness: 100, stability: 90 }), 83.5);
});

test('missing mandatory latency evidence is explicit and prevents a formal total', () => {
  const runs = [completeRun(0, { audioToRenderFinalMs: null })];
  const deterministic = scoreDeterministic({
    report: passedReport,
    sourceText: 'Hello world',
    referenceText: '你好世界',
    evidence: { runs },
  });
  const result = finalizeBenchmarkScore(deterministic, successfulJudge(runs));
  assert.equal(result.status, 'evidence-insufficient');
  assert.equal(result.total, null);
  assert.equal(result.dimensions.latency.status, 'evidence-insufficient');
  assert.deepEqual(result.dimensions.latency.missingEvidence, ['run-0-audioToRenderFinal']);
  assert.ok(result.evidenceCoverage.missing.includes('latency:run-0-audioToRenderFinal'));
});

test('legacy Watch cue-start timers are retained as diagnostics but are not misrepresented as response-created latency', () => {
  const deterministic = scoreDeterministic({
    report: passedReport,
    sourceText: 'Hello world',
    referenceText: '你好世界',
    evidence: {
      content: { translation: '你好世界' },
      queue: {
        firstVisibleTranslationLatencySeconds: 2,
        firstFinalTranslationLatencySeconds: 5,
        duplicateFinalTranslations: 0,
      },
    },
  });
  assert.equal(deterministic.dimensions.latency.score, null);
  assert.deepEqual(deterministic.dimensions.latency.missingEvidence, ['run-0-audioToRenderFirst', 'run-0-audioToRenderFinal']);
  assert.equal(deterministic.runContributions[0].legacyCueToFirstTokenLatencyMs, 2_000);
  assert.equal(deterministic.runContributions[0].legacyCueToFirstCommittedLatencyMs, 5_000);
});

test('provider-event fallback is not treated as high-confidence scoring evidence', () => {
  const deterministic = scoreDeterministic({
    report: passedReport,
    sourceText: 'Hello world',
    referenceText: '你好世界',
    evidence: {
      runs: [completeRun(0, {
        audioStartOrigin: 'provider-event',
        timeToFirstTokenMs: 2_000,
        timeToFirstCommittedMs: 5_000,
      })],
    },
  });
  assert.equal(deterministic.dimensions.latency.score, null);
  assert.deepEqual(deterministic.dimensions.latency.missingEvidence, ['run-0-audioToRenderFirst', 'run-0-audioToRenderFinal']);
});

test('Watch scoring ignores terminal translation errors and selects a final cue', () => {
  const deterministic = scoreDeterministic({
    report: passedReport,
    sourceText: 'Hello world',
    referenceText: '你好世界',
    evidence: {
      content: { translation: '你好世界' },
      queue: { duplicateFinalTranslations: 0 },
      watchSessionReport: {
        sessionId: 'watch-session',
        cues: [
          {
            translationState: 'error',
            audioStartedAtMs: 0,
            audioStartOrigin: 'provider-offset',
            audioToRenderFirstMs: 100,
            audioToRenderFinalMs: 200,
          },
          {
            translationState: 'final',
            audioStartedAtMs: 0,
            audioStartOrigin: 'provider-offset',
            audioToRenderFirstMs: 2_000,
            audioToRenderFinalMs: 5_000,
          },
        ],
      },
    },
  });

  assert.equal(deterministic.runContributions[0].audioToRenderFirstMs, 2_000);
  assert.equal(deterministic.runContributions[0].audioToRenderFinalMs, 5_000);
  assert.equal(deterministic.dimensions.latency.score, 100);
});

test('missing response-count telemetry is evidence-insufficient instead of an invented stability score', () => {
  const runs = [completeRun(0, { responseCount: null })];
  const deterministic = scoreDeterministic({
    report: passedReport,
    sourceText: 'Hello world',
    referenceText: '你好世界',
    evidence: { runs },
  });
  const result = finalizeBenchmarkScore(deterministic, successfulJudge(runs));
  assert.equal(result.status, 'evidence-insufficient');
  assert.equal(result.total, null);
  assert.equal(result.dimensions.stability.score, null);
  assert.deepEqual(result.dimensions.stability.missingEvidence, ['run-0-response-count']);
});

test('completeness reports unrecorded declared runs without silently reweighting the score', () => {
  const deterministic = scoreDeterministic({
    report: { ...passedReport, summary: { runCount: 2 } },
    sourceText: 'Hello world',
    referenceText: '你好世界',
    evidence: { runs: [completeRun(0)] },
  });
  assert.equal(deterministic.dimensions.completeness.score, 50);
  assert.deepEqual(deterministic.dimensions.completeness.evidence.incompleteRuns, [{ runIndex: 1, missing: ['run-record'] }]);
  assert.equal(deterministic.dimensions.stability.score, null);
  assert.deepEqual(deterministic.dimensions.stability.missingEvidence, ['run-record-for-each-declared-run']);
  assert.equal(deterministic.total, null);
  assert.ok(deterministic.evidenceCoverage.missing.includes('latency:run-record-for-each-declared-run'));
});

test('a failed benchmark reports benchmark-failed rather than a capped pseudo-score', () => {
  const runs = [completeRun(0)];
  const deterministic = scoreDeterministic({
    report: { ...passedReport, verdict: 'failed', failureLayer: 'provider', failureReason: 'timeout' },
    sourceText: 'Hello world',
    referenceText: '你好世界',
    evidence: { runs },
  });
  const result = finalizeBenchmarkScore(deterministic, successfulJudge(runs));
  assert.equal(result.status, 'benchmark-failed');
  assert.equal(result.total, null);
  assert.equal(result.grade, null);
  assert.equal(result.run.failureLayer, 'provider');
});

test('LLM judge response parsing is structured and rejects missing rubric scores', () => {
  const parsed = parseLlmJudgeResponse(JSON.stringify({
    rubricVersion: 'translation-judge/v1',
    adequacy: 100,
    factsTerminology: 80,
    omissionsAdditions: 90,
    fluency: 70,
    rationale: 'A number was localized but the meaning remains intact.',
    criticalErrors: [{ category: 'number', description: 'Wrong unit.', sourceEvidence: '10 km', candidateEvidence: '10 m' }],
  }), { model: 'judge', runIndex: 4 });
  assert.equal(parsed.run.runIndex, 4);
  assert.equal(parsed.run.score, 85);
  assert.deepEqual(parsed.run.criticalErrors[0], {
    category: 'number', description: 'Wrong unit.', sourceEvidence: '10 km', candidateEvidence: '10 m',
  });
  assert.throws(
    () => parseLlmJudgeResponse(JSON.stringify({ adequacy: 100, factsTerminology: 100, omissionsAdditions: 100, rationale: 'incomplete' })),
    /fluency score/,
  );
  assert.throws(
    () => parseLlmJudgeResponse(JSON.stringify({
      adequacy: 100, factsTerminology: 100, omissionsAdditions: 100, fluency: 100,
      rationale: 'Missing evidence.', criticalErrors: [{ category: 'facts', description: 'Wrong number.', sourceEvidence: '10' }],
    })),
    /auditable source and candidate evidence/,
  );
});

test('LLM judging evaluates each completed run separately', async () => {
  const runs = [completeRun(0), completeRun(1)];
  let calls = 0;
  const result = await judgeValidRuns({
    runs,
    sourceText: 'Hello world',
    referenceText: '你好世界',
    targetLanguage: 'zh-CN',
    endpoint: 'https://example.invalid/judge',
    apiKey: 'test-key',
    model: 'judge-model',
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({
          adequacy: 100, factsTerminology: 100, omissionsAdditions: 100, fluency: 100, rationale: 'good', criticalErrors: [],
        }) } }] }),
      };
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.status, 'passed');
  assert.deepEqual(result.semanticJudge.runs.map(({ runIndex }) => runIndex), [0, 1]);
});

test('scoreRun persists a credential-free evidence-insufficient v2 record when automatic judging cannot authenticate', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-watch-score-'));
  const sourcePath = path.join(tempRoot, 'source.txt');
  const referencePath = path.join(tempRoot, 'reference.txt');
  const credentialEnv = 'OMNI_TEST_WATCH_SCORE_V1_MISSING_CREDENTIAL';
  try {
    fs.writeFileSync(path.join(tempRoot, 'report.json'), JSON.stringify(passedReport), 'utf8');
    writeCollection(tempRoot, {
      app: { subtitleQueue: {
        firstVisibleTranslationLatencySeconds: 2,
        firstFinalTranslationLatencySeconds: 5,
        duplicateFinalTranslations: 0,
      } },
      physicalOutputContent: { translation: '你好世界' },
    });
    fs.writeFileSync(sourcePath, 'Hello world', 'utf8');
    fs.writeFileSync(referencePath, '你好世界', 'utf8');
    delete process.env[credentialEnv];
    const { result, output } = await scoreRun({
      input: tempRoot,
      source: sourcePath,
      reference: referencePath,
      apiKeyEnv: credentialEnv,
    });
    assert.equal(result.schemaVersion, BENCHMARK_SCORE_VERSION);
    assert.equal(result.status, 'evidence-insufficient');
    assert.equal(result.total, null);
    assert.equal(result.judgeAttempt.status, 'missing-credentials');
    assert.equal(fs.existsSync(output), true);
    assert.equal(fs.readFileSync(output, 'utf8').includes('test-key'), false);
  } finally {
    delete process.env[credentialEnv];
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('dry-run fixtures do not make an external judge request even when a key is available', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-watch-score-dry-run-'));
  const sourcePath = path.join(tempRoot, 'source.txt');
  const referencePath = path.join(tempRoot, 'reference.txt');
  const credentialEnv = 'OMNI_TEST_WATCH_SCORE_V1_DRY_RUN_CREDENTIAL';
  try {
    fs.writeFileSync(path.join(tempRoot, 'report.json'), JSON.stringify({ ...passedReport, mode: 'dry-run' }), 'utf8');
    writeCollection(tempRoot, {
      app: { subtitleQueue: {
        firstVisibleTranslationLatencySeconds: 2,
        firstFinalTranslationLatencySeconds: 5,
        duplicateFinalTranslations: 0,
      } },
      physicalOutputContent: { translation: '你好世界' },
    });
    fs.writeFileSync(sourcePath, 'Hello world', 'utf8');
    fs.writeFileSync(referencePath, '你好世界', 'utf8');
    process.env[credentialEnv] = 'test-only-key';
    const { result } = await scoreRun({
      input: tempRoot,
      source: sourcePath,
      reference: referencePath,
      apiKeyEnv: credentialEnv,
      endpoint: 'https://judge-request-must-not-be-made.invalid',
    });
    assert.equal(result.judgeAttempt.status, 'skipped');
    assert.match(result.judgeAttempt.reason, /Dry-run fixtures/);
  } finally {
    delete process.env[credentialEnv];
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
