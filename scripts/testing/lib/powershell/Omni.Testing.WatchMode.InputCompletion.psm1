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

Export-ModuleMember -Function @('Write-WatchModeInputCompleteMarker', 'Write-WatchModeFailedInputCompleteMarker', 'Test-WatchModeExpectedFailedInputTerminalError')
