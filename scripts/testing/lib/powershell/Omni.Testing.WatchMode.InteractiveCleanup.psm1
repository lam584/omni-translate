#requires -Version 5.1
Set-StrictMode -Version Latest

function Read-OmniCleanupAuthority {
  param([string]$LiteralPath)
  $item = Get-Item -LiteralPath ([IO.Path]::GetFullPath($LiteralPath)) -Force -ErrorAction Stop
  if ($item.PSIsContainer) { throw 'invalid authority' }
  for ($ancestor = $item; $null -ne $ancestor; $ancestor = $ancestor.Parent) {
    if ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'invalid authority' }
    if ($ancestor -is [IO.FileInfo]) { $ancestor = $ancestor.Directory; if ($null -eq $ancestor) { break } }
    if ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'invalid authority' }
  }
  return (Get-Content -LiteralPath $item.FullName -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop)
}

function Get-OmniCleanupGeneration {
  param($Entry)
  $ticks = [DateTimeOffset]::Parse([string]$Entry.startedAt).UtcTicks
  if ([int]$Entry.pid -le 0 -or $ticks -le 0) { throw 'invalid generation' }
  return ([string]$Entry.pid + ':' + [string]$ticks)
}

function Stop-OmniInteractiveOwnedProcesses {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$LaunchPath,
    [Parameter(Mandatory = $true)][string]$ProcessAuthorityPath,
    [Parameter(Mandatory = $true)]$ExpectedBinding,
    [Parameter(Mandatory = $true)][DateTime]$DeadlineUtc
  )
  $receipt = [ordered]@{ schemaVersion = 1; passed = $false; status = 'authority-invalid'; processes = @() }
  $held = New-Object 'Collections.Generic.List[object]'
  try {
    $launch = Read-OmniCleanupAuthority $LaunchPath
    $authority = Read-OmniCleanupAuthority $ProcessAuthorityPath
    if ($launch.schemaVersion -ne 2 -or $launch.artifactKind -cne 'watch-mode-interactive-shard-launch-authority' -or
      $authority.schemaVersion -ne 2 -or $authority.artifactKind -cne 'watch-mode-interactive-process-authority' -or
      $authority.passed -ne $true -or @($authority.errors).Count -ne 0) { throw 'invalid authority' }
    foreach ($field in @('executionId','planDigest','leaseId','leaseDigest','cellId','workerId','vmIdentityDigest')) {
      $expected = [string]$ExpectedBinding.$field
      if ([string]::IsNullOrWhiteSpace($expected) -or [string]$launch.$field -cne $expected -or [string]$authority.$field -cne $expected) { throw 'binding mismatch' }
    }
    $sid = [string]$ExpectedBinding.expectedUserSid
    $session = [int]$ExpectedBinding.expectedSessionId
    $bios = [string](Get-CimInstance Win32_ComputerSystemProduct -ErrorAction Stop).UUID
    if ($session -le 0 -or $sid -notmatch '^S-1-' -or $bios -ine [string]$ExpectedBinding.expectedVmUuidBios -or
      [string]$launch.actualVmUuidBios -ine $bios -or [string]$launch.ownerSid -cne $sid -or [int]$launch.sessionId -ne $session -or
      [string]$authority.expectedOwnerSid -cne $sid -or [int]$authority.expectedSessionId -ne $session) { throw 'machine identity mismatch' }
    $entries = @($authority.processes)
    if ($entries.Count -eq 0 -or $entries.Count -ne [int]$authority.processCount) { throw 'incomplete authority' }
    $byGeneration = @{}
    foreach ($entry in $entries) {
      if ([DateTime]::UtcNow -ge $DeadlineUtc.ToUniversalTime()) { $receipt.status = 'timeout'; return [pscustomobject]$receipt }
      $key = Get-OmniCleanupGeneration $entry
      if ($byGeneration.ContainsKey($key) -or [int]$entry.sessionId -ne $session -or [string]$entry.ownerSid -cne $sid -or
        [string]$entry.imageSha256 -cnotmatch '^[a-f0-9]{64}$' -or -not [IO.Path]::IsPathRooted([string]$entry.imagePath) -or
        [int]$entry.pid -in @($PID, [int]$launch.taskProcess.pid, [int]$launch.explorerProcess.pid) -or
        [IO.Path]::GetFileName([string]$entry.imagePath) -ieq 'explorer.exe') { throw 'invalid process identity' }
      $byGeneration[$key] = $entry
    }
    $rootKey = Get-OmniCleanupGeneration $launch.nodeProcess
    $root = $byGeneration[$rootKey]
    if ($null -eq $root -or [int]$authority.rootProcessId -ne [int]$root.pid -or $root.role -cne 'shard-node' -or
      [int]$root.parentPid -ne [int]$launch.taskProcess.pid -or
      [int]$launch.nodeProcess.parentPid -ne [int]$launch.taskProcess.pid -or
      [int]$launch.taskProcess.sessionId -ne $session -or [string]$launch.taskProcess.ownerSid -cne $sid -or
      [DateTimeOffset]::Parse([string]$launch.taskProcess.startedAt) -gt [DateTimeOffset]::Parse([string]$root.startedAt) -or
      [int]$launch.nodeProcess.sessionId -ne $session -or [string]$launch.nodeProcess.ownerSid -cne $sid -or
      [string]$root.imagePath -ine [string]$launch.nodeProcess.imagePath -or [string]$root.imageSha256 -cne [string]$launch.nodeProcess.imageSha256) { throw 'root mismatch' }
    $ordered = @()
    foreach ($entry in $entries) {
      if ([DateTime]::UtcNow -ge $DeadlineUtc.ToUniversalTime()) { $receipt.status = 'timeout'; return [pscustomobject]$receipt }
      $cursor = $entry; $visited = @{}; $depth = 0
      while ((Get-OmniCleanupGeneration $cursor) -cne $rootKey) {
        if ([DateTime]::UtcNow -ge $DeadlineUtc.ToUniversalTime()) { $receipt.status = 'timeout'; return [pscustomobject]$receipt }
        $key = Get-OmniCleanupGeneration $cursor
        if ($visited.ContainsKey($key)) { throw 'generation cycle' }
        $visited[$key] = $true
        $parentKey = [string]$cursor.parentPid + ':' + [string]([DateTimeOffset]::Parse([string]$cursor.parentStartedAt).UtcTicks)
        $parent = $byGeneration[$parentKey]
        if ($null -eq $parent -or [DateTimeOffset]::Parse([string]$parent.startedAt) -gt [DateTimeOffset]::Parse([string]$cursor.startedAt)) { throw 'parent generation mismatch' }
        $cursor = $parent; $depth++
      }
      $ordered += [pscustomobject]@{ entry = $entry; depth = $depth }
    }
    # Validate every live identity before terminating any process. These are
    # re-opened, authority-bound handles, not fabricated launch custody leases.
    $receipt.status = 'identity-unavailable'
    foreach ($item in ($ordered | Sort-Object depth -Descending)) {
      if ([DateTime]::UtcNow -ge $DeadlineUtc.ToUniversalTime()) { $receipt.status = 'timeout'; return [pscustomobject]$receipt }
      $entry = $item.entry
      $state = [pscustomobject]@{ pid = [int]$entry.pid; status = 'identity-unavailable'; terminated = $false }
      $receipt.processes += $state
      try { $process = [Diagnostics.Process]::GetProcessById([int]$entry.pid) }
      catch [ArgumentException] { $state.status = 'already-exited'; continue }
      $held.Add([pscustomobject]@{ process = $process; state = $state; eligible = $false })
      $bound = $held[$held.Count - 1]
      try { $nativeHandle = $process.Handle }
      catch { if ($process.HasExited) { $state.status = 'already-exited'; continue }; throw }
      if ($process.StartTime.ToUniversalTime().Ticks -ne [DateTimeOffset]::Parse([string]$entry.startedAt).UtcTicks) {
        $state.status = 'original-generation-ended'; continue
      }
      $actualPath = $process.Path
      $actual = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [string]$entry.pid) -ErrorAction Stop
      $owner = Invoke-CimMethod -InputObject $actual -MethodName GetOwnerSid -ErrorAction Stop
      if ($process.HasExited) { $state.status = 'already-exited'; continue }
      if ($actualPath -ine [IO.Path]::GetFullPath([string]$entry.imagePath) -or $process.SessionId -ne $session -or
        [string]$owner.Sid -cne $sid -or $owner.ReturnValue -ne 0 -or
        (Get-FileHash -LiteralPath $actualPath -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant() -cne [string]$entry.imageSha256) {
        $state.status = 'identity-mismatch'; $receipt.status = 'identity-mismatch'; return [pscustomobject]$receipt
      }
      $state.status = 'verified'; $bound.eligible = $true
    }
    foreach ($bound in $held) {
      if (-not $bound.eligible) { continue }
      if ($bound.process.HasExited) { $bound.state.status = 'already-exited'; continue }
      $remaining = [Math]::Floor(($DeadlineUtc.ToUniversalTime() - [DateTime]::UtcNow).TotalMilliseconds)
      if ($remaining -le 0) { $bound.state.status = 'timeout'; $receipt.status = 'timeout'; return [pscustomobject]$receipt }
      $bound.process.Kill()
      if (-not $bound.process.WaitForExit([int][Math]::Min($remaining, 5000))) { $bound.state.status = 'timeout'; $receipt.status = 'timeout'; return [pscustomobject]$receipt }
      $bound.state.status = 'terminated'; $bound.state.terminated = $true
    }
    $receipt.passed = $true; $receipt.status = 'completed'
  } catch {
    # Preserve only a fixed failure class; authority/OS text can contain secrets.
  } finally {
    foreach ($bound in $held) { $bound.process.Dispose() }
  }
  return [pscustomobject]$receipt
}

Export-ModuleMember -Function Stop-OmniInteractiveOwnedProcesses
