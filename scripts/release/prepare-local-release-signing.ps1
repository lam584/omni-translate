param([string]$WorkspaceRoot = '.')

$ErrorActionPreference = 'Stop'
$workspacePath = (Resolve-Path -LiteralPath $WorkspaceRoot).Path
$releaseId = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
& (Join-Path $PSScriptRoot 'new-local-release-certificate.ps1') -WorkspaceRoot $workspacePath -ReleaseId $releaseId | Out-Null
$current = Get-Content -LiteralPath (Join-Path $workspacePath 'artifacts\release-signing\current.json') -Raw -Encoding UTF8 | ConvertFrom-Json
& (Join-Path $workspacePath 'scripts\installer\build-sysvad-driver.ps1') `
  -WorkspaceRoot $workspacePath `
  -Configuration Release `
  -SigningPfxPath ([string]$current.pfxPath) `
  -SigningPfxPasswordPath ([string]$current.passwordPath)
if ($LASTEXITCODE -ne 0) { throw "Local self-signed driver build failed. ExitCode=$LASTEXITCODE" }
Write-Output ([string]$current.releaseId)
