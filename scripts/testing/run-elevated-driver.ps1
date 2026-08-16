[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [ValidateSet('install', 'test')]
  [string]$Action,
  [Parameter(Mandatory)]
  [string]$WorkspaceRoot
)

$ErrorActionPreference = 'Stop'

$installScript = Join-Path $WorkspaceRoot 'scripts\installer\install-development-driver.ps1'
$testScript = Join-Path $WorkspaceRoot 'scripts\installer\test-development-driver.ps1'
if ($Action -eq 'install') {
  $process = Start-Process -FilePath powershell.exe -Verb RunAs -PassThru -Wait -WindowStyle Hidden `
    -WorkingDirectory $WorkspaceRoot -ArgumentList @(
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $installScript,
      '-WorkspaceRoot', $WorkspaceRoot,
      '-RuntimeRoot', (Join-Path $WorkspaceRoot 'artifacts\diagnostics\logs'),
      '-InstallChannel', 'development',
      '-DriverVersion', '0.10.0-dev',
      '-BridgeVersion', '0.1.0',
      '-TargetDeviceId', 'virtual-mic-default'
    )
} else {
  $process = Start-Process -FilePath powershell.exe -Verb RunAs -PassThru -Wait -WindowStyle Hidden `
    -WorkingDirectory $WorkspaceRoot -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $testScript)
}
exit $process.ExitCode
