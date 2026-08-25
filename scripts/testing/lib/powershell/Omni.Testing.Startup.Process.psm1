Set-StrictMode -Version Latest

function Find-MainWindowProcess {
  param([DateTime]$LaunchStartedAtLocal)

  $candidates = @()
  foreach ($process in Get-Process -ErrorAction SilentlyContinue) {
    if ($process.MainWindowHandle -eq 0) {
      continue
    }
    if ($process.MainWindowTitle -ne 'Omni Translate') {
      continue
    }

    try {
      $startedAt = $process.StartTime
    } catch {
      continue
    }

    if ($startedAt -lt $LaunchStartedAtLocal.AddSeconds(-10)) {
      continue
    }

    $candidates += [pscustomobject]@{
      Process = $process
      StartTime = $startedAt
    }
  }

  return $candidates | Sort-Object StartTime | Select-Object -First 1
}

function Get-ExistingDesktopShellProcesses {
  $processes = @(Get-Process -Name 'omni-desktop-shell' -ErrorAction SilentlyContinue)
  $items = @()

  foreach ($process in $processes) {
    $startTime = $null
    $path = $null
    try {
      $startTime = $process.StartTime.ToString('o')
    } catch {
      $startTime = $null
    }
    try {
      $path = $process.Path
    } catch {
      $path = $null
    }

    $items += [pscustomobject]@{
      processId = $process.Id
      processName = $process.ProcessName
      title = $process.MainWindowTitle
      startTime = $startTime
      path = $path
    }
  }

  return $items
}

Export-ModuleMember -Function @(
  'Find-MainWindowProcess',
  'Get-ExistingDesktopShellProcesses'
)
