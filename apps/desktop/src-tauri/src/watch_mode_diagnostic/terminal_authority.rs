use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ExpectedInputCompleteIdentity {
    pub(crate) run_marker: String,
    pub(crate) cell_id: String,
    pub(crate) lease_id: String,
}

#[derive(Clone, Debug)]
pub(super) struct StrictPaidTerminalConfig {
    pub(super) identity: ExpectedInputCompleteIdentity,
    pub(super) producer: TerminalProducerIdentity,
    pub(super) input_complete_path: String,
    pub(super) terminal_authority_path: String,
    pub(super) report_path: String,
    pub(super) input_completion_watchdog: Duration,
    pub(super) provider_shutdown_timeout: Duration,
    pub(super) local_playback_drain_timeout: Duration,
    pub(super) report_write_timeout: Duration,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct TerminalProducerIdentity {
    pub(super) process_id: u32,
    pub(super) start_time_utc_ticks: u64,
    pub(super) started_at_unix_ms: u64,
    pub(super) executable_sha256: String,
    pub(super) source_head_commit: String,
    pub(super) runtime_bundle_digest: String,
    pub(super) launch_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct InputCompleteMarker {
    pub(super) artifact_kind: String,
    pub(super) schema_version: u64,
    pub(super) run_marker: String,
    pub(super) cell_id: String,
    pub(super) lease_id: String,
    pub(super) completed_at_unix_ms: u64,
    pub(super) signaled_at_unix_ms: u64,
    #[serde(default)]
    pub(super) authoritative_transformed_reference_frames: Option<u64>,
    #[serde(default)]
    pub(super) bounded_capture_grace_frames: Option<u64>,
    #[serde(default)]
    pub(super) media_playback_completed_at_unix_ms: Option<u64>,
    #[serde(default)]
    pub(super) max_external_audio_samples: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TerminalAuthorityEvent {
    pub(super) sequence: u64,
    pub(super) stage: String,
    pub(super) observed_at_unix_ms: u64,
    pub(super) detail: Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TerminalAuthority {
    pub(super) artifact_kind: String,
    pub(super) schema_version: u64,
    pub(super) run_marker: String,
    pub(super) cell_id: String,
    pub(super) lease_id: String,
    pub(super) producer_process_id: u32,
    pub(super) producer_start_time_utc_ticks: String,
    pub(super) producer_started_at_unix_ms: u64,
    pub(super) producer_executable_sha256: String,
    pub(super) source_head_commit: String,
    pub(super) runtime_bundle_digest: String,
    pub(super) launch_id: String,
    pub(super) status: String,
    pub(super) started_at_unix_ms: u64,
    pub(super) completed_at_unix_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) error: Option<String>,
    pub(super) events: Vec<TerminalAuthorityEvent>,
}

pub(super) struct TerminalAuthorityRecorder {
    identity: ExpectedInputCompleteIdentity,
    producer: TerminalProducerIdentity,
    started_at_unix_ms: u64,
    events: Vec<TerminalAuthorityEvent>,
}

impl TerminalAuthorityRecorder {
    pub(super) fn new(
        identity: ExpectedInputCompleteIdentity,
        producer: TerminalProducerIdentity,
        started_at_unix_ms: u64,
    ) -> Self {
        Self {
            identity,
            producer,
            started_at_unix_ms,
            events: Vec::new(),
        }
    }

    pub(super) fn push(&mut self, stage: &str, observed_at_unix_ms: u64, detail: Value) {
        self.events.push(TerminalAuthorityEvent {
            sequence: self.events.len() as u64 + 1,
            stage: stage.to_string(),
            observed_at_unix_ms,
            detail,
        });
    }

    pub(super) fn complete(self, completed_at_unix_ms: u64) -> TerminalAuthority {
        self.finish("completed", completed_at_unix_ms, None, None)
    }

    pub(super) fn fail(
        self,
        completed_at_unix_ms: u64,
        error_code: &str,
        error: String,
    ) -> TerminalAuthority {
        self.finish(
            "failed",
            completed_at_unix_ms,
            Some(error_code.to_string()),
            Some(error),
        )
    }

    fn finish(
        mut self,
        status: &str,
        completed_at_unix_ms: u64,
        error_code: Option<String>,
        error: Option<String>,
    ) -> TerminalAuthority {
        self.events
            .sort_by_key(|event| event.observed_at_unix_ms);
        for (index, event) in self.events.iter_mut().enumerate() {
            event.sequence = index as u64 + 1;
        }
        // The recorder can be scheduled just after the typed session owner has
        // already published its first lifecycle event. Preserve that owner's
        // original timestamp while widening the authority window to include
        // every event that could have been produced by this process. Events
        // predating the producer remain outside the window and therefore fail
        // closed in the evidence validators.
        let earliest_trusted_event_at = self
            .events
            .iter()
            .map(|event| event.observed_at_unix_ms)
            .filter(|observed_at| *observed_at >= self.producer.started_at_unix_ms)
            .min();
        let started_at_unix_ms = earliest_trusted_event_at
            .map(|observed_at| self.started_at_unix_ms.min(observed_at))
            .unwrap_or(self.started_at_unix_ms)
            .max(self.producer.started_at_unix_ms);
        TerminalAuthority {
            artifact_kind: "watch-mode-evidence-driven-terminal".to_string(),
            schema_version: 3,
            run_marker: self.identity.run_marker,
            cell_id: self.identity.cell_id,
            lease_id: self.identity.lease_id,
            producer_process_id: self.producer.process_id,
            producer_start_time_utc_ticks: self.producer.start_time_utc_ticks.to_string(),
            producer_started_at_unix_ms: self.producer.started_at_unix_ms,
            producer_executable_sha256: self.producer.executable_sha256,
            source_head_commit: self.producer.source_head_commit,
            runtime_bundle_digest: self.producer.runtime_bundle_digest,
            launch_id: self.producer.launch_id,
            status: status.to_string(),
            started_at_unix_ms,
            completed_at_unix_ms,
            error_code,
            error,
            events: self.events,
        }
    }
}

const WINDOWS_TO_DOTNET_EPOCH_TICKS: u64 = 504_911_232_000_000_000;
const UNIX_EPOCH_DOTNET_TICKS: u64 = 621_355_968_000_000_000;
const TICKS_PER_MILLISECOND: u64 = 10_000;

pub(super) fn process_start_unix_ms_from_utc_ticks(start_time_utc_ticks: u64) -> Result<u64, String> {
    start_time_utc_ticks
        .checked_sub(UNIX_EPOCH_DOTNET_TICKS)
        .map(|ticks| ticks / TICKS_PER_MILLISECOND)
        .ok_or_else(|| "desktop OS startTimeUtcTicks predates the Unix epoch".to_string())
}

#[cfg(windows)]
pub(super) fn current_process_start_time_utc_ticks() -> Result<u64, String> {
    use windows_sys::Win32::Foundation::{GetLastError, FILETIME};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};

    let mut created = FILETIME::default();
    let mut exited = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    let succeeded = unsafe {
        GetProcessTimes(
            GetCurrentProcess(),
            &mut created,
            &mut exited,
            &mut kernel,
            &mut user,
        )
    };
    if succeeded == 0 {
        return Err(format!(
            "failed to query desktop OS process startTimeUtcTicks: win32Error={}",
            unsafe { GetLastError() }
        ));
    }
    let file_time_ticks = (u64::from(created.dwHighDateTime) << 32)
        | u64::from(created.dwLowDateTime);
    file_time_ticks
        .checked_add(WINDOWS_TO_DOTNET_EPOCH_TICKS)
        .ok_or_else(|| "desktop OS process startTimeUtcTicks overflowed".to_string())
}

#[cfg(not(windows))]
pub(super) fn current_process_start_time_utc_ticks() -> Result<u64, String> {
    Err("desktop OS process startTimeUtcTicks is unsupported on this platform".to_string())
}
