#requires -Version 5.1

function Get-FrontendReadyElapsedMs {
  param([object]$Frontend, [DateTimeOffset]$LaunchStartedAt)
  if ($null -eq $Frontend) { return $null }
  $launchEpochMs = [int64]$LaunchStartedAt.ToUnixTimeMilliseconds()
  if ($null -ne $Frontend.readySignalAtEpochMs) {
    return [int]([int64]$Frontend.readySignalAtEpochMs - $launchEpochMs)
  }
  $mountElapsedMs = if ($null -ne $Frontend.appMountedAtEpochMs) {
    [int]([int64]$Frontend.appMountedAtEpochMs - $launchEpochMs)
  } elseif ($null -ne $Frontend.timeOriginMs) {
    [int]([int64]$Frontend.timeOriginMs - $launchEpochMs)
  } else { $null }
  if ($null -eq $mountElapsedMs -or $null -eq $Frontend.readyAfterAppMountMs) { return $null }
  return $mountElapsedMs + [int]$Frontend.readyAfterAppMountMs
}

function Get-WindowToFrontendReadyMs {
  param([object]$Frontend, [object]$WindowInfo, [DateTimeOffset]$LaunchStartedAt)
  if (-not $WindowInfo.detected -or $null -eq $WindowInfo.detectedElapsedMs) { return $null }
  $frontendReadyElapsedMs = Get-FrontendReadyElapsedMs -Frontend $Frontend -LaunchStartedAt $LaunchStartedAt
  if ($null -eq $frontendReadyElapsedMs) { return $null }
  return [int]$frontendReadyElapsedMs - [int]$WindowInfo.detectedElapsedMs
}

Export-ModuleMember -Function @('Get-FrontendReadyElapsedMs','Get-WindowToFrontendReadyMs')
