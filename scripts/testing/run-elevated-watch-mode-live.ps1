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
$runnerStartedAtUtc = [DateTime]::UtcNow
$RunnerArguments = @(
  [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($RunnerArgumentsBase64)) |
    ConvertFrom-Json
)
"elevated=$([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))" |
  Set-Content -LiteralPath $OutputLog -Encoding UTF8
& $runner @RunnerArguments *>> $OutputLog
$runnerExitCode = $LASTEXITCODE

# The Node smoke coordinator may start the next single-device cell as soon as
# this elevated wrapper returns.  A recorder left behind by the runner would
# then retain the physical endpoint and corrupt that next cell's evidence.
$recorders = @(
  Get-Process -Name 'omni-physical-output-probe' -ErrorAction SilentlyContinue |
    Where-Object { $_.StartTime.ToUniversalTime() -ge $runnerStartedAtUtc.AddSeconds(-2) }
)
foreach ($recorder in $recorders) {
  Stop-Process -Id $recorder.Id -Force -ErrorAction SilentlyContinue
  $recorder.WaitForExit(5000) | Out-Null
}
$survivors = @(
  Get-Process -Name 'omni-physical-output-probe' -ErrorAction SilentlyContinue |
    Where-Object { $_.StartTime.ToUniversalTime() -ge $runnerStartedAtUtc.AddSeconds(-2) }
)
if ($survivors.Count -gt 0) {
  throw "physical-output recorder survived elevated runner cleanup: $($survivors.Id -join ',')"
}
exit $runnerExitCode
