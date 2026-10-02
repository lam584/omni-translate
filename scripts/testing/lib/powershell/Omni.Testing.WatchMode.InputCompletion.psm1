#requires -Version 5.1

Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.IO.psm1') -Force -DisableNameChecking

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
  if ($captureGraceFrames -lt 0) { throw 'input-complete reference frames exceed the signed Provider sample lease' }
  $completedAtUnixMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  Write-OmniImmutableJson -LiteralPath $Path -Value ([pscustomobject]@{
    schemaVersion = 1; artifactKind = 'watch-mode-input-complete'; runMarker = $RunMarker
    cellId = $CellId; leaseId = $LeaseId; mediaPlaybackCompletedAtUnixMs = [int64]$Playback.finishedAtMs
    signaledAtUnixMs = $completedAtUnixMs; completedAtUnixMs = $completedAtUnixMs; disposition = 'completed'
    authoritativeTransformedReferenceFrames = $referenceFrames; boundedCaptureGraceFrames = $captureGraceFrames
    maxExternalAudioSamples = $maxSamples
  })
  return $completedAtUnixMs
}

function Write-WatchModeMediaCompleteMarker {
  param(
    [Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$RunMarker,
    [Parameter(Mandatory = $true)][string]$CellId, [Parameter(Mandatory = $true)][string]$LeaseId,
    [Parameter(Mandatory = $true)][string]$WorkspaceRoot, [Parameter(Mandatory = $true)]$Playback,
    [Parameter(Mandatory = $true)][string]$CompletionPolicy
  )
  if ($CompletionPolicy -cne 'aec-output-quiescent-v2') {
    throw 'media-complete is only valid for the versioned AEC open-input policy'
  }
  $canonicalMediaSha256 = 'cf4990ecdc23622d12de3e62adad442755c9e84c4612787798655ee00c85fb2f'
  if ($Playback.passed -ne $true -or [string]$Playback.mediaSha256 -cne $canonicalMediaSha256 -or
      [int64]$Playback.injectorProcessId -le 0 -or [string]::IsNullOrWhiteSpace([string]$Playback.endpointId) -or
      [int64]$Playback.startedAtMs -le 0 -or [int64]$Playback.finishedAtMs -lt [int64]$Playback.startedAtMs) {
    throw 'media-complete requires successful canonical, identity-bound physical media playback'
  }
  $referencePath = [string]$Playback.referencePcmPath
  if (-not (Test-Path -LiteralPath $referencePath -PathType Leaf)) { throw 'media-complete requires retained transformed source PCM' }
  $referenceBytes = (Get-Item -LiteralPath $referencePath).Length
  if ($referenceBytes -ne (2013045 * 2)) { throw 'media-complete source reference frames differ from the canonical signed AEC cell' }
  $maxSamples = [int64]$env:OMNI_WATCH_MODE_PROVIDER_INPUT_MAX_SAMPLES
  if ($maxSamples -ne 2880000) { throw 'AEC open-input observation must use its exact 180-second signed sample ceiling' }
  $sourceText = Get-Content -LiteralPath (Join-Path $WorkspaceRoot 'scripts/testing/fixtures/watch-mode-en-original.txt') -Raw -Encoding UTF8
  $segments = @($sourceText.Trim() -split '\r?\n\s*\r?\n' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  if ($segments.Count -ne 6) { throw 'media-complete requires all six canonical English source segments' }
  # This event never closes capture, fences Provider input or creates input-complete.
  # The production typed lifecycle owns output drain and the two-second confirmation.
  Write-OmniImmutableJson -LiteralPath $Path -Value ([pscustomobject]@{
    schemaVersion = 2; artifactKind = 'watch-mode-media-complete'; runMarker = $RunMarker
    cellId = $CellId; leaseId = $LeaseId; mediaSha256 = $canonicalMediaSha256
    playbackProcessId = [int64]$Playback.injectorProcessId; playbackEndpointId = [string]$Playback.endpointId
    mediaPlaybackStartedAtUnixMs = [int64]$Playback.startedAtMs
    mediaPlaybackCompletedAtUnixMs = [int64]$Playback.finishedAtMs
    authoritativeTransformedReferenceFrames = [int64]($referenceBytes / 2)
    boundedCaptureGraceFrames = [int64]($maxSamples - ($referenceBytes / 2))
    maxExternalAudioSamples = $maxSamples; expectedSourceSegments = $segments
  })
  return [int64]$Playback.finishedAtMs
}

function Write-WatchModeFailedInputCompleteMarker {
  param(
    [Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$RunMarker,
    [Parameter(Mandatory = $true)][string]$CellId, [Parameter(Mandatory = $true)][string]$LeaseId,
    [Parameter(Mandatory = $true)][string]$OutputDirectory, [Parameter(Mandatory = $true)][string]$FailureReason
  )
  $playbackPath = Join-Path $OutputDirectory 'playback.json'
  if (-not (Test-Path -LiteralPath $playbackPath -PathType Leaf)) { throw "failed input-complete requires playback failure evidence: $playbackPath" }
  $playback = Get-Content -LiteralPath $playbackPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($playback.passed -ne $false -or [int64]$playback.finishedAtMs -le 0) { throw 'failed input-complete accepts only terminal failed playback evidence' }
  $referencePath = [string]$playback.referencePcmPath
  if (-not (Test-Path -LiteralPath $referencePath -PathType Leaf)) { throw "failed input-complete requires retained transformed reference PCM: $referencePath" }
  $referenceBytes = (Get-Item -LiteralPath $referencePath).Length
  if ($referenceBytes -le 0 -or ($referenceBytes % 2) -ne 0) { throw "failed input-complete reference PCM is not whole non-empty 16-bit mono frames: $referencePath" }
  $maxSamples = [int64]$env:OMNI_WATCH_MODE_PROVIDER_INPUT_MAX_SAMPLES
  $completedAtUnixMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  Write-OmniImmutableJson -LiteralPath $Path -Value ([pscustomobject]@{
    schemaVersion = 2; artifactKind = 'watch-mode-input-complete'; runMarker = $RunMarker
    cellId = $CellId; leaseId = $LeaseId; mediaPlaybackCompletedAtUnixMs = [int64]$playback.finishedAtMs
    signaledAtUnixMs = $completedAtUnixMs; completedAtUnixMs = $completedAtUnixMs
    disposition = 'failed-incomplete'; failureReason = $FailureReason
    maxExternalAudioSamples = $maxSamples
  })
  return $completedAtUnixMs
}

function Test-WatchModeExpectedFailedInputTerminalError {
  param([Parameter(Mandatory = $true)][string]$Message)
  $pattern = '^custodied Watch desktop terminal failed: exitCode=1 terminalErrorCode=runner-input-failed terminalError=.+ pid=[0-9]+ launchId=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  return $Message -cmatch $pattern
}

Export-ModuleMember -Function @('Write-WatchModeMediaCompleteMarker', 'Write-WatchModeInputCompleteMarker', 'Write-WatchModeFailedInputCompleteMarker', 'Test-WatchModeExpectedFailedInputTerminalError')
