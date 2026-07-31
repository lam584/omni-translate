import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appConfigDraftMock } from '../../mocks/app-config';
import { runtimeSnapshotMock } from '../../mocks/runtime-shell';
import { useAppStore } from '../../stores/app-store';
import { installDesktopApi, resetDesktopApiForTests, TauriDesktopApi } from '../desktop-api';
import { scheduleBridgeAutostartAfterStartup } from './bridge-autostart';
import {
  resetNativeWatchDiagnosticGateForTests,
  updateNativeWatchDiagnosticGateFromIpcPing,
} from './watch-mode';

const invokeMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  isTauri: () => false,
}));

function autostartableSnapshot() {
  const snapshot = structuredClone(runtimeSnapshotMock);
  snapshot.bridgeStatus = 'tauri-shell';
  snapshot.bridge.driverHealth = 'running';
  snapshot.bridge.processStatus = 'stopped';
  return snapshot;
}

describe('scheduleBridgeAutostartAfterStartup', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    resetDesktopApiForTests();
    resetNativeWatchDiagnosticGateForTests();
    installDesktopApi(new TauriDesktopApi());
    useAppStore.setState((state) => ({ ...state, runtimeSnapshot: structuredClone(runtimeSnapshotMock) }));
  });

  afterEach(() => {
    vi.useRealTimers();
    resetDesktopApiForTests();
    resetNativeWatchDiagnosticGateForTests();
  });

  it('starts the bridge service when the refreshed snapshot reports a stopped autostartable bridge', async () => {
    const refreshed = autostartableSnapshot();
    const started = structuredClone(refreshed);
    started.bridge.processStatus = 'running';
    invokeMock.mockImplementation(async (command: string, args?: { command?: { action?: string } }) => {
      if (command === 'bridge_v2' && args?.command?.action === 'refresh') {
        return { data: refreshed, warnings: [] };
      }
      if (command === 'start_bridge_service') {
        return started;
      }
      throw new Error(`unexpected command ${command}`);
    });

    await scheduleBridgeAutostartAfterStartup(structuredClone(appConfigDraftMock), 0).promise;

    expect(invokeMock).toHaveBeenCalledWith('start_bridge_service', expect.anything());
    expect(useAppStore.getState().runtimeSnapshot.bridge.processStatus).toBe('running');
  });

  it.each([
    ['bridge already running', (snapshot: ReturnType<typeof autostartableSnapshot>) => { snapshot.bridge.processStatus = 'running'; }],
    ['driver not running', (snapshot: ReturnType<typeof autostartableSnapshot>) => { snapshot.bridge.driverHealth = 'not-installed'; }],
    ['not in the tauri shell', (snapshot: ReturnType<typeof autostartableSnapshot>) => { snapshot.bridgeStatus = 'browser-preview'; }],
  ])('skips the start when %s', async (_label, mutate) => {
    const refreshed = autostartableSnapshot();
    mutate(refreshed);
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'bridge_v2') return { data: refreshed, warnings: [] };
      throw new Error(`unexpected command ${command}`);
    });

    await scheduleBridgeAutostartAfterStartup(structuredClone(appConfigDraftMock), 0).promise;

    expect(invokeMock).not.toHaveBeenCalledWith('start_bridge_service', expect.anything());
  });

  it('skips generic bridge autostart when the native IPC ping owns Watch diagnostic startup', async () => {
    const refreshed = autostartableSnapshot();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'bridge_v2') return { data: refreshed, warnings: [] };
      throw new Error(`unexpected command ${command}`);
    });
    updateNativeWatchDiagnosticGateFromIpcPing(
      'pong storage_status=ready watchDiagnostic=true backendAutostartAuthoritative=true',
    );

    await scheduleBridgeAutostartAfterStartup(structuredClone(appConfigDraftMock), 0).promise;

    expect(invokeMock).toHaveBeenCalledWith('bridge_v2', { command: { action: 'refresh' } });
    expect(invokeMock).not.toHaveBeenCalledWith('start_bridge_service', expect.anything());
  });

  it('reports a warning notification when the refresh fails', async () => {
    invokeMock.mockRejectedValue(new Error('probe unavailable'));

    await scheduleBridgeAutostartAfterStartup(structuredClone(appConfigDraftMock), 0).promise;

    expect(useAppStore.getState().runtimeNotifications[0]).toEqual(
      expect.objectContaining({ level: 'warning', source: 'desktop-runtime' }),
    );
  });

  it('honours a positive delay and can be cancelled before it fires', () => {
    vi.useFakeTimers();
    const handle = scheduleBridgeAutostartAfterStartup(structuredClone(appConfigDraftMock), 5_000);
    handle.cleanup();
    vi.advanceTimersByTime(5_000);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('uses the store config draft by default', async () => {
    const refreshed = autostartableSnapshot();
    refreshed.bridge.processStatus = 'running';
    invokeMock.mockResolvedValue({ data: refreshed, warnings: [] });

    await scheduleBridgeAutostartAfterStartup(undefined, 0).promise;

    expect(invokeMock).toHaveBeenCalledWith('bridge_v2', { command: { action: 'refresh' } });
  });
});
