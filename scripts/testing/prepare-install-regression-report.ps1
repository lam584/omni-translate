param(
  [string]$OutputRoot = "artifacts/testing/install-regression"
)

$ErrorActionPreference = 'Stop'
$workspaceRoot = Resolve-Path (Join-Path $PSScriptRoot "../..");
Set-Location $workspaceRoot

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$targetDir = Join-Path $workspaceRoot $OutputRoot
New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
$reportPath = Join-Path $targetDir ("install-regression-" + $timestamp + ".md")

$lines = @(
  "# Install Regression Report",
  "",
  "- GeneratedAt: $(Get-Date -Format s)",
  "- Operator: TODO",
  "- RuntimeRoot: ./artifacts/diagnostics/logs",
  "",
  "## Checklist",
  "",
  "1. Fresh install",
  "- [ ] Run npm run driver:install.",
  "- [ ] Confirm driver-install-state.json is updated.",
  "",
  "2. Repair",
  "- [ ] Run npm run driver:repair.",
  "- [ ] Confirm Bridge handshake can recover.",
  "",
  "3. Uninstall",
  "- [ ] Run npm run driver:uninstall.",
  "- [ ] Confirm runtime state returns to not-installed.",
  "",
  "4. Upgrade overwrite",
  "- [ ] Re-run npm run driver:install over an existing runtime root.",
  "- [ ] Confirm old backups are bounded and latest version is active.",
  "",
  "5. Release layout",
  "- [ ] Run npm run installer:prepare.",
  "- [ ] Confirm artifacts/installer/<version> contains bridge-service, scripts, and driver assets.",
  "",
  "## Final Verdict",
  "",
  "- [ ] PASS",
  "- [ ] FAIL",
  "- Notes:"
)

Set-Content -Path $reportPath -Value $lines -Encoding UTF8
Write-Output $reportPath
