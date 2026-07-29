import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_LAYERS = [
  'driver',
  'wasapi',
  'bridge',
  'physicalOutput',
  'physicalOutputContent',
  'speechSegmentation',
  'strictContent',
  'app',
  'provider',
];

export const BASE_REQUIRED_LAYERS = REQUIRED_LAYERS.filter((layer) => layer !== 'strictContent');

export const ECHO_CANCEL_REQUIRED_LAYERS = [
  'driver',
  'wasapi',
  'app',
  'provider',
];

const DEFAULT_ROOT = 'artifacts/testing/watch-mode-live';
const DEFAULT_STRICT_MODELS = [
  'qwen3.5-omni-flash-realtime',
  'qwen3.5-livetranslate-flash-realtime',
];
const EXCLUDED_DIRECTORY_PATTERNS = [
  /^cache$/i,
  /^physical-output-smoke-/i,
  /^reference-pcm-smoke-/i,
];
const INVALID_CANDIDATE_PRINT_LIMIT = 12;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function parseDirectoryTimestamp(name) {
  const match = name.match(/^(\d{8})-(\d{6})(?:-.+)?$/);
  if (!match) return null;
  const [, date, time] = match;
  return Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(4, 6)) - 1,
    Number(date.slice(6, 8)),
    Number(time.slice(0, 2)),
    Number(time.slice(2, 4)),
    Number(time.slice(4, 6)),
  );
}

function evidenceSortTime(entry) {
  const generatedAtMs = Date.parse(entry.report.generatedAt ?? '');
  if (Number.isFinite(generatedAtMs)) return generatedAtMs;
  const directoryTimestamp = parseDirectoryTimestamp(entry.directoryName);
  if (directoryTimestamp !== null) return directoryTimestamp;
  return entry.reportMtimeMs;
}

function isExcludedDirectory(directoryName) {
  return EXCLUDED_DIRECTORY_PATTERNS.some((pattern) => pattern.test(directoryName));
}

function reportFeedbackMode(report) {
  return report?.feedbackLoopPrevention === 'echo-cancel' ? 'echo-cancel' : 'virtual-driver';
}

function requiredLayersFor(options = {}, feedbackMode = 'virtual-driver') {
  if (feedbackMode === 'echo-cancel') return ECHO_CANCEL_REQUIRED_LAYERS;
  return options.strict ? REQUIRED_LAYERS : BASE_REQUIRED_LAYERS;
}

function hasRequiredLayerShape(report, options = {}) {
  return missingRequiredLayers(report, options).length === 0;
}

function missingRequiredLayers(report, options = {}) {
  return requiredLayersFor(options, reportFeedbackMode(report)).filter((layer) => !report.layers?.[layer]?.status);
}

function reportModelId(report) {
  return report.modelId ?? report.layers?.strictContent?.data?.modelId ?? null;
}

function strictContentFailure(report) {
  const strict = report.layers?.strictContent;
  if (!strict) return 'strictContent layer is missing';
  if (strict.status !== 'passed') return strict.reason ?? 'strictContent layer did not pass';
  if (strict.data?.applicable !== true) return 'strictContent gate was not applicable to this report';
  if (strict.data?.passed !== true) return strict.data?.reason ?? 'strictContent data did not pass';
  return null;
}

/** Strict evidence must be recent AND produced from an ancestor of HEAD. */
export const DEFAULT_MAX_EVIDENCE_AGE_DAYS = 14;

/**
 * Strict-mode latency gate: threshold starting points come from historical
 * passing evidence reports (full runs measured firstVisible<=7s and
 * firstFinal<=7s; the live report generator already rejects secondary runs
 * above 8s/15s, so the evidence gate starts at those documented bounds).
 * firstTtsQueued/firstPlayback only have a non-representative 12s short
 * sample (1s/2s) as history, so they default to null and are asserted only
 * when configured via --latency-thresholds.
 */
export const DEFAULT_STRICT_LATENCY_THRESHOLDS = {
  firstVisibleTranslationLatencySeconds: 8,
  firstFinalTranslationLatencySeconds: 15,
  firstTtsQueuedLatencySeconds: null,
  firstPlaybackLatencySeconds: null,
};

export function normalizeLatencyThresholds(value) {
  const thresholds = { ...DEFAULT_STRICT_LATENCY_THRESHOLDS };
  if (value == null || value === true) return thresholds;
  const entries = typeof value === 'string'
    ? value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => item.split('=').map((part) => part.trim()))
    : Object.entries(value);
  for (const [field, raw] of entries) {
    if (!(field in thresholds)) {
      throw new Error(`unknown latency threshold field: ${field}; expected one of ${Object.keys(thresholds).join(', ')}`);
    }
    if (raw == null || raw === 'off' || raw === 'none') {
      thresholds[field] = null;
      continue;
    }
    const numeric = Number(raw);
    if (!Number.isFinite(numeric) || numeric < 0) {
      throw new Error(`invalid latency threshold for ${field}: ${raw} (expected a non-negative number of seconds, or off)`);
    }
    thresholds[field] = numeric;
  }
  return thresholds;
}

/**
 * Rejects a passed report whose produced latency fields exceed the configured
 * thresholds. Fields that the run did not produce are not asserted; the
 * failure reason always carries the measured value.
 */
export function strictLatencyFailure(report, options = {}) {
  const thresholds = normalizeLatencyThresholds(options.latencyThresholds);
  const subtitleQueue = report.layers?.app?.data?.subtitleQueue;
  if (!subtitleQueue) return null;
  const violations = [];
  for (const [field, threshold] of Object.entries(thresholds)) {
    if (threshold == null) continue;
    const measured = Number(subtitleQueue[field]);
    if (!Number.isFinite(measured)) continue;
    if (measured > threshold) {
      violations.push(`${field}=${measured}s exceeds the ${threshold}s threshold`);
    }
  }
  if (violations.length === 0) return null;
  return `latency evidence exceeded threshold(s): ${violations.join('; ')} (adjust with --latency-thresholds field=seconds)`;
}

export function defaultIsAncestorOfHead(commit) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', commit, 'HEAD'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Strict-mode provenance gate: a passed report is still rejected when it is
 * older than the age budget, carries no producing commit, or its commit is
 * not an ancestor of the current HEAD. Before this gate, `--strict` accepted
 * arbitrarily stale artifacts as release evidence.
 */
export function strictProvenanceFailure(report, options = {}) {
  const now = options.now ?? Date.now();
  const maxAgeDays = Number(options.maxAgeDays ?? DEFAULT_MAX_EVIDENCE_AGE_DAYS);
  const generatedAtMs = Date.parse(report.generatedAt ?? '');
  if (!Number.isFinite(generatedAtMs)) {
    return 'strict evidence requires a parseable generatedAt timestamp';
  }
  const ageDays = (now - generatedAtMs) / 86_400_000;
  if (ageDays > maxAgeDays) {
    return `evidence is stale: generatedAt=${report.generatedAt} age=${ageDays.toFixed(1)}d exceeds the ${maxAgeDays}d budget; re-run the live matrix`;
  }
  const commit = typeof report.commit === 'string' && report.commit.trim() ? report.commit.trim() : null;
  if (!commit) {
    return 'strict evidence requires report.commit (regenerate with the current live runner, which stamps git rev-parse HEAD)';
  }
  const isAncestorOfHead = options.isAncestorOfHead ?? defaultIsAncestorOfHead;
  if (!isAncestorOfHead(commit)) {
    return `evidence commit ${commit} is not an ancestor of HEAD; the evidence does not cover the current code`;
  }
  return null;
}

function basicFailure(entry, options = {}) {
  const feedbackMode = entry.feedbackMode ?? reportFeedbackMode(entry.report);
  const failedLayers = requiredLayersFor(options, feedbackMode).filter(
    (layer) => entry.report.layers?.[layer]?.status !== 'passed',
  );
  const latestFailure = describeLatestFailure(entry, failedLayers, options);
  if (entry.report.verdict !== 'passed' || failedLayers.length > 0) {
    return {
      failedLayers,
      latestFailure,
      reason: [
        `verdict=${entry.report.verdict ?? 'unknown'}`,
        `failureLayer=${entry.report.failureLayer ?? '-'}`,
        `failureReason=${latestFailure.failureReason ?? '-'}`,
        `failedLayers=${failedLayers.join(',') || '-'}`,
      ].join(' '),
    };
  }
  if (options.strict && feedbackMode !== 'echo-cancel') {
    const reason = strictContentFailure(entry.report);
    if (reason) {
      return {
        failedLayers: ['strictContent'],
        latestFailure: describeLatestFailure(entry, ['strictContent'], options, reason),
        reason,
      };
    }
  }
  if (options.strict) {
    const provenanceReason = strictProvenanceFailure(entry.report, options);
    if (provenanceReason) {
      return {
        failedLayers: ['provenance'],
        latestFailure: describeLatestFailure(entry, ['provenance'], options, provenanceReason),
        reason: provenanceReason,
      };
    }
    const latencyReason = strictLatencyFailure(entry.report, options);
    if (latencyReason) {
      return {
        failedLayers: ['latency'],
        latestFailure: describeLatestFailure(entry, ['latency'], options, latencyReason),
        reason: latencyReason,
      };
    }
  }
  return { failedLayers: [], reason: null, latestFailure: null };
}

function invalidCandidateReason(entry) {
  if (!entry) return null;
  if (entry.parseError) {
    return `latest live report could not be parsed: ${entry.parseError} reportPath=${entry.reportPath}`;
  }
  if (entry.incomplete) {
    return `latest live report is incomplete: missingLayers=${entry.missingLayers.join(',')} reportPath=${entry.reportPath}`;
  }
  return null;
}

function uniqueTail(lines, limit = 12) {
  const output = [];
  const seen = new Set();
  for (const line of lines.filter(Boolean).reverse()) {
    const key = String(line);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(key);
    if (output.length >= limit) break;
  }
  return output.reverse();
}

function describeLatestFailure(entry, failedLayers = [], options = {}, fallbackReason = null) {
  const report = entry.report ?? {};
  const diagnostics = report.diagnostics ?? {};
  const evidence = diagnostics.evidence ?? {};
  const strict = report.layers?.strictContent?.data;
  return {
    reportPath: entry.reportPath,
    directoryName: entry.directoryName,
    modelId: entry.modelId ?? null,
    failureLayer: report.failureLayer ?? null,
    failureReason: report.failureReason
      ?? fallbackReason
      ?? report.layers?.[report.failureLayer]?.reason
      ?? null,
    failedLayers,
    failedSteps: diagnostics.failedSteps ?? [],
    checkFailures: diagnostics.checkFailures ?? [],
    keyEvidence: uniqueTail([
      ...(evidence.appErrors ?? []),
      ...(evidence.providerErrors ?? evidence.appProviderErrors ?? []),
      ...(evidence.appOmniPreconnect ?? []),
      ...(evidence.appReadiness ?? []),
      ...(evidence.bridgeErrors ?? []),
      ...(evidence.bridgeSourceSummary ?? []),
      ...(evidence.bridgeWatchdog ?? []),
      ...(strict?.failures ?? []),
    ], 16),
  };
}

function describeInvalidCandidate(entry) {
  const failureReason = invalidCandidateReason(entry);
  const diagnostics = entry.report?.diagnostics ?? {};
  return {
    reportPath: entry.reportPath,
    directoryName: entry.directoryName,
    modelId: entry.modelId ?? null,
    failureLayer: entry.report?.failureLayer ?? 'evidence',
    failureReason,
    failedLayers: entry.missingLayers ?? [],
    failedSteps: diagnostics.failedSteps ?? [],
    checkFailures: diagnostics.checkFailures ?? [],
    keyEvidence: uniqueTail([
      entry.parseError ? `parseError=${entry.parseError}` : null,
      entry.incomplete ? `missingLayers=${entry.missingLayers.join(',')}` : null,
      ...(diagnostics.evidence?.appErrors ?? []),
      ...(diagnostics.evidence?.providerErrors ?? diagnostics.evidence?.appProviderErrors ?? []),
      ...(diagnostics.evidence?.appOmniPreconnect ?? []),
      ...(diagnostics.evidence?.appReadiness ?? []),
    ], 16),
  };
}

function loadCandidates(root, options = {}) {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => !isExcludedDirectory(entry.name))
    .map((entry) => {
      const reportPath = path.join(root, entry.name, 'report.json');
      if (!fs.existsSync(reportPath)) return null;
      try {
        const report = readJson(reportPath);
        const stats = fs.statSync(reportPath);
        if (report.mode !== 'live') return null;
        const missingLayers = missingRequiredLayers(report, options);
        return {
          directoryName: entry.name,
          reportPath,
          report,
          reportMtimeMs: stats.mtimeMs,
          modelId: reportModelId(report),
          feedbackMode: reportFeedbackMode(report),
          complete: missingLayers.length === 0,
          incomplete: missingLayers.length > 0,
          missingLayers,
        };
      } catch (error) {
        const stats = fs.statSync(reportPath);
        return {
          directoryName: entry.name,
          reportPath,
          report: {
            verdict: 'failed',
            failureLayer: 'evidence',
            generatedAt: null,
            translationRoute: null,
            layers: {},
          },
          reportMtimeMs: stats.mtimeMs,
          modelId: null,
          feedbackMode: 'virtual-driver',
          complete: false,
          incomplete: false,
          missingLayers: requiredLayersFor(options),
          parseError: error instanceof Error ? error.message : String(error),
        };
      }
    })
    .filter(Boolean)
    .sort((left, right) => {
      const timeDiff = evidenceSortTime(right) - evidenceSortTime(left);
      return timeDiff || right.directoryName.localeCompare(left.directoryName);
    });
}

function normalizeModels(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value !== 'string' || !value.trim()) return [];
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

export function findWatchModeEvidence(options = {}) {
  const root = path.resolve(options.root ?? DEFAULT_ROOT);
  const strict = Boolean(options.strict);
  const requestedModels = normalizeModels(options.models);
  const models = requestedModels.length > 0 ? requestedModels : [];
  const requestedFeedbackModes = normalizeModels(options.feedbackModes);
  const feedbackModes = requestedFeedbackModes.length > 0 ? requestedFeedbackModes : ['virtual-driver'];
  if (!fs.existsSync(root)) {
    return {
      ok: false,
      reason: `watch-mode evidence root does not exist: ${root}`,
      root,
      latest: null,
      candidates: [],
      modelResults: [],
    };
  }

  const candidates = loadCandidates(root, { strict });
  const invalidCandidates = candidates.filter((entry) => entry.parseError || entry.incomplete);
  const completeCandidates = candidates.filter((entry) => entry.complete);
  const latestCandidate = candidates[0] ?? null;
  if (latestCandidate && !latestCandidate.complete) {
    const reason = invalidCandidateReason(latestCandidate);
    return {
      ok: false,
      reason,
      root,
      latest: null,
      latestFailure: describeInvalidCandidate(latestCandidate),
      candidates,
      invalidCandidates,
      modelResults: [],
    };
  }
  if (completeCandidates.length === 0) {
    const latestInvalid = invalidCandidates[0] ?? null;
    const invalidReason = invalidCandidateReason(latestInvalid);
    return {
      ok: false,
      reason: invalidReason ?? `no complete live watch-mode report found under ${root}`,
      root,
      latest: null,
      latestFailure: latestInvalid ? describeInvalidCandidate(latestInvalid) : null,
      candidates,
      invalidCandidates,
      modelResults: [],
    };
  }

  if (models.length > 0) {
    const modelResults = models.flatMap((model) => feedbackModes.map((feedbackMode) => {
      const latest = completeCandidates.find(
        (entry) => entry.modelId === model && entry.feedbackMode === feedbackMode,
      );
      if (!latest) {
        return {
          modelId: model,
          feedbackMode,
          ok: false,
          latest: null,
          failedLayers: [],
          reason: `no complete live watch-mode report found for model ${model} feedbackLoopPrevention ${feedbackMode}`,
        };
      }
      const failure = basicFailure(latest, { strict, now: options.now, maxAgeDays: options.maxAgeDays, isAncestorOfHead: options.isAncestorOfHead, latencyThresholds: options.latencyThresholds });
      return {
        modelId: model,
        feedbackMode,
        ok: failure.reason == null,
        latest,
        failedLayers: failure.failedLayers,
        reason: failure.reason,
        latestFailure: failure.latestFailure,
      };
    }));
    const failed = modelResults.filter((item) => !item.ok);
    return {
      ok: failed.length === 0,
      reason: failed.length === 0
        ? null
        : `watch-mode evidence failed for model(s): ${failed.map((item) => `${item.modelId}[${item.feedbackMode}]: ${item.reason}`).join('; ')}`,
      root,
      latest: modelResults[0]?.latest ?? null,
      failedLayers: [...new Set(modelResults.flatMap((item) => item.failedLayers))],
      candidates: completeCandidates,
      invalidCandidates,
      modelResults,
    };
  }

  const eligibleCandidates = completeCandidates.filter((entry) => feedbackModes.includes(entry.feedbackMode));
  const latest = eligibleCandidates[0];
  if (!latest) {
    return {
      ok: false,
      reason: `no complete live watch-mode report found for feedbackLoopPrevention ${feedbackModes.join(',')} under ${root}`,
      root,
      latest: null,
      candidates: completeCandidates,
      invalidCandidates,
      modelResults: [],
    };
  }
  const failure = basicFailure(latest, { strict, now: options.now, maxAgeDays: options.maxAgeDays, isAncestorOfHead: options.isAncestorOfHead, latencyThresholds: options.latencyThresholds });
  return {
    ok: failure.reason == null,
    reason: failure.reason == null
      ? null
      : `latest live watch-mode report is not passed: ${failure.reason}`,
    root,
    latest,
    failedLayers: failure.failedLayers,
    latestFailure: failure.latestFailure,
    candidates: completeCandidates,
    invalidCandidates,
    modelResults: [],
  };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    args[key] = next && !next.startsWith('--') ? argv[++index] : true;
  }
  return args;
}

function printEntry(entry, label = 'Latest Watch Mode report') {
  if (!entry) return;
  const report = entry.report;
  console.log(`${label}: ${entry.reportPath}`);
  console.log(`ModelId: ${entry.modelId ?? '-'}`);
  console.log(`FeedbackLoopPrevention: ${entry.feedbackMode ?? '-'}`);
  console.log(`GeneratedAt: ${report.generatedAt ?? '-'}`);
  console.log(`TranslationRoute: ${report.translationRoute ?? '-'}`);
  console.log(`Verdict: ${report.verdict ?? '-'}`);
  console.log(`FailureLayer: ${report.failureLayer ?? '-'}`);
  console.log(`FailureReason: ${report.failureReason ?? '-'}`);
  const strict = report.layers?.strictContent?.data;
  if (strict) {
    console.log(`StrictContent: applicable=${strict.applicable ?? '-'} passed=${strict.passed ?? '-'} coverage=${strict.coverage ?? '-'}`);
  }
}

function printFailureDetails(failure, label = 'Failure details') {
  if (!failure) return;
  console.error(`${label}: ${failure.failureReason ?? '-'}`);
  if (failure.reportPath) console.error(`ReportPath: ${failure.reportPath}`);
  for (const step of failure.failedSteps ?? []) {
    console.error(`FailedStep: ${step.name}: ${step.error ?? '-'}`);
  }
  for (const evidence of failure.keyEvidence ?? []) {
    console.error(`Evidence: ${evidence}`);
  }
}

function printEvidence(result) {
  if (result.modelResults?.length > 0) {
    for (const model of result.modelResults) {
      const label = model.feedbackMode ? `${model.modelId} [${model.feedbackMode}]` : model.modelId;
      if (model.latest) printEntry(model.latest, `Latest Watch Mode report for ${label}`);
      if (!model.ok) {
        console.error(`Model ${label} failed evidence gate: ${model.reason}`);
        printFailureDetails(model.latestFailure, `Failure details for ${label}`);
      }
    }
  } else if (result.latest) {
    printEntry(result.latest);
  }
  if (result.ok) {
    console.log('Watch Mode live evidence gate passed.');
    return;
  }
  console.error(`Watch Mode live evidence gate failed: ${result.reason}`);
  printFailureDetails(result.latestFailure);
  const invalidCandidates = result.invalidCandidates ?? [];
  for (const invalid of invalidCandidates.slice(0, INVALID_CANDIDATE_PRINT_LIMIT)) {
    if (invalid.parseError) {
      console.error(`InvalidReport: ${invalid.reportPath}: ${invalid.parseError}`);
    } else if (invalid.incomplete) {
      console.error(`IncompleteReport: ${invalid.reportPath}: missingLayers=${invalid.missingLayers.join(',')}`);
    }
  }
  if (invalidCandidates.length > INVALID_CANDIDATE_PRINT_LIMIT) {
    console.error(`InvalidReportSummary: ${invalidCandidates.length - INVALID_CANDIDATE_PRINT_LIMIT} older incomplete/invalid report(s) omitted; newest ${INVALID_CANDIDATE_PRINT_LIMIT} shown.`);
  }
  console.error('Next step: npm run test:watch-mode-live:matrix');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const strict = args.strict === true || args.strict === 'true';
  const models = normalizeModels(args.models)
    .concat(strict && !args.models ? DEFAULT_STRICT_MODELS : [])
    .filter((value, index, list) => list.indexOf(value) === index);
  const feedbackModes = normalizeModels(args['feedback-modes']);
  let latencyThresholds;
  try {
    latencyThresholds = normalizeLatencyThresholds(args['latency-thresholds']);
  } catch (error) {
    console.error(`Invalid --latency-thresholds: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
    process.exit();
  }
  const result = findWatchModeEvidence({
    root: args.root ?? DEFAULT_ROOT,
    strict,
    models,
    feedbackModes,
    maxAgeDays: args['max-age-days'],
    latencyThresholds,
  });
  printEvidence(result);
  process.exitCode = result.ok ? 0 : 1;
}
