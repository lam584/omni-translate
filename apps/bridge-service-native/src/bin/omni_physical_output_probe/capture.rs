// Shared physical endpoint loopback capture primitives.

    struct LoopbackCapture {
        audio_client: AudioClient,
        capture_client: AudioCaptureClient,
    }

    impl LoopbackCapture {
        fn start(device: &Device) -> Result<Self, String> {
            let format = WaveFormat::new(32, 32, &SampleType::Float, SAMPLE_RATE, CHANNELS, None);
            let (audio_client, capture_client) = open_capture_stream(device, &format)?;
            Ok(Self {
                audio_client,
                capture_client,
            })
        }

        fn collect_available(&self, metrics: &mut CaptureMetrics) -> Result<(), String> {
            for_each_capture_packet(&self.capture_client, BYTES_PER_FRAME, |packet, _silent| {
                if packet.is_empty() {
                    metrics.silent_packets += 1;
                    return;
                }
                for chunk in packet.chunks_exact(4) {
                    let value = f32::from_le_bytes(chunk.try_into().unwrap());
                    if value.is_finite() {
                        metrics.samples.push(value);
                        metrics.peak = metrics.peak.max(value.abs());
                    } else {
                        metrics.invalid_samples += 1;
                    }
                }
            })
        }
    }

    impl Drop for LoopbackCapture {
        fn drop(&mut self) {
            let _ = self.audio_client.stop_stream();
        }
    }

    #[derive(Default)]
    struct CaptureMetrics {
        samples: Vec<f32>,
        peak: f32,
        silent_packets: usize,
        invalid_samples: usize,
    }

    impl CaptureMetrics {
        fn append_pcm16le(&mut self, payload: &[u8]) {
            for chunk in payload.chunks_exact(2) {
                let value = i16::from_le_bytes(chunk.try_into().unwrap()) as f32
                    / i16::MAX as f32;
                self.samples.push(value);
                self.peak = self.peak.max(value.abs());
            }
        }

        fn frames(&self) -> usize {
            self.samples.len() / CHANNELS
        }

        fn rms(&self) -> f32 {
            if self.samples.is_empty() {
                return 0.0;
            }
            let sum = self
                .samples
                .iter()
                .map(|sample| (*sample as f64) * (*sample as f64))
                .sum::<f64>();
            (sum / self.samples.len() as f64).sqrt() as f32
        }
    }

