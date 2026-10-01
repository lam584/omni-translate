import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { appConfigDraftMock } from '../../mocks/app-config';
import type { ProviderDraft } from '../../schema/config';
import { registerDomHarness } from '../../test-utils/component-test-harness';
import ProviderMetadataRefresh from './ProviderMetadataRefresh';

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../../runtime/provider-runtime', () => ({ fetchProviderModelMetadata: mocks.fetch }));

const view = registerDomHarness({ setup: () => { mocks.fetch.mockReset(); } });
const provider: ProviderDraft = { ...appConfigDraftMock.providers[0], kind: 'dashscope', modelMetadataCache: {
  source: 'bailian-api', fetchedAt: '2026-09-01', models: [{ modelId: 'cached', categories: ['TG'], requestModalities: ['Text'], responseModalities: ['Text'] }],
} };

async function clickRefresh() {
  const button = view.container.querySelector<HTMLButtonElement>('button');
  expect(button).toBeInstanceOf(HTMLButtonElement);
  await act(async () => {
    button?.click();
    await Promise.resolve();
  });
}

describe('manual provider metadata refresh', () => {
  it('saves only successful metadata without modifying other provider fields', async () => {
    const cache = { source: 'bailian-api' as const, fetchedAt: '2026-09-29', endpoint: 'https://example.invalid', models: [] };
    mocks.fetch.mockResolvedValue({ providerId: provider.providerId, ...cache, error: null });
    const onChange = vi.fn();
    await view.render(<ProviderMetadataRefresh provider={provider} onChange={onChange} />);
    expect(view.container.textContent).toContain('2026-09-01');
    await clickRefresh();
    expect(mocks.fetch).toHaveBeenCalledWith(provider);
    expect(onChange).toHaveBeenCalledWith({ modelMetadataCache: cache });
  });

  it('displays failure and keeps the last successful cache', async () => {
    mocks.fetch.mockRejectedValue(new Error('network unavailable'));
    const onChange = vi.fn();
    await view.render(<ProviderMetadataRefresh provider={provider} onChange={onChange} />);
    await clickRefresh();
    expect(onChange).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain('2026-09-01');
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('network unavailable');
  });

  it('does not overwrite cache when the backend reports an error result', async () => {
    mocks.fetch.mockResolvedValue({ providerId: provider.providerId, endpoint: 'https://example.invalid', fetchedAt: '2026-09-29', models: [], error: {
      code: 'unavailable', message: 'directory unavailable', retriable: true, httpStatus: 503, providerCode: null, suggestion: null,
    } });
    const onChange = vi.fn();
    await view.render(<ProviderMetadataRefresh provider={provider} onChange={onChange} />);
    await clickRefresh();
    expect(onChange).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain('2026-09-01');
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('directory unavailable');
  });
  it('does not display Bailian refresh for a different provider', async () => {
    await view.render(<ProviderMetadataRefresh provider={{ ...provider, kind: 'openai-compatible' }} onChange={vi.fn()} />);
    expect(view.container.querySelector('button')).toBeNull();
  });
});
