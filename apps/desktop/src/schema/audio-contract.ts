export type AudioInputSourceKind = 'system-output' | 'microphone';

export type AudioOutputTargetKind = 'speaker' | 'virtual-mic' | 'subtitle-engine' | 'monitor';

export type AudioCaptureState = 'idle' | 'armed' | 'capturing' | 'buffering' | 'muted' | 'stopping';

export type AudioPreBufferState = 'cold' | 'primed' | 'ready' | 'draining';

export type AudioFrameEncoding = 'pcm16le';

export type AudioChannelLayout = 'mono' | 'stereo';

export type AudioRouteDirection = 'inbound' | 'outbound';

export type AudioMonitorMode = 'translated-only' | 'original-and-translated';

export type PushToTalkState = 'idle' | 'armed' | 'recording';

export type AudioInputProcessingContract = {
  inputLevel: number;
  echoCancellationEnabled: boolean;
  noiseSuppressionEnabled: boolean;
  autoGainControlEnabled: boolean;
};

export type AudioInputSourceContract = {
  sourceId: string;
  kind: AudioInputSourceKind;
  deviceId: string;
  state: AudioCaptureState;
  muted: boolean;
  bufferAheadMs: number;
  preBufferState: AudioPreBufferState;
  processing: AudioInputProcessingContract;
};

export type AudioOutputTargetContract = {
  targetId: string;
  kind: AudioOutputTargetKind;
  deviceId?: string;
  enabled: boolean;
};

export type AudioFrameContract = {
  frameId: string;
  routeDirection: AudioRouteDirection;
  encoding: AudioFrameEncoding;
  channelLayout: AudioChannelLayout;
  sampleRateHz: 16000 | 24000 | 48000;
  channelCount: 1 | 2;
  frameCount: number;
  timestampMs: number;
  payloadRef: string;
};

export type AudioSegmentContract = {
  segmentId: string;
  routeDirection: AudioRouteDirection;
  startedAtMs: number;
  endedAtMs: number;
  sourceLanguage: string;
  targetLanguage?: string;
  sourceFrameIds: string[];
};

export type AudioMixControlContract = {
  keepOriginalAudio: boolean;
  translatedAudioEnabled: boolean;
  translatedAudioGainDb: number;
  originalAudioGainDb: number;
  duckingEnabled: boolean;
  duckingDepthPercent: number;
  monitorMode: AudioMonitorMode;
};

export type AudioLatencyControlContract = {
  captureBufferMs: number;
  translationBufferMs: number;
  playbackBufferMs: number;
  compensationMs: number;
};

export type PushToTalkContract = {
  enabled: boolean;
  hotkey: string;
  state: PushToTalkState;
  releaseDelayMs: number;
};

export type AudioRouteContract = {
  routeId: string;
  direction: AudioRouteDirection;
  input: AudioInputSourceContract;
  outputs: AudioOutputTargetContract[];
  mixControl: AudioMixControlContract;
  latencyControl: AudioLatencyControlContract;
  pushToTalk?: PushToTalkContract;
};
