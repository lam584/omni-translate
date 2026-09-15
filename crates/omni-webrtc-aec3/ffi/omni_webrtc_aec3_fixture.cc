#include "omni_webrtc_aec3.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <vector>

namespace {

constexpr std::size_t kChannels = 2;
constexpr std::size_t kFramesPer10Ms = 480;
constexpr std::size_t kSamplesPer10Ms = kFramesPer10Ms * kChannels;
constexpr std::size_t kTotalFrames = 600;
constexpr std::size_t kDelayFrames = 5;
constexpr std::size_t kAnalysisStart = 250;
constexpr double kMinimumErleDb = 15.0;

std::array<float, kSamplesPer10Ms> NoiseFrame(std::uint32_t& state) {
  std::array<float, kSamplesPer10Ms> frame{};
  for (float& sample : frame) {
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    sample = static_cast<float>(state) /
                 static_cast<float>(UINT32_MAX) * 0.5f -
             0.25f;
  }
  return frame;
}

double Energy(const std::array<float, kSamplesPer10Ms>& frame) {
  double energy = 0.0;
  for (float sample : frame) {
    energy += static_cast<double>(sample) * static_cast<double>(sample);
  }
  return energy;
}

}  // namespace

int main() {
  void* aec = omni_webrtc_aec3_create();
  if (aec == nullptr) {
    std::fprintf(stderr, "AEC3 fixture: constructor returned null\n");
    return 1;
  }

  std::vector<std::array<float, kSamplesPer10Ms>> history;
  history.reserve(kTotalFrames);
  std::uint32_t state = 0x6d2b79f5u;
  double input_energy = 0.0;
  double output_energy = 0.0;
  for (std::size_t frame_index = 0; frame_index < kTotalFrames;
       ++frame_index) {
    auto render = NoiseFrame(state);
    if (omni_webrtc_aec3_push_render_10ms(
            aec, render.data(), render.size()) != 0) {
      std::fprintf(stderr, "AEC3 fixture: render failed at frame %zu\n",
                   frame_index);
      omni_webrtc_aec3_destroy(aec);
      return 2;
    }
    history.push_back(render);

    std::array<float, kSamplesPer10Ms> capture{};
    if (frame_index >= kDelayFrames) {
      const auto& delayed = history[frame_index - kDelayFrames];
      std::transform(delayed.begin(), delayed.end(), capture.begin(),
                     [](float sample) { return sample * 0.65f; });
    }
    if (frame_index >= kAnalysisStart) {
      input_energy += Energy(capture);
    }
    if (omni_webrtc_aec3_process_capture_10ms(
            aec, capture.data(), capture.size(),
            static_cast<std::int32_t>(kDelayFrames * 10)) != 0) {
      std::fprintf(stderr, "AEC3 fixture: capture failed at frame %zu\n",
                   frame_index);
      omni_webrtc_aec3_destroy(aec);
      return 3;
    }
    if (frame_index >= kAnalysisStart) {
      output_energy += Energy(capture);
    }
  }

  const double erle_db =
      10.0 * std::log10(input_energy / std::max(output_energy, 1.0e-30));
  OmniWebRtcAec3Stats stats{};
  const int stats_result = omni_webrtc_aec3_get_stats(aec, &stats);
  if (stats_result != 0 || stats.render_frames != kTotalFrames ||
      stats.capture_frames != kTotalFrames) {
    std::fprintf(stderr,
                 "AEC3 fixture: invalid counters render=%llu capture=%llu\n",
                 static_cast<unsigned long long>(stats.render_frames),
                 static_cast<unsigned long long>(stats.capture_frames));
    omni_webrtc_aec3_destroy(aec);
    return 4;
  }
  if (!std::isfinite(erle_db) || erle_db < kMinimumErleDb) {
    std::fprintf(stderr,
                 "AEC3 fixture: ERLE %.2f dB is below required %.2f dB\n",
                 erle_db, kMinimumErleDb);
    omni_webrtc_aec3_destroy(aec);
    return 5;
  }
  if (!std::isfinite(stats.residual_echo_likelihood) ||
      stats.residual_echo_likelihood < 0.0 ||
      stats.residual_echo_likelihood > 1.0) {
    std::fprintf(stderr,
                 "AEC3 fixture: invalid residual echo likelihood %.6f\n",
                 stats.residual_echo_likelihood);
    omni_webrtc_aec3_destroy(aec);
    return 6;
  }
  if (stats.reset_count != 0) {
    std::fprintf(stderr,
                 "AEC3 fixture: continuous 600-frame stream reset %llu times\n",
                 static_cast<unsigned long long>(stats.reset_count));
    omni_webrtc_aec3_destroy(aec);
    return 7;
  }
  constexpr std::uint64_t kExplicitResetCalls = 3;
  const int reset_result = omni_webrtc_aec3_reset(aec);
  OmniWebRtcAec3Stats after_reset{};
  const int after_reset_result =
      omni_webrtc_aec3_get_stats(aec, &after_reset);
  if (reset_result != 0 || after_reset_result != 0 ||
      after_reset.reset_count != 1 ||
      after_reset.render_frames != kTotalFrames ||
      after_reset.capture_frames != kTotalFrames) {
    std::fprintf(
        stderr,
        "AEC3 fixture: explicit reset 1 failed code=%d stats=%d reset=%llu render=%llu capture=%llu\n",
        reset_result, after_reset_result,
        static_cast<unsigned long long>(after_reset.reset_count),
        static_cast<unsigned long long>(after_reset.render_frames),
        static_cast<unsigned long long>(after_reset.capture_frames));
    omni_webrtc_aec3_destroy(aec);
    return 8;
  }
  for (std::uint64_t reset_index = 2; reset_index <= kExplicitResetCalls;
       ++reset_index) {
    const int subsequent_reset_result = omni_webrtc_aec3_reset(aec);
    const int subsequent_stats_result =
        omni_webrtc_aec3_get_stats(aec, &after_reset);
    if (subsequent_reset_result != 0 || subsequent_stats_result != 0 ||
        after_reset.reset_count != reset_index ||
        after_reset.render_frames != kTotalFrames ||
        after_reset.capture_frames != kTotalFrames) {
      std::fprintf(
          stderr,
          "AEC3 fixture: explicit reset %llu failed code=%d stats=%d reset=%llu render=%llu capture=%llu\n",
          static_cast<unsigned long long>(reset_index), subsequent_reset_result,
          subsequent_stats_result,
          static_cast<unsigned long long>(after_reset.reset_count),
          static_cast<unsigned long long>(after_reset.render_frames),
          static_cast<unsigned long long>(after_reset.capture_frames));
      omni_webrtc_aec3_destroy(aec);
      return 8;
    }
  }
  std::printf("AEC3 fixture: ERLE %.2f dB, residual=%.6f, render=%llu, capture=%llu\n",
              erle_db, stats.residual_echo_likelihood,
              static_cast<unsigned long long>(stats.render_frames),
              static_cast<unsigned long long>(stats.capture_frames));
  omni_webrtc_aec3_destroy(aec);
  return 0;
}
