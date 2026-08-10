import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  compactTimestamp,
  ensureDir,
  isMain,
  parseCliArgs,
  repoRoot,
  writeJson,
} from '../lib/testing-common.mjs';
import { archiveReleaseManualEvidence } from './archive-release-manual-evidence.mjs';
import { currentGitProvenance } from './git-provenance.mjs';
import {
  assertCleanEvidenceProvenance,
  buildPerformanceStrictSourceReceipt,
  derivePerformanceMeasurementsFromSource,
  hashEvidenceArtifact,
  PERFORMANCE_BASELINE_SCENARIO,
  PERFORMANCE_LIVE_SOURCE_SCHEMA_VERSION,
  PERFORMANCE_THRESHOLDS,
  performanceThresholdIssues,
  RELEASE_MANUAL_SCHEMA_VERSION,
  resolvePerformanceStrictAuthority,
} from './release-manual-evidence.mjs';
import { CANONICAL_STRICT_MATRIX_MANIFEST } from './run-watch-mode-live-matrix.mjs';

const DEFAULT_OUTPUT_ROOT = 'artifacts/testing/perf-baseline';
const DEFAULT_EVIDENCE_OUTPUT_ROOT = 'artifacts/testing/release-manual-evidence';
const DEFAULT_MANIFEST_PATH = path.join(
  'artifacts',
  'testing',
  'watch-mode-live',
  CANONICAL_STRICT_MATRIX_MANIFEST,
);

const asForwardSlash = (value) => value.split(path.sep).join('/');
const safeCellName = (cellKey) => cellKey.replace(/[^A-Za-z0-9._-]+/g, '-');

const addCopiedArtifact = ({
  stagingRoot,
  sourcePath,
  targetRelativePath,
  role,
  cellKey,
}) => {
  const targetPath = path.join(stagingRoot, targetRelativePath);
  ensureDir(path.dirname(targetPath));
  fs.copyFileSync(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
  const hashed = hashEvidenceArtifact(targetPath);
  return {
    role,
    ...(cellKey ? { cellKey } : {}),
    path: asForwardSlash(targetRelativePath),
    originalPath: path.resolve(sourcePath),
    sha256: hashed.sha256,
    byteCount: hashed.byteCount,
  };
};

export function assemblePerformanceBaseline({
  operator,
  runManifest = DEFAULT_MANIFEST_PATH,
  outputRoot = DEFAULT_OUTPUT_ROOT,
  evidenceOutputRoot = DEFAULT_EVIDENCE_OUTPUT_ROOT,
  workspaceRoot = repoRoot,
  provenance = currentGitProvenance({ cwd: workspaceRoot }),
  now = new Date(),
  performanceAuthorityResolver = resolvePerformanceStrictAuthority,
} = {}) {
  if (typeof operator !== 'string' || !operator.trim()) {
    throw new Error('--operator is required');
  }
  assertCleanEvidenceProvenance(provenance);
  const expectedManifestPath = path.resolve(workspaceRoot, DEFAULT_MANIFEST_PATH);
  const manifestPath = path.resolve(workspaceRoot, String(runManifest ?? ''));
  if (manifestPath !== expectedManifestPath) {
    throw new Error(`performance baseline must use the canonical strict matrix manifest: ${expectedManifestPath}`);
  }
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `canonical strict matrix manifest is missing: ${manifestPath}; run npm run test:watch-mode-live:matrix first`,
    );
  }

  const authority = performanceAuthorityResolver({
    workspaceRoot,
    manifestPath,
    currentProvenance: provenance,
    now: now.getTime(),
  });
  const { manifest } = authority;
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-performance-evidence-'));
  try {
    const sourceArtifacts = [addCopiedArtifact({
      stagingRoot,
      sourcePath: manifestPath,
      targetRelativePath: 'strict-matrix.json',
      role: 'watch-mode-strict-matrix',
    })];
    const evidenceRoot = path.dirname(manifestPath);
    const sourceManifestPath = path.resolve(evidenceRoot, String(manifest.sourceManifest ?? ''));
    const verificationReceiptPath = path.resolve(
      evidenceRoot,
      String(manifest.verificationReceiptPath ?? ''),
    );
    sourceArtifacts.push(addCopiedArtifact({
      stagingRoot,
      sourcePath: sourceManifestPath,
      targetRelativePath: 'strict-source-manifest.json',
      role: 'watch-mode-strict-source-manifest',
    }));
    sourceArtifacts.push(addCopiedArtifact({
      stagingRoot,
      sourcePath: verificationReceiptPath,
      targetRelativePath: 'strict-verification-receipt.json',
      role: 'watch-mode-strict-verification-receipt',
    }));
    const seenCells = new Set();
    for (const [index, cell] of manifest.cells.entries()) {
      const cellKey = cell.cellId;
      const runDirectory = authority.runDirectoriesByCell.get(cellKey);
      const report = authority.reportsByCell.get(cellKey);
      if (!runDirectory || !report) {
        throw new Error(`strict authority did not return an authorized report/run directory for ${cellKey}`);
      }
      const reportPath = path.join(runDirectory, 'report.json');
      const metricsPath = path.join(runDirectory, 'system-metrics.json');
      if (!fs.existsSync(reportPath)) throw new Error(`Watch report is missing: ${reportPath}`);
      if (!fs.existsSync(metricsPath)) {
        throw new Error(
          `raw system metrics are missing: ${metricsPath}; re-run the strict matrix with the metrics collector`,
        );
      }
      if (seenCells.has(cellKey)) throw new Error(`canonical matrix contains duplicate cell ${cellKey}`);
      seenCells.add(cellKey);
      const cellDirectory = path.join('runs', `${String(index + 1).padStart(2, '0')}-${safeCellName(cellKey)}`);
      sourceArtifacts.push(addCopiedArtifact({
        stagingRoot,
        sourcePath: reportPath,
        targetRelativePath: path.join(cellDirectory, 'report.json'),
        role: 'watch-mode-report',
        cellKey,
      }));
      sourceArtifacts.push(addCopiedArtifact({
        stagingRoot,
        sourcePath: metricsPath,
        targetRelativePath: path.join(cellDirectory, 'system-metrics.json'),
        role: 'system-metrics',
        cellKey,
      }));
    }

    const source = {
      schemaVersion: PERFORMANCE_LIVE_SOURCE_SCHEMA_VERSION,
      artifactKind: 'performance-live-source',
      generatedAt: now.toISOString(),
      provenance,
      collection: {
        mode: 'watch-mode-strict-matrix',
        command: 'npm run test:watch-mode-live:matrix',
        startedAt: null,
        finishedAt: null,
        sourceArtifacts,
        sourceReceipt: buildPerformanceStrictSourceReceipt(manifest, sourceArtifacts),
      },
      measurements: null,
    };
    const derived = derivePerformanceMeasurementsFromSource(source, stagingRoot, {
      workspaceRoot,
      currentProvenance: provenance,
      now: now.getTime(),
      strictAuthority: authority,
      performanceAuthorityResolver,
    });
    if (derived.issues.length > 0 || !derived.measurements) {
      throw new Error(`performance evidence is invalid:\n- ${derived.issues.join('\n- ')}`);
    }
    source.collection.startedAt = derived.collection.startedAt;
    source.collection.finishedAt = derived.collection.finishedAt;
    source.measurements = derived.measurements;
    writeJson(path.join(stagingRoot, 'performance-source.json'), source);

    const archived = archiveReleaseManualEvidence({
      source: stagingRoot,
      scenarioId: PERFORMANCE_BASELINE_SCENARIO,
      outputRoot: evidenceOutputRoot,
      workspaceRoot,
      provenance,
      now,
    });
    const thresholdFailures = performanceThresholdIssues(source.measurements);
    const report = {
      schemaVersion: RELEASE_MANUAL_SCHEMA_VERSION,
      artifactKind: 'performance-baseline',
      generatedAt: now.toISOString(),
      operator: operator.trim(),
      build: provenance.headCommit,
      verdict: thresholdFailures.length === 0 ? 'PASS' : 'FAIL',
      provenance,
      environment: 'Windows production desktop shell; canonical budget-balanced release validation plan',
      scenario: 'Provider p95 + subtitle commit p95 + subtitle TTS playback + process-tree resource stability',
      thresholds: { ...PERFORMANCE_THRESHOLDS },
      measurements: source.measurements,
      sourceEvidence: {
        receiptPath: asForwardSlash(path.relative(workspaceRoot, archived.receiptPath)),
        receiptSha256: archived.receiptSha256,
      },
      thresholdFailures,
      notes: [
        'Measurements were independently assembled from archived canonical Watch reports and raw system-metrics samples.',
        'CPU is the worst per-cell process-tree p95; memory is the matrix-wide process-tree peak.',
        'Stability duration is the shortest verified Watch session across the two 10-minute model-stability cells.',
      ],
    };
    const resolvedOutputRoot = ensureDir(path.resolve(workspaceRoot, outputRoot));
    const reportPath = writeJson(
      path.join(resolvedOutputRoot, `desktop-perf-baseline-${compactTimestamp(now)}.json`),
      report,
    );
    return {
      reportPath,
      receiptPath: archived.receiptPath,
      verdict: report.verdict,
      thresholdFailures,
      measurements: report.measurements,
    };
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  try {
    const args = parseCliArgs(process.argv.slice(2), {
      defaults: {
        operator: '',
        runManifest: DEFAULT_MANIFEST_PATH,
        outputRoot: DEFAULT_OUTPUT_ROOT,
        evidenceOutputRoot: DEFAULT_EVIDENCE_OUTPUT_ROOT,
      },
    });
    console.log(JSON.stringify(assemblePerformanceBaseline(args), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
