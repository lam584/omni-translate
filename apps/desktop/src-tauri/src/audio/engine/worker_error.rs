use super::*;

pub(super) fn notify_route_worker_error<R: tauri::Runtime>(
    app: &AppHandle<R>,
    direction: &str,
    message: &str,
    error_code: Option<&str>,
) {
    let Some(runtime_state) = app.try_state::<RuntimeStateStore>() else {
        return;
    };
    let text = match error_code {
        Some(code) => format!("音频链路已中断（{direction}）: {message} [{code}]"),
        None => format!("音频链路已中断（{direction}）: {message}"),
    };
    let _ = emit_runtime_notification(
        app,
        &runtime_state,
        crate::runtime::contracts::RuntimeNotification::error(
            &format!("audio-engine-{direction}-{}", error_code.unwrap_or("worker-error")),
            "audio-engine",
            &text,
            ms_marker(unix_ms()),
        ),
    );
}
