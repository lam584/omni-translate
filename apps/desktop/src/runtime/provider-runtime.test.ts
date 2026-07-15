import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appConfigDraftMock } from '../mocks/app-config';

const invokeMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  isTauri: () => Boolean((globalThis as typeof globalThis & { isTauri?: boolean }).isTauri),
}));

import {
  fetchProviderModels,
  getProviderSecretStatus,
  readProviderSecret,
  providerRuntimeTestHelpers,
  runProviderProbe,
  runProviderSmoke,
  saveProviderSecret,
} from './provider-runtime';

function enableTauriRuntime() {
  Object.defineProperty(globalThis, 'isTauri', {
    value: true,
    writable: true,
    configurable: true,
  });
}

function disableTauriRuntime() {
  Reflect.deleteProperty(globalThis, 'isTauri');
}

describe('provider-runtime saveProviderSecret', () => {
  beforeEach(() => {
    disableTauriRuntime();
    enableTauriRuntime();
    invokeMock.mockReset();
    Reflect.deleteProperty(window, '__OMNI_FRONTEND_DIAGNOSTICS__');
    window.localStorage.removeItem('omni.frontendDiagnosticsTrace');
    vi.useRealTimers();
  });

  afterEach(() => {
    disableTauriRuntime();
    Reflect.deleteProperty(window, '__OMNI_FRONTEND_DIAGNOSTICS__');
    window.localStorage.removeItem('omni.frontendDiagnosticsTrace');
    vi.useRealTimers();
  });

  it('issues the direct save invoke and records a local frontend trace on success', async () => {
    invokeMock.mockResolvedValue({
      reference: 'credential://provider/dashscope/default',
      backend: 'windows-credential-manager',
      hasSecret: true,
    });

    const result = await saveProviderSecret('credential://provider/dashscope/default', 'secret-token');

    expect(result).toEqual({
      reference: 'credential://provider/dashscope/default',
      backend: 'windows-credential-manager',
      hasSecret: true,
    });
    expect(invokeMock.mock.calls).toHaveLength(1);
    expect(invokeMock.mock.calls[0]?.[0]).toBe('upsert_secret_ref');
    expect(window.__OMNI_FRONTEND_DIAGNOSTICS__?.[0]).toMatchObject({
      category: 'storage',
      level: 'info',
      summary: '前端收到 API Key 保存结果。',
    });
  });

  it('records a local frontend trace when the save command rejects immediately', async () => {
    invokeMock.mockRejectedValue(new Error('backend failure'));

    await expect(saveProviderSecret('credential://provider/dashscope/default', 'secret-token')).rejects.toThrow('backend failure');

    expect(invokeMock.mock.calls).toHaveLength(1);
    expect(invokeMock.mock.calls[0]?.[0]).toBe('upsert_secret_ref');
    expect(window.__OMNI_FRONTEND_DIAGNOSTICS__?.[0]).toMatchObject({
      category: 'storage',
      level: 'error',
      summary: '前端保存 API Key 失败。',
    });
  });

  it('surfaces a slow backend failure before the save timeout elapses', async () => {
    vi.useFakeTimers();
    invokeMock.mockImplementation(() => {
      return new Promise((_, reject) => {
        window.setTimeout(() => {
          reject(new Error('CredWriteW failed with code 5'));
        }, 6000);
      });
    });

    const pending = saveProviderSecret('credential://provider/dashscope/default', 'secret-token');
    const rejection = pending.catch((error) => error);
    await vi.advanceTimersByTimeAsync(6000);

    const error = await rejection;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('CredWriteW failed with code 5');
    expect(invokeMock.mock.calls).toHaveLength(1);
    expect(invokeMock.mock.calls[0]?.[0]).toBe('upsert_secret_ref');
    expect(window.__OMNI_FRONTEND_DIAGNOSTICS__?.[0]).toMatchObject({
      category: 'storage',
      level: 'error',
      summary: '前端保存 API Key 失败。',
    });
  });

  it('times out when the native save command never returns', async () => {
    vi.useFakeTimers();
    invokeMock.mockImplementation(() => new Promise(() => undefined));

    const pending = saveProviderSecret('credential://provider/dashscope/default', 'secret-token');
    const rejection = pending.catch((error) => error);

    await vi.advanceTimersByTimeAsync(7000);

    const error = await rejection;
    expect(error).toMatchObject({
      code: 'timeout',
      operation: 'credential-save',
      retriable: true,
    });
    expect((error as Error).message).toContain('API Key 原生保存命令超时');
    expect(invokeMock.mock.calls).toHaveLength(1);
    expect(invokeMock.mock.calls[0]?.[0]).toBe('upsert_secret_ref');
    expect(window.__OMNI_FRONTEND_DIAGNOSTICS__).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'storage',
          level: 'error',
          summary: '前端等待运行时命令超时。',
        }),
      ]),
    );
  });

  it('keeps the timeout conclusion when the native command resolves after the frontend already timed out', async () => {
    vi.useFakeTimers();
    let resolveInvoke: ((value: { reference: string; backend: string; hasSecret: boolean }) => void) | undefined;
    invokeMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveInvoke = resolve as (value: { reference: string; backend: string; hasSecret: boolean }) => void;
        }),
    );

    const pending = saveProviderSecret('credential://provider/dashscope/default', 'secret-token');
    const rejection = pending.catch((error) => error);

    await vi.advanceTimersByTimeAsync(7000);

    const error = await rejection;
    expect(error).toMatchObject({
      code: 'timeout',
      operation: 'credential-save',
      retriable: true,
    });

    resolveInvoke?.({
      reference: 'credential://provider/dashscope/default',
      backend: 'windows-credential-manager',
      hasSecret: true,
    });
    await Promise.resolve();

    expect(window.__OMNI_FRONTEND_DIAGNOSTICS__).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'storage',
          level: 'error',
          summary: '前端等待运行时命令超时。',
        }),
      ]),
    );
    expect(window.localStorage.getItem('omni.frontendDiagnosticsTrace')).toContain('前端等待运行时命令超时。');
  });

  it('returns the browser preview result without issuing invoke when tauri runtime is unavailable', async () => {
    disableTauriRuntime();
    invokeMock.mockResolvedValue({
      reference: 'credential://provider/dashscope/default',
      backend: 'windows-credential-manager',
      hasSecret: true,
    });

    const result = await saveProviderSecret('credential://provider/dashscope/default', 'secret-token');

    expect(result).toEqual({
      reference: 'credential://provider/dashscope/default',
      backend: 'browser-preview',
      hasSecret: true,
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('keeps a persisted local trace buffer for later inspection', async () => {
    invokeMock.mockResolvedValue({
      reference: 'credential://provider/dashscope/default',
      backend: 'windows-credential-manager',
      hasSecret: true,
    });

    const result = await saveProviderSecret('credential://provider/dashscope/default', 'secret-token');

    expect(result).toEqual({
      reference: 'credential://provider/dashscope/default',
      backend: 'windows-credential-manager',
      hasSecret: true,
    });
    expect(window.localStorage.getItem('omni.frontendDiagnosticsTrace')).toContain('前端收到 API Key 保存结果。');
  });
});

describe('provider-runtime diagnostics cache', () => {
  beforeEach(() => {
    enableTauriRuntime();
    invokeMock.mockReset();
    Reflect.deleteProperty(window, '__OMNI_FRONTEND_DIAGNOSTICS__');
    window.localStorage.removeItem('omni.frontendDiagnosticsTrace');
  });

  afterEach(() => {
    disableTauriRuntime();
    Reflect.deleteProperty(window, '__OMNI_FRONTEND_DIAGNOSTICS__');
    window.localStorage.removeItem('omni.frontendDiagnosticsTrace');
  });

  it('recovers from malformed and non-array diagnostics cache entries', async () => {
    invokeMock.mockResolvedValue({
      reference: 'credential://provider/dashscope/default',
      backend: 'windows-credential-manager',
      hasSecret: true,
    });

    window.localStorage.setItem('omni.frontendDiagnosticsTrace', '{broken-json');
    await saveProviderSecret('credential://provider/dashscope/default', 'secret-token');
    const firstTraceCount = window.__OMNI_FRONTEND_DIAGNOSTICS__?.length ?? 0;
    expect(firstTraceCount).toBeGreaterThan(0);

    window.localStorage.setItem('omni.frontendDiagnosticsTrace', '{}');
    await saveProviderSecret('credential://provider/dashscope/default', 'secret-token');
    expect(window.__OMNI_FRONTEND_DIAGNOSTICS__?.length ?? 0).toBeGreaterThan(
      firstTraceCount,
    );
  });

  it('keeps save diagnostics in memory when local storage writes fail', async () => {
    invokeMock.mockResolvedValue({
      reference: 'credential://provider/dashscope/default',
      backend: 'windows-credential-manager',
      hasSecret: true,
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage full');
    });

    await saveProviderSecret('credential://provider/dashscope/default', 'secret-token');

    expect(window.__OMNI_FRONTEND_DIAGNOSTICS__?.length).toBeGreaterThan(0);
    setItem.mockRestore();
  });

  it('records non-error save failures', async () => {
    invokeMock.mockRejectedValue('save unavailable');

    await expect(saveProviderSecret('credential://provider/dashscope/default', 'secret-token')).rejects.toBe('save unavailable');
    expect(window.__OMNI_FRONTEND_DIAGNOSTICS__?.[0]?.detail).toContain('save unavailable');
  });

  it('reads persisted array traces and handles warning traces without detail', () => {
    window.localStorage.setItem('omni.frontendDiagnosticsTrace', JSON.stringify([{ summary: 'stored' }]));
    expect(providerRuntimeTestHelpers.readFrontendDiagnosticsTrace()).toEqual([{ summary: 'stored' }]);
    providerRuntimeTestHelpers.appendFrontendDiagnosticsTrace('provider', 'warning', 'warning trace');
    expect(window.__OMNI_FRONTEND_DIAGNOSTICS__?.[0]).toMatchObject({ level: 'warning', summary: 'warning trace' });
  });

  it('does not buffer traces when window is unavailable', () => {
    vi.stubGlobal('window', undefined);
    expect(providerRuntimeTestHelpers.readFrontendDiagnosticsTrace()).toEqual([]);
    expect(() => providerRuntimeTestHelpers.appendFrontendDiagnosticsTrace('provider', 'info', 'ignored')).not.toThrow();
    vi.unstubAllGlobals();
  });
});

describe('provider-runtime timeout helpers', () => {
  beforeEach(() => {
    enableTauriRuntime();
    invokeMock.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    disableTauriRuntime();
    vi.useRealTimers();
  });

  it('uses default timeout guidance and preview decisions for both verdicts', () => {
    expect(providerRuntimeTestHelpers.createProviderRuntimeTimeoutError('操作', 1000, 'test-operation')).toMatchObject({
      code: 'timeout',
      suggestion: '请稍后重试。',
    });
    expect(providerRuntimeTestHelpers.previewRoutingForVerdict('available')).toMatchObject({
      subtitlePriority: 'balanced',
      speechDisposition: 'ready',
    });
    expect(providerRuntimeTestHelpers.previewRoutingForVerdict('unavailable')).toMatchObject({
      subtitlePriority: 'subtitle-first',
      speechDisposition: 'deferred',
    });
  });

  it('ignores a native rejection that arrives after timeout', async () => {
    let rejectInvoke: ((reason?: unknown) => void) | undefined;
    invokeMock.mockImplementation(() => new Promise((_, reject) => {
      rejectInvoke = reject;
    }));
    const rejection = providerRuntimeTestHelpers
      .invokeWithTimeout('late_reject', {}, '操作', 1000, 'provider-test')
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(rejection).resolves.toMatchObject({ code: 'timeout' });
    rejectInvoke?.(new Error('late reject'));
    await Promise.resolve();
  });

  it('ignores an uncleared timeout callback after native resolve', async () => {
    const clearTimeout = vi.spyOn(window, 'clearTimeout').mockImplementation(() => undefined);
    invokeMock.mockResolvedValue('done');
    await expect(providerRuntimeTestHelpers.invokeWithTimeout('resolved', {}, '操作', 1000, 'provider-test')).resolves.toBe('done');
    await vi.advanceTimersByTimeAsync(1000);
    clearTimeout.mockRestore();
  });
});

describe('provider-runtime fetchProviderModels', () => {
  beforeEach(() => {
    disableTauriRuntime();
    invokeMock.mockReset();
  });

  afterEach(() => {
    disableTauriRuntime();
  });

  it('returns browser preview preset models without invoking tauri commands', async () => {
    const result = await fetchProviderModels(appConfigDraftMock.providers[0], [
      {
        id: 'preset-1',
        model: 'qwen-test',
        displayName: 'Qwen Test',
        capabilities: ['speech-to-text', 'speech-to-speech'],
        description: 'preview preset',
      },
    ]);

    expect(result.providerId).toBe(appConfigDraftMock.providers[0].providerId);
    expect(result.models).toEqual([
      {
        id: 'qwen-test',
        displayName: 'Qwen Test',
        ownedBy: 'preset',
        createdAt: null,
        capabilities: ['speech-to-text', 'speech-to-speech'],
      },
    ]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('invokes the tauri model catalog command when runtime is available', async () => {
    enableTauriRuntime();
    invokeMock.mockResolvedValue({ data: {
      providerId: appConfigDraftMock.providers[0].providerId,
      endpoint: 'https://api.openai.com/v1/models',
      fetchedAt: '2026-05-17T02:00:00.000Z',
      models: [
        {
          id: 'gpt-4.1',
          displayName: 'gpt-4.1',
          ownedBy: 'openai',
          createdAt: null,
          capabilities: ['speech-to-text'],
        },
      ],
      error: null,
    } });

    const result = await fetchProviderModels(appConfigDraftMock.providers[0]);

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls[0]).toEqual(['provider_v2', { command: { action: 'fetchModels', provider: appConfigDraftMock.providers[0] } }]);
    expect(result.models[0]?.id).toBe('gpt-4.1');
  });
});

describe('provider-runtime native command wrappers', () => {
  beforeEach(() => {
    enableTauriRuntime();
    invokeMock.mockReset();
    Reflect.deleteProperty(window, '__OMNI_FRONTEND_DIAGNOSTICS__');
    window.localStorage.removeItem('omni.frontendDiagnosticsTrace');
  });

  afterEach(() => {
    disableTauriRuntime();
    Reflect.deleteProperty(window, '__OMNI_FRONTEND_DIAGNOSTICS__');
    window.localStorage.removeItem('omni.frontendDiagnosticsTrace');
  });

  it('reads credential status and secret payloads from the native credential backend', async () => {
    invokeMock
      .mockResolvedValueOnce({
        reference: 'credential://provider/dashscope/default',
        backend: 'windows-credential-manager',
        hasSecret: true,
      })
      .mockResolvedValueOnce({
        reference: 'credential://provider/dashscope/default',
        backend: 'windows-credential-manager',
        secret: 'stored-secret',
      });

    await expect(getProviderSecretStatus('credential://provider/dashscope/default')).resolves.toMatchObject({
      backend: 'windows-credential-manager',
      hasSecret: true,
    });
    await expect(readProviderSecret('credential://provider/dashscope/default')).resolves.toMatchObject({
      backend: 'windows-credential-manager',
      secret: 'stored-secret',
    });
    expect(invokeMock.mock.calls.map((call) => call[0])).toEqual(['get_secret_ref_status', 'read_secret_ref']);
  });

  it('propagates credential read failures and records diagnostics traces', async () => {
    invokeMock.mockRejectedValueOnce(new Error('status unavailable')).mockRejectedValueOnce('secret unavailable');

    await expect(getProviderSecretStatus('credential://provider/dashscope/default')).rejects.toThrow(
      'status unavailable',
    );
    await expect(readProviderSecret('credential://provider/dashscope/default')).rejects.toBe('secret unavailable');
    expect(window.__OMNI_FRONTEND_DIAGNOSTICS__).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ summary: '前端读取 API Key 状态失败。', level: 'error' }),
        expect.objectContaining({ summary: '前端读取 API Key 明文失败。', level: 'error' }),
      ]),
    );
  });

  it('records non-error status failures and Error secret failures', async () => {
    invokeMock.mockRejectedValueOnce('status string failure').mockRejectedValueOnce(new Error('secret Error failure'));
    await expect(getProviderSecretStatus('credential://provider/dashscope/default')).rejects.toBe('status string failure');
    await expect(readProviderSecret('credential://provider/dashscope/default')).rejects.toThrow('secret Error failure');
  });

  it('invokes native probe and smoke commands with the active provider contract', async () => {
    const provider = structuredClone(appConfigDraftMock.providers[0]);
    invokeMock
      .mockResolvedValueOnce({ data: { id: 'probe-native', providerId: provider.providerId, verdict: 'available' } })
      .mockResolvedValueOnce({ data: { requestId: 'smoke-native', providerId: provider.providerId, status: 'completed' } });

    await expect(runProviderProbe(provider)).resolves.toMatchObject({ id: 'probe-native', verdict: 'available' });
    await expect(runProviderSmoke(provider, 'hello', 'en-US', 'zh-CN')).resolves.toMatchObject({
      requestId: 'smoke-native',
      status: 'completed',
    });
    expect(invokeMock.mock.calls).toEqual([
      ['provider_v2', { command: { action: 'probe', provider } }],
      [
        'provider_v2',
        {
          command: {
            action: 'smoke',
            provider,
            sourceText: 'hello',
            sourceLanguage: 'en-US',
            targetLanguage: 'zh-CN',
          },
        },
      ],
    ]);
  });
});

describe('provider-runtime non-error native failures', () => {
  beforeEach(() => {
    enableTauriRuntime();
    invokeMock.mockReset();
    Reflect.deleteProperty(window, '__OMNI_FRONTEND_DIAGNOSTICS__');
    window.localStorage.removeItem('omni.frontendDiagnosticsTrace');
  });

  afterEach(() => {
    disableTauriRuntime();
    Reflect.deleteProperty(window, '__OMNI_FRONTEND_DIAGNOSTICS__');
    window.localStorage.removeItem('omni.frontendDiagnosticsTrace');
  });

  it('records non-error native probe and smoke failures', async () => {
    const provider = structuredClone(appConfigDraftMock.providers[0]);
    invokeMock.mockRejectedValueOnce('probe unavailable').mockRejectedValueOnce('smoke unavailable');

    await expect(runProviderProbe(provider)).rejects.toBe('probe unavailable');
    await expect(runProviderSmoke(provider, 'hello', 'en-US', 'zh-CN')).rejects.toBe('smoke unavailable');
    expect(window.__OMNI_FRONTEND_DIAGNOSTICS__).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: 'error',
          detail: expect.stringContaining('probe unavailable'),
        }),
        expect.objectContaining({
          level: 'error',
          detail: expect.stringContaining('smoke unavailable'),
        }),
      ]),
    );
  });
});

describe('provider-runtime browser preview helpers', () => {
  beforeEach(() => {
    disableTauriRuntime();
    invokeMock.mockReset();
  });

  afterEach(() => {
    disableTauriRuntime();
  });

  it('returns preview credential status and secret payloads without native invoke', async () => {
    await expect(getProviderSecretStatus('credential://provider/test')).resolves.toEqual({
      reference: 'credential://provider/test',
      backend: 'browser-preview',
      hasSecret: false,
    });
    await expect(readProviderSecret('credential://provider/test')).resolves.toEqual({
      reference: 'credential://provider/test',
      backend: 'browser-preview',
      secret: null,
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('returns deferred preview routing for websocket providers', async () => {
    const provider = {
      ...appConfigDraftMock.providers[0],
      transport: 'websocket' as const,
    };

    const probe = await runProviderProbe(provider);
    expect(probe.routingDecision.subtitlePriority).toBe('balanced');
    expect(probe.routingDecision.speechDisposition).toBe('ready');
  });

  it('returns preview probe and smoke results with provider transport routing', async () => {
    const provider = {
      ...appConfigDraftMock.providers[0],
      transport: 'http' as const,
    };

    const probe = await runProviderProbe(provider);
    const smoke = await runProviderSmoke(provider, 'hello', 'en', 'zh-CN');

    expect(probe.transportRequested).toBe('http');
    expect(probe.transportEffective).toBe('http');
    expect(probe.routingDecision.speechDisposition).toBe('ready');
    expect(smoke.streamObserved).toBe(false);
    expect(smoke.sourceLanguage).toBe('en');
    expect(smoke.targetLanguage).toBe('zh-CN');
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
