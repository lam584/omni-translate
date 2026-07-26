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
        let decl = decl.replace("bigint", "number");
        let _ = write!(out, "export {}\n\n", decl.trim_end());
    }
    out
}

fn decl<T: TS>() -> String {
    T::decl()
}

struct GeneratedFile {
    name: &'static str,
    source: &'static str,
    content: String,
}

fn generated_files() -> Vec<GeneratedFile> {
    use crate::audio::contracts as audio;
    use crate::bridge::contracts as bridge;
    use crate::runtime::contracts as runtime;
    use crate::shared::contracts as shared;
    use crate::storage::contracts as storage;

    vec![
        GeneratedFile {
            name: "runtime-core.ts",
            source: "apps/desktop/src-tauri/src/{shared,runtime,storage,bridge}/contracts.rs",
            content: render(
                "apps/desktop/src-tauri/src/{shared,runtime,storage,bridge}/contracts.rs",
                &["import type { MixControl } from './driver-bridge-contract';"],
                &[
                    decl::<shared::RuntimeNotification>(),
                    decl::<storage::StorageRuntimeSnapshot>(),
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
            name: "audio-runtime.ts",
            source: "apps/desktop/src-tauri/src/audio/contracts.rs",
            content: render(
                "apps/desktop/src-tauri/src/audio/contracts.rs",
                &[],
                &[
                    decl::<audio::AudioDeviceRuntime>(),
                    decl::<audio::AudioRouteRuntimeSnapshot>(),
                    decl::<audio::SubtitleDisplaySegmentRuntime>(),
                    decl::<audio::SubtitleCueRuntime>(),
                    decl::<audio::SubtitleOverlayRuntimeSnapshot>(),
                    decl::<audio::SpeechDispatchEventRuntime>(),
                    decl::<audio::SpeechRuntimeSnapshot>(),
                    decl::<audio::SttConnectionRuntime>(),
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
