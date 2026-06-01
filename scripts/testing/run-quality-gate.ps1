param(
  [string]$OutputRoot = "artifacts/testing/quality-gate"
)

$ErrorActionPreference = 'Stop'
$workspaceRoot = Resolve-Path (Join-Path $PSScriptRoot "../..");
Set-Location $workspaceRoot

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$targetDir = Join-Path $workspaceRoot (Join-Path $OutputRoot $timestamp)
New-Item -ItemType Directory -Force -Path $targetDir | Out-Null

$steps = @(
  @{ Name = "verify-desktop"; Command = "npm run verify:desktop" },
  @{ Name = "coverage-all"; Command = "npm run coverage:gate" },
  @{ Name = "check-desktop-shell"; Command = "npm run check:desktop-shell" },
  @{ Name = "test-desktop-shell"; Command = "npm run test:desktop-shell" },
  @{ Name = "check-bridge-service"; Command = "npm run check:bridge-service" },
  @{ Name = "test-bridge-service"; Command = "npm run test:bridge-service" },
  @{ Name = "check-bridge-service-native"; Command = "npm run check:bridge-service-native" },
  @{ Name = "test-bridge-service-native"; Command = "npm run test:bridge-service-native" }
)

$results = @()
foreach ($step in $steps) {
  $logPath = Join-Path $targetDir ($step.Name + ".log")
  Write-Host ">>> $($step.Name): $($step.Command)"
  $wrappedCommand = $step.Command + ' > "' + $logPath + '" 2>&1'
  & cmd.exe /d /s /c $wrappedCommand
  Get-Content -Path $logPath | Select-Object -Last 40
  if ($LASTEXITCODE -ne 0) {
    throw "Quality gate step failed: $($step.Name)"
  }
  $results += [ordered]@{
    name = $step.Name
    command = $step.Command
    logPath = $logPath
    status = "passed"
  }
}

$manualRoot = Join-Path $OutputRoot $timestamp
$e2eRoot = Join-Path $manualRoot "manual-e2e"
$perfRoot = Join-Path $manualRoot "perf-baseline"
$installRoot = Join-Path $manualRoot "install-regression"

$e2eReport = & (Join-Path $workspaceRoot "scripts/testing/prepare-manual-e2e-report.ps1") -OutputRoot $e2eRoot
$perfReport = & (Join-Path $workspaceRoot "scripts/testing/prepare-performance-baseline.ps1") -OutputRoot $perfRoot
$installReport = & (Join-Path $workspaceRoot "scripts/testing/prepare-install-regression-report.ps1") -OutputRoot $installRoot

$summary = [ordered]@{
  generatedAt = (Get-Date -Format s)
  workspaceRoot = $workspaceRoot.Path
  automatedResults = $results
  manualArtifacts = [ordered]@{
    e2eReport = $e2eReport
    performanceBaseline = $perfReport
    installRegression = $installReport
  }
}

$summaryPath = Join-Path $targetDir "quality-gate-summary.json"
$summary | ConvertTo-Json -Depth 6 | Set-Content -Path $summaryPath -Encoding UTF8
Write-Output $summaryPath
