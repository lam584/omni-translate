#pragma once

// Portable ring-buffer core extracted from omni_bridge_ring.cpp.
// This header has NO kernel dependencies (no ntddk.h, no WDK types) and can be
// compiled by any standard C++ toolchain for user-mode smoke tests.
// The kernel layer (omni_bridge_ring.cpp) wraps these functions with spinlocks,
// pool allocation, IRP dispatch and IOCTL adaptation.

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <algorithm>

namespace omni::ring {

/// Fixed-capacity ring buffer with overwrite-oldest semantics.
/// Thread-safety is the caller's responsibility (kernel: KSPIN_LOCK).
class RingBuffer {
public:
    static constexpr uint32_t kDefaultCapacity = 4 * 1024 * 1024;
    static constexpr uint32_t kDefaultMaxBuffered = 19200;

    RingBuffer() = default;

    /// Initializes the ring with an externally-owned storage buffer.
    /// @param storage  Pre-allocated buffer of at least `capacity` bytes.
    /// @param capacity Total ring capacity in bytes.
    /// @param maxBuffered Maximum bytes allowed to remain buffered before overwrite.
    void Initialize(uint8_t* storage, uint32_t capacity, uint32_t maxBuffered) {
        storage_ = storage;
        capacity_ = capacity;
        maxBuffered_ = maxBuffered;
        readOffset_ = 0;
        writeOffset_ = 0;
        bufferedBytes_ = 0;
        capturedBytes_ = 0;
        deliveredBytes_ = 0;
        droppedBytes_ = 0;
    }

    /// Resets offsets and buffered count. Does NOT zero counters.
    void Reset() {
        readOffset_ = 0;
        writeOffset_ = 0;
        bufferedBytes_ = 0;
    }

    /// Full reset including all counters.
    void ResetAll() {
        Reset();
        capturedBytes_ = 0;
        deliveredBytes_ = 0;
        droppedBytes_ = 0;
    }

    /// Writes data into the ring. If data exceeds maxBuffered, only the
    /// trailing maxBuffered bytes are kept (oldest are dropped).
    /// If the ring already has buffered data, oldest buffered data is
    /// overwritten to make room.
    void Write(const uint8_t* buffer, uint32_t byteCount) {
        const uint8_t* cursor = buffer;
        uint32_t remaining = byteCount;

        // If a single write exceeds max buffered, skip the leading excess.
        if (remaining > maxBuffered_) {
            uint32_t skipped = remaining - maxBuffered_;
            cursor += skipped;
            remaining -= skipped;
            droppedBytes_ += skipped;
        }

        // Drop oldest buffered data to make room.
        if (remaining > maxBuffered_ - bufferedBytes_) {
            uint32_t dropped = remaining - (maxBuffered_ - bufferedBytes_);
            readOffset_ = (readOffset_ + dropped) % capacity_;
            bufferedBytes_ -= dropped;
            droppedBytes_ += dropped;
        }

        // Copy data into the ring, wrapping at the tail.
        while (remaining > 0) {
            uint32_t run = std::min(remaining, capacity_ - writeOffset_);
            std::memcpy(storage_ + writeOffset_, cursor, run);
            writeOffset_ = (writeOffset_ + run) % capacity_;
            bufferedBytes_ += run;
            cursor += run;
            remaining -= run;
        }
    }

    /// Reads up to byteCount bytes from the ring into `buffer`.
    /// Returns the number of bytes actually copied.
    uint32_t Read(uint8_t* buffer, uint32_t byteCount) {
        uint32_t copied = 0;
        uint32_t remaining = std::min(byteCount, bufferedBytes_);

        while (remaining > 0) {
            uint32_t run = std::min(remaining, capacity_ - readOffset_);
            std::memcpy(buffer + copied, storage_ + readOffset_, run);
            readOffset_ = (readOffset_ + run) % capacity_;
            bufferedBytes_ -= run;
            copied += run;
            remaining -= run;
        }

        deliveredBytes_ += copied;
        return copied;
    }

    /// Records that byteCount bytes were captured from the audio engine.
    void RecordCapture(uint32_t byteCount) { capturedBytes_ += byteCount; }

    // --- Accessors ---
    uint32_t bufferedBytes() const { return bufferedBytes_; }
    uint32_t readOffset() const { return readOffset_; }
    uint32_t writeOffset() const { return writeOffset_; }
    uint64_t capturedBytes() const { return capturedBytes_; }
    uint64_t deliveredBytes() const { return deliveredBytes_; }
    uint64_t droppedBytes() const { return droppedBytes_; }
    uint32_t capacity() const { return capacity_; }
    uint32_t maxBuffered() const { return maxBuffered_; }

private:
    uint8_t* storage_ = nullptr;
    uint32_t capacity_ = 0;
    uint32_t maxBuffered_ = 0;
    uint32_t readOffset_ = 0;
    uint32_t writeOffset_ = 0;
    uint32_t bufferedBytes_ = 0;
    uint64_t capturedBytes_ = 0;
    uint64_t deliveredBytes_ = 0;
    uint64_t droppedBytes_ = 0;
};

} // namespace omni::ring
