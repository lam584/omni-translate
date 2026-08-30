#requires -Version 5.1

Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.RawContent.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.EvidenceCollection.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.Report.psm1') -Force -DisableNameChecking

function Assert-WatchModeAuthorityRequest {
  param([Parameter(Mandatory = $true)]$Context)
  $request = $Context.request
  $workspaceRoot = [string]$Context.paths.workspaceRoot
  $DryRun = $request.runMode -eq 'fixture'
  $StrictPaidAuthority = [string]$request.authorityMode -eq 'strict-paid'
  $IncidentReplayAuthority = [string]$request.authorityMode -eq 'incident-replay-plus'
  $LocalCanonicalContentAuthority = [string]$request.authorityMode -eq 'local-canonical-smoke'
  $paidAuthorityEnabled = $StrictPaidAuthority -or $IncidentReplayAuthority
  $localContentAuthorityEnabled = $paidAuthorityEnabled -or $LocalCanonicalContentAuthority
  $providerAuthorityMode = [string]$request.authorityMode
  $WatchModelId = [string]$request.model.id
  $WatchRealtimeProtocol = [string]$request.model.protocol
  $SubtitleTranslationMode = [string]$request.model.subtitleTranslationMode
  $WatchAutoStopAfterSeconds = [int]$request.timeouts.sessionSeconds
  $PlaybackSeconds = [int]$request.media.playbackSeconds
  $SkipPhysicalOutputContentStt = [string]$request.physicalContentMode -eq 'disabled'
  $MediaPath = [string]$request.media.path
  $MatrixCellId = [string]$request.matrix.cellId
  if ($localContentAuthorityEnabled) {
      if ($DryRun) { throw "$providerAuthorityMode authority is only valid for a live cell" }
      $approvedAuthorityModels = if ($StrictPaidAuthority) {
        @("qwen3.5-livetranslate-flash-realtime")
      } elseif ($IncidentReplayAuthority) {
        @("qwen3.5-omni-plus-realtime")
      } else {
        @("qwen3.5-omni-flash-realtime", "qwen3.5-livetranslate-flash-realtime", "qwen3.5-omni-plus-realtime")
      }
      if ($WatchModelId -notin $approvedAuthorityModels) {
        throw "$providerAuthorityMode allows only its signed Watch models; got '$WatchModelId'"
      }
      if ([string]::IsNullOrWhiteSpace($MatrixCellId)) {
        throw "$providerAuthorityMode requires MatrixCellId before provider launch"
      }
      if ($paidAuthorityEnabled -and [string]::IsNullOrWhiteSpace($env:OMNI_WATCH_MODE_PROVIDER_INPUT_LEASE_ID)) {
        throw "$providerAuthorityMode requires a coordinator-issued OMNI_WATCH_MODE_PROVIDER_INPUT_LEASE_ID before provider launch"
      }
      if ($LocalCanonicalContentAuthority -and (
        -not [string]::IsNullOrWhiteSpace($env:OMNI_WATCH_MODE_STRICT_PAID_AUTHORITY) -or
        -not [string]::IsNullOrWhiteSpace($env:OMNI_WATCH_MODE_INCIDENT_REPLAY_AUTHORITY)
      )) {
        throw "$providerAuthorityMode refuses ambient production authority sentinels"
      }
      $approvedAuthorityProtocol = if ($WatchModelId -eq "qwen3.5-livetranslate-flash-realtime") {
        "dashscope-livetranslate"
      } else {
        "dashscope-omni"
      }
      if ($WatchRealtimeProtocol -cne $approvedAuthorityProtocol) {
        throw "$providerAuthorityMode model/protocol mismatch: expected $approvedAuthorityProtocol for $WatchModelId"
      }
      if ($SubtitleTranslationMode -ne "native") {
        throw "$providerAuthorityMode forbids secondary translation/TTS; SubtitleTranslationMode must be native"
      }
      $expectedInputCompletionWatchdogSeconds = if ($StrictPaidAuthority -and [string]$request.feedbackMode -eq 'process-exclusion') { 225 } elseif ($StrictPaidAuthority) { 180 } else { $WatchAutoStopAfterSeconds }
      if ($StrictPaidAuthority -and $WatchAutoStopAfterSeconds -ne $expectedInputCompletionWatchdogSeconds) {
        throw "$providerAuthorityMode input-completion watchdog mismatch for $($request.feedbackMode): expected $expectedInputCompletionWatchdogSeconds got $WatchAutoStopAfterSeconds"
      }
      if ($PlaybackSeconds -ne 0) {
        throw "$providerAuthorityMode requires complete canonical media playback; PlaybackSeconds must be 0"
      }
      if ($SkipPhysicalOutputContentStt) {
        throw "$providerAuthorityMode does not permit skipping local physical-output authority"
      }
      $strictCanonicalMedia = (Resolve-Path -LiteralPath (Join-Path $workspaceRoot "scripts/testing/fixtures/watch-mode-en-original.wav") -ErrorAction Stop).Path
      $strictRequestedMedia = (Resolve-Path -LiteralPath $MediaPath -ErrorAction Stop).Path
      if (-not $strictRequestedMedia.Equals($strictCanonicalMedia, [StringComparison]::OrdinalIgnoreCase)) {
        throw "$providerAuthorityMode requires canonical media: $strictCanonicalMedia"
      }
      $strictDeclaredHash = ((Get-Content -LiteralPath (Join-Path $workspaceRoot "scripts/testing/fixtures/watch-mode-en-original.sha256") -Raw -Encoding UTF8).Trim() -split '\s+')[0].ToLowerInvariant()
      $strictActualHash = (Get-FileHash -LiteralPath $strictRequestedMedia -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($strictActualHash -ne $strictDeclaredHash) {
        throw "$providerAuthorityMode canonical media checksum mismatch before provider launch"
      }
    }
}
Export-ModuleMember -Function 'Assert-WatchModeAuthorityRequest'
