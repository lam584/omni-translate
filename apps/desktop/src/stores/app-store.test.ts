import { beforeEach, describe, expect, it } from 'vitest';

import { audioRuntimeSnapshotMock } from '../mocks/audio-runtime';
import { runtimeSnapshotMock } from '../mocks/runtime-shell';
import type { RuntimeNotification } from '../schema/runtime-core';
import { appStoreTestHelpers, useAppStore } from './app-store';

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
    expect(useAppStore.getState().audioRuntimeSnapshot.sessionStartedAt).toBeTruthy();

    const continued = structuredClone(started);
    continued.sessionStartedAt = null;
    useAppStore.getState().setAudioRuntimeSnapshot(continued);
    expect(useAppStore.getState().audioRuntimeSnapshot.sessionStartedAt).toBeTruthy();

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

  it('updates runtime snapshots and each nested configuration section', () => {
    const runtime = { ...runtimeSnapshotMock, lastSyncAt: 'updated' };
    useAppStore.getState().setRuntimeSnapshot(runtime);
    expect(useAppStore.getState().runtimeSnapshot).toBe(runtime);

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
