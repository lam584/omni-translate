// GENERATED FILE - do not edit by hand.
// Source of truth: apps/desktop/src-tauri/src/audio/contracts.rs
// Regenerate: OMNI_UPDATE_CONTRACTS=1 cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml contract_export

export type AudioDeviceRuntime = { deviceId: string, label: string, interfaceName: string, direction: 'render' | 'capture', isDefault: boolean, state: string, };

export type AudioRouteRuntimeSnapshot = { routeId: string, direction: 'inbound' | 'outbound', requestedDeviceId: string, effectiveDeviceId: string, captureState: 'idle' | 'armed' | 'capturing' | 'buffering' | 'muted' | 'stopping', preBufferState: 'cold' | 'primed' | 'ready' | 'draining', vadState: 'silence' | 'speech', bufferAheadMs: number, framesCaptured: number, segmentCount: number, streamBound: boolean, lastEnergyDb: number, lastFrameAt: string | null, activeSegmentId: string | null, lastError: string | null, lastErrorCode: string | null, recommendedAction: string | null, };

export type SubtitleDisplaySegmentRuntime = { sourceText: string, translatedText: string, pending: boolean, };

export type SubtitleCueRuntime = { cueId: string, routeDirection: 'inbound' | 'outbound', sourceText: string, displaySourceText?: string, displaySegments?: Array<SubtitleDisplaySegmentRuntime>, translatedText: string, startedAt: string, endedAt: string,
/**
 * Transcription lifecycle: `true` once the ASR transcript for this cue is
 * finalized (ASR-commit). Independent from translation completion.
 */
committed: boolean,
/**
 * Translation lifecycle: `true` once a finalized translation exists for the
 * current `source_text`. A late final transcript that overwrites
 * `source_text` clears this so the cue is re-translated against the
 * committed text. Serialized only when `true` to keep the wire lean and the
 * TypeScript field optional.
 */
translationCommitted?: boolean, };

export type SubtitleOverlayRuntimeSnapshot = { queueDepth: number, droppedCueCount: number, firstTranslationAverageMs: number | null, firstTranslationLastMs: number | null, firstTranslationSampleCount: number,
/**
 * Stable in-memory Watch report id. The overlay echoes this value in its
 * post-render receipt so stale windows cannot mutate a newer session.
 */
reportSessionId: string | null, activeCue: SubtitleCueRuntime | null, recentCues: Array<SubtitleCueRuntime>, };

export type WatchTimelineEventRuntime = { eventId: string, stage: 'source' | 'model' | 'publish' | 'render' | 'error' | 'session', kind: string, elapsedMs: number, text: string, detail: string | null, finalEvent: boolean, accepted: boolean, visible: boolean | null, callId: string | null, attemptId: string | null, };

export type WatchIssueRuntime = { category: 'model' | 'publish' | 'render' | 'content' | 'timing' | 'output' | 'data' | 'session', code: string, severity: 'warning' | 'error', message: string, cueId: string | null, elapsedMs: number | null, occurrenceCount: number, };

export type WatchCueComparisonRuntime = { cueId: string, revision: number, routeDirection: 'inbound' | 'outbound', translationPath: string, sourceText: string, llmText: string, publishedText: string, publishedSegments: Array<SubtitleDisplaySegmentRuntime>, renderedSourceText: string, renderedText: string, comparisonStatus: 'exact' | 'formatting-only' | 'different' | 'not-published' | 'not-rendered' | 'model-error' | 'pending' | 'superseded', sourceAtMs: number | null, llmFirstAtMs: number | null, llmFinalAtMs: number | null, publishedFirstAtMs: number | null, publishedFinalAtMs: number | null, renderedFirstAtMs: number | null, renderedFinalAtMs: number | null, sourceToLlmFirstMs: number | null, sourceToRenderMs: number | null, llmFirstToPublishMs: number | null, publishToRenderMs: number | null, llmFirstToRenderMs: number | null, llmFinalToPublishMs: number | null, publishedFinalToRenderMs: number | null, llmFinalToRenderMs: number | null, events: Array<WatchTimelineEventRuntime>, issues: Array<WatchIssueRuntime>, droppedEventCount: number, };

export type WatchSessionReportSummaryRuntime = { durationMs: number, cueCount: number, completeCueCount: number, visibleRenderCueCount: number, unrenderedCueCount: number, issueCount: number, issueOccurrenceCount: number, averageSourceToLlmFirstMs: number | null, p95SourceToLlmFirstMs: number | null, maxSourceToLlmFirstMs: number | null, averageSourceToRenderMs: number | null, p95SourceToRenderMs: number | null, maxSourceToRenderMs: number | null, averageLlmFirstToRenderMs: number | null, p95LlmFirstToRenderMs: number | null, maxLlmFirstToRenderMs: number | null, averageLlmFinalToRenderMs: number | null, p95LlmFinalToRenderMs: number | null, maxLlmFinalToRenderMs: number | null, slowestCueId: string | null, };

export type WatchSessionReportRuntime = { sessionId: string, status: 'active' | 'completed', routeMode: string, providerId: string, model: string, startedAt: string, endedAt: string | null, elapsedMs: number, summary: WatchSessionReportSummaryRuntime, cues: Array<WatchCueComparisonRuntime>, events: Array<WatchTimelineEventRuntime>, issues: Array<WatchIssueRuntime>, droppedCueCount: number, droppedEventCount: number, };

export type OverlayRenderReceiptRuntime = { sessionId: string, cueId: string, revision: number, sourceText: string, translatedText: string, committed: boolean, visible: boolean,
/**
 * Renderer wall-clock timestamp (`performance.timeOrigin + now`) in
 * milliseconds. The report store validates it before using it.
 */
renderedAtMs: number, };

export type SpeechDispatchEventRuntime = { eventId: string, kind: string, summary: string, emittedAt: string, cueId: string | null, requestId: string | null, };

export type SpeechRuntimeSnapshot = { status: 'preview' | 'ready' | 'degraded', dispatchState: 'idle' | 'waiting-subtitle' | 'queued' | 'deferred' | 'playing' | 'error', queueDepth: number, cacheEntries: number, policy: string, outputTarget: string, currentCueId: string | null, currentRequestId: string | null, lastStartedAt: string | null, lastCompletedAt: string | null, lastError: string | null, speakerFramesWritten: number, virtualMicFramesWritten: number, mixMode: string, pttGateOpen: boolean, duckingActive: boolean, recentEvents: Array<SpeechDispatchEventRuntime>, };

export type SttConnectionRuntime = {
/**
 * "idle" | "connected" | "reconnecting" | "disconnected"
 */
state: 'idle' | 'connected' | 'reconnecting' | 'disconnected', reconnectAttempt: number, maxReconnectAttempts: number, lastDisconnectReason: string | null, };

export type AudioRuntimeSnapshot = {
/**
 * Monotonically increasing sequence number. Each call to
 * `AudioStateStore::snapshot()` increments a global counter so the
 * frontend can discard stale out-of-order push events (e.g. a pre-clear
 * snapshot arriving after the clear invoke reply).
 */
snapshotSeq: number, status: 'preview' | 'ready' | 'degraded', host: string, renderDevices: Array<AudioDeviceRuntime>, captureDevices: Array<AudioDeviceRuntime>, inbound: AudioRouteRuntimeSnapshot, outbound: AudioRouteRuntimeSnapshot, subtitleOverlay: SubtitleOverlayRuntimeSnapshot, speech: SpeechRuntimeSnapshot, sessionStartedAt: string | null, sttConnected: boolean, sttBufferSize: number, sttConnection: SttConnectionRuntime, };

