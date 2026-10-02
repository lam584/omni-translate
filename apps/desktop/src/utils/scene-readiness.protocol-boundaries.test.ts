import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appConfigDraftMock } from '../mocks/app-config';
import { runtimeSnapshotMock } from '../mocks/runtime-shell';
import { audioRuntimeSnapshotMock } from '../mocks/audio-runtime';
import type { ProviderDraft } from '../schema/config';
import { getWatchSceneReadiness, getVoiceRoomSceneReadiness } from './scene-readiness';
import i18n from '../i18n/config';
import { resolveRealtimeProfile } from './realtime-profile';

vi.mock('./realtime-profile', () => ({ resolveRealtimeProfile: vi.fn() }));

function inputs() {
  const config = structuredClone(appConfigDraftMock);
  const runtime = structuredClone(runtimeSnapshotMock);
  const audio = structuredClone(audioRuntimeSnapshotMock);
  runtime.bridgeStatus = 'tauri-shell';
  runtime.bridge.bridgeState = 'running';
  audio.inbound.streamBound = true;
  audio.outbound.streamBound = true;
  const provider = config.providers[0];
  provider.probe.checkedAt = '2026-10-02T00:00:00Z';
  provider.probe.profileId = 'verified';
  config.activeProviderTemplateId = provider.templateId;
  config.devices.inboundVoiceModelId = `${provider.templateId}::${provider.model}`;
  config.devices.outboundVoiceModelId = config.devices.inboundVoiceModelId;
  config.devices.subtitleTranslationMode = 'native';
  return { config, runtime, audio, provider };
}
function binding(modelId: string, operation: NonNullable<ProviderDraft['modelProtocolBindings']>[number]['operation']) {
  return { modelId, operation, profileOwnerProviderId: 'test-owner', manifestVersion: 1, profileId: 'explicit-test-profile', profileVersion: 1 };
}
function protocolBlockers(values: ReturnType<typeof inputs>) {
  return getWatchSceneReadiness(values.config, values.runtime, values.audio).blockers
    .filter((entry) => entry.id.includes('protocol') || entry.id.includes('unresolved') || entry.id.includes('primary-text') || entry.id.includes('empty-custom'));
}

describe('scene protocol admission boundaries', () => {
  beforeEach(() => {
    vi.mocked(resolveRealtimeProfile).mockReset();
    vi.mocked(resolveRealtimeProfile).mockReturnValue({ nativeTranslation: true } as ReturnType<typeof resolveRealtimeProfile>);
  });

  it('requires a text worker for legacy profiles without native translation, but ignores empty voice references', () => {
    const values = inputs();
    vi.mocked(resolveRealtimeProfile).mockReturnValue({} as ReturnType<typeof resolveRealtimeProfile>);
    values.config.devices.primaryTextTranslationModelId = '';
    expect(protocolBlockers(values)).toContainEqual(expect.objectContaining({ id: 'watch-primary-text-missing', route: '/audio-routing' }));
    values.config.devices.inboundVoiceModelId = '';
    expect(protocolBlockers(values)).toEqual([]);
  });

  it.each(['primary-text', 'secondary-subtitle'] as const)('identifies an unresolved %s without attributing it to the primary audio model', (role) => {
    const values = inputs();
    if (role === 'primary-text') {
      vi.mocked(resolveRealtimeProfile).mockReturnValue({ translationExecution: 'text-worker' } as ReturnType<typeof resolveRealtimeProfile>);
      values.config.devices.primaryTextTranslationModelId = 'missing::text';
    } else {
      values.config.devices.subtitleTranslationMode = 'secondary';
      values.config.devices.subtitleTranslationModelId = 'missing::text';
    }
    expect(protocolBlockers(values)).toEqual([expect.objectContaining({ id: `watch-${role}-unresolved-text`, route: '/providers' })]);
  });

  it('treats a qualified empty model as unresolved, while an unqualified candidate can resolve by group', () => {
    const values = inputs();
    values.config.devices.inboundVoiceModelId = 'missing::';
    expect(protocolBlockers(values)[0]).toMatchObject({ id: 'watch-primary-audio-unresolved-empty' });
    values.provider.kind = 'openai-compatible';
    values.provider.candidateModelGroups = [{ group: 'audio-understanding', modelIds: ['candidate'] }];
    values.config.devices.inboundVoiceModelId = 'candidate';
    expect(protocolBlockers(values)).toEqual([]);
    values.provider.candidateModelGroups = undefined;
    expect(protocolBlockers(values)[0]).toMatchObject({ id: 'watch-primary-audio-unresolved-candidate' });
  });

  it.each(['primary-text', 'secondary-subtitle'] as const)('requires built-in text capability for %s rather than any candidate group', (role) => {
    const values = inputs();
    values.provider.kind = 'openai-compatible';
    values.provider.candidateModelGroups = [{ group: 'text-processing', modelIds: ['allowed-text'] }];
    const reference = `${values.provider.templateId}::wrong-text`;
    if (role === 'primary-text') {
      vi.mocked(resolveRealtimeProfile).mockReturnValue({ translationExecution: 'text-worker' } as ReturnType<typeof resolveRealtimeProfile>);
      values.config.devices.primaryTextTranslationModelId = reference;
    } else {
      values.config.devices.subtitleTranslationMode = 'secondary';
      values.config.devices.subtitleTranslationModelId = reference;
    }
    expect(protocolBlockers(values)).toEqual([expect.objectContaining({ id: 'watch-text-protocol-wrong-text', title: expect.stringContaining('wrong-text') })]);
    values.provider.candidateModelGroups[0].modelIds.push('wrong-text');
    expect(protocolBlockers(values)).toEqual([]);
    values.provider.candidateModelGroups = undefined;
    values.provider.model = 'wrong-text';
    expect(protocolBlockers(values)).toEqual([]);
    values.provider.model = 'other';
    expect(protocolBlockers(values)).toHaveLength(1);
  });

  it.each(['realtime-conversation', 'asr', 'realtime-transcription'] as const)('admits exactly one custom %s binding and rejects duplicates or unrelated text bindings', (operation) => {
    const values = inputs();
    values.provider.templateSource = 'custom';
    values.provider.kind = 'openai-compatible';
    values.provider.model = 'voice';
    values.config.devices.inboundVoiceModelId = `${values.provider.templateId}::voice`;
    values.provider.modelProtocolBindings = [binding('other', operation), binding('voice', 'text-translation')];
    expect(protocolBlockers(values)).toEqual([expect.objectContaining({ id: 'watch-audio-protocol-voice' })]);
    values.provider.modelProtocolBindings.push(binding('voice', operation));
    expect(protocolBlockers(values)).toEqual([]);
    values.provider.modelProtocolBindings.push(binding('voice', operation));
    expect(protocolBlockers(values)).toHaveLength(1);
  });

  it.each(['primary-text', 'secondary-subtitle'] as const)('does not let an audio binding authorize custom %s translation', (role) => {
    const values = inputs();
    values.provider.templateSource = 'custom';
    values.provider.kind = 'openai-compatible';
    const voice = values.provider.model;
    values.provider.modelProtocolBindings = [binding(voice, 'realtime-conversation'), binding('text', 'asr')];
    if (role === 'primary-text') {
      vi.mocked(resolveRealtimeProfile).mockReturnValue({ translationExecution: 'text-worker' } as ReturnType<typeof resolveRealtimeProfile>);
      values.config.devices.primaryTextTranslationModelId = `${values.provider.templateId}::text`;
    } else {
      values.config.devices.subtitleTranslationMode = 'secondary';
      values.config.devices.subtitleTranslationModelId = `${values.provider.templateId}::text`;
    }
    expect(protocolBlockers(values)).toEqual([expect.objectContaining({ id: 'watch-text-protocol-text' })]);
    values.provider.modelProtocolBindings.push(binding('text', 'text-translation'));
    expect(protocolBlockers(values)).toEqual([]);
  });

  it('reports an empty custom platform, including absent candidate groups, but not a platform with a candidate', () => {
    const values = inputs();
    values.provider.templateSource = 'custom';
    values.provider.model = '   ';
    values.config.devices.inboundVoiceModelId = '';
    values.provider.candidateModelGroups = undefined;
    expect(protocolBlockers(values)).toEqual([expect.objectContaining({ id: 'watch-empty-custom-platform' })]);
    values.provider.candidateModelGroups = [{ group: 'text-processing', modelIds: ['text'] }];
    expect(protocolBlockers(values)).toEqual([]);
  });

  it('preserves non-Error protocol failure detail and validates outbound voice independently', () => {
    const values = inputs();
    values.provider.kind = 'dashscope';
    vi.mocked(resolveRealtimeProfile).mockImplementation(() => { throw 'adapter unavailable'; });
    expect(protocolBlockers(values)[0].title).toContain('adapter unavailable');
    values.config.devices.outboundVoiceModelId = 'absent::outbound';
    expect(getVoiceRoomSceneReadiness(values.config, values.runtime, values.audio).blockers).toContainEqual(
      expect.objectContaining({ id: 'voice-room-primary-audio-unresolved-outbound' }),
    );
  });
});


describe('readiness fallback diagnostics retain actionable identity', () => {
  it('keeps localized fallback role names when translations are missing', () => {
    const translate = vi.spyOn(i18n, 't').mockReturnValue('');
    try {
      for (const role of ['primary-audio', 'primary-text', 'secondary-subtitle'] as const) {
        const values = inputs();
        vi.mocked(resolveRealtimeProfile).mockReturnValue({ translationExecution: role === 'primary-text' ? 'text-worker' : 'dedicated-realtime', nativeTranslation: true } as ReturnType<typeof resolveRealtimeProfile>);
        const roleLabel = role === 'primary-audio' ? '主音频模型' : role === 'primary-text' ? '基础文本翻译模型' : '二次字幕模型';
        if (role === 'primary-audio') values.config.devices.inboundVoiceModelId = 'missing::voice';
        else if (role === 'primary-text') values.config.devices.primaryTextTranslationModelId = 'missing::text';
        else { values.config.devices.subtitleTranslationMode = 'secondary'; values.config.devices.subtitleTranslationModelId = 'missing::text'; }
        expect(protocolBlockers(values)[0].title).toContain(roleLabel);
        // The same role must remain explicit at both built-in capability and
        // custom binding boundaries, including an empty qualified model ID.
        if (role === 'primary-audio') values.config.devices.inboundVoiceModelId = `${values.provider.templateId}::`;
        else if (role === 'primary-text') values.config.devices.primaryTextTranslationModelId = `${values.provider.templateId}::`;
        else values.config.devices.subtitleTranslationModelId = `${values.provider.templateId}::`;
        values.provider.kind = 'openai-compatible';
        values.provider.candidateModelGroups = [{ group: 'text-processing', modelIds: [] }];
        if (role !== 'primary-audio') expect(protocolBlockers(values)[0].title).toContain(roleLabel + ' （未选择）');
        values.provider.templateSource = 'custom';
        values.provider.modelProtocolBindings = undefined;
        const custom = protocolBlockers(values);
        expect(custom).toContainEqual(expect.objectContaining({ title: expect.stringContaining(roleLabel + ' （未选择）') }));
        expect(custom.every((entry) => entry.route === '/providers')).toBe(true);
      }
      const missing = inputs();
      vi.mocked(resolveRealtimeProfile).mockReturnValue({ translationExecution: 'text-worker' } as ReturnType<typeof resolveRealtimeProfile>);
      missing.config.devices.primaryTextTranslationModelId = '';
      expect(protocolBlockers(missing)[0].title).toBe('当前语音模型需要选择基础文本翻译模型');
    } finally { translate.mockRestore(); }
  });

  it('reports a built-in qualified empty audio model rather than throwing during readiness', () => {
    const values = inputs();
    values.provider.kind = 'dashscope';
    values.config.devices.inboundVoiceModelId = `${values.provider.templateId}::`;
    vi.mocked(resolveRealtimeProfile).mockImplementation(() => { throw new Error('missing model identity'); });
    expect(protocolBlockers(values)).toEqual([expect.objectContaining({ id: 'watch-audio-protocol-empty', title: expect.stringContaining('（未选择）') })]);
  });

  it.each(['failed', 'unsupported'] as const)('reports process exclusion %s with missing platform evidence', (status) => {
    const values = inputs();
    vi.mocked(resolveRealtimeProfile).mockReturnValue({ nativeTranslation: true } as ReturnType<typeof resolveRealtimeProfile>);
    values.config.devices.feedbackLoopPrevention = 'process-exclusion';
    values.runtime.bridge.processLoopbackStatus = status;
    values.runtime.bridge.processLoopbackFailureDetail = null;
    values.runtime.bridge.windowsBuildNumber = null;
    const blockers = getWatchSceneReadiness(values.config, values.runtime, values.audio).blockers;
    expect(blockers).toContainEqual(expect.objectContaining({ id: `watch-process-exclusion-${status}`, route: '/audio-routing', title: expect.any(String) }));
    expect(blockers.find((entry) => entry.id === `watch-process-exclusion-${status}`)?.title).not.toContain('null');
  });
});
