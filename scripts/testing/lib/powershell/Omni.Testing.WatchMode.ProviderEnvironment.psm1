#requires -Version 5.1

# Resolves only the explicitly selected release endpoint; never rewrites saved URLs.
function Resolve-WatchModeReleaseEndpointHost {
  param([string]$ModelId)
  if ($ModelId -cne 'qwen3.8-livetranslate-flash-realtime') { return 'dashscope.aliyuncs.com' }
  $selectedHost = [string]$env:OMNI_WATCH_MODE_EXPECTED_PROVIDER_ENDPOINT_HOST
  if ($selectedHost -cnotmatch '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cn-beijing\.maas\.aliyuncs\.com$') {
    throw 'Strict 3.8 provider requires its coordinator-selected Beijing workspace host.'
  }
  return $selectedHost
}

function Get-WatchModeBudgetEndpointArguments {
  $selectedHost = [string]$env:OMNI_WATCH_MODE_EXPECTED_PROVIDER_ENDPOINT_HOST
  if (-not [string]::IsNullOrWhiteSpace($selectedHost)) {
    return @('--endpoint-host', $selectedHost)
  }
  return @()
}

function Enter-StrictPaidProviderEnvironment {
  param(
    [bool]$Enabled,
    [bool]$IncidentReplay = $false,
    [bool]$LocalSingleSession = $false,
    [string]$ModelId = "qwen3.5-livetranslate-flash-realtime"
  )
  $fixed = [ordered]@{
    OMNI_WATCH_MODE_EXPECTED_PROVIDER_ID = "provider-dashscope"
    OMNI_WATCH_MODE_EXPECTED_PROVIDER_TEMPLATE_ID = "template-dashscope-realtime"
    OMNI_WATCH_MODE_EXPECTED_PROVIDER_KIND = "dashscope"
    OMNI_WATCH_MODE_EXPECTED_PROVIDER_ENDPOINT_HOST = "dashscope.aliyuncs.com"
    OMNI_WATCH_MODE_EXPECTED_PROVIDER_CREDENTIAL_REFERENCE = "credential://provider/dashscope/default"
  }
  if ($Enabled) {
    $fixed.OMNI_WATCH_MODE_EXPECTED_PROVIDER_ENDPOINT_HOST = Resolve-WatchModeReleaseEndpointHost $ModelId
  }
  if ($Enabled) {
    $fixed.OMNI_WATCH_MODE_STRICT_PAID_AUTHORITY = "1"
  }
  if ($IncidentReplay) {
    $fixed.OMNI_WATCH_MODE_INCIDENT_REPLAY_AUTHORITY = "1"
    $fixed.OMNI_WATCH_MODE_INCIDENT_ID = "watch-mode-loss-incident-plus-v1"
  }
  if ($LocalSingleSession) {
    $fixed.OMNI_WATCH_MODE_LOCAL_SINGLE_SESSION_AUTHORITY = "1"
  }
  $previous = [ordered]@{}
  foreach ($entry in $fixed.GetEnumerator()) {
    $previous[$entry.Key] = [Environment]::GetEnvironmentVariable(
      $entry.Key,
      [EnvironmentVariableTarget]::Process
    )
    if ($Enabled -or $IncidentReplay -or $LocalSingleSession) {
      [Environment]::SetEnvironmentVariable(
        $entry.Key,
        [string]$entry.Value,
        [EnvironmentVariableTarget]::Process
      )
    }
  }
  return [pscustomobject]@{
    enabled = $Enabled -or $IncidentReplay -or $LocalSingleSession
    names = @($fixed.Keys)
    values = $fixed
    previous = $previous
  }
}

function Exit-StrictPaidProviderEnvironment {
  param($State)
  if (-not $State) { return }
  foreach ($name in @($State.names)) {
    [Environment]::SetEnvironmentVariable(
      [string]$name,
      $State.previous[[string]$name],
      [EnvironmentVariableTarget]::Process
    )
  }
}

Export-ModuleMember -Function 'Resolve-WatchModeReleaseEndpointHost', 'Get-WatchModeBudgetEndpointArguments', 'Enter-StrictPaidProviderEnvironment', 'Exit-StrictPaidProviderEnvironment'
