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

function Stop-OmniInteractiveTerminalProcesses {
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



# A request is only a message to the launch owner, never recovered kill custody.
# Terminal collector evidence remains a separate, immutable artifact.
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.IO.psm1') -Force

function Get-OmniInteractiveCancellationBinding {
  param([string]$LaunchPath, $ExpectedBinding)
  $commandPath = Join-Path ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($LaunchPath))) 'command.json'
  $command = Read-OmniCleanupAuthority $commandPath
  if ($command.schemaVersion -ne 2 -or $command.artifactKind -cne 'watch-mode-interactive-task-command' -or
    $command.mode -notin @('shard-cell','incident-plus-cell','local-aec-probe') -or
    [IO.Path]::GetFullPath([string]$command.launchPath) -ine [IO.Path]::GetFullPath($LaunchPath)) { throw 'invalid cancellation command' }
  foreach ($field in @('executionId','planDigest','leaseId','leaseDigest','cellId','workerId','vmIdentityDigest','expectedUserSid','expectedSessionId')) {
    if ([string]::IsNullOrWhiteSpace([string]$ExpectedBinding.$field) -or [string]$command.$field -cne [string]$ExpectedBinding.$field) { throw 'command binding mismatch' }
  }
  $bios = [string](Get-CimInstance Win32_ComputerSystemProduct -ErrorAction Stop).UUID
  if ($command.expectedUserSid -notmatch '^S-1-' -or [int]$command.expectedSessionId -le 0 -or
    $bios -ine [string]$ExpectedBinding.expectedVmUuidBios -or $command.expectedVmUuidBios -ine $bios) { throw 'command machine mismatch' }
  $binding = [ordered]@{}
  foreach ($field in @('executionId','planDigest','leaseId','leaseDigest','cellId','workerId','vmIdentityDigest')) { $binding[$field] = [string]$command.$field }
  $binding.commandSha256 = (Get-FileHash -LiteralPath $commandPath -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
  return [pscustomobject]$binding
}

function Test-OmniInteractiveCancellationIntent {
  param([string]$LaunchPath, $Binding)
  $requestPath = Join-Path ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($LaunchPath))) 'cancel-request.json'
  if (-not (Test-Path -LiteralPath $requestPath)) { return $false }
  Test-OmniInteractiveJobMessage (Read-OmniCleanupAuthority $requestPath) $Binding 'watch-mode-interactive-job-cancel-request'
  return $true
}

function Get-OmniInteractiveJobBinding {
  param([string]$LaunchPath, $ExpectedBinding)
  $launch = Read-OmniCleanupAuthority $LaunchPath
  if ($launch.schemaVersion -ne 2 -or $launch.artifactKind -cne 'watch-mode-interactive-shard-launch-authority') { throw 'invalid launch authority' }
  foreach ($field in @('executionId','planDigest','leaseId','leaseDigest','cellId','workerId','vmIdentityDigest')) {
    if ([string]::IsNullOrWhiteSpace([string]$ExpectedBinding.$field) -or [string]$launch.$field -cne [string]$ExpectedBinding.$field) { throw 'binding mismatch' }
  }
  $sid = [string]$ExpectedBinding.expectedUserSid
  $session = [int]$ExpectedBinding.expectedSessionId
  $bios = [string](Get-CimInstance Win32_ComputerSystemProduct -ErrorAction Stop).UUID
  if ($sid -notmatch '^S-1-' -or $session -le 0 -or $bios -ine [string]$ExpectedBinding.expectedVmUuidBios -or
    $launch.actualVmUuidBios -ine $bios -or $launch.ownerSid -cne $sid -or $launch.sessionId -ne $session) { throw 'machine identity mismatch' }
  foreach ($entry in @($launch.nodeProcess, $launch.taskProcess)) {
    $null = Get-OmniCleanupGeneration $entry
    if ($entry.ownerSid -cne $sid -or $entry.sessionId -ne $session -or
      $entry.imageSha256 -cnotmatch '^[a-f0-9]{64}$' -or -not [IO.Path]::IsPathRooted([string]$entry.imagePath)) { throw 'invalid launch identity' }
  }
  if ($launch.nodeProcess.parentPid -ne $launch.taskProcess.pid -or
    [DateTimeOffset]::Parse($launch.taskProcess.startedAt) -gt [DateTimeOffset]::Parse($launch.nodeProcess.startedAt) -or
    $launch.commandSha256 -cnotmatch '^[a-f0-9]{64}$' -or
    $launch.jobCustody.schemaVersion -ne 1 -or $launch.jobCustody.kind -cne 'unnamed-kill-on-close-job' -or
    $launch.jobCustody.custodyId -cnotmatch '^[a-f0-9]{32}$') { throw 'invalid job custody binding' }
  $binding = Get-OmniInteractiveCancellationBinding $LaunchPath $ExpectedBinding
  if ($launch.commandSha256 -cne $binding.commandSha256) { throw 'launch command hash mismatch' }
  $binding | Add-Member -NotePropertyName custodyId -NotePropertyValue ([string]$launch.jobCustody.custodyId)
  $binding | Add-Member -NotePropertyName launchSha256 -NotePropertyValue ((Get-FileHash -LiteralPath $LaunchPath -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant())
  return $binding
}

function Test-OmniInteractiveJobMessage {
  param($Message, $Binding, [string]$Kind)
  if ($Message.schemaVersion -ne 1 -or $Message.artifactKind -cne $Kind) { throw 'invalid custody message' }
  foreach ($field in @('executionId','planDigest','leaseId','leaseDigest','cellId','workerId','vmIdentityDigest','commandSha256')) {
    if ([string]$Message.$field -cne [string]$Binding.$field) { throw 'custody message binding mismatch' }
  }
}

function New-OmniInteractiveJobMessage {
  param($Binding, [string]$Kind)
  $message = [ordered]@{ schemaVersion = 1; artifactKind = $Kind }
  foreach ($field in @('executionId','planDigest','leaseId','leaseDigest','cellId','workerId','vmIdentityDigest','commandSha256')) { $message[$field] = $Binding.$field }
  return $message
}

function Request-OmniInteractiveJobCancellation {
  param([Parameter(Mandatory = $true)][string]$LaunchPath, [Parameter(Mandatory = $true)]$Binding)
  $requestPath = Join-Path ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($LaunchPath))) 'cancel-request.json'
  $message = New-OmniInteractiveJobMessage $Binding 'watch-mode-interactive-job-cancel-request'
  if (-not (Test-Path -LiteralPath $requestPath)) {
    try { Write-OmniImmutableJson -LiteralPath $requestPath -Value $message }
    catch { if (-not (Test-Path -LiteralPath $requestPath -PathType Leaf)) { throw } }
  }
  Test-OmniInteractiveJobMessage (Read-OmniCleanupAuthority $requestPath) $Binding 'watch-mode-interactive-job-cancel-request'
}

function Complete-OmniInteractiveJobCleanup {
  param([Parameter(Mandatory = $true)]$Job, [Parameter(Mandatory = $true)][string]$LaunchPath,
    [Parameter(Mandatory = $true)][AllowNull()]$Binding, [Parameter(Mandatory = $true)][DateTime]$DeadlineUtc, $ExpectedBinding)
  # Termination/drain uses retained kernel custody even if initial validation
  # failed. Reconciliation never uses stored PIDs as termination authority.
  $Job.Cancel()
  while ($Job.ActiveProcesses -ne 0 -or -not $Job.HasExited) {
    if ([DateTime]::UtcNow -ge $DeadlineUtc.ToUniversalTime()) { throw 'owned job exception cleanup unconfirmed' }
    Start-Sleep -Milliseconds 10
  }
  if ([DateTime]::UtcNow -ge $DeadlineUtc.ToUniversalTime()) { throw 'owned job reconciliation deadline expired' }
  if ($null -eq $Binding) {
    if ($null -eq $ExpectedBinding -or -not (Test-Path -LiteralPath $LaunchPath -PathType Leaf)) { throw 'committed launch binding is unavailable' }
    # One full revalidation after draining, within the SAME cleanup deadline.
    $Binding = Get-OmniInteractiveJobBinding -LaunchPath $LaunchPath -ExpectedBinding $ExpectedBinding
  }
  if ([DateTime]::UtcNow -ge $DeadlineUtc.ToUniversalTime()) { throw 'owned job reconciliation deadline expired' }
  Write-OmniInteractiveJobAcknowledgment -Job $Job -LaunchPath $LaunchPath -Binding $Binding -Cancelled $true
}

function Receive-OmniInteractiveJobCancellation {
  param([Parameter(Mandatory = $true)]$Job, [Parameter(Mandatory = $true)][string]$LaunchPath,
    [Parameter(Mandatory = $true)]$Binding)
  if (-not (Test-OmniInteractiveCancellationIntent $LaunchPath $Binding)) { return $false }
  # The retained native job handle is the sole termination authority.
  $Job.Cancel()
  return $true
}

function Write-OmniInteractiveJobAcknowledgment {
  param([Parameter(Mandatory = $true)]$Job, [Parameter(Mandatory = $true)][string]$LaunchPath,
    [Parameter(Mandatory = $true)]$Binding, [bool]$Cancelled)
  if ($Job.ActiveProcesses -ne 0 -or -not $Job.HasExited) { throw 'owned job is not empty' }
  $ack = New-OmniInteractiveJobMessage $Binding 'watch-mode-interactive-job-cleanup'
  $ack.passed = $true; $ack.status = 'completed'; $ack.jobEmpty = $true; $ack.activeProcesses = 0
  $ack.notStarted = $false; $ack.custodyId = $Binding.custodyId; $ack.launchSha256 = $Binding.launchSha256
  $ack.rootExitCode = $Job.ExitCode; $ack.cancelled = $Cancelled; $ack.completedAt = [DateTime]::UtcNow.ToString('o')
  Write-OmniImmutableJson -LiteralPath (Join-Path ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($LaunchPath))) 'cleanup.job.json') -Value $ack
}

function Write-OmniInteractiveNotStartedAcknowledgment {
  param([Parameter(Mandatory = $true)][string]$LaunchPath, [Parameter(Mandatory = $true)]$Binding)
  if (-not (Test-OmniInteractiveCancellationIntent $LaunchPath $Binding) -or (Test-Path -LiteralPath $LaunchPath)) { throw 'cannot prove pre-launch cancellation' }
  $ack = New-OmniInteractiveJobMessage $Binding 'watch-mode-interactive-job-cleanup'
  $ack.passed = $true; $ack.status = 'completed'; $ack.jobEmpty = $true; $ack.activeProcesses = 0
  $ack.notStarted = $true; $ack.cancelled = $true; $ack.completedAt = [DateTime]::UtcNow.ToString('o')
  $ackPath = Join-Path ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($LaunchPath))) 'cleanup.job.json'
  try { Write-OmniImmutableJson -LiteralPath $ackPath -Value $ack }
  catch {
    $existing = Read-OmniCleanupAuthority $ackPath
    Test-OmniInteractiveJobMessage $existing $Binding 'watch-mode-interactive-job-cleanup'
    if ($existing.notStarted -ne $true -or $existing.passed -ne $true -or $existing.jobEmpty -ne $true -or $existing.activeProcesses -ne 0) { throw 'invalid prior no-start proof' }
  }
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
  try {
    $directory = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($LaunchPath))
    $commandPath = Join-Path $directory 'command.json'
    # Historical complete-ledger cleanup remains supported, but job launches
    # always use command-bound intent, even BEFORE launch.json exists.
    if (-not (Test-Path -LiteralPath $commandPath) -and (Test-Path -LiteralPath $LaunchPath)) {
      $legacy = Read-OmniCleanupAuthority $LaunchPath
      if (-not $legacy.PSObject.Properties['jobCustody']) { return Stop-OmniInteractiveTerminalProcesses @PSBoundParameters }
    }
    while (-not (Test-Path -LiteralPath $commandPath)) {
      if ([DateTime]::UtcNow -ge $DeadlineUtc.ToUniversalTime()) { $receipt.status = 'timeout'; return [pscustomobject]$receipt }
      Start-Sleep -Milliseconds 25
    }
    $binding = Get-OmniInteractiveCancellationBinding $LaunchPath $ExpectedBinding
    if (Test-Path -LiteralPath $LaunchPath) { $null = Get-OmniInteractiveJobBinding $LaunchPath $ExpectedBinding }
    if ([DateTime]::UtcNow -ge $DeadlineUtc.ToUniversalTime()) { $receipt.status = 'timeout'; return [pscustomobject]$receipt }
    $directory = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($LaunchPath))
    $requestPath = Join-Path $directory 'cancel-request.json'
    $ackPath = Join-Path $directory 'cleanup.job.json'
    # All callers atomically elect the same immutable, command-bound request.
    Request-OmniInteractiveJobCancellation -LaunchPath $LaunchPath -Binding $binding
    $receipt.status = 'timeout'
    while ([DateTime]::UtcNow -lt $DeadlineUtc.ToUniversalTime()) {
      if (Test-Path -LiteralPath $ackPath) {
        $receipt.status = 'authority-invalid'
        $ack = Read-OmniCleanupAuthority $ackPath
        Test-OmniInteractiveJobMessage $ack $binding 'watch-mode-interactive-job-cleanup'
        if ($ack.passed -ne $true -or $ack.status -cne 'completed' -or $ack.jobEmpty -ne $true -or $ack.activeProcesses -ne 0) { throw 'job cleanup unconfirmed' }
        if ($ack.notStarted -eq $true) {
          if (Test-Path -LiteralPath $LaunchPath) { throw 'not-started proof conflicts with launch' }
        } else {
          $jobBinding = Get-OmniInteractiveJobBinding $LaunchPath $ExpectedBinding
          if ($ack.custodyId -cne $jobBinding.custodyId -or $ack.launchSha256 -cne $jobBinding.launchSha256) { throw 'job acknowledgment custody mismatch' }
        }
        $receipt.passed = $true; $receipt.status = 'completed'; $receipt.jobEmpty = $true; $receipt.notStarted = $ack.notStarted
        return [pscustomobject]$receipt
      }
      $remaining = [Math]::Floor(($DeadlineUtc.ToUniversalTime() - [DateTime]::UtcNow).TotalMilliseconds)
      if ($remaining -gt 0) { Start-Sleep -Milliseconds ([int][Math]::Min(25, $remaining)) }
    }
  } catch {
    # Fixed failure codes only; exception text may contain secrets.
  }
  return [pscustomobject]$receipt
}
Export-ModuleMember -Function Request-OmniInteractiveJobCancellation, Complete-OmniInteractiveJobCleanup, Stop-OmniInteractiveOwnedProcesses, Get-OmniInteractiveJobBinding, Get-OmniInteractiveCancellationBinding, Test-OmniInteractiveCancellationIntent, Receive-OmniInteractiveJobCancellation, Write-OmniInteractiveJobAcknowledgment, Write-OmniInteractiveNotStartedAcknowledgment
