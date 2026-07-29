/// Shared expansion for the `log_*!` family. Every public logging macro
/// delegates here so the call sequence, `file!():line!()` source capture and
/// argument order stay identical across levels; only the sink function and the
/// level string differ. `file!()`/`line!()` still resolve to the original
/// caller's location because macro spans propagate through delegation.
#[doc(hidden)]
#[macro_export]
macro_rules! __omni_diag_log {
    ($sink:ident, $app:expr, $category:expr, $level:literal, $summary:expr, $detail:expr, $elapsed_ms:expr) => {
        let _ = $crate::diagnostics::events::$sink(
            $app,
            $category,
            $level,
            $summary,
            $detail,
            Some(format!("{}:{}", file!(), line!())),
            $elapsed_ms,
        );
    };
}

#[macro_export]
macro_rules! log_debug {
    ($app:expr, $category:expr, $summary:expr) => {
        $crate::__omni_diag_log!(
            append_diagnostics_log_quiet, $app, $category, "debug", $summary, None, None
        );
    };
    ($app:expr, $category:expr, $summary:expr, $detail:expr) => {
        $crate::__omni_diag_log!(
            append_diagnostics_log_quiet, $app, $category, "debug", $summary, Some($detail), None
        );
    };
    ($app:expr, $category:expr, $summary:expr, $detail:expr, $elapsed_ms:expr) => {
        $crate::__omni_diag_log!(
            append_diagnostics_log_quiet, $app, $category, "debug", $summary, Some($detail), Some($elapsed_ms)
        );
    };
}

#[macro_export]
macro_rules! log_info {
    ($app:expr, $category:expr, $summary:expr) => {
        $crate::__omni_diag_log!(
            append_diagnostics_log_quiet, $app, $category, "info", $summary, None, None
        );
    };
    ($app:expr, $category:expr, $summary:expr, $detail:expr) => {
        $crate::__omni_diag_log!(
            append_diagnostics_log_quiet, $app, $category, "info", $summary, Some($detail), None
        );
    };
    ($app:expr, $category:expr, $summary:expr, $detail:expr, $elapsed_ms:expr) => {
        $crate::__omni_diag_log!(
            append_diagnostics_log_quiet, $app, $category, "info", $summary, Some($detail), Some($elapsed_ms)
        );
    };
}

#[macro_export]
macro_rules! log_warn {
    ($app:expr, $category:expr, $summary:expr) => {
        $crate::__omni_diag_log!(
            append_diagnostics_log, $app, $category, "warning", $summary, None, None
        );
    };
    ($app:expr, $category:expr, $summary:expr, $detail:expr) => {
        $crate::__omni_diag_log!(
            append_diagnostics_log, $app, $category, "warning", $summary, Some($detail), None
        );
    };
    ($app:expr, $category:expr, $summary:expr, $detail:expr, $elapsed_ms:expr) => {
        $crate::__omni_diag_log!(
            append_diagnostics_log, $app, $category, "warning", $summary, Some($detail), Some($elapsed_ms)
        );
    };
}

#[macro_export]
macro_rules! log_error {
    ($app:expr, $category:expr, $summary:expr) => {
        $crate::__omni_diag_log!(
            append_diagnostics_log, $app, $category, "error", $summary, None, None
        );
    };
    ($app:expr, $category:expr, $summary:expr, $detail:expr) => {
        $crate::__omni_diag_log!(
            append_diagnostics_log, $app, $category, "error", $summary, Some($detail), None
        );
    };
    ($app:expr, $category:expr, $summary:expr, $detail:expr, $elapsed_ms:expr) => {
        $crate::__omni_diag_log!(
            append_diagnostics_log, $app, $category, "error", $summary, Some($detail), Some($elapsed_ms)
        );
    };
}
