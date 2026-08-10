#pragma once

#include <cstddef>
#include <cstdint>

extern "C" {

struct OmniWebRtcAec3Stats {
  double erle_db;
  double residual_echo_likelihood;
  std::int32_t delay_ms;
  std::uint64_t render_frames;
  std::uint64_t capture_frames;
  std::uint64_t reset_count;
  std::uint64_t double_talk_frames;
};

void* omni_webrtc_aec3_create();
void omni_webrtc_aec3_destroy(void* opaque);
int omni_webrtc_aec3_push_render_10ms(void* opaque,
                                      const float* interleaved,
                                      std::size_t sample_count);
int omni_webrtc_aec3_process_capture_10ms(void* opaque,
                                          float* interleaved,
                                          std::size_t sample_count,
                                          std::int32_t delay_ms);
int omni_webrtc_aec3_reset(void* opaque);
int omni_webrtc_aec3_get_stats(void* opaque, OmniWebRtcAec3Stats* output);

}  // extern "C"
