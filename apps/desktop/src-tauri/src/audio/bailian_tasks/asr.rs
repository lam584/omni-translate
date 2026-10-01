use std::sync::mpsc;

use tauri::AppHandle;

use crate::audio::engine::emit_audio_snapshot;
use crate::audio::pcm_resample::resample_capture_to_mono_i16;
use crate::audio::state::AudioStateStore;
use crate::provider::contracts::ProviderDraftInput;

use super::lifecycle::{TaskFailure, TaskOutput};
use super::worker::TaskSession;
use super::{TaskError, TaskRole};

const MAX_CHUNKS_PER_TICK: usize = 8;
const MAX_STOP_DRAIN_CHUNKS: usize = 256;

fn apply_output(store: &AudioStateStore, direction: &str, task_id: &str, output: TaskOutput) {
    if let TaskOutput::Transcript { sentence_id, text, final_sentence } = output {
        let cue_id = format!("stt-cue-{direction}-{task_id}-{sentence_id}");
        if final_sentence {
            store.commit_stt_cue(&cue_id, &text, direction);
        } else {
            store.update_or_push_stt_cue(&cue_id, &text, false);
        }
        store.watch_session_report.push_asr_delta(
            if final_sentence { "task.asr.sentence-final" } else { "task.asr.sentence-preview" }, "", &text,
        );
    }
}

fn send_capture(session: &mut TaskSession, raw: &[u8]) -> Result<(), TaskError> {
    if raw.len() % 8 != 0 {
        return Err(TaskError::new(TaskRole::Asr, TaskFailure::InvalidFrame, "capture chunk is not stereo f32 aligned"));
    }
    let samples = resample_capture_to_mono_i16(raw, 16000);
    if !samples.is_empty() {
        session.send_pcm(samples.iter().flat_map(|sample| sample.to_le_bytes()).collect())?;
    }
    Ok(())
}

pub(crate) fn run_asr(
    app: &AppHandle, store: &AudioStateStore, provider: &ProviderDraftInput, direction: &str,
    audio_rx: mpsc::Receiver<Vec<u8>>, stop_rx: mpsc::Receiver<()>,
) -> Result<(), TaskError> {
    let mut session = TaskSession::connect(provider, TaskRole::Asr, "", "")?;
    session.wait_started()?;
    store.set_stt_connected(true, 0);
    emit_audio_snapshot(app, store).map_err(|error| TaskError::new(TaskRole::Asr, TaskFailure::Transport, error))?;
    let mut buffer_size = 0_u64;
    loop {
        let stopping = !matches!(stop_rx.try_recv(), Err(mpsc::TryRecvError::Empty));
        if stopping {
            // Bound queue drain even if a producer continues racing after stop.
            session.begin_drain();
            for index in 0..=MAX_STOP_DRAIN_CHUNKS {
                match audio_rx.try_recv() {
                    Ok(raw) if index < MAX_STOP_DRAIN_CHUNKS => {
                        send_capture(&mut session, &raw)?;
                        buffer_size = buffer_size.saturating_add(raw.len() as u64);
                        if let Some(output) = session.poll()? { apply_output(store, direction, session.task_id(), output); }
                    }
                    Ok(_) => return Err(TaskError::new(TaskRole::Asr, TaskFailure::StopDrain, "capture queue did not quiesce within the stop drain bound")),
                    Err(_) => break,
                }
            }
            session.finish()?;
            while !session.finished() {
                if let Some(output) = session.poll()? { apply_output(store, direction, session.task_id(), output); }
            }
            store.set_stt_connected(false, buffer_size);
            emit_audio_snapshot(app, store).map_err(|error| TaskError::new(TaskRole::Asr, TaskFailure::Transport, error))?;
            return Ok(());
        }
        for _ in 0..MAX_CHUNKS_PER_TICK {
            match audio_rx.try_recv() {
                Ok(raw) => {
                    send_capture(&mut session, &raw)?;
                    buffer_size = buffer_size.saturating_add(raw.len() as u64);
                }
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => {
                    session.finish()?;
                    while !session.finished() {
                        if let Some(output) = session.poll()? { apply_output(store, direction, session.task_id(), output); }
                    }
                    store.set_stt_connected(false, buffer_size);
                    emit_audio_snapshot(app, store).map_err(|error| TaskError::new(TaskRole::Asr, TaskFailure::Transport, error))?;
                    return Ok(());
                }
            }
        }
        if let Some(output) = session.poll()? { apply_output(store, direction, session.task_id(), output); }
        store.set_stt_connected(true, buffer_size);
    }
}
