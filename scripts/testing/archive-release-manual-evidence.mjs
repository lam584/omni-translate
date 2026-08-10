import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  compactTimestamp,
  ensureDir,
  isMain,
  parseCliArgs,
  repoRoot,
  writeJson,
} from '../lib/testing-common.mjs';
import { currentGitProvenance } from './git-provenance.mjs';
import {
  assertCleanEvidenceProvenance,
  hashEvidenceArtifact,
  PERFORMANCE_BASELINE_SCENARIO,
  RELEASE_EVIDENCE_RECEIPT_SCHEMA_VERSION,
  RELEASE_EVIDENCE_SCENARIOS,
} from './release-manual-evidence.mjs';
import {
  RELEASE_MANUAL_COLLECTOR_PROFILES,
  validateReleaseManualCollectorPackage,
} from './release-manual-collector.mjs';

const DEFAULT_OUTPUT_ROOT = 'artifacts/testing/release-manual-evidence';

const safeScenarioId = (scenarioId) => scenarioId.toLowerCase().replace(/[^a-z0-9-]+/g, '-');

export function archiveReleaseManualEvidence({
  source,
  scenarioId,
  outputRoot = DEFAULT_OUTPUT_ROOT,
  workspaceRoot = repoRoot,
  provenance = currentGitProvenance({ cwd: workspaceRoot }),
  now = new Date(),
  suffix = crypto.randomUUID().slice(0, 8),
  testOnlyAllowSyntheticAuthority = false,
  testOnlyRealDeviceAuthorityResolver,
} = {}) {
  if (!RELEASE_EVIDENCE_SCENARIOS.includes(scenarioId)) {
    throw new Error(
      `--scenario-id must be one of: ${RELEASE_EVIDENCE_SCENARIOS.join(', ')}`,
    );
  }
  assertCleanEvidenceProvenance(provenance);
  const sourcePath = path.resolve(workspaceRoot, String(source ?? ''));
  if (!source || !fs.existsSync(sourcePath)) {
    throw new Error(`--source must name an existing file or directory: ${sourcePath}`);
  }
  let collectorManifest = null;
  if (scenarioId !== PERFORMANCE_BASELINE_SCENARIO) {
    const checked = validateReleaseManualCollectorPackage(sourcePath, scenarioId, {
      workspaceRoot,
      currentProvenance: provenance,
      now: now.getTime(),
      testOnlyAllowSyntheticAuthority,
      ...(testOnlyAllowSyntheticAuthority ? { testOnlyRealDeviceAuthorityResolver } : {}),
    });
    if (checked.issues.length > 0 || !checked.manifest) {
      throw new Error(
        `--source is not a valid official ${scenarioId} collector package:\n- ${checked.issues.join('\n- ')}`,
      );
    }
    collectorManifest = checked.manifest;
  }
  const outputBase = path.resolve(workspaceRoot, outputRoot);
  const sourcePrefix = `${sourcePath}${path.sep}`;
  if (outputBase === sourcePath || outputBase.startsWith(sourcePrefix)) {
    throw new Error('evidence output root may not be inside the source artifact');
  }
  const runDir = path.join(
    outputBase,
    provenance.headCommit.slice(0, 12),
    `${compactTimestamp(now)}-${safeScenarioId(scenarioId)}-${suffix}`,
  );
  ensureDir(runDir);
  const sourceStats = fs.lstatSync(sourcePath);
  if (sourceStats.isSymbolicLink()) {
    throw new Error(`evidence source may not be a symbolic link: ${sourcePath}`);
  }
  const archivedName = sourceStats.isDirectory()
    ? 'payload'
    : `payload${path.extname(sourcePath).toLowerCase()}`;
  const archivedPath = path.join(runDir, archivedName);
  if (sourceStats.isDirectory()) {
    fs.cpSync(sourcePath, archivedPath, { recursive: true, force: false, errorOnExist: true });
  } else if (sourceStats.isFile()) {
    fs.copyFileSync(sourcePath, archivedPath, fs.constants.COPYFILE_EXCL);
  } else {
    throw new Error(`evidence source must be a file or directory: ${sourcePath}`);
  }
  const archived = hashEvidenceArtifact(archivedPath);
  const receipt = {
    schemaVersion: RELEASE_EVIDENCE_RECEIPT_SCHEMA_VERSION,
    artifactKind: 'release-manual-evidence-receipt',
    scenarioId,
    generatedAt: now.toISOString(),
    provenance,
    source: {
      originalPath: sourcePath,
      archivedPath: archivedName,
      kind: archived.kind,
      sha256: archived.sha256,
      fileCount: archived.fileCount,
      byteCount: archived.byteCount,
    },
    ...(collectorManifest ? {
      collector: {
        collectorId: collectorManifest.collector.collectorId,
        collectorVersion: collectorManifest.collector.collectorVersion,
        collectionId: collectorManifest.collectionId,
        scenarioId: collectorManifest.scenarioId,
        evidenceArtifactKind: collectorManifest.evidenceArtifactKind,
        manifestSha256: hashEvidenceArtifact(
          path.join(archivedPath, 'collector-manifest.json'),
        ).sha256,
      },
    } : {}),
  };
  const receiptPath = writeJson(path.join(runDir, 'evidence-receipt.json'), receipt);
  const receiptHash = hashEvidenceArtifact(receiptPath);
  return {
    receiptPath,
    receiptSha256: receiptHash.sha256,
    archivedPath,
    archivedSha256: archived.sha256,
  };
}

if (isMain(import.meta.url)) {
  try {
    const args = parseCliArgs(process.argv.slice(2), {
      defaults: {
        source: '',
        scenarioId: '',
        outputRoot: DEFAULT_OUTPUT_ROOT,
      },
    });
    console.log(JSON.stringify(archiveReleaseManualEvidence(args), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
