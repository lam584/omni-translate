#requires -Version 5.1

Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.Process.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.Startup.Timing.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.Startup.DevServer.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.Startup.LogAnalysis.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.Startup.Process.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.Startup.Collection.psm1') -Force -DisableNameChecking

function Invoke-StartupReadinessRun {
  param(
    [Parameter(Mandatory = $true)][string]$WorkspaceRoot,
    [string]$OutputRoot, [int]$TimeoutSeconds, [int]$WindowPollMs, [int]$LogPollMs,
    [int]$DevServerPort, [int]$MaxWindowToReadyMs, [int]$MaxWindowToFrontendMountMs,
    [int]$MaxFrontendBootstrapMs, [int]$MaxReadySignalToNativeLogMs,
    [bool]$UseExistingDevServer, [bool]$UseFastDev, [int]$CriticalWarmupTimeoutMs,
    [bool]$NoWarmup, [bool]$NoStop, [bool]$DryRun
  )
  $workspaceRoot = $WorkspaceRoot
  $desktopRoot = Join-Path $workspaceRoot 'apps/desktop'
  $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $runId = "startup-readiness-$timestamp-$([Guid]::NewGuid().ToString('N').Substring(0, 8))"
  $targetDir = Join-Path $workspaceRoot $OutputRoot
  $runDir = Join-Path $targetDir $runId
  New-Item -ItemType Directory -Force -Path $runDir | Out-Null
  
  $reportPath = Join-Path $runDir 'report.json'
  $markdownPath = Join-Path $runDir 'report.md'
  $stdoutPath = Join-Path $runDir 'tauri-dev.stdout.log'
  $stderrPath = Join-Path $runDir 'tauri-dev.stderr.log'
  $viteStdoutPath = Join-Path $runDir 'vite-dev.stdout.log'
  $viteStderrPath = Join-Path $runDir 'vite-dev.stderr.log'
  $appLogPath = Join-Path $workspaceRoot 'artifacts/diagnostics/logs/app.log'
  $tauriConfigOverridePath = Join-Path $runDir 'tauri.startup-readiness.conf.json'
  $commandText = if ($UseExistingDevServer) {
    "npx tauri dev --config $tauriConfigOverridePath"
  } else {
    'npm run dev --workspace @omni/desktop; npx tauri dev --config tauri.startup-readiness.conf.json'
  }
  if ($UseFastDev) {
    $devServerMode = 'managed-critical-warmup'
  } elseif ($UseExistingDevServer) {
    $devServerMode = 'existing'
  } else {
    $devServerMode = 'managed-prewarmed'
  }
  
if ($DryRun) {
    $thresholds = [ordered]@{ maxWindowToReadyMs=$MaxWindowToReadyMs; maxWindowToFrontendMountMs=$MaxWindowToFrontendMountMs; maxFrontendBootstrapMs=$MaxFrontendBootstrapMs; maxReadySignalToNativeLogMs=$MaxReadySignalToNativeLogMs }
    $artifacts = [ordered]@{ report=$reportPath; markdown=$markdownPath; stdout=$stdoutPath; stderr=$stderrPath; viteStdout=$viteStdoutPath; viteStderr=$viteStderrPath; appLog=$appLogPath }
    Complete-StartupPreflightCollection -RunDirectory $runDir -WorkspaceRoot $workspaceRoot -RunId $runId -DryRun $true -Command $commandText -TimeoutSeconds $TimeoutSeconds -Thresholds $thresholds -DevServer ([ordered]@{ mode=$devServerMode; port=$DevServerPort; listeners=@() }) -Artifacts $artifacts -NoStop ([bool]$NoStop) | Write-Output
    return
  }
  
  $devServerListeners = @(Get-DevServerListeners -Port $DevServerPort)
if (-not $UseExistingDevServer -and $devServerListeners.Count -gt 0) {
    $thresholds = [ordered]@{ maxWindowToReadyMs=$MaxWindowToReadyMs; maxWindowToFrontendMountMs=$MaxWindowToFrontendMountMs; maxFrontendBootstrapMs=$MaxFrontendBootstrapMs; maxReadySignalToNativeLogMs=$MaxReadySignalToNativeLogMs }
    $artifacts = [ordered]@{ report=$reportPath; markdown=$markdownPath; stdout=$stdoutPath; stderr=$stderrPath; viteStdout=$viteStdoutPath; viteStderr=$viteStderrPath; appLog=$appLogPath }
    Complete-StartupPreflightCollection -RunDirectory $runDir -WorkspaceRoot $workspaceRoot -RunId $runId -DryRun $false -FailureCode 'dev-port-in-use' -FailureMessage "Dev server port $DevServerPort is already in use. Use -UseExistingDevServer to measure against the existing Vite server." -Command $commandText -TimeoutSeconds $TimeoutSeconds -Thresholds $thresholds -DevServer ([ordered]@{ mode=$devServerMode; port=$DevServerPort; listeners=$devServerListeners }) -Artifacts $artifacts -NoStop ([bool]$NoStop) | Write-Output
    return
  }
  
if ($UseExistingDevServer -and $devServerListeners.Count -eq 0) {
    $thresholds = [ordered]@{ maxWindowToReadyMs=$MaxWindowToReadyMs; maxWindowToFrontendMountMs=$MaxWindowToFrontendMountMs; maxFrontendBootstrapMs=$MaxFrontendBootstrapMs; maxReadySignalToNativeLogMs=$MaxReadySignalToNativeLogMs }
    $artifacts = [ordered]@{ report=$reportPath; markdown=$markdownPath; stdout=$stdoutPath; stderr=$stderrPath; viteStdout=$viteStdoutPath; viteStderr=$viteStderrPath; appLog=$appLogPath }
    Complete-StartupPreflightCollection -RunDirectory $runDir -WorkspaceRoot $workspaceRoot -RunId $runId -DryRun $false -FailureCode 'dev-port-not-listening' -FailureMessage "Dev server port $DevServerPort is not listening. Start Vite first or run without -UseExistingDevServer." -Command $commandText -TimeoutSeconds $TimeoutSeconds -Thresholds $thresholds -DevServer ([ordered]@{ mode=$devServerMode; port=$DevServerPort; listeners=@() }) -Artifacts $artifacts -NoStop ([bool]$NoStop) | Write-Output
    return
  }
  
  $existingShellProcesses = @(Get-ExistingDesktopShellProcesses)
if ($existingShellProcesses.Count -gt 0) {
    $thresholds = [ordered]@{ maxWindowToReadyMs=$MaxWindowToReadyMs; maxWindowToFrontendMountMs=$MaxWindowToFrontendMountMs; maxFrontendBootstrapMs=$MaxFrontendBootstrapMs; maxReadySignalToNativeLogMs=$MaxReadySignalToNativeLogMs }
    $artifacts = [ordered]@{ report=$reportPath; markdown=$markdownPath; stdout=$stdoutPath; stderr=$stderrPath; viteStdout=$viteStdoutPath; viteStderr=$viteStderrPath; appLog=$appLogPath }
    Complete-StartupPreflightCollection -RunDirectory $runDir -WorkspaceRoot $workspaceRoot -RunId $runId -DryRun $false -FailureCode 'desktop-shell-already-running' -FailureMessage 'A dev desktop shell is already running. Close omni-desktop-shell.exe before measuring a fresh launch.' -Command $commandText -TimeoutSeconds $TimeoutSeconds -Thresholds $thresholds -DevServer ([ordered]@{ mode=$devServerMode; port=$DevServerPort; listeners=$devServerListeners }) -Artifacts $artifacts -NoStop ([bool]$NoStop) -ExistingDesktopShells $existingShellProcesses | Write-Output
    return
  }
  
  $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if ($null -eq $npmCommand) {
    $npmCommand = Get-Command npm -ErrorAction Stop
  }
  
  $npxCommand = Get-Command npx.cmd -ErrorAction SilentlyContinue
  if ($null -eq $npxCommand) {
    $npxCommand = Get-Command npx -ErrorAction SilentlyContinue
  }
  
  $initialLogOffset = 0
  if (Test-Path $appLogPath) {
    $initialLogOffset = (Get-Item $appLogPath).Length
  }
  
  $oldMeasureRunId = $env:OMNI_STARTUP_MEASURE_RUN_ID
  $oldViteMeasureRunId = $env:VITE_OMNI_STARTUP_MEASURE_RUN_ID
  $viteProcess = $null
  $viteProcessLease = $null
  $devServerWarmup = $null
  $devProcess = $null
  $devProcessLease = $null
  $windowInfo = $null
  $windowProcessLease = $null
  $readyMarker = $null
  $fullReadyMarkers = $null
  $processExited = $false
  $logOffset = $initialLogOffset
  $logBuffer = ''
  $launchStartedAtLocal = Get-Date
  $launchStartedAtUtc = Get-UtcIsoNow
  $stopwatch = [System.Diagnostics.Stopwatch]::new()
  
  try {
    $env:OMNI_STARTUP_MEASURE_RUN_ID = $runId
    $env:VITE_OMNI_STARTUP_MEASURE_RUN_ID = $runId
  
    if ($null -eq $npxCommand) {
      throw 'npx was not found on PATH.'
    }
  
    if (-not $UseExistingDevServer) {
      $viteProcess = Start-Process `
        -FilePath $npmCommand.Source `
        -ArgumentList @('run', 'dev', '--workspace', '@omni/desktop') `
        -WorkingDirectory $workspaceRoot `
        -RedirectStandardOutput $viteStdoutPath `
        -RedirectStandardError $viteStderrPath `
        -PassThru `
        -WindowStyle Hidden
      $viteProcessLease = Get-OmniProcessIdentity -ProcessId $viteProcess.Id -Ownership managed
  
      if (-not (Wait-DevServerReady -Port $DevServerPort -TimeoutSeconds 45)) {
        throw "Vite dev server did not become ready on port $DevServerPort."
      }
      $devServerListeners = @(Get-DevServerListeners -Port $DevServerPort)
    }
  
    if ($NoWarmup) {
      $devServerWarmup = [ordered]@{ requestCount = 0; elapsedMs = 0; mode = "disabled" }
      Write-Output "Dev server warmup disabled (-NoWarmup)."
    } elseif ($UseFastDev) {
      $devServerWarmup = Invoke-CriticalDevServerWarmup -Port $DevServerPort -TimeoutMs $CriticalWarmupTimeoutMs
      Write-Output "Critical dev server warmup requested $($devServerWarmup.requestCount) assets in $($devServerWarmup.elapsedMs) ms (mode=critical, cap=$CriticalWarmupTimeoutMs)."
    } else {
      $devServerWarmup = Invoke-DevServerWarmup -Port $DevServerPort -MaxRequests 40
      Write-Output "Dev server warmup requested $($devServerWarmup.requestCount) assets in $($devServerWarmup.elapsedMs) ms."
    }
  
    @{ build = @{ beforeDevCommand = '' } } |
      ConvertTo-Json -Depth 4 |
      Set-Content -Path $tauriConfigOverridePath -Encoding UTF8
    $launchFile = $npxCommand.Source
    $launchArgs = @('tauri', 'dev', '--config', $tauriConfigOverridePath)
    $launchWorkingDirectory = $desktopRoot
  
    Write-Output "Startup readiness run: $runId"
    Write-Output "Launching: $commandText"
  
    $launchStartedAtLocal = Get-Date
    $launchStartedAtUtc = Get-UtcIsoNow
    $stopwatch.Restart()
    $devProcess = Start-Process `
      -FilePath $launchFile `
      -ArgumentList $launchArgs `
      -WorkingDirectory $launchWorkingDirectory `
      -RedirectStandardOutput $stdoutPath `
      -RedirectStandardError $stderrPath `
      -PassThru `
      -WindowStyle Hidden
    $devProcessLease = Get-OmniProcessIdentity -ProcessId $devProcess.Id -Ownership managed
  
    while ($stopwatch.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
      if ($null -eq $windowInfo) {
        $candidate = Find-MainWindowProcess -LaunchStartedAtLocal $launchStartedAtLocal
        if ($null -ne $candidate) {
          $windowProcessLease = Get-OmniProcessIdentity -ProcessId $candidate.Process.Id -Ownership managed
          $windowInfo = [ordered]@{
            detected = $true
            detectedAt = Get-UtcIsoNow
            detectedElapsedMs = $stopwatch.ElapsedMilliseconds
            processId = $candidate.Process.Id
            processName = $candidate.Process.ProcessName
            title = $candidate.Process.MainWindowTitle
            startTime = $candidate.StartTime.ToString('o')
          }
          Write-Output "Window detected after $($windowInfo.detectedElapsedMs) ms (pid=$($windowInfo.processId))."
        }
      }
  
      $logRead = Read-NewTextFromFile -Path $appLogPath -Offset $logOffset
      $logOffset = $logRead.Offset
      if ($logRead.Text.Length -gt 0) {
        $logBuffer += $logRead.Text
        if ($logBuffer.Length -gt 200000) {
          $logBuffer = $logBuffer.Substring($logBuffer.Length - 200000)
        }
  
        $readyMarker = Find-ReadyMarker -Text $logBuffer -RunId $runId
        if ($null -eq $fullReadyMarkers -or -not $fullReadyMarkers.fullReady.detected) {
          $fullReadyMarkers = Find-FullReadyMarkers -Text $logBuffer
        }
        if ($null -ne $readyMarker) {
          break
        }
      }
  
      $devProcess.Refresh()
      if ($devProcess.HasExited) {
        $processExited = $true
        break
      }
  
      Start-Sleep -Milliseconds ([Math]::Max(50, [Math]::Min($WindowPollMs, $LogPollMs)))
    }
  } finally {
    $env:OMNI_STARTUP_MEASURE_RUN_ID = $oldMeasureRunId
    $env:VITE_OMNI_STARTUP_MEASURE_RUN_ID = $oldViteMeasureRunId
  
    if (-not $NoStop -and $null -ne $devProcess) {
      if ($null -ne $windowInfo -and $null -ne $windowInfo.processId) {
        try {
          $windowProcess = Get-Process -Id $windowInfo.processId -ErrorAction SilentlyContinue
          if ($null -ne $windowProcess) {
            [void]$windowProcess.CloseMainWindow()
            Start-Sleep -Milliseconds 1500
          }
        } catch {
          # The process tree cleanup below is the fallback.
        }
      }
  
      if ($windowProcessLease -and (Test-OmniProcessIdentity -Lease $windowProcessLease)) {
        Stop-OmniOwnedProcessTree -Lease $windowProcessLease | Out-Null
      }
      if ($devProcessLease -and (Test-OmniProcessIdentity -Lease $devProcessLease)) {
        Stop-OmniOwnedProcessTree -Lease $devProcessLease | Out-Null
      }
    }
  
    if (-not $NoStop -and $null -ne $viteProcess) {
      if ($viteProcessLease -and (Test-OmniProcessIdentity -Lease $viteProcessLease)) {
        Stop-OmniOwnedProcessTree -Lease $viteProcessLease | Out-Null
      }
    }
  }
  
  $readyInfo = [ordered]@{
    detected = $false
    detectedAt = $null
    detectedElapsedMs = $null
    observedElapsedMs = $null
    windowToReadyMs = $null
    frontend = $null
    markerLine = $null
    payloadError = $null
  }
  
  if ($null -ne $readyMarker) {
    $readyObservedElapsedMs = $stopwatch.ElapsedMilliseconds
    $readyElapsedMs = $readyObservedElapsedMs
    $readyDetectedAt = Get-UtcIsoNow
  
    if ($null -ne $readyMarker.LogTimestamp) {
      $readyDetectedAt = ([DateTimeOffset]$readyMarker.LogTimestamp).ToUniversalTime().ToString('o')
      $fromLog = [int][Math]::Round(($readyMarker.LogTimestamp - $launchStartedAtLocal).TotalMilliseconds)
      if ($fromLog -ge 0) {
        $readyElapsedMs = $fromLog
      }
    }
  
    $windowToReadyMs = $null
    if ($null -ne $windowInfo -and $null -ne $windowInfo.detectedElapsedMs) {
      $windowToReadyMs = $readyElapsedMs - $windowInfo.detectedElapsedMs
    }
    $frontendWindowToReadyMs = Get-WindowToFrontendReadyMs `
      -Frontend $readyMarker.Payload `
      -WindowInfo $windowInfo `
      -LaunchStartedAt ([DateTimeOffset]::Parse($launchStartedAtUtc))
    if ($null -ne $frontendWindowToReadyMs) {
      $windowToReadyMs = $frontendWindowToReadyMs
    }
  
    $readyInfo = [ordered]@{
      detected = $true
      detectedAt = $readyDetectedAt
      detectedElapsedMs = $readyElapsedMs
      observedElapsedMs = $readyObservedElapsedMs
      windowToReadyMs = $windowToReadyMs
      frontend = $readyMarker.Payload
      markerLine = $readyMarker.Line
      payloadError = $readyMarker.PayloadError
    }
  }
  
  if ($null -eq $windowInfo) {
    $windowInfo = [ordered]@{
      detected = $false
      detectedAt = $null
      detectedElapsedMs = $null
      processId = $null
      processName = $null
      title = 'Omni Translate'
      startTime = $null
    }
  }
  
$thresholds = [ordered]@{
    maxWindowToReadyMs = $MaxWindowToReadyMs
    maxWindowToFrontendMountMs = $MaxWindowToFrontendMountMs
    maxFrontendBootstrapMs = $MaxFrontendBootstrapMs
    maxReadySignalToNativeLogMs = $MaxReadySignalToNativeLogMs
  }
  $collection = [ordered]@{
    schemaVersion = 'startup-readiness-collection/v1'
    runId = $runId
    dryRun = $false
    preflightFailure = $null
    command = $commandText
    launchStartedAt = $launchStartedAtUtc
    timeoutSeconds = $TimeoutSeconds
    thresholds = $thresholds
    devServer = [ordered]@{
      mode = $devServerMode
      port = $DevServerPort
      listeners = $devServerListeners
      configOverride = $tauriConfigOverridePath
      warmup = $devServerWarmup
    }
    poll = [ordered]@{ windowPollMs=$WindowPollMs; logPollMs=$LogPollMs }
    window = $windowInfo
    readiness = $readyInfo
    fullReadinessRaw = $fullReadyMarkers
    process = [ordered]@{
      npmProcessId = if ($null -ne $devProcess) { $devProcess.Id } else { $null }
      viteProcessId = if ($null -ne $viteProcess) { $viteProcess.Id } else { $null }
      exitedBeforeReady = $processExited
      noStop = [bool]$NoStop
      existingDesktopShells = @()
    }
    artifacts = [ordered]@{
      report=$reportPath; markdown=$markdownPath; stdout=$stdoutPath; stderr=$stderrPath
      viteStdout=$viteStdoutPath; viteStderr=$viteStderrPath; appLog=$appLogPath
    }
  }
  Complete-StartupReadinessCollection -RunDirectory $runDir -WorkspaceRoot $workspaceRoot -Collection $collection | Write-Output
}

Export-ModuleMember -Function 'Invoke-StartupReadinessRun'
