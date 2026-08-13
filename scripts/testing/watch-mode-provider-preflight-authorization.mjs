import fs from 'node:fs';
import path from 'node:path';

import { LIVE_LLM_CELLS, RELEASE_MODELS } from './watch-mode-balanced-release-plan.mjs';
import {
  SHARD_ALLOWED_WORKER_COUNTS,
  SHARD_AUTHORITY_SCHEMA_VERSION,
  SHARD_CELL_MAX_EXTERNAL_AUDIO_SAMPLES,
  SHARD_MATRIX_CELL_COUNT,
  SHARD_MATRIX_MAX_EXTERNAL_AUDIO_SAMPLES,
  assertAuthorityInventory,
  authorityInventoryDigest,
  canonicalJson,
  fileAuthorityEntry,
  sameAuthorityInventory,
  sha256Canonical,
  signCoordinatorAuthority,
  validateFileAuthorityEntry,
  validateWorkerReadinessRequest,
  verifyCoordinatorAuthority,
} from './watch-mode-shard-authority.mjs';

export const PROVIDER_PREFLIGHT_GRANT_KIND = 'watch-mode-provider-preflight-grant';
export const PROVIDER_PREFLIGHT_GRANT_FILE = 'provider-preflight-grant.json';
export const PROVIDER_PREFLIGHT_LEASE_RESERVATION_KIND =
  'watch-mode-provider-preflight-lease-reservation';
export const PROVIDER_PREFLIGHT_LEASE_RESERVATION_DIRECTORY =
  'provider-preflight-lease-reservations';
export const PROVIDER_PREFLIGHT_COMPLETION_KIND = 'watch-mode-provider-preflight-completion';
export const PROVIDER_PREFLIGHT_COMPLETION_FILE = 'provider-preflight-completion.json';
export const PROVIDER_PREFLIGHT_AUTHORIZATION_SET_KIND =
  'watch-mode-provider-preflight-authorization-set';
export const PROVIDER_PREFLIGHT_CONSUMPTION_KIND =
  'watch-mode-provider-preflight-authorization-consumption';
export const PROVIDER_PREFLIGHT_CONSUMPTION_CLAIM_KIND =
  'watch-mode-provider-preflight-consumption-claim';
export const PROVIDER_PREFLIGHT_CONSUMPTION_CLAIM_FILE =
  'provider-preflight-consumption-claim.json';
export const PROVIDER_PREFLIGHT_DESKTOP_EXECUTABLE =
  'target/release/omni-desktop-shell.exe';

export const PROVIDER_PREFLIGHT_GRANT_PATH_ENV =
  'OMNI_RELEASE_EVIDENCE_PREFLIGHT_GRANT_PATH';
export const PROVIDER_PREFLIGHT_RESERVATION_DIRECTORY_ENV =
  'OMNI_RELEASE_EVIDENCE_PREFLIGHT_RESERVATION_DIRECTORY';
export const PROVIDER_PREFLIGHT_AUTHORIZATION_DIGEST_ENV =
  'OMNI_RELEASE_EVIDENCE_PREFLIGHT_AUTHORIZATION_DIGEST';

export const PROVIDER_PREFLIGHT_PROVIDER_ID = 'provider-dashscope';
export const PROVIDER_PREFLIGHT_MODEL = RELEASE_MODELS[0];
export const PROVIDER_PREFLIGHT_PROTOCOL = 'dashscope-omni';
export const PROVIDER_PREFLIGHT_OPERATION = 'text-translation-preflight';
export const PROVIDER_PREFLIGHT_INPUT_MODE = 'text-only';
export const PROVIDER_PREFLIGHT_INVOCATION_COUNT = 1;
export const PROVIDER_PREFLIGHT_EXTERNAL_AUDIO_SAMPLES = 0;
export const PROVIDER_PREFLIGHT_SYSTEM_PROMPT_TEMPLATE = 'game-live-translation-cn';
export const PROVIDER_PREFLIGHT_RESPONSE_MODALITIES = Object.freeze(['text']);
export const PROVIDER_PREFLIGHT_CUSTOM_HEADERS = Object.freeze([]);
export const PROVIDER_PREFLIGHT_TIMEOUT_MS = 12_000;
export const PROVIDER_PREFLIGHT_TEMPERATURE = 0.2;
export const PROVIDER_PREFLIGHT_MAX_INPUT_TOKENS = 4_096;
export const PROVIDER_PREFLIGHT_MAX_OUTPUT_TOKENS = 256;

const SHA256 = /^[a-f0-9]{64}$/;
const EXECUTION_ID = /^[a-z0-9][a-z0-9._-]{7,127}$/i;

const safeCellId = (cellId) => String(cellId)
  .replace(/[^a-z0-9._-]+/gi, '-')
  .replace(/^-+|-+$/g, '');

export const providerPreflightReservationFileName = (cell, cellIndex = cell.cellIndex) => (
  `${String(Number(cellIndex) + 1).padStart(2, '0')}-${safeCellId(cell.cellId)}.json`
);

const protocolForModel = (modelId) => (
  modelId === 'qwen3.5-livetranslate-flash-realtime'
    ? 'dashscope-livetranslate'
    : 'dashscope-omni'
);

function isoMs(value, label) {
  const timestamp = Date.parse(String(value ?? ''));
  if (!Number.isFinite(timestamp)) throw new Error(`${label} must be an ISO timestamp`);
  return timestamp;
}

function assertFileAuthority(value, expectedPath, label) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || value.path !== expectedPath
    || !Number.isInteger(Number(value.bytes))
    || Number(value.bytes) <= 0
    || !SHA256.test(String(value.sha256 ?? '').toLowerCase())
  ) throw new Error(`${label} is not the expected non-empty file authority`);
  return value;
}

function assertCleanProvenance(provenance) {
  if (
    !provenance
    || provenance.source !== 'git'
    || provenance.captureStatus !== 'captured'
    || provenance.worktreeClean !== true
    || Number(provenance.dirtyEntryCount) !== 0
    || !/^[a-f0-9]{40}$/i.test(String(provenance.headCommit ?? ''))
  ) throw new Error('provider preflight grant requires exact clean git provenance');
}

function normalizedGrantWorkers(workers) {
  return workers.map((worker) => ({
    workerId: worker.workerId,
    ...(String(worker.interactiveUser ?? '').trim()
      ? { interactiveUser: String(worker.interactiveUser).trim() }
      : {}),
    vmIdentity: structuredClone(worker.vmIdentity),
    vmIdentityDigest: sha256Canonical(worker.vmIdentity),
    deviceProfileInstances: structuredClone(worker.deviceProfileInstances),
  }));
}

function grantCells(assignments) {
  return LIVE_LLM_CELLS.map((cell, cellIndex) => ({
    cellIndex,
    cellId: cell.cellId,
    providerId: PROVIDER_PREFLIGHT_PROVIDER_ID,
    modelId: cell.modelId,
    protocol: protocolForModel(cell.modelId),
    feedbackLoopPrevention: cell.feedbackLoopPrevention,
    deviceClass: cell.deviceClass,
    workerId: assignments[cellIndex].workerId,
    waveIndex: assignments[cellIndex].waveIndex,
    deviceProfileInstanceId: assignments[cellIndex].deviceProfileInstanceId,
    leaseId: assignments[cellIndex].leaseId,
    maxExternalAudioSamples: SHARD_CELL_MAX_EXTERNAL_AUDIO_SAMPLES,
  }));
}

export function providerPreflightAuthorizationDigest({ grant, leaseReservations }) {
  return sha256Canonical({
    schemaVersion: SHARD_AUTHORITY_SCHEMA_VERSION,
    artifactKind: PROVIDER_PREFLIGHT_AUTHORIZATION_SET_KIND,
    executionId: grant.executionId,
    grantDigest: grant.digest,
    leaseReservationDigests: leaseReservations.map((reservation) => reservation.digest),
  });
}

export function providerPreflightAuthorizationConsumption({ grant, leaseReservations }) {
  verifyProviderPreflightLeaseReservations(leaseReservations, grant);
  return {
    schemaVersion: SHARD_AUTHORITY_SCHEMA_VERSION,
    artifactKind: PROVIDER_PREFLIGHT_CONSUMPTION_KIND,
    executionId: grant.executionId,
    grantDigest: grant.digest,
    leaseReservationDigests: leaseReservations.map((reservation) => reservation.digest),
    authorizationDigest: providerPreflightAuthorizationDigest({ grant, leaseReservations }),
    providerId: grant.authorization.providerId,
    model: grant.authorization.model,
    protocol: grant.authorization.protocol,
    operation: grant.authorization.operation,
    inputMode: grant.authorization.inputMode,
    invocationCount: grant.authorization.invocationCount,
    externalAudioSamples: grant.authorization.externalAudioSamples,
    tokenBudget: structuredClone(grant.authorization.tokenBudget),
    leaseReservations: leaseReservations.map((reservation, index) => ({
      cellIndex: index,
      cellId: reservation.cellId,
      workerId: reservation.workerId,
      waveIndex: reservation.waveIndex,
      leaseId: reservation.leaseId,
      maxExternalAudioSamples: reservation.maxExternalAudioSamples,
      digest: reservation.digest,
      issuedAt: reservation.issuedAt,
    })),
    grantGeneratedAt: grant.generatedAt,
    reservationIssuedAts: leaseReservations.map((reservation) => reservation.issuedAt),
  };
}

export function validateProviderPreflightConsumptionClaim({
  authorizationRoot,
  grant,
  leaseReservations,
  workspaceRoot,
} = {}) {
  verifyProviderPreflightLeaseReservations(leaseReservations, grant);
  const root = path.resolve(authorizationRoot);
  const rootEntries = fs.readdirSync(root, { withFileTypes: true });
  const expectedRootEntries = [
    PROVIDER_PREFLIGHT_CONSUMPTION_CLAIM_FILE,
    PROVIDER_PREFLIGHT_GRANT_FILE,
    PROVIDER_PREFLIGHT_LEASE_RESERVATION_DIRECTORY,
    'worker-readiness',
    'worker-readiness-request.json',
  ].sort();
  if (
    canonicalJson(rootEntries.map((entry) => entry.name).sort()) !== canonicalJson(expectedRootEntries)
    || rootEntries.some((entry) => entry.isSymbolicLink())
  ) throw new Error('provider preflight authorization root is not the exact non-symlink package');
  const claimPath = path.join(root, PROVIDER_PREFLIGHT_CONSUMPTION_CLAIM_FILE);
  const claim = readRegularJson(claimPath, 'provider preflight consumption claim');
  const expectedKeys = [
    'artifactKind',
    'authorizationDigest',
    'claimedAt',
    'coordinatorKeyId',
    'desktopExecutableBytes',
    'desktopExecutablePath',
    'desktopExecutableRelativePath',
    'desktopExecutableSha256',
    'desktopProcessId',
    'executionId',
    'grantDigest',
    'retryPolicy',
    'schemaVersion',
  ].sort();
  if (canonicalJson(Object.keys(claim).sort()) !== canonicalJson(expectedKeys)) {
    throw new Error('provider preflight consumption claim has unexpected or missing fields');
  }
  const consumption = providerPreflightAuthorizationConsumption({ grant, leaseReservations });
  const claimedAt = isoMs(claim.claimedAt, 'provider preflight consumption claim claimedAt');
  const latestReservationAt = Math.max(...leaseReservations.map((entry) => (
    isoMs(entry.issuedAt, 'provider preflight reservation issuedAt')
  )));
  const executableAuthority = grant.runtimeBinaryHashes.find(
    (entry) => entry.path === PROVIDER_PREFLIGHT_DESKTOP_EXECUTABLE,
  );
  const expectedExecutablePath = path.resolve(
    workspaceRoot,
    ...PROVIDER_PREFLIGHT_DESKTOP_EXECUTABLE.split('/'),
  );
  const executableFile = fileAuthorityEntry(
    expectedExecutablePath,
    PROVIDER_PREFLIGHT_DESKTOP_EXECUTABLE,
  );
  if (
    claim.schemaVersion !== SHARD_AUTHORITY_SCHEMA_VERSION
    || claim.artifactKind !== PROVIDER_PREFLIGHT_CONSUMPTION_CLAIM_KIND
    || claim.executionId !== grant.executionId
    || claim.grantDigest !== grant.digest
    || claim.authorizationDigest !== consumption.authorizationDigest
    || claim.coordinatorKeyId !== grant.signature?.keyId
    || claimedAt < latestReservationAt
    || !Number.isInteger(Number(claim.desktopProcessId))
    || Number(claim.desktopProcessId) <= 0
    || claim.desktopExecutableRelativePath !== PROVIDER_PREFLIGHT_DESKTOP_EXECUTABLE
    || path.resolve(String(claim.desktopExecutablePath ?? '')) !== expectedExecutablePath
    || Number(claim.desktopExecutableBytes) !== Number(executableAuthority?.bytes)
    || claim.desktopExecutableSha256 !== executableAuthority?.sha256
    || Number(claim.desktopExecutableBytes) !== executableFile.bytes
    || claim.desktopExecutableSha256 !== executableFile.sha256
    || claim.retryPolicy !== 'new-execution-required'
  ) throw new Error('provider preflight consumption claim does not bind the signed authorization/runtime');
  const authority = fileAuthorityEntry(claimPath, PROVIDER_PREFLIGHT_CONSUMPTION_CLAIM_FILE);
  return {
    claim,
    authority,
    projection: {
      ...structuredClone(claim),
      ...authority,
    },
  };
}

export function createProviderPreflightGrant({
  executionId,
  generatedAt,
  expiresAt,
  provenance,
  authorityImplementationHashes,
  runtimeBinaryHashes,
  shardOrchestrationImplementationHashes,
  localIsolationAuthority,
  workerReadinessRequest,
  workerReadinessRequestAuthority,
  workerReadinessAuthorities,
  workers,
  assignments,
  signingKeys,
}) {
  if (!Array.isArray(assignments) || assignments.length !== SHARD_MATRIX_CELL_COUNT) {
    throw new Error('provider preflight grant requires all eight paid assignments');
  }
  const cells = grantCells(assignments);
  if (
    new Set(cells.map((cell) => cell.leaseId)).size !== SHARD_MATRIX_CELL_COUNT
    || cells.some((cell) => !String(cell.leaseId ?? '').trim())
    || cells.reduce((sum, cell) => sum + cell.maxExternalAudioSamples, 0)
      !== SHARD_MATRIX_MAX_EXTERNAL_AUDIO_SAMPLES
  ) throw new Error('provider preflight grant requires eight unique fixed-budget lease IDs');
  const core = {
    schemaVersion: SHARD_AUTHORITY_SCHEMA_VERSION,
    artifactKind: PROVIDER_PREFLIGHT_GRANT_KIND,
    generatedAt: generatedAt instanceof Date ? generatedAt.toISOString() : String(generatedAt),
    expiresAt: expiresAt instanceof Date ? expiresAt.toISOString() : String(expiresAt),
    executionId,
    provenance: structuredClone(provenance),
    authorityImplementationHashes: structuredClone(authorityImplementationHashes),
    runtimeBinaryHashes: structuredClone(runtimeBinaryHashes),
    runtimeBundleDigest: authorityInventoryDigest(runtimeBinaryHashes),
    shardOrchestrationImplementationHashes: structuredClone(shardOrchestrationImplementationHashes),
    localIsolationAuthority: structuredClone(localIsolationAuthority),
    workerReadinessRequest: structuredClone(workerReadinessRequest),
    workerReadinessRequestAuthority: structuredClone(workerReadinessRequestAuthority),
    workerReadinessAuthorities: structuredClone(workerReadinessAuthorities),
    workers: normalizedGrantWorkers(workers),
    cells,
    budget: {
      inputSampleRateHz: 16_000,
      cellMaxExternalAudioSamples: SHARD_CELL_MAX_EXTERNAL_AUDIO_SAMPLES,
      matrixMaxExternalAudioSamples: SHARD_MATRIX_MAX_EXTERNAL_AUDIO_SAMPLES,
      reclaimPolicy: 'never-within-execution',
      retryPolicy: 'new-execution-required',
    },
    authorization: {
      providerId: PROVIDER_PREFLIGHT_PROVIDER_ID,
      model: PROVIDER_PREFLIGHT_MODEL,
      protocol: PROVIDER_PREFLIGHT_PROTOCOL,
      operation: PROVIDER_PREFLIGHT_OPERATION,
      inputMode: PROVIDER_PREFLIGHT_INPUT_MODE,
      invocationCount: PROVIDER_PREFLIGHT_INVOCATION_COUNT,
      externalAudioSamples: PROVIDER_PREFLIGHT_EXTERNAL_AUDIO_SAMPLES,
      systemPromptTemplate: PROVIDER_PREFLIGHT_SYSTEM_PROMPT_TEMPLATE,
      responseModalities: [...PROVIDER_PREFLIGHT_RESPONSE_MODALITIES],
      customHeaders: [...PROVIDER_PREFLIGHT_CUSTOM_HEADERS],
      timeoutMs: PROVIDER_PREFLIGHT_TIMEOUT_MS,
      temperature: PROVIDER_PREFLIGHT_TEMPERATURE,
      tokenBudget: {
        maxInputTokens: PROVIDER_PREFLIGHT_MAX_INPUT_TOKENS,
        maxOutputTokens: PROVIDER_PREFLIGHT_MAX_OUTPUT_TOKENS,
      },
    },
    coordinator: { publicKeyPem: signingKeys.publicKeyPem },
  };
  const grant = signCoordinatorAuthority(core, signingKeys.privateKeyPem, signingKeys.publicKeyPem);
  return verifyProviderPreflightGrant(grant);
}

export function verifyProviderPreflightGrant(grant, expected = {}) {
  verifyCoordinatorAuthority(grant, grant?.coordinator?.publicKeyPem, 'provider preflight grant');
  const generatedAt = isoMs(grant.generatedAt, 'provider preflight grant generatedAt');
  const expiresAt = isoMs(grant.expiresAt, 'provider preflight grant expiresAt');
  if (
    grant.schemaVersion !== SHARD_AUTHORITY_SCHEMA_VERSION
    || grant.artifactKind !== PROVIDER_PREFLIGHT_GRANT_KIND
    || !EXECUTION_ID.test(String(grant.executionId ?? ''))
    || expiresAt <= generatedAt
  ) throw new Error('provider preflight grant schema, execution, or time window is invalid');
  assertCleanProvenance(grant.provenance);
  assertAuthorityInventory(grant.authorityImplementationHashes, 'preflight grant implementation authority');
  assertAuthorityInventory(grant.runtimeBinaryHashes, 'preflight grant runtime authority');
  assertAuthorityInventory(
    grant.shardOrchestrationImplementationHashes,
    'preflight grant shard implementation authority',
  );
  if (grant.runtimeBundleDigest !== authorityInventoryDigest(grant.runtimeBinaryHashes)) {
    throw new Error('provider preflight grant runtime bundle digest mismatch');
  }
  if (
    !grant.localIsolationAuthority
    || Number(grant.localIsolationAuthority.providerCalls) !== 0
  ) throw new Error('provider preflight grant local isolation authority is invalid');
  assertFileAuthority(
    grant.workerReadinessRequestAuthority,
    'worker-readiness-request.json',
    'provider preflight worker readiness request authority',
  );
  if (!Array.isArray(grant.workers) || !SHARD_ALLOWED_WORKER_COUNTS.includes(grant.workers.length)) {
    throw new Error('provider preflight grant requires exactly two or three workers');
  }
  validateWorkerReadinessRequest(grant.workerReadinessRequest, {
    executionId: grant.executionId,
    provenance: grant.provenance,
    runtimeBinaryHashes: grant.runtimeBinaryHashes,
    workers: grant.workers,
    assignments: grant.cells,
  });
  if (!Array.isArray(grant.workerReadinessAuthorities)
    || grant.workerReadinessAuthorities.length !== grant.workers.length) {
    throw new Error('provider preflight grant readiness authority count mismatch');
  }
  grant.workers.forEach((worker, index) => {
    if (worker.vmIdentityDigest !== sha256Canonical(worker.vmIdentity)) {
      throw new Error(`provider preflight grant worker ${index} VM digest mismatch`);
    }
    const readiness = grant.workerReadinessAuthorities[index];
    if (readiness?.workerId !== worker.workerId || Number(readiness?.providerCalls) !== 0) {
      throw new Error(`provider preflight grant worker ${index} readiness binding mismatch`);
    }
    assertFileAuthority(
      readiness,
      `worker-readiness/${worker.workerId}.json`,
      `provider preflight worker ${index} readiness authority`,
    );
  });
  if (!Array.isArray(grant.cells) || grant.cells.length !== SHARD_MATRIX_CELL_COUNT) {
    throw new Error('provider preflight grant requires the exact eight paid cells');
  }
  const workerIds = new Set(grant.workers.map((worker) => worker.workerId));
  const slots = new Set();
  const leases = new Set();
  grant.cells.forEach((cell, index) => {
    const approved = LIVE_LLM_CELLS[index];
    const expectedCell = {
      cellIndex: index,
      cellId: approved.cellId,
      providerId: PROVIDER_PREFLIGHT_PROVIDER_ID,
      modelId: approved.modelId,
      protocol: protocolForModel(approved.modelId),
      feedbackLoopPrevention: approved.feedbackLoopPrevention,
      deviceClass: approved.deviceClass,
    };
    for (const [key, value] of Object.entries(expectedCell)) {
      if (cell?.[key] !== value) throw new Error(`provider preflight grant cell ${index} ${key} mismatch`);
    }
    if (
      !workerIds.has(cell.workerId)
      || !String(cell.deviceProfileInstanceId ?? '').trim()
      || !String(cell.leaseId ?? '').trim()
      || !Number.isInteger(Number(cell.waveIndex))
      || Number(cell.waveIndex) < 0
      || Number(cell.maxExternalAudioSamples) !== SHARD_CELL_MAX_EXTERNAL_AUDIO_SAMPLES
    ) throw new Error(`provider preflight grant cell ${index} assignment/budget is invalid`);
    if (slots.has(`${cell.workerId}::${cell.waveIndex}`)) {
      throw new Error(`provider preflight grant worker ${cell.workerId} has duplicate wave slot`);
    }
    slots.add(`${cell.workerId}::${cell.waveIndex}`);
    if (leases.has(cell.leaseId)) throw new Error('provider preflight grant contains a duplicate lease ID');
    leases.add(cell.leaseId);
  });
  if (
    grant.budget?.inputSampleRateHz !== 16_000
    || grant.budget?.cellMaxExternalAudioSamples !== SHARD_CELL_MAX_EXTERNAL_AUDIO_SAMPLES
    || grant.budget?.matrixMaxExternalAudioSamples !== SHARD_MATRIX_MAX_EXTERNAL_AUDIO_SAMPLES
    || grant.budget?.reclaimPolicy !== 'never-within-execution'
    || grant.budget?.retryPolicy !== 'new-execution-required'
    || grant.authorization?.providerId !== PROVIDER_PREFLIGHT_PROVIDER_ID
    || grant.authorization?.model !== PROVIDER_PREFLIGHT_MODEL
    || grant.authorization?.protocol !== PROVIDER_PREFLIGHT_PROTOCOL
    || grant.authorization?.operation !== PROVIDER_PREFLIGHT_OPERATION
    || grant.authorization?.inputMode !== PROVIDER_PREFLIGHT_INPUT_MODE
    || grant.authorization?.invocationCount !== PROVIDER_PREFLIGHT_INVOCATION_COUNT
    || grant.authorization?.externalAudioSamples !== PROVIDER_PREFLIGHT_EXTERNAL_AUDIO_SAMPLES
    || grant.authorization?.systemPromptTemplate !== PROVIDER_PREFLIGHT_SYSTEM_PROMPT_TEMPLATE
    || canonicalJson(grant.authorization?.responseModalities)
      !== canonicalJson(PROVIDER_PREFLIGHT_RESPONSE_MODALITIES)
    || canonicalJson(grant.authorization?.customHeaders)
      !== canonicalJson(PROVIDER_PREFLIGHT_CUSTOM_HEADERS)
    || grant.authorization?.timeoutMs !== PROVIDER_PREFLIGHT_TIMEOUT_MS
    || grant.authorization?.temperature !== PROVIDER_PREFLIGHT_TEMPERATURE
    || grant.authorization?.tokenBudget?.maxInputTokens !== PROVIDER_PREFLIGHT_MAX_INPUT_TOKENS
    || grant.authorization?.tokenBudget?.maxOutputTokens !== PROVIDER_PREFLIGHT_MAX_OUTPUT_TOKENS
  ) throw new Error('provider preflight grant is not the fixed text-only/24-minute authorization');
  if (expected.executionId && grant.executionId !== expected.executionId) {
    throw new Error('provider preflight grant executionId mismatch');
  }
  if (expected.provenance && canonicalJson(grant.provenance) !== canonicalJson(expected.provenance)) {
    throw new Error('provider preflight grant provenance mismatch');
  }
  for (const [actual, wanted, label] of [
    [grant.authorityImplementationHashes, expected.authorityImplementationHashes, 'implementation'],
    [grant.runtimeBinaryHashes, expected.runtimeBinaryHashes, 'runtime'],
    [grant.shardOrchestrationImplementationHashes, expected.shardOrchestrationImplementationHashes, 'shard'],
  ]) {
    if (wanted && !sameAuthorityInventory(actual, wanted)) {
      throw new Error(`provider preflight grant ${label} authority mismatch`);
    }
  }
  return grant;
}

export function createProviderPreflightLeaseReservations({ grant, issuedAt, signingKeys }) {
  verifyProviderPreflightGrant(grant);
  const issuedAtIso = issuedAt instanceof Date ? issuedAt.toISOString() : String(issuedAt);
  if (isoMs(issuedAtIso, 'provider preflight reservation issuedAt') <= isoMs(grant.generatedAt, 'grant generatedAt')) {
    throw new Error('provider preflight reservations must be issued after the signed grant');
  }
  const reservations = grant.cells.map((cell) => signCoordinatorAuthority({
    schemaVersion: SHARD_AUTHORITY_SCHEMA_VERSION,
    artifactKind: PROVIDER_PREFLIGHT_LEASE_RESERVATION_KIND,
    issuedAt: issuedAtIso,
    expiresAt: grant.expiresAt,
    executionId: grant.executionId,
    grantDigest: grant.digest,
    cellIndex: cell.cellIndex,
    cellId: cell.cellId,
    workerId: cell.workerId,
    waveIndex: cell.waveIndex,
    leaseId: cell.leaseId,
    maxExternalAudioSamples: cell.maxExternalAudioSamples,
    reclaimPolicy: 'never-within-execution',
    retryPolicy: 'new-execution-required',
    coordinator: { publicKeyPem: signingKeys.publicKeyPem },
  }, signingKeys.privateKeyPem, signingKeys.publicKeyPem));
  return verifyProviderPreflightLeaseReservations(reservations, grant);
}

export function verifyProviderPreflightLeaseReservations(reservations, grant) {
  verifyProviderPreflightGrant(grant);
  if (!Array.isArray(reservations) || reservations.length !== SHARD_MATRIX_CELL_COUNT) {
    throw new Error('provider preflight requires exactly eight signed lease reservations');
  }
  const grantAt = isoMs(grant.generatedAt, 'provider preflight grant generatedAt');
  const expiresAt = isoMs(grant.expiresAt, 'provider preflight grant expiresAt');
  reservations.forEach((reservation, index) => {
    verifyCoordinatorAuthority(
      reservation,
      grant.coordinator.publicKeyPem,
      `provider preflight lease reservation ${index}`,
    );
    const cell = grant.cells[index];
    const issuedAt = isoMs(reservation.issuedAt, `provider preflight reservation ${index} issuedAt`);
    if (
      reservation.schemaVersion !== SHARD_AUTHORITY_SCHEMA_VERSION
      || reservation.artifactKind !== PROVIDER_PREFLIGHT_LEASE_RESERVATION_KIND
      || reservation.executionId !== grant.executionId
      || reservation.grantDigest !== grant.digest
      || Number(reservation.cellIndex) !== index
      || reservation.cellId !== cell.cellId
      || reservation.workerId !== cell.workerId
      || Number(reservation.waveIndex) !== Number(cell.waveIndex)
      || reservation.leaseId !== cell.leaseId
      || Number(reservation.maxExternalAudioSamples) !== SHARD_CELL_MAX_EXTERNAL_AUDIO_SAMPLES
      || reservation.expiresAt !== grant.expiresAt
      || issuedAt <= grantAt
      || issuedAt >= expiresAt
      || reservation.reclaimPolicy !== 'never-within-execution'
      || reservation.retryPolicy !== 'new-execution-required'
    ) throw new Error(`provider preflight lease reservation ${index} does not match its grant cell`);
  });
  return reservations;
}

function readRegularJson(filePath, label) {
  const stats = fs.lstatSync(filePath);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0) {
    throw new Error(`${label} must be a non-empty regular non-symlink file`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

export function loadProviderPreflightAuthorizationPackage({
  grantPath,
  reservationDirectory,
  expectedAuthorizationDigest = null,
  expected = {},
}) {
  const resolvedGrantPath = path.resolve(grantPath);
  if (path.basename(resolvedGrantPath) !== PROVIDER_PREFLIGHT_GRANT_FILE) {
    throw new Error('provider preflight grant path has an unexpected filename');
  }
  const grant = verifyProviderPreflightGrant(
    readRegularJson(resolvedGrantPath, 'provider preflight grant'),
    expected,
  );
  const resolvedReservationDirectory = path.resolve(reservationDirectory);
  const directoryStats = fs.lstatSync(resolvedReservationDirectory);
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    throw new Error('provider preflight reservation directory must be real and non-symlink');
  }
  const expectedFiles = grant.cells.map(providerPreflightReservationFileName);
  const entries = fs.readdirSync(resolvedReservationDirectory, { withFileTypes: true });
  if (
    entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())
    || canonicalJson(entries.map((entry) => entry.name).sort()) !== canonicalJson([...expectedFiles].sort())
  ) throw new Error('provider preflight reservation directory is not the exact eight-file set');
  const leaseReservations = expectedFiles.map((fileName, index) => readRegularJson(
    path.join(resolvedReservationDirectory, fileName),
    `provider preflight reservation ${index}`,
  ));
  verifyProviderPreflightLeaseReservations(leaseReservations, grant);
  const authorizationDigest = providerPreflightAuthorizationDigest({ grant, leaseReservations });
  if (expectedAuthorizationDigest && authorizationDigest !== expectedAuthorizationDigest) {
    throw new Error('provider preflight authorization digest mismatch');
  }
  return {
    grant,
    leaseReservations,
    authorizationDigest,
    consumption: providerPreflightAuthorizationConsumption({ grant, leaseReservations }),
    grantAuthority: fileAuthorityEntry(resolvedGrantPath, PROVIDER_PREFLIGHT_GRANT_FILE),
    leaseReservationAuthorities: expectedFiles.map((fileName, index) => ({
      cellIndex: index,
      cellId: grant.cells[index].cellId,
      leaseId: grant.cells[index].leaseId,
      digest: leaseReservations[index].digest,
      ...fileAuthorityEntry(
        path.join(resolvedReservationDirectory, fileName),
        `${PROVIDER_PREFLIGHT_LEASE_RESERVATION_DIRECTORY}/${fileName}`,
      ),
    })),
  };
}

export function validateProviderPreflightAuthorizationAuthorities({
  root,
  grantAuthority,
  leaseReservationAuthorities,
  authorizationDigest,
  expected = {},
}) {
  const grantPath = validateFileAuthorityEntry(
    root,
    grantAuthority,
    PROVIDER_PREFLIGHT_GRANT_FILE,
    'provider preflight grant authority',
  );
  if (!Array.isArray(leaseReservationAuthorities)
    || leaseReservationAuthorities.length !== SHARD_MATRIX_CELL_COUNT) {
    throw new Error('provider preflight reservation authority inventory must contain eight entries');
  }
  leaseReservationAuthorities.forEach((entry, index) => validateFileAuthorityEntry(
    root,
    entry,
    `${PROVIDER_PREFLIGHT_LEASE_RESERVATION_DIRECTORY}/${providerPreflightReservationFileName(
      { cellId: entry.cellId, cellIndex: index },
      index,
    )}`,
    `provider preflight reservation authority ${index}`,
  ));
  return loadProviderPreflightAuthorizationPackage({
    grantPath,
    reservationDirectory: path.join(root, PROVIDER_PREFLIGHT_LEASE_RESERVATION_DIRECTORY),
    expectedAuthorizationDigest: authorizationDigest,
    expected,
  });
}

export function createProviderPreflightCompletion({
  grant,
  leaseReservations,
  preflightAuthority,
  generatedAt,
  signingKeys,
}) {
  const consumption = providerPreflightAuthorizationConsumption({ grant, leaseReservations });
  if (
    preflightAuthority.providerId !== consumption.providerId
    || preflightAuthority.model !== consumption.model
    || preflightAuthority.protocol !== consumption.protocol
    || preflightAuthority.operation !== consumption.operation
    || preflightAuthority.inputMode !== consumption.inputMode
    || preflightAuthority.invocationCount !== consumption.invocationCount
    || preflightAuthority.externalAudioSamples !== consumption.externalAudioSamples
    || canonicalJson(preflightAuthority.tokenBudget) !== canonicalJson(consumption.tokenBudget)
    || typeof preflightAuthority.inputTokens !== 'number'
    || !Number.isSafeInteger(preflightAuthority.inputTokens)
    || preflightAuthority.inputTokens < 0
    || preflightAuthority.inputTokens > consumption.tokenBudget.maxInputTokens
    || typeof preflightAuthority.outputTokens !== 'number'
    || !Number.isSafeInteger(preflightAuthority.outputTokens)
    || preflightAuthority.outputTokens < 0
    || preflightAuthority.outputTokens > consumption.tokenBudget.maxOutputTokens
    || (preflightAuthority.audioSeconds != null
      && (typeof preflightAuthority.audioSeconds !== 'number'
        || preflightAuthority.audioSeconds !== 0))
    || preflightAuthority.status !== 'completed'
    || preflightAuthority.executionId !== consumption.executionId
    || preflightAuthority.grantDigest !== consumption.grantDigest
    || preflightAuthority.authorizationDigest !== consumption.authorizationDigest
    || canonicalJson(preflightAuthority.leaseReservationDigests)
      !== canonicalJson(consumption.leaseReservationDigests)
    || preflightAuthority.consumptionClaim?.schemaVersion !== SHARD_AUTHORITY_SCHEMA_VERSION
    || preflightAuthority.consumptionClaim?.artifactKind !== PROVIDER_PREFLIGHT_CONSUMPTION_CLAIM_KIND
    || preflightAuthority.consumptionClaim?.executionId !== consumption.executionId
    || preflightAuthority.consumptionClaim?.grantDigest !== consumption.grantDigest
    || preflightAuthority.consumptionClaim?.authorizationDigest !== consumption.authorizationDigest
    || preflightAuthority.consumptionClaim?.path !== PROVIDER_PREFLIGHT_CONSUMPTION_CLAIM_FILE
    || !Number.isInteger(Number(preflightAuthority.consumptionClaim?.bytes))
    || Number(preflightAuthority.consumptionClaim?.bytes) <= 0
    || !SHA256.test(String(preflightAuthority.consumptionClaim?.sha256 ?? ''))
    || preflightAuthority.consumptionClaim?.retryPolicy !== 'new-execution-required'
  ) throw new Error('provider preflight completion does not match its consumed signed authorization');
  const completionAt = generatedAt instanceof Date ? generatedAt.toISOString() : String(generatedAt);
  if (isoMs(completionAt, 'provider preflight completion generatedAt')
    <= isoMs(preflightAuthority.generatedAt, 'provider preflight receipt generatedAt')) {
    throw new Error('provider preflight completion must be generated after the raw receipt');
  }
  return signCoordinatorAuthority({
    schemaVersion: SHARD_AUTHORITY_SCHEMA_VERSION,
    artifactKind: PROVIDER_PREFLIGHT_COMPLETION_KIND,
    generatedAt: completionAt,
    executionId: grant.executionId,
    grantDigest: grant.digest,
    leaseReservationDigests: leaseReservations.map((reservation) => reservation.digest),
    authorizationDigest: consumption.authorizationDigest,
    consumptionClaim: structuredClone(preflightAuthority.consumptionClaim),
    preflightAuthority: structuredClone(preflightAuthority),
    coordinator: { publicKeyPem: signingKeys.publicKeyPem },
  }, signingKeys.privateKeyPem, signingKeys.publicKeyPem);
}

export function verifyProviderPreflightCompletion(completion, grant, leaseReservations) {
  const consumption = providerPreflightAuthorizationConsumption({ grant, leaseReservations });
  verifyCoordinatorAuthority(
    completion,
    grant.coordinator.publicKeyPem,
    'provider preflight completion',
  );
  if (
    completion.schemaVersion !== SHARD_AUTHORITY_SCHEMA_VERSION
    || completion.artifactKind !== PROVIDER_PREFLIGHT_COMPLETION_KIND
    || completion.executionId !== grant.executionId
    || completion.grantDigest !== grant.digest
    || completion.authorizationDigest !== consumption.authorizationDigest
    || canonicalJson(completion.leaseReservationDigests)
      !== canonicalJson(consumption.leaseReservationDigests)
    || completion.preflightAuthority?.providerId !== consumption.providerId
    || completion.preflightAuthority?.model !== consumption.model
    || completion.preflightAuthority?.protocol !== consumption.protocol
    || completion.preflightAuthority?.operation !== consumption.operation
    || completion.preflightAuthority?.inputMode !== consumption.inputMode
    || completion.preflightAuthority?.invocationCount !== consumption.invocationCount
    || completion.preflightAuthority?.externalAudioSamples !== consumption.externalAudioSamples
    || canonicalJson(completion.preflightAuthority?.tokenBudget)
      !== canonicalJson(consumption.tokenBudget)
    || typeof completion.preflightAuthority?.inputTokens !== 'number'
    || !Number.isSafeInteger(completion.preflightAuthority.inputTokens)
    || completion.preflightAuthority.inputTokens < 0
    || completion.preflightAuthority.inputTokens > consumption.tokenBudget.maxInputTokens
    || typeof completion.preflightAuthority?.outputTokens !== 'number'
    || !Number.isSafeInteger(completion.preflightAuthority.outputTokens)
    || completion.preflightAuthority.outputTokens < 0
    || completion.preflightAuthority.outputTokens > consumption.tokenBudget.maxOutputTokens
    || (completion.preflightAuthority?.audioSeconds != null
      && (typeof completion.preflightAuthority.audioSeconds !== 'number'
        || completion.preflightAuthority.audioSeconds !== 0))
    || completion.preflightAuthority?.status !== 'completed'
    || completion.preflightAuthority?.executionId !== consumption.executionId
    || completion.preflightAuthority?.grantDigest !== consumption.grantDigest
    || completion.preflightAuthority?.authorizationDigest !== consumption.authorizationDigest
    || canonicalJson(completion.preflightAuthority?.leaseReservationDigests)
      !== canonicalJson(consumption.leaseReservationDigests)
    || canonicalJson(completion.consumptionClaim)
      !== canonicalJson(completion.preflightAuthority?.consumptionClaim)
    || !completion.consumptionClaim
    || isoMs(completion.generatedAt, 'provider preflight completion generatedAt')
      <= isoMs(completion.preflightAuthority?.generatedAt, 'provider preflight receipt generatedAt')
  ) throw new Error('provider preflight completion is not bound to its signed authorization/result');
  return completion;
}
