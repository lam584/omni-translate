import { beforeEach, describe, expect, it, vi } from 'vitest';

import { appConfigDraftMock } from '../../mocks/app-config';
import { audioRuntimeSnapshotMock } from '../../mocks/audio-runtime';
import { runtimeSnapshotMock } from '../../mocks/runtime-shell';
import type { AudioRuntimeSnapshot } from '../../schema/audio-runtime';
import type { RuntimeSnapshot } from '../../schema/runtime-core';

const mocks = vi.hoisted(() => ({
  appendLog: vi.fn(),
  recentLogs: vi.fn(),
  watchNeedsBridge: vi.fn(),
  refreshBridge: vi.fn(),
  installBridge: vi.fn(),
  repairBridge: vi.fn(),
  startBridge: vi.fn(),
  cancelPreconnect: vi.fn(),
  getAudioSnapshot: vi.fn(),
  preconnect: vi.fn(),
  showOverlay: vi.fn(),
  startRoute: vi.fn(),
  waitForWatchReady: vi.fn(),
  startSpeech: vi.fn(),
  startTranslation: vi.fn(),
  stopRoute: vi.fn(),
  stopSpeech: vi.fn(),
  stopTranslation: vi.fn(),
}));

const planState = vi.hoisted(() => ({
  fallbackStages: null as null | Array<'bridge-ready' | 'omni-preconnect' | 'inbound-route' | 'outbound-route' | 'translate-worker' | 'speech-dispatch' | 'subtitle-overlay'>,
  mainStages: null as null | Array<'bridge-ready' | 'omni-preconnect' | 'inbound-route' | 'outbound-route' | 'translate-worker' | 'speech-dispatch' | 'subtitle-overlay'>,
  parallelPreconnect: false,
  fallbackParallelPreconnect: false,
}));

vi.mock('../../runtime/audio-runtime', () => ({
  cancelOmniPreconnectRuntime: (...args: unknown[]) => mocks.cancelPreconnect(...args),
  getAudioRuntimeSnapshotRuntime: (...args: unknown[]) => mocks.getAudioSnapshot(...args),
  preconnectOmniRealtimeRuntime: (...args: unknown[]) => mocks.preconnect(...args),
  showSubtitleOverlayWindow: (...args: unknown[]) => mocks.showOverlay(...args),
  startAudioRouteRuntime: (...args: unknown[]) => mocks.startRoute(...args),
  waitForWatchRouteReadyRuntime: (...args: unknown[]) => mocks.waitForWatchReady(...args),
  startSpeechDispatchRuntime: (...args: unknown[]) => mocks.startSpeech(...args),
  startTranslateWorkerRuntime: (...args: unknown[]) => mocks.startTranslation(...args),
  stopAudioRouteRuntime: (...args: unknown[]) => mocks.stopRoute(...args),
  stopSpeechDispatchRuntime: (...args: unknown[]) => mocks.stopSpeech(...args),
  stopTranslateWorkerRuntime: (...args: unknown[]) => mocks.stopTranslation(...args),
}));

vi.mock('../../runtime/diagnostics-runtime', () => ({
  appendFrontendDiagnosticsLog: (...args: unknown[]) => mocks.appendLog(...args),
  getRecentDiagnosticsLogsRuntime: (...args: unknown[]) => mocks.recentLogs(...args),
}));

vi.mock('../../runtime/desktop-api-context', () => ({
  useDesktopApiV2: () => ({
    bridge: {
      refresh: mocks.refreshBridge,
      install: mocks.installBridge,
      repair: mocks.repairBridge,
      start: mocks.startBridge,
    },
  }),
}));

vi.mock('../../utils/scene-readiness', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../utils/scene-readiness')>();
  return { ...original, watchModeNeedsBridge: (...args: unknown[]) => mocks.watchNeedsBridge(...args) };
});

vi.mock('./sceneLaunchPlan', async (importOriginal) => {
  const original = await importOriginal<typeof import('./sceneLaunchPlan')>();
  return {
    ...original,
    buildSceneLaunchPlan: (...args: Parameters<typeof original.buildSceneLaunchPlan>) => {
      const plan = original.buildSceneLaunchPlan(...args);
      if (planState.mainStages) plan.stages = [...planState.mainStages];
      plan.parallelOmniPreconnect = planState.parallelPreconnect;
      return plan;
    },
    buildWatchFallbackPlan: (...args: Parameters<typeof original.buildWatchFallbackPlan>) => {
      const plan = original.buildWatchFallbackPlan(...args);
      if (planState.fallbackStages) plan.stages = [...planState.fallbackStages];
      plan.parallelOmniPreconnect = planState.fallbackParallelPreconnect;
      return plan;
    },
  };
});

vi.mock('./sceneLaunchTimeout', () => ({ sceneLaunchTimeoutMs: () => 100 }));

import { sceneSessionControllerHelpers, useSceneSessionController } from './useSceneSessionController';

function cloneAudio(): AudioRuntimeSnapshot {
  return structuredClone(audioRuntimeSnapshotMock);
}

function cloneRuntime(): RuntimeSnapshot {
  return structuredClone(runtimeSnapshotMock);
}

function readyRuntime(overrides: Partial<RuntimeSnapshot['bridge']> = {}): RuntimeSnapshot {
  const snapshot = cloneRuntime();
  snapshot.bridge = {
    ...snapshot.bridge,
    driverHealth: 'running',
    bridgeState: 'running',
    recommendedAction: null,
    ...overrides,
  };
  return snapshot;
}

function makeHarness(runtimeSnapshot = readyRuntime()) {
  const controller = {
    runtimeSnapshot,
    setRuntimeSnapshot: vi.fn(),
    setAudioSnapshot: vi.fn(),
    updateDeviceDraft: vi.fn(),
    updateSpeechDraft: vi.fn(),
    updateDiagnosticsReady: vi.fn(),
    pushNotification: vi.fn(),
    runBusyAction: vi.fn(async (_action: string, task: () => Promise<void>) => task()),
    confirmWatchFallback: vi.fn(async () => true),
    sceneLaunchFailureMessage: vi.fn((mode: string, stage: string | null, error: unknown) => (
      `${mode}:${stage ?? 'none'}:${error instanceof Error ? error.message : String(error)}`
    )),
    sceneLaunchTimeoutMessage: vi.fn((seconds: number) => `timeout after ${seconds}s`),
  };
  // eslint-disable-next-line react-hooks/rules-of-hooks -- controller factory exercised outside a React render in tests
  return { controller, api: useSceneSessionController(controller) };
}

function makeLaunchOptions(mode: 'watch' | 'voice-room' = 'watch') {
  const configDraft = structuredClone(appConfigDraftMock);
  configDraft.devices.feedbackLoopPrevention = 'none';
  configDraft.devices.virtualMicOutputEnabled = false;
  configDraft.speech.outputTarget = 'speaker';
  const audioSnapshot = cloneAudio();
  audioSnapshot.inbound.streamBound = false;
  audioSnapshot.outbound.streamBound = false;
  audioSnapshot.speech.dispatchState = 'idle';
  return {
    launchAttemptId: `${mode}-attempt`,
    mode,
    configDraft,
    audioSnapshot,
    overlayVisible: mode === 'watch',
    isOmniModel: true,
    speechPatch: { enabled: false },
    secondarySubtitleTranslationEnabled: false,
  };
}

beforeEach(() => {
  vi.useRealTimers();
  for (const mock of Object.values(mocks)) mock.mockReset();
  planState.fallbackStages = null;
  planState.mainStages = null;
  planState.parallelPreconnect = false;
  planState.fallbackParallelPreconnect = false;
  const audio = cloneAudio();
  mocks.watchNeedsBridge.mockReturnValue(false);
  mocks.recentLogs.mockResolvedValue([]);
  mocks.getAudioSnapshot.mockResolvedValue(audio);
  mocks.cancelPreconnect.mockResolvedValue(audio);
  mocks.preconnect.mockResolvedValue(audio);
  mocks.startRoute.mockResolvedValue(audio);
  mocks.waitForWatchReady.mockResolvedValue(audio);
  mocks.startSpeech.mockResolvedValue(audio);
  mocks.startTranslation.mockResolvedValue(audio);
  mocks.stopRoute.mockResolvedValue(audio);
  mocks.stopSpeech.mockResolvedValue(audio);
  mocks.stopTranslation.mockResolvedValue(audio);
  mocks.showOverlay.mockResolvedValue(cloneRuntime());
  mocks.refreshBridge.mockResolvedValue(readyRuntime());
  mocks.installBridge.mockResolvedValue(readyRuntime());
  mocks.repairBridge.mockResolvedValue(readyRuntime());
  mocks.startBridge.mockResolvedValue(readyRuntime());
});

describe('useSceneSessionController IPC orchestration', () => {
  it('covers timeout cleanup values and Bridge error classification helpers', async () => {
    expect(sceneSessionControllerHelpers.isBridgeStartupError(new Error('WASAPI driver failed'))).toBe(true);
    expect(sceneSessionControllerHelpers.isBridgeStartupError('ordinary failure')).toBe(false);
    expect(sceneSessionControllerHelpers.isBridgeStartupError(null)).toBe(false);
    vi.useFakeTimers();
    const timed = sceneSessionControllerHelpers.withSceneLaunchTimeout(
      new Promise<never>(() => undefined), 10, 'deadline', async () => { throw 'cleanup string'; },
    );
    const rejected = expect(timed).rejects.toThrow('deadline');
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    expect(mocks.appendLog).toHaveBeenCalledWith('runtime', 'warning', expect.stringContaining('cleanup string'));
  });

  it('describes Watch attribution when snapshot IPC rejects a non-Error', async () => {
    mocks.getAudioSnapshot.mockRejectedValue('snapshot string');
    await expect(sceneSessionControllerHelpers.describeWatchLaunchFailure('inbound-route', 'route string', false))
      .resolves.toBeInstanceOf(Error);
    expect(mocks.appendLog).toHaveBeenCalledWith('runtime', 'warning', expect.stringContaining('snapshot string'));
    mocks.getAudioSnapshot.mockRejectedValue(new Error('snapshot error'));
    await sceneSessionControllerHelpers.describeWatchLaunchFailure('inbound-route', new Error('route error'), false);
    expect(mocks.appendLog).toHaveBeenCalledWith('runtime', 'warning', expect.stringContaining('snapshot error'));
  });
  it('bypasses Bridge IPC when the selected route does not need it', async () => {
    const { api, controller } = makeHarness();
    const config = structuredClone(appConfigDraftMock);
    await expect(api.ensureBridgeReady('voice-room', config)).resolves.toBe(controller.runtimeSnapshot);
    expect(mocks.refreshBridge).not.toHaveBeenCalled();
  });

  it('logs non-Error Bridge refresh and stop failures and skips inactive stop stages', async () => {
    mocks.watchNeedsBridge.mockReturnValue(true);
    mocks.refreshBridge.mockRejectedValue('refresh string');
    const cached = readyRuntime();
    const { api, controller } = makeHarness(cached);
    await api.ensureBridgeReady('voice-room', structuredClone(appConfigDraftMock));
    expect(mocks.appendLog).toHaveBeenCalledWith('runtime', 'warning', expect.stringContaining('refresh string'));

    const audio = cloneAudio();
    audio.inbound.streamBound = false; audio.outbound.streamBound = false; audio.speech.dispatchState = 'idle';
    mocks.getAudioSnapshot.mockRejectedValue('snapshot stop string');
    mocks.stopTranslation.mockRejectedValue('translation stop string');
    await api.stopAll({ audioSnapshot: audio, hasSpeechActivity: false, setAudioSnapshot: controller.setAudioSnapshot,
      pushNotification: controller.pushNotification, runBusyAction: controller.runBusyAction as never });
    expect(controller.pushNotification).toHaveBeenCalledWith(expect.objectContaining({ level: 'error' }));
    expect(mocks.stopSpeech).not.toHaveBeenCalled();
    expect(mocks.stopRoute).not.toHaveBeenCalled();
  });

  it('uses caller speech activity when native speech is idle', async () => {
    const audio = cloneAudio(); audio.inbound.streamBound = false; audio.outbound.streamBound = false; audio.speech.dispatchState = 'idle';
    mocks.getAudioSnapshot.mockResolvedValue(audio);
    const { api, controller } = makeHarness();
    await api.stopAll({ audioSnapshot: audio, hasSpeechActivity: true, setAudioSnapshot: controller.setAudioSnapshot,
      pushNotification: controller.pushNotification, runBusyAction: controller.runBusyAction as never });
    expect(mocks.stopSpeech).toHaveBeenCalled();
  });

  it('executes fallback cancel, warning text variants, and speech compensation', async () => {
    mocks.watchNeedsBridge.mockReturnValue(true);
    planState.fallbackParallelPreconnect = true;
    planState.fallbackStages = ['bridge-ready', 'omni-preconnect', 'inbound-route'];
    mocks.startRoute.mockRejectedValueOnce('bridge initial string').mockRejectedValueOnce('fallback route string');
    const first = makeHarness(); first.controller.confirmWatchFallback.mockResolvedValue(false);
    await first.api.launchScene(makeLaunchOptions('watch'));
    expect(mocks.appendLog).toHaveBeenCalledWith('runtime', 'error', '[WatchFallback] fallback failed', expect.any(String));

    planState.fallbackParallelPreconnect = false;
    planState.fallbackStages = ['inbound-route', 'speech-dispatch', 'subtitle-overlay'];
    mocks.startRoute.mockReset().mockRejectedValueOnce(new Error('bridge initial')).mockResolvedValueOnce(cloneAudio());
    mocks.showOverlay.mockRejectedValueOnce(new Error('overlay failed'));
    mocks.stopSpeech.mockResolvedValue(cloneAudio());
    const second = makeHarness(); second.controller.confirmWatchFallback.mockResolvedValue(true);
    await second.api.launchScene(makeLaunchOptions('watch'));
    expect(mocks.stopSpeech).toHaveBeenCalled();
  });

  it('covers Watch bridge setup and non-Error preconnect warnings', async () => {
    planState.mainStages = ['bridge-ready', 'inbound-route'];
    const watch = makeHarness();
    await watch.api.launchScene(makeLaunchOptions('watch'));
    expect(watch.controller.updateDeviceDraft).toHaveBeenCalledWith(expect.objectContaining({
      routeMode: 'watch',
      feedbackLoopPrevention: 'echo-cancel',
      aecEnabled: true,
    }));

    planState.parallelPreconnect = true;
    planState.mainStages = ['bridge-ready', 'omni-preconnect', 'inbound-route'];
    mocks.preconnect.mockRejectedValueOnce('preconnect string');
    const parallel = makeHarness();
    await parallel.api.launchScene(makeLaunchOptions('voice-room'));
    expect(parallel.controller.pushNotification).toHaveBeenCalledWith(expect.objectContaining({ level: 'warning' }));
  });

  it('rolls back main speech and reports a non-Error overlay failure', async () => {
    planState.mainStages = ['bridge-ready', 'inbound-route', 'speech-dispatch', 'subtitle-overlay'];
    mocks.showOverlay.mockRejectedValueOnce('overlay string');
    const { api, controller } = makeHarness();
    await api.launchScene(makeLaunchOptions('voice-room'));
    expect(mocks.stopSpeech).toHaveBeenCalled();
    expect(controller.pushNotification).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('overlay string') }));
  });

  it('keeps Watch startup off the synchronous Bridge IPC path even when Bridge is required', async () => {
    mocks.watchNeedsBridge.mockReturnValue(true);
    const { api, controller } = makeHarness();
    await expect(api.ensureBridgeReady('watch', structuredClone(appConfigDraftMock))).resolves.toBe(controller.runtimeSnapshot);
    expect(mocks.refreshBridge).not.toHaveBeenCalled();
  });

  it('falls back to cached Bridge state when refresh IPC fails', async () => {
    mocks.watchNeedsBridge.mockReturnValue(true);
    mocks.refreshBridge.mockRejectedValue('refresh failed');
    const cached = readyRuntime();
    const { api } = makeHarness(cached);

    await expect(api.ensureBridgeReady('voice-room', structuredClone(appConfigDraftMock))).resolves.toBe(cached);
    expect(mocks.appendLog).toHaveBeenCalledWith('runtime', 'warning', expect.stringContaining('refresh failed'));
    mocks.refreshBridge.mockRejectedValue(new Error('refresh error'));
    await api.ensureBridgeReady('voice-room', structuredClone(appConfigDraftMock));
    expect(mocks.appendLog).toHaveBeenCalledWith('runtime', 'warning', expect.stringContaining('refresh error'));
  });

  it('installs a missing Bridge driver and publishes the returned runtime snapshot', async () => {
    mocks.watchNeedsBridge.mockReturnValue(true);
    const missing = readyRuntime({ driverHealth: 'not-installed', bridgeState: 'stopped' });
    mocks.refreshBridge.mockResolvedValue(missing);
    const installed = readyRuntime();
    mocks.installBridge.mockResolvedValue(installed);
    const { api, controller } = makeHarness();

    await expect(api.ensureBridgeReady('voice-room', structuredClone(appConfigDraftMock))).resolves.toBe(installed);
    expect(mocks.installBridge).toHaveBeenCalled();
    expect(controller.setRuntimeSnapshot).toHaveBeenLastCalledWith(installed);
  });

  it.each([
    ['rollback-driver', 'rollback-driver'],
    ['restart-bridge', 'restart-bridge'],
    ['none', 'reinstall-driver'],
  ] as const)('maps recommended action %s to repair IPC action %s', async (recommendedAction, expectedAction) => {
    mocks.watchNeedsBridge.mockReturnValue(true);
    const unhealthy = readyRuntime({
      driverHealth: 'damaged',
      bridgeState: 'stopped',
      recommendedAction: recommendedAction === 'none' ? null : recommendedAction,
    });
    mocks.refreshBridge.mockResolvedValue(unhealthy);
    const repaired = readyRuntime();
    mocks.repairBridge.mockResolvedValue(repaired);
    const { api } = makeHarness();

    await api.ensureBridgeReady('voice-room', structuredClone(appConfigDraftMock));
    expect(mocks.repairBridge).toHaveBeenCalledWith(expectedAction, expect.any(Object));
    expect(mocks.startBridge).not.toHaveBeenCalled();
  });

  it('starts the Bridge service when the driver is healthy but the process is stopped', async () => {
    mocks.watchNeedsBridge.mockReturnValue(true);
    const stopped = readyRuntime({ bridgeState: 'stopped' });
    mocks.refreshBridge.mockResolvedValue(stopped);
    const started = readyRuntime();
    mocks.startBridge.mockResolvedValue(started);
    const { api, controller } = makeHarness();

    await expect(api.ensureBridgeReady('voice-room', structuredClone(appConfigDraftMock))).resolves.toBe(started);
    expect(mocks.startBridge).toHaveBeenCalled();
    expect(controller.setRuntimeSnapshot).toHaveBeenLastCalledWith(started);
  });

  it('stops every active native IPC pipeline and publishes each returned snapshot', async () => {
    const active = cloneAudio();
    active.inbound.streamBound = true;
    active.outbound.streamBound = true;
    active.speech.dispatchState = 'playing';
    mocks.getAudioSnapshot.mockResolvedValue(active);
    const { api, controller } = makeHarness();

    await api.stopAll({
      audioSnapshot: cloneAudio(),
      hasSpeechActivity: false,
      setAudioSnapshot: controller.setAudioSnapshot,
      pushNotification: controller.pushNotification,
      runBusyAction: controller.runBusyAction,
    });

    expect(mocks.stopSpeech).toHaveBeenCalledTimes(1);
    expect(mocks.stopTranslation).toHaveBeenCalledTimes(1);
    expect(mocks.stopRoute.mock.calls.map(([direction]) => direction)).toEqual(['outbound', 'inbound']);
    expect(controller.setAudioSnapshot).toHaveBeenCalled();
  });

  it('continues stop compensation and reports IPC failures when snapshot refresh and a stop step fail', async () => {
    mocks.getAudioSnapshot.mockRejectedValue(new Error('snapshot IPC failed'));
    mocks.stopTranslation.mockRejectedValue('translation stop failed');
    const { api, controller } = makeHarness();

    await api.stopAll({
      audioSnapshot: cloneAudio(),
      hasSpeechActivity: true,
      setAudioSnapshot: controller.setAudioSnapshot,
      pushNotification: controller.pushNotification,
      runBusyAction: controller.runBusyAction,
    });

    expect(mocks.stopSpeech).toHaveBeenCalledTimes(1);
    expect(controller.pushNotification).toHaveBeenCalledWith(expect.objectContaining({
      source: 'session',
      message: expect.stringContaining('translation stop failed'),
    }));
    expect(mocks.appendLog).toHaveBeenCalledWith('runtime', 'warning', expect.stringContaining('snapshot IPC failed'));
    mocks.getAudioSnapshot.mockResolvedValue(cloneAudio());
    mocks.stopTranslation.mockRejectedValue(new Error('translation error'));
    await api.stopAll({ audioSnapshot: cloneAudio(), hasSpeechActivity: false, setAudioSnapshot: controller.setAudioSnapshot,
      pushNotification: controller.pushNotification, runBusyAction: controller.runBusyAction });
    expect(controller.pushNotification).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('translation error') }));
  });

  it('executes every conversation IPC stage and opens the subtitle overlay', async () => {
    const options = makeLaunchOptions('voice-room');
    options.isOmniModel = false;
    options.overlayVisible = false;
    options.speechPatch = { enabled: true };
    const { api, controller } = makeHarness();

    await api.launchScene(options);

    expect(mocks.startRoute.mock.calls.map(([direction]) => direction)).toEqual(['inbound', 'outbound']);
    expect(mocks.startTranslation).toHaveBeenCalledTimes(1);
    expect(mocks.startSpeech).toHaveBeenCalledTimes(1);
    expect(mocks.showOverlay).toHaveBeenCalledTimes(1);
    expect(controller.updateDiagnosticsReady).toHaveBeenCalledWith('voice-room');
    expect(controller.pushNotification).not.toHaveBeenCalled();
  });

  it('runs parallel Omni preconnect IPC and compensates it after a later stage failure', async () => {
    planState.parallelPreconnect = true;
    planState.mainStages = ['bridge-ready', 'omni-preconnect', 'inbound-route'];
    mocks.startRoute.mockRejectedValue(new Error('route failed after preconnect'));
    const { api } = makeHarness();

    await api.launchScene(makeLaunchOptions('voice-room'));

    expect(mocks.preconnect).toHaveBeenCalled();
    expect(mocks.cancelPreconnect).toHaveBeenCalled();
  });

  it('logs and continues when parallel Omni preconnect IPC rejects', async () => {
    planState.parallelPreconnect = true;
    planState.mainStages = ['bridge-ready', 'omni-preconnect', 'inbound-route'];
    mocks.preconnect.mockRejectedValue('preconnect unavailable');
    const { api, controller } = makeHarness();

    await api.launchScene(makeLaunchOptions('voice-room'));

    expect(mocks.appendLog).toHaveBeenCalledWith('runtime', 'warning', expect.stringContaining('preconnect unavailable'));
    expect(controller.pushNotification).toHaveBeenCalledWith(expect.objectContaining({ level: 'warning' }));
    mocks.preconnect.mockRejectedValue(new Error('preconnect error'));
    await api.launchScene(makeLaunchOptions('voice-room'));
    expect(mocks.appendLog).toHaveBeenCalledWith('runtime', 'warning', expect.stringContaining('preconnect error'));
  });

  it('classifies a failed rollback as an error-level launch outcome', async () => {
    planState.mainStages = ['inbound-route', 'translate-worker'];
    mocks.startTranslation.mockRejectedValue(new Error('translation failed'));
    mocks.stopRoute.mockRejectedValue(new Error('rollback failed'));
    const { api } = makeHarness();
    await api.launchScene(makeLaunchOptions('voice-room'));
    expect(mocks.appendLog).toHaveBeenCalledWith('runtime', 'error', expect.stringContaining('status=rollback-failed'));
  });

  it('waits for native Watch readiness after route command acknowledgement', async () => {
    const ready = cloneAudio();
    ready.inbound.streamBound = true;
    mocks.startRoute.mockResolvedValue({ ...ready, inbound: { ...ready.inbound, streamBound: false } });
    mocks.waitForWatchReady.mockResolvedValue(ready);
    const { api, controller } = makeHarness();

    await api.launchScene(makeLaunchOptions('watch'));

    expect(mocks.startRoute).toHaveBeenCalledWith('inbound', expect.any(Object));
    expect(mocks.waitForWatchReady).toHaveBeenCalledWith(100, expect.any(AbortSignal));
    expect(controller.setAudioSnapshot).toHaveBeenLastCalledWith(ready);
    expect(mocks.appendLog).toHaveBeenCalledWith('runtime', 'info', '[WatchLaunch] native route ready', expect.any(String));
  });

  it('rejects a new launch while a previous native route is stopping', async () => {
    const options = makeLaunchOptions('watch');
    options.audioSnapshot.inbound.captureState = 'stopping';
    const { api, controller } = makeHarness();

    await api.launchScene(options);

    expect(controller.pushNotification).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('正在停止') }));
    expect(controller.runBusyAction).not.toHaveBeenCalled();
  });

  it('attributes a rejected Watch IPC command with snapshot and log evidence', async () => {
    mocks.startRoute.mockRejectedValue(new Error('capture command rejected'));
    mocks.getAudioSnapshot.mockResolvedValue(cloneAudio());
    mocks.recentLogs.mockResolvedValue([{
      id: 'route-marker',
      category: 'runtime',
      level: 'warning',
      summary: 'watch_mode.route_error',
      detail: null,
      emittedAt: '2026-07-25T00:00:00.000Z',
    }]);
    const { api, controller } = makeHarness();

    await api.launchScene(makeLaunchOptions('watch'));

    expect(mocks.getAudioSnapshot).toHaveBeenCalled();
    expect(mocks.recentLogs).toHaveBeenCalled();
    expect(controller.sceneLaunchFailureMessage).toHaveBeenCalledWith('watch', 'inbound-route', expect.any(Error));
    expect(controller.pushNotification).toHaveBeenCalledWith(expect.objectContaining({ level: 'error' }));
  });

  it('attributes a Watch rejection even when native snapshot IPC also rejects', async () => {
    mocks.startRoute.mockRejectedValue('route rejected');
    mocks.getAudioSnapshot.mockRejectedValue('snapshot rejected');
    const { api, controller } = makeHarness();

    await api.launchScene(makeLaunchOptions('watch'));

    expect(mocks.appendLog).toHaveBeenCalledWith('runtime', 'warning', expect.stringContaining('snapshot rejected'));
    expect(controller.sceneLaunchFailureMessage).toHaveBeenCalledWith('watch', 'inbound-route', expect.any(Error));
  });

  it('degrades Watch startup to subtitles-only after a Bridge-class IPC error', async () => {
    mocks.watchNeedsBridge.mockReturnValue(true);
    mocks.startRoute
      .mockRejectedValueOnce(new Error('bridge source pipe unavailable'))
      .mockResolvedValueOnce(cloneAudio());
    const { api, controller } = makeHarness();
    controller.confirmWatchFallback.mockResolvedValue(true);

    await api.launchScene(makeLaunchOptions('watch'));

    expect(controller.updateDeviceDraft).toHaveBeenCalledWith(expect.objectContaining({
      feedbackLoopPrevention: 'none',
      outputSpeechEnabled: false,
    }));
    expect(controller.updateSpeechDraft).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
    expect(controller.pushNotification).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('仅字幕模式') }));
  });

  it('uses AEC fallback when subtitles-only is declined and reports a second IPC failure', async () => {
    mocks.watchNeedsBridge.mockReturnValue(true);
    mocks.startRoute
      .mockRejectedValueOnce(new Error('driver bridge failed'))
      .mockRejectedValueOnce(new Error('fallback capture failed'));
    mocks.getAudioSnapshot.mockRejectedValue(new Error('snapshot unavailable'));
    const { api, controller } = makeHarness();
    controller.confirmWatchFallback.mockResolvedValue(false);

    await api.launchScene(makeLaunchOptions('watch'));

    expect(controller.updateDeviceDraft).toHaveBeenCalledWith(expect.objectContaining({
      feedbackLoopPrevention: 'echo-cancel',
      aecEnabled: true,
    }));
    expect(controller.pushNotification).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('aec 降级也未能完成'),
    }));
    expect(mocks.appendLog).toHaveBeenCalledWith('runtime', 'error', '[WatchFallback] fallback failed', expect.any(String));
  });

  it('runs every native IPC stage in a successful AEC fallback', async () => {
    mocks.watchNeedsBridge.mockReturnValue(true);
    planState.fallbackStages = ['inbound-route', 'outbound-route', 'translate-worker', 'speech-dispatch', 'subtitle-overlay'];
    mocks.startRoute.mockRejectedValueOnce(new Error('virtual bridge unavailable'));
    const { api, controller } = makeHarness();
    controller.confirmWatchFallback.mockResolvedValue(false);

    await api.launchScene(makeLaunchOptions('watch'));

    expect(mocks.startRoute.mock.calls.map(([direction]) => direction)).toEqual(['inbound', 'inbound']);
    expect(mocks.startTranslation).toHaveBeenCalled();
    expect(mocks.startSpeech).toHaveBeenCalled();
    expect(mocks.showOverlay).toHaveBeenCalled();
    expect(controller.pushNotification).toHaveBeenCalledWith(expect.objectContaining({ level: 'warning' }));
  });

  it('keeps fallback executor no-op Bridge and preconnect hooks safe under a parallel plan', async () => {
    mocks.watchNeedsBridge.mockReturnValue(true);
    planState.fallbackParallelPreconnect = true;
    planState.fallbackStages = ['bridge-ready', 'omni-preconnect', 'inbound-route'];
    mocks.startRoute.mockRejectedValueOnce(new Error('bridge startup failed')).mockResolvedValueOnce(cloneAudio());
    const { api, controller } = makeHarness();

    await api.launchScene(makeLaunchOptions('watch'));

    expect(controller.pushNotification).toHaveBeenCalledWith(expect.objectContaining({ level: 'warning' }));
  });

  it('compensates non-audio stages in both fallback and main launch plans', async () => {
    mocks.watchNeedsBridge.mockReturnValue(true);
    planState.fallbackStages = ['speech-dispatch', 'inbound-route'];
    mocks.startRoute.mockRejectedValueOnce(new Error('bridge startup failed')).mockRejectedValueOnce(new Error('fallback route failed'));
    await makeHarness().api.launchScene(makeLaunchOptions('watch'));

    mocks.watchNeedsBridge.mockReturnValue(false);
    planState.fallbackStages = null;
    planState.mainStages = ['outbound-route', 'inbound-route'];
    mocks.startRoute.mockReset().mockResolvedValueOnce(cloneAudio()).mockRejectedValueOnce(new Error('main route failed'));
    await makeHarness().api.launchScene(makeLaunchOptions('voice-room'));
    expect(mocks.stopSpeech).toHaveBeenCalled();
    expect(mocks.stopRoute).toHaveBeenCalledWith('outbound');
  });

  it.each([
    ['translate-worker', null, ['inbound']],
    ['speech-dispatch', null, ['translate', 'inbound']],
    ['subtitle-overlay', null, ['speech', 'translate', 'inbound']],
  ] as const)('rolls back completed fallback IPC stages when %s fails', async (failedStage, failedDirection, expectedStops) => {
    mocks.watchNeedsBridge.mockReturnValue(true);
    planState.fallbackStages = ['inbound-route', 'translate-worker', 'speech-dispatch', 'subtitle-overlay'];
    mocks.startRoute.mockRejectedValueOnce(new Error('bridge startup failed'));
    mocks.startRoute.mockResolvedValueOnce(cloneAudio());
    if (failedStage === 'translate-worker') mocks.startTranslation.mockRejectedValueOnce(new Error('fallback translate failed'));
    if (failedStage === 'speech-dispatch') mocks.startSpeech.mockRejectedValueOnce(new Error('fallback speech failed'));
    if (failedStage === 'subtitle-overlay') mocks.showOverlay.mockRejectedValueOnce(new Error('fallback overlay failed'));
    const { api, controller } = makeHarness();
    controller.confirmWatchFallback.mockResolvedValue(false);

    await api.launchScene(makeLaunchOptions('watch'));

    const stopLabels = [
      ...mocks.stopSpeech.mock.calls.map(() => 'speech'),
      ...mocks.stopTranslation.mock.calls.map(() => 'translate'),
      ...mocks.stopRoute.mock.calls.map(([direction]) => direction),
    ];
    expect(stopLabels).toEqual(expect.arrayContaining([...expectedStops]));
    if (failedDirection) expect(mocks.startRoute).toHaveBeenCalledWith(failedDirection, expect.any(Object));
    expect(controller.pushNotification).toHaveBeenCalledWith(expect.objectContaining({ level: 'error' }));
  });

  it('reports subtitle overlay IPC failure after transactional route rollback', async () => {
    const options = makeLaunchOptions('voice-room');
    options.overlayVisible = false;
    mocks.showOverlay.mockRejectedValue(new Error('overlay IPC failed'));
    const { api, controller } = makeHarness();

    await api.launchScene(options);

    expect(mocks.stopRoute.mock.calls.map(([direction]) => direction)).toEqual(['outbound', 'inbound']);
    expect(controller.pushNotification).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('字幕浮窗打开失败'),
    }));
  });

  it('rolls speech and translation IPC back when overlay opening fails late', async () => {
    const options = makeLaunchOptions('voice-room');
    options.isOmniModel = false;
    options.speechPatch = { enabled: true };
    options.overlayVisible = false;
    mocks.showOverlay.mockRejectedValue(new Error('overlay failed after speech'));
    const { api } = makeHarness();

    await api.launchScene(options);

    expect(mocks.stopSpeech).toHaveBeenCalled();
    expect(mocks.stopTranslation).toHaveBeenCalled();
  });

  it('times out a hung conversation IPC launch and runs all native cleanup commands', async () => {
    vi.useFakeTimers();
    mocks.startRoute.mockImplementation(() => new Promise(() => undefined));
    mocks.getAudioSnapshot.mockResolvedValue(cloneAudio());
    const { api, controller } = makeHarness();

    const launch = api.launchScene(makeLaunchOptions('voice-room'));
    await vi.advanceTimersByTimeAsync(100);
    await launch;

    expect(mocks.cancelPreconnect).toHaveBeenCalled();
    expect(mocks.stopSpeech).toHaveBeenCalled();
    expect(mocks.stopTranslation).toHaveBeenCalled();
    expect(mocks.stopRoute.mock.calls.map(([direction]) => direction)).toEqual(['outbound', 'inbound']);
    expect(controller.pushNotification).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('timeout') }));
    vi.useRealTimers();
  });

  it('logs a timeout cleanup callback failure without replacing the launch timeout', async () => {
    vi.useFakeTimers();
    mocks.startRoute.mockImplementation(() => new Promise(() => undefined));
    mocks.appendLog.mockImplementation((_category, _level, summary) => {
      if (summary === '[SceneLaunch] timeout') throw new Error('timeout diagnostics failed');
    });
    const { api } = makeHarness();

    const launch = api.launchScene(makeLaunchOptions('voice-room'));
    await vi.advanceTimersByTimeAsync(100);
    await launch;
    await Promise.resolve();

    expect(mocks.appendLog).toHaveBeenCalledWith('runtime', 'warning', expect.stringContaining('timeout cleanup failed'));
    vi.useRealTimers();
  });

  it.each([
    ['inbound-route', 'route'],
    ['outbound-route', 'route'],
    ['translate-worker', 'translate'],
    ['speech-dispatch', 'speech'],
    ['subtitle-overlay', 'overlay'],
  ] as const)('compensates a late %s IPC result that resolves after the outer timeout', async (lateStage, kind) => {
    vi.useFakeTimers();
    const options = makeLaunchOptions('voice-room');
    options.isOmniModel = lateStage === 'translate-worker' || lateStage === 'speech-dispatch' ? false : true;
    options.speechPatch = { enabled: lateStage === 'speech-dispatch' };
    options.overlayVisible = lateStage !== 'subtitle-overlay';
    const delayed = () => new Promise<AudioRuntimeSnapshot>((resolve) => {
      setTimeout(() => resolve(cloneAudio()), 150);
    });
    const delayedRuntime = () => new Promise<RuntimeSnapshot>((resolve) => {
      setTimeout(() => resolve(cloneRuntime()), 150);
    });
    if (lateStage === 'inbound-route') mocks.startRoute.mockImplementationOnce(delayed);
    if (lateStage === 'outbound-route') mocks.startRoute.mockResolvedValueOnce(cloneAudio()).mockImplementationOnce(delayed);
    if (kind === 'translate') mocks.startTranslation.mockImplementationOnce(delayed);
    if (kind === 'speech') mocks.startSpeech.mockImplementationOnce(delayed);
    if (kind === 'overlay') mocks.showOverlay.mockImplementationOnce(delayedRuntime);
    const { api } = makeHarness();

    const launch = api.launchScene(options);
    await vi.advanceTimersByTimeAsync(100);
    await launch;
    await vi.advanceTimersByTimeAsync(50);

    expect(mocks.appendLog).toHaveBeenCalledWith('runtime', 'warning', '[SceneLaunch] timeout', expect.any(String));
    vi.useRealTimers();
  });
});
