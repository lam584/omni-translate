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

describe('bridge runtime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.invoke.mockReset();
    mocks.isTauriRuntime.mockReset().mockReturnValue(false);
    window.localStorage.clear();
    Reflect.deleteProperty(window, '__OMNI_BRIDGE_RUNTIME_TRACE__');
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, '__OMNI_BRIDGE_RUNTIME_TRACE__');
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
    mocks.invoke.mockResolvedValue(runtimeSnapshotMock);
    const config = structuredClone(appConfigDraftMock);

    await refreshBridgeRuntime();
    await startBridgeServiceRuntime(config);
    await stopBridgeServiceRuntime();
    await installDriverRuntime(config);
    await uninstallDriverRuntime();
    await repairDriverRuntime('restart-bridge', config);

    expect(mocks.invoke.mock.calls).toEqual([
      ['refresh_bridge_runtime', undefined],
      ['start_bridge_service', { config }],
      ['stop_bridge_service', undefined],
      ['install_driver_runtime', { config }],
      ['uninstall_driver_runtime', undefined],
      ['repair_driver_runtime', { action: 'restart-bridge', config }],
    ]);
  });

  it('buffers trace variants and tolerates malformed or unavailable storage', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(bridgeRuntimeTestHelpers.readBridgeTrace()).toEqual([]);
    window.localStorage.setItem('omni.bridgeRuntimeTrace', '{bad json');
    expect(bridgeRuntimeTestHelpers.readBridgeTrace()).toEqual([]);
    window.localStorage.setItem('omni.bridgeRuntimeTrace', '{}');
    expect(bridgeRuntimeTestHelpers.readBridgeTrace()).toEqual([]);
    window.localStorage.setItem('omni.bridgeRuntimeTrace', '[]');
    bridgeRuntimeTestHelpers.appendBridgeTrace('info', 'info');
    bridgeRuntimeTestHelpers.appendBridgeTrace('warning', 'warning', 'detail');
    bridgeRuntimeTestHelpers.appendBridgeTrace('error', 'error', 'detail');
    expect(info).toHaveBeenCalled();
    expect(warning).toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
    expect(bridgeRuntimeTestHelpers.readBridgeTrace()).toHaveLength(3);

    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => bridgeRuntimeTestHelpers.appendBridgeTrace('info', 'quota-safe')).not.toThrow();
    setItem.mockRestore();

    vi.stubGlobal('window', undefined);
    expect(bridgeRuntimeTestHelpers.readBridgeTrace()).toEqual([]);
    expect(() => bridgeRuntimeTestHelpers.appendBridgeTrace('info', 'ignored')).not.toThrow();
  });

  it('creates timeout metadata and ignores late resolutions and rejections', async () => {
    const timeout = bridgeRuntimeTestHelpers.createBridgeRuntimeTimeoutError('启动', 1001, 'start');
    expect(timeout).toMatchObject({ code: 'timeout', operation: 'start', retriable: true });
    expect(timeout.message).toContain('2 秒');

    let resolveInvoke: ((value: string) => void) | undefined;
    mocks.invoke.mockImplementationOnce(() => new Promise<string>((resolve) => {
      resolveInvoke = resolve;
    }));
    const lateResolve = bridgeRuntimeTestHelpers.invokeBridgeWithTimeout('late-resolve', undefined, '迟到', 20, 'late');
    const lateResolveRejection = lateResolve.catch((error) => error);
    await vi.advanceTimersByTimeAsync(20);
    await expect(lateResolveRejection).resolves.toMatchObject({ code: 'timeout' });
    resolveInvoke?.('ignored');
    await Promise.resolve();

    let rejectInvoke: ((reason: unknown) => void) | undefined;
    mocks.invoke.mockImplementationOnce(() => new Promise<string>((_resolve, reject) => {
      rejectInvoke = reject;
    }));
    const lateReject = bridgeRuntimeTestHelpers.invokeBridgeWithTimeout('late-reject', undefined, '迟到', 20, 'late');
    const lateRejectRejection = lateReject.catch((error) => error);
    await vi.advanceTimersByTimeAsync(20);
    await expect(lateRejectRejection).resolves.toMatchObject({ code: 'timeout' });
    rejectInvoke?.('ignored');
    await Promise.resolve();
  });

  it('propagates immediate Error and non-error native failures', async () => {
    mocks.invoke.mockRejectedValueOnce(new Error('native error'));
    await expect(bridgeRuntimeTestHelpers.invokeBridgeWithTimeout('error', undefined, '失败', 20, 'error')).rejects.toThrow('native error');
    mocks.invoke.mockRejectedValueOnce('native string');
    await expect(bridgeRuntimeTestHelpers.invokeBridgeWithTimeout('string', undefined, '失败', 20, 'error')).rejects.toBe('native string');
  });

  it('ignores a retained timeout callback after native resolution', async () => {
    vi.spyOn(window, 'clearTimeout').mockImplementation(() => undefined);
    mocks.invoke.mockResolvedValueOnce('done');
    await expect(bridgeRuntimeTestHelpers.invokeBridgeWithTimeout('done', undefined, '完成', 20, 'done')).resolves.toBe('done');
    await vi.advanceTimersByTimeAsync(20);
  });
});
