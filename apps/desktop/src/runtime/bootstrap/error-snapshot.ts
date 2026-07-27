import i18n from '../../i18n/config';
import { runtimeSnapshotMock } from '../../defaults/runtime-shell';
import type { RuntimeSnapshot } from '../../schema/runtime-core';
import { describeRuntimeError } from '../../utils/runtime-error-text';

export function createRuntimeErrorSnapshot(error: unknown): RuntimeSnapshot {
  const message = describeRuntimeError(error) || i18n.t('runtime.desktop.unknownError');

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
  return describeRuntimeError(error);
}
