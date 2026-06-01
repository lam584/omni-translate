#pragma once

#ifdef _KERNEL_MODE
#include <ntddk.h>
#else
#include <Windows.h>
#include <winioctl.h>
#endif

#define OMNI_BRIDGE_DEVICE_PATH L"\\\\.\\OmniTranslateVirtualAudio"
#define OMNI_BRIDGE_KERNEL_DEVICE_NAME L"\\Device\\OmniTranslateVirtualAudio"
#define OMNI_BRIDGE_DOS_DEVICE_NAME L"\\DosDevices\\OmniTranslateVirtualAudio"

#define FILE_DEVICE_OMNI_TRANSLATE 0x8337

#define IOCTL_OMNI_BRIDGE_READ_PCM \
    CTL_CODE(FILE_DEVICE_OMNI_TRANSLATE, 0x800, METHOD_BUFFERED, FILE_READ_DATA)
#define IOCTL_OMNI_BRIDGE_QUERY_STATUS \
    CTL_CODE(FILE_DEVICE_OMNI_TRANSLATE, 0x801, METHOD_BUFFERED, FILE_READ_DATA)
#define IOCTL_OMNI_BRIDGE_RESET \
    CTL_CODE(FILE_DEVICE_OMNI_TRANSLATE, 0x802, METHOD_BUFFERED, FILE_WRITE_DATA)

#define OMNI_BRIDGE_ABI_VERSION 0x20260602

typedef struct _OMNI_BRIDGE_STATUS
{
    ULONG AbiVersion;
    ULONG RingCapacityBytes;
    ULONG BufferedBytes;
    ULONG MaxBufferedBytes;
    ULONGLONG CapturedBytes;
    ULONGLONG DeliveredBytes;
    ULONGLONG DroppedBytes;
} OMNI_BRIDGE_STATUS, *POMNI_BRIDGE_STATUS;
