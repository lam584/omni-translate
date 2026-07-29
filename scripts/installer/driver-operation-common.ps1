<#
.SYNOPSIS
  Shared preamble and result-file writer for the elevated driver operation
  scripts (request-elevated-driver-operation.ps1 / invoke-elevated-driver-operation.ps1).

.DESCRIPTION
  Dot-source AFTER the param block. Because dot-sourcing runs in the caller's
  scope, the preamble below normalizes the caller's $WorkspaceRoot/$RuntimeRoot/
  $ResultPath parameters in place and defines $startedAt/$logPath exactly as the
  two scripts previously did inline. The whole scripts/installer directory is
  copied verbatim into the installer layout, so this file is always deployed
  next to its consumers.
#>

# Dot-sourced, therefore assignments land in the calling script's scope.
$ErrorActionPreference = 'Stop'
$WorkspaceRoot = (Resolve-Path -LiteralPath $WorkspaceRoot).Path
$RuntimeRoot = [System.IO.Path]::GetFullPath($RuntimeRoot)
$ResultPath = [System.IO.Path]::GetFullPath($ResultPath)
$startedAt = (Get-Date).ToUniversalTime().ToString('o')
$logPath = [System.IO.Path]::ChangeExtension($ResultPath, '.log')

function Write-DriverOperationResultFile {
  param(
    [string]$ResultPath,
    [string]$LogPath,
    [string]$OperationId,
    [string]$Action,
    [bool]$Succeeded,
    [string]$Phase,
    [string]$ErrorCode,
    [string]$Summary,
    [string]$StartedAt
  )
  $result = [ordered]@{
    schemaVersion = 1
    operationId = $OperationId
    action = $Action
    succeeded = $Succeeded
    phase = $Phase
    errorCode = $ErrorCode
    summary = $Summary
    logPath = $LogPath
    startedAt = $StartedAt
    finishedAt = (Get-Date).ToUniversalTime().ToString('o')
  }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ResultPath) | Out-Null
  [System.IO.File]::WriteAllText($ResultPath, ($result | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding($false)))
}
