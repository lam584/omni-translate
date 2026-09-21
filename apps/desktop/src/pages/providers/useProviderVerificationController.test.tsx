import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { appConfigDraftMock } from '../../mocks/app-config';
import { providerTemplates } from '../../mocks/provider-templates';
import { useAppStore } from '../../stores/app-store';
import { registerDomHarness } from '../../test-utils/component-test-harness';
import { providersPageHelpers, type ModelCatalogState } from './providersPageHelpers';
import { useProviderVerificationController } from './useProviderVerificationController';

const runtime = vi.hoisted(() => ({
  fetchModels: vi.fn(), getSecretStatus: vi.fn(), readSecret: vi.fn(), probe: vi.fn(), smoke: vi.fn(), saveSecret: vi.fn(),
}));
vi.mock('../../runtime/provider-runtime', () => ({
  fetchProviderModels: runtime.fetchModels, getProviderSecretStatus: runtime.getSecretStatus,
  readProviderSecret: runtime.readSecret, runProviderProbe: runtime.probe,
  runProviderSmoke: runtime.smoke, saveProviderSecret: runtime.saveSecret,
}));

describe('useProviderVerificationController', () => {
  let params: Parameters<typeof useProviderVerificationController>[0];
  let controller: ReturnType<typeof useProviderVerificationController>;
  const activeTemplate = providerTemplates[0]!;

  function Harness() { controller = useProviderVerificationController(params); return null; }
  async function render() { await act(async () => { view.root.render(<Harness />); await Promise.resolve(); }); }

  const view = registerDomHarness({
    setup: () => {
      vi.clearAllMocks();
      const configDraft = structuredClone(appConfigDraftMock);
      useAppStore.setState((state) => ({ ...state, configDraft }));
      const activeProvider = configDraft.providers[0]!;
      runtime.getSecretStatus.mockResolvedValue({ hasSecret: false });
      runtime.fetchModels.mockResolvedValue({ models: [], error: null, endpoint: null, fetchedAt: 'now' });
      params = {
        t: ((key: string) => key) as never,
        activeProvider, activeTemplate, providerRuntimeBlocked: false, providerRuntimeStatusMessage: null,
        sourceLanguage: 'en', targetLanguage: 'zh', sampleText: 'hello', secretDraft: '', secretVisible: false,
        setBusyAction: vi.fn(), setProbeResult: vi.fn(), setSmokeResult: vi.fn(), setSecretDraft: vi.fn(),
        setSecretStored: vi.fn(), setSecretStatusMessage: vi.fn(), setSecretVisible: vi.fn(), setVerificationModalOpen: vi.fn(),
        modelCatalogSignature: providersPageHelpers.buildModelCatalogSignature(activeProvider),
        localModelCapabilityRegistry: activeProvider.localModelCapabilityRegistry ?? [], setModelCatalog: vi.fn(),
      };
    },
  });

  it('ignores late secret-status success and failure after effect cleanup', async () => {
    let resolve!: (value: { hasSecret: boolean }) => void;
    runtime.getSecretStatus.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await render();
    params = { ...params, providerRuntimeBlocked: true };
    await render();
    await act(async () => resolve({ hasSecret: true }));

    params = { ...params, providerRuntimeBlocked: false };
    let reject!: (reason: unknown) => void;
    runtime.getSecretStatus.mockImplementationOnce(() => new Promise((_done, fail) => { reject = fail; }));
    await render();
    params = { ...params, providerRuntimeBlocked: true };
    await render();
    await act(async () => reject('late failure'));
    expect(params.setSecretStatusMessage).not.toHaveBeenCalledWith(expect.stringContaining('late failure'));
  });

  it('covers blocked actions and the empty save guard with translated fallback messages', async () => {
    params.activeProvider = { ...params.activeProvider, baseUrl: '' };
    await render();
    await act(async () => controller.handleSecretSave());

    params = { ...params, providerRuntimeBlocked: true, providerRuntimeStatusMessage: null, secretDraft: 'key' };
    await render();
    await act(async () => controller.handleSecretSave());
    await act(async () => controller.handleSecretVisibilityToggle());
    await act(async () => controller.handleVerificationRun());
    await act(async () => controller.refreshModelCatalog());
    // 保存/读取/验证三个被阻断动作各产生一条回退文案（t 桩直接回显 key）。
    const blockedMessages = vi.mocked(params.setSecretStatusMessage).mock.calls
      .filter(([message]) => message === 'providers.messages.storageBlockedAction');
    expect(blockedMessages).toHaveLength(3);
    // 被阻断的目录刷新则落到目录错误态，而非密钥状态文案。
    expect(params.setModelCatalog).toHaveBeenCalledWith(expect.objectContaining({
      signature: params.modelCatalogSignature,
      status: 'error',
      error: 'providers.messages.storageBlockedAction',
    }));
  });

  it('resets a template without a capability registry and exercises visibility short-circuits', async () => {
    params.activeProvider = { ...params.activeProvider, localModelCapabilityRegistry: undefined as never };
    await render();
    act(() => controller.resetForTemplate(activeTemplate));

    params = { ...params, secretVisible: true };
    await render();
    await act(async () => controller.handleSecretVisibilityToggle());
    params = { ...params, secretVisible: false, secretDraft: 'already entered' };
    await render();
    await act(async () => controller.handleSecretVisibilityToggle());
    expect(params.setSecretVisible).toHaveBeenCalledWith(true);
  });

  it('loads empty catalogs, persists a secret, reveals both empty and present secrets, and handles verification paths', async () => {
    await render();
    runtime.fetchModels.mockResolvedValueOnce({ models: [], error: null, endpoint: null, fetchedAt: 'now' });
    await act(async () => controller.refreshModelCatalog());

    params = { ...params, secretDraft: ' key ' };
    runtime.saveSecret.mockResolvedValue(undefined);
    await render();
    await act(async () => controller.handleSecretSave());

    params = { ...params, secretDraft: '' };
    runtime.readSecret.mockResolvedValueOnce({ secret: '' }).mockResolvedValueOnce({ secret: 'stored' });
    await render();
    await act(async () => controller.handleSecretVisibilityToggle());
    await act(async () => controller.handleSecretVisibilityToggle());

    runtime.probe.mockResolvedValueOnce({ verdict: 'unavailable', error: { code: 'x', message: 'bad', retriable: false } });
    await act(async () => controller.handleVerificationRun());
    runtime.probe.mockResolvedValueOnce({ verdict: 'available', error: null });
    runtime.smoke.mockResolvedValueOnce({ error: null, streamObserved: true });
    await act(async () => controller.handleVerificationRun());
    expect(runtime.fetchModels).toHaveBeenCalledWith(params.activeProvider, []);
    expect(runtime.saveSecret).toHaveBeenCalledWith(params.activeProvider.authRef.reference, 'key');
    expect(runtime.readSecret).toHaveBeenCalledWith(params.activeProvider.authRef.reference);
    expect(params.setSecretStatusMessage).toHaveBeenCalledWith('providers.messages.noStoredSecret');
    expect(params.setSecretDraft).toHaveBeenCalledWith('stored');
    expect(runtime.probe).toHaveBeenCalledWith(params.activeProvider);
    expect(runtime.smoke).toHaveBeenCalledWith(params.activeProvider, 'hello', 'en', 'zh');
    expect(params.setVerificationModalOpen).toHaveBeenCalledWith(true);
  });

  it('keeps an already-loading matching catalog while a valid cache is present', async () => {
    const current = providersPageHelpers.createEmptyModelCatalog(params.modelCatalogSignature, 'loading');
    let nextState: ModelCatalogState = current;
    const setModelCatalog = vi.fn((next: ModelCatalogState | ((value: ModelCatalogState) => ModelCatalogState)) => {
      nextState = typeof next === 'function' ? next(current) : next;
    });
    params = {
      ...params,
      activeProvider: { ...params.activeProvider, modelCatalogCache: {
        ...params.activeProvider.modelCatalogCache,
        signature: params.modelCatalogSignature,
        fetchedAt: 'now',
      } },
      setModelCatalog,
    };
    await render();
    await act(async () => Promise.resolve());
    expect(nextState).toBe(current);
  });
  it('discards a late verification result after a registry edit', async () => {
    let finish!: (value: unknown) => void;
    runtime.probe.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await render();
    vi.mocked(params.setProbeResult).mockClear();
    let pending!: Promise<void>;
    await act(async () => { pending = controller.handleVerificationRun(); await Promise.resolve(); });
    act(() => useAppStore.getState().updateActiveProviderDraft({ modelRegistryVersion: 2, modelCapabilityOverrides: [{ modelId: params.activeProvider.model, capabilities: [] }] }));
    await act(async () => { finish({ verdict: 'available', error: null }); await pending; });
    expect(params.setProbeResult).not.toHaveBeenCalled();
    expect(runtime.smoke).not.toHaveBeenCalled();
    expect(useAppStore.getState().configDraft.providers[0].probe.checkedAt).toBe('pending-probe');
  });

  it.each(['resolve', 'reject'] as const)('discards a stale smoke %s after binding changes', async (settlement) => {
    runtime.probe.mockResolvedValueOnce({ verdict: 'available', error: null });
    let finish!: (value: unknown) => void;
    let fail!: (reason: unknown) => void;
    runtime.smoke.mockImplementationOnce(() => new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
    await render();
    let pending!: Promise<void>;
    await act(async () => { pending = controller.handleVerificationRun(); await Promise.resolve(); });
    expect(runtime.smoke).toHaveBeenCalledTimes(1);
    vi.mocked(params.setSmokeResult).mockClear();
    vi.mocked(params.setSecretStatusMessage).mockClear();
    act(() => useAppStore.getState().updateActiveProviderDraft({ modelProtocolBindings: [{modelId: params.activeProvider.model, operation:'realtime-translation',profileOwnerProviderId:'bailian',manifestVersion:1,profileId:'changed',profileVersion:2}] }));
    await act(async () => { if (settlement === 'resolve') finish({error: null, streamObserved: true}); else fail(new Error('obsolete failure')); await pending; });
    expect(params.setSmokeResult).not.toHaveBeenCalled();
    expect(params.setSecretStatusMessage).not.toHaveBeenCalled();
    expect(useAppStore.getState().configDraft.providers[0].status).toBe('draft');
  });

  it.each(['probe', 'smoke'] as const)('invalidates shared credentials and discards old %s after saving', async (stage) => {
    const original = params.activeProvider;
    const shared = { ...structuredClone(original), providerId: 'shared-instance' };
    const unrelated = { ...structuredClone(original), providerId: 'other-instance', authRef: { ...original.authRef, reference: 'credential://other' } };
    useAppStore.getState().updateProviders([original, shared, unrelated]);
    const unrelatedBefore = useAppStore.getState().configDraft.providers[2];
    let finish!: (value: unknown) => void;
    runtime.probe.mockResolvedValue({ verdict: 'available', error: null });
    runtime[stage].mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await render();
    let pending!: Promise<void>;
    await act(async () => { pending = controller.handleVerificationRun(); await Promise.resolve(); });
    params = { ...params, secretDraft: 'replacement-test-value' };
    runtime.saveSecret.mockResolvedValueOnce(undefined);
    await render();
    await act(async () => controller.handleSecretSave());
    vi.mocked(params.setProbeResult).mockClear();
    vi.mocked(params.setSmokeResult).mockClear();
    await act(async () => { finish({ verdict: 'available', error: null, streamObserved: true }); await pending; });
    const providers = useAppStore.getState().configDraft.providers;
    expect(providers.slice(0, 2).every((provider) => provider.status === 'draft' && provider.probe.checkedAt === 'pending-probe')).toBe(true);
    expect(providers[2]).toEqual(unrelatedBefore);
    expect(params.setProbeResult).not.toHaveBeenCalled();
    expect(params.setSmokeResult).not.toHaveBeenCalled();
    expect(JSON.stringify(providers)).not.toContain('replacement-test-value');
  });

  it('keeps failed credential writes invalidated and blocks verification during a write', async () => {
    params = { ...params, secretDraft: 'replacement-test-value' };
    let fail!: (reason: unknown) => void;
    runtime.saveSecret.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    await render();
    let pending!: Promise<void>;
    await act(async () => { pending = controller.handleSecretSave(); await Promise.resolve(); });
    await act(async () => controller.handleVerificationRun());
    expect(runtime.probe).not.toHaveBeenCalled();
    await act(async () => { fail(new Error('timeout')); await pending; });
    expect(useAppStore.getState().configDraft.providers[0].status).toBe('draft');
    expect(useAppStore.getState().configDraft.providers[0].probe.checkedAt).toBe('pending-probe');
  });

  it('notifies another mounted controller sharing authRef while isolating instance result writes', async () => {
    const first = params.activeProvider;
    const second = { ...structuredClone(first), providerId: 'second-instance' };
    useAppStore.getState().updateProviders([first, second]);
    const otherParams = { ...params, activeProvider: second, setProbeResult: vi.fn(), setSmokeResult: vi.fn() };
    let otherController!: ReturnType<typeof useProviderVerificationController>;
    function OtherHarness() { otherController = useProviderVerificationController(otherParams); return null; }
    params = { ...params, secretDraft: 'replacement-test-value' };
    await act(async () => { view.root.render(<><Harness /><OtherHarness /></>); await Promise.resolve(); });
    runtime.probe.mockResolvedValueOnce({ verdict: 'available', checkedAt: 'verified', error: null });
    runtime.smoke.mockResolvedValueOnce({ error: null, streamObserved: true });
    await act(async () => otherController.handleVerificationRun());
    expect(useAppStore.getState().configDraft.providers[0]).toEqual(first);
    expect(useAppStore.getState().configDraft.providers[1].status).toBe('ready');
    otherParams.setProbeResult.mockClear();
    otherParams.setSmokeResult.mockClear();
    runtime.saveSecret.mockResolvedValueOnce(undefined);
    await act(async () => controller.handleSecretSave());
    expect(otherParams.setProbeResult).toHaveBeenCalledWith(null);
    expect(otherParams.setSmokeResult).toHaveBeenCalledWith(null);
    expect(useAppStore.getState().configDraft.providers.every((provider) => provider.probe.checkedAt === 'pending-probe')).toBe(true);
  });

});
