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
        SafeFileHandle device, uint controlCode, IntPtr input, uint inputLength,
        out Status output, uint outputLength, out uint bytesReturned, IntPtr overlapped);

    public static Status Query()
    {
        using (var device = CreateFileW(
            @"\\.\OmniTranslateVirtualAudio", GenericRead | GenericWrite,
            FileShareRead | FileShareWrite, IntPtr.Zero, OpenExisting, 0, IntPtr.Zero))
        {
            if (device.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
            Status status;
            uint bytesReturned;
            if (!DeviceIoControl(
                device, IoctlQueryStatus, IntPtr.Zero, 0, out status,
                (uint)Marshal.SizeOf<Status>(), out bytesReturned, IntPtr.Zero))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            return status;
        }
    }
}
'@
  }

  [OmniVirtualAudioProbe]::Query()
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
