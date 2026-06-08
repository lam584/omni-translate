import { describe, expect, it } from 'vitest';
import { audioRuntimeSnapshotMock } from '../mocks/audio-runtime';
import { appConfigDraftMock } from '../mocks/app-config';
import { runtimeSnapshotMock } from '../mocks/runtime-shell';
import { formatSceneReadinessLabel, getAllSceneReadiness, getOverallReadiness, getSceneTone } from './scene-readiness';

describe('scene readiness', () => {
  it('shows provider verification blocker before the first verification attempt', () => {
    const configDraft = structuredClone(appConfigDraftMock);
    configDraft.providers[0].probe.profileId = 'probe-provider-dashscope-pending';
    configDraft.providers[0].probe.checkedAt = '待重新探测';
    configDraft.providers[0].status = 'draft';

    const scenes = getAllSceneReadiness(configDraft, structuredClone(runtimeSnapshotMock), structuredClone(audioRuntimeSnapshotMock));

    expect(scenes.some((scene) => scene.blockers.some((blocker) => blocker.id.endsWith('provider')))).toBe(true);
  });

  it('does not show provider verification blocker after a verification attempt has been recorded', () => {
    const configDraft = structuredClone(appConfigDraftMock);
    configDraft.providers[0].probe.profileId = 'probe-dashscope-verify';
    configDraft.providers[0].probe.checkedAt = '2026-05-17T12:00:00.000Z';
    configDraft.providers[0].status = 'warning';

    const scenes = getAllSceneReadiness(configDraft, structuredClone(runtimeSnapshotMock), structuredClone(audioRuntimeSnapshotMock));

    expect(scenes.some((scene) => scene.blockers.some((blocker) => blocker.id.endsWith('provider')))).toBe(false);
  });

  it('collapses runtime-dependent blockers into a single preview blocker outside the desktop shell', () => {
    const configDraft = structuredClone(appConfigDraftMock);
    const runtimeSnapshot = structuredClone(runtimeSnapshotMock);
    const audioSnapshot = structuredClone(audioRuntimeSnapshotMock);

    const scenes = getAllSceneReadiness(configDraft, runtimeSnapshot, audioSnapshot);

    expect(scenes[0]?.blockers.map((blocker) => blocker.id)).toEqual(['watch-runtime-preview']);
    expect(scenes[1]?.blockers.map((blocker) => blocker.id)).toEqual(['game-runtime-preview']);
    expect(scenes[2]?.blockers.map((blocker) => blocker.id)).toEqual(['voice-room-runtime-preview']);
  });

  it('uses a runtime error blocker instead of bridge and audio blockers when IPC bootstrap failed', () => {
    const configDraft = structuredClone(appConfigDraftMock);
    const runtimeSnapshot = structuredClone(runtimeSnapshotMock);
    runtimeSnapshot.bridgeStatus = 'runtime-error';
    const audioSnapshot = structuredClone(audioRuntimeSnapshotMock);

    const scenes = getAllSceneReadiness(configDraft, runtimeSnapshot, audioSnapshot);

    expect(scenes[1]?.blockers.map((blocker) => blocker.id)).toEqual(['game-runtime-error']);
    expect(scenes[2]?.blockers.map((blocker) => blocker.id)).toEqual(['voice-room-runtime-error']);
  });

  it('requires the speech output target to include virtual mic before clearing the virtual mic blocker', () => {
    const configDraft = structuredClone(appConfigDraftMock);
    const runtimeSnapshot = structuredClone(runtimeSnapshotMock);
    const audioSnapshot = structuredClone(audioRuntimeSnapshotMock);

    runtimeSnapshot.bridgeStatus = 'tauri-shell';
    runtimeSnapshot.bridge.bridgeState = 'running';
    audioSnapshot.inbound.streamBound = true;
    audioSnapshot.outbound.streamBound = true;
    configDraft.speech.enabled = true;
    configDraft.speech.virtualMicOutputEnabled = true;
    configDraft.speech.outputTarget = 'speaker';

    const scenes = getAllSceneReadiness(configDraft, runtimeSnapshot, audioSnapshot);

    expect(scenes[1]?.blockers.some((blocker) => blocker.id === 'game-speech')).toBe(true);
    expect(scenes[2]?.blockers.some((blocker) => blocker.id === 'voice-room-speech')).toBe(true);
  });

  it('clears the virtual mic blocker when the output target includes virtual mic in the desktop shell', () => {
    const configDraft = structuredClone(appConfigDraftMock);
    const runtimeSnapshot = structuredClone(runtimeSnapshotMock);
    const audioSnapshot = structuredClone(audioRuntimeSnapshotMock);

    runtimeSnapshot.bridgeStatus = 'tauri-shell';
    runtimeSnapshot.bridge.bridgeState = 'running';
    audioSnapshot.inbound.streamBound = true;
    audioSnapshot.outbound.streamBound = true;
    configDraft.speech.enabled = true;
    configDraft.speech.virtualMicOutputEnabled = true;
    configDraft.speech.outputTarget = 'both';

    const scenes = getAllSceneReadiness(configDraft, runtimeSnapshot, audioSnapshot);

    expect(scenes[1]?.blockers.some((blocker) => blocker.id === 'game-speech')).toBe(false);
    expect(scenes[2]?.blockers.some((blocker) => blocker.id === 'voice-room-speech')).toBe(false);
  });

  it('adds a bridge blocker in watch mode when feedbackLoopPrevention is virtual-driver and bridge is not running', () => {
    const configDraft = structuredClone(appConfigDraftMock);
    const runtimeSnapshot = structuredClone(runtimeSnapshotMock);
    const audioSnapshot = structuredClone(audioRuntimeSnapshotMock);

    runtimeSnapshot.bridgeStatus = 'tauri-shell';
    runtimeSnapshot.bridge.bridgeState = 'stopped';
    configDraft.devices.feedbackLoopPrevention = 'virtual-driver';
    configDraft.devices.virtualMicOutputEnabled = false;
    configDraft.speech.outputTarget = 'speaker';

    const scenes = getAllSceneReadiness(configDraft, runtimeSnapshot, audioSnapshot);

    expect(scenes[0]?.blockers.some((blocker) => blocker.id === 'watch-bridge')).toBe(true);
  });

  it('adds a bridge blocker in watch mode when virtualMicOutputEnabled is true and bridge is not running', () => {
    const configDraft = structuredClone(appConfigDraftMock);
    const runtimeSnapshot = structuredClone(runtimeSnapshotMock);
    const audioSnapshot = structuredClone(audioRuntimeSnapshotMock);

    runtimeSnapshot.bridgeStatus = 'tauri-shell';
    runtimeSnapshot.bridge.bridgeState = 'stopped';
    configDraft.devices.feedbackLoopPrevention = 'none';
    configDraft.devices.virtualMicOutputEnabled = true;
    configDraft.speech.outputTarget = 'speaker';

    const scenes = getAllSceneReadiness(configDraft, runtimeSnapshot, audioSnapshot);

    expect(scenes[0]?.blockers.some((blocker) => blocker.id === 'watch-bridge')).toBe(true);
  });

  it('does not add a watch bridge blocker when bridge is running', () => {
    const configDraft = structuredClone(appConfigDraftMock);
    const runtimeSnapshot = structuredClone(runtimeSnapshotMock);
    const audioSnapshot = structuredClone(audioRuntimeSnapshotMock);

    runtimeSnapshot.bridgeStatus = 'tauri-shell';
    runtimeSnapshot.bridge.bridgeState = 'running';
    configDraft.devices.feedbackLoopPrevention = 'virtual-driver';
    configDraft.devices.virtualMicOutputEnabled = true;

    const scenes = getAllSceneReadiness(configDraft, runtimeSnapshot, audioSnapshot);

    expect(scenes[0]?.blockers.some((blocker) => blocker.id === 'watch-bridge')).toBe(false);
  });

  it('does not add a watch bridge blocker when no bridge-requiring config is set', () => {
    const configDraft = structuredClone(appConfigDraftMock);
    const runtimeSnapshot = structuredClone(runtimeSnapshotMock);
    const audioSnapshot = structuredClone(audioRuntimeSnapshotMock);

    runtimeSnapshot.bridgeStatus = 'tauri-shell';
    runtimeSnapshot.bridge.bridgeState = 'stopped';
    configDraft.devices.feedbackLoopPrevention = 'none';
    configDraft.devices.virtualMicOutputEnabled = false;
    configDraft.speech.outputTarget = 'speaker';

    const scenes = getAllSceneReadiness(configDraft, runtimeSnapshot, audioSnapshot);

    expect(scenes[0]?.blockers.some((blocker) => blocker.id === 'watch-bridge')).toBe(false);
  });

  it('allows Gemini Live and OpenAI Realtime voice models handled by realtime runners', () => {
    const runtimeSnapshot = structuredClone(runtimeSnapshotMock);
    const audioSnapshot = structuredClone(audioRuntimeSnapshotMock);
    runtimeSnapshot.bridgeStatus = 'tauri-shell';
    runtimeSnapshot.bridge.bridgeState = 'running';
    audioSnapshot.inbound.streamBound = true;
    runtimeSnapshot.windows = runtimeSnapshot.windows.map((item) =>
      item.label === 'subtitle-overlay' ? { ...item, visible: true } : item,
    );

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
    const configDraft = structuredClone(appConfigDraftMock);
    const runtimeSnapshot = structuredClone(runtimeSnapshotMock);
    const audioSnapshot = structuredClone(audioRuntimeSnapshotMock);
    runtimeSnapshot.bridgeStatus = 'tauri-shell';
    runtimeSnapshot.bridge.bridgeState = 'running';
    audioSnapshot.inbound.streamBound = true;
    runtimeSnapshot.windows = runtimeSnapshot.windows.map((item) =>
      item.label === 'subtitle-overlay' ? { ...item, visible: true } : item,
    );
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

  it('covers watch model resolution for empty, explicit, assigned and unknown model ids', () => {
    const runtimeSnapshot = structuredClone(runtimeSnapshotMock);
    const audioSnapshot = structuredClone(audioRuntimeSnapshotMock);
    runtimeSnapshot.bridgeStatus = 'tauri-shell';
    runtimeSnapshot.bridge.bridgeState = 'running';
    audioSnapshot.inbound.streamBound = true;
    runtimeSnapshot.windows = runtimeSnapshot.windows.map((item) =>
      item.label === 'subtitle-overlay' ? { ...item, visible: true } : item,
    );

    const baseConfig = structuredClone(appConfigDraftMock);
    baseConfig.providers[0].probe.profileId = 'probe-dashscope-verify';
    baseConfig.providers[0].probe.checkedAt = '2026-05-17T12:00:00.000Z';
    baseConfig.providers[0].status = 'warning';

    const emptyModelConfig = structuredClone(baseConfig);
    emptyModelConfig.devices.inboundVoiceModelId = ' ';
    expect(getAllSceneReadiness(emptyModelConfig, runtimeSnapshot, audioSnapshot)[0]?.blockers).toEqual([]);

    const explicitModelConfig = structuredClone(baseConfig);
    explicitModelConfig.providers[0].templateId = 'template-audio';
    explicitModelConfig.activeProviderTemplateId = 'template-audio';
    explicitModelConfig.providers[0].localModelCapabilityRegistry = [];
    explicitModelConfig.devices.inboundVoiceModelId = 'template-audio::qwen3-asr-flash-realtime';
    expect(getAllSceneReadiness(explicitModelConfig, runtimeSnapshot, audioSnapshot)[0]?.blockers).toEqual([]);

    const assignedModelConfig = structuredClone(baseConfig);
    assignedModelConfig.providers[0].model = 'default-model';
    assignedModelConfig.providers[0].sceneModelAssignments = [
      { scenario: 'watch', modelIds: ['assigned-asr-model'] },
    ];
    assignedModelConfig.devices.inboundVoiceModelId = 'assigned-asr-model';
    expect(getAllSceneReadiness(assignedModelConfig, runtimeSnapshot, audioSnapshot)[0]?.blockers).toEqual([]);

    const unknownModelConfig = structuredClone(baseConfig);
    unknownModelConfig.devices.inboundVoiceModelId = 'missing-model';
    expect(getAllSceneReadiness(unknownModelConfig, runtimeSnapshot, audioSnapshot)[0]?.blockers).toEqual([]);
  });

  it('formats scene and overall readiness summaries', () => {
    expect(formatSceneReadinessLabel(0, '可开始')).toBe('可开始');
    expect(formatSceneReadinessLabel(3, '可开始')).toBe('待收口 3 项');
    expect([getSceneTone(0), getSceneTone(1), getSceneTone(3)]).toEqual(['ready', 'draft', 'warning']);

    const scenes = getAllSceneReadiness(
      structuredClone(appConfigDraftMock),
      structuredClone(runtimeSnapshotMock),
      structuredClone(audioRuntimeSnapshotMock),
    );
    expect(getOverallReadiness(scenes)).toMatchObject({ readyCount: 0, totalCount: 3, tone: 'risk' });
    expect(getOverallReadiness([{ ...scenes[0], blockers: [] }, scenes[1], scenes[2]])).toMatchObject({ tone: 'warning' });
    expect(getOverallReadiness(scenes.map((scene) => ({ ...scene, blockers: [] })))).toMatchObject({ tone: 'ready' });
  });

  it('treats a missing active provider as an unverified provider', () => {
    const configDraft = structuredClone(appConfigDraftMock);
    configDraft.activeProviderTemplateId = 'missing-template';
    const scenes = getAllSceneReadiness(configDraft, structuredClone(runtimeSnapshotMock), structuredClone(audioRuntimeSnapshotMock));
    expect(scenes.every((scene) => scene.blockers.some((blocker) => blocker.id.endsWith('provider')))).toBe(true);
  });
});
