//! Desktop-only response streaming. Bridge commands keep their existing path.
use super::*;
use crate::audio::speech::{DesktopPlaybackTimeline, DesktopStreamTap, DesktopStreamActivity, DesktopStreamingEvent, NativeDesktopStream};

const MAX_RESPONSE_SAMPLES: usize = 24_000 * 240;
const DESKTOP_STREAM_WAIT: Duration = Duration::from_millis(2);

fn desktop_command_timeout(device_started: bool) -> Duration {
    if device_started { Duration::ZERO } else { DESKTOP_STREAM_WAIT }
}

fn wait_after_desktop_command_timeout<T>(device_started: bool,
    wait: impl FnOnce(Duration) -> Result<T, String>) -> Result<(), String> {
    // Before Start, recv_timeout already waited for provider PCM. Do not add
    // another wait; once running, only the device event owns this bounded wait.
    if device_started { wait(DESKTOP_STREAM_WAIT)?; }
    Ok(())
}

struct DesktopPlaybackActivityGuard<'a>(&'a OmniPlaybackQueue);
impl Drop for DesktopPlaybackActivityGuard<'_> {
    fn drop(&mut self) { self.0.set_desktop_stream_active(false); }
}

fn publish_timeline<R: tauri::Runtime>(app: &AppHandle<R>, store: &AudioStateStore, queue: &OmniPlaybackQueue, timeline: &DesktopPlaybackTimeline, milestone: &str) -> Result<(), String> {
    if let Err(error) = queue.append_desktop_timeline(milestone, timeline) {
        return queue.fail_desktop_evidence(store, &timeline.cue_id, &timeline.response_id, &error);
    }
    if let Ok(json) = serde_json::to_string(timeline) {
        let _ = diag_log(app, "omni", "info", format!(
            "event=native_desktop_playback_timeline milestone={milestone} timeline={json}"));
    }
    Ok(())
}

fn observe_event<R: tauri::Runtime>(app: &AppHandle<R>, store: &AudioStateStore, queue: &OmniPlaybackQueue,
    timeline: &mut DesktopPlaybackTimeline, cue_id: &str, event: DesktopStreamingEvent<'_>) -> Result<(), String> {
    match event {
        DesktopStreamingEvent::Render(event) => {
            if let crate::audio::speech::SpeakerRenderEvent::Discontinuity {
                reason: crate::audio::state::EchoRenderBoundary::SessionStarted { session_id, endpoint_id,
                    renderer_instance_id, owner_generation }, ..
            } = &event {
                timeline.render_session_id = Some(*session_id);
                timeline.physical_playback_device_id = Some((*endpoint_id).into());
                timeline.renderer_instance_id = Some((*renderer_instance_id).into());
                timeline.renderer_owner_generation = Some(*owner_generation);
            }
            if let crate::audio::speech::SpeakerRenderEvent::Discontinuity {
                reason: crate::audio::state::EchoRenderBoundary::StreamStarted { session_id, endpoint_id,
                    renderer_instance_id, owner_generation }, ..
            } = &event {
                timeline.render_start_at_ms.get_or_insert_with(unix_ms);
                timeline.render_start_qpc_100ns = crate::audio::engine::aec_timing::qpc_now_100ns();
                timeline.render_session_id = Some(*session_id);
                timeline.physical_playback_device_id = Some((*endpoint_id).into());
                timeline.renderer_instance_id = Some((*renderer_instance_id).into());
                timeline.renderer_owner_generation = Some(*owner_generation);
                timeline.continuous_stream_id = Some(format!("{renderer_instance_id}:{owner_generation}:{session_id}"));
                timeline.stream_start_count += 1;
                store.record_strict_watch_renderer_started(cue_id)?;
                publish_timeline(app, store, queue, timeline, "render-start")?;
            }
            match event {
            crate::audio::speech::SpeakerRenderEvent::Discontinuity { reason, observed_at } =>
                store.mark_echo_render_discontinuity(reason, observed_at),
            crate::audio::speech::SpeakerRenderEvent::Frame { render_session_id, samples, sample_rate_hz,
                channel_count, player_position, submitted_frames, submitted_qpc_100ns,
                endpoint_padding_frames, physical_prefix_offset_frames, observed_at } =>
                store.push_echo_reference_at(render_session_id, samples, sample_rate_hz, channel_count,
                    player_position, submitted_frames, submitted_qpc_100ns, endpoint_padding_frames,
                    physical_prefix_offset_frames, observed_at),
            crate::audio::speech::SpeakerRenderEvent::AecLiveScenarioStage { status, stage, ordinal,
                delay_ms, nonlinearity, reference_frames, physical_frames, changed_samples,
                changed_ratio, started_at_ms, completed_at_ms } => {
                let _ = diag_log(app, "omni", "info", format!(
                    "event=aec_live_scenario_stage status={status} cueId={cue_id} stage={stage} ordinal={ordinal} delayMs={delay_ms} nonlinearity={nonlinearity} referenceFrames={reference_frames} physicalFrames={physical_frames} changedSamples={changed_samples} changedRatio={changed_ratio:.6} started=true completed={} startedAtMs={started_at_ms} completedAtMs={completed_at_ms} source=runtime-physical-render playbackSource=native-omni",
                    status == "completed"));
                Ok(())
            }
            }
        },
        DesktopStreamingEvent::Activity(activity) => {
            // Lifecycle integration consumes this typed edge. Queue activity
            // remains held by the enclosing OmniPlaybackActiveGuard until the
            // response receipt (including physical drain) has been committed.
            let _ = diag_log(app, "omni", "info", format!(
                "event=native_desktop_stream_activity cueId={cue_id} activity={activity:?}"));
            if activity == DesktopStreamActivity::Completed {
                timeline.render_complete_at_ms.get_or_insert_with(unix_ms);
                timeline.render_complete_qpc_100ns = crate::audio::engine::aec_timing::qpc_now_100ns();
                publish_timeline(app, store, queue, timeline, "render-complete")?;
            } else if activity == DesktopStreamActivity::Aborted {
                timeline.aborted = true;
                publish_timeline(app, store, queue, timeline, "aborted")?;
            }
            if activity == DesktopStreamActivity::Opened {
                store.update_speech(|s| { s.dispatch_state = "playing".into();
                    s.output_target = "speaker".into(); s.current_cue_id = Some(cue_id.into()); });
                let _ = emit_audio_snapshot(app, store);
            }
            Ok(())
        }
        DesktopStreamingEvent::Tap(tap) => {
            let tap: &DesktopStreamTap<'_> = &tap;
            timeline.rendered_frames = tap.reference_end_frame;
            store.record_strict_watch_renderer_frames(cue_id, (tap.physical_samples.len() / 2) as u64)?;
            store.record_aec_physical_output(tap.physical_samples, json!({
                "kind": "physical-render", "cueId": cue_id, "responseId": timeline.response_id,
                "renderSessionId": tap.render_session_id, "ownerGeneration": tap.renderer_owner_generation,
                "rendererInstanceId": tap.renderer_instance_id,
                "endpointId": tap.physical_playback_device_id,
                "referenceStartFrame": tap.reference_start_frame, "referenceEndFrame": tap.reference_end_frame,
                "physicalStartFrame": tap.physical_start_frame, "physicalEndFrame": tap.physical_end_frame,
                "stage": tap.stage, "stageOrdinal": tap.stage_ordinal, "delayMs": tap.delay_ms, "nonlinearity": tap.nonlinearity,
                "sampleRateHz": 48_000, "channelCount": 2,
                "submittedFrames": tap.submitted_frames, "endpointPaddingFrames": tap.endpoint_padding_frames,
                "physicalPrefixOffsetFrames": tap.physical_prefix_offset_frames,
                "qpc100ns": tap.submitted_qpc_100ns, "observedAtUnixMs": unix_ms(),
                "continuityId": store.echo_render_clock_snapshot().discontinuity_count,
                "referenceFrames": tap.reference_samples.len() / 2,
                "physicalFrames": tap.physical_samples.len() / 2,
            }));
            Ok(())
        }
    }
}

pub(super) fn process_native_desktop_stream<R: tauri::Runtime>(
    app: &AppHandle<R>, store: &AudioStateStore, config: &OmniSpeechConfig,
    direction: &str, queue: &OmniPlaybackQueue, authority: &mut TranslatedPcmAuthority,
    first: OmniPlaybackCommand,
) {
    let OmniPlaybackCommand::Stream { cue_id, response_id, sample_rate_hz, created_at_ms,
        stream_state, chunk_index, samples, queued_at, .. } = first else { unreachable!() };
    if stream_state == omni_bridge_protocol::TranslationStreamState::Abort { return; }
    queue.set_desktop_stream_active(true);
    let _stream_activity_guard = DesktopPlaybackActivityGuard(queue);
    let route = crate::audio::speech::SpeechOutputRoutePlan::for_configured_route(direction,
        config.local_playback_enabled, config.virtual_mic_output_enabled, config.bridge_playback_enabled);
    let mut stream = None;
    let timeline = std::cell::RefCell::new(queue.desktop_timeline(response_id.as_deref().unwrap_or("")).unwrap_or_else(|| DesktopPlaybackTimeline {
        cue_id: cue_id.clone(), response_id: response_id.clone().unwrap_or_default(),
        first_audio_delta_at_ms: created_at_ms, source_sample_rate_hz: sample_rate_hz, render_sample_rate_hz: 48_000, ..Default::default()
    }));
    let mut events = |event: DesktopStreamingEvent<'_>| {
        let mut current = timeline.borrow_mut();
        if let Some(done) = queue.desktop_timeline(&current.response_id).and_then(|t| t.audio_done_at_ms) {
            current.audio_done_at_ms.get_or_insert(done);
            current.audio_done_qpc_100ns = queue.desktop_timeline(&current.response_id).and_then(|t|t.audio_done_qpc_100ns);
        }
        observe_event(app, store, queue, &mut current, &cue_id, event)
    };
    let mut ended = false;
    let mut expected_chunk_index = chunk_index;
    let mut output_pcm = Vec::new();
    let result = (|| -> Result<crate::audio::speech::SpeakerPlaybackReceipt, String> {
        if stream_state != omni_bridge_protocol::TranslationStreamState::Start || chunk_index != 0 {
            return Err("native desktop stream received a continuation without its Start".into());
        }
        if !config.enabled || !route.play_to_speaker || route.write_to_bridge_playback || route.write_to_virtual_mic {
            return Err("native desktop stream does not have an exclusive speaker output route".into());
        }
        let snapshot = crate::audio::speech::wait_for_translation_output_route(app, direction,
            config.bridge_capture_mode, &route);
        if let Some(error) = crate::audio::speech::translation_output_route_violation(&cue_id, direction,
            config.bridge_capture_mode, &route, &snapshot) { return Err(error); }
        store.record_strict_watch_renderer_cue_submitted(&cue_id, response_id.as_deref().unwrap_or(""))?;
        stream = Some(NativeDesktopStream::open(config.speaker_device_id.as_deref(),
            store.desktop_playback_ownership(), &cue_id, queued_at, &mut events)?);
        let renderer = stream.as_mut().expect("open stream");
        let append = |pcm: &[i16], renderer: &mut NativeDesktopStream, output: &mut Vec<i16>| -> Result<(), String> {
            if output.len().saturating_add(pcm.len()) > MAX_RESPONSE_SAMPLES {
                return Err("native desktop response exceeds bounded PCM authority storage".into());
            }
            let (enhanced, _) = render_omni_output_samples(pcm, sample_rate_hz, config.speaker_output_level,
                config.translated_audio_gain_db, config.translated_audio_auto_gain_enabled);
            renderer.push_pcm(&enhanced, sample_rate_hz)?;
            output.extend_from_slice(&enhanced);
            timeline.borrow_mut().accepted_source_frames = output.len() as u64;
            Ok(())
        };
        append(&samples, renderer, &mut output_pcm)?;
        expected_chunk_index += 1;
        loop {
            if queue.stream_cancelled(&cue_id) {
                return Err("native desktop stream aborted by queue/response owner".into());
            }
            if let Some(receipt) = renderer.poll(&mut events)? { return Ok(receipt); }
            if ended || !renderer.can_accept(OMNI_OUTPUT_SAMPLE_RATE_HZ as usize / 10) {
                renderer.wait_for_device(DESKTOP_STREAM_WAIT)?;
                continue;
            }
            let device_started = renderer.device_started();
            let command = match queue.recv_timeout(desktop_command_timeout(device_started)) {
                OmniPlaybackReceiveOutcome::Command { command, dropped } => {
                    record_native_playback_stale(app, store, &dropped, "realtime-budget-before-start"); command
                }
                OmniPlaybackReceiveOutcome::StaleDropped(dropped) => {
                    record_native_playback_stale(app, store, &dropped, "realtime-budget-before-start"); continue;
                }
                OmniPlaybackReceiveOutcome::Timeout => {
                    wait_after_desktop_command_timeout(device_started,
                        |timeout| renderer.wait_for_device(timeout))?;
                    continue;
                }
                OmniPlaybackReceiveOutcome::Stopped => return Err("native desktop shutdown without provider End".into()),
            };
            let OmniPlaybackCommand::Stream { cue_id: next_cue, response_id: next_response,
                stream_state, chunk_index, samples, sample_rate_hz: next_rate, .. } = &command else {
                queue.return_pending(command);
                return Err("complete cue overlaps active native desktop stream".into());
            };
            if next_cue != &cue_id {
                queue.return_pending(command);
                return Err("another response overlaps active native desktop stream".into());
            }
            if *stream_state == omni_bridge_protocol::TranslationStreamState::Abort {
                return Err("native desktop Abort command".into());
            }
            if next_response != &response_id || *chunk_index != expected_chunk_index || *next_rate != sample_rate_hz {
                return Err("native desktop stream response/chunk/format owner changed".into());
            }
            match stream_state {
                omni_bridge_protocol::TranslationStreamState::Chunk => append(samples, renderer, &mut output_pcm)?,
                omni_bridge_protocol::TranslationStreamState::End => {
                    if !samples.is_empty() { return Err("native desktop End must not replay PCM".into()); }
                    renderer.end(&mut events)?; ended = true;
                }
                _ => return Err("duplicate native desktop Start".into()),
            }
            expected_chunk_index += 1;
        }
    })();
    match result {
        Ok(receipt) => {
            { let mut current = timeline.borrow_mut(); current.accepted_source_frames = output_pcm.len() as u64;
                current.rendered_frames = receipt.rendered_frames; }
            let render_attempt_id = format!("{}:{}:{}:{cue_id}:{created_at_ms}", receipt.renderer_instance_id,
                receipt.renderer_owner_generation, timeline.borrow().render_session_id.unwrap_or(0));
            let committed = authority.accept_complete_speaker_cue(&cue_id, response_id.as_deref().unwrap_or(""),
                &render_attempt_id, &output_pcm, sample_rate_hz, 1, output_pcm.len() as u64,
                created_at_ms, &receipt, &render_attempt_id);
            if let Err(error) = committed {
                store.watch_session_report.record_session_issue("output", "translated-pcm-authority-failed", "error", &error);
                record_renderer_failure(store, &cue_id, "speaker-renderer-authority-commit-failed");
            } else {
                match store.record_strict_watch_renderer_ack(&cue_id, "speaker-render-completed", &render_attempt_id) {
                    Ok(()) => {
                        let mut current = timeline.borrow_mut(); current.renderer_ack_at_ms = Some(unix_ms());
                        current.renderer_ack_qpc_100ns = crate::audio::engine::aec_timing::qpc_now_100ns();
                        current.renderer_ack_receipt_id = Some(render_attempt_id.clone());
                        if let Err(error) = publish_timeline(app, store, queue, &current, "renderer-ack") {
                            store.watch_session_report.record_session_issue("output", "native-desktop-timeline-write-failed", "error", &error);
                            // publish_timeline already invoked the typed failure
                            // edge and fail-stopped the queue, even after ACK.
                        }
                    }
                    Err(error) => {
                        store.watch_session_report.record_session_issue("output", "strict-renderer-ack-authority-failed", "error", &error);
                    }
                }
                store.update_speech(|s| { s.speaker_frames_written += receipt.rendered_frames; });
            }
        }
        Err(error) => {
            if let Some(stream) = stream.as_mut() { let _ = stream.abort(&mut events); }
            queue.abort_stream(&cue_id, expected_chunk_index, created_at_ms);
            let _ = authority.abort_stream(&cue_id, "native-desktop-stream-failed");
            record_renderer_failure(store, &cue_id, "native-desktop-stream-failed");
            store.watch_session_report.record_session_issue("output", "native-desktop-stream-failed", "error", &error);
            let _ = diag_log(app, "omni", "error", format!("event=native_desktop_stream_failed cueId={cue_id} error={error}"));
        }
    }
    queue.remove_desktop_timeline(response_id.as_deref().unwrap_or(""));
    store.update_speech(|s| { s.dispatch_state = "waiting-subtitle".into(); s.current_cue_id = None; });
    let _ = emit_audio_snapshot(app, store);
}

#[cfg(test)]
mod desktop_evidence_failure_tests {
    use super::*;

    fn failing_queue() -> OmniPlaybackQueue {
        let queue = OmniPlaybackQueue::new(2);
        *queue.inner.timeline_evidence.lock().unwrap() =
            super::super::desktop_timeline_evidence::TimelineEvidence::unavailable_for_test();
        queue
    }

    #[test]
    fn pre_submission_io_failure_registers_real_lineage_and_is_terminal() {
        let store = AudioStateStore::new();
        store.begin_strict_watch_terminal_lifecycle("run", "cell", "lease").unwrap();
        let queue = failing_queue();
        let error = queue.record_desktop_audio_delta("real-cue", "real-response", 1, Some(1), true).unwrap_err();
        let failure = queue.fail_desktop_evidence(&store, "real-cue", "real-response", &error).unwrap_err();
        assert!(!failure.contains("typed renderer failure edge rejected"));
        assert!(store.record_strict_watch_renderer_ack("real-cue", "speaker-render-completed", "receipt").unwrap_err()
            .contains("ACK arrived after terminal failure"));
        assert!(queue.desktop_timeline_result().is_err());
        assert!(matches!(queue.recv_timeout(Duration::ZERO), OmniPlaybackReceiveOutcome::Stopped));
    }

    #[test]
    fn post_ack_io_failure_cannot_become_a_successful_queue_outcome() {
        let store = AudioStateStore::new();
        store.begin_strict_watch_terminal_lifecycle("run", "cell", "lease").unwrap();
        store.record_strict_watch_test_session_updated().unwrap();
        store.record_strict_watch_provider_append(480).unwrap();
        store.record_strict_watch_renderer_cue_submitted("ack-cue", "ack-response").unwrap();
        store.record_strict_watch_renderer_ack("ack-cue", "speaker-render-completed", "real-receipt").unwrap();
        let queue = failing_queue();
        let error = queue.append_desktop_timeline("renderer-ack", &DesktopPlaybackTimeline {
            cue_id: "ack-cue".into(), response_id: "ack-response".into(), ..Default::default()
        }).unwrap_err();
        let failure = queue.fail_desktop_evidence(&store, "ack-cue", "ack-response", &error).unwrap_err();
        assert!(failure.contains("native-desktop-evidence-failed"));
        // An immutable physical ACK does not suppress a subsequent evidence failure.
        assert!(!failure.contains("typed renderer failure edge rejected"));
        store.record_strict_watch_response_audio_done("ack-response").unwrap();
        store.record_strict_watch_response_done("ack-response").unwrap();
        store.record_strict_watch_provider_input_closed().unwrap();
        store.record_strict_watch_session_finish_sent().unwrap();
        store.record_strict_watch_session_finished_received().unwrap();
        assert!(store.strict_watch_terminal_lifecycle_snapshot().unwrap_err().contains("native-desktop-evidence-failed"));
        assert!(queue.desktop_timeline_result().is_err());
        assert!(matches!(queue.recv_timeout(Duration::ZERO), OmniPlaybackReceiveOutcome::Stopped));
        assert_eq!(queue.inner.timeline_evidence.lock().unwrap().failure_owner(),
            Some(("ack-cue".into(), "ack-response".into())));
    }
}

#[cfg(test)]
mod desktop_wait_policy_tests {
    use super::*;

    #[test]
    fn command_receive_only_blocks_before_device_start() {
        assert_eq!(desktop_command_timeout(false), Duration::from_millis(2));
        assert_eq!(desktop_command_timeout(true), Duration::ZERO);
    }

    #[test]
    fn pre_start_command_timeout_does_not_wait_twice() {
        let mut waits = Vec::new();
        let result = wait_after_desktop_command_timeout(false, |timeout| {
            waits.push(timeout);
            Err::<(), _>("device wait must not run before Start".to_string())
        });
        assert_eq!(result, Ok(()));
        assert!(waits.is_empty());
    }

    #[test]
    fn running_command_timeout_uses_one_bounded_device_wait() {
        let mut waits = Vec::new();
        // Neither a signal nor a genuine device timeout is a terminal failure.
        for signaled in [true, false] {
            let result = wait_after_desktop_command_timeout(true, |timeout| {
                waits.push(timeout);
                Ok(signaled)
            });
            assert_eq!(result, Ok(()));
        }
        assert_eq!(waits, vec![Duration::from_millis(2); 2]);
    }

    #[test]
    fn running_device_wait_failure_remains_terminal() {
        for error in ["wasapi event wait failed", "playback permit cancelled"] {
            let result = wait_after_desktop_command_timeout(true, |timeout| {
                assert_eq!(timeout, Duration::from_millis(2));
                Err::<(), _>(error.to_string())
            });
            assert_eq!(result, Err(error.to_string()));
        }
    }
}
