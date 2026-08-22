[CmdletBinding()]
param(
  [switch]$Execute,
  [switch]$IncludeLegacyCargoRegistry
)

$ErrorActionPreference = 'Stop'
$workspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$tempRoot = Join-Path $env:LOCALAPPDATA 'Temp'
$eCargoHome = Join-Path $workspaceRoot 'artifacts\testing\cargo-home'
$legacyCargoRegistry = Join-Path $env:USERPROFILE '.cargo\registry'
$cutoff = [DateTime]::UtcNow.AddDays(-1)

function Get-DirectoryBytes([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return 0L }
  return [long]((Get-ChildItem -LiteralPath $Path -Force -Recurse -ErrorAction SilentlyContinue |
    Measure-Object -Property Length -Sum).Sum)
}

function Get-ApprovedTempChild([string]$Path) {
  $resolvedPath = (Resolve-Path -LiteralPath $Path).Path
  $resolvedParent = (Resolve-Path -LiteralPath $tempRoot).Path.TrimEnd('\')
  if (-not $resolvedPath.StartsWith("$resolvedParent\", [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to clean a path outside TEMP: $resolvedPath"
  }
  return $resolvedPath
}

$targets = @(
  Get-ChildItem -LiteralPath $tempRoot -Directory -Filter 'watch-mode-evidence-*' -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTimeUtc -lt $cutoff } |
    ForEach-Object { [pscustomobject]@{ Path = Get-ApprovedTempChild $_.FullName; Kind = 'stale-watch-test-temp' } }
)
$wdk = Join-Path $tempRoot 'wdk'
if ((Test-Path -LiteralPath $wdk) -and (Get-Item -LiteralPath $wdk).LastWriteTimeUtc -lt $cutoff) {
  $targets += [pscustomobject]@{ Path = Get-ApprovedTempChild $wdk; Kind = 'stale-wdk-temp' }
}
if ($IncludeLegacyCargoRegistry -and (Test-Path -LiteralPath $legacyCargoRegistry)) {
  if ((Get-DirectoryBytes $eCargoHome) -le 0) {
    throw "Refusing to remove the legacy Cargo registry because the E: VM3 Cargo cache is empty: $eCargoHome"
  }
  $targets += [pscustomobject]@{ Path = (Resolve-Path -LiteralPath $legacyCargoRegistry).Path; Kind = 'legacy-cargo-registry' }
}

$planned = $targets | ForEach-Object {
  [pscustomobject]@{ Kind = $_.Kind; Path = $_.Path; SizeMiB = [math]::Round((Get-DirectoryBytes $_.Path) / 1MB, 1) }
}
$planned | Format-Table -AutoSize
$totalMiB = [math]::Round((($planned | Measure-Object -Property SizeMiB -Sum).Sum), 1)
if (-not $Execute) {
  Write-Output "Dry run only: $($planned.Count) approved directories, $totalMiB MiB reclaimable. Re-run with -Execute to delete exactly these paths."
  exit 0
}

$before = (Get-PSDrive -Name C).Free
$failures = @()
foreach ($target in $planned) {
  try { Remove-Item -LiteralPath $target.Path -Recurse -Force -ErrorAction Stop }
  catch { $failures += "$($target.Path): $($_.Exception.Message)" }
}
$after = (Get-PSDrive -Name C).Free
[pscustomobject]@{
  DeletedDirectories = $planned.Count - $failures.Count
  FailedDirectories = $failures.Count
  ReclaimedMiB = [math]::Round(($after - $before) / 1MB, 1)
  CFreeGiB = [math]::Round($after / 1GB, 2)
} | Format-List
if ($failures.Count -gt 0) { $failures; exit 1 }
