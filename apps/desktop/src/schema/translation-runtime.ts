export type RuntimePolicyMode = 'subtitle-first' | 'balanced';

export type OrchestrationTrigger = 'normal' | 'latency-high' | 'probe-risk';

export type RuntimeLaneState = 'waiting-input' | 'streaming' | 'ready' | 'deferred' | 'queued' | 'playing';

export type RuntimeLane = {
  id: 'subtitle' | 'speech';
  label: string;
  state: RuntimeLaneState;
  outputTarget: string;
  note: string;
};

export type SubtitlePriorityRule = {
  id: string;
  trigger: OrchestrationTrigger;
  condition: string;
  behavior: string;
};

export type RuntimeTimelineEvent = {
  id: string;
  type: 'subtitle.delta' | 'subtitle.ready' | 'speech.deferred' | 'speech.queued' | 'speech.playing';
  summary: string;
};

export type TranslationRuntimeSnapshot = {
  policy: RuntimePolicyMode;
  activeTrigger: OrchestrationTrigger;
  subtitleReadyAheadMs: number;
  subtitleLane: RuntimeLane;
  speechLane: RuntimeLane;
  rules: SubtitlePriorityRule[];
  timeline: RuntimeTimelineEvent[];
};