import i18n from '../i18n/config';
import { runtimeSnapshotMock } from '../defaults/runtime-shell';
import type { AppConfigDraft } from '../schema/config';
import type { DriverRepairAction } from '../schema/driver-bridge-contract';
import type { RuntimeSnapshot } from '../schema/runtime-core';
import { activeDesktopApi } from './desktop-api';
import { invokeWithTimeoutCore } from './invoke-with-timeout';
import { createLogger } from './logger';

const BRIDGE_REFRESH_TIMEOUT_MS = 120000;
const BRIDGE_PROCESS_LOOPBACK_PROBE_TIMEOUT_MS = 20000;
const BRIDGE_START_TIMEOUT_MS = 20000;
const BRIDGE_INSTALL_TIMEOUT_MS = 120000;
const BRIDGE_REPAIR_TIMEOUT_MS = 120000;
const BRIDGE_UNINSTALL_TIMEOUT_MS = 60000;

const bridgeLogger = createLogger('bridge');

/**
 * Bridge lifecycle trace, routed through the unified frontend logger (console
 * mirror + bounded ring + batched forwarding). The former localStorage
 * (`omni.bridgeRuntimeTrace`) and `window.__OMNI_BRIDGE_RUNTIME_TRACE__`
 * write-only sinks were removed: nothing in production ever read them.
 */
function appendBridgeTrace(level: 'info' | 'warning' | 'error', summary: string, detail?: string) {
  if (level === 'error') {
    bridgeLogger.error(summary, detail);
  } else if (level === 'warning') {
    bridgeLogger.warn(summary, detail);
  } else {
    bridgeLogger.info(summary, detail);
  }
}

function createBridgeRuntimeTimeoutError(actionLabel: string, timeoutMs: number, operation: string) {
  const error = new Error(
    i18n.t('runtime.bridge.timeoutError', { action: actionLabel, seconds: Math.ceil(timeoutMs / 1000) }),
  );

  Object.assign(error, {
    code: 'timeout',
    operation,
    retriable: true,
  });

  return error;
}

/**
 * Thunk-shaped timeout wrapper (same paradigm as audio-runtime's
 * `invokeAudioWithTimeout`): the race mechanics — single-settle gate, timer
 * cleanup, late-settle unhandled-rejection protection — live in
 * `invokeWithTimeoutCore`. This module keeps only what is bridge-specific:
 * the four lifecycle trace probes and the decorated timeout error. Every
 * production `operation` routes through `activeDesktopApi().bridge`, i.e. the
 * native `bridge_v2` command, which is why the trace detail pins
 * `command=bridge_v2`.
 */
async function invokeBridgeWithTimeout<T>(
  operation: () => Promise<T>,
  actionLabel: string,
  timeoutMs: number,
  operationName: string,
): Promise<T> {
  const startedAt = Date.now();
  appendBridgeTrace('info', i18n.t('runtime.bridge.traceInvokeStart'), `command=bridge_v2 operation=${operationName} timeoutMs=${timeoutMs}`);

  let timeoutError: Error | undefined;
  return invokeWithTimeoutCore(operation, timeoutMs, () => {
    appendBridgeTrace('error', i18n.t('runtime.bridge.traceInvokeTimeout'), `command=bridge_v2 operation=${operationName} elapsedMs=${Date.now() - startedAt}`);
    timeoutError = createBridgeRuntimeTimeoutError(actionLabel, timeoutMs, operationName);
    return timeoutError;
  }).then(
    (result) => {
      appendBridgeTrace('info', i18n.t('runtime.bridge.traceInvokeResult'), `command=bridge_v2 operation=${operationName} elapsedMs=${Date.now() - startedAt}`);
      return result;
    },
    (error: unknown) => {
      // The timeout path already traced traceInvokeTimeout inside the error
      // factory above; only genuine operation failures trace traceInvokeFailed.
      if (timeoutError === undefined || error !== timeoutError) {
        const detail = error instanceof Error ? error.message : String(error);
        appendBridgeTrace('error', i18n.t('runtime.bridge.traceInvokeFailed'), `command=bridge_v2 operation=${operationName} elapsedMs=${Date.now() - startedAt} error=${detail}`);
      }
      throw error;
    },
  );
}

function withBridgePatch(patch: Partial<RuntimeSnapshot['bridge']>): RuntimeSnapshot {
  return {
    ...runtimeSnapshotMock,
    bridge: {
      ...runtimeSnapshotMock.bridge,
      ...patch,
    },
  } satisfies RuntimeSnapshot;
}

export async function refreshBridgeRuntime(): Promise<RuntimeSnapshot> {
  return invokeBridgeWithTimeout(() => activeDesktopApi().bridge.refresh(), i18n.t('runtime.bridge.actionRefresh'), BRIDGE_REFRESH_TIMEOUT_MS, 'bridge-refresh');
}

export function canProbeProcessLoopbackCapability(): boolean {
  return activeDesktopApi().capabilities.hasNativeShell;
}

export async function probeProcessLoopbackCapabilityRuntime(): Promise<RuntimeSnapshot> {
  return invokeBridgeWithTimeout(
    () => activeDesktopApi().bridge.probeProcessLoopback(),
    i18n.t('runtime.bridge.actionRefresh'),
    BRIDGE_PROCESS_LOOPBACK_PROBE_TIMEOUT_MS,
    'bridge-process-loopback-probe',
  );
}

export async function startBridgeServiceRuntime(config: AppConfigDraft): Promise<RuntimeSnapshot> {
  return invokeBridgeWithTimeout(() => activeDesktopApi().bridge.start(config), i18n.t('runtime.bridge.actionStart'), BRIDGE_START_TIMEOUT_MS, 'bridge-start');
}

export async function stopBridgeServiceRuntime(): Promise<RuntimeSnapshot> {
  return invokeBridgeWithTimeout(() => activeDesktopApi().bridge.stop(), i18n.t('runtime.bridge.actionStop'), BRIDGE_REFRESH_TIMEOUT_MS, 'bridge-stop');
}

export async function installDriverRuntime(config: AppConfigDraft): Promise<RuntimeSnapshot> {
  return invokeBridgeWithTimeout(() => activeDesktopApi().bridge.install(config), i18n.t('runtime.bridge.actionInstall'), BRIDGE_INSTALL_TIMEOUT_MS, 'bridge-install');
}

export async function uninstallDriverRuntime(): Promise<RuntimeSnapshot> {
  return invokeBridgeWithTimeout(() => activeDesktopApi().bridge.uninstall(), i18n.t('runtime.bridge.actionUninstall'), BRIDGE_UNINSTALL_TIMEOUT_MS, 'bridge-uninstall');
}

export async function repairDriverRuntime(action: DriverRepairAction, config: AppConfigDraft): Promise<RuntimeSnapshot> {
  return invokeBridgeWithTimeout(() => activeDesktopApi().bridge.repair(action, config), i18n.t('runtime.bridge.actionRepair'), BRIDGE_REPAIR_TIMEOUT_MS, 'bridge-repair');
}

export const bridgeRuntimeTestHelpers = {
  appendBridgeTrace,
  createBridgeRuntimeTimeoutError,
  invokeBridgeWithTimeout,
  withBridgePatch,
};
