Set-StrictMode -Version Latest

function Assert-WatchSessionReportFile {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "required Watch session report was not generated: $Path"
  }
  try {
    $report = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    throw "required Watch session report is invalid JSON at '$Path': $($_.Exception.Message)"
  }
  if ($null -eq $report -or -not $report.sessionId) {
    throw "required Watch session report is empty or missing sessionId: $Path"
  }
  if ($report.status -ne 'completed') {
    throw "required Watch session report is not completed at '$Path': status=$($report.status)"
  }
  return $report
}

function Wait-WatchSessionReportAndDesktopExit {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][DateTime]$DeadlineUtc
  )
  do {
    $reportReady = Test-Path -LiteralPath $Path -PathType Leaf
    $desktopRunning = $null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
    if ($reportReady -and -not $desktopRunning) {
      Assert-WatchSessionReportFile $Path | Out-Null
      return [pscustomobject]@{ reportPath = $Path; desktopExited = $true }
    }
    if (-not $desktopRunning -and -not $reportReady) {
      throw "Watch desktop exited before writing the required session report: $Path"
    }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $DeadlineUtc)

  throw "timed out waiting for same-process Watch report and desktop exit. ProcessId=$ProcessId ReportReady=$reportReady DeadlineUtc=$($DeadlineUtc.ToString('o')) Path=$Path"
}

function Get-WatchSessionReportDeadlineUtc {
  param(
    [Parameter(Mandatory = $true)][DateTime]$LaunchedAtUtc,
    [Parameter(Mandatory = $true)][int]$ReadyTimeoutSeconds,
    [Parameter(Mandatory = $true)][int]$AutoStopAfterSeconds,
    [int]$CompletionGraceSeconds = 120
  )
  return $LaunchedAtUtc.AddSeconds($ReadyTimeoutSeconds + $AutoStopAfterSeconds + $CompletionGraceSeconds)
}

function Write-LatestWatchModeSummary {
  param([Parameter(Mandatory = $true)][string]$RunDirectory)
  $reportPath = Join-Path $RunDirectory 'report.json'
  if (-not (Test-Path -LiteralPath $reportPath -PathType Leaf)) {
    throw "watch-mode report was not generated: $reportPath"
  }
  $report = Get-Content -LiteralPath $reportPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $summaryPath = Join-Path (Split-Path -Parent $RunDirectory) 'latest-watch-mode-live.json'
  [ordered]@{
    timestamp = Split-Path -Leaf $RunDirectory
    reportPath = $reportPath
    verdict = $report.verdict
    failureLayer = $report.failureLayer
    modelId = $report.modelId
    feedbackLoopPrevention = $report.feedbackLoopPrevention
  } | ConvertTo-Json -Depth 4 | Set-Content -Path $summaryPath -Encoding UTF8
}

function Invoke-WatchModeReportGenerator {
  param(
    [Parameter(Mandatory = $true)][string]$InputDirectory,
    [Parameter(Mandatory = $true)][ValidateSet('dry-run', 'live')][string]$Mode,
    [Parameter(Mandatory = $true)][string]$WorkspaceRoot
  )
  node (Join-Path $WorkspaceRoot 'scripts/testing/watch-mode-report.mjs') --input $InputDirectory --output $InputDirectory --mode $Mode
  if ($LASTEXITCODE -ne 0) { throw "watch-mode report generator failed with exit code $LASTEXITCODE" }
  node (Join-Path $WorkspaceRoot 'scripts/testing/watch-mode-score.mjs') --input $InputDirectory
  if ($LASTEXITCODE -ne 0) { throw "watch-mode benchmark scorer failed with exit code $LASTEXITCODE" }
  if ($Mode -eq 'live') { Write-LatestWatchModeSummary $InputDirectory }
}

Export-ModuleMember -Function @(
  'Assert-WatchSessionReportFile',
  'Wait-WatchSessionReportAndDesktopExit',
  'Get-WatchSessionReportDeadlineUtc',
  'Invoke-WatchModeReportGenerator'
)
