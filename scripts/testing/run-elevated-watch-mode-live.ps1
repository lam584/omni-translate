[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [string]$WorkspaceRoot,
  [Parameter(Mandatory)]
  [string]$OutputLog,
  [Parameter(Mandatory)]
  [string]$RequestPath,
  [switch]$Elevated
)

$ErrorActionPreference = 'Stop'
$testTempRoot = Join-Path $WorkspaceRoot 'artifacts\testing\temp'
New-Item -ItemType Directory -Path $testTempRoot -Force | Out-Null
$env:TEMP = $testTempRoot
$env:TMP = $testTempRoot
$env:TMPDIR = $testTempRoot
$env:NPM_CONFIG_CACHE = Join-Path $testTempRoot 'npm-cache'
$env:CARGO_HOME = Join-Path $WorkspaceRoot 'artifacts\testing\cargo-home'
$env:CARGO_TARGET_DIR = Join-Path $WorkspaceRoot 'target'
$self = $MyInvocation.MyCommand.Path
if (-not $Elevated) {
  $process = Start-Process -FilePath powershell.exe -Verb RunAs -PassThru -Wait -WindowStyle Hidden `
    -WorkingDirectory $WorkspaceRoot -ArgumentList @(
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $self,
      '-WorkspaceRoot', $WorkspaceRoot,
      '-OutputLog', $OutputLog,
      '-RequestPath', $RequestPath,
      '-Elevated'
    )
  exit $process.ExitCode
}
$runner = Join-Path $WorkspaceRoot 'scripts\testing\run-watch-mode-live.ps1'
"elevated=$([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))" |
  Set-Content -LiteralPath $OutputLog -Encoding UTF8
# The runner terminates with `exit`; execute it in a child PowerShell so that
# its exit cannot bypass this wrapper's recorder cleanup below.
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $runner -RequestPath $RequestPath *>> $OutputLog
$runnerExitCode = $LASTEXITCODE

exit $runnerExitCode
