param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('INSTALL-FRESH', 'INSTALL-REPAIR', 'INSTALL-UNINSTALL', 'INSTALL-UPGRADE', 'INSTALL-RELEASE-LAYOUT')]
  [string]$ScenarioId,
  [string]$PreviousVersion = '',
  [string]$OutputRoot = '',
  [string]$CollectorOutputRoot = '',
  [int]$TimeoutMs = 1200000
)

$ErrorActionPreference = 'Stop'

function Test-IsAdministrator {
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
}

function ConvertTo-CommandLineArgument([string]$Value) {
  if ($Value -notmatch '[\s"]') { return $Value }
  return '"' + $Value.Replace('"', '\"') + '"'
}

$workspacePath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$runnerPath = Join-Path $workspacePath 'scripts\testing\run-install-release-evidence.mjs'
if (-not (Test-Path -LiteralPath $runnerPath -PathType Leaf)) {
  throw "Install release evidence runner is missing: $runnerPath"
}
if ($ScenarioId -eq 'INSTALL-UPGRADE' -and [string]::IsNullOrWhiteSpace($PreviousVersion)) {
  throw 'INSTALL-UPGRADE requires -PreviousVersion.'
}
if ($ScenarioId -ne 'INSTALL-UPGRADE' -and -not [string]::IsNullOrWhiteSpace($PreviousVersion)) {
  throw '-PreviousVersion is accepted only for INSTALL-UPGRADE.'
}
if ($TimeoutMs -lt 60000 -or $TimeoutMs -gt 3600000) {
  throw '-TimeoutMs must be between 60000 and 3600000.'
}

$nodeCommand = Get-Command node.exe -ErrorAction Stop
$nodeArguments = @($runnerPath, '--scenario-id', $ScenarioId, '--timeout-ms', [string]$TimeoutMs)
if (-not [string]::IsNullOrWhiteSpace($PreviousVersion)) {
  $nodeArguments += @('--previous-version', $PreviousVersion)
}
if (-not [string]::IsNullOrWhiteSpace($OutputRoot)) {
  $nodeArguments += @('--output-root', $OutputRoot)
}
if (-not [string]::IsNullOrWhiteSpace($CollectorOutputRoot)) {
  $nodeArguments += @('--collector-output-root', $CollectorOutputRoot)
}

if ($ScenarioId -eq 'INSTALL-RELEASE-LAYOUT' -or (Test-IsAdministrator)) {
  & $nodeCommand.Source @nodeArguments
  exit $LASTEXITCODE
}

$argumentLine = ($nodeArguments | ForEach-Object { ConvertTo-CommandLineArgument ([string]$_) }) -join ' '
try {
  $elevated = Start-Process `
    -FilePath $nodeCommand.Source `
    -ArgumentList $argumentLine `
    -WorkingDirectory $workspacePath `
    -Verb RunAs `
    -Wait `
    -PassThru
} catch {
  throw "Install release evidence elevation was cancelled or failed: $($_.Exception.Message)"
}
if (-not $elevated -or $elevated.ExitCode -ne 0) {
  throw "Elevated install release evidence runner failed. ExitCode=$($elevated.ExitCode)"
}
