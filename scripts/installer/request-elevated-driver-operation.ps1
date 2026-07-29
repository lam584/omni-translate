param(
  [Parameter(Mandatory = $true)][ValidateSet('install', 'uninstall', 'reinstall')][string]$Action,
  [Parameter(Mandatory = $true)][string]$OperationId,
  [Parameter(Mandatory = $true)][string]$ResultPath,
  [Parameter(Mandatory = $true)][string]$WorkspaceRoot,
  [Parameter(Mandatory = $true)][string]$RuntimeRoot,
  [Parameter(Mandatory = $true)][string]$InstallChannel,
  [Parameter(Mandatory = $true)][string]$DriverVersion,
  [Parameter(Mandatory = $true)][string]$BridgeVersion,
  [Parameter(Mandatory = $true)][string]$TargetDeviceId,
  [string]$VirtualRenderDeviceId = 'omni-virtual-speaker-default'
)

$ErrorActionPreference = 'Stop'
# Shared preamble: normalizes the path parameters and defines $startedAt,
# $logPath and Write-DriverOperationResultFile in this script's scope.
. (Join-Path $PSScriptRoot 'driver-operation-common.ps1')
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ResultPath) | Out-Null

function Write-RequestResult([string]$ErrorCode, [string]$Summary) {
  Write-DriverOperationResultFile -ResultPath $ResultPath -LogPath $logPath `
    -OperationId $OperationId -Action $Action -StartedAt $startedAt `
    -Succeeded $false -Phase 'failed' -ErrorCode $ErrorCode -Summary $Summary
}

function Test-IsAdministrator {
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
}

$elevatedScript = Join-Path $PSScriptRoot 'invoke-elevated-driver-operation.ps1'
$arguments = @(
  '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $elevatedScript,
  '-Action', $Action, '-OperationId', $OperationId, '-ResultPath', $ResultPath,
  '-WorkspaceRoot', $WorkspaceRoot, '-RuntimeRoot', $RuntimeRoot,
  '-InstallChannel', $InstallChannel, '-DriverVersion', $DriverVersion,
  '-BridgeVersion', $BridgeVersion, '-TargetDeviceId', $TargetDeviceId,
  '-VirtualRenderDeviceId', $VirtualRenderDeviceId
)

try {
  if (Test-IsAdministrator) {
    & 'powershell.exe' @arguments
    $exitCode = $LASTEXITCODE
  } else {
    $process = Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList $arguments
    $exitCode = $process.ExitCode
  }
  if (-not (Test-Path -LiteralPath $ResultPath -PathType Leaf)) {
    Write-RequestResult 'driver.operation-failed' "Elevated driver operation exited without a result file. ExitCode=$exitCode"
  }
} catch {
  $code = if ($_.Exception.NativeErrorCode -eq 1223) { 'driver.elevation-cancelled' } else { 'driver.operation-failed' }
  Write-RequestResult $code $_.Exception.Message
}
