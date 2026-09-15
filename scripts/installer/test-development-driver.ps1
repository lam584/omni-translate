param(
  [string]$ExpectedEndpointName = 'Omni Translate Virtual Speaker',
  [string]$ExpectedCaptureEndpointName = 'Omni Translate Virtual Microphone',
  [string]$WorkspaceRoot = (Join-Path $PSScriptRoot '..\..'),
  [string]$PhysicalPlaybackDeviceId = '',
  [string]$VirtualMicEvidenceOutputDirectory = ''
)

$ErrorActionPreference = 'Stop'
$windowsPowerShellSecurityModule = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'
Import-Module $windowsPowerShellSecurityModule -Force
trap {
  Write-Error $_
  exit 1
}
. (Join-Path $PSScriptRoot 'virtual-speaker-device.ps1')

function Get-OmniSha256 {
  param([Parameter(Mandatory)][string]$LiteralPath)
  $stream = [System.IO.File]::OpenRead($LiteralPath)
  $algorithm = [System.Security.Cryptography.SHA256]::Create()
  try {
    return ([System.BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
  } finally {
    $algorithm.Dispose()
    $stream.Dispose()
  }
}

function Get-OmniInstalledDriverAuthority {
  param([string]$WorkspacePath, [string]$RootInstanceId)
  $resolvedWorkspace = (Resolve-Path -LiteralPath $WorkspacePath).Path
  $packageRoot = Join-Path $resolvedWorkspace 'drivers\windows-virtual-mic\package'
  $packageSysPath = Join-Path $packageRoot 'omni-virtual-speaker.sys'
  $packageCatPath = Join-Path $packageRoot 'omni-virtual-speaker.cat'
  $packageInfPath = Join-Path $packageRoot 'omni-virtual-speaker.inf'
  foreach ($requiredPath in @($packageSysPath, $packageCatPath, $packageInfPath)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
      throw "Current-HEAD driver package artifact is missing: $requiredPath"
    }
  }

  $service = Get-CimInstance Win32_SystemDriver -Filter "Name='omni_translate_virtual_speaker'" -ErrorAction Stop
  if (-not $service -or [string]::IsNullOrWhiteSpace([string]$service.PathName)) {
    throw 'Installed omni_translate_virtual_speaker service binary path is unavailable'
  }
  $installedSysPath = [string]$service.PathName
  $installedSysPath = $installedSysPath.Trim().Trim('"')
  if ($installedSysPath.StartsWith('\??\', [System.StringComparison]::Ordinal)) {
    $installedSysPath = $installedSysPath.Substring('\??\'.Length)
  }
  if ($installedSysPath.StartsWith('\SystemRoot\', [System.StringComparison]::OrdinalIgnoreCase)) {
    $installedSysPath = Join-Path $env:SystemRoot $installedSysPath.Substring('\SystemRoot\'.Length)
  }
  $installedSysPath = [Environment]::ExpandEnvironmentVariables($installedSysPath)
  if (-not (Test-Path -LiteralPath $installedSysPath -PathType Leaf)) {
    throw "Installed Omni driver binary is missing: $installedSysPath"
  }

  $packageSysSha256 = Get-OmniSha256 -LiteralPath $packageSysPath
  $packageCatSha256 = Get-OmniSha256 -LiteralPath $packageCatPath
  $packageInfSha256 = Get-OmniSha256 -LiteralPath $packageInfPath
  $installedSysSha256 = Get-OmniSha256 -LiteralPath $installedSysPath
  if ($packageSysSha256 -ne $installedSysSha256) {
    throw "Installed Omni driver binary does not match the current-HEAD package: installed=$installedSysSha256 package=$packageSysSha256 path=$installedSysPath"
  }
  $pnpProperties = @(Get-PnpDeviceProperty -InstanceId $RootInstanceId -ErrorAction Stop)
  $pnpInfName = [string](
    $pnpProperties | Where-Object KeyName -eq 'DEVPKEY_Device_DriverInfPath' |
      Select-Object -First 1 -ExpandProperty Data
  )
  $pnpDriverVersion = [string](
    $pnpProperties | Where-Object KeyName -eq 'DEVPKEY_Device_DriverVersion' |
      Select-Object -First 1 -ExpandProperty Data
  )
  $pnpDriverProvider = [string](
    $pnpProperties | Where-Object KeyName -eq 'DEVPKEY_Device_DriverProvider' |
      Select-Object -First 1 -ExpandProperty Data
  )
  $pnpService = [string](
    $pnpProperties | Where-Object KeyName -eq 'DEVPKEY_Device_Service' |
      Select-Object -First 1 -ExpandProperty Data
  )
  $pnpMatchingDeviceId = [string](
    $pnpProperties | Where-Object KeyName -eq 'DEVPKEY_Device_MatchingDeviceId' |
      Select-Object -First 1 -ExpandProperty Data
  )
  $driverStorePackage = Get-WindowsDriver -Online -ErrorAction Stop |
    Where-Object { [string]$_.Driver -eq $pnpInfName } |
    Select-Object -First 1
  $signedDriverCandidates = @(Get-CimInstance Win32_PnPSignedDriver -ErrorAction SilentlyContinue |
    Where-Object {
      [string]$_.DeviceID -eq $RootInstanceId -or
      [string]$_.InfName -eq $pnpInfName
    })
  if ($signedDriverCandidates.Count -gt 1) {
    throw "Win32_PnPSignedDriver observation is exposed-conflicting because multiple installed rows matched $RootInstanceId / $pnpInfName"
  }
  $signedDriver = if ($signedDriverCandidates.Count -eq 1) { $signedDriverCandidates[0] } else { $null }
  $infVersionMatch = [regex]::Match(
    (Get-Content -LiteralPath $packageInfPath -Raw -Encoding UTF8),
    '(?im)^\s*DriverVer\s*=\s*[^,]+,\s*([0-9]+(?:\.[0-9]+){1,3})\s*$'
  )
  if (-not $infVersionMatch.Success) {
    throw "DriverVer is missing or invalid in $packageInfPath"
  }
  $packageDriverVersion = $infVersionMatch.Groups[1].Value
  $driverBinding = [pscustomobject]@{
    instanceId = $RootInstanceId
    matchingDeviceId = $pnpMatchingDeviceId
    infName = $pnpInfName
    driverVersion = $pnpDriverVersion
    driverProvider = $pnpDriverProvider
    service = $pnpService
  }
  if (
    -not $driverStorePackage -or
    -not (Test-OmniPnpDriverStoreAuthorityRecord `
      -Binding $driverBinding `
      -Package $driverStorePackage `
      -ExpectedDriverVersion $packageDriverVersion) -or
    (
      $signedDriver -and
      -not (Test-OmniInstalledDriverAuthorityRecord `
        -Candidate $signedDriver `
        -Binding $driverBinding `
        -Package $driverStorePackage `
        -ExpectedDriverVersion $packageDriverVersion)
    )
  ) {
    throw "Installed PnP/DriverStore authority or optional Win32_PnPSignedDriver observation did not match the current package for $RootInstanceId"
  }
  $driverStoreRoot = Split-Path -Parent ([string]$driverStorePackage.OriginalFileName)
  $driverStoreInfPath = Join-Path $driverStoreRoot 'omni-virtual-speaker.inf'
  $driverStoreCatPath = Join-Path $driverStoreRoot 'omni-virtual-speaker.cat'
  $driverStoreSysPath = Join-Path $driverStoreRoot 'omni-virtual-speaker.sys'
  foreach ($requiredPath in @($driverStoreInfPath, $driverStoreCatPath, $driverStoreSysPath)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
      throw "Installed DriverStore authority file is missing: $requiredPath"
    }
  }
  $driverStoreInfSha256 = Get-OmniSha256 -LiteralPath $driverStoreInfPath
  $driverStoreCatSha256 = Get-OmniSha256 -LiteralPath $driverStoreCatPath
  $driverStoreSysSha256 = Get-OmniSha256 -LiteralPath $driverStoreSysPath
  if (
    $driverStoreInfSha256 -ne $packageInfSha256 -or
    $driverStoreCatSha256 -ne $packageCatSha256 -or
    $driverStoreSysSha256 -ne $packageSysSha256 -or
    $driverStoreSysSha256 -ne $installedSysSha256
  ) {
    throw 'Installed DriverStore INF/CAT/SYS bytes do not match the current package and running service binary.'
  }
  $installedSignature = Get-AuthenticodeSignature -LiteralPath $installedSysPath
  $packageCatalogSignature = Get-AuthenticodeSignature -LiteralPath $packageCatPath
  $driverStoreSysSignature = Get-AuthenticodeSignature -LiteralPath $driverStoreSysPath
  $driverStoreCatSignature = Get-AuthenticodeSignature -LiteralPath $driverStoreCatPath
  $driverStoreInfSignature = Get-AuthenticodeSignature -LiteralPath $driverStoreInfPath
  if (
    $installedSignature.Status -ne 'Valid' -or
    $packageCatalogSignature.Status -ne 'Valid' -or
    $driverStoreSysSignature.Status -ne 'Valid' -or
    $driverStoreCatSignature.Status -ne 'Valid' -or
    -not $installedSignature.SignerCertificate -or
    -not $packageCatalogSignature.SignerCertificate -or
    -not $driverStoreSysSignature.SignerCertificate -or
    -not $driverStoreCatSignature.SignerCertificate -or
    $installedSignature.SignerCertificate.Thumbprint -ne $packageCatalogSignature.SignerCertificate.Thumbprint -or
    $installedSignature.SignerCertificate.Thumbprint -ne $driverStoreSysSignature.SignerCertificate.Thumbprint -or
    $installedSignature.SignerCertificate.Thumbprint -ne $driverStoreCatSignature.SignerCertificate.Thumbprint
  ) {
    throw "Installed SYS and package CAT do not have the same valid Authenticode signer for $RootInstanceId"
  }
  return [pscustomobject]@{
    installedServiceName = [string]$service.Name
    installedServiceState = [string]$service.State
    installedSysPath = $installedSysPath
    installedSysSha256 = $installedSysSha256
    packageSysPath = $packageSysPath
    packageSysSha256 = $packageSysSha256
    packageCatSha256 = $packageCatSha256
    packageInfSha256 = $packageInfSha256
    installedInfName = $pnpInfName
    installedDriverVersion = $pnpDriverVersion
    installedDriverProvider = $pnpDriverProvider
    installedSigner = [string]$installedSignature.SignerCertificate.Subject
    installedIsSigned = $true
    wmiCandidatePresent = [bool]$signedDriver
    wmiProbeStatus = if ($signedDriver) { 'exposed-consistent' } else { 'not-exposed-yet' }
    wmiSigner = if ($signedDriver) { [string]$signedDriver.Signer } else { $null }
    wmiIsSigned = if ($signedDriver) { [bool]$signedDriver.IsSigned } else { $null }
    pnpDriverInfName = $pnpInfName
    pnpDriverVersion = $pnpDriverVersion
    pnpDriverProvider = $pnpDriverProvider
    pnpService = $pnpService
    pnpMatchingDeviceId = $pnpMatchingDeviceId
    driverStorePublishedName = [string]$driverStorePackage.Driver
    driverStoreVersion = [string]$driverStorePackage.Version
    driverStoreProvider = [string]$driverStorePackage.ProviderName
    driverStoreClass = [string]$driverStorePackage.ClassName
    driverStoreRoot = $driverStoreRoot
    driverStoreInfPath = $driverStoreInfPath
    driverStoreInfSha256 = $driverStoreInfSha256
    driverStoreInfSignatureStatus = [string]$driverStoreInfSignature.Status
    driverStoreCatPath = $driverStoreCatPath
    driverStoreCatSha256 = $driverStoreCatSha256
    driverStoreCatSignatureStatus = [string]$driverStoreCatSignature.Status
    driverStoreCatSignerThumbprint = [string]$driverStoreCatSignature.SignerCertificate.Thumbprint
    driverStoreSysPath = $driverStoreSysPath
    driverStoreSysSha256 = $driverStoreSysSha256
    driverStoreSysSignatureStatus = [string]$driverStoreSysSignature.Status
    driverStoreSysSignerThumbprint = [string]$driverStoreSysSignature.SignerCertificate.Thumbprint
    installedSysSignatureStatus = [string]$installedSignature.Status
    installedSysSignerThumbprint = if ($installedSignature.SignerCertificate) { [string]$installedSignature.SignerCertificate.Thumbprint } else { $null }
    packageCatalogSignatureStatus = [string]$packageCatalogSignature.Status
    packageCatalogSignerThumbprint = if ($packageCatalogSignature.SignerCertificate) { [string]$packageCatalogSignature.SignerCertificate.Thumbprint } else { $null }
  }
}

$rootDevices = @(Assert-OmniVirtualSpeakerRootDeviceCount 1)
$rootDevice = $rootDevices[0]
if ($rootDevice.Status -ne 'OK') {
  throw "Root\OmniTranslateVirtualSpeaker is not running. Status=$($rootDevice.Status), Problem=$($rootDevice.Problem)"
}

$endpoint = Get-OmniVirtualSpeakerEndpoint $ExpectedEndpointName
if (-not $endpoint) {
  throw "$ExpectedEndpointName endpoint was not found."
}
$captureEndpoint = Get-OmniVirtualMicrophoneEndpoint $ExpectedCaptureEndpointName
if (-not $captureEndpoint) {
  throw "$ExpectedCaptureEndpointName capture endpoint was not found."
}

$status = Invoke-OmniVirtualAudioProbe
if ($status.AbiVersion -ne 0x20260810) {
  throw ('Unexpected driver ABI version: 0x{0:X8}' -f $status.AbiVersion)
}
$driverAuthority = Get-OmniInstalledDriverAuthority $WorkspaceRoot $rootDevice.InstanceId
$audioProbe = Invoke-OmniWasapiAudioProbe $WorkspaceRoot
if ([string]::IsNullOrWhiteSpace($VirtualMicEvidenceOutputDirectory)) {
  $workspacePath = (Resolve-Path -LiteralPath $WorkspaceRoot).Path
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
  $VirtualMicEvidenceOutputDirectory = Join-Path $workspacePath "artifacts\testing\manual-e2e\virtual-mic-capture-$stamp"
}
$targetCaptureArguments = @{
  WorkspaceRoot = $WorkspaceRoot
  OutputDirectory = $VirtualMicEvidenceOutputDirectory
}
if (-not [string]::IsNullOrWhiteSpace($PhysicalPlaybackDeviceId)) {
  $targetCaptureArguments.PhysicalPlaybackDeviceId = $PhysicalPlaybackDeviceId
}
$targetCaptureProbe = Invoke-OmniVirtualMicTargetCaptureProbe @targetCaptureArguments
[pscustomobject]@{
  Endpoint = $endpoint.FriendlyName
  CaptureEndpoint = $captureEndpoint.FriendlyName
  RootInstanceId = $rootDevice.InstanceId
  InstalledDriverAuthority = $driverAuthority
  AbiVersion = ('0x{0:X8}' -f $status.AbiVersion)
  RingCapacityBytes = $status.RingCapacityBytes
  BufferedBytes = $status.BufferedBytes
  MaxBufferedBytes = $status.MaxBufferedBytes
  CapturedBytes = $status.CapturedBytes
  DeliveredBytes = $status.DeliveredBytes
  DroppedBytes = $status.DroppedBytes
  RenderStreamsCreated = $status.RenderStreamsCreated
  RenderRunTransitions = $status.RenderRunTransitions
  RenderSetWritePacketCalls = $status.RenderSetWritePacketCalls
  RenderReadBytesCalls = $status.RenderReadBytesCalls
  LoopbackCaptureReadCalls = $status.LoopbackCaptureReadCalls
  MicRingCapacityBytes = $status.MicRingCapacityBytes
  MicBufferedBytes = $status.MicBufferedBytes
  MicMaxBufferedBytes = $status.MicMaxBufferedBytes
  MicSampleRateHz = $status.MicSampleRateHz
  MicChannelCount = $status.MicChannelCount
  MicBitsPerSample = $status.MicBitsPerSample
  MicSessionActive = $status.MicSessionActive
  MicGeneration = $status.MicGeneration
  MicWrittenBytes = $status.MicWrittenBytes
  MicConsumedBytes = $status.MicConsumedBytes
  MicDroppedBytes = $status.MicDroppedBytes
  MicUnderrunBytes = $status.MicUnderrunBytes
  MicRejectedWrites = $status.MicRejectedWrites
  AudioProbePassed = [bool]$audioProbe.passed
  AudioProbeDetail = $audioProbe.detail
  WasapiEndpointId = $audioProbe.endpointId
  CapturedBytesBeforeTone = $audioProbe.capturedBytesBeforeTone
  CapturedBytesAfterTone = $audioProbe.capturedBytesAfterTone
  DeliveredBytesBeforeTone = $audioProbe.deliveredBytesBeforeTone
  DeliveredBytesAfterTone = $audioProbe.deliveredBytesAfterTone
  DroppedBytesAfterTone = $audioProbe.droppedBytesAfterTone
  IdleFrames = $audioProbe.idleFrames
  IdlePeak = $audioProbe.idlePeak
  IdleRms = $audioProbe.idleRms
  ToneFrames = $audioProbe.toneFrames
  TonePeak = $audioProbe.tonePeak
  ToneRms = $audioProbe.toneRms
  ToneFrequencyHz = $audioProbe.toneFrequencyHz
  ToneComponent = $audioProbe.toneComponent
  PostToneIdleFrames = $audioProbe.postToneIdleFrames
  PostToneIdlePeak = $audioProbe.postToneIdlePeak
  PostToneIdleRms = $audioProbe.postToneIdleRms
  SilentPackets = $audioProbe.silentPackets
  InvalidSamples = $audioProbe.invalidSamples
  VirtualMicCaptureEndpointId = $audioProbe.virtualMic.endpointId
  VirtualMicCaptureEndpointName = $audioProbe.virtualMic.endpointName
  VirtualMicProbeGeneration = $audioProbe.virtualMic.generation
  VirtualMicProbeToneFrames = $audioProbe.virtualMic.toneFrames
  VirtualMicProbeTonePeak = $audioProbe.virtualMic.tonePeak
  VirtualMicProbeToneRms = $audioProbe.virtualMic.toneRms
  VirtualMicProbeToneFrequencyHz = $audioProbe.virtualMic.toneFrequencyHz
  VirtualMicProbeToneComponent = $audioProbe.virtualMic.toneComponent
  VirtualMicProbeWrittenBytes = $audioProbe.virtualMic.writtenBytes
  VirtualMicProbeConsumedBytes = $audioProbe.virtualMic.consumedBytes
  VirtualMicProbeDroppedBytes = $audioProbe.virtualMic.droppedBytes
  VirtualMicProbeUnderrunBytes = $audioProbe.virtualMic.underrunBytes
  VirtualMicProbeRejectedWrites = $audioProbe.virtualMic.rejectedWrites
  VirtualMicEvidenceOutputDirectory = $targetCaptureProbe.outputDirectory
  VirtualMicEvidenceCaptureWav = $targetCaptureProbe.captureWav
  VirtualMicEvidenceCaptureProbe = $targetCaptureProbe.captureProbe
  VirtualMicEvidenceRuntimeSnapshot = $targetCaptureProbe.runtimeSnapshot
  VirtualMicEvidenceCapturedFrames = $targetCaptureProbe.capturedFrames
  VirtualMicEvidenceFramesWrittenForCue = $targetCaptureProbe.virtualMicFramesWrittenForCue
  VirtualMicEvidencePhysicalPlaybackFramesForCue = $targetCaptureProbe.physicalPlaybackFramesWrittenForCue
}
