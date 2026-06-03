import { describe, expect, it } from 'vitest';
import type { AudioRuntimeSnapshot } from '../schema/audio-runtime';
import { buildAudioRuntimeBadges } from './audio-runtime-badges';

const labels = {
  capture: { ready: '就绪', capturing: '采集中', error: '错误', armed: '待命', idle: '空闲', preview: '预览' },
  output: { ready: '就绪', error: '错误', degraded: '降级', preview: '预览', missing: '未连接' },
  inboundModels: { ready: '就绪', degraded: '降级', preview: '预览', missing: '未连接' },
  outboundModels: { ready: '就绪', degraded: '降级', preview: '预览', missing: '未连接' },
};

function baseSnapshot(overrides: Partial<AudioRuntimeSnapshot> = {}): AudioRuntimeSnapshot {
  return {
    status: 'ready',
    host: 'test',
    renderDevices: [
      { deviceId: 'r1', label: 'Speaker', interfaceName: 'usb', direction: 'render', isDefault: true, state: 'active' },
    ],
    captureDevices: [
      { deviceId: 'c1', label: 'Mic', interfaceName: 'usb', direction: 'capture', isDefault: true, state: 'active' },
    ],
    inbound: {
      routeId: 'in', direction: 'inbound', requestedDeviceId: 'c1', effectiveDeviceId: 'c1',
      captureState: 'idle', preBufferState: 'cold', vadState: 'silence',
      bufferAheadMs: 0, framesCaptured: 0, segmentCount: 0, streamBound: false,
      lastEnergyDb: -90, lastFrameAt: null, activeSegmentId: null,
      lastError: null, recommendedAction: null,
    },
    outbound: {
      routeId: 'out', direction: 'outbound', requestedDeviceId: 'r1', effectiveDeviceId: 'r1',
      captureState: 'idle', preBufferState: 'cold', vadState: 'silence',
      bufferAheadMs: 0, framesCaptured: 0, segmentCount: 0, streamBound: false,
      lastEnergyDb: -90, lastFrameAt: null, activeSegmentId: null,
      lastError: null, recommendedAction: null,
    },
    subtitleOverlay: {
      queueDepth: 0, droppedCueCount: 0,
      firstTranslationAverageMs: null, firstTranslationLastMs: null, firstTranslationSampleCount: 0,
      activeCue: null, recentCues: [],
    },
    speech: {
      status: 'preview', dispatchState: 'idle', queueDepth: 0, cacheEntries: 0,
      policy: 'subtitle-first', outputTarget: 'speaker', currentCueId: null,
      currentRequestId: null, lastStartedAt: null, lastCompletedAt: null, lastError: null,
      speakerFramesWritten: 0, virtualMicFramesWritten: 0, mixMode: 'replace', pttGateOpen: false, duckingActive: false,
      recentEvents: [],
    },
    sessionStartedAt: null,
    sttConnected: true,
    sttBufferSize: 0,
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

  it('reports missing output when no physical render device exists', () => {
    const snap = baseSnapshot({ renderDevices: [] });
    const badges = buildAudioRuntimeBadges(snap, true, true, labels);
    expect(badges.output.tone).toBe('warning');
    expect(badges.output.label).toBe('未连接');
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
});
