import { runtimeSnapshotMock } from '../mocks/runtime-shell';
import type { DiagnosticsExportScope } from '../schema/config';
import type { DiagnosticLogEntryRuntime, DiagnosticsExportArtifact, RuntimeSnapshot } from '../schema/runtime-core';
import { desktopApiV2 } from './desktop-api-v2';
import { createLogger } from './logger';
import { isTauriRuntime } from './tauri-runtime';

const runtimeLogger = createLogger('runtime');

function withDiagnosticsPatch(patch: Partial<RuntimeSnapshot['diagnostics']>): RuntimeSnapshot {
  return {
    ...runtimeSnapshotMock,
    diagnostics: {
      ...runtimeSnapshotMock.diagnostics,
      ...patch,
    },
  } satisfies RuntimeSnapshot;
}

export async function runDiagnosticsSelfCheckRuntime(): Promise<RuntimeSnapshot> {
  if (!isTauriRuntime()) {
    return withDiagnosticsPatch({
      status: 'ready',
      installStatus: 'ready',
      providerStatus: 'ready',
      driverStatus: 'warning',
      deviceStatus: 'warning',
      lastSelfCheckAt: new Date().toISOString(),
    });
  }

  return desktopApiV2.diagnostics.selfCheck();
}

export async function runSubtitleOverlaySelfCheckRuntime(): Promise<RuntimeSnapshot> {
  if (!isTauriRuntime()) {
    return runtimeSnapshotMock;
  }

  return desktopApiV2.diagnostics.overlaySelfCheck();
}

export async function exportDiagnosticsBundleRuntime(
  scope: DiagnosticsExportScope,
): Promise<{ artifact: DiagnosticsExportArtifact; snapshot: RuntimeSnapshot }> {
  if (!isTauriRuntime()) {
    const generatedAt = new Date().toISOString();
    return {
      artifact: {
        scope,
        outputPath: `browser-preview/diagnostics-${scope}.zip`,
        generatedAt,
        fileCount: scope === 'full' ? 6 : 3,
      },
      snapshot: withDiagnosticsPatch({
        lastExportScope: scope,
        lastExportPath: `browser-preview/diagnostics-${scope}.zip`,
        lastExportedAt: generatedAt,
      }),
    };
  }

  const artifact = await desktopApiV2.diagnostics.export(scope) as DiagnosticsExportArtifact;
  const snapshot = await desktopApiV2.configuration.runtimeSnapshot();
  return { artifact, snapshot };
}

/**
 * Reads the recent native diagnostics log entries. Used by the scene launch
 * attribution path to recover route_start_acknowledged/route_ready/route_error
 * markers when a launch fails. Never throws: an empty list degrades gracefully.
 */
export async function getRecentDiagnosticsLogsRuntime(): Promise<DiagnosticLogEntryRuntime[]> {
  if (!isTauriRuntime()) {
    return [];
  }

  try {
    const snapshot = await desktopApiV2.diagnostics.snapshot();
    return snapshot.recentLogs ?? [];
  } catch (error) {
    runtimeLogger.warn(
      'get_diagnostics_snapshot failed',
      error instanceof Error ? error.message : String(error),
    );
    return [];
  }
}

const loggersByCategory = new Map<string, ReturnType<typeof createLogger>>();

function loggerFor(category: string) {
  let logger = loggersByCategory.get(category);
  if (!logger) {
    logger = createLogger(category);
    loggersByCategory.set(category, logger);
  }
  return logger;
}

/**
 * @deprecated Compatibility adapter over `createLogger(category)`. Entries now
 * flow through the unified frontend logger (console mirror + bounded ring +
 * batched forwarding with retry) instead of one IPC call per line. Prefer
 * holding a `createLogger(category)` instance at new call sites.
 */
export function appendFrontendDiagnosticsLog(
  category: string,
  level: 'debug' | 'info' | 'warning' | 'error',
  summary: string,
  detail?: string,
): Promise<void> {
  const logger = loggerFor(category);
  if (level === 'error') {
    logger.error(summary, detail);
  } else if (level === 'warning') {
    logger.warn(summary, detail);
  } else if (level === 'info') {
    logger.info(summary, detail);
  } else {
    logger.debug(summary, detail);
  }
  return Promise.resolve();
}
