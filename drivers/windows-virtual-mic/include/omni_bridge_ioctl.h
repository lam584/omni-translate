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
#define IOCTL_OMNI_BRIDGE_BEGIN_MIC_SESSION \
    CTL_CODE(FILE_DEVICE_OMNI_TRANSLATE, 0x803, METHOD_BUFFERED, FILE_WRITE_DATA)
#define IOCTL_OMNI_BRIDGE_WRITE_MIC_PCM \
    CTL_CODE(FILE_DEVICE_OMNI_TRANSLATE, 0x804, METHOD_BUFFERED, FILE_WRITE_DATA)
#define IOCTL_OMNI_BRIDGE_END_MIC_SESSION \
    CTL_CODE(FILE_DEVICE_OMNI_TRANSLATE, 0x805, METHOD_BUFFERED, FILE_WRITE_DATA)

#define OMNI_BRIDGE_ABI_VERSION 0x20260810

#define OMNI_VIRTUAL_MIC_SAMPLE_RATE_HZ 48000
#define OMNI_VIRTUAL_MIC_CHANNEL_COUNT 1
#define OMNI_VIRTUAL_MIC_BITS_PER_SAMPLE 16
#define OMNI_VIRTUAL_MIC_BLOCK_ALIGN_BYTES 2
#define OMNI_VIRTUAL_MIC_MAX_WRITE_FRAMES 48000

typedef struct _OMNI_VIRTUAL_MIC_FORMAT
{
    ULONG SampleRateHz;
    ULONG ChannelCount;
    ULONG BitsPerSample;
    ULONG BlockAlignBytes;
} OMNI_VIRTUAL_MIC_FORMAT, *POMNI_VIRTUAL_MIC_FORMAT;

typedef struct _OMNI_VIRTUAL_MIC_SESSION
{
    ULONG AbiVersion;
    ULONG StructSize;
    ULONGLONG Generation;
    OMNI_VIRTUAL_MIC_FORMAT Format;
} OMNI_VIRTUAL_MIC_SESSION, *POMNI_VIRTUAL_MIC_SESSION;

typedef struct _OMNI_VIRTUAL_MIC_WRITE_HEADER
{
    ULONG AbiVersion;
    ULONG HeaderBytes;
    ULONGLONG Generation;
    ULONG SampleRateHz;
    ULONG ChannelCount;
    ULONG BitsPerSample;
    ULONG FrameCount;
    ULONG PayloadBytes;
    ULONG Reserved;
} OMNI_VIRTUAL_MIC_WRITE_HEADER, *POMNI_VIRTUAL_MIC_WRITE_HEADER;

typedef struct _OMNI_BRIDGE_STATUS
{
    ULONG AbiVersion;
    ULONG RingCapacityBytes;
    ULONG BufferedBytes;
    ULONG MaxBufferedBytes;
    ULONGLONG CapturedBytes;
    ULONGLONG DeliveredBytes;
    ULONGLONG DroppedBytes;
    ULONGLONG RenderStreamsCreated;
    ULONGLONG RenderRunTransitions;
    ULONGLONG RenderSetWritePacketCalls;
    ULONGLONG RenderReadBytesCalls;
    ULONGLONG LoopbackCaptureReadCalls;
    ULONG MicRingCapacityBytes;
    ULONG MicBufferedBytes;
    ULONG MicMaxBufferedBytes;
    ULONG MicSampleRateHz;
    ULONG MicChannelCount;
    ULONG MicBitsPerSample;
    ULONG MicSessionActive;
    ULONG MicReserved;
    ULONGLONG MicGeneration;
    ULONGLONG MicWrittenBytes;
    ULONGLONG MicConsumedBytes;
    ULONGLONG MicDroppedBytes;
    ULONGLONG MicUnderrunBytes;
    ULONGLONG MicRejectedWrites;
} OMNI_BRIDGE_STATUS, *POMNI_BRIDGE_STATUS;
