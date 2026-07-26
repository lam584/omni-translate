import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { audioRuntimeSnapshotMock } from '../mocks/audio-runtime';
import { appConfigDraftMock } from '../mocks/app-config';
import { runtimeSnapshotMock } from '../mocks/runtime-shell';
import DiagnosticsPage, { runRecommendedBridgeAction } from './DiagnosticsPage';
import { useAppStore } from '../stores/app-store';
import { mountTestRoot, type TestRootHandle } from '../test-utils';
import type { BenchmarkReport } from '../runtime/benchmark-runtime';
import { DiagnosticsReportExporter } from './diagnostics/DiagnosticsDetails';

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
const runModelBenchmarkMock = vi.fn();
const readProviderSecretMock = vi.fn();
const getLiveSessionEventsRuntimeMock = vi.fn();
const tauriRuntimeMock = vi.hoisted(() => ({
  isRuntime: false,
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => tauriRuntimeMock.invoke(...args),
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

vi.mock('../runtime/benchmark-runtime', () => ({
  runModelBenchmark: (...args: unknown[]) => runModelBenchmarkMock(...args),
}));

vi.mock('../runtime/provider-runtime', () => ({
  readProviderSecret: (...args: unknown[]) => readProviderSecretMock(...args),
}));

vi.mock('../runtime/live-session-events-runtime', () => ({
  getLiveSessionEventsRuntime: (...args: unknown[]) => getLiveSessionEventsRuntimeMock(...args),
}));

vi.mock('../runtime/tauri-runtime', () => ({
  isTauriRuntime: () => tauriRuntimeMock.isRuntime,
  hasInvokeBridge: () => false,
}));

function findButtonByText(container: HTMLElement, text: string) {
  return Array.from(container.querySelectorAll('button')).find((element) => element.textContent?.trim() === text) as
    | HTMLButtonElement
    | undefined;
}

async function changeValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const valueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;

  await act(async () => {
    valueSetter?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function benchmarkReport(text: string): BenchmarkReport {
  return {
    model: 'qwen3.5-omni-plus-realtime',
    audioFile: 'sample.mp3',
    audioDurationSecs: 3,
    runs: [{
      runIndex: 0,
      model: 'qwen3.5-omni-plus-realtime',
      connectMs: 10,
      sessionReadyMs: 20,
      audioSendMs: 100,
      audioChunksSent: 2,
      audioDurationSecs: 3,
      firstAsrMs: null,
      asrDeltas: [],
      asrFinal: '',
      firstOutputMs: 150,
      firstCommittedMs: null,
      outputDeltas: [{
        elapsedMs: 150,
        eventType: 'response.text.delta',
        stash: text,
        committedText: '',
        rawText: text,
      }],
      translationFinal: text,
      responseCreatedMs: 120,
      responseDoneMs: null,
      responseDoneAudioChunksSent: null,
      responseDoneAudioSentSecs: null,
      responseCount: 0,
      speechStartedMs: null,
      speechStoppedMs: null,
      timeToFirstTokenMs: 150,
      timeToFirstCommittedMs: null,
      totalOutputDurationMs: null,
      outputDeltaCount: 1,
    }],
    summary: {
      runCount: 1,
      successfulRuns: 0,
      avgConnectMs: 10,
      avgSessionReadyMs: 20,
      avgTimeToFirstTokenMs: null,
      avgTimeToFirstCommittedMs: null,
      avgOutputDeltaIntervalMs: null,
      avgOutputDeltasPerRun: 1,
      avgTotalOutputDurationMs: null,
      p50DeltaIntervalMs: null,
      p90DeltaIntervalMs: null,
      p99DeltaIntervalMs: null,
      minDeltaIntervalMs: null,
      maxDeltaIntervalMs: null,
    },
  };
}

describe('DiagnosticsPage monitoring boundary', () => {
  let view: TestRootHandle;
  let container: HTMLDivElement;

  async function renderPage() {
    await view.render(
      <MemoryRouter>
        <DiagnosticsPage />
      </MemoryRouter>,
    );
  }

  async function renderPageAndFlush() {
    await act(async () => {
      view.root.render(
        <MemoryRouter>
          <DiagnosticsPage />
        </MemoryRouter>,
      );
      await Promise.resolve();
    });
  }

  beforeEach(() => {
    tauriRuntimeMock.isRuntime = false;
    tauriRuntimeMock.invoke.mockReset();
    tauriRuntimeMock.invoke.mockImplementation(async (command: string) => {
      if (command === 'get_runtime_snapshot' || command === 'bootstrap_runtime') {
        return structuredClone(useAppStore.getState().runtimeSnapshot);
      }
      return undefined;
    });
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
    runModelBenchmarkMock.mockReset();
    readProviderSecretMock.mockReset();
    readProviderSecretMock.mockResolvedValue({ secret: 'test-key' });
    getLiveSessionEventsRuntimeMock.mockReset();
    getLiveSessionEventsRuntimeMock.mockResolvedValue({
      sessionStartedAt: '',
      elapsedMs: 0,
      model: '',
      asrDeltas: [],
      outputDeltas: [],
      asrFinal: '',
      translationFinal: '',
    });

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

    view = mountTestRoot();
    ({ container } = view);
  });

  afterEach(async () => {
    await view.cleanup();
  });

  it('treats idle bridge and capture as neutral monitoring state', async () => {
    await renderPage();

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
    await renderPage();

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
    useAppStore.setState((state) => ({
      ...state,
      runtimeSnapshot: snapshot,
      configDraft: {
        ...state.configDraft,
        devices: { ...state.configDraft.devices, routeMode: 'watch', feedbackLoopPrevention: 'virtual-driver' },
      },
    }));
    repairDriverRuntimeMock.mockRejectedValue(new Error('repair failed'));
    await renderPageAndFlush();
    await act(async () => {
      findButtonByText(container, '自动修复已选项')?.click();
      await Promise.resolve();
    });
    expect(repairDriverRuntimeMock).toHaveBeenCalledWith('reinstall-driver', expect.anything());
    expect(useAppStore.getState().runtimeNotifications[0]?.message).toContain('repair failed');
  });

  it('opens benchmark results immediately and streams progress into the modal', async () => {
    const partialReport = benchmarkReport('实时');
    const finalReport = benchmarkReport('实时结果');
    runModelBenchmarkMock.mockImplementation(async (_model, _secret, _path, options) => {
      options.onProgress({
        runId: 'test-run',
        status: 'running',
        phase: 'output-delta',
        message: '收到模型输出 delta',
        report: partialReport,
        error: null,
        audioChunksSent: 2,
        totalAudioChunks: 10,
      });
      return finalReport;
    });

    await renderPage();

    await act(async () => {
      findButtonByText(container, '开始基准测试')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(readProviderSecretMock).toHaveBeenCalled();
    expect(runModelBenchmarkMock).toHaveBeenCalled();
    expect(runModelBenchmarkMock.mock.calls[0]?.[3]).toMatchObject({ realtimeAudioMode: 'manual' });
    expect(container.textContent).toContain('基准测试结果');
    expect(container.textContent).toContain('收到模型输出 delta');
    expect(container.textContent).toContain('实时结果');
  });

  it('keeps the latest benchmark stream data visible when the run fails', async () => {
    const partialReport = benchmarkReport('部分输出');
    runModelBenchmarkMock.mockImplementation(async (_model, _secret, _path, options) => {
      options.onProgress({
        runId: 'test-run',
        status: 'running',
        phase: 'output-delta',
        message: '收到模型输出 delta',
        report: partialReport,
        error: null,
        audioChunksSent: 3,
        totalAudioChunks: 10,
      });
      throw new Error('network failed');
    });

    await renderPage();

    await act(async () => {
      findButtonByText(container, '开始基准测试')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('network failed');
    expect(container.textContent).toContain('部分输出');
  });

  it('shows the newest benchmark output and ASR events first', async () => {
    const report = benchmarkReport('第三段');
    const run = report.runs[0]!;
    run.firstAsrMs = 80;
    run.asrFinal = '第三句';
    run.asrDeltas = [
      { elapsedMs: 80, stash: '第一句', text: '第一句' },
      { elapsedMs: 120, stash: '第二句', text: '第二句' },
      { elapsedMs: 160, stash: '第三句', text: '第三句' },
    ];
    run.outputDeltas = [
      { elapsedMs: 150, eventType: 'response.text.delta', stash: '第一段', committedText: '', rawText: '第一段' },
      { elapsedMs: 210, eventType: 'response.text.delta', stash: '第二段', committedText: '', rawText: '第二段' },
      { elapsedMs: 270, eventType: 'response.text.delta', stash: '第三段', committedText: '', rawText: '第三段' },
    ];
    run.outputDeltaCount = run.outputDeltas.length;
    report.summary.avgOutputDeltasPerRun = run.outputDeltas.length;
    run.translationFinal = '第一段第二段第三段';

    runModelBenchmarkMock.mockResolvedValue(report);

    await renderPage();

    await act(async () => {
      findButtonByText(container, '开始基准测试')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const eventTables = Array.from(container.querySelectorAll('.benchmark-section'))
      .filter((section) => section.querySelector('h4')?.textContent?.includes('事件明细'))
      .map((section) => Array.from(section.querySelectorAll('tbody tr')));

    expect(eventTables).toHaveLength(2);
    expect(eventTables[0]![0]?.textContent).toContain('第三段');
    expect(eventTables[0]![0]?.querySelector('.benchmark-delta-idx')?.textContent).toBe('3');
    expect(eventTables[1]![0]?.textContent).toContain('第三句');
    expect(eventTables[1]![0]?.querySelector('.benchmark-delta-idx')?.textContent).toBe('3');
  });
  it('renders audio transcript events as benchmark output', async () => {
    const report = benchmarkReport('complete translated output from audio transcript');
    const run = report.runs[0]!;
    run.audioDurationSecs = 30;
    report.audioDurationSecs = 30;
    run.asrFinal = 'source speech transcript';
    run.outputDeltas = [
      {
        elapsedMs: 100,
        eventType: 'response.audio_transcript.delta',
        stash: 'complete translated',
        committedText: '',
        rawText: 'complete translated',
      },
      {
        elapsedMs: 200,
        eventType: 'response.audio_transcript.done',
        stash: '',
        committedText: 'complete translated output from audio transcript',
        rawText: 'complete translated output from audio transcript',
      },
    ];
    run.outputDeltaCount = run.outputDeltas.length;
    run.firstOutputMs = 100;
    run.firstCommittedMs = 200;
    run.responseDoneMs = 210;
    run.translationFinal = 'complete translated output from audio transcript';
    report.summary.avgOutputDeltasPerRun = run.outputDeltas.length;
    runModelBenchmarkMock.mockResolvedValue(report);

    await renderPage();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('.diagnostics-benchmark-panel .diagnostics-primary-action')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('.benchmark-translation')?.textContent).toContain('complete translated output');
    expect(container.querySelectorAll('.benchmark-warning')).toHaveLength(1);
    expect(container.textContent).toContain('audio_transcript.done');
  });

  it('validates benchmark model and MP3 inputs before running', async () => {
    const state = useAppStore.getState();
    useAppStore.setState({
      ...state,
      configDraft: {
        ...state.configDraft,
        providers: state.configDraft.providers.map((provider) => ({
          ...provider,
          sceneModelAssignments: [],
          modelCatalogCache: { ...provider.modelCatalogCache, models: [] },
        })),
      },
    });

    await renderPage();

    expect(container.querySelector<HTMLSelectElement>('.diagnostics-benchmark-select')?.disabled).toBe(true);
    expect(container.textContent).toContain('未配置语音模型');
    expect(container.querySelector<HTMLButtonElement>('.diagnostics-benchmark-panel .diagnostics-primary-action')?.disabled).toBe(true);

    const nextState = useAppStore.getState();
    const provider = structuredClone(appConfigDraftMock.providers[0]);
    provider.sceneModelAssignments = [{ scenario: 'watch', modelIds: ['live-model'] }];
    provider.modelCatalogCache = { ...provider.modelCatalogCache, models: [] };
    useAppStore.setState({
      ...nextState,
      configDraft: {
        ...nextState.configDraft,
        providers: [provider],
      },
    });
    await renderPageAndFlush();

    await changeValue(container.querySelector<HTMLInputElement>('.diagnostics-benchmark-input')!, '   ');
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.diagnostics-benchmark-panel .diagnostics-primary-action')?.click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('请输入 MP3 文件路径');
    expect(runModelBenchmarkMock).not.toHaveBeenCalled();
  });

  it('updates benchmark model selection and reports missing provider secrets', async () => {
    const state = useAppStore.getState();
    const provider = structuredClone(state.configDraft.providers[0]);
    provider.sceneModelAssignments = [
      { scenario: 'watch', modelIds: ['first-live', 'second-live'] },
      { scenario: 'game', modelIds: [] },
      { scenario: 'voice-room', modelIds: [] },
      { scenario: 'subtitle-translate', modelIds: [] },
    ];
    useAppStore.setState({
      ...state,
      configDraft: {
        ...state.configDraft,
        providers: [provider],
      },
    });
    readProviderSecretMock.mockResolvedValueOnce({ secret: '' });

    await renderPageAndFlush();

    const select = container.querySelector<HTMLSelectElement>('.diagnostics-benchmark-select')!;
    expect(select.options.length).toBe(2);
    await changeValue(select, 'second-live');
    await changeValue(container.querySelector<HTMLInputElement>('.diagnostics-benchmark-input')!, 'E:\\audio\\sample.mp3');
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.diagnostics-benchmark-panel .diagnostics-primary-action')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(readProviderSecretMock).toHaveBeenCalled();
    expect(runModelBenchmarkMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain('未找到模型 second-live 的 API Key');
  });

  it('closes benchmark result modal from the close button and backdrop', async () => {
    runModelBenchmarkMock.mockResolvedValue(benchmarkReport('modal result'));

    await renderPage();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.diagnostics-benchmark-panel .diagnostics-primary-action')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('.benchmark-modal')).not.toBeNull();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.benchmark-modal-head > div > .icon-button:last-child')?.click();
    });
    expect(container.querySelector('.benchmark-modal')).toBeNull();

    await act(async () => {
      Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent?.includes('查看结果'))?.click();
    });
    expect(container.querySelector('.benchmark-modal')).not.toBeNull();
    await act(async () => {
      container.querySelector<HTMLElement>('.modal-backdrop--benchmark')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.querySelector('.benchmark-modal')).toBeNull();
  });

  it('toggles repair selections and skips automatic repair when none are selected', async () => {
    const snapshot = structuredClone(useAppStore.getState().runtimeSnapshot);
    snapshot.bridge.driverHealth = 'damaged';
    snapshot.bridge.lifecycleState = 'error';
    snapshot.bridge.lastErrorCode = 'bridge.singleton-already-running';
    useAppStore.setState((state) => ({
      ...state,
      runtimeSnapshot: snapshot,
      configDraft: {
        ...state.configDraft,
        devices: { ...state.configDraft.devices, routeMode: 'watch', feedbackLoopPrevention: 'virtual-driver' },
      },
    }));

    await renderPageAndFlush();

    const repairInputs = Array.from(container.querySelectorAll<HTMLInputElement>('.repair-task-list input[type="checkbox"]'));
    expect(repairInputs.length).toBeGreaterThan(1);
    await act(async () => {
      repairInputs[0]!.click();
      await Promise.resolve();
    });
    expect(findButtonByText(container, '自动修复已选项')?.disabled).toBe(true);

    await act(async () => {
      findButtonByText(container, '自动修复已选项')?.click();
      await Promise.resolve();
    });
    expect(repairDriverRuntimeMock).not.toHaveBeenCalled();

    await act(async () => {
      repairInputs[1]!.click();
      await Promise.resolve();
    });
    expect(findButtonByText(container, '自动修复已选项')?.disabled).toBe(false);
  });

  it('runs runtime-error repair and refreshes after successful Tauri repairs', async () => {
    tauriRuntimeMock.isRuntime = true;
    const snapshot = structuredClone(useAppStore.getState().runtimeSnapshot);
    snapshot.bridgeStatus = 'runtime-error';
    snapshot.bridge.driverHealth = 'running';
    snapshot.bridge.bridgeState = 'running';
    const refreshed = { ...snapshot, bridgeStatus: 'tauri-shell' };
    refreshBridgeRuntimeMock.mockResolvedValue(refreshed);
    tauriRuntimeMock.invoke.mockImplementation(async (command: string) => {
      if (command === 'get_runtime_snapshot' || command === 'bootstrap_runtime') return refreshed;
      return undefined;
    });
    useAppStore.setState((state) => ({ ...state, runtimeSnapshot: snapshot }));

    await renderPageAndFlush();

    await act(async () => {
      findButtonByText(container, '自动修复已选项')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(tauriRuntimeMock.invoke).toHaveBeenCalledWith('bootstrap_runtime');
    expect(tauriRuntimeMock.invoke).toHaveBeenCalledWith('bootstrap_storage');
    expect(tauriRuntimeMock.invoke).toHaveBeenCalledWith('get_runtime_snapshot');
    expect(useAppStore.getState().runtimeNotifications[0]?.level).toBe('info');
  });

  it('shows the original runtime error in the current issue card without repeating it in the conclusion', async () => {
    tauriRuntimeMock.isRuntime = true;
    const snapshot = structuredClone(useAppStore.getState().runtimeSnapshot);
    snapshot.bridgeStatus = 'runtime-error';
    snapshot.notifications = [{
      id: 'runtime-bootstrap-failed',
      level: 'error',
      source: 'desktop-runtime',
      message: "Rust Core 启动桥接失败：invoke 'debug_ipc_ping' 超时（750ms）",
      emittedAt: new Date().toISOString(),
    }];
    useAppStore.setState((state) => ({ ...state, runtimeSnapshot: snapshot }));

    await renderPageAndFlush();

    expect(container.querySelector('.diagnostics-primary-issue')?.textContent).toContain(
      "Rust Core 启动桥接失败：invoke 'debug_ipc_ping' 超时（750ms）",
    );
    expect(container.querySelector('.diagnostics-health-summary')?.textContent).not.toContain('Rust Core 启动桥接失败');
  });

  it('hides live events button when no session is active', async () => {
    await renderPage();

    expect(findButtonByText(container, '查看实时事件')).toBeUndefined();
  });

  it('shows live events for an outbound-only conversation session', async () => {
    const audio = structuredClone(audioRuntimeSnapshotMock);
    audio.sessionStartedAt = 'unix-ms:1000';
    audio.inbound.streamBound = false;
    audio.outbound.streamBound = true;
    useAppStore.setState((state) => ({ ...state, audioRuntimeSnapshot: audio }));

    await renderPage();

    expect(findButtonByText(container, '查看实时事件')).toBeDefined();
  });

  it('shows live events button when session is active and opens modal on click', async () => {
    const audio = structuredClone(audioRuntimeSnapshotMock);
    audio.sessionStartedAt = 'unix-ms:1000';
    audio.inbound.streamBound = true;
    useAppStore.setState((state) => ({ ...state, audioRuntimeSnapshot: audio }));

    getLiveSessionEventsRuntimeMock.mockResolvedValue({
      sessionStartedAt: 'unix-ms:1000',
      elapsedMs: 5000,
      model: 'qwen3.5-omni-plus-realtime',
      asrDeltas: [
        { elapsedMs: 100, stash: '你好', text: '', eventType: 'conversation.item.input_audio_transcription.delta' },
        { elapsedMs: 200, stash: '', text: '你好世界', eventType: 'conversation.item.input_audio_transcription.completed' },
      ],
      outputDeltas: [
        { elapsedMs: 300, eventType: 'response.audio_transcript.delta', stash: 'Hello', committedText: '' },
        { elapsedMs: 500, eventType: 'response.done', stash: '', committedText: '' },
      ],
      asrFinal: '你好世界',
      translationFinal: 'Hello world',
    });

    await renderPage();

    const liveButton = findButtonByText(container, '查看实时事件');
    expect(liveButton).toBeDefined();

    await act(async () => {
      liveButton!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getLiveSessionEventsRuntimeMock).toHaveBeenCalled();
    expect(container.querySelector('.benchmark-modal')).not.toBeNull();
    expect(container.textContent).toContain('实时事件明细');
    expect(container.textContent).toContain('qwen3.5-omni-plus-realtime');
    expect(container.textContent).toContain('ASR 事件明细');
    expect(container.textContent).toContain('输出事件明细');
    expect(container.textContent).toContain('你好世界');
  });

  it('closes live events modal from close button and backdrop', async () => {
    const audio = structuredClone(audioRuntimeSnapshotMock);
    audio.sessionStartedAt = 'unix-ms:2000';
    audio.inbound.streamBound = true;
    useAppStore.setState((state) => ({ ...state, audioRuntimeSnapshot: audio }));

    await renderPage();

    await act(async () => {
      findButtonByText(container, '查看实时事件')!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('.benchmark-modal')).not.toBeNull();

    // Close via close button (second icon-button in modal head)
    const modalHead = container.querySelector('.benchmark-modal-head')!;
    const closeButtons = modalHead.querySelectorAll('.icon-button');
    await act(async () => {
      closeButtons[closeButtons.length - 1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.querySelector('.benchmark-modal')).toBeNull();

    // Reopen and close via backdrop
    await act(async () => {
      findButtonByText(container, '查看实时事件')!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector('.benchmark-modal')).not.toBeNull();
    await act(async () => {
      container.querySelector<HTMLElement>('.modal-backdrop--benchmark')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.querySelector('.benchmark-modal')).toBeNull();
  });

  it('shows empty state when live events have no data', async () => {
    const audio = structuredClone(audioRuntimeSnapshotMock);
    audio.sessionStartedAt = 'unix-ms:3000';
    audio.inbound.streamBound = true;
    useAppStore.setState((state) => ({ ...state, audioRuntimeSnapshot: audio }));

    getLiveSessionEventsRuntimeMock.mockResolvedValue({
      sessionStartedAt: 'unix-ms:3000',
      elapsedMs: 1000,
      model: 'test-model',
      asrDeltas: [],
      outputDeltas: [],
      asrFinal: '',
      translationFinal: '',
    });

    await renderPage();

    await act(async () => {
      findButtonByText(container, '查看实时事件')!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('.benchmark-modal')).not.toBeNull();
    expect(container.textContent).toContain('暂无事件数据');
  });

  it('refreshes live events when refresh button is clicked', async () => {
    const audio = structuredClone(audioRuntimeSnapshotMock);
    audio.sessionStartedAt = 'unix-ms:4000';
    audio.inbound.streamBound = true;
    useAppStore.setState((state) => ({ ...state, audioRuntimeSnapshot: audio }));

    getLiveSessionEventsRuntimeMock.mockResolvedValue({
      sessionStartedAt: 'unix-ms:4000',
      elapsedMs: 2000,
      model: 'refresh-model',
      asrDeltas: [{ elapsedMs: 100, stash: '', text: 'first', eventType: 'asr' }],
      outputDeltas: [],
      asrFinal: 'first',
      translationFinal: '',
    });

    await renderPage();

    await act(async () => {
      findButtonByText(container, '查看实时事件')!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getLiveSessionEventsRuntimeMock).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('first');

    // Update mock to return new data
    getLiveSessionEventsRuntimeMock.mockResolvedValue({
      sessionStartedAt: 'unix-ms:4000',
      elapsedMs: 5000,
      model: 'refresh-model',
      asrDeltas: [
        { elapsedMs: 100, stash: '', text: 'first', eventType: 'asr' },
        { elapsedMs: 300, stash: '', text: 'second', eventType: 'asr' },
      ],
      outputDeltas: [],
      asrFinal: 'second',
      translationFinal: '',
    });

    // Click refresh button (the refresh icon-button in the modal head)
    const modalHead = container.querySelector('.benchmark-modal-head')!;
    const refreshButton = modalHead.querySelectorAll<HTMLButtonElement>('.icon-button')[1];
    await act(async () => {
      refreshButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getLiveSessionEventsRuntimeMock).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('second');
  });

  it('runs the empty-state self-check action', async () => {
    runDiagnosticsSelfCheckRuntimeMock.mockResolvedValue(structuredClone(useAppStore.getState().runtimeSnapshot));
    await renderPage();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('.diagnostics-empty-actions .icon-button')?.click();
      await Promise.resolve();
    });

    expect(runDiagnosticsSelfCheckRuntimeMock).toHaveBeenCalled();
  });

  it('exercises both select-all directions and individual repair deselection', async () => {
    const damaged = structuredClone(useAppStore.getState().runtimeSnapshot);
    damaged.bridgeStatus = 'runtime-error';
    damaged.bridge.driverHealth = 'damaged';
    damaged.bridge.lifecycleState = 'error';
    useAppStore.setState((state) => ({
      ...state,
      runtimeSnapshot: damaged,
      configDraft: {
        ...state.configDraft,
        devices: { ...state.configDraft.devices, routeMode: 'watch', feedbackLoopPrevention: 'virtual-driver' },
      },
    }));
    await renderPageAndFlush();
    const inputs = Array.from(container.querySelectorAll<HTMLInputElement>('.repair-task-list input'));

    await act(async () => inputs[0]?.click());
    await act(async () => inputs[0]?.click());
    await act(async () => inputs[1]?.click());

    expect(inputs.length).toBeGreaterThan(1);
  });

  it('publishes a successful bridge repair snapshot', async () => {
    tauriRuntimeMock.isRuntime = true;
    const damaged = structuredClone(useAppStore.getState().runtimeSnapshot);
    damaged.bridge.driverHealth = 'damaged';
    damaged.bridge.lifecycleState = 'error';
    damaged.bridge.lastErrorCode = 'bridge.singleton-already-running';
    const repaired = structuredClone(damaged);
    repaired.bridge.driverHealth = 'running';
    repaired.bridge.bridgeState = 'running';
    repairDriverRuntimeMock.mockResolvedValue(repaired);
    refreshBridgeRuntimeMock.mockResolvedValue(repaired);
    useAppStore.setState((state) => ({
      ...state,
      runtimeSnapshot: damaged,
      configDraft: {
        ...state.configDraft,
        devices: { ...state.configDraft.devices, routeMode: 'watch', feedbackLoopPrevention: 'virtual-driver' },
      },
    }));
    await renderPageAndFlush();

    await act(async () => {
      await Promise.resolve();
      const repairButton = container.querySelector<HTMLButtonElement>('.control-toolbar .icon-button');
      expect(repairButton).not.toBeNull();
      expect(repairButton?.disabled).toBe(false);
      repairButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(repairDriverRuntimeMock).toHaveBeenCalled();
    expect(useAppStore.getState().runtimeSnapshot.bridge.driverHealth).toBe('running');
  });

  it('exports benchmark and live-event reports through both formats', async () => {
    const benchmarkExport = vi.spyOn(DiagnosticsReportExporter, 'exportBenchmark').mockImplementation(() => undefined);
    const liveExport = vi.spyOn(DiagnosticsReportExporter, 'exportLiveEvents').mockImplementation(() => undefined);
    runModelBenchmarkMock.mockResolvedValue(benchmarkReport('export result'));
    const audio = structuredClone(audioRuntimeSnapshotMock);
    audio.sessionStartedAt = 'unix-ms:5000';
    audio.inbound.streamBound = true;
    useAppStore.setState((state) => ({ ...state, audioRuntimeSnapshot: audio }));
    getLiveSessionEventsRuntimeMock.mockResolvedValue({
      sessionStartedAt: 'unix-ms:5000', elapsedMs: 1000, model: 'live-model',
      asrDeltas: [], outputDeltas: [], asrFinal: '', translationFinal: '',
    });
    await renderPage();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('.diagnostics-benchmark-panel .diagnostics-primary-action')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    for (const format of ['JSON', 'TXT']) {
      await act(async () => container.querySelector<HTMLButtonElement>('.benchmark-modal-head .icon-button')?.click());
      await act(async () => Array.from(container.querySelectorAll<HTMLButtonElement>('.benchmark-modal-head button'))
        .find((button) => button.textContent === format)?.click());
    }
    expect(benchmarkExport).toHaveBeenCalledTimes(2);

    await act(async () => container.querySelectorAll<HTMLButtonElement>('.benchmark-modal-head .icon-button')[1]?.click());
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.diagnostics-live-events-button')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    for (const format of ['JSON', 'TXT']) {
      await act(async () => container.querySelector<HTMLButtonElement>('.benchmark-modal-head .icon-button')?.click());
      await act(async () => Array.from(container.querySelectorAll<HTMLButtonElement>('.benchmark-modal-head button'))
        .find((button) => button.textContent === format)?.click());
    }
    expect(liveExport).toHaveBeenCalledTimes(2);
  });

  it('renders recent diagnostic issues without routes and safely ignores export before live events arrive', async () => {
    const runtime = structuredClone(useAppStore.getState().runtimeSnapshot);
    runtime.diagnostics.recentErrors = [{
      id: 'local-warning', category: 'runtime', level: 'warning', summary: 'local warning', detail: null, emittedAt: 'test',
    }];
    const audio = structuredClone(useAppStore.getState().audioRuntimeSnapshot);
    audio.sessionStartedAt = 'unix-ms:5000';
    audio.sttConnected = true;
    useAppStore.setState((state) => ({ ...state, runtimeSnapshot: runtime, audioRuntimeSnapshot: audio }));
    getLiveSessionEventsRuntimeMock.mockImplementation(() => new Promise(() => undefined));

    await renderPage();
    expect(Array.from(container.querySelectorAll('.compact-alert-item')).some((item) =>
      item.tagName === 'DIV' && item.textContent?.includes('local warning'))).toBe(true);

    await act(async () => container.querySelector<HTMLButtonElement>('.diagnostics-live-events-button')?.click());
    expect(container.querySelector('.benchmark-modal')).not.toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('.benchmark-modal-head .icon-button')?.click());
    await act(async () => Array.from(container.querySelectorAll<HTMLButtonElement>('.benchmark-modal-head button'))
      .find((button) => button.textContent === 'JSON')?.click());
  });

  it('normalizes sparse provider metadata, draft diagnostics, speech defaults, and speech-only live sessions', async () => {
    const configDraft = structuredClone(useAppStore.getState().configDraft);
    const baseProvider = configDraft.providers[0]!;
    configDraft.providers = [
      { ...baseProvider, authRef: undefined as never, localModelCapabilityRegistry: undefined as never,
        sceneModelAssignments: [{ scenario: 'watch', modelIds: ['plain-model', 'scope::', 'scope::api', 'plain-model'] }] },
      { ...baseProvider, templateId: 'sparse-provider', sceneModelAssignments: undefined as never },
    ];
    configDraft.speech.localPlaybackEnabled = undefined as never;
    configDraft.speech.virtualMicOutputEnabled = undefined as never;
    const runtime = structuredClone(runtimeSnapshotMock);
    runtime.diagnostics.recentErrors = [{ id: 'draft-warning', category: 'runtime', level: 'warning', summary: 'draft warning', detail: null, emittedAt: 'test' }];
    const audio = structuredClone(useAppStore.getState().audioRuntimeSnapshot);
    audio.sessionStartedAt = 'unix-ms:5000';
    audio.inbound.streamBound = false;
    audio.outbound.streamBound = false;
    audio.sttConnected = false;
    audio.speech.dispatchState = 'playing';
    useAppStore.setState((state) => ({ ...state, configDraft, runtimeSnapshot: runtime, audioRuntimeSnapshot: audio }));

    await renderPage();
    expect(container.textContent).toContain('draft warning');
    expect(container.querySelector('.diagnostics-live-events-button')).not.toBeNull();
  });

  it('renders sparse benchmark summaries and exports unknown-model live events', async () => {
    const report = benchmarkReport('sparse');
    report.audioDurationSecs = undefined as never;
    report.runs = [];
    runModelBenchmarkMock.mockResolvedValue(report);
    const liveExport = vi.spyOn(DiagnosticsReportExporter, 'exportLiveEvents').mockImplementation(() => undefined);
    const audio = structuredClone(useAppStore.getState().audioRuntimeSnapshot);
    audio.sessionStartedAt = 'unix-ms:5000';
    audio.inbound.streamBound = true;
    useAppStore.setState((state) => ({ ...state, audioRuntimeSnapshot: audio }));
    getLiveSessionEventsRuntimeMock.mockResolvedValue({ sessionStartedAt: 'unix-ms:5000', elapsedMs: 0, model: '', asrDeltas: [], outputDeltas: [], asrFinal: '', translationFinal: '' });
    await renderPage();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.diagnostics-benchmark-panel .diagnostics-primary-action')?.click();
      await Promise.resolve(); await Promise.resolve();
    });
    expect(container.querySelector('.benchmark-modal')).not.toBeNull();
    await act(async () => container.querySelectorAll<HTMLButtonElement>('.benchmark-modal-head .icon-button')[1]?.click());
    await act(async () => { container.querySelector<HTMLButtonElement>('.diagnostics-live-events-button')?.click(); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => container.querySelector<HTMLButtonElement>('.benchmark-modal-head .icon-button')?.click());
    await act(async () => Array.from(container.querySelectorAll<HTMLButtonElement>('.benchmark-modal-head button')).find((button) => button.textContent === 'JSON')?.click());
    expect(liveExport).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('live-events-unknown-'), 'json');
  });
});
