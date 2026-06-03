#!/usr/bin/env pwsh
# PR-7: smoke test for the audio-routing v9 layout.
#
# Verifies that the production build succeeds and the dev server serves
# the entry HTML, the styles bundle, and the AudioRoutingPage module
# without HTTP errors. Catches asset-resolution regressions before
# they reach a real browser.
#
# Usage: pwsh scripts/smoke-audio-routing.ps1 [-KeepServer] [-Port 4173]
#
# -KeepServer leaves the dev server running on $Port for interactive
#   inspection (default: starts, runs assertions, stops).
# -Port picks an alternate dev server port.

param(
    [switch]$KeepServer = $false,
    [int]$Port = 4173
)

$ErrorActionPreference = 'Stop'
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$desktopRoot = Join-Path $repoRoot 'apps/desktop'

Write-Host '== step 1/4: typecheck ==' -ForegroundColor Cyan
& npm run --workspace=@omni/desktop check 2>&1 | Select-Object -Last 3
if ($LASTEXITCODE -ne 0) { throw 'typecheck failed' }

Write-Host '== step 2/4: production build ==' -ForegroundColor Cyan
& npm run --workspace=@omni/desktop build 2>&1 | Select-Object -Last 5
if ($LASTEXITCODE -ne 0) { throw 'build failed' }

Write-Host '== step 3/4: dev server smoke ==' -ForegroundColor Cyan
$devLog = Join-Path $env:TEMP 'pr7-dev.log'
$devErr = Join-Path $env:TEMP 'pr7-dev.err'
$viteBin = Join-Path $repoRoot 'node_modules/vite/bin/vite.js'
if (-not (Test-Path $viteBin)) { throw "vite bin not found at $viteBin" }
$devProcess = Start-Process -FilePath 'node' `
    -ArgumentList @($viteBin, '--port', $Port, '--host', '127.0.0.1') `
    -WorkingDirectory $desktopRoot `
    -RedirectStandardOutput $devLog `
    -RedirectStandardError $devErr `
    -WindowStyle Hidden `
    -PassThru

try {
    $ready = $false
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 500
        try {
            $probe = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 2
            if ($probe.StatusCode -eq 200) { $ready = $true; break }
        } catch {
            # server not ready yet
        }
    }
    if (-not $ready) { throw 'dev server failed to become ready within 10s' }

    $entry = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 15
    if ($entry.StatusCode -ne 200) { throw "entry returned $($entry.StatusCode)" }
    if ($entry.Content -notmatch 'id="root"') { throw 'entry html missing #root' }

    $css = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/src/styles.css" -UseBasicParsing -TimeoutSec 30
    if ($css.StatusCode -ne 200) { throw "styles.css returned $($css.StatusCode)" }
    if ($css.Content -notmatch 'routing-workspace-v9') { throw 'styles.css missing v9 selectors' }
    if ($css.Content -notmatch 'chain-flow-v2|chain-flow ') { throw 'styles.css missing chain-flow rules' }
    if ($css.Content -notmatch 'status-badge-pulse') { throw 'styles.css missing pulse animation' }

    $page = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/src/pages/AudioRoutingPage.tsx" -UseBasicParsing -TimeoutSec 30
    if ($page.StatusCode -ne 200) { throw "AudioRoutingPage.tsx returned $($page.StatusCode)" }
    if ($page.Content -notmatch 'routing-channel-section-unified') { throw 'AudioRoutingPage.tsx missing unified section' }

    Write-Host "  entry=$(($entry.Content | Measure-Object -Character).Characters)B" -ForegroundColor DarkGray
    Write-Host "  styles.css=$(($css.Content | Measure-Object -Character).Characters)B" -ForegroundColor DarkGray
    Write-Host "  AudioRoutingPage.tsx=$(($page.Content | Measure-Object -Character).Characters)B" -ForegroundColor DarkGray
}
finally {
    if (-not $KeepServer -and $devProcess -and -not $devProcess.HasExited) {
        Stop-Process -Id $devProcess.Id -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 500
    }
}

Write-Host '== step 4/4: tests ==' -ForegroundColor Cyan
$testLog = Join-Path $env:TEMP 'pr7-test.log'
$testErr = Join-Path $env:TEMP 'pr7-test.err'
$testProc = Start-Process -FilePath 'cmd.exe' `
    -ArgumentList @('/c', 'npx', 'vitest', 'run', '--root', $desktopRoot) `
    -WorkingDirectory $desktopRoot `
    -RedirectStandardOutput $testLog `
    -RedirectStandardError $testErr `
    -WindowStyle Hidden `
    -PassThru -Wait
if ($testProc.ExitCode -ne 0) {
    Get-Content $testLog -ErrorAction SilentlyContinue | Select-Object -Last 15 | ForEach-Object { Write-Host $_ }
    throw "tests failed with exit $($testProc.ExitCode)"
}
Get-Content $testLog -ErrorAction SilentlyContinue | Select-Object -Last 4 | ForEach-Object { Write-Host $_ }

if ($KeepServer) {
    Write-Host ""
    Write-Host "Dev server left running on http://127.0.0.1:$Port/ (pid $($devProcess.Id))" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "PR-7 smoke test: PASS" -ForegroundColor Green
