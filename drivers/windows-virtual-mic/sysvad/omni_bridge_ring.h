#pragma once

#include <ntddk.h>

NTSTATUS OmniBridgeInitialize(_In_ PDRIVER_OBJECT DriverObject);
VOID OmniBridgeCleanup();
VOID OmniBridgeWriteRenderPcm(_In_reads_bytes_(ByteCount) const UCHAR* Buffer, _In_ ULONG ByteCount);
VOID OmniBridgeReadLoopbackPcm(_Out_writes_bytes_(ByteCount) UCHAR* Buffer, _In_ ULONG ByteCount);
VOID OmniBridgeResetLoopbackPcm();
