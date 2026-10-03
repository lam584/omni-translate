use super::*;

#[test]
fn real_short_appends_and_eager_dequeue_map_old_prefix_and_tail() {
    let mut ledger = CaptureQueueLedger::new(41, 0);
    let p1 = ledger.observe_append(41, 0, 768, Some(768));
    let p2 = ledger.observe_append(41, 768, 4608, Some(3840));
    let p3 = ledger.observe_append(41, 4608, 8448, Some(3840));
    assert_eq!((p1.packet_id, p2.packet_id, p3.packet_id), (Some(1), Some(2), Some(3)));
    let (prefix, spans) = ledger.range(0, 4608).unwrap();
    assert_eq!(prefix, ByteRange { start: 0, end: 4608 });
    assert_eq!(spans.iter().map(|s| s.packet_id).collect::<Vec<_>>(), vec![1, 2]);
    let full = ledger.observe_dequeue(41, 8448, 768, Some(7680));
    assert_eq!((full.generation_before, full.generation_after), (3, 4));
    assert_eq!(full.packet_ranges.iter().map(|s| s.bytes.end-s.bytes.start).collect::<Vec<_>>(), vec![768, 3840, 3072]);
    let tail = ledger.observe_dequeue(41, 768, 0, Some(768));
    assert_eq!(tail.packet_ranges, vec![PacketRange { packet_id: 3,
        bytes: ByteRange { start: 7680, end: 8448 }, packet_offset_start: 3072, packet_offset_end: 3840 }]);
    assert_eq!(ledger.generation(), 5);
    assert!(ledger.spans.is_empty());
}
#[test]
fn eager_batch_chunks_keep_mapping_after_the_entire_queue_has_drained() {
    let mut ledger=CaptureQueueLedger::new(2,0);
    ledger.observe_append(2,0,16000,Some(16000));
    let batch=ledger.observe_dequeue(2,16000,640,Some(15360));
    assert_eq!(batch.dequeue_id,Some(1));
    let (a, sa)=batch.chunk_range(0,7680).unwrap();
    let (b, sb)=batch.chunk_range(7680,7680).unwrap();
    assert_eq!(a,ByteRange{start:0,end:7680}); assert_eq!(b,ByteRange{start:7680,end:15360});
    assert_eq!(sa[0].packet_offset_start,0); assert_eq!(sb[0].packet_offset_start,7680);
    assert!(batch.chunk_range(15360,8).is_none());
    assert_eq!(ledger.range(15360,640).unwrap().1[0].packet_offset_start,15360);
}
#[test]
fn idle_and_read_only_prefix_queries_do_not_mutate_generation_or_packet_ids() {
    let mut ledger=CaptureQueueLedger::new(7,0);
    ledger.observe_append(7,0,768,Some(768));
    for _ in 0..100 {
        let idle=ledger.observe_append(7,768,768,Some(0));
        assert_eq!(idle.packet_id,None); assert!(ledger.range(0,0).unwrap().1.is_empty());
        assert_eq!(ledger.range(0,768).unwrap().1[0].packet_id,1);
        assert_eq!(ledger.generation(),1);
    }
    assert_eq!(ledger.observe_append(7,768,4608,Some(3840)).packet_id,Some(2));
}
#[test]
fn failures_are_sticky_keep_proved_spans_and_never_manufacture_ranges() {
    for (owner,before,after,count,expected) in [
        (42,768,1536,Some(768),"capture-owner-mismatch"),
        (41,760,1528,Some(768),"queue-length-mismatch"),
        (41,768,760,None,"append-byte-underflow"),
        (41,768,1536,Some(3840),"packet-byte-count-mismatch"),
    ] {
        let mut ledger=CaptureQueueLedger::new(41,0); ledger.observe_append(41,0,768,Some(768));
        let proved=ledger.last_known_range(); let spans=ledger.spans.len();
        let failed=ledger.observe_append(owner,before,after,count);
        assert_eq!(failed.error,Some(expected)); assert!(failed.bytes.is_none()); assert!(failed.packet_ranges.is_empty());
        let later=ledger.observe_dequeue(41,768,0,Some(768));
        assert_eq!(later.error,Some(expected)); assert!(later.bytes.is_none());
        assert_eq!(ledger.last_known_range(),proved); assert_eq!(ledger.spans.len(),spans);
        assert!(ledger.range(0,768).is_none());
    }
}
#[test]
fn dequeue_mismatch_and_unobserved_initial_queue_fail_closed() {
    let mut ledger=CaptureQueueLedger::new(41,0); ledger.observe_append(41,0,768,Some(768));
    assert_eq!(ledger.observe_dequeue(41,768,0,Some(760)).error,Some("dequeue-byte-count-mismatch"));
    assert_eq!(ledger.generation(),1); assert_eq!(ledger.spans.len(),1);
    let mut initial=CaptureQueueLedger::new(41,768);
    assert_eq!(initial.observe_append(41,768,1536,Some(768)).error,Some("unobserved-initial-queue"));
}
#[test]
fn retention_is_bounded_without_evicting_proved_prefix() {
    let mut ledger=CaptureQueueLedger::new(1,0);
    for i in 0..MAX_PACKET_SPANS { assert!(ledger.observe_append(1,i*8,(i+1)*8,Some(8)).error.is_none()); }
    let old=ledger.last_known_range();
    let fail=ledger.observe_append(1,MAX_PACKET_SPANS*8,(MAX_PACKET_SPANS+1)*8,Some(8));
    assert_eq!(fail.error,Some("packet-span-retention-bound"));
    assert_eq!(ledger.spans.len(),MAX_PACKET_SPANS); assert_eq!(ledger.last_known_range(),old);
}
#[test]
fn counters_do_not_wrap_or_supply_fake_packet_ids() {
    for which in 0..3 {
        let mut ledger=CaptureQueueLedger::new(1,0);
        match which { 0=>ledger.generation=u64::MAX,1=>ledger.next_packet=u64::MAX,_=>{ledger.head=u64::MAX;ledger.tail=u64::MAX;} }
        let receipt=ledger.observe_append(1,0,8,Some(8));
        assert_eq!(receipt.error,Some("append-counter-overflow")); assert!(receipt.bytes.is_none()); assert!(receipt.packet_id.is_none());
    }
    let mut ledger=CaptureQueueLedger::new(1,0); ledger.observe_append(1,0,8,Some(8)); ledger.next_dequeue=u64::MAX;
    assert_eq!(ledger.observe_dequeue(1,8,0,Some(8)).error,Some("dequeue-counter-overflow"));
    assert_eq!(ledger.last_known_range(),ByteRange{start:0,end:8});
}
#[test]
fn many_packet_shapes_conserve_bytes_and_never_intersect_later_packets() {
    let mut ledger=CaptureQueueLedger::new(9,0); let mut queued=0; let mut appended=0; let mut popped=0;
    for i in 0..5000 {
        let bytes=[768,3840,4608,15360][i%4];
        let row=ledger.observe_append(9,queued,queued+bytes,Some(bytes)); assert!(row.error.is_none());
        queued+=bytes; appended+=bytes;
        // The first interval must not underflow offsets on later packet spans.
        let (_,prefix)=ledger.range(ledger.head,queued.min(8)).unwrap(); assert_eq!(prefix.len(),1);
        let drain=queued/7680*7680;
        if drain>0 {
            let receipt=ledger.observe_dequeue(9,queued,queued-drain,Some(drain)); assert!(receipt.error.is_none());
            assert_eq!(receipt.packet_ranges.iter().map(|s| (s.bytes.end-s.bytes.start) as usize).sum::<usize>(),drain);
            queued-=drain; popped+=drain;
        }
        assert_eq!(ledger.tail-ledger.head,queued as u64); assert_eq!(appended-popped,queued);
    }
}
