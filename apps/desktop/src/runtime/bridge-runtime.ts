import { invoke } from '@tauri-apps/api/core';
import i18n from '../i18n/config';
import { runtimeSnapshotMock } from '../mocks/runtime-shell';
import type { AppConfigDraft } from '../schema/config';
import type { DriverRepairAction } from '../schema/driver-bridge-contract';
import type { RuntimeSnapshot } from '../schema/runtime-core';
import { isTauriRuntime } from './tauri-runtime';

const BRIDGE_REFRESH_TIMEOUT_MS = 120000;
const BRIDGE_START_TIMEOUT_MS = 20000;
const BRIDGE_INSTALL_TIMEOUT_MS = 120000;
const BRIDGE_REPAIR_TIMEOUT_MS = 120000;
const BRIDGE_UNINSTALL_TIMEOUT_MS = 60000;
const BRIDGE_TRACE_LIMIT = 80;
const BRIDGE_TRACE_STORAGE_KEY = 'omni.bridgeRuntimeTrace';

type BridgeRuntimeTrace = {
  category: 'bridge';
  level: 'info' | 'warning' | 'error';
  summary: string;
  detail?: string;
  emittedAt: string;
};

declare global {
  interface Window {
    __OMNI_BRIDGE_RUNTIME_TRACE__?: BridgeRuntimeTrace[];
  }
}

function readBridgeTrace() {
  if (typeof window === 'undefined') {
    return [] as BridgeRuntimeTrace[];
  }

  if (Array.isArray(window.__OMNI_BRIDGE_RUNTIME_TRACE__)) {
    return window.__OMNI_BRIDGE_RUNTIME_TRACE__;
  }

  try {
    const raw = window.localStorage.getItem(BRIDGE_TRACE_STORAGE_KEY);
    if (!raw) {
      return [] as BridgeRuntimeTrace[];
    }

    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as BridgeRuntimeTrace[]) : ([] as BridgeRuntimeTrace[]);
  } catch {
    return [] as BridgeRuntimeTrace[];
  }
}

function appendBridgeTrace(level: BridgeRuntimeTrace['level'], summary: string, detail?: string) {
  if (typeof window === 'undefined') {
    return;
  }

  const entry: BridgeRuntimeTrace = {
    category: 'bridge',
    level,
    summary,
    detail,
    emittedAt: new Date().toISOString(),
  };

  const nextTrace = [entry, ...readBridgeTrace()].slice(0, BRIDGE_TRACE_LIMIT);
  window.__OMNI_BRIDGE_RUNTIME_TRACE__ = nextTrace;

  try {
    window.localStorage.setItem(BRIDGE_TRACE_STORAGE_KEY, JSON.stringify(nextTrace));
  } catch {
    // Diagnostics buffering must never block the main workflow.
  }

  const message = detail ? `${summary} ${detail}` : summary;
  if (level === 'error') {
    console.error('[omni][bridge-runtime]', message);
    return;
  }

  if (level === 'warning') {
    console.warn('[omni][bridge-runtime]', message);
    return;
  }

  console.info('[omni][bridge-runtime]', message);
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

async function invokeBridgeWithTimeout<T>(
  command: string,
  payload: Record<string, unknown> | undefined,
  actionLabel: string,
  timeoutMs: number,
  operation: string,
): Promise<T> {
  const startedAt = Date.now();
  appendBridgeTrace('info', i18n.t('runtime.bridge.traceInvokeStart'), `command=${command} operation=${operation} timeoutMs=${timeoutMs}`);

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      appendBridgeTrace('error', i18n.t('runtime.bridge.traceInvokeTimeout'), `command=${command} operation=${operation} elapsedMs=${Date.now() - startedAt}`);
      reject(createBridgeRuntimeTimeoutError(actionLabel, timeoutMs, operation));
    }, timeoutMs);

    invoke<T>(command, payload)
      .then((result) => {
        if (settled) {
          return;
        }

        settled = true;
        window.clearTimeout(timer);
        appendBridgeTrace('info', i18n.t('runtime.bridge.traceInvokeResult'), `command=${command} operation=${operation} elapsedMs=${Date.now() - startedAt}`);
        resolve(result);
      })
      .catch((error) => {
        if (settled) {
          return;
        }

        settled = true;
        window.clearTimeout(timer);
        const detail = error instanceof Error ? error.message : String(error);
        appendBridgeTrace('error', i18n.t('runtime.bridge.traceInvokeFailed'), `command=${command} operation=${operation} elapsedMs=${Date.now() - startedAt} error=${detail}`);
        reject(error);
      });
  });
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
  if (!isTauriRuntime()) {
    return runtimeSnapshotMock;
  }

  return invokeBridgeWithTimeout<{ data: RuntimeSnapshot }>('bridge_v2', { command: { action: 'refresh' } }, i18n.t('runtime.bridge.actionRefresh'), BRIDGE_REFRESH_TIMEOUT_MS, 'bridge-refresh').then((result) => result.data);
}

export async function startBridgeServiceRuntime(config: AppConfigDraft): Promise<RuntimeSnapshot> {
  if (!isTauriRuntime()) {
    return withBridgePatch({
      processStatus: 'running',
      bridgeState: 'running',
      lifecycleState: 'ready',
      driverHealth: 'running',
      installPhase: 'ready',
      lastErrorCode: null,
      recommendedAction: 'open-diagnostics',
      sessionId: 'browser-preview-session',
      lastHandshakeAt: new Date().toISOString(),
      expectedDriverVersion: config.driver.expectedDriverVersion,
      expectedBridgeVersion: config.driver.expectedBridgeVersion,
    });
  }

  return invokeBridgeWithTimeout<{ data: RuntimeSnapshot }>('bridge_v2', { command: { action: 'start', config } }, i18n.t('runtime.bridge.actionStart'), BRIDGE_START_TIMEOUT_MS, 'bridge-start').then((result) => result.data);
}

export async function stopBridgeServiceRuntime(): Promise<RuntimeSnapshot> {
  if (!isTauriRuntime()) {
    return withBridgePatch({
      processStatus: 'stopped',
      bridgeState: 'stopped',
      lifecycleState: 'stopped',
      sessionId: null,
    });
  }

  return invokeBridgeWithTimeout<{ data: RuntimeSnapshot }>('bridge_v2', { command: { action: 'stop' } }, i18n.t('runtime.bridge.actionStop'), BRIDGE_REFRESH_TIMEOUT_MS, 'bridge-stop').then((result) => result.data);
}

export async function installDriverRuntime(config: AppConfigDraft): Promise<RuntimeSnapshot> {
  if (!isTauriRuntime()) {
    return withBridgePatch({
      processStatus: 'running',
      bridgeState: 'running',
      lifecycleState: 'ready',
      driverHealth: 'running',
      driverVersion: config.driver.expectedDriverVersion,
      bridgeVersion: config.driver.expectedBridgeVersion,
      installPhase: 'ready',
      lastErrorCode: null,
      recommendedAction: 'open-diagnostics',
      sessionId: 'browser-preview-session',
      lastHandshakeAt: new Date().toISOString(),
    });
  }

  return invokeBridgeWithTimeout<{ data: RuntimeSnapshot }>('bridge_v2', { command: { action: 'install', config } }, i18n.t('runtime.bridge.actionInstall'), BRIDGE_INSTALL_TIMEOUT_MS, 'bridge-install').then((result) => result.data);
}

export async function uninstallDriverRuntime(): Promise<RuntimeSnapshot> {
  if (!isTauriRuntime()) {
    return withBridgePatch({
      processStatus: 'stopped',
      bridgeState: 'stopped',
      lifecycleState: 'idle',
      driverHealth: 'not-installed',
      driverVersion: null,
      installPhase: 'planned',
      lastErrorCode: 'driver.not-installed',
      recommendedAction: 'reinstall-driver',
      sessionId: null,
    });
  }

  return invokeBridgeWithTimeout<{ data: RuntimeSnapshot }>('bridge_v2', { command: { action: 'uninstall' } }, i18n.t('runtime.bridge.actionUninstall'), BRIDGE_UNINSTALL_TIMEOUT_MS, 'bridge-uninstall').then((result) => result.data);
}

export async function repairDriverRuntime(action: DriverRepairAction, config: AppConfigDraft): Promise<RuntimeSnapshot> {
  if (!isTauriRuntime()) {
    return action === 'restart-bridge' ? startBridgeServiceRuntime(config) : installDriverRuntime(config);
  }

  return invokeBridgeWithTimeout<{ data: RuntimeSnapshot }>('bridge_v2', { command: { action: 'repair', repairAction: action, config } }, i18n.t('runtime.bridge.actionRepair'), BRIDGE_REPAIR_TIMEOUT_MS, 'bridge-repair').then((result) => result.data);
}

export const bridgeRuntimeTestHelpers = {
  readBridgeTrace,
  appendBridgeTrace,
  createBridgeRuntimeTimeoutError,
  invokeBridgeWithTimeout,
  withBridgePatch,
};
