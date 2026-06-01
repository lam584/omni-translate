param(
  [string]$WorkspaceRoot = '.'
)

$ErrorActionPreference = 'Stop'
$workspacePath = (Resolve-Path -LiteralPath $WorkspaceRoot).Path
$certificatePath = Join-Path $workspacePath 'drivers\windows-virtual-mic\package\omni-translate-development-driver.cer'
if (-not (Test-Path -LiteralPath $certificatePath -PathType Leaf)) {
  throw "Development driver certificate was not found: $certificatePath. Run scripts\installer\build-sysvad-driver.ps1 first."
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Trusting a development driver certificate requires an elevated PowerShell session.'
}

foreach ($store in @('Root', 'TrustedPublisher')) {
  & certutil.exe -addstore -f $store $certificatePath
  if ($LASTEXITCODE -ne 0) {
    throw "certutil failed to add the development certificate to LocalMachine\$store. ExitCode=$LASTEXITCODE"
  }
}
Write-Output 'Development driver certificate trusted in LocalMachine Root and TrustedPublisher.'
