import { appConfigDraftMock } from '../mocks/app-config';
import { audioRuntimeSnapshotMock } from '../mocks/audio-runtime';
import { runtimeSnapshotMock } from '../mocks/runtime-shell';
import { installDesktopApi, resetDesktopApiForTests, TauriDesktopApi } from '../runtime/desktop-api';
import { PreviewDesktopApi } from '../runtime/preview-desktop-api';

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
 * Injection sugar for tests: installs the Tauri or the browser-preview
 * desktop boundary. This replaced the old `globalThis.isTauri` toggle, which
 * only covered one of the three environment probes and therefore exercised a
 * different path than the vi.mock-based suites.
 */
export function setTauriRuntime(enabled: boolean) {
  resetDesktopApiForTests();
  installDesktopApi(enabled ? new TauriDesktopApi() : new PreviewDesktopApi());
}
