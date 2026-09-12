import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { readJson, repoRoot } from '../lib/testing-common.mjs';
import {
  currentGitProvenance,
  exactGitProvenanceFailure,
  gitProvenanceShapeFailure,
} from './git-provenance.mjs';
import {
  CANONICAL_STRICT_MATRIX_MANIFEST,
  DEFAULT_FEEDBACK_MODES,
  DEFAULT_MODELS,
  SUPPORTED_DEVICE_CLASSES,
} from './run-watch-mode-live-matrix.mjs';
import {
  LIVE_LLM_CELLS,
  balancedReleasePlanFailure,
} from './watch-mode-balanced-release-plan.mjs';
import {
  resolveAuthorityPath,
  STRICT_MATRIX_ARTIFACT_KIND,
  STRICT_MATRIX_SCHEMA_VERSION,
} from './watch-mode-evidence-authority.mjs';
import {
  findWatchModeEvidence,
  readRunManifest,
  strictManifestProvenanceFailure,
  verifyStrictMatrixAuthority,
} from './verify-watch-mode-evidence.mjs';
import {
  RELEASE_MANUAL_COLLECTOR_PROFILES,
  validateReleaseManualCollectorPackage,
} from './release-manual-collector.mjs';

export const RELEASE_MANUAL_SCHEMA_VERSION = 2;
export const RELEASE_EVIDENCE_RECEIPT_SCHEMA_VERSION = 1;
export const PERFORMANCE_LIVE_SOURCE_SCHEMA_VERSION = 3;
export const PERFORMANCE_SYSTEM_METRICS_SCHEMA_VERSION = 1;
export const PERFORMANCE_STRICT_SOURCE_RECEIPT_KIND = 'performance-strict-matrix-source-receipt';
export const PERFORMANCE_STRICT_SOURCE_RECEIPT_SCHEMA_VERSION = 2;
export const DEFAULT_MANUAL_EVIDENCE_MAX_AGE_DAYS = 14;

export const MANUAL_E2E_SCENARIOS = [
  'E2E-PROVIDER-CONFIG',
  'E2E-PROVIDER-PROBE',
  'E2E-REAL-DEVICE-AUDIO',
  'E2E-OVERLAY-CLICK-THROUGH',
  'E2E-DIAGNOSTICS-EXPORT',
  'E2E-VIRTUAL-MIC-CAPTURE',
];

export const INSTALL_REGRESSION_SCENARIOS = [
  'INSTALL-FRESH',
  'INSTALL-REPAIR',
  'INSTALL-UNINSTALL',
  'INSTALL-UPGRADE',
  'INSTALL-RELEASE-LAYOUT',
];

export const PERFORMANCE_BASELINE_SCENARIO = 'PERFORMANCE-BASELINE';
export const RELEASE_EVIDENCE_SCENARIOS = [
  ...MANUAL_E2E_SCENARIOS,
  ...INSTALL_REGRESSION_SCENARIOS,
  PERFORMANCE_BASELINE_SCENARIO,
];

export const PERFORMANCE_THRESHOLDS = Object.freeze({
  providerFirstEventLatencyMs: 1200,
  subtitleCueCommitLatencyMs: 800,
  ttsRoundTripLatencyMs: 2200,
  cpuP95Percent: 65,
  memoryPeakMb: 900,
  terminalStageCoveragePercent: 100,
  allowedDropouts: 0,
});

export const PERFORMANCE_MEASUREMENT_NAMES = [
  'providerFirstEventLatencyMs',
  'subtitleCueCommitLatencyMs',
  'ttsRoundTripLatencyMs',
  'cpuP95Percent',
  'memoryPeakMb',
  'observedDropouts',
  'terminalStageCoveragePercent',
];

const asForwardSlash = (value) => value.split(path.sep).join('/');

const walkFiles = (root, current = root) => {
  const entries = fs.readdirSync(current, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name, 'en'));
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(current, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`evidence artifacts may not contain symbolic links: ${fullPath}`);
    }
    if (entry.isDirectory()) {
      files.push(...walkFiles(root, fullPath));
    } else if (entry.isFile()) {
      files.push({ fullPath, relativePath: asForwardSlash(path.relative(root, fullPath)) });
    }
  }
  return files;
};

/** A deterministic SHA-256 receipt for one file or an entire directory tree. */
export function hashEvidenceArtifact(candidate) {
  const resolved = path.resolve(candidate);
  if (!fs.existsSync(resolved)) {
    throw new Error(`evidence artifact does not exist: ${resolved}`);
  }
  const stats = fs.lstatSync(resolved);
  if (stats.isSymbolicLink()) {
    throw new Error(`evidence artifact may not be a symbolic link: ${resolved}`);
  }
  if (stats.isFile()) {
    const bytes = fs.readFileSync(resolved);
    return {
      kind: 'file',
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      fileCount: 1,
      byteCount: bytes.length,
    };
  }
  if (!stats.isDirectory()) {
    throw new Error(`evidence artifact must be a file or directory: ${resolved}`);
  }
  const digest = crypto.createHash('sha256');
  const files = walkFiles(resolved);
  let byteCount = 0;
  for (const file of files) {
    const bytes = fs.readFileSync(file.fullPath);
    byteCount += bytes.length;
    digest.update('file\0');
    digest.update(file.relativePath);
    digest.update('\0');
    digest.update(String(bytes.length));
    digest.update('\0');
    digest.update(bytes);
    digest.update('\0');
  }
  return {
    kind: 'directory',
    sha256: digest.digest('hex'),
    fileCount: files.length,
    byteCount,
  };
}

export const resolveEvidencePath = (candidate, workspaceRoot = repoRoot) => (
  path.isAbsolute(String(candidate ?? ''))
    ? path.resolve(String(candidate))
    : path.resolve(workspaceRoot, String(candidate ?? ''))
);

export function evidenceTimestampFailure(
  value,
  subject,
  { now = Date.now(), maxAgeDays = DEFAULT_MANUAL_EVIDENCE_MAX_AGE_DAYS } = {},
) {
  const parsed = Date.parse(String(value ?? ''));
  if (!Number.isFinite(parsed)) return `${subject} is missing or invalid`;
  if (parsed > now + 5 * 60 * 1000) return `${subject} is more than five minutes in the future`;
  const ageDays = (now - parsed) / (24 * 60 * 60 * 1000);
  if (ageDays > maxAgeDays) {
    return `${subject} is stale (${ageDays.toFixed(1)}d > ${maxAgeDays}d)`;
  }
  return null;
}

const markdownField = (content, name) => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return content.match(new RegExp(`^- ${escaped}:\\s*(.*)$`, 'm'))?.[1]?.trim() ?? '';
};

const markdownHeaderProvenance = (content) => ({
  schemaVersion: 1,
  source: 'git',
  captureStatus: 'captured',
  headCommit: markdownField(content, 'GitHead') || null,
  worktreeClean: markdownField(content, 'WorktreeClean') === 'true',
  dirtyEntryCount: Number(markdownField(content, 'DirtyEntryCount')),
});

const scenarioBlocks = (content) => {
  const matches = [...content.matchAll(/^### ([A-Z0-9-]+)\s*$/gm)];
  return matches.map((match, index) => {
    const nextScenarioIndex = matches[index + 1]?.index ?? content.length;
    const nextSectionOffset = content.slice(match.index + match[0].length).search(/^## [^#]/m);
    const nextSectionIndex = nextSectionOffset < 0
      ? content.length
      : match.index + match[0].length + nextSectionOffset;
    return {
      id: match[1],
      content: content.slice(match.index, Math.min(nextScenarioIndex, nextSectionIndex)),
    };
  });
};

const blockField = (block, name) => markdownField(block, name);

function validateEvidenceReceipt(
  receipt,
  receiptPath,
  {
    expectedScenarioId,
    currentProvenance,
    now,
    maxAgeDays,
    workspaceRoot,
    testOnlyAllowSyntheticAuthority,
    testOnlyRealDeviceAuthorityResolver,
  },
) {
  const issues = [];
  if (receipt?.schemaVersion !== RELEASE_EVIDENCE_RECEIPT_SCHEMA_VERSION) {
    issues.push(`receipt schemaVersion must be ${RELEASE_EVIDENCE_RECEIPT_SCHEMA_VERSION}`);
  }
  if (receipt?.artifactKind !== 'release-manual-evidence-receipt') {
    issues.push('receipt artifactKind must be release-manual-evidence-receipt');
  }
  if (receipt?.scenarioId !== expectedScenarioId) {
    issues.push(`receipt scenarioId must be ${expectedScenarioId}`);
  }
  const timestampIssue = evidenceTimestampFailure(receipt?.generatedAt, 'receipt.generatedAt', {
    now,
    maxAgeDays,
  });
  if (timestampIssue) issues.push(timestampIssue);
  const provenanceIssue = exactGitProvenanceFailure(receipt?.provenance, currentProvenance, {
    recordedSubject: 'receipt.provenance',
    currentSubject: 'current checkout provenance',
  });
  if (provenanceIssue) issues.push(provenanceIssue);

  const archivedPath = receipt?.source?.archivedPath;
  if (typeof archivedPath !== 'string' || !archivedPath.trim()) {
    issues.push('receipt source.archivedPath is missing');
    return issues;
  }
  const payloadPath = path.resolve(path.dirname(receiptPath), archivedPath);
  const receiptRoot = `${path.resolve(path.dirname(receiptPath))}${path.sep}`;
  if (payloadPath !== path.resolve(path.dirname(receiptPath)) && !payloadPath.startsWith(receiptRoot)) {
    issues.push('receipt source.archivedPath escapes the receipt directory');
    return issues;
  }
  try {
    const payload = hashEvidenceArtifact(payloadPath);
    if (payload.sha256 !== receipt?.source?.sha256) issues.push('receipt payload SHA-256 mismatch');
    if (payload.kind !== receipt?.source?.kind) issues.push('receipt payload kind mismatch');
    if (payload.fileCount !== receipt?.source?.fileCount) issues.push('receipt payload fileCount mismatch');
    if (payload.byteCount !== receipt?.source?.byteCount) issues.push('receipt payload byteCount mismatch');
    const collectorProfile = RELEASE_MANUAL_COLLECTOR_PROFILES[expectedScenarioId];
    if (collectorProfile) {
      const checked = validateReleaseManualCollectorPackage(payloadPath, expectedScenarioId, {
        workspaceRoot,
        currentProvenance,
        now,
        maxAgeDays,
        testOnlyAllowSyntheticAuthority,
        ...(testOnlyAllowSyntheticAuthority ? { testOnlyRealDeviceAuthorityResolver } : {}),
      });
      for (const issue of checked.issues) issues.push(`official collector package: ${issue}`);
      const manifest = checked.manifest;
      const manifestPath = path.join(payloadPath, 'collector-manifest.json');
      const expectedBinding = manifest ? {
        collectorId: manifest.collector?.collectorId,
        collectorVersion: manifest.collector?.collectorVersion,
        collectionId: manifest.collectionId,
        scenarioId: manifest.scenarioId,
        evidenceArtifactKind: manifest.evidenceArtifactKind,
        manifestSha256: fs.existsSync(manifestPath)
          ? hashEvidenceArtifact(manifestPath).sha256
          : null,
      } : null;
      if (!expectedBinding || JSON.stringify(receipt?.collector) !== JSON.stringify(expectedBinding)) {
        issues.push('receipt collector binding does not match the archived official collector manifest');
      }
    }
  } catch (error) {
    issues.push(error.message);
  }
  return issues;
}

function validateVirtualMicCaptureReceipt(
  receipt,
  receiptPath,
  block,
) {
  const issues = [];
  const payloadRoot = path.resolve(path.dirname(receiptPath), String(receipt.source.archivedPath ?? ''));
  try {
    const manifest = readJson(path.join(payloadRoot, 'collector-manifest.json'));
    const summary = manifest?.summary ?? {};
    const markdownExpectations = {
      ExpectedOutcome: 'supported-ready-real-capture',
      CapabilitySupported: 'true',
      CapabilityStatus: 'ready',
      CaptureEndpointName: String(summary.captureEndpointName ?? ''),
      VirtualMicFormat: '48000Hz/mono/pcm16',
      CapturedFrames: String(summary.capturedFrames ?? ''),
      BridgeVirtualMicFramesWritten: String(summary.virtualMicFramesWritten ?? ''),
      PhysicalPlaybackFrames: '0',
      CueCompletedCount: String(summary.cueCompletedCount ?? ''),
    };
    for (const [field, expected] of Object.entries(markdownExpectations)) {
      if (blockField(block.content, field) !== expected) {
        issues.push(`${field} must match receipt evidence (${expected})`);
      }
    }
  } catch (error) {
    issues.push(error.message);
  }
  return issues;
}

function validateCommonMarkdownHeader(
  content,
  { artifactKind, currentProvenance, now, maxAgeDays },
) {
  const issues = [];
  if (Number(markdownField(content, 'SchemaVersion')) !== RELEASE_MANUAL_SCHEMA_VERSION) {
    issues.push(`SchemaVersion must be ${RELEASE_MANUAL_SCHEMA_VERSION}`);
  }
  if (markdownField(content, 'ArtifactKind') !== artifactKind) {
    issues.push(`ArtifactKind must be ${artifactKind}`);
  }
  const generatedAtIssue = evidenceTimestampFailure(markdownField(content, 'GeneratedAt'), 'GeneratedAt', {
    now,
    maxAgeDays,
  });
  if (generatedAtIssue) issues.push(generatedAtIssue);
  if (!markdownField(content, 'Operator') || markdownField(content, 'Operator') === 'TODO') {
    issues.push('operator is missing');
  }
  const build = markdownField(content, 'Build');
  if (!build || build === 'TODO') {
    issues.push('build is missing');
  } else if (build !== currentProvenance?.headCommit) {
    issues.push(`Build must exactly match current HEAD ${currentProvenance?.headCommit ?? '(unavailable)'}`);
  }
  const provenanceIssue = exactGitProvenanceFailure(
    markdownHeaderProvenance(content),
    currentProvenance,
    {
      recordedSubject: `${artifactKind} report provenance`,
      currentSubject: 'current checkout provenance',
    },
  );
  if (provenanceIssue) issues.push(provenanceIssue);
  if (/\bTODO\b/.test(content)) issues.push('contains TODO placeholders');
  return issues;
}

export function validateMarkdownManualReport(
  content,
  {
    artifactKind,
    expectedScenarios,
    workspaceRoot = repoRoot,
    currentProvenance = currentGitProvenance({ cwd: workspaceRoot }),
    now = Date.now(),
    maxAgeDays = DEFAULT_MANUAL_EVIDENCE_MAX_AGE_DAYS,
    testOnlyAllowSyntheticAuthority = false,
    testOnlyRealDeviceAuthorityResolver,
  } = {},
) {
  if (!artifactKind || !Array.isArray(expectedScenarios)) {
    throw new Error('artifactKind and expectedScenarios are required');
  }
  const issues = validateCommonMarkdownHeader(content, {
    artifactKind,
    currentProvenance,
    now,
    maxAgeDays,
  });
  const blocks = scenarioBlocks(content);
  const ids = blocks.map((block) => block.id);
  if (JSON.stringify(ids) !== JSON.stringify(expectedScenarios)) {
    issues.push(`scenario set/order must be exactly: ${expectedScenarios.join(', ')}`);
  }

  for (const scenarioId of expectedScenarios) {
    const block = blocks.find((candidate) => candidate.id === scenarioId);
    if (!block) continue;
    if (!/^- \[[xX]\] PASS\s*$/m.test(block.content)) {
      issues.push(`${scenarioId}: PASS checkbox is not selected`);
    }
    if (/^- \[[xX]\] FAIL\s*$/m.test(block.content)) {
      issues.push(`${scenarioId}: FAIL checkbox is selected`);
    }
    const result = blockField(block.content, 'Result');
    if (!result || result === 'TODO') issues.push(`${scenarioId}: Result is missing`);
    const receiptCandidate = blockField(block.content, 'EvidenceReceipt');
    const expectedReceiptSha = blockField(block.content, 'EvidenceReceiptSha256').toLowerCase();
    if (!receiptCandidate || receiptCandidate === 'TODO') {
      issues.push(`${scenarioId}: EvidenceReceipt is missing`);
      continue;
    }
    if (!/^[a-f0-9]{64}$/.test(expectedReceiptSha)) {
      issues.push(`${scenarioId}: EvidenceReceiptSha256 must be 64 lowercase hex characters`);
      continue;
    }
    const receiptPath = resolveEvidencePath(receiptCandidate, workspaceRoot);
    try {
      const receiptHash = hashEvidenceArtifact(receiptPath);
      if (receiptHash.kind !== 'file') {
        issues.push(`${scenarioId}: EvidenceReceipt must be a JSON file`);
        continue;
      }
      if (receiptHash.sha256 !== expectedReceiptSha) {
        issues.push(`${scenarioId}: EvidenceReceipt SHA-256 mismatch`);
        continue;
      }
      const receipt = readJson(receiptPath);
      for (const issue of validateEvidenceReceipt(receipt, receiptPath, {
        expectedScenarioId: scenarioId,
        currentProvenance,
        now,
        maxAgeDays,
        workspaceRoot,
        testOnlyAllowSyntheticAuthority,
        ...(testOnlyAllowSyntheticAuthority ? { testOnlyRealDeviceAuthorityResolver } : {}),
      })) {
        issues.push(`${scenarioId}: ${issue}`);
      }
      if (scenarioId === 'E2E-VIRTUAL-MIC-CAPTURE') {
        for (const issue of validateVirtualMicCaptureReceipt(receipt, receiptPath, block, {
          now,
          maxAgeDays,
        })) {
          issues.push(`${scenarioId}: ${issue}`);
        }
      }
    } catch (error) {
      issues.push(`${scenarioId}: ${error.message}`);
    }
  }

  const finalSection = content.split(/^## Final Verdict\s*$/m)[1] ?? '';
  if (!/^- \[[xX]\] PASS\s*$/m.test(finalSection)) issues.push('final PASS verdict is not selected');
  if (/^- \[[xX]\] FAIL\s*$/m.test(finalSection)) issues.push('final FAIL verdict is selected');
  return [...new Set(issues)];
}

const numericMeasurementIssues = (measurements) => {
  const issues = [];
  for (const name of PERFORMANCE_MEASUREMENT_NAMES) {
    const value = measurements?.[name];
    if (!Number.isFinite(value) || value < 0) issues.push(`missing or invalid measurement: ${name}`);
  }
  return issues;
};

export const performanceThresholdIssues = (measurements, thresholds = PERFORMANCE_THRESHOLDS) => {
  const issues = [];
  for (const name of [
    'providerFirstEventLatencyMs',
    'subtitleCueCommitLatencyMs',
    'ttsRoundTripLatencyMs',
    'cpuP95Percent',
    'memoryPeakMb',
  ]) {
    if (Number.isFinite(measurements?.[name]) && measurements[name] > thresholds[name]) {
      issues.push(`${name}=${measurements[name]} exceeds threshold ${thresholds[name]}`);
    }
  }
  if (Number.isFinite(measurements?.observedDropouts) && measurements.observedDropouts !== 0) {
    issues.push(`observedDropouts must be 0, received ${measurements.observedDropouts}`);
  }
  if (Number.isFinite(measurements?.terminalStageCoveragePercent)
    && measurements.terminalStageCoveragePercent < thresholds.terminalStageCoveragePercent) {
    issues.push(
      `terminalStageCoveragePercent=${measurements.terminalStageCoveragePercent} is lower than ${thresholds.terminalStageCoveragePercent}`,
    );
  }
  return issues;
};

const expectedPerformanceCellKeys = () => LIVE_LLM_CELLS.map(({ cellId }) => cellId);

const performanceCellKey = (cell) => String(cell?.cellId ?? '');

const reportIdentityKey = ({ modelId, feedbackLoopPrevention, deviceClass }) => (
  `${modelId}::${feedbackLoopPrevention}::${deviceClass}`
);

const authorityMapKey = (directory) => {
  const resolved = path.resolve(directory);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

const sameResolvedPath = (left, right) => {
  const normalizedLeft = authorityMapKey(left);
  const normalizedRight = authorityMapKey(right);
  return normalizedLeft === normalizedRight;
};

const canonicalPerformanceManifestPath = (workspaceRoot) => path.resolve(
  workspaceRoot,
  'artifacts/testing/watch-mode-live',
  CANONICAL_STRICT_MATRIX_MANIFEST,
);

const strictPerformanceShapeFailure = (manifest) => {
  if (
    manifest?.schemaVersion !== STRICT_MATRIX_SCHEMA_VERSION
    || manifest?.artifactKind !== STRICT_MATRIX_ARTIFACT_KIND
  ) {
    return `canonical strict matrix must use ${STRICT_MATRIX_ARTIFACT_KIND} schemaVersion=${STRICT_MATRIX_SCHEMA_VERSION}`;
  }
  if (manifest.strict !== true || manifest.evidenceMode !== 'live' || manifest.verification !== 'passed') {
    return 'canonical strict matrix must be a verified passed live strict matrix';
  }
  const validationPlanFailure = balancedReleasePlanFailure(manifest.validationPlan);
  if (validationPlanFailure) return validationPlanFailure;
  if (
    !isDeepStrictEqual(manifest.models, DEFAULT_MODELS)
    || !isDeepStrictEqual(manifest.feedbackLoopPreventionModes, DEFAULT_FEEDBACK_MODES)
  ) {
    return 'canonical strict matrix model/route set is not the exact release grid';
  }
  const deviceClasses = Array.isArray(manifest.deviceProfiles)
    ? manifest.deviceProfiles.map((profile) => profile?.deviceClass)
    : [];
  if (
    deviceClasses.length !== SUPPORTED_DEVICE_CLASSES.length
    || !SUPPORTED_DEVICE_CLASSES.every((deviceClass) => (
      deviceClasses.filter((candidate) => candidate === deviceClass).length === 1
    ))
  ) {
    return `canonical strict matrix device profiles are not exactly: ${SUPPORTED_DEVICE_CLASSES.join(', ')}`;
  }
  const expectedCells = expectedPerformanceCellKeys();
  const actualCells = Array.isArray(manifest.cells)
    ? manifest.cells.map((cell) => performanceCellKey(cell))
    : [];
  if (
    actualCells.length !== expectedCells.length
    || new Set(actualCells).size !== expectedCells.length
    || expectedCells.some((cellKey) => !actualCells.includes(cellKey))
  ) {
    return 'canonical strict matrix paid cell set is not the exact budget-approved balanced release plan';
  }
  return null;
};

/**
 * Resolves the canonical performance source through the same production
 * authority path as `test:watch-mode-evidence:strict`. A verification receipt
 * is only an index: all cell receipts, fixed raw artifacts, rebuilt reports,
 * runtime binaries, zero-LLM local isolation authority, and the strict balanced
 * release verdict are checked again here.
 */
export function resolvePerformanceStrictAuthority({
  workspaceRoot = repoRoot,
  manifestPath = canonicalPerformanceManifestPath(workspaceRoot),
  currentProvenance = currentGitProvenance({ cwd: workspaceRoot }),
  now = Date.now(),
  maxAgeDays = DEFAULT_MANUAL_EVIDENCE_MAX_AGE_DAYS,
} = {}) {
  const expectedManifestPath = canonicalPerformanceManifestPath(workspaceRoot);
  const resolvedManifestPath = path.resolve(manifestPath);
  if (!sameResolvedPath(resolvedManifestPath, expectedManifestPath)) {
    throw new Error(`performance authority must use the canonical strict matrix manifest: ${expectedManifestPath}`);
  }
  const resolved = readRunManifest(resolvedManifestPath, { baseDirectory: workspaceRoot });
  const shapeFailure = strictPerformanceShapeFailure(resolved.manifest);
  if (shapeFailure) throw new Error(shapeFailure);
  const provenanceFailure = strictManifestProvenanceFailure(resolved.manifest, {
    currentProvenance,
  });
  if (provenanceFailure) {
    throw new Error(`canonical strict matrix provenance failed: ${provenanceFailure}`);
  }
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const authority = verifyStrictMatrixAuthority({
    manifestPath: resolved.manifestPath,
    manifest: resolved.manifest,
    evidenceRoot: path.dirname(resolved.manifestPath),
    currentProvenance,
    workspaceRoot,
    now: nowMs,
    maxAgeDays,
  });
  const strictResult = findWatchModeEvidence({
    root: path.dirname(resolved.manifestPath),
    strict: true,
    models: DEFAULT_MODELS,
    feedbackModes: DEFAULT_FEEDBACK_MODES,
    deviceClasses: SUPPORTED_DEVICE_CLASSES,
    releaseCells: LIVE_LLM_CELLS,
    runDirectories: authority.runDirectories,
    authorizedReports: authority.authorizedReports,
    currentProvenance,
    now: nowMs,
    maxAgeDays,
  });
  if (!strictResult.ok) {
    throw new Error(`canonical strict matrix evidence failed: ${strictResult.reason ?? 'unknown strict evidence failure'}`);
  }

  const reportsByCell = new Map();
  const runDirectoriesByCell = new Map();
  const rawArtifactsByCell = new Map();
  for (const [index, cell] of resolved.manifest.cells.entries()) {
    const runDirectory = authority.runDirectories[index];
    const report = authority.authorizedReports.get(authorityMapKey(runDirectory));
    if (!report) throw new Error(`canonical strict matrix cell ${index} has no authorized rebuilt report`);
    const cellKey = performanceCellKey(cell);
    const reportCellIdentity = reportIdentityKey({
      modelId: report.modelId,
      feedbackLoopPrevention: report.feedbackLoopPrevention,
      deviceClass: report.deviceEvidence?.deviceClass,
    });
    const expectedReportIdentity = reportIdentityKey(cell);
    if (reportCellIdentity !== expectedReportIdentity) {
      throw new Error(`canonical strict matrix cell ${index} authorized report identity is ${reportCellIdentity}, expected ${expectedReportIdentity}`);
    }
    reportsByCell.set(cellKey, report);
    runDirectoriesByCell.set(cellKey, runDirectory);
    const receiptPath = resolveAuthorityPath(
      path.dirname(resolved.manifestPath),
      cell.receiptPath,
      `canonical strict matrix cell ${index} receipt`,
    );
    const receipt = readJson(receiptPath);
    const artifactByPath = new Map(receipt.artifacts.map((artifact) => [artifact.path, artifact]));
    const rawReport = artifactByPath.get('report.json');
    const rawSystemMetrics = artifactByPath.get('system-metrics.json');
    const rawTerminal = artifactByPath.get('evidence-driven-terminal.json');
    if (!rawReport || !rawSystemMetrics || !rawTerminal) {
      throw new Error(`canonical strict matrix cell ${index} receipt does not bind report.json, system-metrics.json, and evidence-driven-terminal.json`);
    }
    rawArtifactsByCell.set(cellKey, {
      receiptPath,
      report: rawReport,
      systemMetrics: rawSystemMetrics,
      terminal: rawTerminal,
    });
  }
  return {
    manifestPath: resolved.manifestPath,
    manifest: resolved.manifest,
    runDirectories: authority.runDirectories,
    authorizedReports: authority.authorizedReports,
    reportsByCell,
    runDirectoriesByCell,
    rawArtifactsByCell,
    implementationHashes: authority.implementationHashes,
    runtimeBinaryHashes: authority.runtimeBinaryHashes,
  };
}

const receiptArtifactBinding = (artifact) => ({
  role: artifact.role,
  path: artifact.path,
  originalPath: path.resolve(artifact.originalPath),
  sha256: artifact.sha256,
  byteCount: artifact.byteCount,
});

export function buildPerformanceStrictSourceReceipt(manifest, sourceArtifacts) {
  const exactlyOne = (role) => {
    const matches = sourceArtifacts.filter((artifact) => artifact.role === role);
    if (matches.length !== 1) throw new Error(`performance authority requires exactly one ${role} artifact`);
    return receiptArtifactBinding(matches[0]);
  };
  const exactlyOneCell = (role, cellKey) => {
    const matches = sourceArtifacts.filter((artifact) => (
      artifact.role === role && artifact.cellKey === cellKey
    ));
    if (matches.length !== 1) {
      throw new Error(`performance authority requires exactly one ${role} artifact for ${cellKey}`);
    }
    return receiptArtifactBinding(matches[0]);
  };
  return {
    schemaVersion: PERFORMANCE_STRICT_SOURCE_RECEIPT_SCHEMA_VERSION,
    artifactKind: PERFORMANCE_STRICT_SOURCE_RECEIPT_KIND,
    canonicalManifest: exactlyOne('watch-mode-strict-matrix'),
    sourceManifest: exactlyOne('watch-mode-strict-source-manifest'),
    strictVerificationReceipt: exactlyOne('watch-mode-strict-verification-receipt'),
    cells: manifest.cells.map((cell) => {
      const cellKey = performanceCellKey(cell);
      return {
        cellKey,
        runDirectory: cell.runDirectory,
        receiptPath: cell.receiptPath,
        receiptBytes: cell.receiptBytes,
        receiptSha256: cell.receiptSha256,
        report: exactlyOneCell('watch-mode-report', cellKey),
        systemMetrics: exactlyOneCell('system-metrics', cellKey),
        terminal: exactlyOneCell('evidence-driven-terminal', cellKey),
      };
    }),
  };
}

const finiteNonNegative = (value) => Number.isFinite(Number(value)) && Number(value) >= 0;

const percentileNearestRank = (values, percentile) => {
  const sorted = values.map(Number).filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil(sorted.length * percentile) - 1)];
};

const roundedMeasurement = (value) => Math.round(Number(value) * 1_000_000) / 1_000_000;

const measurementsMatch = (recorded, derived) => PERFORMANCE_MEASUREMENT_NAMES.every((name) => (
  Number.isFinite(recorded?.[name])
  && Number.isFinite(derived?.[name])
  && Math.abs(Number(recorded[name]) - Number(derived[name])) <= 0.000001
));

const artifactPathWithinRoot = (sourceRoot, candidate) => {
  const root = path.resolve(sourceRoot);
  const resolved = path.resolve(root, String(candidate ?? ''));
  return resolved === root || resolved.startsWith(`${root}${path.sep}`) ? resolved : null;
};

const reportDesktopPid = (report) => {
  const steps = report?.layers?.environment?.data;
  if (!Array.isArray(steps)) return null;
  const startStep = steps.find((step) => step?.name === 'start desktop shell' && step?.ok === true);
  const processId = Number(startStep?.result?.pid);
  return Number.isInteger(processId) && processId > 0 ? processId : null;
};

const dropoutCountForReport = (report) => {
  const bridgeMetrics = report?.diagnostics?.evidence?.bridgeMetrics ?? {};
  const values = [
    bridgeMetrics.underruns,
    bridgeMetrics.droppedFrames,
    bridgeMetrics.driverDroppedBytes,
    bridgeMetrics.staleSourceFramesDropped,
    report?.layers?.bridge?.data?.droppedFrameCount,
  ].map((value) => Number(value ?? 0));
  return values.every((value) => Number.isFinite(value) && value >= 0)
    ? values.reduce((total, value) => total + value, 0)
    : null;
};

const nullableDuration = (start, end) => {
  const startMs = Number(start);
  const endMs = Number(end);
  return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs
    ? endMs - startMs
    : null;
};

const nullableNumberMatches = (recorded, recomputed) => (
  recomputed == null
    ? recorded == null
    : Number.isFinite(Number(recorded)) && Number(recorded) === recomputed
);

const recomputeWatchLatencyEvidence = (watch, cellKey) => {
  const issues = [];
  const cues = Array.isArray(watch?.cues) ? watch.cues : [];
  const representativeCues = cues.filter((cue) => cue?.comparisonStatus !== 'superseded');
  if (representativeCues.length === 0) {
    issues.push(`${cellKey}: Watch report has no representative raw cues for latency recomputation`);
    return { issues, providerLatencyMs: null, subtitleLatencyMs: null };
  }
  const sourceToLlm = [];
  const llmFinalToRender = [];
  for (const [index, cue] of representativeCues.entries()) {
    const providerLatency = nullableDuration(cue?.sourceAtMs, cue?.llmFirstAtMs);
    const subtitleLatency = nullableDuration(cue?.llmFinalAtMs, cue?.renderedFinalAtMs);
    if (!nullableNumberMatches(cue?.sourceToLlmFirstMs, providerLatency)) {
      issues.push(`${cellKey}: cue ${index} sourceToLlmFirstMs does not match raw timestamps`);
    }
    if (!nullableNumberMatches(cue?.llmFinalToRenderMs, subtitleLatency)) {
      issues.push(`${cellKey}: cue ${index} llmFinalToRenderMs does not match raw timestamps`);
    }
    if (providerLatency != null) sourceToLlm.push(providerLatency);
    if (subtitleLatency != null) llmFinalToRender.push(subtitleLatency);
  }
  const providerLatencyMs = percentileNearestRank(sourceToLlm, 0.95);
  const subtitleLatencyMs = percentileNearestRank(llmFinalToRender, 0.95);
  if (Number(watch?.summary?.cueCount) !== representativeCues.length) {
    issues.push(`${cellKey}: Watch summary cueCount does not match raw representative cues`);
  }
  if (!nullableNumberMatches(watch?.summary?.p95SourceToLlmFirstMs, providerLatencyMs)) {
    issues.push(`${cellKey}: Watch summary p95SourceToLlmFirstMs does not match raw cue timestamps`);
  }
  if (!nullableNumberMatches(watch?.summary?.p95LlmFinalToRenderMs, subtitleLatencyMs)) {
    issues.push(`${cellKey}: Watch summary p95LlmFinalToRenderMs does not match raw cue timestamps`);
  }
  return { issues, providerLatencyMs, subtitleLatencyMs };
};

const validateSystemMetrics = (metrics, { cellKey, watchDurationMs, desktopProcessId, now, maxAgeDays }) => {
  const issues = [];
  if (metrics?.schemaVersion !== PERFORMANCE_SYSTEM_METRICS_SCHEMA_VERSION) {
    issues.push(`${cellKey}: system metrics schemaVersion must be ${PERFORMANCE_SYSTEM_METRICS_SCHEMA_VERSION}`);
  }
  if (metrics?.artifactKind !== 'watch-mode-system-metrics') {
    issues.push(`${cellKey}: system metrics artifactKind must be watch-mode-system-metrics`);
  }
  if (metrics?.scope !== 'process-tree') issues.push(`${cellKey}: system metrics scope must be process-tree`);
  if (metrics?.collector !== 'scripts/testing/collect-watch-mode-system-metrics.ps1') {
    issues.push(`${cellKey}: system metrics collector identity is missing or invalid`);
  }
  if (Number(metrics?.rootProcessId) !== desktopProcessId) {
    issues.push(`${cellKey}: system metrics rootProcessId does not match the launched desktop PID`);
  }
  if (!Number.isInteger(Number(metrics?.processorCount)) || Number(metrics.processorCount) <= 0) {
    issues.push(`${cellKey}: system metrics processorCount is invalid`);
  }
  const sampleIntervalMs = Number(metrics?.sampleIntervalMs);
  if (!Number.isInteger(sampleIntervalMs) || sampleIntervalMs < 250 || sampleIntervalMs > 5000) {
    issues.push(`${cellKey}: system metrics sampleIntervalMs must be between 250 and 5000`);
  }
  if (metrics?.completionReason !== 'root-process-exited') {
    issues.push(`${cellKey}: system metrics completionReason must be root-process-exited`);
  }
  if (!Array.isArray(metrics?.collectionErrors) || metrics.collectionErrors.length > 0) {
    issues.push(`${cellKey}: system metrics collectionErrors must be an empty array`);
  }
  const startedAt = Date.parse(String(metrics?.startedAt ?? ''));
  const finishedAt = Date.parse(String(metrics?.finishedAt ?? ''));
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt <= startedAt) {
    issues.push(`${cellKey}: system metrics collection timestamps are invalid`);
  } else {
    const timestampIssue = evidenceTimestampFailure(metrics.finishedAt, `${cellKey} system metrics finishedAt`, {
      now,
      maxAgeDays,
    });
    if (timestampIssue) issues.push(timestampIssue);
    const metricsDurationMs = finishedAt - startedAt;
    if (metricsDurationMs < watchDurationMs * 0.95) {
      issues.push(
        `${cellKey}: system metrics covered ${(metricsDurationMs / 60000).toFixed(3)} minutes, less than 95% of the Watch session`,
      );
    }
    if (Number.isFinite(sampleIntervalMs)) {
      const minimumSamples = Math.floor((metricsDurationMs / sampleIntervalMs) * 0.85);
      if (!Array.isArray(metrics?.samples) || metrics.samples.length < minimumSamples) {
        issues.push(`${cellKey}: system metrics sample coverage is incomplete; minimum=${minimumSamples}`);
      }
    }
  }
  const samples = Array.isArray(metrics?.samples) ? metrics.samples : [];
  if (Number(metrics?.sampleCount) !== samples.length || samples.length === 0) {
    issues.push(`${cellKey}: system metrics sampleCount does not match a non-empty samples array`);
  }
  let previousTimestamp = -Infinity;
  let previousElapsed = -Infinity;
  const cpuValues = [];
  const memoryValues = [];
  for (const [index, sample] of samples.entries()) {
    const timestamp = Date.parse(String(sample?.timestamp ?? ''));
    const elapsedMs = Number(sample?.elapsedMs);
    const cpuPercent = Number(sample?.cpuPercent);
    const workingSetMb = Number(sample?.workingSetMb);
    if (!Number.isFinite(timestamp) || timestamp <= previousTimestamp) {
      issues.push(`${cellKey}: system metrics sample ${index} timestamp is invalid or not increasing`);
      break;
    }
    if (!Number.isFinite(elapsedMs) || elapsedMs <= previousElapsed) {
      issues.push(`${cellKey}: system metrics sample ${index} elapsedMs is invalid or not increasing`);
      break;
    }
    if (!Number.isFinite(cpuPercent) || cpuPercent < 0 || cpuPercent > 105) {
      issues.push(`${cellKey}: system metrics sample ${index} cpuPercent is outside [0, 105]`);
      break;
    }
    if (!Number.isFinite(workingSetMb) || workingSetMb <= 0) {
      issues.push(`${cellKey}: system metrics sample ${index} workingSetMb must be positive`);
      break;
    }
    if (!Number.isInteger(Number(sample?.processCount)) || Number(sample.processCount) <= 0) {
      issues.push(`${cellKey}: system metrics sample ${index} processCount must be positive`);
      break;
    }
    previousTimestamp = timestamp;
    previousElapsed = elapsedMs;
    cpuValues.push(cpuPercent);
    memoryValues.push(workingSetMb);
  }
  return {
    issues,
    startedAt,
    finishedAt,
    cpuP95Percent: percentileNearestRank(cpuValues, 0.95),
    memoryPeakMb: memoryValues.length > 0 ? Math.max(...memoryValues) : null,
  };
};

/**
 * Independently derives the release performance aggregate from archived
 * canonical matrix reports and their raw per-process-tree system samples.
 * No number in performance-source.json is authoritative.
 */
export function derivePerformanceMeasurementsFromSource(
  source,
  sourceRoot,
  {
    workspaceRoot = repoRoot,
    currentProvenance = currentGitProvenance({ cwd: workspaceRoot }),
    now = Date.now(),
    maxAgeDays = DEFAULT_MANUAL_EVIDENCE_MAX_AGE_DAYS,
    performanceAuthorityResolver = resolvePerformanceStrictAuthority,
    strictAuthority = null,
  } = {},
) {
  const issues = [];
  const artifacts = source?.collection?.sourceArtifacts;
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    issues.push('performance source collection.sourceArtifacts is empty');
    return { issues, measurements: null };
  }
  const artifactPaths = new Set();
  const usableArtifacts = [];
  for (const artifact of artifacts) {
    const artifactPath = artifactPathWithinRoot(sourceRoot, artifact?.path);
    if (!artifactPath) {
      issues.push(`performance source artifact escapes evidence directory: ${artifact?.path}`);
      continue;
    }
    if (artifactPaths.has(artifactPath)) issues.push(`duplicate performance source artifact path: ${artifact.path}`);
    artifactPaths.add(artifactPath);
    if (![
      'watch-mode-strict-matrix',
      'watch-mode-strict-source-manifest',
      'watch-mode-strict-verification-receipt',
      'watch-mode-report',
      'system-metrics',
      'evidence-driven-terminal',
    ].includes(artifact?.role)) {
      issues.push(`unsupported performance source artifact role: ${artifact?.role ?? '(missing)'}`);
      continue;
    }
    if (!/^[a-f0-9]{64}$/.test(String(artifact?.sha256 ?? ''))) {
      issues.push(`performance source artifact ${artifact.role} has an invalid SHA-256`);
      continue;
    }
    try {
      const hashed = hashEvidenceArtifact(artifactPath);
      if (hashed.kind !== 'file') issues.push(`performance source artifact ${artifact.role} must be a file`);
      if (hashed.sha256 !== artifact.sha256) {
        issues.push(`performance source artifact ${artifact.role} SHA-256 mismatch`);
      }
      if (Number(artifact.byteCount) !== hashed.byteCount) {
        issues.push(`performance source artifact ${artifact.role} byteCount mismatch`);
      }
      usableArtifacts.push({ ...artifact, artifactPath });
    } catch (error) {
      issues.push(`performance source artifact ${artifact.role}: ${error.message}`);
    }
  }

  const manifestArtifacts = usableArtifacts.filter((artifact) => artifact.role === 'watch-mode-strict-matrix');
  const sourceManifestArtifacts = usableArtifacts.filter(
    (artifact) => artifact.role === 'watch-mode-strict-source-manifest',
  );
  const verificationArtifacts = usableArtifacts.filter(
    (artifact) => artifact.role === 'watch-mode-strict-verification-receipt',
  );
  const reportArtifacts = usableArtifacts.filter((artifact) => artifact.role === 'watch-mode-report');
  const metricsArtifacts = usableArtifacts.filter((artifact) => artifact.role === 'system-metrics');
  const terminalArtifacts = usableArtifacts.filter((artifact) => artifact.role === 'evidence-driven-terminal');
  const expectedCells = expectedPerformanceCellKeys();
  if (manifestArtifacts.length !== 1) issues.push('performance source must contain exactly one strict matrix manifest');
  if (sourceManifestArtifacts.length !== 1) {
    issues.push('performance source must contain exactly one strict source manifest');
  }
  if (verificationArtifacts.length !== 1) {
    issues.push('performance source must contain exactly one strict verification receipt');
  }
  if (reportArtifacts.length !== expectedCells.length) {
    issues.push(`performance source must contain exactly ${expectedCells.length} Watch reports`);
  }
  if (metricsArtifacts.length !== expectedCells.length) {
    issues.push(`performance source must contain exactly ${expectedCells.length} system metrics files`);
  }
  if (terminalArtifacts.length !== expectedCells.length) {
    issues.push(`performance source must contain exactly ${expectedCells.length} evidence-driven terminal files`);
  }

  let authority = strictAuthority;
  if (!authority) {
    try {
      authority = performanceAuthorityResolver({
        workspaceRoot,
        manifestPath: canonicalPerformanceManifestPath(workspaceRoot),
        currentProvenance,
        now,
        maxAgeDays,
      });
    } catch (error) {
      issues.push(`strict matrix authority: ${error.message}`);
    }
  }
  const manifest = authority?.manifest ?? null;
  const bindArchivedCopyToAuthority = (artifact, expectedOriginalPath, label) => {
    if (!artifact) return;
    if (!sameResolvedPath(artifact.originalPath, expectedOriginalPath)) {
      issues.push(`${label} originalPath is not the production authority artifact ${expectedOriginalPath}`);
      return;
    }
    try {
      const originalHash = hashEvidenceArtifact(expectedOriginalPath);
      if (
        originalHash.kind !== 'file'
        || originalHash.sha256 !== artifact.sha256
        || originalHash.byteCount !== Number(artifact.byteCount)
      ) {
        issues.push(`${label} archived copy does not match the current production authority artifact`);
      }
    } catch (error) {
      issues.push(`${label}: ${error.message}`);
    }
  };
  const bindArchivedCopyToCellReceipt = (artifact, receiptEntry, label) => {
    if (!artifact) return;
    if (
      !receiptEntry
      || receiptEntry.sha256 !== artifact.sha256
      || Number(receiptEntry.bytes) !== Number(artifact.byteCount)
    ) {
      issues.push(`${label} archived copy does not match the fixed per-cell raw inventory`);
    }
  };
  if (authority && manifestArtifacts.length === 1) {
    bindArchivedCopyToAuthority(
      manifestArtifacts[0],
      authority.manifestPath,
      'strict matrix manifest',
    );
    const evidenceRoot = path.dirname(authority.manifestPath);
    const sourceManifestPath = path.resolve(evidenceRoot, String(manifest.sourceManifest ?? ''));
    const verificationReceiptPath = path.resolve(
      evidenceRoot,
      String(manifest.verificationReceiptPath ?? ''),
    );
    bindArchivedCopyToAuthority(
      sourceManifestArtifacts[0],
      sourceManifestPath,
      'strict source manifest',
    );
    bindArchivedCopyToAuthority(
      verificationArtifacts[0],
      verificationReceiptPath,
      'strict verification receipt',
    );
    try {
      const expectedSourceReceipt = buildPerformanceStrictSourceReceipt(manifest, usableArtifacts);
      if (!isDeepStrictEqual(source?.collection?.sourceReceipt, expectedSourceReceipt)) {
        issues.push('performance source collection.sourceReceipt does not match strict manifest/verification receipt authority');
      }
    } catch (error) {
      issues.push(`performance source receipt: ${error.message}`);
    }
  }

  const reportByCell = new Map();
  const metricsByCell = new Map();
  const terminalByCell = new Map();
  for (const artifact of reportArtifacts) {
    if (reportByCell.has(artifact.cellKey)) issues.push(`duplicate Watch report cellKey: ${artifact.cellKey}`);
    reportByCell.set(artifact.cellKey, artifact);
  }
  for (const artifact of metricsArtifacts) {
    if (metricsByCell.has(artifact.cellKey)) issues.push(`duplicate system metrics cellKey: ${artifact.cellKey}`);
    metricsByCell.set(artifact.cellKey, artifact);
  }
  for (const artifact of terminalArtifacts) {
    if (terminalByCell.has(artifact.cellKey)) issues.push(`duplicate terminal cellKey: ${artifact.cellKey}`);
    terminalByCell.set(artifact.cellKey, artifact);
  }
  if (
    reportByCell.size !== expectedCells.length
    || metricsByCell.size !== expectedCells.length
    || terminalByCell.size !== expectedCells.length
    || expectedCells.some((cellKey) => (
      !reportByCell.has(cellKey) || !metricsByCell.has(cellKey) || !terminalByCell.has(cellKey)
    ))
  ) {
    issues.push(`performance source cell set must be exactly: ${expectedCells.join(', ')}`);
  }

  const providerLatencies = [];
  const subtitleLatencies = [];
  const ttsLatencies = [];
  const cpuP95Values = [];
  const memoryPeakValues = [];
  let observedDropouts = 0;
  let earliestMetricsStart = Infinity;
  let latestMetricsFinish = -Infinity;
  for (const cellKey of expectedCells) {
    const reportArtifact = reportByCell.get(cellKey);
    const metricsArtifact = metricsByCell.get(cellKey);
    const terminalArtifact = terminalByCell.get(cellKey);
    if (!reportArtifact || !metricsArtifact || !terminalArtifact) continue;
    try {
      const report = authority?.reportsByCell?.get(cellKey);
      const originalRunDirectory = authority?.runDirectoriesByCell?.get(cellKey);
      if (!report || !originalRunDirectory) {
        issues.push(`${cellKey}: strict authority did not return an authorized report/run directory`);
        continue;
      }
      const manifestCell = manifest?.cells?.find((cell) => cell.cellId === cellKey);
      const actualIdentity = reportIdentityKey({
        modelId: report?.modelId,
        feedbackLoopPrevention: report?.feedbackLoopPrevention,
        deviceClass: report?.deviceEvidence?.deviceClass,
      });
      const expectedIdentity = reportIdentityKey(manifestCell ?? {});
      if (actualIdentity !== expectedIdentity) issues.push(`${cellKey}: Watch report identity is ${actualIdentity}`);
      if (report?.mode !== 'live' || report?.verdict !== 'passed') {
        issues.push(`${cellKey}: Watch report must be a passed live report`);
      }
      const reportTimestampIssue = evidenceTimestampFailure(report?.generatedAt, `${cellKey} report.generatedAt`, {
        now,
        maxAgeDays,
      });
      if (reportTimestampIssue) issues.push(reportTimestampIssue);
      const reportProvenanceIssue = exactGitProvenanceFailure(report?.provenance, currentProvenance, {
        recordedSubject: `${cellKey} report provenance`,
        currentSubject: 'current checkout provenance',
      });
      if (reportProvenanceIssue) issues.push(reportProvenanceIssue);
      bindArchivedCopyToAuthority(
        reportArtifact,
        path.join(originalRunDirectory, 'report.json'),
        `${cellKey} Watch report`,
      );
      bindArchivedCopyToAuthority(
        metricsArtifact,
        path.join(originalRunDirectory, 'system-metrics.json'),
        `${cellKey} system metrics`,
      );
      bindArchivedCopyToAuthority(
        terminalArtifact,
        path.join(originalRunDirectory, 'evidence-driven-terminal.json'),
        `${cellKey} evidence-driven terminal`,
      );
      const rawAuthority = authority?.rawArtifactsByCell?.get(cellKey);
      if (!rawAuthority) {
        issues.push(`${cellKey}: strict authority did not return fixed raw report/system-metrics/terminal bindings`);
      } else {
        bindArchivedCopyToCellReceipt(
          reportArtifact,
          rawAuthority.report,
          `${cellKey} Watch report`,
        );
        bindArchivedCopyToCellReceipt(
          metricsArtifact,
          rawAuthority.systemMetrics,
          `${cellKey} system metrics`,
        );
        bindArchivedCopyToCellReceipt(
          terminalArtifact,
          rawAuthority.terminal,
          `${cellKey} evidence-driven terminal`,
        );
      }

      const watch = report?.watchSessionReport;
      const elapsedMs = Number(watch?.elapsedMs);
      const summaryDurationMs = Number(watch?.summary?.durationMs);
      if (
        watch?.status !== 'completed'
        || !finiteNonNegative(elapsedMs)
        || !finiteNonNegative(summaryDurationMs)
        || Math.abs(elapsedMs - summaryDurationMs) > 1000
      ) {
        issues.push(`${cellKey}: Watch session duration/status evidence is invalid`);
        continue;
      }
      const watchDurationMs = Math.min(elapsedMs, summaryDurationMs);
      const recomputedLatency = recomputeWatchLatencyEvidence(watch, cellKey);
      issues.push(...recomputedLatency.issues);
      const providerLatency = recomputedLatency.providerLatencyMs;
      const subtitleLatency = recomputedLatency.subtitleLatencyMs;
      if (!finiteNonNegative(providerLatency)) issues.push(`${cellKey}: provider p95 latency is missing`);
      else providerLatencies.push(providerLatency);
      if (!finiteNonNegative(subtitleLatency)) issues.push(`${cellKey}: subtitle commit p95 latency is missing`);
      else subtitleLatencies.push(subtitleLatency);
      if (report.feedbackLoopPrevention !== 'echo-cancel') {
        const firstPlaybackSeconds = Number(report?.layers?.app?.data?.subtitleQueue?.firstPlaybackLatencySeconds);
        if (!finiteNonNegative(firstPlaybackSeconds)) issues.push(`${cellKey}: subtitle TTS playback latency is missing`);
        else ttsLatencies.push(firstPlaybackSeconds * 1000);
      }
      const dropouts = dropoutCountForReport(report);
      if (dropouts == null) issues.push(`${cellKey}: dropout counters are missing or invalid`);
      else observedDropouts += dropouts;
      const desktopProcessId = reportDesktopPid(report);
      if (!desktopProcessId) issues.push(`${cellKey}: launched desktop PID evidence is missing`);
      const metrics = readJson(metricsArtifact.artifactPath);
      const validatedMetrics = validateSystemMetrics(metrics, {
        cellKey,
        watchDurationMs,
        desktopProcessId,
        now,
        maxAgeDays,
      });
      issues.push(...validatedMetrics.issues);
      if (Number.isFinite(validatedMetrics.cpuP95Percent)) cpuP95Values.push(validatedMetrics.cpuP95Percent);
      if (Number.isFinite(validatedMetrics.memoryPeakMb)) memoryPeakValues.push(validatedMetrics.memoryPeakMb);
      if (Number.isFinite(validatedMetrics.startedAt)) earliestMetricsStart = Math.min(earliestMetricsStart, validatedMetrics.startedAt);
      if (Number.isFinite(validatedMetrics.finishedAt)) latestMetricsFinish = Math.max(latestMetricsFinish, validatedMetrics.finishedAt);
    } catch (error) {
      issues.push(`${cellKey}: ${error.message}`);
    }
  }

  const completeAggregates = [
    providerLatencies.length === expectedCells.length,
    subtitleLatencies.length === expectedCells.length,
    ttsLatencies.length === LIVE_LLM_CELLS.filter((cell) => cell.feedbackLoopPrevention !== 'echo-cancel').length,
    terminalByCell.size === expectedCells.length,
    cpuP95Values.length === expectedCells.length,
    memoryPeakValues.length === expectedCells.length,
  ].every(Boolean);
  const measurements = completeAggregates ? {
    providerFirstEventLatencyMs: roundedMeasurement(Math.max(...providerLatencies)),
    subtitleCueCommitLatencyMs: roundedMeasurement(Math.max(...subtitleLatencies)),
    ttsRoundTripLatencyMs: roundedMeasurement(Math.max(...ttsLatencies)),
    cpuP95Percent: roundedMeasurement(Math.max(...cpuP95Values)),
    memoryPeakMb: roundedMeasurement(Math.max(...memoryPeakValues)),
    observedDropouts: roundedMeasurement(observedDropouts),
    terminalStageCoveragePercent: roundedMeasurement(
      (terminalByCell.size / expectedCells.length) * 100,
    ),
  } : null;
  return {
    issues: [...new Set(issues)],
    measurements,
    collection: {
      startedAt: Number.isFinite(earliestMetricsStart) ? new Date(earliestMetricsStart).toISOString() : null,
      finishedAt: Number.isFinite(latestMetricsFinish) ? new Date(latestMetricsFinish).toISOString() : null,
    },
  };
}

const validatePerformanceSourceArtifact = (
  source,
  sourceRoot,
  {
    workspaceRoot,
    currentProvenance,
    now,
    maxAgeDays,
    performanceAuthorityResolver,
  },
) => {
  const issues = [];
  if (source?.schemaVersion !== PERFORMANCE_LIVE_SOURCE_SCHEMA_VERSION) {
    issues.push(`performance source schemaVersion must be ${PERFORMANCE_LIVE_SOURCE_SCHEMA_VERSION}`);
  }
  if (source?.artifactKind !== 'performance-live-source') {
    issues.push('performance source artifactKind must be performance-live-source');
  }
  const timestampIssue = evidenceTimestampFailure(source?.generatedAt, 'performance source generatedAt', {
    now,
    maxAgeDays,
  });
  if (timestampIssue) issues.push(timestampIssue);
  const provenanceIssue = exactGitProvenanceFailure(source?.provenance, currentProvenance, {
    recordedSubject: 'performance source provenance',
    currentSubject: 'current checkout provenance',
  });
  if (provenanceIssue) issues.push(provenanceIssue);
  if (source?.collection?.mode !== 'watch-mode-strict-matrix') {
    issues.push('performance source collection.mode must be watch-mode-strict-matrix');
  }
  if (typeof source?.collection?.command !== 'string' || !source.collection.command.trim()) {
    issues.push('performance source collection.command is missing');
  }
  issues.push(...numericMeasurementIssues(source?.measurements));
  const derived = derivePerformanceMeasurementsFromSource(source, sourceRoot, {
    workspaceRoot,
    currentProvenance,
    now,
    maxAgeDays,
    performanceAuthorityResolver,
  });
  issues.push(...derived.issues);
  if (derived.measurements && !measurementsMatch(source?.measurements, derived.measurements)) {
    issues.push('performance-source.json measurements do not match independently recomputed raw evidence');
  }
  for (const field of ['startedAt', 'finishedAt']) {
    if (derived.collection[field] && Date.parse(source?.collection?.[field]) !== Date.parse(derived.collection[field])) {
      issues.push(`performance source collection.${field} does not match raw system metrics`);
    }
  }
  return { issues: [...new Set(issues)], derivedMeasurements: derived.measurements };
};

export function validatePerformanceReport(
  payload,
  {
    workspaceRoot = repoRoot,
    currentProvenance = currentGitProvenance({ cwd: workspaceRoot }),
    now = Date.now(),
    maxAgeDays = DEFAULT_MANUAL_EVIDENCE_MAX_AGE_DAYS,
    performanceAuthorityResolver = resolvePerformanceStrictAuthority,
  } = {},
) {
  const issues = [];
  if (payload?.schemaVersion !== RELEASE_MANUAL_SCHEMA_VERSION) {
    issues.push(`schemaVersion must be ${RELEASE_MANUAL_SCHEMA_VERSION}`);
  }
  if (payload?.artifactKind !== 'performance-baseline') {
    issues.push('artifactKind must be performance-baseline');
  }
  const timestampIssue = evidenceTimestampFailure(payload?.generatedAt, 'generatedAt', {
    now,
    maxAgeDays,
  });
  if (timestampIssue) issues.push(timestampIssue);
  if (
    typeof payload?.operator !== 'string'
    || !payload.operator.trim()
    || payload.operator.trim() === 'TODO'
  ) issues.push('operator is missing');
  if (payload?.verdict !== 'PASS') issues.push('verdict is not PASS');
  const provenanceIssue = exactGitProvenanceFailure(payload?.provenance, currentProvenance, {
    recordedSubject: 'performance report provenance',
    currentSubject: 'current checkout provenance',
  });
  if (provenanceIssue) issues.push(provenanceIssue);
  if (payload?.build !== currentProvenance?.headCommit) {
    issues.push(`build must exactly match current HEAD ${currentProvenance?.headCommit ?? '(unavailable)'}`);
  }
  if (JSON.stringify(payload?.thresholds) !== JSON.stringify(PERFORMANCE_THRESHOLDS)) {
    issues.push('thresholds do not match the locked release thresholds');
  }
  issues.push(...numericMeasurementIssues(payload?.measurements));
  issues.push(...performanceThresholdIssues(payload?.measurements, PERFORMANCE_THRESHOLDS));

  const receiptCandidate = payload?.sourceEvidence?.receiptPath;
  const expectedReceiptSha = String(payload?.sourceEvidence?.receiptSha256 ?? '').toLowerCase();
  if (typeof receiptCandidate !== 'string' || !receiptCandidate.trim()) {
    issues.push('sourceEvidence.receiptPath is missing');
    return [...new Set(issues)];
  }
  if (!/^[a-f0-9]{64}$/.test(expectedReceiptSha)) {
    issues.push('sourceEvidence.receiptSha256 must be 64 lowercase hex characters');
    return [...new Set(issues)];
  }
  const receiptPath = resolveEvidencePath(receiptCandidate, workspaceRoot);
  try {
    const receiptHash = hashEvidenceArtifact(receiptPath);
    if (receiptHash.kind !== 'file') issues.push('performance EvidenceReceipt must be a JSON file');
    if (receiptHash.sha256 !== expectedReceiptSha) issues.push('performance EvidenceReceipt SHA-256 mismatch');
    const receipt = readJson(receiptPath);
    for (const issue of validateEvidenceReceipt(receipt, receiptPath, {
      expectedScenarioId: PERFORMANCE_BASELINE_SCENARIO,
      currentProvenance,
      now,
      maxAgeDays,
      workspaceRoot,
    })) {
      issues.push(`performance receipt: ${issue}`);
    }
    const payloadPath = path.resolve(path.dirname(receiptPath), String(receipt?.source?.archivedPath ?? ''));
    if (receipt?.source?.kind !== 'directory') {
      issues.push('performance receipt payload must be a directory');
    } else {
      const sourcePath = path.join(payloadPath, 'performance-source.json');
      const source = readJson(sourcePath);
      const sourceValidation = validatePerformanceSourceArtifact(source, payloadPath, {
        workspaceRoot,
        currentProvenance,
        now,
        maxAgeDays,
        performanceAuthorityResolver,
      });
      issues.push(...sourceValidation.issues);
      if (
        sourceValidation.derivedMeasurements
        && !measurementsMatch(payload?.measurements, sourceValidation.derivedMeasurements)
      ) {
        issues.push('performance report measurements do not match independently recomputed raw evidence');
      }
    }
  } catch (error) {
    issues.push(`performance source evidence: ${error.message}`);
  }
  return [...new Set(issues)];
}

export function assertCleanEvidenceProvenance(provenance) {
  const failure = gitProvenanceShapeFailure(provenance, 'manual evidence provenance');
  if (failure) throw new Error(`manual evidence requires an exact clean git checkout: ${failure}`);
  return provenance;
}
