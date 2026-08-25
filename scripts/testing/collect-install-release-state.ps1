param(
  [Parameter(Mandatory = $true)][ValidateSet('system', 'health', 'signatures')][string]$Mode,
  [Parameter(Mandatory = $true)][string]$WorkspaceRoot,
  [Parameter(Mandatory = $true)][string]$RuntimeRoot,
  [Parameter(Mandatory = $true)][string]$OutputPath,
  [string]$EvidenceOutputDirectory = ''
)

$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

Import-Module (Join-Path $PSScriptRoot 'lib/powershell/Omni.Testing.IO.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'lib/powershell/Omni.Testing.Windows.psm1') -Force

function Get-SignatureEvidence([string]$Path, [string]$RelativePath) {
  $signature = Get-AuthenticodeSignature -LiteralPath $Path
  return [ordered]@{
    path = $RelativePath.Replace('\', '/')
    status = [string]$signature.Status
    statusMessage = [string]$signature.StatusMessage
    signatureType = [string]$signature.SignatureType
    signerThumbprint = if ($signature.SignerCertificate) { [string]$signature.SignerCertificate.Thumbprint } else { $null }
    signerSubject = if ($signature.SignerCertificate) { [string]$signature.SignerCertificate.Subject } else { $null }
    timeStamperThumbprint = if ($signature.TimeStamperCertificate) { [string]$signature.TimeStamperCertificate.Thumbprint } else { $null }
    timeStamperSubject = if ($signature.TimeStamperCertificate) { [string]$signature.TimeStamperCertificate.Subject } else { $null }
  }
}

function Get-DriverStoreFileEvidence([string]$Path) {
  $present = [bool](Test-Path -LiteralPath $Path -PathType Leaf)
  return [ordered]@{
    path = $Path
    present = $present
    bytes = if ($present) { [long](Get-Item -LiteralPath $Path).Length } else { $null }
    sha256 = if ($present) { Get-OmniSha256 -LiteralPath $Path } else { $null }
    signature = if ($present) { Get-SignatureEvidence $Path $Path } else { $null }
  }
}

function Resolve-ServiceBinaryPath([string]$RawPath) {
  if ([string]::IsNullOrWhiteSpace($RawPath)) { return $null }
  $resolved = $RawPath.Trim().Trim('"')
  if ($resolved.StartsWith('\??\', [System.StringComparison]::Ordinal)) {
    $resolved = $resolved.Substring('\??\'.Length)
  }
  if ($resolved.StartsWith('\SystemRoot\', [System.StringComparison]::OrdinalIgnoreCase)) {
    $resolved = Join-Path $env:SystemRoot $resolved.Substring('\SystemRoot\'.Length)
  }
  return [Environment]::ExpandEnvironmentVariables($resolved)
}

function Get-PnpPropertyData([object[]]$Properties, [string]$KeyName) {
  $property = $Properties | Where-Object { $_.KeyName -eq $KeyName } | Select-Object -First 1
  if ($property) { return [string]$property.Data }
  return $null
}

function Write-Result([object]$Value) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputPath) | Out-Null
  [System.IO.File]::WriteAllText(
    [System.IO.Path]::GetFullPath($OutputPath),
    (($Value | ConvertTo-Json -Depth 32) + [Environment]::NewLine),
    $utf8NoBom
  )
}

$workspacePath = (Resolve-Path -LiteralPath $WorkspaceRoot).Path
$runtimePath = [System.IO.Path]::GetFullPath($RuntimeRoot)
$capturedAt = (Get-Date).ToUniversalTime().ToString('o')

if ($Mode -eq 'signatures') {
  $extensions = @('.exe', '.dll', '.sys', '.cat', '.ps1')
  $signatures = @(Get-ChildItem -LiteralPath $workspacePath -Recurse -File | Where-Object {
    $extensions -contains $_.Extension.ToLowerInvariant()
  } | Sort-Object FullName | ForEach-Object {
    $relative = $_.FullName.Substring($workspacePath.Length).TrimStart([char[]]"\\/")
    Get-SignatureEvidence $_.FullName $relative
  })
  Write-Result ([ordered]@{
    schemaVersion = 1
    artifactKind = 'omni-release-package-signature-inventory'
    capturedAt = $capturedAt
    packageRoot = $workspacePath
    signatures = $signatures
  })
  exit 0
}

. (Join-Path $workspacePath 'scripts\installer\virtual-speaker-device.ps1')
. (Join-Path $PSScriptRoot 'powershell-script-authority.ps1')
. (Join-Path $PSScriptRoot 'virtual-mic-capture-authority.ps1')

if ($Mode -eq 'health') {
  if ([string]::IsNullOrWhiteSpace($EvidenceOutputDirectory)) {
    throw 'health collection requires EvidenceOutputDirectory'
  }
  New-Item -ItemType Directory -Force -Path $EvidenceOutputDirectory | Out-Null
  $driverProbe = Invoke-OmniJsonPowerShellScript `
    -ScriptPath (Join-Path $workspacePath 'scripts\installer\probe-development-driver.ps1') `
    -Arguments @('-WorkspaceRoot', $workspacePath, '-RuntimeRoot', $runtimePath) `
    -Label 'Driver release probe'
  if (
    $driverProbe.schemaVersion -ne 1 -or
    $driverProbe.driverHealth -ne 'running' -or
    $driverProbe.virtualMicOutputSupported -ne $true -or
    $driverProbe.virtualMicOutputStatus -ne 'ready' -or
    $driverProbe.virtualMicFormat -ne '48000Hz/mono/pcm16' -or
    $driverProbe.abiVersion -ne '0X20260810'
  ) {
    throw "Driver release probe did not prove running/ready v6 virtual microphone state: $($driverProbe | ConvertTo-Json -Depth 8 -Compress)"
  }
  try {
    $testOutput = @(& (Join-Path $workspacePath 'scripts\installer\test-development-driver.ps1') `
      -WorkspaceRoot $workspacePath -VirtualMicEvidenceOutputDirectory $EvidenceOutputDirectory)
    $testSucceeded = $?
  } catch {
    throw "Driver audio/Bridge probe threw an exception: $($_.Exception.Message)"
  }
  if (-not $testSucceeded) {
    throw 'Driver audio/Bridge probe reported an unsuccessful PowerShell invocation.'
  }
  $testResult = $testOutput | Where-Object { $_ -and $_.PSObject.Properties['InstalledDriverAuthority'] } | Select-Object -Last 1
  if (-not $testResult) {
    throw 'Driver audio/Bridge probe returned no structured authority result.'
  }
  $invalidSamples = Get-OmniRequiredNonNegativeInt64Property `
    -Record $testResult -PropertyName 'InvalidSamples' -Label 'Driver audio/Bridge probe'
  $droppedBytesAfterTone = Get-OmniRequiredNonNegativeInt64Property `
    -Record $testResult -PropertyName 'DroppedBytesAfterTone' -Label 'Driver audio/Bridge probe'
  $virtualMicProbeDroppedBytes = Get-OmniRequiredNonNegativeInt64Property `
    -Record $testResult -PropertyName 'VirtualMicProbeDroppedBytes' -Label 'Driver audio/Bridge probe'
  $virtualMicProbeRejectedWrites = Get-OmniRequiredNonNegativeInt64Property `
    -Record $testResult -PropertyName 'VirtualMicProbeRejectedWrites' -Label 'Driver audio/Bridge probe'
  $captureProbePath = [string]$testResult.VirtualMicEvidenceCaptureProbe
  $runtimeSnapshotPath = [string]$testResult.VirtualMicEvidenceRuntimeSnapshot
  $captureWavPath = [string]$testResult.VirtualMicEvidenceCaptureWav
  foreach ($required in @($captureProbePath, $runtimeSnapshotPath, $captureWavPath)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
      throw "Driver health probe is missing raw evidence: $required"
    }
  }
  $captureProbe = Get-Content -LiteralPath $captureProbePath -Raw -Encoding UTF8 | ConvertFrom-Json
  $runtimeSnapshot = Get-Content -LiteralPath $runtimeSnapshotPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $bridgeHandshake = Assert-OmniVirtualMicCaptureAuthority `
    -CaptureProbe $captureProbe `
    -RuntimeSnapshot $runtimeSnapshot `
    -CaptureWavPath $captureWavPath
  Write-Result ([ordered]@{
    schemaVersion = 1
    artifactKind = 'omni-install-release-health-probe'
    capturedAt = $capturedAt
    driverProbe = $driverProbe
    installedDriverAuthority = $testResult.InstalledDriverAuthority
    audioProbe = [ordered]@{
      passed = [bool]$testResult.AudioProbePassed
      detail = $testResult.AudioProbeDetail
      endpointId = [string]$testResult.WasapiEndpointId
      toneFrames = [long]$testResult.ToneFrames
      tonePeak = [double]$testResult.TonePeak
      toneRms = [double]$testResult.ToneRms
      toneFrequencyHz = [double]$testResult.ToneFrequencyHz
      toneComponent = [double]$testResult.ToneComponent
      invalidSamples = $invalidSamples
      droppedBytes = $droppedBytesAfterTone
      virtualMicDroppedBytes = $virtualMicProbeDroppedBytes
      virtualMicRejectedWrites = $virtualMicProbeRejectedWrites
    }
    bridgeHandshake = $bridgeHandshake
    virtualMicProbe = $captureProbe
    virtualMicRuntimeSnapshot = $runtimeSnapshot
    rawEvidence = [ordered]@{
      captureProbePath = $captureProbePath
      captureProbeSha256 = Get-OmniSha256 -LiteralPath $captureProbePath
      runtimeSnapshotPath = $runtimeSnapshotPath
      runtimeSnapshotSha256 = Get-OmniSha256 -LiteralPath $runtimeSnapshotPath
      captureWavPath = $captureWavPath
      captureWavSha256 = Get-OmniSha256 -LiteralPath $captureWavPath
    }
  })
  exit 0
}

$rootDevices = @(Get-OmniVirtualSpeakerRootDevices | Sort-Object InstanceId)
$renderEndpoints = @(Get-PnpDevice -PresentOnly -Class AudioEndpoint -ErrorAction SilentlyContinue | Where-Object {
  Test-OmniVirtualAudioEndpoint `
    -Endpoint $_ `
    -Direction render `
    -ExpectedEndpointName 'Omni Translate Virtual Speaker'
} | Sort-Object InstanceId)
$captureEndpoints = @(Get-PnpDevice -PresentOnly -Class AudioEndpoint -ErrorAction SilentlyContinue | Where-Object {
  Test-OmniVirtualAudioEndpoint `
    -Endpoint $_ `
    -Direction capture `
    -ExpectedEndpointName 'Omni Translate Virtual Microphone'
} | Sort-Object InstanceId)
$driverPackages = @(Get-WindowsDriver -Online -ErrorAction Stop | Where-Object {
  $_.ProviderName -eq 'Omni Translate' -and
  [System.IO.Path]::GetFileName([string]$_.OriginalFileName) -eq 'omni-virtual-speaker.inf'
} | Sort-Object Driver)
$rootIds = @($rootDevices | ForEach-Object { [string]$_.InstanceId })
$rootDriverBindings = @($rootDevices | ForEach-Object {
  $properties = @(Get-PnpDeviceProperty -InstanceId $_.InstanceId -ErrorAction SilentlyContinue)
  [pscustomobject]@{
    instanceId = [string]$_.InstanceId
    matchingDeviceId = Get-PnpPropertyData $properties 'DEVPKEY_Device_MatchingDeviceId'
    infName = Get-PnpPropertyData $properties 'DEVPKEY_Device_DriverInfPath'
    driverVersion = Get-PnpPropertyData $properties 'DEVPKEY_Device_DriverVersion'
    driverProvider = Get-PnpPropertyData $properties 'DEVPKEY_Device_DriverProvider'
    service = Get-PnpPropertyData $properties 'DEVPKEY_Device_Service'
  }
})
$publishedNames = @($driverPackages | ForEach-Object { [string]$_.Driver })
$signedDriverQuery = Get-OmniOptionalSignedDriverQuery
$signedDriverQueryDiagnostic = $signedDriverQuery.queryDiagnostic
$signedDriverCandidates = @($signedDriverQuery.rows | Where-Object {
  $rootIds -contains [string]$_.DeviceID -or
  $publishedNames -contains [string]$_.InfName -or
  [string]$_.DriverProviderName -eq 'Omni Translate'
} | Sort-Object DeviceID, InfName)
$pnpDriverStoreAuthorities = @($rootDriverBindings | ForEach-Object {
  $binding = $_
  $package = $driverPackages | Where-Object {
    [string]$_.Driver -eq [string]$binding.infName
  } | Select-Object -First 1
  if (
    $package -and
    (Test-OmniPnpDriverStoreAuthorityRecord -Binding $binding -Package $package)
  ) {
    $relatedCandidates = @($signedDriverCandidates | Where-Object {
      [string]$_.DeviceID -eq [string]$binding.instanceId -or
      [string]$_.InfName -eq [string]$binding.infName
    })
    $matchingCandidates = @($relatedCandidates | Where-Object {
      Test-OmniInstalledDriverAuthorityRecord `
        -Candidate $_ `
        -Binding $binding `
        -Package $package
    })
    if (
      $signedDriverCandidates.Count -gt 1 -or
      ($signedDriverCandidates.Count -eq 1 -and $matchingCandidates.Count -ne 1)
    ) {
      throw "Win32_PnPSignedDriver observation is exposed-conflicting with PnP/DriverStore authority for $($binding.instanceId). candidates=$($signedDriverCandidates.Count) related=$($relatedCandidates.Count) matching=$($matchingCandidates.Count)"
    }
    [pscustomobject]@{
      binding = $binding
      package = $package
      wmiCandidate = if ($matchingCandidates.Count -eq 1) { $matchingCandidates[0] } else { $null }
    }
  }
})
$services = @(Get-CimInstance Win32_SystemDriver -Filter "Name='omni_translate_virtual_speaker'" -ErrorAction SilentlyContinue)
$serviceEvidence = @($services | ForEach-Object {
  $binaryPath = Resolve-ServiceBinaryPath ([string]$_.PathName)
  [ordered]@{
    name = [string]$_.Name
    state = [string]$_.State
    status = [string]$_.Status
    startMode = [string]$_.StartMode
    pathName = [string]$_.PathName
    binaryPath = $binaryPath
    binaryPresent = [bool]($binaryPath -and (Test-Path -LiteralPath $binaryPath -PathType Leaf))
    binarySha256 = if ($binaryPath) { Get-OmniSha256 -LiteralPath $binaryPath } else { $null }
    signature = if ($binaryPath -and (Test-Path -LiteralPath $binaryPath -PathType Leaf)) {
      Get-SignatureEvidence $binaryPath $binaryPath
    } else { $null }
  }
})
$wmiObservationState = if ($signedDriverQuery.probeStatus -eq 'query-unavailable') {
  'query-unavailable'
} elseif (
  $rootDevices.Count -gt 0 -and
  $signedDriverCandidates.Count -gt 1
) {
  throw "Win32_PnPSignedDriver observation is exposed-conflicting because multiple Omni rows were published: $($signedDriverCandidates.DeviceID -join ', ')"
} elseif (
  $rootDevices.Count -eq 1 -and
  $pnpDriverStoreAuthorities.Count -eq 1 -and
  $pnpDriverStoreAuthorities[0].wmiCandidate
) {
  'exposed-consistent'
} elseif ($rootDevices.Count -eq 1 -and $signedDriverCandidates.Count -eq 0) {
  'not-exposed-yet'
} elseif ($rootDevices.Count -eq 1 -and $signedDriverCandidates.Count -ne 0) {
  throw "Win32_PnPSignedDriver observation is exposed-conflicting with the installed PnP/DriverStore topology."
} else {
  'not-applicable-clean-or-noncanonical-topology'
}
$installedDriverAuthority = if ($pnpDriverStoreAuthorities.Count -eq 1) {
  $authority = $pnpDriverStoreAuthorities[0]
  $binding = $authority.binding
  $package = $authority.package
  $rootDevice = $rootDevices | Where-Object {
    [string]$_.InstanceId -eq [string]$binding.instanceId
  } | Select-Object -First 1
  $driverStoreInfPath = [string]$package.OriginalFileName
  $driverStoreRoot = if ([string]::IsNullOrWhiteSpace($driverStoreInfPath)) {
    $null
  } else {
    Split-Path -Parent $driverStoreInfPath
  }
  $driverStoreInf = if ($driverStoreRoot) {
    Get-DriverStoreFileEvidence (Join-Path $driverStoreRoot 'omni-virtual-speaker.inf')
  } else { $null }
  $driverStoreCat = if ($driverStoreRoot) {
    Get-DriverStoreFileEvidence (Join-Path $driverStoreRoot 'omni-virtual-speaker.cat')
  } else { $null }
  $driverStoreSys = if ($driverStoreRoot) {
    Get-DriverStoreFileEvidence (Join-Path $driverStoreRoot 'omni-virtual-speaker.sys')
  } else { $null }
  [ordered]@{
    deviceId = [string]$binding.instanceId
    deviceName = [string]$rootDevice.FriendlyName
    matchingDeviceId = [string]$binding.matchingDeviceId
    infName = [string]$binding.infName
    driverVersion = [string]$binding.driverVersion
    driverProviderName = [string]$binding.driverProvider
    serviceName = [string]$binding.service
    driverStore = [ordered]@{
      publishedName = [string]$package.Driver
      originalFileName = $driverStoreInfPath
      root = $driverStoreRoot
      providerName = [string]$package.ProviderName
      className = [string]$package.ClassName
      version = [string]$package.Version
      inf = $driverStoreInf
      cat = $driverStoreCat
      sys = $driverStoreSys
    }
    service = if ($serviceEvidence.Count -eq 1) { $serviceEvidence[0] } else { $null }
    wmiObservation = [ordered]@{
      probeStatus = $wmiObservationState
      queryDiagnostic = $signedDriverQueryDiagnostic
      candidate = if ($authority.wmiCandidate) {
        [ordered]@{
          deviceId = [string]$authority.wmiCandidate.DeviceID
          infName = [string]$authority.wmiCandidate.InfName
          driverVersion = [string]$authority.wmiCandidate.DriverVersion
          driverProviderName = [string]$authority.wmiCandidate.DriverProviderName
          signer = [string]$authority.wmiCandidate.Signer
          isSigned = [bool]$authority.wmiCandidate.IsSigned
        }
      } else { $null }
    }
  }
} else { $null }
$signedDriverResolutionStatus = if ($installedDriverAuthority) {
  'ready-pnp-driverstore-service-files'
} elseif (
  $rootDevices.Count -eq 0 -and
  $driverPackages.Count -eq 0 -and
  $serviceEvidence.Count -eq 0
) {
  'clean'
} else {
  'topology-not-authoritative'
}
$runtimeStatePath = Join-Path $runtimePath 'driver-install-state.json'
$runtimeState = if (Test-Path -LiteralPath $runtimeStatePath -PathType Leaf) {
  Get-Content -LiteralPath $runtimeStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
} else { $null }
$bridgeProcesses = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $_.Name -in @('omni-bridge-service.exe', 'omni-driver-audio-probe.exe', 'omni-virtual-mic-target-capture.exe')
} | Sort-Object ProcessId | ForEach-Object {
  [ordered]@{
    processId = [long]$_.ProcessId
    parentProcessId = [long]$_.ParentProcessId
    name = [string]$_.Name
    executablePath = [string]$_.ExecutablePath
  }
})

Write-Result ([ordered]@{
  schemaVersion = 1
  artifactKind = 'omni-install-system-state'
  capturedAt = $capturedAt
  isAdministrator = [bool](Test-OmniIsAdministrator)
  hardwareId = Get-OmniVirtualSpeakerHardwareId
  rootDevices = @($rootDevices | ForEach-Object {
    [ordered]@{
      instanceId = [string]$_.InstanceId
      status = [string]$_.Status
      problem = [string]$_.Problem
      friendlyName = [string]$_.FriendlyName
    }
  })
  renderEndpoints = @($renderEndpoints | ForEach-Object {
    [ordered]@{ instanceId = [string]$_.InstanceId; status = [string]$_.Status; friendlyName = [string]$_.FriendlyName }
  })
  captureEndpoints = @($captureEndpoints | ForEach-Object {
    [ordered]@{ instanceId = [string]$_.InstanceId; status = [string]$_.Status; friendlyName = [string]$_.FriendlyName }
  })
  driverPackages = @($driverPackages | ForEach-Object {
    [ordered]@{
      publishedName = [string]$_.Driver
      originalFileName = [string]$_.OriginalFileName
      providerName = [string]$_.ProviderName
      className = [string]$_.ClassName
      version = [string]$_.Version
      date = if ($_.Date) { ([datetime]$_.Date).ToUniversalTime().ToString('o') } else { $null }
    }
  })
  installedDriverAuthority = $installedDriverAuthority
  signedDrivers = @($signedDriverCandidates | ForEach-Object {
    [ordered]@{
      deviceId = [string]$_.DeviceID
      deviceName = [string]$_.DeviceName
      infName = [string]$_.InfName
      driverVersion = [string]$_.DriverVersion
      driverProviderName = [string]$_.DriverProviderName
      manufacturer = [string]$_.Manufacturer
      signer = [string]$_.Signer
      isSigned = [bool]$_.IsSigned
    }
  })
  signedDriverCandidates = @($signedDriverCandidates | ForEach-Object {
    [ordered]@{
      deviceId = [string]$_.DeviceID
      deviceName = [string]$_.DeviceName
      infName = [string]$_.InfName
      driverVersion = [string]$_.DriverVersion
      driverProviderName = [string]$_.DriverProviderName
      manufacturer = [string]$_.Manufacturer
      signer = [string]$_.Signer
      isSigned = [bool]$_.IsSigned
    }
  })
  wmiSignedDriverObservation = [ordered]@{
    probeStatus = $wmiObservationState
    rowCount = $signedDriverCandidates.Count
    queryDiagnostic = $signedDriverQueryDiagnostic
  }
  signedDriverResolutionStatus = $signedDriverResolutionStatus
  pnpDriverStoreAuthorityCount = $pnpDriverStoreAuthorities.Count
  rootDriverBindings = @($rootDriverBindings)
  services = $serviceEvidence
  runtimeStatePath = $runtimeStatePath
  runtimeStatePresent = [bool]$runtimeState
  runtimeState = $runtimeState
  bridgeProcesses = $bridgeProcesses
})
