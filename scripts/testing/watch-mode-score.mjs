import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_WEIGHTS = Object.freeze({ semantic: 40, latency: 30, completeness: 20, reliability: 10 });
const DEFAULT_THRESHOLDS = Object.freeze({ firstVisibleGood: 2, firstVisibleBad: 8, firstFinalGood: 5, firstFinalBad: 15 });

const clamp = (value, min = 0, max = 100) => Math.min(max, Math.max(min, Number(value) || 0));
const round = (value, digits = 1) => Number(Number(value).toFixed(digits));
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const readText = (file) => fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();

function optionalNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalized(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function multisetOverlap(left, right) {
  const a = [...normalized(left)];
  const b = [...normalized(right)];
  if (!a.length || !b.length) return 0;
  const counts = new Map();
  for (const char of b) counts.set(char, (counts.get(char) ?? 0) + 1);
  let matched = 0;
  for (const char of a) {
    const count = counts.get(char) ?? 0;
    if (count > 0) { matched += 1; counts.set(char, count - 1); }
  }
  const precision = matched / a.length;
  const recall = matched / b.length;
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

function rampDown(value, good, bad) {
  if (value == null || value === '' || !Number.isFinite(Number(value))) return 0;
  if (value <= good) return 100;
  if (value >= bad) return 0;
  return 100 * (bad - value) / (bad - good);
}

function findEvidence(runDirectory, report) {
  const snapshotsPath = path.join(runDirectory, 'snapshots.json');
  const contentPath = path.join(runDirectory, 'physical-output-content.json');
  const snapshots = fs.existsSync(snapshotsPath) ? readJson(snapshotsPath) : {};
  const content = snapshots.physicalOutputContent
    ?? (fs.existsSync(contentPath) ? readJson(contentPath) : {})
    ?? {};
  const queue = content.subtitleQueue ?? snapshots.app?.subtitleQueue ?? {};
  const strict = report.layers?.strictContent?.data ?? {};
  return { snapshots, content, queue, strict };
}

function outputText(content) {
  const values = [content.translation, content.subtitleText, content.segmentTranslationText]
    .map((value) => String(value ?? '').trim()).filter(Boolean);
  return [...new Set(values)].join('\n');
}

function inferFixturePaths(runDirectory, evidence) {
  const mediaPath = String(evidence.content?.sourceReference?.mediaPath ?? evidence.snapshots?.playback?.mediaPath ?? '');
  const basename = path.basename(mediaPath, path.extname(mediaPath));
  const fixtureRoot = path.resolve('scripts/testing/fixtures');
  const known = new Set(['watch-mode-en-original', 'watch-mode-en-conversation', 'watch-mode-en-technical']);
  if (known.has(basename)) {
    return { source: path.join(fixtureRoot, `${basename}.txt`), reference: path.join(fixtureRoot, `${basename}.zh-CN.txt`) };
  }
  const localName = basename.match(/^watch-mode-general\.([\w-]+)$/)?.[1];
  if (localName) {
    return { source: path.join(fixtureRoot, 'watch-mode-en-original.txt'), reference: path.join(fixtureRoot, 'multilingual', `${basename}.txt`) };
  }
  return { source: null, reference: null, runDirectory };
}

export function scoreDeterministic({ report, evidence, referenceText = '' }) {
  const { content, queue, strict, snapshots } = evidence;
  const candidate = outputText(content);
  const referenceScore = referenceText ? multisetOverlap(candidate, referenceText) * 100 : null;
  const coverageScore = Number.isFinite(Number(strict.coverage)) ? Number(strict.coverage) * 100 : null;
  const semanticSignals = [referenceScore, coverageScore].filter(Number.isFinite);
  const semantic = semanticSignals.length ? semanticSignals.reduce((a, b) => a + b, 0) / semanticSignals.length : 0;

  const firstVisible = optionalNumber(queue.firstVisibleTranslationLatencySeconds);
  const firstFinal = optionalNumber(queue.firstFinalTranslationLatencySeconds);
  const latencySignals = [
    rampDown(firstVisible, DEFAULT_THRESHOLDS.firstVisibleGood, DEFAULT_THRESHOLDS.firstVisibleBad),
    rampDown(firstFinal, DEFAULT_THRESHOLDS.firstFinalGood, DEFAULT_THRESHOLDS.firstFinalBad),
  ];
  const latency = latencySignals.reduce((a, b) => a + b, 0) / latencySignals.length;

  const finalWrites = Number(queue.finalWriteCount ?? 0);
  const queued = Number(queue.queuedSegmentCount ?? snapshots.speechSegmentation?.queuedSegments ?? 0);
  const played = Number(queue.playedSegmentCount ?? snapshots.speechSegmentation?.playedSegments ?? 0);
  const completionRatio = queued > 0 ? Math.min(finalWrites, played) / queued : 0;
  const completeness = 100 * clamp(completionRatio, 0, 1);

  const failedLayers = Object.values(report.layers ?? {}).filter((layer) => layer?.status === 'failed').length;
  const provider = snapshots.provider ?? {};
  const calls = Number(provider.totalCalls ?? 0);
  const failedCalls = Number(provider.failedCalls ?? 0);
  const providerSuccess = calls > 0 ? 1 - Math.min(1, failedCalls / calls) : 0;
  const orderingPenalty = 15 * Number(queue.cueOrderInversions ?? 0) + 10 * Number(queue.duplicateFinalTranslations ?? 0);
  const reliability = clamp(100 * providerSuccess - 25 * failedLayers - orderingPenalty);

  const dimensions = { semantic: round(semantic), latency: round(latency), completeness: round(completeness), reliability: round(reliability) };
  const weighted = Object.entries(DEFAULT_WEIGHTS).reduce((sum, [name, weight]) => sum + dimensions[name] * weight / 100, 0);
  return {
    dimensions,
    total: round(report.verdict === 'passed' ? weighted : Math.min(weighted, 59)),
    grade: grade(report.verdict === 'passed' ? weighted : Math.min(weighted, 59)),
    gate: { passed: report.verdict === 'passed', verdict: report.verdict, failureLayer: report.failureLayer ?? null, failureReason: report.failureReason ?? null },
    metrics: { firstVisibleTranslationLatencySeconds: firstVisible, firstFinalTranslationLatencySeconds: firstFinal, finalWriteCount: finalWrites, queuedSegmentCount: queued, playedSegmentCount: played, completionRatio: round(completionRatio, 3), referenceOverlap: referenceScore == null ? null : round(referenceScore), strictCoverage: coverageScore == null ? null : round(coverageScore) },
    candidateText: candidate,
  };
}

function grade(score) {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const source = fenced ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  return JSON.parse(source);
}

export async function judgeWithLlm({ sourceText, referenceText, candidateText, targetLanguage, endpoint, apiKey, model }) {
  const rubric = {
    adequacy: 'Meaning and facts preserved', fluency: 'Natural target-language expression',
    terminology: 'Names, numbers, units, and technical terms', omissions: 'No important omissions or additions',
  };
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, temperature: 0, response_format: { type: 'json_object' }, messages: [
      { role: 'system', content: `You are a strict translation benchmark judge. Return JSON only. Score each rubric field from 0 to 100 and provide concise rationale and criticalErrors array. Rubric: ${JSON.stringify(rubric)}` },
      { role: 'user', content: JSON.stringify({ sourceText, referenceText, candidateText, targetLanguage }) },
    ] }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`LLM judge HTTP ${response.status}: ${body.slice(0, 300)}`);
  const envelope = JSON.parse(body);
  const judged = extractJson(envelope.choices?.[0]?.message?.content ?? '');
  const fields = ['adequacy', 'fluency', 'terminology', 'omissions'];
  const scores = Object.fromEntries(fields.map((field) => [field, clamp(judged[field])]));
  return { model, scores, score: round(fields.reduce((sum, field) => sum + scores[field], 0) / fields.length), rationale: String(judged.rationale ?? ''), criticalErrors: Array.isArray(judged.criticalErrors) ? judged.criticalErrors : [] };
}

export function combineLlmSemanticScore(deterministicDimensions, llmSemanticScore) {
  return {
    ...deterministicDimensions,
    semantic: round(0.4 * deterministicDimensions.semantic + 0.6 * clamp(llmSemanticScore)),
  };
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
  const deterministic = scoreDeterministic({ report, evidence, referenceText });
  let llmJudge = { enabled: false, status: 'skipped', reason: 'LLM judge not requested' };
  let dimensions = { ...deterministic.dimensions };
  const llmRequested = options.llmJudge || /^(1|true|yes)$/i.test(process.env.OMNI_BENCHMARK_LLM_JUDGE ?? '');
  if (llmRequested) {
    const apiKey = process.env[options.apiKeyEnv ?? 'DASHSCOPE_API_KEY'];
    if (!apiKey) llmJudge = { enabled: true, status: 'skipped', reason: `missing ${options.apiKeyEnv ?? 'DASHSCOPE_API_KEY'}` };
    else {
      llmJudge = { enabled: true, status: 'passed', ...(await judgeWithLlm({ sourceText, referenceText, candidateText: deterministic.candidateText, targetLanguage: options.targetLanguage ?? 'unknown', endpoint: options.endpoint ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', apiKey, model: options.judgeModel ?? 'qwen3.5-plus' })) };
      dimensions = combineLlmSemanticScore(dimensions, llmJudge.score);
    }
  }
  const weighted = Object.entries(DEFAULT_WEIGHTS).reduce((sum, [name, weight]) => sum + dimensions[name] * weight / 100, 0);
  const total = round(deterministic.gate.passed ? weighted : Math.min(weighted, 59));
  const result = { schemaVersion: 1, generatedAt: new Date().toISOString(), weights: DEFAULT_WEIGHTS, thresholds: DEFAULT_THRESHOLDS, total, grade: grade(total), gate: deterministic.gate, dimensions, metrics: deterministic.metrics, deterministic: { dimensions: deterministic.dimensions, total: deterministic.total }, llmJudge, provenance: { runDirectory, reportPath, sourcePath, referencePath } };
  const output = path.resolve(options.output ?? path.join(runDirectory, 'benchmark-score.json'));
  fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return { result, output };
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) if (argv[i].startsWith('--')) { const key = argv[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase()); result[key] = argv[i + 1]?.startsWith('--') || argv[i + 1] == null ? true : argv[++i]; }
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (!options.input) throw new Error('--input <run-directory> is required');
    const { result, output } = await scoreRun(options);
    console.log(JSON.stringify({ output, total: result.total, grade: result.grade, gate: result.gate, llmJudge: result.llmJudge.status }));
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
