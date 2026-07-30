//! Diagnostics contract types now live in `crate::shared::contracts` so the
//! runtime aggregate can embed them without depending on this module. These
//! re-exports keep every existing `crate::diagnostics::contracts::*` path
//! compiling unchanged.

pub(crate) use crate::shared::contracts::{
    DiagnosticLogCategoryRuntime, DiagnosticLogEntryRuntime, DiagnosticSupportSignalRuntime,
    DiagnosticsExportArtifact, DiagnosticsRuntimeSnapshot, ModelTraceCallRuntime,
    ModelTraceSummaryRuntime,
};
