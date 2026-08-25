#requires -Version 5.1

Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.Process.psm1') -Force

function Start-WatchModeSystemMetricsSampler {
  param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [Parameter(Mandatory = $true)][string]$WorkspaceRoot
  )
  $collectorPath = Join-Path $WorkspaceRoot "scripts/testing/collect-watch-mode-system-metrics.ps1"
  $metricsPath = Join-Path $OutputDirectory "system-metrics.json"
  $stdoutPath = Join-Path $OutputDirectory "system-metrics.stdout.log"
  $stderrPath = Join-Path $OutputDirectory "system-metrics.stderr.log"
  Remove-Item -LiteralPath $metricsPath -Force -ErrorAction SilentlyContinue
  $process = Start-Process -FilePath "powershell.exe" `
    -ArgumentList @(
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', "`"$collectorPath`"",
      '-RootProcessId', "$ProcessId",
      '-OutputPath', "`"$metricsPath`"",
      '-SampleIntervalMs', '1000'
    ) `
    -WorkingDirectory $WorkspaceRoot `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -WindowStyle Hidden `
    -PassThru
  return [pscustomobject]@{
    pid = $process.Id
    processLease = Get-OmniProcessIdentity -ProcessId $process.Id -Ownership managed
    rootProcessId = $ProcessId
    outputPath = $metricsPath
    stdout = $stdoutPath
    stderr = $stderrPath
    sampleIntervalMs = 1000
  }
}

function Complete-WatchModeSystemMetricsSampler {
  param($Sampler)
  if (-not $Sampler -or -not $Sampler.pid) {
    throw "system metrics sampler was not started"
  }
  $process = Get-Process -Id ([int]$Sampler.pid) -ErrorAction SilentlyContinue
  if ($process -and -not $process.HasExited) {
    Wait-Process -Id $process.Id -Timeout 15 -ErrorAction SilentlyContinue
    $process.Refresh()
  }
  if ($process -and -not $process.HasExited) {
    throw "system metrics sampler did not exit after desktop process $($Sampler.rootProcessId) exited"
  }
  if (-not (Test-Path -LiteralPath $Sampler.outputPath -PathType Leaf)) {
    $collectorError = if (Test-Path -LiteralPath $Sampler.stderr -PathType Leaf) {
      Get-Content -LiteralPath $Sampler.stderr -Raw -Encoding UTF8
    } else { '' }
    throw "system metrics sampler did not write $($Sampler.outputPath): $collectorError"
  }
  $metrics = Get-Content -LiteralPath $Sampler.outputPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if (
    $metrics.artifactKind -ne 'watch-mode-system-metrics' -or
    $metrics.completionReason -ne 'root-process-exited' -or
    [int]$metrics.sampleCount -le 0 -or
    @($metrics.collectionErrors).Count -gt 0
  ) {
    throw (
      "system metrics sampler emitted unusable evidence: " +
      "completionReason=$($metrics.completionReason) sampleCount=$($metrics.sampleCount) " +
      "errors=$(@($metrics.collectionErrors) -join '; ')"
    )
  }
  return [pscustomobject]@{
    outputPath = $Sampler.outputPath
    sampleCount = [int]$metrics.sampleCount
    startedAt = $metrics.startedAt
    finishedAt = $metrics.finishedAt
    completionReason = $metrics.completionReason
  }
}

function Stop-WatchModeSystemMetricsSampler {
  param($Sampler)
  if ($Sampler -and $Sampler.processLease -and (Test-OmniProcessIdentity -Lease $Sampler.processLease)) {
    Stop-OmniOwnedProcessTree -Lease $Sampler.processLease | Out-Null
  }
}


Export-ModuleMember -Function @(
  'Start-WatchModeSystemMetricsSampler',
  'Complete-WatchModeSystemMetricsSampler',
  'Stop-WatchModeSystemMetricsSampler'
)
