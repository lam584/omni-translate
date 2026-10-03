//! Production owner-local boundaries for the real capture FIFO. This does not
//! repair clocks or supply diagnostic authority. It prevents a native block
//! from joining PCM on opposite sides of a proved packet-time discontinuity.
use std::collections::VecDeque;
const FRAME_BYTES: usize = 8;
const NORMAL_FRAMES: usize = 960;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct PacketTime {
    pub(crate) frame: u64,
    pub(crate) qpc: u64,
    pub(crate) frames: usize,
    pub(crate) discontinuity: bool,
    pub(crate) timestamp_error: bool,
}
impl PacketTime {
    fn end(self) -> Result<u64, String> {
        self.frame.checked_add(u64::try_from(self.frames).map_err(|_| "packet frame count overflow")?)
            .ok_or_else(|| "packet frame endpoint overflow".into())
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct BoundaryProof {
    pub(crate) owner: u64,
    pub(crate) generation: u64,
    pub(crate) id: u64,
    pub(crate) closed_segment: u64,
    pub(crate) next_segment: u64,
    pub(crate) bytes: usize,
    pub(crate) frames: usize,
    pub(crate) reason: &'static str,
    pub(crate) old_head_frame: u64,
    pub(crate) old_end_frame: u64,
    pub(crate) next: PacketTime,
    pub(crate) previous_timestamp_error: bool,
}
/// Not Clone: one immediate owner-local dequeue, bound to the actual prefix.
#[derive(Debug)]
pub(crate) struct BoundaryPermit { proof: BoundaryProof, exact_prefix: Vec<u8> }
impl BoundaryPermit {
    pub(crate) fn proof(&self) -> BoundaryProof { self.proof }
}
#[derive(Debug)]
pub(crate) struct PacketAdmission {
    pub(crate) segment: u64,
    pub(crate) generation: u64,
    pub(crate) boundary: Option<u64>,
    pub(crate) reason: Option<&'static str>,
    pub(crate) previous_end: Option<u64>,
    pub(crate) previous_timestamp_error: Option<bool>,
    pub(crate) prefix: Option<BoundaryPermit>,
}
#[derive(Debug)]
pub(crate) struct CapturePacketSegments {
    owner: u64,
    generation: u64,
    segment: u64,
    boundary: u64,
    queued_frames: usize,
    previous: Option<PacketTime>,
    pending_reset: Option<u64>,
    pending_prefix_bytes: usize,
    pending_prefix_receipt: Option<usize>,
    pending_processing: Option<BoundaryProof>,
}
impl CapturePacketSegments {
    pub(crate) fn new(owner: u64) -> Result<Self, String> {
        if owner == 0 { return Err("capture time segments require an actual nonzero owner".into()); }
        Ok(Self { owner, generation: 0, segment: 1, boundary: 0,
            queued_frames: 0, previous: None, pending_reset: None, pending_prefix_bytes: 0, pending_prefix_receipt: None, pending_processing: None })
    }
    /// Called after the real GetBuffer append, before reset/new-packet preparation.
    /// Empty reads do not mutate this owner or erase an unconsumed boundary.
    pub(crate) fn append(&mut self, owner: u64, before_bytes: usize,
        queue: &VecDeque<u8>, packet: PacketTime) -> Result<PacketAdmission, String> {
        if owner != self.owner || packet.frames == 0 || before_bytes % FRAME_BYTES != 0
            || before_bytes / FRAME_BYTES != self.queued_frames {
            return Err("capture time append owner/frame/queue mismatch".into());
        }
        let appended = packet.frames.checked_mul(FRAME_BYTES).ok_or("capture time append byte overflow")?;
        if before_bytes.checked_add(appended) != Some(queue.len()) {
            return Err("capture time append does not match the real FIFO".into());
        }
        if self.pending_reset.is_some() { return Err("new packet arrived before boundary reset acknowledgment".into()); }
        packet.end()?;
        let previous_end = self.previous.map(PacketTime::end).transpose()?;
        let reason = self.previous.and_then(|old| {
            if packet.timestamp_error { Some("timestamp-error") }
            else if old.timestamp_error { Some("untrusted-predecessor") }
            else if packet.discontinuity { Some("data-discontinuity") }
            else if previous_end != Some(packet.frame) { Some("device-frame-gap") }
            else { None }
        });
        let generation = self.generation.checked_add(1).ok_or("capture time generation exhausted")?;
        let old_segment = self.segment;
        let mut segment = old_segment;
        let mut id = None;
        let mut prefix = None;
        if let Some(reason) = reason {
            let boundary = self.boundary.checked_add(1).ok_or("capture time boundary identity exhausted")?;
            segment = old_segment.checked_add(1).ok_or("capture time segment identity exhausted")?;
            id = Some(boundary);
            if before_bytes > 0 {
                let frames = before_bytes / FRAME_BYTES;
                if frames >= NORMAL_FRAMES { return Err("old capture time segment was not normally drained".into()); }
                let old = self.previous.ok_or("old capture segment has no real packet")?;
                let old_end = old.end()?;
                let old_head = old_end.checked_sub(frames as u64).ok_or("old capture prefix frame anchor underflow")?;
                let proof = BoundaryProof { owner, generation, id: boundary, closed_segment: old_segment,
                    next_segment: segment, bytes: before_bytes, frames, reason, old_head_frame: old_head,
                    old_end_frame: old_end, next: packet, previous_timestamp_error: old.timestamp_error };
                self.pending_processing = Some(proof);
                prefix = Some(BoundaryPermit { proof, exact_prefix: queue.iter().take(before_bytes).copied().collect() });
            }
            self.boundary = boundary;
            self.pending_reset = Some(boundary);
            self.pending_prefix_bytes = before_bytes;
        }
        self.segment = segment;
        self.generation = generation;
        self.queued_frames = before_bytes / FRAME_BYTES + packet.frames;
        let previous_timestamp_error = self.previous.map(|p| p.timestamp_error);
        self.previous = Some(packet);
        Ok(PacketAdmission { segment, generation, boundary: id, reason,
            previous_end, previous_timestamp_error, prefix })
    }
    /// Take only old bytes. The current native packet remains in the same FIFO;
    /// no silence is inserted, old input is not discarded, and no clock is fixed.
    pub(crate) fn take_prefix(&mut self, queue: &mut VecDeque<u8>, permit: BoundaryPermit) -> Result<Vec<u8>, String> {
        let p = permit.proof;
        if p.owner != self.owner || p.generation != self.generation
            || Some(p.id) != self.pending_reset || p.next_segment != self.segment
            || self.pending_prefix_receipt.is_some() || self.pending_prefix_bytes != p.bytes
            || queue.len() != self.queued_frames * FRAME_BYTES
            || queue.iter().take(p.bytes).copied().ne(permit.exact_prefix.iter().copied()) {
            return Err("capture time boundary permit owner/generation/content mismatch".into());
        }
        self.pending_prefix_receipt = Some(p.bytes);
        Ok(queue.drain(..p.bytes).collect())
    }
    /// Observe the actual eager dequeue, not AEC completion or a guessed chunk.
    pub(crate) fn dequeued(&mut self, owner: u64, before: usize, after: usize, bytes: usize) -> Result<(), String> {
        if owner != self.owner || before != self.queued_frames * FRAME_BYTES
            || after.checked_add(bytes) != Some(before) || bytes % FRAME_BYTES != 0 || after % FRAME_BYTES != 0 {
            return Err("capture time dequeue owner/range mismatch".into());
        }
        if bytes == 0 { return Ok(()); }
        if self.pending_reset.is_some() && (self.pending_prefix_receipt != Some(bytes)
            || self.pending_prefix_bytes != bytes) {
            return Err("capture time dequeue crossed an unprocessed boundary".into());
        }
        self.generation = self.generation.checked_add(1).ok_or("capture time generation exhausted")?;
        self.queued_frames = after / FRAME_BYTES;
        if self.pending_reset.is_some() { self.pending_prefix_bytes = 0; self.pending_prefix_receipt = None; }
        Ok(())
    }
    /// Only process_chunk calls this after old-prefix AEC AND dispatch succeed.
    /// Dequeue, failed processing, a stop, and an unrelated capture cannot ack it.
    pub(crate) fn complete_prefix_processing(&mut self, owner: u64, generation: u64,
        id: u64, frames: usize) -> Result<(), String> {
        let proof = self.pending_processing.ok_or("capture boundary completion has no pending real prefix")?;
        if proof.owner != owner || proof.generation != generation || proof.id != id
            || proof.frames != frames || self.pending_reset != Some(id)
            || self.segment != proof.next_segment || self.pending_prefix_bytes != 0
            || self.pending_prefix_receipt.is_some() || generation.checked_add(1) != Some(self.generation) {
            return Err("capture boundary AEC/dispatch completion identity or dequeue mismatch".into());
        }
        self.pending_processing = None;
        Ok(())
    }
    pub(crate) fn reset_required(&self) -> bool { self.pending_reset.is_some() }
    /// Check before touching the engine: an invalid order must not reset it first.
    pub(crate) fn boundary_reset_ready(&self) -> Result<(), String> {
        if self.pending_prefix_bytes != 0 || self.pending_prefix_receipt.is_some() {
            return Err("capture continuity reset preceded its retained prefix dequeue".into());
        }
        if self.pending_processing.is_some() {
            return Err("capture continuity reset preceded retained prefix AEC/dispatch completion".into());
        }
        Ok(())
    }
    /// Called only after the production canceller's reset succeeded.
    pub(crate) fn acknowledge_reset(&mut self) -> Result<(), String> {
        self.boundary_reset_ready()?;
        self.pending_reset = None;
        Ok(())
    }
    pub(crate) fn normal_dequeue_ready(&self) -> Result<(), String> {
        if self.pending_reset.is_some() { return Err("normal capture dequeue preceded boundary completion/reset".into()); }
        Ok(())
    }
}

#[cfg(test)]
#[path = "capture_packet_segments_tests.rs"]
mod tests;