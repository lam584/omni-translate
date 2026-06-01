import type { RuntimePolicyMode } from './translation-runtime';

export type TtsOutputTarget = 'speaker' | 'virtual-mic' | 'both';

export type TtsDispatchState = 'idle' | 'waiting-subtitle' | 'queued' | 'playing';

export type TtsRequestContract = {
  requestId: string;
  sessionId: string;
  sourceSegmentId: string;
  sourceText: string;
  targetLanguage: string;
  voicePresetId: string;
  outputTarget: TtsOutputTarget;
  localPlaybackEnabled: boolean;
  virtualMicOutputEnabled: boolean;
  waitForSubtitleReady: boolean;
  subtitlePriorityMode: RuntimePolicyMode;
};

export type TtsDispatchEvent = {
  type: 'tts.requested' | 'tts.deferred' | 'tts.playback.started' | 'tts.playback.completed';
  requestId: string;
  summary: string;
};