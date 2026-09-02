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
  SHARD_MATRIX_MAX_EXTERNAL_AUDIO_SAMPLES,
  SHARD_ORCHESTRATION_IMPLEMENTATION_FILES,
  authorityInventoryDigest,
  buildShardCellResult,
  createSignedExecutionPlan,
  fileAuthorityEntry,
  generateCoordinatorSigningKeyPair,
  issueCellLeases,
  interactiveExecutionExitMatchesReport,
  sha256Canonical,
  validateInteractiveProcessAuthority,
  validateProviderUsageAuthority,
  validateShardCellResult,
  validateShardManifest,
  verifyCellLease,
  verifySignedExecutionPlan,
  writeShardCellResult,
  writeShardManifest,
} from './watch-mode-shard-authority.mjs';
import { defaultSingleWorkerAssignments } from './run-watch-mode-live-coordinator.mjs';
import { LIVE_LLM_CELLS } from './watch-mode-balanced-release-plan.mjs';
import { rebuildReportFromDirectory } from './watch-mode-report.mjs';
import {
  healthyApp,
  healthyAppLog,
  healthyAecPlayback,
  healthyBridge,
  healthyBridgeLog,
  healthyDriver,
  healthyPhysicalOutput,
  healthyPhysicalOutputContent,
  healthyProcessExclusionBridge,
  healthyProcessExclusionFingerprint,
  healthyProcessExclusionRestartLog,
  healthyProvider,
  healthySystemMetrics,
  healthyWasapi,
  healthyWatchSessionReport,
} from './watch-mode-report-test-helpers.mjs';
import {
  WATCH_MODE_RUN_COLLECTION_SCHEMA,
  writeWatchModeRunCollection,
} from './watch-mode-run-collection.mjs';

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

function interactiveProcessGenerationFixture() {
  const fixture = createFixture();
  const lease = fixture.leases[0];
  const worker = fixture.plan.workers.find((entry) => entry.workerId === lease.workerId);
  const baseMs = fixture.now.getTime() - 10_000;
  const ownerSid = 'S-1-5-21-1-2-3-1000';
  const observedProcess = ({ role, pid, parentPid, startedOffset, firstOffset, lastOffset, imageName }) => ({
    role,
    pid,
    parentPid,
    sessionId: 1,
    imagePath: `C:\\fixture\\${imageName}`,
    imageSha256: SHA_A,
    commandLine: `${imageName} ${role === 'recorder' ? '--record-only' : '--fixture'}`,
    startedAt: new Date(baseMs + startedOffset).toISOString(),
    ownerUser: worker.interactiveUser ?? 'VMUser',
    ownerDomain: 'FIXTURE',
    ownerSid,
    firstSeenAt: new Date(baseMs + firstOffset).toISOString(),
    lastSeenAt: new Date(baseMs + lastOffset).toISOString(),
  });
  const root = observedProcess({
    role: 'shard-node', pid: 100, parentPid: 99, startedOffset: 0,
    firstOffset: 100, lastOffset: 900, imageName: 'node.exe',
  });
  const processes = [
    root,
    observedProcess({
      role: 'cell-powershell', pid: 101, parentPid: 100, startedOffset: 50,
      firstOffset: 100, lastOffset: 900, imageName: 'powershell.exe',
    }),
    observedProcess({
      role: 'supporting', pid: 2240, parentPid: 101, startedOffset: 120,
      firstOffset: 150, lastOffset: 250, imageName: 'omni-physical-output-probe.exe',
    }),
    observedProcess({
      role: 'desktop', pid: 102, parentPid: 101, startedOffset: 200,
      firstOffset: 220, lastOffset: 800, imageName: 'omni-desktop-shell.exe',
    }),
    observedProcess({
      role: 'bridge', pid: 103, parentPid: 102, startedOffset: 230,
      firstOffset: 250, lastOffset: 750, imageName: 'omni-bridge-service.exe',
    }),
    observedProcess({
      role: 'recorder', pid: 2240, parentPid: 101, startedOffset: 300,
      firstOffset: 350, lastOffset: 850, imageName: 'omni-physical-output-probe.exe',
    }),
  ];
  const uniqueParentByPid = new Map(processes.map((entry) => [entry.pid, entry]));
  for (const processEntry of processes) {
    processEntry.parentStartedAt = processEntry === root
      ? null
      : uniqueParentByPid.get(processEntry.parentPid).startedAt;
  }
  return {
    fixture,
    lease,
    worker,
    launch: {
      ownerSid,
      nodeProcess: root,
      taskProcess: { pid: 99 },
    },
    execution: { exitCode: 0 },
    processAuthority: {
      schemaVersion: 2,
      artifactKind: 'watch-mode-interactive-process-authority',
      executionId: fixture.plan.executionId,
      planDigest: fixture.plan.planDigest,
      leaseId: lease.leaseId,
      leaseDigest: lease.leaseDigest,
      cellId: lease.cellId,
      workerId: worker.workerId,
      vmIdentityDigest: worker.vmIdentityDigest,
      rootProcessId: root.pid,
      expectedSessionId: 1,
      expectedOwnerSid: ownerSid,
      startedAt: new Date(baseMs + 75).toISOString(),
      completedAt: new Date(baseMs + 950).toISOString(),
      sampleIntervalMs: 250,
      executionExitCode: 0,
      requiredRoles: ['shard-node', 'cell-powershell', 'desktop', 'bridge', 'recorder'],
      processCount: processes.length,
      processes,
      errors: [],
      passed: true,
    },
  };
}

function validateInteractiveProcessFixture(fixture, processAuthority = fixture.processAuthority) {
  return validateInteractiveProcessAuthority({
    processAuthority,
    execution: fixture.execution,
    launch: fixture.launch,
    plan: fixture.fixture.plan,
    lease: fixture.lease,
    worker: fixture.worker,
  });
}

test('interactive process authority preserves valid PID reuse generations and rejects forged topology', () => {
  const valid = interactiveProcessGenerationFixture();
  assert.doesNotThrow(() => validateInteractiveProcessAuthority({
    processAuthority: valid.processAuthority,
    execution: valid.execution,
    launch: valid.launch,
    plan: valid.fixture.plan,
    lease: valid.lease,
    worker: valid.worker,
  }));

  const duplicate = structuredClone(valid.processAuthority);
  duplicate.processes.push(structuredClone(duplicate.processes.at(-1)));
  duplicate.processCount = duplicate.processes.length;
  assert.throws(() => validateInteractiveProcessAuthority({
    processAuthority: duplicate,
    execution: valid.execution,
    launch: valid.launch,
    plan: valid.fixture.plan,
    lease: valid.lease,
    worker: valid.worker,
  }), /observation identity is invalid/);

  const invalidParent = structuredClone(valid.processAuthority);
  const recorder = invalidParent.processes.find((entry) => entry.role === 'recorder');
  recorder.parentPid = 777;
  const forgedParent = {
    ...structuredClone(invalidParent.processes.find((entry) => entry.role === 'supporting')),
    pid: 777,
    parentPid: 101,
    startedAt: new Date(Date.parse(recorder.startedAt) + 50).toISOString(),
    firstSeenAt: recorder.firstSeenAt,
    lastSeenAt: recorder.lastSeenAt,
  };
  recorder.parentStartedAt = forgedParent.startedAt;
  invalidParent.processes.push(forgedParent);
  invalidParent.processCount = invalidParent.processes.length;
  assert.throws(() => validateInteractiveProcessAuthority({
    processAuthority: invalidParent,
    execution: valid.execution,
    launch: valid.launch,
    plan: valid.fixture.plan,
    lease: valid.lease,
    worker: valid.worker,
  }), /no valid parent generation/);

  const disconnectedCycle = structuredClone(valid.processAuthority);
  const cycleStartedAt = new Date(Date.parse(disconnectedCycle.startedAt) + 400).toISOString();
  const cycleFirstSeenAt = new Date(Date.parse(disconnectedCycle.startedAt) + 450).toISOString();
  const cycleLastSeenAt = new Date(Date.parse(disconnectedCycle.startedAt) + 700).toISOString();
  disconnectedCycle.processes.push(
    {
      ...structuredClone(disconnectedCycle.processes.find((entry) => entry.role === 'supporting')),
      pid: 800,
      parentPid: 801,
      parentStartedAt: cycleStartedAt,
      startedAt: cycleStartedAt,
      firstSeenAt: cycleFirstSeenAt,
      lastSeenAt: cycleLastSeenAt,
    },
    {
      ...structuredClone(disconnectedCycle.processes.find((entry) => entry.role === 'supporting')),
      pid: 801,
      parentPid: 800,
      parentStartedAt: cycleStartedAt,
      startedAt: cycleStartedAt,
      firstSeenAt: cycleFirstSeenAt,
      lastSeenAt: cycleLastSeenAt,
    },
  );
  disconnectedCycle.processCount = disconnectedCycle.processes.length;
  assert.throws(() => validateInteractiveProcessAuthority({
    processAuthority: disconnectedCycle,
    execution: valid.execution,
    launch: valid.launch,
    plan: valid.fixture.plan,
    lease: valid.lease,
    worker: valid.worker,
  }), /outside the captured root process generation tree/);
});

test('interactive process authority binds children to the exact reused parent PID generation', () => {
  const valid = interactiveProcessGenerationFixture();
  const oldParent = valid.processAuthority.processes.find((entry) => (
    entry.pid === 2240 && entry.role === 'supporting'
  ));
  const newParent = valid.processAuthority.processes.find((entry) => (
    entry.pid === 2240 && entry.role === 'recorder'
  ));
  const child = {
    ...structuredClone(valid.processAuthority.processes.find((entry) => entry.role === 'bridge')),
    role: 'supporting',
    pid: 104,
    parentPid: 2240,
    parentStartedAt: oldParent.startedAt,
    startedAt: new Date(Date.parse(oldParent.startedAt) + 60).toISOString(),
    firstSeenAt: new Date(Date.parse(oldParent.firstSeenAt) + 40).toISOString(),
    lastSeenAt: new Date(Date.parse(oldParent.lastSeenAt) + 200).toISOString(),
  };
  valid.processAuthority.processes.push(child);
  valid.processAuthority.processCount = valid.processAuthority.processes.length;
  assert.doesNotThrow(() => validateInteractiveProcessFixture(valid));

  const wrongGeneration = structuredClone(valid.processAuthority);
  wrongGeneration.processes.find((entry) => entry.pid === child.pid).parentStartedAt = newParent.startedAt;
  assert.throws(
    () => validateInteractiveProcessFixture(valid, wrongGeneration),
    /no valid parent generation/,
  );
});

test('interactive process authority rejects a second generation of the launched root PID', () => {
  const valid = interactiveProcessGenerationFixture();
  const root = valid.processAuthority.processes.find((entry) => entry.role === 'shard-node');
  valid.processAuthority.processes.push({
    ...structuredClone(root),
    role: 'supporting',
    parentPid: root.pid,
    parentStartedAt: root.startedAt,
    imagePath: 'C:\\fixture\\decoy-node.exe',
    commandLine: 'decoy-node.exe --fixture',
    startedAt: new Date(Date.parse(root.startedAt) + 300).toISOString(),
    firstSeenAt: new Date(Date.parse(root.firstSeenAt) + 300).toISOString(),
    lastSeenAt: new Date(Date.parse(root.lastSeenAt) - 100).toISOString(),
  });
  valid.processAuthority.processCount = valid.processAuthority.processes.length;

  assert.throws(
    () => validateInteractiveProcessFixture(valid),
    /interactive traced shard root does not match the launched Node process/,
  );
  const decoyFirst = structuredClone(valid.processAuthority);
  decoyFirst.processes.unshift(decoyFirst.processes.pop());
  assert.throws(
    () => validateInteractiveProcessFixture(valid, decoyFirst),
    /interactive traced shard root does not match the launched Node process/,
  );
});

test('interactive process authority keeps passed errors and required roles as hard gates', () => {
  const valid = interactiveProcessGenerationFixture();
  const cases = [
    {
      name: 'passed=false',
      mutate: (authority) => { authority.passed = false; },
    },
    {
      name: 'errors non-empty',
      mutate: (authority) => { authority.errors.push('collector failed'); },
    },
    {
      name: 'requiredRoles missing recorder',
      mutate: (authority) => {
        authority.requiredRoles = authority.requiredRoles.filter((role) => role !== 'recorder');
      },
    },
  ];
  for (const testCase of cases) {
    const invalid = structuredClone(valid.processAuthority);
    testCase.mutate(invalid);
    assert.throws(
      () => validateInteractiveProcessFixture(valid, invalid),
      /interactive process authority is invalid/,
      testCase.name,
    );
  }
});

test('interactive process authority rejects parent observation lifetimes beyond sample tolerance', () => {
  const valid = interactiveProcessGenerationFixture();
  const sampleIntervalMs = valid.processAuthority.sampleIntervalMs;

  const lateParentObservation = structuredClone(valid.processAuthority);
  const lateParent = lateParentObservation.processes.find((entry) => entry.role === 'cell-powershell');
  const earlyChild = lateParentObservation.processes.find((entry) => entry.role === 'supporting');
  lateParent.firstSeenAt = new Date(
    Date.parse(earlyChild.firstSeenAt) + sampleIntervalMs + 1,
  ).toISOString();
  assert.throws(
    () => validateInteractiveProcessFixture(valid, lateParentObservation),
    /no valid parent generation/,
  );

  const expiredParentObservation = structuredClone(valid.processAuthority);
  const expiredParent = expiredParentObservation.processes.find((entry) => entry.role === 'cell-powershell');
  const lateChild = expiredParentObservation.processes.find((entry) => entry.role === 'recorder');
  lateChild.firstSeenAt = new Date(Date.parse(lateChild.firstSeenAt) + 350).toISOString();
  expiredParent.lastSeenAt = new Date(
    Date.parse(lateChild.firstSeenAt) - sampleIntervalMs - 1,
  ).toISOString();
  assert.throws(
    () => validateInteractiveProcessFixture(valid, expiredParentObservation),
    /no valid parent generation/,
  );
});

test('interactive process authority rejects a pure missing parent generation', () => {
  const valid = interactiveProcessGenerationFixture();
  const disconnected = structuredClone(valid.processAuthority);
  const recorder = disconnected.processes.find((entry) => entry.role === 'recorder');
  recorder.parentStartedAt = new Date(Date.parse(recorder.parentStartedAt) - 1).toISOString();

  assert.throws(
    () => validateInteractiveProcessFixture(valid, disconnected),
    /no valid parent generation/,
  );
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
       ...structuredClone(PREFLIGHT_LIFECYCLE_AUTHORITY),
       ...providerPreflightOverrides,
     },
    workers,
    assignments: defaultSingleWorkerAssignments(workers),
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

function refreshForgedResultAuthority(resultPath, result, reportPath) {
  const reportArtifactIndex = result.artifacts.findIndex((entry) => entry.path === 'report.json');
  assert.ok(reportArtifactIndex >= 0, 'fixture shard result must bind report.json');
  result.artifacts[reportArtifactIndex] = fileAuthorityEntry(reportPath, 'report.json');
  const core = structuredClone(result);
  delete core.resultDigest;
  result.resultDigest = sha256Canonical(core);
  writeJson(resultPath, result);
}

function providerIdentity(cell, lease, runMarker, protocol = 'dashscope-livetranslate') {
  return {
    schemaVersion: 2,
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
    modelProtocolProfileIdentity: structuredClone(cell.modelProtocolProfileIdentity),
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
    schemaVersion: 2,
    artifactKind: PROVIDER_INPUT_BUDGET_LEASE_KIND,
    cellId: cell.cellId,
    leaseId: lease.leaseId,
    runMarker,
    maxSamples: cell.maxExternalAudioSamples,
    modelProtocolProfileIdentity: structuredClone(cell.modelProtocolProfileIdentity),
  });
  writeJson(path.join(runDirectory, PROVIDER_INPUT_BUDGET_LEDGER_FILE), {
    ...identity,
    maxSamples: cell.maxExternalAudioSamples,
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
  writeRawReportAuthority(runDirectory, cell);
}

function writeRawReportAuthority(runDirectory, cell, {
  bridgeDroppedFrameCount = 0,
  collectionFailure = null,
  steps = [],
} = {}) {
  const processExclusion = cell.feedbackLoopPrevention === 'process-exclusion';
  const echoCancel = cell.feedbackLoopPrevention === 'echo-cancel';
  const snapshots = {
    schemaVersion: 1,
    modelId: cell.modelId,
    feedbackLoopPrevention: cell.feedbackLoopPrevention,
    deviceEvidence: {
      deviceClass: cell.deviceClass,
      profileId: cell.deviceProfileId ?? cell.deviceProfileInstance.profileId,
      resolvedDeviceId: cell.deviceProfileInstance.physicalPlaybackDeviceId,
      resolvedDeviceName: 'VMware HDA Test Device',
    },
    driver: healthyDriver,
    wasapi: healthyWasapi,
    bridge: processExclusion
      ? healthyProcessExclusionBridge
      : { ...healthyBridge, droppedFrameCount: bridgeDroppedFrameCount },
    physicalOutput: processExclusion
      ? healthyProcessExclusionFingerprint
      : healthyPhysicalOutput,
    physicalOutputContentRaw: healthyPhysicalOutputContent,
    app: healthyApp,
    provider: healthyProvider,
    watchSessionReport: healthyWatchSessionReport,
    playback: echoCancel ? healthyAecPlayback : null,
    systemMetrics: processExclusion ? healthySystemMetrics : null,
  };
  writeJson(path.join(runDirectory, 'fixture-evidence.raw.json'), snapshots);
  writeJson(path.join(runDirectory, 'run-metadata.json'), {
    schemaVersion: 'watch-mode-run-metadata/v1',
    runMarker: null,
    startedAtLocal: null,
    modelId: cell.modelId,
    feedbackMode: cell.feedbackLoopPrevention,
  });
  const appLog = processExclusion
    ? [healthyAppLog, healthyProcessExclusionRestartLog].join('\n')
    : healthyAppLog;
  fs.writeFileSync(path.join(runDirectory, 'app.log'), `${appLog}\n`, 'utf8');
  fs.writeFileSync(path.join(runDirectory, 'bridge-service.log'), `${healthyBridgeLog}\n`, 'utf8');
  writeWatchModeRunCollection(runDirectory, {
    schemaVersion: WATCH_MODE_RUN_COLLECTION_SCHEMA,
    artifactKind: 'watch-mode-run-collection',
    request: { schemaVersion: 'watch-mode-run-request/v1', runMode: 'live' },
    collectionStatus: collectionFailure ? 'failed' : 'completed',
    steps,
    ownedProcesses: [],
    artifacts: {
      appLog: 'app.log',
      bridgeLog: 'bridge-service.log',
      runMetadata: 'run-metadata.json',
      fixtureEvidence: 'fixture-evidence.raw.json',
    },
    primaryError: collectionFailure,
    cleanupErrors: [],
  });
  const report = rebuildReportFromDirectory(runDirectory, {
    mode: 'live',
    provenance: PROVENANCE,
  });
  const reportPath = path.join(runDirectory, 'report.json');
  writeJson(reportPath, report);
  return JSON.parse(fs.readFileSync(reportPath, 'utf8'));
}

function writeRawBridgeFailureAuthority(runDirectory, cell) {
  return writeRawReportAuthority(runDirectory, cell, { bridgeDroppedFrameCount: 1 });
}

test('shard orchestration inventory is independent from local/matrix implementation authority', () => {
  assert.deepEqual(SHARD_ORCHESTRATION_IMPLEMENTATION_FILES, [
    'scripts/testing/watch-mode-shard-authority.mjs',
    'scripts/testing/run-watch-mode-live-shard.mjs',
    'scripts/testing/run-watch-mode-live-coordinator.mjs',
    'scripts/testing/run-watch-mode-live-production-coordinator.mjs',
    'scripts/testing/watch-mode-release-timeout-budget.mjs',
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

test('signed plan and leases bind exact four cells, serial waves, identities and mode-derived samples', () => {
  const fixture = createFixture();
  assert.throws(
    () => createFixture({ providerPreflightOverrides: { inputTokens: '64' } }),
    /exactly one completed zero-input LiveTranslate lifecycle/,
  );
  assert.equal(verifySignedExecutionPlan(fixture.plan, { now: fixture.now }), fixture.plan);
  assert.equal(fixture.plan.cells.length, 4);
  assert.deepEqual(fixture.plan.waves.map((wave) => wave.cellIds.length), [1, 1, 1, 1]);
  assert.equal(fixture.leases.length, 4);
  assert.equal(new Set(fixture.leases.map((lease) => lease.leaseId)).size, 4);
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
       ...structuredClone(PREFLIGHT_LIFECYCLE_AUTHORITY),
     },
    workers,
    assignments: workers.length === 1
      ? defaultSingleWorkerAssignments(workers)
      : [],
    ...fixture.signingKeys,
  });
  const oneWorkerPlan = createWithWorkers(testWorkers());
  assert.equal(oneWorkerPlan.workers.length, 1);
  assert.deepEqual(oneWorkerPlan.waves.map((wave) => wave.cellIds.length), [1, 1, 1, 1]);
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
    const cell = fixture.plan.cells.find((entry) => entry.feedbackLoopPrevention === 'virtual-driver');
    const lease = fixture.leases.find((entry) => entry.cellId === cell.cellId);
    writeSuccessfulRun(root, cell, lease);
    const usage = validateProviderUsageAuthority(root, { cell, lease });
    assert.equal(usage.actualExternalAudioSamples, 32_000);
    assert.equal(usage.maxExternalAudioSamples, cell.maxExternalAudioSamples);
    assert.equal(usage.launchLeasePath, PROVIDER_INPUT_BUDGET_LEASE_FILE);
    assert.equal(usage.journalEventCount, 5);

    writeSuccessfulRun(root, cell, lease, { samples: 0 });
    const zeroInputUsage = validateProviderUsageAuthority(root, { cell, lease });
    assert.equal(zeroInputUsage.actualExternalAudioSamples, 0);
    assert.equal(zeroInputUsage.journalEventCount, 3);

    const preProviderLedgerPath = path.join(root, PROVIDER_INPUT_BUDGET_LEDGER_FILE);
    const preProviderJournalPath = path.join(root, PROVIDER_INPUT_BUDGET_JOURNAL_FILE);
    const preProviderLedger = JSON.parse(fs.readFileSync(preProviderLedgerPath, 'utf8'));
    const preProviderJournal = fs.readFileSync(preProviderJournalPath, 'utf8')
      .trim().split(/\r?\n/u).map(JSON.parse);
    preProviderLedger.sessionGeneration = 0;
    preProviderLedger.initialConnectAttempts = 0;
    preProviderLedger.terminalReason = 'runner-failed-before-provider-session';
    const preProviderFinalized = {
      ...preProviderJournal.at(-1),
      sequence: 2,
      sessionGeneration: 0,
      initialConnectAttempts: 0,
      terminalReason: preProviderLedger.terminalReason,
    };
    const preProviderInitialized = {
      ...preProviderJournal[0],
      sessionGeneration: 0,
      initialConnectAttempts: 0,
    };
    writeJson(preProviderLedgerPath, preProviderLedger);
    fs.writeFileSync(
      preProviderJournalPath,
      `${[preProviderInitialized, preProviderFinalized].map(JSON.stringify).join('\n')}\n`,
      'utf8',
    );
    const preProviderUsage = validateProviderUsageAuthority(root, { cell, lease });
    assert.equal(preProviderUsage.initialConnectAttempts, 0);
    assert.equal(preProviderUsage.sessionGeneration, 0);
    assert.equal(preProviderUsage.terminalStatus, 'runner-failed-before-provider-session');

    writeSuccessfulRun(root, cell, lease, { samples: 0 });
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
    const cell = fixture.plan.cells.find((entry) => entry.feedbackLoopPrevention === 'virtual-driver');
    const lease = fixture.leases.find((entry) => entry.cellId === cell.cellId);
    const worker = fixture.plan.workers.find((entry) => entry.workerId === cell.workerId);
    const runDirectory = path.join(shardRoot, 'runs', 'failed-cell');
    writeSuccessfulRun(runDirectory, cell, lease);
    const rawReport = writeRawBridgeFailureAuthority(runDirectory, cell);
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
    assert.equal(validated.result.stableErrorCode, rawReport.stableErrorCode);
  } finally {
    fs.rmSync(shardRoot, { recursive: true, force: true });
  }
});

test('failed shard result builder rejects unknown failure identity fields', () => {
  const fixture = createFixture();
  const shardRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-shard-unknown-failure-'));
  try {
    const cell = fixture.plan.cells.find((entry) => entry.feedbackLoopPrevention === 'virtual-driver');
    const lease = fixture.leases.find((entry) => entry.cellId === cell.cellId);
    const worker = fixture.plan.workers.find((entry) => entry.workerId === cell.workerId);
    const runDirectory = path.join(shardRoot, 'runs', 'unknown-failure-cell');
    writeSuccessfulRun(runDirectory, cell, lease);
    writeJson(path.join(runDirectory, 'report.json'), {
      verdict: 'failed',
      failureLayer: 'unknown',
      stableErrorCode: 'unknown',
      lifecyclePhase: 'unknown',
      failureContext: {
        endpointId: cell.deviceProfileInstance.physicalPlaybackDeviceId,
        bridgeInstanceId: 'bridge-report-authority',
        ownerGenerationTransition: { before: 41, after: 42 },
      },
    });

    assert.throws(
      () => buildShardCellResult({
        plan: fixture.plan,
        lease,
        workerId: worker.workerId,
        vmIdentity: worker.vmIdentity,
        shardRoot,
        runDirectory,
        ...fixture.snapshot,
      }),
      /unknown|failure identity/i,
    );
  } finally {
    fs.rmSync(shardRoot, { recursive: true, force: true });
  }
});

test('failed shard result builder requires structured endpoint, bridge, and owner transition context', () => {
  const fixture = createFixture();
  const shardRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-shard-missing-failure-context-'));
  try {
    const cell = fixture.plan.cells[0];
    const lease = fixture.leases.find((entry) => entry.cellId === cell.cellId);
    const worker = fixture.plan.workers.find((entry) => entry.workerId === cell.workerId);
    const runDirectory = path.join(shardRoot, 'runs', 'missing-failure-context-cell');
    writeSuccessfulRun(runDirectory, cell, lease);
    writeJson(path.join(runDirectory, 'report.json'), {
      verdict: 'failed',
      failureLayer: 'bridge',
      stableErrorCode: 'bridge.restart-authority-failed',
      lifecyclePhase: 'bridge-restart',
      failureContext: {},
    });

    assert.throws(
      () => buildShardCellResult({
        plan: fixture.plan,
        lease,
        workerId: worker.workerId,
        vmIdentity: worker.vmIdentity,
        shardRoot,
        runDirectory,
        ...fixture.snapshot,
      }),
      /endpoint|bridge|owner.*transition|failure context/i,
    );
  } finally {
    fs.rmSync(shardRoot, { recursive: true, force: true });
  }
});

test('self-consistently rehashed shard failure fields must exactly match the original report', () => {
  const fixture = createFixture();
  const shardRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-shard-forged-failure-'));
  try {
    const cell = fixture.plan.cells.find((entry) => entry.feedbackLoopPrevention === 'virtual-driver');
    const lease = fixture.leases.find((entry) => entry.cellId === cell.cellId);
    const worker = fixture.plan.workers.find((entry) => entry.workerId === cell.workerId);
    const runDirectory = path.join(shardRoot, 'runs', 'forged-failure-cell');
    writeSuccessfulRun(runDirectory, cell, lease);
    const originalReport = writeRawBridgeFailureAuthority(runDirectory, cell);
    const written = writeShardCellResult({
      plan: fixture.plan,
      lease,
      workerId: worker.workerId,
      vmIdentity: worker.vmIdentity,
      shardRoot,
      runDirectory,
      ...fixture.snapshot,
    });
    const forged = JSON.parse(fs.readFileSync(written.resultPath, 'utf8'));
    forged.failureLayer = 'provider';
    forged.stableErrorCode = 'provider.response-stream-timeout';
    forged.lifecyclePhase = 'active-response';
    forged.failureContext = {
      endpointId: '{forged-endpoint}',
      bridgeInstanceId: 'bridge-instance-forged-result',
      ownerGenerationTransition: { before: 99, after: 100 },
    };
    const forgedCore = structuredClone(forged);
    delete forgedCore.resultDigest;
    forged.resultDigest = sha256Canonical(forgedCore);
    writeJson(written.resultPath, forged);

    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(runDirectory, 'report.json'), 'utf8')),
      originalReport,
      'the oracle is the unchanged original report, not a regenerated product report',
    );
    assert.throws(
      () => validateShardCellResult({
        resultPath: written.resultPath,
        plan: fixture.plan,
        lease,
        shardRoot,
        now: fixture.now,
      }),
      /strict report|failure.*mismatch|does not match/i,
    );
  } finally {
    fs.rmSync(shardRoot, { recursive: true, force: true });
  }
});

test('validator rejects a legal alternate failure identity rehashed over an unchanged raw run', () => {
  const fixture = createFixture();
  const shardRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-shard-raw-failure-authority-'));
  try {
    const cell = fixture.plan.cells.find((entry) => entry.feedbackLoopPrevention === 'virtual-driver');
    const lease = fixture.leases.find((entry) => entry.cellId === cell.cellId);
    const worker = fixture.plan.workers.find((entry) => entry.workerId === cell.workerId);
    const runDirectory = path.join(shardRoot, 'runs', 'raw-failure-authority-cell');
    writeSuccessfulRun(runDirectory, cell, lease);
    const rawReport = writeRawBridgeFailureAuthority(runDirectory, cell);
    assert.equal(rawReport.verdict, 'failed');
    assert.equal(rawReport.failureLayer, 'bridge');

    const written = writeShardCellResult({
      plan: fixture.plan,
      lease,
      workerId: worker.workerId,
      vmIdentity: worker.vmIdentity,
      shardRoot,
      runDirectory,
      ...fixture.snapshot,
    });
    const reportPath = path.join(runDirectory, 'report.json');
    const forgedReport = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    forgedReport.failureLayer = 'app';
    forgedReport.failureReason = 'provider response stream timeout';
    forgedReport.stableErrorCode = 'provider.response-stream-timeout';
    forgedReport.lifecyclePhase = 'active-response';
    forgedReport.failureContext = {
      endpointId: cell.deviceProfileInstance.physicalPlaybackDeviceId,
      bridgeInstanceId: 'bridge-valid-but-not-from-raw-evidence',
      ownerGenerationTransition: { before: 101, after: 102 },
      nativeResponseCancellation: null,
    };
    writeJson(reportPath, forgedReport);
    const forgedResult = JSON.parse(fs.readFileSync(written.resultPath, 'utf8'));
    forgedResult.failureLayer = forgedReport.failureLayer;
    forgedResult.stableErrorCode = forgedReport.stableErrorCode;
    forgedResult.lifecyclePhase = forgedReport.lifecyclePhase;
    forgedResult.failureContext = forgedReport.failureContext;
    refreshForgedResultAuthority(written.resultPath, forgedResult, reportPath);

    assert.equal(
      rebuildReportFromDirectory(runDirectory, { mode: 'live', provenance: PROVENANCE }).failureLayer,
      'bridge',
      'the independent oracle remains the unchanged raw Bridge failure',
    );
    assert.throws(
      () => validateShardCellResult({
        resultPath: written.resultPath,
        plan: fixture.plan,
        lease,
        shardRoot,
        now: fixture.now,
      }),
      /raw evidence|independently rebuilt|report authority/i,
    );
  } finally {
    fs.rmSync(shardRoot, { recursive: true, force: true });
  }
});

test('validator rejects self-consistent unknown failure identity even when report bytes agree', () => {
  const fixture = createFixture();
  const shardRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-shard-unknown-validator-'));
  try {
    const cell = fixture.plan.cells.find((entry) => entry.feedbackLoopPrevention === 'virtual-driver');
    const lease = fixture.leases.find((entry) => entry.cellId === cell.cellId);
    const worker = fixture.plan.workers.find((entry) => entry.workerId === cell.workerId);
    const runDirectory = path.join(shardRoot, 'runs', 'unknown-validator-cell');
    writeSuccessfulRun(runDirectory, cell, lease);
    const reportPath = path.join(runDirectory, 'report.json');
    writeRawBridgeFailureAuthority(runDirectory, cell);
    const written = writeShardCellResult({
      plan: fixture.plan,
      lease,
      workerId: worker.workerId,
      vmIdentity: worker.vmIdentity,
      shardRoot,
      runDirectory,
      ...fixture.snapshot,
    });
    const forgedReport = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    forgedReport.failureLayer = 'unknown';
    forgedReport.stableErrorCode = 'unknown';
    forgedReport.lifecyclePhase = 'unknown';
    writeJson(reportPath, forgedReport);
    const forgedResult = JSON.parse(fs.readFileSync(written.resultPath, 'utf8'));
    forgedResult.failureLayer = forgedReport.failureLayer;
    forgedResult.stableErrorCode = forgedReport.stableErrorCode;
    forgedResult.lifecyclePhase = forgedReport.lifecyclePhase;
    refreshForgedResultAuthority(written.resultPath, forgedResult, reportPath);

    assert.throws(
      () => validateShardCellResult({
        resultPath: written.resultPath,
        plan: fixture.plan,
        lease,
        shardRoot,
        now: fixture.now,
      }),
      /unknown|failure identity/i,
    );
  } finally {
    fs.rmSync(shardRoot, { recursive: true, force: true });
  }
});

test('validator rejects self-consistent malformed endpoint, bridge, and owner context', () => {
  const fixture = createFixture();
  const shardRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-shard-context-validator-'));
  try {
    const cell = fixture.plan.cells.find((entry) => entry.feedbackLoopPrevention === 'virtual-driver');
    const lease = fixture.leases.find((entry) => entry.cellId === cell.cellId);
    const worker = fixture.plan.workers.find((entry) => entry.workerId === cell.workerId);
    const runDirectory = path.join(shardRoot, 'runs', 'context-validator-cell');
    writeSuccessfulRun(runDirectory, cell, lease);
    const reportPath = path.join(runDirectory, 'report.json');
    writeRawBridgeFailureAuthority(runDirectory, cell);
    const written = writeShardCellResult({
      plan: fixture.plan,
      lease,
      workerId: worker.workerId,
      vmIdentity: worker.vmIdentity,
      shardRoot,
      runDirectory,
      ...fixture.snapshot,
    });
    const forgedReport = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    forgedReport.failureContext = {};
    writeJson(reportPath, forgedReport);
    const forgedResult = JSON.parse(fs.readFileSync(written.resultPath, 'utf8'));
    forgedResult.failureContext = {};
    refreshForgedResultAuthority(written.resultPath, forgedResult, reportPath);

    assert.throws(
      () => validateShardCellResult({
        resultPath: written.resultPath,
        plan: fixture.plan,
        lease,
        shardRoot,
        now: fixture.now,
      }),
      /endpoint|bridge|owner.*transition|failure context/i,
    );
  } finally {
    fs.rmSync(shardRoot, { recursive: true, force: true });
  }
});

test('self-consistently rehashed manifest failure identity must match its validated cell result', () => {
  const fixture = createFixture();
  const shardRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-shard-manifest-failure-'));
  try {
    const worker = fixture.plan.workers[0];
    const resultPaths = [];
    for (const cell of fixture.plan.cells) {
      const lease = fixture.leases.find((entry) => entry.cellId === cell.cellId);
      const runDirectory = path.join(shardRoot, 'runs', `cell-${cell.cellIndex}`);
      writeSuccessfulRun(runDirectory, cell, lease);
      if (cell.feedbackLoopPrevention === 'virtual-driver') {
        writeRawBridgeFailureAuthority(runDirectory, cell);
      }
      resultPaths.push(writeShardCellResult({
        plan: fixture.plan,
        lease,
        workerId: worker.workerId,
        vmIdentity: worker.vmIdentity,
        shardRoot,
        runDirectory,
        ...fixture.snapshot,
      }).resultPath);
    }
    const written = writeShardManifest({
      plan: fixture.plan,
      leases: fixture.leases,
      workerId: worker.workerId,
      shardRoot,
      resultPaths,
    });
    const forged = JSON.parse(fs.readFileSync(written.manifestPath, 'utf8'));
    const failedBinding = forged.results.find((entry) => entry.verdict === 'failed');
    failedBinding.failureLayer = 'provider';
    failedBinding.stableErrorCode = 'provider.response-stream-timeout';
    failedBinding.lifecyclePhase = 'active-response';
    failedBinding.failureContext = {
      endpointId: '{forged-manifest-endpoint}',
      bridgeInstanceId: 'forged-manifest-bridge',
      ownerGenerationTransition: { before: 700, after: 701 },
    };
    const forgedCore = structuredClone(forged);
    delete forgedCore.manifestDigest;
    forged.manifestDigest = sha256Canonical(forgedCore);
    writeJson(written.manifestPath, forged);

    assert.throws(
      () => validateShardManifest({
        manifestPath: written.manifestPath,
        shardRoot,
        plan: fixture.plan,
        leases: fixture.leases,
        now: fixture.now,
      }),
      /manifest result.*failure identity.*mismatch/i,
    );
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
    const blockedReport = writeRawReportAuthority(runDirectory, cell, {
      collectionFailure: { message: 'environment prerequisite unavailable' },
      steps: [{
        schemaVersion: 'watch-mode-step/v2',
        id: 'start-desktop-shell',
        name: 'start desktop shell',
        status: 'blocked',
        data: null,
        error: { message: 'environment prerequisite unavailable' },
      }],
    });
    assert.equal(blockedReport.verdict, 'blocked');
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
    assert.equal(validated.result.stableErrorCode, blockedReport.stableErrorCode);
    assert.equal(validated.result.lifecyclePhase, 'environment-preflight');
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
