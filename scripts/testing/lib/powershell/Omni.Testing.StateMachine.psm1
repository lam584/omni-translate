#requires -Version 5.1

Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.Step.psm1') -Force -DisableNameChecking

function New-OmniRunState {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]$Context,
    [Parameter(Mandatory = $true)]$Request
  )

  return [pscustomobject]@{
    context = $Context
    request = $Request
    steps = [System.Collections.ArrayList]::new()
    stepById = @{}
    data = @{}
    ownedProcesses = [System.Collections.ArrayList]::new()
    primaryError = $null
    primaryStepId = $null
    cleanupErrors = [System.Collections.ArrayList]::new()
  }
}

function Add-OmniRunStep {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]$State,
    [Parameter(Mandatory = $true)]$Step
  )

  if ($State.stepById.ContainsKey([string]$Step.id)) {
    throw "duplicate state-machine step id: $($Step.id)"
  }
  [void]$State.steps.Add($Step)
  $State.stepById[[string]$Step.id] = $Step
  if ($Step.status -eq 'failed' -and -not $State.primaryError) {
    $State.primaryError = $Step.error
    $State.primaryStepId = [string]$Step.id
  }
  return $Step
}

function Invoke-OmniRunPhase {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]$State,
    [Parameter(Mandatory = $true)][string]$Id,
    [Parameter(Mandatory = $true)][string]$Phase,
    [string[]]$PrerequisiteIds = @(),
    [scriptblock]$Action,
    [string]$FailureCode = 'testing.phase.execution-failed',
    [string]$PolicySkipReason
  )

  $startedAtUtc = [DateTime]::UtcNow
  if ($PSBoundParameters.ContainsKey('PolicySkipReason')) {
    if ([string]::IsNullOrWhiteSpace($PolicySkipReason)) {
      throw "policy skip reason is required for skipped phase '$Id'"
    }
    $step = New-OmniStepResult -Id $Id -Phase $Phase -Status skipped `
      -StartedAtUtc $startedAtUtc -Data ([pscustomobject]@{ reason = $PolicySkipReason })
    return Add-OmniRunStep -State $State -Step $step
  }
  if (-not $Action) {
    throw "action is required for executable phase '$Id'"
  }

  $blockedBy = @()
  foreach ($prerequisiteId in $PrerequisiteIds) {
    if (-not $State.stepById.ContainsKey($prerequisiteId)) {
      throw "phase '$Id' references an unknown prerequisite '$prerequisiteId'"
    }
    $prerequisite = $State.stepById[$prerequisiteId]
    if ($prerequisite.status -ne 'passed') {
      $blockedBy += [pscustomobject]@{
        id = [string]$prerequisite.id
        status = [string]$prerequisite.status
      }
    }
  }
  if ($blockedBy.Count -gt 0) {
    $step = New-OmniStepResult -Id $Id -Phase $Phase -Status blocked `
      -StartedAtUtc $startedAtUtc -Data ([pscustomobject]@{ blockedBy = @($blockedBy) })
    return Add-OmniRunStep -State $State -Step $step
  }

  $step = Invoke-OmniStep -Id $Id -Phase $Phase -Action $Action -FailureCode $FailureCode
  return Add-OmniRunStep -State $State -Step $step
}

function Add-OmniOwnedProcess {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]$State,
    [Parameter(Mandatory = $true)]$Lease
  )

  if ([string]$Lease.ownership -ne 'managed') {
    throw 'only managed process leases may be registered as owned resources'
  }
  [void]$State.ownedProcesses.Add($Lease)
  return $Lease
}

function Add-OmniCleanupError {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]$State,
    [Parameter(Mandatory = $true)][string]$Code,
    [Parameter(Mandatory = $true)][string]$Message,
    $Details = $null
  )

  $cleanupError = New-OmniStepError -Kind cleanup -Code $Code -Message $Message -Details $Details
  [void]$State.cleanupErrors.Add($cleanupError)
  return $cleanupError
}

function Complete-OmniBlockedPhases {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]$State,
    [Parameter(Mandatory = $true)][string[]]$Phases
  )

  if (-not $State.primaryStepId) {
    throw 'cannot block remaining phases before a primary failure is recorded'
  }
  foreach ($phase in $Phases) {
    if (@($State.steps | Where-Object { $_.phase -eq $phase }).Count -gt 0) { continue }
    Invoke-OmniRunPhase -State $State -Id "phase.$phase" -Phase $phase `
      -PrerequisiteIds $State.primaryStepId -Action { $null } | Out-Null
  }
}

Export-ModuleMember -Function @(
  'New-OmniRunState',
  'Add-OmniRunStep',
  'Invoke-OmniRunPhase',
  'Add-OmniOwnedProcess',
  'Add-OmniCleanupError',
  'Complete-OmniBlockedPhases'
)
