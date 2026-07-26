import type { AppConfigDraft } from '../../schema/config';
import { LocalStorageBackend } from '../../utils/persistence-backend';

/**
 * The single access path for the `omni.configDraftFallback` recovery slot.
 * Two write paths used to exist for the same key (bare `window.localStorage`
 * calls in the persist queue and a LocalStorageBackend in the bootstrap);
 * both serialized identically, so funnelling everything through one backend
 * instance changes no stored bytes.
 */
export const CONFIG_DRAFT_FALLBACK_STORAGE_KEY = 'omni.configDraftFallback';
export const CONFIG_DRAFT_SYNC_STORAGE_KEY = 'omni.configDraftShadow';

const fallbackBackend = new LocalStorageBackend();

export function canUseLocalStorage() {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

export async function saveConfigDraftFallback(config: AppConfigDraft): Promise<void> {
  await fallbackBackend.save(CONFIG_DRAFT_FALLBACK_STORAGE_KEY, config);
}

export async function loadConfigDraftFallback(): Promise<AppConfigDraft | null> {
  return fallbackBackend.load<AppConfigDraft>(CONFIG_DRAFT_FALLBACK_STORAGE_KEY);
}

export async function deleteConfigDraftFallback(): Promise<void> {
  await fallbackBackend.delete(CONFIG_DRAFT_FALLBACK_STORAGE_KEY);
}

/**
 * Clear the fallback only when it still holds exactly the config that was
 * just persisted natively (a newer draft written meanwhile must survive).
 */
export async function clearConfigDraftFallbackIfMatches(serializedConfig: string): Promise<void> {
  const stored = await fallbackBackend.load<AppConfigDraft>(CONFIG_DRAFT_FALLBACK_STORAGE_KEY);
  if (stored !== null && JSON.stringify(stored) === serializedConfig) {
    await fallbackBackend.delete(CONFIG_DRAFT_FALLBACK_STORAGE_KEY);
  }
}

export function writeConfigDraftShadow(serializedConfig: string) {
  if (!canUseLocalStorage()) {
    return;
  }
  if (window.localStorage.getItem(CONFIG_DRAFT_SYNC_STORAGE_KEY) === serializedConfig) {
    return;
  }
  window.localStorage.setItem(CONFIG_DRAFT_SYNC_STORAGE_KEY, serializedConfig);
}
