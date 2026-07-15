param(
  [string]$OutputRoot = 'artifacts/logs/testing/coverage'
)

$ErrorActionPreference = 'Stop'
$workspaceRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $workspaceRoot

function Test-IsAdministrator {
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Invoke-CoverageStep {
  param(
    [string]$Name,
    [string]$Command
  )

  $logPath = Join-Path $outputDir "$Name.log"
  Write-Host ">>> $Name`: $Command"
  # Windows PowerShell wraps any native stderr line in a NativeCommandError.
  # Test runners legitimately use stderr for warnings, so decide success from
  # the native exit code after allowing the merged stream to reach the log.
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & cmd.exe /d /s /c $Command 2>&1 | Tee-Object -FilePath $logPath
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($exitCode -ne 0) {
    throw "Coverage gate step failed: $Name"
  }
}

function Assert-RustCoverage {
  param(
    [string]$Name,
    [string]$ReportPath
  )

  $report = Get-Content -LiteralPath $ReportPath -Raw | ConvertFrom-Json
  $totals = $report.data[0].totals
  $metrics = [ordered]@{
    lines = [double]$totals.lines.percent
    functions = [double]$totals.functions.percent
    branches = [double]$totals.branches.percent
  }
  foreach ($entry in $metrics.GetEnumerator()) {
    if ($entry.Value -lt 100) {
      throw "$Name $($entry.Key) coverage is $($entry.Value)%, below 100%."
    }
  }
}

if (-not (Test-IsAdministrator)) {
  throw 'coverage:gate must run from an administrator PowerShell because the desktop-shell test executable requires elevation.'
}

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$outputDir = Join-Path $workspaceRoot (Join-Path $OutputRoot $timestamp)
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null

Invoke-CoverageStep 'desktop-frontend' 'npm run test:desktop-coverage'

$desktopShellReport = Join-Path $outputDir 'desktop-shell.json'
Invoke-CoverageStep 'desktop-shell-rust' "cargo +nightly-2026-06-01 llvm-cov --manifest-path apps/desktop/src-tauri/Cargo.toml --branch --json --output-path `"$desktopShellReport`""
Assert-RustCoverage 'desktop-shell-rust' $desktopShellReport

$nativeBridgeReport = Join-Path $outputDir 'native-bridge.json'
Invoke-CoverageStep 'native-bridge-rust' "cargo +nightly-2026-06-01 llvm-cov --manifest-path apps/bridge-service-native/Cargo.toml --branch --json --output-path `"$nativeBridgeReport`""
Assert-RustCoverage 'native-bridge-rust' $nativeBridgeReport

Write-Output $outputDir
