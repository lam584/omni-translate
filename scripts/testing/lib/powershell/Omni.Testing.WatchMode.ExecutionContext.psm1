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
  $outputDir = New-OmniTestingOutputDirectory -Root ([string]$Request.paths.outputRoot) `
    -ModelId ([string]$Request.model.id) -FeedbackMode ([string]$Request.feedbackMode) `
    -DeviceProfileId ([string]$Request.physicalDevice.profileId)
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
    SkipDriverRepair = $Request.driverPolicy -ne 'repair-if-needed'
    AllowDriverRepair = $Request.driverPolicy -eq 'repair-if-needed'
    UseDefaultEndpointPlayback = $false; StopDesktopAfterPlayback = $false
    AllowElevatedDesktopLaunch = $Request.desktop.elevation -eq 'allow'
    SkipPhysicalOutputContentStt = $Request.physicalContentMode -eq 'disabled'
    StrictPaidAuthority = $Request.authorityMode -eq 'strict-paid'
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
    desktopAutoStopAfterSeconds = [int]$Context.lifecycle.desktopAutoStopSeconds
    providerAuthorityMode = [string]$Request.authorityMode
    outputDir = $outputDir
    runMarker = "watch_mode_diagnostic.run_id=$([System.Guid]::NewGuid().ToString('N'))"
    startedAtLocal = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  }
}

Export-ModuleMember -Function 'New-WatchModeExecutionContext'
