/// Owns a single capture route's lifecycle dependencies.
///
/// Keeping the channel, route specification and UI handle together prevents
/// the thread launcher from becoming a second orchestration implementation.
struct RouteWorker {
    app: AppHandle,
    direction: String,
    spec: RouteSpec,
    stop_rx: mpsc::Receiver<()>,
    input_completion_rx: Option<mpsc::Receiver<RouteInputCompletionRequest>>,
    stt_sender: Option<mpsc::Sender<Vec<u8>>>,
    init_done: Option<Arc<AtomicBool>>,
    native_capture_start: Option<NativeCaptureStartAck>,
    bridge_source_context: Option<BridgeSourceWorkerContext>,
}

impl RouteWorker {
    fn run(self, store: &AudioStateStore) -> Result<(), String> {
        run_route_worker(
            self.app,
            store,
            &self.direction,
            self.spec,
            self.stop_rx,
            self.input_completion_rx,
            self.stt_sender,
            self.init_done,
            self.native_capture_start,
            self.bridge_source_context,
        )
    }
}
