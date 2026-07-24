import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appConfigDraftMock } from '../../mocks/app-config';
import { providerTemplates } from '../../mocks/provider-templates';
import { useAppStore } from '../../stores/app-store';
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
  let root: Root;
  let container: HTMLDivElement;
  let params: Parameters<typeof useProviderVerificationController>[0];
  let controller: ReturnType<typeof useProviderVerificationController>;
  const activeTemplate = providerTemplates[0]!;

  function Harness() { controller = useProviderVerificationController(params); return null; }
  async function render() { await act(async () => { root.render(<Harness />); await Promise.resolve(); }); }

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  });

  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

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
    expect(params.setSecretStatusMessage).toHaveBeenCalled();
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
});
