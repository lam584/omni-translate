import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OverlayApp, mountOverlayApp } from './overlay';

const overlayMocks = vi.hoisted(() => ({
  bootstrapCleanup: vi.fn(),
  bootstrapDesktopRuntimeBridge: vi.fn(),
}));

vi.mock('./runtime/desktop-runtime', () => ({
  bootstrapDesktopRuntimeBridge: (...args: Parameters<typeof overlayMocks.bootstrapDesktopRuntimeBridge>) =>
    overlayMocks.bootstrapDesktopRuntimeBridge(...args),
}));

vi.mock('./pages/SubtitleOverlayPage', () => ({
  default: () => React.createElement('div', { className: 'subtitle-overlay-page-test' }),
}));

vi.mock('./i18n/config', () => ({}));

describe('overlay entry', () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    overlayMocks.bootstrapCleanup.mockReset();
    overlayMocks.bootstrapDesktopRuntimeBridge.mockReset().mockResolvedValue(overlayMocks.bootstrapCleanup);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount());
      root = null;
    }
    container.remove();
  });

  it('starts the desktop runtime bridge and cleans it up', async () => {
    await act(async () => {
      root?.render(React.createElement(OverlayApp));
    });

    expect(container.querySelector('.subtitle-overlay-page-test')).not.toBeNull();
    expect(overlayMocks.bootstrapDesktopRuntimeBridge).toHaveBeenCalledTimes(1);

    await act(async () => root?.unmount());
    root = null;
    expect(overlayMocks.bootstrapCleanup).toHaveBeenCalledTimes(1);
  });

  it('fails fast when the overlay root element is missing', () => {
    expect(() => mountOverlayApp(null)).toThrow('Overlay root element not found.');
  });

  it('renders a retryable degraded view when runtime bootstrap fails', async () => {
    overlayMocks.bootstrapDesktopRuntimeBridge.mockRejectedValueOnce(new Error('bootstrap failed'));

    await act(async () => {
      root?.render(React.createElement(OverlayApp));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('.overlay-bootstrap-fallback')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });
});
