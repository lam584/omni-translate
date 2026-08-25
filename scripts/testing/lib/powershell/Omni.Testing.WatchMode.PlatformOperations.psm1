#requires -Version 5.1

function Stop-StaleBridgeService {
  param([string]$WorkspaceRoot, [string]$RootForRuntime)
  $resolvedRuntimeRoot = if ([System.IO.Path]::IsPathRooted($RootForRuntime)) {
    $RootForRuntime
  } else {
    Join-Path $WorkspaceRoot $RootForRuntime
  }
  & (Join-Path $WorkspaceRoot 'scripts/installer/stop-stale-bridge-service.ps1') `
    -WorkspaceRoot $WorkspaceRoot -RuntimeRoot $resolvedRuntimeRoot
}

function Invoke-ElevatedDriverReinstall {
  param([string]$OutputDirectory, [Parameter(Mandatory = $true)]$Context)
  $workspaceRoot = [string]$Context.paths.workspaceRoot
  $operationId = "watch-mode-live-reinstall-$([System.Guid]::NewGuid().ToString('N'))"
  $resultPath = Join-Path $OutputDirectory 'driver-reinstall-result.json'
  & (Join-Path $workspaceRoot 'scripts/installer/request-elevated-driver-operation.ps1') `
    -Action reinstall -OperationId $operationId -ResultPath $resultPath `
    -WorkspaceRoot $workspaceRoot -RuntimeRoot ([string]$Context.paths.runtimeRoot) `
    -InstallChannel development -DriverVersion 0.10.0-dev -BridgeVersion 0.1.0 `
    -TargetDeviceId virtual-mic-default -VirtualRenderDeviceId omni-virtual-speaker-default
  if (Test-Path -LiteralPath $resultPath -PathType Leaf) {
    return Get-Content -LiteralPath $resultPath -Raw -Encoding UTF8 | ConvertFrom-Json
  }
  throw "driver.elevated-reinstall-result-missing: $resultPath"
}

Export-ModuleMember -Function 'Stop-StaleBridgeService', 'Invoke-ElevatedDriverReinstall'
