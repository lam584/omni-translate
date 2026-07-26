import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appConfigDraftMock } from '../mocks/app-config';
import { runtimeSnapshotMock } from '../mocks/runtime-shell';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauriRuntime: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mocks.invoke(...args),
}));

vi.mock('./tauri-runtime', () => ({
  isTauriRuntime: () => mocks.isTauriRuntime(),
}));

import {
  bridgeRuntimeTestHelpers,
  installDriverRuntime,
  refreshBridgeRuntime,
  repairDriverRuntime,
  startBridgeServiceRuntime,
  stopBridgeServiceRuntime,
  uninstallDriverRuntime,
} from './bridge-runtime';
import { getRecentFrontendLogEntries, loggerTestHelpers } from './logger';

describe('bridge runtime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.invoke.mockReset();
    mocks.isTauriRuntime.mockReset().mockReturnValue(false);
    loggerTestHelpers.reset();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    loggerTestHelpers.reset();
  });

  it('provides complete browser preview lifecycle snapshots', async () => {
    const config = structuredClone(appConfigDraftMock);
    expect(await refreshBridgeRuntime()).toBe(runtimeSnapshotMock);
    expect((await startBridgeServiceRuntime(config)).bridge).toMatchObject({
      bridgeState: 'running',
      expectedDriverVersion: config.driver.expectedDriverVersion,
      expectedBridgeVersion: config.driver.expectedBridgeVersion,
    });
    expect((await stopBridgeServiceRuntime()).bridge).toMatchObject({ bridgeState: 'stopped', sessionId: null });
    expect((await installDriverRuntime(config)).bridge).toMatchObject({ driverHealth: 'running', driverVersion: config.driver.expectedDriverVersion });
    expect((await uninstallDriverRuntime()).bridge).toMatchObject({ driverHealth: 'not-installed', lastErrorCode: 'driver.not-installed' });
    expect((await repairDriverRuntime('restart-bridge', config)).bridge.bridgeState).toBe('running');
    expect((await repairDriverRuntime('reinstall-driver', config)).bridge.driverHealth).toBe('running');
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('maps every desktop lifecycle action to native invoke commands', async () => {
    mocks.isTauriRuntime.mockReturnValue(true);
    mocks.invoke.mockResolvedValue({ data: runtimeSnapshotMock });
    const config = structuredClone(appConfigDraftMock);

    await refreshBridgeRuntime();
    await startBridgeServiceRuntime(config);
    await stopBridgeServiceRuntime();
    await installDriverRuntime(config);
    await uninstallDriverRuntime();
    await repairDriverRuntime('restart-bridge', config);

    expect(mocks.invoke.mock.calls).toEqual([
      ['bridge_v2', { command: { action: 'refresh' } }],
      ['bridge_v2', { command: { action: 'start', config } }],
      ['bridge_v2', { command: { action: 'stop' } }],
      ['bridge_v2', { command: { action: 'install', config } }],
      ['bridge_v2', { command: { action: 'uninstall' } }],
      ['bridge_v2', { command: { action: 'repair', repairAction: 'restart-bridge', config } }],
    ]);
  });

  it('records trace variants in the logger ring without any storage dependency', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    bridgeRuntimeTestHelpers.appendBridgeTrace('info', 'info');
    bridgeRuntimeTestHelpers.appendBridgeTrace('warning', 'warning', 'detail');
    bridgeRuntimeTestHelpers.appendBridgeTrace('error', 'error', 'detail');
    expect(info).toHaveBeenCalled();
    expect(warning).toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
    const bridgeEntries = getRecentFrontendLogEntries().filter((entry) => entry.category === 'bridge');
    expect(bridgeEntries).toHaveLength(3);
    expect(bridgeEntries.map((entry) => entry.level)).toEqual(['info', 'warning', 'error']);

    // The unified logger never touches localStorage (the legacy
    // omni.bridgeRuntimeTrace persistence was removed), so a broken storage
    // backend must not affect trace recording.
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => bridgeRuntimeTestHelpers.appendBridgeTrace('info', 'quota-safe')).not.toThrow();
    setItem.mockRestore();

    vi.stubGlobal('window', undefined);
    expect(() => bridgeRuntimeTestHelpers.appendBridgeTrace('info', 'window-free')).not.toThrow();
    vi.unstubAllGlobals();
    expect(getRecentFrontendLogEntries().map((entry) => entry.summary)).toContain('window-free');
  });

  it('creates timeout metadata and ignores late resolutions and rejections', async () => {
    const timeout = bridgeRuntimeTestHelpers.createBridgeRuntimeTimeoutError('启动', 1001, 'start');
    expect(timeout).toMatchObject({ code: 'timeout', operation: 'start', retriable: true });
    expect(timeout.message).toContain('2 秒');

    let resolveOperation: ((value: string) => void) | undefined;
    const lateResolveOperation = vi.fn(() => new Promise<string>((resolve) => {
      resolveOperation = resolve;
    }));
    const lateResolve = bridgeRuntimeTestHelpers.invokeBridgeWithTimeout(lateResolveOperation, '迟到', 20, 'late');
    const lateResolveRejection = lateResolve.catch((error) => error);
    await vi.advanceTimersByTimeAsync(20);
    await expect(lateResolveRejection).resolves.toMatchObject({ code: 'timeout' });
    resolveOperation?.('ignored');
    await Promise.resolve();

    let rejectOperation: ((reason: unknown) => void) | undefined;
    const lateRejectOperation = vi.fn(() => new Promise<string>((_resolve, reject) => {
      rejectOperation = reject;
    }));
    const lateReject = bridgeRuntimeTestHelpers.invokeBridgeWithTimeout(lateRejectOperation, '迟到', 20, 'late');
    const lateRejectRejection = lateReject.catch((error) => error);
    await vi.advanceTimersByTimeAsync(20);
    await expect(lateRejectRejection).resolves.toMatchObject({ code: 'timeout' });
    rejectOperation?.('ignored');
    await Promise.resolve();
  });

  it('propagates immediate Error and non-error native failures', async () => {
    const errorOperation = vi.fn().mockRejectedValueOnce(new Error('native error'));
    await expect(bridgeRuntimeTestHelpers.invokeBridgeWithTimeout(errorOperation, '失败', 20, 'error')).rejects.toThrow('native error');
    const stringOperation = vi.fn().mockRejectedValueOnce('native string');
    await expect(bridgeRuntimeTestHelpers.invokeBridgeWithTimeout(stringOperation, '失败', 20, 'error')).rejects.toBe('native string');
  });

  it('ignores a retained timeout callback after native resolution', async () => {
    vi.spyOn(window, 'clearTimeout').mockImplementation(() => undefined);
    const doneOperation = vi.fn().mockResolvedValueOnce('done');
    await expect(bridgeRuntimeTestHelpers.invokeBridgeWithTimeout(doneOperation, '完成', 20, 'done')).resolves.toBe('done');
    await vi.advanceTimersByTimeAsync(20);
  });
});
