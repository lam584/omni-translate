use crate::artifacts::CueStatusTimelineEventEvidence;
use omni_bridge_service::{
    AudioFrameHeader, AudioRouteDirection, AudioSampleFormat, TranslationAudioSink,
};
use omni_bridge_protocol::{
    AudioFrameAck, TranslationPlaybackStatusAck, TranslationPlaybackStatusEvent,
};
use serde_json::{json, Value};
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MAX_FRAMED_HEADER_BYTES: usize = 1024 * 1024;

pub(super) fn control(pipe_name: &str, payload: Value) -> Result<Value, String> {
    let mut pipe = open_pipe(&format!(r"\\.\pipe\{pipe_name}"), Duration::from_secs(5))?;
    writeln!(
        pipe,
        "{}",
        serde_json::to_string(&payload).map_err(error_text)?
    )
    .map_err(error_text)?;
    let mut reader = BufReader::new(pipe);
    let mut line = String::new();
    reader.read_line(&mut line).map_err(error_text)?;
    if line.trim().is_empty() {
        return Err("Bridge control pipe returned an empty response".to_string());
    }
    serde_json::from_str(line.trim()).map_err(error_text)
}

pub(super) fn send_virtual_mic_cue(
    pipe_name: &str,
    session_id: &str,
    cue_id: &str,
    pcm: &[i16],
) -> Result<AudioFrameAck, String> {
    let payload = pcm
        .iter()
        .flat_map(|sample| sample.to_le_bytes())
        .collect::<Vec<_>>();
    let created_at_ms = unix_ms();
    let header = build_virtual_mic_header(
        session_id,
        cue_id,
        pcm.len(),
        payload.len(),
        created_at_ms,
    );
    let mut pipe = open_pipe(
        &format!(r"\\.\pipe\{pipe_name}-audio"),
        Duration::from_secs(5),
    )?;
    let header_bytes = serde_json::to_vec(&header).map_err(error_text)?;
    pipe.write_all(&(header_bytes.len() as u32).to_le_bytes())
        .map_err(error_text)?;
    pipe.write_all(&header_bytes).map_err(error_text)?;
    pipe.write_all(&payload).map_err(error_text)?;
    pipe.flush().map_err(error_text)?;
    let ack: AudioFrameAck = read_framed_json(&mut pipe)?;
    if ack.event_type != "bridge.translation.ack"
        || ack.error_code.is_some()
        || ack.accepted_frames != pcm.len()
    {
        return Err(format!("Bridge rejected virtual microphone cue: {ack:?}"));
    }
    Ok(ack)
}

pub(super) fn collect_cue_statuses(
    pipe_name: &str,
    cue_id: &str,
    timeout: Duration,
) -> Result<Vec<CueStatusTimelineEventEvidence>, String> {
    let pipe = open_pipe(
        &format!(r"\\.\pipe\{pipe_name}-source"),
        Duration::from_secs(5),
    )?;
    let mut reader = BufReader::new(pipe);
    let started = Instant::now();
    let mut terminal_seen_at = None;
    let mut events = Vec::new();
    let mut last_received_at_monotonic_ns = 0_u64;
    loop {
        if started.elapsed() >= timeout {
            return Err(format!(
                "timed out waiting for exactly-once virtual microphone status events for cue {cue_id}"
            ));
        }
        let header = read_source_envelope(&mut reader)?;
        if header["type"].as_str() == Some("bridge.translation.status") {
            let event: TranslationPlaybackStatusEvent =
                serde_json::from_value(header).map_err(error_text)?;
            acknowledge_translation_status(reader.get_mut(), &event)?;
            if event.cue_id == cue_id {
                if event.playback_status.is_terminal() {
                    terminal_seen_at.get_or_insert_with(Instant::now);
                }
                let observed_ns = u64::try_from(started.elapsed().as_nanos()).unwrap_or(u64::MAX);
                let received_at_monotonic_ns = observed_ns
                    .max(last_received_at_monotonic_ns.saturating_add(1));
                last_received_at_monotonic_ns = received_at_monotonic_ns;
                events.push(CueStatusTimelineEventEvidence {
                    event,
                    collector_received_at_monotonic_ns: received_at_monotonic_ns,
                });
            }
        }
        if terminal_seen_at
            .is_some_and(|terminal| terminal.elapsed() >= Duration::from_millis(300))
        {
            return Ok(events);
        }
    }
}

pub(super) fn shutdown_bridge(pipe_name: &str) {
    let _ = control(
        pipe_name,
        json!({
            "type": "bridge.shutdown",
            "requestId": format!("virtual-mic-target-capture-shutdown-{}", unix_ms()),
            "sessionId": "virtual-mic-target-capture",
            "reason": "virtual-mic-target-capture-complete"
        }),
    );
}

pub(super) fn open_pipe(path: &str, timeout: Duration) -> Result<File, String> {
    let started = Instant::now();
    loop {
        match OpenOptions::new().read(true).write(true).open(path) {
            Ok(file) => return Ok(file),
            Err(error) if started.elapsed() < timeout => {
                let _ = error;
                thread::sleep(Duration::from_millis(25));
            }
            Err(error) => {
                return Err(format!(
                    "failed to open Bridge pipe {path} within {}ms: {error}",
                    timeout.as_millis()
                ))
            }
        }
    }
}

pub(super) fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

fn build_virtual_mic_header(
    session_id: &str,
    cue_id: &str,
    frame_count: usize,
    payload_bytes: usize,
    created_at_ms: u64,
) -> AudioFrameHeader {
    AudioFrameHeader {
        event_type: "bridge.translation.frame".to_string(),
        request_id: format!("virtual-mic-target-capture-{created_at_ms}"),
        session_id: session_id.to_string(),
        frame_id: format!("virtual-mic-target-frame-{created_at_ms}"),
        stream_id: "virtual-mic-target-capture".to_string(),
        sample_rate_hz: 48_000,
        sample_format: AudioSampleFormat::PcmS16le,
        channel_count: 1,
        frame_count,
        timestamp_ms: created_at_ms,
        payload_bytes,
        bridge_process_id: None,
        bridge_instance_id: None,
        source_generation: None,
        source_generation_token: None,
        cue_id: Some(cue_id.to_string()),
        created_at_ms: Some(created_at_ms),
        estimated_duration_ms: Some((frame_count as u64 * 1_000).div_ceil(48_000)),
        chunk_index: Some(0),
        chunk_count: Some(1),
        stream_state: None,
        translated_audio_enhancement_applied: true,
        translation_sink: Some(TranslationAudioSink::VirtualMic),
        route_direction: Some(AudioRouteDirection::Outbound),
    }
}

fn read_framed_json<T: serde::de::DeserializeOwned>(pipe: &mut File) -> Result<T, String> {
    let mut length = [0_u8; 4];
    pipe.read_exact(&mut length).map_err(error_text)?;
    let length = u32::from_le_bytes(length) as usize;
    if length == 0 || length > MAX_FRAMED_HEADER_BYTES {
        return Err(format!("Bridge returned an invalid framed JSON length: {length}"));
    }
    let mut body = vec![0_u8; length];
    pipe.read_exact(&mut body).map_err(error_text)?;
    serde_json::from_slice(&body).map_err(error_text)
}

fn read_source_envelope(reader: &mut BufReader<File>) -> Result<Value, String> {
    let mut length = [0_u8; 4];
    reader.read_exact(&mut length).map_err(error_text)?;
    let length = u32::from_le_bytes(length) as usize;
    if length == 0 || length > MAX_FRAMED_HEADER_BYTES {
        return Err(format!("Bridge source returned an invalid header length: {length}"));
    }
    let mut header = vec![0_u8; length];
    reader.read_exact(&mut header).map_err(error_text)?;
    let header: Value = serde_json::from_slice(&header).map_err(error_text)?;
    let payload_bytes = header["payloadBytes"].as_u64().unwrap_or_default() as usize;
    if payload_bytes > 16 * 1024 * 1024 {
        return Err(format!(
            "Bridge source returned an unreasonable payload length: {payload_bytes}"
        ));
    }
    if payload_bytes > 0 {
        let mut payload = vec![0_u8; payload_bytes];
        reader.read_exact(&mut payload).map_err(error_text)?;
    }
    Ok(header)
}

fn acknowledge_translation_status(
    pipe: &mut File,
    event: &TranslationPlaybackStatusEvent,
) -> Result<(), String> {
    let ack = TranslationPlaybackStatusAck {
        event_type: "bridge.translation.status.ack".to_string(),
        status_id: event.status_id.clone(),
        session_id: event.session_id.clone(),
    };
    let header = serde_json::to_vec(&ack).map_err(error_text)?;
    pipe.write_all(&(header.len() as u32).to_le_bytes())
        .map_err(error_text)?;
    pipe.write_all(&header).map_err(error_text)?;
    pipe.flush().map_err(error_text)
}

fn error_text(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn virtual_mic_frame_is_explicitly_outbound_and_generation_chunked() {
        let header = build_virtual_mic_header("session", "cue", 960, 1_920, 42);
        assert_eq!(header.translation_sink, Some(TranslationAudioSink::VirtualMic));
        assert_eq!(header.route_direction, Some(AudioRouteDirection::Outbound));
        assert_eq!(header.chunk_index, Some(0));
        assert_eq!(header.chunk_count, Some(1));
        assert!(header.translated_audio_enhancement_applied);
        assert_eq!(header.sample_rate_hz, 48_000);
        assert_eq!(header.channel_count, 1);
        assert_eq!(header.payload_bytes, 1_920);
    }
}
