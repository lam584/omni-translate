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
  param([Parameter(Mandatory = $true)]$Lease)

  if ($Lease.schemaVersion -cne 'omni-process-lease/v1') { return $false }
  $record = (Get-OmniProcessCustodyRegistry)[[string]$Lease.custodyId]
  if ($null -eq $record -or -not (Test-OmniProcessCustodyRecord -Lease $Lease -Record $record)) { return $false }
  $process = Get-Process -Id ([int]$Lease.pid) -ErrorAction SilentlyContinue
  if (-not $process) { return $false }
  try {
    $actualPath = Get-OmniProcessExecutablePath -ProcessId ([int]$Lease.pid)
    $expectedPath = [System.IO.Path]::GetFullPath([string]$Lease.executablePath)
    if (-not $actualPath.Equals($expectedPath, [StringComparison]::OrdinalIgnoreCase)) { return $false }
    if ([long]$process.StartTime.ToUniversalTime().Ticks -ne [long]$Lease.startTimeUtcTicks) { return $false }
    if ($Lease.executableSha256) {
      $actualHash = Get-OmniSha256 -LiteralPath $actualPath
      if ($actualHash -cne [string]$Lease.executableSha256) { return $false }
    }
    return $true
  } catch {
    return $false
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

function Get-OmniDescendantProcessIds {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][int]$RootProcessId)

  $all = @(Get-CimInstance Win32_Process -ErrorAction Stop)
  $childrenByParent = @{}
  foreach ($item in $all) {
    $parentId = [int]$item.ParentProcessId
    if (-not $childrenByParent.ContainsKey($parentId)) {
      $childrenByParent[$parentId] = New-Object System.Collections.Generic.List[int]
    }
    $childrenByParent[$parentId].Add([int]$item.ProcessId) | Out-Null
  }
  $result = New-Object System.Collections.Generic.List[int]
  $pending = New-Object System.Collections.Generic.Stack[int]
  $pending.Push($RootProcessId)
  while ($pending.Count -gt 0) {
    $parent = $pending.Pop()
    if (-not $childrenByParent.ContainsKey($parent)) { continue }
    foreach ($child in $childrenByParent[$parent]) {
      $result.Add($child) | Out-Null
      $pending.Push($child)
    }
  }
  return @($result)
}

function Stop-OmniOwnedProcessTree {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]$Lease,
    [ValidateRange(100, 30000)][int]$WaitMilliseconds = 3000
  )

  if ([string]$Lease.ownership -cne 'managed') {
    throw "refusing to stop an externally owned process: pid=$($Lease.pid)"
  }
  if (-not (Test-OmniProcessIdentity -Lease $Lease)) {
    throw "refusing to stop a process whose identity no longer matches its lease: pid=$($Lease.pid)"
  }
  $ids = @((Get-OmniDescendantProcessIds -RootProcessId ([int]$Lease.pid)))
  [array]::Reverse($ids)
  $targetIds = @($ids) + @([int]$Lease.pid)
  # The root identity was validated immediately above. Ask Windows to terminate
  # the live tree atomically as well, so a child created after the CIM snapshot
  # cannot retain inherited stdout/stderr handles past this cleanup boundary.
  & taskkill.exe /PID ([int]$Lease.pid) /T /F 2>&1 | Out-Null
  foreach ($id in $ids) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
  Stop-Process -Id ([int]$Lease.pid) -Force -ErrorAction SilentlyContinue
  $deadline = [DateTime]::UtcNow.AddMilliseconds($WaitMilliseconds)
  do {
    $remainingIds = @($targetIds | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
    if ($remainingIds.Count -eq 0) { break }
    Start-Sleep -Milliseconds 50
  } while ([DateTime]::UtcNow -lt $deadline)
  if ($remainingIds.Count -gt 0) {
    throw "owned process tree did not exit within ${WaitMilliseconds}ms: rootPid=$($Lease.pid) remainingPids=$($remainingIds -join ',')"
  }
  (Get-OmniProcessCustodyRegistry).Remove([string]$Lease.custodyId)
  return [pscustomobject]@{ stopped = $true; pid = [int]$Lease.pid }
}

function Stop-OmniManagedProcessHandle {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process,
    [ValidateRange(100, 30000)][int]$WaitMilliseconds = 3000
  )
  if ($Process.HasExited) { return [pscustomobject]@{ stopped = $false; pid = [int]$Process.Id; alreadyExited = $true } }
  try {
    $lease = Get-OmniProcessIdentity -ProcessId ([int]$Process.Id) -Ownership managed
  } catch {
    if (Get-Process -Id ([int]$Process.Id) -ErrorAction SilentlyContinue) { throw }
    return [pscustomobject]@{ stopped = $false; pid = [int]$Process.Id; alreadyExited = $true }
  }
  try {
    return Stop-OmniOwnedProcessTree -Lease $lease -WaitMilliseconds $WaitMilliseconds
  } catch {
    $Process.Refresh()
    if (-not $Process.HasExited) { throw }
    return [pscustomobject]@{ stopped = $false; pid = [int]$Process.Id; alreadyExited = $true; identityEndedDuringCleanup = $true }
  }
}
Export-ModuleMember -Function @(
  'Get-OmniProcessIdentity',
  'Test-OmniProcessIdentity',
  'Wait-OmniManagedProcessExit',
  'Get-OmniDescendantProcessIds',
  'Stop-OmniOwnedProcessTree',
  'Stop-OmniManagedProcessHandle'
)
