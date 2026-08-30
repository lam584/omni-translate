use serde_json::{json, Value};

const STRICT_PAID_AUTHORITY_ENV: &str = "OMNI_WATCH_MODE_STRICT_PAID_AUTHORITY";
const EXPECTED_PROVIDER_ID_ENV: &str = "OMNI_WATCH_MODE_EXPECTED_PROVIDER_ID";
const STRICT_PROVIDER_ID: &str = "provider-dashscope";
const STRICT_PROVIDER_KIND: &str = "dashscope";
const STRICT_PROVIDER_TEMPLATE_ID: &str = "template-dashscope-realtime";
const STRICT_MODEL_ID: &str = "qwen3.5-livetranslate-flash-realtime";
const STRICT_REALTIME_PROTOCOL: &str = "dashscope-livetranslate";

fn set_json_pointer_value(config: &mut Value, path: &[&str], value: Value) {
    if path.is_empty() {
        return;
    }
    let mut current = config;
    for key in &path[..path.len() - 1] {
        if !current.get(*key).is_some_and(Value::is_object) {
            current[*key] = Value::Object(Default::default());
        }
        current = current
            .get_mut(*key)
            .expect("object key exists after insert");
    }
    current[path[path.len() - 1]] = value;
}

fn set_json_pointer_string(config: &mut Value, path: &[&str], value: String) {
    set_json_pointer_value(config, path, Value::String(value));
}

fn set_json_pointer_number(config: &mut Value, path: &[&str], value: i64) {
    set_json_pointer_value(config, path, Value::Number(value.into()));
}

fn set_json_pointer_bool(config: &mut Value, path: &[&str], value: bool) {
    set_json_pointer_value(config, path, Value::Bool(value));
}

fn watch_protocol_matches_provider(provider: &Value, protocol: &str) -> bool {
    let kind = provider
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let template_id = provider
        .get("templateId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    match protocol {
        value if value.starts_with("dashscope-") => {
            kind == "dashscope" || template_id.contains("dashscope")
        }
        value if value.starts_with("openai-") => {
            kind == "openai-compatible" && !template_id.contains("gemini")
        }
        "gemini-live" => template_id.contains("gemini"),
        _ => false,
    }
}

pub(super) fn configure_watch_realtime_provider(
    config: &mut Value,
    requested_model_id: &str,
    realtime_protocol: &str,
) -> Result<String, String> {
    configure_watch_realtime_provider_with_environment(
        config,
        requested_model_id,
        realtime_protocol,
        |name| std::env::var(name).ok(),
    )
}

fn strict_expected_provider_id(
    read_env: &impl Fn(&str) -> Option<String>,
) -> Result<Option<String>, String> {
    let Some(strict_paid_authority) = read_env(STRICT_PAID_AUTHORITY_ENV) else {
        return Ok(None);
    };
    if strict_paid_authority.trim() != "1" {
        return Err(format!(
            "{STRICT_PAID_AUTHORITY_ENV} must be exactly 1 when present"
        ));
    }

    let expected_provider_id = read_env(EXPECTED_PROVIDER_ID_ENV)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            format!(
                "strict paid Watch authority requires {EXPECTED_PROVIDER_ID_ENV} before provider connect"
            )
        })?;
    if expected_provider_id != STRICT_PROVIDER_ID {
        return Err(format!(
            "strict paid Watch authority requires {EXPECTED_PROVIDER_ID_ENV}={STRICT_PROVIDER_ID}; got {expected_provider_id}"
        ));
    }
    Ok(Some(expected_provider_id))
}

pub(super) fn configure_watch_realtime_provider_with_environment(
    config: &mut Value,
    requested_model_id: &str,
    realtime_protocol: &str,
    read_env: impl Fn(&str) -> Option<String>,
) -> Result<String, String> {
    let strict_expected_provider_id = strict_expected_provider_id(&read_env)?;
    if realtime_protocol.is_empty() {
        if strict_expected_provider_id.is_some() {
            return Err(
                "strict paid Watch authority requires an explicit realtime protocol before provider connect"
                    .to_string(),
            );
        }
        return Ok(requested_model_id.to_string());
    }
    if requested_model_id.is_empty() {
        return Err("Watch realtime protocol was provided without a model id".to_string());
    }
    if !matches!(
        realtime_protocol,
        "dashscope-omni"
            | "dashscope-livetranslate"
            | "dashscope-asr"
            | "openai-conversation"
            | "openai-translation"
            | "openai-transcription"
            | "openai-flat"
            | "gemini-live"
    ) {
        return Err(format!(
            "Unsupported Watch realtime protocol '{realtime_protocol}'"
        ));
    }

    let (template_hint, resolved_model_id) = requested_model_id
        .split_once("::")
        .map(|(template_id, model_id)| (Some(template_id), model_id))
        .unwrap_or((None, requested_model_id));
    if strict_expected_provider_id.is_some()
        && (resolved_model_id != STRICT_MODEL_ID || realtime_protocol != STRICT_REALTIME_PROTOCOL)
    {
        return Err(format!(
            "strict paid Watch authority requires model={STRICT_MODEL_ID} protocol={STRICT_REALTIME_PROTOCOL}; observed model={resolved_model_id} protocol={realtime_protocol}"
        ));
    }
    let providers = config
        .get_mut("providers")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| "Watch config has no providers array".to_string())?;
    let provider_index = if let Some(expected_provider_id) = strict_expected_provider_id.as_deref()
    {
        let index = providers
            .iter()
            .position(|provider| {
                provider.get("providerId").and_then(Value::as_str) == Some(expected_provider_id)
            })
            .ok_or_else(|| {
                format!(
                    "strict paid Watch authority providerId '{expected_provider_id}' is missing before provider connect"
                )
            })?;
        let provider = &providers[index];
        let actual_kind = provider
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if actual_kind != STRICT_PROVIDER_KIND {
            return Err(format!(
                "strict paid Watch authority provider kind mismatch for {expected_provider_id}: expected={STRICT_PROVIDER_KIND} actual={actual_kind}"
            ));
        }
        let actual_template_id = provider
            .get("templateId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if actual_template_id != STRICT_PROVIDER_TEMPLATE_ID {
            return Err(format!(
                "strict paid Watch authority provider templateId mismatch for {expected_provider_id}: expected={STRICT_PROVIDER_TEMPLATE_ID} actual={actual_template_id}"
            ));
        }
        if let Some(template_hint) = template_hint {
            if template_hint != actual_template_id {
                return Err(format!(
                    "strict paid Watch authority model template mismatch for {expected_provider_id}: expected={actual_template_id} actual={template_hint}"
                ));
            }
        }
        if !watch_protocol_matches_provider(provider, realtime_protocol) {
            return Err(format!(
                "strict paid Watch authority provider {expected_provider_id} cannot host realtime protocol '{realtime_protocol}'"
            ));
        }
        index
    } else {
        providers
            .iter()
            .position(|provider| {
                let template_matches = template_hint
                    .map(|expected| {
                        provider.get("templateId").and_then(Value::as_str) == Some(expected)
                    })
                    .unwrap_or(true);
                template_matches && watch_protocol_matches_provider(provider, realtime_protocol)
            })
            .ok_or_else(|| {
                format!(
                    "No provider can host Watch realtime protocol '{realtime_protocol}' for model '{requested_model_id}'"
                )
            })?
    };

    // Downstream route resolution consumes `templateId::modelId` and selects
    // the first provider with that template. In strict mode, move the exact
    // provider to the front so an earlier compatible/duplicate template cannot
    // replace the provider identity that was authorized above.
    let provider_index = if strict_expected_provider_id.is_some() && provider_index != 0 {
        providers.swap(0, provider_index);
        0
    } else {
        provider_index
    };
    let provider = &mut providers[provider_index];

    provider["model"] = Value::String(resolved_model_id.to_string());
    provider["realtimeProtocol"] = Value::String(realtime_protocol.to_string());
    if !provider
        .get("localModelCapabilityRegistry")
        .is_some_and(Value::is_array)
    {
        provider["localModelCapabilityRegistry"] = Value::Array(Vec::new());
    }
    let registry = provider["localModelCapabilityRegistry"]
        .as_array_mut()
        .expect("registry was initialized as an array");
    registry.retain(|entry| {
        entry.get("modelId").and_then(Value::as_str) != Some(resolved_model_id)
    });
    let capabilities = if matches!(realtime_protocol, "dashscope-asr" | "openai-transcription") {
        vec!["speech-to-text"]
    } else {
        vec!["speech-to-text", "speech-to-speech"]
    };
    let realtime_audio_mode = match realtime_protocol {
        "dashscope-omni" => "semantic_vad",
        "gemini-live" => "gemini_auto_activity",
        _ => "server_vad",
    };
    let interaction_capabilities = if realtime_protocol == "dashscope-omni" {
        vec!["streaming", "auto_vad", "manual_commit"]
    } else {
        vec!["streaming", "auto_vad"]
    };
    registry.insert(
        0,
        json!({
            "id": "watch-diagnostic-explicit-protocol",
            "modelId": resolved_model_id,
            "capabilities": capabilities,
            "realtimeProtocol": realtime_protocol,
            "realtimeAudioMode": realtime_audio_mode,
            "interactionCapabilities": interaction_capabilities
        }),
    );

    let template_id = provider
        .get("templateId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    Ok(if template_id.is_empty() {
        resolved_model_id.to_string()
    } else {
        format!("{template_id}::{resolved_model_id}")
    })
}

pub(super) fn configure_watch_mode(
    config: &mut Value,
    output_device_id: &str,
    output_level: i64,
    watch_model_id: &str,
    subtitle_translation_mode: &str,
    subtitle_translation_model_id: &str,
    inbound_secondary_audio_model_id: &str,
    translation_audio_source: &str,
    feedback_loop_prevention: &str,
) {
    // Native Watch diagnostics replay the selected realtime model's translated
    // PCM on every release route. Echo-cancel renders from Desktop to provide
    // the AEC reference; virtual-driver and process-exclusion hand the same PCM
    // to the Bridge-owned physical playback sink. The latter routes still keep
    // Desktop direct playback disabled in `audio::speech::output`, so enabling
    // local playback here does not create a second render owner or model call.
    let translated_playback_enabled = subtitle_translation_mode == "secondary"
        || (subtitle_translation_mode == "native"
            && matches!(
                feedback_loop_prevention,
                "echo-cancel" | "process-exclusion" | "virtual-driver"
            ));
    // A diagnostic launch with no explicit physical endpoint must not inherit
    // a stale persisted device id (for example, a removed virtual endpoint).
    // `default` is understood by both direct playback and WASAPI capture.
    let output_device_id = if output_device_id.trim().is_empty() {
        "default"
    } else {
        output_device_id
    };
    set_json_pointer_string(config, &["devices", "routeMode"], "watch".to_string());
    set_json_pointer_string(
        config,
        &["devices", "outputDeviceId"],
        output_device_id.to_string(),
    );
    // Physical Watch routes capture the loopback stream of the same render
    // endpoint used by the media injector and translated playback. Do not let
    // a persisted concrete inbound device override the endpoint selected for
    // this diagnostic run. Virtual-driver intentionally captures its virtual
    // render endpoint instead and is resolved separately by the audio engine.
    if feedback_loop_prevention != "virtual-driver" {
        set_json_pointer_string(
            config,
            &["devices", "inboundRoute", "input", "deviceId"],
            output_device_id.to_string(),
        );
    }
    set_json_pointer_number(config, &["devices", "outputLevel"], output_level);
    set_json_pointer_string(
        config,
        &["devices", "subtitleTranslationMode"],
        subtitle_translation_mode.to_string(),
    );
    set_json_pointer_string(
        config,
        &["devices", "subtitleTranslationModelId"],
        subtitle_translation_model_id.to_string(),
    );
    set_json_pointer_string(
        config,
        &["devices", "inboundSecondaryAudioModelId"],
        inbound_secondary_audio_model_id.to_string(),
    );
    if !watch_model_id.is_empty() {
        set_json_pointer_string(
            config,
            &["devices", "inboundVoiceModelId"],
            watch_model_id.to_string(),
        );
        set_json_pointer_string(
            config,
            &["devices", "outboundVoiceModelId"],
            watch_model_id.to_string(),
        );
        set_json_pointer_string(
            config,
            &["devices", "textToSpeechModelId"],
            watch_model_id.to_string(),
        );
        set_json_pointer_string(
            config,
            &["speech", "textToSpeechModelId"],
            watch_model_id.to_string(),
        );
    }
    if subtitle_translation_mode == "secondary" {
        set_json_pointer_string(
            config,
            &["devices", "textToSpeechModelId"],
            inbound_secondary_audio_model_id.to_string(),
        );
        set_json_pointer_string(
            config,
            &["speech", "textToSpeechModelId"],
            inbound_secondary_audio_model_id.to_string(),
        );
    }
    set_json_pointer_bool(config, &["speech", "enabled"], true);
    set_json_pointer_bool(
        config,
        &["devices", "outputSpeechEnabled"],
        translated_playback_enabled,
    );
    set_json_pointer_string(config, &["speech", "outputTarget"], "speaker".to_string());
    set_json_pointer_bool(
        config,
        &["speech", "localPlaybackEnabled"],
        translated_playback_enabled,
    );
    set_json_pointer_bool(config, &["speech", "virtualMicOutputEnabled"], false);
    set_json_pointer_string(
        config,
        &["devices", "feedbackLoopPrevention"],
        feedback_loop_prevention.to_string(),
    );
    set_json_pointer_bool(
        config,
        &["devices", "inboundRoute", "mixControl", "keepOriginalAudio"],
        true,
    );
    set_json_pointer_bool(
        config,
        &[
            "devices",
            "inboundRoute",
            "mixControl",
            "translatedAudioEnabled",
        ],
        translated_playback_enabled,
    );
    set_json_pointer_number(
        config,
        &[
            "devices",
            "inboundRoute",
            "mixControl",
            "originalAudioGainDb",
        ],
        0,
    );
    set_json_pointer_number(
        config,
        &[
            "devices",
            "inboundRoute",
            "mixControl",
            "translatedAudioGainDb",
        ],
        0,
    );
    set_json_pointer_bool(config, &["vad", "bypass"], true);
    set_json_pointer_bool(
        config,
        &["devices", "inboundRoute", "mixControl", "duckingEnabled"],
        translated_playback_enabled,
    );
    set_json_pointer_string(
        config,
        &["devices", "inboundRoute", "mixControl", "monitorMode"],
        "original-and-translated".to_string(),
    );
    set_json_pointer_string(
        config,
        &["speech", "translationAudioSource"],
        translation_audio_source.to_string(),
    );
}
