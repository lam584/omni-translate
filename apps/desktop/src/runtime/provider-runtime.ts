import i18n from '../i18n/config';
import { defaultProviderProbeProfile } from '../defaults/provider-probes';
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
import { desktopApiV2 } from './desktop-api-v2';
import { invokeWithTimeoutCore } from './invoke-with-timeout';
import { createLogger } from './logger';
import { isTauriRuntime } from './tauri-runtime';

const MIN_PROVIDER_RUNTIME_TIMEOUT_MS = 1000;
const SAVE_PROVIDER_SECRET_TIMEOUT_MS = 7000;

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

const providerTraceLoggers = new Map<string, ReturnType<typeof createLogger>>();

/**
 * Provider/credential runtime trace, routed through the unified frontend
 * logger (console mirror + bounded ring + batched forwarding). The former
 * localStorage (`omni.frontendDiagnosticsTrace`) and
 * `window.__OMNI_FRONTEND_DIAGNOSTICS__` write-only sinks were removed:
 * nothing in production ever read them.
 */
function appendFrontendDiagnosticsTrace(category: string, level: string, summary: string, detail?: string) {
  let logger = providerTraceLoggers.get(category);
  if (!logger) {
    logger = createLogger(category);
    providerTraceLoggers.set(category, logger);
  }

  if (level === 'error') {
    logger.error(summary, detail);
  } else if (level === 'warning') {
    logger.warn(summary, detail);
  } else {
    logger.info(summary, detail);
  }
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
  operation: () => Promise<T>,
  actionLabel: string,
  timeoutMs: number | null,
  operationName: string,
  guidance?: string,
): Promise<T> {
  const startedAt = Date.now();
  const category = diagnosticsCategoryForOperation(operationName);
  const effectiveTimeoutMs = timeoutMs === null ? null : resolveRuntimeTimeoutMs(timeoutMs);

  appendFrontendDiagnosticsTrace(
    category,
    'info',
    i18n.t('runtime.provider.traceInvokeStart'),
    `operation=${operationName} timeoutMs=${effectiveTimeoutMs ?? 'none'}`,
  );

  // Mirrors the pre-core `settled` gate for traces: once the timeout won the
  // race, a late settle of the underlying operation must not emit a
  // result/failure trace.
  let timedOut = false;

  const tracedOperation = () =>
    operation().then(
      (result) => {
        if (!timedOut) {
          appendFrontendDiagnosticsTrace(
            category,
            'info',
            i18n.t('runtime.provider.traceInvokeResult'),
            `operation=${operationName} elapsedMs=${Date.now() - startedAt}`,
          );
        }
        return result;
      },
      (error: unknown) => {
        if (!timedOut) {
          const detail = error instanceof Error ? error.message : String(error);
          appendFrontendDiagnosticsTrace(
            category,
            'error',
            i18n.t('runtime.provider.traceInvokeFailed'),
            `operation=${operationName} elapsedMs=${Date.now() - startedAt} error=${detail}`,
          );
        }
        throw error;
      },
    );

  return invokeWithTimeoutCore(tracedOperation, effectiveTimeoutMs, () => {
    timedOut = true;
    appendFrontendDiagnosticsTrace(
      category,
      'error',
      i18n.t('runtime.provider.traceInvokeTimeout'),
      `operation=${operationName} elapsedMs=${Date.now() - startedAt}`,
    );
    // The core only calls this factory when a timer was armed, i.e. the
    // effective timeout is a number; the fallback merely satisfies the type.
    return createProviderRuntimeTimeoutError(actionLabel, effectiveTimeoutMs ?? MIN_PROVIDER_RUNTIME_TIMEOUT_MS, operationName, guidance);
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
    const result = await invokeWithTimeout(
      () => desktopApiV2.credentials.status(reference),
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
    const result = await invokeWithTimeout(
      () => desktopApiV2.credentials.save(reference, secret),
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
    const result = await invokeWithTimeout(
      () => desktopApiV2.credentials.read(reference),
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

  return invokeWithTimeout(
    () => desktopApiV2.provider.probe(provider),
    i18n.t('runtime.provider.actionProbe'),
    provider.timeoutMs + 3000,
    'provider-probe',
    i18n.t('runtime.provider.guidanceProbe'),
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

  return invokeWithTimeout(
    () => desktopApiV2.provider.fetchModels(provider),
    i18n.t('runtime.provider.actionFetchModels'),
    provider.timeoutMs + 3000,
    'provider-models',
    i18n.t('runtime.provider.guidanceFetchModels'),
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

  return invokeWithTimeout(
    () => desktopApiV2.provider.smoke(provider, sourceText, sourceLanguage, targetLanguage),
    i18n.t('runtime.provider.actionSmoke'),
    provider.timeoutMs + 3000,
    'provider-smoke',
    i18n.t('runtime.provider.guidanceSmoke'),
  );
}

export const providerRuntimeTestHelpers = {
  resolveRuntimeTimeoutMs,
  createProviderRuntimeTimeoutError,
  appendFrontendDiagnosticsTrace,
  diagnosticsCategoryForOperation,
  mapPresetToRuntimeModel,
  previewRoutingForVerdict,
  invokeWithTimeout,
};
