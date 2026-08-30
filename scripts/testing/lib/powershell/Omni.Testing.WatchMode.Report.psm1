Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.IO.psm1') -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.Process.psm1') -DisableNameChecking

function Read-WatchJsonSnapshot {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Label)
  try {
    $item = Get-Item -LiteralPath $Path -ErrorAction Stop
    if (-not $item.PSIsContainer -and (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0)) {
      $bytes = [System.IO.File]::ReadAllBytes($item.FullName)
    } else {
      throw "$Label must be a regular non-reparse file"
    }
    if ($bytes.LongLength -le 0) { throw "$Label is empty" }
    $text = [System.Text.UTF8Encoding]::new($false, $true).GetString($bytes)
    if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
    $json = $text | ConvertFrom-Json
    return [pscustomobject]@{ bytes = $bytes; json = $json; path = $item.FullName }
  } catch {
    throw "$Label is invalid JSON at '$Path': $($_.Exception.Message)"
  }
}

function Get-WatchBytesSha256 {
  param([Parameter(Mandatory = $true)][byte[]]$Bytes)
  $algorithm = [System.Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($algorithm.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
  finally { $algorithm.Dispose() }
}

function Get-WatchProcessStartUnixMs {
  param([Parameter(Mandatory = $true)][long]$StartTimeUtcTicks)
  try {
    $started = [DateTime]::new($StartTimeUtcTicks, [DateTimeKind]::Utc)
    return [DateTimeOffset]::new($started).ToUnixTimeMilliseconds()
  } catch {
    throw "process custody startTimeUtcTicks is invalid: $StartTimeUtcTicks"
  }
}

function Assert-WatchSessionReportFile {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "required Watch session report was not generated: $Path"
  }
  $report = (Read-WatchJsonSnapshot -Path $Path -Label 'required Watch session report').json
  if ($null -eq $report -or -not $report.sessionId) {
    throw "required Watch session report is empty or missing sessionId: $Path"
  }
  if ($report.status -ne 'completed') {
    throw "required Watch session report is not completed at '$Path': status=$($report.status)"
  }
  return $report
}

function Assert-WatchTerminalAuthorityFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$ReportPath,
    [Parameter(Mandatory = $true)]$ProcessLease,
    [Parameter(Mandatory = $true)][string]$RunMarker,
    [Parameter(Mandatory = $true)][string]$CellId,
    [Parameter(Mandatory = $true)][string]$LeaseId,
    [Parameter(Mandatory = $true)][string]$SourceHeadCommit,
    [Parameter(Mandatory = $true)][string]$RuntimeBundleDigest
  )
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "required evidence-driven terminal authority was not generated: $Path"
  }
  $terminal = (Read-WatchJsonSnapshot -Path $Path -Label 'required evidence-driven terminal authority').json
  if ($terminal.artifactKind -cne 'watch-mode-evidence-driven-terminal' -or
      [int]$terminal.schemaVersion -ne 2 -or $terminal.status -cne 'completed') {
    throw "evidence-driven terminal authority is not a completed v2 authority: $Path"
  }
  foreach ($binding in @(
    @('runMarker', [string]$terminal.runMarker, $RunMarker),
    @('cellId', [string]$terminal.cellId, $CellId),
    @('leaseId', [string]$terminal.leaseId, $LeaseId),
    @('launchId', [string]$terminal.launchId, [string]$ProcessLease.launchId)
  )) {
    if ($binding[1] -cne $binding[2]) {
      throw "evidence-driven terminal $($binding[0]) does not match this launch: expected=$($binding[2]) observed=$($binding[1])"
    }
  }
  $expectedProducerStartedAtUnixMs = Get-WatchProcessStartUnixMs -StartTimeUtcTicks ([long]$ProcessLease.startTimeUtcTicks)
  if ([int]$terminal.producerProcessId -ne [int]$ProcessLease.pid -or
      [int64]$terminal.producerStartTimeUtcTicks -ne [int64]$ProcessLease.startTimeUtcTicks -or
      [int64]$terminal.producerStartedAtUnixMs -ne $expectedProducerStartedAtUnixMs -or
      [int64]$terminal.startedAtUnixMs -lt $expectedProducerStartedAtUnixMs -or
      [string]$terminal.producerExecutableSha256 -cne [string]$ProcessLease.executableSha256 -or
      [string]$terminal.sourceHeadCommit -cne $SourceHeadCommit -or
      [string]$terminal.runtimeBundleDigest -cne $RuntimeBundleDigest) {
    throw 'evidence-driven terminal producer identity is incomplete or does not match the custodied desktop process'
  }
  $events = @($terminal.events)
  $requiredStages = @(
    'mediaPlaybackCompleted', 'inputCompleteSignaled', 'inputCompleteObserved',
    'lastProviderAppend', 'sessionFinishSent', 'sessionFinishedReceived',
    'localPlaybackQuiescent', 'finalRendererAck', 'reportWritten'
  )
  if ($events.Count -ne 10) { throw 'evidence-driven terminal requires exactly ten raw owner stages' }
  $startedAt = [int64]$terminal.startedAtUnixMs
  $completedAt = [int64]$terminal.completedAtUnixMs
  if ($startedAt -le 0 -or $completedAt -lt $startedAt) {
    throw 'evidence-driven terminal startedAt/completedAt boundary is invalid'
  }
  $seenStages = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  $previousAt = $startedAt
  for ($index = 0; $index -lt $events.Count; $index++) {
    $event = $events[$index]
    $observedAt = [int64]$event.observedAtUnixMs
    if ([int64]$event.sequence -ne ($index + 1) -or $observedAt -lt $previousAt -or $observedAt -gt $completedAt) {
      throw "evidence-driven terminal event $($index + 1) is non-contiguous or outside startedAt/completedAt"
    }
    if (-not $seenStages.Add([string]$event.stage)) {
      throw "evidence-driven terminal contains duplicate stage: $($event.stage)"
    }
    $previousAt = $observedAt
  }
  foreach ($stage in $requiredStages) {
    if (-not $seenStages.Contains($stage)) { throw "evidence-driven terminal is missing raw stage $stage" }
  }
  $responseStageCount = @('lastResponseAudioDone', 'responseDone').Where({ $seenStages.Contains($_) }).Count
  if ($responseStageCount -ne 1 -or $seenStages.Count -ne 10) {
    throw 'evidence-driven terminal requires exactly one response terminal stage and no unknown stages'
  }
  if ([string]$events[-1].stage -cne 'reportWritten') {
    throw 'evidence-driven terminal reportWritten must be unique and final'
  }
  $detail = $events[-1].detail
  if ([string]$detail.reportPath -cne 'watch-session-report.json') {
    throw "evidence-driven terminal reportPath must be the canonical basename watch-session-report.json: $($detail.reportPath)"
  }
  $actualReportPath = [System.IO.Path]::GetFullPath($ReportPath)
  $boundReportPath = [System.IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $Path) ([string]$detail.reportPath)))
  if (-not $actualReportPath.Equals($boundReportPath, [StringComparison]::OrdinalIgnoreCase)) {
    throw "evidence-driven terminal report path does not match this run: $boundReportPath"
  }
  $reportSnapshot = Read-WatchJsonSnapshot -Path $actualReportPath -Label 'terminal-bound Watch session report'
  $actualHash = Get-WatchBytesSha256 -Bytes $reportSnapshot.bytes
  if ([int64]$detail.byteLength -ne [int64]$reportSnapshot.bytes.LongLength -or
      [string]$detail.sha256 -cne $actualHash) {
    throw "evidence-driven terminal report byte length or SHA-256 does not match the durable report bytes: expectedBytes=$($detail.byteLength) actualBytes=$($reportSnapshot.bytes.LongLength) expectedSha256=$($detail.sha256) actualSha256=$actualHash"
  }
  if ([string]$reportSnapshot.json.status -cne 'completed') { throw 'terminal-bound Watch session report is not completed' }
  return $terminal
}

function Get-WatchFailedTerminalAuthority {
  param(
    [string]$Path,
    [Parameter(Mandatory = $true)]$ProcessLease,
    [Parameter(Mandatory = $true)][string]$RunMarker,
    [Parameter(Mandatory = $true)][string]$CellId,
    [Parameter(Mandatory = $true)][string]$LeaseId,
    [Parameter(Mandatory = $true)][string]$SourceHeadCommit,
    [Parameter(Mandatory = $true)][string]$RuntimeBundleDigest
  )
  if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return $null
  }
  try {
    $terminal = (Read-WatchJsonSnapshot -Path $Path -Label 'failed evidence-driven terminal authority').json
  } catch {
    return $null
  }
  if ($terminal.artifactKind -cne 'watch-mode-evidence-driven-terminal' -or
      [int]$terminal.schemaVersion -ne 2 -or $terminal.status -cne 'failed' -or
      [string]$terminal.runMarker -cne $RunMarker -or
      [string]$terminal.cellId -cne $CellId -or
      [string]$terminal.leaseId -cne $LeaseId -or
      [string]$terminal.launchId -cne [string]$ProcessLease.launchId -or
      [int]$terminal.producerProcessId -ne [int]$ProcessLease.pid -or
      [int64]$terminal.producerStartTimeUtcTicks -ne [int64]$ProcessLease.startTimeUtcTicks -or
      [int64]$terminal.producerStartedAtUnixMs -ne (Get-WatchProcessStartUnixMs -StartTimeUtcTicks ([long]$ProcessLease.startTimeUtcTicks)) -or
      [string]$terminal.producerExecutableSha256 -cne [string]$ProcessLease.executableSha256 -or
      [string]$terminal.sourceHeadCommit -cne $SourceHeadCommit -or
      [string]$terminal.runtimeBundleDigest -cne $RuntimeBundleDigest -or
      [string]::IsNullOrWhiteSpace([string]$terminal.errorCode)) {
    return $null
  }
  return $terminal
}

function Wait-WatchSessionReportAndDesktopExit {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)]$ProcessLease,
    [string]$TerminalAuthorityPath,
    [string]$RunMarker,
    [string]$CellId,
    [string]$LeaseId,
    [string]$SourceHeadCommit,
    [string]$RuntimeBundleDigest,
    [Parameter(Mandatory = $true)][DateTime]$DeadlineUtc
  )
  $exit = Wait-OmniManagedProcessExit -Lease $ProcessLease -DeadlineUtc $DeadlineUtc
  $failedTerminal = $null
  if (-not [string]::IsNullOrWhiteSpace($TerminalAuthorityPath)) {
    $failedTerminal = Get-WatchFailedTerminalAuthority -Path $TerminalAuthorityPath `
      -ProcessLease $ProcessLease -RunMarker $RunMarker -CellId $CellId -LeaseId $LeaseId `
      -SourceHeadCommit $SourceHeadCommit -RuntimeBundleDigest $RuntimeBundleDigest
  }
  if ($null -ne $failedTerminal) {
    throw "custodied Watch desktop terminal failed: exitCode=$($exit.exitCode) terminalErrorCode=$($failedTerminal.errorCode) terminalError=$($failedTerminal.error) pid=$($exit.pid) launchId=$($exit.launchId)"
  }
  if ([int]$exit.exitCode -ne 0) {
    throw "custodied Watch desktop exited with exit code $($exit.exitCode): pid=$($exit.pid) launchId=$($exit.launchId)"
  }
  if (-not [string]::IsNullOrWhiteSpace($TerminalAuthorityPath)) {
    Assert-WatchTerminalAuthorityFile -Path $TerminalAuthorityPath -ReportPath $Path `
      -ProcessLease $ProcessLease -RunMarker $RunMarker -CellId $CellId -LeaseId $LeaseId `
      -SourceHeadCommit $SourceHeadCommit -RuntimeBundleDigest $RuntimeBundleDigest | Out-Null
  }
  Assert-WatchSessionReportFile $Path | Out-Null
  return [pscustomobject]@{
    reportPath = $Path; terminalAuthorityPath = $TerminalAuthorityPath; desktopExited = $true
    exitCode = 0; pid = [int]$exit.pid; launchId = [string]$exit.launchId
  }
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
  'Assert-WatchTerminalAuthorityFile',
  'Wait-WatchSessionReportAndDesktopExit',
  'Get-WatchSessionReportDeadlineUtc',
  'Invoke-WatchModeReportGenerator'
)
