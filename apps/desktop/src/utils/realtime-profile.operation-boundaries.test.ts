import { describe, expect, it } from 'vitest';
import { appConfigDraftMock } from '../mocks/app-config';
import { primaryDashScopeOperation, resolveRealtimeProfile } from './realtime-profile';

function provider() {
  const draft = structuredClone(appConfigDraftMock.providers[0]);
  draft.kind = 'dashscope';
  draft.model = 'exact-custom-model';
  draft.modelProtocolBindings = [];
  return draft;
}

describe('realtime operation selection ambiguity', () => {
  it.each([['realtime-conversation', 'dialogue'], ['asr', 'asr'], ['realtime-transcription', 'asr'], ['realtime-translation', 'native_translate']] as const)('uses explicit %s operation for an unregistered exact model', (operation, expected) => {
    const draft = provider();
    draft.modelProtocolBindings = [{ modelId: draft.model, operation, profileOwnerProviderId: 'bailian', manifestVersion: 3, profileId: 'bound', profileVersion: 1 }];
    expect(primaryDashScopeOperation(draft, draft.model)).toBe(expected);
    draft.modelProtocolBindings.push({ ...draft.modelProtocolBindings[0] });
    expect(() => primaryDashScopeOperation(draft, draft.model)).toThrow('model_protocol.profile_ambiguous');
  });

  it('ignores unrelated model/operation bindings rather than borrowing their protocol', () => {
    const draft = provider();
    draft.modelProtocolBindings = [{ modelId: draft.model, operation: 'text-translation', profileOwnerProviderId: 'openai', manifestVersion: 3, profileId: 'text', profileVersion: 1 }];
    expect(primaryDashScopeOperation(draft, draft.model)).toBe('native_translate');
    draft.modelProtocolBindings = undefined;
    expect(primaryDashScopeOperation(draft, draft.model)).toBe('native_translate');
  });

  it('returns no manifest dialect for an exact custom profile which lacks a route adapter', () => {
    const draft = provider();
    draft.kind = 'openai-compatible';
    draft.templateId = 'template-custom-exact';
    draft.templateSource = 'custom';
    draft.localModelCapabilityRegistry = [];
    draft.modelProtocolBindings = [{ modelId: draft.model, operation: 'realtime-transcription', profileOwnerProviderId: 'openai', manifestVersion: 3, profileId: 'openai.realtime.transcription.ws.ga', profileVersion: 1 }];
    const result = resolveRealtimeProfile({ providers: [draft] }, draft.model);
    expect(result.modelId).toBe('exact-custom-model');
    // Unknown profile identity must not silently acquire a conversation adapter.
    expect(result.protocolDialect).not.toBe('openai-conversation');
  });
});
