//! Acoustic feedback-loop simulation: TTS speaker output convolved with a
//! sparse room impulse response is fed back into the capture path, and the
//! REAL defense chain (EchoReferenceBuffer subtraction → suppressed-chunk
//! accounting → echo-dominance classification → manual-response gate) must
//! not produce a second turn. Pure Rust, no audio devices.
//!
//! The three scenarios reconstruct the 2026-07-26 feedback-incident classes
//! (b5e7379 → c263838 → d112b5d) as deterministic waveforms. The original
//! field recordings are not stored in the repository, so these are synthetic
//! reconstructions of each incident's acoustic shape; if the incident WAVs
//! are ever added under fixtures/, `simulate_room_loop` can replay them via
//! `hound` unchanged.

use std::time::{Duration, Instant};

use super::connection_coordinator::{
    classify_manual_response, recent_echo_input_is_dominated, ManualResponseDecision,
};
use crate::audio::echo_cancel::EchoReferenceBuffer;

const SAMPLE_RATE_HZ: usize = 48_000;
const CHANNELS: usize = 2;
/// Mirrors ECHO_CANCEL_DELAY_SAMPLES in the capture engine (100ms @48k stereo).
const DELAY_SAMPLES: usize = 9_600;
/// One 960-frame stereo capture chunk (20ms).
const CHUNK_FRAMES: usize = 960;
const CHUNK_SAMPLES: usize = CHUNK_FRAMES * CHANNELS;

/// A sparse room impulse response: direct path plus a few reflections.
/// (delay in 48k mono samples, gain)
struct RoomImpulse {
    taps: Vec<(usize, f32)>,
}

impl RoomImpulse {
    fn small_room(direct_gain: f32) -> Self {
        Self {
            taps: vec![
                (0, direct_gain),
                (317, direct_gain * 0.35),
                (911, direct_gain * 0.2),
                (1637, direct_gain * 0.1),
            ],
        }
    }
}

/// Deterministic speech-shaped TTS waveform (AM-modulated tone bursts with
/// pauses), 48k mono.
fn synthetic_tts(seconds: usize) -> Vec<f32> {
    let total = seconds * SAMPLE_RATE_HZ;
    (0..total)
        .map(|index| {
            let t = index as f32 / SAMPLE_RATE_HZ as f32;
            // Sentence rhythm: ~600ms bursts with ~200ms gaps.
            let burst = ((t / 0.8).fract() < 0.75) as u8 as f32;
            let envelope = (t * 6.7).sin().abs() * 0.6 + 0.4;
            (t * 2.0 * std::f32::consts::PI * 220.0).sin()
                * (t * 2.0 * std::f32::consts::PI * 3.1).sin().mul_add(0.2, 0.8)
                * envelope
                * burst
                * 0.5
        })
        .collect()
}

struct LoopOutcome {
    total_chunks: u64,
    suppressed_chunks: u64,
    /// Max RMS of any cleaned chunk that was NOT suppressed (audio that would
    /// reach ASR). The single-delay canceller lets short reverb tails through
    /// at burst boundaries (the aligned reference is already silent while
    /// reflections still ring), so this is asserted RELATIVE to the raw echo
    /// level — the turn-level dominance gate is the defense that must be
    /// absolute.
    max_unsuppressed_rms: f32,
    /// Max RMS of the raw microphone chunks (the untreated echo level).
    max_raw_rms: f32,
}

fn rms(samples: &[f32]) -> f32 {
    (samples.iter().map(|sample| sample * sample).sum::<f32>() / samples.len() as f32).sqrt()
}

/// Plays `speaker_wave` through the echo reference (as push_echo_reference
/// does) while the microphone hears the room-convolved echo, chunk by chunk,
/// through the real canceller.
fn simulate_room_loop(speaker_wave: &[f32], room: &RoomImpulse) -> LoopOutcome {
    // Microphone signal: sparse convolution of the speaker wave with the room
    // impulse, arriving DELAY_SAMPLES (interleaved) after playback.
    let mono_delay_frames = DELAY_SAMPLES / CHANNELS;
    let mic_len = speaker_wave.len();
    let mut mic = vec![0.0_f32; mic_len];
    for (tap_delay, gain) in &room.taps {
        let offset = mono_delay_frames + tap_delay;
        for index in offset..mic_len {
            mic[index] += speaker_wave[index - offset] * gain;
        }
    }

    let playback_started = Instant::now();
    let mut reference = EchoReferenceBuffer::new(SAMPLE_RATE_HZ * 30);
    reference.push_samples_at(speaker_wave, SAMPLE_RATE_HZ as u32, 1, playback_started);

    let mut outcome = LoopOutcome {
        total_chunks: 0,
        suppressed_chunks: 0,
        max_unsuppressed_rms: 0.0,
        max_raw_rms: 0.0,
    };
    let chunk_count = mic_len / CHUNK_FRAMES;
    for chunk_index in 1..chunk_count {
        let start_frame = chunk_index * CHUNK_FRAMES;
        let captured: Vec<f32> = (0..CHUNK_SAMPLES)
            .map(|sample_index| mic[start_frame + sample_index / CHANNELS])
            .collect();
        let now = playback_started
            + Duration::from_micros((start_frame as u64 + CHUNK_FRAMES as u64) * 1_000_000 / SAMPLE_RATE_HZ as u64);
        outcome.max_raw_rms = outcome.max_raw_rms.max(rms(&captured));
        let cancellation = reference.subtract_from_at(&captured, DELAY_SAMPLES, now);
        outcome.total_chunks += 1;
        if cancellation.suppress_asr {
            outcome.suppressed_chunks += 1;
        } else {
            outcome.max_unsuppressed_rms = outcome
                .max_unsuppressed_rms
                .max(rms(&cancellation.samples));
        }
    }
    outcome
}

/// Shared final assertion: the loop must not be able to open a second turn.
fn assert_no_second_turn(outcome: &LoopOutcome, incident: &str) {
    // The chunk accounting must classify the stretch as echo-dominated…
    assert!(
        recent_echo_input_is_dominated(outcome.total_chunks, outcome.suppressed_chunks),
        "{incident}: echo dominance not detected (total={} suppressed={})",
        outcome.total_chunks,
        outcome.suppressed_chunks,
    );
    // …and with the guard active, a garbled loop transcript during recent
    // playback must never arm response.create — the second turn dies here.
    let decision = classify_manual_response(
        "这是被房间回路重新拾取的翻译语音",
        "完全不同的上一轮翻译输出",
        Some(2_000),
        true,
        recent_echo_input_is_dominated(outcome.total_chunks, outcome.suppressed_chunks),
    );
    assert_eq!(
        decision,
        ManualResponseDecision::SkipEchoDominatedPlayback,
        "{incident}: the manual gate must skip the echo-dominated turn"
    );
}

/// Incident class 1 (b5e7379): moderate speaker→mic bleed through the room.
#[test]
fn room_bleed_does_not_produce_a_second_turn() {
    let tts = synthetic_tts(4);
    let outcome = simulate_room_loop(&tts, &RoomImpulse::small_room(0.5));
    assert_no_second_turn(&outcome, "room-bleed");
    // Anything escaping chunk-level suppression is a reverb tail at a burst
    // boundary (the aligned reference is already silent while reflections
    // still ring — a known limit of the single-delay canceller; the
    // turn-level gate above is the absolute defense). Observed residual is
    // ~0.40x of the raw echo peak; the 0.45x canary trips if the gate ever
    // regresses to passing playback-dominated chunks wholesale (~1.0x).
    assert!(
        outcome.max_unsuppressed_rms < outcome.max_raw_rms * 0.45,
        "room-bleed: escaped residual not attenuated (residual_rms={} raw_rms={})",
        outcome.max_unsuppressed_rms,
        outcome.max_raw_rms
    );
}

/// Incident class 2 (c263838): hot loopback — the acoustic path is louder
/// than the canceller's fixed attenuation model, so linear subtraction alone
/// leaves an audible residual. The playback gate must still keep it from ASR.
#[test]
fn hot_loopback_residual_is_gated_before_asr() {
    let tts = synthetic_tts(4);
    let outcome = simulate_room_loop(&tts, &RoomImpulse::small_room(1.0));
    assert_no_second_turn(&outcome, "hot-loopback");
    assert!(
        outcome.max_unsuppressed_rms < outcome.max_raw_rms * 0.45,
        "hot-loopback: escaped residual not attenuated (residual_rms={} raw_rms={})",
        outcome.max_unsuppressed_rms,
        outcome.max_raw_rms
    );
}

/// Incident class 3 (d112b5d): the source media is paused, so for a long
/// stretch the microphone hears ONLY the (quieter) translated playback. The
/// suppressed-chunk share must dominate and hold the gate shut.
#[test]
fn paused_source_pure_echo_keeps_the_gate_shut() {
    let tts = synthetic_tts(6);
    let outcome = simulate_room_loop(&tts, &RoomImpulse::small_room(0.25));
    assert!(
        outcome.total_chunks >= 120,
        "scenario must cover the dominance window (got {} chunks)",
        outcome.total_chunks
    );
    assert_no_second_turn(&outcome, "paused-source");
}
