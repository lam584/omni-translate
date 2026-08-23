[CmdletBinding()]
param([switch]$Elevated)

$ErrorActionPreference = 'Stop'
$workspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$source = 'C:\ProgramData\Microsoft\VisualStudio\Packages'
$destination = Join-Path $workspaceRoot 'artifacts\testing\system-cache\visual-studio-packages'

if (-not $Elevated) {
  $self = $MyInvocation.MyCommand.Path
  $process = Start-Process -FilePath powershell.exe -Verb RunAs -PassThru -Wait -WindowStyle Hidden -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $self, '-Elevated'
  )
  exit $process.ExitCode
}

if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw "Visual Studio package cache is missing: $source" }
$sourceItem = Get-Item -LiteralPath $source -Force
if (($sourceItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Visual Studio package cache is already redirected: $source" }
if (Test-Path -LiteralPath $destination) { throw "Destination already exists; refusing to merge: $destination" }
New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
$result = Start-Process -FilePath robocopy.exe -PassThru -Wait -NoNewWindow -ArgumentList @($source, $destination, '/E', '/MOVE', '/COPY:DAT', '/DCOPY:DAT', '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS')
if ($result.ExitCode -ge 8) { throw "robocopy failed moving the Visual Studio package cache (exit $($result.ExitCode)); source was retained" }
if (Test-Path -LiteralPath $source) {
  if (@(Get-ChildItem -LiteralPath $source -Force -ErrorAction SilentlyContinue).Count -gt 0) { throw "Visual Studio package cache still contains files after move: $source" }
  Remove-Item -LiteralPath $source -Force
}
New-Item -ItemType Junction -Path $source -Target $destination | Out-Null
Write-Output "Moved Visual Studio package cache to $destination and created junction $source"
