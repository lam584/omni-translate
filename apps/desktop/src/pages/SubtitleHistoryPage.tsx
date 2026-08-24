import { listen } from '@tauri-apps/api/event';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import AppIcon from '../components/icons/AppIcon';
import { useDesktopApiV2 } from '../runtime/desktop-api-context';
import {
  HISTORY_CHANGED_EVENT,
  HISTORY_PLAYBACK_EVENT,
  type HistoryAudioTrack,
  type HistoryChangedEventV2,
  type HistoryCue,
  type HistoryPlaybackEventV2,
  type HistorySessionSummary,
  type HistoryStatistics,
} from '../schema/history';
import { useAppStore } from '../stores/app-store';

const EMPTY_STATS: HistoryStatistics = { sessionCount: 0, cueCount: 0, audioBytes: 0 };

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function appendUnique<T extends { id: string }>(current: T[], incoming: T[]) {
  const known = new Set(current.map((item) => item.id));
  return [...current, ...incoming.filter((item) => !known.has(item.id))];
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  return `${(value / 1024 ** 3).toFixed(2)} GiB`;
}

function formatTime(value: number | null, locale: string) {
  if (value === null) return '—';
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

export default function SubtitleHistoryPage() {
  const { t, i18n } = useTranslation();
  const desktopApi = useDesktopApiV2();
  const audio = useAppStore((state) => state.audioRuntimeSnapshot);
  const routeActive = audio.inbound.streamBound || audio.outbound.streamBound;
  const [sessions, setSessions] = useState<HistorySessionSummary[]>([]);
  const [sessionCursor, setSessionCursor] = useState<string | null>(null);
  const [selectedSession, setSelectedSession] = useState<HistorySessionSummary | null>(null);
  const [cues, setCues] = useState<HistoryCue[]>([]);
  const [cueCursor, setCueCursor] = useState<string | null>(null);
  const [stats, setStats] = useState<HistoryStatistics>(EMPTY_STATS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playbackKey, setPlaybackKey] = useState<string | null>(null);

  const locale = i18n.resolvedLanguage ?? i18n.language ?? 'en';
  const selectedSessionId = selectedSession?.id ?? null;

  const loadSessions = useCallback(async (cursor?: string, append = false) => {
    if (!desktopApi.capabilities.hasNativeShell) {
      setSessions([]);
      setSessionCursor(null);
      setStats(EMPTY_STATS);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [page, nextStats] = await Promise.all([
        desktopApi.history.listSessions(cursor, 25),
        desktopApi.history.getStats(),
      ]);
      setSessions((current) => append ? appendUnique(current, page.items) : page.items);
      setSessionCursor(page.nextCursor);
      setStats(nextStats);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setLoading(false);
    }
  }, [desktopApi]);

  const loadCues = useCallback(async (sessionId: string, cursor?: string, append = false) => {
    setLoading(true);
    setError(null);
    try {
      const page = await desktopApi.history.listCues(sessionId, cursor, 50);
      setCues((current) => append ? appendUnique(current, page.items) : page.items);
      setCueCursor(page.nextCursor);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setLoading(false);
    }
  }, [desktopApi]);

  useEffect(() => {
    queueMicrotask(() => void loadSessions());
  }, [loadSessions]);

  useEffect(() => {
    if (!desktopApi.capabilities.hasNativeShell) return undefined;
    let disposed = false;
    const unlisten: Array<() => void> = [];
    void Promise.all([
      listen<HistoryChangedEventV2>(HISTORY_CHANGED_EVENT, () => {
        void loadSessions();
        if (selectedSessionId) void loadCues(selectedSessionId);
      }),
      listen<HistoryPlaybackEventV2>(HISTORY_PLAYBACK_EVENT, (event) => {
        if (event.payload.status === 'started') {
          setPlaybackKey(`${event.payload.cueId}:${event.payload.track}`);
        } else {
          setPlaybackKey(null);
          if (event.payload.status === 'failed') setError(event.payload.error ?? event.payload.reason);
        }
      }),
    ]).then((listeners) => {
      if (disposed) listeners.forEach((stop) => stop());
      else unlisten.push(...listeners);
    }).catch((caught) => setError(describeError(caught)));
    return () => {
      disposed = true;
      unlisten.forEach((stop) => stop());
    };
  }, [desktopApi, loadCues, loadSessions, selectedSessionId]);

  const openSession = useCallback((session: HistorySessionSummary) => {
    setSelectedSession(session);
    setCues([]);
    setCueCursor(null);
    void loadCues(session.id);
  }, [loadCues]);

  const deleteSession = useCallback(async (session: HistorySessionSummary) => {
    if (!window.confirm(t('history.deleteConfirm'))) return;
    try {
      const result = await desktopApi.history.deleteSession(session.id);
      if (result.deleted) {
        setSessions((current) => current.filter((item) => item.id !== session.id));
        if (selectedSessionId === session.id) {
          setSelectedSession(null);
          setCues([]);
          setCueCursor(null);
        }
        setStats(await desktopApi.history.getStats());
      }
    } catch (caught) {
      setError(describeError(caught));
    }
  }, [desktopApi, selectedSessionId, t]);

  const clearHistory = useCallback(async () => {
    if (!window.confirm(t('history.clearConfirm'))) return;
    try {
      await desktopApi.history.clear();
      setSelectedSession(null);
      setCues([]);
      setCueCursor(null);
      await loadSessions();
    } catch (caught) {
      setError(describeError(caught));
    }
  }, [desktopApi, loadSessions, t]);

  const play = useCallback(async (cue: HistoryCue, track: HistoryAudioTrack) => {
    if (!selectedSessionId || routeActive) return;
    const key = `${cue.cueId}:${track}`;
    try {
      if (playbackKey === key) {
        await desktopApi.history.stopPlayback();
        setPlaybackKey(null);
        return;
      }
      await desktopApi.history.playCueAudio(selectedSessionId, cue.cueId, track);
      setPlaybackKey(key);
    } catch (caught) {
      setError(describeError(caught));
    }
  }, [desktopApi, playbackKey, routeActive, selectedSessionId]);

  const summary = useMemo(() => [
    { label: t('history.sessions'), value: stats.sessionCount.toLocaleString(locale) },
    { label: t('history.cues'), value: stats.cueCount.toLocaleString(locale) },
    { label: t('history.storage'), value: formatBytes(stats.audioBytes) },
  ], [locale, stats, t]);

  return (
    <main className="subtitle-history-page control-workspace">
      <section className="content-card subtitle-history-summary">
        <div>
          <span className="diagnostics-kicker">{t('history.kicker')}</span>
          <h2>{t('history.title')}</h2>
          <p>{t('history.description')}</p>
        </div>
        <div className="subtitle-history-stats">
          {summary.map((item) => <div key={item.label}><strong>{item.value}</strong><span>{item.label}</span></div>)}
        </div>
        <div className="subtitle-history-actions">
          <button className="icon-button" disabled={loading} onClick={() => void loadSessions()} type="button">
            <AppIcon name="refresh" size={14} /> {t('history.refresh')}
          </button>
          <button className="icon-button" disabled={loading || sessions.every((session) => session.endedAtMs === null)} onClick={() => void clearHistory()} type="button">
            <AppIcon name="trash" size={14} /> {t('history.clear')}
          </button>
        </div>
      </section>

      {routeActive ? <p className="subtitle-history-route-warning" role="status">{t('history.routeActive')}</p> : null}
      {error ? <p className="subtitle-history-error" role="alert">{error}</p> : null}
      {!desktopApi.capabilities.hasNativeShell ? <p className="subtitle-history-empty">{t('history.nativeOnly')}</p> : null}

      <div className="subtitle-history-grid">
        <section className="content-card subtitle-history-sessions" aria-label={t('history.sessionList')}>
          {sessions.length === 0 ? <p className="subtitle-history-empty">{loading ? t('common.loading') : t('history.empty')}</p> : (
            <div className="subtitle-history-session-list">
              {sessions.map((session) => (
                <article className={selectedSessionId === session.id ? 'subtitle-history-session active' : 'subtitle-history-session'} key={session.id}>
                  <button className="subtitle-history-session-open" onClick={() => openSession(session)} type="button">
                    <strong>{formatTime(session.endedAtMs ?? session.startedAtMs, locale)}</strong>
                    <span>{t('history.sessionMeta', { cues: session.cueCount, size: formatBytes(session.audioBytes) })}</span>
                    <small>{session.endedAtMs === null ? t('history.active') : session.status}</small>
                  </button>
                  <button aria-label={t('history.delete')} className="icon-button" disabled={session.endedAtMs === null} onClick={() => void deleteSession(session)} type="button">
                    <AppIcon name="trash" size={14} />
                  </button>
                </article>
              ))}
            </div>
          )}
          {sessionCursor ? <button className="subtitle-history-more" disabled={loading} onClick={() => void loadSessions(sessionCursor, true)} type="button">{t('history.loadMoreSessions')}</button> : null}
        </section>

        <section className="content-card subtitle-history-cues" aria-label={t('history.cueList')}>
          {!selectedSession ? <p className="subtitle-history-empty">{t('history.selectSession')}</p> : null}
          {selectedSession && cues.length === 0 ? <p className="subtitle-history-empty">{loading ? t('common.loading') : t('history.noCues')}</p> : null}
          {cues.map((cue) => (
            <article className="subtitle-history-cue" key={cue.id}>
              <header><span>#{cue.sequence}</span><time>{formatTime(cue.startedAtMs, locale)}</time></header>
              <p className="subtitle-history-source">{cue.sourceText}</p>
              <p className="subtitle-history-translation">{cue.translatedText || t('history.translationUnavailable')}</p>
              <div className="subtitle-history-playback-actions">
                <button disabled={routeActive || !cue.sourceAudioAvailable} onClick={() => void play(cue, 'source')} type="button">
                  <AppIcon name={playbackKey === `${cue.cueId}:source` ? 'stop' : 'play'} size={13} /> {t('history.playSource')}
                </button>
                <button disabled={routeActive || !cue.translatedAudioAvailable} onClick={() => void play(cue, 'translated')} type="button">
                  <AppIcon name={playbackKey === `${cue.cueId}:translated` ? 'stop' : 'play'} size={13} /> {t('history.playTranslated')}
                </button>
              </div>
            </article>
          ))}
          {cueCursor && selectedSession ? <button className="subtitle-history-more" disabled={loading} onClick={() => void loadCues(selectedSession.id, cueCursor, true)} type="button">{t('history.loadMoreCues')}</button> : null}
        </section>
      </div>
    </main>
  );
}
