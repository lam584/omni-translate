import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  installDesktopApi,
  resetDesktopApiForTests,
  TauriDesktopApi,
  type DesktopApi,
} from './desktop-api';
import { DesktopApiProvider, useDesktopApiV2, useDesktopCapabilities } from './desktop-api-context';
import { PreviewDesktopApi } from './preview-desktop-api';

describe('DesktopApiProvider', () => {
  let container: HTMLDivElement;
  let root: Root;
  let observed: DesktopApi;
  let observedCapabilities: { hasNativeShell: boolean };

  function Consumer() {
    observed = useDesktopApiV2();
    observedCapabilities = useDesktopCapabilities();
    return null;
  }

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    resetDesktopApiForTests();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    resetDesktopApiForTests();
  });

  it('serves the installed API and permits a complete replacement at the orchestration boundary', async () => {
    const preview = new PreviewDesktopApi();
    installDesktopApi(preview);

    await act(async () => root.render(<DesktopApiProvider><Consumer /></DesktopApiProvider>));
    expect(observed).toBe(preview);
    expect(observedCapabilities.hasNativeShell).toBe(false);

    const replacement = new TauriDesktopApi(async <T,>() => undefined as T);
    await act(async () => root.render(<DesktopApiProvider api={replacement}><Consumer /></DesktopApiProvider>));
    expect(observed).toBe(replacement);
    expect(observedCapabilities.hasNativeShell).toBe(true);
  });

  it('re-renders consumers when a late heal upgrades the installed API', async () => {
    const preview = new PreviewDesktopApi();
    installDesktopApi(preview);

    await act(async () => root.render(<DesktopApiProvider><Consumer /></DesktopApiProvider>));
    expect(observedCapabilities.hasNativeShell).toBe(false);

    const upgraded = new TauriDesktopApi(async <T,>() => undefined as T);
    await act(async () => {
      installDesktopApi(upgraded);
    });
    expect(observed).toBe(upgraded);
    expect(observedCapabilities.hasNativeShell).toBe(true);
  });
});
