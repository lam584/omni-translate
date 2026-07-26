//! The decoupling seam between diagnostics and runtime.
//!
//! Before this module the two subsystems called each other concretely:
//! `append_diagnostics_log` rebuilt and emitted the runtime snapshot, and
//! `emit_runtime_notification` wrote into the diagnostics log store — a
//! compile-time cycle whose hazards (snapshot storms starving the WebView2
//! invoke channel during startup) were only held back by inline filters.
//!
//! Now each side only publishes a signal here and the *other* side decides
//! what to do with it. The composition root (`main.rs` setup) registers the
//! subscribers and the diagnostics snapshot provider, so the wiring exists in
//! exactly one place and either side works standalone (signals published with
//! no subscriber are dropped, mirroring the old `try_state` `None` branches).

use std::sync::{OnceLock, RwLock};

use super::contracts::DiagnosticsRuntimeSnapshot;

/// A diagnostics log line was recorded (native-origin, non-quiet path only —
/// frontend-forwarded lines never publish, preserving the invoke-channel fix).
pub struct DiagnosticsLogSignal<'a> {
    pub category: &'a str,
    pub level: &'a str,
}

/// A runtime notification was pushed and should be mirrored into the
/// diagnostics log with these exact fields.
pub struct RuntimeNotificationSignal<'a> {
    pub level: &'a str,
    pub source: &'a str,
    pub message: &'a str,
    pub emitted_at: &'a str,
}

type LogObserver = Box<dyn Fn(&DiagnosticsLogSignal<'_>) + Send + Sync>;
type NotificationObserver = Box<dyn Fn(&RuntimeNotificationSignal<'_>) + Send + Sync>;
type RefreshObserver = Box<dyn Fn() + Send + Sync>;
type SnapshotProvider = Box<dyn Fn() -> DiagnosticsRuntimeSnapshot + Send + Sync>;

/// Instance-scoped bus so tests can build private buses; production uses the
/// single process-global instance from [`global`].
#[derive(Default)]
pub struct SharedSignals {
    log_observers: RwLock<Vec<LogObserver>>,
    notification_observers: RwLock<Vec<NotificationObserver>>,
    refresh_observers: RwLock<Vec<RefreshObserver>>,
    diagnostics_snapshot_provider: RwLock<Option<SnapshotProvider>>,
}

impl SharedSignals {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn subscribe_diagnostics_log(&self, observer: impl Fn(&DiagnosticsLogSignal<'_>) + Send + Sync + 'static) {
        self.log_observers.write().expect("log observers poisoned").push(Box::new(observer));
    }

    pub fn publish_diagnostics_log(&self, category: &str, level: &str) {
        let signal = DiagnosticsLogSignal { category, level };
        for observer in self.log_observers.read().expect("log observers poisoned").iter() {
            observer(&signal);
        }
    }

    pub fn subscribe_runtime_notification(
        &self,
        observer: impl Fn(&RuntimeNotificationSignal<'_>) + Send + Sync + 'static,
    ) {
        self.notification_observers
            .write()
            .expect("notification observers poisoned")
            .push(Box::new(observer));
    }

    pub fn publish_runtime_notification(&self, signal: &RuntimeNotificationSignal<'_>) {
        for observer in self
            .notification_observers
            .read()
            .expect("notification observers poisoned")
            .iter()
        {
            observer(signal);
        }
    }

    /// Diagnostics-visible state changed without a log line (e.g. a model
    /// trace update); the runtime subscriber refreshes the snapshot.
    pub fn subscribe_runtime_snapshot_refresh(&self, observer: impl Fn() + Send + Sync + 'static) {
        self.refresh_observers
            .write()
            .expect("refresh observers poisoned")
            .push(Box::new(observer));
    }

    pub fn request_runtime_snapshot_refresh(&self) {
        for observer in self.refresh_observers.read().expect("refresh observers poisoned").iter() {
            observer();
        }
    }

    /// Register the diagnostics section provider used when the runtime
    /// aggregate snapshot is built. Last registration wins.
    pub fn set_diagnostics_snapshot_provider(
        &self,
        provider: impl Fn() -> DiagnosticsRuntimeSnapshot + Send + Sync + 'static,
    ) {
        *self
            .diagnostics_snapshot_provider
            .write()
            .expect("snapshot provider poisoned") = Some(Box::new(provider));
    }

    /// The current diagnostics section, or the preview baseline when no
    /// provider is registered (mirrors the old `try_state` `None` fallback).
    pub fn diagnostics_snapshot(&self) -> DiagnosticsRuntimeSnapshot {
        match self
            .diagnostics_snapshot_provider
            .read()
            .expect("snapshot provider poisoned")
            .as_ref()
        {
            Some(provider) => provider(),
            None => DiagnosticsRuntimeSnapshot::preview(),
        }
    }
}

/// The process-global bus production code publishes to and `main.rs`
/// subscribes on.
pub fn global() -> &'static SharedSignals {
    static GLOBAL: OnceLock<SharedSignals> = OnceLock::new();
    GLOBAL.get_or_init(SharedSignals::new)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    use super::*;

    #[test]
    fn log_signals_reach_every_subscriber_with_category_and_level() {
        let signals = SharedSignals::new();
        let seen = Arc::new(Mutex::new(Vec::new()));
        for _ in 0..2 {
            let seen = Arc::clone(&seen);
            signals.subscribe_diagnostics_log(move |signal| {
                seen.lock().unwrap().push((signal.category.to_string(), signal.level.to_string()));
            });
        }

        signals.publish_diagnostics_log("runtime", "info");

        assert_eq!(
            *seen.lock().unwrap(),
            vec![("runtime".to_string(), "info".to_string()); 2]
        );
    }

    #[test]
    fn publishing_without_subscribers_is_a_silent_no_op() {
        let signals = SharedSignals::new();
        signals.publish_diagnostics_log("audio", "debug");
        signals.publish_runtime_notification(&RuntimeNotificationSignal {
            level: "info",
            source: "runtime-tests",
            message: "dropped",
            emitted_at: "unix:0",
        });
    }

    #[test]
    fn notification_signals_carry_the_exact_log_mirror_fields() {
        let signals = SharedSignals::new();
        let seen = Arc::new(Mutex::new(Vec::new()));
        {
            let seen = Arc::clone(&seen);
            signals.subscribe_runtime_notification(move |signal| {
                seen.lock().unwrap().push((
                    signal.level.to_string(),
                    signal.source.to_string(),
                    signal.message.to_string(),
                    signal.emitted_at.to_string(),
                ));
            });
        }

        signals.publish_runtime_notification(&RuntimeNotificationSignal {
            level: "warning",
            source: "rust-core",
            message: "bridge degraded",
            emitted_at: "unix:1778883200",
        });

        assert_eq!(
            *seen.lock().unwrap(),
            vec![(
                "warning".to_string(),
                "rust-core".to_string(),
                "bridge degraded".to_string(),
                "unix:1778883200".to_string()
            )]
        );
    }

    #[test]
    fn diagnostics_snapshot_defaults_to_preview_until_a_provider_registers() {
        let signals = SharedSignals::new();
        assert_eq!(signals.diagnostics_snapshot().status, "preview");

        let calls = Arc::new(AtomicUsize::new(0));
        {
            let calls = Arc::clone(&calls);
            signals.set_diagnostics_snapshot_provider(move || {
                calls.fetch_add(1, Ordering::SeqCst);
                let mut snapshot = DiagnosticsRuntimeSnapshot::preview();
                snapshot.status = "ready".to_string();
                snapshot
            });
        }

        assert_eq!(signals.diagnostics_snapshot().status, "ready");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}
