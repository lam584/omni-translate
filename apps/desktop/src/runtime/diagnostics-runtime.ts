import { invoke } from '@tauri-apps/api/core';
import { runtimeSnapshotMock } from '../mocks/runtime-shell';
import type { DiagnosticsExportScope } from '../schema/config';
import type { DiagnosticsExportArtifact, RuntimeSnapshot } from '../schema/runtime-core';
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

  return invoke<RuntimeSnapshot>('run_diagnostics_self_check');
}

export async function runSubtitleOverlaySelfCheckRuntime(): Promise<RuntimeSnapshot> {
  if (!isTauriRuntime()) {
    return runtimeSnapshotMock;
  }

  return invoke<RuntimeSnapshot>('run_subtitle_overlay_self_check');
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

  const artifact = await invoke<DiagnosticsExportArtifact>('export_diagnostics_bundle', { scope });
  const snapshot = await invoke<RuntimeSnapshot>('get_runtime_snapshot');
  return { artifact, snapshot };
}
