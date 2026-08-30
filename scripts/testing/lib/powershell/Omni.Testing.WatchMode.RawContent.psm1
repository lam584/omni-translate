#requires -Version 5.1

Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.Evidence.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.AudioAnalysis.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.Stt.psm1') -Force -DisableNameChecking

function Read-TranslatedCuePlaybackAuthority {
  param([string]$OutputDirectory, [string]$AppLogPath, [string]$RunMarker)
  $watchReportPath = Join-Path $OutputDirectory "watch-session-report.json"
  if (-not (Test-Path -LiteralPath $watchReportPath -PathType Leaf)) {
    return [pscustomobject]@{ passed = $false; error = "watch-session-report.json is missing" }
  }
  $devicePath = Join-Path $OutputDirectory "physical-playback-device.json"
  $workspaceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../..'))
  $authorityScript = Join-Path $workspaceRoot 'scripts/testing/watch-mode/playback-authority.mjs'
  $arguments = @(
    $authorityScript, '--watch-report', $watchReportPath, '--device', $devicePath,
    '--app-log', $AppLogPath, '--marker', $RunMarker
  )
  $output = @(& node @arguments 2>&1 | ForEach-Object { "$_" })
  if ($LASTEXITCODE -ne 0) {
    throw "translated cue playback authority failed: $($output -join ' ')"
  }
  return (($output -join "`n") | ConvertFrom-Json)
}

function Get-TranslatedPcmLoopbackAuthority {
  param(
    [string]$OutputDirectory,
    $Recording,
    $PlaybackAuthority,
    [string]$AppLogPath,
    [string]$RunMarker,
    [Parameter(Mandatory = $true)]$Context
  )
  $workspaceRoot = [string]$Context.paths.workspaceRoot
  $LocalCanonicalContentAuthority = [string]$Context.request.authorityMode -eq 'local-canonical-smoke'
  $MatrixCellId = [string]$Context.request.matrix.cellId
  $WatchModelId = [string]$Context.request.model.id
  $WatchRealtimeProtocol = [string]$Context.request.model.protocol
  $FeedbackLoopPrevention = [string]$Context.request.feedbackMode
  $matcherPath = Join-Path $workspaceRoot "scripts/testing/watch-mode-translated-pcm-loopback.mjs"
  $leaseFileName = if ($LocalCanonicalContentAuthority) {
    "smoke-provider-session-lease.json"
  } else {
    "provider-input-budget-lease.json"
  }
  $leasePath = Join-Path $OutputDirectory $leaseFileName
  if (-not (Test-Path -LiteralPath $leasePath -PathType Leaf)) {
    return [pscustomobject]@{ passed = $false; authorityMode = "translated-pcm-loopback-correlation-v1"; error = "provider input budget lease is missing" }
  }
  $lease = Get-Content -LiteralPath $leasePath -Raw -Encoding UTF8 | ConvertFrom-Json
  $protocol = if ($WatchRealtimeProtocol) {
    $WatchRealtimeProtocol
  } elseif ($WatchModelId -eq "qwen3.5-livetranslate-flash-realtime") {
    "dashscope-livetranslate"
  } else {
    "dashscope-omni"
  }
  $arguments = @(
    $matcherPath,
    "--run-directory", $OutputDirectory,
    "--app-log", $AppLogPath,
    "--run-marker", $RunMarker,
    "--recording-started-at-ms", ([string]$Recording.recordingStartedAtEpochMs),
    "--cell-id", $MatrixCellId,
    "--lease-id", ([string]$lease.leaseId),
    "--model-id", $WatchModelId,
    "--protocol", $protocol,
    "--feedback-loop-prevention", $FeedbackLoopPrevention
  )
  $stdoutPath = Join-Path $OutputDirectory "translated-pcm-loopback.stdout.json"
  $stderrPath = Join-Path $OutputDirectory "translated-pcm-loopback.stderr.log"
  $process = Start-Process -FilePath "node" -ArgumentList $arguments -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -WindowStyle Hidden -Wait -PassThru
  if (-not (Test-Path -LiteralPath $stdoutPath -PathType Leaf)) {
    return [pscustomobject]@{ passed = $false; authorityMode = "translated-pcm-loopback-correlation-v1"; error = "translated PCM matcher returned no JSON"; exitCode = $process.ExitCode }
  }
  try {
    $authority = Get-Content -LiteralPath $stdoutPath -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    return [pscustomobject]@{ passed = $false; authorityMode = "translated-pcm-loopback-correlation-v1"; error = "translated PCM matcher JSON is invalid: $($_.Exception.Message)"; exitCode = $process.ExitCode }
  }
  if ($process.ExitCode -ne 0 -and $authority.passed) {
    $authority.passed = $false
    $authority | Add-Member -NotePropertyName error -NotePropertyValue "translated PCM matcher exited with $($process.ExitCode)" -Force
  }
  return $authority
}

function Get-LocalPhysicalOutputContentAuthority {
  param([string]$OutputDirectory, $Recording, [string]$AppLogPath, [string]$RunMarker, $SourceReferenceTranscript, [Parameter(Mandatory = $true)]$Context)
  $workspaceRoot = [string]$Context.paths.workspaceRoot
  $PlaybackSeconds = [int]$Context.request.media.playbackSeconds
  $resultPath = Join-Path $OutputDirectory "physical-output-content.raw.json"
  $pcmPath = [string]$Recording.transcriptionPcmPath
  if (-not (Test-Path -LiteralPath $pcmPath -PathType Leaf)) {
    [pscustomobject]@{
      schemaVersion = 1
      authorityMode = "local-pcm-cue-playback-v1"
      passed = $false
      remoteProviderCalls = 0
      error = "physical output PCM file was not created"
      recording = $Recording
    } | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $resultPath -Encoding UTF8
    return Get-Content -LiteralPath $resultPath -Raw -Encoding UTF8 | ConvertFrom-Json
  }
  $sourceWindowSeconds = if ($PlaybackSeconds -gt 0) {
    [Math]::Max(8, $PlaybackSeconds + 8)
  } elseif ($Recording -and $Recording.audioQuality -and $Recording.audioQuality.durationSeconds) {
    [Math]::Max(8, [Math]::Min([double]$Recording.audioQuality.durationSeconds, 90))
  } else {
    90
  }
  $sourceWindow = Copy-PcmWindow $pcmPath `
    (Join-Path $OutputDirectory 'physical-output-recording-source-window-16k-mono.pcm') `
    16000 $sourceWindowSeconds
  $canonicalSourceAndPhysical = if ($sourceWindow) {
    try {
      Invoke-CanonicalSourceAuthorityNode $OutputDirectory "Combined" $workspaceRoot
    } catch {
      [pscustomobject]@{ passed = $false; error = $_.Exception.Message }
    }
  } else {
    [pscustomobject]@{ passed = $false; error = "physical output source window was not created" }
  }
  $originalSimilarity = if ($canonicalSourceAndPhysical.passed -and $canonicalSourceAndPhysical.physicalSourceWaveform) {
    $canonicalSourceAndPhysical.physicalSourceWaveform
  } else {
    [pscustomobject]@{ passed = $false; error = [string]$canonicalSourceAndPhysical.error }
  }
  $segmentation = Read-SpeechSegmentationSummary $AppLogPath $RunMarker
  $subtitleQueue = $null
  $subtitleText = Get-RecentSubtitleText $AppLogPath $RunMarker
  $segmentTranslationText = Get-RecentFinalSegmentTranslationText $AppLogPath $RunMarker
  $playbackAuthority = Read-TranslatedCuePlaybackAuthority $OutputDirectory $AppLogPath $RunMarker
  $translatedAcousticAuthority = Get-TranslatedPcmLoopbackAuthority $OutputDirectory $Recording $playbackAuthority $AppLogPath $RunMarker $Context
  [pscustomobject]@{
    schemaVersion = 1
    authorityMode = "local-pcm-cue-playback-v1"
    collectionStatus = "completed"
    remoteProviderCalls = 0
    externalAudioSeconds = 0
    source = ""
    translation = ""
    sourceReference = $SourceReferenceTranscript
    subtitleText = $subtitleText
    segmentTranslationText = $segmentTranslationText
    subtitleQueue = $subtitleQueue
    sttSourceWindow = $sourceWindow
    originalPassthrough = [pscustomobject]@{
      transcriptChars = 0
      authority = "canonical-source-signed-waveform-v1"
      sourceSimilarity = $originalSimilarity
    }
    translatedSpeech = [pscustomobject]@{
      playedSegments = $segmentation.playedSegments
      queuedSegments = $segmentation.queuedSegments
      transcriptChars = 0
      authority = "structured-cue-plus-physical-playback-lifecycle"
      playbackAuthority = $playbackAuthority
      acousticAuthority = $translatedAcousticAuthority
    }
    mixedOutput = [pscustomobject]@{
      rms = $Recording.rms
      peak = $Recording.peak
    }
    recording = $Recording
    audioQuality = $Recording.audioQuality
  } | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $resultPath -Encoding UTF8
  return Get-Content -LiteralPath $resultPath -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Invoke-PhysicalOutputContentStt {
  param([string]$OutputDirectory, $Recording, [string]$AppLogPath, [string]$RunMarker, $SourceReferenceTranscript, [Parameter(Mandatory = $true)]$Context)
  $workspaceRoot = [string]$Context.paths.workspaceRoot
  $PlaybackSeconds = [int]$Context.request.media.playbackSeconds
  $authorityMode = [string]$Context.request.authorityMode
  $SkipPhysicalOutputContentStt = [string]$Context.request.physicalContentMode -eq 'disabled'
  $resultPath = Join-Path $OutputDirectory "physical-output-content.raw.json"
  if (-not $Recording) {
    [pscustomobject]@{ passed = $false; error = "physical output recording did not run" } | ConvertTo-Json -Depth 8 | Set-Content -Path $resultPath -Encoding UTF8
    return Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
  }
  if ($authorityMode -in @('strict-paid', 'incident-replay-plus', 'local-canonical-smoke')) {
    return Get-LocalPhysicalOutputContentAuthority `
      $OutputDirectory `
      $Recording `
      $AppLogPath `
      $RunMarker `
      $SourceReferenceTranscript `
      $Context
  }
  if ($SkipPhysicalOutputContentStt) {
    [pscustomobject]@{
      skipped = $true
      reason = "SkipPhysicalOutputContentStt was provided"
      recording = $Recording
      subtitleText = Get-RecentSubtitleText $AppLogPath $RunMarker
    } | ConvertTo-Json -Depth 12 | Set-Content -Path $resultPath -Encoding UTF8
    return Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
  }
  $pcmPath = [string]$Recording.transcriptionPcmPath
  if (-not (Test-Path -LiteralPath $pcmPath -PathType Leaf)) {
    [pscustomobject]@{
      passed = $false
      error = "physical output transcription PCM file was not created"
      recording = $Recording
      subtitleText = Get-RecentSubtitleText $AppLogPath $RunMarker
    } | ConvertTo-Json -Depth 12 | Set-Content -Path $resultPath -Encoding UTF8
    return Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
  }
  $apiKey = Get-PhysicalOutputSttApiKey $workspaceRoot
  if (-not $apiKey) {
    [pscustomobject]@{
      passed = $false
      error = "DASHSCOPE_API_KEY or OMNI_TEST_DASHSCOPE_API_KEY is required for physical output content STT"
      recording = $Recording
      subtitleText = Get-RecentSubtitleText $AppLogPath $RunMarker
    } | ConvertTo-Json -Depth 12 | Set-Content -Path $resultPath -Encoding UTF8
    return Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
  }
  try {
    $exe = Build-OmniRealtimeDiagnostic $OutputDirectory $workspaceRoot
  } catch {
    [pscustomobject]@{
      passed = $false
      error = $_.Exception.Message
      recording = $Recording
      subtitleText = Get-RecentSubtitleText $AppLogPath $RunMarker
    } | ConvertTo-Json -Depth 12 | Set-Content -Path $resultPath -Encoding UTF8
    return Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
  }
  $stdout = Join-Path $OutputDirectory "physical-output-stt.stdout.log"
  $stderr = Join-Path $OutputDirectory "physical-output-stt.stderr.log"
  $sourceWindowSeconds = if ($PlaybackSeconds -gt 0) {
    [Math]::Max(8, $PlaybackSeconds + 8)
  } elseif ($Recording -and $Recording.audioQuality -and $Recording.audioQuality.durationSeconds) {
    [Math]::Max(8, [Math]::Min([double]$Recording.audioQuality.durationSeconds, 90))
  } else {
    90
  }
  $sourceWindow = Copy-PcmWindow $pcmPath `
    (Join-Path $OutputDirectory 'physical-output-recording-source-window-16k-mono.pcm') `
    16000 $sourceWindowSeconds
  $sourceReferencePcmPath = Join-Path $OutputDirectory "source-media-reference-16k-mono.pcm"
  $originalSimilarity = if ($sourceWindow) {
    Measure-PcmReferenceSimilarity -ReferencePcmPath $sourceReferencePcmPath `
      -RecordedPcmPath ([string]$sourceWindow.path) -SampleRateHz 16000 -WorkspaceRoot $workspaceRoot
  } else {
    [pscustomobject]@{
      passed = $false
      error = "physical output source window was not created"
      referencePcmPath = $sourceReferencePcmPath
      recordedPcmPath = $null
    }
  }
  $sttPcmPath = if ($sourceWindow) { [string]$sourceWindow.path } else { $pcmPath }
  $previous = $env:DASHSCOPE_API_KEY
  try {
    $env:DASHSCOPE_API_KEY = $apiKey
    $exit = Invoke-NativeProcessToLog $exe @("--pcm", $sttPcmPath, "--manual") $workspaceRoot $stdout $stderr 240
  } finally {
    $env:DASHSCOPE_API_KEY = $previous
  }
  $text = if (Test-Path -LiteralPath $stdout -PathType Leaf) { Get-Content -LiteralPath $stdout -Raw -Encoding UTF8 -ErrorAction SilentlyContinue } else { "" }
  $parsed = Parse-OmniRealtimeDiagnosticText $text
  $source = $parsed.source
  $translation = $parsed.translation
  $segmentation = Read-SpeechSegmentationSummary $AppLogPath $RunMarker
  $subtitleQueue = $null
  $subtitleText = Get-RecentSubtitleText $AppLogPath $RunMarker
  $segmentTranslationText = Get-RecentFinalSegmentTranslationText $AppLogPath $RunMarker
  [pscustomobject]@{
    collectionStatus = "completed"
    sttSucceeded = ($exit -eq 0 -and $source.Trim().Length -gt 0)
    exitCode = $exit
    source = $source
    translation = $translation
    sourceReference = $SourceReferenceTranscript
    subtitleText = $subtitleText
    segmentTranslationText = $segmentTranslationText
    subtitleQueue = $subtitleQueue
    sttSourceWindow = $sourceWindow
    originalPassthrough = [pscustomobject]@{
      transcriptChars = $source.Trim().Length
      sourceSimilarity = $originalSimilarity
    }
    translatedSpeech = [pscustomobject]@{
      playedSegments = $segmentation.playedSegments
      queuedSegments = $segmentation.queuedSegments
      transcriptChars = $translation.Trim().Length
    }
    mixedOutput = [pscustomobject]@{
      rms = $Recording.rms
      peak = $Recording.peak
    }
    recording = $Recording
    audioQuality = $Recording.audioQuality
    stdout = $stdout
    stderr = $stderr
  } | ConvertTo-Json -Depth 12 | Set-Content -Path $resultPath -Encoding UTF8
  return Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
}

Export-ModuleMember -Function @(
  'Read-TranslatedCuePlaybackAuthority',
  'Get-TranslatedPcmLoopbackAuthority',
  'Get-LocalPhysicalOutputContentAuthority',
  'Invoke-PhysicalOutputContentStt'
)
