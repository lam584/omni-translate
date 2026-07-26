param(
  [string]$OutputRoot = "artifacts/logs/testing/quality-gate-auto",
  [switch]$SkipDesktopShell,
  [switch]$SkipBridgeService
)

$ErrorActionPreference = 'Stop'
$workspaceRoot = Resolve-Path (Join-Path $PSScriptRoot "../..");
Set-Location $workspaceRoot

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$targetDir = Join-Path $workspaceRoot (Join-Path $OutputRoot $timestamp)
New-Item -ItemType Directory -Force -Path $targetDir | Out-Null

$steps = @(
  @{ Name = "audit-architecture"; Command = "npm run audit:architecture" },
  @{ Name = "verify-desktop"; Command = "npm run verify:desktop" },
  @{ Name = "contracts"; Command = "npm run test:contracts" },
  @{ Name = "integration-bridge-contract"; Command = "npm run test:integration:bridge-contract" },
  @{ Name = "coverage-all"; Command = "npm run coverage:gate" }
)

if (-not $SkipDesktopShell) {
  $steps += @{ Name = "check-desktop-shell"; Command = "npm run check:desktop-shell" }
  $steps += @{ Name = "test-desktop-shell"; Command = "npm run test:desktop-shell" }
}

if (-not $SkipBridgeService) {
  $steps += @{ Name = "check-bridge-service-native"; Command = "npm run check:bridge-service-native" }
  $steps += @{ Name = "test-bridge-service-native"; Command = "npm run test:bridge-service-native" }
}

$results = @()
foreach ($step in $steps) {
  $logPath = Join-Path $targetDir ($step.Name + ".log")
  Write-Host ">>> $($step.Name): $($step.Command)"
  $wrappedCommand = $step.Command + ' > "' + $logPath + '" 2>&1'
  & cmd.exe /d /s /c $wrappedCommand
  # Echo the log tail via the host stream only: the success stream must stay
  # clean so callers capturing this script's output receive just the summary path.
  Get-Content -Path $logPath | Select-Object -Last 40 | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "Quality gate (auto) step failed: $($step.Name)"
  }
  $results += [ordered]@{
    name = $step.Name
    command = $step.Command
    logPath = $logPath
    status = "passed"
  }
}

$summary = [ordered]@{
  generatedAt = (Get-Date -Format s)
  workspaceRoot = $workspaceRoot.Path
  automatedResults = $results
}

$summaryPath = Join-Path $targetDir "quality-gate-auto-summary.json"
$summary | ConvertTo-Json -Depth 6 | Set-Content -Path $summaryPath -Encoding UTF8
Write-Output $summaryPath
