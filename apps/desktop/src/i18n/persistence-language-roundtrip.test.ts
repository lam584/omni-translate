import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import i18n from './config';
import { appConfigDraftMock } from '../defaults/app-config';
import { useAppStore } from '../stores/app-store';

const initialState = useAppStore.getState();

function resetStore() {
  useAppStore.setState(initialState, true);
}

/**
 * Builds a config draft through the real store mutation paths and returns the
 * exact bytes the persist queue stores: the fallback subscription in
 * src/runtime/bootstrap/startup.ts persists `JSON.stringify(state.configDraft)`
 * and LocalStorageBackend.save (src/utils/persistence-backend.ts) writes that
 * serialization verbatim.
 */
function buildDraftAndSerialize(): string {
  resetStore();
  const store = useAppStore.getState();
  store.setConfigDraft(structuredClone(appConfigDraftMock));
  store.updateSubtitleDraft({ mode: 'bilingual', targetLanguage: 'zh-CN' });
  store.updateSpeechDraft({ enabled: true, voice: 'Ethan' });
  store.updateDriverDraft({ installPhase: 'rollback-required' });
  store.setActivePresetId('preset-game-voice-mode');
  return JSON.stringify(useAppStore.getState().configDraft);
}

// A key whose zh-CN and en translations differ, used to prove the language
// switch in this suite is real (i18n is the live instance, not a stub).
const PROBE_KEY = 'diagnostics.status.running';

describe('config draft persistence vs UI language', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh-CN');
    resetStore();
  });

  afterAll(async () => {
    // Restore the suite-wide default from test-setup.ts.
    await i18n.changeLanguage('zh-CN');
    resetStore();
  });

  it('persists byte-identical config drafts under zh-CN and en', async () => {
    expect(i18n.resolvedLanguage).toBe('zh-CN');
    expect(i18n.t(PROBE_KEY)).toBe('运行中');
    const zhBytes = buildDraftAndSerialize();

    await i18n.changeLanguage('en');
    // The switch is real: the same key now renders the English string.
    expect(i18n.t(PROBE_KEY)).toBe('Running');
    const enBytes = buildDraftAndSerialize();

    // Byte-identical persisted content: nothing in the draft build path may
    // capture the active UI language.
    expect(enBytes).toBe(zhBytes);

    // And neither locale's rendering of a UI string leaks into the persisted
    // bytes (the draft's own Chinese *content*, e.g. provider display names,
    // is data and stays byte-identical above).
    expect(zhBytes).not.toContain('运行中');
    expect(zhBytes).not.toContain('"Running"');
  });

  it('hydrates a persisted draft into identical state regardless of the active language', async () => {
    const persisted = buildDraftAndSerialize();

    // Hydrate the way the bootstrap does: parse the stored bytes and feed them
    // through setConfigDraft (mergeConfigDraftWithDefaults).
    await i18n.changeLanguage('en');
    resetStore();
    useAppStore.getState().setConfigDraft(JSON.parse(persisted));
    const hydratedUnderEn = JSON.stringify(useAppStore.getState().configDraft);

    await i18n.changeLanguage('zh-CN');
    resetStore();
    useAppStore.getState().setConfigDraft(JSON.parse(persisted));
    const hydratedUnderZh = JSON.stringify(useAppStore.getState().configDraft);

    expect(hydratedUnderEn).toBe(hydratedUnderZh);

    // Hydration is a fixed point of persistence: re-persisting the hydrated
    // draft stores the same bytes, so save/load cycles cannot drift with the
    // UI language.
    expect(hydratedUnderEn).toBe(persisted);
  });
});
