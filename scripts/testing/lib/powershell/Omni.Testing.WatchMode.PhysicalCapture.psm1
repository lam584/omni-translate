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
  param($Recorder, [Parameter(Mandatory = $true)][string]$WorkspaceRoot, [switch]$TerminalSucceeded)
  if (-not $Recorder) { return $null }
  $terminalAuthorityObserved = $Recorder.terminalAuthorityPath -and (Test-Path -LiteralPath $Recorder.terminalAuthorityPath -PathType Leaf)
  if ($TerminalSucceeded -and -not $terminalAuthorityObserved) { throw "physical output recorder terminal-success stop requires the immutable desktop terminal authority" }
  if ($TerminalSucceeded -and -not $Recorder.process.HasExited) {
    $naturalExitWaitMilliseconds = ([int]$Recorder.terminalTailSeconds + 10) * 1000
    [void]$Recorder.process.WaitForExit($naturalExitWaitMilliseconds)
    $Recorder.process.Refresh()
  }
  if (-not $Recorder.process.HasExited) {
    Stop-OmniManagedProcessHandle -Process $Recorder.process -WaitMilliseconds 5000 | Out-Null
  }
  # Refuse the next serialized cell while its recorder may retain the endpoint.
  $exited = $Recorder.process.HasExited -or $Recorder.process.WaitForExit(5000)
  if (-not $exited) { throw "physical output recorder did not exit after forced stop; refusing to start another serialized matrix cell (Pid=$($Recorder.pid))" }
  $text = if (Test-Path -LiteralPath $Recorder.stdout -PathType Leaf) {
    Get-Content -LiteralPath $Recorder.stdout -Raw -ErrorAction SilentlyContinue
  } else {
    ""
  }
  $parsed = $null
  if ($text) {
    $jsonLine = @($text -split "`r?`n" | Where-Object { $_.Trim().StartsWith("{") } | Select-Object -Last 1)
    if ($jsonLine.Count -gt 0) {
      try {
        $parsed = $jsonLine[0] | ConvertFrom-Json
      } catch {
        $parsed = $null
      }
    }
  }
  if (-not $parsed) {
    $stderrText = if (Test-Path -LiteralPath $Recorder.stderr -PathType Leaf) { Get-Content -LiteralPath $Recorder.stderr -Raw -ErrorAction SilentlyContinue } else { "" }
    $parsed = [pscustomobject]@{
      passed = $false
      error = "physical output recorder returned no JSON output"
      stderr = $stderrText
      recordingPath = $Recorder.recordingPath
      transcriptionPcmPath = $Recorder.transcriptionPcmPath
    }
  }
  $quality = Measure-PcmAudioQuality -PcmPath $Recorder.transcriptionPcmPath -SampleRateHz 16000 -WorkspaceRoot $workspaceRoot
  if ($quality) {
    $parsed | Add-Member -NotePropertyName audioQuality -NotePropertyValue $quality -Force
  }
  $parsed | Add-Member -NotePropertyName recordingStartedAtEpochMs -NotePropertyValue ([int64]$Recorder.startedAtEpochMs) -Force
  $parsed | ConvertTo-Json -Depth 12 | Set-Content -Path (Join-Path (Split-Path -Parent $Recorder.recordingPath) "physical-output-recording.json") -Encoding UTF8
  return $parsed
}
Export-ModuleMember -Function @(
  'Test-RetryablePhysicalOutputProbeFailure',
  'Invoke-PhysicalOutputProbe',
  'Start-PhysicalOutputContentRecorder',
  'Complete-PhysicalOutputContentRecorder'
)
