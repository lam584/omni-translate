import type { TtsDispatchEvent, TtsRequestContract } from '../schema/tts-contract';
import type { TranslationRuntimeSnapshot } from '../schema/translation-runtime';

export const translationRuntimeSnapshotMock: TranslationRuntimeSnapshot = {
  policy: 'subtitle-first',
  activeTrigger: 'latency-high',
  subtitleReadyAheadMs: 640,
  subtitleLane: {
    id: 'subtitle',
    label: '字幕链路',
    state: 'ready',
    outputTarget: 'overlay-caption',
    note: '高延迟时优先交付字幕，不等待译音播报完成。',
  },
  speechLane: {
    id: 'speech',
    label: '译音链路',
    state: 'deferred',
    outputTarget: 'speaker / virtual-mic',
    note: '当前延迟超预算，译音暂缓，等待字幕完成后再排队。',
  },
  rules: [
    {
      id: 'runtime-rule-latency-high',
      trigger: 'latency-high',
      condition: '当实测延迟高于 1200 ms 时触发。',
      behavior: '字幕立即输出，译音状态切到 deferred。',
    },
    {
      id: 'runtime-rule-probe-risk',
      trigger: 'probe-risk',
      condition: '当模型服务探测结论为不推荐实时时触发。',
      behavior: '默认关闭译音叠加，只保留字幕和可选排队播报。',
    },
    {
      id: 'runtime-rule-normal',
      trigger: 'normal',
      condition: '当探测可用且延迟低于预算时触发。',
      behavior: '字幕和译音都可进入持续链路，但字幕仍先提交。',
    },
  ],
  timeline: [
    {
      id: 'runtime-event-subtitle-delta',
      type: 'subtitle.delta',
      summary: '收到增量翻译文本，字幕缓冲区持续刷新。',
    },
    {
      id: 'runtime-event-subtitle-ready',
      type: 'subtitle.ready',
      summary: '字幕片段已输出，等待译音链路补齐。',
    },
    {
      id: 'runtime-event-speech-deferred',
      type: 'speech.deferred',
      summary: '当前会话命中高延迟规则，译音暂缓。',
    },
    {
      id: 'runtime-event-speech-queued',
      type: 'speech.queued',
      summary: '字幕确认后，译音请求进入播放队列。',
    },
  ],
};

export const ttsRequestContractMock: TtsRequestContract = {
  requestId: 'tts-request-001',
  sessionId: 'session-realtime-watch-001',
  sourceSegmentId: 'segment-042',
  sourceText: 'Incoming speech translated to Chinese subtitle first.',
  targetLanguage: 'zh-CN',
  voicePresetId: 'voice-cn-neutral',
  outputTarget: 'speaker',
  localPlaybackEnabled: true,
  virtualMicOutputEnabled: false,
  waitForSubtitleReady: true,
  subtitlePriorityMode: 'subtitle-first',
};

export const ttsDispatchEventsMock: TtsDispatchEvent[] = [
  {
    type: 'tts.requested',
    requestId: 'tts-request-001',
    summary: '字幕片段完成后生成 TTS 请求，占位链路已串联。',
  },
  {
    type: 'tts.deferred',
    requestId: 'tts-request-001',
    summary: '当前会话命中字幕优先规则，先等待字幕提交。',
  },
  {
    type: 'tts.playback.started',
    requestId: 'tts-request-001',
    summary: '当延迟回落后，译音可转入本地播放或虚拟麦克风输出。',
  },
];