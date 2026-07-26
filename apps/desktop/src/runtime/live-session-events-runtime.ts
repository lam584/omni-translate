import { activeDesktopApi } from './desktop-api';

export type LiveSessionAsrDelta = {
  elapsedMs: number;
  stash: string;
  text: string;
  eventType: string;
};

export type LiveSessionOutputDelta = {
  elapsedMs: number;
  eventType: string;
  stash: string;
  committedText: string;
};

export type PipelineMilestones = {
  preconnectStartedMs: number | null;
  sessionReadyMs: number | null;
  routeStartedMs: number | null;
  firstAudioSentMs: number | null;
  firstSpeechStartedMs: number | null;
  queuedAudioChunks: number | null;
  droppedBeforeReady: number | null;
  firstAudibleChunkMs: number | null;
  silenceSkippedBeforeAudible: number | null;
  totalInputChunksAtSpeech: number | null;
};

export type LiveSessionEvents = {
  sessionStartedAt: string;
  elapsedMs: number;
  model: string;
  asrDeltas: LiveSessionAsrDelta[];
  outputDeltas: LiveSessionOutputDelta[];
  asrFinal: string;
  translationFinal: string;
  pipelineMilestones: PipelineMilestones;
};

export const EMPTY_PIPELINE_MILESTONES: PipelineMilestones = {
  preconnectStartedMs: null,
  sessionReadyMs: null,
  routeStartedMs: null,
  firstAudioSentMs: null,
  firstSpeechStartedMs: null,
  queuedAudioChunks: null,
  droppedBeforeReady: null,
  firstAudibleChunkMs: null,
  silenceSkippedBeforeAudible: null,
  totalInputChunksAtSpeech: null,
};

const EMPTY_LIVE_SESSION_EVENTS: LiveSessionEvents = {
  sessionStartedAt: '',
  elapsedMs: 0,
  model: '',
  asrDeltas: [],
  outputDeltas: [],
  asrFinal: '',
  translationFinal: '',
  pipelineMilestones: { ...EMPTY_PIPELINE_MILESTONES },
};

export async function getLiveSessionEventsRuntime(): Promise<LiveSessionEvents> {
  const parsed = await activeDesktopApi().diagnostics.liveSessionEvents<Partial<LiveSessionEvents>>();
  return {
    ...EMPTY_LIVE_SESSION_EVENTS,
    ...parsed,
    pipelineMilestones: {
      ...EMPTY_PIPELINE_MILESTONES,
      ...parsed.pipelineMilestones,
    },
  };
}
