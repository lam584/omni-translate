import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appConfigDraftMock } from './mocks/app-config';
import { OverlayUnlockApp } from './overlay-unlock';
import { useAppStore } from './stores/app-store';

const mocks = vi.hoisted(() => ({
  bootstrap: vi.fn(async () => () => {}),
  hide: vi.fn(async () => {}),
}));

vi.mock('./runtime/desktop-runtime', () => ({
  bootstrapDesktopRuntimeBridge: mocks.bootstrap,
}));

vi.mock('./runtime/overlay-window-adapter', () => ({
  getCurrentWindow: () => ({ hide: mocks.hide }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? '解锁' }),
}));

describe('OverlayUnlockApp', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState((state) => ({
      ...state,
      configDraft: {
        ...structuredClone(appConfigDraftMock),
        subtitles: { ...structuredClone(appConfigDraftMock.subtitles), overlayLocked: true },
      },
    }));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('unlocks the subtitle overlay and immediately hides the hotspot window', async () => {
    await act(async () => root.render(<OverlayUnlockApp />));
    const button = container.querySelector('button');
    expect(button).not.toBeNull();

    await act(async () => button?.click());

    expect(useAppStore.getState().configDraft.subtitles.overlayLocked).toBe(false);
    expect(mocks.hide).toHaveBeenCalledOnce();
  });
});
