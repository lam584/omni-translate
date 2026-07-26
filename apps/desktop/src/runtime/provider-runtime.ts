import { invoke } from '@tauri-apps/api/core';
import i18n from '../i18n/config';
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
  const effectiveGuidance = guidance ?? i18n.t('runtime.provider.defaultGuidance');
  const error = new Error(i18n.t('runtime.provider.timeoutError', { action: actionLabel, seconds: Math.ceil(timeoutMs / 1000), guidance: effectiveGuidance }));

  Object.assign(error, {
    code: 'timeout',
    operation,
    retriable: true,
    suggestion: effectiveGuidance,
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
    rationale: i18n.t('runtime.provider.previewRationale'),
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
    i18n.t('runtime.provider.traceInvokeStart'),
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
              i18n.t('runtime.provider.traceInvokeTimeout'),
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
          i18n.t('runtime.provider.traceInvokeResult'),
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
          i18n.t('runtime.provider.traceInvokeFailed'),
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

  appendFrontendDiagnosticsTrace('storage', 'info', i18n.t('runtime.provider.traceSecretStatusStart'), `reference=${reference}`);

  try {
    const result = await invokeWithTimeout<CredentialRefStatus>(
      'get_secret_ref_status',
      { reference },
      i18n.t('runtime.provider.actionSecretStatus'),
      null,
      'credential-status',
      i18n.t('runtime.provider.guidanceCredentialManager'),
    );

    appendFrontendDiagnosticsTrace(
      'storage',
      'info',
      i18n.t('runtime.provider.traceSecretStatusResult'),
      `reference=${reference} backend=${result.backend} hasSecret=${result.hasSecret}`,
    );
    return result;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    appendFrontendDiagnosticsTrace('storage', 'error', i18n.t('runtime.provider.traceSecretStatusFailed'), `reference=${reference} error=${detail}`);
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

  appendFrontendDiagnosticsTrace('storage', 'info', i18n.t('runtime.provider.traceSecretSaveStart'), `reference=${reference} secretLength=${secret.length}`);

  try {
    const result = await invokeWithTimeout<CredentialRefStatus>(
      'upsert_secret_ref',
      { reference, secret },
      i18n.t('runtime.provider.actionSecretSave'),
      SAVE_PROVIDER_SECRET_TIMEOUT_MS,
      'credential-save',
      i18n.t('runtime.provider.guidanceCredentialManager'),
    );

    appendFrontendDiagnosticsTrace(
      'storage',
      'info',
      i18n.t('runtime.provider.traceSecretSaveResult'),
      `reference=${reference} backend=${result.backend} hasSecret=${result.hasSecret}`,
    );

    return result;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    appendFrontendDiagnosticsTrace('storage', 'error', i18n.t('runtime.provider.traceSecretSaveFailed'), `reference=${reference} error=${detail}`);
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

  appendFrontendDiagnosticsTrace('storage', 'info', i18n.t('runtime.provider.traceSecretReadStart'), `reference=${reference}`);

  try {
    const result = await invokeWithTimeout<CredentialSecretPayload>(
      'read_secret_ref',
      { reference },
      i18n.t('runtime.provider.actionSecretRead'),
      null,
      'credential-read',
      i18n.t('runtime.provider.guidanceCredentialManager'),
    );

    appendFrontendDiagnosticsTrace(
      'storage',
      'info',
      i18n.t('runtime.provider.traceSecretReadResult'),
      `reference=${reference} hasSecret=${Boolean(result.secret)}`,
    );
    return result;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    appendFrontendDiagnosticsTrace('storage', 'error', i18n.t('runtime.provider.traceSecretReadFailed'), `reference=${reference} error=${detail}`);
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

  return invokeWithTimeout<{ data: ProviderProbeProfileRuntime }>(
    'provider_v2',
    { command: { action: 'probe', provider } },
    i18n.t('runtime.provider.actionProbe'),
    provider.timeoutMs + 3000,
    'provider-probe',
    i18n.t('runtime.provider.guidanceProbe'),
  ).then((result) => result.data);
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

  return invokeWithTimeout<{ data: ProviderModelCatalogRuntime }>(
    'provider_v2',
    { command: { action: 'fetchModels', provider } },
    i18n.t('runtime.provider.actionFetchModels'),
    provider.timeoutMs + 3000,
    'provider-models',
    i18n.t('runtime.provider.guidanceFetchModels'),
  ).then((result) => result.data);
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
          summary: i18n.t('runtime.provider.smokeSessionStarted'),
        },
        {
          eventType: 'translation.completed',
          summary: i18n.t('runtime.provider.smokeTranslationCompleted'),
          segmentId: 'segment-preview',
          text: 'Browser preview translation result.',
        },
        {
          eventType: 'response.completed',
          summary: i18n.t('runtime.provider.smokeResponseCompleted'),
        },
      ],
      inputTokens: 12,
      outputTokens: 5,
      audioSeconds: null,
      routingDecision: {
        subtitlePriority: 'balanced',
        speechDisposition: 'ready',
        rationale: i18n.t('runtime.provider.smokePreviewRationale'),
      },
      error: null,
    };
  }

  return invokeWithTimeout<{ data: ProviderSmokeResult }>(
    'provider_v2',
    {
      command: { action: 'smoke', provider, sourceText, sourceLanguage, targetLanguage },
    },
    i18n.t('runtime.provider.actionSmoke'),
    provider.timeoutMs + 3000,
    'provider-smoke',
    i18n.t('runtime.provider.guidanceSmoke'),
  ).then((result) => result.data);
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
