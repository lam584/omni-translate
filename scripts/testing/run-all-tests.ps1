param(
  [switch]$SkipIntegration
)

$ErrorActionPreference = 'Stop'
$workspaceRoot = Resolve-Path (Join-Path $PSScriptRoot "../..")
Set-Location $workspaceRoot

$steps = @(
  @{ Name = "workspace-tests"; Command = "npm test --workspaces --if-present" },
  @{ Name = "desktop-shell-tests"; Command = "npm run test:desktop-shell" }
)

if (-not $SkipIntegration) {
  $steps += @{ Name = "llm-audio-integration"; Command = "npm run test:llm-integration" }
}

foreach ($step in $steps) {
  Write-Host ">>> $($step.Name): $($step.Command)"
  & cmd.exe /d /s /c $step.Command
  if ($LASTEXITCODE -ne 0) {
    throw "Test step failed: $($step.Name)"
  }
}

Write-Host "All requested tests passed."
