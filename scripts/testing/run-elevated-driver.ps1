[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [ValidateSet('install', 'test')]
  [string]$Action,
  [Parameter(Mandatory)]
  [string]$WorkspaceRoot,
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

if (-not $Elevated) {
  $self = $MyInvocation.MyCommand.Path
  $process = Start-Process -FilePath powershell.exe -Verb RunAs -PassThru -Wait -WindowStyle Hidden `
    -WorkingDirectory $WorkspaceRoot -ArgumentList @(
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $self,
      '-Action', $Action,
      '-WorkspaceRoot', $WorkspaceRoot,
      '-Elevated'
    )
  exit $process.ExitCode
}

$installScript = Join-Path $WorkspaceRoot 'scripts\installer\install-development-driver.ps1'
$testScript = Join-Path $WorkspaceRoot 'scripts\installer\test-development-driver.ps1'
if ($Action -eq 'install') {
  & $installScript `
    -WorkspaceRoot $WorkspaceRoot `
    -RuntimeRoot (Join-Path $WorkspaceRoot 'artifacts\diagnostics\logs') `
    -InstallChannel 'development' `
    -DriverVersion '0.10.0-dev' `
    -BridgeVersion '0.1.0' `
    -TargetDeviceId 'virtual-mic-default'
} else {
  & $testScript
}
exit $LASTEXITCODE
