import { beforeEach, describe, expect, it } from 'vitest';

import { audioRuntimeSnapshotMock } from '../mocks/audio-runtime';
import { runtimeSnapshotMock } from '../mocks/runtime-shell';
import type { RuntimeNotification } from '../schema/runtime-core';
import type { SubtitleDeltaRuntime } from '../schema/audio-runtime';
import { applySubtitleDeltaToIndex, appStoreTestHelpers, useAppStore } from './app-store';

const initialState = useAppStore.getState();

function resetStore() {
  useAppStore.setState(initialState, true);
}

function notification(id: string): RuntimeNotification {
  return {
    id,
    level: 'info',
    source: 'test',
    message: id,
    emittedAt: `time-${id}`,
  };
}

function cue(cueId: string) {
  return {
    cueId,
    routeDirection: 'inbound' as const,
    sourceText: `source ${cueId}`,
    translatedText: `translated ${cueId}`,
    startedAt: 'unix:1',
    endedAt: 'unix:2',
    committed: true,
    translationCommitted: true,
  };
}

describe('app store', () => {
  beforeEach(resetStore);

  it('selects known pages and falls back to the first nav item', () => {
    useAppStore.getState().setActivePageByPath('/audio-routing');
    expect(useAppStore.getState().activePageId).toBe('audio-routing');

    useAppStore.getState().setActivePageByPath('/missing');
    expect(useAppStore.getState().activePageId).toBe('session');
  });

  it('resolves empty navigation and preset initialization fallbacks', () => {
    expect(appStoreTestHelpers.resolveInitialPageId([])).toBe('dashboard');
    expect(appStoreTestHelpers.resolveInitialPresetId(undefined, [])).toBe('preset-watch-mode');
    expect(appStoreTestHelpers.resolveInitialPresetId(undefined, [{ id: 'first' }] as never)).toBe('first');
    expect(appStoreTestHelpers.resolveInitialPresetId('active', [])).toBe('active');
    expect(appStoreTestHelpers.resolvePageIdByPath([], '/missing', 'fallback')).toBe('fallback');
  });

  it('keeps the active preset synchronized with onboarding config', () => {
    useAppStore.getState().setActivePresetId('preset-game-voice-mode');

    expect(useAppStore.getState().activePresetId).toBe('preset-game-voice-mode');
    expect(useAppStore.getState().configDraft.onboarding.activePresetId).toBe('preset-game-voice-mode');
  });

  it('records and clears audio session timestamps across routing transitions', () => {
    const started = structuredClone(audioRuntimeSnapshotMock);
    started.inbound.streamBound = true;
    started.sessionStartedAt = null;
    useAppStore.getState().setAudioRuntimeSnapshot(started);
    const startedAt = useAppStore.getState().audioRuntimeSnapshot.sessionStartedAt;
    expect(startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(Number.isNaN(new Date(startedAt!).getTime())).toBe(false);

    const continued = structuredClone(started);
    continued.sessionStartedAt = null;
    useAppStore.getState().setAudioRuntimeSnapshot(continued);
    // A snapshot from the same running session must keep the ORIGINAL
    // timestamp, not mint a new one (the elapsed timer would reset).
    expect(useAppStore.getState().audioRuntimeSnapshot.sessionStartedAt).toBe(startedAt);

    const stopped = structuredClone(audioRuntimeSnapshotMock);
    useAppStore.getState().setAudioRuntimeSnapshot(stopped);
    expect(useAppStore.getState().audioRuntimeSnapshot.sessionStartedAt).toBeNull();

    useAppStore.getState().setAudioRuntimeSnapshot(structuredClone(audioRuntimeSnapshotMock));
    expect(useAppStore.getState().audioRuntimeSnapshot.sessionStartedAt).toBeNull();
  });

  it('records timestamps for outbound-only sessions and preserves explicit start timestamps', () => {
    const outbound = structuredClone(audioRuntimeSnapshotMock);
    outbound.outbound.streamBound = true;
    outbound.sessionStartedAt = 'unix-ms:123';
    useAppStore.getState().setAudioRuntimeSnapshot(outbound);

    expect(useAppStore.getState().audioRuntimeSnapshot.sessionStartedAt).toBe('unix-ms:123');
  });

  it('fills missing provider identity fields when hydrating legacy config drafts', () => {
    const configDraft = structuredClone(useAppStore.getState().configDraft);
    const legacyDraft = {
      ...configDraft,
      providers: undefined,
      activeProviderTemplateId: undefined,
    } as unknown as typeof configDraft;

    const merged = appStoreTestHelpers.mergeConfigDraftWithDefaults(legacyDraft);

    expect(merged.providers).toEqual(initialState.configDraft.providers);
    expect(merged.activeProviderTemplateId).toBe(initialState.configDraft.activeProviderTemplateId);
  });

  it('hydrates legacy shared subtitle colors into both independent text styles', () => {
    const legacyDraft = structuredClone(useAppStore.getState().configDraft);
    const legacySubtitles = legacyDraft.subtitles as unknown as Record<string, unknown>;
    legacySubtitles.overlayTextColor = '#123456';
    delete legacySubtitles.overlaySourceTextStyle;
    delete legacySubtitles.overlayTranslationTextStyle;

    const merged = appStoreTestHelpers.mergeConfigDraftWithDefaults(legacyDraft);

    expect(merged.subtitles.overlaySourceTextStyle.color).toBe('#123456');
    expect(merged.subtitles.overlayTranslationTextStyle.color).toBe('#123456');
    expect(merged.subtitles.overlaySourceTextStyle.fontWeight).toBe(500);
    expect(merged.subtitles.overlayTranslationTextStyle.fontWeight).toBe(700);
  });

  it('enables missing history fields without changing persisted model selections', () => {
    const legacyDraft = structuredClone(useAppStore.getState().configDraft);
    legacyDraft.providers[0].model = 'persisted-provider-model';
    legacyDraft.devices.inboundVoiceModelId = 'persisted-inbound-model';
    legacyDraft.devices.outboundVoiceModelId = 'persisted-outbound-model';
    legacyDraft.devices.textToSpeechModelId = 'persisted-tts-model';
    delete (legacyDraft.subtitles as Partial<typeof legacyDraft.subtitles>).history;

    const merged = appStoreTestHelpers.mergeConfigDraftWithDefaults(legacyDraft);

    expect(merged.subtitles.history).toEqual({
      enabled: true,
      sourceAudioEnabled: true,
      translatedAudioEnabled: true,
    });
    expect(merged.providers[0].model).toBe('persisted-provider-model');
    expect(merged.devices.inboundVoiceModelId).toBe('persisted-inbound-model');
    expect(merged.devices.outboundVoiceModelId).toBe('persisted-outbound-model');
    expect(merged.devices.textToSpeechModelId).toBe('persisted-tts-model');
  });

  it('fills missing inbound mix gains without replacing persisted mix settings', () => {
    const legacyDraft = structuredClone(useAppStore.getState().configDraft);
    const legacyMix = legacyDraft.devices.inboundRoute.mixControl as unknown as Record<string, unknown>;
    legacyMix.keepOriginalAudio = false;
    delete legacyMix.originalAudioGainDb;
    delete legacyMix.translatedAudioGainDb;
    delete legacyMix.translatedAudioAutoGainEnabled;

    const merged = appStoreTestHelpers.mergeConfigDraftWithDefaults(legacyDraft);

    expect(merged.devices.inboundRoute.mixControl.keepOriginalAudio).toBe(false);
    expect(merged.devices.inboundRoute.mixControl.translatedAudioEnabled).toBe(true);
    expect(merged.devices.inboundRoute.mixControl.originalAudioGainDb).toBe(-4);
    expect(merged.devices.inboundRoute.mixControl.translatedAudioGainDb).toBe(0);
    expect(merged.devices.inboundRoute.mixControl.translatedAudioAutoGainEnabled).toBe(true);
  });

  it('fills missing outbound mix gains without replacing persisted mix settings', () => {
    const legacyDraft = structuredClone(useAppStore.getState().configDraft);
    const legacyMix = legacyDraft.devices.outboundRoute.mixControl as unknown as Record<string, unknown>;
    legacyMix.keepOriginalAudio = false;
    delete legacyMix.originalAudioGainDb;
    delete legacyMix.translatedAudioGainDb;
    delete legacyMix.translatedAudioAutoGainEnabled;

    const merged = appStoreTestHelpers.mergeConfigDraftWithDefaults(legacyDraft);

    expect(merged.devices.outboundRoute.mixControl.keepOriginalAudio).toBe(false);
    expect(merged.devices.outboundRoute.mixControl.translatedAudioEnabled).toBe(true);
    expect(merged.devices.outboundRoute.mixControl.originalAudioGainDb).toBe(-4);
    expect(merged.devices.outboundRoute.mixControl.translatedAudioGainDb).toBe(-1);
    expect(merged.devices.outboundRoute.mixControl.translatedAudioAutoGainEnabled).toBe(false);
  });

  it('deduplicates notifications, keeps six items and updates runtime sync metadata', () => {
    for (let index = 0; index < 7; index += 1) {
      useAppStore.getState().pushRuntimeNotification(notification(`notice-${index}`));
    }
    useAppStore.getState().pushRuntimeNotification(notification('notice-3'));

    const state = useAppStore.getState();
    expect(state.runtimeNotifications).toHaveLength(6);
    expect(state.runtimeNotifications[0]?.id).toBe('notice-3');
    expect(new Set(state.runtimeNotifications.map((item) => item.id)).size).toBe(6);
    expect(state.runtimeSnapshot.lastSyncAt).toBe('time-notice-3');
  });

  it('preserves local notifications when a native snapshot arrives without them', () => {
    const local = notification('local-unacknowledged');
    useAppStore.getState().pushRuntimeNotification(local);
    const native = notification('native-notice');

    useAppStore.getState().setRuntimeSnapshot({
      ...runtimeSnapshotMock,
      notifications: [native],
    });

    expect(useAppStore.getState().runtimeNotifications.map((item) => item.id).slice(0, 2)).toEqual([
      'native-notice',
      'local-unacknowledged',
    ]);
    expect(useAppStore.getState().runtimeSnapshot.notifications).toEqual(
      useAppStore.getState().runtimeNotifications,
    );
  });

  it('applies ten thousand subtitle deltas through a bounded indexed window', () => {
    const baseline = structuredClone(audioRuntimeSnapshotMock);
    baseline.subtitleOverlay.streamId = 'stream-10k';
    baseline.subtitleOverlay.generation = 7;
    baseline.subtitleOverlay.seq = 0;
    baseline.subtitleOverlay.recentCues = [];
    baseline.subtitleOverlay.activeCue = null;
    useAppStore.getState().setAudioRuntimeSnapshot(baseline);

    for (let index = 1; index <= 10_000; index += 1) {
      const delta: SubtitleDeltaRuntime = {
        streamId: 'stream-10k',
        generation: 7,
        seq: index,
        operation: 'upsert',
        cue: {
          cueId: `cue-${index}`,
          routeDirection: 'inbound',
          sourceText: `source ${index}`,
          translatedText: `translated ${index}`,
          startedAt: 'unix:1',
          endedAt: 'unix:2',
          committed: true,
          translationCommitted: true,
        },
      };
      expect(useAppStore.getState().applySubtitleDelta(delta)).toBe('applied');
    }

    const state = useAppStore.getState();
    expect(state.subtitleOrderedCueIds).toHaveLength(32);
    expect(Object.keys(state.subtitleCueById)).toHaveLength(32);
    expect(state.subtitleOrderedCueIds[0]).toBe('cue-10000');
    expect(state.audioRuntimeSnapshot.subtitleOverlay.recentCues).toHaveLength(32);
    expect(state.audioRuntimeSnapshot.subtitleOverlay.recentCues[31]?.cueId).toBe('cue-9969');
  });

  it('requests resync for subtitle sequence gaps without mutating indexed cues', () => {
    const baseline = structuredClone(audioRuntimeSnapshotMock);
    baseline.subtitleOverlay.streamId = 'stream-gap';
    baseline.subtitleOverlay.generation = 3;
    baseline.subtitleOverlay.seq = 40;
    useAppStore.getState().setAudioRuntimeSnapshot(baseline);
    const before = useAppStore.getState().subtitleOrderedCueIds;

    const result = useAppStore.getState().applySubtitleDelta({
      streamId: 'stream-gap',
      generation: 3,
      seq: 42,
      operation: 'upsert',
      cue: {
        cueId: 'gap-cue',
        routeDirection: 'inbound',
        sourceText: 'gap',
        translatedText: 'gap',
        startedAt: 'unix:1',
        endedAt: 'unix:2',
        committed: true,
      },
    });

    expect(result).toBe('resync');
    expect(useAppStore.getState().subtitleOrderedCueIds).toBe(before);
    expect(useAppStore.getState().subtitleSeq).toBe(40);
  });

  it('classifies every subtitle delta ordering and identity failure', () => {
    const current = {
      cueById: { existing: cue('existing') },
      orderedCueIds: ['existing'],
      streamId: 'stream-a',
      generation: 4,
      seq: 10,
    };
    const baseDelta = {
      streamId: 'stream-a', generation: 4, seq: 11, operation: 'upsert' as const, cue: cue('next'),
    };

    expect(applySubtitleDeltaToIndex({ ...current, streamId: '' }, baseDelta).result).toBe('resync');
    expect(applySubtitleDeltaToIndex(current, { ...baseDelta, streamId: 'stream-b' }).result).toBe('resync');
    expect(applySubtitleDeltaToIndex(current, { ...baseDelta, generation: 5 }).result).toBe('resync');
    expect(applySubtitleDeltaToIndex(current, { ...baseDelta, seq: 10 }).result).toBe('ignored');
    expect(applySubtitleDeltaToIndex(current, { ...baseDelta, cue: null }).result).toBe('resync');
    expect(applySubtitleDeltaToIndex(current, {
      ...baseDelta,
      operation: 'unsupported' as never,
    }).result).toBe('resync');
  });

  it('applies reset and both existing and absent removal operations', () => {
    const current = {
      cueById: { first: cue('first'), second: cue('second') },
      orderedCueIds: ['first', 'second'],
      streamId: 'stream-reset',
      generation: 8,
      seq: 20,
    };

    const reset = applySubtitleDeltaToIndex(current, {
      streamId: 'stream-reset', generation: 9, seq: 1, operation: 'reset', cue: null,
    });
    expect(reset).toEqual({
      result: 'applied',
      index: { cueById: {}, orderedCueIds: [], streamId: 'stream-reset', generation: 9, seq: 1 },
    });

    const absent = applySubtitleDeltaToIndex(current, {
      streamId: 'stream-reset', generation: 8, seq: 21, operation: 'remove', cue: cue('absent'),
    });
    expect(absent.result).toBe('applied');
    expect(absent.index.cueById).toBe(current.cueById);
    expect(absent.index.seq).toBe(21);

    const removed = applySubtitleDeltaToIndex(current, {
      streamId: 'stream-reset', generation: 8, seq: 21, operation: 'remove', cue: cue('first'),
    });
    expect(removed.result).toBe('applied');
    expect(removed.index.orderedCueIds).toEqual(['second']);
    expect(removed.index.cueById.first).toBeUndefined();
  });

  it('updates an existing cue without reordering it and filters missing indexed entries', () => {
    const current = {
      cueById: { first: cue('first') },
      orderedCueIds: ['missing', 'first'],
      streamId: 'stream-update',
      generation: 2,
      seq: 3,
    };
    const updated = applySubtitleDeltaToIndex(current, {
      streamId: 'stream-update', generation: 2, seq: 4, operation: 'upsert',
      cue: { ...cue('first'), translatedText: 'updated' },
    });
    expect(updated.index.orderedCueIds).toEqual(['missing', 'first']);

    useAppStore.setState({
      subtitleCueById: updated.index.cueById,
      subtitleOrderedCueIds: updated.index.orderedCueIds,
      subtitleStreamId: updated.index.streamId,
      subtitleGeneration: updated.index.generation,
      subtitleSeq: updated.index.seq,
    });
    const result = useAppStore.getState().applySubtitleDelta({
      streamId: 'stream-update', generation: 2, seq: 5, operation: 'remove', cue: cue('first'),
    });
    expect(result).toBe('applied');
    expect(useAppStore.getState().audioRuntimeSnapshot.subtitleOverlay.recentCues).toEqual([]);
    expect(useAppStore.getState().audioRuntimeSnapshot.subtitleOverlay.activeCue).toBeNull();
  });

  it('drops stale snapshots and preserves subtitle state when no baseline is included', () => {
    const current = structuredClone(audioRuntimeSnapshotMock);
    current.snapshotSeq = 50;
    current.subtitleOverlay.streamId = 'preserved-stream';
    current.subtitleOverlay.generation = 5;
    current.subtitleOverlay.seq = 7;
    current.subtitleOverlay.recentCues = [cue('preserved')];
    current.subtitleOverlay.activeCue = cue('preserved');
    useAppStore.setState({ audioRuntimeSnapshot: current });
    useAppStore.setState({
      subtitleCueById: { preserved: cue('preserved') },
      subtitleOrderedCueIds: ['preserved'],
      subtitleStreamId: 'preserved-stream',
      subtitleGeneration: 5,
      subtitleSeq: 7,
    });

    const stale = structuredClone(current);
    stale.snapshotSeq = 49;
    stale.subtitleOverlay.recentCues = [];
    useAppStore.getState().setAudioRuntimeSnapshot(stale);
    expect(useAppStore.getState().audioRuntimeSnapshot).toBe(current);

    const deltaOnly = structuredClone(current);
    deltaOnly.snapshotSeq = 51;
    deltaOnly.subtitleOverlay.baselineIncluded = false;
    deltaOnly.subtitleOverlay.streamId = 'ignored-stream';
    deltaOnly.subtitleOverlay.activeCue = cue('not-in-index');
    useAppStore.getState().setAudioRuntimeSnapshot(deltaOnly);
    const state = useAppStore.getState();
    expect(state.subtitleStreamId).toBe('preserved-stream');
    expect(state.audioRuntimeSnapshot.subtitleOverlay.recentCues.map((item) => item.cueId)).toEqual(['preserved']);
    expect(state.audioRuntimeSnapshot.subtitleOverlay.activeCue?.cueId).toBe('preserved');
  });

  it('deduplicates the bounded raw baseline window and falls back to its first cue', () => {
    const snapshot = structuredClone(audioRuntimeSnapshotMock);
    snapshot.snapshotSeq = 100;
    snapshot.subtitleOverlay.streamId = 'baseline-stream';
    snapshot.subtitleOverlay.generation = 10;
    snapshot.subtitleOverlay.seq = 20;
    snapshot.subtitleOverlay.activeCue = cue('missing-active');
    snapshot.subtitleOverlay.recentCues = [
      cue('cue-0'),
      cue('cue-0'),
      ...Array.from({ length: 40 }, (_, index) => cue(`cue-${index + 1}`)),
    ];

    useAppStore.getState().setAudioRuntimeSnapshot(snapshot);
    const state = useAppStore.getState();
    expect(state.subtitleOrderedCueIds.length).toBeLessThanOrEqual(32);
    expect(new Set(state.subtitleOrderedCueIds).size).toBe(state.subtitleOrderedCueIds.length);
    expect(state.subtitleOrderedCueIds.slice(0, 2)).toEqual(['cue-0', 'cue-1']);
    expect(state.audioRuntimeSnapshot.subtitleOverlay.activeCue?.cueId).toBe('cue-0');
  });

  it('replaces matching native notifications and hydrates config through the store action', () => {
    const local = notification('same-id');
    useAppStore.getState().pushRuntimeNotification(local);
    const native = { ...notification('same-id'), message: 'native replacement' };
    useAppStore.getState().setRuntimeSnapshot({ ...runtimeSnapshotMock, notifications: [native] });
    expect(useAppStore.getState().runtimeNotifications.filter((item) => item.id === 'same-id')).toEqual([native]);

    const draft = structuredClone(useAppStore.getState().configDraft);
    draft.onboarding.activePresetId = 'preset-from-config';
    useAppStore.getState().setConfigDraft(draft);
    expect(useAppStore.getState().activePresetId).toBe('preset-from-config');
  });

  it('uses legacy color and snapshot sequence defaults when fields are absent', () => {
    const legacyDraft = structuredClone(useAppStore.getState().configDraft);
    delete (legacyDraft.subtitles as Partial<typeof legacyDraft.subtitles>).overlayTextColor;
    delete (legacyDraft.subtitles as Partial<typeof legacyDraft.subtitles>).overlaySourceTextStyle;
    delete (legacyDraft.subtitles as Partial<typeof legacyDraft.subtitles>).overlayTranslationTextStyle;
    const merged = appStoreTestHelpers.mergeConfigDraftWithDefaults(legacyDraft);
    expect(merged.subtitles.overlaySourceTextStyle.color).toBe(
      initialState.configDraft.subtitles.overlaySourceTextStyle.color,
    );

    const current = structuredClone(audioRuntimeSnapshotMock);
    delete (current as Partial<typeof current>).snapshotSeq;
    useAppStore.setState({ audioRuntimeSnapshot: current });
    const incoming = structuredClone(current);
    incoming.subtitleOverlay.recentCues = [cue('no-sequence')];
    useAppStore.getState().setAudioRuntimeSnapshot(incoming);
    expect(useAppStore.getState().audioRuntimeSnapshot.subtitleOverlay.recentCues[0]?.cueId).toBe('no-sequence');
  });

  it('updates runtime snapshots and each nested configuration section', () => {
    const runtime = { ...runtimeSnapshotMock, lastSyncAt: 'updated' };
    useAppStore.getState().setRuntimeSnapshot(runtime);
    expect(useAppStore.getState().runtimeSnapshot).toStrictEqual(runtime);

    const activeTemplateId = useAppStore.getState().configDraft.activeProviderTemplateId;
    useAppStore.getState().updateActiveProviderDraft({ displayName: 'Updated Provider' });
    expect(
      useAppStore.getState().configDraft.providers.find((provider) => provider.templateId === activeTemplateId)
        ?.displayName,
    ).toBe('Updated Provider');

    useAppStore.getState().updateDeviceDraft({ status: 'ready' });
    useAppStore.getState().updateSubtitleDraft({ targetLanguage: 'en-US' });
    useAppStore.getState().updateSpeechDraft({ enabled: false });
    useAppStore.getState().updateDriverDraft({ status: 'ready' });
    useAppStore.getState().updateGlossaryDraft({ status: 'ready' });
    useAppStore.getState().updateDiagnosticsDraft({ status: 'ready' });
    useAppStore.getState().updateOnboardingDraft({ activePresetId: 'preset-discord-mode' });
    useAppStore.getState().updateActiveProviderTemplateId('template-deepseek');
    const providers = useAppStore.getState().configDraft.providers.slice(0, 1);
    useAppStore.getState().updateProviders(providers);

    const state = useAppStore.getState();
    expect(state.configDraft.devices.status).toBe('ready');
    expect(state.configDraft.subtitles.targetLanguage).toBe('en-US');
    expect(state.configDraft.speech.enabled).toBe(false);
    expect(state.configDraft.driver.status).toBe('ready');
    expect(state.configDraft.glossary.status).toBe('ready');
    expect(state.configDraft.diagnostics.status).toBe('ready');
    expect(state.configDraft.onboarding.activePresetId).toBe('preset-discord-mode');
    expect(state.configDraft.activeProviderTemplateId).toBe('template-deepseek');
    expect(state.configDraft.providers).toEqual(providers);
  });
});
