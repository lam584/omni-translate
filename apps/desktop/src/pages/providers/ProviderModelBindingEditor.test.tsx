import * as protocolResolver from '../../provider-manifest/resolver';
import { providerVerificationIdentity } from '../../utils/provider-draft-verification';
import { describe, expect, it, vi } from 'vitest';
import { appConfigDraftMock } from '../../mocks/app-config';
import { useAppStore } from '../../stores/app-store';
import { registerDomHarness } from '../../test-utils/component-test-harness';
import { buttonByText, click, inputText, selectValue } from '../../test-utils/dom-interactions';
import { createDefaultLocalModelCapabilityRegistry } from '../../utils/provider-model-capabilities';
import { modelRegistryEditorPatch } from '../../utils/provider-model-capabilities-registry';
import ProviderModelBindingEditor from './ProviderModelBindingEditor';
import ProviderCapabilityRegistryDialog from './ProviderCapabilityRegistryDialog';

function activeProvider() { return useAppStore.getState().configDraft.providers[0]; }
function BindingHarness() {
  const provider = useAppStore((state) => state.configDraft.providers[0]);
  return <ProviderModelBindingEditor provider={provider} />;
}
function RegistryHarness() {
  const provider = useAppStore((state) => state.configDraft.providers[0]);
  const update = useAppStore((state) => state.updateActiveProviderDraft);
  return <ProviderCapabilityRegistryDialog entries={provider.localModelCapabilityRegistry} modelIdSuggestions={[]}
    onAdd={() => {}} onClose={() => {}} onOpenHelp={() => {}} onCapabilityToggle={() => {}} onInteractionToggle={() => {}} onRemove={() => {}}
    onChange={(id, patch) => update(modelRegistryEditorPatch(provider, provider.localModelCapabilityRegistry.map((row) => row.id === id ? { ...row, ...patch } : row)))} />;
}

describe('model registry v2 editors', () => {
  const view = registerDomHarness({ setup: () => {
    const config = structuredClone(appConfigDraftMock);
    config.providers[0].modelRegistryVersion = 2;
    config.providers[0].modelCapabilityOverrides = [];
    config.providers[0].modelProtocolBindings = [];
    config.providers[0].localModelCapabilityRegistry = createDefaultLocalModelCapabilityRegistry(config.providers[0].templateId)
      .filter((entry) => entry.modelId === config.providers[0].model);
    useAppStore.setState({ configDraft: config });
  } });
  it('locks known identities and allows only enabled explicit unknown bindings without I/O', async () => {
    await view.render(<BindingHarness />);
    expect(view.container.querySelector('select')).toBeNull();
    await inputText(view.container.querySelector('input')!, 'custom.Exact');
    const select = view.container.querySelector('select')!;
    const option = Array.from(select.options).find((item) => item.value.includes('bailian.livetranslate.3_8.realtime.ws'))!;
    expect(option).toBeInstanceOf(HTMLOptionElement);
    expect(Array.from(select.options).some((item) => item.value.includes('bailian.omni.realtime.ws'))).toBe(false);
    await selectValue(select, option.value);
    expect(activeProvider().modelProtocolBindings).toContainEqual(expect.objectContaining({modelId: 'custom.Exact', profileId: 'bailian.livetranslate.3_8.realtime.ws', profileVersion: 1}));
    expect(activeProvider().probe.checkedAt).toBe('pending-probe');
    await inputText(view.container.querySelector('input')!, 'qwen3.8-livetranslate-flash-realtime');
    expect(view.container.querySelector('select')).toBeNull();
  });
  it('shows Workspace guidance for known/custom profiles without rewriting an address', async () => {
    const originalUrl = activeProvider().baseUrl;
    await view.render(<BindingHarness />);
    expect(view.container.querySelector('[data-testid=workspace-endpoint-hint]')).toBeNull();
    await inputText(view.container.querySelector('input')!, 'custom.Exact');
    await selectValue(view.container.querySelector('select')!, JSON.stringify(['bailian.livetranslate.3_8.realtime.ws', 1, 'realtime-translation']));
    expect(view.container.querySelector('[data-testid=workspace-endpoint-hint]')?.textContent).toContain('wss://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime');
    expect(view.container.textContent).toContain('workspace_required');
    expect(activeProvider().baseUrl).toBe(originalUrl);
    await inputText(view.container.querySelector('input')!, 'qwen3.8-livetranslate-flash-realtime');
    expect(view.container.querySelector('[data-testid=workspace-endpoint-hint]')).not.toBeNull();
    expect(activeProvider().baseUrl).toBe(originalUrl);
  });
  it('persists hidden metadata separately and restoring defaults removes the override', async () => {
    await view.render(<RegistryHarness />);
    const box = view.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await click(box);
    expect(activeProvider().modelCapabilityOverrides).toContainEqual(expect.objectContaining({modelId: activeProvider().model, hidden: true, source: 'user'}));
    expect(view.container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
    // The shared existing localization is used instead of introducing untranslated keys.
    const button = buttonByText(view.container, '恢复默认') ?? buttonByText(view.container, 'Restore defaults');
    await click(button);
    expect(activeProvider().modelCapabilityOverrides).toEqual([]);
    expect(view.container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false);
  });
  it('ignores blank/untrimmed IDs, keeps other operation bindings, and reports rejection strings', async () => {
    const provider = activeProvider();
    provider.modelProtocolBindings = undefined;
    await view.render(<BindingHarness />);
    await inputText(view.container.querySelector('input')!, ' invalid ');
    const optionValue = JSON.stringify(['bailian.livetranslate.3_8.realtime.ws', 1, 'realtime-translation']);
    await selectValue(view.container.querySelector('select')!, '');
    await selectValue(view.container.querySelector('select')!, optionValue);
    expect(activeProvider().modelProtocolBindings).toBeUndefined();
    await inputText(view.container.querySelector('input')!, 'valid.Exact');
    await selectValue(view.container.querySelector('select')!, optionValue);
    expect(activeProvider().modelProtocolBindings).toHaveLength(1);
    const selected = activeProvider().modelProtocolBindings![0];
    useAppStore.getState().updateActiveProviderDraft({modelProtocolBindings: [selected, {...selected, modelId:'other'}, {...selected, operation:'asr'}]});
    await view.render(<BindingHarness />);
    await selectValue(view.container.querySelector('select')!, optionValue);
    expect(activeProvider().modelProtocolBindings).toHaveLength(3);
    vi.spyOn(protocolResolver, 'resolveProviderProtocol').mockImplementationOnce(() => { throw 'binding rejected'; });
    await view.render(<BindingHarness />);
    expect(view.container.textContent).toContain('binding rejected');
  });
  it('only displays a matching model-bound persisted verification result', async () => {
    const provider = activeProvider();
    provider.model = 'verified.Exact';
    provider.probe = {...provider.probe, verdict:'available', checkedAt:'2026-09-20T10:00:00Z'};
    provider.status = 'ready';
    provider.probe.profileId = 'credential-proof:test-receipt';
    provider.probe.configurationSignature = providerVerificationIdentity(provider);
    await view.render(<BindingHarness />);
    const matchedText = view.container.textContent;
    await inputText(view.container.querySelector('input')!, 'different.Exact');
    expect(view.container.textContent).not.toBe(matchedText);
    await inputText(view.container.querySelector('input')!, 'verified.Exact');
    expect(view.container.textContent).toBe(matchedText);
    useAppStore.getState().updateActiveProviderDraft({baseUrl:'https://changed.invalid'});
    await view.render(<BindingHarness />);
    expect(view.container.textContent).not.toBe(matchedText);
  });

  it('uses the documented default region without inventing an endpoint for unknown regions', async () => {
    const provider = activeProvider();
    provider.model = 'qwen3.8-livetranslate-flash-realtime';
    provider.region = '';
    const originalUrl = provider.baseUrl;
    await view.render(<BindingHarness />);
    expect(view.container.querySelector('[data-testid=workspace-endpoint-hint] code')?.textContent)
      .toBe('wss://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime');
    expect(activeProvider().baseUrl).toBe(originalUrl);
    useAppStore.getState().updateActiveProviderDraft({ region: 'unknown-region' });
    await view.render(<BindingHarness />);
    expect(view.container.querySelector('[data-testid=workspace-endpoint-hint]')).not.toBeNull();
    expect(view.container.querySelector('[data-testid=workspace-endpoint-hint] code')).toBeNull();
    expect(activeProvider().baseUrl).toBe(originalUrl);
  });
});
