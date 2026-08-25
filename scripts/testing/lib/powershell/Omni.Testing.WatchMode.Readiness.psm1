#requires -Version 5.1

function Get-DiagnosticLogLines {
  param(
    [string]$Text,
    [string[]]$Patterns,
    [int]$Limit = 8
  )
  if (-not $Text) {
    return @()
  }
  $matchedLines = @()
  foreach ($line in ($Text -split "`r?`n")) {
    if (-not $line.Trim()) {
      continue
    }
    foreach ($pattern in $Patterns) {
      if ($line -match $pattern) {
        $matchedLines += $line
        break
      }
    }
  }
  if ($matchedLines.Count -le $Limit) {
    return $matchedLines
  }
  return $matchedLines[($matchedLines.Count - $Limit)..($matchedLines.Count - 1)]
}

function Format-DiagnosticLogLines {
  param([object[]]$Lines)
  if (-not $Lines -or $Lines.Count -eq 0) {
    return "-"
  }
  return (($Lines | ForEach-Object { [string]$_ }) -join " || ")
}

function Get-OptionalDiagnosticFileTail {
  param(
    [string]$Path,
    [int]$Limit = 8
  )
  if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return @()
  }
  $text = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
  return @(Get-DiagnosticLogLines $text @('.+') $Limit)
}

function Wait-WatchModeAppReadiness {
  param(
    [string]$ReadinessPath,
    [string]$RunMarker,
    [int]$ProcessId,
    [DateTime]$DeadlineUtc,
    [string]$DesktopStdoutPath = '',
    [string]$DesktopStderrPath = ''
  )
  $startedAtUtc = [DateTime]::UtcNow
  $lastStatus = $null
  $lastReadError = $null
  do {
    if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) {
      throw (
        "Watch desktop exited before structured readiness completed. " +
        "Pid=$ProcessId ReadinessPath=$ReadinessPath " +
        "DesktopStdout=$DesktopStdoutPath DesktopStderr=$DesktopStderrPath"
      )
    }
    if (Test-Path -LiteralPath $ReadinessPath -PathType Leaf) {
      try {
        $status = Get-Content -LiteralPath $ReadinessPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $lastReadError = $null
        if ($status.schemaVersion -ne 'watch-mode-readiness/v2') {
          throw "unexpected schemaVersion '$($status.schemaVersion)'"
        }
        if ([string]$status.runMarker -ne $RunMarker) {
          throw "stale runMarker '$($status.runMarker)'"
        }
        if ([int]$status.processId -ne $ProcessId) {
          throw "unexpected processId '$($status.processId)'"
        }
        $lastStatus = $status
        if ($status.state -eq 'failed') {
          throw "desktop reported $($status.failure.code): $($status.failure.message)"
        }
        if ($status.state -eq 'ready') {
          return [pscustomobject]@{
            matched = $true
            path = $ReadinessPath
            pid = $ProcessId
            state = [string]$status.state
            providerReady = $status.provider.status -eq 'ready'
            frontendIpcReady = $status.frontendIpc.status -eq 'ready'
            bridgeReady = $status.bridge.status -eq 'ready'
            routeReady = $status.route.status -eq 'ready'
            elapsedMs = [Math]::Max(0, [int](([DateTime]::UtcNow - $startedAtUtc).TotalMilliseconds))
          }
        }
      } catch {
        if ($lastStatus -and $lastStatus.state -eq 'failed') {
          throw "structured Watch readiness failed. Pid=$ProcessId ReadinessPath=$ReadinessPath Error=$($_.Exception.Message)"
        }
        $lastReadError = $_.Exception.Message
      }
    }
    Start-Sleep -Milliseconds 200
  } while ([DateTime]::UtcNow -lt $DeadlineUtc.ToUniversalTime())

  $stdoutLines = Get-OptionalDiagnosticFileTail $DesktopStdoutPath 8
  $stderrLines = Get-OptionalDiagnosticFileTail $DesktopStderrPath 8
  $elapsedMs = [Math]::Max(0, [int](([DateTime]::UtcNow - $startedAtUtc).TotalMilliseconds))
  $lastState = if ($lastStatus) { [string]$lastStatus.state } else { 'missing' }
  throw (
    "timed out waiting for structured Watch readiness. Pid=$ProcessId State=$lastState " +
    "ElapsedMs=$elapsedMs ReadinessPath=$ReadinessPath RunMarker=$RunMarker LastReadError=$lastReadError " +
    "DesktopStdoutPath=$DesktopStdoutPath DesktopStdoutTail=$(Format-DiagnosticLogLines $stdoutLines) " +
    "DesktopStderrPath=$DesktopStderrPath DesktopStderrTail=$(Format-DiagnosticLogLines $stderrLines)"
  )
}


Export-ModuleMember -Function 'Wait-WatchModeAppReadiness'
