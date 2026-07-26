$ErrorActionPreference = "Stop"

$workspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
# Root workspace target directory first; legacy per-crate target directory second.
$releaseExecutables = @(
    (Join-Path $workspaceRoot "target\release\omni-desktop-shell.exe"),
    (Join-Path $workspaceRoot "apps\desktop\src-tauri\target\release\omni-desktop-shell.exe")
)

$matchingProcesses = Get-Process -Name "omni-desktop-shell" -ErrorAction SilentlyContinue |
    Where-Object { $releaseExecutables -contains $_.Path }

foreach ($process in $matchingProcesses) {
    Write-Host "Stopping stale desktop release process $($process.Id)..."
    Stop-Process -Id $process.Id -Force
    Wait-Process -Id $process.Id -ErrorAction SilentlyContinue
}
