param(
  [Parameter(Mandatory = $true)]
  [ValidateRange(1, 2147483647)]
  [int]$RootProcessId,
  [Parameter(Mandatory = $true)]
  [string]$OutputPath,
  [Parameter(Mandatory = $true)]
  [ValidateRange(1, 65535)]
  [int]$ExpectedSessionId,
  [Parameter(Mandatory = $true)]
  [string]$ExpectedOwnerSid,
  [Parameter(Mandatory = $true)]
  [string]$ExecutionId,
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-f0-9]{64}$')]
  [string]$PlanDigest,
  [Parameter(Mandatory = $true)]
  [string]$LeaseId,
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-f0-9]{64}$')]
  [string]$LeaseDigest,
  [Parameter(Mandatory = $true)]
  [string]$CellId,
  [Parameter(Mandatory = $true)]
  [string]$WorkerId,
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-f0-9]{64}$')]
  [string]$VmIdentityDigest,
  [switch]$RequireRecorder,
  [ValidateRange(100, 5000)]
  [int]$SampleIntervalMs = 250
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-Sha256 {
  param([Parameter(Mandatory = $true)][string]$Path)
  $bytes = [IO.File]::ReadAllBytes([IO.Path]::GetFullPath($Path))
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function Format-CollectionError {
  param([Parameter(Mandatory = $true)]$ErrorRecord)
  $position = [string]$ErrorRecord.InvocationInfo.PositionMessage
  $errorId = [string]$ErrorRecord.FullyQualifiedErrorId
  return "$($ErrorRecord.Exception.Message) | errorId=$errorId | $position"
}

function Get-DescendantProcesses {
  param([int]$RootId)
  $all = @(Get-CimInstance Win32_Process -ErrorAction Stop)
  $byParent = @{}
  foreach ($process in $all) {
    $parentId = [int]$process.ParentProcessId
    if (-not $byParent.ContainsKey($parentId)) {
      $byParent[$parentId] = New-Object Collections.Generic.List[object]
    }
    [void]$byParent[$parentId].Add($process)
  }
  $queue = New-Object Collections.Generic.Queue[int]
  $seen = New-Object Collections.Generic.HashSet[int]
  $result = New-Object Collections.Generic.List[object]
  $queue.Enqueue($RootId)
  while ($queue.Count -gt 0) {
    $processId = $queue.Dequeue()
    if (-not $seen.Add($processId)) { continue }
    $process = @($all | Where-Object { [int]$_.ProcessId -eq $processId } | Select-Object -First 1)
    if ($process.Count -eq 1) { [void]$result.Add($process[0]) }
    if ($byParent.ContainsKey($processId)) {
      foreach ($child in $byParent[$processId]) { $queue.Enqueue([int]$child.ProcessId) }
    }
  }
  # Windows PowerShell 5.1 can throw System.ArgumentException ("type
  # mismatch") while expanding a generic List[object] through @(...).
  # Materialize the list with its strongly typed API before returning it.
  return [object[]]$result.ToArray()
}

function Get-Role {
  param($Process, [int]$RootId)
  $name = ([string]$Process.Name).ToLowerInvariant()
  $command = [string]$Process.CommandLine
  if ([int]$Process.ProcessId -eq $RootId) { return 'shard-node' }
  if ($name -eq 'powershell.exe' -and $command -like '*run-watch-mode-live.ps1*') { return 'cell-powershell' }
  if ($name -eq 'omni-desktop-shell.exe') { return 'desktop' }
  if ($name -eq 'omni-bridge-service.exe') { return 'bridge' }
  if ($name -eq 'omni-physical-output-probe.exe' -and $command -like '*--record-only*') { return 'recorder' }
  return 'supporting'
}

$startedAt = [DateTime]::UtcNow
$observed = @{}
$errors = New-Object Collections.Generic.List[string]
try {
  if (-not (Get-Process -Id $RootProcessId -ErrorAction SilentlyContinue)) {
    throw "root process $RootProcessId does not exist"
  }
  while (Get-Process -Id $RootProcessId -ErrorAction SilentlyContinue) {
    try {
      foreach ($process in @(Get-DescendantProcesses $RootProcessId)) {
        $processId = [int]$process.ProcessId
        $key = "$processId"
        $capturedAt = [DateTime]::UtcNow.ToString('o')
        if ($observed.ContainsKey($key)) {
          $observed[$key].lastSeenAt = $capturedAt
          continue
        }
        try {
          if (-not (Get-Process -Id $processId -ErrorAction SilentlyContinue)) { continue }
          $ownerSid = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -ErrorAction Stop
          $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwner -ErrorAction Stop
          $imagePath = [string]$process.ExecutablePath
          if (-not $imagePath -or -not (Test-Path -LiteralPath $imagePath -PathType Leaf)) {
            throw "process $processId has no regular executable path"
          }
          $entry = [ordered]@{
            role = Get-Role $process $RootProcessId
            pid = $processId
            parentPid = [int]$process.ParentProcessId
            sessionId = [int]$process.SessionId
            imagePath = [IO.Path]::GetFullPath($imagePath)
            imageSha256 = Get-Sha256 $imagePath
            commandLine = [string]$process.CommandLine
            startedAt = (Get-Process -Id $processId -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')
            ownerUser = [string]$owner.User
            ownerDomain = [string]$owner.Domain
            ownerSid = [string]$ownerSid.Sid
            firstSeenAt = $capturedAt
            lastSeenAt = $capturedAt
          }
          if ($entry.sessionId -ne $ExpectedSessionId -or $entry.ownerSid -cne $ExpectedOwnerSid) {
            throw "process $processId escaped the signed interactive session/owner"
          }
          $observed[$key] = $entry
        } catch {
          if (Get-Process -Id $processId -ErrorAction SilentlyContinue) { throw }
        }
      }
    } catch {
      [void]$errors.Add((Format-CollectionError $_))
    }
    Start-Sleep -Milliseconds $SampleIntervalMs
  }
} catch {
  [void]$errors.Add((Format-CollectionError $_))
}

$processes = @($observed.Values | Sort-Object @{ Expression = { $_.firstSeenAt } }, @{ Expression = { $_.pid } })
$requiredRoles = @('shard-node', 'cell-powershell', 'desktop', 'bridge')
if ($RequireRecorder) { $requiredRoles += 'recorder' }
foreach ($role in $requiredRoles) {
  if (@($processes | Where-Object { $_.role -eq $role }).Count -lt 1) {
    [void]$errors.Add("required process role was not observed: $role")
  }
}
$payload = [ordered]@{
  schemaVersion = 1
  artifactKind = 'watch-mode-interactive-process-authority'
  executionId = $ExecutionId
  planDigest = $PlanDigest
  leaseId = $LeaseId
  leaseDigest = $LeaseDigest
  cellId = $CellId
  workerId = $WorkerId
  vmIdentityDigest = $VmIdentityDigest
  rootProcessId = $RootProcessId
  expectedSessionId = $ExpectedSessionId
  expectedOwnerSid = $ExpectedOwnerSid
  startedAt = $startedAt.ToString('o')
  completedAt = [DateTime]::UtcNow.ToString('o')
  sampleIntervalMs = $SampleIntervalMs
  processCount = $processes.Count
  processes = $processes
  errors = $errors.ToArray()
  passed = $errors.Count -eq 0
}
$resolvedOutputPath = [IO.Path]::GetFullPath($OutputPath)
[void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($resolvedOutputPath))
$encoding = New-Object Text.UTF8Encoding($false)
$bytes = $encoding.GetBytes((($payload | ConvertTo-Json -Depth 12) + "`n"))
$stream = New-Object IO.FileStream(
  $resolvedOutputPath,
  [IO.FileMode]::CreateNew,
  [IO.FileAccess]::Write,
  [IO.FileShare]::Read,
  4096,
  [IO.FileOptions]::WriteThrough
)
try {
  $stream.Write($bytes, 0, $bytes.Length)
  $stream.Flush($true)
} finally {
  $stream.Dispose()
}
if (-not $payload.passed) { exit 1 }
