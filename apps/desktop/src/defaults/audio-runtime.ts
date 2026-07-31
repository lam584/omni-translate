import { appConfigDraftMock } from './app-config';
import type { AudioRuntimeSnapshot } from '../schema/audio-runtime';

// Preview cue used both as the active cue and the seed of `recentCues`; the
// factory keeps the two snapshot entries as independent object instances.
function makeBrowserPreviewCue(): NonNullable<AudioRuntimeSnapshot['subtitleOverlay']['activeCue']> {
  return {
    cueId: 'browser-preview-cue-1',
    routeDirection: 'inbound',
    sourceText: '浏览器预览模式',
    translatedText: '这里会显示真实歌词字幕',
    displaySegments: [
      {
        sourceText: '浏览器预览模式',
        translatedText: '这里会显示真实歌词字幕',
        pending: false,
      },
    ],
    startedAt: 'browser-preview',
    endedAt: 'browser-preview',
    committed: true,
  };
}

export const audioRuntimeSnapshotMock: AudioRuntimeSnapshot = {
  status: 'preview',
  host: 'wasapi',
  sessionStartedAt: null,
  sttConnected: false,
  sttBufferSize: 0,
  sttConnection: {
    state: 'idle',
    reconnectAttempt: 0,
    maxReconnectAttempts: 0,
    lastDisconnectReason: null,
  },
  renderDevices: [
    {
      deviceId: appConfigDraftMock.devices.inboundRoute.input.deviceId,
      label: '扬声器（浏览器预览）',
      interfaceName: '浏览器预览输出',
      direction: 'render',
      isDefault: true,
      state: 'Active',
    },
  ],
  captureDevices: [
    {
      deviceId: appConfigDraftMock.devices.outboundRoute.input.deviceId,
      label: '麦克风（浏览器预览）',
      interfaceName: '浏览器预览输入',
      direction: 'capture',
      isDefault: true,
      state: 'Active',
    },
  ],
  inbound: {
    routeId: appConfigDraftMock.devices.inboundRoute.routeId,
    direction: 'inbound',
    requestedDeviceId: appConfigDraftMock.devices.inboundRoute.input.deviceId,
    effectiveDeviceId: appConfigDraftMock.devices.inboundRoute.input.deviceId,
    captureState: 'buffering',
    preBufferState: 'primed',
    vadState: 'silence',
    bufferAheadMs: 120,
    framesCaptured: 0,
    segmentCount: 1,
    streamBound: false,
    lastEnergyDb: -54,
    lastFrameAt: 'browser-preview',
    activeSegmentId: null,
    lastError: null,
    lastErrorCode: null,
    recommendedAction: null,
  },
  outbound: {
    routeId: appConfigDraftMock.devices.outboundRoute.routeId,
    direction: 'outbound',
    requestedDeviceId: appConfigDraftMock.devices.outboundRoute.input.deviceId,
    effectiveDeviceId: appConfigDraftMock.devices.outboundRoute.input.deviceId,
    captureState: 'armed',
    preBufferState: 'cold',
    vadState: 'silence',
    bufferAheadMs: 0,
    framesCaptured: 0,
    segmentCount: 0,
    streamBound: false,
    lastEnergyDb: -90,
    lastFrameAt: null,
    activeSegmentId: null,
    lastError: null,
    lastErrorCode: null,
    recommendedAction: null,
  },
  subtitleOverlay: {
    queueDepth: 1,
    droppedCueCount: 0,
    firstTranslationAverageMs: null,
    firstTranslationLastMs: null,
    firstTranslationSampleCount: 0,
    reportSessionId: null,
    activeCue: makeBrowserPreviewCue(),
    recentCues: [makeBrowserPreviewCue()],
  },
  speech: {
    status: 'preview',
    dispatchState: 'waiting-subtitle',
    queueDepth: 1,
    cacheEntries: 1,
    policy: 'subtitle-first',
    outputTarget: appConfigDraftMock.speech.outputTarget,
    currentCueId: 'browser-preview-cue-1',
    currentRequestId: 'browser-preview-tts-1',
    lastStartedAt: 'browser-preview',
    lastCompletedAt: 'browser-preview',
    lastError: null,
    speakerFramesWritten: 2400,
    virtualMicFramesWritten: 0,
    mixMode: 'translated-plus-prompt',
    pttGateOpen: true,
    duckingActive: false,
    recentEvents: [
      {
        eventId: 'browser-preview-tts-requested',
        // Preview events must use the pinned native vocabulary
        // (schema/speech-event-kinds.ts); `speech.tts-requested` never
        // existed on the Rust side.
        kind: 'speech.realtime-audio-requested',
        summary: '浏览器预览模式会显示播报事件流，但不会连接真实模型服务。',
        emittedAt: 'browser-preview',
        cueId: 'browser-preview-cue-1',
        requestId: 'browser-preview-tts-1',
      },
      {
        eventId: 'browser-preview-tts-completed',
        kind: 'speech.completed',
        summary: '预览模式已模拟一次扬声器播报完成。',
        emittedAt: 'browser-preview',
        cueId: 'browser-preview-cue-1',
        requestId: 'browser-preview-tts-1',
      },
    ],
  },
};
