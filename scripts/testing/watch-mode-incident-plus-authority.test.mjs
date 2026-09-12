import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { repoRoot } from '../lib/testing-common.mjs';
import {
  INCIDENT_PLUS_CELL_RESULT_FILE,
  INCIDENT_PLUS_CELLS,
  INCIDENT_PLUS_EXTERNAL_BUDGET_FILE,
  INCIDENT_PLUS_INPUT_SAMPLE_RATE_HZ,
  INCIDENT_PLUS_MANIFEST_FILE,
  INCIDENT_PLUS_MAX_EXTERNAL_AUDIO_SAMPLES,
  INCIDENT_PLUS_MAX_EXTERNAL_AUDIO_SECONDS,
  INCIDENT_PLUS_VERIFICATION_RECEIPT_FILE,
  createIncidentPlusAssignments,
  createIncidentPlusExecutionPlan,
  createIncidentPlusPreflightGrant,
  createIncidentPlusPreflightLeaseReservations,
  createIncidentPlusPreflightCompletion,
  createIncidentPlusReadinessRequests,
  incidentPlusPreflightAuthorizationConsumption,
  issueIncidentPlusCellLeases,
  validateIncidentPlusWatchReport,
  readIncidentPlusPreflightAuthorizationPackage,
  verifyIncidentPlusCellLease,
  verifyIncidentPlusExecutionPlan,
  verifyIncidentPlusPreflightGrant,
  verifyIncidentPlusPreflightLeaseReservations,
  writeIncidentPlusCellResult,
  writeIncidentPlusExecutionPlan,
  writeIncidentPlusManifest,
  writeIncidentPlusPreflightAuthorizationPackage,
  writeIncidentPlusVerificationReceipt,
} from './watch-mode-incident-plus-authority.mjs';
import {
  prepareCurrentIncidentPlusExecution,
  prepareIncidentPlusExecution,
  mapIncidentPlusWorkersSerially,
  parseIncidentPlusCliArgs,
  runIncidentPlusProductionCoordinator,
  stageIncidentPlusCellAuthority,
} from './run-watch-mode-incident-plus.mjs';
import {
  buildIncidentPlusPowerShellRunnerArgv,
  finalizeInteractiveIncidentPlusCell,
  runLeasedIncidentPlusCell,
} from './run-watch-mode-incident-plus-cell.mjs';
import { generateCoordinatorSigningKeyPair } from './watch-mode-shard-authority.mjs';
import {
  INCIDENT_REPLAY_PLUS_ID,
  PROVIDER_INPUT_PREFILTER_FILE,
  PROVIDER_INPUT_PREFILTER_MAGIC,
  replayProviderInputPrefilter,
} from './watch-mode-external-provider-budget.mjs';

test('incident Plus prepares worker runtime bundles serially before paid dispatch', async () => {
  let active = 0;
  let maximumActive = 0;
  const order = [];
  const completed = await mapIncidentPlusWorkersSerially(
    [{ workerId: 'vm1' }, { workerId: 'vm2' }],
    async (worker) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      order.push(`start:${worker.workerId}`);
      await new Promise((resolve) => setImmediate(resolve));
      order.push(`finish:${worker.workerId}`);
      active -= 1;
      return worker.workerId;
    },
  );
  assert.equal(maximumActive, 1);
  assert.deepEqual(order, ['start:vm1', 'finish:vm1', 'start:vm2', 'finish:vm2']);
  assert.deepEqual(completed, ['vm1', 'vm2']);
});

// This suite exercises signed-plan expiry separately. Keep the normal fixture
// window safely in the future so ordinary verification does not depend on the
// wall clock of the machine running the tests.
const fixedNow = new Date('2035-08-14T03:00:00.000Z');
const fixedFuture = new Date('2035-08-14T05:00:00.000Z');
const provenance = Object.freeze({
  source: 'git',
  captureStatus: 'captured',
  headCommit: 'a'.repeat(40),
  worktreeClean: true,
  dirtyEntryCount: 0,
});
const inventory = (name) => [{ path: `${name}.bin`, bytes: 1, sha256: 'b'.repeat(64) }];
const localIsolationAuthority = Object.freeze({
  path: 'local-isolation-manifest.json', bytes: 1, sha256: 'c'.repeat(64), providerCalls: 0,
});
const workers = Object.freeze([
  {
    workerId: 'worker-default',
    interactiveUser: 'runner',
    vmIdentity: { provider: 'vmware', uuidBios: 'vm-default' },
    deviceProfileInstances: [{
      instanceId: 'default-profile',
      profileId: 'default-speaker',
      deviceClass: 'default-speaker',
      physicalPlaybackDeviceId: 'default',
      expectedPhysicalPlaybackDeviceName: 'Default speaker',
    }],
  },
  {
    workerId: 'worker-usb',
    interactiveUser: 'runner',
    vmIdentity: { provider: 'vmware', uuidBios: 'vm-usb' },
    deviceProfileInstances: [{
      instanceId: 'usb-profile',
      profileId: 'usb-speaker',
      deviceClass: 'usb',
      physicalPlaybackDeviceId: 'usb-endpoint-1',
      expectedPhysicalPlaybackDeviceName: 'USB speaker',
    }],
  },
]);

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'omni-incident-plus-'));
}

function twoVmProductionConfig(root) {
  const identityFile = path.join(root, 'id_rsa');
  const knownHostsFile = path.join(root, 'known_hosts');
  writeText(identityFile, 'fixture-key');
  writeText(knownHostsFile, [
    'incident-vm-default ssh-ed25519 AAAAfixture1',
    'incident-vm-usb ssh-ed25519 AAAAfixture2',
  ].join('\n'));
  const defaultProfile = (workerId) => ({
    instanceId: `${workerId}-default`,
    profileId: 'default-speaker-profile',
    deviceClass: 'default-speaker',
    physicalPlaybackDeviceId: 'default',
    expectedPhysicalPlaybackDeviceName: '',
  });
  return {
    schemaVersion: 1,
    artifactKind: 'watch-mode-production-shard-workers',
    sshExecutable: 'ssh.exe',
    scpExecutable: 'scp.exe',
    workers: [
      {
        workerId: 'worker-default', host: '192.0.2.41', port: 22, user: 'runner',
        identityFile, knownHostsFile, hostKeyAlias: 'incident-vm-default',
        workspaceRoot: 'E:\\watch-worker', guestExecutionRoot: 'E:\\omni-incident',
        vmIdentity: workers[0].vmIdentity,
        deviceProfileInstances: [defaultProfile('worker-default')],
      },
      {
        workerId: 'worker-usb', host: '192.0.2.42', port: 22, user: 'runner',
        identityFile, knownHostsFile, hostKeyAlias: 'incident-vm-usb',
        workspaceRoot: 'E:\\watch-worker', guestExecutionRoot: 'E:\\omni-incident',
        vmIdentity: workers[1].vmIdentity,
        deviceProfileInstances: [defaultProfile('worker-usb'), workers[1].deviceProfileInstances[0]],
      },
    ],
  };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, 'utf8');
}

function planFixture({ runtimeBinaryHashes = inventory('runtime') } = {}) {
  const signingKeys = generateCoordinatorSigningKeyPair();
  const plan = createIncidentPlusExecutionPlan({
    executionId: 'incident-plus-test-001',
    generatedAt: fixedNow,
    expiresAt: fixedFuture,
    provenance,
    authorityImplementationHashes: inventory('implementation'),
    runtimeBinaryHashes,
    incidentImplementationHashes: inventory('incident'),
    localIsolationAuthority,
    workers,
    signingKeys,
  });
  const leases = issueIncidentPlusCellLeases(plan, signingKeys, { issuedAt: fixedNow });
  const readinessRequests = createIncidentPlusReadinessRequests(plan, signingKeys, { generatedAt: fixedNow });
  return { plan, leases, readinessRequests, signingKeys };
}

test('current Plus preparation rejects its manifest-only Omni adapter before build or dispatch', () => {
  const root = tempRoot();
  const signingKeys = generateCoordinatorSigningKeyPair();
  const calls = [];
  assert.throws(() => prepareCurrentIncidentPlusExecution({
    workerConfig: workers,
    localIsolationAuthority,
    executionRoot: root,
    executionId: 'incident-plus-current-preparation',
    generatedAt: fixedNow,
    expiresAt: fixedFuture,
    signingKeys,
    environment: { KEEP_ME: 'yes', CARGO_TARGET_DIR: 'stale-target' },
    buildRuntimeAuthority: ({ environment }) => {
      calls.push(environment);
      return inventory('rebuilt-runtime');
    },
    captureProvenance: () => provenance,
    captureAuthorityImplementationHashes: () => inventory('current-implementation'),
    captureIncidentImplementationHashes: () => inventory('current-incident'),
  }), /model_protocol\.adapter_unavailable/);
  assert.equal(calls.length, 0, 'protocol rejection must precede runtime build');
});

test('manifest-only Plus authority takes precedence over later provenance checks', () => {
  let buildCalled = false;
  assert.throws(() => prepareCurrentIncidentPlusExecution({
    workerConfig: workers,
    localIsolationAuthority,
    executionRoot: tempRoot(),
    executionId: 'incident-plus-dirty-runtime',
    generatedAt: fixedNow,
    expiresAt: fixedFuture,
    buildRuntimeAuthority: () => {
      buildCalled = true;
      return inventory('rebuilt-runtime');
    },
    captureProvenance: () => ({ ...provenance, worktreeClean: false, dirtyEntryCount: 1 }),
  }), /model_protocol\.adapter_unavailable/);
  assert.equal(buildCalled, false);
});

test('Plus coordinator requires an explicit dispatch switch before it can reach a Provider', () => {
  const prepared = parseIncidentPlusCliArgs([
    '--workers-config', 'workers.json',
    '--local-isolation-authority', 'local.json',
  ]);
  assert.equal(prepared.dispatch, undefined);
  const dispatched = parseIncidentPlusCliArgs([
    '--workers-config', 'workers.json',
    '--local-isolation-authority', 'local.json',
    '--dispatch',
  ]);
  assert.equal(dispatched.dispatch, true);
});

test('Plus cell staging uploads the signed plan before its cell lease', async () => {
  const uploads = [];
  const staged = await stageIncidentPlusCellAuthority({
    upload: async (_worker, source, target) => uploads.push({ source, target }),
    worker: { workerId: 'vm1-default' },
    planPath: 'C:\\authority\\plan.json',
    leasePath: 'C:\\authority\\lease.json',
    remoteRoot: 'E:\\incident\\vm1-default',
    cellIndex: 0,
  });
  assert.deepEqual(uploads, [
    {
      source: 'C:\\authority\\plan.json',
      target: 'E:\\incident\\vm1-default\\shard-execution-plan.json',
    },
    {
      source: 'C:\\authority\\lease.json',
      target: 'E:\\incident\\vm1-default\\leases\\1.json',
    },
  ]);
  assert.equal(staged.remotePlanPath, uploads[0].target);
  assert.equal(staged.remoteLeasePath, uploads[1].target);
});

function healthyWatchReport() {
  return {
    model: 'qwen3.5-omni-plus-realtime',
    status: 'completed',
    events: [{ stage: 'source', finalEvent: true, text: '今天继续测试。', accepted: true }],
    issues: [],
    cues: [{
      cueId: 'cue-1', sourceText: '今天继续测试。', publishedText: 'Continue testing today.',
      comparisonStatus: 'exact', events: [],
    }],
  };
}

function healthyReport(cell) {
  const common = {
    verdict: 'passed',
    modelId: 'qwen3.5-omni-plus-realtime',
    feedbackLoopPrevention: cell.feedbackLoopPrevention,
    layers: {
      environment: { status: 'passed' },
      app: { status: 'passed' },
      strictContent: { status: cell.feedbackLoopPrevention === 'echo-cancel' ? 'skipped' : 'passed' },
    },
  };
  if (cell.feedbackLoopPrevention === 'echo-cancel') {
    common.layers.aec = {
      status: 'passed',
      data: {
        maxResetCount: 0,
        maxRenderUnderruns: 0,
        maxCaptureUnderruns: 0,
        maxAsrDeletedChunks: 0,
      },
    };
  }
  return common;
}

function readinessReceipt(plan, request) {
  const worker = plan.workers.find((entry) => entry.workerId === request.workerId);
  const virtualDriverRequired = request.assignedCells.some((entry) => entry.feedbackLoopPrevention === 'virtual-driver');
  return {
    schemaVersion: 1,
    artifactKind: 'watch-mode-incident-plus-worker-zero-provider-readiness',
    incidentId: INCIDENT_REPLAY_PLUS_ID,
    generatedAt: '2035-08-14T03:10:00.000Z',
    executionId: plan.executionId,
    planDigest: plan.planDigest,
    requestDigest: request.requestDigest,
    workerId: worker.workerId,
    vmIdentityDigest: worker.vmIdentityDigest,
    sourceHeadCommit: plan.provenance.headCommit,
    runtimeBundleDigest: plan.authority.runtimeBundleDigest,
    providerCalls: 0,
    externalAudioSamples: 0,
    interactiveSession: { ready: true, sessionId: 1 },
    credentials: {
      providerId: 'provider-dashscope',
      reference: 'credential://provider/dashscope/default',
      visible: true,
    },
    bridgeSource: { ready: true },
    virtualDriver: { required: virtualDriverRequired, ready: virtualDriverRequired },
    processExclusion: {
      ready: request.assignedCells.some((entry) => entry.feedbackLoopPrevention === 'process-exclusion'),
    },
    echoCancel: {
      ready: request.assignedCells.some((entry) => entry.feedbackLoopPrevention === 'echo-cancel'),
    },
    profiles: worker.deviceProfileInstances,
  };
}

function writeBudgetArtifacts(runDirectory, cell, lease) {
  const runMarker = `run-${cell.cellIndex + 1}`;
  const attemptedSamples = 32_000;
  const rawChunk = Buffer.alloc(attemptedSamples * 3 * 8);
  for (let offset = 0; offset < rawChunk.length; offset += 8) {
    rawChunk.writeFloatLE(0.25, offset);
    rawChunk.writeFloatLE(0.25, offset + 4);
  }
  const rawLength = Buffer.alloc(4);
  rawLength.writeUInt32LE(rawChunk.length);
  const prefilterPath = path.join(runDirectory, PROVIDER_INPUT_PREFILTER_FILE);
  fs.writeFileSync(
    prefilterPath,
    Buffer.concat([PROVIDER_INPUT_PREFILTER_MAGIC, rawLength, rawChunk]),
  );
  fs.writeFileSync(
    path.join(runDirectory, 'provider-input-16k-mono.pcm'),
    replayProviderInputPrefilter({
      filePath: prefilterPath,
      maxSamples: INCIDENT_PLUS_MAX_EXTERNAL_AUDIO_SAMPLES,
    }).expectedProviderPcm,
  );
  writeText(path.join(runDirectory, 'app.log'), [
    runMarker,
    'input_audio_buffer.append.summary {"resampledSamplesTotal":32000}',
    '[CONNECT] connected Omni',
  ].join('\n'));
  const identity = {
    schemaVersion: 1,
    artifactKind: 'watch-mode-provider-input-budget-ledger',
    cellId: cell.cellId,
    leaseId: lease.leaseId,
    runMarker,
    sessionGeneration: 1,
    direction: 'inbound',
    strictPaidAuthority: false,
    incidentReplayAuthority: true,
    incidentId: INCIDENT_REPLAY_PLUS_ID,
    providerId: 'provider-dashscope',
    templateId: 'template-dashscope-realtime',
    providerKind: 'dashscope',
    endpointHost: 'dashscope.aliyuncs.com',
    credentialReference: 'credential://provider/dashscope/default',
    authHeaderName: 'Authorization',
    authScheme: 'bearer',
    customHeaderCount: 0,
    model: cell.modelId,
    protocol: 'dashscope-omni',
    maxSamples: 2_880_000,
    totalAttemptedSamples: attemptedSamples,
    appendAttempts: 1,
    sendFailures: 0,
    initialConnectAttempts: 1,
    reconnects: 0,
    budgetExceeded: false,
    finalized: true,
    terminalReason: 'worker-completed',
  };
  writeJson(path.join(runDirectory, 'provider-input-budget-ledger.json'), identity);
  writeJson(path.join(runDirectory, 'provider-input-budget-lease.json'), {
    schemaVersion: 1,
    artifactKind: 'watch-mode-provider-input-budget-lease',
    cellId: cell.cellId,
    leaseId: lease.leaseId,
    runMarker,
    maxSamples: 2_880_000,
  });
  const initialized = { ...identity, event: 'initialized', sequence: 1, occurredAtMs: 1, attemptedSamples: null, finalized: false, terminalReason: null, totalAttemptedSamples: 0, appendAttempts: 0, initialConnectAttempts: 0 };
  const connected = { ...initialized, event: 'initial_connect_attempt', sequence: 2, occurredAtMs: 2, initialConnectAttempts: 1 };
  const reserved = { ...identity, event: 'reserved', sequence: 3, occurredAtMs: 3, attemptedSamples, finalized: false, terminalReason: null };
  const finalized = { ...identity, event: 'finalized', sequence: 4, occurredAtMs: 4, attemptedSamples: null };
  writeText(path.join(runDirectory, 'provider-input-budget-ledger.json.journal.jsonl'), [initialized, connected, reserved, finalized].map(JSON.stringify).join('\n'));
}

function syntheticValidatedBudget(runDirectory, options) {
  const cell = INCIDENT_PLUS_CELLS.find((entry) => entry.cellId === options.cellId);
  return {
    schemaVersion: 1,
    artifactKind: 'watch-mode-paid-cell-external-provider-budget',
    generatedAt: '2035-08-14T03:30:00.000Z',
    passed: true,
    scope: 'strict-paid-provider-input-samples',
    runMarker: `run-${cell.cellId}`,
    cellId: cell.cellId,
    modelId: cell.modelId,
    feedbackLoopPrevention: cell.feedbackLoopPrevention,
    translationMode: 'native',
    approvedModels: ['qwen3.5-omni-plus-realtime'],
    incidentId: INCIDENT_REPLAY_PLUS_ID,
    inputSampleRateHz: 16_000,
    providerInputSampleCeiling: 2_880_000,
    actualProviderInputSamples: 32_000,
    actualProviderInputSeconds: 2,
    providerSendBoundary: { leaseId: `budget-${cell.cellId}` },
    calls: { mainRealtime: 1, sourceTranscript: 0, physicalOutputStt: 0, secondaryTranslation: 0, secondaryTts: 0 },
    auxiliaryExternalAudioSeconds: 0,
    violations: [],
  };
}

test('incident Plus plan is fixed to three Plus cells, two VMs, and two waves', () => {
  const { plan, leases } = planFixture();
  verifyIncidentPlusExecutionPlan(plan, { now: fixedNow });
  assert.equal(plan.cells.length, 3);
  assert.deepEqual(plan.cells.map((cell) => cell.modelId), Array(3).fill('qwen3.5-omni-plus-realtime'));
  assert.deepEqual(plan.waves, [
    { waveIndex: 0, cellIds: [INCIDENT_PLUS_CELLS[0].cellId, INCIDENT_PLUS_CELLS[1].cellId] },
    { waveIndex: 1, cellIds: [INCIDENT_PLUS_CELLS[2].cellId] },
  ]);
  assert.equal(plan.budget.inputSampleRateHz, INCIDENT_PLUS_INPUT_SAMPLE_RATE_HZ);
  assert.equal(plan.budget.matrixMaxExternalAudioSeconds, INCIDENT_PLUS_MAX_EXTERNAL_AUDIO_SECONDS);
  assert.equal(plan.budget.matrixMaxExternalAudioSamples, INCIDENT_PLUS_MAX_EXTERNAL_AUDIO_SAMPLES);
  assert.equal(leases.length, 3);
  leases.forEach((lease) => verifyIncidentPlusCellLease(lease, plan, { now: fixedNow }));
  assert.throws(() => createIncidentPlusExecutionPlan({
    executionId: 'incident-plus-test-002', generatedAt: fixedNow, expiresAt: fixedFuture,
    provenance, authorityImplementationHashes: inventory('implementation'), runtimeBinaryHashes: inventory('runtime'),
    incidentImplementationHashes: inventory('incident'), localIsolationAuthority,
    workers: [workers[0], { ...workers[1], vmIdentity: workers[0].vmIdentity }], signingKeys: generateCoordinatorSigningKeyPair(),
  }), /different VMs/);
});

test('incident Plus preflight authority is a separate three-reservation Plus-only grant', () => {
  const { plan, leases, signingKeys } = planFixture();
  const grantAt = new Date('2035-08-14T03:00:01.000Z');
  const reservationAt = new Date('2035-08-14T03:00:02.000Z');
  const grant = createIncidentPlusPreflightGrant({
    plan,
    leases,
    generatedAt: grantAt,
    signingKeys,
  });
  assert.equal(grant.artifactKind, 'watch-mode-incident-plus-preflight-grant');
  assert.equal(grant.incidentId, INCIDENT_REPLAY_PLUS_ID);
  assert.equal(grant.authorization.model, 'qwen3.5-omni-plus-realtime');
  assert.equal(grant.cells.length, 3);
  assert.deepEqual(
    grant.cells.map((cell) => cell.deviceProfileInstanceId),
    plan.cells.map((cell) => cell.deviceProfileInstance.instanceId),
  );
  assert.ok(grant.cells.every((cell) => String(cell.deviceProfileInstanceId).length > 0));
  assert.equal(grant.budget.matrixMaxExternalAudioSamples, 8_640_000);
  assert.deepEqual(grant.localIsolationAuthority, plan.localIsolationAuthority);
  assert.equal(grant.localIsolationAuthority.providerCalls, 0);
  verifyIncidentPlusPreflightGrant(grant, plan);

  const reservations = createIncidentPlusPreflightLeaseReservations({
    grant,
    plan,
    issuedAt: reservationAt,
    signingKeys,
  });
  assert.equal(reservations.length, 3);
  assert.ok(reservations.every((entry) => (
    entry.artifactKind === 'watch-mode-incident-plus-preflight-lease-reservation'
    && entry.incidentId === INCIDENT_REPLAY_PLUS_ID
  )));
  verifyIncidentPlusPreflightLeaseReservations(reservations, grant, plan);
  const consumed = incidentPlusPreflightAuthorizationConsumption({
    grant,
    leaseReservations: reservations,
  });
  assert.equal(consumed.artifactKind, 'watch-mode-incident-plus-preflight-authorization-consumption');
  assert.equal(consumed.leaseReservationDigests.length, 3);
  assert.equal(consumed.externalAudioSamples, 0);
  assert.equal(consumed.model, 'qwen3.5-omni-plus-realtime');
});

test('incident Plus execution preparation publishes only the signed three-reservation authority', () => {
  const root = tempRoot();
  try {
    const signingKeys = generateCoordinatorSigningKeyPair();
    const prepared = prepareIncidentPlusExecution({
      workerConfig: workers,
      localIsolationAuthority,
      executionRoot: root,
      executionId: 'incident-plus-prepared-001',
      generatedAt: fixedNow,
      expiresAt: fixedFuture,
      signingKeys,
      provenance,
      authorityImplementationHashes: inventory('implementation'),
      runtimeBinaryHashes: inventory('runtime'),
      incidentImplementationHashes: inventory('incident'),
    });
    const published = readIncidentPlusPreflightAuthorizationPackage({
      executionRoot: prepared.executionRoot,
      plan: prepared.plan,
    });
    assert.equal(published.grant.digest, prepared.grant.digest);
    assert.deepEqual(
      published.leaseReservations.map((entry) => entry.digest),
      prepared.leaseReservations.map((entry) => entry.digest),
    );
    const publishedText = fs.readFileSync(
      path.join(prepared.executionRoot, 'preflight-authorization', 'incident-plus-preflight-grant.json'),
      'utf8',
    );
    assert.equal(publishedText.includes(signingKeys.privateKeyPem), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('incident verifier rejects historical echo gates, normal queue loss, and unhealthy AEC', () => {
  const cell = INCIDENT_PLUS_CELLS[0];
  assert.equal(validateIncidentPlusWatchReport({ report: healthyReport(cell), watchSessionReport: healthyWatchReport(), cell }).passed, true);

  const echoRejected = healthyWatchReport();
  echoRejected.issues.push({ code: 'recent-output-echo' });
  assert.match(
    validateIncidentPlusWatchReport({ report: healthyReport(cell), watchSessionReport: echoRejected, cell }).violations.join('; '),
    /historical text echo suppression/,
  );

  const queueRejected = healthyWatchReport();
  queueRejected.issues.push({ code: 'native-playback-queue-expired' });
  assert.match(
    validateIncidentPlusWatchReport({ report: healthyReport(cell), watchSessionReport: queueRejected, cell }).violations.join('; '),
    /native playback queue issue/,
  );

  const aecCell = INCIDENT_PLUS_CELLS[2];
  const unhealthyAec = healthyReport(aecCell);
  unhealthyAec.layers.aec.data.maxCaptureUnderruns = 1;
  assert.match(
    validateIncidentPlusWatchReport({ report: unhealthyAec, watchSessionReport: healthyWatchReport(), cell: aecCell }).violations.join('; '),
    /AEC underrun/,
  );
});

test('incident Plus cell runner uses the bounded Plus authority without entering the strict release matrix', async () => {
  const root = tempRoot();
  try {
    const { plan, leases, readinessRequests } = planFixture();
    const executionRoot = path.join(root, plan.executionId);
    writeIncidentPlusExecutionPlan({ executionRoot, plan, leases, readinessRequests });
    const worker = plan.workers[0];
    const request = readinessRequests.find((entry) => entry.workerId === worker.workerId);
    const readinessPath = path.join(executionRoot, 'readiness', `${worker.workerId}.json`);
    writeJson(readinessPath, readinessReceipt(plan, request));
    const lease = leases[0];
    const snapshot = {
      provenance,
      authorityImplementationHashes: inventory('implementation'),
      runtimeBinaryHashes: inventory('runtime'),
      incidentImplementationHashes: inventory('incident'),
    };
    const interactiveReceiptPath = path.join(executionRoot, 'interactive-execution.json');
    const outcome = await runLeasedIncidentPlusCell({
      plan,
      lease,
      workerId: worker.workerId,
      vmIdentity: worker.vmIdentity,
      executionRoot,
      readinessReceiptPath: readinessPath,
      readinessRequest: request,
      authoritySnapshot: snapshot,
      readAuthoritySnapshot: () => snapshot,
      interactiveExecutionReceiptPath: interactiveReceiptPath,
      now: () => new Date('2035-08-14T03:30:00.000Z'),
      assertExternalProviderBudget: syntheticValidatedBudget,
      executeCell: async (cellRequest) => {
        const argv = buildIncidentPlusPowerShellRunnerArgv(path.join(cellRequest.cellOutputRoot, 'run-request.json'));
        assert.equal(argv.includes('--request'), true);
        assert.equal(argv.includes('-IncidentReplayAuthority'), false);
        assert.equal(argv.includes('-StrictPaidAuthority'), false);
        assert.equal(cellRequest.environment.OMNI_WATCH_MODE_INCIDENT_REPLAY_AUTHORITY, '1');
        assert.equal(cellRequest.environment.OMNI_WATCH_MODE_PROVIDER_INPUT_MAX_SAMPLES, '2880000');
        const runDirectory = path.join(cellRequest.cellOutputRoot, 'completed');
        writeJson(path.join(runDirectory, 'report.json'), healthyReport(cellRequest.cell));
        writeJson(path.join(runDirectory, 'watch-session-report.json'), healthyWatchReport());
        writeBudgetArtifacts(runDirectory, cellRequest.cell, lease);
        writeJson(
          path.join(runDirectory, 'external-provider-budget.json'),
          syntheticValidatedBudget(runDirectory, { cellId: cellRequest.cell.cellId }),
        );
        return { exitCode: 0, runDirectory };
      },
    });
    assert.equal(path.basename(outcome.resultPath), INCIDENT_PLUS_CELL_RESULT_FILE);
    const interactive = JSON.parse(fs.readFileSync(interactiveReceiptPath, 'utf8'));
    assert.equal(interactive.artifactKind, 'watch-mode-interactive-incident-plus-cell-execution');
    assert.equal(interactive.leaseId, lease.leaseId);
    const finalized = finalizeInteractiveIncidentPlusCell({
      request: {
        schemaVersion: 1,
        artifactKind: 'watch-mode-interactive-cell-finalization-request',
        planPath: path.join(executionRoot, 'incident-plus-execution-plan.json'),
        leasePath: path.join(executionRoot, 'leases', '1.json'),
        workerId: worker.workerId,
        vmUuidBios: worker.vmIdentity.uuidBios,
        shardRoot: executionRoot,
        executionReceiptPath: interactiveReceiptPath,
        readinessReceiptPath: readinessPath,
        readinessRequestPath: path.join(executionRoot, `worker-readiness-request-${worker.workerId}.json`),
      },
      authoritySnapshot: snapshot,
      now: new Date('2035-08-14T03:30:00.000Z'),
      assertExternalProviderBudget: syntheticValidatedBudget,
    });
    assert.equal(finalized.resultPath, outcome.resultPath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.skip('legacy two-worker Plus coordinator is retired by the single-machine release workflow', async () => {
  const coordinatorSource = fs.readFileSync(
    path.join(repoRoot, 'scripts/testing/run-watch-mode-incident-plus.mjs'),
    'utf8',
  );
  assert.match(coordinatorSource, /line !== REMOTE_POWERSHELL_COMPLETION_MARKER/);
  assert.match(coordinatorSource, /child process timed out after/);
  assert.match(coordinatorSource, /exitCode: 124/);
  const root = tempRoot();
  try {
    const config = twoVmProductionConfig(root);
    const prepared = prepareIncidentPlusExecution({
      workerConfig: config,
      localIsolationAuthority,
      executionRoot: root,
      executionId: 'incident-plus-coordinator-test',
      generatedAt: fixedNow,
      expiresAt: fixedFuture,
      provenance,
      authorityImplementationHashes: inventory('implementation'),
      runtimeBinaryHashes: inventory('runtime'),
      incidentImplementationHashes: [
        'scripts/testing/invoke-watch-mode-interactive-task.ps1',
        'scripts/testing/run-watch-mode-interactive-task.ps1',
        'scripts/testing/collect-watch-mode-interactive-process-authority.ps1',
        'scripts/testing/run-watch-mode-live-shard.mjs',
        'scripts/testing/run-watch-mode-incident-plus-cell.mjs',
      ].map((entry, index) => ({ path: entry, bytes: index + 1, sha256: `${index + 1}`.repeat(64) })),
    });
    const calls = [];
    const result = await runIncidentPlusProductionCoordinator({
      workerConfig: config,
      localIsolationAuthority,
      executionRoot: root,
      executionId: prepared.plan.executionId,
      now: () => new Date('2035-08-14T03:30:00.000Z'),
      operations: {
        prepareExecution: () => prepared,
        createPreparationTransport: ({ plan }) => {
          calls.push(`transport:${plan.cells.length}`);
          assert.equal(plan.artifactKind, 'watch-mode-incident-plus-execution-plan');
          assert.equal(plan.authority.shardOrchestrationImplementationHashes.length, 4);
          return { cancelCell: async () => {} };
        },
        prepareWorkers: async () => {
          calls.push('readiness');
          return prepared.plan.workers.map((worker) => ({ workerId: worker.workerId, readiness: {} }));
        },
        runPreflight: async () => {
          calls.push('preflight');
          return { preflight: { incidentId: INCIDENT_REPLAY_PLUS_ID }, preflightPath: path.join(root, 'preflight.json') };
        },
        dispatchCell: async ({ cell }) => {
          calls.push(`dispatch:${cell.cellIndex}`);
          return { resultPath: path.join(root, `cell-${cell.cellIndex}.json`) };
        },
        writeManifest: ({ plan, resultPaths, preflight }) => {
          calls.push('manifest');
          assert.equal(plan.cells.length, 3);
          assert.deepEqual(resultPaths, [
            path.join(root, 'cell-0.json'), path.join(root, 'cell-1.json'), path.join(root, 'cell-2.json'),
          ]);
          assert.equal(preflight.incidentId, INCIDENT_REPLAY_PLUS_ID);
          return { manifestPath: path.join(root, 'incident-plus-manifest.json') };
        },
        writeVerification: ({ manifestPath }) => {
          calls.push('verification');
          assert.equal(manifestPath, path.join(root, 'incident-plus-manifest.json'));
          return { receiptPath: path.join(root, 'incident-plus-verification-receipt.json') };
        },
      },
    });
    assert.deepEqual(calls, [
      'transport:3', 'readiness', 'preflight', 'dispatch:0', 'dispatch:1', 'dispatch:2',
      'manifest', 'verification',
    ]);
    assert.equal(result.verificationReceiptPath, path.join(root, 'incident-plus-verification-receipt.json'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('legacy incident Plus aggregate rejects missing enabled protocol identity', () => {
  const root = tempRoot();
  try {
    const workspaceRoot = path.join(root, 'workspace');
    const desktopPath = path.join(workspaceRoot, 'target', 'release', 'omni-desktop-shell.exe');
    writeText(desktopPath, 'incident-plus-desktop-fixture');
    const desktopBytes = fs.statSync(desktopPath).size;
    const desktopSha256 = createHash('sha256').update(fs.readFileSync(desktopPath)).digest('hex');
    const { plan, leases, readinessRequests, signingKeys } = planFixture({
      runtimeBinaryHashes: [{
        path: 'target/release/omni-desktop-shell.exe',
        bytes: desktopBytes,
        sha256: desktopSha256,
      }],
    });
    const executionRoot = path.join(root, plan.executionId);
    writeIncidentPlusExecutionPlan({ executionRoot, plan, leases, readinessRequests });
    const readinessPaths = readinessRequests.map((request) => {
      const filePath = path.join(executionRoot, 'readiness', `${request.workerId}.json`);
      writeJson(filePath, readinessReceipt(plan, request));
      return filePath;
    });
    const grant = createIncidentPlusPreflightGrant({
      plan, leases, generatedAt: new Date('2035-08-14T03:15:00.000Z'), signingKeys,
    });
    const leaseReservations = createIncidentPlusPreflightLeaseReservations({
      grant, plan, issuedAt: new Date('2035-08-14T03:15:01.000Z'), signingKeys,
    });
    const preflightAuthorization = writeIncidentPlusPreflightAuthorizationPackage({
      executionRoot, plan, grant, leaseReservations,
    });
    const consumed = incidentPlusPreflightAuthorizationConsumption({ grant, leaseReservations });
    writeJson(path.join(preflightAuthorization.authorizationRoot, 'incident-plus-preflight-consumption-claim.json'), {
      schemaVersion: 1,
      artifactKind: 'watch-mode-incident-plus-preflight-consumption-claim',
      incidentId: INCIDENT_REPLAY_PLUS_ID,
      claimedAt: '2035-08-14T03:15:02.000Z',
      executionId: plan.executionId,
      grantDigest: grant.digest,
      authorizationDigest: consumed.authorizationDigest,
      coordinatorKeyId: grant.signature.keyId,
      desktopExecutableBytes: desktopBytes,
      desktopExecutablePath: desktopPath,
      desktopExecutableRelativePath: 'target/release/omni-desktop-shell.exe',
      desktopExecutableSha256: desktopSha256,
      desktopProcessId: 1234,
      retryPolicy: 'new-execution-required',
    });
    const preflightEvidenceDirectory = path.join(executionRoot, 'preflight-evidence');
    writeJson(path.join(preflightEvidenceDirectory, 'emitter-result.json'), { status: 'completed' });
    writeJson(path.join(preflightEvidenceDirectory, 'provider-probe-result.json'), { status: 'completed' });
    writeJson(path.join(preflightEvidenceDirectory, 'diagnostics-bundle', 'bundle.json'), { status: 'completed' });
    const preflight = createIncidentPlusPreflightCompletion({
      plan,
      leases,
      grant,
      leaseReservations,
      authorizationRoot: preflightAuthorization.authorizationRoot,
      evidenceDirectory: preflightEvidenceDirectory,
      completedAt: new Date('2035-08-14T03:20:00.000Z'),
      signingKeys,
      workspaceRoot,
      validateRawEvidence: (_evidenceDirectory, { expectedAuthorization }) => ({
        issues: [],
        summary: {
          providerId: expectedAuthorization.providerId,
          model: expectedAuthorization.model,
          protocol: expectedAuthorization.protocol,
          operation: expectedAuthorization.operation,
          inputMode: expectedAuthorization.inputMode,
          providerInvocationCount: 1,
          externalAudioSamples: 0,
          inputTokens: 10,
          outputTokens: 5,
          audioSeconds: 0,
        },
      }),
    });
    const resultPaths = plan.cells.map((cell, index) => {
      const runDirectory = path.join(executionRoot, 'runs', `c${index + 1}`);
      writeJson(path.join(runDirectory, 'report.json'), healthyReport(cell));
      writeJson(path.join(runDirectory, 'watch-session-report.json'), healthyWatchReport());
      writeBudgetArtifacts(runDirectory, cell, leases[index]);
      writeJson(
        path.join(runDirectory, 'external-provider-budget.json'),
        syntheticValidatedBudget(runDirectory, { cellId: cell.cellId }),
      );
      return writeIncidentPlusCellResult({
        plan, lease: leases[index], workerId: cell.workerId,
        vmIdentity: plan.workers.find((worker) => worker.workerId === cell.workerId).vmIdentity,
        executionRoot, runDirectory,
        readinessReceiptPath: readinessPaths.find((candidate) => candidate.endsWith(`${cell.workerId}.json`)),
        readinessRequest: readinessRequests.find((request) => request.workerId === cell.workerId),
        generatedAt: new Date('2035-08-14T03:30:00.000Z'),
        assertExternalProviderBudget: syntheticValidatedBudget,
      }).resultPath;
    });
    assert.throws(() => writeIncidentPlusManifest({
      plan, leases, preflight, executionRoot, resultPaths, readinessReceiptPaths: readinessPaths,
      readinessRequests, generatedAt: new Date('2035-08-14T03:40:00.000Z'), signingKeys,
      assertExternalProviderBudget: syntheticValidatedBudget,
    }), /model protocol profile identity is missing/);
    assert.equal(
      fs.existsSync(path.join(executionRoot, INCIDENT_PLUS_EXTERNAL_BUDGET_FILE)),
      false,
      'a manifest-only adapter must not publish a passing aggregate budget',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
