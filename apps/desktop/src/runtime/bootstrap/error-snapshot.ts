import i18n from '../../i18n/config';
import { runtimeSnapshotMock } from '../../defaults/runtime-shell';
import type { RuntimeSnapshot } from '../../schema/runtime-core';

export function createRuntimeErrorSnapshot(error: unknown): RuntimeSnapshot {
  const message = error instanceof Error ? error.message : i18n.t('runtime.desktop.unknownError');

  return {
    ...runtimeSnapshotMock,
    coreState: 'degraded',
    bridgeStatus: 'runtime-error',
    lastSyncAt: new Date().toISOString(),
    notifications: [
      {
        id: 'runtime-bootstrap-failed',
        level: 'error',
        source: 'desktop-runtime',
        message: i18n.t('runtime.desktop.rustCoreFailed', { message }),
        emittedAt: new Date().toISOString(),
      },
    ],
  };
}

export function formatRuntimeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
