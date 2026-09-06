import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  SHARD_CELL_MAX_EXTERNAL_AUDIO_SAMPLES,
  SHARD_EXECUTION_PLAN_FILE,
  SHARD_MATRIX_CELL_COUNT,
  SHARD_MATRIX_MAX_EXTERNAL_AUDIO_SAMPLES,
  createWorkerReadinessRequest,
  createSignedExecutionPlan,
  fileAuthorityEntry,
  generateCoordinatorSigningKeyPair,
  issueCellLeases,
  sha256Canonical,
  verifyCellLease,
  verifySignedExecutionPlan,
  signCoordinatorAuthority,
} from './watch-mode-shard-authority.mjs';
import { validateProductionWorkerConfig, PRODUCTION_WORKER_CONFIG_KIND, productionCellFailureDisposition, observeOwnedCellCompletion, runProductionWavesPreservingFailure } from './run-watch-mode-live-production-coordinator.mjs';
import { verifyStrictShardProviderPreflightAuthorization } from './verify-watch-mode-evidence.mjs';
import {
  COORDINATOR_PROVIDER_PREFLIGHT_FILE,
  CoordinatorWaveFailure,
  collectCoordinatorAggregation,
  defaultSingleWorkerAssignments,
  fixedThreeWorkerAssignments,
  prepareCoordinatorExecution,
  runCoordinatorWaves,
  validateCoordinatorAggregate,
  validateCoordinatorExecutionAuthority,
} from './run-watch-mode-live-coordinator.mjs';
import {
  PROVIDER_PREFLIGHT_MODEL,
  PROVIDER_PREFLIGHT_PROTOCOL,
  verifyProviderPreflightGrant,
} from './watch-mode-provider-preflight-authorization.mjs';
import { LIVE_LLM_CELLS } from './watch-mode-balanced-release-plan.mjs';
import { fixedFourWorkerAssignments } from './watch-mode-four-worker-plan.mjs';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const MODEL_PROTOCOL_PROFILE_IDENTITY = LIVE_LLM_CELLS[0].modelProtocolProfileIdentity;
const PREFLIGHT_LIFECYCLE_AUTHORITY = Object.freeze({
  providerId: 'provider-dashscope',
  model: 'qwen3.5-livetranslate-flash-realtime',
  protocol: 'dashscope-livetranslate',
  operation: 'livetranslate-session-lifecycle-preflight',
  modelProtocolProfileIdentity: MODEL_PROTOCOL_PROFILE_IDENTITY,
  inputMode: 'none',
  providerInputMode: 'none',
  responseMode: 'text-only',
  terminalEvent: 'session.finished',
  status: 'completed',
  externalAudioSamples: 0,
  invocationCount: 1,
  lifecycleBudget: {
    firstServerEventLatencyMs: 1_200,
    socketEventTimeoutMs: 12_000,
  },
  evidenceOutcome: 'livetranslate-session-finished',
  firstServerEvent: { type: 'session.created', monotonicMs: 606 },
  sessionAuthority: {
    sessionIdentitySha256: SHA_A,
    serverModel: 'qwen3.5-livetranslate-flash-realtime',
    echoedSessionConfigSha256: SHA_B,
  },
  rawTrace: {
    path: 'raw/provider-websocket-trace.jsonl',
    bytes: 256,
    sha256: SHA_A,
    eventCount: 6,
  },
  audioSeconds: null,
});
const PROVENANCE = Object.freeze({
  schemaVersion: 1,
  source: 'git',
  captureStatus: 'captured',
  headCommit: '3'.repeat(40),
  worktreeClean: true,
  dirtyEntryCount: 0,
});

const inventory = (name, sha) => [{ path: `${name}/artifact`, bytes: 23, sha256: sha }];
const runtimeInventory = () => [
  ...inventory('runtime', SHA_B),
  ...['sys', 'cat', 'inf'].map((extension) => ({
    path: `drivers/windows-virtual-mic/package/omni-virtual-speaker.${extension}`,
    bytes: 23,
    sha256: SHA_B,
  })),
];

function runtimeInventoryWithDesktop(workspaceRoot) {
  const executablePath = path.join(workspaceRoot, 'target', 'release', 'omni-desktop-shell.exe');
  fs.mkdirSync(path.dirname(executablePath), { recursive: true });
  fs.writeFileSync(executablePath, 'fixture-desktop-runtime\n', 'utf8');
  return [
    fileAuthorityEntry(executablePath, 'target/release/omni-desktop-shell.exe'),
    ...runtimeInventory(),
  ];
}

function writeReadinessFixture(context, mutateReceipt = () => {}) {
  const workerReadinessRequest = createWorkerReadinessRequest(context);
  const requestPath = path.join(context.executionRoot, 'worker-readiness-request.json');
  fs.writeFileSync(requestPath, `${JSON.stringify(workerReadinessRequest)}\n`, 'utf8');
  return {
    workerReadinessRequest,
    requestAuthority: fileAuthorityEntry(requestPath, 'worker-readiness-request.json'),
    workers: workerReadinessRequest.workers.map((worker) => {
      const receiptPath = path.join(context.executionRoot, 'worker-readiness', `${worker.workerId}.json`);
      fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
      const requestedAt = Date.parse(workerReadinessRequest.generatedAt);
      const taskProcess = {
        pid: 1000 + Number(worker.workerId.replace(/\D/g, '') || 1),
        parentPid: 500,
        sessionId: 1,
        imagePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        imageSha256: SHA_A,
        startedAt: new Date(requestedAt + 1).toISOString(),
        ownerSid: 'S-1-5-21-fixture-1001',
      };
      const generatedAt = new Date(requestedAt + 100).toISOString();
      const receipt = {
        schemaVersion: 3,
        artifactKind: 'watch-mode-production-worker-zero-provider-readiness',
        generatedAt,
        executionId: context.executionId,
        readinessRequestDigest: workerReadinessRequest.requestDigest,
        workerId: worker.workerId,
        vmIdentityDigest: worker.vmIdentityDigest,
        ...(worker.transportAuthority ? { transportAuthority: structuredClone(worker.transportAuthority) } : {}),
        runtimeBundleDigest: workerReadinessRequest.runtimeBundleDigest,
        providerCalls: 0,
        driverRequired: worker.driverRequired,
        driver: {
          installedServiceState: worker.driverRequired ? 'running' : 'not-required',
          installedSysSha256: worker.driverRequired ? SHA_B : null,
          installedSysSignatureStatus: worker.driverRequired ? 'valid' : null,
          packageCatalogSignatureStatus: worker.driverRequired ? 'valid' : null,
          packageSysSha256: SHA_B,
          packageCatSha256: SHA_B,
          packageInfSha256: SHA_B,
        },
        interactiveSession: {
          user: worker.interactiveUser ?? 'VMUser',
          ownerSid: taskProcess.ownerSid,
          sessionId: 1,
          explorerProcessCount: 1,
          taskProcess,
        },
        credentialStatus: {
          backend: 'windows-credential-manager',
          exists: true,
          reference: 'credential://provider/dashscope/default',
          targetName: 'OmniTranslate:credential___provider_dashscope_default',
          blobNonEmpty: true,
          credentialBlobBytes: 64,
          checkedAt: new Date(requestedAt + 50).toISOString(),
          probeProcess: taskProcess,
        },
        profiles: worker.deviceProfileInstances.map((profile) => ({
          instanceId: profile.instanceId,
          profileId: profile.profileId,
          deviceClass: profile.deviceClass,
          resolvedDeviceId: profile.physicalPlaybackDeviceId === 'default'
            ? `{fixture-${worker.workerId}-default}`
            : profile.physicalPlaybackDeviceId,
          resolvedDeviceName: profile.expectedPhysicalPlaybackDeviceName || 'Fixture Default Speaker',
        })),
      };
      mutateReceipt(receipt, worker);
      fs.writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`, 'utf8');
      return {
        workerId: worker.workerId,
        providerCalls: 0,
        driverRequired: worker.driverRequired,
        ...fileAuthorityEntry(receiptPath, `worker-readiness/${worker.workerId}.json`),
      };
    }),
  };
}

function workers() {
  return [
    {
      workerId: 'vm1', vmIdentity: { provider: 'vmware', uuidBios: '56-4d-vm-1' },
      deviceProfileInstances: [{
        instanceId: 'vm1-default', profileId: 'vmware-hda-default', deviceClass: 'default-speaker',
        physicalPlaybackDeviceId: 'default', expectedPhysicalPlaybackDeviceName: '',
      }],
    },
  ];
}

function signedFixture(workerList = workers()) {
  const now = new Date();
  const generatedAt = new Date(now.getTime() - 1_000);
  const keys = generateCoordinatorSigningKeyPair();
  const plan = createSignedExecutionPlan({
    executionId: 'watch-shard-coordinator-test',
    generatedAt,
    expiresAt: new Date(now.getTime() + 3_600_000),
    provenance: PROVENANCE,
    authorityImplementationHashes: inventory('matrix', SHA_A),
    runtimeBinaryHashes: runtimeInventory(),
    shardOrchestrationImplementationHashes: inventory('shard', SHA_A),
    localIsolationAuthority: { path: 'local.json', bytes: 10, sha256: SHA_A, providerCalls: 0 },
    providerPreflightAuthority: {
       path: 'preflight.json', bytes: 10, sha256: SHA_B, providerId: 'provider-dashscope',
       ...structuredClone(PREFLIGHT_LIFECYCLE_AUTHORITY),
     },
    workers: workerList,
    assignments: workerList.length === 4 ? fixedFourWorkerAssignments(workerList)
      : workerList.length === 3 ? fixedThreeWorkerAssignments(workerList) : defaultSingleWorkerAssignments(workerList),
    ...keys,
  });
  return {
    now,
    plan,
    keys,
    leases: issueCellLeases(plan, keys.privateKeyPem, { issuedAt: generatedAt }),
  };
}

test('multi-worker safety failure fences pending dispatch before cleanup and retains cleanup failures', { timeout: 10000 }, async () => {
  const workerList = ['vm171', 'vm167', 'vm169'].map((workerId) => ({
    ...workers()[0], workerId,
    vmIdentity: { provider: 'vmware', uuidBios: `uuid-${workerId}` },
    transportAuthority: { kind: 'local' },
    deviceProfileInstances: [{
      instanceId: `${workerId}-default`, profileId: 'vmware-hda-default', deviceClass: 'default-speaker',
      physicalPlaybackDeviceId: `{${workerId}}`, expectedPhysicalPlaybackDeviceName: `speaker-${workerId}`,
    }],
  }));
  const { plan, leases, now } = signedFixture(workerList);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-cancel-fence-'));
  let releaseWait;
  const waitBarrier = new Promise((resolve) => { releaseWait = resolve; });
  const pendingSignals = [];
  const dispatched = [];
  const cancelled = [];
  try {
    fs.writeFileSync(path.join(root, SHARD_EXECUTION_PLAN_FILE), JSON.stringify(plan));
    await assert.rejects(runCoordinatorWaves({
      plan, leases, executionRoot: root, now: () => now, firstWaveStaggerMs: 7000,
      wait: async (_delay, signal) => { pendingSignals.push(signal); await waitBarrier; },
      dispatchCell: async ({ cell }) => { dispatched.push(cell.cellId); throw new Error('fixture dispatch failed'); },
      cancelCell: ({ cell }) => {
        cancelled.push(cell.cellId);
        assert.equal(pendingSignals.length, 2);
        assert.ok(pendingSignals.every((signal) => signal.aborted), 'all pending pipelines are fenced before cancellation');
        releaseWait();
        throw new Error('fixture cleanup failed');
      },
    }), (error) => {
      assert.ok(error instanceof CoordinatorWaveFailure);
      assert.equal(error.cause.message, 'fixture dispatch failed');
      assert.equal(error.cleanupErrors.length, 1);
      assert.equal(error.cleanupErrors[0].code, 'coordinator.cleanup.cell-failed');
      assert.equal(error.cleanupErrors[0].cellId, dispatched[0]);
      return true;
    });
    assert.equal(dispatched.length, 1, 'neither staggered peers nor c03 may start');
    assert.deepEqual(cancelled, dispatched, 'the failed worker also needs an owned-process cleanup attempt');
  } finally {
    releaseWait();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const [failureLabel, failureMessage] of [
  ['c02 finalizer rejection', 'interactive cell guest finalizer failed: exitCode=1 | provider input budget ledger is not a strict terminal success'],
  ['actual budget violation', 'provider budget exceeded'],
  ['connection safety violation', 'provider extra connection rejected'],
]) {
test(`${failureLabel} retains late c04 evidence and unconfirmed cleanup`, { timeout: 10000 }, async () => {
  const workerList = ['vm171', 'vm167', 'vm169'].map((workerId) => ({
    ...workers()[0], workerId,
    vmIdentity: { provider: 'vmware', uuidBios: `uuid-${workerId}` },
    transportAuthority: { kind: 'local' },
    deviceProfileInstances: [{
      instanceId: `${workerId}-default`, profileId: 'vmware-hda-default', deviceClass: 'default-speaker',
      physicalPlaybackDeviceId: `{${workerId}}`, expectedPhysicalPlaybackDeviceName: `speaker-${workerId}`,
    }],
  }));
  const { plan, leases, now } = signedFixture(workerList);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-late-c04-'));
  const c02 = LIVE_LLM_CELLS[1].cellId;
  const c04 = LIVE_LLM_CELLS[3].cellId;
  // This ambiguous finalizer error is not proof of an overrun, nor proof of safety.
  const primary = new Error(failureMessage);
  const signals = new Map();
  let releaseDispatch;
  const allDispatched = new Promise((resolve) => { releaseDispatch = resolve; });
  let releaseLate;
  const cleanupAttempted = new Promise((resolve) => { releaseLate = resolve; });
  const cancelled = [];
  primary.collectFailureEvidence = async () => {
    assert.equal(cancelled.length, 3, 'safety stop must precede failed-finalizer collection');
    primary.failureEvidence = { manifestPath: 'fixture-diagnostics-only.json' };
  };
  try {
    fs.writeFileSync(path.join(root, SHARD_EXECUTION_PLAN_FILE), JSON.stringify(plan));
    await assert.rejects(runProductionWavesPreservingFailure({ executionRoot: root, plan, run: () => runCoordinatorWaves({
      plan, leases, executionRoot: root, now: () => now,
      classifyFailure: productionCellFailureDisposition,
      dispatchCell: async ({ cell, signal }) => {
        signals.set(cell.cellId, signal);
        if (signals.size === 3) releaseDispatch();
        await allDispatched;
        if (cell.cellId === c02) throw primary;
        return observeOwnedCellCompletion({ signal, timeoutMs: 1_000, execute: async ({ signal: observerSignal }) => {
          assert.equal(observerSignal, undefined);
          await cleanupAttempted;
          // A cancel request does not prove that an already-started worker stopped.
          return { result: { verdict: 'passed', resultDigest: SHA_A } };
        } });
      },
      cancelCell: async ({ cell }) => {
        assert.ok([...signals.values()].every((signal) => signal.aborted));
        cancelled.push(cell.cellId);
        releaseLate();
        return cell.cellId === c04
          ? { passed: false, status: 'cleanup-incomplete', processCleanup: { passed: false, status: 'authority-invalid' } }
          : { passed: true };
      },
    }) }), (error) => {
      assert.ok(error instanceof CoordinatorWaveFailure);
      assert.equal(error.cause, primary);
      assert.equal(error.partialResults.get(c04)?.result.verdict, 'passed');
      assert.ok(error.completedCellIds.includes(c04));
      assert.ok(!error.completedCellIds.includes(c02));
      assert.equal(error.cleanupErrors.length, 1);
      assert.equal(error.cleanupErrors[0].cellId, c04);
      const manifest = JSON.parse(fs.readFileSync(error.failureCollectionPath, 'utf8'));
      assert.equal(manifest.validatedResults.find((entry) => entry.cellId === c04).verdict, 'passed');
      assert.equal(manifest.failedCellEvidence.find((entry) => entry.cellId === c02).evidence.manifestPath,
        'fixture-diagnostics-only.json');
      return true;
    });
    assert.equal(signals.has(LIVE_LLM_CELLS[2].cellId), false, 'unproven safety must fence c03');
    assert.deepEqual(new Set(cancelled), new Set(plan.waves[0].cellIds));
  } finally {
    releaseDispatch();
    releaseLate();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
}

test('verified ordinary failed outcomes remain collect-all rather than stopAll', async () => {
  const { plan, leases, now } = signedFixture();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-collect-failed-'));
  const c02 = LIVE_LLM_CELLS[1].cellId;
  const dispatched = [];
  try {
    fs.writeFileSync(path.join(root, SHARD_EXECUTION_PLAN_FILE), JSON.stringify(plan));
    const result = await runCoordinatorWaves({
      plan, leases, executionRoot: root, now: () => now,
      classifyFailure: productionCellFailureDisposition,
      dispatchCell: async ({ cell }) => {
        dispatched.push(cell.cellId);
        return { result: {
          verdict: cell.cellId === c02 ? 'failed' : 'passed',
          resultDigest: SHA_A,
          stableErrorCode: cell.cellId === c02 ? 'provider.session-finished-timeout' : null,
        } };
      },
      cancelCell: () => assert.fail('ordinary completed outcome must not cancel peers'),
    });
    assert.deepEqual(dispatched, plan.cells.map((cell) => cell.cellId));
    assert.equal(result.completedCellIds.length, 4);
    assert.equal(result.collectedFailures.length, 1);
    assert.equal(result.collectedFailures[0].cellId, c02);
    assert.equal(result.results.get(c02).result.verdict, 'failed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const [label, receipt] of [
  ['missing receipt', undefined],
  ['negative receipt', { passed: false, status: 'authority-invalid' }],
  ['contradictory receipt', { passed: true, status: 'cleanup-incomplete' }],
  ['failed process cleanup', { passed: true, processCleanup: { passed: false } }],
  ['failed task cleanup', { passed: true, taskCleanupPassed: false }],
  ['reported cleanup errors', { passed: true, cleanupErrors: [{ code: 'fixture-error' }] }],
  ['synchronous cleanup exception', new Error('cleanup fixture exception')],
  ['confirmed receipt', { passed: true, status: 'cleanup-completed' }],
]) {
  test(`serial safety failure cleans the failed dispatch and retains ${label}`, async () => {
    const { plan, leases, now } = signedFixture();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-serial-cleanup-'));
    const cancelled = [];
    try {
      fs.writeFileSync(path.join(root, SHARD_EXECUTION_PLAN_FILE), JSON.stringify(plan));
      await assert.rejects(runCoordinatorWaves({
        plan, leases, executionRoot: root, now: () => now,
        dispatchCell: async () => { throw new Error('provider budget exceeded'); },
        cancelCell: ({ cell }) => {
          cancelled.push(cell.cellId);
          if (receipt instanceof Error) throw receipt;
          return receipt;
        },
      }), (error) => {
        assert.equal(error.cause.message, 'provider budget exceeded');
        assert.equal(error.cleanupErrors.length, label === 'confirmed receipt' ? 0 : 1);
        assert.deepEqual(error.startedCellIds, [plan.cells[0].cellId]);
        return true;
      });
      assert.deepEqual(cancelled, [plan.cells[0].cellId]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test('single-machine placement assigns every paid cell to one distinct serial wave', () => {
  const workerList = workers();
  const assignments = defaultSingleWorkerAssignments(workerList);
  assert.deepEqual(
    assignments.map((entry) => entry.waveIndex),
    Array.from({ length: SHARD_MATRIX_CELL_COUNT }, (_, index) => index),
  );
  assert.ok(assignments.every((entry) => entry.workerId === 'vm1'));
  assert.equal(
    new Set(assignments.map((entry) => `${entry.workerId}:${entry.waveIndex}`)).size,
    assignments.length,
  );
});

test('single-machine placement rejects additional workers', () => {
  assert.throws(() => defaultSingleWorkerAssignments([...workers(), {
    ...workers()[0], workerId: 'vm4', vmIdentity: { provider: 'vmware', uuidBios: 'vm-four' },
  }]), /exactly one local worker/);
});

test('fixed three-worker placement runs c01/c02/c04 in wave zero and c03 on vm169 in wave one', () => {
  const profile = (workerId) => ({
    instanceId: `${workerId}-default`, profileId: 'vmware-hda-default',
    deviceClass: 'default-speaker', physicalPlaybackDeviceId: `{${workerId}}`,
    expectedPhysicalPlaybackDeviceName: `speaker-${workerId}`,
  });
  const workerList = ['vm171', 'vm167', 'vm169'].map((workerId) => ({
    workerId, deviceProfileInstances: [profile(workerId)],
  }));
  assert.deepEqual(fixedThreeWorkerAssignments(workerList).map((entry) => [
    LIVE_LLM_CELLS.findIndex((cell) => cell.cellId === entry.cellId) + 1, entry.workerId, entry.waveIndex,
  ]), [
    [1, 'vm171', 0], [2, 'vm169', 0], [3, 'vm169', 1], [4, 'vm167', 0],
  ]);
});

test('coordinator staggers only first-wave dispatches and keeps later waves dependency-bound', async () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-coordinator-stagger-'));
  try {
    const profile = (workerId) => ({
      instanceId: `${workerId}-default`, profileId: 'vmware-hda-default', deviceClass: 'default-speaker',
      physicalPlaybackDeviceId: `{${workerId}}`, expectedPhysicalPlaybackDeviceName: `speaker-${workerId}`,
    });
    const workerList = ['vm171', 'vm167', 'vm169'].map((workerId) => ({
      workerId, vmIdentity: { provider: 'vmware', uuidBios: `uuid-${workerId}` },
      transportAuthority: { kind: 'local' },
      deviceProfileInstances: [profile(workerId)],
    }));
    const keys = generateCoordinatorSigningKeyPair();
    const now = new Date();
    const plan = createSignedExecutionPlan({
      executionId: 'watch-shard-stagger-test', generatedAt: now,
      expiresAt: new Date(now.getTime() + 3_600_000), provenance: PROVENANCE,
      authorityImplementationHashes: inventory('matrix', SHA_A), runtimeBinaryHashes: runtimeInventory(),
      shardOrchestrationImplementationHashes: inventory('shard', SHA_A),
      localIsolationAuthority: { path: 'local.json', bytes: 10, sha256: SHA_A, providerCalls: 0 },
      providerPreflightAuthority: { path: 'preflight.json', bytes: 10, sha256: SHA_B, ...structuredClone(PREFLIGHT_LIFECYCLE_AUTHORITY) },
      workers: workerList, assignments: fixedThreeWorkerAssignments(workerList), ...keys,
    });
    const leases = issueCellLeases(plan, keys.privateKeyPem, { issuedAt: now });
    fs.mkdirSync(outputRoot, { recursive: true });
    fs.writeFileSync(path.join(outputRoot, SHARD_EXECUTION_PLAN_FILE), `${JSON.stringify(plan)}\n`);
    const delays = [];
    const dispatched = [];
    let releaseSlowPeers;
    const slowPeers = new Promise((resolve) => { releaseSlowPeers = resolve; });
    let resolveC03;
    const c03Started = new Promise((resolve) => { resolveC03 = resolve; });
    const execution = runCoordinatorWaves({
      plan, leases, executionRoot: outputRoot, firstWaveStaggerMs: 7_000,
      wait: async (delayMs) => { delays.push(delayMs); },
      dispatchCell: async ({ cell }) => {
        dispatched.push(cell.cellId);
        if ([0, 3].includes(cell.cellIndex)) await slowPeers;
        if (cell.cellIndex === 2) resolveC03();
        return { result: { verdict: 'passed', resultDigest: sha256Canonical({ cellId: cell.cellId }), generatedAt: new Date(now.getTime() + 500).toISOString() } };
      },
      now: () => new Date(now.getTime() + 1_000),
    });
    await c03Started;
    assert.equal(dispatched.includes(LIVE_LLM_CELLS[2].cellId), true, 'c03 starts after c02 without waiting for other workers');
    releaseSlowPeers();
    const outcome = await execution;
    assert.doesNotThrow(() => validateCoordinatorExecutionAuthority({
      executionRoot: outputRoot, plan, leases, resultByCell: outcome.results,
    }));
    const c02 = LIVE_LLM_CELLS[1].cellId;
    outcome.results.get(c02).result.generatedAt = new Date(now.getTime() + 60_000).toISOString();
    assert.throws(() => validateCoordinatorExecutionAuthority({
      executionRoot: outputRoot, plan, leases, resultByCell: outcome.results,
    }), /worker vm169 dispatched .* before .* completed/u);
    assert.deepEqual(delays.sort((left, right) => left - right), [7_000, 14_000]);
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

for (const [firstWaveStaggerMs, synchronousAdvanceMs] of [[0, 0], [7_000, 0], [7_000, 6_500]]) {
  test(`four-worker signed offsets override legacy ${firstWaveStaggerMs}ms stagger with ${synchronousAdvanceMs}ms synchronous clock advance`, async () => {
    // Deliberately different from both canonical cell order and dispatch order.
    const workerList = (synchronousAdvanceMs ? ['vm171', 'vm169', 'vm131', 'vm167'] : ['vm131', 'vm169', 'vm167', 'vm171']).map((workerId) => ({
      ...workers()[0], workerId,
      vmIdentity: { provider: 'vmware', uuidBios: `uuid-${workerId}` },
      transportAuthority: { kind: 'local' },
      deviceProfileInstances: [{
        instanceId: `${workerId}-default`, profileId: 'vmware-hda-default', deviceClass: 'default-speaker',
        physicalPlaybackDeviceId: `{${workerId}}`, expectedPhysicalPlaybackDeviceName: `speaker-${workerId}`,
      }],
    }));
    const { plan, leases, now } = signedFixture(workerList);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-four-clock-'));
    let clockMs = 0;
    const timers = [];
    const dispatches = [];
    const flush = () => new Promise((resolve) => setImmediate(resolve));
    let execution;
    try {
      fs.writeFileSync(path.join(root, SHARD_EXECUTION_PLAN_FILE), JSON.stringify(plan));
      execution = runCoordinatorWaves({
        plan, leases, executionRoot: root, firstWaveStaggerMs,
        now: () => new Date(now.getTime() + clockMs),
        wait: (delayMs, signal) => new Promise((resolve, reject) => {
          timers.push({ due: clockMs + delayMs, resolve });
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
        dispatchCell: async ({ cell }) => {
          dispatches.push([cell.cellIndex + 1, cell.workerId, clockMs]);
          if (cell.cellIndex === 0) clockMs += synchronousAdvanceMs;
          return { result: { verdict: 'passed', resultDigest: SHA_A } };
        },
      });
      await flush();
      assert.deepEqual([...dispatches], synchronousAdvanceMs
        ? [[1, 'vm171', 0], [4, 'vm167', 6_500], [2, 'vm169', 6_500]] : [[1, 'vm171', 0]]);
      for (const deadline of (synchronousAdvanceMs ? [8_999, 9_000] : [2_999, 3_000, 5_999, 6_000, 8_999, 9_000])) {
        clockMs = deadline;
        for (const timer of timers.filter((entry) => entry.due <= clockMs)) timer.resolve();
        await flush();
        const expected = [[1, 'vm171', 0], [4, 'vm167', Math.max(3_000, synchronousAdvanceMs)],
          [2, 'vm169', Math.max(6_000, synchronousAdvanceMs)], [3, 'vm131', 9_000]];
        assert.deepEqual(dispatches, expected.filter((entry) => entry[2] <= clockMs));
      }
      assert.equal((await execution).completedCellIds.length, 4);
      for (const mutation of ['offset', 'worker', 'missing']) {
        const tampered = structuredClone(plan);
        if (mutation === 'offset') tampered.dispatchSchedule[1].startOffsetMs = 7_000;
        if (mutation === 'worker') tampered.dispatchSchedule[1].workerId = 'vm169';
        if (mutation === 'missing') delete tampered.dispatchSchedule;
        fs.writeFileSync(path.join(root, SHARD_EXECUTION_PLAN_FILE), JSON.stringify(tampered));
        let readinessCalls = 0;
        await assert.rejects(runCoordinatorWaves({
          plan: tampered, leases, executionRoot: root, now: () => now,
          assertWorkerReady: async () => { readinessCalls += 1; },
          dispatchCell: async () => assert.fail('tampered signed schedule must never dispatch'),
        }));
        assert.equal(readinessCalls, 0, 'schedule authentication precedes readiness and paid dispatch');
      }
    } finally {
      for (const timer of timers) timer.resolve();
      await execution?.catch(() => {});
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test('production three-worker local/SSH pins survive readiness, grant, signed plan, and final authorization verification', async () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-coordinator-prepare-'));
  try {
    const preflightEvidenceDirectory = path.join(outputRoot, 'preflight-raw');
    fs.mkdirSync(preflightEvidenceDirectory);
    const preflightEvidencePath = path.join(preflightEvidenceDirectory, 'emitter-result.json');
    fs.writeFileSync(preflightEvidencePath, '{"status":"completed"}\n', 'utf8');
    const calls = {
      provenance: 0,
      build: 0,
      implementation: 0,
      shardImplementation: 0,
      readiness: 0,
      preflight: 0,
      local: 0,
    };
    const config = validateProductionWorkerConfig({
      schemaVersion: 2, artifactKind: PRODUCTION_WORKER_CONFIG_KIND,
      workers: ['vm171', 'vm167', 'vm169'].map((workerId, index) => {
        fs.writeFileSync(path.join(outputRoot, `${workerId}-key`), 'fixture-only-private-key');
        fs.writeFileSync(path.join(outputRoot, `${workerId}-hosts`), `${workerId} ssh-ed25519 ${Buffer.from(`fixture-host-key-${index}`).toString('base64')}\n`);
        return {
          workerId, user: 'VMUser', workspaceRoot: 'E:\\worker', guestExecutionRoot: 'E:\\shards',
          transport: index === 0 ? { kind: 'local' } : { kind: 'ssh', host: `192.0.2.${index}`, port: 22, identityFile: `${workerId}-key`, knownHostsFile: `${workerId}-hosts`, hostKeyAlias: workerId },
          vmIdentity: { provider: 'vmware', uuidBios: `564d0000-0000-0000-0000-00000000000${index}` },
          deviceProfileInstances: [{ instanceId: `${workerId}-default`, profileId: `${workerId}-speaker`, deviceClass: 'default-speaker', physicalPlaybackDeviceId: `{${workerId}}`, expectedPhysicalPlaybackDeviceName: `Speaker ${workerId}` }],
        };
      }),
    }, { configDirectory: outputRoot });
    const productionWorkers = config.workers.map(({ workerId, user, vmIdentity, deviceProfileInstances, transport }) => ({
      workerId, interactiveUser: user, vmIdentity, deviceProfileInstances,
      transportAuthority: transport.kind === 'local' ? { kind: 'local' } : {
        kind: 'ssh', hostKeyAlias: transport.hostKeyAlias, hostKeyAlgorithm: transport.hostKeyAlgorithm, hostKeySha256: transport.hostKeySha256,
      },
    }));
    const generatedAt = new Date(Date.now() - 1000);
    const runtimeAuthority = runtimeInventoryWithDesktop(outputRoot);
    const resultSigningKeys = generateCoordinatorSigningKeyPair();
    const result = await prepareCoordinatorExecution({
      outputRoot,
      workspaceRoot: outputRoot,
      executionId: 'watch-shard-atomic-test',
      workers: productionWorkers,
      assignments: config.assignments,
      signingKeys: resultSigningKeys,
      generatedAt,
      expiresAt: new Date(generatedAt.getTime() + 3_600_000),
      captureProvenance: async () => { calls.provenance += 1; return PROVENANCE; },
      buildRuntimeAuthority: async ({ coordinatorKeyId, coordinatorPublicKeyPem }) => {
        calls.build += 1;
        assert.match(coordinatorKeyId, /^[a-f0-9]{64}$/);
        assert.match(coordinatorPublicKeyPem, /BEGIN PUBLIC KEY/);
        return runtimeAuthority;
      },
      captureAuthorityImplementationHashes: async () => { calls.implementation += 1; return inventory('matrix', SHA_A); },
      captureShardImplementationHashes: async () => { calls.shardImplementation += 1; return inventory('shard', SHA_A); },
      runZeroProviderWorkerReadiness: async (context) => {
        calls.readiness += 1;
        return writeReadinessFixture(context);
      },
      runProviderPreflight: async ({
        grant,
        grantPath,
        leaseReservationDirectory,
        authorization,
        authorizationDigest,
      }) => {
        calls.preflight += 1;
        assert.deepEqual(grant.workers.map((worker) => worker.transportAuthority), productionWorkers.map((worker) => worker.transportAuthority));
        assert.equal(JSON.stringify(grant.workers).includes('identityFile'), false);
        for (const mutation of ['drop', 'change-pin']) {
          const { digest: _digest, signature: _signature, ...core } = structuredClone(grant);
          if (mutation === 'drop') delete core.workers[1].transportAuthority;
          else core.workers[1].transportAuthority.hostKeySha256 = `SHA256:${'a'.repeat(43)}`;
          const tampered = signCoordinatorAuthority(core, resultSigningKeys.privateKeyPem, resultSigningKeys.publicKeyPem);
          assert.throws(() => verifyProviderPreflightGrant(tampered), /worker\/profile inventory mismatch|transport authority/);
        }
        assert.equal(calls.local, 1, 'local authority must precede provider authorization');
        assert.equal(fs.existsSync(grantPath), true, 'signed grant must be published before provider connect');
        assert.equal(fs.readdirSync(leaseReservationDirectory).length, SHARD_MATRIX_CELL_COUNT);
        assert.equal(new Set(grant.cells.map((cell) => cell.leaseId)).size, SHARD_MATRIX_CELL_COUNT);
        assert.deepEqual(
          grant.authorization.modelProtocolProfileIdentity,
          MODEL_PROTOCOL_PROFILE_IDENTITY,
        );
        assert.ok(grant.cells.every((cell) => (
          JSON.stringify(cell.modelProtocolProfileIdentity)
            === JSON.stringify(MODEL_PROTOCOL_PROFILE_IDENTITY)
        )));
        assert.ok(authorization.leaseReservations.every((reservation) => (
          JSON.stringify(reservation.modelProtocolProfileIdentity)
            === JSON.stringify(MODEL_PROTOCOL_PROFILE_IDENTITY)
        )));
        const desktop = runtimeAuthority.find((entry) => entry.path === 'target/release/omni-desktop-shell.exe');
        fs.writeFileSync(path.join(path.dirname(grantPath), 'provider-preflight-consumption-claim.json'), `${JSON.stringify({
          schemaVersion: 3,
          artifactKind: 'watch-mode-provider-preflight-consumption-claim',
          executionId: grant.executionId,
          grantDigest: grant.digest,
          authorizationDigest,
          coordinatorKeyId: grant.signature.keyId,
          claimedAt: new Date(Math.max(...authorization.reservationIssuedAts.map(Date.parse)) + 1).toISOString(),
          desktopProcessId: 4242,
          desktopExecutablePath: path.join(outputRoot, 'target', 'release', 'omni-desktop-shell.exe'),
          desktopExecutableRelativePath: 'target/release/omni-desktop-shell.exe',
          desktopExecutableBytes: desktop.bytes,
          desktopExecutableSha256: desktop.sha256,
          retryPolicy: 'new-execution-required',
        }, null, 2)}\n`, 'utf8');
        return {
          ...structuredClone(PREFLIGHT_LIFECYCLE_AUTHORITY),
          providerInvocationCount: PREFLIGHT_LIFECYCLE_AUTHORITY.invocationCount,
          evidenceDirectory: preflightEvidenceDirectory,
        };
      },
      obtainLocalIsolationAuthority: async () => {
        calls.local += 1;
        return { path: 'local-isolation.json', bytes: 91, sha256: SHA_A, providerCalls: 0 };
      },
      validateProviderPreflightEvidence: (_root, { expectedAuthorization }) => ({
        issues: [],
        evidenceTimes: [new Date(
          Math.max(...expectedAuthorization.reservationIssuedAts.map(Date.parse)) + 1,
        ).toISOString()],
        summary: {
          ...structuredClone(PREFLIGHT_LIFECYCLE_AUTHORITY),
          providerInvocationCount: PREFLIGHT_LIFECYCLE_AUTHORITY.invocationCount,
          executionId: expectedAuthorization.executionId,
          grantDigest: expectedAuthorization.grantDigest,
          leaseReservationDigests: expectedAuthorization.leaseReservationDigests,
          authorizationDigest: expectedAuthorization.authorizationDigest,
          consumptionClaim: expectedAuthorization.consumptionClaim,
          lifecycleBudget: structuredClone(expectedAuthorization.lifecycleBudget),
        },
      }),
    });
    assert.deepEqual(calls, {
      provenance: 3,
      build: 1,
      implementation: 1,
      shardImplementation: 1,
      readiness: 1,
      preflight: 1,
      local: 1,
    });
    assert.equal(path.basename(result.planPath), SHARD_EXECUTION_PLAN_FILE);
    assert.equal(result.leasePaths.length, SHARD_MATRIX_CELL_COUNT);
    assert.deepEqual(
      result.leases.map((lease) => lease.leaseId),
      result.plan.cells.map((cell) => cell.leaseId),
    );
    assert.ok(result.leasePaths.every((leasePath) => fs.existsSync(leasePath)));
    assert.equal(new Set(result.leases.map((lease) => lease.leaseId)).size, SHARD_MATRIX_CELL_COUNT);
    assert.equal(
      result.leases.reduce((sum, lease) => sum + lease.maxExternalAudioSamples, 0),
      SHARD_MATRIX_MAX_EXTERNAL_AUDIO_SAMPLES,
    );
    assert.equal(verifySignedExecutionPlan(result.plan).planDigest, result.plan.planDigest);
    const grant = JSON.parse(fs.readFileSync(path.join(result.executionRoot, 'provider-preflight-grant.json'), 'utf8'));
    const projection = {
      providerPreflightGrant: result.plan.providerPreflightGrant,
      providerPreflightLeaseReservations: result.plan.providerPreflightLeaseReservations.map(({ cellIndex: _cellIndex, ...entry }) => entry),
      providerPreflightAuthorization: result.plan.providerPreflightAuthorization,
      providerPreflightCompletion: result.plan.providerPreflightCompletion,
      workerReadinessRequest: fileAuthorityEntry(path.join(result.executionRoot, 'worker-readiness-request.json'), 'worker-readiness-request.json'),
      workerReadiness: grant.workerReadinessAuthorities,
    };
    const finalOptions = {
      plan: result.plan, executionRoot: result.executionRoot, executionRootRelative: '', evidenceRoot: outputRoot, workspaceRoot: outputRoot,
      shardExecution: projection, matrixIntegration: projection, currentImplementationHashes: inventory('matrix', SHA_A),
      currentRuntimeBinaryHashes: runtimeAuthority, currentShardImplementationHashes: inventory('shard', SHA_A), validationAt: new Date(),
    };
    const verifiedAuthorization = verifyStrictShardProviderPreflightAuthorization(finalOptions);
    assert.deepEqual(verifiedAuthorization.grant.workers.map((worker) => worker.transportAuthority), productionWorkers.map((worker) => worker.transportAuthority));
    for (const mutation of ['drop', 'change-pin']) {
      const tamperedPlan = structuredClone(result.plan);
      if (mutation === 'drop') delete tamperedPlan.workers[1].transportAuthority;
      else tamperedPlan.workers[1].transportAuthority.hostKeySha256 = `SHA256:${'b'.repeat(43)}`;
      assert.throws(() => verifyStrictShardProviderPreflightAuthorization({ ...finalOptions, plan: tamperedPlan }), /grant workers/);
    }
    for (const lease of result.leases) verifyCellLease(lease, result.plan);
    const preflight = JSON.parse(fs.readFileSync(
      path.join(result.executionRoot, COORDINATOR_PROVIDER_PREFLIGHT_FILE),
      'utf8',
    ));
    assert.equal(preflight.invocationCount, 1);
    assert.equal(preflight.operation, 'livetranslate-session-lifecycle-preflight');
    assert.equal(preflight.inputMode, 'none');
    assert.equal(preflight.providerInputMode, 'none');
    assert.equal(preflight.responseMode, 'text-only');
    assert.equal(preflight.terminalEvent, 'session.finished');
    assert.equal(preflight.model, PROVIDER_PREFLIGHT_MODEL);
    assert.deepEqual(
      preflight.modelProtocolProfileIdentity,
      MODEL_PROTOCOL_PROFILE_IDENTITY,
    );
    assert.equal(preflight.externalAudioSamples, 0);
    const publishedText = fs.readdirSync(result.executionRoot, { recursive: true, encoding: 'utf8' })
      .filter((entry) => entry.endsWith('.json'))
      .map((entry) => fs.readFileSync(path.join(result.executionRoot, entry), 'utf8'))
      .join('\n');
    assert.equal(publishedText.includes(result.signingKeys.privateKeyPem), false, 'private key must never be published');
    assert.equal(fs.readdirSync(outputRoot).some((entry) => entry.includes('.preparing-')), false);

    await assert.rejects(
      prepareCoordinatorExecution({
        outputRoot,
        executionId: 'watch-shard-atomic-test',
        workers: workers(),
      }),
      /refusing to reuse coordinator executionId/,
    );
    assert.equal(calls.preflight, 1, 'reopening an execution must not repeat the paid provider preflight');
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('a failed preflight leaves a durable execution reservation and cannot be repeated after restart', async () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-coordinator-preflight-fail-'));
  try {
    let preflightCalls = 0;
    const generatedAt = new Date();
    const options = {
      outputRoot,
      executionId: 'watch-shard-preflight-failure',
      workers: workers(),
      generatedAt,
      expiresAt: new Date(generatedAt.getTime() + 3_600_000),
      captureProvenance: async () => PROVENANCE,
      buildRuntimeAuthority: async () => runtimeInventory(),
      captureAuthorityImplementationHashes: async () => inventory('matrix', SHA_A),
      captureShardImplementationHashes: async () => inventory('shard', SHA_A),
      runZeroProviderWorkerReadiness: async (context) => writeReadinessFixture(context),
      runProviderPreflight: async () => {
        preflightCalls += 1;
        throw new Error('text preflight unavailable');
      },
      obtainLocalIsolationAuthority: async () => ({
        path: 'local.json', bytes: 1, sha256: SHA_A, providerCalls: 0,
      }),
    };
    await assert.rejects(prepareCoordinatorExecution(options), /text preflight unavailable/);
    assert.equal(preflightCalls, 1);
    assert.ok(fs.existsSync(path.join(outputRoot, 'watch-shard-preflight-failure.reservation.json')));
    await assert.rejects(prepareCoordinatorExecution(options), /refusing to reuse coordinator executionId/);
    assert.equal(preflightCalls, 1, 'restart must require a new execution rather than repeat preflight');
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('insufficient remaining execution validity stops before the paid text preflight', async () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-coordinator-expiry-'));
  let preflightCalls = 0;
  try {
    const generatedAt = new Date();
    await assert.rejects(prepareCoordinatorExecution({
      outputRoot,
      executionId: 'watch-shard-insufficient-validity',
      workers: workers(),
      generatedAt,
      expiresAt: new Date(generatedAt.getTime() + 60 * 60 * 1_000),
      now: () => new Date(generatedAt.getTime() + 30 * 60 * 1_000),
      minimumRemainingExecutionMs: 45 * 60 * 1_000,
      captureProvenance: async () => PROVENANCE,
      buildRuntimeAuthority: async () => runtimeInventory(),
      captureAuthorityImplementationHashes: async () => inventory('matrix', SHA_A),
      captureShardImplementationHashes: async () => inventory('shard', SHA_A),
      runZeroProviderWorkerReadiness: async (context) => writeReadinessFixture(context),
      runProviderPreflight: async () => { preflightCalls += 1; throw new Error('must not run'); },
      obtainLocalIsolationAuthority: async () => ({
        path: 'local.json', bytes: 1, sha256: SHA_A, providerCalls: 0,
      }),
    }), /validity is insufficient/);
    assert.equal(preflightCalls, 0);
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('worker readiness failure stops before the paid text preflight', async () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-coordinator-readiness-fail-'));
  let preflightCalls = 0;
  try {
    const generatedAt = new Date();
    await assert.rejects(prepareCoordinatorExecution({
      outputRoot,
      executionId: 'watch-shard-readiness-failure',
      workers: workers(),
      generatedAt,
      expiresAt: new Date(generatedAt.getTime() + 3_600_000),
      captureProvenance: async () => PROVENANCE,
      buildRuntimeAuthority: async () => runtimeInventory(),
      captureAuthorityImplementationHashes: async () => inventory('matrix', SHA_A),
      captureShardImplementationHashes: async () => inventory('shard', SHA_A),
      runZeroProviderWorkerReadiness: async () => {
        throw new Error('vm2 endpoint profile is unavailable');
      },
      runProviderPreflight: async () => {
        preflightCalls += 1;
        throw new Error('must not run');
      },
      obtainLocalIsolationAuthority: async () => ({
        path: 'local.json', bytes: 1, sha256: SHA_A, providerCalls: 0,
      }),
    }), /vm2 endpoint profile is unavailable/);
    assert.equal(preflightCalls, 0);
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('coordinator fully validates staged driver and credential readiness before text preflight', async () => {
  for (const scenario of [
    {
      name: 'driver package hash',
      mutate: (receipt, worker) => {
        if (worker.workerId === 'vm1') receipt.driver.packageSysSha256 = SHA_A;
      },
      expected: /installed driver does not match/,
    },
    {
      name: 'credential process timestamp',
      mutate: (receipt, worker) => {
        if (worker.workerId === 'vm1') {
          receipt.credentialStatus.checkedAt = new Date(
            Date.parse(receipt.generatedAt) + 1_000,
          ).toISOString();
        }
      },
      expected: /credential status is not bound/,
    },
    {
      name: 'empty credential blob',
      mutate: (receipt, worker) => {
        if (worker.workerId === 'vm1') {
          receipt.credentialStatus.blobNonEmpty = false;
          receipt.credentialStatus.credentialBlobBytes = 0;
        }
      },
      expected: /credential status is not bound/,
    },
  ]) {
    const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-readiness-full-check-'));
    let preflightCalls = 0;
    try {
      const generatedAt = new Date();
      await assert.rejects(prepareCoordinatorExecution({
        outputRoot,
        executionId: `watch-readiness-${scenario.name.replaceAll(' ', '-')}`,
        workers: workers(),
        generatedAt,
        expiresAt: new Date(generatedAt.getTime() + 3_600_000),
        captureProvenance: async () => PROVENANCE,
        buildRuntimeAuthority: async () => runtimeInventory(),
        captureAuthorityImplementationHashes: async () => inventory('matrix', SHA_A),
        captureShardImplementationHashes: async () => inventory('shard', SHA_A),
        runZeroProviderWorkerReadiness: async (context) => writeReadinessFixture(
          context,
          scenario.mutate,
        ),
        runProviderPreflight: async () => { preflightCalls += 1; throw new Error('must not run'); },
        obtainLocalIsolationAuthority: async () => ({
          path: 'local.json', bytes: 1, sha256: SHA_A, providerCalls: 0,
        }),
      }), scenario.expected);
      assert.equal(preflightCalls, 0, `${scenario.name} must fail before text preflight`);
    } finally {
      fs.rmSync(outputRoot, { recursive: true, force: true });
    }
  }
});

test('coordinator completes every bounded serial wave without redispatch or local retries', async () => {
  const value = signedFixture();
  const executionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-coordinator-waves-'));
  fs.writeFileSync(path.join(executionRoot, SHARD_EXECUTION_PLAN_FILE), `${JSON.stringify(value.plan)}\n`, 'utf8');
  const dispatches = [];
  const completedWaves = [];
  const ready = [];
  try {
    const outcome = await runCoordinatorWaves({
      plan: value.plan,
      leases: value.leases,
      executionRoot,
      now: () => value.now,
      assertWorkerReady: async ({ worker }) => { ready.push(worker.workerId); },
      dispatchCell: async ({ waveIndex, cell, lease }) => {
        dispatches.push({ waveIndex, cellId: cell.cellId, leaseId: lease.leaseId });
        return { result: { verdict: 'passed', leaseId: lease.leaseId, resultDigest: 'a'.repeat(64) } };
      },
      onWaveCompleted: async ({ waveIndex }) => { completedWaves.push(waveIndex); },
    });
    assert.deepEqual(ready.sort(), ['vm1']);
    assert.equal(dispatches.length, SHARD_MATRIX_CELL_COUNT);
    assert.equal(new Set(dispatches.map((entry) => entry.cellId)).size, SHARD_MATRIX_CELL_COUNT);
    assert.equal(new Set(dispatches.map((entry) => entry.leaseId)).size, SHARD_MATRIX_CELL_COUNT);
    const expectedWaves = Array.from({ length: SHARD_MATRIX_CELL_COUNT }, (_, index) => index);
    assert.deepEqual(dispatches.map((entry) => entry.waveIndex), expectedWaves);
    assert.deepEqual(completedWaves, expectedWaves);
    assert.equal(outcome.completedCellIds.length, SHARD_MATRIX_CELL_COUNT);
    assert.equal(
      fs.readdirSync(path.join(executionRoot, 'dispatch-claims')).length,
      SHARD_MATRIX_CELL_COUNT,
    );
  } finally {
    fs.rmSync(executionRoot, { recursive: true, force: true });
  }
});

test('serial wave failure cancels its own unfinished dispatch and never dispatches a later paid wave', async () => {
  const value = signedFixture();
  const executionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-coordinator-fail-'));
  fs.writeFileSync(path.join(executionRoot, SHARD_EXECUTION_PLAN_FILE), `${JSON.stringify(value.plan)}\n`, 'utf8');
  const started = [];
  const cancelled = [];
  const failingCellId = value.plan.waves[1].cellIds[0];
  try {
    await assert.rejects(
      runCoordinatorWaves({
        plan: value.plan,
        leases: value.leases,
        executionRoot,
        now: () => value.now,
        dispatchCell: ({ waveIndex, cell, lease, signal }) => {
          started.push(cell.cellId);
          if (waveIndex === 0) return Promise.resolve({ result: { verdict: 'passed', leaseId: lease.leaseId, resultDigest: 'b'.repeat(64) } });
          if (cell.cellId === failingCellId) {
            return new Promise((_, reject) => setImmediate(() => reject(new Error('authoritative report failed'))));
          }
          return new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(new Error('cancelled by peer failure')), { once: true });
          });
        },
        cancelCell: async ({ cell }) => { cancelled.push(cell.cellId); },
      }),
      (error) => {
        assert.ok(error instanceof CoordinatorWaveFailure);
        assert.equal(error.waveIndex, 1);
        assert.match(error.message, /authoritative report failed/);
        return true;
      },
    );
    assert.deepEqual(started.slice(0, 1), value.plan.waves[0].cellIds);
    assert.ok(value.plan.waves[1].cellIds.every((cellId) => started.includes(cellId)));
    assert.equal(value.plan.waves[2].cellIds.some((cellId) => started.includes(cellId)), false);
    assert.deepEqual(cancelled, [failingCellId], 'only the started, unfinished cell requires cleanup');
  } finally {
    fs.rmSync(executionRoot, { recursive: true, force: true });
  }
});

test('readiness failure stops before every paid cell and before a lease is dispatched', async () => {
  const value = signedFixture();
  const executionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-coordinator-ready-'));
  fs.writeFileSync(path.join(executionRoot, SHARD_EXECUTION_PLAN_FILE), `${JSON.stringify(value.plan)}\n`, 'utf8');
  let dispatchCount = 0;
  try {
    await assert.rejects(
      runCoordinatorWaves({
        plan: value.plan,
        leases: value.leases,
        executionRoot,
        now: () => value.now,
        assertWorkerReady: async ({ worker }) => {
          if (worker.workerId === 'vm1') throw new Error('runtime bundle mismatch');
        },
        dispatchCell: async () => { dispatchCount += 1; },
      }),
      /readiness failed before paid dispatch/,
    );
    assert.equal(dispatchCount, 0);
    assert.equal(fs.existsSync(path.join(executionRoot, 'dispatch-claims')), false);
  } finally {
    fs.rmSync(executionRoot, { recursive: true, force: true });
  }
});

test('durable coordinator dispatch claims prevent lease redispatch after coordinator restart', async () => {
  const value = signedFixture();
  const executionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-coordinator-restart-'));
  fs.writeFileSync(path.join(executionRoot, SHARD_EXECUTION_PLAN_FILE), `${JSON.stringify(value.plan)}\n`, 'utf8');
  let firstDispatches = 0;
  try {
    await assert.rejects(
      runCoordinatorWaves({
        plan: value.plan,
        leases: value.leases,
        executionRoot,
        now: () => value.now,
        dispatchCell: async ({ waveIndex }) => {
          firstDispatches += 1;
          if (waveIndex === 0) throw new Error('simulated coordinator loss');
          return { result: { verdict: 'passed', resultDigest: 'c'.repeat(64) } };
        },
      }),
      CoordinatorWaveFailure,
    );
    assert.ok(firstDispatches >= 1);
    let restartDispatches = 0;
    await assert.rejects(
      runCoordinatorWaves({
        plan: value.plan,
        leases: value.leases,
        executionRoot,
        now: () => value.now,
        dispatchCell: async () => {
          restartDispatches += 1;
          return { result: { verdict: 'passed', resultDigest: 'd'.repeat(64) } };
        },
      }),
      /refusing to overwrite immutable authority file/,
    );
    assert.equal(restartDispatches, 0);
  } finally {
    fs.rmSync(executionRoot, { recursive: true, force: true });
  }
});

test('coordinator dispatch requires the immutable plan file beneath executionRoot', async () => {
  const value = signedFixture();
  const executionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-coordinator-root-bind-'));
  let dispatches = 0;
  try {
    await assert.rejects(
      runCoordinatorWaves({
        plan: value.plan,
        leases: value.leases,
        executionRoot,
        now: () => value.now,
        dispatchCell: async () => { dispatches += 1; },
      }),
      /coordinator execution plan|ENOENT/,
    );
    assert.equal(dispatches, 0);
    fs.writeFileSync(path.join(executionRoot, SHARD_EXECUTION_PLAN_FILE), '{}\n', 'utf8');
    await assert.rejects(
      runCoordinatorWaves({
        plan: value.plan,
        leases: value.leases,
        executionRoot,
        now: () => value.now,
        dispatchCell: async () => { dispatches += 1; },
      }),
      /does not match the in-memory signed plan/,
    );
    assert.equal(dispatches, 0);
  } finally {
    fs.rmSync(executionRoot, { recursive: true, force: true });
  }
});

function fakeValidatedShard(plan, leases, worker, { duplicateCellId = null } = {}) {
  const cells = plan.cells.filter((cell) => cell.workerId === worker.workerId);
  return {
    manifest: {
      workerId: worker.workerId,
      manifestDigest: `${worker.workerId}-manifest-digest`,
    },
    worker,
    validatedResults: cells.map((cell, index) => {
      const lease = leases.find((entry) => entry.leaseId === cell.leaseId);
      const representedCell = duplicateCellId && index === 0
        ? plan.cells.find((entry) => entry.cellId === duplicateCellId)
        : cell;
      return {
        cell: representedCell,
        runDirectory: path.join('C:\\staged', worker.workerId, `cell-${cell.cellIndex}`),
        result: {
          resultDigest: `${worker.workerId}-${cell.cellIndex}-result`,
          leaseId: lease.leaseId,
          leaseDigest: lease.leaseDigest,
          runDirectory: `runs/cell-${cell.cellIndex}`,
          worker: { workerId: worker.workerId, vmIdentityDigest: worker.vmIdentityDigest },
          usageAuthority: {
            leaseId: lease.leaseId,
            actualExternalAudioSamples: 16_000 + cell.cellIndex,
            maxExternalAudioSamples: SHARD_CELL_MAX_EXTERNAL_AUDIO_SAMPLES,
          },
          deviceAuthority: {
            profileId: cell.deviceProfileInstance.profileId,
            deviceClass: cell.deviceClass,
          },
        },
      };
    }),
  };
}

test('coordinator aggregate canonicalizes arrival order and binds every cell to one unique lease', () => {
  const value = signedFixture();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-coordinator-aggregate-'));
  try {
    const executionRoot = path.join(root, 'execution');
    fs.mkdirSync(executionRoot);
    fs.writeFileSync(path.join(executionRoot, SHARD_EXECUTION_PLAN_FILE), `${JSON.stringify(value.plan)}\n`, 'utf8');
    const shards = value.plan.workers.map((worker) => {
      const shardRoot = path.join(root, worker.workerId);
      fs.mkdirSync(shardRoot, { recursive: true });
      const manifestPath = path.join(shardRoot, 'shard-manifest.json');
      fs.writeFileSync(manifestPath, `${worker.workerId}\n`, 'utf8');
      return { shardRoot, manifestPath };
    }).reverse();
    const validatedByRoot = new Map(value.plan.workers.map((worker) => [
      path.join(root, worker.workerId),
      fakeValidatedShard(value.plan, value.leases, worker),
    ]));
    const resultByCellForReceipts = new Map();
    for (const validated of validatedByRoot.values()) {
      for (const entry of validated.validatedResults) resultByCellForReceipts.set(entry.cell.cellId, entry);
    }
    let timestamp = value.now.getTime();
    for (const wave of value.plan.waves) {
      for (const cellId of wave.cellIds) {
        const cell = value.plan.cells.find((entry) => entry.cellId === cellId);
        const lease = value.leases.find((entry) => entry.leaseId === cell.leaseId);
        const claim = {
          schemaVersion: 3,
          artifactKind: 'watch-mode-shard-dispatch-claim',
          claimedAt: new Date(timestamp).toISOString(),
          executionId: value.plan.executionId,
          planDigest: value.plan.planDigest,
          cellIndex: cell.cellIndex,
          cellId,
          workerId: cell.workerId,
          waveIndex: cell.waveIndex,
          leaseId: lease.leaseId,
          leaseDigest: lease.leaseDigest,
          retryPolicy: 'new-execution-required',
        };
        fs.mkdirSync(path.join(executionRoot, 'dispatch-claims'), { recursive: true });
        fs.writeFileSync(path.join(executionRoot, 'dispatch-claims', `${lease.leaseId}.json`), `${JSON.stringify(claim)}\n`, 'utf8');
      }
      timestamp += 1_000;
      const cells = wave.cellIds.map((cellId) => {
        const cell = value.plan.cells.find((entry) => entry.cellId === cellId);
        return {
          cellIndex: cell.cellIndex,
          cellId,
          leaseId: cell.leaseId,
          resultDigest: resultByCellForReceipts.get(cellId).result.resultDigest,
        };
      });
      const core = {
        schemaVersion: 3,
        artifactKind: 'watch-mode-shard-wave-completion',
        completedAt: new Date(timestamp).toISOString(),
        executionId: value.plan.executionId,
        planDigest: value.plan.planDigest,
        waveIndex: wave.waveIndex,
        cells,
      };
      fs.mkdirSync(path.join(executionRoot, 'wave-completions'), { recursive: true });
      fs.writeFileSync(
        path.join(executionRoot, 'wave-completions', `wave-${wave.waveIndex}.json`),
        `${JSON.stringify({ ...core, receiptDigest: sha256Canonical(core) })}\n`,
        'utf8',
      );
      timestamp += 1_000;
    }
    const result = collectCoordinatorAggregation({
      plan: value.plan,
      leases: value.leases,
      shards,
      executionRoot,
      generatedAt: value.now,
      validateShard: ({ shardRoot }) => validatedByRoot.get(path.resolve(shardRoot)),
    });
    assert.deepEqual(
      result.aggregate.cells.map((cell) => cell.cellId),
      value.plan.cells.map((cell) => cell.cellId),
    );
    assert.equal(
      new Set(result.aggregate.cells.map((cell) => cell.leaseId)).size,
      SHARD_MATRIX_CELL_COUNT,
    );
    assert.equal(result.aggregate.budget.reservedExternalAudioSamples, SHARD_MATRIX_MAX_EXTERNAL_AUDIO_SAMPLES);
    assert.equal(result.aggregate.budget.preflightExternalAudioSamples, 0);
    assert.equal(result.matrixIntegration.cells.length, SHARD_MATRIX_CELL_COUNT);
    assert.ok(result.matrixIntegration.cells.every((cell) => path.isAbsolute(cell.sourceRunDirectory)));
    assert.equal(validateCoordinatorAggregate(result.aggregate), result.aggregate);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('coordinator aggregate rejects cross-worker cell substitution even with valid-looking shard hashes', () => {
  const value = signedFixture();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-coordinator-mix-'));
  try {
    const shards = value.plan.workers.map((worker) => {
      const shardRoot = path.join(root, worker.workerId);
      fs.mkdirSync(shardRoot, { recursive: true });
      const manifestPath = path.join(shardRoot, 'shard-manifest.json');
      fs.writeFileSync(manifestPath, 'manifest\n', 'utf8');
      return { shardRoot, manifestPath };
    });
    const firstCellId = value.plan.cells[0].cellId;
    const validatedByRoot = new Map(value.plan.workers.map((worker, index) => [
      path.join(root, worker.workerId),
      fakeValidatedShard(value.plan, value.leases, worker, { duplicateCellId: index === 2 ? firstCellId : null }),
    ]));
    assert.throws(
      () => collectCoordinatorAggregation({
        plan: value.plan,
        leases: value.leases,
        shards,
        executionRoot: root,
        generatedAt: value.now,
        validateShard: ({ shardRoot }) => validatedByRoot.get(path.resolve(shardRoot)),
      }),
      /execution plan is missing|duplicate cell|cell\/lease binding mismatch/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('coordinator execution authority rejects dispatching a later wave before the prior wave completion', async () => {
  const value = signedFixture();
  const executionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-coordinator-wave-order-'));
  try {
    fs.writeFileSync(path.join(executionRoot, SHARD_EXECUTION_PLAN_FILE), `${JSON.stringify(value.plan)}\n`, 'utf8');
    let currentMs = value.now.getTime();
    const outcome = await runCoordinatorWaves({
      plan: value.plan,
      leases: value.leases,
      executionRoot,
      now: () => new Date(currentMs += 1_000),
      dispatchCell: async ({ lease }) => ({
        result: { verdict: 'passed', leaseId: lease.leaseId, resultDigest: 'e'.repeat(64) },
      }),
    });
    const waveOneCell = value.plan.cells.find((cell) => cell.waveIndex === 1);
    const claimPath = path.join(executionRoot, 'dispatch-claims', `${waveOneCell.leaseId}.json`);
    const claim = JSON.parse(fs.readFileSync(claimPath, 'utf8'));
    const priorCompletion = JSON.parse(fs.readFileSync(
      path.join(executionRoot, 'wave-completions', 'wave-0.json'),
      'utf8',
    ));
    claim.claimedAt = new Date(Date.parse(priorCompletion.completedAt) - 1_000).toISOString();
    fs.writeFileSync(claimPath, `${JSON.stringify(claim)}\n`, 'utf8');
    assert.throws(
      () => validateCoordinatorExecutionAuthority({
        executionRoot,
        plan: value.plan,
        leases: value.leases,
        resultByCell: outcome.results,
      }),
      /dispatched wave 1 before wave 0 completed/,
    );
  } finally {
    fs.rmSync(executionRoot, { recursive: true, force: true });
  }
});
