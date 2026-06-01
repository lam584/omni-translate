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
$startedAt = (Get-Date).ToUniversalTime().ToString('o')
$logPath = [System.IO.Path]::ChangeExtension($ResultPath, '.log')

function Write-OperationResult([bool]$Succeeded, [string]$Phase, [string]$ErrorCode, [string]$Summary) {
  $result = [ordered]@{
    schemaVersion = 1
    operationId = $OperationId
    action = $Action
    succeeded = $Succeeded
    phase = $Phase
    errorCode = $ErrorCode
    summary = $Summary
    logPath = $logPath
    startedAt = $startedAt
    finishedAt = (Get-Date).ToUniversalTime().ToString('o')
  }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ResultPath) | Out-Null
  [System.IO.File]::WriteAllText($ResultPath, ($result | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding($false)))
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
  if ($Action -eq 'reinstall') {
    & (Join-Path $PSScriptRoot $script) @common -Action 'rollback-driver' *> $logPath
  } else {
    & (Join-Path $PSScriptRoot $script) @common *> $logPath
  }
  Write-OperationResult $true 'completed' $null "$Action completed."
} catch {
  $_ | Out-String | Add-Content -LiteralPath $logPath
  Write-OperationResult $false 'failed' 'driver.operation-failed' $_.Exception.Message
  exit 1
}
