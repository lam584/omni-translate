#requires -Version 5.1

Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.IO.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.Configuration.psm1') -Force

function Write-NamedPipeJsonLine {
  param(
    [string]$PipeName,
    [object]$Payload,
    [int]$TimeoutMs = 5000
  )
  $client = [System.IO.Pipes.NamedPipeClientStream]::new('.', $PipeName, [System.IO.Pipes.PipeDirection]::InOut)
  $client.Connect($TimeoutMs)
  try {
    $writer = [System.IO.StreamWriter]::new($client)
    $writer.AutoFlush = $true
    $reader = [System.IO.StreamReader]::new($client)
    $writer.WriteLine(($Payload | ConvertTo-Json -Depth 12 -Compress))
    $line = $reader.ReadLine()
    if (-not $line) {
      throw "named pipe $PipeName returned no response"
    }
    return $line | ConvertFrom-Json
  } finally {
    $client.Dispose()
  }
}

function Read-BridgeSourceFrame {
  param(
    [string]$PipeName,
    [int]$TimeoutMs = 8000
  )
  $client = [System.IO.Pipes.NamedPipeClientStream]::new('.', $PipeName, [System.IO.Pipes.PipeDirection]::In)
  $client.Connect($TimeoutMs)
  try {
    $reader = [System.IO.BinaryReader]::new($client)
    $started = [DateTimeOffset]::UtcNow
    while (([DateTimeOffset]::UtcNow - $started).TotalMilliseconds -lt $TimeoutMs) {
      $headerLength = $reader.ReadUInt32()
      $headerBytes = $reader.ReadBytes($headerLength)
      $header = [System.Text.Encoding]::UTF8.GetString($headerBytes) | ConvertFrom-Json
      $payloadBytes = 0
      if ($header.payloadBytes -gt 0) {
        $payload = $reader.ReadBytes($header.payloadBytes)
        $payloadBytes = $payload.Length
      }
      if ($header.type -eq 'bridge.source.frame' -and $payloadBytes -gt 0) {
        return [pscustomobject]@{
          eventType = $header.type
          frameId = $header.frameId
          frameCount = $header.frameCount
          payloadBytes = $payloadBytes
          sampleRateHz = $header.sampleRateHz
          channelCount = $header.channelCount
        }
      }
    }
    throw "timed out waiting for a bridge.source.frame"
  } finally {
    $client.Dispose()
  }
}

function New-BridgeSourceProbeInitPayload {
  param(
    [string]$FeedbackMode,
    [string]$SessionId
  )
  $sourceCaptureMode = if ($FeedbackMode -eq "process-exclusion") { "process-exclusion" } else { "virtual-driver" }
  return [ordered]@{
    type = 'bridge.init'
    requestId = "watch-mode-probe-init-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
    protocolVersion = '2026-08-13-audio-routing-v7'
    sessionId = $SessionId
    installChannel = 'development'
    targetDeviceId = 'virtual-mic-default'
    virtualRenderDeviceId = 'virtual-speaker-default'
    physicalPlaybackDeviceId = 'default'
    physicalPlaybackLevel = 50
    monitorPlaybackEnabled = $false
    translationPlaybackEnabled = $true
    sourceCaptureMode = $sourceCaptureMode
    expectedDriverVersion = '0.10.0-dev'
    expectedBridgeVersion = '0.1.0'
    mixControl = [ordered]@{
      keepOriginalAudio = $true
      translatedAudioEnabled = $true
      translatedAudioGainDb = 0
      originalAudioGainDb = 0
      duckingEnabled = $false
      duckingDepthPercent = 0
      monitorMode = 'translated-only'
    }
  }
}

function Invoke-BridgeSourceProbe {
  param(
    [string]$OutputDirectory,
    [string]$FeedbackMode = "virtual-driver",
    [Parameter(Mandatory = $true)][string]$WorkspaceRoot
  )
  $bridgeExe = Join-Path $WorkspaceRoot 'target/release/omni-bridge-service.exe'
  if (-not (Test-Path -LiteralPath $bridgeExe -PathType Leaf)) {
    throw "Bridge executable not found: $bridgeExe"
  }
  New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
  # Keep the bridge's mutable runtime state out of the deeply nested evidence
  # tree.  Windows file APIs used by the bridge can otherwise fail while
  # creating nested state files under a long smoke-cell path.
  $probeRuntimeRoot = Join-Path ([System.IO.Path]::GetTempPath()) "omni-bridge-source-probe-$PID"
  New-Item -ItemType Directory -Force -Path $probeRuntimeRoot | Out-Null
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
  Set-OmniUtf8NoBomContent (Join-Path $probeRuntimeRoot "driver-install-state.json") $installStateJson
  $pipeName = "omni-watch-mode-probe-$PID"
  $stdout = Join-Path $OutputDirectory "bridge-source-probe.stdout.log"
  $stderr = Join-Path $OutputDirectory "bridge-source-probe.stderr.log"
  $diagnosticsPath = Join-Path $OutputDirectory "bridge-source-probe-diagnostics.json"
  $process = Start-Process -FilePath $bridgeExe -ArgumentList @(
    "--pipe-name", $pipeName,
    "--runtime-root", $probeRuntimeRoot,
    "--bridge-version", "0.1.0"
  ) -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden -PassThru
  $init = $null
  $state = $null
  $frame = $null
  $audioProbeProcess = $null
  $phase = "init"
  try {
    Start-Sleep -Milliseconds 600
    $phase = "init"
    $sessionId = "watch-mode-probe-session-$PID"
    $initPayload = New-BridgeSourceProbeInitPayload $FeedbackMode $sessionId
    $init = Write-NamedPipeJsonLine $pipeName $initPayload
    if (Test-UsesVirtualDriverBackend $FeedbackMode) {
      $phase = "source_frame"
      $audioProbeExe = Join-Path $WorkspaceRoot 'target/release/omni-driver-audio-probe.exe'
      if (-not (Test-Path -LiteralPath $audioProbeExe -PathType Leaf)) {
        throw "Driver audio probe executable not found: $audioProbeExe"
      }
      $audioProbeStdout = Join-Path $probeRuntimeRoot "audio-probe.stdout.log"
      $audioProbeStderr = Join-Path $probeRuntimeRoot "audio-probe.stderr.log"
      $audioProbeProcess = Start-Process -FilePath $audioProbeExe `
        -ArgumentList @("--inject-only") `
        -RedirectStandardOutput $audioProbeStdout `
        -RedirectStandardError $audioProbeStderr `
        -WindowStyle Hidden -PassThru
      Start-Sleep -Milliseconds 250
      $frame = Read-BridgeSourceFrame "$pipeName-source"
      if (-not $audioProbeProcess.WaitForExit(15000)) {
        throw "driver audio probe did not exit after source frame injection"
      }
      $audioProbeProcess.Refresh()
      $probeOutput = if (Test-Path -LiteralPath $audioProbeStdout) {
        Get-Content -LiteralPath $audioProbeStdout -Raw -ErrorAction SilentlyContinue
      } else { "" }
      $probeResult = $null
      try {
        if ($probeOutput.Trim()) {
          $probeResult = $probeOutput | ConvertFrom-Json
        }
      } catch {
        throw "driver audio probe produced invalid JSON: $($_.Exception.Message)"
      }
      if ($null -eq $probeResult -or $probeResult.passed -ne $true) {
        $probeError = if (Test-Path -LiteralPath $audioProbeStderr) {
          Get-Content -LiteralPath $audioProbeStderr -Raw -ErrorAction SilentlyContinue
        } else { "" }
        throw "driver audio probe did not report passed=true: $probeError $probeOutput"
      }
      if ($null -ne $audioProbeProcess.ExitCode -and $audioProbeProcess.ExitCode -ne 0) {
        throw "driver audio probe reported exit code $($audioProbeProcess.ExitCode) after passed=true"
      }
      $resetStdout = Join-Path $probeRuntimeRoot "audio-probe-reset.stdout.log"
      $resetStderr = Join-Path $probeRuntimeRoot "audio-probe-reset.stderr.log"
      $resetProcess = Start-Process -FilePath $audioProbeExe `
        -ArgumentList @("--reset-only") `
        -RedirectStandardOutput $resetStdout `
        -RedirectStandardError $resetStderr `
        -WindowStyle Hidden -Wait -PassThru
      $resetOutput = if (Test-Path -LiteralPath $resetStdout) {
        Get-Content -LiteralPath $resetStdout -Raw -ErrorAction SilentlyContinue
      } else { "" }
      $resetResult = $null
      try {
        if ($resetOutput.Trim()) {
          $resetResult = $resetOutput | ConvertFrom-Json
        }
      } catch {
        throw "driver reset produced invalid JSON: $($_.Exception.Message)"
      }
      if ($resetProcess.ExitCode -ne 0 -or $null -eq $resetResult -or $resetResult.passed -ne $true) {
        $resetError = if (Test-Path -LiteralPath $resetStderr) {
          Get-Content -LiteralPath $resetStderr -Raw -ErrorAction SilentlyContinue
        } else { "" }
        throw "driver reset after source frame probe did not report passed=true: $resetError $resetOutput"
      }
    }
    $phase = "state_query"
    $state = Write-NamedPipeJsonLine $pipeName ([ordered]@{
      type = 'bridge.state.query'
      requestId = "watch-mode-probe-state-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
    })
    $phase = "shutdown"
    [void](Write-NamedPipeJsonLine $pipeName ([ordered]@{
      type = 'bridge.shutdown'
      requestId = "watch-mode-probe-shutdown-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
      sessionId = "watch-mode-probe-session-$PID"
      reason = 'watch-mode-probe-complete'
    }))
    return [pscustomobject]@{
      passed = $true
      init = $init
      state = $state
      sourceFrame = $frame
      pipeName = $pipeName
      sourcePipeName = "$pipeName-source"
      stdout = $stdout
      stderr = $stderr
    }
  } catch {
    $errorMessage = $_.Exception.Message
    $stateQueryError = $null
    if ($init -and -not $state) {
      try {
        $state = Write-NamedPipeJsonLine $pipeName ([ordered]@{
          type = 'bridge.state.query'
          requestId = "watch-mode-probe-state-after-failure-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
        })
      } catch {
        $stateQueryError = $_.Exception.Message
      }
    }
    if ($init) {
      try {
        [void](Write-NamedPipeJsonLine $pipeName ([ordered]@{
          type = 'bridge.shutdown'
          requestId = "watch-mode-probe-shutdown-after-failure-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
          sessionId = "watch-mode-probe-session-$PID"
          reason = 'watch-mode-probe-failed'
        }))
      } catch {
        if (-not $stateQueryError) {
          $stateQueryError = "shutdown failed: $($_.Exception.Message)"
        }
      }
    }
    [pscustomobject]@{
      passed = $false
      phase = $phase
      error = $errorMessage
      init = $init
      state = $state
      stateQueryError = $stateQueryError
      pipeName = $pipeName
      sourcePipeName = "$pipeName-source"
      stdout = $stdout
      stderr = $stderr
    } | ConvertTo-Json -Depth 12 | Set-Content -Path $diagnosticsPath -Encoding UTF8
    throw "bridge source probe failed during ${phase}: $errorMessage Diagnostics=$diagnosticsPath"
  } finally {
    if ($audioProbeProcess -and -not $audioProbeProcess.HasExited) {
      Stop-Process -Id $audioProbeProcess.Id -Force -ErrorAction SilentlyContinue
    }
    if (-not $process.HasExited) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
  }
}


Export-ModuleMember -Function @(
  'Write-NamedPipeJsonLine',
  'Read-BridgeSourceFrame',
  'New-BridgeSourceProbeInitPayload',
  'Invoke-BridgeSourceProbe'
)
