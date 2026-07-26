import { DesktopApiV2 } from './desktop-api-v2';
import { PreviewDesktopApi, type DesktopCapabilities } from './preview-desktop-api';
import { isTauriRuntime } from './tauri-runtime';

/**
 * Structural surface of the desktop boundary (the public members of
 * DesktopApiV2 without its private invoke plumbing), plus the capability
 * flags callers use instead of re-probing the environment.
 */
export type DesktopApiSurface = Omit<DesktopApiV2, never>;
export type DesktopApi = DesktopApiSurface & { readonly capabilities: DesktopCapabilities };

/** The real desktop boundary: DesktopApiV2 over Tauri invoke. */
export class TauriDesktopApi extends DesktopApiV2 {
  readonly capabilities: DesktopCapabilities = { hasNativeShell: true };
}

type DesktopApiListener = () => void;

let activeApi: DesktopApi | null = null;
const listeners = new Set<DesktopApiListener>();

/**
 * Install the desktop boundary implementation. Called once per process from
 * a composition root (main.tsx / overlay.tsx pick the initial implementation;
 * the desktop-runtime bootstrap upgrades preview -> Tauri when the invoke
 * bridge heals late). Everything else consumes `activeDesktopApi()` or the
 * React context and never probes the environment itself.
 */
export function installDesktopApi(api: DesktopApi): void {
  activeApi = api;
  for (const listener of Array.from(listeners)) {
    listener();
  }
}

/**
 * The active desktop boundary. Falls back to a one-time environment decision
 * so module-level callers stay safe before a composition root has run
 * (e.g. isolated unit tests importing a runtime module directly).
 */
export function activeDesktopApi(): DesktopApi {
  if (activeApi === null) {
    activeApi = isTauriRuntime() ? new TauriDesktopApi() : new PreviewDesktopApi();
  }
  return activeApi;
}

/** Subscribe to installDesktopApi transitions (late-heal upgrade re-renders). */
export function subscribeDesktopApiChange(listener: DesktopApiListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam: clear the active instance so the next call re-decides. */
export function resetDesktopApiForTests(): void {
  activeApi = null;
}
