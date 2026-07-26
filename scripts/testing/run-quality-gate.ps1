param(
  [string]$OutputRoot = "artifacts/logs/testing/quality-gate",
  [string]$ManualE2EReport = "",
  [string]$PerformanceBaselineReport = "",
  [string]$InstallRegressionReport = "",
  [switch]$AllowPendingManual
)

$ErrorActionPreference = 'Stop'
$workspaceRoot = Resolve-Path (Join-Path $PSScriptRoot "../..");
Set-Location $workspaceRoot

# 1. Run automated quality gate first
$autoScript = Join-Path $PSScriptRoot "run-quality-gate-auto.ps1"
$autoSummaryPath = & $autoScript -OutputRoot $OutputRoot
if ($LASTEXITCODE -ne 0) {
  throw "Automated quality gate failed. See: $autoSummaryPath"
}

# 2. Generate and validate manual artifacts
$autoSummary = Get-Content -LiteralPath $autoSummaryPath -Raw | ConvertFrom-Json
$timestamp = Split-Path -Leaf (Split-Path -Parent $autoSummaryPath)
$manualRoot = Join-Path $OutputRoot $timestamp
$e2eRoot = Join-Path $manualRoot "manual-e2e"
$perfRoot = Join-Path $manualRoot "perf-baseline"
$installRoot = Join-Path $manualRoot "install-regression"

if ([string]::IsNullOrWhiteSpace($ManualE2EReport)) {
  $e2eReport = & (Join-Path $workspaceRoot "scripts/testing/prepare-manual-e2e-report.ps1") -OutputRoot $e2eRoot
} else {
  $e2eReport = (Resolve-Path -LiteralPath $ManualE2EReport).Path
}

if ([string]::IsNullOrWhiteSpace($PerformanceBaselineReport)) {
  $perfReport = & (Join-Path $workspaceRoot "scripts/testing/prepare-performance-baseline.ps1") -OutputRoot $perfRoot
} else {
  $perfReport = (Resolve-Path -LiteralPath $PerformanceBaselineReport).Path
}

if ([string]::IsNullOrWhiteSpace($InstallRegressionReport)) {
  $installReport = & (Join-Path $workspaceRoot "scripts/testing/prepare-install-regression-report.ps1") -OutputRoot $installRoot
} else {
  $installReport = (Resolve-Path -LiteralPath $InstallRegressionReport).Path
}

function Test-MarkdownManualReport {
  param([string]$ReportPath)

  $content = Get-Content -LiteralPath $ReportPath -Raw
  $issues = @()
  if ($content -match 'TODO') { $issues += 'contains TODO placeholders' }
  if ($content -match '(?m)^- Operator:\s*$') { $issues += 'operator is missing' }
  if ($content -match '(?m)^- Build:\s*$') { $issues += 'build is missing' }
  if ($content -match '(?m)^- \[ \] PASS$') { $issues += 'PASS checkbox is not selected' }
  if ($content -notmatch '(?m)^- \[[xX]\] PASS$') { $issues += 'missing selected PASS verdict' }
  if ($content -match '(?m)^- \[[xX]\] FAIL$') { $issues += 'FAIL verdict is selected' }
  if ($content -match '(?m)^- \[ \] (?!FAIL$).+') { $issues += 'contains unchecked checklist items' }
  return $issues
}

function Test-PerformanceReport {
  param([string]$ReportPath)

  $payload = Get-Content -LiteralPath $ReportPath -Raw | ConvertFrom-Json
  $issues = @()
  foreach ($property in $payload.measurements.PSObject.Properties) {
    if ($null -eq $property.Value) { $issues += "missing measurement: $($property.Name)" }
  }
  if ($payload.verdict -ne 'PASS') { $issues += 'verdict is not PASS' }
  if ([string]::IsNullOrWhiteSpace($payload.operator)) { $issues += 'operator is missing' }
  if ([string]::IsNullOrWhiteSpace($payload.build)) { $issues += 'build is missing' }
  return $issues
}

$manualArtifactResults = @(
  [ordered]@{ name = 'manual-e2e'; path = $e2eReport; status = 'passed'; issues = @(Test-MarkdownManualReport $e2eReport) },
  [ordered]@{ name = 'performance-baseline'; path = $perfReport; status = 'passed'; issues = @(Test-PerformanceReport $perfReport) },
  [ordered]@{ name = 'install-regression'; path = $installReport; status = 'passed'; issues = @(Test-MarkdownManualReport $installReport) }
)

foreach ($artifact in $manualArtifactResults) {
  if ($artifact.issues.Count -gt 0) { $artifact['status'] = 'pending' }
}

$manualVerificationStatus = if (($manualArtifactResults | Where-Object { $_.status -ne 'passed' }).Count -gt 0) { 'pending' } else { 'passed' }

# Automated integration coverage for the desktop-runtime <-> bridge contract
# (fake bridge / fake provider). These rows replace the former manual E2E
# scenarios: subtitle display, locked overlay click-through, TTS counters.
$automatedIntegration = @($autoSummary.automatedResults | Where-Object { $_.name -eq 'integration-bridge-contract' })
if ($automatedIntegration.Count -eq 0) {
  throw "Automated integration step 'integration-bridge-contract' is missing from the automated quality gate results."
}

$summary = [ordered]@{
  generatedAt = (Get-Date -Format s)
  workspaceRoot = $workspaceRoot.Path
  automatedResults = $autoSummary.automatedResults
  automatedIntegration = [ordered]@{
    name = 'integration-bridge-contract'
    status = $automatedIntegration[0].status
    logPath = $automatedIntegration[0].logPath
    coveredManualScenarios = @('subtitle-display', 'locked-overlay-click-through', 'tts-counters')
  }
  manualVerificationStatus = $manualVerificationStatus
  manualArtifacts = [ordered]@{
    e2eReport = $e2eReport
    performanceBaseline = $perfReport
    installRegression = $installReport
  }
  manualArtifactResults = $manualArtifactResults
}

$summaryPath = Join-Path (Split-Path -Parent $autoSummaryPath) "quality-gate-summary.json"
$summary | ConvertTo-Json -Depth 6 | Set-Content -Path $summaryPath -Encoding UTF8
Write-Output $summaryPath

if ($manualVerificationStatus -ne 'passed' -and -not $AllowPendingManual) {
  throw "Manual verification is pending. Fill operator/build/verdict and mark every manual checklist PASS before treating quality:gate as passed. Summary: $summaryPath"
}
