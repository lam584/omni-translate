import scoreRulesJson from '../../../../../contracts/benchmark-score-v1-rules.json';
import type { BenchmarkReport, BenchmarkRunResult } from '../../runtime/benchmark-runtime';

/**
 * Public, versioned scoring rules shared with the Watch Mode tooling.
 *
 * Keep the values in the JSON contract rather than duplicating magic numbers
 * in the renderer.  The score object persists this exact rules snapshot so a
 * historical result remains explainable after a future rubric change.
 */
export const BENCHMARK_SCORE_VERSION = 'benchmark-score/v1' as const;

export type BenchmarkScoreGrade = 'A' | 'B' | 'C' | 'D' | 'F';
export type BenchmarkScoreStatus =
  | 'official'
  | 'benchmark-running'
  | 'judging'
  | 'evidence-insufficient'
  | 'judge-failed'
  | 'benchmark-failed';
export type BenchmarkDimensionStatus = 'scored' | 'evidence-insufficient';
export type BenchmarkJudgeState = 'idle' | 'running' | 'failed' | 'completed';
export type BenchmarkRunState = 'running' | 'completed' | 'failed';

export type BenchmarkScoreV1Rules = {
  $schema: string;
  title: string;
  schemaVersion: typeof BENCHMARK_SCORE_VERSION;
  dimensionWeights: {
    semantic: number;
    latency: number;
    completeness: number;
    stability: number;
  };
  semantic: {
    referenceMetric: 'chrF2';
    characterNgramOrder: number;
    beta: number;
    referenceWeight: number;
    judgeWeight: number;
    judgeSubscores: readonly BenchmarkJudgeSubscoreKey[];
  };
  latencyMilliseconds: {
    firstToken: { good: number; bad: number };
    firstCommitted: { good: number; bad: number };
  };
  stability: { extraResponsePenalty: number };
  grades: readonly { grade: BenchmarkScoreGrade; minimum: number }[];
};

export const BENCHMARK_SCORE_V1_RULES = scoreRulesJson as BenchmarkScoreV1Rules;

export type BenchmarkJudgeSubscoreKey =
  | 'adequacy'
  | 'factsTerminology'
  | 'omissionsAdditions'
  | 'fluency';

export type BenchmarkJudgeCriticalError = {
  category: string;
  description: string;
  sourceEvidence?: string | null;
  candidateEvidence?: string | null;
};

export type BenchmarkJudgeRunEvidence = {
  runIndex: number;
  score: number;
  subscores: Record<BenchmarkJudgeSubscoreKey, number>;
  rationale: string;
  criticalErrors: BenchmarkJudgeCriticalError[];
};

/** Evidence returned by the judge.  It intentionally contains no credential. */
export type BenchmarkSemanticJudgeEvidence = {
  model: string;
  rubricVersion: string;
  score: number;
  runs: BenchmarkJudgeRunEvidence[];
};

export type ChrF2NgramEvidence = {
  order: number;
  candidateNgrams: number;
  referenceNgrams: number;
  matchedNgrams: number;
  precision: number;
  recall: number;
};

export type ChrF2Evidence = {
  metric: 'chrF2';
  normalization: 'Unicode NFKC; whitespace removed; case preserved';
  characterNgramOrder: number;
  beta: number;
  candidateCharacters: number;
  referenceCharacters: number;
  precision: number;
  recall: number;
  score: number;
  orders: ChrF2NgramEvidence[];
};

export type BenchmarkDimension<TEvidence> = {
  score: number | null;
  status: BenchmarkDimensionStatus;
  weight: number;
  formula: string;
  evidence: TEvidence;
  missingEvidence: string[];
};

export type SemanticDimensionEvidence = {
  sourceTextAvailable: boolean;
  referenceTranslationAvailable: boolean;
  completedRunIndexes: number[];
  referenceByRun: Array<{ runIndex: number; chrF2: ChrF2Evidence }>;
  referenceAverage: number | null;
  judge: {
    state: BenchmarkJudgeState;
    model: string | null;
    rubricVersion: string | null;
    judgedRunIndexes: number[];
    average: number | null;
    runs: BenchmarkJudgeRunEvidence[];
  };
};

export type LatencySignalEvidence = {
  runIndex: number;
  signal: 'firstToken' | 'firstCommitted';
  latencyMs: number | null;
  score: number | null;
  threshold: { good: number; bad: number };
  zone: 'good' | 'linear' | 'slow' | 'missing';
};

export type LatencyDimensionEvidence = {
  signals: LatencySignalEvidence[];
  average: number | null;
};

export type IncompleteRunEvidence = {
  runIndex: number;
  missing: Array<'run-record' | 'response-done' | 'final-translation'>;
};

export type CompletenessDimensionEvidence = {
  declaredRuns: number;
  completedRuns: number;
  incompleteRuns: IncompleteRunEvidence[];
};

export type StabilityDeduction = {
  type: 'extra-response';
  runIndex: number;
  responseOrdinal: number;
  amount: number;
};

export type StabilityDimensionEvidence = {
  declaredRuns: number;
  successfulRuns: number;
  failedRunIndexes: number[];
  baseScore: number | null;
  deductions: StabilityDeduction[];
  totalDeduction: number;
};

export type BenchmarkScoreEvidenceCoverage = {
  benchmarkCompleted: boolean;
  completeDimensions: number;
  requiredDimensions: number;
  missing: string[];
};

/** The complete public record stored/exported for a v1 benchmark score. */
export type BenchmarkScoreV1 = {
  schemaVersion: typeof BENCHMARK_SCORE_VERSION;
  version: typeof BENCHMARK_SCORE_VERSION;
  status: BenchmarkScoreStatus;
  total: number | null;
  grade: BenchmarkScoreGrade | null;
  weights: BenchmarkScoreV1Rules['dimensionWeights'];
  thresholds: Pick<BenchmarkScoreV1Rules, 'semantic' | 'latencyMilliseconds' | 'stability' | 'grades'>;
  dimensions: {
    semantic: BenchmarkDimension<SemanticDimensionEvidence>;
    latency: BenchmarkDimension<LatencyDimensionEvidence>;
    completeness: BenchmarkDimension<CompletenessDimensionEvidence>;
    stability: BenchmarkDimension<StabilityDimensionEvidence>;
  };
  evidenceCoverage: BenchmarkScoreEvidenceCoverage;
  formulas: {
    semantic: string;
    latency: string;
    completeness: string;
    stability: string;
    total: string;
  };
  deductions: StabilityDeduction[];
  judge: SemanticDimensionEvidence['judge'];
};

/** Kept as a source-compatible name for diagnostics callers. */
export type BenchmarkResultScore = BenchmarkScoreV1;

export type BenchmarkScoreOptions = {
  sourceText?: string | null;
  referenceTranslation?: string | null;
  semanticJudge?: BenchmarkSemanticJudgeEvidence | null;
  judgeState?: BenchmarkJudgeState;
  judgeError?: string | null;
  /** Explicit preflight evidence gaps, such as no selected judge or credential. */
  judgeMissingEvidence?: readonly string[];
  /** Selected judge metadata remains visible before a result is returned. */
  judgeModel?: string | null;
  judgeRubricVersion?: string | null;
  benchmarkState?: BenchmarkRunState;
};

const clamp = (value: number) => Math.min(100, Math.max(0, value));
const round = (value: number) => Number(value.toFixed(1));

function finiteNumber(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value);
}

function average(values: readonly number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function completedRun(run: BenchmarkRunResult): boolean {
  return run.responseDoneMs != null && run.translationFinal.trim().length > 0;
}

function declaredRunCount(report: BenchmarkReport): number {
  return Math.max(report.summary.runCount, report.runs.length);
}

function scoreGrade(score: number): BenchmarkScoreGrade {
  return BENCHMARK_SCORE_V1_RULES.grades.find(({ minimum }) => score >= minimum)?.grade ?? 'F';
}

function normalizeChrFText(value: string): string {
  // chrF works on character n-grams. Whitespace is not lexical content and
  // would otherwise dominate translated CJK text; punctuation and casing are
  // deliberately retained so this is a documented, reproducible metric.
  return value.normalize('NFKC').replace(/\s+/gu, '');
}

function ngramCounts(characters: readonly string[], order: number): Map<string, number> {
  const counts = new Map<string, number>();
  for (let start = 0; start <= characters.length - order; start += 1) {
    const ngram = characters.slice(start, start + order).join('');
    counts.set(ngram, (counts.get(ngram) ?? 0) + 1);
  }
  return counts;
}

/**
 * Calculates chrF2 from Unicode NFKC-normalized character 1–6 grams.
 * The score is null only when one side has no comparable characters.
 */
export function calculateChrF2(candidateText: string, referenceText: string): ChrF2Evidence | null {
  const candidate = [...normalizeChrFText(candidateText)];
  const reference = [...normalizeChrFText(referenceText)];
  if (!candidate.length || !reference.length) return null;

  const orderLimit = Math.min(
    BENCHMARK_SCORE_V1_RULES.semantic.characterNgramOrder,
    candidate.length,
    reference.length,
  );
  if (!orderLimit) return null;

  const orders: ChrF2NgramEvidence[] = [];
  for (let order = 1; order <= orderLimit; order += 1) {
    const candidateCounts = ngramCounts(candidate, order);
    const referenceCounts = ngramCounts(reference, order);
    let matchedNgrams = 0;
    for (const [ngram, count] of candidateCounts) {
      matchedNgrams += Math.min(count, referenceCounts.get(ngram) ?? 0);
    }
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
  const beta = BENCHMARK_SCORE_V1_RULES.semantic.beta;
  const betaSquared = beta ** 2;
  const score = precision + recall === 0
    ? 0
    : ((1 + betaSquared) * precision * recall) / (betaSquared * precision + recall) * 100;

  return {
    metric: 'chrF2',
    normalization: 'Unicode NFKC; whitespace removed; case preserved',
    characterNgramOrder: BENCHMARK_SCORE_V1_RULES.semantic.characterNgramOrder,
    beta,
    candidateCharacters: candidate.length,
    referenceCharacters: reference.length,
    precision: round(precision * 100),
    recall: round(recall * 100),
    score: round(score),
    orders: orders.map((order) => ({
      ...order,
      precision: round(order.precision * 100),
      recall: round(order.recall * 100),
    })),
  };
}

/** Returns the response-relative latency, never the full audio-session offset. */
export function relativeResponseLatency(
  responseCreatedMs: number | null,
  eventMs: number | null,
): number | null {
  if (finiteNumber(responseCreatedMs) && finiteNumber(eventMs)) {
    return Math.max(0, eventMs - responseCreatedMs);
  }
  return null;
}

/** Public linear latency ramp used by both benchmark score producers. */
export function scoreLatencyRamp(valueMs: number | null, goodMs: number, badMs: number): number | null {
  if (!finiteNumber(valueMs)) return null;
  if (valueMs <= goodMs) return 100;
  if (valueMs >= badMs) return 0;
  return round(100 * (badMs - valueMs) / (badMs - goodMs));
}

function latencyZone(valueMs: number | null, threshold: { good: number; bad: number }): LatencySignalEvidence['zone'] {
  if (!finiteNumber(valueMs)) return 'missing';
  if (valueMs <= threshold.good) return 'good';
  if (valueMs >= threshold.bad) return 'slow';
  return 'linear';
}

function incompleteRuns(report: BenchmarkReport, declaredRuns: number): IncompleteRunEvidence[] {
  const runByIndex = new Map(report.runs.map((run) => [run.runIndex, run]));
  const knownIndexes = new Set<number>([...Array(declaredRuns).keys(), ...runByIndex.keys()]);
  return [...knownIndexes]
    .sort((left, right) => left - right)
    .flatMap((runIndex) => {
      const run = runByIndex.get(runIndex);
      if (!run) return [{ runIndex, missing: ['run-record'] }];
      const missing: IncompleteRunEvidence['missing'] = [];
      if (run.responseDoneMs == null) missing.push('response-done');
      if (!run.translationFinal.trim()) missing.push('final-translation');
      return missing.length ? [{ runIndex, missing }] : [];
    });
}

function hasAllJudgeEvidence(
  completedRunIndexes: readonly number[],
  judge: BenchmarkSemanticJudgeEvidence | null | undefined,
): boolean {
  if (!judge || !judge.runs.length) return false;
  const judged = new Set(judge.runs.map(({ runIndex }) => runIndex));
  return completedRunIndexes.length > 0 && completedRunIndexes.every((runIndex) => judged.has(runIndex));
}

/**
 * Scores a completed benchmark report using benchmark-score/v1.  A total is
 * intentionally produced only for an official score; dimensions are still
 * exposed with their evidence while a user needs to supply/retry judging.
 */
export function scoreBenchmarkReport(
  report: BenchmarkReport,
  options: BenchmarkScoreOptions = {},
): BenchmarkScoreV1 {
  const rules = BENCHMARK_SCORE_V1_RULES;
  const declaredRuns = declaredRunCount(report);
  const completedRuns = report.runs.filter(completedRun);
  const completedRunIndexes = completedRuns.map(({ runIndex }) => runIndex);
  const sourceTextAvailable = Boolean(options.sourceText?.trim());
  const referenceTranslationAvailable = Boolean(options.referenceTranslation?.trim());
  const judgeState = options.judgeError ? 'failed' : options.judgeState ?? (options.semanticJudge ? 'completed' : 'idle');

  const referenceByRun = referenceTranslationAvailable
    ? completedRuns.flatMap((run) => {
      const chrF2 = calculateChrF2(run.translationFinal, options.referenceTranslation!);
      return chrF2 ? [{ runIndex: run.runIndex, chrF2 }] : [];
    })
    : [];
  const referenceAverage = average(referenceByRun.map(({ chrF2 }) => chrF2.score));
  const judgeRuns = options.semanticJudge?.runs ?? [];
  const judgedRunIndexes = judgeRuns.map(({ runIndex }) => runIndex);
  const judgeComplete = hasAllJudgeEvidence(completedRunIndexes, options.semanticJudge);
  const judgeScores = completedRunIndexes.flatMap((runIndex) => {
    const judged = judgeRuns.find((item) => item.runIndex === runIndex);
    return judged && finiteNumber(judged.score) ? [clamp(judged.score)] : [];
  });
  const judgeAverage = judgeComplete ? average(judgeScores) : null;
  const semanticMissing: string[] = [];
  if (!sourceTextAvailable) semanticMissing.push('source-text');
  if (!referenceTranslationAvailable) semanticMissing.push('reference-translation');
  if (!completedRunIndexes.length) semanticMissing.push('completed-translation');
  if (referenceByRun.length !== completedRunIndexes.length) semanticMissing.push('chrF2-for-each-completed-run');
  if (!judgeComplete) {
    const explicitJudgeGaps = options.judgeMissingEvidence?.filter(Boolean) ?? [];
    semanticMissing.push(...(explicitJudgeGaps.length ? explicitJudgeGaps : ['judge-result-for-each-completed-run']));
  }
  const semanticScore = semanticMissing.length === 0 && referenceAverage != null && judgeAverage != null
    ? round(referenceAverage * rules.semantic.referenceWeight / 100 + judgeAverage * rules.semantic.judgeWeight / 100)
    : null;
  const semantic: BenchmarkDimension<SemanticDimensionEvidence> = {
    score: semanticScore,
    status: semanticScore == null ? 'evidence-insufficient' : 'scored',
    weight: rules.dimensionWeights.semantic,
    formula: `(${rules.semantic.referenceWeight}% × mean(chrF2)) + (${rules.semantic.judgeWeight}% × mean(judge score))`,
    missingEvidence: semanticMissing,
    evidence: {
      sourceTextAvailable,
      referenceTranslationAvailable,
      completedRunIndexes,
      referenceByRun,
      referenceAverage: referenceAverage == null ? null : round(referenceAverage),
      judge: {
        state: judgeState,
        model: options.semanticJudge?.model ?? options.judgeModel ?? null,
        rubricVersion: options.semanticJudge?.rubricVersion ?? options.judgeRubricVersion ?? null,
        judgedRunIndexes,
        average: judgeAverage == null ? null : round(judgeAverage),
        runs: judgeRuns,
      },
    },
  };

  const latencySignals: LatencySignalEvidence[] = report.runs.flatMap((run) => {
    // `timeToFirst*Ms` in the desktop report predates v1 and is a
    // whole-run timestamp, not independently verified response-relative
    // evidence. Never use it to fill a missing responseCreated event.
    const firstTokenLatency = relativeResponseLatency(run.responseCreatedMs, run.firstOutputMs);
    const firstCommittedLatency = relativeResponseLatency(run.responseCreatedMs, run.firstCommittedMs);
    const firstTokenThreshold = rules.latencyMilliseconds.firstToken;
    const firstCommittedThreshold = rules.latencyMilliseconds.firstCommitted;
    return [
      {
        runIndex: run.runIndex,
        signal: 'firstToken' as const,
        latencyMs: firstTokenLatency,
        score: scoreLatencyRamp(firstTokenLatency, firstTokenThreshold.good, firstTokenThreshold.bad),
        threshold: firstTokenThreshold,
        zone: latencyZone(firstTokenLatency, firstTokenThreshold),
      },
      {
        runIndex: run.runIndex,
        signal: 'firstCommitted' as const,
        latencyMs: firstCommittedLatency,
        score: scoreLatencyRamp(firstCommittedLatency, firstCommittedThreshold.good, firstCommittedThreshold.bad),
        threshold: firstCommittedThreshold,
        zone: latencyZone(firstCommittedLatency, firstCommittedThreshold),
      },
    ];
  });
  const latencyMissing: string[] = [];
  if (!declaredRuns) latencyMissing.push('declared-runs');
  if (report.runs.length < declaredRuns) latencyMissing.push('run-record-for-each-declared-run');
  for (const signal of latencySignals.filter(({ score }) => score == null)) {
    latencyMissing.push(`run-${signal.runIndex}-${signal.signal}`);
  }
  const latencyScores = latencySignals.flatMap(({ score }) => score == null ? [] : [score]);
  const latencyAverage = latencyMissing.length === 0 ? average(latencyScores) : null;
  const latency: BenchmarkDimension<LatencyDimensionEvidence> = {
    score: latencyAverage == null ? null : round(latencyAverage),
    status: latencyAverage == null ? 'evidence-insufficient' : 'scored',
    weight: rules.dimensionWeights.latency,
    formula: 'mean(each run’s response-created → first-token and response-created → first-committed linear-ramp scores)',
    missingEvidence: latencyMissing,
    evidence: { signals: latencySignals, average: latencyAverage == null ? null : round(latencyAverage) },
  };

  const unfinished = incompleteRuns(report, declaredRuns);
  const completenessScore = declaredRuns ? round(100 * completedRuns.length / declaredRuns) : null;
  const completeness: BenchmarkDimension<CompletenessDimensionEvidence> = {
    score: completenessScore,
    status: completenessScore == null ? 'evidence-insufficient' : 'scored',
    weight: rules.dimensionWeights.completeness,
    formula: '100 × completed runs with a final translation ÷ declared runs',
    missingEvidence: declaredRuns ? [] : ['declared-runs'],
    evidence: {
      declaredRuns,
      completedRuns: completedRuns.length,
      incompleteRuns: unfinished,
    },
  };

  const stabilityMissing: string[] = [];
  if (!declaredRuns) stabilityMissing.push('declared-runs');
  if (report.runs.length < declaredRuns) stabilityMissing.push('run-record-for-each-declared-run');
  for (const run of report.runs) {
    if (!Number.isInteger(run.responseCount) || run.responseCount < 0) {
      stabilityMissing.push(`run-${run.runIndex}-response-count`);
    }
  }
  const deductions: StabilityDeduction[] = report.runs.flatMap((run) =>
    !Number.isInteger(run.responseCount) || run.responseCount < 0
      ? []
      : Array.from({ length: Math.max(0, run.responseCount - 1) }, (_, index) => ({
      type: 'extra-response' as const,
      runIndex: run.runIndex,
      responseOrdinal: index + 2,
      amount: rules.stability.extraResponsePenalty,
      })),
  );
  const baseStability = declaredRuns ? 100 * completedRuns.length / declaredRuns : null;
  const totalDeduction = deductions.reduce((sum, deduction) => sum + deduction.amount, 0);
  const stabilityScore = baseStability == null || stabilityMissing.length ? null : round(clamp(baseStability - totalDeduction));
  const stability: BenchmarkDimension<StabilityDimensionEvidence> = {
    score: stabilityScore,
    status: stabilityScore == null ? 'evidence-insufficient' : 'scored',
    weight: rules.dimensionWeights.stability,
    formula: `100 × successful runs ÷ declared runs − ${rules.stability.extraResponsePenalty} points per extra response (clamped to 0–100)`,
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
  const benchmarkCompleted = options.benchmarkState === 'completed'
    || (options.benchmarkState == null && declaredRuns > 0 && report.runs.length >= declaredRuns);
  const allDimensionsComplete = Object.values(dimensions).every((dimension) => dimension.status === 'scored');
  let status: BenchmarkScoreStatus;
  if (options.benchmarkState === 'failed') {
    status = 'benchmark-failed';
  } else if (!benchmarkCompleted) {
    status = 'benchmark-running';
  } else if (judgeState === 'running') {
    status = 'judging';
  } else if (judgeState === 'failed') {
    status = 'judge-failed';
  } else if (!allDimensionsComplete) {
    status = 'evidence-insufficient';
  } else {
    status = 'official';
  }
  const weighted = Object.entries(dimensions).reduce((sum, [name, dimension]) =>
    sum + (dimension.score ?? 0) * rules.dimensionWeights[name as keyof typeof rules.dimensionWeights] / 100,
  0);
  const total = status === 'official' ? round(weighted) : null;

  return {
    schemaVersion: BENCHMARK_SCORE_VERSION,
    version: BENCHMARK_SCORE_VERSION,
    status,
    total,
    grade: total == null ? null : scoreGrade(total),
    weights: rules.dimensionWeights,
    thresholds: {
      semantic: rules.semantic,
      latencyMilliseconds: rules.latencyMilliseconds,
      stability: rules.stability,
      grades: rules.grades,
    },
    dimensions,
    evidenceCoverage: {
      benchmarkCompleted,
      completeDimensions: Object.values(dimensions).filter((dimension) => dimension.status === 'scored').length,
      requiredDimensions: 4,
      missing,
    },
    formulas: {
      semantic: semantic.formula,
      latency: latency.formula,
      completeness: completeness.formula,
      stability: stability.formula,
      total: '0.40 × semantic + 0.30 × latency + 0.20 × completeness + 0.10 × stability; official only when all four dimensions have complete evidence',
    },
    deductions,
    judge: semantic.evidence.judge,
  };
}
