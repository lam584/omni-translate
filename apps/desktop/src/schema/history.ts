export const HISTORY_CHANGED_EVENT = 'history://changed' as const;
export const HISTORY_PLAYBACK_EVENT = 'history://playback' as const;

export type {
  HistoryAudioTrack,
  HistoryChangedEventV2,
  HistoryPlaybackEventV2,
  HistoryPlaybackStartV2,
  HistoryPlaybackStopV2,
} from './generated/history';

export type HistorySessionSummary = {
  id: string;
  startedAtMs: number;
  endedAtMs: number | null;
  status: string;
  cueCount: number;
  audioBytes: number;
};

export type HistorySessionPage = {
  items: HistorySessionSummary[];
  nextCursor: string | null;
};

export type HistoryCue = {
  id: string;
  cueId: string;
  sequence: number;
  revision: number;
  routeDirection: string;
  sourceText: string;
  translatedText: string;
  sourceCommitted: boolean;
  translationCommitted: boolean;
  startedAtMs: number;
  endedAtMs: number;
};

export type HistoryCuePage = { items: HistoryCue[]; nextCursor: string | null };
export type HistorySessionDetail = { session: HistorySessionSummary };
export type HistoryStatistics = { sessionCount: number; cueCount: number; audioBytes: number };
