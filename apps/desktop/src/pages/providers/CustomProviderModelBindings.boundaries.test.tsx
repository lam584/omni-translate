import { describe, expect, it, vi } from 'vitest';
import { appConfigDraftMock } from '../../mocks/app-config';
import { customProviderProtocolProfileOptions } from '../../provider-manifest/custom-profile-options';
import { registerDomHarness } from '../../test-utils/component-test-harness';
import { click, selectValue } from '../../test-utils/dom-interactions';
import CustomProviderModelBindings from './CustomProviderModelBindings';

vi.mock('react-i18next', async () => {
  const { reactI18nextStub } = await import('../../test-utils/i18n-stub');
  return reactI18nextStub();
});

function provider() {
  const draft = structuredClone(appConfigDraftMock.providers[0]);
  draft.kind = 'openai-compatible';
  draft.templateSource = 'custom';
  draft.transport = 'websocket';
  draft.streamEnabled = true;
  draft.authRef.headerName = 'Authorization';
  draft.authRef.scheme = 'bearer';
  draft.candidateModelGroups = [{ group: 'audio-understanding', modelIds: ['voice', 'other'] }];
  draft.modelProtocolBindings = undefined;
  return draft;
}

describe('custom binding editor explicit selection and replacement', () => {
  const view = registerDomHarness();

  it('renders an empty-model hint for an absent or empty candidate list, without invoking a mutation', async () => {
    const draft = provider();
    const onChange = vi.fn();
    draft.candidateModelGroups = undefined;
    await view.render(<CustomProviderModelBindings provider={draft} capabilitiesRegistry={[]} onChange={onChange} />);
    expect(view.container.textContent).toContain('请先在下方候选模型中添加模型');
    expect(view.container.querySelector('select')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('filters unsupported capabilities and connection/auth mismatches instead of offering inferred protocols', async () => {
    const draft = provider();
    const onChange = vi.fn();
    const capabilities = [{ id: 'voice', modelId: 'voice', capabilities: ['text-generation' as const, 'speech-to-speech' as const] }];
    await view.render(<CustomProviderModelBindings provider={draft} capabilitiesRegistry={[]} onChange={onChange} />);
    expect(view.container.querySelectorAll('select')).toHaveLength(1);
    expect(view.container.textContent).toContain('没有匹配的已实现协议');
    draft.authRef.headerName = 'X-Unrecognized-Auth';
    await view.render(<CustomProviderModelBindings provider={draft} capabilitiesRegistry={capabilities} onChange={onChange} />);
    expect(view.container.querySelectorAll('select')).toHaveLength(1);
    draft.authRef.headerName = 'Authorization';
    draft.authRef.scheme = 'none';
    await view.render(<CustomProviderModelBindings provider={draft} capabilitiesRegistry={capabilities} onChange={onChange} />);
    expect(view.container.querySelectorAll('select')).toHaveLength(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('replaces only the selected model/operation, preserves other bindings, and removes only the clicked binding', async () => {
    const draft = provider();
    const option = customProviderProtocolProfileOptions(draft.kind).find((entry) => entry.operation === 'text-translation' && entry.authScheme === 'bearer')!;
    expect(option).toMatchObject({ operation: 'text-translation', authScheme: 'bearer' });
    const old = { profileOwnerProviderId: 'test-owner', manifestVersion: 1, modelId: 'voice', operation: 'text-translation' as const, profileId: 'old', profileVersion: 1 };
    const other = { ...old, modelId: 'other' };
    const audio = { ...old, operation: 'realtime-conversation' as const };
    draft.modelProtocolBindings = [old, other, audio];
    const onChange = vi.fn();
    await view.render(<CustomProviderModelBindings provider={draft} capabilitiesRegistry={[{ id: 'voice', modelId: 'voice', capabilities: ['text-generation'] }]} onChange={onChange} />);
    const selects = view.container.querySelectorAll('select');
    expect(selects).toHaveLength(2);
    await selectValue(selects[1], '');
    expect(onChange).not.toHaveBeenCalled();
    await selectValue(selects[1], option.key);
    expect(onChange).toHaveBeenLastCalledWith({
      modelRegistryVersion: 2, status: 'draft', modelProtocolBindings: [other, audio, expect.objectContaining({ modelId: 'voice', operation: 'text-translation', profileId: option.profileId })],
    });
    expect(selects[1].value).toBe('');
    await click(view.container.querySelector('button[aria-label="移除 text-translation 协议绑定"]'));
    expect(onChange).toHaveBeenLastCalledWith({ status: 'draft', modelProtocolBindings: [other, audio] });
    await selectValue(selects[0], 'other');
    expect(view.container.textContent).toContain('text-translation: old@1');
    expect(view.container.textContent).not.toContain('realtime-conversation: old@1');
    draft.candidateModelGroups = [{ group: 'audio-understanding', modelIds: ['replacement'] }];
    await view.render(<CustomProviderModelBindings provider={draft} capabilitiesRegistry={[]} onChange={onChange} />);
    expect(view.container.querySelector('select')?.value).toBe('replacement');
  });
});
