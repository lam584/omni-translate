#requires -Version 5.1
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.IO.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.Process.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.Windows.Elevation.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.Windows.Audio.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.AudioCapture.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.Bridge.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.Configuration.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.DesktopLifecycle.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.PlatformOperations.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.StateMachine.psm1') -Force -DisableNameChecking

function Invoke-PreDesktopStep {
  param(
    [Parameter(Mandatory = $true)]$State,
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Phase,
    [Parameter(Mandatory = $true)][scriptblock]$Script,
    [switch]$ContinueOnError
  )
  Write-Host "==> $Name"
  $step = Invoke-OmniRunPhase -State $State -Id ($Name -replace '[^A-Za-z0-9._-]', '-') -Phase $Phase -Action $Script
  if ($step.status -eq 'failed' -and -not $ContinueOnError) { throw $step.error.message }
  return $step
}

function Invoke-WatchModePreDesktopPhase {
  param(
    [Parameter(Mandatory = $true)]$Execution,
    [Parameter(Mandatory = $true)]$State,
    [string]$DevconPath
  )
  foreach ($property in $Execution.PSObject.Properties) {
    Set-Variable -Name $property.Name -Value $property.Value -Scope Local
  }
  $driverProbe = $null
  $virtualDriverMediaPreflight = $null
  $deviceEvidenceStep = $null
      $appLogForMarker = [string]$runContext.paths.appLogPath
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $appLogForMarker) | Out-Null
      Add-Content -LiteralPath $appLogForMarker -Value $runMarker -Encoding UTF8
      $desktopEnvState = Set-DesktopAutostartEnvFile -RunMarker $runMarker -OutputDirectory $outputDir `
        -WorkspaceRoot $workspaceRoot -Context $runContext
    
      # Windows PowerShell promotes cargo's successful stderr progress line to a
      # NativeCommandError when ErrorActionPreference=Stop. Run npm through cmd
      # with stdout/stderr merged so a zero exit remains a successful build step.
      if ($paidAuthorityEnabled -or $LocalCanonicalContentAuthority) {
        Invoke-OmniRunPhase -State $state -Id 'build-bridge-service-native' -Phase initialize `
          -PolicySkipReason 'frozen runtime authority forbids rebuilding inside evidence collection' | Out-Null
      } else {
        Invoke-PreDesktopStep -State $state "build bridge service native" -Phase initialize {
          & cmd.exe /d /c 'npm.cmd run build:bridge-service-native 2>&1'
        } -ContinueOnError | Out-Null
      }
      Invoke-PreDesktopStep -State $state "verify no unleased desktop shell exists before live run" -Phase preflight {
        Stop-StaleWatchModeDesktopShell
      } | Out-Null
      Invoke-PreDesktopStep -State $state "stop stale bridge service before driver probe" -Phase preflight {
        Stop-StaleBridgeService $workspaceRoot $RuntimeRoot
      } -ContinueOnError | Out-Null
      if (Test-UsesVirtualDriverBackend $FeedbackLoopPrevention) {
        if ($paidAuthorityEnabled) {
          $driverProbe = Invoke-PreDesktopStep -State $state "driver probe from signed worker readiness" -Phase driverProbe {
            Get-SignedWorkerReadinessDriverProbe -ReceiptPath $WorkerReadinessReceiptPath -WorkspaceRoot $workspaceRoot
          } -ContinueOnError
        } else {
          $driverProbeArguments = Get-WatchModeDriverProbeArguments `
            -WorkspaceRoot $workspaceRoot `
            -RequestedDevconPath $DevconPath
          $driverProbe = Invoke-PreDesktopStep -State $state "driver probe" -Phase driverProbe {
            & (Join-Path $workspaceRoot "scripts/installer/test-development-driver.ps1") @driverProbeArguments
          } -ContinueOnError
        }
    
        if ($driverProbe.status -ne 'passed' -and -not $SkipDriverRepair -and $AllowDriverRepair) {
          Invoke-PreDesktopStep -State $state "repair driver with explicit elevation" -Phase driverProbe { Invoke-ElevatedDriverReinstall $outputDir $runContext } -ContinueOnError | Out-Null
          $driverProbe = Invoke-PreDesktopStep -State $state "driver probe after repair" -Phase driverProbe {
            & (Join-Path $workspaceRoot "scripts/installer/test-development-driver.ps1") @driverProbeArguments
          } -ContinueOnError
        }
        elseif ($driverProbe.status -ne 'passed' -and -not $SkipDriverRepair -and -not $AllowDriverRepair) {
          Write-Host "driver probe failed; skipping elevated repair because -AllowDriverRepair was not provided"
        }
      } else {
        $driverProbe = Invoke-OmniRunPhase -State $state -Id 'driver-probe' -Phase driverProbe `
          -PolicySkipReason "$FeedbackLoopPrevention does not install, probe, or depend on the virtual driver"
      }
      Convert-DriverProbeToJsonFile $driverProbe (Join-Path $outputDir "driver.json")
      $driverPreflightFailure = Get-VirtualDriverPreflightFailure $FeedbackLoopPrevention $driverProbe
      if ($driverPreflightFailure) { throw $driverPreflightFailure }
    
      $bridgeSourceProbe = if ($FeedbackLoopPrevention -eq "echo-cancel") {
        Invoke-OmniRunPhase -State $state -Id 'bridge-source-frame-probe' -Phase bridgeProbe `
          -PolicySkipReason 'echo-cancel Watch capture does not use a Bridge source backend'
      } else {
        Invoke-PreDesktopStep -State $state "bridge source frame probe" -Phase bridgeProbe {
          Invoke-BridgeSourceProbe -OutputDirectory $outputDir -FeedbackMode $FeedbackLoopPrevention `
            -WorkspaceRoot $workspaceRoot
        } -ContinueOnError
      }
      if ($bridgeSourceProbe.status -eq 'passed') {
        $bridgeSourceProbe.data | ConvertTo-Json -Depth 12 | Set-Content -Path (Join-Path $outputDir "bridge-source-probe.json") -Encoding UTF8
      } else {
        $bridgeDiagnosticsPath = Join-Path $outputDir "bridge-source-probe-diagnostics.json"
        if (Test-Path -LiteralPath $bridgeDiagnosticsPath -PathType Leaf) {
          Get-Content -LiteralPath $bridgeDiagnosticsPath -Raw -Encoding UTF8 | Set-Content -Path (Join-Path $outputDir "bridge-source-probe.json") -Encoding UTF8
        } else {
          [pscustomobject]@{ passed = $false; error = $bridgeSourceProbe.error.message } | ConvertTo-Json -Depth 8 | Set-Content -Path (Join-Path $outputDir "bridge-source-probe.json") -Encoding UTF8
        }
      }
      if ($FeedbackLoopPrevention -ne "echo-cancel" -and $bridgeSourceProbe.status -ne 'passed') {
        throw "bridge source frame preflight failed before the Desktop/LLM session: $($bridgeSourceProbe.error.message)"
      }
    
      $virtualDriverMediaPreflight = if (Test-UsesVirtualDriverBackend $FeedbackLoopPrevention) {
        Invoke-PreDesktopStep -State $state "virtual-driver media source preflight" -Phase preflight {
          Invoke-VirtualDriverMediaSourcePreflight `
            -OutputDirectory $outputDir `
            -VirtualRenderEndpointId ([string]$driverProbe.data.WasapiEndpointId) `
            -PathToMedia $MediaPath `
            -WorkspaceRoot $workspaceRoot
        } -ContinueOnError
      } else {
        Invoke-OmniRunPhase -State $state -Id 'virtual-driver-media-source-preflight' -Phase preflight `
          -PolicySkipReason "$FeedbackLoopPrevention does not use the virtual-driver media path"
      }
      if ($virtualDriverMediaPreflight.status -eq 'passed') {
        $virtualDriverMediaPreflight.data | ConvertTo-Json -Depth 12 | Set-Content -Path (Join-Path $outputDir "virtual-driver-media-source-preflight.json") -Encoding UTF8
      } elseif ($virtualDriverMediaPreflight.status -eq 'failed') {
        $preflightDiagnosticsPath = Join-Path $outputDir "virtual-driver-media-source-preflight-diagnostics.json"
        if (Test-Path -LiteralPath $preflightDiagnosticsPath -PathType Leaf) {
          Get-Content -LiteralPath $preflightDiagnosticsPath -Raw -Encoding UTF8 | Set-Content -Path (Join-Path $outputDir "virtual-driver-media-source-preflight.json") -Encoding UTF8
        } else {
          [pscustomobject]@{ passed = $false; error = $virtualDriverMediaPreflight.error.message } | ConvertTo-Json -Depth 8 | Set-Content -Path (Join-Path $outputDir "virtual-driver-media-source-preflight.json") -Encoding UTF8
        }
        throw "virtual-driver media source preflight failed before the Desktop/LLM session: $($virtualDriverMediaPreflight.error.message)"
      } else {
        [pscustomobject]@{
          skipped = $true
          reason = [string]$virtualDriverMediaPreflight.data.reason
        } | ConvertTo-Json -Depth 8 | Set-Content -Path (Join-Path $outputDir "virtual-driver-media-source-preflight.json") -Encoding UTF8
      }
    
      $physicalOutputProbe = if ($FeedbackLoopPrevention -eq "echo-cancel") {
        Invoke-OmniRunPhase -State $state -Id 'physical-output-loopback-probe' -Phase preflight `
          -PolicySkipReason 'echo-cancel does not use a Bridge physical-output isolation probe'
      } else {
        Invoke-PreDesktopStep -State $state "physical output loopback probe" -Phase preflight {
          Invoke-PhysicalOutputProbe $outputDir $FeedbackLoopPrevention $workspaceRoot $PhysicalPlaybackDeviceId $ExpectedPhysicalPlaybackDeviceName
        } -ContinueOnError
      }
      if ($physicalOutputProbe.status -eq 'passed') {
        $physicalOutputProbe.data | ConvertTo-Json -Depth 12 | Set-Content -Path (Join-Path $outputDir "physical-output-probe.json") -Encoding UTF8
        Set-DesktopPhysicalPlaybackOverride -DeviceId (Get-PhysicalOutputResolvedDeviceId $physicalOutputProbe) `
          -WorkspaceRoot $workspaceRoot
      } else {
        [pscustomobject]@{ error = $physicalOutputProbe.error.message } | ConvertTo-Json -Depth 8 | Set-Content -Path (Join-Path $outputDir "physical-output-probe.json") -Encoding UTF8
      }
    
      $deviceEvidenceStep = Invoke-PreDesktopStep -State $state "resolve and classify physical playback endpoint" -Phase preflight {
        Resolve-PhysicalPlaybackDeviceEvidence -PhysicalOutputProbe $physicalOutputProbe `
          -FeedbackMode $FeedbackLoopPrevention -RequestedDeviceId $PhysicalPlaybackDeviceId `
          -ExpectedDeviceName $ExpectedPhysicalPlaybackDeviceName -ProfileId $PhysicalPlaybackDeviceProfileId `
          -DeviceClass $PhysicalPlaybackDeviceClass
      } -ContinueOnError
      if ($deviceEvidenceStep.status -ne 'passed') {
        throw "physical playback device evidence failed: $($deviceEvidenceStep.error.message)"
      }
      $deviceEvidenceStep.data | ConvertTo-Json -Depth 8 | Set-Content -Path (Join-Path $outputDir "physical-playback-device.json") -Encoding UTF8
      $resolvedPhysicalDeviceId = [string]$deviceEvidenceStep.data.resolvedDeviceId
      Set-DesktopPhysicalPlaybackOverride -DeviceId $resolvedPhysicalDeviceId -WorkspaceRoot $workspaceRoot
      $desktopProcess = Invoke-PreDesktopStep -State $state "start desktop shell" -Phase desktopLaunch {
        Start-WatchModeDesktopShell $runContext $outputDir $runMarker $resolvedPhysicalDeviceId
      } -ContinueOnError
    
  [pscustomobject]@{
    desktopProcess = $desktopProcess
    desktopEnvState = $desktopEnvState
    driverProbe = $driverProbe
    virtualDriverMediaPreflight = $virtualDriverMediaPreflight
    deviceEvidenceStep = $deviceEvidenceStep
    resolvedPhysicalDeviceId = $resolvedPhysicalDeviceId
  }
}

Export-ModuleMember -Function Invoke-WatchModePreDesktopPhase
