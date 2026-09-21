import { describe, expect, it } from 'vitest';
import { appConfigDraftMock } from '../mocks/app-config';
import { audioRuntimeSnapshotMock } from '../mocks/audio-runtime';
import { runtimeSnapshotMock } from '../mocks/runtime-shell';
import { hasCredentialBoundVerification } from './provider-draft-verification';
import { getAllSceneReadiness } from './scene-readiness';

describe('historical known-model readiness without session credential proof', () => {
  it.each([
    ['template-dashscope-realtime', 'qwen3.5-livetranslate-flash-realtime'],
    ['template-openai-compatible-realtime', 'gpt-realtime-2.1'],
  ])('does not force paid re-verification for %s after clearing the custom claim', (templateId, model) => {
    const config = structuredClone(appConfigDraftMock);
    const provider = config.providers[0];
    provider.templateId = templateId;
    provider.model = model;
    provider.status = 'ready';
    provider.probe = {
      ...provider.probe, profileId: 'credential-proof:previous-session',
      checkedAt: '2026-09-20T10:00:00Z', verdict: 'available', configurationSignature: undefined,
    };
    config.providers = [provider];
    config.activeProviderTemplateId = templateId;
    expect(hasCredentialBoundVerification(provider)).toBe(false);
    const scenes = getAllSceneReadiness(config, structuredClone(runtimeSnapshotMock), structuredClone(audioRuntimeSnapshotMock));
    expect(scenes.some((scene) => scene.blockers.some((blocker) => blocker.id.endsWith('provider')))).toBe(false);
  });
});
