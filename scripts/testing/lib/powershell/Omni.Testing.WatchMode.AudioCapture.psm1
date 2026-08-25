#requires -Version 5.1

Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.IO.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.Windows.Audio.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.Bridge.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.AudioAnalysis.psm1') -Force
function Write-TestMediaReferencePcm {
  param(
    [string]$PathToMedia,
    [string]$OutputDirectory,
    [Parameter(Mandatory = $true)][string]$WorkspaceRoot,
    [Parameter(Mandatory = $true)][int]$PlaybackSeconds,
    [string]$InjectorExecutablePath
  )
  if (-not $OutputDirectory) {
    return $null
  }
  $injectorExe = if ($InjectorExecutablePath) { $InjectorExecutablePath } else { Join-Path $WorkspaceRoot 'target/release/omni-watch-media-injector.exe' }
  if (-not (Test-Path -LiteralPath $injectorExe -PathType Leaf)) {
    throw "watch media injector was not built: $injectorExe. Run npm run build:bridge-service-native first."
  }
  $referencePcmPath = Join-Path $OutputDirectory "source-media-reference-16k-mono.pcm"
  $args = @(
    "--media", (Resolve-Path -LiteralPath $PathToMedia).Path,
    "--reference-pcm16k-mono-path", $referencePcmPath,
    "--reference-only"
  )
  if ($PlaybackSeconds -gt 0) {
    $args += @("--max-seconds", "$PlaybackSeconds")
  }
  $output = @(& $injectorExe @args)
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0 -or -not $output) {
    throw "watch media reference decoder failed. ExitCode=$exitCode Output=$output"
  }
  try {
    $result = ($output -join [Environment]::NewLine) | ConvertFrom-Json
  } catch {
    throw "watch media reference decoder returned invalid JSON: $($_.Exception.Message)"
  }
  if (-not $result.passed -or -not (Test-Path -LiteralPath $referencePcmPath -PathType Leaf)) {
    throw "watch media reference decoder failed: $($result.detail)"
  }
  return $referencePcmPath
}

function Start-TestMediaPlayback {
  param([string]$PathToMedia, [string]$PlaybackEndpointId, [string]$OutputDirectory, [Parameter(Mandatory = $true)][string]$WorkspaceRoot, [Parameter(Mandatory = $true)][int]$PlaybackSeconds)
  if (-not (Test-Path -LiteralPath $PathToMedia -PathType Leaf)) {
    throw "Test media file not found: $PathToMedia"
  }
  $injectorExe = Join-Path $WorkspaceRoot 'target/release/omni-watch-media-injector.exe'
  if (Test-Path -LiteralPath $injectorExe -PathType Leaf) {
    $resolvedMediaPath = (Resolve-Path -LiteralPath $PathToMedia).Path
    $mediaSha256 = (Get-FileHash -LiteralPath $resolvedMediaPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $args = @("--media", $resolvedMediaPath)
    $referencePcmPath = $null
    if ($OutputDirectory) {
      $referencePcmPath = Join-Path $OutputDirectory "source-media-reference-16k-mono.pcm"
      $args += @("--reference-pcm16k-mono-path", $referencePcmPath)
    }
    if ($PlaybackEndpointId) {
      $args += @("--endpoint-id", $PlaybackEndpointId)
    }
    if ($PlaybackSeconds -gt 0) {
      $args += @("--max-seconds", "$PlaybackSeconds")
    }
    $playbackStartedAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $output = & $injectorExe @args
    $playbackFinishedAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0 -or -not $output) {
      throw "watch media injector failed. ExitCode=$exitCode Output=$output"
    }
    $result = ($output -join [Environment]::NewLine) | ConvertFrom-Json
    if (-not $result.passed) {
      throw "watch media injector failed: $($result.detail)"
    }
    return [pscustomobject]@{
      playbackMode = "wasapi-media-injector"
      endpointId = $result.endpointId
      mediaPath = $result.mediaPath
      mediaSha256 = $mediaSha256
      injectorProcessId = $result.processId
      startedAtMs = if ($result.startedAtMs) { $result.startedAtMs } else { $playbackStartedAtMs }
      finishedAtMs = if ($result.finishedAtMs) { $result.finishedAtMs } else { $playbackFinishedAtMs }
      renderedFrames = $result.renderedFrames
      renderedSeconds = $result.renderedSeconds
      referencePcmPath = $referencePcmPath
    }
  }

  throw "watch media injector was not built: $injectorExe. Run npm run build:bridge-service-native first."
}

function Start-TestMediaPlaybackViaDefaultEndpoint {
  param([string]$PathToMedia, [string]$PlaybackEndpointId, [string]$OutputDirectory, [Parameter(Mandatory = $true)][string]$WorkspaceRoot, [Parameter(Mandatory = $true)][int]$PlaybackSeconds)
  if (-not (Test-Path -LiteralPath $PathToMedia -PathType Leaf)) {
    throw "Test media file not found: $PathToMedia"
  }
  $resolvedMediaPath = (Resolve-Path -LiteralPath $PathToMedia).Path
  $mediaSha256 = (Get-FileHash -LiteralPath $resolvedMediaPath -Algorithm SHA256).Hash.ToLowerInvariant()
  # MCI exercises the Windows default-endpoint route but does not expose its
  # decoded samples. Produce the same 16 kHz mono authority without opening a
  # render stream, and do it before switching so a decoder failure cannot
  # strand the machine on the temporary Watch playback endpoint.
  $referencePcmPath = Write-TestMediaReferencePcm $resolvedMediaPath $OutputDirectory $WorkspaceRoot $PlaybackSeconds
  $previousEndpointId = $null
  $defaultEndpointSwitched = $false
  if ($PlaybackEndpointId) {
    $previousEndpointId = Get-DefaultRenderEndpointId
    Set-DefaultRenderEndpoint $PlaybackEndpointId
    $defaultEndpointSwitched = $true
    Start-Sleep -Milliseconds 500
  }
  if (-not ([type]::GetType("OmniTranslate.WinmmMci", $false))) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace OmniTranslate {
  public static class WinmmMci {
    [DllImport("winmm.dll", CharSet = CharSet.Unicode)]
    private static extern int mciSendString(string command, StringBuilder returnValue, int returnLength, IntPtr hwndCallback);

    public static string Send(string command, int returnLength) {
      var buffer = new StringBuilder(returnLength);
      int result = mciSendString(command, buffer, returnLength, IntPtr.Zero);
      if (result != 0) {
        throw new InvalidOperationException("mciSendString failed result=" + result + " command=" + command);
      }
      return buffer.ToString();
    }
  }
}
"@
  }
  $alias = "omni_watch_test_$PID"
  $playbackStartedAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $durationSeconds = $null
  $volumeWarning = $null
  try {
    [void][OmniTranslate.WinmmMci]::Send("open `"$resolvedMediaPath`" alias $alias", 0)
    $lengthMsText = [OmniTranslate.WinmmMci]::Send("status $alias length", 64)
    $lengthMs = 0
    if ([int]::TryParse($lengthMsText.Trim(), [ref]$lengthMs) -and $lengthMs -gt 0) {
      $durationSeconds = [Math]::Round($lengthMs / 1000.0, 3)
    }
    try {
      [void][OmniTranslate.WinmmMci]::Send("setaudio $alias volume to 600", 0)
    } catch {
      # Some WinMM waveaudio devices reject setaudio even though play works.
      # Preserve this diagnostic but do not suppress the real media playback.
      $volumeWarning = $_.Exception.Message
    }
    [void][OmniTranslate.WinmmMci]::Send("play $alias from 0", 0)
    $sleepSeconds = if ($PlaybackSeconds -gt 0) {
      $PlaybackSeconds
    } elseif ($durationSeconds -and $durationSeconds -gt 0) {
      [Math]::Ceiling($durationSeconds)
    } else {
      0
    }
    if ($sleepSeconds -gt 0) {
      Start-Sleep -Seconds $sleepSeconds
    }
    [void][OmniTranslate.WinmmMci]::Send("stop $alias", 0)
  } finally {
    try {
      [void][OmniTranslate.WinmmMci]::Send("close $alias", 0)
    } catch {
    }
    if ($defaultEndpointSwitched -and $previousEndpointId) {
      Set-DefaultRenderEndpoint $previousEndpointId
    }
  }
  return [pscustomobject]@{
    playbackMode = "mci-default-endpoint"
    endpointId = $PlaybackEndpointId
    mediaPath = $resolvedMediaPath
    mediaSha256 = $mediaSha256
    injectorProcessId = $PID
    startedAtMs = $playbackStartedAtMs
    finishedAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    playedSeconds = if ($PlaybackSeconds -gt 0) { $PlaybackSeconds } else { $durationSeconds }
    naturalDurationSeconds = $durationSeconds
    volumeWarning = $volumeWarning
    defaultEndpointSwitched = $defaultEndpointSwitched
    referencePcmPath = $referencePcmPath
  }
}

function Invoke-VirtualDriverMediaSourcePreflight {
  param(
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [Parameter(Mandatory = $true)][string]$VirtualRenderEndpointId,
    [Parameter(Mandatory = $true)][string]$PathToMedia,
    [Parameter(Mandatory = $true)][string]$WorkspaceRoot
  )
  # The development-driver health probe injects directly through the IOCTL
  # surface. That proves the ring and source pipe, but it does not prove that
  # the exact WASAPI media injector used by a paid Watch cell reached the
  # virtual render endpoint. Keep this zero-LLM probe separate and require a
  # freshly observed source frame before the Desktop can preconnect a model.
  if ([string]::IsNullOrWhiteSpace($VirtualRenderEndpointId)) {
    throw "virtual-driver media source preflight requires the driver probe WasapiEndpointId"
  }
  if (-not (Test-Path -LiteralPath $PathToMedia -PathType Leaf)) {
    throw "virtual-driver media source preflight media file was not found: $PathToMedia"
  }
  $bridgeExe = Join-Path $WorkspaceRoot 'target/release/omni-bridge-service.exe'
  $injectorExe = Join-Path $WorkspaceRoot 'target/release/omni-watch-media-injector.exe'
  $audioProbeExe = Join-Path $WorkspaceRoot 'target/release/omni-driver-audio-probe.exe'
  foreach ($requiredExe in @($bridgeExe, $injectorExe, $audioProbeExe)) {
    if (-not (Test-Path -LiteralPath $requiredExe -PathType Leaf)) {
      throw "virtual-driver media source preflight executable was not built: $requiredExe"
    }
  }

  # See Invoke-BridgeSourceProbe: runtime state needs a short Windows path.
  $preflightRoot = Join-Path ([System.IO.Path]::GetTempPath()) "omni-virtual-driver-preflight-$PID"
  New-Item -ItemType Directory -Force -Path $preflightRoot | Out-Null
  $installStateJson = [ordered]@{
    protocolVersion = '2026-08-13-audio-routing-v7'
    installChannel = 'development'
    driverVersion = '0.10.0-dev'
    bridgeVersion = '0.1.0'
    driverHealth = 'running'
    installedAt = (Get-Date -Format s)
    targetDeviceId = 'virtual-mic-default'
    virtualRenderDeviceId = 'virtual-speaker-default'
    driverBackend = 'sysvad-wave-rt'
  } | ConvertTo-Json -Depth 6
  Set-OmniUtf8NoBomContent (Join-Path $preflightRoot "driver-install-state.json") $installStateJson

  $resetStdout = Join-Path $preflightRoot "driver-reset.stdout.log"
  $resetStderr = Join-Path $preflightRoot "driver-reset.stderr.log"
  $resetProcess = Start-Process -FilePath $audioProbeExe `
    -ArgumentList @("--reset-only") `
    -RedirectStandardOutput $resetStdout `
    -RedirectStandardError $resetStderr `
    -WindowStyle Hidden -Wait -PassThru
  $resetOutput = if (Test-Path -LiteralPath $resetStdout -PathType Leaf) {
    Get-Content -LiteralPath $resetStdout -Raw -Encoding UTF8
  } else { "" }
  $resetResult = $null
  try {
    if ($resetOutput.Trim()) {
      $resetResult = $resetOutput | ConvertFrom-Json
    }
  } catch {
    throw "virtual-driver media source preflight reset emitted invalid JSON: $($_.Exception.Message)"
  }
  if ($resetProcess.ExitCode -ne 0 -or $null -eq $resetResult -or $resetResult.passed -ne $true) {
    $resetError = if (Test-Path -LiteralPath $resetStderr -PathType Leaf) {
      Get-Content -LiteralPath $resetStderr -Raw -Encoding UTF8
    } else { "" }
    throw "virtual-driver media source preflight could not reset the driver ring: $resetError $resetOutput"
  }

  $pipeName = "omni-watch-media-preflight-$PID"
  $bridgeStdout = Join-Path $OutputDirectory "virtual-driver-media-source-preflight.bridge.stdout.log"
  $bridgeStderr = Join-Path $OutputDirectory "virtual-driver-media-source-preflight.bridge.stderr.log"
  $injectorStdout = Join-Path $OutputDirectory "virtual-driver-media-source-preflight.injector.stdout.log"
  $injectorStderr = Join-Path $OutputDirectory "virtual-driver-media-source-preflight.injector.stderr.log"
  $diagnosticsPath = Join-Path $OutputDirectory "virtual-driver-media-source-preflight-diagnostics.json"
  $bridgeProcess = $null
  $injectorProcess = $null
  $init = $null
  $frame = $null
  $injectorResult = $null
  $phase = "start_bridge"
  try {
    $bridgeProcess = Start-Process -FilePath $bridgeExe -ArgumentList @(
      "--pipe-name", $pipeName,
      "--runtime-root", $preflightRoot,
      "--bridge-version", "0.1.0"
    ) -RedirectStandardOutput $bridgeStdout -RedirectStandardError $bridgeStderr -WindowStyle Hidden -PassThru
    Start-Sleep -Milliseconds 600
    $phase = "init"
    $sessionId = "watch-mode-media-preflight-$PID"
    $init = Write-NamedPipeJsonLine $pipeName (New-BridgeSourceProbeInitPayload "virtual-driver" $sessionId)
    $phase = "render_media"
    $injectorProcess = Start-Process -FilePath $injectorExe `
      -ArgumentList @("--media", (Resolve-Path -LiteralPath $PathToMedia).Path, "--endpoint-id", $VirtualRenderEndpointId, "--max-seconds", "5") `
      -RedirectStandardOutput $injectorStdout `
      -RedirectStandardError $injectorStderr `
      -WindowStyle Hidden -PassThru
    $phase = "read_source_frame"
    $frame = Read-BridgeSourceFrame "$pipeName-source" -TimeoutMs 12000
    if (-not $injectorProcess.WaitForExit(20000)) {
      throw "watch media injector did not exit after the virtual-driver source frame"
    }
    $injectorProcess.Refresh()
    $injectorOutput = if (Test-Path -LiteralPath $injectorStdout -PathType Leaf) {
      Get-Content -LiteralPath $injectorStdout -Raw -Encoding UTF8
    } else { "" }
    try {
      if ($injectorOutput.Trim()) {
        $injectorResult = $injectorOutput | ConvertFrom-Json
      }
    } catch {
      throw "watch media injector emitted invalid JSON: $($_.Exception.Message)"
    }
    if ((($null -ne $injectorProcess.ExitCode) -and $injectorProcess.ExitCode -ne 0) -or $null -eq $injectorResult -or $injectorResult.passed -ne $true) {
      $injectorError = if (Test-Path -LiteralPath $injectorStderr -PathType Leaf) {
        Get-Content -LiteralPath $injectorStderr -Raw -Encoding UTF8
      } else { "" }
      throw "watch media injector did not report passed=true: $injectorError $injectorOutput"
    }
    $phase = "shutdown"
    [void](Write-NamedPipeJsonLine $pipeName ([ordered]@{
      type = 'bridge.shutdown'
      requestId = "watch-mode-media-preflight-shutdown-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
      sessionId = $sessionId
      reason = 'watch-mode-media-preflight-complete'
    }))
    return [pscustomobject]@{
      passed = $true
      reset = $resetResult
      init = $init
      sourceFrame = $frame
      injector = $injectorResult
      virtualRenderEndpointId = $VirtualRenderEndpointId
      pipeName = $pipeName
      sourcePipeName = "$pipeName-source"
      bridgeStdout = $bridgeStdout
      bridgeStderr = $bridgeStderr
      injectorStdout = $injectorStdout
      injectorStderr = $injectorStderr
    }
  } catch {
    $errorMessage = $_.Exception.Message
    [pscustomobject]@{
      passed = $false
      phase = $phase
      error = $errorMessage
      init = $init
      sourceFrame = $frame
      injector = $injectorResult
      virtualRenderEndpointId = $VirtualRenderEndpointId
      pipeName = $pipeName
      sourcePipeName = "$pipeName-source"
      bridgeStdout = $bridgeStdout
      bridgeStderr = $bridgeStderr
      injectorStdout = $injectorStdout
      injectorStderr = $injectorStderr
    } | ConvertTo-Json -Depth 12 | Set-Content -Path $diagnosticsPath -Encoding UTF8
    throw "virtual-driver media source preflight failed during ${phase}: $errorMessage Diagnostics=$diagnosticsPath"
  } finally {
    if ($injectorProcess -and -not $injectorProcess.HasExited) {
      Stop-Process -Id $injectorProcess.Id -Force -ErrorAction SilentlyContinue
    }
    if ($bridgeProcess -and -not $bridgeProcess.HasExited) {
      Stop-Process -Id $bridgeProcess.Id -Force -ErrorAction SilentlyContinue
    }
  }
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
  $output = & $probeExe @probeArgs 2> $stderr
  $exitCode = $LASTEXITCODE
  $text = ($output -join [Environment]::NewLine)
  Set-OmniUtf8NoBomContent $stdout $text
  if (-not $text) {
    throw "physical output probe returned no JSON output. ExitCode=$exitCode"
  }
  try {
    $result = $text | ConvertFrom-Json
  } catch {
    throw "physical output probe returned invalid JSON. ExitCode=$exitCode Output=$text"
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
  param([string]$OutputDirectory, [string]$PhysicalDeviceId, [Parameter(Mandatory = $true)][string]$WorkspaceRoot, [Parameter(Mandatory = $true)][int]$PlaybackSeconds, [Parameter(Mandatory = $true)][int]$PostPlaybackWaitSeconds)
  $probeExe = Join-Path $WorkspaceRoot 'target/release/omni-physical-output-probe.exe'
  if (-not (Test-Path -LiteralPath $probeExe -PathType Leaf)) {
    throw "Physical output recorder executable not found: $probeExe"
  }
  if (-not $PhysicalDeviceId) {
    throw "Physical output recorder requires a resolved physical playback endpoint id"
  }
  $mediaBudgetSeconds = if ($PlaybackSeconds -gt 0) { $PlaybackSeconds } else { 180 }
  $recordSeconds = [Math]::Max(8, $mediaBudgetSeconds + $PostPlaybackWaitSeconds + 8)
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
    "--transcription-pcm-path", $transcriptionPcmPath
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
  }
}

function Complete-PhysicalOutputContentRecorder {
  param($Recorder, [Parameter(Mandatory = $true)][string]$WorkspaceRoot)
  if (-not $Recorder) {
    return $null
  }
  $timeoutMs = ([int]$Recorder.recordSeconds + 20) * 1000
  $exited = $Recorder.process.WaitForExit($timeoutMs)
  if (-not $exited) {
    Stop-Process -Id $Recorder.pid -Force -ErrorAction SilentlyContinue
    # A successful Stop-Process request is asynchronous.  Do not allow the
    # next serialized matrix cell to start while its physical-output recorder
    # may still retain the endpoint; that would contaminate the single-device
    # evidence window.
    $exited = $Recorder.process.WaitForExit(5000)
    if (-not $exited) {
      throw "physical output recorder did not exit after forced stop; refusing to start another serialized matrix cell (Pid=$($Recorder.pid))"
    }
  }
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
  'Write-TestMediaReferencePcm',
  'Start-TestMediaPlayback',
  'Start-TestMediaPlaybackViaDefaultEndpoint',
  'Invoke-VirtualDriverMediaSourcePreflight',
  'Invoke-PhysicalOutputProbe',
  'Start-PhysicalOutputContentRecorder',
  'Complete-PhysicalOutputContentRecorder'
)
