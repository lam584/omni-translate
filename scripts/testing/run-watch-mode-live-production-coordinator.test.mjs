import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import test from 'node:test';

import { repoRoot } from '../lib/testing-common.mjs';
import { LIVE_LLM_CELLS } from './watch-mode-balanced-release-plan.mjs';
import { AUTHORITY_RUNTIME_BINARY_FILES } from './watch-mode-evidence-authority.mjs';
import {
  WATCH_REMOTE_DISPATCH_AND_RECEIPT_ENVELOPE_MS,
  WATCH_SHARD_WORKER_TIMEOUT_MS,
} from './watch-mode-release-timeout-budget.mjs';
import {
  coordinatorKeyIdForPublicKey,
  createWorkerReadinessRequest,
  fileAuthorityEntry,
  generateCoordinatorSigningKeyPair,
} from './watch-mode-shard-authority.mjs';
import {
  PRODUCTION_WORKER_CONFIG_KIND,
  PRODUCTION_CELL_DOWNLOAD_TIMEOUT_MS,
  PRODUCTION_COORDINATOR_TIMEOUT_MS,
  PRODUCTION_INTERACTIVE_SESSION_LAUNCH_BODY,
  PRODUCTION_POST_PREFLIGHT_EVIDENCE_MARGIN_MS,
  PRODUCTION_PRESERVED_WORKER_READINESS_BODY,
  PRODUCTION_REMOTE_CELL_TIMEOUT_MS,
  PRODUCTION_ZERO_PROVIDER_READINESS_TIMEOUT_MS,
  PRODUCTION_WORKER_READINESS_FINALIZE_BODY,
  PRODUCTION_WORKER_ZERO_PROVIDER_READINESS_BODY,
  parseProductionCoordinatorCliArgs,
  aggregateProductionCellFailures,
  productionCellFailureDisposition,
  productionFailureFingerprint,
  remotePowerShellInvocation,
  decodeRemotePowerShellFileOutput,
  runRemoteJsonWithRetries,
  PRODUCTION_REMOTE_RUNTIME_VERIFICATION_TIMEOUT_MS,
  PRODUCTION_REMOTE_READINESS_FINALIZATION_TIMEOUT_MS,
  runProductionCoordinator,
  scpBaseArgs,
  sshBaseArgs,
  validateProductionWorkerConfig,
  windowsPowerShellEnvironment,
} from './run-watch-mode-live-production-coordinator.mjs';

test('production cell failures stop only for safety boundaries and collect ordinary verdicts', () => {
  assert.equal(productionCellFailureDisposition({
    error: new Error('runtime hash mismatch before evidence collection'),
  }), 'stop');
  assert.equal(productionCellFailureDisposition({
    outcome: { result: { verdict: 'failed', stableErrorCode: 'watch.acoustic.reference-mismatch' } },
    error: new Error('strict cell verdict failed: watch.acoustic.reference-mismatch'),
  }), 'collect');
  assert.equal(productionCellFailureDisposition({
    outcome: {
      result: {
        verdict: 'failed',
        stableErrorCode: 'watch.strict-cell.blocked',
        failureLayer: 'environment',
        endpointId: '{physical-endpoint}',
        diagnostics: { rejectedReference: 'wrong translated audio' },
      },
    },
    error: new Error('strict cell verdict failed: watch.strict-cell.blocked'),
  }), 'collect');
  assert.equal(productionCellFailureDisposition({
    error: new Error('endpoint ownership conflict detected before the next cell'),
  }), 'stop');
});

test('production failure aggregation reports progress and shared root causes', () => {
  const plan = {
    cells: [
      { cellId: 'a', feedbackLoopPrevention: 'process-exclusion' },
      { cellId: 'b', feedbackLoopPrevention: 'process-exclusion' },
      { cellId: 'c', feedbackLoopPrevention: 'echo-cancel' },
    ],
  };
  const failed = (cellId) => ({
    cellId,
    error: 'acoustic mismatch',
    outcome: {
      result: {
        verdict: 'failed',
        failureLayer: 'acoustic',
        stableErrorCode: 'watch.acoustic.mismatch',
        lifecyclePhase: 'physical-playback-proof',
        failureContext: {
          endpointId: '{shared-endpoint}',
          bridgeInstanceId: 'shared-bridge-instance',
          ownerGenerationTransition: { before: 10, after: 11 },
        },
      },
    },
  });
  const summary = aggregateProductionCellFailures({
    plan,
    waveOutcome: {
      startedCellIds: ['a', 'b', 'c'],
      completedCellIds: ['a', 'b', 'c'],
      collectedFailures: [failed('a'), failed('b')],
    },
  });
  assert.deepEqual(summary.attempted, ['a', 'b', 'c']);
  assert.deepEqual(summary.passed, ['c']);
  assert.deepEqual(summary.failed, ['a', 'b']);
  assert.equal(summary.sharedRootCauses.length, 1);
  assert.deepEqual(summary.sharedRootCauses[0].cellIds, ['a', 'b']);
  assert.equal(summary.cellSpecificFailures.length, 0);
});

test('production fingerprint rejects nested report fallbacks when validated direct fields are absent', () => {
  const plan = {
    cells: [{
      cellId: 'cell-a',
      feedbackLoopPrevention: 'process-exclusion',
      deviceProfileInstance: { physicalPlaybackDeviceId: '{plan-endpoint}' },
    }],
  };
  const failure = {
    cellId: 'cell-a',
    outcome: {
      result: {
        verdict: 'failed',
        report: {
          failureLayer: 'bridge',
          stableErrorCode: 'bridge.restart-authority-failed',
          lifecyclePhase: 'bridge-restart',
          failureContext: {
            endpointId: '{nested-report-endpoint}',
            bridgeInstanceId: 'nested-report-bridge',
            ownerGenerationTransition: { before: 1, after: 2 },
          },
        },
        restartSummary: {
          phase: 'nested-restart-phase',
          newBridgeInstanceId: 'nested-restart-bridge',
          playbackOwnerGeneration: 2,
        },
      },
    },
  };

  assert.throws(
    () => productionFailureFingerprint(failure, plan),
    'a coordinator fingerprint must require validated shard-result fields instead of guessing from nested objects',
  );
});

test('production failure grouping includes the bridge instance authority', () => {
  const plan = {
    cells: [
      { cellId: 'cell-a', feedbackLoopPrevention: 'process-exclusion' },
      { cellId: 'cell-b', feedbackLoopPrevention: 'process-exclusion' },
    ],
  };
  const failed = (cellId, bridgeInstanceId) => ({
    cellId,
    error: 'bridge restart authority failed',
    outcome: {
      result: {
        verdict: 'failed',
        failureLayer: 'bridge',
        stableErrorCode: 'bridge.restart-authority-failed',
        lifecyclePhase: 'bridge-restart',
        failureContext: {
          endpointId: '{same-endpoint}',
          bridgeInstanceId,
          ownerGenerationTransition: { before: 10, after: 11 },
        },
      },
    },
  });
  const summary = aggregateProductionCellFailures({
    plan,
    waveOutcome: {
      startedCellIds: ['cell-a', 'cell-b'],
      completedCellIds: ['cell-a', 'cell-b'],
      collectedFailures: [
        failed('cell-a', 'bridge-instance-a'),
        failed('cell-b', 'bridge-instance-b'),
      ],
    },
  });

  assert.equal(summary.sharedRootCauses.length, 0);
  assert.equal(summary.cellSpecificFailures.length, 2);
  assert.deepEqual(
    summary.cellSpecificFailures.map((entry) => entry.fingerprint.bridgeInstanceId),
    ['bridge-instance-a', 'bridge-instance-b'],
  );
});

test('remote runtime verification has a bounded slow-disk timeout', () => {
  assert.equal(PRODUCTION_REMOTE_RUNTIME_VERIFICATION_TIMEOUT_MS, 5 * 60 * 1000);
  const source = fs.readFileSync(new URL('./run-watch-mode-live-production-coordinator.mjs', import.meta.url), 'utf8');
  assert.match(
    source,
    /planPath:\s*remotePlanPath,\s*},\s*{\s*timeoutMs:\s*PRODUCTION_REMOTE_RUNTIME_VERIFICATION_TIMEOUT_MS,/s,
  );
  assert.doesNotMatch(
    source,
    /planPath:\s*remotePlanPath,\s*},\s*undefined,\s*{\s*timeoutMs:\s*PRODUCTION_REMOTE_RUNTIME_VERIFICATION_TIMEOUT_MS,/s,
  );
});

test('a killed Windows child settles the transport timeout without waiting for an exit event', () => {
  const source = fs.readFileSync(new URL('./run-watch-mode-live-production-coordinator.mjs', import.meta.url), 'utf8');
  assert.match(source, /child process timed out after/);
  assert.match(source, /exitCode: 124/);
  assert.match(source, /timer = setTimeout\(\(\) => \{[\s\S]*finish\(\(\) => resolve\(/);
});

test('worker preparation normalizes and verifies signed implementation bytes before readiness', () => {
  const source = fs.readFileSync(new URL('./run-watch-mode-live-production-coordinator.mjs', import.meta.url), 'utf8');
  assert.match(source, /plan\.authority\.implementationHashes/);
  assert.match(source, /plan\.authority\.incidentImplementationHashes/);
  assert.match(
    source,
    /for \(const entry of implementationEntries\) await upload\(worker, entry\.localPath, entry\.remotePath\)/,
  );
  assert.match(source, /implementation mismatch: \$target/);
  assert.match(source, /implementation verification returned an incomplete inventory/);
  assert.ok(
    source.indexOf('implementation verification returned an incomplete inventory')
      < source.lastIndexOf('PRODUCTION_WORKER_ZERO_PROVIDER_READINESS_BODY'),
    'signed implementation verification must precede zero-provider readiness and Provider preflight',
  );
});

test('worker clean-state checks content and untracked files instead of racy porcelain metadata', () => {
  const source = fs.readFileSync(new URL('./run-watch-mode-live-production-coordinator.mjs', import.meta.url), 'utf8');
  const queryWorker = source.slice(
    source.indexOf('async function queryWorker'),
    source.indexOf('async function prepareWorker'),
  );
  assert.match(queryWorker, /diff --quiet --ignore-submodules --/);
  assert.match(queryWorker, /diff --cached --quiet --ignore-submodules --/);
  assert.match(queryWorker, /ls-files --others --exclude-standard/);
  assert.match(queryWorker, /\$dirtyEntryCount = @\(\$untracked\)\.Count/);
  assert.doesNotMatch(queryWorker, /status --porcelain=v1 --untracked-files=all/);
});

test('remote readiness finalization has a bounded slow-disk timeout', () => {
  assert.equal(PRODUCTION_REMOTE_READINESS_FINALIZATION_TIMEOUT_MS, 5 * 60 * 1000);
  const source = fs.readFileSync(new URL('./run-watch-mode-live-production-coordinator.mjs', import.meta.url), 'utf8');
  assert.match(source, /timeoutMs:\s*PRODUCTION_REMOTE_READINESS_FINALIZATION_TIMEOUT_MS/);
});

const CLEAN_PROVENANCE = {
  schemaVersion: 1,
  source: 'git',
  captureStatus: 'captured',
  headCommit: 'a'.repeat(40),
  worktreeClean: true,
  dirtyEntryCount: 0,
};

const isWindows = process.platform === 'win32';

test('zero-provider readiness reserves enough time for signed driver reinstall and verification', () => {
  assert.equal(PRODUCTION_ZERO_PROVIDER_READINESS_TIMEOUT_MS, 10 * 60_000);
  assert.ok(PRODUCTION_ZERO_PROVIDER_READINESS_TIMEOUT_MS < PRODUCTION_COORDINATOR_TIMEOUT_MS);
  assert.equal(
    PRODUCTION_REMOTE_CELL_TIMEOUT_MS,
    WATCH_SHARD_WORKER_TIMEOUT_MS + WATCH_REMOTE_DISPATCH_AND_RECEIPT_ENVELOPE_MS,
  );
  assert.equal(PRODUCTION_CELL_DOWNLOAD_TIMEOUT_MS, 300_000);
  assert.equal(
    PRODUCTION_COORDINATOR_TIMEOUT_MS,
    PRODUCTION_ZERO_PROVIDER_READINESS_TIMEOUT_MS
      + LIVE_LLM_CELLS.length * (
        PRODUCTION_REMOTE_CELL_TIMEOUT_MS + PRODUCTION_CELL_DOWNLOAD_TIMEOUT_MS
      )
      + PRODUCTION_POST_PREFLIGHT_EVIDENCE_MARGIN_MS,
  );
});

test('remote runtime verification retries transient failures but never accepts a persistent failure', async () => {
  let calls = 0;
  const recovered = await runRemoteJsonWithRetries(async () => {
    calls += 1;
    if (calls < 3) return { exitCode: 1, stdout: '', stderr: 'transient read failure' };
    return { exitCode: 0, stdout: '{"passed":true}\n', stderr: '' };
  }, 'runtime verification', { attempts: 3, delayMs: 0 });
  assert.deepEqual(recovered, { passed: true });
  assert.equal(calls, 3);

  calls = 0;
  await assert.rejects(runRemoteJsonWithRetries(async () => {
    calls += 1;
    return { exitCode: 1, stdout: '', stderr: 'persistent mismatch' };
  }, 'runtime verification', { attempts: 3, delayMs: 0 }), /attempt 3 failed.*persistent mismatch/);
  assert.equal(calls, 3);
});

test('remote failures preserve stdout diagnostics when PowerShell writes no stderr', async () => {
  await assert.rejects(runRemoteJsonWithRetries(async () => ({
    exitCode: 1,
    stdout: 'readiness failure detail\n',
    stderr: '',
  }), 'worker readiness', { attempts: 1, delayMs: 0 }), /readiness failure detail/);
});

function quotePowerShell(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

test('production coordinator rejects a noncanonical authorization root before any callback', async () => {
  const noncanonicalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-noncanonical-root-'));
  let callbackCalls = 0;
  try {
    await assert.rejects(runProductionCoordinator({
      workerConfig: null,
      localIsolationAuthority: 'unused.json',
      coordinatorOutputRoot: noncanonicalRoot,
      operations: {
        prepareCoordinatorExecution: async () => { callbackCalls += 1; },
      },
    }), /canonical coordinator authorization root/);
    assert.equal(callbackCalls, 0);
  } finally {
    fs.rmSync(noncanonicalRoot, { recursive: true, force: true });
  }
});

test('coordinator failure state preserves the primary error through bounded cleanup terminal state', async () => {
  const executionId = `cleanup-state-${crypto.randomUUID()}`;
  const outputRoot = path.join(repoRoot, 'artifacts', 'testing', 'watch-mode-live-coordinator');
  const statePath = path.join(outputRoot, `${executionId}.coordinator-state.json`);
  await assert.rejects(runProductionCoordinator({
    workerConfig: null,
    runtimeAuthority: 'missing-runtime.json',
    localIsolationAuthority: 'missing-local.json',
    executionId,
    coordinatorOutputRoot: outputRoot,
  }));
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(state.stage, 'cleanup-completed');
  assert.ok(state.primaryError?.message);
  assert.deepEqual(state.cleanupErrors, []);
  fs.rmSync(statePath, { force: true });
});

function rawWorkerConfig(root) {
  const defaultProfile = (workerId) => ({
    instanceId: `${workerId}-default`,
    profileId: 'vmware-hda-default',
    deviceClass: 'default-speaker',
    physicalPlaybackDeviceId: '{0.0.0.00000000}.{a609dee5-4ffd-49d6-b7f2-705cfa934363}',
    expectedPhysicalPlaybackDeviceName: '扬声器 (High Definition Audio Device)',
  });
  return {
    schemaVersion: 1,
    artifactKind: PRODUCTION_WORKER_CONFIG_KIND,
    workers: [
      {
        workerId: 'vm1', user: 'VMUser',
        workspaceRoot: 'E:\\watch-worker', guestExecutionRoot: 'E:\\omni-shards',
        vmIdentity: { provider: 'vmware', uuidBios: '56-4d-vm-1' },
        deviceProfileInstances: [defaultProfile('vm1')],
      },
    ],
  };
}

test('production worker config is exact, single-machine, UUID-bound, and has no SSH credentials', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-production-config-'));
  try {
    const raw = rawWorkerConfig(root);
    const parsed = validateProductionWorkerConfig(raw, { configDirectory: root });
    assert.equal(parsed.workers.length, 1);
    assert.deepEqual(parsed.workers.map((worker) => worker.workerId), ['vm1']);
    const additionalWorker = structuredClone(raw);
    additionalWorker.workers.push({ ...structuredClone(raw.workers[0]), workerId: 'vm2' });
    assert.throws(() => validateProductionWorkerConfig(additionalWorker, { configDirectory: root }), /exactly one local worker/);
    const sshField = structuredClone(raw);
    sshField.sshExecutable = 'ssh.exe';
    assert.throws(() => validateProductionWorkerConfig(sshField, { configDirectory: root }), /keys must be exactly/);
    const extraKey = structuredClone(raw);
    extraKey.workers[0].remoteCommand = 'anything';
    assert.throws(() => validateProductionWorkerConfig(extraKey, { configDirectory: root }), /keys must be exactly/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('worker readiness proves driver package and endpoint profiles without a Provider process', () => {
  const source = fs.readFileSync(
    new URL('./run-watch-mode-live-production-coordinator.mjs', import.meta.url),
    'utf8',
  );
  assert.ok(
    AUTHORITY_RUNTIME_BINARY_FILES.includes(
      'drivers/windows-virtual-mic/package/omni-translate-development-driver.cer',
    ),
    'the trust certificate must be hash-bound and distributed with the signed runtime package',
  );
  const elevatedDriverOperation = fs.readFileSync(
    path.join(repoRoot, 'scripts/installer/invoke-elevated-driver-operation.ps1'),
    'utf8',
  );
  assert.match(elevatedDriverOperation, /test-development-driver\.ps1/);
  assert.match(elevatedDriverOperation, /ReadinessResultPath/);
  assert.match(PRODUCTION_WORKER_ZERO_PROVIDER_READINESS_BODY, /artifacts\\tooling\\devcon\.exe/);
  assert.match(PRODUCTION_WORKER_ZERO_PROVIDER_READINESS_BODY, /Resolve-OmniDevconPath/);
  assert.match(PRODUCTION_WORKER_ZERO_PROVIDER_READINESS_BODY, /Test-Path -LiteralPath \$devconCandidate -PathType Leaf/);
  assert.match(PRODUCTION_WORKER_ZERO_PROVIDER_READINESS_BODY, /Resolve-OmniDevconPath @devconArguments/);
  assert.match(PRODUCTION_WORKER_ZERO_PROVIDER_READINESS_BODY, /driver package changed after signed runtime distribution/);
  assert.match(PRODUCTION_WORKER_ZERO_PROVIDER_READINESS_BODY, /packageCertificateHash/);
  assert.match(PRODUCTION_WORKER_ZERO_PROVIDER_READINESS_BODY, /expected\.cerSha256/);
  assert.match(
    PRODUCTION_WORKER_ZERO_PROVIDER_READINESS_BODY,
    /driver trust certificate does not match the signed runtime package signer/,
  );
  assert.match(PRODUCTION_WORKER_ZERO_PROVIDER_READINESS_BODY, /packageMetadata\.signerThumbprint/);
  assert.match(PRODUCTION_WORKER_ZERO_PROVIDER_READINESS_BODY, /request-elevated-driver-operation\.ps1/);
  assert.match(PRODUCTION_WORKER_ZERO_PROVIDER_READINESS_BODY, /Action = 'reinstall'/);
  assert.match(PRODUCTION_WORKER_ZERO_PROVIDER_READINESS_BODY, /Action = 'probe'/);
  assert.match(PRODUCTION_WORKER_ZERO_PROVIDER_READINESS_BODY, /action = 'probe'/);
  assert.match(PRODUCTION_WORKER_ZERO_PROVIDER_READINESS_BODY, /reinstall was skipped/);
  assert.match(PRODUCTION_WORKER_ZERO_PROVIDER_READINESS_BODY, /if \(-not \$authority\) \{/);
  assert.match(PRODUCTION_WORKER_ZERO_PROVIDER_READINESS_BODY, /driverOperation\.elevated -ne \$true/);
  assert.ok(
    PRODUCTION_WORKER_ZERO_PROVIDER_READINESS_BODY.indexOf('Resolve-OmniDevconPath')
      < PRODUCTION_WORKER_ZERO_PROVIDER_READINESS_BODY.indexOf('driver package changed after signed runtime distribution'),
    'DevCon authority must be established before exact package hashing',
  );
  assert.ok(
    PRODUCTION_WORKER_ZERO_PROVIDER_READINESS_BODY.indexOf('driver package changed after signed runtime distribution')
      < PRODUCTION_WORKER_ZERO_PROVIDER_READINESS_BODY.indexOf("Action = 'reinstall'"),
    'signed runtime bytes must be rechecked before the elevated driver repair',
  );
  assert.ok(
    PRODUCTION_WORKER_ZERO_PROVIDER_READINESS_BODY.indexOf("Action = 'reinstall'")
      < PRODUCTION_WORKER_ZERO_PROVIDER_READINESS_BODY.indexOf('$driver = Get-Content -LiteralPath $driverReadinessResultPath'),
    'the exact rebuilt package must be installed before readiness is collected',
  );
  const driverRequiredBranch = PRODUCTION_WORKER_ZERO_PROVIDER_READINESS_BODY.slice(
    PRODUCTION_WORKER_ZERO_PROVIDER_READINESS_BODY.indexOf('if ($driverRequired) {'),
    PRODUCTION_WORKER_ZERO_PROVIDER_READINESS_BODY.indexOf('} else {'),
  );
  const controlStart = PRODUCTION_WORKER_ZERO_PROVIDER_READINESS_BODY.indexOf('$control = [ordered]@{');
  const nonDriverBranch = PRODUCTION_WORKER_ZERO_PROVIDER_READINESS_BODY.slice(
    PRODUCTION_WORKER_ZERO_PROVIDER_READINESS_BODY.lastIndexOf('} else {', controlStart),
    controlStart,
  );
  assert.match(driverRequiredBranch, /request-elevated-driver-operation\.ps1/);
  assert.doesNotMatch(nonDriverBranch, /request-elevated-driver-operation\.ps1|Resolve-OmniDevconPath|Action = 'reinstall'/);
  assert.match(PRODUCTION_WORKER_ZERO_PROVIDER_READINESS_BODY, /installedSysSha256/);
  assert.match(PRODUCTION_WORKER_ZERO_PROVIDER_READINESS_BODY, /packageCatSha256/);
  assert.doesNotMatch(PRODUCTION_WORKER_ZERO_PROVIDER_READINESS_BODY, /omni-physical-output-probe\.exe/);
  assert.match(PRODUCTION_INTERACTIVE_SESSION_LAUNCH_BODY, /invoke-watch-mode-interactive-task\.ps1/);
  assert.match(PRODUCTION_WORKER_READINESS_FINALIZE_BODY, /interactive-readiness\.json/);
  assert.match(PRODUCTION_WORKER_READINESS_FINALIZE_BODY, /\$receipt = \[ordered\]@\{\s*schemaVersion = 2/);
  assert.match(PRODUCTION_WORKER_READINESS_FINALIZE_BODY, /profiles = @\(\$interactive\.profiles\)/);
  assert.match(PRODUCTION_WORKER_READINESS_FINALIZE_BODY, /credentialStatus = \$interactive\.credentialStatus/);
  assert.match(PRODUCTION_WORKER_READINESS_FINALIZE_BODY, /windows-credential-manager/);
  assert.match(PRODUCTION_INTERACTIVE_SESSION_LAUNCH_BODY, /invoke-watch-mode-interactive-task\.ps1/);
  const launcher = fs.readFileSync(
    path.join(repoRoot, 'scripts/testing/run-watch-mode-interactive-task.ps1'),
    'utf8',
  );
  assert.match(launcher, /EntryPoint = "CredEnumerateW"/);
  assert.match(launcher, /ExactSpelling = true/);
  assert.match(launcher, /FindCredential/);
  assert.match(launcher, /CredFree/);
  assert.doesNotMatch(launcher, /\[ref\]\$credentials|\[ref\]\$count/);
  assert.doesNotMatch(launcher, /CredReadW\s*\(/);
  assert.match(launcher, /CredentialBlobSize/);
  assert.match(launcher, /credentialBlobBytes/);
  assert.match(launcher, /blobNonEmpty/);
  assert.match(launcher, /-gt 2560/);
  assert.match(launcher, /credential:\/\/provider\/dashscope\/default/);
  assert.match(launcher, /OmniTranslate:credential___provider_dashscope_default/);
  const control = [
    'invoke-watch-mode-interactive-task.ps1',
    'lib/powershell/Omni.Testing.WatchMode.InteractiveRequest.psm1',
    'lib/powershell/Omni.Testing.WatchMode.InteractiveScheduler.psm1',
  ].map((relativePath) => fs.readFileSync(path.join(repoRoot, 'scripts/testing', relativePath), 'utf8')).join('\n');
  assert.match(control, /expectedCredentialReference = \[string\]\$payload\.expectedCredentialReference/);
  assert.match(control, /\[bool\]\$payload\.requireSeparateControlPlane/);
  assert.match(source, /requireSeparateControlPlane: !isCoordinatorLocalWorker\(worker\)/);
  assert.match(source, /\$launch\.schemaVersion -ne 2/);
  assert.match(control, /taskInfoBeforeStart/);
  assert.match(control, /taskObservedStarted/);
  assert.match(control, /\$taskStateBeforeInfo/);
  assert.match(control, /\$taskStateAfterInfo/);
  assert.match(control, /@\(\$taskStateBeforeInfo, \$taskStateAfterInfo\)/);
  assert.match(control, /if \(\$taskIsActive\) \{ \$successfulTaskExitObservedAt = \$null \}/);
  assert.match(control, /\.State -in @\('Running', 'Queued'\)/);
  assert.match(control, /\$lastTaskResult -ne 0/);
  assert.match(control, /\$terminalVisibilityGraceMilliseconds = 5000/);
  assert.match(control, /completed successfully without publishing terminal authority after the visibility grace period/);
  assert.match(control, /interactive task exited before terminal authority/);
  assert.match(control, /Principal\.UserId -cne \[string\]\$command\.expectedUserSid/);
  assert.doesNotMatch(control, /Principal\.UserId -cne \$expectedSid/);
  assert.match(control, /\$command = \[ordered\]@\{\s*schemaVersion = 2/);
  assert.match(control, /artifactKind = 'watch-mode-interactive-scheduled-task-terminal'[\s\S]*?schemaVersion = 2|schemaVersion = 2[\s\S]*?artifactKind = 'watch-mode-interactive-scheduled-task-terminal'/);
  assert.doesNotMatch(PRODUCTION_WORKER_ZERO_PROVIDER_READINESS_BODY, /omni-desktop-shell|DashScope|providerId/i);
});

test('interactive shard PowerShell emitters use shard authority schema v2', () => {
  const launcher = fs.readFileSync(
    path.join(repoRoot, 'scripts/testing/run-watch-mode-interactive-task.ps1'),
    'utf8',
  );
  const collector = fs.readFileSync(
    path.join(repoRoot, 'scripts/testing/collect-watch-mode-interactive-process-authority.ps1'),
    'utf8',
  );
  assert.match(launcher, /\$request\.schemaVersion -ne 2/);
  for (const kind of [
    'watch-mode-interactive-shard-launch-authority',
    'watch-mode-interactive-shard-claim-release',
  ]) {
    const kindIndex = launcher.indexOf(`artifactKind = '${kind}'`);
    assert.ok(kindIndex >= 0, `${kind} emitter must exist`);
    assert.match(launcher.slice(Math.max(0, kindIndex - 80), kindIndex + 80), /schemaVersion = 2/);
  }
  const shardTerminalIndex = launcher.lastIndexOf("artifactKind = 'watch-mode-interactive-task-terminal'");
  assert.ok(shardTerminalIndex >= 0);
  assert.match(launcher.slice(Math.max(0, shardTerminalIndex - 80), shardTerminalIndex + 80), /schemaVersion = 2/);
  assert.match(collector, /schemaVersion = 2(?:;\s*|\s*\r?\n\s*)artifactKind = 'watch-mode-interactive-process-authority'/);
  assert.match(collector, /for \(\$identityAttempt = 0; \$identityAttempt -lt 4 -and -not \$imagePath;/);
  assert.match(collector, /Get-CimInstance Win32_Process -Filter "ProcessId=\$processId"/);
  assert.match(collector, /\[DateTime\]\$child\.CreationDate -ge \[DateTime\]\$process\.CreationDate/);
  assert.match(collector, /if \(-not \$identityProcess -or -not \(Get-Process -Id \$processId[^\n]+\)\) \{ continue \}/);
  assert.match(collector, /\$executionExitCode -eq 0/);
  assert.match(collector, /interactive cell execution receipt identity mismatch/);
  assert.match(launcher, /'-ExecutionReceiptPath'/);
  assert.match(collector, /\$requiredRoles = @\('shard-node', 'cell-powershell'\)/);
});

test('interactive readiness decodes native UTF-8 endpoint JSON and restores console encoding', { skip: !isWindows }, () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-readiness-utf8-'));
  const emitterPath = path.join(tempRoot, 'emit-endpoint-json.mjs');
  const launcherPath = path.join(repoRoot, 'scripts/testing/run-watch-mode-interactive-task.ps1');
  const endpointName = '扬声器 (High Definition Audio Device)';
  fs.writeFileSync(
    emitterPath,
    `process.stdout.write(JSON.stringify({ passed: true, resolvedPhysicalPlaybackDeviceName: ${JSON.stringify(endpointName)} }));\n`,
    'utf8',
  );
  const command = [
    '$tokens = $null',
    '$errors = $null',
    `$ast = [System.Management.Automation.Language.Parser]::ParseFile(${quotePowerShell(launcherPath)}, [ref]$tokens, [ref]$errors)`,
    "if (@($errors).Count -ne 0) { throw 'launcher parse failed' }",
    "$function = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-Utf8JsonProcess' }, $true))",
    "if ($function.Count -ne 1) { throw 'UTF-8 JSON helper is missing or duplicated' }",
    '. ([scriptblock]::Create($function[0].Extent.Text))',
    '$original = [Console]::OutputEncoding',
    '[Console]::OutputEncoding = [Text.Encoding]::GetEncoding(936)',
    '$before = [Console]::OutputEncoding.CodePage',
    `$result = Invoke-Utf8JsonProcess -FilePath ${quotePowerShell(process.execPath)} -ArgumentList @(${quotePowerShell(emitterPath)}) -FailureContext 'UTF-8 fixture failed'`,
    '$nameBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$result.resolvedPhysicalPlaybackDeviceName))',
    '$encodingRestored = ([Console]::OutputEncoding.CodePage -eq $before)',
    '[Console]::OutputEncoding = $original',
    '[ordered]@{ nameBase64 = $nameBase64; encodingRestored = $encodingRestored; exercisedCodePage = $before } | ConvertTo-Json -Compress',
  ].join('; ');
  try {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const evidence = JSON.parse(result.stdout.trim());
    assert.equal(evidence.nameBase64, Buffer.from(endpointName, 'utf8').toString('base64'));
    assert.equal(evidence.encodingRestored, true);
    assert.equal(evidence.exercisedCodePage, 936);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('interactive control projects readiness and paid-cell fields only inside their exact mode', () => {
  const control = [
    'invoke-watch-mode-interactive-task.ps1',
    'lib/powershell/Omni.Testing.WatchMode.InteractiveRequest.psm1',
    'lib/powershell/Omni.Testing.WatchMode.InteractiveScheduler.psm1',
  ].map((relativePath) => fs.readFileSync(path.join(repoRoot, 'scripts/testing', relativePath), 'utf8')).join('\n');
  assert.match(control, /\$mode -notin @\('endpoint-readiness', 'shard-cell', 'incident-plus-cell'\)/);
  const commandStart = control.indexOf('$command = [ordered]@{');
  const commandEnd = control.indexOf('Write-OmniImmutableJson -LiteralPath $commandPath -Value $command');
  assert.ok(commandStart >= 0 && commandEnd > commandStart);
  const commandProjection = control.slice(commandStart, commandEnd);
  assert.doesNotMatch(
    commandProjection,
    /\$payload\.(?:leaseId|leaseDigest|cellId|feedbackLoopPrevention|planPath|planSha256|leasePath|leaseSha256|readinessPath|readinessRequestDigest|profiles|probeExecutable|bridgeExecutable)/,
  );
  for (const field of [
    'leaseId',
    'leaseDigest',
    'cellId',
    'feedbackLoopPrevention',
    'planPath',
    'planSha256',
    'leasePath',
    'leaseSha256',
    'readinessPath',
  ]) {
    assert.equal(
      control.match(new RegExp(`\\$payload\\.${field}`, 'g'))?.length,
      1,
      `${field} must be read only while projecting a shard-cell request`,
    );
  }
  assert.equal(
    control.match(/\$payload\.readinessRequestPath/g)?.length,
    1,
    'incident-plus-cell must read its additional readiness request only while projecting the signed cell request',
  );
  for (const field of ['readinessRequestDigest', 'profiles', 'probeExecutable', 'bridgeExecutable']) {
    assert.equal(
      control.match(new RegExp(`\\$payload\\.${field}`, 'g'))?.length,
      1,
      `${field} must be read only while projecting endpoint readiness`,
    );
  }
  assert.match(control, /if \(\$mode -in @\('shard-cell', 'incident-plus-cell'\)\) \{[\s\S]*?\$taskTerminal\['leaseId'\]/);
  assert.match(control, /Export-ScheduledTask -TaskPath \$taskPath -TaskName \$taskName/);
  assert.match(control, /recordedXml\.Task\.Principals\.Principal\.UserId -cne \[string\]\$command\.expectedUserSid/);
  assert.match(control, /recordedXml\.Task\.Principals\.Principal\.LogonType -cne 'InteractiveToken'/);
  assert.ok(
    control.indexOf('Omni.Testing.Process.psm1') < control.lastIndexOf('Omni.Testing.IO.psm1'),
    'interactive control must re-import IO after Process so Get-OmniSha256 remains exported',
  );
  assert.doesNotMatch(control, /recorded\.Principal\.UserId -cne \[string\]\$command\.expectedUserId/);
  assert.doesNotMatch(control, /recorded\.Principal\.LogonType -cne 'InteractiveToken'/);
});

test('production coordinator verifies a prebuilt runtime and never rebuilds it', () => {
  const source = fs.readFileSync(
    path.join(repoRoot, 'scripts/testing/run-watch-mode-live-production-coordinator.mjs'),
    'utf8',
  );
  assert.match(source, /verifyStrictRuntimeAuthority/);
  assert.doesNotMatch(source, /buildStrictRuntimeAuthority/);
  assert.match(source, /PROVIDER_PREFLIGHT_AUTHORIZATION_DIGEST_ENV/);
  assert.match(source, /PROVIDER_PREFLIGHT_GRANT_PATH_ENV/);
});

test('remote PowerShell uses a compressed encoded command without SSH stdin', () => {
  const marker = 'runtime-entry-marker-'.padEnd(128, 'x');
  const invocation = remotePowerShellInvocation(
    '[pscustomobject]@{ count = @($payload.entries).Count } | ConvertTo-Json -Compress',
    {
      localizedName: '扬声器 (High Definition Audio Device)',
      entries: Array.from({ length: 256 }, (_, index) => ({
        path: `target/release/runtime-${index}.exe`,
        sha256: marker,
      })),
    },
  );
  assert.equal(invocation.input, '');
  assert.ok(invocation.args.join(' ').length < 32_768);
  assert.equal(invocation.args.includes('-EncodedCommand'), true);
  assert.equal(invocation.args.join(' ').includes(marker), false);
  const bootstrap = Buffer.from(invocation.args.at(-1), 'base64').toString('utf16le');
  const compressedMatch = bootstrap.match(/FromBase64String\('([^']+)'\)/);
  assert.ok(compressedMatch);
  const streamedSource = zlib.gunzipSync(Buffer.from(compressedMatch[1], 'base64')).toString('utf8');
  const payloadMatch = streamedSource.match(/FromBase64String\('([^']+)'\)/);
  assert.ok(payloadMatch);
  const streamedPayload = JSON.parse(Buffer.from(payloadMatch[1], 'base64').toString('utf8'));
  assert.equal(streamedPayload.entries.length, 256);
  assert.equal(streamedPayload.entries[0].sha256, marker);
  assert.equal(streamedPayload.localizedName, '扬声器 (High Definition Audio Device)');
  assert.match(streamedSource, /Console\]::OutputEncoding = \[Text\.UTF8Encoding\]::new\(\$false\)/);
  assert.match(streamedSource, /\$OutputEncoding = \[Console\]::OutputEncoding/);
  assert.doesNotMatch(streamedSource, /__OMNI_REMOTE_COMPLETE_V1__/);
  assert.match(bootstrap, /GZipStream/);
  assert.match(bootstrap, /ReadToEnd/);
  assert.match(bootstrap, /ScriptBlock/);
  assert.match(bootstrap, /__OMNI_REMOTE_COMPLETE_V1__/);
  assert.doesNotMatch(bootstrap, /(?:^|[;{}]\s*)exit\s+[01](?:\s*[;} ]|$)/u);
  assert.match(bootstrap, /\[Console\]::Out\.Flush\(\); \[Environment\]::Exit\(0\)/);
  assert.match(bootstrap, /\[Console\]::Error\.Flush\(\); \[Environment\]::Exit\(1\)/);
  assert.match(invocation.fileScript, /\$payloadJson =/);
  assert.match(invocation.fileScript, /^Import-Module Microsoft\.PowerShell\.Security -ErrorAction Stop/m);
  assert.match(invocation.fileScript, /ConvertTo-Json -Compress/);
  assert.match(invocation.fileScript, /__OMNI_REMOTE_COMPLETE_V1__/);
  assert.doesNotMatch(invocation.fileScript, /ScriptBlock|GZipStream/);
  assert.match(invocation.fileScript, /\$omniRemoteOutput = @\(/);
  assert.match(invocation.fileScript, /ToBase64String/);
  assert.match(invocation.fileScript, /__OMNI_REMOTE_OUTPUT_V1__/);
  assert.match(invocation.fileScript, /offset \+= 160/);
  assert.match(invocation.fileScript, /Console\]::Out\.WriteLine/);
  assert.doesNotMatch(invocation.fileScript, /try \{|exit [01]/);
});

test('remote PowerShell file output reconstructs framed payloads larger than 256 bytes', () => {
  const payload = JSON.stringify({ entries: Array.from({ length: 12 }, (_, index) => ({
    path: `target/release/runtime-${index}.exe`,
    sha256: 'a'.repeat(64),
  })) });
  assert.ok(Buffer.byteLength(payload, 'utf8') > 256);
  const encoded = Buffer.from(payload, 'utf8').toString('base64');
  const frames = encoded.match(/.{1,160}/gu).map((frame) => `__OMNI_REMOTE_OUTPUT_V1__${frame}`);
  const decoded = decodeRemotePowerShellFileOutput({
    exitCode: 0,
    stdout: `${frames.join('\r\n')}\r\n__OMNI_REMOTE_COMPLETE_V1__\r\n`,
    stderr: '',
  });
  assert.equal(decoded.exitCode, 0);
  assert.equal(decoded.stdout, `${payload}\n__OMNI_REMOTE_COMPLETE_V1__\n`);
});

test('local Windows PowerShell excludes PowerShell 7 module roots', () => {
  const environment = windowsPowerShellEnvironment({
    WINDIR: 'C:\\Windows',
    ProgramFiles: 'C:\\Program Files',
    USERPROFILE: 'C:\\Users\\VMUser',
    PSModulePath: 'C:\\Program Files\\PowerShell\\Modules;C:\\Codex\\Modules',
  });
  assert.equal(
    environment.PSModulePath,
    'C:\\Users\\VMUser\\Documents\\WindowsPowerShell\\Modules;C:\\Program Files\\WindowsPowerShell\\Modules;C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
  );
  assert.doesNotMatch(environment.PSModulePath, /\\Program Files\\PowerShell\\Modules/);
});

test('remote PowerShell hashes files without module auto-loading', { skip: !isWindows }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-remote-hash-'));
  const target = path.join(root, 'input.bin');
  fs.writeFileSync(target, 'single-machine-runtime-authority', 'utf8');
  const expected = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
  const invocation = remotePowerShellInvocation(
    '$PSModuleAutoLoadingPreference = "None"; (Get-FileHash -LiteralPath ([string]$payload.path) -Algorithm SHA256).Hash.ToLowerInvariant()',
    { path: target },
  );
  try {
    const result = spawnSync(invocation.args[0], invocation.args.slice(1), {
      input: invocation.input,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0], expected);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('preserved worker readiness is decoded as UTF-8 and returned as one compact JSON line', { skip: !isWindows }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-preserved-readiness-'));
  const readinessRoot = path.join(root, 'readiness');
  fs.mkdirSync(readinessRoot, { recursive: true });
  const readiness = {
    artifactKind: 'watch-mode-production-worker-zero-provider-readiness',
    workerId: 'vm1-default',
    providerCalls: 0,
    profiles: [{ resolvedDeviceName: '扬声器 (High Definition Audio Device)' }],
  };
  fs.writeFileSync(
    path.join(readinessRoot, 'zero-provider-readiness.json'),
    `${JSON.stringify(readiness, null, 2)}\n`,
    'utf8',
  );
  const invocation = remotePowerShellInvocation(
    PRODUCTION_PRESERVED_WORKER_READINESS_BODY,
    { remoteRoot: root },
  );
  try {
    const result = spawnSync(invocation.args[0], invocation.args.slice(1), {
      input: invocation.input,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const nonEmptyLines = result.stdout.split(/\r?\n/)
      .filter((line) => line.trim() && line.trim() !== '__OMNI_REMOTE_COMPLETE_V1__');
    assert.equal(nonEmptyLines.length, 1);
    assert.deepEqual(JSON.parse(nonEmptyLines[0]), readiness);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('interactive remote wrapper accepts a successful PowerShell control with no native exit code', { skip: !isWindows }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-control-exit-'));
  const scriptsRoot = path.join(root, 'scripts', 'testing');
  const controlPath = path.join(scriptsRoot, 'invoke-watch-mode-interactive-task.ps1');
  fs.mkdirSync(scriptsRoot, { recursive: true });
  fs.writeFileSync(controlPath, [
    'param([Parameter(Mandatory = $true)][string]$PayloadBase64)',
    "$decoded = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PayloadBase64)) | ConvertFrom-Json",
    "[ordered]@{ status = 'passed'; marker = [string]$decoded.marker } | ConvertTo-Json -Compress",
  ].join('\n'), 'utf8');
  const invocation = remotePowerShellInvocation(PRODUCTION_INTERACTIVE_SESSION_LAUNCH_BODY, {
    workspaceRoot: root,
    controlScriptSha256: crypto.createHash('sha256').update(fs.readFileSync(controlPath)).digest('hex'),
    interactiveRequest: { marker: 'script-success-with-null-last-exit-code' },
  });
  try {
    const result = spawnSync(invocation.args[0], invocation.args.slice(1), {
      input: invocation.input,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const evidence = JSON.parse(result.stdout.split(/\r?\n/)
      .filter((line) => line.trim() && line.trim() !== '__OMNI_REMOTE_COMPLETE_V1__').join('\n'));
    assert.equal(evidence.status, 'passed');
    assert.equal(evidence.marker, 'script-success-with-null-last-exit-code');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('SSH transport finalizes manifests in the guest and cancellation is task/launch-authority bound', () => {
  const source = fs.readFileSync(
    path.join(repoRoot, 'scripts/testing/run-watch-mode-live-production-coordinator.mjs'),
    'utf8',
  );
  assert.match(source, /--finalize-worker-request/);
  assert.match(source, /watch-mode-worker-shard-finalization-request/);
  assert.match(source, /validateShardManifest\(\{/);
  assert.doesNotMatch(source, /writeShardManifest\s*\(/);
  assert.doesNotMatch(source, /LEGACY_PRODUCTION_/);
  assert.doesNotMatch(source, /encodedPowerShell/);
  assert.match(source, /isCoordinatorLocalWorker\(worker\)/);
  assert.match(source, /`local-command-\$\{crypto\.randomBytes\(12\)/);
  assert.match(source, /runProcess\('powershell\.exe', \[/);
  assert.match(source, /'-File', localScriptPath/);
  assert.match(source, /environment: windowsPowerShellEnvironment\(processOptions\.environment \?\? process\.env\)/);
  assert.match(source, /decodeRemotePowerShellFileOutput\(localResult\)/);
  assert.match(source, /cwd: worker\.workspaceRoot/);
  assert.match(source, /requireControlPlane = false/);
  assert.match(source, /requireControlPlane: true/);
  assert.match(source, /fs\.writeFileSync\(localScriptPath, invocation\.fileScript, 'utf8'\)/);
  assert.match(source, /'-File', remoteScriptPath/);
  assert.match(source, /Remove-Item -LiteralPath '\$\{remoteScriptPath\}' -Force/);
  assert.match(source, /fs\.copyFileSync\(localPath, remotePath\)/);
  assert.match(source, /fs\.cpSync\(remotePath, localDestination/);
  assert.match(source, /executeRemote: runRemote/);
  assert.match(source, /uploadFile: upload/);
  assert.doesNotMatch(source, /production three-VM strict evidence/);
  assert.match(source, /Get-ScheduledTask -TaskPath \$taskPath -TaskName \$taskName/);
  assert.match(source, /Stop-ScheduledTask -TaskPath \$taskPath -TaskName \$taskName/);
  assert.match(source, /Unregister-ScheduledTask -TaskPath \$taskPath -TaskName \$taskName/);
  assert.match(source, /launch\.nodeProcess\.startedAt/);
  assert.match(source, /launch\.nodeProcess\.imageSha256/);
  assert.match(source, /launch\.nodeProcess\.imagePath/);
  assert.doesNotMatch(source, /logs\\\\" \+ \[string\]\$payload\.leaseId \+ '\\.pid'/);
});

test('production coordinator drives four signed serial waves through stage, verify, and publish', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-production-orchestrator-'));
  const config = rawWorkerConfig(root);
  const normalized = validateProductionWorkerConfig(config, { configDirectory: root });
  const profilesByWorker = new Map(normalized.workers.map((worker) => [
    worker.workerId,
    new Map(worker.deviceProfileInstances.map((profile) => [profile.deviceClass, profile])),
  ]));
  const placements = LIVE_LLM_CELLS.map((_, index) => ['vm1', index]);
  const cells = LIVE_LLM_CELLS.map((cell, index) => {
    const [workerId, waveIndex] = placements[index];
    return {
      ...cell,
      cellIndex: index,
      workerId,
      waveIndex,
      leaseId: `lease-${index}`,
      vmIdentityDigest: '1'.repeat(64),
      deviceProfileInstance: profilesByWorker.get(workerId).get(cell.deviceClass),
    };
  });
  const plan = {
    executionId: 'production-test-execution',
    provenance: CLEAN_PROVENANCE,
    authority: { runtimeBinaryHashes: [] },
    localIsolationAuthority: { manifestPath: 'local.json', path: 'local.json', bytes: 1, sha256: 'b'.repeat(64), providerCalls: 0 },
    workers: normalized.workers.map(({ workerId, vmIdentity, deviceProfileInstances }) => ({ workerId, vmIdentity, deviceProfileInstances })),
    cells,
    waves: cells.map((_, waveIndex) => ({
      waveIndex,
      cellIds: cells.filter((cell) => cell.waveIndex === waveIndex).map((cell) => cell.cellId),
    })),
  };
  const leases = cells.map((cell) => ({ leaseId: cell.leaseId, cellId: cell.cellId }));
  const runDirectories = cells.map((cell, index) => {
    const directory = path.join(root, 'staged', `cell-${index}`);
    fs.mkdirSync(directory, { recursive: true });
    return directory;
  });
  const calls = [];
  const signingKeys = generateCoordinatorSigningKeyPair();
  const publicKeyPath = path.join(root, 'coordinator-signing-public.pem');
  const privateKeyPath = path.join(root, 'coordinator-signing-private.pem');
  fs.writeFileSync(publicKeyPath, signingKeys.publicKeyPem);
  fs.writeFileSync(privateKeyPath, signingKeys.privateKeyPem);
  try {
    const result = await runProductionCoordinator({
      workerConfig: config,
      runtimeAuthority: 'runtime.json',
      localIsolationAuthority: 'local.json',
      coordinatorOutputRoot: path.join(
        repoRoot,
        'artifacts',
        'testing',
        'watch-mode-live-coordinator',
      ),
      evidenceOutputRoot: path.join(root, 'evidence'),
      operations: {
        verifyRuntimeAuthority: async () => ({
          authorityPath: path.join(root, 'strict-runtime-authority.json'),
          authority: {
            authorityDigest: 'f'.repeat(64),
            releaseId: 'watch-test-release',
            runtimeBinaryHashes: [],
            coordinatorSigning: {
              algorithm: 'Ed25519',
              keyId: coordinatorKeyIdForPublicKey(signingKeys.publicKeyPem),
              publicKeyAuthority: fileAuthorityEntry(publicKeyPath, path.basename(publicKeyPath)),
              privateKeyAuthority: fileAuthorityEntry(privateKeyPath, path.basename(privateKeyPath)),
            },
          },
        }),
        runZeroProviderWorkerReadiness: async (context) => {
          calls.push('zero-provider-readiness');
          fs.mkdirSync(context.executionRoot, { recursive: true });
          const workerReadinessRequest = createWorkerReadinessRequest(context);
          const requestPath = path.join(context.executionRoot, 'worker-readiness-request.json');
          fs.writeFileSync(requestPath, JSON.stringify(workerReadinessRequest));
          return {
            workerReadinessRequest,
            requestAuthority: fileAuthorityEntry(requestPath, 'worker-readiness-request.json'),
            workers: context.workers.map((worker) => ({ workerId: worker.workerId, providerCalls: 0 })),
          };
        },
        runProviderPreflight: async () => {
          calls.push('provider-preflight');
          return {
            providerId: 'provider-dashscope',
            operation: 'text-translation-preflight',
            inputMode: 'text-only',
            providerInvocationCount: 1,
            externalAudioSamples: 0,
            status: 'completed',
            evidenceDirectory: path.join(root, 'unused-preflight'),
          };
        },
        prepareCoordinatorExecution: async (options) => {
          calls.push('prepare');
          assert.deepEqual(options.signingKeys, signingKeys);
          assert.equal(typeof options.buildRuntimeAuthority, 'function');
          assert.equal(typeof options.runProviderPreflight, 'function');
          assert.equal(typeof options.runZeroProviderWorkerReadiness, 'function');
          assert.equal(
            options.minimumRemainingExecutionMs,
            LIVE_LLM_CELLS.length * (
              PRODUCTION_REMOTE_CELL_TIMEOUT_MS + PRODUCTION_CELL_DOWNLOAD_TIMEOUT_MS
            )
              + PRODUCTION_POST_PREFLIGHT_EVIDENCE_MARGIN_MS,
          );
          const workerReadiness = await options.runZeroProviderWorkerReadiness({
            executionId: plan.executionId,
            executionRoot: path.join(root, 'execution'),
            generatedAt: new Date(),
            provenance: CLEAN_PROVENANCE,
            runtimeBinaryHashes: [{ path: 'runtime/a.exe', bytes: 1, sha256: 'a'.repeat(64) }],
            workers: plan.workers,
            assignments: plan.cells.map((cell) => ({
              cellId: cell.cellId,
              workerId: cell.workerId,
              waveIndex: cell.waveIndex,
              deviceProfileInstanceId: cell.deviceProfileInstance.instanceId,
            })),
          });
          await options.runProviderPreflight({ provenance: CLEAN_PROVENANCE });
          plan.workerReadinessRequest = workerReadiness.workerReadinessRequest;
          return {
            plan,
            leases,
            leasePaths: cells.map((_, index) => path.join(root, `lease-${index}.json`)),
            planPath: path.join(root, 'plan.json'),
            executionRoot: path.join(root, 'execution'),
          };
        },
        createTransport: async () => ({
          prepareWorker: async ({ worker }) => { calls.push(`ready:${worker.workerId}`); },
          dispatchCell: async ({ cell }) => {
            calls.push(`paid:${cell.cellIndex}`);
            return { result: { verdict: 'passed', resultDigest: String(cell.cellIndex).repeat(64), runDirectory: `runs/${cell.cellIndex}` } };
          },
          cancelCell: async () => {},
          collectWorker: async ({ worker }) => ({ workerId: worker.workerId, shardRoot: path.join(root, worker.workerId), manifestPath: path.join(root, `${worker.workerId}.json`) }),
        }),
        runCoordinatorWaves: async ({ plan: signedPlan, assertWorkerReady, dispatchCell }) => {
          for (const worker of signedPlan.workers) await assertWorkerReady({ worker });
          const results = new Map();
          for (const wave of signedPlan.waves) {
            calls.push(`wave:${wave.waveIndex}`);
            await Promise.all(wave.cellIds.map(async (cellId) => {
              const cell = signedPlan.cells.find((entry) => entry.cellId === cellId);
              const outcome = await dispatchCell({ cell, lease: leases[cell.cellIndex], signal: new AbortController().signal });
              results.set(cellId, outcome);
            }));
          }
          return {
            results,
            startedCellIds: signedPlan.cells.map((cell) => cell.cellId),
            completedCellIds: signedPlan.cells.map((cell) => cell.cellId),
            collectedFailures: [],
          };
        },
        writeCoordinatorAggregate: () => ({
          aggregatePath: path.join(root, 'aggregate.json'),
          matrixIntegration: { cells: [] },
        }),
        stageShardMatrixIntegration: () => {
          const finalExecutionRoot = path.join(root, 'evidence', 'staged');
          fs.mkdirSync(finalExecutionRoot, { recursive: true });
          return {
            runDirectories,
            shardExecution: { executionRoot: 'staged' },
            matrixIntegration: { cells },
            finalExecutionRoot,
          };
        },
        assertCellExternalProviderBudget: (_directory, expected) => ({
          passed: true,
          cellId: expected.cellId,
          modelId: expected.modelId,
          feedbackLoopPrevention: expected.feedbackLoopPrevention,
          actualProviderInputSamples: 1,
          providerSendBoundary: { leaseId: cells.find((cell) => cell.cellId === expected.cellId).leaseId },
          calls: { sourceTranscript: 0, physicalOutputStt: 0, secondaryTranslation: 0, secondaryTts: 0 },
        }),
        writeMatrixExternalProviderBudget: (outputRoot) => {
          fs.mkdirSync(outputRoot, { recursive: true });
          const filePath = path.join(outputRoot, 'budget.json');
          fs.writeFileSync(filePath, '{"passed":true}\n', 'utf8');
          return { filePath, ledger: { passed: true } };
        },
        writeMatrixRunManifest: () => {
          calls.push('write-manifest');
          return { manifestPath: path.join(root, 'manifest.json') };
        },
        runVerifier: async () => { calls.push('verify'); return { status: 0 }; },
        publishSuccessfulStrictMatrixManifest: () => {
          calls.push('publish');
          return { canonicalPath: path.join(root, 'canonical.json') };
        },
      },
    });
    assert.deepEqual(
      calls.filter((entry) => entry.startsWith('wave:')),
      LIVE_LLM_CELLS.map((_, index) => `wave:${index}`),
    );
    assert.ok(calls.indexOf('zero-provider-readiness') < calls.indexOf('provider-preflight'));
    assert.equal(calls.filter((entry) => entry.startsWith('paid:')).length, LIVE_LLM_CELLS.length);
    assert.ok(calls.indexOf('verify') < calls.indexOf('publish'));
    assert.equal(result.workerCount, 1);
    assert.equal(result.waveCount, LIVE_LLM_CELLS.length);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('coordinator CLI exposes only the production config, local receipt, and output roots', () => {
  const parsed = parseProductionCoordinatorCliArgs([
    '--workers-config', 'workers.json',
    '--runtime-authority', 'strict-runtime-authority.json',
    '--local-isolation-authority', 'local-isolation-manifest.json',
    '--execution-id', 'fixed-execution',
  ]);
  assert.equal(parsed.workersConfig, 'workers.json');
  assert.equal(parsed.runtimeAuthority, 'strict-runtime-authority.json');
  assert.equal(parsed.localIsolationAuthority, 'local-isolation-manifest.json');
  assert.equal(parsed.executionId, 'fixed-execution');
  assert.throws(() => parseProductionCoordinatorCliArgs(['--remote-command', 'whoami']), /Unknown flag/);
});
