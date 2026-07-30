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

fn is_committed_cue_already_played(
    cue_id: &str,
    committed_played: &HashSet<String>,
) -> bool {
    committed_played.contains(cue_id)
}

fn remember_committed_cue_played(
    cue_id: &str,
    committed_played: &mut HashSet<String>,
    order: &mut VecDeque<String>,
) {
    if !committed_played.insert(cue_id.to_string()) {
        return; // already present, no duplicate insertion
    }
    order.push_back(cue_id.to_string());
    while order.len() > MAX_PROCESSED_CUES {
        if let Some(expired) = order.pop_front() {
            committed_played.remove(&expired);
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

fn split_tts_clauses(text: &str) -> Vec<String> {
    let mut clauses = Vec::new();
    let mut current = String::new();
    for ch in text.chars() {
        match ch {
            '\r' => {}
            '\n' | '；' | ';' => {
                let value = current.trim();
                if !value.is_empty() {
                    clauses.push(value.to_string());
                }
                current.clear();
            }
            '。' | '！' | '？' | '!' | '?' => {
                current.push(ch);
                let value = current.trim();
                if !value.is_empty() {
                    clauses.push(value.to_string());
                }
                current.clear();
            }
            _ => current.push(ch),
        }
    }
    let value = current.trim();
    if !value.is_empty() {
        clauses.push(value.to_string());
    }
    clauses
}

fn split_secondary_tts_segments(source_text: &str, translated_text: &str) -> Vec<(String, String)> {
    let translated_parts = split_tts_clauses(translated_text);
    if translated_parts.is_empty() {
        return Vec::new();
    }
    let source_parts = split_tts_clauses(source_text);
    if source_parts.len() == translated_parts.len() {
        return source_parts.into_iter().zip(translated_parts).collect();
    }
    translated_parts
        .into_iter()
        .map(|translated| (source_text.trim().to_string(), translated))
        .collect()
}

fn secondary_tts_segment_index(display_index: usize, part_index: usize) -> usize {
    display_index.saturating_mul(1000).saturating_add(part_index)
}

fn speech_dispatch_tasks_for_cue(
    cue: &SubtitleCueRuntime,
    config: &SpeechConfig,
    committed_played: &HashSet<String>,
) -> Vec<SpeechDispatchTask> {
    if cue.committed && is_committed_cue_already_played(&cue.cue_id, committed_played) {
        return Vec::new();
    }
    if !cue.committed && !cue.translation_committed {
        return Vec::new();
    }
    if config.secondary_segment_tts_enabled {
        let first_segment = cue
            .display_segments
            .iter()
            .enumerate()
            .find(|(_, segment)| !segment.pending && !segment.translated_text.trim().is_empty());
        let Some((index, segment)) = first_segment else {
            return Vec::new();
        };
        return split_secondary_tts_segments(&segment.source_text, &segment.translated_text)
            .into_iter()
            .enumerate()
            .map(|(part_index, (source_text, translated_text))| SpeechDispatchTask {
                cue: cue.clone(),
                segment_index: secondary_tts_segment_index(index, part_index),
                source_text,
                translated_text,
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
        event_id: format!("{}-{}", kind, now_unix_millis_marker()),
        kind: kind.to_string(),
        summary,
        emitted_at: now_unix_millis_marker(),
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
    enhancement_metrics: SpeechEnhancementMetrics,
}

struct SpeechMixPlanner<'a> {
    cue: &'a SubtitleCueRuntime,
    captured_audio: Option<CapturedSegmentAudio>,
    translated_pcm: Vec<i16>,
    sample_rate_hz: u32,
    channel_count: u16,
    config: &'a SpeechConfig,
}

impl<'a> SpeechMixPlanner<'a> {
    fn new(
        cue: &'a SubtitleCueRuntime,
        captured_audio: Option<CapturedSegmentAudio>,
        translated_pcm: Vec<i16>,
        sample_rate_hz: u32,
        channel_count: u16,
        config: &'a SpeechConfig,
    ) -> Self {
        Self {
            cue,
            captured_audio,
            translated_pcm,
            sample_rate_hz,
            channel_count,
            config,
        }
    }

    fn build(self) -> MixPlan {
        let cue = self.cue;
        let captured_audio = self.captured_audio;
        let translated_pcm = self.translated_pcm;
        let sample_rate_hz = self.sample_rate_hz;
        let channel_count = self.channel_count;
        let config = self.config;
    let route_mix = if cue.route_direction == "outbound" {
        &config.outbound_mix
    } else {
        &config.inbound_mix
    };
    let (mut translated, enhancement_metrics) = enhance_speech_i16(
        &translated_pcm,
        sample_rate_hz,
        channel_count,
        route_mix.translated_audio_gain_db,
        route_mix.translated_audio_auto_gain_enabled,
    );
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
        enhancement_metrics,
    }
}
}
