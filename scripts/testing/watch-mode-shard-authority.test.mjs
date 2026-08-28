import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AUTHORITY_IMPLEMENTATION_FILES } from './watch-mode-evidence-authority.mjs';
import {
  PROVIDER_INPUT_BUDGET_JOURNAL_FILE,
  PROVIDER_INPUT_BUDGET_LEASE_FILE,
  PROVIDER_INPUT_BUDGET_LEASE_KIND,
  PROVIDER_INPUT_BUDGET_LEDGER_FILE,
  PROVIDER_INPUT_BUDGET_LEDGER_KIND,
  SHARD_CELL_MAX_EXTERNAL_AUDIO_SAMPLES,
  SHARD_MATRIX_MAX_EXTERNAL_AUDIO_SAMPLES,
  SHARD_ORCHESTRATION_IMPLEMENTATION_FILES,
  authorityInventoryDigest,
  buildShardCellResult,
  createSignedExecutionPlan,
  generateCoordinatorSigningKeyPair,
  issueCellLeases,
  interactiveExecutionExitMatchesReport,
  sha256Canonical,
  validateProviderUsageAuthority,
  validateShardCellResult,
  validateShardManifest,
  verifyCellLease,
  verifySignedExecutionPlan,
  writeShardCellResult,
  writeShardManifest,
} from './watch-mode-shard-authority.mjs';
import { defaultThreeVmAssignments } from './run-watch-mode-live-coordinator.mjs';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const PROVENANCE = Object.freeze({
  schemaVersion: 1,
  source: 'git',
  captureStatus: 'captured',
  headCommit: '1'.repeat(40),
  worktreeClean: true,
  dirtyEntryCount: 0,
});

test('interactive execution exit validates collection success independently from report failure', () => {
  assert.equal(interactiveExecutionExitMatchesReport(0, 'passed'), true);
  assert.equal(interactiveExecutionExitMatchesReport(1, 'passed'), false);
  assert.equal(interactiveExecutionExitMatchesReport(0, 'blocked'), true);
  assert.equal(interactiveExecutionExitMatchesReport(1, 'blocked'), true);
  assert.equal(interactiveExecutionExitMatchesReport(0, 'failed'), true);
  assert.equal(interactiveExecutionExitMatchesReport(1, 'failed'), true);
  assert.equal(interactiveExecutionExitMatchesReport(2, 'failed'), false);
});

const inventory = (prefix, sha = SHA_A) => [{ path: `${prefix}/authority.bin`, bytes: 17, sha256: sha }];

function testWorkers() {
  const profile = (workerId, instanceId, profileId, deviceClass, physicalPlaybackDeviceId, expectedName = '') => ({
    instanceId: `${workerId}-${instanceId}`,
    profileId,
    deviceClass,
    physicalPlaybackDeviceId,
    expectedPhysicalPlaybackDeviceName: expectedName,
  });
  return [
    {
      workerId: 'vm1',
      vmIdentity: { provider: 'vmware', uuidBios: 'vm-uuid-1' },
      deviceProfileInstances: [profile('vm1', 'default', 'vmware-hda-default', 'default-speaker', 'default')],
    },
  ];
}

function createFixture({ providerPreflightOverrides = {} } = {}) {
  const now = new Date();
  const generatedAt = new Date(now.getTime() - 1_000);
  const expiresAt = new Date(now.getTime() + 3_600_000);
  const workers = testWorkers();
  const signingKeys = generateCoordinatorSigningKeyPair();
  const authorityImplementationHashes = inventory('matrix');
  const runtimeBinaryHashes = [
    ...inventory('runtime', SHA_B),
    ...['sys', 'cat', 'inf'].map((extension) => ({
      path: `drivers/windows-virtual-mic/package/omni-virtual-speaker.${extension}`,
      bytes: 17,
      sha256: SHA_B,
    })),
  ];
  const shardOrchestrationImplementationHashes = inventory('shard');
  const plan = createSignedExecutionPlan({
    executionId: 'watch-shard-test-0001',
    generatedAt,
    expiresAt,
    provenance: PROVENANCE,
    authorityImplementationHashes,
    runtimeBinaryHashes,
    shardOrchestrationImplementationHashes,
    localIsolationAuthority: {
      path: 'local/local-isolation-manifest.json', bytes: 99, sha256: SHA_A, providerCalls: 0,
    },
    providerPreflightAuthority: {
      path: 'provider-preflight-receipt.json', bytes: 88, sha256: SHA_B,
       providerId: 'provider-dashscope', operation: 'text-translation-preflight',
       status: 'completed', externalAudioSamples: 0, invocationCount: 1,
       tokenBudget: { maxInputTokens: 4_096, maxOutputTokens: 256 },
       inputTokens: 64, outputTokens: 12, audioSeconds: null,
       ...providerPreflightOverrides,
     },
    workers,
    assignments: defaultThreeVmAssignments(workers),
    ...signingKeys,
  });
  const leases = issueCellLeases(plan, signingKeys.privateKeyPem, { issuedAt: generatedAt });
  return {
    now,
    generatedAt,
    workers,
    signingKeys,
    plan,
    leases,
    snapshot: {
      provenance: PROVENANCE,
      authorityImplementationHashes,
      runtimeBinaryHashes,
      shardOrchestrationImplementationHashes,
    },
  };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function providerIdentity(cell, lease, runMarker, protocol = 'dashscope-omni') {
  return {
    schemaVersion: 1,
    artifactKind: PROVIDER_INPUT_BUDGET_LEDGER_KIND,
    cellId: cell.cellId,
    leaseId: lease.leaseId,
    runMarker,
    sessionGeneration: 7,
    direction: 'inbound',
    strictPaidAuthority: true,
    providerId: 'provider-dashscope',
    templateId: 'template-dashscope-realtime',
    providerKind: 'dashscope',
    endpointHost: 'dashscope.aliyuncs.com',
    credentialReference: 'credential://provider/dashscope/default',
    authHeaderName: 'Authorization',
    authScheme: 'bearer',
    customHeaderCount: 0,
    model: cell.modelId,
    protocol,
  };
}

function writeSuccessfulRun(runDirectory, cell, lease, { samples = 32_000 } = {}) {
  fs.mkdirSync(runDirectory, { recursive: true });
  const runMarker = `watch_mode_diagnostic.run_id=${cell.cellIndex}`;
  const identity = providerIdentity(
    cell,
    lease,
    runMarker,
    cell.modelId.includes('livetranslate') ? 'dashscope-livetranslate' : 'dashscope-omni',
  );
  writeJson(path.join(runDirectory, 'report.json'), { verdict: 'passed' });
  writeJson(path.join(runDirectory, 'physical-playback-device.json'), {
    profileId: cell.deviceProfileInstance.profileId,
    deviceClass: cell.deviceClass,
    requestedDeviceId: cell.deviceProfileInstance.physicalPlaybackDeviceId,
    resolvedDeviceId: `{resolved-${cell.cellIndex}}`,
    resolvedDeviceName: cell.deviceProfileInstance.expectedPhysicalPlaybackDeviceName || 'VMware HDA Test Device',
    classificationSource: 'windows-mmdevice-registry',
    routeEvidenceSource: 'physical-output-probe+runtime-route',
    verified: true,
    fixtureOnly: false,
  });
  if (cell.feedbackLoopPrevention === 'virtual-driver') {
    writeJson(path.join(runDirectory, 'driver.json'), {
      InstalledDriverAuthority: {
        installedSysSha256: SHA_B,
        packageSysSha256: SHA_B,
        packageCatSha256: SHA_B,
        packageInfSha256: SHA_B,
        installedServiceState: 'running',
        installedSysSignatureStatus: 'valid',
        packageCatalogSignatureStatus: 'valid',
        installedSysSignerThumbprint: 'fixture-thumbprint',
        packageCatalogSignerThumbprint: 'fixture-thumbprint',
      },
    });
  }
  writeJson(path.join(runDirectory, PROVIDER_INPUT_BUDGET_LEASE_FILE), {
    schemaVersion: 1,
    artifactKind: PROVIDER_INPUT_BUDGET_LEASE_KIND,
    cellId: cell.cellId,
    leaseId: lease.leaseId,
    runMarker,
    maxSamples: SHARD_CELL_MAX_EXTERNAL_AUDIO_SAMPLES,
  });
  writeJson(path.join(runDirectory, PROVIDER_INPUT_BUDGET_LEDGER_FILE), {
    ...identity,
    maxSamples: SHARD_CELL_MAX_EXTERNAL_AUDIO_SAMPLES,
    totalAttemptedSamples: samples,
    appendAttempts: samples === 0 ? 0 : 2,
    sendFailures: 0,
    initialConnectAttempts: 1,
    reconnects: 0,
    budgetExceeded: false,
    finalized: true,
    terminalReason: 'worker-completed',
  });
  const events = [
    { ...identity, sequence: 1, event: 'initialized', initialConnectAttempts: 0, finalized: false },
    { ...identity, sequence: 2, event: 'initial_connect_attempt', initialConnectAttempts: 1, finalized: false },
    ...(samples === 0 ? [] : [
      { ...identity, sequence: 3, event: 'reserved', initialConnectAttempts: 1, attemptedSamples: Math.floor(samples / 2), finalized: false },
      { ...identity, sequence: 4, event: 'reserved', initialConnectAttempts: 1, attemptedSamples: samples - Math.floor(samples / 2), finalized: false },
    ]),
    { ...identity, sequence: samples === 0 ? 3 : 5, event: 'finalized', initialConnectAttempts: 1, finalized: true },
  ];
  fs.writeFileSync(
    path.join(runDirectory, PROVIDER_INPUT_BUDGET_JOURNAL_FILE),
    `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
    'utf8',
  );
}

test('shard orchestration inventory is independent from local/matrix implementation authority', () => {
  assert.deepEqual(SHARD_ORCHESTRATION_IMPLEMENTATION_FILES, [
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
  assert.equal(SHARD_ORCHESTRATION_IMPLEMENTATION_FILES.includes('scripts/testing/run-watch-mode-live-matrix.mjs'), false);
});

test('signed plan and leases bind exact eight cells, eight serial waves, machine/runtime identities and 1440 seconds', () => {
  const fixture = createFixture();
  assert.throws(
    () => createFixture({ providerPreflightOverrides: { inputTokens: '64' } }),
    /exactly one completed text-only invocation/,
  );
  assert.equal(verifySignedExecutionPlan(fixture.plan, { now: fixture.now }), fixture.plan);
  assert.equal(fixture.plan.cells.length, 8);
  assert.deepEqual(fixture.plan.waves.map((wave) => wave.cellIds.length), [1, 1, 1, 1, 1, 1, 1, 1]);
  assert.equal(fixture.leases.length, 8);
  assert.equal(new Set(fixture.leases.map((lease) => lease.leaseId)).size, 8);
  assert.equal(
    fixture.leases.reduce((sum, lease) => sum + lease.maxExternalAudioSamples, 0),
    SHARD_MATRIX_MAX_EXTERNAL_AUDIO_SAMPLES,
  );
  for (const lease of fixture.leases) {
    assert.equal(verifyCellLease(lease, fixture.plan, { now: fixture.now }).cellId, lease.cellId);
  }
  assert.equal(
    fixture.plan.authority.runtimeBundleDigest,
    authorityInventoryDigest(fixture.snapshot.runtimeBinaryHashes),
  );

  const tamperedPlan = structuredClone(fixture.plan);
  tamperedPlan.cells[0].workerId = 'vm2';
  assert.throws(() => verifySignedExecutionPlan(tamperedPlan, { now: fixture.now }), /digest mismatch/);

  const forgedProviderPlan = structuredClone(fixture.plan);
  forgedProviderPlan.providerIdentity.endpointHost = 'attacker.invalid';
  const forgedProviderCore = structuredClone(forgedProviderPlan);
  delete forgedProviderCore.signature;
  delete forgedProviderCore.planDigest;
  forgedProviderPlan.planDigest = sha256Canonical(forgedProviderCore);
  assert.throws(
    () => verifySignedExecutionPlan(forgedProviderPlan, { now: fixture.now }),
    /signature|provider identity/,
  );

  const tamperedLease = structuredClone(fixture.leases[0]);
  tamperedLease.maxExternalAudioSamples += 1;
  assert.throws(() => verifyCellLease(tamperedLease, fixture.plan, { now: fixture.now }), /digest mismatch/);

  assert.throws(
    () => verifySignedExecutionPlan(fixture.plan, {
      now: fixture.now,
      currentRuntimeBinaryHashes: inventory('runtime', SHA_A),
    }),
    /runtime binary hashes/,
  );
});

test('signed plan accepts exactly one local worker and rejects additional workers', () => {
  const fixture = createFixture();
  const createWithWorkers = (workers) => createSignedExecutionPlan({
    executionId: `watch-worker-count-${workers.length}`,
    generatedAt: fixture.generatedAt,
    expiresAt: new Date(fixture.now.getTime() + 3_600_000),
    provenance: PROVENANCE,
    authorityImplementationHashes: fixture.snapshot.authorityImplementationHashes,
    runtimeBinaryHashes: fixture.snapshot.runtimeBinaryHashes,
    shardOrchestrationImplementationHashes: fixture.snapshot.shardOrchestrationImplementationHashes,
    localIsolationAuthority: {
      path: 'local/local-isolation-manifest.json', bytes: 99, sha256: SHA_A, providerCalls: 0,
    },
    providerPreflightAuthority: {
      path: 'provider-preflight-receipt.json', bytes: 88, sha256: SHA_B,
       providerId: 'provider-dashscope', operation: 'text-translation-preflight',
       status: 'completed', externalAudioSamples: 0, invocationCount: 1,
       tokenBudget: { maxInputTokens: 4_096, maxOutputTokens: 256 },
       inputTokens: 64, outputTokens: 12, audioSeconds: null,
     },
    workers,
    assignments: workers.length === 1
      ? defaultThreeVmAssignments(workers)
      : [],
    ...fixture.signingKeys,
  });
  const oneWorkerPlan = createWithWorkers(testWorkers());
  assert.equal(oneWorkerPlan.workers.length, 1);
  assert.deepEqual(oneWorkerPlan.waves.map((wave) => wave.cellIds.length), [1, 1, 1, 1, 1, 1, 1, 1]);
  const fourth = {
    ...structuredClone(testWorkers()[0]),
    workerId: 'vm4',
    vmIdentity: { provider: 'vmware', uuidBios: 'vm-uuid-4' },
  };
  assert.throws(() => createWithWorkers([...testWorkers(), fourth]), /assignments must contain|exactly one local worker/);
});

test('provider usage authority binds coordinator launch receipt and ordered send-boundary journal', () => {
  const fixture = createFixture();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-shard-usage-'));
  try {
    const cell = fixture.plan.cells[0];
    const lease = fixture.leases[0];
    writeSuccessfulRun(root, cell, lease);
    const usage = validateProviderUsageAuthority(root, { cell, lease });
    assert.equal(usage.actualExternalAudioSamples, 32_000);
    assert.equal(usage.maxExternalAudioSamples, SHARD_CELL_MAX_EXTERNAL_AUDIO_SAMPLES);
    assert.equal(usage.launchLeasePath, PROVIDER_INPUT_BUDGET_LEASE_FILE);
    assert.equal(usage.journalEventCount, 5);

    writeSuccessfulRun(root, cell, lease, { samples: 0 });
    const zeroInputUsage = validateProviderUsageAuthority(root, { cell, lease });
    assert.equal(zeroInputUsage.actualExternalAudioSamples, 0);
    assert.equal(zeroInputUsage.journalEventCount, 3);

    const timeoutLedgerPath = path.join(root, PROVIDER_INPUT_BUDGET_LEDGER_FILE);
    const timeoutJournalPath = path.join(root, PROVIDER_INPUT_BUDGET_JOURNAL_FILE);
    const timeoutLedger = JSON.parse(fs.readFileSync(timeoutLedgerPath, 'utf8'));
    const timeoutJournal = fs.readFileSync(timeoutJournalPath, 'utf8').trim().split(/\r?\n/u).map(JSON.parse);
    timeoutLedger.terminalReason = 'livetranslate-session-finished-timeout';
    timeoutJournal.at(-1).terminalReason = timeoutLedger.terminalReason;
    writeJson(timeoutLedgerPath, timeoutLedger);
    fs.writeFileSync(timeoutJournalPath, `${timeoutJournal.map(JSON.stringify).join('\n')}\n`, 'utf8');
    const timeoutUsage = validateProviderUsageAuthority(root, { cell, lease });
    assert.equal(timeoutUsage.terminalStatus, 'livetranslate-session-finished-timeout');

    writeSuccessfulRun(root, cell, lease);

    const reconnectLedgerPath = path.join(root, PROVIDER_INPUT_BUDGET_LEDGER_FILE);
    const reconnectJournalPath = path.join(root, PROVIDER_INPUT_BUDGET_JOURNAL_FILE);
    const reconnectLedger = JSON.parse(fs.readFileSync(reconnectLedgerPath, 'utf8'));
    const reconnectJournal = fs.readFileSync(reconnectJournalPath, 'utf8')
      .trim().split(/\r?\n/u).map(JSON.parse);
    reconnectLedger.terminalReason = 'reconnect-forbidden-socket-close';
    const reconnectFinalized = reconnectJournal.pop();
    reconnectJournal.push({
      ...reconnectJournal.at(-1),
      sequence: 5,
      event: 'reconnect_rejected',
      attemptedSamples: null,
      terminalReason: reconnectLedger.terminalReason,
    });
    reconnectFinalized.sequence = 6;
    reconnectFinalized.terminalReason = reconnectLedger.terminalReason;
    writeJson(reconnectLedgerPath, reconnectLedger);
    fs.writeFileSync(
      reconnectJournalPath,
      `${[...reconnectJournal, reconnectFinalized].map(JSON.stringify).join('\n')}\n`,
      'utf8',
    );
    const disconnectedUsage = validateProviderUsageAuthority(root, { cell, lease });
    assert.equal(disconnectedUsage.initialConnectAttempts, 1);
    assert.equal(disconnectedUsage.terminalStatus, 'reconnect-forbidden-socket-close');

    writeSuccessfulRun(root, cell, lease);

    const launchLease = JSON.parse(fs.readFileSync(path.join(root, PROVIDER_INPUT_BUDGET_LEASE_FILE), 'utf8'));
    launchLease.leaseId = 'locally-generated-lease';
    writeJson(path.join(root, PROVIDER_INPUT_BUDGET_LEASE_FILE), launchLease);
    assert.throws(
      () => validateProviderUsageAuthority(root, { cell, lease }),
      /launch lease leaseId mismatch/,
    );

    writeSuccessfulRun(root, cell, lease);
    fs.appendFileSync(
      path.join(root, PROVIDER_INPUT_BUDGET_JOURNAL_FILE),
      `${JSON.stringify({ ...providerIdentity(cell, lease, `watch_mode_diagnostic.run_id=${cell.cellIndex}`), sequence: 6, event: 'reconnect', initialConnectAttempts: 1 })}\n`,
    );
    assert.throws(
      () => validateProviderUsageAuthority(root, { cell, lease }),
      /must end with exactly one finalized event|forbidden reconnect/,
    );

    writeSuccessfulRun(root, cell, lease);
    const ledgerPath = path.join(root, PROVIDER_INPUT_BUDGET_LEDGER_FILE);
    const forgedLedger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    forgedLedger.credentialReference = 'credential://provider/attacker/default';
    writeJson(ledgerPath, forgedLedger);
    assert.throws(
      () => validateProviderUsageAuthority(root, { cell, lease }),
      /credentialReference mismatch/,
    );

    writeSuccessfulRun(root, cell, lease);
    const forgedHeaderLedger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    forgedHeaderLedger.customHeaderCount = 1;
    writeJson(ledgerPath, forgedHeaderLedger);
    assert.throws(
      () => validateProviderUsageAuthority(root, { cell, lease }),
      /customHeaderCount mismatch/,
    );

    writeSuccessfulRun(root, cell, lease);
    const journalPath = path.join(root, PROVIDER_INPUT_BUDGET_JOURNAL_FILE);
    const journal = fs.readFileSync(journalPath, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
    journal.splice(1, 1);
    journal.forEach((event, index) => { event.sequence = index + 1; });
    fs.writeFileSync(journalPath, `${journal.map(JSON.stringify).join('\n')}\n`, 'utf8');
    assert.throws(
      () => validateProviderUsageAuthority(root, { cell, lease }),
      /initialConnectAttempts is non-monotonic|exactly one initial_connect_attempt/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cell results and a worker shard manifest rehash raw files and preserve canonical cell leases', () => {
  const fixture = createFixture();
  const shardRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-shard-authority-'));
  try {
    const workerId = 'vm1';
    const worker = fixture.plan.workers.find((entry) => entry.workerId === workerId);
    const cells = fixture.plan.cells.filter((cell) => cell.workerId === workerId);
    const resultPaths = [];
    for (const cell of cells) {
      const lease = fixture.leases.find((entry) => entry.cellId === cell.cellId);
      const runDirectory = path.join(shardRoot, 'runs', `cell-${cell.cellIndex}`);
      writeSuccessfulRun(runDirectory, cell, lease, { samples: 16_000 + cell.cellIndex });
      const written = writeShardCellResult({
        plan: fixture.plan,
        lease,
        workerId,
        vmIdentity: worker.vmIdentity,
        shardRoot,
        runDirectory,
        ...fixture.snapshot,
      });
      assert.equal(
        validateShardCellResult({
          resultPath: written.resultPath,
          plan: fixture.plan,
          lease,
          shardRoot,
          now: fixture.now,
        }).result.resultDigest,
        written.result.resultDigest,
      );
      // The matrix receipt is written only after the guest-local result. It is
      // a downstream attestation and must not mutate the raw inventory the
      // result already sealed.
      fs.writeFileSync(
        path.join(runDirectory, 'matrix-cell-authority.json'),
        JSON.stringify({ artifactKind: 'watch-mode-matrix-cell-authority' }),
      );
      assert.equal(
        validateShardCellResult({
          resultPath: written.resultPath,
          plan: fixture.plan,
          lease,
          shardRoot,
          now: fixture.now,
        }).result.resultDigest,
        written.result.resultDigest,
      );
      resultPaths.push(written.resultPath);
    }
    const shard = writeShardManifest({
      plan: fixture.plan,
      leases: fixture.leases,
      workerId,
      shardRoot,
      resultPaths,
    });
    const validated = validateShardManifest({
      manifestPath: shard.manifestPath,
      shardRoot,
      plan: fixture.plan,
      leases: fixture.leases,
      now: fixture.now,
    });
    assert.deepEqual(
      validated.validatedResults.map((entry) => entry.cell.cellId),
      cells.map((cell) => cell.cellId),
    );

    fs.appendFileSync(path.join(validated.validatedResults[0].runDirectory, 'report.json'), ' ');
    assert.throws(
      () => validateShardManifest({
        manifestPath: shard.manifestPath,
        shardRoot,
        plan: fixture.plan,
        leases: fixture.leases,
        now: fixture.now,
      }),
      /raw artifact inventory mismatch|hash\/size binding mismatch/,
    );
  } finally {
    fs.rmSync(shardRoot, { recursive: true, force: true });
  }
});

test('ordinary failed report remains an identity-bound shard result for collect-all', () => {
  const fixture = createFixture();
  const shardRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-shard-failed-result-'));
  try {
    const cell = fixture.plan.cells[0];
    const lease = fixture.leases.find((entry) => entry.cellId === cell.cellId);
    const worker = fixture.plan.workers.find((entry) => entry.workerId === cell.workerId);
    const runDirectory = path.join(shardRoot, 'runs', 'failed-cell');
    writeSuccessfulRun(runDirectory, cell, lease);
    writeJson(path.join(runDirectory, 'report.json'), {
      verdict: 'failed',
      failureLayer: 'acoustic',
      stableErrorCode: 'watch.acoustic.reference-mismatch',
      lifecyclePhase: 'contentCapture',
    });
    const written = writeShardCellResult({
      plan: fixture.plan,
      lease,
      workerId: worker.workerId,
      vmIdentity: worker.vmIdentity,
      shardRoot,
      runDirectory,
      ...fixture.snapshot,
    });
    const validated = validateShardCellResult({
      resultPath: written.resultPath,
      plan: fixture.plan,
      lease,
      shardRoot,
      now: fixture.now,
    });
    assert.equal(validated.result.verdict, 'failed');
    assert.equal(validated.result.stableErrorCode, 'watch.acoustic.reference-mismatch');
  } finally {
    fs.rmSync(shardRoot, { recursive: true, force: true });
  }
});

test('blocked report is preserved and normalized to a collect-all failed shard result', () => {
  const fixture = createFixture();
  const shardRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-shard-blocked-result-'));
  try {
    const cell = fixture.plan.cells[0];
    const lease = fixture.leases.find((entry) => entry.cellId === cell.cellId);
    const worker = fixture.plan.workers.find((entry) => entry.workerId === cell.workerId);
    const runDirectory = path.join(shardRoot, 'runs', 'blocked-cell');
    writeSuccessfulRun(runDirectory, cell, lease);
    const devicePath = path.join(runDirectory, 'physical-playback-device.json');
    const device = JSON.parse(fs.readFileSync(devicePath, 'utf8'));
    device.resolvedDeviceName = `扬声器 (${cell.deviceProfileInstance.expectedPhysicalPlaybackDeviceName})`;
    writeJson(devicePath, device);
    writeJson(path.join(runDirectory, 'report.json'), {
      verdict: 'blocked',
      failureLayer: 'environment',
      lifecyclePhase: 'contentCapture',
    });
    const written = writeShardCellResult({
      plan: fixture.plan,
      lease,
      workerId: worker.workerId,
      vmIdentity: worker.vmIdentity,
      shardRoot,
      runDirectory,
      ...fixture.snapshot,
    });
    const validated = validateShardCellResult({
      resultPath: written.resultPath,
      plan: fixture.plan,
      lease,
      shardRoot,
      now: fixture.now,
    });
    assert.equal(validated.result.verdict, 'failed');
    assert.equal(validated.result.reportVerdict, 'blocked');
    assert.equal(validated.result.stableErrorCode, 'watch.strict-cell.blocked');
  } finally {
    fs.rmSync(shardRoot, { recursive: true, force: true });
  }
});

test('result builder refuses a mismatched VM even when the source/runtime hashes match', () => {
  const fixture = createFixture();
  const shardRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-shard-vm-'));
  try {
    const cell = fixture.plan.cells[0];
    const lease = fixture.leases[0];
    const runDirectory = path.join(shardRoot, 'runs', 'cell');
    writeSuccessfulRun(runDirectory, cell, lease);
    assert.throws(
      () => buildShardCellResult({
        plan: fixture.plan,
        lease,
        workerId: cell.workerId,
        vmIdentity: { provider: 'vmware', uuidBios: 'another-vm' },
        shardRoot,
        runDirectory,
        ...fixture.snapshot,
      }),
      /worker\/VM identity/,
    );
  } finally {
    fs.rmSync(shardRoot, { recursive: true, force: true });
  }
});
