// GENERATED FILE - do not edit by hand.
// Source of truth: apps/desktop/src-tauri/src/history/playback.rs
// Regenerate: OMNI_UPDATE_CONTRACTS=1 cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml contract_export

export type HistoryAudioTrack = "source" | "translated";

export type HistoryChangedEventV2 = { reason: 'sessionStarted' | 'sessionFinalized' | 'sessionDeleted' | 'historyCleared' | 'archiveGap', sessionId: string | null, timestampMs: number, };

export type HistoryPlaybackEventV2 = { playbackId: string, sessionId: string, cueId: string, track: HistoryAudioTrack, status: 'started' | 'stopped' | 'failed', reason: string | null, error: string | null, timestampMs: number, };

export type HistoryPlaybackStartV2 = { playbackId: string, status: 'started', };

export type HistoryPlaybackStopV2 = { stopped: boolean, };
