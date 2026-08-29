/*
 * Copyright (c) 2016-2017 The WebRTC project authors.
 * All Rights Reserved.
 *
 * Use of this source code is governed by a BSD-style license. This file keeps
 * the residual echo detector math from WebRTC commit
 * aa217206b9ce8b929dc56d112d670a5931ef8cc1 in one translation unit because
 * the pinned vcpkg archive installs echo_detector_creator.h but omits the
 * CreateEchoDetector implementation from webrtc.lib.
 */

#include "api/audio/echo_detector_creator.h"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <numeric>
#include <optional>
#include <vector>

#include "api/array_view.h"
#include "api/audio/audio_processing.h"
#include "api/make_ref_counted.h"

namespace webrtc {
namespace {

constexpr float kAdaptationAlpha = 0.001f;
constexpr float kMovingMaxDecayFactor = 0.99f;
constexpr std::size_t kLookbackFrames = 650;
constexpr std::size_t kRenderBufferSize = 30;
constexpr std::size_t kAggregationBufferSize = 10 * 100;

class CircularBuffer {
 public:
  explicit CircularBuffer(std::size_t size) : buffer_(size) {}

  void Push(float value) {
    buffer_[next_insertion_index_] = value;
    next_insertion_index_ = (next_insertion_index_ + 1) % buffer_.size();
    element_count_ = std::min(element_count_ + 1, buffer_.size());
  }

  std::optional<float> Pop() {
    if (element_count_ == 0) {
      return std::nullopt;
    }
    const std::size_t index =
        (buffer_.size() + next_insertion_index_ - element_count_) %
        buffer_.size();
    --element_count_;
    return buffer_[index];
  }

  std::size_t Size() const { return element_count_; }

  void Clear() {
    std::fill(buffer_.begin(), buffer_.end(), 0.f);
    next_insertion_index_ = 0;
    element_count_ = 0;
  }

 private:
  std::vector<float> buffer_;
  std::size_t next_insertion_index_ = 0;
  std::size_t element_count_ = 0;
};

class MeanVarianceEstimator {
 public:
  void Update(float value) {
    mean_ = (1.f - kAdaptationAlpha) * mean_ + kAdaptationAlpha * value;
    variance_ = (1.f - kAdaptationAlpha) * variance_ +
                kAdaptationAlpha * (value - mean_) * (value - mean_);
  }

  float mean() const { return mean_; }
  float std_deviation() const { return std::sqrt(std::max(variance_, 0.f)); }

  void Clear() {
    mean_ = 0.f;
    variance_ = 0.f;
  }

 private:
  float mean_ = 0.f;
  float variance_ = 0.f;
};

class NormalizedCovarianceEstimator {
 public:
  void Update(float x,
              float x_mean,
              float x_sigma,
              float y,
              float y_mean,
              float y_sigma) {
    covariance_ = (1.f - kAdaptationAlpha) * covariance_ +
                  kAdaptationAlpha * (x - x_mean) * (y - y_mean);
    normalized_cross_correlation_ =
        covariance_ / (x_sigma * y_sigma + .0001f);
  }

  float normalized_cross_correlation() const {
    return normalized_cross_correlation_;
  }

  void Clear() {
    normalized_cross_correlation_ = 0.f;
    covariance_ = 0.f;
  }

 private:
  float normalized_cross_correlation_ = 0.f;
  float covariance_ = 0.f;
};

class MovingMax {
 public:
  explicit MovingMax(std::size_t window_size) : window_size_(window_size) {}

  void Update(float value) {
    if (counter_ >= window_size_ - 1) {
      max_value_ *= kMovingMaxDecayFactor;
    } else {
      ++counter_;
    }
    if (value > max_value_) {
      max_value_ = value;
      counter_ = 0;
    }
  }

  float max() const { return max_value_; }

  void Clear() {
    max_value_ = 0.f;
    counter_ = 0;
  }

 private:
  float max_value_ = 0.f;
  std::size_t counter_ = 0;
  std::size_t window_size_ = 1;
};

float Power(ArrayView<const float> input) {
  if (input.empty()) {
    return 0.f;
  }
  return std::inner_product(input.begin(), input.end(), input.begin(), 0.f) /
         input.size();
}

class ResidualEchoDetectorCompat : public EchoDetector {
 public:
  ResidualEchoDetectorCompat()
      : render_buffer_(kRenderBufferSize),
        render_power_(kLookbackFrames),
        render_power_mean_(kLookbackFrames),
        render_power_std_dev_(kLookbackFrames),
        covariances_(kLookbackFrames),
        recent_likelihood_max_(kAggregationBufferSize) {}

  ~ResidualEchoDetectorCompat() override = default;

  void AnalyzeRenderAudio(ArrayView<const float> render_audio) override {
    if (render_buffer_.Size() == 0) {
      frames_since_zero_buffer_size_ = 0;
    } else if (frames_since_zero_buffer_size_ >= kRenderBufferSize) {
      render_buffer_.Pop();
      frames_since_zero_buffer_size_ = 0;
    }
    ++frames_since_zero_buffer_size_;
    render_buffer_.Push(Power(render_audio));
  }

  void AnalyzeCaptureAudio(ArrayView<const float> capture_audio) override {
    if (first_process_call_) {
      render_buffer_.Clear();
      first_process_call_ = false;
    }
    const std::optional<float> buffered_render_power = render_buffer_.Pop();
    if (!buffered_render_power) {
      return;
    }

    render_statistics_.Update(*buffered_render_power);
    render_power_[next_insertion_index_] = *buffered_render_power;
    render_power_mean_[next_insertion_index_] = render_statistics_.mean();
    render_power_std_dev_[next_insertion_index_] =
        render_statistics_.std_deviation();

    const float capture_power = Power(capture_audio);
    capture_statistics_.Update(capture_power);
    const float capture_mean = capture_statistics_.mean();
    const float capture_std_deviation = capture_statistics_.std_deviation();

    echo_likelihood_ = 0.f;
    std::size_t read_index = next_insertion_index_;
    for (auto& covariance : covariances_) {
      covariance.Update(capture_power, capture_mean, capture_std_deviation,
                        render_power_[read_index],
                        render_power_mean_[read_index],
                        render_power_std_dev_[read_index]);
      read_index = read_index > 0 ? read_index - 1 : kLookbackFrames - 1;
      echo_likelihood_ = std::max(
          echo_likelihood_, covariance.normalized_cross_correlation());
    }

    reliability_ = (1.f - kAdaptationAlpha) * reliability_ +
                   kAdaptationAlpha;
    echo_likelihood_ =
        std::clamp(echo_likelihood_ * reliability_, 0.f, 1.f);
    recent_likelihood_max_.Update(echo_likelihood_);
    next_insertion_index_ =
        next_insertion_index_ < kLookbackFrames - 1
            ? next_insertion_index_ + 1
            : 0;
  }

  void Initialize(int,
                  int,
                  int,
                  int) override {
    render_buffer_.Clear();
    std::fill(render_power_.begin(), render_power_.end(), 0.f);
    std::fill(render_power_mean_.begin(), render_power_mean_.end(), 0.f);
    std::fill(render_power_std_dev_.begin(), render_power_std_dev_.end(), 0.f);
    render_statistics_.Clear();
    capture_statistics_.Clear();
    recent_likelihood_max_.Clear();
    for (auto& covariance : covariances_) {
      covariance.Clear();
    }
    first_process_call_ = true;
    frames_since_zero_buffer_size_ = 0;
    next_insertion_index_ = 0;
    echo_likelihood_ = 0.f;
    reliability_ = 0.f;
  }

  Metrics GetMetrics() const override {
    Metrics metrics;
    metrics.echo_likelihood = echo_likelihood_;
    metrics.echo_likelihood_recent_max = recent_likelihood_max_.max();
    return metrics;
  }

 private:
  bool first_process_call_ = true;
  CircularBuffer render_buffer_;
  std::size_t frames_since_zero_buffer_size_ = 0;
  std::vector<float> render_power_;
  std::vector<float> render_power_mean_;
  std::vector<float> render_power_std_dev_;
  std::vector<NormalizedCovarianceEstimator> covariances_;
  std::size_t next_insertion_index_ = 0;
  MeanVarianceEstimator render_statistics_;
  MeanVarianceEstimator capture_statistics_;
  float echo_likelihood_ = 0.f;
  float reliability_ = 0.f;
  MovingMax recent_likelihood_max_;
};

}  // namespace

scoped_refptr<EchoDetector> CreateEchoDetector() {
  return make_ref_counted<ResidualEchoDetectorCompat>();
}

}  // namespace webrtc
