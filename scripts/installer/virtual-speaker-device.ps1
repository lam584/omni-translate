$script:OmniVirtualSpeakerHardwareId = 'Root\OmniTranslateVirtualSpeaker'
$script:OmniVirtualSpeakerName = 'Omni Translate Virtual Speaker'
$script:OmniVirtualMicrophoneName = 'Omni Translate Virtual Microphone'

function Get-OmniVirtualSpeakerHardwareId {
  return $script:OmniVirtualSpeakerHardwareId
}
$script:OmniVirtualDriverMinimumWindowsBuild = 19041

function Get-OmniWindowsBuildNumber {
  $currentVersion = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction Stop
  $rawBuild = if ($currentVersion.CurrentBuildNumber) {
    $currentVersion.CurrentBuildNumber
  } else {
    $currentVersion.CurrentBuild
  }
  $windowsBuild = 0
  if (-not [int]::TryParse([string]$rawBuild, [ref]$windowsBuild)) {
    throw "Windows build number is unavailable from CurrentVersion: $rawBuild"
  }
  return $windowsBuild
}

function Test-OmniVirtualDriverWindowsBuild(
  [int]$WindowsBuild = 0
) {
  if ($WindowsBuild -le 0) {
    $WindowsBuild = Get-OmniWindowsBuildNumber
  }
  return $WindowsBuild -ge $script:OmniVirtualDriverMinimumWindowsBuild
}

function Assert-OmniVirtualDriverWindowsBuild(
  [int]$WindowsBuild = 0
) {
  if ($WindowsBuild -le 0) {
    $WindowsBuild = Get-OmniWindowsBuildNumber
  }
  if (-not (Test-OmniVirtualDriverWindowsBuild -WindowsBuild $WindowsBuild)) {
    throw "Omni Translate Virtual Driver requires Windows build $script:OmniVirtualDriverMinimumWindowsBuild or newer. Current build: $WindowsBuild."
  }
}

function Assert-OmniAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Managing the development driver requires an elevated PowerShell session.'
  }
}

function Get-OmniVirtualSpeakerRootDevices {
  $enumRoot = 'HKLM:\SYSTEM\CurrentControlSet\Enum\ROOT'
  @(Get-ChildItem -Path $enumRoot -Recurse -ErrorAction SilentlyContinue | Where-Object {
    try {
      $properties = Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction Stop
      @($properties.HardwareID) -contains $script:OmniVirtualSpeakerHardwareId
    } catch {
      $false
    }
  } | ForEach-Object {
    $relativePath = $_.Name.Substring('HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Enum\'.Length)
    Get-PnpDevice -InstanceId $relativePath -ErrorAction SilentlyContinue
  } | Where-Object { $_ })
}

function Test-OmniAudioEndpointDirection(
  [Parameter(Mandatory = $true)][object]$Endpoint,
  [Parameter(Mandatory = $true)][ValidateSet('render', 'capture')][string]$Direction
) {
  $dataFlowPrefix = if ($Direction -eq 'render') {
    'SWD\MMDEVAPI\{0.0.0.'
  } else {
    'SWD\MMDEVAPI\{0.0.1.'
  }
  return ([string]$Endpoint.InstanceId).StartsWith(
    $dataFlowPrefix,
    [System.StringComparison]::OrdinalIgnoreCase
  )
}

function Test-OmniVirtualAudioEndpoint(
  [Parameter(Mandatory = $true)][object]$Endpoint,
  [Parameter(Mandatory = $true)][ValidateSet('render', 'capture')][string]$Direction,
  [Parameter(Mandatory = $true)][string]$ExpectedEndpointName
) {
  return (
    (Test-OmniAudioEndpointDirection -Endpoint $Endpoint -Direction $Direction) -and
    ([string]$Endpoint.FriendlyName).IndexOf(
      $ExpectedEndpointName,
      [System.StringComparison]::OrdinalIgnoreCase
    ) -ge 0
  )
}

function Test-OmniPnpDriverStoreAuthorityRecord(
  [Parameter(Mandatory = $true)][object]$Binding,
  [Parameter(Mandatory = $true)][object]$Package,
  [string]$ExpectedDriverVersion = ''
) {
  $bindingVersion = [string]$Binding.driverVersion
  return (
    -not [string]::IsNullOrWhiteSpace([string]$Binding.instanceId) -and
    -not [string]::IsNullOrWhiteSpace([string]$Binding.infName) -and
    -not [string]::IsNullOrWhiteSpace($bindingVersion) -and
    [string]$Binding.driverProvider -eq 'Omni Translate' -and
    [string]$Binding.matchingDeviceId -eq $script:OmniVirtualSpeakerHardwareId -and
    [string]$Binding.service -eq 'omni_translate_virtual_speaker' -and
    [string]$Package.Driver -eq [string]$Binding.infName -and
    [string]$Package.ProviderName -eq 'Omni Translate' -and
    [string]$Package.ClassName -eq 'MEDIA' -and
    [string]$Package.Version -eq $bindingVersion -and
    (
      [string]::IsNullOrWhiteSpace($ExpectedDriverVersion) -or
      $bindingVersion -eq $ExpectedDriverVersion
    )
  )
}

function Test-OmniInstalledDriverAuthorityRecord(
  [Parameter(Mandatory = $true)][object]$Candidate,
  [Parameter(Mandatory = $true)][object]$Binding,
  [Parameter(Mandatory = $true)][object]$Package,
  [string]$ExpectedDriverVersion = ''
) {
  return (
    (Test-OmniPnpDriverStoreAuthorityRecord `
      -Binding $Binding `
      -Package $Package `
      -ExpectedDriverVersion $ExpectedDriverVersion) -and
    -not [string]::IsNullOrWhiteSpace([string]$Candidate.DeviceID) -and
    -not [string]::IsNullOrWhiteSpace([string]$Candidate.InfName) -and
    [string]$Candidate.InfName -eq [string]$Binding.infName -and
    [string]$Candidate.DriverVersion -eq [string]$Binding.driverVersion -and
    [string]$Candidate.DriverProviderName -eq 'Omni Translate'
  )
}

function Get-OmniOptionalSignedDriverQuery(
  [scriptblock]$Query = $null
) {
  if (-not $Query) {
    $Query = { @(Get-CimInstance Win32_PnPSignedDriver -ErrorAction Stop) }
  }
  try {
    return [pscustomobject]@{
      probeStatus = 'query-succeeded'
      rows = @(& $Query)
      queryDiagnostic = $null
    }
  } catch {
    return [pscustomobject]@{
      probeStatus = 'query-unavailable'
      rows = @()
      queryDiagnostic = [pscustomobject]@{
        exceptionType = $_.Exception.GetType().FullName
        message = [string]$_.Exception.Message
        fullyQualifiedErrorId = [string]$_.FullyQualifiedErrorId
        category = [string]$_.CategoryInfo.Category
      }
    }
  }
}

function Get-OmniVirtualSpeakerEndpoint([string]$ExpectedEndpointName = $script:OmniVirtualSpeakerName) {
  Get-PnpDevice -PresentOnly -Class AudioEndpoint -ErrorAction SilentlyContinue | Where-Object {
    Test-OmniVirtualAudioEndpoint -Endpoint $_ -Direction render -ExpectedEndpointName $ExpectedEndpointName
  } | Select-Object -First 1
}

function Get-OmniVirtualMicrophoneEndpoint([string]$ExpectedEndpointName = $script:OmniVirtualMicrophoneName) {
  Get-PnpDevice -PresentOnly -Class AudioEndpoint -ErrorAction SilentlyContinue | Where-Object {
    Test-OmniVirtualAudioEndpoint -Endpoint $_ -Direction capture -ExpectedEndpointName $ExpectedEndpointName
  } | Select-Object -First 1
}

function Invoke-OmniVirtualAudioProbe {
  if (-not ('OmniVirtualAudioProbe' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class OmniVirtualAudioProbe
{
    private const uint FileDeviceOmniTranslate = 0x8337;
    private const uint FileReadData = 0x0001;
    private const uint MethodBuffered = 0;
    private static readonly uint IoctlQueryStatus =
        (FileDeviceOmniTranslate << 16) | (FileReadData << 14) | (0x801u << 2) | MethodBuffered;
    private const uint GenericRead = 0x80000000;
    private const uint GenericWrite = 0x40000000;
    private const uint FileShareRead = 0x00000001;
    private const uint FileShareWrite = 0x00000002;
    private const uint OpenExisting = 3;

    [StructLayout(LayoutKind.Sequential)]
    public struct Status
    {
        public uint AbiVersion;
        public uint RingCapacityBytes;
        public uint BufferedBytes;
        public uint MaxBufferedBytes;
        public ulong CapturedBytes;
        public ulong DeliveredBytes;
        public ulong DroppedBytes;
        public ulong RenderStreamsCreated;
        public ulong RenderRunTransitions;
        public ulong RenderSetWritePacketCalls;
        public ulong RenderReadBytesCalls;
        public ulong LoopbackCaptureReadCalls;
        public uint MicRingCapacityBytes;
        public uint MicBufferedBytes;
        public uint MicMaxBufferedBytes;
        public uint MicSampleRateHz;
        public uint MicChannelCount;
        public uint MicBitsPerSample;
        public uint MicSessionActive;
        public uint MicReserved;
        public ulong MicGeneration;
        public ulong MicWrittenBytes;
        public ulong MicConsumedBytes;
        public ulong MicDroppedBytes;
        public ulong MicUnderrunBytes;
        public ulong MicRejectedWrites;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(
        string fileName, uint desiredAccess, uint shareMode, IntPtr securityAttributes,
        uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DeviceIoControl(
        SafeFileHandle device, uint controlCode, byte[] input, uint inputLength,
        byte[] output, uint outputLength, out uint bytesReturned, IntPtr overlapped);

    public static Status Query()
    {
        using (var device = CreateFileW(
            @"\\.\OmniTranslateVirtualAudio", GenericRead | GenericWrite,
            FileShareRead | FileShareWrite, IntPtr.Zero, OpenExisting, 0, IntPtr.Zero))
        {
            if (device.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
            byte[] output = new byte[256];
            uint bytesReturned;
            if (!DeviceIoControl(
                device, IoctlQueryStatus, null, 0, output,
                (uint)output.Length, out bytesReturned, IntPtr.Zero))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            if (bytesReturned < Marshal.SizeOf<Status>())
            {
                throw new Win32Exception(122, "Driver returned an incomplete status buffer.");
            }
            Status status = new Status();
            status.AbiVersion = BitConverter.ToUInt32(output, 0);
            status.RingCapacityBytes = BitConverter.ToUInt32(output, 4);
            status.BufferedBytes = BitConverter.ToUInt32(output, 8);
            status.MaxBufferedBytes = BitConverter.ToUInt32(output, 12);
            status.CapturedBytes = BitConverter.ToUInt64(output, 16);
            status.DeliveredBytes = BitConverter.ToUInt64(output, 24);
            status.DroppedBytes = BitConverter.ToUInt64(output, 32);
            status.RenderStreamsCreated = BitConverter.ToUInt64(output, 40);
            status.RenderRunTransitions = BitConverter.ToUInt64(output, 48);
            status.RenderSetWritePacketCalls = BitConverter.ToUInt64(output, 56);
            status.RenderReadBytesCalls = BitConverter.ToUInt64(output, 64);
            status.LoopbackCaptureReadCalls = BitConverter.ToUInt64(output, 72);
            status.MicRingCapacityBytes = BitConverter.ToUInt32(output, 80);
            status.MicBufferedBytes = BitConverter.ToUInt32(output, 84);
            status.MicMaxBufferedBytes = BitConverter.ToUInt32(output, 88);
            status.MicSampleRateHz = BitConverter.ToUInt32(output, 92);
            status.MicChannelCount = BitConverter.ToUInt32(output, 96);
            status.MicBitsPerSample = BitConverter.ToUInt32(output, 100);
            status.MicSessionActive = BitConverter.ToUInt32(output, 104);
            status.MicReserved = BitConverter.ToUInt32(output, 108);
            status.MicGeneration = BitConverter.ToUInt64(output, 112);
            status.MicWrittenBytes = BitConverter.ToUInt64(output, 120);
            status.MicConsumedBytes = BitConverter.ToUInt64(output, 128);
            status.MicDroppedBytes = BitConverter.ToUInt64(output, 136);
            status.MicUnderrunBytes = BitConverter.ToUInt64(output, 144);
            status.MicRejectedWrites = BitConverter.ToUInt64(output, 152);
            return status;
        }
    }
}
'@
  }

  [OmniVirtualAudioProbe]::Query()
}

function Invoke-OmniWasapiAudioProbe([string]$WorkspaceRoot = (Join-Path $PSScriptRoot '..\..')) {
  $workspacePath = (Resolve-Path -LiteralPath $WorkspaceRoot).Path
  # In a source workspace the strict matrix prebuilds the root Cargo target;
  # prefer it over installed-layout or legacy copies that may be stale.
  $probeCandidates = @(
    (Join-Path $workspacePath 'target\release\omni-driver-audio-probe.exe'),
    (Join-Path $workspacePath 'bridge-service-native\omni-driver-audio-probe.exe'),
    (Join-Path $workspacePath 'apps\bridge-service-native\target\release\omni-driver-audio-probe.exe')
  )
  $probePath = $probeCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
  if (-not $probePath) {
    throw "The WASAPI audio probe has not been built: $($probeCandidates -join ' | '). Run npm run build:bridge-service-native first."
  }

  $probeOutput = & $probePath
  $probeExitCode = $LASTEXITCODE
  if (-not $probeOutput) {
    throw "The WASAPI audio probe returned no JSON output. ExitCode=$probeExitCode"
  }
  try {
    $probe = ($probeOutput -join [Environment]::NewLine) | ConvertFrom-Json
  } catch {
    throw "The WASAPI audio probe returned invalid JSON. ExitCode=$probeExitCode Output=$probeOutput"
  }
  if ($probeExitCode -ne 0 -or -not $probe.passed) {
    throw "The WASAPI audio probe failed. ExitCode=$probeExitCode Detail=$($probe.detail) Restart Windows and rerun the driver installation if the driver package was just replaced."
  }
  return $probe
}

function Invoke-OmniVirtualMicTargetCaptureProbe(
  [string]$WorkspaceRoot = (Join-Path $PSScriptRoot '..\..'),
  [string]$OutputDirectory
) {
  if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    throw 'Virtual microphone target capture requires a non-empty evidence output directory.'
  }
  $workspacePath = (Resolve-Path -LiteralPath $WorkspaceRoot).Path
  $captureCandidates = @(
    (Join-Path $workspacePath 'target\release\omni-virtual-mic-target-capture.exe'),
    (Join-Path $workspacePath 'bridge-service-native\omni-virtual-mic-target-capture.exe'),
    (Join-Path $workspacePath 'apps\bridge-service-native\target\release\omni-virtual-mic-target-capture.exe')
  )
  $bridgeCandidates = @(
    (Join-Path $workspacePath 'target\release\omni-bridge-service.exe'),
    (Join-Path $workspacePath 'bridge-service-native\omni-bridge-service.exe'),
    (Join-Path $workspacePath 'apps\bridge-service-native\target\release\omni-bridge-service.exe')
  )
  $capturePath = $captureCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
  $bridgePath = $bridgeCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
  if (-not $capturePath) {
    throw "The virtual microphone target capture executable has not been built: $($captureCandidates -join ' | '). Run npm run build:bridge-service-native first."
  }
  if (-not $bridgePath) {
    throw "The native Bridge executable has not been built: $($bridgeCandidates -join ' | '). Run npm run build:bridge-service-native first."
  }

  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
  $runtimeRoot = Join-Path $workspacePath "artifacts\diagnostics\virtual-mic-target-capture\$stamp"
  $probeOutput = & $capturePath --output-directory $OutputDirectory --bridge-exe $bridgePath --runtime-root $runtimeRoot
  $probeExitCode = $LASTEXITCODE
  if (-not $probeOutput) {
    throw "The virtual microphone target capture returned no JSON output. ExitCode=$probeExitCode"
  }
  try {
    $probe = ($probeOutput -join [Environment]::NewLine) | ConvertFrom-Json
  } catch {
    throw "The virtual microphone target capture returned invalid JSON. ExitCode=$probeExitCode Output=$probeOutput"
  }
  if ($probeExitCode -ne 0 -or -not $probe.passed) {
    throw "The virtual microphone target capture failed. ExitCode=$probeExitCode Detail=$($probe.detail)"
  }
  return $probe
}

function Assert-OmniVirtualSpeakerRootDeviceCount([int]$ExpectedCount) {
  $devices = @(Get-OmniVirtualSpeakerRootDevices)
  if ($devices.Count -ne $ExpectedCount) {
    $ids = if ($devices.Count -eq 0) { '<none>' } else { $devices.InstanceId -join ', ' }
    throw "Expected $ExpectedCount $script:OmniVirtualSpeakerHardwareId ROOT device(s), found $($devices.Count): $ids"
  }
  return $devices
}

function Remove-OmniVirtualSpeakerDriverPackages([string]$PnPUtil) {
  $packages = @(Get-WindowsDriver -Online | Where-Object {
    $_.ProviderName -eq 'Omni Translate' -and
    [System.IO.Path]::GetFileName($_.OriginalFileName) -eq 'omni-virtual-speaker.inf'
  })
  foreach ($package in $packages) {
    & $PnPUtil /delete-driver $package.Driver /uninstall
    if ($LASTEXITCODE -notin @(0, 3010)) {
      throw "pnputil failed to uninstall $($package.Driver). ExitCode=$LASTEXITCODE"
    }
  }
}
