#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <new>
#include <optional>
#include <utility>

#include "omni_webrtc_aec3.h"
#include "api/audio/audio_processing.h"
#include "api/audio/audio_processing_statistics.h"
#include "api/audio/builtin_audio_processing_builder.h"
#include "api/audio/echo_detector_creator.h"
#include "api/environment/environment_factory.h"

namespace {

constexpr int kSampleRateHz = 48000;
constexpr std::size_t kChannels = 2;
constexpr std::size_t kFramesPer10Ms = 480;
constexpr std::size_t kSamplesPer10Ms = kFramesPer10Ms * kChannels;

struct OmniWebRtcAec3 {
  webrtc::scoped_refptr<webrtc::AudioProcessing> apm;
  webrtc::StreamConfig stream_config{kSampleRateHz, kChannels};
  std::array<std::array<float, kFramesPer10Ms>, kChannels> input_channels{};
  std::array<std::array<float, kFramesPer10Ms>, kChannels> output_channels{};
  std::uint64_t render_frames = 0;
  std::uint64_t capture_frames = 0;
  std::uint64_t reset_count = 0;
  std::uint64_t double_talk_frames = 0;
  double last_render_rms = 0.0;
};

double InterleavedRms(const float* samples, std::size_t sample_count) {
  double energy = 0.0;
  for (std::size_t index = 0; index < sample_count; ++index) {
    const double sample = samples[index];
    energy += sample * sample;
  }
  return sample_count == 0 ? 0.0 : std::sqrt(energy / sample_count);
}

void Deinterleave(const float* interleaved, OmniWebRtcAec3& handle) {
  for (std::size_t frame = 0; frame < kFramesPer10Ms; ++frame) {
    for (std::size_t channel = 0; channel < kChannels; ++channel) {
      handle.input_channels[channel][frame] =
          interleaved[frame * kChannels + channel];
    }
  }
}

void Interleave(const OmniWebRtcAec3& handle, float* interleaved) {
  for (std::size_t frame = 0; frame < kFramesPer10Ms; ++frame) {
    for (std::size_t channel = 0; channel < kChannels; ++channel) {
      interleaved[frame * kChannels + channel] =
          handle.output_channels[channel][frame];
    }
  }
}

std::array<const float*, kChannels> ConstChannelPointers(
    const OmniWebRtcAec3& handle) {
  return {handle.input_channels[0].data(), handle.input_channels[1].data()};
}

std::array<float*, kChannels> MutableChannelPointers(OmniWebRtcAec3& handle) {
  return {handle.output_channels[0].data(), handle.output_channels[1].data()};
}

double OptionalDouble(const std::optional<double>& value) {
  return value.value_or(std::numeric_limits<double>::quiet_NaN());
}

std::int32_t OptionalInt(const std::optional<std::int32_t>& value) {
  return value.value_or(-1);
}

}  // namespace

extern "C" {

void* omni_webrtc_aec3_create() {
  webrtc::AudioProcessing::Config config;
  config.pipeline.maximum_internal_processing_rate = kSampleRateHz;
  config.pipeline.multi_channel_render = true;
  config.pipeline.multi_channel_capture = true;
  config.echo_canceller.enabled = true;
  config.echo_canceller.export_linear_aec_output = false;

  webrtc::BuiltinAudioProcessingBuilder builder(config);
  builder.SetEchoDetector(webrtc::CreateEchoDetector());
  auto apm = builder.Build(webrtc::CreateEnvironment());
  if (!apm || apm->Initialize() != webrtc::AudioProcessing::kNoError) {
    return nullptr;
  }
  auto* handle = new (std::nothrow) OmniWebRtcAec3;
  if (handle == nullptr) {
    return nullptr;
  }
  handle->apm = std::move(apm);
  return handle;
}

void omni_webrtc_aec3_destroy(void* opaque) {
  delete static_cast<OmniWebRtcAec3*>(opaque);
}

int omni_webrtc_aec3_push_render_10ms(void* opaque,
                                      const float* interleaved,
                                      std::size_t sample_count) {
  auto* handle = static_cast<OmniWebRtcAec3*>(opaque);
  if (handle == nullptr || interleaved == nullptr) {
    return -1;
  }
  if (sample_count != kSamplesPer10Ms) {
    return -2;
  }
  handle->last_render_rms = InterleavedRms(interleaved, sample_count);
  Deinterleave(interleaved, *handle);
  const auto source = ConstChannelPointers(*handle);
  auto destination = MutableChannelPointers(*handle);
  const int result = handle->apm->ProcessReverseStream(
      source.data(), handle->stream_config, handle->stream_config,
      destination.data());
  if (result == webrtc::AudioProcessing::kNoError) {
    ++handle->render_frames;
  }
  return result;
}

int omni_webrtc_aec3_process_capture_10ms(void* opaque,
                                          float* interleaved,
                                          std::size_t sample_count,
                                          std::int32_t delay_ms) {
  auto* handle = static_cast<OmniWebRtcAec3*>(opaque);
  if (handle == nullptr || interleaved == nullptr) {
    return -1;
  }
  if (sample_count != kSamplesPer10Ms) {
    return -2;
  }
  const double capture_rms = InterleavedRms(interleaved, sample_count);
  const int bounded_delay = std::clamp<int>(delay_ms, 0, 1000);
  const int delay_result = handle->apm->set_stream_delay_ms(bounded_delay);
  // APM currently truncates stream-delay hints above 500 ms and returns the
  // documented non-fatal warning. Keep processing: AEC3's internal delay
  // estimator still receives the render/capture streams, and the 0-1000 ms
  // fixture must validate frame preservation rather than turn a warning into
  // a dropped capture frame.
  if (delay_result != webrtc::AudioProcessing::kNoError &&
      delay_result != webrtc::AudioProcessing::kBadStreamParameterWarning) {
    return delay_result;
  }
  Deinterleave(interleaved, *handle);
  const auto source = ConstChannelPointers(*handle);
  auto destination = MutableChannelPointers(*handle);
  const int result = handle->apm->ProcessStream(
      source.data(), handle->stream_config, handle->stream_config,
      destination.data());
  if (result == webrtc::AudioProcessing::kNoError) {
    Interleave(*handle, interleaved);
    const double output_rms = InterleavedRms(interleaved, sample_count);
    // WebRTC's public APM statistics do not expose a native double-talk
    // counter. Count the conservative diagnostic case where far-end render is
    // active and substantial post-AEC capture energy remains. This metric is
    // telemetry only; it never controls PCM or ASR forwarding.
    if (handle->last_render_rms >= 0.001 && capture_rms >= 0.001 &&
        output_rms >= 0.001 && output_rms >= capture_rms * 0.2) {
      ++handle->double_talk_frames;
    }
    ++handle->capture_frames;
  }
  return result;
}

int omni_webrtc_aec3_reset(void* opaque) {
  auto* handle = static_cast<OmniWebRtcAec3*>(opaque);
  if (handle == nullptr) {
    return -1;
  }
  const int result = handle->apm->Initialize();
  if (result == webrtc::AudioProcessing::kNoError) {
    ++handle->reset_count;
  }
  return result;
}

int omni_webrtc_aec3_get_stats(void* opaque, OmniWebRtcAec3Stats* output) {
  auto* handle = static_cast<OmniWebRtcAec3*>(opaque);
  if (handle == nullptr || output == nullptr) {
    return -1;
  }
  const webrtc::AudioProcessingStats stats = handle->apm->GetStatistics();
  output->erle_db = OptionalDouble(stats.echo_return_loss_enhancement);
  output->residual_echo_likelihood = OptionalDouble(stats.residual_echo_likelihood);
  output->delay_ms = OptionalInt(stats.delay_ms);
  output->render_frames = handle->render_frames;
  output->capture_frames = handle->capture_frames;
  output->reset_count = handle->reset_count;
  output->double_talk_frames = handle->double_talk_frames;
  return 0;
}

}  // extern "C"
