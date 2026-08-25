#requires -Version 5.1

function Complete-StartupReadinessCollection {
  param(
    [Parameter(Mandatory = $true)][string]$RunDirectory,
    [Parameter(Mandatory = $true)][string]$WorkspaceRoot,
    [Parameter(Mandatory = $true)]$Collection
  )
  $collectionPath = Join-Path $RunDirectory 'startup-collection.json'
  $json = $Collection | ConvertTo-Json -Depth 16
  [IO.File]::WriteAllText($collectionPath, $json, [Text.UTF8Encoding]::new($false))
  & node (Join-Path $WorkspaceRoot 'scripts/testing/startup-readiness-report.mjs') --input $collectionPath --output $RunDirectory | Out-Null
  if ($LASTEXITCODE -notin @(0, 1)) {
    throw "startup readiness report generator failed with exit code $LASTEXITCODE"
  }
  return Join-Path $RunDirectory 'report.json'
}

function Complete-StartupPreflightCollection {
  param(
    [Parameter(Mandatory = $true)][string]$RunDirectory,
    [Parameter(Mandatory = $true)][string]$WorkspaceRoot,
    [Parameter(Mandatory = $true)][string]$RunId,
    [Parameter(Mandatory = $true)][bool]$DryRun,
    [string]$FailureCode,
    [string]$FailureMessage,
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(Mandatory = $true)][int]$TimeoutSeconds,
    [Parameter(Mandatory = $true)]$Thresholds,
    [Parameter(Mandatory = $true)]$DevServer,
    [Parameter(Mandatory = $true)]$Artifacts,
    [Parameter(Mandatory = $true)][bool]$NoStop,
    $ExistingDesktopShells = @()
  )
  $emptyWindow = [ordered]@{ detected=$false; detectedAt=$null; detectedElapsedMs=$null; processId=$null; processName=$null; title='Omni Translate'; startTime=$null }
  $emptyReadiness = [ordered]@{ detected=$false; detectedAt=$null; detectedElapsedMs=$null; observedElapsedMs=$null; windowToReadyMs=$null; frontend=$null; markerLine=$null; payloadError=$null }
  $collection = [ordered]@{
    schemaVersion = 'startup-readiness-collection/v1'
    runId = $RunId
    dryRun = $DryRun
    preflightFailure = if ($FailureCode) { [ordered]@{ code=$FailureCode; message=$FailureMessage } } else { $null }
    command = $Command
    launchStartedAt = [DateTimeOffset]::UtcNow.ToString('o')
    timeoutSeconds = $TimeoutSeconds
    thresholds = $Thresholds
    devServer = $DevServer
    poll = [ordered]@{ windowPollMs=$null; logPollMs=$null }
    window = $emptyWindow
    readiness = $emptyReadiness
    fullReadinessRaw = $null
    process = [ordered]@{ npmProcessId=$null; viteProcessId=$null; exitedBeforeReady=$false; noStop=$NoStop; existingDesktopShells=@($ExistingDesktopShells) }
    artifacts = $Artifacts
  }
  return Complete-StartupReadinessCollection -RunDirectory $RunDirectory -WorkspaceRoot $WorkspaceRoot -Collection $collection
}

Export-ModuleMember -Function @('Complete-StartupReadinessCollection','Complete-StartupPreflightCollection')
