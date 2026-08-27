#requires -Version 5.1

Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.IO.psm1') -Force

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
    [ValidateSet('managed', 'external')][string]$Ownership = 'managed'
  )

  $process = Get-Process -Id $ProcessId -ErrorAction Stop
  $path = Get-OmniProcessExecutablePath -ProcessId $ProcessId
  return [pscustomobject]@{
    schemaVersion = 'omni-process-lease/v1'
    pid = $ProcessId
    startTimeUtcTicks = [long]$process.StartTime.ToUniversalTime().Ticks
    executablePath = $path
    executableSha256 = Get-OmniSha256 -LiteralPath $path
    ownership = $Ownership
    guardianPid = $null
  }
}

function Test-OmniProcessIdentity {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)]$Lease)

  if ($Lease.schemaVersion -cne 'omni-process-lease/v1') { return $false }
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
  foreach ($id in $ids) {
    Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
  }
  Stop-Process -Id ([int]$Lease.pid) -Force -ErrorAction SilentlyContinue
  $deadline = [DateTime]::UtcNow.AddMilliseconds($WaitMilliseconds)
  while ((Get-Process -Id ([int]$Lease.pid) -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 50
  }
  if (Get-Process -Id ([int]$Lease.pid) -ErrorAction SilentlyContinue) {
    throw "owned process did not exit within ${WaitMilliseconds}ms: pid=$($Lease.pid)"
  }
  return [pscustomobject]@{ stopped = $true; pid = [int]$Lease.pid }
}

function Stop-OmniManagedProcessHandle {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process,
    [ValidateRange(100, 30000)][int]$WaitMilliseconds = 3000
  )
  if ($Process.HasExited) {
    return [pscustomobject]@{ stopped = $false; pid = [int]$Process.Id; alreadyExited = $true }
  }
  try {
    $lease = Get-OmniProcessIdentity -ProcessId ([int]$Process.Id) -Ownership managed
  } catch {
    if (-not (Get-Process -Id ([int]$Process.Id) -ErrorAction SilentlyContinue)) {
      return [pscustomobject]@{ stopped = $false; pid = [int]$Process.Id; alreadyExited = $true }
    }
    throw
  }
  Stop-OmniOwnedProcessTree -Lease $lease -WaitMilliseconds $WaitMilliseconds
}

Export-ModuleMember -Function @(
  'Get-OmniProcessIdentity',
  'Test-OmniProcessIdentity',
  'Get-OmniDescendantProcessIds',
  'Stop-OmniOwnedProcessTree',
  'Stop-OmniManagedProcessHandle'
)
