#requires -Version 5.1

Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.StateMachine.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.DesktopLifecycle.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.Metrics.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.PlatformOperations.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.Configuration.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.PhysicalCapture.psm1') -Force

function Complete-WatchModePhysicalRecorderAfterRun {
  param(
    [Parameter(Mandatory = $true)]$Recorder,
    [Parameter(Mandatory = $true)][string]$WorkspaceRoot,
    [string]$TerminalAuthorityPath
  )
  $terminalExists = -not [string]::IsNullOrWhiteSpace($TerminalAuthorityPath) -and
    (Test-Path -LiteralPath $TerminalAuthorityPath -PathType Leaf)
  Complete-PhysicalOutputContentRecorder $Recorder $WorkspaceRoot -TerminalSucceeded:$terminalExists
}

function Stop-WatchModeRunResources {
  param(
    [Parameter(Mandatory = $true)]$State,
    [Parameter(Mandatory = $true)]$Context,
    $DesktopProcess,
    [Parameter(Mandatory = $true)][string]$WorkspaceRoot,
    [Parameter(Mandatory = $true)][string]$RuntimeRoot,
    $DesktopEnvironmentState
  )
  try { Stop-WatchModeDesktopShell $Context $DesktopProcess | Out-Null }
  catch { Add-OmniCleanupError -State $State -Code 'watch-mode.cleanup.desktop-failed' -Message $_.Exception.Message | Out-Null }
  $sampler = if ($DesktopProcess -and $DesktopProcess.status -eq 'passed' -and $DesktopProcess.data) {
    $DesktopProcess.data.systemMetricsSampler
  } else { $null }
  try { Stop-WatchModeSystemMetricsSampler $sampler }
  catch { Add-OmniCleanupError -State $State -Code 'watch-mode.cleanup.metrics-failed' -Message $_.Exception.Message | Out-Null }
  try { Stop-StaleBridgeService $WorkspaceRoot $RuntimeRoot | Out-Null }
  catch { Add-OmniCleanupError -State $State -Code 'watch-mode.cleanup.bridge-failed' -Message $_.Exception.Message | Out-Null }
  try { Restore-DesktopAutostartEnvFile $DesktopEnvironmentState }
  catch { Add-OmniCleanupError -State $State -Code 'watch-mode.cleanup.environment-failed' -Message $_.Exception.Message | Out-Null }
}

Export-ModuleMember -Function @('Stop-WatchModeRunResources', 'Complete-WatchModePhysicalRecorderAfterRun')
