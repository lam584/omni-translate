import fs from 'node:fs';
import path from 'node:path';

import { isMain, parseCliArgs, repoRoot } from '../lib/testing-common.mjs';
import { currentGitProvenance, exactGitProvenanceFailure } from './git-provenance.mjs';
import {
  currentAuthorityImplementationHashes,
  currentPaidAuthorityImplementationHashes,
  currentAuthorityRuntimeBinaryHashes,
  fileAuthorityEntry,
  sameAuthorityInventory,
} from './watch-mode-evidence-authority.mjs';
import {
  INCIDENT_PLUS_AUTHORITY_SCHEMA_VERSION,
  INCIDENT_PLUS_EXECUTION_PLAN_FILE,
  INCIDENT_PLUS_MANIFEST_FILE,
  INCIDENT_PLUS_VERIFICATION_RECEIPT_FILE,
  currentIncidentPlusImplementationHashes,
  validateIncidentPlusManifest,
  verifyIncidentPlusExecutionPlan,
} from './watch-mode-incident-plus-authority.mjs';
import {
  canonicalJson,
  sha256Canonical,
  verifyCoordinatorAuthority,
} from './watch-mode-shard-authority.mjs';
import { verifyLocalIsolationManifest } from './watch-mode-local-isolation.mjs';
import {
  CANONICAL_STRICT_MATRIX_MANIFEST,
} from './run-watch-mode-live-matrix.mjs';
import {
  validateStrictMatrixVerificationReceipt,
  verifyStrictMatrixAuthority,
} from './verify-watch-mode-evidence.mjs';

export const WATCH_MODE_CLOSEOUT_SCHEMA_VERSION = 1;
export const WATCH_MODE_CLOSEOUT_KIND = 'watch-mode-loss-closeout-manifest';
export const WATCH_MODE_CLOSEOUT_FILE = 'watch-mode-loss-closeout-manifest.json';
export const WATCH_MODE_CLOSEOUT_RUNNER_ID = 'scripts/testing/watch-mode-closeout-manifest.mjs';

function readRegularJson(filePath, label) {
  const resolved = path.resolve(filePath);
  const stats = fs.lstatSync(resolved);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0) {
    throw new Error(`${label} must be a non-empty regular non-symlink JSON file`);
  }
  return JSON.parse(fs.readFileSync(resolved, 'utf8').replace(/^\uFEFF/, ''));
}

function portable(value) {
  return String(value).split(path.sep).join('/');
}

function closeoutUnsigned(value) {
  const { closeoutDigest, ...core } = value;
  return core;
}

function assertExactCurrentProvenance(recorded, current, label) {
  const failure = exactGitProvenanceFailure(recorded, current, {
    recordedSubject: label,
    currentSubject: 'current closeout checkout',
  });
  if (failure) throw new Error(failure);
}

export function loadIncidentPlusExecution(executionRoot) {
  const root = path.resolve(executionRoot);
  const planPath = path.join(root, INCIDENT_PLUS_EXECUTION_PLAN_FILE);
  const plan = readRegularJson(planPath, 'incident Plus execution plan');
  verifyIncidentPlusExecutionPlan(plan, { checkExpiry: false });
  const leases = plan.cells.map((_, index) => readRegularJson(
    path.join(root, 'leases', `${index + 1}.json`),
    `incident Plus cell lease ${index + 1}`,
  ));
  const readinessRequests = plan.workers.map((worker) => readRegularJson(
    path.join(root, `worker-readiness-request-${worker.workerId}.json`),
    `incident Plus readiness request ${worker.workerId}`,
  ));
  const readinessReceiptPaths = plan.workers.map((worker) => (
    path.join(root, 'readiness', `${worker.workerId}.json`)
  ));
  const manifestPath = path.join(root, INCIDENT_PLUS_MANIFEST_FILE);
  const verified = validateIncidentPlusManifest({
    manifestPath,
    plan,
    leases,
    executionRoot: root,
    readinessReceiptPaths,
    readinessRequests,
    now: new Date(),
  });
  const receiptPath = path.join(root, INCIDENT_PLUS_VERIFICATION_RECEIPT_FILE);
  const receipt = readRegularJson(receiptPath, 'incident Plus verification receipt');
  if (
    receipt.schemaVersion !== INCIDENT_PLUS_AUTHORITY_SCHEMA_VERSION
    || receipt.artifactKind !== 'watch-mode-incident-plus-verification-receipt'
    || receipt.incidentId !== plan.incidentId
    || receipt.verdict !== 'passed'
    || receipt.executionId !== plan.executionId
    || receipt.planDigest !== plan.planDigest
    || receipt.manifestDigest !== verified.manifest.manifestDigest
  ) throw new Error('incident Plus verification receipt does not bind the validated manifest');
  verifyCoordinatorAuthority(receipt, plan.coordinator.publicKeyPem, 'incident Plus verification receipt');
  const { signature, digest, verificationDigest, ...receiptCore } = receipt;
  if (verificationDigest !== sha256Canonical(receiptCore)) {
    throw new Error('incident Plus verification receipt digest mismatch');
  }
  return {
    root,
    planPath,
    manifestPath,
    receiptPath,
    plan,
    manifest: verified.manifest,
    receipt,
  };
}

export function verifyCloseoutInputs({
  incidentExecutionRoot,
  strictManifestPath = path.join(repoRoot, 'artifacts', 'testing', 'watch-mode-live', CANONICAL_STRICT_MATRIX_MANIFEST),
  localIsolationManifestPath,
  workspaceRoot = repoRoot,
  currentProvenance = currentGitProvenance({ cwd: workspaceRoot }),
  currentImplementationHashes = currentAuthorityImplementationHashes({ workspaceRoot }),
  currentPaidImplementationHashes = currentPaidAuthorityImplementationHashes({ workspaceRoot }),
  currentRuntimeBinaryHashes = currentAuthorityRuntimeBinaryHashes({ workspaceRoot }),
  currentIncidentImplementationHashes = currentIncidentPlusImplementationHashes({ workspaceRoot }),
}) {
  const incident = loadIncidentPlusExecution(incidentExecutionRoot);
  assertExactCurrentProvenance(incident.plan.provenance, currentProvenance, 'incident Plus plan provenance');
  if (!sameAuthorityInventory(incident.plan.authority.runtimeBinaryHashes, currentRuntimeBinaryHashes)) {
    throw new Error('incident Plus runtime binary hashes do not match the current release build');
  }
  if (!sameAuthorityInventory(incident.plan.authority.implementationHashes, currentImplementationHashes)) {
    throw new Error('incident Plus shared implementation hashes do not match the current checkout');
  }
  if (!sameAuthorityInventory(
    incident.plan.authority.incidentImplementationHashes,
    currentIncidentImplementationHashes,
  )) {
    throw new Error('incident Plus implementation hashes do not match the current checkout');
  }

  const resolvedLocalIsolation = path.resolve(
    localIsolationManifestPath ?? incident.plan.localIsolationAuthority.path,
  );
  const local = verifyLocalIsolationManifest({
    manifestPath: resolvedLocalIsolation,
    workspaceRoot,
    provenance: currentProvenance,
    runtimeBinaryHashes: currentRuntimeBinaryHashes,
  });
  const localAuthority = fileAuthorityEntry(
    resolvedLocalIsolation,
    portable(path.relative(workspaceRoot, resolvedLocalIsolation)),
  );
  if (
    localAuthority.bytes !== Number(incident.plan.localIsolationAuthority.bytes)
    || localAuthority.sha256 !== incident.plan.localIsolationAuthority.sha256
  ) throw new Error('incident Plus plan does not bind the supplied current local-isolation authority');

  const resolvedStrictManifest = path.resolve(strictManifestPath);
  const strictManifest = readRegularJson(resolvedStrictManifest, 'canonical strict matrix manifest');
  const strictRoot = path.dirname(resolvedStrictManifest);
  const strictAuthority = verifyStrictMatrixAuthority({
    manifestPath: resolvedStrictManifest,
    manifest: strictManifest,
    evidenceRoot: strictRoot,
    currentProvenance,
    workspaceRoot,
    currentImplementationHashes,
    currentPaidImplementationHashes,
    currentRuntimeBinaryHashes,
  });
  const strictReceipt = validateStrictMatrixVerificationReceipt({
    receiptPath: path.join(strictRoot, strictManifest.verificationReceiptPath),
    manifestPath: path.join(strictRoot, strictManifest.sourceManifest),
    manifest: readRegularJson(path.join(strictRoot, strictManifest.sourceManifest), 'strict source manifest'),
    currentProvenance,
    implementationHashes: currentImplementationHashes,
    paidImplementationHashes: currentPaidImplementationHashes,
    runtimeBinaryHashes: currentRuntimeBinaryHashes,
  });
  return {
    incident,
    local,
    strictAuthority,
    strictManifestPath: resolvedStrictManifest,
    strictManifest,
    strictReceipt,
    localIsolationManifestPath: resolvedLocalIsolation,
  };
}

export function buildWatchModeCloseoutManifest({
  incidentExecutionRoot,
  strictManifestPath,
  localIsolationManifestPath,
  workspaceRoot = repoRoot,
  currentProvenance = currentGitProvenance({ cwd: workspaceRoot }),
  currentImplementationHashes = currentAuthorityImplementationHashes({ workspaceRoot }),
  currentPaidImplementationHashes = currentPaidAuthorityImplementationHashes({ workspaceRoot }),
  currentRuntimeBinaryHashes = currentAuthorityRuntimeBinaryHashes({ workspaceRoot }),
  currentIncidentImplementationHashes = currentIncidentPlusImplementationHashes({ workspaceRoot }),
  generatedAt = new Date(),
}) {
  const verified = verifyCloseoutInputs({
    incidentExecutionRoot,
    strictManifestPath,
    localIsolationManifestPath,
    workspaceRoot,
    currentProvenance,
    currentImplementationHashes,
    currentPaidImplementationHashes,
    currentRuntimeBinaryHashes,
    currentIncidentImplementationHashes,
  });
  const base = path.resolve(workspaceRoot);
  const core = {
    schemaVersion: WATCH_MODE_CLOSEOUT_SCHEMA_VERSION,
    artifactKind: WATCH_MODE_CLOSEOUT_KIND,
    generatedAt: generatedAt.toISOString(),
    verdict: 'passed',
    provenance: currentProvenance,
    runtimeBinaryHashes: currentRuntimeBinaryHashes,
    implementationHashes: currentImplementationHashes,
    paidImplementationHashes: currentPaidImplementationHashes,
    incidentImplementationHashes: currentIncidentImplementationHashes,
    localIsolation: fileAuthorityEntry(
      verified.localIsolationManifestPath,
      portable(path.relative(base, verified.localIsolationManifestPath)),
    ),
    incidentPlus: {
      executionId: verified.incident.plan.executionId,
      plan: fileAuthorityEntry(
        verified.incident.planPath,
        portable(path.relative(base, verified.incident.planPath)),
      ),
      manifest: fileAuthorityEntry(
        verified.incident.manifestPath,
        portable(path.relative(base, verified.incident.manifestPath)),
      ),
      verificationReceipt: fileAuthorityEntry(
        verified.incident.receiptPath,
        portable(path.relative(base, verified.incident.receiptPath)),
      ),
      workerReadiness: verified.incident.manifest.workerReadiness,
      preflight: verified.incident.manifest.preflight,
      externalProviderBudget: verified.incident.manifest.externalProviderBudget,
    },
    strictReleaseMatrix: {
      manifest: fileAuthorityEntry(
        verified.strictManifestPath,
        portable(path.relative(base, verified.strictManifestPath)),
      ),
      verificationReceipt: fileAuthorityEntry(
        path.join(path.dirname(verified.strictManifestPath), verified.strictManifest.verificationReceiptPath),
        portable(path.relative(
          base,
          path.join(path.dirname(verified.strictManifestPath), verified.strictManifest.verificationReceiptPath),
        )),
      ),
      externalProviderBudget: verified.strictManifest.externalProviderBudget,
      shardExecution: verified.strictManifest.shardExecution,
      matrixIntegration: verified.strictManifest.matrixIntegration,
      validatedCellCount: verified.strictAuthority.runDirectories.length,
      verifier: verified.strictReceipt.artifactKind,
    },
  };
  return { ...core, closeoutDigest: sha256Canonical(core) };
}

export function writeWatchModeCloseoutManifest({
  outputPath,
  ...options
}) {
  const manifest = buildWatchModeCloseoutManifest(options);
  const resolved = path.resolve(outputPath);
  if (fs.existsSync(resolved)) throw new Error(`refusing to overwrite closeout manifest: ${resolved}`);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { outputPath: resolved, manifest };
}

export function parseWatchModeCloseoutArgs(argv) {
  return parseCliArgs(argv, {
    defaults: {
      incidentExecutionRoot: '',
      strictManifest: path.join('artifacts', 'testing', 'watch-mode-live', CANONICAL_STRICT_MATRIX_MANIFEST),
      localIsolationManifest: '',
      output: path.join('artifacts', 'testing', WATCH_MODE_CLOSEOUT_FILE),
    },
  });
}

if (isMain(import.meta.url)) {
  try {
    const options = parseWatchModeCloseoutArgs(process.argv.slice(2));
    if (!options.incidentExecutionRoot) throw new Error('--incident-execution-root is required');
    const result = writeWatchModeCloseoutManifest({
      incidentExecutionRoot: path.resolve(repoRoot, options.incidentExecutionRoot),
      strictManifestPath: path.resolve(repoRoot, options.strictManifest),
      ...(options.localIsolationManifest
        ? { localIsolationManifestPath: path.resolve(repoRoot, options.localIsolationManifest) }
        : {}),
      outputPath: path.resolve(repoRoot, options.output),
    });
    console.log(result.outputPath);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
