import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  PROVIDER_INPUT_BUDGET_JOURNAL_FILE,
  PROVIDER_INPUT_BUDGET_LEASE_FILE,
  PROVIDER_INPUT_BUDGET_LEASE_KIND,
  PROVIDER_INPUT_BUDGET_LEDGER_FILE,
  PROVIDER_INPUT_BUDGET_LEDGER_KIND,
  createSignedExecutionPlan,
  generateCoordinatorSigningKeyPair,
  issueCellLeases,
} from './watch-mode-shard-authority.mjs';
import {
  acquireInteractiveShardAuthorities,
  buildPowerShellRunnerArgv,
  buildShardCellExecutionRequest,
  runLeasedShardCell,
  terminatePowerShellShardChild,
} from './run-watch-mode-live-shard.mjs';
import { defaultSingleWorkerAssignments } from './run-watch-mode-live-coordinator.mjs';
import { LIVE_LLM_CELLS } from './watch-mode-balanced-release-plan.mjs';
import {
  WATCH_RUNNER_READINESS_TIMEOUT_SECONDS,
  WATCH_SHARD_POST_REPORT_ENVELOPE_MS,
  WATCH_SHARD_PRE_DESKTOP_ENVELOPE_MS,
  WATCH_SHARD_PROCESS_IDENTITY_TIMEOUT_MS,
  WATCH_SHARD_PROCESS_KILL_TIMEOUT_MS,
  WATCH_SHARD_PROCESS_TERMINATION_GRACE_MS,
  deriveWatchRunnerInternalDeadlineMs,
  deriveWatchShardPreExecutionBudgetMs,
  deriveWatchShardWorkerTimeoutMs,
} from './watch-mode-release-timeout-budget.mjs';
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
const PROVENANCE = Object.freeze({
  schemaVersion: 1,
  source: 'git',
  captureStatus: 'captured',
  headCommit: '2'.repeat(40),
  worktreeClean: true,
  dirtyEntryCount: 0,
});

const inventory = (name, sha) => [{ path: `${name}/binary`, bytes: 11, sha256: sha }];

function fixture() {
  const now = new Date();
  const generatedAt = new Date(now.getTime() - 1_000);
  const workers = [{
    workerId: 'local-vmware', vmIdentity: { provider: 'vmware', uuidBios: 'uuid-local' },
    deviceProfileInstances: [{
      instanceId: 'local-hda', profileId: 'vmware-hda', deviceClass: 'default-speaker',
      physicalPlaybackDeviceId: '{hda-endpoint}',
      expectedPhysicalPlaybackDeviceName: '扬声器 (High Definition Audio Device)',
    }],
  }];
  const keys = generateCoordinatorSigningKeyPair();
  const snapshot = {
    provenance: PROVENANCE,
    authorityImplementationHashes: inventory('matrix', SHA_A),
    runtimeBinaryHashes: inventory('runtime', SHA_B),
    shardOrchestrationImplementationHashes: inventory('shard', SHA_A),
  };
  const plan = createSignedExecutionPlan({
    executionId: 'watch-shard-worker-test',
    generatedAt,
    expiresAt: new Date(now.getTime() + 3_600_000),
    provenance: PROVENANCE,
    ...snapshot,
    localIsolationAuthority: { path: 'local.json', bytes: 1, sha256: SHA_A, providerCalls: 0 },
    providerPreflightAuthority: {
      path: 'preflight.json', bytes: 1, sha256: SHA_B, status: 'completed',
      providerId: 'provider-dashscope',
      model: 'qwen3.5-livetranslate-flash-realtime',
      protocol: 'dashscope-livetranslate',
      operation: 'livetranslate-session-lifecycle-preflight',
      modelProtocolProfileIdentity: MODEL_PROTOCOL_PROFILE_IDENTITY,
      inputMode: 'none',
      providerInputMode: 'none',
      responseMode: 'text-only',
      terminalEvent: 'session.finished',
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
    },
    workers,
    assignments: defaultSingleWorkerAssignments(workers),
    ...keys,
  });
  return {
    now,
    workers,
    snapshot,
    plan,
    leases: issueCellLeases(plan, keys.privateKeyPem, { issuedAt: generatedAt }),
  };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

function writeSuccessfulRun(runDirectory, cell, lease) {
  fs.mkdirSync(runDirectory, { recursive: true });
  const runMarker = `watch_mode_diagnostic.run_id=${cell.cellIndex}`;
  const identity = {
    schemaVersion: 2,
    artifactKind: PROVIDER_INPUT_BUDGET_LEDGER_KIND,
    cellId: cell.cellId,
    leaseId: lease.leaseId,
    runMarker,
    sessionGeneration: 1,
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
    protocol: cell.modelId.includes('livetranslate') ? 'dashscope-livetranslate' : 'dashscope-omni',
    modelProtocolProfileIdentity: structuredClone(cell.modelProtocolProfileIdentity),
  };
  writeJson(path.join(runDirectory, 'physical-playback-device.json'), {
    profileId: cell.deviceProfileInstance.profileId,
    deviceClass: cell.deviceClass,
    requestedDeviceId: cell.deviceProfileInstance.physicalPlaybackDeviceId,
    resolvedDeviceId: `{resolved-${cell.cellIndex}}`,
    resolvedDeviceName: cell.deviceProfileInstance.expectedPhysicalPlaybackDeviceName || 'VMware HDA Test',
    verified: true,
    fixtureOnly: false,
  });
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
    totalAttemptedSamples: 16_000,
    appendAttempts: 1,
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
    { ...identity, sequence: 3, event: 'reserved', initialConnectAttempts: 1, attemptedSamples: 16_000, finalized: false },
    { ...identity, sequence: 4, event: 'finalized', initialConnectAttempts: 1, finalized: true },
  ];
  fs.writeFileSync(
    path.join(runDirectory, PROVIDER_INPUT_BUDGET_JOURNAL_FILE),
    `${events.map(JSON.stringify).join('\n')}\n`,
    'utf8',
  );
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
    bridge: processExclusion ? healthyProcessExclusionBridge : healthyBridge,
    physicalOutput: processExclusion ? healthyProcessExclusionFingerprint : healthyPhysicalOutput,
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
  fs.writeFileSync(
    path.join(runDirectory, 'app.log'),
    `${processExclusion
      ? [healthyAppLog, healthyProcessExclusionRestartLog].join('\n')
      : healthyAppLog}\n`,
    'utf8',
  );
  fs.writeFileSync(path.join(runDirectory, 'bridge-service.log'), `${healthyBridgeLog}\n`, 'utf8');
  writeWatchModeRunCollection(runDirectory, {
    schemaVersion: WATCH_MODE_RUN_COLLECTION_SCHEMA,
    artifactKind: 'watch-mode-run-collection',
    request: { schemaVersion: 'watch-mode-run-request/v1', runMode: 'live' },
    collectionStatus: 'completed',
    steps: [],
    ownedProcesses: [],
    artifacts: {
      appLog: 'app.log',
      bridgeLog: 'bridge-service.log',
      runMetadata: 'run-metadata.json',
      fixtureEvidence: 'fixture-evidence.raw.json',
    },
    primaryError: null,
    cleanupErrors: [],
  });
  writeJson(path.join(runDirectory, 'report.json'), rebuildReportFromDirectory(runDirectory, {
    mode: 'live',
    provenance: PROVENANCE,
  }));
}

test('worker request carries only its signed paid cell and never contains build/preflight/local work', () => {
  const value = fixture();
  const cell = value.plan.cells[0];
  const lease = value.leases[0];
  const worker = value.plan.workers.find((entry) => entry.workerId === cell.workerId);
  const request = buildShardCellExecutionRequest({
    plan: value.plan,
    lease,
    workerId: worker.workerId,
    vmIdentity: worker.vmIdentity,
    shardRoot: path.join(os.tmpdir(), 'omni-request-only'),
    now: value.now,
  });
  assert.equal(request.leaseId, lease.leaseId);
  assert.equal(request.environment.OMNI_WATCH_MODE_PROVIDER_INPUT_LEASE_ID, lease.leaseId);
  assert.deepEqual({
    strict: request.environment.OMNI_WATCH_MODE_STRICT_PAID_AUTHORITY,
    providerId: request.environment.OMNI_WATCH_MODE_EXPECTED_PROVIDER_ID,
    templateId: request.environment.OMNI_WATCH_MODE_EXPECTED_PROVIDER_TEMPLATE_ID,
    providerKind: request.environment.OMNI_WATCH_MODE_EXPECTED_PROVIDER_KIND,
    endpointHost: request.environment.OMNI_WATCH_MODE_EXPECTED_PROVIDER_ENDPOINT_HOST,
    credentialReference:
      request.environment.OMNI_WATCH_MODE_EXPECTED_PROVIDER_CREDENTIAL_REFERENCE,
  }, {
    strict: '1',
    providerId: 'provider-dashscope',
    templateId: 'template-dashscope-realtime',
    providerKind: 'dashscope',
    endpointHost: 'dashscope.aliyuncs.com',
    credentialReference: 'credential://provider/dashscope/default',
  });
  assert.equal(
    request.environment.OMNI_WATCH_MODE_PROVIDER_INPUT_MAX_SAMPLES,
    String(cell.maxExternalAudioSamples),
  );
  assert.equal(request.runnerOptions.strictPaidAuthority, true);
  assert.equal(request.runnerOptions.matrixCellId, cell.cellId);
  assert.equal(request.runnerOptions.subtitleTranslationMode, 'native');
  assert.equal(request.runnerOptions.model, 'qwen3.5-livetranslate-flash-realtime');
  assert.deepEqual(
    request.runnerOptions.modelProtocolProfileIdentity,
    cell.modelProtocolProfileIdentity,
  );
  assert.deepEqual(
    JSON.parse(request.environment.OMNI_WATCH_MODE_MODEL_PROTOCOL_PROFILE_IDENTITY),
    cell.modelProtocolProfileIdentity,
  );
  assert.equal(request.runnerOptions.postPlaybackWaitSeconds, 0);
  assert.equal(request.runnerOptions.sessionReadyTimeoutSeconds, WATCH_RUNNER_READINESS_TIMEOUT_SECONDS);
  assert.equal(request.runnerOptions.watchAutoStopAfterSeconds, 225);
  assert.equal(request.runnerOptions.processExclusionRestartAfterSeconds, 90);
  assert.equal(request.runnerOptions.processExclusionRestartQuietSeconds, 45);
  assert.equal(request.runnerOptions.providerFinishTimeoutSeconds, 15);
  assert.equal(request.runnerOptions.localPlaybackDrainTimeoutSeconds, 30);
  assert.equal(request.runnerOptions.physicalRecorderTailSeconds, 2);
  assert.equal(
    deriveWatchShardWorkerTimeoutMs(cell),
    WATCH_SHARD_PRE_DESKTOP_ENVELOPE_MS
      + deriveWatchRunnerInternalDeadlineMs(cell)
      + WATCH_SHARD_POST_REPORT_ENVELOPE_MS
      + WATCH_SHARD_PROCESS_TERMINATION_GRACE_MS,
  );
  assert.equal(deriveWatchShardWorkerTimeoutMs(cell), 458_000);
  assert.equal(request.runnerOptions.inputCompletePath, path.join(request.cellOutputRoot, 'input-complete.json'));
  assert.equal(request.runnerOptions.terminalAuthorityPath, path.join(request.cellOutputRoot, 'evidence-driven-terminal.json'));
  assert.equal(path.basename(request.cellOutputRoot), 'c01');
  assert.ok(request.cellOutputRoot.length < path.join(
    path.join(os.tmpdir(), 'omni-request-only'),
    'runs',
    `01-${cell.cellId}`,
  ).length);
  const argv = buildPowerShellRunnerArgv(path.join(request.cellOutputRoot, 'run-request.json'));
  assert.ok(argv.includes('--request'));
  assert.ok(!argv.includes('-StrictPaidAuthority'));
  assert.equal(argv.some((arg) => /preflight|local-isolation|build/i.test(arg)), false);
});

test('validated worker readiness is forwarded to the strict live runner', async () => {
  const value = fixture();
  const cell = value.plan.cells[0];
  const lease = value.leases[0];
  const worker = value.plan.workers.find((entry) => entry.workerId === cell.workerId);
  const request = buildShardCellExecutionRequest({
    plan: value.plan,
    lease,
    workerId: worker.workerId,
    vmIdentity: worker.vmIdentity,
    shardRoot: path.join(os.tmpdir(), 'omni-readiness-forward'),
    now: value.now,
  });
  request.runnerOptions.readinessReceiptPath = 'E:\\signed\\zero-provider-readiness.json';
  const argv = buildPowerShellRunnerArgv(path.join(request.cellOutputRoot, 'run-request.json'));
  assert.equal(argv.includes('-WorkerReadinessReceiptPath'), false);
  assert.equal(request.runnerOptions.readinessReceiptPath, 'E:\\signed\\zero-provider-readiness.json');
});

test('delayed interactive authorities, identity, and taskkill consume formula-owned outer phases', async () => {
  const events = [];
  let elapsedMs = 0;
  const currentProcess = { pid: 42, startedAt: '2026-08-31T00:00:00.000Z' };
  await acquireInteractiveShardAuthorities({
    interactiveCommandPath: 'interactive-command.json',
    interactiveLaunchAuthorityPath: 'interactive-launch.json',
    interactiveReleasePath: 'interactive-release.json',
    plan: { executionId: 'fake-delayed-authority' },
    lease: { leaseId: 'lease-delayed-authority' },
    worker: { workerId: 'worker-delayed-authority' },
  }, {
    waitForAuthorityFile: async (_filePath, label, timeoutMs) => {
      events.push(label);
      elapsedMs += timeoutMs;
    },
    inspectCurrentProcess: ({ timeoutMs }) => {
      events.push('process identity');
      elapsedMs += timeoutMs;
      return currentProcess;
    },
    validateLaunchAuthority: ({ currentProcess: received }) => {
      events.push('validated');
      assert.equal(received, currentProcess);
    },
  });
  assert.deepEqual(events, [
    'interactive launch authority',
    'interactive claim release',
    'process identity',
    'validated',
  ]);
  assert.equal(elapsedMs, deriveWatchShardPreExecutionBudgetMs());
  assert.ok(elapsedMs >= WATCH_SHARD_PROCESS_IDENTITY_TIMEOUT_MS);

  let killInvocation = null;
  terminatePowerShellShardChild({ pid: 4242 }, {
    platform: 'win32',
    killProcessTree: (executable, args, options) => {
      killInvocation = { executable, args, options };
      elapsedMs += options.timeout;
      return { status: 0 };
    },
  });
  assert.equal(killInvocation.executable, 'taskkill.exe');
  assert.deepEqual(killInvocation.args, ['/PID', '4242', '/F', '/T']);
  assert.equal(killInvocation.options.timeout, WATCH_SHARD_PROCESS_KILL_TIMEOUT_MS);
  assert.equal(
    elapsedMs,
    deriveWatchShardPreExecutionBudgetMs() + WATCH_SHARD_PROCESS_KILL_TIMEOUT_MS,
  );
});

test('worker executes exactly one coordinator lease, verifies continuity, and writes result/terminal authority', async () => {
  const value = fixture();
  const shardRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-worker-run-'));
  try {
    const cell = value.plan.cells[0];
    const lease = value.leases[0];
    const worker = value.plan.workers.find((entry) => entry.workerId === cell.workerId);
    let executions = 0;
    let executionTimeoutMs = null;
    const outcome = await runLeasedShardCell({
      plan: value.plan,
      lease,
      workerId: worker.workerId,
      vmIdentity: worker.vmIdentity,
      shardRoot,
      authoritySnapshot: value.snapshot,
      readAuthoritySnapshot: () => value.snapshot,
      now: () => value.now,
      executeCell: async (request, { timeoutMs }) => {
        executions += 1;
        executionTimeoutMs = timeoutMs;
        assert.equal(request.environment.OMNI_WATCH_MODE_PROVIDER_INPUT_LEASE_ID, lease.leaseId);
        const runDirectory = path.join(request.cellOutputRoot, 'run-1');
        writeSuccessfulRun(runDirectory, cell, lease);
        return { exitCode: 0, runDirectory };
      },
    });
    assert.equal(executions, 1);
    assert.equal(executionTimeoutMs, deriveWatchShardWorkerTimeoutMs(cell));
    assert.equal(outcome.result.verdict, 'passed');
    assert.equal(outcome.result.usageAuthority.leaseId, lease.leaseId);
    assert.equal(JSON.parse(fs.readFileSync(outcome.terminalPath, 'utf8')).status, 'passed');
    assert.ok(fs.existsSync(outcome.resultPath));
  } finally {
    fs.rmSync(shardRoot, { recursive: true, force: true });
  }
});

test('a failed paid attempt consumes its lease and cannot be retried after process restart', async () => {
  const value = fixture();
  const shardRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-worker-fail-'));
  try {
    const cell = value.plan.cells[0];
    const lease = value.leases[0];
    const worker = value.plan.workers.find((entry) => entry.workerId === cell.workerId);
    let executions = 0;
    const options = {
      plan: value.plan,
      lease,
      workerId: worker.workerId,
      vmIdentity: worker.vmIdentity,
      shardRoot,
      authoritySnapshot: value.snapshot,
      now: () => value.now,
      executeCell: async () => {
        executions += 1;
        return { exitCode: 9, runDirectory: null };
      },
    };
    await assert.rejects(runLeasedShardCell(options), /exited with 9/);
    await assert.rejects(runLeasedShardCell(options), /refusing to overwrite immutable authority file/);
    assert.equal(executions, 1);
    const terminal = JSON.parse(fs.readFileSync(
      path.join(shardRoot, 'lease-terminals', `${lease.leaseId}.json`),
      'utf8',
    ));
    assert.equal(terminal.status, 'failed');
    assert.equal(terminal.leaseId, lease.leaseId);
  } finally {
    fs.rmSync(shardRoot, { recursive: true, force: true });
  }
});

test('worker discards a paid result when runtime hashes change during the cell', async () => {
  const value = fixture();
  const shardRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-worker-continuity-'));
  try {
    const cell = value.plan.cells[0];
    const lease = value.leases[0];
    const worker = value.plan.workers.find((entry) => entry.workerId === cell.workerId);
    const changedSnapshot = {
      ...value.snapshot,
      runtimeBinaryHashes: inventory('runtime', SHA_A),
    };
    await assert.rejects(
      runLeasedShardCell({
        plan: value.plan,
        lease,
        workerId: worker.workerId,
        vmIdentity: worker.vmIdentity,
        shardRoot,
        authoritySnapshot: value.snapshot,
        readAuthoritySnapshot: () => changedSnapshot,
        now: () => value.now,
        executeCell: async (request) => {
          const runDirectory = path.join(request.cellOutputRoot, 'run-1');
          writeSuccessfulRun(runDirectory, cell, lease);
          return { exitCode: 0, runDirectory };
        },
      }),
      /runtime binary hashes/,
    );
    assert.equal(
      fs.existsSync(path.join(shardRoot, 'runs', 'c01', 'run-1', 'shard-cell-result.json')),
      false,
    );
  } finally {
    fs.rmSync(shardRoot, { recursive: true, force: true });
  }
});
