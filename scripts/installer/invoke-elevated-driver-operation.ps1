param(
  [Parameter(Mandatory = $true)][ValidateSet('install', 'uninstall', 'reinstall')][string]$Action,
  [Parameter(Mandatory = $true)][string]$OperationId,
  [Parameter(Mandatory = $true)][string]$ResultPath,
  [Parameter(Mandatory = $true)][string]$WorkspaceRoot,
  [Parameter(Mandatory = $true)][string]$RuntimeRoot,
  [Parameter(Mandatory = $true)][ValidateSet('development', 'release')][string]$InstallChannel,
  [Parameter(Mandatory = $true)][string]$DriverVersion,
  [Parameter(Mandatory = $true)][string]$BridgeVersion,
  [Parameter(Mandatory = $true)][string]$TargetDeviceId,
  [string]$VirtualRenderDeviceId = 'omni-virtual-speaker-default',
  [long]$RequestProcessId = 0,
  [ValidateSet('already-elevated', 'uac-runas', 'unknown')][string]$ElevationMode = 'unknown'
)

$ErrorActionPreference = 'Stop'
# Shared preamble: normalizes the path parameters and defines $startedAt,
# $logPath and Write-DriverOperationResultFile in this script's scope.
. (Join-Path $PSScriptRoot 'driver-operation-common.ps1')

function Write-OperationResult([bool]$Succeeded, [string]$Phase, [string]$ErrorCode, [string]$Summary) {
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
  $isElevated = $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
  Write-DriverOperationResultFile -ResultPath $ResultPath -LogPath $logPath `
    -OperationId $OperationId -Action $Action -StartedAt $startedAt `
    -Succeeded $Succeeded -Phase $Phase -ErrorCode $ErrorCode -Summary $Summary `
    -RequestProcessId $RequestProcessId -ElevatedProcessId $PID -Elevated $isElevated `
    -ElevationMode $ElevationMode -InstallChannel $InstallChannel `
    -DriverVersion $DriverVersion -BridgeVersion $BridgeVersion
}

function Get-DriverOperationErrorCode([string]$Message) {
  if ($Message -match 'CM_PROB_FAILED_START|CM_PROB_NEED_RESTART|pending system reboot|requires reboot|need restart') {
    return 'driver.reboot-required'
  }
  if ($Message -match 'WASAPI audio probe failed') {
    return 'driver.audio-probe-failed'
  }
  return 'driver.operation-failed'
}

try {
  $common = @{
    WorkspaceRoot = $WorkspaceRoot
    RuntimeRoot = $RuntimeRoot
    InstallChannel = $InstallChannel
    DriverVersion = $DriverVersion
    BridgeVersion = $BridgeVersion
    TargetDeviceId = $TargetDeviceId
    VirtualRenderDeviceId = $VirtualRenderDeviceId
  }
  $script = switch ($Action) {
    'install' { 'install-development-driver.ps1' }
    'uninstall' { 'uninstall-development-driver.ps1' }
    'reinstall' { 'repair-driver.ps1' }
  }
  if ($InstallChannel -eq 'release') {
    # Fail closed on the stable package before any install, repair, or uninstall
    # action is allowed to mutate PnP/DriverStore/runtime state.
    & (Join-Path $PSScriptRoot 'install-development-driver.ps1') @common -ValidatePackageOnly *> $logPath
  }
  if ($Action -eq 'reinstall') {
    & (Join-Path $PSScriptRoot $script) @common -Action 'rollback-driver' *> $logPath
  } else {
    & (Join-Path $PSScriptRoot $script) @common *> $logPath
  }
  Write-OperationResult $true 'completed' $null "$Action completed."
} catch {
  $_ | Out-String | Add-Content -LiteralPath $logPath
  Write-OperationResult $false 'failed' (Get-DriverOperationErrorCode $_.Exception.Message) $_.Exception.Message
  exit 1
}
