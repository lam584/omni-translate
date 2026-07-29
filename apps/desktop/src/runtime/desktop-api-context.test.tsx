import { act } from 'react';
import { describe, expect, it } from 'vitest';

import { registerDomHarness } from '../test-utils/component-test-harness';
import {
  installDesktopApi,
  resetDesktopApiForTests,
  TauriDesktopApi,
  type DesktopApi,
} from './desktop-api';
import { DesktopApiProvider, useDesktopApiV2, useDesktopCapabilities } from './desktop-api-context';
import { PreviewDesktopApi } from './preview-desktop-api';

describe('DesktopApiProvider', () => {
  let observed: DesktopApi;
  let observedCapabilities: { hasNativeShell: boolean };

  function Consumer() {
    observed = useDesktopApiV2();
    observedCapabilities = useDesktopCapabilities();
    return null;
  }

  const view = registerDomHarness({
    setup: () => {
      resetDesktopApiForTests();
    },
    cleanup: () => {
      resetDesktopApiForTests();
    },
  });

  it('serves the installed API and permits a complete replacement at the orchestration boundary', async () => {
    const preview = new PreviewDesktopApi();
    installDesktopApi(preview);

    await view.render(<DesktopApiProvider><Consumer /></DesktopApiProvider>);
    expect(observed).toBe(preview);
    expect(observedCapabilities.hasNativeShell).toBe(false);

    const replacement = new TauriDesktopApi(async <T,>() => undefined as T);
    await view.render(<DesktopApiProvider api={replacement}><Consumer /></DesktopApiProvider>);
    expect(observed).toBe(replacement);
    expect(observedCapabilities.hasNativeShell).toBe(true);
  });

  it('re-renders consumers when a late heal upgrades the installed API', async () => {
    const preview = new PreviewDesktopApi();
    installDesktopApi(preview);

    await view.render(<DesktopApiProvider><Consumer /></DesktopApiProvider>);
    expect(observedCapabilities.hasNativeShell).toBe(false);

    const upgraded = new TauriDesktopApi(async <T,>() => undefined as T);
    await act(async () => {
      installDesktopApi(upgraded);
    });
    expect(observed).toBe(upgraded);
    expect(observedCapabilities.hasNativeShell).toBe(true);
  });
});
