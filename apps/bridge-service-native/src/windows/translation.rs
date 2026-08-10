#[derive(Debug)]
struct PlaybackJob {
    samples: Vec<f32>,
    device_id: String,
    volume: f32,
    source_frame: bool,
    ducking_enabled: bool,
    ducking_depth_percent: u64,
    queued_at: Instant,
    source_generation: u64,
    cue_id: Option<String>,
    created_at_ms: u64,
    estimated_duration_ms: u64,
    playback_duration_ms: u64,
    translation_generation: u64,
}

enum PlaybackCommand {
    Play(PlaybackJob),
    TranslationQueued,
    FlushSource,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct TranslationCueTerminal {
    cue_id: Option<String>,
    status: TranslationPlaybackStatusKind,
    reason: String,
    error_code: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct PlaybackStopRequest {
    reason: String,
    error_code: Option<String>,
    recreate_output: bool,
    stop_through_generation: u64,
    terminated_cues: Vec<TranslationCueTerminal>,
}

enum PlaybackControlCommand {
    StopAll(PlaybackStopRequest),
}

struct ActiveTranslationPlayback {
    cue_id: Option<String>,
    created_at_ms: u64,
    estimated_duration_ms: u64,
    playback_frames: u64,
    expected_end_ms: u64,
}

#[derive(Debug)]
struct TranslationEnqueueOutcome {
    projected_start_ms: u64,
    projected_end_ms: u64,
    dropped: Vec<PlaybackJob>,
}

#[derive(Debug)]
struct TranslationEnqueueFailure {
    job: PlaybackJob,
    projected_start_ms: u64,
    dropped: Vec<PlaybackJob>,
    reason: TranslationEnqueueFailureReason,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TranslationEnqueueFailureReason {
    QueueFull,
    RealtimeBudget,
}

#[derive(Debug)]
struct TranslationStartOutcome {
    job: Option<PlaybackJob>,
    dropped: Vec<PlaybackJob>,
}

struct TranslationStatusOutbox {
    producer_id: String,
    next_sequence: u64,
    pending: VecDeque<TranslationPlaybackStatusEvent>,
}

impl Default for TranslationStatusOutbox {
    fn default() -> Self {
        Self {
            producer_id: uuid::Uuid::new_v4().simple().to_string(),
            next_sequence: 0,
            pending: VecDeque::new(),
        }
    }
}

impl TranslationStatusOutbox {
    fn next_status_id(&mut self) -> String {
        self.next_sequence = self
            .next_sequence
            .checked_add(1)
            .expect("translation status sequence exhausted");
        format!(
            "bridge-translation-status-{}-{}",
            self.producer_id, self.next_sequence
        )
    }

    fn push(&mut self, event: TranslationPlaybackStatusEvent) {
        self.pending.push_back(event);
    }

    fn front(&self) -> Option<&TranslationPlaybackStatusEvent> {
        self.pending.front()
    }

    fn acknowledge(&mut self, ack: &TranslationPlaybackStatusAck) -> bool {
        let Some(front) = self.pending.front() else {
            return false;
        };
        if front.status_id != ack.status_id || front.session_id != ack.session_id {
            return false;
        }
        self.pending.pop_front();
        true
    }
}

struct TranslationPlaybackQueue {
    capacity: usize,
    pending: VecDeque<PlaybackJob>,
    active: Option<ActiveTranslationPlayback>,
}

impl TranslationPlaybackQueue {
    fn new(capacity: usize) -> Self {
        Self {
            capacity,
            pending: VecDeque::with_capacity(capacity),
            active: None,
        }
    }

    fn projected_start_ms(&self, now_ms: u64) -> u64 {
        let active_end_ms = self
            .active
            .as_ref()
            .map(|active| active.expected_end_ms)
            .unwrap_or(now_ms)
            .max(now_ms);
        self.pending.iter().fold(active_end_ms, |start_ms, job| {
            start_ms.saturating_add(job.playback_duration_ms)
        })
    }

    fn projected_end_ms(&self, now_ms: u64) -> u64 {
        self.projected_start_ms(now_ms)
    }

    fn active_end_ms(&self, now_ms: u64) -> u64 {
        self.active
            .as_ref()
            .map(|active| active.expected_end_ms)
            .unwrap_or(now_ms)
            .max(now_ms)
    }

    /// Removes only pending cues that would miss their own five-second start
    /// budget. Dropped jobs do not advance the retained queue's cursor, so a
    /// later cue that becomes timely after an older stale cue is removed is
    /// preserved.
    fn drain_expired_pending(&mut self, now_ms: u64) -> Vec<PlaybackJob> {
        let mut projected_start_ms = self.active_end_ms(now_ms);
        let mut retained = VecDeque::with_capacity(self.pending.len());
        let mut dropped = Vec::new();
        for job in self.pending.drain(..) {
            if translation_would_miss_realtime_budget(job.created_at_ms, projected_start_ms) {
                dropped.push(job);
            } else {
                projected_start_ms =
                    projected_start_ms.saturating_add(job.playback_duration_ms);
                retained.push_back(job);
            }
        }
        self.pending = retained;
        dropped
    }

    fn enqueue(
        &mut self,
        job: PlaybackJob,
        now_ms: u64,
    ) -> Result<TranslationEnqueueOutcome, TranslationEnqueueFailure> {
        let dropped = self.drain_expired_pending(now_ms);
        let projected_start_ms = self.projected_start_ms(now_ms);
        if self.pending.len() >= self.capacity {
            return Err(TranslationEnqueueFailure {
                job,
                projected_start_ms,
                dropped,
                reason: TranslationEnqueueFailureReason::QueueFull,
            });
        }
        if translation_would_miss_realtime_budget(job.created_at_ms, projected_start_ms) {
            return Err(TranslationEnqueueFailure {
                job,
                projected_start_ms,
                dropped,
                reason: TranslationEnqueueFailureReason::RealtimeBudget,
            });
        }
        let projected_end_ms = projected_start_ms.saturating_add(job.playback_duration_ms);
        self.pending.push_back(job);
        Ok(TranslationEnqueueOutcome {
            projected_start_ms,
            projected_end_ms,
            dropped,
        })
    }

    fn start_next(&mut self, now_ms: u64) -> TranslationStartOutcome {
        if self.active.is_some() {
            return TranslationStartOutcome {
                job: None,
                dropped: Vec::new(),
            };
        }
        let dropped = self.drain_expired_pending(now_ms);
        let Some(job) = self.pending.pop_front() else {
            return TranslationStartOutcome { job: None, dropped };
        };
        let playback_frames =
            job.samples.len() as u64 / INTERNAL_CHANNEL_COUNT as u64;
        self.active = Some(ActiveTranslationPlayback {
            cue_id: job.cue_id.clone(),
            created_at_ms: job.created_at_ms,
            estimated_duration_ms: job.estimated_duration_ms,
            playback_frames,
            expected_end_ms: now_ms.saturating_add(job.playback_duration_ms),
        });
        TranslationStartOutcome {
            job: Some(job),
            dropped,
        }
    }

    fn finish_active(&mut self) -> Option<ActiveTranslationPlayback> {
        self.active.take()
    }

    fn clear(&mut self) -> (Option<ActiveTranslationPlayback>, Vec<PlaybackJob>) {
        (self.active.take(), self.pending.drain(..).collect())
    }
}

fn translation_terminal_status(error_code: Option<&str>) -> TranslationPlaybackStatusKind {
    if error_code.is_some() {
        TranslationPlaybackStatusKind::RouteFailed
    } else {
        TranslationPlaybackStatusKind::StaleDropped
    }
}

fn log_translation_terminal(terminal: &TranslationCueTerminal) {
    let cue_id = terminal.cue_id.as_deref().unwrap_or("-");
    let error_suffix = terminal
        .error_code
        .as_deref()
        .map(|code| format!(" errorCode={code}"))
        .unwrap_or_default();
    let level = if terminal.status == TranslationPlaybackStatusKind::RouteFailed {
        LogLevel::Error
    } else {
        LogLevel::Warning
    };
    service_log(
        level,
        cue_id,
        &format!(
            "event=translation_playback_status status={} cueId={cue_id} reason={}{}",
            terminal.status.as_str(), terminal.reason, error_suffix,
        ),
    );
}

fn emit_translation_terminal(state: &BridgeState, terminal: &TranslationCueTerminal) {
    log_translation_terminal(terminal);
    state.emit_translation_status(
        terminal.cue_id.as_deref(),
        terminal.status,
        &terminal.reason,
        terminal.error_code.as_deref(),
    );
}

fn request_playback_stop(
    current: &mut BridgeState,
    translation_queue: &Arc<Mutex<TranslationPlaybackQueue>>,
    playback_control_tx: &mpsc::Sender<PlaybackControlCommand>,
    reason: impl Into<String>,
    error_code: Option<&str>,
) -> PlaybackStopRequest {
    let reason = reason.into();
    let error_code = error_code.map(str::to_string);
    let recreate_output = reason == "physical-playback-device-changed";
    let status = translation_terminal_status(error_code.as_deref());
    let stop_through_generation = current.translation_generation;
    current.translation_generation = current.translation_generation.wrapping_add(1);
    let (active, pending) = translation_queue.lock().unwrap().clear();
    let mut terminated_cues = Vec::with_capacity(pending.len() + usize::from(active.is_some()));
    if let Some(active) = active {
        current.dropped_frame_count += active.playback_frames;
        terminated_cues.push(TranslationCueTerminal {
            cue_id: active.cue_id,
            status,
            reason: reason.clone(),
            error_code: error_code.clone(),
        });
    }
    for job in pending {
        current.dropped_frame_count +=
            job.samples.len() as u64 / INTERNAL_CHANNEL_COUNT as u64;
        terminated_cues.push(TranslationCueTerminal {
            cue_id: job.cue_id,
            status,
            reason: reason.clone(),
            error_code: error_code.clone(),
        });
    }
    current.translation_queue_end_timestamp_ms = unix_ms();
    for terminal in &terminated_cues {
        emit_translation_terminal(current, terminal);
    }
    let request = PlaybackStopRequest {
        reason,
        error_code,
        recreate_output,
        stop_through_generation,
        terminated_cues,
    };
    if playback_control_tx
        .send(PlaybackControlCommand::StopAll(request.clone()))
        .is_err()
    {
        service_log(
            LogLevel::Error,
            &format!("{}:{}", file!(), line!()),
            "playback control worker is unavailable while stopping all output",
        );
    }
    request
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct SourceRouteFailure {
    code: String,
    detail: String,
}

fn process_source_route_failure(state: &BridgeState) -> Option<SourceRouteFailure> {
    if state.source_capture_mode != SourceCaptureMode::ProcessExclusion
        || state.process_loopback_status == ProcessLoopbackStatus::Ready
    {
        return None;
    }
    let code = state.last_error_code.clone().unwrap_or_else(|| {
        if state.process_loopback_status == ProcessLoopbackStatus::Unsupported {
            "bridge.process-loopback-unsupported"
        } else {
            "bridge.process-loopback-capture-failed"
        }
        .to_string()
    });
    let detail = state
        .process_loopback_failure_detail
        .clone()
        .unwrap_or_else(|| format!("process loopback source route is {}", state.process_loopback_status.as_str()));
    Some(SourceRouteFailure { code, detail })
}

fn source_route_error_header(state: &BridgeState, failure: &SourceRouteFailure) -> Value {
    json!({
        "type": "bridge.source.error",
        "requestId": format!("bridge-source-error-{}", unix_ms()),
        "sessionId": state.session_id.as_deref().unwrap_or_default(),
        "frameId": format!("bridge-source-error-{}", state.source_generation),
        "streamId": "omni-process-loopback-exclusion",
        "sampleRateHz": INTERNAL_SAMPLE_RATE_HZ,
        "sampleFormat": "pcm-s16le",
        "channelCount": INTERNAL_CHANNEL_COUNT,
        "frameCount": 0,
        "timestampMs": unix_ms(),
        "payloadBytes": 0,
        "bridgeProcessId": state.bridge_process_id,
        "bridgeInstanceId": state.bridge_instance_id,
        "sourceGeneration": state.source_generation,
        "sourceGenerationToken": source_generation_token(state, state.source_generation),
        "errorCode": failure.code,
        "message": failure.detail,
        "translatedAudioEnhancementApplied": false,
    })
}
