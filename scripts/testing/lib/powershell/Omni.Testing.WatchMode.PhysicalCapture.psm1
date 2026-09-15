#requires -Version 5.1
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.IO.psm1') -Force; Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.Process.psm1') -Force; Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.Windows.Audio.psm1') -Force; Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.Bridge.psm1') -Force; Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.AudioAnalysis.psm1') -Force
function Test-RetryablePhysicalOutputProbeFailure {
  param($Result, [string]$FeedbackMode)
  $fingerprint = $Result.processExclusionFingerprint
  $detail = [string]$Result.detail
  $incompleteSourceWindow = $detail.Contains('Bridge source pipe captured only ') -and
    [long]$fingerprint.sourceCapturedFrames -gt 0 -and [long]$fingerprint.sourceCapturedFrames -lt 48000
  $incompleteExternalWindow = $detail.Contains('external fingerprint did not survive process loopback:')
  return $FeedbackMode -eq 'process-exclusion' -and
    $Result.passed -eq $false -and
    [string]$fingerprint.sourceCaptureMode -ceq 'process-exclusion' -and
    [string]$fingerprint.captureBackend -ceq 'wasapi-process-exclusion' -and
    [string]$fingerprint.processLoopbackStatus -ceq 'ready' -and
    [long]$fingerprint.bridgeProcessId -gt 0 -and
    [long]$fingerprint.excludedProcessId -eq [long]$fingerprint.bridgeProcessId -and
    [double]$fingerprint.physicalExternalComponent -ge 0.01 -and
    [double]$fingerprint.physicalBridgeChildComponent -ge 0.01 -and
    ($incompleteExternalWindow -or $incompleteSourceWindow) -and
    -not $detail.Contains('translation fingerprint was not physically detectable') -and
    -not $detail.Contains('leaked into source pipe')
}
function Invoke-PhysicalOutputProbe {
  param([string]$OutputDirectory, [string]$FeedbackMode, [Parameter(Mandatory = $true)][string]$WorkspaceRoot, [string]$PhysicalPlaybackDeviceId, [string]$ExpectedPhysicalPlaybackDeviceName)
  $probeExe = Join-Path $WorkspaceRoot 'target/release/omni-physical-output-probe.exe'
  $bridgeExe = Join-Path $WorkspaceRoot 'target/release/omni-bridge-service.exe'
  $tonePlayerExe = Join-Path $WorkspaceRoot 'target/release/omni-tone-render-probe.exe'
  if (-not (Test-Path -LiteralPath $probeExe -PathType Leaf)) {
    throw "Physical output probe executable not found: $probeExe"
  }
  if (-not (Test-Path -LiteralPath $bridgeExe -PathType Leaf)) {
    throw "Bridge executable not found: $bridgeExe"
  }
  if ($FeedbackMode -eq "process-exclusion" -and -not (Test-Path -LiteralPath $tonePlayerExe -PathType Leaf)) {
    throw "Tone render probe executable not found: $tonePlayerExe"
  }
  $probeRuntimeRoot = Join-Path $OutputDirectory "physical-output-probe-runtime"
  New-Item -ItemType Directory -Force -Path $probeRuntimeRoot | Out-Null
  $stdout = Join-Path $OutputDirectory "physical-output-probe.stdout.log"
  $stderr = Join-Path $OutputDirectory "physical-output-probe.stderr.log"
  $probeDeviceId = $PhysicalPlaybackDeviceId
  if (($probeDeviceId -eq "default" -or [string]::IsNullOrWhiteSpace($probeDeviceId)) -and $ExpectedPhysicalPlaybackDeviceName) {
    $probeDeviceId = $ExpectedPhysicalPlaybackDeviceName
  }
  $probeArgs = @(
    "--bridge-exe", $bridgeExe,
    "--runtime-root", $probeRuntimeRoot,
    "--physical-playback-device-id", $probeDeviceId,
    "--physical-playback-level", "50"
  )
  if ($FeedbackMode -eq "process-exclusion") {
    $probeArgs += @(
      "--tone-player-exe", $tonePlayerExe,
      "--process-exclusion-fingerprint"
    )
  }
  $result = $null
  $exitCode = -1
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    $attemptStdout = Join-Path $OutputDirectory "physical-output-probe.attempt-$attempt.stdout.log"
    $attemptStderr = Join-Path $OutputDirectory "physical-output-probe.attempt-$attempt.stderr.log"
    $output = & $probeExe @probeArgs 2> $attemptStderr
    $exitCode = $LASTEXITCODE
    $text = ($output -join [Environment]::NewLine)
    Set-OmniUtf8NoBomContent $attemptStdout $text
    Copy-Item -LiteralPath $attemptStdout -Destination $stdout -Force
    Copy-Item -LiteralPath $attemptStderr -Destination $stderr -Force
    if (-not $text) {
      throw "physical output probe returned no JSON output. ExitCode=$exitCode"
    }
    try {
      $result = $text | ConvertFrom-Json
    } catch {
      throw "physical output probe returned invalid JSON. ExitCode=$exitCode Output=$text"
    }
    if ($exitCode -eq 0 -and ($result.passed -or $result.skipped)) { break }
    $retryable = Test-RetryablePhysicalOutputProbeFailure -Result $result -FeedbackMode $FeedbackMode
    if (-not $retryable -or $attempt -eq 3) { break }
    Start-Sleep -Milliseconds 750
  }
  if ($exitCode -ne 0 -or (-not $result.passed -and -not $result.skipped)) {
    throw "physical output probe failed. ExitCode=$exitCode Detail=$($result.detail)"
  }
  if ($ExpectedPhysicalPlaybackDeviceName -and -not $result.skipped) {
    $resolvedName = [string]$result.resolvedPhysicalPlaybackDeviceName
    if ($resolvedName -notlike "*$ExpectedPhysicalPlaybackDeviceName*") {
      throw "physical output probe resolved '$resolvedName', expected device name containing '$ExpectedPhysicalPlaybackDeviceName'"
    }
  }
  return $result
}
function Start-PhysicalOutputContentRecorder {
  param(
    [string]$OutputDirectory, [string]$PhysicalDeviceId, [Parameter(Mandatory = $true)][string]$WorkspaceRoot,
    [Parameter(Mandatory = $true)][int]$CellHardWatchdogSeconds, [Parameter(Mandatory = $true)][int]$TerminalTailSeconds,
    [Parameter(Mandatory = $true)][string]$TerminalAuthorityPath,
    [Parameter(Mandatory = $true)][string]$RunMarker,
    [Parameter(Mandatory = $true)][string]$CellId,
    [Parameter(Mandatory = $true)][string]$LeaseId
  )
  $probeExe = Join-Path $WorkspaceRoot 'target/release/omni-physical-output-probe.exe'
  if (-not (Test-Path -LiteralPath $probeExe -PathType Leaf)) {
    throw "Physical output recorder executable not found: $probeExe"
  }
  if (-not $PhysicalDeviceId) {
    throw "Physical output recorder requires a resolved physical playback endpoint id"
  }
  $recordSeconds = [Math]::Max(8, $CellHardWatchdogSeconds + 8)
  $recordingPath = Join-Path $OutputDirectory "physical-output-recording.wav"
  $transcriptionPcmPath = Join-Path $OutputDirectory "physical-output-recording-16k-mono.pcm"
  $stdout = Join-Path $OutputDirectory "physical-output-recorder.stdout.log"
  $stderr = Join-Path $OutputDirectory "physical-output-recorder.stderr.log"
  $startedAtEpochMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $process = Start-Process -FilePath $probeExe -ArgumentList @(
    "--record-only",
    "--record-seconds", "$recordSeconds",
    "--physical-playback-device-id", $PhysicalDeviceId,
    "--record-path", $recordingPath,
    "--transcription-pcm-path", $transcriptionPcmPath,
    "--terminal-marker-path", $TerminalAuthorityPath,
    "--terminal-tail-seconds", "$TerminalTailSeconds",
    "--terminal-run-marker", $RunMarker,
    "--terminal-cell-id", $CellId,
    "--terminal-lease-id", $LeaseId
  ) -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden -PassThru
  return [pscustomobject]@{
    pid = $process.Id
    process = $process
    recordSeconds = $recordSeconds
    startedAtEpochMs = $startedAtEpochMs
    recordingPath = $recordingPath
    transcriptionPcmPath = $transcriptionPcmPath
    stdout = $stdout
    stderr = $stderr
    terminalTailSeconds = $TerminalTailSeconds
    terminalAuthorityPath = $TerminalAuthorityPath
  }
}
function Complete-PhysicalOutputContentRecorder {
  param(
    $Recorder,
    [Parameter(Mandatory = $true)][string]$WorkspaceRoot,
    [switch]$TerminalSucceeded,
    $InjectedAudioQuality,
    [string]$InjectedAudioQualityError,
    [Nullable[bool]]$InjectedRecorderExited
  )
  if (-not $Recorder) { return $null }
  $resultPath = Join-Path (Split-Path -Parent $Recorder.recordingPath) 'physical-output-recording.json'
  $stderrText = if (Test-Path -LiteralPath $Recorder.stderr -PathType Leaf) { [string](Get-Content -LiteralPath $Recorder.stderr -Raw -ErrorAction SilentlyContinue) } else { '' }
  $failure = $null
  $completionFailures = [System.Collections.Generic.List[object]]::new()
  $terminalAuthorityObserved = $Recorder.terminalAuthorityPath -and (Test-Path -LiteralPath $Recorder.terminalAuthorityPath -PathType Leaf)
  if ($TerminalSucceeded -and -not $terminalAuthorityObserved) {
    $failure = 'physical output recorder terminal-success stop requires the immutable desktop terminal authority'
    $completionFailures.Add([pscustomobject]@{ stage='terminal-authority'; status='failed'; message=$failure })
  }
  if ($PSBoundParameters.ContainsKey('InjectedRecorderExited')) {
    $exited = [bool]$InjectedRecorderExited
  } else {
    if ($TerminalSucceeded -and -not $Recorder.process.HasExited) {
      $naturalExitWaitMilliseconds = ([int]$Recorder.terminalTailSeconds + 10) * 1000
      [void]$Recorder.process.WaitForExit($naturalExitWaitMilliseconds)
      $Recorder.process.Refresh()
    }
    if (-not $Recorder.process.HasExited) {
      try { Stop-OmniManagedProcessHandle -Process $Recorder.process -WaitMilliseconds 5000 | Out-Null } catch {
        $message = $_.Exception.Message
        $completionFailures.Add([pscustomobject]@{ stage='process-cleanup'; status='failed'; message=$message })
        if (-not $failure) { $failure = $message }
      }
    }
    # Refuse the next serialized cell while its recorder may retain the endpoint.
    $exited = $Recorder.process.HasExited -or $Recorder.process.WaitForExit(5000)
  }
  if (-not $exited) {
    $message = "physical output recorder did not exit after forced stop; refusing to start another serialized matrix cell (Pid=$($Recorder.pid))"
    $completionFailures.Add([pscustomobject]@{ stage='process-exit'; status='failed'; message=$message })
    if (-not $failure) { $failure = $message }
  }
  $text = if (Test-Path -LiteralPath $Recorder.stdout -PathType Leaf) {
    [string](Get-Content -LiteralPath $Recorder.stdout -Raw -ErrorAction SilentlyContinue)
  } else {
    ""
  }
  $parsed = $null
  $parsedRecorderJson = $false
  $parseFailure = $null
  if ($text) {
    $jsonLine = @($text -split "`r?`n" | Where-Object { $_.Trim().StartsWith("{") } | Select-Object -Last 1)
    if ($jsonLine.Count -gt 0) {
      try {
        $parsed = $jsonLine[0] | ConvertFrom-Json
        $parsedRecorderJson = $null -ne $parsed
      } catch {
        $parseFailure = "physical output recorder returned invalid JSON: $($_.Exception.Message)"
      }
    }
  }
  if (-not $parsed) {
    $parsed = [pscustomobject]@{
      passed = $false
      error = if ($parseFailure) { $parseFailure } else { 'physical output recorder returned no JSON output' }
      stderr = $stderrText
      recordingPath = $Recorder.recordingPath
      transcriptionPcmPath = $Recorder.transcriptionPcmPath
    }
    $parseMessage = [string]$parsed.error
    $completionFailures.Add([pscustomobject]@{ stage='recorder-json'; status='failed'; message=$parseMessage })
    if (-not $failure) { $failure = $parseMessage }
  }
  try {
    if ($PSBoundParameters.ContainsKey('InjectedAudioQualityError')) { throw $InjectedAudioQualityError }
    $quality = if ($PSBoundParameters.ContainsKey('InjectedAudioQuality')) {
      $InjectedAudioQuality
    } elseif (-not $parsedRecorderJson -or -not (Test-Path -LiteralPath $Recorder.transcriptionPcmPath -PathType Leaf)) {
      $completionFailures.Add([pscustomobject]@{ stage='audio-quality'; status='skipped'; message='skipped due to missing valid recorder JSON or transcription PCM' })
      $null
    } else {
      Measure-PcmAudioQuality -PcmPath $Recorder.transcriptionPcmPath -SampleRateHz 16000 -WorkspaceRoot $WorkspaceRoot
    }
    if ($quality) { $parsed | Add-Member -NotePropertyName audioQuality -NotePropertyValue $quality -Force }
  } catch {
    $message = "physical output recorder audio analysis failed: $($_.Exception.Message)"
    $completionFailures.Add([pscustomobject]@{ stage='audio-quality'; status='failed'; message=$message })
    if (-not $failure) { $failure = $message }
  }
  $sampleZeroEpochMs = 0
  $sampleZeroAuthority = $null
  $captureTimeline = $parsed.captureTimeline
  if ($null -ne $captureTimeline) {
    try { $sampleZeroEpochMs = [int64]$captureTimeline.sampleZeroEpochMs } catch {}
    $sampleZeroAuthority = [string]$captureTimeline.sampleZeroTimeAuthority
  }
  if ($sampleZeroEpochMs -le 0 -or $sampleZeroAuthority -cne 'first-capture-packet-qpc-epoch-calibration-v2') {
    $message = 'physical output recorder did not return first-capture sample-zero time authority'
    $completionFailures.Add([pscustomobject]@{ stage='capture-timeline'; status='failed'; message=$message })
    if (-not $failure) { $failure = $message }
  } else { $parsed | Add-Member -NotePropertyName recordingStartedAtEpochMs -NotePropertyValue $sampleZeroEpochMs -Force }
  $parsed | Add-Member -NotePropertyName processLaunchStartedAtEpochMs -NotePropertyValue ([int64]$Recorder.startedAtEpochMs) -Force
  $parsed | Add-Member -NotePropertyName stderr -NotePropertyValue $stderrText -Force
  $parsed | Add-Member -NotePropertyName processExited -NotePropertyValue ([bool]$exited) -Force
  $parsed | Add-Member -NotePropertyName completionFailures -NotePropertyValue @($completionFailures) -Force
  if ($failure) {
    $parsed | Add-Member -NotePropertyName passed -NotePropertyValue $false -Force
    $parsed | Add-Member -NotePropertyName completionError -NotePropertyValue $failure -Force
  }
  $artifactJson = ConvertTo-Json -InputObject $parsed -Depth 6 -Compress
  [System.IO.File]::WriteAllText($resultPath, $artifactJson, [System.Text.UTF8Encoding]::new($false))
  if ($failure) { throw "$failure Diagnostics=$resultPath" }
  return $parsed
}
Export-ModuleMember -Function @(
  'Test-RetryablePhysicalOutputProbeFailure',
  'Invoke-PhysicalOutputProbe',
  'Start-PhysicalOutputContentRecorder',
  'Complete-PhysicalOutputContentRecorder'
)
