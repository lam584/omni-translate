#include <ntddk.h>
#include "../include/omni_bridge_ioctl.h"
#include "omni_bridge_ring.h"

#define OMNI_BRIDGE_RING_CAPACITY (4 * 1024 * 1024)
#define OMNI_BRIDGE_MAX_BUFFERED_BYTES 19200
#define OMNI_LOOPBACK_RING_CAPACITY OMNI_BRIDGE_MAX_BUFFERED_BYTES
#define OMNI_BRIDGE_POOL_TAG 'RbmO'

static PDEVICE_OBJECT g_OmniBridgeDevice = nullptr;
static PUCHAR g_OmniBridgeRing = nullptr;
static ULONG g_OmniBridgeReadOffset = 0;
static ULONG g_OmniBridgeWriteOffset = 0;
static ULONG g_OmniBridgeBufferedBytes = 0;
static ULONGLONG g_OmniBridgeCapturedBytes = 0;
static ULONGLONG g_OmniBridgeDeliveredBytes = 0;
static ULONGLONG g_OmniBridgeDroppedBytes = 0;
static PFILE_OBJECT g_OmniBridgeReaderOwner = nullptr;
static PUCHAR g_OmniLoopbackRing = nullptr;
static ULONG g_OmniLoopbackReadOffset = 0;
static ULONG g_OmniLoopbackWriteOffset = 0;
static ULONG g_OmniLoopbackBufferedBytes = 0;
static KSPIN_LOCK g_OmniBridgeLock;
static PDRIVER_DISPATCH g_OriginalCreate = nullptr;
static PDRIVER_DISPATCH g_OriginalClose = nullptr;
static PDRIVER_DISPATCH g_OriginalDeviceControl = nullptr;

static NTSTATUS CompleteIrp(_In_ PIRP Irp, _In_ NTSTATUS Status, _In_ ULONG_PTR Information)
{
    Irp->IoStatus.Status = Status;
    Irp->IoStatus.Information = Information;
    IoCompleteRequest(Irp, IO_NO_INCREMENT);
    return Status;
}

static VOID ResetRingLocked()
{
    g_OmniBridgeReadOffset = 0;
    g_OmniBridgeWriteOffset = 0;
    g_OmniBridgeBufferedBytes = 0;
}

static VOID ResetLoopbackRingLocked()
{
    g_OmniLoopbackReadOffset = 0;
    g_OmniLoopbackWriteOffset = 0;
    g_OmniLoopbackBufferedBytes = 0;
}

static ULONG ReadRingLocked(_Out_writes_bytes_(ByteCount) PUCHAR Buffer, _In_ ULONG ByteCount)
{
    ULONG copied = 0;
    ULONG remaining = min(ByteCount, g_OmniBridgeBufferedBytes);

    while (remaining > 0)
    {
        ULONG run = min(remaining, OMNI_BRIDGE_RING_CAPACITY - g_OmniBridgeReadOffset);
        RtlCopyMemory(Buffer + copied, g_OmniBridgeRing + g_OmniBridgeReadOffset, run);
        g_OmniBridgeReadOffset = (g_OmniBridgeReadOffset + run) % OMNI_BRIDGE_RING_CAPACITY;
        g_OmniBridgeBufferedBytes -= run;
        copied += run;
        remaining -= run;
    }

    g_OmniBridgeDeliveredBytes += copied;
    return copied;
}

static VOID WriteRingLocked(_In_reads_bytes_(ByteCount) const UCHAR* Buffer, _In_ ULONG ByteCount)
{
    ULONG remaining = ByteCount;
    const UCHAR* cursor = Buffer;

    if (remaining > OMNI_BRIDGE_MAX_BUFFERED_BYTES)
    {
        ULONG skipped = remaining - OMNI_BRIDGE_MAX_BUFFERED_BYTES;
        cursor += skipped;
        remaining -= skipped;
        g_OmniBridgeDroppedBytes += skipped;
    }

    if (remaining > OMNI_BRIDGE_MAX_BUFFERED_BYTES - g_OmniBridgeBufferedBytes)
    {
        ULONG dropped = remaining - (OMNI_BRIDGE_MAX_BUFFERED_BYTES - g_OmniBridgeBufferedBytes);
        g_OmniBridgeReadOffset = (g_OmniBridgeReadOffset + dropped) % OMNI_BRIDGE_RING_CAPACITY;
        g_OmniBridgeBufferedBytes -= dropped;
        g_OmniBridgeDroppedBytes += dropped;
    }

    while (remaining > 0)
    {
        ULONG run = min(remaining, OMNI_BRIDGE_RING_CAPACITY - g_OmniBridgeWriteOffset);
        RtlCopyMemory(g_OmniBridgeRing + g_OmniBridgeWriteOffset, cursor, run);
        g_OmniBridgeWriteOffset = (g_OmniBridgeWriteOffset + run) % OMNI_BRIDGE_RING_CAPACITY;
        g_OmniBridgeBufferedBytes += run;
        cursor += run;
        remaining -= run;
    }
}

static ULONG ReadLoopbackRingLocked(_Out_writes_bytes_(ByteCount) PUCHAR Buffer, _In_ ULONG ByteCount)
{
    ULONG copied = 0;
    ULONG remaining = min(ByteCount, g_OmniLoopbackBufferedBytes);

    while (remaining > 0)
    {
        ULONG run = min(remaining, OMNI_LOOPBACK_RING_CAPACITY - g_OmniLoopbackReadOffset);
        RtlCopyMemory(Buffer + copied, g_OmniLoopbackRing + g_OmniLoopbackReadOffset, run);
        g_OmniLoopbackReadOffset = (g_OmniLoopbackReadOffset + run) % OMNI_LOOPBACK_RING_CAPACITY;
        g_OmniLoopbackBufferedBytes -= run;
        copied += run;
        remaining -= run;
    }

    return copied;
}

static VOID WriteLoopbackRingLocked(_In_reads_bytes_(ByteCount) const UCHAR* Buffer, _In_ ULONG ByteCount)
{
    ULONG remaining = ByteCount;
    const UCHAR* cursor = Buffer;

    if (remaining > OMNI_LOOPBACK_RING_CAPACITY)
    {
        ULONG skipped = remaining - OMNI_LOOPBACK_RING_CAPACITY;
        cursor += skipped;
        remaining -= skipped;
    }

    if (remaining > OMNI_LOOPBACK_RING_CAPACITY - g_OmniLoopbackBufferedBytes)
    {
        ULONG dropped = remaining - (OMNI_LOOPBACK_RING_CAPACITY - g_OmniLoopbackBufferedBytes);
        g_OmniLoopbackReadOffset = (g_OmniLoopbackReadOffset + dropped) % OMNI_LOOPBACK_RING_CAPACITY;
        g_OmniLoopbackBufferedBytes -= dropped;
    }

    while (remaining > 0)
    {
        ULONG run = min(remaining, OMNI_LOOPBACK_RING_CAPACITY - g_OmniLoopbackWriteOffset);
        RtlCopyMemory(g_OmniLoopbackRing + g_OmniLoopbackWriteOffset, cursor, run);
        g_OmniLoopbackWriteOffset = (g_OmniLoopbackWriteOffset + run) % OMNI_LOOPBACK_RING_CAPACITY;
        g_OmniLoopbackBufferedBytes += run;
        cursor += run;
        remaining -= run;
    }
}

static NTSTATUS DispatchCreateClose(_In_ PDEVICE_OBJECT DeviceObject, _In_ PIRP Irp)
{
    if (DeviceObject == g_OmniBridgeDevice)
    {
        PIO_STACK_LOCATION stack = IoGetCurrentIrpStackLocation(Irp);
        if (stack->MajorFunction == IRP_MJ_CLOSE)
        {
            KIRQL oldIrql;
            KeAcquireSpinLock(&g_OmniBridgeLock, &oldIrql);
            if (g_OmniBridgeReaderOwner == stack->FileObject)
            {
                g_OmniBridgeReaderOwner = nullptr;
            }
            KeReleaseSpinLock(&g_OmniBridgeLock, oldIrql);
        }
        return CompleteIrp(Irp, STATUS_SUCCESS, 0);
    }

    PDRIVER_DISPATCH original =
        IoGetCurrentIrpStackLocation(Irp)->MajorFunction == IRP_MJ_CREATE
        ? g_OriginalCreate
        : g_OriginalClose;
    return original != nullptr
        ? original(DeviceObject, Irp)
        : CompleteIrp(Irp, STATUS_INVALID_DEVICE_REQUEST, 0);
}

static NTSTATUS DispatchDeviceControl(_In_ PDEVICE_OBJECT DeviceObject, _In_ PIRP Irp)
{
    if (DeviceObject != g_OmniBridgeDevice)
    {
        return g_OriginalDeviceControl != nullptr
            ? g_OriginalDeviceControl(DeviceObject, Irp)
            : CompleteIrp(Irp, STATUS_INVALID_DEVICE_REQUEST, 0);
    }

    PIO_STACK_LOCATION stack = IoGetCurrentIrpStackLocation(Irp);
    ULONG controlCode = stack->Parameters.DeviceIoControl.IoControlCode;
    ULONG outputLength = stack->Parameters.DeviceIoControl.OutputBufferLength;
    PVOID systemBuffer = Irp->AssociatedIrp.SystemBuffer;
    KIRQL oldIrql;

    switch (controlCode)
    {
        case IOCTL_OMNI_BRIDGE_READ_PCM:
        {
            if (outputLength == 0 || systemBuffer == nullptr)
            {
                return CompleteIrp(Irp, STATUS_BUFFER_TOO_SMALL, 0);
            }

            KeAcquireSpinLock(&g_OmniBridgeLock, &oldIrql);
            if (g_OmniBridgeReaderOwner == nullptr)
            {
                g_OmniBridgeReaderOwner = stack->FileObject;
            }
            if (g_OmniBridgeReaderOwner != stack->FileObject)
            {
                KeReleaseSpinLock(&g_OmniBridgeLock, oldIrql);
                return CompleteIrp(Irp, STATUS_ACCESS_DENIED, 0);
            }
            ULONG copied = ReadRingLocked(static_cast<PUCHAR>(systemBuffer), outputLength);
            KeReleaseSpinLock(&g_OmniBridgeLock, oldIrql);
            return CompleteIrp(Irp, STATUS_SUCCESS, copied);
        }
        case IOCTL_OMNI_BRIDGE_QUERY_STATUS:
        {
            if (outputLength < sizeof(OMNI_BRIDGE_STATUS) || systemBuffer == nullptr)
            {
                return CompleteIrp(Irp, STATUS_BUFFER_TOO_SMALL, 0);
            }

            KeAcquireSpinLock(&g_OmniBridgeLock, &oldIrql);
            OMNI_BRIDGE_STATUS status = {};
            status.AbiVersion = OMNI_BRIDGE_ABI_VERSION;
            status.RingCapacityBytes = OMNI_BRIDGE_RING_CAPACITY;
            status.BufferedBytes = g_OmniBridgeBufferedBytes;
            status.MaxBufferedBytes = OMNI_BRIDGE_MAX_BUFFERED_BYTES;
            status.CapturedBytes = g_OmniBridgeCapturedBytes;
            status.DeliveredBytes = g_OmniBridgeDeliveredBytes;
            status.DroppedBytes = g_OmniBridgeDroppedBytes;
            KeReleaseSpinLock(&g_OmniBridgeLock, oldIrql);

            RtlCopyMemory(systemBuffer, &status, sizeof(status));
            return CompleteIrp(Irp, STATUS_SUCCESS, sizeof(status));
        }
        case IOCTL_OMNI_BRIDGE_RESET:
        {
            KeAcquireSpinLock(&g_OmniBridgeLock, &oldIrql);
            if (g_OmniBridgeReaderOwner == nullptr)
            {
                g_OmniBridgeReaderOwner = stack->FileObject;
            }
            if (g_OmniBridgeReaderOwner != stack->FileObject)
            {
                KeReleaseSpinLock(&g_OmniBridgeLock, oldIrql);
                return CompleteIrp(Irp, STATUS_ACCESS_DENIED, 0);
            }
            ResetRingLocked();
            ResetLoopbackRingLocked();
            g_OmniBridgeCapturedBytes = 0;
            g_OmniBridgeDeliveredBytes = 0;
            g_OmniBridgeDroppedBytes = 0;
            KeReleaseSpinLock(&g_OmniBridgeLock, oldIrql);
            return CompleteIrp(Irp, STATUS_SUCCESS, 0);
        }
        default:
            return CompleteIrp(Irp, STATUS_INVALID_DEVICE_REQUEST, 0);
    }
}

NTSTATUS OmniBridgeInitialize(_In_ PDRIVER_OBJECT DriverObject)
{
    UNICODE_STRING deviceName;
    UNICODE_STRING symbolicLinkName;

    KeInitializeSpinLock(&g_OmniBridgeLock);
    g_OmniBridgeReaderOwner = nullptr;
    g_OmniBridgeRing = static_cast<PUCHAR>(
        ExAllocatePool2(POOL_FLAG_NON_PAGED, OMNI_BRIDGE_RING_CAPACITY, OMNI_BRIDGE_POOL_TAG));
    if (g_OmniBridgeRing == nullptr)
    {
        return STATUS_INSUFFICIENT_RESOURCES;
    }

    g_OmniLoopbackRing = static_cast<PUCHAR>(
        ExAllocatePool2(POOL_FLAG_NON_PAGED, OMNI_LOOPBACK_RING_CAPACITY, OMNI_BRIDGE_POOL_TAG));
    if (g_OmniLoopbackRing == nullptr)
    {
        OmniBridgeCleanup();
        return STATUS_INSUFFICIENT_RESOURCES;
    }

    RtlInitUnicodeString(&deviceName, OMNI_BRIDGE_KERNEL_DEVICE_NAME);
    NTSTATUS status = IoCreateDevice(
        DriverObject,
        0,
        &deviceName,
        FILE_DEVICE_OMNI_TRANSLATE,
        FILE_DEVICE_SECURE_OPEN,
        FALSE,
        &g_OmniBridgeDevice);
    if (!NT_SUCCESS(status))
    {
        OmniBridgeCleanup();
        return status;
    }

    RtlInitUnicodeString(&symbolicLinkName, OMNI_BRIDGE_DOS_DEVICE_NAME);
    status = IoCreateSymbolicLink(&symbolicLinkName, &deviceName);
    if (!NT_SUCCESS(status))
    {
        OmniBridgeCleanup();
        return status;
    }

    g_OmniBridgeDevice->Flags |= DO_BUFFERED_IO;
    g_OmniBridgeDevice->Flags &= ~DO_DEVICE_INITIALIZING;
    g_OriginalCreate = DriverObject->MajorFunction[IRP_MJ_CREATE];
    g_OriginalClose = DriverObject->MajorFunction[IRP_MJ_CLOSE];
    g_OriginalDeviceControl = DriverObject->MajorFunction[IRP_MJ_DEVICE_CONTROL];
    DriverObject->MajorFunction[IRP_MJ_CREATE] = DispatchCreateClose;
    DriverObject->MajorFunction[IRP_MJ_CLOSE] = DispatchCreateClose;
    DriverObject->MajorFunction[IRP_MJ_DEVICE_CONTROL] = DispatchDeviceControl;
    return STATUS_SUCCESS;
}

VOID OmniBridgeCleanup()
{
    UNICODE_STRING symbolicLinkName;

    RtlInitUnicodeString(&symbolicLinkName, OMNI_BRIDGE_DOS_DEVICE_NAME);
    IoDeleteSymbolicLink(&symbolicLinkName);
    g_OmniBridgeReaderOwner = nullptr;

    if (g_OmniBridgeDevice != nullptr)
    {
        IoDeleteDevice(g_OmniBridgeDevice);
        g_OmniBridgeDevice = nullptr;
    }

    if (g_OmniBridgeRing != nullptr)
    {
        ExFreePoolWithTag(g_OmniBridgeRing, OMNI_BRIDGE_POOL_TAG);
        g_OmniBridgeRing = nullptr;
    }

    if (g_OmniLoopbackRing != nullptr)
    {
        ExFreePoolWithTag(g_OmniLoopbackRing, OMNI_BRIDGE_POOL_TAG);
        g_OmniLoopbackRing = nullptr;
    }
}

VOID OmniBridgeWriteRenderPcm(_In_reads_bytes_(ByteCount) const UCHAR* Buffer, _In_ ULONG ByteCount)
{
    if (g_OmniBridgeRing == nullptr || Buffer == nullptr || ByteCount == 0)
    {
        return;
    }

    KIRQL oldIrql;
    KeAcquireSpinLock(&g_OmniBridgeLock, &oldIrql);
    g_OmniBridgeCapturedBytes += ByteCount;
    WriteRingLocked(Buffer, ByteCount);
    WriteLoopbackRingLocked(Buffer, ByteCount);
    KeReleaseSpinLock(&g_OmniBridgeLock, oldIrql);
}

VOID OmniBridgeReadLoopbackPcm(_Out_writes_bytes_(ByteCount) UCHAR* Buffer, _In_ ULONG ByteCount)
{
    if (Buffer == nullptr || ByteCount == 0)
    {
        return;
    }

    ULONG copied = 0;
    if (g_OmniLoopbackRing != nullptr)
    {
        KIRQL oldIrql;
        KeAcquireSpinLock(&g_OmniBridgeLock, &oldIrql);
        copied = ReadLoopbackRingLocked(Buffer, ByteCount);
        KeReleaseSpinLock(&g_OmniBridgeLock, oldIrql);
    }

    if (copied < ByteCount)
    {
        RtlZeroMemory(Buffer + copied, ByteCount - copied);
    }
}

VOID OmniBridgeResetLoopbackPcm()
{
    if (g_OmniLoopbackRing == nullptr)
    {
        return;
    }

    KIRQL oldIrql;
    KeAcquireSpinLock(&g_OmniBridgeLock, &oldIrql);
    ResetLoopbackRingLocked();
    KeReleaseSpinLock(&g_OmniBridgeLock, oldIrql);
}
