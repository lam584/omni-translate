import i18n from '../i18n/config';
import type { ModelPreset } from '../schema/provider-template';
import type { ProviderDraft } from '../schema/config';
import type {
  CredentialSecretPayload,
  CredentialRefStatus,
  ProviderModelCatalogRuntime,
  ProviderProbeProfileRuntime,
  ProviderSmokeResult,
} from '../schema/provider-runtime';
import { activeDesktopApi } from './desktop-api';
import { invokeWithTimeoutCore } from './invoke-with-timeout';
import { createLogger } from './logger';

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

// Shared start/result/failed trace scaffold for the three credential
// operations; only the summaries, detail projections and timeout differ.
async function invokeCredentialOperation<T>(
  reference: string,
  operation: () => Promise<T>,
  actionLabel: string,
  timeoutMs: number | null,
  operationName: string,
  trace: {
    startSummary: string;
    startDetail: string;
    resultSummary: string;
    resultDetail: (result: T) => string;
    failedSummary: string;
  },
): Promise<T> {
  appendFrontendDiagnosticsTrace('storage', 'info', trace.startSummary, trace.startDetail);

  try {
    const result = await invokeWithTimeout(
      operation,
      actionLabel,
      timeoutMs,
      operationName,
      i18n.t('runtime.provider.guidanceCredentialManager'),
    );

    appendFrontendDiagnosticsTrace('storage', 'info', trace.resultSummary, trace.resultDetail(result));
    return result;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    appendFrontendDiagnosticsTrace('storage', 'error', trace.failedSummary, `reference=${reference} error=${detail}`);
    throw error;
  }
}

export async function getProviderSecretStatus(reference: string): Promise<CredentialRefStatus> {
  return invokeCredentialOperation(
    reference,
    () => activeDesktopApi().credentials.status(reference),
    i18n.t('runtime.provider.actionSecretStatus'),
    null,
    'credential-status',
    {
      startSummary: i18n.t('runtime.provider.traceSecretStatusStart'),
      startDetail: `reference=${reference}`,
      resultSummary: i18n.t('runtime.provider.traceSecretStatusResult'),
      resultDetail: (result) => `reference=${reference} backend=${result.backend} hasSecret=${result.hasSecret}`,
      failedSummary: i18n.t('runtime.provider.traceSecretStatusFailed'),
    },
  );
}

export async function saveProviderSecret(reference: string, secret: string): Promise<CredentialRefStatus> {
  return invokeCredentialOperation(
    reference,
    () => activeDesktopApi().credentials.save(reference, secret),
    i18n.t('runtime.provider.actionSecretSave'),
    SAVE_PROVIDER_SECRET_TIMEOUT_MS,
    'credential-save',
    {
      startSummary: i18n.t('runtime.provider.traceSecretSaveStart'),
      startDetail: `reference=${reference} secretLength=${secret.length}`,
      resultSummary: i18n.t('runtime.provider.traceSecretSaveResult'),
      resultDetail: (result) => `reference=${reference} backend=${result.backend} hasSecret=${result.hasSecret}`,
      failedSummary: i18n.t('runtime.provider.traceSecretSaveFailed'),
    },
  );
}

export async function readProviderSecret(reference: string): Promise<CredentialSecretPayload> {
  return invokeCredentialOperation(
    reference,
    () => activeDesktopApi().credentials.read(reference),
    i18n.t('runtime.provider.actionSecretRead'),
    null,
    'credential-read',
    {
      startSummary: i18n.t('runtime.provider.traceSecretReadStart'),
      startDetail: `reference=${reference}`,
      resultSummary: i18n.t('runtime.provider.traceSecretReadResult'),
      resultDetail: (result) => `reference=${reference} hasSecret=${Boolean(result.secret)}`,
      failedSummary: i18n.t('runtime.provider.traceSecretReadFailed'),
    },
  );
}

export async function runProviderProbe(provider: ProviderDraft): Promise<ProviderProbeProfileRuntime> {
  return invokeWithTimeout(
    () => activeDesktopApi().provider.probe(provider),
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
  return invokeWithTimeout(
    () => activeDesktopApi().provider.fetchModels(provider, presetModels),
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
  return invokeWithTimeout(
    () => activeDesktopApi().provider.smoke(provider, sourceText, sourceLanguage, targetLanguage),
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
  invokeWithTimeout,
};
