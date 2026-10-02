import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { appConfigDraftMock } from '../../mocks/app-config';
import { registerDomHarness } from '../../test-utils/component-test-harness';
import { click } from '../../test-utils/dom-interactions';
import { fetchProviderModelMetadata } from '../../runtime/provider-runtime';
import ProviderMetadataRefresh from './ProviderMetadataRefresh';

vi.mock('../../runtime/provider-runtime', () => ({ fetchProviderModelMetadata: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, options?: Record<string, unknown>) => `${key}${options?.error ? ': ' + options.error : ''}` }) }));
function provider() { return structuredClone(appConfigDraftMock.providers.find((p) => p.kind === 'dashscope')!); }
function response(providerId: string) { return { providerId, fetchedAt: '2026-10-02T00:00:00Z', endpoint: 'https://dashscope.aliyuncs.com/api/v1/models', models: [], error: null }; }

describe('manual metadata refresh failure and disposal', () => {
  const view = registerDomHarness({ setup: () => { vi.mocked(fetchProviderModelMetadata).mockReset(); } });

  it('is absent for non-DashScope providers and writes a successful exact-identity response', async () => {
    const draft = provider();
    const onChange = vi.fn();
    await view.render(<ProviderMetadataRefresh provider={{ ...draft, kind: 'openai-compatible' }} onChange={onChange} />);
    expect(view.container.innerHTML).toBe('');
    vi.mocked(fetchProviderModelMetadata).mockResolvedValue(response(draft.providerId));
    await view.render(<ProviderMetadataRefresh provider={draft} onChange={onChange} />);
    expect(view.container.textContent).toContain('providers.metadata.notFetched');
    await click(view.container.querySelector('button'));
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ modelMetadataCache: { source: 'bailian-api', fetchedAt: '2026-10-02T00:00:00Z', endpoint: 'https://dashscope.aliyuncs.com/api/v1/models', models: [] } });
  });

  it.each(['wrong-identity', 'service-error', 'non-error-rejection'] as const)('preserves the successful cache on %s', async (kind) => {
    const draft = provider();
    draft.modelMetadataCache = { source: 'bailian-api', fetchedAt: 'previous', models: [] };
    const original = structuredClone(draft.modelMetadataCache);
    const onChange = vi.fn();
    if (kind === 'wrong-identity') vi.mocked(fetchProviderModelMetadata).mockResolvedValue(response('other-provider'));
    else if (kind === 'service-error') vi.mocked(fetchProviderModelMetadata).mockResolvedValue({ ...response(draft.providerId), error: { code: 'provider.failure', message: 'service unavailable', retriable: true, httpStatus: 503, providerCode: null, suggestion: null } } as Awaited<ReturnType<typeof fetchProviderModelMetadata>>);
    else vi.mocked(fetchProviderModelMetadata).mockRejectedValue('transport lost');
    await view.render(<ProviderMetadataRefresh provider={draft} onChange={onChange} />);
    expect(view.container.textContent).toContain('providers.metadata.lastUpdated');
    await click(view.container.querySelector('button'));
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(kind === 'wrong-identity' ? 'identity mismatch' : kind === 'service-error' ? 'service unavailable' : 'transport lost');
    expect(view.container.querySelector('button')?.disabled).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    expect(draft.modelMetadataCache).toEqual(original);
  });

  it.each([false, true])('does not mutate after disposal when the pending request rejects=%s', async (reject) => {
    const draft = provider();
    const onChange = vi.fn();
    let resolve!: (value: Awaited<ReturnType<typeof fetchProviderModelMetadata>>) => void;
    let fail!: (value: unknown) => void;
    vi.mocked(fetchProviderModelMetadata).mockReturnValue(new Promise((yes, no) => { resolve = yes; fail = no; }));
    await view.render(<ProviderMetadataRefresh provider={draft} onChange={onChange} />);
    await click(view.container.querySelector('button'));
    expect(view.container.querySelector('button')?.disabled).toBe(true);
    await click(view.container.querySelector('button'));
    expect(fetchProviderModelMetadata).toHaveBeenCalledTimes(1);
    await view.unmount();
    await act(async () => { if (reject) fail(new Error('late failure')); else resolve(response(draft.providerId)); });
    expect(onChange).not.toHaveBeenCalled();
    expect(view.container.innerHTML).toBe('');
  });
});
