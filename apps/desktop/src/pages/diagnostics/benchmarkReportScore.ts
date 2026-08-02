import type { BenchmarkReport } from '../../runtime/benchmark-runtime';

export type BenchmarkResultScore = {
  total: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  dimensions: { semantic: number | null; latency: number; completeness: number; reliability: number };
  semanticEvidence: 'reference-proxy' | 'llm-judge' | 'unavailable';
};

const clamp = (value: number) => Math.min(100, Math.max(0, value));
const round = (value: number) => Number(value.toFixed(1));

function ramp(value: number | null, good: number, bad: number): number {
  if (value == null || !Number.isFinite(value)) return 0;
  if (value <= good) return 100;
  if (value >= bad) return 0;
  return 100 * (bad - value) / (bad - good);
}

function grade(score: number): BenchmarkResultScore['grade'] {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

function normalizedText(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function multisetOverlap(left: string, right: string): number | null {
  const candidate = [...normalizedText(left)];
  const reference = [...normalizedText(right)];
  if (!candidate.length || !reference.length) return null;

  const referenceCounts = new Map<string, number>();
  for (const character of reference) {
    referenceCounts.set(character, (referenceCounts.get(character) ?? 0) + 1);
  }

  let matched = 0;
  for (const character of candidate) {
    const remaining = referenceCounts.get(character) ?? 0;
    if (remaining > 0) {
      matched += 1;
      referenceCounts.set(character, remaining - 1);
    }
  }

  const precision = matched / candidate.length;
  const recall = matched / reference.length;
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall) * 100;
}

function referenceSemanticScore(report: BenchmarkReport, referenceTranslation: string | null | undefined): number | null {
  if (!referenceTranslation?.trim()) return null;

  const runScores = report.runs
    .map((run) => multisetOverlap(run.translationFinal, referenceTranslation))
    .filter((score): score is number => score != null);
  return runScores.length ? runScores.reduce((sum, score) => sum + score, 0) / runScores.length : null;
}

export function scoreBenchmarkReport(
  report: BenchmarkReport,
  options: { llmSemanticScore?: number | null; referenceTranslation?: string | null } = {},
): BenchmarkResultScore {
  const completedRuns = report.runs.filter((run) => run.responseDoneMs != null && run.translationFinal.trim().length > 0);
  const latencyValues = report.runs.flatMap((run) => [
    // firstOutputMs/firstCommittedMs are absolute session offsets. The
    // benchmark UI reports the user-relevant latency after response creation;
    // using the absolute offset would score a long audio file as slow even
    // when the model answered immediately after the request was created.
    ramp(relativeResponseLatency(run.responseCreatedMs, run.firstOutputMs, run.timeToFirstTokenMs), 2_000, 8_000),
    ramp(relativeResponseLatency(run.responseCreatedMs, run.firstCommittedMs, run.timeToFirstCommittedMs), 5_000, 15_000),
  ]);
  const latency = latencyValues.length ? latencyValues.reduce((sum, value) => sum + value, 0) / latencyValues.length : 0;
  const completeness = report.runs.length ? 100 * completedRuns.length / report.runs.length : 0;
  const declaredRuns = Math.max(report.summary.runCount, report.runs.length, 1);
  const successfulRuns = Math.min(report.summary.successfulRuns, completedRuns.length);
  const responsePenalty = report.runs.reduce((sum, run) => sum + Math.max(0, run.responseCount - 1) * 5, 0);
  const reliability = clamp(100 * successfulRuns / declaredRuns - responsePenalty);
  const referenceSemantic = referenceSemanticScore(report, options.referenceTranslation);
  const llmSemantic = options.llmSemanticScore == null || !Number.isFinite(options.llmSemanticScore)
    ? null : clamp(options.llmSemanticScore);
  const semantic = llmSemantic == null
    ? referenceSemantic == null ? null : round(clamp(referenceSemantic))
    : round(clamp(referenceSemantic == null ? llmSemantic : referenceSemantic * 0.4 + llmSemantic * 0.6));
  const weighted = [
    semantic == null ? null : { value: semantic, weight: 40 },
    { value: latency, weight: 30 }, { value: completeness, weight: 20 }, { value: reliability, weight: 10 },
  ].filter((item): item is { value: number; weight: number } => item != null);
  const weightTotal = weighted.reduce((sum, item) => sum + item.weight, 0);
  const total = round(weighted.reduce((sum, item) => sum + item.value * item.weight, 0) / weightTotal);
  return {
    total, grade: grade(total),
    dimensions: { semantic, latency: round(latency), completeness: round(completeness), reliability: round(reliability) },
    semanticEvidence: llmSemantic != null ? 'llm-judge' : referenceSemantic != null ? 'reference-proxy' : 'unavailable',
  };
}

function relativeResponseLatency(responseCreatedMs: number | null, eventMs: number | null, fallbackMs: number | null): number | null {
  if (responseCreatedMs != null && eventMs != null) {
    return Math.max(0, eventMs - responseCreatedMs);
  }
  return fallbackMs;
}
