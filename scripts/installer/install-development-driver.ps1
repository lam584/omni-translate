param(
  [Parameter(Mandatory = $true)][string]$WorkspaceRoot,
  [Parameter(Mandatory = $true)][string]$RuntimeRoot,
  [Parameter(Mandatory = $true)][string]$InstallChannel,
  [Parameter(Mandatory = $true)][string]$DriverVersion,
  [Parameter(Mandatory = $true)][string]$BridgeVersion,
  [Parameter(Mandatory = $true)][string]$TargetDeviceId,
  [string]$VirtualRenderDeviceId = 'omni-virtual-speaker-default',
  [switch]$SkipTrustCertificate,
  [switch]$AllowDebugDriver
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'virtual-speaker-device.ps1')
& (Join-Path $PSScriptRoot 'stop-stale-bridge-service.ps1') -WorkspaceRoot $WorkspaceRoot -RuntimeRoot $RuntimeRoot

function Find-Devcon {
  $toolsRoot = 'C:\Program Files (x86)\Windows Kits\10\Tools'
  $devcon = Get-ChildItem -LiteralPath $toolsRoot -Recurse -File -Filter devcon.exe -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '\\x64\\devcon\.exe$' } |
    Sort-Object FullName -Descending |
    Select-Object -First 1
  if (-not $devcon) {
    throw "WDK devcon.exe was not found under $toolsRoot"
  }
  return $devcon.FullName
}

function Assert-KernelDebuggingEnabled {
  $bcdedit = Join-Path $env:SystemRoot 'System32\bcdedit.exe'
  if (-not (Test-Path -LiteralPath $bcdedit -PathType Leaf)) {
    throw "bcdedit.exe was not found at $bcdedit"
  }
  $bootConfiguration = & $bcdedit /enum '{current}' 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to inspect the current boot configuration with bcdedit.exe. ExitCode=$LASTEXITCODE"
  }
  if ($bootConfiguration -notmatch '(?im)^\s*debug\s+Yes\s*$') {
    throw 'Refusing to install a Debug SYSVAD package because kernel debugging is not enabled for the current boot entry. Enable and connect a kernel debugger before retrying.'
  }
}

Assert-OmniAdministrator
$workspacePath = (Resolve-Path -LiteralPath $WorkspaceRoot).Path
$packageRoot = Join-Path $workspacePath 'drivers\windows-virtual-mic\package'
$infPath = Join-Path $packageRoot 'omni-virtual-speaker.inf'
$sysPath = Join-Path $packageRoot 'omni-virtual-speaker.sys'
$catPath = Join-Path $packageRoot 'omni-virtual-speaker.cat'
$hardwareId = 'Root\OmniTranslateVirtualSpeaker'
$metadataPath = Join-Path $packageRoot 'driver-package.json'

foreach ($requiredPath in @($infPath, $sysPath, $catPath)) {
  if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
    throw "SYSVAD driver package is incomplete. Missing: $requiredPath. Run scripts\installer\build-sysvad-driver.ps1 on a WDK-enabled Windows machine first."
  }
}
if (Test-Path -LiteralPath $metadataPath -PathType Leaf) {
  $metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
  if ($metadata.configuration -eq 'Debug' -and -not $AllowDebugDriver) {
    throw 'Refusing to install a Debug SYSVAD package without -AllowDebugDriver. Build the development package with -Configuration Release.'
  }
  if ($metadata.configuration -eq 'Debug') {
    Assert-KernelDebuggingEnabled
  }
}

$certificatePath = Join-Path $packageRoot 'omni-translate-development-driver.cer'
if ((Test-Path -LiteralPath $certificatePath -PathType Leaf) -and -not $SkipTrustCertificate) {
  & (Join-Path $PSScriptRoot 'trust-development-driver-certificate.ps1') -WorkspaceRoot $workspacePath
  if ($LASTEXITCODE -ne 0) {
    throw "Development driver certificate trust failed. ExitCode=$LASTEXITCODE"
  }
}

$pnputil = Join-Path $env:SystemRoot 'System32\pnputil.exe'
if (-not (Test-Path -LiteralPath $pnputil -PathType Leaf)) {
  throw "pnputil.exe was not found at $pnputil"
}
$devcon = Find-Devcon

New-Item -ItemType Directory -Force -Path $RuntimeRoot | Out-Null

& $pnputil /add-driver $infPath
if ($LASTEXITCODE -notin @(0, 259, 3010)) {
  throw "pnputil failed to stage the SYSVAD driver package. ExitCode=$LASTEXITCODE. Enable TESTSIGNING on the dedicated test machine with scripts\installer\enable-test-signing.ps1 and restart Windows."
}

$rootDevices = @(Get-OmniVirtualSpeakerRootDevices)
if ($rootDevices.Count -gt 1) {
  throw "Multiple $hardwareId ROOT devices are present: $($rootDevices.InstanceId -join ', '). Run npm run driver:uninstall before installing."
}
if ($rootDevices.Count -eq 0) {
  & $devcon install $infPath $hardwareId
  if ($LASTEXITCODE -notin @(0, 1)) {
    throw "devcon failed to create $hardwareId. ExitCode=$LASTEXITCODE. Enable TESTSIGNING and restart Windows before retrying."
  }
} else {
  & $pnputil /add-driver $infPath /install
  if ($LASTEXITCODE -notin @(0, 259, 3010)) {
    throw "pnputil failed to update $hardwareId. ExitCode=$LASTEXITCODE"
  }
}
$rootDevices = @(Assert-OmniVirtualSpeakerRootDeviceCount 1)
$rootDevice = $rootDevices[0]
if ($rootDevice.Status -ne 'OK') {
  throw "$hardwareId is present but not running. InstanceId=$($rootDevice.InstanceId), Status=$($rootDevice.Status), Problem=$($rootDevice.Problem)"
}

$deadline = (Get-Date).AddSeconds(20)
do {
  $virtualSpeaker = Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object {
    $_.Class -eq 'AudioEndpoint' -and $_.FriendlyName -like '*Omni Translate Virtual Speaker*'
  } | Select-Object -First 1
  if ($virtualSpeaker) {
    break
  }
  Start-Sleep -Milliseconds 250
} while ((Get-Date) -lt $deadline)
if (-not $virtualSpeaker) {
  throw 'The ROOT device was installed, but the Omni Translate Virtual Speaker endpoint did not appear within 20 seconds.'
}
& (Join-Path $PSScriptRoot 'test-development-driver.ps1') -WorkspaceRoot $WorkspaceRoot
if (-not $?) {
  throw 'The Omni Translate Virtual Speaker endpoint audio validation failed.'
}

$state = [ordered]@{
  protocolVersion = '2026-07-27-smart-gain-v3'
  installChannel = $InstallChannel
  driverVersion = $DriverVersion
  bridgeVersion = $BridgeVersion
  driverHealth = 'running'
  installedAt = (Get-Date).ToUniversalTime().ToString('o')
  targetDeviceId = $TargetDeviceId
  virtualRenderDeviceId = $VirtualRenderDeviceId
  driverBackend = 'sysvad-wave-rt'
  deviceName = 'Omni Translate Virtual Speaker'
  installedInfPath = $infPath
  pnpInstanceId = $rootDevice.InstanceId
  endpointInstanceId = $virtualSpeaker.InstanceId
}

$json = $state | ConvertTo-Json -Depth 4
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $RuntimeRoot 'driver-install-state.json'), $json, $utf8NoBom)

Write-Output "SYSVAD virtual audio driver installed for $VirtualRenderDeviceId"
