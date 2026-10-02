//! Capture-owned spans, published in channel-send order and bound on actual receive.
//! Vec allocation identity is only a retention key across queue/requeue moves;
//! offsets, clocks and reset identity are assigned exclusively by the producer.
use super::{AecCaptureFrameMetadata, AecDiagnosticTap};
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AecPostPacket {
    source_packet_sequence: u64,
    post_sample_offset: u64,
    reset_generation: u64,
    metadata: AecCaptureFrameMetadata,
    bytes: Arc<[u8]>,
}

#[derive(Debug, Default)]
pub(super) struct PostTapProvenance {
    sample_count: u64,
    dispatch_offset: u64,
    successful_send_offset: u64,
    last_dispatched: Option<AecPostPacket>,
    dispatched: VecDeque<AecPostPacket>,
    received: HashMap<usize, AecPostPacket>,
    started: bool,
}

impl AecPostPacket {
    fn sample_count(&self) -> u64 { self.bytes.len() as u64 / 4 }

    fn validate(&self, raw: &[u8]) -> Result<(), String> {
        if raw.is_empty() || raw.len() % 8 != 0 || raw != self.bytes.as_ref() {
            return Err("watch.aec-provenance-pcm-mismatch".into());
        }
        let m = self.metadata;
        if !m.queue_head_clock_valid || m.timestamp_error || m.data_discontinuity
            || m.queue_head_qpc_100ns == 0 {
            return Err("watch.aec-provenance-invalid-clock".into());
        }
        if raw.chunks_exact(4).any(|s| !f32::from_le_bytes(s.try_into().unwrap()).is_finite()) {
            return Err("watch.aec-provenance-nonfinite-pcm".into());
        }
        Ok(())
    }

    fn validate_wire(&self, raw: &[u8], wire: &[i16], rate: u32) -> Result<(), String> {
        self.validate(raw)?;
        if !matches!(rate, 16_000 | 24_000) || raw.len() / 8 % (48_000 / rate) as usize != 0
            || crate::audio::pcm_resample::resample_capture_to_mono_i16(raw, rate) != wire {
            return Err("watch.aec-provenance-wire-mismatch".into());
        }
        Ok(())
    }
}

impl PostTapProvenance {
    pub(super) fn capture(&mut self, sequence: u64, post: &[f32], metadata: AecCaptureFrameMetadata,
        reset_generation: u64) -> AecPostPacket {
        let packet = AecPostPacket {
            source_packet_sequence: sequence, post_sample_offset: self.sample_count,
            reset_generation, metadata,
            bytes: post.iter().flat_map(|s| s.to_le_bytes()).collect::<Vec<_>>().into(),
        };
        self.sample_count = self.sample_count.checked_add(post.len() as u64).expect("AEC capture offset overflow");
        packet
    }

    fn dispatch(&mut self, packet: AecPostPacket, raw: &[u8]) -> Result<(), String> {
        packet.validate(raw)?;
        if packet.post_sample_offset != self.dispatch_offset {
            return Err("watch.aec-provenance-capture-gap-or-reorder".into());
        }
        if let Some(last) = &self.last_dispatched {
            let frames = last.sample_count() / 2;
            let expected_clock = last.metadata.queue_head_qpc_100ns.checked_add(
                (frames * 10_000_000 + 24_000) / 48_000).ok_or("watch.aec-provenance-clock-overflow")?;
            let expected_device = last.metadata.queue_head_device_frame_index.checked_add(frames)
                .ok_or("watch.aec-provenance-device-overflow")?;
            if packet.reset_generation < last.reset_generation || packet.source_packet_sequence <= last.source_packet_sequence
                || packet.metadata.queue_head_device_frame_index != expected_device
                || packet.metadata.queue_head_qpc_100ns.abs_diff(expected_clock) > 1 {
                return Err("watch.aec-provenance-capture-clock-gap".into());
            }
        }
        if self.dispatch_offset.saturating_sub(self.successful_send_offset).saturating_add(packet.sample_count()) > 128 * 1024 * 1024 / 4 {
            return Err("watch.aec-provenance-retention-bound-exceeded".into());
        }
        self.started = true;
        self.dispatch_offset += packet.sample_count();
        self.last_dispatched = Some(packet.clone());
        self.dispatched.push_back(packet);
        Ok(())
    }

    fn receive(&mut self, raw: &Vec<u8>) -> Result<(), String> {
        let packet = self.dispatched.front().ok_or("watch.aec-provenance-receive-without-dispatch")?;
        packet.validate(raw)?;
        let key = raw.as_ptr() as usize;
        if self.received.contains_key(&key) { return Err("watch.aec-provenance-received-allocation-reused".into()); }
        let packet = self.dispatched.pop_front().unwrap();
        self.received.insert(key, packet);
        Ok(())
    }

    fn packet(&self, raw: &[u8]) -> Result<AecPostPacket, String> {
        let packet = self.received.get(&(raw.as_ptr() as usize))
            .ok_or("watch.aec-provenance-unbound-received-packet")?;
        packet.validate(raw)?;
        if packet.post_sample_offset != self.successful_send_offset {
            return Err("watch.aec-provenance-send-gap-or-reorder".into());
        }
        Ok(packet.clone())
    }

    fn complete(&mut self, raw: &[u8], packet: &AecPostPacket) -> Result<(), String> {
        let bound = self.packet(raw)?;
        if bound != *packet {
            return Err("watch.aec-provenance-wrong-packet-token".into());
        }
        self.successful_send_offset += bound.sample_count();
        self.received.remove(&(raw.as_ptr() as usize));
        Ok(())
    }

    fn drained(&self) -> Result<(), String> {
        if self.started && (!self.dispatched.is_empty() || !self.received.is_empty()
            || self.successful_send_offset != self.sample_count) {
            return Err("watch.aec-provenance-unconsumed-capture-packets".into());
        }
        Ok(())
    }
}

impl AecDiagnosticTap {
    pub(crate) fn provider_lineage_required(&self) -> bool { self.lineage_enabled }

    fn with_lineage<T>(&self, disabled: T,
        operation: impl FnOnce(&mut PostTapProvenance) -> Result<T, String>) -> Result<T, String> {
        if !self.lineage_enabled { return Ok(disabled); }
        let Some(live) = &self.live else {
            return Err(self.startup_error.clone().unwrap_or_else(|| "watch.aec-provenance-tap-unavailable".into()));
        };
        let result = (|| {
            if let Some(error) = live.shared.failure.get() { return Err(error.clone()); }
            let mut guard = live.post_provenance.lock().map_err(|_| "watch.aec-provenance-poisoned")?;
            operation(&mut guard)
        })();
        if let Err(error) = &result { self.abort(error); }
        result
    }

    pub(crate) fn dispatch_provider_packet(&self, packet: Option<AecPostPacket>, raw: &[u8]) -> Result<(), String> {
        self.with_lineage((), |lineage| lineage.dispatch(
            packet.ok_or("watch.aec-provenance-dispatch-without-capture-token")?, raw))
    }

    pub(crate) fn bind_provider_receive(&self, raw: &Vec<u8>) -> Result<(), String> {
        self.with_lineage((), |lineage| lineage.receive(raw))
    }

    pub(crate) fn provider_packet(&self, raw: &Vec<u8>) -> Result<Option<AecPostPacket>, String> {
        self.with_lineage(None, |lineage| lineage.packet(raw).map(Some))
    }

    pub(crate) fn validate_provider_wire(&self, packet: Option<&AecPostPacket>, raw: &[u8], wire: &[i16], rate: u32) -> Result<(), String> {
        self.with_lineage((), |lineage| {
            let bound = lineage.packet(raw)?;
            if packet != Some(&bound) { return Err("watch.aec-provenance-wrong-packet-token".into()); }
            bound.validate_wire(raw, wire, rate)
        })
    }

    pub(crate) fn commit_provider_packet(&self, wire: &[i16], raw: &Vec<u8>, packet: &AecPostPacket,
        session: &str, rate: u32, sent_qpc: u64) -> Result<Option<serde_json::Value>, String> {
        self.with_lineage(None, |lineage| {
            packet.validate_wire(raw, wire, rate)?;
            if session.trim().is_empty() || sent_qpc < packet.metadata.queue_head_qpc_100ns {
                return Err("watch.aec-provenance-send-clock-or-session-invalid".into());
            }
            lineage.complete(raw, packet)?;
            Ok(Some(serde_json::json!({
                "providerSessionId": session, "sampleRateHz": rate,
                "mappingProfile": "capture-downmix-box-decimate/v1",
                "sourcePacketSequence": packet.source_packet_sequence,
                "postSampleOffset": packet.post_sample_offset, "postSampleCount": packet.sample_count(),
                "qpc100ns": packet.metadata.queue_head_qpc_100ns, "sentQpc100ns": sent_qpc,
                "captureDeviceFrameIndex": packet.metadata.queue_head_device_frame_index,
                "continuityId": packet.metadata.continuity_id, "resetGeneration": packet.reset_generation,
            })))
        })
    }

    #[cfg(test)]
    pub(super) fn finish_provider_packet(&self, wire: &[i16], raw: &Vec<u8>, packet: &AecPostPacket,
        session: &str, rate: u32, sent_qpc: u64) -> Result<(), String> {
        if let Some(metadata) = self.commit_provider_packet(wire, raw, packet, session, rate, sent_qpc)? {
            self.record_provider(wire, metadata);
        }
        Ok(())
    }

    pub(super) fn validate_provider_drain(&self) -> Result<(), String> {
        self.with_lineage((), |lineage| lineage.drained())
    }
}

#[cfg(test)]
mod tests;
