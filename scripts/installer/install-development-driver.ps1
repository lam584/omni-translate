param(
  [Parameter(Mandatory = $true)][string]$WorkspaceRoot,
  [Parameter(Mandatory = $true)][string]$RuntimeRoot,
  [Parameter(Mandatory = $true)][ValidateSet('development', 'release')][string]$InstallChannel,
  [Parameter(Mandatory = $true)][string]$DriverVersion,
  [Parameter(Mandatory = $true)][string]$BridgeVersion,
  [Parameter(Mandatory = $true)][string]$TargetDeviceId,
  [string]$VirtualRenderDeviceId = 'omni-virtual-speaker-default',
  [string]$DevconPath = '',
  [switch]$SkipTrustCertificate,
  [switch]$AllowDebugDriver,
  [switch]$ValidatePackageOnly
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'virtual-speaker-device.ps1')
. (Join-Path $PSScriptRoot 'devcon-authority.ps1')

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

function Get-OmniInfDriverVersion([string]$InfPath) {
  $infText = Get-Content -LiteralPath $InfPath -Raw -Encoding UTF8
  $match = [regex]::Match($infText, '(?im)^\s*DriverVer\s*=\s*[^,]+,\s*([0-9]+(?:\.[0-9]+){1,3})\s*$')
  if (-not $match.Success) {
    throw "DriverVer is missing or invalid in $InfPath"
  }
  return $match.Groups[1].Value
}

function Assert-OmniStableReleasePackage {
  param(
    [string]$PackageRoot,
    [string]$InfPath,
    [string]$SysPath,
    [string]$CatPath,
    [object]$Metadata,
    [string]$RequestedDriverVersion,
    [string]$RequestedBridgeVersion
  )
  $releasePackagePath = Join-Path $PackageRoot '..\..\..\release-package.json'
  $releaseManifestPath = Join-Path $PackageRoot '..\..\..\release-manifest.json'
  $layoutPath = Join-Path $PackageRoot '..\..\..\installer-layout.json'
  $developmentCertificatePath = Join-Path $PackageRoot 'omni-translate-development-driver.cer'
  foreach ($requiredPath in @($releasePackagePath, $releaseManifestPath, $layoutPath)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
      throw "Release install requires canonical signed-package metadata: $requiredPath"
    }
  }
  if (Test-Path -LiteralPath $developmentCertificatePath) {
    throw 'Release install refuses a package containing the development trust certificate.'
  }
  $releasePackage = Get-Content -LiteralPath $releasePackagePath -Raw -Encoding UTF8 | ConvertFrom-Json
  $releaseManifest = Get-Content -LiteralPath $releaseManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $layout = Get-Content -LiteralPath $layoutPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $infDriverVersion = Get-OmniInfDriverVersion $InfPath
  $packageVersion = [string]$releasePackage.version
  $expectedPackageBaseName = "OmniTranslate-$packageVersion-windows-x64-portable"
  $workspacePath = [System.IO.Path]::GetFullPath((Join-Path $PackageRoot '..\..\..'))
  $sourceCommit = [string]$releasePackage.sourceCommit
  if (
    $sourceCommit -notmatch '^[a-fA-F0-9]{40}$' -or
    $releaseManifest.sourceCommit -ne $sourceCommit -or
    $layout.sourceCommit -ne $sourceCommit -or
    $Metadata.sourceCommit -ne $sourceCommit -or
    $releasePackage.sourceProvenance.headCommit -ne $sourceCommit -or
    $releaseManifest.sourceProvenance.headCommit -ne $sourceCommit -or
    $layout.sourceProvenance.headCommit -ne $sourceCommit -or
    $Metadata.sourceProvenance.headCommit -ne $sourceCommit -or
    $releasePackage.sourceProvenance.worktreeClean -ne $true -or
    $releaseManifest.sourceProvenance.worktreeClean -ne $true -or
    $layout.sourceProvenance.worktreeClean -ne $true -or
    $Metadata.sourceProvenance.worktreeClean -ne $true -or
    [int]$releasePackage.sourceProvenance.dirtyEntryCount -ne 0 -or
    [int]$releaseManifest.sourceProvenance.dirtyEntryCount -ne 0 -or
    [int]$layout.sourceProvenance.dirtyEntryCount -ne 0 -or
    [int]$Metadata.sourceProvenance.dirtyEntryCount -ne 0 -or
    $releasePackage.channel -ne 'stable' -or
    $releasePackage.platform -ne 'windows-x64' -or
    $releasePackage.packageName -ne "$expectedPackageBaseName.zip" -or
    $releasePackage.installEntry -ne 'scripts/installer/install-development-driver.ps1' -or
    $releasePackage.uninstallEntry -ne 'scripts/installer/uninstall-development-driver.ps1' -or
    $releasePackage.repairEntry -ne 'scripts/installer/repair-driver.ps1' -or
    $layout.naming.channel -ne 'stable' -or
    $layout.naming.platform -ne 'windows-x64' -or
    $layout.naming.packageBaseName -ne $expectedPackageBaseName -or
    $layout.version -ne $releasePackage.version -or
    $layout.packages.nativeBridge -ne $RequestedBridgeVersion
  ) {
    throw 'Release package metadata is not a consistent stable Windows x64 installer layout.'
  }
  $buildAuthority = $layout.buildAuthority
  $expectedBuildBinaries = @(
    [pscustomobject]@{ Role = 'desktop-shell'; Path = 'desktop/omni-desktop-shell.exe'; Verification = 'embedded-commit' },
    [pscustomobject]@{ Role = 'native-bridge'; Path = 'bridge-service-native/omni-bridge-service.exe'; Verification = '--build-commit' },
    [pscustomobject]@{ Role = 'audio-probe'; Path = 'bridge-service-native/omni-driver-audio-probe.exe'; Verification = '--build-commit' },
    [pscustomobject]@{ Role = 'virtual-mic-target-capture'; Path = 'bridge-service-native/omni-virtual-mic-target-capture.exe'; Verification = '--build-commit' }
  )
  if (
    $buildAuthority.schemaVersion -ne 1 -or
    $buildAuthority.artifactKind -ne 'omni-release-build-authority' -or
    $buildAuthority.sourceCommit -ne $sourceCommit -or
    $buildAuthority.forcedCleanBuild -ne $true -or
    -not ([string]$buildAuthority.cargoTargetDirectory).Contains($sourceCommit) -or
    @($buildAuthority.binaries).Count -ne $expectedBuildBinaries.Count
  ) {
    throw 'Release package does not contain exact current-HEAD forced-build authority.'
  }
  for ($index = 0; $index -lt $expectedBuildBinaries.Count; $index += 1) {
    $expected = $expectedBuildBinaries[$index]
    $recorded = @($buildAuthority.binaries)[$index]
    $binaryPath = Join-Path $workspacePath $expected.Path.Replace('/', '\')
    if (-not (Test-Path -LiteralPath $binaryPath -PathType Leaf)) {
      throw "Release build authority binary is missing: $($expected.Path)"
    }
    $binary = Get-Item -LiteralPath $binaryPath
    $binarySha256 = (Get-FileHash -LiteralPath $binaryPath -Algorithm SHA256).Hash
    if (
      $recorded.role -ne $expected.Role -or
      $recorded.path -ne $expected.Path -or
      $recorded.verification -ne $expected.Verification -or
      $recorded.sourceCommit -ne $sourceCommit -or
      [long]$recorded.bytes -ne [long]$binary.Length -or
      -not $binarySha256.Equals([string]$recorded.sha256, [StringComparison]::OrdinalIgnoreCase)
    ) {
      throw "Release build authority does not match $($expected.Path)"
    }
  }
  if ($RequestedDriverVersion -ne $infDriverVersion) {
    throw "Requested DriverVersion=$RequestedDriverVersion does not match INF DriverVer=$infDriverVersion"
  }
  if (
    -not $Metadata -or
    $Metadata.protocolVersion -ne '2026-08-13-audio-routing-v7' -or
    $Metadata.configuration -ne 'Release' -or
    $Metadata.platform -ne 'x64' -or
    $Metadata.signingMode -ne 'release-injected' -or
    $Metadata.timestampMode -ne 'rfc3161' -or
    [string]::IsNullOrWhiteSpace([string]$Metadata.signerThumbprint)
  ) {
    throw 'Release install requires Release/x64/release-injected driver metadata with an RFC3161 timestamp policy.'
  }
  foreach ($signedPath in @($SysPath, $CatPath)) {
    $signature = Get-AuthenticodeSignature -LiteralPath $signedPath
    if (
      $signature.Status -ne 'Valid' -or
      -not $signature.SignerCertificate -or
      $signature.SignerCertificate.Thumbprint -ne $Metadata.signerThumbprint -or
      -not $signature.TimeStamperCertificate
    ) {
      throw "Release install refuses invalid, mismatched, or untimestamped signature: $signedPath"
    }
  }
  $requiredReleaseFiles = @(
    'bridge-service-native\omni-bridge-service.exe',
    'bridge-service-native\omni-driver-audio-probe.exe',
    'bridge-service-native\omni-virtual-mic-target-capture.exe',
    'desktop\omni-desktop-shell.exe',
    'scripts\installer\request-elevated-driver-operation.ps1',
    'scripts\installer\invoke-elevated-driver-operation.ps1',
    'scripts\installer\install-development-driver.ps1',
    'scripts\installer\uninstall-development-driver.ps1',
    'scripts\installer\repair-driver.ps1',
    'scripts\installer\probe-development-driver.ps1',
    'scripts\installer\test-development-driver.ps1'
  )
  foreach ($relativePath in $requiredReleaseFiles) {
    $requiredPath = Join-Path $workspacePath $relativePath
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
      throw "Release package is missing a production executable/script: $relativePath"
    }
  }
  $releaseSignableExtensions = @('.exe', '.dll', '.sys', '.cat', '.ps1')
  $releaseSignableFiles = @(Get-ChildItem -LiteralPath $workspacePath -Recurse -File | Where-Object {
    $releaseSignableExtensions -contains $_.Extension.ToLowerInvariant()
  })
  if ($releaseSignableFiles.Count -eq 0) {
    throw 'Release package contains no Authenticode-verifiable production artifacts.'
  }
  foreach ($releaseFile in $releaseSignableFiles) {
    $releaseSignature = Get-AuthenticodeSignature -LiteralPath $releaseFile.FullName
    if (
      $releaseSignature.Status -ne 'Valid' -or
      -not $releaseSignature.SignerCertificate -or
      -not $releaseSignature.TimeStamperCertificate
    ) {
      throw "Release install refuses unsigned or untimestamped production artifact: $($releaseFile.FullName)"
    }
  }
  return [pscustomobject]@{
    PackageVersion = $packageVersion
    DriverVersion = $infDriverVersion
  }
}

Assert-OmniVirtualDriverWindowsBuild
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
  $metadata = Get-Content -LiteralPath $metadataPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($metadata.configuration -eq 'Debug' -and -not $AllowDebugDriver) {
    throw 'Refusing to install a Debug SYSVAD package without -AllowDebugDriver. Build the development package with -Configuration Release.'
  }
  if ($metadata.configuration -eq 'Debug') {
    Assert-KernelDebuggingEnabled
  }
}
$stablePackageAuthority = $null
if ($InstallChannel -eq 'release') {
  if (-not [string]::IsNullOrWhiteSpace($DevconPath)) {
    throw 'Release installs do not accept an explicit DevCon path.'
  }
  $stablePackageAuthority = Assert-OmniStableReleasePackage `
    -PackageRoot $packageRoot `
    -InfPath $infPath `
    -SysPath $sysPath `
    -CatPath $catPath `
    -Metadata $metadata `
    -RequestedDriverVersion $DriverVersion `
    -RequestedBridgeVersion $BridgeVersion
}
if ($ValidatePackageOnly) {
  Write-Output 'Driver package preflight passed.'
  return
}
& (Join-Path $PSScriptRoot 'stop-stale-bridge-service.ps1') -WorkspaceRoot $WorkspaceRoot -RuntimeRoot $RuntimeRoot

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
$devcon = Resolve-OmniDevconPath -WorkspaceRoot $workspacePath -ExplicitPath $DevconPath

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
  $virtualSpeaker = Get-OmniVirtualSpeakerEndpoint
  $virtualMicrophone = Get-OmniVirtualMicrophoneEndpoint
  if ($virtualSpeaker -and $virtualMicrophone) {
    break
  }
  Start-Sleep -Milliseconds 250
} while ((Get-Date) -lt $deadline)
if (-not $virtualSpeaker) {
  throw 'The ROOT device was installed, but the Omni Translate Virtual Speaker endpoint did not appear within 20 seconds.'
}

if (-not $virtualMicrophone) {
  throw 'The ROOT device was installed, but the Omni Translate Virtual Microphone capture endpoint did not appear within 20 seconds.'
}
$testOutput = @(& (Join-Path $PSScriptRoot 'test-development-driver.ps1') -WorkspaceRoot $WorkspaceRoot)
if (-not $?) {
  throw 'The Omni Translate Virtual Speaker endpoint audio validation failed.'
}
$testResult = $testOutput |
  Where-Object { $_ -and $_.PSObject.Properties['InstalledDriverAuthority'] } |
  Select-Object -Last 1
if (-not $testResult -or -not $testResult.InstalledDriverAuthority) {
  throw 'The Omni Translate Virtual Speaker endpoint audio validation returned no installed-driver authority.'
}
$installedDriverAuthority = $testResult.InstalledDriverAuthority
if ($InstallChannel -eq 'release') {
  if (
    [string]::IsNullOrWhiteSpace([string]$installedDriverAuthority.installedDriverVersion) -or
    [string]$installedDriverAuthority.installedDriverVersion -ne [string]$stablePackageAuthority.DriverVersion -or
    [string]$installedDriverAuthority.pnpDriverVersion -ne [string]$stablePackageAuthority.DriverVersion -or
    [string]$installedDriverAuthority.driverStoreVersion -ne [string]$stablePackageAuthority.DriverVersion
  ) {
    throw "Installed PnP/DriverStore version does not match the release package INF: installed=$($installedDriverAuthority.installedDriverVersion) pnp=$($installedDriverAuthority.pnpDriverVersion) driverStore=$($installedDriverAuthority.driverStoreVersion) expected=$($stablePackageAuthority.DriverVersion)"
  }
}

$state = [ordered]@{
  protocolVersion = '2026-08-13-audio-routing-v7'
  installChannel = $InstallChannel
  driverVersion = if ($InstallChannel -eq 'release') { [string]$installedDriverAuthority.installedDriverVersion } else { $DriverVersion }
  requestedDriverVersion = $DriverVersion
  packageVersion = if ($stablePackageAuthority) { $stablePackageAuthority.PackageVersion } else { $null }
  bridgeVersion = $BridgeVersion
  driverHealth = 'running'
  installedAt = (Get-Date).ToUniversalTime().ToString('o')
  targetDeviceId = $TargetDeviceId
  virtualRenderDeviceId = $VirtualRenderDeviceId
  virtualCaptureDeviceId = $virtualMicrophone.InstanceId
  driverBackend = 'sysvad-wave-rt'
  deviceName = 'Omni Translate Virtual Speaker'
  installedInfPath = $infPath
  pnpInstanceId = $rootDevice.InstanceId
  endpointInstanceId = $virtualSpeaker.InstanceId
  captureEndpointInstanceId = $virtualMicrophone.InstanceId
}

$json = $state | ConvertTo-Json -Depth 4
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $RuntimeRoot 'driver-install-state.json'), $json, $utf8NoBom)

Write-Output "SYSVAD virtual audio driver installed for $VirtualRenderDeviceId"
