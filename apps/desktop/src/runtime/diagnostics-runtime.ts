import type { DiagnosticsExportScope } from '../schema/config';
import type { DiagnosticLogEntryRuntime, DiagnosticsExportArtifact, RuntimeSnapshot } from '../schema/runtime-core';
import { activeDesktopApi } from './desktop-api';
import { createLogger } from './logger';

const runtimeLogger = createLogger('runtime');

export async function runDiagnosticsSelfCheckRuntime(): Promise<RuntimeSnapshot> {
  return activeDesktopApi().diagnostics.selfCheck();
}

export async function runSubtitleOverlaySelfCheckRuntime(): Promise<RuntimeSnapshot> {
  return activeDesktopApi().diagnostics.overlaySelfCheck();
}

export async function exportDiagnosticsBundleRuntime(
  scope: DiagnosticsExportScope,
): Promise<{ artifact: DiagnosticsExportArtifact; snapshot: RuntimeSnapshot }> {
  const artifact = await activeDesktopApi().diagnostics.export(scope) as DiagnosticsExportArtifact;
  const snapshot = await activeDesktopApi().configuration.runtimeSnapshot();
  return { artifact, snapshot };
}

export async function openExportDirectoryRuntime(outputPath: string): Promise<void> {
  await activeDesktopApi().diagnostics.openExportDirectory(outputPath);
}

/**
 * Reads the recent native diagnostics log entries. Used by the scene launch
 * attribution path to recover route_start_acknowledged/route_ready/route_error
 * markers when a launch fails. Never throws: an empty list degrades gracefully.
 */
export async function getRecentDiagnosticsLogsRuntime(): Promise<DiagnosticLogEntryRuntime[]> {
  try {
    const snapshot = await activeDesktopApi().diagnostics.snapshot();
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
