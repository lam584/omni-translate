$ErrorActionPreference = "Stop"

$desktopRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..\apps\desktop")).Path
$npmCommand = (Get-Command npm.cmd -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$npxCommand = (Get-Command npx.cmd -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$devUrl = "http://127.0.0.1:4173"

Write-Host "[dev:tauri:fast] Starting Tauri dev without rebuilding the release Native Bridge..."
Write-Host "[dev:tauri:fast] Starting and warming Vite before opening the desktop WebView..."

Push-Location $desktopRoot
try {
  & $npmCommand run predev
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }

  $vite = Start-Process -FilePath $npmCommand -ArgumentList @("run", "dev") -WorkingDirectory $desktopRoot -PassThru -WindowStyle Hidden
  try {
    $ready = $false
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
      if ($vite.HasExited) {
        throw "Vite exited before the development server became ready (exit code $($vite.ExitCode))."
      }
      try {
        $response = Invoke-WebRequest -Uri "$devUrl/src/main.tsx" -UseBasicParsing -TimeoutSec 2
        if ($response.StatusCode -eq 200) {
          $ready = $true
          break
        }
      } catch {
        Start-Sleep -Milliseconds 250
      }
    }
    if (-not $ready) {
      throw "Timed out waiting for Vite at $devUrl."
    }

    Write-Host "[dev:tauri:fast] Vite is warm; starting Tauri with the Cargo incremental cache..."
    $configOverride = '{\"build\":{\"beforeDevCommand\":\"\"}}'
    & $npxCommand tauri dev --config $configOverride
    exit $LASTEXITCODE
  } finally {
    if ($vite -and -not $vite.HasExited) {
      Stop-Process -Id $vite.Id -Force -ErrorAction SilentlyContinue
    }
  }
} finally {
  Pop-Location
}
