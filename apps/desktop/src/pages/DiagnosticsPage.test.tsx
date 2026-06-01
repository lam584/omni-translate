import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { audioRuntimeSnapshotMock } from '../mocks/audio-runtime';
import { appConfigDraftMock } from '../mocks/app-config';
import { runtimeSnapshotMock } from '../mocks/runtime-shell';
import DiagnosticsPage, { runRecommendedBridgeAction } from './DiagnosticsPage';
import { useAppStore } from '../stores/app-store';

const startAudioRouteRuntimeMock = vi.fn();
const startSpeechDispatchRuntimeMock = vi.fn();
const installDriverRuntimeMock = vi.fn();
const refreshBridgeRuntimeMock = vi.fn();
const repairDriverRuntimeMock = vi.fn();
const startBridgeServiceRuntimeMock = vi.fn();
const stopBridgeServiceRuntimeMock = vi.fn();
const uninstallDriverRuntimeMock = vi.fn();
const exportDiagnosticsBundleRuntimeMock = vi.fn();
const runDiagnosticsSelfCheckRuntimeMock = vi.fn();
const runSubtitleOverlaySelfCheckRuntimeMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => false,
}));

vi.mock('../runtime/audio-runtime', () => ({
  startAudioRouteRuntime: (...args: unknown[]) => startAudioRouteRuntimeMock(...args),
  startSpeechDispatchRuntime: (...args: unknown[]) => startSpeechDispatchRuntimeMock(...args),
}));

vi.mock('../runtime/bridge-runtime', () => ({
  installDriverRuntime: (...args: unknown[]) => installDriverRuntimeMock(...args),
  refreshBridgeRuntime: (...args: unknown[]) => refreshBridgeRuntimeMock(...args),
  repairDriverRuntime: (...args: unknown[]) => repairDriverRuntimeMock(...args),
  startBridgeServiceRuntime: (...args: unknown[]) => startBridgeServiceRuntimeMock(...args),
  stopBridgeServiceRuntime: (...args: unknown[]) => stopBridgeServiceRuntimeMock(...args),
  uninstallDriverRuntime: (...args: unknown[]) => uninstallDriverRuntimeMock(...args),
}));

vi.mock('../runtime/diagnostics-runtime', () => ({
  exportDiagnosticsBundleRuntime: (...args: unknown[]) => exportDiagnosticsBundleRuntimeMock(...args),
  runDiagnosticsSelfCheckRuntime: (...args: unknown[]) => runDiagnosticsSelfCheckRuntimeMock(...args),
  runSubtitleOverlaySelfCheckRuntime: (...args: unknown[]) => runSubtitleOverlaySelfCheckRuntimeMock(...args),
}));

vi.mock('../runtime/tauri-runtime', () => ({
  isTauriRuntime: () => false,
  hasInvokeBridge: () => false,
}));

function findButtonByText(container: HTMLElement, text: string) {
  return Array.from(container.querySelectorAll('button')).find((element) => element.textContent?.trim() === text) as
    | HTMLButtonElement
    | undefined;
}

describe('DiagnosticsPage monitoring boundary', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    startAudioRouteRuntimeMock.mockReset();
    startSpeechDispatchRuntimeMock.mockReset();
    installDriverRuntimeMock.mockReset();
    refreshBridgeRuntimeMock.mockReset();
    repairDriverRuntimeMock.mockReset();
    startBridgeServiceRuntimeMock.mockReset();
    stopBridgeServiceRuntimeMock.mockReset();
    uninstallDriverRuntimeMock.mockReset();
    exportDiagnosticsBundleRuntimeMock.mockReset();
    runDiagnosticsSelfCheckRuntimeMock.mockReset();
    runSubtitleOverlaySelfCheckRuntimeMock.mockReset();

    const configDraft = structuredClone(appConfigDraftMock);
    const runtimeSnapshot = structuredClone(runtimeSnapshotMock);
    const audioRuntimeSnapshot = structuredClone(audioRuntimeSnapshotMock);

    runtimeSnapshot.bridgeStatus = 'tauri-shell';
    runtimeSnapshot.storage.status = 'ready';
    runtimeSnapshot.bridge.bridgeState = 'stopped';
    runtimeSnapshot.bridge.driverHealth = 'running';
    runtimeSnapshot.bridge.lifecycleState = 'idle';
    runtimeSnapshot.bridge.installPhase = 'ready';
    runtimeSnapshot.windows = runtimeSnapshot.windows.map((item) =>
      item.label === 'subtitle-overlay' ? { ...item, visible: false } : item,
    );
    runtimeSnapshot.notifications = [];
    runtimeSnapshot.diagnostics.recentErrors = [];
    runtimeSnapshot.diagnostics.deviceStatus = 'ready';
    runtimeSnapshot.diagnostics.driverStatus = 'ready';

    audioRuntimeSnapshot.status = 'ready';
    audioRuntimeSnapshot.inbound.streamBound = false;
    audioRuntimeSnapshot.inbound.captureState = 'buffering';
    audioRuntimeSnapshot.outbound.streamBound = false;
    audioRuntimeSnapshot.outbound.captureState = 'armed';
    audioRuntimeSnapshot.speech.outputTarget = 'speaker';
    audioRuntimeSnapshot.speech.dispatchState = 'idle';
    audioRuntimeSnapshot.inbound.lastError = null;
    audioRuntimeSnapshot.outbound.lastError = null;
    audioRuntimeSnapshot.speech.lastError = null;

    configDraft.speech.enabled = false;
    configDraft.speech.outputTarget = 'speaker';
    configDraft.speech.virtualMicOutputEnabled = false;
    configDraft.speech.localPlaybackEnabled = true;
    configDraft.speech.status = 'warning';

    useAppStore.setState((state) => ({
      ...state,
      configDraft,
      runtimeSnapshot,
      audioRuntimeSnapshot,
      runtimeNotifications: runtimeSnapshot.notifications,
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

  it('treats idle bridge and capture as neutral monitoring state', async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <DiagnosticsPage />
        </MemoryRouter>,
      );
    });

    const autoRepairButton = findButtonByText(container, '自动修复已选项');
    expect(autoRepairButton).toBeUndefined();
    expect(container.textContent).toContain('底层运行态监控');
    expect(container.textContent).toContain('桥接服务');
    expect(container.textContent).not.toContain('桥接链路待启动');
    expect(container.textContent).not.toContain('系统音频待启动采集');
    expect(container.textContent).not.toContain('修正译音输出目标');
  });

  it('dispatches each recommended bridge action', async () => {
    const config = useAppStore.getState().configDraft;
    const snapshot = structuredClone(useAppStore.getState().runtimeSnapshot);
    installDriverRuntimeMock.mockResolvedValue(snapshot);
    repairDriverRuntimeMock.mockResolvedValue(snapshot);
    startBridgeServiceRuntimeMock.mockResolvedValue(snapshot);

    snapshot.bridge.driverHealth = 'not-installed';
    await runRecommendedBridgeAction(snapshot, config);
    expect(installDriverRuntimeMock).toHaveBeenCalledWith(config);

    snapshot.bridge.driverHealth = 'damaged';
    await runRecommendedBridgeAction(snapshot, config);
    expect(repairDriverRuntimeMock).toHaveBeenCalledWith('reinstall-driver', config);

    snapshot.bridge.driverHealth = 'running';
    snapshot.bridge.bridgeState = 'stopped';
    await runRecommendedBridgeAction(snapshot, config);
    expect(startBridgeServiceRuntimeMock).toHaveBeenCalledWith(config);

    snapshot.bridge.bridgeState = 'running';
    await runRecommendedBridgeAction(snapshot, config);
    expect(repairDriverRuntimeMock).toHaveBeenCalledWith('restart-bridge', config);
  });

  it('runs diagnostics, overlay self-check, export and refresh actions', async () => {
    const snapshot = structuredClone(useAppStore.getState().runtimeSnapshot);
    runDiagnosticsSelfCheckRuntimeMock.mockResolvedValue(snapshot);
    runSubtitleOverlaySelfCheckRuntimeMock.mockResolvedValue(snapshot);
    exportDiagnosticsBundleRuntimeMock.mockResolvedValue({ snapshot });
    refreshBridgeRuntimeMock.mockResolvedValue(snapshot);
    await act(async () => {
      root.render(
        <MemoryRouter>
          <DiagnosticsPage />
        </MemoryRouter>,
      );
    });

    for (const label of ['重新诊断', '测试字幕浮窗', '导出诊断包', '刷新运行态']) {
      await act(async () => {
        findButtonByText(container, label)?.click();
        await Promise.resolve();
      });
    }
    expect(runDiagnosticsSelfCheckRuntimeMock).toHaveBeenCalled();
    expect(runSubtitleOverlaySelfCheckRuntimeMock).toHaveBeenCalled();
    expect(exportDiagnosticsBundleRuntimeMock).toHaveBeenCalled();
    expect(refreshBridgeRuntimeMock).toHaveBeenCalled();
  });

  it('records automatic repair failures for damaged bridge state', async () => {
    const snapshot = structuredClone(useAppStore.getState().runtimeSnapshot);
    snapshot.bridge.driverHealth = 'damaged';
    snapshot.bridge.lifecycleState = 'error';
    snapshot.bridge.lastErrorCode = 'bridge.singleton-already-running';
    useAppStore.setState((state) => ({ ...state, runtimeSnapshot: snapshot }));
    repairDriverRuntimeMock.mockRejectedValue(new Error('repair failed'));
    await act(async () => {
      root.render(
        <MemoryRouter>
          <DiagnosticsPage />
        </MemoryRouter>,
      );
      await Promise.resolve();
    });
    await act(async () => {
      findButtonByText(container, '自动修复已选项')?.click();
      await Promise.resolve();
    });
    expect(repairDriverRuntimeMock).toHaveBeenCalledWith('reinstall-driver', expect.anything());
    expect(useAppStore.getState().runtimeNotifications[0]?.message).toContain('repair failed');
  });
});
