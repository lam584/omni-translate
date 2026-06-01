param(
  [string]$OutputRoot = "artifacts/testing/manual-e2e"
)

$ErrorActionPreference = 'Stop'
$workspaceRoot = Resolve-Path (Join-Path $PSScriptRoot "../..");
Set-Location $workspaceRoot

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$targetDir = Join-Path $workspaceRoot $OutputRoot
New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
$reportPath = Join-Path $targetDir ("desktop-e2e-" + $timestamp + ".md")

$lines = @(
  "# Desktop E2E Smoke Report",
  "",
  "- GeneratedAt: $(Get-Date -Format s)",
  "- Operator: TODO",
  "- Build: TODO",
  "- Environment: Windows desktop shell",
  "",
  "## Preflight",
  "",
  "1. Run npm run verify:desktop.",
  "2. Run npm run quality:desktop-shell.",
  "3. Run npm run test:bridge-service.",
  "",
  "## Scenario Checklist",
  "",
  "1. Provider configuration",
  "- [ ] Save Provider config and secret reference successfully.",
  "- Result:",
  "",
  "2. Provider probe",
  "- [ ] Run probe and confirm verdict, transport, and guidance are populated.",
  "- Result:",
  "",
  "3. Subtitle display",
  "- [ ] Start inbound or outbound capture and confirm recent subtitle cues appear in main window or overlay.",
  "- Result:",
  "",
  "4. TTS outbound",
  "- [ ] Trigger speech dispatch and confirm speaker or virtual-mic counters advance.",
  "- Result:",
  "",
  "5. Diagnostics export",
  "- [ ] Run diagnostics self-check and export a full diagnostics bundle.",
  "- Result:",
  "",
  "## Artifacts",
  "",
  "- Diagnostics bundle path:",
  "- Screenshot or notes:",
  "",
  "## Final Verdict",
  "",
  "- [ ] PASS",
  "- [ ] FAIL",
  "- Notes:"
)

Set-Content -Path $reportPath -Value $lines -Encoding UTF8
Write-Output $reportPath
