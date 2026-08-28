import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const moduleRoot = path.join(repositoryRoot, 'scripts', 'testing', 'lib', 'powershell');
const powershell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';

function quote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function runPowerShell(source) {
  const result = spawnSync(
    powershell,
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${source}`,
    ],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr.trim(), '', result.stderr);
  return result.stdout.trim();
}

test('IO module preserves Chinese UTF-8 and enforces immutable JSON', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'omni-testing-io-'));
  const jsonPath = path.join(directory, 'evidence.json');
  try {
    const output = runPowerShell(`
      Import-Module ${quote(path.join(moduleRoot, 'Omni.Testing.IO.psm1'))} -Force
      $value = [ordered]@{ message = '中文证据'; count = 2 }
      Write-OmniJsonAtomic -LiteralPath ${quote(jsonPath)} -Value $value
      $read = Read-OmniJsonFile -LiteralPath ${quote(jsonPath)}
      $immutable = Join-Path ${quote(directory)} 'immutable.json'
      Write-OmniImmutableJson -LiteralPath $immutable -Value $value
      $refused = $false
      try { Write-OmniImmutableJson -LiteralPath $immutable -Value $value } catch { $refused = $true }
      $hashValue = [string](Get-OmniSha256 -LiteralPath $immutable)
      [ordered]@{ message = $read.message; refused = $refused; hash = $hashValue } | ConvertTo-Json -Compress
    `);
    const parsed = JSON.parse(output);
    assert.equal(parsed.message, '中文证据');
    assert.equal(parsed.refused, true);
    assert.equal(typeof parsed.hash, 'string', output);
    assert.match(parsed.hash, /^[a-f0-9]{64}$/);
    const bytes = await readFile(jsonPath);
    assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('step module exposes one explicit four-state schema', () => {
  const output = runPowerShell(`
    Import-Module ${quote(path.join(moduleRoot, 'Omni.Testing.Step.psm1'))} -Force
    $passed = Invoke-OmniStep -Id 'probe' -Phase 'readiness' -Action { [ordered]@{ ready = $true } }
    $failed = Invoke-OmniStep -Id 'launch' -Phase 'desktopLaunch' -FailureCode 'testing.launch.failed' -Action { throw 'boom' }
    $skipped = New-OmniStepResult -Id 'stt' -Phase 'contentCapture' -Status skipped -StartedAtUtc ([DateTime]::UtcNow)
    @($passed, $failed, $skipped) | ConvertTo-Json -Depth 10 -Compress
  `);
  const [passed, failed, skipped] = JSON.parse(output);
  assert.deepEqual([passed.status, failed.status, skipped.status], ['passed', 'failed', 'skipped']);
  assert.equal(passed.schemaVersion, 'watch-mode-step/v2');
  assert.equal(failed.error.code, 'testing.launch.failed');
  assert.equal(failed.error.message, 'boom');
});

test('state machine blocks unmet phases and preserves the first failure across cleanup errors', () => {
  const output = runPowerShell(`
    Import-Module ${quote(path.join(moduleRoot, 'Omni.Testing.StateMachine.psm1'))} -Force
    $state = New-OmniRunState -Context ([pscustomobject]@{ runId = 'run-1' }) -Request ([pscustomobject]@{ runMode = 'live' })
    Invoke-OmniRunPhase -State $state -Id 'initialize' -Phase 'initialize' -Action { [pscustomobject]@{ initialized = $true } } | Out-Null
    Invoke-OmniRunPhase -State $state -Id 'driver.probe' -Phase 'driverProbe' -PrerequisiteIds 'initialize' -FailureCode 'driver.probe.failed' -Action { throw 'driver unavailable' } | Out-Null
    $playbackInvoked = $false
    Invoke-OmniRunPhase -State $state -Id 'playback' -Phase 'playback' -PrerequisiteIds 'driver.probe' -Action { $playbackInvoked = $true } | Out-Null
    Add-OmniCleanupError -State $state -Code 'cleanup.desktop.failed' -Message 'cleanup failed' | Out-Null
    Complete-OmniBlockedPhases -State $state -Phases @('initialize', 'driverProbe', 'readiness', 'playback', 'cleanup')
    [ordered]@{
      statuses = @($state.steps | ForEach-Object { $_.status })
      blockedBy = @($state.stepById['playback'].data.blockedBy | ForEach-Object { $_.id })
      playbackInvoked = $playbackInvoked
      primaryCode = $state.primaryError.code
      cleanupCode = $state.cleanupErrors[0].code
      completedPhases = @($state.steps | ForEach-Object { $_.phase })
    } | ConvertTo-Json -Depth 8 -Compress
  `);
  const parsed = JSON.parse(output);
  assert.deepEqual(parsed.statuses, ['passed', 'failed', 'blocked', 'blocked', 'blocked']);
  assert.deepEqual(parsed.blockedBy, ['driver.probe']);
  assert.equal(parsed.playbackInvoked, false);
  assert.equal(parsed.primaryCode, 'driver.probe.failed');
  assert.equal(parsed.cleanupCode, 'cleanup.desktop.failed');
  assert.deepEqual(parsed.completedPhases, ['initialize', 'driverProbe', 'playback', 'readiness', 'cleanup']);
});

test('Windows module reports the current elevation state explicitly', () => {
  const output = runPowerShell(`
    Import-Module ${quote(path.join(moduleRoot, 'Omni.Testing.Windows.psm1'))} -Force
    [ordered]@{ isAdministrator = [bool](Test-OmniIsAdministrator) } | ConvertTo-Json -Compress
  `);
  assert.equal(typeof JSON.parse(output).isAdministrator, 'boolean');
});

test('Watch Mode context accepts one typed request and rejects cross-field ambiguity', () => {
  const output = runPowerShell(`
    Import-Module ${quote(path.join(moduleRoot, 'Omni.Testing.WatchMode.Config.psm1'))} -Force
    $request = [pscustomobject]@{ schemaVersion='watch-mode-run-request/v1'; runMode='live'; authorityMode='none'; feedbackMode='virtual-driver'; driverPolicy='repair-if-needed'; physicalContentMode='remote-stt'; desktop=[pscustomobject]@{launchMode='managed';elevation='forbid'}; paths=[pscustomobject]@{outputRoot='out';runtimeRoot='logs'}; timeouts=[pscustomobject]@{}; media=[pscustomobject]@{}; model=[pscustomobject]@{}; physicalDevice=[pscustomobject]@{}; matrix=[pscustomobject]@{} }
    $managed = New-OmniWatchModeContext -Request $request -WorkspaceRoot ${quote(repositoryRoot)}
    $request.feedbackMode = 'echo-cancel'
    $ambiguousDriver = $false
    try { New-OmniWatchModeContext -Request $request -WorkspaceRoot ${quote(repositoryRoot)} | Out-Null } catch { $ambiguousDriver = $true }
    [ordered]@{ managed = $managed; ambiguousDriver = $ambiguousDriver } | ConvertTo-Json -Depth 8 -Compress
  `);
  const parsed = JSON.parse(output);
  assert.equal(parsed.managed.schemaVersion, 'watch-mode-run-context/v2');
  assert.equal(parsed.managed.mode, 'live');
  assert.equal(parsed.managed.driverPolicy, 'repair-if-needed');
  assert.equal(parsed.ambiguousDriver, true);
});

test('process module refuses external and stale leases, then stops its managed process', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'omni-testing-process-'));
  try {
    const output = runPowerShell(`
      Import-Module ${quote(path.join(moduleRoot, 'Omni.Testing.Process.psm1'))} -Force
      $child = Start-Process powershell.exe -ArgumentList '-NoLogo','-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 30' -WindowStyle Hidden -PassThru
      $lease = Get-OmniProcessIdentity -ProcessId $child.Id -Ownership managed
      $external = $lease | ConvertTo-Json | ConvertFrom-Json; $external.ownership = 'external'
      $stale = $lease | ConvertTo-Json | ConvertFrom-Json; $stale.startTimeUtcTicks = [long]$stale.startTimeUtcTicks + 1
      $externalRefused = $false; $staleRefused = $false
      try { Stop-OmniOwnedProcessTree -Lease $external | Out-Null } catch { $externalRefused = $true }
      try { Stop-OmniOwnedProcessTree -Lease $stale | Out-Null } catch { $staleRefused = $true }
      $result = Stop-OmniOwnedProcessTree -Lease $lease
      [ordered]@{ externalRefused = $externalRefused; staleRefused = $staleRefused; stopped = $result.stopped; resultType = $(if ($null -eq $result) { 'null' } else { $result.GetType().FullName }) } | ConvertTo-Json -Compress
    `);
    const parsed = JSON.parse(output);
    assert.equal(parsed.externalRefused, true);
    assert.equal(parsed.staleRefused, true);
    assert.equal(parsed.stopped, true, output);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('managed process cleanup accepts an owned process that already ended', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'omni-testing-process-ended-'));
  try {
    const output = runPowerShell(`
      Import-Module ${quote(path.join(moduleRoot, 'Omni.Testing.Process.psm1'))} -Force
      $child = Start-Process powershell.exe -ArgumentList '-NoLogo','-NoProfile','-NonInteractive','-Command','exit 0' -WindowStyle Hidden -PassThru
      $child.WaitForExit()
      $result = Stop-OmniManagedProcessHandle -Process $child
      [ordered]@{ stopped = $result.stopped; alreadyExited = $result.alreadyExited; pid = $result.pid } | ConvertTo-Json -Compress
    `);
    const parsed = JSON.parse(output);
    assert.equal(parsed.stopped, false);
    assert.equal(parsed.alreadyExited, true);
    assert.ok(parsed.pid > 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Watch Mode PowerShell boundaries stay thin and route termination through Process', () => {
  const watchFiles = fs.readdirSync(moduleRoot)
    .filter((name) => name.startsWith('Omni.Testing.WatchMode.') && name.endsWith('.psm1'));
  for (const name of watchFiles) {
    const source = fs.readFileSync(path.join(moduleRoot, name), 'utf8');
    assert.doesNotMatch(source, /\bStop-Process\b|\btaskkill(?:\.exe)?\b/iu, name);
  }
  assert.ok(fs.readFileSync(path.join(moduleRoot, 'Omni.Testing.WatchMode.Runner.psm1'), 'utf8').split(/\r?\n/u).length <= 350);
  for (const name of [
    'Omni.Testing.WatchMode.AudioPlayback.psm1',
    'Omni.Testing.WatchMode.VirtualDriverCapture.psm1',
    'Omni.Testing.WatchMode.PhysicalCapture.psm1',
  ]) {
    assert.ok(fs.readFileSync(path.join(moduleRoot, name), 'utf8').split(/\r?\n/u).length <= 300, name);
  }
});
