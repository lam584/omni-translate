import { invoke } from '@tauri-apps/api/core';
import { defaultProviderProbeProfile } from '../mocks/provider-probes';
import type { ModelPreset } from '../schema/provider-template';
import type { ProviderDraft } from '../schema/config';
import type {
  CredentialSecretPayload,
  CredentialRefStatus,
  ProviderModelCatalogRuntime,
  ProviderModelRuntime,
  ProviderProbeProfileRuntime,
  ProviderSmokeResult,
} from '../schema/provider-runtime';
import { isTauriRuntime } from './tauri-runtime';

const MIN_PROVIDER_RUNTIME_TIMEOUT_MS = 1000;
const SAVE_PROVIDER_SECRET_TIMEOUT_MS = 7000;
const FRONTEND_DIAGNOSTICS_TRACE_LIMIT = 80;
const FRONTEND_DIAGNOSTICS_STORAGE_KEY = 'omni.frontendDiagnosticsTrace';

type FrontendDiagnosticsTrace = {
  scope: 'provider-runtime';
  category: string;
  level: string;
  summary: string;
  detail?: string;
  emittedAt: string;
};

declare global {
  interface Window {
    __OMNI_FRONTEND_DIAGNOSTICS__?: FrontendDiagnosticsTrace[];
  }
}

function resolveRuntimeTimeoutMs(timeoutMs: number) {
  return Math.max(timeoutMs, MIN_PROVIDER_RUNTIME_TIMEOUT_MS);
}

function createProviderRuntimeTimeoutError(actionLabel: string, timeoutMs: number, operation: string, guidance?: string) {
  const error = new Error(`${actionLabel}超时，${Math.ceil(timeoutMs / 1000)} 秒内未收到结果。${guidance ?? '请稍后重试。'}`);

  Object.assign(error, {
    code: 'timeout',
    operation,
    retriable: true,
    suggestion: guidance ?? '请稍后重试。',
  });

  return error;
}

function readFrontendDiagnosticsTrace() {
  if (typeof window === 'undefined') {
    return [] as FrontendDiagnosticsTrace[];
  }

  if (Array.isArray(window.__OMNI_FRONTEND_DIAGNOSTICS__)) {
    return window.__OMNI_FRONTEND_DIAGNOSTICS__;
  }

  try {
    const raw = window.localStorage.getItem(FRONTEND_DIAGNOSTICS_STORAGE_KEY);
    if (!raw) {
      return [] as FrontendDiagnosticsTrace[];
    }

    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as FrontendDiagnosticsTrace[]) : ([] as FrontendDiagnosticsTrace[]);
  } catch {
    return [] as FrontendDiagnosticsTrace[];
  }
}

function appendFrontendDiagnosticsTrace(category: string, level: string, summary: string, detail?: string) {
  if (typeof window === 'undefined') {
    return;
  }

  const entry: FrontendDiagnosticsTrace = {
    scope: 'provider-runtime',
    category,
    level,
    summary,
    detail,
    emittedAt: new Date().toISOString(),
  };

  const nextTrace = [entry, ...readFrontendDiagnosticsTrace()].slice(0, FRONTEND_DIAGNOSTICS_TRACE_LIMIT);
  window.__OMNI_FRONTEND_DIAGNOSTICS__ = nextTrace;

  try {
    window.localStorage.setItem(FRONTEND_DIAGNOSTICS_STORAGE_KEY, JSON.stringify(nextTrace));
  } catch {
    // Diagnostics buffering must never block the main workflow.
  }

  const message = detail ? `${summary} ${detail}` : summary;
  if (level === 'error') {
    console.error('[omni][provider-runtime]', message);
    return;
  }

  if (level === 'warning') {
    console.warn('[omni][provider-runtime]', message);
    return;
  }

  console.info('[omni][provider-runtime]', message);
}

function diagnosticsCategoryForOperation(operation: string) {
  return operation.startsWith('credential-') ? 'storage' : 'provider';
}

function mapPresetToRuntimeModel(preset: ModelPreset): ProviderModelRuntime {
  return {
    id: preset.model,
    displayName: preset.displayName,
    ownedBy: 'preset',
    createdAt: null,
    capabilities: preset.capabilities,
  };
}

function previewRoutingForVerdict(verdict: ProviderProbeProfileRuntime['verdict']) {
  return {
    subtitlePriority: verdict === 'available' ? ('balanced' as const) : ('subtitle-first' as const),
    speechDisposition: verdict === 'available' ? ('ready' as const) : ('deferred' as const),
    rationale: '当前运行在浏览器预览模式，使用 mock probe 结果。',
  };
}

async function invokeWithTimeout<T>(
  command: string,
  payload: Record<string, unknown>,
  actionLabel: string,
  timeoutMs: number | null,
  operation: string,
  guidance?: string,
): Promise<T> {
  const startedAt = Date.now();
  const category = diagnosticsCategoryForOperation(operation);
  const effectiveTimeoutMs = timeoutMs === null ? null : resolveRuntimeTimeoutMs(timeoutMs);

  appendFrontendDiagnosticsTrace(
    category,
    'info',
    '前端发起运行时命令。',
    `command=${command} operation=${operation} timeoutMs=${effectiveTimeoutMs ?? 'none'} payloadKeys=${Object.keys(payload).join(',')}`,
  );

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timeoutId =
      effectiveTimeoutMs === null
        ? null
        : window.setTimeout(() => {
            if (settled) {
              return;
            }

            settled = true;
            appendFrontendDiagnosticsTrace(
              category,
              'error',
              '前端等待运行时命令超时。',
              `command=${command} operation=${operation} elapsedMs=${Date.now() - startedAt}`,
            );
            reject(createProviderRuntimeTimeoutError(actionLabel, effectiveTimeoutMs, operation, guidance));
          }, effectiveTimeoutMs);

    invoke<T>(command, payload)
      .then((result) => {
        if (settled) {
          return;
        }

        settled = true;
        if (timeoutId !== null) {
          window.clearTimeout(timeoutId);
        }
        appendFrontendDiagnosticsTrace(
          category,
          'info',
          '前端收到运行时命令结果。',
          `command=${command} operation=${operation} elapsedMs=${Date.now() - startedAt}`,
        );
        resolve(result);
      })
      .catch((error) => {
        if (settled) {
          return;
        }

        settled = true;
        if (timeoutId !== null) {
          window.clearTimeout(timeoutId);
        }
        const detail = error instanceof Error ? error.message : String(error);
        appendFrontendDiagnosticsTrace(
          category,
          'error',
          '前端运行时命令失败。',
          `command=${command} operation=${operation} elapsedMs=${Date.now() - startedAt} error=${detail}`,
        );
        reject(error);
      });
  });
}

export async function getProviderSecretStatus(reference: string): Promise<CredentialRefStatus> {
  if (!isTauriRuntime()) {
    return {
      reference,
      backend: 'browser-preview',
      hasSecret: false,
    };
  }

  appendFrontendDiagnosticsTrace('storage', 'info', '前端准备读取 API Key 状态。', `reference=${reference}`);

  try {
    const result = await invokeWithTimeout<CredentialRefStatus>(
      'get_secret_ref_status',
      { reference },
      '读取已保存 API Key 状态',
      null,
      'credential-status',
      '请检查 Windows Credential Manager 是否可用后重试。',
    );

    appendFrontendDiagnosticsTrace(
      'storage',
      'info',
      '前端收到 API Key 状态结果。',
      `reference=${reference} backend=${result.backend} hasSecret=${result.hasSecret}`,
    );
    return result;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    appendFrontendDiagnosticsTrace('storage', 'error', '前端读取 API Key 状态失败。', `reference=${reference} error=${detail}`);
    throw error;
  }
}

export async function saveProviderSecret(reference: string, secret: string): Promise<CredentialRefStatus> {
  if (!isTauriRuntime()) {
    return {
      reference,
      backend: 'browser-preview',
      hasSecret: secret.length > 0,
    };
  }

  appendFrontendDiagnosticsTrace('storage', 'info', '前端准备保存 API Key。', `reference=${reference} secretLength=${secret.length}`);

  try {
    const result = await invokeWithTimeout<CredentialRefStatus>(
      'upsert_secret_ref',
      { reference, secret },
      'API Key 原生保存命令',
      SAVE_PROVIDER_SECRET_TIMEOUT_MS,
      'credential-save',
      '请检查 Windows Credential Manager 是否可用后重试。',
    );

    appendFrontendDiagnosticsTrace(
      'storage',
      'info',
      '前端收到 API Key 保存结果。',
      `reference=${reference} backend=${result.backend} hasSecret=${result.hasSecret}`,
    );

    return result;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    appendFrontendDiagnosticsTrace('storage', 'error', '前端保存 API Key 失败。', `reference=${reference} error=${detail}`);
    throw error;
  }
}

export async function readProviderSecret(reference: string): Promise<CredentialSecretPayload> {
  if (!isTauriRuntime()) {
    return {
      reference,
      backend: 'browser-preview',
      secret: null,
    };
  }

  appendFrontendDiagnosticsTrace('storage', 'info', '前端准备读取 API Key 明文。', `reference=${reference}`);

  try {
    const result = await invokeWithTimeout<CredentialSecretPayload>(
      'read_secret_ref',
      { reference },
      '读取已保存 API Key',
      null,
      'credential-read',
      '请检查 Windows Credential Manager 是否可用后重试。',
    );

    appendFrontendDiagnosticsTrace(
      'storage',
      'info',
      '前端收到 API Key 明文结果。',
      `reference=${reference} hasSecret=${Boolean(result.secret)}`,
    );
    return result;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    appendFrontendDiagnosticsTrace('storage', 'error', '前端读取 API Key 明文失败。', `reference=${reference} error=${detail}`);
    throw error;
  }
}

export async function runProviderProbe(provider: ProviderDraft): Promise<ProviderProbeProfileRuntime> {
  if (!isTauriRuntime()) {
    return {
      id: defaultProviderProbeProfile.id,
      templateId: defaultProviderProbeProfile.templateId,
      providerId: defaultProviderProbeProfile.providerId,
      verdict: defaultProviderProbeProfile.verdict,
      checkedAt: defaultProviderProbeProfile.checkedAt,
      measuredLatencyMs: defaultProviderProbeProfile.measuredLatencyMs,
      latencyBudgetMs: defaultProviderProbeProfile.latencyBudgetMs,
      streamSupported: defaultProviderProbeProfile.streamSupported,
      errorShapeStable: defaultProviderProbeProfile.errorShapeStable,
      responseShapeStable: defaultProviderProbeProfile.responseShapeStable,
      transportRequested: provider.transport,
      transportEffective: provider.transport,
      fallbackApplied: false,
      checks: defaultProviderProbeProfile.checks,
      guidance: defaultProviderProbeProfile.guidance,
      routingDecision: previewRoutingForVerdict(defaultProviderProbeProfile.verdict),
      error: null,
    };
  }

  return invokeWithTimeout<ProviderProbeProfileRuntime>(
    'probe_provider',
    { provider },
    '模型连通性检测',
    provider.timeoutMs + 3000,
    'provider-probe',
    '请检查接口地址、网络连通性，或先切换到 HTTP 传输模式后重试。',
  );
}

export async function fetchProviderModels(
  provider: ProviderDraft,
  presetModels: ModelPreset[] = [],
): Promise<ProviderModelCatalogRuntime> {
  if (!isTauriRuntime()) {
    const models = presetModels.map(mapPresetToRuntimeModel);

    return {
      providerId: provider.providerId,
      endpoint: `${provider.baseUrl.replace(/\/$/, '')}/models`,
      fetchedAt: new Date().toISOString(),
      models,
      error: null,
    };
  }

  return invokeWithTimeout<ProviderModelCatalogRuntime>(
    'fetch_provider_models',
    { provider },
    '获取模型列表',
    provider.timeoutMs + 3000,
    'provider-models',
    '请检查接口地址、API Key 和网络连通性后重试。',
  );
}

export async function runProviderSmoke(
  provider: ProviderDraft,
  sourceText: string,
  sourceLanguage: string,
  targetLanguage: string,
): Promise<ProviderSmokeResult> {
  if (!isTauriRuntime()) {
    return {
      requestId: 'browser-preview-smoke',
      providerId: provider.providerId,
      status: 'completed',
      transportRequested: provider.transport,
      transportEffective: provider.transport,
      fallbackApplied: false,
      streamObserved: provider.transport !== 'http',
      durationMs: 120,
      firstEventLatencyMs: 48,
      transcript: 'Browser preview translation result.',
      sourceLanguage,
      targetLanguage,
      eventLog: [
        {
          eventType: 'session.started',
          summary: '浏览器预览模式已建立 mock 会话。',
        },
        {
          eventType: 'translation.completed',
          summary: '浏览器预览模式返回了整段 mock 文本。',
          segmentId: 'segment-preview',
          text: 'Browser preview translation result.',
        },
        {
          eventType: 'response.completed',
          summary: '浏览器预览模式响应结束。',
        },
      ],
      inputTokens: 12,
      outputTokens: 5,
      audioSeconds: null,
      routingDecision: {
        subtitlePriority: 'balanced',
        speechDisposition: 'ready',
        rationale: '当前运行在浏览器预览模式，未连接真实 Provider。',
      },
      error: null,
    };
  }

  return invokeWithTimeout<ProviderSmokeResult>(
    'execute_provider_smoke',
    {
      provider,
      sourceText,
      sourceLanguage,
      targetLanguage,
    },
    '模型冒烟测试',
    provider.timeoutMs + 3000,
    'provider-smoke',
    '请检查接口地址、网络连通性，或先切换到 HTTP 传输模式后重试。',
  );
}

export const providerRuntimeTestHelpers = {
  resolveRuntimeTimeoutMs,
  createProviderRuntimeTimeoutError,
  readFrontendDiagnosticsTrace,
  appendFrontendDiagnosticsTrace,
  diagnosticsCategoryForOperation,
  mapPresetToRuntimeModel,
  previewRoutingForVerdict,
  invokeWithTimeout,
};
