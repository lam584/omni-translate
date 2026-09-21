use super::*;

const BENCHMARK_CONNECT_MAX_ATTEMPTS: usize = 4;
const BENCHMARK_CONNECT_INITIAL_BACKOFF_MS: u64 = 250;

pub(super) fn authorize_bailian_model_operation_for_benchmark_invocation(
    model: &str,
    requested_provider_kind: &str,
    provider: Option<&crate::provider::contracts::ProviderDraftInput>,
    base_url: Option<&str>,
    auth_header_name: Option<&str>,
    auth_scheme: Option<&str>,
) -> Result<
    Option<crate::provider::model_protocol_profile::AuthorizedModelProtocolProfile>,
    String,
> {
    // Recheck on the worker as well, before the optional provider draft branch.
    crate::watch_mode_diagnostic::local_aec_probe::ensure_provider_work_allowed()?;
    let inspected_profiles =
        crate::provider::model_protocol_profile::lookup_model_protocol_profiles_for_inspection(
            model,
        )
        .map_err(|error| {
            format!(
                "{}: unable to inspect benchmark model protocol authority",
                error.code()
            )
        })?;
    if provider.is_none()
        && (requested_provider_kind == "dashscope" || !inspected_profiles.is_empty())
    {
        return Err(
            "model_protocol.authorization_identity_mismatch: Bailian benchmark requires the complete provider draft before audio decode or connect"
                .to_string(),
        );
    }
    let authority = provider
        .map(|provider| {
            crate::provider::gateway::authorize_bailian_model_operation_before_provider_access(
                provider,
                model,
                "native_translate",
            )
            .map_err(|error| error.message)
        })
        .transpose()?
        .flatten();
    if requested_provider_kind == "dashscope" && authority.is_none() {
        return Err(
            "model_protocol.authorization_identity_mismatch: DashScope benchmark has no invocation authority"
                .to_string(),
        );
    }
    if authority.is_some() {
        let provider = provider.expect("authorized benchmark authority requires a provider draft");
        if requested_provider_kind != provider.kind
            || provider.transport != "websocket"
            || base_url.is_some_and(|value| value.trim() != provider.base_url.trim())
            || auth_header_name
                .is_some_and(|value| value.trim() != provider.auth_ref.header_name.trim())
            || auth_scheme.is_some_and(|value| {
                !value.trim().eq_ignore_ascii_case(provider.auth_ref.scheme.trim())
            })
        {
            return Err(
                "model_protocol.authorization_identity_mismatch: Bailian benchmark overrides do not match the supplied provider authority"
                    .to_string(),
            );
        }
    }
    Ok(authority)
}

fn benchmark_requires_model_protocol_authority(config: &BenchmarkConfig) -> Result<bool, String> {
    let profiles =
        crate::provider::model_protocol_profile::lookup_model_protocol_profiles_for_inspection(
            &config.model,
        )
        .map_err(|error| {
            format!(
                "{}: unable to inspect benchmark connector authority",
                error.code()
            )
        })?;
    Ok(!profiles.is_empty()
        || config.provider_kind == "dashscope"
        || matches!(
            config.protocol_dialect,
            Some(
                crate::audio::events::RealtimeProtocol::DashscopeOmni
                    | crate::audio::events::RealtimeProtocol::DashscopeLivetranslate
                    | crate::audio::events::RealtimeProtocol::DashscopeAsr
            )
        ))
}

fn validate_benchmark_connection_authority(
    config: &BenchmarkConfig,
    request: &tungstenite::handshake::client::Request,
) -> Result<(), String> {
    if !benchmark_requires_model_protocol_authority(config)? {
        return Ok(());
    }
    let authority = config.model_protocol_authority.as_ref().ok_or_else(|| {
        "model_protocol.authorization_identity_mismatch: benchmark connector has no Bailian invocation authority"
            .to_string()
    })?;
    if config.provider_kind != "dashscope"
        || authority.exact_model_id != config.model
        || authority.operation != "native_translate"
        || authority.transport != "websocket"
    {
        return Err(
            "model_protocol.authorization_identity_mismatch: benchmark connector invocation does not match its Bailian authority"
                .to_string(),
        );
    }
    let request_url = Url::parse(&request.uri().to_string()).map_err(|error| {
        format!(
            "model_protocol.endpoint_family_mismatch: benchmark WebSocket URL is invalid: {error}"
        )
    })?;
    let request_host = request_url
        .host_str()
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| {
            "model_protocol.endpoint_host_required: benchmark WebSocket URL has no host"
                .to_string()
        })?;
    if request_host != authority.endpoint_host || request_url.path() != authority.endpoint_path {
        return Err(format!(
            "model_protocol.endpoint_family_mismatch: benchmark connector endpoint '{}{}' does not match authorized '{}{}'",
            request_host,
            request_url.path(),
            authority.endpoint_host,
            authority.endpoint_path
        ));
    }
    Ok(())
}

/// A benchmark is an explicit connectivity probe, but a single TCP attempt is
/// too brittle on Windows when a VPN/TUN adapter has just changed routes. Keep
/// retries bounded so a genuinely unavailable endpoint still fails quickly.
pub(super) fn connect_benchmark_websocket(
    config: &BenchmarkConfig,
    policy: BenchmarkExecutionPolicy,
    request: tungstenite::handshake::client::Request,
    error_context: &str,
) -> Result<
    (
        WebSocket<MaybeTlsStream<TcpStream>>,
        tungstenite::handshake::client::Response,
    ),
    String,
> {
    validate_benchmark_connection_authority(config, &request)?;
    // Authority is checked against the original production request in all modes.
    // The loopback transport exists only in tests, cannot be selected by live config,
    // and does not rewrite the authorized URI, Host, model, or protocol profile.
    match policy {
        BenchmarkExecutionPolicy::Production => {}
        #[cfg(test)]
        BenchmarkExecutionPolicy::Bounded { loopback } => {
            return if let Some(address) = loopback {
                if !address.ip().is_loopback() {
                    return Err("bounded fixture transport must be loopback".to_string());
                }
                let stream = TcpStream::connect_timeout(&address, Duration::from_secs(2))
                    .map_err(|_| format!("{error_context}: bounded fixture TCP connect failed"))?;
                stream.set_read_timeout(Some(Duration::from_secs(2))).map_err(|e| e.to_string())?;
                stream.set_write_timeout(Some(Duration::from_secs(2))).map_err(|e| e.to_string())?;
                tungstenite::client(request, MaybeTlsStream::Plain(stream))
                    .map_err(|e| format!("{error_context}: single attempt: {e}"))
            } else {
                tungstenite::client::connect_with_config(request, None, 0)
                    .map_err(|e| format!("{error_context}: single attempt: {e}"))
            };
        }
    }
    let mut last_error = None;
    for attempt in 1..=BENCHMARK_CONNECT_MAX_ATTEMPTS {
        match connect(request.clone()) {
            Ok(connected) => return Ok(connected),
            Err(error) => {
                last_error = Some(error);
                if attempt < BENCHMARK_CONNECT_MAX_ATTEMPTS {
                    let delay_ms = BENCHMARK_CONNECT_INITIAL_BACKOFF_MS << (attempt - 1);
                    thread::sleep(Duration::from_millis(delay_ms));
                }
            }
        }
    }

    Err(format!(
        "{error_context} after {BENCHMARK_CONNECT_MAX_ATTEMPTS} attempts: {}",
        last_error.expect("at least one websocket connection attempt")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;

    #[test]
    fn local_probe_blocks_benchmark_without_provider_draft_before_factory() {
        crate::watch_mode_diagnostic::local_aec_probe::test_provider_entry_opt_ins(
            concat!(module_path!(), "::local_probe_blocks_benchmark_without_provider_draft_before_factory")
                .strip_prefix(concat!(env!("CARGO_CRATE_NAME"), "::")).unwrap(),
            |requested| {
                let mut factory_calls = 0;
                for kind in ["openai-compatible", "gemini", "dashscope"] {
                    let admission = authorize_bailian_model_operation_for_benchmark_invocation(
                        "unregistered-benchmark-model", kind, None, None, None, None,
                    ).map(|_| { factory_calls += 1; });
                    if !requested {
                        admission.unwrap();
                        assert_eq!(factory_calls, 1, "non-Bailian draftless admission must be unchanged");
                        break;
                    }
                    assert!(admission.unwrap_err().contains("forbidden during the local AEC probe"));
                    assert_eq!(factory_calls, 0, "no decoder, progress worker or connector may be created");
                }
            },
        );
    }

    fn connector_config(
        model: &str,
        provider_kind: &str,
        protocol_dialect: Option<crate::audio::events::RealtimeProtocol>,
    ) -> BenchmarkConfig {
        BenchmarkConfig {
            api_key: "unused-test-key".to_string(),
            mp3_path: PathBuf::from("unused-test-audio.mp3"),
            model: model.to_string(),
            audio_mode: RealtimeAudioMode::ServerVad,
            interaction_capabilities: Vec::new(),
            provider_kind: provider_kind.to_string(),
            base_url: String::new(),
            auth_header_name: "Authorization".to_string(),
            auth_scheme: "bearer".to_string(),
            voice: "Ethan".to_string(),
            target_language: "zh".to_string(),
            protocol_dialect,
            model_protocol_authority: None,
        }
    }

    fn counted_loopback_connector() -> (
        String,
        Arc<AtomicUsize>,
        Arc<AtomicBool>,
        thread::JoinHandle<()>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener should bind");
        listener
            .set_nonblocking(true)
            .expect("listener should be nonblocking");
        let address = listener.local_addr().expect("listener should have address");
        let attempts = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let attempts_for_server = Arc::clone(&attempts);
        let stop_for_server = Arc::clone(&stop);
        let server = thread::spawn(move || {
            while !stop_for_server.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        attempts_for_server.fetch_add(1, Ordering::SeqCst);
                        drop(stream);
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2));
                    }
                    Err(error) => panic!("loopback connector failed: {error}"),
                }
            }
        });
        (format!("ws://{address}/ws"), attempts, stop, server)
    }

    fn assert_connector_rejected_without_network(config: BenchmarkConfig) -> String {
        let (url, attempts, stop, server) = counted_loopback_connector();
        let request = url
            .as_str()
            .into_client_request()
            .expect("loopback request should build");
        let error = connect_benchmark_websocket(&config, BenchmarkExecutionPolicy::Production, request, "unexpected connect")
            .expect_err("Bailian benchmark boundary must fail closed");
        stop.store(true, Ordering::SeqCst);
        server.join().expect("loopback connector should stop");
        assert_eq!(attempts.load(Ordering::SeqCst), 0);
        error
    }

    #[test]
    fn registered_bailian_model_cannot_cross_kind_at_benchmark_connector() {
        let error = assert_connector_rejected_without_network(connector_config(
            "qwen3.5-livetranslate-flash-realtime",
            "openai-compatible",
            Some(crate::audio::events::RealtimeProtocol::OpenAiConversation),
        ));
        assert!(error.contains("model_protocol.authorization_identity_mismatch"));
    }

    #[test]
    fn unknown_bailian_snapshot_cannot_reach_benchmark_connector() {
        let error = assert_connector_rejected_without_network(connector_config(
            "qwen3.5-livetranslate-flash-realtime-2099-12-31",
            "dashscope",
            Some(crate::audio::events::RealtimeProtocol::DashscopeLivetranslate),
        ));
        assert!(error.contains("model_protocol.authorization_identity_mismatch"));
    }
    #[test]
    fn bounded_connection_one_attempt_default_retains_four() {
        for (policy, expected) in [
            (BenchmarkExecutionPolicy::Production, 4),
            (BenchmarkExecutionPolicy::Bounded { loopback: None }, 1),
        ] {
            let (url, attempts, stop, server) = counted_loopback_connector();
            let config = connector_config("local-fixture-model", "openai-compatible", None);
            assert!(connect_benchmark_websocket(&config, policy, url.as_str().into_client_request().unwrap(), "fixture").is_err());
            stop.store(true, Ordering::SeqCst); server.join().unwrap();
            assert_eq!(attempts.load(Ordering::SeqCst), expected);
        }
    }

    #[test]
    fn bounded_connection_does_not_follow_redirect() {
        use std::io::{Read, Write};
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("ws://{}/realtime", listener.local_addr().unwrap());
        let (target, attempts, stop, target_server) = counted_loopback_connector();
        let redirect = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            let mut request = [0; 4096]; let _ = stream.read(&mut request).unwrap();
            write!(stream, "HTTP/1.1 302 Found\r\nLocation: {target}\r\nContent-Length: 0\r\n\r\n").unwrap();
        });
        let config = connector_config("local-fixture-model", "openai-compatible", None);
        let result = connect_benchmark_websocket(&config, BenchmarkExecutionPolicy::Bounded { loopback: None },
            url.as_str().into_client_request().unwrap(), "fixture");
        assert!(result.is_err()); redirect.join().unwrap();
        stop.store(true, Ordering::SeqCst); target_server.join().unwrap();
        assert_eq!(attempts.load(Ordering::SeqCst), 0);
    }

}
