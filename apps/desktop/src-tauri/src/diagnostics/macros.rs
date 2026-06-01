#[macro_export]
macro_rules! log_debug {
    ($app:expr, $category:expr, $summary:expr) => {
        let _ = $crate::diagnostics::events::append_diagnostics_log_quiet(
            $app,
            $category,
            "debug",
            $summary,
            None,
            Some(format!("{}:{}", file!(), line!())),
            None,
        );
    };
    ($app:expr, $category:expr, $summary:expr, $detail:expr) => {
        let _ = $crate::diagnostics::events::append_diagnostics_log_quiet(
            $app,
            $category,
            "debug",
            $summary,
            Some($detail),
            Some(format!("{}:{}", file!(), line!())),
            None,
        );
    };
    ($app:expr, $category:expr, $summary:expr, $detail:expr, $elapsed_ms:expr) => {
        let _ = $crate::diagnostics::events::append_diagnostics_log_quiet(
            $app,
            $category,
            "debug",
            $summary,
            Some($detail),
            Some(format!("{}:{}", file!(), line!())),
            Some($elapsed_ms),
        );
    };
}

#[macro_export]
macro_rules! log_info {
    ($app:expr, $category:expr, $summary:expr) => {
        let _ = $crate::diagnostics::events::append_diagnostics_log_quiet(
            $app,
            $category,
            "info",
            $summary,
            None,
            Some(format!("{}:{}", file!(), line!())),
            None,
        );
    };
    ($app:expr, $category:expr, $summary:expr, $detail:expr) => {
        let _ = $crate::diagnostics::events::append_diagnostics_log_quiet(
            $app,
            $category,
            "info",
            $summary,
            Some($detail),
            Some(format!("{}:{}", file!(), line!())),
            None,
        );
    };
    ($app:expr, $category:expr, $summary:expr, $detail:expr, $elapsed_ms:expr) => {
        let _ = $crate::diagnostics::events::append_diagnostics_log_quiet(
            $app,
            $category,
            "info",
            $summary,
            Some($detail),
            Some(format!("{}:{}", file!(), line!())),
            Some($elapsed_ms),
        );
    };
}

#[macro_export]
macro_rules! log_warn {
    ($app:expr, $category:expr, $summary:expr) => {
        let _ = $crate::diagnostics::events::append_diagnostics_log(
            $app,
            $category,
            "warning",
            $summary,
            None,
            Some(format!("{}:{}", file!(), line!())),
            None,
        );
    };
    ($app:expr, $category:expr, $summary:expr, $detail:expr) => {
        let _ = $crate::diagnostics::events::append_diagnostics_log(
            $app,
            $category,
            "warning",
            $summary,
            Some($detail),
            Some(format!("{}:{}", file!(), line!())),
            None,
        );
    };
    ($app:expr, $category:expr, $summary:expr, $detail:expr, $elapsed_ms:expr) => {
        let _ = $crate::diagnostics::events::append_diagnostics_log(
            $app,
            $category,
            "warning",
            $summary,
            Some($detail),
            Some(format!("{}:{}", file!(), line!())),
            Some($elapsed_ms),
        );
    };
}

#[macro_export]
macro_rules! log_error {
    ($app:expr, $category:expr, $summary:expr) => {
        let _ = $crate::diagnostics::events::append_diagnostics_log(
            $app,
            $category,
            "error",
            $summary,
            None,
            Some(format!("{}:{}", file!(), line!())),
            None,
        );
    };
    ($app:expr, $category:expr, $summary:expr, $detail:expr) => {
        let _ = $crate::diagnostics::events::append_diagnostics_log(
            $app,
            $category,
            "error",
            $summary,
            Some($detail),
            Some(format!("{}:{}", file!(), line!())),
            None,
        );
    };
    ($app:expr, $category:expr, $summary:expr, $detail:expr, $elapsed_ms:expr) => {
        let _ = $crate::diagnostics::events::append_diagnostics_log(
            $app,
            $category,
            "error",
            $summary,
            Some($detail),
            Some(format!("{}:{}", file!(), line!())),
            Some($elapsed_ms),
        );
    };
}
