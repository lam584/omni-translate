#requires -Version 5.1
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.IO.psm1') -Force -DisableNameChecking; Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.Process.psm1') -Force -DisableNameChecking
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
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.Stt.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.Step.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.StateMachine.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.Preflight.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.FixtureRunner.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.PlatformOperations.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.EvidenceCollection.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.ExecutionContext.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.RunLifecycle.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.PreDesktopPhase.psm1') -Force -DisableNameChecking
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
function Get-WatchModeRestartQuietWindow {
  param(
    [Parameter(Mandatory = $true)][ValidateSet('virtual-driver', 'process-exclusion', 'echo-cancel')][string]$FeedbackMode,
    [Parameter(Mandatory = $true)] [ValidateRange(30, 7200)] [int]$ProviderInputSeconds,
    [bool]$StrictPaidAuthority,
    [ValidateRange(0, 7200)] [int]$RestartAfterSeconds = 90,
    [ValidateRange(0, 7200)] [int]$RestartQuietSeconds = 45
  )
  $enabled = $StrictPaidAuthority -and $FeedbackMode -eq 'process-exclusion'
  return [pscustomobject]@{
    afterSeconds = if ($enabled) { $RestartAfterSeconds } else { 0 }
    durationSeconds = if ($enabled) { $RestartQuietSeconds } else { 0 }
  }
}
function Write-WatchModeInputCompleteMarker {
  param(
    [Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$RunMarker,
    [Parameter(Mandatory = $true)][string]$CellId, [Parameter(Mandatory = $true)][string]$LeaseId,
    [Parameter(Mandatory = $true)]$Playback
  )
  $referencePath = [string]$Playback.referencePcmPath
  if (-not (Test-Path -LiteralPath $referencePath -PathType Leaf)) { throw "input-complete requires the authoritative transformed reference PCM: $referencePath" }
  $referenceBytes = (Get-Item -LiteralPath $referencePath).Length
  if ($referenceBytes -le 0 -or ($referenceBytes % 2) -ne 0) { throw "input-complete reference PCM is not whole non-empty 16-bit mono frames: $referencePath" }
  $referenceFrames = [int64]($referenceBytes / 2)
  $maxSamples = [int64]$env:OMNI_WATCH_MODE_PROVIDER_INPUT_MAX_SAMPLES
  $captureGraceFrames = $maxSamples - $referenceFrames
  if ($captureGraceFrames -lt 0) { throw "input-complete reference frames exceed the signed Provider sample lease" }
  $completedAtUnixMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  Write-OmniImmutableJson -LiteralPath $Path -Value ([pscustomobject]@{
    schemaVersion = 1
    artifactKind = 'watch-mode-input-complete'
    runMarker = $RunMarker
    cellId = $CellId
    leaseId = $LeaseId
    mediaPlaybackCompletedAtUnixMs = [int64]$Playback.finishedAtMs
    signaledAtUnixMs = $completedAtUnixMs
    completedAtUnixMs = $completedAtUnixMs
    authoritativeTransformedReferenceFrames = $referenceFrames
    boundedCaptureGraceFrames = $captureGraceFrames
    maxExternalAudioSamples = $maxSamples
  })
  return $completedAtUnixMs
}
function Invoke-WatchModeRun {
  param(
    [Parameter(Mandatory = $true)]$Context,
    [Parameter(Mandatory = $true)]$Request,
    [string]$DevconPath
  )
  $execution = New-WatchModeExecutionContext -Context $Context -Request $Request
  foreach ($property in $execution.PSObject.Properties) {
    Set-Variable -Name $property.Name -Value $property.Value -Scope Local
  }
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
    $preDesktop = Invoke-WatchModePreDesktopPhase -Execution $execution -State $state -DevconPath $DevconPath
    $desktopProcess = $preDesktop.desktopProcess
    $desktopEnvState = $preDesktop.desktopEnvState
    $driverProbe = $preDesktop.driverProbe
    $virtualDriverMediaPreflight = $preDesktop.virtualDriverMediaPreflight
    $deviceEvidenceStep = $preDesktop.deviceEvidenceStep
    $resolvedPhysicalDeviceId = [string]$preDesktop.resolvedPhysicalDeviceId
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
        $appLogBeforePlayback = [string]$desktopProcess.data.appLogPath
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
          Start-PhysicalOutputContentRecorder $outputDir $resolvedPhysicalDeviceId $workspaceRoot `
            $CellHardWatchdogSeconds $PhysicalRecorderTailSeconds $TerminalAuthorityPath `
            $runMarker $MatrixCellId ([string]$env:OMNI_WATCH_MODE_PROVIDER_INPUT_LEASE_ID)
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
              $restartQuietWindow = Get-WatchModeRestartQuietWindow `
                -FeedbackMode $FeedbackLoopPrevention `
                -ProviderInputSeconds $WatchAutoStopAfterSeconds `
                -StrictPaidAuthority $StrictPaidAuthority `
                -RestartAfterSeconds ([int]$runContext.lifecycle.processExclusionRestartAfterSeconds) `
                -RestartQuietSeconds ([int]$runContext.lifecycle.processExclusionRestartQuietSeconds)
              $playbackStep = Invoke-Step -State $state "play watch-mode media" -Phase playback {
                Start-TestMediaPlayback $MediaPath $watchPlaybackEndpointId $outputDir $workspaceRoot $PlaybackSeconds `
                  -RestartQuietWindowAfterSeconds ([int]$restartQuietWindow.afterSeconds) `
                  -RestartQuietWindowSeconds ([int]$restartQuietWindow.durationSeconds)
              } -ContinueOnError
          }
          if ($StrictPaidAuthority) {
            if ($playbackStep.status -ne 'passed') {
              throw "input-complete cannot be signaled because media playback failed"
            }
            Invoke-Step -State $state "signal identity-bound input completion" -Phase playback {
              Write-WatchModeInputCompleteMarker -Path $InputCompletePath -RunMarker $runMarker `
                -CellId $MatrixCellId -LeaseId ([string]$env:OMNI_WATCH_MODE_PROVIDER_INPUT_LEASE_ID) `
                -Playback $playbackStep.data
            } | Out-Null
          }
          $requiredWatchReportPath = Join-Path $outputDir "watch-session-report.json"
          $reportDeadlineUtc = Get-WatchSessionReportDeadlineUtc `
            -LaunchedAtUtc ([DateTime]$desktopProcess.data.launchedAtUtc) `
            -ReadyTimeoutSeconds $SessionReadyTimeoutSeconds `
            -AutoStopAfterSeconds $CellHardWatchdogSeconds `
            -CompletionGraceSeconds 30
          $reportWaitArguments = @{
            Path = $requiredWatchReportPath
            ProcessLease = $desktopProcess.data.processLease
            DeadlineUtc = $reportDeadlineUtc
          }
          if ($StrictPaidAuthority) {
            $reportWaitArguments.TerminalAuthorityPath = $TerminalAuthorityPath
            $reportWaitArguments.RunMarker = $runMarker
            $reportWaitArguments.CellId = $MatrixCellId
            $reportWaitArguments.LeaseId = [string]$env:OMNI_WATCH_MODE_PROVIDER_INPUT_LEASE_ID
            $reportWaitArguments.SourceHeadCommit = [string]$env:OMNI_WATCH_MODE_SOURCE_HEAD_COMMIT
            $reportWaitArguments.RuntimeBundleDigest = [string]$env:OMNI_WATCH_MODE_RUNTIME_BUNDLE_DIGEST
          }
          $reportWaitStep = Invoke-Step -State $state "wait for same-process Watch report and desktop exit" -Phase reportWait {
            Wait-WatchSessionReportAndDesktopExit @reportWaitArguments
          } -ContinueOnError
          if ($reportWaitStep.status -ne 'passed') {
            throw "same-process Watch report capture failed: $($reportWaitStep.error.message)"
          }
          $scopedAppLogPath = Join-Path $outputDir 'app.log'
          $savedAppLogPath = Copy-WatchModeAppLog -SourcePath ([string]$runContext.paths.appLogPath) `
            -DestinationPath $scopedAppLogPath -RunMarker $runMarker
          if (-not $savedAppLogPath) {
            throw 'same-process Watch app log could not be scoped across log rotation'
          }
          $appLogBeforePlayback = $scopedAppLogPath
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
              Complete-PhysicalOutputContentRecorder $physicalOutputRecorder $workspaceRoot -TerminalSucceeded
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
    if ($physicalOutputRecorder -and -not $physicalOutputRecordingStep) {
      $recorderCleanupStep = Invoke-Step -State $state "stop physical output recorder after failed run" -Phase cleanup {
        Complete-WatchModePhysicalRecorderAfterRun $physicalOutputRecorder $workspaceRoot $TerminalAuthorityPath
      } -ContinueOnError
      if ($recorderCleanupStep.status -ne 'passed' -and -not $runException) {
        $runException = [System.Management.Automation.RuntimeException]::new(
          "physical output recorder failure cleanup failed: $($recorderCleanupStep.error.message)"
        )
      }
    }
    Stop-WatchModeRunResources -State $state -Context $runContext -DesktopProcess $desktopProcess `
      -WorkspaceRoot $workspaceRoot -RuntimeRoot $RuntimeRoot -DesktopEnvironmentState $desktopEnvState

    # The paid-cell ledger is terminal evidence, not a success-only artifact.
    # Generate it even when an earlier phase failed so the coordinator can
    # prove the consumed Provider budget and finish collect-all aggregation.
    $strictBudgetPath = Join-Path $outputDir 'external-provider-budget.json'
    if ($paidAuthorityEnabled -and -not (Test-Path -LiteralPath $strictBudgetPath -PathType Leaf)) {
      $terminalBudgetStep = Invoke-Step -State $state "finalize strict paid external provider budget" -Phase artifactSave {
        Write-StrictPaidCellBudget $outputDir $appLogBeforePlayback $runMarker $runContext
      } -ContinueOnError
      if ($terminalBudgetStep.status -ne 'passed' -and -not $runException) {
        $runException = [System.Management.Automation.RuntimeException]::new(
          "strict paid-cell provider budget finalization failed: $($terminalBudgetStep.error.message)"
        )
      }
    }
  }
  Save-WatchModeRunArtifacts -OutputDirectory $outputDir -PlaybackStep $playbackStep `
    -RunMarker $runMarker -StartedAtLocal $startedAtLocal -Context $runContext -Request $request -State $state
  Write-Output $outputDir
  if ($runException) { throw $runException }
}
Export-ModuleMember -Function @('Invoke-WatchModeRun', 'Get-WatchModeRestartQuietWindow', 'Write-WatchModeInputCompleteMarker')
