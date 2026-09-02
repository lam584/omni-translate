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
  [Parameter(Mandatory = $true)][string]$ExecutionReceiptPath,
  [switch]$RequireRecorder,
  [ValidateRange(100, 5000)][int]$SampleIntervalMs = 250
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'lib/powershell/Omni.Testing.IO.psm1') -Force
function Format-CollectionError {
  param([Parameter(Mandatory = $true)]$ErrorRecord)
  $position = [string]$ErrorRecord.InvocationInfo.PositionMessage
  $errorId = [string]$ErrorRecord.FullyQualifiedErrorId
  return "$($ErrorRecord.Exception.Message) | errorId=$errorId | $position"
}
function Get-ProcessGenerationKey {
  param([Parameter(Mandatory = $true)]$Process)
  $processId = [int]$Process.ProcessId
  $createdAtUtc = ([DateTime]$Process.CreationDate).ToUniversalTime()
  return "$processId|$($createdAtUtc.Ticks)"
}
function Get-DescendantProcesses {
  param([int]$RootId, [Parameter(Mandatory = $true)][string]$RootGenerationKey)
  $all = @(Get-CimInstance Win32_Process -ErrorAction Stop)
  $byParent = @{}
  foreach ($process in $all) {
    $parentId = [int]$process.ParentProcessId
    if (-not $byParent.ContainsKey($parentId)) {
      $byParent[$parentId] = New-Object Collections.Generic.List[object]
    }
    [void]$byParent[$parentId].Add($process)
  }
  $queue = New-Object Collections.Generic.Queue[object]
  $seen = New-Object Collections.Generic.HashSet[int]
  $result = New-Object Collections.Generic.List[object]
  $rootProcess = @($all | Where-Object {
    [int]$_.ProcessId -eq $RootId -and (Get-ProcessGenerationKey $_) -ceq $RootGenerationKey
  } | Select-Object -First 1)
  if ($rootProcess.Count -ne 1) { return [object[]]@() }
  $queue.Enqueue($rootProcess[0])
  while ($queue.Count -gt 0) {
    $process = $queue.Dequeue()
    $processId = [int]$process.ProcessId
    if (-not $seen.Add($processId)) { continue }
    [void]$result.Add($process)
    if ($byParent.ContainsKey($processId)) {
      foreach ($child in $byParent[$processId]) {
        # ParentProcessId is not an identity on Windows. A long-lived system
        # process can retain a historical parent PID that has since been
        # reused by this task. Creation-time monotonicity rejects that false
        # edge without weakening the later session/SID/image checks.
        if ([DateTime]$child.CreationDate -ge [DateTime]$process.CreationDate) {
          $queue.Enqueue($child)
        }
      }
    }
  }
  # Avoid Windows PowerShell 5.1 generic List[object] expansion type mismatches.
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
  $rootProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$RootProcessId" -ErrorAction SilentlyContinue
  if (-not $rootProcess) {
    throw "root process $RootProcessId does not exist"
  }
  $rootGenerationKey = Get-ProcessGenerationKey $rootProcess
  while ($true) {
    $currentRoot = Get-CimInstance Win32_Process -Filter "ProcessId=$RootProcessId" -ErrorAction SilentlyContinue
    if (-not $currentRoot -or (Get-ProcessGenerationKey $currentRoot) -cne $rootGenerationKey) { break }
    try {
      $capturedAt = [DateTime]::UtcNow.ToString('o')
      foreach ($process in @(Get-DescendantProcesses $RootProcessId $rootGenerationKey)) {
        $processId = [int]$process.ProcessId
        $key = Get-ProcessGenerationKey $process
        if ($observed.ContainsKey($key)) {
          $observed[$key].lastSeenAt = $capturedAt
          continue
        }
        try {
          $identityProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue
          if (-not $identityProcess -or (Get-ProcessGenerationKey $identityProcess) -cne $key) { continue }
          $imagePath = [string]$identityProcess.ExecutablePath
          for ($identityAttempt = 0; $identityAttempt -lt 4 -and -not $imagePath; $identityAttempt++) {
            Start-Sleep -Milliseconds 25
            $identityProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue
            if (-not $identityProcess) { break }
            $imagePath = [string]$identityProcess.ExecutablePath
          }
          if (-not $identityProcess -or (Get-ProcessGenerationKey $identityProcess) -cne $key) { continue }
          if (-not $imagePath -or -not (Test-Path -LiteralPath $imagePath -PathType Leaf)) {
            throw "process $processId has no regular executable path"
          }
          $ownerSid = Invoke-CimMethod -InputObject $identityProcess -MethodName GetOwnerSid -ErrorAction Stop
          $owner = Invoke-CimMethod -InputObject $identityProcess -MethodName GetOwner -ErrorAction Stop
          $runtimeProcess = Get-Process -Id $processId -ErrorAction SilentlyContinue
          $confirmedIdentityProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue
          if (
            -not $runtimeProcess -or
            -not $confirmedIdentityProcess -or
            (Get-ProcessGenerationKey $confirmedIdentityProcess) -cne $key
          ) { continue }
          $parentStartedAt = $null
          if ($processId -ne $RootProcessId) {
            $parentIdentityProcess = Get-CimInstance Win32_Process `
              -Filter "ProcessId=$([int]$identityProcess.ParentProcessId)" `
              -ErrorAction SilentlyContinue
            if (-not $parentIdentityProcess) { continue }
            $parentGenerationKey = Get-ProcessGenerationKey $parentIdentityProcess
            if (-not $observed.ContainsKey($parentGenerationKey)) { continue }
            $parentStartedAt = [string]$observed[$parentGenerationKey].startedAt
          }
          $entry = [ordered]@{
            role = Get-Role $identityProcess $RootProcessId
            pid = $processId
            parentPid = [int]$identityProcess.ParentProcessId
            parentStartedAt = $parentStartedAt
            sessionId = [int]$identityProcess.SessionId
            imagePath = [IO.Path]::GetFullPath($imagePath)
            imageSha256 = Get-OmniSha256 -LiteralPath $imagePath
            commandLine = [string]$identityProcess.CommandLine
            startedAt = $runtimeProcess.StartTime.ToUniversalTime().ToString('o')
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
          $failedProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue
          if ($failedProcess -and (Get-ProcessGenerationKey $failedProcess) -ceq $key) { throw }
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
$processes = @($observed.Values | Sort-Object `
  @{ Expression = { $_.firstSeenAt } }, @{ Expression = { $_.pid } }, @{ Expression = { $_.startedAt } })
$executionExitCode = $null
try {
  $resolvedExecutionReceiptPath = [IO.Path]::GetFullPath($ExecutionReceiptPath)
  if (-not (Test-Path -LiteralPath $resolvedExecutionReceiptPath -PathType Leaf)) { throw 'interactive cell execution receipt was not published' }
  $executionReceipt = Get-Content -LiteralPath $resolvedExecutionReceiptPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $expectedReceiptIdentity = @{
    executionId = $ExecutionId; planDigest = $PlanDigest; leaseId = $LeaseId; leaseDigest = $LeaseDigest
    cellId = $CellId; workerId = $WorkerId; vmIdentityDigest = $VmIdentityDigest
  }
  foreach ($name in $expectedReceiptIdentity.Keys) {
    if ([string]$executionReceipt.$name -cne [string]$expectedReceiptIdentity[$name]) { throw 'interactive cell execution receipt identity mismatch' }
  }
  $executionExitCode = [int]$executionReceipt.exitCode
} catch { [void]$errors.Add((Format-CollectionError $_)) }
$requiredRoles = @('shard-node', 'cell-powershell')
if ($executionExitCode -eq 0) {
  $requiredRoles += @('desktop', 'bridge')
  if ($RequireRecorder) { $requiredRoles += 'recorder' }
}
foreach ($role in $requiredRoles) {
  if (@($processes | Where-Object { $_.role -eq $role }).Count -lt 1) {
    [void]$errors.Add("required process role was not observed: $role")
  }
}
$payload = [ordered]@{
  schemaVersion = 2; artifactKind = 'watch-mode-interactive-process-authority'
  executionId = $ExecutionId; planDigest = $PlanDigest
  leaseId = $LeaseId; leaseDigest = $LeaseDigest; cellId = $CellId
  workerId = $WorkerId; vmIdentityDigest = $VmIdentityDigest
  rootProcessId = $RootProcessId; expectedSessionId = $ExpectedSessionId; expectedOwnerSid = $ExpectedOwnerSid
  startedAt = $startedAt.ToString('o'); completedAt = [DateTime]::UtcNow.ToString('o')
  sampleIntervalMs = $SampleIntervalMs; executionExitCode = $executionExitCode; requiredRoles = $requiredRoles
  processCount = $processes.Count; processes = $processes; errors = $errors.ToArray()
  passed = $errors.Count -eq 0
}
$resolvedOutputPath = [IO.Path]::GetFullPath($OutputPath)
[void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($resolvedOutputPath))
$encoding = New-Object Text.UTF8Encoding($false)
$bytes = $encoding.GetBytes((($payload | ConvertTo-Json -Depth 12) + "`n"))
$stream = New-Object IO.FileStream($resolvedOutputPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write,
  [IO.FileShare]::Read, 4096, [IO.FileOptions]::WriteThrough)
try {
  $stream.Write($bytes, 0, $bytes.Length)
  $stream.Flush($true)
} finally {
  $stream.Dispose()
}
if (-not $payload.passed) { exit 1 }
