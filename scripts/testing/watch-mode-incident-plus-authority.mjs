import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { isMain, parseCliArgs, repoRoot } from '../lib/testing-common.mjs';
import {
  INCIDENT_REPLAY_PLUS_ID,
  INCIDENT_REPLAY_PLUS_MODEL,
  INCIDENT_REPLAY_PLUS_MODEL_PROTOCOLS,
  INCIDENT_REPLAY_PLUS_PROVIDER_IDENTITY,
  assertCellExternalProviderBudget,
  buildMatrixExternalProviderBudget,
} from './watch-mode-external-provider-budget.mjs';
import {
  hashProviderPreflightArtifact,
  validateProviderPreflightRawAuthority,
} from './watch-mode-provider-preflight-authority.mjs';
import {
  atomicWriteJson,
  authorityInventoryDigest,
  canonicalJson,
  fileAuthorityEntry,
  generateCoordinatorSigningKeyPair,
  sha256Canonical,
  signCoordinatorAuthority,
  validateFileAuthorityEntry,
  verifyCoordinatorAuthority,
} from './watch-mode-shard-authority.mjs';

export const INCIDENT_PLUS_AUTHORITY_SCHEMA_VERSION = 1;
export const INCIDENT_PLUS_EXECUTION_PLAN_KIND = 'watch-mode-incident-plus-execution-plan';
export const INCIDENT_PLUS_CELL_LEASE_KIND = 'watch-mode-incident-plus-cell-lease';
export const INCIDENT_PLUS_PREFLIGHT_GRANT_KIND = 'watch-mode-incident-plus-preflight-grant';
export const INCIDENT_PLUS_PREFLIGHT_RESERVATION_KIND =
  'watch-mode-incident-plus-preflight-lease-reservation';
export const INCIDENT_PLUS_PREFLIGHT_AUTHORIZATION_SET_KIND =
  'watch-mode-incident-plus-preflight-authorization-set';
export const INCIDENT_PLUS_PREFLIGHT_CONSUMPTION_KIND =
  'watch-mode-incident-plus-preflight-authorization-consumption';
export const INCIDENT_PLUS_PREFLIGHT_CONSUMPTION_CLAIM_KIND =
  'watch-mode-incident-plus-preflight-consumption-claim';
export const INCIDENT_PLUS_PREFLIGHT_KIND = 'watch-mode-incident-plus-text-preflight';
export const INCIDENT_PLUS_READINESS_REQUEST_KIND =
  'watch-mode-incident-plus-worker-zero-provider-readiness-request';
export const INCIDENT_PLUS_READINESS_KIND =
  'watch-mode-incident-plus-worker-zero-provider-readiness';
export const INCIDENT_PLUS_CELL_RESULT_KIND = 'watch-mode-incident-plus-cell-result';
export const INCIDENT_PLUS_MANIFEST_KIND = 'watch-mode-incident-plus-manifest';
export const INCIDENT_PLUS_VERIFICATION_RECEIPT_KIND =
  'watch-mode-incident-plus-verification-receipt';
export const INCIDENT_PLUS_EXECUTION_PLAN_FILE = 'incident-plus-execution-plan.json';
export const INCIDENT_PLUS_PREFLIGHT_GRANT_FILE = 'incident-plus-preflight-grant.json';
export const INCIDENT_PLUS_PREFLIGHT_RESERVATION_DIRECTORY =
  'incident-plus-preflight-lease-reservations';
export const INCIDENT_PLUS_PREFLIGHT_CONSUMPTION_CLAIM_FILE =
  'incident-plus-preflight-consumption-claim.json';
export const INCIDENT_PLUS_CELL_RESULT_FILE = 'incident-plus-cell-result.json';
export const INCIDENT_PLUS_MANIFEST_FILE = 'incident-plus-manifest.json';
export const INCIDENT_PLUS_VERIFICATION_RECEIPT_FILE =
  'incident-plus-verification-receipt.json';
export const INCIDENT_PLUS_EXTERNAL_BUDGET_FILE =
  'incident-plus-external-provider-budget.json';

export const INCIDENT_PLUS_INPUT_SAMPLE_RATE_HZ = 16_000;
export const INCIDENT_PLUS_CELL_MAX_EXTERNAL_AUDIO_SAMPLES = 2_880_000;
export const INCIDENT_PLUS_CELL_MAX_EXTERNAL_AUDIO_SECONDS = 180;
export const INCIDENT_PLUS_MAX_EXTERNAL_AUDIO_SAMPLES = 8_640_000;
export const INCIDENT_PLUS_MAX_EXTERNAL_AUDIO_SECONDS = 540;
export const INCIDENT_PLUS_REQUIRED_HISTORY_REASONS = Object.freeze([
  'recent-output-echo',
  'echo-chain-fragment',
  'short-cjk-output-echo',
]);
export const INCIDENT_PLUS_FORBIDDEN_PLAYBACK_ISSUES = Object.freeze([
  'native-playback-queue-expired',
  'native-playback-queue-overflow',
  'native-playback-stream-stale-dropped',
  'native-playback-queue-stale-dropped',
]);

const SHA256 = /^[a-f0-9]{64}$/i;
const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const EXECUTION_ID = /^[a-z0-9][a-z0-9._-]{7,127}$/i;
const ISO_DATE = (value) => Number.isFinite(Date.parse(String(value ?? '')));
const portable = (value) => String(value).split(path.sep).join('/');

const incidentCell = ({ feedbackLoopPrevention, deviceClass }) => Object.freeze({
  cellId: `incident-plus::${INCIDENT_REPLAY_PLUS_MODEL}::${feedbackLoopPrevention}::${deviceClass}`,
  tier: 'incident-replay',
  providerMode: 'live-dashscope',
  durationSeconds: INCIDENT_PLUS_CELL_MAX_EXTERNAL_AUDIO_SECONDS,
  maxExternalAudioSamples: INCIDENT_PLUS_CELL_MAX_EXTERNAL_AUDIO_SAMPLES,
  auxiliaryExternalAudioSeconds: 0,
  subtitleTranslationMode: 'native',
  modelId: INCIDENT_REPLAY_PLUS_MODEL,
  feedbackLoopPrevention,
  deviceClass,
});

export const INCIDENT_PLUS_CELLS = Object.freeze([
  incidentCell({ feedbackLoopPrevention: 'process-exclusion', deviceClass: 'default-speaker' }),
  incidentCell({ feedbackLoopPrevention: 'virtual-driver', deviceClass: 'usb' }),
  incidentCell({ feedbackLoopPrevention: 'echo-cancel', deviceClass: 'default-speaker' }),
]);

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function assertIdentifier(value, label, { execution = false } = {}) {
  const pattern = execution ? EXECUTION_ID : IDENTIFIER;
  if (!pattern.test(String(value ?? ''))) throw new Error(`${label} is not a portable identifier`);
  return String(value);
}

function assertIso(value, label) {
  if (!ISO_DATE(value)) throw new Error(`${label} must be an ISO timestamp`);
  return Date.parse(String(value));
}

function assertCleanProvenance(provenance, label = 'incident source provenance') {
  assertObject(provenance, label);
  if (
    provenance.source !== 'git'
    || provenance.captureStatus !== 'captured'
    || provenance.worktreeClean !== true
    || Number(provenance.dirtyEntryCount) !== 0
    || !/^[a-f0-9]{40}$/i.test(String(provenance.headCommit ?? ''))
  ) throw new Error(`${label} must bind an exact clean git commit`);
  return provenance;
}

function assertInventory(entries, label) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error(`${label} must not be empty`);
  const seen = new Set();
  for (const [index, entry] of entries.entries()) {
    assertObject(entry, `${label}[${index}]`);
    const entryPath = String(entry.path ?? '').replaceAll('\\', '/');
    if (!entryPath || entryPath.startsWith('/') || /^[a-z]:\//i.test(entryPath)
      || entryPath.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw new Error(`${label}[${index}].path is not a safe relative path`);
    }
    const identity = process.platform === 'win32' ? entryPath.toLowerCase() : entryPath;
    if (seen.has(identity)) throw new Error(`${label} has duplicate path ${entryPath}`);
    seen.add(identity);
    if (!Number.isInteger(Number(entry.bytes)) || Number(entry.bytes) < 0
      || !SHA256.test(String(entry.sha256 ?? ''))) {
      throw new Error(`${label}[${index}] has an invalid hash/size`);
    }
  }
  return [...entries].sort((left, right) => String(left.path).localeCompare(String(right.path)));
}

function sameInventory(left, right) {
  try {
    return canonicalJson(assertInventory(left, 'left inventory'))
      === canonicalJson(assertInventory(right, 'right inventory'));
  } catch {
    return false;
  }
}

function assertOpaqueAuthority(value, label, assertions = null) {
  assertObject(value, label);
  if (
    !String(value.path ?? '').trim()
    || !Number.isInteger(Number(value.bytes))
    || Number(value.bytes) <= 0
    || !SHA256.test(String(value.sha256 ?? ''))
  ) throw new Error(`${label} must contain a file authority`);
  assertions?.(value);
  return value;
}

function assertVmIdentity(value, label) {
  assertObject(value, label);
  if (value.provider !== 'vmware' || !String(value.uuidBios ?? '').trim()) {
    throw new Error(`${label} must bind provider=vmware and uuidBios`);
  }
  return value;
}

function normalizedProfile(profile, label) {
  assertObject(profile, label);
  assertIdentifier(profile.instanceId, `${label}.instanceId`);
  assertIdentifier(profile.profileId, `${label}.profileId`);
  if (!['default-speaker', 'usb'].includes(profile.deviceClass)) {
    throw new Error(`${label}.deviceClass is unsupported`);
  }
  if (!String(profile.physicalPlaybackDeviceId ?? '').trim()) {
    throw new Error(`${label}.physicalPlaybackDeviceId is missing`);
  }
  if (profile.deviceClass === 'usb' && profile.physicalPlaybackDeviceId === 'default') {
    throw new Error(`${label} must use an explicit USB endpoint`);
  }
  if (typeof profile.expectedPhysicalPlaybackDeviceName !== 'string') {
    throw new Error(`${label}.expectedPhysicalPlaybackDeviceName must be a string`);
  }
  return {
    instanceId: String(profile.instanceId),
    profileId: String(profile.profileId),
    deviceClass: String(profile.deviceClass),
    physicalPlaybackDeviceId: String(profile.physicalPlaybackDeviceId),
    expectedPhysicalPlaybackDeviceName: profile.expectedPhysicalPlaybackDeviceName,
  };
}

function normalizeWorkers(workers) {
  if (!Array.isArray(workers) || workers.length !== 2) {
    throw new Error('incident Plus authority requires exactly two VM workers');
  }
  const workerIds = new Set();
  const vmDigests = new Set();
  return workers.map((worker, index) => {
    assertObject(worker, `workers[${index}]`);
    const workerId = assertIdentifier(worker.workerId, `workers[${index}].workerId`);
    if (workerIds.has(workerId)) throw new Error(`incident Plus workerId is duplicated: ${workerId}`);
    workerIds.add(workerId);
    const vmIdentity = structuredClone(assertVmIdentity(worker.vmIdentity, `workers[${index}].vmIdentity`));
    const vmIdentityDigest = sha256Canonical(vmIdentity);
    if (vmDigests.has(vmIdentityDigest)) throw new Error('incident Plus workers must bind different VMs');
    vmDigests.add(vmIdentityDigest);
    if (!Array.isArray(worker.deviceProfileInstances) || worker.deviceProfileInstances.length === 0) {
      throw new Error(`incident Plus worker ${workerId} has no device profiles`);
    }
    const profiles = worker.deviceProfileInstances.map((profile, profileIndex) => (
      normalizedProfile(profile, `incident Plus worker ${workerId} profile ${profileIndex}`)
    ));
    const instances = new Set(profiles.map((profile) => profile.instanceId));
    if (instances.size !== profiles.length) throw new Error(`incident Plus worker ${workerId} has duplicate profiles`);
    return {
      workerId,
      ...(String(worker.interactiveUser ?? '').trim() ? { interactiveUser: String(worker.interactiveUser).trim() } : {}),
      vmIdentity,
      vmIdentityDigest,
      deviceProfileInstances: profiles,
    };
  });
}

function profileFor(workers, deviceClass, role) {
  const matches = workers.flatMap((worker) => worker.deviceProfileInstances
    .filter((profile) => profile.deviceClass === deviceClass)
    .map((profile) => ({ worker, profile })));
  if (matches.length !== 1) {
    throw new Error(`incident Plus requires exactly one ${deviceClass} profile for ${role}`);
  }
  return matches[0];
}

export function createIncidentPlusAssignments(workers) {
  const normalizedWorkers = normalizeWorkers(workers);
  const defaultSpeaker = profileFor(normalizedWorkers, 'default-speaker', 'process-exclusion/AEC');
  const usb = profileFor(normalizedWorkers, 'usb', 'virtual-driver');
  if (defaultSpeaker.worker.workerId === usb.worker.workerId) {
    throw new Error('incident Plus process/AEC and USB virtual-driver assignments require different VMs');
  }
  return [
    {
      cellId: INCIDENT_PLUS_CELLS[0].cellId,
      workerId: defaultSpeaker.worker.workerId,
      waveIndex: 0,
      deviceProfileInstanceId: defaultSpeaker.profile.instanceId,
    },
    {
      cellId: INCIDENT_PLUS_CELLS[1].cellId,
      workerId: usb.worker.workerId,
      waveIndex: 0,
      deviceProfileInstanceId: usb.profile.instanceId,
    },
    {
      cellId: INCIDENT_PLUS_CELLS[2].cellId,
      workerId: defaultSpeaker.worker.workerId,
      waveIndex: 1,
      deviceProfileInstanceId: defaultSpeaker.profile.instanceId,
    },
  ];
}

function cellProjection(cell) {
  return {
    cellId: cell.cellId,
    tier: cell.tier,
    providerMode: cell.providerMode,
    durationSeconds: cell.durationSeconds,
    maxExternalAudioSamples: cell.maxExternalAudioSamples,
    auxiliaryExternalAudioSeconds: cell.auxiliaryExternalAudioSeconds,
    subtitleTranslationMode: cell.subtitleTranslationMode,
    modelId: cell.modelId,
    feedbackLoopPrevention: cell.feedbackLoopPrevention,
    deviceClass: cell.deviceClass,
  };
}

function assertExactIncidentCells(cells) {
  if (!Array.isArray(cells) || cells.length !== INCIDENT_PLUS_CELLS.length) {
    throw new Error('incident Plus plan must contain exactly three cells');
  }
  for (const [index, cell] of cells.entries()) {
    if (canonicalJson(cellProjection(cell)) !== canonicalJson(cellProjection(INCIDENT_PLUS_CELLS[index]))) {
      throw new Error(`incident Plus cell ${index + 1} does not match the fixed replay plan`);
    }
  }
}

function randomLeaseId(randomBytes) {
  return `incident-lease-${Buffer.from(randomBytes(16)).toString('hex')}`;
}

function planUnsigned(plan) {
  const { signature, digest, planDigest, ...core } = plan;
  return core;
}

function leaseUnsigned(lease) {
  const { signature, digest, leaseDigest, ...core } = lease;
  return core;
}

function preflightUnsigned(preflight) {
  const { signature, digest, preflightDigest, ...core } = preflight;
  return core;
}

function signedWithNamedDigest(core, field, signingKeys) {
  const named = { ...core, [field]: sha256Canonical(core) };
  return signCoordinatorAuthority(named, signingKeys.privateKeyPem, signingKeys.publicKeyPem);
}

function assertSigningKeys(signingKeys) {
  if (!signingKeys?.publicKeyPem || !signingKeys?.privateKeyPem) {
    throw new Error('incident Plus coordinator signing key pair is required');
  }
  const derived = crypto.createPublicKey(crypto.createPrivateKey(signingKeys.privateKeyPem))
    .export({ type: 'spki', format: 'pem' }).toString();
  if (derived !== signingKeys.publicKeyPem) throw new Error('incident Plus signing keys do not match');
  return signingKeys;
}

export function createIncidentPlusExecutionPlan({
  executionId = `incident-plus-${crypto.randomUUID()}`,
  generatedAt = new Date(),
  expiresAt = new Date((generatedAt instanceof Date ? generatedAt.getTime() : Date.parse(generatedAt)) + 6 * 60 * 60 * 1_000),
  provenance,
  authorityImplementationHashes,
  runtimeBinaryHashes,
  incidentImplementationHashes,
  localIsolationAuthority,
  workers,
  assignments = createIncidentPlusAssignments(workers),
  signingKeys = generateCoordinatorSigningKeyPair(),
  randomBytes = crypto.randomBytes,
}) {
  assertIdentifier(executionId, 'incident executionId', { execution: true });
  assertCleanProvenance(provenance);
  const implementationHashes = assertInventory(authorityImplementationHashes, 'incident implementation authority');
  const runtimeHashes = assertInventory(runtimeBinaryHashes, 'incident runtime authority');
  const incidentHashes = assertInventory(incidentImplementationHashes, 'incident authority implementation');
  assertOpaqueAuthority(localIsolationAuthority, 'incident local isolation authority', (value) => {
    if (Number(value.providerCalls) !== 0) throw new Error('incident local isolation authority must have providerCalls=0');
  });
  const normalizedWorkers = normalizeWorkers(workers);
  const expectedAssignments = createIncidentPlusAssignments(normalizedWorkers);
  if (canonicalJson(assignments) !== canonicalJson(expectedAssignments)) {
    throw new Error('incident Plus assignments must be the fixed two-wave placement');
  }
  const generatedAtIso = generatedAt instanceof Date ? generatedAt.toISOString() : String(generatedAt);
  const expiresAtIso = expiresAt instanceof Date ? expiresAt.toISOString() : String(expiresAt);
  const generatedAtMs = assertIso(generatedAtIso, 'incident plan generatedAt');
  if (assertIso(expiresAtIso, 'incident plan expiresAt') <= generatedAtMs) {
    throw new Error('incident plan expiry must be after generation');
  }
  assertSigningKeys(signingKeys);
  const workerById = new Map(normalizedWorkers.map((worker) => [worker.workerId, worker]));
  const plannedCells = INCIDENT_PLUS_CELLS.map((approved, cellIndex) => {
    const assignment = assignments[cellIndex];
    const worker = workerById.get(assignment.workerId);
    if (!worker || assignment.cellId !== approved.cellId || assignment.waveIndex !== (cellIndex === 2 ? 1 : 0)) {
      throw new Error(`incident Plus assignment ${cellIndex + 1} is invalid`);
    }
    const profile = worker.deviceProfileInstances.find((entry) => (
      entry.instanceId === assignment.deviceProfileInstanceId
    ));
    if (!profile || profile.deviceClass !== approved.deviceClass) {
      throw new Error(`incident Plus assignment ${cellIndex + 1} profile is invalid`);
    }
    return {
      cellIndex,
      ...cellProjection(approved),
      workerId: worker.workerId,
      vmIdentityDigest: worker.vmIdentityDigest,
      waveIndex: assignment.waveIndex,
      deviceProfileInstance: structuredClone(profile),
      deviceProfileInstanceDigest: sha256Canonical(profile),
      leaseId: randomLeaseId(randomBytes),
      maxExternalAudioSamples: INCIDENT_PLUS_CELL_MAX_EXTERNAL_AUDIO_SAMPLES,
      inputSampleRateHz: INCIDENT_PLUS_INPUT_SAMPLE_RATE_HZ,
    };
  });
  if (new Set(plannedCells.map((cell) => cell.leaseId)).size !== INCIDENT_PLUS_CELLS.length) {
    throw new Error('incident Plus plan lease IDs must be unique');
  }
  const core = {
    schemaVersion: INCIDENT_PLUS_AUTHORITY_SCHEMA_VERSION,
    artifactKind: INCIDENT_PLUS_EXECUTION_PLAN_KIND,
    incidentId: INCIDENT_REPLAY_PLUS_ID,
    executionId,
    generatedAt: generatedAtIso,
    expiresAt: expiresAtIso,
    provenance: structuredClone(provenance),
    validationPlan: {
      incidentId: INCIDENT_REPLAY_PLUS_ID,
      modelId: INCIDENT_REPLAY_PLUS_MODEL,
      cellCount: INCIDENT_PLUS_CELLS.length,
      cells: INCIDENT_PLUS_CELLS.map(cellProjection),
      sha256: sha256Canonical(INCIDENT_PLUS_CELLS.map(cellProjection)),
    },
    providerIdentity: structuredClone(INCIDENT_REPLAY_PLUS_PROVIDER_IDENTITY),
    authority: {
      implementationHashes,
      runtimeBinaryHashes: runtimeHashes,
      runtimeBundleDigest: authorityInventoryDigest(runtimeHashes),
      incidentImplementationHashes: incidentHashes,
      incidentImplementationDigest: authorityInventoryDigest(incidentHashes),
    },
    localIsolationAuthority: structuredClone(localIsolationAuthority),
    coordinator: { publicKeyPem: signingKeys.publicKeyPem },
    budget: {
      allocationMode: 'immutable-disjoint-cell-leases',
      inputSampleRateHz: INCIDENT_PLUS_INPUT_SAMPLE_RATE_HZ,
      cellMaxExternalAudioSamples: INCIDENT_PLUS_CELL_MAX_EXTERNAL_AUDIO_SAMPLES,
      cellMaxExternalAudioSeconds: INCIDENT_PLUS_CELL_MAX_EXTERNAL_AUDIO_SECONDS,
      matrixMaxExternalAudioSamples: INCIDENT_PLUS_MAX_EXTERNAL_AUDIO_SAMPLES,
      matrixMaxExternalAudioSeconds: INCIDENT_PLUS_MAX_EXTERNAL_AUDIO_SECONDS,
      allocatedExternalAudioSamples: INCIDENT_PLUS_MAX_EXTERNAL_AUDIO_SAMPLES,
      auxiliaryExternalAudioSeconds: 0,
      cellCount: INCIDENT_PLUS_CELLS.length,
      reclaimPolicy: 'never-within-execution',
      retryPolicy: 'new-execution-required',
    },
    workers: normalizedWorkers,
    waves: [
      { waveIndex: 0, cellIds: plannedCells.slice(0, 2).map((cell) => cell.cellId) },
      { waveIndex: 1, cellIds: [plannedCells[2].cellId] },
    ],
    cells: plannedCells,
  };
  return signedWithNamedDigest(core, 'planDigest', signingKeys);
}

export function verifyIncidentPlusExecutionPlan(plan, {
  now = new Date(),
  checkExpiry = true,
  currentProvenance = null,
  currentAuthorityImplementationHashes = null,
  currentRuntimeBinaryHashes = null,
  currentIncidentImplementationHashes = null,
} = {}) {
  assertObject(plan, 'incident Plus execution plan');
  if (plan.schemaVersion !== INCIDENT_PLUS_AUTHORITY_SCHEMA_VERSION
    || plan.artifactKind !== INCIDENT_PLUS_EXECUTION_PLAN_KIND
    || plan.incidentId !== INCIDENT_REPLAY_PLUS_ID) {
    throw new Error('unsupported incident Plus execution plan');
  }
  assertIdentifier(plan.executionId, 'incident executionId', { execution: true });
  assertCleanProvenance(plan.provenance);
  if (!plan.coordinator?.publicKeyPem) throw new Error('incident Plus plan coordinator key is missing');
  verifyCoordinatorAuthority(plan, plan.coordinator.publicKeyPem, 'incident Plus execution plan');
  if (plan.planDigest !== sha256Canonical(planUnsigned(plan))) throw new Error('incident Plus planDigest mismatch');
  const generatedAt = assertIso(plan.generatedAt, 'incident plan generatedAt');
  const expiresAt = assertIso(plan.expiresAt, 'incident plan expiresAt');
  if (expiresAt <= generatedAt) throw new Error('incident Plus plan time window is inverted');
  if (checkExpiry && Number(now instanceof Date ? now.getTime() : now) > expiresAt) {
    throw new Error('incident Plus execution plan has expired');
  }
  if (
    plan.validationPlan?.incidentId !== INCIDENT_REPLAY_PLUS_ID
    || plan.validationPlan?.modelId !== INCIDENT_REPLAY_PLUS_MODEL
    || plan.validationPlan?.cellCount !== INCIDENT_PLUS_CELLS.length
    || plan.validationPlan?.sha256 !== sha256Canonical(INCIDENT_PLUS_CELLS.map(cellProjection))
    || canonicalJson(plan.validationPlan?.cells) !== canonicalJson(INCIDENT_PLUS_CELLS.map(cellProjection))
  ) throw new Error('incident Plus plan validation cells were changed');
  if (canonicalJson(plan.providerIdentity) !== canonicalJson(INCIDENT_REPLAY_PLUS_PROVIDER_IDENTITY)) {
    throw new Error('incident Plus plan provider identity is invalid');
  }
  assertOpaqueAuthority(plan.localIsolationAuthority, 'incident local isolation authority', (value) => {
    if (Number(value.providerCalls) !== 0) throw new Error('incident local isolation authority must bind providerCalls=0');
  });
  const workers = normalizeWorkers(plan.workers);
  if (canonicalJson(workers) !== canonicalJson(plan.workers)) throw new Error('incident Plus workers are not normalized');
  assertExactIncidentCells(plan.cells);
  const expectedAssignments = createIncidentPlusAssignments(workers);
  const workerById = new Map(workers.map((worker) => [worker.workerId, worker]));
  const leaseIds = new Set();
  for (const [index, cell] of plan.cells.entries()) {
    const assignment = expectedAssignments[index];
    const worker = workerById.get(cell.workerId);
    if (
      Number(cell.cellIndex) !== index
      || cell.workerId !== assignment.workerId
      || Number(cell.waveIndex) !== assignment.waveIndex
      || cell.vmIdentityDigest !== worker?.vmIdentityDigest
      || cell.deviceProfileInstance?.instanceId !== assignment.deviceProfileInstanceId
      || cell.deviceProfileInstanceDigest !== sha256Canonical(cell.deviceProfileInstance)
      || Number(cell.maxExternalAudioSamples) !== INCIDENT_PLUS_CELL_MAX_EXTERNAL_AUDIO_SAMPLES
      || Number(cell.inputSampleRateHz) !== INCIDENT_PLUS_INPUT_SAMPLE_RATE_HZ
    ) throw new Error(`incident Plus cell ${index + 1} worker/profile binding is invalid`);
    assertIdentifier(cell.leaseId, `incident Plus cell ${index + 1} leaseId`);
    if (leaseIds.has(cell.leaseId)) throw new Error('incident Plus plan has duplicate cell leases');
    leaseIds.add(cell.leaseId);
  }
  if (canonicalJson(plan.waves) !== canonicalJson([
    { waveIndex: 0, cellIds: plan.cells.slice(0, 2).map((cell) => cell.cellId) },
    { waveIndex: 1, cellIds: [plan.cells[2].cellId] },
  ])) throw new Error('incident Plus plan must run the fixed two-wave schedule');
  const authority = plan.authority ?? {};
  assertInventory(authority.implementationHashes, 'incident implementation authority');
  assertInventory(authority.runtimeBinaryHashes, 'incident runtime authority');
  assertInventory(authority.incidentImplementationHashes, 'incident implementation authority');
  if (
    authority.runtimeBundleDigest !== authorityInventoryDigest(authority.runtimeBinaryHashes)
    || authority.incidentImplementationDigest !== authorityInventoryDigest(authority.incidentImplementationHashes)
  ) throw new Error('incident Plus authority inventory digest mismatch');
  const budget = plan.budget ?? {};
  if (
    budget.allocationMode !== 'immutable-disjoint-cell-leases'
    || Number(budget.inputSampleRateHz) !== INCIDENT_PLUS_INPUT_SAMPLE_RATE_HZ
    || Number(budget.cellMaxExternalAudioSamples) !== INCIDENT_PLUS_CELL_MAX_EXTERNAL_AUDIO_SAMPLES
    || Number(budget.cellMaxExternalAudioSeconds) !== INCIDENT_PLUS_CELL_MAX_EXTERNAL_AUDIO_SECONDS
    || Number(budget.matrixMaxExternalAudioSamples) !== INCIDENT_PLUS_MAX_EXTERNAL_AUDIO_SAMPLES
    || Number(budget.matrixMaxExternalAudioSeconds) !== INCIDENT_PLUS_MAX_EXTERNAL_AUDIO_SECONDS
    || Number(budget.allocatedExternalAudioSamples) !== INCIDENT_PLUS_MAX_EXTERNAL_AUDIO_SAMPLES
    || Number(budget.auxiliaryExternalAudioSeconds) !== 0
    || Number(budget.cellCount) !== INCIDENT_PLUS_CELLS.length
    || budget.reclaimPolicy !== 'never-within-execution'
    || budget.retryPolicy !== 'new-execution-required'
  ) throw new Error('incident Plus plan budget is not the fixed 540-second allocation');
  if (currentProvenance && canonicalJson(currentProvenance) !== canonicalJson(plan.provenance)) {
    throw new Error('current provenance does not match incident Plus plan');
  }
  if (currentAuthorityImplementationHashes && !sameInventory(currentAuthorityImplementationHashes, authority.implementationHashes)) {
    throw new Error('current implementation hashes do not match incident Plus plan');
  }
  if (currentRuntimeBinaryHashes && !sameInventory(currentRuntimeBinaryHashes, authority.runtimeBinaryHashes)) {
    throw new Error('current runtime hashes do not match incident Plus plan');
  }
  if (currentIncidentImplementationHashes && !sameInventory(currentIncidentImplementationHashes, authority.incidentImplementationHashes)) {
    throw new Error('current incident authority hashes do not match incident Plus plan');
  }
  return plan;
}

export function issueIncidentPlusCellLeases(plan, signingKeys, { issuedAt = new Date() } = {}) {
  verifyIncidentPlusExecutionPlan(plan, { now: issuedAt });
  assertSigningKeys(signingKeys);
  if (signingKeys.publicKeyPem !== plan.coordinator.publicKeyPem) {
    throw new Error('incident Plus cell lease signer does not match the plan coordinator');
  }
  const issuedAtIso = issuedAt instanceof Date ? issuedAt.toISOString() : String(issuedAt);
  return plan.cells.map((cell) => signedWithNamedDigest({
    schemaVersion: INCIDENT_PLUS_AUTHORITY_SCHEMA_VERSION,
    artifactKind: INCIDENT_PLUS_CELL_LEASE_KIND,
    incidentId: INCIDENT_REPLAY_PLUS_ID,
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
    inputSampleRateHz: INCIDENT_PLUS_INPUT_SAMPLE_RATE_HZ,
    maxExternalAudioSamples: INCIDENT_PLUS_CELL_MAX_EXTERNAL_AUDIO_SAMPLES,
    auxiliaryExternalAudioSeconds: 0,
    reclaimPolicy: 'never-within-execution',
    retryPolicy: 'new-execution-required',
  }, 'leaseDigest', signingKeys));
}

export function verifyIncidentPlusCellLease(lease, plan, { now = new Date(), checkExpiry = true } = {}) {
  verifyIncidentPlusExecutionPlan(plan, { now, checkExpiry });
  assertObject(lease, 'incident Plus cell lease');
  if (lease.schemaVersion !== INCIDENT_PLUS_AUTHORITY_SCHEMA_VERSION
    || lease.artifactKind !== INCIDENT_PLUS_CELL_LEASE_KIND
    || lease.incidentId !== INCIDENT_REPLAY_PLUS_ID) {
    throw new Error('unsupported incident Plus cell lease');
  }
  verifyCoordinatorAuthority(lease, plan.coordinator.publicKeyPem, 'incident Plus cell lease');
  if (lease.leaseDigest !== sha256Canonical(leaseUnsigned(lease))) throw new Error('incident Plus leaseDigest mismatch');
  const cell = plan.cells[Number(lease.cellIndex)];
  if (!cell) throw new Error('incident Plus lease references an unknown cell');
  const expected = {
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
    inputSampleRateHz: INCIDENT_PLUS_INPUT_SAMPLE_RATE_HZ,
    maxExternalAudioSamples: INCIDENT_PLUS_CELL_MAX_EXTERNAL_AUDIO_SAMPLES,
    auxiliaryExternalAudioSeconds: 0,
    reclaimPolicy: 'never-within-execution',
    retryPolicy: 'new-execution-required',
  };
  for (const [key, value] of Object.entries(expected)) {
    if (lease[key] !== value) throw new Error(`incident Plus lease ${key} does not match the plan`);
  }
  if (lease.expiresAt !== plan.expiresAt) throw new Error('incident Plus lease expiry does not match plan');
  const issuedAt = assertIso(lease.issuedAt, 'incident Plus lease issuedAt');
  const expiresAt = assertIso(lease.expiresAt, 'incident Plus lease expiresAt');
  if (issuedAt < Date.parse(plan.generatedAt) || issuedAt >= expiresAt) {
    throw new Error('incident Plus lease was issued outside the plan window');
  }
  if (checkExpiry && Number(now instanceof Date ? now.getTime() : now) > expiresAt) {
    throw new Error('incident Plus cell lease has expired');
  }
  return cell;
}

export function createIncidentPlusReadinessRequests(plan, signingKeys, { generatedAt = new Date() } = {}) {
  verifyIncidentPlusExecutionPlan(plan, { now: generatedAt });
  assertSigningKeys(signingKeys);
  if (signingKeys.publicKeyPem !== plan.coordinator.publicKeyPem) {
    throw new Error('incident Plus readiness signer does not match the plan coordinator');
  }
  const generatedAtIso = generatedAt instanceof Date ? generatedAt.toISOString() : String(generatedAt);
  return plan.workers.map((worker) => signedWithNamedDigest({
    schemaVersion: INCIDENT_PLUS_AUTHORITY_SCHEMA_VERSION,
    artifactKind: INCIDENT_PLUS_READINESS_REQUEST_KIND,
    incidentId: INCIDENT_REPLAY_PLUS_ID,
    generatedAt: generatedAtIso,
    executionId: plan.executionId,
    planDigest: plan.planDigest,
    workerId: worker.workerId,
    vmIdentityDigest: worker.vmIdentityDigest,
    sourceHeadCommit: plan.provenance.headCommit,
    runtimeBundleDigest: plan.authority.runtimeBundleDigest,
    profiles: structuredClone(worker.deviceProfileInstances),
    assignedCells: plan.cells.filter((cell) => cell.workerId === worker.workerId).map((cell) => ({
      cellId: cell.cellId,
      feedbackLoopPrevention: cell.feedbackLoopPrevention,
      deviceClass: cell.deviceClass,
      deviceProfileInstanceDigest: cell.deviceProfileInstanceDigest,
    })),
    providerCalls: 0,
    externalAudioSamples: 0,
  }, 'requestDigest', signingKeys));
}

export function validateIncidentPlusReadinessRequest(request, plan) {
  verifyIncidentPlusExecutionPlan(plan, { now: request?.generatedAt });
  if (request?.schemaVersion !== INCIDENT_PLUS_AUTHORITY_SCHEMA_VERSION
    || request.artifactKind !== INCIDENT_PLUS_READINESS_REQUEST_KIND
    || request.incidentId !== INCIDENT_REPLAY_PLUS_ID) {
    throw new Error('unsupported incident Plus readiness request');
  }
  verifyCoordinatorAuthority(request, plan.coordinator.publicKeyPem, 'incident Plus readiness request');
  const { signature, digest, requestDigest, ...core } = request;
  if (requestDigest !== sha256Canonical(core)) throw new Error('incident Plus readiness request digest mismatch');
  assertIso(request.generatedAt, 'incident Plus readiness request generatedAt');
  const worker = plan.workers.find((entry) => entry.workerId === request.workerId);
  if (!worker || request.executionId !== plan.executionId || request.planDigest !== plan.planDigest
    || request.vmIdentityDigest !== worker.vmIdentityDigest
    || request.sourceHeadCommit !== plan.provenance.headCommit
    || request.runtimeBundleDigest !== plan.authority.runtimeBundleDigest
    || Number(request.providerCalls) !== 0 || Number(request.externalAudioSamples) !== 0
    || canonicalJson(request.profiles) !== canonicalJson(worker.deviceProfileInstances)) {
    throw new Error('incident Plus readiness request is not bound to the signed plan worker');
  }
  const expectedCells = plan.cells.filter((cell) => cell.workerId === worker.workerId).map((cell) => ({
    cellId: cell.cellId,
    feedbackLoopPrevention: cell.feedbackLoopPrevention,
    deviceClass: cell.deviceClass,
    deviceProfileInstanceDigest: cell.deviceProfileInstanceDigest,
  }));
  if (canonicalJson(request.assignedCells) !== canonicalJson(expectedCells)) {
    throw new Error('incident Plus readiness request assigned cells mismatch');
  }
  return worker;
}

function readRegularJson(filePath, label) {
  const resolved = path.resolve(filePath);
  let stats;
  try {
    stats = fs.lstatSync(resolved);
  } catch {
    throw new Error(`${label} is missing: ${resolved}`);
  }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0) {
    throw new Error(`${label} must be a non-empty regular non-symlink file`);
  }
  try {
    return JSON.parse(fs.readFileSync(resolved, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

export function validateIncidentPlusWorkerReadiness({
  receiptPath,
  request,
  plan,
  now = new Date(),
  authorityPath = path.basename(receiptPath),
}) {
  const worker = validateIncidentPlusReadinessRequest(request, plan);
  const receipt = readRegularJson(receiptPath, 'incident Plus worker readiness receipt');
  if (
    receipt.schemaVersion !== INCIDENT_PLUS_AUTHORITY_SCHEMA_VERSION
    || receipt.artifactKind !== INCIDENT_PLUS_READINESS_KIND
    || receipt.incidentId !== INCIDENT_REPLAY_PLUS_ID
    || receipt.executionId !== plan.executionId
    || receipt.planDigest !== plan.planDigest
    || receipt.requestDigest !== request.requestDigest
    || receipt.workerId !== worker.workerId
    || receipt.vmIdentityDigest !== worker.vmIdentityDigest
    || receipt.sourceHeadCommit !== plan.provenance.headCommit
    || receipt.runtimeBundleDigest !== plan.authority.runtimeBundleDigest
    || Number(receipt.providerCalls) !== 0
    || Number(receipt.externalAudioSamples) !== 0
    || receipt.interactiveSession?.ready !== true
    || Number(receipt.interactiveSession?.sessionId) !== 1
    || receipt.credentials?.providerId !== INCIDENT_REPLAY_PLUS_PROVIDER_IDENTITY.providerId
    || receipt.credentials?.reference !== INCIDENT_REPLAY_PLUS_PROVIDER_IDENTITY.credentialReference
    || receipt.credentials?.visible !== true
    || receipt.bridgeSource?.ready !== true
    || !ISO_DATE(receipt.generatedAt)
  ) throw new Error('incident Plus worker readiness receipt does not prove zero-provider device/session/credential readiness');
  if (Date.parse(receipt.generatedAt) < Date.parse(request.generatedAt)
    || Date.parse(receipt.generatedAt) > Number(now instanceof Date ? now.getTime() : now) + 300_000) {
    throw new Error('incident Plus worker readiness receipt timestamp is invalid');
  }
  if (canonicalJson(receipt.profiles) !== canonicalJson(worker.deviceProfileInstances)) {
    throw new Error('incident Plus worker readiness receipt device profiles mismatch');
  }
  const virtualDriverRequired = request.assignedCells.some((cell) => cell.feedbackLoopPrevention === 'virtual-driver');
  if (Boolean(receipt.virtualDriver?.required) !== virtualDriverRequired
    || (virtualDriverRequired && receipt.virtualDriver?.ready !== true)
    || (request.assignedCells.some((cell) => cell.feedbackLoopPrevention === 'process-exclusion')
      && receipt.processExclusion?.ready !== true)
    || (request.assignedCells.some((cell) => cell.feedbackLoopPrevention === 'echo-cancel')
      && receipt.echoCancel?.ready !== true)) {
    throw new Error('incident Plus worker readiness receipt feedback-route capability mismatch');
  }
  return {
    receipt,
    authority: fileAuthorityEntry(path.resolve(receiptPath), authorityPath),
    worker,
  };
}

function incidentPreflightCells(plan) {
  return plan.cells.map((cell, cellIndex) => ({
    cellIndex,
    cellId: cell.cellId,
    providerId: INCIDENT_REPLAY_PLUS_PROVIDER_IDENTITY.providerId,
    modelId: INCIDENT_REPLAY_PLUS_MODEL,
    protocol: INCIDENT_REPLAY_PLUS_MODEL_PROTOCOLS[INCIDENT_REPLAY_PLUS_MODEL],
    feedbackLoopPrevention: cell.feedbackLoopPrevention,
    deviceClass: cell.deviceClass,
    workerId: cell.workerId,
    waveIndex: cell.waveIndex,
    deviceProfileInstanceId: cell.deviceProfileInstance.instanceId,
    leaseId: cell.leaseId,
    maxExternalAudioSamples: INCIDENT_PLUS_CELL_MAX_EXTERNAL_AUDIO_SAMPLES,
  }));
}

export const incidentPlusPreflightReservationFileName = (cell, cellIndex = cell.cellIndex) => (
  `${String(Number(cellIndex) + 1).padStart(2, '0')}-${String(cell.cellId)
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '')}.json`
);

export function incidentPlusPreflightAuthorizationDigest({ grant, leaseReservations }) {
  return sha256Canonical({
    schemaVersion: INCIDENT_PLUS_AUTHORITY_SCHEMA_VERSION,
    artifactKind: INCIDENT_PLUS_PREFLIGHT_AUTHORIZATION_SET_KIND,
    executionId: grant.executionId,
    grantDigest: grant.digest,
    leaseReservationDigests: leaseReservations.map((reservation) => reservation.digest),
  });
}

export function createIncidentPlusPreflightGrant({
  plan,
  leases,
  generatedAt = new Date(),
  signingKeys,
}) {
  verifyIncidentPlusExecutionPlan(plan, { now: generatedAt });
  assertSigningKeys(signingKeys);
  if (signingKeys.publicKeyPem !== plan.coordinator.publicKeyPem) {
    throw new Error('incident Plus preflight grant signer does not match plan coordinator');
  }
  if (!Array.isArray(leases) || leases.length !== INCIDENT_PLUS_CELLS.length) {
    throw new Error('incident Plus preflight grant requires all three cell leases');
  }
  const grantAt = generatedAt instanceof Date ? generatedAt.toISOString() : String(generatedAt);
  if (Date.parse(grantAt) < Date.parse(plan.generatedAt) || Date.parse(grantAt) >= Date.parse(plan.expiresAt)) {
    throw new Error('incident Plus preflight grant time is outside the execution window');
  }
  const cells = incidentPreflightCells(plan);
  for (const [index, lease] of leases.entries()) {
    const verified = verifyIncidentPlusCellLease(lease, plan, { now: generatedAt });
    if (verified.cellIndex !== index || verified.leaseId !== cells[index].leaseId) {
      throw new Error(`incident Plus preflight lease ${index + 1} does not match its planned cell`);
    }
  }
  const core = {
    schemaVersion: INCIDENT_PLUS_AUTHORITY_SCHEMA_VERSION,
    artifactKind: INCIDENT_PLUS_PREFLIGHT_GRANT_KIND,
    incidentId: INCIDENT_REPLAY_PLUS_ID,
    generatedAt: grantAt,
    expiresAt: plan.expiresAt,
    executionId: plan.executionId,
    provenance: structuredClone(plan.provenance),
    authorityImplementationHashes: structuredClone(plan.authority.implementationHashes),
    runtimeBinaryHashes: structuredClone(plan.authority.runtimeBinaryHashes),
    runtimeBundleDigest: plan.authority.runtimeBundleDigest,
    incidentImplementationHashes: structuredClone(plan.authority.incidentImplementationHashes),
    localIsolationAuthority: structuredClone(plan.localIsolationAuthority),
    workers: structuredClone(plan.workers),
    cells,
    budget: {
      inputSampleRateHz: INCIDENT_PLUS_INPUT_SAMPLE_RATE_HZ,
      cellMaxExternalAudioSamples: INCIDENT_PLUS_CELL_MAX_EXTERNAL_AUDIO_SAMPLES,
      matrixMaxExternalAudioSamples: INCIDENT_PLUS_MAX_EXTERNAL_AUDIO_SAMPLES,
      reclaimPolicy: 'never-within-execution',
      retryPolicy: 'new-execution-required',
    },
    authorization: {
      providerId: INCIDENT_REPLAY_PLUS_PROVIDER_IDENTITY.providerId,
      model: INCIDENT_REPLAY_PLUS_MODEL,
      protocol: INCIDENT_REPLAY_PLUS_MODEL_PROTOCOLS[INCIDENT_REPLAY_PLUS_MODEL],
      operation: 'text-translation-preflight',
      inputMode: 'text-only',
      invocationCount: 1,
      externalAudioSamples: 0,
      systemPromptTemplate: 'game-live-translation-cn',
      responseModalities: ['text'],
      customHeaders: [],
      timeoutMs: 12_000,
      temperature: 0.2,
      tokenBudget: { maxInputTokens: 4_096, maxOutputTokens: 256 },
    },
    coordinator: { publicKeyPem: signingKeys.publicKeyPem },
  };
  return signCoordinatorAuthority(core, signingKeys.privateKeyPem, signingKeys.publicKeyPem);
}

export function verifyIncidentPlusPreflightGrant(grant, plan) {
  verifyIncidentPlusExecutionPlan(plan, { now: grant?.generatedAt });
  verifyCoordinatorAuthority(grant, plan.coordinator.publicKeyPem, 'incident Plus preflight grant');
  const cells = incidentPreflightCells(plan);
  if (
    grant?.schemaVersion !== INCIDENT_PLUS_AUTHORITY_SCHEMA_VERSION
    || grant.artifactKind !== INCIDENT_PLUS_PREFLIGHT_GRANT_KIND
    || grant.incidentId !== INCIDENT_REPLAY_PLUS_ID
    || grant.executionId !== plan.executionId
    || Date.parse(String(grant.generatedAt ?? '')) < Date.parse(plan.generatedAt)
    || Date.parse(String(grant.expiresAt ?? '')) !== Date.parse(plan.expiresAt)
    || canonicalJson(grant.provenance) !== canonicalJson(plan.provenance)
    || canonicalJson(grant.authorityImplementationHashes) !== canonicalJson(plan.authority.implementationHashes)
    || canonicalJson(grant.runtimeBinaryHashes) !== canonicalJson(plan.authority.runtimeBinaryHashes)
    || grant.runtimeBundleDigest !== plan.authority.runtimeBundleDigest
    || canonicalJson(grant.incidentImplementationHashes) !== canonicalJson(plan.authority.incidentImplementationHashes)
    || canonicalJson(grant.localIsolationAuthority) !== canonicalJson(plan.localIsolationAuthority)
    || canonicalJson(grant.workers) !== canonicalJson(plan.workers)
    || canonicalJson(grant.cells) !== canonicalJson(cells)
    || canonicalJson(grant.budget) !== canonicalJson({
      inputSampleRateHz: 16_000,
      cellMaxExternalAudioSamples: 2_880_000,
      matrixMaxExternalAudioSamples: 8_640_000,
      reclaimPolicy: 'never-within-execution',
      retryPolicy: 'new-execution-required',
    })
    || canonicalJson(grant.authorization) !== canonicalJson({
      providerId: INCIDENT_REPLAY_PLUS_PROVIDER_IDENTITY.providerId,
      model: INCIDENT_REPLAY_PLUS_MODEL,
      protocol: INCIDENT_REPLAY_PLUS_MODEL_PROTOCOLS[INCIDENT_REPLAY_PLUS_MODEL],
      operation: 'text-translation-preflight',
      inputMode: 'text-only',
      invocationCount: 1,
      externalAudioSamples: 0,
      systemPromptTemplate: 'game-live-translation-cn',
      responseModalities: ['text'],
      customHeaders: [],
      timeoutMs: 12_000,
      temperature: 0.2,
      tokenBudget: { maxInputTokens: 4_096, maxOutputTokens: 256 },
    })
  ) throw new Error('incident Plus preflight grant does not bind the fixed three-cell text-only authority');
  return grant;
}

export function createIncidentPlusPreflightLeaseReservations({
  grant,
  plan,
  issuedAt = new Date(),
  signingKeys,
}) {
  verifyIncidentPlusPreflightGrant(grant, plan);
  assertSigningKeys(signingKeys);
  const issuedAtIso = issuedAt instanceof Date ? issuedAt.toISOString() : String(issuedAt);
  if (Date.parse(issuedAtIso) <= Date.parse(grant.generatedAt)
    || Date.parse(issuedAtIso) >= Date.parse(grant.expiresAt)) {
    throw new Error('incident Plus preflight reservations must be issued within the grant window');
  }
  const reservations = grant.cells.map((cell) => signCoordinatorAuthority({
    schemaVersion: INCIDENT_PLUS_AUTHORITY_SCHEMA_VERSION,
    artifactKind: INCIDENT_PLUS_PREFLIGHT_RESERVATION_KIND,
    incidentId: INCIDENT_REPLAY_PLUS_ID,
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
  return verifyIncidentPlusPreflightLeaseReservations(reservations, grant, plan);
}

/**
 * Publish the public half of the one-shot Plus preflight authority.  The
 * coordinator's private key is deliberately never persisted; the Desktop
 * process receives only this signed grant and its three signed reservations.
 */
export function writeIncidentPlusPreflightAuthorizationPackage({
  executionRoot,
  plan,
  grant,
  leaseReservations,
}) {
  verifyIncidentPlusPreflightGrant(grant, plan);
  verifyIncidentPlusPreflightLeaseReservations(leaseReservations, grant, plan);
  const root = path.join(path.resolve(executionRoot), 'preflight-authorization');
  if (fs.existsSync(root)) {
    throw new Error(`incident Plus preflight authorization already exists: ${root}`);
  }
  const reservationsRoot = path.join(root, INCIDENT_PLUS_PREFLIGHT_RESERVATION_DIRECTORY);
  fs.mkdirSync(reservationsRoot, { recursive: true });
  const grantPath = path.join(root, INCIDENT_PLUS_PREFLIGHT_GRANT_FILE);
  atomicWriteJson(grantPath, grant);
  const reservationPaths = leaseReservations.map((reservation, index) => {
    const filePath = path.join(
      reservationsRoot,
      incidentPlusPreflightReservationFileName(plan.cells[index], index),
    );
    atomicWriteJson(filePath, reservation);
    return filePath;
  });
  return {
    authorizationRoot: root,
    grantPath,
    reservationDirectory: reservationsRoot,
    reservationPaths,
    authorizationDigest: incidentPlusPreflightAuthorizationDigest({
      grant,
      leaseReservations,
    }),
  };
}

export function readIncidentPlusPreflightAuthorizationPackage({ executionRoot, plan }) {
  const root = path.join(path.resolve(executionRoot), 'preflight-authorization');
  const grant = readRegularJson(
    path.join(root, INCIDENT_PLUS_PREFLIGHT_GRANT_FILE),
    'incident Plus preflight grant',
  );
  verifyIncidentPlusPreflightGrant(grant, plan);
  const reservationsRoot = path.join(root, INCIDENT_PLUS_PREFLIGHT_RESERVATION_DIRECTORY);
  const leaseReservations = plan.cells.map((cell, index) => readRegularJson(
    path.join(reservationsRoot, incidentPlusPreflightReservationFileName(cell, index)),
    `incident Plus preflight reservation ${index + 1}`,
  ));
  verifyIncidentPlusPreflightLeaseReservations(leaseReservations, grant, plan);
  return {
    authorizationRoot: root,
    grant,
    leaseReservations,
    authorizationDigest: incidentPlusPreflightAuthorizationDigest({ grant, leaseReservations }),
  };
}

export function verifyIncidentPlusPreflightLeaseReservations(reservations, grant, plan) {
  verifyIncidentPlusPreflightGrant(grant, plan);
  if (!Array.isArray(reservations) || reservations.length !== INCIDENT_PLUS_CELLS.length) {
    throw new Error('incident Plus preflight requires exactly three lease reservations');
  }
  for (const [index, reservation] of reservations.entries()) {
    const cell = grant.cells[index];
    verifyCoordinatorAuthority(reservation, grant.coordinator.publicKeyPem, `incident Plus preflight reservation ${index + 1}`);
    if (
      reservation?.schemaVersion !== INCIDENT_PLUS_AUTHORITY_SCHEMA_VERSION
      || reservation.artifactKind !== INCIDENT_PLUS_PREFLIGHT_RESERVATION_KIND
      || reservation.incidentId !== INCIDENT_REPLAY_PLUS_ID
      || reservation.executionId !== grant.executionId
      || reservation.grantDigest !== grant.digest
      || Number(reservation.cellIndex) !== index
      || reservation.cellId !== cell.cellId
      || reservation.workerId !== cell.workerId
      || Number(reservation.waveIndex) !== Number(cell.waveIndex)
      || reservation.leaseId !== cell.leaseId
      || Number(reservation.maxExternalAudioSamples) !== INCIDENT_PLUS_CELL_MAX_EXTERNAL_AUDIO_SAMPLES
      || reservation.expiresAt !== grant.expiresAt
      || Date.parse(String(reservation.issuedAt ?? '')) <= Date.parse(grant.generatedAt)
      || Date.parse(String(reservation.issuedAt ?? '')) >= Date.parse(grant.expiresAt)
      || reservation.reclaimPolicy !== 'never-within-execution'
      || reservation.retryPolicy !== 'new-execution-required'
    ) throw new Error(`incident Plus preflight reservation ${index + 1} does not match its signed grant`);
  }
  return reservations;
}

export function incidentPlusPreflightAuthorizationConsumption({ grant, leaseReservations }) {
  return {
    schemaVersion: INCIDENT_PLUS_AUTHORITY_SCHEMA_VERSION,
    artifactKind: INCIDENT_PLUS_PREFLIGHT_CONSUMPTION_KIND,
    incidentId: INCIDENT_REPLAY_PLUS_ID,
    executionId: grant.executionId,
    grantDigest: grant.digest,
    leaseReservationDigests: leaseReservations.map((reservation) => reservation.digest),
    authorizationDigest: incidentPlusPreflightAuthorizationDigest({ grant, leaseReservations }),
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

function assertIncidentPlusPreflightClaim({ claimPath, grant, consumption, workspaceRoot = repoRoot }) {
  const claim = readRegularJson(claimPath, 'incident Plus preflight consumption claim');
  const desktop = grant.runtimeBinaryHashes.find((entry) => (
    entry.path === 'target/release/omni-desktop-shell.exe'
  ));
  const desktopPath = path.resolve(workspaceRoot, 'target', 'release', 'omni-desktop-shell.exe');
  const desktopAuthority = fileAuthorityEntry(desktopPath, 'target/release/omni-desktop-shell.exe');
  const expectedKeys = [
    'artifactKind', 'authorizationDigest', 'claimedAt', 'coordinatorKeyId',
    'desktopExecutableBytes', 'desktopExecutablePath', 'desktopExecutableRelativePath',
    'desktopExecutableSha256', 'desktopProcessId', 'executionId', 'grantDigest',
    'incidentId', 'retryPolicy', 'schemaVersion',
  ].sort();
  if (
    canonicalJson(Object.keys(claim).sort()) !== canonicalJson(expectedKeys)
    || claim.schemaVersion !== INCIDENT_PLUS_AUTHORITY_SCHEMA_VERSION
    || claim.artifactKind !== INCIDENT_PLUS_PREFLIGHT_CONSUMPTION_CLAIM_KIND
    || claim.incidentId !== INCIDENT_REPLAY_PLUS_ID
    || claim.executionId !== grant.executionId
    || claim.grantDigest !== grant.digest
    || claim.authorizationDigest !== consumption.authorizationDigest
    || claim.coordinatorKeyId !== grant.signature?.keyId
    || !ISO_DATE(claim.claimedAt)
    || Date.parse(claim.claimedAt) < Math.max(...consumption.reservationIssuedAts.map(Date.parse))
    || !Number.isInteger(Number(claim.desktopProcessId))
    || Number(claim.desktopProcessId) <= 0
    || claim.desktopExecutableRelativePath !== desktopAuthority.path
    || path.resolve(String(claim.desktopExecutablePath ?? '')) !== desktopPath
    || Number(claim.desktopExecutableBytes) !== Number(desktop?.bytes)
    || claim.desktopExecutableSha256 !== desktop?.sha256
    || Number(claim.desktopExecutableBytes) !== desktopAuthority.bytes
    || claim.desktopExecutableSha256 !== desktopAuthority.sha256
    || claim.retryPolicy !== 'new-execution-required'
  ) throw new Error('incident Plus preflight consumption claim does not bind the signed authorization/runtime');
  return {
    ...claim,
    ...fileAuthorityEntry(claimPath, INCIDENT_PLUS_PREFLIGHT_CONSUMPTION_CLAIM_FILE),
  };
}

export function createIncidentPlusPreflightCompletion({
  plan,
  leases,
  grant,
  leaseReservations,
  evidenceDirectory,
  authorizationRoot,
  completedAt = new Date(),
  signingKeys,
  workspaceRoot = repoRoot,
  validateRawEvidence = validateProviderPreflightRawAuthority,
}) {
  verifyIncidentPlusExecutionPlan(plan, { now: completedAt });
  verifyIncidentPlusPreflightGrant(grant, plan);
  verifyIncidentPlusPreflightLeaseReservations(leaseReservations, grant, plan);
  assertSigningKeys(signingKeys);
  if (signingKeys.publicKeyPem !== plan.coordinator.publicKeyPem) {
    throw new Error('incident Plus preflight completion signer does not match plan coordinator');
  }
  const resolvedAuthorizationRoot = path.resolve(authorizationRoot);
  const executionRoot = path.dirname(resolvedAuthorizationRoot);
  const resolvedEvidenceDirectory = path.resolve(evidenceDirectory);
  const evidenceRelativePath = portable(path.relative(executionRoot, resolvedEvidenceDirectory));
  if (
    !evidenceRelativePath
    || evidenceRelativePath.startsWith('../')
    || path.isAbsolute(evidenceRelativePath)
    || evidenceRelativePath.includes('/')
  ) {
    throw new Error('incident Plus preflight raw evidence must be a direct execution-root child directory');
  }
  const consumption = incidentPlusPreflightAuthorizationConsumption({ grant, leaseReservations });
  const claim = assertIncidentPlusPreflightClaim({
    claimPath: path.join(resolvedAuthorizationRoot, INCIDENT_PLUS_PREFLIGHT_CONSUMPTION_CLAIM_FILE),
    grant,
    consumption,
    workspaceRoot,
  });
  const expectedAuthorization = { ...consumption, consumptionClaim: claim };
  const raw = validateRawEvidence(resolvedEvidenceDirectory, {
    currentProvenance: plan.provenance,
    now: completedAt instanceof Date ? completedAt.getTime() : Date.parse(completedAt),
    expectedAuthorization,
  });
  if (raw?.issues?.length > 0 || !raw?.summary) {
    throw new Error(`incident Plus preflight raw authority failed: ${(raw?.issues ?? ['missing summary']).join('; ')}`);
  }
  const summary = raw.summary;
  if (
    summary.providerId !== consumption.providerId
    || summary.model !== consumption.model
    || summary.protocol !== consumption.protocol
    || summary.operation !== consumption.operation
    || summary.inputMode !== consumption.inputMode
    || Number(summary.providerInvocationCount) !== 1
    || Number(summary.externalAudioSamples) !== 0
    || Number(summary.inputTokens) > consumption.tokenBudget.maxInputTokens
    || Number(summary.outputTokens) > consumption.tokenBudget.maxOutputTokens
    || (summary.audioSeconds != null && Number(summary.audioSeconds) !== 0)
  ) throw new Error('incident Plus preflight raw evidence does not match its exact text-only authority');
  const completedAtIso = completedAt instanceof Date ? completedAt.toISOString() : String(completedAt);
  const core = {
    schemaVersion: INCIDENT_PLUS_AUTHORITY_SCHEMA_VERSION,
    artifactKind: INCIDENT_PLUS_PREFLIGHT_KIND,
    authorityMode: 'signed-consumption-v1',
    incidentId: INCIDENT_REPLAY_PLUS_ID,
    completedAt: completedAtIso,
    status: 'completed',
    executionId: plan.executionId,
    planDigest: plan.planDigest,
    sourceHeadCommit: plan.provenance.headCommit,
    runtimeBundleDigest: plan.authority.runtimeBundleDigest,
    providerId: summary.providerId,
    modelId: summary.model,
    protocol: summary.protocol,
    operation: summary.operation,
    inputMode: summary.inputMode,
    invocationCount: summary.providerInvocationCount,
    externalAudioSamples: summary.externalAudioSamples,
    auxiliaryExternalAudioSeconds: 0,
    tokenBudget: structuredClone(consumption.tokenBudget),
    inputTokens: summary.inputTokens,
    outputTokens: summary.outputTokens,
    leaseDigests: leases.map((lease) => lease.leaseDigest),
    grantDigest: grant.digest,
    authorizationDigest: consumption.authorizationDigest,
    leaseReservationDigests: structuredClone(consumption.leaseReservationDigests),
    consumptionClaim: claim,
    rawEvidence: {
      path: evidenceRelativePath,
      ...hashProviderPreflightArtifact(resolvedEvidenceDirectory),
    },
  };
  return signedWithNamedDigest(core, 'preflightDigest', signingKeys);
}

export function createIncidentPlusTextOnlyPreflight({
  plan,
  leases,
  completedAt = new Date(),
  inputTokens,
  outputTokens,
  rawEvidencePath,
  signingKeys,
}) {
  verifyIncidentPlusExecutionPlan(plan, { now: completedAt });
  assertSigningKeys(signingKeys);
  if (signingKeys.publicKeyPem !== plan.coordinator.publicKeyPem) {
    throw new Error('incident Plus preflight signer does not match the plan coordinator');
  }
  if (!Array.isArray(leases) || leases.length !== INCIDENT_PLUS_CELLS.length) {
    throw new Error('incident Plus preflight requires all three signed cell leases');
  }
  const verifiedLeases = leases.map((lease) => verifyIncidentPlusCellLease(lease, plan, { now: completedAt }));
  if (verifiedLeases.some((cell, index) => cell.cellIndex !== index)) {
    throw new Error('incident Plus preflight leases do not match the fixed cells');
  }
  const input = Number(inputTokens);
  const output = Number(outputTokens);
  if (!Number.isSafeInteger(input) || input < 0 || input > 4_096
    || !Number.isSafeInteger(output) || output < 0 || output > 256) {
    throw new Error('incident Plus text preflight token use is outside its fixed bounds');
  }
  const completedAtIso = completedAt instanceof Date ? completedAt.toISOString() : String(completedAt);
  const core = {
    schemaVersion: INCIDENT_PLUS_AUTHORITY_SCHEMA_VERSION,
    artifactKind: INCIDENT_PLUS_PREFLIGHT_KIND,
    // Kept only for low-level fixture construction.  It is intentionally
    // rejected by manifest verification so a production run cannot forge a
    // successful preflight without the Desktop consumption claim.
    authorityMode: 'fixture-only-not-valid-for-manifest',
    incidentId: INCIDENT_REPLAY_PLUS_ID,
    completedAt: completedAtIso,
    status: 'completed',
    executionId: plan.executionId,
    planDigest: plan.planDigest,
    sourceHeadCommit: plan.provenance.headCommit,
    runtimeBundleDigest: plan.authority.runtimeBundleDigest,
    providerId: INCIDENT_REPLAY_PLUS_PROVIDER_IDENTITY.providerId,
    modelId: INCIDENT_REPLAY_PLUS_MODEL,
    protocol: INCIDENT_REPLAY_PLUS_MODEL_PROTOCOLS[INCIDENT_REPLAY_PLUS_MODEL],
    operation: 'text-translation-preflight',
    inputMode: 'text-only',
    invocationCount: 1,
    externalAudioSamples: 0,
    auxiliaryExternalAudioSeconds: 0,
    tokenBudget: { maxInputTokens: 4_096, maxOutputTokens: 256 },
    inputTokens: input,
    outputTokens: output,
    leaseDigests: leases.map((lease) => lease.leaseDigest),
    rawEvidence: fileAuthorityEntry(rawEvidencePath, path.basename(rawEvidencePath)),
  };
  return signedWithNamedDigest(core, 'preflightDigest', signingKeys);
}

export function verifyIncidentPlusTextOnlyPreflight(
  preflight,
  plan,
  leases,
  { now = new Date(), executionRoot = null } = {},
) {
  verifyIncidentPlusExecutionPlan(plan, { now });
  if (preflight?.schemaVersion !== INCIDENT_PLUS_AUTHORITY_SCHEMA_VERSION
    || preflight.artifactKind !== INCIDENT_PLUS_PREFLIGHT_KIND
    || preflight.incidentId !== INCIDENT_REPLAY_PLUS_ID
    || preflight.authorityMode !== 'signed-consumption-v1') {
    throw new Error('unsupported incident Plus preflight receipt');
  }
  verifyCoordinatorAuthority(preflight, plan.coordinator.publicKeyPem, 'incident Plus text preflight');
  if (preflight.preflightDigest !== sha256Canonical(preflightUnsigned(preflight))) {
    throw new Error('incident Plus preflightDigest mismatch');
  }
  const completedAt = assertIso(preflight.completedAt, 'incident Plus preflight completedAt');
  if (completedAt < Date.parse(plan.generatedAt) || completedAt >= Date.parse(plan.expiresAt)
    || completedAt > Number(now instanceof Date ? now.getTime() : now) + 300_000) {
    throw new Error('incident Plus preflight occurred outside its signed execution window');
  }
  const expectedLeaseDigests = leases.map((lease) => {
    verifyIncidentPlusCellLease(lease, plan, { now });
    return lease.leaseDigest;
  });
  if (
    preflight.status !== 'completed'
    || preflight.executionId !== plan.executionId
    || preflight.planDigest !== plan.planDigest
    || preflight.sourceHeadCommit !== plan.provenance.headCommit
    || preflight.runtimeBundleDigest !== plan.authority.runtimeBundleDigest
    || preflight.providerId !== INCIDENT_REPLAY_PLUS_PROVIDER_IDENTITY.providerId
    || preflight.modelId !== INCIDENT_REPLAY_PLUS_MODEL
    || preflight.protocol !== INCIDENT_REPLAY_PLUS_MODEL_PROTOCOLS[INCIDENT_REPLAY_PLUS_MODEL]
    || preflight.operation !== 'text-translation-preflight'
    || preflight.inputMode !== 'text-only'
    || Number(preflight.invocationCount) !== 1
    || Number(preflight.externalAudioSamples) !== 0
    || Number(preflight.auxiliaryExternalAudioSeconds) !== 0
    || canonicalJson(preflight.tokenBudget) !== canonicalJson({ maxInputTokens: 4_096, maxOutputTokens: 256 })
    || !Number.isSafeInteger(Number(preflight.inputTokens))
    || Number(preflight.inputTokens) < 0 || Number(preflight.inputTokens) > 4_096
    || !Number.isSafeInteger(Number(preflight.outputTokens))
    || Number(preflight.outputTokens) < 0 || Number(preflight.outputTokens) > 256
    || canonicalJson(preflight.leaseDigests) !== canonicalJson(expectedLeaseDigests)
    || !SHA256.test(String(preflight.grantDigest ?? ''))
    || !SHA256.test(String(preflight.authorizationDigest ?? ''))
    || !Array.isArray(preflight.leaseReservationDigests)
    || preflight.leaseReservationDigests.length !== INCIDENT_PLUS_CELLS.length
    || preflight.leaseReservationDigests.some((digest) => !SHA256.test(String(digest)))
    || !preflight.consumptionClaim
    || preflight.consumptionClaim.path !== INCIDENT_PLUS_PREFLIGHT_CONSUMPTION_CLAIM_FILE
    || !Number.isInteger(Number(preflight.consumptionClaim.bytes))
    || Number(preflight.consumptionClaim.bytes) <= 0
    || !SHA256.test(String(preflight.consumptionClaim.sha256 ?? ''))
    || !preflight.rawEvidence
    || preflight.rawEvidence.kind !== 'directory'
    || !SHA256.test(String(preflight.rawEvidence.sha256 ?? ''))
    || !Number.isInteger(Number(preflight.rawEvidence.fileCount))
    || Number(preflight.rawEvidence.fileCount) < 3
    || !Number.isInteger(Number(preflight.rawEvidence.byteCount))
    || Number(preflight.rawEvidence.byteCount) <= 0
  ) throw new Error('incident Plus preflight does not prove exactly one bounded text-only Plus invocation');
  if (executionRoot) {
    const root = path.resolve(executionRoot);
    const authorizationPackage = readIncidentPlusPreflightAuthorizationPackage({ executionRoot: root, plan });
    if (
      preflight.grantDigest !== authorizationPackage.grant.digest
      || preflight.authorizationDigest !== authorizationPackage.authorizationDigest
      || canonicalJson(preflight.leaseReservationDigests)
        !== canonicalJson(authorizationPackage.leaseReservations.map((reservation) => reservation.digest))
    ) throw new Error('incident Plus preflight does not match its signed authorization package');
    const claimPath = path.join(root, 'preflight-authorization', INCIDENT_PLUS_PREFLIGHT_CONSUMPTION_CLAIM_FILE);
    const claimAuthority = fileAuthorityEntry(claimPath, INCIDENT_PLUS_PREFLIGHT_CONSUMPTION_CLAIM_FILE);
    const claim = readRegularJson(claimPath, 'incident Plus preflight consumption claim');
    if (canonicalJson(preflight.consumptionClaim) !== canonicalJson({ ...claim, ...claimAuthority })) {
      throw new Error('incident Plus preflight consumption claim hash/size no longer matches disk');
    }
    const rawEvidenceRoot = path.join(root, String(preflight.rawEvidence.path));
    const rawAuthority = hashProviderPreflightArtifact(rawEvidenceRoot);
    if (canonicalJson(rawAuthority) !== canonicalJson({
      kind: preflight.rawEvidence.kind,
      sha256: preflight.rawEvidence.sha256,
      fileCount: preflight.rawEvidence.fileCount,
      byteCount: preflight.rawEvidence.byteCount,
    })) {
      throw new Error('incident Plus preflight raw evidence hash/size no longer matches disk');
    }
  }
  return preflight;
}

function allTimelineEvents(watchSessionReport) {
  const root = Array.isArray(watchSessionReport?.events) ? watchSessionReport.events : [];
  const nested = (Array.isArray(watchSessionReport?.cues) ? watchSessionReport.cues : [])
    .flatMap((cue) => Array.isArray(cue?.events) ? cue.events : []);
  return [...root, ...nested];
}

export function validateIncidentPlusWatchReport({ report, watchSessionReport, cell }) {
  assertObject(report, 'incident Plus runtime report');
  assertObject(watchSessionReport, 'incident Plus watch session report');
  const violations = [];
  if (report.verdict !== 'passed') violations.push(`runtime report verdict is ${report.verdict ?? 'missing'}`);
  if (report.modelId !== INCIDENT_REPLAY_PLUS_MODEL) violations.push('runtime report modelId is not Plus');
  if (report.feedbackLoopPrevention !== cell.feedbackLoopPrevention) violations.push('runtime report feedback mode mismatch');
  if (watchSessionReport.model !== INCIDENT_REPLAY_PLUS_MODEL) violations.push('watch session report model is not Plus');
  if (watchSessionReport.status !== 'completed') violations.push('watch session report is not completed');
  for (const [layerName, layer] of Object.entries(report.layers ?? {})) {
    if (layer?.status && !['passed', 'skipped'].includes(layer.status)) {
      violations.push(`required report layer ${layerName} is ${layer.status}`);
    }
  }
  if (cell.feedbackLoopPrevention !== 'echo-cancel'
    && report.layers?.strictContent?.status !== 'passed') {
    violations.push('canonical strict-content layer did not pass');
  }
  if (cell.feedbackLoopPrevention === 'echo-cancel') {
    const aec = report.layers?.aec;
    const data = aec?.data ?? {};
    if (aec?.status !== 'passed') violations.push('AEC report layer did not pass');
    if (Number(data.maxResetCount ?? 0) !== 0) violations.push(`AEC reset count is abnormal: ${data.maxResetCount}`);
    if (Number(data.maxRenderUnderruns ?? 0) !== 0 || Number(data.maxCaptureUnderruns ?? 0) !== 0) {
      violations.push(`AEC underrun count is abnormal: render=${data.maxRenderUnderruns ?? 0} capture=${data.maxCaptureUnderruns ?? 0}`);
    }
    if (Number(data.maxAsrDeletedChunks ?? -1) !== 0) {
      violations.push('AEC deleted ASR capture chunks');
    }
  }
  const serialized = JSON.stringify(watchSessionReport);
  const historicalReasonHits = INCIDENT_PLUS_REQUIRED_HISTORY_REASONS.filter((reason) => serialized.includes(reason));
  const playbackIssueHits = INCIDENT_PLUS_FORBIDDEN_PLAYBACK_ISSUES.filter((issue) => serialized.includes(issue));
  if (historicalReasonHits.length > 0) violations.push(`historical text echo suppression was emitted: ${historicalReasonHits.join(', ')}`);
  if (playbackIssueHits.length > 0) violations.push(`normal native playback queue issue was emitted: ${playbackIssueHits.join(', ')}`);
  const nonEmptySourceFinals = allTimelineEvents(watchSessionReport).filter((event) => (
    event?.stage === 'source'
    && event?.finalEvent === true
    && String(event?.text ?? '').trim().length > 0
  ));
  if (nonEmptySourceFinals.length === 0) violations.push('watch session report has no non-empty source final');
  const rejectedSourceFinals = nonEmptySourceFinals.filter((event) => event.accepted !== true);
  if (rejectedSourceFinals.length > 0) violations.push(`watch session report rejected ${rejectedSourceFinals.length} non-empty source final(s)`);
  const completedCues = (Array.isArray(watchSessionReport.cues) ? watchSessionReport.cues : []).filter((cue) => (
    ['exact', 'formatting-only'].includes(cue?.comparisonStatus)
    && String(cue?.sourceText ?? '').trim()
    && String(cue?.publishedText ?? '').trim()
  ));
  if (completedCues.length === 0) violations.push('watch session report has no published completed cue');
  return {
    passed: violations.length === 0,
    nonEmptySourceFinalCount: nonEmptySourceFinals.length,
    rejectedNonEmptySourceFinalCount: rejectedSourceFinals.length,
    completedCueCount: completedCues.length,
    historicalReasonHits,
    playbackIssueHits,
    aecChecked: cell.feedbackLoopPrevention === 'echo-cancel',
    violations,
  };
}

function collectRunArtifacts(runDirectory) {
  const root = path.resolve(runDirectory);
  const entries = [];
  const visit = (directory) => {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const child = path.join(directory, item.name);
      const relativePath = portable(path.relative(root, child));
      const stats = fs.lstatSync(child);
      if (stats.isSymbolicLink()) throw new Error(`incident Plus run contains a symlink: ${relativePath}`);
      if (stats.isDirectory()) visit(child);
      else if (stats.isFile() && relativePath !== INCIDENT_PLUS_CELL_RESULT_FILE) {
        entries.push(fileAuthorityEntry(child, relativePath, { allowEmpty: true }));
      } else if (!stats.isFile()) throw new Error(`incident Plus run has unsupported artifact: ${relativePath}`);
    }
  };
  visit(root);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function resultUnsigned(result) {
  const { resultDigest, ...core } = result;
  return core;
}

export function buildIncidentPlusCellResult({
  plan,
  lease,
  workerId,
  vmIdentity,
  executionRoot,
  runDirectory,
  readinessReceiptPath,
  readinessRequest,
  generatedAt = new Date(),
  currentProvenance = plan.provenance,
  currentAuthorityImplementationHashes = plan.authority.implementationHashes,
  currentRuntimeBinaryHashes = plan.authority.runtimeBinaryHashes,
  currentIncidentImplementationHashes = plan.authority.incidentImplementationHashes,
  assertExternalProviderBudget = assertCellExternalProviderBudget,
}) {
  verifyIncidentPlusExecutionPlan(plan, {
    now: generatedAt,
    currentProvenance,
    currentAuthorityImplementationHashes,
    currentRuntimeBinaryHashes,
    currentIncidentImplementationHashes,
  });
  const cell = verifyIncidentPlusCellLease(lease, plan, { now: generatedAt });
  const worker = plan.workers.find((entry) => entry.workerId === workerId);
  if (!worker || cell.workerId !== workerId || canonicalJson(worker.vmIdentity) !== canonicalJson(vmIdentity)) {
    throw new Error('incident Plus result worker/VM does not match its signed lease');
  }
  const root = path.resolve(executionRoot);
  const run = path.resolve(runDirectory);
  const relative = portable(path.relative(root, run));
  if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) {
    throw new Error('incident Plus run directory escapes its execution root');
  }
  const report = readRegularJson(path.join(run, 'report.json'), 'incident Plus report');
  const watchSessionReport = readRegularJson(path.join(run, 'watch-session-report.json'), 'incident Plus watch session report');
  const historicalRegressionChecks = validateIncidentPlusWatchReport({ report, watchSessionReport, cell });
  if (!historicalRegressionChecks.passed) {
    throw new Error(`incident Plus historical regression failed: ${historicalRegressionChecks.violations.join('; ')}`);
  }
  const readiness = validateIncidentPlusWorkerReadiness({
    receiptPath: readinessReceiptPath,
    request: readinessRequest,
    plan,
    now: generatedAt,
    authorityPath: portable(path.relative(root, path.resolve(readinessReceiptPath))),
  });
  const externalProviderBudget = assertExternalProviderBudget(run, {
    cellId: cell.cellId,
    modelId: cell.modelId,
    feedbackLoopPrevention: cell.feedbackLoopPrevention,
    inputCeilingSamples: cell.maxExternalAudioSamples,
    approvedModels: [INCIDENT_REPLAY_PLUS_MODEL],
    modelProtocols: INCIDENT_REPLAY_PLUS_MODEL_PROTOCOLS,
    providerIdentity: INCIDENT_REPLAY_PLUS_PROVIDER_IDENTITY,
    authorityMode: 'incident-replay-plus',
  });
  if (externalProviderBudget.incidentId !== INCIDENT_REPLAY_PLUS_ID) {
    throw new Error('incident Plus external provider budget is missing incidentId');
  }
  const artifacts = collectRunArtifacts(run);
  for (const required of ['report.json', 'watch-session-report.json', 'external-provider-budget.json']) {
    if (!artifacts.some((entry) => entry.path === required)) {
      throw new Error(`incident Plus run is missing ${required}`);
    }
  }
  const core = {
    schemaVersion: INCIDENT_PLUS_AUTHORITY_SCHEMA_VERSION,
    artifactKind: INCIDENT_PLUS_CELL_RESULT_KIND,
    incidentId: INCIDENT_REPLAY_PLUS_ID,
    generatedAt: generatedAt instanceof Date ? generatedAt.toISOString() : String(generatedAt),
    verdict: 'passed',
    executionId: plan.executionId,
    planDigest: plan.planDigest,
    leaseId: lease.leaseId,
    leaseDigest: lease.leaseDigest,
    cell: { ...cellProjection(cell), cellIndex: cell.cellIndex, waveIndex: cell.waveIndex },
    worker: { workerId, vmIdentity: structuredClone(vmIdentity), vmIdentityDigest: worker.vmIdentityDigest },
    runDirectory: relative,
    provenance: structuredClone(plan.provenance),
    authority: structuredClone(plan.authority),
    cellLease: fileAuthorityEntry(path.join(root, 'leases', `${cell.cellIndex + 1}.json`), `leases/${cell.cellIndex + 1}.json`),
    workerReadiness: readiness.authority,
    externalProviderBudget,
    historicalRegressionChecks,
    artifacts,
  };
  return { ...core, resultDigest: sha256Canonical(core) };
}

export function writeIncidentPlusCellResult(options) {
  const result = buildIncidentPlusCellResult(options);
  const resultPath = path.join(path.resolve(options.runDirectory), INCIDENT_PLUS_CELL_RESULT_FILE);
  atomicWriteJson(resultPath, result);
  return { resultPath, result };
}

export function validateIncidentPlusCellResult({
  resultPath,
  plan,
  lease,
  executionRoot,
  readinessReceiptPath,
  readinessRequest,
  now = new Date(),
  assertExternalProviderBudget = assertCellExternalProviderBudget,
}) {
  const result = readRegularJson(resultPath, 'incident Plus cell result');
  const plannedCell = verifyIncidentPlusCellLease(lease, plan, { now });
  if (result.schemaVersion !== INCIDENT_PLUS_AUTHORITY_SCHEMA_VERSION
    || result.artifactKind !== INCIDENT_PLUS_CELL_RESULT_KIND
    || result.incidentId !== INCIDENT_REPLAY_PLUS_ID
    || result.verdict !== 'passed'
    || result.resultDigest !== sha256Canonical(resultUnsigned(result))) {
    throw new Error('incident Plus cell result schema/verdict/digest is invalid');
  }
  if (
    result.executionId !== plan.executionId
    || result.planDigest !== plan.planDigest
    || result.leaseId !== lease.leaseId
    || result.leaseDigest !== lease.leaseDigest
    || Number(result.cell?.cellIndex) !== plannedCell.cellIndex
    || result.cell?.cellId !== plannedCell.cellId
    || result.worker?.workerId !== plannedCell.workerId
    || result.worker?.vmIdentityDigest !== plannedCell.vmIdentityDigest
    || canonicalJson(result.provenance) !== canonicalJson(plan.provenance)
    || canonicalJson(result.authority) !== canonicalJson(plan.authority)
  ) throw new Error('incident Plus cell result plan/lease/provenance binding mismatch');
  const root = path.resolve(executionRoot);
  const run = path.resolve(root, ...String(result.runDirectory).split('/'));
  if (path.resolve(resultPath) !== path.join(run, INCIDENT_PLUS_CELL_RESULT_FILE)) {
    throw new Error('incident Plus result file is not in its declared run directory');
  }
  const rebuilt = buildIncidentPlusCellResult({
    plan,
    lease,
    workerId: result.worker.workerId,
    vmIdentity: result.worker.vmIdentity,
    executionRoot: root,
    runDirectory: run,
    readinessReceiptPath,
    readinessRequest,
    generatedAt: result.generatedAt,
    assertExternalProviderBudget,
  });
  if (canonicalJson(result) !== canonicalJson(rebuilt)) {
    throw new Error('incident Plus cell result no longer matches raw evidence');
  }
  return { result, runDirectory: run, cell: plannedCell };
}

function manifestUnsigned(manifest) {
  const { signature, digest, manifestDigest, ...core } = manifest;
  return core;
}

export function buildIncidentPlusManifest({
  plan,
  leases,
  preflight,
  executionRoot,
  resultPaths,
  readinessReceiptPaths,
  readinessRequests,
  generatedAt = new Date(),
  signingKeys,
  assertExternalProviderBudget = assertCellExternalProviderBudget,
}) {
  verifyIncidentPlusExecutionPlan(plan, { now: generatedAt });
  assertSigningKeys(signingKeys);
  if (signingKeys.publicKeyPem !== plan.coordinator.publicKeyPem) {
    throw new Error('incident Plus manifest signer does not match plan coordinator');
  }
  if (!Array.isArray(leases) || leases.length !== INCIDENT_PLUS_CELLS.length
    || !Array.isArray(resultPaths) || resultPaths.length !== INCIDENT_PLUS_CELLS.length
    || !Array.isArray(readinessReceiptPaths) || readinessReceiptPaths.length !== plan.workers.length
    || !Array.isArray(readinessRequests) || readinessRequests.length !== plan.workers.length) {
    throw new Error('incident Plus manifest requires all leases, results, and two worker readiness receipts');
  }
  verifyIncidentPlusTextOnlyPreflight(preflight, plan, leases, {
    now: generatedAt,
    executionRoot,
  });
  const requestByWorker = new Map();
  const readinessByWorker = new Map();
  for (const request of readinessRequests) {
    const worker = validateIncidentPlusReadinessRequest(request, plan);
    if (requestByWorker.has(worker.workerId)) throw new Error('incident Plus manifest has duplicate readiness requests');
    requestByWorker.set(worker.workerId, request);
  }
  for (const receiptPath of readinessReceiptPaths) {
    const receipt = readRegularJson(receiptPath, 'incident Plus worker readiness receipt');
    const request = requestByWorker.get(receipt.workerId);
    const checked = validateIncidentPlusWorkerReadiness({
      receiptPath,
      request,
      plan,
      now: generatedAt,
      authorityPath: portable(path.relative(path.resolve(executionRoot), path.resolve(receiptPath))),
    });
    if (readinessByWorker.has(checked.worker.workerId)) throw new Error('incident Plus manifest has duplicate readiness receipts');
    readinessByWorker.set(checked.worker.workerId, checked);
  }
  if (readinessByWorker.size !== plan.workers.length) throw new Error('incident Plus worker readiness coverage is incomplete');
  const root = path.resolve(executionRoot);
  const leaseById = new Map(leases.map((lease) => [lease.leaseId, lease]));
  const resultEntries = resultPaths.map((resultPath, index) => {
    const raw = readRegularJson(resultPath, 'incident Plus cell result');
    const lease = leaseById.get(raw.leaseId);
    if (!lease) throw new Error(`incident Plus result ${index + 1} has no signed lease`);
    const request = requestByWorker.get(raw.worker?.workerId);
    const readiness = readinessByWorker.get(raw.worker?.workerId);
    const checked = validateIncidentPlusCellResult({
      resultPath,
      plan,
      lease,
      executionRoot: root,
      readinessReceiptPath: path.join(root, readiness.authority.path),
      readinessRequest: request,
      now: generatedAt,
      assertExternalProviderBudget,
    });
    return { checked, raw };
  }).sort((left, right) => left.checked.cell.cellIndex - right.checked.cell.cellIndex);
  if (canonicalJson(resultEntries.map(({ checked }) => checked.cell.cellId))
    !== canonicalJson(plan.cells.map((cell) => cell.cellId))) {
    throw new Error('incident Plus manifest results do not match all three fixed cells');
  }
  const budgets = resultEntries.map(({ raw }) => raw.externalProviderBudget);
  const aggregateBudget = buildMatrixExternalProviderBudget(budgets, {
    generatedAt,
    matrixInputSampleCeiling: INCIDENT_PLUS_MAX_EXTERNAL_AUDIO_SAMPLES,
    expectedCells: INCIDENT_PLUS_CELLS,
  });
  if (!aggregateBudget.passed) throw new Error(`incident Plus aggregate budget failed: ${aggregateBudget.violations.join('; ')}`);
  const core = {
    schemaVersion: INCIDENT_PLUS_AUTHORITY_SCHEMA_VERSION,
    artifactKind: INCIDENT_PLUS_MANIFEST_KIND,
    incidentId: INCIDENT_REPLAY_PLUS_ID,
    generatedAt: generatedAt instanceof Date ? generatedAt.toISOString() : String(generatedAt),
    verdict: 'passed',
    executionId: plan.executionId,
    planDigest: plan.planDigest,
    provenance: structuredClone(plan.provenance),
    authority: structuredClone(plan.authority),
    preflight: structuredClone(preflight),
    cellLeases: leases.map((lease, index) => ({
      cellIndex: index,
      cellId: plan.cells[index].cellId,
      leaseId: lease.leaseId,
      leaseDigest: lease.leaseDigest,
      authority: fileAuthorityEntry(path.join(root, 'leases', `${index + 1}.json`), `leases/${index + 1}.json`),
    })),
    workerReadiness: plan.workers.map((worker) => ({
      workerId: worker.workerId,
      requestDigest: requestByWorker.get(worker.workerId).requestDigest,
      authority: readinessByWorker.get(worker.workerId).authority,
    })),
    externalProviderBudget: {
      ...aggregateBudget,
      incidentId: INCIDENT_REPLAY_PLUS_ID,
    },
    results: resultEntries.map(({ raw, checked }) => ({
      cellIndex: checked.cell.cellIndex,
      cellId: checked.cell.cellId,
      leaseId: raw.leaseId,
      resultDigest: raw.resultDigest,
      runDirectory: raw.runDirectory,
      authority: fileAuthorityEntry(
        path.join(checked.runDirectory, INCIDENT_PLUS_CELL_RESULT_FILE),
        `${raw.runDirectory}/${INCIDENT_PLUS_CELL_RESULT_FILE}`,
      ),
      historicalRegressionChecks: raw.historicalRegressionChecks,
    })),
  };
  return signedWithNamedDigest(core, 'manifestDigest', signingKeys);
}

export function writeIncidentPlusManifest(options) {
  const root = path.resolve(options.executionRoot);
  const budgetPath = path.join(root, INCIDENT_PLUS_EXTERNAL_BUDGET_FILE);
  const unsignedManifest = buildIncidentPlusManifest(options);
  const budget = unsignedManifest.externalProviderBudget;
  atomicWriteJson(budgetPath, budget);
  const { signature, digest, manifestDigest, ...core } = unsignedManifest;
  const manifest = signedWithNamedDigest({
    ...core,
    externalProviderBudget: {
      ...budget,
      authority: fileAuthorityEntry(budgetPath, INCIDENT_PLUS_EXTERNAL_BUDGET_FILE),
    },
  }, 'manifestDigest', options.signingKeys);
  const manifestPath = path.join(root, INCIDENT_PLUS_MANIFEST_FILE);
  atomicWriteJson(manifestPath, manifest);
  return { manifestPath, manifest };
}

export function validateIncidentPlusManifest({
  manifestPath,
  plan,
  leases,
  executionRoot,
  readinessReceiptPaths,
  readinessRequests,
  now = new Date(),
  assertExternalProviderBudget = assertCellExternalProviderBudget,
}) {
  verifyIncidentPlusExecutionPlan(plan, { now });
  const root = path.resolve(executionRoot);
  if (path.resolve(manifestPath) !== path.join(root, INCIDENT_PLUS_MANIFEST_FILE)) {
    throw new Error('incident Plus manifest must be stored in the execution root');
  }
  const manifest = readRegularJson(manifestPath, 'incident Plus manifest');
  if (manifest.schemaVersion !== INCIDENT_PLUS_AUTHORITY_SCHEMA_VERSION
    || manifest.artifactKind !== INCIDENT_PLUS_MANIFEST_KIND
    || manifest.incidentId !== INCIDENT_REPLAY_PLUS_ID
    || manifest.verdict !== 'passed') throw new Error('unsupported incident Plus manifest');
  verifyCoordinatorAuthority(manifest, plan.coordinator.publicKeyPem, 'incident Plus manifest');
  if (manifest.manifestDigest !== sha256Canonical(manifestUnsigned(manifest))) {
    throw new Error('incident Plus manifestDigest mismatch');
  }
  if (manifest.executionId !== plan.executionId || manifest.planDigest !== plan.planDigest
    || canonicalJson(manifest.provenance) !== canonicalJson(plan.provenance)
    || canonicalJson(manifest.authority) !== canonicalJson(plan.authority)) {
    throw new Error('incident Plus manifest plan/provenance authority mismatch');
  }
  const preflight = verifyIncidentPlusTextOnlyPreflight(manifest.preflight, plan, leases, {
    now,
    executionRoot: root,
  });
  const requestByWorker = new Map(readinessRequests.map((request) => [request.workerId, request]));
  const readinessByWorker = new Map();
  for (const receiptPath of readinessReceiptPaths) {
    const receipt = readRegularJson(receiptPath, 'incident Plus worker readiness receipt');
    readinessByWorker.set(receipt.workerId, validateIncidentPlusWorkerReadiness({
      receiptPath,
      request: requestByWorker.get(receipt.workerId),
      plan,
      now,
      authorityPath: portable(path.relative(root, path.resolve(receiptPath))),
    }));
  }
  if (readinessByWorker.size !== plan.workers.length) throw new Error('incident Plus manifest readiness receipts are incomplete');
  if (!Array.isArray(manifest.results) || manifest.results.length !== INCIDENT_PLUS_CELLS.length) {
    throw new Error('incident Plus manifest must bind all three results');
  }
  const resultPaths = manifest.results.map((entry) => validateFileAuthorityEntry(
    root,
    entry.authority,
    `${entry.runDirectory}/${INCIDENT_PLUS_CELL_RESULT_FILE}`,
    `incident Plus manifest result ${entry.cellIndex + 1}`,
  ));
  const validated = resultPaths.map((resultPath) => {
    const raw = readRegularJson(resultPath, 'incident Plus cell result');
    const lease = leases.find((entry) => entry.leaseId === raw.leaseId);
    return validateIncidentPlusCellResult({
      resultPath,
      plan,
      lease,
      executionRoot: root,
      readinessReceiptPath: path.join(root, readinessByWorker.get(raw.worker.workerId).authority.path),
      readinessRequest: requestByWorker.get(raw.worker.workerId),
      now,
      assertExternalProviderBudget,
    });
  }).sort((left, right) => left.cell.cellIndex - right.cell.cellIndex);
  if (canonicalJson(validated.map((entry) => entry.cell.cellId))
    !== canonicalJson(plan.cells.map((cell) => cell.cellId))) {
    throw new Error('incident Plus manifest result order/cells mismatch');
  }
  const budgetAuthority = validateFileAuthorityEntry(
    root,
    manifest.externalProviderBudget?.authority,
    INCIDENT_PLUS_EXTERNAL_BUDGET_FILE,
    'incident Plus aggregate budget',
  );
  const recordedBudget = readRegularJson(budgetAuthority, 'incident Plus aggregate budget');
  const rebuiltBudget = buildMatrixExternalProviderBudget(validated.map((entry) => entry.result.externalProviderBudget), {
    generatedAt: manifest.externalProviderBudget.generatedAt,
    matrixInputSampleCeiling: INCIDENT_PLUS_MAX_EXTERNAL_AUDIO_SAMPLES,
    expectedCells: INCIDENT_PLUS_CELLS,
  });
  const expectedBudget = { ...rebuiltBudget, incidentId: INCIDENT_REPLAY_PLUS_ID };
  if (canonicalJson(recordedBudget) !== canonicalJson(expectedBudget)
    || canonicalJson(manifest.externalProviderBudget) !== canonicalJson({
      ...expectedBudget,
      authority: manifest.externalProviderBudget.authority,
    })) {
    throw new Error('incident Plus aggregate provider budget mismatch');
  }
  if (!recordedBudget.passed) throw new Error('incident Plus aggregate budget did not pass');
  return { manifest, preflight, validatedResults: validated, externalProviderBudget: recordedBudget };
}

export function writeIncidentPlusVerificationReceipt({
  manifestPath,
  plan,
  leases,
  executionRoot,
  readinessReceiptPaths,
  readinessRequests,
  generatedAt = new Date(),
  signingKeys,
  assertExternalProviderBudget = assertCellExternalProviderBudget,
}) {
  const verified = validateIncidentPlusManifest({
    manifestPath,
    plan,
    leases,
    executionRoot,
    readinessReceiptPaths,
    readinessRequests,
    now: generatedAt,
    assertExternalProviderBudget,
  });
  assertSigningKeys(signingKeys);
  if (signingKeys.publicKeyPem !== plan.coordinator.publicKeyPem) {
    throw new Error('incident Plus verification signer does not match plan coordinator');
  }
  const core = {
    schemaVersion: INCIDENT_PLUS_AUTHORITY_SCHEMA_VERSION,
    artifactKind: INCIDENT_PLUS_VERIFICATION_RECEIPT_KIND,
    incidentId: INCIDENT_REPLAY_PLUS_ID,
    generatedAt: generatedAt instanceof Date ? generatedAt.toISOString() : String(generatedAt),
    verdict: 'passed',
    executionId: plan.executionId,
    planDigest: plan.planDigest,
    manifest: fileAuthorityEntry(manifestPath, INCIDENT_PLUS_MANIFEST_FILE),
    manifestDigest: verified.manifest.manifestDigest,
    runtimeBundleDigest: plan.authority.runtimeBundleDigest,
    externalProviderBudget: {
      actualProviderInputSamples: verified.externalProviderBudget.actualProviderInputSamples,
      actualProviderInputSeconds: verified.externalProviderBudget.actualProviderInputSeconds,
      matrixInputSampleCeiling: verified.externalProviderBudget.matrixInputSampleCeiling,
      auxiliaryExternalAudioSeconds: verified.externalProviderBudget.auxiliaryExternalAudioSeconds,
    },
    historicalRegressionChecks: verified.validatedResults.map((entry) => ({
      cellId: entry.cell.cellId,
      ...entry.result.historicalRegressionChecks,
    })),
  };
  const receipt = signedWithNamedDigest(core, 'verificationDigest', signingKeys);
  const receiptPath = path.join(path.resolve(executionRoot), INCIDENT_PLUS_VERIFICATION_RECEIPT_FILE);
  atomicWriteJson(receiptPath, receipt);
  return { receiptPath, receipt };
}

export function currentIncidentPlusImplementationHashes({ workspaceRoot = repoRoot } = {}) {
  const files = [
    'scripts/testing/watch-mode-incident-plus-authority.mjs',
    'scripts/testing/run-watch-mode-incident-plus.mjs',
    'scripts/testing/run-watch-mode-incident-plus-cell.mjs',
    'scripts/testing/invoke-watch-mode-interactive-task.ps1',
    'scripts/testing/run-watch-mode-interactive-task.ps1',
    'scripts/testing/collect-watch-mode-interactive-process-authority.ps1',
    // Endpoint readiness never launches a paid shard, but the immutable
    // InteractiveToken controller still hashes this legacy runner before it
    // permits the readiness task.  Bind that exact byte sequence here rather
    // than letting the Plus coordinator borrow an unhashed strict artifact.
    'scripts/testing/run-watch-mode-live-shard.mjs',
    'scripts/testing/run-watch-mode-live.ps1',
    'scripts/testing/watch-mode-external-provider-budget.mjs',
    'scripts/testing/watch-mode-provider-preflight-authority.mjs',
    'apps/desktop/src-tauri/src/audio/pcm_resample.rs',
    'apps/desktop/src-tauri/src/audio/omni/mod.rs',
    'apps/desktop/src-tauri/src/audio/omni/audio_pump.rs',
    'apps/desktop/src-tauri/src/audio/omni/session_worker.rs',
    'apps/desktop/src-tauri/src/audio/omni/provider_input_budget.rs',
    'apps/desktop/src-tauri/src/release_evidence_diagnostic/provider_preflight_authority.rs',
  ];
  return files.map((relativePath) => fileAuthorityEntry(
    path.resolve(workspaceRoot, ...relativePath.split('/')),
    relativePath,
  ));
}

export function writeIncidentPlusExecutionPlan({ executionRoot, plan, leases, readinessRequests }) {
  verifyIncidentPlusExecutionPlan(plan);
  const root = path.resolve(executionRoot);
  fs.mkdirSync(path.join(root, 'leases'), { recursive: true });
  atomicWriteJson(path.join(root, INCIDENT_PLUS_EXECUTION_PLAN_FILE), plan);
  leases.forEach((lease, index) => {
    verifyIncidentPlusCellLease(lease, plan);
    atomicWriteJson(path.join(root, 'leases', `${index + 1}.json`), lease);
  });
  readinessRequests.forEach((request) => {
    validateIncidentPlusReadinessRequest(request, plan);
    atomicWriteJson(path.join(root, `worker-readiness-request-${request.workerId}.json`), request);
  });
  return {
    planPath: path.join(root, INCIDENT_PLUS_EXECUTION_PLAN_FILE),
    leasePaths: leases.map((_, index) => path.join(root, 'leases', `${index + 1}.json`)),
  };
}

export function parseIncidentPlusAuthorityCliArgs(argv) {
  return parseCliArgs(argv, {
    defaults: { verifyManifest: '', plan: '', executionRoot: '' },
  });
}

if (isMain(import.meta.url)) {
  try {
    const options = parseIncidentPlusAuthorityCliArgs(process.argv.slice(2));
    if (!options.verifyManifest) throw new Error('--verify-manifest is required');
    console.log(path.resolve(options.verifyManifest));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
