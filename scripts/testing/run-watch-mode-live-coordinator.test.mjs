import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  SHARD_CELL_MAX_EXTERNAL_AUDIO_SAMPLES,
  SHARD_EXECUTION_PLAN_FILE,
  SHARD_MATRIX_MAX_EXTERNAL_AUDIO_SAMPLES,
  createWorkerReadinessRequest,
  createSignedExecutionPlan,
  fileAuthorityEntry,
  generateCoordinatorSigningKeyPair,
  issueCellLeases,
  sha256Canonical,
  verifyCellLease,
  verifySignedExecutionPlan,
} from './watch-mode-shard-authority.mjs';
import {
  COORDINATOR_PROVIDER_PREFLIGHT_FILE,
  CoordinatorWaveFailure,
  collectCoordinatorAggregation,
  defaultThreeVmAssignments,
  prepareCoordinatorExecution,
  runCoordinatorWaves,
  validateCoordinatorAggregate,
  validateCoordinatorExecutionAuthority,
} from './run-watch-mode-live-coordinator.mjs';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
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
        schemaVersion: 1,
        artifactKind: 'watch-mode-production-worker-zero-provider-readiness',
        generatedAt,
        executionId: context.executionId,
        readinessRequestDigest: workerReadinessRequest.requestDigest,
        workerId: worker.workerId,
        vmIdentityDigest: worker.vmIdentityDigest,
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
    {
      workerId: 'vm2', vmIdentity: { provider: 'vmware', uuidBios: '56-4d-vm-2' },
      deviceProfileInstances: [
        {
          instanceId: 'vm2-default', profileId: 'vmware-hda-default', deviceClass: 'default-speaker',
          physicalPlaybackDeviceId: 'default', expectedPhysicalPlaybackDeviceName: '',
        },
        {
          instanceId: 'vm2-usb', profileId: 'realtek-usb-spdif', deviceClass: 'usb',
          physicalPlaybackDeviceId: '{realtek-usb-endpoint}', expectedPhysicalPlaybackDeviceName: 'Realtek USB Test',
        },
      ],
    },
    {
      workerId: 'vm3', vmIdentity: { provider: 'vmware', uuidBios: '56-4d-vm-3' },
      deviceProfileInstances: [{
        instanceId: 'vm3-default', profileId: 'vmware-hda-default', deviceClass: 'default-speaker',
        physicalPlaybackDeviceId: 'default', expectedPhysicalPlaybackDeviceName: '',
      }],
    },
  ];
}

function signedFixture() {
  const now = new Date();
  const generatedAt = new Date(now.getTime() - 1_000);
  const keys = generateCoordinatorSigningKeyPair();
  const workerList = workers();
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
       operation: 'text-translation-preflight', status: 'completed', externalAudioSamples: 0, invocationCount: 1,
       tokenBudget: { maxInputTokens: 4_096, maxOutputTokens: 256 },
       inputTokens: 64, outputTokens: 12, audioSeconds: null,
     },
    workers: workerList,
    assignments: defaultThreeVmAssignments(workerList),
    ...keys,
  });
  return {
    now,
    plan,
    keys,
    leases: issueCellLeases(plan, keys.privateKeyPem, { issuedAt: generatedAt }),
  };
}

test('default three-VM placement assigns every USB cell to VM2 and permits one cell per worker/wave', () => {
  const workerList = workers();
  const assignments = defaultThreeVmAssignments(workerList);
  assert.deepEqual(assignments.map((entry) => entry.waveIndex), [0, 0, 0, 1, 1, 2, 2, 1]);
  assert.deepEqual(
    assignments.filter((_, index) => [1, 3, 5].includes(index)).map((entry) => entry.workerId),
    ['vm2', 'vm2', 'vm2'],
  );
  assert.equal(
    new Set(assignments.map((entry) => `${entry.workerId}:${entry.waveIndex}`)).size,
    assignments.length,
  );
});

test('two-VM placement is capability-driven across four waves with all virtual-driver cells on the USB-capable VM', () => {
  const workerList = workers().slice(0, 2);
  const assignments = defaultThreeVmAssignments(workerList);
  assert.deepEqual(assignments.map((entry) => entry.waveIndex), [0, 0, 1, 1, 2, 3, 2, 3]);
  assert.deepEqual(
    assignments.map((entry) => entry.workerId),
    ['vm1', 'vm2', 'vm1', 'vm2', 'vm2', 'vm2', 'vm1', 'vm1'],
  );
  assert.equal(new Set(assignments.map((entry) => `${entry.workerId}:${entry.waveIndex}`)).size, 8);
  assert.throws(() => defaultThreeVmAssignments(workerList.slice(0, 1)), /two or three workers/);
  assert.throws(() => defaultThreeVmAssignments([...workers(), {
    ...workers()[0], workerId: 'vm4', vmIdentity: { provider: 'vmware', uuidBios: 'vm-four' },
  }]), /two or three workers/);
});

test('coordinator prepares build/preflight/local once and atomically publishes exactly eight signed leases', async () => {
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
    const generatedAt = new Date();
    const runtimeAuthority = runtimeInventoryWithDesktop(outputRoot);
    const result = await prepareCoordinatorExecution({
      outputRoot,
      workspaceRoot: outputRoot,
      executionId: 'watch-shard-atomic-test',
      workers: workers(),
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
        assert.equal(calls.local, 1, 'local authority must precede provider authorization');
        assert.equal(fs.existsSync(grantPath), true, 'signed grant must be published before provider connect');
        assert.equal(fs.readdirSync(leaseReservationDirectory).length, 8);
        assert.equal(new Set(grant.cells.map((cell) => cell.leaseId)).size, 8);
        const desktop = runtimeAuthority.find((entry) => entry.path === 'target/release/omni-desktop-shell.exe');
        fs.writeFileSync(path.join(path.dirname(grantPath), 'provider-preflight-consumption-claim.json'), `${JSON.stringify({
          schemaVersion: 1,
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
          providerId: 'provider-dashscope',
          operation: 'text-translation-preflight',
          inputMode: 'text-only',
          providerInvocationCount: 1,
          status: 'completed',
          externalAudioSamples: 0,
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
          providerId: 'provider-dashscope',
          model: 'qwen3.5-omni-flash-realtime',
          protocol: 'dashscope-omni',
          operation: 'text-translation-preflight',
          inputMode: 'text-only',
          externalAudioSamples: 0,
          providerInvocationCount: 1,
          executionId: expectedAuthorization.executionId,
          grantDigest: expectedAuthorization.grantDigest,
          leaseReservationDigests: expectedAuthorization.leaseReservationDigests,
          authorizationDigest: expectedAuthorization.authorizationDigest,
          consumptionClaim: expectedAuthorization.consumptionClaim,
          tokenBudget: expectedAuthorization.tokenBudget,
          inputTokens: 64,
          outputTokens: 12,
          audioSeconds: null,
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
    assert.equal(result.leasePaths.length, 8);
    assert.deepEqual(
      result.leases.map((lease) => lease.leaseId),
      result.plan.cells.map((cell) => cell.leaseId),
    );
    assert.ok(result.leasePaths.every((leasePath) => fs.existsSync(leasePath)));
    assert.equal(new Set(result.leases.map((lease) => lease.leaseId)).size, 8);
    assert.equal(
      result.leases.reduce((sum, lease) => sum + lease.maxExternalAudioSamples, 0),
      SHARD_MATRIX_MAX_EXTERNAL_AUDIO_SAMPLES,
    );
    assert.equal(verifySignedExecutionPlan(result.plan).planDigest, result.plan.planDigest);
    for (const lease of result.leases) verifyCellLease(lease, result.plan);
    const preflight = JSON.parse(fs.readFileSync(
      path.join(result.executionRoot, COORDINATOR_PROVIDER_PREFLIGHT_FILE),
      'utf8',
    ));
    assert.equal(preflight.invocationCount, 1);
    assert.equal(preflight.operation, 'text-translation-preflight');
    assert.equal(preflight.inputMode, 'text-only');
    assert.equal(preflight.model, 'qwen3.5-omni-flash-realtime');
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
        if (worker.workerId === 'vm2') receipt.driver.packageSysSha256 = SHA_A;
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

test('coordinator completes three bounded waves without redispatch or local retries', async () => {
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
    assert.deepEqual(ready.sort(), ['vm1', 'vm2', 'vm3']);
    assert.equal(dispatches.length, 8);
    assert.equal(new Set(dispatches.map((entry) => entry.cellId)).size, 8);
    assert.equal(new Set(dispatches.map((entry) => entry.leaseId)).size, 8);
    assert.deepEqual(dispatches.map((entry) => entry.waveIndex), [0, 0, 0, 1, 1, 1, 2, 2]);
    assert.deepEqual(completedWaves, [0, 1, 2]);
    assert.equal(outcome.completedCellIds.length, 8);
    assert.equal(fs.readdirSync(path.join(executionRoot, 'dispatch-claims')).length, 8);
  } finally {
    fs.rmSync(executionRoot, { recursive: true, force: true });
  }
});

test('wave failure cancels active peers and never dispatches a later paid wave', async () => {
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
    assert.deepEqual(started.slice(0, 3), value.plan.waves[0].cellIds);
    assert.ok(value.plan.waves[1].cellIds.every((cellId) => started.includes(cellId)));
    assert.equal(value.plan.waves[2].cellIds.some((cellId) => started.includes(cellId)), false);
    assert.ok(cancelled.length >= 1);
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
          if (worker.workerId === 'vm3') throw new Error('runtime bundle mismatch');
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
          schemaVersion: 1,
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
        schemaVersion: 1,
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
    assert.equal(new Set(result.aggregate.cells.map((cell) => cell.leaseId)).size, 8);
    assert.equal(result.aggregate.budget.reservedExternalAudioSamples, SHARD_MATRIX_MAX_EXTERNAL_AUDIO_SAMPLES);
    assert.equal(result.aggregate.budget.preflightExternalAudioSamples, 0);
    assert.equal(result.matrixIntegration.cells.length, 8);
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
      /duplicate cell|cell\/lease binding mismatch/,
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
