/**
 * Direct v1 command whitelist
 * ---------------------------
 * Every renderer→shell call goes through one of the five v2 service
 * envelopes (`provider_v2` / `session_v2` / `bridge_v2` / `diagnostics_v2` /
 * `configuration_v2`) EXCEPT the commands below, each of which keeps a direct
 * registration for a written reason. Do not add new direct commands without
 * extending this list, and keep it in sync with `generate_handler!` in
 * `src-tauri/src/main.rs`.
 *
 * - `debug_ipc_ping` — IPC liveness probe used before anything else may
 *   invoke; must stay a trivial sync echo with no envelope or logging. Also
 *   CLI-invoked by scripts/diagnostics/ipc_test.ps1 and
 *   scripts/testing/run-watch-mode-live.ps1.
 * - `start_audio_route` — route startup keeps the sub-second native
 *   acknowledgement on the click path and bypasses the ServiceResult
 *   envelope. Also CLI-invoked by run-watch-mode-live.ps1.
 * - `start_bridge_service` — startup/autostart path predating bridge_v2;
 *   CLI-invoked by run-watch-mode-live.ps1.
 * - `append_frontend_diagnostics_logs` / `set_diagnostics_log_level` —
 *   fire-and-forget logger plumbing; must not depend on snapshot rebuilds.
 * - `bootstrap_storage` — startup recovery path; CLI-invoked by ipc_test.ps1.
 * - `sync_subtitle_overlay_window_state` / `unlock_subtitle_overlay` /
 *   `toggle_subtitle_overlay` / `show_subtitle_overlay` — the overlay is a
 *   separately bootstrapped renderer and issues these before the V2 desktop
 *   service bridge has hydrated.
 * - Script-only registrations without a renderer call site:
 *   `load_config_draft`, `stop_audio_route`, `preconnect_omni_realtime`
 *   (run-watch-mode-live.ps1) and `debug_cred_direct` (ipc_test.ps1). Their
 *   removal requires re-running the live matrix on real hardware.
 */
import { invoke } from '@tauri-apps/api/core';
import { LogicalPosition, LogicalSize } from '@tauri-apps/api/dpi';
import { Menu } from '@tauri-apps/api/menu';
import { currentMonitor, cursorPosition, getCurrentWindow, PhysicalPosition } from '@tauri-apps/api/window';
import type { AudioRuntimeSnapshot } from '../schema/audio-runtime';
import type { AppConfigDraft, DiagnosticsExportScope, ProviderDraft, RealtimeAudioMode } from '../schema/config';
import type { DriverRepairAction } from '../schema/driver-bridge-contract';
import type { ProviderInteractionCapability } from '../schema/provider-contract';
import type { ModelPreset } from '../schema/provider-template';
import type { CredentialRefStatus, CredentialSecretPayload, ProviderModelCatalogRuntime, ProviderProbeProfileRuntime, ProviderSmokeResult } from '../schema/provider-runtime';
import type { ConfigExportArtifact, ConfigSnapshotRecord } from '../schema/generated/runtime-core';
import type { DiagnosticLogEntryRuntime, RuntimeSnapshot } from '../schema/runtime-core';

export type ServiceWarning = { code: string; message: string };
export type ServiceResult<T> = { data: T; warnings: ServiceWarning[]; requestId?: string };
export type ServiceErrorV2 = { code: string; message: string; retriable: boolean; details?: unknown };
export type { ConfigExportArtifact, ConfigSnapshotRecord };
export type FrontendDiagnosticsBatchEntry = {
  category: string;
  level: string;
  summary: string;
  detail: string | null;
  emittedAt: string;
};
export type DiagnosticsLogLevel = 'error' | 'warning' | 'info' | 'debug' | 'verbose';
/** Flat args for the provider_v2 'runModelBenchmark' action; mirrors the benchmark-runtime call site. */
export type ModelBenchmarkRunPayload = {
  model: string;
  apiKey: string;
  mp3Path: string;
  runId: string;
  realtimeAudioMode?: RealtimeAudioMode;
  interactionCapabilities?: ProviderInteractionCapability[];
  providerKind?: string;
  baseUrl?: string;
  authHeaderName?: string;
  authScheme?: string;
};

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
    // `presetModels` is a preview-implementation hint (the browser preview
    // builds its catalog from the preset list); the native provider service
    // resolves the catalog itself and ignores it.
    fetchModels: async (provider: ProviderDraft, _presetModels?: readonly ModelPreset[]) =>
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
    prewarmRoutes: async (config: AppConfigDraft) => unwrap(await this.invokeFn<ServiceResult<AudioRuntimeSnapshot>>('session_v2', { command: { action: 'prewarmRoutes', config } })),
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
    // Performance-sensitive legacy direct command, distinct from `startRoute`
    // above (session_v2 envelope): route startup must keep the sub-second
    // native acknowledgement on the click path, so it bypasses the
    // ServiceResult unwrap entirely.
    startAudioRoute: async (direction: 'inbound' | 'outbound', config: AppConfigDraft) =>
      this.invokeFn<AudioRuntimeSnapshot>('start_audio_route', { direction, config }),
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

  /**
   * Legacy bridge lifecycle command that pre-dates bridge_v2. Whitelisted:
   * the startup/autostart path issues it directly and the live-matrix script
   * invokes it over the CLI, so it bypasses the ServiceResult envelope.
   */
  readonly legacyBridge = {
    start: (config: AppConfigDraft) => this.invokeFn<RuntimeSnapshot>('start_bridge_service', { config }),
  };

  readonly diagnostics = {
    selfCheck: async () => unwrap(await this.invokeFn<ServiceResult<RuntimeSnapshot>>('diagnostics_v2', { command: { action: 'selfCheck' } })),
    overlaySelfCheck: async () => unwrap(await this.invokeFn<ServiceResult<RuntimeSnapshot>>('diagnostics_v2', { command: { action: 'overlaySelfCheck' } })),
    export: async (scope: DiagnosticsExportScope) => unwrap(await this.invokeFn<ServiceResult<{ scope: string; outputPath: string; generatedAt: string; fileCount: number }>>('diagnostics_v2', { command: { action: 'export', scope } })),
    liveSessionEvents: async <T>() => unwrap(await this.invokeFn<ServiceResult<T>>('diagnostics_v2', { command: { action: 'liveSessionEvents' } })),
    // Batched frontend log forwarding + dynamic level control stay direct
    // commands (not v2 envelopes): they are fire-and-forget plumbing used by
    // the logger itself and must not depend on snapshot rebuilds.
    appendLogs: async (entries: readonly FrontendDiagnosticsBatchEntry[], droppedCount: number) =>
      this.invokeFn<void>('append_frontend_diagnostics_logs', { entries: [...entries], droppedCount }),
    setLogLevel: async (level: DiagnosticsLogLevel) =>
      this.invokeFn<void>('set_diagnostics_log_level', { level }),
    // Native log-ring snapshot: scene launch attribution reads recent route
    // markers from the diagnostics snapshot action.
    snapshot: async () =>
      unwrap(await this.invokeFn<ServiceResult<{ recentLogs?: DiagnosticLogEntryRuntime[] }>>('diagnostics_v2', { command: { action: 'snapshot' } })),
  };

  readonly configuration = {
    load: async () => unwrap(await this.invokeFn<ServiceResult<AppConfigDraft>>('configuration_v2', { command: { action: 'load' } })),
    save: async (config: AppConfigDraft) => unwrap(await this.invokeFn<ServiceResult<RuntimeSnapshot['storage']>>('configuration_v2', { command: { action: 'save', config } })),
    reset: async () => unwrap(await this.invokeFn<ServiceResult<AppConfigDraft>>('configuration_v2', { command: { action: 'reset' } })),
    export: async () => unwrap(await this.invokeFn<ServiceResult<ConfigExportArtifact>>('configuration_v2', { command: { action: 'export' } })),
    import: async (filePath: string) => unwrap(await this.invokeFn<ServiceResult<AppConfigDraft>>('configuration_v2', { command: { action: 'import', filePath } })),
    createSnapshot: async (reason?: string) => unwrap(await this.invokeFn<ServiceResult<ConfigSnapshotRecord>>('configuration_v2', { command: { action: 'createSnapshot', reason } })),
    rollback: async (snapshotId: string) => unwrap(await this.invokeFn<ServiceResult<AppConfigDraft>>('configuration_v2', { command: { action: 'rollback', snapshotId } })),
    // Whitelisted direct command (see the header): startup recovery issues it
    // before the runtime snapshot exists, and ipc_test.ps1 invokes it over CLI.
    bootstrapStorage: async () => this.invokeFn<void>('bootstrap_storage'),
    runtimeSnapshot: async () =>
      unwrap(await this.invokeFn<ServiceResult<RuntimeSnapshot>>('configuration_v2', { command: { action: 'runtimeSnapshot' } })),
    bootstrapRuntime: async () =>
      unwrap(await this.invokeFn<ServiceResult<RuntimeSnapshot>>('configuration_v2', { command: { action: 'bootstrapRuntime' } })),
  };

  /** Startup-orchestration commands used by the desktop runtime bootstrap. */
  readonly runtime = {
    // Whitelisted direct command (see the header): the IPC liveness probe.
    debugIpcPing: () => this.invokeFn<string>('debug_ipc_ping'),
    bootstrapAudio: async () =>
      unwrap(await this.invokeFn<ServiceResult<AudioRuntimeSnapshot>>('session_v2', { command: { action: 'bootstrap' } })),
  };

  /**
   * Subtitle-overlay native window commands. These stay direct commands (not
   * v2 envelopes): the overlay is a separately bootstrapped renderer and can
   * issue them before the V2 desktop service bridge has hydrated.
   */
  readonly overlay = {
    sync: (locked: boolean, rounded: boolean, hotspotInteractive: boolean) =>
      this.invokeFn<void>('sync_subtitle_overlay_window_state', { locked, rounded, hotspotInteractive }),
    unlock: () => this.invokeFn<void>('unlock_subtitle_overlay'),
    toggle: () => this.invokeFn<RuntimeSnapshot>('toggle_subtitle_overlay'),
    show: () => this.invokeFn<RuntimeSnapshot>('show_subtitle_overlay'),
  };

  readonly benchmark = {
    /** Returns the benchmark report as a raw JSON string; callers parse it. */
    runModelBenchmark: async (payload: ModelBenchmarkRunPayload) =>
      unwrap(await this.invokeFn<ServiceResult<string>>('provider_v2', { command: { action: 'runModelBenchmark', ...payload } })),
  };

  // Secrets are intentionally not represented in the generic configuration
  // draft protocol: callers must use the credential-specific actions, which
  // never appear inside a config document.
  readonly credentials = {
    status: async (reference: string) =>
      unwrap(await this.invokeFn<ServiceResult<CredentialRefStatus>>('configuration_v2', { command: { action: 'secretStatus', reference } })),
    read: async (reference: string) =>
      unwrap(await this.invokeFn<ServiceResult<CredentialSecretPayload>>('configuration_v2', { command: { action: 'secretRead', reference } })),
    save: async (reference: string, secret: string) =>
      unwrap(await this.invokeFn<ServiceResult<CredentialRefStatus>>('configuration_v2', { command: { action: 'secretUpsert', reference, secret } })),
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
