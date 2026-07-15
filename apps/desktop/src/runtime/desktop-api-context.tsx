import { createContext, useContext, type PropsWithChildren } from 'react';
import { desktopApiV2, type DesktopApiV2 } from './desktop-api-v2';

const DesktopApiContext = createContext<DesktopApiV2>(desktopApiV2);

/** Supplies a replaceable desktop boundary to page-level orchestration. */
export function DesktopApiProvider({ api, children }: PropsWithChildren<{ api?: DesktopApiV2 }>) {
  return <DesktopApiContext.Provider value={api ?? desktopApiV2}>{children}</DesktopApiContext.Provider>;
}

export function useDesktopApiV2(): DesktopApiV2 {
  return useContext(DesktopApiContext);
}
