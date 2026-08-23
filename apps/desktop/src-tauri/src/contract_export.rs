//! Generated TypeScript contract files: assembly + freshness gate.
//!
//! `cargo test contract_export` fails when the committed files under
//! `apps/desktop/src/schema/generated/` no longer match what the Rust
//! contract types declare; regenerate with
//! `OMNI_UPDATE_CONTRACTS=1 cargo test contract_export`
//! (PowerShell: `$env:OMNI_UPDATE_CONTRACTS='1'; cargo test contract_export`).
//!
//! The version pins and event-name pins stay in
//! `scripts/testing/verify-contracts.mjs`; this module only owns the type
//! shapes. TS-side files under `src/schema/` re-export from the generated
//! files, so a Rust contract change that is not regenerated fails here and
//! a regenerated change that breaks consumers fails `tsc`.

use std::fmt::Write as _;
use std::fs;
use std::path::PathBuf;

use ts_rs::TS;

fn generated_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(r"..\src\schema\generated")
}

fn header(source: &str) -> String {
    format!(
        "// GENERATED FILE - do not edit by hand.\n\
         // Source of truth: {source}\n\
         // Regenerate: OMNI_UPDATE_CONTRACTS=1 cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml contract_export\n\n"
    )
}

fn render(header_source: &str, imports: &[&str], decls: &[String]) -> String {
    let mut out = header(header_source);
    for import in imports {
        out.push_str(import);
        out.push('\n');
    }
    if !imports.is_empty() {
        out.push('\n');
    }
    for decl in decls {
        // Wide integers travel as JSON numbers through serde_json (u64 and
        // the explicitly-annotated u128 fields alike), so the TypeScript
        // side has always typed them as `number`; fold ts-rs's `bigint`
        // mapping accordingly.
        let decl = decl
            .replace("bigint", "number")
            .lines()
            .map(str::trim_end)
            .collect::<Vec<_>>()
            .join("\n");
        let _ = write!(out, "export {}\n\n", decl.trim_end());
    }
    out
}

fn decl<T: TS>() -> String {
    T::decl(&ts_rs::Config::default())
}

struct GeneratedFile {
    name: &'static str,
    content: String,
}

fn generated_files() -> Vec<GeneratedFile> {
    use omni_bridge_protocol as protocol;
    use crate::audio::contracts as audio;
    use crate::bridge::contracts as bridge;
    use crate::provider::contracts as provider;
    use crate::runtime::contracts as runtime;
    use crate::shared::contracts as shared;
    use crate::storage::contracts as storage;

    vec![
        GeneratedFile {
            name: "runtime-core.ts",
            content: render(
                "apps/desktop/src-tauri/src/{shared,runtime,storage,bridge}/contracts.rs",
                &["import type { CaptureBackend, MixControl, ProcessLoopbackStatus, SourceCaptureMode } from './driver-bridge-contract';"],
                &[
                    decl::<shared::RuntimeNotification>(),
                    decl::<storage::StorageRuntimeSnapshot>(),
                    decl::<storage::ConfigExportArtifact>(),
                    decl::<storage::ConfigSnapshotRecord>(),
                    decl::<storage::BenchmarkHistoryRecord>(),
                    decl::<storage::BenchmarkHistorySummary>(),
                    decl::<storage::BenchmarkHistoryPage>(),
                    decl::<storage::BenchmarkHistoryDeleteResult>(),
                    decl::<storage::BenchmarkHistoryClearResult>(),
                    decl::<runtime::RuntimeWindowSnapshot>(),
                    decl::<bridge::BridgeRuntimeSnapshot>(),
                    decl::<bridge::DriverOperationResult>(),
                    decl::<shared::DiagnosticLogEntryRuntime>(),
                    decl::<shared::DiagnosticLogCategoryRuntime>(),
                    decl::<shared::DiagnosticSupportSignalRuntime>(),
                    decl::<shared::ModelTraceCallRuntime>(),
                    decl::<shared::ModelTraceSummaryRuntime>(),
                    decl::<shared::DiagnosticsRuntimeSnapshot>(),
                    decl::<shared::DiagnosticsExportArtifact>(),
                    decl::<runtime::RuntimeSnapshot>(),
                ],
            ),
        },
        GeneratedFile {
            name: "driver-bridge-contract.ts",
            content: render(
                "crates/omni-bridge-protocol/src/lib.rs",
                &[],
                &[
                    decl::<protocol::SourceCaptureMode>(),
                    decl::<protocol::CaptureBackend>(),
                    decl::<protocol::ProcessLoopbackStatus>(),
                    decl::<protocol::MixControl>(),
                    decl::<protocol::TranslationAudioSink>(),
                    decl::<protocol::AudioRouteDirection>(),
                    decl::<protocol::TranslationStreamState>(),
                    decl::<protocol::AudioFrameHeader>(),
                    decl::<protocol::TranslationPlaybackStatusKind>(),
                    decl::<protocol::TranslationPlaybackStatusEvent>(),
                    decl::<protocol::TranslationPlaybackStatusAck>(),
                    decl::<protocol::AudioFrameAck>(),
                ],
            ),
        },
        GeneratedFile {
            name: "bridge-ipc.ts",
            content: render(
                "apps/desktop/src-tauri/src/bridge/contracts.rs",
                &["import type { CaptureBackend, MixControl, ProcessLoopbackStatus, SourceCaptureMode } from './driver-bridge-contract';"],
                &[
                    decl::<bridge::BridgeAudioFrame>(),
                    decl::<bridge::BridgeInitRequest>(),
                    decl::<bridge::BridgeInitResponse>(),
                    decl::<bridge::BridgeProcessLoopbackProbeRequest>(),
                    decl::<bridge::BridgeProcessLoopbackProbeResponse>(),
                    decl::<bridge::BridgeStateQuery>(),
                    decl::<bridge::BridgeStateResponse>(),
                    decl::<bridge::BridgeWriteFrameRequest>(),
                    decl::<bridge::BridgeWriteFrameAck>(),
                    decl::<bridge::BridgeShutdownRequest>(),
                    decl::<bridge::DriverBridgeErrorEvent>(),
                ],
            ),
        },
        GeneratedFile {
            name: "provider-runtime.ts",
            content: render(
                "apps/desktop/src-tauri/src/{provider,storage}/contracts.rs + main.rs",
                &[
                    "import type { ProviderCapability } from '../provider-contract';",
                    "import type { ProviderProbeCheckStatus, ProviderProbeVerdict } from '../provider-probe';",
                ],
                &[
                    decl::<provider::ProviderRuntimeError>(),
                    decl::<provider::ProviderRoutingDecision>(),
                    decl::<provider::ProviderProbeCheckRuntime>(),
                    decl::<provider::ProviderProbeProfileRuntime>(),
                    decl::<provider::ProviderStreamEventRecord>(),
                    decl::<provider::ProviderSmokeResult>(),
                    decl::<provider::ProviderModelRuntime>(),
                    decl::<provider::ProviderModelCatalogRuntime>(),
                    decl::<storage::CredentialRefStatus>(),
                    decl::<storage::CredentialSecretPayload>(),
                    decl::<crate::CredentialDirectResultEvent>(),
                ],
            ),
        },
        GeneratedFile {
            name: "api-v2-commands.ts",
            content: render(
                "apps/desktop/src-tauri/src/api_v2.rs",
                &[],
                &[
                    decl::<crate::api_v2::ProviderCommandV2>(),
                    decl::<crate::api_v2::SessionCommandV2>(),
                    decl::<crate::api_v2::BridgeCommandV2>(),
                    decl::<crate::api_v2::DiagnosticsCommandV2>(),
                    decl::<crate::api_v2::HistoryCommandV2>(),
                    decl::<crate::api_v2::ConfigurationCommandV2>(),
                ],
            ),
        },
        GeneratedFile {
            name: "audio-runtime.ts",
            content: render(
                "apps/desktop/src-tauri/src/audio/contracts.rs",
                &[],
                &[
                    decl::<audio::AudioDeviceRuntime>(),
                    decl::<audio::AudioRouteRuntimeSnapshot>(),
                    decl::<audio::SubtitleDisplaySegmentRuntime>(),
                    decl::<audio::SubtitleCueRuntime>(),
                    decl::<audio::SubtitleOverlayRuntimeSnapshot>(),
                    decl::<audio::WatchTimelineEventRuntime>(),
                    decl::<audio::WatchIssueRuntime>(),
                    decl::<audio::WatchCueComparisonRuntime>(),
                    decl::<audio::WatchSessionReportSummaryRuntime>(),
                    decl::<audio::WatchSessionReportRuntime>(),
                    decl::<audio::OverlayRenderReceiptRuntime>(),
                    decl::<audio::SpeechDispatchEventRuntime>(),
                    decl::<audio::SpeechRuntimeSnapshot>(),
                    decl::<audio::SttConnectionRuntime>(),
                    decl::<audio::EchoCaptureDiagnosticsRuntime>(),
                    decl::<audio::AudioRuntimeSnapshot>(),
                ],
            ),
        },
    ]
}

#[test]
fn contract_export_matches_generated_files() {
    let update = std::env::var("OMNI_UPDATE_CONTRACTS").is_ok();
    let dir = generated_dir();
    if update {
        fs::create_dir_all(&dir).expect("create generated dir");
    }

    let mut stale = Vec::new();
    for file in generated_files() {
        let path = dir.join(file.name);
        if update {
            fs::write(&path, &file.content).expect("write generated file");
            continue;
        }
        let existing = fs::read_to_string(&path).unwrap_or_default();
        if existing.replace("\r\n", "\n") != file.content.replace("\r\n", "\n") {
            stale.push(file.name);
        }
    }

    assert!(
        stale.is_empty(),
        "generated contract files are stale: {stale:?}; regenerate with OMNI_UPDATE_CONTRACTS=1 cargo test contract_export"
    );
}
