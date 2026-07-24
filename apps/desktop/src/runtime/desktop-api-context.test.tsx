import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { desktopApiV2, DesktopApiV2 } from './desktop-api-v2';
import { DesktopApiProvider, useDesktopApiV2 } from './desktop-api-context';

describe('DesktopApiProvider', () => {
  let container: HTMLDivElement;
  let root: Root;
  let observed: DesktopApiV2;

  function Consumer() {
    observed = useDesktopApiV2();
    return null;
  }

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('uses the default API and permits a complete replacement at the orchestration boundary', async () => {
    await act(async () => root.render(<DesktopApiProvider><Consumer /></DesktopApiProvider>));
    expect(observed).toBe(desktopApiV2);

    const replacement = new DesktopApiV2(async <T,>() => undefined as T);
    await act(async () => root.render(<DesktopApiProvider api={replacement}><Consumer /></DesktopApiProvider>));
    expect(observed).toBe(replacement);
  });
});
