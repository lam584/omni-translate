//! Exclusive append-only typed playback evidence, independently sealed.
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use sha2::{Digest, Sha256};
use crate::audio::speech::DesktopPlaybackTimeline;

const DIRECTORY_ENV: &str = "OMNI_WATCH_MODE_AEC_DIAGNOSTIC_TAP_DIRECTORY";
const TIMELINE_FILE: &str = "aec-desktop-playback-timeline.jsonl";
const TERMINAL_FILE: &str = "aec-desktop-playback-timeline-terminal.json";

pub(super) struct TimelineEvidence {
    directory: Option<PathBuf>,
    file: Option<File>,
    hasher: Sha256,
    bytes: u64,
    rows: u64,
    failure: Option<String>,
    identity: serde_json::Value,
    sealed: bool,
    started: bool,
    active_responses: std::collections::BTreeSet<String>,
    completed_responses: u64,
    last_owner: Option<(String, String)>,
}

impl TimelineEvidence {
    pub(super) fn from_env() -> Self {
        let directory = std::env::var_os(DIRECTORY_ENV).filter(|p| !p.is_empty()).map(PathBuf::from);
        let identity = serde_json::json!({
            "runMarker": std::env::var("OMNI_WATCH_MODE_MEDIA_AUTHORITY_RUN_MARKER").ok(),
            "cellId": std::env::var("OMNI_WATCH_MODE_MEDIA_AUTHORITY_CELL_ID").ok(),
            "leaseId": std::env::var("OMNI_WATCH_MODE_MEDIA_AUTHORITY_LEASE_ID").ok(),
        });
        // Freeze identity now, but only open files if a Desktop delta is
        // admitted. Bridge/virtual-only queues never gain a new failure mode.
        let mut result = Self::open(None, identity);
        result.directory = directory;
        if result.directory.is_some() && ["runMarker", "cellId", "leaseId"].iter().any(|key|
            result.identity[*key].as_str().is_none_or(|s| s.trim().is_empty())) {
            result.fail("playback timeline missing startup-frozen media authority identity".into());
        }
        result
    }
    fn open(directory: Option<PathBuf>, identity: serde_json::Value) -> Self {
        let started = directory.is_some();
        let mut result = Self { directory, file: None, hasher: Sha256::new(), bytes: 0, rows: 0,
            failure: None, identity, sealed: false, started, active_responses: std::collections::BTreeSet::new(), completed_responses: 0, last_owner: None };
        if let Some(directory) = &result.directory {
            match OpenOptions::new().write(true).create_new(true).open(directory.join(TIMELINE_FILE)) {
                Ok(file) => result.file = Some(file),
                Err(error) => result.fail(format!("timeline exclusive create failed: {error}")),
            }
        }
        result
    }
    pub(super) fn fail(&mut self, reason: String) {
        if self.directory.is_some() && self.failure.is_none() { self.failure = Some(reason); }
    }
    pub(super) fn append(&mut self, milestone: &str, timeline: &DesktopPlaybackTimeline) -> Result<(), String> {
        if self.directory.is_none() { return Ok(()); }
        // Retain real lineage even if exclusive creation/the first write fails,
        // and after ACK removes the response from the pending inventory.
        self.last_owner = Some((timeline.cue_id.clone(), timeline.response_id.clone()));
        if self.sealed { return Err("playback timeline append after immutable seal".into()); }
        if !self.started {
            self.started = true;
            if self.failure.is_none() {
                match OpenOptions::new().write(true).create_new(true).open(self.directory.as_ref().unwrap().join(TIMELINE_FILE)) {
                    Ok(file) => self.file = Some(file),
                    Err(error) => self.fail(format!("timeline exclusive create failed: {error}")),
                }
            }
        }
        if let Some(error) = &self.failure { return Err(error.clone()); }
        let observed_qpc = crate::audio::engine::aec_timing::qpc_now_100ns();
        let qpc_required = timeline.first_audio_delta_qpc_100ns.is_some_and(|q|q>0) && observed_qpc.is_some_and(|q|q>0)
            && (timeline.audio_done_at_ms.is_none() || timeline.audio_done_qpc_100ns.is_some())
            && (timeline.render_start_at_ms.is_none() || timeline.render_start_qpc_100ns.is_some())
            && (timeline.render_complete_at_ms.is_none() || timeline.render_complete_qpc_100ns.is_some())
            && (timeline.renderer_ack_at_ms.is_none() || timeline.renderer_ack_qpc_100ns.is_some());
        if !qpc_required { self.fail("playback timeline missing authoritative QPC timestamp".into()); return Err(self.failure.clone().unwrap()); }
        let result = (|| -> Result<(), String> {
            if timeline.response_id.trim().is_empty() || timeline.cue_id.trim().is_empty() {
                return Err("playback timeline requires actual response/cue identity".into());
            }
            if milestone == "audio-delta" && self.active_responses.contains(&timeline.response_id) {
                return Err("duplicate first delta evidence for an active response".into());
            }
            if milestone == "renderer-ack" && (!self.active_responses.contains(&timeline.response_id)
                || timeline.stream_start_count != 1 || timeline.render_session_id.is_none()
                || timeline.audio_done_at_ms.is_none() || timeline.render_complete_at_ms.is_none()
                || timeline.renderer_ack_at_ms.is_none() || timeline.renderer_ack_receipt_id.is_none()
                || timeline.source_sample_rate_hz != 24_000 || timeline.render_sample_rate_hz != 48_000
                || timeline.accepted_source_frames == 0
                || timeline.rendered_frames != timeline.accepted_source_frames.saturating_mul(2)) {
                return Err("playback timeline ACK lacks complete continuous physical authority".into());
            }
            let mut bytes = serde_json::to_vec(&serde_json::json!({
                "schemaVersion": 1, "artifactKind": "aec-desktop-playback-timeline",
                "sequence": self.rows + 1, "identity": self.identity, "milestone": milestone,
                "runMarker": self.identity["runMarker"], "cellId": self.identity["cellId"], "leaseId": self.identity["leaseId"],
                "observedAtUnixMs": crate::audio::time_utils::unix_ms(), "observedQpc100ns": observed_qpc,
                "timeline": timeline,
            })).map_err(|e| e.to_string())?;
            bytes.push(b'\n');
            self.file.as_mut().ok_or("playback timeline file unavailable")?.write_all(&bytes).map_err(|e| e.to_string())?;
            self.hasher.update(&bytes); self.bytes += bytes.len() as u64; self.rows += 1;
            if milestone == "audio-delta" { self.active_responses.insert(timeline.response_id.clone()); }
            if milestone == "renderer-ack" { self.active_responses.remove(&timeline.response_id); self.completed_responses += 1; }
            if milestone == "aborted" { return Err("playback response aborted before immutable successful ACK".into()); }
            Ok(())
        })();
        if let Err(error) = &result { self.fail(format!("playback timeline append failed: {error}")); }
        result
    }
    #[cfg(test)]
    pub(super) fn unavailable_for_test() -> Self {
        Self::open(Some(PathBuf::from("?:/not-a-timeline-directory")), serde_json::json!({}))
    }

    pub(super) fn failure_owner(&self) -> Option<(String, String)> {
        self.last_owner.clone()
    }

    pub(super) fn outcome(&self) -> Result<(), String> {
        if self.directory.is_none() || !self.started { return Ok(()); }
        if let Some(error) = &self.failure { return Err(error.clone()); }
        if self.directory.is_some() && !self.sealed { return Err("enabled playback timeline was never sealed".into()); }
        Ok(())
    }

    pub(super) fn seal(&mut self) -> Result<(), String> {
        if self.directory.is_none() || !self.started { return Ok(()); }
        if self.sealed { return self.failure.clone().map_or(Ok(()), Err); }
        self.sealed = true;
        if self.rows == 0 { self.fail("playback timeline has no authoritative output milestones".into()); }
        if !self.active_responses.is_empty() { self.fail(format!("playback timeline has unacknowledged responses: {:?}", self.active_responses)); }
        if let Some(mut file) = self.file.take() {
            if let Err(error) = file.flush().and_then(|_| file.sync_all()) { self.fail(format!("playback timeline flush/sync failed: {error}")); }
        } else { self.fail("playback timeline file missing at seal".into()); }
        let terminal = serde_json::json!({
            "schemaVersion": 1, "artifactKind": "aec-desktop-playback-timeline-terminal",
            "identity": self.identity, "runMarker": self.identity["runMarker"], "cellId": self.identity["cellId"],
            "leaseId": self.identity["leaseId"], "complete": self.failure.is_none(), "countsFinal": true,
            "error": self.failure, "completedResponses": self.completed_responses, "pendingResponses": self.active_responses, "timeline": {"file": TIMELINE_FILE, "bytes": self.bytes,
                "rows": self.rows, "sha256": format!("{:x}",self.hasher.clone().finalize())},
        });
        let directory = self.directory.as_ref().expect("enabled evidence directory");
        let result = (|| -> Result<(), String> {
            // A seal is never overwritten or replaced by a later success.
            let mut file = OpenOptions::new().write(true).create_new(true).open(directory.join(TERMINAL_FILE)).map_err(|e| e.to_string())?;
            serde_json::to_writer(&mut file, &terminal).map_err(|e| e.to_string())?;
            file.write_all(b"\n").and_then(|_|file.flush()).and_then(|_|file.sync_all()).map_err(|e| e.to_string())
        })();
        if let Err(error) = result { self.fail(format!("playback timeline seal failed: {error}")); }
        self.failure.clone().map_or(Ok(()), Err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exclusive_append_and_hash_seal_never_overwrite_existing_evidence() {
        let directory=std::env::temp_dir().join(format!("omni-timeline-{}-{}",std::process::id(),crate::audio::time_utils::unix_ms()));
        std::fs::create_dir(&directory).unwrap();
        let mut writer=TimelineEvidence::open(Some(directory.clone()),serde_json::json!({"runMarker":"test"}));
        let timeline=DesktopPlaybackTimeline{cue_id:"cue".into(),response_id:"response".into(),first_audio_delta_at_ms:1,
            first_audio_delta_qpc_100ns:Some(100),..Default::default()};
        writer.append("audio-delta",&timeline).unwrap();
        let acknowledged = DesktopPlaybackTimeline { audio_done_at_ms:Some(2),audio_done_qpc_100ns:Some(200),
            render_start_at_ms:Some(2),render_start_qpc_100ns:Some(200),render_complete_at_ms:Some(3),render_complete_qpc_100ns:Some(300),
            renderer_ack_at_ms:Some(4),renderer_ack_qpc_100ns:Some(400),renderer_ack_receipt_id:Some("session-receipt".into()),
            render_session_id:Some(1), stream_start_count:1,source_sample_rate_hz:24_000,render_sample_rate_hz:48_000,
            accepted_source_frames:24,rendered_frames:48, ..timeline.clone() };
        writer.append("renderer-ack",&acknowledged).unwrap();
        assert_eq!(writer.failure_owner(), Some(("cue".into(), "response".into())),
            "seal failure must retain the real ACK owner, not a synthetic timeline cue");
        writer.seal().unwrap();
        assert!(writer.append("late",&timeline).is_err());
        let bytes=std::fs::read(directory.join(TIMELINE_FILE)).unwrap();
        let seal:serde_json::Value=serde_json::from_slice(&std::fs::read(directory.join(TERMINAL_FILE)).unwrap()).unwrap();
        assert_eq!(seal["complete"],true); assert_eq!(seal["timeline"]["rows"],2);
        assert_eq!(seal["timeline"]["sha256"],format!("{:x}",Sha256::digest(&bytes)));
        let mut duplicate=TimelineEvidence::open(Some(directory.clone()),serde_json::json!({}));
        assert!(duplicate.append("duplicate",&timeline).is_err()); assert!(duplicate.seal().is_err());
        assert_eq!(std::fs::read(directory.join(TIMELINE_FILE)).unwrap(),bytes);
        std::fs::remove_file(directory.join(TIMELINE_FILE)).unwrap();
        std::fs::remove_file(directory.join(TERMINAL_FILE)).unwrap(); std::fs::remove_dir(directory).unwrap();
    }
    #[test]
    fn unavailable_directory_and_missing_qpc_fail_closed() {
        let mut writer=TimelineEvidence::open(Some(PathBuf::from("?:/not-a-timeline-directory")),serde_json::json!({}));
        let timeline = DesktopPlaybackTimeline { cue_id:"unsubmitted-cue".into(), response_id:"actual-response".into(), ..Default::default() };
        assert!(writer.append("audio-delta",&timeline).is_err());
        assert_eq!(writer.failure_owner(), Some(("unsubmitted-cue".into(), "actual-response".into())));
        assert!(writer.seal().is_err());
    }
}
