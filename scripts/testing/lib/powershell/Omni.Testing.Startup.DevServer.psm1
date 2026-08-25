#requires -Version 5.1

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
      # Warmup is best-effort; the Node report engine evaluates readiness.
    }
  }

  return [ordered]@{
    requestCount = $requestCount
    elapsedMs = [int]$startedAt.ElapsedMilliseconds
  }
}


Export-ModuleMember -Function @('Get-DevServerListeners','Wait-DevServerReady','Resolve-DevServerAssetPath','Get-DevServerAssetDependencies','Invoke-CriticalDevServerWarmup','Invoke-DevServerWarmup')
