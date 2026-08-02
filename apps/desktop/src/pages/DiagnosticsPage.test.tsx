import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { audioRuntimeSnapshotMock } from '../mocks/audio-runtime';
import { appConfigDraftMock } from '../mocks/app-config';
import { runtimeSnapshotMock } from '../mocks/runtime-shell';
import { createFakeBridge, type FakeBridge } from '../mocks/fake-bridge';
import DiagnosticsPage, { runRecommendedBridgeAction } from './DiagnosticsPage';
import { installDesktopApi, resetDesktopApiForTests, TauriDesktopApi } from '../runtime/desktop-api';
import { PreviewDesktopApi } from '../runtime/preview-desktop-api';
import { loggerTestHelpers } from '../runtime/logger';
import { useAppStore } from '../stores/app-store';
import { mountTestRoot, type TestRootHandle } from '../test-utils/react-root';
import type { BenchmarkReport } from '../runtime/benchmark-runtime';
import { DiagnosticsReportExporter } from './diagnostics/DiagnosticsDetails';

// The diagnostics workbench runs against the injectable fake bridge instead of
// stubbed runtime modules: every action goes through the real
// diagnostics/bridge/provider/configuration runtime code down to a fake
// `invoke`, so the assertions are recorded v2 commands plus the resulting
// store/DOM state. vi.mock is reserved for leaf externalities (the Tauri
// core/event channels). Unless a case says otherwise it runs the NATIVE path
// (TauriDesktopApi + fake bridge + a present `__TAURI_INTERNALS__.invoke`);
// the one browser-PREVIEW case is named and commented as such.

const harness = vi.hoisted(() => ({
  nativeShell: true,
  invoke: null as null | (<T>(command: string, args?: Record<string, unknown>) => Promise<T>),
  listen: null as
    | null
    | (<T>(eventName: string, handler: (event: { event: string; payload: T }) => void) => Promise<() => void>),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
    if (!harness.invoke) {
      return Promise.reject(new Error(`fake bridge not installed for command ${command}`));
    }
    return harness.invoke(command, args);
  },
  isTauri: () => harness.nativeShell,
}));

// benchmark-runtime subscribes to the native `benchmark://progress` channel.
// Event delivery is a leaf externality, so it is routed into the fake bridge's
// own event bus rather than stubbing the runtime module.
vi.mock('@tauri-apps/api/event', () => ({
  listen: <T,>(eventName: string, handler: (event: { event: string; payload: T }) => void): Promise<() => void> => {
    if (!harness.listen) {
      return Promise.reject(new Error(`fake bridge not installed for event ${eventName}`));
    }
    return harness.listen(eventName, handler);
  },
}));

type TauriInternalsWindow = Window & { __TAURI_INTERNALS__?: { invoke?: unknown } };

/** The raw probe `hasInvokeBridge()` reads; present only in the native shell. */
function installInvokeBridge(installed: boolean) {
  const scope = window as TauriInternalsWindow;
  if (installed) {
    scope.__TAURI_INTERNALS__ = { invoke: () => undefined };
  } else {
    delete scope.__TAURI_INTERNALS__;
  }
}

const providerSecretRef = appConfigDraftMock.providers[0]?.authRef?.reference ?? '';
const defaultBenchmarkMp3Path = 'scripts/testing/fixtures/watch-mode-en-original.wav';

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

/** Drains the microtask queue (and any 0ms timer) inside act(). */
async function settleUi() {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });
}

async function clickAndSettle(element: HTMLElement | null | undefined) {
  await act(async () => {
    element?.click();
  });
  await settleUi();
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
  let fake: FakeBridge;
  let clipboardWrite: ReturnType<typeof vi.fn>;
  let originalClipboardDescriptor: PropertyDescriptor | undefined;

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

  /**
   * Freezes one in-flight command so pending state can be observed, then hands
   * back a release that lets it reach the fake bridge. Used instead of
   * re-introducing a runtime-module stub for "still running" assertions.
   */
  function holdCommand(command: string, action?: string) {
    const passthrough = fake.invoke;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    harness.invoke = <T,>(name: string, args?: Record<string, unknown>): Promise<T> => {
      const calledAction = (args?.command as { action?: string } | undefined)?.action;
      if (name === command && (action === undefined || calledAction === action)) {
        return gate.then(() => passthrough<T>(name, args));
      }
      return passthrough<T>(name, args);
    };

    return async () => {
      harness.invoke = passthrough;
      release();
      await settleUi();
    };
  }

  /** Swaps the installed boundary to the browser-preview implementation. */
  function installPreviewShell() {
    harness.nativeShell = false;
    installInvokeBridge(false);
    resetDesktopApiForTests();
    installDesktopApi(new PreviewDesktopApi());
  }

  beforeEach(() => {
    originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    clipboardWrite = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: clipboardWrite },
    });
    fake = createFakeBridge();
    harness.invoke = fake.invoke;
    harness.listen = fake.listen;
    harness.nativeShell = true;
    installInvokeBridge(true);
    // Re-install per test so a previous test's Tauri/preview choice cannot leak.
    resetDesktopApiForTests();
    installDesktopApi(new TauriDesktopApi());

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

    // The backend reports the same machine state the store starts from, so a
    // refresh/self-check does not silently rewrite the scenario under test.
    fake.seedRuntimeSnapshot(runtimeSnapshot);
    fake.setProviderSecret(providerSecretRef, 'fake-api-key');

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
    // The frontend logger forwards batches over the same bridge; drop the
    // queue before the fake is uninstalled so no retry loop outlives the test.
    loggerTestHelpers.reset();
    harness.invoke = null;
    harness.listen = null;
    installInvokeBridge(false);
    resetDesktopApiForTests();
    if (originalClipboardDescriptor) {
      Object.defineProperty(navigator, 'clipboard', originalClipboardDescriptor);
    } else {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
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
    // Native posture: the environment panel reports a live invoke bridge.
    expect(container.querySelector('.diagnostics-raw-signals')?.textContent).toContain('IPC Bridge: true');
  });

  it('dispatches each recommended bridge action as its bridge_v2 command', async () => {
    const config = useAppStore.getState().configDraft;
    const snapshot = structuredClone(useAppStore.getState().runtimeSnapshot);

    snapshot.bridge.driverHealth = 'not-installed';
    await runRecommendedBridgeAction(snapshot, config);

    snapshot.bridge.driverHealth = 'damaged';
    await runRecommendedBridgeAction(snapshot, config);

    snapshot.bridge.driverHealth = 'running';
    snapshot.bridge.bridgeState = 'stopped';
    await runRecommendedBridgeAction(snapshot, config);

    snapshot.bridge.bridgeState = 'running';
    await runRecommendedBridgeAction(snapshot, config);

    const bridgeCalls = fake.commandCalls('bridge_v2');
    expect(bridgeCalls.map((call) => call.action)).toEqual(['install', 'repair', 'start', 'repair']);
    expect(bridgeCalls[0]?.args).toMatchObject({ command: { action: 'install', config } });
    expect(bridgeCalls[1]?.args).toMatchObject({ command: { repairAction: 'reinstall-driver', config } });
    expect(bridgeCalls[2]?.args).toMatchObject({ command: { action: 'start', config } });
    expect(bridgeCalls[3]?.args).toMatchObject({ command: { repairAction: 'restart-bridge', config } });
    // …and the backend really came up as a result of those commands.
    expect(fake.getRuntimeSnapshot().bridge.bridgeState).toBe('running');
  });

  it('runs diagnostics, overlay self-check, export and refresh actions', async () => {
    await renderPage();

    const exportScope = container.querySelector<HTMLSelectElement>('.diagnostics-export-scope select');
    expect(exportScope?.value).toBe('summary');

    for (const label of ['重新诊断', '测试字幕浮窗', '导出诊断包', '刷新运行态']) {
      await clickAndSettle(findButtonByText(container, label));
    }

    const diagnosticsCalls = fake.commandCalls('diagnostics_v2');
    expect(diagnosticsCalls.map((call) => call.action)).toEqual(['selfCheck', 'overlaySelfCheck', 'export']);
    expect(diagnosticsCalls[2]?.args).toMatchObject({ command: { scope: 'summary' } });
    expect(fake.commandCalls('bridge_v2').map((call) => call.action)).toEqual(['refresh']);
    // The export artifact is only a receipt: the scope lands in the UI through
    // the runtime snapshot the export publishes.
    expect(fake.commandCalls('configuration_v2').map((call) => call.action)).toEqual(['runtimeSnapshot']);

    const state = useAppStore.getState();
    expect(state.configDraft.diagnostics.lastExportScope).toBe('summary');
    expect(state.runtimeSnapshot.diagnostics.lastExportScope).toBe('summary');
    expect(state.runtimeSnapshot.diagnostics.lastExportPath).toContain('summary');
  });

  it('exports the explicitly selected full diagnostics scope', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await renderPage();

    const exportScope = container.querySelector<HTMLSelectElement>('.diagnostics-export-scope select');
    expect(exportScope).not.toBeNull();
    await changeValue(exportScope!, 'full');
    await clickAndSettle(findButtonByText(container, '导出诊断包'));

    const exportCall = fake.commandCalls('diagnostics_v2').find((call) => call.action === 'export');
    expect(exportCall?.args).toMatchObject({ command: { scope: 'full' } });
    expect(useAppStore.getState().configDraft.diagnostics.lastExportScope).toBe('full');
  });

  it('tracks a bootstrapped scope until the user explicitly overrides it', async () => {
    await renderPage();

    const exportScope = container.querySelector<HTMLSelectElement>('.diagnostics-export-scope select');
    expect(exportScope?.value).toBe('summary');
    await act(async () => {
      useAppStore.setState((state) => ({
        ...state,
        runtimeSnapshot: {
          ...state.runtimeSnapshot,
          diagnostics: { ...state.runtimeSnapshot.diagnostics, lastExportScope: 'quick' },
        },
      }));
    });
    expect(exportScope?.value).toBe('quick');

    await changeValue(exportScope!, 'full');
    await act(async () => {
      useAppStore.setState((state) => ({
        ...state,
        runtimeSnapshot: {
          ...state.runtimeSnapshot,
          diagnostics: { ...state.runtimeSnapshot.diagnostics, lastExportScope: 'summary' },
        },
      }));
    });
    expect(exportScope?.value).toBe('full');
  });

  it('shows open-directory failures on the diagnostics page', async () => {
    await renderPage();
    await clickAndSettle(findButtonByText(container, '导出诊断包'));
    fake.rejectNextAction('openExportDirectory', { message: 'shell unavailable' });

    await clickAndSettle(findButtonByText(container, '打开所在目录'));

    const alert = container.querySelector<HTMLElement>('[role="alert"]');
    expect(alert?.textContent).toContain('shell unavailable');
    await clickAndSettle(alert?.querySelector<HTMLButtonElement>('button'));
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('records automatic repair failures for damaged bridge state', async () => {
    const snapshot = structuredClone(useAppStore.getState().runtimeSnapshot);
    snapshot.bridge.driverHealth = 'damaged';
    snapshot.bridge.lifecycleState = 'error';
    snapshot.bridge.lastErrorCode = 'bridge.singleton-already-running';
    fake.seedRuntimeSnapshot(snapshot);
    useAppStore.setState((state) => ({
      ...state,
      runtimeSnapshot: snapshot,
      configDraft: {
        ...state.configDraft,
        devices: { ...state.configDraft.devices, routeMode: 'watch', feedbackLoopPrevention: 'virtual-driver' },
      },
    }));
    fake.rejectNextAction('repair', { code: 'driver.operation-failed', message: 'repair failed' });
    // Hold the refresh to exercise the ordering: the failure must be appended
    // after the backend snapshot replaces the notification list.
    const releaseRefresh = holdCommand('bridge_v2', 'refresh');

    await renderPageAndFlush();
    await clickAndSettle(findButtonByText(container, '自动修复已选项'));

    expect(fake.commandCalls('bridge_v2')[0]?.args).toMatchObject({
      command: { action: 'repair', repairAction: 'reinstall-driver' },
    });
    expect(useAppStore.getState().runtimeNotifications).toHaveLength(0);
    await releaseRefresh();
    const notification = useAppStore.getState().runtimeNotifications[0];
    expect(notification?.level).toBe('error');
    expect(notification?.source).toBe('diagnostics');
    expect(notification?.message).toContain('执行桥接推荐修复');
    expect(notification?.message).toContain('repair failed');
    expect(notification?.message).toContain('driver.operation-failed');

    expect(fake.commandCalls('bridge_v2').map((call) => call.action)).toEqual(['repair', 'refresh']);
  });

  it('opens benchmark results immediately and streams progress into the modal', async () => {
    const partialReport = benchmarkReport('实时');
    const finalReport = benchmarkReport('实时结果');
    fake.programBenchmarkRun({
      progress: [{
        phase: 'output-delta',
        message: '收到模型输出 delta',
        report: partialReport,
        audioChunksSent: 2,
        totalAudioChunks: 10,
      }],
      report: finalReport,
    });

    await renderPage();
    await clickAndSettle(findButtonByText(container, '开始基准测试'));

    const configurationCalls = fake.commandCalls('configuration_v2');
    expect(configurationCalls.map((call) => call.action)).toEqual(['secretRead']);
    expect(configurationCalls[0]?.args).toMatchObject({ command: { reference: providerSecretRef } });

    const benchmarkCall = fake.commandCalls('provider_v2')[0];
    expect(benchmarkCall?.action).toBe('runModelBenchmark');
    // The secret read above is what unlocks the run: it must reach the payload.
    expect(benchmarkCall?.args).toMatchObject({
      command: {
        model: 'qwen3.5-omni-plus-realtime',
        apiKey: 'fake-api-key',
        mp3Path: defaultBenchmarkMp3Path,
        realtimeAudioMode: 'manual',
      },
    });
    expect(container.textContent).toContain('基准测试结果');
    expect(container.querySelector('.benchmark-result-score')).not.toBeNull();
    expect(container.textContent).toContain('基准评分');
    expect(container.textContent).toContain('语义质量');
    expect(container.textContent).toContain('收到模型输出 delta');
    expect(container.textContent).toContain('实时结果');
  });

  it('keeps the latest benchmark stream data visible when the run fails', async () => {
    const partialReport = benchmarkReport('部分输出');
    fake.programBenchmarkRun({
      progress: [{
        phase: 'output-delta',
        message: '收到模型输出 delta',
        report: partialReport,
        audioChunksSent: 3,
        totalAudioChunks: 10,
      }],
      failure: { message: 'network failed' },
    });

    await renderPage();
    await clickAndSettle(findButtonByText(container, '开始基准测试'));

    // The partial report streamed before the failure stays on screen…
    expect(container.textContent).toContain('部分输出');
    // …and the run is presented as failed, with the backend's terminal phase.
    expect(container.querySelector('.benchmark-progress-card')?.className).toContain('benchmark-progress-error');
    expect(container.querySelector('.benchmark-progress-head strong')?.textContent).toBe('failed');
    expect(container.querySelector('.diagnostics-benchmark-error')?.textContent).toContain('network failed');
    expect(container.querySelector('.diagnostics-benchmark-error')?.textContent).toContain('runtime.operation-failed');
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

    fake.programBenchmarkRun({ report });

    await renderPage();
    await clickAndSettle(findButtonByText(container, '开始基准测试'));

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
    fake.programBenchmarkRun({ report });

    await renderPage();
    await clickAndSettle(container.querySelector<HTMLButtonElement>('.diagnostics-benchmark-panel .diagnostics-primary-action'));

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

    const audioSelect = container.querySelectorAll<HTMLSelectElement>('.diagnostics-benchmark-select')[1]!;
    await changeValue(audioSelect, '__custom__');
    await changeValue(container.querySelector<HTMLInputElement>('.diagnostics-benchmark-input')!, '   ');
    await clickAndSettle(container.querySelector<HTMLButtonElement>('.diagnostics-benchmark-panel .diagnostics-primary-action'));

    expect(container.textContent).toContain('请输入 MP3 文件路径');
    // The run is rejected client-side: neither the credential nor the provider
    // command ever reaches the bridge.
    expect(fake.commandCalls('configuration_v2')).toHaveLength(0);
    expect(fake.commandCalls('provider_v2')).toHaveLength(0);
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
    // No secret stored for this reference: the keyring answers `secret: null`.
    fake.setProviderSecret(providerSecretRef, null);

    await renderPageAndFlush();

    const select = container.querySelector<HTMLSelectElement>('.diagnostics-benchmark-select')!;
    expect(select.options.length).toBe(2);
    await changeValue(select, 'template-dashscope-realtime::second-live');
    const audioSelect = container.querySelectorAll<HTMLSelectElement>('.diagnostics-benchmark-select')[1]!;
    await changeValue(audioSelect, '__custom__');
    await changeValue(container.querySelector<HTMLInputElement>('.diagnostics-benchmark-input')!, 'E:\\audio\\sample.mp3');
    await clickAndSettle(container.querySelector<HTMLButtonElement>('.diagnostics-benchmark-panel .diagnostics-primary-action'));

    expect(fake.commandCalls('configuration_v2').map((call) => call.action)).toEqual(['secretRead']);
    expect(fake.commandCalls('provider_v2')).toHaveLength(0);
    expect(container.textContent).toContain('未找到模型 阿里云百炼 API: second-live 的 API Key');
  });

  it('closes benchmark result modal from the close button and backdrop', async () => {
    fake.programBenchmarkRun({ report: benchmarkReport('modal result') });

    await renderPage();
    await clickAndSettle(container.querySelector<HTMLButtonElement>('.diagnostics-benchmark-panel .diagnostics-primary-action'));

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
    fake.seedRuntimeSnapshot(snapshot);
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

    await clickAndSettle(findButtonByText(container, '自动修复已选项'));
    expect(fake.commandCalls('bridge_v2')).toHaveLength(0);

    await act(async () => {
      repairInputs[1]!.click();
      await Promise.resolve();
    });
    expect(findButtonByText(container, '自动修复已选项')?.disabled).toBe(false);
  });

  it('runs runtime-error repair and refreshes after successful Tauri repairs', async () => {
    // `runtime-error` is synthesised by the renderer bootstrap, never sent by
    // the shell: the store holds it while the backend still reports a healthy
    // snapshot, which is exactly what the repair re-reads.
    const snapshot = structuredClone(useAppStore.getState().runtimeSnapshot);
    snapshot.bridgeStatus = 'runtime-error';
    snapshot.bridge.driverHealth = 'running';
    snapshot.bridge.bridgeState = 'running';
    useAppStore.setState((state) => ({ ...state, runtimeSnapshot: snapshot }));

    await renderPageAndFlush();
    await clickAndSettle(findButtonByText(container, '自动修复已选项'));

    expect(fake.commandCalls('configuration_v2').map((call) => call.action)).toEqual([
      'bootstrapRuntime',
      'runtimeSnapshot',
    ]);
    expect(fake.commandCalls('bootstrap_storage')).toHaveLength(1);
    expect(fake.commandCalls('bridge_v2').map((call) => call.action)).toEqual(['refresh']);
    expect(useAppStore.getState().runtimeSnapshot.bridgeStatus).toBe('tauri-shell');
    expect(useAppStore.getState().runtimeNotifications[0]?.level).toBe('info');
  });

  it('shows the original runtime error in the current issue card without repeating it in the conclusion', async () => {
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

  it('keeps the latest Watch report entry available when no session is active', async () => {
    await renderPage();

    expect(findButtonByText(container, '最近一次看片报告')).toBeInstanceOf(HTMLButtonElement);
  });

  it('keeps the Watch report entry available for an outbound-only conversation session', async () => {
    const audio = structuredClone(audioRuntimeSnapshotMock);
    audio.sessionStartedAt = 'unix-ms:1000';
    audio.inbound.streamBound = false;
    audio.outbound.streamBound = true;
    useAppStore.setState((state) => ({ ...state, audioRuntimeSnapshot: audio }));

    await renderPage();

    expect(findButtonByText(container, '最近一次看片报告')).toBeInstanceOf(HTMLButtonElement);
  });

  it('opens the latest Watch report and shows the three-stage comparison', async () => {
    const audio = structuredClone(audioRuntimeSnapshotMock);
    audio.sessionStartedAt = 'unix-ms:1000';
    audio.inbound.streamBound = true;
    useAppStore.setState((state) => ({ ...state, audioRuntimeSnapshot: audio }));

    fake.startLiveSession({ model: 'qwen3.5-omni-plus-realtime', sessionStartedAt: 'unix-ms:1000' });
    fake.pushLiveAsrDelta({ elapsedMs: 100, stash: '你好', text: '', eventType: 'conversation.item.input_audio_transcription.delta' });
    fake.pushLiveAsrDelta({ elapsedMs: 200, stash: '', text: '你好世界', eventType: 'conversation.item.input_audio_transcription.completed' });
    fake.pushLiveOutputDelta({ elapsedMs: 300, eventType: 'response.audio_transcript.delta', stash: 'Hello', committedText: '' });
    fake.pushLiveOutputDelta({ elapsedMs: 500, eventType: 'response.done', stash: '', committedText: 'Hello world' });

    await renderPage();

    const reportButton = findButtonByText(container, '最近一次看片报告');
    expect(reportButton).toBeInstanceOf(HTMLButtonElement);

    await clickAndSettle(reportButton);

    expect(fake.commandCalls('diagnostics_v2').map((call) => call.action)).toEqual(['watchSessionReport']);
    expect(container.querySelector('[role="dialog"].watch-report-modal')).not.toBeNull();
    expect(container.textContent).toContain('最近一次看片报告');
    expect(container.textContent).toContain('qwen3.5-omni-plus-realtime');
    await changeValue(container.querySelector<HTMLSelectElement>('.watch-report-controls select')!, 'all');
    await settleUi();
    expect(container.textContent).toContain('LLM 采用文本');
    expect(container.textContent).toContain('字幕发布文本');
    expect(container.textContent).toContain('浮窗实际文本');
    expect(container.textContent).toContain('你好世界');
    expect(container.textContent).toContain('Hello world');
    expect(container.textContent).toContain('完全一致');
  });

  it('closes the Watch report modal from close button and backdrop', async () => {
    const audio = structuredClone(audioRuntimeSnapshotMock);
    audio.sessionStartedAt = 'unix-ms:2000';
    audio.inbound.streamBound = true;
    useAppStore.setState((state) => ({ ...state, audioRuntimeSnapshot: audio }));
    fake.startLiveSession({ sessionStartedAt: 'unix-ms:2000' });

    await renderPage();

    await clickAndSettle(findButtonByText(container, '最近一次看片报告'));

    expect(container.querySelector('.benchmark-modal')).not.toBeNull();

    // Close via close button (second icon-button in modal head)
    const modalHead = container.querySelector('.benchmark-modal-head')!;
    const closeButtons = modalHead.querySelectorAll('.icon-button');
    await act(async () => {
      closeButtons[closeButtons.length - 1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.querySelector('.benchmark-modal')).toBeNull();

    // Reopen and close via backdrop
    await clickAndSettle(findButtonByText(container, '最近一次看片报告'));
    expect(container.querySelector('.benchmark-modal')).not.toBeNull();
    await act(async () => {
      container.querySelector<HTMLElement>('.modal-backdrop--benchmark')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.querySelector('.benchmark-modal')).toBeNull();
  });

  it('shows an empty state when there is no retained Watch report', async () => {
    await renderPage();

    await clickAndSettle(findButtonByText(container, '最近一次看片报告'));

    expect(container.querySelector('[role="dialog"].watch-report-modal')).not.toBeNull();
    expect(container.textContent).toContain('尚无看片报告');
  });

  it('refreshes the Watch report when refresh is clicked', async () => {
    const audio = structuredClone(audioRuntimeSnapshotMock);
    audio.sessionStartedAt = 'unix-ms:4000';
    audio.inbound.streamBound = true;
    useAppStore.setState((state) => ({ ...state, audioRuntimeSnapshot: audio }));

    fake.startLiveSession({ model: 'refresh-model', sessionStartedAt: 'unix-ms:4000' });
    fake.pushLiveAsrDelta({ elapsedMs: 100, stash: '', text: 'first', eventType: 'asr' });

    await renderPage();

    await clickAndSettle(findButtonByText(container, '最近一次看片报告'));

    expect(fake.commandCalls('diagnostics_v2')).toHaveLength(1);
    await changeValue(container.querySelector<HTMLSelectElement>('.watch-report-controls select')!, 'all');
    await settleUi();
    expect(container.textContent).toContain('first');

    // The native buffer keeps recording while the modal is open.
    fake.pushLiveAsrDelta({ elapsedMs: 300, stash: '', text: 'second', eventType: 'asr' });

    // Click refresh button (the refresh icon-button in the modal head)
    const refreshButton = container.querySelector<HTMLButtonElement>('.benchmark-modal button[title="刷新"]');
    await clickAndSettle(refreshButton);

    expect(fake.commandCalls('diagnostics_v2')).toHaveLength(2);
    expect(container.textContent).toContain('second');
  });

  it('runs the empty-state self-check action', async () => {
    await renderPage();

    await clickAndSettle(container.querySelector<HTMLButtonElement>('.diagnostics-empty-actions .icon-button'));

    expect(fake.commandCalls('diagnostics_v2').map((call) => call.action)).toEqual(['selfCheck']);
    expect(useAppStore.getState().runtimeSnapshot.bridgeStatus).toBe('tauri-shell');
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
    const damaged = structuredClone(useAppStore.getState().runtimeSnapshot);
    damaged.bridge.driverHealth = 'damaged';
    damaged.bridge.lifecycleState = 'error';
    damaged.bridge.lastErrorCode = 'bridge.singleton-already-running';
    fake.seedRuntimeSnapshot(damaged);
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
    });
    await settleUi();

    expect(fake.commandCalls('bridge_v2').map((call) => call.action)).toEqual(['repair', 'refresh']);
    expect(fake.getRuntimeSnapshot().bridge.bridgeState).toBe('running');
    expect(useAppStore.getState().runtimeSnapshot.bridge.driverHealth).toBe('running');
  });

  it('exports benchmark and Watch reports through both formats', async () => {
    // The exporter is a browser download facade (Blob + anchor click), the one
    // leaf externality of the export path.
    const benchmarkExport = vi.spyOn(DiagnosticsReportExporter, 'exportBenchmark').mockResolvedValue({ outputPath: 'benchmark.json', fileCount: 1 });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fake.programBenchmarkRun({ report: benchmarkReport('export result') });
    const audio = structuredClone(audioRuntimeSnapshotMock);
    audio.sessionStartedAt = 'unix-ms:5000';
    audio.inbound.streamBound = true;
    useAppStore.setState((state) => ({ ...state, audioRuntimeSnapshot: audio }));
    fake.startLiveSession({ model: 'live-model', sessionStartedAt: 'unix-ms:5000' });
    await renderPage();

    await clickAndSettle(container.querySelector<HTMLButtonElement>('.diagnostics-benchmark-panel .diagnostics-primary-action'));
    for (const format of ['JSON', 'TXT']) {
      await act(async () => container.querySelector<HTMLButtonElement>('.benchmark-modal-head .icon-button')?.click());
      await act(async () => Array.from(container.querySelectorAll<HTMLButtonElement>('.benchmark-modal-head button'))
        .find((button) => button.textContent === format)?.click());
    }
    expect(benchmarkExport).toHaveBeenCalledTimes(2);

    await act(async () => container.querySelectorAll<HTMLButtonElement>('.benchmark-modal-head .icon-button')[1]?.click());
    await clickAndSettle(container.querySelector<HTMLButtonElement>('.diagnostics-live-events-button'));
    for (const format of ['JSON', 'TXT']) {
      await clickAndSettle(Array.from(container.querySelectorAll<HTMLButtonElement>('.watch-report-actions button'))
        .find((button) => button.textContent === format));
      const exportedPath = container.querySelector<HTMLInputElement>('.watch-report-export-path');
      expect(exportedPath).not.toBeNull();
      expect(exportedPath?.readOnly).toBe(true);
      expect(exportedPath?.value).toMatch(new RegExp(`\\.${format.toLowerCase()}$`));
      const copyPathButton = Array.from(container.querySelectorAll<HTMLButtonElement>('.watch-report-export-result-actions button'))
        .find((button) => button.textContent === '复制路径');
      await clickAndSettle(copyPathButton);
      expect(clipboardWrite).toHaveBeenLastCalledWith(exportedPath?.value);
      expect(container.querySelector('.watch-report-export-result-actions')?.textContent).toContain('路径已复制');
      const openFolderButton = Array.from(container.querySelectorAll<HTMLButtonElement>('.watch-report-export-result-actions button'))
        .find((button) => button.textContent === '打开所在目录');
      await clickAndSettle(openFolderButton);
      const openDirectoryCalls = fake.commandCalls('diagnostics_v2')
        .filter((call) => call.action === 'openExportDirectory');
      expect(openDirectoryCalls.at(-1)?.args).toMatchObject({
        command: { outputPath: expect.stringMatching(new RegExp(`\\.${format.toLowerCase()}$`)) },
      });
    }
    const reportExports = fake.commandCalls('diagnostics_v2')
      .filter((call) => call.action === 'writeExportArtifact');
    expect(reportExports).toHaveLength(2);
    expect(reportExports[0]?.args).toMatchObject({
      command: {
        filename: expect.stringMatching(/^watch-session-report-live-model-.+\.json$/),
        content: expect.stringContaining('"sessionId": "fake-watch-session"'),
      },
    });
    expect(reportExports[1]?.args).toMatchObject({
      command: {
        filename: expect.stringMatching(/^watch-session-report-live-model-.+\.txt$/),
        content: expect.stringContaining('=== Watch Session Report ==='),
      },
    });
    const openDirectoryCalls = fake.commandCalls('diagnostics_v2')
      .filter((call) => call.action === 'openExportDirectory');
    expect(openDirectoryCalls).toHaveLength(2);
    expect(openDirectoryCalls[0]?.args)
      .toMatchObject({ command: { outputPath: expect.stringMatching(/\.json$/) } });
    expect(openDirectoryCalls[1]?.args)
      .toMatchObject({ command: { outputPath: expect.stringMatching(/\.txt$/) } });
  });

  it('renders recent diagnostic issues without routes and safely ignores export before the Watch report arrives', async () => {
    const runtime = structuredClone(useAppStore.getState().runtimeSnapshot);
    runtime.diagnostics.recentErrors = [{
      id: 'local-warning', category: 'runtime', level: 'warning', summary: 'local warning', detail: null, emittedAt: 'test', source: null, elapsedMs: null,
    }];
    const audio = structuredClone(useAppStore.getState().audioRuntimeSnapshot);
    audio.sessionStartedAt = 'unix-ms:5000';
    audio.sttConnected = true;
    useAppStore.setState((state) => ({ ...state, runtimeSnapshot: runtime, audioRuntimeSnapshot: audio }));
    // Never released: the Watch report read stays in flight for the whole case.
    holdCommand('diagnostics_v2', 'watchSessionReport');

    await renderPage();
    expect(Array.from(container.querySelectorAll('.compact-alert-item')).some((item) =>
      item.tagName === 'DIV' && item.textContent?.includes('local warning'))).toBe(true);

    await act(async () => container.querySelector<HTMLButtonElement>('.diagnostics-live-events-button')?.click());
    expect(container.querySelector('[role="dialog"].watch-report-modal')).not.toBeNull();
    expect(container.querySelector('.watch-report-actions')).toBeNull();
    expect(fake.commandCalls('diagnostics_v2').some((call) => call.action === 'writeExportArtifact')).toBe(false);
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
    runtime.diagnostics.recentErrors = [{ id: 'draft-warning', category: 'runtime', level: 'warning', summary: 'draft warning', detail: null, emittedAt: 'test', source: null, elapsedMs: null }];
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

  it('renders sparse benchmark summaries and exports an unknown-model Watch report', async () => {
    const report = benchmarkReport('sparse');
    report.audioDurationSecs = undefined as never;
    report.runs = [];
    fake.programBenchmarkRun({ report });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const audio = structuredClone(useAppStore.getState().audioRuntimeSnapshot);
    audio.sessionStartedAt = 'unix-ms:5000';
    audio.inbound.streamBound = true;
    useAppStore.setState((state) => ({ ...state, audioRuntimeSnapshot: audio }));
    fake.startLiveSession({ model: '', sessionStartedAt: 'unix-ms:5000' });
    await renderPage();
    await clickAndSettle(container.querySelector<HTMLButtonElement>('.diagnostics-benchmark-panel .diagnostics-primary-action'));
    expect(container.querySelector('.benchmark-modal')).not.toBeNull();
    await act(async () => container.querySelectorAll<HTMLButtonElement>('.benchmark-modal-head .icon-button')[1]?.click());
    await clickAndSettle(container.querySelector<HTMLButtonElement>('.diagnostics-live-events-button'));
    await clickAndSettle(Array.from(container.querySelectorAll<HTMLButtonElement>('.watch-report-actions button'))
      .find((button) => button.textContent === 'JSON'));
    expect(fake.commandCalls('diagnostics_v2').find((call) => call.action === 'writeExportArtifact')?.args)
      .toMatchObject({ command: { filename: expect.stringContaining('watch-session-report-unknown-') } });
  });

  it('PREVIEW path: repairs through the browser-preview boundary without touching the native bridge', async () => {
    installPreviewShell();
    const damaged = structuredClone(useAppStore.getState().runtimeSnapshot);
    damaged.bridge.driverHealth = 'damaged';
    damaged.bridge.lifecycleState = 'error';
    damaged.bridge.lastErrorCode = 'bridge.singleton-already-running';
    useAppStore.setState((state) => ({
      ...state,
      runtimeSnapshot: damaged,
      configDraft: {
        ...state.configDraft,
        devices: { ...state.configDraft.devices, routeMode: 'watch', feedbackLoopPrevention: 'virtual-driver' },
      },
    }));

    await renderPageAndFlush();
    expect(container.querySelector('.diagnostics-raw-signals')?.textContent).toContain('IPC Bridge: false');

    await clickAndSettle(findButtonByText(container, '自动修复已选项'));

    // Nothing reached the IPC bridge: the preview implementation answered.
    expect(fake.calls).toHaveLength(0);
    expect(useAppStore.getState().runtimeSnapshot.bridge.driverHealth).toBe('running');
    // Without a native shell the controller skips the follow-up bridge refresh,
    // so the success notification stays at the head of the list.
    expect(useAppStore.getState().runtimeNotifications[0]?.level).toBe('info');
  });
});
