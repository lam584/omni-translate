$ErrorActionPreference = 'Stop'

function Test-IsAdministrator {
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-IsAdministrator)) {
  $arguments = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', "`"$($MyInvocation.MyCommand.Path)`""
  )

  try {
    $process = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -ArgumentList $arguments
    exit $process.ExitCode
  } catch {
    if ($_.Exception.NativeErrorCode -eq 1223) {
      Write-Error 'Administrator elevation was cancelled.'
      exit 1223
    }
    throw
  }
}

$workspaceRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
Push-Location $workspaceRoot
try {
  & 'npm.cmd' run build:bridge-service-native
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }

  & 'npm.cmd' run dev:tauri --workspace '@omni/desktop'
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
