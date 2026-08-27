import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWatchModeArtifacts } from './watch-mode/artifact-loader.mjs';

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const RULES_PATH = path.resolve(MODULE_DIRECTORY, '../../contracts/benchmark-score-v2-rules.json');
const DEFAULT_JUDGE_MODEL = 'qwen3.5-plus';

export const BENCHMARK_SCORE_VERSION = 'benchmark-score/v2';
export const LEGACY_BENCHMARK_SCORE_VERSION = 'benchmark-score/v1';
export const LLM_JUDGE_RUBRIC_VERSION = 'translation-judge/v1';

const FALLBACK_RULES = Object.freeze({
  schemaVersion: BENCHMARK_SCORE_VERSION,
  dimensionWeights: { semantic: 40, latency: 30, completeness: 20, stability: 10 },
  semantic: {
    referenceMetric: 'chrF2', characterNgramOrder: 6, beta: 2, referenceWeight: 40, judgeWeight: 60,
    judgeSubscores: ['adequacy', 'factsTerminology', 'omissionsAdditions', 'fluency'],
  },
  latencyMilliseconds: {
    audioToRenderFirst: { good: 2_000, bad: 8_000 },
    audioToRenderFinal: { good: 5_000, bad: 15_000 },
  },
  stability: { extraResponsePenalty: 5 },
  grades: [
    { grade: 'A', minimum: 90 }, { grade: 'B', minimum: 80 }, { grade: 'C', minimum: 70 },
    { grade: 'D', minimum: 60 }, { grade: 'F', minimum: 0 },
  ],
});

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const readText = (file) => fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
const clone = (value) => JSON.parse(JSON.stringify(value));
const round = (value, digits = 1) => Number(Number(value).toFixed(digits));
const clamp = (value, min = 0, max = 100) => Math.min(max, Math.max(min, value));
const average = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

function optionalNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function optionalNonNegativeNumber(value) {
  const number = optionalNumber(value);
  return number != null && number >= 0 ? number : null;
}

function validateRules(rules) {
  if (!rules || rules.schemaVersion !== BENCHMARK_SCORE_VERSION) {
    throw new Error(`${RULES_PATH} must declare schemaVersion ${BENCHMARK_SCORE_VERSION}`);
  }
  const dimensions = ['semantic', 'latency', 'completeness', 'stability'];
  const totalWeight = dimensions.reduce((sum, key) => sum + Number(rules.dimensionWeights?.[key]), 0);
  if (totalWeight !== 100 || dimensions.some((key) => !Number.isFinite(Number(rules.dimensionWeights?.[key])))) {
    throw new Error(`${RULES_PATH} must define all four dimension weights summing to 100`);
  }
  if (rules.semantic?.referenceMetric !== 'chrF2' || rules.semantic?.characterNgramOrder !== 6 || rules.semantic?.beta !== 2) {
    throw new Error(`${RULES_PATH} must define chrF2 with character 1–6 grams and beta=2`);
  }
  if (Number(rules.semantic?.referenceWeight) + Number(rules.semantic?.judgeWeight) !== 100) {
    throw new Error(`${RULES_PATH} semantic weights must sum to 100`);
  }
  for (const signal of ['audioToRenderFirst', 'audioToRenderFinal']) {
    const threshold = rules.latencyMilliseconds?.[signal];
    if (!threshold || !Number.isFinite(Number(threshold.good)) || !Number.isFinite(Number(threshold.bad)) || threshold.good >= threshold.bad) {
      throw new Error(`${RULES_PATH} has invalid ${signal} latency thresholds`);
    }
  }
  if (!Number.isFinite(Number(rules.stability?.extraResponsePenalty))) {
    throw new Error(`${RULES_PATH} must define stability.extraResponsePenalty`);
  }
  return rules;
}

function loadRules() {
  // Source archives can still inspect a score without contracts/, but normal
  // workspace execution always reads the same versioned rule file as desktop.
  return validateRules(fs.existsSync(RULES_PATH) ? readJson(RULES_PATH) : clone(FALLBACK_RULES));
}

export const BENCHMARK_SCORE_V2_RULES = Object.freeze(loadRules());
export const BENCHMARK_SCORE_RULES = BENCHMARK_SCORE_V2_RULES;

function findEvidence(runDirectory, report) {
  const snapshots = loadWatchModeArtifacts(runDirectory).snapshots;
  const content = snapshots.physicalOutputContentRaw ?? snapshots.physicalOutputContent ?? {};
  return {
    snapshots,
    content,
    queue: content.subtitleQueue ?? snapshots.app?.subtitleQueue ?? {},
    watchSessionReport: snapshots.watchSessionReport ?? report.watchSessionReport ?? null,
  };
}

function inferFixturePaths(runDirectory, evidence) {
  const mediaPath = String(evidence.content?.sourceReference?.mediaPath ?? evidence.snapshots?.playback?.mediaPath ?? '');
  const basename = path.basename(mediaPath, path.extname(mediaPath));
  const fixtureRoot = path.resolve('scripts/testing/fixtures');
  const known = new Set(['watch-mode-en-original', 'watch-mode-en-conversation', 'watch-mode-en-technical']);
  if (known.has(basename)) {
    return { source: path.join(fixtureRoot, `${basename}.txt`), reference: path.join(fixtureRoot, `${basename}.zh-CN.txt`) };
  }
  const language = basename.match(/^watch-mode-general\.([\w-]+)$/)?.[1];
  if (language) {
    return { source: path.join(fixtureRoot, 'watch-mode-en-original.txt'), reference: path.join(fixtureRoot, 'multilingual', `${basename}.txt`) };
  }
  return { source: null, reference: null };
}

/** The documented chrF2 normalization shared with the desktop score engine. */
export function normalizeChrFText(value) {
  // Whitespace is formatting rather than lexical content. Punctuation and
  // case remain deliberate evidence, so they are not discarded or folded.
  return String(value ?? '').normalize('NFKC').replace(/\s+/gu, '');
}

function ngramCounts(characters, order) {
  const counts = new Map();
  for (let index = 0; index <= characters.length - order; index += 1) {
    const ngram = characters.slice(index, index + order).join('');
    counts.set(ngram, (counts.get(ngram) ?? 0) + 1);
  }
  return counts;
}

/**
 * Calculates chrF2 from Unicode-NFKC character 1–6 grams. The per-order
 * counts and aggregate precision/recall are retained for auditability.
 */
export function calculateChrF2(candidateText, referenceText) {
  const candidate = [...normalizeChrFText(candidateText)];
  const reference = [...normalizeChrFText(referenceText)];
  if (!candidate.length || !reference.length) return null;
  const orderLimit = Math.min(BENCHMARK_SCORE_V2_RULES.semantic.characterNgramOrder, candidate.length, reference.length);
  if (!orderLimit) return null;

  const orders = [];
  for (let order = 1; order <= orderLimit; order += 1) {
    const candidateCounts = ngramCounts(candidate, order);
    const referenceCounts = ngramCounts(reference, order);
    let matchedNgrams = 0;
    for (const [ngram, count] of candidateCounts) matchedNgrams += Math.min(count, referenceCounts.get(ngram) ?? 0);
    const candidateNgrams = candidate.length - order + 1;
    const referenceNgrams = reference.length - order + 1;
    orders.push({
      order,
      candidateNgrams,
      referenceNgrams,
      matchedNgrams,
      precision: matchedNgrams / candidateNgrams,
      recall: matchedNgrams / referenceNgrams,
    });
  }
  const precision = average(orders.map(({ precision: value }) => value)) ?? 0;
  const recall = average(orders.map(({ recall: value }) => value)) ?? 0;
  const beta = BENCHMARK_SCORE_V2_RULES.semantic.beta;
  const betaSquared = beta ** 2;
  const score = precision + recall === 0 ? 0 : (1 + betaSquared) * precision * recall / (betaSquared * precision + recall) * 100;
  return {
    metric: 'chrF2',
    normalization: 'Unicode NFKC; whitespace removed; case preserved',
    characterNgramOrder: BENCHMARK_SCORE_V2_RULES.semantic.characterNgramOrder,
    beta,
    candidateCharacters: candidate.length,
    referenceCharacters: reference.length,
    precision: round(precision * 100),
    recall: round(recall * 100),
    score: round(score),
    orders: orders.map((order) => ({ ...order, precision: round(order.precision * 100), recall: round(order.recall * 100) })),
  };
}

// Kept as a concise name for script callers; both exports use the same v1 math.
export const scoreChrF2 = calculateChrF2;

/** Returns response-relative latency rather than a whole-session offset. */
export function relativeResponseLatency(responseCreatedMs, eventMs, fallbackMs) {
  if (responseCreatedMs != null && eventMs != null) return Math.max(0, eventMs - responseCreatedMs);
  return fallbackMs != null && Number.isFinite(fallbackMs) ? Math.max(0, fallbackMs) : null;
}

/** The public v1 linear latency ramp. */
export function scoreLatencyRamp(valueMs, goodMs, badMs) {
  if (valueMs == null || !Number.isFinite(valueMs)) return null;
  if (valueMs <= goodMs) return 100;
  if (valueMs >= badMs) return 0;
  return round(100 * (badMs - valueMs) / (badMs - goodMs));
}

function latencyZone(valueMs, threshold) {
  if (valueMs == null) return 'missing';
  if (valueMs <= threshold.good) return 'good';
  if (valueMs >= threshold.bad) return 'slow';
  return 'linear';
}

function textFromContent(content, watchSessionReport) {
  const direct = [content?.translation, content?.subtitleText, content?.segmentTranslationText]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);
  if (direct.length) return [...new Set(direct)].join('\n');
  const fromCues = Array.isArray(watchSessionReport?.cues)
    ? watchSessionReport.cues.map((cue) => String(cue?.renderedText ?? cue?.publishedText ?? cue?.llmText ?? '').trim()).filter(Boolean)
    : [];
  return fromCues.join('\n');
}

function reportRunState(report, evidence) {
  const verdict = String(report?.verdict ?? '').toLowerCase();
  const status = String(report?.status ?? evidence?.watchSessionReport?.status ?? '').toLowerCase();
  if (verdict === 'passed' || status === 'completed' || status === 'passed') return 'completed';
  if (verdict === 'failed' || verdict === 'blocked' || status === 'failed' || status === 'error') return 'failed';
  return 'running';
}

function completedFromRawRun(raw, fallback) {
  if (typeof raw?.responseCompleted === 'boolean') return raw.responseCompleted;
  if (typeof raw?.completed === 'boolean') return raw.completed;
  if (raw?.responseDoneMs != null || raw?.responseDoneAtMs != null || raw?.responseDone === true) return true;
  if (raw?.status === 'completed' || raw?.status === 'passed') return true;
  return fallback;
}

function candidateFromRawRun(raw) {
  return String(raw?.candidateText ?? raw?.translationFinal ?? raw?.translation ?? raw?.finalTranslation ?? '').trim();
}

function millisecondsFromSeconds(value) {
  const seconds = optionalNonNegativeNumber(value);
  return seconds == null ? null : seconds * 1_000;
}

function highConfidenceAudioOrigin(origin) {
  return ['provider-offset', 'manual-audible', 'local-rms'].includes(String(origin ?? ''));
}

function normalizeRun(raw, index, defaults = {}) {
  const responseCreatedMs = optionalNonNegativeNumber(raw?.responseCreatedMs ?? raw?.responseCreatedAtMs);
  const firstTokenMs = optionalNonNegativeNumber(raw?.firstTokenMs ?? raw?.firstOutputMs ?? raw?.firstVisibleMs);
  const firstCommittedMs = optionalNonNegativeNumber(raw?.firstCommittedMs ?? raw?.firstFinalMs);
  // A producer may explicitly provide a response-relative duration, but the
  // legacy `timeToFirst*Ms` fields are whole-run clocks in desktop reports.
  // Never treat those legacy clocks as a substitute for responseCreated
  // diagnostic evidence only; benchmark-score/v2 uses audio-origin latency.
  const firstTokenFallbackMs = optionalNonNegativeNumber(raw?.firstTokenLatencyMs);
  const firstCommittedFallbackMs = optionalNonNegativeNumber(raw?.firstCommittedLatencyMs);
  const audioStartOrigin = String(raw?.audioStartOrigin ?? '').trim() || null;
  const audioToRenderFirstMs = optionalNonNegativeNumber(raw?.audioToRenderFirstMs);
  const audioToRenderFinalMs = optionalNonNegativeNumber(raw?.audioToRenderFinalMs);
  const responseCount = optionalNonNegativeNumber(raw?.responseCount);
  const extraResponses = optionalNonNegativeNumber(raw?.extraResponseCount ?? raw?.extraResponses ?? defaults.extraResponseCount);
  return {
    runIndex: Number.isInteger(Number(raw?.runIndex)) ? Number(raw.runIndex) : index,
    runId: String(raw?.runId ?? raw?.id ?? raw?.runIndex ?? `run-${index + 1}`),
    sourceText: String(raw?.sourceText ?? raw?.source ?? defaults.sourceText ?? '').trim(),
    translationFinal: candidateFromRawRun(raw),
    responseDone: completedFromRawRun(raw, defaults.responseDone ?? false),
    // A first response is free, but it must still be evidenced. Do not invent
    // a count of one when a raw run omitted its duplicate-response telemetry.
    responseCount: responseCount == null ? (extraResponses == null ? null : 1 + extraResponses) : responseCount,
    responseCreatedMs,
    firstTokenMs,
    firstCommittedMs,
    firstTokenFallbackMs,
    firstCommittedFallbackMs,
    audioStartedAtMs: optionalNonNegativeNumber(raw?.audioStartedAtMs),
    audioStartOrigin,
    sourceStableAtMs: optionalNonNegativeNumber(raw?.sourceStableAtMs),
    audioToSourceFirstMs: optionalNonNegativeNumber(raw?.audioToSourceFirstMs),
    audioToLlmFirstMs: optionalNonNegativeNumber(raw?.audioToLlmFirstMs),
    audioToRenderFirstMs,
    audioToRenderFinalMs,
    highConfidenceAudioOrigin: highConfidenceAudioOrigin(audioStartOrigin),
    // The legacy Watch queue timers start at cue_started, not at
    // responseCreated. Preserve them for diagnosis but never score them as
    // response-relative v1 latency evidence.
    legacyCueToFirstTokenLatencyMs: millisecondsFromSeconds(raw?.legacyCueToFirstTokenLatencySeconds ?? raw?.firstVisibleTranslationLatencySeconds),
    legacyCueToFirstCommittedLatencyMs: millisecondsFromSeconds(raw?.legacyCueToFirstCommittedLatencySeconds ?? raw?.firstFinalTranslationLatencySeconds),
  };
}

function normalizeRuns({ report, evidence, sourceText }) {
  const state = reportRunState(report, evidence);
  const rawRuns = Array.isArray(evidence?.runs) && evidence.runs.length
    ? evidence.runs
    : Array.isArray(report?.runs) && report.runs.length
      ? report.runs
      : null;
  const fallbackText = textFromContent(evidence?.content, evidence?.watchSessionReport);
  const queueExtraResponses = optionalNonNegativeNumber(evidence?.queue?.duplicateFinalTranslations);
  const representativeCue = Array.isArray(evidence?.watchSessionReport?.cues)
    ? evidence.watchSessionReport.cues.find((cue) => (
      cue?.translationState === 'final' && highConfidenceAudioOrigin(cue?.audioStartOrigin)
    ))
    : null;
  const runs = rawRuns
    ? rawRuns.map((raw, index) => normalizeRun(raw, index, { sourceText }))
    : [normalizeRun({
      runId: evidence?.watchSessionReport?.sessionId ?? 'watch-mode-session',
      sourceText,
      translationFinal: fallbackText,
      responseCompleted: state === 'completed',
      extraResponseCount: queueExtraResponses,
      audioStartedAtMs: representativeCue?.audioStartedAtMs,
      audioStartOrigin: representativeCue?.audioStartOrigin,
      sourceStableAtMs: representativeCue?.sourceStableAtMs,
      audioToSourceFirstMs: representativeCue?.audioToSourceFirstMs,
      audioToLlmFirstMs: representativeCue?.audioToLlmFirstMs,
      audioToRenderFirstMs: representativeCue?.audioToRenderFirstMs,
      audioToRenderFinalMs: representativeCue?.audioToRenderFinalMs,
      legacyCueToFirstTokenLatencySeconds: evidence?.queue?.firstVisibleTranslationLatencySeconds,
      legacyCueToFirstCommittedLatencySeconds: evidence?.queue?.firstFinalTranslationLatencySeconds,
    }, 0, { sourceText, responseDone: state === 'completed', extraResponseCount: queueExtraResponses })];
  const declared = optionalNonNegativeNumber(evidence?.declaredRunCount ?? evidence?.runCount ?? report?.summary?.runCount ?? report?.declaredRunCount);
  const declaredRuns = Math.max(runs.length, Math.trunc(declared ?? runs.length));
  return { runs, declaredRuns, benchmarkState: state };
}

function isCompletedRun(run) {
  return run.responseDone && run.translationFinal.length > 0;
}

function incompleteRuns(runs, declaredRuns) {
  const byIndex = new Map(runs.map((run) => [run.runIndex, run]));
  const indexes = new Set([...Array(declaredRuns).keys(), ...byIndex.keys()]);
  return [...indexes].sort((left, right) => left - right).flatMap((runIndex) => {
    const run = byIndex.get(runIndex);
    if (!run) return [{ runIndex, missing: ['run-record'] }];
    const missing = [];
    if (!run.responseDone) missing.push('response-done');
    if (!run.translationFinal) missing.push('final-translation');
    return missing.length ? [{ runIndex, missing }] : [];
  });
}

function hasAllJudgeEvidence(completedRunIndexes, judge) {
  if (!judge || !Array.isArray(judge.runs) || !judge.runs.length) return false;
  const judged = new Set(judge.runs.map(({ runIndex }) => runIndex));
  return completedRunIndexes.length > 0 && completedRunIndexes.every((runIndex) => judged.has(runIndex));
}

function judgeStateFor({ semanticJudge, judgeState, judgeError }) {
  if (judgeError || judgeState === 'failed') return 'failed';
  if (judgeState === 'running') return 'running';
  return semanticJudge ? 'completed' : 'idle';
}

function formulas(rules) {
  return {
    semantic: `(${rules.semantic.referenceWeight}% × mean(chrF2)) + (${rules.semantic.judgeWeight}% × mean(judge score))`,
    latency: 'mean(each run’s high-confidence audio → visible-first and audio → visible-final linear-ramp scores)',
    completeness: '100 × completed runs with a final translation ÷ declared runs',
    stability: `100 × successful runs ÷ declared runs − ${rules.stability.extraResponsePenalty} points per extra response (clamped to 0–100)`,
    total: '0.40 × semantic + 0.30 × latency + 0.20 × completeness + 0.10 × stability; official only when all four dimensions have complete evidence',
  };
}

/**
 * Common v2 score producer. Watch Mode converts its evidence into `runs` and
 * then applies the exact same public rules object and total formula as desktop.
 */
function scoreNormalized({ report, runs, declaredRuns, sourceText, referenceText, semanticJudge = null, judgeState = 'idle', judgeError = null, benchmarkState = 'running' }) {
  const rules = BENCHMARK_SCORE_V2_RULES;
  const completedRuns = runs.filter(isCompletedRun);
  const completedRunIndexes = completedRuns.map(({ runIndex }) => runIndex);
  const sourceTextAvailable = Boolean(String(sourceText ?? '').trim());
  const referenceTranslationAvailable = Boolean(String(referenceText ?? '').trim());
  const normalizedJudgeState = judgeStateFor({ semanticJudge, judgeState, judgeError });
  const referenceByRun = referenceTranslationAvailable
    ? completedRuns.flatMap((run) => {
      const chrF2 = calculateChrF2(run.translationFinal, referenceText);
      return chrF2 ? [{ runIndex: run.runIndex, chrF2 }] : [];
    })
    : [];
  const referenceAverage = average(referenceByRun.map(({ chrF2 }) => chrF2.score));
  const judgeRuns = semanticJudge?.runs ?? [];
  const judgeComplete = hasAllJudgeEvidence(completedRunIndexes, semanticJudge);
  const judgeScores = completedRunIndexes.flatMap((runIndex) => {
    const judgment = judgeRuns.find((item) => item.runIndex === runIndex);
    return judgment && Number.isFinite(judgment.score) ? [clamp(judgment.score)] : [];
  });
  const judgeAverage = judgeComplete ? average(judgeScores) : null;
  const semanticMissing = [];
  if (!sourceTextAvailable) semanticMissing.push('source-text');
  if (!referenceTranslationAvailable) semanticMissing.push('reference-translation');
  if (!completedRunIndexes.length) semanticMissing.push('completed-translation');
  if (referenceByRun.length !== completedRunIndexes.length) semanticMissing.push('chrF2-for-each-completed-run');
  if (!judgeComplete) semanticMissing.push('judge-result-for-each-completed-run');
  const semanticScore = semanticMissing.length === 0 && referenceAverage != null && judgeAverage != null
    ? round(referenceAverage * rules.semantic.referenceWeight / 100 + judgeAverage * rules.semantic.judgeWeight / 100)
    : null;
  const allFormulas = formulas(rules);
  const semantic = {
    score: semanticScore,
    status: semanticScore == null ? 'evidence-insufficient' : 'scored',
    weight: rules.dimensionWeights.semantic,
    formula: allFormulas.semantic,
    missingEvidence: semanticMissing,
    evidence: {
      sourceTextAvailable,
      referenceTranslationAvailable,
      completedRunIndexes,
      referenceByRun,
      referenceAverage: referenceAverage == null ? null : round(referenceAverage),
      judge: {
        state: normalizedJudgeState,
        model: semanticJudge?.model ?? null,
        rubricVersion: semanticJudge?.rubricVersion ?? null,
        judgedRunIndexes: judgeRuns.map(({ runIndex }) => runIndex),
        average: judgeAverage == null ? null : round(judgeAverage),
        runs: judgeRuns,
      },
    },
  };

  const latencySignals = runs.flatMap((run) => {
    const firstLatency = run.highConfidenceAudioOrigin ? run.audioToRenderFirstMs : null;
    const finalLatency = run.highConfidenceAudioOrigin ? run.audioToRenderFinalMs : null;
    const firstThreshold = rules.latencyMilliseconds.audioToRenderFirst;
    const finalThreshold = rules.latencyMilliseconds.audioToRenderFinal;
    return [
      {
        runIndex: run.runIndex,
        signal: 'audioToRenderFirst',
        audioStartOrigin: run.audioStartOrigin,
        highConfidence: run.highConfidenceAudioOrigin,
        latencyMs: firstLatency,
        score: scoreLatencyRamp(firstLatency, firstThreshold.good, firstThreshold.bad),
        threshold: clone(firstThreshold),
        zone: latencyZone(firstLatency, firstThreshold),
      },
      {
        runIndex: run.runIndex,
        signal: 'audioToRenderFinal',
        audioStartOrigin: run.audioStartOrigin,
        highConfidence: run.highConfidenceAudioOrigin,
        latencyMs: finalLatency,
        score: scoreLatencyRamp(finalLatency, finalThreshold.good, finalThreshold.bad),
        threshold: clone(finalThreshold),
        zone: latencyZone(finalLatency, finalThreshold),
      },
    ];
  });
  const latencyMissing = [];
  if (!declaredRuns) latencyMissing.push('declared-runs');
  if (runs.length < declaredRuns) latencyMissing.push('run-record-for-each-declared-run');
  for (const signal of latencySignals.filter(({ score }) => score == null)) latencyMissing.push(`run-${signal.runIndex}-${signal.signal}`);
  const latencyScores = latencySignals.flatMap(({ score }) => score == null ? [] : [score]);
  const latencyAverage = latencyMissing.length === 0 ? average(latencyScores) : null;
  const latency = {
    score: latencyAverage == null ? null : round(latencyAverage),
    status: latencyAverage == null ? 'evidence-insufficient' : 'scored',
    weight: rules.dimensionWeights.latency,
    formula: allFormulas.latency,
    missingEvidence: latencyMissing,
    evidence: { signals: latencySignals, average: latencyAverage == null ? null : round(latencyAverage) },
  };

  const unfinished = incompleteRuns(runs, declaredRuns);
  const completenessScore = declaredRuns ? round(100 * completedRuns.length / declaredRuns) : null;
  const completeness = {
    score: completenessScore,
    status: completenessScore == null ? 'evidence-insufficient' : 'scored',
    weight: rules.dimensionWeights.completeness,
    formula: allFormulas.completeness,
    missingEvidence: declaredRuns ? [] : ['declared-runs'],
    evidence: { declaredRuns, completedRuns: completedRuns.length, incompleteRuns: unfinished },
  };

  const stabilityMissing = [];
  if (!declaredRuns) stabilityMissing.push('declared-runs');
  if (runs.length < declaredRuns) stabilityMissing.push('run-record-for-each-declared-run');
  for (const run of runs) {
    if (run.responseCount == null) stabilityMissing.push(`run-${run.runIndex}-response-count`);
  }
  const deductions = runs.flatMap((run) => Array.from({ length: Math.max(0, Math.trunc(run.responseCount ?? 1) - 1) }, (_, index) => ({
    type: 'extra-response',
    runIndex: run.runIndex,
    responseOrdinal: index + 2,
    amount: rules.stability.extraResponsePenalty,
  })));
  const baseStability = declaredRuns ? 100 * completedRuns.length / declaredRuns : null;
  const totalDeduction = deductions.reduce((sum, deduction) => sum + deduction.amount, 0);
  const stabilityScore = baseStability == null || stabilityMissing.length ? null : round(clamp(baseStability - totalDeduction));
  const stability = {
    score: stabilityScore,
    status: stabilityScore == null ? 'evidence-insufficient' : 'scored',
    weight: rules.dimensionWeights.stability,
    formula: allFormulas.stability,
    missingEvidence: stabilityMissing,
    evidence: {
      declaredRuns,
      successfulRuns: completedRuns.length,
      failedRunIndexes: unfinished.map(({ runIndex }) => runIndex),
      baseScore: baseStability == null ? null : round(baseStability),
      deductions,
      totalDeduction,
    },
  };

  const dimensions = { semantic, latency, completeness, stability };
  const missing = Object.entries(dimensions).flatMap(([name, dimension]) =>
    dimension.status === 'scored' ? [] : dimension.missingEvidence.map((item) => `${name}:${item}`),
  );
  const benchmarkCompleted = benchmarkState === 'completed';
  const allDimensionsComplete = Object.values(dimensions).every((dimension) => dimension.status === 'scored');
  let status;
  if (benchmarkState === 'failed') status = 'benchmark-failed';
  else if (!benchmarkCompleted) status = 'benchmark-running';
  else if (normalizedJudgeState === 'running') status = 'judging';
  else if (normalizedJudgeState === 'failed') status = 'judge-failed';
  else if (!allDimensionsComplete) status = 'evidence-insufficient';
  else status = 'official';
  const total = status === 'official' ? calculateWeightedTotal(dimensions) : null;
  return {
    schemaVersion: BENCHMARK_SCORE_VERSION,
    version: BENCHMARK_SCORE_VERSION,
    status,
    total,
    grade: total == null ? null : gradeFor(total),
    weights: clone(rules.dimensionWeights),
    thresholds: {
      semantic: clone(rules.semantic),
      latencyMilliseconds: clone(rules.latencyMilliseconds),
      stability: clone(rules.stability),
      grades: clone(rules.grades),
    },
    dimensions,
    evidenceCoverage: {
      benchmarkCompleted,
      completeDimensions: Object.values(dimensions).filter((dimension) => dimension.status === 'scored').length,
      requiredDimensions: 4,
      missing,
    },
    formulas: allFormulas,
    deductions,
    judge: semantic.evidence.judge,
    // Watch Mode additions: preserve enough raw, non-secret evidence to see
    // how each run contributed to every dimension without reopening logs.
    run: {
      status: benchmarkState,
      mode: report?.mode ?? null,
      verdict: report?.verdict ?? null,
      failureLayer: report?.failureLayer ?? null,
      failureReason: report?.failureReason ?? null,
      declaredRuns,
    },
    runContributions: runs.map((run) => ({
      runIndex: run.runIndex,
      runId: run.runId,
      responseDone: run.responseDone,
      responseCount: run.responseCount,
      translationFinal: run.translationFinal,
      responseCreatedMs: run.responseCreatedMs,
      firstTokenMs: run.firstTokenMs,
      firstCommittedMs: run.firstCommittedMs,
      firstTokenLatencyMs: relativeResponseLatency(run.responseCreatedMs, run.firstTokenMs, run.firstTokenFallbackMs),
      firstCommittedLatencyMs: relativeResponseLatency(run.responseCreatedMs, run.firstCommittedMs, run.firstCommittedFallbackMs),
      audioStartedAtMs: run.audioStartedAtMs,
      audioStartOrigin: run.audioStartOrigin,
      sourceStableAtMs: run.sourceStableAtMs,
      audioToSourceFirstMs: run.audioToSourceFirstMs,
      audioToLlmFirstMs: run.audioToLlmFirstMs,
      audioToRenderFirstMs: run.audioToRenderFirstMs,
      audioToRenderFinalMs: run.audioToRenderFinalMs,
      highConfidenceAudioOrigin: run.highConfidenceAudioOrigin,
      legacyCueToFirstTokenLatencyMs: run.legacyCueToFirstTokenLatencyMs,
      legacyCueToFirstCommittedLatencyMs: run.legacyCueToFirstCommittedLatencyMs,
    })),
  };
}

export function gradeFor(score) {
  return BENCHMARK_SCORE_V2_RULES.grades.find(({ minimum }) => score >= minimum)?.grade ?? 'F';
}

export function calculateWeightedTotal(dimensions) {
  return round(Object.entries(BENCHMARK_SCORE_V2_RULES.dimensionWeights).reduce((sum, [name, weight]) => {
    const candidate = dimensions?.[name];
    const score = typeof candidate === 'object' ? candidate?.score : candidate;
    if (!Number.isFinite(score)) throw new Error(`Cannot calculate ${BENCHMARK_SCORE_VERSION} total: ${name} is missing.`);
    return sum + score * weight / 100;
  }, 0));
}

/** Direct semantic blending helper, including the documented 40/60 weights. */
export function combineLlmSemanticScore(referenceScoreOrDimensions, llmSemanticScore) {
  const referenceScore = typeof referenceScoreOrDimensions === 'object'
    ? referenceScoreOrDimensions.semantic
    : referenceScoreOrDimensions;
  if (!Number.isFinite(referenceScore) || !Number.isFinite(llmSemanticScore)) return null;
  const blended = round(
    clamp(referenceScore) * BENCHMARK_SCORE_V2_RULES.semantic.referenceWeight / 100
      + clamp(llmSemanticScore) * BENCHMARK_SCORE_V2_RULES.semantic.judgeWeight / 100,
  );
  return typeof referenceScoreOrDimensions === 'object'
    ? { ...referenceScoreOrDimensions, semantic: blended }
    : blended;
}

function attachScoreContext(score, context) {
  Object.defineProperty(score, '__scoreContext', { configurable: false, enumerable: false, value: context });
  return score;
}

/** Calculates deterministic v1 evidence; without a judge there is no total. */
export function scoreDeterministic({ report = {}, evidence = {}, referenceText = '', sourceText = '', benchmarkState = null }) {
  const normalized = normalizeRuns({ report, evidence, sourceText });
  const context = {
    report,
    runs: normalized.runs,
    declaredRuns: normalized.declaredRuns,
    sourceText,
    referenceText,
    benchmarkState: benchmarkState ?? normalized.benchmarkState,
  };
  return attachScoreContext(scoreNormalized(context), context);
}

/** Applies an LLM judge result to previously normalized deterministic evidence. */
export function finalizeBenchmarkScore(deterministic, judgeAttempt = null) {
  const context = deterministic?.__scoreContext;
  if (!context) throw new Error('finalizeBenchmarkScore requires an object returned by scoreDeterministic.');
  const status = judgeAttempt?.status ?? 'idle';
  const score = scoreNormalized({
    ...context,
    semanticJudge: status === 'passed' ? judgeAttempt.semanticJudge : null,
    judgeState: status === 'judging' ? 'running' : status === 'failed' ? 'failed' : 'idle',
    judgeError: status === 'failed' ? judgeAttempt.reason ?? 'LLM judge failed.' : null,
  });
  score.judgeAttempt = judgeAttempt == null ? {
    enabled: false,
    status: 'idle',
    model: null,
    rubricVersion: LLM_JUDGE_RUBRIC_VERSION,
    reason: 'LLM judge has not run yet.',
    runJudgments: [],
  } : clone(judgeAttempt);
  return attachScoreContext(score, context);
}

function extractJson(text) {
  if (typeof text === 'object' && text != null) return text;
  const source = String(text ?? '');
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  const json = fenced ?? (start >= 0 && end >= start ? source.slice(start, end + 1) : '');
  if (!json) throw new Error('LLM judge did not return a JSON object.');
  return JSON.parse(json);
}

function validJudgeScore(value, field) {
  if (!Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 100) {
    throw new Error(`LLM judge returned an invalid ${field} score; expected a number from 0 to 100.`);
  }
  return round(Number(value));
}

function normalizeCriticalErrors(value) {
  if (!Array.isArray(value)) return [];
  return value.map((error) => {
    if (typeof error === 'string') return { category: 'unspecified', description: error, sourceEvidence: null, candidateEvidence: null };
    const evidence = error?.evidence ?? {};
    return {
      category: String(error?.category ?? 'unspecified'),
      description: String(error?.description ?? error?.message ?? ''),
      sourceEvidence: error?.sourceEvidence ?? error?.sourceExcerpt ?? evidence.sourceEvidence ?? evidence.sourceExcerpt ?? null,
      candidateEvidence: error?.candidateEvidence ?? error?.candidateExcerpt ?? evidence.candidateEvidence ?? evidence.candidateExcerpt ?? null,
    };
  }).filter((error) => error.description);
}

export function parseLlmJudgeResponse(content, { model, runIndex = 0 } = {}) {
  const judged = extractJson(content);
  const fields = BENCHMARK_SCORE_V2_RULES.semantic.judgeSubscores;
  const subscores = Object.fromEntries(fields.map((field) => [field, validJudgeScore(judged[field], field)]));
  const rationale = String(judged.rationale ?? '').trim();
  if (!rationale) throw new Error('LLM judge did not provide a rationale.');
  if (!Array.isArray(judged.criticalErrors)) {
    throw new Error('LLM judge did not provide a criticalErrors array.');
  }
  const criticalErrors = normalizeCriticalErrors(judged.criticalErrors);
  if (
    criticalErrors.length !== judged.criticalErrors.length
    || criticalErrors.some((error) => error.sourceEvidence == null || error.candidateEvidence == null)
  ) {
    throw new Error('LLM judge criticalErrors must include auditable source and candidate evidence.');
  }
  return {
    model: String(model ?? ''),
    rubricVersion: String(judged.rubricVersion ?? LLM_JUDGE_RUBRIC_VERSION),
    run: {
      runIndex,
      score: round(average(fields.map((field) => subscores[field]))),
      subscores,
      rationale,
      criticalErrors,
    },
  };
}

export async function judgeWithLlm({ sourceText, referenceText, candidateText, targetLanguage, endpoint, apiKey, model, runIndex = 0, fetchImpl = globalThis.fetch }) {
  if (typeof fetchImpl !== 'function') throw new Error('No fetch implementation is available for the LLM judge.');
  const rubric = {
    adequacy: 'Semantic fidelity: preserve meaning, relationships, and intent.',
    factsTerminology: 'Names, terms, facts, numbers, dates, money, units, and technical language.',
    omissionsAdditions: 'Do not omit important content or add unsupported content.',
    fluency: 'Natural, grammatical target-language expression appropriate to the source.',
  };
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `You are a strict translation benchmark judge. Return JSON only with rubricVersion, ${BENCHMARK_SCORE_V2_RULES.semantic.judgeSubscores.join(', ')}, rationale, and criticalErrors. Each score must be 0-100. Each criticalErrors item must include category, description, sourceEvidence, and candidateEvidence. Rubric: ${JSON.stringify(rubric)}`,
        },
        { role: 'user', content: JSON.stringify({ sourceText, referenceText, candidateText, targetLanguage }) },
      ],
    }),
  });
  if (!response.ok) {
    // Do not persist an arbitrary proxy error body; it could reflect a secret.
    throw new Error(`LLM judge HTTP ${response.status}.`);
  }
  const envelope = await response.json();
  return parseLlmJudgeResponse(envelope.choices?.[0]?.message?.content, { model, runIndex });
}

function safeError(error) {
  return (error instanceof Error ? error.message : String(error)).replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
}

/** Judges every completed run separately, then preserves each result. */
export async function judgeValidRuns({ runs, sourceText, referenceText, targetLanguage, endpoint, apiKey, model, fetchImpl }) {
  // Accept the normalized Watch Mode records used by scoreRun, while keeping
  // this exported helper convenient for callers that pass report-style runs.
  const normalizedRuns = runs.map((run, index) => (
    Object.hasOwn(run, 'responseDone') && Object.hasOwn(run, 'translationFinal')
      ? run
      : normalizeRun(run, index)
  ));
  const eligibleRuns = normalizedRuns.filter(isCompletedRun);
  if (!String(referenceText ?? '').trim()) {
    return { enabled: false, status: 'missing-reference', model: model ?? null, rubricVersion: LLM_JUDGE_RUBRIC_VERSION, reason: 'A verified reference translation is required before the LLM judge can run.', runJudgments: [] };
  }
  if (!String(sourceText ?? '').trim()) {
    return { enabled: false, status: 'missing-source', model: model ?? null, rubricVersion: LLM_JUDGE_RUBRIC_VERSION, reason: 'Source text is required before the LLM judge can run.', runJudgments: [] };
  }
  if (!eligibleRuns.length) {
    return { enabled: false, status: 'missing-candidate', model: model ?? null, rubricVersion: LLM_JUDGE_RUBRIC_VERSION, reason: 'No completed run has a final translation for LLM judgment.', runJudgments: [] };
  }
  const runJudgments = [];
  let rubricVersion = LLM_JUDGE_RUBRIC_VERSION;
  for (const run of eligibleRuns) {
    try {
      const judged = await judgeWithLlm({
        sourceText,
        referenceText,
        candidateText: run.translationFinal,
        targetLanguage,
        endpoint,
        apiKey,
        model,
        runIndex: run.runIndex,
        fetchImpl,
      });
      rubricVersion = judged.rubricVersion;
      runJudgments.push(judged.run);
    } catch (error) {
      return { enabled: true, status: 'failed', model, rubricVersion, reason: safeError(error), runJudgments };
    }
  }
  return {
    enabled: true,
    status: 'passed',
    model,
    rubricVersion,
    semanticJudge: {
      model,
      rubricVersion,
      score: round(average(runJudgments.map((run) => run.score))),
      runs: runJudgments,
    },
    runJudgments,
  };
}

function booleanOption(value) {
  if (typeof value === 'boolean') return value;
  if (value == null) return null;
  if (/^(1|true|yes)$/i.test(String(value))) return true;
  if (/^(0|false|no)$/i.test(String(value))) return false;
  return null;
}

function resolveJudgeSettings(options) {
  const environmentSetting = booleanOption(process.env.OMNI_BENCHMARK_LLM_JUDGE);
  const requested = booleanOption(options.llmJudge);
  const apiKeyEnv = String(options.apiKeyEnv ?? process.env.OMNI_BENCHMARK_JUDGE_API_KEY_ENV ?? 'DASHSCOPE_API_KEY');
  return {
    disabled: options.noLlmJudge === true || requested === false || environmentSetting === false,
    model: String(options.judgeModel ?? process.env.OMNI_BENCHMARK_JUDGE_MODEL ?? DEFAULT_JUDGE_MODEL),
    endpoint: String(options.endpoint ?? process.env.OMNI_BENCHMARK_JUDGE_ENDPOINT ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'),
    apiKey: process.env[apiKeyEnv],
    apiKeyEnv,
  };
}

async function runAutomaticJudge({ deterministic, sourceText, referenceText, options }) {
  if (deterministic.run.status !== 'completed') {
    return { enabled: false, status: 'skipped', model: null, rubricVersion: LLM_JUDGE_RUBRIC_VERSION, reason: 'The benchmark did not complete, so no LLM judge request was made.', runJudgments: [] };
  }
  if (deterministic.run.mode === 'dry-run') {
    return { enabled: false, status: 'skipped', model: null, rubricVersion: LLM_JUDGE_RUBRIC_VERSION, reason: 'Dry-run fixtures never call an external LLM judge.', runJudgments: [] };
  }
  if (!String(sourceText ?? '').trim()) {
    return { enabled: false, status: 'missing-source', model: null, rubricVersion: LLM_JUDGE_RUBRIC_VERSION, reason: 'Source text is unavailable, so no LLM judge request was made.', runJudgments: [] };
  }
  if (!String(referenceText ?? '').trim()) {
    return { enabled: false, status: 'missing-reference', model: null, rubricVersion: LLM_JUDGE_RUBRIC_VERSION, reason: 'Reference translation is unavailable, so no LLM judge request was made.', runJudgments: [] };
  }
  const settings = resolveJudgeSettings(options);
  if (settings.disabled) {
    return { enabled: false, status: 'idle', model: settings.model, rubricVersion: LLM_JUDGE_RUBRIC_VERSION, reason: 'LLM judge is disabled; rerun without --no-llm-judge to request a formal score.', runJudgments: [] };
  }
  if (!settings.model) {
    return { enabled: false, status: 'missing-model', model: null, rubricVersion: LLM_JUDGE_RUBRIC_VERSION, reason: 'No LLM judge model is selected.', runJudgments: [] };
  }
  if (!settings.apiKey) {
    return { enabled: false, status: 'missing-credentials', model: settings.model, rubricVersion: LLM_JUDGE_RUBRIC_VERSION, reason: `No credential is available in ${settings.apiKeyEnv}; no LLM judge request was made.`, runJudgments: [] };
  }
  return judgeValidRuns({
    runs: deterministic.__scoreContext.runs,
    sourceText,
    referenceText,
    targetLanguage: options.targetLanguage ?? 'unknown',
    endpoint: settings.endpoint,
    apiKey: settings.apiKey,
    model: settings.model,
  });
}

export async function scoreRun(options) {
  const runDirectory = path.resolve(options.input);
  const reportPath = options.report ? path.resolve(options.report) : path.join(runDirectory, 'report.json');
  const report = readJson(reportPath);
  const evidence = findEvidence(runDirectory, report);
  const inferred = inferFixturePaths(runDirectory, evidence);
  const referencePath = options.reference ? path.resolve(options.reference) : inferred.reference;
  const sourcePath = options.source ? path.resolve(options.source) : inferred.source;
  const referenceText = referencePath && fs.existsSync(referencePath) ? readText(referencePath) : '';
  const sourceText = sourcePath && fs.existsSync(sourcePath) ? readText(sourcePath) : '';
  const deterministic = scoreDeterministic({ report, evidence, referenceText, sourceText });
  const judgeAttempt = await runAutomaticJudge({ deterministic, sourceText, referenceText, options });
  const result = {
    ...finalizeBenchmarkScore(deterministic, judgeAttempt),
    generatedAt: new Date().toISOString(),
    provenance: { runDirectory, reportPath, sourcePath, referencePath },
  };
  const output = path.resolve(options.output ?? path.join(runDirectory, 'benchmark-score.json'));
  fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return { result, output };
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue;
    const key = argv[index].slice(2).replace(/-([a-z])/g, (_, character) => character.toUpperCase());
    result[key] = argv[index + 1]?.startsWith('--') || argv[index + 1] == null ? true : argv[++index];
  }
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (!options.input) throw new Error('--input <run-directory> is required');
    const { result, output } = await scoreRun(options);
    console.log(JSON.stringify({ output, status: result.status, total: result.total, grade: result.grade, runStatus: result.run.status, llmJudge: result.judgeAttempt.status }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
