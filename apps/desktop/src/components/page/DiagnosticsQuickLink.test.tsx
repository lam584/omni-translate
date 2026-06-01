import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appConfigDraftMock } from '../../mocks/app-config';
import { audioRuntimeSnapshotMock } from '../../mocks/audio-runtime';
import { runtimeSnapshotMock } from '../../mocks/runtime-shell';
import DiagnosticsQuickLink from './DiagnosticsQuickLink';

describe('DiagnosticsQuickLink', () => {
  let container: HTMLDivElement;
  let root: Root;

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

  it('links to diagnostics with the computed readiness badge by default', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <DiagnosticsQuickLink
            audioRuntimeSnapshot={structuredClone(audioRuntimeSnapshotMock)}
            configDraft={structuredClone(appConfigDraftMock)}
            runtimeSnapshot={structuredClone(runtimeSnapshotMock)}
          />
        </MemoryRouter>,
      );
    });
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/diagnostics');
    expect(container.querySelector('.status-badge')).not.toBeNull();
  });

  it('can hide the readiness badge', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <DiagnosticsQuickLink
            audioRuntimeSnapshot={structuredClone(audioRuntimeSnapshotMock)}
            configDraft={structuredClone(appConfigDraftMock)}
            runtimeSnapshot={structuredClone(runtimeSnapshotMock)}
            showOverallBadge={false}
          />
        </MemoryRouter>,
      );
    });
    expect(container.querySelector('.status-badge')).toBeNull();
  });
});
