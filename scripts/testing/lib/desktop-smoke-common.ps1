#requires -Version 5.1
<#
.SYNOPSIS
  Shared side-effect helpers for the desktop smoke/stress runners
  (run-overlay-driver-smoke.ps1, run-startup-ipc-stress.ps1).

.DESCRIPTION
  Dot-source this file from a runner; it only defines functions and never
  executes anything on load. Runner-specific behavior (e.g. each script's
  Stop-DesktopShellProcesses policy) stays in the runner itself.
#>

function Set-Utf8NoBomContent {
  param([string]$Path, [string]$Value)
  $encoding = [System.Text.UTF8Encoding]::new($false)
  [System.IO.File]::WriteAllText($Path, $Value, $encoding)
}

function Get-FileLength {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return 0
  }
  return (Get-Item -LiteralPath $Path).Length
}

function Read-TextDelta {
  param([string]$Path, [long]$Offset)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return ''
  }
  $stream = $null
  $reader = $null
  try {
    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    if ($stream.Length -lt $Offset) {
      $Offset = 0
    }
    [void]$stream.Seek($Offset, [System.IO.SeekOrigin]::Begin)
    $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::UTF8, $true)
    return $reader.ReadToEnd()
  } catch {
    return ''
  } finally {
    if ($null -ne $reader) { $reader.Dispose() } elseif ($null -ne $stream) { $stream.Dispose() }
  }
}

function Get-ChildProcessIds {
  param([int]$ParentId)
  foreach ($child in @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$ParentId" -ErrorAction SilentlyContinue)) {
    [int]$child.ProcessId
    Get-ChildProcessIds -ParentId ([int]$child.ProcessId)
  }
}

function Stop-ProcessTree {
  param([int]$RootProcessId)
  $ids = @((Get-ChildProcessIds -ParentId $RootProcessId) + $RootProcessId | Select-Object -Unique)
  [array]::Reverse($ids)
  foreach ($id in $ids) {
    Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
  }
}
