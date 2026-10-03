//! Bounded diagnostic observer of already completed FIFO mutations. No PCM,
//! clock, reset policy, or admission authority lives here. A failed observation
//! freezes the last proved ledger rather than guessing ranges or changing audio.
use std::collections::VecDeque;

pub(super) const MAX_PACKET_SPANS: usize = 2048;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct ByteRange { pub start: u64, pub end: u64 }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct PacketRange {
    pub packet_id: u64, pub bytes: ByteRange,
    pub packet_offset_start: u64, pub packet_offset_end: u64,
}
#[derive(Clone, Debug)]
pub(super) struct QueueMutation {
    pub owner_id: u64,
    pub packet_id: Option<u64>, pub dequeue_id: Option<u64>,
    pub generation_before: u64, pub generation_after: u64,
    pub queued_before: usize, pub queued_after: usize,
    pub bytes: Option<ByteRange>, pub packet_ranges: Vec<PacketRange>,
    pub error: Option<&'static str>, pub last_known_head: u64, pub last_known_tail: u64,
}
#[derive(Clone, Copy, Debug)]
struct PacketSpan { id: u64, original_start: u64, bytes: ByteRange }
#[derive(Debug)]
pub(super) struct CaptureQueueLedger {
    owner_id: u64, generation: u64, next_packet: u64, next_dequeue: u64,
    head: u64, tail: u64, spans: VecDeque<PacketSpan>, error: Option<&'static str>,
}
impl CaptureQueueLedger {
    pub(super) fn new(owner_id: u64, queued_bytes: usize) -> Self {
        Self { owner_id, generation: 0, next_packet: 1, next_dequeue: 1, head: 0, tail: 0,
            spans: VecDeque::new(), error: (queued_bytes != 0).then_some("unobserved-initial-queue") }
    }
    pub(super) fn generation(&self) -> u64 { self.generation }
    pub(super) fn error(&self) -> Option<&'static str> { self.error }
    pub(super) fn last_known_range(&self) -> ByteRange { ByteRange { start: self.head, end: self.tail } }
    fn fail(&mut self, reason: &'static str) { if self.error.is_none() { self.error = Some(reason); } }
    fn verify_before(&mut self, owner_id: u64, before: usize) {
        if owner_id != self.owner_id { self.fail("capture-owner-mismatch"); }
        if self.tail.checked_sub(self.head) != Some(before as u64) { self.fail("queue-length-mismatch"); }
    }
    fn receipt(&self, before: usize, after: usize) -> QueueMutation {
        QueueMutation { owner_id: self.owner_id, packet_id: None, dequeue_id: None, generation_before: self.generation,
            generation_after: self.generation, queued_before: before, queued_after: after,
            bytes: None, packet_ranges: Vec::new(), error: self.error,
            last_known_head: self.head, last_known_tail: self.tail }
    }
    fn intersections(&self, range: ByteRange) -> Vec<PacketRange> {
        self.spans.iter().filter_map(|span| {
            let start = range.start.max(span.bytes.start);
            let end = range.end.min(span.bytes.end);
            (start < end).then(|| PacketRange { packet_id: span.id,
                bytes: ByteRange { start, end }, packet_offset_start: start - span.original_start,
                packet_offset_end: end - span.original_start })
        }).collect()
    }
    /// Read-only range query. Unknown or out-of-ledger bytes are never mapped.
    pub(super) fn range(&self, start: u64, bytes: usize) -> Option<(ByteRange, Vec<PacketRange>)> {
        if self.error.is_some() { return None; }
        let end = start.checked_add(bytes as u64)?;
        if start < self.head || end > self.tail { return None; }
        let range = ByteRange { start, end };
        Some((range, self.intersections(range)))
    }
    pub(super) fn observe_append(&mut self, owner_id: u64, before: usize, after: usize,
        actual_packet_bytes: Option<usize>) -> QueueMutation {
        self.verify_before(owner_id, before);
        let mut receipt = self.receipt(before, after);
        let delta = after.checked_sub(before);
        if delta.is_none() { self.fail("append-byte-underflow"); }
        if delta != actual_packet_bytes { self.fail("packet-byte-count-mismatch"); }
        if delta == Some(0) && self.error.is_none() { return receipt; }
        if self.spans.len() >= MAX_PACKET_SPANS { self.fail("packet-span-retention-bound"); }
        let next_tail = delta.and_then(|bytes| self.tail.checked_add(bytes as u64));
        let next_generation = self.generation.checked_add(1);
        let next_packet = self.next_packet.checked_add(1);
        if next_tail.is_none() || next_generation.is_none() || next_packet.is_none() {
            self.fail("append-counter-overflow");
        }
        if self.error.is_some() { receipt.error = self.error; return receipt; }
        let range = ByteRange { start: self.tail, end: next_tail.unwrap() };
        let id = self.next_packet;
        self.spans.push_back(PacketSpan { id, original_start: range.start, bytes: range });
        self.tail = range.end; self.generation = next_generation.unwrap(); self.next_packet = next_packet.unwrap();
        receipt.packet_id = Some(id); receipt.bytes = Some(range);
        receipt.packet_ranges = self.intersections(range);
        receipt.generation_after = self.generation; receipt.last_known_tail = self.tail;
        receipt
    }
    pub(super) fn observe_dequeue(&mut self, owner_id: u64, before: usize, after: usize,
        actual_dequeued_bytes: Option<usize>) -> QueueMutation {
        self.verify_before(owner_id, before);
        let mut receipt = self.receipt(before, after);
        let delta = before.checked_sub(after);
        if delta.is_none() { self.fail("dequeue-byte-underflow"); }
        if delta != actual_dequeued_bytes { self.fail("dequeue-byte-count-mismatch"); }
        if delta == Some(0) && self.error.is_none() { return receipt; }
        let next_head = delta.and_then(|bytes| self.head.checked_add(bytes as u64));
        let next_generation = self.generation.checked_add(1);
        let next_dequeue = self.next_dequeue.checked_add(1);
        if next_head.is_none() || next_generation.is_none() || next_dequeue.is_none() {
            self.fail("dequeue-counter-overflow");
        }
        if self.error.is_some() { receipt.error = self.error; return receipt; }
        let range = ByteRange { start: self.head, end: next_head.unwrap() };
        receipt.packet_ranges = self.intersections(range);
        receipt.bytes = Some(range); receipt.dequeue_id = Some(self.next_dequeue);
        self.head = range.end; self.generation = next_generation.unwrap(); self.next_dequeue = next_dequeue.unwrap();
        while self.spans.front().is_some_and(|span| span.bytes.end <= self.head) { self.spans.pop_front(); }
        if let Some(span) = self.spans.front_mut() { span.bytes.start = span.bytes.start.max(self.head); }
        receipt.generation_after = self.generation; receipt.last_known_head = self.head;
        receipt
    }
}

impl QueueMutation {
    /// Binds actual chunks to the completed eager batch dequeue, including bytes
    /// which are no longer in the live FIFO. No packet/latest-clock substitution.
    pub(super) fn chunk_range(&self, offset: usize, bytes: usize) -> Option<(ByteRange, Vec<PacketRange>)> {
        if self.error.is_some() { return None; }
        let batch = self.bytes?;
        let start = batch.start.checked_add(offset as u64)?;
        let end = start.checked_add(bytes as u64)?;
        if end > batch.end { return None; }
        let range = ByteRange { start, end };
        let spans = self.packet_ranges.iter().filter_map(|span| {
            let left = start.max(span.bytes.start); let right = end.min(span.bytes.end);
            (left < right).then(|| PacketRange { packet_id: span.packet_id,
                bytes: ByteRange { start: left, end: right },
                packet_offset_start: span.packet_offset_start + left - span.bytes.start,
                packet_offset_end: span.packet_offset_start + right - span.bytes.start })
        }).collect();
        Some((range, spans))
    }
}

#[cfg(test)]
#[path = "capture_queue_provenance_tests.rs"]
mod tests;
