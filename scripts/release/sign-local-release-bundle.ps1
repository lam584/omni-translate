param(
  [Parameter(Mandatory = $true)][string]$WorkspaceRoot,
  [Parameter(Mandatory = $true)][string]$BundleRoot,
  [string]$WindowsKitVersion = '10.0.26100.0'
)

$ErrorActionPreference = 'Stop'
$workspacePath = (Resolve-Path -LiteralPath $WorkspaceRoot).Path
$bundlePath = (Resolve-Path -LiteralPath $BundleRoot).Path
$current = Get-Content -LiteralPath (Join-Path $workspacePath 'artifacts\release-signing\current.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$signtool = "C:\Program Files (x86)\Windows Kits\10\bin\$WindowsKitVersion\x64\signtool.exe"
if (-not (Test-Path -LiteralPath $signtool -PathType Leaf)) { throw "SignTool was not found: $signtool" }
$password = (Get-Content -LiteralPath ([string]$current.passwordPath) -Raw -Encoding UTF8).Trim()
$targets = @(Get-ChildItem -LiteralPath $bundlePath -Recurse -File | Where-Object {
  @('.exe', '.msi', '.dll', '.ps1') -contains $_.Extension.ToLowerInvariant()
})
foreach ($target in $targets) {
  & $signtool sign /fd SHA256 /f ([string]$current.pfxPath) /p $password $target.FullName
  if ($LASTEXITCODE -ne 0) { throw "Local signing failed: $($target.FullName)" }
}
Copy-Item -LiteralPath ([string]$current.certificatePath) -Destination (Join-Path $bundlePath 'local-release-code-signing.cer') -Force
Write-Output "Signed $($targets.Count) release files with $($current.thumbprint)"
