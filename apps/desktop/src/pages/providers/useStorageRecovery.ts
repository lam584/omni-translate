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

/** Restores storage after startup without coupling provider editing to IPC. */
export function useStorageRecovery({ runtimeStatus, bridgeStatus, setRuntimeSnapshot }: StorageRecoveryOptions) {
  const desktopApi = useDesktopApiV2();
  const hasNativeShell = desktopApi.capabilities.hasNativeShell;
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const attemptsRef = useRef(0);
  const recoveryKey = `${runtimeStatus}:${bridgeStatus}`;
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);

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
        if (active) setFailure({ key: recoveryKey, message: cause instanceof Error ? cause.message : String(cause) });
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
  }, [bridgeStatus, desktopApi, recoveryKey, runtimeStatus, setRuntimeSnapshot, hasNativeShell]);

  return failure?.key === recoveryKey ? failure.message : null;
}
