use super::*;

#[test]
fn zero_input_probe_plan_is_admitted_and_bound_by_the_production_client_adapter() {
    let provider: ProviderDraftInput = serde_json::from_value(json!({
        "templateId":"template-dashscope-realtime", "providerId":"lt", "kind":"dashscope",
        "displayName":"LT", "model":"qwen3.5-livetranslate-flash-realtime",
        "baseUrl":"https://dashscope.aliyuncs.com/api/v1", "transport":"websocket",
        "authRef":{"kind":"header","reference":"synthetic","headerName":"Authorization","scheme":"Bearer"},
        "region":"cn-beijing", "streamEnabled":true, "timeoutMs":1000,
        "systemPromptTemplate":""
    }))
    .unwrap();
    let context = ProviderCallContext {
        provider: &provider,
        request_id: "probe",
        source_text: "",
        source_language: "en",
        target_language: "zh",
        glossary_prompt: None,
        livetranslate_session_probe: true,
        strict_livetranslate_authority: true,
    };
    let mut plan = prepare_livetranslate_probe_plan(&context)
        .expect("production must prepare the complete admitted preflight plan");
    crate::audio::bailian_protocol::admit_livetranslate_client_event(
        &plan.protocol_authority,
        &plan.session_update,
    )
    .expect("session.update must use the paid Watch typed protocol");
    crate::audio::bailian_protocol::admit_livetranslate_client_event(
        &plan.protocol_authority,
        &plan.session_finish,
    )
    .expect("session.finish must use the paid Watch typed protocol");
    assert_eq!(
        plan.session_update.pointer("/session/input_audio_transcription/language"),
        Some(&json!("en")),
    );
    assert_eq!(
        plan.session_update.pointer("/session/translation/language"),
        Some(&json!("zh")),
    );
    assert_eq!(
        plan.session_update.pointer("/session/translation/corpus/phrases"),
        Some(&json!({
            "Mars": "火星",
            "artificial biosphere": "人工生物圈",
            "light bulb": "灯泡",
            "one billion": "十亿"
        })),
    );
    let duplicate_update = plan
        .protocol_state
        .record_client_session_update(&plan.protocol_authority, &plan.session_update)
        .expect_err("the exact planned session.update must already be bound once");
    assert!(duplicate_update.contains("must be bound once"));
}

#[test]
fn server_event_ids_require_nonempty_unique_strings_without_invented_format_rules() {
    let mut observed = HashSet::new();
    for (event_type, event_id) in [
        ("session.created", "event_UiAuTHNW6doW4VCAt1qmq"),
        ("session.updated", "provider-issued id/事件-001"),
    ] {
        validate_livetranslate_server_event_id(
            &json!({ "type": event_type, "event_id": event_id }),
            event_type,
            &mut observed,
        )
        .expect("controlled unique event_id should pass");
    }
    let reused = validate_livetranslate_server_event_id(
        &json!({
            "type": "session.finished",
            "event_id": "provider-issued id/事件-001",
        }),
        "session.finished",
        &mut observed,
    )
    .expect_err("reused event_id should fail closed");
    assert_eq!(reused.code, "protocol.event-id-reused");

    for event_id in ["", "   "] {
        let invalid = validate_livetranslate_server_event_id(
            &json!({ "type": "session.finished", "event_id": event_id }),
            "session.finished",
            &mut observed,
        )
        .expect_err("malformed event_id should fail closed");
        assert_eq!(invalid.code, "protocol.event-id-invalid");
    }
}

#[test]
fn persisted_diagnostics_are_redacted_control_free_and_bounded() {
    let diagnostic = format!(
        "rate limit\r\nAuthorization: Bearer auth-secret api_key=key-secret safe-context {}",
        "x".repeat(300)
    );
    let sanitized = sanitize_diagnostic_text(&diagnostic, 96);
    assert!(sanitized.contains("rate limit"));
    assert!(sanitized.contains("[REDACTED]"));
    assert!(!sanitized.contains("auth-secret"));
    assert!(!sanitized.contains("key-secret"));
    assert!(!sanitized.chars().any(char::is_control));
    assert_eq!(sanitized.chars().count(), 96);
    assert!(sanitized.ends_with("[TRUNCATED]"));

    let payload = sanitized_provider_error_payload(&json!({
        "type": "error",
        "error": {
            "code": "InvalidApiKey Authorization: Bearer code-secret",
            "detail": diagnostic,
        },
        "credential": "top-level-secret",
    }));
    assert!(payload.contains("InvalidApiKey"));
    assert!(payload.contains("rate limit"));
    assert!(!payload.contains("code-secret"));
    assert!(!payload.contains("top-level-secret"));
    assert!(payload.chars().count() <= MAX_PROVIDER_ERROR_PAYLOAD_CHARS);
}
