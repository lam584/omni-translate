param(
  [Parameter(Mandatory = $true)]
  [ValidateRange(1, 2147483647)]
  [int]$RootProcessId,
  [Parameter(Mandatory = $true)]
  [string]$OutputPath,
  [ValidateRange(250, 5000)]
  [int]$SampleIntervalMs = 1000
)

$ErrorActionPreference = 'Stop'

function Get-ProcessTreeIds {
  param([int]$RootId)

  $processes = @(Get-CimInstance Win32_Process -ErrorAction Stop)
  $children = @{}
  foreach ($process in $processes) {
    $parentId = [int]$process.ParentProcessId
    if (-not $children.ContainsKey($parentId)) {
      $children[$parentId] = New-Object System.Collections.Generic.List[int]
    }
    [void]$children[$parentId].Add([int]$process.ProcessId)
  }
  $pending = New-Object System.Collections.Generic.Queue[int]
  $seen = New-Object System.Collections.Generic.HashSet[int]
  $pending.Enqueue($RootId)
  while ($pending.Count -gt 0) {
    $processId = $pending.Dequeue()
    if (-not $seen.Add($processId)) { continue }
    if ($children.ContainsKey($processId)) {
      foreach ($childId in $children[$processId]) {
        $pending.Enqueue($childId)
      }
    }
  }
  return @($seen)
}

function Get-ProcessTreeSnapshot {
  param([int]$RootId)

  $cpuByProcess = @{}
  $processNamesById = @{}
  $bridgeProcessIds = New-Object System.Collections.Generic.List[int]
  $workingSetBytes = 0L
  foreach ($processId in @(Get-ProcessTreeIds $RootId)) {
    try {
      $process = Get-Process -Id $processId -ErrorAction Stop
      $cpuByProcess["$processId"] = [double]$process.TotalProcessorTime.TotalMilliseconds
      $processNamesById["$processId"] = [string]$process.ProcessName
      if ($process.ProcessName -eq 'omni-bridge-service') {
        [void]$bridgeProcessIds.Add([int]$processId)
      }
      $workingSetBytes += [int64]$process.WorkingSet64
    } catch [Microsoft.PowerShell.Commands.ProcessCommandException] {
      # A child may exit between the process-tree and process snapshots. The
      # root liveness check below decides when collection is complete.
    }
  }
  return [pscustomobject]@{
    capturedAt = [DateTime]::UtcNow
    cpuByProcess = $cpuByProcess
    processIds = @($cpuByProcess.Keys | ForEach-Object { [int]$_ } | Sort-Object)
    processNamesById = $processNamesById
    bridgeProcessIds = @($bridgeProcessIds | Sort-Object)
    processCount = $cpuByProcess.Count
    workingSetBytes = $workingSetBytes
  }
}

$resolvedOutputPath = [System.IO.Path]::GetFullPath($OutputPath)
$outputDirectory = Split-Path -Parent $resolvedOutputPath
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
$startedAt = [DateTime]::UtcNow
$samples = New-Object System.Collections.Generic.List[object]
$collectionErrors = New-Object System.Collections.Generic.List[string]
$processorCount = [Environment]::ProcessorCount
$completionReason = 'collector-stopped'
$previous = $null

function Test-RootProcessIdentity {
  param(
    [int]$RootId,
    [DateTime]$ExpectedStartTimeUtc
  )

  try {
    $process = Get-Process -Id $RootId -ErrorAction Stop
    return $process.StartTime.ToUniversalTime() -eq $ExpectedStartTimeUtc
  } catch {
    return $false
  }
}

try {
  $rootProcess = Get-Process -Id $RootProcessId -ErrorAction SilentlyContinue
  if (-not $rootProcess) {
    throw "root process $RootProcessId does not exist"
  }
  $rootStartTimeUtc = $rootProcess.StartTime.ToUniversalTime()
  $previous = Get-ProcessTreeSnapshot $RootProcessId
  while ($true) {
    Start-Sleep -Milliseconds $SampleIntervalMs
    if (-not (Test-RootProcessIdentity $RootProcessId $rootStartTimeUtc)) {
      $completionReason = 'root-process-exited'
      break
    }
    try {
      $current = Get-ProcessTreeSnapshot $RootProcessId
      if ($current.processCount -le 0 -or $current.workingSetBytes -le 0) {
        if (-not (Test-RootProcessIdentity $RootProcessId $rootStartTimeUtc)) {
          $completionReason = 'root-process-exited'
          break
        }
        throw 'system metrics process-tree snapshot was empty while the root process was alive'
      }
      $elapsedMs = ($current.capturedAt - $previous.capturedAt).TotalMilliseconds
      if ($elapsedMs -le 0) {
        # Windows can return two identical wall-clock ticks at this polling
        # cadence. Keep the prior baseline and wait for a later sample rather
        # than invalidating an otherwise live process-transition artifact.
        continue
      }
      $cpuDeltaMs = 0.0
      foreach ($entry in $current.cpuByProcess.GetEnumerator()) {
        if ($previous.cpuByProcess.ContainsKey($entry.Key)) {
          $delta = [double]$entry.Value - [double]$previous.cpuByProcess[$entry.Key]
          if ($delta -gt 0) { $cpuDeltaMs += $delta }
        }
      }
      $cpuPercent = ($cpuDeltaMs / $elapsedMs / $processorCount) * 100.0
      [void]$samples.Add([ordered]@{
        timestamp = $current.capturedAt.ToString('o')
        elapsedMs = [Math]::Round(($current.capturedAt - $startedAt).TotalMilliseconds, 3)
        processCount = $current.processCount
        processIds = @($current.processIds)
        processNamesById = $current.processNamesById
        bridgeProcessIds = @($current.bridgeProcessIds)
        cpuPercent = [Math]::Round($cpuPercent, 6)
        workingSetMb = [Math]::Round(($current.workingSetBytes / 1MB), 6)
      })
      $previous = $current
    } catch {
      [void]$collectionErrors.Add($_.Exception.Message)
    }
  }
} catch {
  [void]$collectionErrors.Add($_.Exception.Message)
  $completionReason = 'collector-failed'
} finally {
  $finishedAt = [DateTime]::UtcNow
  $payload = [ordered]@{
    schemaVersion = 1
    artifactKind = 'watch-mode-system-metrics'
    collector = 'scripts/testing/collect-watch-mode-system-metrics.ps1'
    rootProcessId = $RootProcessId
    scope = 'process-tree'
    processorCount = $processorCount
    sampleIntervalMs = $SampleIntervalMs
    startedAt = $startedAt.ToString('o')
    finishedAt = $finishedAt.ToString('o')
    completionReason = $completionReason
    sampleCount = $samples.Count
    collectionErrors = $collectionErrors.ToArray()
    samples = $samples.ToArray()
  }
  $temporaryPath = "$resolvedOutputPath.$PID.tmp"
  $utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText(
    $temporaryPath,
    (($payload | ConvertTo-Json -Depth 8) + "`n"),
    $utf8WithoutBom
  )
  Move-Item -LiteralPath $temporaryPath -Destination $resolvedOutputPath -Force
}

if ($completionReason -ne 'root-process-exited' -or $collectionErrors.Count -gt 0) {
  exit 1
}
