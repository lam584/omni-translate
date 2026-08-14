import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { isMain, parseCliArgs, repoRoot } from '../lib/testing-common.mjs';
import { currentGitProvenance } from './git-provenance.mjs';
import {
  buildStrictRuntimeAuthority,
  strictRuntimeEnvironment,
} from './run-watch-mode-live-matrix.mjs';
import {
  currentAuthorityImplementationHashes,
  currentAuthorityRuntimeBinaryHashes,
} from './watch-mode-evidence-authority.mjs';
import {
  createIncidentPlusAssignments,
  createIncidentPlusExecutionPlan,
  createIncidentPlusPreflightGrant,
  createIncidentPlusPreflightLeaseReservations,
  createIncidentPlusReadinessRequests,
  currentIncidentPlusImplementationHashes,
  issueIncidentPlusCellLeases,
  writeIncidentPlusPreflightAuthorizationPackage,
  writeIncidentPlusExecutionPlan,
} from './watch-mode-incident-plus-authority.mjs';
import {
  coordinatorKeyIdForPublicKey,
  generateCoordinatorSigningKeyPair,
} from './watch-mode-shard-authority.mjs';

export const INCIDENT_PLUS_RUNNER_ID = 'scripts/testing/run-watch-mode-incident-plus.mjs';

function readRegularJson(filePath, label) {
  const resolved = path.resolve(filePath);
  const stats = fs.lstatSync(resolved);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0) {
    throw new Error(`${label} must be a non-empty regular non-symlink JSON file`);
  }
  return JSON.parse(fs.readFileSync(resolved, 'utf8').replace(/^\uFEFF/, ''));
}

export function normalizeIncidentPlusWorkers(workerConfig) {
  const workers = Array.isArray(workerConfig?.workers) ? workerConfig.workers : workerConfig;
  if (!Array.isArray(workers)) throw new Error('incident Plus worker configuration requires a workers array');
  return workers.map((worker) => ({
    workerId: worker.workerId,
    ...(worker.user ? { interactiveUser: worker.user } : {}),
    vmIdentity: worker.vmIdentity,
    deviceProfileInstances: worker.deviceProfileInstances,
  }));
}

export function prepareIncidentPlusExecution({
  workerConfig,
  localIsolationAuthority,
  executionRoot = path.join(repoRoot, 'artifacts', 'testing', 'watch-mode-incident-plus'),
  executionId = `incident-plus-${crypto.randomUUID()}`,
  generatedAt = new Date(),
  expiresAt = new Date(generatedAt.getTime() + 6 * 60 * 60 * 1_000),
  signingKeys = generateCoordinatorSigningKeyPair(),
  provenance = currentGitProvenance({ cwd: repoRoot }),
  authorityImplementationHashes = currentAuthorityImplementationHashes({ workspaceRoot: repoRoot }),
  runtimeBinaryHashes = currentAuthorityRuntimeBinaryHashes({ workspaceRoot: repoRoot }),
  incidentImplementationHashes = currentIncidentPlusImplementationHashes({ workspaceRoot: repoRoot }),
}) {
  const workers = normalizeIncidentPlusWorkers(workerConfig);
  const assignments = createIncidentPlusAssignments(workers);
  const plan = createIncidentPlusExecutionPlan({
    executionId,
    generatedAt,
    expiresAt,
    provenance,
    authorityImplementationHashes,
    runtimeBinaryHashes,
    incidentImplementationHashes,
    localIsolationAuthority,
    workers,
    assignments,
    signingKeys,
  });
  const leases = issueIncidentPlusCellLeases(plan, signingKeys, { issuedAt: generatedAt });
  const readinessRequests = createIncidentPlusReadinessRequests(plan, signingKeys, { generatedAt });
  const root = path.resolve(executionRoot, executionId);
  if (fs.existsSync(root)) throw new Error(`incident Plus execution root already exists: ${root}`);
  const written = writeIncidentPlusExecutionPlan({
    executionRoot: root,
    plan,
    leases,
    readinessRequests,
  });
  const grantAt = new Date(generatedAt.getTime() + 1_000);
  const reservationAt = new Date(generatedAt.getTime() + 2_000);
  const grant = createIncidentPlusPreflightGrant({
    plan,
    leases,
    generatedAt: grantAt,
    signingKeys,
  });
  const leaseReservations = createIncidentPlusPreflightLeaseReservations({
    grant,
    plan,
    issuedAt: reservationAt,
    signingKeys,
  });
  const preflightAuthorization = writeIncidentPlusPreflightAuthorizationPackage({
    executionRoot: root,
    plan,
    grant,
    leaseReservations,
  });
  return {
    executionRoot: root,
    plan,
    leases,
    readinessRequests,
    grant,
    leaseReservations,
    preflightAuthorization,
    signingKeys,
    ...written,
  };
}

/**
 * Build the Desktop authority binary before writing an execution plan.  The
 * text-only preflight grant is deliberately signed by a fresh coordinator
 * key, and the Desktop verifier only accepts that grant when the same public
 * key identity was compiled into the release binary.  Keeping the build
 * before plan issuance prevents a superficially valid, but unusable, Plus
 * incident authority from ever reaching a Provider call.
 *
 * This remains separate from `prepareIncidentPlusExecution` so fixtures and
 * offline authority tests can inject deterministic inventories without
 * rebuilding native binaries.
 */
export function prepareCurrentIncidentPlusExecution({
  workerConfig,
  localIsolationAuthority,
  executionRoot = path.join(repoRoot, 'artifacts', 'testing', 'watch-mode-incident-plus'),
  executionId = `incident-plus-${crypto.randomUUID()}`,
  generatedAt = new Date(),
  expiresAt = new Date(generatedAt.getTime() + 6 * 60 * 60 * 1_000),
  signingKeys = generateCoordinatorSigningKeyPair(),
  buildRuntimeAuthority = buildStrictRuntimeAuthority,
  captureProvenance = () => currentGitProvenance({ cwd: repoRoot }),
  captureAuthorityImplementationHashes = () => currentAuthorityImplementationHashes({ workspaceRoot: repoRoot }),
  captureIncidentImplementationHashes = () => currentIncidentPlusImplementationHashes({ workspaceRoot: repoRoot }),
  environment = process.env,
}) {
  const coordinatorKeyId = coordinatorKeyIdForPublicKey(signingKeys.publicKeyPem);
  const runtimeBinaryHashes = buildRuntimeAuthority({
    environment: {
      ...strictRuntimeEnvironment(environment),
      OMNI_PROVIDER_PREFLIGHT_COORDINATOR_KEY_ID: coordinatorKeyId,
    },
  });
  // The build is a mandatory provenance boundary.  In particular, do not
  // issue leases if a generated package, external edit, or stale checkout
  // made the evidence worktree dirty while compiling the signed runtime.
  const provenance = captureProvenance();
  if (provenance?.worktreeClean !== true || Number(provenance?.dirtyEntryCount) !== 0) {
    throw new Error('incident Plus runtime build changed the evidence worktree; refuse to issue a signed plan');
  }
  return prepareIncidentPlusExecution({
    workerConfig,
    localIsolationAuthority,
    executionRoot,
    executionId,
    generatedAt,
    expiresAt,
    signingKeys,
    provenance,
    authorityImplementationHashes: captureAuthorityImplementationHashes(),
    runtimeBinaryHashes,
    incidentImplementationHashes: captureIncidentImplementationHashes(),
  });
}

export function parseIncidentPlusCliArgs(argv) {
  return parseCliArgs(argv, {
    defaults: {
      workersConfig: '',
      localIsolationAuthority: '',
      executionRoot: 'artifacts/testing/watch-mode-incident-plus',
      executionId: '',
    },
  });
}

if (isMain(import.meta.url)) {
  try {
    const options = parseIncidentPlusCliArgs(process.argv.slice(2));
    if (!options.workersConfig) throw new Error('--workers-config is required');
    if (!options.localIsolationAuthority) throw new Error('--local-isolation-authority is required');
    const workers = readRegularJson(path.resolve(repoRoot, options.workersConfig), 'incident Plus worker config');
    const localIsolationAuthority = readRegularJson(
      path.resolve(repoRoot, options.localIsolationAuthority),
      'incident Plus local isolation authority',
    );
    const result = prepareCurrentIncidentPlusExecution({
      workerConfig: workers,
      localIsolationAuthority,
      executionRoot: path.resolve(repoRoot, options.executionRoot),
      ...(options.executionId ? { executionId: options.executionId } : {}),
    });
    console.log(result.planPath);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
