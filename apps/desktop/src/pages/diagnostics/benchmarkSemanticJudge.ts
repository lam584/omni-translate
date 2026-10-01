import i18n from '../../i18n/config';
import { readProviderSecret } from '../../runtime/provider-runtime';
import { activeDesktopApi } from '../../runtime/desktop-api';
import { effectiveProviderModelRegistry } from '../../utils/provider-model-capabilities-registry';
import type { BenchmarkReport } from '../../runtime/benchmark-runtime';
import type { ProviderDraft } from '../../schema/config';
import { describeUnknownError } from '../../utils/describe-unknown-error';
import { resolveBenchmarkReferenceTranslation, resolveBenchmarkSourceText } from './benchmarkReferenceText';
import type {
  BenchmarkJudgeCriticalError,
  BenchmarkJudgeRunEvidence,
  BenchmarkJudgeSubscoreKey,
  BenchmarkSemanticJudgeEvidence,
} from './benchmarkReportScore';

export type BenchmarkJudgeModel = {
  modelId: string;
  displayName: string;
  authReference: string;
  provider: ProviderDraft;
};

/** Kept as the public result name used by the diagnostics screen. */
export type BenchmarkSemanticJudgeResult = BenchmarkSemanticJudgeEvidence;

export type BenchmarkJudgeParsedPayload = Omit<BenchmarkJudgeRunEvidence, 'runIndex'>;

const RUBRIC_VERSION = 'benchmark-semantic-judge/v1';
const RUBRIC_KEYS: readonly BenchmarkJudgeSubscoreKey[] = [
  'adequacy',
  'factsTerminology',
  'omissionsAdditions',
  'fluency',
];

function jsonObjectCandidates(transcript: string): string[] {
  const candidates: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < transcript.length; index += 1) {
    const character = transcript[index];
    if (depth === 0) {
      if (character === '{') {
        start = index;
        depth = 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
    } else if (character === '"') {
      inString = true;
    } else if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        candidates.push(transcript.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return candidates;
}

function clamp(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function round(value: number): number {
  return Number(value.toFixed(1));
}

function scoreValue(value: unknown): number | null {
  const score = Number(value);
  return Number.isFinite(score) ? clamp(score) : null;
}

function normalizeKey(str: string): string {
  return str.toLowerCase().replace(/[-_\s]/g, "");
}

function readAliasedScore(input: Record<string, unknown>, key: BenchmarkJudgeSubscoreKey): number | null {
  const aliases: Record<BenchmarkJudgeSubscoreKey, readonly string[]> = {
    adequacy: ['adequacy', 'semanticFidelity', 'semantic_fidelity', 'fidelity', '忠实度', '语义忠实度'],
    factsTerminology: ['factsTerminology', 'facts_terminology', 'terminology', 'facts', '术语', '事实与术语'],
    omissionsAdditions: ['omissionsAdditions', 'omissions_additions', 'omissions', 'additions', '增减译', '遗漏与增译'],
    fluency: ['fluency', '流畅度', '语言流畅度'],
  };
  const normalizedInput = new Map<string, unknown>();
  for (const [k, v] of Object.entries(input)) {
    normalizedInput.set(normalizeKey(k), v);
  }
  for (const alias of aliases[key]) {
    const val = input[alias] ?? normalizedInput.get(normalizeKey(alias));
    const score = scoreValue(val);
    if (score != null) return score;
  }
  return null;
}

function parseCriticalErrors(value: unknown): BenchmarkJudgeCriticalError[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((error) => {
    if (typeof error === 'string' && error.trim()) {
      return [{ category: 'unspecified', description: error.trim() }];
    }
    if (!error || typeof error !== 'object' || Array.isArray(error)) return [];
    const record = error as Record<string, unknown>;
    const description = typeof record.description === 'string'
      ? record.description.trim()
      : typeof record.message === 'string' ? record.message.trim() : '';
    if (!description) return [];
    return [{
      category: typeof record.category === 'string' && record.category.trim() ? record.category.trim() : 'unspecified',
      description,
      sourceEvidence: typeof record.sourceEvidence === 'string'
        ? record.sourceEvidence
        : typeof record.source_evidence === 'string' ? record.source_evidence : null,
      candidateEvidence: typeof record.candidateEvidence === 'string'
        ? record.candidateEvidence
        : typeof record.translationEvidence === 'string'
          ? record.translationEvidence
          : typeof record.candidate_evidence === 'string' ? record.candidate_evidence : null,
    }];
  });
}

/**
 * Parses the documented judge response. All four rubric fields are required;
 * accepting a bare scalar score would make a low result impossible to audit.
 */
export function parseBenchmarkJudgePayload(transcript: string): BenchmarkJudgeParsedPayload {
  const strippedTranscript = transcript.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const fencedCandidates = [...strippedTranscript.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)]
    .flatMap((match) => jsonObjectCandidates(match[1] ?? ''));
  const candidates = [
    ...fencedCandidates,
    ...jsonObjectCandidates(strippedTranscript),
    ...jsonObjectCandidates(transcript),
  ];

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      let record = parsed as Record<string, unknown>;
      if (record.result && typeof record.result === 'object' && !Array.isArray(record.result)) {
        record = record.result as Record<string, unknown>;
      } else if (record.data && typeof record.data === 'object' && !Array.isArray(record.data)) {
        record = record.data as Record<string, unknown>;
      }
      const nestedSubscores = record.subscores;
      const scoreRecord = nestedSubscores && typeof nestedSubscores === 'object' && !Array.isArray(nestedSubscores)
        ? nestedSubscores as Record<string, unknown>
        : record;
      const subscores = Object.fromEntries(RUBRIC_KEYS.map((key) => [key, readAliasedScore(scoreRecord, key)])) as Record<BenchmarkJudgeSubscoreKey, number | null>;
      if (RUBRIC_KEYS.some((key) => subscores[key] == null)) continue;
      const normalizedSubscores = Object.fromEntries(RUBRIC_KEYS.map((key) => [key, subscores[key]!])) as Record<BenchmarkJudgeSubscoreKey, number>;
      const score = round(RUBRIC_KEYS.reduce((sum, key) => sum + normalizedSubscores[key], 0) / RUBRIC_KEYS.length);
      const rationale = typeof record.rationale === 'string'
        ? record.rationale.trim()
        : typeof record.reason === 'string'
          ? record.reason.trim()
          : typeof record.summary === 'string'
            ? record.summary.trim()
            : '';
      const rawCriticalErrors = record.criticalErrors !== undefined
        ? record.criticalErrors
        : record.critical_errors !== undefined
          ? record.critical_errors
          : [];
      if (!rationale || !Array.isArray(rawCriticalErrors)) continue;
      const criticalErrors = parseCriticalErrors(rawCriticalErrors);
      // A listed error without source/candidate excerpts cannot explain a
      // deduction, so it is not valid auditable v1 judge evidence.
      if (
        criticalErrors.length !== rawCriticalErrors.length
        || criticalErrors.some((error) => error.sourceEvidence == null || error.candidateEvidence == null)
      ) continue;
      return {
        score,
        subscores: normalizedSubscores,
        rationale,
        criticalErrors,
      };
    } catch {
      // Providers may prefix reasoning or emit an unrelated object before the
      // final JSON payload. Keep looking for the balanced structured result.
      continue;
    }
  }

  throw new Error(i18n.t('runtime.benchmark.semanticJudgeInvalidResponse'));
}

/**
 * Compatibility helper retained for callers that only render the aggregate
 * score/rationale; it intentionally does not discard the strict parser.
 */
export function parseBenchmarkJudgeJson(transcript: string): { score: number; rationale: string } {
  const { score, rationale } = parseBenchmarkJudgePayload(transcript);
  return { score, rationale };
}

function validRuns(report: BenchmarkReport) {
  return report.runs.filter((run) => run.responseDoneMs != null && run.translationFinal.trim().length > 0);
}

/** Project the effective exact-model capability into the native gateway request. */
export function resolveBenchmarkJudgeTextProvider(provider: ProviderDraft): ProviderDraft | null {
  const entry = effectiveProviderModelRegistry(provider).find((candidate) => candidate.modelId === provider.model);
  if (!entry || entry.hidden || !entry.capabilities.includes('text-generation')) return null;
  return {
    ...provider,
    localModelCapabilityRegistry: [
      ...(provider.localModelCapabilityRegistry ?? []).filter((candidate) => candidate.modelId !== provider.model),
      entry,
    ],
  };
}

/**
 * Scores every valid run separately. The request contains source, reference,
 * and candidate text, allowing the score evidence to be reproduced without
 * ever serializing a provider credential into the result.
 */
export async function runBenchmarkSemanticJudge(
  report: BenchmarkReport,
  judgeModel: BenchmarkJudgeModel,
  credential?: string,
): Promise<BenchmarkSemanticJudgeResult> {
  const sourceText = resolveBenchmarkSourceText(report.audioFile);
  if (!sourceText) throw new Error(i18n.t('runtime.benchmark.semanticJudgeReferenceUnavailable'));
  const referenceTranslation = resolveBenchmarkReferenceTranslation(report.audioFile);
  if (!referenceTranslation) throw new Error(i18n.t('runtime.benchmark.semanticJudgeReferenceUnavailable'));
  const runs = validRuns(report);
  if (!runs.length) throw new Error(i18n.t('runtime.benchmark.semanticJudgeTranslationUnavailable'));
  const textProvider = resolveBenchmarkJudgeTextProvider(judgeModel.provider);
  if (!textProvider) throw new Error(`模型 ${judgeModel.provider.model} 未在能力注册表中启用文本生成，不能用于语义评分。`);
  const apiKey = credential ?? (await readProviderSecret(judgeModel.authReference)).secret;
  if (!apiKey) throw new Error(i18n.t('runtime.benchmark.semanticJudgeMissingApiKey', { model: judgeModel.displayName }));
  const provider: ProviderDraft = {
    ...textProvider,
    model: textProvider.model,
    // A text judge must not inherit the provider's realtime voice transport.
    transport: 'streaming-http',
    systemPromptTemplate: 'benchmark-semantic-judge-v1',
    temperature: 0,
    maxOutputTokens: 2048,
    responseModalities: ['text'],
    streamEnabled: true,
    timeoutMs: 60_000,
  };
  const judgedRuns: BenchmarkJudgeRunEvidence[] = [];
  for (const run of runs) {
    const result = await activeDesktopApi().provider.smoke(
      provider,
      JSON.stringify({
        rubricVersion: RUBRIC_VERSION,
        runIndex: run.runIndex,
        source: sourceText,
        reference: referenceTranslation,
        translation: run.translationFinal.trim(),
      }),
      'benchmark-source-reference-candidate',
      'json-translation-judge',
    );
    if (result.error) throw new Error(result.error.message);
    judgedRuns.push({ runIndex: run.runIndex, ...parseBenchmarkJudgePayload(result.transcript) });
  }
  const score = round(judgedRuns.reduce((sum, run) => sum + run.score, 0) / judgedRuns.length);
  return { model: judgeModel.displayName, rubricVersion: RUBRIC_VERSION, score, runs: judgedRuns };
}

export function formatSemanticJudgeError(error: unknown): string {
  return `${i18n.t('runtime.benchmark.semanticJudgeFailed')}\n${describeUnknownError(error)}`;
}
