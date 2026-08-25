param(
  [Parameter(Mandatory = $true)][string]$RequestPath
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

$resolvedRequestPath = (Resolve-Path -LiteralPath $RequestPath -ErrorAction Stop).Path
$request = Get-Content -LiteralPath $resolvedRequestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($request.schemaVersion -cne 'watch-mode-run-request/v1') {
  throw "unsupported Watch Mode request schema: $($request.schemaVersion)"
}

Import-Module (Join-Path $PSScriptRoot 'lib/powershell/Omni.Testing.WatchMode.Config.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'lib/powershell/Omni.Testing.WatchMode.Runner.psm1') -Force -DisableNameChecking

$context = New-OmniWatchModeContext -Request $request -WorkspaceRoot (Join-Path $PSScriptRoot '../..')
Invoke-WatchModeRun -Context $context -Request $request -DevconPath ([string]$env:OMNI_WATCH_MODE_DEVCON_PATH)
