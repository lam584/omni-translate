[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [string]$WorkspaceRoot,
  [Parameter(Mandatory)]
  [string]$OutputLog,
  [Parameter(Mandatory)]
  [string]$RunnerArgumentsBase64,
  [switch]$Elevated
)

$ErrorActionPreference = 'Stop'
$self = $MyInvocation.MyCommand.Path
if (-not $Elevated) {
  $process = Start-Process -FilePath powershell.exe -Verb RunAs -PassThru -Wait -WindowStyle Hidden `
    -WorkingDirectory $WorkspaceRoot -ArgumentList @(
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $self,
      '-WorkspaceRoot', $WorkspaceRoot,
      '-OutputLog', $OutputLog,
      '-RunnerArgumentsBase64', $RunnerArgumentsBase64,
      '-Elevated'
    )
  exit $process.ExitCode
}
$runner = Join-Path $WorkspaceRoot 'scripts\testing\run-watch-mode-live.ps1'
$RunnerArguments = @(
  [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($RunnerArgumentsBase64)) |
    ConvertFrom-Json
)
& $runner @RunnerArguments *>> $OutputLog
exit $LASTEXITCODE
