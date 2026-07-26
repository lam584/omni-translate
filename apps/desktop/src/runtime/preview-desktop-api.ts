import i18n from '../i18n/config';
import { appConfigDraftMock } from '../defaults/app-config';
import { audioRuntimeSnapshotMock } from '../defaults/audio-runtime';
import { defaultProviderProbeProfile } from '../defaults/provider-probes';
import { runtimeSnapshotMock } from '../defaults/runtime-shell';
import type { AudioRuntimeSnapshot } from '../schema/audio-runtime';
import type { AppConfigDraft, DiagnosticsExportScope, ProviderDraft } from '../schema/config';
import type { DriverRepairAction } from '../schema/driver-bridge-contract';
import type { ModelPreset } from '../schema/provider-template';
import type {
  CredentialRefStatus,
  CredentialSecretPayload,
  ProviderModelCatalogRuntime,
  ProviderModelRuntime,
  ProviderProbeProfileRuntime,
  ProviderSmokeResult,
} from '../schema/provider-runtime';
import type { DiagnosticLogEntryRuntime, RuntimeSnapshot } from '../schema/runtime-core';
import type {
  ConfigSnapshotRecord,
  DesktopMenuItem,
  DesktopMonitor,
  DesktopPoint,
  DesktopSize,
  DiagnosticsLogLevel,
  FrontendDiagnosticsBatchEntry,
  ModelBenchmarkRunPayload,
} from './desktop-api-v2';

/** Capability flags a desktop-api implementation advertises to callers. */
export type DesktopCapabilities = {
  /** True only inside the Tauri shell: native IPC, windows, tray, drivers. */
  readonly hasNativeShell: boolean;
};

function previewUnavailable(operation: string): Error {
  return new Error(`browser-preview: ${operation} is not available outside the desktop shell`);
}

function mapPresetToRuntimeModel(preset: ModelPreset): ProviderModelRuntime {
  return {
    id: preset.model,
    displayName: preset.displayName,
    ownedBy: 'preset',
    createdAt: null,
    capabilities: preset.capabilities,
  };
}

export function previewRoutingForVerdict(verdict: ProviderProbeProfileRuntime['verdict']) {
  return {
    subtitlePriority: verdict === 'available' ? ('balanced' as const) : ('subtitle-first' as const),
    speechDisposition: verdict === 'available' ? ('ready' as const) : ('deferred' as const),
    rationale: i18n.t('runtime.provider.previewRationale'),
  };
}

/**
 * Stateful browser-preview implementation of the desktop boundary.
 *
 * This is the single home for every "not in Tauri -> serve preview data"
 * branch that previously lived inline in the runtime modules. It mirrors the
 * fake-bridge contract double semantics at the API-method level: route
 * starts bind streams, cue clears empty the overlay, bridge lifecycle
 * transitions patch the runtime snapshot, so the real runtime-module logic
 * (polling loops, patch merges) behaves in the preview exactly as it did
 * with the old inline fallbacks. Operations with no preview meaning reject
 * with a clear browser-preview error instead of a raw missing-bridge invoke
 * failure.
 */
export class PreviewDesktopApi {
  readonly capabilities: DesktopCapabilities = { hasNativeShell: false };

  private audio: AudioRuntimeSnapshot = structuredClone(audioRuntimeSnapshotMock);
  private runtimeSnapshot: RuntimeSnapshot = structuredClone(runtimeSnapshotMock);
  private configDraft: AppConfigDraft = structuredClone(appConfigDraftMock);

  private audioSnapshot(): AudioRuntimeSnapshot {
    return structuredClone(this.audio);
  }

  private shellSnapshot(): RuntimeSnapshot {
    return structuredClone(this.runtimeSnapshot);
  }

  private patchBridge(patch: Partial<RuntimeSnapshot['bridge']>): RuntimeSnapshot {
    this.runtimeSnapshot = {
      ...this.runtimeSnapshot,
      bridge: { ...this.runtimeSnapshot.bridge, ...patch },
    };
    return this.shellSnapshot();
  }

  private patchDiagnostics(patch: Partial<RuntimeSnapshot['diagnostics']>): RuntimeSnapshot {
    this.runtimeSnapshot = {
      ...this.runtimeSnapshot,
      diagnostics: { ...this.runtimeSnapshot.diagnostics, ...patch },
    };
    return this.shellSnapshot();
  }

  private startRoute(direction: 'inbound' | 'outbound'): AudioRuntimeSnapshot {
    const route = direction === 'inbound' ? this.audio.inbound : this.audio.outbound;
    route.captureState = 'capturing';
    route.streamBound = true;
    route.framesCaptured += 960;
    return this.audioSnapshot();
  }

  private stopRoute(direction: 'inbound' | 'outbound'): AudioRuntimeSnapshot {
    const route = direction === 'inbound' ? this.audio.inbound : this.audio.outbound;
    route.captureState = direction === 'inbound' ? 'buffering' : 'armed';
    route.streamBound = false;
    return this.audioSnapshot();
  }

  readonly provider = {
    fetchModels: async (provider: ProviderDraft, presetModels: readonly ModelPreset[] = []): Promise<ProviderModelCatalogRuntime> => ({
      providerId: provider.providerId,
      endpoint: `${provider.baseUrl.replace(/\/$/, '')}/models`,
      fetchedAt: new Date().toISOString(),
      models: presetModels.map(mapPresetToRuntimeModel),
      error: null,
    }),
    probe: async (provider: ProviderDraft): Promise<ProviderProbeProfileRuntime> => ({
      id: defaultProviderProbeProfile.id,
      templateId: defaultProviderProbeProfile.templateId,
      providerId: defaultProviderProbeProfile.providerId,
      verdict: defaultProviderProbeProfile.verdict,
      checkedAt: defaultProviderProbeProfile.checkedAt,
      measuredLatencyMs: defaultProviderProbeProfile.measuredLatencyMs,
      latencyBudgetMs: defaultProviderProbeProfile.latencyBudgetMs,
      streamSupported: defaultProviderProbeProfile.streamSupported,
      errorShapeStable: defaultProviderProbeProfile.errorShapeStable,
      responseShapeStable: defaultProviderProbeProfile.responseShapeStable,
      transportRequested: provider.transport,
      transportEffective: provider.transport,
      fallbackApplied: false,
      checks: defaultProviderProbeProfile.checks,
      guidance: defaultProviderProbeProfile.guidance,
      routingDecision: previewRoutingForVerdict(defaultProviderProbeProfile.verdict),
      error: null,
    }),
    smoke: async (
      provider: ProviderDraft,
      _sourceText?: string,
      sourceLanguage?: string,
      targetLanguage?: string,
    ): Promise<ProviderSmokeResult> => ({
      requestId: 'browser-preview-smoke',
      providerId: provider.providerId,
      status: 'completed',
      transportRequested: provider.transport,
      transportEffective: provider.transport,
      fallbackApplied: false,
      streamObserved: provider.transport !== 'http',
      durationMs: 120,
      firstEventLatencyMs: 48,
      transcript: 'Browser preview translation result.',
      sourceLanguage: sourceLanguage ?? '',
      targetLanguage: targetLanguage ?? '',
      eventLog: [
        {
          eventType: 'session.started',
          summary: i18n.t('runtime.provider.smokeSessionStarted'),
          segmentId: null,
          textDelta: null,
          text: null,
          audioChunkRef: null,
        },
        {
          eventType: 'translation.completed',
          summary: i18n.t('runtime.provider.smokeTranslationCompleted'),
          segmentId: 'segment-preview',
          textDelta: null,
          text: 'Browser preview translation result.',
          audioChunkRef: null,
        },
        {
          eventType: 'response.completed',
          summary: i18n.t('runtime.provider.smokeResponseCompleted'),
          segmentId: null,
          textDelta: null,
          text: null,
          audioChunkRef: null,
        },
      ],
      inputTokens: 12,
      outputTokens: 5,
      audioSeconds: null,
      routingDecision: {
        subtitlePriority: 'balanced',
        speechDisposition: 'ready',
        rationale: i18n.t('runtime.provider.smokePreviewRationale'),
      },
      error: null,
    }),
  };

  readonly session = {
    snapshot: async () => this.audioSnapshot(),
    refreshDevices: async () => this.audioSnapshot(),
    preconnect: async (_config: AppConfigDraft) => this.audioSnapshot(),
    cancelPreconnect: async () => this.audioSnapshot(),
    prewarmRoutes: async (_config: AppConfigDraft) => this.audioSnapshot(),
    startRoute: async (direction: 'inbound' | 'outbound', _config: AppConfigDraft) => this.startRoute(direction),
    stopRoute: async (direction: 'inbound' | 'outbound') => this.stopRoute(direction),
    clearCues: async () => {
      this.audio.subtitleOverlay = {
        queueDepth: 0,
        droppedCueCount: 0,
        firstTranslationAverageMs: null,
        firstTranslationLastMs: null,
        firstTranslationSampleCount: 0,
        activeCue: null,
        recentCues: [],
      };
      this.audio.speech = { ...this.audio.speech, queueDepth: 0, currentCueId: null };
      return this.audioSnapshot();
    },
    startSpeech: async (config: AppConfigDraft) => {
      this.audio.speech = {
        ...this.audio.speech,
        status: 'ready',
        dispatchState: 'playing',
        outputTarget: config.speech.outputTarget,
      };
      return this.audioSnapshot();
    },
    stopSpeech: async () => {
      this.audio.speech = {
        ...this.audio.speech,
        dispatchState: 'idle',
        currentCueId: null,
        currentRequestId: null,
      };
      return this.audioSnapshot();
    },
    startTranslation: async (_config: AppConfigDraft) => {
      this.audio.sessionStartedAt = new Date().toISOString();
      return this.audioSnapshot();
    },
    stopTranslation: async () => {
      this.audio.sessionStartedAt = null;
      return this.audioSnapshot();
    },
    syncOverlayRegion: async (_rounded = true) => this.audioSnapshot(),
    syncOverlayWindowState: async (_locked: boolean, _rounded: boolean, _hotspotInteractive: boolean) => this.audioSnapshot(),
    startAudioRoute: async (direction: 'inbound' | 'outbound', _config: AppConfigDraft) => this.startRoute(direction),
  };

  readonly bridge = {
    snapshot: async (): Promise<RuntimeSnapshot['bridge']> => structuredClone(this.runtimeSnapshot.bridge),
    refresh: async () => this.shellSnapshot(),
    start: async (config: AppConfigDraft) =>
      this.patchBridge({
        processStatus: 'running',
        bridgeState: 'running',
        lifecycleState: 'ready',
        driverHealth: 'running',
        installPhase: 'ready',
        lastErrorCode: null,
        recommendedAction: 'open-diagnostics',
        sessionId: 'browser-preview-session',
        lastHandshakeAt: new Date().toISOString(),
        expectedDriverVersion: config.driver.expectedDriverVersion,
        expectedBridgeVersion: config.driver.expectedBridgeVersion,
      }),
    stop: async () =>
      this.patchBridge({
        processStatus: 'stopped',
        bridgeState: 'stopped',
        lifecycleState: 'stopped',
        sessionId: null,
      }),
    install: async (config: AppConfigDraft) =>
      this.patchBridge({
        processStatus: 'running',
        bridgeState: 'running',
        lifecycleState: 'ready',
        driverHealth: 'running',
        driverVersion: config.driver.expectedDriverVersion,
        bridgeVersion: config.driver.expectedBridgeVersion,
        installPhase: 'ready',
        lastErrorCode: null,
        recommendedAction: 'open-diagnostics',
        sessionId: 'browser-preview-session',
        lastHandshakeAt: new Date().toISOString(),
      }),
    uninstall: async () =>
      this.patchBridge({
        processStatus: 'stopped',
        bridgeState: 'stopped',
        lifecycleState: 'idle',
        driverHealth: 'not-installed',
        driverVersion: null,
        installPhase: 'planned',
        lastErrorCode: 'driver.not-installed',
        recommendedAction: 'reinstall-driver',
        sessionId: null,
      }),
    repair: async (repairAction: DriverRepairAction, config: AppConfigDraft) =>
      repairAction === 'restart-bridge' ? this.bridge.start(config) : this.bridge.install(config),
  };

  readonly legacyBridge = {
    start: async (config: AppConfigDraft) => this.bridge.start(config),
  };

  readonly diagnostics = {
    selfCheck: async () =>
      this.patchDiagnostics({
        status: 'ready',
        installStatus: 'ready',
        providerStatus: 'ready',
        driverStatus: 'warning',
        deviceStatus: 'warning',
        lastSelfCheckAt: new Date().toISOString(),
      }),
    overlaySelfCheck: async () => this.shellSnapshot(),
    export: async (scope: DiagnosticsExportScope) => {
      const generatedAt = new Date().toISOString();
      const outputPath = `browser-preview/diagnostics-${scope}.zip`;
      this.patchDiagnostics({
        lastExportScope: scope,
        lastExportPath: outputPath,
        lastExportedAt: generatedAt,
      });
      return { scope: scope as string, outputPath, generatedAt, fileCount: scope === 'full' ? 6 : 3 };
    },
    liveSessionEvents: async <T,>() => ({}) as T,
    appendLogs: async (_entries: readonly FrontendDiagnosticsBatchEntry[], _droppedCount: number) => undefined,
    setLogLevel: async (_level: DiagnosticsLogLevel) => undefined,
    snapshot: async (): Promise<{ recentLogs?: DiagnosticLogEntryRuntime[] }> => ({ recentLogs: [] }),
  };

  readonly configuration = {
    load: async () => structuredClone(this.configDraft),
    save: async (config: AppConfigDraft) => {
      this.configDraft = structuredClone(config);
      return structuredClone(this.runtimeSnapshot.storage);
    },
    reset: async () => {
      this.configDraft = structuredClone(appConfigDraftMock);
      return structuredClone(this.configDraft);
    },
    export: async () => Promise.reject(previewUnavailable('configuration.export')),
    import: async (_filePath: string) => Promise.reject(previewUnavailable('configuration.import')),
    createSnapshot: async (_reason?: string): Promise<ConfigSnapshotRecord> =>
      Promise.reject(previewUnavailable('configuration.createSnapshot')),
    rollback: async (_snapshotId: string) => Promise.reject(previewUnavailable('configuration.rollback')),
    bootstrapStorage: async () => undefined,
    runtimeSnapshot: async () => this.shellSnapshot(),
    bootstrapRuntime: async () => this.shellSnapshot(),
  };

  readonly runtime = {
    debugIpcPing: async (): Promise<string> => Promise.reject(previewUnavailable('runtime.debugIpcPing')),
    bootstrapAudio: async () => this.audioSnapshot(),
  };

  readonly overlay = {
    sync: async (_locked: boolean, _rounded: boolean, _hotspotInteractive: boolean) => undefined,
    unlock: async () => undefined,
    toggle: async () => {
      this.runtimeSnapshot = {
        ...this.runtimeSnapshot,
        windows: this.runtimeSnapshot.windows.map((item) =>
          item.label === 'subtitle-overlay' ? { ...item, visible: !item.visible } : item,
        ),
      };
      return this.shellSnapshot();
    },
    show: async () => {
      this.runtimeSnapshot = {
        ...this.runtimeSnapshot,
        windows: this.runtimeSnapshot.windows.map((item) =>
          item.label === 'subtitle-overlay' ? { ...item, visible: true } : item,
        ),
      };
      return this.shellSnapshot();
    },
  };

  readonly benchmark = {
    runModelBenchmark: async (_payload: ModelBenchmarkRunPayload): Promise<string> =>
      Promise.reject(new Error(i18n.t('runtime.benchmark.desktopOnly'))),
  };

  readonly credentials = {
    status: async (reference: string): Promise<CredentialRefStatus> => ({
      reference,
      backend: 'browser-preview',
      hasSecret: false,
    }),
    read: async (reference: string): Promise<CredentialSecretPayload> => ({
      reference,
      backend: 'browser-preview',
      secret: null,
    }),
    save: async (reference: string, secret: string): Promise<CredentialRefStatus> => ({
      reference,
      backend: 'browser-preview',
      hasSecret: secret.length > 0,
    }),
  };

  readonly window = {
    currentMonitor: async (): Promise<DesktopMonitor | null> => null,
    cursorPosition: async (): Promise<DesktopPoint> => Promise.reject(previewUnavailable('window.cursorPosition')),
    outerPosition: async (): Promise<DesktopPoint> => Promise.reject(previewUnavailable('window.outerPosition')),
    outerSize: async (): Promise<DesktopSize> => Promise.reject(previewUnavailable('window.outerSize')),
    scaleFactor: async (): Promise<number> => Promise.reject(previewUnavailable('window.scaleFactor')),
    setPosition: async (_position: DesktopPoint) => undefined,
    setLogicalSize: async (_size: DesktopSize) => undefined,
    popupMenu: async (_items: DesktopMenuItem[], _position: DesktopPoint) => undefined,
  };
}
