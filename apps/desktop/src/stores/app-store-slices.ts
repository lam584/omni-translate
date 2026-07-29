import { useAppStore } from './app-store';

// Shared selector bundles for pages that subscribe to the same store slices.
// Each slice keeps its own `useAppStore` call so the subscription granularity
// is identical to the previous inline selectors.

export function useRuntimeSessionStoreSlices() {
  const configDraft = useAppStore((state) => state.configDraft);
  const runtimeSnapshot = useAppStore((state) => state.runtimeSnapshot);
  const audioRuntimeSnapshot = useAppStore((state) => state.audioRuntimeSnapshot);
  const setRuntimeSnapshot = useAppStore((state) => state.setRuntimeSnapshot);
  return { configDraft, runtimeSnapshot, audioRuntimeSnapshot, setRuntimeSnapshot };
}

export function useProviderWorkspaceStoreSlices() {
  const configDraft = useAppStore((state) => state.configDraft);
  const runtimeSnapshot = useAppStore((state) => state.runtimeSnapshot);
  const runtimeNotifications = useAppStore((state) => state.runtimeNotifications);
  const updateActiveProviderDraft = useAppStore((state) => state.updateActiveProviderDraft);
  const setRuntimeSnapshot = useAppStore((state) => state.setRuntimeSnapshot);
  return { configDraft, runtimeSnapshot, runtimeNotifications, updateActiveProviderDraft, setRuntimeSnapshot };
}
