param(
  [string]$OutputRoot = "artifacts/testing/perf-baseline"
)

$ErrorActionPreference = 'Stop'
$workspaceRoot = Resolve-Path (Join-Path $PSScriptRoot "../..");
Set-Location $workspaceRoot

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$targetDir = Join-Path $workspaceRoot $OutputRoot
New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
$reportPath = Join-Path $targetDir ("desktop-perf-baseline-" + $timestamp + ".json")

$payload = [ordered]@{
  generatedAt = (Get-Date -Format s)
  environment = "Windows desktop shell"
  scenario = "Provider probe + subtitle display + speech dispatch + diagnostics export"
  thresholds = [ordered]@{
    providerFirstEventLatencyMs = 1200
    subtitleCueCommitLatencyMs = 800
    ttsRoundTripLatencyMs = 2200
    cpuP95Percent = 65
    memoryPeakMb = 900
    stabilityWindowMinutes = 30
    allowedDropouts = 0
  }
  measurements = [ordered]@{
    providerFirstEventLatencyMs = $null
    subtitleCueCommitLatencyMs = $null
    ttsRoundTripLatencyMs = $null
    cpuP95Percent = $null
    memoryPeakMb = $null
    observedDropouts = $null
  }
  notes = @(
    "Fill measurements after running the Milestone M smoke path in the desktop shell.",
    "CPU should be recorded as sample P95 and memory should use peak working set or minimum available ratio."
  )
}

$payload | ConvertTo-Json -Depth 6 | Set-Content -Path $reportPath -Encoding UTF8
Write-Output $reportPath
