use super::*;

pub(super) async fn collect_provider_config(
    app: &AppHandle,
    staging: &Path,
    invocation_id: &str,
    source_head_commit: &str,
    timeline: &mut Vec<Value>,
) -> Result<DiagnosticsAuthority, String> {
    log_authority_event(
        app,
        EvidenceScenario::ProviderConfig,
        invocation_id,
        "production-handler-invoked",
        Some("storage_events::load_config_draft"),
    );
    let before = load_config_draft(app.clone(), app.state::<StorageStateStore>())?;
    let (provider_before, provider) =
        select_provider(&before, env_value(PROVIDER_ID_ENV).as_deref())?;
    push_timeline(
        timeline,
        "configuration-loaded",
        invocation_id,
        Some(json!({ "providerId": provider.provider_id })),
    );

    save_config_draft(
        app.clone(),
        app.state::<StorageStateStore>(),
        before.clone(),
    )?;
    let after = load_config_draft(app.clone(), app.state::<StorageStateStore>())?;
    let (provider_after, _) = select_provider_by_id(&after, &provider.provider_id)?;
    if provider_before != provider_after {
        return Err("production configuration save/load changed the selected provider".to_string());
    }
    push_timeline(
        timeline,
        "configuration-saved-and-reloaded",
        invocation_id,
        None,
    );

    let checked_at = now();
    let credential = get_secret_ref_status(app.clone(), provider.auth_ref.reference.clone()).await?;
    if credential.backend != "windows-credential-manager" || !credential.has_secret {
        return Err(format!(
            "provider credential reference is unavailable in Windows Credential Manager: {}",
            credential.reference
        ));
    }
    push_timeline(
        timeline,
        "credential-status-read",
        invocation_id,
        Some(json!({ "reference": credential.reference, "hasSecret": credential.has_secret })),
    );

    let diagnostics = capture_full_diagnostics(
        app,
        staging,
        EvidenceScenario::ProviderConfig,
        invocation_id,
        source_head_commit,
        timeline,
    )
    .await?;
    let snapshot = json!({
        "schemaVersion": 1,
        "artifactKind": "provider-config-production-snapshot",
        "collectorId": EvidenceScenario::ProviderConfig.collector_id(),
        "collectorVersion": EMITTER_VERSION,
        "invocationId": invocation_id,
        "source": "desktop-api-v2",
        "productionMode": true,
        "capturedAt": now(),
        "desktopProcessId": std::process::id(),
        "sourceHeadCommit": source_head_commit,
        "provider": {
            "templateId": provider.template_id,
            "providerId": provider.provider_id,
            "kind": provider.kind,
            "model": provider.model,
            "baseUrl": provider.base_url,
            "transport": provider.transport,
            "configPersisted": true,
            "authRef": {
                "kind": provider.auth_ref.kind,
                "reference": provider.auth_ref.reference,
                "headerName": provider.auth_ref.header_name,
                "scheme": provider.auth_ref.scheme,
            },
            "secretValuePresent": false,
        },
        "credentialStatus": {
            "backend": credential.backend,
            "exists": credential.has_secret,
            "reference": credential.reference,
            "checkedAt": checked_at,
        },
        "diagnosticsExport": diagnostics,
    });
    write_json(&staging.join("provider-config-snapshot.json"), &snapshot)?;
    Ok(diagnostics)
}
pub(super) async fn collect_provider_probe(
    app: &AppHandle,
    staging: &Path,
    invocation_id: &str,
    source_head_commit: &str,
    timeline: &mut Vec<Value>,
) -> Result<DiagnosticsAuthority, String> {
    let config = load_config_draft(app.clone(), app.state::<StorageStateStore>())?;
    let mut authorization = ProviderPreflightAuthorization::load_required(source_head_commit)?;
    let strict_livetranslate = authorization.is_strict_livetranslate();
    let (_, mut provider) = select_provider_by_id(&config, AUTHORIZED_PROVIDER_ID)?;
    let configured_model = authorization.apply_to_provider(&mut provider)?;
    let protocol = crate::audio::events::resolve_realtime_profile(&provider, &provider.model)
        .protocol_dialect
        .map(|value| value.as_str().to_string())
        .ok_or_else(|| "provider preflight did not resolve a realtime protocol".to_string())?;
    let credential = get_secret_ref_status(app.clone(), provider.auth_ref.reference.clone()).await?;
    if credential.backend != "windows-credential-manager" || !credential.has_secret {
        return Err(format!(
            "provider credential reference is unavailable in Windows Credential Manager: {}",
            credential.reference
        ));
    }
    authorization.claim_before_connect()?;
    push_timeline(
        timeline,
        "provider-loaded-and-credential-checked",
        invocation_id,
        Some(json!({ "providerId": provider.provider_id })),
    );
    log_authority_event(
        app,
        EvidenceScenario::ProviderProbe,
        invocation_id,
        "production-handler-invoked",
        Some("provider_events::probe_provider"),
    );
    let provider_connect_started_at = now();
    let probe = probe_provider(app.clone(), provider.clone()).await;
    let provider_connect_completed_at = now();
    let probe_checked_at = provider_connect_completed_at.clone();
    if !strict_livetranslate && probe.verdict != "available" {
        return Err(format!(
            "production provider probe did not report available: verdict={} error={}",
            probe.verdict,
            probe
                .error
                .as_ref()
                .map(|error| error.message.as_str())
                .unwrap_or("none")
        ));
    }
    push_timeline(
        timeline,
        "provider-probe-completed",
        invocation_id,
        Some(json!({
            "verdict": probe.verdict,
            "latencyMs": probe.measured_latency_ms,
        })),
    );

    let endpoint_host = url::Url::parse(&provider.base_url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
        .ok_or_else(|| "provider baseUrl has no valid endpoint host".to_string())?;
    let preflight_authorization = Some(authorization.authority.clone());
    if probe.provider_id != provider.provider_id {
        return Err("authorized provider probe returned a different provider identity".to_string());
    }
    if probe.audio_seconds.is_some_and(|seconds| seconds != 0.0) {
        return Err(
            "authorized LiveTranslate session preflight reported non-zero audio usage".to_string(),
        );
    }
    if !strict_livetranslate {
        let input_tokens = probe
            .input_tokens
            .ok_or_else(|| "authorized provider probe omitted input token usage".to_string())?;
        let output_tokens = probe
            .output_tokens
            .ok_or_else(|| "authorized provider probe omitted output token usage".to_string())?;
        if input_tokens > 4_096 || output_tokens > provider.max_output_tokens {
            return Err(
                "authorized provider probe exceeded its signed text-only token budget"
                    .to_string(),
            );
        }
    }
    if let Some(store) = app.try_state::<crate::provider::state::ProviderStateStore>() {
        store.record_probe(crate::provider::state::ProviderProbeSummary {
            verdict: probe.verdict.clone(),
            checked_at: probe_checked_at.clone(),
            transport_effective: probe.transport_effective.clone(),
            configured_model: Some(configured_model.clone()),
            model: Some(provider.model.clone()),
            protocol: Some(protocol.clone()),
            preflight_authorization: preflight_authorization.clone(),
            provider_connect_started_at: Some(provider_connect_started_at.clone()),
            provider_connect_completed_at: Some(provider_connect_completed_at.clone()),
            input_tokens: probe.input_tokens,
            output_tokens: probe.output_tokens,
            audio_seconds: probe.audio_seconds,
        });
    }
    let diagnostics = capture_full_diagnostics(
        app,
        staging,
        EvidenceScenario::ProviderProbe,
        invocation_id,
        source_head_commit,
        timeline,
    )
    .await?;
    let raw_trace = strict_livetranslate
        .then(|| write_provider_wire_trace(staging, probe.wire_evidence.as_ref()))
        .transpose()?;
    let wire_evidence = if strict_livetranslate {
        probe
            .wire_evidence
            .as_ref()
            .map(serde_json::to_value)
            .transpose()
            .map_err(|error| error.to_string())?
    } else {
        None
    };
    let mut raw_probe_result = serde_json::to_value(&probe).map_err(|error| error.to_string())?;
    if let Some(object) = raw_probe_result.as_object_mut() {
        if strict_livetranslate {
            object.remove("wireEvidence");
            if let Some(wire) = wire_evidence.as_ref().and_then(Value::as_object) {
                object.extend(wire.clone());
            } else {
                object.insert("evidenceOutcome".to_string(), json!("unknown"));
                object.insert("providerInputMode".to_string(), json!("none"));
                object.insert("responseMode".to_string(), json!("text-only"));
                object.insert("providerInvocationCount".to_string(), json!(1));
                object.insert("connectionCount".to_string(), json!(probe.connection_count));
                object.insert("externalAudioSamples".to_string(), json!(0));
                object.insert("inputAudioBufferCommitCount".to_string(), json!(0));
                object.insert(
                    "conversationItemCreateInputTextCount".to_string(),
                    json!(0),
                );
                object.insert("responseCreateCount".to_string(), json!(0));
            }
            object.insert(
                "rawTrace".to_string(),
                raw_trace.clone().unwrap_or(Value::Null),
            );
            object.insert("productionMode".to_string(), json!(true));
            object.insert(
                "lifecycleBudget".to_string(),
                json!({
                    "firstServerEventLatencyMs": 1_200,
                    "socketEventTimeoutMs": 12_000,
                }),
            );
            let first_server_event_latency_ms = object
                .get("firstServerEvent")
                .and_then(Value::as_object)
                .and_then(|event| event.get("monotonicMs"))
                .cloned()
                .unwrap_or(Value::Null);
            object.insert(
                "firstServerEventLatencyMs".to_string(),
                first_server_event_latency_ms,
            );
        }
        object.insert("modelId".to_string(), json!(provider.model));
        object.insert("configuredModel".to_string(), json!(configured_model));
        object.insert("checkedAt".to_string(), json!(probe_checked_at));
        object.insert("model".to_string(), json!(provider.model));
        object.insert("protocol".to_string(), json!(protocol));
        object.insert(
            "preflightAuthorization".to_string(),
            preflight_authorization.clone().unwrap_or(Value::Null),
        );
        object.insert(
            "providerConnectStartedAt".to_string(),
            json!(provider_connect_started_at),
        );
        object.insert(
            "providerConnectCompletedAt".to_string(),
            json!(provider_connect_completed_at),
        );
    }
    let mut result = json!({
        "schemaVersion": 1,
        "artifactKind": "provider-production-probe-result",
        "collectorId": EvidenceScenario::ProviderProbe.collector_id(),
        "collectorVersion": EMITTER_VERSION,
        "invocationId": invocation_id,
        "source": "desktop-api-v2",
        "productionMode": true,
        "operation": if strict_livetranslate {
            "livetranslate-session-lifecycle-preflight"
        } else {
            "text-translation-preflight"
        },
        "inputMode": if strict_livetranslate { "none" } else { "text-only" },
        "externalAudioSamples": 0,
        "providerInvocationCount": 1,
        "inputTokens": probe.input_tokens,
        "outputTokens": probe.output_tokens,
        "audioSeconds": probe.audio_seconds,
        "checkedAt": probe_checked_at,
        "desktopProcessId": std::process::id(),
        "sourceHeadCommit": source_head_commit,
        "templateId": provider.template_id,
        "providerId": provider.provider_id,
        "configuredModel": configured_model,
        "model": provider.model,
        "protocol": protocol,
        "preflightAuthorization": preflight_authorization,
        "providerConnectStartedAt": provider_connect_started_at,
        "providerConnectCompletedAt": provider_connect_completed_at,
        "transportRequested": probe.transport_requested,
        "effectiveTransport": probe.transport_effective,
        "endpointHost": endpoint_host,
        "verdict": probe.verdict,
        "latencyMs": probe.measured_latency_ms,
        "latencyBudgetMs": probe.latency_budget_ms
    });
    let result_object = result
        .as_object_mut()
        .ok_or_else(|| "provider probe result must be a JSON object".to_string())?;
    for (key, value) in [
        ("connectionAttempts", json!(probe.connection_attempts)),
        ("connectionCount", json!(probe.connection_count)),
        ("connectionOpened", json!(probe.connection_opened)),
        ("connectionClosed", json!(probe.connection_closed)),
        ("connectionOwner", json!(probe.connection_owner)),
        ("connectionGeneration", json!(probe.connection_generation)),
        ("streamObserved", json!(probe.stream_supported)),
        ("responseShapeStable", json!(probe.response_shape_stable)),
        ("errorShapeStable", json!(probe.error_shape_stable)),
        ("credentialStatus", json!({
            "backend": credential.backend,
            "exists": credential.has_secret,
            "reference": credential.reference,
        })),
        ("rawProbeResult", raw_probe_result),
        ("diagnosticsExport", json!(diagnostics)),
    ] {
        result_object.insert(key.to_string(), value);
    }
    if strict_livetranslate {
        result_object.insert("providerInputMode".to_string(), json!("none"));
        result_object.insert("responseMode".to_string(), json!("text-only"));
        result_object.insert("terminalEvent".to_string(), json!("session.finished"));
        result_object.insert(
            "evidenceOutcome".to_string(),
            wire_evidence
                .as_ref()
                .and_then(|value| value.get("evidenceOutcome"))
                .cloned()
                .unwrap_or_else(|| json!("unknown")),
        );
        result_object.insert(
            "firstServerEvent".to_string(),
            wire_evidence
                .as_ref()
                .and_then(|value| value.get("firstServerEvent"))
                .cloned()
                .unwrap_or(Value::Null),
        );
        result_object.insert(
            "rawTrace".to_string(),
            raw_trace.unwrap_or(Value::Null),
        );
    }
    write_json(&staging.join("provider-probe-result.json"), &result)?;
    Ok(diagnostics)
}

fn write_provider_wire_trace(
    staging: &Path,
    evidence: Option<&crate::provider::contracts::ProviderProbeWireEvidence>,
) -> Result<Value, String> {
    let raw_directory = staging.join("raw");
    fs::create_dir(&raw_directory).map_err(|error| {
        format!(
            "failed to create provider raw trace directory {}: {error}",
            raw_directory.display()
        )
    })?;
    let trace_path = raw_directory.join("provider-websocket-trace.jsonl");
    let trace = evidence
        .map(|evidence| evidence.trace.clone())
        .unwrap_or_default();
    let mut bytes = Vec::new();
    if trace.is_empty() {
        serde_json::to_writer(
            &mut bytes,
            &json!({
                "monotonicMs": 0,
                "direction": "local",
                "type": "wire-evidence.missing",
            }),
        )
        .map_err(|error| error.to_string())?;
        bytes.push(b'\n');
    } else {
        for entry in &trace {
            serde_json::to_writer(&mut bytes, entry).map_err(|error| error.to_string())?;
            bytes.push(b'\n');
        }
    }
    fs::write(&trace_path, &bytes).map_err(|error| {
        format!(
            "failed to write provider raw trace {}: {error}",
            trace_path.display()
        )
    })?;
    Ok(json!({
        "path": "raw/provider-websocket-trace.jsonl",
        "bytes": bytes.len(),
        "sha256": hash_file(&trace_path)?,
        "eventCount": if trace.is_empty() { 1 } else { trace.len() },
    }))
}
