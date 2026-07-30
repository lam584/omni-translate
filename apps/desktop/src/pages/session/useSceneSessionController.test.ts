import { beforeEach, describe, expect, it, vi } from 'vitest';

import { appConfigDraftMock } from '../../mocks/app-config';
import { audioRuntimeSnapshotMock } from '../../mocks/audio-runtime';
import { runtimeSnapshotMock } from '../../mocks/runtime-shell';
import type { AudioRuntimeSnapshot } from '../../schema/audio-runtime';
import type { RuntimeSnapshot } from '../../schema/runtime-core';
import type { ResolvedRealtimeProfile } from '../../utils/realtime-profile';

type LaunchRealtimeProfile = Pick<ResolvedRealtimeProfile, 'nativeTranslation' | 'speechDispatchPolicy'>;
const nativeRealtimeProfile: LaunchRealtimeProfile = { nativeTranslation: true, speechDispatchPolicy: 'native-audio' };
const classicRealtimeProfile: LaunchRealtimeProfile = { nativeTranslation: false, speechDispatchPolicy: 'subtitle-tts' };

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
  toggleOverlay: vi.fn(),
  startRoute: vi.fn(),
  waitForWatchReady: vi.fn(),
  startSpeech: vi.fn(),
  startTranslation: vi.fn(),
  stopRoute: vi.fn(),
  stopSpeech: vi.fn(),
  stopTranslation: vi.fn(),
}));

// Plan topology comes from the REAL buildSceneLaunchPlan/buildWatchFallbackPlan
// in every test (fabricated stage arrays once asserted flows real plans never
// produce — the b796174 lesson). The single exception: current real plans hard
// -code parallelOmniPreconnect=false, so the executor's preconnect-callback
// wiring in the controller is unreachable through real topology. Two wiring
// tests below opt into `forceParallelPreconnect` to keep that seam covered;
// whether that code path should instead be removed is part of the phase-6
// coverage-threshold decision memo.
const planState = vi.hoisted(() => ({
  forceParallelPreconnect: false,
}));

vi.mock('../../runtime/audio-runtime', () => ({
  cancelOmniPreconnectRuntime: (...args: unknown[]) => mocks.cancelPreconnect(...args),
  getAudioRuntimeSnapshotRuntime: (...args: unknown[]) => mocks.getAudioSnapshot(...args),
  preconnectOmniRealtimeRuntime: (...args: unknown[]) => mocks.preconnect(...args),
  showSubtitleOverlayWindow: (...args: unknown[]) => mocks.showOverlay(...args),
  toggleSubtitleOverlayWindow: (...args: unknown[]) => mocks.toggleOverlay(...args),
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

vi.mock('../../runtime/bridge-runtime', () => ({
  refreshBridgeRuntime: (...args: unknown[]) => mocks.refreshBridge(...args),
  installDriverRuntime: (...args: unknown[]) => mocks.installBridge(...args),
  repairDriverRuntime: (...args: unknown[]) => mocks.repairBridge(...args),
  startBridgeServiceRuntime: (...args: unknown[]) => mocks.startBridge(...args),
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
      if (planState.forceParallelPreconnect) {
        plan.parallelOmniPreconnect = true;
        plan.stages = ['bridge-ready', 'omni-preconnect', ...plan.stages.filter((stage) => stage !== 'bridge-ready')];
      }
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
    realtimeProfile: nativeRealtimeProfile,
    speechPatch: { enabled: false },
    secondarySubtitleTranslationEnabled: false,
  };
}

/** Runs stopAll with the controller's spies wired in as the callbacks. */
async function runStopAll(
  { api, controller }: ReturnType<typeof makeHarness>,
  options: { audioSnapshot?: AudioRuntimeSnapshot; hasSpeechActivity?: boolean } = {},
) {
  await api.stopAll({
    audioSnapshot: options.audioSnapshot ?? cloneAudio(),
    hasSpeechActivity: options.hasSpeechActivity ?? false,
    setAudioSnapshot: controller.setAudioSnapshot,
    pushNotification: controller.pushNotification,
    runBusyAction: controller.runBusyAction,
  });
}

/** Launches under fake timers, runs past the outer timeout, and asserts the timeout log. */
async function launchPastOuterTimeout(options: ReturnType<typeof makeLaunchOptions>) {
  const harness = makeHarness();
  const launch = harness.api.launchScene(options);
  await vi.advanceTimersByTimeAsync(100);
  await launch;
  await vi.advanceTimersByTimeAsync(50);
  expect(mocks.appendLog).toHaveBeenCalledWith('runtime', 'warning', '[SceneLaunch] timeout', expect.any(String));
  return harness;
}

beforeEach(() => {
  vi.useRealTimers();
  for (const mock of Object.values(mocks)) mock.mockReset();
  planState.forceParallelPreconnect = false;
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
  mocks.toggleOverlay.mockResolvedValue(cloneRuntime());
  mocks.refreshBridge.mockResolvedValue(readyRuntime());
  mocks.installBridge.mockResolvedValue(readyRuntime());
  mocks.repairBridge.mockResolvedValue(readyRuntime());
  mocks.startBridge.mockResolvedValue(readyRuntime());
});

describe('useSceneSessionController IPC orchestration', () => {
  it('classifies Bridge startup errors without treating unrelated or empty failures as Bridge errors', () => {
    expect(sceneSessionControllerHelpers.isBridgeStartupError(new Error('WASAPI driver failed'))).toBe(true);
    expect(sceneSessionControllerHelpers.isBridgeStartupError('ordinary failure')).toBe(false);
    expect(sceneSessionControllerHelpers.isBridgeStartupError(null)).toBe(false);
  });

  it('preserves the launch timeout when asynchronous cleanup itself fails', async () => {
    vi.useFakeTimers();
    const timed = sceneSessionControllerHelpers.withSceneLaunchTimeout(
      new Promise<never>(() => undefined), 10, 'deadline', async () => { throw 'cleanup string'; },
    );
    const rejected = expect(timed).rejects.toThrow('deadline');
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    expect(mocks.appendLog).toHaveBeenCalledWith('runtime', 'warning', expect.stringContaining('cleanup string'));
    vi.useRealTimers();
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

  it('logs non-Error Bridge refresh and stop failures and skips stops only for truly idle routes', async () => {
    mocks.watchNeedsBridge.mockReturnValue(true);
    mocks.refreshBridge.mockRejectedValue('refresh string');
    const cached = readyRuntime();
    const { api, controller } = makeHarness(cached);
    await api.ensureBridgeReady('voice-room', structuredClone(appConfigDraftMock));
    expect(mocks.appendLog).toHaveBeenCalledWith('runtime', 'warning', expect.stringContaining('refresh string'));

    const audio = cloneAudio();
    audio.inbound.streamBound = false; audio.inbound.captureState = 'idle';
    audio.outbound.streamBound = false; audio.outbound.captureState = 'idle';
    audio.speech.dispatchState = 'idle';
    mocks.getAudioSnapshot.mockRejectedValue('snapshot stop string');
    mocks.stopTranslation.mockRejectedValue('translation stop string');
    await api.stopAll({ audioSnapshot: audio, hasSpeechActivity: false, setAudioSnapshot: controller.setAudioSnapshot,
      pushNotification: controller.pushNotification, runBusyAction: controller.runBusyAction as never });
    expect(controller.pushNotification).toHaveBeenCalledWith(expect.objectContaining({ level: 'error' }));
    expect(mocks.stopSpeech).not.toHaveBeenCalled();
    expect(mocks.stopRoute).not.toHaveBeenCalled();
  });

  it.each([
    ['armed'],
    ['buffering'],
  ] as const)('stops a converging watch route (captureState=%s, streamBound=false) instead of skipping it', async (captureState) => {
    // Regression: the accepted-but-not-bound convergence window (native
    // fast-watch acknowledged, stream still binding) left capture/translate
    // running after the user pressed stop, because stopAll only stopped
    // streamBound routes.
    const converging = cloneAudio();
    converging.inbound.streamBound = false;
    converging.inbound.captureState = captureState;
    converging.outbound.streamBound = false;
    converging.outbound.captureState = 'idle';
    converging.speech.dispatchState = 'idle';
    mocks.getAudioSnapshot.mockResolvedValue(converging);
    const { api, controller } = makeHarness();

    await runStopAll({ api, controller });

    expect(mocks.stopRoute.mock.calls.map(([direction]) => direction)).toEqual(['inbound']);
    // The optimistic pre-stop snapshot must show the converging route as stopping.
    const optimistic = controller.setAudioSnapshot.mock.calls
      .map(([snapshot]) => snapshot as AudioRuntimeSnapshot)
      .find((snapshot) => snapshot.inbound.captureState === 'stopping');
    expect(optimistic?.inbound.captureState).toBe('stopping');
    expect(optimistic?.inbound.streamBound).toBe(false);
  });

  it('uses caller speech activity when native speech is idle', async () => {
    const audio = cloneAudio(); audio.inbound.streamBound = false; audio.outbound.streamBound = false; audio.speech.dispatchState = 'idle';
    mocks.getAudioSnapshot.mockResolvedValue(audio);
    const { api, controller } = makeHarness();
    await runStopAll({ api, controller }, { audioSnapshot: audio, hasSpeechActivity: true });
    expect(mocks.stopSpeech).toHaveBeenCalledWith();
  });

  it('reports a fallback failure and rolls the AEC fallback back when its speech stage fails', async () => {
    // Real fallback topology: subtitles-only → [inbound-route]; AEC (speech
    // enabled) → [inbound-route, speech-dispatch].
    mocks.watchNeedsBridge.mockReturnValue(true);
    mocks.startRoute.mockRejectedValueOnce('bridge initial string').mockRejectedValueOnce('fallback route string');
    const first = makeHarness(); first.controller.confirmWatchFallback.mockResolvedValue(false);
    await first.api.launchScene(makeLaunchOptions('watch'));
    expect(mocks.appendLog).toHaveBeenCalledWith('runtime', 'error', '[WatchFallback] fallback failed', expect.any(String));

    mocks.startRoute.mockReset().mockRejectedValueOnce(new Error('bridge initial')).mockResolvedValueOnce(cloneAudio());
    mocks.startSpeech.mockRejectedValueOnce(new Error('fallback speech failed'));
    const second = makeHarness(); second.controller.confirmWatchFallback.mockResolvedValue(false);
    await second.api.launchScene(makeLaunchOptions('watch'));
    // The AEC fallback's speech-dispatch stage failed after inbound-route
    // completed: the completed route is rolled back.
    expect(mocks.stopRoute.mock.calls.map(([direction]) => direction)).toContain('inbound');
    expect(second.controller.pushNotification).toHaveBeenCalledWith(expect.objectContaining({ level: 'error' }));
  });

  it('migrates legacy Watch drafts on the real bridge-free plan and warns on non-Error preconnect failures', async () => {
    // Use the real watch plan: its stages never include 'bridge-ready', so the
    // legacy draft correction must run outside the bridge-ready callback.
    const watch = makeHarness();
    await watch.api.launchScene(makeLaunchOptions('watch'));
    expect(watch.controller.updateDeviceDraft).toHaveBeenCalledWith(expect.objectContaining({
      routeMode: 'watch',
      feedbackLoopPrevention: 'echo-cancel',
      aecEnabled: true,
      virtualMicOutputEnabled: false,
    }));
    expect(watch.controller.updateSpeechDraft).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
    expect(watch.controller.updateDiagnosticsReady).toHaveBeenCalledWith('watch');

    planState.forceParallelPreconnect = true;
    mocks.preconnect.mockRejectedValueOnce('preconnect string');
    const parallel = makeHarness();
    await parallel.api.launchScene(makeLaunchOptions('voice-room'));
    expect(parallel.controller.pushNotification).toHaveBeenCalledWith(expect.objectContaining({ level: 'warning' }));
  });

  it('rolls back main speech and reports a non-Error overlay failure', async () => {
    // Real voice-room plan with speech + overlay: [bridge-ready, inbound-route,
    // outbound-route, translate-worker, speech-dispatch, subtitle-overlay].
    const options = makeLaunchOptions('voice-room');
    options.realtimeProfile = classicRealtimeProfile;
    options.speechPatch = { enabled: true };
    options.overlayVisible = false;
    mocks.showOverlay.mockRejectedValueOnce('overlay string');
    const { api, controller } = makeHarness();
    await api.launchScene(options);
    expect(mocks.stopSpeech).toHaveBeenCalledWith();
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
    expect(mocks.installBridge).toHaveBeenCalledWith(expect.objectContaining({ devices: expect.any(Object) }));
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
    expect(mocks.startBridge).toHaveBeenCalledWith(expect.objectContaining({ devices: expect.any(Object) }));
    expect(controller.setRuntimeSnapshot).toHaveBeenLastCalledWith(started);
  });

  it('stops every active native IPC pipeline and publishes each returned snapshot', async () => {
    const active = cloneAudio();
    active.inbound.streamBound = true;
    active.outbound.streamBound = true;
    active.speech.dispatchState = 'playing';
    mocks.getAudioSnapshot.mockResolvedValue(active);
    const { api, controller } = makeHarness();

    await runStopAll({ api, controller });

    expect(mocks.stopSpeech).toHaveBeenCalledTimes(1);
    expect(mocks.stopTranslation).toHaveBeenCalledTimes(1);
    expect(mocks.stopRoute.mock.calls.map(([direction]) => direction)).toEqual(['outbound', 'inbound']);
    expect(controller.setAudioSnapshot).toHaveBeenLastCalledWith(audioRuntimeSnapshotMock);
  });

  it('continues stop compensation and reports IPC failures when snapshot refresh and a stop step fail', async () => {
    mocks.getAudioSnapshot.mockRejectedValue(new Error('snapshot IPC failed'));
    mocks.stopTranslation.mockRejectedValue('translation stop failed');
    const { api, controller } = makeHarness();

    await runStopAll({ api, controller }, { hasSpeechActivity: true });

    expect(mocks.stopSpeech).toHaveBeenCalledTimes(1);
    expect(controller.pushNotification).toHaveBeenCalledWith(expect.objectContaining({
      source: 'session',
      message: expect.stringContaining('translation stop failed'),
    }));
    expect(mocks.appendLog).toHaveBeenCalledWith('runtime', 'warning', expect.stringContaining('snapshot IPC failed'));
    mocks.getAudioSnapshot.mockResolvedValue(cloneAudio());
    mocks.stopTranslation.mockRejectedValue(new Error('translation error'));
    await runStopAll({ api, controller });
    expect(controller.pushNotification).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('translation error') }));
  });

  it('executes every conversation IPC stage and opens the subtitle overlay', async () => {
    const options = makeLaunchOptions('voice-room');
    options.realtimeProfile = classicRealtimeProfile;
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
    planState.forceParallelPreconnect = true;
    mocks.startRoute.mockRejectedValue(new Error('route failed after preconnect'));
    const { api } = makeHarness();

    await api.launchScene(makeLaunchOptions('voice-room'));

    expect(mocks.preconnect).toHaveBeenCalledWith(expect.objectContaining({ devices: expect.any(Object) }));
    expect(mocks.cancelPreconnect).toHaveBeenCalledWith();
  });

  it('logs and continues when parallel Omni preconnect IPC rejects', async () => {
    planState.forceParallelPreconnect = true;
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
    // Real voice-room non-Omni plan reaches translate-worker after both
    // routes; a failing stopRoute during rollback yields rollback-failed.
    const options = makeLaunchOptions('voice-room');
    options.realtimeProfile = classicRealtimeProfile;
    mocks.startTranslation.mockRejectedValue(new Error('translation failed'));
    mocks.stopRoute.mockRejectedValue(new Error('rollback failed'));
    const { api } = makeHarness();
    await api.launchScene(options);
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

    expect(mocks.getAudioSnapshot).toHaveBeenCalledWith();
    expect(mocks.recentLogs).toHaveBeenCalledWith();
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

  it('runs every real AEC-fallback stage after a Bridge-class failure', async () => {
    // Real AEC fallback plan: [inbound-route, speech-dispatch] — no bridge
    // stage, no translate worker, no renderer-owned overlay.
    mocks.watchNeedsBridge.mockReturnValue(true);
    mocks.startRoute.mockRejectedValueOnce(new Error('virtual bridge unavailable'));
    const { api, controller } = makeHarness();
    controller.confirmWatchFallback.mockResolvedValue(false);

    await api.launchScene(makeLaunchOptions('watch'));

    expect(mocks.startRoute.mock.calls.map(([direction]) => direction)).toEqual(['inbound', 'inbound']);
    expect(mocks.startSpeech).toHaveBeenCalledWith(expect.objectContaining({ speech: expect.any(Object) }));
    expect(mocks.startTranslation).not.toHaveBeenCalled();
    expect(mocks.showOverlay).not.toHaveBeenCalled();
    expect(controller.pushNotification).toHaveBeenCalledWith(expect.objectContaining({ level: 'warning' }));
  });

  it('compensates completed non-audio stages when a real voice-room launch fails late', async () => {
    // Full real plan: bridge-ready, inbound, outbound, translate, speech,
    // overlay. The overlay fails, so speech + translate + both routes roll
    // back in reverse order.
    const options = makeLaunchOptions('voice-room');
    options.realtimeProfile = classicRealtimeProfile;
    options.speechPatch = { enabled: true };
    options.overlayVisible = false;
    mocks.showOverlay.mockRejectedValueOnce(new Error('overlay failed late'));
    const { api, controller } = makeHarness();

    await api.launchScene(options);

    expect(mocks.stopSpeech).toHaveBeenCalledWith();
    expect(mocks.stopTranslation).toHaveBeenCalledWith();
    expect(mocks.stopRoute.mock.calls.map(([direction]) => direction)).toEqual(['outbound', 'inbound']);
    expect(controller.pushNotification).toHaveBeenCalledWith(expect.objectContaining({ level: 'error' }));
  });

  it('rolls the completed fallback route back when the AEC fallback speech stage fails', async () => {
    mocks.watchNeedsBridge.mockReturnValue(true);
    mocks.startRoute.mockRejectedValueOnce(new Error('bridge startup failed'));
    mocks.startRoute.mockResolvedValueOnce(cloneAudio());
    mocks.startSpeech.mockRejectedValueOnce(new Error('fallback speech failed'));
    const { api, controller } = makeHarness();
    controller.confirmWatchFallback.mockResolvedValue(false);

    await api.launchScene(makeLaunchOptions('watch'));

    expect(mocks.stopRoute.mock.calls.map(([direction]) => direction)).toContain('inbound');
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
    options.realtimeProfile = classicRealtimeProfile;
    options.speechPatch = { enabled: true };
    options.overlayVisible = false;
    mocks.showOverlay.mockRejectedValue(new Error('overlay failed after speech'));
    const { api } = makeHarness();

    await api.launchScene(options);

    expect(mocks.stopSpeech).toHaveBeenCalledWith();
    expect(mocks.stopTranslation).toHaveBeenCalledWith();
  });

  it('times out a hung conversation IPC launch and runs all native cleanup commands', async () => {
    vi.useFakeTimers();
    mocks.startRoute.mockImplementation(() => new Promise(() => undefined));
    mocks.getAudioSnapshot.mockResolvedValue(cloneAudio());
    const { api, controller } = makeHarness();

    const launch = api.launchScene(makeLaunchOptions('voice-room'));
    await vi.advanceTimersByTimeAsync(100);
    await launch;

    expect(mocks.cancelPreconnect).toHaveBeenCalledWith();
    expect(mocks.stopSpeech).toHaveBeenCalledWith();
    expect(mocks.stopTranslation).toHaveBeenCalledWith();
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
  ] as const)('stops a late %s IPC result after the outer timeout and suppresses its stale snapshot', async (lateStage, kind) => {
    vi.useFakeTimers();
    const options = makeLaunchOptions('voice-room');
    options.realtimeProfile = lateStage === 'translate-worker' || lateStage === 'speech-dispatch'
      ? classicRealtimeProfile
      : nativeRealtimeProfile;
    options.speechPatch = { enabled: lateStage === 'speech-dispatch' };
    options.overlayVisible = true;
    const lateSnapshot = cloneAudio();
    lateSnapshot.inbound.framesCaptured = 999;
    const stopSnapshot = cloneAudio();
    stopSnapshot.inbound.framesCaptured = 222;
    mocks.stopRoute.mockResolvedValue(stopSnapshot);
    mocks.stopSpeech.mockResolvedValue(stopSnapshot);
    mocks.stopTranslation.mockResolvedValue(stopSnapshot);
    const delayed = () => new Promise<AudioRuntimeSnapshot>((resolve) => {
      setTimeout(() => resolve(lateSnapshot), 150);
    });
    if (lateStage === 'inbound-route') mocks.startRoute.mockImplementationOnce(delayed);
    if (lateStage === 'outbound-route') mocks.startRoute.mockResolvedValueOnce(cloneAudio()).mockImplementationOnce(delayed);
    if (kind === 'translate') mocks.startTranslation.mockImplementationOnce(delayed);
    if (kind === 'speech') mocks.startSpeech.mockImplementationOnce(delayed);

    const { controller } = await launchPastOuterTimeout(options);

    // The late stage's own stop command must run when its start resolves after
    // the timeout, and its started-state snapshot must never be published.
    const expectedStop = lateStage === 'inbound-route' ? ['inbound']
      : lateStage === 'outbound-route' ? ['outbound'] : [];
    for (const direction of expectedStop) {
      expect(mocks.stopRoute.mock.calls.map(([d]) => d)).toContain(direction);
    }
    if (kind === 'translate') expect(mocks.stopTranslation).toHaveBeenCalledWith();
    if (kind === 'speech') expect(mocks.stopSpeech).toHaveBeenCalledWith();
    expect(controller.setAudioSnapshot).not.toHaveBeenCalledWith(lateSnapshot);
    // Snapshot order: the last published audio snapshot is the late stage's
    // stop result, not any started-state snapshot.
    const lastPublished = controller.setAudioSnapshot.mock.calls.at(-1)?.[0] as AudioRuntimeSnapshot;
    expect(lastPublished.inbound.framesCaptured).toBe(222);
    vi.useRealTimers();
  });

  it('hides a subtitle overlay that opens after the outer timeout and suppresses its runtime snapshot', async () => {
    // Regression: the timeout compensation only stopped route/translate/speech;
    // a late-resolving showSubtitleOverlayWindow left the overlay visible with
    // no session behind it.
    vi.useFakeTimers();
    const options = makeLaunchOptions('voice-room');
    options.realtimeProfile = nativeRealtimeProfile;
    options.speechPatch = { enabled: false };
    options.overlayVisible = false;
    const lateRuntime = cloneRuntime();
    lateRuntime.sessionId = 'late-overlay-session';
    const hiddenRuntime = cloneRuntime();
    hiddenRuntime.sessionId = 'overlay-hidden-session';
    mocks.showOverlay.mockImplementationOnce(() => new Promise<RuntimeSnapshot>((resolve) => {
      setTimeout(() => resolve(lateRuntime), 150);
    }));
    mocks.toggleOverlay.mockResolvedValue(hiddenRuntime);

    const { controller } = await launchPastOuterTimeout(options);

    expect(mocks.toggleOverlay).toHaveBeenCalledWith();
    expect(controller.setRuntimeSnapshot).not.toHaveBeenCalledWith(lateRuntime);
    expect(controller.setRuntimeSnapshot).toHaveBeenCalledWith(hiddenRuntime);
    vi.useRealTimers();
  });

});
