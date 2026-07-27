import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../../stores/app-store';
import type { RuntimeNotification } from '../../schema/runtime-core';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../../runtime/diagnostics-runtime', () => ({
  appendFrontendDiagnosticsLog: vi.fn(),
  exportDiagnosticsBundleRuntime: vi.fn(),
  openExportDirectoryRuntime: vi.fn(),
}));

import { exportDiagnosticsBundleRuntime, openExportDirectoryRuntime } from '../../runtime/diagnostics-runtime';
import RuntimeToastHost from './RuntimeToastHost';
import { isSessionToastNotification, toastDisplayText } from './runtime-toast-helpers';

function notification(patch: Partial<RuntimeNotification>): RuntimeNotification {
  return {
    id: 'n1',
    level: 'error',
    source: 'session',
    message: 'boom',
    emittedAt: '2026-06-02T00:00:00.000Z',
    ...patch,
  };
}

describe('RuntimeToastHost source filtering', () => {
  it('accepts error/warning notifications from session-domain sources', () => {
    expect(isSessionToastNotification(notification({ source: 'session', level: 'error' }))).toBe(true);
    expect(isSessionToastNotification(notification({ source: 'omni', level: 'warning' }))).toBe(true);
    expect(isSessionToastNotification(notification({ source: 'audio-engine', level: 'error' }))).toBe(true);
  });

  it('rejects info level, keeps unrelated warnings local, and exposes every error', () => {
    expect(isSessionToastNotification(notification({ source: 'session', level: 'info' }))).toBe(false);
    expect(isSessionToastNotification(notification({ source: 'bridge-runtime', level: 'warning' }))).toBe(false);
    expect(isSessionToastNotification(notification({ source: 'bridge-runtime', level: 'error' }))).toBe(true);
    expect(isSessionToastNotification(notification({ source: 'desktop-runtime', level: 'error' }))).toBe(true);
  });
});

describe('RuntimeToastHost localized text', () => {
  const t = (key: string) => `t:${key}`;

  it('resolves a tagged session error code through the presentation table', () => {
    const message = 'API Key 失效: bad (code=InvalidApiKey) | code: session.credential-invalid | recommended: update-provider-credentials';
    expect(toastDisplayText(message, t)).toBe('t:session.errorCode.credentialInvalid [session.credential-invalid]');
  });

  it('falls back to the raw message when no code marker is present', () => {
    expect(toastDisplayText('plain runtime failure', t)).toBe('plain runtime failure');
  });
});

describe('RuntimeToastHost rendering', () => {
  let container: HTMLDivElement;
  let root: Root;

  const pushNotification = (patch: Partial<RuntimeNotification>) =>
    act(() => {
      useAppStore.getState().pushRuntimeNotification(notification(patch));
    });

  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    useAppStore.setState((state) => ({ ...state, runtimeNotifications: [] }));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<RuntimeToastHost />);
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
  });

  it('renders errors from every source so notifications always have an outlet', () => {
    expect(container.querySelector('.runtime-toast-region')).toBeNull();
    pushNotification({ id: 'bridge-1', source: 'bridge-runtime', level: 'error', message: 'bridge down' });
    expect(container.querySelector('.runtime-toast-error')?.textContent).toContain('bridge down');
    pushNotification({ id: 'session-1', source: 'session', level: 'error', message: 'session down' });
    const toast = [...container.querySelectorAll('.runtime-toast-error')]
      .find((item) => item.textContent?.includes('session down'));
    expect(toast?.textContent).toContain('session down');
    expect(toast?.getAttribute('role')).toBe('alert');
  });

  it('does not re-toast a deduplicated notification id after dismissal', async () => {
    pushNotification({ id: 'omni-provider-x', source: 'session', level: 'error', message: 'first push' });
    expect(container.querySelectorAll('.runtime-toast')).toHaveLength(1);
    const closeButton = container.querySelector<HTMLButtonElement>('.runtime-toast-close');
    await act(async () => {
      closeButton?.click();
    });
    expect(container.querySelectorAll('.runtime-toast')).toHaveLength(0);
    // Same id re-pushed (reconnect storm) must not resurface a new toast.
    pushNotification({ id: 'omni-provider-x', source: 'session', level: 'error', message: 'second push' });
    expect(container.querySelectorAll('.runtime-toast')).toHaveLength(0);
  });

  it('auto-dismisses warnings after five seconds while errors persist', async () => {
    pushNotification({ id: 'warn-1', source: 'audio-engine', level: 'warning', message: 'flaky audio' });
    pushNotification({ id: 'err-1', source: 'omni', level: 'error', message: 'session dead' });
    expect(container.querySelectorAll('.runtime-toast')).toHaveLength(2);
    expect(container.querySelector('.runtime-toast-warning')?.getAttribute('role')).toBe('status');
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(container.querySelector('.runtime-toast-warning')).toBeNull();
    expect(container.querySelector('.runtime-toast-error')?.textContent).toContain('session dead');
  });

  it('surfaces a desktop bootstrap error that predates the host mount', async () => {
    await act(async () => root.unmount());
    useAppStore.setState((state) => ({
      ...state,
      runtimeNotifications: [notification({ id: 'runtime-bootstrap-failed', source: 'desktop-runtime', message: 'IPC unavailable' })],
    }));
    root = createRoot(container);
    await act(async () => root.render(<RuntimeToastHost />));
    expect(container.querySelector('.runtime-toast-error')?.textContent).toContain('IPC unavailable');
    expect(container.querySelector('.runtime-toast-action')?.textContent).toContain('common.retry');
  });

  it('offers a retry action for desktop runtime persistence failures', async () => {
    const listener = vi.fn();
    window.addEventListener('omni://retry-config-persist', listener);
    pushNotification({ id: 'config-persist-failed-1', source: 'desktop-runtime', level: 'error', message: 'not saved' });
    await act(async () => container.querySelector<HTMLButtonElement>('.runtime-toast-action')?.click());
    expect(listener).toHaveBeenCalledOnce();
    expect(container.querySelector('.runtime-toast')).toBeNull();
    window.removeEventListener('omni://retry-config-persist', listener);
  });

  it('keeps the session toast and shows the reason when diagnostics export fails', async () => {
    vi.mocked(exportDiagnosticsBundleRuntime).mockRejectedValueOnce(new Error('磁盘空间不足'));
    pushNotification({ id: 'session-export-failure', source: 'session', level: 'error', message: 'session down' });

    await act(async () => container.querySelector<HTMLButtonElement>('.runtime-toast-action')?.click());

    expect(container.querySelector('.runtime-toast-error')?.textContent).toContain('session down');
    expect(container.querySelector('.runtime-toast-export-error')?.textContent).toContain('磁盘空间不足');
  });

  it('keeps export success distinct when only opening its directory fails', async () => {
    vi.mocked(exportDiagnosticsBundleRuntime).mockResolvedValueOnce({
      artifact: {
        outputPath: 'C:/exports/quick.zip',
        fileCount: 3,
        scope: 'quick',
        generatedAt: '2026-07-27T00:00:00.000Z',
      },
      snapshot: useAppStore.getState().runtimeSnapshot,
    });
    vi.mocked(openExportDirectoryRuntime).mockRejectedValueOnce(new Error('shell unavailable'));
    pushNotification({ id: 'session-open-directory-failure', source: 'session', level: 'error', message: 'session down' });

    await act(async () => container.querySelector<HTMLButtonElement>('.runtime-toast-action')?.click());

    const feedback = container.querySelector('.runtime-toast-export-error')?.textContent;
    expect(feedback).toContain('diagnostics.status.completed：C:/exports/quick.zip');
    expect(feedback).toContain('diagnostics.actions.openExportDirectory diagnostics.status.failed');
    expect(feedback).toContain('shell unavailable');
  });
});
