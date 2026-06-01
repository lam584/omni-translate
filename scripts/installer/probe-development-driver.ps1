param(
  [string]$WorkspaceRoot = (Join-Path $PSScriptRoot '..\..'),
  [string]$RuntimeRoot = (Join-Path $env:LOCALAPPDATA 'OmniTranslate\bridge-runtime'),
  [switch]$ProbeSecureBootElevated
)

$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom
. (Join-Path $PSScriptRoot 'virtual-speaker-device.ps1')

function Get-TestSigningEnabled {
  $startOptions = (Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control' -Name SystemStartOptions -ErrorAction SilentlyContinue).SystemStartOptions
  if ($startOptions) {
    return [bool]($startOptions -match '(?i)(^|\s)TESTSIGNING(\s|$)')
  }
  $output = & (Join-Path $env:SystemRoot 'System32\bcdedit.exe') /enum 2>$null
  return [bool]($output -match '(?im)^\s*testsigning\s+(Yes|On|\u662F|\u5F00\u542F)\s*$')
}

function Get-SecureBootEnabled {
  try {
    return [bool](Confirm-SecureBootUEFI)
  } catch {
    return $null
  }
}

function Get-SecureBootProbeResult {
  $secureBootEnabled = Get-SecureBootEnabled
  if ($null -ne $secureBootEnabled) {
    return @{ Enabled = $secureBootEnabled; Status = 'detected' }
  }
  if (-not $ProbeSecureBootElevated) {
    return @{ Enabled = $null; Status = 'unavailable' }
  }

  $resultPath = Join-Path $env:TEMP ("omni-secure-boot-" + [guid]::NewGuid().ToString() + '.json')
  try {
    $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'probe-secure-boot-elevated.ps1'), '-ResultPath', $resultPath)
    Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -Wait -ArgumentList $arguments
    if (-not (Test-Path -LiteralPath $resultPath -PathType Leaf)) {
      return @{ Enabled = $null; Status = 'unavailable' }
    }
    $result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
    return @{ Enabled = $result.secureBootEnabled; Status = $result.status }
  } catch {
    if ($_.Exception.NativeErrorCode -eq 1223) {
      return @{ Enabled = $null; Status = 'cancelled' }
    }
    return @{ Enabled = $null; Status = 'unavailable' }
  } finally {
    Remove-Item -LiteralPath $resultPath -Force -ErrorAction SilentlyContinue
  }
}

function Get-DriverPackageMetadata([string]$WorkspacePath) {
  $path = Join-Path $WorkspacePath 'drivers\windows-virtual-mic\package\driver-package.json'
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    return $null
  }
  return Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
}

$workspacePath = (Resolve-Path -LiteralPath $WorkspaceRoot).Path
$runtimeStatePath = Join-Path $RuntimeRoot 'driver-install-state.json'
$runtimeState = $null
if (Test-Path -LiteralPath $runtimeStatePath -PathType Leaf) {
  try {
    $runtimeState = Get-Content -LiteralPath $runtimeStatePath -Raw | ConvertFrom-Json
  } catch {
    $runtimeState = $null
  }
}

$rootDevices = @(Get-OmniVirtualSpeakerRootDevices)
$endpoint = Get-OmniVirtualSpeakerEndpoint
$metadata = Get-DriverPackageMetadata $workspacePath
$testSigningEnabled = Get-TestSigningEnabled
$secureBootProbe = Get-SecureBootProbeResult
$secureBootEnabled = $secureBootProbe.Enabled
$abiVersion = $null
$ioctlAvailable = $false
$probeError = $null

if ($rootDevices.Count -eq 1 -and $rootDevices[0].Status -eq 'OK' -and $endpoint) {
  try {
    $probe = Invoke-OmniVirtualAudioProbe
    $abiVersion = ('0x{0:X8}' -f $probe.AbiVersion).ToUpperInvariant()
    $ioctlAvailable = $true
  } catch {
    $probeError = $_.Exception.Message
  }
}

$driverHealth = 'not-installed'
$errorCode = $null
if ($rootDevices.Count -gt 1) {
  $driverHealth = 'damaged'
  $errorCode = 'driver.duplicate-root-devices'
} elseif ($rootDevices.Count -eq 1) {
  if ($rootDevices[0].Status -ne 'OK') {
    $driverHealth = 'damaged'
    $errorCode = 'driver.operation-failed'
  } elseif (-not $endpoint) {
    $driverHealth = 'damaged'
    $errorCode = 'driver.endpoint-missing'
  } elseif (-not $ioctlAvailable) {
    $driverHealth = 'damaged'
    $errorCode = 'driver.ioctl-unavailable'
  } elseif ($abiVersion -ne '0X20260601') {
    $driverHealth = 'version-mismatch'
    $errorCode = 'driver.abi-mismatch'
  } elseif ($runtimeState -and $runtimeState.driverBackend -ne 'sysvad-wave-rt') {
    $driverHealth = 'damaged'
    $errorCode = 'driver.operation-failed'
  } else {
    $driverHealth = 'running'
  }
}

if ($driverHealth -eq 'not-installed' -and -not $testSigningEnabled) {
  $errorCode = if ($secureBootEnabled -eq $true) { 'driver.secure-boot-enabled' } else { 'driver.testsigning-disabled' }
}

[ordered]@{
  schemaVersion = 1
  driverHealth = $driverHealth
  errorCode = $errorCode
  testSigningEnabled = $testSigningEnabled
  secureBootEnabled = $secureBootEnabled
  secureBootProbeStatus = $secureBootProbe.Status
  rootDeviceCount = $rootDevices.Count
  rootInstanceIds = @($rootDevices | ForEach-Object { $_.InstanceId })
  endpointName = if ($endpoint) { $endpoint.FriendlyName } else { $null }
  abiVersion = $abiVersion
  ioctlAvailable = $ioctlAvailable
  installedDriverVersion = if ($runtimeState) { $runtimeState.driverVersion } else { $null }
  packageConfiguration = if ($metadata) { $metadata.configuration } else { $null }
  packageSigningMode = if ($metadata) { $metadata.signingMode } else { $null }
  runtimeStatePresent = [bool]$runtimeState
  detail = $probeError
} | ConvertTo-Json -Depth 5 -Compress
