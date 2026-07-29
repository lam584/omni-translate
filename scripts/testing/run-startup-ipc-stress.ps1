#requires -Version 5.1
<#
.SYNOPSIS
  Launches the release desktop shell N times and records, per launch, whether the
  native IPC channel came up and how long it took.

.DESCRIPTION
  The failure this guards against is the startup hang where the WebView2 renderer
  never reaches `debug_ipc_ping`, the native IPC channel never initializes, and
  the passive watchdog in apps/desktop/src-tauri/src/main.rs writes
  `startup.ipc_never_connected` 65 seconds later. A single launch almost always
  succeeds, so only repetition surfaces it.

  All marker detection, statistics and pass/fail evaluation live in
  scripts/testing/startup-ipc-stress.mjs; this script only launches, polls the
  app.log delta, kills the process between runs and hands the evidence back.

  -DryRun prints the plan and exits 0 without launching anything.
#>
param(
  [switch]$DryRun,
  [int]$Runs = 10,
  [string]$OutputRoot = "artifacts/testing/startup-ipc-stress",
  [string]$ReleaseExecutablePath = "",
  [string]$RuntimeAppLogPath = "",
  [int]$PingTimeoutMs = 90000,
  [int]$PollIntervalMs = 250,
  [int]$BetweenRunsSettleMs = 1500
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

# npm 11 swallows PowerShell-style single-dash options after "npm run ... --" and
# forwards only their values, so "-Runs 25" arrives here as a bare "25" that binds
# positionally to -OutputRoot. Fail fast with npm-safe alternatives.
if ($env:npm_lifecycle_event -eq "test:startup-ipc-stress" -and $PSBoundParameters.ContainsKey("OutputRoot")) {
  throw (
    "npm forwarded only the value '$OutputRoot' because npm 11 swallows single-dash options after 'npm run ... --'. " +
    "Set OMNI_STARTUP_IPC_STRESS_RUNS or OMNI_STARTUP_IPC_STRESS_DRY_RUN before 'npm run', or invoke the runner directly: " +
    "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./scripts/testing/run-startup-ipc-stress.ps1 [-DryRun] [-Runs <n>]"
  )
}
if (-not $PSBoundParameters.ContainsKey("Runs") -and $env:OMNI_STARTUP_IPC_STRESS_RUNS) {
  $parsedRuns = 0
  if (-not [int]::TryParse($env:OMNI_STARTUP_IPC_STRESS_RUNS, [ref]$parsedRuns) -or $parsedRuns -le 0) {
    throw "OMNI_STARTUP_IPC_STRESS_RUNS must be a positive integer; got '$($env:OMNI_STARTUP_IPC_STRESS_RUNS)'."
  }
  $Runs = $parsedRuns
}
if (-not $DryRun -and $env:OMNI_STARTUP_IPC_STRESS_DRY_RUN -eq "1") {
  $DryRun = $true
}

$workspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$stressModule = Join-Path $workspaceRoot 'scripts/testing/startup-ipc-stress.mjs'

# Shared file/process helpers (Set-Utf8NoBomContent, Get-FileLength,
# Read-TextDelta, Get-ChildProcessIds, Stop-ProcessTree).
. (Join-Path $PSScriptRoot 'lib/desktop-smoke-common.ps1')

# Mirrors findIpcPingEvidence in startup-ipc-stress.mjs closely enough to stop
# polling; the authoritative verdict is still computed by the Node module from
# the recorded delta, so a mismatch here can only cost extra wall-clock time.
function Test-IpcConnectedDelta {
  param([string]$Delta, [string[]]$Markers, [string]$NeverConnectedMarker)
  if ([string]::IsNullOrEmpty($Delta)) {
    return $false
  }
  foreach ($line in ($Delta -split "`r?`n")) {
    if (-not $line.Trim()) { continue }
    if ($line.Contains($NeverConnectedMarker)) { continue }
    if ($line -match 'fail|error|timeout') { continue }
    foreach ($marker in $Markers) {
      if ($line.Contains($marker)) {
        return $true
      }
    }
  }
  return $false
}

function Stop-DesktopShellProcesses {
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds(10)
  $stableSince = $null
  while ([DateTimeOffset]::UtcNow -lt $deadline) {
    $processes = @(Get-Process -Name 'omni-desktop-shell' -ErrorAction SilentlyContinue)
    if ($processes.Count -gt 0) {
      $processes | Stop-Process -Force -ErrorAction SilentlyContinue
      $stableSince = $null
    } elseif ($null -eq $stableSince) {
      $stableSince = [DateTimeOffset]::UtcNow
    } elseif (([DateTimeOffset]::UtcNow - $stableSince).TotalMilliseconds -ge 1000) {
      return $true
    }
    Start-Sleep -Milliseconds 200
  }
  return $false
}

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$runId = "startup-ipc-stress-$timestamp"
$runDir = Join-Path $workspaceRoot (Join-Path $OutputRoot $runId)
New-Item -ItemType Directory -Force -Path $runDir | Out-Null

$planArguments = @(
  '--mode', 'plan',
  '--output', $runDir,
  '--workspace-root', $workspaceRoot,
  '--runs', "$Runs",
  '--ping-timeout-ms', "$PingTimeoutMs",
  '--poll-interval-ms', "$PollIntervalMs",
  '--output-root', $OutputRoot
)
if ($ReleaseExecutablePath) {
  $planArguments += @('--release-executable-path', $ReleaseExecutablePath)
}
if ($RuntimeAppLogPath) {
  $resolvedAppLogPath = [System.IO.Path]::GetFullPath($RuntimeAppLogPath)
  $planArguments += @('--app-log-path', $resolvedAppLogPath)
}
if ($DryRun) {
  $planArguments += '--dry-run'
}

& node $stressModule @planArguments
if ($LASTEXITCODE -ne 0) {
  throw "startup IPC stress plan generation failed with exit code $LASTEXITCODE"
}
if ($DryRun) {
  Write-Host ""
  Write-Host "Dry run only: the desktop shell was not launched."
  exit 0
}

$plan = Get-Content -LiteralPath (Join-Path $runDir 'plan.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $plan.releaseExecutable.found) {
  Write-Host "Release desktop shell was not built at $($plan.releaseExecutable.path)." -ForegroundColor Red
  Write-Host "  build it with: $($plan.releaseExecutable.buildHint)" -ForegroundColor Yellow
  throw "startup IPC stress requires a release build at $($plan.releaseExecutable.path)"
}
if (-not $plan.timeoutCoversWatchdogGrace) {
  Write-Host ("WARNING: ping timeout {0}ms is below the native watchdog grace {1}ms; a non-connecting run will be killed before {2} can be written." -f `
      $plan.pingTimeoutMs, $plan.watchdogGraceMs, $plan.neverConnectedMarker) -ForegroundColor Yellow
}

$existingShells = @(Get-Process -Name 'omni-desktop-shell' -ErrorAction SilentlyContinue)
if ($existingShells.Count -gt 0) {
  throw "omni-desktop-shell is already running (pid=$(($existingShells | ForEach-Object { $_.Id }) -join ',')); close it so the stress measures fresh launches"
}

$appLogPath = if ([System.IO.Path]::IsPathRooted([string]$plan.appLogPath)) {
  [string]$plan.appLogPath
} else {
  Join-Path $workspaceRoot $plan.appLogPath
}
$exePath = [string]$plan.releaseExecutable.path
$markers = @($plan.ipcConnectedMarkers)
$neverConnectedMarker = [string]$plan.neverConnectedMarker

$runRecords = @()
$runnerError = $null
$startedAt = [DateTimeOffset]::UtcNow.ToString('o')
$previousLogLevel = $env:OMNI_LOG_LEVEL

try {
  $env:OMNI_LOG_LEVEL = [string]$plan.environment.OMNI_LOG_LEVEL

  for ($index = 1; $index -le $plan.runs; $index++) {
    $logOffset = Get-FileLength $appLogPath
    $stdoutPath = Join-Path $runDir "run-$index.stdout.log"
    $stderrPath = Join-Path $runDir "run-$index.stderr.log"
    $process = $null
    $launched = $true
    $launchError = $null
    $connected = $false
    $latencyMs = $null
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

    try {
      $process = Start-Process -FilePath $exePath `
        -WorkingDirectory (Split-Path -Parent $exePath) `
        -RedirectStandardOutput $stdoutPath `
        -RedirectStandardError $stderrPath `
        -WindowStyle Hidden `
        -PassThru
    } catch {
      $launched = $false
      $launchError = $_.Exception.Message
    }

    if ($launched) {
      while ($stopwatch.ElapsedMilliseconds -lt $plan.pingTimeoutMs) {
        $delta = Read-TextDelta -Path $appLogPath -Offset $logOffset
        if (Test-IpcConnectedDelta -Delta $delta -Markers $markers -NeverConnectedMarker $neverConnectedMarker) {
          $connected = $true
          $latencyMs = [int]$stopwatch.ElapsedMilliseconds
          break
        }
        Start-Sleep -Milliseconds $plan.pollIntervalMs
      }
    }

    $waitedMs = [int]$stopwatch.ElapsedMilliseconds
    if ($null -ne $process) {
      Stop-ProcessTree -RootProcessId $process.Id
    }
    if (-not (Stop-DesktopShellProcesses)) {
      throw "omni-desktop-shell processes remained after the 10-second cleanup window"
    }
    Start-Sleep -Milliseconds 500

    $finalDelta = Read-TextDelta -Path $appLogPath -Offset $logOffset
    Set-Utf8NoBomContent (Join-Path $runDir "run-$index.app-log-delta.log") $finalDelta

    $runRecords += [ordered]@{
      index = $index
      launched = $launched
      launchError = $launchError
      processId = if ($null -ne $process) { $process.Id } else { $null }
      latencyMs = $latencyMs
      waitedMs = $waitedMs
      killed = ($null -ne $process)
      logDelta = $finalDelta
    }

    $latencyText = if ($null -ne $latencyMs) { "$latencyMs" } else { '-' }
    Write-Host ("run {0}/{1}: connected={2} latencyMs={3} waitedMs={4}" -f $index, $plan.runs, $connected, $latencyText, $waitedMs)
    Start-Sleep -Milliseconds $BetweenRunsSettleMs
  }
} catch {
  $runnerError = $_.Exception.Message
  Write-Host "startup IPC stress runner error: $runnerError" -ForegroundColor Red
} finally {
  $env:OMNI_LOG_LEVEL = $previousLogLevel
  [void](Stop-DesktopShellProcesses)
}

$evidence = [ordered]@{
  runId = $runId
  dryRun = $false
  startedAt = $startedAt
  finishedAt = [DateTimeOffset]::UtcNow.ToString('o')
  plan = $plan
  runnerError = $runnerError
  runs = $runRecords
}
Set-Utf8NoBomContent (Join-Path $runDir 'evidence.json') ($evidence | ConvertTo-Json -Depth 24)

& node $stressModule --mode report --input $runDir --output $runDir
$reportExitCode = $LASTEXITCODE
exit $reportExitCode
