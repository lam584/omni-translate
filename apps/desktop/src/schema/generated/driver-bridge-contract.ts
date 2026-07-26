// GENERATED FILE - do not edit by hand.
// Source of truth: crates/omni-bridge-protocol/src/lib.rs
// Regenerate: OMNI_UPDATE_CONTRACTS=1 cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml contract_export

export type MixControl = { keepOriginalAudio: boolean, translatedAudioEnabled: boolean, translatedAudioGainDb: number, originalAudioGainDb: number, duckingEnabled: boolean, duckingDepthPercent: number, monitorMode: string, };

export type AudioFrameHeader = { type: 'bridge.source.frame' | 'bridge.translation.frame', requestId: string, sessionId: string, frameId: string, streamId: string, sampleRateHz: 16000 | 24000 | 48000, channelCount: 1 | 2, frameCount: number, timestampMs: number, payloadBytes: number, };

export type AudioFrameAck = { type: 'bridge.source.ack' | 'bridge.translation.ack' | 'bridge.translation.nack', requestId: string, frameId: string, acceptedFrames: number, playbackFramesWritten: number, errorCode?: string, message?: string, };

