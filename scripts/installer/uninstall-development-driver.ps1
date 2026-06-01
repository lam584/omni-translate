param(
  [Parameter(Mandatory = $true)][string]$WorkspaceRoot,
  [Parameter(Mandatory = $true)][string]$RuntimeRoot,
  [Parameter(Mandatory = $true)][string]$InstallChannel,
  [Parameter(Mandatory = $true)][string]$DriverVersion,
  [Parameter(Mandatory = $true)][string]$BridgeVersion,
  [Parameter(Mandatory = $true)][string]$TargetDeviceId,
  [string]$VirtualRenderDeviceId = 'omni-virtual-speaker-default'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'virtual-speaker-device.ps1')
& (Join-Path $PSScriptRoot 'stop-stale-bridge-service.ps1') -WorkspaceRoot $WorkspaceRoot -RuntimeRoot $RuntimeRoot
Assert-OmniAdministrator

New-Item -ItemType Directory -Force -Path $RuntimeRoot | Out-Null

$workspacePath = (Resolve-Path -LiteralPath $WorkspaceRoot).Path
$pnputil = Join-Path $env:SystemRoot 'System32\pnputil.exe'
& $pnputil /remove-device /deviceid $script:OmniVirtualSpeakerHardwareId
if ($LASTEXITCODE -notin @(0, 259, 3010)) {
  throw "pnputil failed to remove $script:OmniVirtualSpeakerHardwareId. ExitCode=$LASTEXITCODE"
}
$remainingDevices = @(Get-OmniVirtualSpeakerRootDevices)
if ($remainingDevices.Count -ne 0) {
  throw "Failed to remove all $script:OmniVirtualSpeakerHardwareId ROOT devices: $($remainingDevices.InstanceId -join ', ')"
}
Remove-OmniVirtualSpeakerDriverPackages $pnputil

foreach ($runtimeFile in @('driver-install-state.json', 'last-source-frame.pcm', 'last-translation-frame.pcm')) {
  $path = Join-Path $RuntimeRoot $runtimeFile
  if (Test-Path -LiteralPath $path) {
    Remove-Item -LiteralPath $path -Force
  }
}

Write-Output "SYSVAD virtual audio driver state removed for $VirtualRenderDeviceId"
