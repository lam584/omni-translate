#requires -Version 5.1

function Add-CoreAudioPolicyConfig {
  if ([type]::GetType("OmniTranslate.AudioPolicyConfigClient", $false)) {
    return
  }
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

namespace OmniTranslate {
  public enum EDataFlow { eRender = 0, eCapture = 1, eAll = 2 }
  public enum ERole { eConsole = 0, eMultimedia = 1, eCommunications = 2 }

  [ComImport]
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDeviceEnumerator {
    int NotImpl1();
    int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice endpoint);
  }

  [ComImport]
  [Guid("D666063F-1587-4E43-81F1-B948E807363F")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDevice {
    int Activate(ref Guid iid, int dwClsCtx, IntPtr activationParams, out IntPtr interfacePointer);
    int OpenPropertyStore(int stgmAccess, out IntPtr properties);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    int GetState(out int state);
  }

  [ComImport]
  [Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  public class MMDeviceEnumerator {}

  [ComImport]
  [Guid("F8679F50-850A-41CF-9C72-430F290290C8")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IPolicyConfig {
    int GetMixFormat([MarshalAs(UnmanagedType.LPWStr)] string deviceId, out IntPtr format);
    int GetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string deviceId, int defaultFormat, out IntPtr format);
    int ResetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string deviceId);
    int SetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string deviceId, IntPtr endpointFormat, IntPtr mixFormat);
    int GetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string deviceId, int defaultPeriod, out long defaultProcessingPeriod, out long minimumProcessingPeriod);
    int SetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string deviceId, ref long processingPeriod);
    int GetShareMode([MarshalAs(UnmanagedType.LPWStr)] string deviceId, IntPtr mode);
    int SetShareMode([MarshalAs(UnmanagedType.LPWStr)] string deviceId, IntPtr mode);
    int GetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string deviceId, ref Guid key, IntPtr value);
    int SetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string deviceId, ref Guid key, IntPtr value);
    int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string deviceId, ERole role);
    int SetEndpointVisibility([MarshalAs(UnmanagedType.LPWStr)] string deviceId, int visible);
  }

  [ComImport]
  [Guid("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9")]
  public class AudioPolicyConfigClient {}

  public static class AudioEndpointSwitcher {
    public static string GetDefaultRenderEndpointId() {
      var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
      IMMDevice device;
      enumerator.GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eMultimedia, out device);
      if (device == null) {
        return null;
      }
      string id;
      device.GetId(out id);
      return id;
    }

    public static void SetDefaultRenderEndpoint(string endpointId) {
      if (String.IsNullOrWhiteSpace(endpointId)) {
        return;
      }
      var policy = (IPolicyConfig)(new AudioPolicyConfigClient());
      policy.SetDefaultEndpoint(endpointId, ERole.eConsole);
      policy.SetDefaultEndpoint(endpointId, ERole.eMultimedia);
      policy.SetDefaultEndpoint(endpointId, ERole.eCommunications);
    }
  }
}
"@
}

function Convert-ComObjectToInterface {
  param([object]$ComObject, [type]$InterfaceType)
  $unknown = [System.Runtime.InteropServices.Marshal]::GetIUnknownForObject($ComObject)
  try {
    return [System.Runtime.InteropServices.Marshal]::GetTypedObjectForIUnknown($unknown, $InterfaceType)
  } finally {
    [void][System.Runtime.InteropServices.Marshal]::Release($unknown)
  }
}

function Get-DefaultRenderEndpointId {
  Add-CoreAudioPolicyConfig
  return [OmniTranslate.AudioEndpointSwitcher]::GetDefaultRenderEndpointId()
}

function Get-PhysicalPlaybackDeviceClassFromSignals {
  param([string[]]$Signals)
  $classificationText = (@($Signals) | Where-Object { $_ } | ForEach-Object { [string]$_ }) -join " "
  if ($classificationText -match '(?i)bluetooth|\bbth(?:enum|hf|a2dp)?\b|a2dp|hands[ -]?free') {
    return "bluetooth"
  }
  if ($classificationText -match '(?i)\busb\b|usb[\\#_-]|vid_[0-9a-f]{4}') {
    return "usb"
  }
  if ($classificationText.Trim()) {
    return "default-speaker"
  }
  return $null
}

function Get-RenderEndpointRegistryIdentity {
  param([string]$RequestedDeviceId)
  $resolvedDeviceId = if (-not $RequestedDeviceId -or $RequestedDeviceId -eq "default") {
    Get-DefaultRenderEndpointId
  } else {
    $RequestedDeviceId
  }
  if (-not $resolvedDeviceId) {
    throw "Windows did not resolve a physical render endpoint id for '$RequestedDeviceId'."
  }
  # MMDevices stores the endpoint under the GUID suffix, while the Core Audio
  # API commonly returns the full {flow}.{guid} device id.
  $registryDeviceId = if ($resolvedDeviceId -match '^\{[^}]+\}\.\{[^}]+\}$') {
    $resolvedDeviceId.Substring($resolvedDeviceId.IndexOf('}.') + 2)
  } else {
    $resolvedDeviceId
  }
  $registryPath = "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Render\$registryDeviceId\Properties"
  if (-not (Test-Path -LiteralPath $registryPath -PathType Container)) {
    throw "physical render endpoint '$resolvedDeviceId' has no Windows MMDevice registry evidence"
  }
  $properties = Get-ItemProperty -LiteralPath $registryPath
  $friendlyName = [string]$properties.'{a45c254e-df1c-4efd-8020-67d146a850e0},14'
  if (-not $friendlyName.Trim()) {
    $endpointName = [string]$properties.'{a45c254e-df1c-4efd-8020-67d146a850e0},2'
    $deviceName = [string]$properties.'{b3f8fa53-0004-438e-9003-51a46e139bfc},6'
    $friendlyName = if ($endpointName.Trim() -and $deviceName.Trim()) {
      "$($endpointName.Trim()) ($($deviceName.Trim()))"
    } elseif ($endpointName.Trim()) {
      $endpointName
    } else {
      $deviceName
    }
  }
  if (-not $friendlyName.Trim()) {
    throw "physical render endpoint '$resolvedDeviceId' has no Windows MMDevice friendly name"
  }
  $signals = @($resolvedDeviceId, $friendlyName)
  foreach ($property in $properties.PSObject.Properties) {
    if ($property.Name -like 'PS*' -or $null -eq $property.Value) { continue }
    if ($property.Value -is [string]) {
      $signals += [string]$property.Value
    } elseif ($property.Value -is [string[]]) {
      $signals += @($property.Value)
    }
  }
  return [pscustomobject]@{
    resolvedDeviceId = $resolvedDeviceId
    resolvedDeviceName = $friendlyName.Trim()
    classificationSignals = @($signals | Where-Object { $_ } | Select-Object -Unique -First 32)
  }
}

function New-PhysicalPlaybackDeviceEvidence {
  param(
    [string]$ProfileId,
    [string]$ExpectedDeviceClass,
    [string]$RequestedDeviceId,
    [string]$ResolvedDeviceId,
    [string]$ResolvedDeviceName,
    [string[]]$ClassificationSignals,
    [string]$RouteEvidenceSource,
    [bool]$FixtureOnly = $false
  )
  $inferredClass = Get-PhysicalPlaybackDeviceClassFromSignals @(
    $ResolvedDeviceId,
    $ResolvedDeviceName,
    $ClassificationSignals
  )
  if ($inferredClass -ne $ExpectedDeviceClass) {
    throw "physical endpoint class mismatch: profile=$ProfileId expected=$ExpectedDeviceClass inferred=$inferredClass id=$ResolvedDeviceId name=$ResolvedDeviceName"
  }
  return [pscustomobject]@{
    profileId = $ProfileId
    deviceClass = $ExpectedDeviceClass
    requestedDeviceId = $RequestedDeviceId
    resolvedDeviceId = $ResolvedDeviceId
    resolvedDeviceName = $ResolvedDeviceName
    classificationSignals = @($ClassificationSignals)
    classificationSource = "windows-mmdevice-registry"
    routeEvidenceSource = $RouteEvidenceSource
    verified = -not $FixtureOnly
    fixtureOnly = $FixtureOnly
  }
}

function Resolve-PhysicalPlaybackDeviceEvidence {
  param(
    $PhysicalOutputProbe,
    [Parameter(Mandatory = $true)][string]$FeedbackMode,
    [Parameter(Mandatory = $true)][string]$RequestedDeviceId,
    [AllowEmptyString()][string]$ExpectedDeviceName,
    [Parameter(Mandatory = $true)][string]$ProfileId,
    [Parameter(Mandatory = $true)][string]$DeviceClass
  )
  $probeResult = if ($PhysicalOutputProbe -and $PhysicalOutputProbe.status -eq 'passed') {
    $PhysicalOutputProbe.data
  } else {
    $null
  }
  if ($FeedbackMode -ne "echo-cancel") {
    if (-not $probeResult -or $probeResult.skipped -or -not $probeResult.passed) {
      throw "the $FeedbackMode route has no passed physical-output endpoint probe"
    }
  }
  $probeResolvedId = if ($probeResult) { [string]$probeResult.resolvedPhysicalPlaybackDeviceId } else { "" }
  $identity = Get-RenderEndpointRegistryIdentity $(
    if ($probeResolvedId) { $probeResolvedId } else { $RequestedDeviceId }
  )
  $probeResolvedName = if ($probeResult) { [string]$probeResult.resolvedPhysicalPlaybackDeviceName } else { "" }
  if ($ExpectedDeviceName) {
    $nameMatches = $identity.resolvedDeviceName -like "*$ExpectedDeviceName*" -or
      ($probeResolvedName -and $probeResolvedName -like "*$ExpectedDeviceName*")
    if (-not $nameMatches) {
      throw "resolved endpoint '$($identity.resolvedDeviceName)' does not match expected device name '$ExpectedDeviceName'"
    }
  }
  $signals = @($identity.classificationSignals)
  if ($probeResolvedName) { $signals += $probeResolvedName }
  $routeEvidenceSource = if ($FeedbackMode -eq "echo-cancel") {
    "desktop-runtime-route+windows-mmdevice"
  } else {
    "physical-output-probe+runtime-route"
  }
  return New-PhysicalPlaybackDeviceEvidence `
    -ProfileId $ProfileId `
    -ExpectedDeviceClass $DeviceClass `
    -RequestedDeviceId $RequestedDeviceId `
    -ResolvedDeviceId $identity.resolvedDeviceId `
    -ResolvedDeviceName $identity.resolvedDeviceName `
    -ClassificationSignals $signals `
    -RouteEvidenceSource $routeEvidenceSource
}

function Set-DefaultRenderEndpoint {
  param([string]$EndpointId)
  if (-not $EndpointId) {
    return
  }
  Add-CoreAudioPolicyConfig
  [OmniTranslate.AudioEndpointSwitcher]::SetDefaultRenderEndpoint($EndpointId)
}


Export-ModuleMember -Function @(
  'Add-CoreAudioPolicyConfig',
  'Get-DefaultRenderEndpointId',
  'Get-PhysicalPlaybackDeviceClassFromSignals',
  'Get-RenderEndpointRegistryIdentity',
  'New-PhysicalPlaybackDeviceEvidence',
  'Resolve-PhysicalPlaybackDeviceEvidence',
  'Set-DefaultRenderEndpoint'
)
