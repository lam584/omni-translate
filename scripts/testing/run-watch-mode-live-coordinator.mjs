import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { isMain, parseCliArgs, repoRoot } from '../lib/testing-common.mjs';
import { LIVE_LLM_CELLS } from './watch-mode-balanced-release-plan.mjs';
import {
  SHARD_AUTHORITY_SCHEMA_VERSION,
  SHARD_CELL_MAX_EXTERNAL_AUDIO_SAMPLES,
  SHARD_EXECUTION_PLAN_FILE,
  SHARD_MATRIX_CELL_COUNT,
  SHARD_MATRIX_MAX_EXTERNAL_AUDIO_SAMPLES,
  SHARD_MATRIX_MAX_EXTERNAL_AUDIO_SECONDS,
  atomicWriteJson,
  canonicalJson,
  coordinatorKeyIdForPublicKey,
  createSignedExecutionPlan,
  fileAuthorityEntry,
  generateCoordinatorSigningKeyPair,
  issueCellLeases,
  sha256Canonical,
  validateShardManifest,
  validateFileAuthorityEntry,
  validateWorkerZeroProviderReadinessAuthority,
  verifyCellLease,
  verifySignedExecutionPlan,
} from './watch-mode-shard-authority.mjs';
import { validateProviderPreflightRawAuthority } from './watch-mode-provider-preflight-authority.mjs';
import {
  PROVIDER_PREFLIGHT_COMPLETION_FILE as COORDINATOR_PREFLIGHT_COMPLETION_FILE,
  PROVIDER_PREFLIGHT_COMPLETION_KIND as COORDINATOR_PREFLIGHT_COMPLETION_KIND,
  PROVIDER_PREFLIGHT_GRANT_FILE as COORDINATOR_PREFLIGHT_GRANT_FILE,
  PROVIDER_PREFLIGHT_GRANT_KIND as COORDINATOR_PREFLIGHT_GRANT_KIND,
  PROVIDER_PREFLIGHT_LEASE_RESERVATION_DIRECTORY,
  PROVIDER_PREFLIGHT_LEASE_RESERVATION_KIND as COORDINATOR_PREFLIGHT_LEASE_RESERVATION_KIND,
  PROVIDER_PREFLIGHT_CONSUMPTION_CLAIM_FILE,
  createProviderPreflightCompletion,
  createProviderPreflightGrant,
  createProviderPreflightLeaseReservations,
  loadProviderPreflightAuthorizationPackage,
  providerPreflightReservationFileName,
  verifyProviderPreflightCompletion,
  verifyProviderPreflightGrant,
  verifyProviderPreflightLeaseReservations,
  validateProviderPreflightConsumptionClaim,
} from './watch-mode-provider-preflight-authorization.mjs';

export {
  COORDINATOR_PREFLIGHT_COMPLETION_FILE,
  COORDINATOR_PREFLIGHT_COMPLETION_KIND,
  COORDINATOR_PREFLIGHT_GRANT_FILE,
  COORDINATOR_PREFLIGHT_GRANT_KIND,
  COORDINATOR_PREFLIGHT_LEASE_RESERVATION_KIND,
  createProviderPreflightCompletion,
  createProviderPreflightGrant,
  createProviderPreflightLeaseReservations,
  verifyProviderPreflightCompletion,
  verifyProviderPreflightGrant,
  verifyProviderPreflightLeaseReservations,
};

export const SHARD_COORDINATOR_RUNNER_ID = 'scripts/testing/run-watch-mode-live-coordinator.mjs';
export const COORDINATOR_PROVIDER_PREFLIGHT_KIND = 'watch-mode-shard-provider-preflight-receipt';
export const COORDINATOR_PROVIDER_PREFLIGHT_FILE = 'provider-preflight-receipt.json';
export const COORDINATOR_PROVIDER_PREFLIGHT_INVENTORY_KIND = 'watch-mode-shard-provider-preflight-evidence-inventory';
export const COORDINATOR_PROVIDER_PREFLIGHT_EVIDENCE_ROOT = 'provider-preflight-evidence/raw';
export const COORDINATOR_PROVIDER_PREFLIGHT_INVENTORY_FILE = 'provider-preflight-evidence/inventory.json';
export const COORDINATOR_EXECUTION_RESERVATION_KIND = 'watch-mode-shard-execution-reservation';
export const COORDINATOR_DISPATCH_CLAIM_KIND = 'watch-mode-shard-dispatch-claim';
export const COORDINATOR_WAVE_COMPLETION_KIND = 'watch-mode-shard-wave-completion';
export const COORDINATOR_AGGREGATE_KIND = 'watch-mode-paid-shard-coordinator-aggregate';
export const COORDINATOR_AGGREGATE_FILE = 'coordinator-aggregate.json';
export const COORDINATOR_PREFLIGHT_AUTHORIZATION_DIRECTORY_SUFFIX = '.preflight-authorization';

const DEFAULT_CELL_PLACEMENT = Object.freeze([
  Object.freeze({ workerIndex: 0, waveIndex: 0 }),
  Object.freeze({ workerIndex: 1, waveIndex: 0 }),
  Object.freeze({ workerIndex: 2, waveIndex: 0 }),
  Object.freeze({ workerIndex: 1, waveIndex: 1 }),
  Object.freeze({ workerIndex: 0, waveIndex: 1 }),
  Object.freeze({ workerIndex: 1, waveIndex: 2 }),
  Object.freeze({ workerIndex: 0, waveIndex: 2 }),
  Object.freeze({ workerIndex: 2, waveIndex: 1 }),
]);

const TWO_WORKER_CELL_PLACEMENT = Object.freeze([
  Object.freeze({ capability: 'default-only', waveIndex: 0 }),
  Object.freeze({ capability: 'usb', waveIndex: 0 }),
  Object.freeze({ capability: 'default-only', waveIndex: 1 }),
  Object.freeze({ capability: 'usb', waveIndex: 1 }),
  Object.freeze({ capability: 'usb', waveIndex: 2 }),
  Object.freeze({ capability: 'usb', waveIndex: 3 }),
  Object.freeze({ capability: 'default-only', waveIndex: 2 }),
  Object.freeze({ capability: 'default-only', waveIndex: 3 }),
]);

const safeCellId = (cellId) => String(cellId).replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '');
const EXECUTION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{7,127}$/i;

function readJson(filePath, label) {
  let stats;
  try {
    stats = fs.lstatSync(filePath);
  } catch {
    throw new Error(`${label} is missing: ${filePath}`);
  }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0) {
    throw new Error(`${label} must be a non-empty regular file`);
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

export function assertCoordinatorExecutionRoot({ executionRoot, plan }) {
  const root = path.resolve(executionRoot);
  const stats = fs.lstatSync(root);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('coordinator executionRoot must be a regular non-symlink directory');
  }
  const planPath = path.join(root, SHARD_EXECUTION_PLAN_FILE);
  const recorded = readJson(planPath, 'coordinator execution plan');
  if (canonicalJson(recorded) !== canonicalJson(plan)) {
    throw new Error('coordinator executionRoot plan does not match the in-memory signed plan');
  }
  return { root, planPath };
}

export function defaultSingleWorkerAssignments(workers) {
  if (!Array.isArray(workers) || workers.length !== 1) {
    throw new Error('default strict placement requires exactly one local worker');
  }
  const worker = workers[0];
  const profiles = worker.deviceProfileInstances?.filter(
    (profile) => profile.deviceClass === 'default-speaker',
  ) ?? [];
  if (profiles.length !== 1) {
    throw new Error(`worker ${worker.workerId} must have exactly one default-speaker profile`);
  }
  return LIVE_LLM_CELLS.map((cell, cellIndex) => {
    return {
      cellId: cell.cellId,
      workerId: worker.workerId,
      waveIndex: cellIndex,
      deviceProfileInstanceId: profiles[0].instanceId,
    };
  });
}

// Transitional source-level alias only. It does not enable multi-worker
// placement or evidence compatibility; all current plans require one worker.
export const defaultThreeVmAssignments = defaultSingleWorkerAssignments;

function assertPreflightOutcome(outcome) {
  if (
    !outcome
    || outcome.status !== 'completed'
    || !String(outcome.providerId ?? '').trim()
    || !String(outcome.evidenceDirectory ?? '').trim()
    || outcome.operation !== 'text-translation-preflight'
    || outcome.inputMode !== 'text-only'
    || Number(outcome.providerInvocationCount) !== 1
    || Number(outcome.externalAudioSamples) !== 0
  ) throw new Error('coordinator provider preflight must be one completed text-only invocation with bound evidence');
  return outcome;
}

function copyPreflightTree(sourceDirectory, destinationDirectory) {
  const source = path.resolve(sourceDirectory);
  const stats = fs.lstatSync(source);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('provider preflight evidence must be a real non-symlink directory');
  }
  fs.mkdirSync(destinationDirectory, { recursive: false });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destinationDirectory, entry.name);
    const entryStats = fs.lstatSync(sourcePath);
    if (entryStats.isSymbolicLink()) throw new Error(`provider preflight evidence may not contain symlinks: ${sourcePath}`);
    if (entryStats.isDirectory()) copyPreflightTree(sourcePath, destinationPath);
    else if (entryStats.isFile()) fs.copyFileSync(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
    else throw new Error(`provider preflight evidence contains an unsupported entry: ${sourcePath}`);
  }
}

function preflightTreeInventory(rootDirectory) {
  const root = path.resolve(rootDirectory);
  const entries = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filePath = path.join(directory, entry.name);
      const stats = fs.lstatSync(filePath);
      const relativePath = path.relative(root, filePath).split(path.sep).join('/');
      if (stats.isSymbolicLink()) throw new Error(`provider preflight evidence may not contain symlinks: ${relativePath}`);
      if (stats.isDirectory()) visit(filePath);
      else if (stats.isFile()) {
        entries.push({
          path: relativePath,
          bytes: stats.size,
          sha256: crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'),
        });
      } else throw new Error(`provider preflight evidence contains an unsupported entry: ${relativePath}`);
    }
  };
  visit(root);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  if (entries.length === 0) throw new Error('provider preflight evidence directory is empty');
  return entries;
}

export function writeCoordinatorProviderPreflightReceipt({
  executionRoot,
  executionId,
  preflight,
  provenance,
  generatedAt = new Date(),
  workspaceRoot = repoRoot,
  validateEvidence = validateProviderPreflightRawAuthority,
  expectedAuthorization,
}) {
  const checked = assertPreflightOutcome(preflight);
  const evidenceSourceRoot = path.resolve(checked.evidenceDirectory);
  const validation = validateEvidence(evidenceSourceRoot, {
    workspaceRoot,
    implementationRoot: workspaceRoot,
    currentProvenance: provenance,
    now: generatedAt instanceof Date ? generatedAt.getTime() : Date.parse(generatedAt),
    expectedAuthorization,
  });
  if (validation?.issues?.length > 0 || !validation?.summary) {
    throw new Error(`coordinator provider preflight raw authority failed: ${(validation?.issues ?? ['missing summary']).join('; ')}`);
  }
  const evidenceTimes = validation.evidenceTimes ?? [];
  const authorizationPublishedAt = Math.max(
    Date.parse(String(expectedAuthorization?.grantGeneratedAt ?? '')),
    ...(expectedAuthorization?.reservationIssuedAts ?? []).map((value) => Date.parse(String(value))),
  );
  if (
    !Number.isFinite(authorizationPublishedAt)
    || evidenceTimes.length === 0
    || evidenceTimes.some((value) => !Number.isFinite(Date.parse(String(value))))
    || Math.min(...evidenceTimes.map((value) => Date.parse(String(value)))) <= authorizationPublishedAt
  ) throw new Error('provider preflight raw evidence did not start after signed authorization publication');
  const summary = validation.summary;
  const inputTokens = summary.inputTokens;
  const outputTokens = summary.outputTokens;
  const audioSeconds = summary.audioSeconds == null ? null : summary.audioSeconds;
  const tokenBudget = expectedAuthorization?.tokenBudget;
  if (
    summary.providerId !== checked.providerId
    || !String(summary.model ?? '').trim()
    || summary.operation !== 'text-translation-preflight'
    || summary.inputMode !== 'text-only'
    || Number(summary.externalAudioSamples) !== 0
    || Number(summary.providerInvocationCount) !== 1
    || summary.protocol !== expectedAuthorization?.protocol
    || summary.executionId !== expectedAuthorization?.executionId
    || summary.grantDigest !== expectedAuthorization?.grantDigest
    || summary.authorizationDigest !== expectedAuthorization?.authorizationDigest
    || canonicalJson(summary.consumptionClaim)
      !== canonicalJson(expectedAuthorization?.consumptionClaim)
    || canonicalJson(summary.leaseReservationDigests)
      !== canonicalJson(expectedAuthorization?.leaseReservationDigests)
    || Number(tokenBudget?.maxInputTokens) !== 4_096
    || Number(tokenBudget?.maxOutputTokens) !== 256
    || typeof inputTokens !== 'number'
    || typeof outputTokens !== 'number'
    || !Number.isSafeInteger(inputTokens)
    || inputTokens < 0
    || inputTokens > Number(tokenBudget.maxInputTokens)
    || !Number.isSafeInteger(outputTokens)
    || outputTokens < 0
    || outputTokens > Number(tokenBudget.maxOutputTokens)
    || (audioSeconds !== null && (typeof audioSeconds !== 'number' || audioSeconds !== 0))
  ) throw new Error('coordinator provider preflight summary is not one text-only zero-audio invocation');
  const evidenceRoot = path.join(
    path.resolve(executionRoot),
    ...COORDINATOR_PROVIDER_PREFLIGHT_EVIDENCE_ROOT.split('/'),
  );
  fs.mkdirSync(path.dirname(evidenceRoot), { recursive: true });
  copyPreflightTree(evidenceSourceRoot, evidenceRoot);
  const entries = preflightTreeInventory(evidenceRoot);
  const inventoryDigest = sha256Canonical(entries);
  const inventory = {
    schemaVersion: SHARD_AUTHORITY_SCHEMA_VERSION,
    artifactKind: COORDINATOR_PROVIDER_PREFLIGHT_INVENTORY_KIND,
    executionId,
    scenarioId: 'E2E-PROVIDER-PROBE',
    providerId: summary.providerId,
    model: summary.model,
    protocol: summary.protocol,
    invocationCount: summary.providerInvocationCount,
    operation: summary.operation,
    inputMode: summary.inputMode,
    externalAudioSamples: summary.externalAudioSamples,
    tokenBudget: structuredClone(tokenBudget),
    inputTokens,
    outputTokens,
    audioSeconds,
    rawEvidenceRoot: COORDINATOR_PROVIDER_PREFLIGHT_EVIDENCE_ROOT,
    entryCount: entries.length,
    entries,
    inventoryDigest,
    grantDigest: expectedAuthorization.grantDigest,
    leaseReservationDigests: structuredClone(expectedAuthorization.leaseReservationDigests),
    authorizationDigest: expectedAuthorization.authorizationDigest,
    consumptionClaim: structuredClone(expectedAuthorization.consumptionClaim),
  };
  const inventoryPath = path.join(
    path.resolve(executionRoot),
    ...COORDINATOR_PROVIDER_PREFLIGHT_INVENTORY_FILE.split('/'),
  );
  atomicWriteJson(inventoryPath, inventory);
  const evidenceAuthority = fileAuthorityEntry(
    inventoryPath,
    COORDINATOR_PROVIDER_PREFLIGHT_INVENTORY_FILE,
  );
  const receipt = {
    schemaVersion: SHARD_AUTHORITY_SCHEMA_VERSION,
    artifactKind: COORDINATOR_PROVIDER_PREFLIGHT_KIND,
    generatedAt: generatedAt instanceof Date ? generatedAt.toISOString() : String(generatedAt),
    executionId,
    invocationCount: 1,
    providerId: summary.providerId,
    model: summary.model,
    protocol: summary.protocol,
    operation: summary.operation,
    inputMode: summary.inputMode,
    status: checked.status,
    externalAudioSamples: summary.externalAudioSamples,
    tokenBudget: structuredClone(tokenBudget),
    inputTokens,
    outputTokens,
    audioSeconds,
    evidenceAuthority,
    scenarioId: 'E2E-PROVIDER-PROBE',
    rawEvidenceRoot: COORDINATOR_PROVIDER_PREFLIGHT_EVIDENCE_ROOT,
    rawEvidenceCount: entries.length,
    rawEvidenceDigest: inventoryDigest,
    grantDigest: expectedAuthorization.grantDigest,
    leaseReservationDigests: structuredClone(expectedAuthorization.leaseReservationDigests),
    authorizationDigest: expectedAuthorization.authorizationDigest,
    consumptionClaim: structuredClone(expectedAuthorization.consumptionClaim),
  };
  const receiptPath = path.join(path.resolve(executionRoot), COORDINATOR_PROVIDER_PREFLIGHT_FILE);
  atomicWriteJson(receiptPath, receipt);
  const authority = fileAuthorityEntry(receiptPath, COORDINATOR_PROVIDER_PREFLIGHT_FILE);
  return {
    receiptPath,
    receipt,
    authority: {
      ...authority,
      providerId: summary.providerId,
      model: summary.model,
      protocol: summary.protocol,
      operation: summary.operation,
      inputMode: summary.inputMode,
      status: 'completed',
      externalAudioSamples: summary.externalAudioSamples,
      tokenBudget: structuredClone(tokenBudget),
      inputTokens,
      outputTokens,
      audioSeconds,
      invocationCount: summary.providerInvocationCount,
      scenarioId: receipt.scenarioId,
      rawEvidenceRoot: receipt.rawEvidenceRoot,
      rawEvidenceCount: receipt.rawEvidenceCount,
      rawEvidenceDigest: receipt.rawEvidenceDigest,
      executionId: receipt.executionId,
      grantDigest: receipt.grantDigest,
      leaseReservationDigests: structuredClone(receipt.leaseReservationDigests),
      authorizationDigest: receipt.authorizationDigest,
      consumptionClaim: structuredClone(receipt.consumptionClaim),
      generatedAt: receipt.generatedAt,
    },
  };
}

function exactProvenance(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function strictlyLaterDate(clock, ...earlierValues) {
  const current = clock();
  const currentMs = current instanceof Date ? current.getTime() : Date.parse(String(current));
  const floor = Math.max(...earlierValues.map((value) => (
    value instanceof Date ? value.getTime() : Date.parse(String(value))
  )));
  if (!Number.isFinite(currentMs) || !Number.isFinite(floor)) {
    throw new Error('coordinator authority clock produced an invalid timestamp');
  }
  return new Date(Math.max(currentMs, floor + 1));
}

/**
 * Coordinator-only preparation seam. Callbacks deliberately separate the one
 * build, one text preflight and one local-isolation lookup/run from paid shard
 * execution; workers receive only the atomically published plan and leases.
 */
export async function prepareCoordinatorExecution({
  outputRoot,
  workspaceRoot = repoRoot,
  executionId = `watch-shard-${crypto.randomUUID()}`,
  workers,
  assignments = defaultThreeVmAssignments(workers),
  generatedAt = new Date(),
  expiresAt = new Date(generatedAt.getTime() + 86_400_000),
  now = () => new Date(),
  signingKeys = generateCoordinatorSigningKeyPair(),
  captureProvenance,
  buildRuntimeAuthority,
  captureAuthorityImplementationHashes,
  captureShardImplementationHashes,
  runProviderPreflight,
  runZeroProviderWorkerReadiness,
  obtainLocalIsolationAuthority,
  validateProviderPreflightEvidence = validateProviderPreflightRawAuthority,
  minimumRemainingExecutionMs = 0,
}) {
  if (!EXECUTION_ID_PATTERN.test(String(executionId ?? ''))) {
    throw new Error('coordinator executionId must be a portable 8-128 character identifier');
  }
  const resolvedOutputRoot = path.resolve(outputRoot);
  const finalExecutionRoot = path.join(resolvedOutputRoot, executionId);
  const reservationPath = path.join(resolvedOutputRoot, `${executionId}.reservation.json`);
  if (fs.existsSync(finalExecutionRoot) || fs.existsSync(reservationPath)) {
    throw new Error(`refusing to reuse coordinator executionId ${executionId}`);
  }
  for (const [name, callback] of Object.entries({
    captureProvenance,
    buildRuntimeAuthority,
    captureAuthorityImplementationHashes,
    captureShardImplementationHashes,
    runZeroProviderWorkerReadiness,
    runProviderPreflight,
    obtainLocalIsolationAuthority,
  })) {
    if (typeof callback !== 'function') throw new Error(`coordinator preparation requires ${name} callback`);
  }
  fs.mkdirSync(resolvedOutputRoot, { recursive: true });
  // The durable reservation is intentionally never removed, including when a
  // later build/preflight fails. A coordinator restart must use a new execution
  // authorization rather than reissue leases or repeat a preflight under the
  // same executionId.
  atomicWriteJson(reservationPath, {
    schemaVersion: SHARD_AUTHORITY_SCHEMA_VERSION,
    artifactKind: COORDINATOR_EXECUTION_RESERVATION_KIND,
    executionId,
    reservedAt: generatedAt instanceof Date ? generatedAt.toISOString() : String(generatedAt),
    retryPolicy: 'new-execution-required',
  });
  const stagingRoot = `${finalExecutionRoot}.preparing-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  fs.mkdirSync(stagingRoot, { recursive: false });
  try {
    const startProvenance = await captureProvenance();
    const coordinatorKeyId = coordinatorKeyIdForPublicKey(signingKeys.publicKeyPem);
    // Exactly one coordinator build; workers never call this callback.
    const runtimeBinaryHashes = await buildRuntimeAuthority({
      provenance: startProvenance,
      coordinatorPublicKeyPem: signingKeys.publicKeyPem,
      coordinatorKeyId,
    });
    const postBuildProvenance = await captureProvenance();
    if (!exactProvenance(startProvenance, postBuildProvenance)) {
      throw new Error('coordinator source provenance changed during the single runtime build');
    }
    const authorityImplementationHashes = await captureAuthorityImplementationHashes();
    const shardOrchestrationImplementationHashes = await captureShardImplementationHashes();
    // Every assigned worker must prove the exact clean HEAD/runtime, installed
    // driver package and assigned endpoint profiles before the one paid text
    // preflight is permitted to run.
    const workerReadiness = await runZeroProviderWorkerReadiness({
      executionId,
      executionRoot: stagingRoot,
      generatedAt,
      provenance: startProvenance,
      runtimeBinaryHashes,
      authorityImplementationHashes,
      shardOrchestrationImplementationHashes,
      workers,
      assignments,
    });
    if (
      !workerReadiness?.workerReadinessRequest
      || !workerReadiness.requestAuthority
      || !Array.isArray(workerReadiness.workers)
      || workerReadiness.workers.length !== workers.length
      || new Set(workerReadiness.workers.map((entry) => entry.workerId)).size !== workers.length
      || workerReadiness.workers.some((entry) => Number(entry.providerCalls) !== 0)
      || workers.some((worker) => !workerReadiness.workers.some((entry) => entry.workerId === worker.workerId))
    ) throw new Error('coordinator zero-provider worker readiness did not cover every assigned VM');
    validateFileAuthorityEntry(
      stagingRoot,
      workerReadiness.requestAuthority,
      'worker-readiness-request.json',
      'worker readiness request authority',
    );
    for (const readiness of workerReadiness.workers) {
      const readinessPath = validateFileAuthorityEntry(
        stagingRoot,
        readiness,
        `worker-readiness/${readiness.workerId}.json`,
        `worker ${readiness.workerId} readiness authority`,
      );
      validateWorkerZeroProviderReadinessAuthority({
        receiptPath: readinessPath,
        request: workerReadiness.workerReadinessRequest,
        workerId: readiness.workerId,
        now: now(),
        authorityPath: `worker-readiness/${readiness.workerId}.json`,
      });
    }
    // The six zero-Provider cells are a prerequisite of the paid grant and are
    // therefore resolved before authorizing even the single text-only probe.
    const localIsolationAuthority = await obtainLocalIsolationAuthority({
      executionId,
      provenance: startProvenance,
      runtimeBinaryHashes,
    });
    const assignmentWithLeases = assignments.map((assignment) => ({
      ...assignment,
      leaseId: assignment.leaseId ?? `lease-${crypto.randomUUID()}`,
    }));
    const grantGeneratedAt = strictlyLaterDate(now, generatedAt);
    const preflightGrant = createProviderPreflightGrant({
      executionId,
      generatedAt: grantGeneratedAt,
      expiresAt,
      provenance: startProvenance,
      authorityImplementationHashes,
      runtimeBinaryHashes,
      shardOrchestrationImplementationHashes,
      localIsolationAuthority,
      workerReadinessRequest: workerReadiness.workerReadinessRequest,
      workerReadinessRequestAuthority: workerReadiness.requestAuthority,
      workerReadinessAuthorities: workerReadiness.workers,
      workers,
      assignments: assignmentWithLeases,
      signingKeys,
    });
    verifyProviderPreflightGrant(preflightGrant);
    const preflightGrantPath = path.join(stagingRoot, COORDINATOR_PREFLIGHT_GRANT_FILE);
    atomicWriteJson(preflightGrantPath, preflightGrant);
    const leaseReservations = createProviderPreflightLeaseReservations({
      grant: preflightGrant,
      issuedAt: strictlyLaterDate(now, grantGeneratedAt),
      signingKeys,
    });
    verifyProviderPreflightLeaseReservations(leaseReservations, preflightGrant);
    const authorizationFinalRoot = path.join(
      resolvedOutputRoot,
      `${executionId}${COORDINATOR_PREFLIGHT_AUTHORIZATION_DIRECTORY_SUFFIX}`,
    );
    const authorizationStagingRoot = `${authorizationFinalRoot}.preparing-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    if (fs.existsSync(authorizationFinalRoot)) {
      throw new Error('provider preflight authorization package already exists');
    }
    fs.mkdirSync(authorizationStagingRoot, { recursive: false });
    fs.copyFileSync(preflightGrantPath, path.join(authorizationStagingRoot, COORDINATOR_PREFLIGHT_GRANT_FILE));
    fs.copyFileSync(
      path.join(stagingRoot, ...workerReadiness.requestAuthority.path.split('/')),
      path.join(authorizationStagingRoot, 'worker-readiness-request.json'),
    );
    const publishedReadinessRoot = path.join(authorizationStagingRoot, 'worker-readiness');
    fs.mkdirSync(publishedReadinessRoot);
    for (const readiness of workerReadiness.workers) {
      fs.copyFileSync(
        path.join(stagingRoot, ...readiness.path.split('/')),
        path.join(authorizationStagingRoot, ...readiness.path.split('/')),
      );
    }
    const reservationRoot = path.join(
      authorizationStagingRoot,
      PROVIDER_PREFLIGHT_LEASE_RESERVATION_DIRECTORY,
    );
    fs.mkdirSync(reservationRoot);
    leaseReservations.forEach((reservation, index) => atomicWriteJson(
      path.join(reservationRoot, providerPreflightReservationFileName(reservation, index)),
      reservation,
    ));
    fs.renameSync(authorizationStagingRoot, authorizationFinalRoot);
    const publishedGrantPath = path.join(authorizationFinalRoot, COORDINATOR_PREFLIGHT_GRANT_FILE);
    const publishedReservationDirectory = path.join(
      authorizationFinalRoot,
      PROVIDER_PREFLIGHT_LEASE_RESERVATION_DIRECTORY,
    );
    const authorizationPackage = loadProviderPreflightAuthorizationPackage({
      grantPath: publishedGrantPath,
      reservationDirectory: publishedReservationDirectory,
      expected: {
        executionId,
        provenance: startProvenance,
        authorityImplementationHashes,
        runtimeBinaryHashes,
        shardOrchestrationImplementationHashes,
      },
    });
    const preflightBoundaryAt = now();
    const preflightBoundaryMs = preflightBoundaryAt instanceof Date
      ? preflightBoundaryAt.getTime()
      : Date.parse(String(preflightBoundaryAt));
    const expiryMs = expiresAt instanceof Date ? expiresAt.getTime() : Date.parse(String(expiresAt));
    if (
      !Number.isSafeInteger(Number(minimumRemainingExecutionMs))
      || Number(minimumRemainingExecutionMs) < 0
      || !Number.isFinite(preflightBoundaryMs)
      || !Number.isFinite(expiryMs)
      || expiryMs - preflightBoundaryMs < Number(minimumRemainingExecutionMs)
    ) {
      throw new Error('coordinator execution validity is insufficient for every paid wave and final evidence publication');
    }
    const expectedPreflightAuthorization = {
      ...authorizationPackage.consumption,
    };
    const stagedReservationDirectory = path.join(
      stagingRoot,
      PROVIDER_PREFLIGHT_LEASE_RESERVATION_DIRECTORY,
    );
    fs.mkdirSync(stagedReservationDirectory);
    for (const entry of authorizationPackage.leaseReservationAuthorities) {
      const fileName = path.basename(entry.path);
      fs.copyFileSync(
        path.join(publishedReservationDirectory, fileName),
        path.join(stagedReservationDirectory, fileName),
        fs.constants.COPYFILE_EXCL,
      );
    }
    // Exactly one coordinator text preflight. It must never be delegated to a shard.
    const preflightOutcome = await runProviderPreflight({
      executionId,
      provenance: startProvenance,
      runtimeBinaryHashes,
      grant: preflightGrant,
      grantPath: publishedGrantPath,
      leaseReservationDirectory: publishedReservationDirectory,
      authorization: expectedPreflightAuthorization,
      authorizationDigest: authorizationPackage.authorizationDigest,
    });
    const consumptionClaim = validateProviderPreflightConsumptionClaim({
      authorizationRoot: authorizationFinalRoot,
      grant: preflightGrant,
      leaseReservations,
      workspaceRoot,
    });
    const expectedConsumedPreflightAuthorization = {
      ...expectedPreflightAuthorization,
      consumptionClaim: consumptionClaim.projection,
    };
    fs.copyFileSync(
      path.join(authorizationFinalRoot, PROVIDER_PREFLIGHT_CONSUMPTION_CLAIM_FILE),
      path.join(stagingRoot, PROVIDER_PREFLIGHT_CONSUMPTION_CLAIM_FILE),
      fs.constants.COPYFILE_EXCL,
    );
    const preflightReceiptGeneratedAt = strictlyLaterDate(
      now,
      leaseReservations[0].issuedAt,
    );
    const preflightReceipt = writeCoordinatorProviderPreflightReceipt({
      executionRoot: stagingRoot,
      executionId,
      preflight: preflightOutcome,
      provenance: startProvenance,
      generatedAt: preflightReceiptGeneratedAt,
      workspaceRoot,
      validateEvidence: validateProviderPreflightEvidence,
      expectedAuthorization: expectedConsumedPreflightAuthorization,
    });
    const completionGeneratedAt = strictlyLaterDate(now, preflightReceiptGeneratedAt);
    const preflightCompletion = createProviderPreflightCompletion({
      grant: preflightGrant,
      leaseReservations,
      preflightAuthority: preflightReceipt.authority,
      generatedAt: completionGeneratedAt,
      signingKeys,
    });
    verifyProviderPreflightCompletion(preflightCompletion, preflightGrant, leaseReservations);
    const preflightCompletionPath = path.join(stagingRoot, COORDINATOR_PREFLIGHT_COMPLETION_FILE);
    atomicWriteJson(preflightCompletionPath, preflightCompletion);
    const beforePublishProvenance = await captureProvenance();
    if (!exactProvenance(startProvenance, beforePublishProvenance)) {
      throw new Error('coordinator source provenance changed before atomic execution publication');
    }
    const planGeneratedAt = strictlyLaterDate(now, completionGeneratedAt);
    if (planGeneratedAt.getTime() >= (expiresAt instanceof Date ? expiresAt.getTime() : Date.parse(String(expiresAt)))) {
      throw new Error('provider preflight completed after the signed execution expiry');
    }
    const leaseReservationAuthorities = authorizationPackage.leaseReservationAuthorities.map((entry) => ({
      ...entry,
      path: `${PROVIDER_PREFLIGHT_LEASE_RESERVATION_DIRECTORY}/${path.basename(entry.path)}`,
    }));
    const plan = createSignedExecutionPlan({
      executionId,
      generatedAt: planGeneratedAt,
      expiresAt,
      provenance: beforePublishProvenance,
      authorityImplementationHashes,
      runtimeBinaryHashes,
      shardOrchestrationImplementationHashes,
      localIsolationAuthority,
      providerPreflightAuthority: preflightReceipt.authority,
      providerPreflightGrant: {
        ...fileAuthorityEntry(preflightGrantPath, COORDINATOR_PREFLIGHT_GRANT_FILE),
        digest: preflightGrant.digest,
      },
      providerPreflightLeaseReservations: leaseReservationAuthorities,
      providerPreflightAuthorization: {
        grantDigest: preflightGrant.digest,
        leaseReservationDigests: leaseReservations.map((reservation) => reservation.digest),
        authorizationDigest: authorizationPackage.authorizationDigest,
        tokenBudget: structuredClone(expectedConsumedPreflightAuthorization.tokenBudget),
        consumptionClaim: consumptionClaim.projection,
      },
      providerPreflightCompletion: {
        ...fileAuthorityEntry(preflightCompletionPath, COORDINATOR_PREFLIGHT_COMPLETION_FILE),
        digest: preflightCompletion.digest,
        grantDigest: preflightGrant.digest,
        authorizationDigest: authorizationPackage.authorizationDigest,
        tokenBudget: structuredClone(preflightReceipt.authority.tokenBudget),
        inputTokens: preflightReceipt.authority.inputTokens,
        outputTokens: preflightReceipt.authority.outputTokens,
        audioSeconds: preflightReceipt.authority.audioSeconds,
        consumptionClaim: consumptionClaim.projection,
      },
      workerReadinessRequest: workerReadiness.workerReadinessRequest,
      workers,
      assignments: assignmentWithLeases,
      ...signingKeys,
    });
    const leases = issueCellLeases(plan, signingKeys.privateKeyPem, { issuedAt: planGeneratedAt });
    if (
      leases.length !== SHARD_MATRIX_CELL_COUNT
      || new Set(leases.map((lease) => lease.leaseId)).size !== SHARD_MATRIX_CELL_COUNT
      || leases.some((lease) => Number(lease.maxExternalAudioSamples) !== SHARD_CELL_MAX_EXTERNAL_AUDIO_SAMPLES)
      || leases.reduce((sum, lease) => sum + Number(lease.maxExternalAudioSamples), 0) !== SHARD_MATRIX_MAX_EXTERNAL_AUDIO_SAMPLES
    ) throw new Error('coordinator did not allocate the exact eight disjoint paid-cell leases');
    const planPath = path.join(stagingRoot, SHARD_EXECUTION_PLAN_FILE);
    atomicWriteJson(planPath, plan);
    const leaseDirectory = path.join(stagingRoot, 'leases');
    const leasePaths = leases.map((lease) => {
      const leasePath = path.join(
        leaseDirectory,
        `${String(lease.cellIndex + 1).padStart(2, '0')}-${safeCellId(lease.cellId)}.json`,
      );
      atomicWriteJson(leasePath, lease);
      return leasePath;
    });
    // Publishing the directory last makes plan + all eight leases visible as
    // one immutable allocation. A crash cannot expose a partial grant set.
    fs.renameSync(stagingRoot, finalExecutionRoot);
    const finalPlanPath = path.join(finalExecutionRoot, SHARD_EXECUTION_PLAN_FILE);
    const finalLeasePaths = leasePaths.map((leasePath) => path.join(finalExecutionRoot, path.relative(stagingRoot, leasePath)));
    return {
      executionRoot: finalExecutionRoot,
      planPath: finalPlanPath,
      plan,
      leases,
      leasePaths: finalLeasePaths,
      providerPreflightReceiptPath: path.join(finalExecutionRoot, COORDINATOR_PROVIDER_PREFLIGHT_FILE),
      providerPreflightGrantPath: path.join(finalExecutionRoot, COORDINATOR_PREFLIGHT_GRANT_FILE),
      providerPreflightCompletionPath: path.join(finalExecutionRoot, COORDINATOR_PREFLIGHT_COMPLETION_FILE),
      providerPreflightLeaseReservationPaths: leaseReservationAuthorities.map((entry) => (
        path.join(finalExecutionRoot, ...entry.path.split('/'))
      )),
      providerPreflightAuthorization: authorizationPackage.consumption,
      providerPreflightAuthorizationRoot: authorizationFinalRoot,
      reservationPath,
      // The private key remains an in-memory coordinator capability. It is not
      // written beneath executionRoot and must not be copied to a worker.
      signingKeys,
    };
  } catch (error) {
    if (fs.existsSync(stagingRoot)) fs.rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

export class CoordinatorWaveFailure extends Error {
  constructor({ waveIndex, cellId, cause, startedCellIds, completedCellIds, partialResults }) {
    super(`strict paid shard wave ${waveIndex} failed at ${cellId}: ${cause?.message ?? cause}`);
    this.name = 'CoordinatorWaveFailure';
    this.waveIndex = waveIndex;
    this.cellId = cellId;
    this.cause = cause;
    this.startedCellIds = startedCellIds;
    this.completedCellIds = completedCellIds;
    this.partialResults = partialResults;
  }
}

function assertExactLeaseSet(plan, leases, now) {
  if (!Array.isArray(leases) || leases.length !== SHARD_MATRIX_CELL_COUNT) {
    throw new Error(`coordinator requires exactly ${SHARD_MATRIX_CELL_COUNT} signed leases`);
  }
  const byId = new Map();
  for (const lease of leases) {
    const cell = verifyCellLease(lease, plan, { now });
    if (byId.has(lease.leaseId)) throw new Error(`coordinator received duplicate lease ${lease.leaseId}`);
    byId.set(lease.leaseId, { lease, cell });
  }
  if (plan.cells.some((cell) => !byId.has(cell.leaseId))) throw new Error('coordinator lease set is incomplete');
  const reserved = [...byId.values()].reduce((sum, entry) => sum + Number(entry.lease.maxExternalAudioSamples), 0);
  if (reserved !== SHARD_MATRIX_MAX_EXTERNAL_AUDIO_SAMPLES) throw new Error('coordinator lease set is not the exact 1440-second allocation');
  return byId;
}

export function claimCoordinatorCellDispatch({ executionRoot, plan, lease, cell, claimedAt = new Date() }) {
  const { root } = assertCoordinatorExecutionRoot({ executionRoot, plan });
  verifyCellLease(lease, plan, { now: claimedAt });
  if (lease.cellId !== cell.cellId || lease.leaseId !== cell.leaseId) {
    throw new Error('coordinator dispatch claim cell/lease mismatch');
  }
  const claimPath = path.join(root, 'dispatch-claims', `${lease.leaseId}.json`);
  const claim = {
    schemaVersion: SHARD_AUTHORITY_SCHEMA_VERSION,
    artifactKind: COORDINATOR_DISPATCH_CLAIM_KIND,
    claimedAt: claimedAt instanceof Date ? claimedAt.toISOString() : String(claimedAt),
    executionId: plan.executionId,
    planDigest: plan.planDigest,
    cellIndex: cell.cellIndex,
    cellId: cell.cellId,
    workerId: cell.workerId,
    waveIndex: cell.waveIndex,
    leaseId: lease.leaseId,
    leaseDigest: lease.leaseDigest,
    retryPolicy: 'new-execution-required',
  };
  atomicWriteJson(claimPath, claim);
  return { claimPath, claim };
}

function resultDigestFromOutcome(outcome) {
  return outcome?.result?.resultDigest ?? outcome?.resultDigest ?? null;
}

export function completeCoordinatorWave({
  executionRoot,
  plan,
  wave,
  results,
  completedAt = new Date(),
}) {
  const { root } = assertCoordinatorExecutionRoot({ executionRoot, plan });
  const cells = wave.cellIds.map((cellId) => {
    const cell = plan.cells.find((candidate) => candidate.cellId === cellId);
    const resultDigest = resultDigestFromOutcome(results.get(cellId));
    if (!cell || !/^[a-f0-9]{64}$/i.test(String(resultDigest ?? ''))) {
      throw new Error(`coordinator wave ${wave.waveIndex} lacks a verified result digest for ${cellId}`);
    }
    return { cellIndex: cell.cellIndex, cellId, leaseId: cell.leaseId, resultDigest };
  });
  const core = {
    schemaVersion: SHARD_AUTHORITY_SCHEMA_VERSION,
    artifactKind: COORDINATOR_WAVE_COMPLETION_KIND,
    completedAt: completedAt instanceof Date ? completedAt.toISOString() : String(completedAt),
    executionId: plan.executionId,
    planDigest: plan.planDigest,
    waveIndex: wave.waveIndex,
    cells,
  };
  const receipt = { ...core, receiptDigest: sha256Canonical(core) };
  const receiptPath = path.join(root, 'wave-completions', `wave-${wave.waveIndex}.json`);
  atomicWriteJson(receiptPath, receipt);
  return { receiptPath, receipt };
}

/**
 * Runs one cell per worker in bounded waves. The classifier may retain an
 * identity-bound ordinary failed result and continue later waves. Safety
 * failures abort/cancel peers immediately. Already-started peer audio remains
 * chargeable; no retry is attempted within this execution.
 */
export async function runCoordinatorWaves({
  plan,
  leases,
  executionRoot,
  assertWorkerReady = async () => {},
  dispatchCell,
  cancelCell = async () => {},
  validateCompletedCell = async ({ outcome }) => {
    if (outcome?.result?.verdict !== 'passed') throw new Error('worker did not return a passed shard result');
    return outcome;
  },
  onWaveCompleted = async () => {},
  classifyFailure = () => 'stop',
  now = () => new Date(),
}) {
  if (typeof dispatchCell !== 'function') throw new Error('coordinator requires a dispatchCell adapter');
  if (!String(executionRoot ?? '').trim()) throw new Error('coordinator requires a durable executionRoot for dispatch claims');
  assertCoordinatorExecutionRoot({ executionRoot, plan });
  verifySignedExecutionPlan(plan, { now: now() });
  const leaseById = assertExactLeaseSet(plan, leases, now());
  // All readiness checks are zero-Provider and finish before the first paid wave.
  const readiness = await Promise.allSettled(plan.workers.map((worker) => assertWorkerReady({ plan, worker })));
  const readinessFailure = readiness.find((entry) => entry.status === 'rejected');
  if (readinessFailure) throw new Error(`worker readiness failed before paid dispatch: ${readinessFailure.reason?.message ?? readinessFailure.reason}`);

  const started = new Set();
  const completed = new Set();
  const results = new Map();
  const waveCompletions = [];
  const collectedFailures = [];
  for (const wave of plan.waves) {
    const waveCells = wave.cellIds.map((cellId) => plan.cells.find((cell) => cell.cellId === cellId));
    let firstFailure = null;
    const controllers = new Map(waveCells.map((cell) => [cell.cellId, new AbortController()]));
    const cancellationPromises = [];
    const failWave = (cell, error) => {
      if (firstFailure) return;
      firstFailure = { cell, error };
      for (const peer of waveCells) {
        if (peer.cellId === cell.cellId || completed.has(peer.cellId)) continue;
        controllers.get(peer.cellId).abort(error);
        cancellationPromises.push(Promise.resolve(cancelCell({
          plan,
          waveIndex: wave.waveIndex,
          cell: peer,
          lease: leaseById.get(peer.leaseId).lease,
          reason: error,
        })));
      }
    };
    const tasks = waveCells.map(async (cell) => {
      if (started.has(cell.cellId)) throw new Error(`coordinator attempted to redispatch ${cell.cellId}`);
      const lease = leaseById.get(cell.leaseId).lease;
      try {
        claimCoordinatorCellDispatch({ executionRoot, plan, lease, cell, claimedAt: now() });
        started.add(cell.cellId);
        const outcome = await dispatchCell({
          plan,
          waveIndex: wave.waveIndex,
          cell,
          lease,
          signal: controllers.get(cell.cellId).signal,
        });
        let validated;
        try {
          validated = await validateCompletedCell({ plan, cell, lease, outcome });
        } catch (error) {
          if (
            classifyFailure({ plan, cell, lease, outcome, error }) === 'collect'
            && /^[a-f0-9]{64}$/iu.test(String(outcome?.result?.resultDigest ?? ''))
          ) {
            completed.add(cell.cellId);
            results.set(cell.cellId, outcome);
            collectedFailures.push({
              cellId: cell.cellId,
              cellIndex: cell.cellIndex,
              waveIndex: wave.waveIndex,
              error: error.message,
              outcome,
            });
            return outcome;
          }
          throw error;
        }
        if (firstFailure) throw new Error(`peer ${firstFailure.cell.cellId} already failed in this wave`);
        completed.add(cell.cellId);
        results.set(cell.cellId, validated);
        return validated;
      } catch (error) {
        failWave(cell, error);
        throw error;
      }
    });
    const settled = await Promise.allSettled(tasks);
    await Promise.allSettled(cancellationPromises);
    if (firstFailure || settled.some((entry) => entry.status === 'rejected')) {
      const failedIndex = settled.findIndex((entry) => entry.status === 'rejected');
      const failure = firstFailure ?? {
        cell: waveCells[failedIndex],
        error: settled[failedIndex].reason,
      };
      throw new CoordinatorWaveFailure({
        waveIndex: wave.waveIndex,
        cellId: failure.cell.cellId,
        cause: failure.error,
        startedCellIds: [...started],
        completedCellIds: [...completed],
        partialResults: new Map(results),
      });
    }
    waveCompletions.push(completeCoordinatorWave({
      executionRoot,
      plan,
      wave,
      results,
      completedAt: now(),
    }));
    await onWaveCompleted({
      plan,
      waveIndex: wave.waveIndex,
      cellIds: [...wave.cellIds],
      results: new Map(wave.cellIds.map((cellId) => [cellId, results.get(cellId)])),
    });
  }
  if (completed.size !== SHARD_MATRIX_CELL_COUNT) throw new Error('coordinator completed an incomplete paid matrix');
  return {
    results,
    waveCompletions,
    collectedFailures,
    startedCellIds: [...started],
    completedCellIds: [...completed],
  };
}

export function validateCoordinatorExecutionAuthority({
  executionRoot,
  plan,
  leases,
  resultByCell = null,
}) {
  const { root } = assertCoordinatorExecutionRoot({ executionRoot, plan });
  const leaseById = new Map(leases.map((lease) => [lease.leaseId, lease]));
  const claimDirectory = path.join(root, 'dispatch-claims');
  const claimFiles = fs.readdirSync(claimDirectory).filter((entry) => entry.endsWith('.json')).sort();
  if (claimFiles.length !== SHARD_MATRIX_CELL_COUNT) {
    throw new Error(`coordinator execution authority requires exactly ${SHARD_MATRIX_CELL_COUNT} dispatch claims`);
  }
  const claims = new Map();
  const claimAuthorities = [];
  for (const cell of plan.cells) {
    const claimPath = path.join(claimDirectory, `${cell.leaseId}.json`);
    const claim = readJson(claimPath, `coordinator dispatch claim ${cell.cellId}`);
    const lease = leaseById.get(cell.leaseId);
    if (
      !lease
      || claim.schemaVersion !== SHARD_AUTHORITY_SCHEMA_VERSION
      || claim.artifactKind !== COORDINATOR_DISPATCH_CLAIM_KIND
      || claim.executionId !== plan.executionId
      || claim.planDigest !== plan.planDigest
      || claim.cellIndex !== cell.cellIndex
      || claim.cellId !== cell.cellId
      || claim.workerId !== cell.workerId
      || claim.waveIndex !== cell.waveIndex
      || claim.leaseId !== lease.leaseId
      || claim.leaseDigest !== lease.leaseDigest
      || claim.retryPolicy !== 'new-execution-required'
      || !Number.isFinite(Date.parse(claim.claimedAt))
    ) throw new Error(`coordinator dispatch claim does not match ${cell.cellId}`);
    claims.set(cell.cellId, claim);
    claimAuthorities.push({
      cellId: cell.cellId,
      ...fileAuthorityEntry(claimPath, `dispatch-claims/${cell.leaseId}.json`),
    });
  }
  const completionDirectory = path.join(root, 'wave-completions');
  const completionFiles = fs.readdirSync(completionDirectory).filter((entry) => entry.endsWith('.json')).sort();
  if (completionFiles.length !== plan.waves.length) {
    throw new Error(`coordinator execution authority requires exactly ${plan.waves.length} wave completions`);
  }
  const waveAuthorities = [];
  let priorCompletedAt = Date.parse(plan.generatedAt);
  for (const wave of plan.waves) {
    const receiptPath = path.join(completionDirectory, `wave-${wave.waveIndex}.json`);
    const receipt = readJson(receiptPath, `coordinator wave ${wave.waveIndex} completion`);
    const { receiptDigest, ...core } = receipt;
    const completedAt = Date.parse(receipt.completedAt);
    if (
      receipt.schemaVersion !== SHARD_AUTHORITY_SCHEMA_VERSION
      || receipt.artifactKind !== COORDINATOR_WAVE_COMPLETION_KIND
      || receipt.executionId !== plan.executionId
      || receipt.planDigest !== plan.planDigest
      || receipt.waveIndex !== wave.waveIndex
      || receiptDigest !== sha256Canonical(core)
      || !Number.isFinite(completedAt)
      || completedAt < priorCompletedAt
    ) throw new Error(`coordinator wave ${wave.waveIndex} completion authority is invalid`);
    const expectedCells = wave.cellIds.map((cellId) => {
      const cell = plan.cells.find((candidate) => candidate.cellId === cellId);
      const boundResult = resultByCell?.get(cellId);
      return {
        cellIndex: cell.cellIndex,
        cellId,
        leaseId: cell.leaseId,
        resultDigest: boundResult?.result?.resultDigest
          ?? resultDigestFromOutcome(boundResult)
          ?? receipt.cells?.find((entry) => entry.cellId === cellId)?.resultDigest,
      };
    });
    if (canonicalJson(receipt.cells) !== canonicalJson(expectedCells)) {
      throw new Error(`coordinator wave ${wave.waveIndex} result bindings do not match canonical cells`);
    }
    for (const cellId of wave.cellIds) {
      if (Date.parse(claims.get(cellId).claimedAt) > completedAt) {
        throw new Error(`coordinator wave ${wave.waveIndex} completed before cell ${cellId} was dispatched`);
      }
    }
    const nextWave = plan.waves[wave.waveIndex + 1];
    if (nextWave) {
      for (const nextCellId of nextWave.cellIds) {
        if (Date.parse(claims.get(nextCellId).claimedAt) < completedAt) {
          throw new Error(`coordinator dispatched wave ${nextWave.waveIndex} before wave ${wave.waveIndex} completed`);
        }
      }
    }
    priorCompletedAt = completedAt;
    waveAuthorities.push({
      waveIndex: wave.waveIndex,
      ...fileAuthorityEntry(receiptPath, `wave-completions/wave-${wave.waveIndex}.json`),
      receiptDigest,
    });
  }
  return { claimAuthorities, waveAuthorities };
}

function aggregateCore(aggregate) {
  const { aggregateDigest, ...core } = aggregate;
  return core;
}

export function collectCoordinatorAggregation({
  plan,
  leases,
  shards,
  executionRoot,
  generatedAt = new Date(),
  validateShard = validateShardManifest,
}) {
  verifySignedExecutionPlan(plan, { now: generatedAt });
  const leaseById = assertExactLeaseSet(plan, leases, generatedAt);
  if (!Array.isArray(shards) || shards.length !== plan.workers.length) {
    throw new Error(`coordinator aggregation requires exactly ${plan.workers.length} shard manifests`);
  }
  const workersSeen = new Set();
  const resultByCell = new Map();
  const shardAuthorities = [];
  for (const shard of shards) {
    const validated = validateShard({
      manifestPath: path.resolve(shard.manifestPath),
      shardRoot: path.resolve(shard.shardRoot),
      plan,
      leases,
      now: generatedAt,
    });
    const workerId = validated.manifest.workerId;
    if (workersSeen.has(workerId)) throw new Error(`coordinator aggregation has duplicate shard worker ${workerId}`);
    workersSeen.add(workerId);
    shardAuthorities.push({
      workerId,
      vmIdentityDigest: validated.worker.vmIdentityDigest,
      manifest: fileAuthorityEntry(
        path.resolve(shard.manifestPath),
        path.basename(shard.manifestPath),
      ),
      manifestDigest: validated.manifest.manifestDigest,
    });
    for (const result of validated.validatedResults) {
      if (resultByCell.has(result.cell.cellId)) throw new Error(`coordinator aggregation has duplicate cell ${result.cell.cellId}`);
      resultByCell.set(result.cell.cellId, {
        ...result,
        shardRoot: path.resolve(shard.shardRoot),
        shardManifestDigest: validated.manifest.manifestDigest,
      });
    }
  }
  if (workersSeen.size !== plan.workers.length || plan.workers.some((worker) => !workersSeen.has(worker.workerId))) {
    throw new Error('coordinator aggregation is missing an assigned worker shard');
  }
  const canonicalCells = plan.cells.map((cell) => {
    const binding = resultByCell.get(cell.cellId);
    if (!binding) throw new Error(`coordinator aggregation is missing cell ${cell.cellId}`);
    const lease = leaseById.get(cell.leaseId).lease;
    if (
      binding.result.leaseId !== lease.leaseId
      || binding.result.leaseDigest !== lease.leaseDigest
      || binding.cell.cellIndex !== cell.cellIndex
      || binding.result.worker.workerId !== cell.workerId
    ) throw new Error(`coordinator aggregation cell/lease binding mismatch for ${cell.cellId}`);
    return {
      cellIndex: cell.cellIndex,
      cellId: cell.cellId,
      tier: cell.tier,
      providerMode: cell.providerMode,
      durationSeconds: cell.durationSeconds,
      modelId: cell.modelId,
      feedbackLoopPrevention: cell.feedbackLoopPrevention,
      deviceClass: cell.deviceClass,
      deviceProfileId: cell.deviceProfileInstance.profileId,
      workerId: cell.workerId,
      vmIdentityDigest: cell.vmIdentityDigest,
      waveIndex: cell.waveIndex,
      leaseId: lease.leaseId,
      leaseDigest: lease.leaseDigest,
      shardManifestDigest: binding.shardManifestDigest,
      resultDigest: binding.result.resultDigest,
      verdict: binding.result.verdict,
      ...(binding.result.verdict === 'failed' ? {
        failureLayer: binding.result.failureLayer,
        stableErrorCode: binding.result.stableErrorCode,
        lifecyclePhase: binding.result.lifecyclePhase,
      } : {}),
      runDirectory: binding.result.runDirectory,
      actualExternalAudioSamples: binding.result.usageAuthority.actualExternalAudioSamples,
      usageAuthority: binding.result.usageAuthority,
      deviceAuthority: binding.result.deviceAuthority,
      // This absolute path is an in-memory integration value only. The later
      // matrix adapter must stage/copy it beneath one coordinator evidence root.
      sourceRunDirectory: binding.runDirectory,
    };
  });
  if (new Set(canonicalCells.map((cell) => cell.leaseId)).size !== SHARD_MATRIX_CELL_COUNT) {
    throw new Error('coordinator aggregation reuses a cell lease');
  }
  const actualExternalAudioSamples = canonicalCells.reduce(
    (sum, cell) => sum + Number(cell.actualExternalAudioSamples),
    0,
  );
  if (actualExternalAudioSamples <= 0 || actualExternalAudioSamples > SHARD_MATRIX_MAX_EXTERNAL_AUDIO_SAMPLES) {
    throw new Error('coordinator aggregate external audio usage is outside the approved 1440-second budget');
  }
  const executionAuthority = validateCoordinatorExecutionAuthority({
    executionRoot,
    plan,
    leases,
    resultByCell,
  });
  const serializableCells = canonicalCells.map(({ sourceRunDirectory, ...cell }) => cell);
  const core = {
    schemaVersion: SHARD_AUTHORITY_SCHEMA_VERSION,
    artifactKind: COORDINATOR_AGGREGATE_KIND,
    generatedAt: generatedAt instanceof Date ? generatedAt.toISOString() : String(generatedAt),
    verdict: canonicalCells.every((cell) => cell.verdict === 'passed') ? 'passed' : 'failed',
    executionId: plan.executionId,
    planDigest: plan.planDigest,
    provenance: structuredClone(plan.provenance),
    authority: structuredClone(plan.authority),
    localIsolationAuthority: structuredClone(plan.localIsolationAuthority),
    providerPreflightAuthority: structuredClone(plan.providerPreflightAuthority),
    executionAuthority,
    budget: {
      allocationMode: 'immutable-disjoint-cell-leases',
      reservedExternalAudioSamples: SHARD_MATRIX_MAX_EXTERNAL_AUDIO_SAMPLES,
      actualExternalAudioSamples,
      maxExternalAudioSeconds: SHARD_MATRIX_MAX_EXTERNAL_AUDIO_SECONDS,
      cellLeaseCount: SHARD_MATRIX_CELL_COUNT,
      auxiliaryExternalAudioSamples: 0,
      preflightExternalAudioSamples: 0,
    },
    shards: shardAuthorities.sort((left, right) => left.workerId.localeCompare(right.workerId)),
    cells: serializableCells,
  };
  const aggregate = { ...core, aggregateDigest: sha256Canonical(core) };
  return {
    aggregate,
    canonicalCells,
    matrixIntegration: {
      provenance: plan.provenance,
      authorityImplementationHashes: plan.authority.implementationHashes,
      authorityRuntimeBinaryHashes: plan.authority.runtimeBinaryHashes,
      shardOrchestrationImplementationHashes: plan.authority.shardOrchestrationImplementationHashes,
      localIsolationAuthority: plan.localIsolationAuthority,
      providerPreflightAuthority: plan.providerPreflightAuthority,
      releaseCells: LIVE_LLM_CELLS,
      cells: canonicalCells,
      externalProviderBudget: aggregate.budget,
    },
  };
}

export function writeCoordinatorAggregate({ outputRoot, ...options }) {
  const collected = collectCoordinatorAggregation(options);
  const aggregatePath = path.join(path.resolve(outputRoot), COORDINATOR_AGGREGATE_FILE);
  atomicWriteJson(aggregatePath, collected.aggregate);
  return { ...collected, aggregatePath };
}

export function validateCoordinatorAggregate(aggregate) {
  if (
    aggregate?.schemaVersion !== SHARD_AUTHORITY_SCHEMA_VERSION
    || aggregate?.artifactKind !== COORDINATOR_AGGREGATE_KIND
    || !['passed', 'failed'].includes(aggregate?.verdict)
    || aggregate?.aggregateDigest !== sha256Canonical(aggregateCore(aggregate))
    || !Array.isArray(aggregate.cells)
    || aggregate.cells.length !== SHARD_MATRIX_CELL_COUNT
    || new Set(aggregate.cells.map((cell) => cell.cellId)).size !== SHARD_MATRIX_CELL_COUNT
    || new Set(aggregate.cells.map((cell) => cell.leaseId)).size !== SHARD_MATRIX_CELL_COUNT
    || Number(aggregate.budget?.reservedExternalAudioSamples) !== SHARD_MATRIX_MAX_EXTERNAL_AUDIO_SAMPLES
    || Number(aggregate.budget?.actualExternalAudioSamples) > SHARD_MATRIX_MAX_EXTERNAL_AUDIO_SAMPLES
    || Number(aggregate.budget?.preflightExternalAudioSamples) !== 0
  ) throw new Error('coordinator aggregate is invalid or exceeds the fixed authority budget');
  const expectedIds = LIVE_LLM_CELLS.map((cell) => cell.cellId);
  if (canonicalJson(aggregate.cells.map((cell) => cell.cellId)) !== canonicalJson(expectedIds)) {
    throw new Error('coordinator aggregate cells are not in canonical paid-plan order');
  }
  const expectedVerdict = aggregate.cells.every((cell) => cell.verdict === 'passed') ? 'passed' : 'failed';
  if (aggregate.verdict !== expectedVerdict) throw new Error('coordinator aggregate verdict does not match cell verdicts');
  return aggregate;
}

export function parseCoordinatorCliArgs(argv) {
  return parseCliArgs(argv, {
    defaults: {
      plan: '',
      leases: '',
      shards: '',
      outputRoot: '',
    },
  });
}

if (isMain(import.meta.url)) {
  try {
    const options = parseCoordinatorCliArgs(process.argv.slice(2));
    for (const key of ['plan', 'leases', 'shards', 'outputRoot']) {
      if (!String(options[key] ?? '').trim()) throw new Error(`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`);
    }
    const readJson = (filePath) => JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8').replace(/^\uFEFF/, ''));
    const plan = readJson(options.plan);
    const leases = readJson(options.leases);
    const shards = readJson(options.shards);
    const result = writeCoordinatorAggregate({
      outputRoot: options.outputRoot,
      plan,
      leases,
      shards,
    });
    console.log(result.aggregatePath);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
