// GENERATED FILE - do not edit by hand.
// Source of truth: apps/desktop/src-tauri/src/bridge/contracts.rs
// Regenerate: OMNI_UPDATE_CONTRACTS=1 cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml contract_export

import type { MixControl } from './driver-bridge-contract';

export type BridgeAudioFrame = { frameId: string, streamId: string, encoding: 'pcm16le', channelLayout: 'mono' | 'stereo', sampleRateHz: 16000 | 24000 | 48000, channelCount: 1 | 2, frameCount: number, timestampMs: number, payloadRef: string, };

export type BridgeInitRequest = { requestId: string, protocolVersion: '2026-07-27-smart-gain-v3', sessionId: string, installChannel: 'development' | 'release', targetDeviceId: string, virtualRenderDeviceId: string, physicalPlaybackDeviceId: string, physicalPlaybackLevel: number, mixControl: MixControl, monitorPlaybackEnabled: boolean, expectedDriverVersion: string, expectedBridgeVersion: string, };

export type BridgeInitResponse = { requestId: string, protocolVersion: '2026-07-27-smart-gain-v3', bridgeState: 'stopped' | 'starting' | 'running' | 'degraded', driverHealth: 'not-installed' | 'damaged' | 'version-mismatch' | 'running', activeDriverVersion?: string, };

export type BridgeStateQuery = { requestId: string, };

export type BridgeStateResponse = { requestId: string, protocolVersion: '2026-07-27-smart-gain-v3', bridgeState: 'stopped' | 'starting' | 'running' | 'degraded', lifecycleState: 'idle' | 'initializing' | 'ready' | 'writing' | 'draining' | 'stopped' | 'error', driverHealth: 'not-installed' | 'damaged' | 'version-mismatch' | 'running', driverVersion?: string, bridgeVersion: string, captureBackend: string, captureLifecycleState: string, captureRestartCount: number, capturePacketCount: number, captureFramesReceived: number, capturePeak: number, captureRms: number, captureSilentPacketCount: number, captureInvalidSampleCount: number, resolvedPhysicalPlaybackDeviceId: string, monitorBufferedMs: number, monitorUnderrunCount: number, monitorOverrunCount: number, queuedFrames: number, sourceFramesCaptured: number, translatedFramesAccepted: number, playbackFramesWritten: number, underrunCount: number, droppedFrameCount: number, driverBufferedBytes: number, driverMaxBufferedBytes: number, driverCapturedBytes: number, driverDeliveredBytes: number, driverDroppedBytes: number, sourcePendingBytes: number, sourcePacerQueuedFrames: number, monitorSourceQueuedFrames: number, staleSourceFramesDropped: number, sourceSubscriberActive: boolean, sourceGeneration: number, sourceWorkerPhase: string, sourceWorkerLastProgressTimestampMs?: number, sourceReadCalls: number, sourceZeroByteReads: number, monitorPlaybackState: string, lastFrameTimestampMs?: number, lastErrorCode?: 'driver.not-installed' | 'driver.version-mismatch' | 'driver.write-failed' | 'driver.testsigning-disabled' | 'driver.secure-boot-enabled' | 'driver.memory-integrity-enabled' | 'driver.reboot-required' | 'driver.audio-probe-failed' | 'driver.duplicate-root-devices' | 'driver.endpoint-missing' | 'driver.ioctl-unavailable' | 'driver.abi-mismatch' | 'driver.elevation-cancelled' | 'driver.probe-failed' | 'driver.operation-failed' | 'bridge.not-ready' | 'bridge.queue-overflow' | 'bridge.permission-denied' | 'bridge.timeout' | 'bridge.session-mismatch' | 'bridge.singleton-already-running' | 'monitor.virtual-playback-loop' | 'installer.rollback-triggered', };

export type BridgeWriteFrameRequest = { requestId: string, sessionId: string, frame: BridgeAudioFrame, };

export type BridgeWriteFrameAck = { requestId: string, frameId: string, acceptedAt: string, queueDepth: number, };

export type BridgeShutdownRequest = { requestId: string, sessionId: string, reason: 'session-ended' | 'installer-rollback' | 'manual-stop', };

export type DriverBridgeErrorEvent = { requestId?: string, code: 'driver.not-installed' | 'driver.version-mismatch' | 'driver.write-failed' | 'driver.testsigning-disabled' | 'driver.secure-boot-enabled' | 'driver.memory-integrity-enabled' | 'driver.reboot-required' | 'driver.audio-probe-failed' | 'driver.duplicate-root-devices' | 'driver.endpoint-missing' | 'driver.ioctl-unavailable' | 'driver.abi-mismatch' | 'driver.elevation-cancelled' | 'driver.probe-failed' | 'driver.operation-failed' | 'bridge.not-ready' | 'bridge.queue-overflow' | 'bridge.permission-denied' | 'bridge.timeout' | 'bridge.session-mismatch' | 'bridge.singleton-already-running' | 'monitor.virtual-playback-loop' | 'installer.rollback-triggered', message: string, retriable: boolean, bridgeState: 'stopped' | 'starting' | 'running' | 'degraded', driverHealth: 'not-installed' | 'damaged' | 'version-mismatch' | 'running', suggestedAction?: 'reinstall-driver' | 'restart-bridge' | 'rollback-driver' | 'open-diagnostics', };

