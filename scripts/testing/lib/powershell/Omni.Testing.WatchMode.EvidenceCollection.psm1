#requires -Version 5.1
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.IO.psm1')
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.Report.psm1') -DisableNameChecking
function Copy-IfExists {
  param([string]$Source, [string]$Destination)
  if (Test-Path -LiteralPath $Source -PathType Leaf) {
    Copy-Item -LiteralPath $Source -Destination $Destination -Force
    return $Destination
  }
  return $null
}
function Get-WatchModeDesktopAppLogPath {
  $localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
  if ([string]::IsNullOrWhiteSpace($localAppData)) { throw 'LocalApplicationData is unavailable for the release desktop log.' }
  return Join-Path $localAppData 'OmniTranslate\diagnostics\logs\app.log'
}
function Copy-WatchModeAppLog {
  param(
    [Parameter(Mandatory = $true)][string]$SourcePath,
    [Parameter(Mandatory = $true)][string]$DestinationPath,
    [Parameter(Mandatory = $true)][string]$RunMarker
  )
  $directory = Split-Path -Parent $SourcePath
  $rotatedPath = Join-Path $directory 'app.1.log'
  $parts = @()
  if (Test-Path -LiteralPath $rotatedPath -PathType Leaf) {
    $parts += [System.IO.File]::ReadAllText($rotatedPath, [System.Text.Encoding]::UTF8)
  }
  if (Test-Path -LiteralPath $SourcePath -PathType Leaf) {
    $parts += [System.IO.File]::ReadAllText($SourcePath, [System.Text.Encoding]::UTF8)
  }
  $combined = ($parts -join '') -replace "`r`n", "`n"
  $markerLine = "`n$RunMarker`n"
  $markerIndex = ("`n$combined").LastIndexOf($markerLine, [System.StringComparison]::Ordinal)
  if ($markerIndex -lt 0) { return $null }
  $scoped = ("`n$combined").Substring($markerIndex + 1)
  [System.IO.File]::WriteAllText($DestinationPath, $scoped, [System.Text.UTF8Encoding]::new($false))
  return $DestinationPath
}
function Save-WatchModeRunArtifacts {
  param(
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    $PlaybackStep,
    [Parameter(Mandatory = $true)][string]$RunMarker,
    [Parameter(Mandatory = $true)][string]$StartedAtLocal,
    [Parameter(Mandatory = $true)]$Context,
    [Parameter(Mandatory = $true)]$Request,
    [Parameter(Mandatory = $true)]$State
  )
  $runtimePath = Resolve-Path -LiteralPath $Context.paths.runtimeRoot -ErrorAction SilentlyContinue
  $appLogSource = Get-WatchModeDesktopAppLogPath
  $bridgeLogSource = if ($runtimePath) { Join-Path $runtimePath.Path "bridge-service.log" } else { Join-Path $Context.paths.runtimeRoot "bridge-service.log" }
  $appLogTarget = Copy-WatchModeAppLog -SourcePath $appLogSource `
    -DestinationPath (Join-Path $OutputDirectory "app.log") -RunMarker $RunMarker
  $bridgeLogTarget = Copy-IfExists $bridgeLogSource (Join-Path $OutputDirectory "bridge-service.log")
  if (-not $appLogTarget) {
    "" | Set-Content -Path (Join-Path $OutputDirectory "app.log") -Encoding UTF8
  }
  if (-not $bridgeLogTarget) {
    "" | Set-Content -Path (Join-Path $OutputDirectory "bridge-service.log") -Encoding UTF8
  }
  $playbackSnapshot = if ($PlaybackStep -and $PlaybackStep.status -eq 'passed') { $PlaybackStep.data } else { $null }
  if ($playbackSnapshot) {
    $playbackSnapshot | ConvertTo-Json -Depth 12 | Set-Content -Path (Join-Path $OutputDirectory "playback.json") -Encoding UTF8
  }
  $physicalContentStep = @($State.steps | Where-Object {
    $_.id -eq "transcribe-and-compare-physical-output-content"
  } | Select-Object -Last 1)
  if (
    $physicalContentStep -and
    $physicalContentStep.data -and
    $physicalContentStep.data.skipped
  ) {
    $physicalContentStep.data | ConvertTo-Json -Depth 12 | Set-Content `
      -Path (Join-Path $OutputDirectory "physical-output-content.raw.json") -Encoding UTF8
  }
  Write-OmniJsonAtomic -LiteralPath (Join-Path $OutputDirectory 'run-metadata.json') -Value ([pscustomobject]@{
    schemaVersion = 'watch-mode-run-metadata/v1'
    runMarker = $RunMarker
    startedAtLocal = $StartedAtLocal
    modelId = $Context.model.id
    feedbackMode = $Context.audioRoute
  }) -Depth 6
  $serializableSteps = @($State.steps | ForEach-Object {
    [pscustomobject]@{
      schemaVersion = $_.schemaVersion
      id = $_.id
      phase = $_.phase
      status = $_.status
      startedAt = $_.startedAt
      endedAt = $_.endedAt
      durationMs = $_.durationMs
      data = $_.data
      error = $_.error
    }
  })
  $artifactCandidates = [ordered]@{
    appLog = 'app.log'
    bridgeLog = 'bridge-service.log'
    runMetadata = 'run-metadata.json'
    runtimeStatus = 'watch-runtime-status.json'
    driverProbe = 'driver.json'
    bridgeSourceProbe = 'bridge-source-probe.json'
    physicalOutputProbe = 'physical-output-probe.json'
    physicalPlaybackDevice = 'physical-playback-device.json'
    playback = 'playback.json'
    watchSessionReport = 'watch-session-report.json'
    sourceMediaTranscript = 'source-media-transcript.json'
    physicalOutputSttRaw = 'physical-output-stt.raw.json'
    physicalOutputContentRaw = 'physical-output-content.raw.json'
    physicalOutputRecording = 'physical-output-recording.wav'
    audioAnalysis = 'audio-analysis.json'
    systemMetrics = 'system-metrics.json'
    externalProviderBudget = 'external-provider-budget.json'
  }
  $artifacts = [ordered]@{}
  foreach ($entry in $artifactCandidates.GetEnumerator()) {
    $candidatePath = Join-Path $OutputDirectory $entry.Value
    $artifacts[$entry.Key] = if (Test-Path -LiteralPath $candidatePath -PathType Leaf) { $entry.Value } else { $null }
  }
  Write-OmniJsonAtomic -LiteralPath (Join-Path $OutputDirectory 'run-collection.json') -Value ([pscustomobject]@{
    schemaVersion = 'watch-mode-run-collection/v2'
    artifactKind = 'watch-mode-run-collection'
    request = $Request
    collectionStatus = if ($State.primaryError) { 'failed' } else { 'completed' }
    steps = $serializableSteps
    ownedProcesses = @($State.ownedProcesses)
    artifacts = [pscustomobject]$artifacts
    primaryError = $State.primaryError
    cleanupErrors = @($State.cleanupErrors)
  }) -Depth 16
  Invoke-WatchModeReportGenerator $OutputDirectory "live" $Context.paths.workspaceRoot
}
function Write-StrictPaidCellBudget {
  param([string]$OutputDirectory, [string]$AppLogPath, [string]$RunMarker, [Parameter(Mandatory = $true)]$Context)
  $workspaceRoot = [string]$Context.paths.workspaceRoot
  $MatrixCellId = [string]$Context.request.matrix.cellId
  $WatchModelId = [string]$Context.request.model.id
  $FeedbackLoopPrevention = [string]$Context.request.feedbackMode
  $SubtitleTranslationMode = [string]$Context.request.model.subtitleTranslationMode
  $providerAuthorityMode = [string]$Context.request.authorityMode
  $budgetScript = Join-Path $workspaceRoot "scripts/testing/watch-mode-external-provider-budget.mjs"
  if ([string]::IsNullOrWhiteSpace($AppLogPath) -or -not (Test-Path -LiteralPath $AppLogPath -PathType Leaf)) {
    $AppLogPath = Join-Path $OutputDirectory 'app.log'
    $scopedLog = Copy-WatchModeAppLog -SourcePath (Get-WatchModeDesktopAppLogPath) `
      -DestinationPath $AppLogPath -RunMarker $RunMarker
    if (-not $scopedLog) {
      [System.IO.File]::WriteAllText($AppLogPath, "$RunMarker`n", [System.Text.UTF8Encoding]::new($false))
    }
  }
  $sendBoundaryLedgerPath = Join-Path $OutputDirectory 'provider-input-budget-ledger.json'
  if (-not (Test-Path -LiteralPath $sendBoundaryLedgerPath -PathType Leaf)) {
    $leaseId = [string]$env:OMNI_WATCH_MODE_PROVIDER_INPUT_LEASE_ID
    if ([string]::IsNullOrWhiteSpace($leaseId)) {
      throw 'strict paid pre-provider terminal requires the coordinator-issued Provider input lease id'
    }
    $terminalArguments = @(
      $budgetScript,
      '--run-directory', $OutputDirectory,
      '--app-log', $AppLogPath,
      '--run-marker', $RunMarker,
      '--cell-id', $MatrixCellId,
      '--model-id', $WatchModelId,
      '--feedback-mode', $FeedbackLoopPrevention,
      '--translation-mode', $SubtitleTranslationMode,
      '--input-ceiling-samples', "$env:OMNI_WATCH_MODE_PROVIDER_INPUT_MAX_SAMPLES",
      '--authority-mode', $providerAuthorityMode,
      '--write-pre-provider-terminal', 'true',
      '--lease-id', $leaseId
    )
    $terminalOutput = @(& node @terminalArguments 2>&1 | ForEach-Object { "$_" })
    if ($LASTEXITCODE -ne 0) {
      throw "strict paid pre-provider terminal creation failed: $($terminalOutput -join ' ')"
    }
  }
  $arguments = @(
    $budgetScript,
    "--run-directory", $OutputDirectory,
    "--app-log", $AppLogPath,
    "--run-marker", $RunMarker,
    "--cell-id", $MatrixCellId,
    "--model-id", $WatchModelId,
    "--feedback-mode", $FeedbackLoopPrevention,
    "--translation-mode", $SubtitleTranslationMode,
    "--input-ceiling-samples", "$env:OMNI_WATCH_MODE_PROVIDER_INPUT_MAX_SAMPLES",
    "--authority-mode", $providerAuthorityMode
  )
  $output = @(& node @arguments 2>&1 | ForEach-Object { "$_" })
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    throw "strict paid-cell provider budget failed before matrix continuation: $($output -join ' ')"
  }
  $budgetPath = Join-Path $OutputDirectory "external-provider-budget.json"
  if (-not (Test-Path -LiteralPath $budgetPath -PathType Leaf)) {
    throw "strict paid-cell provider budget did not create $budgetPath"
  }
  $ledger = Get-Content -LiteralPath $budgetPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if (-not $ledger.passed) {
    throw "strict paid-cell provider budget did not pass"
  }
  return $ledger
}
function Write-LocalSmokeProviderSessionAuthority {
  param([string]$OutputDirectory, [string]$RunMarker, [Parameter(Mandatory = $true)]$Context)
  $FeedbackLoopPrevention = [string]$Context.request.feedbackMode
  $MatrixCellId = [string]$Context.request.matrix.cellId
  $WatchAutoStopAfterSeconds = [int]$Context.request.timeouts.sessionSeconds
  $WatchModelId = [string]$Context.request.model.id
  $WatchRealtimeProtocol = [string]$Context.request.model.protocol
  $leasePath = Join-Path $OutputDirectory "smoke-provider-session-lease.json"
  $ledgerPath = Join-Path $OutputDirectory "smoke-provider-session-ledger.json"
  $sourcePath = Join-Path $OutputDirectory "source-media-transcript.json"
  $physicalPath = Join-Path $OutputDirectory "physical-output-content.raw.json"
  $authorityPath = Join-Path $OutputDirectory "smoke-provider-session-authority.json"
  $requiredPaths = @($leasePath, $ledgerPath, $sourcePath, $physicalPath)
  foreach ($requiredPath in $requiredPaths) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
      throw "local smoke provider-session authority input is missing: $requiredPath"
    }
  }
  $lease = Get-Content -LiteralPath $leasePath -Raw -Encoding UTF8 | ConvertFrom-Json
  $ledger = Get-Content -LiteralPath $ledgerPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $source = if (Test-Path -LiteralPath $sourcePath -PathType Leaf) {
    Get-Content -LiteralPath $sourcePath -Raw -Encoding UTF8 | ConvertFrom-Json
  } else { $null }
  $physical = if (Test-Path -LiteralPath $physicalPath -PathType Leaf) {
    Get-Content -LiteralPath $physicalPath -Raw -Encoding UTF8 | ConvertFrom-Json
  } else { $null }
  $violations = @()
  if ($lease.schemaVersion -ne 1 -or $ledger.schemaVersion -ne 1) { $violations += "smoke lease and ledger schema versions must both be 1" }
  if ($lease.artifactKind -cne "watch-mode-smoke-provider-session-lease") { $violations += "smoke lease artifact kind is invalid" }
  if ($ledger.artifactKind -cne "watch-mode-smoke-provider-session-ledger") { $violations += "smoke ledger artifact kind is invalid" }
  $requiredLedgerFields = @(
    "cellId", "leaseId", "runMarker", "maxSamples", "sessionGeneration",
    "totalAttemptedSamples", "initialConnectAttempts", "reconnects",
    "appendAttempts", "sendFailures", "budgetExceeded", "finalized", "terminalReason",
    "model", "protocol", "localSingleSessionAuthority",
    "strictPaidAuthority", "incidentReplayAuthority", "nonAuthoritative",
    "direction", "providerId", "templateId", "providerKind", "endpointHost",
    "credentialReference", "authHeaderName", "authScheme", "customHeaderCount"
  )
  foreach ($field in $requiredLedgerFields) {
    if ($ledger.PSObject.Properties.Name -notcontains $field) { $violations += "smoke ledger field is missing: $field" }
  }
  if ($lease.nonAuthoritative -ne $true -or $ledger.nonAuthoritative -ne $true) { $violations += "smoke lease and ledger must be explicitly non-authoritative" }
  if ($ledger.localSingleSessionAuthority -ne $true -or $ledger.strictPaidAuthority -ne $false -or $ledger.incidentReplayAuthority -ne $false) { $violations += "smoke ledger authority sentinels are invalid" }
  if (
    [string]$ledger.direction -cne "inbound" -or
    [string]$ledger.providerId -cne "provider-dashscope" -or
    [string]$ledger.templateId -cne "template-dashscope-realtime" -or
    [string]$ledger.providerKind -cne "dashscope" -or
    [string]$ledger.endpointHost -cne "dashscope.aliyuncs.com" -or
    [string]$ledger.credentialReference -cne "credential://provider/dashscope/default" -or
    [string]$ledger.authHeaderName -cne "Authorization" -or
    [string]$ledger.authScheme -cne "bearer" -or
    [long]$ledger.customHeaderCount -ne 0
  ) { $violations += "smoke ledger Provider identity is not canonical" }
  if ([string]$lease.cellId -cne $MatrixCellId -or [string]$ledger.cellId -cne $MatrixCellId) { $violations += "smoke authority cellId mismatch" }
  if ([string]$lease.leaseId -cne [string]$ledger.leaseId -or [string]::IsNullOrWhiteSpace([string]$ledger.leaseId)) { $violations += "smoke authority leaseId mismatch" }
  if ([string]$lease.runMarker -cne $RunMarker -or [string]$ledger.runMarker -cne $RunMarker) { $violations += "smoke authority run marker mismatch" }
  if ([long]$lease.maxSamples -ne [long]$ledger.maxSamples -or [long]$ledger.maxSamples -ne ($WatchAutoStopAfterSeconds * 16000)) { $violations += "smoke authority sample ceiling mismatch" }
  if ([long]$ledger.sessionGeneration -le 0) { $violations += "smoke ledger session generation is invalid" }
  if ([long]$ledger.totalAttemptedSamples -le 0 -or [long]$ledger.totalAttemptedSamples -gt [long]$ledger.maxSamples) { $violations += "smoke provider input samples are outside the lease" }
  if ([long]$ledger.appendAttempts -le 0) { $violations += "smoke Provider ledger contains no append attempts" }
  if ([long]$ledger.initialConnectAttempts -ne 1) { $violations += "smoke must perform exactly one initial Provider connection" }
  if ([long]$ledger.reconnects -ne 0) { $violations += "smoke must not reconnect to the Provider" }
  if ([long]$ledger.sendFailures -ne 0) { $violations += "smoke Provider send boundary recorded failures" }
  if ($ledger.budgetExceeded -ne $false -or $ledger.finalized -ne $true) { $violations += "smoke Provider ledger is not a finalized in-budget session" }
  if ([string]$ledger.terminalReason -cne "worker-completed") { $violations += "smoke Provider worker did not reach its normal completion terminal" }
  if ([string]$ledger.model -cne $WatchModelId -or [string]$ledger.protocol -cne $WatchRealtimeProtocol) { $violations += "smoke Provider model/protocol mismatch" }
  $sourceHasZeroCallFields = $source.PSObject.Properties.Name -contains "remoteProviderCalls" -and $source.PSObject.Properties.Name -contains "externalAudioSeconds"
  $physicalHasZeroCallFields = $physical.PSObject.Properties.Name -contains "remoteProviderCalls" -and $physical.PSObject.Properties.Name -contains "externalAudioSeconds"
  if ($source.schemaVersion -ne 2 -or $source.authorityMode -cne "canonical-fixture-local-v2" -or -not $sourceHasZeroCallFields -or $source.passed -ne $true -or [long]$source.remoteProviderCalls -ne 0 -or [double]$source.externalAudioSeconds -ne 0) { $violations += "canonical source authority used or required an auxiliary Provider" }
  if ($physical.schemaVersion -ne 1 -or $physical.authorityMode -cne "local-pcm-cue-playback-v1" -or -not $physicalHasZeroCallFields -or $physical.passed -ne $true -or [long]$physical.remoteProviderCalls -ne 0 -or [double]$physical.externalAudioSeconds -ne 0) { $violations += "physical-output authority used or required an auxiliary Provider" }
  $authority = [ordered]@{
    schemaVersion = 1
    artifactKind = "watch-mode-smoke-provider-session-authority"
    nonAuthoritative = $true
    passed = ($violations.Count -eq 0)
    cellId = $MatrixCellId
    leaseId = [string]$ledger.leaseId
    runMarker = $RunMarker
    model = $WatchModelId
    protocol = $WatchRealtimeProtocol
    providerSessions = [long]$ledger.initialConnectAttempts
    auxiliaryProviderSessions = 0
    totalAttemptedSamples = [long]$ledger.totalAttemptedSamples
    maxSamples = [long]$ledger.maxSamples
    reconnects = [long]$ledger.reconnects
    finalized = [bool]$ledger.finalized
    violations = @($violations)
  }
  [System.IO.File]::WriteAllText(
    $authorityPath,
    ($authority | ConvertTo-Json -Depth 5),
    [System.Text.UTF8Encoding]::new($false)
  )
  if ($violations.Count -gt 0) {
    throw "local smoke provider-session authority failed: $($violations -join '; ')"
  }
  return [pscustomobject]$authority
}
Export-ModuleMember -Function @(
  'Get-WatchModeDesktopAppLogPath',
  'Copy-WatchModeAppLog',
  'Save-WatchModeRunArtifacts',
  'Write-StrictPaidCellBudget',
  'Write-LocalSmokeProviderSessionAuthority'
)
