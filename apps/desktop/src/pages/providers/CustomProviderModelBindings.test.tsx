import { describe, expect, it, vi } from 'vitest';
import { appConfigDraftMock } from '../../defaults/app-config';
import type { ProviderDraft } from '../../schema/config';
import { registerDomHarness } from '../../test-utils/component-test-harness';
import CustomProviderModelBindings from './CustomProviderModelBindings';

vi.mock('react-i18next', async () => {
  const { reactI18nextStub } = await import('../../test-utils/i18n-stub');
  return reactI18nextStub();
});

function customProvider(modelId: string, baseUrl: string): ProviderDraft {
  return {
    ...structuredClone(appConfigDraftMock.providers[0]),
    templateId: 'template-custom-native-audio', templateSource: 'custom',
    kind: 'dashscope', transport: 'websocket', region: 'cn-beijing', baseUrl,
    candidateModelGroups: [{ group: 'audio-understanding', modelIds: [modelId] }],
    modelProtocolBindings: [],
    authRef: { ...appConfigDraftMock.providers[0].authRef, headerName: 'Authorization', scheme: 'bearer' },
  };
}

describe('custom DashScope model binding native-operation wording', () => {
  const view = registerDomHarness();

  it.each([
    { modelId: 'qwen-audio-3.0-realtime-plus', operation: 'dialogue', path: '/api-ws/v1/realtime', profileId: 'bailian.qwen-audio-chat.realtime.ws' },
    { modelId: 'qwen-audio-3.1-asr-flash-streaming', operation: 'asr', path: '/api-ws/v1/inference', profileId: 'bailian.task-asr.qwen-audio-3.1.ws' },
    { modelId: 'qwen-audio-3.0-tts-plus', operation: 'tts', path: '/api-ws/v1/inference', profileId: 'bailian.task-tts.qwen-audio-3.0.ws' },
    { modelId: 'qwen3.5-livetranslate-flash-realtime', operation: 'native_translate', path: '/api/v1', profileId: 'bailian.livetranslate.realtime.ws' },
  ])('shows the exact approved $operation authority without changing the draft', async ({ modelId, operation, path, profileId }) => {
    const provider = customProvider(modelId, 'https://dashscope.aliyuncs.com' + path);
    const before = structuredClone(provider);
    const onChange = vi.fn();
    await view.render(<CustomProviderModelBindings capabilitiesRegistry={[]} onChange={onChange} provider={provider} />);
    expect(view.container.textContent).toContain('原生操作已授权');
    expect(view.container.textContent).toContain(profileId + '@1');
    expect(view.container.textContent).toContain('操作：' + operation);
    expect(view.container.textContent).toContain('区域：cn-beijing');
    expect(view.container.textContent).not.toContain('尚未匹配');
    expect(provider).toEqual(before);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('explains operation-specific realtime/inference, Workspace, region and auth requirements when unapproved', async () => {
    const provider = customProvider('fun-asr-realtime', 'https://dashscope.aliyuncs.com/api-ws/v1/inference');
    await view.render(<CustomProviderModelBindings capabilitiesRegistry={[]} onChange={vi.fn()} provider={provider} />);
    expect(view.container.textContent).toContain('尚未匹配已实现的阿里云原生操作协议');
    for (const hint of ['对话、ASR、TTS 或实时翻译', 'realtime/inference', 'Workspace', '区域', 'Bearer']) {
      expect(view.container.textContent).toContain(hint);
    }
    expect(view.container.textContent).not.toContain('原生操作已授权');
  });
});
