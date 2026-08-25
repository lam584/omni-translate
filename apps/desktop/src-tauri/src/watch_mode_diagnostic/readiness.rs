use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

const READINESS_PATH_ENV: &str = "OMNI_WATCH_MODE_READINESS_PATH";
const RUN_MARKER_ENV: &str = "OMNI_WATCH_MODE_RUN_MARKER";
const SCHEMA_VERSION: &str = "watch-mode-readiness/v2";

static WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ComponentReadiness {
    status: String,
    at_ms: Option<u64>,
    error: Option<ReadinessError>,
}

impl ComponentReadiness {
    fn pending() -> Self {
        Self {
            status: "pending".to_string(),
            at_ms: None,
            error: None,
        }
    }

    fn set(&mut self, status: &str, error: Option<ReadinessError>) {
        self.status = status.to_string();
        self.at_ms = Some(now_ms());
        self.error = error;
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadinessError {
    code: String,
    message: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WatchModeReadiness {
    schema_version: String,
    run_marker: String,
    process_id: u32,
    state: String,
    updated_at_ms: u64,
    frontend_ipc: ComponentReadiness,
    provider: ComponentReadiness,
    bridge: ComponentReadiness,
    route: ComponentReadiness,
    failure: Option<ReadinessError>,
}

impl WatchModeReadiness {
    fn new(run_marker: String) -> Self {
        Self {
            schema_version: SCHEMA_VERSION.to_string(),
            run_marker,
            process_id: std::process::id(),
            state: "waiting-frontend-ipc".to_string(),
            updated_at_ms: now_ms(),
            frontend_ipc: ComponentReadiness::pending(),
            provider: ComponentReadiness::pending(),
            bridge: ComponentReadiness::pending(),
            route: ComponentReadiness::pending(),
            failure: None,
        }
    }

    fn recompute_state(&mut self) {
        if self.failure.is_some() {
            self.state = "failed".to_string();
        } else if self.frontend_ipc.status != "ready" {
            self.state = "waiting-frontend-ipc".to_string();
        } else if self.bridge.status != "ready" {
            self.state = "starting-bridge".to_string();
        } else if self.route.status != "ready" {
            self.state = "starting-route".to_string();
        } else if self.provider.status != "ready" {
            self.state = "waiting-provider".to_string();
        } else {
            self.state = "ready".to_string();
        }
        self.updated_at_ms = now_ms();
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn readiness_path() -> Option<PathBuf> {
    std::env::var_os(READINESS_PATH_ENV)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn run_marker() -> String {
    std::env::var(RUN_MARKER_ENV).unwrap_or_default()
}

fn load_or_new(path: &Path) -> WatchModeReadiness {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .filter(|status: &WatchModeReadiness| {
            status.schema_version == SCHEMA_VERSION
                && status.run_marker == run_marker()
                && status.process_id == std::process::id()
        })
        .unwrap_or_else(|| WatchModeReadiness::new(run_marker()))
}

fn write_atomic(path: &Path, status: &WatchModeReadiness) -> Result<(), String> {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| format!("Watch readiness path has no file name: {}", path.display()))?;
    if let Some(parent) = path.parent().filter(|parent| !parent.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let temporary_path = path.with_file_name(format!(".{file_name}.{}.tmp", Uuid::new_v4().simple()));
    let result = (|| -> Result<(), String> {
        let json = serde_json::to_vec_pretty(status).map_err(|error| error.to_string())?;
        std::fs::write(&temporary_path, json).map_err(|error| error.to_string())?;
        if path.exists() {
            std::fs::remove_file(path).map_err(|error| error.to_string())?;
        }
        std::fs::rename(&temporary_path, path).map_err(|error| error.to_string())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary_path);
    }
    result
}

fn update(mutator: impl FnOnce(&mut WatchModeReadiness)) {
    let Some(path) = readiness_path() else {
        return;
    };
    let lock = WRITE_LOCK.get_or_init(|| Mutex::new(()));
    let Ok(_guard) = lock.lock() else {
        return;
    };
    let mut status = load_or_new(&path);
    mutator(&mut status);
    status.recompute_state();
    let _ = write_atomic(&path, &status);
}

pub(super) fn initialize() {
    let Some(path) = readiness_path() else {
        return;
    };
    let lock = WRITE_LOCK.get_or_init(|| Mutex::new(()));
    let Ok(_guard) = lock.lock() else {
        return;
    };
    let _ = write_atomic(&path, &WatchModeReadiness::new(run_marker()));
}

pub(super) fn mark_frontend_ipc_ready() {
    update(|status| status.frontend_ipc.set("ready", None));
}

pub(super) fn mark_bridge_ready() {
    update(|status| status.bridge.set("ready", None));
}

pub(super) fn mark_route_ready() {
    update(|status| status.route.set("ready", None));
}

pub(crate) fn mark_provider_ready() {
    update(|status| status.provider.set("ready", None));
}

pub(crate) fn fail(component: &str, code: &str, message: impl Into<String>) {
    let error = ReadinessError {
        code: code.to_string(),
        message: message.into(),
    };
    update(|status| {
        match component {
            "frontendIpc" => status.frontend_ipc.set("failed", Some(error.clone())),
            "provider" => status.provider.set("failed", Some(error.clone())),
            "bridge" => status.bridge.set("failed", Some(error.clone())),
            "route" => status.route.set("failed", Some(error.clone())),
            _ => {}
        }
        status.failure = Some(error);
    });
}

#[cfg(test)]
mod tests {
    use super::{WatchModeReadiness, SCHEMA_VERSION};

    #[test]
    fn readiness_requires_all_components_before_ready() {
        let mut status = WatchModeReadiness::new("run-1".to_string());
        status.frontend_ipc.set("ready", None);
        status.bridge.set("ready", None);
        status.route.set("ready", None);
        status.recompute_state();
        assert_eq!(status.state, "waiting-provider");
        status.provider.set("ready", None);
        status.recompute_state();
        assert_eq!(status.state, "ready");
        assert_eq!(status.schema_version, SCHEMA_VERSION);
    }

    #[test]
    fn readiness_failure_is_terminal() {
        let mut status = WatchModeReadiness::new("run-2".to_string());
        status.failure = Some(super::ReadinessError {
            code: "frontend.ipc.timeout".to_string(),
            message: "timeout".to_string(),
        });
        status.recompute_state();
        assert_eq!(status.state, "failed");
    }
}
