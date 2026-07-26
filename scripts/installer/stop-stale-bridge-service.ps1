param(
  [string]$WorkspaceRoot = '.',
  [string]$RuntimeRoot = (Join-Path $WorkspaceRoot 'artifacts\diagnostics\logs'),
  [string]$PipeName = 'omni-bridge-ipc'
)

$ErrorActionPreference = 'Stop'

$pidPath = Join-Path $RuntimeRoot 'bridge-service.pid'
if (-not (Test-Path -LiteralPath $pidPath)) {
  return
}

$rawPid = (Get-Content -LiteralPath $pidPath -Raw).Trim()
$bridgePid = 0
if (-not [int]::TryParse($rawPid, [ref]$bridgePid)) {
  throw "bridge.stale-pid-invalid: $rawPid"
}

$process = Get-Process -Id $bridgePid -ErrorAction SilentlyContinue
if (-not $process) {
  Remove-Item -LiteralPath $pidPath -Force
  return
}

$workspacePath = (Resolve-Path -LiteralPath $WorkspaceRoot).Path
# Root Cargo workspace target directory first; legacy per-crate target directory second.
$expectedPaths = @(
  (Join-Path $workspacePath 'target\release\omni-bridge-service.exe'),
  (Join-Path $workspacePath 'apps\bridge-service-native\target\release\omni-bridge-service.exe')
) | ForEach-Object { [System.IO.Path]::GetFullPath($_) }
$actualProcessPath = $process.Path
if ([string]::IsNullOrWhiteSpace($actualProcessPath)) {
  $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $bridgePid" -ErrorAction SilentlyContinue
  $actualProcessPath = $processInfo.ExecutablePath
}
if ([string]::IsNullOrWhiteSpace($actualProcessPath)) {
  if ($process.ProcessName -eq 'omni-bridge-service') {
    Stop-Process -Id $bridgePid -Force -ErrorAction Stop
    [void]$process.WaitForExit(3000)
    Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
    return
  }
  throw "bridge.stale-process-path-unavailable: pid=$bridgePid processName=$($process.ProcessName)"
}
$actualPath = [System.IO.Path]::GetFullPath($actualProcessPath)
$pathMatched = $false
foreach ($expectedPath in $expectedPaths) {
  if ([string]::Equals($actualPath, $expectedPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    $pathMatched = $true
    break
  }
}
if (-not $pathMatched) {
  throw "bridge.stale-process-path-mismatch: pid=$bridgePid actual=$actualPath expected=$($expectedPaths -join ' | ')"
}

$client = $null
try {
  $client = [System.IO.Pipes.NamedPipeClientStream]::new(
    '.',
    $PipeName,
    [System.IO.Pipes.PipeDirection]::InOut,
    [System.IO.Pipes.PipeOptions]::Asynchronous
  )
  $client.Connect(500)
  $writer = [System.IO.StreamWriter]::new($client)
  $writer.AutoFlush = $true
  $reader = [System.IO.StreamReader]::new($client)
  $request = [ordered]@{
    type = 'bridge.shutdown'
    requestId = "installer-shutdown-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
    sessionId = 'installer-cleanup'
    reason = 'manual-stop'
  } | ConvertTo-Json -Compress
  $writer.WriteLine($request)
  [void]$reader.ReadLine()
} catch {
  # Older sidecars may not support shutdown. The exact PID fallback below remains bounded by the path check.
} finally {
  if ($client) {
    $client.Dispose()
  }
}

if ($process.WaitForExit(1000)) {
  Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
  return
}

Stop-Process -Id $bridgePid -Force -ErrorAction Stop
[void]$process.WaitForExit(3000)
Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
