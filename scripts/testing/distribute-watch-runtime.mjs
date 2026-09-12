import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isMain, repoRoot, parseCliArgs } from '../lib/testing-common.mjs';
import { verifyStrictRuntimeAuthority } from './watch-mode-strict-runtime-authority.mjs';
import { AUTHORITY_RUNTIME_BINARY_FILES } from './watch-mode-evidence-authority.mjs';
import { readProductionWorkerConfig, createSshProductionTransport } from './run-watch-mode-live-production-coordinator.mjs';

const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => a?.bytes === b.bytes && a?.sha256 === b.sha256;
const write = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });

function runtimeTarExecutable() {
  if (process.platform !== 'win32') return 'tar';
  const windowsRoot = process.env.SystemRoot;
  if (!windowsRoot || !path.win32.isAbsolute(windowsRoot)) throw new Error('Windows SystemRoot must be absolute for system tar');
  // A 32-bit process on 64-bit Windows must bypass filesystem redirection.
  const directory = process.arch === 'ia32' && process.env.PROCESSOR_ARCHITEW6432 ? 'Sysnative' : 'System32';
  return path.win32.join(windowsRoot, directory, 'tar.exe');
}

function assertAncestry(file) {
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`reparse ancestry: ${current}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current === path.dirname(current)) break;
  }
}

function safeFile(root, relative) {
  if (!AUTHORITY_RUNTIME_BINARY_FILES.includes(relative)) throw new Error('runtime path not allowlisted');
  const file = path.resolve(root, relative);
  assertAncestry(file);
  if (!fs.statSync(file).isFile()) throw new Error('runtime entry not regular');
  return file;
}

// Only control-plane PowerShell; no runtime process, driver install, or Provider.
export const RUNTIME_CONTROL_PS = String.raw`
$ErrorActionPreference = 'Stop'
function Safe([string]$p) {
  $p = [IO.Path]::GetFullPath($p)
  $c = $p
  while ($c) {
    if (Test-Path -LiteralPath $c) {
      $i = Get-Item -Force -LiteralPath $c
      if (($i.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse ancestry' }
    }
    $c = [IO.Path]::GetDirectoryName($c)
  }
  return $p
}
function Entry([string]$root, $e) {
  if ($e.path -notmatch '^[a-zA-Z0-9_./-]+$' -or $e.path -match '(^|/)\.\.?(/|$)' -or $e.path.StartsWith('/')) { throw 'traversal' }
  $r = Safe $root
  $p = Safe (Join-Path $r $e.path)
  if (!$p.StartsWith($r.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'escape' }
  return $p
}
function Proof([string]$p, [string]$name) {
  if (!(Test-Path -LiteralPath $p)) { return @{path=$name; bytes=$null; sha256=$null} }
  $i = Get-Item -Force -LiteralPath (Safe $p)
  if ($i.PSIsContainer) { throw 'not regular file' }
  $stream = [IO.File]::OpenRead($p)
  $hasher = [Security.Cryptography.SHA256]::Create()
  try { $digest = [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
  finally { $stream.Dispose(); $hasher.Dispose() }
  return @{path=$name; bytes=$i.Length; sha256=$digest}
}
function AssertProof($actual, $expected) {
  if ($actual.bytes -ne $expected.bytes -or $actual.sha256 -cne $expected.sha256) { throw 'SHA256/bytes mismatch' }
}
function Git([string[]]$a) {
  $v = & git.exe --no-optional-locks -c core.quotepath=false -c core.fsmonitor=false -C $payload.workspaceRoot @a
  if ($LASTEXITCODE -ne 0) { throw 'git check failed' }
  return ($v -join [Environment]::NewLine).Trim()
}
function Identity {
  Safe $payload.workspaceRoot | Out-Null
  $head = Git @('rev-parse','--verify','HEAD')
  # Bounded clean check, not a claim of independent tracked-content hashing.
  # Reject index flags that can mask dirty source. Never refresh/reset the index.
  foreach ($flag in @('-v', '-f')) {
    $tagged = Git @('ls-files', $flag)
    foreach ($line in ($tagged -split [Environment]::NewLine)) {
      if ($line -and !$line.StartsWith('H ')) { throw 'masked or non-regular index flags' }
    }
  }
  Git @('diff','--quiet','--no-ext-diff','--ignore-submodules=none','--') | Out-Null
  $cached = Git @('diff','--cached','--name-only','HEAD','--')
  $untracked = Git @('ls-files','--others','--exclude-standard')
  $status = Git @('status','--porcelain=v1','--untracked-files=all','--ignore-submodules=none')
  $bios = ([string](Get-CimInstance Win32_ComputerSystemProduct).UUID).ToLowerInvariant()
  if ($head -cne $payload.head -or $cached -or $untracked -or $status -or $bios -cne $payload.bios) { throw 'HEAD/BIOS/clean mismatch' }
  return @{head=$head; bios=$bios; clean=$true; cleanCheck='git-diff-no-masked-index-flags'}
}
function AssertRuntimeUntracked {
  # One index inventory, not one native process per runtime/source file.
  $tracked = Git @('ls-files','--cached')
  foreach ($line in ($tracked -split [Environment]::NewLine)) {
    if (!$line) { continue }
    foreach ($e in $payload.entries) {
      if ($line -ieq [string]$e.path -or ([string]$e.path).StartsWith($line + '/', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'refusing tracked runtime or tracked ancestor overwrite'
      }
    }
  }
}
$identity = Identity
AssertRuntimeUntracked
$root = Safe $payload.executionRoot
if ($payload.phase -eq 'inspect') {
  if (Test-Path -LiteralPath $root) { throw 'executionRoot already exists' }
  New-Item -ItemType Directory -Path $root | Out-Null
  $entries = @($payload.entries | ForEach-Object { Proof (Entry $payload.workspaceRoot $_) $_.path })
} elseif ($payload.phase -eq 'stage') {
  $archive = Safe (Join-Path $root 'delta.tar')
  if ($payload.changed.Count -gt 0) {
    AssertProof (Proof $archive 'delta.tar') $payload.archive
    $systemDirectory = [Environment]::SystemDirectory
    if ([Environment]::Is64BitOperatingSystem -and ![Environment]::Is64BitProcess) {
      $systemDirectory = Join-Path ([Environment]::GetFolderPath('Windows')) 'Sysnative'
    }
    $systemTar = Safe (Join-Path $systemDirectory 'tar.exe')
    if (!(Test-Path -LiteralPath $systemTar -PathType Leaf)) { throw 'Windows system tar is missing' }
    $listing = @(& $systemTar -tf $archive)
    if ($LASTEXITCODE -ne 0) { throw 'tar listing failed' }
    $expectedNames = @($payload.changed | ForEach-Object { $_.path })
    if ($listing.Count -ne $expectedNames.Count -or (Compare-Object $listing $expectedNames)) { throw 'archive inventory mismatch' }
    $verbose = @(& $systemTar -tvf $archive)
    if ($LASTEXITCODE -ne 0 -or @($verbose | Where-Object { !$_.StartsWith('-') }).Count) { throw 'archive non-regular entry' }
    $delta = Join-Path $root 'delta'
    if (Test-Path -LiteralPath $delta) { throw 'delta already exists' }
    New-Item -ItemType Directory -Path $delta | Out-Null
    & $systemTar -xf $archive -C $delta
    if ($LASTEXITCODE -ne 0) { throw 'tar extraction failed' }
    foreach ($e in $payload.changed) { AssertProof (Proof (Entry $delta $e) $e.path) $e }
  }
  $runtime = Join-Path $root 'runtime'
  if (Test-Path -LiteralPath $runtime) { throw 'runtime already exists' }
  New-Item -ItemType Directory -Path $runtime | Out-Null
  foreach ($e in $payload.entries) {
    $sourceRoot = $payload.workspaceRoot
    if (@($payload.changed | Where-Object { $_.path -ceq $e.path }).Count) { $sourceRoot = Join-Path $root 'delta' }
    $source = Entry $sourceRoot $e
    AssertProof (Proof $source $e.path) $e
    $dest = Entry $runtime $e
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($dest)) | Out-Null
    Safe $dest | Out-Null
    [IO.File]::Copy($source, $dest, $false)
  }
  $entries = @($payload.entries | ForEach-Object { Proof (Entry $runtime $_) $_.path })
  foreach ($e in $payload.entries) { AssertProof ($entries | Where-Object { $_.path -ceq $e.path }) $e }
  # Publish only verified runtime bytes to the existing coordinator lookup paths.
  # Keep the exclusive runtime copy even if installation or final checks fail.
  AssertRuntimeUntracked
  foreach ($e in $payload.entries) {
    $source = Entry $runtime $e
    $dest = Entry $payload.workspaceRoot $e
    $current = Proof $dest $e.path
    if ($current.bytes -eq $e.bytes -and $current.sha256 -ceq $e.sha256) { continue }
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($dest)) | Out-Null
    Safe $dest | Out-Null
    [IO.File]::Copy($source, $dest, $true)
  }
  $entries = @($payload.entries | ForEach-Object { Proof (Entry $payload.workspaceRoot $_) $_.path })
  foreach ($e in $payload.entries) { AssertProof ($entries | Where-Object { $_.path -ceq $e.path }) $e }
  AssertRuntimeUntracked
  $identity = Identity
} else { throw 'invalid phase' }
@{entries=$entries; identity=$identity} | ConvertTo-Json -Depth 12 -Compress
`;

function unpack(result) {
  if (result?.exitCode !== 0) throw new Error(`remote control failed: ${result?.stderr ?? 'no result'}`);
  const lines = String(result.stdout).split(/\r?\n/).filter((line) => line.startsWith('{'));
  if (lines.length !== 1) throw new Error('invalid remote proof envelope');
  return JSON.parse(lines[0]);
}

function assertProof(result, entries, worker, head, complete) {
  const id = result?.identity;
  if (id?.head !== head || id?.bios !== worker.vmIdentity.uuidBios.toLowerCase()
      || id?.clean !== true || id?.cleanCheck !== 'git-diff-no-masked-index-flags') throw new Error('HEAD/BIOS/clean proof mismatch');
  if (!Array.isArray(result.entries) || result.entries.length !== entries.length
      || new Set(result.entries.map((e) => e.path)).size !== entries.length) throw new Error('incomplete runtime proof');
  for (const entry of entries) {
    const actual = result.entries.find((e) => e.path === entry.path);
    if (!actual || (complete && !same(actual, entry))) throw new Error('runtime hash mismatch');
  }
}

/** operations is a trusted test seam, not a CLI/config option. */
export async function distributeWatchRuntime({ runtimeAuthorityPath, workersConfig, workspaceRoot = repoRoot, operations = {} } = {}) {
  const verify = operations.verifyStrictRuntimeAuthority ?? verifyStrictRuntimeAuthority;
  const initial = await verify(runtimeAuthorityPath, { workspaceRoot });
  const snapshot = JSON.stringify(initial.authority);
  const entries = initial.authority.runtimeBinaryHashes;
  if (!Array.isArray(entries) || entries.length !== AUTHORITY_RUNTIME_BINARY_FILES.length
      || new Set(entries.map((e) => e.path)).size !== entries.length
      || entries.some((e) => !AUTHORITY_RUNTIME_BINARY_FILES.includes(e.path) || !Number.isSafeInteger(e.bytes)
        || e.bytes < 0 || !/^[a-f0-9]{64}$/.test(e.sha256))) throw new Error('invalid runtime manifest');
  const config = (operations.readConfig ?? operations.readProductionWorkerConfig ?? readProductionWorkerConfig)(path.resolve(workspaceRoot, workersConfig));
  for (const worker of config.workers) {
    if (worker.transport?.kind === 'local'
        && path.win32.resolve(worker.workspaceRoot).toLowerCase() !== path.win32.resolve(workspaceRoot).toLowerCase()) {
      throw new Error('local worker workspace must match coordinator workspace; SSH fallback is forbidden');
    }
  }
  const executionId = `runtime-${crypto.randomUUID()}`;
  const parent = path.join(workspaceRoot, 'artifacts/testing/watch-runtime-distributions');
  assertAncestry(parent);
  fs.mkdirSync(parent, { recursive: true });
  const evidenceRoot = path.join(parent, executionId);
  fs.mkdirSync(evidenceRoot);
  assertAncestry(evidenceRoot);
  const transport = operations.transport ?? createSshProductionTransport({ config, plan: { executionId }, leasePaths: [], coordinatorExecutionRoot: evidenceRoot, workspaceRoot,
    ...(operations.runProcess ? { runProcess: operations.runProcess } : {}) });
  const started = Date.now();
  const settled = await Promise.allSettled(config.workers.map(async (worker) => {
    const start = Date.now();
    const local = path.join(evidenceRoot, worker.workerId);
    fs.mkdirSync(local);
    const executionRoot = path.win32.join(worker.guestExecutionRoot, executionId, worker.workerId);
    const payload = { executionRoot, workspaceRoot: worker.workspaceRoot, head: initial.authority.provenance.headCommit, bios: worker.vmIdentity.uuidBios.toLowerCase(), entries };
    const control = async (phase, extra = {}) => {
      const raw = await transport.executeRemote(worker, RUNTIME_CONTROL_PS, { ...payload, phase, ...extra }, { requireControlPlane: true });
      write(path.join(local, `${phase}-response.json`), raw);
      return unpack(raw);
    };
    try {
      const before = await control('inspect');
      assertProof(before, entries, worker, payload.head, false);
      const inspected = Date.now();
      const changed = entries.filter((e) => !same(before.entries.find((a) => a.path === e.path), e));
      let archive = null;
      if (changed.length) {
        const bundle = path.join(local, 'bundle');
        fs.mkdirSync(bundle);
        for (const entry of changed) {
          const source = safeFile(workspaceRoot, entry.path);
          const bytes = fs.readFileSync(source);
          if (!same({ bytes: bytes.length, sha256: hash(bytes) }, entry)) throw new Error('local runtime hash mismatch');
          const dest = path.join(bundle, entry.path);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, bytes, { flag: 'wx' });
        }
        const archivePath = path.join(local, 'delta.tar');
        const executable = runtimeTarExecutable();
        const result = (operations.runTar ?? spawnSync)(executable, ['-cf', archivePath, '-C', bundle, ...changed.map((e) => e.path)], { encoding: 'utf8', windowsHide: true });
        write(path.join(local, 'tar-result.json'), { executable, status: result.status, stderr: result.stderr, error: result.error?.message });
        if (result.error || result.status !== 0) throw new Error('system tar failed');
        const bytes = fs.readFileSync(archivePath);
        archive = { bytes: bytes.length, sha256: hash(bytes) };
        await transport.uploadFile(worker, archivePath, path.win32.join(executionRoot, 'delta.tar'), { timeoutMs: 120_000 });
      }
      const uploaded = Date.now();
      const after = await control('stage', { changed, archive });
      assertProof(after, entries, worker, payload.head, true);
      const receipt = { schemaVersion: 1, artifactKind: 'watch-runtime-worker-distribution', workerId: worker.workerId, executionRoot,
        workspaceRoot: worker.workspaceRoot, runtimeRoot: path.win32.join(executionRoot, 'runtime'),
        identity: after.identity, entries: entries.map((e) => ({ ...e, status: changed.includes(e) ? 'copied' : 'reused' })),
        archive, uploadedFiles: changed.length, uploadedBytes: archive?.bytes ?? 0, runtimeBytes: entries.reduce((n, e) => n + e.bytes, 0),
        timings: { inspectMs: inspected - start, transferMs: uploaded - inspected, verifyMs: Date.now() - uploaded, totalMs: Date.now() - start } };
      write(path.join(local, 'verified.json'), receipt);
      return receipt;
    } catch (error) {
      write(path.join(local, 'failure.json'), { workerId: worker.workerId, error: error.message, elapsedMs: Date.now() - start });
      throw error;
    }
  }));
  let finalError;
  try {
    const final = await verify(runtimeAuthorityPath, { workspaceRoot });
    if (JSON.stringify(final.authority) !== snapshot) throw new Error('authority changed during distribution');
  } catch (error) { finalError = error; }
  const failures = settled.filter((r) => r.status === 'rejected').map((r) => r.reason);
  if (finalError) failures.push(finalError);
  if (failures.length) {
    write(path.join(evidenceRoot, 'failure.json'), { errors: failures.map((e) => e.message), workers: settled.map((r, i) => ({ workerId: config.workers[i].workerId, status: r.status })) });
    const error = new AggregateError(failures, `runtime distribution failed; evidence retained: ${evidenceRoot}`);
    error.evidenceRoot = evidenceRoot;
    throw error;
  }
  const receipt = { schemaVersion: 1, artifactKind: 'watch-runtime-distribution', status: 'success', executionId, authorityDigest: initial.authority.authorityDigest, headCommit: initial.authority.provenance.headCommit, workers: settled.map((r) => r.value), elapsedMs: Date.now() - started, evidenceRoot };
  write(path.join(evidenceRoot, 'success.json'), receipt);
  return receipt;
}

if (isMain(import.meta.url)) {
  try {
    const args = parseCliArgs(process.argv.slice(2), { defaults: { runtimeAuthority: '', workersConfig: '' } });
    if (!args.runtimeAuthority || !args.workersConfig) throw new Error('--runtime-authority and --workers-config are required');
    console.log(JSON.stringify(await distributeWatchRuntime({ runtimeAuthorityPath: args.runtimeAuthority, workersConfig: args.workersConfig })));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
