[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [string]$WorkspaceRoot,
  [Parameter(Mandatory)]
  [string]$OutputLog,
  [Parameter(Mandatory)]
  [string]$RunnerArgumentsJson
)

$ErrorActionPreference = 'Stop'
$runner = Join-Path $WorkspaceRoot 'scripts\testing\run-watch-mode-live.ps1'
$RunnerArguments = @($RunnerArgumentsJson | ConvertFrom-Json)
& $runner @RunnerArguments *>> $OutputLog
exit $LASTEXITCODE
