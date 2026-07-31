// GENERATED FILE - do not edit by hand.
// Source of truth: apps/desktop/src-tauri/src/api_v2.rs
// Regenerate: OMNI_UPDATE_CONTRACTS=1 cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml contract_export

export type ProviderCommandV2 = { "action": "resolveRealtimeProfile", config: unknown, modelReference: string, } | { "action": "fetchModels", provider: unknown, } | { "action": "probe", provider: unknown, } | { "action": "smoke", provider: unknown, sourceText?: string, sourceLanguage?: string, targetLanguage?: string, } | { "action": "runModelBenchmark", model: string, apiKey: string, mp3Path: string, runId: string, realtimeAudioMode?: string, interactionCapabilities?: Array<string>, providerKind?: string, baseUrl?: string, authHeaderName?: string, authScheme?: string, provider?: unknown, };

export type SessionCommandV2 = { "action": "snapshot" } | { "action": "bootstrap" } | { "action": "refreshDevices" } | { "action": "preconnect", config: unknown, } | { "action": "cancelPreconnect" } | { "action": "prewarmRoutes", config: unknown, } | { "action": "startRoute", direction: string, config: unknown, } | { "action": "stopRoute", direction: string, } | { "action": "clearCues" } | { "action": "startSpeech", config: unknown, } | { "action": "stopSpeech" } | { "action": "startTranslation", config: unknown, } | { "action": "stopTranslation" } | { "action": "syncOverlayRegion", rounded: boolean, } | { "action": "syncOverlayWindowState", locked: boolean, rounded: boolean, hotspotInteractive: boolean, };

export type BridgeCommandV2 = { "action": "snapshot" } | { "action": "refresh" } | { "action": "start", config: unknown, } | { "action": "stop" } | { "action": "install", config: unknown, } | { "action": "uninstall" } | { "action": "repair", config: unknown, repairAction: string, };

export type DiagnosticsCommandV2 = { "action": "selfCheck" } | { "action": "overlaySelfCheck" } | { "action": "export", scope: string, } | { "action": "watchSessionReport" } | { "action": "clearWatchSessionReport" } | { "action": "snapshot" } | { "action": "openExportDirectory", outputPath: string, } | { "action": "writeExportArtifact", filename: string, content: string, };

export type ConfigurationCommandV2 = { "action": "load" } | { "action": "save", config: unknown, } | { "action": "reset" } | { "action": "export" } | { "action": "import", filePath: string, } | { "action": "createSnapshot", reason?: string, } | { "action": "rollback", snapshotId: string, } | { "action": "runtimeSnapshot" } | { "action": "bootstrapRuntime" } | { "action": "secretStatus", reference: string, } | { "action": "secretRead", reference: string, } | { "action": "secretUpsert", reference: string, secret: string, };

