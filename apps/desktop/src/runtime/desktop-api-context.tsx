import { createContext, useContext, useSyncExternalStore, type PropsWithChildren } from 'react';
import { activeDesktopApi, subscribeDesktopApiChange, type DesktopApi } from './desktop-api';
import type { DesktopCapabilities } from './preview-desktop-api';

const DesktopApiContext = createContext<DesktopApi | null>(null);

/**
 * Supplies the desktop boundary to the React tree. Without an explicit `api`
 * it tracks the installed implementation, so a late invoke-bridge heal
 * (preview -> Tauri upgrade) re-renders consumers with the new capabilities.
 */
export function DesktopApiProvider({ api, children }: PropsWithChildren<{ api?: DesktopApi }>) {
  const installed = useSyncExternalStore(subscribeDesktopApiChange, activeDesktopApi, activeDesktopApi);
  return <DesktopApiContext.Provider value={api ?? installed}>{children}</DesktopApiContext.Provider>;
}

export function useDesktopApiV2(): DesktopApi {
  return useContext(DesktopApiContext) ?? activeDesktopApi();
}

/** Capability flags for UI-level feature gating (no environment probing). */
export function useDesktopCapabilities(): DesktopCapabilities {
  return useDesktopApiV2().capabilities;
}
