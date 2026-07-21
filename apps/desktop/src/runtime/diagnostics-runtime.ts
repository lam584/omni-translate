import { invoke } from '@tauri-apps/api/core';
import { runtimeSnapshotMock } from '../mocks/runtime-shell';
import type { DiagnosticsExportScope } from '../schema/config';
import type { DiagnosticLogEntryRuntime, DiagnosticsExportArtifact, RuntimeSnapshot } from '../schema/runtime-core';
import { desktopApiV2 } from './desktop-api-v2';
import { isTauriRuntime } from './tauri-runtime';

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
  const snapshot = await invoke<RuntimeSnapshot>('get_runtime_snapshot');
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
    const snapshot = await invoke<{ recentLogs?: DiagnosticLogEntryRuntime[] }>('get_diagnostics_snapshot');
    return snapshot.recentLogs ?? [];
  } catch (error) {
    console.warn('[diagnostics] get_diagnostics_snapshot failed:', error);
    return [];
  }
}

export function appendFrontendDiagnosticsLog(
  category: string,
  level: 'debug' | 'info' | 'warning' | 'error',
  summary: string,
  detail?: string,
): Promise<void> {
  if (!isTauriRuntime()) {
    const prefix = `[${level.toUpperCase()}] [${category}]`;
    if (detail) {
      console.log(`${prefix} ${summary}\n${detail}`);
    } else {
      console.log(`${prefix} ${summary}`);
    }
    return Promise.resolve();
  }

  return invoke<void>('append_frontend_diagnostics_log', {
    category,
    level,
    summary,
    detail: detail ?? null,
  }).catch((err) => {
    console.warn('[diagnostics] append_frontend_diagnostics_log failed:', err);
  });
}
