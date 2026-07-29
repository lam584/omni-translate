#requires -Version 5.1
<#
.SYNOPSIS
  tauri-driver overlay smoke: drives the release desktop shell through a real
  WebDriver session and asserts the native subtitle-overlay window state.

.DESCRIPTION
  All decision logic (argument building, pass/fail evaluation, report shaping)
  lives in scripts/testing/overlay-driver-smoke.mjs so it is unit-tested without
  a desktop session. This script only performs side effects: probe the tooling,
  start tauri-driver, create the session against the release build, run the
  overlay commands inside the main webview over the real IPC boundary, tear
  everything down, and hand the collected evidence back to Node.

  -DryRun prints the plan and exits 0 without starting anything.
#>
param(
  [switch]$DryRun,
  [string]$OutputRoot = "artifacts/testing/overlay-driver-smoke",
  [string]$NativeDriverPath = "",
  [string]$ReleaseExecutablePath = "",
  [string]$DriverHost = "127.0.0.1",
  [int]$DriverPort = 4444,
  [int]$NativeDriverPort = 4445,
  [ValidateSet("self-check", "toggle")]
  [string]$OverlayShowMode = "self-check",
  [int]$SessionTimeoutSeconds = 120,
  [int]$OverlayCommandTimeoutSeconds = 30,
  [int]$DriverStartTimeoutSeconds = 30
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

# npm 11 swallows PowerShell-style single-dash options after "npm run ... --"
# and forwards only their values, so "-NativeDriverPath C:\tools\x.exe" arrives
# here as a bare value that binds positionally to -OutputRoot. Fail fast with
# npm-safe alternatives instead of writing artifacts to a driver path.
if ($env:npm_lifecycle_event -eq "smoke:overlay-driver" -and $PSBoundParameters.ContainsKey("OutputRoot")) {
  throw (
    "npm forwarded only the value '$OutputRoot' because npm 11 swallows single-dash options after 'npm run ... --'. " +
    "Set OMNI_OVERLAY_DRIVER_SMOKE_DRY_RUN or OMNI_OVERLAY_DRIVER_SMOKE_NATIVE_DRIVER_PATH before 'npm run', or invoke the runner directly: " +
    "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./scripts/testing/run-overlay-driver-smoke.ps1 [-DryRun] [-NativeDriverPath <path>]"
  )
}
if (-not $DryRun -and $env:OMNI_OVERLAY_DRIVER_SMOKE_DRY_RUN -eq "1") {
  $DryRun = $true
}
if (-not $PSBoundParameters.ContainsKey("NativeDriverPath") -and $env:OMNI_OVERLAY_DRIVER_SMOKE_NATIVE_DRIVER_PATH) {
  $NativeDriverPath = $env:OMNI_OVERLAY_DRIVER_SMOKE_NATIVE_DRIVER_PATH
}

$workspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$smokeModule = Join-Path $workspaceRoot 'scripts/testing/overlay-driver-smoke.mjs'

# Escape hatch. Loud by construction: the banner text is owned by the Node
# module so this path can never degrade into a silent "ok".
if ($env:OMNI_SKIP_DRIVER_SMOKE -eq "1") {
  & node $smokeModule --mode skip-banner --reason "OMNI_SKIP_DRIVER_SMOKE=1 was set in the environment"
  exit 0
}

# Shared file/process helpers (Set-Utf8NoBomContent, Get-FileLength,
# Read-TextDelta, Get-ChildProcessIds, Stop-ProcessTree).
. (Join-Path $PSScriptRoot 'lib/desktop-smoke-common.ps1')

function Test-TcpPort {
  param([string]$TargetHost, [int]$Port, [int]$TimeoutMs = 500)
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $async = $client.BeginConnect($TargetHost, $Port, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMs)) {
      return $false
    }
    $client.EndConnect($async)
    return $true
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Invoke-WebDriverRequest {
  param(
    [ValidateSet("GET", "POST", "DELETE")]
    [string]$Method,
    [string]$Uri,
    [object]$Body = $null,
    [int]$TimeoutSeconds = 60
  )
  $parameters = @{
    Method = $Method
    Uri = $Uri
    TimeoutSec = $TimeoutSeconds
    UseBasicParsing = $true
  }
  if ($null -ne $Body) {
    $json = $Body | ConvertTo-Json -Depth 16 -Compress
    $parameters.ContentType = 'application/json; charset=utf-8'
    $parameters.Body = [System.Text.Encoding]::UTF8.GetBytes($json)
  }
  return Invoke-RestMethod @parameters
}

function Stop-DesktopShellProcesses {
  Get-Process -Name 'omni-desktop-shell' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 400
  return (@(Get-Process -Name 'omni-desktop-shell' -ErrorAction SilentlyContinue).Count -eq 0)
}

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$runId = "overlay-driver-smoke-$timestamp"
$runDir = Join-Path $workspaceRoot (Join-Path $OutputRoot $runId)
New-Item -ItemType Directory -Force -Path $runDir | Out-Null

$resolvedNativeDriver = if ($NativeDriverPath) { $NativeDriverPath } else { 'msedgedriver.exe' }

$planArguments = @(
  '--mode', 'plan',
  '--output', $runDir,
  '--workspace-root', $workspaceRoot,
  '--driver-host', $DriverHost,
  '--driver-port', "$DriverPort",
  '--native-driver-port', "$NativeDriverPort",
  '--native-driver-path', $resolvedNativeDriver,
  '--show-mode', $OverlayShowMode,
  '--session-timeout-seconds', "$SessionTimeoutSeconds",
  '--output-root', $OutputRoot
)
if ($ReleaseExecutablePath) {
  $planArguments += @('--release-executable-path', $ReleaseExecutablePath)
}
if ($DryRun) {
  $planArguments += '--dry-run'
}

& node $smokeModule @planArguments
if ($LASTEXITCODE -ne 0) {
  throw "overlay driver smoke plan generation failed with exit code $LASTEXITCODE"
}
if ($DryRun) {
  Write-Host ""
  Write-Host "Dry run only: no tauri-driver session was created and the app was not launched."
  exit 0
}

$plan = Get-Content -LiteralPath (Join-Path $runDir 'plan.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$appLogPath = Join-Path $workspaceRoot 'artifacts/diagnostics/logs/app.log'
$appLogOffset = Get-FileLength $appLogPath

$tools = @()
$driverProcess = $null
$driverProcessEvidence = [ordered]@{ started = $false; listening = $false; pid = $null; endpoint = $plan.driver.endpoint; error = $null }
$sessionEvidence = [ordered]@{ created = $false; sessionId = $null; error = $null }
$overlayEvidence = [ordered]@{ showMode = $OverlayShowMode; windowHandles = @() }
$teardownEvidence = [ordered]@{ sessionDeleted = $false; driverStopped = $false; appStopped = $false }
$releaseEvidence = [ordered]@{
  found = [bool]$plan.releaseExecutable.found
  path = [string]$plan.releaseExecutable.path
  buildHint = [string]$plan.releaseExecutable.buildHint
}
$runnerError = $null
$sessionId = $null
$startedAt = [DateTimeOffset]::UtcNow.ToString('o')

try {
  foreach ($required in $plan.requiredTools) {
    $resolvedPath = $null
    if ($required.name -eq 'msedgedriver' -and $NativeDriverPath) {
      if (Test-Path -LiteralPath $NativeDriverPath -PathType Leaf) {
        $resolvedPath = (Resolve-Path -LiteralPath $NativeDriverPath).Path
      }
    }
    if (-not $resolvedPath) {
      $command = Get-Command $required.name -ErrorAction SilentlyContinue
      if ($command) { $resolvedPath = $command.Source }
    }
    $tools += [pscustomobject]@{
      name = $required.name
      found = [bool]$resolvedPath
      path = $resolvedPath
      installHint = $required.installHint
    }
  }

  $missingTools = @($tools | Where-Object { -not $_.found })
  if ($missingTools.Count -gt 0) {
    Write-Host "Missing WebDriver tooling required by the overlay smoke:" -ForegroundColor Red
    foreach ($missing in $missingTools) {
      Write-Host "  - $($missing.name): $($missing.installHint)" -ForegroundColor Yellow
    }
    throw "overlay driver smoke requires $((($missingTools | ForEach-Object { $_.name }) -join ', ')) on PATH"
  }

  if (-not $plan.releaseExecutable.found) {
    Write-Host "Release desktop shell was not built at $($plan.releaseExecutable.path)." -ForegroundColor Red
    Write-Host "  build it with: $($plan.releaseExecutable.buildHint)" -ForegroundColor Yellow
    throw "overlay driver smoke requires a release build at $($plan.releaseExecutable.path)"
  }

  $nativeDriverResolved = ($tools | Where-Object { $_.name -eq 'msedgedriver' } | Select-Object -First 1).path
  # Start-Process joins ArgumentList with plain spaces on Windows PowerShell 5.1,
  # so a driver path containing spaces has to carry its own quotes.
  $nativeDriverArgument = if ($nativeDriverResolved -match '\s') { '"' + $nativeDriverResolved + '"' } else { $nativeDriverResolved }
  $driverArguments = @($plan.driver.args)
  for ($index = 0; $index -lt $driverArguments.Count; $index++) {
    if ($driverArguments[$index] -eq '--native-driver') {
      $driverArguments[$index + 1] = $nativeDriverArgument
    }
  }

  if (Test-TcpPort -TargetHost $plan.driver.host -Port $plan.driver.port) {
    throw "port $($plan.driver.port) is already in use; stop the stale tauri-driver before running the overlay smoke"
  }

  $driverStdout = Join-Path $runDir 'tauri-driver.stdout.log'
  $driverStderr = Join-Path $runDir 'tauri-driver.stderr.log'
  $driverProcess = Start-Process -FilePath (($tools | Where-Object { $_.name -eq 'tauri-driver' } | Select-Object -First 1).path) `
    -ArgumentList $driverArguments `
    -WorkingDirectory $workspaceRoot `
    -RedirectStandardOutput $driverStdout `
    -RedirectStandardError $driverStderr `
    -WindowStyle Hidden `
    -PassThru
  $driverProcessEvidence.started = $true
  $driverProcessEvidence.pid = $driverProcess.Id

  $driverDeadline = (Get-Date).AddSeconds($DriverStartTimeoutSeconds)
  while ((Get-Date) -lt $driverDeadline) {
    if (Test-TcpPort -TargetHost $plan.driver.host -Port $plan.driver.port) {
      $driverProcessEvidence.listening = $true
      break
    }
    $driverProcess.Refresh()
    if ($driverProcess.HasExited) {
      $driverProcessEvidence.error = "tauri-driver exited with code $($driverProcess.ExitCode); see $driverStderr"
      break
    }
    Start-Sleep -Milliseconds 250
  }
  if (-not $driverProcessEvidence.listening) {
    if (-not $driverProcessEvidence.error) {
      $driverProcessEvidence.error = "tauri-driver did not accept connections on $($plan.driver.endpoint) within ${DriverStartTimeoutSeconds}s"
    }
    throw $driverProcessEvidence.error
  }

  $sessionResponse = Invoke-WebDriverRequest -Method POST `
    -Uri $plan.session.request.url `
    -Body $plan.session.request.body `
    -TimeoutSeconds $plan.session.timeoutSeconds
  $sessionId = [string]$sessionResponse.value.sessionId
  if (-not $sessionId) {
    throw "tauri-driver returned no sessionId; response=$($sessionResponse | ConvertTo-Json -Depth 6 -Compress)"
  }
  $sessionEvidence.created = $true
  $sessionEvidence.sessionId = $sessionId

  # Deterministic async-script budget instead of the implementation default.
  [void](Invoke-WebDriverRequest -Method POST `
      -Uri "$($plan.driver.endpoint)/session/$sessionId/timeouts" `
      -Body @{ script = ($OverlayCommandTimeoutSeconds * 1000) } `
      -TimeoutSeconds 30)

  foreach ($step in $plan.overlay.steps) {
    $stepEvidence = [ordered]@{ ok = $false; command = $step.command; error = $null; result = $null }
    try {
      $response = Invoke-WebDriverRequest -Method POST `
        -Uri "$($plan.driver.endpoint)/session/$sessionId/execute/async" `
        -Body @{ script = $step.script; args = @() } `
        -TimeoutSeconds ($OverlayCommandTimeoutSeconds + 15)
      $value = $response.value
      if ($null -ne $value -and $value.ok -eq $true) {
        $stepEvidence.ok = $true
        $stepEvidence.result = $value.value
      } else {
        $stepEvidence.error = if ($null -ne $value -and $value.error) {
          [string]$value.error
        } else {
          "invoke $($step.command) returned no result"
        }
      }
    } catch {
      $stepEvidence.error = $_.Exception.Message
    }
    $overlayEvidence[$step.name] = $stepEvidence
    Write-Host "overlay step '$($step.name)' ($($step.command)): ok=$($stepEvidence.ok)"
  }

  try {
    $handles = Invoke-WebDriverRequest -Method GET -Uri "$($plan.driver.endpoint)/session/$sessionId/window/handles" -TimeoutSeconds 30
    $overlayEvidence.windowHandles = @($handles.value)
  } catch {
    $overlayEvidence.windowHandles = @()
  }
} catch {
  $runnerError = $_.Exception.Message
  Write-Host "overlay driver smoke runner error: $runnerError" -ForegroundColor Red
} finally {
  if ($sessionId) {
    try {
      [void](Invoke-WebDriverRequest -Method DELETE -Uri "$($plan.driver.endpoint)/session/$sessionId" -TimeoutSeconds 30)
      $teardownEvidence.sessionDeleted = $true
    } catch {
      $teardownEvidence.sessionDeleted = $false
    }
  }
  if ($null -ne $driverProcess) {
    Stop-ProcessTree -RootProcessId $driverProcess.Id
    Start-Sleep -Milliseconds 300
    $teardownEvidence.driverStopped = -not (Test-TcpPort -TargetHost $plan.driver.host -Port $plan.driver.port)
  }
  $teardownEvidence.appStopped = Stop-DesktopShellProcesses
}

$appLogDelta = Read-TextDelta -Path $appLogPath -Offset $appLogOffset
Set-Utf8NoBomContent (Join-Path $runDir 'app-log-delta.log') $appLogDelta

$evidence = [ordered]@{
  runId = $runId
  dryRun = $false
  startedAt = $startedAt
  finishedAt = [DateTimeOffset]::UtcNow.ToString('o')
  plan = $plan
  tools = $tools
  releaseExecutable = $releaseEvidence
  driverProcess = $driverProcessEvidence
  session = $sessionEvidence
  overlay = $overlayEvidence
  teardown = $teardownEvidence
  runnerError = $runnerError
  appLogDelta = $appLogDelta
}
Set-Utf8NoBomContent (Join-Path $runDir 'evidence.json') ($evidence | ConvertTo-Json -Depth 24)

& node $smokeModule --mode report --input $runDir --output $runDir
$reportExitCode = $LASTEXITCODE
exit $reportExitCode
