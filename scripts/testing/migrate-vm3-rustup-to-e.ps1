[CmdletBinding()]
param([switch]$Execute)

$ErrorActionPreference = 'Stop'
$workspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$source = Join-Path $env:USERPROFILE '.rustup'
$destination = Join-Path $workspaceRoot 'artifacts\testing\rustup-home'

if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw "Rustup source is missing: $source" }
if (-not $Execute) {
  $bytes = (Get-ChildItem -LiteralPath $source -Force -Recurse | Measure-Object -Property Length -Sum).Sum
  Write-Output "Dry run only: migrate $source to $destination ($([math]::Round($bytes / 1MB, 1)) MiB). Re-run with -Execute."
  exit 0
}
if (Test-Path -LiteralPath $destination) { throw "Destination already exists; refusing to merge: $destination" }
New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
$cargo = Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe'
if (-not (Test-Path -LiteralPath $cargo -PathType Leaf)) { throw "Cargo launcher is missing: $cargo" }
$env:RUSTUP_HOME = $destination
& $cargo --version
if ($LASTEXITCODE -ne 0) { throw 'Migrated Rustup home failed cargo verification; source was preserved' }
Remove-Item -LiteralPath $source -Recurse -Force
[Environment]::SetEnvironmentVariable('RUSTUP_HOME', $destination, 'User')
[Environment]::SetEnvironmentVariable('CARGO_HOME', (Join-Path $workspaceRoot 'artifacts\testing\cargo-home'), 'User')
Write-Output "Migrated Rustup home to E: and configured future user sessions to use E: caches."
