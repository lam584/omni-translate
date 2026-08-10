import { describe, expect, it } from 'vitest';
import { audioRuntimeSnapshotMock } from '../mocks/audio-runtime';
import { appConfigDraftMock } from '../mocks/app-config';
import { runtimeSnapshotMock } from '../mocks/runtime-shell';
import { PENDING_PROBE_CHECKED_AT } from '../schema/provider-probe';
import { formatSceneReadinessLabel, getAllSceneReadiness, getOverallReadiness, getSceneTone } from './scene-readiness';

/** Clones the shared config/runtime/audio mock trio for one readiness case. */
function makeReadinessInputs() {
  return {
    configDraft: structuredClone(appConfigDraftMock),
    runtimeSnapshot: structuredClone(runtimeSnapshotMock),
    audioSnapshot: structuredClone(audioRuntimeSnapshotMock),
  };
}

function markAecReady(audioSnapshot: typeof audioRuntimeSnapshotMock) {
  audioSnapshot.aecBackend = 'webrtc-aec3';
  audioSnapshot.aecStatus = 'ready';
  audioSnapshot.aecFailureDetail = null;
}

/** Scene readiness for a config against pristine runtime/audio snapshots. */
function scenesFor(configDraft: typeof appConfigDraftMock) {
  return getAllSceneReadiness(configDraft, structuredClone(runtimeSnapshotMock), structuredClone(audioRuntimeSnapshotMock));
}

/** Conversation scenes with a live desktop bridge and both routes bound. */
function conversationScenes(options: {
  feedbackLoopPrevention: (typeof appConfigDraftMock)['devices']['feedbackLoopPrevention'];
  aecEnabled: boolean;
}) {
  const { configDraft, runtimeSnapshot, audioSnapshot } = makeReadinessInputs();
  runtimeSnapshot.bridgeStatus = 'tauri-shell';
  runtimeSnapshot.bridge.bridgeState = 'running';
  audioSnapshot.inbound.streamBound = true;
  audioSnapshot.outbound.streamBound = true;
  markAecReady(audioSnapshot);
  configDraft.devices.feedbackLoopPrevention = options.feedbackLoopPrevention;
  configDraft.devices.aecEnabled = options.aecEnabled;
  return getAllSceneReadiness(configDraft, runtimeSnapshot, audioSnapshot);
}

/** Watch-mode scenes in the desktop shell under the given bridge state and config. */
function watchScenesWithBridgeConfig(options: {
  bridgeState: 'running' | 'stopped';
  feedbackLoopPrevention: (typeof appConfigDraftMock)['devices']['feedbackLoopPrevention'];
  virtualMicOutputEnabled: boolean;
  outputSpeechEnabled?: boolean;
  outputTarget?: (typeof appConfigDraftMock)['speech']['outputTarget'];
}) {
  const { configDraft, runtimeSnapshot, audioSnapshot } = makeReadinessInputs();
  runtimeSnapshot.bridgeStatus = 'tauri-shell';
  runtimeSnapshot.bridge.bridgeState = options.bridgeState;
  configDraft.devices.feedbackLoopPrevention = options.feedbackLoopPrevention;
  configDraft.devices.virtualMicOutputEnabled = options.virtualMicOutputEnabled;
  if (options.outputSpeechEnabled !== undefined) {
    configDraft.devices.outputSpeechEnabled = options.outputSpeechEnabled;
    configDraft.speech.enabled = options.outputSpeechEnabled;
  }
  if (options.outputTarget) configDraft.speech.outputTarget = options.outputTarget;
  return getAllSceneReadiness(configDraft, runtimeSnapshot, audioSnapshot);
}

/** Inputs where the watch scene is fully live: running bridge, bound inbound, visible overlay. */
function makeWatchReadyRuntimeInputs() {
  const { configDraft, runtimeSnapshot, audioSnapshot } = makeReadinessInputs();
  runtimeSnapshot.bridgeStatus = 'tauri-shell';
  runtimeSnapshot.bridge.bridgeState = 'running';
  audioSnapshot.inbound.streamBound = true;
  markAecReady(audioSnapshot);
  runtimeSnapshot.windows = runtimeSnapshot.windows.map((item) =>
    item.label === 'subtitle-overlay' ? { ...item, visible: true } : item,
  );
  return { configDraft, runtimeSnapshot, audioSnapshot };
}

describe('scene readiness', () => {
  it('shows provider verification blocker before the first verification attempt', () => {
    const configDraft = structuredClone(appConfigDraftMock);
    configDraft.providers[0].probe.profileId = 'probe-provider-dashscope-pending';
    configDraft.providers[0].probe.checkedAt = '待重新探测';
    configDraft.providers[0].status = 'draft';

    const scenes = scenesFor(configDraft);

    expect(scenes.some((scene) => scene.blockers.some((blocker) => blocker.id.endsWith('provider')))).toBe(true);
  });

  it('treats the sentinel and legacy localized pending values as unverified regardless of UI language', () => {
    for (const checkedAt of [PENDING_PROBE_CHECKED_AT, '待重新探测', 'Pending re-probe']) {
      const configDraft = structuredClone(appConfigDraftMock);
      configDraft.providers[0].probe.profileId = 'probe-dashscope-verify';
      configDraft.providers[0].probe.checkedAt = checkedAt;

      const scenes = scenesFor(configDraft);

      expect(scenes.every((scene) => scene.blockers.some((blocker) => blocker.id.endsWith('provider')))).toBe(true);
    }
  });

  it('does not show provider verification blocker after a verification attempt has been recorded', () => {
    const configDraft = structuredClone(appConfigDraftMock);
    configDraft.providers[0].probe.profileId = 'probe-dashscope-verify';
    configDraft.providers[0].probe.checkedAt = '2026-05-17T12:00:00.000Z';
    configDraft.providers[0].status = 'warning';

    const scenes = scenesFor(configDraft);

    expect(scenes.some((scene) => scene.blockers.some((blocker) => blocker.id.endsWith('provider')))).toBe(false);
  });

  it('collapses runtime-dependent blockers into a single preview blocker outside the desktop shell', () => {
    const { configDraft, runtimeSnapshot, audioSnapshot } = makeReadinessInputs();

    const scenes = getAllSceneReadiness(configDraft, runtimeSnapshot, audioSnapshot);

    expect(scenes[0]?.blockers.map((blocker) => blocker.id)).toEqual(['watch-runtime-preview']);
    expect(scenes[1]?.blockers.map((blocker) => blocker.id)).toEqual(['game-runtime-preview']);
    expect(scenes[2]?.blockers.map((blocker) => blocker.id)).toEqual(['voice-room-runtime-preview']);
  });

  it('uses a runtime error blocker instead of bridge and audio blockers when IPC bootstrap failed', () => {
    const { configDraft, runtimeSnapshot, audioSnapshot } = makeReadinessInputs();
    runtimeSnapshot.bridgeStatus = 'runtime-error';

    const scenes = getAllSceneReadiness(configDraft, runtimeSnapshot, audioSnapshot);

    expect(scenes[1]?.blockers.map((blocker) => blocker.id)).toEqual(['game-runtime-error']);
    expect(scenes[2]?.blockers.map((blocker) => blocker.id)).toEqual(['voice-room-runtime-error']);
  });

  it('requires AEC before clearing conversation feedback blockers', () => {
    const scenes = conversationScenes({ feedbackLoopPrevention: 'none', aecEnabled: false });

    expect(scenes[1]?.blockers.some((blocker) => blocker.id === 'game-aec')).toBe(true);
    expect(scenes[2]?.blockers.some((blocker) => blocker.id === 'voice-room-aec')).toBe(true);
  });

  it('clears conversation feedback blockers when AEC is enabled', () => {
    const scenes = conversationScenes({ feedbackLoopPrevention: 'echo-cancel', aecEnabled: true });

    expect(scenes[1]?.blockers.some((blocker) => blocker.id === 'game-aec')).toBe(false);
    expect(scenes[2]?.blockers.some((blocker) => blocker.id === 'voice-room-aec')).toBe(false);
  });

  it('reports the missing virtual-microphone backend for isolated conversation routes', () => {
    for (const feedbackLoopPrevention of ['virtual-driver', 'process-exclusion'] as const) {
      const scenes = conversationScenes({ feedbackLoopPrevention, aecEnabled: false });
      expect(scenes[1]?.blockers).toContainEqual(expect.objectContaining({
        id: 'game-virtual-mic-output-unavailable',
      }));
      expect(scenes[2]?.blockers).toContainEqual(expect.objectContaining({
        id: 'voice-room-virtual-mic-output-unavailable',
      }));
      expect(scenes[1]?.blockers.some((blocker) => blocker.id === 'game-aec')).toBe(false);
      expect(scenes[2]?.blockers.some((blocker) => blocker.id === 'voice-room-aec')).toBe(false);
    }
  });

  it('accepts the Virtual Driver conversation route only when its outbound microphone capability is ready', () => {
    const { configDraft, runtimeSnapshot, audioSnapshot } = makeReadinessInputs();
    runtimeSnapshot.bridgeStatus = 'tauri-shell';
    runtimeSnapshot.bridge.bridgeState = 'running';
    Object.assign(runtimeSnapshot.bridge, {
      windowsBuildNumber: 19041,
      virtualMicOutputSupported: true,
      virtualMicOutputStatus: 'ready',
      captureEndpointName: 'Microphone (Omni Translate Virtual Microphone)',
      virtualMicFormat: '48000Hz/mono/pcm16',
    });
    audioSnapshot.inbound.streamBound = true;
    audioSnapshot.outbound.streamBound = true;
    configDraft.devices.feedbackLoopPrevention = 'virtual-driver';

    const scenes = getAllSceneReadiness(configDraft, runtimeSnapshot, audioSnapshot);

    expect(scenes[1]?.blockers.some((blocker) => blocker.id === 'game-virtual-mic-output-unavailable')).toBe(false);
    expect(scenes[2]?.blockers.some((blocker) => blocker.id === 'voice-room-virtual-mic-output-unavailable')).toBe(false);
    expect(scenes[1]?.blockers.some((blocker) => blocker.id === 'game-aec')).toBe(false);
    expect(scenes[2]?.blockers.some((blocker) => blocker.id === 'voice-room-aec')).toBe(false);
  });

  it('treats echo-cancel as the AEC3 backend even when a legacy toggle was saved false', () => {
    const scenes = conversationScenes({ feedbackLoopPrevention: 'echo-cancel', aecEnabled: false });

    expect(scenes[1]?.blockers.some((blocker) => blocker.id === 'game-aec')).toBe(false);
    expect(scenes[2]?.blockers.some((blocker) => blocker.id === 'voice-room-aec')).toBe(false);
  });

  it('keeps echo-cancel blocked while the generated AEC3 capability is unavailable', () => {
    const { configDraft, runtimeSnapshot, audioSnapshot } = makeWatchReadyRuntimeInputs();
    configDraft.devices.feedbackLoopPrevention = 'echo-cancel';
    configDraft.devices.aecEnabled = true;
    audioSnapshot.aecBackend = 'unavailable';
    audioSnapshot.aecStatus = 'unavailable';
    audioSnapshot.aecFailureDetail = 'MSVC build gate is closed';

    const scenes = getAllSceneReadiness(configDraft, runtimeSnapshot, audioSnapshot);

    expect(scenes[0]?.blockers).toContainEqual(expect.objectContaining({ id: 'watch-aec-unavailable' }));
    expect(scenes[1]?.blockers).toContainEqual(expect.objectContaining({ id: 'game-aec', title: expect.stringContaining('不可用') }));
    expect(scenes[2]?.blockers).toContainEqual(expect.objectContaining({ id: 'voice-room-aec', title: expect.stringContaining('不可用') }));
  });

  it('requires an explicit feedback route for translated Watch speech but permits subtitles-only none', () => {
    const translated = makeWatchReadyRuntimeInputs();
    translated.configDraft.devices.feedbackLoopPrevention = 'none';
    translated.configDraft.devices.outputSpeechEnabled = true;

    const translatedWatch = getAllSceneReadiness(
      translated.configDraft,
      translated.runtimeSnapshot,
      translated.audioSnapshot,
    )[0];

    expect(translatedWatch?.blockers).toContainEqual(expect.objectContaining({ id: 'watch-feedback-route-required' }));

    translated.configDraft.devices.outputSpeechEnabled = false;
    translated.configDraft.speech.enabled = false;
    const subtitlesOnlyWatch = getAllSceneReadiness(
      translated.configDraft,
      translated.runtimeSnapshot,
      translated.audioSnapshot,
    )[0];

    expect(subtitlesOnlyWatch?.blockers.some((blocker) => blocker.id === 'watch-feedback-route-required')).toBe(false);
  });

  it('adds a bridge blocker in watch mode when feedbackLoopPrevention is virtual-driver and bridge is not running', () => {
    const scenes = watchScenesWithBridgeConfig({
      bridgeState: 'stopped',
      feedbackLoopPrevention: 'virtual-driver',
      virtualMicOutputEnabled: false,
      outputTarget: 'speaker',
    });

    expect(scenes[0]?.blockers.some((blocker) => blocker.id === 'watch-bridge')).toBe(true);
  });

  it('blocks an imported Virtual Driver route below Windows build 19041 without changing the selection', () => {
    const { configDraft, runtimeSnapshot, audioSnapshot } = makeWatchReadyRuntimeInputs();
    configDraft.devices.feedbackLoopPrevention = 'virtual-driver';
    runtimeSnapshot.bridge.windowsBuildNumber = 19040;

    const watch = getAllSceneReadiness(configDraft, runtimeSnapshot, audioSnapshot)[0];

    expect(watch?.blockers).toContainEqual(expect.objectContaining({
      id: 'watch-virtual-driver-unsupported',
      title: expect.stringContaining('19041'),
    }));
    expect(configDraft.devices.feedbackLoopPrevention).toBe('virtual-driver');
  });

  it('requires a running Bridge for process exclusion without requiring a virtual driver', () => {
    const scenes = watchScenesWithBridgeConfig({
      bridgeState: 'stopped',
      feedbackLoopPrevention: 'process-exclusion',
      virtualMicOutputEnabled: false,
      outputTarget: 'speaker',
    });

    expect(scenes[0]?.blockers).toContainEqual(expect.objectContaining({
      id: 'watch-bridge',
      title: expect.stringContaining('进程级排除'),
    }));
  });

  it('blocks an unsupported process-exclusion draft without silently downgrading it', () => {
    const { configDraft, runtimeSnapshot, audioSnapshot } = makeWatchReadyRuntimeInputs();
    configDraft.devices.feedbackLoopPrevention = 'process-exclusion';
    Object.assign(runtimeSnapshot.bridge, {
      processLoopbackSupported: false,
      processLoopbackStatus: 'unsupported',
      windowsBuildNumber: 19045,
      processLoopbackMinimumWindowsBuild: 20348,
      processLoopbackFailureDetail: null,
    });

    const watch = getAllSceneReadiness(configDraft, runtimeSnapshot, audioSnapshot)[0];

    expect(watch?.blockers).toContainEqual(expect.objectContaining({
      id: 'watch-process-exclusion-unsupported',
      title: expect.stringContaining('20348'),
    }));
    expect(configDraft.devices.feedbackLoopPrevention).toBe('process-exclusion');
  });

  it('accepts process exclusion only after the capability probe is ready', () => {
    const { configDraft, runtimeSnapshot, audioSnapshot } = makeWatchReadyRuntimeInputs();
    configDraft.devices.feedbackLoopPrevention = 'process-exclusion';
    Object.assign(runtimeSnapshot.bridge, {
      processLoopbackSupported: true,
      processLoopbackStatus: 'ready',
      windowsBuildNumber: 26100,
      processLoopbackMinimumWindowsBuild: 20348,
      processLoopbackFailureDetail: null,
    });

    const watch = getAllSceneReadiness(configDraft, runtimeSnapshot, audioSnapshot)[0];

    expect(watch?.blockers.some((blocker) => blocker.id.startsWith('watch-process-exclusion'))).toBe(false);
    expect(watch?.blockers.some((blocker) => blocker.id === 'watch-bridge')).toBe(false);
  });

  it('adds a bridge blocker in watch mode when virtualMicOutputEnabled is true and bridge is not running', () => {
    const scenes = watchScenesWithBridgeConfig({
      bridgeState: 'stopped',
      feedbackLoopPrevention: 'none',
      virtualMicOutputEnabled: true,
      outputSpeechEnabled: false,
      outputTarget: 'speaker',
    });

    expect(scenes[0]?.blockers.some((blocker) => blocker.id === 'watch-bridge')).toBe(true);
  });

  it('does not add a watch bridge blocker when bridge is running', () => {
    const scenes = watchScenesWithBridgeConfig({
      bridgeState: 'running',
      feedbackLoopPrevention: 'virtual-driver',
      virtualMicOutputEnabled: true,
    });

    expect(scenes[0]?.blockers.some((blocker) => blocker.id === 'watch-bridge')).toBe(false);
  });

  it('does not add a watch bridge blocker when no bridge-requiring config is set', () => {
    const scenes = watchScenesWithBridgeConfig({
      bridgeState: 'stopped',
      feedbackLoopPrevention: 'none',
      virtualMicOutputEnabled: false,
      outputTarget: 'speaker',
    });

    expect(scenes[0]?.blockers.some((blocker) => blocker.id === 'watch-bridge')).toBe(false);
  });

  it('allows Gemini Live and OpenAI Realtime voice models handled by realtime runners', () => {
    const { runtimeSnapshot, audioSnapshot } = makeWatchReadyRuntimeInputs();

    const geminiConfig = structuredClone(appConfigDraftMock);
    geminiConfig.providers[0].model = 'gemini-2.5-flash-live';
    geminiConfig.providers[0].localModelCapabilityRegistry = [
      {
        id: 'registry-gemini-live',
        modelId: 'gemini-2.5-flash-live',
        capabilities: ['speech-to-speech'],
        realtimeAudioMode: 'gemini_auto_activity',
      },
    ];
    geminiConfig.devices.inboundVoiceModelId = 'gemini-2.5-flash-live';

    const openaiConfig = structuredClone(appConfigDraftMock);
    openaiConfig.providers[0].kind = 'openai-compatible';
    openaiConfig.providers[0].model = 'gpt-4o-realtime-preview';
    openaiConfig.providers[0].localModelCapabilityRegistry = [
      {
        id: 'registry-openai-realtime',
        modelId: 'gpt-4o-realtime-preview',
        capabilities: ['speech-to-speech'],
        realtimeAudioMode: 'server_vad',
      },
    ];
    openaiConfig.devices.inboundVoiceModelId = 'gpt-4o-realtime-preview';

    expect(getAllSceneReadiness(geminiConfig, runtimeSnapshot, audioSnapshot)[0]?.blockers.map((blocker) => blocker.id)).not.toContain(
      'watch-gemini-live-mode',
    );
    expect(getAllSceneReadiness(openaiConfig, runtimeSnapshot, audioSnapshot)[0]?.blockers.map((blocker) => blocker.id)).not.toContain(
      'watch-openai-realtime-runner',
    );
  });

  it('does not block Qwen realtime audio modes that the watch runner supports', () => {
    const { configDraft, runtimeSnapshot, audioSnapshot } = makeWatchReadyRuntimeInputs();
    configDraft.providers[0].localModelCapabilityRegistry = [
      {
        id: 'registry-qwen-omni',
        modelId: 'qwen3.5-omni-plus-realtime',
        capabilities: ['speech-to-speech'],
        realtimeAudioMode: 'semantic_vad',
      },
    ];
    configDraft.devices.inboundVoiceModelId = 'qwen3.5-omni-plus-realtime';

    expect(getAllSceneReadiness(configDraft, runtimeSnapshot, audioSnapshot)[0]?.blockers.map((blocker) => blocker.id)).not.toContain(
      'watch-openai-realtime-runner',
    );
    expect(getAllSceneReadiness(configDraft, runtimeSnapshot, audioSnapshot)[0]?.blockers.map((blocker) => blocker.id)).not.toContain(
      'watch-gemini-live-mode',
    );
  });

  // The former "covers watch model resolution" test asserted `blockers=[]`
  // for four configs whose distinguishing branches no longer exist in
  // scene-readiness (model-mode blockers moved out during the decoupling
  // refactor), so all four assertions were identical and vacuous. Each watch
  // blocker branch is pinned by its own observable id instead.
  it('raises each watch blocker exactly under its own condition', () => {
    const { configDraft: readyConfig, runtimeSnapshot: readyRuntime, audioSnapshot: readyAudio } = makeWatchReadyRuntimeInputs();
    readyConfig.providers[0].probe.profileId = 'probe-dashscope-verify';
    readyConfig.providers[0].probe.checkedAt = '2026-05-17T12:00:00.000Z';
    readyConfig.providers[0].status = 'warning';
    readyConfig.devices.feedbackLoopPrevention = 'echo-cancel';
    readyConfig.devices.virtualMicOutputEnabled = false;
    readyConfig.speech.outputTarget = 'speaker';

    const watchBlockerIds = (
      config = readyConfig,
      runtime = readyRuntime,
      audio = readyAudio,
    ) => getAllSceneReadiness(structuredClone(config), structuredClone(runtime), structuredClone(audio))[0]!
      .blockers.map((blocker) => blocker.id);

    // Fully ready baseline: no blockers at all.
    expect(watchBlockerIds()).toEqual([]);

    // Unverified provider → watch-provider (and only that).
    const unverified = structuredClone(readyConfig);
    unverified.providers[0].probe.profileId = '';
    unverified.providers[0].probe.checkedAt = '';
    unverified.providers[0].status = 'draft';
    expect(watchBlockerIds(unverified)).toEqual(['watch-provider']);

    // Bridge-dependent route with the bridge stopped → watch-bridge.
    const bridgeNeeded = structuredClone(readyConfig);
    bridgeNeeded.devices.feedbackLoopPrevention = 'virtual-driver';
    const stoppedBridge = structuredClone(readyRuntime);
    stoppedBridge.bridge.bridgeState = 'stopped';
    expect(watchBlockerIds(bridgeNeeded, stoppedBridge)).toEqual(['watch-bridge']);
    // The same stopped bridge without a bridge-dependent route: no blocker.
    expect(watchBlockerIds(readyConfig, stoppedBridge)).toEqual([]);

    // Unbound system audio → watch-inbound.
    const unboundAudio = structuredClone(readyAudio);
    unboundAudio.inbound.streamBound = false;
    expect(watchBlockerIds(readyConfig, readyRuntime, unboundAudio)).toEqual(['watch-inbound']);

    // Hidden overlay → watch-overlay.
    const hiddenOverlay = structuredClone(readyRuntime);
    hiddenOverlay.windows = hiddenOverlay.windows.map((item) =>
      item.label === 'subtitle-overlay' ? { ...item, visible: false } : item,
    );
    expect(watchBlockerIds(readyConfig, hiddenOverlay)).toEqual(['watch-overlay']);
  });

  it('formats scene and overall readiness summaries', () => {
    expect(formatSceneReadinessLabel(0, '可开始')).toBe('可开始');
    expect(formatSceneReadinessLabel(3, '可开始')).toBe('待收口 3 项');
    expect([getSceneTone(0), getSceneTone(1), getSceneTone(3)]).toEqual(['ready', 'draft', 'warning']);

    const scenes = scenesFor(structuredClone(appConfigDraftMock));
    expect(getOverallReadiness(scenes)).toMatchObject({ readyCount: 0, totalCount: 3, tone: 'risk' });
    expect(getOverallReadiness([{ ...scenes[0], blockers: [] }, scenes[1], scenes[2]])).toMatchObject({ tone: 'warning' });
    expect(getOverallReadiness(scenes.map((scene) => ({ ...scene, blockers: [] })))).toMatchObject({ tone: 'ready' });
  });

  it('treats a missing active provider as an unverified provider', () => {
    const configDraft = structuredClone(appConfigDraftMock);
    configDraft.activeProviderTemplateId = 'missing-template';
    const scenes = scenesFor(configDraft);
    expect(scenes.every((scene) => scene.blockers.some((blocker) => blocker.id.endsWith('provider')))).toBe(true);
  });
});
