#requires -Version 5.1

Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.IO.psm1') -Force

function Get-OmniProcessCustodyRegistry {
  $key = 'Omni.Testing.ProcessCustodyRegistry.v1'
  $registry = [AppDomain]::CurrentDomain.GetData($key)
  if ($null -eq $registry) {
    $registry = [hashtable]::Synchronized(@{})
    [AppDomain]::CurrentDomain.SetData($key, $registry)
  }
  return $registry
}

function Test-OmniProcessCustodyRecord {
  param([Parameter(Mandatory = $true)]$Lease, [Parameter(Mandatory = $true)]$Record)
  return (
    [string]$Lease.schemaVersion -ceq 'omni-process-lease/v1' -and
    [string]$Lease.ownership -ceq 'managed' -and
    [string]$Lease.custodyId -ceq [string]$Record.custodyId -and
    [string]$Lease.launchId -ceq [string]$Record.launchId -and
    [int]$Lease.pid -eq [int]$Record.pid -and
    [long]$Lease.startTimeUtcTicks -eq [long]$Record.startTimeUtcTicks -and
    [string]$Lease.executableSha256 -ceq [string]$Record.executableSha256 -and
    [System.IO.Path]::GetFullPath([string]$Lease.executablePath).Equals(
      [string]$Record.executablePath, [StringComparison]::OrdinalIgnoreCase
    )
  )
}

function Get-OmniProcessExecutablePath {
  param([Parameter(Mandatory = $true)][int]$ProcessId)

  $process = Get-Process -Id $ProcessId -ErrorAction Stop
  if (-not [string]::IsNullOrWhiteSpace($process.Path)) {
    return [System.IO.Path]::GetFullPath($process.Path)
  }
  $cim = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction Stop
  if ([string]::IsNullOrWhiteSpace($cim.ExecutablePath)) {
    throw "process executable path is unavailable: pid=$ProcessId"
  }
  return [System.IO.Path]::GetFullPath([string]$cim.ExecutablePath)
}

function Get-OmniProcessIdentity {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [ValidateSet('managed', 'external')][string]$Ownership = 'managed',
    [string]$LaunchId,
    [System.Diagnostics.Process]$ProcessHandle
  )

  $process = if ($ProcessHandle) { $ProcessHandle } else { Get-Process -Id $ProcessId -ErrorAction Stop }
  if ([int]$process.Id -ne $ProcessId) { throw "process handle does not match requested pid: expected=$ProcessId observed=$($process.Id)" }
  if ($ProcessHandle) {
    try { $null = $process.Handle }
    catch { throw "failed to acquire launch-owned process handle before custody registration: pid=$ProcessId error=$($_.Exception.Message)" }
  }
  $path = Get-OmniProcessExecutablePath -ProcessId $ProcessId
  $hash = Get-OmniSha256 -LiteralPath $path
  $custodyId = if ($Ownership -eq 'managed') { [guid]::NewGuid().ToString('N') } else { $null }
  if ([string]::IsNullOrWhiteSpace($LaunchId)) { $LaunchId = [guid]::NewGuid().ToString() }
  $lease = [pscustomobject]@{
    schemaVersion = 'omni-process-lease/v1'
    custodyId = $custodyId
    launchId = $LaunchId
    pid = $ProcessId
    startTimeUtcTicks = [long]$process.StartTime.ToUniversalTime().Ticks
    executablePath = $path
    executableSha256 = $hash
    ownership = $Ownership
    guardianPid = $null
  }
  if ($custodyId) {
    (Get-OmniProcessCustodyRegistry)[$custodyId] = [pscustomobject]@{
      custodyId = $custodyId; launchId = $LaunchId; process = $process; hasExitAuthority = [bool]$ProcessHandle; pid = $ProcessId
      startTimeUtcTicks = [long]$lease.startTimeUtcTicks; executablePath = $path; executableSha256 = $hash
    }
  }
  return $lease
}

function Test-OmniProcessIdentity {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)]$Lease, [switch]$Detailed)

  $result = Get-OmniProcessIdentityState -Lease $Lease
  if ($Detailed) { return $result }
  return $result.status -eq 'current'
}

function Get-OmniProcessIdentityState {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)]$Lease)

  if ($Lease.schemaVersion -cne 'omni-process-lease/v1') {
    return [pscustomobject]@{ status = 'unverifiable'; process = $null; error = 'unsupported process lease schema' }
  }
  $record = (Get-OmniProcessCustodyRegistry)[[string]$Lease.custodyId]
  if ($null -eq $record -or -not (Test-OmniProcessCustodyRecord -Lease $Lease -Record $record)) {
    return [pscustomobject]@{ status = 'unverifiable'; process = $null; error = 'process launch custody is missing or does not match its lease' }
  }
  if ($record.hasExitAuthority) {
    try {
      $record.process.Refresh()
      if ($record.process.HasExited) { return [pscustomobject]@{ status = 'exited'; process = $record.process; error = $null } }
    } catch { return [pscustomobject]@{ status = 'unverifiable'; process = $record.process; error = $_.Exception.Message } }
  }
  try { $process = Get-Process -Id ([int]$Lease.pid) -ErrorAction Stop } catch {
    if ($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId*') { return [pscustomobject]@{ status = 'exited'; process = $null; error = $null } }
    return [pscustomobject]@{ status = 'unverifiable'; process = $null; error = $_.Exception.Message }
  }
  try {
    $null = $process.Handle
    if ([long]$process.StartTime.ToUniversalTime().Ticks -ne [long]$Lease.startTimeUtcTicks) { return [pscustomobject]@{ status = 'reused'; process = $process; error = $null } }
    $actualPath = if (-not [string]::IsNullOrWhiteSpace($process.Path)) { [System.IO.Path]::GetFullPath($process.Path) } else { Get-OmniProcessExecutablePath -ProcessId ([int]$Lease.pid) }
    $expectedPath = [System.IO.Path]::GetFullPath([string]$Lease.executablePath)
    if (-not $actualPath.Equals($expectedPath, [StringComparison]::OrdinalIgnoreCase)) { return [pscustomobject]@{ status = 'reused'; process = $process; error = $null } }
    if ($Lease.executableSha256) {
      $actualHash = Get-OmniSha256 -LiteralPath $actualPath
      if ($actualHash -cne [string]$Lease.executableSha256) { return [pscustomobject]@{ status = 'reused'; process = $process; error = $null } }
    }
    return [pscustomobject]@{ status = 'current'; process = $process; error = $null }
  } catch {
    if ($record.hasExitAuthority) { try { $record.process.Refresh(); if ($record.process.HasExited) { return [pscustomobject]@{ status = 'exited'; process = $record.process; error = $null } } } catch {} }
    return [pscustomobject]@{ status = 'unverifiable'; process = $process; error = $_.Exception.Message }
  }
}

function Wait-OmniManagedProcessExit {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]$Lease,
    [Parameter(Mandatory = $true)][DateTime]$DeadlineUtc
  )
  if ([string]$Lease.ownership -cne 'managed' -or [string]::IsNullOrWhiteSpace([string]$Lease.custodyId)) {
    throw 'managed process exit requires a launch custody lease'
  }
  $registry = Get-OmniProcessCustodyRegistry
  $record = $registry[[string]$Lease.custodyId]
  if ($null -eq $record -or -not (Test-OmniProcessCustodyRecord -Lease $Lease -Record $record)) {
    throw "process launch custody is missing or does not match its lease: pid=$($Lease.pid)"
  }
  if (-not $record.hasExitAuthority) { throw "process custody lease has no launch-owned exit authority: pid=$($Lease.pid)" }
  $remainingMs = [Math]::Floor(($DeadlineUtc.ToUniversalTime() - [DateTime]::UtcNow).TotalMilliseconds)
  if ($remainingMs -le 0 -or -not $record.process.WaitForExit([int][Math]::Min($remainingMs, [int]::MaxValue))) {
    throw "timed out waiting for custodied process exit: pid=$($Lease.pid) deadlineUtc=$($DeadlineUtc.ToUniversalTime().ToString('o'))"
  }
  $record.process.Refresh()
  $observedExitCode = $record.process.ExitCode
  if ($null -eq $observedExitCode) { throw "custodied process exit code is unavailable: pid=$($Lease.pid)" }
  $exitCode = [int]$observedExitCode
  $registry.Remove([string]$Lease.custodyId)
  return [pscustomobject]@{
    pid = [int]$Lease.pid; startTimeUtcTicks = [long]$Lease.startTimeUtcTicks
    executableSha256 = [string]$Lease.executableSha256; launchId = [string]$Lease.launchId; exitCode = $exitCode
  }
}

function Get-OmniProcessStartTimeUtcTicks {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)]$Process)

  if ($Process.PSObject.Properties.Name -contains 'StartTimeUtcTicks') { return [long]$Process.StartTimeUtcTicks }
  if ($Process.PSObject.Properties.Name -contains 'CreationDate') {
    $created = $Process.CreationDate
    if ($created -is [DateTime]) { return [long]$created.ToUniversalTime().Ticks }
    if (-not [string]::IsNullOrWhiteSpace([string]$created)) { return [long]([System.Management.ManagementDateTimeConverter]::ToDateTime([string]$created).ToUniversalTime().Ticks) }
  }
  if ($Process.PSObject.Properties.Name -contains 'StartTime') { return [long]$Process.StartTime.ToUniversalTime().Ticks }
  throw 'process creation time is unavailable'
}

function ConvertTo-OmniProcessGenerationTicks {
  param([Parameter(Mandatory = $true)][long]$Ticks)

  # Win32_Process.CreationDate has microsecond precision, while Process.StartTime
  # can expose 100-nanosecond ticks. Compare at the shared precision.
  return $Ticks - ($Ticks % 10)
}

function Get-OmniDescendantProcessTargets {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][int]$RootProcessId,
    [Parameter(Mandatory = $true)][long]$RootStartTimeUtcTicks,
    [object[]]$ProcessSnapshot
  )

  $rootGeneration = ConvertTo-OmniProcessGenerationTicks -Ticks $RootStartTimeUtcTicks
  $all = if ($null -ne $ProcessSnapshot) { @($ProcessSnapshot) } else { @(Get-CimInstance Win32_Process -ErrorAction Stop) }
  $childrenByParent = @{}
  foreach ($item in $all) {
    $processId = [int]$item.ProcessId
    $parentId = [int]$item.ParentProcessId
    if ($processId -le 0 -or $processId -eq $parentId) { continue }
    $startTimeUtcTicks = $null
    $generationError = $null
    try { $startTimeUtcTicks = Get-OmniProcessStartTimeUtcTicks -Process $item } catch { $generationError = $_.Exception.Message }
    if (-not $childrenByParent.ContainsKey($parentId)) { $childrenByParent[$parentId] = New-Object System.Collections.Generic.List[object] }
    $childrenByParent[$parentId].Add([pscustomobject]@{
      pid = $processId
      parentPid = $parentId
      startTimeUtcTicks = if ($null -eq $startTimeUtcTicks) { $null } else { ConvertTo-OmniProcessGenerationTicks -Ticks $startTimeUtcTicks }
      generationError = $generationError
    }) | Out-Null
  }
  $result = New-Object System.Collections.Generic.List[object]
  $pending = New-Object System.Collections.Generic.Stack[object]
  $pending.Push([pscustomobject]@{ pid = $RootProcessId; startTimeUtcTicks = $rootGeneration })
  $visited = @{ "$($RootProcessId):$rootGeneration" = $true }
  while ($pending.Count -gt 0) {
    $parent = $pending.Pop()
    if (-not $childrenByParent.ContainsKey([int]$parent.pid)) { continue }
    foreach ($child in $childrenByParent[[int]$parent.pid]) {
      if ($null -ne $child.generationError) {
        throw "reachable descendant generation is unverifiable: parentPid=$($parent.pid) pid=$($child.pid) error=$($child.generationError)"
      }
      # ParentProcessId has no generation; creation ordering rejects stale PID ancestry.
      if ([long]$child.startTimeUtcTicks -lt $rootGeneration -or
          [long]$child.startTimeUtcTicks -lt [long]$parent.startTimeUtcTicks) { continue }
      $key = "$($child.pid):$($child.startTimeUtcTicks)"
      if ($visited.ContainsKey($key)) { continue }
      $visited[$key] = $true
      $result.Add($child) | Out-Null
      $pending.Push($child)
    }
  }
  return $result.ToArray()
}

function Get-OmniProcessGenerationState {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)]$Target)

  try {
    $process = Get-Process -Id ([int]$Target.pid) -ErrorAction Stop
  } catch {
    if ($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId*') {
      return [pscustomobject]@{ status = 'absent'; process = $null; error = $null }
    }
    return [pscustomobject]@{ status = 'unverifiable'; process = $null; error = $_.Exception.Message }
  }
  try {
    # Force PS5's lazy Process wrapper to bind a native SafeProcessHandle before
    # reading identity. Keep this same object alive through any subsequent Kill.
    $null = $process.Handle
    if ($process.HasExited) {
      return [pscustomobject]@{ status = 'absent'; process = $process; error = $null }
    }
    $actualTicks = $null
    try { $actualTicks = Get-OmniProcessStartTimeUtcTicks -Process $process } catch {
      # Windows PowerShell 5 can expose a live, handle-bound Process wrapper with
      # a transiently null StartTime. Fall back to the CIM creation timestamp,
      # but keep the original native handle as the only termination authority.
      $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$Target.pid)" -ErrorAction Stop
      if ($null -eq $cim) {
        return [pscustomobject]@{ status = 'absent'; process = $process; error = $null }
      }
      $actualTicks = Get-OmniProcessStartTimeUtcTicks -Process $cim
    }
    if ($process.HasExited) {
      return [pscustomobject]@{ status = 'absent'; process = $process; error = $null }
    }
    $actual = ConvertTo-OmniProcessGenerationTicks -Ticks ([long]$actualTicks)
  } catch {
    return [pscustomobject]@{ status = 'unverifiable'; process = $process; error = $_.Exception.Message }
  }
  $expected = ConvertTo-OmniProcessGenerationTicks -Ticks ([long]$Target.startTimeUtcTicks)
  $status = if ($actual -eq $expected) { 'current' } else { 'reused' }
  return [pscustomobject]@{ status = $status; process = $process; error = $null }
}

function Stop-OmniProcessGeneration {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)]$Target)

  $generation = Get-OmniProcessGenerationState -Target $Target
  try {
    if ($generation.status -eq 'absent' -or $generation.status -eq 'reused') { return $false }
    if ($generation.status -ne 'current') { throw "process generation could not be verified before termination: pid=$($Target.pid) error=$($generation.error)" }
    # Kill through the already generation-checked, handle-bound Process object.
    try { $generation.process.Kill() } catch { return $false }
    return $true
  } finally {
    if ($null -ne $generation.process -and $generation.process.PSObject.Methods.Name -contains 'Dispose') { $generation.process.Dispose() }
  }
}

function Stop-OmniOwnedProcessTree {
  param([Parameter(Mandatory = $true)]$Lease, [ValidateRange(100, 30000)][int]$WaitMilliseconds = 3000)
  if ([string]$Lease.ownership -cne 'managed') { throw "refusing to stop an externally owned process: pid=$($Lease.pid)" }
  $identity = Get-OmniProcessIdentityState -Lease $Lease
  if ($identity.status -eq 'exited') {
    (Get-OmniProcessCustodyRegistry).Remove([string]$Lease.custodyId)
    return [pscustomobject]@{ stopped = $false; pid = [int]$Lease.pid; alreadyExited = $true; identityStatus = 'exited' }
  }
  if ($identity.status -ne 'current') { throw "refusing to stop a process whose identity is not current: pid=$($Lease.pid) status=$($identity.status) error=$($identity.error)" }
  $targets = @((Get-OmniDescendantProcessTargets -RootProcessId ([int]$Lease.pid) -RootStartTimeUtcTicks ([long]$Lease.startTimeUtcTicks)))
  [array]::Reverse($targets)
  $rootTarget = [pscustomobject]@{ pid = [int]$Lease.pid; startTimeUtcTicks = [long]$Lease.startTimeUtcTicks }
  $allTargets = @($targets) + @($rootTarget)
  # Never pass a previously checked numeric PID to a separate tree-kill utility.
  # Each leaf-to-root termination re-reads the generation and kills through that
  # same handle-bound Process object. A reused PID is skipped, and an identity
  # lookup that cannot be proved fails closed.
  $terminationResults = @(foreach ($target in $allTargets) {
    [pscustomobject]@{
      pid = [int]$target.pid
      startTimeUtcTicks = [long]$target.startTimeUtcTicks
      killRequested = [bool](Stop-OmniProcessGeneration -Target $target)
    }
  })
  $deadline = [DateTime]::UtcNow.AddMilliseconds($WaitMilliseconds)
  do {
    $remaining = @(foreach ($target in $allTargets) {
      $generation = Get-OmniProcessGenerationState -Target $target
      try {
        if ($generation.status -eq 'current' -or $generation.status -eq 'unverifiable') {
          [pscustomobject]@{ pid = [int]$target.pid; status = $generation.status; error = $generation.error }
        }
      } finally {
        if ($null -ne $generation.process -and $generation.process.PSObject.Methods.Name -contains 'Dispose') { $generation.process.Dispose() }
      }
    })
    $remainingIds = @($remaining | ForEach-Object { [int]$_.pid })
    if ($remainingIds.Count -eq 0) { break }
    Start-Sleep -Milliseconds 50
  } while ([DateTime]::UtcNow -lt $deadline)
  if ($remainingIds.Count -gt 0) {
    $unverifiable = @($remaining | Where-Object { $_.status -eq 'unverifiable' } | ForEach-Object { "pid=$($_.pid):$($_.error)" })
    throw "owned process tree did not exit within ${WaitMilliseconds}ms: rootPid=$($Lease.pid) remainingPids=$($remainingIds -join ',') unverifiable=$($unverifiable -join ';')"
  }
  (Get-OmniProcessCustodyRegistry).Remove([string]$Lease.custodyId)
  return [pscustomobject]@{ stopped = $true; pid = [int]$Lease.pid; terminationResults = $terminationResults }
}

function Stop-OmniManagedProcessHandle {
  param([Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process, [ValidateRange(100, 30000)][int]$WaitMilliseconds = 3000)
  if ($Process.HasExited) { return [pscustomobject]@{ stopped = $false; pid = [int]$Process.Id; alreadyExited = $true } }
  try {
    $lease = Get-OmniProcessIdentity -ProcessId ([int]$Process.Id) -Ownership managed -ProcessHandle $Process
  } catch {
    try { $Process.Refresh() } catch {}
    if (-not $Process.HasExited) { throw }
    return [pscustomobject]@{ stopped = $false; pid = [int]$Process.Id; alreadyExited = $true }
  }
  return Stop-OmniOwnedProcessTree -Lease $lease -WaitMilliseconds $WaitMilliseconds
}
Export-ModuleMember -Function @(
  'Get-OmniProcessIdentity',
  'Get-OmniProcessIdentityState',
  'Test-OmniProcessIdentity',
  'Wait-OmniManagedProcessExit',
  'Stop-OmniOwnedProcessTree',
  'Stop-OmniManagedProcessHandle'
)
