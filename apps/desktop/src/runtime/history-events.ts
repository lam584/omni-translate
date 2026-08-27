import { listen } from '@tauri-apps/api/event';

import {
  HISTORY_CHANGED_EVENT,
  HISTORY_PLAYBACK_EVENT,
  type HistoryChangedEventV2,
  type HistoryPlaybackEventV2,
} from '../schema/history';

export type HistoryEventHandlers = {
  enabled: boolean;
  onChanged: (event: HistoryChangedEventV2) => void;
  onPlayback: (event: HistoryPlaybackEventV2) => void;
};

export async function subscribeHistoryEvents({
  enabled,
  onChanged,
  onPlayback,
}: HistoryEventHandlers): Promise<() => void> {
  if (!enabled) return () => undefined;

  const unlisteners: Array<() => void> = [];
  try {
    unlisteners.push(await listen<HistoryChangedEventV2>(HISTORY_CHANGED_EVENT, (event) => {
      onChanged(event.payload);
    }));
    unlisteners.push(await listen<HistoryPlaybackEventV2>(HISTORY_PLAYBACK_EVENT, (event) => {
      onPlayback(event.payload);
    }));
  } catch (error) {
    unlisteners.forEach((unlisten) => unlisten());
    throw error;
  }

  return () => unlisteners.forEach((unlisten) => unlisten());
}
