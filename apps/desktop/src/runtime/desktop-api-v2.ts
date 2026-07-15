import { invoke } from '@tauri-apps/api/core';
import { LogicalPosition, LogicalSize } from '@tauri-apps/api/dpi';
import { Menu } from '@tauri-apps/api/menu';
import { currentMonitor, cursorPosition, getCurrentWindow, PhysicalPosition } from '@tauri-apps/api/window';
import type { AudioRuntimeSnapshot } from '../schema/audio-runtime';
import type { AppConfigDraft, DiagnosticsExportScope, ProviderDraft } from '../schema/config';
import type { DriverRepairAction } from '../schema/driver-bridge-contract';
import type { CredentialRefStatus, CredentialSecretPayload, ProviderModelCatalogRuntime, ProviderProbeProfileRuntime, ProviderSmokeResult } from '../schema/provider-runtime';
import type { RuntimeSnapshot } from '../schema/runtime-core';

export type ServiceWarning = { code: string; message: string };
export type ServiceResult<T> = { data: T; warnings: ServiceWarning[] };
export type ServiceErrorV2 = { code: string; message: string; retriable: boolean; details?: unknown };
export type ConfigExportArtifact = {
  filePath: string;
  exportedAt: string;
  configContractVersion: number;
  snapshotCount: number;
};
export type ConfigSnapshotRecord = { snapshotId: string; reason: string; createdAt: string };

export type InvokeFn = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
export type DesktopPoint = { x: number; y: number };
export type DesktopSize = { width: number; height: number };
export type DesktopMonitor = { workArea: { position: DesktopPoint; size: DesktopSize } };
export type DesktopMenuItem = { id: string; text: string; action: () => void | Promise<void> };

function unwrap<T>(result: ServiceResult<T>): T {
  return result.data;
}

/**
 * Renderer-side boundary for the five V2 desktop services.  Tests can inject
 * a small invoke fake instead of mocking every legacy runtime module.
 */
export class DesktopApiV2 {
  constructor(private readonly invokeFn: InvokeFn = invoke) {}

  readonly provider = {
    fetchModels: async (provider: ProviderDraft) =>
      unwrap(await this.invokeFn<ServiceResult<ProviderModelCatalogRuntime>>('provider_v2', { command: { action: 'fetchModels', provider } })),
    probe: async (provider: ProviderDraft) =>
      unwrap(await this.invokeFn<ServiceResult<ProviderProbeProfileRuntime>>('provider_v2', { command: { action: 'probe', provider } })),
    smoke: async (provider: ProviderDraft, sourceText?: string, sourceLanguage?: string, targetLanguage?: string) =>
      unwrap(await this.invokeFn<ServiceResult<ProviderSmokeResult>>('provider_v2', {
        command: { action: 'smoke', provider, sourceText, sourceLanguage, targetLanguage },
      })),
  };

  readonly session = {
    snapshot: async () => unwrap(await this.invokeFn<ServiceResult<AudioRuntimeSnapshot>>('session_v2', { command: { action: 'snapshot' } })),
    refreshDevices: async () => unwrap(await this.invokeFn<ServiceResult<AudioRuntimeSnapshot>>('session_v2', { command: { action: 'refreshDevices' } })),
    preconnect: async (config: AppConfigDraft) => unwrap(await this.invokeFn<ServiceResult<AudioRuntimeSnapshot>>('session_v2', { command: { action: 'preconnect', config } })),
    cancelPreconnect: async () => unwrap(await this.invokeFn<ServiceResult<AudioRuntimeSnapshot>>('session_v2', { command: { action: 'cancelPreconnect' } })),
    startRoute: async (direction: 'inbound' | 'outbound', config: AppConfigDraft) => unwrap(await this.invokeFn<ServiceResult<AudioRuntimeSnapshot>>('session_v2', { command: { action: 'startRoute', direction, config } })),
    stopRoute: async (direction: 'inbound' | 'outbound') => unwrap(await this.invokeFn<ServiceResult<AudioRuntimeSnapshot>>('session_v2', { command: { action: 'stopRoute', direction } })),
    clearCues: async () => unwrap(await this.invokeFn<ServiceResult<AudioRuntimeSnapshot>>('session_v2', { command: { action: 'clearCues' } })),
    startSpeech: async (config: AppConfigDraft) => unwrap(await this.invokeFn<ServiceResult<AudioRuntimeSnapshot>>('session_v2', { command: { action: 'startSpeech', config } })),
    stopSpeech: async () => unwrap(await this.invokeFn<ServiceResult<AudioRuntimeSnapshot>>('session_v2', { command: { action: 'stopSpeech' } })),
    startTranslation: async (config: AppConfigDraft) => unwrap(await this.invokeFn<ServiceResult<AudioRuntimeSnapshot>>('session_v2', { command: { action: 'startTranslation', config } })),
    stopTranslation: async () => unwrap(await this.invokeFn<ServiceResult<AudioRuntimeSnapshot>>('session_v2', { command: { action: 'stopTranslation' } })),
    syncOverlayRegion: async (rounded = true) => unwrap(await this.invokeFn<ServiceResult<AudioRuntimeSnapshot>>('session_v2', { command: { action: 'syncOverlayRegion', rounded } })),
    syncOverlayWindowState: async (locked: boolean, rounded: boolean, hotspotInteractive: boolean) => unwrap(await this.invokeFn<ServiceResult<AudioRuntimeSnapshot>>('session_v2', {
      command: { action: 'syncOverlayWindowState', locked, rounded, hotspotInteractive },
    })),
  };

  readonly bridge = {
    snapshot: async () => unwrap(await this.invokeFn<ServiceResult<RuntimeSnapshot['bridge']>>('bridge_v2', { command: { action: 'snapshot' } })),
    refresh: async () => unwrap(await this.invokeFn<ServiceResult<RuntimeSnapshot>>('bridge_v2', { command: { action: 'refresh' } })),
    start: async (config: AppConfigDraft) => unwrap(await this.invokeFn<ServiceResult<RuntimeSnapshot>>('bridge_v2', { command: { action: 'start', config } })),
    stop: async () => unwrap(await this.invokeFn<ServiceResult<RuntimeSnapshot>>('bridge_v2', { command: { action: 'stop' } })),
    install: async (config: AppConfigDraft) => unwrap(await this.invokeFn<ServiceResult<RuntimeSnapshot>>('bridge_v2', { command: { action: 'install', config } })),
    uninstall: async () => unwrap(await this.invokeFn<ServiceResult<RuntimeSnapshot>>('bridge_v2', { command: { action: 'uninstall' } })),
    repair: async (repairAction: DriverRepairAction, config: AppConfigDraft) => unwrap(await this.invokeFn<ServiceResult<RuntimeSnapshot>>('bridge_v2', { command: { action: 'repair', repairAction, config } })),
  };

  readonly diagnostics = {
    selfCheck: async () => unwrap(await this.invokeFn<ServiceResult<RuntimeSnapshot>>('diagnostics_v2', { command: { action: 'selfCheck' } })),
    overlaySelfCheck: async () => unwrap(await this.invokeFn<ServiceResult<RuntimeSnapshot>>('diagnostics_v2', { command: { action: 'overlaySelfCheck' } })),
    export: async (scope: DiagnosticsExportScope) => unwrap(await this.invokeFn<ServiceResult<{ scope: string; outputPath: string; generatedAt: string; fileCount: number }>>('diagnostics_v2', { command: { action: 'export', scope } })),
    liveSessionEvents: async <T>() => unwrap(await this.invokeFn<ServiceResult<T>>('diagnostics_v2', { command: { action: 'liveSessionEvents' } })),
  };

  readonly configuration = {
    load: async () => unwrap(await this.invokeFn<ServiceResult<AppConfigDraft>>('configuration_v2', { command: { action: 'load' } })),
    save: async (config: AppConfigDraft) => unwrap(await this.invokeFn<ServiceResult<RuntimeSnapshot['storage']>>('configuration_v2', { command: { action: 'save', config } })),
    reset: async () => unwrap(await this.invokeFn<ServiceResult<AppConfigDraft>>('configuration_v2', { command: { action: 'reset' } })),
    export: async () => unwrap(await this.invokeFn<ServiceResult<ConfigExportArtifact>>('configuration_v2', { command: { action: 'export' } })),
    import: async (filePath: string) => unwrap(await this.invokeFn<ServiceResult<AppConfigDraft>>('configuration_v2', { command: { action: 'import', filePath } })),
    createSnapshot: async (reason?: string) => unwrap(await this.invokeFn<ServiceResult<ConfigSnapshotRecord>>('configuration_v2', { command: { action: 'createSnapshot', reason } })),
    rollback: async (snapshotId: string) => unwrap(await this.invokeFn<ServiceResult<AppConfigDraft>>('configuration_v2', { command: { action: 'rollback', snapshotId } })),
    // Startup recovery remains a renderer capability while the Rust bootstrap
    // command is folded into configuration_v2; pages never invoke it directly.
    bootstrapStorage: async () => this.invokeFn<void>('bootstrap_storage'),
    runtimeSnapshot: async () => this.invokeFn<RuntimeSnapshot>('get_runtime_snapshot'),
    bootstrapRuntime: async () => this.invokeFn<RuntimeSnapshot>('bootstrap_runtime'),
  };

  /** Persistence capability kept behind the desktop boundary during V2 migration. */
  readonly persistence = {
    saveDraft: async <T>(config: T) => this.invokeFn<void>('save_config_draft', { config }),
    loadDraft: async <T>() => this.invokeFn<T | null>('load_config_draft'),
    deleteDraft: async () => this.invokeFn<void>('delete_config_draft'),
    availableCommands: async () => this.invokeFn<string[]>('list_commands'),
  };

  /** Transitional runtime capability for startup orchestration. */
  readonly runtime = {
    invoke: <T>(command: string, args?: Record<string, unknown>) => this.invokeFn<T>(command, args),
  };

  // Secrets are intentionally not represented in the generic configuration
  // protocol: callers must use the credential-specific capability.
  readonly credentials = {
    status: (reference: string) => this.invokeFn<CredentialRefStatus>('get_secret_ref_status', { reference }),
    read: (reference: string) => this.invokeFn<CredentialSecretPayload>('read_secret_ref', { reference }),
    save: (reference: string, secret: string) => this.invokeFn<CredentialRefStatus>('upsert_secret_ref', { reference, secret }),
  };

  /** Native-window boundary used by overlay hooks; tests inject this object. */
  readonly window = {
    currentMonitor: async (): Promise<DesktopMonitor | null> => currentMonitor(),
    cursorPosition: async (): Promise<DesktopPoint> => cursorPosition(),
    outerPosition: async (): Promise<DesktopPoint> => getCurrentWindow().outerPosition(),
    outerSize: async (): Promise<DesktopSize> => getCurrentWindow().outerSize(),
    scaleFactor: async (): Promise<number> => getCurrentWindow().scaleFactor(),
    setPosition: async (position: DesktopPoint) => getCurrentWindow().setPosition(new PhysicalPosition(position.x, position.y)),
    setLogicalSize: async (size: DesktopSize) => getCurrentWindow().setSize(new LogicalSize(size.width, size.height)),
    popupMenu: async (items: DesktopMenuItem[], position: DesktopPoint) => {
      const menu = await Menu.new({
        items: items.map((item) => ({ id: item.id, text: item.text, action: item.action })),
      });
      try {
        await menu.popup(new LogicalPosition(position.x, position.y), getCurrentWindow());
      } finally {
        await menu.close().catch(() => undefined);
      }
    },
  };
}

export const desktopApiV2 = new DesktopApiV2();
