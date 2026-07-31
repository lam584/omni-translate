import { activeDesktopApi } from './desktop-api';
import type { WatchSessionReportRuntime } from '../schema/audio-runtime';

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
  const report = await activeDesktopApi().diagnostics.watchSessionReport<WatchSessionReportRuntime | null>();
  if (!report) return structuredClone(EMPTY_LIVE_SESSION_EVENTS);
  const parsed: Partial<LiveSessionEvents> = {
    sessionStartedAt: report.startedAt,
    elapsedMs: report.elapsedMs,
    model: report.model,
    asrDeltas: report.cues.flatMap((cue) => cue.events
      .filter((event) => event.stage === 'source')
      .map((event) => ({
        elapsedMs: event.elapsedMs,
        stash: event.finalEvent ? '' : event.text,
        text: event.finalEvent ? event.text : '',
        eventType: event.kind,
      }))),
    outputDeltas: report.cues.flatMap((cue) => cue.events
      .filter((event) => event.stage === 'model')
      .map((event) => ({
        elapsedMs: event.elapsedMs,
        eventType: event.kind,
        stash: event.finalEvent ? '' : event.text,
        committedText: event.finalEvent ? event.text : '',
      }))),
    asrFinal: report.cues.at(-1)?.sourceText ?? '',
    translationFinal: report.cues.at(-1)?.llmText ?? '',
  };
  return {
    ...EMPTY_LIVE_SESSION_EVENTS,
    ...parsed,
    pipelineMilestones: {
      ...EMPTY_PIPELINE_MILESTONES,
      ...parsed.pipelineMilestones,
    },
  };
}
