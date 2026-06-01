param(
  [Parameter(Mandatory = $true)][string]$WorkspaceRoot,
  [Parameter(Mandatory = $true)][string]$RuntimeRoot,
  [Parameter(Mandatory = $true)][string]$InstallChannel,
  [Parameter(Mandatory = $true)][string]$DriverVersion,
  [Parameter(Mandatory = $true)][string]$BridgeVersion,
  [Parameter(Mandatory = $true)][string]$TargetDeviceId,
  [string]$VirtualRenderDeviceId = 'omni-virtual-speaker-default',
  [Parameter(Mandatory = $true)][string]$Action
)

$ErrorActionPreference = 'Stop'

if ($Action -eq 'rollback-driver') {
  & (Join-Path $PSScriptRoot 'uninstall-development-driver.ps1') `
    -WorkspaceRoot $WorkspaceRoot `
    -RuntimeRoot $RuntimeRoot `
    -InstallChannel $InstallChannel `
    -DriverVersion $DriverVersion `
    -BridgeVersion $BridgeVersion `
    -TargetDeviceId $TargetDeviceId `
    -VirtualRenderDeviceId $VirtualRenderDeviceId
}

& (Join-Path $PSScriptRoot 'install-development-driver.ps1') `
  -WorkspaceRoot $WorkspaceRoot `
  -RuntimeRoot $RuntimeRoot `
  -InstallChannel $InstallChannel `
  -DriverVersion $DriverVersion `
  -BridgeVersion $BridgeVersion `
  -TargetDeviceId $TargetDeviceId `
  -VirtualRenderDeviceId $VirtualRenderDeviceId
