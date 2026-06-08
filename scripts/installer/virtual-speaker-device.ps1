$script:OmniVirtualSpeakerHardwareId = 'Root\OmniTranslateVirtualSpeaker'
$script:OmniVirtualSpeakerName = 'Omni Translate Virtual Speaker'

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

function Get-OmniVirtualSpeakerEndpoint([string]$ExpectedEndpointName = $script:OmniVirtualSpeakerName) {
  Get-PnpDevice -PresentOnly -Class AudioEndpoint -ErrorAction SilentlyContinue | Where-Object {
    $_.FriendlyName -like "*$ExpectedEndpointName*"
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
            byte[] output = new byte[128];
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
  $probePath = Join-Path $workspacePath 'apps\bridge-service-native\target\release\omni-driver-audio-probe.exe'
  if (-not (Test-Path -LiteralPath $probePath -PathType Leaf)) {
    throw "The WASAPI audio probe has not been built: $probePath. Run npm run build:bridge-service-native first."
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
