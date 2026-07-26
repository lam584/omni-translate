import { appConfigDraftMock } from '../mocks/app-config';
import { audioRuntimeSnapshotMock } from '../mocks/audio-runtime';
import { runtimeSnapshotMock } from '../mocks/runtime-shell';

/**
 * Deep-clones the canonical store fixtures. Callers destructure the slices
 * they need; cloning all three keeps the helper drop-in compatible with the
 * per-file variants it replaces.
 */
export function cloneStoreState() {
  return {
    configDraft: structuredClone(appConfigDraftMock),
    runtimeSnapshot: structuredClone(runtimeSnapshotMock),
    audioRuntimeSnapshot: structuredClone(audioRuntimeSnapshotMock),
  };
}

/**
 * Toggles the `globalThis.isTauri` marker used by `isTauri()` runtime probes.
 * Passing false removes the property entirely (browser-preview behaviour).
 */
export function setTauriRuntime(enabled: boolean) {
  if (enabled) {
    Object.defineProperty(globalThis, 'isTauri', {
      value: true,
      writable: true,
      configurable: true,
    });
    return;
  }

  Reflect.deleteProperty(globalThis, 'isTauri');
}
