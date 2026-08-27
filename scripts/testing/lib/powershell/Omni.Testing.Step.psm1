#requires -Version 5.1

function New-OmniStepError {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('execution', 'assertion', 'timeout', 'dependency', 'cleanup')]
    [string]$Kind,
    [Parameter(Mandatory = $true)][string]$Code,
    [Parameter(Mandatory = $true)][string]$Message,
    $Details = $null
  )

  $errorPayload = [pscustomobject]@{
    kind = $Kind
    code = $Code
    message = $Message
    details = $Details
  }
  $errorPayload | Add-Member -MemberType ScriptMethod -Name ToString -Value { return [string]$this.message } -Force
  return $errorPayload
}

function New-OmniStepResult {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$Id,
    [Parameter(Mandatory = $true)][string]$Phase,
    [Parameter(Mandatory = $true)]
    [ValidateSet('passed', 'failed', 'skipped', 'blocked')]
    [string]$Status,
    [Parameter(Mandatory = $true)][DateTime]$StartedAtUtc,
    [DateTime]$EndedAtUtc = [DateTime]::UtcNow,
    $Data = $null,
    $ErrorRecord = $null
  )

  if ($Status -eq 'failed' -and -not $ErrorRecord) {
    throw "failed step '$Id' requires ErrorRecord"
  }
  if ($Status -ne 'failed' -and $ErrorRecord) {
    throw "non-failed step '$Id' must not carry ErrorRecord"
  }
  return [pscustomobject]@{
    schemaVersion = 'watch-mode-step/v2'
    id = $Id
    phase = $Phase
    status = $Status
    startedAt = $StartedAtUtc.ToString('o')
    endedAt = $EndedAtUtc.ToUniversalTime().ToString('o')
    durationMs = [Math]::Max(0, [long]($EndedAtUtc.ToUniversalTime() - $StartedAtUtc.ToUniversalTime()).TotalMilliseconds)
    data = $Data
    error = $ErrorRecord
  }
}

function Invoke-OmniStep {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$Id,
    [Parameter(Mandatory = $true)][string]$Phase,
    [Parameter(Mandatory = $true)][scriptblock]$Action,
    [string]$FailureCode = 'testing.step.execution-failed'
  )

  $startedAtUtc = [DateTime]::UtcNow
  try {
    $LASTEXITCODE = 0
    $data = & $Action
    if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {
      throw "native command exited with code $LASTEXITCODE"
    }
    return New-OmniStepResult -Id $Id -Phase $Phase -Status passed -StartedAtUtc $startedAtUtc -Data $data
  } catch {
    $errorPayload = New-OmniStepError -Kind execution -Code $FailureCode -Message $_.Exception.Message
    return New-OmniStepResult -Id $Id -Phase $Phase -Status failed -StartedAtUtc $startedAtUtc -ErrorRecord $errorPayload
  }
}

Export-ModuleMember -Function @(
  'New-OmniStepError',
  'New-OmniStepResult',
  'Invoke-OmniStep'
)
