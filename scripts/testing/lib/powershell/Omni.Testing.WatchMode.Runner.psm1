#requires -Version 5.1
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.IO.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.Process.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.Windows.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.Windows.Audio.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.Windows.Elevation.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.Configuration.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.Readiness.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.Metrics.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.AudioAnalysis.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.Bridge.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.Report.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.Provider.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.AudioCapture.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.DesktopLifecycle.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.RawContent.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.EvidenceCollection.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.Step.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.StateMachine.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.Preflight.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.FixtureRunner.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.PlatformOperations.psm1') -Force -DisableNameChecking
function Invoke-Step {
  param(
    [Parameter(Mandatory = $true)]$State,
    [string]$Name,
    [Parameter(Mandatory = $true)][string]$Phase,
    [scriptblock]$Script,
    [switch]$ContinueOnError
  )
  Write-Host "==> $Name"
  $step = Invoke-OmniRunPhase -State $State -Id ($Name -replace '[^A-Za-z0-9._-]', '-') `
    -Phase $Phase -Action $Script
  if ($step.status -eq 'failed' -and -not $ContinueOnError) {
    throw $step.error.message
  }
  return $step
}

function Invoke-WatchModeRun {
  param(
    [Parameter(Mandatory = $true)]$Context,
    [Parameter(Mandatory = $true)]$Request,
    [string]$DevconPath
  )
  $runContext = $Context
  $request = $Request
  $workspaceRoot = [string]$Context.paths.workspaceRoot
  $DryRun = $request.runMode -eq 'fixture'
  $Fixture = 'pass'
  $FixtureRoot = 'scripts/testing/fixtures/watch-mode-live'
  $OutputRoot = [string]$request.paths.outputRoot
  $RuntimeRoot = [string]$request.paths.runtimeRoot
  $WarmupSeconds = [int]$request.timeouts.warmupSeconds
  $PlaybackSeconds = [int]$request.media.playbackSeconds
  $PostPlaybackWaitSeconds = [int]$request.timeouts.postPlaybackSeconds
  $SessionReadyTimeoutSeconds = [int]$request.timeouts.readinessSeconds
  $WatchAutoStopAfterSeconds = [int]$request.timeouts.sessionSeconds
  $SkipDriverRepair = $request.driverPolicy -ne 'repair-if-needed'
  $AllowDriverRepair = $request.driverPolicy -eq 'repair-if-needed'
  $UseDefaultEndpointPlayback = $false
  $StopDesktopAfterPlayback = $false
  $AllowElevatedDesktopLaunch = $request.desktop.elevation -eq 'allow'
  $SkipPhysicalOutputContentStt = $request.physicalContentMode -eq 'disabled'
  $StrictPaidAuthority = $request.authorityMode -eq 'strict-paid'
  $IncidentReplayAuthority = $request.authorityMode -eq 'incident-replay-plus'
  $LocalCanonicalContentAuthority = $request.authorityMode -eq 'local-canonical-smoke'
  $MatrixCellId = [string]$request.matrix.cellId
  $WorkerReadinessReceiptPath = [string]$request.paths.workerReadinessReceipt
  $MediaPath = [string]$request.media.path
  $WatchModelId = [string]$request.model.id
  $WatchRealtimeProtocol = [string]$request.model.protocol
  $SubtitleTranslationMode = [string]$request.model.subtitleTranslationMode
  $SubtitleTranslationModelId = [string]$request.model.subtitleModelId
  $InboundSecondaryAudioModelId = [string]$request.model.secondaryAudioModelId
  $PhysicalPlaybackDeviceId = [string]$request.physicalDevice.id
  $PhysicalPlaybackDeviceClass = [string]$request.physicalDevice.class
  $PhysicalPlaybackDeviceProfileId = [string]$request.physicalDevice.profileId
  $FeedbackLoopPrevention = [string]$request.feedbackMode
  $ExpectedPhysicalPlaybackDeviceName = [string]$request.physicalDevice.expectedName
  $paidAuthorityEnabled = $StrictPaidAuthority -or $IncidentReplayAuthority
  $localContentAuthorityEnabled = $paidAuthorityEnabled -or $LocalCanonicalContentAuthority
  $providerAuthorityMode = [string]$request.authorityMode
  Set-Location $workspaceRoot
  
  Assert-WatchModeAuthorityRequest -Context $Context
  
  
  $outputDir = New-OmniTestingOutputDirectory -Root $OutputRoot -ModelId $WatchModelId `
    -FeedbackMode $FeedbackLoopPrevention -DeviceProfileId $PhysicalPlaybackDeviceProfileId
  $runMarker = "watch_mode_diagnostic.run_id=$([System.Guid]::NewGuid().ToString('N'))"
  $startedAtLocal = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  
  if ($DryRun) {
    Invoke-WatchModeFixtureRun -Context $runContext -Request $request -OutputDirectory $outputDir
    return
  }
  $state = New-OmniRunState -Context $runContext -Request $request
  $steps = $state.steps
  $desktopProcess = $null
  $desktopEnvState = $null
  $driverProbe = $null
  $playbackStep = $null
  $physicalOutputRecorder = $null
  $physicalOutputRecorderStep = $null
  $physicalOutputRecordingStep = $null
  $physicalOutputContentStep = $null
  $deviceEvidenceStep = $null
  $sourceMediaTranscriptStep = $null
  $virtualDriverMediaPreflight = $null
  $runException = $null
  try {
    $runtimePathForMarker = Resolve-Path -LiteralPath $RuntimeRoot -ErrorAction SilentlyContinue
    $appLogForMarker = if ($runtimePathForMarker) { Join-Path $runtimePathForMarker.Path "app.log" } else { Join-Path $RuntimeRoot "app.log" }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $appLogForMarker) | Out-Null
    Add-Content -LiteralPath $appLogForMarker -Value $runMarker -Encoding UTF8
    $desktopEnvState = Set-DesktopAutostartEnvFile -RunMarker $runMarker -OutputDirectory $outputDir `
      -WorkspaceRoot $workspaceRoot -Context $runContext
  
    # Windows PowerShell promotes cargo's successful stderr progress line to a
    # NativeCommandError when ErrorActionPreference=Stop. Run npm through cmd
    # with stdout/stderr merged so a zero exit remains a successful build step.
    Invoke-Step -State $state "build bridge service native" -Phase initialize {
      & cmd.exe /d /c 'npm.cmd run build:bridge-service-native 2>&1'
    } -ContinueOnError | Out-Null
    Invoke-Step -State $state "verify no unleased desktop shell exists before live run" -Phase preflight {
      Stop-StaleWatchModeDesktopShell
    } | Out-Null
    Invoke-Step -State $state "stop stale bridge service before driver probe" -Phase preflight {
      Stop-StaleBridgeService $workspaceRoot $RuntimeRoot
    } -ContinueOnError | Out-Null
    if (Test-UsesVirtualDriverBackend $FeedbackLoopPrevention) {
      if ($paidAuthorityEnabled) {
        $driverProbe = Invoke-Step -State $state "driver probe from signed worker readiness" -Phase driverProbe {
          Get-SignedWorkerReadinessDriverProbe -ReceiptPath $WorkerReadinessReceiptPath -WorkspaceRoot $workspaceRoot
        } -ContinueOnError
      } else {
        $driverProbeArguments = Get-WatchModeDriverProbeArguments `
          -WorkspaceRoot $workspaceRoot `
          -RequestedDevconPath $DevconPath
        $driverProbe = Invoke-Step -State $state "driver probe" -Phase driverProbe {
          & (Join-Path $workspaceRoot "scripts/installer/test-development-driver.ps1") @driverProbeArguments
        } -ContinueOnError
      }
  
      if ($driverProbe.status -ne 'passed' -and -not $SkipDriverRepair -and $AllowDriverRepair) {
        Invoke-Step -State $state "repair driver with explicit elevation" -Phase driverProbe { Invoke-ElevatedDriverReinstall $outputDir $runContext } -ContinueOnError | Out-Null
        $driverProbe = Invoke-Step -State $state "driver probe after repair" -Phase driverProbe {
          & (Join-Path $workspaceRoot "scripts/installer/test-development-driver.ps1") @driverProbeArguments
        } -ContinueOnError
      }
      elseif ($driverProbe.status -ne 'passed' -and -not $SkipDriverRepair -and -not $AllowDriverRepair) {
        Write-Host "driver probe failed; skipping elevated repair because -AllowDriverRepair was not provided"
      }
    } else {
      $driverProbe = Invoke-OmniRunPhase -State $state -Id 'driver-probe' -Phase driverProbe `
        -PolicySkipReason "$FeedbackLoopPrevention does not install, probe, or depend on the virtual driver"
    }
    Convert-DriverProbeToJsonFile $driverProbe (Join-Path $outputDir "driver.json")
    $driverPreflightFailure = Get-VirtualDriverPreflightFailure $FeedbackLoopPrevention $driverProbe
    if ($driverPreflightFailure) { throw $driverPreflightFailure }
  
    $bridgeSourceProbe = if ($FeedbackLoopPrevention -eq "echo-cancel") {
      Invoke-OmniRunPhase -State $state -Id 'bridge-source-frame-probe' -Phase bridgeProbe `
        -PolicySkipReason 'echo-cancel Watch capture does not use a Bridge source backend'
    } else {
      Invoke-Step -State $state "bridge source frame probe" -Phase bridgeProbe {
        Invoke-BridgeSourceProbe -OutputDirectory $outputDir -FeedbackMode $FeedbackLoopPrevention `
          -WorkspaceRoot $workspaceRoot
      } -ContinueOnError
    }
    if ($bridgeSourceProbe.status -eq 'passed') {
      $bridgeSourceProbe.data | ConvertTo-Json -Depth 12 | Set-Content -Path (Join-Path $outputDir "bridge-source-probe.json") -Encoding UTF8
    } else {
      $bridgeDiagnosticsPath = Join-Path $outputDir "bridge-source-probe-diagnostics.json"
      if (Test-Path -LiteralPath $bridgeDiagnosticsPath -PathType Leaf) {
        Get-Content -LiteralPath $bridgeDiagnosticsPath -Raw -Encoding UTF8 | Set-Content -Path (Join-Path $outputDir "bridge-source-probe.json") -Encoding UTF8
      } else {
        [pscustomobject]@{ passed = $false; error = $bridgeSourceProbe.error.message } | ConvertTo-Json -Depth 8 | Set-Content -Path (Join-Path $outputDir "bridge-source-probe.json") -Encoding UTF8
      }
    }
    if ($FeedbackLoopPrevention -ne "echo-cancel" -and $bridgeSourceProbe.status -ne 'passed') {
      throw "bridge source frame preflight failed before the Desktop/LLM session: $($bridgeSourceProbe.error.message)"
    }
  
    $virtualDriverMediaPreflight = if (Test-UsesVirtualDriverBackend $FeedbackLoopPrevention) {
      Invoke-Step -State $state "virtual-driver media source preflight" -Phase preflight {
        Invoke-VirtualDriverMediaSourcePreflight `
          -OutputDirectory $outputDir `
          -VirtualRenderEndpointId ([string]$driverProbe.data.WasapiEndpointId) `
          -PathToMedia $MediaPath `
          -WorkspaceRoot $workspaceRoot
      } -ContinueOnError
    } else {
      Invoke-OmniRunPhase -State $state -Id 'virtual-driver-media-source-preflight' -Phase preflight `
        -PolicySkipReason "$FeedbackLoopPrevention does not use the virtual-driver media path"
    }
    if ($virtualDriverMediaPreflight.status -eq 'passed') {
      $virtualDriverMediaPreflight.data | ConvertTo-Json -Depth 12 | Set-Content -Path (Join-Path $outputDir "virtual-driver-media-source-preflight.json") -Encoding UTF8
    } else {
      $preflightDiagnosticsPath = Join-Path $outputDir "virtual-driver-media-source-preflight-diagnostics.json"
      if (Test-Path -LiteralPath $preflightDiagnosticsPath -PathType Leaf) {
        Get-Content -LiteralPath $preflightDiagnosticsPath -Raw -Encoding UTF8 | Set-Content -Path (Join-Path $outputDir "virtual-driver-media-source-preflight.json") -Encoding UTF8
      } else {
        [pscustomobject]@{ passed = $false; error = $virtualDriverMediaPreflight.error.message } | ConvertTo-Json -Depth 8 | Set-Content -Path (Join-Path $outputDir "virtual-driver-media-source-preflight.json") -Encoding UTF8
      }
      throw "virtual-driver media source preflight failed before the Desktop/LLM session: $($virtualDriverMediaPreflight.error.message)"
    }
  
    $physicalOutputProbe = if ($FeedbackLoopPrevention -eq "echo-cancel") {
      Invoke-OmniRunPhase -State $state -Id 'physical-output-loopback-probe' -Phase preflight `
        -PolicySkipReason 'echo-cancel does not use a Bridge physical-output isolation probe'
    } else {
      Invoke-Step -State $state "physical output loopback probe" -Phase preflight {
        Invoke-PhysicalOutputProbe $outputDir $FeedbackLoopPrevention $workspaceRoot $PhysicalPlaybackDeviceId $ExpectedPhysicalPlaybackDeviceName
      } -ContinueOnError
    }
    if ($physicalOutputProbe.status -eq 'passed') {
      $physicalOutputProbe.data | ConvertTo-Json -Depth 12 | Set-Content -Path (Join-Path $outputDir "physical-output-probe.json") -Encoding UTF8
      Set-DesktopPhysicalPlaybackOverride -DeviceId (Get-PhysicalOutputResolvedDeviceId $physicalOutputProbe) `
        -WorkspaceRoot $workspaceRoot
    } else {
      [pscustomobject]@{ error = $physicalOutputProbe.error.message } | ConvertTo-Json -Depth 8 | Set-Content -Path (Join-Path $outputDir "physical-output-probe.json") -Encoding UTF8
    }
  
    $deviceEvidenceStep = Invoke-Step -State $state "resolve and classify physical playback endpoint" -Phase preflight {
      Resolve-PhysicalPlaybackDeviceEvidence -PhysicalOutputProbe $physicalOutputProbe `
        -FeedbackMode $FeedbackLoopPrevention -RequestedDeviceId $PhysicalPlaybackDeviceId `
        -ExpectedDeviceName $ExpectedPhysicalPlaybackDeviceName -ProfileId $PhysicalPlaybackDeviceProfileId `
        -DeviceClass $PhysicalPlaybackDeviceClass
    } -ContinueOnError
    if ($deviceEvidenceStep.status -ne 'passed') {
      throw "physical playback device evidence failed: $($deviceEvidenceStep.error.message)"
    }
    $deviceEvidenceStep.data | ConvertTo-Json -Depth 8 | Set-Content -Path (Join-Path $outputDir "physical-playback-device.json") -Encoding UTF8
    $resolvedPhysicalDeviceId = [string]$deviceEvidenceStep.data.resolvedDeviceId
    Set-DesktopPhysicalPlaybackOverride -DeviceId $resolvedPhysicalDeviceId -WorkspaceRoot $workspaceRoot
    $desktopProcess = Invoke-Step -State $state "start desktop shell" -Phase desktopLaunch {
      Start-WatchModeDesktopShell $runContext $outputDir $runMarker $resolvedPhysicalDeviceId
    } -ContinueOnError
  
    if ($desktopProcess.status -eq 'passed') {
      # The virtual-driver route intentionally renders its source through the
        # installed virtual endpoint. The other routes must inject the source
        # into the same resolved physical endpoint that the recorder/probe uses;
        # letting the injector silently choose the OS default can select a
        # different endpoint (for example, the VM default changed after probe)
        # and make the physical-content evidence record only silence.
        $watchPlaybackEndpointId = if (
          $FeedbackLoopPrevention -eq "virtual-driver" -and
          $driverProbe.status -eq 'passed' -and
          $driverProbe.data.WasapiEndpointId
        ) {
          [string]$driverProbe.data.WasapiEndpointId
        } else {
          [string]$resolvedPhysicalDeviceId
        }
        $runtimePathBeforePlayback = Resolve-Path -LiteralPath $RuntimeRoot -ErrorAction SilentlyContinue
        $appLogBeforePlayback = if ($runtimePathBeforePlayback) { Join-Path $runtimePathBeforePlayback.Path "app.log" } else { Join-Path $RuntimeRoot "app.log" }
        # Count the readiness budget from the desktop launch, not from this wait.
        # Warm-up therefore cannot silently extend a failed single-model run past
        # the configured limit.
        $readinessDeadlineUtc = ([DateTime]$desktopProcess.data.launchedAtUtc).AddSeconds($SessionReadyTimeoutSeconds)
      $readinessStep = Invoke-Step -State $state "wait for same-process provider and frontend IPC readiness" -Phase readiness {
        Wait-WatchModeAppReadiness `
          -ReadinessPath ([string]$desktopProcess.data.watchReadinessPath) `
          -RunMarker $runMarker `
          -ProcessId ([int]$desktopProcess.data.pid) `
          -DeadlineUtc $readinessDeadlineUtc `
          -DesktopStdoutPath ([string]$desktopProcess.data.stdout) `
          -DesktopStderrPath ([string]$desktopProcess.data.stderr)
      } -ContinueOnError
      if ($readinessStep.status -ne 'passed') {
        throw "same-process Watch frontend readiness infrastructure check failed: $($readinessStep.error.message)"
      }
      $physicalOutputContentSkipReason = Get-PhysicalOutputContentSkipReason `
        -FeedbackMode $FeedbackLoopPrevention `
        -SkipContentStt $SkipPhysicalOutputContentStt
      $physicalOutputRecorderStep = if ($physicalOutputContentSkipReason) {
        Invoke-OmniRunPhase -State $state -Id 'start-physical-output-content-recording' -Phase recording `
          -PolicySkipReason $physicalOutputContentSkipReason
      } else {
        Invoke-Step -State $state "start physical output content recording" -Phase recording {
          Start-PhysicalOutputContentRecorder $outputDir $resolvedPhysicalDeviceId $workspaceRoot $PlaybackSeconds $PostPlaybackWaitSeconds
        } -ContinueOnError
      }
      if ($physicalOutputRecorderStep.status -eq 'passed' -and -not $physicalOutputContentSkipReason) {
        $physicalOutputRecorder = $physicalOutputRecorderStep.data
      }
  
      if ($physicalOutputRecorderStep.status -eq 'failed') {
        throw "start physical output content recording failed: $($physicalOutputRecorderStep.error.message)"
      }
  
      if ($UseDefaultEndpointPlayback) {
            $playbackStep = Invoke-Step -State $state "play watch-mode media via default endpoint" -Phase playback {
                Start-TestMediaPlaybackViaDefaultEndpoint $MediaPath $watchPlaybackEndpointId $outputDir $workspaceRoot $PlaybackSeconds
            } -ContinueOnError
          } else {
              $playbackStep = Invoke-Step -State $state "play watch-mode media" -Phase playback { Start-TestMediaPlayback $MediaPath $watchPlaybackEndpointId $outputDir $workspaceRoot $PlaybackSeconds } -ContinueOnError
          }
          $requiredWatchReportPath = Join-Path $outputDir "watch-session-report.json"
          $reportDeadlineUtc = Get-WatchSessionReportDeadlineUtc `
            -LaunchedAtUtc ([DateTime]$desktopProcess.data.launchedAtUtc) `
            -ReadyTimeoutSeconds $SessionReadyTimeoutSeconds `
            -AutoStopAfterSeconds $WatchAutoStopAfterSeconds
          $reportWaitStep = Invoke-Step -State $state "wait for same-process Watch report and desktop exit" -Phase reportWait {
            Wait-WatchSessionReportAndDesktopExit `
              -Path $requiredWatchReportPath `
              -ProcessId ([int]$desktopProcess.data.pid) `
              -DeadlineUtc $reportDeadlineUtc
          } -ContinueOnError
          if ($reportWaitStep.status -ne 'passed') {
            throw "same-process Watch report capture failed: $($reportWaitStep.error.message)"
          }
          if ($StopDesktopAfterPlayback) {
            Invoke-Step -State $state "stop watch-mode desktop shell after playback" -Phase cleanup {
              Stop-WatchModeDesktopShell $runContext $desktopProcess
            } -ContinueOnError | Out-Null
          }
          $sourceMediaTranscriptStep = if ($physicalOutputContentSkipReason) {
            Invoke-OmniRunPhase -State $state -Id 'transcribe-source-media-reference' -Phase contentCapture `
              -PolicySkipReason $physicalOutputContentSkipReason
          } else {
            Invoke-Step -State $state "transcribe source media reference" -Phase contentCapture {
              Get-SourceMediaReferenceTranscript $outputDir $MediaPath $runContext
            } -ContinueOnError
          }
          $physicalOutputRecordingStep = if ($physicalOutputContentSkipReason) {
            Invoke-OmniRunPhase -State $state -Id 'complete-physical-output-content-recording' -Phase recording `
              -PolicySkipReason $physicalOutputContentSkipReason
          } else {
            Invoke-Step -State $state "complete physical output content recording" -Phase recording {
              Complete-PhysicalOutputContentRecorder $physicalOutputRecorder $workspaceRoot
            } -ContinueOnError
          }
          $physicalOutputContentStep = if ($physicalOutputContentSkipReason) {
            Invoke-OmniRunPhase -State $state -Id 'transcribe-and-compare-physical-output-content' -Phase contentCapture `
              -PolicySkipReason $physicalOutputContentSkipReason
          } else {
            Invoke-Step -State $state "transcribe and compare physical output content" -Phase contentCapture {
              Invoke-PhysicalOutputContentStt $outputDir $physicalOutputRecordingStep.data $appLogBeforePlayback $runMarker $sourceMediaTranscriptStep.data $runContext
            } -ContinueOnError
          }
    } else {
      throw "desktop shell did not start: $($desktopProcess.error.message)"
    }
  
    $requiredWatchReportPath = Join-Path $outputDir "watch-session-report.json"
    Invoke-Step -State $state "stop bridge service after live run" -Phase cleanup {
      if ($AllowElevatedDesktopLaunch) {
        [pscustomobject]@{
          desktopStop = Stop-WatchModeDesktopShell $runContext $desktopProcess
          bridgeStop = Stop-StaleBridgeService $workspaceRoot $RuntimeRoot
        }
      } else {
        [pscustomobject]@{
          reportSavedByDesktopProcess = Test-Path -LiteralPath $requiredWatchReportPath -PathType Leaf
          bridgeStop = Stop-StaleBridgeService $workspaceRoot $RuntimeRoot
        }
      }
    } -ContinueOnError | Out-Null
  
    $systemMetricsStep = if ($desktopProcess -and $desktopProcess.status -eq 'passed' -and $desktopProcess.data -and $desktopProcess.data.systemMetricsSampler) {
      Invoke-Step -State $state "complete desktop process-tree system metrics sampling" -Phase artifactSave {
        Complete-WatchModeSystemMetricsSampler $desktopProcess.data.systemMetricsSampler
      } -ContinueOnError
    } else {
      Invoke-OmniRunPhase -State $state -Id 'complete-desktop-process-tree-system-metrics-sampling' `
        -Phase artifactSave -PolicySkipReason 'desktop shell did not start'
    }
    if ($systemMetricsStep.status -eq 'failed') {
      throw "desktop system metrics evidence failed: $($systemMetricsStep.error.message)"
    }
    Assert-WatchSessionReportFile $requiredWatchReportPath | Out-Null
    if ($reportWaitStep -and $reportWaitStep.status -ne 'passed') {
      throw "same-process Watch report did not complete within the desktop launch deadline: $($reportWaitStep.error.message)"
    }
  
    if ($LocalCanonicalContentAuthority) {
      $localSessionAuthorityStep = Invoke-Step -State $state "validate local smoke Provider session authority" -Phase artifactSave {
        Write-LocalSmokeProviderSessionAuthority $outputDir $runMarker $runContext
      } -ContinueOnError
      if ($localSessionAuthorityStep.status -ne 'passed') {
        throw $localSessionAuthorityStep.error.message
      }
    }
  
    if ($paidAuthorityEnabled) {
      $strictBudgetStep = Invoke-Step -State $state "validate strict paid external provider budget" -Phase artifactSave {
        Write-StrictPaidCellBudget $outputDir $appLogBeforePlayback $runMarker $runContext
      } -ContinueOnError
      if ($strictBudgetStep.status -ne 'passed') {
        throw $strictBudgetStep.error.message
      }
    }
  
  } catch {
    $message = $_.Exception.Message
    $runException = $_
    if (-not $state.stepById.ContainsKey('run-failed')) {
      $failureError = New-OmniStepError -Kind execution -Code 'watch-mode.run.failed' -Message $message
      $failureStep = New-OmniStepResult -Id 'run-failed' -Phase artifactSave -Status failed `
        -StartedAtUtc ([DateTime]::UtcNow) -ErrorRecord $failureError
      Add-OmniRunStep -State $state -Step $failureStep | Out-Null
    }
    Complete-OmniBlockedPhases -State $state -Phases @(
      'initialize', 'preflight', 'driverProbe', 'bridgeProbe', 'desktopLaunch', 'readiness',
      'recording', 'playback', 'reportWait', 'contentCapture', 'artifactSave'
    )
  } finally {
    try {
      Stop-WatchModeDesktopShell $runContext $desktopProcess | Out-Null
    } catch {
      Add-OmniCleanupError -State $state -Code 'watch-mode.cleanup.desktop-failed' `
        -Message $_.Exception.Message | Out-Null
    }
    $samplerToStop = if ($desktopProcess -and $desktopProcess.status -eq 'passed' -and $desktopProcess.data) {
      $desktopProcess.data.systemMetricsSampler
    } else { $null }
    try {
      Stop-WatchModeSystemMetricsSampler $samplerToStop
    } catch {
      Add-OmniCleanupError -State $state -Code 'watch-mode.cleanup.metrics-failed' `
        -Message $_.Exception.Message | Out-Null
    }
    try {
      Stop-StaleBridgeService $workspaceRoot $RuntimeRoot | Out-Null
    } catch {
      Add-OmniCleanupError -State $state -Code 'watch-mode.cleanup.bridge-failed' `
        -Message $_.Exception.Message | Out-Null
    }
    try {
      Restore-DesktopAutostartEnvFile $desktopEnvState
    } catch {
      Add-OmniCleanupError -State $state -Code 'watch-mode.cleanup.environment-failed' `
        -Message $_.Exception.Message | Out-Null
    }
  }
  Save-WatchModeRunArtifacts -OutputDirectory $outputDir -PlaybackStep $playbackStep `
    -RunMarker $runMarker -StartedAtLocal $startedAtLocal -Context $runContext -Request $request -State $state
  Write-Output $outputDir
  if ($runException) { throw $runException }
}

Export-ModuleMember -Function 'Invoke-WatchModeRun'
