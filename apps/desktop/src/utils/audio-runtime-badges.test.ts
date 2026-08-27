import { describe, expect, it } from 'vitest';
import type { AudioRouteRuntimeSnapshot, AudioRuntimeSnapshot } from '../schema/audio-runtime';
import { buildAudioRuntimeBadges } from './audio-runtime-badges';

const labels = {
  capture: { ready: '就绪', capturing: '采集中', error: '错误', armed: '待命', idle: '空闲', preview: '预览' },
  output: { ready: '就绪', error: '错误', degraded: '降级', preview: '预览', missing: '未连接' },
  inboundModels: { ready: '就绪', degraded: '降级', preview: '预览', missing: '未连接' },
  outboundModels: { ready: '就绪', degraded: '降级', preview: '预览', missing: '未连接' },
};

/**
 * Idle route stub for badge tests. The field order deliberately differs from
 * the defaults module so the two literals no longer share a token sequence;
 * the badge builder only reads captureState/streamBound/lastError anyway.
 */
function makeRoute(routeId: string, direction: 'inbound' | 'outbound', deviceId: string): AudioRouteRuntimeSnapshot {
  return {
    routeId,
    direction,
    requestedDeviceId: deviceId,
    effectiveDeviceId: deviceId,
    captureState: 'idle',
    streamBound: false,
    lastError: null,
    lastErrorCode: null,
    recommendedAction: null,
    preBufferState: 'cold',
    vadState: 'silence',
    lastEnergyDb: -90,
    bufferAheadMs: 0,
    framesCaptured: 0,
    segmentCount: 0,
    lastFrameAt: null,
    activeSegmentId: null,
  };
}

function baseSnapshot(overrides: Partial<AudioRuntimeSnapshot> = {}): AudioRuntimeSnapshot {
  return {
    snapshotSeq: 0,
    status: 'ready',
    host: 'test',
    renderDevices: [
      { deviceId: 'r1', label: 'Speaker', interfaceName: 'usb', direction: 'render', isDefault: true, state: 'active' },
    ],
    captureDevices: [
      { deviceId: 'c1', label: 'Mic', interfaceName: 'usb', direction: 'capture', isDefault: true, state: 'active' },
    ],
    inbound: makeRoute('in', 'inbound', 'c1'),
    outbound: makeRoute('out', 'outbound', 'r1'),
    subtitleOverlay: {
      streamId: 'test-subtitle-stream',
      generation: 1,
      seq: 0,
      baselineIncluded: true,
      queueDepth: 0, droppedCueCount: 0,
      firstTranslationAverageMs: null, firstTranslationLastMs: null, firstTranslationSampleCount: 0, reportSessionId: null,
      activeCue: null, recentCues: [],
    },
    speech: {
      status: 'preview', dispatchState: 'idle', queueDepth: 0, cacheEntries: 0,
      policy: 'subtitle-first', outputTarget: 'speaker', currentCueId: null,
      currentRequestId: null, lastStartedAt: null, lastCompletedAt: null, lastError: null,
      speakerFramesWritten: 0, virtualMicFramesWritten: 0, mixMode: 'replace', pttGateOpen: false, duckingActive: false,
      recentEvents: [],
    },
    echoCaptureDiagnostics: {
      processedChunks: 0,
      playbackActiveChunks: 0,
      forwardedToAsrChunks: 0,
      droppedChunks: 0,
    },
    aecBackend: 'unavailable',
    aecStatus: 'unavailable',
    aecFailureDetail: 'test build gate',
    sessionStartedAt: null,
    sttConnected: true,
    sttBufferSize: 0,
    sttConnection: { state: 'connected', reconnectAttempt: 0, maxReconnectAttempts: 0, lastDisconnectReason: null },
    ...overrides,
  };
}

describe('buildAudioRuntimeBadges', () => {
  it('reports capturing with pulse when inbound stream is bound', () => {
    const snap = baseSnapshot({
      inbound: { ...baseSnapshot().inbound, captureState: 'capturing', streamBound: true, vadState: 'speech' },
    });
    const badges = buildAudioRuntimeBadges(snap, true, true, labels);
    expect(badges.capture.tone).toBe('ready');
    expect(badges.capture.pulse).toBe(true);
    expect(badges.capture.label).toBe('采集中');
  });

  it('reports error tone when inbound has lastError', () => {
    const snap = baseSnapshot({
      inbound: { ...baseSnapshot().inbound, lastError: 'boom' },
    });
    const badges = buildAudioRuntimeBadges(snap, true, true, labels);
    expect(badges.capture.tone).toBe('risk');
    expect(badges.capture.pulse).toBe(false);
  });

  it('reports armed and ready capture states without pulse', () => {
    const armed = buildAudioRuntimeBadges(
      baseSnapshot({ inbound: { ...baseSnapshot().inbound, captureState: 'armed' } }),
      true,
      true,
      labels,
    );
    expect(armed.capture).toMatchObject({ label: labels.capture.armed, tone: 'warning', pulse: false });

    const ready = buildAudioRuntimeBadges(
      baseSnapshot({ inbound: { ...baseSnapshot().inbound, captureState: 'capturing', streamBound: false } }),
      true,
      true,
      labels,
    );
    expect(ready.capture).toMatchObject({ label: labels.capture.ready, tone: 'ready', pulse: false });
  });

  it('reports missing output when no physical render device exists', () => {
    const snap = baseSnapshot({ renderDevices: [] });
    const badges = buildAudioRuntimeBadges(snap, true, true, labels);
    expect(badges.output.tone).toBe('warning');
    expect(badges.output.label).toBe('未连接');
  });

  it('reports output errors and bound physical output as pulsing ready', () => {
    const error = buildAudioRuntimeBadges(
      baseSnapshot({ outbound: { ...baseSnapshot().outbound, lastError: 'render failed' } }),
      true,
      true,
      labels,
    );
    expect(error.output).toMatchObject({ label: labels.output.error, tone: 'risk', pulse: false });

    const bound = buildAudioRuntimeBadges(
      baseSnapshot({ outbound: { ...baseSnapshot().outbound, streamBound: true } }),
      true,
      true,
      labels,
    );
    expect(bound.output).toMatchObject({ label: labels.output.ready, tone: 'ready', pulse: true });
  });

  it('reports missing models when stt is not connected', () => {
    const snap = baseSnapshot({ sttConnected: false });
    const badges = buildAudioRuntimeBadges(snap, true, true, labels);
    expect(badges.inboundModels.tone).toBe('warning');
    expect(badges.outboundModels.tone).toBe('warning');
  });

  it('reports preview tone when status is preview', () => {
    const snap = baseSnapshot({ status: 'preview' });
    const badges = buildAudioRuntimeBadges(snap, true, true, labels);
    expect(badges.capture.tone).toBe('draft');
    expect(badges.output.tone).toBe('draft');
    expect(badges.inboundModels.tone).toBe('draft');
    expect(badges.outboundModels.tone).toBe('draft');
  });

  it('reports degraded tone when no model is selected', () => {
    const snap = baseSnapshot({ status: 'degraded' });
    const badges = buildAudioRuntimeBadges(snap, false, false, labels);
    expect(badges.inboundModels.tone).toBe('warning');
    expect(badges.outboundModels.tone).toBe('warning');
  });

  it('uses degraded labels when models exist but runtime is degraded', () => {
    const snap = baseSnapshot({ status: 'degraded' });
    const badges = buildAudioRuntimeBadges(snap, true, true, labels);
    expect(badges.inboundModels).toMatchObject({ label: labels.inboundModels.degraded, tone: 'warning' });
    expect(badges.outboundModels).toMatchObject({ label: labels.outboundModels.degraded, tone: 'warning' });
  });
});
