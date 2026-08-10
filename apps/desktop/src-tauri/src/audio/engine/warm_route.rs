use std::collections::HashMap;
use std::sync::Mutex;

/// Control message sent to a parked warm-route thread. The device stays open and
/// idle until one of these arrives.
enum WarmControl {
    /// Transition the pre-opened device into the live capture loop.
    Activate {
        spec: RouteSpec,
        stt_sender: Option<mpsc::Sender<Vec<u8>>>,
        stop_rx: mpsc::Receiver<()>,
    },
    /// Release the pre-opened device without ever capturing.
    Cancel,
}

/// A single pre-warmed capture direction. The WASAPI COM handles live on the
/// warm thread (thread affinity); this slot only holds the control channel plus
/// enough metadata to decide whether an incoming `start_route` can reuse it.
struct WarmRouteSlot {
    control_tx: mpsc::Sender<WarmControl>,
    requested_device_id: String,
    ready: Arc<AtomicBool>,
    join_handle: thread::JoinHandle<()>,
}

impl WarmRouteSlot {
    /// A slot is usable for activation only when it targets the same device,
    /// finished initializing, and its thread is still parked (not exited).
    fn matches(&self, requested_device_id: &str) -> bool {
        self.requested_device_id == requested_device_id
            && self.ready.load(Ordering::Relaxed)
            && !self.join_handle.is_finished()
    }
}

/// Pre-opens capture devices during idle time so a later `start_route` only has
/// to `start_stream` instead of paying the full device-open cost. Watch mode and
/// conversation mode share this one warmer; they differ only in which directions
/// they activate.
pub(crate) struct CaptureRouteWarmer {
    slots: Mutex<HashMap<String, WarmRouteSlot>>,
}

impl CaptureRouteWarmer {
    pub(crate) fn new() -> Self {
        Self {
            slots: Mutex::new(HashMap::new()),
        }
    }

    /// Best-effort pre-open of `direction`'s WASAPI device. Idempotent for the
    /// same device; a stale slot targeting a different device is cancelled first.
    /// virtual-driver inbound is skipped because it flows through the Bridge pipe
    /// rather than a WASAPI device.
    pub(crate) fn prewarm(&self, app: &AppHandle, direction: &str, config: &Value) {
        let spec = match RouteSpec::from_config(config, direction) {
            Ok(spec) => spec,
            Err(error) => {
                diag_log_detail(
                    app,
                    "audio",
                    "debug",
                    "预热跳过：路由配置解析失败。",
                    format!("direction={direction} error={error}"),
                );
                return;
            }
        };
        if let Err(error) = spec.ensure_feedback_backend_available() {
            diag_log_detail(
                app,
                "audio",
                "debug",
                "预热跳过：音频反馈后端不可用。",
                format!("direction={direction} error={error}"),
            );
            return;
        }
        if spec.uses_bridge_source() {
            return;
        }
        let requested_device_id = spec.requested_device_id.clone();

        if let Ok(slots) = self.slots.lock() {
            if let Some(slot) = slots.get(direction) {
                if slot.requested_device_id == requested_device_id
                    && !slot.join_handle.is_finished()
                {
                    // Already warming or parked for this device: nothing to do.
                    return;
                }
            }
        }
        // Any existing slot targets a different device (or its thread exited);
        // drop it before opening the new one so we never hold two devices.
        self.cancel(direction);

        let (control_tx, control_rx) = mpsc::channel();
        let ready = Arc::new(AtomicBool::new(false));
        let ready_for_thread = ready.clone();
        let app_handle = app.clone();
        let warm_direction = direction.to_string();
        let warm_spec = spec.clone();
        let join_handle = match thread::Builder::new()
            .name(format!("audio-warm-{direction}"))
            .spawn(move || {
                warm_route_thread(
                    app_handle,
                    &warm_direction,
                    warm_spec,
                    control_rx,
                    ready_for_thread,
                );
            }) {
            Ok(handle) => handle,
            Err(error) => {
                diag_log_detail(
                    app,
                    "audio",
                    "warning",
                    "预热线程创建失败。",
                    format!("direction={direction} error={error}"),
                );
                return;
            }
        };

        if let Ok(mut slots) = self.slots.lock() {
            slots.insert(
                direction.to_string(),
                WarmRouteSlot {
                    control_tx,
                    requested_device_id,
                    ready,
                    join_handle,
                },
            );
        }
    }

    /// Attempt to reuse a parked route for `direction`.
    ///
    /// On a match the warm thread transitions into the live capture loop and a
    /// ready-to-register [`AudioRouteHandle`] is returned. On a miss the
    /// `stt_sender` is handed back (via `Err`) so the caller can cold start
    /// without losing it.
    pub(crate) fn try_activate(
        &self,
        direction: &str,
        spec: &RouteSpec,
        stt_sender: Option<mpsc::Sender<Vec<u8>>>,
    ) -> Result<AudioRouteHandle, Option<mpsc::Sender<Vec<u8>>>> {
        if spec.uses_bridge_source() {
            return Err(stt_sender);
        }

        let slot = {
            let mut slots = match self.slots.lock() {
                Ok(slots) => slots,
                Err(_) => return Err(stt_sender),
            };
            match slots.get(direction) {
                Some(slot) if slot.matches(&spec.requested_device_id) => {
                    slots.remove(direction).expect("slot present")
                }
                _ => return Err(stt_sender),
            }
        };

        let (stop_tx, stop_rx) = mpsc::channel();
        match slot.control_tx.send(WarmControl::Activate {
            spec: spec.clone(),
            stt_sender,
            stop_rx,
        }) {
            Ok(()) => Ok(AudioRouteHandle {
                stop_tx,
                join_handle: slot.join_handle,
            }),
            // The warm thread exited between the readiness check and the send;
            // recover the sender from the failed message so cold start keeps STT.
            Err(mpsc::SendError(WarmControl::Activate { stt_sender, .. })) => Err(stt_sender),
            Err(_) => Err(None),
        }
    }

    /// Release the parked device for `direction`, if any, and wait for its thread
    /// to unwind so the COM handles are dropped on their owning thread.
    pub(crate) fn cancel(&self, direction: &str) {
        let slot = match self.slots.lock() {
            Ok(mut slots) => slots.remove(direction),
            Err(_) => None,
        };
        if let Some(slot) = slot {
            let _ = slot.control_tx.send(WarmControl::Cancel);
            let _ = slot.join_handle.join();
        }
    }

    /// Release every parked device (used on shutdown / full reconfiguration).
    #[allow(dead_code, reason = "invoked by lifecycle teardown and future config resets")]
    pub(crate) fn cancel_all(&self) {
        let directions: Vec<String> = match self.slots.lock() {
            Ok(slots) => slots.keys().cloned().collect(),
            Err(_) => return,
        };
        for direction in directions {
            self.cancel(&direction);
        }
    }

    /// Whether `direction` is currently parked and ready for `requested_device_id`.
    #[allow(dead_code, reason = "used by tests and diagnostics")]
    pub(crate) fn is_parked_for(&self, direction: &str, requested_device_id: &str) -> bool {
        self.slots
            .lock()
            .map(|slots| {
                slots
                    .get(direction)
                    .map(|slot| slot.matches(requested_device_id))
                    .unwrap_or(false)
            })
            .unwrap_or(false)
    }
}

impl Default for CaptureRouteWarmer {
    fn default() -> Self {
        Self::new()
    }
}

/// Body of an `audio-warm-{direction}` thread: open the device, park until told
/// to activate, then hand off to the shared capture loop on this same thread so
/// the WASAPI COM handles never cross a thread boundary.
fn warm_route_thread(
    app: AppHandle,
    direction: &str,
    spec: RouteSpec,
    control_rx: mpsc::Receiver<WarmControl>,
    ready: Arc<AtomicBool>,
) {
    let _ = initialize_mta().ok();
    let initialized = match initialize_capture_route(&app, direction, &spec) {
        Ok(initialized) => initialized,
        Err(error) => {
            diag_log_detail(
                &app,
                "audio",
                "warning",
                "预热初始化失败，将回退到点击时冷启动。",
                format!("direction={direction} error={error}"),
            );
            return;
        }
    };
    diag_log_detail(
        &app,
        "audio",
        "info",
        format!(
            "已预热 {} 采集设备（已打开、未采集，耗时 {:.1}s）。",
            direction,
            initialized.init_elapsed.as_secs_f64(),
        ),
        format!(
            "direction={} device={}",
            direction, initialized.effective_device_id
        ),
    );
    ready.store(true, Ordering::Relaxed);

    // Park until activation or cancellation. A disconnected channel means the
    // slot was dropped without an explicit cancel, so release the device.
    match control_rx.recv() {
        Ok(WarmControl::Activate {
            spec: activate_spec,
            stt_sender,
            stop_rx,
        }) => {
            let store = app.state::<AudioStateStore>();
            if let Err(error) = run_capture_loop(
                app.clone(),
                &store,
                direction,
                activate_spec,
                initialized,
                stop_rx,
                stt_sender,
            ) {
                let (message, error_code, recommended_action) =
                    crate::audio::omni::session_errors::split_error_markers(&error);
                notify_route_worker_error(&app, direction, &message, error_code.as_deref());
                store.mark_route_error(direction, message, error_code, recommended_action);
                let _ = emit_audio_snapshot(&app, &store);
            }
        }
        Ok(WarmControl::Cancel) | Err(_) => {
            // `initialized` drops here, releasing the device on its owning thread.
            diag_log_detail(
                &app,
                "audio",
                "debug",
                "预热设备已释放（未激活）。",
                format!("direction={direction}"),
            );
        }
    }
}

#[cfg(test)]
mod warm_route_tests {
    use super::*;
    use serde_json::json;

    /// Builds a slot whose thread parks on the control channel (like a real
    /// warmed route) without touching WASAPI, so activation/matching logic can
    /// be exercised in a unit test.
    fn spawn_parked_slot(requested_device_id: &str, ready: bool) -> WarmRouteSlot {
        let (control_tx, control_rx) = mpsc::channel::<WarmControl>();
        let join_handle = thread::spawn(move || {
            let _ = control_rx.recv();
        });
        WarmRouteSlot {
            control_tx,
            requested_device_id: requested_device_id.to_string(),
            ready: Arc::new(AtomicBool::new(ready)),
            join_handle,
        }
    }

    fn inbound_spec(device_id: &str) -> RouteSpec {
        let config = json!({ "devices": { "inboundRoute": { "input": { "deviceId": device_id } } } });
        RouteSpec::from_config(&config, "inbound").expect("spec")
    }

    #[test]
    fn try_activate_returns_handle_on_device_match() {
        let warmer = CaptureRouteWarmer::new();
        warmer
            .slots
            .lock()
            .unwrap()
            .insert("inbound".to_string(), spawn_parked_slot("dev-1", true));

        let result = warmer.try_activate("inbound", &inbound_spec("dev-1"), None);

        assert!(result.is_ok(), "matching device should activate");
        assert!(
            warmer.slots.lock().unwrap().get("inbound").is_none(),
            "activated slot must be removed from the warmer"
        );
        let _ = result.unwrap().join_handle.join();
    }

    #[test]
    fn try_activate_hands_sender_back_on_device_mismatch() {
        let warmer = CaptureRouteWarmer::new();
        warmer
            .slots
            .lock()
            .unwrap()
            .insert("inbound".to_string(), spawn_parked_slot("dev-1", true));
        let (tx, _rx) = mpsc::channel::<Vec<u8>>();

        let result = warmer.try_activate("inbound", &inbound_spec("dev-2"), Some(tx));

        assert!(matches!(result, Err(Some(_))), "sender must return for cold start");
        assert!(
            warmer.slots.lock().unwrap().get("inbound").is_some(),
            "mismatched slot must stay parked"
        );
        warmer.cancel("inbound");
    }

    #[test]
    fn try_activate_skips_slot_that_is_not_ready() {
        let warmer = CaptureRouteWarmer::new();
        warmer
            .slots
            .lock()
            .unwrap()
            .insert("inbound".to_string(), spawn_parked_slot("dev-1", false));
        let (tx, _rx) = mpsc::channel::<Vec<u8>>();

        let result = warmer.try_activate("inbound", &inbound_spec("dev-1"), Some(tx));

        assert!(matches!(result, Err(Some(_))), "not-yet-ready slot must not activate");
        warmer.cancel("inbound");
    }

    #[test]
    fn try_activate_skips_virtual_driver_inbound() {
        let warmer = CaptureRouteWarmer::new();
        let config = json!({
            "devices": { "feedbackLoopPrevention": "virtual-driver", "virtualRenderDeviceId": "vrd" }
        });
        let spec = RouteSpec::from_config(&config, "inbound").expect("spec");
        let (tx, _rx) = mpsc::channel::<Vec<u8>>();

        let result = warmer.try_activate("inbound", &spec, Some(tx));

        assert!(matches!(result, Err(Some(_))), "virtual-driver inbound is never pre-warmed");
    }

    #[test]
    fn is_parked_for_matches_device_and_readiness() {
        let warmer = CaptureRouteWarmer::new();
        warmer
            .slots
            .lock()
            .unwrap()
            .insert("outbound".to_string(), spawn_parked_slot("mic-1", true));

        assert!(warmer.is_parked_for("outbound", "mic-1"));
        assert!(!warmer.is_parked_for("outbound", "mic-2"));
        assert!(!warmer.is_parked_for("inbound", "mic-1"));
        warmer.cancel("outbound");
    }

    #[test]
    fn cancel_removes_slot() {
        let warmer = CaptureRouteWarmer::new();
        warmer
            .slots
            .lock()
            .unwrap()
            .insert("inbound".to_string(), spawn_parked_slot("dev-1", true));

        warmer.cancel("inbound");

        assert!(warmer.slots.lock().unwrap().get("inbound").is_none());
        assert!(!warmer.is_parked_for("inbound", "dev-1"));
    }
}
