//! Successful WASAPI writes may be shorter than an AEC frame. Preserve real
//! bytes and assemble 10ms only at the production capture-clock matcher.
use super::*;
use crate::audio::speech::CaptureClockReferenceMatcher;

const ENDPOINT: &str = "same-render-capture-endpoint";

fn start(store: &AudioStateStore, evidence: &RefCell<evidence::StreamEvidence>, session: u64) {
    for reason in [
        EchoRenderBoundary::SessionStarted { session_id: session, endpoint_id: ENDPOINT,
            renderer_instance_id: "test-renderer", owner_generation: 1 },
        EchoRenderBoundary::StreamStarted { session_id: session, endpoint_id: ENDPOINT,
            renderer_instance_id: "test-renderer", owner_generation: 1 },
    ] {
        observe_event(store, ENDPOINT, evidence, false, DesktopStreamingEvent::Render(
            SpeakerRenderEvent::Discontinuity { reason, observed_at: Instant::now() })).unwrap();
    }
}

fn render<'a>(session: u64, samples: &'a [f32], submitted: u64, padding: u32) -> DesktopStreamingEvent<'a> {
    DesktopStreamingEvent::Render(SpeakerRenderEvent::Frame { render_session_id: session, samples,
        sample_rate_hz: 48_000, channel_count: 2,
        player_position: Duration::from_secs_f64(submitted.saturating_sub(u64::from(padding)) as f64/48_000.0),
        submitted_frames: submitted, submitted_qpc_100ns: Some(100_000_000+submitted*10_000_000/48_000),
        endpoint_padding_frames: padding, physical_prefix_offset_frames: 0, observed_at: Instant::now() })
}

fn ramp(start: usize, frames: usize) -> Vec<f32> {
    (start..start+frames).flat_map(|n| [n as f32/32_768.0, -(n as f32/32_768.0)]).collect()
}

#[test]
fn observer_admits_capacity_topup_and_short_tail_without_retiming_the_write() {
    let dir=tempfile::tempdir().unwrap(); let store=AudioStateStore::new();
    let evidence=RefCell::new(evidence::StreamEvidence::new(dir.path()).unwrap());
    start(&store,&evidence,1);
    let mut submitted=0;
    for frames in [480,480,480,96,384,17,1] {
        let samples=ramp(submitted as usize,frames); submitted+=frames as u64;
        observe_event(&store,ENDPOINT,&evidence,false,render(1,&samples,submitted,frames as u32)).unwrap();
        let clock=store.echo_render_clock_snapshot();
        assert_eq!(clock.submitted_frames,Some(submitted));
        assert_eq!(clock.endpoint_padding_frames,Some(frames as u32));
        assert_eq!(clock.reference_lead_frames,Some(0));
    }
    assert_eq!(submitted,1938);
}


#[test]
fn observed_1056_frame_endpoint_capacity_admits_the_exact_96_frame_topup() {
    let dir=tempfile::tempdir().unwrap(); let store=AudioStateStore::new();
    let evidence=RefCell::new(evidence::StreamEvidence::new(dir.path()).unwrap()); start(&store,&evidence,1);
    let golden=ramp(0,1536);let mut submitted=0;
    for (frames,padding) in [(480,480),(480,960),(480,960),(96,1056)] {
        let begin=submitted;submitted+=frames;let samples=&golden[begin*2..submitted*2];
        observe_event(&store,ENDPOINT,&evidence,false,render(1,samples,submitted as u64,padding)).unwrap();
        let clock=store.echo_render_clock_snapshot();
        assert_eq!(clock.submitted_frames,Some(submitted as u64));
        assert_eq!(clock.endpoint_padding_frames,Some(padding));
        assert_eq!(clock.reference_lead_frames,Some(padding.saturating_sub(frames as u32)));
    }
    assert_eq!(submitted,1536);
}

#[test]
fn admitted_short_writes_assemble_exact_native_10ms_without_synthetic_lookahead() {
    let dir=tempfile::tempdir().unwrap(); let store=AudioStateStore::new();
    let evidence=RefCell::new(evidence::StreamEvidence::new(dir.path()).unwrap()); start(&store,&evidence,1);
    let mut matcher=CaptureClockReferenceMatcher::default(); let golden=ramp(0,961);
    let mut end=0;
    for frames in [96,384,96,384,1] {
        let begin=end; end+=frames;
        let samples=&golden[begin*2..end*2];
        observe_event(&store,ENDPOINT,&evidence,false,render(1,samples,end as u64,frames as u32)).unwrap();
        matcher.enqueue_committed(1,end as u64,None,samples).unwrap();
        match end {
            480 => assert_eq!(matcher.take_10ms(1).unwrap(),golden[0..960]),
            960 => assert_eq!(matcher.take_10ms(1).unwrap(),golden[960..1920]),
            _ => assert!(matcher.take_10ms(1).is_none(),"short write invented a complete AEC frame"),
        }
    }
    assert!(matcher.take_10ms(1).is_none());
    // Never borrow the previous epoch's final real frame for a new owner.
    matcher.clear_for_epoch(2); matcher.enqueue_committed(2,479,None,&ramp(961,479)).unwrap();
    assert!(matcher.take_10ms(2).is_none());
}

#[test]
fn observer_rejects_malformed_partial_pcm_before_publishing_clock_state() {
    let dir=tempfile::tempdir().unwrap(); let store=AudioStateStore::new();
    let evidence=RefCell::new(evidence::StreamEvidence::new(dir.path()).unwrap()); start(&store,&evidence,1);
    for samples in [vec![],vec![0.1;191],vec![0.1;962],vec![f32::NAN;192],
        vec![f32::INFINITY;192],vec![1.01;192]] {
        assert!(observe_event(&store,ENDPOINT,&evidence,false,render(1,&samples,96,96)).is_err());
        assert_eq!(store.echo_render_clock_snapshot().submitted_frames,None);
    }
}

#[test]
fn short_reference_cannot_bypass_format_clock_or_started_session_authority() {
    let dir=tempfile::tempdir().unwrap(); let store=AudioStateStore::new();
    let evidence=RefCell::new(evidence::StreamEvidence::new(dir.path()).unwrap()); start(&store,&evidence,1);
    let samples=ramp(0,96);
    for mutation in 0..7 {
        let mut event=render(1,&samples,96,96);
        if let DesktopStreamingEvent::Render(SpeakerRenderEvent::Frame { render_session_id,
            sample_rate_hz,channel_count,submitted_frames,submitted_qpc_100ns,endpoint_padding_frames,
            physical_prefix_offset_frames,.. })=&mut event {
            match mutation {
                0 => *sample_rate_hz=24_000, 1 => *channel_count=1,
                2 => *submitted_qpc_100ns=None, 3 => *endpoint_padding_frames=97,
                4 => *submitted_frames=95, 5 => *render_session_id=2,
                _ => *physical_prefix_offset_frames=1,
            }
        }
        assert!(observe_event(&store,ENDPOINT,&evidence,false,event).is_err(),"mutation {mutation}");
        assert_eq!(store.echo_render_clock_snapshot().submitted_frames,None);
    }
}

#[test]
fn partial_physical_evidence_seals_all_native_bytes_and_contiguous_frame_spans() {
    let dir=tempfile::tempdir().unwrap(); let mut evidence=evidence::StreamEvidence::new(dir.path()).unwrap();
    let golden=ramp(0,497); let mut end=0;
    for frames in [96,384,17] {
        let begin=end;end+=frames;let samples=&golden[begin*2..end*2];
        let tap=crate::audio::speech::DesktopStreamTap { render_session_id:1,renderer_owner_generation:1,
            renderer_instance_id:"test-renderer",physical_playback_device_id:ENDPOINT,
            reference_start_frame:begin as u64,reference_end_frame:end as u64,
            physical_start_frame:begin as u64,physical_end_frame:end as u64,
            stage:Some("double-talk"),stage_ordinal:Some(1),delay_ms:0,nonlinearity:"none",
            reference_samples:samples,physical_samples:samples,submitted_frames:end as u64,
            endpoint_padding_frames:frames as u32,physical_prefix_offset_frames:0,
            submitted_qpc_100ns:Some(100_000_000+end as u64),observed_at:Instant::now() };
        evidence.tap(&tap,ENDPOINT,false).unwrap();
    }
    let sealed=evidence.finish().unwrap();
    let expected:Vec<u8>=golden.iter().flat_map(|s|s.to_le_bytes()).collect();
    for name in ["local-aec-physical-48k-stereo.f32le","local-aec-linear-reference-48k-stereo.f32le"] {
        assert_eq!(fs::read(dir.path().join(name)).unwrap(),expected);
    }
    assert_eq!(sealed["physical"]["frameCount"],497);
    assert_eq!(sealed["linearReference"]["frameCount"],497);
    assert_eq!(sealed["events"]["eventCount"],3);
    assert_eq!(sealed["streamDrained"],false,"sealed bytes alone cannot manufacture a pass");
}

#[cfg(feature="webrtc-aec3")]
#[test]
fn linked_aec_consumes_partial_device_writes_only_when_the_real_10ms_reference_is_complete() {
    let dir=tempfile::tempdir().unwrap(); let store=AudioStateStore::new();
    store.activate_production_echo_canceller().unwrap();
    let evidence=RefCell::new(evidence::StreamEvidence::new(dir.path()).unwrap()); start(&store,&evidence,1);
    let samples=ramp(0,480);
    let metadata=crate::audio::state::AecCaptureFrameMetadata {
        packet_device_frame_index:0,packet_qpc_100ns:100_000_000,
        queue_head_device_frame_index:0,queue_head_qpc_100ns:100_000_000,
        observed_qpc_100ns:Some(100_000_001),continuity_id:1,delay_samples:0,
        timestamp_error:false,data_discontinuity:false,queue_head_clock_valid:true };
    observe_event(&store,ENDPOINT,&evidence,false,render(1,&samples[..192],96,96)).unwrap();
    store.process_echo_capture_with_metadata(&[0.0;960],0,Some(metadata)).unwrap();
    assert_eq!(store.echo_canceller_stats().unwrap().render_10ms_frames,0);
    observe_event(&store,ENDPOINT,&evidence,false,render(1,&samples[192..],480,384)).unwrap();
    store.process_echo_capture_with_metadata(&[0.0;960],0,Some(metadata)).unwrap();
    let stats=store.echo_canceller_stats().unwrap();assert_eq!(stats.render_10ms_frames,1);
    assert_eq!(stats.capture_10ms_frames,2);assert_eq!(stats.rejected_frame_count,0);
}
