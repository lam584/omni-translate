param(
  [Parameter(Mandatory = $true)][string]$PayloadBase64,
  [Parameter(Mandatory = $true)][int]$TimeoutMs,
  [Parameter(Mandatory = $true)][string]$StdoutPath,
  [Parameter(Mandatory = $true)][string]$StderrPath
)

$ErrorActionPreference = 'Stop'
$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PayloadBase64)) | ConvertFrom-Json
foreach ($entry in $payload.environment.PSObject.Properties) {
  [Environment]::SetEnvironmentVariable($entry.Name, [string]$entry.Value, 'Process')
}

# All current preflight commands use discrete arguments. Start-Process keeps
# their process identity available, allowing taskkill /T to stop the complete
# smoke-owned tree when the hard deadline expires.
$process = Start-Process -FilePath $payload.command -ArgumentList @($payload.arguments) `
  -WorkingDirectory $payload.cwd -RedirectStandardOutput $StdoutPath `
  -RedirectStandardError $StderrPath -PassThru
if (-not $process.WaitForExit($TimeoutMs)) {
  & taskkill.exe /PID $process.Id /T /F | Out-Null
  $process.WaitForExit()
  exit 124
}
exit $process.ExitCode
