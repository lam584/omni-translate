// GENERATED FILE - do not edit by hand.
// Source of truth: apps/desktop/src-tauri/src/audio/contracts.rs
// Regenerate: OMNI_UPDATE_CONTRACTS=1 cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml contract_export

export type AudioDeviceRuntime = { deviceId: string, label: string, interfaceName: string, direction: 'render' | 'capture', isDefault: boolean, state: string, };

export type AudioRouteRuntimeSnapshot = { routeId: string, direction: 'inbound' | 'outbound', requestedDeviceId: string, effectiveDeviceId: string, captureState: 'idle' | 'armed' | 'capturing' | 'buffering' | 'muted' | 'stopping', preBufferState: 'cold' | 'primed' | 'ready' | 'draining', vadState: 'silence' | 'speech', bufferAheadMs: number, framesCaptured: number, segmentCount: number, streamBound: boolean, lastEnergyDb: number, lastFrameAt: string | null, activeSegmentId: string | null, lastError: string | null, lastErrorCode: string | null, recommendedAction: string | null, };

export type SubtitleDisplaySegmentRuntime = { sourceText: string, translatedText: string, pending: boolean, };

export type SubtitleCueRuntime = { cueId: string, routeDirection: 'inbound' | 'outbound', sourceText: string, displaySourceText?: string, displaySegments?: Array<SubtitleDisplaySegmentRuntime>, translatedText: string, startedAt: string, endedAt: string, committed: boolean, };

export type SubtitleOverlayRuntimeSnapshot = { queueDepth: number, droppedCueCount: number, firstTranslationAverageMs: number | null, firstTranslationLastMs: number | null, firstTranslationSampleCount: number, activeCue: SubtitleCueRuntime | null, recentCues: Array<SubtitleCueRuntime>, };

export type SpeechDispatchEventRuntime = { eventId: string, kind: string, summary: string, emittedAt: string, cueId: string | null, requestId: string | null, };

export type SpeechRuntimeSnapshot = { status: 'preview' | 'ready' | 'degraded', dispatchState: 'idle' | 'waiting-subtitle' | 'queued' | 'deferred' | 'playing' | 'error', queueDepth: number, cacheEntries: number, policy: string, outputTarget: string, currentCueId: string | null, currentRequestId: string | null, lastStartedAt: string | null, lastCompletedAt: string | null, lastError: string | null, speakerFramesWritten: number, virtualMicFramesWritten: number, mixMode: string, pttGateOpen: boolean, duckingActive: boolean, recentEvents: Array<SpeechDispatchEventRuntime>, };

export type SttConnectionRuntime = { 
/**
 * "idle" | "connected" | "reconnecting" | "disconnected"
 */
state: 'idle' | 'connected' | 'reconnecting' | 'disconnected', reconnectAttempt: number, maxReconnectAttempts: number, lastDisconnectReason: string | null, };

export type AudioRuntimeSnapshot = { status: 'preview' | 'ready' | 'degraded', host: string, renderDevices: Array<AudioDeviceRuntime>, captureDevices: Array<AudioDeviceRuntime>, inbound: AudioRouteRuntimeSnapshot, outbound: AudioRouteRuntimeSnapshot, subtitleOverlay: SubtitleOverlayRuntimeSnapshot, speech: SpeechRuntimeSnapshot, sessionStartedAt: string | null, sttConnected: boolean, sttBufferSize: number, sttConnection: SttConnectionRuntime, };

