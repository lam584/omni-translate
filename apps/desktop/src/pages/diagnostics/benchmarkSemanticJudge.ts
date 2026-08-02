import i18n from '../../i18n/config';
import { readProviderSecret } from '../../runtime/provider-runtime';
import { activeDesktopApi } from '../../runtime/desktop-api';
import type { BenchmarkReport } from '../../runtime/benchmark-runtime';
import type { ProviderDraft } from '../../schema/config';
import { describeUnknownError } from '../../utils/describe-unknown-error';
import { resolveBenchmarkSourceText } from './benchmarkReferenceText';

export type BenchmarkJudgeModel = {
  modelId: string;
  displayName: string;
  authReference: string;
  provider: ProviderDraft;
};

export type BenchmarkSemanticJudgeResult = {
  score: number;
  rationale: string;
  model: string;
};

function jsonObjectCandidates(transcript: string): string[] {
  const candidates: string[] = [];
  for (let start = 0; start < transcript.length; start += 1) {
    if (transcript[start] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < transcript.length; index += 1) {
      const character = transcript[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') {
        inString = true;
      } else if (character === '{') {
        depth += 1;
      } else if (character === '}') {
        depth -= 1;
        if (depth === 0) {
          candidates.push(transcript.slice(start, index + 1));
          break;
        }
      }
    }
  }
  return candidates;
}

export function parseBenchmarkJudgeJson(transcript: string): { score: number; rationale: string } {
  const fencedCandidates = [...transcript.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)]
    .flatMap((match) => jsonObjectCandidates(match[1] ?? ''));
  const candidates = [...fencedCandidates, ...jsonObjectCandidates(transcript)];

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as { score?: unknown; rationale?: unknown };
      const score = Number(parsed.score);
      if (Number.isFinite(score)) {
        return {
          score: Math.min(100, Math.max(0, score)),
          rationale: typeof parsed.rationale === 'string' ? parsed.rationale : '',
        };
      }
    } catch {
      // Try the next balanced object; providers may prepend reasoning or a
      // non-JSON object before the final judge payload.
      continue;
    }
  }

  throw new Error(i18n.t('runtime.benchmark.semanticJudgeInvalidResponse'));
}

export async function runBenchmarkSemanticJudge(
  report: BenchmarkReport,
  judgeModel: BenchmarkJudgeModel,
): Promise<BenchmarkSemanticJudgeResult> {
  const sourceText = resolveBenchmarkSourceText(report.audioFile);
  if (!sourceText) throw new Error(i18n.t('runtime.benchmark.semanticJudgeReferenceUnavailable'));
  const run = report.runs.at(-1) ?? report.runs[0];
  const translation = run?.translationFinal?.trim() ?? '';
  if (!translation) throw new Error(i18n.t('runtime.benchmark.semanticJudgeTranslationUnavailable'));
  const secret = await readProviderSecret(judgeModel.authReference);
  if (!secret.secret) throw new Error(i18n.t('runtime.benchmark.semanticJudgeMissingApiKey', { model: judgeModel.displayName }));
  const provider: ProviderDraft = {
    ...judgeModel.provider,
    model: judgeModel.provider.model,
    systemPromptTemplate: 'benchmark-semantic-judge-v1',
    temperature: 0,
    maxOutputTokens: 512,
    responseModalities: ['text'],
    streamEnabled: false,
  };
  const result = await activeDesktopApi().provider.smoke(
    provider,
    JSON.stringify({ source: sourceText, translation }),
    'benchmark-source-and-translation',
    'json-score',
  );
  if (result.error) throw new Error(result.error.message);
  const parsed = parseBenchmarkJudgeJson(result.transcript);
  return { ...parsed, model: judgeModel.displayName };
}

export function formatSemanticJudgeError(error: unknown): string {
  return `${i18n.t('runtime.benchmark.semanticJudgeFailed')}\n${describeUnknownError(error)}`;
}
