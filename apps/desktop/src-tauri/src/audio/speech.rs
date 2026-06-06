use std::collections::{hash_map::DefaultHasher, HashSet, VecDeque};
use std::hash::{Hash, Hasher};
use std::num::{NonZeroU16, NonZeroU32};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait};
use rodio::{buffer::SamplesBuffer, DeviceSinkBuilder, Player};
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::bridge::ipc::write_virtual_mic_frame;
use crate::diagnostics::events::append_diagnostics_log;
use crate::provider::contracts::ProviderDraftInput;
use crate::provider::gateway::ProviderGateway;
use crate::storage::StorageStateStore;

use super::contracts::{AudioRuntimeSnapshot, SpeechDispatchEventRuntime, SubtitleCueRuntime};
use super::engine::emit_audio_snapshot;
use super::state::{AudioRouteHandle, AudioStateStore, CachedTtsAudio, CapturedSegmentAudio};

const SPEECH_POLL_INTERVAL_MS: u64 = 120;
const MAX_PROCESSED_CUES: usize = 32;
const PROMPT_TONE_MS: u32 = 90;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TranslationAudioSource {
    None,
    OmniNative,
    SubtitleTts,
}

pub(crate) fn resolve_translation_audio_source(
    config: &Value,
    omni_native_supported: bool,
) -> TranslationAudioSource {
    match config
        .pointer("/speech/translationAudioSource")
        .and_then(Value::as_str)
        .unwrap_or("auto")
    {
        "omni-native" if omni_native_supported => TranslationAudioSource::OmniNative,
        "omni-native" => TranslationAudioSource::None,
        "subtitle-tts" => TranslationAudioSource::SubtitleTts,
        _ if omni_native_supported => TranslationAudioSource::OmniNative,
        _ => TranslationAudioSource::SubtitleTts,
    }
}

pub fn start_dispatch(
    app: AppHandle,
    store: &AudioStateStore,
    config: Value,
) -> Result<AudioRuntimeSnapshot, String> {
    stop_dispatch(app.clone(), store)?;

    let initial_config = SpeechConfig::from_value(&config)?;
    store.update_speech(|speech| {
        speech.status = "ready".to_string();
        speech.dispatch_state = if initial_config.enabled {
            "waiting-subtitle".to_string()
        } else {
            "idle".to_string()
        };
        speech.policy = initial_config.priority.clone();
        speech.output_target = initial_config.output_target.clone();
        speech.ptt_gate_open = !initial_config.outbound_ptt_enabled
            || initial_config.outbound_ptt_state == "recording";
        speech.last_error = None;
    });
    let _ = append_diagnostics_log(
        &app,
        "audio",
        "info",
        "已启动 speech dispatch worker。",
        None,
        None,
        None,
    );
    emit_audio_snapshot(&app, store)?;

    let (stop_tx, stop_rx) = mpsc::channel();
    let app_handle = app.clone();
    let config_for_worker = config.clone();

    let join_handle = thread::Builder::new()
        .name("speech-dispatch".to_string())
        .spawn(move || {
            let audio_state = app_handle.state::<AudioStateStore>();
            if let Err(error) =
                run_dispatch_worker(app_handle.clone(), &audio_state, config_for_worker, stop_rx)
            {
                audio_state.update_speech(|speech| {
                    speech.status = "degraded".to_string();
                    speech.dispatch_state = "error".to_string();
                    speech.last_error = Some(error.clone());
                    push_event(speech, "speech.error", error.clone(), None, None);
                });
                let _ = append_diagnostics_log(
                    &app_handle,
                    "audio",
                    "error",
                    "speech dispatch worker 失败。",
                    Some(error),
                    None,
                    None,
                );
                let _ = emit_audio_snapshot(&app_handle, &audio_state);
            }
        })
        .map_err(|error| error.to_string())?;

    store.insert_session(
        "speech",
        AudioRouteHandle {
            stop_tx,
            join_handle,
        },
    );
    Ok(store.snapshot())
}

pub fn stop_dispatch(
    app: AppHandle,
    store: &AudioStateStore,
) -> Result<AudioRuntimeSnapshot, String> {
    if let Some(handle) = store.take_session("speech") {
        let _ = handle.stop_tx.send(());
        let _ = handle.join_handle.join();
    }

    store.update_speech(|speech| {
        speech.dispatch_state = "idle".to_string();
        speech.current_cue_id = None;
        speech.current_request_id = None;
        speech.last_error = None;
        push_event(
            speech,
            "speech.stopped",
            "译音调度已停止。".to_string(),
            None,
            None,
        );
    });
    let _ = append_diagnostics_log(
        &app,
        "audio",
        "info",
        "已停止 speech dispatch worker。",
        None,
        None,
        None,
    );
    emit_audio_snapshot(&app, store)?;
    Ok(store.snapshot())
}

fn run_dispatch_worker(
    app: AppHandle,
    store: &AudioStateStore,
    initial_config: Value,
    stop_rx: mpsc::Receiver<()>,
) -> Result<(), String> {
    let gateway = ProviderGateway::new();
    let storage = app.state::<StorageStateStore>();
    let mut processed = HashSet::new();
    let mut processed_order = VecDeque::new();
    let mut processed_segment_slots = HashSet::new();
    let mut processed_segment_slot_order = VecDeque::new();
   let initial_speech_config = SpeechConfig::from_value(&initial_config)?;
   // When the dispatch worker is started with speech enabled (e.g. secondary
   // subtitle TTS is active), pin to the initial config regardless of the
   // OMNI_WATCH_MODE_AUTOSTART env var. Elevated desktop shell processes may
   // not inherit the runner's env vars, causing the worker to reload a stale
   // stored config that lacks outputSpeechEnabled/translationAudioSource.
   let use_initial_config = initial_speech_config.enabled
       || std::env::var("OMNI_WATCH_MODE_AUTOSTART")
       .map(|value| matches!(value.trim(), "1" | "true" | "TRUE" | "yes" | "YES"))
       .unwrap_or(false);

   loop {
        if stop_rx.try_recv().is_ok() {
            break;
        }

        let config_value = if use_initial_config {
            initial_config.clone()
        } else {
            storage
                .load_config()
                .unwrap_or_else(|_| initial_config.clone())
        };
        let config = SpeechConfig::from_value(&config_value)?;
        let snapshot = store.snapshot();
        let pending_tasks: Vec<SpeechDispatchTask> = snapshot
            .subtitle_overlay
            .recent_cues
            .iter()
            .rev()
            .flat_map(|cue| speech_dispatch_tasks_for_cue(cue, &config))
            .filter(|task| !is_processed_task(task, &processed, &processed_segment_slots))
            .collect();
        let ptt_gate_open =
            !config.outbound_ptt_enabled || config.outbound_ptt_state == "recording";

        store.update_speech(|speech| {
            speech.status = "ready".to_string();
            speech.policy = config.priority.clone();
            speech.output_target = config.output_target.clone();
            speech.queue_depth = pending_tasks.len();
            speech.ptt_gate_open = ptt_gate_open;
            if !config.enabled {
                speech.dispatch_state = "idle".to_string();
            } else if pending_tasks.is_empty() && speech.dispatch_state != "playing" {
                speech.dispatch_state = "waiting-subtitle".to_string();
            }
        });
        emit_audio_snapshot(&app, store)?;

        if !config.enabled || pending_tasks.is_empty() {
            thread::sleep(Duration::from_millis(SPEECH_POLL_INTERVAL_MS));
            continue;
        }

        let mut blocked_by_ptt = false;
        for task in pending_tasks {
            if task.cue.route_direction == "outbound"
                && config.outbound_ptt_enabled
                && config.outbound_ptt_state != "recording"
            {
                blocked_by_ptt = true;
                store.update_speech(|speech| {
                    speech.dispatch_state = "queued".to_string();
                    push_event(
                        speech,
                        "speech.ptt-blocked",
                        "Push-to-talk 未打开，出站译音继续排队。".to_string(),
                        Some(task.cue.cue_id.clone()),
                        None,
                    );
                });
                let _ = append_diagnostics_log(
                    &app,
                    "audio",
                    "warning",
                    "Push-to-talk 未打开，出站译音继续排队。",
                    Some(format!("cue={}", task.cue.cue_id)),
                    None,
                    None,
                );
                emit_audio_snapshot(&app, store)?;
                break;
            }

            let dispatch_key = task.dispatch_key();
            match process_task(&app, store, &gateway, &task, &config) {
                Ok(()) => {
                    remember_processed(&mut processed, &mut processed_order, &dispatch_key);
                    remember_segment_slot_processed(
                        &task,
                        &mut processed_segment_slots,
                        &mut processed_segment_slot_order,
                    );
                }
                Err(error) => {
                    remember_processed(&mut processed, &mut processed_order, &dispatch_key);
                    remember_segment_slot_processed(
                        &task,
                        &mut processed_segment_slots,
                        &mut processed_segment_slot_order,
                    );
                    let diagnostics_error = error.clone();
                    store.update_speech(|speech| {
                        speech.status = "degraded".to_string();
                        speech.dispatch_state = "error".to_string();
                        speech.last_error = Some(error.clone());
                        push_event(
                            speech,
                            "speech.error",
                            error,
                            Some(task.cue.cue_id.clone()),
                            None,
                        );
                    });
                    let _ = append_diagnostics_log(
                        &app,
                        "audio",
                        "error",
                        "译音任务失败。",
                        Some(format!(
                            "cue={} segmentIndex={} error={}",
                            task.cue.cue_id, task.segment_index, diagnostics_error
                        )),
                        None,
                        None,
                    );
                    emit_audio_snapshot(&app, store)?;
                }
            }
        }

        if blocked_by_ptt {
            thread::sleep(Duration::from_millis(SPEECH_POLL_INTERVAL_MS));
            continue;
        }

        thread::sleep(Duration::from_millis(40));
    }

    Ok(())
}

#[derive(Clone)]
struct SpeechDispatchTask {
    cue: SubtitleCueRuntime,
    segment_index: usize,
    source_text: String,
    translated_text: String,
    segment_mode: bool,
}

impl SpeechDispatchTask {
    fn dispatch_key(&self) -> String {
        let mut hasher = DefaultHasher::new();
        self.cue.cue_id.hash(&mut hasher);
        self.segment_index.hash(&mut hasher);
        self.source_text.hash(&mut hasher);
        self.translated_text.hash(&mut hasher);
        format!(
            "{}:{}:{:016x}",
            self.cue.cue_id,
            self.segment_index,
            hasher.finish()
        )
    }

    fn cache_key(&self, config: &SpeechConfig) -> String {
        let mut hasher = DefaultHasher::new();
        self.translated_text.hash(&mut hasher);
        format!(
            "{}:{}:{}:{}:{}:{:016x}",
            self.cue.cue_id,
            self.segment_index,
            config.voice,
            config.target_language,
            config.provider.model,
            hasher.finish(),
        )
    }

    fn segment_slot_key(&self) -> Option<String> {
        if self.segment_mode {
            Some(format!("{}:{}", self.cue.cue_id, self.segment_index))
        } else {
            None
        }
    }
}

fn process_task(
    app: &AppHandle,
    store: &AudioStateStore,
    gateway: &ProviderGateway,
    task: &SpeechDispatchTask,
    config: &SpeechConfig,
) -> Result<(), String> {
    let cue = &task.cue;
    let delay_ms = config.dispatch_delay_ms(&cue.route_direction);
    if delay_ms > 0 {
        store.update_speech(|speech| {
            speech.dispatch_state = "deferred".to_string();
            speech.current_cue_id = Some(cue.cue_id.clone());
            speech.last_started_at = Some(now_marker());
            push_event(
                speech,
                "speech.deferred",
                format!("字幕优先策略生效，延迟 {} ms 后再发起译音。", delay_ms),
                Some(cue.cue_id.clone()),
                None,
            );
        });
        emit_audio_snapshot(app, store)?;
        thread::sleep(Duration::from_millis(delay_ms));
    }

    let _ = append_diagnostics_log(
        app,
        "audio",
        "info",
        "speech.segment_tts_queued",
        Some(format!(
            "cue={} segmentIndex={} segmentMode={} sourceChars={} translatedChars={}",
            cue.cue_id,
            task.segment_index,
            task.segment_mode,
            task.source_text.chars().count(),
            task.translated_text.chars().count()
        )),
        None,
        None,
    );

    let cache_key = task.cache_key(config);
    let (request_id, sample_rate_hz, channel_count, translated_pcm, cache_hit) =
        if let Some(cached) = store.tts_audio(&cache_key) {
            (
                cached.request_id,
                cached.sample_rate_hz,
                cached.channel_count,
                cached.pcm_i16,
                true,
            )
        } else {
            let _ = append_diagnostics_log(
                app,
                "audio",
                "info",
                "speech.segment_tts_requested",
                Some(format!(
                    "cue={} segmentIndex={} translatedChars={} provider={} model={}",
                    cue.cue_id,
                    task.segment_index,
                    task.translated_text.chars().count(),
                    config.provider.provider_id,
                    config.provider.model
                )),
                None,
                None,
            );
            let synthesis = gateway
                .synthesize_realtime_audio(
                    config.provider.clone(),
                    task.translated_text.clone(),
                    config.target_language.clone(),
                    config.voice.clone(),
                )
                .map_err(|error| error.message)?;
            store.cache_tts_audio(CachedTtsAudio {
                cache_key: cache_key.clone(),
                request_id: synthesis.request_id.clone(),
                sample_rate_hz: synthesis.audio.sample_rate_hz,
                channel_count: synthesis.audio.channel_count,
                pcm_i16: synthesis.audio.pcm_i16.clone(),
            });
            (
                synthesis.request_id,
                synthesis.audio.sample_rate_hz,
                synthesis.audio.channel_count,
                synthesis.audio.pcm_i16,
                false,
            )
        };

    let mix = build_mix_plan(
        cue,
        store.segment_audio(&cue.cue_id),
        translated_pcm,
        sample_rate_hz,
        channel_count,
        config,
    );
    store.update_speech(|speech| {
        speech.dispatch_state = "playing".to_string();
        speech.current_cue_id = Some(cue.cue_id.clone());
        speech.current_request_id = Some(request_id.clone());
        speech.mix_mode = mix.mix_mode.clone();
        speech.ducking_active = mix.ducking_active;
        speech.last_started_at = Some(now_marker());
        push_event(
            speech,
            if cache_hit {
                "speech.cache-hit"
            } else {
                "speech.realtime-audio-requested"
            },
            if cache_hit {
                "命中 Realtime 音频缓存，直接进入混音和输出。".to_string()
            } else {
                "已完成 Realtime audio 请求，进入混音和输出。".to_string()
            },
            Some(cue.cue_id.clone()),
            Some(request_id.clone()),
        );
    });
    emit_audio_snapshot(app, store)?;

    let output_route = SpeechOutputRoutePlan::new(
        config.local_playback_enabled,
        config.virtual_mic_output_enabled,
    );
    let speaker_frames = if output_route.play_to_speaker {
        let echo_reference = i16_to_f32(&mix.speaker_samples);
        store.push_echo_reference(&echo_reference, mix.sample_rate_hz, mix.channel_count);
        let frames = play_to_speaker(
            &mix.speaker_samples,
            mix.sample_rate_hz,
            mix.channel_count,
            config.speaker_device_id.as_deref(),
            config.speaker_output_level,
        )?;
        let _ = append_diagnostics_log(
            app,
            "audio",
            "info",
            if task.segment_mode {
                "speech.segment_playback_written"
            } else {
                "speech.speaker_playback_written"
            },
            Some(format!(
                "cue={} segmentIndex={} frames={} sampleRateHz={} channels={} outputLevel={} deviceId={}",
                cue.cue_id,
                task.segment_index,
                frames,
                mix.sample_rate_hz,
                mix.channel_count,
                config.speaker_output_level,
                config.speaker_device_id.as_deref().unwrap_or("default")
            )),
            None,
            None,
        );
        frames
    } else {
        let _ = append_diagnostics_log(
            app,
            "audio",
            "warning",
            if task.segment_mode {
                "speech.segment_playback_skipped"
            } else {
                "speech.speaker_playback_skipped"
            },
            Some(format!(
                "cue={} segmentIndex={} localPlaybackEnabled={} outputTarget={} deviceId={}",
                cue.cue_id,
                task.segment_index,
                config.local_playback_enabled,
                config.output_target,
                config.speaker_device_id.as_deref().unwrap_or("default")
            )),
            None,
            None,
        );
        0
    };
    let virtual_mic_frames = if output_route.write_to_virtual_mic {
        write_virtual_mic_frame(
            app,
            &cue.cue_id,
            &request_id,
            &mix.virtual_mic_samples,
            mix.sample_rate_hz,
            mix.channel_count,
        )?
    } else {
        0
    };

    store.update_speech(|speech| {
        speech.dispatch_state = "waiting-subtitle".to_string();
        speech.current_cue_id = None;
        speech.current_request_id = None;
        speech.last_completed_at = Some(now_marker());
        speech.speaker_frames_written += speaker_frames;
        speech.virtual_mic_frames_written += virtual_mic_frames;
        speech.last_error = None;
        push_event(
            speech,
            "speech.completed",
            format!(
                "译音输出完成，speaker={} 帧 / virtual-mic={} 帧。",
                speaker_frames, virtual_mic_frames
            ),
            Some(cue.cue_id.clone()),
            Some(request_id),
        );
    });
    let _ = append_diagnostics_log(
        app,
        "audio",
        "info",
        format!("译音输出完成，cue={}。", cue.cue_id),
        Some(format!(
            "speakerFrames={} virtualMicFrames={}",
            speaker_frames, virtual_mic_frames
        )),
        None,
        None,
    );
    emit_audio_snapshot(app, store)?;

    Ok(())
}

fn remember_processed(processed: &mut HashSet<String>, order: &mut VecDeque<String>, cue_id: &str) {
    processed.insert(cue_id.to_string());
    order.push_back(cue_id.to_string());
    while order.len() > MAX_PROCESSED_CUES {
        if let Some(expired) = order.pop_front() {
            processed.remove(&expired);
        }
    }
}

fn is_processed_task(
    task: &SpeechDispatchTask,
    processed: &HashSet<String>,
    processed_segment_slots: &HashSet<String>,
) -> bool {
    processed.contains(&task.dispatch_key())
        || task
            .segment_slot_key()
            .is_some_and(|slot_key| processed_segment_slots.contains(&slot_key))
}

fn remember_segment_slot_processed(
    task: &SpeechDispatchTask,
    processed_segment_slots: &mut HashSet<String>,
    order: &mut VecDeque<String>,
) {
    let Some(slot_key) = task.segment_slot_key() else {
        return;
    };
    processed_segment_slots.insert(slot_key.clone());
    order.push_back(slot_key);
    while order.len() > MAX_PROCESSED_CUES {
        if let Some(expired) = order.pop_front() {
            processed_segment_slots.remove(&expired);
        }
    }
}

fn is_speech_ready_cue(cue: &SubtitleCueRuntime) -> bool {
    if cue.translated_text.trim().is_empty() {
        return false;
    }
    if cue.committed {
        return true;
    }
    !cue.display_segments.is_empty()
        && cue
            .display_segments
            .iter()
            .filter(|segment| !segment.translated_text.trim().is_empty())
            .all(|segment| !segment.pending)
}

fn speech_dispatch_tasks_for_cue(
    cue: &SubtitleCueRuntime,
    config: &SpeechConfig,
) -> Vec<SpeechDispatchTask> {
    if config.secondary_segment_tts_enabled {
        return cue
            .display_segments
            .iter()
            .enumerate()
            .filter(|(_, segment)| !segment.pending && !segment.translated_text.trim().is_empty())
            .map(|(index, segment)| SpeechDispatchTask {
                cue: cue.clone(),
                segment_index: index,
                source_text: segment.source_text.clone(),
                translated_text: segment.translated_text.clone(),
                segment_mode: true,
            })
            .collect();
    }

    if !is_speech_ready_cue(cue) {
        return Vec::new();
    }
    vec![SpeechDispatchTask {
        cue: cue.clone(),
        segment_index: 0,
        source_text: cue.display_source_text.clone(),
        translated_text: cue.translated_text.clone(),
        segment_mode: false,
    }]
}

fn push_event(
    speech: &mut super::contracts::SpeechRuntimeSnapshot,
    kind: &str,
    summary: String,
    cue_id: Option<String>,
    request_id: Option<String>,
) {
    let event = SpeechDispatchEventRuntime {
        event_id: format!("{}-{}", kind, now_marker()),
        kind: kind.to_string(),
        summary,
        emitted_at: now_marker(),
        cue_id,
        request_id,
    };
    speech.recent_events.insert(0, event);
    if speech.recent_events.len() > 8 {
        speech.recent_events.truncate(8);
    }
}

struct MixPlan {
    speaker_samples: Vec<i16>,
    virtual_mic_samples: Vec<i16>,
    sample_rate_hz: u32,
    channel_count: u16,
    mix_mode: String,
    ducking_active: bool,
}

fn build_mix_plan(
    cue: &SubtitleCueRuntime,
    captured_audio: Option<CapturedSegmentAudio>,
    translated_pcm: Vec<i16>,
    sample_rate_hz: u32,
    channel_count: u16,
    config: &SpeechConfig,
) -> MixPlan {
    let route_mix = if cue.route_direction == "outbound" {
        &config.outbound_mix
    } else {
        &config.inbound_mix
    };
    let mut translated = apply_i16_gain(&translated_pcm, route_mix.translated_audio_gain_db);
    let prompt = generate_prompt_tone(sample_rate_hz, PROMPT_TONE_MS);
    let mut translated_with_prompt = prompt;
    translated_with_prompt.append(&mut translated);

    let original = if route_mix.keep_original_audio {
        captured_audio
            .as_ref()
            .map(convert_captured_audio_to_mono_i16_24k)
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let original_gain_db = if route_mix.ducking_enabled {
        route_mix.original_audio_gain_db - route_mix.ducking_depth_percent as f32 / 10.0
    } else {
        route_mix.original_audio_gain_db
    };
    let original = apply_i16_gain(&original, original_gain_db);
    let mixed = if !original.is_empty() {
        mix_pcm_tracks(&original, &translated_with_prompt)
    } else {
        translated_with_prompt.clone()
    };
    let speaker_samples = if config.local_playback_enabled {
        mixed.clone()
    } else {
        Vec::new()
    };
    let virtual_mic_samples = if config.virtual_mic_output_enabled {
        scale_i16_by_output_level(&mixed, config.speaker_output_level)
    } else {
        Vec::new()
    };

    MixPlan {
        speaker_samples,
        virtual_mic_samples,
        sample_rate_hz,
        channel_count,
        mix_mode: if !original.is_empty() {
            "original-plus-translated".to_string()
        } else {
            "translated-plus-prompt".to_string()
        },
        ducking_active: route_mix.ducking_enabled && !original.is_empty(),
    }
}

fn apply_i16_gain(samples: &[i16], gain_db: f32) -> Vec<i16> {
    let gain = 10_f32.powf(gain_db / 20.0);
    samples
        .iter()
        .map(|sample| ((*sample as f32) * gain).clamp(i16::MIN as f32, i16::MAX as f32) as i16)
        .collect()
}

pub(crate) fn scale_i16_by_output_level(samples: &[i16], output_level: u64) -> Vec<i16> {
    let volume = playback_volume(output_level);
    samples
        .iter()
        .map(|sample| ((*sample as f32) * volume).clamp(i16::MIN as f32, i16::MAX as f32) as i16)
        .collect()
}

fn mix_pcm_tracks(left: &[i16], right: &[i16]) -> Vec<i16> {
    let len = left.len().max(right.len());
    let mut mixed = Vec::with_capacity(len);
    for index in 0..len {
        let lhs = left.get(index).copied().unwrap_or(0) as i32;
        let rhs = right.get(index).copied().unwrap_or(0) as i32;
        mixed.push((lhs + rhs).clamp(i16::MIN as i32, i16::MAX as i32) as i16);
    }
    mixed
}

fn convert_captured_audio_to_mono_i16_24k(audio: &CapturedSegmentAudio) -> Vec<i16> {
    let mut mono = Vec::new();
    let frame_stride = audio.channel_count as usize * 4;
    if frame_stride == 0 {
        return mono;
    }

    for (frame_index, frame) in audio.pcm_f32le.chunks_exact(frame_stride).enumerate() {
        if audio.sample_rate_hz >= 48_000 && frame_index % 2 == 1 {
            continue;
        }

        let mut sample_sum = 0.0_f32;
        for channel_index in 0..audio.channel_count as usize {
            let offset = channel_index * 4;
            sample_sum += f32::from_le_bytes([
                frame[offset],
                frame[offset + 1],
                frame[offset + 2],
                frame[offset + 3],
            ]);
        }
        let sample = sample_sum / audio.channel_count.max(1) as f32;
        mono.push((sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16);
    }

    mono
}

fn generate_prompt_tone(sample_rate_hz: u32, duration_ms: u32) -> Vec<i16> {
    let sample_count = (sample_rate_hz as u64 * duration_ms as u64 / 1_000) as usize;
    let mut tone = Vec::with_capacity(sample_count);
    for index in 0..sample_count {
        let phase = index as f32 / sample_rate_hz as f32;
        let envelope = if index < 200 {
            index as f32 / 200.0
        } else if sample_count.saturating_sub(index) < 200 {
            sample_count.saturating_sub(index) as f32 / 200.0
        } else {
            1.0
        };
        tone.push(
            ((phase * 2.0 * std::f32::consts::PI * 880.0).sin() * envelope * 0.18 * i16::MAX as f32)
                as i16,
        );
    }
    tone
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct SpeechOutputRoutePlan {
    pub(crate) play_to_speaker: bool,
    pub(crate) write_to_virtual_mic: bool,
}

impl SpeechOutputRoutePlan {
    pub(crate) fn new(local_playback_enabled: bool, virtual_mic_output_enabled: bool) -> Self {
        Self {
            play_to_speaker: local_playback_enabled,
            write_to_virtual_mic: virtual_mic_output_enabled,
        }
    }
}

pub(crate) fn desktop_direct_playback_enabled_for_config(config: &Value) -> bool {
    let local_playback_enabled = config
        .pointer("/speech/localPlaybackEnabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let explicit_physical_output = config
        .pointer("/devices/outputDeviceId")
        .and_then(Value::as_str)
        .filter(|value| !is_default_output_device_alias(value))
        .is_some();
    let virtual_driver_isolation = config
        .pointer("/devices/feedbackLoopPrevention")
        .and_then(Value::as_str)
        == Some("virtual-driver");

    local_playback_enabled && (!virtual_driver_isolation || explicit_physical_output)
}

pub(crate) fn play_to_speaker(
    samples: &[i16],
    sample_rate_hz: u32,
    channel_count: u16,
    device_id: Option<&str>,
    output_level: u64,
) -> Result<u64, String> {
    if samples.is_empty() {
        return Ok(0);
    }

    let sink = match device_id.filter(|id| !is_default_output_device_alias(id)) {
        Some(device_id) => {
            let host = cpal::default_host();
            let device = host
                .output_devices()
                .map_err(|error| error.to_string())?
                .find(|device| speaker_output_device_matches(device, device_id))
                .ok_or_else(|| {
                    format!("configured speaker output device not found: {device_id}")
                })?;
            DeviceSinkBuilder::from_device(device)
                .and_then(|builder| builder.open_sink_or_fallback())
                .map_err(|error| error.to_string())?
        }
        None => DeviceSinkBuilder::open_default_sink().map_err(|error| error.to_string())?,
    };
    let player = Player::connect_new(sink.mixer());
    player.set_volume(playback_volume(output_level));
    let source = SamplesBuffer::new(
        NonZeroU16::new(channel_count).ok_or_else(|| "channel count cannot be zero".to_string())?,
        NonZeroU32::new(sample_rate_hz).ok_or_else(|| "sample rate cannot be zero".to_string())?,
        samples
            .iter()
            .map(|sample| *sample as f32 / i16::MAX as f32)
            .collect::<Vec<_>>(),
    );
    player.append(source);
    player.sleep_until_end();
    Ok((samples.len() / channel_count as usize) as u64)
}

fn playback_volume(output_level: u64) -> f32 {
    output_level.min(100) as f32 / 100.0
}

fn is_default_output_device_alias(device_id: &str) -> bool {
    matches!(
        device_id.trim(),
        "" | "default" | "speaker-default" | "system-output-default"
    )
}

fn speaker_output_device_matches(device: &cpal::Device, requested: &str) -> bool {
    device.id().map(|id| id.1 == requested).unwrap_or(false)
        || device
            .description()
            .map(|description| {
                normalized_device_name(description.name())
                    .contains(&normalized_device_name(requested))
            })
            .unwrap_or(false)
}

fn normalized_device_name(value: &str) -> String {
    value
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .flat_map(char::to_lowercase)
        .collect()
}

pub(crate) fn i16_to_f32(samples: &[i16]) -> Vec<f32> {
    samples
        .iter()
        .map(|sample| *sample as f32 / i16::MAX as f32)
        .collect()
}

use super::time_utils::now_marker;

#[derive(Clone)]
#[allow(dead_code)]
struct RouteMixConfig {
    keep_original_audio: bool,
    translated_audio_enabled: bool,
    translated_audio_gain_db: f32,
    original_audio_gain_db: f32,
    ducking_enabled: bool,
    ducking_depth_percent: u64,
}

#[derive(Clone)]
struct SpeechConfig {
    provider: ProviderDraftInput,
    enabled: bool,
    target_language: String,
    #[allow(dead_code)]
    voice_preset_id: String,
    voice: String,
    output_target: String,
    local_playback_enabled: bool,
    virtual_mic_output_enabled: bool,
    speaker_device_id: Option<String>,
    speaker_output_level: u64,
    priority: String,
    inbound_delay_ms: u64,
    outbound_delay_ms: u64,
    outbound_ptt_enabled: bool,
    outbound_ptt_state: String,
    inbound_mix: RouteMixConfig,
    outbound_mix: RouteMixConfig,
    secondary_segment_tts_enabled: bool,
}

impl SpeechConfig {
    fn from_value(config: &Value) -> Result<Self, String> {
        let provider = config
            .get("providers")
            .and_then(Value::as_array)
            .and_then(|arr| arr.first())
            .and_then(|v| serde_json::from_value::<ProviderDraftInput>(v.clone()).ok())
            .unwrap_or_else(|| {
                serde_json::from_value(Value::Null).expect("default provider should parse")
            });
        let secondary_translation_active = config
            .pointer("/devices/subtitleTranslationMode")
            .and_then(Value::as_str)
            == Some("secondary")
            && config
                .pointer("/devices/subtitleTranslationModelId")
                .and_then(Value::as_str)
                .map(|value| !value.trim().is_empty())
                .unwrap_or(false);
        let secondary_audio_enabled = config
            .pointer("/devices/outputSpeechEnabled")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let tts_model_candidates = [
            config
                .pointer("/devices/inboundSecondaryAudioModelId")
                .and_then(Value::as_str)
                .filter(|model| {
                    secondary_translation_active
                        && secondary_audio_enabled
                        && !model.trim().is_empty()
                }),
            config
                .pointer("/speech/textToSpeechModelId")
                .and_then(Value::as_str)
                .filter(|model| !model.trim().is_empty()),
            config
                .pointer("/devices/textToSpeechModelId")
                .and_then(Value::as_str)
                .filter(|model| !model.trim().is_empty()),
            config
                .pointer("/devices/outboundVoiceModelId")
                .and_then(Value::as_str)
                .filter(|model| !model.trim().is_empty()),
        ];
        let mut provider = tts_model_candidates
            .into_iter()
            .flatten()
            .filter(|model| !is_livetranslate_model_id(model))
            .find_map(|model| resolve_model_provider_from_config_value(config, model))
            .unwrap_or(provider);
        let secondary_segment_tts_enabled = secondary_translation_active
            && secondary_audio_enabled
            && resolve_translation_audio_source(config, true)
                == TranslationAudioSource::SubtitleTts;
        if secondary_segment_tts_enabled
            && provider.kind == "dashscope"
            && is_livetranslate_model_id(&provider.model)
        {
            provider.model = "qwen3.5-omni-plus-realtime".to_string();
        }
        Ok(Self {
            provider,
            enabled: config
                .pointer("/speech/enabled")
                .and_then(Value::as_bool)
                .unwrap_or(false)
                || secondary_segment_tts_enabled,
            target_language: config
                .pointer("/speech/targetLanguage")
                .and_then(Value::as_str)
                .unwrap_or("zh-CN")
                .to_string(),
            voice_preset_id: config
                .pointer("/speech/voicePresetId")
                .and_then(Value::as_str)
                .unwrap_or("voice-cn-neutral")
                .to_string(),
            voice: config
                .pointer("/speech/voice")
                .and_then(Value::as_str)
                .unwrap_or("Ethan")
                .to_string(),
            output_target: config
                .pointer("/speech/outputTarget")
                .and_then(Value::as_str)
                .unwrap_or("speaker")
                .to_string(),
            local_playback_enabled: desktop_direct_playback_enabled_for_config(config),
            virtual_mic_output_enabled: config
                .pointer("/speech/virtualMicOutputEnabled")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            speaker_device_id: config
                .pointer("/devices/outputDeviceId")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .map(str::to_string),
            speaker_output_level: config
                .pointer("/devices/outputLevel")
                .and_then(Value::as_u64)
                .unwrap_or(100)
                .min(100),
            priority: config
                .pointer("/subtitles/priority")
                .and_then(Value::as_str)
                .unwrap_or("subtitle-first")
                .to_string(),
            inbound_delay_ms: config
                .pointer("/devices/inboundRoute/latencyControl/translationBufferMs")
                .and_then(Value::as_u64)
                .unwrap_or(120)
                + config
                    .pointer("/devices/inboundRoute/latencyControl/playbackBufferMs")
                    .and_then(Value::as_u64)
                    .unwrap_or(40),
            outbound_delay_ms: config
                .pointer("/devices/outboundRoute/latencyControl/translationBufferMs")
                .and_then(Value::as_u64)
                .unwrap_or(90)
                + config
                    .pointer("/devices/outboundRoute/latencyControl/playbackBufferMs")
                    .and_then(Value::as_u64)
                    .unwrap_or(50),
            outbound_ptt_enabled: config
                .pointer("/devices/outboundRoute/pushToTalk/enabled")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            outbound_ptt_state: config
                .pointer("/devices/outboundRoute/pushToTalk/state")
                .and_then(Value::as_str)
                .unwrap_or("idle")
                .to_string(),
            inbound_mix: parse_mix(config, "/devices/inboundRoute/mixControl"),
            outbound_mix: parse_mix(config, "/devices/outboundRoute/mixControl"),
            secondary_segment_tts_enabled,
        })
    }

    fn dispatch_delay_ms(&self, direction: &str) -> u64 {
        if self.priority != "subtitle-first" {
            return 0;
        }

        if direction == "outbound" {
            self.outbound_delay_ms
        } else {
            self.inbound_delay_ms
        }
    }
}

pub(crate) fn speech_output_enabled(config: &Value) -> bool {
    config
        .pointer("/speech/enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || config
            .pointer("/devices/outputSpeechEnabled")
            .and_then(Value::as_bool)
            .unwrap_or(false)
}

#[cfg(test)]
mod translation_audio_source_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn legacy_config_automatically_prefers_omni_native_audio() {
        assert_eq!(
            resolve_translation_audio_source(&json!({}), true),
            TranslationAudioSource::OmniNative
        );
    }

    #[test]
    fn automatic_source_falls_back_to_subtitle_tts_without_native_audio() {
        assert_eq!(
            resolve_translation_audio_source(&json!({}), false),
            TranslationAudioSource::SubtitleTts
        );
    }

    #[test]
    fn explicit_unsupported_omni_native_source_stays_silent() {
        assert_eq!(
            resolve_translation_audio_source(
                &json!({ "speech": { "translationAudioSource": "omni-native" } }),
                false
            ),
            TranslationAudioSource::None
        );
    }

    #[test]
    fn explicit_subtitle_tts_ignores_available_native_audio() {
        assert_eq!(
            resolve_translation_audio_source(
                &json!({ "speech": { "translationAudioSource": "subtitle-tts" } }),
                true
            ),
            TranslationAudioSource::SubtitleTts
        );
    }
}

fn resolve_model_provider_from_config_value(
    config: &Value,
    composite_model_id: &str,
) -> Option<ProviderDraftInput> {
    let requested_model = composite_model_id.trim();
    if requested_model.is_empty() {
        return None;
    }
    let providers = config
        .get("providers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    if let Some((template_id, model_id)) = requested_model.split_once("::") {
        for provider_value in &providers {
            let parsed: Option<ProviderDraftInput> =
                serde_json::from_value(provider_value.clone()).ok();
            if let Some(mut provider) = parsed {
                if provider.template_id == template_id {
                    provider.model = model_id.to_string();
                    return Some(provider);
                }
            }
        }
        return None;
    }

    providers
        .iter()
        .filter_map(|provider_value| {
            serde_json::from_value::<ProviderDraftInput>(provider_value.clone()).ok()
        })
        .find(|provider| provider.kind == "dashscope")
        .map(|mut provider| {
            provider.model = requested_model.to_string();
            provider
        })
}

fn is_livetranslate_model_id(model_id: &str) -> bool {
    let lower = model_id.to_ascii_lowercase();
    lower.contains("livetranslate")
}

fn parse_mix(config: &Value, prefix: &str) -> RouteMixConfig {
    RouteMixConfig {
        keep_original_audio: config
            .pointer(&format!("{prefix}/keepOriginalAudio"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        translated_audio_enabled: config
            .pointer(&format!("{prefix}/translatedAudioEnabled"))
            .and_then(Value::as_bool)
            .unwrap_or(true),
        translated_audio_gain_db: config
            .pointer(&format!("{prefix}/translatedAudioGainDb"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0) as f32,
        original_audio_gain_db: config
            .pointer(&format!("{prefix}/originalAudioGainDb"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0) as f32,
        ducking_enabled: config
            .pointer(&format!("{prefix}/duckingEnabled"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        ducking_depth_percent: config
            .pointer(&format!("{prefix}/duckingDepthPercent"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
    }
}

#[cfg(test)]
mod tests {
    use super::super::contracts::SubtitleDisplaySegmentRuntime;
    use super::*;
    use serde_json::json;

    fn provider_input() -> ProviderDraftInput {
        ProviderDraftInput {
            template_id: "template".to_string(),
            provider_id: "provider".to_string(),
            kind: "openai-compatible".to_string(),
            display_name: "Provider".to_string(),
            model: "tts-model".to_string(),
            base_url: "http://127.0.0.1:1".to_string(),
            transport: "http".to_string(),
            auth_ref: crate::provider::contracts::ProviderAuthRefInput {
                kind: "credential-ref".to_string(),
                reference: "none".to_string(),
                header_name: "Authorization".to_string(),
                scheme: "none".to_string(),
            },
            region: None,
            stream_enabled: false,
            timeout_ms: 1000,
            system_prompt_template: "video-realtime-cn".to_string(),
            temperature: 0.2,
            max_output_tokens: 256,
            response_modalities: vec!["text".to_string()],
            custom_headers: vec![],
            scene_model_assignments: vec![],
            local_model_capability_registry: vec![],
            model_catalog_cache: Default::default(),
        }
    }

    #[test]
    fn build_mix_plan_adds_prompt_and_original_audio() {
        let cue = SubtitleCueRuntime {
            cue_id: "cue-outbound-1".to_string(),
            route_direction: "outbound".to_string(),
            source_text: "source".to_string(),
            display_source_text: String::new(),
            display_segments: vec![],
            translated_text: "translated".to_string(),
            started_at: "unix-ms:1".to_string(),
            ended_at: "unix-ms:2".to_string(),
            committed: true,
        };
        let config = SpeechConfig {
            provider: provider_input(),
            enabled: true,
            target_language: "zh-CN".to_string(),
            voice_preset_id: "voice-cn-neutral".to_string(),
            voice: "Ethan".to_string(),
            output_target: "both".to_string(),
            local_playback_enabled: true,
            virtual_mic_output_enabled: true,
            speaker_device_id: None,
            speaker_output_level: 100,
            priority: "subtitle-first".to_string(),
            inbound_delay_ms: 0,
            outbound_delay_ms: 0,
            outbound_ptt_enabled: false,
            outbound_ptt_state: "recording".to_string(),
            inbound_mix: RouteMixConfig {
                keep_original_audio: false,
                translated_audio_enabled: true,
                translated_audio_gain_db: 0.0,
                original_audio_gain_db: 0.0,
                ducking_enabled: false,
                ducking_depth_percent: 0,
            },
            outbound_mix: RouteMixConfig {
                keep_original_audio: true,
                translated_audio_enabled: true,
                translated_audio_gain_db: 0.0,
                original_audio_gain_db: 0.0,
                ducking_enabled: true,
                ducking_depth_percent: 30,
            },
            secondary_segment_tts_enabled: false,
        };
        let captured = CapturedSegmentAudio {
            cue_id: cue.cue_id.clone(),
            route_direction: cue.route_direction.clone(),
            sample_rate_hz: 48_000,
            channel_count: 2,
            pcm_f32le: vec![0, 0, 64, 63, 0, 0, 64, 63, 0, 0, 64, 63, 0, 0, 64, 63],
        };

        let plan = build_mix_plan(
            &cue,
            Some(captured),
            vec![2000, -2000, 1000, -1000],
            24_000,
            1,
            &config,
        );

        assert!(!plan.speaker_samples.is_empty());
        assert!(!plan.virtual_mic_samples.is_empty());
        assert_eq!(plan.mix_mode, "original-plus-translated");
        assert!(plan.ducking_active);
    }

    #[test]
    fn output_route_plan_keeps_local_playback_and_virtual_mic_as_independent_targets() {
        let plan = SpeechOutputRoutePlan::new(true, true);

        assert!(plan.play_to_speaker);
        assert!(plan.write_to_virtual_mic);
    }

    #[test]
    fn output_route_plan_does_not_require_virtual_mic_for_local_playback() {
        let plan = SpeechOutputRoutePlan::new(true, false);

        assert!(plan.play_to_speaker);
        assert!(!plan.write_to_virtual_mic);
    }

    #[test]
    fn virtual_driver_feedback_prevention_disables_local_playback() {
        let config = json!({
            "devices": {
                "feedbackLoopPrevention": "virtual-driver"
            },
            "speech": {
                "localPlaybackEnabled": true
            }
        });

        assert!(!desktop_direct_playback_enabled_for_config(&config));
    }

    #[test]
    fn virtual_driver_feedback_prevention_keeps_explicit_physical_output() {
        let config = json!({
            "devices": {
                "feedbackLoopPrevention": "virtual-driver",
                "outputDeviceId": "耳机 (iBasso-DC-Series)"
            },
            "speech": {
                "localPlaybackEnabled": true
            }
        });

        assert!(desktop_direct_playback_enabled_for_config(&config));
    }

    #[test]
    fn echo_cancel_feedback_prevention_keeps_requested_local_playback() {
        let config = json!({
            "devices": {
                "feedbackLoopPrevention": "echo-cancel"
            },
            "speech": {
                "localPlaybackEnabled": true
            }
        });

        assert!(desktop_direct_playback_enabled_for_config(&config));
    }

    #[test]
    fn convert_captured_audio_downsamples_stereo_float_to_mono_24k() {
        let audio = CapturedSegmentAudio {
            cue_id: "cue-inbound-1".to_string(),
            route_direction: "inbound".to_string(),
            sample_rate_hz: 48_000,
            channel_count: 2,
            pcm_f32le: [
                1.0_f32.to_le_bytes(),
                (-1.0_f32).to_le_bytes(),
                0.5_f32.to_le_bytes(),
                0.5_f32.to_le_bytes(),
                0.25_f32.to_le_bytes(),
                0.25_f32.to_le_bytes(),
                (-0.5_f32).to_le_bytes(),
                (-0.5_f32).to_le_bytes(),
            ]
            .into_iter()
            .flatten()
            .collect(),
        };

        let mono = convert_captured_audio_to_mono_i16_24k(&audio);

        assert_eq!(mono.len(), 2);
        assert_eq!(mono[0], 0);
        assert!(mono[1] > 7_000 && mono[1] < 9_000);
    }

    #[test]
    fn speech_ready_accepts_final_secondary_translation_before_cue_commit() {
        let cue = SubtitleCueRuntime {
            cue_id: "cue-1".to_string(),
            route_direction: "inbound".to_string(),
            source_text: "hello".to_string(),
            display_source_text: "hello".to_string(),
            display_segments: vec![SubtitleDisplaySegmentRuntime {
                source_text: "hello".to_string(),
                translated_text: "你好。".to_string(),
                pending: false,
            }],
            translated_text: "你好。".to_string(),
            started_at: "unix-ms:1".to_string(),
            ended_at: "unix-ms:2".to_string(),
            committed: false,
        };

        assert!(is_speech_ready_cue(&cue));
    }

    #[test]
    fn speech_ready_ignores_pending_secondary_translation() {
        let cue = SubtitleCueRuntime {
            cue_id: "cue-1".to_string(),
            route_direction: "inbound".to_string(),
            source_text: "hello".to_string(),
            display_source_text: "hello".to_string(),
            display_segments: vec![SubtitleDisplaySegmentRuntime {
                source_text: "hello".to_string(),
                translated_text: "你".to_string(),
                pending: true,
            }],
            translated_text: "你".to_string(),
            started_at: "unix-ms:1".to_string(),
            ended_at: "unix-ms:2".to_string(),
            committed: false,
        };

        assert!(!is_speech_ready_cue(&cue));
    }

    #[test]
    fn native_route_uses_single_cue_task_without_segment_tts() {
        let config = SpeechConfig::from_value(&json!({
            "speech": {
                "enabled": true,
                "translationAudioSource": "auto"
            },
            "devices": {
                "subtitleTranslationMode": "native",
                "outputSpeechEnabled": false
            }
        }))
        .unwrap();
        let cue = SubtitleCueRuntime {
            cue_id: "cue-native".to_string(),
            route_direction: "inbound".to_string(),
            source_text: "hello".to_string(),
            display_source_text: "hello".to_string(),
            display_segments: vec![SubtitleDisplaySegmentRuntime {
                source_text: "hello".to_string(),
                translated_text: "你好。".to_string(),
                pending: false,
            }],
            translated_text: "你好。".to_string(),
            started_at: "unix-ms:1".to_string(),
            ended_at: "unix-ms:2".to_string(),
            committed: true,
        };

        let tasks = speech_dispatch_tasks_for_cue(&cue, &config);

        assert_eq!(tasks.len(), 1);
        assert!(!tasks[0].segment_mode);
        assert_eq!(tasks[0].translated_text, "你好。");
    }

    #[test]
    fn secondary_route_dispatches_only_final_display_segments() {
        let config = SpeechConfig::from_value(&json!({
            "speech": {
                "translationAudioSource": "subtitle-tts"
            },
            "devices": {
                "subtitleTranslationMode": "secondary",
                "subtitleTranslationModelId": "template::text-model",
                "outputSpeechEnabled": true
            }
        }))
        .unwrap();
        let cue = SubtitleCueRuntime {
            cue_id: "cue-secondary".to_string(),
            route_direction: "inbound".to_string(),
            source_text: "hello then wait".to_string(),
            display_source_text: "hello\nthen wait".to_string(),
            display_segments: vec![
                SubtitleDisplaySegmentRuntime {
                    source_text: "hello".to_string(),
                    translated_text: "你好。".to_string(),
                    pending: false,
                },
                SubtitleDisplaySegmentRuntime {
                    source_text: "then wait".to_string(),
                    translated_text: "然后等等".to_string(),
                    pending: true,
                },
            ],
            translated_text: "你好。\n然后等等".to_string(),
            started_at: "unix-ms:1".to_string(),
            ended_at: "unix-ms:2".to_string(),
            committed: false,
        };

        let tasks = speech_dispatch_tasks_for_cue(&cue, &config);

        assert_eq!(tasks.len(), 1);
        assert!(tasks[0].segment_mode);
        assert_eq!(tasks[0].segment_index, 0);
        assert_eq!(tasks[0].translated_text, "你好。");
    }

    #[test]
    fn secondary_segment_slot_blocks_replacement_replay() {
        let cue = SubtitleCueRuntime {
            cue_id: "cue-secondary".to_string(),
            route_direction: "inbound".to_string(),
            source_text: "hello".to_string(),
            display_source_text: "hello".to_string(),
            display_segments: Vec::new(),
            translated_text: "hello translated".to_string(),
            started_at: "unix-ms:1".to_string(),
            ended_at: "unix-ms:2".to_string(),
            committed: false,
        };
        let first = SpeechDispatchTask {
            cue: cue.clone(),
            segment_index: 0,
            source_text: "hello".to_string(),
            translated_text: "hello translated".to_string(),
            segment_mode: true,
        };
        let replacement = SpeechDispatchTask {
            cue,
            segment_index: 0,
            source_text: "hello there".to_string(),
            translated_text: "hello there translated".to_string(),
            segment_mode: true,
        };
        let mut processed = HashSet::new();
        let mut processed_order = VecDeque::new();
        let mut processed_slots = HashSet::new();
        let mut processed_slot_order = VecDeque::new();

        assert_ne!(first.dispatch_key(), replacement.dispatch_key());
        assert_eq!(first.segment_slot_key(), replacement.segment_slot_key());

        let dispatch_key = first.dispatch_key();
        remember_processed(&mut processed, &mut processed_order, &dispatch_key);
        remember_segment_slot_processed(&first, &mut processed_slots, &mut processed_slot_order);

        assert!(is_processed_task(
            &replacement,
            &processed,
            &processed_slots
        ));
    }

    #[test]
    fn speech_config_uses_subtitle_priority_to_compute_dispatch_delay() {
        let config = SpeechConfig::from_value(&json!({
          "providers": [{
            "templateId": "template",
            "providerId": "provider",
            "kind": "openai-compatible",
            "displayName": "Provider",
            "model": "tts-model",
            "baseUrl": "http://127.0.0.1:1",
            "transport": "http",
            "authRef": {
              "kind": "credential-ref",
              "reference": "none",
              "headerName": "Authorization",
              "scheme": "none"
            },
            "region": null,
            "streamEnabled": false,
            "timeoutMs": 1000,
            "systemPromptTemplate": "video-realtime-cn"
          }],
          "speech": {
            "enabled": true,
            "targetLanguage": "en-US",
            "voicePresetId": "voice-en-neutral",
            "outputTarget": "both",
            "localPlaybackEnabled": true,
            "virtualMicOutputEnabled": true
          },
          "subtitles": {
            "priority": "subtitle-first"
          },
          "devices": {
            "inboundRoute": {
              "latencyControl": {
                "translationBufferMs": 120,
                "playbackBufferMs": 40
              },
              "mixControl": {}
            },
            "outboundRoute": {
              "latencyControl": {
                "translationBufferMs": 90,
                "playbackBufferMs": 50
              },
              "pushToTalk": {
                "enabled": true,
                "state": "recording"
              },
              "mixControl": {}
            }
          }
        }))
        .expect("speech config should parse");

        assert_eq!(config.dispatch_delay_ms("inbound"), 160);
        assert_eq!(config.dispatch_delay_ms("outbound"), 140);
    }

    #[test]
    fn speech_config_prefers_explicit_text_to_speech_model() {
        let config = SpeechConfig::from_value(&json!({
          "providers": [{
            "templateId": "template-main",
            "providerId": "provider-main",
            "kind": "openai-compatible",
            "displayName": "Main Provider",
            "model": "main-model",
            "baseUrl": "http://main.test",
            "transport": "http",
            "authRef": {
              "kind": "credential-ref",
              "reference": "none",
              "headerName": "Authorization",
              "scheme": "none"
            },
            "region": null,
            "streamEnabled": false,
            "timeoutMs": 1000,
            "systemPromptTemplate": "video-realtime-cn"
          },
          {
            "templateId": "template-linked",
            "providerId": "provider-linked",
            "kind": "dashscope",
            "displayName": "Linked Provider",
            "model": "linked-default",
            "baseUrl": "http://linked.test",
            "transport": "websocket",
            "authRef": {
              "kind": "credential-ref",
              "reference": "none",
              "headerName": "Authorization",
              "scheme": "none"
            },
            "region": null,
            "streamEnabled": false,
            "timeoutMs": 1000,
            "systemPromptTemplate": "video-realtime-cn"
          }],
          "speech": {
            "enabled": true,
            "targetLanguage": "en-US",
            "voicePresetId": "voice-en-neutral",
            "textToSpeechModelId": "template-linked::tts-model",
            "outputTarget": "both",
            "localPlaybackEnabled": true,
            "virtualMicOutputEnabled": true
          },
          "subtitles": {
            "priority": "balanced"
          },
          "devices": {
            "textToSpeechModelId": "template-main::device-tts-model",
            "outboundVoiceModelId": "template-main::outbound-model",
            "inboundRoute": {
              "latencyControl": {},
              "mixControl": {}
            },
            "outboundRoute": {
              "latencyControl": {},
              "pushToTalk": {},
              "mixControl": {}
            }
          }
        }))
        .expect("speech config should parse");

        assert_eq!(config.provider.provider_id, "provider-linked");
        assert_eq!(config.provider.model, "tts-model");
    }

    #[test]
    fn secondary_tts_prefers_inbound_secondary_audio_model() {
        let config = SpeechConfig::from_value(&json!({
          "providers": [
            {
              "templateId": "template-default",
              "providerId": "provider-default",
              "kind": "openai-compatible",
              "displayName": "Default Provider",
              "model": "default-model",
              "baseUrl": "http://default.test",
              "transport": "http",
              "authRef": { "kind": "credential-ref", "reference": "none", "headerName": "Authorization", "scheme": "none" },
              "region": null,
              "streamEnabled": false,
              "timeoutMs": 1000,
              "systemPromptTemplate": "video-realtime-cn"
            },
            {
              "templateId": "template-secondary",
              "providerId": "provider-secondary",
              "kind": "dashscope",
              "displayName": "Secondary Provider",
              "model": "old-model",
              "baseUrl": "http://secondary.test",
              "transport": "websocket",
              "authRef": { "kind": "credential-ref", "reference": "none", "headerName": "Authorization", "scheme": "none" },
              "region": null,
              "streamEnabled": false,
              "timeoutMs": 1000,
              "systemPromptTemplate": "video-realtime-cn"
            }
          ],
          "devices": {
            "subtitleTranslationMode": "secondary",
            "subtitleTranslationModelId": "template-default::text-model",
            "outputSpeechEnabled": true,
            "inboundSecondaryAudioModelId": "template-secondary::secondary-tts",
            "inboundRoute": { "latencyControl": {}, "mixControl": {} },
            "outboundRoute": { "latencyControl": {}, "pushToTalk": {}, "mixControl": {} }
          },
          "speech": {
            "translationAudioSource": "subtitle-tts"
          }
        }))
        .expect("speech config should parse");

        assert!(config.secondary_segment_tts_enabled);
        assert_eq!(config.provider.provider_id, "provider-secondary");
        assert_eq!(config.provider.model, "secondary-tts");
    }

    #[test]
    fn secondary_tts_skips_livetranslate_and_uses_bare_tts_model() {
        let config = SpeechConfig::from_value(&json!({
          "providers": [
            {
              "templateId": "template-dashscope-realtime",
              "providerId": "provider-dashscope",
              "kind": "dashscope",
              "displayName": "DashScope",
              "model": "qwen3.5-livetranslate-flash-realtime",
              "baseUrl": "https://dashscope.aliyuncs.com/api/v1",
              "transport": "websocket",
              "authRef": { "kind": "credential-ref", "reference": "credential://provider/dashscope/default", "headerName": "Authorization", "scheme": "Bearer" },
              "region": null,
              "streamEnabled": false,
              "timeoutMs": 1000,
              "systemPromptTemplate": "video-realtime-cn"
            }
          ],
          "devices": {
            "subtitleTranslationMode": "secondary",
            "subtitleTranslationModelId": "template-deepseek::deepseek-v4-flash",
            "outputSpeechEnabled": true,
            "inboundSecondaryAudioModelId": "template-dashscope-realtime::qwen3.5-livetranslate-flash-realtime",
            "inboundRoute": { "latencyControl": {}, "mixControl": {} },
            "outboundRoute": { "latencyControl": {}, "pushToTalk": {}, "mixControl": {} }
          },
          "speech": {
            "translationAudioSource": "subtitle-tts",
            "textToSpeechModelId": "qwen3.5-omni-plus-realtime"
          }
        }))
        .expect("speech config should parse");

        assert!(config.secondary_segment_tts_enabled);
        assert_eq!(config.provider.provider_id, "provider-dashscope");
        assert_eq!(config.provider.model, "qwen3.5-omni-plus-realtime");
    }

    #[test]
    fn output_level_scales_virtual_mic_samples() {
        assert_eq!(
            scale_i16_by_output_level(&[1000, -1000], 50),
            vec![500, -500]
        );
        assert_eq!(scale_i16_by_output_level(&[1000], 0), vec![0]);
        assert_eq!(scale_i16_by_output_level(&[1000], 200), vec![1000]);
    }

    #[test]
    fn resolve_model_provider_composite_id_matches_linked_by_template() {
        let config = json!({
            "providers": [
                {
                    "templateId": "template-main", "providerId": "provider-main",
                    "kind": "openai-compatible", "displayName": "Main",
                    "model": "main-model", "baseUrl": "http://main.test",
                    "transport": "http",
                    "authRef": { "kind": "credential-ref", "reference": "none", "headerName": "Authorization", "scheme": "none" },
                    "region": null, "streamEnabled": false, "timeoutMs": 1000,
                    "systemPromptTemplate": "video-realtime-cn"
                },
                {
                    "templateId": "template-linked", "providerId": "provider-linked",
                    "kind": "dashscope", "displayName": "Linked",
                    "model": "linked-default", "baseUrl": "http://linked.test",
                    "transport": "websocket",
                    "authRef": { "kind": "credential-ref", "reference": "none", "headerName": "Authorization", "scheme": "none" },
                    "region": null, "streamEnabled": false, "timeoutMs": 1000,
                    "systemPromptTemplate": "video-realtime-cn"
                }
            ]
        });
        let provider =
            resolve_model_provider_from_config_value(&config, "template-linked::tts-model")
                .expect("composite ID should resolve to linked provider");
        assert_eq!(provider.provider_id, "provider-linked");
        assert_eq!(provider.model, "tts-model");
        assert_eq!(provider.kind, "dashscope");
    }

    #[test]
    fn resolve_model_provider_returns_none_for_unmatched_model() {
        let config = json!({
            "providers": [{
                "templateId": "template-main", "providerId": "provider-main",
                "kind": "openai-compatible", "displayName": "Main",
                "model": "main-model", "baseUrl": "http://main.test",
                "transport": "http",
                "authRef": { "kind": "credential-ref", "reference": "none", "headerName": "Authorization", "scheme": "none" },
                "region": null, "streamEnabled": false, "timeoutMs": 1000,
                "systemPromptTemplate": "video-realtime-cn"
            }]
        });
        assert!(resolve_model_provider_from_config_value(&config, "unknown-model").is_none());
    }

    #[test]
    fn resolve_model_provider_returns_none_for_unknown_composite_template() {
        let config = json!({
            "providers": [{
                "templateId": "template-main", "providerId": "provider-main",
                "kind": "openai-compatible", "displayName": "Main",
                "model": "main-model", "baseUrl": "http://main.test",
                "transport": "http",
                "authRef": { "kind": "credential-ref", "reference": "none", "headerName": "Authorization", "scheme": "none" },
                "region": null, "streamEnabled": false, "timeoutMs": 1000,
                "systemPromptTemplate": "video-realtime-cn"
            }]
        });
        assert!(resolve_model_provider_from_config_value(
            &config,
            "template-nonexistent::some-model"
        )
        .is_none());
    }

    #[test]
    fn resolve_model_provider_composite_id_matches_main_by_template() {
        let config = json!({
            "providers": [{
                "templateId": "template-main", "providerId": "provider-main",
                "kind": "openai-compatible", "displayName": "Main",
                "model": "main-model", "baseUrl": "http://main.test",
                "transport": "http",
                "authRef": { "kind": "credential-ref", "reference": "none", "headerName": "Authorization", "scheme": "none" },
                "region": null, "streamEnabled": false, "timeoutMs": 1000,
                "systemPromptTemplate": "video-realtime-cn"
            }]
        });
        let provider =
            resolve_model_provider_from_config_value(&config, "template-main::custom-model")
                .expect("composite ID should resolve to main provider");
        assert_eq!(provider.provider_id, "provider-main");
        assert_eq!(provider.model, "custom-model");
        assert_eq!(provider.kind, "openai-compatible");
    }

    #[test]
    fn playback_volume_normalizes_and_clamps_output_level() {
        assert_eq!(playback_volume(0), 0.0);
        assert_eq!(playback_volume(66), 0.66);
        assert_eq!(playback_volume(100), 1.0);
        assert_eq!(playback_volume(101), 1.0);
    }

    #[test]
    fn speaker_output_name_matching_ignores_case_and_spaces() {
        let resolved = normalized_device_name("Headphones (iBasso-DC-Series)");
        let requested = normalized_device_name("ibasso-dc-series");

        assert!(resolved.contains(&requested));
    }
}
