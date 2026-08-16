[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [string]$WorkspaceRoot,
  [Parameter(Mandatory)]
  [string]$OutputLog,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$RunnerArguments
)

$ErrorActionPreference = 'Stop'
$runner = Join-Path $WorkspaceRoot 'scripts\testing\run-watch-mode-live.ps1'
& $runner @RunnerArguments *>> $OutputLog
exit $LASTEXITCODE
