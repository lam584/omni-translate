// Native C++ smoke tests for the Omni ring buffer core.
// Compile with any standard Windows C++ toolchain (MSVC cl.exe / clang++):
//   cl /std:c++17 /EHsc /I..\include omni_ring_core_test.cpp /Fe:omni_ring_core_test.exe
//   .\omni_ring_core_test.exe
// No WDK, no kernel headers, no administrator privileges required.

#include <cassert>
#include <cstdio>
#include <cstring>
#include <vector>

#include "omni_ring_core.h"

using omni::ring::RingBuffer;

static int testsPassed = 0;
static int testsFailed = 0;

#define ASSERT_EQ(actual, expected) \
    do { \
        auto a_ = (actual); auto e_ = (expected); \
        if (a_ != e_) { \
            std::printf("  FAIL: %s == %llu, expected %llu (line %d)\n", \
                #actual, (unsigned long long)a_, (unsigned long long)e_, __LINE__); \
            ++testsFailed; return; \
        } \
    } while (0)

#define ASSERT_TRUE(cond) \
    do { if (!(cond)) { std::printf("  FAIL: %s (line %d)\n", #cond, __LINE__); ++testsFailed; return; } } while (0)

#define RUN_TEST(fn) \
    do { std::printf("[TEST] %s\n", #fn); fn(); ++testsPassed; } while (0)

// --- Test: empty buffer read and reset ---
static void test_empty_read_and_reset() {
    std::vector<uint8_t> storage(1024, 0);
    RingBuffer ring;
    ring.Initialize(storage.data(), 1024, 512);

    uint8_t out[64];
    ASSERT_EQ(ring.Read(out, 64), 0u);
    ASSERT_EQ(ring.bufferedBytes(), 0u);
    ASSERT_EQ(ring.deliveredBytes(), 0u);

    ring.Write(reinterpret_cast<const uint8_t*>("hello"), 5);
    ASSERT_EQ(ring.bufferedBytes(), 5u);
    ring.Reset();
    ASSERT_EQ(ring.bufferedBytes(), 0u);
    ASSERT_EQ(ring.readOffset(), 0u);
    ASSERT_EQ(ring.writeOffset(), 0u);
    // Counters survive Reset.
    ASSERT_EQ(ring.capturedBytes(), 0u);
}

// --- Test: write/read order preserved ---
static void test_write_read_order() {
    std::vector<uint8_t> storage(1024, 0);
    RingBuffer ring;
    ring.Initialize(storage.data(), 1024, 512);

    const uint8_t data[] = {1, 2, 3, 4, 5, 6, 7, 8};
    ring.Write(data, 8);
    ASSERT_EQ(ring.bufferedBytes(), 8u);

    uint8_t out[8] = {};
    ASSERT_EQ(ring.Read(out, 8), 8u);
    ASSERT_TRUE(std::memcmp(out, data, 8) == 0);
    ASSERT_EQ(ring.bufferedBytes(), 0u);
    ASSERT_EQ(ring.deliveredBytes(), 8u);
}

// --- Test: wrap-around across tail ---
static void test_wraparound() {
    const uint32_t capacity = 16;
    std::vector<uint8_t> storage(capacity, 0);
    RingBuffer ring;
    ring.Initialize(storage.data(), capacity, 16);

    // Fill 12 bytes, read 12, then write 8 more (wraps around).
    uint8_t fill[12];
    std::memset(fill, 0xAA, 12);
    ring.Write(fill, 12);
    uint8_t drain[12];
    ASSERT_EQ(ring.Read(drain, 12), 12u);

    // writeOffset is now 12. Writing 8 bytes wraps: 4 at tail + 4 at head.
    uint8_t wrap[8] = {10, 20, 30, 40, 50, 60, 70, 80};
    ring.Write(wrap, 8);
    ASSERT_EQ(ring.bufferedBytes(), 8u);

    uint8_t out[8] = {};
    ASSERT_EQ(ring.Read(out, 8), 8u);
    ASSERT_TRUE(std::memcmp(out, wrap, 8) == 0);
}

// --- Test: overwrite keeps only newest data ---
static void test_overwrite_keeps_newest() {
    const uint32_t maxBuffered = 8;
    std::vector<uint8_t> storage(64, 0);
    RingBuffer ring;
    ring.Initialize(storage.data(), 64, maxBuffered);

    // Write 12 bytes when max is 8: only the last 8 survive.
    uint8_t data[12] = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12};
    ring.Write(data, 12);
    ASSERT_EQ(ring.bufferedBytes(), 8u);
    ASSERT_EQ(ring.droppedBytes(), 4u);

    uint8_t out[8] = {};
    ASSERT_EQ(ring.Read(out, 8), 8u);
    // Should contain bytes 5..12 (the newest 8).
    ASSERT_EQ(out[0], 5u);
    ASSERT_EQ(out[7], 12u);
}

// --- Test: counters correct on overwrite of buffered data ---
static void test_overwrite_counters() {
    const uint32_t maxBuffered = 8;
    std::vector<uint8_t> storage(64, 0);
    RingBuffer ring;
    ring.Initialize(storage.data(), 64, maxBuffered);

    // Write 6 bytes (fits within max 8).
    uint8_t first[6] = {1, 2, 3, 4, 5, 6};
    ring.Write(first, 6);
    ring.RecordCapture(6);
    ASSERT_EQ(ring.bufferedBytes(), 6u);
    ASSERT_EQ(ring.capturedBytes(), 6u);
    ASSERT_EQ(ring.droppedBytes(), 0u);

    // Write 6 more: only 2 fit, so 4 oldest are dropped.
    uint8_t second[6] = {7, 8, 9, 10, 11, 12};
    ring.Write(second, 6);
    ring.RecordCapture(6);
    ASSERT_EQ(ring.bufferedBytes(), 8u);
    ASSERT_EQ(ring.droppedBytes(), 4u);
    ASSERT_EQ(ring.capturedBytes(), 12u);

    // Read all 8: should be bytes 5..12 (oldest 4 of 12 dropped).
    uint8_t out[8] = {};
    ASSERT_EQ(ring.Read(out, 8), 8u);
    ASSERT_EQ(out[0], 5u);
    ASSERT_EQ(out[7], 12u);
    ASSERT_EQ(ring.deliveredBytes(), 8u);
}

// --- Test: event-mode startup pre-roll fits without dropping source audio ---
static void test_startup_preroll_fits_default_budget() {
    const uint32_t frameBytes = 3840; // 20 ms, 48 kHz stereo PCM16.
    const uint32_t prerollFrames = 10; // 200 ms startup burst.
    ASSERT_EQ(RingBuffer::kDefaultMaxBuffered, 192000u);

    std::vector<uint8_t> storage(RingBuffer::kDefaultMaxBuffered, 0);
    RingBuffer ring;
    ring.Initialize(
        storage.data(),
        static_cast<uint32_t>(storage.size()),
        RingBuffer::kDefaultMaxBuffered);

    std::vector<uint8_t> expected(frameBytes * prerollFrames);
    for (uint32_t index = 0; index < expected.size(); ++index) {
        expected[index] = static_cast<uint8_t>(index % 251);
    }
    for (uint32_t frame = 0; frame < prerollFrames; ++frame) {
        const uint8_t* payload = expected.data() + frame * frameBytes;
        ring.Write(payload, frameBytes);
        ring.RecordCapture(frameBytes);
    }

    ASSERT_EQ(ring.bufferedBytes(), frameBytes * prerollFrames);
    ASSERT_EQ(ring.droppedBytes(), 0u);
    std::vector<uint8_t> actual(expected.size(), 0);
    ASSERT_EQ(ring.Read(actual.data(), static_cast<uint32_t>(actual.size())), expected.size());
    ASSERT_TRUE(actual == expected);
    ASSERT_EQ(ring.capturedBytes(), ring.deliveredBytes());
}

// --- Test: loopback ring and bridge ring state isolation ---
static void test_ring_isolation() {
    std::vector<uint8_t> storageA(256, 0);
    std::vector<uint8_t> storageB(256, 0);
    RingBuffer bridgeRing;
    RingBuffer loopbackRing;
    bridgeRing.Initialize(storageA.data(), 256, 128);
    loopbackRing.Initialize(storageB.data(), 128, 128);

    const uint8_t data[10] = {0, 1, 2, 3, 4, 5, 6, 7, 8, 9};
    bridgeRing.Write(data, 10);
    loopbackRing.Write(data, 10);

    // Reset only the loopback ring.
    loopbackRing.Reset();
    ASSERT_EQ(loopbackRing.bufferedBytes(), 0u);
    ASSERT_EQ(bridgeRing.bufferedBytes(), 10u);

    // Bridge ring still readable.
    uint8_t out[10] = {};
    ASSERT_EQ(bridgeRing.Read(out, 10), 10u);
    ASSERT_TRUE(std::memcmp(out, data, 10) == 0);

    // Loopback ring empty.
    ASSERT_EQ(loopbackRing.Read(out, 10), 0u);
}

// --- Test: ResetAll zeroes counters ---
static void test_reset_all() {
    std::vector<uint8_t> storage(64, 0);
    RingBuffer ring;
    ring.Initialize(storage.data(), 64, 32);

    uint8_t data[20];
    std::memset(data, 0xFF, 20);
    ring.Write(data, 20);
    ring.RecordCapture(20);
    uint8_t out[10];
    ring.Read(out, 10);

    ASSERT_TRUE(ring.capturedBytes() > 0);
    ASSERT_TRUE(ring.deliveredBytes() > 0);

    ring.ResetAll();
    ASSERT_EQ(ring.bufferedBytes(), 0u);
    ASSERT_EQ(ring.capturedBytes(), 0u);
    ASSERT_EQ(ring.deliveredBytes(), 0u);
    ASSERT_EQ(ring.droppedBytes(), 0u);
}

// Mirrors the generation boundary imposed by BEGIN/WRITE/END_MIC_SESSION while
// exercising the same bounded RingBuffer core used by the driver tests.
static void test_virtual_mic_generation_boundary() {
    std::vector<uint8_t> storage(32, 0);
    RingBuffer ring;
    ring.Initialize(storage.data(), 32, 16);
    uint64_t generation = 1;
    bool active = true;
    uint8_t first[12];
    std::memset(first, 0x11, sizeof(first));
    ring.Write(first, sizeof(first));
    ring.RecordCapture(sizeof(first));

    // A new session generation must not expose stale PCM to the next capture
    // client, and writes are accepted only while that generation is active.
    generation = 2;
    ring.ResetAll();
    ASSERT_EQ(generation, 2u);
    ASSERT_EQ(ring.bufferedBytes(), 0u);
    active = false;
    ASSERT_TRUE(!active);

    active = true;
    uint8_t second[20];
    std::memset(second, 0x22, sizeof(second));
    if (active) {
        ring.Write(second, sizeof(second));
        ring.RecordCapture(sizeof(second));
    }
    ASSERT_EQ(ring.bufferedBytes(), 16u);
    ASSERT_EQ(ring.droppedBytes(), 4u);
    ASSERT_EQ(ring.capturedBytes(), 20u);
}

int main() {
    std::printf("=== Omni Ring Core Smoke Tests ===\n");
    RUN_TEST(test_empty_read_and_reset);
    RUN_TEST(test_write_read_order);
    RUN_TEST(test_wraparound);
    RUN_TEST(test_overwrite_keeps_newest);
    RUN_TEST(test_overwrite_counters);
    RUN_TEST(test_startup_preroll_fits_default_budget);
    RUN_TEST(test_ring_isolation);
    RUN_TEST(test_reset_all);
    RUN_TEST(test_virtual_mic_generation_boundary);

    std::printf("\n=== Results: %d passed, %d failed ===\n", testsPassed, testsFailed);
    return testsFailed > 0 ? 1 : 0;
}
