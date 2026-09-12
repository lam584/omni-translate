use super::*;

pub(super) struct PreparedLiveTranslateBenchmarkPlan {
    authority: crate::provider::model_protocol_profile::AuthorizedModelProtocolProfile,
    server_state: crate::audio::bailian_protocol::LiveTranslateServerState,
    session_update: Value,
    audio_appends: Vec<Value>,
    manual_commit: Option<Value>,
    session_finish: Option<Value>,
}

struct LiveTranslateClientPlanValues {
    session_update: Value,
    audio_appends: Vec<Value>,
    manual_commit: Option<Value>,
    session_finish: Value,
}

#[cfg(test)]
pub(super) fn prepare_livetranslate_benchmark_plan(
    config: &BenchmarkConfig,
    samples: &[i16],
) -> Result<PreparedLiveTranslateBenchmarkPlan, String> {
    prepare_livetranslate_benchmark_plan_inner(config, samples, |_| {})
}

pub(super) fn with_prepared_livetranslate_plan<T>(
    config: &BenchmarkConfig,
    samples: &[i16],
    connect: impl FnOnce() -> Result<T, String>,
) -> Result<(PreparedLiveTranslateBenchmarkPlan, T), String> {
    with_prepared_livetranslate_plan_inner(config, samples, |_| {}, connect)
}

fn with_prepared_livetranslate_plan_inner<T>(
    config: &BenchmarkConfig,
    samples: &[i16],
    mutate: impl FnOnce(&mut LiveTranslateClientPlanValues),
    connect: impl FnOnce() -> Result<T, String>,
) -> Result<(PreparedLiveTranslateBenchmarkPlan, T), String> {
    let plan = prepare_livetranslate_benchmark_plan_inner(config, samples, mutate)?;
    let connected = connect()?;
    Ok((plan, connected))
}

fn prepare_livetranslate_benchmark_plan_inner(
    config: &BenchmarkConfig,
    samples: &[i16],
    mutate: impl FnOnce(&mut LiveTranslateClientPlanValues),
) -> Result<PreparedLiveTranslateBenchmarkPlan, String> {
    let authority = config.model_protocol_authority.clone().ok_or_else(|| {
        "model_protocol.authorization_identity_mismatch: DashScope benchmark has no invocation authority"
            .to_string()
    })?;
    if config.provider_kind != "dashscope"
        || authority.exact_model_id != config.model
        || authority.operation != "native_translate"
        || authority.transport != "websocket"
    {
        return Err(
            "model_protocol.authorization_identity_mismatch: LiveTranslate client plan does not match the benchmark invocation"
                .to_string(),
        );
    }
    if authority.adapter_id != crate::audio::bailian_protocol::LIVETRANSLATE_ADAPTER_ID
        || authority.wire_dialect != crate::audio::bailian_protocol::LIVETRANSLATE_DIALECT_ID
        || authority.terminal_lifecycle != "session.finish->session.finished"
        || config.protocol_dialect
            != Some(crate::audio::events::RealtimeProtocol::DashscopeLivetranslate)
    {
        return Err(format!(
            "model_protocol.adapter_unavailable: benchmark requires the enabled typed LiveTranslate adapter (adapterId={} wireDialect={} terminalLifecycle={})",
            authority.adapter_id, authority.wire_dialect, authority.terminal_lifecycle
        ));
    }

    let audio_appends = samples
        .chunks(CHUNK_SAMPLES)
        .map(|chunk| {
            crate::audio::omni::build_dashscope_audio_append(&base64_encode_i16(chunk))
        })
        .collect();
    let mut values = LiveTranslateClientPlanValues {
        session_update: build_session_update(config),
        audio_appends,
        manual_commit: (config.audio_mode == RealtimeAudioMode::Manual)
            .then(crate::audio::omni::build_dashscope_input_audio_commit),
        session_finish: json!({
            "event_id": format!("benchmark_session_finish_{}", samples.chunks(CHUNK_SAMPLES).count()),
            "type": "session.finish"
        }),
    };
    mutate(&mut values);

    let mut server_state = crate::audio::bailian_protocol::LiveTranslateServerState::default();
    server_state.record_client_session_update(&authority, &values.session_update)?;
    for event in &values.audio_appends {
        crate::audio::bailian_protocol::admit_livetranslate_client_event(&authority, event)?;
    }
    if let Some(event) = values.manual_commit.as_ref() {
        crate::audio::bailian_protocol::admit_livetranslate_client_event(&authority, event)?;
    }
    crate::audio::bailian_protocol::admit_livetranslate_client_event(
        &authority,
        &values.session_finish,
    )?;

    Ok(PreparedLiveTranslateBenchmarkPlan {
        authority,
        server_state,
        session_update: values.session_update,
        audio_appends: values.audio_appends,
        manual_commit: values.manual_commit,
        session_finish: Some(values.session_finish),
    })
}

impl PreparedLiveTranslateBenchmarkPlan {
    pub(super) fn session_update(&self) -> &Value {
        &self.session_update
    }

    pub(super) fn audio_append(&self, index: usize) -> Result<&Value, String> {
        self.audio_appends.get(index).ok_or_else(|| {
            format!(
                "model_protocol.event_order_invalid: no admitted LiveTranslate audio append for chunk {index}"
            )
        })
    }

    pub(super) fn manual_commit(&self) -> Option<&Value> {
        self.manual_commit.as_ref()
    }

    pub(super) fn take_session_finish(&mut self) -> Result<Value, String> {
    if self.session_finish.is_none() {
            return Err(
                "model_protocol.event_order_invalid: LiveTranslate session.finish was already consumed"
                    .to_string(),
            );
        }
        self.server_state.record_client_finish()?;
        Ok(self
            .session_finish
            .take()
            .expect("session.finish presence was checked before state transition"))
    }

    pub(super) fn admit_server_event(
        &mut self,
        event: &Value,
    ) -> Result<crate::audio::bailian_protocol::LiveTranslateServerMutation, String> {
        self.server_state.admit(&self.authority, event)
    }

    pub(super) fn wait_until_ready(
        &mut self,
        socket: &mut WebSocket<MaybeTlsStream<TcpStream>>,
    ) -> Result<(), String> {
        let deadline = Instant::now() + Duration::from_secs(SESSION_READY_TIMEOUT_SECS);
        while Instant::now() < deadline {
            match socket.read() {
                Ok(Message::Text(text)) => {
                    let event: Value = serde_json::from_str(&text).map_err(|error| {
                        format!("LiveTranslate JSON error during setup: {error}")
                    })?;
                    let mutation = self.admit_server_event(&event)?;
                    if crate::audio::realtime_ws::server_event_type(&event, "") == "error" {
                        return Err(format!(
                            "provider-error: LiveTranslate setup error: {}",
                            event.get("error").unwrap_or(&Value::Null)
                        ));
                    }
                    if mutation.session_updated.is_some() {
                        return Ok(());
                    }
                }
                Ok(Message::Binary(_)) => {
                    return Err(
                        "unexpected_event: model_protocol.frame_kind_mismatch LiveTranslate setup received binary data"
                            .to_string(),
                    );
                }
                Ok(Message::Close(_)) => {
                    return Err(
                        "LiveTranslate server closed before the exact session.updated echo"
                            .to_string(),
                    );
                }
                Err(error) if is_timeout(&error.to_string()) => continue,
                Err(error) => {
                    return Err(format!("LiveTranslate read error during setup: {error}"));
                }
                _ => {}
            }
        }
        Err("timed out waiting for exact LiveTranslate session.updated echo".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;

    fn config() -> BenchmarkConfig {
        BenchmarkConfig {
            api_key: "unused-test-key".to_string(),
            mp3_path: PathBuf::from("unused-test-audio.pcm"),
            model: "qwen3.5-livetranslate-flash-realtime".to_string(),
            audio_mode: RealtimeAudioMode::ServerVad,
            interaction_capabilities: vec!["auto_vad".to_string()],
            provider_kind: "dashscope".to_string(),
            base_url: "ws://127.0.0.1".to_string(),
            auth_header_name: "Authorization".to_string(),
            auth_scheme: "bearer".to_string(),
            voice: "Ethan".to_string(),
            target_language: "zh".to_string(),
            protocol_dialect: Some(
                crate::audio::events::RealtimeProtocol::DashscopeLivetranslate,
            ),
            model_protocol_authority: Some(
                crate::audio::bailian_protocol::livetranslate_test_authority(),
            ),
        }
    }

    #[test]
    fn malformed_session_builder_is_rejected_before_loopback_accept() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener should bind");
        listener
            .set_nonblocking(true)
            .expect("listener should be nonblocking");
        let address = listener.local_addr().expect("listener address");
        let accepts = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let accepts_for_server = Arc::clone(&accepts);
        let stop_for_server = Arc::clone(&stop);
        let server = thread::spawn(move || {
            while !stop_for_server.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        accepts_for_server.fetch_add(1, Ordering::SeqCst);
                        drop(stream);
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2));
                    }
                    Err(error) => panic!("loopback accept failed: {error}"),
                }
            }
        });

        let connect_invoked = AtomicBool::new(false);
        let error = with_prepared_livetranslate_plan_inner(
            &config(),
            &[1_i16; CHUNK_SAMPLES],
            |values| values.session_update["session"]["instructions"] = json!("Omni-only"),
            || {
                connect_invoked.store(true, Ordering::SeqCst);
                TcpStream::connect(address)
                    .map(|_| ())
                    .map_err(|error| error.to_string())
            },
        )
        .err()
        .expect("malformed complete client plan must fail before connect");
        stop.store(true, Ordering::SeqCst);
        server.join().expect("loopback server should stop");

        assert!(error.contains("unsupported field instructions"), "{error}");
        assert!(!connect_invoked.load(Ordering::SeqCst));
        assert_eq!(accepts.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn valid_plan_reaches_the_same_loopback_connection_boundary() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener should bind");
        let address = listener.local_addr().expect("listener address");
        let accepted = Arc::new(AtomicUsize::new(0));
        let accepted_for_server = Arc::clone(&accepted);
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().expect("valid plan should connect");
            accepted_for_server.fetch_add(1, Ordering::SeqCst);
            drop(stream);
        });

        let (_plan, ()) = with_prepared_livetranslate_plan(
            &config(),
            &[1_i16; CHUNK_SAMPLES],
            || {
                TcpStream::connect(address)
                    .map(|_| ())
                    .map_err(|error| error.to_string())
            },
        )
        .expect("valid plan should cross the pre-connect boundary");
        server.join().expect("loopback server should stop");
        assert_eq!(accepted.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn complete_client_plan_admits_every_value_and_preserves_finish_on_failed_transition() {
        let mut plan = prepare_livetranslate_benchmark_plan(
            &config(),
            &[1_i16; CHUNK_SAMPLES * 2],
        )
        .expect("valid production builders should form one typed plan");
        assert_eq!(plan.audio_appends.len(), 2);
        assert!(plan.manual_commit.is_none());
        assert!(plan.take_session_finish().is_err(), "finish requires an active session");
        assert!(plan.session_finish.is_some(), "failed transition must not consume finish");
    }

    #[test]
    fn manual_plan_admits_commit_and_never_constructs_omni_response_create() {
        let mut manual = config();
        manual.audio_mode = RealtimeAudioMode::Manual;
        let plan = prepare_livetranslate_benchmark_plan(
            &manual,
            &[1_i16; CHUNK_SAMPLES],
        )
        .expect("manual LiveTranslate plan should admit its explicit commit");
        assert_eq!(
            plan.manual_commit()
                .and_then(|event| event.get("type"))
                .and_then(Value::as_str),
            Some("input_audio_buffer.commit")
        );
        assert!(crate::audio::omni::build_dashscope_response_create_for_protocol(
            crate::audio::events::RealtimeProtocol::DashscopeLivetranslate,
        )
        .is_none());
    }
}
