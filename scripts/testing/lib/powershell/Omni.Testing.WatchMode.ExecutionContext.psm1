#requires -Version 5.1

Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.IO.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.Configuration.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.Preflight.psm1') -Force

function New-WatchModeExecutionContext {
  param(
    [Parameter(Mandatory = $true)]$Context,
    [Parameter(Mandatory = $true)]$Request
  )
  $workspaceRoot = [string]$Context.paths.workspaceRoot
  Set-Location $workspaceRoot
  Assert-WatchModeAuthorityRequest -Context $Context
  $strictPaidAuthority = $Request.authorityMode -eq 'strict-paid'
  $requestedOutputRoot = [System.IO.Path]::GetFullPath([string]$Request.paths.outputRoot)
  if ($strictPaidAuthority) {
    $inputCompletePath = [string]$Request.paths.inputComplete
    $terminalAuthorityPath = [string]$Request.paths.terminalAuthority
    if ([string]::IsNullOrWhiteSpace($inputCompletePath) -or
        [string]::IsNullOrWhiteSpace($terminalAuthorityPath)) {
      throw 'strict paid Watch request requires identity-bound inputComplete and terminalAuthority paths'
    }
    $inputCompletePath = [System.IO.Path]::GetFullPath($inputCompletePath)
    $terminalAuthorityPath = [System.IO.Path]::GetFullPath($terminalAuthorityPath)
    if ([System.IO.Path]::GetDirectoryName($inputCompletePath) -cne $requestedOutputRoot -or
        [System.IO.Path]::GetDirectoryName($terminalAuthorityPath) -cne $requestedOutputRoot -or
        [System.IO.Path]::GetFileName($inputCompletePath) -cne 'input-complete.json' -or
        [System.IO.Path]::GetFileName($terminalAuthorityPath) -cne 'evidence-driven-terminal.json') {
      throw 'strict paid Watch authority paths must be canonical files directly under paths.outputRoot'
    }
    [System.IO.Directory]::CreateDirectory($requestedOutputRoot) | Out-Null
    $outputDir = $requestedOutputRoot
  } else {
    $outputDir = New-OmniTestingOutputDirectory -Root $requestedOutputRoot `
      -ModelId ([string]$Request.model.id) -FeedbackMode ([string]$Request.feedbackMode) `
      -DeviceProfileId ([string]$Request.physicalDevice.profileId)
    $inputCompletePath = Join-Path $outputDir 'input-complete.json'
    $terminalAuthorityPath = Join-Path $outputDir 'evidence-driven-terminal.json'
  }
  return [pscustomobject]@{
    runContext = $Context; request = $Request; workspaceRoot = $workspaceRoot
    DryRun = $Request.runMode -eq 'fixture'; Fixture = 'pass'
    FixtureRoot = 'scripts/testing/fixtures/watch-mode-live'
    OutputRoot = [string]$Request.paths.outputRoot; RuntimeRoot = [string]$Request.paths.runtimeRoot
    WarmupSeconds = [int]$Request.timeouts.warmupSeconds
    PlaybackSeconds = [int]$Request.media.playbackSeconds
    PostPlaybackWaitSeconds = [int]$Request.timeouts.postPlaybackSeconds
    SessionReadyTimeoutSeconds = [int]$Request.timeouts.readinessSeconds
    WatchAutoStopAfterSeconds = [int]$Request.timeouts.sessionSeconds
    InputCompletionWatchdogSeconds = [int]$Request.timeouts.inputCompletionWatchdogSeconds
    ProviderFinishTimeoutSeconds = [int]$Request.timeouts.providerFinishTimeoutSeconds
    LocalPlaybackDrainTimeoutSeconds = [int]$Request.timeouts.localPlaybackDrainTimeoutSeconds
    ReportWriteTimeoutSeconds = [int]$Request.timeouts.reportWriteTimeoutSeconds
    CellHardWatchdogSeconds = [int]$Request.timeouts.cellHardWatchdogSeconds
    PhysicalRecorderTailSeconds = [int]$Request.timeouts.physicalRecorderTailSeconds
    InputCompletePath = $inputCompletePath
    TerminalAuthorityPath = $terminalAuthorityPath
    SkipDriverRepair = $Request.driverPolicy -ne 'repair-if-needed'
    AllowDriverRepair = $Request.driverPolicy -eq 'repair-if-needed'
    UseDefaultEndpointPlayback = $false; StopDesktopAfterPlayback = $false
    AllowElevatedDesktopLaunch = $Request.desktop.elevation -eq 'allow'
    SkipPhysicalOutputContentStt = $Request.physicalContentMode -eq 'disabled'
    StrictPaidAuthority = $strictPaidAuthority
    IncidentReplayAuthority = $Request.authorityMode -eq 'incident-replay-plus'
    LocalCanonicalContentAuthority = $Request.authorityMode -eq 'local-canonical-smoke'
    MatrixCellId = [string]$Request.matrix.cellId
    WorkerReadinessReceiptPath = [string]$Request.paths.workerReadinessReceipt
    MediaPath = [string]$Request.media.path; WatchModelId = [string]$Request.model.id
    WatchRealtimeProtocol = [string]$Request.model.protocol
    SubtitleTranslationMode = [string]$Request.model.subtitleTranslationMode
    SubtitleTranslationModelId = [string]$Request.model.subtitleModelId
    InboundSecondaryAudioModelId = [string]$Request.model.secondaryAudioModelId
    PhysicalPlaybackDeviceId = [string]$Request.physicalDevice.id
    PhysicalPlaybackDeviceClass = [string]$Request.physicalDevice.class
    PhysicalPlaybackDeviceProfileId = [string]$Request.physicalDevice.profileId
    FeedbackLoopPrevention = [string]$Request.feedbackMode
    ExpectedPhysicalPlaybackDeviceName = [string]$Request.physicalDevice.expectedName
    paidAuthorityEnabled = $Request.authorityMode -in @('strict-paid', 'incident-replay-plus')
    localContentAuthorityEnabled = $Request.authorityMode -in @('strict-paid', 'incident-replay-plus', 'local-canonical-smoke')
    desktopAutoStopAfterSeconds = [int]$Context.lifecycle.cellHardWatchdogSeconds
    providerAuthorityMode = [string]$Request.authorityMode
    outputDir = $outputDir
    runMarker = "watch_mode_diagnostic.run_id=$([System.Guid]::NewGuid().ToString('N'))"
    startedAtLocal = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  }
}

Export-ModuleMember -Function 'New-WatchModeExecutionContext'
