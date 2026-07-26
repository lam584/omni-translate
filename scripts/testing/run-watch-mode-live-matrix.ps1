param(
  [string[]]$Models = @(
    "qwen3.5-omni-flash-realtime",
    "qwen3.5-livetranslate-flash-realtime"
  ),
  [string[]]$FeedbackLoopPreventionModes = @(
    "virtual-driver",
    "echo-cancel"
  ),
  [string]$OutputRoot = "artifacts/testing/watch-mode-live",
  [string]$MediaPath = "scripts/testing/fixtures/watch-mode-en-original.wav",
  [int]$WarmupSeconds = 12,
  [int]$PlaybackSeconds = 0,
  [int]$PostPlaybackWaitSeconds = 120,
  [int]$SessionReadyTimeoutSeconds = 90,
  [switch]$SkipDesktopLaunch,
  [switch]$SkipDriverRepair,
  [switch]$AllowDriverRepair,
  [switch]$UseDefaultEndpointPlayback,
  [switch]$StopDesktopAfterPlayback,
  [switch]$AllowElevatedDesktopLaunch,
  [switch]$SkipPhysicalOutputContentStt,
  [string]$PhysicalPlaybackDeviceId = "default",
  [string]$ExpectedPhysicalPlaybackDeviceName = "",
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$RunnerArgs = @()
)

$ErrorActionPreference = 'Stop'

$workspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
Set-Location $workspaceRoot

$runScript = Join-Path $workspaceRoot "scripts/testing/run-watch-mode-live.ps1"
$modelList = @($Models | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
if ($modelList.Count -eq 0) {
  throw "At least one Watch Mode model must be provided."
}
$feedbackModeList = @($FeedbackLoopPreventionModes | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
if ($feedbackModeList.Count -eq 0) {
  throw "At least one feedback loop prevention mode must be provided."
}
foreach ($mode in $feedbackModeList) {
  if ($mode -notin @("virtual-driver", "echo-cancel")) {
    throw "Unsupported feedback loop prevention mode: $mode"
  }
}

$runDirectories = @()
foreach ($model in $modelList) {
  foreach ($feedbackMode in $feedbackModeList) {
    Write-Host "==> Running Watch Mode live strict matrix model: $model feedbackLoopPrevention: $feedbackMode"
    $runnerParameters = @{
      OutputRoot = $OutputRoot
      MediaPath = $MediaPath
      WarmupSeconds = $WarmupSeconds
      WatchModelId = $model
      PlaybackSeconds = $PlaybackSeconds
      PostPlaybackWaitSeconds = $PostPlaybackWaitSeconds
      SessionReadyTimeoutSeconds = $SessionReadyTimeoutSeconds
      PhysicalPlaybackDeviceId = $PhysicalPlaybackDeviceId
      FeedbackLoopPrevention = $feedbackMode
      ExpectedPhysicalPlaybackDeviceName = $ExpectedPhysicalPlaybackDeviceName
    }
    if ($SkipDesktopLaunch) { $runnerParameters.SkipDesktopLaunch = $true }
    if ($SkipDriverRepair) { $runnerParameters.SkipDriverRepair = $true }
    if ($AllowDriverRepair) { $runnerParameters.AllowDriverRepair = $true }
    if ($UseDefaultEndpointPlayback) { $runnerParameters.UseDefaultEndpointPlayback = $true }
    if ($StopDesktopAfterPlayback) { $runnerParameters.StopDesktopAfterPlayback = $true }
    if ($AllowElevatedDesktopLaunch) { $runnerParameters.AllowElevatedDesktopLaunch = $true }
    if ($SkipPhysicalOutputContentStt) { $runnerParameters.SkipPhysicalOutputContentStt = $true }
    $output = & $runScript @runnerParameters @RunnerArgs
    if ($LASTEXITCODE -ne 0) {
      throw "Watch Mode live run failed for model $model feedbackLoopPrevention $feedbackMode with exit code $LASTEXITCODE"
    }
    $runDirectories += @($output | Where-Object { $_ } | Select-Object -Last 1)
  }
}

Write-Host "==> Verifying strict Watch Mode evidence matrix"
node ./scripts/testing/verify-watch-mode-evidence.mjs --root $OutputRoot --strict --models ($modelList -join ",") --feedback-modes ($feedbackModeList -join ",")
if ($LASTEXITCODE -ne 0) {
  throw "strict Watch Mode evidence matrix failed with exit code $LASTEXITCODE"
}

[pscustomobject]@{
  models = $modelList
  feedbackLoopPreventionModes = $feedbackModeList
  runDirectories = $runDirectories
} | ConvertTo-Json -Depth 6
