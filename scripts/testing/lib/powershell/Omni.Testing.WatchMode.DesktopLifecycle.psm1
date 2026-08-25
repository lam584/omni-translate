#requires -Version 5.1

Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.Process.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.Windows.Elevation.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.Metrics.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.Provider.psm1') -Force
function Resolve-OmniBuiltExecutable {
  # Every workspace member builds into the root Cargo target directory.
  param(
    [Parameter(Mandatory = $true)][string]$BuildProfile,
    [Parameter(Mandatory = $true)][string]$ExecutableName,
    [Parameter(Mandatory = $true)][string]$WorkspaceRoot
  )
  return (Join-Path $WorkspaceRoot "target/$BuildProfile/$ExecutableName")
}

function Start-WatchModeDesktopShell {
  param(
    [Parameter(Mandatory = $true)]$Context,
    [string]$OutputDirectory,
    [string]$RunMarker,
    [string]$PhysicalDeviceId
  )
  $request = $Context.request
  $workspaceRoot = [string]$Context.paths.workspaceRoot
  $WatchAutoStopAfterSeconds = [int]$request.timeouts.sessionSeconds
  $WarmupSeconds = [int]$request.timeouts.warmupSeconds
  $FeedbackLoopPrevention = [string]$request.feedbackMode
  $AllowElevatedDesktopLaunch = [string]$request.desktop.elevation -eq 'allow'
  $StrictPaidAuthority = [string]$request.authorityMode -eq 'strict-paid'
  $IncidentReplayAuthority = [string]$request.authorityMode -eq 'incident-replay-plus'
  $LocalCanonicalContentAuthority = [string]$request.authorityMode -eq 'local-canonical-smoke'
  $localContentAuthorityEnabled = $StrictPaidAuthority -or $IncidentReplayAuthority -or $LocalCanonicalContentAuthority
  $MatrixCellId = [string]$request.matrix.cellId
  $WatchModelId = [string]$request.model.id
  $WatchRealtimeProtocol = [string]$request.model.protocol
  $SubtitleTranslationMode = [string]$request.model.subtitleTranslationMode
  $SubtitleTranslationModelId = [string]$request.model.subtitleModelId
  $InboundSecondaryAudioModelId = [string]$request.model.secondaryAudioModelId
  $stdout = Join-Path $OutputDirectory "desktop-shell.stdout.log"
  $stderr = Join-Path $OutputDirectory "desktop-shell.stderr.log"
  # A debug cargo build resolves Tauri's devUrl and the old harness paired it
  # with a placeholder HTML server. That path cannot exercise the real React
  # overlay or generate render receipts. Live evidence must use the production
  # binary whose frontendDist contains the actual main and overlay pages. Build
  # it once before the model matrix with `npm run build:tauri --workspace
  # @omni/desktop`; model timing begins only when this executable launches.
  $buildLog = $null
  $buildErrLog = $null
  $cargoLog = $null
  $cargoErrLog = $null
  $exe = Resolve-OmniBuiltExecutable -BuildProfile "release" -ExecutableName "omni-desktop-shell.exe" -WorkspaceRoot $workspaceRoot
  if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    throw "production desktop shell was not built: $exe. Run 'npm run build:tauri --workspace @omni/desktop' first."
  }
  $providerInputPcmPath = Join-Path $OutputDirectory "provider-input-16k-mono.pcm"
  $watchSessionReportPath = Join-Path $OutputDirectory "watch-session-report.json"
  $watchReadinessPath = Join-Path $OutputDirectory "watch-runtime-status.json"
  $watchReportAutoStopAfterMs = $WatchAutoStopAfterSeconds * 1000
  $liveScenarioEnvironment = Get-WatchModeLiveScenarioEnvironment `
    -FeedbackMode $FeedbackLoopPrevention `
    -AutoStopAfterMs $watchReportAutoStopAfterMs
  Remove-Item -LiteralPath $watchSessionReportPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $watchReadinessPath -Force -ErrorAction SilentlyContinue
  $previousAutostart = $env:OMNI_WATCH_MODE_AUTOSTART
  $previousRunMarker = $env:OMNI_WATCH_MODE_RUN_MARKER
  $previousOutputDevice = $env:OMNI_WATCH_MODE_OUTPUT_DEVICE_ID
  $previousOutputLevel = $env:OMNI_WATCH_MODE_OUTPUT_LEVEL
  $previousSubtitleTranslationMode = $env:OMNI_WATCH_MODE_SUBTITLE_TRANSLATION_MODE
  $previousTranslationAudioSource = $env:OMNI_WATCH_MODE_TRANSLATION_AUDIO_SOURCE
  $previousProviderInputPcmPath = $env:OMNI_WATCH_MODE_PROVIDER_INPUT_PCM_PATH
  $previousProviderInputMaxSamples = $env:OMNI_WATCH_MODE_PROVIDER_INPUT_MAX_SAMPLES
  $previousProviderInputLedgerPath = $env:OMNI_WATCH_MODE_PROVIDER_INPUT_LEDGER_PATH
  $previousProviderInputCellId = $env:OMNI_WATCH_MODE_CELL_ID
  $previousProviderInputLeaseId = $env:OMNI_WATCH_MODE_PROVIDER_INPUT_LEASE_ID
  $previousIncidentReplayAuthority = $env:OMNI_WATCH_MODE_INCIDENT_REPLAY_AUTHORITY
  $previousIncidentId = $env:OMNI_WATCH_MODE_INCIDENT_ID
  $previousTranslatedPcmAuthorityDir = $env:OMNI_WATCH_MODE_TRANSLATED_PCM_AUTHORITY_DIR
  $previousWatchModelId = $env:OMNI_WATCH_MODE_MODEL_ID
  $previousWatchRealtimeProtocol = $env:OMNI_WATCH_MODE_REALTIME_PROTOCOL
  $previousSubtitleTranslationModelId = $env:OMNI_WATCH_MODE_SUBTITLE_TRANSLATION_MODEL_ID
  $previousInboundSecondaryAudioModelId = $env:OMNI_WATCH_MODE_INBOUND_SECONDARY_AUDIO_MODEL_ID
  $previousFeedbackLoopPrevention = $env:OMNI_WATCH_MODE_FEEDBACK_LOOP_PREVENTION
  $previousProcessExclusionRestartAfterMs = $env:OMNI_WATCH_MODE_PROCESS_EXCLUSION_RESTART_AFTER_MS
  $previousAecLiveScenario = $env:OMNI_WATCH_MODE_AEC_LIVE_SCENARIO
  $previousAutoStopAfterMs = $env:OMNI_WATCH_MODE_AUTO_STOP_AFTER_MS
  $previousReportPath = $env:OMNI_WATCH_MODE_REPORT_PATH
  $previousExitAfterReport = $env:OMNI_WATCH_MODE_EXIT_AFTER_REPORT
  $previousReadinessPath = $env:OMNI_WATCH_MODE_READINESS_PATH
  $previousLogLevel = $env:OMNI_LOG_LEVEL
  $elevatedLaunch = $null
  $strictPaidProviderEnvironment = $null
  try {
    $strictPaidProviderEnvironment = Enter-StrictPaidProviderEnvironment `
      -Enabled $StrictPaidAuthority `
      -IncidentReplay $IncidentReplayAuthority `
      -LocalSingleSession $LocalCanonicalContentAuthority
    $env:OMNI_WATCH_MODE_AUTOSTART = "1"
    $env:OMNI_WATCH_MODE_RUN_MARKER = $RunMarker
    $diagnosticOutputDeviceId = if ($PhysicalDeviceId) { $PhysicalDeviceId } else { "default" }
    $diagnosticSubtitleTranslationMode = $SubtitleTranslationMode
    $env:OMNI_WATCH_MODE_OUTPUT_DEVICE_ID = $diagnosticOutputDeviceId
    $env:OMNI_WATCH_MODE_OUTPUT_LEVEL = "50"
    # Echo-cancel evidence replays the realtime model's native output so AEC
    # observes the exact speaker signal. The virtual-driver route retains the
    # secondary subtitle-TTS path that it isolates from inbound capture.
    $env:OMNI_WATCH_MODE_SUBTITLE_TRANSLATION_MODE = $diagnosticSubtitleTranslationMode
    $env:OMNI_WATCH_MODE_TRANSLATION_AUDIO_SOURCE = if ($SubtitleTranslationMode -eq "native") { "omni-native" } else { "subtitle-tts" }
    $env:OMNI_WATCH_MODE_PROVIDER_INPUT_PCM_PATH = $providerInputPcmPath
    if ($localContentAuthorityEnabled) {
      $env:OMNI_WATCH_MODE_PROVIDER_INPUT_MAX_SAMPLES = "$($WatchAutoStopAfterSeconds * 16000)"
      $ledgerFileName = if ($LocalCanonicalContentAuthority) {
        "smoke-provider-session-ledger.json"
      } else {
        "provider-input-budget-ledger.json"
      }
      $env:OMNI_WATCH_MODE_PROVIDER_INPUT_LEDGER_PATH = Join-Path $OutputDirectory $ledgerFileName
      $env:OMNI_WATCH_MODE_CELL_ID = $MatrixCellId
      $translatedPcmAuthorityDirectory = Join-Path $OutputDirectory "translated-cue-pcm"
      # The Rust authority owns exclusive creation of this directory. Creating
      # it here would turn a clean strict-paid launch into a deterministic
      # fail-closed collision before the first provider connection.
      $env:OMNI_WATCH_MODE_TRANSLATED_PCM_AUTHORITY_DIR = $translatedPcmAuthorityDirectory
      # Production workers consume a coordinator-issued lease. A local smoke
      # cell mints a run-scoped non-authoritative lease that cannot be reused
      # by the production matrix authority.
      $env:OMNI_WATCH_MODE_PROVIDER_INPUT_LEASE_ID = if ($LocalCanonicalContentAuthority) {
        "smoke-$([guid]::NewGuid().ToString('N'))"
      } else {
        $previousProviderInputLeaseId.Trim()
      }
      $leaseArtifactKind = if ($LocalCanonicalContentAuthority) {
        "watch-mode-smoke-provider-session-lease"
      } else {
        "watch-mode-provider-input-budget-lease"
      }
      $leaseFileName = if ($LocalCanonicalContentAuthority) {
        "smoke-provider-session-lease.json"
      } else {
        "provider-input-budget-lease.json"
      }
      $leaseReceipt = [ordered]@{
        schemaVersion = 1
        artifactKind = $leaseArtifactKind
        nonAuthoritative = [bool]$LocalCanonicalContentAuthority
        cellId = $MatrixCellId
        leaseId = $env:OMNI_WATCH_MODE_PROVIDER_INPUT_LEASE_ID
        runMarker = $RunMarker
        maxSamples = [int]$env:OMNI_WATCH_MODE_PROVIDER_INPUT_MAX_SAMPLES
      }
      $leaseReceiptJson = $leaseReceipt | ConvertTo-Json -Depth 3
      [System.IO.File]::WriteAllText(
        (Join-Path $OutputDirectory $leaseFileName),
        $leaseReceiptJson,
        [System.Text.UTF8Encoding]::new($false)
      )
    }
    if ($WatchModelId) {
      $env:OMNI_WATCH_MODE_MODEL_ID = $WatchModelId
    }
    if ($WatchRealtimeProtocol) {
      $env:OMNI_WATCH_MODE_REALTIME_PROTOCOL = $WatchRealtimeProtocol
    }
    if ($SubtitleTranslationMode -eq "secondary" -and $SubtitleTranslationModelId) {
      $env:OMNI_WATCH_MODE_SUBTITLE_TRANSLATION_MODEL_ID = $SubtitleTranslationModelId
    } elseif ($SubtitleTranslationMode -eq "native") {
      $env:OMNI_WATCH_MODE_SUBTITLE_TRANSLATION_MODEL_ID = ""
    }
    if ($SubtitleTranslationMode -eq "secondary" -and $InboundSecondaryAudioModelId) {
      $env:OMNI_WATCH_MODE_INBOUND_SECONDARY_AUDIO_MODEL_ID = $InboundSecondaryAudioModelId
    } elseif ($SubtitleTranslationMode -eq "native") {
      $env:OMNI_WATCH_MODE_INBOUND_SECONDARY_AUDIO_MODEL_ID = ""
    }
    $env:OMNI_WATCH_MODE_FEEDBACK_LOOP_PREVENTION = $FeedbackLoopPrevention
    $env:OMNI_WATCH_MODE_PROCESS_EXCLUSION_RESTART_AFTER_MS = $liveScenarioEnvironment.processExclusionRestartAfterMs
    $env:OMNI_WATCH_MODE_AEC_LIVE_SCENARIO = $liveScenarioEnvironment.aecLiveScenario
    $env:OMNI_WATCH_MODE_AUTO_STOP_AFTER_MS = $liveScenarioEnvironment.autoStopAfterMs
    $env:OMNI_WATCH_MODE_REPORT_PATH = $watchSessionReportPath
    $env:OMNI_WATCH_MODE_READINESS_PATH = $watchReadinessPath
    $env:OMNI_WATCH_MODE_EXIT_AFTER_REPORT = "1"
    if ($localContentAuthorityEnabled) {
      # Debug model-trace summaries and the PCM dump cross-check the Rust
      # send-boundary ledger, which remains the paid-input authority.
      $env:OMNI_LOG_LEVEL = "debug"
    }
    if ($AllowElevatedDesktopLaunch) {
      $watchEnvironmentNames = @(
        "OMNI_WATCH_MODE_AUTOSTART",
        "OMNI_WATCH_MODE_RUN_MARKER",
        "OMNI_WATCH_MODE_OUTPUT_DEVICE_ID",
        "OMNI_WATCH_MODE_OUTPUT_LEVEL",
        "OMNI_WATCH_MODE_SUBTITLE_TRANSLATION_MODE",
        "OMNI_WATCH_MODE_TRANSLATION_AUDIO_SOURCE",
        "OMNI_WATCH_MODE_PROVIDER_INPUT_PCM_PATH",
        "OMNI_WATCH_MODE_PROVIDER_INPUT_MAX_SAMPLES",
        "OMNI_WATCH_MODE_PROVIDER_INPUT_LEDGER_PATH",
        "OMNI_WATCH_MODE_CELL_ID",
        "OMNI_WATCH_MODE_PROVIDER_INPUT_LEASE_ID",
        "OMNI_WATCH_MODE_INCIDENT_REPLAY_AUTHORITY",
        "OMNI_WATCH_MODE_INCIDENT_ID",
        "OMNI_WATCH_MODE_TRANSLATED_PCM_AUTHORITY_DIR",
        "OMNI_WATCH_MODE_MODEL_ID",
        "OMNI_WATCH_MODE_REALTIME_PROTOCOL",
        "OMNI_WATCH_MODE_SUBTITLE_TRANSLATION_MODEL_ID",
        "OMNI_WATCH_MODE_INBOUND_SECONDARY_AUDIO_MODEL_ID",
        "OMNI_WATCH_MODE_FEEDBACK_LOOP_PREVENTION",
        "OMNI_WATCH_MODE_PROCESS_EXCLUSION_RESTART_AFTER_MS",
        "OMNI_WATCH_MODE_AEC_LIVE_SCENARIO",
        "OMNI_WATCH_MODE_AUTO_STOP_AFTER_MS",
        "OMNI_WATCH_MODE_REPORT_PATH",
        "OMNI_WATCH_MODE_READINESS_PATH",
        "OMNI_WATCH_MODE_EXIT_AFTER_REPORT",
        "OMNI_LOG_LEVEL"
      )
      if ($localContentAuthorityEnabled) {
        $watchEnvironmentNames += @($strictPaidProviderEnvironment.names)
      }
      $launchEnvironment = @{}
      foreach ($name in $watchEnvironmentNames) {
        $launchEnvironment[$name] = [System.Environment]::GetEnvironmentVariable($name, [System.EnvironmentVariableTarget]::Process)
      }
      $elevatedLaunch = Start-ElevatedWatchModeDesktopShell `
        -ExecutablePath $exe `
        -WorkingDirectory (Join-Path $workspaceRoot "apps/desktop/src-tauri") `
        -OutputDirectory $OutputDirectory `
        -LaunchEnvironment $launchEnvironment `
        -StdoutPath $stdout `
        -StderrPath $stderr
      $desktopLaunchedAtUtc = $elevatedLaunch.launchedAtUtc
      $process = [pscustomobject]@{ Id = $elevatedLaunch.pid }
    } else {
      try {
        $desktopLaunchedAtUtc = [DateTime]::UtcNow
        $process = Start-Process -FilePath $exe -WorkingDirectory (Join-Path $workspaceRoot "apps/desktop/src-tauri") -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden -PassThru
      } catch {
        if ($_.Exception.Message -match "requires elevation|requires elevated|740") {
          throw "desktop shell requires elevation; rerun with -AllowElevatedDesktopLaunch so the runner can start it via UAC"
        }
        throw
      }
    }

    $processLease = if ($elevatedLaunch) {
      $null
    } else {
      Get-OmniProcessIdentity -ProcessId $process.Id -Ownership managed
    }
  } finally {
    $env:OMNI_WATCH_MODE_AUTOSTART = $previousAutostart
    $env:OMNI_WATCH_MODE_RUN_MARKER = $previousRunMarker
    $env:OMNI_WATCH_MODE_OUTPUT_DEVICE_ID = $previousOutputDevice
    $env:OMNI_WATCH_MODE_OUTPUT_LEVEL = $previousOutputLevel
    $env:OMNI_WATCH_MODE_SUBTITLE_TRANSLATION_MODE = $previousSubtitleTranslationMode
    $env:OMNI_WATCH_MODE_TRANSLATION_AUDIO_SOURCE = $previousTranslationAudioSource
    $env:OMNI_WATCH_MODE_PROVIDER_INPUT_PCM_PATH = $previousProviderInputPcmPath
    $env:OMNI_WATCH_MODE_PROVIDER_INPUT_MAX_SAMPLES = $previousProviderInputMaxSamples
    $env:OMNI_WATCH_MODE_PROVIDER_INPUT_LEDGER_PATH = $previousProviderInputLedgerPath
    $env:OMNI_WATCH_MODE_CELL_ID = $previousProviderInputCellId
    $env:OMNI_WATCH_MODE_PROVIDER_INPUT_LEASE_ID = $previousProviderInputLeaseId
    $env:OMNI_WATCH_MODE_INCIDENT_REPLAY_AUTHORITY = $previousIncidentReplayAuthority
    $env:OMNI_WATCH_MODE_INCIDENT_ID = $previousIncidentId
    Exit-StrictPaidProviderEnvironment $strictPaidProviderEnvironment
    $env:OMNI_WATCH_MODE_TRANSLATED_PCM_AUTHORITY_DIR = $previousTranslatedPcmAuthorityDir
    $env:OMNI_WATCH_MODE_MODEL_ID = $previousWatchModelId
    $env:OMNI_WATCH_MODE_REALTIME_PROTOCOL = $previousWatchRealtimeProtocol
    $env:OMNI_WATCH_MODE_SUBTITLE_TRANSLATION_MODEL_ID = $previousSubtitleTranslationModelId
    $env:OMNI_WATCH_MODE_INBOUND_SECONDARY_AUDIO_MODEL_ID = $previousInboundSecondaryAudioModelId
    $env:OMNI_WATCH_MODE_FEEDBACK_LOOP_PREVENTION = $previousFeedbackLoopPrevention
    $env:OMNI_WATCH_MODE_PROCESS_EXCLUSION_RESTART_AFTER_MS = $previousProcessExclusionRestartAfterMs
    $env:OMNI_WATCH_MODE_AEC_LIVE_SCENARIO = $previousAecLiveScenario
    $env:OMNI_WATCH_MODE_AUTO_STOP_AFTER_MS = $previousAutoStopAfterMs
    $env:OMNI_WATCH_MODE_REPORT_PATH = $previousReportPath
    $env:OMNI_WATCH_MODE_READINESS_PATH = $previousReadinessPath
    $env:OMNI_WATCH_MODE_EXIT_AFTER_REPORT = $previousExitAfterReport
    $env:OMNI_LOG_LEVEL = $previousLogLevel
  }
  $systemMetricsSampler = $null
  try {
    $systemMetricsSampler = Start-WatchModeSystemMetricsSampler `
      -ProcessId ([int]$process.Id) `
      -OutputDirectory $OutputDirectory `
      -WorkspaceRoot $workspaceRoot
    Start-Sleep -Seconds $WarmupSeconds
  } catch {
    if ($elevatedLaunch) {
      Stop-ElevatedWatchModeDesktopLaunch $elevatedLaunch | Out-Null
    } else {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
    Stop-WatchModeSystemMetricsSampler $systemMetricsSampler
    throw
  }
  return [pscustomobject]@{
    pid = $process.Id
    processLease = $processLease
    stdout = $stdout
    stderr = $stderr
    buildLog = $buildLog
    cargoBuildLog = $cargoLog
    buildErrorLog = $buildErrLog
    cargoBuildErrorLog = $cargoErrLog
    watchSessionReportPath = $watchSessionReportPath
    watchReadinessPath = $watchReadinessPath
    watchReportAutoStopAfterMs = $watchReportAutoStopAfterMs
    launchedAtUtc = $desktopLaunchedAtUtc
    systemMetricsSampler = $systemMetricsSampler
    guardianPid = if ($elevatedLaunch) { $elevatedLaunch.guardianPid } else { $null }
    guardianLeasePath = if ($elevatedLaunch) { $elevatedLaunch.guardianLeasePath } else { $null }
    guardianEnvironmentPath = if ($elevatedLaunch) { $elevatedLaunch.guardianEnvironmentPath } else { $null }
    guardianReceiptPath = if ($elevatedLaunch) { $elevatedLaunch.guardianReceiptPath } else { $null }
  }
}

function Stop-WatchModeDesktopShell {
  param([Parameter(Mandatory = $true)]$Context, $DesktopProcessStep)
  $AllowElevatedDesktopLaunch = [string]$Context.request.desktop.elevation -eq 'allow'
  if ($AllowElevatedDesktopLaunch) {
    $trackedLaunch = if ($DesktopProcessStep -and $DesktopProcessStep.status -eq 'passed' -and $DesktopProcessStep.data -and $DesktopProcessStep.data.guardianLeasePath) {
      $DesktopProcessStep.data
    } else {
      $null
    }
    if ($trackedLaunch) {
      return Stop-ElevatedWatchModeDesktopLaunch $trackedLaunch
    }
    return [pscustomobject]@{
      stopped = $false
      reason = 'elevated desktop launch never produced a tracked guardian receipt'
    }
  }
  if ($DesktopProcessStep -and $DesktopProcessStep.status -eq 'passed' -and $DesktopProcessStep.data -and $DesktopProcessStep.data.pid) {
    if (-not $DesktopProcessStep.data.processLease) {
      throw "managed desktop cleanup has no process lease: pid=$($DesktopProcessStep.data.pid)"
    }
    if (Test-OmniProcessIdentity -Lease $DesktopProcessStep.data.processLease) {
      Stop-OmniOwnedProcessTree -Lease $DesktopProcessStep.data.processLease | Out-Null
    }
  }
}

function Stop-StaleWatchModeDesktopShell {
  $staleProcesses = @(Get-Process -Name "omni-desktop-shell" -ErrorAction SilentlyContinue)
  if ($staleProcesses.Count -gt 0) {
    $ids = ($staleProcesses.Id | ForEach-Object { "$_" }) -join ","
    throw "refusing to terminate an unleased omni-desktop-shell; close the existing instance before this run (pid=$ids)"
  }
  return [pscustomobject]@{
    stoppedProcessCount = 0
  }
}

Export-ModuleMember -Function @(
  'Start-WatchModeDesktopShell',
  'Stop-WatchModeDesktopShell',
  'Stop-StaleWatchModeDesktopShell'
)
