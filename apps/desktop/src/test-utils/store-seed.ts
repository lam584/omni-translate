import { useAppStore } from '../stores/app-store';
import { cloneStoreState } from './store-state';

type StoreSlices = ReturnType<typeof cloneStoreState>;

/**
 * Seeds the config draft, runtime snapshot, audio runtime snapshot and the
 * runtime notifications (taken from the cloned snapshot) in one call. Pass a
 * mutator to adjust the cloned fixtures before they are published.
 */
export function seedRuntimeStore(mutate?: (slices: StoreSlices) => void): StoreSlices {
  const slices = cloneStoreState();
  mutate?.(slices);
  useAppStore.setState((state) => ({
    ...state,
    ...slices,
    runtimeNotifications: slices.runtimeSnapshot.notifications,
  }));
  return slices;
}
