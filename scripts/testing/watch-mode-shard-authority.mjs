import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { repoRoot } from '../lib/testing-common.mjs';
import {
  BALANCED_RELEASE_PLAN,
  LIVE_LLM_CELLS,
} from './watch-mode-balanced-release-plan.mjs';

export const SHARD_AUTHORITY_SCHEMA_VERSION = 2;
export const SHARD_EXECUTION_PLAN_KIND = 'watch-mode-paid-shard-execution-plan';
export const SHARD_CELL_LEASE_KIND = 'watch-mode-paid-shard-cell-lease';
export const SHARD_CELL_RESULT_KIND = 'watch-mode-paid-shard-cell-result';
export const SHARD_MANIFEST_KIND = 'watch-mode-paid-shard-manifest';
export const SHARD_EXECUTION_PLAN_FILE = 'strict-shard-execution-plan.json';
export const SHARD_CELL_RESULT_FILE = 'shard-cell-result.json';
export const SHARD_MANIFEST_FILE = 'shard-manifest.json';
export const SHARD_WORKER_READINESS_REQUEST_KIND =
  'watch-mode-production-worker-readiness-request';
export const SHARD_WORKER_READINESS_KIND =
  'watch-mode-production-worker-zero-provider-readiness';
export const SHARD_WORKER_READINESS_FILE = 'worker-zero-provider-readiness.json';
export const SHARD_INTERACTIVE_SESSION_AUTHORITY_FILE = 'interactive-session-authority.json';
export const SHARD_INTERACTIVE_COMMAND_FILE = 'interactive-command.json';
export const SHARD_INTERACTIVE_LAUNCH_FILE = 'interactive-launch.json';
export const SHARD_INTERACTIVE_PROCESS_AUTHORITY_FILE = 'interactive-process-authority.json';
export const SHARD_INTERACTIVE_TERMINAL_FILE = 'interactive-terminal.json';
export const SHARD_INTERACTIVE_TASK_TERMINAL_FILE = 'interactive-task-terminal.json';
export const SHARD_INTERACTIVE_CLAIM_RELEASE_FILE = 'interactive-claim-release.json';
export const SHARD_INTERACTIVE_CELL_EXECUTION_FILE = 'interactive-cell-execution.json';
export const SHARD_INTERACTIVE_CELL_EXECUTION_KIND =
  'watch-mode-interactive-shard-cell-execution';

export const PROVIDER_INPUT_BUDGET_LEDGER_SCHEMA_VERSION = 1;
export const PROVIDER_INPUT_BUDGET_LEDGER_KIND = 'watch-mode-provider-input-budget-ledger';
export const PROVIDER_INPUT_BUDGET_LEDGER_FILE = 'provider-input-budget-ledger.json';
export const PROVIDER_INPUT_BUDGET_JOURNAL_FILE = `${PROVIDER_INPUT_BUDGET_LEDGER_FILE}.journal.jsonl`;
export const PROVIDER_INPUT_BUDGET_LEASE_KIND = 'watch-mode-provider-input-budget-lease';
export const PROVIDER_INPUT_BUDGET_LEASE_FILE = 'provider-input-budget-lease.json';
export const SHARD_STRICT_PAID_PROVIDER_IDENTITY = Object.freeze({
  strictPaidAuthority: true,
  providerId: 'provider-dashscope',
  templateId: 'template-dashscope-realtime',
  providerKind: 'dashscope',
  endpointHost: 'dashscope.aliyuncs.com',
  credentialReference: 'credential://provider/dashscope/default',
  authHeaderName: 'Authorization',
  authScheme: 'bearer',
  customHeaderCount: 0,
});
export const SHARD_STRICT_PAID_MODEL_PROTOCOLS = Object.freeze({
  'qwen3.5-omni-flash-realtime': 'dashscope-omni',
  'qwen3.5-livetranslate-flash-realtime': 'dashscope-livetranslate',
});

export const SHARD_INPUT_SAMPLE_RATE_HZ = 16_000;
export const SHARD_CELL_MAX_EXTERNAL_AUDIO_SAMPLES = 2_880_000;
export const SHARD_CELL_MAX_EXTERNAL_AUDIO_SECONDS = 180;
export const SHARD_MATRIX_CELL_COUNT = 8;
export const SHARD_MATRIX_MAX_EXTERNAL_AUDIO_SAMPLES = 23_040_000;
export const SHARD_MATRIX_MAX_EXTERNAL_AUDIO_SECONDS = 1_440;
export const SHARD_ALLOWED_WORKER_COUNTS = Object.freeze([1]);
export const SHARD_MIN_WORKER_COUNT = 1;
export const SHARD_MAX_WORKER_COUNT = 1;

// This inventory is intentionally separate from AUTHORITY_IMPLEMENTATION_FILES.
// Adding shard orchestration must not invalidate a previously captured six-cell
// zero-Provider local-isolation authority.
export const SHARD_ORCHESTRATION_IMPLEMENTATION_FILES = Object.freeze([
  'scripts/testing/watch-mode-shard-authority.mjs',
  'scripts/testing/run-watch-mode-live-shard.mjs',
  'scripts/testing/run-watch-mode-live-coordinator.mjs',
  'scripts/testing/run-watch-mode-live-production-coordinator.mjs',
  'scripts/testing/watch-mode-strict-runtime-authority.mjs',
  'scripts/testing/watch-mode-provider-preflight-process.mjs',
  'scripts/testing/watch-mode-provider-network-health.mjs',
  'scripts/testing/invoke-watch-mode-interactive-task.ps1',
  'scripts/testing/lib/powershell/Omni.Testing.WatchMode.InteractiveRequest.psm1',
  'scripts/testing/lib/powershell/Omni.Testing.WatchMode.InteractiveScheduler.psm1',
  'scripts/testing/run-watch-mode-interactive-task.ps1',
  'scripts/testing/collect-watch-mode-interactive-process-authority.ps1',
  'scripts/testing/release-manual-collector.mjs',
  'scripts/testing/watch-mode-provider-preflight-authority.mjs',
  'scripts/testing/watch-mode-provider-preflight-authorization.mjs',
]);

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const EXECUTION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{7,127}$/i;
const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const ALLOWED_JOURNAL_EVENTS = new Set([
  'initialized',
  'initial_connect_attempt',
  'reserved',
  'reserve_rejected',
  'send_failed',
  'reconnect',
  'finalized',
]);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => value[key] !== undefined)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export const canonicalJson = (value) => JSON.stringify(canonicalize(value));
export const sha256Canonical = (value) => (
  crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
);
export const sha256File = (filePath) => (
  crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
);

const portable = (value) => value.split(path.sep).join('/');

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function assertIdentifier(value, label) {
  if (!IDENTIFIER_PATTERN.test(String(value ?? ''))) {
    throw new Error(`${label} must be a portable identifier`);
  }
  return String(value);
}

function assertExecutionId(value) {
  if (!EXECUTION_ID_PATTERN.test(String(value ?? ''))) {
    throw new Error('shard executionId must be an 8-128 character portable identifier');
  }
  return String(value);
}

function assertIsoDate(value, label) {
  const timestamp = Date.parse(String(value ?? ''));
  if (!Number.isFinite(timestamp)) throw new Error(`${label} must be an ISO timestamp`);
  return timestamp;
}

function assertCleanProvenance(provenance, label = 'shard source provenance') {
  assertObject(provenance, label);
  if (
    provenance.source !== 'git'
    || provenance.captureStatus !== 'captured'
    || !/^[a-f0-9]{40}$/i.test(String(provenance.headCommit ?? ''))
    || provenance.worktreeClean !== true
    || Number(provenance.dirtyEntryCount) !== 0
  ) {
    throw new Error(`${label} must bind an exact clean 40-character git HEAD`);
  }
  return provenance;
}

function assertRelativePortablePath(value, label) {
  const normalized = String(value ?? '').replaceAll('\\', '/');
  if (
    !normalized
    || path.posix.isAbsolute(normalized)
    || /^[a-z]:\//i.test(normalized)
    || normalized.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error(`${label} must be a non-empty relative portable path without traversal`);
  }
  return normalized;
}

function assertRegularFile(filePath, label, { allowEmpty = false } = {}) {
  let stats;
  try {
    stats = fs.lstatSync(filePath);
  } catch {
    throw new Error(`${label} is missing: ${filePath}`);
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file: ${filePath}`);
  }
  if (!allowEmpty && stats.size <= 0) throw new Error(`${label} is empty: ${filePath}`);
  return stats;
}

export function resolveAuthorityChild(parentDirectory, relativePath, label = 'authority path') {
  const normalized = assertRelativePortablePath(relativePath, label);
  const parent = path.resolve(parentDirectory);
  const resolved = path.resolve(parent, ...normalized.split('/'));
  const relative = path.relative(parent, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes ${parent}`);
  }
  return resolved;
}

export function relativeAuthorityChild(parentDirectory, childPath, label = 'authority path') {
  const parent = path.resolve(parentDirectory);
  const child = path.resolve(childPath);
  const relative = path.relative(parent, child);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} must be a child of ${parent}: ${child}`);
  }
  return portable(relative);
}

export function fileAuthorityEntry(filePath, relativePath, { allowEmpty = false } = {}) {
  const normalized = assertRelativePortablePath(relativePath, 'authority artifact path');
  const stats = assertRegularFile(filePath, `authority artifact ${normalized}`, { allowEmpty });
  return { path: normalized, bytes: stats.size, sha256: sha256File(filePath) };
}

export function validateFileAuthorityEntry(parentDirectory, entry, expectedPath, label) {
  assertObject(entry, label);
  const normalized = assertRelativePortablePath(expectedPath, `${label} expected path`);
  if (entry.path !== normalized) throw new Error(`${label} path mismatch`);
  const filePath = resolveAuthorityChild(parentDirectory, entry.path, label);
  const current = fileAuthorityEntry(filePath, normalized, { allowEmpty: true });
  if (Number(entry.bytes) !== current.bytes || String(entry.sha256).toLowerCase() !== current.sha256) {
    throw new Error(`${label} hash/size binding mismatch`);
  }
  return filePath;
}

export function assertAuthorityInventory(entries, label = 'authority inventory') {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error(`${label} must not be empty`);
  const seen = new Set();
  for (const [index, entry] of entries.entries()) {
    assertObject(entry, `${label}[${index}]`);
    const entryPath = assertRelativePortablePath(entry.path, `${label}[${index}].path`);
    const identity = process.platform === 'win32' ? entryPath.toLowerCase() : entryPath;
    if (seen.has(identity)) throw new Error(`${label} contains duplicate path ${entryPath}`);
    seen.add(identity);
    if (!Number.isInteger(Number(entry.bytes)) || Number(entry.bytes) < 0) {
      throw new Error(`${label}[${index}].bytes must be a non-negative integer`);
    }
    if (!SHA256_PATTERN.test(String(entry.sha256 ?? '').toLowerCase())) {
      throw new Error(`${label}[${index}].sha256 must be a SHA-256 digest`);
    }
  }
  return entries;
}

function sortedInventory(entries) {
  return [...entries]
    .map((entry) => ({ path: entry.path, bytes: Number(entry.bytes), sha256: String(entry.sha256).toLowerCase() }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function authorityInventoryDigest(entries) {
  return sha256Canonical(sortedInventory(assertAuthorityInventory(entries)));
}

export function sameAuthorityInventory(left, right) {
  try {
    return canonicalJson(sortedInventory(assertAuthorityInventory(left)))
      === canonicalJson(sortedInventory(assertAuthorityInventory(right)));
  } catch {
    return false;
  }
}

export function currentShardOrchestrationImplementationHashes({ workspaceRoot = repoRoot } = {}) {
  return SHARD_ORCHESTRATION_IMPLEMENTATION_FILES.map((relativePath) => fileAuthorityEntry(
    path.resolve(workspaceRoot, ...relativePath.split('/')),
    relativePath,
  ));
}

export function coordinatorKeyIdForPublicKey(publicKeyPem) {
  const key = crypto.createPublicKey(publicKeyPem);
  const der = key.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex');
}

const keyIdForPublicKey = coordinatorKeyIdForPublicKey;

export function generateCoordinatorSigningKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

export function signCoordinatorAuthority(value, privateKeyPem, publicKeyPem) {
  const keyId = keyIdForPublicKey(publicKeyPem);
  const core = structuredClone(value);
  const digest = sha256Canonical(core);
  const signed = { ...core, digest };
  return { ...signed, signature: signPayload(signed, privateKeyPem, keyId) };
}

export function verifyCoordinatorAuthority(value, publicKeyPem, label = 'coordinator authority') {
  assertObject(value, label);
  const { signature, digest, ...core } = value;
  if (!SHA256_PATTERN.test(String(digest ?? '')) || digest !== sha256Canonical(core)) {
    throw new Error(`${label} digest mismatch`);
  }
  verifyPayloadSignature({ ...core, digest }, signature, publicKeyPem, label);
  return value;
}

function signPayload(value, privateKeyPem, keyId) {
  const signature = crypto.sign(
    null,
    Buffer.from(canonicalJson(value), 'utf8'),
    crypto.createPrivateKey(privateKeyPem),
  );
  return { algorithm: 'Ed25519', keyId, valueBase64: signature.toString('base64') };
}

function verifyPayloadSignature(value, signature, publicKeyPem, label) {
  if (
    signature?.algorithm !== 'Ed25519'
    || signature?.keyId !== keyIdForPublicKey(publicKeyPem)
    || typeof signature?.valueBase64 !== 'string'
  ) throw new Error(`${label} has invalid signature metadata`);
  let bytes;
  try {
    bytes = Buffer.from(signature.valueBase64, 'base64');
  } catch {
    throw new Error(`${label} signature is not base64`);
  }
  if (!crypto.verify(
    null,
    Buffer.from(canonicalJson(value), 'utf8'),
    crypto.createPublicKey(publicKeyPem),
    bytes,
  )) throw new Error(`${label} Ed25519 signature verification failed`);
}

function approvedCellProjection(cell) {
  return {
    cellId: cell.cellId,
    tier: cell.tier,
    providerMode: cell.providerMode,
    durationSeconds: cell.durationSeconds,
    externalProviderSessionCeilingSeconds:
      cell.externalProviderSessionCeilingSeconds ?? cell.durationSeconds,
    auxiliaryExternalAudioSeconds: cell.auxiliaryExternalAudioSeconds ?? 0,
    subtitleTranslationMode: cell.subtitleTranslationMode ?? 'native',
    modelId: cell.modelId,
    feedbackLoopPrevention: cell.feedbackLoopPrevention,
    deviceClass: cell.deviceClass,
  };
}

function assertExactPaidCells(cells) {
  if (!Array.isArray(cells) || cells.length !== SHARD_MATRIX_CELL_COUNT || LIVE_LLM_CELLS.length !== SHARD_MATRIX_CELL_COUNT) {
    throw new Error(`shard execution plan requires exactly ${SHARD_MATRIX_CELL_COUNT} paid cells`);
  }
  for (let index = 0; index < LIVE_LLM_CELLS.length; index += 1) {
    if (canonicalJson(approvedCellProjection(cells[index])) !== canonicalJson(approvedCellProjection(LIVE_LLM_CELLS[index]))) {
      throw new Error(`shard execution cell ${index} does not match the fixed paid release cell`);
    }
  }
}

function assertVmIdentity(value, label) {
  const identity = assertObject(value, label);
  if (identity.provider !== 'vmware' || !String(identity.uuidBios ?? '').trim()) {
    throw new Error(`${label} must bind provider=vmware and uuidBios`);
  }
  return identity;
}

function assertDeviceProfileInstance(profile, label) {
  assertObject(profile, label);
  assertIdentifier(profile.instanceId, `${label}.instanceId`);
  assertIdentifier(profile.profileId, `${label}.profileId`);
  if (!['default-speaker', 'usb'].includes(profile.deviceClass)) {
    throw new Error(`${label}.deviceClass is unsupported`);
  }
  if (!String(profile.physicalPlaybackDeviceId ?? '').trim()) {
    throw new Error(`${label}.physicalPlaybackDeviceId is missing`);
  }
  if (profile.deviceClass !== 'default-speaker' && profile.physicalPlaybackDeviceId === 'default') {
    throw new Error(`${label} must use an explicit endpoint for ${profile.deviceClass}`);
  }
  if (typeof profile.expectedPhysicalPlaybackDeviceName !== 'string') {
    throw new Error(`${label}.expectedPhysicalPlaybackDeviceName must be a string`);
  }
  return profile;
}

function assertWorkers(workers) {
  if (!Array.isArray(workers) || !SHARD_ALLOWED_WORKER_COUNTS.includes(workers.length)) {
    throw new Error('strict paid execution requires exactly one local worker');
  }
  const workerIds = new Set();
  const vmIds = new Set();
  for (const [index, worker] of workers.entries()) {
    assertObject(worker, `workers[${index}]`);
    const workerId = assertIdentifier(worker.workerId, `workers[${index}].workerId`);
    if (workerIds.has(workerId)) throw new Error(`duplicate workerId ${workerId}`);
    workerIds.add(workerId);
    const vmIdentity = assertVmIdentity(worker.vmIdentity, `workers[${index}].vmIdentity`);
    const vmDigest = sha256Canonical(vmIdentity);
    if (vmIds.has(vmDigest)) throw new Error(`duplicate VM identity for worker ${workerId}`);
    vmIds.add(vmDigest);
    if (worker.vmIdentityDigest !== vmDigest) throw new Error(`worker ${workerId} VM identity digest mismatch`);
    if (!Array.isArray(worker.deviceProfileInstances) || worker.deviceProfileInstances.length === 0) {
      throw new Error(`worker ${workerId} has no device profile instances`);
    }
    const instanceIds = new Set();
    for (const [profileIndex, profile] of worker.deviceProfileInstances.entries()) {
      assertDeviceProfileInstance(profile, `worker ${workerId} profile ${profileIndex}`);
      if (instanceIds.has(profile.instanceId)) throw new Error(`worker ${workerId} has duplicate profile instance ${profile.instanceId}`);
      instanceIds.add(profile.instanceId);
    }
  }
}

function opaqueAuthority(value, label, extraAssertions) {
  assertObject(value, label);
  assertRelativePortablePath(value.path, `${label}.path`);
  if (!Number.isInteger(Number(value.bytes)) || Number(value.bytes) <= 0) {
    throw new Error(`${label}.bytes must be a positive integer`);
  }
  if (!SHA256_PATTERN.test(String(value.sha256 ?? '').toLowerCase())) {
    throw new Error(`${label}.sha256 is invalid`);
  }
  extraAssertions?.(value);
  return value;
}

function assertBoundPrerequisites(plan) {
  if (canonicalJson(plan.providerIdentity) !== canonicalJson(SHARD_STRICT_PAID_PROVIDER_IDENTITY)) {
    throw new Error('execution plan strict paid provider identity is missing or forged');
  }
  opaqueAuthority(plan.localIsolationAuthority, 'local isolation authority', (value) => {
    if (Number(value.providerCalls) !== 0) throw new Error('local isolation authority must bind providerCalls=0');
  });
  opaqueAuthority(plan.providerPreflightAuthority, 'provider preflight authority', (value) => {
    if (
      value.status !== 'completed'
      || value.operation !== 'text-translation-preflight'
      || Number(value.invocationCount) !== 1
      || Number(value.externalAudioSamples) !== 0
      || canonicalJson(value.tokenBudget) !== canonicalJson({
        maxInputTokens: 4_096,
        maxOutputTokens: 256,
      })
      || typeof value.inputTokens !== 'number'
      || !Number.isSafeInteger(value.inputTokens)
      || value.inputTokens < 0
      || value.inputTokens > 4_096
      || typeof value.outputTokens !== 'number'
      || !Number.isSafeInteger(value.outputTokens)
      || value.outputTokens < 0
      || value.outputTokens > 256
      || (value.audioSeconds != null
        && (typeof value.audioSeconds !== 'number' || value.audioSeconds !== 0))
    ) {
      throw new Error('provider preflight authority must bind exactly one completed text-only invocation');
    }
  });
  const hasTwoStagePreflight = Boolean(
    plan.providerPreflightGrant
    || plan.providerPreflightLeaseReservations
    || plan.providerPreflightAuthorization
    || plan.providerPreflightCompletion
  );
  if (hasTwoStagePreflight) {
    opaqueAuthority(plan.providerPreflightGrant, 'provider preflight grant authority', (value) => {
      if (!SHA256_PATTERN.test(String(value.digest ?? ''))) {
        throw new Error('provider preflight grant authority digest is invalid');
      }
    });
    if (
      !Array.isArray(plan.providerPreflightLeaseReservations)
      || plan.providerPreflightLeaseReservations.length !== SHARD_MATRIX_CELL_COUNT
    ) throw new Error('execution plan must bind exactly eight provider preflight lease reservations');
    plan.providerPreflightLeaseReservations.forEach((entry, index) => {
      opaqueAuthority(entry, `provider preflight lease reservation authority ${index}`, (value) => {
        if (
          value.cellId !== LIVE_LLM_CELLS[index].cellId
          || value.leaseId !== plan.cells[index].leaseId
          || !SHA256_PATTERN.test(String(value.digest ?? ''))
        ) throw new Error(`provider preflight lease reservation authority ${index} is invalid`);
      });
    });
    if (
      !plan.providerPreflightAuthorization
      || plan.providerPreflightAuthorization.grantDigest !== plan.providerPreflightGrant.digest
      || !Array.isArray(plan.providerPreflightAuthorization.leaseReservationDigests)
      || canonicalJson(plan.providerPreflightAuthorization.leaseReservationDigests)
        !== canonicalJson(plan.providerPreflightLeaseReservations.map((entry) => entry.digest))
      || !SHA256_PATTERN.test(String(plan.providerPreflightAuthorization.authorizationDigest ?? ''))
      || canonicalJson(plan.providerPreflightAuthorization.tokenBudget) !== canonicalJson({
        maxInputTokens: 4_096,
        maxOutputTokens: 256,
      })
      || canonicalJson(plan.providerPreflightAuthorization.tokenBudget)
        !== canonicalJson(plan.providerPreflightAuthority.tokenBudget)
      || plan.providerPreflightAuthorization.consumptionClaim?.schemaVersion !== SHARD_AUTHORITY_SCHEMA_VERSION
      || plan.providerPreflightAuthorization.consumptionClaim?.artifactKind
        !== 'watch-mode-provider-preflight-consumption-claim'
      || plan.providerPreflightAuthorization.consumptionClaim?.executionId !== plan.executionId
      || plan.providerPreflightAuthorization.consumptionClaim?.grantDigest
        !== plan.providerPreflightGrant.digest
      || plan.providerPreflightAuthorization.consumptionClaim?.authorizationDigest
        !== plan.providerPreflightAuthorization.authorizationDigest
      || plan.providerPreflightAuthorization.consumptionClaim?.path
        !== 'provider-preflight-consumption-claim.json'
      || !Number.isInteger(Number(plan.providerPreflightAuthorization.consumptionClaim?.bytes))
      || Number(plan.providerPreflightAuthorization.consumptionClaim?.bytes) <= 0
      || !SHA256_PATTERN.test(String(plan.providerPreflightAuthorization.consumptionClaim?.sha256 ?? ''))
      || plan.providerPreflightAuthorization.consumptionClaim?.retryPolicy !== 'new-execution-required'
    ) throw new Error('execution plan provider preflight authorization set is invalid');
    opaqueAuthority(plan.providerPreflightCompletion, 'provider preflight completion authority', (value) => {
      if (
        !SHA256_PATTERN.test(String(value.digest ?? ''))
        || value.grantDigest !== plan.providerPreflightGrant.digest
        || value.authorizationDigest !== plan.providerPreflightAuthorization.authorizationDigest
        || canonicalJson(value.tokenBudget) !== canonicalJson(plan.providerPreflightAuthority.tokenBudget)
        || value.inputTokens !== plan.providerPreflightAuthority.inputTokens
        || value.outputTokens !== plan.providerPreflightAuthority.outputTokens
        || value.audioSeconds !== plan.providerPreflightAuthority.audioSeconds
        || canonicalJson(value.consumptionClaim)
          !== canonicalJson(plan.providerPreflightAuthorization.consumptionClaim)
      ) throw new Error('provider preflight completion authority is invalid');
    });
  }
}

function normalizeWorkers(workers) {
  return workers.map((worker) => {
    const vmIdentity = structuredClone(worker.vmIdentity);
    return {
      workerId: String(worker.workerId),
      ...(String(worker.interactiveUser ?? '').trim()
        ? { interactiveUser: String(worker.interactiveUser).trim() }
        : {}),
      vmIdentity,
      vmIdentityDigest: sha256Canonical(vmIdentity),
      deviceProfileInstances: worker.deviceProfileInstances.map((profile) => ({
        instanceId: String(profile.instanceId),
        profileId: String(profile.profileId),
        deviceClass: String(profile.deviceClass),
        physicalPlaybackDeviceId: String(profile.physicalPlaybackDeviceId),
        expectedPhysicalPlaybackDeviceName: String(profile.expectedPhysicalPlaybackDeviceName ?? ''),
      })),
    };
  });
}

function randomHex(randomBytes, bytes = 16) {
  return Buffer.from(randomBytes(bytes)).toString('hex');
}

export function createWorkerReadinessRequest({
  executionId,
  generatedAt = new Date(),
  provenance,
  runtimeBinaryHashes,
  workers,
  assignments,
}) {
  assertExecutionId(executionId);
  assertCleanProvenance(provenance);
  assertAuthorityInventory(runtimeBinaryHashes, 'worker readiness runtime authority');
  const normalizedWorkers = normalizeWorkers(workers ?? []);
  for (const worker of normalizedWorkers) worker.vmIdentityDigest = sha256Canonical(worker.vmIdentity);
  assertWorkers(normalizedWorkers);
  if (!Array.isArray(assignments) || assignments.length !== LIVE_LLM_CELLS.length) {
    throw new Error('worker readiness request requires all eight fixed cell assignments');
  }
  const assigned = assignments.map((assignment, cellIndex) => {
    const approved = LIVE_LLM_CELLS[cellIndex];
    if (assignment.cellId !== approved.cellId) {
      throw new Error(`worker readiness assignment ${cellIndex} does not match ${approved.cellId}`);
    }
    const worker = normalizedWorkers.find((entry) => entry.workerId === assignment.workerId);
    if (!worker) throw new Error(`worker readiness assignment references unknown worker ${assignment.workerId}`);
    return {
      cellId: approved.cellId,
      workerId: worker.workerId,
      feedbackLoopPrevention: approved.feedbackLoopPrevention,
      deviceClass: approved.deviceClass,
    };
  });
  const core = {
    schemaVersion: SHARD_AUTHORITY_SCHEMA_VERSION,
    artifactKind: SHARD_WORKER_READINESS_REQUEST_KIND,
    generatedAt: generatedAt instanceof Date ? generatedAt.toISOString() : String(generatedAt),
    executionId,
    provenance: structuredClone(provenance),
    runtimeBinaryHashes: sortedInventory(runtimeBinaryHashes),
    runtimeBundleDigest: authorityInventoryDigest(runtimeBinaryHashes),
    workers: normalizedWorkers.map((worker) => ({
      ...worker,
      driverRequired: assigned.some((cell) => (
        cell.workerId === worker.workerId && cell.feedbackLoopPrevention === 'virtual-driver'
      )),
    })),
    assignments: assigned,
  };
  assertIsoDate(core.generatedAt, 'worker readiness request generatedAt');
  return { ...core, requestDigest: sha256Canonical(core) };
}

export function validateWorkerReadinessRequest(request, expected = {}) {
  assertObject(request, 'worker readiness request');
  if (
    request.schemaVersion !== SHARD_AUTHORITY_SCHEMA_VERSION
    || request.artifactKind !== SHARD_WORKER_READINESS_REQUEST_KIND
  ) throw new Error('unsupported worker readiness request');
  const { requestDigest, ...core } = request;
  if (requestDigest !== sha256Canonical(core)) throw new Error('worker readiness request digest mismatch');
  assertExecutionId(request.executionId);
  assertIsoDate(request.generatedAt, 'worker readiness request generatedAt');
  assertCleanProvenance(request.provenance, 'worker readiness request provenance');
  assertAuthorityInventory(request.runtimeBinaryHashes, 'worker readiness request runtime authority');
  if (request.runtimeBundleDigest !== authorityInventoryDigest(request.runtimeBinaryHashes)) {
    throw new Error('worker readiness request runtime bundle digest mismatch');
  }
  assertWorkers(request.workers);
  for (const worker of request.workers) {
    if (worker.vmIdentityDigest !== sha256Canonical(worker.vmIdentity)) {
      throw new Error(`worker readiness request VM identity digest mismatch for ${worker.workerId}`);
    }
    const expectedDriverRequired = request.assignments?.some((cell) => (
      cell.workerId === worker.workerId && cell.feedbackLoopPrevention === 'virtual-driver'
    ));
    if (worker.driverRequired !== expectedDriverRequired) {
      throw new Error(`worker readiness request driverRequired mismatch for ${worker.workerId}`);
    }
  }
  if (expected.executionId && request.executionId !== expected.executionId) {
    throw new Error('worker readiness request executionId mismatch');
  }
  if (expected.provenance && canonicalJson(request.provenance) !== canonicalJson(expected.provenance)) {
    throw new Error('worker readiness request provenance mismatch');
  }
  if (
    expected.runtimeBinaryHashes
    && !sameAuthorityInventory(request.runtimeBinaryHashes, expected.runtimeBinaryHashes)
  ) throw new Error('worker readiness request runtime inventory mismatch');
  if (expected.workers) {
    const normalized = normalizeWorkers(expected.workers);
    for (const worker of normalized) worker.vmIdentityDigest = sha256Canonical(worker.vmIdentity);
    const strippedRequestWorkers = request.workers.map(({ driverRequired, ...worker }) => worker);
    if (canonicalJson(strippedRequestWorkers) !== canonicalJson(normalized)) {
      throw new Error('worker readiness request worker/profile inventory mismatch');
    }
  }
  if (expected.assignments) {
    const projected = expected.assignments.map((assignment, cellIndex) => ({
      cellId: LIVE_LLM_CELLS[cellIndex].cellId,
      workerId: assignment.workerId,
      feedbackLoopPrevention: LIVE_LLM_CELLS[cellIndex].feedbackLoopPrevention,
      deviceClass: LIVE_LLM_CELLS[cellIndex].deviceClass,
    }));
    if (canonicalJson(request.assignments) !== canonicalJson(projected)) {
      throw new Error('worker readiness request cell assignment mismatch');
    }
  }
  return request;
}

export function createSignedExecutionPlan({
  executionId = `watch-shard-${crypto.randomUUID()}`,
  generatedAt = new Date(),
  expiresAt = new Date((generatedAt instanceof Date ? generatedAt.getTime() : Date.parse(generatedAt)) + 86_400_000),
  provenance,
  authorityImplementationHashes,
  runtimeBinaryHashes,
  shardOrchestrationImplementationHashes = currentShardOrchestrationImplementationHashes(),
  localIsolationAuthority,
  providerPreflightAuthority,
  providerPreflightGrant = null,
  providerPreflightLeaseReservations = null,
  providerPreflightAuthorization = null,
  providerPreflightCompletion = null,
  workerReadinessRequest = null,
  workers,
  assignments,
  publicKeyPem,
  privateKeyPem,
  randomBytes = crypto.randomBytes,
}) {
  assertExecutionId(executionId);
  assertCleanProvenance(provenance);
  assertAuthorityInventory(authorityImplementationHashes, 'matrix implementation authority');
  assertAuthorityInventory(runtimeBinaryHashes, 'runtime binary authority');
  assertAuthorityInventory(shardOrchestrationImplementationHashes, 'shard orchestration implementation authority');
  const normalizedWorkers = normalizeWorkers(workers ?? []);
  for (const [index, worker] of normalizedWorkers.entries()) worker.vmIdentityDigest = sha256Canonical(worker.vmIdentity);
  assertWorkers(normalizedWorkers);
  if (workerReadinessRequest) {
    validateWorkerReadinessRequest(workerReadinessRequest, {
      executionId,
      provenance,
      runtimeBinaryHashes,
      workers: normalizedWorkers,
      assignments,
    });
    const requestGeneratedAt = assertIsoDate(
      workerReadinessRequest.generatedAt,
      'worker readiness request generatedAt',
    );
    const planGeneratedAt = generatedAt instanceof Date ? generatedAt.getTime() : Date.parse(generatedAt);
    if (requestGeneratedAt > planGeneratedAt) {
      throw new Error('worker readiness request must precede the signed execution plan');
    }
  }
  if (!Array.isArray(assignments) || assignments.length !== LIVE_LLM_CELLS.length) {
    throw new Error(`shard assignments must contain exactly ${LIVE_LLM_CELLS.length} cells`);
  }
  if (!publicKeyPem || !privateKeyPem) throw new Error('coordinator signing key pair is required');
  const derivedPublic = crypto.createPublicKey(crypto.createPrivateKey(privateKeyPem))
    .export({ type: 'spki', format: 'pem' }).toString();
  if (keyIdForPublicKey(derivedPublic) !== keyIdForPublicKey(publicKeyPem)) {
    throw new Error('coordinator public/private signing keys do not match');
  }
  const workerById = new Map(normalizedWorkers.map((worker) => [worker.workerId, worker]));
  const assignedIds = new Set();
  const workerWaveSlots = new Set();
  const plannedCells = LIVE_LLM_CELLS.map((approvedCell, cellIndex) => {
    const assignment = assignments[cellIndex];
    if (assignment?.cellId !== approvedCell.cellId) {
      throw new Error(`shard assignment ${cellIndex} must be for ${approvedCell.cellId}`);
    }
    if (assignedIds.has(assignment.cellId)) throw new Error(`duplicate assignment ${assignment.cellId}`);
    assignedIds.add(assignment.cellId);
    const worker = workerById.get(String(assignment.workerId));
    if (!worker) throw new Error(`assignment ${assignment.cellId} references unknown worker ${assignment.workerId}`);
    const waveIndex = Number(assignment.waveIndex);
    if (!Number.isInteger(waveIndex) || waveIndex < 0) throw new Error(`assignment ${assignment.cellId} has invalid waveIndex`);
    const workerWaveSlot = `${worker.workerId}::${waveIndex}`;
    if (workerWaveSlots.has(workerWaveSlot)) {
      throw new Error(`worker ${worker.workerId} has more than one cell in wave ${waveIndex}`);
    }
    workerWaveSlots.add(workerWaveSlot);
    const profile = worker.deviceProfileInstances.find((entry) => entry.instanceId === assignment.deviceProfileInstanceId);
    if (!profile) throw new Error(`assignment ${assignment.cellId} references an unknown profile instance`);
    if (profile.deviceClass !== approvedCell.deviceClass) {
      throw new Error(`assignment ${assignment.cellId} profile class does not match ${approvedCell.deviceClass}`);
    }
    return {
      cellIndex,
      ...approvedCellProjection(approvedCell),
      workerId: worker.workerId,
      vmIdentityDigest: worker.vmIdentityDigest,
      waveIndex,
      deviceProfileInstance: structuredClone(profile),
      deviceProfileInstanceDigest: sha256Canonical(profile),
      leaseId: assignment.leaseId ?? `lease-${randomHex(randomBytes)}`,
      maxExternalAudioSamples: SHARD_CELL_MAX_EXTERNAL_AUDIO_SAMPLES,
      inputSampleRateHz: SHARD_INPUT_SAMPLE_RATE_HZ,
    };
  });
  const waveIndices = [...new Set(plannedCells.map((cell) => cell.waveIndex))].sort((a, b) => a - b);
  if (waveIndices.some((value, index) => value !== index)) throw new Error('shard waves must be contiguous from zero');
  const waves = waveIndices.map((waveIndex) => ({
    waveIndex,
    cellIds: plannedCells.filter((cell) => cell.waveIndex === waveIndex)
      .sort((left, right) => left.cellIndex - right.cellIndex)
      .map((cell) => cell.cellId),
  }));
  const generatedAtIso = generatedAt instanceof Date ? generatedAt.toISOString() : String(generatedAt);
  const expiresAtIso = expiresAt instanceof Date ? expiresAt.toISOString() : String(expiresAt);
  if (assertIsoDate(expiresAtIso, 'execution plan expiresAt') <= assertIsoDate(generatedAtIso, 'execution plan generatedAt')) {
    throw new Error('execution plan expiresAt must be later than generatedAt');
  }
  const keyId = keyIdForPublicKey(publicKeyPem);
  const core = {
    schemaVersion: SHARD_AUTHORITY_SCHEMA_VERSION,
    artifactKind: SHARD_EXECUTION_PLAN_KIND,
    executionId,
    generatedAt: generatedAtIso,
    expiresAt: expiresAtIso,
    provenance: structuredClone(provenance),
    validationPlan: {
      schemaVersion: BALANCED_RELEASE_PLAN.schemaVersion,
      planId: BALANCED_RELEASE_PLAN.planId,
      sha256: sha256Canonical(BALANCED_RELEASE_PLAN),
    },
    authority: {
      implementationHashes: sortedInventory(authorityImplementationHashes),
      runtimeBinaryHashes: sortedInventory(runtimeBinaryHashes),
      runtimeBundleDigest: authorityInventoryDigest(runtimeBinaryHashes),
      shardOrchestrationImplementationHashes: sortedInventory(shardOrchestrationImplementationHashes),
      shardOrchestrationDigest: authorityInventoryDigest(shardOrchestrationImplementationHashes),
    },
    localIsolationAuthority: structuredClone(localIsolationAuthority),
    providerPreflightAuthority: structuredClone(providerPreflightAuthority),
    providerIdentity: structuredClone(SHARD_STRICT_PAID_PROVIDER_IDENTITY),
    ...(providerPreflightGrant
      ? { providerPreflightGrant: structuredClone(providerPreflightGrant) }
      : {}),
    ...(providerPreflightLeaseReservations
      ? { providerPreflightLeaseReservations: structuredClone(providerPreflightLeaseReservations) }
      : {}),
    ...(providerPreflightAuthorization
      ? { providerPreflightAuthorization: structuredClone(providerPreflightAuthorization) }
      : {}),
    ...(providerPreflightCompletion
      ? { providerPreflightCompletion: structuredClone(providerPreflightCompletion) }
      : {}),
    ...(workerReadinessRequest
      ? { workerReadinessRequest: structuredClone(workerReadinessRequest) }
      : {}),
    coordinator: { keyId, publicKeyPem: String(publicKeyPem) },
    budget: {
      allocationMode: 'immutable-disjoint-cell-leases',
      inputSampleRateHz: SHARD_INPUT_SAMPLE_RATE_HZ,
      cellMaxExternalAudioSamples: SHARD_CELL_MAX_EXTERNAL_AUDIO_SAMPLES,
      cellMaxExternalAudioSeconds: SHARD_CELL_MAX_EXTERNAL_AUDIO_SECONDS,
      matrixMaxExternalAudioSamples: SHARD_MATRIX_MAX_EXTERNAL_AUDIO_SAMPLES,
      matrixMaxExternalAudioSeconds: SHARD_MATRIX_MAX_EXTERNAL_AUDIO_SECONDS,
      allocatedExternalAudioSamples: plannedCells.length * SHARD_CELL_MAX_EXTERNAL_AUDIO_SAMPLES,
      cellCount: plannedCells.length,
      reclaimPolicy: 'never-within-execution',
      retryPolicy: 'new-execution-required',
    },
    workers: normalizedWorkers,
    waves,
    cells: plannedCells,
  };
  assertBoundPrerequisites(core);
  const planDigest = sha256Canonical(core);
  const signed = { ...core, planDigest };
  return { ...signed, signature: signPayload(signed, privateKeyPem, keyId) };
}

export function verifySignedExecutionPlan(plan, {
  now = new Date(),
  checkExpiry = true,
  currentProvenance = null,
  currentAuthorityImplementationHashes = null,
  currentRuntimeBinaryHashes = null,
  currentShardImplementationHashes = null,
} = {}) {
  assertObject(plan, 'shard execution plan');
  if (plan.schemaVersion !== SHARD_AUTHORITY_SCHEMA_VERSION || plan.artifactKind !== SHARD_EXECUTION_PLAN_KIND) {
    throw new Error('unsupported shard execution plan schema/kind');
  }
  assertExecutionId(plan.executionId);
  assertCleanProvenance(plan.provenance);
  if (
    plan.validationPlan?.schemaVersion !== BALANCED_RELEASE_PLAN.schemaVersion
    || plan.validationPlan?.planId !== BALANCED_RELEASE_PLAN.planId
    || plan.validationPlan?.sha256 !== sha256Canonical(BALANCED_RELEASE_PLAN)
  ) throw new Error('shard execution plan does not bind the current exact balanced release plan');
  const { signature, planDigest, ...core } = plan;
  if (!SHA256_PATTERN.test(String(planDigest ?? '')) || planDigest !== sha256Canonical(core)) {
    throw new Error('shard execution plan digest mismatch');
  }
  if (plan.coordinator?.keyId !== keyIdForPublicKey(plan.coordinator?.publicKeyPem)) {
    throw new Error('shard execution plan coordinator key identity mismatch');
  }
  verifyPayloadSignature({ ...core, planDigest }, signature, plan.coordinator.publicKeyPem, 'shard execution plan');
  const generatedAtMs = assertIsoDate(plan.generatedAt, 'execution plan generatedAt');
  const expiresAtMs = assertIsoDate(plan.expiresAt, 'execution plan expiresAt');
  if (expiresAtMs <= generatedAtMs) throw new Error('shard execution plan time window is inverted');
  if (checkExpiry && Number(now instanceof Date ? now.getTime() : now) > expiresAtMs) {
    throw new Error('shard execution plan has expired');
  }
  assertWorkers(plan.workers);
  assertExactPaidCells(plan.cells);
  const workerById = new Map(plan.workers.map((worker) => [worker.workerId, worker]));
  const cellIds = new Set();
  const leases = new Set();
  const workerWaveSlots = new Set();
  for (const [index, cell] of plan.cells.entries()) {
    if (Number(cell.cellIndex) !== index) throw new Error(`shard execution cell ${index} has invalid cellIndex`);
    if (cellIds.has(cell.cellId)) throw new Error(`duplicate shard cell ${cell.cellId}`);
    cellIds.add(cell.cellId);
    assertIdentifier(cell.leaseId, `shard cell ${index} leaseId`);
    if (leases.has(cell.leaseId)) throw new Error(`duplicate shard leaseId ${cell.leaseId}`);
    leases.add(cell.leaseId);
    const worker = workerById.get(cell.workerId);
    if (!worker || cell.vmIdentityDigest !== worker.vmIdentityDigest) throw new Error(`shard cell ${index} worker/VM binding mismatch`);
    const profile = worker.deviceProfileInstances.find((entry) => entry.instanceId === cell.deviceProfileInstance?.instanceId);
    if (
      !profile
      || canonicalJson(profile) !== canonicalJson(cell.deviceProfileInstance)
      || cell.deviceProfileInstanceDigest !== sha256Canonical(profile)
      || profile.deviceClass !== cell.deviceClass
    ) throw new Error(`shard cell ${index} device profile binding mismatch`);
    if (Number(cell.maxExternalAudioSamples) !== SHARD_CELL_MAX_EXTERNAL_AUDIO_SAMPLES || Number(cell.inputSampleRateHz) !== SHARD_INPUT_SAMPLE_RATE_HZ) {
      throw new Error(`shard cell ${index} does not have the fixed external audio lease`);
    }
    const slot = `${cell.workerId}::${cell.waveIndex}`;
    if (workerWaveSlots.has(slot)) throw new Error(`worker ${cell.workerId} has two cells in wave ${cell.waveIndex}`);
    workerWaveSlots.add(slot);
  }
  const expectedWaves = [...new Set(plan.cells.map((cell) => Number(cell.waveIndex)))].sort((a, b) => a - b);
  if (
    !Array.isArray(plan.waves)
    || plan.waves.length !== expectedWaves.length
    || expectedWaves.some((wave, index) => wave !== index)
  ) throw new Error('shard execution plan waves are missing or non-contiguous');
  for (const [waveIndex, wave] of plan.waves.entries()) {
    const expected = plan.cells.filter((cell) => cell.waveIndex === waveIndex)
      .sort((left, right) => left.cellIndex - right.cellIndex).map((cell) => cell.cellId);
    if (wave.waveIndex !== waveIndex || canonicalJson(wave.cellIds) !== canonicalJson(expected)) {
      throw new Error(`shard execution wave ${waveIndex} does not match cell assignments`);
    }
  }
  assertAuthorityInventory(plan.authority?.implementationHashes, 'plan matrix implementation authority');
  assertAuthorityInventory(plan.authority?.runtimeBinaryHashes, 'plan runtime authority');
  assertAuthorityInventory(plan.authority?.shardOrchestrationImplementationHashes, 'plan shard implementation authority');
  if (plan.authority.runtimeBundleDigest !== authorityInventoryDigest(plan.authority.runtimeBinaryHashes)) {
    throw new Error('shard execution runtime bundle digest mismatch');
  }
  if (plan.workerReadinessRequest) {
    validateWorkerReadinessRequest(plan.workerReadinessRequest, {
      executionId: plan.executionId,
      provenance: plan.provenance,
      runtimeBinaryHashes: plan.authority.runtimeBinaryHashes,
      workers: plan.workers,
      assignments: plan.cells,
    });
    if (Date.parse(plan.workerReadinessRequest.generatedAt) > generatedAtMs) {
      throw new Error('worker readiness request timestamp is later than the signed execution plan');
    }
  }
  if (plan.authority.shardOrchestrationDigest !== authorityInventoryDigest(plan.authority.shardOrchestrationImplementationHashes)) {
    throw new Error('shard execution orchestration digest mismatch');
  }
  if (
    plan.budget?.allocationMode !== 'immutable-disjoint-cell-leases'
    || Number(plan.budget.inputSampleRateHz) !== SHARD_INPUT_SAMPLE_RATE_HZ
    || Number(plan.budget.cellMaxExternalAudioSamples) !== SHARD_CELL_MAX_EXTERNAL_AUDIO_SAMPLES
    || Number(plan.budget.matrixMaxExternalAudioSamples) !== SHARD_MATRIX_MAX_EXTERNAL_AUDIO_SAMPLES
    || Number(plan.budget.allocatedExternalAudioSamples) !== SHARD_MATRIX_MAX_EXTERNAL_AUDIO_SAMPLES
    || Number(plan.budget.cellCount) !== SHARD_MATRIX_CELL_COUNT
    || plan.budget.reclaimPolicy !== 'never-within-execution'
    || plan.budget.retryPolicy !== 'new-execution-required'
  ) throw new Error('shard execution plan budget is not the fixed fail-closed 24-minute allocation');
  assertBoundPrerequisites(plan);
  if (currentProvenance && canonicalJson(currentProvenance) !== canonicalJson(plan.provenance)) {
    throw new Error('worker/coordinator source provenance does not exactly match the execution plan');
  }
  if (currentAuthorityImplementationHashes && !sameAuthorityInventory(currentAuthorityImplementationHashes, plan.authority.implementationHashes)) {
    throw new Error('current matrix implementation hashes do not match the execution plan');
  }
  if (currentRuntimeBinaryHashes && !sameAuthorityInventory(currentRuntimeBinaryHashes, plan.authority.runtimeBinaryHashes)) {
    throw new Error('current runtime binary hashes do not match the execution plan');
  }
  if (currentShardImplementationHashes && !sameAuthorityInventory(currentShardImplementationHashes, plan.authority.shardOrchestrationImplementationHashes)) {
    throw new Error('current shard implementation hashes do not match the execution plan');
  }
  return plan;
}

export function issueCellLeases(plan, privateKeyPem, { issuedAt = new Date() } = {}) {
  verifySignedExecutionPlan(plan, { now: issuedAt });
  const derivedPublic = crypto.createPublicKey(crypto.createPrivateKey(privateKeyPem))
    .export({ type: 'spki', format: 'pem' }).toString();
  if (keyIdForPublicKey(derivedPublic) !== plan.coordinator.keyId) {
    throw new Error('cell lease signer does not match the execution plan coordinator key');
  }
  const issuedAtIso = issuedAt instanceof Date ? issuedAt.toISOString() : String(issuedAt);
  return plan.cells.map((cell) => {
    const core = {
      schemaVersion: SHARD_AUTHORITY_SCHEMA_VERSION,
      artifactKind: SHARD_CELL_LEASE_KIND,
      issuedAt: issuedAtIso,
      expiresAt: plan.expiresAt,
      executionId: plan.executionId,
      planDigest: plan.planDigest,
      leaseId: cell.leaseId,
      cellIndex: cell.cellIndex,
      cellId: cell.cellId,
      workerId: cell.workerId,
      vmIdentityDigest: cell.vmIdentityDigest,
      waveIndex: cell.waveIndex,
      deviceProfileInstanceDigest: cell.deviceProfileInstanceDigest,
      sourceHeadCommit: plan.provenance.headCommit,
      runtimeBundleDigest: plan.authority.runtimeBundleDigest,
      inputSampleRateHz: SHARD_INPUT_SAMPLE_RATE_HZ,
      maxExternalAudioSamples: SHARD_CELL_MAX_EXTERNAL_AUDIO_SAMPLES,
      reclaimPolicy: 'never-within-execution',
      retryPolicy: 'new-execution-required',
    };
    const leaseDigest = sha256Canonical(core);
    const signed = { ...core, leaseDigest };
    return { ...signed, signature: signPayload(signed, privateKeyPem, plan.coordinator.keyId) };
  });
}

export function verifyCellLease(lease, plan, { now = new Date(), checkExpiry = true } = {}) {
  verifySignedExecutionPlan(plan, { now, checkExpiry });
  if (lease?.schemaVersion !== SHARD_AUTHORITY_SCHEMA_VERSION || lease?.artifactKind !== SHARD_CELL_LEASE_KIND) {
    throw new Error('unsupported shard cell lease schema/kind');
  }
  const { signature, leaseDigest, ...core } = lease;
  if (!SHA256_PATTERN.test(String(leaseDigest ?? '')) || leaseDigest !== sha256Canonical(core)) {
    throw new Error('shard cell lease digest mismatch');
  }
  verifyPayloadSignature({ ...core, leaseDigest }, signature, plan.coordinator.publicKeyPem, 'shard cell lease');
  const cell = plan.cells[Number(lease.cellIndex)];
  if (!cell) throw new Error('shard cell lease references an unknown cell index');
  const exact = {
    executionId: plan.executionId,
    planDigest: plan.planDigest,
    leaseId: cell.leaseId,
    cellIndex: cell.cellIndex,
    cellId: cell.cellId,
    workerId: cell.workerId,
    vmIdentityDigest: cell.vmIdentityDigest,
    waveIndex: cell.waveIndex,
    deviceProfileInstanceDigest: cell.deviceProfileInstanceDigest,
    sourceHeadCommit: plan.provenance.headCommit,
    runtimeBundleDigest: plan.authority.runtimeBundleDigest,
    inputSampleRateHz: SHARD_INPUT_SAMPLE_RATE_HZ,
    maxExternalAudioSamples: SHARD_CELL_MAX_EXTERNAL_AUDIO_SAMPLES,
    reclaimPolicy: 'never-within-execution',
    retryPolicy: 'new-execution-required',
  };
  for (const [key, expected] of Object.entries(exact)) {
    if (lease[key] !== expected) throw new Error(`shard cell lease ${key} does not match the execution plan`);
  }
  if (lease.expiresAt !== plan.expiresAt) throw new Error('shard cell lease expiry does not match the execution plan');
  const issuedAtMs = assertIsoDate(lease.issuedAt, 'cell lease issuedAt');
  const expiresAtMs = assertIsoDate(lease.expiresAt, 'cell lease expiresAt');
  if (issuedAtMs < Date.parse(plan.generatedAt) || issuedAtMs >= expiresAtMs) {
    throw new Error('shard cell lease issuance time is outside the execution window');
  }
  if (checkExpiry && Number(now instanceof Date ? now.getTime() : now) > expiresAtMs) {
    throw new Error('shard cell lease has expired');
  }
  return cell;
}

function readJson(filePath, label) {
  assertRegularFile(filePath, label);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function readJsonLines(filePath, label) {
  assertRegularFile(filePath, label);
  const lines = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) throw new Error(`${label} is empty`);
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`${label} line ${index + 1} is not JSON: ${error.message}`);
    }
  });
}

function assertProviderIdentity(value, expected, label) {
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (value?.[key] !== expectedValue) throw new Error(`${label} ${key} mismatch`);
  }
}

export function validateProviderUsageAuthority(runDirectory, { cell, lease }) {
  const resolvedRunDirectory = path.resolve(runDirectory);
  const ledgerPath = path.join(resolvedRunDirectory, PROVIDER_INPUT_BUDGET_LEDGER_FILE);
  const journalPath = path.join(resolvedRunDirectory, PROVIDER_INPUT_BUDGET_JOURNAL_FILE);
  const launchLeasePath = path.join(resolvedRunDirectory, PROVIDER_INPUT_BUDGET_LEASE_FILE);
  const ledger = readJson(ledgerPath, 'provider input budget ledger');
  const journal = readJsonLines(journalPath, 'provider input budget journal');
  const launchLease = readJson(launchLeasePath, 'provider input launch lease');
  const expectedIdentity = {
    schemaVersion: PROVIDER_INPUT_BUDGET_LEDGER_SCHEMA_VERSION,
    artifactKind: PROVIDER_INPUT_BUDGET_LEDGER_KIND,
    cellId: cell.cellId,
    leaseId: lease.leaseId,
    direction: 'inbound',
    model: cell.modelId,
    protocol: SHARD_STRICT_PAID_MODEL_PROTOCOLS[cell.modelId],
    ...SHARD_STRICT_PAID_PROVIDER_IDENTITY,
  };
  assertProviderIdentity(ledger, expectedIdentity, 'provider input budget ledger');
  if (!String(ledger.runMarker ?? '').trim()) throw new Error('provider input budget ledger runMarker is missing');
  if (!Number.isInteger(Number(ledger.sessionGeneration)) || Number(ledger.sessionGeneration) < 0) {
    throw new Error('provider input budget ledger sessionGeneration is invalid');
  }
  if (!expectedIdentity.protocol) throw new Error(`shard cell ${cell.cellId} has no approved realtime model/protocol mapping`);
  assertProviderIdentity(launchLease, {
    schemaVersion: PROVIDER_INPUT_BUDGET_LEDGER_SCHEMA_VERSION,
    artifactKind: PROVIDER_INPUT_BUDGET_LEASE_KIND,
    cellId: cell.cellId,
    leaseId: lease.leaseId,
    runMarker: ledger.runMarker,
    maxSamples: SHARD_CELL_MAX_EXTERNAL_AUDIO_SAMPLES,
  }, 'provider input launch lease');
  if (Number(ledger.maxSamples) !== SHARD_CELL_MAX_EXTERNAL_AUDIO_SAMPLES || Number(ledger.maxSamples) !== lease.maxExternalAudioSamples) {
    throw new Error('provider input budget ledger maxSamples does not match the signed cell lease');
  }
  const actualSamples = Number(ledger.totalAttemptedSamples);
  if (!Number.isSafeInteger(actualSamples) || actualSamples <= 0 || actualSamples > SHARD_CELL_MAX_EXTERNAL_AUDIO_SAMPLES) {
    throw new Error('provider input budget ledger totalAttemptedSamples is outside the signed cell lease');
  }
  const appendAttempts = Number(ledger.appendAttempts);
  if (!Number.isSafeInteger(appendAttempts) || appendAttempts <= 0) {
    throw new Error('provider input budget ledger appendAttempts must be positive');
  }
  if (
    Number(ledger.sendFailures) !== 0
    || Number(ledger.initialConnectAttempts) !== 1
    || Number(ledger.reconnects) !== 0
    || ledger.budgetExceeded !== false
    || ledger.finalized !== true
    || ledger.terminalReason !== 'worker-completed'
  ) throw new Error('provider input budget ledger is not a strict terminal success');
  const journalIdentity = {
    ...expectedIdentity,
    runMarker: ledger.runMarker,
    sessionGeneration: ledger.sessionGeneration,
  };
  const counts = Object.fromEntries([...ALLOWED_JOURNAL_EVENTS].map((event) => [event, 0]));
  let reservedSamples = 0;
  let observedInitialConnectAttempts = 0;
  for (const [index, event] of journal.entries()) {
    if (!ALLOWED_JOURNAL_EVENTS.has(event?.event)) {
      throw new Error(`provider input budget journal has unknown event at sequence ${index + 1}`);
    }
    if (Number(event.sequence) !== index + 1) {
      throw new Error(`provider input budget journal sequence mismatch at ${index + 1}`);
    }
    assertProviderIdentity(event, journalIdentity, `provider input budget journal sequence ${index + 1}`);
    counts[event.event] += 1;
    const initialConnectAttempts = Number(event.initialConnectAttempts);
    if (!Number.isSafeInteger(initialConnectAttempts) || initialConnectAttempts < 0 || initialConnectAttempts > 1) {
      throw new Error(`provider input budget journal initialConnectAttempts is invalid at sequence ${index + 1}`);
    }
    if (event.event === 'initial_connect_attempt') {
      observedInitialConnectAttempts += 1;
      if (index !== 1 || initialConnectAttempts !== 1) {
        throw new Error('provider input budget initial_connect_attempt must immediately follow initialized and set the count to one');
      }
    } else if (initialConnectAttempts !== observedInitialConnectAttempts) {
      throw new Error(`provider input budget journal initialConnectAttempts is non-monotonic at sequence ${index + 1}`);
    }
    if (event.event === 'reserved') {
      const samples = Number(event.attemptedSamples);
      if (!Number.isSafeInteger(samples) || samples <= 0) {
        throw new Error(`provider input budget journal reserved event ${index + 1} has invalid attemptedSamples`);
      }
      reservedSamples += samples;
    }
  }
  if (journal[0]?.event !== 'initialized' || counts.initialized !== 1) {
    throw new Error('provider input budget journal must begin with exactly one initialized event');
  }
  if (counts.initial_connect_attempt !== 1) {
    throw new Error('provider input budget journal must contain exactly one initial_connect_attempt event');
  }
  if (journal.at(-1)?.event !== 'finalized' || journal.at(-1)?.finalized !== true || counts.finalized !== 1) {
    throw new Error('provider input budget journal must end with exactly one finalized event');
  }
  if (counts.reserved < 1 || counts.reserved !== appendAttempts || reservedSamples !== actualSamples) {
    throw new Error('provider input budget journal reserved events do not match the final ledger');
  }
  for (const forbidden of ['reserve_rejected', 'send_failed', 'reconnect']) {
    if (counts[forbidden] !== 0) throw new Error(`provider input budget journal contains forbidden ${forbidden}`);
  }
  const ledgerAuthority = fileAuthorityEntry(ledgerPath, PROVIDER_INPUT_BUDGET_LEDGER_FILE);
  const journalAuthority = fileAuthorityEntry(journalPath, PROVIDER_INPUT_BUDGET_JOURNAL_FILE);
  const launchLeaseAuthority = fileAuthorityEntry(launchLeasePath, PROVIDER_INPUT_BUDGET_LEASE_FILE);
  return {
    ...ledgerAuthority,
    journalPath: journalAuthority.path,
    journalBytes: journalAuthority.bytes,
    journalSha256: journalAuthority.sha256,
    journalEventCount: journal.length,
    launchLeasePath: launchLeaseAuthority.path,
    launchLeaseBytes: launchLeaseAuthority.bytes,
    launchLeaseSha256: launchLeaseAuthority.sha256,
    schemaVersion: ledger.schemaVersion,
    artifactKind: ledger.artifactKind,
    cellId: ledger.cellId,
    leaseId: ledger.leaseId,
    runMarker: ledger.runMarker,
    sessionGeneration: ledger.sessionGeneration,
    direction: ledger.direction,
    model: ledger.model,
    protocol: ledger.protocol,
    strictPaidAuthority: ledger.strictPaidAuthority,
    providerId: ledger.providerId,
    templateId: ledger.templateId,
    providerKind: ledger.providerKind,
    endpointHost: ledger.endpointHost,
    credentialReference: ledger.credentialReference,
    authHeaderName: ledger.authHeaderName,
    authScheme: ledger.authScheme,
    customHeaderCount: Number(ledger.customHeaderCount),
    actualExternalAudioSamples: actualSamples,
    maxExternalAudioSamples: Number(ledger.maxSamples),
    appendAttempts,
    initialConnectAttempts: Number(ledger.initialConnectAttempts),
    terminalStatus: ledger.terminalReason,
    finalized: ledger.finalized,
  };
}

function readDeviceAuthority(runDirectory, cell) {
  const relativePath = 'physical-playback-device.json';
  const filePath = path.join(runDirectory, relativePath);
  const device = readJson(filePath, 'physical playback device authority');
  const planned = cell.deviceProfileInstance;
  if (
    device.profileId !== planned.profileId
    || device.deviceClass !== cell.deviceClass
    || device.requestedDeviceId !== planned.physicalPlaybackDeviceId
    || !String(device.resolvedDeviceId ?? '').trim()
    || !String(device.resolvedDeviceName ?? '').trim()
    || device.verified !== true
    || device.fixtureOnly !== false
  ) throw new Error(`physical playback device does not match shard cell ${cell.cellId}`);
  if (
    planned.expectedPhysicalPlaybackDeviceName
    && device.resolvedDeviceName !== planned.expectedPhysicalPlaybackDeviceName
  ) throw new Error(`physical playback device name does not match shard profile ${planned.profileId}`);
  return {
    ...fileAuthorityEntry(filePath, relativePath),
    instanceId: planned.instanceId,
    profileId: device.profileId,
    deviceClass: device.deviceClass,
    requestedDeviceId: device.requestedDeviceId,
    resolvedDeviceId: device.resolvedDeviceId,
    resolvedDeviceName: device.resolvedDeviceName,
    classificationSource: device.classificationSource ?? null,
    routeEvidenceSource: device.routeEvidenceSource ?? null,
  };
}

function runtimeEntry(runtimeBinaryHashes, entryPath, label) {
  const entry = runtimeBinaryHashes.find((candidate) => candidate.path === entryPath);
  if (!entry) throw new Error(`runtime authority is missing ${label}`);
  return entry;
}

export function validateWorkerZeroProviderReadinessAuthority({
  receiptPath,
  plan = null,
  request = plan?.workerReadinessRequest,
  workerId,
  now = new Date(),
  authorityPath = SHARD_WORKER_READINESS_FILE,
}) {
  const checkedRequest = validateWorkerReadinessRequest(request, plan ? {
    executionId: plan.executionId,
    provenance: plan.provenance,
    runtimeBinaryHashes: plan.authority.runtimeBinaryHashes,
    workers: plan.workers,
    assignments: plan.cells,
  } : {});
  const worker = checkedRequest.workers.find((entry) => entry.workerId === workerId);
  if (!worker) throw new Error(`worker readiness receipt references unknown worker ${workerId}`);
  const receipt = readJson(receiptPath, 'worker zero-provider readiness receipt');
  if (
    receipt.schemaVersion !== SHARD_AUTHORITY_SCHEMA_VERSION
    || receipt.artifactKind !== SHARD_WORKER_READINESS_KIND
    || receipt.executionId !== checkedRequest.executionId
    || receipt.readinessRequestDigest !== checkedRequest.requestDigest
    || receipt.workerId !== worker.workerId
    || receipt.vmIdentityDigest !== worker.vmIdentityDigest
    || receipt.runtimeBundleDigest !== checkedRequest.runtimeBundleDigest
    || Number(receipt.providerCalls) !== 0
  ) throw new Error('worker zero-provider readiness receipt identity/budget binding mismatch');
  const generatedAtMs = assertIsoDate(receipt.generatedAt, 'worker zero-provider readiness generatedAt');
  const requestAtMs = assertIsoDate(checkedRequest.generatedAt, 'worker readiness request generatedAt');
  const nowMs = Number(now instanceof Date ? now.getTime() : now);
  if (generatedAtMs < requestAtMs || generatedAtMs > nowMs + 300_000) {
    throw new Error('worker zero-provider readiness receipt timestamp is outside its request window');
  }
  const runtime = checkedRequest.runtimeBinaryHashes;
  const sys = runtimeEntry(runtime, 'drivers/windows-virtual-mic/package/omni-virtual-speaker.sys', 'driver SYS');
  const cat = runtimeEntry(runtime, 'drivers/windows-virtual-mic/package/omni-virtual-speaker.cat', 'driver CAT');
  const inf = runtimeEntry(runtime, 'drivers/windows-virtual-mic/package/omni-virtual-speaker.inf', 'driver INF');
  const driver = assertObject(receipt.driver, 'worker readiness installed driver authority');
  const driverRequired = Boolean(worker.driverRequired);
  if (receipt.driverRequired !== driverRequired) {
    throw new Error('worker readiness driverRequired does not match its signed cell assignments');
  }
  if (
    (driverRequired && (
      String(driver.installedServiceState ?? '').toLowerCase() !== 'running'
      || String(driver.installedSysSha256 ?? '').toLowerCase() !== sys.sha256
      || String(driver.installedSysSignatureStatus ?? '').toLowerCase() !== 'valid'
      || String(driver.packageCatalogSignatureStatus ?? '').toLowerCase() !== 'valid'
    ))
    || (!driverRequired && String(driver.installedServiceState ?? '').toLowerCase() !== 'not-required')
    || String(driver.packageSysSha256 ?? '').toLowerCase() !== sys.sha256
    || String(driver.packageCatSha256 ?? '').toLowerCase() !== cat.sha256
    || String(driver.packageInfSha256 ?? '').toLowerCase() !== inf.sha256
  ) throw new Error('worker readiness installed driver does not match the requested runtime bundle');
  if (
    !receipt.interactiveSession
    || (worker.interactiveUser && receipt.interactiveSession.user !== worker.interactiveUser)
    || !Number.isInteger(Number(receipt.interactiveSession.sessionId))
    || Number(receipt.interactiveSession.sessionId) <= 0
    || Number(receipt.interactiveSession.explorerProcessCount) < 1
  ) throw new Error('worker readiness interactive console/explorer authority is invalid');
  const credentialCheckedAtMs = Date.parse(String(receipt.credentialStatus?.checkedAt ?? ''));
  if (
    receipt.credentialStatus?.backend !== 'windows-credential-manager'
    || receipt.credentialStatus?.exists !== true
    || receipt.credentialStatus?.reference
      !== SHARD_STRICT_PAID_PROVIDER_IDENTITY.credentialReference
    || receipt.credentialStatus?.targetName
      !== 'OmniTranslate:credential___provider_dashscope_default'
    || receipt.credentialStatus?.blobNonEmpty !== true
    || !Number.isInteger(Number(receipt.credentialStatus?.credentialBlobBytes))
    || Number(receipt.credentialStatus?.credentialBlobBytes) <= 0
    || Number(receipt.credentialStatus?.credentialBlobBytes) > 2_560
    || !Number.isFinite(credentialCheckedAtMs)
    || credentialCheckedAtMs < requestAtMs
    || credentialCheckedAtMs > generatedAtMs
    || canonicalJson(receipt.credentialStatus?.probeProcess)
      !== canonicalJson(receipt.interactiveSession.taskProcess)
  ) throw new Error('worker readiness credential status is not bound to VMUser session 1 metadata');
  assertInteractiveProcessIdentity(
    receipt.credentialStatus.probeProcess,
    {
      sessionId: Number(receipt.interactiveSession.sessionId),
      ownerSid: receipt.interactiveSession.ownerSid,
    },
    'worker readiness credential status probe',
  );
  if (!Array.isArray(receipt.profiles) || receipt.profiles.length !== worker.deviceProfileInstances.length) {
    throw new Error('worker readiness endpoint/profile inventory is incomplete');
  }
  const seenProfiles = new Set();
  for (const expected of worker.deviceProfileInstances) {
    const matches = receipt.profiles.filter((entry) => entry?.instanceId === expected.instanceId);
    if (matches.length !== 1 || seenProfiles.has(expected.instanceId)) {
      throw new Error(`worker readiness profile ${expected.instanceId} is missing or duplicated`);
    }
    seenProfiles.add(expected.instanceId);
    const actual = matches[0];
    if (
      actual.profileId !== expected.profileId
      || actual.deviceClass !== expected.deviceClass
      || !String(actual.resolvedDeviceId ?? '').trim()
      || !String(actual.resolvedDeviceName ?? '').trim()
    ) throw new Error(`worker readiness profile ${expected.instanceId} endpoint binding mismatch`);
    const expectedName = String(expected.expectedPhysicalPlaybackDeviceName ?? '').trim().toLowerCase();
    if (expectedName && !String(actual.resolvedDeviceName).toLowerCase().includes(expectedName)) {
      throw new Error(`worker readiness profile ${expected.instanceId} endpoint name mismatch`);
    }
  }
  return {
    receipt,
    authority: fileAuthorityEntry(receiptPath, authorityPath),
  };
}

function interactiveIdentityFailure(value, { plan, lease, worker }, label) {
  if (
    value.executionId !== plan.executionId
    || value.planDigest !== plan.planDigest
    || value.leaseId !== lease.leaseId
    || value.leaseDigest !== lease.leaseDigest
    || value.cellId !== lease.cellId
    || value.workerId !== worker.workerId
  ) return `${label} execution/plan/lease/worker identity mismatch`;
  return null;
}

function assertInteractiveProcessIdentity(value, { sessionId, ownerSid }, label) {
  if (
    !value
    || !Number.isInteger(Number(value.pid))
    || Number(value.pid) <= 0
    || !Number.isInteger(Number(value.parentPid))
    || Number(value.parentPid) < 0
    || Number(value.sessionId) !== sessionId
    || value.ownerSid !== ownerSid
    || !String(value.imagePath ?? '').trim()
    || !SHA256_PATTERN.test(String(value.imageSha256 ?? '').toLowerCase())
    || !Number.isFinite(Date.parse(String(value.startedAt ?? '')))
  ) throw new Error(`${label} process identity is invalid`);
  return value;
}

export function validateInteractiveLaunchAuthority({
  commandPath,
  launchPath,
  releasePath,
  plan,
  lease,
  worker,
  currentProcess = null,
}) {
  const command = readJson(commandPath, 'interactive task command');
  const launch = readJson(launchPath, 'interactive launch authority');
  const release = readJson(releasePath, 'interactive claim release');
  const commandFile = fileAuthorityEntry(commandPath, path.basename(commandPath));
  const identity = { plan, lease, worker };
  if (
    command.schemaVersion !== SHARD_AUTHORITY_SCHEMA_VERSION
    || command.artifactKind !== 'watch-mode-interactive-task-command'
    || command.mode !== 'shard-cell'
    || interactiveIdentityFailure(command, identity, 'interactive command')
    || command.vmIdentityDigest !== worker.vmIdentityDigest
    || String(command.expectedVmUuidBios).toLowerCase()
      !== String(worker.vmIdentity.uuidBios).toLowerCase()
    || command.expectedUser !== worker.interactiveUser
    || !String(command.expectedUserSid ?? '').trim()
    || Number(command.expectedSessionId) !== 1
    || !String(command.taskName ?? '').startsWith('OmniPaid-')
    || command.taskPath !== '\\OmniTranslate\\'
    || !String(command.scheduledCommandPath ?? '').trim()
    || !String(command.expectedUserId ?? '').endsWith(`\\${worker.interactiveUser}`)
    || !SHA256_PATTERN.test(String(command.launcherSha256 ?? '').toLowerCase())
    || !SHA256_PATTERN.test(String(command.shardRunnerSha256 ?? '').toLowerCase())
    || !SHA256_PATTERN.test(String(command.nodeSha256 ?? '').toLowerCase())
  ) throw new Error('interactive task command does not match the signed lease/worker');
  if (
    launch.schemaVersion !== SHARD_AUTHORITY_SCHEMA_VERSION
    || launch.artifactKind !== 'watch-mode-interactive-shard-launch-authority'
    || interactiveIdentityFailure(launch, identity, 'interactive launch')
    || launch.vmIdentityDigest !== worker.vmIdentityDigest
    || String(launch.actualVmUuidBios).toLowerCase()
      !== String(worker.vmIdentity.uuidBios).toLowerCase()
    || launch.commandSha256 !== commandFile.sha256
    || launch.taskName !== command.taskName
    || launch.user !== worker.interactiveUser
    || !String(launch.ownerSid ?? '').trim()
    || Number(launch.sessionId) !== 1
    || launch.desktop !== 'WinSta0\\Default'
    || launch.launcherSha256 !== command.launcherSha256
    || launch.shardRunnerSha256 !== command.shardRunnerSha256
  ) throw new Error('interactive launch authority does not match command/lease/worker');
  assertInteractiveProcessIdentity(launch.taskProcess, launch, 'interactive task PowerShell');
  assertInteractiveProcessIdentity(launch.explorerProcess, launch, 'interactive Explorer');
  assertInteractiveProcessIdentity(launch.nodeProcess, launch, 'interactive shard Node');
  if (
    Number(launch.nodeProcess.parentPid) !== Number(launch.taskProcess.pid)
    || Number(launch.explorerProcess.sessionId) !== Number(launch.sessionId)
  ) throw new Error('interactive launch process parent/session topology is invalid');
  if (
    release.schemaVersion !== SHARD_AUTHORITY_SCHEMA_VERSION
    || release.artifactKind !== 'watch-mode-interactive-shard-claim-release'
    || interactiveIdentityFailure(release, identity, 'interactive claim release')
    || release.vmIdentityDigest !== worker.vmIdentityDigest
    || release.commandSha256 !== commandFile.sha256
    || Number(release.nodePid) !== Number(launch.nodeProcess.pid)
    || release.nodeStartedAt !== launch.nodeProcess.startedAt
    || Number(release.sessionId) !== 1
    || release.ownerSid !== launch.ownerSid
    || Date.parse(release.releasedAt) < Date.parse(launch.launchedAt)
  ) throw new Error('interactive claim release does not match the launched Node process');
  if (currentProcess && (
    Number(currentProcess.pid) !== Number(launch.nodeProcess.pid)
    || Number(currentProcess.sessionId) !== 1
    || currentProcess.ownerSid !== launch.ownerSid
    || currentProcess.startedAt !== launch.nodeProcess.startedAt
    || String(currentProcess.imagePath).toLowerCase() !== String(launch.nodeProcess.imagePath).toLowerCase()
    || String(currentProcess.imageSha256).toLowerCase() !== String(launch.nodeProcess.imageSha256).toLowerCase()
  )) throw new Error('current shard Node does not match the interactive launch authority');
  return {
    command,
    launch,
    release,
    files: {
      command: commandFile,
      launch: fileAuthorityEntry(launchPath, path.basename(launchPath)),
      release: fileAuthorityEntry(releasePath, path.basename(releasePath)),
    },
  };
}

export function validateInteractiveSessionAuthority({
  authorityPath,
  commandPath = null,
  launchPath = null,
  processAuthorityPath = null,
  terminalPath = null,
  taskTerminalPath = null,
  executionPath = null,
  plan = null,
  lease,
  worker,
}) {
  if (!commandPath) {
    const authority = readJson(authorityPath, 'interactive session authority');
    if (authority.artifactKind === 'watch-mode-interactive-shard-session-authority' && authority.command) {
      if (!plan) throw new Error('stored interactive session authority requires its signed plan');
      const root = path.dirname(path.resolve(authorityPath));
      const component = (entry, expectedPath, label) => validateFileAuthorityEntry(
        root, entry, expectedPath, label,
      );
      const checked = validateInteractiveSessionAuthority({
        authorityPath: component(
          authority.release,
          SHARD_INTERACTIVE_CLAIM_RELEASE_FILE,
          'stored interactive claim release',
        ),
        commandPath: component(
          authority.command,
          SHARD_INTERACTIVE_COMMAND_FILE,
          'stored interactive command',
        ),
        launchPath: component(
          authority.launch,
          SHARD_INTERACTIVE_LAUNCH_FILE,
          'stored interactive launch',
        ),
        processAuthorityPath: component(
          authority.processAuthority,
          SHARD_INTERACTIVE_PROCESS_AUTHORITY_FILE,
          'stored interactive process authority',
        ),
        terminalPath: component(
          authority.terminal,
          SHARD_INTERACTIVE_TERMINAL_FILE,
          'stored interactive terminal',
        ),
        taskTerminalPath: component(
          authority.taskTerminal,
          SHARD_INTERACTIVE_TASK_TERMINAL_FILE,
          'stored interactive task terminal',
        ),
        executionPath: component(
          authority.execution,
          SHARD_INTERACTIVE_CELL_EXECUTION_FILE,
          'stored interactive cell execution',
        ),
        plan,
        lease,
        worker,
      });
      if (canonicalJson(checked.authority) !== canonicalJson(authority)) {
        throw new Error('stored interactive session authority projection mismatch');
      }
      return {
        authority,
        file: fileAuthorityEntry(authorityPath, SHARD_INTERACTIVE_SESSION_AUTHORITY_FILE),
      };
    }
    throw new Error('interactive session authority requires the complete command/launch/release/process/terminal/task/execution bundle');
  }
  const launch = validateInteractiveLaunchAuthority({
    commandPath,
    launchPath,
    releasePath: authorityPath,
    plan,
    lease,
    worker,
  });
  const command = launch.command;
  const processAuthority = readJson(processAuthorityPath, 'interactive process authority');
  const terminal = readJson(terminalPath, 'interactive task terminal');
  const taskTerminal = readJson(taskTerminalPath, 'interactive scheduled task terminal');
  const execution = readJson(executionPath, 'interactive cell execution receipt');
  const identity = { plan, lease, worker };
  const expectedTaskActionArguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass '
    + `-File "${launch.command.launcherPath}" -RequestPath "${launch.command.scheduledCommandPath}" `
    + `-ExpectedRequestSha256 ${launch.files.command.sha256}`;
  const processStartedAtMs = Date.parse(String(processAuthority.startedAt ?? ''));
  const processCompletedAtMs = Date.parse(String(processAuthority.completedAt ?? ''));
  if (
    processAuthority.schemaVersion !== SHARD_AUTHORITY_SCHEMA_VERSION
    || processAuthority.artifactKind !== 'watch-mode-interactive-process-authority'
    || interactiveIdentityFailure(processAuthority, identity, 'interactive process authority')
    || processAuthority.vmIdentityDigest !== worker.vmIdentityDigest
    || processAuthority.passed !== true
    || Number(processAuthority.expectedSessionId) !== 1
    || processAuthority.expectedOwnerSid !== launch.launch.ownerSid
    || Number(processAuthority.rootProcessId) !== Number(launch.launch.nodeProcess.pid)
    || !Array.isArray(processAuthority.processes)
    || Number(processAuthority.processCount) !== processAuthority.processes.length
    || processAuthority.processes.length < 1
    || processAuthority.processes.some((entry) => (
      Number(entry.sessionId) !== 1 || entry.ownerSid !== launch.launch.ownerSid
    ))
    || !Number.isFinite(processStartedAtMs)
    || !Number.isFinite(processCompletedAtMs)
    || processStartedAtMs > processCompletedAtMs
    || !Number.isInteger(Number(processAuthority.sampleIntervalMs))
    || Number(processAuthority.sampleIntervalMs) < 100
    || Number(processAuthority.sampleIntervalMs) > 5_000
    || !Array.isArray(processAuthority.errors)
    || processAuthority.errors.length !== 0
  ) throw new Error('interactive process authority is invalid');
  const processByPid = new Map();
  for (const [index, processEntry] of processAuthority.processes.entries()) {
    assertInteractiveProcessIdentity(
      processEntry,
      { sessionId: 1, ownerSid: launch.launch.ownerSid },
      `interactive traced process ${index}`,
    );
    const firstSeenAtMs = Date.parse(String(processEntry.firstSeenAt ?? ''));
    const lastSeenAtMs = Date.parse(String(processEntry.lastSeenAt ?? ''));
    if (
      processByPid.has(Number(processEntry.pid))
      || !String(processEntry.role ?? '').trim()
      || !String(processEntry.ownerUser ?? '').trim()
      || !String(processEntry.ownerDomain ?? '').trim()
      || typeof processEntry.commandLine !== 'string'
      || !Number.isFinite(firstSeenAtMs)
      || !Number.isFinite(lastSeenAtMs)
      || firstSeenAtMs < processStartedAtMs - Number(processAuthority.sampleIntervalMs)
      || firstSeenAtMs > lastSeenAtMs
      || lastSeenAtMs > processCompletedAtMs + Number(processAuthority.sampleIntervalMs)
    ) throw new Error(`interactive traced process ${index} observation identity is invalid`);
    processByPid.set(Number(processEntry.pid), processEntry);
  }
  const tracedRoot = processByPid.get(Number(processAuthority.rootProcessId));
  if (
    !tracedRoot
    || tracedRoot.role !== 'shard-node'
    || Number(tracedRoot.pid) !== Number(launch.launch.nodeProcess.pid)
    || Number(tracedRoot.parentPid) !== Number(launch.launch.taskProcess.pid)
    || tracedRoot.startedAt !== launch.launch.nodeProcess.startedAt
    || String(tracedRoot.imagePath).toLowerCase()
      !== String(launch.launch.nodeProcess.imagePath).toLowerCase()
    || String(tracedRoot.imageSha256).toLowerCase()
      !== String(launch.launch.nodeProcess.imageSha256).toLowerCase()
  ) throw new Error('interactive traced shard root does not match the launched Node process');
  for (const processEntry of processAuthority.processes) {
    if (processEntry.role !== 'shard-node' && !processByPid.has(Number(processEntry.parentPid))) {
      throw new Error(`interactive traced process ${processEntry.pid} is outside the captured root process tree`);
    }
  }
  const requiredRoles = new Set(['shard-node', 'cell-powershell', 'desktop', 'bridge']);
  if (plan.cells[Number(lease.cellIndex)]?.feedbackLoopPrevention !== 'echo-cancel') {
    requiredRoles.add('recorder');
  }
  for (const role of requiredRoles) {
    if (!processAuthority.processes.some((entry) => entry.role === role)) {
      throw new Error(`interactive process authority is missing required role ${role}`);
    }
  }
  if (
    terminal.schemaVersion !== SHARD_AUTHORITY_SCHEMA_VERSION
    || terminal.artifactKind !== 'watch-mode-interactive-task-terminal'
    || interactiveIdentityFailure(terminal, identity, 'interactive terminal')
    || terminal.vmIdentityDigest !== worker.vmIdentityDigest
    || terminal.commandSha256 !== launch.files.command.sha256
    || Number(terminal.sessionId) !== 1
    || terminal.user !== worker.interactiveUser
    || terminal.ownerSid !== launch.launch.ownerSid
    || Number(terminal.nodePid) !== Number(launch.launch.nodeProcess.pid)
    || terminal.nodeStartedAt !== launch.launch.nodeProcess.startedAt
    || Number(terminal.exitCode) !== 0
    || Number(terminal.processAuthorityExitCode) !== 0
    || !Number.isFinite(Date.parse(String(terminal.completedAt ?? '')))
    || processCompletedAtMs > Date.parse(String(terminal.completedAt ?? ''))
  ) throw new Error('interactive task terminal does not match the completed shard process');
  if (
    taskTerminal.schemaVersion !== SHARD_AUTHORITY_SCHEMA_VERSION
    || taskTerminal.artifactKind !== 'watch-mode-interactive-scheduled-task-terminal'
    || taskTerminal.executionId !== plan.executionId
    || taskTerminal.planDigest !== plan.planDigest
    || taskTerminal.workerId !== worker.workerId
    || taskTerminal.leaseId !== lease.leaseId
    || taskTerminal.leaseDigest !== lease.leaseDigest
    || taskTerminal.cellId !== lease.cellId
    || taskTerminal.vmIdentityDigest !== worker.vmIdentityDigest
    || taskTerminal.commandSha256 !== launch.files.command.sha256
    || taskTerminal.taskName !== launch.launch.taskName
    || taskTerminal.taskPath !== command.taskPath
    || taskTerminal.actionExecute !== 'powershell.exe'
    || taskTerminal.actionArguments !== expectedTaskActionArguments
    || taskTerminal.userId !== command.expectedUserId
    || taskTerminal.logonType !== 'InteractiveToken'
    || taskTerminal.runLevel !== 'Limited'
    || Number(taskTerminal.lastTaskResult) !== 0
    || taskTerminal.terminalSha256 !== sha256File(terminalPath)
    || !Number.isFinite(Date.parse(String(taskTerminal.completedAt ?? '')))
    || Date.parse(taskTerminal.completedAt) < Date.parse(terminal.completedAt)
  ) throw new Error('interactive scheduled task terminal is invalid');
  if (
    execution.schemaVersion !== SHARD_AUTHORITY_SCHEMA_VERSION
    || execution.artifactKind !== SHARD_INTERACTIVE_CELL_EXECUTION_KIND
    || interactiveIdentityFailure(execution, identity, 'interactive cell execution')
    || execution.vmIdentityDigest !== worker.vmIdentityDigest
    || Number(execution.exitCode) !== 0
    || !String(execution.runDirectory ?? '').trim()
    || path.isAbsolute(String(execution.runDirectory))
    || String(execution.runDirectory).replaceAll('\\', '/').split('/').includes('..')
    || !Number.isFinite(Date.parse(String(execution.completedAt ?? '')))
    || Date.parse(execution.completedAt) > Date.parse(terminal.completedAt)
    || terminal.executionReceiptObserved !== true
  ) throw new Error('interactive cell execution receipt does not match the completed task/lease');
  const summary = {
    schemaVersion: SHARD_AUTHORITY_SCHEMA_VERSION,
    artifactKind: 'watch-mode-interactive-shard-session-authority',
    executionId: plan.executionId,
    planDigest: plan.planDigest,
    leaseId: lease.leaseId,
    leaseDigest: lease.leaseDigest,
    cellId: lease.cellId,
    workerId: worker.workerId,
    vmIdentityDigest: worker.vmIdentityDigest,
    user: worker.interactiveUser,
    ownerSid: launch.launch.ownerSid,
    sessionId: 1,
    command: fileAuthorityEntry(commandPath, SHARD_INTERACTIVE_COMMAND_FILE),
    launch: fileAuthorityEntry(launchPath, SHARD_INTERACTIVE_LAUNCH_FILE),
    release: fileAuthorityEntry(authorityPath, SHARD_INTERACTIVE_CLAIM_RELEASE_FILE),
    processAuthority: fileAuthorityEntry(
      processAuthorityPath,
      SHARD_INTERACTIVE_PROCESS_AUTHORITY_FILE,
    ),
    terminal: fileAuthorityEntry(terminalPath, SHARD_INTERACTIVE_TERMINAL_FILE),
    taskTerminal: fileAuthorityEntry(taskTerminalPath, SHARD_INTERACTIVE_TASK_TERMINAL_FILE),
    execution: fileAuthorityEntry(executionPath, SHARD_INTERACTIVE_CELL_EXECUTION_FILE),
  };
  return { authority: summary, file: null };
}

function assertVirtualDriverAuthority(runDirectory, plan) {
  const driver = readJson(path.join(runDirectory, 'driver.json'), 'virtual-driver authority');
  const authority = driver.InstalledDriverAuthority ?? driver.installedDriverAuthority;
  assertObject(authority, 'installed virtual-driver authority');
  const sys = runtimeEntry(plan.authority.runtimeBinaryHashes, 'drivers/windows-virtual-mic/package/omni-virtual-speaker.sys', 'driver SYS');
  const cat = runtimeEntry(plan.authority.runtimeBinaryHashes, 'drivers/windows-virtual-mic/package/omni-virtual-speaker.cat', 'driver CAT');
  const inf = runtimeEntry(plan.authority.runtimeBinaryHashes, 'drivers/windows-virtual-mic/package/omni-virtual-speaker.inf', 'driver INF');
  if (
    String(authority.installedSysSha256 ?? '').toLowerCase() !== sys.sha256
    || String(authority.packageSysSha256 ?? '').toLowerCase() !== sys.sha256
    || String(authority.packageCatSha256 ?? '').toLowerCase() !== cat.sha256
    || String(authority.packageInfSha256 ?? '').toLowerCase() !== inf.sha256
    || String(authority.installedServiceState ?? '').toLowerCase() !== 'running'
    || String(authority.installedSysSignatureStatus ?? '').toLowerCase() !== 'valid'
    || String(authority.packageCatalogSignatureStatus ?? '').toLowerCase() !== 'valid'
    || !String(authority.installedSysSignerThumbprint ?? '').trim()
    || String(authority.installedSysSignerThumbprint).toLowerCase()
      !== String(authority.packageCatalogSignerThumbprint ?? '').toLowerCase()
  ) throw new Error('installed virtual-driver does not match the signed runtime bundle');
}

export function collectRunArtifactInventory(runDirectory, {
  // Both files are downstream receipts over the guest-produced raw run. They
  // must never become inputs to the guest inventory they attest, otherwise
  // writing the matrix receipt after the shard result creates a deterministic
  // self-reference mismatch.
  excludedPaths = [SHARD_CELL_RESULT_FILE, 'matrix-cell-authority.json'],
} = {}) {
  const root = path.resolve(runDirectory);
  const excluded = new Set(excludedPaths.map((entry) => entry.replaceAll('\\', '/')));
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      const relative = portable(path.relative(root, child));
      const stats = fs.lstatSync(child);
      if (stats.isSymbolicLink()) throw new Error(`run artifact must not be a symlink: ${relative}`);
      if (stats.isDirectory()) {
        visit(child);
      } else if (stats.isFile() && !excluded.has(relative)) {
        files.push(fileAuthorityEntry(child, relative, { allowEmpty: true }));
      } else if (!stats.isFile()) {
        throw new Error(`run artifact has unsupported filesystem type: ${relative}`);
      }
    }
  };
  visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function resultCore(result) {
  const { resultDigest, ...core } = result;
  return core;
}

export function buildShardCellResult({
  plan,
  lease,
  workerId,
  vmIdentity,
  shardRoot,
  runDirectory,
  provenance,
  authorityImplementationHashes,
  runtimeBinaryHashes,
  shardOrchestrationImplementationHashes,
  generatedAt = new Date(),
}) {
  verifySignedExecutionPlan(plan, {
    now: generatedAt,
    currentProvenance: provenance,
    currentAuthorityImplementationHashes: authorityImplementationHashes,
    currentRuntimeBinaryHashes: runtimeBinaryHashes,
    currentShardImplementationHashes: shardOrchestrationImplementationHashes,
  });
  const cell = verifyCellLease(lease, plan, { now: generatedAt });
  const worker = plan.workers.find((candidate) => candidate.workerId === workerId);
  if (!worker || cell.workerId !== workerId || canonicalJson(worker.vmIdentity) !== canonicalJson(vmIdentity)) {
    throw new Error('shard cell result worker/VM identity does not match the signed plan');
  }
  const resolvedShardRoot = path.resolve(shardRoot);
  const resolvedRunDirectory = path.resolve(runDirectory);
  const runDirectoryRelative = relativeAuthorityChild(resolvedShardRoot, resolvedRunDirectory, 'shard run directory');
  const report = readJson(path.join(resolvedRunDirectory, 'report.json'), 'strict cell report');
  if (!['passed', 'failed'].includes(report.verdict)) {
    throw new Error(`shard cell report has unsupported verdict: ${report.verdict ?? 'missing'}`);
  }
  const usageAuthority = validateProviderUsageAuthority(resolvedRunDirectory, { cell, lease });
  const deviceAuthority = readDeviceAuthority(resolvedRunDirectory, cell);
  const workerReadinessAuthority = plan.workerReadinessRequest
    ? validateWorkerZeroProviderReadinessAuthority({
        receiptPath: path.join(resolvedRunDirectory, SHARD_WORKER_READINESS_FILE),
        plan,
        workerId,
        now: generatedAt,
      }).authority
    : null;
  const interactiveSessionAuthority = plan.workerReadinessRequest
    ? validateInteractiveSessionAuthority({
        authorityPath: path.join(resolvedRunDirectory, SHARD_INTERACTIVE_SESSION_AUTHORITY_FILE),
        plan,
        lease,
        worker,
      }).file
    : null;
  const interactiveSummary = plan.workerReadinessRequest
    ? readJson(
        path.join(resolvedRunDirectory, SHARD_INTERACTIVE_SESSION_AUTHORITY_FILE),
        'interactive session authority',
      )
    : null;
  if (cell.feedbackLoopPrevention === 'virtual-driver') {
    assertVirtualDriverAuthority(resolvedRunDirectory, plan);
  }
  const artifacts = collectRunArtifactInventory(resolvedRunDirectory);
  for (const required of [
    'report.json',
    'physical-playback-device.json',
    PROVIDER_INPUT_BUDGET_LEDGER_FILE,
    PROVIDER_INPUT_BUDGET_JOURNAL_FILE,
    PROVIDER_INPUT_BUDGET_LEASE_FILE,
    ...(plan.workerReadinessRequest ? [SHARD_WORKER_READINESS_FILE] : []),
    ...(plan.workerReadinessRequest ? [SHARD_INTERACTIVE_SESSION_AUTHORITY_FILE] : []),
    ...(interactiveSummary?.command ? [
      SHARD_INTERACTIVE_COMMAND_FILE,
      SHARD_INTERACTIVE_LAUNCH_FILE,
      SHARD_INTERACTIVE_CLAIM_RELEASE_FILE,
      SHARD_INTERACTIVE_PROCESS_AUTHORITY_FILE,
      SHARD_INTERACTIVE_TERMINAL_FILE,
      SHARD_INTERACTIVE_TASK_TERMINAL_FILE,
      SHARD_INTERACTIVE_CELL_EXECUTION_FILE,
    ] : []),
  ]) {
    if (!artifacts.some((entry) => entry.path === required)) throw new Error(`shard result is missing required artifact ${required}`);
  }
  const core = {
    schemaVersion: SHARD_AUTHORITY_SCHEMA_VERSION,
    artifactKind: SHARD_CELL_RESULT_KIND,
    generatedAt: generatedAt instanceof Date ? generatedAt.toISOString() : String(generatedAt),
    verdict: report.verdict,
    ...(report.verdict === 'failed' ? {
      failureLayer: report.failureLayer ?? 'unknown',
      stableErrorCode: report.stableErrorCode ?? report.failureCode ?? 'watch.strict-cell.failed',
      lifecyclePhase: report.lifecyclePhase ?? null,
    } : {}),
    executionId: plan.executionId,
    planDigest: plan.planDigest,
    leaseDigest: lease.leaseDigest,
    leaseId: lease.leaseId,
    cell: {
      ...approvedCellProjection(cell),
      cellIndex: cell.cellIndex,
      waveIndex: cell.waveIndex,
    },
    worker: {
      workerId,
      vmIdentity: structuredClone(vmIdentity),
      vmIdentityDigest: worker.vmIdentityDigest,
    },
    runDirectory: runDirectoryRelative,
    provenance: structuredClone(provenance),
    authority: {
      implementationHashes: sortedInventory(authorityImplementationHashes),
      runtimeBinaryHashes: sortedInventory(runtimeBinaryHashes),
      runtimeBundleDigest: authorityInventoryDigest(runtimeBinaryHashes),
      shardOrchestrationImplementationHashes: sortedInventory(shardOrchestrationImplementationHashes),
      shardOrchestrationDigest: authorityInventoryDigest(shardOrchestrationImplementationHashes),
    },
    deviceAuthority,
    usageAuthority,
    ...(workerReadinessAuthority ? { workerReadinessAuthority } : {}),
    ...(interactiveSessionAuthority ? { interactiveSessionAuthority } : {}),
    artifacts,
  };
  return { ...core, resultDigest: sha256Canonical(core) };
}

export function atomicWriteJson(filePath, value, { overwrite = false } = {}) {
  const target = path.resolve(filePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (!overwrite && fs.existsSync(target)) throw new Error(`refusing to overwrite immutable authority file ${target}`);
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx');
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, target);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return target;
}

export function writeShardCellResult(options) {
  const result = buildShardCellResult(options);
  const resultPath = path.join(path.resolve(options.runDirectory), SHARD_CELL_RESULT_FILE);
  atomicWriteJson(resultPath, result);
  return { resultPath, result };
}

export function validateShardCellResult({
  resultPath,
  plan,
  lease,
  shardRoot,
  currentProvenance = plan.provenance,
  currentAuthorityImplementationHashes = plan.authority.implementationHashes,
  currentRuntimeBinaryHashes = plan.authority.runtimeBinaryHashes,
  currentShardImplementationHashes = plan.authority.shardOrchestrationImplementationHashes,
  now = new Date(),
}) {
  verifySignedExecutionPlan(plan, {
    now,
    currentProvenance,
    currentAuthorityImplementationHashes,
    currentRuntimeBinaryHashes,
    currentShardImplementationHashes,
  });
  const plannedCell = verifyCellLease(lease, plan, { now });
  const result = readJson(resultPath, 'shard cell result');
  if (
    result.schemaVersion !== SHARD_AUTHORITY_SCHEMA_VERSION
    || result.artifactKind !== SHARD_CELL_RESULT_KIND
    || !['passed', 'failed'].includes(result.verdict)
    || (result.verdict === 'failed' && !String(result.stableErrorCode ?? '').trim())
  ) {
    throw new Error('unsupported shard cell result');
  }
  if (result.resultDigest !== sha256Canonical(resultCore(result))) throw new Error('shard cell result digest mismatch');
  const resultGeneratedAtMs = assertIsoDate(result.generatedAt, 'shard cell result generatedAt');
  if (
    resultGeneratedAtMs < Date.parse(lease.issuedAt)
    || resultGeneratedAtMs > Date.parse(lease.expiresAt)
    || resultGeneratedAtMs > Number(now instanceof Date ? now.getTime() : now) + 300_000
  ) throw new Error('shard cell result generatedAt is outside its signed lease window');
  if (
    result.executionId !== plan.executionId
    || result.planDigest !== plan.planDigest
    || result.leaseDigest !== lease.leaseDigest
    || result.leaseId !== lease.leaseId
    || Number(result.cell?.cellIndex) !== plannedCell.cellIndex
    || result.cell?.cellId !== plannedCell.cellId
    || result.worker?.workerId !== plannedCell.workerId
    || result.worker?.vmIdentityDigest !== plannedCell.vmIdentityDigest
  ) throw new Error('shard cell result plan/lease/worker identity mismatch');
  const worker = plan.workers.find((entry) => entry.workerId === plannedCell.workerId);
  if (canonicalJson(result.worker.vmIdentity) !== canonicalJson(worker.vmIdentity)) throw new Error('shard cell result VM identity mismatch');
  if (canonicalJson(result.provenance) !== canonicalJson(plan.provenance)) throw new Error('shard cell result source provenance mismatch');
  if (
    !sameAuthorityInventory(result.authority?.implementationHashes, plan.authority.implementationHashes)
    || !sameAuthorityInventory(result.authority?.runtimeBinaryHashes, plan.authority.runtimeBinaryHashes)
    || !sameAuthorityInventory(result.authority?.shardOrchestrationImplementationHashes, plan.authority.shardOrchestrationImplementationHashes)
    || result.authority?.runtimeBundleDigest !== plan.authority.runtimeBundleDigest
    || result.authority?.shardOrchestrationDigest !== plan.authority.shardOrchestrationDigest
  ) throw new Error('shard cell result implementation/runtime authority mismatch');
  const runDirectory = resolveAuthorityChild(shardRoot, result.runDirectory, 'shard cell run directory');
  const expectedResultPath = path.join(runDirectory, SHARD_CELL_RESULT_FILE);
  if (path.resolve(resultPath) !== path.resolve(expectedResultPath)) throw new Error('shard cell result path does not match its run directory');
  const usage = validateProviderUsageAuthority(runDirectory, { cell: plannedCell, lease });
  if (canonicalJson(usage) !== canonicalJson(result.usageAuthority)) throw new Error('shard cell result usage authority mismatch');
  const device = readDeviceAuthority(runDirectory, plannedCell);
  if (canonicalJson(device) !== canonicalJson(result.deviceAuthority)) throw new Error('shard cell result device authority mismatch');
  if (plan.workerReadinessRequest) {
    const readiness = validateWorkerZeroProviderReadinessAuthority({
      receiptPath: path.join(runDirectory, SHARD_WORKER_READINESS_FILE),
      plan,
      workerId: plannedCell.workerId,
      now,
    });
    if (canonicalJson(readiness.authority) !== canonicalJson(result.workerReadinessAuthority)) {
      throw new Error('shard cell result worker readiness authority mismatch');
    }
    const interactive = validateInteractiveSessionAuthority({
      authorityPath: path.join(runDirectory, SHARD_INTERACTIVE_SESSION_AUTHORITY_FILE),
      plan,
      lease,
      worker,
    });
    if (canonicalJson(interactive.file) !== canonicalJson(result.interactiveSessionAuthority)) {
      throw new Error('shard cell result interactive session authority mismatch');
    }
  } else if (result.workerReadinessAuthority) {
    throw new Error('shard cell result has an unplanned worker readiness authority');
  }
  if (plannedCell.feedbackLoopPrevention === 'virtual-driver') assertVirtualDriverAuthority(runDirectory, plan);
  const artifacts = collectRunArtifactInventory(runDirectory);
  if (canonicalJson(artifacts) !== canonicalJson(result.artifacts)) throw new Error('shard cell result raw artifact inventory mismatch');
  return { result, runDirectory, cell: plannedCell };
}

function manifestCore(manifest) {
  const { manifestDigest, ...core } = manifest;
  return core;
}

export function buildShardManifest({
  plan,
  leases,
  workerId,
  shardRoot,
  resultPaths,
  generatedAt = new Date(),
}) {
  verifySignedExecutionPlan(plan, { now: generatedAt });
  const leaseById = new Map(leases.map((lease) => [lease.leaseId, lease]));
  const expectedCells = plan.cells.filter((cell) => cell.workerId === workerId)
    .sort((left, right) => left.cellIndex - right.cellIndex);
  if (!plan.workers.some((worker) => worker.workerId === workerId)) throw new Error(`unknown shard worker ${workerId}`);
  if (!Array.isArray(resultPaths) || resultPaths.length !== expectedCells.length) {
    throw new Error(`worker ${workerId} shard manifest requires ${expectedCells.length} results`);
  }
  const validated = resultPaths.map((resultPath) => {
    const result = readJson(resultPath, 'shard cell result');
    const lease = leaseById.get(result.leaseId);
    if (!lease) throw new Error(`shard result ${resultPath} has no issued lease`);
    return validateShardCellResult({ resultPath, plan, lease, shardRoot, now: generatedAt });
  }).sort((left, right) => left.cell.cellIndex - right.cell.cellIndex);
  if (canonicalJson(validated.map((entry) => entry.cell.cellId)) !== canonicalJson(expectedCells.map((cell) => cell.cellId))) {
    throw new Error(`worker ${workerId} shard results do not match its assigned cells`);
  }
  const resultAuthorities = validated.map(({ result }) => {
    const resultPath = resolveAuthorityChild(shardRoot, `${result.runDirectory}/${SHARD_CELL_RESULT_FILE}`);
    return {
      cellIndex: result.cell.cellIndex,
      cellId: result.cell.cellId,
      leaseId: result.leaseId,
      runDirectory: result.runDirectory,
      result: fileAuthorityEntry(
        resultPath,
        `${result.runDirectory}/${SHARD_CELL_RESULT_FILE}`,
      ),
      resultDigest: result.resultDigest,
      verdict: result.verdict,
      ...(result.verdict === 'failed' ? {
        failureLayer: result.failureLayer,
        stableErrorCode: result.stableErrorCode,
        lifecyclePhase: result.lifecyclePhase,
      } : {}),
      actualExternalAudioSamples: result.usageAuthority.actualExternalAudioSamples,
    };
  });
  const actualExternalAudioSamples = resultAuthorities.reduce(
    (sum, entry) => sum + Number(entry.actualExternalAudioSamples),
    0,
  );
  if (actualExternalAudioSamples > expectedCells.length * SHARD_CELL_MAX_EXTERNAL_AUDIO_SAMPLES) {
    throw new Error(`worker ${workerId} shard usage exceeds its immutable leases`);
  }
  const core = {
    schemaVersion: SHARD_AUTHORITY_SCHEMA_VERSION,
    artifactKind: SHARD_MANIFEST_KIND,
    generatedAt: generatedAt instanceof Date ? generatedAt.toISOString() : String(generatedAt),
    verdict: validated.every(({ result }) => result.verdict === 'passed') ? 'passed' : 'failed',
    executionId: plan.executionId,
    planDigest: plan.planDigest,
    workerId,
    vmIdentityDigest: plan.workers.find((worker) => worker.workerId === workerId).vmIdentityDigest,
    runtimeBundleDigest: plan.authority.runtimeBundleDigest,
    shardOrchestrationDigest: plan.authority.shardOrchestrationDigest,
    assignedCellCount: expectedCells.length,
    reservedExternalAudioSamples: expectedCells.length * SHARD_CELL_MAX_EXTERNAL_AUDIO_SAMPLES,
    actualExternalAudioSamples,
    results: resultAuthorities,
  };
  return { ...core, manifestDigest: sha256Canonical(core) };
}

export function writeShardManifest(options) {
  const manifest = buildShardManifest(options);
  const manifestPath = path.join(path.resolve(options.shardRoot), SHARD_MANIFEST_FILE);
  atomicWriteJson(manifestPath, manifest);
  return { manifestPath, manifest };
}

export function validateShardManifest({
  manifestPath,
  shardRoot,
  plan,
  leases,
  now = new Date(),
}) {
  verifySignedExecutionPlan(plan, { now });
  if (path.resolve(manifestPath) !== path.join(path.resolve(shardRoot), SHARD_MANIFEST_FILE)) {
    throw new Error('shard manifest must be stored directly in its shard root');
  }
  const manifest = readJson(manifestPath, 'shard manifest');
  if (
    manifest.schemaVersion !== SHARD_AUTHORITY_SCHEMA_VERSION
    || manifest.artifactKind !== SHARD_MANIFEST_KIND
    || !['passed', 'failed'].includes(manifest.verdict)
  ) {
    throw new Error('unsupported shard manifest');
  }
  if (manifest.manifestDigest !== sha256Canonical(manifestCore(manifest))) throw new Error('shard manifest digest mismatch');
  const manifestGeneratedAtMs = assertIsoDate(manifest.generatedAt, 'shard manifest generatedAt');
  if (
    manifestGeneratedAtMs < Date.parse(plan.generatedAt)
    || manifestGeneratedAtMs > Date.parse(plan.expiresAt)
    || manifestGeneratedAtMs > Number(now instanceof Date ? now.getTime() : now) + 300_000
  ) throw new Error('shard manifest generatedAt is outside its signed execution window');
  if (manifest.executionId !== plan.executionId || manifest.planDigest !== plan.planDigest) {
    throw new Error('shard manifest execution binding mismatch');
  }
  const worker = plan.workers.find((entry) => entry.workerId === manifest.workerId);
  if (!worker || manifest.vmIdentityDigest !== worker.vmIdentityDigest) throw new Error('shard manifest worker/VM binding mismatch');
  if (
    manifest.runtimeBundleDigest !== plan.authority.runtimeBundleDigest
    || manifest.shardOrchestrationDigest !== plan.authority.shardOrchestrationDigest
  ) throw new Error('shard manifest runtime/implementation binding mismatch');
  const leaseById = new Map(leases.map((lease) => [lease.leaseId, lease]));
  const expectedCells = plan.cells.filter((cell) => cell.workerId === manifest.workerId)
    .sort((left, right) => left.cellIndex - right.cellIndex);
  if (!Array.isArray(manifest.results) || manifest.results.length !== expectedCells.length) {
    throw new Error('shard manifest result count does not match worker assignment');
  }
  const validatedResults = [];
  for (let index = 0; index < manifest.results.length; index += 1) {
    const binding = manifest.results[index];
    const expectedCell = expectedCells[index];
    if (binding.cellIndex !== expectedCell.cellIndex || binding.cellId !== expectedCell.cellId || binding.leaseId !== expectedCell.leaseId) {
      throw new Error(`shard manifest result ${index} does not match worker assignment`);
    }
    const resultPath = validateFileAuthorityEntry(
      shardRoot,
      binding.result,
      `${binding.runDirectory}/${SHARD_CELL_RESULT_FILE}`,
      `shard manifest result ${index}`,
    );
    const validated = validateShardCellResult({
      resultPath,
      plan,
      lease: leaseById.get(binding.leaseId),
      shardRoot,
      now,
    });
    if (Date.parse(validated.result.generatedAt) > manifestGeneratedAtMs) {
      throw new Error(`shard manifest result ${index} was generated after the shard manifest`);
    }
    if (
      validated.result.resultDigest !== binding.resultDigest
      || validated.result.verdict !== binding.verdict
      || Number(validated.result.usageAuthority.actualExternalAudioSamples) !== Number(binding.actualExternalAudioSamples)
    ) throw new Error(`shard manifest result ${index} authority mismatch`);
    validatedResults.push(validated);
  }
  const expectedVerdict = validatedResults.every(({ result }) => result.verdict === 'passed') ? 'passed' : 'failed';
  if (manifest.verdict !== expectedVerdict) throw new Error('shard manifest verdict does not match its cell results');
  const actual = validatedResults.reduce(
    (sum, entry) => sum + Number(entry.result.usageAuthority.actualExternalAudioSamples),
    0,
  );
  if (
    Number(manifest.assignedCellCount) !== expectedCells.length
    || Number(manifest.reservedExternalAudioSamples) !== expectedCells.length * SHARD_CELL_MAX_EXTERNAL_AUDIO_SAMPLES
    || Number(manifest.actualExternalAudioSamples) !== actual
    || actual > Number(manifest.reservedExternalAudioSamples)
  ) throw new Error('shard manifest aggregate budget mismatch');
  return { manifest, worker, validatedResults };
}
