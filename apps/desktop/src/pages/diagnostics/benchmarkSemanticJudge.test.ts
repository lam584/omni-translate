import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BenchmarkReport } from '../../runtime/benchmark-runtime';
import type { ProviderDraft } from '../../schema/config';
import {
  formatSemanticJudgeError,
  parseBenchmarkJudgeJson,
  parseBenchmarkJudgePayload,
  runBenchmarkSemanticJudge,
} from './benchmarkSemanticJudge';

const mocks = vi.hoisted(() => ({
  activeDesktopApi: vi.fn(),
  readProviderSecret: vi.fn(),
  resolveSourceText: vi.fn(),
  resolveReferenceTranslation: vi.fn(),
  smoke: vi.fn(),
}));

vi.mock('../../runtime/desktop-api', () => ({ activeDesktopApi: mocks.activeDesktopApi }));
vi.mock('../../runtime/provider-runtime', () => ({ readProviderSecret: mocks.readProviderSecret }));
vi.mock('./benchmarkReferenceText', () => ({
  resolveBenchmarkSourceText: mocks.resolveSourceText,
  resolveBenchmarkReferenceTranslation: mocks.resolveReferenceTranslation,
}));

const payload = {
  subscores: {
    adequacy: 92,
    factsTerminology: 88,
    omissionsAdditions: 84,
    fluency: 96,
  },
  rationale: 'Numbers are retained; one detail is omitted.',
  criticalErrors: [{ category: 'omission', description: 'A qualifier is absent.', sourceEvidence: 'only', translationEvidence: 'missing' }],
};

const judgeModel = {
  modelId: 'judge-model',
  displayName: 'Judge Model',
  authReference: 'credential:judge',
  provider: {
    providerId: 'judge-provider',
    model: 'judge-model',
    localModelCapabilityRegistry: [{ id: 'judge-text', modelId: 'judge-model', capabilities: ['text-generation'] }],
    streamEnabled: false,
    timeoutMs: 10_000,
    systemPromptTemplate: 'original',
    temperature: 0.8,
    maxOutputTokens: 2048,
    responseModalities: ['text', 'audio'],
  } as ProviderDraft,
};

const benchmarkReport = (runs: BenchmarkReport['runs'] = [{
  runIndex: 0,
  model: 'candidate-model',
  connectMs: 10,
  sessionReadyMs: 20,
  audioSendMs: 30,
  audioChunksSent: 1,
  audioDurationSecs: 1,
  firstAsrMs: 40,
  asrDeltas: [],
  asrFinal: 'hello',
  firstOutputMs: 50,
  firstCommittedMs: 60,
  outputDeltas: [],
  translationFinal: '  你好  ',
  responseCreatedMs: 45,
  responseDoneMs: 70,
  responseDoneAudioChunksSent: 1,
  responseDoneAudioSentSecs: 1,
  responseCount: 1,
  speechStartedMs: 0,
  speechStoppedMs: 30,
  timeToFirstTokenMs: 5,
  timeToFirstCommittedMs: 15,
  totalOutputDurationMs: 20,
  outputDeltaCount: 1,
}]): BenchmarkReport => ({
  model: 'candidate-model',
  audioFile: 'benchmark.wav',
  audioDurationSecs: 1,
  runs,
  summary: {
    runCount: runs.length,
    successfulRuns: runs.length,
    avgConnectMs: 10,
    avgSessionReadyMs: 20,
    avgTimeToFirstTokenMs: 5,
    avgTimeToFirstCommittedMs: 15,
    avgOutputDeltaIntervalMs: null,
    avgOutputDeltasPerRun: 1,
    avgTotalOutputDurationMs: 20,
    p50DeltaIntervalMs: null,
    p90DeltaIntervalMs: null,
    p99DeltaIntervalMs: null,
    minDeltaIntervalMs: null,
    maxDeltaIntervalMs: null,
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.activeDesktopApi.mockReturnValue({ provider: { smoke: mocks.smoke } });
  mocks.readProviderSecret.mockResolvedValue({ reference: 'credential:judge', backend: 'test', secret: 'stored-key' });
  mocks.resolveSourceText.mockReturnValue('hello');
  mocks.resolveReferenceTranslation.mockReturnValue('你好');
  mocks.smoke.mockResolvedValue({ error: null, transcript: JSON.stringify(payload) });
});

describe('parseBenchmarkJudgePayload', () => {
  it('accepts fenced nested rubric JSON, calculates its mean, and preserves evidence', () => {
    expect(parseBenchmarkJudgePayload(`\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``)).toEqual({
      score: 90,
      subscores: payload.subscores,
      rationale: payload.rationale,
      criticalErrors: [{ category: 'omission', description: 'A qualifier is absent.', sourceEvidence: 'only', candidateEvidence: 'missing' }],
    });
  });

  it('finds the final structured object after provider reasoning and supports documented aliases', () => {
    const transcript = `thinking {"score": 5}\nfinal ${JSON.stringify({
      subscores: { adequacy: 80, terminology: 90, omissions: 70, fluency: 100 },
      rationale: 'usable',
      criticalErrors: [],
    })}`;
    expect(parseBenchmarkJudgeJson(transcript)).toEqual({ score: 85, rationale: 'usable' });
  });

  it('does not accept a complete nested score from a truncated streaming response', () => {
    const valid = JSON.stringify(payload);
    expect(() => parseBenchmarkJudgePayload(valid.slice(0, -1))).toThrow();
    expect(() => parseBenchmarkJudgePayload(`{"result":${valid}`)).toThrow();
    expect(() => parseBenchmarkJudgePayload(`{"data":${valid}`)).toThrow();
    expect(parseBenchmarkJudgePayload(`prefix ${valid}`).score).toBe(90);
  });
  it('rejects a bare scalar score or a response with a missing rubric field', () => {
    expect(() => parseBenchmarkJudgePayload('{"score": 90, "rationale": "opaque"}')).toThrow();
    expect(() => parseBenchmarkJudgePayload('{"subscores":{"adequacy":90},"rationale":"incomplete"}')).toThrow();
    expect(() => parseBenchmarkJudgePayload(JSON.stringify({
      subscores: { adequacy: 90, factsTerminology: 90, omissionsAdditions: 90, fluency: 90 },
      rationale: '',
      criticalErrors: [],
    }))).toThrow();
    expect(() => parseBenchmarkJudgePayload(JSON.stringify({
      subscores: { adequacy: 90, factsTerminology: 90, omissionsAdditions: 90, fluency: 90 },
      rationale: 'Missing candidate excerpt.',
      criticalErrors: [{ category: 'facts', description: 'A number changed.', sourceEvidence: '10' }],
    }))).toThrow();
  });

  it('handles escaped strings, flat aliases, clamping, and all critical-error evidence aliases', () => {
    const transcript = `prefix {not-json} ${JSON.stringify({
      semantic_fidelity: 120,
      facts_terminology: -5,
      omissions_additions: '75',
      fluency: 85,
      reason: 'Escaped "quote" and \\ slash.',
      critical_errors: [
        { message: 'Changed a fact.', source_evidence: 'ten', candidate_evidence: 'eleven' },
        { category: 'terminology', description: 'Wrong term.', sourceEvidence: 'API', candidateEvidence: 'SDK' },
      ],
    })}`;

    expect(parseBenchmarkJudgePayload(transcript)).toEqual({
      score: 65,
      subscores: { adequacy: 100, factsTerminology: 0, omissionsAdditions: 75, fluency: 85 },
      rationale: 'Escaped "quote" and \\ slash.',
      criticalErrors: [
        {
          category: 'unspecified',
          description: 'Changed a fact.',
          sourceEvidence: 'ten',
          candidateEvidence: 'eleven',
        },
        {
          category: 'terminology',
          description: 'Wrong term.',
          sourceEvidence: 'API',
          candidateEvidence: 'SDK',
        },
      ],
    });
  });

  it('handles <think> blocks, wrapper objects, and omitted criticalErrors', () => {
    const raw = `<think>
Thinking about scores:
- adequacy: 95
- facts: 90
- omissions: 90
- fluency: 95
</think>
\`\`\`json
{
  "result": {
    "subscores": {
      "忠实度": 95,
      "facts_terminology": 90,
      "omissions-additions": 90,
      "流畅度": 95
    },
    "summary": "翻译非常准确流畅。"
  }
}
\`\`\``;
    expect(parseBenchmarkJudgePayload(raw)).toEqual({
      score: 92.5,
      subscores: {
        adequacy: 95,
        factsTerminology: 90,
        omissionsAdditions: 90,
        fluency: 95,
      },
      rationale: "翻译非常准确流畅。",
      criticalErrors: [],
    });
  });

  it('rejects malformed critical-error containers and unauditable entries', () => {
    const base = {
      subscores: { adequacy: 90, facts: 90, additions: 90, fluency: 90 },
      rationale: 'Auditable rationale.',
    };
    for (const criticalErrors of [
      'not-an-array',
      ['plain error'],
      [null],
      [[]],
      [{}],
      [{ description: '   ', sourceEvidence: 'source', candidateEvidence: 'candidate' }],
      [{ description: 'missing excerpts' }],
    ]) {
      expect(() => parseBenchmarkJudgePayload(JSON.stringify({ ...base, criticalErrors }))).toThrow();
    }
  });
});

describe('runBenchmarkSemanticJudge', () => {
  it('judges every completed non-empty run with a locked provider configuration and averages the scores', async () => {
    const second = { ...benchmarkReport().runs[0], runIndex: 1, translationFinal: '再见' };
    mocks.smoke
      .mockResolvedValueOnce({ error: null, transcript: JSON.stringify(payload) })
      .mockResolvedValueOnce({ error: null, transcript: JSON.stringify({
        ...payload,
        subscores: { adequacy: 80, factsTerminology: 80, omissionsAdditions: 80, fluency: 80 },
      }) });

    await expect(runBenchmarkSemanticJudge(benchmarkReport([benchmarkReport().runs[0], second]), judgeModel, 'direct-key')).resolves.toEqual({
      model: 'Judge Model',
      rubricVersion: 'benchmark-semantic-judge/v1',
      score: 85,
      runs: [
        expect.objectContaining({ runIndex: 0, score: 90 }),
        expect.objectContaining({ runIndex: 1, score: 80 }),
      ],
    });
    expect(mocks.readProviderSecret).not.toHaveBeenCalled();
    expect(mocks.smoke).toHaveBeenCalledTimes(2);
    expect(mocks.smoke.mock.calls[0][0]).toMatchObject({
      model: 'judge-model',
      systemPromptTemplate: 'benchmark-semantic-judge-v1',
      temperature: 0,
      maxOutputTokens: 2048,
      responseModalities: ['text'],
      streamEnabled: true,
      transport: 'streaming-http',
      timeoutMs: 60_000,
    });
    expect(JSON.parse(mocks.smoke.mock.calls[0][1])).toMatchObject({
      rubricVersion: 'benchmark-semantic-judge/v1',
      runIndex: 0,
      source: 'hello',
      reference: '你好',
      translation: '你好',
    });
  });

  it('routes a text judge through streaming HTTP without rewriting the configured realtime provider', async () => {
    mocks.smoke.mockResolvedValueOnce({ error: null, transcript: JSON.stringify(payload) });
    const realtime = {
      ...judgeModel.provider,
      model: 'qwen-plus',
      localModelCapabilityRegistry: [{ id: 'judge-text', modelId: 'qwen-plus', capabilities: ['text-generation'] }],
      kind: 'dashscope',
      transport: 'websocket',
    } as ProviderDraft;
    await runBenchmarkSemanticJudge(benchmarkReport(), {
      ...judgeModel, provider: realtime,
    }, 'direct-key');
    expect(mocks.smoke.mock.calls[0][0]).toMatchObject({ model: 'qwen-plus', transport: 'streaming-http', streamEnabled: true, timeoutMs: 60_000 });
    expect(realtime.transport).toBe('websocket');
    expect(realtime.streamEnabled).toBe(false);
    expect(realtime.timeoutMs).toBe(10_000);
  });
  it('uses the built-in text capability for a catalog LLM without requiring a user override', async () => {
    await runBenchmarkSemanticJudge(benchmarkReport(), {
      ...judgeModel,
      provider: { ...judgeModel.provider, kind: 'dashscope', model: 'qwen3.8-flash' },
    }, 'direct-key');
    expect(mocks.smoke.mock.calls[0][0]).toMatchObject({
      transport: 'streaming-http',
      model: 'qwen3.8-flash',
      localModelCapabilityRegistry: expect.arrayContaining([
        expect.objectContaining({ modelId: 'qwen3.8-flash', capabilities: expect.arrayContaining(['text-generation']) }),
      ]),
    });
  });
  it('uses an explicit GUI capability override for catalog-only text models and respects its removal', async () => {
    const provider = {
      ...judgeModel.provider,
      kind: 'dashscope',
      model: 'qwen3.8-flash',
      modelRegistryVersion: 2,
      modelCapabilityOverrides: [{ modelId: 'qwen3.8-flash', source: 'user', capabilities: ['text-generation'] }],
    } as ProviderDraft;
    await runBenchmarkSemanticJudge(benchmarkReport(), { ...judgeModel, provider }, 'direct-key');
    expect(mocks.smoke.mock.calls[0][0]).toMatchObject({
      model: 'qwen3.8-flash', transport: 'streaming-http',
      localModelCapabilityRegistry: expect.arrayContaining([expect.objectContaining({ modelId: 'qwen3.8-flash', capabilities: ['text-generation'] })]),
    });
    mocks.smoke.mockClear();
    const disabled = { ...provider, modelCapabilityOverrides: [{ modelId: 'qwen3.8-flash', source: 'user' as const, capabilities: [] }] };
    await expect(runBenchmarkSemanticJudge(benchmarkReport(), { ...judgeModel, provider: disabled }, 'direct-key')).rejects.toThrow('文本生成');
    expect(mocks.smoke).not.toHaveBeenCalled();
  });
  it('reads a stored credential and ignores incomplete or empty candidate runs', async () => {
    const incomplete = { ...benchmarkReport().runs[0], runIndex: 1, responseDoneMs: null };
    const empty = { ...benchmarkReport().runs[0], runIndex: 2, translationFinal: '   ' };

    await runBenchmarkSemanticJudge(benchmarkReport([benchmarkReport().runs[0], incomplete, empty]), judgeModel);

    expect(mocks.readProviderSecret).toHaveBeenCalledWith('credential:judge');
    expect(mocks.smoke).toHaveBeenCalledOnce();
  });

  it('rejects an interrupted streaming response rather than scoring its complete nested object', async () => {
    mocks.smoke.mockResolvedValueOnce({ error: null, transcript: `{"result":${JSON.stringify(payload)}` });
    await expect(runBenchmarkSemanticJudge(benchmarkReport(), judgeModel, 'key')).rejects.toThrow();
  });
  it('reports each unavailable prerequisite and provider failure', async () => {
    mocks.resolveSourceText.mockReturnValueOnce(null);
    await expect(runBenchmarkSemanticJudge(benchmarkReport(), judgeModel, 'key')).rejects.toThrow();

    mocks.resolveReferenceTranslation.mockReturnValueOnce(null);
    await expect(runBenchmarkSemanticJudge(benchmarkReport(), judgeModel, 'key')).rejects.toThrow();

    await expect(runBenchmarkSemanticJudge(benchmarkReport([]), judgeModel, 'key')).rejects.toThrow();

    mocks.readProviderSecret.mockResolvedValueOnce({ reference: 'credential:judge', backend: 'test', secret: null });
    await expect(runBenchmarkSemanticJudge(benchmarkReport(), judgeModel)).rejects.toThrow('Judge Model');

    mocks.smoke.mockResolvedValueOnce({ error: { message: 'judge offline' }, transcript: '' });
    await expect(runBenchmarkSemanticJudge(benchmarkReport(), judgeModel, 'key')).rejects.toThrow('judge offline');
  });

  it('formats unknown judge failures for diagnostics', () => {
    expect(formatSemanticJudgeError(new Error('network down'))).toContain('network down');
    expect(formatSemanticJudgeError('plain failure')).toContain('plain failure');
  });
});
