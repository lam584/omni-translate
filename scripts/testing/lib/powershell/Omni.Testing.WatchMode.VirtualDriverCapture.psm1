#requires -Version 5.1

Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.IO.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.Process.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.Windows.Audio.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.Bridge.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.AudioAnalysis.psm1') -Force

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
    protocolVersion = '2026-08-27-audio-routing-v8'
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
      Stop-OmniManagedProcessHandle -Process $injectorProcess | Out-Null
    }
    if ($bridgeProcess -and -not $bridgeProcess.HasExited) {
      Stop-OmniManagedProcessHandle -Process $bridgeProcess | Out-Null
    }
  }
}


Export-ModuleMember -Function 'Invoke-VirtualDriverMediaSourcePreflight'
