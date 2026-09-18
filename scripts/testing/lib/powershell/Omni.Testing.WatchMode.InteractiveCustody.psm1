#requires -Version 5.1

Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.IO.psm1') -Force

function Get-OmniInteractiveLaunchProcessState {
  param(
    [Parameter(Mandatory = $true)][string]$LaunchPath,
    [Parameter(Mandatory = $true)][ValidateSet('taskProcess', 'nodeProcess')][string]$ProcessProperty
  )
  if (-not (Test-Path -LiteralPath $LaunchPath -PathType Leaf)) {
    return [pscustomobject]@{ status = 'missing'; pid = $null; error = 'launch authority is missing' }
  }
  $processId = $null
  try {
    $launch = Get-Content -LiteralPath $LaunchPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if (
      [int]$launch.schemaVersion -ne 2 -or
      [string]$launch.artifactKind -cne 'watch-mode-interactive-shard-launch-authority' -or
      $null -eq $launch.PSObject.Properties[$ProcessProperty]
    ) {
      return [pscustomobject]@{ status = 'invalid'; pid = $null; error = 'launch authority process binding is invalid' }
    }
    $expected = $launch.$ProcessProperty
    $processId = [int]$expected.pid
    $expectedPath = [IO.Path]::GetFullPath([string]$expected.imagePath)
    if (
      $processId -le 0 -or
      [int]$expected.sessionId -lt 0 -or
      [string]::IsNullOrWhiteSpace([string]$expected.startedAt) -or
      [string]$expected.imageSha256 -notmatch '^[a-f0-9]{64}$' -or
      [string]::IsNullOrWhiteSpace([string]$expected.ownerSid)
    ) {
      return [pscustomobject]@{ status = 'invalid'; pid = $processId; error = 'launch authority process identity is incomplete' }
    }
    $actual = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction Stop
    if ($null -eq $actual) {
      return [pscustomobject]@{ status = 'exited'; pid = $processId; error = $null }
    }
    $process = Get-Process -Id $processId -ErrorAction Stop
    $null = $process.Handle
    if ($process.HasExited) {
      return [pscustomobject]@{ status = 'exited'; pid = $processId; error = $null }
    }
    $actualPath = [IO.Path]::GetFullPath([string]$actual.ExecutablePath)
    $actualOwnerSid = Invoke-CimMethod -InputObject $actual -MethodName GetOwnerSid -ErrorAction Stop
    if (
      [int]$actual.SessionId -ne [int]$expected.sessionId -or
      $process.StartTime.ToUniversalTime().ToString('o') -cne [string]$expected.startedAt -or
      -not $actualPath.Equals($expectedPath, [StringComparison]::OrdinalIgnoreCase) -or
      [string]$actualOwnerSid.Sid -cne [string]$expected.ownerSid -or
      (Get-OmniSha256 -LiteralPath $actualPath) -cne [string]$expected.imageSha256
    ) {
      return [pscustomobject]@{ status = 'mismatch'; pid = $processId; error = $null }
    }
    return [pscustomobject]@{ status = 'current'; pid = $processId; error = $null }
  } catch {
    try {
      if ($processId -gt 0 -and -not (Get-Process -Id $processId -ErrorAction SilentlyContinue)) {
        return [pscustomobject]@{ status = 'exited'; pid = $processId; error = $null }
      }
    } catch {}
    return [pscustomobject]@{ status = 'unverifiable'; pid = $processId; error = $_.Exception.Message }
  }
}

function Get-OmniInteractiveScheduledTaskExitDecision {
  param(
    [Parameter(Mandatory = $true)][string]$LaunchPath,
    [Parameter(Mandatory = $true)][int]$LastTaskResult
  )
  if ($LastTaskResult -eq 0) {
    return [pscustomobject]@{ action = 'await-terminal-visibility'; taskProcessState = 'not-required'; nodeProcessState = 'not-required' }
  }
  $taskProcess = Get-OmniInteractiveLaunchProcessState -LaunchPath $LaunchPath -ProcessProperty 'taskProcess'
  if ($taskProcess.status -eq 'current') {
    return [pscustomobject]@{ action = 'wait-for-terminal-authority'; taskProcessState = 'current'; nodeProcessState = 'not-required' }
  }
  $nodeProcess = Get-OmniInteractiveLaunchProcessState -LaunchPath $LaunchPath -ProcessProperty 'nodeProcess'
  if ($nodeProcess.status -eq 'current') {
    return [pscustomobject]@{ action = 'wait-for-terminal-authority'; taskProcessState = [string]$taskProcess.status; nodeProcessState = 'current' }
  }
  return [pscustomobject]@{
    action = 'fail-task-result'
    taskProcessState = [string]$taskProcess.status
    nodeProcessState = [string]$nodeProcess.status
  }
}

Export-ModuleMember -Function 'Get-OmniInteractiveScheduledTaskExitDecision'
