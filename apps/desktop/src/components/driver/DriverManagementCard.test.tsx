import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../../i18n/config';
import i18n from '../../i18n/config';
import { registerDomHarness } from '../../test-utils/component-test-harness';
import { click } from '../../test-utils/dom-interactions';
import { driverRuntimeMocks, resetDriverRuntimeMocks } from '../../test-utils/driver-runtime-mock';
import {
  findButtonByText,
  makeBridgeSnapshot,
  makeFailedDriverOperation,
  seedBridgeSnapshot,
  seedDriverStoreState,
} from '../../test-utils/driver-store-fixtures';
import DriverManagementCard from './DriverManagementCard';

vi.mock('../../runtime/bridge-runtime', async () =>
  (await import('../../test-utils/driver-runtime-mock')).bridgeRuntimeMockModule());

const {
  installDriverRuntime: installDriverRuntimeMock,
  repairDriverRuntime: repairDriverRuntimeMock,
  uninstallDriverRuntime: uninstallDriverRuntimeMock,
  refreshBridgeRuntime: refreshBridgeRuntimeMock,
  startBridgeServiceRuntime: startBridgeServiceRuntimeMock,
} = driverRuntimeMocks;

describe('DriverManagementCard', () => {
  const view = registerDomHarness({
    setup: async () => {
      resetDriverRuntimeMocks();
      await i18n.changeLanguage('zh-CN');
      seedDriverStoreState();
    },
  });
  let container: HTMLDivElement;

  beforeEach(() => {
    ({ container } = view);
  });

  it.each([
    ['not-installed', 'stopped', '驱动尚未安装', '安装驱动'],
    ['damaged', 'stopped', '驱动需要修复', '修复驱动'],
    ['running', 'stopped', 'Bridge 服务未运行', '启动桥接'],
    ['running', 'running', '驱动与桥接已就绪', '重新检测'],
  ] as const)('shows the recommended onboarding action for %s / %s', async (driverHealth, bridgeState, title, action) => {
    seedBridgeSnapshot({ driverHealth, bridgeState });

    await view.render(<DriverManagementCard variant="onboarding" />);

    expect(container.textContent).toContain(title);
    expect(findButtonByText(container, action)).toBeInstanceOf(HTMLButtonElement);
    expect(findButtonByText(container, '卸载')).toBeUndefined();
    expect(findButtonByText(container, '重新安装')).toBeUndefined();
  });

  it('keeps maintenance actions in settings mode and reveals diagnostic details on demand', async () => {
    seedBridgeSnapshot({ lastErrorCode: 'driver.operation-failed' });

    await view.render(<DriverManagementCard />);

    expect(findButtonByText(container, '卸载')).toBeInstanceOf(HTMLButtonElement);
    expect(findButtonByText(container, '重新安装')).toBeInstanceOf(HTMLButtonElement);
    expect(container.textContent).not.toContain('driver.operation-failed');

    await click(findButtonByText(container, '查看高级详情')!);
    expect(container.textContent).toContain('driver.operation-failed');
    expect(container.querySelector('.driver-management-details')).not.toBeNull();
  });

  it('uses a warning after detection when the driver still needs attention', async () => {
    refreshBridgeRuntimeMock.mockResolvedValue(
      makeBridgeSnapshot({ driverHealth: 'damaged', lastErrorCode: 'driver.operation-failed' }),
    );

    await view.render(<DriverManagementCard variant="onboarding" />);

    await click(findButtonByText(container, '重新检测')!);
    expect(container.textContent).toContain('检测已完成，驱动仍需要处理。');
    expect(container.querySelector('.driver-management-feedback-warning')).not.toBeNull();
  });

  it('shows a user-facing failure while keeping the raw error out of the default view', async () => {
    refreshBridgeRuntimeMock.mockRejectedValue(new Error('driver.elevation-cancelled: UAC cancelled by user'));

    await view.render(<DriverManagementCard variant="onboarding" />);

    await click(findButtonByText(container, '重新检测')!);
    expect(container.textContent).toContain('驱动操作未完成。请查看诊断摘要中的具体失败原因并按提示处理。');
    expect(container.textContent).not.toContain('driver.elevation-cancelled');
    expect(container.querySelector('.driver-management-feedback-error')).not.toBeNull();
  });

  it('surfaces WASAPI probe failures as actionable status and feedback', async () => {
    const staleSnapshot = seedBridgeSnapshot({ driverHealth: 'running', bridgeState: 'stopped', lastErrorCode: null });

    const refreshedSnapshot = structuredClone(staleSnapshot);
    refreshedSnapshot.bridge.bridgeState = 'degraded';
    refreshedSnapshot.bridge.driverDetail =
      'driver.operation-failed: The WASAPI audio probe failed. ExitCode=1 Detail=idle peak 0.499969 exceeds 0.002000';
    refreshedSnapshot.bridge.lastDriverOperation = makeFailedDriverOperation({
      operationId: 'operation-wasapi',
      action: 'install',
      errorCode: 'driver.audio-probe-failed',
      summary: refreshedSnapshot.bridge.driverDetail,
      logPath: 'E:\\omni-translate\\artifacts\\diagnostics\\logs\\driver-operations\\wasapi.log',
    });
    startBridgeServiceRuntimeMock.mockRejectedValue(new Error('bridge failed'));
    refreshBridgeRuntimeMock.mockResolvedValue(refreshedSnapshot);

    await view.render(<DriverManagementCard />);

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
    seedBridgeSnapshot({ driverHealth: 'running', bridgeState: 'degraded', lastErrorCode: null, driverDetail: null });

    await view.render(<DriverManagementCard />);

    expect(container.textContent).toContain('Bridge 服务异常');
    expect(container.textContent).not.toContain('Bridge 服务未运行');
  });

  it('starts bridge instead of installing when device evidence exists with a stale missing-driver error', async () => {
    const snapshot = seedBridgeSnapshot({
      driverHealth: 'not-installed',
      bridgeState: 'degraded',
      lastErrorCode: 'driver.not-installed',
      rootDeviceCount: 1,
      rootInstanceIds: ['ROOT\\MEDIA\\0000'],
      endpointName: 'Speakers (Omni Translate Virtual Speaker)',
      abiVersion: '0x20260604',
      ioctlAvailable: true,
    });
    startBridgeServiceRuntimeMock.mockResolvedValue(snapshot);

    await view.render(<DriverManagementCard />);

    await click(container.querySelector<HTMLButtonElement>('.driver-management-primary')!);

    expect(startBridgeServiceRuntimeMock).toHaveBeenCalledWith(expect.any(Object));
    expect(installDriverRuntimeMock).not.toHaveBeenCalled();
  });

  it('refreshes diagnostics after a failed repair action', async () => {
    const damagedSnapshot = seedBridgeSnapshot({ driverHealth: 'damaged', bridgeState: 'stopped' });

    const refreshedSnapshot = structuredClone(damagedSnapshot);
    refreshedSnapshot.bridge.lastErrorCode = 'driver.reboot-required';
    refreshedSnapshot.bridge.driverDetail = 'Root\\OmniTranslateVirtualSpeaker is present but not running. Problem=CM_PROB_FAILED_START';
    refreshedSnapshot.bridge.lastDriverOperation = makeFailedDriverOperation({
      operationId: 'operation-reboot',
      errorCode: 'driver.reboot-required',
      summary: 'Problem=CM_PROB_FAILED_START',
      logPath: 'C:\\temp\\repair.log',
    });
    repairDriverRuntimeMock.mockRejectedValue(new Error('driver.reboot-required: reboot first'));
    refreshBridgeRuntimeMock.mockResolvedValue(refreshedSnapshot);

    await view.render(<DriverManagementCard />);

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
    const snapshot = seedBridgeSnapshot({ driverHealth: 'not-installed', bridgeState: 'stopped' });
    let resolveInstall: ((value: typeof snapshot) => void) | undefined;
    installDriverRuntimeMock.mockImplementation(() => new Promise((resolve) => {
      resolveInstall = resolve;
    }));

    await view.render(<DriverManagementCard variant="onboarding" />);
    await click(findButtonByText(container, '安装驱动')!);
    expect(container.textContent).toContain('处理中');

    await act(async () => {
      resolveInstall?.(snapshot);
      await Promise.resolve();
    });
  });

  it('disables duplicate detection while a driver probe is running', async () => {
    seedBridgeSnapshot({ driverProbeState: 'probing' });

    await view.render(<DriverManagementCard variant="onboarding" />);

    expect(container.querySelector<HTMLButtonElement>('.driver-management-secondary')?.disabled).toBe(true);
  });

  it('reveals the failed driver operation log and diagnostic summary', async () => {
    seedBridgeSnapshot({
      lastErrorCode: 'driver.operation-failed',
      driverDetail: 'driver.operation-failed: pnputil failed',
      lastDriverOperation: makeFailedDriverOperation(),
    });

    await view.render(<DriverManagementCard variant="onboarding" />);

    await click(container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!);
    expect(container.textContent).toContain('C:\\temp\\driver-operation.log');
    expect(container.textContent).toContain('driver.operation-failed: pnputil failed');
  });

  it('runs install, uninstall and reinstall maintenance actions', async () => {
    const installedSnapshot = makeBridgeSnapshot({ driverHealth: 'running', bridgeState: 'running' });
    installDriverRuntimeMock.mockResolvedValue(installedSnapshot);
    uninstallDriverRuntimeMock.mockResolvedValue(installedSnapshot);
    repairDriverRuntimeMock.mockResolvedValue(installedSnapshot);
    seedBridgeSnapshot({ driverHealth: 'not-installed', bridgeState: 'stopped' });

    await view.render(<DriverManagementCard />);
    await click(container.querySelector<HTMLButtonElement>('.driver-management-primary')!);
    expect(installDriverRuntimeMock).toHaveBeenCalledTimes(1);

    const actions = container.querySelectorAll<HTMLButtonElement>('.driver-management-actions .settings-action');
    await click(actions[1]);
    await click(actions[2]);
    expect(uninstallDriverRuntimeMock).toHaveBeenCalledTimes(1);
    expect(repairDriverRuntimeMock).toHaveBeenCalledWith('reinstall-driver', expect.any(Object));
  });

  it('starts a stopped bridge and shows secure boot details', async () => {
    seedBridgeSnapshot({
      driverHealth: 'running',
      bridgeState: 'stopped',
      lastErrorCode: 'driver.secure-boot-enabled',
      testSigningEnabled: true,
      signatureEnforcementBypassed: true,
      memoryIntegrityEnabled: true,
      secureBootEnabled: true,
    });
    startBridgeServiceRuntimeMock.mockResolvedValue(makeBridgeSnapshot());

    await view.render(<DriverManagementCard variant="onboarding" />);
    await click(container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!);
    expect(container.textContent).toContain('driver.secure-boot-enabled');
    await click(findButtonByText(container, '启动桥接')!);
    expect(startBridgeServiceRuntimeMock).toHaveBeenCalledWith(expect.any(Object));
  });

  it('shows damaged-driver details with empty optional diagnostics and disabled secure boot', async () => {
    seedBridgeSnapshot({
      driverHealth: 'damaged',
      bridgeState: 'stopped',
      lastErrorCode: null,
      rootInstanceIds: [],
      endpointName: null,
      abiVersion: null,
      testSigningEnabled: false,
      secureBootEnabled: false,
      driverDetail: null,
      lastDriverOperation: makeFailedDriverOperation({ operationId: 'operation-2', summary: 'fallback summary', logPath: '' }),
    });

    await view.render(<DriverManagementCard variant="onboarding" />);
    await click(container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!);

    expect(container.textContent).toContain('fallback summary');
    expect(container.textContent).toContain('未启用');
  });
});
