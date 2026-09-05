import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import zlib from 'node:zlib';
import test from 'node:test';

test('interactive finalizer binds workspace cwd and preserves complete native failures', { skip: process.platform !== 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-finalizer-cwd-'));
  const workspace = path.join(root, 'workspace');
  const wrongCwd = path.join(root, 'ssh-home');
  fs.mkdirSync(path.join(workspace, 'contracts'), { recursive: true });
  fs.mkdirSync(wrongCwd);
  fs.writeFileSync(path.join(workspace, 'contracts', 'fixture.json'), '{"marker":"workspace-contract"}');
  const runner = path.join(workspace, 'runner.mjs');
  fs.writeFileSync(runner, [
    "import fs from 'node:fs';",
    "const contract = JSON.parse(fs.readFileSync('contracts/fixture.json', 'utf8'));",
    "if (process.argv.at(-1) === 'fail') { console.error('first-native-error'); console.error('last-native-error'); process.exitCode = 7; }",
    "else { console.error('nonfatal-warning'); console.log(contract.marker); console.log(process.argv[1]); }",
  ].join('\n'));
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  const harness = path.join(root, 'harness.ps1');
  fs.writeFileSync(harness, [
    'param([string]$Workspace,[string]$Node,[string]$Runner,[string]$Request)',
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
    `Import-Module ${quote(path.join(repoRoot, 'scripts/testing/lib/powershell/Omni.Testing.WatchMode.InteractiveScheduler.psm1'))} -Force`,
    "$module = Get-Module Omni.Testing.WatchMode.InteractiveScheduler",
    '$before = (Get-Location).Path',
    '$message = $null; $output = $null; $resultExists = $false',
    'try { $result = & $module { param($w,$n,$r,$q) Invoke-OmniInteractiveFinalizer -WorkspaceRoot $w -NodeExecutable $n -RunnerPath $r -RequestPath $q } $Workspace $Node $Runner $Request; $output = $result.output }',
    'catch { $message = $_.Exception.Message }',
    'if ($output) { $resultPath = [string](@($output | Where-Object { $_ } | Select-Object -Last 1)[0]); $resultExists = Test-Path -LiteralPath $resultPath -PathType Leaf }',
    '[ordered]@{before=$before;after=(Get-Location).Path;preference=[string]$ErrorActionPreference;message=$message;output=$output;resultExists=$resultExists}|ConvertTo-Json -Compress',
  ].join('\n'), 'utf8');
  const invoke = (workspacePath, request, node = process.execPath) => {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', harness, workspacePath, node, runner, request], {
      cwd: wrongCwd, encoding: 'utf8', timeout: 30_000, windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout.trim());
    assert.equal(receipt.before, receipt.after);
    assert.equal(receipt.preference, 'Stop');
    return receipt;
  };
  try {
    const old = spawnSync(process.execPath, [runner, 'ok'], { cwd: wrongCwd, encoding: 'utf8', timeout: 30_000 });
    assert.notEqual(old.status, 0);
    assert.match(old.stderr, /ENOENT.*contracts[\\/]fixture.json/);
    const good = invoke(workspace, 'ok');
    assert.equal(good.message, null);
    assert.deepEqual(good.output, ['workspace-contract', runner]);
    assert.equal(good.resultExists, true);
    const failed = invoke(workspace, 'fail');
    assert.match(failed.message, /exitCode=7.*first-native-error.*last-native-error/s);
    assert.match(invoke('relative-workspace', 'ok').message, /workspace must be absolute/);
    assert.ok(invoke(workspace, 'ok', path.join(root, 'missing.exe')).message);
    const noExitStatus = path.join(root, 'no-exit-status.ps1');
    fs.writeFileSync(noExitStatus, "Write-Output 'no-native-status'", 'utf8');
    assert.ok(invoke(workspace, 'ok', noExitStatus).message);
    const junction = path.join(root, 'alias');
    fs.symlinkSync(workspace, junction, 'junction');
    assert.match(invoke(junction, 'ok').message, /non-reparse directory/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

import { repoRoot } from '../lib/testing-common.mjs';
import { LIVE_LLM_CELLS } from './watch-mode-balanced-release-plan.mjs';
import {
  AUTHORITY_IMPLEMENTATION_FILES,
  AUTHORITY_RUNTIME_BINARY_FILES,
} from './watch-mode-evidence-authority.mjs';
import {
  deriveWatchPostReadinessExecutionBudgetMs,
  deriveWatchProductionInitialWorkerReadinessBudgetMs,
  deriveWatchProductionPrepaidCoordinatorBudgetMs,
  deriveWatchProductionProviderPreflightBudgetMs,
  deriveWatchProductionInteractiveCellTimeoutMs,
  deriveWatchProductionRemoteCellTimeoutMs,
} from './watch-mode-release-timeout-budget.mjs';
import {
  coordinatorKeyIdForPublicKey,
  createWorkerReadinessRequest,
  fileAuthorityEntry,
  generateCoordinatorSigningKeyPair,
} from './watch-mode-shard-authority.mjs';
import {
  assertProductionCoordinatorWaveBudget,
  PRODUCTION_WORKER_CONFIG_KIND,
  PRODUCTION_CELL_DOWNLOAD_TIMEOUT_MS,
  PRODUCTION_CELL_LEASE_UPLOAD_TIMEOUT_MS,
  PRODUCTION_COORDINATOR_TIMEOUT_MS,
  PRODUCTION_INTERACTIVE_SESSION_LAUNCH_BODY,
  PRODUCTION_PRESERVED_WORKER_READINESS_BODY,
  PRODUCTION_ZERO_PROVIDER_READINESS_TIMEOUT_MS,
  PRODUCTION_WORKER_READINESS_FINALIZE_BODY,
  PRODUCTION_WORKER_ZERO_PROVIDER_READINESS_BODY,
  parseProductionCoordinatorCliArgs,
  aggregateProductionCellFailures,
  assertProductionCellsPassedForCanonicalVerification,
  productionCellFailureDisposition,
  productionFailureFingerprint,
  remotePowerShellInvocation,
  runBoundedCoordinatorStage,
  runBoundedCoordinatorStageWithinDeadline,
  runKillableCoordinatorProcessStage,
  decodeRemotePowerShellFileOutput,
  runChildProcess,
  runProductionEvidenceVerifier,
  createProductionWorkerReadinessTransportPlan,
  runRemoteJsonWithRetries,
  PRODUCTION_REMOTE_RUNTIME_VERIFICATION_TIMEOUT_MS,
  PRODUCTION_REMOTE_READINESS_FINALIZATION_TIMEOUT_MS,
  runProductionCoordinator,
  scpBaseArgs,
  sshBaseArgs,
  validateProductionWorkerConfig,
  windowsPowerShellEnvironment,
  createSshProductionTransport,
} from './run-watch-mode-live-production-coordinator.mjs';

test('a same-thread synchronous blocker cannot resolve after its bounded coordinator deadline', async () => {
  await assert.rejects(
    runBoundedCoordinatorStage(() => {
      const blockedUntilMs = Date.now() + 80;
      while (Date.now() < blockedUntilMs) {
        // Reproduce a synchronous filesystem/hash stage that starves the timer.
      }
      return 'late-success';
    }, 'synchronous coordinator blocker', 10),
    /synchronous coordinator blocker timed out after 10ms/u,
  );
});

test('a killable coordinator process stage terminates a synchronous blocker at the absolute deadline', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-killable-coordinator-stage-'));
  const lateMarker = path.join(root, 'late-marker.txt');
  try {
    await assert.rejects(
      runKillableCoordinatorProcessStage({
        stageLabel: 'runtime-authority-before-verifier',
        executable: process.execPath,
        args: [
          '-e',
          'const fs=require("node:fs");const end=Date.now()+200;while(Date.now()<end){};fs.writeFileSync(process.argv[1],"late");',
          lateMarker,
        ],
        deadlineMs: Date.now() + 30,
      }),
      /runtime-authority-before-verifier timed out after .* shared coordinator deadline/u,
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(fs.existsSync(lateMarker), false, 'the killed blocker must not perform a late write');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('killable coordinator stages use the smaller of stage ceiling and shared absolute deadline', async () => {
  const calls = [];
  await runKillableCoordinatorProcessStage({
    stageLabel: 'final-evidence-staging',
    executable: process.execPath,
    deadlineMs: 1_050,
    maximumTimeoutMs: 500,
    deadlineNow: () => 1_000,
    runProcess: async (_executable, _args, options) => {
      calls.push(options.timeoutMs);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });
  assert.deepEqual(calls, [50]);
});

test('killable coordinator child failures retain the exact finalization stage', async () => {
  await assert.rejects(
    runKillableCoordinatorProcessStage({
      stageLabel: 'canonical-manifest-publication',
      executable: process.execPath,
      deadlineMs: 2_000,
      deadlineNow: () => 1_000,
      runProcess: async () => ({ exitCode: 7, stdout: '', stderr: 'fixture publication failed' }),
    }),
    /canonical-manifest-publication child failed with exit 7: fixture publication failed/u,
  );
});

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

test('failed production cells stop after final staging and retain the staged failure authority', () => {
  const manifestPath = 'E:\\evidence\\failed-matrix.json';
  assert.doesNotThrow(() => assertProductionCellsPassedForCanonicalVerification({
    failureSummary: { failed: [] },
    manifestPath,
  }));
  for (const failureSummary of [null, {}, { failed: 'c03' }]) {
    assert.throws(() => assertProductionCellsPassedForCanonicalVerification({
      failureSummary,
      manifestPath,
    }), /requires a valid collect-all failure summary/u);
  }
  assert.throws(
    () => assertProductionCellsPassedForCanonicalVerification({
      failureSummary: { failed: ['c03'] },
      manifestPath,
      startedCellIds: ['c01', 'c02', 'c03', 'c04'],
      completedCellIds: ['c01', 'c02', 'c03', 'c04'],
    }),
    (error) => {
      assert.equal(error.code, 'watch.production.cells-failed');
      assert.equal(error.failurePath, manifestPath);
      assert.deepEqual(error.startedCellIds, ['c01', 'c02', 'c03', 'c04']);
      assert.deepEqual(error.completedCellIds, ['c01', 'c02', 'c03', 'c04']);
      assert.match(error.message, /c03/u);
      return true;
    },
  );
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
  assert.match(source, /attempts:\s*WATCH_PRODUCTION_REMOTE_RUNTIME_VERIFICATION_ATTEMPTS/u);
  assert.match(source, /delayMs:\s*WATCH_PRODUCTION_REMOTE_RUNTIME_VERIFICATION_RETRY_DELAY_MS/u);
});

test('a stuck guest finalizer settles the injected remote child timeout without an exit event', async () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let killedWith = null;
  child.kill = (signal) => { killedWith = signal; };
  const startedAt = performance.now();
  const result = await runChildProcess('stuck-guest-finalizer', [], {
    timeoutMs: 5,
    spawnProcess: () => child,
  });
  assert.equal(result.exitCode, 124);
  assert.match(result.stderr, /child process timed out after 5ms/u);
  assert.equal(killedWith, 'SIGKILL');
  assert.ok(performance.now() - startedAt < 500);
  const source = fs.readFileSync(
    new URL('./run-watch-mode-live-production-coordinator.mjs', import.meta.url),
    'utf8',
  );
  assert.match(source, /timeoutMs: WATCH_PRODUCTION_GUEST_FINALIZER_TIMEOUT_MS/);
});

test('worker preparation normalizes and verifies signed implementation bytes before readiness', () => {
  const source = fs.readFileSync(new URL('./run-watch-mode-live-production-coordinator.mjs', import.meta.url), 'utf8');
  assert.match(source, /productionImplementationDistributionEntries\(plan\.authority\)/);
  assert.match(source, /authority\.implementationHashes/);
  assert.match(source, /authority\.shardOrchestrationImplementationHashes/);
  assert.match(source, /authority\.incidentImplementationHashes/);
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
  const readinessPlan = source.slice(
    source.indexOf('const readinessPlan = createProductionWorkerReadinessTransportPlan'),
    source.indexOf('const readinessTransport = createSshProductionTransport'),
  );
  assert.match(readinessPlan, /authorityImplementationHashes/u);
  assert.equal(AUTHORITY_IMPLEMENTATION_FILES.length, 58);
});

test('fresh readiness transports all 58 production implementation entries', () => {
  const implementationHashes = AUTHORITY_IMPLEMENTATION_FILES.map((entryPath, index) => ({
    path: entryPath,
    bytes: index + 1,
    sha256: String(index).padStart(64, '0'),
  }));
  const plan = createProductionWorkerReadinessTransportPlan({
    executionId: 'readiness-upload-count',
    provenance: { headCommit: 'a'.repeat(40) },
    authorityImplementationHashes: implementationHashes,
    shardOrchestrationImplementationHashes: [],
    workerReadinessRequest: {
      runtimeBinaryHashes: [],
      runtimeBundleDigest: 'b'.repeat(64),
      workers: [],
      assignments: [],
      requestDigest: 'c'.repeat(64),
    },
  });
  assert.equal(plan.authority.implementationHashes.length, 58);
  assert.deepEqual(plan.authority.implementationHashes, implementationHashes);
});

test('production evidence verifier is an asynchronously killable final-evidence stage', () => {
  const source = fs.readFileSync(
    new URL('./run-watch-mode-live-production-coordinator.mjs', import.meta.url),
    'utf8',
  );
  const verifierStage = source.slice(
    source.indexOf('const verifyResult ='),
    source.indexOf('const runtimeAfterVerifier ='),
  );
  assert.doesNotMatch(verifierStage, /spawnSync/u);
  assert.match(verifierStage, /runProductionEvidenceVerifier/u);
  assert.match(source, /remainingVerifierDeadlineMs = Math\.ceil\(postFinalDeadlineMs - deadlineNow\(\)\)/u);
  assert.match(verifierStage, /timeoutMs:\s*Math\.min\([\s\S]*remainingVerifierDeadlineMs/u);
  assert.match(verifierStage, /signal/u);
  assert.match(source, /'runtime-authority-before-verifier'/u);
  assert.match(source, /'runtime-authority-after-verifier'/u);
  assert.match(source, /stage: 'final-evidence-staging'/u);
  assert.match(source, /stage: 'canonical-manifest-publication'/u);
});

test('post-final staging, authority checks, verifier, and publication share one absolute deadline', () => {
  const source = fs.readFileSync(
    new URL('./run-watch-mode-live-production-coordinator.mjs', import.meta.url),
    'utf8',
  );
  const postFinalFlow = source.slice(
    source.indexOf('const postFinalDeadlineMs ='),
    source.indexOf('return {', source.indexOf('const postFinalDeadlineMs =')),
  );
  assert.ok(postFinalFlow.length > 0, 'the post-final flow must create an absolute shared deadline');
  assert.match(
    postFinalFlow,
    /deriveWatchProductionFinalEvidenceBudgetMs\(\)/u,
    'the shared deadline must derive from the same budget exported to the outer watchdog',
  );
  assert.ok(
    [...postFinalFlow.matchAll(/postFinalDeadlineMs/gu)].length >= 6,
    'every post-final stage must consume the same absolute deadline instead of restarting a local timer',
  );
  assert.doesNotMatch(
    postFinalFlow,
    /remainingVerifierDeadlineMs = Math\.ceil\(coordinatorDeadlineMs/u,
    'the verifier may not escape back to the wider coordinator deadline',
  );
});

test('shared post-final deadline rejects cumulative stage work before publication', async () => {
  let fakeNowMs = 0;
  let published = false;
  const sharedDeadlineMs = 360_000;
  await runBoundedCoordinatorStageWithinDeadline({
    operation: () => { fakeNowMs += 200_000; },
    label: 'final-evidence-staging',
    deadlineMs: sharedDeadlineMs,
    deadlineNow: () => fakeNowMs,
    maximumTimeoutMs: 240_000,
  });
  await assert.rejects(async () => {
    await runBoundedCoordinatorStageWithinDeadline({
      operation: () => { fakeNowMs += 200_000; },
      label: 'strict-evidence-verifier',
      deadlineMs: sharedDeadlineMs,
      deadlineNow: () => fakeNowMs,
      maximumTimeoutMs: 240_000,
    });
    published = true;
  },
    /strict-evidence-verifier completed after the shared post-final evidence deadline/u,
  );
  assert.equal(published, false);
});

test('a hung production evidence verifier times out before publication', async () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let killedWith = null;
  child.kill = (signal) => { killedWith = signal; };
  let published = false;
  await assert.rejects(async () => {
    await runProductionEvidenceVerifier({
      evidenceOutputRoot: 'unused-evidence-root',
      manifestPath: 'unused-manifest.json',
      timeoutMs: 5,
      spawnProcess: () => child,
    });
    published = true;
  }, /strict-evidence-verifier timed out after 5ms; canonical manifest was not published/u);
  assert.equal(published, false);
  assert.equal(killedWith, 'SIGKILL');
});

test('remote readiness shares one absolute deadline across command upload and SSH execution', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-remote-stage-deadline-'));
  try {
    const worker = {
      workerId: 'worker-deadline',
      host: '192.0.2.10',
      port: 22,
      user: 'omni',
      identityFile: path.join(root, 'identity'),
      knownHostsFile: path.join(root, 'known-hosts'),
      hostKeyAlias: 'worker-deadline',
      workspaceRoot: 'C:\\omni-worker',
      guestExecutionRoot: 'C:\\omni-evidence',
      vmIdentity: { uuidBios: '11111111-1111-1111-1111-111111111111' },
    };
    let fakeNowMs = 0;
    const calls = [];
    const desiredChildDurationMs = 44_999;
    const runProcess = async (executable, _args, options = {}) => {
      calls.push({ executable, timeoutMs: options.timeoutMs });
      const allowedMs = Number(options.timeoutMs);
      if (allowedMs < desiredChildDurationMs) {
        fakeNowMs += allowedMs;
        return { exitCode: 124, stdout: '', stderr: 'fake child timeout' };
      }
      fakeNowMs += desiredChildDurationMs;
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const transport = createSshProductionTransport({
      config: {
        scpExecutable: 'scp.exe',
        sshExecutable: 'ssh.exe',
        workers: [worker],
      },
      plan: {
        executionId: 'deadline-fixture',
        provenance: { headCommit: 'a'.repeat(40) },
        authority: { implementationHashes: [], runtimeBinaryHashes: [] },
      },
      planPath: path.join(root, 'plan.json'),
      leasePaths: [],
      coordinatorExecutionRoot: root,
      runProcess,
      workspaceRoot: root,
      deadlineNow: () => fakeNowMs,
    });
    await assert.rejects(
      () => transport.prepareWorker({ worker }),
      /fake child timeout|shared deadline/u,
    );
    assert.deepEqual(calls.slice(0, 2), [
      { executable: 'scp.exe', timeoutMs: 45_000 },
      { executable: 'ssh.exe', timeoutMs: 1 },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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
  assert.equal(PRODUCTION_CELL_LEASE_UPLOAD_TIMEOUT_MS, 60_000);
  assert.equal(PRODUCTION_CELL_DOWNLOAD_TIMEOUT_MS, 300_000);
  assert.deepEqual(
    LIVE_LLM_CELLS.map((cell) => deriveWatchProductionRemoteCellTimeoutMs(cell)),
    [640_000, 595_000, 595_000, 640_000],
  );
  assert.equal(
    PRODUCTION_COORDINATOR_TIMEOUT_MS,
    deriveWatchProductionPrepaidCoordinatorBudgetMs()
      + deriveWatchPostReadinessExecutionBudgetMs({ cells: LIVE_LLM_CELLS }),
  );
  assert.equal(PRODUCTION_COORDINATOR_TIMEOUT_MS, 13_702_000);
});

test('production transport applies each formal cell timeout at its actual outer boundary', () => {
  const source = fs.readFileSync(
    new URL('./run-watch-mode-live-production-coordinator.mjs', import.meta.url),
    'utf8',
  );
  assert.match(
    source,
    /const interactiveCellTimeoutMs = deriveWatchProductionInteractiveCellTimeoutMs\(cell\)/,
  );
  assert.match(
    source,
    /const remoteCellTimeoutMs = deriveWatchProductionRemoteCellTimeoutMs\(cell\)/,
  );
  assert.match(
    source,
    /timeoutMs: PRODUCTION_CELL_LEASE_UPLOAD_TIMEOUT_MS/,
  );
  assert.match(
    source,
    /timeoutMs: interactiveCellTimeoutMs,[\s\S]*timeoutMs: remoteCellTimeoutMs/,
  );
  assert.doesNotMatch(source, /PRODUCTION_REMOTE_CELL_TIMEOUT_MS/);
  for (const cell of LIVE_LLM_CELLS) {
    assert.ok(
      deriveWatchProductionRemoteCellTimeoutMs(cell)
        > deriveWatchProductionInteractiveCellTimeoutMs(cell),
    );
  }
});

test('production coordinator proves the full execution budget remains after delayed preparation', () => {
  const source = fs.readFileSync(
    new URL('./run-watch-mode-live-production-coordinator.mjs', import.meta.url),
    'utf8',
  );
  assert.match(source, /assertProductionCoordinatorWaveBudget\(\{/);
  assert.match(source, /coordinatorDeadlineMs/);
  const requiredExecutionMs = deriveWatchPostReadinessExecutionBudgetMs({
    cells: LIVE_LLM_CELLS,
  });
  const fakeCoordinatorStartedAtMs = 10_000;
  const fakeCoordinatorDeadlineMs = fakeCoordinatorStartedAtMs
    + PRODUCTION_COORDINATOR_TIMEOUT_MS;
  const legacyPreparationDeadlineMs = fakeCoordinatorStartedAtMs
    + PRODUCTION_ZERO_PROVIDER_READINESS_TIMEOUT_MS;
  const fakeReadinessCompletedAtMs = fakeCoordinatorStartedAtMs
    + deriveWatchProductionInitialWorkerReadinessBudgetMs();
  const fakePreflightCompletedAtMs = fakeReadinessCompletedAtMs
    + deriveWatchProductionProviderPreflightBudgetMs();
  assert.ok(fakeReadinessCompletedAtMs > legacyPreparationDeadlineMs);
  assert.ok(fakePreflightCompletedAtMs > legacyPreparationDeadlineMs);
  const fakePreparationBoundaryMs = fakeCoordinatorStartedAtMs
    + deriveWatchProductionPrepaidCoordinatorBudgetMs();
  assert.deepEqual(
    assertProductionCoordinatorWaveBudget({
      coordinatorDeadlineMs: fakeCoordinatorDeadlineMs,
      currentTimeMs: fakePreparationBoundaryMs,
    }),
    { remainingMs: requiredExecutionMs, requiredExecutionMs },
  );
  assert.throws(
    () => assertProductionCoordinatorWaveBudget({
      coordinatorDeadlineMs: fakeCoordinatorDeadlineMs,
      currentTimeMs: fakePreparationBoundaryMs + 1,
    }),
    new RegExp(
      `refuses paid waves with ${requiredExecutionMs - 1}ms remaining; `
      + `${requiredExecutionMs}ms is required`,
      'u',
    ),
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
    schemaVersion: 2,
    artifactKind: PRODUCTION_WORKER_CONFIG_KIND,
    workers: [
      {
        workerId: 'vm1', user: 'VMUser',
        transport: { kind: 'local' },
        workspaceRoot: 'E:\\watch-worker', guestExecutionRoot: 'E:\\omni-shards',
        vmIdentity: { provider: 'vmware', uuidBios: '56-4d-vm-1' },
        deviceProfileInstances: [defaultProfile('vm1')],
      },
    ],
  };
}

test('production worker config v2 accepts one local worker and rejects unbound fields', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-production-config-'));
  try {
    const raw = rawWorkerConfig(root);
    const parsed = validateProductionWorkerConfig(raw, { configDirectory: root });
    assert.equal(parsed.workers.length, 1);
    assert.deepEqual(parsed.workers.map((worker) => worker.workerId), ['vm1']);
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

test('production worker config v2 binds three distinct transports, BIOS UUIDs, host keys, and fixed placement', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-production-three-worker-'));
  try {
    const identity = path.join(root, 'id_rsa');
    fs.writeFileSync(identity, 'test-private-key');
    const profile = (workerId) => ({
      instanceId: `${workerId}-default`, profileId: 'vmware-hda-default', deviceClass: 'default-speaker',
      physicalPlaybackDeviceId: `{${workerId}-endpoint}`,
      expectedPhysicalPlaybackDeviceName: `speaker-${workerId}`,
    });
    const worker = (workerId, host, key) => {
      const knownHostsFile = path.join(root, `${workerId}.known-hosts`);
      fs.writeFileSync(knownHostsFile, `${workerId} ssh-ed25519 ${key}\n`);
      return {
        workerId, transport: { kind: 'ssh', host, port: 22, identityFile: 'id_rsa', knownHostsFile: path.basename(knownHostsFile), hostKeyAlias: workerId },
        user: 'VMUser', workspaceRoot: 'E:\\watch-worker', guestExecutionRoot: 'E:\\omni-shards',
        vmIdentity: { provider: 'vmware', uuidBios: `56-4d-${workerId}` },
        deviceProfileInstances: [profile(workerId)],
      };
    };
    const config = {
      schemaVersion: 2, artifactKind: PRODUCTION_WORKER_CONFIG_KIND,
      workers: [worker('vm171', '192.168.40.171', 'AAAA'), worker('vm167', '192.168.40.167', 'BBBB'), worker('vm169', '192.168.40.169', 'CCCC')],
    };
    const normalized = validateProductionWorkerConfig(config, { configDirectory: root });
    assert.deepEqual(normalized.assignments.map(({ cellId, workerId, waveIndex }) => [LIVE_LLM_CELLS.findIndex((cell) => cell.cellId === cellId) + 1, workerId, waveIndex]), [
      [1, 'vm171', 0], [2, 'vm169', 0], [3, 'vm169', 1], [4, 'vm167', 0],
    ]);
    const duplicateUuid = structuredClone(config);
    duplicateUuid.workers[2].vmIdentity.uuidBios = duplicateUuid.workers[1].vmIdentity.uuidBios;
    assert.throws(() => validateProductionWorkerConfig(duplicateUuid, { configDirectory: root }), /reuses a VMware BIOS UUID/u);
    const duplicateKey = structuredClone(config);
    fs.writeFileSync(path.join(root, 'vm169.known-hosts'), 'vm169 ssh-ed25519 BBBB\n');
    assert.throws(() => validateProductionWorkerConfig(duplicateKey, { configDirectory: root }), /reuses an SSH host key/u);
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
  assert.match(PRODUCTION_WORKER_READINESS_FINALIZE_BODY, /\$receipt = \[ordered\]@\{\s*schemaVersion = 3/);
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
    'lib/powershell/Omni.Testing.WatchMode.InteractiveCleanup.psm1',
  ].map((relativePath) => fs.readFileSync(path.join(repoRoot, 'scripts/testing', relativePath), 'utf8')).join('\n');
  assert.match(control, /expectedCredentialReference = \[string\]\$payload\.expectedCredentialReference/);
  assert.match(control, /\[bool\]\$payload\.requireSeparateControlPlane/);
  assert.match(source, /requireSeparateControlPlane: !isCoordinatorLocalWorker\(worker\)/);
  assert.match(control, /\$launch\.schemaVersion -ne 2/);
  assert.match(source, /Stop-OmniInteractiveOwnedProcesses/);
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

test('zero-provider readiness virtual-mic probe binds the current Bridge authority and preserves raw acceptance and capture evidence', () => {
  const targetCaptureApp = fs.readFileSync(
    path.join(repoRoot, 'apps/bridge-service-native/src/bin/omni-virtual-mic-target-capture.rs'),
    'utf8',
  );
  const targetCaptureIpc = fs.readFileSync(
    path.join(repoRoot, 'apps/bridge-service-native/src/bin/virtual_mic_target_capture/ipc.rs'),
    'utf8',
  );
  const driverTest = fs.readFileSync(
    path.join(repoRoot, 'scripts/installer/test-development-driver.ps1'),
    'utf8',
  );
  const elevatedRequest = fs.readFileSync(
    path.join(repoRoot, 'scripts/installer/request-elevated-driver-operation.ps1'),
    'utf8',
  );
  const elevatedOperation = fs.readFileSync(
    path.join(repoRoot, 'scripts/installer/invoke-elevated-driver-operation.ps1'),
    'utf8',
  );
  const deviceProbe = fs.readFileSync(
    path.join(repoRoot, 'scripts/installer/virtual-speaker-device.ps1'),
    'utf8',
  );

  // The formal zero-Provider worker readiness must reach the real production
  // capture process and preserve its raw device artifacts; helper-only or
  // aggregate-counter readiness is not a substitute for target capture.
  assert.match(PRODUCTION_WORKER_ZERO_PROVIDER_READINESS_BODY, /VirtualMicEvidenceOutputDirectory/);
  assert.match(driverTest, /Invoke-OmniVirtualMicTargetCaptureProbe/);
  assert.match(deviceProbe, /omni-virtual-mic-target-capture\.exe/);
  assert.match(deviceProbe, /--output-directory/);
  for (const artifact of [
    'virtual-mic-capture.wav',
    'virtual-mic-capture-probe.json',
    'runtime-snapshot.json',
  ]) {
    assert.match(targetCaptureApp, new RegExp(artifact.replace('.', '\\.')));
  }

  // Bridge authority requires a concrete playback owner. The profile's exact
  // endpoint id must cross the coordinator/UAC/driver/probe boundary unchanged;
  // an empty or "default" alias is not a production authority.
  assert.match(PRODUCTION_WORKER_ZERO_PROVIDER_READINESS_BODY, /physicalPlaybackDeviceId/);
  for (const boundary of [elevatedRequest, elevatedOperation, driverTest, deviceProbe]) {
    assert.match(boundary, /PhysicalPlaybackDeviceId/);
  }
  assert.match(deviceProbe, /--physical-playback-device-id/);
  assert.match(targetCaptureApp, /--physical-playback-device-id/);
  assert.match(targetCaptureApp, /physical playback device id[^\n]*(?:empty|default)/i);
  assert.match(targetCaptureApp, /"physicalPlaybackDeviceId":\s*physical_playback_device_id/);

  // This is intentionally checked at the serialized production frame, not at
  // a convenience helper: every member must be present and sourced rather than
  // reset to the legacy empty tuple that the real Bridge deterministically nacks.
  const headerBuilder = targetCaptureIpc.slice(
    targetCaptureIpc.indexOf('fn build_virtual_mic_header'),
    targetCaptureIpc.indexOf('fn read_framed_json'),
  );
  for (const field of [
    'bridge_instance_id',
    'source_generation',
    'source_generation_token',
    'playback_owner_generation',
    'physical_playback_device_id',
  ]) {
    assert.doesNotMatch(
      headerBuilder,
      new RegExp(`${field}:\\s*None`),
      `${field} must be bound on the production probe frame`,
    );
    assert.match(
      headerBuilder,
      new RegExp(`${field}:\\s*Some\\(`),
      `${field} must be serialized as part of the current authority tuple`,
    );
  }

  // Attempted, Bridge-accepted, Bridge-committed, and device-played remain
  // separate oracles. In particular, counters cannot replace the original ACK
  // or the capture fingerprint computed from the target application's PCM.
  const runProbe = targetCaptureApp.slice(
    targetCaptureApp.indexOf('fn run_probe'),
    targetCaptureApp.indexOf('struct BridgeIdentity'),
  );
  const attempted = runProbe.indexOf('send_virtual_mic_cue');
  const committed = runProbe.indexOf('collect_cue_statuses');
  const captured = runProbe.indexOf('wait_for_capture_result');
  const played = runProbe.indexOf('find_unique_fingerprint');
  const counters = runProbe.indexOf('CounterEvidence::from_snapshots');
  assert.ok(attempted >= 0 && attempted < committed);
  assert.ok(committed < captured && captured < played && played < counters);
  assert.match(targetCaptureIpc, /ack\.event_type != "bridge\.translation\.ack"/);
  assert.match(targetCaptureIpc, /ack\.accepted_frames != pcm\.len\(\)/);
  for (const ackField of [
    'session_id',
    'bridge_instance_id',
    'source_generation',
    'source_generation_token',
    'playback_owner_generation',
    'physical_playback_device_id',
  ]) {
    assert.match(targetCaptureIpc, new RegExp(`ack\\.${ackField}`));
  }
  assert.match(targetCaptureApp, /CueLifecycleEvidence::from_timeline/);
  assert.match(targetCaptureApp, /require_fingerprint_spectrum/);
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
  assert.match(collector, /function Get-ProcessGenerationKey/);
  assert.match(collector, /\$key = Get-ProcessGenerationKey \$process/);
  assert.match(collector, /\(Get-ProcessGenerationKey \$currentRoot\) -cne \$rootGenerationKey/);
  assert.match(collector, /\(Get-ProcessGenerationKey \$confirmedIdentityProcess\) -cne \$key/);
  assert.match(collector, /parentStartedAt = \$parentStartedAt/);
  const descendantSnapshotIndex = collector.indexOf('$descendantSnapshot = @(Get-DescendantProcesses $RootProcessId $rootGenerationKey)');
  const capturedAtIndex = collector.indexOf("$capturedAt = [DateTime]::UtcNow.ToString('o')", descendantSnapshotIndex);
  const snapshotLoopIndex = collector.indexOf('foreach ($process in $descendantSnapshot)', capturedAtIndex);
  const firstGenerationCheckIndex = collector.indexOf('(Get-ProcessGenerationKey $identityProcess) -cne $key', snapshotLoopIndex);
  const existingGenerationIndex = collector.indexOf('if ($observed.ContainsKey($key))', firstGenerationCheckIndex);
  const lastSeenAtIndex = collector.indexOf('lastSeenAt = $capturedAt', existingGenerationIndex);
  const confirmedGenerationIndex = collector.indexOf('(Get-ProcessGenerationKey $confirmedIdentityProcess) -cne $key', lastSeenAtIndex);
  const firstSeenAtIndex = collector.indexOf('firstSeenAt = $capturedAt', capturedAtIndex);
  assert.ok(descendantSnapshotIndex >= 0);
  assert.ok(capturedAtIndex > descendantSnapshotIndex);
  assert.ok(snapshotLoopIndex > capturedAtIndex);
  assert.ok(firstGenerationCheckIndex > snapshotLoopIndex);
  assert.ok(existingGenerationIndex > firstGenerationCheckIndex);
  assert.ok(lastSeenAtIndex > existingGenerationIndex);
  assert.ok(confirmedGenerationIndex > lastSeenAtIndex);
  assert.ok(firstSeenAtIndex > confirmedGenerationIndex);
  assert.match(collector, /\$executionExitCode -eq 0/);
  assert.match(collector, /interactive cell execution receipt identity mismatch/);
  assert.match(launcher, /'-ExecutionReceiptPath'/);
  assert.match(collector, /\$requiredRoles = @\('shard-node', 'cell-powershell'\)/);
});

test('interactive shard retains redirected process exit status and rejects unknown status', { skip: !isWindows }, () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-shard-exit-'));
  const launcher = fs.readFileSync(path.join(repoRoot, 'scripts/testing/run-watch-mode-interactive-task.ps1'), 'utf8');
  const launch = launcher.slice(launcher.indexOf('$node = Start-Process'), launcher.indexOf('$nodeIdentity = Get-ProcessIdentity $node.Id'));
  const wait = launcher.slice(launcher.indexOf('$node.WaitForExit()'), launcher.indexOf('$trace.WaitForExit(30000)'));
  assert.match(launch, /\$nodeHandle = \$node.Handle/);
  assert.doesNotMatch(wait, /\.Refresh\(/);
  const emitterPath = path.join(tempRoot, 'exit.mjs');
  fs.writeFileSync(emitterPath, 'setTimeout(() => { console.log("stdout"); console.error("stderr"); process.exit(Number(process.argv[2])); }, 200);\n', 'utf8');
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `$request = @{ nodeExecutable = ${quotePowerShell(process.execPath)}; workspaceRoot = ${quotePowerShell(tempRoot)}; stdoutPath = ''; stderrPath = '' }`,
    '$results = @()',
    'foreach ($delay in @(0, 1200)) { foreach ($expected in @(0, 23)) {',
    `$request.stdoutPath = Join-Path ${quotePowerShell(tempRoot)} "$delay-$expected.out"`,
    `$request.stderrPath = Join-Path ${quotePowerShell(tempRoot)} "$delay-$expected.err"`,
    `$arguments = @(${quotePowerShell(`"${emitterPath}"`)}, [string]$expected)`,
    launch,
    'Start-Sleep -Milliseconds $delay',
    wait,
    '$results += @{ expected = $expected; actual = $nodeExitCode; delay = $delay }',
    '}}',
    '$node = [pscustomobject]@{ ExitCode = $null }',
    '$node | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value {}',
    '$rejectedUnknown = $false',
    'try {', wait,
    '} catch { $rejectedUnknown = $_.Exception.Message -eq "interactive shard Node exit code is unavailable" }',
    '@{ results = $results; rejectedUnknown = $rejectedUnknown } | ConvertTo-Json -Depth 5 -Compress',
  ].join('\n');
  try {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], {
      encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const evidence = JSON.parse(result.stdout.trim());
    assert.equal(evidence.results.length, 4);
    for (const entry of evidence.results) assert.equal(entry.actual, entry.expected, `delay=${entry.delay}`);
    assert.equal(evidence.rejectedUnknown, true);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
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
    'lib/powershell/Omni.Testing.WatchMode.InteractiveCleanup.psm1',
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

test('remote PowerShell file-only mode bypasses only the encoded argument budget', () => {
  const body = '$payload | ConvertTo-Json -Compress';
  const payload = { marker: 'file-only', inventory: crypto.randomBytes(32_768).toString('base64') };
  assert.throws(() => remotePowerShellInvocation(body, payload), /encoded-command budget/);
  assert.throws(() => remotePowerShellInvocation(body, payload, { mode: 'encoded' }), /encoded-command budget/);
  const invocation = remotePowerShellInvocation(body, payload, { mode: 'file-only' });
  assert.ok(invocation.fileScript.length > 32_000);
  assert.deepEqual(Object.keys(invocation).sort(), ['fileScript', 'input']);
  assert.equal(invocation.input, '');
  const small = { marker: 'same-source-扬声器' };
  assert.equal(
    remotePowerShellInvocation(body, small, { mode: 'file-only' }).fileScript,
    remotePowerShellInvocation(body, small, { mode: 'encoded' }).fileScript,
  );
  assert.throws(() => remotePowerShellInvocation(body, small, { mode: 'invalid' }), /invocation mode/);
});

test('Windows PowerShell file-only executes oversized incompressible payload with identical output framing', { skip: !isWindows }, () => {
  const payload = { marker: 'file-only-扬声器', inventory: crypto.randomBytes(32_768).toString('base64') };
  const body = '$payload | ConvertTo-Json -Compress';
  assert.throws(() => remotePowerShellInvocation(body, payload, { mode: 'encoded' }), /encoded-command budget/);
  const invocation = remotePowerShellInvocation(body, payload, { mode: 'file-only' });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-large-file-command-'));
  const scriptPath = path.join(root, 'command.ps1');
  try {
    fs.writeFileSync(scriptPath, invocation.fileScript, 'utf8');
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
    ], { encoding: 'utf8', timeout: 30_000, windowsHide: true, env: windowsPowerShellEnvironment(process.env) });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.match(result.stdout, /__OMNI_REMOTE_COMPLETE_V1__/);
    const decoded = decodeRemotePowerShellFileOutput({ exitCode: result.status, stdout: result.stdout, stderr: result.stderr });
    assert.deepEqual(JSON.parse(decoded.stdout.split(/\r?\n/)[0]), payload);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('production runRemote selects file-only for both local and SSH large payloads', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-large-run-remote-'));
  const payload = { inventory: crypto.randomBytes(32_768).toString('base64') };
  const body = '$payload | ConvertTo-Json -Compress';
  const fileScript = remotePowerShellInvocation(body, payload, { mode: 'file-only' }).fileScript;
  try {
    for (const kind of ['local', 'ssh']) {
      const worker = {
        workerId: `worker-${kind}`, transport: { kind }, workspaceRoot: root,
        guestExecutionRoot: root, user: 'VMUser', host: '192.0.2.10', port: 22,
        identityFile: path.join(root, 'identity'), knownHostsFile: path.join(root, 'known-hosts'),
        hostKeyAlias: 'fixture-worker',
      };
      const calls = [];
      const transport = createSshProductionTransport({
        config: { workers: [worker], scpExecutable: 'scp.exe', sshExecutable: 'ssh.exe' },
        plan: { executionId: 'large-file-only' }, planPath: path.join(root, 'unused-plan.json'),
        leasePaths: [], coordinatorExecutionRoot: root, workspaceRoot: root,
        runProcess: async (executable, args, options) => {
          calls.push({ executable, args });
          assert.equal(args.includes('-EncodedCommand'), false);
          assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 30_000);
          if (executable === 'scp.exe') {
            assert.equal(fs.readFileSync(args.at(-2), 'utf8'), fileScript);
          }
          if (executable === 'powershell.exe') {
            assert.equal(fs.readFileSync(args[args.indexOf('-File') + 1], 'utf8'), fileScript);
          }
          if (args.includes('-File')) {
            const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');
            const frames = encoded.match(/.{1,160}/gu).map((frame) => `__OMNI_REMOTE_OUTPUT_V1__${frame}`);
            return { exitCode: 0, stdout: `${frames.join('\n')}\n__OMNI_REMOTE_COMPLETE_V1__\n`, stderr: '' };
          }
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      });
      const result = await transport.executeRemote(worker, body, payload, { timeoutMs: 30_000 });
      assert.deepEqual(JSON.parse(result.stdout.split(/\r?\n/)[0]), payload);
      assert.equal(calls.filter((call) => call.args.includes('-File')).length, 1);
      assert.equal(calls.some((call) => call.executable === 'scp.exe'), kind === 'ssh');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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
  let diagnostic;
  let primaryFailure;
  try {
    const result = spawnSync(invocation.args[0], invocation.args.slice(1), {
      input: invocation.input,
      encoding: 'utf8',
      timeout: 30_000,
    });
    diagnostic = {
      status: result.status, signal: result.signal,
      error: result.error && {
        message: result.error.message, code: result.error.code,
        errno: result.error.errno, syscall: result.error.syscall,
      },
      stdout: result.stdout, stderr: result.stderr,
      nodeVersion: process.version, uvVersion: process.versions.uv,
    };
    assert.equal(result.status, 0, JSON.stringify(diagnostic));
    const evidence = JSON.parse(result.stdout.split(/\r?\n/)
      .filter((line) => line.trim() && line.trim() !== '__OMNI_REMOTE_COMPLETE_V1__').join('\n'));
    assert.equal(evidence.status, 'passed');
    assert.equal(evidence.marker, 'script-success-with-null-last-exit-code');
  } catch (error) {
    primaryFailure = error;
    // Keep this outside os.tmpdir(): the outer VM harness removes temporary roots.
    const failureRoot = path.join(repoRoot, 'artifacts/testing/interactive-control-failures', crypto.randomUUID());
    try {
      fs.mkdirSync(failureRoot, { recursive: true });
      fs.writeFileSync(path.join(failureRoot, 'diagnostic.json'), `${JSON.stringify({ ...diagnostic, failure: error.message }, null, 2)}\n`, 'utf8');
      fs.cpSync(root, path.join(failureRoot, 'fixture'), { recursive: true });
    } catch (retentionError) {
      console.error('interactive control failure retention failed:', retentionError.message);
    }
    throw error;
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch (cleanupError) {
      if (!primaryFailure) throw cleanupError;
      console.error('interactive control fixture cleanup failed:', cleanupError.message);
    }
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
  const cancel = source.slice(source.indexOf('async function cancelCell('), source.indexOf('async function collectWorker('));
  const cleanup = fs.readFileSync(path.join(repoRoot, 'scripts/testing/lib/powershell/Omni.Testing.WatchMode.InteractiveCleanup.psm1'), 'utf8');
  assert.match(cancel, /orchestrationHash\(plan, cleanupModule\)/);
  assert.match(cancel, /if \(!cleanupHash\) throw/);
  assert.match(cancel, /Get-FileHash -LiteralPath \$modulePath -Algorithm SHA256 -ErrorAction Stop/);
  assert.match(cancel, /-cne \[string\]\$payload\.cleanupHash/);
  assert.ok(cancel.indexOf('worker cleanup module hash mismatch') < cancel.indexOf('Import-Module $modulePath'));
  assert.match(cancel, /Stop-OmniInteractiveOwnedProcesses[\s\S]*?-ExpectedBinding \$payload\.binding/);
  for (const field of ['executionId', 'planDigest', 'workerId', 'vmIdentityDigest', 'leaseId', 'leaseDigest', 'cellId', 'expectedVmUuidBios', 'expectedSessionId']) {
    assert.match(cancel, new RegExp(`${field}:`));
  }
  assert.match(cancel, /expectedUserSid[\s\S]*?Translate\(\[Security\.Principal\.SecurityIdentifier\]\)/);
  for (const verb of ['Get', 'Stop', 'Unregister']) {
    assert.match(cancel, new RegExp(`${verb}-ScheduledTask -TaskPath \\$taskPath -TaskName \\(\\[string\\]\\$payload\\.taskName\\)`));
  }
  assert.match(cancel, /Write-OmniImmutableJson -LiteralPath \$receiptPath -Value \$receipt/);
  assert.match(cancel, /if \(-not \$receipt\.passed\) \{ throw/);
  assert.doesNotMatch(cancel, /taskkill|Stop-Process|Stop-OmniOwnedProcessTree|\.catch\s*\(/);
  assert.match(cleanup, /\$launch\.schemaVersion -ne 2/);
  assert.match(cleanup, /Get-OmniCleanupGeneration \$launch\.nodeProcess/);
  assert.match(cleanup, /\$root\.imagePath -ine \[string\]\$launch\.nodeProcess\.imagePath/);
  assert.match(cleanup, /\$root\.imageSha256 -cne \[string\]\$launch\.nodeProcess\.imageSha256/);
  assert.match(cleanup, /\$process\.StartTime\.ToUniversalTime\(\)\.Ticks -ne/);
  assert.match(cleanup, /\$nativeHandle = \$process\.Handle/);
  assert.doesNotMatch(source, /logs\\\\" \+ \[string\]\$payload\.leaseId \+ '\\.pid'/);
});

test('paid scheduler cleanup gates success output and preserves primary failures without a PID-tree fallback', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'scripts/testing/lib/powershell/Omni.Testing.WatchMode.InteractiveScheduler.psm1'), 'utf8');
  const cleanup = fs.readFileSync(path.join(repoRoot, 'scripts/testing/lib/powershell/Omni.Testing.WatchMode.InteractiveCleanup.psm1'), 'utf8');
  const finallyStart = source.search(/\} finally \{\r?\n    if \(\$registered\)/);
  assert.ok(finallyStart > 0);
  const finalization = source.slice(finallyStart);
  const paid = finalization.slice(finalization.indexOf("if ($mode -in @('shard-cell', 'incident-plus-cell'))"), finalization.indexOf('} else {'));
  assert.match(paid, /status = 'cleanup-incomplete'/);
  assert.match(paid, /Stop-OmniInteractiveOwnedProcesses[\s\S]*?-ExpectedBinding \$command/);
  assert.ok(paid.indexOf('Stop-OmniInteractiveOwnedProcesses') < paid.indexOf('Stop-ScheduledTask'));
  assert.match(paid, /\$cleanupReceipt\.processCleanup\.passed -ne \$true\) \{ \$cleanupError =/);
  assert.match(paid, /Write-OmniImmutableJson[\s\S]*?'cleanup\.scheduler\.json'/);
  assert.doesNotMatch(paid, /Stop-GuardedNode|Stop-Process|Stop-OmniOwnedProcessTree|taskkill/);
  assert.match(cleanup, /Read-OmniCleanupAuthority \$ProcessAuthorityPath/);
  assert.match(cleanup, /\$authority\.passed -ne \$true/);
  assert.match(source, /\} catch \{\s*\$primaryError = \$_\s*\} finally/);
  assert.match(finalization, /if \(\$null -ne \$primaryError\) \{ throw \$primaryError \}\s*if \(\$null -ne \$cleanupError\) \{ throw \$cleanupError \}\s*\$resultJson/);
  assert.match(source.slice(0, finallyStart), /\$resultJson = \[ordered\]@\{/);
  assert.match(finalization, /\} else \{\s*Stop-ScheduledTask[\s\S]*?Stop-GuardedNode \$launchPath/);
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
  let preparationRun = 0;
  let failCells = false;
  try {
    const coordinatorOptions = {
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
            operation: 'livetranslate-session-lifecycle-preflight',
            inputMode: 'none',
            providerInputMode: 'none',
            responseMode: 'text-only',
            terminalEvent: 'session.finished',
            lifecycleBudget: {
              firstServerEventLatencyMs: 1_200,
              socketEventTimeoutMs: 12_000,
            },
            evidenceOutcome: 'livetranslate-session-finished',
            firstServerEvent: { type: 'session.created', monotonicMs: 606 },
            sessionAuthority: {
              sessionIdentitySha256: 'a'.repeat(64),
              serverModel: 'qwen3.5-livetranslate-flash-realtime',
              echoedSessionConfigSha256: 'b'.repeat(64),
            },
            rawTrace: {
              path: 'raw/provider-websocket-trace.jsonl',
              bytes: 256,
              sha256: 'c'.repeat(64),
              eventCount: 6,
            },
            providerInvocationCount: 1,
            externalAudioSamples: 0,
            status: 'completed',
            evidenceDirectory: path.join(root, 'unused-preflight'),
          };
        },
        prepareCoordinatorExecution: async (options) => {
          preparationRun += 1;
          const executionRoot = path.join(root, `execution-${preparationRun}`);
          calls.push('prepare');
          assert.deepEqual(options.signingKeys, signingKeys);
          assert.equal(typeof options.buildRuntimeAuthority, 'function');
          assert.equal(typeof options.runProviderPreflight, 'function');
          assert.equal(typeof options.runZeroProviderWorkerReadiness, 'function');
          assert.equal(
            options.minimumRemainingExecutionMs,
            deriveWatchPostReadinessExecutionBudgetMs({ cells: LIVE_LLM_CELLS }),
          );
          const workerReadiness = await options.runZeroProviderWorkerReadiness({
            executionId: plan.executionId,
            executionRoot,
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
            executionRoot,
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
          const collectedFailures = [];
          if (failCells) {
            const failedCell = signedPlan.cells[2];
            const failedResult = {
              verdict: 'failed',
              failureLayer: 'provider',
              stableErrorCode: 'watch.provider.session-failed',
              lifecyclePhase: 'provider-session',
              failureContext: {
                endpointId: null,
                bridgeInstanceId: null,
                ownerGenerationTransition: { before: null, after: null },
              },
            };
            const outcome = { result: failedResult };
            results.set(failedCell.cellId, outcome);
            collectedFailures.push({
              cellId: failedCell.cellId,
              error: 'fixture provider session failed',
              outcome,
            });
          }
          return {
            results,
            startedCellIds: signedPlan.cells.map((cell) => cell.cellId),
            completedCellIds: signedPlan.cells.map((cell) => cell.cellId),
            collectedFailures,
          };
        },
        writeCoordinatorAggregate: () => ({
          aggregatePath: path.join(root, 'aggregate.json'),
          matrixIntegration: { cells: [] },
        }),
        stageShardMatrixIntegration: () => {
          const finalExecutionRoot = path.join(
            root,
            'evidence',
            failCells ? 'staged-failed' : 'staged',
          );
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
    };
    const result = await runProductionCoordinator(coordinatorOptions);
    assert.deepEqual(
      calls.filter((entry) => entry.startsWith('wave:')),
      LIVE_LLM_CELLS.map((_, index) => `wave:${index}`),
    );
    assert.ok(calls.indexOf('zero-provider-readiness') < calls.indexOf('provider-preflight'));
    assert.equal(calls.filter((entry) => entry.startsWith('paid:')).length, LIVE_LLM_CELLS.length);
    assert.ok(calls.indexOf('verify') < calls.indexOf('publish'));
    assert.equal(result.workerCount, 1);
    assert.equal(result.waveCount, LIVE_LLM_CELLS.length);

    calls.length = 0;
    const originalTransport = coordinatorOptions.operations.createTransport;
    await assert.rejects(runProductionCoordinator({
      ...coordinatorOptions,
      executionId: 'production-test-collection-failed',
      operations: {
        ...coordinatorOptions.operations,
        createTransport: async (...args) => ({
          ...await originalTransport(...args),
          collectWorker: () => { throw new Error('fixture collection failure'); },
        }),
      },
    }), error => {
      assert.equal(error.code, 'watch.collection.failed');
      assert.ok(fs.existsSync(error.failurePath));
      return true;
    });
    assert.equal(calls.includes('write-manifest'), false);
    assert.equal(calls.includes('verify'), false);
    assert.equal(calls.includes('publish'), false);

    failCells = true;
    calls.length = 0;
    await assert.rejects(
      runProductionCoordinator({
        ...coordinatorOptions,
        executionId: 'production-test-failed-execution',
      }),
      /production cells failed after final evidence staging/u,
    );
    assert.equal(calls.filter((entry) => entry === 'write-manifest').length, 1);
    assert.equal(calls.filter((entry) => entry === 'verify').length, 0);
    assert.equal(calls.filter((entry) => entry === 'publish').length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('worker collection settles synchronous and asynchronous failures without losing slow workers', async () => {
  const { collectProductionWorkers } = await import('./run-watch-mode-live-production-coordinator.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-collect-settled-'));
  const preparation = { executionRoot: root, plan: { executionId: 'fixture', workers: ['a', 'b', 'c'].map(workerId => ({ workerId })) }, leases: [] };
  const waveOutcome = { results: new Map(), startedCellIds: ['cell'], completedCellIds: ['cell'] };
  let release;
  const slow = new Promise(resolve => { release = resolve; });
  const calls = [];
  let finished = false;
  try {
    const pending = collectProductionWorkers({ preparation, waveOutcome, transport: { collectWorker({ worker }) {
      calls.push(worker.workerId);
      if (worker.workerId === 'a') throw new Error('native secret fixture must never be persisted');
      if (worker.workerId === 'b') return Promise.reject(new Error('deadline exceeded with private stderr'));
      return slow.then(() => ({ workerId: 'c' }));
    } } }).then(() => { throw new Error('unexpected success'); }, error => { finished = true; return error; });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, ['a', 'b', 'c']);
    assert.equal(finished, false);
    release();
    const error = await pending;
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);
    assert.deepEqual(error.completedCellIds, ['cell']);
    const raw = fs.readFileSync(error.failurePath, 'utf8');
    assert.doesNotMatch(raw, /secret|private stderr|native/);
    const receipt = JSON.parse(raw);
    assert.equal(receipt.allWorkersSettled, true);
    assert.deepEqual(receipt.workers.map(w => w.status), ['failed', 'failed', 'collected']);
    assert.equal(receipt.workers[1].code, 'watch.collection.timeout');
    const successRoot = path.join(root, 'success');
    fs.mkdirSync(successRoot);
    const result = await collectProductionWorkers({ preparation: { ...preparation, executionRoot: successRoot }, waveOutcome, transport: { async collectWorker({ worker }) {
      if (worker.workerId === 'a') await new Promise(resolve => setImmediate(resolve));
      return { workerId: worker.workerId };
    } } });
    assert.deepEqual(result.map(w => w.workerId), ['a', 'b', 'c']);
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

test('prepaid distribution covers every signed shard implementation with exact bytes', async () => {
  const { productionImplementationDistributionEntries } = await import('./run-watch-mode-live-production-coordinator.mjs');
  const { currentShardOrchestrationImplementationHashes } = await import('./watch-mode-shard-authority.mjs');
  const matrix = AUTHORITY_IMPLEMENTATION_FILES.map((entry) => fileAuthorityEntry(path.join(repoRoot, entry), entry));
  const shards = currentShardOrchestrationImplementationHashes();
  const combined = productionImplementationDistributionEntries({
    implementationHashes: matrix,
    shardOrchestrationImplementationHashes: shards,
  });
  assert.equal(new Set(combined.map((entry) => entry.path)).size, combined.length);
  for (const entry of [...matrix, ...shards]) {
    assert.deepEqual(combined.find((candidate) => candidate.path === entry.path), entry);
  }
  for (const name of ['watch-mode-provider-network-health.mjs', 'watch-mode-provider-preflight-process.mjs', 'watch-mode-release-timeout-budget.mjs']) {
    const entry = shards.find((candidate) => candidate.path === `scripts/testing/${name}`);
    assert.ok(entry);
    assert.ok(!matrix.some((candidate) => candidate.path === entry.path), 'fixture must exercise a shard-only entry');
    const crlf = fs.readFileSync(path.join(repoRoot, entry.path), 'utf8').replace(/\r?\n/g, '\r\n');
    assert.notEqual(crypto.createHash('sha256').update(crlf).digest('hex'), entry.sha256);
    assert.deepEqual(combined.find((candidate) => candidate.path === entry.path), entry, 'distribute signed LF bytes, not normalized remote hashes');
  }
  assert.throws(() => productionImplementationDistributionEntries({
    implementationHashes: [shards[0]],
    shardOrchestrationImplementationHashes: [{ ...shards[0], bytes: shards[0].bytes + 1 }],
  }), /signed implementation inventories disagree/);
  assert.throws(() => productionImplementationDistributionEntries({
    shardOrchestrationImplementationHashes: [shards[0]],
    incidentImplementationHashes: [{ ...shards[0], sha256: '0'.repeat(64) }],
  }), /signed implementation inventories disagree/);
  const source = fs.readFileSync(new URL('./run-watch-mode-live-production-coordinator.mjs', import.meta.url), 'utf8');
  assert.match(source, /const implementationEntries = productionImplementationDistributionEntries\(plan\.authority\)/);
  assert.match(source, /for \(const entry of implementationEntries\) await upload\(worker, entry\.localPath, entry\.remotePath\)/);
});
