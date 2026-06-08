param(
  [string]$OutputRoot = "artifacts/testing/startup-readiness",
  [int]$TimeoutSeconds = 120,
  [int]$WindowPollMs = 100,
  [int]$LogPollMs = 250,
  [int]$DevServerPort = 4173,
  [int]$MaxWindowToReadyMs = 10000,
  [int]$MaxWindowToFrontendMountMs = 1000,
  [int]$MaxFrontendBootstrapMs = 8500,
  [int]$MaxReadySignalToNativeLogMs = 500,
  [switch]$UseExistingDevServer,
  [switch]$UseFastDev,
  [int]$CriticalWarmupTimeoutMs = 1200,
  [switch]$NoWarmup,
  [switch]$NoStop,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

function Get-UtcIsoNow {
  return [DateTimeOffset]::UtcNow.ToString('o')
}

function Write-JsonReport {
  param(
    [string]$Path,
    [object]$Value
  )

  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 16), $encoding)
}

function Write-MarkdownReport {
  param(
    [string]$Path,
    [object]$Report
  )

  $windowElapsed = if ($null -ne $Report.window.detectedElapsedMs) { "$($Report.window.detectedElapsedMs) ms" } else { "n/a" }
  $readyElapsed = if ($null -ne $Report.readiness.detectedElapsedMs) { "$($Report.readiness.detectedElapsedMs) ms" } else { "n/a" }
  $windowToReady = if ($null -ne $Report.readiness.windowToReadyMs) { "$($Report.readiness.windowToReadyMs) ms" } else { "n/a" }

  $lines = @(
    "# Startup readiness report",
    "",
    "- runId: ``$($Report.runId)``",
    "- verdict: **$($Report.verdict)**",
    "- command: ``$($Report.command)``",
    "- dev server mode: ``$($Report.devServer.mode)``",
    "- dev server port: ``$($Report.devServer.port)``",
    "- window detected: $windowElapsed",
    "- readiness detected: $readyElapsed",
    "- window to readiness: $windowToReady",
    "- stdout: ``$($Report.artifacts.stdout)``",
    "- stderr: ``$($Report.artifacts.stderr)``",
    "- app log: ``$($Report.artifacts.appLog)``"
  )

  if ($Report.readiness.frontend -and $Report.readiness.frontend.readyAfterAppMountMs) {
    $lines += "- frontend app mount to ready: $($Report.readiness.frontend.readyAfterAppMountMs) ms"
  }

  if ($Report.phases) {
    $lines += ""
    $lines += "## Phase breakdown"
    foreach ($phaseName in $Report.phases.Keys) {
      $phaseValue = $Report.phases[$phaseName]
      if ($null -ne $phaseValue) {
        $lines += "- ${phaseName}: $phaseValue ms"
      }
    }
  }

  if ($Report.fullReadiness -and $Report.fullReadiness.fullReady.detected) {
    $lines += ""
    $lines += "## Full readiness"
    $lines += "- route_ready: $($Report.fullReadiness.routeReady.elapsedMs) ms"
    $lines += "- styles_ready: $($Report.fullReadiness.stylesReady.elapsedMs) ms"
    $lines += "- bridge_converged: $($Report.fullReadiness.bridgeConverged.elapsedMs) ms"
    $lines += "- full_ready: $($Report.fullReadiness.fullReady.elapsedMs) ms"
  }

  if ($Report.devCommandMetrics) {
    $lines += ""
    $lines += "## Dev command metrics"
    foreach ($metricName in $Report.devCommandMetrics.Keys) {
      $metricValue = $Report.devCommandMetrics[$metricName]
      if ($null -ne $metricValue) {
        $lines += "- ${metricName}: $metricValue ms"
      }
    }
  }

  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, ($lines -join [Environment]::NewLine), $encoding)
}

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

function Get-DevServerListeners {
  param([int]$Port)

  try {
    $connections = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
  } catch {
    return @()
  }

  $owners = @()
  foreach ($connection in $connections) {
    $processName = $null
    try {
      $processName = (Get-Process -Id $connection.OwningProcess -ErrorAction SilentlyContinue).ProcessName
    } catch {
      $processName = $null
    }

    $owners += [pscustomobject]@{
      localAddress = $connection.LocalAddress
      localPort = $connection.LocalPort
      state = [string]$connection.State
      owningProcess = $connection.OwningProcess
      processName = $processName
    }
  }

  return $owners
}

function Wait-DevServerReady {
  param(
    [int]$Port,
    [int]$TimeoutSeconds = 30
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $warmupDeadline = (Get-Date).AddSeconds([Math]::Min(3, $TimeoutSeconds))
  $url = "http://127.0.0.1:$Port/"
  while ((Get-Date) -lt $deadline) {
    $listeners = @(Get-DevServerListeners -Port $Port)
    if ($listeners.Count -gt 0) {
      try {
        $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5
        if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
          return $true
        }
      } catch {
        # The listener can exist before Vite has finished accepting requests.
      }
    }
    Start-Sleep -Milliseconds 200
  }

  return $false
}

function Resolve-DevServerAssetPath {
  param(
    [string]$Specifier,
    [string]$BasePath
  )

  if ([string]::IsNullOrWhiteSpace($Specifier)) {
    return $null
  }
  if ($Specifier.StartsWith('http://') -or $Specifier.StartsWith('https://')) {
    try {
      $uri = [Uri]$Specifier
      return "$($uri.PathAndQuery)"
    } catch {
      return $null
    }
  }
  if ($Specifier.StartsWith('/')) {
    return $Specifier
  }
  if ($Specifier.StartsWith('.') -and -not [string]::IsNullOrWhiteSpace($BasePath)) {
    try {
      $baseUri = [Uri]"http://127.0.0.1$BasePath"
      $resolved = [Uri]::new($baseUri, $Specifier)
      return "$($resolved.PathAndQuery)"
    } catch {
      return $null
    }
  }

  return $null
}

function Get-DevServerAssetDependencies {
  param(
    [string]$Text,
    [string]$BasePath
  )

  $dependencies = @()
  $patterns = @(
    '(?m)\bimport\s+(?:[^''"]+\s+from\s+)?[''"](?<path>[^''"]+)[''"]',
    '(?m)\bexport\s+[^''"]+\s+from\s+[''"](?<path>[^''"]+)[''"]',
    '(?m)\bimport\(\s*[''"](?<path>[^''"]+)[''"]\s*\)',
    '(?m)@import\s+[''"](?<path>[^''"]+)[''"]'
  )

  foreach ($pattern in $patterns) {
    foreach ($match in [regex]::Matches($Text, $pattern)) {
      $resolved = Resolve-DevServerAssetPath -Specifier $match.Groups['path'].Value -BasePath $BasePath
      if ($null -ne $resolved) {
        $dependencies += $resolved
      }
    }
  }

  return $dependencies | Select-Object -Unique
}


function Invoke-CriticalDevServerWarmup {
  param(
    [int]$Port,
    [string[]]$CriticalPaths = @(
      '/',
      '/src/main.tsx',
      '/src/App.tsx',
      '/src/styles/startup.css',
      '/src/router.tsx',
      '/src/router-startup.ts',
      '/src/pages/RealTimeSessionPage.tsx'
    ),
    [int]$TimeoutMs = 1200
  )

  $origin = "http://127.0.0.1:$Port"
  $startedAt = [System.Diagnostics.Stopwatch]::StartNew()
  $requestCount = 0

  $jobs = @()
  foreach ($path in $CriticalPaths) {
    $uri = "$origin$path"
    $jobs += Start-Job -ScriptBlock {
      param($u)
      try { Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 3 *> $null } catch {}
    } -ArgumentList $uri
  }

  while (($jobs.State -contains "Running") -and $startedAt.ElapsedMilliseconds -lt $TimeoutMs) {
    Start-Sleep -Milliseconds 50
  }

  foreach ($job in $jobs) {
    try {
      $result = Receive-Job -Job $job -ErrorAction SilentlyContinue
      if ($null -ne $result) { $requestCount += 1 }
    } catch {}
    Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
  }

  return [ordered]@{
    requestCount = $requestCount
    elapsedMs = $startedAt.ElapsedMilliseconds
    mode = "critical"
    timeoutMs = $TimeoutMs
  }
}

function Invoke-DevServerWarmup {
  param(
    [int]$Port,
    [string[]]$EntryPaths = @('/', '/src/main.tsx'),
    [int]$MaxRequests = 240
  )

  $origin = "http://127.0.0.1:$Port"
  $queue = [System.Collections.Generic.Queue[string]]::new()
  $visited = [System.Collections.Generic.HashSet[string]]::new()
  foreach ($entry in $EntryPaths) {
    $queue.Enqueue($entry)
  }

  $requestCount = 0
  $startedAt = [System.Diagnostics.Stopwatch]::StartNew()
  while ($queue.Count -gt 0 -and $requestCount -lt $MaxRequests -and (Get-Date) -lt $warmupDeadline) {
    $path = $queue.Dequeue()
    if (-not $visited.Add($path)) {
      continue
    }

    try {
      $response = Invoke-WebRequest -Uri "$origin$path" -UseBasicParsing -TimeoutSec 20
      $requestCount += 1
      $contentType = [string]$response.Headers['Content-Type']
      if ($contentType.Contains('javascript') -or $contentType.Contains('css') -or $path.EndsWith('.tsx') -or $path.EndsWith('.ts') -or $path.EndsWith('.css')) {
        $dependencies = Get-DevServerAssetDependencies -Text ([string]$response.Content) -BasePath $path
        foreach ($dependency in $dependencies) {
          if (-not $visited.Contains($dependency)) {
            $queue.Enqueue($dependency)
          }
        }
      }
    } catch {
      # Warmup is best-effort; the readiness verdict still comes from the app.
    }
  }

  return [ordered]@{
    requestCount = $requestCount
    elapsedMs = [int]$startedAt.ElapsedMilliseconds
  }
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

function Read-NewTextFromFile {
  param(
    [string]$Path,
    [long]$Offset
  )

  if (-not (Test-Path $Path)) {
    return [pscustomobject]@{ Text = ''; Offset = 0 }
  }

  $file = Get-Item $Path
  if ($file.Length -lt $Offset) {
    $Offset = 0
  }

  $stream = $null
  $reader = $null
  try {
    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    [void]$stream.Seek($Offset, [System.IO.SeekOrigin]::Begin)
    $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8, $true)
    $text = $reader.ReadToEnd()
    $newOffset = $stream.Position
    return [pscustomobject]@{ Text = $text; Offset = $newOffset }
  } finally {
    if ($null -ne $reader) {
      $reader.Dispose()
    } elseif ($null -ne $stream) {
      $stream.Dispose()
    }
  }
}

function Find-ReadyMarker {
  param(
    [string]$Text,
    [string]$RunId
  )

  foreach ($line in ($Text -split "`r?`n")) {
    if ([string]::IsNullOrWhiteSpace($line)) {
      continue
    }
    if (-not $line.Contains('startup.readiness_ready')) {
      continue
    }
    if (-not $line.Contains("runId=$RunId")) {
      continue
    }

    $payload = $null
    $payloadError = $null
    if ($line -match 'payload=([^ ]+)') {
      try {
        $payloadJson = [System.Uri]::UnescapeDataString($Matches[1])
        $payload = $payloadJson | ConvertFrom-Json
      } catch {
        $payloadError = $_.Exception.Message
      }
    }

    $logTimestamp = $null
    if ($line -match '^(?<timestamp>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})') {
      try {
        $logTimestamp = [DateTime]::ParseExact(
          $Matches['timestamp'],
          'yyyy-MM-dd HH:mm:ss.fff',
          [System.Globalization.CultureInfo]::InvariantCulture,
          [System.Globalization.DateTimeStyles]::AssumeLocal
        )
      } catch {
        $logTimestamp = $null
      }
    }

    return [pscustomobject]@{
      Line = $line
      LogTimestamp = $logTimestamp
      Payload = $payload
      PayloadError = $payloadError
    }
  }

  return $null
}


function Find-FullReadyMarkers {
  param(
    [string]$Text
  )

  $markers = [ordered]@{
    routeReady = $null
    stylesReady = $null
    bridgeConverged = $null
    fullReady = $null
  }

  foreach ($line in ($Text -split "`r?`n")) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }

    $logTimestamp = $null
    if ($line -match '^(?<timestamp>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})') {
      try {
        $logTimestamp = [DateTime]::ParseExact(
          $Matches['timestamp'],
          'yyyy-MM-dd HH:mm:ss.fff',
          [System.Globalization.CultureInfo]::InvariantCulture,
          [System.Globalization.DateTimeStyles]::AssumeLocal
        )
      } catch { $logTimestamp = $null }
    }

    if ($line.Contains('startup.route_ready') -and -not $markers.routeReady) {
      $markers.routeReady = [pscustomobject]@{ detected = $true; timestamp = $logTimestamp; line = $line }
    }
    if ($line.Contains('startup.styles_ready') -and -not $markers.stylesReady) {
      $markers.stylesReady = [pscustomobject]@{ detected = $true; timestamp = $logTimestamp; line = $line }
    }
    if ($line.Contains('startup.bridge_converged') -and -not $markers.bridgeConverged) {
      $detail = ''
      if ($line -match 'convergence=(\w+)') { $detail = $Matches[1] }
      $markers.bridgeConverged = [pscustomobject]@{ detected = $true; timestamp = $logTimestamp; line = $line; convergence = $detail }
    }
    if ($line.Contains('startup.full_ready') -and -not $markers.fullReady) {
      $markers.fullReady = [pscustomobject]@{ detected = $true; timestamp = $logTimestamp; line = $line }
    }
  }

  return $markers
}
function Get-ChildProcessIds {
  param([int]$ParentId)

  $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$ParentId" -ErrorAction SilentlyContinue)
  foreach ($child in $children) {
    $childId = [int]$child.ProcessId
    $childId
    Get-ChildProcessIds -ParentId $childId
  }
}

function Stop-ProcessTree {
  param([int]$RootProcessId)

  $ids = @((Get-ChildProcessIds -ParentId $RootProcessId) + $RootProcessId | Select-Object -Unique)
  [array]::Reverse($ids)
  foreach ($id in $ids) {
    try {
      Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
    } catch {
      # Process already exited.
    }
  }
}

function Stop-NewMainWindows {
  param(
    [DateTime]$LaunchStartedAtLocal,
    [int]$WaitSeconds = 10
  )

  $deadline = (Get-Date).AddSeconds($WaitSeconds)
  do {
    $candidate = Find-MainWindowProcess -LaunchStartedAtLocal $LaunchStartedAtLocal
    if ($null -ne $candidate) {
      try {
        [void]$candidate.Process.CloseMainWindow()
        Start-Sleep -Milliseconds 1000
        $process = Get-Process -Id $candidate.Process.Id -ErrorAction SilentlyContinue
        if ($null -ne $process) {
          Stop-Process -Id $candidate.Process.Id -Force -ErrorAction SilentlyContinue
        }
      } catch {
        # Best-effort cleanup only.
      }
      return
    }

    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
}

function Stop-NewBuildProcesses {
  param(
    [DateTime]$LaunchStartedAtLocal,
    [int]$WaitSeconds = 5
  )

  $deadline = (Get-Date).AddSeconds($WaitSeconds)
  $names = @('cargo', 'rustc', 'omni-desktop-shell')
  do {
    foreach ($name in $names) {
      foreach ($process in @(Get-Process -Name $name -ErrorAction SilentlyContinue)) {
        try {
          if ($process.StartTime -lt $LaunchStartedAtLocal.AddSeconds(-5)) {
            continue
          }
        } catch {
          continue
        }

        try {
          if ($process.MainWindowHandle -ne 0) {
            [void]$process.CloseMainWindow()
            Start-Sleep -Milliseconds 500
          }
          $stillRunning = Get-Process -Id $process.Id -ErrorAction SilentlyContinue
          if ($null -ne $stillRunning) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
          }
        } catch {
          # Best-effort cleanup only.
        }
      }
    }

    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
}

function Read-TextFileIfExists {
  param([string]$Path)

  if (-not (Test-Path $Path)) {
    return ''
  }

  return Get-Content -Raw -Encoding UTF8 -Path $Path
}

function Classify-DevFailure {
  param(
    [string]$StdoutPath,
    [string]$StderrPath
  )

  $stdoutText = Read-TextFileIfExists -Path $StdoutPath
  $stderrText = Read-TextFileIfExists -Path $StderrPath
  $combined = "$stdoutText`n$stderrText"

  if ($combined -match 'os error 740|请求的操作需要提升|requires elevation|requires elevated|requireAdministrator') {
    return [pscustomobject]@{
      verdict = 'requires-elevation'
      summary = 'The desktop shell requires elevation and could not be launched from this PowerShell session.'
    }
  }

  if ($combined -match 'Port\s+\d+\s+is already in use|error when starting dev server') {
    return [pscustomobject]@{
      verdict = 'dev-server-start-failed'
      summary = 'The frontend dev server failed to start.'
    }
  }

  if ($combined -match 'could not compile|error\[E\d+\]|failed to remove file') {
    return [pscustomobject]@{
      verdict = 'tauri-build-failed'
      summary = 'The Tauri Rust shell did not build successfully.'
    }
  }

  if ($combined -match 'beforeDevCommand.*non-zero status code|DevCommand.*non-zero') {
    return [pscustomobject]@{
      verdict = 'tauri-dev-command-failed'
      summary = 'The Tauri dev command exited or failed before readiness.'
    }
  }

  return $null
}

function Test-FrontendBootstrapErrors {
  param([object]$Frontend)

  if ($null -eq $Frontend -or $null -eq $Frontend.steps) {
    return $false
  }

  foreach ($stepProperty in $Frontend.steps.PSObject.Properties) {
    $step = $stepProperty.Value
    if ($null -ne $step.errorAtMs) {
      return $true
    }
  }

  return $false
}

function New-StartupThresholds {
  return [ordered]@{
    maxWindowToReadyMs = $MaxWindowToReadyMs
    maxWindowToFrontendMountMs = $MaxWindowToFrontendMountMs
    maxFrontendBootstrapMs = $MaxFrontendBootstrapMs
    maxReadySignalToNativeLogMs = $MaxReadySignalToNativeLogMs
    frontendStepMs = [ordered]@{
      'detect-runtime' = 200
      'check-ipc' = 1000
      'init-runtime' = 1500
      'init-audio' = 3000
      'load-config' = 2400
      'bootstrap-overlay-delay' = 0
    }
  }
}

function Remove-AnsiEscapeSequences {
  param([string]$Text)

  if ([string]::IsNullOrEmpty($Text)) {
    return ''
  }

  $escape = [char]27
  return [regex]::Replace($Text, "$escape\[[0-9;?]*[ -/]*[@-~]", '')
}

function Get-FrontendStepDurations {
  param([object]$Frontend)

  $durations = [ordered]@{}
  if ($null -eq $Frontend -or $null -eq $Frontend.steps) {
    return $durations
  }

  foreach ($stepProperty in $Frontend.steps.PSObject.Properties) {
    $step = $stepProperty.Value
    $endAt = if ($null -ne $step.doneAtMs) {
      $step.doneAtMs
    } elseif ($null -ne $step.errorAtMs) {
      $step.errorAtMs
    } else {
      $null
    }

    if ($null -ne $step.activeAtMs -and $null -ne $endAt) {
      $durations[$stepProperty.Name] = [int]($endAt - $step.activeAtMs)
    }
  }

  if ($null -ne $Frontend.bootstrapOverlayCompletionDelayMs) {
    $durations['bootstrap-overlay-delay'] = [int]$Frontend.bootstrapOverlayCompletionDelayMs
  }

  return $durations
}

function Get-StartupPhaseMetrics {
  param(
    [object]$ReadyInfo,
    [object]$WindowInfo,
    [DateTimeOffset]$LaunchStartedAt
  )

  $phases = [ordered]@{
    launchToWindowMs = if ($WindowInfo.detected) { $WindowInfo.detectedElapsedMs } else { $null }
    windowToReadyMs = $ReadyInfo.windowToReadyMs
    windowToFrontendMountMs = $null
    frontendMountToReadySignalMs = $null
    readySignalToNativeLogMs = $null
  }

  $frontend = $ReadyInfo.frontend
  if ($ReadyInfo.detected -and $WindowInfo.detected -and $null -ne $frontend) {
    $launchEpochMs = [int64]$LaunchStartedAt.ToUnixTimeMilliseconds()
    $frontendMountElapsedMs = $null
    $frontendReadySignalElapsedMs = $null

    if ($null -ne $frontend.appMountedAtEpochMs) {
      $frontendMountElapsedMs = [int]([int64]$frontend.appMountedAtEpochMs - $launchEpochMs)
    } elseif ($null -ne $frontend.timeOriginMs) {
      $frontendMountElapsedMs = [int]([int64]$frontend.timeOriginMs - $launchEpochMs)
    }

    if ($null -ne $frontend.readySignalAtEpochMs) {
      $frontendReadySignalElapsedMs = [int]([int64]$frontend.readySignalAtEpochMs - $launchEpochMs)
    } elseif ($null -ne $frontendMountElapsedMs -and $null -ne $frontend.readyAfterAppMountMs) {
      $frontendReadySignalElapsedMs = $frontendMountElapsedMs + [int]$frontend.readyAfterAppMountMs
    }

    if ($null -ne $frontendMountElapsedMs) {
      $phases.windowToFrontendMountMs = $frontendMountElapsedMs - [int]$WindowInfo.detectedElapsedMs
    }
    if ($null -ne $frontend.readyAfterAppMountMs) {
      $phases.frontendMountToReadySignalMs = [int]$frontend.readyAfterAppMountMs
    }
    if ($null -ne $ReadyInfo.detectedElapsedMs -and $null -ne $frontendReadySignalElapsedMs) {
      $phases.readySignalToNativeLogMs = [int]$ReadyInfo.detectedElapsedMs - $frontendReadySignalElapsedMs
    }
  }

  return [ordered]@{
    phases = $phases
    frontendStepDurationsMs = Get-FrontendStepDurations -Frontend $frontend
  }
}

function Get-FrontendReadyElapsedMs {
  param(
    [object]$Frontend,
    [DateTimeOffset]$LaunchStartedAt
  )

  if ($null -eq $Frontend) {
    return $null
  }

  $launchEpochMs = [int64]$LaunchStartedAt.ToUnixTimeMilliseconds()
  if ($null -ne $Frontend.readySignalAtEpochMs) {
    return [int]([int64]$Frontend.readySignalAtEpochMs - $launchEpochMs)
  }

  $frontendMountElapsedMs = $null
  if ($null -ne $Frontend.appMountedAtEpochMs) {
    $frontendMountElapsedMs = [int]([int64]$Frontend.appMountedAtEpochMs - $launchEpochMs)
  } elseif ($null -ne $Frontend.timeOriginMs) {
    $frontendMountElapsedMs = [int]([int64]$Frontend.timeOriginMs - $launchEpochMs)
  }

  if ($null -eq $frontendMountElapsedMs -or $null -eq $Frontend.readyAfterAppMountMs) {
    return $null
  }

  return $frontendMountElapsedMs + [int]$Frontend.readyAfterAppMountMs
}

function Get-WindowToFrontendReadyMs {
  param(
    [object]$Frontend,
    [object]$WindowInfo,
    [DateTimeOffset]$LaunchStartedAt
  )

  if (-not $WindowInfo.detected -or $null -eq $WindowInfo.detectedElapsedMs) {
    return $null
  }

  $frontendReadyElapsedMs = Get-FrontendReadyElapsedMs -Frontend $Frontend -LaunchStartedAt $LaunchStartedAt
  if ($null -eq $frontendReadyElapsedMs) {
    return $null
  }

  return [int]$frontendReadyElapsedMs - [int]$WindowInfo.detectedElapsedMs
}

function Get-StartupPhaseThresholdIssues {
  param(
    [object]$PhaseMetrics,
    [object]$Thresholds
  )

  $issues = @()
  $phases = $PhaseMetrics.phases
  if ($null -ne $phases.windowToFrontendMountMs -and $phases.windowToFrontendMountMs -gt $Thresholds.maxWindowToFrontendMountMs) {
    $issues += "windowToFrontendMountMs=$($phases.windowToFrontendMountMs) exceeds $($Thresholds.maxWindowToFrontendMountMs)ms"
  }
  if ($null -ne $phases.frontendMountToReadySignalMs -and $phases.frontendMountToReadySignalMs -gt $Thresholds.maxFrontendBootstrapMs) {
    $issues += "frontendMountToReadySignalMs=$($phases.frontendMountToReadySignalMs) exceeds $($Thresholds.maxFrontendBootstrapMs)ms"
  }
  if ($null -ne $phases.readySignalToNativeLogMs -and $phases.readySignalToNativeLogMs -gt $Thresholds.maxReadySignalToNativeLogMs) {
    $issues += "readySignalToNativeLogMs=$($phases.readySignalToNativeLogMs) exceeds $($Thresholds.maxReadySignalToNativeLogMs)ms"
  }

  foreach ($stepName in $PhaseMetrics.frontendStepDurationsMs.Keys) {
    if (-not $Thresholds.frontendStepMs.Contains($stepName)) {
      continue
    }
    $duration = $PhaseMetrics.frontendStepDurationsMs[$stepName]
    $budget = $Thresholds.frontendStepMs[$stepName]
    if ($duration -gt $budget) {
      $issues += "frontend step '$stepName' duration ${duration}ms exceeds ${budget}ms"
    }
  }

  return $issues
}

function Get-DevCommandMetrics {
  param(
    [string]$StdoutPath,
    [string]$StderrPath,
    [string]$ViteStdoutPath = ''
  )

  $stdoutText = Read-TextFileIfExists -Path $StdoutPath
  if (-not [string]::IsNullOrWhiteSpace($ViteStdoutPath)) {
    $stdoutText = "$stdoutText`n$(Read-TextFileIfExists -Path $ViteStdoutPath)"
  }
  $stderrText = Read-TextFileIfExists -Path $StderrPath
  $stdoutText = Remove-AnsiEscapeSequences -Text $stdoutText
  $stderrText = Remove-AnsiEscapeSequences -Text $stderrText
  $metrics = [ordered]@{
    viteReadyMs = $null
    cargoBuildMs = $null
  }

  if ($stdoutText -match 'ready in\s+(?<value>\d+(?:\.\d+)?)\s*(?<unit>ms|s)') {
    $value = [double]$Matches['value']
    $metrics.viteReadyMs = if ($Matches['unit'] -eq 's') {
      [int][Math]::Round($value * 1000)
    } else {
      [int][Math]::Round($value)
    }
  }

  if ($stderrText -match 'Finished.+?in\s+(?<value>\d+(?:\.\d+)?)s') {
    $metrics.cargoBuildMs = [int][Math]::Round([double]$Matches['value'] * 1000)
  }

  return $metrics
}

$workspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$desktopRoot = Join-Path $workspaceRoot 'apps/desktop'
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$runId = "startup-readiness-$timestamp-$([Guid]::NewGuid().ToString('N').Substring(0, 8))"
$targetDir = Join-Path $workspaceRoot $OutputRoot
$runDir = Join-Path $targetDir $runId
New-Item -ItemType Directory -Force -Path $runDir | Out-Null

$reportPath = Join-Path $runDir 'report.json'
$markdownPath = Join-Path $runDir 'report.md'
$stdoutPath = Join-Path $runDir 'tauri-dev.stdout.log'
$stderrPath = Join-Path $runDir 'tauri-dev.stderr.log'
$viteStdoutPath = Join-Path $runDir 'vite-dev.stdout.log'
$viteStderrPath = Join-Path $runDir 'vite-dev.stderr.log'
$appLogPath = Join-Path $workspaceRoot 'artifacts/diagnostics/logs/app.log'
$tauriConfigOverridePath = Join-Path $runDir 'tauri.startup-readiness.conf.json'
$commandText = if ($UseExistingDevServer) {
  "npx tauri dev --config $tauriConfigOverridePath"
} else {
  'npm run dev --workspace @omni/desktop; npx tauri dev --config tauri.startup-readiness.conf.json'
}
if ($UseFastDev) {
  $devServerMode = 'managed-critical-warmup'
} elseif ($UseExistingDevServer) {
  $devServerMode = 'existing'
} else {
  $devServerMode = 'managed-prewarmed'
}

if ($DryRun) {
  $report = [ordered]@{
    schemaVersion = 1
    generatedAt = Get-UtcIsoNow
    runId = $runId
    dryRun = $true
    verdict = 'dry-run'
    command = $commandText
    timeoutSeconds = $TimeoutSeconds
    thresholds = New-StartupThresholds
    devServer = [ordered]@{
      mode = $devServerMode
      port = $DevServerPort
      listeners = @()
    }
    window = [ordered]@{
      detected = $false
      detectedAt = $null
      detectedElapsedMs = $null
      processId = $null
      processName = $null
      title = 'Omni Translate'
    }
    readiness = [ordered]@{
      detected = $false
      detectedAt = $null
      detectedElapsedMs = $null
      windowToReadyMs = $null
      frontend = $null
      markerLine = $null
    }
    artifacts = [ordered]@{
      report = $reportPath
      markdown = $markdownPath
      stdout = $stdoutPath
      stderr = $stderrPath
      viteStdout = $viteStdoutPath
      viteStderr = $viteStderrPath
      appLog = $appLogPath
    }
  }
  Write-JsonReport -Path $reportPath -Value $report
  Write-MarkdownReport -Path $markdownPath -Report $report
  Write-Output $reportPath
  return
}

$devServerListeners = @(Get-DevServerListeners -Port $DevServerPort)
if (-not $UseExistingDevServer -and $devServerListeners.Count -gt 0) {
  $report = [ordered]@{
    schemaVersion = 1
    generatedAt = Get-UtcIsoNow
    runId = $runId
    dryRun = $false
    verdict = 'dev-port-in-use'
    command = $commandText
    timeoutSeconds = $TimeoutSeconds
    thresholds = New-StartupThresholds
    devServer = [ordered]@{
      mode = $devServerMode
      port = $DevServerPort
      listeners = $devServerListeners
    }
    window = [ordered]@{
      detected = $false
      detectedAt = $null
      detectedElapsedMs = $null
      processId = $null
      processName = $null
      title = 'Omni Translate'
      startTime = $null
    }
    readiness = [ordered]@{
      detected = $false
      detectedAt = $null
      detectedElapsedMs = $null
      observedElapsedMs = $null
      windowToReadyMs = $null
      frontend = $null
      markerLine = $null
      payloadError = $null
    }
    process = [ordered]@{
      npmProcessId = $null
      exitedBeforeReady = $false
      noStop = [bool]$NoStop
    }
    artifacts = [ordered]@{
      report = $reportPath
      markdown = $markdownPath
      stdout = $stdoutPath
      stderr = $stderrPath
      viteStdout = $viteStdoutPath
      viteStderr = $viteStderrPath
      appLog = $appLogPath
    }
  }
  Write-JsonReport -Path $reportPath -Value $report
  Write-MarkdownReport -Path $markdownPath -Report $report
  Write-Output "Dev server port $DevServerPort is already in use. Use -UseExistingDevServer to measure against the existing Vite server."
  Write-Output $reportPath
  return
}

if ($UseExistingDevServer -and $devServerListeners.Count -eq 0) {
  $report = [ordered]@{
    schemaVersion = 1
    generatedAt = Get-UtcIsoNow
    runId = $runId
    dryRun = $false
    verdict = 'dev-port-not-listening'
    command = $commandText
    timeoutSeconds = $TimeoutSeconds
    thresholds = New-StartupThresholds
    devServer = [ordered]@{
      mode = $devServerMode
      port = $DevServerPort
      listeners = @()
    }
    window = [ordered]@{
      detected = $false
      detectedAt = $null
      detectedElapsedMs = $null
      processId = $null
      processName = $null
      title = 'Omni Translate'
      startTime = $null
    }
    readiness = [ordered]@{
      detected = $false
      detectedAt = $null
      detectedElapsedMs = $null
      observedElapsedMs = $null
      windowToReadyMs = $null
      frontend = $null
      markerLine = $null
      payloadError = $null
    }
    process = [ordered]@{
      npmProcessId = $null
      exitedBeforeReady = $false
      noStop = [bool]$NoStop
    }
    artifacts = [ordered]@{
      report = $reportPath
      markdown = $markdownPath
      stdout = $stdoutPath
      stderr = $stderrPath
      viteStdout = $viteStdoutPath
      viteStderr = $viteStderrPath
      appLog = $appLogPath
    }
  }
  Write-JsonReport -Path $reportPath -Value $report
  Write-MarkdownReport -Path $markdownPath -Report $report
  Write-Output "Dev server port $DevServerPort is not listening. Start Vite first or run without -UseExistingDevServer."
  Write-Output $reportPath
  return
}

$existingShellProcesses = @(Get-ExistingDesktopShellProcesses)
if ($existingShellProcesses.Count -gt 0) {
  $report = [ordered]@{
    schemaVersion = 1
    generatedAt = Get-UtcIsoNow
    runId = $runId
    dryRun = $false
    verdict = 'desktop-shell-already-running'
    command = $commandText
    timeoutSeconds = $TimeoutSeconds
    thresholds = New-StartupThresholds
    devServer = [ordered]@{
      mode = $devServerMode
      port = $DevServerPort
      listeners = $devServerListeners
    }
    window = [ordered]@{
      detected = $false
      detectedAt = $null
      detectedElapsedMs = $null
      processId = $null
      processName = $null
      title = 'Omni Translate'
      startTime = $null
    }
    readiness = [ordered]@{
      detected = $false
      detectedAt = $null
      detectedElapsedMs = $null
      observedElapsedMs = $null
      windowToReadyMs = $null
      frontend = $null
      markerLine = $null
      payloadError = $null
    }
    process = [ordered]@{
      npmProcessId = $null
      exitedBeforeReady = $false
      noStop = [bool]$NoStop
      existingDesktopShells = $existingShellProcesses
    }
    artifacts = [ordered]@{
      report = $reportPath
      markdown = $markdownPath
      stdout = $stdoutPath
      stderr = $stderrPath
      viteStdout = $viteStdoutPath
      viteStderr = $viteStderrPath
      appLog = $appLogPath
    }
  }
  Write-JsonReport -Path $reportPath -Value $report
  Write-MarkdownReport -Path $markdownPath -Report $report
  Write-Output "A dev desktop shell is already running. Close omni-desktop-shell.exe before measuring a fresh launch."
  Write-Output $reportPath
  return
}

$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if ($null -eq $npmCommand) {
  $npmCommand = Get-Command npm -ErrorAction Stop
}

$npxCommand = Get-Command npx.cmd -ErrorAction SilentlyContinue
if ($null -eq $npxCommand) {
  $npxCommand = Get-Command npx -ErrorAction SilentlyContinue
}

$initialLogOffset = 0
if (Test-Path $appLogPath) {
  $initialLogOffset = (Get-Item $appLogPath).Length
}

$oldMeasureRunId = $env:OMNI_STARTUP_MEASURE_RUN_ID
$oldViteMeasureRunId = $env:VITE_OMNI_STARTUP_MEASURE_RUN_ID
$viteProcess = $null
$devServerWarmup = $null
$devProcess = $null
$windowInfo = $null
$readyMarker = $null
$fullReadyMarkers = $null
$processExited = $false
$logOffset = $initialLogOffset
$logBuffer = ''
$launchStartedAtLocal = Get-Date
$launchStartedAtUtc = Get-UtcIsoNow
$stopwatch = [System.Diagnostics.Stopwatch]::new()

try {
  $env:OMNI_STARTUP_MEASURE_RUN_ID = $runId
  $env:VITE_OMNI_STARTUP_MEASURE_RUN_ID = $runId

  if ($null -eq $npxCommand) {
    throw 'npx was not found on PATH.'
  }

  if (-not $UseExistingDevServer) {
    $viteProcess = Start-Process `
      -FilePath $npmCommand.Source `
      -ArgumentList @('run', 'dev', '--workspace', '@omni/desktop') `
      -WorkingDirectory $workspaceRoot `
      -RedirectStandardOutput $viteStdoutPath `
      -RedirectStandardError $viteStderrPath `
      -PassThru `
      -WindowStyle Hidden

    if (-not (Wait-DevServerReady -Port $DevServerPort -TimeoutSeconds 45)) {
      throw "Vite dev server did not become ready on port $DevServerPort."
    }
    $devServerListeners = @(Get-DevServerListeners -Port $DevServerPort)
  }

  if ($NoWarmup) {
    $devServerWarmup = [ordered]@{ requestCount = 0; elapsedMs = 0; mode = "disabled" }
    Write-Output "Dev server warmup disabled (-NoWarmup)."
  } elseif ($UseFastDev) {
    $devServerWarmup = Invoke-CriticalDevServerWarmup -Port $DevServerPort -TimeoutMs $CriticalWarmupTimeoutMs
    Write-Output "Critical dev server warmup requested $($devServerWarmup.requestCount) assets in $($devServerWarmup.elapsedMs) ms (mode=critical, cap=$CriticalWarmupTimeoutMs)."
  } else {
    $devServerWarmup = Invoke-DevServerWarmup -Port $DevServerPort -MaxRequests 40
    Write-Output "Dev server warmup requested $($devServerWarmup.requestCount) assets in $($devServerWarmup.elapsedMs) ms."
  }

  @{ build = @{ beforeDevCommand = '' } } |
    ConvertTo-Json -Depth 4 |
    Set-Content -Path $tauriConfigOverridePath -Encoding UTF8
  $launchFile = $npxCommand.Source
  $launchArgs = @('tauri', 'dev', '--config', $tauriConfigOverridePath)
  $launchWorkingDirectory = $desktopRoot

  Write-Output "Startup readiness run: $runId"
  Write-Output "Launching: $commandText"

  $launchStartedAtLocal = Get-Date
  $launchStartedAtUtc = Get-UtcIsoNow
  $stopwatch.Restart()
  $devProcess = Start-Process `
    -FilePath $launchFile `
    -ArgumentList $launchArgs `
    -WorkingDirectory $launchWorkingDirectory `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -PassThru `
    -WindowStyle Hidden

  while ($stopwatch.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
    if ($null -eq $windowInfo) {
      $candidate = Find-MainWindowProcess -LaunchStartedAtLocal $launchStartedAtLocal
      if ($null -ne $candidate) {
        $windowInfo = [ordered]@{
          detected = $true
          detectedAt = Get-UtcIsoNow
          detectedElapsedMs = $stopwatch.ElapsedMilliseconds
          processId = $candidate.Process.Id
          processName = $candidate.Process.ProcessName
          title = $candidate.Process.MainWindowTitle
          startTime = $candidate.StartTime.ToString('o')
        }
        Write-Output "Window detected after $($windowInfo.detectedElapsedMs) ms (pid=$($windowInfo.processId))."
      }
    }

    $logRead = Read-NewTextFromFile -Path $appLogPath -Offset $logOffset
    $logOffset = $logRead.Offset
    if ($logRead.Text.Length -gt 0) {
      $logBuffer += $logRead.Text
      if ($logBuffer.Length -gt 200000) {
        $logBuffer = $logBuffer.Substring($logBuffer.Length - 200000)
      }

      $readyMarker = Find-ReadyMarker -Text $logBuffer -RunId $runId
      if ($null -eq $fullReadyMarkers -or -not $fullReadyMarkers.fullReady.detected) {
        $fullReadyMarkers = Find-FullReadyMarkers -Text $logBuffer
      }
      if ($null -ne $readyMarker) {
        break
      }
    }

    $devProcess.Refresh()
    if ($devProcess.HasExited) {
      $processExited = $true
      break
    }

    Start-Sleep -Milliseconds ([Math]::Max(50, [Math]::Min($WindowPollMs, $LogPollMs)))
  }
} finally {
  $env:OMNI_STARTUP_MEASURE_RUN_ID = $oldMeasureRunId
  $env:VITE_OMNI_STARTUP_MEASURE_RUN_ID = $oldViteMeasureRunId

  if (-not $NoStop -and $null -ne $devProcess) {
    if ($null -ne $windowInfo -and $null -ne $windowInfo.processId) {
      try {
        $windowProcess = Get-Process -Id $windowInfo.processId -ErrorAction SilentlyContinue
        if ($null -ne $windowProcess) {
          [void]$windowProcess.CloseMainWindow()
          Start-Sleep -Milliseconds 1500
        }
      } catch {
        # The process tree cleanup below is the fallback.
      }
    }

    Stop-ProcessTree -RootProcessId $devProcess.Id
    Stop-NewBuildProcesses -LaunchStartedAtLocal $launchStartedAtLocal -WaitSeconds 5
    Stop-NewMainWindows -LaunchStartedAtLocal $launchStartedAtLocal -WaitSeconds 10
  }

  if (-not $NoStop -and $null -ne $viteProcess) {
    Stop-ProcessTree -RootProcessId $viteProcess.Id
  }
}

$readyInfo = [ordered]@{
  detected = $false
  detectedAt = $null
  detectedElapsedMs = $null
  observedElapsedMs = $null
  windowToReadyMs = $null
  frontend = $null
  markerLine = $null
  payloadError = $null
}

if ($null -ne $readyMarker) {
  $readyObservedElapsedMs = $stopwatch.ElapsedMilliseconds
  $readyElapsedMs = $readyObservedElapsedMs
  $readyDetectedAt = Get-UtcIsoNow

  if ($null -ne $readyMarker.LogTimestamp) {
    $readyDetectedAt = ([DateTimeOffset]$readyMarker.LogTimestamp).ToUniversalTime().ToString('o')
    $fromLog = [int][Math]::Round(($readyMarker.LogTimestamp - $launchStartedAtLocal).TotalMilliseconds)
    if ($fromLog -ge 0) {
      $readyElapsedMs = $fromLog
    }
  }

  $windowToReadyMs = $null
  if ($null -ne $windowInfo -and $null -ne $windowInfo.detectedElapsedMs) {
    $windowToReadyMs = $readyElapsedMs - $windowInfo.detectedElapsedMs
  }
  $frontendWindowToReadyMs = Get-WindowToFrontendReadyMs `
    -Frontend $readyMarker.Payload `
    -WindowInfo $windowInfo `
    -LaunchStartedAt ([DateTimeOffset]::Parse($launchStartedAtUtc))
  if ($null -ne $frontendWindowToReadyMs) {
    $windowToReadyMs = $frontendWindowToReadyMs
  }

  $readyInfo = [ordered]@{
    detected = $true
    detectedAt = $readyDetectedAt
    detectedElapsedMs = $readyElapsedMs
    observedElapsedMs = $readyObservedElapsedMs
    windowToReadyMs = $windowToReadyMs
    frontend = $readyMarker.Payload
    markerLine = $readyMarker.Line
    payloadError = $readyMarker.PayloadError
  }
}

if ($null -eq $windowInfo) {
  $windowInfo = [ordered]@{
    detected = $false
    detectedAt = $null
    detectedElapsedMs = $null
    processId = $null
    processName = $null
    title = 'Omni Translate'
    startTime = $null
  }
}

$thresholds = New-StartupThresholds
$phaseMetrics = Get-StartupPhaseMetrics `
  -ReadyInfo $readyInfo `
  -WindowInfo $windowInfo `
  -LaunchStartedAt ([DateTimeOffset]::Parse($launchStartedAtUtc))
$phaseThresholdIssues = Get-StartupPhaseThresholdIssues -PhaseMetrics $phaseMetrics -Thresholds $thresholds
$devCommandMetrics = Get-DevCommandMetrics -StdoutPath $stdoutPath -StderrPath $stderrPath -ViteStdoutPath $viteStdoutPath

$failure = $null
$verdict = 'passed'
$bootstrapHadErrors = Test-FrontendBootstrapErrors -Frontend $readyInfo.frontend
if ($readyInfo.detected -and $bootstrapHadErrors) {
  $verdict = 'bootstrap-error-before-ready'
  $failure = [pscustomobject]@{
    verdict = $verdict
    summary = 'Frontend bootstrap completed through an error path, so the app was not considered functionally ready.'
  }
} elseif ($readyInfo.detected -and $null -ne $readyInfo.windowToReadyMs -and $readyInfo.windowToReadyMs -gt $MaxWindowToReadyMs) {
  $verdict = 'readiness-threshold-failed'
  $failure = [pscustomobject]@{
    verdict = $verdict
    summary = "Window-to-readiness latency exceeded the ${MaxWindowToReadyMs}ms threshold."
  }
} elseif ($readyInfo.detected -and $phaseThresholdIssues.Count -gt 0) {
  $verdict = 'startup-phase-threshold-failed'
  $failure = [pscustomobject]@{
    verdict = $verdict
    summary = "Startup phase thresholds failed: $($phaseThresholdIssues -join '; ')"
  }
} elseif (-not $readyInfo.detected) {
  $failure = Classify-DevFailure -StdoutPath $stdoutPath -StderrPath $stderrPath
  if ($null -ne $failure) {
    $verdict = $failure.verdict
  } elseif ($processExited) {
    $verdict = 'process-exited-before-ready'
  } elseif ($windowInfo.detected) {
    $verdict = 'ready-timeout'
  } else {
    $verdict = 'window-timeout'
  }
}

$report = [ordered]@{
  schemaVersion = 1
  generatedAt = Get-UtcIsoNow
  runId = $runId
  dryRun = $false
  verdict = $verdict
  command = $commandText
  launchStartedAt = $launchStartedAtUtc
  timeoutSeconds = $TimeoutSeconds
  thresholds = $thresholds
  devServer = [ordered]@{
    mode = $devServerMode
    port = $DevServerPort
    listeners = $devServerListeners
    configOverride = $tauriConfigOverridePath
    warmup = $devServerWarmup
  }
  poll = [ordered]@{
    windowPollMs = $WindowPollMs
    logPollMs = $LogPollMs
  }
  window = $windowInfo
  devCommandMetrics = if ($null -ne $devCommandMetrics) {
    $windowMs = if ($windowInfo.detected) { $windowInfo.detectedElapsedMs } else { $null }
    $readyMs = if ($readyInfo.detected) { $readyInfo.detectedElapsedMs } else { $null }
    $fullMs = if ($null -ne $fullReadyMarkers -and $fullReadyMarkers.fullReady.detected -and $null -ne $fullReadyMarkers.fullReady.timestamp) {
      [int][Math]::Round(($fullReadyMarkers.fullReady.timestamp - $launchStartedAtLocal).TotalMilliseconds)
    } else { $null }
    $windowToFullMs = if ($null -ne $windowMs -and $null -ne $fullMs) { $fullMs - $windowMs } else { $null }
    $routeMs = if ($null -ne $fullReadyMarkers -and $fullReadyMarkers.routeReady.detected -and $null -ne $fullReadyMarkers.routeReady.timestamp) {
      [int][Math]::Round(($fullReadyMarkers.routeReady.timestamp - $launchStartedAtLocal).TotalMilliseconds)
    } else { $null }
    $stylesMs = if ($null -ne $fullReadyMarkers -and $fullReadyMarkers.stylesReady.detected -and $null -ne $fullReadyMarkers.stylesReady.timestamp) {
      [int][Math]::Round(($fullReadyMarkers.stylesReady.timestamp - $launchStartedAtLocal).TotalMilliseconds)
    } else { $null }
    $bridgeMs = if ($null -ne $fullReadyMarkers -and $fullReadyMarkers.bridgeConverged.detected -and $null -ne $fullReadyMarkers.bridgeConverged.timestamp) {
      [int][Math]::Round(($fullReadyMarkers.bridgeConverged.timestamp - $launchStartedAtLocal).TotalMilliseconds)
    } else { $null }
    $extended = [ordered]@{}
    foreach ($key in $devCommandMetrics.Keys) { $extended[$key] = $devCommandMetrics[$key] }
    $extended['commandToWindowMs'] = $windowMs
    $extended['commandToReadyMs'] = $readyMs
    $extended['commandToFullReadyMs'] = $fullMs
    $extended['windowToFullReadyMs'] = $windowToFullMs
    $extended['routeLoadMs'] = $routeMs
    $extended['stylesLoadMs'] = $stylesMs
    $extended['bridgeConvergeMs'] = $bridgeMs
    $extended
  } else {
    $devCommandMetrics
  }
  readiness = $readyInfo
  fullReadiness = if ($null -ne $fullReadyMarkers) {
    [ordered]@{
      routeReady = if ($null -ne $fullReadyMarkers.routeReady) {
        [ordered]@{ detected = $true; elapsedMs = if ($null -ne $fullReadyMarkers.routeReady.timestamp) { [int][Math]::Round(($fullReadyMarkers.routeReady.timestamp - $launchStartedAtLocal).TotalMilliseconds) } else { $null } }
      } else { [ordered]@{ detected = $false; elapsedMs = $null } }
      stylesReady = if ($null -ne $fullReadyMarkers.stylesReady) {
        [ordered]@{ detected = $true; elapsedMs = if ($null -ne $fullReadyMarkers.stylesReady.timestamp) { [int][Math]::Round(($fullReadyMarkers.stylesReady.timestamp - $launchStartedAtLocal).TotalMilliseconds) } else { $null } }
      } else { [ordered]@{ detected = $false; elapsedMs = $null } }
      bridgeConverged = if ($null -ne $fullReadyMarkers.bridgeConverged) {
        [ordered]@{ detected = $true; elapsedMs = if ($null -ne $fullReadyMarkers.bridgeConverged.timestamp) { [int][Math]::Round(($fullReadyMarkers.bridgeConverged.timestamp - $launchStartedAtLocal).TotalMilliseconds) } else { $null }; convergence = $fullReadyMarkers.bridgeConverged.convergence }
      } else { [ordered]@{ detected = $false; elapsedMs = $null; convergence = $null } }
      fullReady = if ($null -ne $fullReadyMarkers.fullReady) {
        [ordered]@{ detected = $true; elapsedMs = if ($null -ne $fullReadyMarkers.fullReady.timestamp) { [int][Math]::Round(($fullReadyMarkers.fullReady.timestamp - $launchStartedAtLocal).TotalMilliseconds) } else { $null } }
      } else { [ordered]@{ detected = $false; elapsedMs = $null } }
    }
  } else {
    $null
  }
  phases = $phaseMetrics.phases
  frontendStepDurationsMs = $phaseMetrics.frontendStepDurationsMs
  failure = if ($null -ne $failure) {
    [ordered]@{
      summary = $failure.summary
      verdict = $failure.verdict
    }
  } else {
    $null
  }
  process = [ordered]@{
    npmProcessId = if ($null -ne $devProcess) { $devProcess.Id } else { $null }
    viteProcessId = if ($null -ne $viteProcess) { $viteProcess.Id } else { $null }
    exitedBeforeReady = $processExited
    noStop = [bool]$NoStop
    existingDesktopShells = @()
  }
  artifacts = [ordered]@{
    report = $reportPath
      markdown = $markdownPath
      stdout = $stdoutPath
      stderr = $stderrPath
      viteStdout = $viteStdoutPath
      viteStderr = $viteStderrPath
      appLog = $appLogPath
  }
}

Write-JsonReport -Path $reportPath -Value $report
Write-MarkdownReport -Path $markdownPath -Report $report
Write-Output $reportPath



