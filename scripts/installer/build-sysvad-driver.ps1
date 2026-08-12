param(
  [string]$WorkspaceRoot = '.',
  [ValidateSet('Debug', 'Release')][string]$Configuration = 'Release',
  [ValidateSet('x64')][string]$Platform = 'x64',
  [string]$WindowsKitVersion = '10.0.26100.0',
  [string]$VisualStudioRoot = 'C:\Program Files\Microsoft Visual Studio\2022\Community',
  [string]$SigningPfxPath = '',
  [string]$SigningPfxPasswordPath = '',
  [string]$SigningTimestampUrl = '',
  [switch]$SkipSigning
)

$ErrorActionPreference = 'Stop'

function Assert-File([string]$Path, [string]$Description) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Description was not found: $Path"
  }
}

function Write-Utf8NoBom([string]$Path, [string]$Text) {
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Text, $utf8NoBom)
}

function Invoke-Checked([string]$Executable, [string[]]$Arguments) {
  & $Executable @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Executable failed. ExitCode=$LASTEXITCODE"
  }
}

function Get-CleanReleaseSourceProvenance([string]$WorkspacePath) {
  $headCommit = (& git -C $WorkspacePath rev-parse --verify HEAD 2>$null | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $headCommit -notmatch '^[a-fA-F0-9]{40}$') {
    throw 'Release driver signing requires an exact git HEAD commit.'
  }
  $status = @(& git -C $WorkspacePath status --porcelain=v1 --untracked-files=all --ignore-submodules=none 2>$null)
  if ($LASTEXITCODE -ne 0) {
    throw 'Release driver signing could not inspect the git worktree.'
  }
  $dirtyEntries = @($status | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
  if ($dirtyEntries.Count -ne 0) {
    throw "Release driver signing requires a clean worktree; found $($dirtyEntries.Count) dirty/untracked entries."
  }
  return [ordered]@{
    schemaVersion = 1
    source = 'git'
    captureStatus = 'captured'
    headCommit = $headCommit
    worktreeClean = $true
    dirtyEntryCount = 0
  }
}

$workspacePath = (Resolve-Path -LiteralPath $WorkspaceRoot).Path
$releaseSourceProvenance = if (-not [string]::IsNullOrWhiteSpace($SigningPfxPath) -and -not $SkipSigning) {
  Get-CleanReleaseSourceProvenance $workspacePath
} else { $null }
$driverRoot = Join-Path $workspacePath 'drivers\windows-virtual-mic'
$sysvadRoot = Join-Path $driverRoot 'sysvad'
$endpointsProject = Join-Path $sysvadRoot 'EndpointsCommon\EndpointsCommon.vcxproj'
$tabletProject = Join-Path $sysvadRoot 'TabletAudioSample\TabletAudioSample.vcxproj'
$buildOutput = Join-Path $sysvadRoot "TabletAudioSample\$Platform\$Configuration"
$packageRoot = Join-Path $driverRoot 'package'
$kernelImportPolicyPath = Join-Path $driverRoot 'tests\fixtures\kernel-import-minimum-builds.json'
$overlayRoot = Join-Path $workspacePath 'artifacts\driver-build\msbuild-overlay\v170'
$toolsetRoot = Join-Path $overlayRoot "Platforms\$Platform\PlatformToolsets\WindowsKernelModeDriver10.0"
$windowsKitsRoot = 'C:\Program Files (x86)\Windows Kits\10'
$wdkBuildRoot = Join-Path $windowsKitsRoot "build\$WindowsKitVersion"
$wdkBinRoot = Join-Path $windowsKitsRoot "bin\$WindowsKitVersion"
$wdkToolsRoot = Join-Path $windowsKitsRoot "Tools\$WindowsKitVersion\x64"
$msbuild = Join-Path $VisualStudioRoot 'MSBuild\Current\Bin\MSBuild.exe'
$vcTargetsRoot = Join-Path $VisualStudioRoot 'MSBuild\Microsoft\VC\v170'
$vcToolsRoot = Get-ChildItem -LiteralPath (Join-Path $VisualStudioRoot 'VC\Tools\MSVC') -Directory |
  Sort-Object Name -Descending |
  Select-Object -First 1
$dumpbin = Join-Path $vcToolsRoot.FullName 'bin\Hostx64\x64\dumpbin.exe'

Assert-File $endpointsProject 'SYSVAD EndpointsCommon project'
Assert-File $tabletProject 'SYSVAD TabletAudioSample project'
Assert-File $kernelImportPolicyPath 'Kernel import minimum-build policy'
Assert-File $msbuild 'MSBuild'
Assert-File $dumpbin 'dumpbin'
Assert-File (Join-Path $wdkBuildRoot 'WindowsDriver.Default.props') 'WDK build props'
Assert-File (Join-Path $wdkBinRoot 'x86\Inf2Cat.exe') 'Inf2Cat'
Assert-File (Join-Path $wdkBinRoot 'x64\signtool.exe') 'SignTool'
Assert-File (Join-Path $wdkToolsRoot 'infverif.exe') 'InfVerif'
if (-not $vcToolsRoot) {
  throw "MSVC tools were not found under $VisualStudioRoot"
}

if (Test-Path -LiteralPath $overlayRoot) {
  $resolvedOverlay = (Resolve-Path -LiteralPath $overlayRoot).Path
  $expectedPrefix = (Join-Path $workspacePath 'artifacts\driver-build')
  if (-not $resolvedOverlay.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove overlay outside workspace artifacts: $resolvedOverlay"
  }
  Remove-Item -LiteralPath $resolvedOverlay -Recurse -Force
}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $overlayRoot) | Out-Null
Copy-Item -LiteralPath $vcTargetsRoot -Destination $overlayRoot -Recurse
New-Item -ItemType Directory -Force -Path $toolsetRoot | Out-Null

$escapedWindowsKitsRoot = "$windowsKitsRoot\"
$escapedVcToolsRoot = "$($vcToolsRoot.FullName)\"
$toolsetProps = @"
<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup>
    <IsKernelModeToolset>true</IsKernelModeToolset>
    <WDKContentRoot Condition="'`$(WDKContentRoot)' == ''">$escapedWindowsKitsRoot</WDKContentRoot>
    <WindowsSdkDir Condition="'`$(WindowsSdkDir)' == ''">$escapedWindowsKitsRoot</WindowsSdkDir>
    <WDKBuildFolder Condition="'`$(WDKBuildFolder)' == ''">$WindowsKitVersion</WDKBuildFolder>
    <WDKBinRoot Condition="'`$(WDKBinRoot)' == ''">`$(WDKContentRoot)bin\`$(WDKBuildFolder)</WDKBinRoot>
    <DDK_INC_PATH>`$(WDKContentRoot)Include\`$(WDKBuildFolder)\km\</DDK_INC_PATH>
    <DDK_LIB_PATH>`$(WDKContentRoot)Lib\`$(WDKBuildFolder)\km\x64\</DDK_LIB_PATH>
    <KMDF_INC_PATH>`$(WDKContentRoot)Include\wdf\kmdf\</KMDF_INC_PATH>
    <KMDF_LIB_PATH>`$(WDKContentRoot)Lib\wdf\kmdf\x64\</KMDF_LIB_PATH>
  </PropertyGroup>
  <Import Project="`$(WDKContentRoot)build\`$(WDKBuildFolder)\WindowsDriver.Default.props" />
  <Import Project="`$(WDKContentRoot)build\`$(WDKBuildFolder)\`$(Platform)\WindowsKernelModeDriver\WDK.`$(Platform).WindowsKernelModeDriver.props" />
  <Import Project="`$(WDKContentRoot)build\`$(WDKBuildFolder)\`$(Platform)\ImportAfter\WDK.`$(Platform).WindowsKernelModeDriver.Platform.props" />
  <Import Project="`$(VCTargetsPath)\Platforms\`$(Platform)\PlatformToolsets\v143\Toolset.props" />
  <PropertyGroup>
    <VCToolsInstallDir>$escapedVcToolsRoot</VCToolsInstallDir>
    <CLToolPath>`$(VCToolsInstallDir)bin\Hostx64\x64\</CLToolPath>
    <LinkToolPath>`$(CLToolPath)</LinkToolPath>
    <LibToolPath>`$(CLToolPath)</LibToolPath>
    <ExecutablePath>`$(CLToolPath);`$(ExecutablePath)</ExecutablePath>
    <IncludePath>`$(WDKContentRoot)Include\wdf\kmdf\1.15;`$(WDKContentRoot)Include\`$(TargetPlatformVersion)\km;`$(WDKContentRoot)Include\`$(TargetPlatformVersion)\shared;`$(WDKContentRoot)Include\`$(TargetPlatformVersion)\ucrt;`$(WDKContentRoot)Include\`$(TargetPlatformVersion)\um;`$(IncludePath)</IncludePath>
    <LibraryPath>`$(WDKContentRoot)Lib\`$(TargetPlatformVersion)\km\x64;`$(WDKContentRoot)Lib\`$(TargetPlatformVersion)\ucrt\x64;`$(WDKContentRoot)Lib\`$(TargetPlatformVersion)\um\x64;`$(LibraryPath)</LibraryPath>
  </PropertyGroup>
</Project>
"@
$toolsetTargets = @"
<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <Import Project="`$(VCTargetsPath)\Platforms\`$(Platform)\PlatformToolsets\v143\Toolset.targets" />
  <Import Project="`$(WDKContentRoot)build\`$(WDKBuildFolder)\WindowsDriver.Common.targets" />
  <Import Project="`$(WDKContentRoot)build\`$(WDKBuildFolder)\`$(Platform)\ImportAfter\WDK.`$(Platform).WindowsDriverCommonToolset.Platform.Targets" />
</Project>
"@
Write-Utf8NoBom (Join-Path $toolsetRoot 'Toolset.props') $toolsetProps
Write-Utf8NoBom (Join-Path $toolsetRoot 'Toolset.targets') $toolsetTargets

$msbuildArgs = @(
  '/m',
  '/t:Rebuild',
  "/p:Configuration=$Configuration",
  "/p:Platform=$Platform",
  "/p:WindowsTargetPlatformVersion=$WindowsKitVersion",
  # The WDK's automatic TestSign chooses an IDE-created certificate from the
  # current token's personal store.  It is neither the project PFX nor part of
  # the staged package authority, and can be present without a private key in
  # non-IDE/interactive task tokens.  The explicit SignTool calls below always
  # sign the staged SYS and generated CAT with the configured project PFX.
  '/p:SignMode=None',
  '/p:SkipPackageVerification=true',
  "/p:VCTargetsPath=$overlayRoot\"
)
$savedPath = $env:PATH
Remove-Item Env:PATH -ErrorAction SilentlyContinue
$env:Path = $savedPath
try {
  Invoke-Checked $msbuild (@($endpointsProject) + $msbuildArgs)
  Invoke-Checked $msbuild (@($tabletProject) + $msbuildArgs)
} finally {
  $env:Path = $savedPath
}

New-Item -ItemType Directory -Force -Path $packageRoot | Out-Null
$stagedInf = Join-Path $packageRoot 'omni-virtual-speaker.inf'
$stagedSys = Join-Path $packageRoot 'omni-virtual-speaker.sys'
$stagedCat = Join-Path $packageRoot 'omni-virtual-speaker.cat'
$stagedPublicCertificate = Join-Path $packageRoot 'omni-translate-development-driver.cer'
$stagedMetadata = Join-Path $packageRoot 'driver-package.json'
Copy-Item -LiteralPath (Join-Path $buildOutput 'ComponentizedAudioSample.inf') -Destination $stagedInf -Force
Copy-Item -LiteralPath (Join-Path $buildOutput 'omni-virtual-speaker.sys') -Destination $stagedSys -Force
$importOutput = & $dumpbin /imports $stagedSys
if ($LASTEXITCODE -ne 0) {
  throw "dumpbin failed while inspecting $stagedSys. ExitCode=$LASTEXITCODE"
}
$kernelImportPolicy = Get-Content -LiteralPath $kernelImportPolicyPath -Raw -Encoding utf8 |
  ConvertFrom-Json
$declaredMinimumWindowsBuild = [int]$kernelImportPolicy.minimumSupportedWindowsBuild
$allowedKernelModules = @($kernelImportPolicy.modules.PSObject.Properties.Name | ForEach-Object {
  $_.ToLowerInvariant()
})
$importedModules = @()
$importedSymbols = @()
$currentImportModule = $null
foreach ($line in $importOutput) {
  if ($line -match '^\s*Summary\s*$') {
    $currentImportModule = $null
    continue
  }
  if ($line -match '^\s+([A-Za-z0-9_.-]+\.(?:dll|exe|sys))\s*$') {
    $currentImportModule = $Matches[1].ToLowerInvariant()
    $importedModules += $currentImportModule
    continue
  }
  if ($currentImportModule -and $line -match '^\s+[0-9A-Fa-f]+\s+([^\s]+)\s*$') {
    $importedSymbols += [pscustomobject]@{
      Module = $currentImportModule
      Symbol = $Matches[1]
    }
  }
}
$importedModules = @($importedModules | Select-Object -Unique)
$unexpectedModules = @($importedModules | Where-Object { $_ -notin $allowedKernelModules })
if ($unexpectedModules.Count -ne 0) {
  throw "SYSVAD driver imports non-kernel modules: $($unexpectedModules -join ', ')"
}
$minimumWindowsBuild = 0
foreach ($import in $importedSymbols) {
  $moduleProperty = $kernelImportPolicy.modules.PSObject.Properties |
    Where-Object { $_.Name.Equals($import.Module, [StringComparison]::OrdinalIgnoreCase) } |
    Select-Object -First 1
  if (-not $moduleProperty) {
    throw "SYSVAD import policy does not declare module $($import.Module)."
  }
  $symbolProperty = $moduleProperty.Value.PSObject.Properties[$import.Symbol]
  if (-not $symbolProperty) {
    throw "SYSVAD import policy does not declare $($import.Module)!$($import.Symbol). Audit its minimum Windows build before shipping."
  }
  $minimumWindowsBuild = [Math]::Max($minimumWindowsBuild, [int]$symbolProperty.Value)
}
if ($minimumWindowsBuild -gt $declaredMinimumWindowsBuild) {
  throw "SYSVAD imports require Windows build $minimumWindowsBuild, above the declared minimum $declaredMinimumWindowsBuild."
}
if ($minimumWindowsBuild -ne $declaredMinimumWindowsBuild) {
  throw "SYSVAD import audit resolved build $minimumWindowsBuild, but the declared minimum is $declaredMinimumWindowsBuild. Keep the INF, installer, and import policy in lockstep."
}
Write-Output "SYSVAD kernel import audit passed: $($importedSymbols.Count) symbols, minimum Windows build $minimumWindowsBuild."
Remove-Item -LiteralPath $stagedCat -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $stagedPublicCertificate -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $stagedMetadata -Force -ErrorAction SilentlyContinue

$infverif = Join-Path $wdkToolsRoot 'infverif.exe'
Invoke-Checked $infverif @('/u', $stagedInf)

if ($SkipSigning) {
  $unsignedMetadata = [ordered]@{
    sourceCommit = $null
    sourceProvenance = $null
    protocolVersion = '2026-08-10-audio-routing-v6'
    configuration = $Configuration
    platform = $Platform
    minimumWindowsBuild = $declaredMinimumWindowsBuild
    kernelImportMinimumWindowsBuild = $minimumWindowsBuild
    signingMode = 'unsigned'
    signerThumbprint = $null
  }
  Write-Utf8NoBom $stagedMetadata (($unsignedMetadata | ConvertTo-Json -Depth 3) + "`n")
  Write-Warning 'Staged INF and SYS without CAT because -SkipSigning was supplied.'
  exit 0
}

$useDevelopmentSigningCredential = -not $SigningPfxPath
if (-not $SigningPfxPath) {
  $developmentSigningRoot = Join-Path $workspacePath 'artifacts\driver-signing\development'
  $SigningPfxPath = Join-Path $developmentSigningRoot 'omni-translate-development-driver.pfx'
  $SigningPfxPasswordPath = Join-Path $developmentSigningRoot 'password.txt'
  if (-not (Test-Path -LiteralPath $SigningPfxPath -PathType Leaf)) {
    & (Join-Path $PSScriptRoot 'new-development-driver-certificate.ps1') -WorkspaceRoot $workspacePath
    if ($LASTEXITCODE -ne 0) {
      throw "Development signing certificate generation failed. ExitCode=$LASTEXITCODE"
    }
  }
}
if (-not $SigningPfxPasswordPath) {
  throw 'SigningPfxPasswordPath is required when SigningPfxPath is provided.'
}
if (-not $useDevelopmentSigningCredential -and [string]::IsNullOrWhiteSpace($SigningTimestampUrl)) {
  throw 'SigningTimestampUrl is required for a release-injected driver signature.'
}
Assert-File $SigningPfxPath 'Signing PFX'
Assert-File $SigningPfxPasswordPath 'Signing PFX password file'
$signingPassword = (Get-Content -LiteralPath $SigningPfxPasswordPath -Raw).Trim()
$signtool = Join-Path $wdkBinRoot 'x64\signtool.exe'
$inf2cat = Join-Path $wdkBinRoot 'x86\Inf2Cat.exe'

$signingArguments = @('sign', '/fd', 'SHA256', '/f', $SigningPfxPath, '/p', $signingPassword)
if (-not $useDevelopmentSigningCredential) {
  $signingArguments += @('/tr', $SigningTimestampUrl, '/td', 'SHA256')
}
Invoke-Checked $signtool @($signingArguments + @($stagedSys))
Invoke-Checked $inf2cat @("/driver:$packageRoot", '/os:10_X64', '/uselocaltime', '/verbose')
Invoke-Checked $signtool @($signingArguments + @($stagedCat))

$signingCertificate = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2(
  $SigningPfxPath,
  $signingPassword
)
$isDevelopmentTestSigner = $useDevelopmentSigningCredential -or
  $signingCertificate.Subject -eq 'CN=Omni Translate Development Driver Test Signing'
foreach ($signedPath in @($stagedSys, $stagedCat)) {
  $signature = Get-AuthenticodeSignature -LiteralPath $signedPath
  if (-not $signature.SignerCertificate -or $signature.SignerCertificate.Thumbprint -ne $signingCertificate.Thumbprint) {
    throw "Unexpected Authenticode signer for $signedPath"
  }
  if (-not $useDevelopmentSigningCredential -and -not $signature.TimeStamperCertificate) {
    throw "Release-injected signature is missing an RFC3161 timestamp for $signedPath"
  }
}

$certificatePath = [System.IO.Path]::ChangeExtension($SigningPfxPath, '.cer')
if ($isDevelopmentTestSigner -and (Test-Path -LiteralPath $certificatePath -PathType Leaf)) {
  Copy-Item -LiteralPath $certificatePath -Destination $stagedPublicCertificate -Force
}

$packageMetadata = [ordered]@{
  sourceCommit = if ($isDevelopmentTestSigner) { $null } else { [string]$releaseSourceProvenance.headCommit }
  sourceProvenance = if ($isDevelopmentTestSigner) { $null } else { $releaseSourceProvenance }
  protocolVersion = '2026-08-10-audio-routing-v6'
  configuration = $Configuration
  platform = $Platform
  minimumWindowsBuild = $declaredMinimumWindowsBuild
  kernelImportMinimumWindowsBuild = $minimumWindowsBuild
  signingMode = if ($isDevelopmentTestSigner) { 'development-test' } else { 'release-injected' }
  signerThumbprint = $signingCertificate.Thumbprint
  timestampMode = if ($isDevelopmentTestSigner) { 'none' } else { 'rfc3161' }
  timestampUrl = if ($isDevelopmentTestSigner) { $null } else { $SigningTimestampUrl }
}
Write-Utf8NoBom $stagedMetadata (($packageMetadata | ConvertTo-Json -Depth 3) + "`n")

Write-Output "SYSVAD package staged at $packageRoot"
