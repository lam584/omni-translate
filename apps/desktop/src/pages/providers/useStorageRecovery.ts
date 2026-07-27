import { useEffect, useRef, useState } from 'react';
import type { RuntimeSnapshot } from '../../schema/runtime-core';
import { useDesktopApiV2 } from '../../runtime/desktop-api-context';
import { invokeWithTimeoutCore } from '../../runtime/invoke-with-timeout';

const POLL_INTERVAL_MS = 2_000;
const MAX_POLL_ATTEMPTS = 8;
const RECOVERY_INVOKE_TIMEOUT_MS = 5_000;

type StorageRecoveryOptions = {
  runtimeStatus: RuntimeSnapshot['storage']['status'];
  bridgeStatus: string;
  setRuntimeSnapshot: (snapshot: RuntimeSnapshot) => void;
};

async function invokeWithTimeout<T>(operation: () => Promise<T>, name: string): Promise<T> {
  return invokeWithTimeoutCore(
    operation,
    RECOVERY_INVOKE_TIMEOUT_MS,
    () => new Error(`${name} timed out after 5000ms`),
  );
}

export const storageRecoveryHelpers = { invokeWithTimeout };

export function classifyStorageRecoveryError(cause: unknown) {
  const detail = cause instanceof Error ? cause.message : String(cause);
  const normalized = detail.toLowerCase();
  const chinese = (document.documentElement.lang || 'zh-CN').toLowerCase().startsWith('zh');
  if (/timeout|timed out|超时/.test(normalized)) {
    return chinese ? `存储恢复超时：${detail}` : `Storage recovery timed out: ${detail}`;
  }
  if (/credential|keyring|vault|凭据|密钥/.test(normalized)) {
    return chinese ? `系统凭据存储不可用：${detail}` : `The system credential store is unavailable: ${detail}`;
  }
  if (/sqlite|database|数据库/.test(normalized)) {
    return chinese ? `配置数据库不可用：${detail}` : `The configuration database is unavailable: ${detail}`;
  }
  return chinese ? `存储恢复失败：${detail}` : `Storage recovery failed: ${detail}`;
}

/** Restores storage after startup without coupling provider editing to IPC. */
export function useStorageRecovery({ runtimeStatus, bridgeStatus, setRuntimeSnapshot }: StorageRecoveryOptions) {
  const desktopApi = useDesktopApiV2();
  const hasNativeShell = desktopApi.capabilities.hasNativeShell;
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const attemptsRef = useRef(0);
  const recoveryKey = `${runtimeStatus}:${bridgeStatus}`;
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    if (!hasNativeShell || runtimeStatus === 'ready' || bridgeStatus === 'runtime-error') {
      return;
    }

    let active = true;
    attemptsRef.current = 0;
    const refresh = async (lastResort = false) => {
      try {
        if (lastResort) {
          const snapshot = await invokeWithTimeout(() => desktopApi.configuration.bootstrapRuntime(), 'bootstrap runtime');
          if (active && snapshot.storage.status === 'ready') {
            setFailure(null);
            setRuntimeSnapshot(snapshot);
          }
        } else {
          await invokeWithTimeout(() => desktopApi.configuration.bootstrapStorage(), 'bootstrap storage');
          const snapshot = await invokeWithTimeout(() => desktopApi.configuration.runtimeSnapshot(), 'runtime snapshot');
          if (active && snapshot.storage.status === 'ready') {
            setFailure(null);
            setRuntimeSnapshot(snapshot);
          }
        }
      } catch (cause) {
        if (active) setFailure({ key: recoveryKey, message: classifyStorageRecoveryError(cause) });
      }
    };

    void refresh();
    intervalRef.current = window.setInterval(() => {
      attemptsRef.current += 1;
      if (attemptsRef.current >= MAX_POLL_ATTEMPTS) {
        window.clearInterval(intervalRef.current!);
        intervalRef.current = null;
        void refresh(true);
        return;
      }
      void refresh();
    }, POLL_INTERVAL_MS);

    return () => {
      active = false;
      if (intervalRef.current) window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    };
  }, [bridgeStatus, desktopApi, recoveryKey, retryToken, runtimeStatus, setRuntimeSnapshot, hasNativeShell]);

  return {
    failure: failure?.key === recoveryKey ? failure.message : null,
    retry: () => setRetryToken((current) => current + 1),
  };
}
