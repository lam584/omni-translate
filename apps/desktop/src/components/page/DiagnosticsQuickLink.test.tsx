import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { appConfigDraftMock } from '../../mocks/app-config';
import { audioRuntimeSnapshotMock } from '../../mocks/audio-runtime';
import { runtimeSnapshotMock } from '../../mocks/runtime-shell';
import { registerDomHarness } from '../../test-utils/component-test-harness';
import DiagnosticsQuickLink from './DiagnosticsQuickLink';

describe('DiagnosticsQuickLink', () => {
  const view = registerDomHarness();

  it('links to diagnostics with the computed readiness badge by default', async () => {
    await view.render(
      <MemoryRouter>
        <DiagnosticsQuickLink
          audioRuntimeSnapshot={structuredClone(audioRuntimeSnapshotMock)}
          configDraft={structuredClone(appConfigDraftMock)}
          runtimeSnapshot={structuredClone(runtimeSnapshotMock)}
        />
      </MemoryRouter>,
    );
    expect(view.container.querySelector('a')?.getAttribute('href')).toBe('/diagnostics');
    expect(view.container.querySelector('.status-badge')).not.toBeNull();
  });

  it('can hide the readiness badge', async () => {
    await view.render(
      <MemoryRouter>
        <DiagnosticsQuickLink
          audioRuntimeSnapshot={structuredClone(audioRuntimeSnapshotMock)}
          configDraft={structuredClone(appConfigDraftMock)}
          runtimeSnapshot={structuredClone(runtimeSnapshotMock)}
          showOverallBadge={false}
        />
      </MemoryRouter>,
    );
    expect(view.container.querySelector('.status-badge')).toBeNull();
  });
});
