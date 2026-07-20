param(
  [int]$Port = 4173
)

$ErrorActionPreference = "Stop"

$listeners = @(
  Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique
)

if ($listeners.Count -eq 0) {
  Write-Host "[dev:port] Port $Port is available."
  exit 0
}

foreach ($processId in $listeners) {
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  $processName = if ($process) { $process.ProcessName } else { "unknown" }
  Write-Host "[dev:port] Stopping PID $processId ($processName) listening on port $Port..."
  Stop-Process -Id $processId -Force -ErrorAction Stop
}

Start-Sleep -Milliseconds 300

$remaining = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
if ($remaining.Count -gt 0) {
  throw "Port $Port is still occupied after stopping its listener."
}

Write-Host "[dev:port] Port $Port has been released."
