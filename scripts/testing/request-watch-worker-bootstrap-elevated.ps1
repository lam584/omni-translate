[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][ValidateSet('LockPrivateKeyAcl','RotateSshHostKey','InstallBootReadinessTask','RemoveBootReadinessTask')][string]$Action,
  [string]$PrivateKeyPath = 'E:\id_rsa',
  [string]$ReadinessRoot = 'C:\ProgramData\OmniTranslate\watch-worker-readiness'
)
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'bootstrap-watch-worker.ps1'
$arguments = @(
  '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
  '-File', ('"{0}"' -f $script),
  '-Action', $Action,
  '-PrivateKeyPath', ('"{0}"' -f $PrivateKeyPath),
  '-ReadinessRoot', ('"{0}"' -f $ReadinessRoot)
) -join ' '
$process = Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -ArgumentList $arguments -Wait -PassThru
if ($process.ExitCode -ne 0) { throw "Elevated worker bootstrap failed with exit code $($process.ExitCode)" }
