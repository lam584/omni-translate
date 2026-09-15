import { describe, expect, it } from 'vitest';
import { appConfigDraftMock } from '../mocks/app-config';
import type { ProviderDraft } from '../schema/config';
import {
  RealtimeProfileAuthorizationError,
  resolveRealtimeProfile,
} from './realtime-profile';

function unknownDashscopeProvider(): ProviderDraft {
  const provider = structuredClone(appConfigDraftMock.providers[0]);
  provider.kind = 'dashscope';
  provider.templateId = 'template-dashscope-realtime';
  provider.model = 'future-unknown-voice-model-2099';
  provider.sceneModelAssignments = [];
  provider.localModelCapabilityRegistry = [];
  delete provider.templateRealtimeProtocol;
  delete provider.realtimeProtocol;
  return provider;
}

describe('Bailian model protocol old-red authorization', () => {
  function expectRejected(provider: ProviderDraft, code: RealtimeProfileAuthorizationError['code']) {
    let caught: unknown;
    try {
      resolveRealtimeProfile({ providers: [provider] }, provider.model);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RealtimeProfileAuthorizationError);
    expect(caught).toMatchObject({ code, message: code });
  }

  it('A02 unknown_dashscope_model_never_infers_paid_dialect', () => {
    const provider = unknownDashscopeProvider();
    provider.templateRealtimeProtocol = 'dashscope-omni';
    expectRejected(
      provider,
      'model_protocol.model_not_registered',
    );
  });

  it('A03 exact_registry_without_profile_declaration_is_not_connection_authority', () => {
    const provider = unknownDashscopeProvider();
    provider.model = 'qwen3.5-livetranslate-flash-realtime';
    provider.localModelCapabilityRegistry = [{
      id: 'missing-declaration',
      modelId: provider.model,
      capabilities: ['speech-to-text', 'speech-to-speech'],
      realtimeProtocol: 'dashscope-livetranslate',
    }];
    expectRejected(provider, 'model_protocol.authorization_identity_mismatch');
  });

  it('A04 forged_local_profile_declaration_cannot_override_the_manifest', () => {
    const provider = unknownDashscopeProvider();
    provider.model = 'qwen3.5-livetranslate-flash-realtime';
    provider.localModelCapabilityRegistry = [{
      id: 'forged-profile',
      modelId: provider.model,
      capabilities: ['speech-to-text', 'speech-to-speech'],
      registryVersion: 'bailian-model-protocol-registry/v1',
      profileId: 'bailian.omni.realtime.ws',
      profileVersion: 1,
      realtimeProtocol: 'dashscope-omni',
    }];
    expectRejected(provider, 'model_protocol.profile_id_mismatch');
  });
});
