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

test('process tree snapshot rejects stale parent generations and terminates traversal cycles', { skip: process.platform !== 'win32' }, () => {
  const output = runPowerShell(`
    $module = Import-Module ${quote(path.join(moduleRoot, 'Omni.Testing.Process.psm1'))} -Force -PassThru
    & $module {
      function Get-LegacyDescendants($RootProcessId, $ProcessSnapshot) {
        $children = @{}
        foreach ($item in $ProcessSnapshot) {
          $parent = [int]$item.ParentProcessId
          if (-not $children.ContainsKey($parent)) { $children[$parent] = @() }
          $children[$parent] += [int]$item.ProcessId
        }
        $result = @(); $pending = New-Object System.Collections.Generic.Stack[int]; $pending.Push($RootProcessId)
        while ($pending.Count -gt 0) {
          $parent = $pending.Pop()
          if (-not $children.ContainsKey($parent)) { continue }
          foreach ($child in @($children[$parent])) { $result += $child; $pending.Push($child) }
        }
        return $result
      }
      $snapshot = @(
        [pscustomobject]@{ ProcessId = 101; ParentProcessId = 100; StartTimeUtcTicks = 1100 },
        [pscustomobject]@{ ProcessId = 102; ParentProcessId = 101; StartTimeUtcTicks = 1200 },
        [pscustomobject]@{ ProcessId = 200; ParentProcessId = 100; StartTimeUtcTicks = 900 },
        [pscustomobject]@{ ProcessId = 302; ParentProcessId = 100; StartTimeUtcTicks = 1000 },
        [pscustomobject]@{ ProcessId = 100; ParentProcessId = 302; StartTimeUtcTicks = 1000 }
      )
      $targets = @(Get-OmniDescendantProcessTargets -RootProcessId 100 -RootStartTimeUtcTicks 1000 -ProcessSnapshot $snapshot)
      $legacy = @(Get-LegacyDescendants 100 @($snapshot[0..2]))
      [ordered]@{
        pids = @($targets | ForEach-Object { $_.pid } | Sort-Object)
        generations = @($targets | ForEach-Object { $_.startTimeUtcTicks })
        legacyPids = @($legacy | Sort-Object)
      } | ConvertTo-Json -Compress
    }
  `);
  const result = JSON.parse(output);
  assert.deepEqual(result.pids, [101, 102, 302]);
  assert.equal(result.generations.length, 3);
  assert.deepEqual(result.legacyPids, [101, 102, 200], 'old PID-only traversal must reproduce the stale-parent false positive');
});

test('fallback stop reads actual process identity and kills only the bound current-generation handle', { skip: process.platform !== 'win32' }, () => {
  const output = runPowerShell(`
    $module = Import-Module ${quote(path.join(moduleRoot, 'Omni.Testing.Process.psm1'))} -Force -PassThru
    & $module {
      $script:killed = @()
      function script:Get-Process {
        param($Id, $ErrorAction)
        $fake = [pscustomobject]@{ StartTime = [DateTime]::new($script:actualTicks, [DateTimeKind]::Utc); BoundPid = [int]$Id; Handle = [IntPtr]::new(1) }
        $fake | Add-Member ScriptMethod Kill { $script:killed += [int]$this.BoundPid }
        $fake | Add-Member ScriptMethod Dispose { }
        return $fake
      }
      $script:actualTicks = 222
      $staleStopped = Stop-OmniProcessGeneration -Target ([pscustomobject]@{ pid = 77; startTimeUtcTicks = 111 })
      $script:actualTicks = 229
      $currentStopped = Stop-OmniProcessGeneration -Target ([pscustomobject]@{ pid = 77; startTimeUtcTicks = 220 })
      [ordered]@{ staleStopped = $staleStopped; currentStopped = $currentStopped; killed = @($script:killed) } | ConvertTo-Json -Compress
    }
  `);
  const result = JSON.parse(output);
  assert.equal(result.staleStopped, false);
  assert.equal(result.currentStopped, true);
  assert.deepEqual(result.killed, [77]);
});

test('PS5 generation lookup binds and releases a native process handle', { skip: process.platform !== 'win32' }, () => {
  const output = runPowerShell(`
    $module = Import-Module ${quote(path.join(moduleRoot, 'Omni.Testing.Process.psm1'))} -Force -PassThru
    $fixture = Start-Process powershell.exe -ArgumentList '-NoProfile -Command Start-Sleep -Seconds 30' -WindowStyle Hidden -PassThru
    try {
      $target = [pscustomobject]@{ pid = $fixture.Id; startTimeUtcTicks = [long]$fixture.StartTime.ToUniversalTime().Ticks }
      $result = & $module {
        param($target)
        $state = Get-OmniProcessGenerationState -Target $target
        $field = $state.process.GetType().GetField('m_processHandle', [Reflection.BindingFlags]'Instance,NonPublic')
        $handle = if ($null -eq $field) { $null } else { $field.GetValue($state.process) }
        $before = $null -ne $handle -and -not $handle.IsInvalid -and -not $handle.IsClosed
        $state.process.Dispose()
        [ordered]@{ status = $state.status; boundBeforeDispose = $before; closedAfterDispose = ($null -ne $handle -and $handle.IsClosed) }
      } $target
      $result | ConvertTo-Json -Compress
    } finally {
      if (-not $fixture.HasExited) { $fixture.Kill(); $fixture.WaitForExit() }
      $fixture.Dispose()
    }
  `);
  const result = JSON.parse(output);
  assert.equal(result.status, 'current');
  assert.equal(result.boundBeforeDispose, true);
  assert.equal(result.closedAfterDispose, true);
});

test('reachable descendant with unreadable creation time fails closed while unrelated unreadable rows do not', { skip: process.platform !== 'win32' }, () => {
  const output = runPowerShell(`
    $module = Import-Module ${quote(path.join(moduleRoot, 'Omni.Testing.Process.psm1'))} -Force -PassThru
    & $module {
      $snapshot = @(
        [pscustomobject]@{ ProcessId = 101; ParentProcessId = 100; StartTimeUtcTicks = 1100 },
        [pscustomobject]@{ ProcessId = 102; ParentProcessId = 101 },
        [pscustomobject]@{ ProcessId = 900; ParentProcessId = 899 }
      )
      $failure = $null
      try { Get-OmniDescendantProcessTargets -RootProcessId 100 -RootStartTimeUtcTicks 1000 -ProcessSnapshot $snapshot | Out-Null } catch { $failure = $_.Exception.Message }
      $unrelatedOnly = @(Get-OmniDescendantProcessTargets -RootProcessId 100 -RootStartTimeUtcTicks 1000 -ProcessSnapshot @($snapshot[0], $snapshot[2]))
      [ordered]@{ failure = $failure; unrelatedCount = $unrelatedOnly.Count } | ConvertTo-Json -Compress
    }
  `);
  const result = JSON.parse(output);
  assert.match(result.failure, /reachable descendant generation is unverifiable.*parentPid=101.*pid=102/u);
  assert.equal(result.unrelatedCount, 1);
});

test('native tree termination keeps the verified root handle alive for the taskkill call', { skip: process.platform !== 'win32' }, () => {
  const output = runPowerShell(`
    $module = Import-Module ${quote(path.join(moduleRoot, 'Omni.Testing.Process.psm1'))} -Force -PassThru
    & $module {
      $script:guardDisposed = $false; $script:taskkillSawLiveGuard = $false; $script:stateCalls = 0
      $guard = [pscustomobject]@{ Handle = [IntPtr]::new(1) }
      $guard | Add-Member ScriptMethod Dispose { $script:guardDisposed = $true }
      function script:Test-OmniProcessIdentity { param($Lease) return $true }
      function script:Get-OmniDescendantProcessTargets { param($RootProcessId,$RootStartTimeUtcTicks) return @() }
      function script:Get-OmniProcessGenerationState {
        param($Target)
        $script:stateCalls += 1
        if ($script:stateCalls -eq 1) { return [pscustomobject]@{ status='current'; process=$guard; error=$null } }
        return [pscustomobject]@{ status='absent'; process=$null; error=$null }
      }
      function script:Stop-OmniProcessGeneration { param($Target) return $false }
      function script:taskkill.exe { $script:taskkillSawLiveGuard = -not $script:guardDisposed; $global:LASTEXITCODE=0 }
      $lease = [pscustomobject]@{ ownership='managed'; pid=77; startTimeUtcTicks=220; custodyId='missing-test-record' }
      $result = Stop-OmniOwnedProcessTree -Lease $lease
      [ordered]@{ stopped=$result.stopped; liveDuringTaskkill=$script:taskkillSawLiveGuard; disposedAfter=$script:guardDisposed } | ConvertTo-Json -Compress
    }
  `);
  const result = JSON.parse(output);
  assert.equal(result.stopped, true);
  assert.equal(result.liveDuringTaskkill, true);
  assert.equal(result.disposedAfter, true);
});

test('managed handle cleanup preserves descendant cleanup failure after the root exits', { skip: process.platform !== 'win32' }, () => {
  const output = runPowerShell(`
    $module = Import-Module ${quote(path.join(moduleRoot, 'Omni.Testing.Process.psm1'))} -Force -PassThru
    $fixture = Start-Process powershell.exe -ArgumentList '-NoProfile -Command Start-Sleep -Seconds 30' -WindowStyle Hidden -PassThru
    try {
      & $module {
        function script:Get-OmniProcessIdentity { param($ProcessId,$Ownership) return [pscustomobject]@{ pid=$ProcessId } }
        function script:Stop-OmniOwnedProcessTree { param($Lease,$WaitMilliseconds) throw 'descendant cleanup unverified' }
      }
      $failure = $null
      try { Stop-OmniManagedProcessHandle -Process $fixture | Out-Null } catch { $failure = $_.Exception.Message }
      $fixture.Kill(); $fixture.WaitForExit()
      [ordered]@{ failure=$failure; rootExited=$fixture.HasExited } | ConvertTo-Json -Compress
    } finally {
      if (-not $fixture.HasExited) { $fixture.Kill(); $fixture.WaitForExit() }
      $fixture.Dispose()
    }
  `);
  const result = JSON.parse(output);
  assert.match(result.failure, /descendant cleanup unverified/u);
  assert.equal(result.rootExited, true);
});

test('process identity lookup errors fail closed instead of masquerading as process exit', { skip: process.platform !== 'win32' }, () => {
  const output = runPowerShell(`
    $module = Import-Module ${quote(path.join(moduleRoot, 'Omni.Testing.Process.psm1'))} -Force -PassThru
    & $module {
      function script:Get-Process { param($Id, $ErrorAction) throw [UnauthorizedAccessException]::new('identity denied') }
      $target = [pscustomobject]@{ pid = 88; startTimeUtcTicks = 220 }
      $state = Get-OmniProcessGenerationState -Target $target
      $failure = $null
      try { Stop-OmniProcessGeneration -Target $target | Out-Null } catch { $failure = $_.Exception.Message }
      [ordered]@{ status = $state.status; error = $state.error; failure = $failure } | ConvertTo-Json -Compress
    }
  `);
  const result = JSON.parse(output);
  assert.equal(result.status, 'unverifiable');
  assert.match(result.error, /identity denied/u);
  assert.match(result.failure, /could not be verified before termination/u);
});

test('owned tree cleanup captures native stderr without bypassing final exit verification', { skip: process.platform !== 'win32' }, () => {
  const output = runPowerShell(`
    $ErrorActionPreference = 'Stop'
    $module = Import-Module ${quote(path.join(moduleRoot, 'Omni.Testing.Process.psm1'))} -Force -PassThru
    $process = Start-Process -FilePath $env:ComSpec -ArgumentList '/d /c ping.exe -n 30 127.0.0.1' -WindowStyle Hidden -PassThru
    try {
      $lease = Get-OmniProcessIdentity -ProcessId $process.Id -Ownership managed
      & $module { function script:taskkill.exe { & $env:ComSpec /d /c 'echo fixture-taskkill-stderr 1>&2 & exit /b 128' } }
      $result = Stop-OmniOwnedProcessTree -Lease $lease
      [ordered]@{ stopped = $result.stopped; alive = [bool](Get-Process -Id $process.Id -ErrorAction SilentlyContinue); preference = [string]$ErrorActionPreference; nativeExit = $result.taskkillExitCode; nativeOutput = @($result.taskkillOutput) } | ConvertTo-Json -Compress
    } finally { if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit() } }
  `);
  const result = JSON.parse(output);
  assert.equal(result.stopped, true);
  assert.equal(result.alive, false);
  assert.equal(result.preference, 'Stop');
  assert.equal(result.nativeExit, 128);
  assert.match(result.nativeOutput.join('\n'), /fixture-taskkill-stderr/u);
});

test('owned tree cleanup still rejects a live process after native and fallback failure', { skip: process.platform !== 'win32' }, () => {
  const output = runPowerShell(`
    $ErrorActionPreference = 'Stop'
    $module = Import-Module ${quote(path.join(moduleRoot, 'Omni.Testing.Process.psm1'))} -Force -PassThru
    $process = Start-Process powershell.exe -ArgumentList '-NoProfile -Command Start-Sleep -Seconds 30' -WindowStyle Hidden -PassThru
    try {
      $lease = Get-OmniProcessIdentity -ProcessId $process.Id -Ownership managed
      & $module {
        function script:taskkill.exe { & $env:ComSpec /d /c 'echo fixture-taskkill-denied 1>&2 & exit /b 128' }
        function script:Stop-OmniProcessGeneration { param($Target) return $false }
      }
      $failure = $null
      try { Stop-OmniOwnedProcessTree -Lease $lease -WaitMilliseconds 100 | Out-Null } catch { $failure = $_.Exception.Message }
      [ordered]@{ failure = $failure; alive = [bool](Get-Process -Id $process.Id -ErrorAction SilentlyContinue); custodyRetained = (Test-OmniProcessIdentity -Lease $lease); preference = [string]$ErrorActionPreference } | ConvertTo-Json -Compress
    } finally { if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit() } }
  `);
  const result = JSON.parse(output);
  assert.match(result.failure, /owned process tree did not exit/u);
  assert.match(result.failure, /taskkillExitCode=128.*fixture-taskkill-denied/u);
  assert.match(result.failure, /remainingPids=\d+/u);
  assert.equal(result.alive, true);
  assert.equal(result.custodyRetained, true);
  assert.equal(result.preference, 'Stop');
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

test('managed process launch custody preserves the exact nonzero exit code', () => {
  const output = runPowerShell(`
    Import-Module ${quote(path.join(moduleRoot, 'Omni.Testing.Process.psm1'))} -Force
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes('Start-Sleep -Milliseconds 150; exit 7'))
    $child = Start-Process powershell.exe -ArgumentList @('-NoProfile','-EncodedCommand',$encoded) -WindowStyle Hidden -PassThru
    $lease = Get-OmniProcessIdentity -ProcessId $child.Id -Ownership managed -ProcessHandle $child
    Wait-OmniManagedProcessExit -Lease $lease -DeadlineUtc ([DateTime]::UtcNow.AddSeconds(5)) | ConvertTo-Json -Compress
  `);
  assert.equal(JSON.parse(output).exitCode, 7);
});

test('Watch Mode PowerShell boundaries stay thin and route termination through Process', () => {
  const watchFiles = fs.readdirSync(moduleRoot)
    .filter((name) => name.startsWith('Omni.Testing.WatchMode.') && name.endsWith('.psm1'));
  for (const name of watchFiles) {
    const source = fs.readFileSync(path.join(moduleRoot, name), 'utf8');
    assert.doesNotMatch(source, /\bStop-Process\b|\btaskkill(?:\.exe)?\b/iu, name);
  }
  assert.ok(fs.readFileSync(path.join(moduleRoot, 'Omni.Testing.WatchMode.Runner.psm1'), 'utf8').split(/\r?\n/u).length <= 365);
  for (const name of [
    'Omni.Testing.WatchMode.AudioPlayback.psm1',
    'Omni.Testing.WatchMode.VirtualDriverCapture.psm1',
    'Omni.Testing.WatchMode.PhysicalCapture.psm1',
  ]) {
    assert.ok(fs.readFileSync(path.join(moduleRoot, name), 'utf8').split(/\r?\n/u).length <= 300, name);
  }
});
