use std::collections::VecDeque;

use super::AudioStateStore;

const INSTANCE_CAPACITY: usize = 16;
const FRAME_CAPACITY: usize = 8_192;

/// Authoritative identity carried by each native Bridge source frame. The
/// producer and Desktop read timestamps are independent Unix epoch values.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct BridgeSourceFrameIdentity {
    pub(crate) bridge_process_id: u32,
    pub(crate) bridge_instance_id: String,
    pub(crate) session_id: String,
    pub(crate) source_generation: u64,
    pub(crate) source_generation_token: String,
    pub(crate) frame_timestamp_ms: u64,
    pub(crate) read_timestamp_ms: u64,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct BridgeSourceRuntimeEvidenceSnapshot {
    pub(crate) accepted_frame_count: u64,
    pub(crate) rejected_frame_count: u64,
    pub(crate) last_accepted: Option<BridgeSourceFrameIdentity>,
    accepted_by_instance: Vec<(String, u64)>,
    first_frame_by_generation: Vec<BridgeSourceFrameIdentity>,
    rejected_frames: Vec<BridgeSourceFrameIdentity>,
}

impl BridgeSourceRuntimeEvidenceSnapshot {
    pub(crate) fn accepted_for_instance(&self, instance_id: &str) -> u64 {
        self.accepted_by_instance
            .iter()
            .find_map(|(candidate, count)| (candidate == instance_id).then_some(*count))
            .unwrap_or(0)
    }

    pub(crate) fn first_frame_for_generation(
        &self,
        generation_token: &str,
    ) -> Option<&BridgeSourceFrameIdentity> {
        self.first_frame_by_generation
            .iter()
            .find(|identity| identity.source_generation_token == generation_token)
    }

    pub(crate) fn rejected_for_instance_since(
        &self,
        instance_id: &str,
        read_timestamp_ms: u64,
    ) -> u64 {
        self.rejected_frames
            .iter()
            .filter(|identity| {
                identity.bridge_instance_id == instance_id
                    && identity.read_timestamp_ms >= read_timestamp_ms
            })
            .count() as u64
    }
}

#[derive(Default)]
pub(super) struct BridgeSourceRuntimeEvidence {
    accepted_frame_count: u64,
    rejected_frame_count: u64,
    last_accepted: Option<BridgeSourceFrameIdentity>,
    accepted_by_instance: VecDeque<(String, u64)>,
    first_frame_by_generation: VecDeque<BridgeSourceFrameIdentity>,
    rejected_frames: VecDeque<BridgeSourceFrameIdentity>,
}

impl BridgeSourceRuntimeEvidence {
    fn record_accepted(&mut self, identity: BridgeSourceFrameIdentity) {
        self.accepted_frame_count = self.accepted_frame_count.saturating_add(1);
        if let Some((_, count)) = self
            .accepted_by_instance
            .iter_mut()
            .find(|(instance_id, _)| instance_id == &identity.bridge_instance_id)
        {
            *count = count.saturating_add(1);
        } else {
            if self.accepted_by_instance.len() == INSTANCE_CAPACITY {
                self.accepted_by_instance.pop_front();
            }
            self.accepted_by_instance
                .push_back((identity.bridge_instance_id.clone(), 1));
        }
        if !self
            .first_frame_by_generation
            .iter()
            .any(|first| first.source_generation_token == identity.source_generation_token)
        {
            if self.first_frame_by_generation.len() == INSTANCE_CAPACITY {
                self.first_frame_by_generation.pop_front();
            }
            self.first_frame_by_generation.push_back(identity.clone());
        }
        self.last_accepted = Some(identity);
    }

    fn record_rejected(&mut self, identity: BridgeSourceFrameIdentity) {
        self.rejected_frame_count = self.rejected_frame_count.saturating_add(1);
        if self.rejected_frames.len() == FRAME_CAPACITY {
            self.rejected_frames.pop_front();
        }
        self.rejected_frames.push_back(identity);
    }

    fn snapshot(&self) -> BridgeSourceRuntimeEvidenceSnapshot {
        BridgeSourceRuntimeEvidenceSnapshot {
            accepted_frame_count: self.accepted_frame_count,
            rejected_frame_count: self.rejected_frame_count,
            last_accepted: self.last_accepted.clone(),
            accepted_by_instance: self.accepted_by_instance.iter().cloned().collect(),
            first_frame_by_generation: self
                .first_frame_by_generation
                .iter()
                .cloned()
                .collect(),
            rejected_frames: self.rejected_frames.iter().cloned().collect(),
        }
    }
}

impl AudioStateStore {
    pub(crate) fn record_bridge_source_frame_accepted(
        &self,
        identity: BridgeSourceFrameIdentity,
    ) {
        self.bridge_source_runtime_evidence
            .lock()
            .expect("bridge source evidence poisoned")
            .record_accepted(identity);
    }

    pub(crate) fn record_bridge_source_frame_rejected(
        &self,
        identity: BridgeSourceFrameIdentity,
    ) {
        self.bridge_source_runtime_evidence
            .lock()
            .expect("bridge source evidence poisoned")
            .record_rejected(identity);
    }

    pub(crate) fn bridge_source_runtime_evidence(
        &self,
    ) -> BridgeSourceRuntimeEvidenceSnapshot {
        self.bridge_source_runtime_evidence
            .lock()
            .expect("bridge source evidence poisoned")
            .snapshot()
    }
}
