import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appConfigDraftMock } from '../mocks/app-config';

vi.mock('@tauri-apps/api/core', async () => (await import('../test-utils/tauri-invoke-mock')).tauriCoreMockModuleWithRuntimeFlag());

import { invokeMock } from '../test-utils/tauri-invoke-mock';

import {
  enablePreviewDesktopRuntime as disableTauriRuntime,
  enableTauriDesktopRuntime as enableTauriRuntime,
} from '../test-utils/runtime-test-harness';
import { getRecentFrontendLogEntries, loggerTestHelpers } from './logger';
import {
  fetchProviderModels,
  getProviderSecretStatus,
  readProviderSecret,
  providerRuntimeTestHelpers,
  runProviderProbe,
  runProviderSmoke,
  saveProviderSecret,
} from './provider-runtime';

/** Entries recorded through the unified logger, newest first. */
function recentTraceEntries() {
  return [...getRecentFrontendLogEntries()].reverse();
}

/** Invoke calls issued by the code under test, excluding logger forwarding. */
function nonLoggerInvokeCalls() {
  return invokeMock.mock.calls.filter((call) => call[0] !== 'append_frontend_diagnostics_logs');
}

const SECRET_REFERENCE = 'credential://provider/dashscope/default';

/** Success envelope returned by the native secretUpsert command. */
function credentialSaveEnvelope() {
  return {
    data: {
      reference: SECRET_REFERENCE,
      backend: 'windows-credential-manager',
      hasSecret: true,
    },
    warnings: [],
  };
}

/** Saves the default secret and asserts the full native result payload. */
async function saveSecretExpectingNativeResult() {
  const result = await saveProviderSecret(SECRET_REFERENCE, 'secret-token');
  expect(result).toEqual({
    reference: SECRET_REFERENCE,
    backend: 'windows-credential-manager',
    hasSecret: true,
  });
}

/** Asserts exactly one non-logger invoke carrying the secretUpsert envelope. */
function expectSingleSecretUpsertInvoke() {
  expect(nonLoggerInvokeCalls()).toHaveLength(1);
  expect(nonLoggerInvokeCalls()[0]).toEqual([
    'configuration_v2',
    { command: { action: 'secretUpsert', reference: SECRET_REFERENCE, secret: 'secret-token' } },
  ]);
}

/** Asserts the newest trace records the localized save failure. */
function expectLatestSaveFailureTrace() {
  expect(recentTraceEntries()[0]).toMatchObject({
    category: 'storage',
    level: 'error',
    summary: '前端保存 API Key 失败。',
  });
}

/** Starts a save, advances fake timers past the deadline and asserts the timeout error. */
async function expectSaveTimeoutAfter(ms: number) {
  const pending = saveProviderSecret(SECRET_REFERENCE, 'secret-token');
  const rejection = pending.catch((error) => error);

  await vi.advanceTimersByTimeAsync(ms);

  const error = await rejection;
  expect(error).toMatchObject({
    code: 'timeout',
    operation: 'credential-save',
    retriable: true,
  });
  return error as Error;
}

/** Asserts the trace ring recorded the runtime-command timeout entry. */
function expectRuntimeTimeoutTrace() {
  expect(recentTraceEntries()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        category: 'storage',
        level: 'error',
        summary: '前端等待运行时命令超时。',
      }),
    ]),
  );
}

/** Registers the shared Tauri runtime + logger reset hooks for a describe block. */
function registerTauriLoggerHooks() {
  beforeEach(() => {
    enableTauriRuntime();
    invokeMock.mockReset();
    loggerTestHelpers.reset();
  });
  afterEach(() => {
    disableTauriRuntime();
    loggerTestHelpers.reset();
  });
}

describe('provider-runtime saveProviderSecret', () => {
  beforeEach(() => {
    disableTauriRuntime();
    enableTauriRuntime();
    invokeMock.mockReset();
    loggerTestHelpers.reset();
    vi.useRealTimers();
  });

  afterEach(() => {
    disableTauriRuntime();
    loggerTestHelpers.reset();
    vi.useRealTimers();
  });

  it('issues the direct save invoke and records a local frontend trace on success', async () => {
    invokeMock.mockResolvedValue(credentialSaveEnvelope());

    await saveSecretExpectingNativeResult();

    expectSingleSecretUpsertInvoke();
    expect(recentTraceEntries()[0]).toMatchObject({
      category: 'storage',
      level: 'info',
      summary: '前端收到 API Key 保存结果。',
    });
  });

  it('records a local frontend trace when the save command rejects immediately', async () => {
    invokeMock.mockRejectedValue(new Error('backend failure'));

    await expect(saveProviderSecret(SECRET_REFERENCE, 'secret-token')).rejects.toThrow('backend failure');

    expectSingleSecretUpsertInvoke();
    expectLatestSaveFailureTrace();
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

    const pending = saveProviderSecret(SECRET_REFERENCE, 'secret-token');
    const rejection = pending.catch((error) => error);
    await vi.advanceTimersByTimeAsync(6000);

    const error = await rejection;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('CredWriteW failed with code 5');
    expectSingleSecretUpsertInvoke();
    expectLatestSaveFailureTrace();
  });

  it('times out when the native save command never returns', async () => {
    vi.useFakeTimers();
    invokeMock.mockImplementation(() => new Promise(() => undefined));

    const error = await expectSaveTimeoutAfter(7000);
    expect(error.message).toContain('API Key 原生保存命令超时');
    expectSingleSecretUpsertInvoke();
    expectRuntimeTimeoutTrace();
  });

  it('keeps the timeout conclusion when the native command resolves after the frontend already timed out', async () => {
    vi.useFakeTimers();
    let resolveInvoke:
      | ((value: { data: { reference: string; backend: string; hasSecret: boolean }; warnings: unknown[] }) => void)
      | undefined;
    invokeMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveInvoke = resolve as (value: { data: { reference: string; backend: string; hasSecret: boolean }; warnings: unknown[] }) => void;
        }),
    );

    const pending = saveProviderSecret(SECRET_REFERENCE, 'secret-token');
    const rejection = pending.catch((error) => error);

    await vi.advanceTimersByTimeAsync(7000);

    const error = await rejection;
    expect(error).toMatchObject({
      code: 'timeout',
      operation: 'credential-save',
      retriable: true,
    });

    resolveInvoke?.(credentialSaveEnvelope());
    await Promise.resolve();

    expectRuntimeTimeoutTrace();
  });

  it('returns the browser preview result without issuing invoke when tauri runtime is unavailable', async () => {
    disableTauriRuntime();
    invokeMock.mockResolvedValue(credentialSaveEnvelope());

    const result = await saveProviderSecret(SECRET_REFERENCE, 'secret-token');

    expect(result).toEqual({
      reference: SECRET_REFERENCE,
      backend: 'browser-preview',
      hasSecret: true,
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('keeps a bounded in-memory trace buffer for later inspection', async () => {
    invokeMock.mockResolvedValue(credentialSaveEnvelope());

    await saveSecretExpectingNativeResult();

    expect(recentTraceEntries().map((entry) => entry.summary)).toContain('前端收到 API Key 保存结果。');
  });
});

describe('provider-runtime diagnostics trace', () => {
  registerTauriLoggerHooks();

  it('accumulates trace entries across appends in the logger ring', async () => {
    invokeMock.mockResolvedValue(credentialSaveEnvelope());

    await saveProviderSecret(SECRET_REFERENCE, 'secret-token');
    const firstTraceCount = recentTraceEntries().length;
    expect(firstTraceCount).toBeGreaterThan(0);

    await saveProviderSecret(SECRET_REFERENCE, 'secret-token');
    expect(recentTraceEntries().length).toBeGreaterThan(firstTraceCount);
  });

  it('keeps save diagnostics in memory even when local storage is unavailable', async () => {
    // The unified logger never touches localStorage (the legacy
    // omni.frontendDiagnosticsTrace persistence was removed), so a broken
    // storage backend must not affect trace recording.
    invokeMock.mockResolvedValue(credentialSaveEnvelope());
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage full');
    });

    await saveProviderSecret(SECRET_REFERENCE, 'secret-token');

    expect(recentTraceEntries().length).toBeGreaterThan(0);
    setItem.mockRestore();
  });

  it('records non-error save failures', async () => {
    invokeMock.mockRejectedValue('save unavailable');

    await expect(saveProviderSecret(SECRET_REFERENCE, 'secret-token')).rejects.toBe('save unavailable');
    expect(recentTraceEntries()[0]?.detail).toContain('save unavailable');
  });

  it('handles warning traces without detail', () => {
    providerRuntimeTestHelpers.appendFrontendDiagnosticsTrace('provider', 'warning', 'warning trace');
    expect(recentTraceEntries()[0]).toMatchObject({ level: 'warning', summary: 'warning trace', detail: null });
  });

  it('still records traces when window is unavailable', () => {
    vi.stubGlobal('window', undefined);
    expect(() => providerRuntimeTestHelpers.appendFrontendDiagnosticsTrace('provider', 'info', 'window-free')).not.toThrow();
    vi.unstubAllGlobals();
    expect(recentTraceEntries().map((entry) => entry.summary)).toContain('window-free');
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

  it('uses default timeout guidance for timeout errors', () => {
    expect(providerRuntimeTestHelpers.createProviderRuntimeTimeoutError('操作', 1000, 'test-operation')).toMatchObject({
      code: 'timeout',
      suggestion: '请稍后重试。',
    });
  });

  it('ignores a native rejection that arrives after timeout', async () => {
    let rejectInvoke: ((reason?: unknown) => void) | undefined;
    invokeMock.mockImplementation(() => new Promise((_, reject) => {
      rejectInvoke = reject;
    }));
    const rejection = providerRuntimeTestHelpers
      .invokeWithTimeout(() => invokeMock('late_reject', {}), '操作', 1000, 'provider-test')
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(rejection).resolves.toMatchObject({ code: 'timeout' });
    rejectInvoke?.(new Error('late reject'));
    await Promise.resolve();
  });

  it('ignores an uncleared timeout callback after native resolve', async () => {
    const clearTimeout = vi.spyOn(window, 'clearTimeout').mockImplementation(() => undefined);
    invokeMock.mockResolvedValue('done');
    await expect(providerRuntimeTestHelpers.invokeWithTimeout(() => invokeMock('resolved', {}), '操作', 1000, 'provider-test')).resolves.toBe('done');
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
  registerTauriLoggerHooks();

  it('reads credential status and secret payloads from the native credential backend', async () => {
    invokeMock
      .mockResolvedValueOnce({
        data: {
          reference: 'credential://provider/dashscope/default',
          backend: 'windows-credential-manager',
          hasSecret: true,
        },
        warnings: [],
      })
      .mockResolvedValueOnce({
        data: {
          reference: 'credential://provider/dashscope/default',
          backend: 'windows-credential-manager',
          secret: 'stored-secret',
        },
        warnings: [],
      });

    await expect(getProviderSecretStatus('credential://provider/dashscope/default')).resolves.toMatchObject({
      backend: 'windows-credential-manager',
      hasSecret: true,
    });
    await expect(readProviderSecret('credential://provider/dashscope/default')).resolves.toMatchObject({
      backend: 'windows-credential-manager',
      secret: 'stored-secret',
    });
    expect(nonLoggerInvokeCalls()).toEqual([
      ['configuration_v2', { command: { action: 'secretStatus', reference: 'credential://provider/dashscope/default' } }],
      ['configuration_v2', { command: { action: 'secretRead', reference: 'credential://provider/dashscope/default' } }],
    ]);
  });

  it('propagates credential read failures and records diagnostics traces', async () => {
    // Dispatch by envelope action: the logger's own batched forwarding also
    // calls invoke, so consumable mockRejectedValueOnce chains would race with it.
    invokeMock.mockImplementation((command: unknown, args?: unknown) => {
      const action = (args as { command?: { action?: string } } | undefined)?.command?.action;
      if (command === 'configuration_v2' && action === 'secretStatus') return Promise.reject(new Error('status unavailable'));
      if (command === 'configuration_v2' && action === 'secretRead') return Promise.reject('secret unavailable');
      return Promise.resolve(undefined);
    });

    await expect(getProviderSecretStatus('credential://provider/dashscope/default')).rejects.toThrow(
      'status unavailable',
    );
    await expect(readProviderSecret('credential://provider/dashscope/default')).rejects.toBe('secret unavailable');
    expect(recentTraceEntries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ summary: '前端读取 API Key 状态失败。', level: 'error' }),
        expect.objectContaining({ summary: '前端读取 API Key 明文失败。', level: 'error' }),
      ]),
    );
  });

  it('records non-error status failures and Error secret failures', async () => {
    invokeMock.mockImplementation((command: unknown, args?: unknown) => {
      const action = (args as { command?: { action?: string } } | undefined)?.command?.action;
      if (command === 'configuration_v2' && action === 'secretStatus') return Promise.reject('status string failure');
      if (command === 'configuration_v2' && action === 'secretRead') return Promise.reject(new Error('secret Error failure'));
      return Promise.resolve(undefined);
    });
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
  registerTauriLoggerHooks();

  it('records non-error native probe and smoke failures', async () => {
    const provider = structuredClone(appConfigDraftMock.providers[0]);
    // Dispatch by command so the logger's own forwarding invokes cannot
    // consume the queued provider_v2 rejections.
    const providerFailures = ['probe unavailable', 'smoke unavailable'];
    invokeMock.mockImplementation((command: unknown) =>
      command === 'provider_v2' ? Promise.reject(providerFailures.shift()) : Promise.resolve(undefined));

    await expect(runProviderProbe(provider)).rejects.toBe('probe unavailable');
    await expect(runProviderSmoke(provider, 'hello', 'en-US', 'zh-CN')).rejects.toBe('smoke unavailable');
    expect(recentTraceEntries()).toEqual(
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

  it('records exactly the probe invocation and failure traces for one failed probe', async () => {
    invokeMock.mockImplementation((command: unknown) =>
      command === 'provider_v2' ? Promise.reject(new Error('probe unavailable')) : Promise.resolve(undefined));

    await expect(runProviderProbe(structuredClone(appConfigDraftMock.providers[0]))).rejects.toThrow('probe unavailable');

    expect(recentTraceEntries()).toHaveLength(2);
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
