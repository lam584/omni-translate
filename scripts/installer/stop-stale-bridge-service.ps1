param(
  [string]$WorkspaceRoot = '.',
  [string]$RuntimeRoot = (Join-Path $env:LOCALAPPDATA 'OmniTranslate\bridge-runtime'),
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
$expectedPath = [System.IO.Path]::GetFullPath(
  (Join-Path $workspacePath 'apps\bridge-service-native\target\release\omni-bridge-service.exe')
)
$actualPath = [System.IO.Path]::GetFullPath($process.Path)
if (-not [string]::Equals($actualPath, $expectedPath, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "bridge.stale-process-path-mismatch: pid=$bridgePid actual=$actualPath expected=$expectedPath"
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
$process.WaitForExit()
Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
