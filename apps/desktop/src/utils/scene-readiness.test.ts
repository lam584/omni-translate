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
