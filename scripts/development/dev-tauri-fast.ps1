param(
  [int]$DevServerPort = 4173,
  [int]$DevServerStartTimeoutSeconds = 45,
  [int]$CriticalWarmupTimeoutMs = 1200,
  [switch]$SkipCargo,
  [switch]$ForceCargo
)

$ErrorActionPreference = "Stop"
$desktopRoot = "$PSScriptRoot\..\..\apps\desktop"
$workspaceRoot = "$PSScriptRoot\..\.."
$srcTauriRoot = "$desktopRoot\src-tauri"
$debugExe = "$srcTauriRoot\target\debug\omni-desktop-shell.exe"
$cargoToml = "$srcTauriRoot\Cargo.toml"
$cargoLock = "$srcTauriRoot\Cargo.lock"

function Test-BinaryFresh {
  $exe = Get-Item $debugExe -ErrorAction SilentlyContinue
  if (-not $exe) { return $false }
  $timestamp = $exe.LastWriteTime

  $rustSources = Get-ChildItem -Path "$srcTauriRoot\src" -Recurse -Filter *.rs -ErrorAction SilentlyContinue
  foreach ($f in $rustSources) {
    if ($f.LastWriteTime -gt $timestamp) { return $false }
  }
  foreach ($f in @($cargoToml, $cargoLock)) {
    $item = Get-Item $f -ErrorAction SilentlyContinue
    if ($item -and $item.LastWriteTime -gt $timestamp) { return $false }
  }
  return $true
}

Write-Host "[dev:tauri:fast] Checking binary freshness..."

$fresh = $false
if (-not $ForceCargo) {
  $fresh = Test-BinaryFresh
  if ($fresh) {
    Write-Host "[dev:tauri:fast] Binary is fresh, skipping cargo."
  } else {
    Write-Host "[dev:tauri:fast] Rust sources newer than binary, will rebuild."
  }
}

$env:OMNI_TAURI_FAST_START = "1"
$env:VITE_OMNI_STARTUP_MEASURE_RUN_ID = "tauri-fast-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"

# 1. Start or reuse Vite dev server
$existing = Get-NetTCPConnection -LocalPort $DevServerPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $existing) {
  Write-Host "[dev:tauri:fast] Starting Vite dev server..."
  $vite = Start-Process -FilePath (Get-Command npm -ErrorAction Stop).Source `
    -ArgumentList @("run", "dev", "--workspace", "@omni/desktop") `
    -WorkingDirectory $workspaceRoot `
    -PassThru `
    -WindowStyle Hidden

  Write-Host "[dev:tauri:fast] Waiting for Vite on port $DevServerPort..."
  $deadline = (Get-Date).AddSeconds($DevServerStartTimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $listeners = @(Get-NetTCPConnection -LocalPort $DevServerPort -State Listen -ErrorAction SilentlyContinue)
    if ($listeners.Count -gt 0) {
      try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$DevServerPort/" -UseBasicParsing -TimeoutSec 5
        if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500) { break }
      } catch {}
    }
    Start-Sleep -Milliseconds 200
  }
  Write-Host "[dev:tauri:fast] Vite ready."
} else {
  Write-Host "[dev:tauri:fast] Reusing existing Vite on port $DevServerPort."
}

# 2. Critical resource warmup (parallel, best-effort, 1200ms max)
$criticalPaths = @(
  "/",
  "/src/main.tsx",
  "/src/App.tsx",
  "/src/styles/startup.css",
  "/src/router.tsx",
  "/src/router-startup.ts",
  "/src/pages/RealTimeSessionPage.tsx"
)

$warmupStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$jobs = @()
foreach ($path in $criticalPaths) {
  $uri = "http://127.0.0.1:$DevServerPort$path"
  $jobs += Start-Job -ScriptBlock {
    param($u)
    try { Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 3 *> $null } catch {}
  } -ArgumentList $uri
}

while ($jobs.State -contains "Running" -and $warmupStopwatch.ElapsedMilliseconds -lt $CriticalWarmupTimeoutMs) {
  Start-Sleep -Milliseconds 50
}
$jobs | Remove-Job -Force -ErrorAction SilentlyContinue
Write-Host "[dev:tauri:fast] Warmup completed in $($warmupStopwatch.ElapsedMilliseconds)ms."

# 3. Launch Tauri desktop shell
if ($fresh -and -not $ForceCargo) {
  # Direct debug exe launch: skip `tauri dev` entirely
  Write-Host "[dev:tauri:fast] Launching existing debug exe..."

  # Prepare a minimal tauri config so Vite knows what to serve
  $overrideConfig = @{
    build = @{
      beforeDevCommand = ""
      devUrl = "http://127.0.0.1:$DevServerPort"
      frontendDist = "..\dist"
    }
  }
  $overridePath = [System.IO.Path]::GetTempPath() + "omni-tauri-fast-override-$($env:OMNI_TAURI_FAST_START).json"
  $overrideConfig | ConvertTo-Json -Depth 4 | Set-Content -Path $overridePath -Encoding UTF8

  $env:TAURI_CONFIG_PATH = $overridePath
  $env:TAURI_DEV_DISABLE_CARGO = "1"

  # Use tauri dev --no-dev-server-wait so it skips vite start, uses existing
  & npx tauri dev --no-dev-server-wait --config $overridePath
} else {
  # Fallback: standard tauri dev
  Write-Host "[dev:tauri:fast] Falling back to tauri dev (cargo rebuild)..."
  & npx tauri dev --no-dev-server-wait
}
