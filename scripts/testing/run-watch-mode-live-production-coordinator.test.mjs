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

import { sha256Canonical } from './watch-mode-shard-authority.mjs';

const productionCoordinatorSource = fs.readFileSync(
  new URL('./run-watch-mode-live-production-coordinator.mjs', import.meta.url),
  'utf8',
);

function windowsPathFromGitScpOperand(operand) {
  return String(operand)
    .replace(/^\/([a-z])\//iu, (_, drive) => `${drive.toUpperCase()}:/`)
    .replaceAll('/', '\\');
}

function signedCredentialHelperFixture(root) {
  const relativePath = 'target/release/watch-worker-credential.exe';
  const filePath = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const bytes = Buffer.from('signed-credential-helper-fixture');
  fs.writeFileSync(filePath, bytes);
  return [{
    path: relativePath,
    bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  }];
}

test('remote credential provision consumes the helper from signed runtime inventory', () => {
  assert.doesNotMatch(
    productionCoordinatorSource,
    /path\.join\(repoRoot, 'target', 'release', 'watch-worker-credential\.exe'\)/u,
  );
  assert.match(productionCoordinatorSource, /target\/release\/watch-worker-credential\.exe/u);
  assert.match(productionCoordinatorSource, /runtimeBinaryHashes/u);
  assert.match(productionCoordinatorSource, /actualHelperAuthority.sha256 !== helperAuthority.sha256/u);
});

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
    `Import-Module ${quote(path.join(repoRoot, 'scripts/testing/lib/powershell/Omni.Testing.WatchMode.InteractiveFinalizer.psm1'))} -Force`,
    "$module = Get-Module Omni.Testing.WatchMode.InteractiveFinalizer",
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
  assertSafeCollectionArchiveEntries,
  collectRemoteDirectoryArchive,
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
  resolveLocalIsolationAuthorityPath,
  selectChangedRuntimeEntries,
  aggregateProductionCellFailures,
  assertProductionCellsPassedForCanonicalVerification,
  productionCellFailureDisposition,
  observeOwnedCellCompletion,
  preserveFailedCellEvidence,
  failedCellEvidencePaths,
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
  createSshProviderPreflightTransport,
  validateProviderPreflightInteractiveTerminal,
  validateProviderPreflightCleanupReceipt,
  validateProviderPreflightProcessAuthority,
  createDeterministicReadinessTransferArchive,
  REMOTE_PROVIDER_PREFLIGHT_PUBLICATION_BODY,
  stageProductionReadinessBatch,
} from './run-watch-mode-live-production-coordinator.mjs';

test('collection archive inventory remains inside the immutable worker root', () => {
  assert.doesNotThrow(() => assertSafeCollectionArchiveEntries([
    'vm167/',
    'vm167/shard-manifest.json',
    'vm167/runs/c04/report.json',
  ], 'vm167'));
  for (const entries of [
    [],
    ['../escape'],
    ['vm167/../../escape'],
    ['/absolute'],
    ['C:/absolute'],
    ['vm167/file:stream'],
    ['vm167/a', 'vm167/a'],
    ['vm169/shard-manifest.json'],
  ]) assert.throws(() => assertSafeCollectionArchiveEntries(entries, 'vm167'));
});

test('remote directory collection validates a hash-authorized archive before atomic publication', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-cell-archive-'));
  const finalDirectory = path.join(root, 'validation-shards', 'vm167', 'runs', 'c04');
  const archiveBytes = Buffer.from('authorized-cell-archive');
  const sha256 = crypto.createHash('sha256').update(archiveBytes).digest('hex');
  const remoteDirectory = 'E:\\omni-shards\\execution\\vm167\\runs\\c04';
  const remoteArchivePath = `${remoteDirectory}.collection-lease-test.tar`;
  const remoteCalls = [];
  let validationObservedFinal = null;
  try {
    const result = await collectRemoteDirectoryArchive({
      worker: { workerId: 'vm167' }, remoteDirectory, localDirectory: finalDirectory,
      remoteArchivePath, timeoutMs: 30_000, nonce: 'fixture',
      executeRemote: async (_worker, body, payload) => {
        remoteCalls.push({ body, payload });
        if (remoteCalls.length === 1) {
          return { exitCode: 0, stdout: JSON.stringify({ path: remoteArchivePath, bytes: archiveBytes.length, sha256 }), stderr: '' };
        }
        return { exitCode: 0, stdout: JSON.stringify({ removed: true }), stderr: '' };
      },
      downloadFile: async (_worker, remotePath, localPath) => {
        assert.equal(remotePath, remoteArchivePath);
        assert.equal(fs.existsSync(finalDirectory), false);
        fs.writeFileSync(localPath, archiveBytes);
      },
      runLocalProcess: async (_executable, args) => {
        if (args[0] === '-tf') return { exitCode: 0, signal: null, stdout: 'c04/\nc04/shard-cell-result.json\n', stderr: '' };
        if (args[0] === '-tvf') return { exitCode: 0, signal: null, stdout: 'd c04/\n- c04/shard-cell-result.json\n', stderr: '' };
        assert.equal(args[0], '-xf');
        const extractRoot = args[args.indexOf('-C') + 1];
        const staged = path.join(extractRoot, 'c04');
        fs.mkdirSync(staged);
        fs.writeFileSync(path.join(staged, 'shard-cell-result.json'), '{"fixture":true}\n');
        return { exitCode: 0, signal: null, stdout: '', stderr: '' };
      },
      validateExtracted: async (staged) => {
        validationObservedFinal = fs.existsSync(finalDirectory);
        assert.equal(path.basename(staged), 'c04');
        assert.equal(fs.existsSync(path.join(staged, 'shard-cell-result.json')), true);
      },
    });
    assert.equal(validationObservedFinal, false);
    assert.equal(result.localDirectory, finalDirectory);
    assert.equal(fs.existsSync(path.join(finalDirectory, 'shard-cell-result.json')), true);
    assert.equal(remoteCalls.length, 2);
    assert.equal(remoteCalls[1].payload.archivePath, remoteArchivePath);
    assert.deepEqual(
      fs.readdirSync(path.dirname(finalDirectory)).filter((name) => name.startsWith('.incoming-')),
      [],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('remote directory collection keeps validated publication successful when staging parent cleanup fails', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-cell-archive-cleanup-warning-'));
  const finalDirectory = path.join(root, 'validation-shards', 'vm167', 'runs', 'c04');
  const archiveBytes = Buffer.from('valid-cell-archive');
  const sha256 = crypto.createHash('sha256').update(archiveBytes).digest('hex');
  const remoteDirectory = 'E:\\omni-shards\\execution\\vm167\\runs\\c04';
  const remoteArchivePath = `${remoteDirectory}.collection-lease-test.tar`;
  let remoteCalls = 0;
  try {
    const result = await collectRemoteDirectoryArchive({
      worker: { workerId: 'vm167' }, remoteDirectory, localDirectory: finalDirectory,
      remoteArchivePath, timeoutMs: 30_000, nonce: 'fixture-cleanup-warning',
      executeRemote: async () => {
        remoteCalls += 1;
        return remoteCalls === 1
          ? { exitCode: 0, stdout: JSON.stringify({ path: remoteArchivePath, bytes: archiveBytes.length, sha256 }), stderr: '' }
          : { exitCode: 0, stdout: JSON.stringify({ removed: true }), stderr: '' };
      },
      downloadFile: async (_worker, _remotePath, localPath) => fs.writeFileSync(localPath, archiveBytes),
      runLocalProcess: async (_executable, args) => {
        if (args[0] === '-tf') return { exitCode: 0, signal: null, stdout: 'c04/\nc04/shard-cell-result.json\n', stderr: '' };
        if (args[0] === '-tvf') return { exitCode: 0, signal: null, stdout: 'd c04/\n- c04/shard-cell-result.json\n', stderr: '' };
        const extractRoot = args[args.indexOf('-C') + 1];
        fs.mkdirSync(path.join(extractRoot, 'c04'));
        fs.writeFileSync(path.join(extractRoot, 'c04', 'shard-cell-result.json'), '{}\n');
        return { exitCode: 0, signal: null, stdout: '', stderr: '' };
      },
      validateExtracted: async (staged) => {
        fs.writeFileSync(path.join(path.dirname(staged), 'cleanup-blocker.txt'), 'retain diagnostic\n');
      },
    });
    assert.equal(result.localDirectory, finalDirectory);
    assert.equal(fs.existsSync(path.join(finalDirectory, 'shard-cell-result.json')), true);
    assert.equal(remoteCalls, 2);
    assert.equal(
      fs.readdirSync(path.dirname(finalDirectory)).some((name) => name.startsWith('.incoming-')),
      true,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('remote directory collection never publishes validation-shards when staged validation fails', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-cell-archive-reject-'));
  const finalDirectory = path.join(root, 'validation-shards', 'vm167', 'runs', 'c04');
  const archiveBytes = Buffer.from('invalid-cell-archive');
  const sha256 = crypto.createHash('sha256').update(archiveBytes).digest('hex');
  const remoteDirectory = 'E:\\omni-shards\\execution\\vm167\\runs\\c04';
  const remoteArchivePath = `${remoteDirectory}.collection-lease-test.tar`;
  let remoteCalls = 0;
  try {
    await assert.rejects(collectRemoteDirectoryArchive({
      worker: { workerId: 'vm167' }, remoteDirectory, localDirectory: finalDirectory,
      remoteArchivePath, timeoutMs: 30_000, nonce: 'fixture-reject',
      executeRemote: async () => {
        remoteCalls += 1;
        return remoteCalls === 1
          ? { exitCode: 0, stdout: JSON.stringify({ path: remoteArchivePath, bytes: archiveBytes.length, sha256 }), stderr: '' }
          : { exitCode: 0, stdout: JSON.stringify({ removed: true }), stderr: '' };
      },
      downloadFile: async (_worker, _remotePath, localPath) => fs.writeFileSync(localPath, archiveBytes),
      runLocalProcess: async (_executable, args) => {
        if (args[0] === '-tf') return { exitCode: 0, signal: null, stdout: 'c04/\nc04/shard-cell-result.json\n', stderr: '' };
        if (args[0] === '-tvf') return { exitCode: 0, signal: null, stdout: 'd c04/\n- c04/shard-cell-result.json\n', stderr: '' };
        const extractRoot = args[args.indexOf('-C') + 1];
        fs.mkdirSync(path.join(extractRoot, 'c04'));
        fs.writeFileSync(path.join(extractRoot, 'c04', 'shard-cell-result.json'), '{}\n');
        return { exitCode: 0, signal: null, stdout: '', stderr: '' };
      },
      validateExtracted: async () => { throw new Error('fixture manifest mismatch'); },
    }), /fixture manifest mismatch/u);
    assert.equal(fs.existsSync(finalDirectory), false);
    assert.equal(remoteCalls, 2);
    assert.equal(
      fs.readdirSync(path.dirname(finalDirectory)).some((name) => name.startsWith('.incoming-')),
      true,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});



test('readiness batch transport uploads one deterministic archive with the exact signed inventory', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-readiness-batch-'));
  try {
    const files = [
      { path: 'shard-execution-plan.json', targetKind: 'execution', content: 'plan-v1' },
      { path: 'scripts/testing/worker.mjs', targetKind: 'workspace', content: 'worker-v1' },
      { path: 'target/release/runtime.exe', targetKind: 'workspace', content: 'runtime-v1' },
    ];
    const transferEntries = files.map((entry, index) => {
      const localPath = path.join(root, 'source-' + index);
      fs.writeFileSync(localPath, entry.content, 'utf8');
      const bytes = fs.readFileSync(localPath);
      return {
        ...entry, localPath, remotePath: 'C:\\fixture\\' + entry.path.replaceAll('/', '\\'),
        bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      };
    });
    const worker = { workerId: 'vm169', workspaceRoot: 'C:\\watch-worker' };
    const uploads = [];
    const executions = [];
    const transfer = await stageProductionReadinessBatch({
      worker, transferEntries, coordinatorExecutionRoot: root,
      remoteRoot: 'C:\\omni-shards\\execution\\vm169',
      uploadFile: async (_worker, localPath, remotePath) => { uploads.push({ localPath, remotePath }); },
      executeRemote: async (_worker, body, payload) => { executions.push({ body, payload }); },
    });
    assert.equal(uploads.length, 1);
    assert.equal(path.basename(uploads[0].localPath), 'readiness-transfer.tar');
    assert.equal(executions.length, 1);
    assert.deepEqual(transfer.entries.map((entry) => entry.path), files.map((entry) => entry.path));
    assert.deepEqual(executions[0].payload.archive.entries.map((entry) => ({
      memberPath: entry.memberPath, path: entry.path, targetKind: entry.targetKind,
    })), files.map((entry, index) => ({
      memberPath: 'payload/' + String(index).padStart(4, '0'), path: entry.path, targetKind: entry.targetKind,
    })));
    const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar';
    const listed = spawnSync(tar, ['-tf', uploads[0].localPath], { encoding: 'utf8', windowsHide: true });
    assert.equal(listed.status, 0, listed.stderr);
    assert.deepEqual(listed.stdout.trim().split(/\r?\n/u), files.map((_, index) => 'payload/' + String(index).padStart(4, '0')));
    const second = createDeterministicReadinessTransferArchive({
      archivePath: path.join(root, 'second.tar'), entries: transferEntries,
    });
    assert.equal(second.sha256, transfer.sha256);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('readiness batch extraction failure is terminal before any Provider invocation', { skip: process.platform !== 'win32' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-readiness-batch-failure-'));
  try {
    const localPath = path.join(root, 'plan.json');
    fs.writeFileSync(localPath, '{}\n', 'utf8');
    const bytes = fs.readFileSync(localPath);
    const workspaceRoot = path.join(root, 'workspace');
    const remoteRoot = path.join(root, 'remote');
    fs.mkdirSync(workspaceRoot);
    fs.mkdirSync(remoteRoot);
    let uploads = 0;
    let providerCalls = 0;
    await assert.rejects(async () => {
      await stageProductionReadinessBatch({
        worker: { workerId: 'vm131', workspaceRoot },
        transferEntries: [{
          path: 'shard-execution-plan.json', targetKind: 'execution', localPath,
          remotePath: 'C:\\omni-shards\\execution\\vm131\\shard-execution-plan.json',
          bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        }],
        coordinatorExecutionRoot: root, remoteRoot,
        uploadFile: async (_worker, archivePath, remoteArchivePath) => {
          uploads += 1;
          fs.copyFileSync(archivePath, remoteArchivePath);
          fs.appendFileSync(remoteArchivePath, 'corruption');
        },
        executeRemote: async (_worker, body, payload) => {
          const script = path.join(root, 'extract.ps1');
          fs.writeFileSync(script, remotePowerShellInvocation(body, payload, { mode: 'file-only' }).fileScript, 'utf8');
          const result = spawnSync('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
          ], { encoding: 'utf8', windowsHide: true, env: windowsPowerShellEnvironment(process.env) });
          if (result.status !== 0) throw new Error(result.stderr + result.stdout);
        },
      });
      providerCalls += 1;
    }, /archive hash.*size mismatch/u);
    assert.equal(uploads, 1);
    assert.equal(providerCalls, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('pre-distributed runtime skips only exact hashes with complete unique inventory', () => {
  const entries = [{path: 'a.exe', bytes: 10, sha256: 'a'.repeat(64)}, {path: 'b.exe', bytes: 20, sha256: 'b'.repeat(64)}];
  const observed = entries.map((entry) => ({...entry, exists: true}));
  assert.deepEqual(selectChangedRuntimeEntries(entries, observed), []);
  assert.deepEqual(selectChangedRuntimeEntries(entries, [{...observed[0], sha256: 'c'.repeat(64)}, observed[1]]), [entries[0]]);
  assert.deepEqual(selectChangedRuntimeEntries(entries, [observed[0], {...observed[1], exists: false}]), [entries[1]]);
  assert.deepEqual(selectChangedRuntimeEntries(entries, [observed[0], {...observed[1], bytes: 21}]), [entries[1]]);
  assert.throws(() => selectChangedRuntimeEntries(entries, [observed[0], observed[0]]), /exactly once/);
  assert.throws(() => selectChangedRuntimeEntries(entries, [observed[0]]), /exactly once/);
});

test('isolation collector absolute path and CLI relative path resolve to the same authority', () => {
  const workspaceRoot = path.resolve(os.tmpdir(), 'omni-isolation-path-fixture');
  const relative = 'artifacts/testing/watch-mode-local-isolation/run/local-isolation-manifest.json';
  const absolute = path.resolve(workspaceRoot, relative);
  assert.equal(resolveLocalIsolationAuthorityPath(absolute, { workspaceRoot }), absolute);
  assert.equal(resolveLocalIsolationAuthorityPath(relative, { workspaceRoot }), absolute);
  assert.throws(() => resolveLocalIsolationAuthorityPath(path.resolve(workspaceRoot, '../outside/local-isolation-manifest.json'), { workspaceRoot }));
  assert.throws(() => resolveLocalIsolationAuthorityPath('../outside/local-isolation-manifest.json', { workspaceRoot }));
  assert.throws(() => resolveLocalIsolationAuthorityPath(path.resolve(workspaceRoot, 'artifacts/testing/watch-mode-local-isolation-evil/local-isolation-manifest.json'), { workspaceRoot }));
  assert.throws(() => resolveLocalIsolationAuthorityPath(absolute.replace('local-isolation-manifest.json', 'wrong.json'), { workspaceRoot }));
});

test('isolation resolver rejects junction ancestry without touching the external target', () => {
  for (const location of ['workspace', 'authority-root', 'run', 'dangling-run']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-isolation-junction-'));
    const workspaceRoot = path.join(root, 'workspace');
    const authorityRoot = path.join(workspaceRoot, 'artifacts/testing/watch-mode-local-isolation');
    const target = path.join(root, 'outside-authority');
    const junction = location === 'workspace' ? workspaceRoot
      : location === 'authority-root' ? authorityRoot : path.join(authorityRoot, 'run');
    const relative = 'artifacts/testing/watch-mode-local-isolation/run/local-isolation-manifest.json';
    const absolute = path.join(workspaceRoot, relative);
    const dangling = location === 'dangling-run';
    let linked = false;
    try {
      fs.mkdirSync(path.dirname(junction), { recursive: true });
      if (!dangling) {
        fs.mkdirSync(target);
        fs.writeFileSync(path.join(target, 'sentinel.txt'), 'do not alter external evidence', 'utf8');
      }
      fs.symlinkSync(target, junction, process.platform === 'win32' ? 'junction' : 'dir');
      linked = true;
      assert.ok(fs.lstatSync(junction).isSymbolicLink());
      assert.throws(() => resolveLocalIsolationAuthorityPath(absolute, { workspaceRoot }), /reparse|symlink/i, location);
      assert.throws(() => resolveLocalIsolationAuthorityPath(relative, { workspaceRoot }), /reparse|symlink/i, location);
    } finally {
      // Unlink only the verified fixture link, never recursively remove its target.
      if (linked) {
        assert.ok(path.resolve(junction).startsWith(`${path.resolve(root)}${path.sep}`));
        assert.ok(fs.lstatSync(junction).isSymbolicLink());
        fs.unlinkSync(junction);
      }
      if (!dangling && fs.existsSync(target)) {
        assert.equal(fs.readFileSync(path.join(target, 'sentinel.txt'), 'utf8'), 'do not alter external evidence');
      }
      assert.equal(fs.realpathSync(root), path.resolve(root));
      assert.ok(path.resolve(root).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
      assert.ok(path.resolve(target).startsWith(`${path.resolve(root)}${path.sep}`));
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('isolation resolver accepts regular ancestors and missing manifest descendants', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-isolation-regular-'));
  try {
    const relative = 'artifacts/testing/watch-mode-local-isolation/new/run/local-isolation-manifest.json';
    fs.mkdirSync(path.join(root, 'artifacts/testing/watch-mode-local-isolation'), { recursive: true });
    const absolute = path.join(root, relative);
    assert.equal(resolveLocalIsolationAuthorityPath(relative, { workspaceRoot: root }), absolute);
    assert.equal(resolveLocalIsolationAuthorityPath(absolute, { workspaceRoot: root }), absolute);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, '{}', 'utf8');
    assert.equal(resolveLocalIsolationAuthorityPath(relative, { workspaceRoot: root }), absolute);
    assert.equal(resolveLocalIsolationAuthorityPath(absolute, { workspaceRoot: root }), absolute);
  } finally {
    assert.equal(fs.realpathSync(root), path.resolve(root));
    assert.ok(path.resolve(root).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

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

test('owned c04 observer survives peer stop signal until its bounded task publishes final evidence', async () => {
  const controller = new AbortController();
  let publishTerminal;
  let observedExit = false;
  let completed = false;
  const state = { phase: 'owned-task-running', launches: 0, providerCalls: 0 };
  const observing = observeOwnedCellCompletion({
    signal: controller.signal, timeoutMs: 1_000,
    execute: ({ signal, timeoutMs }) => {
      assert.equal(timeoutMs, 1_000);
      state.launches += 1;
      return new Promise((resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('SSH observer aborted before guest terminal')), { once: true });
        publishTerminal = () => { observedExit = true; state.phase = 'terminal-and-files-collected'; resolve(state); };
      });
    },
  });
  observing.then(() => { completed = true; }, () => { completed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error('c02 finalizer rejected'));
  await new Promise((resolve) => setImmediate(resolve));
  const prematurelyCompleted = completed;
  publishTerminal();
  const result = await observing;
  assert.equal(prematurelyCompleted, false, 'peer cancellation must not sever terminal observation');
  assert.equal(observedExit, true);
  assert.equal(result.phase, 'terminal-and-files-collected');
  assert.equal(result.launches, 1);
  assert.equal(result.providerCalls, 0);
});

test('owned observer enforces a finite timebox and preserves raw failures without promoting them', async () => {
  let captured = 0;
  const pending = observeOwnedCellCompletion({ timeoutMs: 20,
    execute: ({ timeoutMs }) => { assert.equal(timeoutMs, 20); return new Promise(() => {}); },
    preserveFailure: async () => { captured += 1; return { manifestPath: 'diagnostics-only.json' }; },
  });
  let timeoutError;
  await assert.rejects(pending, (error) => {
    assert.match(error.message, /owned cell terminal observation.*timed out/);
    timeoutError = error;
    assert.equal(error.result, undefined);
    return true;
  });
  assert.equal(captured, 0, 'failure must reach stopAll before diagnostic I/O');
  await timeoutError.collectFailureEvidence();
  assert.equal(timeoutError.failureEvidence.manifestPath, 'diagnostics-only.json');
  assert.equal(captured, 1);
  const primary = new Error('provider input budget ledger is not a strict terminal success');
  await assert.rejects(observeOwnedCellCompletion({ timeoutMs: 1_000,
    execute: async () => { throw primary; },
    preserveFailure: async () => { throw new Error('copy failed'); },
  }), (error) => {
    assert.equal(error, primary);
    return true;
  });
  await primary.collectFailureEvidence();
  assert.equal(primary.failureEvidenceErrors[0].code, 'watch.collection.failed-cell-unavailable');
  const controller = new AbortController();
  controller.abort(primary);
  await assert.rejects(observeOwnedCellCompletion({ signal: controller.signal, timeoutMs: 1_000,
    execute: () => assert.fail('aborted cell must not launch'),
  }), (error) => error === primary);
});

test('failed finalizer file preservation is allowlisted, byte/hash verified and diagnostics-only', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-failed-preserve-'));
  const plan = { executionId: 'fixture-execution', planDigest: 'a'.repeat(64) };
  const cell = { cellIndex: 1, cellId: 'c02', workerId: 'vm169' };
  const lease = { leaseId: 'lease-fixture', leaseDigest: 'b'.repeat(64) };
  const bytes = Buffer.from('{"finalized":false,"terminalReason":null}');
  const entry = { path: 'runs/c02/provider-input-budget-ledger.json', bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  try {
    const evidence = await preserveFailedCellEvidence({ plan, cell, lease, directory: path.join(root, 'saved'),
      inventory: [entry], download: async (_source, destination) => fs.writeFileSync(destination, bytes),
    });
    const manifest = JSON.parse(fs.readFileSync(evidence.manifestPath, 'utf8'));
    assert.equal(manifest.status, 'diagnostics-only');
    assert.equal(manifest.verdict, undefined);
    assert.equal(manifest.files[0].sha256, entry.sha256);
    assert.ok(manifest.missing.includes('runs/c02/watch-session-report.json'));
    assert.equal(failedCellEvidencePaths(cell, lease).some((name) => /backup|credential|private|desktop-env/i.test(name)), false);
    for (const name of ['../escape.log', 'runs/c02/desktop-env.local.backup', 'private/key', 'runs/c04/report.json']) {
      await assert.rejects(preserveFailedCellEvidence({ plan, cell, lease, directory: path.join(root, 'bad'),
        inventory: [{ ...entry, path: name }], download: () => assert.fail('must reject before read/download'),
      }), /inventory authority invalid/);
    }
    await assert.rejects(preserveFailedCellEvidence({ plan, cell, lease, directory: path.join(root, 'changed'),
      inventory: [entry], download: async (_source, destination) => fs.writeFileSync(destination, 'changed'),
    }), /hash\/size changed/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
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
      startedCellIds: ['a', 'c', 'b'],
      completedCellIds: ['c', 'a', 'b'],
      collectedFailures: [failed('b'), failed('a')],
    },
  });
  assert.deepEqual(summary.attempted, ['a', 'b', 'c']);
  assert.deepEqual(summary.completed, ['a', 'b', 'c']);
  assert.deepEqual(summary.passed, ['c']);
  assert.deepEqual(summary.failed, ['a', 'b']);
  assert.deepEqual(summary.failures.map((entry) => entry.cellId), ['a', 'b']);
  assert.equal(summary.sharedRootCauses.length, 1);
  assert.deepEqual(summary.sharedRootCauses[0].cellIds, ['a', 'b']);
  assert.equal(summary.cellSpecificFailures.length, 0);
});

test('production failure aggregation rejects duplicate and unknown runtime cell IDs', () => {
  const plan = {
    cells: [
      { cellId: 'a', feedbackLoopPrevention: 'process-exclusion' },
      { cellId: 'b', feedbackLoopPrevention: 'echo-cancel' },
    ],
  };
  const failed = (cellId) => ({
    cellId,
    error: 'fixture failure',
    outcome: {
      result: {
        verdict: 'failed',
        failureLayer: 'provider',
        stableErrorCode: 'watch.provider.session-failed',
        lifecyclePhase: 'provider-session',
        failureContext: {
          endpointId: '{fixture-endpoint}',
          bridgeInstanceId: null,
          ownerGenerationTransition: { before: null, after: null },
        },
      },
    },
  });
  const aggregate = (changed) => aggregateProductionCellFailures({
    plan,
    waveOutcome: {
      startedCellIds: ['a', 'b'],
      completedCellIds: ['a', 'b'],
      collectedFailures: [failed('a')],
      ...changed,
    },
  });
  assert.throws(() => aggregate({ startedCellIds: ['a', 'a'] }), /duplicate attempted cell IDs/u);
  assert.throws(() => aggregate({ completedCellIds: ['a', 'unknown'] }), /unknown completed cell ID: unknown/u);
  assert.throws(() => aggregate({ collectedFailures: [failed('a'), failed('a')] }), /duplicate failed cell ID: a/u);
  assert.throws(() => aggregate({ collectedFailures: [failed('unknown')] }), /unknown failed cell ID: unknown/u);
  assert.throws(() => aggregateProductionCellFailures({
    plan: { cells: [...plan.cells, plan.cells[0]] },
    waveOutcome: { startedCellIds: [], completedCellIds: [], collectedFailures: [] },
  }), /duplicate planned cell IDs/u);
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
  assert.match(source, /update-index --refresh -- @refreshPaths/u);
  assert.match(source, /implementation index refresh failed after byte verification/u);
  assert.match(source, /workspaceRoot: worker\.workspaceRoot,\s*implementationEntries:/u);
  assert.match(source, /implementation verification returned an incomplete inventory/);
  assert.ok(
    source.indexOf('implementation mismatch: $target')
      < source.indexOf('update-index --refresh -- @refreshPaths'),
    'index refresh must happen only after exact implementation byte verification',
  );
  assert.ok(
    source.indexOf('update-index --refresh -- @refreshPaths')
      < source.lastIndexOf('await queryWorker(worker)'),
    'index refresh must happen before the final clean-state guard',
  );
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
  assert.equal(AUTHORITY_IMPLEMENTATION_FILES.length, 63);
  assert.ok(AUTHORITY_IMPLEMENTATION_FILES.includes('scripts/testing/prepare-watch-release.mjs'));
  assert.ok(AUTHORITY_IMPLEMENTATION_FILES.includes('scripts/testing/distribute-watch-runtime.mjs'));
});

test('fresh readiness transports all 63 production implementation entries', () => {
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
  assert.equal(plan.authority.implementationHashes.length, 63);
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
  assert.equal(PRODUCTION_COORDINATOR_TIMEOUT_MS, 14_062_000);
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

for (const [label, receipt] of [['undefined', undefined], ['false', false], ['negative', { passed: false }],
  ['positive', { passed: true, cleanupErrors: [] }]]) {
  test(`outer coordinator cleanup requires positive receipt: ${label}`, async () => {
    const executionId = `cleanup-receipt-${crypto.randomUUID()}`;
    const outputRoot = path.join(repoRoot, 'artifacts', 'testing', 'watch-mode-live-coordinator');
    const statePath = path.join(outputRoot, `${executionId}.coordinator-state.json`);
    let calls = 0;
    try {
      await assert.rejects(runProductionCoordinator({ workerConfig: null,
        runtimeAuthority: 'missing-runtime.json', localIsolationAuthority: 'missing-local.json',
        executionId, coordinatorOutputRoot: outputRoot,
        operations: { cleanupOwnedResources: async () => { calls += 1; return receipt; } },
      }));
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      assert.equal(calls, 1);
      assert.equal(state.stage, label === 'positive' ? 'cleanup-completed' : 'cleanup-incomplete');
      assert.equal(state.cleanupErrors.length, label === 'positive' ? 0 : 1);
      assert.ok(state.primaryError.message);
    } finally { fs.rmSync(statePath, { force: true }); }
  });
}

function rawWorkerConfig(root, workerIds = ['vm1']) {
  if (workerIds.length === 4) {
    fs.writeFileSync(path.join(root, 'vm131-key'), 'fixture-private-key');
    fs.writeFileSync(path.join(root, 'vm131-hosts'), `vm131 ssh-ed25519 ${Buffer.from('fixture-vm131-host-key').toString('base64')}\n`);
  }
  const defaultProfile = (workerId) => ({
    instanceId: `${workerId}-default`,
    profileId: 'vmware-hda-default',
    deviceClass: 'default-speaker',
    physicalPlaybackDeviceId: '{0.0.0.00000000}.{a609dee5-4ffd-49d6-b7f2-705cfa934363}',
    expectedPhysicalPlaybackDeviceName: '扬声器 (High Definition Audio Device)',
  });
  return {
    schemaVersion: 3,
    artifactKind: PRODUCTION_WORKER_CONFIG_KIND,
    providerPreflightExecutor: { workerId: workerIds.at(-1) },
    workers: workerIds.map((workerId) => ({
      workerId, user: 'VMUser',
      transport: workerIds.length === 4 && workerId === 'vm131'
        ? { kind: 'ssh', host: '192.0.2.131', port: 22, identityFile: path.join(root, 'vm131-key'), knownHostsFile: path.join(root, 'vm131-hosts'), hostKeyAlias: 'vm131' }
        : { kind: 'local' },
      workspaceRoot: 'E:\\watch-worker', guestExecutionRoot: 'E:\\omni-shards',
      vmIdentity: { provider: 'vmware', uuidBios: `56-4d-${workerId}` },
      deviceProfileInstances: [defaultProfile(workerId)],
    })),
  };
}

test('production worker config v3 accepts one local worker and rejects unbound fields', () => {
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

test('remote preflight transport runs executor-bound network health before credential pipe, uploads only authorization files, and never retries', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-remote-preflight-'));
  try {
    const authorizationRoot = path.join(root, 'authorization');
    fs.mkdirSync(path.join(authorizationRoot, 'provider-preflight-lease-reservations'), { recursive: true });
    fs.mkdirSync(path.join(authorizationRoot, 'worker-readiness'), { recursive: true });
    for (const relative of [
      'provider-preflight-grant.json', 'worker-readiness-request.json',
      'provider-preflight-lease-reservations/01-c01.json',
      'worker-readiness/vm131.json',
    ]) {
      const target = path.join(authorizationRoot, ...relative.split('/'));
      fs.writeFileSync(target, relative === 'worker-readiness/vm131.json' ? JSON.stringify({
        workerId: 'vm131',
        interactiveSession: {
          sessionId: 1,
          ownerSid: 'S-1-5-21-1000',
          desktop: 'WinSta0\\Default',
        },
      }) : '{}\n', 'utf8');
    }
    const localEvidenceDirectory = path.join(root, 'collected', 'final-evidence');
    const events = [];
    const executor = {
      workerId: 'vm131', user: 'VMUser', workspaceRoot: 'E:\\watch-worker',
      guestExecutionRoot: 'E:\\omni-shards', vmIdentity: { provider: 'vmware', uuidBios: 'fixture' },
      transport: {
        kind: 'ssh', hostKeyAlias: 'vm131', hostKeyAlgorithm: 'ssh-ed25519',
        hostKeySha256: `SHA256:${'A'.repeat(43)}`,
      }, host: '192.0.2.131', port: 22,
      identityFile: 'E:\\id_rsa', knownHostsFile: 'E:\\known_hosts', hostKeyAlias: 'vm131',
    };
    let providerRuns = 0;
    let controllerSource = '';
    let launcherSource = '';
    let parsedControlScripts = false;
    let terminalFixture = null;
    let processAuthorityText = '';
    let controllerMode = 'success';
    let publicationSource = '';
    const runProcess = async (executable, args, options = {}) => {
      const joined = args.join(' ');
      const encodedIndex = args.indexOf('-EncodedCommand');
      const remoteSource = encodedIndex >= 0
        ? Buffer.from(args[encodedIndex + 1], 'base64').toString('utf16le')
        : joined;
      if (executable === 'ssh.exe' && remoteSource.includes('watch-mode-provider-network-health.mjs')) {
        events.push('network-health');
        assert.match(remoteSource, /Set-Location -LiteralPath 'E:\\watch-worker'/u);
        const request = JSON.parse(String(options.input));
        return { exitCode: 0, stdout: `${JSON.stringify({
          schemaVersion: 1,
          artifactKind: 'watch-mode-provider-network-health',
          executionId: 'remote-preflight-order',
          providerCalls: 0,
          verdict: 'passed',
          executor: request.executor,
        })}\n`, stderr: '' };
      }
      if (executable === 'ssh.exe' && joined.includes('provider-preflight-controller.ps1')) {
        events.push('provider'); providerRuns += 1;
        if (!parsedControlScripts) {
          const parserPath = path.join(root, 'parse-control.ps1');
          fs.writeFileSync(parserPath, '$tokens=$null;$errors=$null;[Management.Automation.Language.Parser]::ParseFile($args[0],[ref]$tokens,[ref]$errors)|Out-Null;if($errors.Count){$errors|ForEach-Object{$_.ToString()};exit 1}\n', 'utf8');
          for (const [name, source] of [['controller.ps1', controllerSource], ['launcher.ps1', launcherSource]]) {
            const scriptPath = path.join(root, name);
            fs.writeFileSync(scriptPath, source, 'utf8');
            const parser = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', parserPath, scriptPath],
            { encoding: 'utf8' });
            assert.equal(parser.status, 0, `${name}: ${parser.stdout}\n${parser.stderr}`);
          }
          parsedControlScripts = true;
        }
        assert.match(controllerSource, /New-ScheduledTaskPrincipal[^\n]+-LogonType Interactive -RunLevel Limited/u);
        assert.match(controllerSource, /interactive Provider preflight terminal authority mismatch/u);
        assert.match(controllerSource, /Principal\.UserId -cne \$expectedSid/u);
        assert.match(controllerSource, /provider-preflight-interactive-launcher\.ps1/u);
        assert.match(controllerSource, /FileMode\]::CreateNew/u);
        assert.match(controllerSource, /controller authority mismatch/u);
        assert.match(controllerSource, /launcher authority mismatch/u);
        assert.match(controllerSource, /sessionId -ne \$expectedSessionId/u);
        assert.match(controllerSource, /provider-preflight-cleanup/u);
        assert.match(controllerSource, /Get-Command node\.exe -CommandType Application/u);
        assert.doesNotMatch(controllerSource, /api.?key|credential|secret/i);
        assert.equal(args.includes('-EncodedCommand'), false);
        assert.doesNotMatch(String(options.input), /api.?key|credential|secret/i);
        const argument = (name) => args[args.indexOf(name) + 1];
        processAuthorityText = JSON.stringify({
          schemaVersion: 1, artifactKind: 'watch-mode-provider-preflight-process-authority',
          executionId: 'remote-preflight-order', workerId: 'vm131', expectedSessionId: 1,
          expectedOwnerSid: 'S-1-5-21-1000',
          launcher: { pid: 100, parentPid: 50, imagePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', startedAt: new Date().toISOString(), sessionId: 1, ownerSid: 'S-1-5-21-1000' },
          worker: { pid: 101, parentPid: 100, imagePath: 'C:\\Program Files\\nodejs\\node.exe', startedAt: new Date().toISOString(), sessionId: 1, ownerSid: 'S-1-5-21-1000' },
          descendants: [{ pid: 102, parentPid: 101, imagePath: 'E:\\watch-worker\\target\\release\\omni-desktop-shell.exe', startedAt: new Date().toISOString(), sessionId: 1, ownerSid: 'S-1-5-21-1000' }],
        });
        const processAuthoritySha256 = crypto.createHash('sha256').update(processAuthorityText, 'utf8').digest('hex');
        terminalFixture = {
          schemaVersion: 1, artifactKind: 'watch-mode-provider-preflight-interactive-terminal',
          executionId: 'remote-preflight-order', workerId: 'vm131',
          authorizationDigest: 'a'.repeat(64), controllerSha256: argument('-ControllerSha256'),
          launcherSha256: argument('-LauncherSha256'), processAuthoritySha256,
          requestSha256: crypto.createHash('sha256').update(String(options.input), 'utf8').digest('hex'),
          taskName: 'OmniPreflight-6bde723257b39bd495a3403f', taskPath: '\\OmniTranslate\\',
          exitCode: 0, sessionId: 1, ownerSid: 'S-1-5-21-1000', desktop: 'WinSta0\\Default',
          completedAt: new Date().toISOString(),
        };
        if (controllerMode === 'throw') throw new Error('simulated SSH transport termination');
        return { exitCode: controllerMode === 'nonzero' ? 23 : 0, stdout: `${JSON.stringify({ status: 'completed', outputDirectory: 'E:\\omni-shards\\provider-preflight-evidence', fields: {} })}\n`, stderr: controllerMode === 'nonzero' ? 'simulated controller failure' : '' };
      }
      if (executable === 'ssh.exe' && remoteSource.includes('publication script SHA-256 mismatch')) {
        events.push('publication-verify');
        assert.equal(args.includes('-EncodedCommand'), true);
        assert.ok(joined.length < 4_000, 'publication verification must remain a short remote command');
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (executable === 'ssh.exe' && args.includes('-File') && /publish-[a-f0-9]{24}\.ps1/u.test(joined)) {
        events.push('publication-execute');
        assert.equal(args.includes('-EncodedCommand'), false);
        assert.equal(options.input, '');
        const output = Buffer.from(JSON.stringify({ published: true }), 'utf8').toString('base64');
        return { exitCode: 0, stdout: `__OMNI_REMOTE_OUTPUT_V1__${output}\n__OMNI_REMOTE_COMPLETE_V1__\n`, stderr: '' };
      }
      if (executable === 'ssh.exe' && remoteSource.includes('publication script cleanup did not remove the exact file')) {
        events.push('publication-cleanup');
        assert.equal(args.includes('-EncodedCommand'), true);
        assert.match(remoteSource, /Remove-Item -LiteralPath \$p -Force/u);
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (executable === 'ssh.exe') { events.push('mkdir'); return { exitCode: 0, stdout: '{}\n', stderr: '' }; }
      if (joined.includes('provider-preflight-consumption-claim.json')) {
        events.push('claim'); fs.writeFileSync(windowsPathFromGitScpOperand(args.at(-1)), '{}\n', 'utf8');
      } else if (joined.includes('provider-preflight-worker.terminal.json')) {
        events.push('terminal'); fs.writeFileSync(windowsPathFromGitScpOperand(args.at(-1)), JSON.stringify(terminalFixture), 'utf8');
      } else if (joined.includes('provider-preflight-process-authority.json')) {
        events.push('process-authority'); fs.writeFileSync(windowsPathFromGitScpOperand(args.at(-1)), processAuthorityText, 'utf8');
      } else if (joined.includes('provider-preflight-cleanup.json')) {
        events.push('cleanup');
        fs.writeFileSync(windowsPathFromGitScpOperand(args.at(-1)), JSON.stringify({
          schemaVersion: 1, artifactKind: 'watch-mode-provider-preflight-cleanup',
          executionId: 'remote-preflight-order', workerId: 'vm131',
          taskName: 'OmniPreflight-6bde723257b39bd495a3403f', taskPath: '\\OmniTranslate\\',
          processAuthoritySha256: terminalFixture.processAuthoritySha256,
          taskAbsent: true, identitiesEnded: true, temporaryFilesAbsent: true, attemptErrors: [], passed: true,
          completedAt: new Date().toISOString(),
        }), 'utf8');
      } else if (joined.includes('provider-preflight-evidence')) {
        events.push('evidence');
        fs.mkdirSync(path.join(path.dirname(localEvidenceDirectory), 'provider-preflight-evidence'), { recursive: true });
      } else {
        assert.doesNotMatch(args.at(-2), /watch-remote-preflight/u, 'authorization uploads must use a short local staging path');
        const uploadedSource = fs.readFileSync(windowsPathFromGitScpOperand(args.at(-2)), 'utf8');
        if (/publish-[a-f0-9]{24}\.ps1/u.test(joined)) {
          publicationSource = uploadedSource;
          assert.match(publicationSource, /ConvertTo-ExtendedLengthPath/u);
          assert.match(publicationSource, /__OMNI_REMOTE_OUTPUT_V1__/u);
        } else if (joined.includes('provider-preflight-controller.ps1')) controllerSource = uploadedSource;
        else if (joined.includes('provider-preflight-interactive-launcher.ps1')) launcherSource = uploadedSource;
        else if (!joined.includes('provider-preflight-interactive-launcher.ps1')
          && !uploadedSource.includes('"interactiveSession"')) assert.equal(uploadedSource, '{}\n');
        assert.match(args.at(-1), /:E:\/omni-shards\/\.provider-preflight\/[a-f0-9]{20}\//u);
        assert.ok(args.at(-1).length < 240, 'remote authorization upload must remain below the legacy Windows path ceiling');
        events.push(`upload:${path.basename(args.at(-2))}`);
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const makeTransport = () => createSshProviderPreflightTransport({
      config: { sshExecutable: 'ssh.exe', scpExecutable: 'scp.exe' }, executor,
      executionId: 'remote-preflight-order', authorizationRoot, localEvidenceDirectory, runProcess,
      workspaceRoot: root,
      runtimeBinaryHashes: signedCredentialHelperFixture(root),
      verifyExecutor: async () => { events.push('verify'); },
      signingKeys: generateCoordinatorSigningKeyPair(),
      provision: async (options) => {
        events.push('credential');
        assert.doesNotMatch(JSON.stringify(options), /api.?key|secret/i);
      },
    });
    const readinessAuthority = fileAuthorityEntry(
      path.join(authorizationRoot, 'worker-readiness', 'vm131.json'), 'worker-readiness/vm131.json',
    );
    const grant = { executor: {
      workerId: 'vm131', interactiveUser: 'VMUser', vmIdentity: executor.vmIdentity,
      transportAuthority: {
        kind: 'ssh', hostKeyAlias: 'vm131', hostKeyAlgorithm: 'ssh-ed25519',
        hostKeySha256: `SHA256:${'A'.repeat(43)}`,
      },
      vmIdentityDigest: sha256Canonical(executor.vmIdentity),
      runtimeBundleDigest: 'b'.repeat(64),
      readinessAuthority: {
        ...readinessAuthority, providerCalls: 0, workerId: 'vm131',
      },
    } };
    const transport = makeTransport();
    const result = await transport.dispatch({ grant, authorizationDigest: 'a'.repeat(64) });
    assert.deepEqual(events.slice(0, 4), ['verify', 'network-health', 'credential', 'mkdir']);
    assert.ok(events.slice(4, 8).every((entry) => entry.startsWith('upload:')), JSON.stringify(events));
    assert.deepEqual(events.slice(8, 12), [
      'upload:publish-' + events[8].slice('upload:publish-'.length),
      'publication-verify', 'publication-execute', 'publication-cleanup',
    ], 'canonical publication must use verified file-only execution and exact cleanup');
    assert.deepEqual(events.slice(12, 15), [
      'upload:provider-preflight-interactive-launcher.ps1',
      'upload:provider-preflight-controller.ps1',
      'mkdir',
    ], 'canonical authorization publication must precede control upload: ' + JSON.stringify(events));
    assert.deepEqual(events.slice(-6), ['provider', 'terminal', 'process-authority', 'cleanup', 'claim', 'evidence']);
    assert.equal(providerRuns, 1);
    assert.equal(result.outputDirectory, path.resolve(localEvidenceDirectory));
    assert.deepEqual(fs.readdirSync(authorizationRoot).sort(), [
      'provider-preflight-consumption-claim.json',
      'provider-preflight-grant.json',
      'provider-preflight-lease-reservations',
      'worker-readiness',
      'worker-readiness-request.json',
    ], 'control receipts must not contaminate the exact signed authorization package');
    assert.deepEqual(fs.readdirSync(`${authorizationRoot}.control-evidence`).sort(), [
      'provider-preflight-cleanup.json',
      'provider-preflight-process-authority.json',
      'provider-preflight-worker.terminal.json',
    ]);
    await assert.rejects(transport.dispatch({ grant, authorizationDigest: 'a'.repeat(64) }), /single-use/);
    assert.equal(providerRuns, 1);
    for (const mode of ['nonzero', 'throw']) {
      controllerMode = mode;
      events.length = 0;
      await assert.rejects(
        makeTransport().dispatch({ grant, authorizationDigest: 'a'.repeat(64) }),
        (error) => error instanceof AggregateError
          && /collect-all evidence recovery/u.test(error.message)
          && error.errors.some((entry) => mode === 'nonzero'
            ? /failed with exit 23/u.test(entry.message)
            : /simulated SSH transport termination/u.test(entry.message)),
      );
      assert.deepEqual(events.slice(-6), ['provider', 'terminal', 'process-authority', 'cleanup', 'claim', 'evidence'], `${mode}: ${JSON.stringify(events)}`);
    }
    assert.equal(providerRuns, 3);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('provider preflight terminal replay/session substitution and cleanup failure are rejected by coordinator authority validators', () => {
  const expected = {
    executionId: 'execution-current', workerId: 'vm131', authorizationDigest: 'a'.repeat(64),
    controllerSha256: 'b'.repeat(64), launcherSha256: 'c'.repeat(64),
    processAuthoritySha256: 'e'.repeat(64), requestSha256: 'd'.repeat(64),
    taskName: 'OmniPreflight-current', sessionId: 1, ownerSid: 'S-1-5-21-1000', desktop: 'WinSta0\\Default',
  };
  const terminal = {
    schemaVersion: 1, artifactKind: 'watch-mode-provider-preflight-interactive-terminal',
    ...expected, taskPath: '\\OmniTranslate\\', exitCode: 0, completedAt: new Date().toISOString(),
  };
  assert.doesNotThrow(() => validateProviderPreflightInteractiveTerminal(terminal, expected));
  for (const changed of [
    { executionId: 'execution-replayed' }, { sessionId: 2 }, { requestSha256: 'e'.repeat(64) },
    { launcherSha256: 'f'.repeat(64) }, { ownerSid: 'S-1-5-21-2000' },
  ]) assert.throws(() => validateProviderPreflightInteractiveTerminal({ ...terminal, ...changed }, expected), /exact bound authority/u);
  const cleanupExpected = { executionId: expected.executionId, workerId: expected.workerId, taskName: expected.taskName, processAuthoritySha256: expected.processAuthoritySha256 };
  const cleanup = {
    schemaVersion: 1, artifactKind: 'watch-mode-provider-preflight-cleanup', ...cleanupExpected,
    taskPath: '\\OmniTranslate\\', taskAbsent: true, identitiesEnded: true,
    temporaryFilesAbsent: true, attemptErrors: [], passed: true, completedAt: new Date().toISOString(),
  };
  assert.doesNotThrow(() => validateProviderPreflightCleanupReceipt(cleanup, cleanupExpected));
  for (const changed of [{ taskAbsent: false }, { identitiesEnded: false }, { temporaryFilesAbsent: false }, { attemptErrors: ['failed'] }, { passed: false }]) {
    assert.throws(() => validateProviderPreflightCleanupReceipt({ ...cleanup, ...changed }, cleanupExpected), /positive bound authority/u);
  }
  const identity = { pid: 100, parentPid: 50, imagePath: 'C:\\Windows\\System32\\cmd.exe', startedAt: new Date().toISOString(), sessionId: 1, ownerSid: expected.ownerSid };
  const processAuthority = {
    schemaVersion: 1, artifactKind: 'watch-mode-provider-preflight-process-authority',
    executionId: expected.executionId, workerId: expected.workerId,
    expectedSessionId: 1, expectedOwnerSid: expected.ownerSid,
    launcher: identity, worker: { ...identity, pid: 101, parentPid: 100 },
    descendants: [{ ...identity, pid: 102, parentPid: 101 }],
  };
  assert.doesNotThrow(() => validateProviderPreflightProcessAuthority(processAuthority, expected));
  assert.throws(() => validateProviderPreflightProcessAuthority({ ...processAuthority, descendants: [{ ...identity, pid: 101 }] }, expected), /duplicate identities/u);
});

test('provider preflight control authority verification precedes Provider invocation accounting', () => {
  const source = fs.readFileSync(new URL('./run-watch-mode-live-production-coordinator.mjs', import.meta.url), 'utf8');
  const verification = source.indexOf("ensureSuccessful(controlVerificationResult, 'remote Provider preflight control authority verification')");
  const providerStart = source.indexOf('onProviderCallStarted();', verification);
  assert.ok(verification >= 0 && providerStart > verification);
  const boundary = source.slice(source.lastIndexOf('const controlVerification =', verification), providerStart);
  assert.match(boundary, /FileAttributes\]::ReparsePoint/u);
  assert.match(boundary, /Get-FileHash/u);
  assert.match(boundary, /entry\.bytes/u);
  assert.match(source, /launcher self authority mismatch/u);
  assert.match(source, /sessionId -ne \$expectedSessionId/u);
  assert.match(source, /FileMode\]::CreateNew/u);
  assert.match(source, /cleanup receipt is not a positive bound authority/u);
  assert.match(source, /attemptErrors=@\(\$cleanupErrors\); passed=\$false/u);
  assert.match(source, /\[IO\.FileMode\]::Create,/u, 'cleanup receipt must be idempotently overwritten with positive or negative state');
  assert.match(source, /sameStart -and \$sameImage/u, 'PID cleanup must compare captured creation identity before treating a PID as live');
  const readinessBlock = source.slice(source.indexOf('const readinessPath ='), source.indexOf('const requestText ='));
  assert.equal((readinessBlock.match(/fs\.readFileSync\(readinessPath\)/gu) ?? []).length, 1);
  assert.match(readinessBlock, /createHash\('sha256'\)\.update\(readinessBytes\)/u);
  assert.match(readinessBlock, /JSON\.parse\(readinessBytes\.toString/u);
});

test('remote executor network health failure is terminal before credential provision and Provider with no fallback', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-remote-network-health-failure-'));
  try {
    const authorizationRoot = path.join(root, 'authorization');
    fs.mkdirSync(path.join(authorizationRoot, 'provider-preflight-lease-reservations'), { recursive: true });
    fs.mkdirSync(path.join(authorizationRoot, 'worker-readiness'), { recursive: true });
    const executor = {
      workerId: 'vm131', user: 'VMUser', workspaceRoot: 'E:\\watch-worker',
      guestExecutionRoot: 'E:\\omni-shards', vmIdentity: { provider: 'vmware', uuidBios: 'fixture' },
      transport: { kind: 'ssh' }, host: '192.0.2.131', port: 22,
      identityFile: 'E:\\id_rsa', knownHostsFile: 'E:\\known_hosts', hostKeyAlias: 'vm131',
    };
    let credentialCalls = 0;
    let providerCalls = 0;
    let providerCallStarts = 0;
    const transport = createSshProviderPreflightTransport({
      config: { sshExecutable: 'ssh.exe', scpExecutable: 'scp.exe' }, executor,
      executionId: 'remote-health-failure', authorizationRoot,
      localEvidenceDirectory: path.join(root, 'evidence'),
      workspaceRoot: root,
      runtimeBinaryHashes: signedCredentialHelperFixture(root),
      verifyExecutor: async () => {},
      signingKeys: generateCoordinatorSigningKeyPair(),
      provision: async () => { credentialCalls += 1; },
      onProviderCallStarted: () => { providerCallStarts += 1; },
      runProcess: async (executable, args) => {
        const joined = args.join(' ');
        const encodedIndex = args.indexOf('-EncodedCommand');
        const remoteSource = encodedIndex >= 0
          ? Buffer.from(args[encodedIndex + 1], 'base64').toString('utf16le')
          : joined;
        if (remoteSource.includes('watch-mode-provider-network-health.mjs')) {
          return { exitCode: 1, stdout: `${JSON.stringify({
            schemaVersion: 1,
            artifactKind: 'watch-mode-provider-network-health',
            executionId: 'remote-health-failure',
            providerCalls: 0,
            verdict: 'failed',
            executor: grant.executor,
          })}\n`, stderr: 'provider network health failed before paid preflight authorization' };
        }
        if (joined.includes('run-watch-mode-provider-preflight-worker.mjs')) providerCalls += 1;
        return { exitCode: 0, stdout: '{}\n', stderr: '' };
      },
    });
    const grant = { executor: { workerId: 'vm131', interactiveUser: 'VMUser', vmIdentity: executor.vmIdentity, readinessAuthority: { providerCalls: 0 } } };
    await assert.rejects(
      transport.dispatch({ grant, authorizationDigest: 'a'.repeat(64) }),
      /remote Provider network health.*failed/u,
    );
    assert.equal(credentialCalls, 0);
    assert.equal(providerCalls, 0);
    assert.equal(providerCallStarts, 0);
    assert.ok(fs.existsSync(path.join(authorizationRoot, 'provider-network-health-authority.json')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('production worker config v3 binds three distinct transports, BIOS UUIDs, host keys, and fixed placement', () => {
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
      schemaVersion: 3, artifactKind: PRODUCTION_WORKER_CONFIG_KIND,
      providerPreflightExecutor: { workerId: 'vm169' },
      workers: [worker('vm171', '192.168.40.171', 'AAAA'), worker('vm167', '192.168.40.167', 'BBBB'), worker('vm169', '192.168.40.169', 'CCCC')],
    };
    const normalized = validateProductionWorkerConfig(config, { configDirectory: root });
    assert.deepEqual(normalized.assignments.map(({ cellId, workerId, waveIndex }) => [LIVE_LLM_CELLS.findIndex((cell) => cell.cellId === cellId) + 1, workerId, waveIndex]), [
      [1, 'vm171', 0], [2, 'vm169', 0], [3, 'vm169', 1], [4, 'vm167', 0],
    ]);
    const duplicateUuid = structuredClone(config);
    const fourConfig = structuredClone(config);
    fourConfig.workers[0].transport = { kind: 'local' };
    fourConfig.workers.push(worker('vm131', '192.168.40.131', 'DDDD'));
    fourConfig.providerPreflightExecutor = { workerId: 'vm167' };
    const four = validateProductionWorkerConfig(fourConfig, { configDirectory: root });
    assert.deepEqual(four.assignments.map(({ workerId, waveIndex }) => [workerId, waveIndex]), [
      ['vm171', 0], ['vm169', 0], ['vm131', 0], ['vm167', 0],
    ]);
    assert.equal(four.workers.filter((entry) => entry.transport.kind === 'ssh').length, 3);
    assert.equal(four.preflightExecutor.workerId, 'vm167');
    const wrongFourth = structuredClone(fourConfig);
    wrongFourth.workers[3].vmIdentity.uuidBios = wrongFourth.workers[2].vmIdentity.uuidBios;
    assert.throws(() => validateProductionWorkerConfig(wrongFourth, { configDirectory: root }), /reuses a VMware BIOS UUID/);
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
  const remoteWorker = fs.readFileSync(
    path.join(repoRoot, 'scripts/testing/run-watch-mode-provider-preflight-worker.mjs'),
    'utf8',
  );
  assert.match(remoteWorker, /OMNI_RELEASE_EVIDENCE_PREFLIGHT_AUTHORIZATION_DIGEST/);
  assert.match(remoteWorker, /OMNI_RELEASE_EVIDENCE_PREFLIGHT_GRANT_PATH/);
  assert.match(remoteWorker, /OMNI_RELEASE_EVIDENCE_HEAD_COMMIT: headCommit/);
  assert.match(remoteWorker, /clean signed Git provenance/);
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

test('canonical Provider preflight publication file body preserves extended-length path support', { skip: !isWindows }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-preflight-long-path-'));
  const sourceRoot = path.join(root, 'staging');
  const targetRoot = path.join(root, 'canonical-' + 'x'.repeat(205));
  const relative = 'provider-preflight-lease-reservations/lease-' + 'y'.repeat(48) + '.json';
  const source = path.join(sourceRoot, ...relative.split('/'));
  const target = path.join(targetRoot, ...relative.split('/'));
  const bytes = Buffer.from('{"lease":"long-path-authority"}\\n', 'utf8');
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, bytes, { flag: 'wx' });
  assert.ok(target.length > 260, 'fixture destination must exceed MAX_PATH, got ' + target.length);
  const invocation = remotePowerShellInvocation(REMOTE_PROVIDER_PREFLIGHT_PUBLICATION_BODY, {
    sourceRoot,
    targetRoot,
    files: [{
      path: relative,
      bytes: bytes.byteLength,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    }],
  }, { mode: 'file-only' });
  const scriptPath = path.join(root, 'publish.ps1');
  try {
    fs.writeFileSync(scriptPath, invocation.fileScript, 'utf8');
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
    ], { encoding: 'utf8', timeout: 30_000, windowsHide: true, env: windowsPowerShellEnvironment(process.env) });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const decoded = decodeRemotePowerShellFileOutput({ exitCode: result.status, stdout: result.stdout, stderr: result.stderr });
    const receipt = JSON.parse(decoded.stdout.split(/\r?\n/u)[0]);
    assert.equal(receipt.published, true);
    assert.equal(receipt.logicalTargetRoot, path.win32.resolve(targetRoot));
    assert.equal(fs.readFileSync('\\\\?\\' + target).toString('utf8'), bytes.toString('utf8'));
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
            assert.deepEqual(args.slice(0, -2), scpBaseArgs(worker));
            assert.equal(args.at(-1), `VMUser@192.0.2.10:C:/Users/VMUser/AppData/Local/Temp/${path.basename(args.at(-2))}`);
            assert.doesNotMatch(args.at(-2), /\\/u, 'Git SCP -O command upload local operand must use slashes (otherwise unexpected filename)');
            assert.equal(fs.readFileSync(windowsPathFromGitScpOperand(args.at(-2)), 'utf8'), fileScript);
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

test('Git SCP -O normalizes local operands and preserves host pins and remoteSpec', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-scp-operands-'));
  const worker = {
    workerId: 'scp-worker', transport: { kind: 'ssh' }, user: 'VMUser', host: '192.0.2.10', port: 2222,
    guestExecutionRoot: root, workspaceRoot: root,
    identityFile: 'E:\\host pins\\identity', knownHostsFile: 'E:\\host pins\\known-hosts', hostKeyAlias: 'fixture-worker',
  };
  const calls = [];
  const transport = createSshProductionTransport({
    config: { workers: [worker], scpExecutable: 'scp.exe', sshExecutable: 'ssh.exe' },
    plan: { executionId: 'scp-operands' }, planPath: path.join(root, 'plan.json'),
    leasePaths: [], coordinatorExecutionRoot: root, workspaceRoot: root,
    runProcess: async (executable, args) => {
      calls.push({ executable, args });
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });
  try {
    for (const [kind, relativePath] of [
      ['runtime', 'runtime\\omni.exe'],
      ['implementation', 'scripts\\testing\\worker.mjs'],
      ['plan', 'signed plan.json'],
    ]) {
      await t.test(kind + ' upload', async () => {
        const localPath = 'E:\\watch-coordinator\\' + relativePath;
        const remotePath = 'C:\\worker root\\' + relativePath;
        await transport.uploadFile(worker, localPath, remotePath);
        const call = calls.at(-1);
        assert.equal(call.executable, 'scp.exe');
        assert.deepEqual(call.args.slice(0, -2), scpBaseArgs(worker));
        assert.equal(call.args.at(-1), 'VMUser@192.0.2.10:' + remotePath.replaceAll('\\', '/'));
        assert.equal(call.args.at(-2), localPath.replaceAll('\\', '/'), 'Git SCP -O upload must normalize local operand to avoid unexpected filename');
      });
    }
    await t.test('downloadTree local destination boundary consistency', async () => {
      // Real downloads succeed with either separator; this asserts boundary consistency, not a reproduced download failure.
      const localParent = path.join(root, 'download tree');
      await transport.downloadTree(worker, 'C:\\worker root\\shard', localParent);
      const call = calls.at(-1);
      assert.equal(call.executable, 'scp.exe');
      assert.deepEqual(call.args.slice(0, -2), [...scpBaseArgs(worker), '-r']);
      assert.equal(call.args.at(-2), 'VMUser@192.0.2.10:C:/worker root/shard');
      assert.equal(call.args.at(-1), localParent.replaceAll('\\', '/'), 'normalize download destination for boundary consistency');
    });
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
    { mode: 'file-only' },
  );
  // Exercise the same inspectable -File transport used by local and SSH workers.
  const scriptPath = path.join(root, 'hash.ps1');
  fs.writeFileSync(scriptPath, invocation.fileScript, 'utf8');
  try {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      input: invocation.input,
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    });
    assert.equal(result.status, 0, JSON.stringify({ error: result.error?.message, code: result.error?.code, signal: result.signal, stderr: result.stderr }));
    const decoded = decodeRemotePowerShellFileOutput({ exitCode: result.status, stdout: result.stdout, stderr: result.stderr });
    assert.equal(decoded.exitCode, 0);
    assert.equal(decoded.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0], expected);
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
  const collect = source.slice(source.indexOf('async function collectWorker('), source.indexOf('function productionDeviceProfiles('));
  assert.match(
    collect,
    /Set-Location -LiteralPath \$workspace[\s\S]*?& node\.exe \$runnerPath '--finalize-worker-request'/,
    'guest shard finalization must run from the signed workspace so repository-relative contracts resolve there',
  );
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

test('production coordinator passes four collected signed shard roots through stage, verify, and publish', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-production-orchestrator-'));
  const config = rawWorkerConfig(root, ['vm171', 'vm167', 'vm169', 'vm131']);
  const normalized = validateProductionWorkerConfig(config, { configDirectory: root });
  const profilesByWorker = new Map(normalized.workers.map((worker) => [
    worker.workerId,
    new Map(worker.deviceProfileInstances.map((profile) => [profile.deviceClass, profile])),
  ]));
  const placements = normalized.assignments.map(({ workerId, waveIndex }) => [workerId, waveIndex]);
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
    workers: normalized.workers.map(({ workerId, vmIdentity, deviceProfileInstances, transport }) => ({
      workerId,
      vmIdentity,
      deviceProfileInstances,
      transportAuthority: transport.kind === 'local' ? { kind: 'local' } : {
        kind: 'ssh',
        hostKeyAlias: transport.hostKeyAlias,
        hostKeyAlgorithm: transport.hostKeyAlgorithm,
        hostKeySha256: transport.hostKeySha256,
      },
    })),
    cells,
    waves: [...new Set(cells.map((cell) => cell.waveIndex))].map((waveIndex) => ({
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
        stageShardMatrixIntegration: ({ shards: stagedShards }) => {
          calls.push(`stage:${stagedShards.map((shard) => shard.workerId).join(',')}`);
          assert.deepEqual(
            stagedShards.map((shard) => shard.workerId),
            plan.workers.map((worker) => worker.workerId),
          );
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
      plan.waves.map((wave) => `wave:${wave.waveIndex}`),
    );
    assert.deepEqual(
      calls.filter((entry) => entry.startsWith('stage:')),
      ['stage:vm171,vm167,vm169,vm131'],
    );
    assert.ok(calls.indexOf('zero-provider-readiness') < calls.indexOf('provider-preflight'));
    assert.equal(calls.filter((entry) => entry.startsWith('paid:')).length, LIVE_LLM_CELLS.length);
    assert.ok(calls.indexOf('verify') < calls.indexOf('publish'));
    assert.equal(result.workerCount, 4);
    assert.equal(result.waveCount, 1);

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
