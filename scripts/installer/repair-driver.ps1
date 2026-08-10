param(
  [Parameter(Mandatory = $true)][string]$WorkspaceRoot,
  [Parameter(Mandatory = $true)][string]$RuntimeRoot,
  [Parameter(Mandatory = $true)][ValidateSet('development', 'release')][string]$InstallChannel,
  [Parameter(Mandatory = $true)][string]$DriverVersion,
  [Parameter(Mandatory = $true)][string]$BridgeVersion,
  [Parameter(Mandatory = $true)][string]$TargetDeviceId,
  [string]$VirtualRenderDeviceId = 'omni-virtual-speaker-default',
  [string]$DevconPath = '',
  [Parameter(Mandatory = $true)][string]$Action
)

$ErrorActionPreference = 'Stop'

$common = @{
  WorkspaceRoot = $WorkspaceRoot
  RuntimeRoot = $RuntimeRoot
  InstallChannel = $InstallChannel
  DriverVersion = $DriverVersion
  BridgeVersion = $BridgeVersion
  TargetDeviceId = $TargetDeviceId
  VirtualRenderDeviceId = $VirtualRenderDeviceId
}

if ($InstallChannel -eq 'release') {
  & (Join-Path $PSScriptRoot 'install-development-driver.ps1') @common -DevconPath $DevconPath -ValidatePackageOnly
}

if ($Action -eq 'rollback-driver' -or $Action -eq 'reinstall-driver') {
  & (Join-Path $PSScriptRoot 'uninstall-development-driver.ps1') @common
}

& (Join-Path $PSScriptRoot 'install-development-driver.ps1') @common -DevconPath $DevconPath
