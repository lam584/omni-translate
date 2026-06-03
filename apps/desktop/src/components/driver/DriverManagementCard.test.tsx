import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../i18n/config';
import i18n from '../../i18n/config';
import { appConfigDraftMock } from '../../mocks/app-config';
import { runtimeSnapshotMock } from '../../mocks/runtime-shell';
import { useAppStore } from '../../stores/app-store';
import DriverManagementCard from './DriverManagementCard';

const installDriverRuntimeMock = vi.fn();
const repairDriverRuntimeMock = vi.fn();
const uninstallDriverRuntimeMock = vi.fn();
const refreshBridgeRuntimeMock = vi.fn();
const startBridgeServiceRuntimeMock = vi.fn();

vi.mock('../../runtime/bridge-runtime', () => ({
  installDriverRuntime: (...args: unknown[]) => installDriverRuntimeMock(...args),
  repairDriverRuntime: (...args: unknown[]) => repairDriverRuntimeMock(...args),
  uninstallDriverRuntime: (...args: unknown[]) => uninstallDriverRuntimeMock(...args),
  refreshBridgeRuntime: (...args: unknown[]) => refreshBridgeRuntimeMock(...args),
  startBridgeServiceRuntime: (...args: unknown[]) => startBridgeServiceRuntimeMock(...args),
}));

function findButtonByText(container: HTMLElement, text: string) {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent?.trim() === text);
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('DriverManagementCard', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    installDriverRuntimeMock.mockReset();
    repairDriverRuntimeMock.mockReset();
    uninstallDriverRuntimeMock.mockReset();
    refreshBridgeRuntimeMock.mockReset();
    startBridgeServiceRuntimeMock.mockReset();
    await i18n.changeLanguage('zh-CN');

    useAppStore.setState((state) => ({
      ...state,
      configDraft: structuredClone(appConfigDraftMock),
      runtimeNotifications: [],
      runtimeSnapshot: structuredClone(runtimeSnapshotMock),
    }));

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it.each([
    ['not-installed', 'stopped', '驱动尚未安装', '安装驱动'],
    ['damaged', 'stopped', '驱动需要修复', '修复驱动'],
    ['running', 'stopped', 'Bridge 服务未运行', '启动桥接'],
    ['running', 'running', '驱动与桥接已就绪', '重新检测'],
  ] as const)('shows the recommended onboarding action for %s / %s', async (driverHealth, bridgeState, title, action) => {
    const snapshot = structuredClone(runtimeSnapshotMock);
    snapshot.bridge.driverHealth = driverHealth;
    snapshot.bridge.bridgeState = bridgeState;
    useAppStore.setState((state) => ({ ...state, runtimeSnapshot: snapshot }));

    await act(async () => {
      root.render(<DriverManagementCard variant="onboarding" />);
    });

    expect(container.textContent).toContain(title);
    expect(findButtonByText(container, action)).toBeDefined();
    expect(findButtonByText(container, '卸载')).toBeUndefined();
    expect(findButtonByText(container, '重新安装')).toBeUndefined();
  });

  it('keeps maintenance actions in settings mode and reveals diagnostic details on demand', async () => {
    const snapshot = structuredClone(runtimeSnapshotMock);
    snapshot.bridge.lastErrorCode = 'driver.operation-failed';
    useAppStore.setState((state) => ({ ...state, runtimeSnapshot: snapshot }));

    await act(async () => {
      root.render(<DriverManagementCard />);
    });

    expect(findButtonByText(container, '卸载')).toBeDefined();
    expect(findButtonByText(container, '重新安装')).toBeDefined();
    expect(container.textContent).not.toContain('driver.operation-failed');

    await click(findButtonByText(container, '查看高级详情')!);
    expect(container.textContent).toContain('driver.operation-failed');
    expect(container.querySelector('.driver-management-details')).not.toBeNull();
  });

  it('uses a warning after detection when the driver still needs attention', async () => {
    const snapshot = structuredClone(runtimeSnapshotMock);
    snapshot.bridge.driverHealth = 'damaged';
    snapshot.bridge.lastErrorCode = 'driver.operation-failed';
    refreshBridgeRuntimeMock.mockResolvedValue(snapshot);

    await act(async () => {
      root.render(<DriverManagementCard variant="onboarding" />);
    });

    await click(findButtonByText(container, '重新检测')!);
    expect(container.textContent).toContain('检测已完成，驱动仍需要处理。');
    expect(container.querySelector('.driver-management-feedback-warning')).not.toBeNull();
  });

  it('shows a user-facing failure while keeping the raw error out of the default view', async () => {
    refreshBridgeRuntimeMock.mockRejectedValue(new Error('driver.elevation-cancelled: UAC cancelled by user'));

    await act(async () => {
      root.render(<DriverManagementCard variant="onboarding" />);
    });

    await click(findButtonByText(container, '重新检测')!);
    expect(container.textContent).toContain('驱动操作未完成。请查看诊断摘要中的具体失败原因并按提示处理。');
    expect(container.textContent).not.toContain('driver.elevation-cancelled');
    expect(container.querySelector('.driver-management-feedback-error')).not.toBeNull();
  });

  it('surfaces WASAPI probe failures as actionable status and feedback', async () => {
    const staleSnapshot = structuredClone(runtimeSnapshotMock);
    staleSnapshot.bridge.driverHealth = 'running';
    staleSnapshot.bridge.bridgeState = 'stopped';
    staleSnapshot.bridge.lastErrorCode = null;
    useAppStore.setState((state) => ({ ...state, runtimeSnapshot: staleSnapshot }));

    const refreshedSnapshot = structuredClone(staleSnapshot);
    refreshedSnapshot.bridge.bridgeState = 'degraded';
    refreshedSnapshot.bridge.driverDetail =
      'driver.operation-failed: The WASAPI audio probe failed. ExitCode=1 Detail=idle peak 0.499969 exceeds 0.002000';
    refreshedSnapshot.bridge.lastDriverOperation = {
      schemaVersion: 1,
      operationId: 'operation-wasapi',
      action: 'install',
      succeeded: false,
      phase: 'failed',
      errorCode: 'driver.audio-probe-failed',
      summary: refreshedSnapshot.bridge.driverDetail,
      logPath: 'E:\\omni-translate\\artifacts\\diagnostics\\logs\\driver-operations\\wasapi.log',
      startedAt: '2026-06-01T00:00:00Z',
      finishedAt: '2026-06-01T00:00:01Z',
    };
    startBridgeServiceRuntimeMock.mockRejectedValue(new Error('bridge failed'));
    refreshBridgeRuntimeMock.mockResolvedValue(refreshedSnapshot);

    await act(async () => {
      root.render(<DriverManagementCard />);
    });

    await click(findButtonByText(container, '启动桥接')!);

    expect(container.textContent).toContain('虚拟扬声器音频自检失败');
    expect(container.textContent).toContain('虚拟扬声器自检失败。请重启 Windows');
    expect(container.textContent).not.toContain('驱动操作失败。请展开高级详情');

    await click(container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!);
    expect(container.textContent).toContain('驱动设备已出现，但安装自检没有捕获到预期的 1 kHz 测试音');
    expect(container.textContent).toContain('The WASAPI audio probe failed');
    expect(container.textContent).toContain('wasapi.log');
  });

  it('shows bridge degraded separately from a stopped bridge', async () => {
    const snapshot = structuredClone(runtimeSnapshotMock);
    snapshot.bridge.driverHealth = 'running';
    snapshot.bridge.bridgeState = 'degraded';
    snapshot.bridge.lastErrorCode = null;
    snapshot.bridge.driverDetail = null;
    useAppStore.setState((state) => ({ ...state, runtimeSnapshot: snapshot }));

    await act(async () => {
      root.render(<DriverManagementCard />);
    });

    expect(container.textContent).toContain('Bridge 服务异常');
    expect(container.textContent).not.toContain('Bridge 服务未运行');
  });

  it('refreshes diagnostics after a failed repair action', async () => {
    const damagedSnapshot = structuredClone(runtimeSnapshotMock);
    damagedSnapshot.bridge.driverHealth = 'damaged';
    damagedSnapshot.bridge.bridgeState = 'stopped';
    useAppStore.setState((state) => ({ ...state, runtimeSnapshot: damagedSnapshot }));

    const refreshedSnapshot = structuredClone(damagedSnapshot);
    refreshedSnapshot.bridge.lastErrorCode = 'driver.reboot-required';
    refreshedSnapshot.bridge.driverDetail = 'Root\\OmniTranslateVirtualSpeaker is present but not running. Problem=CM_PROB_FAILED_START';
    refreshedSnapshot.bridge.lastDriverOperation = {
      schemaVersion: 1,
      operationId: 'operation-reboot',
      action: 'reinstall',
      succeeded: false,
      phase: 'failed',
      errorCode: 'driver.reboot-required',
      summary: 'Problem=CM_PROB_FAILED_START',
      logPath: 'C:\\temp\\repair.log',
      startedAt: '2026-06-01T00:00:00Z',
      finishedAt: '2026-06-01T00:00:01Z',
    };
    repairDriverRuntimeMock.mockRejectedValue(new Error('driver.reboot-required: reboot first'));
    refreshBridgeRuntimeMock.mockResolvedValue(refreshedSnapshot);

    await act(async () => {
      root.render(<DriverManagementCard />);
    });

    await click(container.querySelector<HTMLButtonElement>('.driver-management-primary')!);
    await click(container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!);

    expect(refreshBridgeRuntimeMock).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('需要重启 Windows 后继续');
    expect(container.textContent).toContain('Windows 仍有待完成的驱动配置。请重启 Windows 后重新检测或重新安装。');
    expect(container.textContent).toContain('C:\\temp\\repair.log');
    expect(container.textContent).toContain('CM_PROB_FAILED_START');
    expect(container.querySelector('.driver-management-feedback-error')).not.toBeNull();
  });

  it('shows processing state while the primary install action is pending', async () => {
    const snapshot = structuredClone(runtimeSnapshotMock);
    snapshot.bridge.driverHealth = 'not-installed';
    snapshot.bridge.bridgeState = 'stopped';
    useAppStore.setState((state) => ({ ...state, runtimeSnapshot: snapshot }));
    let resolveInstall: ((value: typeof snapshot) => void) | undefined;
    installDriverRuntimeMock.mockImplementation(() => new Promise((resolve) => {
      resolveInstall = resolve;
    }));

    await act(async () => {
      root.render(<DriverManagementCard variant="onboarding" />);
    });
    await click(findButtonByText(container, '安装驱动')!);
    expect(container.textContent).toContain('处理中');

    await act(async () => {
      resolveInstall?.(snapshot);
      await Promise.resolve();
    });
  });

  it('disables duplicate detection while a driver probe is running', async () => {
    const snapshot = structuredClone(runtimeSnapshotMock);
    snapshot.bridge.driverProbeState = 'probing';
    useAppStore.setState((state) => ({ ...state, runtimeSnapshot: snapshot }));

    await act(async () => {
      root.render(<DriverManagementCard variant="onboarding" />);
    });

    expect(container.querySelector<HTMLButtonElement>('.driver-management-secondary')?.disabled).toBe(true);
  });

  it('reveals the failed driver operation log and diagnostic summary', async () => {
    const snapshot = structuredClone(runtimeSnapshotMock);
    snapshot.bridge.lastErrorCode = 'driver.operation-failed';
    snapshot.bridge.driverDetail = 'driver.operation-failed: pnputil failed';
    snapshot.bridge.lastDriverOperation = {
      schemaVersion: 1,
      operationId: 'operation-1',
      action: 'reinstall',
      succeeded: false,
      phase: 'failed',
      errorCode: 'driver.operation-failed',
      summary: 'pnputil failed',
      logPath: 'C:\\temp\\driver-operation.log',
      startedAt: '2026-06-01T00:00:00Z',
      finishedAt: '2026-06-01T00:00:01Z',
    };
    useAppStore.setState((state) => ({ ...state, runtimeSnapshot: snapshot }));

    await act(async () => {
      root.render(<DriverManagementCard variant="onboarding" />);
    });

    await click(container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!);
    expect(container.textContent).toContain('C:\\temp\\driver-operation.log');
    expect(container.textContent).toContain('driver.operation-failed: pnputil failed');
  });

  it('runs install, uninstall and reinstall maintenance actions', async () => {
    const installedSnapshot = structuredClone(runtimeSnapshotMock);
    installedSnapshot.bridge.driverHealth = 'running';
    installedSnapshot.bridge.bridgeState = 'running';
    const missingSnapshot = structuredClone(runtimeSnapshotMock);
    missingSnapshot.bridge.driverHealth = 'not-installed';
    missingSnapshot.bridge.bridgeState = 'stopped';
    installDriverRuntimeMock.mockResolvedValue(installedSnapshot);
    uninstallDriverRuntimeMock.mockResolvedValue(installedSnapshot);
    repairDriverRuntimeMock.mockResolvedValue(installedSnapshot);
    useAppStore.setState((state) => ({ ...state, runtimeSnapshot: missingSnapshot }));

    await act(async () => {
      root.render(<DriverManagementCard />);
    });
    await click(container.querySelector<HTMLButtonElement>('.driver-management-primary')!);
    expect(installDriverRuntimeMock).toHaveBeenCalledTimes(1);

    const actions = container.querySelectorAll<HTMLButtonElement>('.driver-management-actions .settings-action');
    await click(actions[1]);
    await click(actions[2]);
    expect(uninstallDriverRuntimeMock).toHaveBeenCalledTimes(1);
    expect(repairDriverRuntimeMock).toHaveBeenCalledWith('reinstall-driver', expect.any(Object));
  });

  it('starts a stopped bridge and shows secure boot details', async () => {
    const stoppedSnapshot = structuredClone(runtimeSnapshotMock);
    stoppedSnapshot.bridge.driverHealth = 'running';
    stoppedSnapshot.bridge.bridgeState = 'stopped';
    stoppedSnapshot.bridge.lastErrorCode = 'driver.secure-boot-enabled';
    stoppedSnapshot.bridge.testSigningEnabled = true;
    stoppedSnapshot.bridge.secureBootEnabled = true;
    startBridgeServiceRuntimeMock.mockResolvedValue(structuredClone(runtimeSnapshotMock));
    useAppStore.setState((state) => ({ ...state, runtimeSnapshot: stoppedSnapshot }));

    await act(async () => {
      root.render(<DriverManagementCard variant="onboarding" />);
    });
    await click(container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!);
    expect(container.textContent).toContain('driver.secure-boot-enabled');
    await click(findButtonByText(container, '启动桥接')!);
    expect(startBridgeServiceRuntimeMock).toHaveBeenCalledWith(expect.any(Object));
  });

  it('shows damaged-driver details with empty optional diagnostics and disabled secure boot', async () => {
    const snapshot = structuredClone(runtimeSnapshotMock);
    snapshot.bridge.driverHealth = 'damaged';
    snapshot.bridge.bridgeState = 'stopped';
    snapshot.bridge.lastErrorCode = null;
    snapshot.bridge.rootInstanceIds = [];
    snapshot.bridge.endpointName = null;
    snapshot.bridge.abiVersion = null;
    snapshot.bridge.testSigningEnabled = false;
    snapshot.bridge.secureBootEnabled = false;
    snapshot.bridge.driverDetail = null;
    snapshot.bridge.lastDriverOperation = {
      schemaVersion: 1,
      operationId: 'operation-2',
      action: 'reinstall',
      succeeded: false,
      phase: 'failed',
      errorCode: 'driver.operation-failed',
      summary: 'fallback summary',
      logPath: '',
      startedAt: '2026-06-01T00:00:00Z',
      finishedAt: '2026-06-01T00:00:01Z',
    };
    useAppStore.setState((state) => ({ ...state, runtimeSnapshot: snapshot }));

    await act(async () => {
      root.render(<DriverManagementCard variant="onboarding" />);
    });
    await click(container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!);

    expect(container.textContent).toContain('fallback summary');
    expect(container.textContent).toContain('未启用');
  });
});
